import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

/**
 * EUR-Lex via CELLAR, the Publications Office's semantic repository. Its SPARQL
 * endpoint is keyless and fast for exact CELEX lookups and Virtuoso free-text
 * (bif:contains) title searches; FILTER(CONTAINS/REGEX) scans the whole corpus
 * and takes >10 s, so it is never used here.
 */
const SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";
const CELLAR_CELEX = "https://publications.europa.eu/resource/celex/";
const EURLEX_NL = "https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=CELEX:";
const OB_BASE = "https://zoek.officielebekendmakingen.nl/";

const LANG_NLD = "http://publications.europa.eu/resource/authority/language/NLD";
const LANG_ENG = "http://publications.europa.eu/resource/authority/language/ENG";
const COUNTRY_NLD = "http://publications.europa.eu/resource/authority/country/NLD";
const RESOURCE_TYPE = "http://publications.europa.eu/resource/authority/resource-type/";

/** Newest CJEU rulings listed per legal act in eurlex_document. */
const CASE_LAW_LIMIT = 10;

const PREFIXES =
  "PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>\n" +
  "PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\n";

const TYPE_GROUPS: Record<"REG" | "DIR" | "DEC", string[]> = {
  REG: ["REG", "REG_IMPL", "REG_DEL"],
  DIR: ["DIR", "DIR_IMPL", "DIR_DEL"],
  DEC: ["DEC", "DEC_IMPL", "DEC_DEL"],
};

const TYPE_LABEL_NL: Record<string, string> = {
  REG: "Verordening",
  REG_IMPL: "Uitvoeringsverordening",
  REG_DEL: "Gedelegeerde verordening",
  DIR: "Richtlijn",
  DIR_IMPL: "Uitvoeringsrichtlijn",
  DIR_DEL: "Gedelegeerde richtlijn",
  DEC: "Besluit",
  DEC_IMPL: "Uitvoeringsbesluit",
  DEC_DEL: "Gedelegeerd besluit",
};

/** Newest amending acts listed per legal act in eurlex_document. */
const AMENDMENT_LIMIT = 20;

/**
 * Words dropped from a title search. Virtuoso's free-text index treats the English
 * ones as noise (an AND with one of them matches nothing); the Dutch ones carry no
 * meaning in a title. "eu", "eg" and "nr" stand in nearly every title
 * ("Verordening (EU) nr. ..."): alone they make CELLAR scan the whole corpus
 * (16-19 s, measured), next to another word they add nothing.
 */
const NOISE_WORDS = new Set([
  "het", "een", "van", "voor", "met", "door", "naar", "over", "tot", "bij", "aan", "uit",
  "als", "dat", "die", "deze", "zijn", "and", "the", "for", "with", "des", "der", "den",
  // Two-letter function words (Dutch, then English/Virtuoso noise).
  "de", "en", "in", "op", "te", "of", "om", "is", "na", "al", "er", "ze", "we", "je", "ik", "af",
  "an", "as", "at", "be", "by", "do", "he", "if", "it", "me", "my", "on", "or", "re", "so", "to", "up",
  // Boilerplate in EU titles.
  "eu", "eg", "nr",
]);

/**
 * Act-type words. A title search on these alone lists every act of that type, so
 * they never stand on their own in the fallback without two-letter words.
 */
const ACT_TYPE_WORDS = new Set([
  "verordening", "richtlijn", "besluit", "beschikking",
  "uitvoeringsverordening", "uitvoeringsrichtlijn", "uitvoeringsbesluit", "gedelegeerde", "gedelegeerd",
  "regulation", "directive", "decision", "implementing", "delegated",
]);

/** Words that may surround a document number in a citation ("Verordening (EU) 2016/679"). */
const CITATION_WORDS = new Set([
  "verordening", "richtlijn", "besluit", "beschikking",
  "uitvoeringsverordening", "uitvoeringsrichtlijn", "uitvoeringsbesluit", "gedelegeerde", "gedelegeerd",
  "regulation", "directive", "decision", "implementing", "delegated",
  "eu", "eg", "eeg", "euratom", "egks", "ec", "eec", "nr", "no", "celex",
  "van", "het", "de", "en", "europees", "europese", "parlement", "raad", "commissie",
  "the", "of", "european", "parliament", "and", "council", "commission",
]);

const TYPE_LETTER: Record<"REG" | "DIR" | "DEC", string> = { REG: "R", DIR: "L", DEC: "D" };

const ACCESS_NOTE_BASE =
  "Bron: EUR-Lex/CELLAR (Publicatiebureau van de Europese Unie), SPARQL-endpoint. " +
  "Alleen de elektronische editie van het Publicatieblad van de EU is authentiek; " +
  "metadata en geconsolideerde teksten dienen louter ter informatie.";

export interface EuCellarResult {
  items: Array<Record<string, unknown>>;
  total: number | null;
  endpoint: string;
  params: Record<string, string>;
  access_note: string;
}

type Binding = Record<string, { value?: string } | undefined>;
interface SparqlJson {
  results?: { bindings?: Binding[] };
}

const CELEX_STRICT = /^3\d{4}[A-Z]\d{4,5}$/;

/**
 * The four-digit year a citation part stands for, or null. EU acts date from 1952
 * (ECSC). Since 1999 citations write the year in four digits, so a two-digit part
 * is only a year for older acts: "95/46" is 1995, and "10/2011" never means 2010.
 */
function citationYear(y: string): string | null {
  const n = Number(y);
  if (y.length === 4) return n >= 1952 && n <= new Date().getUTCFullYear() + 1 ? y : null;
  if (y.length === 2) return n >= 52 ? `19${y}` : null;
  return null;
}

interface PairReading {
  year: string;
  writtenYear: string;
  number: string;
  yearFirst: boolean;
}

/** "(EG)", "(EEG)", "(EGKS)" and English "(EC)"/"(EEC)" only stand in citations from before 2015. */
const PRE_2015_MARKERS = new Set(["eg", "eeg", "egks", "ec", "eec"]);

/** The era a citation's marker points to: (EG)/(EEG)/(EC) before 2015, or (EU). */
type CitationMarker = "pre2015" | "eu" | null;

function markerOf(word: string): CitationMarker {
  return PRE_2015_MARKERS.has(word) ? "pre2015" : word === "eu" ? "eu" : null;
}

/**
 * The marker of the citation around the number pair at s[start, end) (lower
 * case). Only the citation itself counts: the run of citation words right before
 * the pair ("Verordening (EU) ", "EG-verordening "), nearest marker first, else a
 * marker right after it ("1907/2006/EG", "2018/1999 (EG)"). Words further on
 * belong to other acts: in "Verordening (EU) 2018/1999 tot wijziging van
 * Verordening (EG) nr. 663/2009" the (EG) is not the marker of 2018/1999.
 */
function citationMarker(s: string, start: number, end: number): CitationMarker {
  const before = s.slice(0, start).match(/[\p{L}\p{N}]+/gu) ?? [];
  for (let i = before.length - 1; i >= 0; i--) {
    const marker = markerOf(before[i]);
    if (marker) return marker;
    if (!CITATION_WORDS.has(before[i])) break;
  }
  const after = /^\s*[/(]?\s*(\p{L}+)/u.exec(s.slice(end));
  return after ? markerOf(after[1]) : null;
}

/** "nr."/"no." right before the number pair: the pre-2015 number/year style. */
function hasNumberWord(before: string): boolean {
  return /\b(nr|no)\.?\s*$/.test(before);
}

/**
 * Read the two numbers of a directive or decision citation ("2016/679",
 * "95/46", "Besluit nr. 1386/2013/EU") as year and number. `numberFirst` is set
 * when "nr."/"no." precedes the pair. Regulations follow their own rules, see
 * readRegulationPair.
 */
function readNumberPair(a: string, b: string, numberFirst: boolean): PairReading | null {
  const yearA = citationYear(a);
  const yearB = citationYear(b);
  const numberYear = yearB ? { year: yearB, writtenYear: b, number: a, yearFirst: false } : null;
  if (numberFirst && numberYear) return numberYear;
  // A four-digit year after a shorter number is number/year ("66/2010", "10/2011"):
  // no act written year-first with a two-digit year carries a number like 2010.
  if (numberYear && b.length === 4 && a.length < 4) return numberYear;
  if (yearA) return { year: yearA, writtenYear: a, number: b, yearFirst: true };
  if (numberYear && b.length === 4) return numberYear;
  return null;
}

/**
 * The readings of a regulation's number pair, most likely first. Until 2014 a
 * regulation was cited number/year ("(EG) nr. 1998/2006", "(EEG) nr. 1408/71"),
 * since 2015 year/number ("(EU) 2016/679"). So the pair is year/number only when
 * its first part is a year from 2015 on: "1998/2006" is regulation 1998 of 2006,
 * never 2006 of 1998. When both readings fit ("2018/1999": (EU) 2018/1999 and
 * (EG) nr. 2018/1999 both exist), "nr." or an (EG)/(EEG) marker picks number/year
 * and an (EU) marker year/number (see citationMarker); without either, both
 * readings are returned.
 *
 * A pair that no regulation is cited as is read the other way round, as the only
 * act it can mean: "1119/2021" as (EU) 2021/1119 and, when the citation says it is
 * a regulation (`regulationNamed`), "2001/1049" as (EG) nr. 1049/2001. Without that
 * type word "95/46" is left to the directive and decision readings, so (EG) nr.
 * 46/95 is not shown as act 95/46.
 */
function readRegulationPair(
  a: string,
  b: string,
  numberFirst: boolean,
  marker: CitationMarker,
  regulationNamed: boolean,
): PairReading[] {
  const yearA = citationYear(a);
  const yearB = citationYear(b);
  const yearFirst = yearA && Number(yearA) >= 2015 ? { year: yearA, writtenYear: a, number: b, yearFirst: true } : null;
  const numberYear = yearB ? { year: yearB, writtenYear: b, number: a, yearFirst: false } : null;
  if (yearFirst && numberYear) {
    if (Number(yearB) >= 2015) return [yearFirst];
    if (numberFirst || marker === "pre2015") return [numberYear];
    if (marker === "eu") return [yearFirst];
    return [yearFirst, numberYear];
  }
  const only = yearFirst ?? numberYear;
  if (only) return [only];
  return regulationNamed && yearA ? [{ year: yearA, writtenYear: a, number: b, yearFirst: true }] : [];
}

/**
 * The readings of a number pair for one CELEX type letter (R, L or D), most
 * likely first. `typeNamed` is set when the citation or the type filter names
 * the type.
 */
function readPairFor(
  letter: string,
  a: string,
  b: string,
  numberFirst: boolean,
  marker: CitationMarker,
  typeNamed: boolean,
): PairReading[] {
  if (letter === "R") return readRegulationPair(a, b, numberFirst, marker, typeNamed);
  const pair = readNumberPair(a, b, numberFirst);
  return pair ? [pair] : [];
}

/** The act-type letter of the first type word in `s` (lower case), or null. */
function firstTypeLetter(s: string): string | null {
  const kinds: Array<[RegExp, string]> = [
    [/verordening|regulation/, "R"],
    [/richtlijn|directive/, "L"],
    [/besluit|decision|beschikking/, "D"],
  ];
  let first: { at: number; letter: string } | null = null;
  for (const [re, letter] of kinds) {
    const k = re.exec(s);
    if (k && (!first || k.index < first.at)) first = { at: k.index, letter };
  }
  return first?.letter ?? null;
}

/**
 * Turn a CELEX number or a Dutch/English EU citation into a sector-3 CELEX
 * (e.g. "Richtlijn 95/46/EG" → 31995L0046). Returns null when unrecognised.
 */
export function normalizeCelex(input: string): string | null {
  const raw = String(input ?? "").normalize("NFC").trim();
  if (!raw) return null;

  const direct = raw.replace(/^celex\s*[:\s]\s*/i, "").replace(/\s+/g, "").toUpperCase();
  const dm = /^3(\d{4})([A-Z])(\d{1,5})$/.exec(direct);
  if (dm) {
    const celex = `3${dm[1]}${dm[2]}${dm[3].padStart(4, "0")}`;
    return CELEX_STRICT.test(celex) ? celex : null;
  }

  const s = raw.toLowerCase();
  const letter = firstTypeLetter(s);
  const nm = /(\d{1,4})\s*\/\s*(\d{1,4})/.exec(s);
  if (!letter || !nm) return null;

  // One act is asked for: take the most likely reading (see readRegulationPair). An
  // act's own title often cites older (EG) acts after its number, so only the
  // citation of this pair decides (see citationMarker).
  const end = nm.index + nm[0].length;
  const [pair] = readPairFor(letter, nm[1], nm[2], hasNumberWord(s.slice(0, nm.index)), citationMarker(s, nm.index, end), true);
  if (!pair) return null;
  const celex = `3${pair.year}${letter}${pair.number.padStart(4, "0")}`;
  return CELEX_STRICT.test(celex) ? celex : null;
}

/**
 * Split user input into free-text words. Only Unicode letters and digits survive,
 * so quotes, braces and SPARQL keywords can never reach the query. Two-letter
 * words are kept ("VK", "5G"); single characters and NOISE_WORDS are dropped.
 */
export function freeTextWords(query: string): { words: string[]; ignored: string[] } {
  const words: string[] = [];
  const ignored: string[] = [];
  for (const w of String(query ?? "").normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length < 2 || NOISE_WORDS.has(w.toLowerCase())) ignored.push(w);
    else if (words.length < 6) words.push(w);
    else ignored.push(w);
  }
  return { words, ignored };
}

/** Build a Virtuoso free-text expression (an AND of quoted words) from user input. */
export function buildFreeText(query: string): string {
  const { words } = freeTextWords(query);
  if (words.length === 0) {
    throw new Error(
      `Zoekterm '${query}' bevat geen bruikbare woorden (minimaal 2 letters of cijfers; stopwoorden en 'EU', 'EG' en 'nr' tellen niet mee).`,
    );
  }
  return andOf(words);
}

function andOf(words: string[]): string {
  return words.map((w) => `"${w}"`).join(" AND ");
}

/**
 * The words to search again without the two-letter ones, or null. A two-letter
 * word is often an abbreviation the title spells out ("Brexit VK") or repeats
 * words already in the query ("terugtrekking Verenigd Koninkrijk (VK)"); ANDing it can
 * hide the act asked about. No fallback when only two-letter words or act-type
 * words would remain ("VK-verordening" must not list every regulation).
 */
function wordsWithoutShort(words: string[]): string[] | null {
  const rest = words.filter((w) => w.length > 2);
  if (rest.length === words.length || !rest.some((w) => !ACT_TYPE_WORDS.has(w.toLowerCase()))) return null;
  return rest;
}

export interface DocumentNumber {
  /** CELEX type letters with a candidate: R (regulation), L (directive), D (decision). */
  letters: string[];
  /**
   * Candidate CELEX numbers, most likely first. Each type reads the pair its own
   * way (see readRegulationPair), and a regulation pair can have two readings.
   */
  celex: string[];
  /** The number pair as written in the query ("2016/679", "1049/2001", "95/46"). */
  citation: string;
  /**
   * Set when the query's type word names another act type than the type filter
   * ("Richtlijn 2006/123/EG" with type REG). The candidates then follow the type
   * word, and the search shows no exact match: the filter excludes that act.
   */
  conflictsWithType?: true;
}

/**
 * Recognise a query that is just an EU document number, optionally with type
 * and citation words: "2016/679", "Verordening (EU) 2016/679", "Richtlijn
 * 95/46/EG", "(EG) nr. 1049/2001". Returns null for anything else, including a
 * number mixed with topic words, which stays a title search.
 */
export function parseDocumentNumber(query: string, type?: "REG" | "DIR" | "DEC"): DocumentNumber | null {
  const s = String(query ?? "").normalize("NFC").toLowerCase();
  const pairs = [...s.matchAll(/(\d{1,5})\s*\/\s*(\d{1,5})/g)];
  if (pairs.length !== 1) return null;
  const m = pairs[0];
  const at = m.index ?? 0;
  const rest = `${s.slice(0, at)} ${s.slice(at + m[0].length)}`.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (rest.some((w) => !CITATION_WORDS.has(w))) return null;

  const namedLetter = firstTypeLetter(s);
  const filterLetter = type ? TYPE_LETTER[type] : null;
  // A type word that contradicts the filter is read as written, so another act
  // with the same pair is never shown as the one asked for.
  const conflict = Boolean(namedLetter && filterLetter && namedLetter !== filterLetter);
  const typeLetter = conflict ? namedLetter : (filterLetter ?? namedLetter);
  // Since 2015 regulations, directives and decisions share one numbering, but
  // older acts of different types can carry the same number: try all three.
  const tryLetters = typeLetter ? [typeLetter] : ["R", "L", "D"];
  const numberFirst = hasNumberWord(s.slice(0, at));
  const marker = citationMarker(s, at, at + m[0].length);
  const candidates: Array<{ letter: string; celex: string; reading: PairReading }> = [];
  for (const letter of tryLetters) {
    for (const reading of readPairFor(letter, m[1], m[2], numberFirst, marker, typeLetter !== null)) {
      const celex = `3${reading.year}${letter}${reading.number.replace(/^0+(?=\d)/, "").padStart(4, "0")}`;
      if (CELEX_STRICT.test(celex) && !candidates.some((c) => c.celex === celex)) candidates.push({ letter, celex, reading });
    }
  }
  if (!candidates.length) return null;
  // All readings come from the same written pair; the citation only drops leading zeros of the number.
  const { reading } = candidates[0];
  const number = reading.number.replace(/^0+(?=\d)/, "");
  return {
    letters: [...new Set(candidates.map((c) => c.letter))],
    celex: candidates.map((c) => c.celex),
    citation: reading.yearFirst ? `${reading.writtenYear}/${number}` : `${number}/${reading.writtenYear}`,
    ...(conflict ? { conflictsWithType: true as const } : {}),
  };
}

function val(row: Binding, key: string): string | undefined {
  const v = row[key]?.value;
  return v === undefined || v === "" ? undefined : v;
}

function lastSegment(uri: string | undefined): string | undefined {
  return uri ? uri.split("/").pop() : undefined;
}

function toBool(v: string | undefined): boolean | null {
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return null;
}

function requireCelex(id: string): string {
  const celex = normalizeCelex(id);
  if (!celex) {
    throw new Error(
      `Ongeldig CELEX-nummer of EU-citaat: '${id}' (verwacht bv. 32016R0679 of 'Richtlijn (EU) 2016/680').`,
    );
  }
  return celex;
}

function legislationItem(args: {
  celex: string;
  titleNl?: string;
  titleEn?: string;
  type?: string;
  date?: string;
  force?: string;
  eli?: string;
}): Record<string, unknown> {
  const title = args.titleNl ?? args.titleEn ?? null;
  return {
    celex: args.celex,
    title,
    title_language: args.titleNl ? "nl" : args.titleEn ? "en" : null,
    document_type: args.type ?? null,
    document_type_label: args.type ? (TYPE_LABEL_NL[args.type] ?? args.type) : null,
    date: args.date ? args.date.slice(0, 10) : null,
    in_force: toBool(args.force),
    eli: args.eli ?? null,
    eurlex_url: EURLEX_NL + args.celex,
    cellar_url: CELLAR_CELEX + args.celex,
  };
}

/** Derive the officielebekendmakingen.nl identifier of a Dutch implementing measure. */
function bekendmakingId(
  oj: string | undefined,
  ojNum: string | undefined,
  ojDate: string | undefined,
  typeAct: string | undefined,
): { identifier: string | null; journal: string | null } {
  const year = ojDate?.slice(0, 4);
  const num = ojNum?.trim().replace(/^0+(?=\d)/, "");
  const ojLower = (oj ?? "").toLowerCase();
  let kind: "stb" | "stcrt" | null = null;
  if (ojLower.includes("staatsblad")) kind = "stb";
  else if (ojLower.includes("staatscourant")) kind = "stcrt";
  else if (!oj) {
    // Without a journal name CELLAR still gives the number: a Wet is always in the
    // Staatsblad, a ministerial Regeling/Bekendmaking always in the Staatscourant.
    const t = (typeAct ?? "").toLowerCase();
    if (t === "wet") kind = "stb";
    else if (/^(bekendmaking|regeling|mededeling)$/.test(t)) kind = "stcrt";
  }
  const validNumber = Boolean(num && /^\d+$/.test(num) && year && /^\d{4}$/.test(year));
  const identifier = kind && validNumber ? `${kind}-${year}-${num}` : null;

  let journal: string | null = null;
  const baseName = oj ? oj.replace(/\s*\(.*\)\s*$/, "").trim() : kind === "stb" ? "Staatsblad" : kind === "stcrt" ? "Staatscourant" : "";
  if (baseName && validNumber) journal = `${baseName} ${year}, ${num}`;
  else if (oj) journal = oj;
  return { identifier, journal };
}

export class EuCellarSource {
  constructor(private readonly config: AppConfig) {}

  private async select(query: string): Promise<Binding[]> {
    const { data } = await getJson<SparqlJson>(SPARQL_ENDPOINT, {
      query: { query: PREFIXES + query },
      headers: { Accept: "application/sparql-results+json" },
      connector: "eu_cellar",
      timeoutMs: 20_000,
      retries: 1,
    });
    const bindings = data?.results?.bindings;
    if (!Array.isArray(bindings)) {
      throw new Error("CELLAR SPARQL gaf een onverwacht antwoord (geen results.bindings).");
    }
    return bindings;
  }

  /**
   * Newest legal acts whose Dutch title matches a free-text expression. The
   * expression must come from buildFreeText or be a quoted digits-only citation.
   */
  private async titleSearch(expression: string, typeList: string, limit: number): Promise<Array<Record<string, unknown>>> {
    const sparql = `SELECT DISTINCT ?celex ?date ?type ?force ?eli ?title WHERE {
  ?expr cdm:expression_title ?title ;
        cdm:expression_uses_language <${LANG_NLD}> ;
        cdm:expression_belongs_to_work ?work .
  ?title bif:contains '${expression}' .
  ?work cdm:resource_legal_id_celex ?celex ;
        cdm:work_has_resource-type ?type ;
        cdm:work_date_document ?date .
  OPTIONAL { ?work cdm:resource_legal_in-force ?force }
  OPTIONAL { ?work cdm:resource_legal_eli ?eli }
  FILTER(?type IN (${typeList}))
  FILTER(!CONTAINS(STR(?celex), "R("))
} ORDER BY DESC(?date) ?celex LIMIT ${limit}`;

    const rows = await this.select(sparql);
    const seen = new Set<string>();
    const items: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const celex = val(row, "celex");
      if (!celex || seen.has(celex)) continue;
      seen.add(celex);
      items.push({
        ...legislationItem({
          celex,
          titleNl: val(row, "title"),
          type: lastSegment(val(row, "type")),
          date: val(row, "date"),
          force: val(row, "force"),
          eli: val(row, "eli"),
        }),
        match: "title",
      });
    }
    return items;
  }

  async search(args: { query: string; type?: "REG" | "DIR" | "DEC"; limit: number }): Promise<EuCellarResult> {
    const limit = Math.max(1, Math.min(Math.floor(args.limit) || 1, this.config.limits.maxRows));
    const types = args.type ? TYPE_GROUPS[args.type] : Object.values(TYPE_GROUPS).flat();
    if (!types) throw new Error(`Onbekend documenttype '${args.type}' (verwacht REG, DIR of DEC).`);
    const typeList = types.map((t) => `<${RESOURCE_TYPE}${t}>`).join(", ");

    const docNumber = parseDocumentNumber(args.query, args.type);
    if (docNumber) return this.searchDocumentNumber(args, docNumber, typeList, limit);

    const expression = buildFreeText(args.query);
    const { words, ignored } = freeTextWords(args.query);
    const rest = wordsWithoutShort(words);
    const partialExpression = rest ? andOf(rest) : null;
    // Both run at once: the fallback only fills up a short primary result, but
    // waiting for the primary first would double the latency of every such query.
    // Only the primary search may fail the call.
    const [primary, fallback] = await Promise.all([
      this.titleSearch(expression, typeList, limit),
      partialExpression
        ? this.titleSearch(partialExpression, typeList, limit).catch(() => null)
        : Promise.resolve([]),
    ]);
    const primaryCelex = new Set(primary.map((i) => String(i.celex)));
    const partial = (fallback ?? [])
      .filter((i) => !primaryCelex.has(String(i.celex)))
      .slice(0, Math.max(0, limit - primary.length))
      .map((i) => ({ ...i, match: "title_partial" }));
    const items = [...primary, ...partial];

    let shortNote = "";
    const shortWords = words.filter((w) => w.length === 2);
    if (shortWords.length && shortWords.length < words.length) {
      const shortList = shortWords.map((w) => `'${w}'`).join(", ");
      shortNote = partial.length
        ? (primary.length
            ? `Eerst ${primary.length} ${primary.length === 1 ? "titel" : "titels"} met alle zoekwoorden, ook ${shortList} (match: title); `
            : `Geen titels met alle zoekwoorden, ook ${shortList}; `) +
          `daarna ${partial.length} ${partial.length === 1 ? "titel" : "titels"} zonder ${shortList} (match: title_partial), ` +
          "want een kort woord is vaak een afkorting die de titel voluit schrijft. "
        : fallback === null && primary.length < limit
          ? `Korte woorden zijn meegezocht: ${shortList}; de aanvullende zoekopdracht zonder ${shortList} mislukte, probeer het zo nodig opnieuw zonder ${shortList}. `
          : `Korte woorden zijn meegezocht: ${shortList}. `;
    }

    return {
      items,
      total: null,
      endpoint: SPARQL_ENDPOINT,
      params: {
        query: args.query,
        freetext: expression,
        ...(partialExpression ? { freetext_partial: partialExpression } : {}),
        ...(args.type ? { type: args.type } : {}),
        limit: String(limit),
      },
      access_note:
        `${ACCESS_NOTE_BASE} Er wordt alleen gezocht in de Nederlandse titels (niet in de volledige tekst) ` +
        "van verordeningen, richtlijnen en besluiten, nieuwste eerst; het totaal aantal treffers is onbekend. " +
        (ignored.length
          ? `Niet meegezocht (één teken, stopwoord, 'EU'/'EG'/'nr' of meer dan zes woorden): ${ignored.slice(0, 10).join(", ")}. `
          : "") +
        shortNote +
        (items.length === 0
          ? "Geen titels gevonden; probeer officiële EU-terminologie (bv. 'artificiële intelligentie' i.p.v. 'kunstmatige intelligentie'), synoniemen of minder woorden."
          : "Titels gebruiken officiële EU-terminologie; zijn de resultaten schaars of niet relevant, zoek dan opnieuw met officiële of alternatieve termen of met minder woorden."),
    };
  }

  /**
   * A query that is only a document number ("2021/1119", "Richtlijn 95/46/EG")
   * looks the act up by CELEX instead of AND-ing "2021" and "1119" over all titles,
   * which also finds acts of another year that carry the same number. Acts
   * whose title cites exactly that number (amending and implementing acts) follow.
   */
  private async searchDocumentNumber(
    args: { query: string; type?: "REG" | "DIR" | "DEC" },
    dn: DocumentNumber,
    typeList: string,
    limit: number,
  ): Promise<EuCellarResult> {
    // CELEX values and the citation are digits plus one letter from a fixed set (see parseDocumentNumber).
    const values = dn.celex.map((c) => `"${c}"^^xsd:string`).join(" ");
    const exactSparql = `SELECT DISTINCT ?celex ?date ?type ?force ?eli ?titleNl ?titleEn WHERE {
  VALUES ?celex { ${values} }
  ?work cdm:resource_legal_id_celex ?celex .
  OPTIONAL { ?work cdm:work_date_document ?date }
  OPTIONAL { ?work cdm:work_has_resource-type ?type }
  OPTIONAL { ?work cdm:resource_legal_in-force ?force }
  OPTIONAL { ?work cdm:resource_legal_eli ?eli }
  OPTIONAL { ?exprNl cdm:expression_belongs_to_work ?work ;
             cdm:expression_uses_language <${LANG_NLD}> ;
             cdm:expression_title ?titleNl }
  OPTIONAL { ?exprEn cdm:expression_belongs_to_work ?work ;
             cdm:expression_uses_language <${LANG_ENG}> ;
             cdm:expression_title ?titleEn }
} LIMIT 100`;
    const phrase = `"${dn.citation}"`;

    // On a type conflict the act asked for is outside the filter: only citing titles of the filtered type remain.
    const [exactRows, citing] = await Promise.all([
      dn.conflictsWithType ? Promise.resolve([]) : this.select(exactSparql),
      this.titleSearch(phrase, typeList, limit),
    ]);

    const exact: Array<Record<string, unknown>> = [];
    for (const celex of dn.celex) {
      const rows = exactRows.filter((r) => val(r, "celex") === celex);
      if (!rows.length) continue;
      const first = (key: string): string | undefined => rows.map((r) => val(r, key)).find((v) => v !== undefined);
      const typeCodes = rows.map((r) => lastSegment(val(r, "type"))).filter((t): t is string => Boolean(t));
      exact.push({
        ...legislationItem({
          celex,
          titleNl: first("titleNl"),
          titleEn: first("titleEn"),
          type: typeCodes.find((t) => t in TYPE_LABEL_NL) ?? typeCodes[0],
          date: first("date"),
          force: first("force"),
          eli: first("eli"),
        }),
        match: "document_number",
      });
    }

    // The free-text phrase ignores punctuation; keep only titles that really cite the number.
    // A pair inside a longer identifier ("Besluit DRC/1/2003", "ECB/2024/12") is not a citation of it.
    const [x, y] = dn.citation.split("/");
    const cites = new RegExp(`(?<![\\d/])0*${x}\\s*/\\s*0*${y}(?!\\d|\\s*/\\s*\\d)`);
    const exactCelex = new Set(exact.map((i) => String(i.celex)));
    const related = citing.filter((i) => !exactCelex.has(String(i.celex)) && cites.test(String(i.title ?? "")));
    const items = [...exact, ...related].slice(0, limit);

    const kinds = dn.letters.map((l) => ({ R: "verordening", L: "richtlijn", D: "besluit" })[l] ?? l).join(", ");
    const exactLetters = exact.map((i) => String(i.celex).charAt(5));
    const severalTypes = new Set(exactLetters).size > 1;
    const severalReadings = exactLetters.length > new Set(exactLetters).size;
    const why = [
      ...(severalTypes ? ["vóór 2015 konden een verordening, richtlijn en besluit hetzelfde nummer dragen"] : []),
      ...(severalReadings
        ? [
            "een verordening van vóór 2015 wordt geciteerd als nummer/jaar, een latere als jaar/nummer; " +
              "met '(EU)' of '(EG) nr.' erbij wordt alleen die lezing gezocht",
          ]
        : []),
    ];
    let note: string;
    if (dn.conflictsWithType && args.type) {
      const filtered = ({ REG: "verordeningen", DIR: "richtlijnen", DEC: "besluiten" } as const)[args.type];
      note =
        `Zoekterm herkend als documentnummer ${dn.citation} van een ${kinds} (CELEX ${dn.celex.join(", ")}), ` +
        `maar type=${args.type} zoekt alleen ${filtered}: daarom geen exacte match. ` +
        "Laat type weg of pas het aan, of vraag de handeling op met eurlex_document. " +
        (related.length
          ? `Wel getoond: ${filtered} die ${dn.citation} in hun Nederlandse titel noemen (match: title).`
          : `Ook geen ${filtered} die ${dn.citation} in hun titel noemen.`);
    } else if (exact.length) {
      note =
        `Zoekterm herkend als documentnummer ${dn.citation}: eerst ` +
        (exact.length === 1
          ? "de handeling zelf"
          : `de ${exact.length} handelingen met dat nummer (${why.join("; ")}; zie ` +
            `${[...(severalTypes ? ["document_type"] : []), ...(severalReadings ? ["date"] : [])].join(" en ")})`) +
        ` (CELEX ${[...exactCelex].join(", ")}; match: document_number)` +
        (related.length ? `, daarna handelingen die ${dn.citation} in hun Nederlandse titel noemen (match: title), nieuwste eerst.` : ".");
    } else {
      note =
        `Zoekterm herkend als documentnummer ${dn.citation}, maar CELLAR kent geen ${kinds} met dat nummer (gezocht: CELEX ${dn.celex.join(", ")}). ` +
        (related.length
          ? `Wel getoond: handelingen die ${dn.citation} in hun Nederlandse titel noemen (match: title).`
          : args.type
            ? `Ook geen titels van type ${args.type} die dit nummer noemen; controleer jaar, nummer en type.`
            : "Ook geen titels die dit nummer noemen; controleer jaar en nummer.");
    }

    return {
      items,
      total: null,
      endpoint: SPARQL_ENDPOINT,
      params: {
        query: args.query,
        document_number: dn.citation,
        celex: dn.celex.join(","),
        freetext: phrase,
        ...(args.type ? { type: args.type } : {}),
        limit: String(limit),
      },
      access_note: `${ACCESS_NOTE_BASE} ${note}`,
    };
  }

  /** CJEU case law interpreting a work: the newest rulings plus the total count, as two parallel queries. */
  private async caseLaw(celex: string): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
    // No GROUP BY: Virtuoso's MAX/SAMPLE over OPTIONAL dates mixes values between groups.
    // Rows can repeat per title, so fetch a margin and deduplicate on CELEX below.
    const listSparql = `SELECT DISTINCT ?celex ?ecli ?date ?titleNl ?titleEn WHERE {
  ?work cdm:resource_legal_id_celex "${celex}"^^xsd:string .
  ?case cdm:case-law_interpretes_resource_legal ?work ;
        cdm:resource_legal_id_celex ?celex ;
        cdm:work_date_document ?date .
  OPTIONAL { ?case cdm:case-law_ecli ?ecli }
  OPTIONAL { ?exprNl cdm:expression_belongs_to_work ?case ;
             cdm:expression_uses_language <${LANG_NLD}> ;
             cdm:expression_title ?titleNl }
  OPTIONAL { ?exprEn cdm:expression_belongs_to_work ?case ;
             cdm:expression_uses_language <${LANG_ENG}> ;
             cdm:expression_title ?titleEn }
} ORDER BY DESC(?date) ?celex LIMIT ${CASE_LAW_LIMIT * 4}`;
    const countSparql = `SELECT (COUNT(DISTINCT ?case) AS ?n) WHERE {
  ?work cdm:resource_legal_id_celex "${celex}"^^xsd:string .
  ?case cdm:case-law_interpretes_resource_legal ?work .
}`;

    const [listRows, countRows] = await Promise.all([this.select(listSparql), this.select(countSparql)]);
    const total = Number(countRows[0] ? val(countRows[0], "n") : undefined);
    if (!Number.isInteger(total) || total < 0) {
      throw new Error("CELLAR SPARQL gaf geen geldig aantal HvJ-uitspraken.");
    }

    const seen = new Set<string>();
    const items: Array<Record<string, unknown>> = [];
    for (const row of listRows) {
      const caseCelex = val(row, "celex");
      if (!caseCelex || seen.has(caseCelex)) continue;
      seen.add(caseCelex);
      const title = val(row, "titleNl") ?? val(row, "titleEn");
      items.push({
        ecli: val(row, "ecli") ?? null,
        celex: caseCelex,
        // CELLAR separates the heading, parties, keywords and case number with '#'.
        title: title ? title.replace(/\s*#\s*/g, " ").trim() : null,
        date: val(row, "date")?.slice(0, 10) ?? null,
        eurlex_url: EURLEX_NL + caseCelex,
      });
      if (items.length === CASE_LAW_LIMIT) break;
    }
    return { items, total: Math.max(total, items.length) };
  }

  /**
   * Acts that amend or repeal a work, from CELLAR's resource_legal_amends_ and
   * resource_legal_repeals_resource_legal relations: the newest of each plus the
   * number of amending acts, as two parallel queries. CELLAR also records a
   * corrigendum (CELEX "...R(12)") as amending its act; it is no amending act,
   * so it is left out of the list and the count, as in titleSearch.
   */
  private async changes(celex: string): Promise<{
    amendedBy: Array<Record<string, unknown>>;
    amendedByTotal: number;
    repealedBy: Array<Record<string, unknown>>;
  }> {
    const relations = `  { ?act cdm:resource_legal_amends_resource_legal ?work . BIND("amended_by" AS ?rel) }
  UNION
  { ?act cdm:resource_legal_repeals_resource_legal ?work . BIND("repealed_by" AS ?rel) }`;
    // "repealed_by" sorts before "amended_by" with DESC, so a repeal is never cut off
    // by the LIMIT on a heavily amended act. Rows repeat per title: fetch a margin.
    const listSparql = `SELECT DISTINCT ?rel ?celex ?date ?force ?titleNl ?titleEn WHERE {
  ?work cdm:resource_legal_id_celex "${celex}"^^xsd:string .
${relations}
  ?act cdm:resource_legal_id_celex ?celex .
  FILTER(!CONTAINS(STR(?celex), "R("))
  OPTIONAL { ?act cdm:work_date_document ?date }
  OPTIONAL { ?act cdm:resource_legal_in-force ?force }
  OPTIONAL { ?exprNl cdm:expression_belongs_to_work ?act ;
             cdm:expression_uses_language <${LANG_NLD}> ;
             cdm:expression_title ?titleNl }
  OPTIONAL { ?exprEn cdm:expression_belongs_to_work ?act ;
             cdm:expression_uses_language <${LANG_ENG}> ;
             cdm:expression_title ?titleEn }
} ORDER BY DESC(?rel) DESC(?date) ?celex LIMIT ${AMENDMENT_LIMIT * 4}`;
    const countSparql = `SELECT ?rel (COUNT(DISTINCT ?act) AS ?n) WHERE {
  ?work cdm:resource_legal_id_celex "${celex}"^^xsd:string .
${relations}
  ?act cdm:resource_legal_id_celex ?celex .
  FILTER(!CONTAINS(STR(?celex), "R("))
} GROUP BY ?rel`;

    const [listRows, countRows] = await Promise.all([this.select(listSparql), this.select(countSparql)]);
    let amendedByTotal = 0;
    for (const row of countRows) {
      if (val(row, "rel") !== "amended_by") continue;
      const n = Number(val(row, "n"));
      if (!Number.isInteger(n) || n < 0) throw new Error("CELLAR SPARQL gaf geen geldig aantal wijzigingshandelingen.");
      amendedByTotal = n;
    }

    const amendedBy: Array<Record<string, unknown>> = [];
    const repealedBy: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const row of listRows) {
      const rel = val(row, "rel");
      const actCelex = val(row, "celex");
      if (!actCelex || (rel !== "amended_by" && rel !== "repealed_by")) continue;
      const key = `${rel}:${actCelex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const target = rel === "amended_by" ? amendedBy : repealedBy;
      if (target.length === AMENDMENT_LIMIT) continue;
      target.push({
        celex: actCelex,
        title: val(row, "titleNl") ?? val(row, "titleEn") ?? null,
        date: val(row, "date")?.slice(0, 10) ?? null,
        in_force: toBool(val(row, "force")),
        eurlex_url: EURLEX_NL + actCelex,
      });
    }
    return { amendedBy, amendedByTotal: Math.max(amendedByTotal, amendedBy.length), repealedBy };
  }

  async document(args: { id: string }): Promise<EuCellarResult> {
    const celex = requireCelex(args.id);
    const sparql = `SELECT ?date ?type ?force ?eli ?titleNl ?titleEn WHERE {
  ?work cdm:resource_legal_id_celex "${celex}"^^xsd:string .
  OPTIONAL { ?work cdm:work_date_document ?date }
  OPTIONAL { ?work cdm:work_has_resource-type ?type }
  OPTIONAL { ?work cdm:resource_legal_in-force ?force }
  OPTIONAL { ?work cdm:resource_legal_eli ?eli }
  OPTIONAL { ?exprNl cdm:expression_belongs_to_work ?work ;
             cdm:expression_uses_language <${LANG_NLD}> ;
             cdm:expression_title ?titleNl }
  OPTIONAL { ?exprEn cdm:expression_belongs_to_work ?work ;
             cdm:expression_uses_language <${LANG_ENG}> ;
             cdm:expression_title ?titleEn }
} LIMIT 100`;

    // Case law and amendments run alongside the metadata; only the metadata query may fail the call.
    const [rows, caseLaw, changes] = await Promise.all([
      this.select(sparql),
      this.caseLaw(celex).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      this.changes(celex).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]);
    const first = (key: string, pick?: (v: string) => boolean): string | undefined => {
      for (const row of rows) {
        const v = val(row, key);
        if (v !== undefined && (!pick || pick(v))) return v;
      }
      return undefined;
    };

    const params = { id: args.id, celex };
    if (rows.length === 0) {
      return {
        items: [],
        total: 0,
        endpoint: SPARQL_ENDPOINT,
        params,
        access_note: `${ACCESS_NOTE_BASE} CELEX ${celex} komt niet voor in CELLAR.`,
      };
    }

    // A work can carry several resource types (e.g. REG and a legacy code); prefer a known one.
    const typeCodes = rows.map((r) => lastSegment(val(r, "type"))).filter((t): t is string => Boolean(t));
    const type = typeCodes.find((t) => t in TYPE_LABEL_NL) ?? typeCodes[0];

    let caseLawNote: string;
    if (!caseLaw.ok) {
      const reason = caseLaw.error instanceof Error ? caseLaw.error.message : String(caseLaw.error);
      caseLawNote = ` HvJ-rechtspraak kon niet worden opgehaald (${reason.slice(0, 200)}); hvj_arresten en hvj_arresten_total zijn daarom null.`;
    } else if (caseLaw.value.total === 0) {
      caseLawNote = " CELLAR registreert geen uitspraken van het Hof van Justitie die deze handeling uitleggen.";
    } else {
      caseLawNote =
        ` hvj_arresten: de ${caseLaw.value.items.length} nieuwste van ${caseLaw.value.total} uitspraken van het Hof van Justitie ` +
        "(vooral arresten) die deze handeling volgens CELLAR uitleggen.";
    }

    let changesNote: string;
    if (!changes.ok) {
      const reason = changes.error instanceof Error ? changes.error.message : String(changes.error);
      changesNote = ` Wijzigingen konden niet worden opgehaald (${reason.slice(0, 200)}); amended_by, amended_by_total en repealed_by zijn daarom null.`;
    } else {
      const { amendedBy, amendedByTotal, repealedBy } = changes.value;
      changesNote =
        amendedByTotal === 0
          ? " CELLAR registreert geen wijzigingshandelingen voor deze handeling."
          : (amendedBy.length === amendedByTotal
              ? ` amended_by: ${amendedByTotal === 1 ? "1 wijzigingshandeling" : `alle ${amendedByTotal} wijzigingshandelingen`} volgens CELLAR`
              : ` amended_by: de ${amendedBy.length} nieuwste van ${amendedByTotal} wijzigingshandelingen volgens CELLAR`) +
            (amendedBy[0] ? ` (laatste: ${amendedBy[0].celex}${amendedBy[0].date ? ` van ${amendedBy[0].date}` : ""}).` : ".");
      if (repealedBy.length) {
        changesNote += ` Ingetrokken door: ${repealedBy.map((r) => r.celex).join(", ")} (repealed_by).`;
      }
    }

    return {
      items: [
        {
          ...legislationItem({
            celex,
            titleNl: first("titleNl"),
            titleEn: first("titleEn"),
            type,
            date: first("date"),
            force: first("force"),
            eli: first("eli"),
          }),
          hvj_arresten: caseLaw.ok ? caseLaw.value.items : null,
          hvj_arresten_total: caseLaw.ok ? caseLaw.value.total : null,
          amended_by: changes.ok ? changes.value.amendedBy : null,
          amended_by_total: changes.ok ? changes.value.amendedByTotal : null,
          repealed_by: changes.ok ? changes.value.repealedBy : null,
        },
      ],
      total: 1,
      endpoint: SPARQL_ENDPOINT,
      params,
      access_note: ACCESS_NOTE_BASE + caseLawNote + changesNote,
    };
  }

  async nlTransposition(args: { id: string; limit: number }): Promise<EuCellarResult> {
    const celex = requireCelex(args.id);
    if (celex[5] !== "L") {
      throw new Error(
        `${celex} is geen richtlijn; nationale omzettingsmaatregelen bestaan alleen voor richtlijnen (verordeningen gelden rechtstreeks).`,
      );
    }
    const limit = Math.max(1, Math.min(Math.floor(args.limit) || 1, this.config.limits.maxRows));

    // Group per measure: several OPTIONAL values would otherwise multiply the rows
    // and let LIMIT cut measures off.
    const sparql = `SELECT ?nimcelex (SAMPLE(?t) AS ?title) (SAMPLE(?ta) AS ?typeAct) (SAMPLE(?o) AS ?oj)
       (SAMPLE(?on) AS ?ojnum) (MAX(?od) AS ?ojdate) (MAX(?nd) AS ?notif) WHERE {
  ?w cdm:resource_legal_id_celex "${celex}"^^xsd:string .
  ?nim cdm:measure_national_implementing_implements_resource_legal ?w ;
       cdm:measure_national_implementing_implemented_by_country <${COUNTRY_NLD}> ;
       cdm:resource_legal_id_celex ?nimcelex .
  OPTIONAL { ?nim cdm:work_title ?t }
  OPTIONAL { ?nim cdm:measure_national_implementing_type_act ?ta }
  OPTIONAL { ?nim cdm:measure_national_implementing_name_official_journal ?o }
  OPTIONAL { ?nim cdm:measure_national_implementing_number_official_journal ?on }
  OPTIONAL { ?nim cdm:measure_national_implementing_date_official_journal ?od }
  OPTIONAL { ?nim cdm:measure_national_implementing_date_notification ?nd }
} GROUP BY ?nimcelex ORDER BY DESC(?ojdate) ?nimcelex LIMIT ${limit}`;

    const rows = await this.select(sparql);
    const eurlexUrl = EURLEX_NL + celex;
    const seen = new Set<string>();
    const items: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const nimCelex = val(row, "nimcelex");
      if (!nimCelex || seen.has(nimCelex)) continue;
      seen.add(nimCelex);
      const ojDate = val(row, "ojdate");
      const typeAct = val(row, "typeAct");
      const { identifier, journal } = bekendmakingId(val(row, "oj"), val(row, "ojnum"), ojDate, typeAct);
      items.push({
        directive_celex: celex,
        title: val(row, "title") ?? null,
        measure_type: typeAct ?? null,
        official_journal: journal,
        identifier,
        publication_date: ojDate ? ojDate.slice(0, 10) : null,
        notification_date: val(row, "notif")?.slice(0, 10) ?? null,
        canonical_url: identifier ? `${OB_BASE}${identifier}.html` : eurlexUrl,
      });
    }

    const note =
      items.length === 0
        ? ` Voor richtlijn ${celex} zijn in CELLAR geen Nederlandse omzettingsmaatregelen genotificeerd (of de richtlijn bestaat niet).`
        : " Omzettingsmaatregelen zoals door Nederland aan de Commissie genotificeerd; de identifier (stb-/stcrt-) is afgeleid van publicatieblad en nummer.";

    return {
      items,
      total: items.length < limit ? items.length : null,
      endpoint: SPARQL_ENDPOINT,
      params: { id: args.id, celex, limit: String(limit) },
      access_note: ACCESS_NOTE_BASE + note,
    };
  }
}
