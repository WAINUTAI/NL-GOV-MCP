import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BekendmakingenSource,
  SRU_MAX_START_RECORD,
  bekendmakingSnippet,
  detectPlaces,
  extractSruDiagnostic,
  normalizeBekendmakingIdentifier,
  normalizeSruDate,
  normalizeSruDateDetailed,
  parseLegalBasis,
  placeSuggestionNote,
  publicationXmlToText,
  resolveAuthority,
  resolvePublicatiebladen,
  rewriteKeepingSyntax,
  sruTotal,
} from "../src/sources/bekendmakingen.js";
import { rewriteQuery } from "../src/utils/query-rewriter.js";
import { clearHttpCache, markConnectorSuccess } from "../src/utils/connector-runtime.js";
import { parseXml } from "../src/utils/xml-parser.js";
import {
  AANHANGSEL_RECORD,
  BLG_RECORD,
  GMB_RECORD,
  HANDELINGEN_RECORD,
  GMB_XML,
  KST_RECORD,
  SRU_DIAGNOSTIC,
  creatorRecord,
  sruResponse,
  utrechtRecord,
} from "./helpers/bekendmakingen-fixtures.js";
import { testConfig, xmlResponse } from "./helpers/config.js";
import { buildSamplePdf } from "./helpers/pdf-fixture.js";

type Handler = (url: URL) => Response | Promise<Response>;

function stubFetch(handler: Handler) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    return handler(new URL(href));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function calledUrls(fetchMock: ReturnType<typeof stubFetch>): URL[] {
  return fetchMock.mock.calls.map((call) => {
    const input = (call as unknown[])[0];
    return new URL(typeof input === "string" ? input : String((input as URL).href ?? input));
  });
}

/** The CQL of the n-th SRU call. */
function cql(fetchMock: ReturnType<typeof stubFetch>, index = 0): string {
  const sruCalls = calledUrls(fetchMock).filter((url) => url.pathname === "/sru");
  return sruCalls[index]?.searchParams.get("query") ?? "";
}

const source = () => new BekendmakingenSource(testConfig);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearHttpCache();
  markConnectorSuccess("officiele_bekendmakingen", 1);
});

describe("search — CQL", () => {
  it("keeps the established shape for a plain query", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([GMB_RECORD], 1)));
    await source().search({ query: "woningbouw", maximumRecords: 5, authority: "Gouda", type: "beleidsregel", date_from: "2026-01-01", date_to: "2026-06-30" });
    expect(cql(fetchMock)).toBe(
      'woningbouw AND c.product-area="officielepublicaties" AND dt.type="beleidsregel" AND dt.creator="Gouda" AND dt.date>=2026-01-01 AND dt.date<=2026-06-30',
    );
  });

  it("searches an alias authority under every name the source may use", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([GMB_RECORD], 1)));
    const out = await source().search({ query: "openbare verlichting", maximumRecords: 5, authority: "Den Haag" });
    const query = cql(fetchMock);
    expect(query).toContain('dt.creator="Den Haag"');
    expect(query).toContain(`dt.creator="'s-Gravenhage"`);
    expect(query).toMatch(/\(dt\.creator="Den Haag" OR .*\)/);
    expect(out.access_note).toContain("'s-Gravenhage");
  });

  it("turns a Gemeente/Provincie prefix into an organisation type", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([GMB_RECORD], 1)));
    await source().search({ query: "afvalinzameling", maximumRecords: 5, authority: "Gemeente Gouda" });
    await source().search({ query: "afvalinzameling", maximumRecords: 5, authority: "Provincie Utrecht" });
    expect(cql(fetchMock, 0)).toContain('dt.creator="Gouda" AND w.organisatietype="gemeente"');
    expect(cql(fetchMock, 0)).not.toContain("Gemeente Gouda");
    expect(cql(fetchMock, 1)).toContain('dt.creator="Utrecht" AND w.organisatietype="provincie"');
  });

  it("says when authority_type overrides the kind a prefix in the name points to", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([GMB_RECORD], 1)));
    const out = await source().search({ query: "parkeerbeleid", maximumRecords: 5, authority: "Provincie Utrecht", authority_type: "gemeente" });
    expect(cql(fetchMock)).toContain('dt.creator="Utrecht" AND w.organisatietype="gemeente"');
    expect(out.access_note).toContain(
      "authority 'Provincie Utrecht' gezocht als uitgever 'Utrecht' met organisatietype 'gemeente' " +
        "(authority_type 'gemeente' gaat voor op het voorvoegsel in de naam, dat op 'provincie' wijst).",
    );
    const agreeing = await source().search({ query: "parkeerbeleid", maximumRecords: 5, authority: "Provincie Utrecht", authority_type: "provincie" });
    expect(agreeing.access_note ?? "").not.toContain("gaat voor op het voorvoegsel");
    expect(agreeing.access_note).toContain("met organisatietype 'provincie'");
  });

  it("leaves a CQL sort clause out of the free text and points to sort", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([GMB_RECORD], 1)));
    const out = await source().search({ query: "parkeerbeleid sortBy dt.date", maximumRecords: 5 });
    expect(cql(fetchMock)).toBe('parkeerbeleid AND c.product-area="officielepublicaties"');
    expect(out.access_note).toContain("'sortBy dt.date' uit de zoekterm genegeerd; sorteer met de parameter sort.");
  });

  it("filters on authority_type with or without an authority", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([GMB_RECORD], 1)));
    await source().search({ query: "GGZ-beleid", maximumRecords: 5, authority_type: "gemeente" });
    await source().search({ query: "jaarstukken", maximumRecords: 5, authority: "Utrecht", authority_type: "provincie" });
    expect(cql(fetchMock, 0)).toContain('w.organisatietype="gemeente"');
    expect(cql(fetchMock, 0)).not.toContain("dt.creator");
    expect(cql(fetchMock, 1)).toContain('dt.creator="Utrecht" AND w.organisatietype="provincie"');
  });

  it("applies a journal passed as type to publicatienaam, with a note", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([GMB_RECORD], 9)));
    const out = await source().search({ query: "openbare verlichting", maximumRecords: 20, type: "staatscourant", date_from: "2026-06-01" });
    expect(cql(fetchMock)).toBe(
      'openbare AND verlichting AND c.product-area="officielepublicaties" AND w.publicatienaam="Staatscourant" AND dt.date>=2026-06-01',
    );
    expect(out.access_note).toContain("type 'staatscourant' is een publicatieblad");
  });

  it("keeps a journal name that is also a document kind as dt.type", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([KST_RECORD], 1)));
    const out = await source().search({ query: "afvalinzameling", maximumRecords: 5, type: "Kamerstuk" });
    expect(cql(fetchMock)).toContain('dt.type="Kamerstuk"');
    expect(out.access_note ?? "").not.toContain("publicatieblad");
  });

  it("filters on one or more journals, abbreviations included", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([GMB_RECORD], 1)));
    await source().search({ query: "afvalinzameling", maximumRecords: 5, publicatieblad: "gmb, Provinciaal blad;wsb" });
    expect(cql(fetchMock)).toContain(
      '(w.publicatienaam="Gemeenteblad" OR w.publicatienaam="Provinciaal blad" OR w.publicatienaam="Waterschapsblad")',
    );
  });

  it("applies an unknown journal as typed but says which ones exist", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([], 0)));
    const out = await source().search({ query: "afvalinzameling", maximumRecords: 5, publicatieblad: "Gemeentekrant" });
    expect(cql(fetchMock)).toContain('w.publicatienaam="Gemeentekrant"');
    expect(out.access_note).toContain("Onbekend publicatieblad 'Gemeentekrant'");
    expect(out.access_note).toContain("Gemeenteblad");
  });

  it("sorts server-side on the chosen date field", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([GMB_RECORD], 1)));
    await source().search({ query: "Enkhuizen", maximumRecords: 5, authority: "Enkhuizen", sort: "date_newest" });
    await source().search({ query: "afvalinzameling", maximumRecords: 5, sort: "date_oldest", date_field: "publicatiedatum", date_from: "2025" });
    expect(cql(fetchMock, 0)).toBe(
      'Enkhuizen AND c.product-area="officielepublicaties" AND dt.creator="Enkhuizen" sortBy dt.date/sort.descending',
    );
    expect(cql(fetchMock, 1)).toBe(
      'afvalinzameling AND c.product-area="officielepublicaties" AND dt.available>=2025-01-01 sortBy dt.available/sort.ascending',
    );
  });

  it("keeps compounds exact when sorting by date, and says so", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([GMB_RECORD], 1)));
    const newest = await source().search({ query: "GGZ-beleid", maximumRecords: 5, sort: "date_newest", expandCompounds: true });
    expect(calledUrls(fetchMock)).toHaveLength(1);
    expect(cql(fetchMock, 0)).toMatch(/^GGZ-beleid AND /);
    expect(newest.access_note).toContain("alleen als exacte term");
  });

  it("keeps compounds exact for callers that do not ask for expansion (nl_gov_ask)", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([GMB_RECORD], 1)));
    const out = await source().search({ query: "gemeenteblad GGZ-beleid", maximumRecords: 5 });
    expect(calledUrls(fetchMock)).toHaveLength(1);
    expect(cql(fetchMock)).toBe('gemeenteblad AND GGZ-beleid AND c.product-area="officielepublicaties"');
    expect(out.access_note ?? "").not.toContain("GGZ-beleid");
  });

  it("drops unusable dates with a note instead of sending broken CQL", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([GMB_RECORD], 1)));
    const out = await source().search({ query: "afvalinzameling", maximumRecords: 5, date_from: "juni 2026", date_to: "2026-02" });
    expect(cql(fetchMock)).toBe('afvalinzameling AND c.product-area="officielepublicaties" AND dt.date<=2026-02-28');
    expect(out.access_note).toContain("date_from 'juni 2026' genegeerd");
  });

  it("sends a day past the end of the month as the same bound, not as a clause the server ignores", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([GMB_RECORD], 1)));
    const out = await source().search({ query: "afvalinzameling", maximumRecords: 5, date_from: "2026-04-31", date_to: "2026-02-29" });
    expect(cql(fetchMock)).toBe('afvalinzameling AND c.product-area="officielepublicaties" AND dt.date>=2026-05-01 AND dt.date<=2026-02-28');
    expect(out.access_note).toContain("date_from '2026-04-31' bestaat niet als datum; gebruikt als 2026-05-01");
    expect(out.access_note).toContain("date_to '2026-02-29' bestaat niet als datum; gebruikt als 2026-02-28");
    const dutch = await source().search({ query: "afvalinzameling", maximumRecords: 5, date_from: "31-12-2025", date_to: "2026-00-10" });
    expect(cql(fetchMock, 1)).toBe('afvalinzameling AND c.product-area="officielepublicaties" AND dt.date>=2025-12-31');
    expect(dutch.access_note).toContain("date_from '31-12-2025' gelezen als 2025-12-31");
    expect(dutch.access_note).toContain("date_to '2026-00-10' genegeerd");
  });
});

describe("search — authority matching", () => {
  it("searches a water board under its typed name only", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([GMB_RECORD], 91)));
    const out = await source().search({ query: "legger", maximumRecords: 5, authority: "Hoogheemraadschap van Rijnland" });
    const sru = calledUrls(fetchMock).map((url) => url.searchParams.get("query"));
    // The count probe for the typed name, then the search itself.
    expect(sru).toEqual([
      'c.product-area="officielepublicaties" AND dt.creator="Hoogheemraadschap van Rijnland" AND w.organisatietype="waterschap"',
      'legger AND c.product-area="officielepublicaties" AND dt.creator="Hoogheemraadschap van Rijnland" AND w.organisatietype="waterschap"',
    ]);
    expect(sru[1]).not.toContain('dt.creator="Rijnland"');
    expect(out.total).toBe(91);
  });

  it("falls back to the bare water-board name when the typed one is no publisher", async () => {
    const fetchMock = stubFetch((url) =>
      xmlResponse(url.searchParams.get("maximumRecords") === "0" ? sruResponse([], 0) : sruResponse([GMB_RECORD], 150)),
    );
    const out = await source().search({ query: "keur", maximumRecords: 5, authority: "Hoogheemraadschap Rijnland" });
    expect(cql(fetchMock, 1)).toBe('keur AND c.product-area="officielepublicaties" AND dt.creator="Rijnland" AND w.organisatietype="waterschap"');
    expect(out.access_note).toContain("Uitgever 'Hoogheemraadschap Rijnland' komt in de bron niet voor; gezocht als 'Rijnland'");
  });

  it("keeps the typed water-board name when the count probe gives no answer", async () => {
    const fetchMock = stubFetch((url) =>
      url.searchParams.get("maximumRecords") === "0" ? new Response("busy", { status: 503 }) : xmlResponse(sruResponse([GMB_RECORD], 150)),
    );
    await source().search({ query: "keur", maximumRecords: 5, authority: "Hoogheemraadschap van Rijnland" });
    const searches = calledUrls(fetchMock).filter((url) => url.searchParams.get("maximumRecords") !== "0");
    expect(searches[0].searchParams.get("query")).toContain('dt.creator="Hoogheemraadschap van Rijnland" AND');
  });

  it("flags same-type publishers that the containment match mixes in", async () => {
    const records = [
      ...Array.from({ length: 3 }, (_, i) => creatorRecord(`gmb-2026-${i}`, "Groningen")),
      creatorRecord("gmb-2026-9", "Midden-Groningen"),
    ];
    stubFetch(() => xmlResponse(sruResponse(records, 76696)));
    const out = await source().search({ query: "", maximumRecords: 4, authority: "Gemeente Groningen" });
    expect(out.access_note).toContain("meerdere uitgevers: Groningen: 3, Midden-Groningen: 1");
    expect(out.access_note).toContain("'Groningen' is al de volledige naam; 'Midden-Groningen' valt daarmee niet uit te sluiten");
  });

  it("counts an older spelling of the same municipality as that municipality, not as another publisher", async () => {
    const records = [
      ...Array.from({ length: 3 }, (_, i) => creatorRecord(`gmb-2021-${i}`, "Utrecht")),
      creatorRecord("gmb-2015-68045", "Utrecht (Utr)"),
    ];
    stubFetch(() => xmlResponse(sruResponse(records, 4675)));
    const out = await source().search({ query: "parkeren", maximumRecords: 4, authority: "Gemeente Utrecht" });
    const note = out.access_note ?? "";
    expect(note).not.toContain("meerdere uitgevers");
    expect(note).not.toContain("niet uit te sluiten");
    expect(note).toContain(
      "1 record op deze pagina heeft authority 'Utrecht (Utr)': zo schreef de bron gemeente Utrecht tot begin 2016. " +
        "Het is dezelfde uitgever als 'Utrecht', geen andere organisatie.",
    );
    // The records themselves keep the spelling the source publishes.
    expect(out.items.map((item) => item.authority)).toEqual(["Utrecht", "Utrecht", "Utrecht", "Utrecht (Utr)"]);
  });

  it("explains an older spelling when a page holds nothing else", async () => {
    stubFetch(() => xmlResponse(sruResponse([creatorRecord("stcrt-2009-4975", "Utrecht (Utr)"), creatorRecord("stcrt-2009-5729", "Utrecht (Utr)")], 103496)));
    const out = await source().search({ query: "", maximumRecords: 2, authority: "Utrecht", authority_type: "gemeente", sort: "date_oldest" });
    expect(out.access_note).toContain("2 records op deze pagina hebben authority 'Utrecht (Utr)'");
    expect(out.access_note).not.toContain("meerdere uitgevers");
  });

  it("lists only the really different publisher next to an older spelling", async () => {
    const records = [
      ...Array.from({ length: 3 }, (_, i) => creatorRecord(`gmb-2026-${i}`, "Groningen")),
      creatorRecord("stcrt-2014-25388", "Groningen (Gr)"),
      creatorRecord("gmb-2026-9", "Midden-Groningen"),
    ];
    stubFetch(() => xmlResponse(sruResponse(records, 76696)));
    const out = await source().search({ query: "parkeren", maximumRecords: 5, authority: "Gemeente Groningen" });
    const note = out.access_note ?? "";
    expect(note).toContain("meerdere uitgevers: Groningen: 4, Midden-Groningen: 1.");
    expect(note).toContain("'Groningen' is al de volledige naam; 'Midden-Groningen' valt daarmee niet uit te sluiten");
    expect(note).not.toMatch(/'Midden-Groningen', 'Groningen \(Gr\)'/);
    expect(note).toContain(
      "1 record op deze pagina heeft authority 'Groningen (Gr)': zo schreef de bron gemeente Groningen tot en met 2015. " +
        "Het is dezelfde uitgever als 'Groningen' (in de telling hierboven daaronder meegeteld), geen andere organisatie.",
    );
  });

  it("folds an older spelling into its own kind when no type is set", async () => {
    const records = [
      utrechtRecord("prb-2026-7695", "provincie", "Provinciaal blad"),
      utrechtRecord("gmb-2026-1", "gemeente", "Gemeenteblad"),
      creatorRecord("gmb-2015-68045", "Utrecht (Utr)"),
    ];
    stubFetch(() => xmlResponse(sruResponse(records, 3)));
    const out = await source().search({ query: "jaarstukken", maximumRecords: 5, authority: "Utrecht" });
    expect(out.access_note).toContain("meerdere uitgevers: Utrecht (gemeente): 2, Utrecht (provincie): 1.");
    expect(out.access_note).not.toContain("Utrecht (Utr) (gemeente)");
  });

  it("keeps Bergen (NH) and Bergen (L) apart: they are municipalities, not older spellings", async () => {
    const records = [creatorRecord("gmb-1", "Bergen (NH)"), creatorRecord("gmb-2", "Bergen (L)")];
    stubFetch(() => xmlResponse(sruResponse(records, 19977)));
    const out = await source().search({ query: "parkeren", maximumRecords: 2, authority: "Bergen", authority_type: "gemeente" });
    expect(out.access_note).toContain("meerdere uitgevers: Bergen (NH): 1, Bergen (L): 1");
    expect(out.access_note).not.toContain("dezelfde uitgever");
  });

  it("suggests the full name when the typed one is only part of every publisher", async () => {
    const records = [creatorRecord("gmb-1", "Bergen (NH)"), creatorRecord("gmb-2", "Bergen (NH)"), creatorRecord("gmb-3", "Bergen op Zoom")];
    stubFetch(() => xmlResponse(sruResponse(records, 45903)));
    const out = await source().search({ query: "parkeren", maximumRecords: 3, authority: "Bergen", authority_type: "gemeente" });
    expect(out.access_note).toContain("meerdere uitgevers: Bergen (NH): 2, Bergen op Zoom: 1");
    expect(out.access_note).toContain("Gebruik de volledige naam van de bedoelde uitgever, bijv. 'Bergen (NH)' of 'Bergen op Zoom'");
  });

  it("counts a spelling without the hyphen as the same publisher, typed or not", async () => {
    const records = [
      ...Array.from({ length: 3 }, (_, i) => creatorRecord(`gmb-2026-${i}`, "Pijnacker-Nootdorp")),
      creatorRecord("gmb-2015-411", "Pijnacker Nootdorp"),
    ];
    stubFetch(() => xmlResponse(sruResponse(records, 4)));
    const explained =
      "1 record op deze pagina heeft authority 'Pijnacker Nootdorp': een andere schrijfwijze van dezelfde uitgever als 'Pijnacker-Nootdorp', " +
      "geen andere organisatie.";
    for (const args of [{ authority: "Gemeente Pijnacker-Nootdorp" }, { authority: "Pijnacker-Nootdorp" }, { authority: "Pijnacker Nootdorp", authority_type: "gemeente" }]) {
      const out = await source().search({ query: "parkeerbeleid", maximumRecords: 4, ...args });
      const note = out.access_note ?? "";
      expect(note).toContain(explained);
      expect(note).not.toContain("meerdere uitgevers");
      expect(note).not.toContain("niet uit te sluiten");
      expect(note).not.toContain("Beperk met authority_type");
      expect(out.items.map((item) => item.authority)).toContain("Pijnacker Nootdorp");
    }
  });

  it("counts an alias the search sends as the official name: Den Haag is 's-Gravenhage", async () => {
    const records = [
      ...Array.from({ length: 3 }, (_, i) => creatorRecord(`gmb-2013-${i}`, "'s-Gravenhage")),
      creatorRecord("stcrt-2013-77", "Den Haag"),
      creatorRecord("stcrt-2013-78", "Den Haag"),
    ];
    stubFetch(() => xmlResponse(sruResponse(records, 5)));
    const out = await source().search({ query: "parkeerbeleid", maximumRecords: 5, authority: "Gemeente Den Haag", date_to: "2013-12-31" });
    const note = out.access_note ?? "";
    expect(note).not.toContain("meerdere uitgevers");
    expect(note).not.toContain("niet uit te sluiten");
    expect(note).toContain(
      "2 records op deze pagina hebben authority 'Den Haag': een andere schrijfwijze van dezelfde uitgever als ''s-Gravenhage', geen andere organisatie.",
    );
  });

  it("keeps a different kind of publisher apart while folding the alias, without a type", async () => {
    const records = [
      ...Array.from({ length: 2 }, (_, i) => creatorRecord(`gmb-2013-${i}`, "'s-Gravenhage")),
      creatorRecord("stcrt-2013-77", "Den Haag"),
      creatorRecord("stcrt-2013-90", "Rechtbank Den Haag", "rechterlijke macht"),
    ];
    stubFetch(() => xmlResponse(sruResponse(records, 4)));
    const out = await source().search({ query: "afvalinzameling", maximumRecords: 4, authority: "Den Haag" });
    const note = out.access_note ?? "";
    expect(note).toContain("meerdere uitgevers: 's-Gravenhage (gemeente): 3, Rechtbank Den Haag (rechterlijke macht): 1.");
    expect(note).toContain("Beperk met authority_type");
    expect(note).toContain(
      "1 record op deze pagina heeft authority 'Den Haag': een andere schrijfwijze van dezelfde uitgever als ''s-Gravenhage' " +
        "(in de telling hierboven daaronder meegeteld), geen andere organisatie.",
    );
  });

  it("folds a creator that carries the kind in its name, whatever the case of its organisation type", async () => {
    const records = [
      creatorRecord("gmb-2024-1", "Noardeast-Fryslân"),
      creatorRecord("gmb-2024-2", "Noardeast-Fryslân"),
      creatorRecord("gmb-2024-134004", "gemeente Noardeast-Fryslân", "Gemeente"),
    ];
    stubFetch(() => xmlResponse(sruResponse(records, 3)));
    for (const authority of ["Gemeente Noardeast-Fryslân", "Noardeast-Fryslân"]) {
      const out = await source().search({ query: "woningbouw", maximumRecords: 3, authority });
      const note = out.access_note ?? "";
      expect(note).not.toContain("meerdere uitgevers");
      expect(note).not.toContain("niet uit te sluiten");
      expect(note).toContain("1 record op deze pagina heeft authority 'gemeente Noardeast-Fryslân': een andere schrijfwijze van dezelfde uitgever als 'Noardeast-Fryslân'");
    }
  });

  it("counts a province alias and a prefixed province creator under the official name", async () => {
    const records = [
      creatorRecord("prb-2026-1", "Fryslân", "provincie"),
      creatorRecord("prb-2014-149", "Friesland", "provincie"),
      creatorRecord("prb-2020-5", "provincie Fryslân", "provincie"),
    ];
    stubFetch(() => xmlResponse(sruResponse(records, 3)));
    const out = await source().search({ query: "subsidieplafond", maximumRecords: 3, authority: "Provincie Friesland" });
    const note = out.access_note ?? "";
    expect(note).not.toContain("meerdere uitgevers");
    expect(note).toContain("authority 'Friesland': een andere schrijfwijze van dezelfde uitgever als 'Fryslân'");
    expect(note).toContain("authority 'provincie Fryslân': een andere schrijfwijze van dezelfde uitgever als 'Fryslân'");
  });

  it("never names an empty list of publishers that 'cannot be excluded'", async () => {
    const records = [
      creatorRecord("gmb-2026-1", "Pijnacker-Nootdorp"),
      creatorRecord("gmb-2015-2", "Pijnacker Nootdorp"),
      creatorRecord("gmb-2015-3", "gemeente Pijnacker-Nootdorp"),
      creatorRecord("gmb-2015-4", "Pijnacker Nootdorp"),
    ];
    stubFetch(() => xmlResponse(sruResponse(records, 4)));
    const out = await source().search({ query: "bestemmingsplan", maximumRecords: 4, authority: "Pijnacker-Nootdorp", authority_type: "gemeente" });
    const note = out.access_note ?? "";
    expect(note).not.toContain("niet uit te sluiten");
    expect(note).not.toMatch(/;\s+(valt|vallen)/);
    expect(note).toContain("2 records op deze pagina hebben authority 'Pijnacker Nootdorp'");
    expect(note).toContain("1 record op deze pagina heeft authority 'gemeente Pijnacker-Nootdorp'");
  });

  it("still lists a really different publisher next to a folded spelling", async () => {
    const records = [
      ...Array.from({ length: 3 }, (_, i) => creatorRecord(`gmb-2026-${i}`, "Groningen")),
      creatorRecord("gmb-2014-7", "gemeente Groningen"),
      creatorRecord("gmb-2026-9", "Midden-Groningen"),
    ];
    stubFetch(() => xmlResponse(sruResponse(records, 5)));
    const out = await source().search({ query: "afvalinzameling", maximumRecords: 5, authority: "Gemeente Groningen" });
    const note = out.access_note ?? "";
    expect(note).toContain("meerdere uitgevers: Groningen: 4, Midden-Groningen: 1.");
    expect(note).toContain("'Groningen' is al de volledige naam; 'Midden-Groningen' valt daarmee niet uit te sluiten");
    expect(note).toContain("authority 'gemeente Groningen': een andere schrijfwijze van dezelfde uitgever als 'Groningen' (in de telling hierboven daaronder meegeteld)");
  });
});

describe("search — hyphenated compounds, exact hits first", () => {
  const EXACT = 'OV-visie AND c.product-area="officielepublicaties"';
  const LOOSE = '("OV-visie" OR (OV AND visie)) AND c.product-area="officielepublicaties"';
  const exactRecords = [creatorRecord("kst-31305-412", "Tweede Kamer der Staten-Generaal"), creatorRecord("h-tk-20242025-42-4", "Tweede Kamer der Staten-Generaal")];
  const looseRecords = [
    creatorRecord("blg-1011204", "Tweede Kamer der Staten-Generaal"),
    creatorRecord("kst-31305-412", "Tweede Kamer der Staten-Generaal"),
    creatorRecord("blg-907315", "Tweede Kamer der Staten-Generaal"),
    creatorRecord("nds-tk-2024D04417", "Tweede Kamer der Staten-Generaal"),
  ];

  function compoundStub(exactTotal = 2, looseTotal = 4476) {
    return stubFetch((url) => {
      const query = url.searchParams.get("query");
      const start = Number(url.searchParams.get("startRecord"));
      const max = Number(url.searchParams.get("maximumRecords"));
      const pool = query === EXACT ? exactRecords.slice(0, exactTotal) : query === LOOSE ? looseRecords : [];
      return xmlResponse(sruResponse(pool.slice(start - 1, start - 1 + max), query === EXACT ? exactTotal : looseTotal));
    });
  }

  it("lists the exact compound first, then the loose words without repeating a publication", async () => {
    const fetchMock = compoundStub();
    const out = await source().search({ query: "OV-visie", maximumRecords: 5, expandCompounds: true });
    expect(calledUrls(fetchMock).map((url) => url.searchParams.get("query"))).toEqual([EXACT, LOOSE]);
    expect(out.items.map((item) => item.identifier)).toEqual(["kst-31305-412", "h-tk-20242025-42-4", "blg-1011204", "blg-907315"]);
    expect(out.total).toBe(4476);
    expect(out.positions).toBe(4478);
    expect(out.page_span).toBe(5);
    expect(out.params.exact_first_query).toBe(EXACT);
    expect(out.access_note).toContain("eerst de 2 publicaties met precies die term, daarna die waarin de losse woorden voorkomen (OV EN visie)");
    expect(out.access_note).toContain("Deze pagina telt 4 records in plaats van 5");
    expect(out.access_note).toContain("startRecord 6");
  });

  it("maps a later page onto the loose list and drops the exact hits there", async () => {
    const fetchMock = compoundStub();
    const out = await source().search({ query: "OV-visie", maximumRecords: 2, startRecord: 3, expandCompounds: true });
    const urls = calledUrls(fetchMock);
    expect(urls.map((url) => [url.searchParams.get("query"), url.searchParams.get("startRecord"), url.searchParams.get("maximumRecords")])).toEqual([
      [EXACT, "3", "2"],
      [LOOSE, "1", "2"],
      [EXACT, "1", "2"],
    ]);
    expect(out.items.map((item) => item.identifier)).toEqual(["blg-1011204"]);
    expect(out.page_span).toBe(2);
  });

  it("searches only the loose words when the compound never occurs as such", async () => {
    compoundStub(0);
    const out = await source().search({ query: "OV-visie", maximumRecords: 3, expandCompounds: true });
    expect(out.items.map((item) => item.identifier)).toEqual(["blg-1011204", "kst-31305-412", "blg-907315"]);
    expect(out.positions).toBeUndefined();
    expect(out.access_note).toContain("komt nergens letterlijk voor");
  });

  it("names only the loose words the query requires, without function words", async () => {
    const exact = 'zorg-en-welzijn AND c.product-area="officielepublicaties"';
    stubFetch((url) => xmlResponse(sruResponse(url.searchParams.get("query") === exact ? [] : looseRecords, url.searchParams.get("query") === exact ? 0 : 4)));
    const out = await source().search({ query: "zorg-en-welzijn", maximumRecords: 3, expandCompounds: true });
    expect(out.access_note).toContain("gezocht op de losse woorden (zorg EN welzijn)");
  });

  it("keeps a common compound exact and says how to get the loose words", async () => {
    const fetchMock = compoundStub(250);
    const out = await source().search({ query: "OV-visie", maximumRecords: 2, expandCompounds: true });
    expect(calledUrls(fetchMock).map((url) => url.searchParams.get("query"))).toEqual([EXACT, LOOSE]);
    expect(out.items.map((item) => item.identifier)).toEqual(["kst-31305-412", "h-tk-20242025-42-4"]);
    expect(out.total).toBe(250);
    expect(out.params.query).toBe(EXACT);
    expect(out.access_note).toContain("als exacte term gezocht (250 treffers)");
    expect(out.access_note).toContain("(OV visie)");
  });
});

describe("search — totals that are not there", () => {
  const COUNTLESS = (records: string[]) => sruResponse(records, 0).replace("<sru:numberOfRecords>0</sru:numberOfRecords>", "");

  it("reports an unknown total as null, not 0", async () => {
    stubFetch(() => xmlResponse(COUNTLESS([GMB_RECORD, KST_RECORD])));
    const out = await source().search({ query: "afvalinzameling", maximumRecords: 5 });
    expect(out.items).toHaveLength(2);
    expect(out.total).toBeNull();
    expect(out.access_note).toContain("het totaal is onbekend");
  });

  it("does not call a publisher unknown when the count probe has no count", async () => {
    stubFetch((url) => xmlResponse(url.searchParams.get("maximumRecords") === "0" ? COUNTLESS([]) : sruResponse([], 0)));
    const out = await source().search({ query: "afvalinzameling", maximumRecords: 5, authority: "Gouda" });
    expect(out.access_note ?? "").not.toContain("Geen uitgever gevonden");
  });

  it("does not claim 0 hits beyond the paging window when the count is missing", async () => {
    stubFetch(() => xmlResponse(COUNTLESS([])));
    const out = await source().search({ query: "zorg", maximumRecords: 5, startRecord: 10001 });
    expect(out.total).toBeNull();
    expect(out.access_note).not.toContain("deze zoekvraag heeft");
    expect(out.diagnostic).toBe("start_record_beyond_limit");
  });

  it("keeps the records of a response whose diagnostic only ignored part of the query", async () => {
    const partial = sruResponse([GMB_RECORD], 5458).replace(
      "</sru:searchRetrieveResponse>",
      '<sru:diagnostics><diag:diagnostic xmlns:diag="http://docs.oasis-open.org/ns/search-ws/diagnostic"><diag:uri>info:srw/diagnostic/1/10</diag:uri>' +
        "<diag:details>[:2026-02-30] is not a valid range constraint against type date</diag:details><diag:message>SEARCH-IGNOREDQTEXT</diag:message>" +
        "</diag:diagnostic></sru:diagnostics></sru:searchRetrieveResponse>",
    );
    stubFetch(() => xmlResponse(partial));
    const out = await source().search({ query: "afvalinzameling", maximumRecords: 5 });
    expect(out.items).toHaveLength(1);
    expect(out.total).toBe(5458);
    expect(out.diagnostic).toBeUndefined();
    expect(out.access_note).toContain("negeerde een deel van de zoekvraag (SRU-diagnose: SEARCH-IGNOREDQTEXT: [:2026-02-30] is not a valid range constraint");
  });
});

describe("search — honest results", () => {
  it("maps the publication with its dates, citation, links and journal", async () => {
    stubFetch(() => xmlResponse(sruResponse([GMB_RECORD, KST_RECORD], 2)));
    const out = await source().search({ query: "afvalinzameling", maximumRecords: 5 });
    const [gmb, kst] = out.items;
    expect(gmb).toMatchObject({
      identifier: "gmb-2026-104512",
      date: "2026-04-02",
      date_type: "dagtekening",
      publication_date: "2026-04-02",
      authority: "Pijnacker-Nootdorp",
      authority_type: "gemeente",
      publicatieblad: "Gemeenteblad",
      vindplaats: "Gemeenteblad 2026, 104512",
      publication_type: "ander besluit van algemene strekking",
      canonical_url: "https://zoek.officielebekendmakingen.nl/gmb-2026-104512.html",
      pdf_url: "https://repository.overheid.nl/frbr/officielepublicaties/gmb/2026/gmb-2026-104512/1/pdf/gmb-2026-104512.pdf",
      xml_url: "https://repository.overheid.nl/frbr/officielepublicaties/gmb/2026/gmb-2026-104512/1/xml/gmb-2026-104512.xml",
    });
    // The Kamerstuk's document date precedes its publication.
    expect(kst).toMatchObject({
      date: "2026-10-01",
      publication_date: "2026-10-02",
      vindplaats: "Kamerstuk 37020-IX nr. 40 (vergaderjaar 2026-2027)",
      document_title: "Motie van de leden Dassen en Stultiens over een SER-advies",
    });
    expect(out.total).toBe(2);
  });

  it("cites a Handelingen item and a Kamervragen answer by their own numbers", async () => {
    stubFetch(() => xmlResponse(sruResponse([HANDELINGEN_RECORD, AANHANGSEL_RECORD], 2)));
    const out = await source().search({ query: "woningbouw", maximumRecords: 5 });
    expect(out.items.map((item) => item.vindplaats)).toEqual([
      "Handelingen II 2024-2025, nr. 42, item 4",
      "Aanhangsel Handelingen II 2019-2020, nr. 4046",
    ]);
  });

  it("takes the chamber of an Aanhangsel answer from its publisher when the identifier has none", async () => {
    // Since 2025-2026 the identifier is "ah-<number>", while both chambers number
    // their Aanhangsel from 1 each session.
    const current = (id: string, creator: string) =>
      AANHANGSEL_RECORD.replaceAll("ah-tk-20192020-4046", id)
        .replace("Tweede Kamer der Staten-Generaal", creator)
        .replace("<overheidwetgeving:aanhangselnummer>4046<", "<overheidwetgeving:aanhangselnummer>1<")
        .replace("<overheidwetgeving:vergaderjaar>2019-2020<", "<overheidwetgeving:vergaderjaar>2026-2027<");
    stubFetch(() =>
      xmlResponse(
        sruResponse(
          [
            current("ah-1000001", "Tweede Kamer der Staten-Generaal"),
            current("ah-1000002", "Eerste Kamer der Staten-Generaal"),
            current("ah-1000003", "Staten-Generaal"),
            current("ah-1000004", "Tweede Kamer der Staten-Generaal</dcterms:creator><dcterms:creator>Eerste Kamer der Staten-Generaal"),
          ],
          4,
        ),
      ),
    );
    const out = await source().search({ query: "afvalinzameling", maximumRecords: 5 });
    expect(out.items.map((item) => [item.identifier, item.vindplaats])).toEqual([
      ["ah-1000001", "Aanhangsel Handelingen II 2026-2027, nr. 1"],
      ["ah-1000002", "Aanhangsel Handelingen I 2026-2027, nr. 1"],
      // No chamber in the record, or two: left out, not guessed.
      ["ah-1000003", "Aanhangsel Handelingen 2026-2027, nr. 1"],
      ["ah-1000004", "Aanhangsel Handelingen 2026-2027, nr. 1"],
    ]);
  });

  it("keeps the chamber of the identifier when it names one", async () => {
    const mislabelled = AANHANGSEL_RECORD.replace("Tweede Kamer der Staten-Generaal", "Eerste Kamer der Staten-Generaal");
    stubFetch(() => xmlResponse(sruResponse([mislabelled], 1)));
    const out = await source().search({ query: "afvalinzameling", maximumRecords: 5 });
    expect(out.items[0].vindplaats).toBe("Aanhangsel Handelingen II 2019-2020, nr. 4046");
  });

  it("cites a current Aanhangsel answer with its chamber in record_get", async () => {
    const id = "ah-1000002";
    const record = AANHANGSEL_RECORD.replaceAll("ah-tk-20192020-4046", id).replace(
      "Tweede Kamer der Staten-Generaal",
      "Eerste Kamer der Staten-Generaal",
    );
    stubFetch(() => xmlResponse(sruResponse([record], 1)));
    const out = await source().getRecord(id, { include_text: false });
    expect(out.item).toMatchObject({
      identifier: id,
      authority: "Eerste Kamer der Staten-Generaal",
      vindplaats: "Aanhangsel Handelingen I 2019-2020, nr. 4046",
      aanhangsel_number: "4046",
    });
  });

  it("builds a snippet with the citation, not just the publisher", async () => {
    stubFetch(() => xmlResponse(sruResponse([GMB_RECORD, KST_RECORD], 2)));
    const out = await source().search({ query: "afvalinzameling", maximumRecords: 5 });
    expect(bekendmakingSnippet(out.items[0])).toBe(
      "Gemeenteblad 2026, 104512 · Pijnacker-Nootdorp (gemeente) · ander besluit van algemene strekking · gepubliceerd 2026-04-02",
    );
    expect(bekendmakingSnippet(out.items[1])).toContain("Motie van de leden Dassen en Stultiens");
  });

  it("reports a rejected query as a diagnostic, not as zero results", async () => {
    stubFetch(() => xmlResponse(SRU_DIAGNOSTIC));
    const out = await source().search({ query: "afvalinzameling", maximumRecords: 5 });
    expect(out.items).toEqual([]);
    expect(out.diagnostic).toContain("mismatched input");
    expect(out.access_note).toContain("geen \"0 resultaten\"");
  });

  it("explains a zero result for an authority the source does not know", async () => {
    const fetchMock = stubFetch((url) =>
      xmlResponse(sruResponse([], 0)),
    );
    const out = await source().search({ query: "afvalinzameling", maximumRecords: 5, authority: "Gemeente Goudaa" });
    const urls = calledUrls(fetchMock);
    expect(urls).toHaveLength(2);
    expect(urls[1].searchParams.get("maximumRecords")).toBe("0");
    expect(urls[1].searchParams.get("query")).toBe(
      'c.product-area="officielepublicaties" AND dt.creator="Goudaa" AND w.organisatietype="gemeente"',
    );
    expect(out.access_note).toContain("Geen uitgever gevonden");
    expect(out.access_note).toContain("Tweede Kamer der Staten-Generaal");
  });

  it("explains a zero result for a known authority with no matching publications", async () => {
    stubFetch((url) =>
      xmlResponse(sruResponse([], url.searchParams.get("maximumRecords") === "0" ? 17446 : 0)),
    );
    const out = await source().search({ query: "blockchain", maximumRecords: 5, authority: "Gouda" });
    expect(out.access_note).toContain("'Gouda' heeft 17.446 publicaties");
  });

  it("explains a zero result for a document type", async () => {
    stubFetch(() => xmlResponse(sruResponse([], 0)));
    const out = await source().search({ query: "afvalinzameling", maximumRecords: 5, type: "Kamerstukk" });
    expect(out.access_note).toContain("Geen resultaten met type 'Kamerstukk'");
  });

  it("flags an authority that matches several publishers in the results", async () => {
    stubFetch(() =>
      xmlResponse(sruResponse([utrechtRecord("prb-2026-7695", "provincie", "Provinciaal blad"), utrechtRecord("gmb-2026-1", "gemeente", "Gemeenteblad")], 2)),
    );
    const out = await source().search({ query: "jaarstukken", maximumRecords: 5, authority: "Utrecht" });
    expect(out.access_note).toContain("meerdere uitgevers: Utrecht (provincie): 1, Utrecht (gemeente): 1");
    const narrowed = await source().search({ query: "jaarstukken", maximumRecords: 5, authority: "Utrecht", authority_type: "gemeente" });
    expect(narrowed.access_note ?? "").not.toContain("meerdere uitgevers");
  });

  it("suggests the authority filter when the query names a place", async () => {
    stubFetch(() => xmlResponse(sruResponse([KST_RECORD], 306)));
    const out = await source().search({ query: "harderwijk afvalinzameling", originalQuery: "Harderwijk afvalinzameling", maximumRecords: 5 });
    expect(out.access_note).toContain("authority: 'Harderwijk' (authority_type 'gemeente')");
    const withAuthority = await source().search({ query: "afvalinzameling", maximumRecords: 5, authority: "Harderwijk" });
    expect(withAuthority.access_note ?? "").not.toContain("De zoekterm noemt");
  });

  it("answers a page beyond the upstream window with the count, not with an error", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([], 459711)));
    const out = await source().search({ query: "zorg", maximumRecords: 5, startRecord: SRU_MAX_START_RECORD + 2 });
    const urls = calledUrls(fetchMock);
    expect(urls).toHaveLength(1);
    expect(urls[0].searchParams.get("maximumRecords")).toBe("0");
    expect(urls[0].searchParams.get("startRecord")).toBe("1");
    expect(out.items).toEqual([]);
    expect(out.total).toBe(459711);
    expect(out.diagnostic).toBeUndefined();
    expect(out.access_note).toContain("alleen de eerste ~10.000 treffers");
    expect(out.access_note).toContain("het maximum is 9.999");
  });

  it("warns when a result set is larger than the pageable window", async () => {
    stubFetch(() => xmlResponse(sruResponse([GMB_RECORD], 15170)));
    const out = await source().search({ query: "Enkhuizen", maximumRecords: 5, authority: "Enkhuizen" });
    expect(out.access_note).toContain("alleen de eerste ~10.000 op te halen");
  });
});

describe("getRecord", () => {
  it("returns the full metadata and links", async () => {
    stubFetch(() => xmlResponse(sruResponse([GMB_RECORD], 1)));
    const out = await source().getRecord("gmb-2026-104512");
    expect(out.item).toMatchObject({
      identifier: "gmb-2026-104512",
      publication_date: "2026-04-02",
      vindplaats: "Gemeenteblad 2026, 104512",
      subjects: ["Recht | Organisatie en beleid"],
      concerns_regulation: "CVDR700412_1",
      municipality: "Pijnacker-Nootdorp",
      province: "Zuid-Holland",
      publication_number: "104512",
      odt_url: expect.stringContaining("/odt/gmb-2026-104512.odt"),
      metadata_url: expect.stringContaining("/metadata/metadata.xml"),
    });
    expect(out.item?.legal_basis).toEqual([
      {
        label: "RICHTLIJN 2008/98/EG (kaderrichtlijn afvalstoffen)",
        url: "https://eur-lex.europa.eu/legal-content/NL/TXT/HTML/?uri=CELEX:32008L0098",
      },
      {
        label: "artikel 4:81 van de Algemene wet bestuursrecht",
        url: "https://wetten.overheid.nl/jci1.0:c:BWBR0005537&artikel=4:81&g=2026-01-01",
      },
    ]);
  });

  it("does not invent a record for an unknown identifier", async () => {
    stubFetch(() => xmlResponse(sruResponse([], 0)));
    const out = await source().getRecord("gmb-2099-1");
    expect(out.item).toBeNull();
    expect(out.access_note).toContain("Geen bekendmaking gevonden met identifier 'gmb-2099-1'");
  });

  it("accepts a website URL as identifier and asks for exactly that identifier", async () => {
    const fetchMock = stubFetch(() => xmlResponse(sruResponse([KST_RECORD], 1)));
    const out = await source().getRecord("https://zoek.officielebekendmakingen.nl/kst-37020-IX-40.html");
    expect(cql(fetchMock)).toBe('dt.identifier=="kst-37020-IX-40" AND c.product-area="officielepublicaties"');
    expect(calledUrls(fetchMock)).toHaveLength(1);
    expect(out.item?.identifier).toBe("kst-37020-IX-40");
  });

  it("finds an identifier typed in another case", async () => {
    const fetchMock = stubFetch((url) =>
      xmlResponse(url.searchParams.get("query")?.startsWith("dt.identifier==") ? sruResponse([], 0) : sruResponse([KST_RECORD], 1)),
    );
    const out = await source().getRecord("KST-37020-IX-40");
    expect(cql(fetchMock, 1)).toBe('dt.identifier="KST-37020-IX-40" AND c.product-area="officielepublicaties"');
    expect(out.item?.identifier).toBe("kst-37020-IX-40");
    expect(out.params.query).toBe('dt.identifier="KST-37020-IX-40" AND c.product-area="officielepublicaties"');
  });

  it("does not hand out another publication for a partial identifier", async () => {
    const dossier = ["kst-37020-IX-9", "kst-37020-IX-30", "kst-37020-IX-11"].map((id) => creatorRecord(id, "Tweede Kamer der Staten-Generaal"));
    stubFetch((url) =>
      xmlResponse(url.searchParams.get("query")?.startsWith("dt.identifier==") ? sruResponse([], 0) : sruResponse(dossier, 40)),
    );
    const out = await source().getRecord("kst-37020-IX");
    expect(out.item).toBeNull();
    expect(out.access_note).toContain("Geen bekendmaking gevonden met identifier 'kst-37020-IX'");
    expect(out.access_note).toContain("deel van 40 andere identifiers (bijv. 'kst-37020-IX-9', 'kst-37020-IX-30', 'kst-37020-IX-11')");
  });

  it("includes the document text from the XML manifestation", async () => {
    const fetchMock = stubFetch((url) =>
      url.pathname.endsWith(".xml") ? xmlResponse(GMB_XML) : xmlResponse(sruResponse([GMB_RECORD], 1)),
    );
    const out = await source().getRecord("gmb-2026-104512", { include_text: true, max_chars: 60 });
    expect(calledUrls(fetchMock).map((url) => url.pathname)).toContain(
      "/frbr/officielepublicaties/gmb/2026/gmb-2026-104512/1/xml/gmb-2026-104512.xml",
    );
    expect(out.item?.text).toBe("GEMEENTEBLAD Officiële uitgave van de gemeente Pijnacker-Nootdorp".slice(0, 60));
    expect(out.item).toMatchObject({ text_format: "xml", text_truncated: true, text_chars: 60 });
    expect(out.access_note).toContain("XML-versie");
  });

  it("falls back to the PDF when there is no XML version", async () => {
    stubFetch((url) =>
      url.pathname.endsWith(".pdf")
        ? new Response(buildSamplePdf("Voortgangsrapportage fietsparkeren bij stations").buffer as ArrayBuffer, {
            status: 200,
            headers: { "content-type": "application/pdf" },
          })
        : xmlResponse(sruResponse([BLG_RECORD], 1)),
    );
    const out = await source().getRecord("blg-1093410", { include_text: true });
    expect(out.item?.vindplaats).toBe("Kamerstuk 31305 nr. 412, bijlage (vergaderjaar 2023-2024)");
    expect(out.item?.text).toContain("Voortgangsrapportage fietsparkeren bij stations");
    expect(out.item?.text_format).toBe("pdf");
  });

  it("keeps the metadata and gives a reason when the text cannot be fetched", async () => {
    stubFetch((url) =>
      url.pathname.endsWith(".pdf") ? new Response("gone", { status: 404 }) : xmlResponse(sruResponse([BLG_RECORD], 1)),
    );
    const out = await source().getRecord("blg-1093410", { include_text: true });
    expect(out.item?.identifier).toBe("blg-1093410");
    expect(out.item?.text).toBeUndefined();
    expect(String(out.item?.text_unavailable_reason)).toContain("fetch_failed");
    expect(out.access_note).toContain("Documenttekst niet beschikbaar");
  });
});

describe("fallbacks", () => {
  it("never fabricate a record", () => {
    const search = source().fallbackSearch({ query: "GGZ-beleid", maximumRecords: 5 });
    expect(search.items).toEqual([]);
    expect(search.total).toBeNull();
    expect(search.access_note).toContain("geen resultaten opgehaald");
    // The manual link actually runs the search (?zoekterm= showed all 6.7M publications).
    expect(search.access_note).toContain("cql.textAndIndexes");
    const get = source().fallbackGet("https://zoek.officielebekendmakingen.nl/gmb-2026-104512.html");
    expect(get.item).toBeNull();
    expect(get.access_note).toContain("https://zoek.officielebekendmakingen.nl/gmb-2026-104512.html");
  });
});

describe("helpers", () => {
  it("resolveAuthority strips prefixes and adds aliases and creator spellings", () => {
    expect(resolveAuthority("Gemeente Den Haag")).toMatchObject({ type: "gemeente", typeFromPrefix: true });
    expect(resolveAuthority("Gemeente Den Haag")?.names).toEqual(expect.arrayContaining(["Den Haag", "'s-Gravenhage"]));
    expect(resolveAuthority("Waterschap Rivierenland")).toMatchObject({ names: ["Waterschap Rivierenland"], type: "waterschap" });
    expect(resolveAuthority("Hoogheemraadschap van Rijnland")?.fallbackNames?.[0]).toBe("Rijnland");
    expect(resolveAuthority("Gemeente Gouda")?.fallbackNames).toBeUndefined();
    expect(resolveAuthority("Hengelo (O)")?.names).toContain("Hengelo");
    expect(resolveAuthority("Utrecht", "provincie")).toMatchObject({ names: ["Utrecht"], type: "provincie", typeFromPrefix: false });
    expect(resolveAuthority("   ")).toBeUndefined();
  });

  it("resolvePublicatiebladen folds case, accents and abbreviations", () => {
    expect(resolvePublicatiebladen("STCRT, provinciaal blad, Kamervragen (Aanhangsel), xyz")).toEqual({
      names: ["Staatscourant", "Provinciaal blad", "Kamervragen (Aanhangsel)"],
      unknown: ["xyz"],
    });
  });

  it("detectPlaces finds municipalities and provinces, longest match, capitals for common words", () => {
    expect(detectPlaces("Harderwijk afvalinzameling")).toEqual([{ name: "Harderwijk", kinds: ["gemeente"] }]);
    expect(detectPlaces("OV in Utrecht")).toEqual([{ name: "Utrecht", kinds: ["gemeente", "provincie"] }]);
    expect(detectPlaces("GGZ-beleid gemeente Utrecht")).toEqual([{ name: "Utrecht", kinds: ["gemeente"] }]);
    expect(detectPlaces("visie Midden-Groningen")).toEqual([{ name: "Midden-Groningen", kinds: ["gemeente"] }]);
    expect(detectPlaces("den haag ov")).toEqual([{ name: "'s-Gravenhage", kinds: ["gemeente"] }]);
    expect(detectPlaces("Noardeast Fryslan beleid")).toEqual([{ name: "Noardeast-Fryslân", kinds: ["gemeente"] }]);
    expect(detectPlaces("de beste buren putten")).toEqual([]);
    expect(detectPlaces("gemeente Best")).toEqual([{ name: "Best", kinds: ["gemeente"] }]);
    expect(detectPlaces("openbare verlichting")).toEqual([]);
    expect(placeSuggestionNote("afvalinzameling")).toBeUndefined();
  });

  it("normalizeSruDate widens partial dates and rejects free text", () => {
    expect(normalizeSruDate("2026-02-29", "to")).toBe("2026-02-28");
    expect(normalizeSruDate("2026-02-29", "from")).toBe("2026-03-01");
    expect(normalizeSruDate("2024-02-29", "to")).toBe("2024-02-29");
    expect(normalizeSruDate("2026-12-32", "to")).toBeNull();
    expect(normalizeSruDate("2026-12-31", "from")).toBe("2026-12-31");
    expect(normalizeSruDateDetailed("2025-12-31", "from")).toEqual({ date: "2025-12-31" });
    expect(normalizeSruDateDetailed("2026-11-31", "from")).toEqual({ date: "2026-12-01", readAs: "nonexistent" });
    expect(normalizeSruDateDetailed("2025-02-29", "to")).toEqual({ date: "2025-02-28", readAs: "nonexistent" });
    expect(normalizeSruDateDetailed("1-6-2026", "from")).toEqual({ date: "2026-06-01", readAs: "reformatted" });
    expect(normalizeSruDate("2026", "from")).toBe("2026-01-01");
    expect(normalizeSruDate("2026", "to")).toBe("2026-12-31");
    expect(normalizeSruDate("2024-02", "to")).toBe("2024-02-29");
    expect(normalizeSruDate("2026-06-01T00:00:00+02:00", "from")).toBe("2026-06-01");
    expect(normalizeSruDate("2026-13", "from")).toBeNull();
    expect(normalizeSruDate("gisteren", "from")).toBeNull();
    expect(normalizeSruDate(" ", "from")).toBeUndefined();
  });

  it("normalizeBekendmakingIdentifier accepts identifiers and URLs", () => {
    expect(normalizeBekendmakingIdentifier(" gmb-2026-104512 ")).toBe("gmb-2026-104512");
    expect(normalizeBekendmakingIdentifier("https://zoek.officielebekendmakingen.nl/stcrt-2011-12795.html")).toBe("stcrt-2011-12795");
    expect(normalizeBekendmakingIdentifier("https://zoek.officielebekendmakingen.nl/stcrt-2011-12795")).toBe("stcrt-2011-12795");
    expect(
      normalizeBekendmakingIdentifier("https://repository.overheid.nl/frbr/officielepublicaties/gmb/2026/gmb-2026-104512/1/pdf/gmb-2026-104512.pdf"),
    ).toBe("gmb-2026-104512");
  });

  it("normalizeBekendmakingIdentifier finds the identifier in metadata URLs", () => {
    expect(normalizeBekendmakingIdentifier("https://zoek.officielebekendmakingen.nl/kst-37020-IX-40/metadata.xml")).toBe("kst-37020-IX-40");
    expect(
      normalizeBekendmakingIdentifier("https://repository.overheid.nl/frbr/officielepublicaties/gmb/2026/gmb-2026-104512/1/metadata/metadata.xml"),
    ).toBe("gmb-2026-104512");
    expect(
      normalizeBekendmakingIdentifier("https://repository.overheid.nl/frbr/officielepublicaties/h-tk/20242025/h-tk-20242025-42-4/1/xml/h-tk-20242025-42-4.xml"),
    ).toBe("h-tk-20242025-42-4");
    expect(normalizeBekendmakingIdentifier("https://zoek.officielebekendmakingen.nl/blg-1093410.pdf")).toBe("blg-1093410");
  });

  it("detectPlaces skips abbreviations, verb forms and institution names", () => {
    expect(detectPlaces("OSS software")).toEqual([]);
    expect(detectPlaces("overlast weert")).toEqual([]);
    expect(detectPlaces("parkeerbeleid Weert")).toEqual([{ name: "Weert", kinds: ["gemeente"] }]);
    expect(detectPlaces("Universiteit Utrecht subsidie")).toEqual([]);
    expect(detectPlaces("Rechtbank Den Haag uitspraak")).toEqual([]);
    expect(detectPlaces("Universiteit van Amsterdam huisvesting")).toEqual([]);
    // Named on its own as well: still a place.
    expect(detectPlaces("Hogeschool Utrecht en gemeente Utrecht")).toEqual([{ name: "Utrecht", kinds: ["gemeente"] }]);
  });

  it("parseLegalBasis splits label and reference", () => {
    expect(parseLegalBasis("Gemeentewet")).toEqual({ label: "Gemeentewet" });
    expect(parseLegalBasis("art. 3]|[onbekend:123")).toEqual({ label: "art. 3", reference: "onbekend:123" });
  });

  it("publicationXmlToText separates elements but keeps inline markup inside words", () => {
    expect(publicationXmlToText(GMB_XML)).toBe(
      "GEMEENTEBLAD Officiële uitgave van de gemeente Pijnacker-Nootdorp Het college van burgemeester en wethouders; " +
        "gelet op artikel 4:81 van de Algemene wet bestuursrecht & de Afvalstoffenverordening;",
    );
  });

  it("extractSruDiagnostic ignores normal responses and keeps the details", () => {
    expect(extractSruDiagnostic(parseXml(sruResponse([GMB_RECORD], 1)))).toBeUndefined();
    expect(extractSruDiagnostic(parseXml(SRU_DIAGNOSTIC))).toContain("mismatched input");
    const withDetails = SRU_DIAGNOSTIC.replace("<ns3:message>", "<ns3:details>[:2026-02-29] is not a valid range constraint</ns3:details><ns3:message>");
    expect(extractSruDiagnostic(parseXml(withDetails))).toMatch(/^line 1:13 mismatched input .*: \[:2026-02-29\] is not a valid range constraint$/);
  });

  it("sruTotal tells a missing count from zero", () => {
    expect(sruTotal(parseXml(sruResponse([], 0)))).toBe(0);
    expect(sruTotal(parseXml(sruResponse([], 17446)))).toBe(17446);
    expect(sruTotal(parseXml(SRU_DIAGNOSTIC))).toBeUndefined();
  });

  it("rewriteKeepingSyntax keeps phrases, citations and apostrophe words out of the rewriter", () => {
    const moderate = (text: string) => rewriteQuery(text, "moderate");
    expect(rewriteKeepingSyntax('"zorg en veiligheid" Utrecht', moderate).rewritten).toBe('"zorg en veiligheid" utrecht');
    expect(rewriteKeepingSyntax("“zorg en veiligheid”", moderate).rewritten).toBe('"zorg en veiligheid"');
    const question = rewriteKeepingSyntax("Wat is de verordening 2016/679?", moderate);
    expect(question.rewritten).toBe("verordening 2016/679");
    expect(question.explanation).toBe('Zoekterm herschreven: "Wat is de verordening 2016/679?" → "verordening 2016/679".');
    expect(rewriteKeepingSyntax("parkeren 's-Gravenhage auto's", moderate).rewritten).toBe("parkeren 's-Gravenhage auto's");
    expect(rewriteKeepingSyntax("Zijn er regels voor auto's, fietsen?", moderate).rewritten).toBe("zijn er regels voor auto's fietsen");
    expect(rewriteKeepingSyntax("informatie over OV-visie", moderate)).toEqual(moderate("informatie over OV-visie"));
  });

  it("rewriteKeepingSyntax restores the held tokens in syntaxQuery too", () => {
    const moderate = (text: string) => rewriteQuery(text, "moderate");
    const phrase = rewriteKeepingSyntax('"zorg en veiligheid" AND Utrecht', moderate);
    expect(phrase.syntaxQuery).toBe('"zorg en veiligheid" AND utrecht');
    const citation = rewriteKeepingSyntax("parkeren AND fietsen 2016/679", moderate);
    expect(citation.syntaxQuery).toBe("parkeren AND fietsen 2016/679");
    for (const out of [phrase, citation]) expect(JSON.stringify(out)).not.toMatch(/zqx\d+xqz/);
    // Without search syntax there is no separate syntax form.
    expect(rewriteKeepingSyntax('"zorg en veiligheid" Utrecht', moderate).syntaxQuery).toBeUndefined();
  });

  it("rewriteKeepingSyntax keeps a trailing sort clause whole, so the planner can leave it out", () => {
    const moderate = (text: string) => rewriteQuery(text, "moderate");
    expect(rewriteKeepingSyntax("parkeerbeleid sortBy dt.date", moderate).rewritten).toBe("parkeerbeleid sortBy dt.date");
    expect(rewriteKeepingSyntax("Parkeerbeleid sortBy dt.date/sort.descending", moderate).rewritten).toBe(
      "parkeerbeleid sortBy dt.date/sort.descending",
    );
  });
});
