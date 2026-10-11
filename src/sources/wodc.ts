/**
 * WODC Repository (repository.wodc.nl): the research reports of the
 * Wetenschappelijk Onderzoek- en Datacentrum of the Ministry of Justice and
 * Security, from 1974 on. A DSpace 7 repository with an open REST API, no key.
 *
 * Search is DSpace discovery (Solr) over the metadata AND the full text of the
 * reports; it gives no highlights, so a hit may sit anywhere in a report.
 * An item has an ORIGINAL bundle (the PDFs: rapport, aanbiedingsbrief,
 * samenvatting, summary, ...) and usually a TEXT bundle with DSpace's own text
 * extraction of each PDF ("<name>.pdf.txt"). That extraction stops at 100,000
 * characters, so for a long report it holds only the first part; the full text
 * is then read from the PDF itself. Some items hold no files at all: the report
 * was published elsewhere and the item links to it.
 *
 * The site's copyright page puts the website under CC0; the items carry no
 * licence (no dc.rights), so none is claimed for the reports.
 */
import { getJson, getText, SourceRequestError } from "../utils/http.js";
import { errorResponse, mapSourceError } from "../utils/response.js";
import { fetchPdfText, MAX_PDF_TEXT_CHARS } from "../utils/pdf-text.js";
import { foldText } from "./dso-regeltekst.js";
import { snippetAt } from "./tweede-kamer-debatten.js";
import type { AppConfig, MCPErrorResponse } from "../types.js";

const SITE = "https://repository.wodc.nl";
const API = `${SITE}/server/api`;
export const WODC_SEARCH_ENDPOINT = `${API}/discover/search/objects`;
export const WODC_ITEM_ENDPOINT = `${API}/core/items`;
const PID_ENDPOINT = `${API}/pid/find`;
const BITSTREAM_ENDPOINT = `${API}/core/bitstreams`;
/** The repository's handle prefix: https://repository.wodc.nl/handle/20.500.12832/3576. */
const HANDLE_PREFIX = "20.500.12832";
const CONNECTOR = "wodc";
const TIMEOUT_MS = 15_000;
const TEXT_TIMEOUT_MS = 20_000;

/** Upstream page size used at most per request (DSpace's discovery default maximum). */
export const WODC_MAX_ROWS = 100;
export const WODC_DEFAULT_ROWS = 20;
/**
 * Highest offset wodc_search takes. The repository holds some thousands of items; a far
 * larger offset overflows DSpace's page number and returns items from the start.
 */
export const WODC_MAX_OFFSET = 100_000;
/** DSpace's text extraction (textextractor.max-chars) stops at this many characters. */
export const WODC_REPOSITORY_TEXT_LIMIT = 100_000;
export const WODC_DEFAULT_CHARS = 10_000;
export const WODC_MAX_CHARS = 50_000;
/** Characters of the abstract in a search record; wodc_document_get gives it whole. */
const ABSTRACT_CHARS = 600;
const PASSAGE_RADIUS = 250;
/** Every word of a zoekterm must occur within this many characters of the first. */
const PASSAGE_WINDOW = 400;
export const WODC_MAX_PASSAGES = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

export type WodcSort = "relevance" | "newest" | "oldest";
export type WodcTextSource = "auto" | "repository" | "pdf";

export class WodcInputError extends Error {
  constructor(message: string, public readonly suggestion?: string) {
    super(message);
    this.name = "WodcInputError";
  }
}

export interface WodcItem {
  uuid: string;
  handle?: string;
  title: string;
  subtitle?: string;
  title_english?: string;
  authors: string[];
  institutions: string[];
  /** dc.date.issued as published: a day, a month or only a year ("2000"). */
  issued?: string;
  /** Report series and number, e.g. "Cahier 2026-12", "WODC Rapport 3356". */
  series: string[];
  /** WODC project number(s) (dc.identifier.project), e.g. "3105g". */
  projectnummers: string[];
  type?: string;
  subjects: string[];
  abstract?: string;
  publisher?: string;
  /** Canonical handle URL, the persistent link the repository itself gives. */
  url: string;
  /** The item page in the repository's web interface. */
  item_url: string;
  /** News articles about the report on wodc.nl. */
  news_urls: string[];
  /** Other links, e.g. to a report published elsewhere. */
  related_urls: string[];
  withdrawn?: boolean;
}

export interface WodcSearchArgs {
  query?: string;
  date_from?: string;
  date_to?: string;
  series?: string;
  project?: string;
  author?: string;
  sort?: WodcSort;
  offset?: number;
  limit?: number;
}

export interface WodcSearchResult {
  items: WodcItem[];
  total: number | null;
  offset: number;
  limit: number;
  sort: WodcSort;
  /** The query as sent upstream (after removing search syntax the repository cannot take). */
  query?: string;
  endpoint: string;
  params: Record<string, string>;
  access_note?: string;
}

export interface WodcFile {
  uuid: string;
  name: string;
  size_bytes: number | null;
  /** From the file name: rapport, samenvatting, summary, aanbiedingsbrief, factsheet, bijlage or overig. */
  soort: string;
  url: string;
  /** The repository holds its own text extraction of this file. */
  repository_tekst: boolean;
}

export interface WodcPassage {
  /** Character position in the (normalised) text. */
  positie: number;
  tekst: string;
}

export interface WodcDocument {
  item: WodcItem;
  files: WodcFile[];
  /** The file whose text is given. */
  bestand?: WodcFile;
  /** Where the text comes from: the repository's extraction or the PDF. */
  tekst_bron?: "repository" | "pdf";
  tekst?: string;
  /** Characters of the text read (before max_chars). */
  tekst_lengte?: number;
  /** The text read is not the whole document (the repository's 100,000-character limit, or the PDF cap). */
  tekst_onvolledig?: boolean;
  /** Length of the whole PDF text, when the PDF was read. */
  pdf_tekst_lengte?: number;
  pdf_paginas?: number;
  /** data.tekst was cut at max_chars. */
  tekst_ingekort?: boolean;
  passages?: WodcPassage[];
  passages_totaal?: number;
  /** Per zoekterm word: how often it occurs in the text read. */
  woord_treffers?: Record<string, number>;
  notes: string[];
  endpoint: string;
  params: Record<string, string>;
}

export interface WodcGetArgs {
  id: string;
  max_chars?: number;
  zoekterm?: string;
  bestand?: string;
  text_source?: WodcTextSource;
}

/* ------------------------------------------------------------------ */
/*  Metadata                                                           */
/* ------------------------------------------------------------------ */

type DspaceMetadata = Record<string, Array<{ value?: unknown }> | undefined>;

function values(md: DspaceMetadata, key: string): string[] {
  return (md[key] ?? [])
    .map((v) => (typeof v?.value === "string" ? v.value.trim() : ""))
    .filter(Boolean);
}

function firstValue(md: DspaceMetadata, key: string): string | undefined {
  return values(md, key)[0];
}

/** "D::Dwangbehandeling" → "Dwangbehandeling": the letter is the thesaurus' index heading. */
function subjectLabel(value: string): string {
  return value.replace(/^[^:]{1,3}::/, "").trim();
}

function isWodcSite(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "www.wodc.nl" || host === "wodc.nl";
  } catch {
    return false;
  }
}

export function wodcHandleUrl(handle: string): string {
  return `${SITE}/handle/${handle}`;
}

export function toWodcItem(raw: Record<string, unknown>): WodcItem {
  const md = (raw.metadata ?? {}) as DspaceMetadata;
  const uuid = String(raw.uuid ?? raw.id ?? "");
  const handle = typeof raw.handle === "string" && raw.handle ? raw.handle : undefined;
  const uri = values(md, "dc.identifier.uri").find((u) => u.startsWith(`${SITE}/handle/`));
  const links = [...values(md, "dc.relation.uri"), ...values(md, "dc.relation.url")].filter((u) => /^https?:\/\//i.test(u));
  const unique = (list: string[]) => [...new Set(list)];
  return {
    uuid,
    handle,
    title: firstValue(md, "dc.title") ?? (typeof raw.name === "string" ? raw.name : ""),
    subtitle: firstValue(md, "dc.title.alternative"),
    title_english: firstValue(md, "dc.title.english"),
    authors: values(md, "dc.contributor.author"),
    institutions: unique(values(md, "dc.contributor.institution")),
    issued: firstValue(md, "dc.date.issued"),
    series: values(md, "dc.relation.ispartofseries"),
    projectnummers: values(md, "dc.identifier.project"),
    type: firstValue(md, "dc.type"),
    subjects: unique(values(md, "dc.subject").map(subjectLabel).filter(Boolean)),
    abstract: firstValue(md, "dc.description.abstract"),
    publisher: firstValue(md, "dc.publisher"),
    url: uri ?? (handle ? wodcHandleUrl(handle) : `${SITE}/items/${uuid}`),
    item_url: `${SITE}/items/${uuid}`,
    news_urls: unique(links.filter(isWodcSite)),
    related_urls: unique(links.filter((u) => !isWodcSite(u))),
    withdrawn: raw.withdrawn === true ? true : undefined,
  };
}

/** Abstract for a search record: at most ABSTRACT_CHARS, cut on a word boundary. */
export function shortAbstract(abstract: string | undefined, max = ABSTRACT_CHARS): { text?: string; cut: boolean } {
  if (!abstract) return { cut: false };
  const flat = abstract.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return { text: flat, cut: false };
  return { text: `${flat.slice(0, max).replace(/\s+\S*$/, "")} …`, cut: true };
}

/* ------------------------------------------------------------------ */
/*  Search input                                                       */
/* ------------------------------------------------------------------ */

/**
 * A query the repository's Solr parser accepts. Words, "quoted phrases",
 * -word (exclude) and OR/AND/NOT stay; the rest of the Lucene syntax is
 * removed, since "(", "[", "~" or an unbalanced quote make the repository
 * answer HTTP 422, "a:b" searches a field named a and "c++" matches every item.
 */
export function cleanWodcQuery(raw: string | undefined): { query?: string; removed: string[] } {
  let text = (raw ?? "").replace(/[“”„‟«»]/g, '"').trim();
  const removed: string[] = [];
  if (!text) return { removed };
  if ((text.match(/"/g) ?? []).length % 2 === 1) {
    text = text.replace(/"/g, " ");
    removed.push('"');
  }
  const special = /[+&|!(){}[\]^~*?:\\/]/g;
  for (const m of new Set(text.match(special) ?? [])) removed.push(m);
  text = text.replace(special, " ");
  const tokens = text
    .split(/(\s+|"[^"]*")/)
    .map((t) => t.trim())
    .filter(Boolean)
    // A lone or trailing "-" excludes nothing; a token of only hyphens is noise.
    .map((t) => (t.startsWith('"') ? t : t.replace(/-+$/, "")))
    .filter((t) => t && t !== '""' && !/^-+$/.test(t));
  // An operator needs a term on both sides (NOT also works in front of one).
  while (tokens.length && /^(AND|OR)$/.test(tokens[0])) tokens.shift();
  while (tokens.length && /^(AND|OR|NOT)$/.test(tokens[tokens.length - 1])) tokens.pop();
  const query = tokens.join(" ").trim();
  return { query: query || undefined, removed };
}

/** A date_from/date_to value: YYYY, YYYY-MM or YYYY-MM-DD. */
export function parseWodcDate(name: string, value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  const m = DATE_RE.exec(v);
  const month = m?.[2] ? Number(m[2]) : 1;
  const day = m?.[3] ? Number(m[3]) : 1;
  const valid = m && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(Number(m[1]), month, 0)).getUTCDate();
  if (!valid) {
    throw new WodcInputError(`${name} '${value}' is geen datum`, "Gebruik YYYY, YYYY-MM of YYYY-MM-DD, bijvoorbeeld 2024 of 2024-03-01.");
  }
  return v;
}

/**
 * A date_to the repository takes as meant: it reads a month as its first day
 * ("2024-06" ends on 1 June), so a month is sent as its last day. A year it
 * reads as the whole year already.
 */
export function wodcDateTo(value: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m) return value;
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return `${value}-${String(last).padStart(2, "0")}`;
}

/** The comparable start of a date value, to check that date_from is not after date_to. */
function dateKey(value: string, edge: "start" | "end"): string {
  const [y, m, d] = value.split("-");
  if (d) return value;
  if (m) return edge === "start" ? `${y}-${m}-01` : `${y}-${m}-31`;
  return edge === "start" ? `${y}-01-01` : `${y}-12-31`;
}

export function clampWodcRows(limit: number | null | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return WODC_DEFAULT_ROWS;
  return Math.min(WODC_MAX_ROWS, Math.max(1, Math.floor(limit)));
}

/**
 * Map an offset/limit window onto DSpace's page/size paging (page from 0): the
 * smallest page size from `limit` up to WODC_MAX_ROWS that holds the whole
 * window in one page, else the page size that fetches the fewest items in at
 * most three consecutive pages (a page of 100 items takes the repository
 * seconds, so fetching twice the window is slow).
 */
export function planWodcWindow(offset: number, limit: number): { size: number; pages: number[]; skip: number } {
  const off = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0));
  const lim = clampWodcRows(limit);
  const last = off + lim - 1;
  for (let size = lim; size <= WODC_MAX_ROWS; size++) {
    if (Math.floor(off / size) === Math.floor(last / size)) return { size, pages: [Math.floor(off / size)], skip: off % size };
  }
  let best = { size: WODC_MAX_ROWS, first: Math.floor(off / WODC_MAX_ROWS), count: Math.floor(last / WODC_MAX_ROWS) - Math.floor(off / WODC_MAX_ROWS) + 1 };
  for (let size = WODC_MAX_ROWS - 1; size >= Math.ceil(lim / 2); size--) {
    const first = Math.floor(off / size);
    const count = Math.floor(last / size) - first + 1;
    if (count <= 3 && count * size < best.count * best.size) best = { size, first, count };
  }
  const pages = Array.from({ length: best.count }, (_, i) => best.first + i);
  return { size: best.size, pages, skip: off - best.first * best.size };
}

const SORT_PARAM: Record<WodcSort, string> = {
  relevance: "score,DESC",
  newest: "dc.date.issued,DESC",
  oldest: "dc.date.issued,ASC",
};

/* ------------------------------------------------------------------ */
/*  Item input                                                         */
/* ------------------------------------------------------------------ */

/**
 * The uuid or handle an id stands for: a uuid, a handle ("20.500.12832/3576",
 * "hdl:20.500.12832/3576"), or a repository URL (/handle/…, /items/<uuid>,
 * /entities/publication/<uuid>, hdl.handle.net/…).
 */
export function parseWodcId(input: string): { uuid: string } | { handle: string } {
  const raw = input.trim();
  if (UUID_RE.test(raw)) return { uuid: raw.toLowerCase() };
  // A link is read only from the repository itself or the handle resolver, never from another site.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^www\./i.test(raw)) {
    let host = "";
    try {
      host = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw).hostname.toLowerCase();
    } catch {
      // Not a URL after all: the checks below reject it.
    }
    if (host !== "repository.wodc.nl" && host !== "hdl.handle.net") {
      throw new WodcInputError(
        `'${input.slice(0, 200)}' is geen link naar de WODC-repository${host ? ` (host ${host})` : ""}`,
        "Geef de uuid of een link van repository.wodc.nl (of hdl.handle.net), bijvoorbeeld https://repository.wodc.nl/handle/20.500.12832/3576.",
      );
    }
  }
  const uuidInUrl = /repository\.wodc\.nl\/(?:server\/api\/core\/items|items|entities\/[a-z]+)\/([0-9a-f-]{36})/i.exec(raw);
  if (uuidInUrl && UUID_RE.test(uuidInUrl[1])) return { uuid: uuidInUrl[1].toLowerCase() };
  const handle = new RegExp(`(?:^|hdl:|/handle/|hdl\\.handle\\.net/)(${HANDLE_PREFIX.replace(/\./g, "\\.")}/\\d+)(?:[/?#]|$)`, "i").exec(raw);
  if (handle) return { handle: handle[1] };
  if (/^\d+$/.test(raw)) return { handle: `${HANDLE_PREFIX}/${raw}` };
  throw new WodcInputError(
    `'${input}' is geen WODC-item`,
    "Geef de uuid of de handle-URL uit wodc_search, bijvoorbeeld https://repository.wodc.nl/handle/20.500.12832/3576.",
  );
}

/* ------------------------------------------------------------------ */
/*  Files and text                                                     */
/* ------------------------------------------------------------------ */

const FILE_KINDS: Array<[RegExp, string]> = [
  [/^aanbied/, "aanbiedingsbrief"],
  [/^(beleidsreactie|kamerbrief|brief)/, "aanbiedingsbrief"],
  [/^samenvatting/, "samenvatting"],
  [/^(summary|english-summary)/, "summary"],
  [/^factsheet/, "factsheet"],
  [/^(bijlage|bijlagen|appendix|annex)/, "bijlage"],
  [/^(rapport|eindrapport|volledige|.*volledige[-_ ]tekst)/, "rapport"],
];

/**
 * Older names carry the kind after a number or title: "3322-vroegtijdig
 * ingrijpen-samenvatting.pdf", "ob264_summary_tcm28-69414.pdf",
 * "addendum-aanbiednota-....pdf"; the kind then is a whole word part.
 */
const FILE_KIND_WORDS: Array<[RegExp, string]> = [
  [/(?:^|[-_ .])samenvatting(?:$|[-_ .])/, "samenvatting"],
  [/(?:^|[-_ .])summary(?:$|[-_ .])/, "summary"],
  [/(?:^|[-_ .])(aanbied\w*|beleidsreactie|kamerbrief)(?:$|[-_ .])/, "aanbiedingsbrief"],
  [/(?:^|[-_ .])factsheet(?:$|[-_ .])/, "factsheet"],
  [/(?:^|[-_ .])(bijlagen?|bijlagenrapport|appendix|annex)(?:$|[-_ .])/, "bijlage"],
];

export function fileKind(name: string): string {
  const n = foldText(name);
  for (const [re, kind] of FILE_KINDS) if (re.test(n)) return kind;
  for (const [re, kind] of FILE_KIND_WORDS) if (re.test(n)) return kind;
  return "overig";
}

/**
 * The file that is the report: one named as such, else the largest PDF that is
 * no letter, summary or appendix, else (a factsheet, a summary alone) the largest.
 */
export function pickMainFile(files: WodcFile[]): WodcFile | undefined {
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
  const pool = pdfs.length ? pdfs : files;
  const bySize = (list: WodcFile[]) => [...list].sort((a, b) => (b.size_bytes ?? 0) - (a.size_bytes ?? 0))[0];
  return (
    bySize(pool.filter((f) => f.soort === "rapport")) ??
    bySize(pool.filter((f) => !["aanbiedingsbrief", "samenvatting", "summary", "bijlage"].includes(f.soort))) ??
    bySize(pool)
  );
}

/** A file asked for by uuid or by (part of) its name, accents and case ignored. */
export function pickFile(files: WodcFile[], wanted: string): WodcFile | undefined {
  const w = wanted.trim();
  const byId = files.find((f) => f.uuid.toLowerCase() === w.toLowerCase());
  if (byId) return byId;
  const fw = foldText(w);
  return files.find((f) => f.soort === fw) ?? files.find((f) => foldText(f.name).includes(fw));
}

/**
 * The repository's extracted text is a PDF text layer with every line followed
 * by a blank line: one or two line breaks are a line break, more a paragraph.
 */
export function normalizeRepositoryText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2010\u2011]/g, "-")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\u0000")
    .replace(/\n\n/g, "\n")
    .replace(/\u0000/g, "\n\n")
    .trim();
}

/** Cut at max characters on a word boundary. */
function cutText(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  return { text: `${text.slice(0, max).replace(/\s+\S*$/, "")} …`, cut: true };
}

interface ZoekTerm {
  text: string;
  re: RegExp;
}

/**
 * The words of a zoekterm: "quoted phrases" and single words, accents and case
 * ignored. A word of up to 3 characters or a phrase matches as a whole word, a
 * longer word also inside a longer one ("recidive" finds "recidivecijfers").
 */
export function zoekTerms(zoekterm: string): ZoekTerm[] {
  const input = zoekterm.replace(/[“”„‟«»]/g, '"');
  const parts: string[] = [];
  const rest = input.replace(/"([^"]*)"/g, (_m, phrase: string) => {
    if (phrase.trim()) parts.push(phrase.trim());
    return " ";
  });
  const phrases = new Set(parts);
  for (const w of rest.split(/\s+/)) {
    const t = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (t) parts.push(t);
  }
  const seen = new Set<string>();
  const terms: ZoekTerm[] = [];
  for (const part of parts) {
    const folded = foldText(part).replace(/\s+/g, " ");
    if (seen.has(folded)) continue;
    seen.add(folded);
    const escaped = folded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    const whole = phrases.has(part) || folded.length <= 3;
    terms.push({ text: part, re: new RegExp(whole ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped, "gu") });
  }
  return terms;
}

/** Fold text keeping every position, so a match in the folded text is a match in the original. */
function foldKeepingPositions(text: string): string {
  const folded = foldText(text);
  if (folded.length === text.length) return folded;
  return text
    .split("")
    .map((c) => {
      const f = foldText(c);
      return f.length === 1 ? f : c;
    })
    .join("");
}

/**
 * The passages holding every word of the zoekterm within PASSAGE_WINDOW
 * characters of an occurrence of the first, in document order, each around
 * that occurrence; occurrences inside an earlier passage are not repeated.
 */
export function findPassages(text: string, zoekterm: string, max = WODC_MAX_PASSAGES): { passages: WodcPassage[]; total: number; counts: Record<string, number> } {
  const terms = zoekTerms(zoekterm);
  const counts: Record<string, number> = {};
  if (!terms.length) return { passages: [], total: 0, counts };
  const flat = text.replace(/\s+/g, " ");
  const folded = foldKeepingPositions(flat);
  const positions = terms.map((t) => [...folded.matchAll(t.re)].map((m) => m.index ?? 0));
  terms.forEach((t, i) => (counts[t.text] = positions[i].length));
  const passages: WodcPassage[] = [];
  let total = 0;
  let coveredTo = -1;
  for (const at of positions[0]) {
    if (at < coveredTo) continue;
    const near = positions.every((list) => list.some((p) => Math.abs(p - at) <= PASSAGE_WINDOW));
    if (!near) continue;
    total += 1;
    coveredTo = at + PASSAGE_RADIUS;
    if (passages.length < max) passages.push({ positie: at, tekst: snippetAt(flat, at, PASSAGE_RADIUS) });
  }
  return { passages, total, counts };
}

/* ------------------------------------------------------------------ */
/*  Source                                                             */
/* ------------------------------------------------------------------ */

interface DspaceSearchResponse {
  _embedded?: {
    searchResult?: {
      page?: { totalElements?: number };
      _embedded?: { objects?: Array<{ _embedded?: { indexableObject?: Record<string, unknown> } }> };
    };
  };
}

interface DspaceBitstream {
  uuid?: string;
  name?: string;
  sizeBytes?: number;
  _links?: { content?: { href?: string } };
}

interface DspaceBundle {
  name?: string;
  _embedded?: { bitstreams?: { page?: { totalElements?: number }; _embedded?: { bitstreams?: DspaceBitstream[] } } };
}

/** The download URL of a file; a link off the repository is not followed. */
function contentUrl(b: DspaceBitstream): string {
  const href = b._links?.content?.href;
  return href?.startsWith(`${BITSTREAM_ENDPOINT}/`) ? href : `${BITSTREAM_ENDPOINT}/${b.uuid}/content`;
}

export class WodcSource {
  constructor(private readonly config: AppConfig) {}

  /** The request parameters of a search, also for dryRun. */
  buildSearchParams(args: WodcSearchArgs, page: number, size: number): { params: Record<string, string>; sort: WodcSort; query?: string; removed: string[] } {
    const { query, removed } = cleanWodcQuery(args.query);
    const from = parseWodcDate("date_from", args.date_from);
    const to = parseWodcDate("date_to", args.date_to);
    if (from && to && dateKey(from, "start") > dateKey(to, "end")) {
      throw new WodcInputError(`date_from ${from} ligt na date_to ${to}`, "Draai de datums om.");
    }
    const sort: WodcSort = args.sort ?? (query ? "relevance" : "newest");
    const params: Record<string, string> = { dsoType: "ITEM", sort: SORT_PARAM[sort], page: String(page), size: String(size) };
    if (query) params.query = query;
    if (from || to) params["f.dateIssued"] = `[${from ?? "*"} TO ${to ? wodcDateTo(to) : "*"}],equals`;
    if (args.series?.trim()) params["f.series"] = `${args.series.trim()},contains`;
    if (args.project?.trim()) params["f.project"] = `${args.project.trim()},contains`;
    if (args.author?.trim()) params["f.author"] = `${args.author.trim()},contains`;
    return { params, sort, query, removed };
  }

  async search(args: WodcSearchArgs): Promise<WodcSearchResult> {
    const limit = clampWodcRows(args.limit);
    const requested = Math.max(0, Math.floor(args.offset ?? 0));
    const offset = Math.min(requested, WODC_MAX_OFFSET);
    const plan = planWodcWindow(offset, limit);
    const built = this.buildSearchParams(args, plan.pages[0], plan.size);
    const raws: Record<string, unknown>[] = [];
    let total: number | null = null;
    for (const page of plan.pages) {
      const { data } = await getJson<DspaceSearchResponse>(WODC_SEARCH_ENDPOINT, {
        connector: CONNECTOR,
        timeoutMs: TIMEOUT_MS,
        query: { ...built.params, page: String(page) },
      });
      const result = data?._embedded?.searchResult;
      if (!result) {
        throw new SourceRequestError({ message: "WODC search response without searchResult", endpoint: WODC_SEARCH_ENDPOINT, code: "malformed_response" });
      }
      total = typeof result.page?.totalElements === "number" ? result.page.totalElements : total;
      const objects = result._embedded?.objects ?? [];
      for (const o of objects) if (o._embedded?.indexableObject) raws.push(o._embedded.indexableObject);
      if (objects.length < plan.size) break;
    }
    // An offset at or past the last item is an empty page, whatever the repository sends for it.
    const items = total !== null && requested >= total ? [] : raws.slice(plan.skip, plan.skip + limit).map(toWodcItem);
    const notes: string[] = [];
    if (total !== null && requested >= total && total > 0) notes.push(`offset ${requested} ligt voorbij het laatste van de ${total} rapporten: deze pagina is leeg.`);
    if (built.removed.length) notes.push(`Zoeksyntax die de repository niet aanneemt is uit de zoekvraag gehaald (${built.removed.join(" ")}); gezocht op: ${built.query ?? "(alles)"}.`);
    if (args.query?.trim() && !built.query) notes.push("Er bleef geen zoekwoord over; alle items binnen de filters zijn getoond.");
    if (built.query) notes.push("Zoekwoorden worden gezocht in de metadata én in de volledige tekst van de rapporten; een treffer kan dus alleen in de tekst staan (lees die met wodc_document_get en zoekterm).");
    if ((args.date_from && /^\d{4}-\d{2}/.test(args.date_from)) || (args.date_to && /^\d{4}-\d{2}/.test(args.date_to))) {
      notes.push("Oudere items hebben alleen een jaar als datum; die tellen als 1 januari van dat jaar.");
    }
    return {
      items,
      total,
      offset: requested,
      limit,
      sort: built.sort,
      query: built.query,
      endpoint: WODC_SEARCH_ENDPOINT,
      params: { ...built.params, page: plan.pages.join(","), size: String(plan.size) },
      access_note: notes.join(" ") || undefined,
    };
  }

  /** The item with its bundles, or undefined when the repository does not know it. */
  private async fetchItem(id: { uuid: string } | { handle: string }): Promise<{ raw: Record<string, unknown>; bundles: DspaceBundle[] } | undefined> {
    try {
      let uuid: string;
      if ("handle" in id) {
        // pid/find answers with a redirect to the item; fetch follows it.
        const { data } = await getJson<Record<string, unknown>>(PID_ENDPOINT, { connector: CONNECTOR, timeoutMs: TIMEOUT_MS, query: { id: `hdl:${id.handle}` } });
        uuid = String(data?.uuid ?? "");
        if (!UUID_RE.test(uuid)) return undefined;
      } else {
        uuid = id.uuid;
      }
      const { data } = await getJson<Record<string, unknown> & { _embedded?: { bundles?: { _embedded?: { bundles?: DspaceBundle[] } } } }>(`${WODC_ITEM_ENDPOINT}/${uuid}`, {
        connector: CONNECTOR,
        timeoutMs: TIMEOUT_MS,
        query: { embed: "bundles/bitstreams" },
      });
      if (!data || typeof data !== "object" || !data.uuid) {
        throw new SourceRequestError({ message: "WODC item response without uuid", endpoint: `${WODC_ITEM_ENDPOINT}/${uuid}`, code: "malformed_response" });
      }
      return { raw: data, bundles: data._embedded?.bundles?._embedded?.bundles ?? [] };
    } catch (e) {
      // A uuid or handle the repository does not hold: 404. A withdrawn or
      // private item answers 401/403 to an anonymous request.
      if (e instanceof SourceRequestError && (e.status === 404 || e.status === 401 || e.status === 403)) return undefined;
      throw e;
    }
  }

  async getDocument(args: WodcGetArgs): Promise<WodcDocument | { notFound: true; endpoint: string; params: Record<string, string>; message: string }> {
    const id = parseWodcId(args.id);
    const endpoint = "uuid" in id ? `${WODC_ITEM_ENDPOINT}/${id.uuid}` : PID_ENDPOINT;
    const params: Record<string, string> = "uuid" in id ? { embed: "bundles/bitstreams" } : { id: `hdl:${id.handle}` };
    const fetched = await this.fetchItem(id);
    if (!fetched) {
      return {
        notFound: true,
        endpoint,
        params,
        message: `De WODC-repository kent geen (openbaar) item ${"uuid" in id ? id.uuid : id.handle}.`,
      };
    }
    const item = toWodcItem(fetched.raw);
    const notes: string[] = [];
    const bundle = (name: string) => fetched.bundles.find((b) => b.name === name);
    const bitstreams = (b: DspaceBundle | undefined) => b?._embedded?.bitstreams?._embedded?.bitstreams ?? [];
    const textByName = new Map(bitstreams(bundle("TEXT")).map((b) => [String(b.name ?? ""), b]));
    const files: WodcFile[] = bitstreams(bundle("ORIGINAL"))
      .filter((b) => b.uuid && b.name)
      .map((b) => ({
        uuid: String(b.uuid),
        name: String(b.name),
        size_bytes: typeof b.sizeBytes === "number" ? b.sizeBytes : null,
        soort: fileKind(String(b.name)),
        url: contentUrl(b),
        repository_tekst: textByName.has(`${b.name}.txt`),
      }));
    for (const b of fetched.bundles) {
      const listed = bitstreams(b).length;
      const total = b._embedded?.bitstreams?.page?.totalElements;
      if (b.name === "ORIGINAL" && typeof total === "number" && total > listed) {
        notes.push(`Het item heeft ${total} bestanden; alleen de eerste ${listed} zijn bekeken.`);
      }
    }
    if (item.withdrawn) notes.push("Dit item is door de repository ingetrokken (withdrawn).");

    const doc: WodcDocument = { item, files, notes, endpoint, params };
    if (!files.length) {
      notes.push(
        item.related_urls.length
          ? `De repository bevat voor dit item geen bestanden en dus geen tekst; de publicatie staat elders: ${item.related_urls.join(", ")}.`
          : "De repository bevat voor dit item geen bestanden en dus geen tekst; alleen de beschrijving is beschikbaar.",
      );
      return doc;
    }

    let main: WodcFile | undefined;
    if (args.bestand?.trim()) {
      main = pickFile(files, args.bestand);
      if (!main) {
        notes.push(`Geen bestand '${args.bestand}' bij dit item; gekozen is het hoofdrapport. Bestanden: ${files.map((f) => f.name).join(", ")}.`);
      }
    }
    main ??= pickMainFile(files);
    doc.bestand = main;
    const maxChars = args.max_chars ?? WODC_DEFAULT_CHARS;
    const zoekterm = args.zoekterm?.trim();
    if (!main || (maxChars === 0 && !zoekterm)) return doc;

    const source = args.text_source ?? "auto";
    const isPdf = /\.pdf$/i.test(main.name);
    let text: string | undefined;
    let complete = true;

    const repoText = textByName.get(`${main.name}.txt`);
    if (source !== "pdf" && repoText) {
      try {
        const { data } = await getText(contentUrl(repoText), { connector: CONNECTOR, timeoutMs: TEXT_TIMEOUT_MS });
        text = normalizeRepositoryText(data);
        complete = data.length < WODC_REPOSITORY_TEXT_LIMIT;
        doc.tekst_bron = "repository";
        if (!text) notes.push(`De tekstextractie van de repository voor ${main.name} is leeg.`);
      } catch (e) {
        if (!(e instanceof SourceRequestError)) throw e;
        notes.push(`De tekst van ${main.name} in de repository kon niet worden gelezen (${e.status ? `HTTP ${e.status}` : e.code}).`);
      }
    } else if (source === "repository" && !repoText) {
      notes.push(`De repository heeft geen eigen tekstextractie van ${main.name}${isPdf ? "; lees de PDF met text_source 'pdf'" : ""}.`);
    }

    // The PDF is read when asked for, when the repository has no (readable) text,
    // or when its text stops at the extraction limit and more of it is needed.
    const needMore = !complete && (Boolean(zoekterm) || maxChars > (text?.length ?? 0));
    const readPdf = isPdf && (source === "pdf" || (source === "auto" && (!text || needMore)));
    if (readPdf) {
      const pdf = await fetchPdfText(main.url, { maxChars: MAX_PDF_TEXT_CHARS, connector: CONNECTOR });
      if (pdf.ok) {
        text = pdf.text;
        complete = !pdf.truncated;
        doc.tekst_bron = "pdf";
        doc.pdf_tekst_lengte = pdf.total_chars;
        doc.pdf_paginas = pdf.pages;
        if (pdf.truncated) notes.push(`Van de PDF (${pdf.pages} pagina's, ${pdf.total_chars} tekens) zijn de eerste ${MAX_PDF_TEXT_CHARS} tekens gelezen; de rest staat alleen in de PDF.`);
      } else if (pdf.reason === "no_text_layer") {
        notes.push(`${main.name} heeft geen tekstlaag (vermoedelijk een scan); er is geen tekst beschikbaar. Open de PDF.`);
      } else {
        notes.push(`De tekst uit de PDF ${main.name} kon niet worden gelezen (${pdf.reason}: ${pdf.message}).${text ? " De tekst hieronder komt uit de repository." : ""}`);
      }
    }
    if (doc.tekst_bron === "repository" && !complete) {
      notes.push(`De tekstextractie van de repository stopt na ${WODC_REPOSITORY_TEXT_LIMIT} tekens; dit is alleen het begin van ${main.name}${source === "repository" ? " (lees de rest met text_source 'pdf')" : ""}.`);
    }
    if (text === undefined) {
      if (!repoText && !isPdf) notes.push(`Van ${main.name} is geen tekst beschikbaar.`);
      else if (source === "pdf" && !isPdf) notes.push(`${main.name} is geen PDF; lees de tekst met text_source 'auto'.`);
      return doc;
    }

    doc.tekst_lengte = text.length;
    doc.tekst_onvolledig = complete ? undefined : true;
    if (zoekterm) {
      const found = findPassages(text, zoekterm);
      let budget = maxChars > 0 ? maxChars : WODC_DEFAULT_CHARS;
      doc.passages = [];
      for (const p of found.passages) {
        if (budget <= 0) break;
        doc.passages.push(p.tekst.length > budget ? { ...p, tekst: cutText(p.tekst, budget).text } : p);
        budget -= p.tekst.length;
      }
      doc.passages_totaal = found.total;
      doc.woord_treffers = found.counts;
      if (found.total > doc.passages.length) {
        notes.push(`${found.total} passages gevonden, de eerste ${doc.passages.length} getoond (max ${WODC_MAX_PASSAGES}, binnen max_chars).`);
      }
      if (!found.total) {
        const missing = Object.entries(found.counts).filter(([, n]) => n === 0).map(([w]) => w);
        notes.push(
          missing.length
            ? `'${missing.join("', '")}' komt niet voor in de gelezen tekst${complete ? "" : " (niet de hele tekst; zie hierboven)"}.`
            : `De woorden komen voor, maar niet binnen ${PASSAGE_WINDOW} tekens van elkaar; zoek op minder woorden.`,
        );
      }
    } else {
      const cut = cutText(text, maxChars);
      doc.tekst = cut.text;
      doc.tekst_ingekort = cut.cut ? true : undefined;
      if (cut.cut) notes.push(`Tekst ingekort tot ${maxChars} van ${text.length} tekens (max_chars); zoek gericht met zoekterm.`);
    }
    return doc;
  }
}

export function mapWodcError(error: unknown): MCPErrorResponse {
  if (error instanceof WodcInputError) return errorResponse({ error: "unexpected", message: error.message, suggestion: error.suggestion });
  if (error instanceof SourceRequestError && (error.status === 400 || error.status === 422)) {
    return errorResponse({
      error: "http_error",
      message: `De WODC-repository weigerde de zoekvraag (HTTP ${error.status}).`,
      suggestion: "Gebruik gewone woorden en eventueel \"aanhalingstekens\" voor een woordgroep.",
      details: { endpoint: error.endpoint, status: error.status },
    });
  }
  return mapSourceError(error, "WODC Repository", SITE);
}
