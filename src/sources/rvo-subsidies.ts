import type { AppConfig } from "../types.js";
import { getJson, getText, SourceRequestError } from "../utils/http.js";
import { htmlToText } from "../utils/html-text.js";

/**
 * Subsidies en financiering of RVO (Rijksdienst voor Ondernemend Nederland).
 *
 * The catalogue comes from RVO's open data API (data.overheid.nl dataset
 * 'subsidies-en-financiering-rvo-nl', CC0). GET /api/v1/opendata/subsidies?page=N
 * returns a bare JSON array of 50 entries, in the order the pages were created, an
 * empty array past the last page and HTTP 500 for a negative page. Search, filter,
 * sort and page-size parameters (search, q, keys, title, sort, order, limit,
 * items_per_page, status, id, ...) are all ignored (verified live, October 2026), so
 * the whole catalogue (28 pages, about 1,370 entries) is read once and searched here.
 * It holds every page of the site section "Subsidies en financiering": a regeling's
 * own page, its sub-pages (aanvragen, voorwaarden, oproepen, veelgestelde vragen) and
 * closed and historical regelingen alike.
 *
 * GET /api/v1/opendata/subsidies/<uuid> adds `body`: the page's rich-text blocks as
 * HTML, with null in place of every other block (uitklapblokken, meldingen, downloads,
 * call-to-action) and [rvo_custom:...] placeholders for login buttons. Only the uuid
 * works; a slug answers 404 {"ok":false,"message":"Not found"}.
 *
 * Neither endpoint carries the application status, period or budget. The public page
 * on www.rvo.nl shows them ("Open voor aanvragen", Startdatum, Einddatum, Totaal
 * budget) from the page data embedded in its HTML (the Next.js flight payload:
 * subsidyStatus, startDate, endDate, budget), together with all of the page's blocks;
 * readPage() takes them from there. Nothing is inferred from the body text: its
 * sentences about dates are too often about something else (decision terms, earlier
 * rounds, the end of a project).
 */
const SITE = "https://www.rvo.nl";
export const RVO_SUBSIDIES_ENDPOINT = `${SITE}/api/v1/opendata/subsidies`;
/** Connector of the open data API. */
export const RVO_SUBSIDIES_CONNECTOR = "rvo_subsidies";
/**
 * Connector of the public pages read for status, period and budget: apart from the API,
 * so a slow page cannot trip the breaker of the catalogue (as ori_pages for ORI).
 */
export const RVO_SUBSIDIES_PAGES_CONNECTOR = "rvo_subsidies_pages";
/**
 * Per request, with one retry: a slow rvo.nl would otherwise stack 20 s timeouts and two
 * retries per page into minutes (89 s once, October 2026), past what MCP clients wait.
 */
const TIMEOUT_MS = 10_000;
const RETRIES = 1;
/** Loading the catalogue waits at most this long; list pages not read by then are missing. */
const CATALOGUE_DEADLINE_MS = 20_000;
/** The status pages of one search are read within this time; a page not read by then is 'onbekend'. */
const STATUS_BUDGET_MS = 10_000;

/** Fixed upstream page size; a shorter page is the last one. */
const LIST_PAGE_SIZE = 50;
/** Guard against an endless list: 60 pages is 3,000 entries, more than twice today's. */
const MAX_LIST_PAGES = 60;
/** Parallel requests; connector-runtime allows 3 per connector anyway. */
const CONCURRENCY = 3;
/** The catalogue changes a few times a day, not by the minute. */
const CATALOGUE_TTL_MS = 3 * 60 * 60 * 1000;
/** After a failed or incomplete load, try again this soon. */
const CATALOGUE_RETRY_MS = 5 * 60 * 1000;
/** Status, period and budget read from a page; RVO edits them during the day. */
const STATUS_TTL_MS = 30 * 60 * 1000;
const STATUS_CACHE_MAX = 2000;

export const RVO_DEFAULT_ROWS = 10;
export const RVO_MAX_ROWS = 50;
/** At most this many pages are read to show the status of the results of one search. */
export const RVO_STATUS_ENRICH_MAX = 10;
/** At most this many pages are read to filter one search by status. */
export const RVO_STATUS_CHECK_MAX = 40;
export const RVO_TEXT_DEFAULT_CHARS = 12_000;
export const RVO_TEXT_MAX_CHARS = 50_000;
const MAX_LEGAL_REFERENCES = 50;

/** Status codes, for the four labels rvo.nl shows (taxonomy 'subsidy_status'). */
export const RVO_STATUSSEN = ["open", "bijna_open", "tijdelijk_gesloten", "gesloten"] as const;
export type RvoStatus = (typeof RVO_STATUSSEN)[number];
/** "overig": a label not in this list (passed on as shown); "onbekend": no label read. */
export type RvoStatusCode = RvoStatus | "overig" | "onbekend";

/** The labels as rvo.nl shows them; the only four seen on 94 sampled pages (October 2026). */
export const RVO_STATUS_LABELS: Record<RvoStatus, string> = {
  open: "Open voor aanvragen",
  bijna_open: "Bijna open voor aanvragen",
  tijdelijk_gesloten: "Tijdelijk gesloten voor aanvragen",
  gesloten: "Gesloten voor aanvragen",
};

/** Target groups (field `targets`) in the catalogue, October 2026. */
export const RVO_DOELGROEPEN = [
  "MKB (ook zzp)",
  "Grootbedrijf",
  "Agrarisch ondernemer",
  "School / Kennisinstelling",
  "Non-profit / NGO",
  "Particulier / Vereniging / (Ver)huurder",
  "Financier",
  "Overheid",
  "Producentenorganisatie",
  "Visser",
] as const;

/** Subjects (field `subjects`) in the catalogue, October 2026 (whitespace normalised). */
export const RVO_ONDERWERPEN = [
  "Innovatie, onderzoek en onderwijs",
  "Klimaat en energie",
  "Landbouw",
  "Ondernemen en bedrijfsvoering",
  "Bouwen en wonen",
  "Internationaal ondernemen",
  "Ontwikkelingssamenwerking",
  "Visserij",
  "Gezondheid, zorg en welzijn",
  "Dieren en natuur",
] as const;

export const RVO_SORTS = ["relevance", "changed", "created", "title"] as const;
export type RvoSort = (typeof RVO_SORTS)[number];

export class RvoSubsidiesInputError extends Error {
  constructor(message: string, public readonly suggestion?: string) {
    super(message);
    this.name = "RvoSubsidiesInputError";
  }
}

export interface RvoCountry {
  name: string;
  /** ISO 3166 alpha-2; absent for entries without one ("Europa", "Bonaire"). */
  code?: string;
}

/** One page of the catalogue, as the open data API lists it. */
export interface RvoSubsidyItem {
  id: string;
  title: string;
  /** Public page, e.g. https://www.rvo.nl/subsidies-financiering/dumava. */
  url: string;
  /** Path of that page, e.g. /subsidies-financiering/dumava. */
  path: string;
  /** Plain text; RVO's login-button placeholders removed. */
  intro: string;
  created?: string;
  changed?: string;
  targets: string[];
  subjects: string[];
  sectors: string[];
  countries: RvoCountry[];
  /** Names of the regelingen the page belongs to (RVO's own taxonomy). */
  subsidies: string[];
  tags: string[];
  /** A page directly under /subsidies-financiering/: a regeling's own page, not one of its sub-pages. */
  main_page: boolean;
  /** For a sub-page: the path one level up. */
  parent_path?: string;
  /** Title of the nearest page up the path that is in the catalogue. */
  parent_title?: string;
}

/** Status, period and budget as the public page shows them. Only what the page states. */
export interface RvoSubsidyStatus {
  status: RvoStatusCode;
  /** The label as shown, e.g. "Tijdelijk gesloten voor aanvragen". */
  status_label?: string;
  /** Start and end of the application period as the page gives them (ISO 8601 with offset). */
  application_start?: string;
  application_end?: string;
  /** The period in words, Dutch time ("1 juni 2026 09:00 tot 16 oktober 2026 17:00"). */
  period_text?: string;
  /** Where now falls against those dates (by Amsterdam day when the page shows no times); computed here, absent without dates. */
  period_state?: "not_started" | "running" | "ended";
  budget_total_eur?: number;
  /** "In behandeling" on the page: the amount in applications being handled. */
  budget_in_progress_eur?: number;
  /** Total minus in behandeling (not below 0), as the page computes "Nog beschikbaar". */
  budget_available_eur?: number;
  /** Date of those budget figures ("Nog beschikbaar op ..."). */
  budget_date?: string;
  /** "Aanvullende informatie" in the budget tile. */
  budget_note?: string;
  /** Text in the budget tile, usually the amount per application, with its heading if any. */
  subsidy_info?: string;
  subsidy_info_title?: string;
  /** "De inhoud van deze pagina is gecontroleerd op ...". */
  page_checked_at?: string;
  /** The page's latest change notice ("De subsidie sluit op ..."). */
  change_notice?: string;
  status_source_url: string;
  /** The raw values the fields above were taken from. */
  status_evidence?: string;
  /** Why something is unknown, or where label and dates disagree. */
  status_note?: string;
}

export interface RvoLegalReference {
  kind: "bwb" | "officiele_bekendmaking" | "eur_lex";
  /** BWBR id, publication id ("stcrt-2026-12345") or CELEX number / ELI path. */
  id?: string;
  url: string;
  label?: string;
}

export interface RvoLink {
  title: string;
  url: string;
  mimetype?: string;
  size_bytes?: number;
}

export interface RvoSubsidiesSearchArgs {
  query?: string;
  doelgroep?: string;
  onderwerp?: string;
  sector?: string;
  land?: string;
  /** YYYY-MM-DD: only pages changed on or after this day. */
  changed_since?: string;
  /** Only the pages read from rvo.nl with one of these statuses. */
  status?: RvoStatus[];
  main_pages_only?: boolean;
  /** Read the public pages of the results for status, period and budget (default true). */
  include_status?: boolean;
  sort?: RvoSort;
  offset?: number;
  limit?: number;
}

export interface RvoSearchHit extends RvoSubsidyItem {
  score?: number;
  status_info?: RvoSubsidyStatus;
}

/**
 * Why the pages after the last one read are unknown: "stopped": reading stopped after
 * failed pages; "max_pages": the guard of 60 pages was hit; "deadline": the load ran out
 * of time (CATALOGUE_DEADLINE_MS).
 */
export type RvoCatalogueTruncation = "stopped" | "max_pages" | "deadline";

export interface RvoCatalogueInfo {
  entries: number;
  pages_read: number;
  missing_pages: number[];
  truncated?: RvoCatalogueTruncation;
  complete: boolean;
  loaded_at: string;
  /** Served from an earlier load because refreshing it failed. */
  stale: boolean;
}

export interface RvoSubsidiesSearchResult {
  items: RvoSearchHit[];
  /** Matches; null when a status filter left candidates unchecked. */
  total: number | null;
  offset: number;
  limit: number;
  query: string;
  sort: RvoSort;
  /** Filters as applied, with the catalogue values an input matched. */
  filters: Record<string, string>;
  catalogue: RvoCatalogueInfo;
  /**
   * With a status filter: candidates after the other filters, how many of their pages
   * were read (or cached), how many of those had no readable status, how many matched,
   * and whether every candidate was checked (only then is `total` known).
   */
  status_checks?: { candidates: number; checked: number; unreadable: number; matches: number; all_checked: boolean };
  has_more: boolean;
  endpoint: string;
  params: Record<string, string>;
  access_note: string;
}

export interface RvoSubsidieGetArgs {
  /** uuid, or the page URL, path or slug ("dumava", "/subsidies-financiering/dumava"). */
  id: string;
  maxChars?: number;
  /** Only the sections whose heading contains this. */
  sectie?: string;
  /** Read the public page for status, period, budget and the complete text (default true). */
  readPage?: boolean;
}

export interface RvoSubsidieGetFound {
  item: RvoSubsidyItem;
  status_info?: RvoSubsidyStatus;
  text: string;
  /** Length of the text (of the chosen sections) before truncation. */
  text_chars: number;
  text_truncated: boolean;
  /** "pagina": all blocks of the public page; "api": the open data body (rich text only). */
  text_source: "pagina" | "api";
  sections: string[];
  sectie?: string;
  legal_references: RvoLegalReference[];
  downloads: RvoLink[];
  endpoint: string;
  params: Record<string, string>;
  access_note: string;
}

export interface RvoSubsidieGetNotFound {
  notFound: true;
  message: string;
  /** A page that rvo.nl has for the path or slug although the open data lacks it (e.g. /subsidies-financiering/isde). */
  site_page?: string;
  /** Where rvo.nl redirects the path to (another page, not read in its place). */
  redirects_to?: string;
  suggestions: RvoSubsidyItem[];
  endpoint: string;
  params: Record<string, string>;
}

export type RvoSubsidieGetResult = RvoSubsidieGetFound | RvoSubsidieGetNotFound;

// ---------------------------------------------------------------------------
// Small helpers

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.replace(/\s+/g, " ").trim();
  return t || undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Lowercase, accents stripped, whitespace collapsed: "Financiën" matches "financien". */
export function foldRvo(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’`´]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function words(folded: string): string[] {
  return folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** RVO's placeholders for login buttons: "[rvo_custom:upnl:upnl7_eh3_aanvraag_beheren]". */
const RVO_MARKER = /\[rvo_custom:[^\]]*\]/g;

function plain(value: unknown): string {
  return typeof value === "string" ? htmlToText(value.replace(RVO_MARKER, " ")) : "";
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = value.map((v) => str(v)).filter((v): v is string => !!v);
  return [...new Set(out)];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lower-case path without trailing slash, for comparing paths and URLs. */
function pathKey(path: string): string {
  let p = path.trim();
  try {
    p = decodeURI(p);
  } catch {
    // keep as given
  }
  return p.toLowerCase().replace(/\/+$/, "");
}

/** What a get id that is not a uuid names: an exact path on rvo.nl, or a bare slug. */
export type RvoIdTarget = { kind: "path"; path: string } | { kind: "slug"; slug: string };

/**
 * A URL ("https://www.rvo.nl/...", also without scheme: "www.rvo.nl/...") or an input with
 * more than one path segment names exactly that path: query, fragment and a trailing slash
 * are dropped, case does not matter. One segment ("dumava", "/dumava") is a slug.
 * Undefined for a URL of another site or one without a path.
 */
export function rvoIdTarget(input: string): RvoIdTarget | undefined {
  let s = input.trim();
  if (/^(?:[a-z0-9-]+\.)*rvo\.nl(?:[/?#]|$)/i.test(s)) s = `https://${s}`;
  let url = false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (!/(^|\.)rvo\.nl$/i.test(u.hostname)) return undefined;
      s = u.pathname;
      url = true;
    } catch {
      return undefined;
    }
  } else {
    s = s.replace(/[?#].*$/, "");
  }
  try {
    s = decodeURIComponent(s);
  } catch {
    // keep as given
  }
  const segments = s.split("/").filter(Boolean);
  if (!segments.length) return undefined;
  if (!url && segments.length === 1) return { kind: "slug", slug: segments[0].toLowerCase() };
  return { kind: "path", path: `/${segments.join("/")}` };
}

/** The rvo.nl path a target stands for: a slug and a path outside the section get /subsidies-financiering in front. */
function sectionPath(target: RvoIdTarget): string {
  const path = target.kind === "slug" ? `/${target.slug}` : target.path;
  return /^\/subsidies-financiering(\/|$)/i.test(path) ? path : `/subsidies-financiering${path}`;
}

export function rvoPageUrl(path: string): string {
  return new URL(path, SITE).toString();
}

// ---------------------------------------------------------------------------
// Catalogue entries

export function toRvoItem(value: unknown): RvoSubsidyItem | undefined {
  const row = asRecord(value);
  const id = str(row?.id);
  const path = str(row?.url);
  if (!row || !id || !path || !path.startsWith("/")) return undefined;
  const segments = path.split("/").filter(Boolean);
  const countries: RvoCountry[] = [];
  if (Array.isArray(row.countries)) {
    for (const c of row.countries) {
      const name = str(asRecord(c)?.name);
      if (!name || countries.some((x) => x.name === name)) continue;
      const code = str(asRecord(c)?.isoalpha2);
      countries.push(code ? { name, code: code.toUpperCase() } : { name });
    }
  }
  const item: RvoSubsidyItem = {
    id,
    title: plain(row.title) || path,
    url: rvoPageUrl(path),
    path,
    intro: plain(row.intro),
    targets: stringList(row.targets),
    subjects: stringList(row.subjects),
    sectors: stringList(row.sectors),
    countries,
    subsidies: stringList(row.subsidies),
    tags: stringList(row.tags),
    main_page: segments.length === 2 && segments[0].toLowerCase() === "subsidies-financiering",
  };
  const created = str(row.created);
  const changed = str(row.changed);
  if (created) item.created = created;
  if (changed) item.changed = changed;
  if (segments.length > 2) item.parent_path = `/${segments.slice(0, -1).join("/")}`;
  return item;
}

interface FoldedFields {
  title: string;
  titleWords: Set<string>;
  subsidies: string;
  tags: string;
  intro: string;
  allWords: Set<string>;
}

interface Entry {
  item: RvoSubsidyItem;
  f: FoldedFields;
}

interface Catalogue {
  entries: Entry[];
  byId: Map<string, Entry>;
  byPath: Map<string, Entry>;
  pagesRead: number;
  missingPages: number[];
  /** Pages after the last one read are unknown: reading stopped after failures, ran out of time or hit MAX_LIST_PAGES. */
  truncated?: RvoCatalogueTruncation;
  complete: boolean;
  loadedAt: string;
}

function foldFields(item: RvoSubsidyItem): FoldedFields {
  const title = foldRvo(item.title);
  const subsidies = foldRvo(item.subsidies.join(" | "));
  const tags = foldRvo(item.tags.join(" | "));
  const intro = foldRvo(item.intro);
  return {
    title,
    titleWords: new Set(words(title)),
    subsidies,
    tags,
    intro,
    allWords: new Set(words(`${title} ${subsidies} ${tags} ${intro}`)),
  };
}

/** Build the catalogue from list rows: deduplicated by id, parents resolved. */
export function buildRvoCatalogue(rows: unknown[], pagesRead: number, missingPages: number[], truncated?: RvoCatalogueTruncation): Catalogue {
  const entries: Entry[] = [];
  const byId = new Map<string, Entry>();
  const byPath = new Map<string, Entry>();
  for (const row of rows) {
    const item = toRvoItem(row);
    if (!item || byId.has(item.id)) continue;
    const entry = { item, f: foldFields(item) };
    entries.push(entry);
    byId.set(item.id, entry);
    byPath.set(pathKey(item.path), entry);
  }
  for (const { item } of entries) {
    if (!item.parent_path) continue;
    // The nearest page up the path that is in the catalogue (the MIT landing page is not).
    const segments = item.path.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 2; i--) {
      const up = byPath.get(pathKey(`/${segments.slice(0, i).join("/")}`));
      if (up) {
        item.parent_title = up.item.title;
        break;
      }
    }
  }
  return {
    entries,
    byId,
    byPath,
    pagesRead,
    missingPages,
    ...(truncated ? { truncated } : {}),
    complete: missingPages.length === 0 && !truncated,
    loadedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Query

interface QueryTerm {
  text: string;
  phrase: boolean;
  /** Short terms ("ai", "mit", "sde") must be a whole word, not part of one. */
  wholeWord: boolean;
}

export interface ParsedRvoQuery {
  /** Alternatives (uppercase OR); within one, every term is required. */
  groups: QueryTerm[][];
  excluded: QueryTerm[];
  /** Stop words and words every entry is about ("subsidie"), left out. */
  ignored: string[];
}

/** Dutch function words, and lowercase "or"/"and" (only the uppercase forms are operators). */
const STOPWORDS = new Set([
  "de", "het", "een", "en", "van", "voor", "in", "op", "met", "aan", "te", "om", "over", "bij", "tot",
  "door", "naar", "als", "of", "die", "dat", "er", "is", "zijn", "wat", "welke", "welk", "ik", "wij",
  "we", "u", "mijn", "onze", "ons", "kan", "kun", "kunnen", "nog", "or", "and",
]);
/** Every entry is a subsidy or financing page: these words would only cut entries that do not repeat them. */
const GENERIC_WORDS = new Set(["subsidie", "subsidies", "subsidieregeling", "subsidieregelingen", "regeling", "regelingen", "financiering", "rvo"]);

function term(text: string, phrase: boolean): QueryTerm {
  return { text, phrase, wholeWord: !phrase && text.length <= 3 };
}

/**
 * Words are all required; "quoted phrases" match as written; an uppercase OR starts an
 * alternative ("waterstof OR elektrolyse"; AND binds tighter, as in cvdr); -word or NOT
 * word excludes. Lowercase "or"/"of" are ordinary (stop) words. Stop words and the
 * generic words above are left out, unless nothing else is left.
 */
export function parseRvoQuery(query: string | undefined): ParsedRvoQuery {
  const groups: QueryTerm[][] = [[]];
  const excluded: QueryTerm[] = [];
  const dropped: Array<{ group: QueryTerm[]; term: QueryTerm; word: string }> = [];
  let negateNext = false;
  for (const m of (query ?? "").matchAll(/(-?)"([^"]*)"?|(\S+)/g)) {
    const raw = m[3];
    if (raw === "OR") {
      if (groups[groups.length - 1].length) groups.push([]);
      negateNext = false;
      continue;
    }
    if (raw === "AND") continue;
    if (raw === "NOT") {
      negateNext = true;
      continue;
    }
    const negated = negateNext || m[1] === "-" || (raw?.startsWith("-") ?? false);
    negateNext = false;
    const target = negated ? excluded : groups[groups.length - 1];
    if (m[2] !== undefined) {
      const phrase = foldRvo(m[2]);
      if (phrase) target.push(term(phrase, phrase.includes(" ")));
      continue;
    }
    for (const w of words(foldRvo(raw ?? ""))) {
      const t = term(w, false);
      if (!negated && (STOPWORDS.has(w) || GENERIC_WORDS.has(w))) dropped.push({ group: target, term: t, word: w });
      else target.push(t);
    }
  }
  const hasOther = groups.some((g) => g.length > 0);
  const ignored: string[] = [];
  for (const d of dropped) {
    if (hasOther) ignored.push(d.word);
    else d.group.push(d.term);
  }
  return { groups: groups.filter((g) => g.length > 0), excluded, ignored: [...new Set(ignored)] };
}

const WEIGHTS = { title: 8, subsidies: 4, tags: 3, intro: 1 } as const;
const MAIN_PAGE_BONUS = 2;

function termScore(t: QueryTerm, f: FoldedFields): number {
  if (t.wholeWord) {
    if (!f.allWords.has(t.text)) return 0;
    if (f.titleWords.has(t.text)) return WEIGHTS.title + 2;
    const inField = (s: string) => words(s).includes(t.text);
    if (inField(f.subsidies)) return WEIGHTS.subsidies;
    if (inField(f.tags)) return WEIGHTS.tags;
    return WEIGHTS.intro;
  }
  if (f.title.includes(t.text)) {
    const startsWord = [...f.titleWords].some((w) => w.startsWith(t.text)) || (t.phrase && f.title.startsWith(t.text));
    return WEIGHTS.title + (startsWord ? 2 : 0);
  }
  if (f.subsidies.includes(t.text)) return WEIGHTS.subsidies;
  if (f.tags.includes(t.text)) return WEIGHTS.tags;
  if (f.intro.includes(t.text)) return WEIGHTS.intro;
  return 0;
}

/** Relevance of an entry for the query; undefined when it does not match. */
export function scoreRvoEntry(f: FoldedFields, q: ParsedRvoQuery): number | undefined {
  if (q.excluded.some((t) => termScore(t, f) > 0)) return undefined;
  if (!q.groups.length) return 0;
  let best: number | undefined;
  for (const group of q.groups) {
    let sum = 0;
    let all = true;
    for (const t of group) {
      const s = termScore(t, f);
      if (!s) {
        all = false;
        break;
      }
      sum += s;
    }
    if (all && (best === undefined || sum > best)) best = sum;
  }
  return best;
}

/** Catalogue values an input means: exact (folded) when there is one, otherwise those containing it. */
export function resolveRvoFacet(input: string, values: Iterable<string>): string[] {
  const target = foldRvo(input);
  const all = [...new Set(values)];
  const exact = all.filter((v) => foldRvo(v) === target);
  if (exact.length) return exact;
  return all.filter((v) => foldRvo(v).includes(target)).sort((a, b) => a.localeCompare(b, "nl"));
}

// ---------------------------------------------------------------------------
// Public page: status, period, budget and blocks

const NEXT_PUSH = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;

/** The Next.js flight payload of a page: the string chunks pushed by its inline scripts. */
export function extractRvoFlight(html: string): string {
  const parts: string[] = [];
  for (const m of html.matchAll(NEXT_PUSH)) {
    try {
      parts.push(JSON.parse(m[1]) as string);
    } catch {
      // A chunk that is not a JSON string literal holds nothing we read.
    }
  }
  return parts.join("");
}

/** The balanced JSON object that starts at `start` (a "{"), quotes respected. */
function objectAt(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** UTF-8 length of one code point. */
function utf8Length(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/**
 * The text rows of a flight payload. Long strings are not inline but in a row
 * "16:T5e0,<text>" (id, "T", length in UTF-8 bytes as hex, comma), referenced as "$16".
 * Such a row has no line end: the next row starts right after its text. Every other
 * row runs to the end of its line. The payload is read row by row, as React does.
 */
export function rvoFlightTextRows(flight: string): Map<string, string> {
  const rows = new Map<string, string>();
  let i = 0;
  while (i < flight.length) {
    const head = /^([0-9a-f]*):T([0-9a-f]+),/.exec(flight.slice(i, i + 40));
    if (head) {
      const bytes = Number.parseInt(head[2], 16);
      const start = i + head[0].length;
      let used = 0;
      let j = start;
      while (j < flight.length && used < bytes) {
        const cp = flight.codePointAt(j) as number;
        used += utf8Length(cp);
        j += cp > 0xffff ? 2 : 1;
      }
      if (used !== bytes) break;
      rows.set(head[1], flight.slice(start, j));
      i = j;
      continue;
    }
    const end = flight.indexOf("\n", i);
    if (end < 0) break;
    i = end + 1;
  }
  return rows;
}

/**
 * Resolve the string references in a node: "$16" to its text row, "$$..." to a literal
 * "$...". Other references ("$L1f", "$5:props:...") are left as they are; no field read
 * here holds one in the copy that findRvoPageNode returns.
 */
function resolveFlightRefs(value: unknown, rows: Map<string, string>, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.startsWith("$$")) return value.slice(1);
    const ref = /^\$([0-9a-f]+)$/.exec(value)?.[1];
    return ref ? (rows.get(ref) ?? value) : value;
  }
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => resolveFlightRefs(v, rows, depth + 1));
  const o = asRecord(value);
  if (!o) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = resolveFlightRefs(v, rows, depth + 1);
  return out;
}

/**
 * The page's own node in the flight payload: the object that starts with its id, with
 * its text references resolved. It occurs twice; the second copy points back to the
 * first ("$5:props:...:subsidyStatus"), so the copy with real values is taken.
 */
export function findRvoPageNode(flight: string, id: string): Record<string, unknown> | undefined {
  const marker = `{"id":"${id}"`;
  let idx = flight.indexOf(marker);
  for (let n = 0; idx >= 0 && n < 6; n++) {
    const text = objectAt(flight, idx);
    if (text) {
      try {
        const node = asRecord(JSON.parse(text));
        if (node && (asRecord(node.subsidyStatus) || Array.isArray(node.contentElements))) {
          return resolveFlightRefs(node, rvoFlightTextRows(flight)) as Record<string, unknown>;
        }
      } catch {
        // Not a complete object; try the next occurrence.
      }
    }
    idx = flight.indexOf(marker, idx + marker.length);
  }
  return undefined;
}

/**
 * The id (uuid) of the page's own node in its page data: the first node with blocks or a
 * status whose url (or last breadcrumb) is `path`. The open data API knows a page by it.
 */
export function rvoPageNodeId(flight: string, path: string): string | undefined {
  const want = pathKey(path);
  const seen = new Set<string>();
  for (const m of flight.matchAll(/\{"id":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > 400) break;
    const node = findRvoPageNode(flight, id);
    if (!node) continue;
    const crumbs = Array.isArray(node.breadcrumbs) ? node.breadcrumbs : [];
    const url = str(node.url) ?? str(asRecord(crumbs[crumbs.length - 1])?.uri);
    if (!url) continue;
    try {
      if (pathKey(new URL(url, SITE).pathname) === want) return id;
    } catch {
      // not a URL
    }
  }
  return undefined;
}

function canonicalOf(html: string): string | undefined {
  const tag = html.match(/<link\b[^>]*\brel="canonical"[^>]*>/i)?.[0];
  return tag?.match(/\bhref="([^"]+)"/i)?.[1];
}

/** The status flag in the rendered page; used only when the page data cannot be read. */
function flagLabel(html: string): string | undefined {
  const m = html.match(/class="subsidy-flag-wrapper"[\s\S]{0,600}?<span>([^<>]{2,80})<\/span>/);
  return m ? htmlToText(m[1]) || undefined : undefined;
}

export function rvoStatusCode(label: string | undefined): RvoStatusCode {
  if (!label) return "onbekend";
  const folded = foldRvo(label);
  for (const code of RVO_STATUSSEN) if (foldRvo(RVO_STATUS_LABELS[code]) === folded) return code;
  return "overig";
}

const DAY = new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", day: "numeric", month: "long", year: "numeric" });
const TIME = new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" });
/** The calendar day in Amsterdam as YYYY-MM-DD, for comparing days. */
const AMS_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" });

function isoDate(value: unknown): { raw: string; date: Date } | undefined {
  const raw = str(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}/.test(raw)) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : { raw, date };
}

function inWords(d: Date, withTime: boolean): string {
  return withTime ? `${DAY.format(d)} ${TIME.format(d)}` : DAY.format(d);
}

const EUR = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 0 });

function euro(n: number): string {
  return `€ ${EUR.format(n)}`;
}

const BUDGET_CLOSED_PATTERNS: RegExp[] = [
  // "het budget voor 2026 is uitgeput", "Het budget voor deze regeling is op 2 juni overtekend"
  /[\p{L}-]*budget\b(?<gap>[^.!?]{0,80}?)\b(?:is|was|zijn|waren|raakte)\b(?<gap2>[^.!?]{0,60}?)\b(?:uitgeput|overtekend)\b/iu,
  // "Het budget voor 2026 van deze regeling is op."
  /[\p{L}-]*budget\b(?<gap>[^.!?]{0,80}?)\b(?:is|was)\s+(?:nu\s+|inmiddels\s+|helaas\s+|al\s+)?op\s*(?=[.!;,]|$)/iu,
  // "op 1 oktober 2026 raakte het AanZET-budget overtekend"
  /\b(?:raakte|is|was)\s+(?:het|de)\s+[\p{L}-]*budget\s+(?:overtekend|uitgeput)\b/iu,
  // "het subsidieplafond is bereikt"
  /[\p{L}-]*plafond\b(?<gap>[^.!?]{0,60}?)\b(?:is|was)\s+(?:nu\s+|inmiddels\s+|al\s+)?bereikt\b/iu,
  // "Deze regeling is gesloten."
  /^(?:let op:\s*)?(?:deze|de)\s+(?:subsidie)?regeling\s+is\s+(?:nu\s+|definitief\s+)?gesloten\b/iu,
  // "U kunt geen aanvraag meer indienen." / "u kunt niet meer aanvragen." (the whole rest of the sentence)
  /(?:^|[;,:]\s*)(?:let op:\s*)?u kunt (?:(?:deze|de) (?:subsidie|regeling) )?(?:geen (?:nieuwe )?(?:aanvraag|aanvragen) meer (?:indienen|doen)|niet meer aanvragen)\s*[.!]?$/iu,
];

/**
 * Sentences in which the page text itself says the budget is used up or oversubscribed, the
 * subsidieplafond is reached or no more applications can be made. Conservative: questions,
 * headings, conditions ("Als ...", "Dan ...", "totdat het budget ...") and negations ("nog
 * niet overtekend") do not count. The sentence is returned as written, year included.
 */
export function rvoBudgetClosedSentences(texts: string[], max = 3): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const body = line.replace(/^-\s+/, "").replace(/^["'“”]+|["'“”]+$/g, "");
      for (const piece of body.split(/(?<=[.!?])\s+(?=["'“(]?\p{Lu})|(?<=\p{Ll}[.!?])(?=\p{Lu})/u)) {
        const sentence = piece.trim();
        if (!sentence || sentence.endsWith("?") || /^(?:dan|als|wanneer|indien|zodra|stel)\b/iu.test(sentence)) continue;
        const hit = BUDGET_CLOSED_PATTERNS.some((re) => {
          const m = re.exec(sentence);
          if (!m) return false;
          const gaps = `${m.groups?.gap ?? ""} ${m.groups?.gap2 ?? ""}`;
          if (/\b(?:niet|geen|bijna)\b/iu.test(gaps)) return false;
          // "..., totdat het budget is uitgeput": a condition, not a statement.
          return !/\b(?:totdat|tot|als|wanneer|indien|zodra|voordat|nadat)\b[^,;:]*$/iu.test(sentence.slice(0, m.index));
        });
        if (!hit) continue;
        const key = foldRvo(sentence);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(sentence.length > 300 ? `${sentence.slice(0, 297)}...` : sentence);
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

/**
 * Status, period and budget from the page node. Values are taken as they are; the only
 * things computed are period_state (now against the dates), budget_available_eur (as
 * the page computes "Nog beschikbaar") and a note where the label and dates disagree.
 */
export function rvoStatusFromNode(node: Record<string, unknown>, pageUrl: string, now: Date = new Date()): RvoSubsidyStatus {
  const label = str(asRecord(node.subsidyStatus)?.name);
  const out: RvoSubsidyStatus = { status: rvoStatusCode(label), status_source_url: pageUrl };
  if (label) out.status_label = label;
  const evidence: string[] = [`subsidyStatus.name=${label ? JSON.stringify(label) : "null"}`];

  const start = isoDate(node.startDate);
  const end = isoDate(node.endDate);
  const withTime = node.disableTime !== true;
  if (start) {
    out.application_start = start.raw;
    evidence.push(`startDate=${start.raw}`);
  }
  if (end) {
    out.application_end = end.raw;
    evidence.push(`endDate=${end.raw}`);
  }
  if (start && end) out.period_text = `${inWords(start.date, withTime)} tot ${inWords(end.date, withTime)}`;
  else if (start) out.period_text = `vanaf ${inWords(start.date, withTime)}`;
  else if (end) out.period_text = `tot ${inWords(end.date, withTime)}`;
  if (start || end) {
    if (withTime) {
      const t = now.getTime();
      out.period_state = start && t < start.date.getTime() ? "not_started" : end && t > end.date.getTime() ? "ended" : "running";
    } else {
      // Without times (disableTime) the page shows days, and "tot 31 december 2026" includes that
      // day (endDate is its midnight): the days are compared in Amsterdam time.
      const today = AMS_DAY.format(now);
      out.period_state = start && today < AMS_DAY.format(start.date) ? "not_started" : end && today > AMS_DAY.format(end.date) ? "ended" : "running";
    }
  }

  const budget = asRecord(node.budget);
  const total = num(budget?.total);
  const inProgress = num(budget?.negotiation);
  if (total !== undefined) {
    out.budget_total_eur = total;
    evidence.push(`budget.total=${total}`);
  }
  if (inProgress !== undefined) {
    out.budget_in_progress_eur = inProgress;
    evidence.push(`budget.negotiation=${inProgress}`);
  }
  if (total !== undefined && inProgress !== undefined) out.budget_available_eur = Math.max(0, total - inProgress);
  const budgetDate = str(budget?.budgetDate);
  if (budgetDate) out.budget_date = budgetDate;
  const budgetNote = plain(budget?.additionalInfo);
  if (budgetNote) out.budget_note = budgetNote;
  const info = plain(node.description);
  if (info) {
    out.subsidy_info = info;
    const infoTitle = plain(budget?.descriptionTitle).replace(/:\s*$/, "");
    if (infoTitle) out.subsidy_info_title = infoTitle;
  }
  const checked = str(node.checked);
  if (checked) out.page_checked_at = checked;
  const notice = plain(asRecord(node.notifications)?.changes);
  if (notice) out.change_notice = notice;
  out.status_evidence = `${evidence.join("; ")} (paginagegevens van ${pageUrl})`;

  const notes: string[] = [];
  if (!label) notes.push("De pagina toont geen statuslabel.");
  const shown = (d: { date: Date }) => inWords(d.date, withTime);
  if (out.status === "open" && end && out.period_state === "ended") {
    notes.push(`Label '${label}', maar de einddatum op de pagina (${shown(end)}) is voorbij.`);
  } else if (out.status === "open" && start && out.period_state === "not_started") {
    notes.push(`Label '${label}', maar de aanvraagperiode op de pagina begint pas op ${shown(start)}.`);
  } else if ((out.status === "gesloten" || out.status === "tijdelijk_gesloten") && out.period_state === "running") {
    notes.push(`Label '${label}', terwijl de periode op de pagina (${out.period_text}) nog loopt.`);
  } else if (out.status === "bijna_open" && out.period_state === "running") {
    notes.push(`Label '${label}', terwijl de periode op de pagina (${out.period_text}) al loopt.`);
  }
  if (out.status !== "gesloten") {
    // The label is kept as RVO shows it; a sentence in the page text that says the budget is
    // used up or applications are closed is quoted next to it (it may concern one year or part).
    const said = rvoBudgetClosedSentences([
      ...(typeof node.intro === "string" ? rvoHtmlLines(node.intro) : []),
      ...(notice ? [notice] : []),
      ...(budgetNote ? [budgetNote] : []),
      ...(Array.isArray(node.contentElements) ? renderRvoElements(node.contentElements).lines : []),
    ]);
    if (said.length) {
      notes.push(
        `${label ? `Label '${label}' ongewijzigd overgenomen, maar de` : "De"} paginatekst zegt: ${said.map((x) => `"${x}"`).join("; ")}.`,
      );
    }
  }
  if (notes.length) out.status_note = notes.join(" ");
  return out;
}

export interface RvoPageRead {
  status: RvoSubsidyStatus;
  /** The page's blocks (contentElements), when the page data could be read. */
  elements?: unknown[];
}

/**
 * Read a fetched page: the node with the item's id from the page data, or only the
 * rendered status flag when that is missing. A page whose canonical URL is another
 * page (the old URL redirects there) says nothing about this entry.
 */
export function parseRvoPage(html: string, id: string, pageUrl: string, now: Date = new Date()): RvoPageRead {
  const canonical = canonicalOf(html);
  if (canonical && pathKey(new URL(canonical, SITE).pathname) !== pathKey(new URL(pageUrl).pathname)) {
    return {
      status: {
        status: "onbekend",
        status_source_url: pageUrl,
        status_note: `De pagina verwijst door naar ${canonical}; die gaat niet over deze regeling, dus status, periode en budget zijn onbekend.`,
      },
    };
  }
  const node = findRvoPageNode(extractRvoFlight(html), id);
  if (node) {
    const elements = Array.isArray(node.contentElements) ? node.contentElements : undefined;
    return { status: rvoStatusFromNode(node, pageUrl, now), ...(elements ? { elements } : {}) };
  }
  const flag = flagLabel(html);
  if (flag) {
    return {
      status: {
        status: rvoStatusCode(flag),
        status_label: flag,
        status_source_url: pageUrl,
        status_evidence: `statuslabel op de pagina: ${JSON.stringify(flag)}`,
        status_note: "Alleen het statuslabel is van de pagina gelezen; de paginagegevens met periode en budget waren niet te vinden.",
      },
    };
  }
  return {
    status: {
      status: "onbekend",
      status_source_url: pageUrl,
      status_note: "Status, periode en budget niet gevonden op de pagina (de opbouw van rvo.nl is mogelijk veranderd).",
    },
  };
}

// ---------------------------------------------------------------------------
// Text

const BLOCK_TAG = /<(\/?)(h[1-6]|p|li|ul|ol|tr|td|th|table|thead|tbody|caption|div|br|blockquote|section|figure|figcaption)\b[^>]*>/gi;

/** HTML as lines: headings as "## "/"### ", list items as "- ", table cells joined with " | ". */
export function rvoHtmlLines(html: string): string[] {
  const lines: string[] = [];
  const source = html.replace(RVO_MARKER, " ");
  let buf = "";
  let prefix = "";
  const flush = () => {
    const t = htmlToText(buf);
    if (t) {
      lines.push(prefix + t);
      prefix = "";
    }
    buf = "";
  };
  let last = 0;
  for (const m of source.matchAll(BLOCK_TAG)) {
    buf += source.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (tag === "td" || tag === "th") {
      if (!closing && htmlToText(buf)) buf += " | ";
      else buf += " ";
      continue;
    }
    flush();
    if (closing) {
      if (/^h\d$/.test(tag) || tag === "li") prefix = "";
      continue;
    }
    if (tag === "h1" || tag === "h2") prefix = "## ";
    else if (/^h[3-6]$/.test(tag)) prefix = "### ";
    else if (tag === "li") prefix = "- ";
  }
  buf += source.slice(last);
  flush();
  return lines;
}

function absoluteUrl(uri: string): string | undefined {
  try {
    return new URL(uri, SITE).toString();
  } catch {
    return undefined;
  }
}

interface RenderedBlocks {
  lines: string[];
  /** HTML of the rich-text parts, for the legal references. */
  html: string[];
  downloads: RvoLink[];
  links: RvoLink[];
  skipped: Map<string, number>;
}

/** The page's blocks as lines, in page order: text, uitklapblokken, meldingen, downloads, links. */
export function renderRvoElements(elements: unknown[]): RenderedBlocks {
  const out: RenderedBlocks = { lines: [], html: [], downloads: [], links: [], skipped: new Map() };
  const skip = (type: string) => out.skipped.set(type, (out.skipped.get(type) ?? 0) + 1);
  const walk = (value: unknown, depth: number): void => {
    const e = asRecord(value);
    if (!e || depth > 6) return;
    const type = str(e.type) ?? "?";
    const text = (html: unknown) => {
      if (typeof html !== "string" || !html.trim()) return;
      out.html.push(html);
      out.lines.push(...rvoHtmlLines(html));
    };
    const children = () => {
      if (Array.isArray(e.childElements)) for (const c of e.childElements) walk(c, depth + 1);
    };
    switch (type) {
      case "wysiwyg":
      case "textwrap":
        text(e.text);
        break;
      case "notice":
      case "frame":
      case "call_to_action":
        children();
        break;
      case "accordion":
        if (Array.isArray(e.panels)) {
          for (const p of e.panels) {
            const panel = asRecord(p);
            const title = plain(panel?.title);
            if (title) out.lines.push(`### ${title}`);
            if (Array.isArray(panel?.childElements)) for (const c of panel.childElements) walk(c, depth + 1);
          }
        }
        break;
      case "downloads":
        if (Array.isArray(e.files)) {
          for (const f of e.files) {
            const file = asRecord(f);
            const name = plain(file?.name);
            const url = str(file?.uri) ? absoluteUrl(str(file?.uri) as string) : undefined;
            if (!name || !url) continue;
            const mimetype = str(file?.mimetype);
            const size = num(file?.size);
            out.downloads.push({ title: name, url, ...(mimetype ? { mimetype } : {}), ...(size !== undefined ? { size_bytes: size } : {}) });
            out.lines.push(`- Download: ${name}`);
          }
        }
        break;
      case "links":
        if (Array.isArray(e.links)) {
          for (const l of e.links) {
            const link = asRecord(l);
            const title = plain(link?.title);
            const url = str(link?.uri) ? absoluteUrl(str(link?.uri) as string) : undefined;
            if (!title || !url) continue;
            out.links.push({ title, url });
            out.lines.push(`- ${title}`);
          }
        }
        break;
      case "important_dates":
        if (Array.isArray(e.dates)) {
          for (const d of e.dates) {
            const item = asRecord(d);
            const line = [str(item?.date), plain(item?.title), plain(item?.suffix)].filter(Boolean).join(" ");
            if (line) out.lines.push(`- ${line}`);
          }
        }
        break;
      case "quote": {
        const quote = plain(e.quote);
        const author = plain(e.author);
        if (quote) out.lines.push(`"${quote}"${author ? ` (${author})` : ""}`);
        break;
      }
      case "split_container":
        walk(e.left, depth + 1);
        walk(e.right, depth + 1);
        break;
      case "webform_block": {
        const title = plain(e.title);
        if (title) out.lines.push(`Formulier: ${title}`);
        break;
      }
      case "vector_image":
      case "image":
        // An infographic's caption is its text ("Voor wie?" as a list beside the picture).
        if (typeof e.caption === "string" && e.caption.trim()) text(e.caption);
        else skip(type);
        break;
      default:
        // Video and anything new: nothing to read as text.
        skip(type);
    }
  };
  for (const e of elements) walk(e, 0);
  return out;
}

/** A link as a legal reference, when it points to wetten.overheid.nl, officielebekendmakingen.nl or EUR-Lex. */
function legalReference(href: string): RvoLegalReference | undefined {
  let url: URL;
  try {
    url = new URL(href.replace(/&amp;/g, "&"), SITE);
    if (url.hostname.endsWith("safelinks.protection.outlook.com")) {
      // The wrapper also carries the sender's mailbox; only the target is kept.
      const target = url.searchParams.get("url");
      if (!target) return undefined;
      url = new URL(target);
    }
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host.endsWith("wetten.overheid.nl")) {
    const id = url.toString().match(/BWBR\d{7}/i)?.[0]?.toUpperCase();
    return { kind: "bwb", ...(id ? { id } : {}), url: url.toString() };
  }
  if (host.endsWith("officielebekendmakingen.nl")) {
    const id = url.pathname.match(/\b((?:stcrt|stb|trb|gmb|prb|wsb|bgr|kst|ah-tk|h-tk|kv-tk|blg)-[\w-]*\d)\b/i)?.[1]?.toLowerCase();
    return { kind: "officiele_bekendmaking", ...(id ? { id } : {}), url: url.toString() };
  }
  if (host.endsWith("eur-lex.europa.eu")) {
    const celex = url.searchParams.get("uri")?.match(/CELEX:([0-9A-Z()_-]+)/i)?.[1] ?? url.toString().match(/CELEX[:%3A]+([0-9A-Z]+)/i)?.[1];
    const eli = url.pathname.match(/\/eli\/[^?#]+?(?:\/oj)?(?=\/[a-z]{3}$|$)/)?.[0];
    const id = celex?.toUpperCase() ?? eli;
    return { kind: "eur_lex", ...(id ? { id } : {}), url: url.toString() };
  }
  return undefined;
}

/**
 * Links to wetten.overheid.nl, officielebekendmakingen.nl and EUR-Lex, from anchors in
 * the HTML and from the page's link lists (where "Officiële wettekst" usually sits);
 * Outlook safelinks unwrapped.
 */
export function rvoLegalReferences(htmls: string[], links: RvoLink[] = []): RvoLegalReference[] {
  const candidates: Array<{ href: string; label?: string }> = [];
  for (const html of htmls) {
    for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      candidates.push({ href: m[1], label: htmlToText(m[2]) || undefined });
    }
  }
  for (const l of links) candidates.push({ href: l.url, label: l.title });
  const out: RvoLegalReference[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const ref = legalReference(c.href);
    if (!ref) continue;
    const key = `${ref.kind}|${ref.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c.label ? { ...ref, label: c.label } : ref);
    if (out.length >= MAX_LEGAL_REFERENCES) break;
  }
  return out;
}

/** Headings of the second level ("## ...") in the lines. */
function sectionsOf(lines: string[]): string[] {
  return lines.filter((l) => l.startsWith("## ")).map((l) => l.slice(3));
}

/** The sections whose heading contains `term` (folded), each up to the next "## " heading. */
function selectSections(lines: string[], term: string): string[] {
  const target = foldRvo(term);
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.startsWith("## ")) inside = foldRvo(line.slice(3)).includes(target);
    if (inside) out.push(line);
  }
  return out;
}

function truncateLines(lines: string[], maxChars: number): { text: string; chars: number; truncated: boolean } {
  const full = lines.join("\n");
  if (full.length <= maxChars) return { text: full, chars: full.length, truncated: false };
  const cut = full.lastIndexOf("\n", maxChars);
  const text = `${full.slice(0, cut > maxChars / 2 ? cut : maxChars).trimEnd()}\n…`;
  return { text, chars: full.length, truncated: true };
}

// ---------------------------------------------------------------------------
// Notes and summaries

const BASE_NOTE =
  "Bron: open data van RVO (www.rvo.nl/api/v1/opendata/subsidies; dataset 'subsidies-en-financiering-rvo-nl', CC0): " +
  "alle pagina's van het onderdeel Subsidies en financiering van rvo.nl, met gesloten en historische regelingen en de subpagina's " +
  "van regelingen (aanvragen, voorwaarden, oproepen). Alleen wat RVO uitvoert; regelingen van andere loketten (NWO, ZonMw, DUS-I, " +
  "provincies, gemeenten, Europese Commissie) staan er niet in.";

const STATUS_NOTE =
  "Status, aanvraagperiode en budget staan niet in de open-data-API; ze komen van de openbare pagina op rvo.nl (status_source_url) " +
  "zoals RVO ze daar toont. Er wordt niets afgeleid uit de lopende tekst. Een regeling kan per ronde of onderdeel verschillen; " +
  "lees de pagina voor de precieze voorwaarden.";

/** Start of the status_note of a page that was not read within the time of its search. */
const NOT_READ_IN_TIME = "Status onbekend: de pagina is niet gelezen binnen de tijdslimiet";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function statusCounts(items: RvoSearchHit[]): string {
  const counts = new Map<string, number>();
  for (const x of items) {
    if (!x.status_info) continue;
    const key = x.status_info.status_note?.startsWith(NOT_READ_IN_TIME) ? "niet op tijd gelezen" : (x.status_info.status_label ?? x.status_info.status);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => `${n} ${k === "onbekend" || k === "niet op tijd gelezen" ? k : `'${k}'`}`).join(", ");
}

export function summarizeRvoSearch(out: RvoSubsidiesSearchResult): string {
  const filterText = Object.entries(out.filters).map(([k, v]) => `${k}: ${v}`).join(", ");
  const count = out.total === null ? `minstens ${out.status_checks?.matches ?? out.offset + out.items.length}` : String(out.total);
  let summary = `${count} ${out.total === 1 ? "pagina" : "pagina's"} over subsidies en financiering van RVO`;
  if (out.query) summary += ` voor '${out.query}'`;
  if (filterText) summary += ` (${filterText})`;
  if (out.items.length) summary += `; getoond ${out.offset + 1}-${out.offset + out.items.length}`;
  else if (out.total && out.offset >= out.total) summary += `; geen resultaten vanaf offset ${out.offset}`;
  if (out.status_checks) {
    summary += `; status van ${out.status_checks.checked} van ${out.status_checks.candidates} kandidaten gelezen`;
  } else {
    const withStatus = out.items.filter((x) => x.status_info).length;
    if (withStatus && withStatus < out.items.length) summary += `; status opgevraagd voor de eerste ${withStatus} (hooguit ${RVO_STATUS_ENRICH_MAX} per aanroep)`;
  }
  const counts = statusCounts(out.items);
  if (counts) summary += `; status getoond: ${counts}`;
  return summary;
}

export function summarizeRvoGet(out: RvoSubsidieGetFound): string {
  const s = out.status_info;
  const parts = [`RVO: ${out.item.title}`];
  if (s?.status_label) parts.push(s.status_label);
  else if (s) parts.push("status onbekend");
  if (s?.period_text) parts.push(`aanvraagperiode ${s.period_text}`);
  if (s?.budget_total_eur !== undefined) parts.push(`budget ${euro(s.budget_total_eur)}`);
  parts.push(`tekst ${out.text_truncated ? `${out.text.length} van ${out.text_chars}` : out.text_chars} tekens (${out.text_source})`);
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// Source

/** Seconds as said in a note: "10", "0,5". */
function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10}`.replace(".", ",");
}

/** Resolves after `ms`; `clear` stops the timer once it is no longer needed. */
function timer(ms: number): { done: Promise<"deadline">; clear: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<"deadline">((resolve) => {
    handle = setTimeout(() => resolve("deadline"), Math.max(0, ms));
  });
  return { done, clear: () => clearTimeout(handle) };
}

export interface RvoSubsidiesSourceOptions {
  /** How long loading the catalogue may take (CATALOGUE_DEADLINE_MS). */
  catalogueDeadlineMs?: number;
  /** How long one search may read status pages (STATUS_BUDGET_MS). */
  statusBudgetMs?: number;
}

/** A page on rvo.nl for a path the catalogue lacks. */
interface SitePage {
  url: string;
  title?: string;
  status_data: boolean;
  /** The page's own id in its page data, and the page read with it. */
  node_id?: string;
  read?: RvoPageRead;
}

export class RvoSubsidiesSource {
  private catalogue?: { value: Catalogue; expiresAt: number };
  private catalogueLoad?: Promise<{ value: Catalogue; stale: boolean }>;
  private readonly statusCache = new Map<string, { value: RvoSubsidyStatus; expiresAt: number }>();
  private readonly catalogueDeadlineMs: number;
  private readonly statusBudgetMs: number;

  constructor(
    private readonly config: AppConfig,
    options: RvoSubsidiesSourceOptions = {},
  ) {
    this.catalogueDeadlineMs = options.catalogueDeadlineMs ?? CATALOGUE_DEADLINE_MS;
    this.statusBudgetMs = options.statusBudgetMs ?? STATUS_BUDGET_MS;
  }

  private async fetchListPage(page: number): Promise<unknown[]> {
    const { data, meta } = await getJson<unknown>(RVO_SUBSIDIES_ENDPOINT, {
      query: { page },
      connector: RVO_SUBSIDIES_CONNECTOR,
      timeoutMs: TIMEOUT_MS,
      retries: RETRIES,
      // The parsed catalogue is cached below; the raw pages need not be.
      disableCache: true,
    });
    if (!Array.isArray(data)) {
      throw new SourceRequestError({
        message: "RVO open data gaf geen lijst terug.",
        endpoint: meta.url,
        code: "malformed_response",
      });
    }
    return data;
  }

  /**
   * Every list page, CONCURRENCY at a time, until a page comes back short or empty.
   * A failed page is left out and reported. When page 0 fails, or CONCURRENCY pages do,
   * no further pages are asked (an upstream that is down would otherwise be asked for
   * all MAX_LIST_PAGES); only when no page could be read at all is that an error.
   * Reading stops at the deadline: the pages still under way then are missing (their
   * answers are not waited for and change nothing), and when the last page is not known
   * yet the rest is too (truncated "deadline").
   */
  private async loadPages(): Promise<{ rows: unknown[]; pagesRead: number; missing: number[]; truncated?: RvoCatalogueTruncation }> {
    const results = new Map<number, unknown[]>();
    const failed = new Map<number, unknown>();
    const underWay = new Set<number>();
    let next = 0;
    let end = Number.POSITIVE_INFINITY;
    let stopped = false;
    let late = false;
    const worker = async () => {
      while (!stopped && !late && next < Math.min(end, MAX_LIST_PAGES)) {
        const page = next++;
        underWay.add(page);
        try {
          const rows = await this.fetchListPage(page);
          if (late) return;
          results.set(page, rows);
          if (rows.length === 0) end = Math.min(end, page);
          else if (rows.length < LIST_PAGE_SIZE) end = Math.min(end, page + 1);
        } catch (error) {
          if (late) return;
          failed.set(page, error);
          if (page === 0 || failed.size >= CONCURRENCY) stopped = true;
        } finally {
          underWay.delete(page);
        }
      }
    };
    const deadline = timer(this.catalogueDeadlineMs);
    try {
      late = (await Promise.race([Promise.all(Array.from({ length: CONCURRENCY }, () => worker())), deadline.done])) === "deadline";
    } finally {
      deadline.clear();
    }
    // Page 0 is asked first: with nothing read it failed, or it was still under way at the deadline.
    if (!results.size) {
      throw (
        failed.get(0) ??
        new SourceRequestError({
          message: `RVO open data gaf binnen ${seconds(this.catalogueDeadlineMs)} s geen lijstpagina terug.`,
          endpoint: RVO_SUBSIDIES_ENDPOINT,
          code: "timeout",
        })
      );
    }
    const known = Number.isFinite(end);
    const last = known ? end : Math.min(next, MAX_LIST_PAGES);
    const rows: unknown[] = [];
    for (let p = 0; p < last; p++) rows.push(...(results.get(p) ?? []));
    // A page past the end that still held rows (the list grew while it was read).
    for (const [p, r] of results) if (p >= last) rows.push(...r);
    const missing = [...failed.keys(), ...underWay].filter((p) => p < last).sort((a, b) => a - b);
    const truncated = known ? undefined : stopped ? "stopped" : late ? "deadline" : "max_pages";
    return { rows, pagesRead: results.size, missing, ...(truncated ? { truncated } : {}) };
  }

  /**
   * The catalogue, cached for CATALOGUE_TTL_MS; one load at a time, which every caller
   * meanwhile shares, so none waits past its deadline. A failed refresh, or an incomplete
   * one when the previous catalogue was complete, keeps serving the previous catalogue
   * (stale) and is retried after CATALOGUE_RETRY_MS; an incomplete one is kept only that long.
   */
  private async loadCatalogue(): Promise<{ value: Catalogue; stale: boolean }> {
    const now = Date.now();
    if (this.catalogue && this.catalogue.expiresAt > now) return { value: this.catalogue.value, stale: false };
    if (!this.catalogueLoad) {
      this.catalogueLoad = (async () => {
        try {
          const { rows, pagesRead, missing, truncated } = await this.loadPages();
          const value = buildRvoCatalogue(rows, pagesRead, missing, truncated);
          if (!value.entries.length) {
            throw new SourceRequestError({
              message: "RVO open data gaf een lege catalogus.",
              endpoint: RVO_SUBSIDIES_ENDPOINT,
              code: "malformed_response",
            });
          }
          if (!value.complete && this.catalogue?.value.complete) {
            this.catalogue.expiresAt = Date.now() + CATALOGUE_RETRY_MS;
            return { value: this.catalogue.value, stale: true };
          }
          this.catalogue = { value, expiresAt: Date.now() + (value.complete ? CATALOGUE_TTL_MS : CATALOGUE_RETRY_MS) };
          return { value, stale: false };
        } catch (error) {
          if (this.catalogue) {
            this.catalogue.expiresAt = Date.now() + CATALOGUE_RETRY_MS;
            return { value: this.catalogue.value, stale: true };
          }
          throw error;
        }
      })().finally(() => {
        this.catalogueLoad = undefined;
      });
    }
    return this.catalogueLoad;
  }

  private cachedStatus(id: string): RvoSubsidyStatus | undefined {
    const hit = this.statusCache.get(id);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.statusCache.delete(id);
      return undefined;
    }
    return hit.value;
  }

  /** Only pages that were read are remembered; an unreachable one is tried again next call. */
  private rememberStatus(id: string, value: RvoSubsidyStatus): void {
    this.statusCache.delete(id);
    this.statusCache.set(id, { value, expiresAt: Date.now() + STATUS_TTL_MS });
    while (this.statusCache.size > STATUS_CACHE_MAX) {
      const oldest = this.statusCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.statusCache.delete(oldest);
    }
  }

  /** Fetch and parse the public page of an entry. Never throws: an unreadable page is status "onbekend". */
  async readPage(item: Pick<RvoSubsidyItem, "id" | "url">): Promise<RvoPageRead> {
    try {
      const { data } = await getText(item.url, {
        connector: RVO_SUBSIDIES_PAGES_CONNECTOR,
        timeoutMs: TIMEOUT_MS,
        retries: RETRIES,
        headers: { Accept: "text/html" },
        // About 200 kB each; the parsed status is cached instead.
        disableCache: true,
      });
      const read = parseRvoPage(data, item.id, item.url);
      this.rememberStatus(item.id, read.status);
      return read;
    } catch (error) {
      const why =
        error instanceof SourceRequestError
          ? error.status === 404
            ? "de pagina bestaat niet (meer) (HTTP 404)"
            : `de pagina was niet te lezen (${error.code}${error.status ? ` ${error.status}` : ""})`
          : "de pagina was niet te lezen";
      return { status: { status: "onbekend", status_source_url: item.url, status_note: `Status onbekend: ${why}.` } };
    }
  }

  /**
   * Status of each item: cached or read, CONCURRENCY pages at a time, until `deadline`
   * (epoch ms). A page not read by then is 'onbekend' and listed in `late`; a read still
   * under way is not waited for, but its status is remembered for the next call.
   */
  private async statuses(items: RvoSubsidyItem[], deadline: number): Promise<{ byId: Map<string, RvoSubsidyStatus>; late: Set<string> }> {
    const byId = new Map<string, RvoSubsidyStatus>();
    const todo: RvoSubsidyItem[] = [];
    for (const item of items) {
      const cached = this.cachedStatus(item.id);
      if (cached) byId.set(item.id, cached);
      else todo.push(item);
    }
    let next = 0;
    let stop = false;
    const worker = async () => {
      while (!stop && next < todo.length) {
        const item = todo[next++];
        const read = await this.readPage(item);
        if (!stop) byId.set(item.id, read.status);
      }
    };
    if (todo.length && deadline > Date.now()) {
      const budget = timer(deadline - Date.now());
      try {
        await Promise.race([Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, () => worker())), budget.done]);
      } finally {
        stop = true;
        budget.clear();
      }
    }
    const late = new Set<string>();
    for (const item of todo) {
      if (byId.has(item.id)) continue;
      late.add(item.id);
      byId.set(item.id, {
        status: "onbekend",
        status_source_url: item.url,
        status_note: `${NOT_READ_IN_TIME} (${seconds(this.statusBudgetMs)} s voor de statuspagina's van een zoekvraag); rvo_subsidie_get leest haar apart.`,
      });
    }
    return { byId, late };
  }

  async search(args: RvoSubsidiesSearchArgs): Promise<RvoSubsidiesSearchResult> {
    const query = (args.query ?? "").replace(/\s+/g, " ").trim();
    const offset = Math.max(0, Math.floor(args.offset ?? 0));
    const limit = Math.min(RVO_MAX_ROWS, Math.max(1, Math.floor(args.limit ?? RVO_DEFAULT_ROWS)));
    const sort: RvoSort = args.sort ?? (query ? "relevance" : "changed");
    const statusFilter = [...new Set(args.status ?? [])];
    const includeStatus = args.include_status !== false;
    const since = args.changed_since?.trim();
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      throw new RvoSubsidiesInputError(`changed_since '${since}' is geen datum JJJJ-MM-DD.`, "Geef bijvoorbeeld '2026-09-01'.");
    }

    const { value: cat, stale } = await this.loadCatalogue();
    const parsed = parseRvoQuery(query);
    const notes: string[] = [BASE_NOTE];
    const filters: Record<string, string> = {};
    let candidates = cat.entries;

    const facet = (
      key: "doelgroep" | "onderwerp" | "sector",
      input: string | undefined,
      field: "targets" | "subjects" | "sectors",
    ): boolean => {
      const raw = input?.trim();
      if (!raw) return true;
      const values = cat.entries.flatMap((e) => e.item[field]);
      const matched = resolveRvoFacet(raw, values);
      if (!matched.length) {
        const counts = new Map<string, number>();
        for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
        const known = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([v]) => v);
        notes.push(`${key[0].toUpperCase()}${key.slice(1)} '${raw}' komt in de catalogus niet voor; bekend zijn onder meer: ${known.join("; ")}.`);
        filters[key] = `${raw} (onbekend)`;
        return false;
      }
      filters[key] = matched.join(" | ");
      const set = new Set(matched);
      candidates = candidates.filter((e) => e.item[field].some((v) => set.has(v)));
      return true;
    };

    let known = facet("doelgroep", args.doelgroep, "targets");
    known = facet("onderwerp", args.onderwerp, "subjects") && known;
    known = facet("sector", args.sector, "sectors") && known;
    const land = args.land?.trim();
    if (land) {
      const byCode = /^[a-z]{2}$/i.test(land)
        ? [...new Set(cat.entries.flatMap((e) => e.item.countries).filter((c) => c.code === land.toUpperCase()).map((c) => c.name))]
        : [];
      const matched = byCode.length ? byCode : resolveRvoFacet(land, cat.entries.flatMap((e) => e.item.countries.map((c) => c.name)));
      if (!matched.length) {
        notes.push(`Land '${land}' komt in de catalogus niet voor (gebruik de Nederlandse naam, bijv. 'Ghana', 'Caribisch Nederland', of de ISO-code).`);
        filters.land = `${land} (onbekend)`;
        known = false;
      } else {
        filters.land = matched.join(" | ");
        const set = new Set(matched);
        candidates = candidates.filter((e) => e.item.countries.some((c) => set.has(c.name)));
      }
    }
    if (!known) candidates = [];
    if (since) {
      filters.changed_since = since;
      candidates = candidates.filter((e) => (e.item.changed ?? "").slice(0, 10) >= since);
    }
    if (args.main_pages_only) {
      filters.main_pages_only = "ja";
      candidates = candidates.filter((e) => e.item.main_page);
    }

    const scored: Array<{ e: Entry; score: number }> = [];
    for (const e of candidates) {
      const score = scoreRvoEntry(e.f, parsed);
      // A regeling's own page goes before its sub-pages (FAQ, rekentool, aanvragen) at about equal relevance.
      if (score !== undefined) scored.push({ e, score: score + (parsed.groups.length && e.item.main_page ? MAIN_PAGE_BONUS : 0) });
    }
    const byChanged = (a: Entry, b: Entry) => (b.item.changed ?? "").localeCompare(a.item.changed ?? "");
    scored.sort((a, b) => {
      if (sort === "relevance") return b.score - a.score || byChanged(a.e, b.e);
      if (sort === "created") return (b.e.item.created ?? "").localeCompare(a.e.item.created ?? "") || byChanged(a.e, b.e);
      if (sort === "title") return a.e.item.title.localeCompare(b.e.item.title, "nl");
      return byChanged(a.e, b.e);
    });

    const hit = (x: { e: Entry; score: number }, status?: RvoSubsidyStatus): RvoSearchHit => ({
      ...x.e.item,
      ...(parsed.groups.length ? { score: x.score } : {}),
      ...(status ? { status_info: status } : {}),
    });

    let items: RvoSearchHit[];
    let total: number | null;
    let hasMore: boolean;
    let statusChecks: RvoSubsidiesSearchResult["status_checks"];
    /** Status pages read (or cached) for this answer. */
    let statusPages = 0;
    const budget = seconds(this.statusBudgetMs);
    if (statusFilter.length) {
      // Status is only on the pages: read them in order of the ranking until there are
      // enough matches for this window, at most RVO_STATUS_CHECK_MAX per call and within
      // the time budget.
      filters.status = statusFilter.map((s) => RVO_STATUS_LABELS[s]).join(" | ");
      const wanted = new Set<RvoStatusCode>(statusFilter);
      const matches: RvoSearchHit[] = [];
      let checked = 0;
      let unreadable = 0;
      let i = 0;
      let reads = 0;
      let late = 0;
      const deadline = Date.now() + this.statusBudgetMs;
      while (i < scored.length && matches.length < offset + limit && reads < RVO_STATUS_CHECK_MAX && !late) {
        const batch: Array<{ e: Entry; score: number }> = [];
        while (i < scored.length && batch.length < CONCURRENCY * 2) {
          const x = scored[i++];
          if (!this.cachedStatus(x.e.item.id)) {
            if (reads >= RVO_STATUS_CHECK_MAX) {
              i--;
              break;
            }
            reads++;
          }
          batch.push(x);
        }
        if (!batch.length) break;
        const statuses = await this.statuses(batch.map((x) => x.e.item), deadline);
        late = statuses.late.size;
        for (const x of batch) {
          // A page not read in time is not checked: it may well have the status asked for.
          if (statuses.late.has(x.e.item.id)) continue;
          const s = statuses.byId.get(x.e.item.id);
          checked++;
          if (!s || s.status === "onbekend") unreadable++;
          if (s && wanted.has(s.status)) matches.push(hit(x, s));
        }
      }
      const allChecked = i >= scored.length && !late;
      items = matches.slice(offset, offset + limit);
      total = allChecked ? matches.length : null;
      hasMore = matches.length > offset + limit || !allChecked;
      statusChecks = { candidates: scored.length, checked, unreadable, matches: matches.length, all_checked: allChecked };
      statusPages = checked;
      notes.push(
        `Statusfilter: van ${plural(scored.length, "kandidaat", "kandidaten")} is de pagina van ${checked} gelezen ` +
          `(in volgorde van de sortering, hooguit ${RVO_STATUS_CHECK_MAX} nieuwe per aanroep, binnen ${budget} s); ${matches.length} met de gevraagde status.` +
          (allChecked
            ? ""
            : ` De overige ${scored.length - checked} zijn niet gecontroleerd, dus het totaal is onbekend; verfijn de zoekvraag of vraag met offset verder.`) +
          (late
            ? ` De tijdslimiet van ${budget} s voor het lezen van statuspagina's is bereikt: ${plural(late, "pagina is", "pagina's zijn")} niet op tijd gelezen; ` +
              "wat intussen alsnog binnenkomt, gebruikt een volgende aanroep zonder het opnieuw op te vragen."
            : "") +
          (unreadable ? ` Van ${unreadable} was de status niet te lezen; die tellen niet mee.` : ""),
      );
    } else {
      const window = scored.slice(offset, offset + limit);
      total = scored.length;
      hasMore = offset + window.length < scored.length;
      if (includeStatus && window.length) {
        const enrich = window.slice(0, RVO_STATUS_ENRICH_MAX);
        const { byId, late } = await this.statuses(enrich.map((x) => x.e.item), Date.now() + this.statusBudgetMs);
        items = window.map((x) => hit(x, byId.get(x.e.item.id)));
        statusPages = enrich.length - late.size;
        if (window.length > enrich.length) {
          notes.push(
            `Status opgevraagd voor de eerste ${enrich.length} resultaten (hooguit ${RVO_STATUS_ENRICH_MAX} per aanroep); ` +
              "voor de volgende: vraag met offset verder of lees de regeling met rvo_subsidie_get.",
          );
        }
        if (late.size) {
          notes.push(
            `Van ${plural(late.size, "resultaat", "resultaten")} is de pagina niet binnen de tijdslimiet van ${budget} s gelezen; de status is daar onbekend. ` +
              "Wat intussen alsnog binnenkomt, gebruikt een volgende aanroep zonder het opnieuw op te vragen; rvo_subsidie_get leest één regeling apart.",
          );
        }
      } else {
        items = window.map((x) => hit(x));
      }
    }

    if (statusFilter.length || includeStatus) notes.push(STATUS_NOTE);
    else notes.push("Status, aanvraagperiode en budget niet opgevraagd (include_status=false); de lijst bevat ook gesloten regelingen.");
    if (query) {
      notes.push(
        "Gezocht in titel, intro, regelingnamen en tags van de catalogus (alle woorden verplicht, ook als deel van een woord; " +
          "woorden tot 3 letters als heel woord; \"frase\"; OR in hoofdletters voor alternatieven; -woord sluit uit).",
      );
      if (parsed.ignored.length) notes.push(`Genegeerd als te algemeen: ${parsed.ignored.join(", ")}.`);
    }
    if (total === 0 && query && parsed.groups.some((g) => g.length > 1)) {
      notes.push("Geen treffers: alle zoekwoorden moeten voorkomen; probeer minder of andere woorden, of OR.");
    }
    if (stale) notes.push(`De catalogus kon niet worden ververst; dit is de versie van ${cat.loadedAt}.`);
    if (cat.missingPages.length) {
      notes.push(`Onvolledige catalogus: lijstpagina ${cat.missingPages.join(", ")} (${LIST_PAGE_SIZE} items per pagina) kon niet (op tijd) worden gelezen.`);
    }
    if (cat.truncated === "stopped") {
      notes.push("Na mislukte lijstpagina's is het lezen gestopt: de pagina's daarna ontbreken ook.");
    } else if (cat.truncated === "deadline") {
      notes.push(`Het laden van de catalogus is na ${seconds(this.catalogueDeadlineMs)} s afgebroken (rvo.nl was traag): de lijstpagina's na pagina ${cat.pagesRead + cat.missingPages.length - 1} ontbreken ook.`);
    } else if (cat.truncated === "max_pages") {
      notes.push(`De catalogus is afgekapt na ${MAX_LIST_PAGES} lijstpagina's.`);
    }
    if (!cat.complete) notes.push(`Een aanroep na ${CATALOGUE_RETRY_MS / 60_000} minuten laadt de catalogus opnieuw.`);

    const params: Record<string, string> = {
      page: `0-${Math.max(0, cat.pagesRead + cat.missingPages.length - 1)}`,
      page_size: String(LIST_PAGE_SIZE),
      sort,
      offset: String(offset),
      limit: String(limit),
    };
    if (query) params.query = query;
    for (const [k, v] of Object.entries(filters)) params[k] = v;
    if (statusPages) params.status_pages = `${statusPages} pagina's op ${SITE} (connector ${RVO_SUBSIDIES_PAGES_CONNECTOR})`;

    return {
      items,
      total,
      offset,
      limit,
      query,
      sort,
      filters,
      catalogue: {
        entries: cat.entries.length,
        pages_read: cat.pagesRead,
        missing_pages: cat.missingPages,
        ...(cat.truncated ? { truncated: cat.truncated } : {}),
        complete: cat.complete,
        loaded_at: cat.loadedAt,
        stale,
      },
      ...(statusChecks ? { status_checks: statusChecks } : {}),
      has_more: hasMore,
      endpoint: RVO_SUBSIDIES_ENDPOINT,
      params,
      access_note: notes.join(" "),
    };
  }

  /**
   * The catalogue entry a URL, path or slug names. A URL or path names exactly that page
   * (also with /subsidies-financiering in front), never another page with the same last
   * segment. A bare slug ("dumava") means the regeling's own page
   * /subsidies-financiering/<slug> first, else the one page whose path ends in it.
   */
  private resolvePath(cat: Catalogue, target: RvoIdTarget): { entry?: Entry; candidates: Entry[] } {
    if (target.kind === "path") {
      // A URL or path names that one page: never another page that merely ends the same way.
      const entry = cat.byPath.get(pathKey(target.path)) ?? cat.byPath.get(pathKey(sectionPath(target)));
      return { entry, candidates: [] };
    }
    const direct = cat.byPath.get(pathKey(sectionPath(target)));
    if (direct) return { entry: direct, candidates: [] };
    const ending = cat.entries.filter((e) => pathKey(e.item.path).endsWith(`/${target.slug}`));
    return ending.length === 1 ? { entry: ending[0], candidates: [] } : { candidates: ending };
  }

  /**
   * The rvo.nl page for a path or slug the catalogue does not hold. The open data
   * lacks some big regelingen' own pages (/subsidies-financiering/isde, /sde, /mit and
   * /dei answer HTTP 200 on rvo.nl, checked October 2026; their page data holds no
   * status). The page's own id is taken from its page data: the open data API may know
   * the page by it although the catalogue as read lacks it. `redirect` when rvo.nl sends
   * the path to another page; undefined when rvo.nl has no such page or it could not be read.
   */
  private async pageOutsideCatalogue(target: RvoIdTarget): Promise<SitePage | { redirect: string } | undefined> {
    const path = sectionPath(target);
    if (!/^\/subsidies-financiering(?:\/[a-z0-9-]+)+$/i.test(path)) return undefined;
    const url = rvoPageUrl(path);
    try {
      const { data } = await getText(url, {
        connector: RVO_SUBSIDIES_PAGES_CONNECTOR,
        timeoutMs: TIMEOUT_MS,
        retries: RETRIES,
        headers: { Accept: "text/html" },
        disableCache: true,
      });
      const canonical = canonicalOf(data);
      if (canonical && pathKey(new URL(canonical, SITE).pathname) !== pathKey(path)) return { redirect: new URL(canonical, SITE).toString() };
      const title = htmlToText(/<title>([^<]*)<\/title>/i.exec(data)?.[1] ?? "").replace(/\s*\|\s*RVO\.nl\s*$/i, "");
      const flight = extractRvoFlight(data);
      const nodeId = rvoPageNodeId(flight, path);
      return {
        url,
        ...(title ? { title } : {}),
        status_data: flight.includes('"subsidyStatus"') || Boolean(flagLabel(data)),
        ...(nodeId ? { node_id: nodeId, read: parseRvoPage(data, nodeId, url) } : {}),
      };
    } catch {
      return undefined;
    }
  }

  async get(args: RvoSubsidieGetArgs): Promise<RvoSubsidieGetResult> {
    const input = args.id.trim();
    if (!input) throw new RvoSubsidiesInputError("Geef een id (uuid) of de URL of slug van een RVO-pagina.", "Zoek de regeling met rvo_subsidies_search.");
    if (UUID.test(input)) return this.getById(args, input, input);

    const { value: cat } = await this.loadCatalogue();
    const target = rvoIdTarget(input);
    const resolved = target ? this.resolvePath(cat, target) : { candidates: [] };
    if (resolved.entry) {
      const known = resolved.entry.item;
      return this.getById(args, input, known.id, args.readPage !== false ? this.readPage(known) : undefined);
    }
    const lastSegment = target ? (target.kind === "slug" ? target.slug : (target.path.split("/").pop() ?? "")) : input;
    const found = resolved.candidates.length || !target ? undefined : await this.pageOutsideCatalogue(target);
    const onSite = found && "url" in found ? found : undefined;
    const redirect = found && "redirect" in found ? found.redirect : undefined;
    const gap = cat.complete
      ? undefined
      : `De catalogus is nu onvolledig ingelezen (lijstpagina's van rvo.nl ontbraken), dus de pagina kan er wel in horen; een aanroep na ${CATALOGUE_RETRY_MS / 60_000} minuten laadt de catalogus opnieuw.`;
    if (onSite?.node_id) {
      // The page is on rvo.nl and names its own id: the open data API may know it by that id
      // although the catalogue as read lacks it (a list page that failed, or a gap in the list).
      const viaSite = await this.getById(
        args,
        input,
        onSite.node_id,
        args.readPage !== false && onSite.read ? Promise.resolve(onSite.read) : undefined,
        `'${input}' stond niet in de ingelezen catalogus${cat.complete ? "" : " (die was onvolledig)"}; de pagina is op rvo.nl gevonden en via haar id ${onSite.node_id} uit de open data gelezen.`,
      ).catch(() => undefined);
      if (viaSite && !("notFound" in viaSite)) {
        if (onSite.read) this.rememberStatus(onSite.node_id, onSite.read.status);
        return viaSite;
      }
    }

    // Suggestions: the candidates of a slug; for a path the page rvo.nl redirects it to and
    // the nearest page above it in the catalogue; then a search on the last segment.
    let suggestions: RvoSubsidyItem[] = resolved.candidates.slice(0, 5).map((e) => e.item);
    if (!resolved.candidates.length) {
      const near: RvoSubsidyItem[] = [];
      if (redirect) {
        const to = cat.byPath.get(pathKey(new URL(redirect).pathname));
        if (to) near.push(to.item);
      }
      if (target?.kind === "path") {
        const segments = sectionPath(target).split("/").filter(Boolean);
        for (let n = segments.length - 1; n >= 2; n--) {
          const up = cat.byPath.get(pathKey(`/${segments.slice(0, n).join("/")}`));
          if (up) {
            near.push(up.item);
            break;
          }
        }
      }
      const searched = (await this.search({ query: words(foldRvo(lastSegment)).join(" OR "), limit: 5, include_status: false })).items.map(
        // Without score and status: these are suggestions, not results.
        ({ score: _score, status_info: _status, ...item }) => item,
      );
      const seen = new Set<string>();
      suggestions = [...near, ...searched].filter((x) => !seen.has(x.id) && seen.add(x.id)).slice(0, 5);
    }
    const message = resolved.candidates.length
      ? `'${input}' past bij ${resolved.candidates.length} pagina's; geef het volledige pad of de uuid.`
      : !target
        ? `'${input}' is geen adres op rvo.nl en geen pad of slug van een RVO-pagina.`
        : onSite
          ? `Geen pagina '${input}' in de RVO-catalogus (open data), maar rvo.nl heeft er wel een: ${onSite.url}${onSite.title ? ` ('${onSite.title}')` : ""}. ` +
            (onSite.status_data
              ? "Die staat niet in de open data en is hier niet verder gelezen: status, periode en budget staan op de pagina zelf."
              : "Die staat niet in de open data, en in haar paginagegevens staan geen status, periode of budget.")
          : redirect
            ? `Geen pagina '${input}' in de RVO-catalogus (open data); rvo.nl stuurt dat adres door naar een andere pagina: ${redirect}. Die is niet in plaats daarvan gelezen.`
            : `Geen pagina '${input}' in de RVO-catalogus (open data)${target.kind === "path" ? ", en rvo.nl heeft op dat pad geen pagina" : ""}.`;
    return {
      notFound: true,
      message: gap && !resolved.candidates.length ? `${message} ${gap}` : message,
      ...(onSite ? { site_page: onSite.url } : {}),
      ...(redirect ? { redirects_to: redirect } : {}),
      suggestions,
      endpoint: RVO_SUBSIDIES_ENDPOINT,
      params: { id: input, ...(onSite ? { site_page: onSite.url } : {}), ...(redirect ? { redirects_to: redirect } : {}) },
    };
  }

  /** Read one page by its uuid: the open data detail, and the public page unless read_page is false. */
  private async getById(
    args: RvoSubsidieGetArgs,
    input: string,
    id: string,
    pageRead?: Promise<RvoPageRead>,
    foundNote?: string,
  ): Promise<RvoSubsidieGetResult> {
    const maxChars = Math.min(RVO_TEXT_MAX_CHARS, Math.max(1, Math.floor(args.maxChars ?? RVO_TEXT_DEFAULT_CHARS)));
    const readPage = args.readPage !== false;
    const endpoint = `${RVO_SUBSIDIES_ENDPOINT}/${encodeURIComponent(id)}`;
    let detail: Record<string, unknown> | undefined;
    try {
      const { data } = await getJson<unknown>(endpoint, { connector: RVO_SUBSIDIES_CONNECTOR, timeoutMs: TIMEOUT_MS, retries: RETRIES });
      detail = asRecord(data);
    } catch (error) {
      if (error instanceof SourceRequestError && error.status === 404) {
        await pageRead;
        return {
          notFound: true,
          message: `RVO open data kent geen pagina met id ${id} (HTTP 404).`,
          suggestions: [],
          endpoint,
          params: { id: input },
        };
      }
      throw error;
    }
    const item = toRvoItem(detail);
    if (!detail || !item) {
      throw new SourceRequestError({ message: "RVO open data gaf een onverwacht antwoord (geen id/url).", endpoint, code: "malformed_response" });
    }
    if (this.catalogue) {
      const entry = this.catalogue.value.byId.get(item.id);
      if (entry?.item.parent_title) item.parent_title = entry.item.parent_title;
    }
    const page = readPage ? await (pageRead ?? this.readPage(item)) : undefined;

    const notes: string[] = [BASE_NOTE];
    if (foundNote) notes.push(foundNote);
    let lines: string[];
    let htmls: string[];
    let downloads: RvoLink[] = [];
    let links: RvoLink[] = [];
    let textSource: "pagina" | "api";
    const intro = item.intro;
    if (page?.elements) {
      const rendered = renderRvoElements(page.elements);
      lines = rendered.lines;
      htmls = rendered.html;
      downloads = rendered.downloads;
      links = rendered.links;
      textSource = "pagina";
      notes.push("Tekst uit alle blokken van de openbare pagina (ook uitklapblokken, meldingen en downloads).");
    } else {
      const body = Array.isArray(detail.body) ? detail.body : [];
      htmls = body.filter((b): b is string => typeof b === "string");
      lines = htmls.flatMap(rvoHtmlLines);
      textSource = "api";
      const missing = body.length - htmls.length;
      if (missing > 0) {
        notes.push(
          `Tekst uit de open-data-API: ${plural(missing, "blok", "blokken")} van de pagina (uitklapblokken, meldingen, downloads, knoppen) ` +
            `${missing === 1 ? "staat" : "staan"} daar niet in en ontbreken hier; de pagina zelf is volledig.`,
        );
      }
    }
    if (intro) lines = [intro, ...lines];
    if (typeof detail.intro === "string") htmls = [detail.intro, ...htmls];

    const sections = sectionsOf(lines);
    let chosen = lines;
    const sectie = args.sectie?.trim();
    if (sectie) {
      chosen = selectSections(lines, sectie);
      if (!chosen.length) {
        notes.push(`Geen sectie met '${sectie}' in de kop; secties: ${sections.join("; ") || "(geen)"}.`);
      }
    }
    const { text, chars, truncated } = truncateLines(chosen, maxChars);
    if (truncated) notes.push(`Tekst ingekort: ${text.length} van ${chars} tekens (max_chars ${maxChars}, max ${RVO_TEXT_MAX_CHARS}); vraag een sectie op voor de rest.`);
    if (page) notes.push(STATUS_NOTE);
    else notes.push("Status, aanvraagperiode en budget niet opgevraagd (read_page=false).");

    return {
      item,
      ...(page ? { status_info: page.status } : {}),
      text,
      text_chars: chars,
      text_truncated: truncated,
      text_source: textSource,
      sections,
      ...(sectie ? { sectie } : {}),
      legal_references: rvoLegalReferences(htmls, links),
      downloads,
      endpoint,
      params: { id, ...(input !== id ? { input } : {}), ...(page ? { page: item.url } : {}), max_chars: String(maxChars), ...(sectie ? { sectie } : {}) },
      access_note: notes.join(" "),
    };
  }
}
