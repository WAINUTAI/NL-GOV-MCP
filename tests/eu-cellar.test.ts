import { beforeEach, describe, expect, it, vi } from "vitest";
import { EuCellarSource, normalizeCelex } from "../src/sources/eu-cellar.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

const XSD = "http://www.w3.org/2001/XMLSchema#";

function lit(value: string, datatype = "string") {
  return { type: "literal", datatype: `${XSD}${datatype}`, value };
}
function uri(value: string) {
  return { type: "uri", value };
}
function sparql(bindings: Array<Record<string, unknown>>) {
  return { head: { vars: [] }, results: { distinct: false, ordered: true, bindings } };
}

/** Stub fetch with one SPARQL-JSON body and record the SPARQL text of every call. */
function stubSparql(body: unknown) {
  const queries: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    queries.push(url.searchParams.get("query") ?? "");
    return jsonResponse(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, queries };
}

/** Answer the metadata, case-law list and case-law count queries separately. */
function stubDocumentQueries(bodies: { meta: unknown; caseLaw?: unknown; count?: unknown }) {
  const queries: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const q = url.searchParams.get("query") ?? "";
    queries.push(q);
    const body = q.includes("COUNT(DISTINCT ?case)")
      ? (bodies.count ?? sparql([{ n: lit("0", "integer") }]))
      : q.includes("case-law_interpretes_resource_legal")
        ? (bodies.caseLaw ?? sparql([]))
        : bodies.meta;
    return body instanceof Response ? body : jsonResponse(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, queries };
}

describe("normalizeCelex", () => {
  it("accepts plain and prefixed CELEX numbers", () => {
    expect(normalizeCelex("32016R0679")).toBe("32016R0679");
    expect(normalizeCelex("CELEX:32016R0679")).toBe("32016R0679");
    expect(normalizeCelex("celex 32016r0679")).toBe("32016R0679");
    expect(normalizeCelex("32016R679")).toBe("32016R0679");
  });

  it("turns citations into sector-3 CELEX numbers", () => {
    expect(normalizeCelex("Verordening (EU) 2016/679")).toBe("32016R0679");
    expect(normalizeCelex("Richtlijn (EU) 2016/680")).toBe("32016L0680");
    expect(normalizeCelex("Richtlijn 2019/1024")).toBe("32019L1024");
    expect(normalizeCelex("Besluit (EU) 2026/2060")).toBe("32026D2060");
    expect(normalizeCelex("Uitvoeringsverordening (EU) 2023/1234")).toBe("32023R1234");
  });

  it("reads old-style year/number and number/year citations", () => {
    expect(normalizeCelex("Richtlijn 95/46/EG")).toBe("31995L0046");
    expect(normalizeCelex("Verordening (EG) nr. 1049/2001")).toBe("32001R1049");
  });

  it("returns null for anything it cannot recognise", () => {
    expect(normalizeCelex("AVG")).toBeNull();
    expect(normalizeCelex("")).toBeNull();
    expect(normalizeCelex("2016/679")).toBeNull();
    expect(normalizeCelex('32016R0679" } DROP')).toBeNull();
    expect(normalizeCelex("62014CJ0362")).toBeNull();
  });
});

describe("EuCellarSource.document", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("maps a CELLAR work and deduplicates the multiplied rows", async () => {
    const base = {
      date: lit("2016-04-27", "date"),
      type: uri("http://publications.europa.eu/resource/authority/resource-type/REG"),
      force: lit("true", "boolean"),
      eli: lit("http://data.europa.eu/eli/reg/2016/679/oj", "anyURI"),
      titleEn: { type: "literal", value: "Regulation (EU) 2016/679 (GDPR)" },
    };
    const { queries, fetchMock } = stubDocumentQueries({
      meta: sparql([
        { ...base, titleNl: { type: "literal", value: "Verordening (EU) 2016/679 (AVG)" } },
        { ...base, titleNl: { type: "literal", value: "Verordening (EU) 2016/679 (AVG)" } },
      ]),
    });

    const out = await new EuCellarSource(testConfig).document({ id: "Verordening (EU) 2016/679" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const q of queries) expect(q).toContain('"32016R0679"^^xsd:string');
    expect(out.total).toBe(1);
    expect(out.items).toEqual([
      {
        celex: "32016R0679",
        title: "Verordening (EU) 2016/679 (AVG)",
        title_language: "nl",
        document_type: "REG",
        document_type_label: "Verordening",
        date: "2016-04-27",
        in_force: true,
        eli: "http://data.europa.eu/eli/reg/2016/679/oj",
        eurlex_url: "https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=CELEX:32016R0679",
        cellar_url: "https://publications.europa.eu/resource/celex/32016R0679",
        hvj_arresten: [],
        hvj_arresten_total: 0,
      },
    ]);
    expect(out.access_note).toMatch(/CELLAR/);
    expect(out.access_note).toMatch(/authentiek/);
  });

  it("maps CJEU rulings interpreting the act, newest first, deduplicated and capped at ten", async () => {
    const ruling = (n: number, extra: Record<string, unknown> = {}) => ({
      celex: lit(`62024CJ0${String(500 + n)}`),
      ecli: lit(`ECLI:EU:C:2026:${n}`),
      date: lit(`2026-03-${String(20 - n).padStart(2, "0")}`, "date"),
      titleNl: { type: "literal", "xml:lang": "nl", value: `Arrest van het Hof van ${20 - n} maart 2026.#Partij ${n} tegen TC.#Zaak C-${500 + n}/24.` },
      ...extra,
    });
    const caseRows = [
      ruling(1),
      ruling(1, { titleNl: { type: "literal", value: "Tweede NL-titel van hetzelfde arrest" } }),
      { celex: lit("62023CJ0655"), date: lit("2026-03-18", "date"), titleEn: { type: "literal", value: "Judgment in English only" } },
      ...Array.from({ length: 12 }, (_, i) => ruling(i + 3)),
    ];
    const { queries } = stubDocumentQueries({
      meta: sparql([{ type: uri("http://publications.europa.eu/resource/authority/resource-type/REG"), titleNl: { type: "literal", value: "AVG" } }]),
      caseLaw: sparql(caseRows),
      count: sparql([{ n: lit("75", "integer") }]),
    });

    const out = await new EuCellarSource(testConfig).document({ id: "32016R0679" });

    const listQuery = queries.find((q) => q.includes("case-law_interpretes_resource_legal") && !q.includes("COUNT("));
    expect(listQuery).toContain("cdm:case-law_ecli");
    expect(listQuery).toContain("ORDER BY DESC(?date)");
    expect(listQuery).toContain("language/NLD>");
    const item = out.items[0];
    expect(item.hvj_arresten_total).toBe(75);
    const rulings = item.hvj_arresten as Array<Record<string, unknown>>;
    expect(rulings).toHaveLength(10);
    expect(rulings[0]).toEqual({
      ecli: "ECLI:EU:C:2026:1",
      celex: "62024CJ0501",
      title: "Arrest van het Hof van 19 maart 2026. Partij 1 tegen TC. Zaak C-501/24.",
      date: "2026-03-19",
      eurlex_url: "https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=CELEX:62024CJ0501",
    });
    expect(rulings[1]).toEqual({
      ecli: null,
      celex: "62023CJ0655",
      title: "Judgment in English only",
      date: "2026-03-18",
      eurlex_url: "https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=CELEX:62023CJ0655",
    });
    expect(new Set(rulings.map((r) => r.celex)).size).toBe(10);
    expect(out.access_note).toMatch(/10 nieuwste van 75/);
  });

  it("still returns the act when only the CJEU query fails, with null case-law fields", async () => {
    stubDocumentQueries({
      meta: sparql([{ type: uri("http://publications.europa.eu/resource/authority/resource-type/REG"), titleNl: { type: "literal", value: "AVG" } }]),
      caseLaw: jsonResponse({ error: "Virtuoso 37000 Error" }, 400),
      count: sparql([{ n: lit("75", "integer") }]),
    });

    const out = await new EuCellarSource(testConfig).document({ id: "32016R0679" });

    expect(out.total).toBe(1);
    expect(out.items[0]).toMatchObject({ celex: "32016R0679", title: "AVG", hvj_arresten: null, hvj_arresten_total: null });
    expect(out.access_note).toMatch(/HvJ-rechtspraak kon niet worden opgehaald/);
  });

  it("falls back to the English title when there is no Dutch expression", async () => {
    stubDocumentQueries({
      meta: sparql([
        {
          date: lit("1970-01-01", "date"),
          type: uri("http://publications.europa.eu/resource/authority/resource-type/DIR"),
          force: lit("0"),
          titleEn: { type: "literal", value: "Old directive" },
        },
      ]),
    });
    const out = await new EuCellarSource(testConfig).document({ id: "31970L0001" });
    expect(out.items[0]).toMatchObject({
      title: "Old directive",
      title_language: "en",
      document_type_label: "Richtlijn",
      in_force: false,
      eli: null,
    });
  });

  it("returns no items (not a made-up record) when CELLAR has nothing", async () => {
    stubSparql(sparql([]));
    const out = await new EuCellarSource(testConfig).document({ id: "32016R9999" });
    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
  });

  it("rejects an unrecognised id without calling CELLAR", async () => {
    const { fetchMock } = stubSparql(sparql([]));
    await expect(
      new EuCellarSource(testConfig).document({ id: '32016R0679"^^xsd:string } DROP' }),
    ).rejects.toThrow(/Ongeldig CELEX-nummer of EU-citaat/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("EuCellarSource.search", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("builds a bif:contains title search and maps + deduplicates the rows", async () => {
    const row = {
      celex: lit("32024R1689"),
      date: lit("2024-06-13", "date"),
      type: uri("http://publications.europa.eu/resource/authority/resource-type/REG"),
      force: lit("1"),
      title: { type: "literal", value: "Verordening (EU) 2024/1689 artificiële intelligentie" },
    };
    const { queries } = stubSparql(
      sparql([
        row,
        { ...row, force: lit("true", "boolean") },
        {
          celex: lit("32025R0454"),
          date: lit("2025-03-07", "date"),
          type: uri("http://publications.europa.eu/resource/authority/resource-type/REG_IMPL"),
          title: { type: "literal", value: "Uitvoeringsverordening (EU) 2025/454" },
        },
      ]),
    );

    const out = await new EuCellarSource(testConfig).search({
      query: "artificiële intelligentie",
      type: "REG",
      limit: 500,
    });

    const q = queries[0];
    expect(q).toContain(`bif:contains '"artificiële" AND "intelligentie"'`);
    expect(q).toContain("resource-type/REG_IMPL>");
    expect(q).not.toContain("resource-type/DIR>");
    expect(q).toContain("ORDER BY DESC(?date)");
    expect(q).toContain(`LIMIT ${testConfig.limits.maxRows}`);
    expect(out.total).toBeNull();
    expect(out.items.map((i) => i.celex)).toEqual(["32024R1689", "32025R0454"]);
    expect(out.items[0]).toMatchObject({ title_language: "nl", in_force: true, document_type: "REG" });
    expect(out.items[1]).toMatchObject({
      document_type: "REG_IMPL",
      document_type_label: "Uitvoeringsverordening",
      in_force: null,
    });
    expect(out.access_note).toMatch(/titels/);
    expect(out.access_note).toMatch(/officiële EU-terminologie/);
  });

  it("tells the caller to rephrase when no title matches", async () => {
    stubSparql(sparql([]));
    const out = await new EuCellarSource(testConfig).search({ query: "kunstmatige intelligentie", limit: 5 });
    expect(out.items).toEqual([]);
    expect(out.access_note).toMatch(/Geen titels gevonden; probeer officiële EU-terminologie/);
    expect(out.access_note).toMatch(/synoniemen of minder woorden/);
  });

  it("keeps quotes, braces and SPARQL keywords out of the query", async () => {
    const { queries } = stubSparql(sparql([]));
    await new EuCellarSource(testConfig).search({
      query: `privacy' } ; DROP GRAPH <x> # "gegevens" {}`,
      limit: 5,
    });
    const q = queries[0];
    const contains = /bif:contains '([^']*)'/.exec(q)?.[1];
    expect(contains).toBe('"privacy" AND "DROP" AND "GRAPH" AND "gegevens"');
    expect(q).not.toContain("} ;");
    expect(q).not.toContain("<x>");
    expect(q).not.toContain("privacy'");
  });

  it("caps the free-text expression at six words and drops short words", async () => {
    const { queries } = stubSparql(sparql([]));
    await new EuCellarSource(testConfig).search({
      query: "a de EU één twee drie vier vijf zes zeven acht",
      limit: 5,
    });
    const contains = /bif:contains '([^']*)'/.exec(queries[0])?.[1] ?? "";
    expect(contains.split(" AND ")).toEqual(['"één"', '"twee"', '"drie"', '"vier"', '"vijf"', '"zes"']);
  });

  it("throws when nothing usable remains after sanitizing", async () => {
    const { fetchMock } = stubSparql(sparql([]));
    await expect(
      new EuCellarSource(testConfig).search({ query: `'} "" <> ;`, limit: 5 }),
    ).rejects.toThrow(/geen bruikbare woorden/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("EuCellarSource.nlTransposition", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("maps Dutch implementing measures and derives Staatsblad/Staatscourant ids", async () => {
    const { queries } = stubSparql(
      sparql([
        {
          nimcelex: lit("72019L1024NLD_202402750"),
          title: { type: "literal", "xml:lang": "nl", value: "Mededeling implementatie Richtlijn 2019/1024/EU" },
          typeAct: lit("Bekendmaking"),
          ojnum: lit("20264"),
          ojdate: lit("2024-06-21", "date"),
          notif: lit("2024-06-21", "date"),
        },
        {
          nimcelex: lit("72016L0680NLD_268378"),
          title: { type: "literal", value: "Wet van 17 oktober 2018 tot wijziging van de Wet politiegegevens" },
          typeAct: lit("Wet"),
          oj: lit("Staatsblad (Bulletin des Lois et des Décrets royaux)"),
          ojnum: lit("401"),
          ojdate: lit("2018-11-12", "date"),
          notif: lit("2019-01-24", "date"),
        },
        {
          nimcelex: lit("72016L0680NLD_999"),
          title: { type: "literal", value: "Besluit zonder publicatiegegevens" },
          typeAct: lit("Besluit"),
        },
      ]),
    );

    const out = await new EuCellarSource(testConfig).nlTransposition({
      id: "Richtlijn (EU) 2016/680",
      limit: 10,
    });

    const q = queries[0];
    expect(q).toContain('"32016L0680"^^xsd:string');
    expect(q).toContain("country/NLD>");
    expect(q).toContain("LIMIT 10");
    expect(out.total).toBe(3);
    expect(out.items[0]).toEqual({
      directive_celex: "32016L0680",
      title: "Mededeling implementatie Richtlijn 2019/1024/EU",
      measure_type: "Bekendmaking",
      official_journal: "Staatscourant 2024, 20264",
      identifier: "stcrt-2024-20264",
      publication_date: "2024-06-21",
      notification_date: "2024-06-21",
      canonical_url: "https://zoek.officielebekendmakingen.nl/stcrt-2024-20264.html",
    });
    expect(out.items[1]).toMatchObject({
      official_journal: "Staatsblad 2018, 401",
      identifier: "stb-2018-401",
      canonical_url: "https://zoek.officielebekendmakingen.nl/stb-2018-401.html",
    });
    expect(out.items[2]).toMatchObject({
      official_journal: null,
      identifier: null,
      publication_date: null,
      canonical_url: "https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=CELEX:32016L0680",
    });
  });

  it("returns empty items when no measures are notified", async () => {
    stubSparql(sparql([]));
    const out = await new EuCellarSource(testConfig).nlTransposition({ id: "32019L1024", limit: 5 });
    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.access_note).toMatch(/geen Nederlandse omzettingsmaatregelen/);
  });

  it("refuses a regulation and invalid ids without calling CELLAR", async () => {
    const { fetchMock } = stubSparql(sparql([]));
    const src = new EuCellarSource(testConfig);
    await expect(src.nlTransposition({ id: "32016R0679", limit: 5 })).rejects.toThrow(/geen richtlijn/);
    await expect(src.nlTransposition({ id: "AVG", limit: 5 })).rejects.toThrow(
      /Ongeldig CELEX-nummer of EU-citaat/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
