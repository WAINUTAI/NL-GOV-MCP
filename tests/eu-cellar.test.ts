import { beforeEach, describe, expect, it, vi } from "vitest";
import { EuCellarSource, normalizeCelex, parseDocumentNumber } from "../src/sources/eu-cellar.js";
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

/** Answer the metadata, case-law list/count and amendment list/count queries separately. */
function stubDocumentQueries(bodies: {
  meta: unknown;
  caseLaw?: unknown;
  count?: unknown;
  changes?: unknown;
  changesCount?: unknown;
}) {
  const queries: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const q = url.searchParams.get("query") ?? "";
    queries.push(q);
    const body = q.includes("COUNT(DISTINCT ?case)")
      ? (bodies.count ?? sparql([{ n: lit("0", "integer") }]))
      : q.includes("case-law_interpretes_resource_legal")
        ? (bodies.caseLaw ?? sparql([]))
        : q.includes("COUNT(DISTINCT ?act)")
          ? (bodies.changesCount ?? sparql([]))
          : q.includes("resource_legal_amends_resource_legal")
            ? (bodies.changes ?? sparql([]))
            : bodies.meta;
    return body instanceof Response ? body : jsonResponse(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, queries };
}

/** Answer the exact CELEX lookup (VALUES) and the title phrase search separately. */
function stubNumberQueries(bodies: { exact: unknown; titles: unknown }) {
  const queries: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const q = url.searchParams.get("query") ?? "";
    queries.push(q);
    const body = q.includes("VALUES ?celex") ? bodies.exact : bodies.titles;
    return body instanceof Response ? body : jsonResponse(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, queries };
}

/** The bif:contains expression of a title query, or undefined. */
function freetextOf(q: string): string | undefined {
  return /bif:contains '([^']*)'/.exec(q)?.[1];
}

/** Answer title searches per bif:contains expression; unknown expressions get no rows. */
function stubTitleQueries(byExpression: Record<string, unknown>) {
  const queries: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const q = url.searchParams.get("query") ?? "";
    queries.push(q);
    const body = byExpression[freetextOf(q) ?? ""] ?? sparql([]);
    return body instanceof Response ? body : jsonResponse(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, queries };
}

const RT = "http://publications.europa.eu/resource/authority/resource-type/";

/** CELLAR's titles of Verordening (EU) 2018/1999 and of the older (EG) nr. 2018/1999. */
const ENERGY_UNION_TITLE_NL =
  "Verordening (EU) 2018/1999 van het Europees Parlement en de Raad van 11 december 2018 inzake de governance van de " +
  "energie-unie en van de klimaatactie, tot wijziging van Verordeningen (EG) nr. 663/2009 en (EG) nr. 715/2009 van het " +
  "Europees Parlement en de Raad, Richtlijnen 94/22/EG, 98/70/EG, 2009/31/EG, 2009/73/EG, 2010/31/EU, 2012/27/EU en " +
  "2013/30/EU van het Europees Parlement en de Raad, Richtlijnen 2009/119/EG en (EU) 2015/652 van de Raad, en tot " +
  "intrekking van Verordening (EU) nr. 525/2013 van het Europees Parlement en de Raad (Voor de EER relevante tekst.)";
const ENERGY_UNION_TITLE_EN =
  "Regulation (EU) 2018/1999 of the European Parliament and of the Council of 11 December 2018 on the Governance of the " +
  "Energy Union and Climate Action, amending Regulations (EC) No 663/2009 and (EC) No 715/2009 of the European Parliament " +
  "and of the Council, Directives 94/22/EC, 98/70/EC, 2009/31/EC, 2009/73/EC, 2010/31/EU, 2012/27/EU and 2013/30/EU";
const BEEF_SALE_TITLE_NL =
  "Verordening (EG) nr. 2018/1999 van de Commissie van 21 september 1999 betreffende de verkoop, bij openbare " +
  "inschrijving en voor uitvoer, van rundvlees uit de voorraden van bepaalde interventiebureaus";

function titleRow(celex: string, date: string, title: string, type = "REG") {
  return {
    celex: lit(celex),
    date: lit(date, "date"),
    type: uri(`${RT}${type}`),
    title: { type: "literal", value: title },
  };
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
    expect(normalizeCelex("Verordening (EEG) nr. 1408/71")).toBe("31971R1408");
  });

  it("reads a short number before a four-digit year as number/year, with or without 'nr.'", () => {
    // Since 1999 the year is written in four digits: '10/2011' is number 10 of 2011, not 2010/2011.
    expect(normalizeCelex("Verordening (EU) 10/2011")).toBe("32011R0010");
    expect(normalizeCelex("Verordening (EU) nr. 10/2011")).toBe("32011R0010");
    expect(normalizeCelex("Verordening 66/2010")).toBe("32010R0066");
    expect(normalizeCelex("Verordening (EG) 1/2003")).toBe("32003R0001");
    // A two-digit year never stands for 20xx; a regulation's pair is number/year until 2014.
    expect(normalizeCelex("Verordening 46/95")).toBe("31995R0046");
    expect(normalizeCelex("Besluit van 13/06")).toBeNull();
    expect(normalizeCelex("Verordening van 13/06")).toBeNull();
  });

  it("reads a regulation pair year/number only from 2015 on (re-review: '(EG) 1998/2006')", () => {
    // Before 2015 a regulation is always cited number/year, also without 'nr.'.
    expect(normalizeCelex("Verordening (EG) 1998/2006")).toBe("32006R1998");
    expect(normalizeCelex("Verordening (EG) 1987/2006")).toBe("32006R1987");
    expect(normalizeCelex("Verordening (EG) 2006/2004")).toBe("32004R2006");
    expect(normalizeCelex("Verordening 1998/2006")).toBe("32006R1998");
    expect(normalizeCelex("Verordening (EEG) 1408/71")).toBe("31971R1408");
    expect(normalizeCelex("Regulation (EC) 1998/2006")).toBe("32006R1998");
    // From 2015 on, year/number, unchanged.
    expect(normalizeCelex("Verordening (EU) 2016/679")).toBe("32016R0679");
    expect(normalizeCelex("Verordening (EU) 2019/2088")).toBe("32019R2088");
    expect(normalizeCelex("Verordening (EU) 2021/1119")).toBe("32021R1119");
    expect(normalizeCelex("Verordening (EU, Euratom) 2018/1046")).toBe("32018R1046");
    // Both readings fit: the marker decides; without one the newer style comes first.
    expect(normalizeCelex("Verordening (EU) 2018/1999")).toBe("32018R1999");
    expect(normalizeCelex("Verordening (EG) 2018/1999")).toBe("31999R2018");
    expect(normalizeCelex("Verordening (EG) nr. 2018/1999")).toBe("31999R2018");
    expect(normalizeCelex("Verordening 2018/1999")).toBe("32018R1999");
    expect(normalizeCelex("Verordening (EU) 2016/2017")).toBe("32016R2017");
    // A pair no regulation is cited as is read the other way round.
    expect(normalizeCelex("Verordening 1119/2021")).toBe("32021R1119");
    expect(normalizeCelex("Verordening 2001/1049")).toBe("32001R1049");
    // Directives and decisions keep their own reading.
    expect(normalizeCelex("Richtlijn 2006/2004")).toBe("32006L2004");
    expect(normalizeCelex("Besluit nr. 1982/2006/EG")).toBe("32006D1982");
  });

  it("takes the (EU)/(EG) marker from the citation itself, not from older acts the title cites (re-review 3)", () => {
    // An act's own title, as eurlex_search returns it, often goes on to amend (EG) acts.
    expect(normalizeCelex(ENERGY_UNION_TITLE_NL)).toBe("32018R1999");
    expect(normalizeCelex(ENERGY_UNION_TITLE_EN)).toBe("32018R1999");
    expect(
      normalizeCelex(
        "Verordening (EU) 2017/1990 van de Commissie van 6 november 2017 houdende wijziging van Verordening (EG) nr. 1126/2008 " +
          "tot goedkeuring van bepaalde internationale standaarden voor jaarrekeningen",
      ),
    ).toBe("32017R1990");
    expect(
      normalizeCelex(
        "Uitvoeringsverordening (EU) 2020/2003 van de Commissie van 7 december 2020 tot wijziging van Verordening (EG) nr. 1210/2003 van de Raad",
      ),
    ).toBe("32020R2003");
    // The '/EG' of another act later on is not this pair's marker either.
    expect(normalizeCelex("Verordening 2018/1999 en Richtlijn 94/22/EG")).toBe("32018R1999");
    // The older act's own title keeps its number/year reading.
    expect(normalizeCelex(BEEF_SALE_TITLE_NL)).toBe("31999R2018");
    // A marker right before or right after the pair still decides.
    expect(normalizeCelex("EG-verordening 2018/1999")).toBe("31999R2018");
    expect(normalizeCelex("EU-verordening 2018/1999")).toBe("32018R1999");
    expect(normalizeCelex("Verordening 2018/1999 (EG)")).toBe("31999R2018");
    expect(normalizeCelex("Verordening 2018/1999/EG")).toBe("31999R2018");
    expect(normalizeCelex("Verordening (EU, Euratom) 2018/1999")).toBe("32018R1999");
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

    // metadata + case-law list/count + amendment list/count
    expect(fetchMock).toHaveBeenCalledTimes(5);
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
        amended_by: [],
        amended_by_total: 0,
        repealed_by: [],
      },
    ]);
    expect(out.access_note).toMatch(/CELLAR/);
    expect(out.access_note).toMatch(/authentiek/);
    expect(out.access_note).toMatch(/geen wijzigingshandelingen/);
  });

  it("lists the acts amending and repealing it, newest first, with CELEX and date", async () => {
    const amending = (n: number) => ({
      rel: lit("amended_by"),
      celex: lit(`3202${n}R1302`),
      date: lit(`202${n}-05-20`, "date"),
      force: lit("1"),
      titleNl: { type: "literal", value: `Verordening (EU) 202${n}/1302 tot wijziging van Verordening (EU) 2016/679` },
    });
    const { queries } = stubDocumentQueries({
      meta: sparql([{ type: uri(`${RT}REG`), force: lit("1"), titleNl: { type: "literal", value: "Algemene verordening gegevensbescherming" } }]),
      changes: sparql([
        {
          rel: lit("repealed_by"),
          celex: lit("32030R0001"),
          date: lit("2030-01-01", "date"),
          titleEn: { type: "literal", value: "Repealing regulation" },
        },
        amending(6),
        // Same act again with a second Dutch title: deduplicated.
        { ...amending(6), titleNl: { type: "literal", value: "Andere titel" } },
        amending(5),
      ]),
      changesCount: sparql([
        { rel: lit("amended_by"), n: lit("2", "integer") },
        { rel: lit("repealed_by"), n: lit("1", "integer") },
      ]),
    });

    const out = await new EuCellarSource(testConfig).document({ id: "32016R0679" });

    const listQuery = queries.find((q) => q.includes("resource_legal_amends_resource_legal") && !q.includes("COUNT("));
    expect(listQuery).toContain("resource_legal_repeals_resource_legal");
    expect(listQuery).toContain("ORDER BY DESC(?rel) DESC(?date)");
    expect(listQuery).toContain('"32016R0679"^^xsd:string');
    const item = out.items[0];
    expect(item.in_force).toBe(true);
    expect(item.amended_by_total).toBe(2);
    expect(item.amended_by).toEqual([
      {
        celex: "32026R1302",
        title: "Verordening (EU) 2026/1302 tot wijziging van Verordening (EU) 2016/679",
        date: "2026-05-20",
        in_force: true,
        eurlex_url: "https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=CELEX:32026R1302",
      },
      expect.objectContaining({ celex: "32025R1302", date: "2025-05-20" }),
    ]);
    expect(item.repealed_by).toEqual([
      {
        celex: "32030R0001",
        title: "Repealing regulation",
        date: "2030-01-01",
        in_force: null,
        eurlex_url: "https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=CELEX:32030R0001",
      },
    ]);
    expect(out.access_note).toMatch(/alle 2 wijzigingshandelingen volgens CELLAR \(laatste: 32026R1302 van 2026-05-20\)/);
    expect(out.access_note).toMatch(/Ingetrokken door: 32030R0001/);
  });

  it("caps amended_by at twenty and reports the full count", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      rel: lit("amended_by"),
      celex: lit(`3202${Math.floor(i / 10)}R${String(1000 + i)}`),
      date: lit(`2026-01-${String(30 - i).padStart(2, "0")}`, "date"),
    }));
    stubDocumentQueries({
      meta: sparql([{ type: uri(`${RT}REG`), titleNl: { type: "literal", value: "REACH" } }]),
      changes: sparql(rows),
      changesCount: sparql([{ rel: lit("amended_by"), n: lit("85", "integer") }]),
    });

    const out = await new EuCellarSource(testConfig).document({ id: "32006R1907" });

    expect(out.items[0].amended_by).toHaveLength(20);
    expect(out.items[0].amended_by_total).toBe(85);
    expect(out.access_note).toMatch(/de 20 nieuwste van 85 wijzigingshandelingen/);
  });

  it("looks an act up by its own full title, not by the older (EG) acts that title amends (re-review 3)", async () => {
    const { queries } = stubDocumentQueries({
      meta: sparql([{ type: uri(`${RT}REG`), titleNl: { type: "literal", value: ENERGY_UNION_TITLE_NL } }]),
    });

    const out = await new EuCellarSource(testConfig).document({ id: ENERGY_UNION_TITLE_NL });

    expect(out.params.celex).toBe("32018R1999");
    expect(queries).toHaveLength(5);
    for (const q of queries) expect(q).toContain('"32018R1999"^^xsd:string');
    expect(queries.join("\n")).not.toContain("31999R2018");
    expect(out.items[0]).toMatchObject({ celex: "32018R1999", title: ENERGY_UNION_TITLE_NL });
  });

  it("leaves corrigenda out of the amending acts and their count (review: '32011R0010R(12)' listed as the latest)", async () => {
    const { queries } = stubDocumentQueries({
      meta: sparql([{ type: uri(`${RT}REG`), titleNl: { type: "literal", value: "Verordening (EU) nr. 10/2011 betreffende materialen van kunststof" } }]),
    });

    await new EuCellarSource(testConfig).document({ id: "32011R0010" });

    const listQuery = queries.find((q) => q.includes("resource_legal_amends_resource_legal") && !q.includes("COUNT(")) ?? "";
    const countQuery = queries.find((q) => q.includes("COUNT(DISTINCT ?act)")) ?? "";
    for (const q of [listQuery, countQuery]) {
      expect(q).toContain("?act cdm:resource_legal_id_celex ?celex .");
      expect(q).toContain('FILTER(!CONTAINS(STR(?celex), "R("))');
    }
  });

  it("still returns the act when only the amendment queries fail, with null amendment fields", async () => {
    stubDocumentQueries({
      meta: sparql([{ type: uri(`${RT}REG`), titleNl: { type: "literal", value: "AVG" } }]),
      changes: jsonResponse({ error: "Virtuoso 37000 Error" }, 400),
    });

    const out = await new EuCellarSource(testConfig).document({ id: "32016R0679" });

    expect(out.total).toBe(1);
    expect(out.items[0]).toMatchObject({
      celex: "32016R0679",
      hvj_arresten_total: 0,
      amended_by: null,
      amended_by_total: null,
      repealed_by: null,
    });
    expect(out.access_note).toMatch(/Wijzigingen konden niet worden opgehaald/);
  });

  it("rejects an invalid amendment count instead of reporting a wrong number", async () => {
    stubDocumentQueries({
      meta: sparql([{ type: uri(`${RT}REG`), titleNl: { type: "literal", value: "AVG" } }]),
      changesCount: sparql([{ rel: lit("amended_by"), n: lit("veel") }]),
    });
    const out = await new EuCellarSource(testConfig).document({ id: "32016R0679" });
    expect(out.items[0].amended_by_total).toBeNull();
    expect(out.access_note).toMatch(/geen geldig aantal wijzigingshandelingen/);
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

  it("searches two-letter terms such as 'VK'", async () => {
    const { queries } = stubSparql(sparql([]));
    await new EuCellarSource(testConfig).search({ query: "VK", limit: 5 });
    expect(/bif:contains '([^']*)'/.exec(queries[0])?.[1]).toBe('"VK"');

    await new EuCellarSource(testConfig).search({ query: "VK-verordening", limit: 5 });
    expect(/bif:contains '([^']*)'/.exec(queries[1])?.[1]).toBe('"VK" AND "verordening"');
  });

  it("drops two-letter stopwords and the EU/EG/nr boilerplate, and names what it ignored", async () => {
    const { queries } = stubSparql(sparql([]));
    const out = await new EuCellarSource(testConfig).search({ query: "de EU regels op VK in 5G of nr", limit: 5 });
    expect(queries.map(freetextOf)).toContain('"regels" AND "VK" AND "5G"');
    expect(out.access_note).toMatch(/Niet meegezocht .*: de, EU, op, in, of, nr\./);
  });

  it("fills a short result with titles that lack the two-letter word, after the full matches", async () => {
    const { queries } = stubTitleQueries({
      '"terugtrekking" AND "Verenigd" AND "Koninkrijk" AND "VK"': sparql([
        titleRow("32020R2224", "2020-12-23", "Verordening (EU) 2020/2224 ... terugtrekking van het Verenigd Koninkrijk (VK) ..."),
      ]),
      '"terugtrekking" AND "Verenigd" AND "Koninkrijk"': sparql([
        titleRow("32020R2224", "2020-12-23", "Verordening (EU) 2020/2224 ... terugtrekking van het Verenigd Koninkrijk (VK) ..."),
        titleRow("32019R0501", "2019-03-25", "Verordening (EU) 2019/501 ... terugtrekking van het Verenigd Koninkrijk ..."),
      ]),
    });

    const out = await new EuCellarSource(testConfig).search({ query: "terugtrekking Verenigd Koninkrijk (VK)", limit: 20 });

    expect(queries).toHaveLength(2);
    expect(out.items.map((i) => [i.celex, i.match])).toEqual([
      ["32020R2224", "title"],
      ["32019R0501", "title_partial"],
    ]);
    expect(out.params).toMatchObject({
      freetext: '"terugtrekking" AND "Verenigd" AND "Koninkrijk" AND "VK"',
      freetext_partial: '"terugtrekking" AND "Verenigd" AND "Koninkrijk"',
    });
    expect(out.access_note).toContain(
      "Eerst 1 titel met alle zoekwoorden, ook 'VK' (match: title); daarna 1 titel zonder 'VK' (match: title_partial)",
    );
  });

  it("shows the titles without the two-letter word when the full AND finds nothing ('Brexit VK')", async () => {
    stubTitleQueries({
      '"Brexit"': sparql([
        titleRow("32026D1162", "2026-05-01", "Besluit over de brexit ...", "DEC"),
        titleRow("32026R0211", "2026-02-01", "Verordening brexit ..."),
      ]),
    });

    const out = await new EuCellarSource(testConfig).search({ query: "Brexit VK", limit: 20 });

    expect(out.items.map((i) => [i.celex, i.match])).toEqual([
      ["32026D1162", "title_partial"],
      ["32026R0211", "title_partial"],
    ]);
    expect(out.access_note).toContain("Geen titels met alle zoekwoorden, ook 'VK'; daarna 2 titels zonder 'VK'");
    expect(out.access_note).not.toContain("Geen titels gevonden");
  });

  it("does not add partial matches to a full page, but names the two-letter word it searched", async () => {
    const full = sparql(Array.from({ length: 3 }, (_, i) => titleRow(`3202${i}R000${i}`, `202${i}-01-01`, `Solvabiliteit II ${i}`)));
    stubTitleQueries({
      '"Solvabiliteit" AND "II"': full,
      '"Solvabiliteit"': sparql([titleRow("32009L0138", "2009-11-25", "Richtlijn Solvabiliteit", "DIR")]),
    });

    const out = await new EuCellarSource(testConfig).search({ query: "Solvabiliteit II", limit: 3 });

    expect(out.items.map((i) => i.match)).toEqual(["title", "title", "title"]);
    expect(out.access_note).toContain("Korte woorden zijn meegezocht: 'II'.");
  });

  it("skips the fallback when only two-letter or act-type words would remain", async () => {
    const { queries } = stubTitleQueries({});
    const out = await new EuCellarSource(testConfig).search({ query: "VK-verordening", limit: 20 });
    expect(queries.map(freetextOf)).toEqual(['"VK" AND "verordening"']);
    expect(out.params.freetext_partial).toBeUndefined();
    expect(out.access_note).toContain("Korte woorden zijn meegezocht: 'VK'.");

    await new EuCellarSource(testConfig).search({ query: "VK 5G", limit: 20 });
    expect(queries.slice(1).map(freetextOf)).toEqual(['"VK" AND "5G"']);
  });

  it("keeps the full-match result when only the fallback query fails, and says so", async () => {
    stubTitleQueries({
      '"Brexit" AND "VK"': sparql([titleRow("32020D0135", "2020-01-30", "Besluit terugtrekking VK brexit", "DEC")]),
      '"Brexit"': new Response("upstream down", { status: 400 }),
    });

    const out = await new EuCellarSource(testConfig).search({ query: "Brexit VK", limit: 20 });

    expect(out.items.map((i) => [i.celex, i.match])).toEqual([["32020D0135", "title"]]);
    expect(out.access_note).toContain("de aanvullende zoekopdracht zonder 'VK' mislukte");
  });

  it("refuses a query of only boilerplate words instead of scanning every title", async () => {
    const { fetchMock } = stubSparql(sparql([]));
    await expect(new EuCellarSource(testConfig).search({ query: "EU", limit: 5 })).rejects.toThrow(
      /geen bruikbare woorden \(minimaal 2 letters/,
    );
    await expect(new EuCellarSource(testConfig).search({ query: "(EG) nr.", limit: 5 })).rejects.toThrow(/geen bruikbare woorden/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("looks a bare document number up by CELEX first and drops other years with the same number", async () => {
    const titleRow = (celex: string, date: string, title: string, type = "REG") => ({
      celex: lit(celex),
      date: lit(date, "date"),
      type: uri(`${RT}${type}`),
      title: { type: "literal", value: title },
    });
    const { queries } = stubNumberQueries({
      exact: sparql([
        {
          celex: lit("32021R1119"),
          date: lit("2024-06-13", "date"),
          type: uri(`${RT}REG`),
          force: lit("1"),
          titleNl: { type: "literal", value: "Verordening (EU) 2021/1119 (Europese klimaatwet)" },
        },
      ]),
      titles: sparql([
        titleRow("32026R1302", "2026-05-20", "Verordening (EU) 2026/1302 tot wijziging van de Verordeningen (EU) 2021/1119, (EU) 2018/1139"),
        // Matches the phrase index but cites 2026/1119, not 2021/1119.
        titleRow("32026D1119", "2026-04-29", "Besluit (EU) 2026/1119 over de rekeningen voor het begrotingsjaar 2021, 1119 stuks", "DEC"),
        titleRow("32021R1119", "2021-06-30", "Verordening (EU) 2021/1119 (Europese klimaatwet)"),
      ]),
    });

    const out = await new EuCellarSource(testConfig).search({ query: "2021/1119", limit: 20 });

    const exactQuery = queries.find((q) => q.includes("VALUES ?celex")) ?? "";
    expect(exactQuery).toContain('"32021R1119"^^xsd:string "32021L1119"^^xsd:string "32021D1119"^^xsd:string');
    const titleQuery = queries.find((q) => q.includes("bif:contains")) ?? "";
    expect(/bif:contains '([^']*)'/.exec(titleQuery)?.[1]).toBe('"2021/1119"');
    expect(out.items.map((i) => [i.celex, i.match])).toEqual([
      ["32021R1119", "document_number"],
      ["32026R1302", "title"],
    ]);
    expect(out.items[0]).toMatchObject({ document_type: "REG", in_force: true, title_language: "nl" });
    expect(out.params).toMatchObject({ document_number: "2021/1119", celex: "32021R1119,32021L1119,32021D1119" });
    expect(out.access_note).toMatch(/herkend als documentnummer 2021\/1119: eerst de handeling zelf \(CELEX 32021R1119/);
  });

  it("uses the type word of a citation and old-style number/year order", async () => {
    const { queries } = stubNumberQueries({ exact: sparql([]), titles: sparql([]) });
    const out = await new EuCellarSource(testConfig).search({ query: "Verordening (EG) nr. 1049/2001", limit: 5 });
    expect(queries.find((q) => q.includes("VALUES ?celex"))).toContain('VALUES ?celex { "32001R1049"^^xsd:string }');
    expect(/bif:contains '([^']*)'/.exec(queries.find((q) => q.includes("bif:contains")) ?? "")?.[1]).toBe('"1049/2001"');
    expect(out.items).toEqual([]);
    expect(out.access_note).toMatch(/CELLAR kent geen verordening met dat nummer \(gezocht: CELEX 32001R1049\)/);
  });

  it("restricts a document-number lookup to the requested type", async () => {
    const { queries } = stubNumberQueries({ exact: sparql([]), titles: sparql([]) });
    const out = await new EuCellarSource(testConfig).search({ query: "2021/1119", type: "DIR", limit: 5 });
    expect(queries.find((q) => q.includes("VALUES ?celex"))).toContain('VALUES ?celex { "32021L1119"^^xsd:string }');
    expect(queries.find((q) => q.includes("bif:contains"))).not.toContain("resource-type/REG>");
    expect(out.access_note).toMatch(/controleer jaar, nummer en type/);
  });

  it("keeps a number mixed with topic words, or with injection text, a sanitised title search", async () => {
    const { queries } = stubSparql(sparql([]));
    await new EuCellarSource(testConfig).search({ query: "VK 2021/1119 boetes", limit: 5 });
    expect(queries.some((q) => q.includes("VALUES"))).toBe(false);
    // The full AND plus the fallback without the two-letter word.
    expect(queries.map(freetextOf).sort()).toEqual(['"2021" AND "1119" AND "boetes"', '"VK" AND "2021" AND "1119" AND "boetes"']);

    queries.length = 0;
    await new EuCellarSource(testConfig).search({ query: `2021/1119" } DROP GRAPH <x>`, limit: 5 });
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("VALUES");
    expect(queries[0]).not.toContain("<x>");
    expect(freetextOf(queries[0])).toBe('"2021" AND "1119" AND "DROP" AND "GRAPH"');
  });

  it("looks up a number written number/year without 'nr.' as that act ('66/2010', 'Verordening (EU) 10/2011')", async () => {
    const { queries } = stubNumberQueries({
      exact: sparql([
        {
          celex: lit("32010R0066"),
          date: lit("2009-11-25", "date"),
          type: uri(`${RT}REG`),
          titleNl: { type: "literal", value: "Verordening (EG) nr. 66/2010 inzake de EU-milieukeur" },
        },
      ]),
      titles: sparql([]),
    });

    const out = await new EuCellarSource(testConfig).search({ query: "66/2010", limit: 20 });
    expect(queries.find((q) => q.includes("VALUES ?celex"))).toContain('"32010R0066"^^xsd:string "32010L0066"^^xsd:string "32010D0066"^^xsd:string');
    expect(out.items.map((i) => [i.celex, i.match])).toEqual([["32010R0066", "document_number"]]);
    expect(out.params).toMatchObject({ document_number: "66/2010", freetext: '"66/2010"' });
    expect(out.access_note).not.toContain("kent geen");

    queries.length = 0;
    await new EuCellarSource(testConfig).search({ query: "Verordening (EU) 10/2011", limit: 20 });
    expect(queries.find((q) => q.includes("VALUES ?celex"))).toContain('VALUES ?celex { "32011R0010"^^xsd:string }');
  });

  it("says so when a bare number matches acts of several types", async () => {
    const exactRow = (celex: string, type: string) => ({ celex: lit(celex), date: lit("2010-01-01", "date"), type: uri(`${RT}${type}`) });
    stubNumberQueries({ exact: sparql([exactRow("32010R0066", "REG"), exactRow("32010D0066", "DEC")]), titles: sparql([]) });
    const out = await new EuCellarSource(testConfig).search({ query: "66/2010", limit: 20 });
    expect(out.items.map((i) => i.celex)).toEqual(["32010R0066", "32010D0066"]);
    expect(out.access_note).toContain("eerst de 2 handelingen met dat nummer");
    expect(out.access_note).not.toContain("de handeling zelf");
  });

  it("looks up a pre-2015 regulation written without 'nr.' as number/year (re-review: '(EG) 1998/2006')", async () => {
    const titleRow = (celex: string, title: string) => ({
      celex: lit(celex),
      date: lit("2007-01-01", "date"),
      type: uri(`${RT}REG`),
      title: { type: "literal", value: title },
    });
    const { queries } = stubNumberQueries({
      exact: sparql([
        {
          celex: lit("32006R1998"),
          date: lit("2006-12-15", "date"),
          type: uri(`${RT}REG`),
          titleNl: { type: "literal", value: "Verordening (EG) nr. 1998/2006 van de Commissie betreffende de-minimissteun" },
        },
      ]),
      titles: sparql([
        titleRow("32006R1998", "Verordening (EG) nr. 1998/2006 van de Commissie betreffende de-minimissteun"),
        titleRow("32007R0875", "Verordening (EG) nr. 875/2007 tot wijziging van Verordening (EG) nr. 1998/2006"),
      ]),
    });

    const out = await new EuCellarSource(testConfig).search({ query: "Verordening (EG) 1998/2006", limit: 20 });

    // Not 31998R2006, which is Verordening (EG) nr. 2006/98.
    expect(queries.find((q) => q.includes("VALUES ?celex"))).toContain('VALUES ?celex { "32006R1998"^^xsd:string }');
    expect(out.items.map((i) => [i.celex, i.match])).toEqual([
      ["32006R1998", "document_number"],
      ["32007R0875", "title"],
    ]);
    expect(out.params).toMatchObject({ document_number: "1998/2006", celex: "32006R1998" });
    expect(out.access_note).toContain("eerst de handeling zelf (CELEX 32006R1998; match: document_number)");
  });

  it("shows both acts when a regulation number fits both citation styles, and says how to pick one", async () => {
    const exactRow = (celex: string, date: string) => ({ celex: lit(celex), date: lit(date, "date"), type: uri(`${RT}REG`) });
    // Rows in CELLAR's order; the result follows the candidate order (newer style first).
    const { queries } = stubNumberQueries({
      exact: sparql([exactRow("31999R2018", "1999-09-21"), exactRow("32018R1999", "2018-12-11")]),
      titles: sparql([]),
    });

    const out = await new EuCellarSource(testConfig).search({ query: "Verordening 2018/1999", limit: 20 });

    expect(queries.find((q) => q.includes("VALUES ?celex"))).toContain('VALUES ?celex { "32018R1999"^^xsd:string "31999R2018"^^xsd:string }');
    expect(out.items.map((i) => [i.celex, i.match])).toEqual([
      ["32018R1999", "document_number"],
      ["31999R2018", "document_number"],
    ]);
    expect(out.access_note).toContain("eerst de 2 handelingen met dat nummer (een verordening van vóór 2015 wordt geciteerd als nummer/jaar");
    expect(out.access_note).toContain("met '(EU)' of '(EG) nr.' erbij wordt alleen die lezing gezocht; zie date)");
    expect(out.access_note).not.toContain("richtlijn en besluit hetzelfde nummer");

    queries.length = 0;
    await new EuCellarSource(testConfig).search({ query: "Verordening (EU) 2018/1999", limit: 20 });
    expect(queries.find((q) => q.includes("VALUES ?celex"))).toContain('VALUES ?celex { "32018R1999"^^xsd:string }');
  });

  it("shows no exact match when the type word contradicts the type filter, and says so (review: 'Richtlijn 2006/123/EG' with type REG)", async () => {
    const { queries } = stubNumberQueries({
      // Would be Verordening (EG) nr. 123/2006, a different act; it must not be looked up.
      exact: sparql([{ celex: lit("32006R0123"), date: lit("2006-01-24", "date"), type: uri(`${RT}REG`) }]),
      titles: sparql([
        titleRow("32009R0952", "2009-10-07", "Verordening (EG) nr. 952/2009 ter uitvoering van Richtlijn 2006/123/EG betreffende diensten op de interne markt"),
      ]),
    });

    const out = await new EuCellarSource(testConfig).search({ query: "Richtlijn 2006/123/EG", type: "REG", limit: 10 });

    expect(queries.some((q) => q.includes("VALUES ?celex"))).toBe(false);
    expect(queries.find((q) => q.includes("bif:contains"))).toContain("resource-type/REG>");
    expect(out.items.map((i) => [i.celex, i.match])).toEqual([["32009R0952", "title"]]);
    expect(out.params).toMatchObject({ document_number: "2006/123", celex: "32006L0123", type: "REG" });
    expect(out.access_note).toContain(
      "documentnummer 2006/123 van een richtlijn (CELEX 32006L0123), maar type=REG zoekt alleen verordeningen: daarom geen exacte match",
    );
    expect(out.access_note).toContain("Wel getoond: verordeningen die 2006/123 in hun Nederlandse titel noemen");
    expect(out.access_note).not.toContain("de handeling zelf");

    stubNumberQueries({ exact: sparql([]), titles: sparql([]) });
    const none = await new EuCellarSource(testConfig).search({ query: "Richtlijn 95/46/EG", type: "REG", limit: 10 });
    expect(none.items).toEqual([]);
    expect(none.access_note).toContain("Ook geen verordeningen die 95/46 in hun titel noemen.");
  });

  it("does not count a longer identifier that ends in the pair as a citation (review: 'Besluit DRC/1/2003')", async () => {
    stubNumberQueries({
      exact: sparql([{ celex: lit("32003R0001"), date: lit("2002-12-16", "date"), type: uri(`${RT}REG`) }]),
      titles: sparql([
        titleRow("32004R0411", "2004-02-26", "Verordening (EG) nr. 411/2004 tot wijziging van Verordening (EG) nr. 1/2003"),
        titleRow("32003D0500", "2003-07-03", "2003/500/GBVB: Besluit DRC/1/2003 van het Politiek en Veiligheidscomité", "DEC"),
        titleRow("32003D0700", "2003-10-01", "Besluit nr. 1/2003/5 van het Gemengd Comité over de afvalinzameling", "DEC"),
      ]),
    });

    const out = await new EuCellarSource(testConfig).search({ query: "1/2003", limit: 10 });

    expect(out.items.map((i) => [i.celex, i.match])).toEqual([
      ["32003R0001", "document_number"],
      ["32004R0411", "title"],
    ]);
  });
});

describe("parseDocumentNumber", () => {
  it("recognises bare numbers and citations", () => {
    expect(parseDocumentNumber("2021/1119")).toEqual({
      letters: ["R", "L", "D"],
      celex: ["32021R1119", "32021L1119", "32021D1119"],
      citation: "2021/1119",
    });
    expect(parseDocumentNumber("Verordening (EU) 2021/1119")?.celex).toEqual(["32021R1119"]);
    expect(parseDocumentNumber("1119/2021")?.celex).toEqual(["32021R1119", "32021L1119", "32021D1119"]);
    expect(parseDocumentNumber("Richtlijn 95/46/EG")).toMatchObject({ celex: ["31995L0046"], citation: "95/46" });
    expect(parseDocumentNumber("Verordening (EG) nr. 1049/2001")).toMatchObject({ celex: ["32001R1049"], citation: "1049/2001" });
    expect(parseDocumentNumber("Uitvoeringsbesluit (EU) 2026/2221 van de Raad")?.celex).toEqual(["32026D2221"]);
    expect(parseDocumentNumber("2021/1119", "DEC")?.celex).toEqual(["32021D1119"]);
    expect(parseDocumentNumber("Verordening (EEG) nr. 1408/71")).toMatchObject({ celex: ["31971R1408"], citation: "1408/71" });
  });

  it("reads a short number before a four-digit year as number/year (reviewer cases)", () => {
    expect(parseDocumentNumber("66/2010")).toMatchObject({ citation: "66/2010" });
    expect(parseDocumentNumber("66/2010")?.celex).toEqual(["32010R0066", "32010L0066", "32010D0066"]);
    expect(parseDocumentNumber("10/2011")?.celex).toEqual(["32011R0010", "32011L0010", "32011D0010"]);
    expect(parseDocumentNumber("Verordening (EU) 10/2011")).toMatchObject({ celex: ["32011R0010"], citation: "10/2011" });
    expect(parseDocumentNumber("26/2010")?.celex[0]).toBe("32010R0026");
    expect(parseDocumentNumber("12/2003")?.celex[0]).toBe("32003R0012");
    expect(parseDocumentNumber("1/2003")?.celex[0]).toBe("32003R0001");
    expect(parseDocumentNumber("Verordening (EG) nr. 2004/2003")).toMatchObject({ celex: ["32003R2004"] });
  });

  it("reads each type's own citation style: a regulation pair is year/number only from 2015 on (re-review)", () => {
    // The reviewer's cases: the de-minimis, SIS II and CPC regulations, not the 1987/1998/2006 acts numbered 2006/2004.
    expect(parseDocumentNumber("Verordening (EG) 1998/2006")).toEqual({ letters: ["R"], celex: ["32006R1998"], citation: "1998/2006" });
    expect(parseDocumentNumber("Verordening (EG) 1987/2006")?.celex).toEqual(["32006R1987"]);
    expect(parseDocumentNumber("Verordening (EG) 2006/2004")?.celex).toEqual(["32004R2006"]);
    expect(parseDocumentNumber("1998/2006", "REG")?.celex).toEqual(["32006R1998"]);
    // A bare pair: the regulation reading is number/year, directives and decisions year/number.
    expect(parseDocumentNumber("1987/2006")).toEqual({
      letters: ["R", "L", "D"],
      celex: ["32006R1987", "31987L2006", "31987D2006"],
      citation: "1987/2006",
    });
    expect(parseDocumentNumber("2003/2004")?.celex).toEqual(["32004R2003", "32003L2004", "32003D2004"]);
    // From 2015 on, unchanged.
    expect(parseDocumentNumber("Verordening (EU) 2016/679")?.celex).toEqual(["32016R0679"]);
    expect(parseDocumentNumber("Verordening (EU) 2019/2088")?.celex).toEqual(["32019R2088"]);
    expect(parseDocumentNumber("2019/2088")?.celex).toEqual(["32019R2088", "32019L2088", "32019D2088"]);
    expect(parseDocumentNumber("1119/2021")?.celex).toEqual(["32021R1119", "32021L1119", "32021D1119"]);
  });

  it("returns both readings of a regulation pair that fits both styles, unless the citation picks one", () => {
    // (EU) 2018/1999 and (EG) nr. 2018/1999 both exist.
    expect(parseDocumentNumber("Verordening 2018/1999")).toEqual({
      letters: ["R"],
      celex: ["32018R1999", "31999R2018"],
      citation: "2018/1999",
    });
    expect(parseDocumentNumber("2016/94")?.celex).toEqual(["32016R0094", "31994R2016", "32016L0094", "32016D0094"]);
    expect(parseDocumentNumber("Verordening (EU) 2018/1999")?.celex).toEqual(["32018R1999"]);
    expect(parseDocumentNumber("Verordening (EG) 2018/1999")?.celex).toEqual(["31999R2018"]);
    expect(parseDocumentNumber("Verordening (EG) nr. 2018/1999")?.celex).toEqual(["31999R2018"]);
    expect(parseDocumentNumber("Regulation (EC) No 2018/1999")?.celex).toEqual(["31999R2018"]);
  });

  it("reads a regulation pair the other way round only when nothing else fits", () => {
    // Regulation (EC) No 46/95 is cited '46/95'; a bare '95/46' is the directive or decision of 1995.
    expect(parseDocumentNumber("46/95")).toEqual({ letters: ["R"], celex: ["31995R0046"], citation: "46/95" });
    expect(parseDocumentNumber("95/46")?.celex).toEqual(["31995L0046", "31995D0046"]);
    // Named as a regulation, the pair can only mean (EG) nr. 1049/2001.
    expect(parseDocumentNumber("Verordening 2001/1049")?.celex).toEqual(["32001R1049"]);
    expect(parseDocumentNumber("2001/1049")?.celex).toEqual(["32001L1049", "32001D1049"]);
  });

  it("takes the marker right before or right after the pair (re-review 3)", () => {
    expect(parseDocumentNumber("(EG) 2018/1999")?.celex[0]).toBe("31999R2018");
    expect(parseDocumentNumber("2018/1999 (EG)")?.celex[0]).toBe("31999R2018");
    expect(parseDocumentNumber("EG-verordening 2018/1999")?.celex).toEqual(["31999R2018"]);
    expect(parseDocumentNumber("Verordening (EU) 2018/1999 van het Europees Parlement en de Raad")?.celex).toEqual(["32018R1999"]);
  });

  it("reads a type word that contradicts the type filter as written, and flags the conflict", () => {
    expect(parseDocumentNumber("Richtlijn 2006/123/EG", "REG")).toEqual({
      letters: ["L"],
      celex: ["32006L0123"],
      citation: "2006/123",
      conflictsWithType: true,
    });
    expect(parseDocumentNumber("Richtlijn 95/46/EG", "REG")).toMatchObject({ celex: ["31995L0046"], conflictsWithType: true });
    expect(parseDocumentNumber("Verordening (EU) 2016/679", "DEC")).toMatchObject({ celex: ["32016R0679"], conflictsWithType: true });
    // No conflict without a type word, or when word and filter agree.
    expect(parseDocumentNumber("2006/123", "REG")).not.toHaveProperty("conflictsWithType");
    expect(parseDocumentNumber("Uitvoeringsverordening (EU) 2020/2003", "REG")).not.toHaveProperty("conflictsWithType");
    expect(parseDocumentNumber("Beschikking 2006/123", "DEC")).not.toHaveProperty("conflictsWithType");
  });

  it("returns null for anything that is not just a document number", () => {
    expect(parseDocumentNumber("VK")).toBeNull();
    expect(parseDocumentNumber("VK 2021/1119")).toBeNull();
    expect(parseDocumentNumber("2016/679 en 2016/680")).toBeNull();
    expect(parseDocumentNumber("13/06/2024")).toBeNull();
    expect(parseDocumentNumber("12/46")).toBeNull();
    expect(parseDocumentNumber("1119/1234")).toBeNull();
    expect(parseDocumentNumber("")).toBeNull();
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
