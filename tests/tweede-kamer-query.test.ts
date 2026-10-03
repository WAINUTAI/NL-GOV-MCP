import { describe, expect, it } from "vitest";
import {
  buildTextFilter,
  estimateODataNodes,
  parseTkQuery,
  resolveTkEntity,
  shortTermPatternCap,
  tkDayRange,
  tkDownloadUrl,
  tkKamerstukUrl,
  tkRecordView,
  tkSubjectTitle,
  TweedeKamerInputError,
  TweedeKamerSource,
} from "../src/sources/tweede-kamer.js";
import { testConfig } from "./helpers/config.js";

const API = testConfig.endpoints.tweedeKamer;
const tk = new TweedeKamerSource(testConfig);

describe("parseTkQuery", () => {
  it("splits keywords into AND-terms and keeps their order", () => {
    expect(parseTkQuery("Harderwijk afvalinzameling").terms).toEqual([
      { text: "Harderwijk", mode: "substring" },
      { text: "afvalinzameling", mode: "substring" },
    ]);
  });

  it("treats terms of up to three characters as whole words", () => {
    expect(parseTkQuery("Uitkeringen WW").terms).toEqual([
      { text: "Uitkeringen", mode: "substring" },
      { text: "WW", mode: "word" },
    ]);
    expect(parseTkQuery("ICT").terms).toEqual([{ text: "ICT", mode: "word" }]);
  });

  it("keeps quoted phrases together as whole-word phrases", () => {
    expect(parseTkQuery('"sociale advocatuur" justitie').terms).toEqual([
      { text: "sociale advocatuur", mode: "word" },
      { text: "justitie", mode: "substring" },
    ]);
    // Curly quotes as typed by word processors.
    expect(parseTkQuery("“Partij voor de Dieren”").terms).toEqual([{ text: "Partij voor de Dieren", mode: "word" }]);
  });

  it("drops stopwords but reports them, unless nothing else is left", () => {
    const parsed = parseTkQuery("motie over de stikstof");
    expect(parsed.terms.map((t) => t.text)).toEqual(["motie", "stikstof"]);
    expect(parsed.ignored).toEqual(["over", "de"]);
    expect(parseTkQuery("de het").terms.map((t) => t.text)).toEqual(["de", "het"]);
  });

  it("drops recency, meta and request words the query rewriter used to strip", () => {
    const nieuwste = parseTkQuery("nieuwste stikstof?");
    expect(nieuwste.terms).toEqual([{ text: "stikstof", mode: "substring" }]);
    expect(nieuwste.ignored).toEqual(["nieuwste"]);
    expect(parseTkQuery("laatste stikstof").terms.map((t) => t.text)).toEqual(["stikstof"]);
    expect(parseTkQuery("de meest recente moties over de wolf").terms.map((t) => t.text)).toEqual(["moties", "wolf"]);
    expect(parseTkQuery("informatie over woningbouw").terms.map((t) => t.text)).toEqual(["woningbouw"]);
    expect(parseTkQuery("geef mij een overzicht van de latest WW documenten").terms.map((t) => t.text)).toEqual(["WW", "documenten"]);
    // Quoted text is taken literally.
    expect(parseTkQuery('"laatste termijn"').terms).toEqual([{ text: "laatste termijn", mode: "word" }]);
    // "open data" stays a topic.
    expect(parseTkQuery("open data").terms.map((t) => t.text)).toEqual(["open", "data"]);
  });

  it("drops question and request frames that used to become required terms", () => {
    // Each of these returned "0 van 0": "kun", "vertellen" and "ben" had to occur in the title.
    const kun = parseTkQuery("kun je mij vertellen over stikstof");
    expect(kun.terms).toEqual([{ text: "stikstof", mode: "substring" }]);
    expect(kun.ignored).toEqual(["kun", "je", "mij", "vertellen", "over"]);
    const zoek = parseTkQuery("ik ben op zoek naar stikstof");
    expect(zoek.terms).toEqual([{ text: "stikstof", mode: "substring" }]);
    expect(zoek.ignored).toEqual(["ik", "ben", "op", "zoek", "naar"]);
    expect(parseTkQuery("Kun je me vertellen over woningbouw?").terms.map((t) => t.text)).toEqual(["woningbouw"]);
    expect(parseTkQuery("kunt u mij laten zien welke moties er zijn over de wolf").terms.map((t) => t.text)).toEqual(["moties", "wolf"]);
    expect(parseTkQuery("wat is er bekend over zwerfafval").terms.map((t) => t.text)).toEqual(["zwerfafval"]);
    expect(parseTkQuery("ik wil graag meer weten over de AOW").terms).toEqual([{ text: "AOW", mode: "word" }]);
    expect(parseTkQuery("can you tell me about nitrogen").terms.map((t) => t.text)).toEqual(["nitrogen"]);
  });

  it("drops the informal frames and meta words the moderate rewriter stripped", () => {
    // "jij" became a whole-word term that no title contains: "0 van 0".
    const jij = parseTkQuery("kun jij mij vertellen over parkeerbeleid");
    expect(jij.terms).toEqual([{ text: "parkeerbeleid", mode: "substring" }]);
    expect(jij.ignored).toEqual(["kun", "jij", "mij", "vertellen", "over"]);
    expect(parseTkQuery("kan jij me vertellen over woningbouw").terms.map((t) => t.text)).toEqual(["woningbouw"]);
    expect(parseTkQuery("kunnen jullie iets laten zien over afvalinzameling").terms.map((t) => t.text)).toEqual(["afvalinzameling"]);
    expect(parseTkQuery("weet jij iets over parkeerbeleid").terms.map((t) => t.text)).toEqual(["parkeerbeleid"]);
    // Meta words and "about" prepositions shrank the result to an arbitrary subset.
    expect(parseTkQuery("geef mij data over woningbouw").terms.map((t) => t.text)).toEqual(["woningbouw"]);
    expect(parseTkQuery("geef me gegevens betreffende woningbouw").terms.map((t) => t.text)).toEqual(["woningbouw"]);
    expect(parseTkQuery("geef informatie inzake afvalinzameling").terms.map((t) => t.text)).toEqual(["afvalinzameling"]);
    expect(parseTkQuery("pak eens de moties rondom parkeerbeleid").terms.map((t) => t.text)).toEqual(["moties", "parkeerbeleid"]);
    expect(parseTkQuery("datasets aangaande woningbouw").terms.map((t) => t.text)).toEqual(["woningbouw"]);
    // "vraag" only as part of the frame.
    const vraag = parseTkQuery("ik vraag informatie over afvalinzameling");
    expect(vraag.terms).toEqual([{ text: "afvalinzameling", mode: "substring" }]);
    expect(vraag.ignored).toEqual(["ik", "vraag", "informatie", "over"]);
    expect(parseTkQuery("ik vraag me af hoe het zit met parkeerbeleid").terms.map((t) => t.text)).toEqual(["parkeerbeleid"]);
    expect(parseTkQuery("ik heb een vraag over woningbouw").terms.map((t) => t.text)).toEqual(["woningbouw"]);
    expect(parseTkQuery("vraag en aanbod woningbouw").terms.map((t) => t.text)).toEqual(["vraag", "aanbod", "woningbouw"]);
    // "data" stays when it is the topic.
    expect(parseTkQuery("open data over gemeenten").terms.map((t) => t.text)).toEqual(["open", "data", "gemeenten"]);
    expect(parseTkQuery("data deling").terms.map((t) => t.text)).toEqual(["data", "deling"]);
    expect(parseTkQuery("data").terms.map((t) => t.text)).toEqual(["data"]);
    // Nothing after it: "data" is what is asked about, not "geef" and "mij".
    expect(parseTkQuery("geef mij data").terms.map((t) => t.text)).toEqual(["data"]);
    expect(parseTkQuery("toon de datasets over").terms.map((t) => t.text)).toEqual(["datasets"]);
  });

  it("drops connector phrases as a whole, not their words on their own", () => {
    const mbt = parseTkQuery("moties met betrekking tot de wolf");
    expect(mbt.terms.map((t) => t.text)).toEqual(["moties", "wolf"]);
    expect(mbt.ignored).toEqual(["met", "betrekking", "tot", "de"]);
    expect(parseTkQuery("beleid op het gebied van cybersecurity").terms.map((t) => t.text)).toEqual(["beleid", "cybersecurity"]);
    expect(parseTkQuery("inzet ten aanzien van Oekraïne").terms.map((t) => t.text)).toEqual(["inzet", "Oekraïne"]);
    // "gebied" and "relatie" can be the topic.
    expect(parseTkQuery("Natura 2000 gebied").terms.map((t) => t.text)).toContain("gebied");
    expect(parseTkQuery("relatie China").terms.map((t) => t.text)).toEqual(["relatie", "China"]);
    // A query that is only such a phrase is still searched.
    expect(parseTkQuery("met betrekking tot").terms.map((t) => t.text)).toEqual(["betrekking"]);
    // Quoted text is taken literally.
    expect(parseTkQuery('"met betrekking tot"').terms).toEqual([{ text: "met betrekking tot", mode: "word" }]);
  });

  it("keeps a capitalised acronym that equals a stopword, unless the whole query is capitals", () => {
    expect(parseTkQuery("OM zedenzaken").terms).toEqual([
      { text: "OM", mode: "word" },
      { text: "zedenzaken", mode: "substring" },
    ]);
    expect(parseTkQuery("om zedenzaken").terms.map((t) => t.text)).toEqual(["zedenzaken"]);
    expect(parseTkQuery("WW EN ZORG").terms.map((t) => t.text)).toEqual(["WW", "ZORG"]);
  });

  it("strips surrounding punctuation but keeps inner hyphens and dots", () => {
    expect(parseTkQuery("(WW-uitkering), 2.0?").terms.map((t) => t.text)).toEqual(["WW-uitkering", "2.0"]);
    expect(parseTkQuery("'s-Hertogenbosch").terms.map((t) => t.text)).toEqual(["s-Hertogenbosch"]);
  });

  it("returns no terms for empty or punctuation-only input and dedupes", () => {
    expect(parseTkQuery(undefined).terms).toEqual([]);
    expect(parseTkQuery("   ").terms).toEqual([]);
    expect(parseTkQuery("???").terms).toEqual([]);
    expect(parseTkQuery("WW ww Ww").terms).toEqual([{ text: "WW", mode: "word" }]);
  });
});

describe("buildTextFilter", () => {
  const fields = ["Titel", "Onderwerp"];

  it("ANDs one contains() group per term instead of one literal substring", () => {
    const out = buildTextFilter(parseTkQuery("Harderwijk afvalinzameling").terms, fields, 0);
    expect(out.part?.expr).toBe(
      "((contains(Titel,'afvalinzameling') or contains(Onderwerp,'afvalinzameling'))) and ((contains(Titel,'Harderwijk') or contains(Onderwerp,'Harderwijk')))",
    );
    expect(out.applied.map((t) => t.text)).toEqual(["Harderwijk", "afvalinzameling"]);
  });

  it("matches a short term only on word boundaries, after a cheap contains() prefilter", () => {
    const expr = buildTextFilter([{ text: "WW", mode: "word" }], fields, 0, undefined, { capShortTerms: false }).part!.expr;
    expect(expr.startsWith("(contains(Titel,'WW') or contains(Onderwerp,'WW')) and (")).toBe(true);
    // Space-padded field: " WW " anywhere, at the start or end, or as the whole value.
    expect(expr).toContain("contains(concat(concat(' ',Titel),' '),' WW ')");
    expect(expr).toContain("contains(concat(' ',Onderwerp),' WW-')");
    expect(expr).toContain("contains(Onderwerp,'(WW)')");
    expect(expr).toContain("contains(concat(Titel,' '),'/WW ')");
    // No bare substring match of the short term outside the prefilter.
    const boundary = expr.slice(expr.indexOf(") and (") + 7);
    expect(boundary).not.toMatch(/contains\((Titel|Onderwerp),'WW'\)/);
  });

  it("sizes the spellings of a short term by how many rows contain its letters, not by its length", () => {
    // Every spelling is one more check of each row that contains the letters at all.
    // "ING" is three letters but in 383,504 of 715,462 Documents (every "-ing" word).
    const ing = buildTextFilter([{ text: "ING", mode: "word" }], fields, 0, undefined, { candidateRows: 383_504 });
    for (const f of ["Titel", "Onderwerp"]) {
      expect(ing.part!.expr).toContain(`contains(concat(concat(' ',${f}),' '),' ING ')`);
      expect(ing.part!.expr).toContain(`contains(concat(' ',${f}),' ING-')`);
    }
    expect(ing.part!.expr).not.toContain("'(ING)'");
    expect(ing.wordPatterns).toEqual([{ text: "ING", patterns: 2, limit: "speed" }]);

    // "OM" in 149,906 rows: room for "(OM)" as well.
    const om = buildTextFilter([{ text: "OM", mode: "word" }], fields, 0, undefined, { candidateRows: 149_906 });
    expect(om.part!.expr).toContain("'(OM)'");
    expect(om.part!.expr).not.toContain("'/OM '");
    expect(om.wordPatterns).toEqual([{ text: "OM", patterns: 3, limit: "speed" }]);

    // "EU" (94,007 rows): five spellings, including "/EU", 8% of its hits.
    const eu = buildTextFilter([{ text: "EU", mode: "word" }], fields, 0, undefined, { candidateRows: 94_007 });
    expect(eu.part!.expr).toContain("'/EU '");
    expect(eu.wordPatterns).toEqual([{ text: "EU", patterns: 5, limit: "speed" }]);

    // Rare letters ("ICT": 4,951 rows): as many spellings as the node budget allows.
    const ict = buildTextFilter([{ text: "ICT", mode: "word" }], fields, 0, undefined, { candidateRows: 4_951 });
    expect(ict.part!.expr).toContain("' ICT,'");
    expect(ict.wordPatterns![0].patterns).toBeGreaterThanOrEqual(6);
    expect(ict.wordPatterns![0].limit).toBe("nodes");

    // Not counted (dryRun, or a count the service refused): " t ", " t-" and "(t)".
    const uncounted = buildTextFilter([{ text: "ICT", mode: "word" }], fields, 0);
    expect(uncounted.part!.expr).toContain("'(ICT)'");
    expect(uncounted.part!.expr).not.toContain("'/ICT '");
    expect(uncounted.wordPatterns).toEqual([{ text: "ICT", patterns: 3, limit: "speed" }]);

    // Small entities are not capped at all.
    const free = buildTextFilter([{ text: "OV", mode: "word" }], fields, 0, undefined, { capShortTerms: false });
    expect(free.part!.expr).toContain("' OV,'");
    expect(free.wordPatterns![0].limit).toBe("nodes");

    // Long terms and quoted phrases are rare runs of letters: never capped for speed.
    const phrase = buildTextFilter([{ text: "openbaar vervoer", mode: "word" }], fields, 0, undefined, { candidateRows: 500_000 });
    expect(phrase.wordPatterns![0].limit).not.toBe("speed");
  });

  it("shares the check budget between short terms and uses the larger one for votes", () => {
    // One million checks: rows × fields × spellings.
    expect(shortTermPatternCap(278_727, 2, 1)).toBe(2);
    expect(shortTermPatternCap(149_906, 2, 1)).toBe(3);
    expect(shortTermPatternCap(107_706, 2, 1)).toBe(4);
    expect(shortTermPatternCap(94_007, 2, 1)).toBe(5);
    expect(shortTermPatternCap(4_951, 2, 1)).toBe(10);
    // Never below the two most frequent spellings.
    expect(shortTermPatternCap(715_462, 2, 1)).toBe(2);
    // Two short terms split the budget.
    expect(shortTermPatternCap(33_960, 2, 2)).toBe(7);
    // No rows to check: nothing to save. Unknown: three spellings.
    expect(shortTermPatternCap(0, 2, 1)).toBe(10);
    expect(shortTermPatternCap(undefined, 2, 1)).toBe(3);
    // Votes: 961,512 rows for "ov" but each check costs about a sixth.
    expect(shortTermPatternCap(961_512, 2, 1, 6_000_000)).toBe(3);
  });

  it("always keeps the pattern that matches a field equal to the term, however tight the budget", () => {
    // Persoon has three fields; the old `eq` pattern was cut first and "Bos" found nobody.
    // Room for only the two-pattern minimum on three fields.
    const persoon = buildTextFilter([{ text: "Bos", mode: "word" }], ["Achternaam", "Roepnaam", "Functie"], 30);
    expect(persoon.patternsPerField).toBe(2);
    expect(persoon.part!.expr).toContain("contains(concat(concat(' ',Achternaam),' '),' Bos ')");
    expect(persoon.part!.expr).toContain("contains(concat(concat(' ',Roepnaam),' '),' Bos ')");
    expect(persoon.part!.expr).not.toContain("eq 'Bos'");
  });

  it("escapes quotes in terms", () => {
    const expr = buildTextFilter([{ text: "Hertog's", mode: "substring" }], fields, 0).part!.expr;
    expect(expr).toContain("contains(Titel,'Hertog''s')");
  });

  it("stays within the service's 100-node limit by shrinking patterns, then downgrading, then dropping", () => {
    // part.nodes is the exact service count (see tweede-kamer-nodes.test.ts).
    const two = buildTextFilter(parseTkQuery("WW EU").terms, fields, 0);
    expect(two.part!.nodes).toBeLessThanOrEqual(100);
    expect(two.downgraded).toEqual([]);

    const many = buildTextFilter(parseTkQuery("WW EU ICT VS").terms, fields, 0);
    expect(many.part!.nodes).toBeLessThanOrEqual(100);
    expect(many.downgraded.length).toBeGreaterThan(0);

    const huge = buildTextFilter(
      parseTkQuery("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima").terms,
      fields,
      20,
    );
    expect(huge.part!.nodes + 20).toBeLessThanOrEqual(100);
    expect(huge.dropped.length).toBeGreaterThan(0);
    expect(huge.applied.length + huge.dropped.length).toBe(12);
  });
});

describe("estimateODataNodes", () => {
  it("matches the service's counts for single constructs and counts a possible conversion per join", () => {
    expect(estimateODataNodes("contains(Titel,'x')")).toBe(4);
    expect(estimateODataNodes("Soort eq 'Motie'")).toBe(4);
    expect(estimateODataNodes("Datum ge 2024-01-01T00:00:00Z")).toBe(5);
    expect(estimateODataNodes("Vergissing eq false")).toBe(5);
    expect(estimateODataNodes("Besluit_Id eq 64db5eb1-4ad8-4ee1-88c5-9960d34d6423")).toBe(5);
    expect(estimateODataNodes("contains(Titel,'x') or contains(Onderwerp,'x')")).toBe(10);
    expect(estimateODataNodes("Besluit/Agendapunt/Activiteit/Datum ge 2026-07-02T00:00:00+02:00")).toBe(8);
    expect(estimateODataNodes(undefined)).toBe(0);
  });
});

describe("tkDayRange", () => {
  it("uses Dutch local midnights, also across DST changes", () => {
    expect(tkDayRange("2026-10-01", "2026-10-01")).toEqual({
      start: "2026-10-01T00:00:00+02:00",
      endExclusive: "2026-10-02T00:00:00+02:00",
    });
    expect(tkDayRange("2026-01-15")).toEqual({ start: "2026-01-15T00:00:00+01:00" });
    // DST starts 29 March 2026 (local midnight still +01:00), ends 25 October 2026.
    expect(tkDayRange("2026-03-29", "2026-03-28")).toEqual({
      start: "2026-03-29T00:00:00+01:00",
      endExclusive: "2026-03-29T00:00:00+01:00",
    });
    expect(tkDayRange(undefined, "2026-10-25")).toEqual({ endExclusive: "2026-10-26T00:00:00+01:00" });
    expect(tkDayRange(undefined, "2026-12-31")).toEqual({ endExclusive: "2027-01-01T00:00:00+01:00" });
  });

  it("leaves out open-end sentinels instead of building literals the service rejects", () => {
    // The day after 9999-12-31 is year 10000 ("+010000-01").
    expect(tkDayRange("2026-09-01", "9999-12-31")).toEqual({ start: "2026-09-01T00:00:00+02:00" });
    expect(tkDayRange(undefined, "9999-12-30")).toEqual({ endExclusive: "9999-12-31T00:00:00+01:00" });
    // 0001-01-01 with Amsterdam's old local-time offset is before the smallest DateTimeOffset.
    expect(tkDayRange("0001-01-01", "2026-09-30")).toEqual({ endExclusive: "2026-10-01T00:00:00+02:00" });
    // Nothing is dated before 1900: an earlier end still means "nothing".
    expect(tkDayRange(undefined, "1850-01-01")).toEqual({ endExclusive: "1900-01-01T00:00:00+01:00" });
  });
});

describe("links and titles", () => {
  it("builds the public kamerstuk page only with both numbers", () => {
    expect(tkKamerstukUrl("2026Z20929", "2026D48192")).toBe("https://www.tweedekamer.nl/kamerstukken/detail?id=2026Z20929&did=2026D48192");
    expect(tkKamerstukUrl("2026Z20929", undefined)).toBeUndefined();
    expect(tkDownloadUrl("2026D48293")).toBe("https://www.tweedekamer.nl/downloads/document?id=2026D48293");
    expect(tkDownloadUrl("")).toBeUndefined();
  });

  it("uses the subject instead of the shared dossier title", () => {
    expect(tkSubjectTitle({ Titel: "Belastingdienst", Onderwerp: "Lijst van vragen en antwoorden inzake Jaarrapportage Belastingdienst 2025" }))
      .toBe("Lijst van vragen en antwoorden inzake Jaarrapportage Belastingdienst 2025");
    expect(tkSubjectTitle({ Titel: "Natuurbeleid", Onderwerp: "Motie van het lid X over de wolf " })).toBe("Motie van het lid X over de wolf");
    expect(tkSubjectTitle({ Titel: "Regels over nucleaire waarborgen", Onderwerp: "Memorie van toelichting" }))
      .toBe("Memorie van toelichting – Regels over nucleaire waarborgen");
    expect(tkSubjectTitle({ Titel: null, Onderwerp: "Verzamelbrief luchtkwaliteit" })).toBe("Verzamelbrief luchtkwaliteit");
    expect(tkSubjectTitle({ Titel: "Alleen titel", Onderwerp: null })).toBe("Alleen titel");
    expect(tkSubjectTitle({ Id: "x-1" })).toBe("x-1");
  });

  it("gives every record a specific link, never the homepage", () => {
    const withPage = tkRecordView("Document", { Id: "d1", web_url: "https://www.tweedekamer.nl/kamerstukken/detail?id=Z&did=D" }, API);
    expect(withPage.url).toContain("/kamerstukken/detail?");
    const persoon = tkRecordView("Persoon", { Id: "p1", Roepnaam: "Jesse", Achternaam: "Klaver" }, API);
    expect(persoon).toMatchObject({ title: "Jesse Klaver", url: `${API}/Persoon(p1)` });
  });
});

describe("resolveTkEntity", () => {
  it("is case-insensitive and rejects unknown entities", () => {
    expect(resolveTkEntity("zaak")).toBe("Zaak");
    expect(resolveTkEntity(undefined)).toBe("Document");
    expect(resolveTkEntity("Kamerstuk")).toBeUndefined();
  });
});

describe("query plans", () => {
  it("documents: date range in local time, type filter and upstream skip", () => {
    const plan = tk.planDocuments({ query: "stikstof", top: 10, type: "Motie", date_from: "2026-10-01", date_to: "2026-10-01", skip: 20 });
    expect(plan.params.$filter).toContain("Datum ge 2026-10-01T00:00:00+02:00");
    expect(plan.params.$filter).toContain("Datum lt 2026-10-02T00:00:00+02:00");
    expect(plan.params.$filter).toContain("contains(Soort,'Motie')");
    expect(plan.params.$filter).toContain("contains(Onderwerp,'stikstof')");
    expect(plan.params.$skip).toBe("20");
    expect(plan.params.$top).toBe("10");
    // The zaak numbers for the links are looked up by Id afterwards: an expand here
    // made the service evaluate the text filter once more.
    expect(plan.params.$expand).toBeUndefined();
    expect(tk.planSearch({ entity: "Zaak", query: "stikstof", top: 5 }).params.$expand).toBeUndefined();
  });

  it("documents: no query and no filters browses the newest documents, without deleted ones", () => {
    const plan = tk.planDocuments({ top: 5 });
    // Tombstones (every field null but Id and GewijzigdOp) counted toward the total.
    expect(plan.params.$filter).toBe("Verwijderd eq false");
    expect(plan.params.$orderby).toBe("Datum desc");
    // Text terms never match a tombstone: no extra filter.
    expect(tk.planDocuments({ query: "parkeerbeleid", top: 5 }).params.$filter).not.toContain("Verwijderd");
  });

  it("search: a listing leaves out deleted records unless the caller filters on Verwijderd", () => {
    expect(tk.planSearch({ entity: "Document", top: 2 }).params.$filter).toBe("Verwijderd eq false");
    expect(tk.planSearch({ entity: "Zaak", top: 2, filter: "GewijzigdOp ge 2026-09-01T00:00:00Z" }).params.$filter).toBe(
      "(Verwijderd eq false) and (GewijzigdOp ge 2026-09-01T00:00:00Z)",
    );
    expect(tk.planSearch({ entity: "Document", top: 2, filter: "Verwijderd eq true" }).params.$filter).toBe("Verwijderd eq true");
    // ToegezegdAan has no such field.
    expect(tk.planSearch({ entity: "ToegezegdAan", top: 2 }).params.$filter).toBeUndefined();
  });

  it("rejects contradictory dates instead of returning an empty page", () => {
    expect(() => tk.planDocuments({ top: 5, date_from: "2026-05-01", date_to: "2026-01-01" })).toThrow(/ligt na date_to/);
    expect(() => tk.planSearch({ entity: "Zaak", top: 5, date_from: "2026-05-01", date_to: "2026-01-01" })).toThrow(TweedeKamerInputError);
    expect(() => tk.planVotes({ top: 5, date_from: "2026-05-01", date_to: "2026-01-01" })).toThrow(/ligt na date_to/);
    // "date" is one day; next to a range it used to win silently.
    expect(() => tk.planVotes({ top: 5, date: "2026-07-02", date_to: "2026-07-31" })).toThrow(/óf date/);
    expect(() => tk.planVotes({ top: 5, date: "2026-07-02", date_from: "2025-01-01" })).toThrow(TweedeKamerInputError);
    // One day as a range is fine.
    expect(tk.planDocuments({ top: 5, date_from: "2026-07-02", date_to: "2026-07-02" }).params.$filter).toContain("Datum lt 2026-07-03");
  });

  it("search: applies query to Zaak, adds date_from on its date field, keeps a raw filter", () => {
    const plan = tk.planSearch({ entity: "zaak", query: "stikstof", top: 5, date_from: "2026-07-01", filter: "Soort eq 'Motie'" });
    expect(plan.entity).toBe("Zaak");
    expect(plan.params.$filter).toBe(
      "((contains(Titel,'stikstof') or contains(Onderwerp,'stikstof'))) and (GestartOp ge 2026-07-01T00:00:00+02:00) and (Soort eq 'Motie')",
    );
  });

  it("search: dates Agendapunt and Stemming by their meeting or voting session", () => {
    const agendapunt = tk.planSearch({ entity: "Agendapunt", top: 3, date_from: "2026-06-01" });
    expect(agendapunt.params.$filter).toBe("(Verwijderd eq false) and (Activiteit/Datum ge 2026-06-01T00:00:00+02:00)");
    expect(tk.planSearch({ entity: "Stemming", top: 3, date_to: "2026-06-30" }).params.$filter).toBe(
      "(Verwijderd eq false) and (Besluit/Agendapunt/Activiteit/Datum lt 2026-07-01T00:00:00+02:00)",
    );
    // The plan says what the filter is on; which date a record shows is only said once
    // the meeting dates have been looked up (withSessionDates).
    expect(agendapunt.notes.join(" ")).toContain("Datumfilter op Agendapunt.Activiteit/Datum (Nederlandse tijd): de datum van de vergadering (vergaderdatum).");
    expect(agendapunt.notes.join(" ")).not.toContain("bij elk record");
    expect(tk.planSearch({ entity: "Zaak", top: 3, date_from: "2026-06-01" }).notes.join(" ")).not.toContain("wijzigingsdatum");
  });

  it("search: query is optional next to a filter", () => {
    const plan = tk.planSearch({ entity: "Document", top: 3, filter: "Soort eq 'Motie'" });
    expect(plan.params.$filter).toBe("(Verwijderd eq false) and (Soort eq 'Motie')");
  });

  it("search: rejects what it cannot apply instead of ignoring it", () => {
    expect(() => tk.planSearch({ entity: "Kamerstuk", top: 3 })).toThrow(TweedeKamerInputError);
    expect(() => tk.planSearch({ entity: "Zaal", query: "x", top: 3 })).toThrow(/niet ondersteund/);
    expect(() => tk.planSearch({ entity: "Persoon", date_from: "2026-01-01", top: 3 })).toThrow(/date_from/);
    expect(() => tk.planSearch({ query: "x", date_from: "01-07-2026", top: 3 })).toThrow(/JJJJ-MM-DD/);
    expect(() => tk.planSearch({ query: "x", date_to: "2026-02-30", top: 3 })).toThrow(/JJJJ-MM-DD/);
    expect(() => tk.planSearch({ query: "!!!", top: 3 })).toThrow(/geen letters of cijfers/);
  });

  it("votes: query on the voted zaak, vote-session date, zaak number and ordering by session", () => {
    const plan = tk.planVotes({ query: "stikstof", date: "2026-07-02", zaak_nummer: "2026z15215", top: 50 });
    const filter = plan.params.$filter;
    expect(filter).toContain("Verwijderd eq false");
    expect(filter).toContain("Besluit/Zaak/any(z: (contains(z/Titel,'stikstof') or contains(z/Onderwerp,'stikstof')))");
    expect(filter).toContain("Besluit/Agendapunt/Activiteit/Datum ge 2026-07-02T00:00:00+02:00");
    expect(filter).toContain("Besluit/Agendapunt/Activiteit/Datum lt 2026-07-03T00:00:00+02:00");
    expect(filter).toContain("Besluit/Zaak/any(z: z/Nummer eq '2026Z15215')");
    expect(plan.params.$orderby).toBe("Besluit/Agendapunt/Activiteit/Datum desc,Besluit_Id,ActorFractie");
    // Decision details come from one Besluit lookup per page, not an expand on every vote row.
    expect(plan.params.$expand).toBeUndefined();
  });

  it("search: a short name matches a field that is exactly that name (Persoon, Stemming)", () => {
    const bos = tk.planSearch({ entity: "Persoon", query: "Bos", top: 10 });
    expect(bos.params.$filter).toContain("contains(concat(concat(' ',Achternaam),' '),' Bos ')");
    expect(bos.fields).toEqual(["Achternaam", "Roepnaam", "Functie"]);
    const sp = tk.planSearch({
      entity: "Stemming",
      query: "SP",
      top: 10,
      date_from: "2026-07-02",
      date_to: "2026-07-02",
      filter: "Soort eq 'Voor' and Vergissing eq false",
    });
    expect(sp.params.$filter).toContain("contains(concat(concat(' ',ActorFractie),' '),' SP ')");
    expect(sp.params.$filter).toContain("(Soort eq 'Voor' and Vergissing eq false)");
  });

  it("documents: open-end date sentinels drop the bound and say so", () => {
    const plan = tk.planDocuments({ query: "stikstof", top: 5, date_from: "2026-09-01", date_to: "9999-12-31" });
    expect(plan.params.$filter).toContain("Datum ge 2026-09-01T00:00:00+02:00");
    expect(plan.params.$filter).not.toContain("Datum lt");
    expect(plan.params.$filter).not.toContain("+0100");
    expect(plan.notes.join(" ")).toContain("date_to 9999-12-31 legt geen bovengrens op");
    const early = tk.planSearch({ entity: "Zaak", top: 5, date_from: "0001-01-01" });
    expect(early.params.$filter).toBe("Verwijderd eq false");
    expect(early.notes.join(" ")).toContain("date_from 0001-01-01 legt geen ondergrens op");
  });

  it("documents: recency and meta words are not required in the title", () => {
    const plan = tk.planDocuments({ query: "nieuwste stikstof?", top: 5 });
    expect(plan.params.$filter).toBe("(contains(Titel,'stikstof') or contains(Onderwerp,'stikstof'))");
    expect(plan.notes.join(" ")).toContain("Genegeerde stopwoorden: nieuwste");
  });

  it("documents: a question frame is not required in the title and is reported", () => {
    const plan = tk.planDocuments({ query: "kun je mij vertellen over stikstof", top: 5 });
    expect(plan.params.$filter).toBe("(contains(Titel,'stikstof') or contains(Onderwerp,'stikstof'))");
    expect(plan.notes.join(" ")).toContain("Genegeerde stopwoorden: kun, je, mij, vertellen, over.");
    const search = tk.planSearch({ entity: "Document", query: "ik ben op zoek naar woningbouw", top: 5 });
    expect(search.params.$filter).toBe("(contains(Titel,'woningbouw') or contains(Onderwerp,'woningbouw'))");
  });

  it("counts the rows a short term's spellings are checked on before it plans them", () => {
    const capNote = (notes: string[]) => notes.find((n) => n.startsWith("Korte zoekterm"));
    // First plan: the count to send, i.e. the same filters with plain contains() terms.
    const first = tk.planDocuments({ query: "OV", top: 5, type: "Motie", date_from: "2026-01-01" });
    expect(first.probe).toEqual({
      entity: "Document",
      filter:
        "((contains(Titel,'OV') or contains(Onderwerp,'OV'))) and (Datum ge 2026-01-01T00:00:00+01:00) and ((contains(Soort,'Motie') or contains(Titel,'Motie')))",
    });

    // Many rows: the two most frequent spellings, and the note says why and how to get more.
    const many = tk.planDocuments({ query: "OV", top: 5 }, { candidateRows: 278_727 });
    expect(many.probe).toBeUndefined();
    expect(many.params.$filter).toContain("' OV-'");
    expect(many.params.$filter).not.toContain("'(OV)'");
    expect(capNote(many.notes)).toContain('alleen als "OV", "OV-" (ook aan begin of eind en als hele waarde), niet als "(OV)", "/OV", "OV," e.d.');
    expect(capNote(many.notes)).toContain("De letters staan in 278.727 records");
    expect(capNote(many.notes)).toContain("met date_from (een kortere periode) worden meer schrijfwijzen gezocht");

    // A lower date bound leaves few rows: every spelling the node budget allows.
    const few = tk.planDocuments({ query: "OV", top: 5, date_from: "2026-01-01" }, { candidateRows: 4_120 });
    expect(few.params.$filter).toContain("' OV,'");
    expect(capNote(few.notes)).toBeUndefined();

    // tweede_kamer_search on a large entity counts too; with the caller's filter in the count.
    const zaak = tk.planSearch({ entity: "Zaak", query: "ING", top: 5, filter: "Soort eq 'Motie'" });
    expect(zaak.probe).toEqual({ entity: "Zaak", filter: "((contains(Titel,'ING') or contains(Onderwerp,'ING'))) and (Soort eq 'Motie')" });
    expect(tk.planSearch({ entity: "Zaak", query: "ING", top: 5 }, { candidateRows: 201_111 }).params.$filter).not.toContain("'/ING '");
    // Small entities without a date field: no count and no cap.
    for (const small of [tk.planSearch({ entity: "Fractie", query: "SP", top: 5 }), tk.planSearch({ entity: "Persoon", query: "Ko", top: 5 })]) {
      expect(small.probe).toBeUndefined();
      expect(capNote(small.notes)).toBeUndefined();
    }
    expect(tk.planSearch({ entity: "Fractie", query: "SP", top: 5 }).params.$filter).toContain("' SP,'");
    // Only long terms: nothing to count.
    expect(tk.planDocuments({ query: "parkeerbeleid", top: 5 }).probe).toBeUndefined();
    // A long term in the query narrows the count as it narrows the search.
    expect(tk.planDocuments({ query: "OV parkeerbeleid", top: 5 }).probe!.filter).toContain("contains(Titel,'parkeerbeleid')");

    // Votes: counted on the vote rows through the voted zaak, with the votes' own budget.
    const votes = tk.planVotes({ query: "OV", top: 5 });
    expect(votes.probe).toEqual({
      entity: "Stemming",
      filter: "(Verwijderd eq false) and (Besluit/Zaak/any(z: (contains(z/Titel,'OV') or contains(z/Onderwerp,'OV'))))",
    });
    const counted = tk.planVotes({ query: "OV", top: 5 }, { candidateRows: 961_512 });
    expect(counted.params.$filter).toContain("'(OV)'");
    expect(counted.params.$filter).not.toContain("'/OV '");
    expect(capNote(counted.notes)).toContain("met date of date_from");
    // One zaak: a handful of vote rows, nothing to count or cap.
    const oneZaak = tk.planVotes({ query: "OV", top: 5, zaak_nummer: "2026Z15215" });
    expect(oneZaak.probe).toBeUndefined();
    expect(capNote(oneZaak.notes)).toBeUndefined();
    expect(oneZaak.params.$filter).toContain("'/OV '");
  });

  it("notes when the word-boundary filter had to leave out common spellings", () => {
    const plan = tk.planDocuments({ query: "WW EU", top: 5 });
    const note = plan.notes.find((n) => n.startsWith("Woordgrens-filter ingekort"));
    expect(note).toContain('"(WW)"');
    // Plenty of room: no note.
    expect(tk.planDocuments({ query: "WW", top: 5 }).notes.some((n) => n.startsWith("Woordgrens-filter ingekort"))).toBe(false);
  });

  it("votes: zaak_id accepts a Zaak or (as before) a Besluit GUID, and validates input", () => {
    const guid = "64db5eb1-4ad8-4ee1-88c5-9960d34d6423";
    expect(tk.planVotes({ zaak_id: guid, top: 5 }).params.$filter).toContain(`Besluit_Id eq ${guid} or Besluit/Zaak/any(z: z/Id eq ${guid})`);
    expect(tk.planVotes({ zaak_id: guid, top: 5, zaak_id_kind: "zaak" }).params.$filter).toContain(`Besluit/Zaak/any(z: z/Id eq ${guid})`);
    expect(tk.planVotes({ zaak_id: guid, top: 5, zaak_id_kind: "besluit" }).params.$filter).toBe(`(Verwijderd eq false) and (Besluit_Id eq ${guid})`);
    expect(tk.planVotes({ zaak_id: "2026Z15215", top: 5 }).params.$filter).toContain("z/Nummer eq '2026Z15215'");
    expect(() => tk.planVotes({ zaak_id: "abc' or 1 eq 1", top: 5 })).toThrow(TweedeKamerInputError);
    expect(() => tk.planVotes({ besluit_id: "nope", top: 5 })).toThrow(TweedeKamerInputError);
    expect(() => tk.planVotes({ date: "gisteren", top: 5 })).toThrow(/JJJJ-MM-DD/);
  });
});
