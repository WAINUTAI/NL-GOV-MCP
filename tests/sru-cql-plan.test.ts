import { beforeEach, describe, expect, it, vi } from "vitest";
import { KoopCollectieSource } from "../src/sources/koop-collecties.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { compoundSearchParts, freeTextCql, freeTextCqlPlan, freeTextCqlTerms } from "../src/utils/sru-cql.js";
import { testConfig, xmlResponse } from "./helpers/config.js";

const planCql = (input: string | undefined, options?: { expandCompounds?: boolean }) => freeTextCqlPlan(input, options).cql;

describe("freeTextCqlPlan — function words", () => {
  it("does not make Dutch stopwords required terms", () => {
    const plan = freeTextCqlPlan("fietspaden en OV");
    expect(plan.cql).toBe("fietspaden AND OV");
    expect(plan.droppedStopwords).toEqual(["en"]);
    expect(planCql("beleid voor de inzet van BOA")).toBe("beleid AND inzet AND BOA");
  });

  it("keeps the stopwords when they are all there is", () => {
    expect(planCql("de")).toBe("de");
    expect(planCql("de het")).toBe("de AND het");
    expect(freeTextCqlPlan("de het").droppedStopwords).toEqual([]);
  });

  it("keeps words that double as abbreviations or place-name parts", () => {
    expect(planCql("om vervolging")).toBe("om AND vervolging");
    expect(planCql("als onderzoek")).toBe("als AND onderzoek");
    expect(planCql("Den Helder")).toBe("Den AND Helder");
  });

  it("leaves the raw tokenisation of freeTextCqlTerms alone", () => {
    expect(freeTextCqlTerms("a bc - de")).toEqual(["bc", "de"]);
    expect(freeTextCqlTerms("fietspaden en OV")).toEqual(["fietspaden", "en", "OV"]);
  });
});

describe("freeTextCqlPlan — hyphenated compounds", () => {
  it("matches a compound as the exact term or its parts", () => {
    const plan = freeTextCqlPlan("OV-visie");
    expect(plan.cql).toBe('("OV-visie" OR (OV AND visie))');
    expect(plan.expandedCompounds).toEqual(["OV-visie"]);
    expect(planCql("gemeentelijk GGZ-beleid")).toBe('gemeentelijk AND ("GGZ-beleid" OR (GGZ AND beleid))');
  });

  it("drops function words from the parts", () => {
    expect(planCql("Bergen-op-Zoom")).toBe('("Bergen-op-Zoom" OR (Bergen AND Zoom))');
    expect(compoundSearchParts("zorg-en-welzijn")).toEqual(["zorg", "welzijn"]);
    expect(compoundSearchParts("e-mail")).toBeUndefined();
  });

  it("keeps compounds exact when expansion is off (date-sorted searches)", () => {
    const plan = freeTextCqlPlan("OV-visie gemeente", { expandCompounds: false });
    expect(plan.cql).toBe("OV-visie AND gemeente");
    expect(plan.exactCompounds).toEqual(["OV-visie"]);
    expect(plan.expandedCompounds).toEqual([]);
  });

  it("does not split one-letter parts, numbers or elided articles", () => {
    expect(planCql("e-mail")).toBe("e-mail");
    expect(planCql("COVID-19")).toBe("COVID-19");
    expect(planCql("'s-Gravenhage")).toBe("'s-Gravenhage");
    expect(freeTextCqlPlan("e-mail COVID-19").expandedCompounds).toEqual([]);
  });

  it("treats leading and trailing hyphens as punctuation", () => {
    expect(planCql("-zorg welzijn-")).toBe("zorg AND welzijn");
  });
});

describe("freeTextCqlPlan — quotes, apostrophes and CQL syntax", () => {
  it("searches a quoted multi-word string as a phrase", () => {
    const plan = freeTextCqlPlan('"zorg en veiligheid" Utrecht');
    expect(plan.cql).toBe('"zorg en veiligheid" AND Utrecht');
    expect(plan.phrases).toEqual(["zorg en veiligheid"]);
    expect(planCql('"zorg en welzijn", subsidie')).toBe('"zorg en welzijn" AND subsidie');
  });

  it("keeps a quoted compound exact and unwraps a quoted single word", () => {
    expect(planCql('"OV-visie"')).toBe('"OV-visie"');
    expect(planCql('"fiets" register')).toBe("fiets AND register");
  });

  it("escapes and cleans phrase content", () => {
    expect(planCql('"x\\y {z} w"')).toBe('"xy z w"');
  });

  it("strips stray quotes instead of opening a phrase (injection stays inert)", () => {
    expect(planCql('zorg" OR dt.creator=="x')).toBe("zorg AND dt.creatorx");
    expect(freeTextCqlTerms('zorg" OR dt.creator=="x')).toEqual(["zorg", "dt.creatorx"]);
  });

  it("keeps apostrophes inside words and in 's-/'t- names, drops quotation apostrophes", () => {
    expect(planCql("auto's")).toBe("auto's");
    expect(planCql("'woord'")).toBe("woord");
    expect(planCql("‘s-Hertogenbosch")).toBe("'s-Hertogenbosch");
    expect(planCql("'s Gravenhage")).toBe("Gravenhage");
  });

  it("strips characters the upstream parser chokes on", () => {
    // { } answer HTTP 500 upstream; * and ? are masking characters.
    expect(planCql("{x} zorg")).toBe("zorg");
    expect(planCql("parkeer* vraag?")).toBe("parkeer AND vraag");
    expect(planCql("[a]|b ~cd ^ef")).toBe("ab AND cd AND ef");
  });

  it("keeps citations and case numbers with a slash as an exact phrase", () => {
    // Stripped of its slash, a citation became one long number that matches nothing.
    const plan = freeTextCqlPlan("Verordening 2016/679");
    expect(plan.cql).toBe('"2016/679" AND Verordening');
    expect(plan.phrases).toEqual(["2016/679"]);
    expect(planCql("zaak C2023/2052,")).toBe('"C2023/2052" AND zaak');
    expect(planCql('"artikel 2016/679" OV')).toBe('"artikel 2016/679" AND OV');
  });

  it("treats en/of as a conjunction, not a citation", () => {
    const plan = freeTextCqlPlan("subsidie en/of lening");
    expect(plan.cql).toBe("subsidie AND lening");
    expect(plan.droppedStopwords).toEqual(["en/of"]);
  });

  it("keeps en/of when it is all there is, instead of searching everything", () => {
    const plan = freeTextCqlPlan("en/of");
    expect(plan.cql).toBe('"en/of"');
    expect(plan.droppedStopwords).toEqual([]);
    expect(planCql("de en/of")).toBe("de");
  });

  it("leaves out a CQL sort clause typed into the free text, and reports it", () => {
    const plan = freeTextCqlPlan("parkeerbeleid sortBy dt.date");
    expect(plan.cql).toBe("parkeerbeleid");
    expect(plan.droppedSyntax).toEqual(["sortBy dt.date"]);
    expect(planCql("afvalinzameling sortby dt.date/sort.descending")).toBe("afvalinzameling");
    // "sortBy" without an index after it is just a dropped keyword.
    expect(planCql("woningbouw sortBy datum")).toBe("woningbouw AND datum");
  });

  it("splits words joined by an inner +, which the server rejects as a bare term", () => {
    expect(planCql("parkeren+wonen")).toBe("parkeren AND wonen");
    expect(planCql("zorg 1+1")).toBe("zorg");
    // A trailing + parses fine and stays.
    expect(planCql("woningbouw 65+")).toBe("woningbouw AND 65+");
  });

  it("requires a repeated word once", () => {
    expect(planCql("zorg Zorg zorg-")).toBe("zorg");
  });

  it("returns undefined for empty input", () => {
    expect(planCql(undefined)).toBeUndefined();
    expect(planCql('"" ?')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  koop-collecties shares freeTextCql: unchanged or improved only    */
/* ------------------------------------------------------------------ */

const EMPTY_SRU = `<?xml version="1.0" encoding="UTF-8"?>
<sru:searchRetrieveResponse xmlns:sru="http://docs.oasis-open.org/ns/search-ws/sruResponse">
  <sru:version>2.0</sru:version><sru:numberOfRecords>0</sru:numberOfRecords><sru:records></sru:records>
</sru:searchRetrieveResponse>`;

describe("freeTextCql stays the plain AND-join koop-collecties has always sent", () => {
  it("does not apply the planner's stopword, compound, phrase or citation handling", () => {
    expect(freeTextCql("zorg en veiligheid")).toBe("zorg AND en AND veiligheid");
    expect(freeTextCql("Wmo-voorziening")).toBe("Wmo-voorziening");
    expect(freeTextCql('"onjuiste diagnose"')).toBe("onjuiste AND diagnose");
    expect(freeTextCql("C2023/2052")).toBe("C20232052");
    expect(freeTextCql("'s-Gravenhage auto's")).toBe("s-Gravenhage AND autos");
    expect(freeTextCql("zorg sortBy dt.date")).toBe("zorg AND sortBy AND dt.date");
  });

  it("only changes an inner +, which used to make the server reject the whole query", () => {
    // Live (October 2026): `... AND zorg AND 1+1` gives diagnostic "mismatched input '<EOF>'".
    expect(freeTextCql("parkeren+wonen")).toBe("parkeren AND wonen");
    expect(freeTextCql("zorg 1+1")).toBe("zorg");
    expect(freeTextCql("woningbouw 65+")).toBe("woningbouw AND 65+");
  });

  it("gives exactly what the f875a21 implementation gave", () => {
    // Verbatim copy of freeTextCql before the planner existed.
    const legacy = (input: string | undefined) => {
      const raw = (input ?? "").trim();
      if (!raw) return undefined;
      const terms = raw
        .split(/\s+/)
        .map((token) => token.replace(/["'()<>=/\\]/g, "").trim())
        .filter((token) => token.length > 1 && /[\p{L}\p{N}]/u.test(token))
        .filter((token) => !["and", "or", "not", "prox"].includes(token.toLowerCase()));
      return terms.length ? terms.join(" AND ") : undefined;
    };
    const inputs = [
      undefined, "", "   ", "medicatiefout huisarts", "zorg en veiligheid", "BIG-register", "Wmo-voorziening",
      '"onjuiste diagnose"', "C2023/2052", "'s-Gravenhage", "auto's", "{x} zorg", "parkeer* vraag?", "[a]|b ~cd ^ef",
      'zorg" OR dt.creator=="x', "a bc - de", "zorg AND veiligheid", "-zorg welzijn-", "e-mail COVID-19", "zorg sortBy dt.date",
      "Den Helder", "de het", "subsidie en/of lening", '"x\\y {z} w"', "zorg Zorg zorg-",
    ];
    for (const input of inputs) expect(freeTextCql(input)).toBe(legacy(input));
  });
});

describe("koop-collecties queries are unchanged by the planner", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  async function cqlFor(collection: "tuchtrecht" | "samenwerkendecatalogi", query: string, organisatie?: string) {
    const fetchMock = vi.fn(async () => xmlResponse(EMPTY_SRU));
    vi.stubGlobal("fetch", fetchMock);
    await new KoopCollectieSource(testConfig, collection).search({ query, organisatie, maximumRecords: 5 });
    const url = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    return url.searchParams.get("query");
  }

  it("sends single words and plain multi-word queries exactly as before", async () => {
    expect(await cqlFor("tuchtrecht", "medicatiefout")).toBe("c.product-area==tuchtrecht AND medicatiefout");
    expect(await cqlFor("tuchtrecht", "tuchtklachten huisarts")).toBe("c.product-area==tuchtrecht AND tuchtklachten AND huisarts");
    expect(await cqlFor("samenwerkendecatalogi", "paspoort")).toBe("c.product-area==samenwerkendecatalogi AND paspoort");
    expect(await cqlFor("tuchtrecht", "huisarts", 'Centraal "Tucht" College')).toBe(
      'c.product-area==tuchtrecht AND huisarts AND dt.creator=="Centraal \\"Tucht\\" College"',
    );
  });

  it("keeps stopwords, compounds, quotes and slashes as the plain AND-join had them", async () => {
    expect(await cqlFor("samenwerkendecatalogi", "zorg en veiligheid")).toBe(
      "c.product-area==samenwerkendecatalogi AND zorg AND en AND veiligheid",
    );
    expect(await cqlFor("samenwerkendecatalogi", "Wmo-voorziening")).toBe("c.product-area==samenwerkendecatalogi AND Wmo-voorziening");
    expect(await cqlFor("tuchtrecht", "BIG-register")).toBe("c.product-area==tuchtrecht AND BIG-register");
    expect(await cqlFor("tuchtrecht", '"onjuiste diagnose"')).toBe("c.product-area==tuchtrecht AND onjuiste AND diagnose");
    expect(await cqlFor("tuchtrecht", "C2023/2052")).toBe("c.product-area==tuchtrecht AND C20232052");
  });
});
