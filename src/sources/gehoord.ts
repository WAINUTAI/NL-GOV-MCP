import type { AppConfig, MCPRecord } from "../types.js";
import { getJson, SourceRequestError } from "../utils/http.js";
import { errorResponse, mapSourceError } from "../utils/response.js";
import type { MCPErrorResponse } from "../types.js";
import { termsPosition } from "./tweede-kamer-debatten.js";

/**
 * Gehoord.de: automatic transcripts (speech-to-text) of every debate of the
 * Tweede Kamer and the Eerste Kamer, made from the official public video
 * streams; the speakers come from Kamer data. Run by Jeroen Wollaars, used
 * with his permission and an API key (GEHOORD_KEY, 'Authorization: Bearer').
 * Not an official government source: a finding aid next to the verslagen
 * (tweede_kamer_debatten) and the Handelingen, which are the text to quote.
 *
 * What it adds to the verslagen: a full-text index over all debates since
 * 31 March 2026 (newest first), debates that are still running (status
 * "live"), the Eerste Kamer, and a link to the moment in the video.
 *
 * Verified API behaviour (4 November 2026, after the maker's fixes):
 * - An unknown query parameter is HTTP 400 ("Onbekende parameter ..."), so
 *   get() sends only what GEHOORD_PARAMS lists for the endpoint.
 * - /contributions filters chamber, party, speaker and debateId itself. party
 *   is one exact label, case-insensitive ('VVD', 'PRO', 'CU'; no list): a long
 *   name finds nothing, and one fractie can have several labels (GL-PvdA, since
 *   late September 2026 'PRO'; 'CU' in the TK, 'ChristenUnie' in the EK), so
 *   gehoordParties maps a fractie to its labels and search() asks each. speaker is
 *   the speakerLabel (TK Persoon GUID or Eerste Kamer id), never a name: a
 *   name is filtered here, over at most GEHOORD_SPREKER_MAX_PAGES pages.
 * - match=all (every term, any order), match=any (one of them); without match
 *   q is one literal phrase. A "quoted phrase" and -word work inside q; the
 *   answer echoes query.terms {include, exclude}. A term of 4 characters or
 *   fewer matches whole words only, a longer one inside a compound too.
 * - from/to are the vergaderdag, as the Kamer dates it: a night sitting falls
 *   under the day it began.
 * - Every hit carries the full debate object, as /debates gives it.
 * - Debate status scheduled, live, ended, cancelled (dropped from the Debat
 *   Direct agenda) or error. startsAt is the agenda time, startedAt the real
 *   start; locationId ('klompezaal') is the zaal without accents.
 * - The Eerste Kamer speakerLabel is the Eerste Kamer's own stable person id
 *   (https://www.eerstekamer.nl/id/<id>). In the EK debates seen (4 Nov 2026)
 *   every speaker, the minister and the initiatiefnemers too, had such an id;
 *   the maker says bewindspersonen can also speak there under their TK GUID.
 * - Errors are JSON {error:{code,message}}: 400 invalid_request, 401
 *   unauthorized, 404 not_found.
 * - Rate limit 120 requests a minute (x-ratelimit-* headers); a 429 is
 *   retried by the shared http helper.
 */
export const GEHOORD_BASE = "https://gehoord.de/api/v1";
export const GEHOORD_SITE = "https://gehoord.de";
export const GEHOORD_CONNECTOR = "gehoord";
/** Most items the API returns per request. */
export const GEHOORD_MAX_LIMIT = 200;
/** Pages of 200 a search scans at most for a spreker given by name (Gehoord filters only on a persoon-id). */
export const GEHOORD_SPREKER_MAX_PAGES = 3;
/** Pages of 200 gehoord_debat_get reads at most to find a segment_id in its debate. */
export const GEHOORD_SEGMENT_MAX_PAGES = 10;
export const GEHOORD_DEFAULT_CHARS = 1200;
export const GEHOORD_MAX_CHARS = 10_000;
export const GEHOORD_DEFAULT_CONTEXT = 5;
export const GEHOORD_MAX_CONTEXT = 25;
/** The first day Gehoord.de has transcripts for. */
export const GEHOORD_SINCE = "2026-03-31";

const TIMEOUT_MS = 15_000;

/** The query parameters each endpoint knows (verified 4 Nov 2026); anything else is HTTP 400. */
export const GEHOORD_PARAMS = {
  contributions: ["q", "match", "from", "to", "chamber", "party", "speaker", "debateId", "limit", "offset"],
  debates: ["from", "to", "status", "chamber", "updatedSince", "limit", "offset"],
  debate: [],
  debateContributions: ["format", "updatedSince", "order", "limit", "offset", "delimiter"],
} as const satisfies Record<string, readonly string[]>;

export type GehoordKamer = "tk" | "ek";
/** The statuses gehoord_debatten_list offers (the API also knows 'error' and 'all'). */
export const GEHOORD_STATUSES = ["live", "ended", "scheduled", "cancelled"] as const;
export type GehoordStatus = (typeof GEHOORD_STATUSES)[number];
/** How the terms of a query combine: every term, one of them, or the whole query as one phrase. */
export const GEHOORD_MATCHES = ["alle", "een", "woordgroep"] as const;
export type GehoordMatch = (typeof GEHOORD_MATCHES)[number];
/** The API's match value; woordgroep is the API default (no match parameter). */
const MATCH_API: Record<GehoordMatch, string | undefined> = { alle: "all", een: "any", woordgroep: undefined };

/** The terms a query was read as: what must (or may) occur and what must not. */
export interface GehoordQueryTerms {
  include: string[];
  exclude: string[];
}

/** The debate: as /debates gives it, and embedded in every contribution. */
export interface GehoordDebateRef {
  id: number | string;
  chamber: string;
  title: string;
  status: string;
  hall?: string;
  /** The zaal without accents ('klompezaal', 'plenaire-zaal'): the stable key to compare on. */
  locationId?: string;
  /** "Plenair debat", "Commissiedebat", "Technische briefing", "Procedurevergadering", ... */
  debateType?: string;
  /** The start on the Debat Direct agenda; the Kamer often, not always, sets it to the real start. */
  startsAt?: string;
  /** The real start. */
  startedAt?: string;
  endedAt?: string;
  /** The Debat Direct id of the debate. */
  tkDebateId?: string;
  /** The Activiteit in the Gegevensmagazijn. */
  tkActivityId?: string;
  /** The Activiteit's Nummer ('2026A05087'): the commissievergadering page on tweedekamer.nl. */
  tkActivityNumber?: string;
  /** A human typed condensed subtitles (vragenuur, big debates): the text is not literal. Undefined when not given. */
  subtitlesCondensed?: boolean;
  contributionCount?: number;
  lastContributionAt?: string;
  /** The official Kamer page (debatdirect.tweedekamer.nl or eerstekamer.nl). */
  url?: string;
}

export interface GehoordDebate extends GehoordDebateRef {
  subtitlesCondensed: boolean;
  /** The debate on gehoord.de. */
  gehoordUrl: string;
}

export interface GehoordSpeaker {
  /** The raw speakerLabel: the TK Persoon GUID (the spreker objectid of the VLOS XML), or in the Eerste Kamer its own person id. */
  persoonId: string;
  name: string;
  party?: string;
  role?: string;
  politicianId?: string;
  source?: string;
}

export interface GehoordContribution {
  id: number | string;
  debateId: number | string;
  text: string;
  /**
   * The raw speakerLabel, kept as is: a TK Persoon GUID (identical to the
   * spreker objectid in the VLOS XML), or for a senator the Eerste Kamer's own
   * stable person id ('vkyyicefojzk'), which bewindspersonen and initiatiefnemers
   * there usually have too (a TK GUID only sometimes).
   */
  persoonId: string;
  speakerName: string;
  speakerParty?: string;
  speakerRole?: string;
  startMs?: number;
  endMs?: number;
  /** UTC ISO, as the API gives it. */
  startTime?: string;
  /** UTC ISO, as the API gives it. */
  endTime?: string;
  updatedAt?: string;
  debate: GehoordDebateRef;
  /** gehoord.de/beraadslagingen/{debate.id}?segment={id}: the debate scrolled to this fragment; its text plays the video from there. */
  fragmentUrl: string;
}

export interface GehoordSearchArgs {
  /** Words, a "quoted phrase" and -word; how they combine is `match`. */
  query: string;
  /** alle (default): every term; een: one of them; woordgroep: the whole query as one literal phrase. */
  match?: GehoordMatch;
  /** The vergaderdag, as the Kamer dates it. */
  date_from?: string;
  date_to?: string;
  kamer?: GehoordKamer;
  fractie?: string;
  /** A persoon-id (TK GUID or Eerste Kamer id) goes to Gehoord; a name or function is filtered here. */
  spreker?: string;
  /** One debate: Gehoord's debat_id or the TK debate id (tk_debat_id). */
  debat_id?: string | number;
  top: number;
  /** The API's offset; with a spreker name the position in the hits (filtered upstream) to scan from. */
  offset: number;
}

export interface GehoordSearchResult {
  items: GehoordContribution[];
  /** Hits upstream, with Gehoord's own filters (not the spreker name). */
  upstreamTotal: number | null;
  /** Whether a spreker name was filtered here. */
  filtered: boolean;
  /** Hits read upstream (filtered search only). */
  scanned: number;
  /** How the query was read: the API's query.terms, else the same rules applied here. */
  terms: GehoordQueryTerms;
  match: GehoordMatch;
  /** The fractie as Gehoord labels it: one label, or several for one fractie (each asked, merged; with a spreker name filtered here). */
  parties?: string[];
  /** Several labels merged and the page runs past the first 200 hits of a label: continue per label. */
  labelsCapped?: true;
  /** The offset to continue with, when there may be more. */
  nextOffset?: number;
  hasMore: boolean;
  endpoint: string;
  params: Record<string, string>;
}

export interface GehoordListArgs {
  kamer?: GehoordKamer;
  status?: GehoordStatus;
  date_from?: string;
  date_to?: string;
  top: number;
  offset: number;
}

export interface GehoordListResult {
  items: GehoordDebate[];
  total: number | null;
  hasMore: boolean;
  endpoint: string;
  params: Record<string, string>;
}

export interface GehoordDebateDetail {
  debate: GehoordDebate;
  speakers: GehoordSpeaker[];
  endpoint: string;
}

export interface GehoordContributionPage {
  debate?: GehoordDebate;
  items: GehoordContribution[];
  total: number | null;
  hasMore: boolean;
  endpoint: string;
}

export interface GehoordAroundResult {
  debate?: GehoordDebate;
  /** The window: up to `context` fragments before and after the segment, in debate order. */
  items: GehoordContribution[];
  /** Position of the segment in the debate (0-based), when found. */
  position?: number;
  /** Position in the debate of items[0] (0-based). */
  windowStart: number;
  found: boolean;
  /** Fragments read while looking. */
  scanned: number;
  total: number | null;
  /** True when the page cap ended the search before the end of the debate. */
  capped: boolean;
  endpoint: string;
}

/** Thrown for input the API cannot take; mapped to a clear error by mapGehoordError. */
export class GehoordInputError extends Error {
  constructor(message: string, public readonly suggestion?: string) {
    super(message);
    this.name = "GehoordInputError";
  }
}

/* ------------------------------------------------------------------ */
/*  Parsing                                                            */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function optString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s ? s : undefined;
}

function optNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function idOf(value: unknown): number | string {
  return typeof value === "number" ? value : String(value ?? "");
}

/** https://gehoord.de/beraadslagingen/{debateId}: the debate's transcript on gehoord.de. */
export function gehoordDebateUrl(debateId: number | string): string {
  return `${GEHOORD_SITE}/beraadslagingen/${encodeURIComponent(String(debateId))}`;
}

/** https://gehoord.de/beraadslagingen/{debateId}?segment={contributionId}: the debate scrolled to that fragment. */
export function gehoordFragmentUrl(debateId: number | string, contributionId: number | string): string {
  return `${gehoordDebateUrl(debateId)}?segment=${encodeURIComponent(String(contributionId))}`;
}

/** The debate object, as /debates gives it and every search hit embeds it; subtitlesCondensed stays undefined when absent. */
export function parseDebateRef(raw: unknown): GehoordDebateRef {
  const d = asRecord(raw);
  return {
    id: idOf(d.id),
    chamber: optString(d.chamber) ?? "",
    title: optString(d.title) ?? "",
    status: optString(d.status) ?? "",
    hall: optString(d.hall),
    locationId: optString(d.locationId),
    debateType: optString(d.debateType),
    startsAt: optString(d.startsAt),
    startedAt: optString(d.startedAt),
    endedAt: optString(d.endedAt),
    tkDebateId: optString(d.tkDebateId),
    tkActivityId: optString(d.tkActivityId),
    tkActivityNumber: optString(d.tkActivityNumber),
    subtitlesCondensed: typeof d.subtitlesCondensed === "boolean" ? d.subtitlesCondensed : undefined,
    contributionCount: optNumber(d.contributionCount),
    lastContributionAt: optString(d.lastContributionAt),
    url: optString(d.url),
  };
}

export function parseDebate(raw: unknown): GehoordDebate {
  const ref = parseDebateRef(raw);
  return { ...ref, subtitlesCondensed: ref.subtitlesCondensed === true, gehoordUrl: gehoordDebateUrl(ref.id) };
}

/** A contribution; `fallbackDebate` is the page's debate when the item carries none (/debates/{id}/contributions). */
export function parseContribution(raw: unknown, fallbackDebate?: GehoordDebateRef): GehoordContribution {
  const c = asRecord(raw);
  const embedded = c.debate && typeof c.debate === "object" ? parseDebateRef(c.debate) : undefined;
  const debate: GehoordDebateRef = embedded ?? fallbackDebate ?? { id: idOf(c.debateId), chamber: "", title: "", status: "" };
  const id = idOf(c.id);
  const debateId = c.debateId !== undefined && c.debateId !== null ? idOf(c.debateId) : debate.id;
  return {
    id,
    debateId,
    text: String(c.text ?? ""),
    persoonId: String(c.speakerLabel ?? ""),
    speakerName: optString(c.speakerName) ?? "Onbekende spreker",
    speakerParty: optString(c.speakerParty),
    speakerRole: optString(c.speakerRole),
    startMs: optNumber(c.startMs),
    endMs: optNumber(c.endMs),
    startTime: optString(c.startTime),
    endTime: optString(c.endTime),
    updatedAt: optString(c.updatedAt),
    debate,
    fragmentUrl: gehoordFragmentUrl(debateId, id),
  };
}

export function parseSpeaker(raw: unknown): GehoordSpeaker {
  const s = asRecord(raw);
  return {
    persoonId: String(s.speakerLabel ?? ""),
    name: optString(s.name) ?? "Onbekende spreker",
    party: optString(s.party),
    role: optString(s.role),
    politicianId: optString(s.politicianId),
    source: optString(s.source),
  };
}

function parsePagination(raw: unknown): { total: number | null; hasMore: boolean | undefined } {
  const p = asRecord(raw);
  const total = optNumber(p.total);
  return { total: total ?? null, hasMore: typeof p.hasMore === "boolean" ? p.hasMore : undefined };
}

/* ------------------------------------------------------------------ */
/*  Filters, persons and query terms                                   */
/* ------------------------------------------------------------------ */

/** Lower case, no accents, letters and digits only: "GroenLinks-PvdA" → "groenlinkspvda". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Words, lower case, without accents: "Van der Plas" → ["van", "der", "plas"]. */
function words(s: string): string[] {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * The labels Gehoord files a fractie under, per kamer (exact, case-insensitive;
 * 'GroenLinks-PvdA' itself finds nothing). Verified 4 Nov 2026: GroenLinks-PvdA
 * is 'GL-PvdA' up to late September 2026 and 'PRO' since, one fractie under two
 * labels (in the Eerste Kamer only 'PRO'); the ChristenUnie is 'CU' in the
 * Tweede Kamer and 'ChristenUnie' in the Eerste Kamer.
 */
const GL_PRO = { tk: ["GL-PvdA", "PRO"], ek: ["PRO"] };
const CU = { tk: ["CU"], ek: ["ChristenUnie"] };
const PARTY_LABELS: Record<string, { tk: string[]; ek: string[] }> = {
  groenlinkspvda: GL_PRO,
  glpvda: GL_PRO,
  gl: GL_PRO,
  pro: GL_PRO,
  christenunie: CU,
  cu: CU,
  partijvoordedieren: { tk: ["PvdD"], ek: ["PvdD"] },
};

/**
 * The party labels for Gehoord's party filter: a known fractie mapped to every
 * label it has in that kamer (both kamers without one), anything else as given.
 */
export function gehoordParties(fractie: string, kamer?: GehoordKamer): string[] {
  const f = fractie.trim();
  const known = PARTY_LABELS[fold(f)];
  if (!known) return f ? [f] : [];
  return kamer ? [...known[kamer]] : [...new Set([...known.tk, ...known.ek])];
}

const TK_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The Eerste Kamer's own person id, as eerstekamer.nl/id/<id> uses it: 'vkyyicefojzk'. */
const EK_ID_RE = /^v[a-z0-9]{11}$/;

/** A TK Persoon GUID. */
export function isTkPersoonId(id: string): boolean {
  return TK_GUID_RE.test(id.trim());
}

/** A persoon-id Gehoord can filter on (speaker): a TK Persoon GUID or an Eerste Kamer id. */
export function isGehoordPersoonId(id: string): boolean {
  const s = id.trim();
  return TK_GUID_RE.test(s) || EK_ID_RE.test(s);
}

/** The person's page at the Eerste Kamer for an Eerste Kamer id (a TK GUID has none there). */
export function gehoordPersoonUrl(persoonId: string | undefined): string | undefined {
  const s = persoonId?.trim() ?? "";
  return EK_ID_RE.test(s) ? `https://www.eerstekamer.nl/id/${s}` : undefined;
}

/** Whether every word of `spreker` is a word of the speaker's name or role: "Klaver", "van Weel", "minister". */
export function matchesSpreker(c: Pick<GehoordContribution, "speakerName" | "speakerRole">, spreker: string): boolean {
  const wanted = words(spreker);
  if (!wanted.length) return true;
  const have = new Set([...words(c.speakerName), ...words(c.speakerRole ?? "")]);
  return wanted.every((w) => have.has(w));
}

/**
 * How Gehoord reads a query, for when the answer does not echo it: woordgroep
 * is the whole query as one phrase; otherwise a "quoted phrase" is one term,
 * -word excludes it, and every other word is a term.
 */
export function gehoordQueryTerms(query: string, match: GehoordMatch = "alle"): GehoordQueryTerms {
  const q = query.trim();
  if (match === "woordgroep") return { include: q ? [q] : [], exclude: [] };
  const include: string[] = [];
  const exclude: string[] = [];
  for (const m of q.matchAll(/(-?)"([^"]*)"|(\S+)/g)) {
    const quoted = m[2] !== undefined;
    let term = (quoted ? m[2] : m[3] ?? "").trim();
    let negative = quoted && m[1] === "-";
    if (!quoted && term.length > 1 && term.startsWith("-")) {
      negative = true;
      term = term.slice(1);
    }
    term = quoted ? term : term.replace(/"/g, "");
    if (term) (negative ? exclude : include).push(term);
  }
  return { include, exclude };
}

function parseTerms(raw: unknown): GehoordQueryTerms | undefined {
  const t = asRecord(asRecord(raw).terms);
  if (!Array.isArray(t.include)) return undefined;
  const list = (v: unknown) => asArray(v).map((x) => String(x ?? "").trim()).filter(Boolean);
  return { include: list(t.include), exclude: list(t.exclude) };
}

/**
 * The window of `context` fragments before and after the one with id
 * `segmentId`, from fragments in debate order. Undefined when it is not there.
 */
export function contextWindow<T extends { id: number | string }>(
  items: T[],
  segmentId: number | string,
  context: number,
): { items: T[]; position: number; windowStart: number } | undefined {
  const position = items.findIndex((c) => String(c.id) === String(segmentId));
  if (position < 0) return undefined;
  const windowStart = Math.max(0, position - context);
  return { items: items.slice(windowStart, position + context + 1), position, windowStart };
}

/* ------------------------------------------------------------------ */
/*  Source                                                             */
/* ------------------------------------------------------------------ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function checkDate(name: string, value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!DATE_RE.test(value)) throw new GehoordInputError(`${name} '${value}' is geen datum JJJJ-MM-DD.`, `Geef ${name} als JJJJ-MM-DD, bijv. 2026-10-01.`);
  return value;
}

function checkId(name: string, value: string | number): string {
  const s = String(value).trim();
  if (!ID_RE.test(s)) throw new GehoordInputError(`${name} '${s}' is geen geldig Gehoord-id.`, "Neem het id over uit gehoord_debatten_list of gehoord_debatten_search (debat_id / fragment_id).");
  return s;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export class GehoordSource {
  constructor(
    private readonly config: AppConfig,
    private readonly apiKey: string,
  ) {}

  private async get(path: string, query?: Record<string, string | number | undefined>, opts: { retries?: number } = {}): Promise<{ data: unknown; url: string }> {
    // Gehoord answers an unknown parameter with HTTP 400: never send one.
    const known: readonly string[] = path === "/contributions"
      ? GEHOORD_PARAMS.contributions
      : path === "/debates"
        ? GEHOORD_PARAMS.debates
        : path.endsWith("/contributions")
          ? GEHOORD_PARAMS.debateContributions
          : GEHOORD_PARAMS.debate;
    const unknown = Object.entries(query ?? {}).filter(([k, v]) => v !== undefined && !known.includes(k)).map(([k]) => k);
    if (unknown.length) throw new Error(`Gehoord ${path} kent de parameter(s) ${unknown.join(", ")} niet`);
    const { data, meta } = await getJson<unknown>(`${GEHOORD_BASE}${path}`, {
      query,
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      connector: GEHOORD_CONNECTOR,
      timeoutMs: TIMEOUT_MS,
      ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
    });
    return { data, url: meta.url };
  }

  /**
   * Full-text search over the contributions, newest first. Gehoord applies
   * match, the dates, kamer, fractie, a spreker persoon-id and debat_id: one
   * request with the API's own offset. A spreker name Gehoord cannot filter:
   * then pages of 200 from `offset` on, at most GEHOORD_SPREKER_MAX_PAGES,
   * filtered here by name or function, until `top` fragments match.
   */
  async search(args: GehoordSearchArgs): Promise<GehoordSearchResult> {
    const query = args.query.trim();
    if (!query) throw new GehoordInputError("query is leeg.", "Geef een of meer trefwoorden, bijv. 'stikstof' of 'stikstof provincie', of een \"woordgroep\" tussen aanhalingstekens.");
    const from = checkDate("date_from", args.date_from);
    const to = checkDate("date_to", args.date_to);
    const top = clamp(args.top, 1, GEHOORD_MAX_LIMIT);
    const offset = Math.max(0, Math.trunc(args.offset));
    const match: GehoordMatch = args.match ?? "alle";
    const spreker = args.spreker?.trim() || undefined;
    const speaker = spreker && isGehoordPersoonId(spreker) ? spreker : undefined;
    const sprekerNaam = spreker && !speaker ? spreker : undefined;
    const parties = args.fractie?.trim() ? gehoordParties(args.fractie, args.kamer) : [];
    // One fractie under several labels: with a spreker name filtered here with it, else one request per label, merged.
    const party = parties.length === 1 ? parties[0] : undefined;
    const debateId = args.debat_id !== undefined && String(args.debat_id).trim() !== "" ? checkId("debat_id", args.debat_id) : undefined;
    const upstream = { q: query, match: MATCH_API[match], from, to, chamber: args.kamer, party, speaker, debateId };
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(upstream)) if (v !== undefined) params[k] = String(v);
    if (parties.length > 1) params.party = parties.join(" + ");
    if (sprekerNaam) params.spreker = `${sprekerNaam} (hier gefilterd op naam of functie)`;
    const read = (body: Record<string, unknown>) => parseTerms(body.query) ?? gehoordQueryTerms(query, match);
    const labelled = parties.length ? { parties } : {};

    if (!sprekerNaam && parties.length > 1) {
      // Each label from the start, enough for this page; merged newest first. A label with more hits
      // than read has its unread ones after its last hit read: only the merged hits up to there are in place.
      const per = Math.min(GEHOORD_MAX_LIMIT, offset + top);
      const pages = await Promise.all(parties.map(async (p) => {
        const { data, url } = await this.get("/contributions", { ...upstream, party: p, limit: per, offset: 0 });
        const body = asRecord(data);
        return { url, body, items: asArray(body.data).map((c) => parseContribution(c)), page: parsePagination(body.pagination) };
      }));
      const time = (c: GehoordContribution) => Date.parse(c.startTime ?? "") || 0;
      const merged = pages.flatMap((p) => p.items).sort((a, b) => time(b) - time(a));
      let cutoff = -Infinity;
      for (const p of pages) {
        const more = p.page.hasMore ?? (p.page.total !== null ? p.items.length < p.page.total : p.items.length >= per);
        if (more && p.items.length) cutoff = Math.max(cutoff, time(p.items[p.items.length - 1]));
      }
      const inPlace = merged.filter((c) => time(c) >= cutoff);
      const items = inPlace.slice(offset, offset + top);
      const totals = pages.map((p) => p.page.total);
      const upstreamTotal = totals.every((t) => t !== null) ? totals.reduce<number>((a, t) => a + (t ?? 0), 0) : null;
      const reached = offset + items.length;
      const more = upstreamTotal !== null ? reached < upstreamTotal : merged.length > reached;
      // Past what the labels give merged (200 each from the start): only per label from there.
      const labelsCapped = more && per === GEHOORD_MAX_LIMIT && inPlace.length <= offset + top;
      return {
        items,
        upstreamTotal,
        filtered: false,
        scanned: items.length,
        terms: read(pages[0].body),
        match,
        parties,
        nextOffset: more && !labelsCapped ? reached : undefined,
        hasMore: more,
        ...(labelsCapped ? { labelsCapped: true as const } : {}),
        endpoint: pages[0].url,
        params: { ...params, limit: String(top), offset: String(offset) },
      };
    }

    if (!sprekerNaam) {
      const { data, url } = await this.get("/contributions", { ...upstream, limit: top, offset });
      const body = asRecord(data);
      const items = asArray(body.data).map((c) => parseContribution(c));
      const page = parsePagination(body.pagination);
      const hasMore = page.hasMore ?? (page.total !== null ? offset + items.length < page.total : items.length >= top);
      return {
        items,
        upstreamTotal: page.total,
        filtered: false,
        scanned: items.length,
        terms: read(body),
        match,
        ...labelled,
        nextOffset: hasMore ? offset + items.length : undefined,
        hasMore,
        endpoint: url,
        params: { ...params, limit: String(top), offset: String(offset) },
      };
    }

    // Several labels: Gehoord gets none of them, the fractie is filtered here with the name.
    const wanted = new Set(parties.length > 1 ? parties.map((p) => p.toLowerCase()) : []);
    const inParties = (c: GehoordContribution) => !wanted.size || wanted.has((c.speakerParty ?? "").toLowerCase());
    const matches: Array<{ item: GehoordContribution; position: number }> = [];
    let position = offset;
    let upstreamTotal: number | null = null;
    let upstreamMore = true;
    let endpoint = "";
    let terms: GehoordQueryTerms | undefined;
    for (let page = 0; page < GEHOORD_SPREKER_MAX_PAGES && upstreamMore && matches.length < top; page += 1) {
      const { data, url } = await this.get("/contributions", { ...upstream, limit: GEHOORD_MAX_LIMIT, offset: position });
      if (!endpoint) endpoint = url;
      const body = asRecord(data);
      terms ??= read(body);
      const raw = asArray(body.data);
      const meta = parsePagination(body.pagination);
      upstreamTotal = meta.total ?? upstreamTotal;
      raw.forEach((c, i) => {
        const item = parseContribution(c);
        if (matchesSpreker(item, sprekerNaam) && inParties(item)) matches.push({ item, position: position + i });
      });
      position += raw.length;
      upstreamMore = raw.length > 0 && (meta.hasMore ?? (upstreamTotal !== null ? position < upstreamTotal : raw.length >= GEHOORD_MAX_LIMIT));
    }
    const shown = matches.slice(0, top);
    // More matches than shown: go on right after the last one shown; else after the last hit read.
    const nextOffset = matches.length > top ? shown[shown.length - 1].position + 1 : upstreamMore ? position : undefined;
    return {
      items: shown.map((m) => m.item),
      upstreamTotal,
      filtered: true,
      scanned: position - offset,
      terms: terms ?? gehoordQueryTerms(query, match),
      match,
      ...labelled,
      nextOffset,
      hasMore: nextOffset !== undefined,
      endpoint,
      params: { ...params, offset: String(offset) },
    };
  }

  /** Debates, newest first: by kamer, status (live, ended, scheduled, cancelled) and vergaderdag. */
  async listDebates(args: GehoordListArgs): Promise<GehoordListResult> {
    const from = checkDate("date_from", args.date_from);
    const to = checkDate("date_to", args.date_to);
    const top = clamp(args.top, 1, GEHOORD_MAX_LIMIT);
    const offset = Math.max(0, Math.trunc(args.offset));
    const query = { chamber: args.kamer, status: args.status, from, to, limit: top, offset };
    const { data, url } = await this.get("/debates", query);
    const body = asRecord(data);
    const items = asArray(body.data).map(parseDebate);
    const page = parsePagination(body.pagination);
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params[k] = String(v);
    return {
      items,
      total: page.total,
      hasMore: page.hasMore ?? (page.total !== null ? offset + items.length < page.total : items.length >= top),
      endpoint: url,
      params,
    };
  }

  /** One debate with its speakers; `retries` as the shared http helper takes it. */
  async getDebate(debateId: string | number, opts: { retries?: number } = {}): Promise<GehoordDebateDetail> {
    const id = checkId("debate_id", debateId);
    const { data, url } = await this.get(`/debates/${encodeURIComponent(id)}`, undefined, opts);
    const body = asRecord(data);
    // The API wraps the debate in `data`; accept a bare object too.
    const raw = body.data && typeof body.data === "object" ? asRecord(body.data) : body;
    return { debate: parseDebate(raw), speakers: asArray(raw.speakers).map(parseSpeaker), endpoint: url };
  }

  /** A page of a debate's contributions, in debate order. */
  async getContributions(debateId: string | number, page: { limit: number; offset: number }): Promise<GehoordContributionPage> {
    const id = checkId("debate_id", debateId);
    const limit = clamp(page.limit, 1, GEHOORD_MAX_LIMIT);
    const offset = Math.max(0, Math.trunc(page.offset));
    const { data, url } = await this.get(`/debates/${encodeURIComponent(id)}/contributions`, { limit, offset });
    const body = asRecord(data);
    const debate = body.debate && typeof body.debate === "object" ? parseDebate(body.debate) : undefined;
    const items = asArray(body.data).map((c) => parseContribution(c, debate));
    const meta = parsePagination(body.pagination);
    return {
      debate,
      items,
      total: meta.total,
      hasMore: meta.hasMore ?? (meta.total !== null ? offset + items.length < meta.total : items.length >= limit),
      endpoint: url,
    };
  }

  /**
   * The `context` fragments before and after fragment `segmentId` in its
   * debate. The API cannot look a fragment up, so this pages through the
   * debate (200 at a time, at most GEHOORD_SEGMENT_MAX_PAGES pages) and reads
   * one page more when the window runs past the page the fragment is on.
   */
  async getContributionsAround(debateId: string | number, segmentId: string | number, context = GEHOORD_DEFAULT_CONTEXT): Promise<GehoordAroundResult> {
    const segment = checkId("segment_id", segmentId);
    const ctx = clamp(context, 0, GEHOORD_MAX_CONTEXT);
    const all: GehoordContribution[] = [];
    let debate: GehoordDebate | undefined;
    let total: number | null = null;
    let hasMore = true;
    let endpoint = "";
    let pages = 0;
    let window: ReturnType<typeof contextWindow<GehoordContribution>>;
    while (hasMore && pages < GEHOORD_SEGMENT_MAX_PAGES) {
      const page = await this.getContributions(debateId, { limit: GEHOORD_MAX_LIMIT, offset: all.length });
      pages += 1;
      if (!endpoint) endpoint = page.endpoint;
      debate = debate ?? page.debate;
      total = page.total ?? total;
      all.push(...page.items);
      hasMore = page.hasMore && page.items.length > 0;
      window = contextWindow(all, segment, ctx);
      if (window) {
        // The window runs past what was read: one page more, if there is one.
        if (window.position + ctx >= all.length && hasMore) {
          const next = await this.getContributions(debateId, { limit: GEHOORD_MAX_LIMIT, offset: all.length });
          all.push(...next.items);
          window = contextWindow(all, segment, ctx);
        }
        break;
      }
    }
    if (window) {
      return { debate, items: window.items, position: window.position, windowStart: window.windowStart, found: true, scanned: all.length, total, capped: false, endpoint };
    }
    return { debate, items: [], windowStart: 0, found: false, scanned: all.length, total, capped: hasMore, endpoint };
  }
}

/* ------------------------------------------------------------------ */
/*  Errors                                                             */
/* ------------------------------------------------------------------ */

/** The not_configured answer without GEHOORD_KEY. */
export function gehoordMissingKey(): MCPErrorResponse {
  return errorResponse({
    error: "not_configured",
    message: "GEHOORD_KEY ontbreekt",
    suggestion:
      "Gehoord.de geeft API-sleutels op aanvraag via de maker (Jeroen Wollaars, https://gehoord.de); zet de sleutel als GEHOORD_KEY (gaat mee als 'Authorization: Bearer <sleutel>'). Zonder sleutel: tweede_kamer_debatten (officiële verslagen van de Tweede Kamer) of officiele_bekendmakingen_search (type Handelingen).",
  });
}

/** 401 → not_configured (the key is refused), 404 → not found, input → a clear message; the rest as every source. */
export function mapGehoordError(error: unknown, what = "Gehoord.de"): MCPErrorResponse {
  if (error instanceof GehoordInputError) {
    return errorResponse({ error: "unexpected", message: error.message, suggestion: error.suggestion });
  }
  if (error instanceof SourceRequestError && (error.status === 401 || error.status === 403)) {
    return errorResponse({
      error: "not_configured",
      message: `Gehoord.de weigerde de API-sleutel (HTTP ${error.status})`,
      suggestion: "Controleer GEHOORD_KEY: alleen de sleutel zelf, zonder 'Bearer'. Een nieuwe sleutel vraag je aan bij de maker van Gehoord.de.",
      details: { status: error.status },
    });
  }
  if (error instanceof SourceRequestError && error.status === 404) {
    return errorResponse({
      error: "http_error",
      message: `${what} niet gevonden bij Gehoord.de (HTTP 404)`,
      suggestion: "Neem het debat_id over uit gehoord_debatten_list of gehoord_debatten_search.",
      details: { endpoint: error.endpoint, status: 404 },
    });
  }
  return mapSourceError(error, "Gehoord.de", GEHOORD_SITE);
}

/* ------------------------------------------------------------------ */
/*  Records, summaries and notes (shared by the tools and nl_gov_ask)  */
/* ------------------------------------------------------------------ */

export const KAMER_LABEL: Record<string, string> = { tk: "Tweede Kamer", ek: "Eerste Kamer" };

/** The provider's caveats, short: automatic, not for quoting. */
export const GEHOORD_BASE_NOTE =
  "Bron: Gehoord.de (Jeroen Wollaars), een automatische transcriptie (spraak-naar-tekst) van de openbare video-uitzendingen van Tweede en Eerste Kamer, sinds 31 maart 2026; geen officiële overheidsbron en niet door mensen gecorrigeerd. Geschikt om te vinden, niet om te citeren: citeer uit de Handelingen (officiele_bekendmakingen_search, type Handelingen) of de verslagen (tweede_kamer_debatten).";
/** The provider's caveat when the hits carry official text too: it is about the transcript. */
export const GEHOORD_INDEX_NOTE =
  "Gevonden via Gehoord.de (Jeroen Wollaars), een automatische transcriptie (spraak-naar-tekst) van de openbare video-uitzendingen van Tweede en Eerste Kamer; geen officiële overheidsbron en niet door mensen gecorrigeerd. Die transcriptie (data.gehoord_tekst, en data.tekst van records met source_name 'gehoord') is geschikt om te vinden, niet om te citeren: citeer uit de Handelingen (officiele_bekendmakingen_search, type Handelingen) of de verslagen (tweede_kamer_debatten).";
/** Where the links of a fragment record go. */
export const GEHOORD_LINK_NOTE =
  "De link (fragment_url) opent het debat op gehoord.de bij dat fragment; klik op de tekst om de video vanaf dat moment af te spelen (daarvoor is een gratis gehoord.de-account nodig). debat_url is de officiële Kamerpagina.";
export const GEHOORD_LIVE_NOTE =
  "Debat nog live: sprekers en fragmentgrenzen kunnen nog veranderen; de definitieve versie verschijnt na afloop van het debat.";
export const GEHOORD_CONDENSED_NOTE =
  "Bij vragenuur en grote debatten typt soms een mens de ondertiteling; die is samengevat en dus niet letterlijk (subtitlesCondensed; per record data.ondertiteling_samengevat).";
export const GEHOORD_EK_NOTE =
  "Tekst uit de Eerste Kamer heeft geen hoofdletters en geen leestekens. Een senator heeft als persoon_id het vaste persoons-id van de Eerste Kamer zelf (data.persoon_url: eerstekamer.nl/id/...); ook een bewindspersoon of initiatiefnemer heeft daar meestal zo'n Eerste Kamer-id, en maar soms zijn persoon-id van de Tweede Kamer: zoek een spreker in de Eerste Kamer met de persoon_id uit een Eerste Kamer-treffer, of op naam.";
export const GEHOORD_CANCELLED_NOTE =
  "Status 'cancelled' (geschrapt): het debat stond op de agenda van Debat Direct maar is niet doorgegaan; het heeft geen transcriptie en krijgt geen verslag.";

/** Dutch labels of the debate statuses. */
export const GEHOORD_STATUS_LABEL: Record<string, string> = { live: "live", ended: "afgelopen", scheduled: "gepland", cancelled: "geschrapt", error: "fout bij Gehoord" };

/** "Wim Meulenkamp (VVD)", "Sophie Hermans (Minister van VWS)". */
export function gehoordSpeakerLabel(c: Pick<GehoordContribution, "speakerName" | "speakerParty" | "speakerRole">): string {
  const role = c.speakerParty ?? (c.speakerRole && !/^(?:tweede|eerste) kamerlid$/i.test(c.speakerRole) ? c.speakerRole : undefined);
  return role ? `${c.speakerName} (${role})` : c.speakerName;
}

/**
 * About `size` characters around the first place one of the search terms
 * occurs (as Gehoord matches them: case and accents ignored, a term of more
 * than 4 characters inside a compound too), else the start. A string is one
 * phrase; excluded terms are not passed.
 */
export function gehoordSnippet(text: string, terms: string | string[] | undefined, size = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= size) return clean;
  const at = termsPosition(clean, terms);
  if (at < 0) return `${clean.slice(0, size).replace(/\s+\S*$/, "")} …`;
  const start = Math.max(0, at - Math.floor(size / 3));
  const end = Math.min(clean.length, start + size);
  const head = start > 0 ? `… ${clean.slice(start, end).replace(/^\S*\s+/, "")}` : clean.slice(0, end);
  return end < clean.length ? `${head.replace(/\s+\S*$/, "")} …` : head;
}

function cut(text: string, maxChars: number): { tekst?: string; ingekort?: true } {
  if (maxChars <= 0) return {};
  if (text.length <= maxChars) return { tekst: text };
  return { tekst: `${text.slice(0, maxChars).replace(/\s+\S*$/, "")} …`, ingekort: true };
}

/** A contribution as the Gehoord tools show it: linked to its fragment, the official page in data.debat_url. */
export function gehoordContributionRecord(c: GehoordContribution, opts: { query?: string | string[]; maxChars: number; segmentId?: string | number; position?: number }): MCPRecord {
  const text = cut(c.text, opts.maxChars);
  const kamer = c.debate.chamber;
  return {
    source_name: "gehoord",
    title: `${gehoordSpeakerLabel(c)}: ${c.debate.title || `debat ${c.debate.id}`}`,
    canonical_url: c.fragmentUrl,
    date: c.startTime,
    snippet: gehoordSnippet(c.text, opts.query),
    data: {
      fragment_id: c.id,
      debat_id: c.debate.id,
      kamer,
      kamer_naam: KAMER_LABEL[kamer] ?? kamer,
      debat: c.debate.title,
      debat_soort: c.debate.debateType ?? null,
      debat_status: c.debate.status,
      zaal: c.debate.hall ?? null,
      debat_start: c.debate.startsAt ?? null,
      debat_gestart: c.debate.startedAt ?? null,
      ondertiteling_samengevat: c.debate.subtitlesCondensed ?? null,
      tk_debat_id: c.debate.tkDebateId ?? null,
      persoon_id: c.persoonId,
      persoon_url: gehoordPersoonUrl(c.persoonId),
      spreker: c.speakerName,
      fractie: c.speakerParty ?? null,
      functie: c.speakerRole ?? null,
      start_time: c.startTime ?? null,
      end_time: c.endTime ?? null,
      start_ms: c.startMs ?? null,
      end_ms: c.endMs ?? null,
      bijgewerkt: c.updatedAt ?? null,
      positie: opts.position,
      is_segment: opts.segmentId !== undefined ? String(c.id) === String(opts.segmentId) : undefined,
      tekst: text.tekst,
      tekst_lengte: c.text.length,
      tekst_ingekort: text.ingekort,
      fragment_url: c.fragmentUrl,
      debat_url: c.debate.url ?? null,
      bron: "Gehoord.de (automatische transcriptie)",
    },
  };
}

/** A debate as gehoord_debatten_list shows it: linked to the official Kamer page (gehoord.de when there is none). */
export function gehoordDebateRecord(d: GehoordDebate, speakers?: GehoordSpeaker[]): MCPRecord {
  const meta = [
    KAMER_LABEL[d.chamber] ?? d.chamber,
    d.debateType,
    GEHOORD_STATUS_LABEL[d.status] ?? d.status,
    d.hall,
    d.contributionCount !== undefined ? `${d.contributionCount} fragmenten` : undefined,
    d.subtitlesCondensed ? "samengevatte ondertiteling (niet letterlijk)" : undefined,
  ].filter(Boolean).join(" · ");
  return {
    source_name: "gehoord",
    title: d.title || `Debat ${d.id}`,
    canonical_url: d.url ?? d.gehoordUrl,
    date: d.startedAt ?? d.startsAt,
    snippet: meta,
    data: {
      debat_id: d.id,
      kamer: d.chamber,
      kamer_naam: KAMER_LABEL[d.chamber] ?? d.chamber,
      debat: d.title,
      debat_soort: d.debateType ?? null,
      debat_status: d.status,
      zaal: d.hall ?? null,
      gepland: d.startsAt ?? null,
      gestart: d.startedAt ?? null,
      beeindigd: d.endedAt ?? null,
      aantal_fragmenten: d.contributionCount ?? null,
      laatste_fragment: d.lastContributionAt ?? null,
      ondertiteling_samengevat: d.subtitlesCondensed,
      tk_debat_id: d.tkDebateId ?? null,
      tk_activiteit_id: d.tkActivityId ?? null,
      tk_activiteit_nummer: d.tkActivityNumber ?? null,
      debat_url: d.url ?? null,
      gehoord_url: d.gehoordUrl,
      sprekers: speakers?.map((s) => ({ persoon_id: s.persoonId, persoon_url: gehoordPersoonUrl(s.persoonId), naam: s.name, fractie: s.party ?? null, functie: s.role ?? null })),
      bron: "Gehoord.de (automatische transcriptie)",
    },
  };
}

/**
 * The caveats that apply to what was shown: live, condensed (per debate, as
 * every hit carries it), cancelled, Eerste Kamer. Only a debate that does not
 * say whether its subtitles are condensed gets the general warning.
 */
export function gehoordCaveats(debates: Array<{ status?: string; chamber?: string; subtitlesCondensed?: boolean }>): string[] {
  const notes: string[] = [];
  if (debates.some((d) => d.status === "live")) notes.push(GEHOORD_LIVE_NOTE);
  if (debates.some((d) => d.subtitlesCondensed === true)) notes.push(GEHOORD_CONDENSED_NOTE);
  else if (debates.some((d) => d.subtitlesCondensed === undefined)) notes.push(`${GEHOORD_CONDENSED_NOTE.replace(/ \(subtitlesCondensed;.*$/, "")}; gehoord_debat_get toont per debat of dat zo is.`);
  if (debates.some((d) => d.status === "cancelled")) notes.push(GEHOORD_CANCELLED_NOTE);
  if (debates.some((d) => d.chamber === "ek")) notes.push(GEHOORD_EK_NOTE);
  return notes;
}

/** The order of a "what is debated (today)" list: running first, then finished, then planned; cancelled not shown. */
const TODAY_ORDER: Record<string, number> = { live: 0, ended: 1, scheduled: 2, error: 3 };

/**
 * A list of debates without a status filter, for "wat wordt er vandaag
 * besproken": Gehoord sorts newest id first, so the planned debates come
 * before the ones that ran. This puts live and ended first, then scheduled,
 * leaves out cancelled ones, keeps `top`, and counts per status.
 */
export function gehoordDebatesByStatus(records: MCPRecord[], top: number): { records: MCPRecord[]; shown: number; total: number; counts: string } {
  const status = (r: MCPRecord) => String((r.data as Record<string, unknown> | undefined)?.debat_status ?? "");
  const count = new Map<string, number>();
  for (const r of records) count.set(status(r), (count.get(status(r)) ?? 0) + 1);
  const held = records
    .map((r, i) => ({ r, i, rank: TODAY_ORDER[status(r)] ?? 3 }))
    .filter((x) => status(x.r) !== "cancelled")
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.r);
  const counts = ["live", "ended", "scheduled", "error", "cancelled"]
    .filter((s) => count.get(s))
    .map((s) => `${count.get(s)} ${GEHOORD_STATUS_LABEL[s] ?? s}${s === "cancelled" ? " (niet getoond)" : ""}`)
    .join(", ");
  const shown = held.slice(0, top);
  return { records: shown, shown: shown.length, total: held.length, counts };
}

/** "alle woorden 'stikstof' EN 'provincie' (in elke volgorde), zonder 'pallas'". */
export function describeGehoordTerms(terms: GehoordQueryTerms, match: GehoordMatch): string {
  const q = (t: string) => `'${t}'`;
  const without = terms.exclude.length ? `, zonder ${terms.exclude.map(q).join(" of ")}` : "";
  if (match === "woordgroep" || terms.include.length <= 1) {
    const one = terms.include[0] ?? "";
    return `${/\s/.test(one) ? "de letterlijke woordgroep" : "het woord"} ${q(one)}${without}`;
  }
  return match === "een"
    ? `een van de woorden ${terms.include.map(q).join(" OF ")}${without}`
    : `alle woorden ${terms.include.map(q).join(" EN ")} (in elke volgorde)${without}`;
}

/** "12 fragmenten in 4 debatten (van 431 treffers); meest aan het woord: …" */
export function summarizeGehoordSearch(out: GehoordSearchResult, query: string): string {
  const n = out.items.length;
  const of = out.upstreamTotal !== null ? ` van ${out.upstreamTotal} treffers` : "";
  if (!n) {
    return out.filtered
      ? `Geen fragmenten met '${query}' die aan de filters voldoen (${out.scanned}${of} doorzocht)`
      : `Geen fragmenten met '${query}' gevonden bij Gehoord.de`;
  }
  const debates = new Set(out.items.map((c) => String(c.debate.id))).size;
  const bySpeaker = new Map<string, number>();
  for (const c of out.items) bySpeaker.set(gehoordSpeakerLabel(c), (bySpeaker.get(gehoordSpeakerLabel(c)) ?? 0) + 1);
  const top = [...bySpeaker].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, count]) => `${label} ${count}`);
  const scope = out.filtered ? ` (${out.scanned}${of} doorzocht)` : of ? ` (${of.trim()})` : "";
  return `${n} fragment${n === 1 ? "" : "en"} in ${debates} debat${debates === 1 ? "" : "ten"}${scope}; meest aan het woord: ${top.join(", ")}`;
}

export function gehoordSearchNotes(out: GehoordSearchResult, args: Pick<GehoordSearchArgs, "query" | "kamer" | "fractie" | "spreker" | "debat_id" | "date_from" | "date_to" | "offset">): string[] {
  const notes: string[] = [GEHOORD_BASE_NOTE, GEHOORD_LINK_NOTE];
  notes.push(
    `Gezocht op ${describeGehoordTerms(out.terms, out.match)} (match '${out.match}'; hoofdletterongevoelig, een woord van 4 tekens of minder alleen als heel woord, een langer ook in een samenstelling), nieuwste eerst.`,
  );
  const upstream = [
    args.kamer ? `kamer ${args.kamer}` : "",
    out.parties?.length === 1 ? `fractie '${out.parties[0]}'` : "",
    args.spreker?.trim() && !out.filtered ? `spreker (persoon_id) ${args.spreker.trim()}` : "",
    args.debat_id !== undefined && String(args.debat_id).trim() ? `debat ${String(args.debat_id).trim()}` : "",
    args.date_from || args.date_to ? `vergaderdag ${args.date_from ?? "…"} t/m ${args.date_to ?? "…"} (zoals de Kamer dateert: een nachtzitting valt onder de dag waarop hij begon)` : "",
  ].filter(Boolean);
  if (upstream.length) notes.push(`Gehoord.de filtert zelf op ${upstream.join(", ")}.`);
  if (out.parties && out.parties.length > 1) {
    const labels = out.parties.map((p) => `'${p}'`).join(" en ");
    const why = out.parties.includes("PRO") ? "GL-PvdA heet sinds eind september 2026 'PRO'" : "'CU' in de Tweede Kamer, 'ChristenUnie' in de Eerste Kamer";
    notes.push(
      out.filtered
        ? `Fractie '${args.fractie?.trim()}' heet bij Gehoord.de ${labels} (${why}): hier gefilterd, samen met de spreker.`
        : `Fractie '${args.fractie?.trim()}' heet bij Gehoord.de ${labels} (${why}): elk label apart gevraagd en samengevoegd, nieuwste eerst; het totaal telt beide.` +
          (out.labelsCapped ? ` Verder bladeren gaat hier niet voorbij de eerste ${GEHOORD_MAX_LIMIT} treffers per label: zoek dan per label (fractie ${labels.replace(" en ", " of ")}) met offset.` : ""),
    );
  }
  if (out.filtered) {
    const range = out.scanned ? `treffer ${args.offset + 1} t/m ${args.offset + out.scanned}` : "geen treffers";
    notes.push(
      `Gehoord.de filtert alleen op een persoon-id, niet op een naam: spreker '${args.spreker?.trim()}' is hier toegepast op naam en functie, op ${range}${out.upstreamTotal !== null ? ` van ${out.upstreamTotal}` : ""} (nieuwste eerst, hooguit ${GEHOORD_SPREKER_MAX_PAGES * GEHOORD_MAX_LIMIT} per aanroep).` +
        (out.nextOffset !== undefined ? ` Zoek verder met offset=${out.nextOffset}, of geef als spreker de persoon_id uit een treffer (data.persoon_id): dan filtert Gehoord.de zelf, zonder grens.` : ""),
    );
  } else if (out.nextOffset !== undefined) {
    notes.push(`Meer fragmenten: offset=${out.nextOffset}.`);
  }
  notes.push(...gehoordCaveats(out.items.map((c) => c.debate)));
  if (!out.items.length) {
    const tips: string[] = [];
    if (out.match === "woordgroep" && /\s/.test(args.query.trim())) tips.push("zoek met match 'alle' (alle woorden, in elke volgorde) of 'een'");
    else if (out.terms.include.length > 1 && out.match === "alle") tips.push("zoek met minder woorden of met match 'een' (een van de woorden)");
    if (out.parties?.length) tips.push(`fractie gaat als exact partijlabel naar Gehoord.de (hoofdletterongevoelig: 'VVD', 'PRO' of eerder 'GL-PvdA', 'CU' en in de Eerste Kamer 'ChristenUnie', 'PvdD'; in de Eerste Kamer soms 'Fractie-<naam>'); '${out.parties.join("' of '")}' kan anders heten`);
    notes.push(
      `Niets gevonden${tips.length ? `: ${tips.join("; ")}` : ""}. Gehoord.de begint op ${GEHOORD_SINCE}; voor eerdere debatten: tweede_kamer_debatten of officiele_bekendmakingen_search (type Handelingen).`,
    );
  }
  return notes;
}
