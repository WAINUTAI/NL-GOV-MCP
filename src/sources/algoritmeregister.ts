import type { AppConfig } from "../types.js";
import { getJson, postJson, SourceRequestError } from "../utils/http.js";
import { htmlToText } from "../utils/html-text.js";
import { placeKey, placeVariants } from "../utils/place-aliases.js";

/**
 * Algoritmeregister van de Nederlandse overheid (algoritmes.overheid.nl), run by the
 * Ministry of BZK. Open JSON API without key or account; its OpenAPI description is
 * published at https://algoritmes.overheid.nl/api/openapi.json and the code lives at
 * github.com/MinBZK/algoritmeregister.
 *
 * Search is a POST with a JSON body (AlgoritmeQuery). The `organisation` filter only
 * accepts the register's own org_id ("gm0344"), so organisation names are resolved
 * first via the organisation overview endpoint.
 */
const SITE = "https://algoritmes.overheid.nl";
export const ALGORITMEREGISTER_SEARCH_ENDPOINT = `${SITE}/api/algoritme/NLD`;
export const ALGORITMEREGISTER_ORG_ENDPOINT = `${SITE}/api/organisation/NLD`;
const ORG_RELATION_ENDPOINT = `${SITE}/api/organisation-relation`;
const ORG_CODE_ENDPOINT = `${SITE}/api/organisation`;
const SUGGESTION_ENDPOINT = `${SITE}/api/suggestion/NLD`;
const CONNECTOR = "algoritmeregister";
const TIMEOUT_MS = 15_000;

/** Upstream page-size cap: AlgoritmeQuery.limit has maximum 100 (HTTP 422 above it). */
export const ALGORITMEREGISTER_MAX_ROWS = 100;
export const ALGORITMEREGISTER_DEFAULT_ROWS = 20;
/** How many organisation candidates to fetch when resolving a name. */
const ORG_CANDIDATE_ROWS = 25;
/** How many alternatives/candidates to name in the access note. */
const ORG_ALTERNATIVES_SHOWN = 5;
const ORG_AMBIGUOUS_SHOWN = 10;
/** How many look-alikes a not-found summary names. */
const SUMMARY_LOOKALIKES = 3;

/** Status values of the register standard; any other value silently yields 0 upstream. */
export const ALGORITME_STATUSSEN = ["In gebruik", "In ontwikkeling", "Buiten gebruik"] as const;

/** Publication categories of the register (field publication_category). */
export const ALGORITME_PUBLICATIECATEGORIEEN = [
  "Hoog-risico AI-systeem",
  "Impactvolle algoritmes",
  "Overige algoritmes",
] as const;

/**
 * OrgType enum from the register's OpenAPI description (filter `organisationtype`),
 * minus the values the register itself cannot handle.
 */
export const ALGORITME_ORGANISATIETYPES = [
  "adviescollege",
  "agentschap",
  "brandweer",
  "caribisch_openbaar_lichaam",
  "gemeenschappelijke_regeling",
  "gemeente",
  "grensoverschrijdend_gemeenschappelijke_regeling",
  "grensoverschrijdend_regionaal_samenwerkingsorgaan",
  "hoog_college_van_staat",
  "inspectie",
  "interdepartementale_commissie",
  "kabinet_van_de_koning",
  "koepelorganisatie",
  "ministerie",
  "omgevingsdienst",
  "openbaar_lichaam_voor_beroep_en_bedrijf",
  "organisatie_met_overheidsbemoeienis",
  "organisatieonderdeel",
  "politie",
  "provinciale_rekenkamer",
  "provincie",
  "rechtspraak",
  "regionaal_samenwerkingsorgaan",
  "veiligheidsregio",
  "waterschap",
  "zelfstandig_bestuursorgaan",
  "overig",
  "nationaal_overig",
] as const;

/**
 * In the OpenAPI enum but answered with HTTP 500 by the register (no label in its
 * org_type_mapping). Each such call is retried and counts toward the circuit breaker,
 * so a few of them would make the whole tool unavailable; they are not offered.
 */
export const ALGORITME_ORGANISATIETYPES_BROKEN = ["ggdregio", "regionaal_samenwerkingsverband"] as const;

/**
 * Themes (field `category`) that occur in the register. The API types the filter as a
 * free string and answers an unknown value with 0 results, so input is matched against
 * this list case- and accent-insensitively; an unknown value is still passed on (the
 * register may add themes) but flagged in the access note.
 */
export const ALGORITME_CATEGORIEEN = [
  "Cultuur en recreatie",
  "Economie",
  "Internationaal",
  "Migratie en integratie",
  "Natuur en milieu",
  "Onderwijs en wetenschap",
  "Openbare orde en veiligheid",
  "Organisatie en bedrijfsvoering",
  "Overheidsfinanciën",
  "Recht",
  "Ruimte en infrastructuur",
  "Sociale zekerheid",
  "Verkeer",
  "Werk",
  "Wonen",
  "Zorg en gezondheid",
] as const;

export type AlgoritmeStatus = (typeof ALGORITME_STATUSSEN)[number];
export type AlgoritmePublicatiecategorie = (typeof ALGORITME_PUBLICATIECATEGORIEEN)[number];
export type AlgoritmeOrganisatietype = (typeof ALGORITME_ORGANISATIETYPES)[number];

export interface AlgoritmeItem {
  /** LARS code: the register's stable id of the algorithm. */
  id: string;
  title: string;
  organisation: string;
  organisation_id: string;
  organisation_code?: string;
  department?: string;
  description_short: string;
  status: string;
  publication_category: string;
  category: string[];
  type?: string;
  provider?: string;
  impact_assessments: string[];
  begin_date?: string;
  end_date?: string;
  /** Publication timestamp of the current version (create_dt). */
  published_at?: string;
  url: string;
  organisation_url?: string;
}

export interface OrganisationCandidate {
  org_id: string;
  name: string;
  code?: string;
  /** Published algorithms; for an organisation with children this includes them. */
  count?: number;
  type?: string;
  has_children?: boolean;
}

export interface OrganisationResolution {
  input: string;
  status: "resolved" | "ambiguous" | "not_found";
  /** How the input matched: exact name, name without type prefix, partial name, org_id or register code. */
  match?: "exact" | "naam" | "deel" | "org_id" | "code";
  organisation?: OrganisationCandidate;
  /** Other matching organisations (resolved) or all candidates (ambiguous). */
  alternatives: OrganisationCandidate[];
  /** Number of matching organisations upstream (may exceed alternatives.length). */
  candidate_total: number;
  /** Organisations known to the register under this name but without published algorithms. */
  without_algorithms: string[];
  /**
   * Organisations without published algorithms whose name merely resembles the input
   * (contains it or shares words); never presented as the organisation asked for.
   */
  similar_without_algorithms?: string[];
}

export interface AlgoritmeregisterSearchArgs {
  query?: string;
  organisatie?: string;
  status?: AlgoritmeStatus;
  publicatiecategorie?: AlgoritmePublicatiecategorie;
  categorie?: string;
  organisatietype?: AlgoritmeOrganisatietype;
  includeChildren?: boolean;
  offset?: number;
  limit?: number;
}

export interface AlgoritmeregisterSearchResult {
  items: AlgoritmeItem[];
  /** Total matches upstream; null when no search ran (ambiguous organisation). */
  total: number | null;
  offset: number;
  limit: number;
  query: string;
  /**
   * True when the register found no exact match for the keywords (within the
   * organisation and filters) and answered with its similarity (fuzzy) fallback.
   */
  fuzzy?: boolean;
  /**
   * Set together with `fuzzy`: true when the register confirmed that no exact match
   * exists, false when it is inferred from none of the results containing the keywords.
   */
  fuzzy_certain?: boolean;
  categorie?: { value: string; known: boolean };
  filters: Record<string, string>;
  organisation?: OrganisationResolution;
  endpoint: string;
  params: Record<string, string>;
  access_note: string;
}

export function clampAlgoritmeRows(limit: number | null | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return ALGORITMEREGISTER_DEFAULT_ROWS;
  return Math.min(ALGORITMEREGISTER_MAX_ROWS, Math.max(1, Math.floor(limit)));
}

function clampOffset(offset: number | null | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
}

/**
 * Map an arbitrary offset/limit window onto the register's page/limit paging.
 *
 * Upstream only knows `page` (1-based) and `limit` (<= 100), so a window that does not
 * start on a page boundary is served by the smallest page size that holds it in one
 * page (offset 0/20/40 with limit 20 → page size 20, no waste). Only when no single
 * page of at most 100 can hold it are two consecutive pages of 100 fetched.
 */
export function planAlgoritmeWindow(
  offset: number,
  limit: number,
): { pageSize: number; pages: number[]; skip: number } {
  const off = clampOffset(offset);
  const lim = clampAlgoritmeRows(limit);
  const last = off + lim - 1;
  for (let size = lim; size <= ALGORITMEREGISTER_MAX_ROWS; size++) {
    if (Math.floor(off / size) === Math.floor(last / size)) {
      return { pageSize: size, pages: [Math.floor(off / size) + 1], skip: off % size };
    }
  }
  const max = ALGORITMEREGISTER_MAX_ROWS;
  const first = Math.floor(off / max) + 1;
  const lastPage = Math.floor(last / max) + 1;
  const pages: number[] = [];
  for (let p = first; p <= lastPage; p++) pages.push(p);
  return { pageSize: max, pages, skip: off - (first - 1) * max };
}

/** Public page of one algorithm; the site redirects it to the canonical slug URL. */
export function algoritmeUrl(lars: string): string {
  return `${SITE}/nl/algoritme/${encodeURIComponent(lars)}`;
}

/** Public page of one organisation; the site redirects it to the canonical slug URL. */
export function organisatieUrl(orgId: string): string {
  return `${SITE}/nl/organisatie/${encodeURIComponent(orgId)}`;
}

/** Lowercase, strip accents and collapse whitespace so "Financien" matches "Financiën". */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019`\u00b4]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Type prefixes in register names. "Utrecht" should match "Gemeente Utrecht" more
// strongly than "Omgevingsdienst regio Utrecht", which only contains the word, and
// "Rijnland" should match "Hoogheemraadschap van Rijnland".
const ORG_TYPE_WORDS = "gemeente|provincie|waterschap|hoogheemraadschap|wetterskip|ministerie|veiligheidsregio|ggd";
const ORG_TYPE_PREFIX = new RegExp(`^(${ORG_TYPE_WORDS})\\s+(?:van\\s+)?`);
const ORG_TYPE_PREFIX_ANY_CASE = new RegExp(ORG_TYPE_PREFIX.source, "i");
const ORG_TYPE_ONLY = new RegExp(`^(?:${ORG_TYPE_WORDS})$`);

/** Water boards carry three type words; "Waterschap Rijnland" means "Hoogheemraadschap van Rijnland". */
function orgTypeClass(typeWord: string): string {
  return typeWord === "hoogheemraadschap" || typeWord === "wetterskip" ? "waterschap" : typeWord;
}

/** A folded name split into its type word (if any; `type` is its class) and the rest. */
function orgNameParts(folded: string): { type?: string; typeWord?: string; bare: string } {
  const m = folded.match(ORG_TYPE_PREFIX);
  if (!m) return { bare: folded };
  const bare = folded.slice(m[0].length).trim();
  return bare ? { type: orgTypeClass(m[1]), typeWord: m[1], bare } : { bare: folded };
}

// Short function words carry no information for telling organisations apart.
const ORG_FILLER_WORDS = new Set(["van", "de", "het", "der", "en", "voor", "op", "in", "te"]);

function nameWords(folded: string): string[] {
  return folded.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
}

/**
 * The register's organisation search matches stems ("Rijnland" finds "Rijnlanden"),
 * other text about the organisation and, without any exact hit, similar words (a
 * two-word place name can find another municipality that shares one word). A
 * candidate that is neither the name nor contains every input word as a whole word
 * is therefore not evidence that the input means that organisation.
 *
 * Input of filler words only ("Ministerie van") rules nothing out. Input of single
 * letters ("I&W", "J & V") does: those letters are what it names, and no whole word
 * matches them, so it is left to the abbreviation check instead of fitting everything.
 */
function containsAllWords(inputBare: string, candidateFolded: string): boolean {
  const wanted = nameWords(inputBare).filter((w) => !ORG_FILLER_WORDS.has(w));
  if (!wanted.length) return !inputBare.split(/[^\p{L}\p{N}]+/u).some((w) => w.length === 1 && /\p{L}/u.test(w));
  const have = new Set(nameWords(candidateFolded));
  return wanted.every((w) => have.has(w));
}

/** Whether a candidate shares the start of a word with the input ("Rijnland" / "Rijnlanden"). */
function sharesWordStart(inputBare: string, candidateFolded: string): boolean {
  const have = nameWords(candidateFolded);
  return nameWords(inputBare)
    .filter((w) => w.length >= 3 && !ORG_FILLER_WORDS.has(w))
    .some((w) => have.some((h) => h.startsWith(w)));
}

interface AbbreviationToken {
  /** Lower-case letters of the abbreviation, without '&' and '+'. */
  token: string;
  /** Type class the input names ("Ministerie van VWS", "MinEZK" → ministerie). */
  type?: string;
  /** The abbreviation as typed (accents removed), for its capitals: "IenW", "I&W". */
  cased: string;
}

/** 2 to 6 letters, '&' and '+' allowed between them ("VWS", "IenW", "I&W"). */
function isShortTerm(value: string): boolean {
  return /^[\p{L}&+]{2,6}$/u.test(value) && value.replace(/[&+]/g, "").length >= 2;
}

/**
 * The input as a possible abbreviation: one short token after an optional type word
 * ("Ministerie van VWS" → "vws"). "Min" in front of it ("MinEZK", "Min. JenV",
 * "Min IenW", "minfin") is the everyday short form of "Ministerie van"; "Minist" is
 * the word itself cut short, not that form.
 */
function abbreviationToken(raw: string): AbbreviationToken | undefined {
  const cased = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*([&+])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const min = cased.match(/^min\.?\s*(.+)$/i);
  if (min && isShortTerm(min[1]) && !"ministerie".startsWith(cased.toLowerCase().replace(/[^a-z]/g, ""))) {
    return { token: min[1].toLowerCase().replace(/[&+]/g, ""), type: "ministerie", cased: min[1] };
  }
  const prefix = cased.match(ORG_TYPE_PREFIX_ANY_CASE);
  const bare = prefix ? cased.slice(prefix[0].length) : cased;
  if (!isShortTerm(bare)) return undefined;
  return {
    token: bare.toLowerCase().replace(/[&+]/g, ""),
    ...(prefix ? { type: orgTypeClass(prefix[1].toLowerCase()) } : {}),
    cased: bare,
  };
}

/**
 * Everyday abbreviations of the ministries that publish in the register, by org_id.
 * The official ones were checked against the abbreviation TOOI gives that org_id
 * (tooiont:afkorting: "OCW", "IenW", "LVVN", "AenM") or the register's own code for it
 * ("ministerie-buza", "ministerie-lnv"); "EZ" is Economische Zaken, which the register
 * only has as EZK. "SoZaWe" and "BiZa" are the common short names of Sociale Zaken en
 * Werkgelegenheid and Binnenlandse Zaken (BuZa is Buitenlandse Zaken); listed so that
 * they are understood alone ("SoZaWe") and in lower case too ("minsozawe"), where
 * namesMinistry cannot tell the words apart. Keys are written as abbreviationToken
 * reduces them: lower case, without '&' and '+' ("I&W" → "iw", "OC&W" → "ocw").
 *
 * The register's organisation search finds such a form only by chance: "MinOCW" and
 * "Ministerie van OCW" find the Inspectie van het Onderwijs (OCW), "MinEZK" finds BZK,
 * and "Ministerie van A&M" lists every ministry, of which the letters fit Algemene
 * Zaken. A ministry form ("MinOCW", "Min. OCW", "Ministerie van OCW") in this table is
 * therefore resolved through it, never by letters that happen to fit a name; any other
 * ministry form only when it names one ministry outright (see pickMinistry).
 */
const MINISTRY_BY_ABBREVIATION = new Map<string, string>([
  ["az", "mnre1010"],
  ["bz", "mnre1013"],
  ["buza", "mnre1013"],
  ["def", "mnre1018"],
  ["vws", "mnre1025"],
  ["bzk", "mnre1034"],
  ["biza", "mnre1034"],
  ["ezk", "mnre1045"],
  ["ez", "mnre1045"],
  ["jenv", "mnre1058"],
  ["jv", "mnre1058"],
  ["szw", "mnre1073"],
  ["sozawe", "mnre1073"],
  ["fin", "mnre1090"],
  ["ocw", "mnre1109"],
  ["ocenw", "mnre1109"],
  ["ienw", "mnre1130"],
  ["iw", "mnre1130"],
  ["lnv", "mnre1153"],
  ["lvvn", "mnre1153"],
  ["aenm", "mnre1162"],
  ["am", "mnre1162"],
  ["vro", "mnre1171"],
]);

/**
 * Without "Min" or "Ministerie van" in front, only these name a ministry unmistakably;
 * "Fin", "Def", "AZ" or "I&W" alone are left to the organisation search.
 */
const BARE_MINISTRY_ABBREVIATIONS = new Set(["buza", "biza", "vws", "bzk", "ezk", "jenv", "szw", "sozawe", "ocw", "ocenw", "ienw", "lnv", "lvvn", "aenm", "vro"]);

/**
 * The ministry `raw` abbreviates according to MINISTRY_BY_ABBREVIATION: `typed` when
 * it carries the ministry's type word ("MinOCW", "Ministerie van OCW"), otherwise only
 * for the unmistakable bare forms ("OCW").
 */
function ministryByAbbreviation(raw: string): { orgId: string; token: string; typed: boolean } | undefined {
  const abbr = abbreviationToken(raw);
  if (!abbr || (abbr.type && abbr.type !== "ministerie")) return undefined;
  const orgId = MINISTRY_BY_ABBREVIATION.get(abbr.token);
  if (!orgId) return undefined;
  const typed = abbr.type === "ministerie";
  return typed || BARE_MINISTRY_ABBREVIATIONS.has(abbr.token) ? { orgId, token: abbr.token, typed } : undefined;
}

/** Whether `letters` occur in this order in `text`. */
function isSubsequence(letters: string, text: string): boolean {
  let i = 0;
  for (const ch of text) if (ch === letters[i]) i++;
  return i >= letters.length;
}

/**
 * Where the abbreviation is written in mixed case ("IenW", "RvIG", "VenJ"), each
 * capital starts a later word of the name, or falls inside the word the previous
 * capital started ("G" in "Identiteitsgegevens"). "VenJ" is then no abbreviation of
 * "Volksgezondheid, Welzijn en Sport". All capitals, or one, tell nothing.
 */
function capitalsFit(cased: string, words: string[]): boolean {
  const letters = [...cased.replace(/[^\p{L}]/gu, "")];
  const capitals = letters.filter((c) => c !== c.toLowerCase()).map((c) => c.toLowerCase());
  if (capitals.length < 2 || capitals.length === letters.length) return true;
  let word = -1;
  let pos = -1;
  for (const c of capitals) {
    const next = words.findIndex((w, i) => i > word && w[0] === c);
    if (next >= 0) {
      word = next;
      pos = 0;
      continue;
    }
    const inner = word >= 0 ? words[word].indexOf(c, pos + 1) : -1;
    if (inner <= 0) return false;
    pos = inner;
  }
  return true;
}

/**
 * An abbreviation the register's organisation search resolved to this candidate
 * ("UWV", "uwv", "IenW", "RvIG", "Ministerie van VWS"), in any case: its letters occur
 * in order in the name, starting at the start of a word, and its capitals fit (see
 * capitalsFit). Not when the token is the start of a word in the name (the search
 * prefix-matches, so "OM" finds "Gemeente Ommen" and "Venl" finds "Gemeente Venlo"),
 * nor when it is a misspelling of one word ("Weet" / "Weert").
 *
 * A type word in the input ("Ministerie van", or "Min" as in "MinEZK") must match the
 * candidate's type, and the abbreviation is then sought in the rest of the name:
 * "MinVRO" is not "Ministerie *v*an Landbouw, Natuu*r* en V*o*edselkwaliteit". Only an
 * abbreviation that starts with the type word's letter may use it ("Hoogheemraadschap
 * HHNK"). After a ministry's type word the start of a word does count ("MinFin").
 */
function isAbbreviationOf(raw: string, candidateName: string): boolean {
  const abbr = abbreviationToken(raw);
  if (!abbr) return false;
  const name = fold(candidateName);
  const parts = orgNameParts(name);
  if (abbr.type && abbr.type !== parts.type) return false;
  const { token } = abbr;
  const all = nameWords(name);
  const prefixAllowed = abbr.type === "ministerie";
  if (all.some((w) => (!prefixAllowed && w.startsWith(token)) || (w.length - token.length <= 2 && isSubsequence(token, w)))) return false;
  const scopes = abbr.type ? [nameWords(parts.bare), ...(parts.typeWord?.[0] === token[0] ? [all] : [])] : [all];
  return scopes.some(
    (words) =>
      capitalsFit(abbr.cased, words) &&
      words.some((w, i) => w[0] === token[0] && isSubsequence(token.slice(1), words.slice(i).join("").slice(1))),
  );
}

/**
 * Whether a ministry form (`cased`: "Jus", "SoZaWe") names this ministry outright,
 * rather than with letters that merely occur in its name in order (isAbbreviationOf):
 *
 * - its letters, at least three, start one word of the name: "Jus" (Justitie),
 *   "Ond" (Onderwijs), "Financ" (Financiën);
 * - or, written with capitals, each capital starts the next word of the name, the
 *   first one its first word, and the lower-case letters after a capital continue
 *   that word ("SoZaWe": Sociale Zaken en Werkgelegenheid; "en" is skipped), except
 *   that "en", '&' or '+' must be the word "en" itself ("IenW", "OC&W").
 *
 * So "VenW" (Verkeer en Waterstaat) is not Volksgezondheid, Welzijn en Sport, as the
 * word after V is not "en", and "A&M" is not Algemene Zaken, as M starts no word.
 */
function namesMinistry(cased: string, ministryName: string): boolean {
  const words = nameWords(orgNameParts(fold(ministryName)).bare);
  const letters = fold(cased).replace(/[&+]/g, "");
  if (letters.length >= 3 && words.some((w) => !ORG_FILLER_WORDS.has(w) && w.startsWith(letters))) return true;
  const segments = cased.match(/\p{Lu}\p{Ll}*|[&+]/gu) ?? [];
  if (segments.length < 2 || segments.join("") !== cased) return false;
  const nextWord = (from: number): number => {
    let i = from;
    while (i < words.length && ORG_FILLER_WORDS.has(words[i])) i++;
    return i;
  };
  const fitsFrom = (segment: number, word: number): boolean => {
    if (segment === segments.length) return true;
    const part = fold(segments[segment]);
    if (part === "&" || part === "+") return words[word + 1] === "en" && fitsFrom(segment + 1, word + 1);
    const i = nextWord(word + 1);
    const w = words[i];
    if (w === undefined) return false;
    if (w.startsWith(part) && fitsFrom(segment + 1, i)) return true;
    const head = part.endsWith("en") ? part.slice(0, -2) : "";
    return !!head && w.startsWith(head) && words[i + 1] === "en" && fitsFrom(segment + 1, i + 1);
  };
  return fitsFrom(0, -1);
}

/**
 * 3: exact name, org_id or code; 2: the same name apart from the type word, and the
 * same type when the input names one; 1: contains every input word, and the type the
 * input names ("Veiligheidsregio Flevoland" is not "Provincie Flevoland"); 0: only matched
 * on something else (see containsAllWords).
 */
function scoreCandidate(raw: string, c: OrganisationCandidate): number {
  const target = fold(raw);
  const name = fold(c.name);
  const lower = raw.toLowerCase();
  if (name === target || c.org_id.toLowerCase() === lower || (c.code ?? "").toLowerCase() === lower) return 3;
  const input = orgNameParts(target);
  const cand = orgNameParts(name);
  const sameType = !input.type || input.type === cand.type;
  if (cand.bare === input.bare && sameType) return 2;
  const typeNamed = sameType || nameWords(name).includes(input.typeWord ?? "");
  return typeNamed && containsAllWords(input.bare, name) ? 1 : 0;
}

/** A resolved match on the name itself, not merely a name containing the input. */
function isNameMatch(r: OrganisationResolution): boolean {
  return r.status === "resolved" && (r.match === "exact" || r.match === "naam");
}

/** On a tie a bare place name means the municipality first, then the province. */
function placeTypeRank(folded: string): number {
  if (folded.startsWith("gemeente ")) return 0;
  if (folded.startsWith("provincie ")) return 1;
  return 2;
}

/**
 * Other names for the same place that the register may use instead: the register
 * has "Gemeente 's-Hertogenbosch" and "Provincie Fryslân", while people type
 * "Den Bosch" and "Friesland". Punctuation-only variants are left out, the
 * organisation search already tolerates those.
 */
function placeAliases(bare: string): string[] {
  const seen = new Set([placeKey(bare)]);
  const out: string[] = [];
  for (const variant of placeVariants(bare)) {
    const key = placeKey(variant);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(variant);
  }
  return out;
}

export function normalizeAlgoritmeCategorie(value: string): { value: string; known: boolean } {
  const trimmed = value.replace(/\s+/g, " ").trim();
  const target = fold(trimmed);
  const hit = ALGORITME_CATEGORIEEN.find((c) => fold(c) === target);
  return hit ? { value: hit, known: true } : { value: trimmed, known: false };
}

/**
 * Pick the organisation meant by `input` from the register's candidates (upstream
 * order: most algorithms first).
 *
 * Exact name, org_id or code beats a name that matches once its type prefix is dropped
 * ("Utrecht" → "Gemeente Utrecht"), which beats a name containing every input word.
 * On a tie the municipality wins, then the province, since a bare place name most
 * often means the gemeente; the other candidates are returned so the caller can say
 * what else matched. Several partial matches and nothing better is ambiguous: guessing
 * "Gemeente Amsterdam" for "gemeente" would present a guess as the answer.
 *
 * Candidates that contain none of that (the register matched them on stems, other text
 * or similar words) are never chosen, except one candidate for an abbreviation such
 * as "CBS", or the one organisation of the named type a typed abbreviation fits
 * ("Hoogheemraadschap HHNK"); otherwise the result is not_found with those candidates
 * as alternatives, so "West Betuwe" does not turn into "Gemeente Neder-Betuwe".
 *
 * A ministry form ("MinOCW", "Ministerie van JenV") resolves only to the ministry
 * MINISTRY_BY_ABBREVIATION gives for it, and only when that one is among the
 * candidates. For a ministry form the table does not know, the ministries its letters
 * fit are named, not chosen ("Ministerie van VenW" is not VWS): whether it names one
 * ministry outright can only be told from the list of all ministries (pickMinistry).
 */
export function pickOrganisation(
  input: string,
  candidates: OrganisationCandidate[],
  candidateTotal = candidates.length,
): OrganisationResolution {
  const raw = input.trim();
  const none: OrganisationResolution = { input: raw, status: "not_found", alternatives: [], candidate_total: 0, without_algorithms: [] };
  const ministry = ministryByAbbreviation(raw);
  if (ministry?.typed) {
    const hit = candidates.find((c) => c.org_id === ministry.orgId);
    return hit ? { input: raw, status: "resolved", match: "deel", organisation: hit, alternatives: [], candidate_total: 1, without_algorithms: [] } : none;
  }
  const scored = candidates.map((c, index) => ({
    c,
    score: scoreCandidate(raw, c),
    rank: placeTypeRank(fold(c.name)),
    index,
  }));
  if (!scored.length) return none;

  const best = Math.max(...scored.map((s) => s.score));
  if (best === 0) {
    const abbr = abbreviationToken(raw);
    if (abbr) {
      // The register's single answer for a short token: taken when it is an abbreviation
      // of that name, otherwise named as a look-alike ("OM" → Gemeente Ommen). After a
      // type word the search lists every organisation of that type ("Hoogheemraadschap
      // HHNK"); then the one it abbreviates is taken, if the list is complete and there
      // is exactly one. Ministries are the exception (see above): fitting letters only
      // make a look-alike.
      const fits = scored.filter((s) => isAbbreviationOf(raw, s.c.name));
      const complete = candidateTotal <= candidates.length;
      if (abbr.type === "ministerie") {
        if (fits.length) return { ...none, alternatives: fits.slice(0, ORG_ALTERNATIVES_SHOWN).map((s) => s.c) };
      } else if (fits.length === 1 && (scored.length === 1 || (abbr.type && complete))) {
        return { input: raw, status: "resolved", match: "deel", organisation: fits[0].c, alternatives: [], candidate_total: 1, without_algorithms: [] };
      }
      if (scored.length === 1) return { ...none, alternatives: [scored[0].c] };
    }
    // A handful of look-alikes sharing a word with the input is worth naming; a long
    // list, or one matched on the type word only, is the fuzzy fallback's noise.
    if (candidateTotal > ORG_ALTERNATIVES_SHOWN) return none;
    const inputBare = orgNameParts(fold(raw)).bare;
    return { ...none, alternatives: candidates.filter((c) => sharesWordStart(inputBare, fold(c.name))).slice(0, ORG_ALTERNATIVES_SHOWN) };
  }

  const matching = scored.filter((s) => s.score > 0);
  // Only when every candidate matched is the upstream total a count of matches.
  const total = matching.length === candidates.length ? Math.max(candidateTotal, candidates.length) : matching.length;
  if (best === 1 && matching.length > 1) {
    return {
      input: raw,
      status: "ambiguous",
      alternatives: matching.slice(0, ORG_AMBIGUOUS_SHOWN).map((s) => s.c),
      candidate_total: total,
      without_algorithms: [],
    };
  }

  const top = matching
    .filter((s) => s.score === best)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)[0];
  return {
    input: raw,
    status: "resolved",
    match: best === 3 ? "exact" : best === 2 ? "naam" : "deel",
    organisation: top.c,
    alternatives: matching.filter((s) => s !== top).slice(0, ORG_ALTERNATIVES_SHOWN).map((s) => s.c),
    candidate_total: total,
    without_algorithms: [],
  };
}

/**
 * Pick the ministry meant by `input` from the register's complete list of ministries
 * (organisationtype 'ministerie'), as pickOrganisation does, plus one case only that
 * list can settle: a ministry form the table of abbreviations does not know ("MinJus",
 * "MinOnd", "Ministerie van Financ") is taken when exactly one ministry has a name it
 * names outright (see namesMinistry). Several such ministries ("MinVol": Volksgezondheid
 * and Volkshuisvesting) are named first among the look-alikes; none chosen.
 */
export function pickMinistry(
  input: string,
  ministries: OrganisationCandidate[],
  total = ministries.length,
): OrganisationResolution {
  const picked = pickOrganisation(input, ministries, total);
  const abbr = abbreviationToken(picked.input);
  if (picked.status !== "not_found" || abbr?.type !== "ministerie" || ministryByAbbreviation(picked.input)) return picked;
  if (total > ministries.length) return picked;
  const named = ministries.filter((c) => namesMinistry(abbr.cased, c.name));
  if (named.length === 1) {
    return { input: picked.input, status: "resolved", match: "deel", organisation: named[0], alternatives: [], candidate_total: 1, without_algorithms: [] };
  }
  const alternatives = [...named, ...picked.alternatives.filter((c) => !named.includes(c))];
  return { ...picked, alternatives: alternatives.slice(0, ORG_ALTERNATIVES_SHOWN) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value === "string") {
    const t = value.trim();
    // Placeholders such as "-" (seen in begin_date) carry no value.
    return /[\p{L}\p{N}]/u.test(t) ? t : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Text fields may hold HTML (the register stores rich text); keep plain text only. */
function text(value: unknown): string | undefined {
  const s = str(value);
  if (!s) return undefined;
  const plain = htmlToText(s);
  return plain || undefined;
}

function toCandidate(value: unknown): OrganisationCandidate | undefined {
  const o = asRecord(value);
  const orgId = str(o?.org_id);
  const name = str(o?.name);
  if (!o || !orgId || !name) return undefined;
  return {
    org_id: orgId,
    name,
    code: str(o.code),
    count: typeof o.count === "number" ? o.count : undefined,
    type: str(o.roo_type),
    has_children: typeof o.has_children === "boolean" ? o.has_children : undefined,
  };
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => text(v)).filter((v): v is string => !!v);
  const single = text(value);
  return single ? [single] : [];
}

function impactAssessments(row: Record<string, unknown>): string[] {
  const grouped = Array.isArray(row.impacttoetsen_grouping)
    ? row.impacttoetsen_grouping
        .map((g) => text(asRecord(g)?.title))
        .filter((t): t is string => !!t)
    : [];
  if (grouped.length) return [...new Set(grouped)];
  // Older entries carry the list itself in `impacttoetsen`; as a string it is free
  // text about the assessments, not a list, and is left out.
  return Array.isArray(row.impacttoetsen) ? stringList(row.impacttoetsen) : [];
}

export function toAlgoritmeItem(value: unknown): AlgoritmeItem | undefined {
  const row = asRecord(value);
  const lars = str(row?.lars);
  if (!row || !lars) return undefined;
  const orgId = str(row.org_id) ?? "";
  const item: AlgoritmeItem = {
    id: lars,
    title: text(row.name) ?? text(row.preferred_name) ?? `Algoritme ${lars}`,
    organisation: text(row.organization) ?? "",
    organisation_id: orgId,
    description_short: text(row.description_short) ?? "",
    status: str(row.status) ?? "",
    publication_category: str(row.publication_category) ?? "",
    category: stringList(row.category),
    impact_assessments: impactAssessments(row),
    url: algoritmeUrl(lars),
  };
  const optional: Array<[keyof AlgoritmeItem, string | undefined]> = [
    ["organisation_url", orgId ? organisatieUrl(orgId) : undefined],
    ["organisation_code", str(row.code)],
    ["department", text(row.department)],
    ["type", text(row.type)],
    ["provider", text(row.provider)],
    ["begin_date", str(row.begin_date)],
    ["end_date", str(row.end_date)],
    ["published_at", str(row.create_dt)],
  ];
  for (const [key, v] of optional) if (v) (item as unknown as Record<string, unknown>)[key] = v;
  return item;
}

function asQueryResponse(
  data: unknown,
  endpoint: string,
): { results: unknown[]; total: number; organisationName?: string } {
  const o = asRecord(data);
  if (!o || !Array.isArray(o.results) || typeof o.total_count !== "number") {
    throw new SourceRequestError({
      message: "Algoritmeregister gaf een onverwacht antwoord (geen results/total_count).",
      endpoint,
      code: "malformed_response",
    });
  }
  // selected_filters echoes the organisation filter as the register's display name
  // when the org_id is known ("gm0180" → "Gemeente Staphorst").
  const selected = Array.isArray(o.selected_filters) ? o.selected_filters : [];
  const orgFilter = selected.map(asRecord).find((f) => f?.key === "organisation");
  return { results: o.results, total: o.total_count, organisationName: str(orgFilter?.value) };
}

function algoritmes(n: number): string {
  return `${n} ${n === 1 ? "algoritme" : "algoritmes"}`;
}

function describeCandidate(c: OrganisationCandidate): string {
  return `${c.name} (${c.org_id}${typeof c.count === "number" ? `, ${algoritmes(c.count)}` : ""})`;
}

function organisationNote(r: OrganisationResolution, includeChildren: boolean, childrenSeen = false): string {
  if (r.status === "ambiguous") {
    const more = r.candidate_total > r.alternatives.length ? ` (${r.alternatives.length} van ${r.candidate_total} getoond)` : "";
    return (
      `Organisatie '${r.input}' is niet eenduidig; er is niet gezocht. Passende organisaties${more}: ` +
      `${r.alternatives.map(describeCandidate).join("; ")}. Geef de volledige naam of de org_id als organisatie.` +
      (r.without_algorithms.length ? ` Zonder gepubliceerde algoritmes: ${r.without_algorithms.join("; ")}.` : "")
    );
  }
  if (r.status === "not_found") {
    const parts = [`Geen organisatie met gepubliceerde algoritmes gevonden voor '${r.input}'.`];
    if (r.without_algorithms.length) {
      parts.push(`Wel in het register bekend, maar zonder gepubliceerde algoritmes: ${r.without_algorithms.join("; ")}.`);
    }
    if (r.alternatives.length) {
      parts.push(
        `Organisaties met een gelijkende naam die wel algoritmes publiceren: ${r.alternatives.map(describeCandidate).join("; ")}. ` +
          "Is een daarvan bedoeld, geef dan de org_id als organisatie.",
      );
    }
    if (r.similar_without_algorithms?.length) {
      parts.push(`Gelijkende namen in het register zonder gepubliceerde algoritmes: ${r.similar_without_algorithms.join("; ")}.`);
    }
    if (!r.without_algorithms.length && !r.alternatives.length) {
      parts.push("Controleer de schrijfwijze, geef de org_id van het register of zoek zonder organisatie op trefwoord.");
    }
    return parts.join(" ");
  }
  const org = r.organisation;
  if (!org) return "";
  const parts: string[] = [];
  parts.push(
    r.match === "exact" || r.match === "org_id" || r.match === "code"
      ? `Organisatie: ${org.name} (${org.org_id}).`
      : `Organisatie '${r.input}' opgevat als ${org.name} (${org.org_id}).`,
  );
  if (r.alternatives.length) {
    parts.push(
      `Ook passend: ${r.alternatives.map(describeCandidate).join("; ")}. Geef de org_id als organisatie om een andere te kiezen.`,
    );
  }
  // has_children is unknown for an org found by id or code; results from other
  // org_ids show that children were included.
  if (org.has_children || (includeChildren && childrenSeen)) {
    parts.push(
      includeChildren
        ? `Inclusief onderliggende organisaties van ${org.name}; zet include_children=false voor alleen de organisatie zelf.`
        : `Alleen ${org.name} zelf, zonder onderliggende organisaties (include_children=false).`,
    );
  }
  return parts.join(" ");
}

const BASE_NOTE =
  "Bron: Algoritmeregister van de Nederlandse overheid (algoritmes.overheid.nl, ministerie van BZK), open API zonder sleutel. " +
  "Organisaties publiceren hun algoritmes zelf; het register is niet volledig, dus dat een algoritme ontbreekt betekent niet dat een organisatie het niet gebruikt.";

/** The suggestion endpoint returns at most this many algorithms (upstream default limit). */
const SUGGESTION_LIMIT = 10;

/** The search endpoint turns Dutch " of " into the websearch OR operator first. */
function prepSearch(query: string): string {
  return query.split(" of ").join(" or ");
}

/** An OR outside quoted phrases (websearch_to_tsquery reads "or" in any case). */
function hasOrOperator(prepped: string): boolean {
  return /(^|\s)or(\s|$)/i.test(prepped.replace(/"[^"]*"/g, " "));
}

// PostgreSQL's Dutch stop words: websearch_to_tsquery drops them, so a row need not contain them.
const DUTCH_STOPWORDS = new Set(
  (
    "de en van ik te dat die in een hij het niet zijn is was op aan met als voor had er maar om hem dan zou of wat " +
    "mijn men dit zo door over ze zich bij ook tot je mij uit der daar haar naar heb hoe heeft hebben deze u want " +
    "nog zal me zij nu ge geen omdat iets worden toch al waren veel meer doen toen moet ben zonder kan hun dus " +
    "alles onder ja eens hier wie werd altijd doch wordt wezen kunnen ons zelf tegen na reeds wil kon niets uw " +
    "iemand geweest andere"
  ).split(" "),
);

/** Doubled letters collapsed, as Dutch stemming undoubles them ("herkenn" → "herken", "maak" → "mak"). */
function squeeze(value: string): string {
  return value.replace(/(\p{L})\1+/gu, "$1");
}

// Inflection and derivation endings the Dutch Snowball stemmer removes, longest first.
const DUTCH_SUFFIXES = ["heden", "ingen", "lijke", "heid", "ende", "lijk", "baar", "bare", "end", "ing", "ene", "bar", "en", "se", "ig", "s", "e"];

/**
 * A lenient stand-in for the Dutch stem of a keyword, as a substring to look for:
 * "woningtoewijzing" → "woningtoewijz", "algoritmes" → "algoritm". It strips at
 * least as much as the stemmer, so a row the register matched contains it.
 */
function stemProbe(word: string): string {
  let w = word;
  for (let pass = 0; pass < 3; pass++) {
    const suffix = DUTCH_SUFFIXES.find((s) => w.endsWith(s) && w.length - s.length >= 3);
    if (!suffix) break;
    w = w.slice(0, -suffix.length);
  }
  return squeeze(w);
}

/**
 * The keywords as the exact search needs them: every group must match, a group
 * matches when one of its alternatives ('of'/'or') has all its words. Excluded
 * (-word) terms and stop words are left out.
 */
function queryTermGroups(query: string): string[][][] {
  const groups: string[][][] = [];
  let orNext = false;
  for (const m of prepSearch(query).matchAll(/(-?)"([^"]*)"?|(\S+)/g)) {
    const token = m[3];
    if (token !== undefined && /^or$/i.test(token)) {
      orNext = groups.length > 0;
      continue;
    }
    const negated = m[1] === "-" || (token?.startsWith("-") ?? false);
    const words = nameWords(fold(m[2] ?? token ?? "")).filter((w) => !DUTCH_STOPWORDS.has(w));
    if (!negated) {
      if (orNext) groups[groups.length - 1].push(words);
      else groups.push([words]);
    }
    orNext = false;
  }
  return groups;
}

/** All text in a result row (values only, HTML removed), folded and squeezed. */
function rowText(row: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(row);
  return squeeze(fold(parts.join(" ").replace(/<[^>]*>/g, " ")));
}

/** Whether a row plausibly matches the keywords exactly (lenient: unsure counts as yes). */
function rowMentionsTerms(row: Record<string, unknown>, groups: string[][][]): boolean {
  if (!groups.length) return true;
  const text = rowText(row);
  return groups.every((alternatives) =>
    alternatives.some((words) =>
      words.every((w) => {
        const probe = stemProbe(w);
        return probe.length < 3 || text.includes(probe);
      }),
    ),
  );
}

export class AlgoritmeregisterSource {
  constructor(private readonly config: AppConfig) {}

  /**
   * Resolve an organisation name, org_id or register code to the register's org_id.
   *
   * Order: a ministry abbreviation ("MinOCW", "Ministerie van JenV") straight from the
   * register's list of ministries; else the name search (organisations with published
   * algorithms) for the name itself, a bare ministry abbreviation ("OCW"), the
   * register's own name for the place, other ministry forms ("MinJus", "MinVenJ") in
   * the list of ministries and other spellings of an abbreviation ("I&W"), a direct
   * id/code lookup for input that looks like one, then the full organisation list
   * (which also holds organisations without published algorithms) for the name
   * itself, and only then a candidate that merely contains the input.
   */
  async resolveOrganisation(input: string): Promise<OrganisationResolution> {
    const raw = input.replace(/\s+/g, " ").trim();
    const ministry = ministryByAbbreviation(raw);
    if (ministry?.typed) return this.resolveMinistry(raw, ministry.orgId);

    const first = await this.searchOrganisations(raw);
    const picked = pickOrganisation(raw, first.candidates, first.total);
    if (isNameMatch(picked)) return picked;

    if (ministry) {
      // "VWS" finds the ministry itself; "OCW" finds only the Inspectie van het Onderwijs
      // (OCW), which carries the abbreviation in its name and is named next to it.
      if (picked.status === "resolved" && picked.organisation?.org_id === ministry.orgId) return picked;
      const ministries = await this.searchOrganisations("", "ministerie");
      const hit = ministries.candidates.find((c) => c.org_id === ministry.orgId);
      if (hit) {
        const alternatives = first.candidates
          .filter((c) => c.org_id !== hit.org_id && nameWords(fold(c.name)).includes(ministry.token))
          .slice(0, ORG_ALTERNATIVES_SHOWN);
        return { input: raw, status: "resolved", match: "deel", organisation: hit, alternatives, candidate_total: 1 + alternatives.length, without_algorithms: [] };
      }
    }

    // The register names one ministry without its type word ("Asiel en Migratie"), so
    // its official name "Ministerie van Asiel en Migratie" scored nothing against it.
    // Every entry in the register's list of ministries is a ministry: there the name
    // without the type word decides.
    const inputParts = orgNameParts(fold(raw));
    if (inputParts.type === "ministerie") {
      const ministries = await this.searchOrganisations("", "ministerie");
      const same = ministries.candidates.filter((c) => orgNameParts(fold(c.name)).bare === inputParts.bare);
      if (same.length === 1) {
        return { input: raw, status: "resolved", match: "naam", organisation: same[0], alternatives: [], candidate_total: 1, without_algorithms: [] };
      }
    }

    // The register may use another name for the place ("Den Bosch" finds Den Haag and
    // Den Helder, the register says "'s-Hertogenbosch"); try those before settling.
    const prefix = raw.match(ORG_TYPE_PREFIX_ANY_CASE);
    const typeText = prefix ? prefix[0].trim() : "";
    const bareRaw = prefix ? raw.slice(prefix[0].length).trim() : raw;
    for (const alias of placeAliases(bareRaw || raw)) {
      const viaAlias = await this.searchOrganisations(alias);
      if (!viaAlias.candidates.length) continue;
      const aliasPicked = pickOrganisation(typeText ? `${typeText} ${alias}` : alias, viaAlias.candidates, viaAlias.total);
      if (isNameMatch(aliasPicked)) return { ...aliasPicked, input: raw, match: "naam" };
    }

    if (picked.status === "not_found") {
      const viaAbbreviation = await this.resolveAbbreviation(raw);
      if (viaAbbreviation) return viaAbbreviation;
    }

    // A register id ("gm0344", "189378") or code ("gemeente-urk") does not match the
    // name search, which for a code answers with every organisation of that type.
    const singleToken = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(raw);
    const idLike = singleToken && /[\p{N}._-]/u.test(raw);
    if (idLike) {
      const direct = await this.lookupIdOrCode(raw);
      if (direct) return direct;
    }

    // The full organisation list knows the name even without published algorithms
    // ("Gemeente West Betuwe", "Hoogheemraadschap van Rijnland").
    const target = fold(raw);
    const suggestions = ORG_TYPE_ONLY.test(target) || target.length < 3 ? [] : await this.suggestOrganisations(raw);
    let named = suggestions.filter((s) => scoreCandidate(raw, s) >= 2);
    if (!named.length && typeText && bareRaw) {
      // "Waterschap Rijnland" is listed as "Hoogheemraadschap van Rijnland".
      const more = await this.suggestOrganisations(bareRaw);
      named = more.filter((s) => scoreCandidate(raw, s) >= 2);
      suggestions.push(...more.filter((s) => !suggestions.some((x) => x.org_id === s.org_id)));
    }
    const namedWithAlgorithms = named.filter((s) => (s.count ?? 0) > 0);
    if (namedWithAlgorithms.length) return pickOrganisation(raw, namedWithAlgorithms);
    if (named.length) {
      const withoutAlgorithms = named.map((s) => `${s.name} (${s.org_id})`);
      const containing =
        picked.status === "resolved" && picked.organisation
          ? [picked.organisation, ...picked.alternatives]
          : picked.status === "ambiguous"
            ? picked.alternatives
            : [];
      if (containing.length) {
        // "X" is an organisation without algorithms, and other organisations contain "X".
        return {
          input: raw,
          status: "ambiguous",
          alternatives: [...named, ...containing].slice(0, ORG_AMBIGUOUS_SHOWN),
          candidate_total: named.length + Math.max(picked.candidate_total, containing.length),
          without_algorithms: withoutAlgorithms,
        };
      }
      return { input: raw, status: "not_found", alternatives: picked.alternatives, candidate_total: 0, without_algorithms: withoutAlgorithms };
    }

    if (picked.status !== "not_found") return picked;

    if (singleToken && !idLike) {
      const direct = await this.lookupIdOrCode(raw);
      if (direct) return direct;
    }

    // Organisations whose name contains the input but that the name search missed.
    const known = new Set(first.candidates.map((c) => c.org_id));
    const containing = suggestions.filter((s) => (s.count ?? 0) > 0 && !known.has(s.org_id));
    let lookalikes = picked.alternatives;
    if (containing.length) {
      const viaList = pickOrganisation(raw, containing);
      if (viaList.status !== "not_found") return viaList;
      // "Rot": the name search found nothing, the name list holds Gemeente Rotterdam.
      if (!lookalikes.length) lookalikes = viaList.alternatives;
    }
    // No name match is left (those returned above); what the name list still holds only
    // resembles the input ("Nationale Politie" → "Internationale Politiesamenwerking").
    const similar = suggestions
      .filter((s) => !(s.count ?? 0))
      .slice(0, ORG_ALTERNATIVES_SHOWN)
      .map((s) => `${s.name} (${s.org_id})`);
    return {
      input: raw,
      status: "not_found",
      alternatives: lookalikes,
      candidate_total: 0,
      without_algorithms: [],
      ...(similar.length ? { similar_without_algorithms: similar } : {}),
    };
  }

  /**
   * A ministry form the table of abbreviations knows ("MinOCW", "Ministerie van A&M"),
   * from the register's list of ministries with published algorithms. Not in that
   * list: not_found, with the ministry named when the register knows it without
   * published algorithms. Never another ministry.
   */
  private async resolveMinistry(raw: string, orgId: string): Promise<OrganisationResolution> {
    const ministries = await this.searchOrganisations("", "ministerie");
    const picked = pickMinistry(raw, ministries.candidates, ministries.total);
    if (picked.status === "resolved") return picked;
    // Only enriches the "not found" note; failing here must not hide that answer.
    const known = await this.lookupOrgId(orgId).catch(() => undefined);
    return { ...picked, without_algorithms: known ? [`${known.name} (${orgId})`] : [] };
  }

  /**
   * Other spellings of an abbreviation the name search did not resolve.
   *
   * A ministry form the table of abbreviations does not know ("MinJus", "Ministerie
   * van Onderw", "MinVenJ"): the name search finds nothing for it, another ministry, or
   * every ministry by its type word. The register's list of all ministries settles it:
   * pickMinistry takes the one ministry it names outright, or names those the letters
   * fit without choosing one. "I&W": the search answers with an unrelated organisation;
   * the register's names write '&' as "en" ("IenW"), which is taken when the input
   * itself abbreviates the organisation found.
   */
  private async resolveAbbreviation(raw: string): Promise<OrganisationResolution | undefined> {
    const abbr = abbreviationToken(raw);
    if (!abbr) return undefined;
    if (abbr.type === "ministerie") {
      const ministries = await this.searchOrganisations("", "ministerie");
      const picked = pickMinistry(raw, ministries.candidates, ministries.total);
      if (picked.status === "resolved" || picked.alternatives.length) return picked;
    }
    if (abbr.cased.includes("&")) {
      const via = await this.resolveOrganisation(abbr.cased.replace(/&/g, "en"));
      if (via.status === "resolved" && via.organisation && isAbbreviationOf(raw, via.organisation.name)) {
        return { ...via, input: raw, match: "deel", alternatives: [], candidate_total: 1 };
      }
    }
    return undefined;
  }

  private async lookupIdOrCode(raw: string): Promise<OrganisationResolution | undefined> {
    // Register org_ids hold a digit and are lower case ("gm0344", "189378"); the lookup
    // is case-sensitive, so "GM0344" is asked in lower case. Codes are mostly lower case
    // ("rivm", "gemeente-utrecht") but not all ("SED-organisatie"): asked as typed first.
    const lower = raw.toLowerCase();
    const byId = /\d/.test(raw) ? await this.lookupOrgId(lower) : undefined;
    if (byId) {
      return { input: raw, status: "resolved", match: "org_id", organisation: byId, alternatives: [], candidate_total: 1, without_algorithms: [] };
    }
    const byCode = (await this.lookupOrgCode(raw)) ?? (lower !== raw ? await this.lookupOrgCode(lower) : undefined);
    if (byCode) {
      return { input: raw, status: "resolved", match: "code", organisation: byCode, alternatives: [], candidate_total: 1, without_algorithms: [] };
    }
    return undefined;
  }

  /**
   * Organisations with published algorithms whose name matches (the overview lists no
   * others), or with `organisationtype` all of that type (the ministries: 14 in 2026).
   */
  private async searchOrganisations(
    searchtext: string,
    organisationtype?: AlgoritmeOrganisatietype,
  ): Promise<{ candidates: OrganisationCandidate[]; total: number }> {
    const { data } = await postJson<unknown>(
      ALGORITMEREGISTER_ORG_ENDPOINT,
      organisationtype
        ? { page: 1, limit: ALGORITMEREGISTER_MAX_ROWS, organisationtype }
        : { page: 1, limit: ORG_CANDIDATE_ROWS, searchtext },
      { connector: CONNECTOR, timeoutMs: TIMEOUT_MS },
    );
    const overview = asRecord(data);
    if (!overview || !Array.isArray(overview.results)) {
      throw new SourceRequestError({
        message: "Algoritmeregister gaf een onverwacht antwoord op de organisatiezoekvraag.",
        endpoint: ALGORITMEREGISTER_ORG_ENDPOINT,
        code: "malformed_response",
      });
    }
    const candidates = overview.results.map(toCandidate).filter((c): c is OrganisationCandidate => !!c);
    const total = typeof overview.total_count === "number" ? overview.total_count : candidates.length;
    return { candidates, total };
  }

  private async lookupOrgId(orgId: string): Promise<OrganisationCandidate | undefined> {
    // Answers 200 with an empty hierarchy for unknown ids.
    const { data } = await getJson<unknown>(`${ORG_RELATION_ENDPOINT}/${encodeURIComponent(orgId)}`, {
      connector: CONNECTOR,
      timeoutMs: TIMEOUT_MS,
    });
    const hierarchy = asRecord(data)?.hierarchy;
    if (!Array.isArray(hierarchy)) return undefined;
    for (const entry of hierarchy) {
      const e = asRecord(entry);
      if (str(e?.org_id) === orgId) {
        return { org_id: orgId, name: str(e?.name) ?? orgId };
      }
    }
    return undefined;
  }

  private async lookupOrgCode(code: string): Promise<OrganisationCandidate | undefined> {
    try {
      const { data } = await getJson<unknown>(`${ORG_CODE_ENDPOINT}/${encodeURIComponent(code)}`, {
        connector: CONNECTOR,
        timeoutMs: TIMEOUT_MS,
      });
      const orgId = str(asRecord(data)?.org_id);
      return orgId ? { org_id: orgId, name: code, code } : undefined;
    } catch (error) {
      // 404 "Kan corresponderende org_id niet vinden." is the normal "no such code".
      if (error instanceof SourceRequestError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async suggestOrganisations(search: string): Promise<OrganisationCandidate[]> {
    try {
      const { data } = await getJson<unknown>(`${ALGORITMEREGISTER_ORG_ENDPOINT}/${encodeURIComponent(search)}`, {
        connector: CONNECTOR,
        timeoutMs: TIMEOUT_MS,
      });
      const list = asRecord(data)?.organisations;
      return Array.isArray(list) ? list.map(toCandidate).filter((c): c is OrganisationCandidate => !!c) : [];
    } catch {
      // Only enriches the "not found" note; failing here must not hide that answer.
      return [];
    }
  }

  private async fetchPage(
    body: Record<string, unknown>,
    page: number,
    size: number,
  ): Promise<{ results: unknown[]; total: number; organisationName?: string }> {
    const { data, meta } = await postJson<unknown>(
      ALGORITMEREGISTER_SEARCH_ENDPOINT,
      { ...body, page, limit: size },
      { connector: CONNECTOR, timeoutMs: TIMEOUT_MS },
    );
    return asQueryResponse(data, meta.url);
  }

  /**
   * The register's exact full-text matches for a websearch query, without filters.
   * The suggestion endpoint runs that search without the fuzzy fallback and returns at
   * most 10 algorithms (newest first), so fewer than 10 is the complete set.
   * Undefined when it cannot be determined.
   */
  private async exactHits(prepped: string): Promise<{ lars: Set<string>; count: number } | undefined> {
    try {
      const { data } = await getJson<unknown>(
        `${SUGGESTION_ENDPOINT}/${encodeURIComponent(prepped)}`,
        { connector: CONNECTOR, timeoutMs: TIMEOUT_MS },
      );
      const list = asRecord(data)?.algorithms;
      if (!Array.isArray(list)) return undefined;
      const lars = list.map((a) => str(asRecord(a)?.lars)).filter((l): l is string => !!l);
      return { lars: new Set(lars), count: list.length };
    } catch {
      // Only refines the note; the results themselves are already in hand.
      return undefined;
    }
  }

  /**
   * Whether one result row is an exact match for the keywords: the exact search for
   * the keywords plus the row's own name as a phrase finds the row itself. A name many
   * algorithms share ("Anonimiseren") fills the list of 10 with others, so then the
   * organisation is added as a second phrase. True or false when the register says
   * so, undefined when that cannot be told (an OR query, an unbalanced quote, a full
   * list without the row, a failed request, or phrases that do not find their own row).
   */
  private async isExactRow(prepped: string, row: Record<string, unknown>): Promise<boolean | undefined> {
    const asPhrase = (value: unknown) => {
      const s = str(value)?.replace(/["/\\]/g, " ").replace(/\s+/g, " ").trim();
      return s ? `"${s}"` : undefined;
    };
    const lars = str(row.lars);
    const name = asPhrase(row.name);
    if (!lars || !name || hasOrOperator(prepped) || (prepped.match(/"/g)?.length ?? 0) % 2) return undefined;
    const organisation = asPhrase(row.organization);
    for (const phrase of organisation ? [name, `${name} ${organisation}`] : [name]) {
      const hits = await this.exactHits(`${prepped} ${phrase}`);
      if (!hits) return undefined;
      if (hits.lars.has(lars)) return true;
      if (hits.count >= SUGGESTION_LIMIT) continue;
      // The row is missing; that only means something if the phrase alone finds the row.
      const own = await this.exactHits(phrase);
      if (!own || (!own.lars.has(lars) && own.count < SUGGESTION_LIMIT)) return undefined;
      return false;
    }
    return undefined;
  }

  /**
   * Whether the rows came from the register's fuzzy fallback. Upstream runs the exact
   * search with all filters and, when that page is empty, the similarity search with
   * the same filters; the response does not say which one answered.
   *
   * Without filters the suggestion endpoint settles it: no exact hit anywhere means
   * fuzzy. With an organisation or another filter there can be exact hits elsewhere and
   * none within the filters, so the rows themselves are checked: against the complete
   * set of exact hits when the suggestion list is complete, otherwise by asking the
   * register about a row (one page is all exact or all fuzzy). Only when the register
   * cannot tell are the keywords looked for in the rows; that is lenient, as a short
   * stem also occurs inside other words ("kind" in "kinderopvangtoeslag").
   */
  private async detectFuzzy(
    query: string,
    rows: Record<string, unknown>[],
    filtered: boolean,
  ): Promise<{ certain: boolean; exactElsewhere: boolean } | undefined> {
    const prepped = prepSearch(query);
    const exact = await this.exactHits(prepped);
    if (exact && exact.count === 0) return { certain: true, exactElsewhere: false };
    if (!filtered || !rows.length) return undefined;
    const exactElsewhere = !!exact;
    if (exact && exact.count < SUGGESTION_LIMIT) {
      return rows.some((r) => exact.lars.has(str(r.lars) ?? "")) ? undefined : { certain: true, exactElsewhere };
    }
    const groups = queryTermGroups(query);
    const mentions = rows.map((r) => rowMentionsTerms(r, groups));
    let verdict = await this.isExactRow(prepped, rows[0]);
    // A row without the keywords is the likelier one to settle it when the first cannot.
    const lacking = rows.find((_, i) => i > 0 && !mentions[i]);
    if (verdict === undefined && lacking) verdict = await this.isExactRow(prepped, lacking);
    if (verdict === true) return undefined;
    if (verdict === false) return { certain: true, exactElsewhere };
    return mentions.some(Boolean) ? undefined : { certain: false, exactElsewhere };
  }

  /** Algorithms of organisations of this type, without any other filter; undefined when it cannot be told. */
  private async countOrganisationType(organisationtype: AlgoritmeOrganisatietype): Promise<number | undefined> {
    try {
      return (await this.fetchPage({ searchtext: "", organisationtype }, 1, 1)).total;
    } catch {
      // Only decides which note fits; the (empty) result itself stands.
      return undefined;
    }
  }

  /** The JSON body the register expects, without paging (shared with dryRun). */
  buildQuery(args: AlgoritmeregisterSearchArgs, orgId?: string): Record<string, unknown> {
    const query = (args.query ?? "").replace(/\s+/g, " ").trim();
    const categorie = args.categorie?.trim() ? normalizeAlgoritmeCategorie(args.categorie).value : undefined;
    const body: Record<string, unknown> = { searchtext: query };
    if (orgId) {
      body.organisation = orgId;
      body.include_children = args.includeChildren !== false;
    }
    if (args.status) body.status = args.status;
    if (args.publicatiecategorie) body.publicationcategory = args.publicatiecategorie;
    if (categorie) body.category = categorie;
    if (args.organisatietype) body.organisationtype = args.organisatietype;
    return body;
  }

  async search(args: AlgoritmeregisterSearchArgs): Promise<AlgoritmeregisterSearchResult> {
    const query = (args.query ?? "").replace(/\s+/g, " ").trim();
    const offset = clampOffset(args.offset);
    const limit = clampAlgoritmeRows(args.limit);
    const includeChildren = args.includeChildren !== false;
    const categorie = args.categorie?.trim() ? normalizeAlgoritmeCategorie(args.categorie) : undefined;
    const orgInput = (args.organisatie ?? "").replace(/\s+/g, " ").trim();

    const filters: Record<string, string> = {};
    if (args.status) filters.status = args.status;
    if (args.publicatiecategorie) filters.publicatiecategorie = args.publicatiecategorie;
    if (categorie) filters.categorie = categorie.value;
    if (args.organisatietype) filters.organisatietype = args.organisatietype;

    const notes: string[] = [BASE_NOTE];
    let resolution: OrganisationResolution | undefined;
    if (orgInput) {
      resolution = await this.resolveOrganisation(orgInput);
      if (resolution.status !== "resolved") {
        notes.push(organisationNote(resolution, includeChildren));
        return {
          items: [],
          // Not found: the register lists no algorithms under that name. Ambiguous: nothing was searched.
          total: resolution.status === "not_found" ? 0 : null,
          offset,
          limit,
          query,
          categorie,
          filters,
          organisation: resolution,
          endpoint: ALGORITMEREGISTER_ORG_ENDPOINT,
          params: { organisatie: orgInput, ...(query ? { searchtext: query } : {}), ...filters },
          access_note: notes.join(" "),
        };
      }
    }

    const orgId = resolution?.organisation?.org_id;
    const body = this.buildQuery(args, orgId);
    const plan = planAlgoritmeWindow(offset, limit);
    const rows: unknown[] = [];
    let total: number | undefined;
    let organisationName: string | undefined;

    // With keywords the register answers a page without exact hits with its fuzzy
    // similarity search, which has another total and other results. Asking for a page
    // past the last exact hit (offset 60 of 51 for "chatbot") would therefore return
    // fuzzy hits as if they were the next exact ones. Page 1 is asked first so no page
    // starting beyond its total is requested.
    const probed = !!query && plan.pages[0] > 1;
    if (probed) {
      const probe = await this.fetchPage(body, 1, 1);
      total = probe.total;
      organisationName = probe.organisationName;
    }
    const fetchedPages: number[] = [];
    for (const page of plan.pages) {
      if (total !== undefined && (page - 1) * plan.pageSize >= total) break;
      const parsed = await this.fetchPage(body, page, plan.pageSize);
      fetchedPages.push(page);
      if (total === undefined) total = parsed.total;
      organisationName ??= parsed.organisationName;
      rows.push(...parsed.results);
      if (parsed.results.length < plan.pageSize) break;
    }
    total ??= 0;
    const items = rows
      .slice(plan.skip, plan.skip + limit)
      .map(toAlgoritmeItem)
      .filter((x): x is AlgoritmeItem => !!x);

    // The response does not say whether the fuzzy fallback answered; see detectFuzzy.
    const filtered = !!orgId || Object.keys(filters).length > 0;
    const fuzzy =
      query && items.length
        ? await this.detectFuzzy(query, rows.map(asRecord).filter((r): r is Record<string, unknown> => !!r), filtered)
        : undefined;

    if (resolution?.organisation) {
      // An id or code lookup has no proper display name; the register echoes it.
      if ((resolution.match === "org_id" || resolution.match === "code") && organisationName && organisationName !== orgId) {
        resolution = { ...resolution, organisation: { ...resolution.organisation, name: organisationName } };
      }
      const childrenSeen = items.some((x) => x.organisation_id && x.organisation_id !== orgId);
      notes.push(organisationNote(resolution, includeChildren, childrenSeen));
    }

    if (query) {
      notes.push(
        "Zoekwoorden worden in alle velden gezocht (Nederlandse woordstammen); alle woorden moeten voorkomen, " +
          "\"aanhalingstekens\" zoeken een frase, 'of' geeft alternatieven en -woord sluit uit. " +
          "Zonder exacte treffers (ook binnen een organisatie of filter) geeft het register vergelijkbare woorden terug (fuzzy).",
      );
    }
    if (fuzzy && !filtered) {
      notes.push(
        `Er zijn geen exacte treffers voor '${query}' (bijv. door een tikfout of alleen stopwoorden); deze resultaten komen uit de fuzzy zoekfunctie van het register en bevatten het zoekwoord niet per se.`,
      );
    } else if (fuzzy) {
      const scope = orgId ? "deze organisatie" : "deze filters";
      notes.push(
        (fuzzy.certain
          ? `Binnen ${scope} zijn er geen exacte treffers voor '${query}'; deze resultaten komen uit de fuzzy zoekfunctie van het register en bevatten het zoekwoord niet.`
          : `Geen van deze resultaten bevat '${query}'; vermoedelijk zijn er binnen ${scope} geen exacte treffers en komen ze uit de fuzzy zoekfunctie van het register.`) +
          (fuzzy.exactElsewhere ? ` Elders in het register zijn er wel exacte treffers voor '${query}'.` : ""),
      );
    }
    notes.push("Volgorde: nieuwste publicatie eerst.");
    if (total === 0 && query.includes(" ")) {
      notes.push("Geen treffers: alle zoekwoorden moeten voorkomen, probeer minder of andere woorden.");
    }
    let typeProbed = false;
    if (args.organisatietype && total === 0) {
      // Only the type itself finding nothing means the register does not use it. With
      // other constraints the zero may be theirs: one count of the type alone decides.
      const others = [
        ...(orgId ? ["organisatie"] : []),
        ...(query ? ["zoekwoorden"] : []),
        ...Object.keys(filters).filter((k) => k !== "organisatietype"),
      ];
      typeProbed = others.length > 0;
      const typeTotal = typeProbed ? await this.countOrganisationType(args.organisatietype) : 0;
      if (typeTotal === 0) {
        notes.push(
          `Geen treffers met organisatietype '${args.organisatietype}'. Het register deelt organisaties zelf in en gebruikt niet elk type: ` +
            "omgevingsdiensten, veiligheidsregio's, GGD's en andere regionale samenwerkingsverbanden staan onder 'veiligheidsregio' " +
            "(in het register 'Regionaal samenwerkingsorgaan'). Zoek zo'n organisatie liever op naam (organisatie).",
        );
      } else if (typeTotal !== undefined) {
        const list = others.length > 1 ? `${others.slice(0, -1).join(", ")} en ${others.at(-1)}` : others[0];
        notes.push(
          `Organisatietype '${args.organisatietype}' heeft op zichzelf wel treffers (${algoritmes(typeTotal)}); ` +
            `de nul komt door de combinatie met ${list}.`,
        );
      }
    }
    if (categorie && !categorie.known) {
      notes.push(
        `Categorie '${categorie.value}' is geen bekende categorie van het register; bekend zijn: ${ALGORITME_CATEGORIEEN.join(", ")}.`,
      );
    }

    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) params[k] = String(v);
    if (orgInput) params.organisatie = orgInput;
    // The pages actually requested; a probe-only call shows as page 1 with limit 1.
    params.page = fetchedPages.length ? fetchedPages.join(",") : "1";
    params.limit = fetchedPages.length ? String(plan.pageSize) : "1";
    if (probed && fetchedPages.length) params.total_probe = "page=1&limit=1";
    if (typeProbed) params.organisationtype_probe = `organisationtype=${args.organisatietype}&page=1&limit=1`;

    return {
      items,
      total,
      offset,
      limit,
      query,
      ...(fuzzy ? { fuzzy: true, fuzzy_certain: fuzzy.certain } : {}),
      categorie,
      filters,
      organisation: resolution,
      endpoint: ALGORITMEREGISTER_SEARCH_ENDPOINT,
      params,
      access_note: notes.join(" "),
    };
  }
}

/** One-line summary for the tool response. */
export function summarizeAlgoritmeSearch(out: AlgoritmeregisterSearchResult): string {
  const r = out.organisation;
  if (r?.status === "ambiguous") {
    return `Organisatie '${r.input}' is niet eenduidig: ${r.candidate_total} organisaties passen. Kies er één (zie access_note).`;
  }
  if (r?.status === "not_found") {
    const base = `Geen organisatie met gepubliceerde algoritmes gevonden voor '${r.input}' in het Algoritmeregister.`;
    if (r.without_algorithms.length) return `${base} Wel bekend zonder gepubliceerde algoritmes: ${r.without_algorithms.join("; ")}.`;
    if (!r.alternatives.length) return base;
    // Not the organisation asked for, but the likeliest next step ("Nationale Politie" → Politie).
    const shown = r.alternatives.slice(0, SUMMARY_LOOKALIKES);
    const one = shown.length === 1;
    return (
      `${base} ${one ? "Gelijkende naam" : "Gelijkende namen"} met gepubliceerde algoritmes: ${shown.map(describeCandidate).join("; ")}; ` +
      `geef de org_id als organisatie als ${one ? "die" : "een daarvan"} bedoeld is.`
    );
  }
  const count = typeof out.total === "number" ? algoritmes(out.total) : "? algoritmes";
  const filterText = Object.entries(out.filters).map(([k, v]) => `${k}: ${v}`).join(", ");
  let summary: string;
  if (out.fuzzy && out.query) {
    // Say first that the keywords were not found, so fuzzy rows do not read as hits.
    summary = `${out.fuzzy_certain === false ? "Vermoedelijk geen" : "Geen"} exacte treffers voor '${out.query}'`;
    if (r?.organisation) summary += ` bij ${r.organisation.name}`;
    if (filterText) summary += ` (${filterText})`;
    summary += `; ${count} met vergelijkbare woorden (fuzzy) in het Algoritmeregister`;
  } else {
    summary = `${count} in het Algoritmeregister`;
    if (r?.organisation) summary += ` van ${r.organisation.name}`;
    if (out.query) summary += ` voor '${out.query}'`;
    if (filterText) summary += ` (${filterText})`;
  }
  if (out.items.length) {
    summary += `; getoond ${out.offset + 1}-${out.offset + out.items.length}`;
  } else if (out.total && out.offset >= out.total) {
    summary += `; geen resultaten vanaf offset ${out.offset}`;
  }
  return summary;
}
