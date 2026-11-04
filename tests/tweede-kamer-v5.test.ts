import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { migrateV4FieldNames, tkRecordView, TweedeKamerInputError, TweedeKamerSource } from "../src/sources/tweede-kamer.js";
import { TweedeKamerDebattenSource } from "../src/sources/tweede-kamer-debatten.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

/**
 * API version v5 of the Gegevensmagazijn (November 2026): v4/2.0 was
 * announced to stop returning results, and v5 renamed and dropped fields. An old name in a
 * query gets HTTP 400; in a response it is just missing, so a stray read
 * fails silently. These tests pin the migration.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

describe("Gegevensmagazijn API version", () => {
  it("no source or config file still talks to the old OData/v4 API", () => {
    const offenders = [...filesUnder(path.join(ROOT, "src")), ...filesUnder(path.join(ROOT, "config"))].filter((file) =>
      fs.readFileSync(file, "utf8").includes("OData/v4"),
    );
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("the configured base is OData/v5", () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config/default.json"), "utf8"));
    expect(config.endpoints.tweedeKamer).toBe("https://gegevensmagazijn.tweedekamer.nl/OData/v5");
  });
});

describe("migrateV4FieldNames", () => {
  it("renames old field names, also behind a path and in a lambda", () => {
    expect(migrateV4FieldNames("Document", "DocumentNummer eq '2026D47144'")).toEqual({
      expr: "Nummer eq '2026D47144'",
      renamed: [{ from: "DocumentNummer", to: "Nummer" }],
      dropped: [],
    });
    expect(migrateV4FieldNames("Stemming", "ActorFractie eq 'VVD' and Besluit/Zaak/any(z:z/GestartOp ge 2026-10-01T00:00:00+02:00)").expr).toBe(
      "FractieNaam eq 'VVD' and Besluit/Zaak/any(z:z/Datum ge 2026-10-01T00:00:00+02:00)",
    );
    expect(migrateV4FieldNames("Zaak", "GestartOp desc,Volgnummer").expr).toBe("Datum desc,Ondernummer");
    expect(migrateV4FieldNames("Besluit", "BesluitSoort eq 'Stemmen - aangenomen' and StemmingsSoort ne null").expr).toBe(
      "Soort eq 'Stemmen - aangenomen' and Tekst ne null",
    );
    // The service matches names case-insensitively, so a lower-case old name is meant the old way too.
    expect(migrateV4FieldNames("Vergadering", "vergaderingnummer eq 17").expr).toBe("Nummer eq 17");
  });

  it("leaves string literals, function names, dates, GUIDs and v5 names alone", () => {
    const expr = "contains(Onderwerp,'DocumentNummer en GestartOp''s') and Besluit_Id eq 1f12bd35-4638-42f5-b86e-a337b2655953 and Datum ge 2026-01-01T00:00:00Z";
    expect(migrateV4FieldNames("Document", expr)).toEqual({ expr, renamed: [], dropped: [] });
    expect(migrateV4FieldNames("Zaak", "Nummer eq '2026Z17586' and Kamer eq 'Tweede Kamer'").renamed).toEqual([]);
  });

  it("translates a name that still exists elsewhere only for the entity itself", () => {
    expect(migrateV4FieldNames("Besluit", "Opmerking ne null").expr).toBe("Notitie ne null");
    expect(migrateV4FieldNames("Zaak", "Status eq 'Vrijgegeven'").dropped).toEqual(["Status"]);
    // Besluit and Verslag still have a Status, also behind a path from Zaak.
    expect(migrateV4FieldNames("Besluit", "Status eq 'Besluit'").dropped).toEqual([]);
    expect(migrateV4FieldNames("Zaak", "Besluit/any(b:b/Status eq 'Besluit')").dropped).toEqual([]);
    expect(migrateV4FieldNames("PersoonOnderwijs", "Gewicht desc").expr).toBe("Volgorde desc");
  });

  it("translates such a name behind a path step or lambda that names the entity", () => {
    expect(migrateV4FieldNames("Document", "Zaak/any(z:z/Status eq 'Vrijgegeven')").dropped).toEqual(["Status"]);
    expect(migrateV4FieldNames("Document", "HuidigeDocumentVersie/Status eq 'x'").dropped).toEqual(["Status"]);
    expect(migrateV4FieldNames("Stemming", "Besluit/Opmerking ne null").expr).toBe("Besluit/Notitie ne null");
    expect(migrateV4FieldNames("Stemming", "Besluit/Status eq 'Besluit'")).toMatchObject({ renamed: [], dropped: [] });
    // A step that names no entity with such a field translates nothing.
    expect(migrateV4FieldNames("Activiteit", "VoortouwCommissie/Status eq 'x'").dropped).toEqual([]);
  });

  it("compares Document.Kamer, a number in v4, with its v5 text", () => {
    expect(migrateV4FieldNames("Document", "Kamer eq 2 and Soort eq 'Motie'")).toEqual({
      expr: "Kamer eq 'Tweede Kamer' and Soort eq 'Motie'",
      renamed: [{ from: "Kamer eq 2", to: "Kamer eq 'Tweede Kamer'" }],
      dropped: [],
    });
    expect(migrateV4FieldNames("Zaak", "Document/any(d:d/Kamer ne 3)").expr).toBe("Document/any(d:d/Kamer ne 'Eerste Kamer en Tweede Kamer')");
    expect(migrateV4FieldNames("Document", "Kamer eq 'Tweede Kamer'").renamed).toEqual([]);
    expect(migrateV4FieldNames("Document", "Kamer eq 7").expr).toBe("Kamer eq 7");
  });

  it("reports fields v5 dropped", () => {
    expect(migrateV4FieldNames("Document", "DatumRegistratie ge 2026-01-01T00:00:00Z").dropped).toEqual(["DatumRegistratie"]);
    expect(migrateV4FieldNames("Stemming", "SidActorFractie ne null").dropped).toEqual(["SidActorFractie"]);
  });
});

describe("tweede_kamer_search with old field names", () => {
  const tk = new TweedeKamerSource(testConfig);

  it("plans the v5 names and says what was replaced", () => {
    const plan = tk.planSearch({ entity: "Zaak", filter: "GestartOp ge 2026-10-01T00:00:00+02:00", orderby: "Volgnummer desc", top: 5 });
    expect(plan.params.$filter).toContain("Datum ge 2026-10-01T00:00:00+02:00");
    expect(plan.params.$filter).not.toContain("GestartOp");
    expect(plan.params.$orderby).toBe("Ondernummer desc");
    expect(plan.notes.join(" ")).toContain("GestartOp → Datum, Volgnummer → Ondernummer");
  });

  it("names a dropped field instead of sending a request the service rejects", () => {
    expect(() => tk.planSearch({ entity: "Zaak", filter: "Status eq 'Vrijgegeven'", top: 5 })).toThrow(TweedeKamerInputError);
    expect(() => tk.planSearch({ entity: "Zaak", filter: "Status eq 'Vrijgegeven'", top: 5 })).toThrow(/Status bestaat niet meer/);
  });

  it("dates a Zaak by Datum and orders a listing with Id as the last key", () => {
    const plan = tk.planSearch({ entity: "Zaak", date_from: "2026-10-01", top: 5 });
    expect(plan.params.$filter).toContain("Datum ge 2026-10-01T00:00:00+02:00");
    expect(plan.params.$orderby).toBe("GewijzigdOp desc,Id");
    expect(tk.planDocuments({ top: 5 }).params.$orderby).toBe("Datum desc,Id");
  });
});

describe("records read the v5 names", () => {
  const API = testConfig.endpoints.tweedeKamer;

  it("Document, Zaak, Besluit and Stemming", () => {
    expect(tkRecordView("Document", { Id: "d", Soort: "Motie", Nummer: "2026D47144", Onderwerp: "Motie over x" }, API).snippet).toBe("Motie · 2026D47144");
    const zaak = tkRecordView("Zaak", { Id: "z", Soort: "Motie", Nummer: "2026Z1", Datum: "2026-09-01T00:00:00+02:00", Afgedaan: true, Onderwerp: "x" }, API);
    expect(zaak).toMatchObject({ snippet: "Motie · 2026Z1 · afgedaan", date: "2026-09-01T00:00:00+02:00" });
    expect(tkRecordView("Besluit", { Id: "b", Soort: "Stemmen - aangenomen" }, API)).toMatchObject({ title: "Stemmen - aangenomen", snippet: "Stemmen - aangenomen" });
    expect(tkRecordView("Stemming", { Id: "s", Soort: "Voor", Naam: "50PLUS", FractieNaam: "50PLUS" }, API).title).toBe("50PLUS: Voor");
  });
});

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tk-v5-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }> };
    return JSON.parse(result.content[0].text);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("tools against API v5", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("tweede_kamer_search sends the v5 name for an old one and says so", async () => {
    const doc = { Id: "ad8cb9f1-63e1-4e55-b934-e1c5914707af", Soort: "Motie", Nummer: "2026D47144", Onderwerp: "Motie over iets", Datum: "2026-09-29T00:00:00+02:00" };
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.pathname.startsWith("/OData/v5/")).toBe(true);
      return url.searchParams.get("$expand") ? jsonResponse({ value: [{ Id: doc.Id, Zaak: [{ Id: "z", Nummer: "2026Z20455" }] }] }) : jsonResponse({ "@odata.count": 1, value: [doc] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await callTool("tweede_kamer_search", { entity: "Document", filter: "DocumentNummer eq '2026D47144'" });
    const search = new URL(String(fetchMock.mock.calls[0][0]));
    expect(search.searchParams.get("$filter")).toContain("Nummer eq '2026D47144'");
    expect(search.searchParams.get("$filter")).not.toContain("DocumentNummer");
    expect(out.access_note).toContain("DocumentNummer → Nummer");
    expect(out.records[0].canonical_url).toBe("https://www.tweedekamer.nl/kamerstukken/detail?id=2026Z20455&did=2026D47144");
  });

  it("tweede_kamer_search names a dropped field without a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await callTool("tweede_kamer_search", { entity: "Document", filter: "KenmerkAfzender ne null" });
    expect(out.error).toBeDefined();
    expect(out.message).toContain("KenmerkAfzender bestaat niet meer");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tweede_kamer_members takes each member's fractie from the seat it expands", async () => {
    const persons = [
      { Id: "p-1", Roepnaam: "Bart", Achternaam: "Bikkers", Functie: "Tweede Kamerlid" },
      { Id: "p-2", Roepnaam: "Erwin", Achternaam: "Prickaertz", Functie: "Tweede Kamerlid" },
    ];
    const links = [
      { Id: "l-1", Persoon_Id: "p-1", Van: "2025-11-12T00:00:00+01:00", TotEnMet: null, FractieZetel: { Id: "fz-1", Fractie_Id: "f-1", Fractie: { Id: "f-1", Afkorting: "VVD", NaamNL: "Volkspartij voor Vrijheid en Democratie" } } },
      { Id: "l-2", Persoon_Id: "p-2", Van: "2025-11-12T00:00:00+01:00", TotEnMet: null, FractieZetel: { Id: "fz-2", Fractie_Id: "f-2", Fractie: { Id: "f-2", Afkorting: "PVV", NaamNL: "Partij voor de Vrijheid" } } },
    ];
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      return jsonResponse({ value: url.pathname.endsWith("/Persoon") ? persons : links });
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await callTool("tweede_kamer_members", { top: 10 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const linkUrl = new URL(String(fetchMock.mock.calls.find((c) => String(c[0]).includes("FractieZetelPersoon"))![0]));
    expect(linkUrl.searchParams.get("$expand")).toBe("FractieZetel($select=Id,Fractie_Id;$expand=Fractie($select=Id,Afkorting,NaamNL,NaamEN))");
    expect(linkUrl.searchParams.get("$orderby")).toBe("Van desc,Id");
    expect(out.records.map((r: Record<string, any>) => [r.title, r.data.fractie])).toEqual([
      ["Bart Bikkers", "VVD"],
      ["Erwin Prickaertz", "PVV"],
    ]);
  });

  it("tweede_kamer_members with active=false still takes the open seat first", async () => {
    // The newest 250 of all links reach back two years: a member seated
    // earlier is only found among the open links.
    const persons = [
      { Id: "p-1", Roepnaam: "Mirjam", Achternaam: "Bikkers", Functie: "Tweede Kamerlid" },
      { Id: "p-2", Roepnaam: "Erwin", Achternaam: "Prickaertz", Functie: "Tweede Kamerlid" },
    ];
    const seat = (afkorting: string) => ({ Id: `fz-${afkorting}`, Fractie_Id: `f-${afkorting}`, Fractie: { Id: `f-${afkorting}`, Afkorting: afkorting, NaamNL: afkorting } });
    const open = [{ Id: "l-1", Persoon_Id: "p-1", Van: "2023-01-17T00:00:00+01:00", TotEnMet: null, FractieZetel: seat("CU") }];
    const all = [
      { Id: "l-9", Persoon_Id: "p-2", Van: "2025-11-12T00:00:00+01:00", TotEnMet: "2026-01-01T00:00:00+01:00", FractieZetel: seat("PVV") },
    ];
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/Persoon")) return jsonResponse({ value: persons });
      return jsonResponse({ value: url.searchParams.get("$filter")!.includes("TotEnMet eq null") ? open : all });
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await callTool("tweede_kamer_members", { active: false, fractie: "CU", top: 10 });
    const filters = fetchMock.mock.calls
      .map((c) => new URL(String(c[0])))
      .filter((u) => u.pathname.endsWith("/FractieZetelPersoon"))
      .map((u) => u.searchParams.get("$filter"));
    expect(filters).toEqual(["TotEnMet eq null and Verwijderd eq false", "Verwijderd eq false"]);
    expect(out.records.map((r: Record<string, any>) => [r.title, r.data.fractie])).toEqual([["Mirjam Bikkers", "CU"]]);
    const all2 = await callTool("tweede_kamer_members", { active: false, top: 10 });
    expect(all2.records.map((r: Record<string, any>) => r.data.fractie)).toEqual(["CU", "PVV"]);
  });

  it("tweede_kamer_search translates a Document.Kamer number and says so", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ "@odata.count": 0, value: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await callTool("tweede_kamer_search", { entity: "Document", filter: "Kamer eq 2", top: 2 });
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get("$filter")).toContain("Kamer eq 'Tweede Kamer'");
    expect(out.access_note).toContain("Kamer eq 2 → Kamer eq 'Tweede Kamer'");
  });

  it("commissieUrl asks for every activiteit of the moment, in a fixed order", async () => {
    // Eleven activiteiten at once: a page of ten in the default order could miss the debate.
    const rows = Array.from({ length: 11 }, (_, k) => ({ Nummer: `2026A0${1000 + k}`, Onderwerp: k === 10 ? "Mensenrechtenbeleid" : `Ander overleg ${k}` }));
    const fetchMock = vi.fn(async () => jsonResponse({ value: rows }));
    vi.stubGlobal("fetch", fetchMock);
    const src = new TweedeKamerDebattenSource(testConfig);
    const url = await src.commissieUrl({ soort: "Commissie", aanvangstijd: "2026-10-28T10:00:00+01:00", titel: "Mensenrechtenbeleid" });
    const sent = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(sent.searchParams.get("$orderby")).toBe("Id");
    expect(Number(sent.searchParams.get("$top"))).toBeGreaterThan(10);
    expect(url).toContain("2026A01010");
  });
});
