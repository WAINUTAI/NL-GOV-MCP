/**
 * Open calls and subsidy rounds of NWO and ZonMw, read from the overview pages of
 * nwo.nl and zonmw.nl. Neither site has an API for these; both are Drupal sites
 * whose server-rendered overviews carry stable class names (verified live on
 * several pages, Oct 2026).
 *
 * NWO (www.nwo.nl/calls): 12 cards per page with title, summary, the status label
 * nwo.nl itself shows ("Open voor aanvragen", "Doorlopend", "Gesloten", ...) and
 * often a budget, but no closing date; that is only on the call page. The status
 * filter is the site's own facet (`f[n]=calls_bw_call_status:<term>`, OR within the
 * facet), and its counts give the total. Calls of NWO units (regieorgaan-sia.nl,
 * nko.nl, openscience.nl) are listed too and link to those sites, which run the
 * same platform. robots.txt asks for a crawl delay of 3 seconds (a rate limit of 20
 * requests a minute) and an uncached overview takes 4 to 20 seconds to render, so a
 * search reads at most 3 pages, and requests to these sites start at least 3 seconds
 * apart (http.ts crawlDelayMs; a cached page does not count).
 *
 * ZonMw (www.zonmw.nl/nl/subsidies): 12 cards per page with title, summary,
 * programme, start and deadline (both as <time datetime>) and the total. The status
 * is not in the overview HTML: zonmw.nl loads it per card from
 * /nl/entity-date-status/<nid>/full and computes it from those two dates (before the
 * start "Verwacht", until the deadline "Open", then "Gesloten"; checked against that
 * endpoint on ten calls). The site's status filter is a facet URL (`?f[0]=...`),
 * which zonmw.nl's robots.txt excludes, so it is not used: the overview is sorted by
 * deadline, latest first, so every call that is open or expected comes before the
 * first closed one, and reading stops there. robots.txt asks for a crawl delay of 4
 * seconds, so requests to zonmw.nl start at least that far apart.
 *
 * DUS-I (dus-i.nl/subsidies) was checked and left out: its overview is an A-Z list
 * of links without status, and a regulation's status is only a free-text sentence
 * in an update block ("U kunt geen subsidie meer aanvragen", "Het budget voor 2026
 * is op", or nothing), which cannot be read without guessing.
 */
import type { AppConfig, MCPErrorCode, MCPErrorResponse } from "../types.js";
import { getText, SourceRequestError } from "../utils/http.js";
import { htmlToText } from "../utils/html-text.js";
import { errorResponse, mapSourceError } from "../utils/response.js";

const NWO_ORIGIN = "https://www.nwo.nl";
const ZONMW_ORIGIN = "https://www.zonmw.nl";
export const NWO_CALLS_ENDPOINT = `${NWO_ORIGIN}/calls`;
export const ZONMW_SUBSIDIES_ENDPOINT = `${ZONMW_ORIGIN}/nl/subsidies`;

/** One connector per site, so a slow nwo.nl cannot open the circuit of zonmw.nl. */
const NWO_CONNECTOR = "nwo_calls";
const ZONMW_CONNECTOR = "zonmw_subsidies";
export const ONDERZOEKSCALL_CONNECTORS = { nwo: NWO_CONNECTOR, zonmw: ZONMW_CONNECTOR } as const;

export const ONDERZOEKSCALL_ORGANISATIES = ["nwo", "zonmw"] as const;
export type OnderzoekscallOrganisatie = (typeof ONDERZOEKSCALL_ORGANISATIES)[number];

/** Normalised status; the site's own label is kept next to it (status_label). */
export const ONDERZOEKSCALL_STATUSSEN = ["open", "binnenkort", "gesloten"] as const;
export type OnderzoekscallStatus = (typeof ONDERZOEKSCALL_STATUSSEN)[number];

/** Search filter: "actueel" is open plus binnenkort, "alle" includes closed calls. */
export const ONDERZOEKSCALL_STATUS_FILTERS = ["actueel", "open", "binnenkort", "gesloten", "alle"] as const;
export type OnderzoekscallStatusFilter = (typeof ONDERZOEKSCALL_STATUS_FILTERS)[number];

export const ONDERZOEKSCALL_DEFAULT_ROWS = 10;
/**
 * Crawl-delay in the robots.txt of each site (checked live, October 2026: nwo.nl and the
 * sites of its units 3, zonmw.nl 4): the least time between the starts of two requests to it.
 */
export const ONDERZOEKSCALL_CRAWL_DELAY_MS: Readonly<Record<OnderzoekscallOrganisatie, number>> = { nwo: 3_000, zonmw: 4_000 };
/** At most two NWO pages of 12 are needed for a window this size (three when unaligned). */
export const ONDERZOEKSCALL_MAX_ROWS = 24;
export const ONDERZOEKSCALL_MAX_OFFSET = 1000;
export const ONDERZOEKSCALL_DEFAULT_CHARS = 8000;
export const ONDERZOEKSCALL_MAX_CHARS = 40_000;

/** Both overviews show 12 cards per page (verified live). */
const PAGE_SIZE = 12;
/** nwo.nl: crawl delay 3 s, 20 requests a minute; a page can take 20 s to render. */
const NWO_MAX_PAGES = 3;
/** Reading to the first closed call takes ~5 pages now; with the crawl delay each page after the first adds 4 s. */
const ZONMW_MAX_PAGES = 8;
const NWO_TIMEOUT_MS = 30_000;
const ZONMW_TIMEOUT_MS = 15_000;
/** Both search boxes have maxlength 128. */
const MAX_QUERY_CHARS = 128;

/**
 * The status terms of nwo.nl's call_status facet (taxonomy term id, label as shown,
 * normalised status). The parent term "Open calls" (62286) is left out: its facet
 * count is not the sum of the open statuses below it (17 against 36, Oct 2026).
 * "Procedure loopt" means the deadline has passed and the proposals are being
 * assessed, so it counts as closed; "In voorbereiding" is an announced call.
 * label_en is the label of www.nwo.nl/en/calls. The sites of NWO units have their
 * own term ids (nko.nl: "In voorbereiding" is 2414) and some labels of their own
 * ("Open voor inschrijvingen"); there the label decides, and an unknown one is not
 * mapped.
 */
export const NWO_STATUS_TERMS: ReadonlyArray<{ tid: string; label: string; label_en: string; status: OnderzoekscallStatus }> = [
  { tid: "1866", label: "Open voor aanvragen", label_en: "Open for applications", status: "open" },
  { tid: "62163", label: "Open voor intentieverklaring", label_en: "Open for letter of intent", status: "open" },
  { tid: "62164", label: "Open voor vooraanmelding", label_en: "Open for pre-proposals", status: "open" },
  { tid: "1868", label: "Doorlopend", label_en: "Continuous", status: "open" },
  { tid: "1869", label: "Opent binnenkort", label_en: "Upcoming", status: "binnenkort" },
  { tid: "62162", label: "In voorbereiding", label_en: "In preparation", status: "binnenkort" },
  { tid: "62165", label: "Procedure loopt", label_en: "In progress", status: "gesloten" },
  { tid: "1867", label: "Gesloten", label_en: "Closed", status: "gesloten" },
];
const NWO_PARENT_STATUS_TID = "62286";

/** ZonMw's own status classes and labels (status--open etc.). */
const ZONMW_STATUS: Record<string, { status: OnderzoekscallStatus; label: string }> = {
  open: { status: "open", label: "Open" },
  expected: { status: "binnenkort", label: "Verwacht" },
  closed: { status: "gesloten", label: "Gesloten" },
};

/** Hosts whose call pages get() reads: nwo.nl and the sites of NWO units on the same platform. */
const NWO_HOSTS = new Set([
  "www.nwo.nl", "nwo.nl",
  "regieorgaan-sia.nl", "www.regieorgaan-sia.nl",
  "www.nko.nl", "nko.nl",
  "www.openscience.nl", "openscience.nl",
]);
const ZONMW_HOSTS = new Set(["www.zonmw.nl", "zonmw.nl"]);
/**
 * Call pages are addressed by path alone: /calls/<slug> (also /en/calls/) on the NWO
 * sites, /nl/subsidie/<slug> or /en/subsidy/<slug> on zonmw.nl. Anything else (an
 * overview, a facet URL robots.txt excludes, /search) is never fetched by get().
 */
const NWO_CALL_PATH = /^\/(?:en\/)?calls\/[^/]+(?:\/[^/]+)?\/?$/;
const ZONMW_CALL_PATH = /^\/(?:nl\/subsidie|en\/subsidy)\/[^/]+\/?$/;

export class OnderzoekscallInputError extends Error {
  constructor(message: string, public readonly suggestion?: string) {
    super(message);
    this.name = "OnderzoekscallInputError";
  }
}

export interface OnderzoekscallItem {
  organisation: OnderzoekscallOrganisatie;
  title: string;
  url: string;
  /** ZonMw node id; NWO cards carry none. */
  id?: string;
  summary?: string;
  status?: OnderzoekscallStatus;
  /** The label the site itself uses: "Open voor aanvragen", "Doorlopend", "Verwacht", ... */
  status_label?: string;
  /**
   * "label": the status label the site shows (NWO card, ZonMw status block);
   * "datums": ZonMw's own rule applied to the start and deadline on the card.
   */
  status_source?: "label" | "datums";
  /** ISO instant (ZonMw start) or calendar date. */
  opening_date?: string;
  opening_text?: string;
  /** ISO instant from the page's <time datetime>. */
  deadline?: string;
  deadline_text?: string;
  /** Budget as shown, e.g. "€840.875". */
  budget_text?: string;
  /** Only when budget_text is one plain euro amount. */
  budget_eur?: number;
  programme?: string;
  /** ZonMw "Voor wie", e.g. "Op uitnodiging". */
  for_whom?: string;
  /** Set when an NWO card links to the site of an NWO unit (e.g. "regieorgaan-sia.nl"). */
  hosted_on?: string;
}

export interface OnderzoekscallsSearchArgs {
  organisatie?: OnderzoekscallOrganisatie | "alle";
  query?: string;
  status?: OnderzoekscallStatusFilter;
  offset?: number;
  limit?: number;
}

export interface OnderzoekscallsSiteResult {
  organisation: OnderzoekscallOrganisatie;
  connector: string;
  items: OnderzoekscallItem[];
  /** Matches upstream for this status filter and query; null when it could not be determined. */
  total: number | null;
  has_more: boolean;
  endpoint: string;
  params: Record<string, string>;
  notes: string[];
}

export interface OnderzoekscallFailure {
  organisation: OnderzoekscallOrganisatie;
  connector: string;
  error_type: MCPErrorCode;
  message: string;
}

export interface OnderzoekscallsSearchResult {
  /** NWO items first, then ZonMw; offset and limit apply per organisation. */
  items: OnderzoekscallItem[];
  /** Sum over the organisations; null when one of them has no known total. */
  total: number | null;
  has_more: boolean;
  offset: number;
  limit: number;
  query: string;
  status: OnderzoekscallStatusFilter;
  organisations: OnderzoekscallOrganisatie[];
  per_site: OnderzoekscallsSiteResult[];
  failures: OnderzoekscallFailure[];
  endpoint: string;
  params: Record<string, string>;
  access_note: string;
}

export interface OnderzoekscallFeature {
  label: string;
  value: string;
}

export interface OnderzoekscallDate {
  label: string;
  /** ISO instant from <time datetime>, or YYYY-MM-DD for a plain Dutch date. */
  date?: string;
  text: string;
}

export interface OnderzoekscallDocument {
  title: string;
  url: string;
}

export interface OnderzoekscallDetail {
  organisation: OnderzoekscallOrganisatie;
  url: string;
  title: string;
  intro?: string;
  status?: OnderzoekscallStatus;
  status_label?: string;
  /** "label": the status the page shows; "paginagegevens": ZonMw's page metadata (status block unreachable). */
  status_source?: "label" | "paginagegevens";
  opening_date?: string;
  opening_text?: string;
  /** The final closing date: "Sluitingsdatum volledige aanvraag", the only closing date, or ZonMw's deadline. */
  deadline?: string;
  deadline_label?: string;
  deadline_text?: string;
  /**
   * NWO: the first closing date on the page that is still ahead, with its label
   * ("Sluitingsdatum intentieverklaring", "Sluitingsdatum vooraanmelding" or the full
   * application); absent when none is ahead. An earlier closing date can be a condition
   * for the later one; the page text says whether it is.
   */
  next_deadline?: string;
  next_deadline_label?: string;
  next_deadline_text?: string;
  /** Every dated feature on the page (opening, pre-registration, closing, ...). */
  dates: OnderzoekscallDate[];
  budget_text?: string;
  budget_eur?: number;
  budget_per_application_text?: string;
  budget_per_application_eur?: number;
  programme?: string;
  /** All "Kenmerken" as shown, contact persons excluded. */
  features: OnderzoekscallFeature[];
  documents: OnderzoekscallDocument[];
  /** Page text with "## " before each heading, cut at max_chars. */
  text: string;
  text_chars: number;
  truncated: boolean;
  warnings: string[];
  endpoint: string;
  params: Record<string, string>;
  access_note: string;
}

// ---------------------------------------------------------------------------
// Small helpers

function clampInt(value: number | null | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function clampOnderzoekscallRows(limit: number | null | undefined): number {
  return clampInt(limit, 1, ONDERZOEKSCALL_MAX_ROWS, ONDERZOEKSCALL_DEFAULT_ROWS);
}

/** Lowercase and strip accents, for comparing labels. */
function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** An href or src from the HTML as an absolute URL on `origin`; undefined for mailto:, tel: and the like. */
function absoluteUrl(href: string, origin: string): string | undefined {
  const raw = htmlToText(href);
  try {
    const u = new URL(raw, origin);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The search term as sent: a longer one is cut at the last whole word that fits. */
export function onderzoekscallQuery(query: string | undefined): { term: string; cut: boolean } {
  const q = (query ?? "").replace(/\s+/g, " ").trim();
  if (q.length <= MAX_QUERY_CHARS) return { term: q, cut: false };
  const head = q.slice(0, MAX_QUERY_CHARS + 1);
  const space = head.lastIndexOf(" ");
  return { term: (space > 0 ? head.slice(0, space) : head.slice(0, MAX_QUERY_CHARS)).trim(), cut: true };
}

/**
 * "€840.875", "€ 240.000,-" → euros; on an English page "€3,000,000". Anything else
 * (ranges, "1,5 miljoen", "4 miljoen euro") → undefined.
 */
export function parseEuroAmount(text: string | undefined, locale: "nl" | "en" = "nl"): number | undefined {
  if (!text) return undefined;
  const value = text.replace(/ /g, " ").trim();
  const m =
    locale === "en"
      ? /^€\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.00?)?$/.exec(value)
      : /^€\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(?:-|00?))?$/.exec(value);
  return m ? Number(m[1].replace(/[.,]/g, "")) : undefined;
}

/** budget_text with budget_eur only when the amount is plain. */
function budgetFields<K extends "budget" | "budget_per_application">(
  key: K,
  text: string,
  locale: "nl" | "en" = "nl",
): { [P in `${K}_text`]: string } & { [P in `${K}_eur`]?: number } {
  const eur = parseEuroAmount(text, locale);
  return { [`${key}_text`]: text, ...(eur !== undefined ? { [`${key}_eur`]: eur } : {}) } as { [P in `${K}_text`]: string } & { [P in `${K}_eur`]?: number };
}

const DUTCH_MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

/** "12 november 2026" → "2026-11-12"; anything else → undefined. */
export function parseDutchDate(text: string): string | undefined {
  const m = /^(\d{1,2}) ([a-z]+) (\d{4})$/.exec(fold(text));
  if (!m) return undefined;
  const month = DUTCH_MONTHS.indexOf(m[2]);
  const day = Number(m[1]);
  if (month < 0 || day < 1 || day > 31) return undefined;
  const d = new Date(Date.UTC(Number(m[3]), month, day));
  if (d.getUTCMonth() !== month) return undefined;
  return d.toISOString().slice(0, 10);
}

const TIME_RE = /<time\b[^>]*\bdatetime="([^"]+)"[^>]*>([\s\S]*?)<\/time>/i;

/** The first <time datetime> in a fragment: the instant and the text shown. */
function timeIn(fragment: string): { iso: string; text: string } | undefined {
  const m = TIME_RE.exec(fragment);
  if (!m) return undefined;
  const ts = Date.parse(m[1]);
  return Number.isNaN(ts) ? undefined : { iso: new Date(ts).toISOString(), text: htmlToText(m[2]) };
}

/** Status of a NWO label (Dutch or English) as shown on nwo.nl; undefined for a label this mapping does not know. */
export function nwoStatusOfLabel(label: string): OnderzoekscallStatus | undefined {
  const key = fold(label);
  return NWO_STATUS_TERMS.find((t) => fold(t.label) === key || fold(t.label_en) === key)?.status;
}

/** Term ids of the NWO status facet for a filter; empty for "alle". */
export function nwoStatusTermIds(filter: OnderzoekscallStatusFilter): string[] {
  if (filter === "alle") return [];
  const wanted: OnderzoekscallStatus[] = filter === "actueel" ? ["open", "binnenkort"] : [filter];
  return NWO_STATUS_TERMS.filter((t) => wanted.includes(t.status)).map((t) => t.tid);
}

/**
 * ZonMw's own rule, as its status block applies it: before the start "Verwacht"
 * (binnenkort), from the start until the deadline "Open", from the deadline on
 * "Gesloten". Undefined when either date is missing.
 */
export function zonmwStatusFromDates(
  start: string | undefined,
  deadline: string | undefined,
  now: Date,
): { status: OnderzoekscallStatus; label: string } | undefined {
  const s = start ? Date.parse(start) : Number.NaN;
  const d = deadline ? Date.parse(deadline) : Number.NaN;
  if (Number.isNaN(s) || Number.isNaN(d)) return undefined;
  const t = now.getTime();
  if (t < s) return ZONMW_STATUS.expected;
  if (t < d) return ZONMW_STATUS.open;
  return ZONMW_STATUS.closed;
}

function matchesFilter(status: OnderzoekscallStatus | undefined, filter: OnderzoekscallStatusFilter): boolean {
  if (filter === "alle") return true;
  if (!status) return false;
  if (filter === "actueel") return status === "open" || status === "binnenkort";
  return status === filter;
}

/** The pages of `size` that hold the window [offset, offset + limit). */
export function planPageWindow(offset: number, limit: number, size = PAGE_SIZE): { first: number; last: number; skip: number } {
  const first = Math.floor(offset / size);
  return { first, last: Math.floor((offset + limit - 1) / size), skip: offset - first * size };
}

/** The text of the option marked selected in a sort select ("Sluitingsdatum (eerder-later)"). */
function selectedSortLabel(html: string): string | undefined {
  const select = /<select[^>]*name="sort_bef_combine"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  const option = select ? /<option[^>]*selected="selected"[^>]*>([\s\S]*?)<\/option>/.exec(select[1]) : null;
  return option ? htmlToText(option[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Request planning (also used for dryRun)

export interface OnderzoekscallRequest {
  organisation: OnderzoekscallOrganisatie;
  connector: string;
  url: string;
  params: Record<string, string>;
}

/** One overview page of nwo.nl: `input`, the status facet values and `page` (0-based). */
export function buildNwoListRequest(term: string, filter: OnderzoekscallStatusFilter, page: number): OnderzoekscallRequest {
  const pairs: Array<[string, string]> = [];
  if (term) pairs.push(["input", term]);
  nwoStatusTermIds(filter).forEach((tid, i) => pairs.push([`f[${i}]`, `calls_bw_call_status:${tid}`]));
  if (page > 0) pairs.push(["page", String(page)]);
  const qs = new URLSearchParams(pairs).toString();
  return {
    organisation: "nwo",
    connector: ONDERZOEKSCALL_CONNECTORS.nwo,
    url: qs ? `${NWO_CALLS_ENDPOINT}?${qs}` : NWO_CALLS_ENDPOINT,
    params: Object.fromEntries(pairs),
  };
}

/** One overview page of zonmw.nl, always sorted by deadline, latest first. */
export function buildZonmwListRequest(term: string, page: number): OnderzoekscallRequest {
  const pairs: Array<[string, string]> = [];
  if (term) pairs.push(["input", term]);
  pairs.push(["sort_bef_combine", "field_subsidy_date_end_DESC"]);
  if (page > 0) pairs.push(["page", String(page)]);
  return {
    organisation: "zonmw",
    connector: ONDERZOEKSCALL_CONNECTORS.zonmw,
    url: `${ZONMW_SUBSIDIES_ENDPOINT}?${new URLSearchParams(pairs).toString()}`,
    params: Object.fromEntries(pairs),
  };
}

// ---------------------------------------------------------------------------
// Overview parsers

export interface NwoListing {
  items: OnderzoekscallItem[];
  /** Status facet: term id → label and count (counts for the current query and other filters). */
  statusFacet?: Map<string, { label: string; count: number }>;
  hasNext: boolean;
  sortLabel?: string;
}

function parseNwoCard(part: string): OnderzoekscallItem | undefined {
  const link = /<h3 class="card__title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(part);
  if (!link) return undefined;
  const url = absoluteUrl(link[1], NWO_ORIGIN);
  const title = htmlToText(link[2]);
  if (!url || !title) return undefined;
  const item: OnderzoekscallItem = { organisation: "nwo", title, url };
  const summary = /<\/h3>\s*<p>([\s\S]*?)<\/p>/.exec(part);
  if (summary) item.summary = htmlToText(summary[1]) || undefined;
  for (const m of part.matchAll(/<li>\s*<span>([^<]+)<\/span>([\s\S]*?)<\/li>/g)) {
    const label = fold(m[1]);
    const value = htmlToText(m[2]);
    if (!value) continue;
    if (label === "status") {
      item.status_label = value;
      item.status = nwoStatusOfLabel(value);
      item.status_source = "label";
    } else if (label === "budget") {
      item.budget_text = value;
      const eur = parseEuroAmount(value);
      if (eur !== undefined) item.budget_eur = eur;
    }
  }
  const host = new URL(url).hostname;
  if (host !== "www.nwo.nl") item.hosted_on = host.replace(/^www\./, "");
  return item;
}

/** Facet items of call_status: `id="calls-bw-call-status-<tid>"`, label and count. */
export function parseNwoStatusFacet(html: string): Map<string, { label: string; count: number }> | undefined {
  const start = html.indexOf('data-drupal-facet-id="call_status"');
  if (start < 0) return undefined;
  const end = html.indexOf("</fieldset>", start);
  const region = html.slice(start, end > start ? end : start + 40_000);
  const out = new Map<string, { label: string; count: number }>();
  const re = /id="calls-bw-call-status-(\d+)"[\s\S]*?<span class="sticky-tail">([\s\S]*?)<span class="count">(\d+)<\/span>/g;
  for (const m of region.matchAll(re)) out.set(m[1], { label: htmlToText(m[2]), count: Number(m[3]) });
  return out;
}

/**
 * Cards of one nwo.nl overview page. The card list is always there, with an
 * empty-result item when nothing matches; without it the page layout has changed.
 */
export function parseNwoListing(html: string): NwoListing | undefined {
  const start = html.indexOf('<ul class="listing listing-cards">');
  if (start < 0) return undefined;
  const pager = html.indexOf('<nav class="pager"', start);
  const region = html.slice(start, pager > start ? pager : undefined);
  const items = region
    .split(/<li class="list-item\b[^"]*">/)
    .slice(1)
    .map(parseNwoCard)
    .filter((x): x is OnderzoekscallItem => !!x);
  return {
    items,
    statusFacet: parseNwoStatusFacet(html),
    hasNext: html.includes("pager__item--next"),
    sortLabel: selectedSortLabel(html),
  };
}

export interface ZonmwListing {
  items: OnderzoekscallItem[];
  total: number;
  sortLabel?: string;
}

/**
 * The text of a feature value; several list items or links ("Specifiek voor",
 * "Gerelateerde programma's") are joined with "; " instead of running together.
 */
export function featureText(html: string): string {
  const items = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => htmlToText(m[1])).filter(Boolean);
  if (items.length > 1) return items.join("; ");
  const anchors = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((m) => htmlToText(m[1])).filter(Boolean);
  if (anchors.length > 1 && !htmlToText(html.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, " "))) return anchors.join("; ");
  // Text glued to a link without a space is two items ("Programma A<a>Programma B</a>").
  return htmlToText(html.replace(/([^\s>])(<a\b)/g, "$1; $2").replace(/(<\/a>)(?=[^\s<])/g, "$1; "));
}

/** Label/value pairs of a features list: `<strong class="title">Label:</strong> value`. */
function featurePairs(region: string): Array<{ label: string; html: string }> {
  const parts = region.split(/<strong class="[^"]*\btitle\b[^"]*">([\s\S]*?)<\/strong>/);
  const out: Array<{ label: string; html: string }> = [];
  for (let i = 1; i < parts.length; i += 2) {
    out.push({ label: htmlToText(parts[i]).replace(/:\s*$/, ""), html: parts[i + 1] ?? "" });
  }
  return out;
}

function parseZonmwCard(part: string, now: Date): OnderzoekscallItem | undefined {
  const link = /card__title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(part);
  if (!link) return undefined;
  const url = absoluteUrl(link[1], ZONMW_ORIGIN);
  const title = htmlToText(link[2]);
  if (!url || !title) return undefined;
  const item: OnderzoekscallItem = { organisation: "zonmw", title, url };
  const nid = /entity-date-status\/(\d+)\//.exec(part);
  if (nid) item.id = nid[1];
  const intro = /class="card__introduction">([\s\S]*?)<div class="features">/.exec(part);
  if (intro) item.summary = htmlToText(intro[1]) || undefined;
  const list = part.indexOf("features-description-list");
  if (list >= 0) {
    for (const { label, html } of featurePairs(part.slice(list))) {
      const key = fold(label);
      if (key === "start" || key === "deadline") {
        const t = timeIn(html);
        if (!t) continue;
        if (key === "start") {
          item.opening_date = t.iso;
          item.opening_text = t.text;
        } else {
          item.deadline = t.iso;
          item.deadline_text = t.text;
        }
      } else if (key === "programma") {
        item.programme = htmlToText(html) || undefined;
      } else if (key === "voor wie") {
        item.for_whom = htmlToText(html) || undefined;
      }
    }
  }
  const status = zonmwStatusFromDates(item.opening_date, item.deadline, now);
  if (status) {
    item.status = status.status;
    item.status_label = status.label;
    item.status_source = "datums";
  }
  return item;
}

/**
 * Cards of one zonmw.nl overview page and the total ("<strong role=status>825</strong>
 * resultaten"). Undefined when the page has neither the count nor the card list.
 */
export function parseZonmwListing(html: string, now: Date): ZonmwListing | undefined {
  const total = /<strong aria-live="polite" role="status">(\d+)<\/strong>/.exec(html);
  if (!total) return undefined;
  const start = html.indexOf("listing listing-overview");
  const items: OnderzoekscallItem[] = [];
  if (start >= 0) {
    const pager = html.indexOf('<nav class="pager"', start);
    const end = pager > start ? pager : html.indexOf("</article>", start);
    const region = html.slice(start, end > start ? end : undefined);
    for (const part of region.split(/<li>\s*<div class="card">/).slice(1)) {
      const item = parseZonmwCard(part, now);
      if (item) items.push(item);
    }
  } else if (Number(total[1]) > 0) {
    return undefined;
  }
  return { items, total: Number(total[1]), sortLabel: selectedSortLabel(html) };
}

// ---------------------------------------------------------------------------
// Call page parsers

/** The page text: "## " before every h2, navigation and the ZonMw table of contents left out. */
export function sectionedText(regionHtml: string): string {
  const cleaned = regionHtml
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<div class="node__toc[\s\S]*?<\/ul>\s*<\/div>/g, " ");
  const parts = cleaned.split(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  const out: string[] = [];
  const lead = htmlToText(parts[0]);
  if (lead) out.push(lead);
  for (let i = 1; i < parts.length; i += 2) {
    const heading = htmlToText(parts[i]);
    const body = htmlToText(parts[i + 1] ?? "");
    if (!heading && !body) continue;
    out.push(heading ? `## ${heading}${body ? `\n${body}` : ""}` : body);
  }
  return out.join("\n\n");
}

const FILE_LINK_RE = /<a\b[^>]*\bhref="([^"]+\.(?:pdf|docx?|xlsx?|odt|ods|pptx?|zip)(?:\?[^"]*)?)"[^>]*>([\s\S]*?)<\/a>/gi;

/** Links to documents (call text, forms) in a region, as absolute URLs, each once. */
function documentLinks(region: string, origin: string): OnderzoekscallDocument[] {
  const seen = new Set<string>();
  const out: OnderzoekscallDocument[] = [];
  for (const m of region.matchAll(FILE_LINK_RE)) {
    const url = absoluteUrl(m[1], origin);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = htmlToText(m[2]) || decodeURIComponent(new URL(url).pathname.split("/").pop() ?? url);
    out.push({ title, url });
  }
  return out;
}

/**
 * Where the first of the markers occurs at or after `from`, or -1. A marker that is
 * part of a tag (a class name) counts from that tag's "<", so a region cut there
 * never ends in half a tag.
 */
function firstIndex(html: string, markers: string[], from: number): number {
  const found = markers
    .map((m) => {
      const i = html.indexOf(m, from);
      return i < 0 || m.startsWith("<") ? i : Math.max(from, html.lastIndexOf("<", i));
    })
    .filter((i) => i >= 0);
  return found.length ? Math.min(...found) : -1;
}

/** The content after the opening tag that holds `marker`, or -1. */
function contentAfter(html: string, marker: string, from = 0): number {
  const i = html.indexOf(marker, from);
  if (i < 0) return -1;
  const close = html.indexOf(">", i);
  return close < 0 ? -1 : close + 1;
}

/** A feature value that is a plain Dutch date ("3 november 2026 14:00 uur") as YYYY-MM-DD. */
function leadingDutchDate(text: string): string | undefined {
  const m = /^(\d{1,2} [A-Za-z]+ \d{4})\b/.exec(text.trim());
  return m ? parseDutchDate(m[1]) : undefined;
}

/**
 * Whether a closing date is still ahead of `now`: an instant until it passes, a plain
 * date (no time on the page) until that day in Amsterdam is over.
 */
function closingAhead(date: string, now: Date): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date >= (amsterdamDay(now.toISOString()) ?? "");
  const ts = Date.parse(date);
  return !Number.isNaN(ts) && ts > now.getTime();
}

export type ParsedCallPage = Omit<OnderzoekscallDetail, "text" | "text_chars" | "truncated" | "endpoint" | "params" | "access_note"> & {
  fullText: string;
  /** ZonMw: the status block to ask, and the status in the page metadata. */
  statusBlockUrl?: string;
  metadataStatus?: string;
};

/**
 * A call page of nwo.nl or a site of an NWO unit: title, the "Kenmerken" sidebar
 * (`<h6 class="strong">Label</h6> value`), documents and text. The contact block
 * that follows the features is never read, so no names or phone numbers end up in
 * the output. Undefined when the page is not a call page.
 */
export function parseNwoCallPage(html: string, url: string, now: Date): ParsedCallPage | undefined {
  const origin = new URL(url).origin;
  const locale = /^\/en\//.test(new URL(url).pathname) ? "en" : "nl";
  const h1 = /<h1 class="articleHead__title">([\s\S]*?)<\/h1>/.exec(html);
  const sidebar = html.indexOf('class="sidebar--content"');
  if (!h1 || sidebar < 0) return undefined;
  const title = htmlToText(h1[1]);

  // Features: from the "Kenmerken" heading to the next heading, and never past the
  // contact block (its names use the same <h6 class="strong"> markup).
  const contactAt = firstIndex(html, ["paragraph--type--contact", "contact__", "</aside>"], sidebar);
  const limitAt = contactAt > sidebar ? contactAt : sidebar + 10_000;
  const headingEnd = html.indexOf("</h3>", sidebar);
  const featStart = headingEnd >= 0 && headingEnd < limitAt ? headingEnd : sidebar;
  const nextHeading = html.indexOf("<h3", featStart);
  const featEnd = nextHeading >= 0 && nextHeading < limitAt ? nextHeading : limitAt;
  const featRegion = html.slice(featStart, featEnd);
  const features: OnderzoekscallFeature[] = [];
  const dates: OnderzoekscallDate[] = [];
  let status: OnderzoekscallStatus | undefined;
  let statusLabel: string | undefined;
  let budgetText: string | undefined;
  let programme: string | undefined;
  for (const piece of featRegion.split('<h6 class="strong">').slice(1)) {
    const close = piece.indexOf("</h6>");
    if (close < 0) continue;
    const label = htmlToText(piece.slice(0, close));
    const valueHtml = piece.slice(close + 5).split("</div>")[0];
    const value = featureText(valueHtml);
    if (!label) continue;
    if (fold(label) === "status") {
      // Parent and leaf term are both linked ("Open calls", "Open voor aanvragen"); the
      // leaf decides, read by term id so an English page maps the same way.
      const anchors = [...valueHtml.matchAll(/<a\b[^>]*href="[^"]*calls_bw_call_status%3A(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g)];
      const leaf = anchors.find((a) => NWO_STATUS_TERMS.some((t) => t.tid === a[1]));
      if (leaf) {
        statusLabel = htmlToText(leaf[2]);
        status = NWO_STATUS_TERMS.find((t) => t.tid === leaf[1])?.status;
      } else {
        const texts = anchors.map((a) => htmlToText(a[2])).filter((t) => t && fold(t) !== "open calls");
        statusLabel = texts.at(-1) ?? (value || undefined);
        status = statusLabel ? nwoStatusOfLabel(statusLabel) : undefined;
      }
      features.push({ label, value: statusLabel ?? value });
      continue;
    }
    features.push({ label, value });
    const t = timeIn(valueHtml);
    const plainDate = t ? undefined : leadingDutchDate(value);
    if (t) dates.push({ label, date: t.iso, text: value });
    else if (plainDate) dates.push({ label, date: plainDate, text: value });
    const key = fold(label);
    if (key === "budget") budgetText = value;
    if (key === "onderzoeksprogramma" || key === "research programme") programme = value;
  }

  // English pages: "Closing date full application", "Opening date".
  const closing = dates.filter((d) => /^(?:sluitingsdatum|closing date)/.test(fold(d.label)));
  const final =
    closing.find((d) => ["sluitingsdatum volledige aanvraag", "closing date full application"].includes(fold(d.label))) ??
    (closing.length === 1 ? closing[0] : undefined);
  const opening = dates.find((d) => /^opening/.test(fold(d.label)));
  const next = closing
    .filter((d) => d.date && closingAhead(d.date, now))
    .sort((a, b) => Date.parse(a.date ?? "") - Date.parse(b.date ?? ""))[0];

  const warnings: string[] = [];
  if (status && status !== "gesloten" && closing.length && closing.every((d) => Date.parse(d.date ?? "") <= now.getTime())) {
    warnings.push(
      `nwo.nl toont de status '${statusLabel}', maar ${closing.length === 1 ? "de sluitingsdatum" : "alle sluitingsdata"} op de pagina ${closing.length === 1 ? "ligt" : "liggen"} in het verleden (${closing.map((d) => `${d.label}: ${d.text}`).join("; ")}). Controleer de pagina.`,
    );
  }
  if (closing.length > 1 && !final) {
    warnings.push(`De pagina noemt meerdere sluitingsdata (${closing.map((d) => d.label).join(", ")}); zie dates.`);
  }

  const intro = /<div class="articleHead__intro">([\s\S]*?)<\/div>/.exec(html);
  const bodyStart = contentAfter(html, 'class="articleContent');
  const bodyEnd = firstIndex(html, ["col-sidebar", "</article>"], bodyStart >= 0 ? bodyStart : 0);
  const body = bodyStart >= 0 ? html.slice(bodyStart, bodyEnd > bodyStart ? bodyEnd : undefined) : "";
  // Documents sit in the body and in the sidebar above the features.
  const docRegion = bodyStart >= 0 ? html.slice(bodyStart, featEnd > bodyStart ? featEnd : undefined) : "";

  return {
    organisation: "nwo",
    url,
    title,
    ...(intro && htmlToText(intro[1]) ? { intro: htmlToText(intro[1]) } : {}),
    ...(status ? { status } : {}),
    ...(statusLabel ? { status_label: statusLabel, status_source: "label" as const } : {}),
    ...(opening ? { opening_date: opening.date, opening_text: opening.text } : {}),
    ...(final ? { deadline: final.date, deadline_label: final.label, deadline_text: final.text } : {}),
    ...(next ? { next_deadline: next.date, next_deadline_label: next.label, next_deadline_text: next.text } : {}),
    dates,
    ...(budgetText ? budgetFields("budget", budgetText, locale) : {}),
    ...(programme ? { programme } : {}),
    features,
    documents: documentLinks(docRegion, origin),
    warnings,
    fullText: sectionedText(body),
  };
}

/**
 * A subsidy page of zonmw.nl: title, deadline (<time datetime> in the header), the
 * "Kenmerken" list (opening date, budgets, programmes), documents and the text of
 * the tabs Oriënteren, Voorbereiden and Aanvragen. The contact cards are not read.
 */
export function parseZonmwCallPage(html: string, url: string): ParsedCallPage | undefined {
  const origin = new URL(url).origin;
  const h1 = /<h1 class="node__head-title">([\s\S]*?)<\/h1>/.exec(html);
  if (!h1 || !html.includes("node--type-subsidy")) return undefined;
  const title = htmlToText(h1[1]);

  const dates: OnderzoekscallDate[] = [];
  const deadlineMatch = /class="deadline__date">\s*(<time\b[\s\S]*?<\/time>)/.exec(html);
  const deadline = deadlineMatch ? timeIn(deadlineMatch[1]) : undefined;
  if (deadline) dates.push({ label: "Deadline", date: deadline.iso, text: deadline.text });

  const statusBlock = /data-href="([^"]*entity-date-status\/\d+\/full)"/.exec(html);
  const datalayer = /<main\b[^>]*data-piwik-datalayer="([^"]*)"/.exec(html);
  let metadataStatus: string | undefined;
  if (datalayer) {
    try {
      const parsed = JSON.parse(htmlToText(datalayer[1])) as { status?: unknown };
      if (typeof parsed.status === "string") metadataStatus = parsed.status;
    } catch {
      // Metadata only backs up the status block; unreadable metadata is no error.
    }
  }

  const features: OnderzoekscallFeature[] = [];
  let openingText: string | undefined;
  let budgetText: string | undefined;
  let perApplication: string | undefined;
  let programme: string | undefined;
  const featStart = html.indexOf('class="features"', html.indexOf("node__sidebar"));
  if (featStart >= 0) {
    const featEnd = firstIndex(html, ["field--name-field-page-sidebar-paragraphs", "paragraph--type--contacts", "</aside>"], featStart);
    const region = html.slice(featStart, featEnd > featStart ? featEnd : featStart + 10_000);
    for (const { label, html: valueHtml } of featurePairs(region)) {
      const value = featureText(valueHtml);
      if (!label || !value) continue;
      features.push({ label, value });
      const key = fold(label);
      if (key === "openingsdatum") {
        openingText = value;
        dates.push({ label, ...(parseDutchDate(value) ? { date: parseDutchDate(value) } : {}), text: value });
      } else if (key === "budget subsidieronde") budgetText = value;
      else if (key === "budget per aanvraag") perApplication = value;
      else if (key.startsWith("gerelateerde programma")) programme = value;
    }
  }

  const intro = /<div class="node__introduction">([\s\S]*?)<\/div>\s*<\/div>/.exec(html);
  const bodyStart = contentAfter(html, 'class="node__content"');
  const sidebar = firstIndex(html, ['class="node__sidebar'], bodyStart >= 0 ? bodyStart : 0);
  const body = bodyStart >= 0 ? html.slice(bodyStart, sidebar > bodyStart ? sidebar : undefined) : "";
  const headStart = html.indexOf('class="node__head"');
  const contacts = firstIndex(html, ["paragraph--type--contacts", "</aside>"], headStart >= 0 ? headStart : 0);
  const docRegion = headStart >= 0 ? html.slice(headStart, contacts > headStart ? contacts : undefined) : body;

  return {
    organisation: "zonmw",
    url,
    title,
    ...(intro && htmlToText(intro[1]) ? { intro: htmlToText(intro[1]) } : {}),
    ...(openingText ? { opening_text: openingText, ...(parseDutchDate(openingText) ? { opening_date: parseDutchDate(openingText) } : {}) } : {}),
    ...(deadline ? { deadline: deadline.iso, deadline_label: "Deadline", deadline_text: deadline.text } : {}),
    dates,
    ...(budgetText ? budgetFields("budget", budgetText) : {}),
    ...(perApplication ? budgetFields("budget_per_application", perApplication) : {}),
    ...(programme ? { programme } : {}),
    features,
    documents: documentLinks(docRegion, origin),
    warnings: [],
    fullText: sectionedText(body),
    ...(statusBlock ? { statusBlockUrl: absoluteUrl(statusBlock[1], origin) } : {}),
    ...(metadataStatus ? { metadataStatus } : {}),
  };
}

/** `<span class="status--open">Open</span>` from ZonMw's status block. */
export function parseZonmwStatusBlock(html: string): { status: OnderzoekscallStatus; label: string } | undefined {
  const m = /class="status--(open|expected|closed)">([\s\S]*?)<\/span>/.exec(html);
  if (!m) return undefined;
  return { status: ZONMW_STATUS[m[1]].status, label: htmlToText(m[2]) || ZONMW_STATUS[m[1]].label };
}

/**
 * A call URL from search results, checked against the hosts this source reads
 * (https only). Accepts a URL without scheme ("www.nwo.nl/calls/...").
 */
export function resolveOnderzoekscallUrl(input: string): { organisation: OnderzoekscallOrganisatie; url: string } {
  const raw = input.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new OnderzoekscallInputError(`'${raw}' is geen URL`, "Geef de url van een call uit nl_onderzoek_calls_search.");
  }
  const host = u.hostname.toLowerCase();
  const organisation = NWO_HOSTS.has(host) ? "nwo" : ZONMW_HOSTS.has(host) ? "zonmw" : undefined;
  if (!organisation || (u.protocol !== "https:" && u.protocol !== "http:")) {
    throw new OnderzoekscallInputError(
      `'${raw}' is geen pagina van nwo.nl of zonmw.nl`,
      "Alleen callpagina's van nwo.nl (en regieorgaan-sia.nl, nko.nl, openscience.nl) en subsidiepagina's van zonmw.nl worden gelezen.",
    );
  }
  if (!(organisation === "nwo" ? NWO_CALL_PATH : ZONMW_CALL_PATH).test(u.pathname)) {
    throw new OnderzoekscallInputError(
      `'${raw}' is geen ${organisation === "nwo" ? "callpagina" : "subsidiepagina"}`,
      organisation === "nwo"
        ? "Een NWO-call heeft een url als https://www.nwo.nl/calls/<naam>; zoek calls met nl_onderzoek_calls_search."
        : "Een ZonMw-subsidie heeft een url als https://www.zonmw.nl/nl/subsidie/<naam>; zoek subsidies met nl_onderzoek_calls_search.",
    );
  }
  u.protocol = "https:";
  u.hash = "";
  // A call page needs no query string; dropping it keeps facet URLs out.
  u.search = "";
  return { organisation, url: u.toString() };
}

function failureOf(error: unknown, organisation: OnderzoekscallOrganisatie): OnderzoekscallFailure {
  const mapped = mapOnderzoekscallError(error);
  return { organisation, connector: ONDERZOEKSCALL_CONNECTORS[organisation], error_type: mapped.error, message: mapped.message };
}

const LABEL: Record<OnderzoekscallOrganisatie, string> = { nwo: "NWO", zonmw: "ZonMw" };

const STATUS_NOTE: Record<OnderzoekscallOrganisatie, string> = {
  nwo:
    "NWO: status volgens het label dat nwo.nl bij de call toont; 'open' omvat 'Open voor aanvragen', 'Open voor vooraanmelding', " +
    "'Open voor intentieverklaring' en 'Doorlopend', 'binnenkort' is 'Opent binnenkort' en 'In voorbereiding', 'gesloten' is " +
    "'Gesloten' en 'Procedure loopt'. Het overzicht van nwo.nl toont geen sluitingsdatum; die staat op de callpagina (nl_onderzoek_call_get).",
  zonmw:
    "ZonMw: start en deadline staan op de kaart; de status volgt daaruit met de regel van zonmw.nl zelf (voor de start 'Verwacht', " +
    "tot de deadline 'Open', daarna 'Gesloten'). Het statusfilter van zonmw.nl is niet gebruikt (robots.txt sluit gefilterde " +
    "zoekresultaten uit); het overzicht is gesorteerd op deadline, laatste eerst, zodat alle open en verwachte subsidies voor de " +
    "eerste gesloten komen. Het budget staat niet in het overzicht, wel op de subsidiepagina (nl_onderzoek_call_get).",
};

export class OnderzoekscallsSource {
  constructor(
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly crawlDelayMs: Readonly<Record<OnderzoekscallOrganisatie, number>> = ONDERZOEKSCALL_CRAWL_DELAY_MS,
  ) {}

  /** The first request per organisation, for dryRun. */
  planSearch(args: OnderzoekscallsSearchArgs): OnderzoekscallRequest[] {
    const { term } = onderzoekscallQuery(args.query);
    const filter = args.status ?? "actueel";
    const offset = clampInt(args.offset, 0, ONDERZOEKSCALL_MAX_OFFSET, 0);
    const orgs = !args.organisatie || args.organisatie === "alle" ? ONDERZOEKSCALL_ORGANISATIES : [args.organisatie];
    return orgs.map((org) =>
      org === "nwo"
        ? buildNwoListRequest(term, filter, Math.floor(offset / PAGE_SIZE))
        : buildZonmwListRequest(term, filter === "alle" ? Math.floor(offset / PAGE_SIZE) : 0),
    );
  }

  async search(args: OnderzoekscallsSearchArgs): Promise<OnderzoekscallsSearchResult> {
    const { term, cut } = onderzoekscallQuery(args.query);
    const filter = args.status ?? "actueel";
    const offset = clampInt(args.offset, 0, ONDERZOEKSCALL_MAX_OFFSET, 0);
    const limit = clampOnderzoekscallRows(args.limit);
    const organisations: OnderzoekscallOrganisatie[] =
      !args.organisatie || args.organisatie === "alle" ? [...ONDERZOEKSCALL_ORGANISATIES] : [args.organisatie];

    const settled = await Promise.allSettled(
      organisations.map((org) => (org === "nwo" ? this.searchNwo(term, filter, offset, limit) : this.searchZonmw(term, filter, offset, limit))),
    );
    const perSite: OnderzoekscallsSiteResult[] = [];
    const failures: OnderzoekscallFailure[] = [];
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") perSite.push(s.value);
      else failures.push(failureOf(s.reason, organisations[i]));
    });
    // Nothing answered: the error itself is the answer.
    if (!perSite.length) {
      const first = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
      throw first?.reason ?? new Error("Geen bron beantwoordde de zoekvraag");
    }

    const notes: string[] = [];
    if (cut) notes.push(`De zoekvraag is ingekort tot ${MAX_QUERY_CHARS} tekens (de zoekvakken van nwo.nl en zonmw.nl nemen niet meer); gezocht op: "${term}".`);
    if (term) notes.push("Zoekwoorden gaan naar de zoekfunctie van de site zelf (volledige tekst); alle woorden moeten voorkomen.");
    if (organisations.length > 1) notes.push("offset en limit gelden per organisatie; eerst NWO, dan ZonMw.");
    for (const site of perSite) notes.push(...site.notes);
    for (const f of failures) notes.push(`${LABEL[f.organisation]} gaf geen antwoord (${f.message}); alleen de andere organisatie is doorzocht.`);

    const total = perSite.every((s) => s.total !== null) ? perSite.reduce((n, s) => n + (s.total ?? 0), 0) : null;
    const params: Record<string, string> = { organisatie: args.organisatie ?? "alle", status: filter, offset: String(offset), limit: String(limit) };
    if (term) params.query = term;
    for (const site of perSite) {
      for (const [k, v] of Object.entries(site.params)) params[`${site.organisation}.${k}`] = v;
    }
    return {
      items: perSite.flatMap((s) => s.items),
      total,
      has_more: perSite.some((s) => s.has_more),
      offset,
      limit,
      query: term,
      status: filter,
      organisations,
      per_site: perSite,
      failures,
      endpoint: perSite.length === 1 ? perSite[0].endpoint : perSite.map((s) => s.endpoint).join(" | "),
      params,
      access_note: notes.join(" "),
    };
  }

  /**
   * nwo.nl filters by status itself; the window maps straight onto its pages. The
   * total is the sum of the facet counts of the requested statuses (all leaf
   * statuses for "alle"), which reflect the query.
   */
  private async searchNwo(term: string, filter: OnderzoekscallStatusFilter, offset: number, limit: number): Promise<OnderzoekscallsSiteResult> {
    const plan = planPageWindow(offset, limit);
    const rows: OnderzoekscallItem[] = [];
    const fetched: number[] = [];
    let facet: NwoListing["statusFacet"];
    let sortLabel: string | undefined;
    let exhausted = false;
    let firstRequest: OnderzoekscallRequest | undefined;
    for (let page = plan.first; page <= plan.last && fetched.length < NWO_MAX_PAGES; page++) {
      const req = buildNwoListRequest(term, filter, page);
      firstRequest ??= req;
      const { data } = await getText(req.url, { connector: req.connector, timeoutMs: NWO_TIMEOUT_MS, retries: 1, crawlDelayMs: this.crawlDelayMs.nwo });
      const listing = parseNwoListing(data);
      if (!listing) {
        throw new SourceRequestError({ message: "nwo.nl gaf geen herkenbaar calloverzicht terug (de opbouw van de pagina is veranderd).", endpoint: req.url, code: "malformed_response" });
      }
      fetched.push(page);
      facet ??= listing.statusFacet;
      sortLabel ??= listing.sortLabel;
      rows.push(...listing.items);
      if (!listing.hasNext || listing.items.length < PAGE_SIZE) {
        exhausted = true;
        break;
      }
    }
    const items = rows.slice(plan.skip, plan.skip + limit);

    const notes: string[] = [STATUS_NOTE.nwo];
    const tids = nwoStatusTermIds(filter);
    let total: number | null = null;
    if (facet) {
      const counted = filter === "alle" ? [...facet.keys()].filter((t) => t !== NWO_PARENT_STATUS_TID) : tids;
      total = counted.reduce((n, tid) => n + (facet?.get(tid)?.count ?? 0), 0);
      const unknown = [...facet.entries()].filter(([tid]) => tid !== NWO_PARENT_STATUS_TID && !NWO_STATUS_TERMS.some((t) => t.tid === tid));
      if (unknown.length) {
        notes.push(`nwo.nl kent statussen die deze koppeling niet indeelt: ${unknown.map(([, v]) => `'${v.label}' (${v.count})`).join(", ")}; die vallen alleen onder status 'alle'.`);
      }
      const renamed = NWO_STATUS_TERMS.filter((t) => facet?.has(t.tid) && fold(facet.get(t.tid)?.label ?? "") !== fold(t.label));
      if (renamed.length) {
        notes.push(`Statuslabels op nwo.nl zijn gewijzigd: ${renamed.map((t) => `'${t.label}' heet nu '${facet?.get(t.tid)?.label}'`).join(", ")}.`);
      }
    } else {
      notes.push("NWO: het statusfilter met aantallen ontbrak op de pagina; het totaal is onbekend.");
    }
    if (sortLabel) notes.push(`NWO-volgorde: ${sortLabel} (standaard van nwo.nl).`);
    const external = items.filter((x) => x.hosted_on).length;
    if (external) notes.push(`${external} NWO-call(s) staan op de site van een NWO-onderdeel (hosted_on).`);
    const unlabelled = items.filter((x) => !x.status && x.status_label);
    if (unlabelled.length) notes.push(`Onbekend NWO-statuslabel: ${[...new Set(unlabelled.map((x) => `'${x.status_label}'`))].join(", ")}; status is daar leeg gelaten.`);
    if (!exhausted && plan.last - plan.first + 1 > NWO_MAX_PAGES) notes.push(`NWO: per aanroep worden hoogstens ${NWO_MAX_PAGES} pagina's gelezen.`);

    const hasMore = total !== null ? offset + items.length < total : !exhausted;
    const req = firstRequest ?? buildNwoListRequest(term, filter, plan.first);
    return {
      organisation: "nwo",
      connector: req.connector,
      items,
      total,
      has_more: hasMore,
      endpoint: NWO_CALLS_ENDPOINT,
      params: { ...req.params, page: fetched.length ? fetched.join(",") : String(plan.first) },
      notes,
    };
  }

  /**
   * zonmw.nl is read sorted by deadline, latest first, so every open or expected
   * call comes before the first closed one (the boundary). For open/binnenkort/
   * actueel pages are read from the start up to the boundary; for gesloten up to the
   * boundary and then the pages holding the window after it; for alle the window
   * maps straight onto the pages.
   */
  private async searchZonmw(term: string, filter: OnderzoekscallStatusFilter, offset: number, limit: number): Promise<OnderzoekscallsSiteResult> {
    const now = this.now();
    const fetched = new Map<number, OnderzoekscallItem[]>();
    let total = 0;
    let sortLabel: string | undefined;
    const fetchPage = async (page: number): Promise<OnderzoekscallItem[]> => {
      const cached = fetched.get(page);
      if (cached) return cached;
      const req = buildZonmwListRequest(term, page);
      const { data } = await getText(req.url, { connector: req.connector, timeoutMs: ZONMW_TIMEOUT_MS, crawlDelayMs: this.crawlDelayMs.zonmw });
      const listing = parseZonmwListing(data, now);
      if (!listing) {
        throw new SourceRequestError({ message: "zonmw.nl gaf geen herkenbaar subsidieoverzicht terug (de opbouw van de pagina is veranderd).", endpoint: req.url, code: "malformed_response" });
      }
      fetched.set(page, listing.items);
      total = listing.total;
      sortLabel ??= listing.sortLabel;
      return listing.items;
    };
    const lastPage = () => Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

    const notes: string[] = [STATUS_NOTE.zonmw];
    let items: OnderzoekscallItem[] = [];
    let siteTotal: number | null = null;
    let capped = false;
    let undated = 0;

    if (filter === "alle") {
      const plan = planPageWindow(offset, limit);
      const rows: OnderzoekscallItem[] = [];
      for (let page = plan.first; page <= plan.last; page++) {
        const got = await fetchPage(page);
        rows.push(...got);
        if (got.length < PAGE_SIZE) break;
      }
      items = rows.slice(plan.skip, plan.skip + limit);
      siteTotal = total;
    } else {
      // Read pages until the first closed call (or a call without dates, which the
      // sort cannot place), counting the matches before it.
      const ordered: OnderzoekscallItem[] = [];
      let boundary: number | undefined;
      const need = filter === "gesloten" ? Number.POSITIVE_INFINITY : offset + limit + 1;
      for (let page = 0; boundary === undefined; page++) {
        if (fetched.size >= ZONMW_MAX_PAGES) {
          capped = true;
          break;
        }
        const got = await fetchPage(page);
        for (const item of got) {
          if (boundary === undefined && item.status === "gesloten") boundary = ordered.length;
          ordered.push(item);
        }
        if (got.length < PAGE_SIZE || page >= lastPage()) {
          boundary ??= ordered.length;
          break;
        }
        if (filter !== "gesloten" && ordered.filter((x) => matchesFilter(x.status, filter)).length >= need) break;
      }
      const before = boundary === undefined ? ordered : ordered.slice(0, boundary);
      undated = before.filter((x) => !x.status).length;

      if (filter === "gesloten") {
        if (boundary !== undefined) {
          // Everything from the boundary on is closed: the window is [boundary + offset, ...).
          const from = boundary + offset;
          const plan = planPageWindow(from, limit);
          const rows: OnderzoekscallItem[] = [];
          for (let page = plan.first; page <= Math.min(plan.last, lastPage()); page++) {
            if (!fetched.has(page) && fetched.size >= ZONMW_MAX_PAGES) {
              capped = true;
              break;
            }
            rows.push(...(await fetchPage(page)));
          }
          items = rows.slice(plan.skip, plan.skip + limit).filter((x) => x.status === "gesloten");
          siteTotal = Math.max(0, total - boundary);
        }
      } else {
        const matches = before.filter((x) => matchesFilter(x.status, filter));
        items = matches.slice(offset, offset + limit);
        const complete = boundary !== undefined;
        siteTotal = complete ? matches.length : null;
      }
    }

    if (undated) notes.push(`ZonMw: ${undated} subsidie(s) zonder start- of deadlinedatum op de kaart; daarvan is de status onbekend en ze zijn overgeslagen.`);
    if (capped) notes.push(`ZonMw: na ${ZONMW_MAX_PAGES} pagina's gestopt met lezen; het totaal is onbekend. Gebruik zoekwoorden om te verfijnen.`);
    if (sortLabel && fold(sortLabel) !== fold("Einddatum Nieuw - Oud")) notes.push(`ZonMw-sortering is '${sortLabel}', niet de gevraagde deadline-volgorde; de statusindeling kan onvolledig zijn.`);
    notes.push(filter === "alle" ? `ZonMw-volgorde: deadline, laatste eerst (${total} subsidies voor deze zoekvraag).` : "ZonMw-volgorde: deadline, laatste eerst.");

    const pages = [...fetched.keys()].sort((a, b) => a - b);
    const first = buildZonmwListRequest(term, pages[0] ?? 0);
    return {
      organisation: "zonmw",
      connector: first.connector,
      items,
      total: siteTotal,
      has_more: siteTotal !== null ? offset + items.length < siteTotal : true,
      endpoint: ZONMW_SUBSIDIES_ENDPOINT,
      params: { ...first.params, page: pages.length ? pages.join(",") : "0" },
      notes,
    };
  }

  /**
   * One call page as features, dates, documents and text. For ZonMw the status
   * comes from the page's own status block (one more small request); if that fails,
   * from the page metadata.
   */
  async get(args: { url: string; max_chars?: number }): Promise<OnderzoekscallDetail> {
    const { organisation, url } = resolveOnderzoekscallUrl(args.url);
    const maxChars = clampInt(args.max_chars, 500, ONDERZOEKSCALL_MAX_CHARS, ONDERZOEKSCALL_DEFAULT_CHARS);
    const connector = ONDERZOEKSCALL_CONNECTORS[organisation];
    const now = this.now();
    const { data } = await getText(url, {
      connector,
      timeoutMs: organisation === "nwo" ? NWO_TIMEOUT_MS : ZONMW_TIMEOUT_MS,
      crawlDelayMs: this.crawlDelayMs[organisation],
      ...(organisation === "nwo" ? { retries: 1 } : {}),
    });
    const parsed = organisation === "nwo" ? parseNwoCallPage(data, url, now) : parseZonmwCallPage(data, url);
    if (!parsed) {
      throw new OnderzoekscallInputError(
        `${url} is geen ${organisation === "nwo" ? "callpagina" : "subsidiepagina"} (geen titel met kenmerken gevonden).`,
        "Geef de url van een call uit nl_onderzoek_calls_search.",
      );
    }

    const notes: string[] = [];
    const params: Record<string, string> = { url };
    let status = parsed.status;
    let statusLabel = parsed.status_label;
    let statusSource = parsed.status_source;
    if (organisation === "zonmw") {
      let block: ReturnType<typeof parseZonmwStatusBlock>;
      if (parsed.statusBlockUrl) {
        params.status_block = parsed.statusBlockUrl;
        try {
          const { data: blockHtml } = await getText(parsed.statusBlockUrl, { connector, timeoutMs: ZONMW_TIMEOUT_MS, crawlDelayMs: this.crawlDelayMs.zonmw });
          block = parseZonmwStatusBlock(blockHtml);
        } catch {
          // Fall back to the page metadata below; the page itself was read fine.
        }
      }
      if (block) {
        status = block.status;
        statusLabel = block.label;
        statusSource = "label";
      } else if (parsed.metadataStatus && ZONMW_STATUS[parsed.metadataStatus]) {
        status = ZONMW_STATUS[parsed.metadataStatus].status;
        statusLabel = ZONMW_STATUS[parsed.metadataStatus].label;
        statusSource = "paginagegevens";
        notes.push("Het statusblok van zonmw.nl was niet te lezen; de status komt uit de paginagegevens en kan achterlopen.");
      } else {
        notes.push("De status van deze subsidie was niet te bepalen.");
      }
    }

    const full = parsed.fullText;
    let text = full;
    let truncated = false;
    if (full.length > maxChars) {
      const head = full.slice(0, maxChars);
      const space = head.lastIndexOf(" ");
      text = `${(space > maxChars * 0.8 ? head.slice(0, space) : head).trimEnd()} …`;
      truncated = true;
      notes.push(`Tekst afgekapt na ${maxChars} van ${full.length} tekens; vraag meer met max_chars (hoogstens ${ONDERZOEKSCALL_MAX_CHARS}).`);
    }
    if (!parsed.deadline) notes.push("Op de pagina staat geen (eenduidige) sluitingsdatum; zie dates en de tekst.");
    if (parsed.next_deadline && parsed.next_deadline !== parsed.deadline) {
      notes.push(
        `De eerstvolgende sluitingsdatum is ${parsed.next_deadline_label} (${parsed.next_deadline_text}), vóór ${parsed.deadline_label ?? "de laatste sluitingsdatum"}${parsed.deadline_text ? ` (${parsed.deadline_text})` : ""}; ` +
          "of die stap verplicht is, staat in de tekst van de call.",
      );
    }
    if (parsed.budget_text === undefined && parsed.budget_per_application_text === undefined) notes.push("Op de pagina staat geen budget bij de kenmerken.");
    notes.push("Contactpersonen van de pagina zijn weggelaten.");

    const { fullText: _full, statusBlockUrl: _block, metadataStatus: _meta, ...rest } = parsed;
    return {
      ...rest,
      ...(status ? { status } : {}),
      ...(statusLabel ? { status_label: statusLabel } : {}),
      ...(statusSource ? { status_source: statusSource } : {}),
      text,
      text_chars: full.length,
      truncated,
      endpoint: url,
      params,
      access_note: [...parsed.warnings, ...notes].join(" "),
    };
  }
}

/** One-line summary for the search tool. */
export function summarizeOnderzoekscallsSearch(out: OnderzoekscallsSearchResult): string {
  const statusText: Record<OnderzoekscallStatusFilter, string> = {
    actueel: "open of binnenkort open",
    open: "open",
    binnenkort: "binnenkort open",
    gesloten: "gesloten",
    alle: "alle statussen",
  };
  const who = out.organisations.map((o) => LABEL[o]).join(" en ");
  const parts = out.per_site.map((s) => `${LABEL[s.organisation]}: ${s.total === null ? `${s.items.length}+` : s.total}`);
  let summary = `Calls en subsidierondes (${statusText[out.status]}) bij ${who}`;
  if (out.query) summary += ` voor '${out.query}'`;
  summary += `: ${parts.join(", ")}`;
  summary += out.items.length ? `; getoond ${out.items.length} vanaf offset ${out.offset}` : "; geen op deze pagina";
  if (out.failures.length) summary += ` (${out.failures.map((f) => LABEL[f.organisation]).join(", ")} niet bereikbaar)`;
  return summary;
}

/** One-line summary for the get tool: title, status, deadline and budget as the page gives them. */
export function summarizeOnderzoekscall(d: OnderzoekscallDetail): string {
  const parts = [
    d.status_label ? `status '${d.status_label}'` : "status onbekend",
    ...(d.next_deadline && d.next_deadline !== d.deadline ? [`eerst ${d.next_deadline_label}: ${d.next_deadline_text}`] : []),
    d.deadline_text ? `${d.deadline_label ?? "deadline"}: ${d.deadline_text}` : "geen eenduidige sluitingsdatum op de pagina",
    ...(d.budget_text ? [`budget ${d.budget_text}`] : []),
    ...(d.budget_per_application_text ? [`per aanvraag ${d.budget_per_application_text}`] : []),
  ];
  return `${LABEL[d.organisation]}: ${d.title} (${parts.join("; ")})${d.warnings.length ? " — let op, zie access_note" : ""}`;
}

/**
 * The calendar day of an instant in Amsterdam (YYYY-MM-DD), for a record date. A
 * deadline at 00:00 Amsterdam time is 22:00 or 23:00 UTC the day before, so the
 * ISO string itself must not be cut.
 */
export function amsterdamDay(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return undefined;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
}

/** Error mapping for both tools: input errors and a missing page get their own message. */
export function mapOnderzoekscallError(error: unknown): MCPErrorResponse {
  if (error instanceof OnderzoekscallInputError) return errorResponse({ error: "unexpected", message: error.message, suggestion: error.suggestion });
  const zonmw = error instanceof SourceRequestError && error.endpoint.includes("zonmw.nl");
  if (error instanceof SourceRequestError && error.status === 404) {
    return errorResponse({
      error: "http_error",
      message: `Pagina niet gevonden op ${zonmw ? "zonmw.nl" : "nwo.nl"} (HTTP 404).`,
      suggestion: "Zoek de call opnieuw met nl_onderzoek_calls_search; de url kan veranderd zijn.",
      details: { endpoint: error.endpoint, status: 404 },
    });
  }
  return mapSourceError(error, zonmw ? "ZonMw" : "NWO", zonmw ? ZONMW_SUBSIDIES_ENDPOINT : NWO_CALLS_ENDPOINT);
}
