import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { TenderNedSource, noticeDeadlinesFromHtml, noticeDeadlinesFromText } from "../src/sources/tenderned.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { buildSamplePdf } from "./helpers/pdf-fixture.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

/**
 * A market consultation's notice (eForms form E1) prints its own deadline,
 * "Termijn ontvangst antwoorden", which TenderNed's metadata field
 * sluitingsDatumMarktconsultatie often contradicts (seen up to a month later).
 * The notice is the one that counts. Fixture: a made-up consultation about
 * road maintenance.
 */
const MAC = { code: "MAC", omschrijving: "Marktconsultatie" };
const AAO = { code: "AAO", omschrijving: "Aankondiging opdracht" };

const row = (label: string, value: string) =>
  `<tr>\n <td><span class="label">${label}</span><span class="text">: </span></td>\n <td>${value}</td>\n</tr>`;
const header = (level: 1 | 2 | 3, text: string) => `<tr class="header${level}">\n <th colspan="2">${text}</th>\n</tr>`;

/** Section 5.1.12 as TenderNed renders it: the date and the time are two value spans. */
function noticeHtml(deadlines: string[], label = "Termijn ontvangst antwoorden"): string {
  return [
    "<table><tbody>",
    header(1, '1. <span class="label">Koper</span>'),
    row("Officiële naam", "Gemeente Voorbeeldstad"),
    header(1, '5. <span class="label">Perceel</span>'),
    header(3, '5.1.12 <span class="label">Voorwaarden van de aanbesteding</span>'),
    row("Elektronische indiening", '<span class="dynamic-label">Vereist</span>'),
    ...deadlines.map((d) => {
      const [date, ...time] = d.split(" ");
      return row(label, `<span class="value" aria-label="${label}">${date}</span>${time.length ? `<span class="text"> </span><span class="value">${time.join(" ")}</span>` : ""}`);
    }),
    header(3, '5.1.16 <span class="label">Nadere inlichtingen, bemiddeling en evaluatie</span>'),
    "</tbody></table>",
  ].join("\n");
}

const consultation = {
  publicatieId: 910001,
  kenmerk: 810001,
  aanbestedingNaam: "Marktconsultatie onderhoud wegen en fietspaden",
  opdrachtgeverNaam: "Gemeente Voorbeeldstad",
  opdrachtBeschrijving: "Verkenning van de markt voor groot onderhoud aan asfaltwegen en fietspaden.",
  publicatieDatum: "2026-10-01T09:00:00",
  sluitingsDatumMarktconsultatie: "2026-11-20",
  typePublicatie: "Marktconsultatie",
  publicatieCode: "EFE1",
  aankondigingCode: MAC,
  procedureCode: MAC,
  typeOpdrachtCode: { code: "W", omschrijving: "Werken" },
  formType: "consultation",
};

type Handler = (id: string) => Response | Promise<Response> | undefined;

/** Routes TenderNed's endpoints; a handler returning undefined falls back to the default. */
function routed(routes: { detail?: Handler; html?: Handler; pdf?: Handler; search?: () => Response } = {}) {
  return vi.fn(async (input: string) => {
    const parts = new URL(input).pathname.split("/");
    const last = parts.at(-1) ?? "";
    const id = /^\d+$/.test(last) ? last : (parts.at(-2) ?? "");
    if (last === "publicaties") return routes.search?.() ?? jsonResponse({ content: [], totalElements: 0 });
    if (last === "gerelateerd") return jsonResponse([]);
    if (last === "html") return (await routes.html?.(id)) ?? jsonResponse({ html: noticeHtml(["06/11/2026 23:59 +01:00"]) });
    if (last === "pdf") return (await routes.pdf?.(id)) ?? new Response("nope", { status: 500 });
    return (await routes.detail?.(id)) ?? jsonResponse(consultation);
  });
}

const paths = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map((c) => new URL((c as unknown as [string])[0]).pathname.replace(/^.*\/publicaties/, ""));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearHttpCache();
});

describe("reading the deadline from a consultation notice", () => {
  it("reads date, time and UTC offset from the HTML rendering", () => {
    expect(noticeDeadlinesFromHtml(noticeHtml(["06/11/2026 23:59 +01:00"]))).toEqual([
      { iso: "2026-11-06T23:59:00+01:00", datum: "2026-11-06" },
    ]);
    expect(noticeDeadlinesFromHtml(noticeHtml(["14/10/2026 12:00"], "Deadline for receipt of answers"))).toEqual([
      { iso: "2026-10-14T12:00:00", datum: "2026-10-14" },
    ]);
    expect(noticeDeadlinesFromHtml(noticeHtml(["14/10/2026"]))).toEqual([{ iso: "2026-10-14", datum: "2026-10-14" }]);
  });

  it("finds nothing in a notice without that field, and ignores other dates", () => {
    const html = noticeHtml([]).replace("</tbody>", `${row("Verzenddatum van de aankondiging", "01/10/2026 09:00 +02:00")}</tbody>`);
    expect(noticeDeadlinesFromHtml(html)).toEqual([]);
  });

  it("lists several deadlines once each, earliest first", () => {
    const html = noticeHtml(["20/11/2026 12:00 +01:00", "06/11/2026 23:59 +01:00", "20/11/2026 12:00 +01:00"]);
    expect(noticeDeadlinesFromHtml(html).map((d) => d.iso)).toEqual(["2026-11-06T23:59:00+01:00", "2026-11-20T12:00:00+01:00"]);
  });

  it("reads the label from PDF text, where it wraps over lines", () => {
    const text = "Talen waarin\ninschrijvingen kunnen worden\ningediend:\nNederlands\nTermijn ontvangst\nantwoorden: 06/11/2026 23:59 +01:00\n5.1.16 Nadere inlichtingen";
    expect(noticeDeadlinesFromText(text)).toEqual([{ iso: "2026-11-06T23:59:00+01:00", datum: "2026-11-06" }]);
    expect(noticeDeadlinesFromText("Verzenddatum van de aankondiging: 01/10/2026 09:00 +02:00")).toEqual([]);
  });
});

describe("TenderNedSource.get for a market consultation", () => {
  it("takes the notice's earlier deadline over TenderNed's field and says both", async () => {
    vi.stubGlobal("fetch", routed());
    const out = await new TenderNedSource(testConfig).get({ publicatieId: "910001" });
    expect(out.item).toMatchObject({
      sluitingsDatum: "2026-11-06T23:59:00+01:00",
      sluitingsDatumBron: "aankondiging",
      sluitingsDatumGecontroleerd: true,
      sluitingsDatumOorspronkelijk: "2026-11-20",
      sluitingsDatumPlaceholder: false,
    });
    expect(out.item.sluitingsDatumOpmerking).toBe(
      "TenderNed-veld sluitingsDatumMarktconsultatie zegt 20-11-2026, de aankondiging zelf (publicatie 910001, 'Termijn ontvangst antwoorden') 06-11-2026 23:59 (+01:00); de aankondiging is leidend.",
    );
    expect(out.access_note).toContain("Sluitingsdatum: TenderNed-veld sluitingsDatumMarktconsultatie zegt 20-11-2026");
  });

  it("follows the notice when it is later than TenderNed's field too", async () => {
    vi.stubGlobal("fetch", routed({ html: () => jsonResponse({ html: noticeHtml(["04/12/2026 12:00 +01:00"]) }) }));
    const { item } = await new TenderNedSource(testConfig).get({ publicatieId: "910001" });
    expect(item).toMatchObject({ sluitingsDatum: "2026-12-04T12:00:00+01:00", sluitingsDatumOorspronkelijk: "2026-11-20", sluitingsDatumGecontroleerd: true });
    expect(item.sluitingsDatumOpmerking).toContain("zegt 20-11-2026, de aankondiging zelf");
  });

  it("adds only the time when the notice agrees with TenderNed's field", async () => {
    vi.stubGlobal("fetch", routed({ html: () => jsonResponse({ html: noticeHtml(["20/11/2026 17:00 +01:00"]) }) }));
    const out = await new TenderNedSource(testConfig).get({ publicatieId: "910001" });
    expect(out.item).toMatchObject({ sluitingsDatum: "2026-11-20T17:00:00+01:00", sluitingsDatumBron: "aankondiging", sluitingsDatumGecontroleerd: true });
    expect(out.item.sluitingsDatumOorspronkelijk).toBeUndefined();
    expect(out.item.sluitingsDatumOpmerking).toBeUndefined();
    expect(out.access_note ?? "").not.toContain("Sluitingsdatum");
  });

  it("fills in the notice's deadline when TenderNed's field is empty", async () => {
    vi.stubGlobal("fetch", routed({ detail: () => jsonResponse({ ...consultation, sluitingsDatumMarktconsultatie: undefined }) }));
    const { item } = await new TenderNedSource(testConfig).get({ publicatieId: "910001" });
    expect(item).toMatchObject({ sluitingsDatum: "2026-11-06T23:59:00+01:00", sluitingsDatumBron: "aankondiging", sluitingsDatumGecontroleerd: true });
    expect(item.sluitingsDatumOorspronkelijk).toBeUndefined();
    expect(item.sluitingsDatumOpmerking).toContain("TenderNed zelf geeft geen sluitingsdatum; de aankondiging");
  });

  it("still reads the notice when include_award is off", async () => {
    const fetchMock = routed();
    vi.stubGlobal("fetch", fetchMock);
    const { item } = await new TenderNedSource(testConfig).get({ publicatieId: "910001", include_award: false });
    expect(paths(fetchMock)).toContain("/910001/html");
    expect(item.sluitingsDatum).toBe("2026-11-06T23:59:00+01:00");
    expect(item.gunning).toBeUndefined();
  });

  it("does not fetch the notice of an ordinary tender for its deadline", async () => {
    const fetchMock = routed({ detail: () => jsonResponse({ ...consultation, aankondigingCode: AAO, sluitingsDatum: "2026-11-20T10:00:00" }) });
    vi.stubGlobal("fetch", fetchMock);
    const { item } = await new TenderNedSource(testConfig).get({ publicatieId: "910001", include_award: false });
    expect(paths(fetchMock)).not.toContain("/910001/html");
    expect(item).toMatchObject({ sluitingsDatum: "2026-11-20T10:00:00", sluitingsDatumBron: "sluitingsDatum", sluitingsDatumGecontroleerd: true });
  });

  it("falls back to the notice PDF when the HTML rendering cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      routed({
        html: () => new Response("kapot", { status: 404 }),
        pdf: () =>
          new Response(buildSamplePdf("Termijn ontvangst antwoorden: 06/11/2026 23:59 +01:00").buffer as ArrayBuffer, {
            status: 200,
            headers: { "content-type": "application/pdf" },
          }),
      }),
    );
    const { item } = await new TenderNedSource(testConfig).get({ publicatieId: "910001", include_text: true });
    expect(item).toMatchObject({ sluitingsDatum: "2026-11-06T23:59:00+01:00", sluitingsDatumGecontroleerd: true, sluitingsDatumOorspronkelijk: "2026-11-20" });
  });

  it("keeps TenderNed's field, marked unchecked with a warning, when the notice cannot be read", async () => {
    vi.stubGlobal("fetch", routed({ html: () => new Response("kapot", { status: 404 }) }));
    const out = await new TenderNedSource(testConfig).get({ publicatieId: "910001" });
    expect(out.item).toMatchObject({ sluitingsDatum: "2026-11-20", sluitingsDatumBron: "sluitingsDatumMarktconsultatie", sluitingsDatumGecontroleerd: false });
    expect(out.item.sluitingsDatumOpmerking).toContain("Niet gecontroleerd tegen de aankondiging zelf");
    expect(out.access_note).toContain("Niet gecontroleerd tegen de aankondiging zelf");
  });

  it("marks TenderNed's field unchecked when the notice states no deadline", async () => {
    vi.stubGlobal("fetch", routed({ html: () => jsonResponse({ html: noticeHtml([]) }) }));
    const { item } = await new TenderNedSource(testConfig).get({ publicatieId: "910001" });
    expect(item).toMatchObject({ sluitingsDatum: "2026-11-20", sluitingsDatumGecontroleerd: false });
    expect(item.sluitingsDatumOpmerking).toContain("De aankondiging zelf noemt geen termijn");
  });

  it("takes the earliest when the notice names several deadlines", async () => {
    vi.stubGlobal("fetch", routed({ html: () => jsonResponse({ html: noticeHtml(["13/11/2026 12:00 +01:00", "09/11/2026 12:00 +01:00"]) }) }));
    const { item } = await new TenderNedSource(testConfig).get({ publicatieId: "910001" });
    expect(item.sluitingsDatum).toBe("2026-11-09T12:00:00+01:00");
    expect(item.sluitingsDatumOpmerking).toContain("meerdere termijnen (09-11-2026 12:00 (+01:00), 13-11-2026 12:00 (+01:00))");
  });

  it("reads the deadline from the latest rectification", async () => {
    const fetchMock = routed({
      detail: () => jsonResponse({ ...consultation, sluitingsDatumMarktconsultatie: "2026-11-27", publicatieIDLaatsteRectificatie: 910050 }),
      html: (id) => (id === "910050" ? jsonResponse({ html: noticeHtml(["25/11/2026 23:59 +01:00"]) }) : undefined),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { item } = await new TenderNedSource(testConfig).get({ publicatieId: "910001" });
    expect(paths(fetchMock)).toContain("/910050/html");
    expect(item).toMatchObject({ sluitingsDatum: "2026-11-25T23:59:00+01:00", sluitingsDatumGecontroleerd: true, sluitingsDatumOorspronkelijk: "2026-11-27" });
    expect(item.sluitingsDatumOpmerking).toContain("(rectificatie 910050, 'Termijn ontvangst antwoorden')");
  });

  it("shows the earlier date, unchecked, when the rectification cannot be read and the two disagree", async () => {
    vi.stubGlobal(
      "fetch",
      routed({
        detail: () => jsonResponse({ ...consultation, sluitingsDatumMarktconsultatie: "2026-11-27", publicatieIDLaatsteRectificatie: 910050 }),
        html: (id) => (id === "910050" ? new Response("kapot", { status: 404 }) : undefined),
      }),
    );
    const { item } = await new TenderNedSource(testConfig).get({ publicatieId: "910001" });
    expect(item).toMatchObject({ sluitingsDatum: "2026-11-06T23:59:00+01:00", sluitingsDatumGecontroleerd: false, sluitingsDatumOorspronkelijk: "2026-11-27" });
    expect(item.sluitingsDatumOpmerking).toContain("welke geldt is niet vast te stellen, dus sluitings_datum is de vroegste (06-11-2026 23:59 (+01:00))");
  });

  it("keeps TenderNed's earlier field over a later original notice when the rectification cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      routed({
        detail: () => jsonResponse({ ...consultation, sluitingsDatumMarktconsultatie: "2026-11-02", publicatieIDLaatsteRectificatie: 910050 }),
        html: (id) => (id === "910050" ? new Response("kapot", { status: 404 }) : undefined),
      }),
    );
    const { item } = await new TenderNedSource(testConfig).get({ publicatieId: "910001" });
    expect(item).toMatchObject({ sluitingsDatum: "2026-11-02", sluitingsDatumBron: "sluitingsDatumMarktconsultatie", sluitingsDatumGecontroleerd: false });
    expect(item.sluitingsDatumOpmerking).toContain("de vroegste (02-11-2026)");
  });
});

describe("tenderned_aanbestedingen_search for market consultations", () => {
  /** A date `offset` days from now. */
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const ddmmyyyy = (iso: string) => iso.split("-").reverse().join("/");

  const rows = [
    { publicatieId: "910001", typePublicatie: MAC, publicatieDatum: `${day(-3)}T09:00:00`, sluitingsDatumMarktconsultatie: day(30) },
    { publicatieId: "910002", typePublicatie: MAC, publicatieDatum: `${day(-2)}T09:00:00` },
    { publicatieId: "910003", typePublicatie: AAO, publicatieDatum: `${day(-2)}T09:00:00`, sluitingsDatum: `${day(20)}T10:00:00` },
  ];
  const details: Record<string, Record<string, unknown>> = {
    "910001": { ...consultation, publicatieId: 910001, sluitingsDatumMarktconsultatie: day(30) },
    "910002": { ...consultation, publicatieId: 910002, sluitingsDatumMarktconsultatie: undefined },
    "910003": { ...consultation, publicatieId: 910003, aankondigingCode: AAO, sluitingsDatum: `${day(20)}T10:00:00` },
  };
  const htmlFor = (id: string) => (id === "910001" ? noticeHtml([`${ddmmyyyy(day(16))} 23:59 +01:00`]) : noticeHtml([`${ddmmyyyy(day(12))} 12:00 +01:00`]));

  it("checks each consultation's deadline against its notice, including one without any date", async () => {
    const fetchMock = routed({
      search: () => jsonResponse({ content: rows, totalElements: rows.length }),
      detail: (id) => jsonResponse(details[id]),
      html: (id) => jsonResponse({ html: htmlFor(id) }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await new TenderNedSource(testConfig).search({ rows: 10 });
    const [first, second, third] = out.items;
    expect(first).toMatchObject({ sluitingsDatum: `${day(16)}T23:59:00+01:00`, sluitingsDatumBron: "aankondiging", sluitingsDatumGecontroleerd: true, sluitingsDatumOorspronkelijk: day(30) });
    expect(first.sluitingsDatumOpmerking).toContain("de aankondiging is leidend");
    expect(second).toMatchObject({ sluitingsDatum: `${day(12)}T12:00:00+01:00`, sluitingsDatumGecontroleerd: true });
    expect(third).toMatchObject({ sluitingsDatum: `${day(20)}T10:00:00`, sluitingsDatumBron: "sluitingsDatum", sluitingsDatumGecontroleerd: true });
    // The ordinary tender is only re-read, not its notice.
    expect(paths(fetchMock)).not.toContain("/910003/html");
    expect(out.access_note).toContain("Bij 2 marktconsultatie(s) noemt de aankondiging zelf een andere termijn");
    expect(out.access_note).not.toContain("ongecontroleerd");
  });

  it("warns on a consultation whose notice cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      routed({
        search: () => jsonResponse({ content: rows.slice(0, 1), totalElements: 1 }),
        detail: (id) => jsonResponse(details[id]),
        html: () => new Response("kapot", { status: 404 }),
      }),
    );
    const out = await new TenderNedSource(testConfig).search({ rows: 10 });
    expect(out.items[0]).toMatchObject({ sluitingsDatum: day(30), sluitingsDatumGecontroleerd: false });
    expect(out.items[0].sluitingsDatumOpmerking).toContain("Niet gecontroleerd tegen de aankondiging zelf");
    expect(out.access_note).toContain("Bij 1 marktconsultatie(s) kon sluitings_datum niet worden bevestigd door de aankondiging zelf");
    expect(out.access_note).not.toContain("komt sluitings_datum ongecontroleerd uit de zoekindex");
  });

  it("warns on a consultation that was not re-checked at all", async () => {
    vi.stubGlobal(
      "fetch",
      routed({
        search: () => jsonResponse({ content: rows.slice(0, 1), totalElements: 1 }),
        detail: () => jsonResponse({ message: "Service Unavailable" }, 503),
      }),
    );
    const out = await new TenderNedSource(testConfig).search({ rows: 10 });
    expect(out.items[0]).toMatchObject({ sluitingsDatum: day(30), sluitingsDatumGecontroleerd: false });
    expect(out.items[0].sluitingsDatumOpmerking).toContain("ligt de termijn in de aankondiging vaak eerder");
  });

  it("returns the notice's deadline and the warning as snake_case fields from both tools", async () => {
    vi.stubGlobal(
      "fetch",
      routed({
        search: () => jsonResponse({ content: rows.slice(0, 1), totalElements: 1 }),
        detail: (id) => jsonResponse(details[id] ?? details["910001"]),
        html: (id) => jsonResponse({ html: htmlFor(id) }),
      }),
    );
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tenderned-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
      return (JSON.parse(result.content[0].text) as { records: Array<{ data: Record<string, unknown> }> }).records[0].data;
    };
    try {
      const expected = {
        sluitings_datum: `${day(16)}T23:59:00+01:00`,
        sluitings_datum_bron: "aankondiging",
        sluitings_datum_gecontroleerd: true,
        sluitings_datum_oorspronkelijk: day(30),
      };
      const hit = await call("tenderned_aanbestedingen_search", { query: "wegen", top: 5 });
      const detail = await call("tenderned_aanbesteding_get", { publicatie_id: "910001" });
      expect(hit).toMatchObject(expected);
      expect(detail).toMatchObject(expected);
      expect(String(hit.sluitings_datum_opmerking)).toContain("de aankondiging is leidend");
      expect(detail.sluitings_datum_opmerking).toBe(hit.sluitings_datum_opmerking);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
