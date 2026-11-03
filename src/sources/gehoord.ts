import type { AppConfig, MCPRecord } from "../types.js";
import { getJson, SourceRequestError } from "../utils/http.js";
import { errorResponse, mapSourceError } from "../utils/response.js";
import type { MCPErrorResponse } from "../types.js";

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
 * Verified API behaviour (November 2026):
 * - /contributions searches `q` as ONE literal, case-insensitive phrase (no
 *   AND/OR; a term of 4 characters or fewer matches as a whole word only) and
 *   silently ignores chamber, party, speaker and debateId: those filters run
 *   here, over at most GEHOORD_FILTER_MAX_PAGES pages of 200.
 * - /debates ignores q.
 * - Errors are JSON {error:{code,message}}: 401 unauthorized, 404 not_found.
 * - Rate limit 120 requests a minute (x-ratelimit-* headers); a 429 is
 *   retried by the shared http helper.
 */
export const GEHOORD_BASE = "https://gehoord.de/api/v1";
export const GEHOORD_SITE = "https://gehoord.de";
export const GEHOORD_CONNECTOR = "gehoord";
/** Most items the API returns per request. */
export const GEHOORD_MAX_LIMIT = 200;
/** Pages of 200 a filtered search scans at most (kamer/fractie/spreker are applied here, not upstream). */
export const GEHOORD_FILTER_MAX_PAGES = 3;
/** Pages of 200 gehoord_debat_get reads at most to find a segment_id in its debate. */
export const GEHOORD_SEGMENT_MAX_PAGES = 10;
export const GEHOORD_DEFAULT_CHARS = 1200;
export const GEHOORD_MAX_CHARS = 10_000;
export const GEHOORD_DEFAULT_CONTEXT = 5;
export const GEHOORD_MAX_CONTEXT = 25;
/** The first day Gehoord.de has transcripts for. */
export const GEHOORD_SINCE = "2026-03-31";

const TIMEOUT_MS = 15_000;

export type GehoordKamer = "tk" | "ek";
export type GehoordStatus = "live" | "ended";

/** The debate as embedded in a contribution (a subset of GehoordDebate). */
export interface GehoordDebateRef {
  id: number | string;
  chamber: string;
  title: string;
  status: string;
  hall?: string;
  startsAt?: string;
  /** The official Kamer page (debatdirect.tweedekamer.nl or eerstekamer.nl). */
  url?: string;
}

export interface GehoordDebate extends GehoordDebateRef {
  tkDebateId?: string;
  locationId?: string;
  /** "Plenair debat", "Commissiedebat", "Technische briefing", "Procedurevergadering", ... */
  debateType?: string;
  startedAt?: string;
  endedAt?: string;
  tkActivityId?: string;
  tkActivityNumber?: string;
  /** A human typed condensed subtitles (vragenuur, big debates): the text is not literal. */
  subtitlesCondensed: boolean;
  contributionCount?: number;
  lastContributionAt?: string;
  /** The debate on gehoord.de. */
  gehoordUrl: string;
}

export interface GehoordSpeaker {
  /** The raw speakerLabel: for the Tweede Kamer the TK Persoon GUID (the spreker objectid of the VLOS XML). */
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
  /** The raw speakerLabel, kept as is: for the Tweede Kamer the TK Persoon GUID, identical to the spreker objectid in the VLOS XML. */
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
  /** One key word or exact phrase: the API searches the whole string as one literal phrase. */
  query: string;
  date_from?: string;
  date_to?: string;
  kamer?: GehoordKamer;
  fractie?: string;
  spreker?: string;
  top: number;
  /** Without filters the offset of the API; with kamer/fractie/spreker the position in the unfiltered hits to scan from. */
  offset: number;
}

export interface GehoordSearchResult {
  items: GehoordContribution[];
  /** Hits of the phrase upstream (unfiltered). */
  upstreamTotal: number | null;
  /** Whether kamer/fractie/spreker were applied here. */
  filtered: boolean;
  /** Unfiltered hits read (filtered search only). */
  scanned: number;
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

export function parseDebateRef(raw: unknown): GehoordDebateRef {
  const d = asRecord(raw);
  return {
    id: idOf(d.id),
    chamber: optString(d.chamber) ?? "",
    title: optString(d.title) ?? "",
    status: optString(d.status) ?? "",
    hall: optString(d.hall),
    startsAt: optString(d.startsAt),
    url: optString(d.url),
  };
}

export function parseDebate(raw: unknown): GehoordDebate {
  const d = asRecord(raw);
  const ref = parseDebateRef(d);
  return {
    ...ref,
    tkDebateId: optString(d.tkDebateId),
    locationId: optString(d.locationId),
    debateType: optString(d.debateType),
    startedAt: optString(d.startedAt),
    endedAt: optString(d.endedAt),
    tkActivityId: optString(d.tkActivityId),
    tkActivityNumber: optString(d.tkActivityNumber),
    subtitlesCondensed: d.subtitlesCondensed === true,
    contributionCount: optNumber(d.contributionCount),
    lastContributionAt: optString(d.lastContributionAt),
    gehoordUrl: gehoordDebateUrl(ref.id),
  };
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
/*  Client-side filters (the API ignores chamber/party/speaker)        */
/* ------------------------------------------------------------------ */

/** Lower case, no accents, letters and digits only: "GroenLinks-PvdA" → "groenlinkspvda". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Words, lower case, without accents: "Van der Plas" → ["van", "der", "plas"]. */
function words(s: string): string[] {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

const FRACTIE_ALIASES: Record<string, string> = {
  glpvda: "groenlinkspvda",
  gl: "groenlinkspvda",
  cu: "christenunie",
  pvdd: "partijvoordedieren",
};

/** Whether the speaker's party is the fractie asked for: equal (aliases too), or containing it from 4 characters on. */
export function matchesFractie(party: string | undefined, fractie: string): boolean {
  if (!party) return false;
  const p = fold(party);
  const f = fold(fractie);
  if (!f) return true;
  if (p === f) return true;
  const alias = FRACTIE_ALIASES[f];
  if (alias && p === alias) return true;
  return f.length >= 4 && p.includes(f);
}

/** Whether every word of `spreker` is a word of the speaker's name or role: "Klaver", "van Weel", "minister". */
export function matchesSpreker(c: Pick<GehoordContribution, "speakerName" | "speakerRole">, spreker: string): boolean {
  const wanted = words(spreker);
  if (!wanted.length) return true;
  const have = new Set([...words(c.speakerName), ...words(c.speakerRole ?? "")]);
  return wanted.every((w) => have.has(w));
}

export function matchesFilters(c: GehoordContribution, args: Pick<GehoordSearchArgs, "kamer" | "fractie" | "spreker">): boolean {
  if (args.kamer && c.debate.chamber !== args.kamer) return false;
  if (args.fractie && !matchesFractie(c.speakerParty, args.fractie)) return false;
  if (args.spreker && !matchesSpreker(c, args.spreker)) return false;
  return true;
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
   * Full-text search over the contributions, newest first. Without
   * kamer/fractie/spreker one request with the API's own offset; with them,
   * pages of 200 from `offset` on, at most GEHOORD_FILTER_MAX_PAGES, filtered
   * here, until `top` fragments match.
   */
  async search(args: GehoordSearchArgs): Promise<GehoordSearchResult> {
    const query = args.query.trim();
    if (!query) throw new GehoordInputError("query is leeg.", "Geef één trefwoord of een exacte frase, bijv. 'stikstof' of 'medische isotopen'.");
    const from = checkDate("date_from", args.date_from);
    const to = checkDate("date_to", args.date_to);
    const top = clamp(args.top, 1, GEHOORD_MAX_LIMIT);
    const offset = Math.max(0, Math.trunc(args.offset));
    const filtered = Boolean(args.kamer || args.fractie?.trim() || args.spreker?.trim());
    const params: Record<string, string> = { q: query };
    if (from) params.from = from;
    if (to) params.to = to;
    if (args.kamer) params.kamer = `${args.kamer} (hier gefilterd)`;
    if (args.fractie?.trim()) params.fractie = `${args.fractie.trim()} (hier gefilterd)`;
    if (args.spreker?.trim()) params.spreker = `${args.spreker.trim()} (hier gefilterd)`;

    if (!filtered) {
      const { data, url } = await this.get("/contributions", { q: query, from, to, limit: top, offset });
      const body = asRecord(data);
      const items = asArray(body.data).map((c) => parseContribution(c));
      const page = parsePagination(body.pagination);
      const hasMore = page.hasMore ?? (page.total !== null ? offset + items.length < page.total : items.length >= top);
      return {
        items,
        upstreamTotal: page.total,
        filtered: false,
        scanned: items.length,
        nextOffset: hasMore ? offset + items.length : undefined,
        hasMore,
        endpoint: url,
        params: { ...params, limit: String(top), offset: String(offset) },
      };
    }

    const matches: Array<{ item: GehoordContribution; position: number }> = [];
    let position = offset;
    let upstreamTotal: number | null = null;
    let upstreamMore = true;
    let endpoint = "";
    for (let page = 0; page < GEHOORD_FILTER_MAX_PAGES && upstreamMore && matches.length < top; page += 1) {
      const { data, url } = await this.get("/contributions", { q: query, from, to, limit: GEHOORD_MAX_LIMIT, offset: position });
      if (!endpoint) endpoint = url;
      const body = asRecord(data);
      const raw = asArray(body.data);
      const meta = parsePagination(body.pagination);
      upstreamTotal = meta.total ?? upstreamTotal;
      raw.forEach((c, i) => {
        const item = parseContribution(c);
        if (matchesFilters(item, args)) matches.push({ item, position: position + i });
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
      nextOffset,
      hasMore: nextOffset !== undefined,
      endpoint,
      params: { ...params, offset: String(offset) },
    };
  }

  /** Debates, newest first: by kamer, status (live/ended) and date. */
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

  /**
   * One debate with its speakers. retries 0 for a lookup that may fail (the
   * koppeling's debate type): a 429 then does not hold a slot through Retry-After.
   */
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
  "Bij vragenuur en grote debatten typt soms een mens de ondertiteling; die is samengevat en dus niet letterlijk (subtitlesCondensed).";
export const GEHOORD_EK_NOTE = "Tekst uit de Eerste Kamer heeft geen hoofdletters en geen leestekens.";

/** "Wim Meulenkamp (VVD)", "Sophie Hermans (Minister van VWS)". */
export function gehoordSpeakerLabel(c: Pick<GehoordContribution, "speakerName" | "speakerParty" | "speakerRole">): string {
  const role = c.speakerParty ?? (c.speakerRole && !/^(?:tweede|eerste) kamerlid$/i.test(c.speakerRole) ? c.speakerRole : undefined);
  return role ? `${c.speakerName} (${role})` : c.speakerName;
}

/** About `size` characters around the first occurrence of the phrase (case-insensitive), else the start. */
export function gehoordSnippet(text: string, phrase: string | undefined, size = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= size) return clean;
  const at = phrase ? clean.toLowerCase().indexOf(phrase.toLowerCase().trim()) : -1;
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
export function gehoordContributionRecord(c: GehoordContribution, opts: { query?: string; maxChars: number; segmentId?: string | number; position?: number }): MCPRecord {
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
      debat_status: c.debate.status,
      zaal: c.debate.hall ?? null,
      debat_start: c.debate.startsAt ?? null,
      persoon_id: c.persoonId,
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
    d.status === "live" ? "live" : d.status === "ended" ? "afgelopen" : d.status,
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
      sprekers: speakers?.map((s) => ({ persoon_id: s.persoonId, naam: s.name, fractie: s.party ?? null, functie: s.role ?? null })),
      bron: "Gehoord.de (automatische transcriptie)",
    },
  };
}

/** The caveats that apply to what was shown: live, condensed, Eerste Kamer. */
export function gehoordCaveats(debates: Array<{ status?: string; chamber?: string; subtitlesCondensed?: boolean }>, opts: { condensedUnknown?: boolean } = {}): string[] {
  const notes: string[] = [];
  if (debates.some((d) => d.status === "live")) notes.push(GEHOORD_LIVE_NOTE);
  if (debates.some((d) => d.subtitlesCondensed)) notes.push(GEHOORD_CONDENSED_NOTE);
  else if (opts.condensedUnknown && debates.length) notes.push(`${GEHOORD_CONDENSED_NOTE.replace(/ \(subtitlesCondensed\)\.$/, "")}; gehoord_debat_get toont per debat of dat zo is.`);
  if (debates.some((d) => d.chamber === "ek")) notes.push(GEHOORD_EK_NOTE);
  return notes;
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

export function gehoordSearchNotes(out: GehoordSearchResult, args: Pick<GehoordSearchArgs, "query" | "kamer" | "fractie" | "spreker" | "offset">): string[] {
  const notes: string[] = [GEHOORD_BASE_NOTE, GEHOORD_LINK_NOTE];
  notes.push(`Gezocht op de letterlijke frase '${args.query.trim()}' (hoofdletterongevoelig; geen EN/OF, de hele zoekterm is één frase; een woord van 4 tekens of minder alleen als heel woord), nieuwste eerst.`);
  if (out.filtered) {
    const applied = [args.kamer ? `kamer ${args.kamer}` : "", args.fractie ? `fractie '${args.fractie}'` : "", args.spreker ? `spreker '${args.spreker}'` : ""].filter(Boolean).join(", ");
    const range = out.scanned ? `treffer ${args.offset + 1} t/m ${args.offset + out.scanned}` : "geen treffers";
    notes.push(
      `De Gehoord-API filtert niet op kamer, fractie of spreker: ${applied} is hier toegepast op ${range}${out.upstreamTotal !== null ? ` van ${out.upstreamTotal}` : ""} (nieuwste eerst, hooguit ${GEHOORD_FILTER_MAX_PAGES * GEHOORD_MAX_LIMIT} per aanroep).` +
        (out.nextOffset !== undefined ? ` Zoek verder met offset=${out.nextOffset}.` : ""),
    );
  } else if (out.nextOffset !== undefined) {
    notes.push(`Meer fragmenten: offset=${out.nextOffset}.`);
  }
  notes.push(...gehoordCaveats(out.items.map((c) => c.debate), { condensedUnknown: true }));
  if (!out.items.length) {
    notes.push(
      `Niets gevonden: zoek op één kernwoord (bijv. alleen 'stikstof') of een exacte frase die zo is uitgesproken. Gehoord.de begint op ${GEHOORD_SINCE}; voor eerdere debatten: tweede_kamer_debatten of officiele_bekendmakingen_search (type Handelingen).`,
    );
  }
  return notes;
}
