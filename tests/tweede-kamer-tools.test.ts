import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { jsonResponse } from "./helpers/config.js";

type Payload = Record<string, any>;

async function callTool(name: string, args: Record<string, unknown>): Promise<Payload> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tk-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }> };
    return JSON.parse(result.content[0].text) as Payload;
  } finally {
    await client.close();
    await server.close();
  }
}

function urlOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): URL {
  return new URL(String(fetchMock.mock.calls[call][0]));
}

const MOTIE = {
  Id: "eb749f13-9fed-43b6-b869-04027676d08a",
  Soort: "Motie",
  DocumentNummer: "2026D47851",
  Titel: "Vaststelling van de begrotingsstaat van het Ministerie van Financiën (IXB) voor het jaar 2027",
  Onderwerp: "Motie van het lid Van Eijk c.s. over de aanpassing van het heffingsvrij resultaat ",
  Datum: "2026-10-01T00:00:00+02:00",
  ContentType: "application/pdf",
  Zaak: [{ Id: "z-1", Nummer: "2026Z20751", Soort: "Motie" }],
};
const BIJLAGE = {
  Id: "3f0c2a71-5b6e-4d2a-9a41-1c7e8b2d4f60",
  Soort: "Bijlage",
  DocumentNummer: "2025D41007",
  Titel: null,
  Onderwerp: "Beslisnota bij Kamerbrief over wachtlijsten in de jeugdzorg",
  Datum: "2025-10-06T00:00:00+02:00",
  Zaak: [],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearHttpCache();
});

describe("tweede_kamer_documents", () => {
  it("ANDs the terms, links each record to its own page and reports the real total", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ "@odata.count": 1234, value: [MOTIE, BIJLAGE] }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_documents", { query: "heffingsvrij resultaat", top: 2 });

    // The search, then one lookup of the zaak numbers for the links.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const filter = urlOf(fetchMock).searchParams.get("$filter")!;
    expect(filter).toContain("contains(Onderwerp,'heffingsvrij')");
    expect(filter).toContain("contains(Onderwerp,'resultaat')");
    expect(filter).toContain(" and ");
    expect(filter).not.toContain("heffingsvrij resultaat");

    const [motie, bijlage] = payload.records;
    expect(motie.title).toBe("Motie van het lid Van Eijk c.s. over de aanpassing van het heffingsvrij resultaat");
    expect(motie.canonical_url).toBe("https://www.tweedekamer.nl/kamerstukken/detail?id=2026Z20751&did=2026D47851");
    expect(motie.snippet).toContain("dossier: Vaststelling van de begrotingsstaat");
    // No zaak (annex): direct document download, still specific.
    expect(bijlage.canonical_url).toBe("https://www.tweedekamer.nl/downloads/document?id=2025D41007");
    for (const rec of payload.records) {
      expect(rec.canonical_url).not.toBe("https://www.tweedekamer.nl");
      expect(rec.data.related_links ?? []).toEqual([]);
    }

    expect(payload.provenance.total_results).toBe(1234);
    expect(payload.pagination).toEqual({ offset: 0, limit: 2, total: 1234, has_more: true });
    expect(payload.summary).toBe("2 van 1234 Tweede Kamer documenten");
    expect(payload.access_note).toContain("niet in de volledige tekst");
    expect(payload.access_note).toContain("(alle verplicht)");
    // A longer term also matches inside words ("politie" in "politiek"); the note says how to avoid that.
    expect(payload.access_note).toContain('dus "heffingsvrij" in plaats van heffingsvrij');
  });

  it("pages upstream with $skip instead of slicing from row 0", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ "@odata.count": 12, value: [MOTIE, BIJLAGE] }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_documents", { query: "stikstof", top: 5, offset: 10 });

    const url = urlOf(fetchMock);
    expect(url.searchParams.get("$skip")).toBe("10");
    expect(url.searchParams.get("$top")).toBe("5");
    expect(payload.records).toHaveLength(2);
    expect(payload.pagination).toEqual({ offset: 10, limit: 5, total: 12, has_more: false });
  });

  it("accepts a type/date filter without query and filters on Dutch local dates", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ "@odata.count": 0, value: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_documents", { type: "Motie", date_from: "2026-10-01", date_to: "2026-10-01" });

    const filter = urlOf(fetchMock).searchParams.get("$filter")!;
    expect(filter).toContain("Datum ge 2026-10-01T00:00:00+02:00");
    expect(filter).toContain("Datum lt 2026-10-02T00:00:00+02:00");
    expect(payload.records).toEqual([]);
    expect(payload.pagination.total).toBe(0);
  });

  it("returns an explicit error for an invalid date instead of a silent empty result", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const payload = await callTool("tweede_kamer_documents", { query: "stikstof", date_from: "1 juli 2026" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(payload.error).toBe("unexpected");
    expect(payload.message).toContain("JJJJ-MM-DD");
  });

  it("ignores recency words and an open-ended date_to instead of failing or finding nothing", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ "@odata.count": 2664, value: [MOTIE] }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_documents", { query: "nieuwste stikstof?", date_to: "9999-12-31", top: 1 });

    const filter = urlOf(fetchMock).searchParams.get("$filter")!;
    expect(filter).toBe("(contains(Titel,'stikstof') or contains(Onderwerp,'stikstof'))");
    expect(payload.error).toBeUndefined();
    expect(payload.access_note).toContain("Genegeerde stopwoorden: nieuwste");
    expect(payload.access_note).toContain("geen bovengrens");
  });

  it("explains a zero result for a multi-term search", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ "@odata.count": 0, value: [] })));
    const payload = await callTool("tweede_kamer_documents", { query: "Uitkeringen WW" });
    expect(payload.summary).toBe("0 van 0 Tweede Kamer documenten");
    expect(payload.access_note).toContain("alle zoektermen moeten samen voorkomen in Titel of Onderwerp");
    expect(payload.access_note).toContain('"WW" (los woord)');
  });
});

describe("tweede_kamer_search", () => {
  it("no longer requires query when a filter is given", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ "@odata.count": 59691, value: [MOTIE] }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_search", { entity: "Document", filter: "Soort eq 'Motie'", top: 1 });

    expect(payload.error).toBeUndefined();
    // Deleted records (tombstones) are left out of a listing.
    expect(urlOf(fetchMock).searchParams.get("$filter")).toBe("(Verwijderd eq false) and (Soort eq 'Motie')");
    expect(payload.pagination).toEqual({ offset: 0, limit: 1, total: 59691, has_more: true });
  });

  it("applies query and date_from to Zaak instead of returning the newest zaken", async () => {
    const zaak = {
      Id: "z-9",
      Nummer: "2026Z20455",
      Soort: "Motie",
      Titel: "Evaluatie Schipholbeleid",
      Onderwerp: "Motie van het lid Van der Plas over de gevolgen van stikstofbeleid",
      GestartOp: "2026-09-29T00:00:00+02:00",
      Status: "Vrijgegeven",
      Document: [{ Id: "d-9", DocumentNummer: "2026D47272", Soort: "Motie" }],
    };
    const fetchMock = vi.fn(async () => jsonResponse({ "@odata.count": 1, value: [zaak] }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_search", { entity: "Zaak", query: "stikstof", date_from: "2026-07-01" });

    const url = urlOf(fetchMock);
    expect(url.pathname.endsWith("/Zaak")).toBe(true);
    const filter = url.searchParams.get("$filter")!;
    expect(filter).toContain("contains(Onderwerp,'stikstof')");
    expect(filter).toContain("GestartOp ge 2026-07-01T00:00:00+02:00");
    expect(payload.records[0].title).toBe(zaak.Onderwerp);
    expect(payload.records[0].canonical_url).toBe("https://www.tweedekamer.nl/kamerstukken/detail?id=2026Z20455&did=2026D47272");
    expect(payload.provenance.total_results).toBe(1);
  });

  it("reports an upstream 400 explicitly and never falls back to an unfiltered call", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_search", { query: "jeugdbescherming wachtlijsten justitie", top: 50, orderby: "Datum desc", entity: "Zaak" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(payload.records).toBeUndefined();
    expect(payload.error).toBe("http_error");
    expect(payload.message).toContain("HTTP 400");
    expect(payload.details.orderby).toBe("Datum desc");
  });

  it("propagates upstream outages as errors, not as an empty or unfiltered page", async () => {
    const fetchMock = vi.fn(async (_input: string) => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_search", { query: "klimaat", top: 3 });

    expect(payload.error).toBe("http_error");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of fetchMock.mock.calls) {
      expect(new URL(String(call[0])).searchParams.get("$filter")).toContain("klimaat");
    }
  });

  it("rejects an unknown entity with the list of valid ones", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const payload = await callTool("tweede_kamer_search", { entity: "Kamerstuk", query: "stikstof" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(payload.message).toContain("Onbekende Tweede Kamer-entity");
    expect(payload.suggestion).toContain("Kamerstukdossier");
  });

  it("dryRun shows the exact OData request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const payload = await callTool("tweede_kamer_search", { query: "WW", dryRun: true });
    expect(fetchMock).not.toHaveBeenCalled();
    const params = payload.planned_requests[0].params;
    expect(params.$count).toBe("true");
    expect(params.$filter).toContain("contains(concat(concat(' ',Titel),' '),' WW ')");
  });

  it("rebuilds once with a smaller word filter when the service rejects a query plus caller filter", async () => {
    // The first plan uses all the room the estimate allows; the service counts more and refuses.
    let searches = 0;
    const fetchMock = vi.fn(async (input: string) => {
      const params = new URL(input).searchParams;
      // The count before the search: few rows, so the short term gets every spelling that fits.
      if (params.get("$top") === "0") return jsonResponse({ "@odata.count": 812, value: [] });
      if ((params.get("$filter") ?? "").startsWith("Id in (")) return jsonResponse({ value: [] });
      searches += 1;
      return searches === 1 ? new Response("", { status: 400 }) : jsonResponse({ "@odata.count": 3, value: [MOTIE] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_search", { entity: "Document", query: "ICT", filter: "Soort eq 'Motie'", top: 5 });

    // Count, rejected search, smaller search, link lookup.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(searches).toBe(2);
    const first = urlOf(fetchMock, 1).searchParams.get("$filter")!;
    const second = urlOf(fetchMock, 2).searchParams.get("$filter")!;
    expect(second.length).toBeLessThan(first.length);
    expect(second).toContain("(Soort eq 'Motie')");
    expect(second).toContain("contains(concat(concat(' ',Titel),' '),' ICT ')");
    expect(payload.error).toBeUndefined();
    expect(payload.pagination.total).toBe(3);
    expect(payload.access_note).toContain("kleinere woordgrens-filter");
  });

  it("does not retry a rejected caller filter without query terms", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const payload = await callTool("tweede_kamer_search", { entity: "Document", filter: "Bestaatniet eq 'x'" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(payload.error).toBe("http_error");
  });

  it("names the fields it searched when a Persoon search finds nobody", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ "@odata.count": 0, value: [] })));
    const payload = await callTool("tweede_kamer_search", { entity: "Persoon", query: "Xyzzy" });
    expect(payload.access_note).toContain("Geen resultaten in Achternaam, Roepnaam of Functie");
    expect(payload.access_note).not.toContain("titel of onderwerp");
  });
});

describe("tweede_kamer_votes", () => {
  const BESLUIT_ID = "c32bfbe5-f046-48f3-bd56-4a074d4a5ae7";
  const besluit = {
    Id: BESLUIT_ID,
    BesluitSoort: "Stemmen - verworpen",
    BesluitTekst: "Verworpen.",
    StemmingsSoort: "Met handopsteken",
    Status: "Besluit",
    Zaak: [
      {
        Id: "64db5eb1-4ad8-4ee1-88c5-9960d34d6423",
        Nummer: "2026Z15215",
        Soort: "Motie",
        Titel: "Evaluatie Schipholbeleid",
        Onderwerp: "Gewijzigde motie van de leden Kröger en Kostić over de MER",
        Document: [{ Id: "d-1", DocumentNummer: "2026D34153", Soort: "Motie (gewijzigd/nader)" }],
      },
    ],
    Agendapunt: {
      Id: "a-1",
      Onderwerp: "Stemmingen over: moties ingediend bij het tweeminutendebat Schiphol",
      Activiteit: { Id: "act-1", Datum: "2026-07-02T13:30:00+02:00", Soort: "Stemmingen" },
    },
  };
  const vote = (actor: string, soort: string, size: number) => ({
    Id: `s-${actor}`,
    Besluit_Id: BESLUIT_ID,
    Soort: soort,
    FractieGrootte: size,
    ActorNaam: actor,
    ActorFractie: actor,
    Vergissing: false,
    GewijzigdOp: "2026-10-02T10:09:24.86+02:00",
  });
  const entitySet = (input: string) => new URL(input).pathname.split("/").pop() ?? "";

  /** Answers the Stemming query with `votes` and the Besluit lookup with the decision. */
  function serve(votes: unknown[], count: number, extra: (input: string) => Response | undefined = () => undefined) {
    return vi.fn(async (input: string) => {
      const custom = extra(input);
      if (custom) return custom;
      if (entitySet(input) === "Besluit") return jsonResponse({ value: [besluit] });
      return jsonResponse({ "@odata.count": count, value: votes });
    });
  }

  it("filters on the voted zaak and links every vote to its motion and outcome", async () => {
    const fetchMock = serve([vote("VVD", "Tegen", 22), vote("SP", "Voor", 5)], 17);
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_votes", { query: "Schiphol MER", top: 2 });

    // The count for the short term "MER" (with "Schiphol" in it), the vote query, the decision lookup.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const probe = urlOf(fetchMock, 0);
    expect(probe.searchParams.get("$top")).toBe("0");
    expect(probe.searchParams.get("$filter")).toContain("contains(z/Onderwerp,'Schiphol')");
    const url = urlOf(fetchMock, 1);
    expect(url.pathname.endsWith("/Stemming")).toBe(true);
    const filter = url.searchParams.get("$filter")!;
    expect(filter).toContain("Besluit/Zaak/any(z: ");
    expect(filter).toContain("contains(z/Onderwerp,'Schiphol')");
    expect(filter).toContain("contains(concat(concat(' ',z/Onderwerp),' '),' MER ')");
    // No per-row expand on the vote query: that made it take up to a minute.
    expect(url.searchParams.get("$expand")).toBeNull();
    // One lookup for the distinct decisions on the page.
    const lookup = urlOf(fetchMock, 2);
    expect(lookup.pathname.endsWith("/Besluit")).toBe(true);
    expect(lookup.searchParams.get("$filter")).toBe(`Id in (${BESLUIT_ID})`);
    expect(lookup.searchParams.get("$expand")).toContain("Zaak(");
    expect(lookup.searchParams.get("$expand")).toContain("Agendapunt(");

    const rec = payload.records[0];
    expect(rec.title).toBe("VVD tegen: Gewijzigde motie van de leden Kröger en Kostić over de MER");
    expect(rec.canonical_url).toBe("https://www.tweedekamer.nl/kamerstukken/detail?id=2026Z15215&did=2026D34153");
    expect(rec.date).toBe("2026-07-02T13:30:00+02:00");
    expect(rec.snippet).toBe("Verworpen. · Motie 2026Z15215 · stemming 2026-07-02");
    expect(rec.data).toMatchObject({
      Soort: "Tegen",
      FractieGrootte: 22,
      besluit_id: BESLUIT_ID,
      besluit_tekst: "Verworpen.",
      uitslag: "verworpen",
      zaak_nummer: "2026Z15215",
      zaak_soort: "Motie",
      stemming_datum: "2026-07-02T13:30:00+02:00",
    });
    expect(rec.data.Besluit).toBeUndefined();
    // The decisions are counted on this page only, not over all 17 votes.
    expect(payload.summary).toBe("2 van 17 stemmingen (deze pagina: 1 besluit)");
    expect(payload.pagination).toEqual({ offset: 0, limit: 2, total: 17, has_more: true });
    for (const r of payload.records) expect(r.canonical_url).not.toBe("https://opendata.tweedekamer.nl");
  });

  it("keeps the votes and says so when the decision lookup fails", async () => {
    const fetchMock = serve([vote("VVD", "Tegen", 22)], 1, (input) =>
      entitySet(input) === "Besluit" ? new Response("", { status: 404 }) : undefined,
    );
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_votes", { date: "2026-07-02" });

    expect(payload.error).toBeUndefined();
    expect(payload.records).toHaveLength(1);
    expect(payload.records[0].data).toMatchObject({ ActorFractie: "VVD", Soort: "Tegen", besluit_id: BESLUIT_ID, uitslag: null });
    expect(payload.access_note).toContain("konden niet (allemaal) worden opgehaald");
    // All votes on this page: the decision count covers them all.
    expect(payload.summary).toBe("1 van 1 stemmingen over 1 besluit");
  });

  it("looks up a zaak_id GUID once and then filters on the zaak", async () => {
    const fetchMock = serve([vote("D66", "Voor", 9)], 1, (input) =>
      new URL(input).pathname.includes("/Zaak(") ? jsonResponse({ Id: "64db5eb1-4ad8-4ee1-88c5-9960d34d6423" }) : undefined,
    );
    vi.stubGlobal("fetch", fetchMock);

    await callTool("tweede_kamer_votes", { zaak_id: "64db5eb1-4ad8-4ee1-88c5-9960d34d6423" });

    // Zaak lookup, vote query, decision lookup.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(urlOf(fetchMock, 1).searchParams.get("$filter")).toBe(
      "(Verwijderd eq false) and (Besluit/Zaak/any(z: z/Id eq 64db5eb1-4ad8-4ee1-88c5-9960d34d6423))",
    );
  });

  it("keeps accepting a Besluit GUID as zaak_id, as it did before", async () => {
    const fetchMock = serve([vote("D66", "Voor", 9)], 1, (input) =>
      new URL(input).pathname.includes("/Zaak(") ? new Response("", { status: 404 }) : undefined,
    );
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_votes", { zaak_id: BESLUIT_ID });

    expect(urlOf(fetchMock, 1).searchParams.get("$filter")).toBe(`(Verwijderd eq false) and (Besluit_Id eq ${BESLUIT_ID})`);
    expect(payload.records).toHaveLength(1);
    expect(payload.records[0].data.zaak_nummer).toBe("2026Z15215");
  });

  it("filters date on the voting session in Dutch time and explains an empty day", async () => {
    const fetchMock = serve([], 0);
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_votes", { date: "2026-07-03", top: 50 });

    // No votes, no decision lookup.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const filter = urlOf(fetchMock).searchParams.get("$filter")!;
    expect(filter).toContain("Besluit/Agendapunt/Activiteit/Datum ge 2026-07-03T00:00:00+02:00");
    expect(filter).toContain("Besluit/Agendapunt/Activiteit/Datum lt 2026-07-04T00:00:00+02:00");
    expect(filter).not.toContain("GewijzigdOp");
    expect(payload.access_note).toContain("stemmingsvergadering");
    expect(payload.records).toEqual([]);
  });

  it("rejects an id it cannot use instead of returning the latest votes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const payload = await callTool("tweede_kamer_votes", { zaak_id: "motie stikstof" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(payload.error).toBe("unexpected");
    expect(payload.message).toContain("zaak_id");
  });
});

describe("tweede_kamer_document_get", () => {
  it("titles the document by its subject, not the dossier", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(MOTIE)));
    const payload = await callTool("tweede_kamer_document_get", { id: MOTIE.Id });
    expect(payload.records[0].title).toBe("Motie van het lid Van Eijk c.s. over de aanpassing van het heffingsvrij resultaat");
    expect(payload.records[0].data.web_url).toBe("https://www.tweedekamer.nl/kamerstukken/detail?id=2026Z20751&did=2026D47851");
  });
});
