import { setTimeout as sleep } from "node:timers/promises";
import type { AppConfig } from "../types.js";
import {
  acquireConnectorSlot,
  getCircuitDecision,
  getConnectorCacheTtlMs,
  getHttpCache,
  makeHttpCacheKey,
  markConnectorCacheHit,
  markConnectorCall,
  markConnectorFailure,
  markConnectorSuccess,
  setHttpCache,
} from "../utils/connector-runtime.js";
import { SourceRequestError } from "../utils/http.js";
import { htmlToText } from "../utils/html-text.js";
import { logger } from "../utils/logger.js";

/**
 * EU Funding & Tenders Portal of the European Commission: calls for proposals
 * (topics, including prizes), cascade funding calls of EU-funded projects and
 * EU external action calls (EuropeAid/PROSPECT). Tenders are left out.
 *
 * The portal's own search API (api.tech.ec.europa.eu/search-api) needs no account;
 * "SEDIA" is the public key the portal itself sends. Behaviour verified live
 * (October 2026):
 *  - A search is a POST whose query, languages and sort travel as multipart parts
 *    typed application/json. A JSON body or untyped parts are ignored (HTTP 200
 *    with all 4.2 million documents) or rejected (HTTP 500), so utils/http.ts,
 *    which only sends JSON bodies, cannot be used; see postForm.
 *  - type: 0 tender, 1 grant (topic), 2 external action call (PROSPECT), 8 cascade
 *    funding call. status: 31094501 forthcoming, 31094502 open, 31094503 closed.
 *  - pageSize is capped at 100 without an error; pageNumber is 1-based. Results
 *    past the first 10,000 come back as an empty page with totalResults 0.
 *  - Ties in the sort order are broken differently on every request, so plain
 *    relevance paging repeats some documents and skips others (148 of 1202 open
 *    and forthcoming items were never returned). Every sort here therefore ends
 *    with identifier and callccm2Id.
 *  - The index keeps outdated copies of many topics (URL ".../data/topicDetails/
 *    <ID>.json", no budget overview) whose status was never updated: of the 1202
 *    items labelled open or forthcoming, 671 had no deadline left, 663 of them
 *    such copies. By default those are filtered out by deadline (see search).
 *  - Range filters only work with epoch milliseconds; an ISO date is ignored.
 *    A range on the multi-valued deadlineDate matches when any deadline is in it.
 */
export const EU_FUNDING_SEARCH_ENDPOINT = "https://api.tech.ec.europa.eu/search-api/prod/rest/search";
export const EU_FUNDING_FACET_ENDPOINT = "https://api.tech.ec.europa.eu/search-api/prod/rest/facet";
/** Base of the portal's pages; detail paths as the portal's own code builds them. */
export const EU_FUNDING_PORTAL = "https://ec.europa.eu/info/funding-tenders/opportunities/portal";
const API_KEY = "SEDIA";
const CONNECTOR = "eu_funding";
const TIMEOUT_MS = 15_000;
const QUEUE_TIMEOUT_MS = 30_000;
const RETRIES = 1;
const MAX_RESPONSE_CHARS = 12 * 1024 * 1024;
const USER_AGENT = "nl-gov-mcp/0.1.0";
const TIME_ZONE = "Europe/Brussels";

/** Upstream page-size cap: a larger pageSize is silently served as 100. */
export const EU_FUNDING_MAX_ROWS = 100;
export const EU_FUNDING_DEFAULT_ROWS = 20;
/** Only the first 10,000 results of a query can be paged to. */
export const EU_FUNDING_MAX_REACHABLE = 10_000;
/** Default and cap for the text fields of eu_funding_get. */
export const EU_FUNDING_DEFAULT_MAX_CHARS = 4_000;
export const EU_FUNDING_MAX_CHARS = 20_000;
/** How many rows of a call's budget overview, and how many related calls, get returns. */
const CALL_BUDGET_ROWS_SHOWN = 40;
const RELATED_SHOWN = 10;
const LATEST_INFOS_SHOWN = 5;
const SNIPPET_CHARS = 280;
/** Up to this offset+limit the deadline order is the next deadline (see nextDeadlineWindow). */
const NEXT_DEADLINE_MERGE_MAX = 300;

export const EU_FUNDING_STATUSES = ["open", "forthcoming", "closed"] as const;
export const EU_FUNDING_TYPES = ["grant", "cascade_funding", "external_action"] as const;
export const EU_FUNDING_SORTS = ["relevance", "deadline", "deadline_desc", "newest", "oldest", "title", "identifier"] as const;

export type EuFundingStatus = (typeof EU_FUNDING_STATUSES)[number];
export type EuFundingType = (typeof EU_FUNDING_TYPES)[number];
export type EuFundingSort = (typeof EU_FUNDING_SORTS)[number];

const STATUS_CODE: Record<EuFundingStatus, string> = { forthcoming: "31094501", open: "31094502", closed: "31094503" };
const TYPE_CODE: Record<EuFundingType, string> = { grant: "1", external_action: "2", cascade_funding: "8" };
const CODE_TYPE: Record<string, EuFundingType> = { "1": "grant", "2": "external_action", "8": "cascade_funding" };

/** Contract types of external action calls (facet contractType). */
const CONTRACT_TYPES: Record<string, string> = { "42893160": "Grants", "42958121": "Twinning" };

/**
 * Programmes (facet frameworkProgramme over types 1, 2 and 8, October 2026) with the
 * portal's own labels. Abbreviation and period are read from the label; an id that
 * is not listed here is named through the facet endpoint when it shows up.
 */
const PROGRAMME_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["43108390", "Horizon Europe (HORIZON)"],
  ["31045243", "Horizon 2020 Framework Programme (H2020 - 2014-2020)"],
  ["111111", "EU External Action - Prospect (RELEX-PROSPECT)"],
  ["47376280", "EU External Action - eGrants (RELEX2027)"],
  ["43152860", "Digital Europe Programme (DIGITAL)"],
  ["43251567", "Connecting Europe Facility (CEF)"],
  ["43353764", "Erasmus (ERASMUS)"],
  ["31059093", "Erasmus Programme (EPLUS - 2014-2020)"],
  ["44181033", "European Defence Fund (EDF)"],
  ["31109727", "European Defence Industrial Development Programme (EDIDP - 2014-2020)"],
  ["43252405", "Programme for the Environment and Climate Action (LIFE)"],
  ["31107710", "Programme for the Environment and Climate Action (LIFE - 2014-2020)"],
  ["43252476", "Single Market Programme (SMP)"],
  ["31059643", "Programme for the Competitiveness of Enterprises and small and medium-sized enterprises (COSME - 2014-2020)"],
  ["43251814", "Creative Europe Programme (CREA)"],
  ["31059083", "Creative Europe (CREA - 2014-2020)"],
  ["43251589", "Citizens, Equality, Rights and Values programme (CERV)"],
  ["31076817", "Rights, Equality and Citizenship Programme (REC - 2014-2020)"],
  ["31059088", "Europe For Citizens (EFC - 2014-2020)"],
  ["43298664", "Promotion of Agricultural Products (AGRIP)"],
  ["31072773", "Promotion of Agricultural Products (AGRIP - 2014-2020)"],
  ["43332642", "EU4Health Programme (EU4H)"],
  ["31061266", "3rd Health Programme (3HP - 2014-2020)"],
  ["43298916", "Euratom Research and Training Programme (EURATOM)"],
  ["43251842", "Union Anti-Fraud Programme (EUAF)"],
  ["31084392", "Hercule III (HERC - 2014-2020)"],
  ["43252449", "Research Fund for Coal & Steel (RFCS)"],
  ["31061225", "Research Fund for Coal & Steel (RFCS - 2014-2020)"],
  ["43254019", "European Social Fund (ESF)"],
  ["43697167", "European Parliament (EP)"],
  ["43637601", "Pilot Projects & Preparation Actions (PPPA)"],
  ["31084250", "Pilot Projects and Preparatory Actions (PPPA - 2014-2020)"],
  ["45532249", "EU Bodies and Agencies (EUBA)"],
  ["44416173", "Interregional Innovation Investments Instrument (I3)"],
  ["43089234", "Innovation Fund (INNOVFUND)"],
  ["43252368", "Internal Security Fund (ISF)"],
  ["31077817", "Internal Security Fund Police (ISFP - 2014-2020)"],
  ["31077833", "Internal Security Fund Borders and Visa (ISFB - 2014-2020)"],
  ["43392145", "European Maritime, Fisheries and Aquaculture Fund (EMFAF)"],
  ["31098847", "European Maritime and Fisheries Fund (EMFF - 2014-2020)"],
  ["43252386", "Justice Programme (JUST)"],
  ["31070247", "Justice Programme (JUST - 2014-2020)"],
  ["43298203", "Union Civil Protection Mechanism (UCPM)"],
  ["31082527", "Union Civil Protection Mechanism (UCPM - 2014-2020)"],
  ["43252517", "Social Prerogative and Specific Competencies Lines (SOCPL)"],
  ["31061273", "Consumer Programme (CP - 2014-2020)"],
  ["43251447", "Asylum, Migration and Integration Fund (AMIF)"],
  ["31077795", "Asylum, Migration and Integration Fund (AMIF - 2014-2020)"],
  ["43254037", "European Solidarity Corps (ESC)"],
  ["42992790", "European Solidarity Corps (ESC - 2014-2020)"],
  ["43252433", "Programme for the Protection of the Euro against Counterfeiting (PERICLES IV)"],
  ["43251882", "Support for information measures relating to the common agricultural policy (IMCAP)"],
  ["42198993", "Support for information measures relating to the common agricultural policy (IMCAP - 2014-2020)"],
  ["43251530", "Border Management and Visa Instrument (BMVI)"],
  ["44773066", "Just Transition Mechanism (JTM)"],
  ["44773133", "Information Measures for the EU Cohesion policy (IMREG)"],
  ["43253967", "Renewable Energy Financing Mechanism (RENEWFM)"],
  ["46324255", "Technical assistance for ERDF, CF and JTF (ERDF-TA)"],
  ["45876777", "Neighbourhood, Development and International Cooperation Instrument – Global Europe (NDICI)"],
  ["43253952", "Humanitarian Aid (HUMA)"],
  ["47786028", "Business and Consumer Surveys Programme (BCS)"],
  ["42810547", "EUROPE DIRECT (ED - 2014-2020)"],
  ["31088049", "European Statistics (ESTAT - 2014-2020)"],
  ["31059098", "EU Aid Volunteers programme (EUAID - 2014-2020)"],
  ["31075571", "Intra-Africa Academic Mobility Scheme (PANAF - 2014-2020)"],
];

export interface EuFundingProgramme {
  id: string;
  /** The portal's label, e.g. "Horizon Europe (HORIZON)". */
  label: string;
  name: string;
  abbreviation?: string;
  /** Only for programmes of an earlier period, as the label states it ("2014-2020"). */
  period?: string;
}

/** "Erasmus  (ERASMUS )" → name "Erasmus", abbreviation "ERASMUS"; "(H2020 - 2014-2020)" also gives the period. */
export function parseProgrammeLabel(id: string, label: string): EuFundingProgramme {
  const clean = label.replace(/\s+/g, " ").trim();
  const m = clean.match(/^(.*?)\s*\(([^()]*)\)$/);
  if (!m) return { id, label: clean, name: clean };
  const [abbreviation, period] = m[2].split(" - ").map((s) => s.trim());
  return {
    id,
    label: `${m[1]} (${m[2].trim()})`,
    name: m[1],
    ...(abbreviation ? { abbreviation } : {}),
    ...(period ? { period } : {}),
  };
}

export const EU_FUNDING_PROGRAMMES: readonly EuFundingProgramme[] = PROGRAMME_LABELS.map(([id, label]) => parseProgrammeLabel(id, label));
const PROGRAMME_BY_ID = new Map(EU_FUNDING_PROGRAMMES.map((p) => [p.id, p]));

/** Abbreviations of the programmes, current period first, each once (for tool descriptions). */
export const EU_FUNDING_PROGRAMME_ABBREVIATIONS: readonly string[] = [
  ...new Set(EU_FUNDING_PROGRAMMES.filter((p) => !p.period).map((p) => p.abbreviation).filter((a): a is string => !!a)),
];

/** A filter value the caller gave that cannot be used as is (bad date, unknown programme). */
export class EuFundingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EuFundingInputError";
  }
}

/** Lowercase, accents and punctuation removed, whitespace collapsed. */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface ProgrammeResolution {
  input: string;
  ids: string[];
  /** Known programmes the ids stand for (empty for an id that is not in the table). */
  programmes: EuFundingProgramme[];
  match: "id" | "abbreviation" | "name";
}

/**
 * A programme as id ("43108390"), abbreviation ("HORIZON", "LIFE", "EU4H") or part
 * of its name ("Horizon Europe", "Digital Europe"). An abbreviation used in two
 * periods ("LIFE", "CREA") means both. Throws EuFundingInputError when nothing fits:
 * a filter that is not applied would return calls of every programme.
 */
export function resolveEuFundingProgramme(input: string): ProgrammeResolution {
  const raw = input.replace(/\s+/g, " ").trim();
  if (/^\d+$/.test(raw)) {
    const known = PROGRAMME_BY_ID.get(raw);
    return { input: raw, ids: [raw], programmes: known ? [known] : [], match: "id" };
  }
  const key = fold(raw);
  const byAbbreviation = EU_FUNDING_PROGRAMMES.filter((p) => p.abbreviation && fold(p.abbreviation) === key);
  if (key && byAbbreviation.length) {
    return { input: raw, ids: byAbbreviation.map((p) => p.id), programmes: byAbbreviation, match: "abbreviation" };
  }
  const byName = key.length >= 3 ? EU_FUNDING_PROGRAMMES.filter((p) => ` ${fold(p.label)} `.includes(` ${key} `)) : [];
  if (byName.length) return { input: raw, ids: byName.map((p) => p.id), programmes: byName, match: "name" };
  throw new EuFundingInputError(
    `Programma '${raw}' is niet bekend in het Funding & Tenders Portal. Gebruik een afkorting (${EU_FUNDING_PROGRAMME_ABBREVIATIONS.join(", ")}), een deel van de naam of het numerieke id.`,
  );
}

/** Today's date in Brussels as "YYYY-MM-DD"; deadlines are EU deadlines. */
export function brusselsToday(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowMs));
}

function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function checkDay(value: string | undefined, name: string): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(dayStartMs(v)) || new Date(dayStartMs(v)).toISOString().slice(0, 10) !== v) {
    throw new EuFundingInputError(`${name} moet een datum zijn als JJJJ-MM-DD, niet '${v}'.`);
  }
  return v;
}

/**
 * An upstream date as this source returns it. Midnight UTC means the index holds
 * only the day (EU topics: "2026-10-29T00:00:00.000+0000" → "2026-10-29"); any
 * other time is kept as UTC ("2026-06-28T22:59:00.000+0000" → "2026-06-28T22:59:00Z").
 */
export function normalizeEuDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const ms = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (Number.isNaN(ms)) return undefined;
  const iso = new Date(ms).toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : `${iso.slice(0, 19)}Z`;
}

/** Epoch milliseconds as a string ("1788220800000"), as in links and topic details. */
function epochDate(value: unknown): string | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{10,}$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(n) ? normalizeEuDate(new Date(n).toISOString()) : undefined;
}

/**
 * Whether a deadline lies before now. A day-only deadline is not passed during that
 * day: the hour is not in the index (the portal page states it).
 */
function deadlinePassed(deadline: string, nowMs: number, today: string): boolean {
  return deadline.length === 10 ? deadline < today : Date.parse(deadline) < nowMs;
}

function sortDeadlines(values: string[]): string[] {
  const at = (d: string) => (d.length === 10 ? dayStartMs(d) : Date.parse(d));
  return [...new Set(values)].sort((a, b) => at(a) - at(b));
}

type Meta = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Metadata values are arrays; the first non-empty string of one. */
function first(meta: Meta, key: string): string | undefined {
  const v = meta[key];
  const list = Array.isArray(v) ? v : [v];
  for (const x of list) if (typeof x === "string" && x.trim()) return x.trim();
  return undefined;
}

function all(meta: Meta, key: string): string[] {
  const v = meta[key];
  return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
}

/** Several metadata fields hold JSON as a string (budgetOverview, actions, links, ...). */
function jsonField(meta: Meta, key: string): unknown {
  const raw = first(meta, key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Text cut at a word boundary, with an ellipsis. */
function cut(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const slice = text.slice(0, max);
  const at = slice.lastIndexOf(" ");
  return { text: `${(at > max * 0.6 ? slice.slice(0, at) : slice).trimEnd()} …`, cut: true };
}

/** Outdated index copies point at the topic details JSON instead of a portal page. */
function isOutdatedCopy(url: string | undefined): boolean {
  return !!url && /\/data\/topicDetails\//i.test(url);
}

/** Portal page of an item, built the way the portal's own search list builds it. */
export function euFundingPortalUrl(type: EuFundingType, ref: { identifier?: string; reference?: string; cascadeCallId?: string }): string | undefined {
  if (type === "grant" && ref.identifier) return `${EU_FUNDING_PORTAL}/screen/opportunities/topic-details/${encodeURIComponent(ref.identifier)}`;
  if (type === "external_action" && ref.reference) return `${EU_FUNDING_PORTAL}/screen/opportunities/prospect-details/${encodeURIComponent(ref.reference)}`;
  if (type === "cascade_funding" && ref.cascadeCallId) return `${EU_FUNDING_PORTAL}/screen/opportunities/competitive-calls-cs/${encodeURIComponent(ref.cascadeCallId)}`;
  return undefined;
}

export interface EuBudgetLine {
  /** The budget line's key in the call's budget overview. */
  line: string;
  /** Topics this line funds; more than one means they share the amount. */
  topics: string[];
  types_of_action: string[];
  /** EUR per budget year, as the overview gives it. */
  budget_by_year: Record<string, number>;
  budget_eur: number;
  /** Absent when the overview gives 0 (not stated). */
  expected_grants?: number;
  min_contribution_eur?: number;
  max_contribution_eur?: number;
  opening_date?: string;
  deadlines: string[];
  deadline_model?: string;
}

/**
 * The budget overview of a call (shared by all its topics) as budget lines. Rows
 * under one key share that key's amount: a topic with several types of action
 * repeats it per type (MSCA Doctoral Networks: three rows, one amount), and
 * several topics can share one line (verified: always the same amount per key).
 * Each line is therefore counted once.
 */
export function parseBudgetOverview(value: unknown): EuBudgetLine[] {
  const map = asRecord(asRecord(value)?.budgetTopicActionMap);
  if (!map) return [];
  const lines: EuBudgetLine[] = [];
  for (const [key, rows] of Object.entries(map)) {
    if (!Array.isArray(rows) || !rows.length) continue;
    const parsed = rows.map(asRecord).filter((r): r is Record<string, unknown> => !!r);
    const topics: string[] = [];
    const typesOfAction: string[] = [];
    for (const r of parsed) {
      const action = typeof r.action === "string" ? r.action : "";
      const at = action.indexOf(" - ");
      const topic = (at >= 0 ? action.slice(0, at) : action).trim();
      const toa = at >= 0 ? action.slice(at + 3).replace(/\s+/g, " ").trim() : "";
      if (topic && !topics.includes(topic)) topics.push(topic);
      if (toa && !typesOfAction.includes(toa)) typesOfAction.push(toa);
    }
    const head = parsed[0];
    if (!head) continue;
    const byYear: Record<string, number> = {};
    for (const [year, amount] of Object.entries(asRecord(head.budgetYearMap) ?? {})) {
      const n = positiveNumber(amount);
      if (n !== undefined) byYear[year] = n;
    }
    const deadlines = Array.isArray(head.deadlineDates)
      ? head.deadlineDates.map((d) => normalizeEuDate(d) ?? epochDate(d)).filter((d): d is string => !!d)
      : [];
    const line: EuBudgetLine = {
      line: key,
      topics,
      types_of_action: typesOfAction,
      budget_by_year: byYear,
      budget_eur: Object.values(byYear).reduce((s, n) => s + n, 0),
      deadlines: sortDeadlines(deadlines),
    };
    const expected = positiveNumber(head.expectedGrants);
    const min = positiveNumber(head.minContribution);
    const max = positiveNumber(head.maxContribution);
    const opening = normalizeEuDate(head.plannedOpeningDate) ?? epochDate(head.plannedOpeningDate);
    if (expected !== undefined) line.expected_grants = expected;
    if (min !== undefined) line.min_contribution_eur = min;
    if (max !== undefined) line.max_contribution_eur = max;
    if (opening) line.opening_date = opening;
    if (typeof head.deadlineModel === "string" && head.deadlineModel) line.deadline_model = head.deadlineModel;
    lines.push(line);
  }
  return lines;
}

/** What a topic gets from its call's budget lines: each line once; a line shared with other topics is named. */
export function topicBudget(lines: EuBudgetLine[], identifier: string): { budget_eur?: number; shared_with: string[]; lines: EuBudgetLine[] } {
  const own = lines.filter((l) => l.topics.includes(identifier));
  const total = own.reduce((s, l) => s + l.budget_eur, 0);
  const shared = [...new Set(own.flatMap((l) => l.topics.filter((t) => t !== identifier)))];
  return { ...(total > 0 ? { budget_eur: total } : {}), shared_with: shared, lines: own };
}

export interface EuFundingItem {
  type: EuFundingType;
  /** What eu_funding_get takes: topic identifier, cascade call number or EuropeAid reference. */
  id: string;
  /** The portal's identifier: the topic, the EuropeAid reference, or (cascade) the EU topic that funds the project. */
  identifier: string;
  title: string;
  call_identifier?: string;
  call_title?: string;
  /** Cascade funding: the call's own number (callccm2Id) and the EU-funded project that runs it. */
  cascade_call_id?: string;
  project_acronym?: string;
  project_name?: string;
  /** Cascade funding: the EU topic the project was funded under. */
  parent_topic_title?: string;
  programme_id?: string;
  programme?: string;
  programme_abbreviation?: string;
  programme_period?: string;
  /** As the portal states it; "unknown" for any other code (status_code). */
  status: EuFundingStatus | "unknown";
  status_code?: string;
  /** Opening date (for external action calls: publication date). */
  opening_date?: string;
  deadlines: string[];
  /** First deadline that has not passed; absent when all have. */
  next_deadline?: string;
  /** True when every deadline lies before now (computed); absent without deadlines. */
  deadline_passed?: boolean;
  deadline_model?: string;
  /** EUR, as the portal shows it; absent when the source gives none. See budget_scope. */
  budget_eur?: number;
  budget_scope?: "topic" | "shared_budget_line" | "cascade_call" | "external_action_call";
  /** Other topics that share this topic's budget line(s); budget_eur is then the shared amount. */
  budget_shared_with?: string[];
  types_of_action: string[];
  /** External action calls: Grants or Twinning. */
  contract_type?: string;
  /** An outdated copy in the portal index (never updated, status possibly stale). */
  outdated_index_record?: boolean;
  description_short?: string;
  url: string;
  /** External action calls: the PROSPECT page when the index names one. */
  prospect_url?: string;
}

/** The raw search hit: reference, url and metadata arrays. */
export interface EuSearchHit {
  reference?: string;
  url?: string;
  summary?: string;
  metadata: Meta;
}

function asHit(value: unknown): EuSearchHit | undefined {
  const o = asRecord(value);
  const meta = asRecord(o?.metadata);
  if (!o || !meta) return undefined;
  return {
    reference: typeof o.reference === "string" ? o.reference : undefined,
    url: typeof o.url === "string" ? o.url : undefined,
    summary: typeof o.summary === "string" ? o.summary : undefined,
    metadata: meta,
  };
}

function statusOf(code: string | undefined): EuFundingStatus | "unknown" {
  const entry = Object.entries(STATUS_CODE).find(([, c]) => c === code);
  return entry ? (entry[0] as EuFundingStatus) : "unknown";
}

function programmeFields(id: string | undefined, names: ReadonlyMap<string, EuFundingProgramme>): Partial<EuFundingItem> {
  if (!id) return {};
  const p = PROGRAMME_BY_ID.get(id) ?? names.get(id);
  return {
    programme_id: id,
    ...(p ? { programme: p.label } : {}),
    ...(p?.abbreviation ? { programme_abbreviation: p.abbreviation } : {}),
  };
}

/**
 * A search hit as an item. nowMs decides next_deadline and deadline_passed; extra
 * programme names (from the facet endpoint) cover ids missing from the table.
 */
export function toEuFundingItem(
  value: unknown,
  nowMs: number,
  programmeNames: ReadonlyMap<string, EuFundingProgramme> = new Map(),
): EuFundingItem | undefined {
  const hit = asHit(value);
  if (!hit) return undefined;
  const meta = hit.metadata;
  const type = CODE_TYPE[first(meta, "type") ?? ""];
  const identifier = first(meta, "identifier");
  if (!type || !identifier) return undefined;
  const today = brusselsToday(nowMs);
  const cascadeCallId = type === "cascade_funding" ? first(meta, "callccm2Id") : undefined;
  const id = type === "cascade_funding" ? cascadeCallId : identifier;
  const url = euFundingPortalUrl(type, { identifier, reference: hit.reference, cascadeCallId });
  if (!id || !url) return undefined;

  const deadlines = sortDeadlines(all(meta, "deadlineDate").map(normalizeEuDate).filter((d): d is string => !!d));
  const open = deadlines.filter((d) => !deadlinePassed(d, nowMs, today));
  const statusCode = first(meta, "status");
  const ownTitle = type === "cascade_funding" ? first(meta, "callTitle") ?? hit.summary : first(meta, "title") ?? hit.summary;
  const item: EuFundingItem = {
    type,
    id,
    identifier,
    title: (ownTitle ?? identifier).replace(/\s+/g, " ").trim(),
    ...programmeFields(first(meta, "frameworkProgramme"), programmeNames),
    status: statusOf(statusCode),
    deadlines,
    types_of_action: all(meta, "typesOfAction"),
    url,
  };
  if (statusCode) item.status_code = statusCode;
  if (open[0]) item.next_deadline = open[0];
  if (deadlines.length) item.deadline_passed = open.length === 0;

  const opening = normalizeEuDate(first(meta, "startDate"));
  if (opening) item.opening_date = opening;
  const model = first(meta, "deadlineModel");
  if (model) item.deadline_model = model;
  const periods = [...new Set(all(meta, "programmePeriod"))];
  if (periods.length) item.programme_period = periods.join(" / ");

  if (type === "grant") {
    const call = first(meta, "callIdentifier");
    if (call) item.call_identifier = call;
    const callTitle = first(meta, "callTitle");
    if (callTitle) item.call_title = callTitle;
    const budget = topicBudget(parseBudgetOverview(jsonField(meta, "budgetOverview")), identifier);
    if (budget.budget_eur !== undefined) {
      item.budget_eur = budget.budget_eur;
      item.budget_scope = budget.shared_with.length ? "shared_budget_line" : "topic";
      if (budget.shared_with.length) item.budget_shared_with = budget.shared_with;
    }
    const desc = first(meta, "descriptionByte");
    if (desc) item.description_short = cut(htmlToText(desc), SNIPPET_CHARS).text;
  } else {
    const budget = positiveNumber(first(meta, "budget"));
    if (budget !== undefined) {
      item.budget_eur = budget;
      item.budget_scope = type === "cascade_funding" ? "cascade_call" : "external_action_call";
    }
  }
  if (type === "cascade_funding") {
    item.cascade_call_id = cascadeCallId;
    const acronym = first(meta, "projectAcronym");
    const project = first(meta, "projectName");
    const parent = first(meta, "title");
    if (acronym) item.project_acronym = acronym;
    if (project) item.project_name = project.replace(/\s+/g, " ");
    if (parent) item.parent_topic_title = parent;
    const desc = first(meta, "description");
    if (desc) item.description_short = cut(htmlToText(desc), SNIPPET_CHARS).text;
  }
  if (type === "external_action") {
    const contract = CONTRACT_TYPES[first(meta, "contractType") ?? ""];
    if (contract) item.contract_type = contract;
    if (hit.url && /webgate\.ec\.europa\.eu\/prospect\//i.test(hit.url)) item.prospect_url = hit.url;
  }
  if (isOutdatedCopy(hit.url)) item.outdated_index_record = true;
  return item;
}

// ---------------------------------------------------------------------------
// Request building

const TEXT_FIELDS = [
  "tags", "callIdentifier", "description", "identifier", "keywords", "title", "typesOfAction", "typeOfMGAs",
  "missionDetails", "missionDescription", "destinationDetails", "destinationDescription", "callTitle",
];

/**
 * Keywords as the portal's text clause can parse them. ':' '/' and other query
 * syntax made the live API answer 0 results, so they become spaces; a EuropeAid
 * reference keeps its parts joined by '-' as the portal does. An unpaired quote is
 * dropped.
 */
export function toEuSearchText(keywords: string): string {
  let q = keywords.replace(/europeaid\/[\w/]+/gi, (ref) => ref.replace(/\//g, "-"));
  q = q.replace(/[:/\\{}[\]^~<>=]/g, " ");
  if ((q.match(/"/g)?.length ?? 0) % 2) {
    const at = q.lastIndexOf('"');
    q = q.slice(0, at) + q.slice(at + 1);
  }
  return q.replace(/\s+/g, " ").trim();
}

export interface EuFundingSearchArgs {
  query?: string;
  /** Default ["open", "forthcoming"]. */
  status?: EuFundingStatus[];
  /** Default all three. */
  type?: EuFundingType[];
  programme?: string;
  /** YYYY-MM-DD; a call matches when one of its deadlines is in the range. */
  deadlineFrom?: string;
  deadlineTo?: string;
  /** Show items labelled open/forthcoming whose deadlines have all passed. */
  includeExpired?: boolean;
  sort?: EuFundingSort;
  offset?: number;
  limit?: number;
}

export interface EuFundingRequest {
  /** The query part (Elasticsearch bool), the sort part and the URL text. */
  query: Record<string, unknown>;
  sort: Array<{ field: string; order: "ASC" | "DESC" }>;
  text: string;
  keywords: string;
  status: EuFundingStatus[];
  type: EuFundingType[];
  programme?: ProgrammeResolution;
  sortName: EuFundingSort;
  /** Whether calls without a deadline today or later are left out. */
  expiryFilter: boolean;
  today: string;
  deadlineFrom?: string;
  deadlineTo?: string;
  /** The same query without the expiry bound (to count what it leaves out). */
  unfilteredQuery?: Record<string, unknown>;
  offset: number;
  limit: number;
  plan: { pageSize: number; pages: number[]; skip: number };
  /** Set when the window was cut to the first 10,000 results. */
  reachableCut?: boolean;
}

export function clampEuFundingRows(limit: number | null | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return EU_FUNDING_DEFAULT_ROWS;
  return Math.min(EU_FUNDING_MAX_ROWS, Math.max(1, Math.floor(limit)));
}

/**
 * Map an offset/limit window onto 1-based pages of at most 100: the smallest page
 * size that holds the window in one page, else two consecutive pages of 100.
 */
export function planEuFundingWindow(offset: number, limit: number): { pageSize: number; pages: number[]; skip: number } {
  const off = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0));
  const lim = clampEuFundingRows(limit);
  const last = off + lim - 1;
  for (let size = lim; size <= EU_FUNDING_MAX_ROWS; size++) {
    if (Math.floor(off / size) === Math.floor(last / size)) return { pageSize: size, pages: [Math.floor(off / size) + 1], skip: off % size };
  }
  const max = EU_FUNDING_MAX_ROWS;
  const firstPage = Math.floor(off / max) + 1;
  const pages = [firstPage, Math.floor(last / max) + 1].filter((p, i, a) => a.indexOf(p) === i);
  return { pageSize: max, pages, skip: off - (firstPage - 1) * max };
}

const SORTS: Record<EuFundingSort, Array<{ field: string; order: "ASC" | "DESC" }>> = {
  relevance: [{ field: "relevance", order: "DESC" }],
  deadline: [{ field: "deadlineDate", order: "ASC" }],
  deadline_desc: [{ field: "deadlineDate", order: "DESC" }],
  newest: [{ field: "startDate", order: "DESC" }],
  oldest: [{ field: "startDate", order: "ASC" }],
  title: [{ field: "title", order: "ASC" }],
  identifier: [],
};
const TIE_BREAK = [{ field: "identifier", order: "ASC" as const }, { field: "callccm2Id", order: "ASC" as const }];

/** The request(s) a search sends, without network (shared with dryRun). */
export function buildEuFundingRequest(args: EuFundingSearchArgs, nowMs: number = Date.now()): EuFundingRequest {
  const keywords = toEuSearchText(args.query ?? "");
  const status = args.status?.length ? [...new Set(args.status)] : (["open", "forthcoming"] as EuFundingStatus[]);
  const type = args.type?.length ? [...new Set(args.type)] : [...EU_FUNDING_TYPES];
  const deadlineFrom = checkDay(args.deadlineFrom, "deadline_from");
  const deadlineTo = checkDay(args.deadlineTo, "deadline_to");
  if (deadlineFrom && deadlineTo && deadlineFrom > deadlineTo) {
    throw new EuFundingInputError(`deadline_from (${deadlineFrom}) ligt na deadline_to (${deadlineTo}).`);
  }
  const programme = args.programme?.trim() ? resolveEuFundingProgramme(args.programme) : undefined;
  const today = brusselsToday(nowMs);
  const expiryFilter = !args.includeExpired && !status.includes("closed");
  const sortName = args.sort ?? (keywords ? "relevance" : "deadline");

  const base: unknown[] = [
    { terms: { type: type.map((t) => TYPE_CODE[t]) } },
    { terms: { status: status.map((s) => STATUS_CODE[s]) } },
  ];
  if (programme) base.push({ terms: { frameworkProgramme: programme.ids } });
  if (keywords) {
    base.push({ text: { query: keywords, fields: TEXT_FIELDS, defaultOperator: "AND", analyzeWildcard: true, lenient: true, boost: 1 } });
  }
  // One range clause: two clauses on a multi-valued field could each be met by a different deadline.
  const range = (gte?: number, lte?: number) =>
    gte !== undefined || lte !== undefined
      ? [{ range: { deadlineDate: { ...(gte !== undefined ? { gte } : {}), ...(lte !== undefined ? { lte } : {}) } } }]
      : [];
  const userGte = deadlineFrom ? dayStartMs(deadlineFrom) : undefined;
  const lte = deadlineTo ? dayStartMs(deadlineTo) + 86_399_999 : undefined;
  const expiryGte = expiryFilter ? Math.max(dayStartMs(today), userGte ?? 0) : userGte;
  const query = { bool: { must: [...base, ...range(expiryGte, lte)] } };
  const unfilteredQuery = expiryFilter ? { bool: { must: [...base, ...range(userGte, lte)] } } : undefined;

  const offset = Math.max(0, Math.floor(Number.isFinite(args.offset) ? (args.offset as number) : 0));
  let limit = clampEuFundingRows(args.limit);
  let reachableCut = false;
  if (offset + limit > EU_FUNDING_MAX_REACHABLE) {
    limit = Math.max(0, EU_FUNDING_MAX_REACHABLE - offset);
    reachableCut = true;
  }
  return {
    query,
    sort: [...SORTS[sortName], ...TIE_BREAK],
    text: "***",
    keywords,
    status,
    type,
    ...(programme ? { programme } : {}),
    sortName,
    expiryFilter,
    today,
    ...(deadlineFrom ? { deadlineFrom } : {}),
    ...(deadlineTo ? { deadlineTo } : {}),
    ...(unfilteredQuery ? { unfilteredQuery } : {}),
    offset,
    limit,
    plan: limit > 0 ? planEuFundingWindow(offset, limit) : { pageSize: 0, pages: [], skip: 0 },
    ...(reachableCut ? { reachableCut } : {}),
  };
}

/** The request as provenance/dryRun params (strings). */
export function euFundingParams(req: EuFundingRequest): Record<string, string> {
  const params: Record<string, string> = {
    text: req.text,
    languages: '["en"]',
    query: JSON.stringify(req.query),
    sort: JSON.stringify(req.sort),
    pageSize: String(req.plan.pageSize),
    pageNumber: req.plan.pages.join(","),
  };
  if (req.unfilteredQuery) params.count_without_deadline_filter = "pageSize=1&pageNumber=1";
  if (usesNextDeadlineOrder(req)) {
    params.order = "next_deadline: calls with all deadlines ahead (must_not deadline < today) merged with those with a passed cut-off";
  }
  return params;
}

/** Whether search orders by next deadline itself (see EuFundingSource.nextDeadlineWindow). */
function usesNextDeadlineOrder(req: EuFundingRequest): boolean {
  return req.sortName === "deadline" && req.expiryFilter && req.plan.pages.length > 0 && req.offset + req.limit <= NEXT_DEADLINE_MERGE_MAX;
}

// ---------------------------------------------------------------------------
// Transport

interface FormRequest {
  endpoint: string;
  text: string;
  query: unknown;
  sort?: unknown;
  pageSize?: number;
  pageNumber?: number;
}

function formBody(req: FormRequest): FormData {
  const form = new FormData();
  const part = (v: unknown) => new Blob([JSON.stringify(v)], { type: "application/json" });
  form.append("query", part(req.query));
  form.append("languages", part(["en"]));
  if (req.sort) form.append("sort", part(req.sort));
  return form;
}

/**
 * POST a multipart search with the same safeguards utils/http.ts gives other
 * connectors: response cache, circuit breaker, per-connector slots, a timeout
 * (also on the body), one retry on 429/5xx/network errors and a size cap. It is
 * here because http.ts only sends JSON bodies, which this API silently ignores.
 */
async function postForm(req: FormRequest): Promise<{ data: unknown; url: string; cacheHit: boolean }> {
  const u = new URL(req.endpoint);
  u.searchParams.set("apiKey", API_KEY);
  u.searchParams.set("text", req.text);
  if (req.pageSize !== undefined) u.searchParams.set("pageSize", String(req.pageSize));
  if (req.pageNumber !== undefined) u.searchParams.set("pageNumber", String(req.pageNumber));
  const fullUrl = u.toString();
  // The key is the portal's public one, but keys stay out of logs and error details (as in http.ts).
  const url = fullUrl.replace(/([?&]apiKey=)[^&]*/i, "$1***");
  const parts = { query: req.query, languages: ["en"], ...(req.sort ? { sort: req.sort } : {}) };

  markConnectorCall(CONNECTOR);
  const cacheKey = makeHttpCacheKey({ connector: CONNECTOR, method: "POST", url, body: parts });
  const cached = getHttpCache<string>(cacheKey);
  if (cached) {
    markConnectorCacheHit(CONNECTOR);
    return { data: JSON.parse(cached.value), url, cacheHit: true };
  }

  const circuit = getCircuitDecision(CONNECTOR);
  if (circuit.open) {
    throw new SourceRequestError({ message: `Circuit open for connector '${CONNECTOR}'`, endpoint: url, code: "circuit_open", status: 503, retryAfter: circuit.retryAfterS });
  }
  const queued = Date.now();
  let release: (() => void) | undefined;
  try {
    release = await acquireConnectorSlot(CONNECTOR, QUEUE_TIMEOUT_MS);
  } catch {
    markConnectorFailure(CONNECTOR, { countTowardCircuit: false, responseTimeMs: Date.now() - queued });
    throw new SourceRequestError({ message: `Request queue timeout after ${QUEUE_TIMEOUT_MS}ms`, endpoint: url, code: "timeout" });
  }

  try {
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      let status = 0;
      try {
        // A FormData body is consumed by sending it, so every attempt builds its own.
        const response = await fetch(fullUrl, {
          method: "POST",
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          body: formBody(req),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        status = response.status;
        logger.info({ method: "POST", url, connector: CONNECTOR, status, attempt, elapsedMs: Date.now() - started }, "source_request");
        if (status === 429 || status >= 500) {
          await response.body?.cancel().catch(() => undefined);
          if (attempt <= RETRIES) {
            await sleep(attempt * 400);
            continue;
          }
          markConnectorFailure(CONNECTOR, { countTowardCircuit: true, responseTimeMs: Date.now() - queued });
          throw new SourceRequestError({
            message: status === 429 ? `Rate limited by source (${url})` : `Source request failed with status ${status}`,
            endpoint: url,
            code: status === 429 ? "rate_limited" : "http_error",
            status,
          });
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          markConnectorFailure(CONNECTOR, { countTowardCircuit: false, responseTimeMs: Date.now() - queued });
          throw new SourceRequestError({ message: `Source request failed with status ${status}`, endpoint: url, code: "http_error", status });
        }
        const body = await response.text();
        if (body.length > MAX_RESPONSE_CHARS) {
          markConnectorFailure(CONNECTOR, { countTowardCircuit: false, responseTimeMs: Date.now() - queued });
          throw new SourceRequestError({ message: `Response body exceeded ${MAX_RESPONSE_CHARS} characters`, endpoint: url, code: "malformed_response", status });
        }
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          markConnectorFailure(CONNECTOR, { countTowardCircuit: false, responseTimeMs: Date.now() - queued });
          throw new SourceRequestError({ message: "EU Funding & Tenders Portal gaf geen JSON terug.", endpoint: url, code: "malformed_response", status });
        }
        setHttpCache(cacheKey, body, getConnectorCacheTtlMs(CONNECTOR), CONNECTOR, body.length);
        markConnectorSuccess(CONNECTOR, Date.now() - queued);
        return { data, url, cacheHit: false };
      } catch (error) {
        if (error instanceof SourceRequestError) throw error;
        if (attempt <= RETRIES) {
          await sleep(attempt * 400);
          continue;
        }
        const name = (error as { name?: unknown } | undefined)?.name;
        const timedOut = name === "TimeoutError" || name === "AbortError";
        markConnectorFailure(CONNECTOR, { countTowardCircuit: true, responseTimeMs: Date.now() - queued });
        throw new SourceRequestError({
          message: timedOut ? `Source timeout after ${TIMEOUT_MS}ms` : error instanceof Error ? error.message : "Network error while contacting source",
          endpoint: url,
          code: timedOut ? "timeout" : "network_error",
          ...(status ? { status } : {}),
        });
      }
    }
  } finally {
    release?.();
  }
}

function asSearchResponse(data: unknown, endpoint: string): { results: unknown[]; total: number } {
  const o = asRecord(data);
  if (!o || !Array.isArray(o.results) || typeof o.totalResults !== "number") {
    throw new SourceRequestError({
      message: "EU Funding & Tenders Portal gaf een onverwacht antwoord (geen results/totalResults).",
      endpoint,
      code: "malformed_response",
    });
  }
  return { results: o.results, total: o.totalResults };
}

// ---------------------------------------------------------------------------
// Notes

const BASE_NOTE =
  "Bron: EU Funding & Tenders Portal (Europese Commissie), open zoek-API zonder account. Bevat EU-oproepen: topics van calls for proposals " +
  "(subsidies, ook prijzen), cascade funding (oproepen van EU-gefinancierde projecten aan derden) en oproepen van EU extern beleid " +
  "(EuropeAid/PROSPECT); aanbestedingen zijn weggelaten. Nationale en regionale regelingen (RVO, NWO, provincies) staan hier niet in.";

const KEYWORD_NOTE =
  "Zoekwoorden worden gezocht in de Engelse titel, omschrijving, identifier, call, type actie en trefwoorden; alle woorden moeten voorkomen, " +
  "\"aanhalingstekens\" zoeken een frase, OR geeft alternatieven en -woord sluit uit. Het portaal is Engelstalig: Nederlandse zoekwoorden vinden vrijwel niets, zoek dus met Engelse termen.";

const DEADLINE_NOTE =
  "Status zoals het portaal die opgeeft (forthcoming = nog niet open); next_deadline en deadline_passed zijn berekend uit de deadlines in de bron. " +
  "Bij EU-topics bevat de bron alleen de deadlinedatum (het tijdstip staat op de portaalpagina); bij cascade- en externe oproepen een tijdstip in UTC.";

const BUDGET_NOTE =
  "Budget in EUR zoals het portaal het toont: bij een EU-topic de budgetregels van dat topic in het budgetoverzicht van de call (elke regel één keer, alle jaren; " +
  "deelt het topic een regel met andere topics, dan is het de gedeelde pot, zie budget_shared_with), bij cascade funding het totaal beschikbare bedrag van de oproep, " +
  "bij externe oproepen het oproepbudget. Staat er geen bedrag in de bron, dan ontbreekt budget_eur.";

const CASCADE_NOTE =
  "Cascade-oproepen worden door het uitvoerende EU-project zelf gepubliceerd en bijgehouden; hun status en deadline kunnen achterlopen. Controleer de oproep op de pagina van het project.";

function sortNote(req: EuFundingRequest, nextDeadlineOrder: boolean): string | undefined {
  if (req.sortName === "deadline" && nextDeadlineOrder) return "Volgorde: eerstvolgende deadline eerst.";
  if (req.sortName === "deadline") return "Volgorde: vroegste deadline eerst; bij oproepen met meerdere deadlines telt de vroegste, ook als die al voorbij is.";
  if (req.sortName === "deadline_desc") return "Volgorde: laatste deadline eerst (per oproep de laatste deadline).";
  if (req.sortName === "newest") return "Volgorde: nieuwste openings- of publicatiedatum eerst.";
  if (req.sortName === "oldest") return "Volgorde: oudste openings- of publicatiedatum eerst.";
  if (req.sortName === "relevance" && !req.keywords) return "Volgorde: relevantie zonder zoekwoorden is willekeurig; kies liever sort 'deadline'.";
  return undefined;
}

function nl(n: number): string {
  return n.toLocaleString("nl-NL");
}

// ---------------------------------------------------------------------------
// Source

export interface EuFundingSearchResult {
  items: EuFundingItem[];
  /** Total matches upstream (after the expiry filter); null when no search ran. */
  total: number | null;
  offset: number;
  limit: number;
  query: string;
  filters: Record<string, string>;
  sort: EuFundingSort;
  /** Items the portal labels open/forthcoming that the expiry filter left out; undefined when not counted. */
  expired_hidden?: number;
  programme?: ProgrammeResolution;
  endpoint: string;
  params: Record<string, string>;
  access_note: string;
}

export interface EuFundingAction {
  status: EuFundingStatus | "unknown";
  types_of_action: string[];
  opening_date?: string;
  deadlines: string[];
  deadline_model?: string;
}

export interface EuFundingDetail extends EuFundingItem {
  description?: string;
  conditions?: string;
  /** Cascade funding: how to apply and how proposals are evaluated, as the project states it. */
  application_info?: string;
  further_information?: string;
  /** Cascade funding: the project's own text on timing ("duration"). */
  timing_info?: string;
  /** Names of the text fields that were cut at max_chars. */
  truncated: string[];
  /** Grant: this topic's budget lines in the call's budget overview. */
  budget_lines?: EuBudgetLine[];
  /** Grant: the whole call's budget overview (lines counted once; shown up to 40). */
  call_budget?: { lines_total: number; lines: EuBudgetLine[]; total_eur?: number; years: string[] };
  actions?: EuFundingAction[];
  latest_infos?: Array<{ date?: string; text: string }>;
  submission_links?: Array<{ type_of_action?: string; grant_agreement_type?: string; url: string; opens?: string; closes?: string }>;
  documents?: Array<{ name: string; type?: string; language?: string; date?: string; url: string }>;
  beneficiary_administration?: string;
}

export interface EuFundingGetResult {
  item?: EuFundingDetail;
  /** Several items fit: pick one by id. */
  candidates?: EuFundingItem[];
  /** call_topics: the input is a call; cascade_calls: a topic with only cascade calls; number_collision: both kinds of call. */
  candidates_kind?: "call_topics" | "cascade_calls" | "number_collision";
  /** Grant: cascade funding calls run under this topic by EU-funded projects. */
  cascade_calls?: { total: number; shown: EuFundingItem[] };
  input: string;
  endpoint: string;
  params: Record<string, string>;
  access_note: string;
}

type IdShape = { kind: "topic"; value: string } | { kind: "number"; value: string };

/**
 * What eu_funding_get was given: a topic identifier, a cascade call number, an
 * EuropeAid reference or call number, or a portal/PROSPECT URL of one of those.
 */
export function parseEuFundingId(input: string): IdShape | undefined {
  const v = input.trim();
  if (!v) return undefined;
  const fromUrl =
    v.match(/topic-details\/([^/?#\s]+)/i)?.[1] ??
    v.match(/data\/topicDetails\/([^/?#\s]+?)(?:\.json)?(?:[?#]|$)/i)?.[1];
  if (fromUrl) {
    const decoded = decodeURIComponent(fromUrl);
    const prospect = decoded.match(/^(\d+)PROSPECTS?EN$/i);
    return prospect ? { kind: "number", value: prospect[1] } : { kind: "topic", value: decoded };
  }
  const number =
    v.match(/competitive-calls-cs(?:-old)?\/(\d+)/i)?.[1] ??
    v.match(/prospect-details\/(\d+)/i)?.[1] ??
    v.match(/[?&]callId=(\d+)/i)?.[1] ??
    v.match(/^europeaid\/(\d+)\//i)?.[1] ??
    v.match(/^(\d+)PROSPECTS?EN$/i)?.[1] ??
    v.match(/^(\d+)$/)?.[1];
  if (number) return { kind: "number", value: number };
  if (/^https?:\/\//i.test(v)) return undefined;
  return { kind: "topic", value: v };
}

export class EuFundingSource {
  /** Programme names learned from the facet endpoint for ids missing from the table. */
  private readonly extraProgrammes = new Map<string, EuFundingProgramme>();

  constructor(private readonly config: AppConfig) {}

  private async fetchPage(query: unknown, sort: unknown, pageSize: number, pageNumber: number): Promise<{ results: unknown[]; total: number; url: string }> {
    const { data, url } = await postForm({ endpoint: EU_FUNDING_SEARCH_ENDPOINT, text: "***", query, sort, pageSize, pageNumber });
    return { ...asSearchResponse(data, url), url };
  }

  /** Names for programme ids not in the table, via the facet endpoint; failures only cost the names. */
  private async learnProgrammes(ids: string[]): Promise<void> {
    const unknown = [...new Set(ids)].filter((id) => !PROGRAMME_BY_ID.has(id) && !this.extraProgrammes.has(id));
    if (!unknown.length) return;
    try {
      const { data } = await postForm({ endpoint: EU_FUNDING_FACET_ENDPOINT, text: "***", query: { bool: { must: [{ terms: { frameworkProgramme: unknown } }] } } });
      const facets = asRecord(data)?.facets;
      const fp = Array.isArray(facets) ? facets.map(asRecord).find((f) => f?.name === "frameworkProgramme") : undefined;
      for (const v of Array.isArray(fp?.values) ? fp.values : []) {
        const o = asRecord(v);
        if (typeof o?.rawValue === "string" && typeof o.value === "string" && unknown.includes(o.rawValue)) {
          this.extraProgrammes.set(o.rawValue, parseProgrammeLabel(o.rawValue, o.value));
        }
      }
    } catch {
      // Only the programme name is missing then; the id stays in the record.
    }
  }

  private async items(rows: unknown[], nowMs: number): Promise<EuFundingItem[]> {
    const ids = rows.map((r) => first(asRecord(asRecord(r)?.metadata) ?? {}, "frameworkProgramme")).filter((id): id is string => !!id);
    await this.learnProgrammes(ids);
    return rows.map((r) => toEuFundingItem(r, nowMs, this.extraProgrammes)).filter((x): x is EuFundingItem => !!x);
  }

  /**
   * The window in order of next deadline. Upstream sorts a multi-valued field by its
   * smallest value, so a call with a cut-off that has passed (24 of 534 open ones)
   * would come first by that old date. Calls whose deadlines all lie ahead are in
   * the right order upstream; the few with a passed cut-off are fetched whole and
   * merged in. The first offset+limit of the former are enough for the window.
   * Undefined (upstream order instead) when the latter do not fit in one page.
   */
  private async nextDeadlineWindow(req: EuFundingRequest, nowMs: number): Promise<{ items: EuFundingItem[]; total: number; params: Record<string, string> } | undefined> {
    const must = (req.query as { bool: { must: unknown[] } }).bool.must;
    const passedCutOff = { range: { deadlineDate: { lt: dayStartMs(req.today) } } };
    const withPassed = { bool: { must: [...must, passedCutOff] } };
    const allAhead = { bool: { must, must_not: [passedCutOff] } };
    const passed = await this.fetchPage(withPassed, req.sort, EU_FUNDING_MAX_ROWS, 1);
    if (passed.total > passed.results.length) return undefined;
    const want = req.offset + req.limit;
    const size = Math.min(want, EU_FUNDING_MAX_ROWS);
    const ahead: unknown[] = [];
    let aheadTotal: number | undefined;
    const pages: number[] = [];
    for (let page = 1; page <= Math.ceil(want / size); page++) {
      const parsed = await this.fetchPage(allAhead, req.sort, size, page);
      pages.push(page);
      aheadTotal ??= parsed.total;
      ahead.push(...parsed.results);
      if (parsed.results.length < size) break;
    }
    const key = (x: EuFundingItem) => {
      const d = x.next_deadline;
      return d ? (d.length === 10 ? dayStartMs(d) : Date.parse(d)) : Number.MAX_SAFE_INTEGER;
    };
    const items = (await this.items([...ahead.slice(0, want), ...passed.results], nowMs)).sort(
      (a, b) => key(a) - key(b) || a.identifier.localeCompare(b.identifier) || a.id.localeCompare(b.id),
    );
    return {
      items: items.slice(req.offset, req.offset + req.limit),
      total: (aheadTotal ?? 0) + passed.total,
      params: {
        query: JSON.stringify(allAhead),
        pageSize: String(size),
        pageNumber: pages.join(","),
        query_passed_cut_off: JSON.stringify(withPassed),
        query_passed_cut_off_page: `pageSize=${EU_FUNDING_MAX_ROWS}&pageNumber=1`,
        order: "next_deadline (merged)",
      },
    };
  }

  /**
   * Search calls. With status open and/or forthcoming (the default) calls without a
   * deadline today or later are left out, because the index keeps outdated copies
   * with their old status; how many is counted with one extra request and reported.
   */
  async search(args: EuFundingSearchArgs, nowMs: number = Date.now()): Promise<EuFundingSearchResult> {
    const req = buildEuFundingRequest(args, nowMs);
    const filters: Record<string, string> = { status: req.status.join(","), type: req.type.join(",") };
    if (req.programme) filters.programme = req.programme.programmes.map((p) => p.abbreviation ?? p.id).join(",") || req.programme.ids.join(",");
    if (req.deadlineFrom) filters.deadline_from = req.deadlineFrom;
    if (req.deadlineTo) filters.deadline_to = req.deadlineTo;
    if (req.expiryFilter) filters.hide_expired = `deadline >= ${req.today}`;

    const notes: string[] = [BASE_NOTE];
    const params = euFundingParams(req);
    const base = { offset: req.offset, limit: req.limit, query: req.keywords, filters, sort: req.sortName, ...(req.programme ? { programme: req.programme } : {}) };

    if (!req.plan.pages.length) {
      notes.push(`Het portaal geeft alleen de eerste ${nl(EU_FUNDING_MAX_REACHABLE)} resultaten van een zoekvraag; offset ${nl(req.offset)} valt daarbuiten. Verfijn de zoekvraag.`);
      return { ...base, items: [], total: null, endpoint: EU_FUNDING_SEARCH_ENDPOINT, params, access_note: notes.join(" ") };
    }

    const countUnfiltered = req.unfilteredQuery
      ? this.fetchPage(req.unfilteredQuery, req.sort, 1, 1).then((p) => p.total, () => undefined)
      : Promise.resolve(undefined);
    let items: EuFundingItem[];
    let total: number;
    const merged = usesNextDeadlineOrder(req) ? await this.nextDeadlineWindow(req, nowMs) : undefined;
    if (merged) {
      ({ items, total } = merged);
      Object.assign(params, merged.params);
    } else {
      // Upstream order after all (merge not possible): the planned "order" no longer applies.
      delete params.order;
      const rows: unknown[] = [];
      let upstreamTotal: number | undefined;
      const fetched: number[] = [];
      for (const page of req.plan.pages) {
        if (upstreamTotal !== undefined && (page - 1) * req.plan.pageSize >= upstreamTotal) break;
        const parsed = await this.fetchPage(req.query, req.sort, req.plan.pageSize, page);
        fetched.push(page);
        upstreamTotal ??= parsed.total;
        rows.push(...parsed.results);
        if (parsed.results.length < req.plan.pageSize) break;
      }
      items = await this.items(rows.slice(req.plan.skip, req.plan.skip + req.limit), nowMs);
      total = upstreamTotal ?? 0;
      params.pageNumber = fetched.join(",") || "1";
    }
    const unfilteredTotal = await countUnfiltered;

    let expiredHidden: number | undefined;
    if (req.expiryFilter && unfilteredTotal !== undefined) {
      expiredHidden = Math.max(0, unfilteredTotal - total);
      if (expiredHidden > 0) {
        notes.push(
          `Weggelaten: ${nl(expiredHidden)} van de ${nl(unfilteredTotal)} oproepen die het portaal als ${req.status.join("/")} aanduidt, ` +
            `hebben geen deadline vanaf vandaag (${req.today}) meer. De index van het portaal bewaart van veel topics verouderde kopieën met hun oude status. ` +
            "Zet include_expired=true om ze toch te zien.",
        );
      }
    } else if (req.expiryFilter) {
      notes.push(`Alleen oproepen met een deadline vanaf vandaag (${req.today}); hoeveel als open aangeduide oproepen daardoor wegvielen, kon niet worden geteld.`);
    } else if (items.some((x) => x.status !== "closed" && x.deadline_passed)) {
      notes.push("Let op: sommige oproepen heten in het portaal nog open of forthcoming terwijl al hun deadlines voorbij zijn (deadline_passed); vaak een verouderde kopie (outdated_index_record).");
    }
    // A copy with a deadline still ahead passes the filter above, though the current record may differ.
    const copies = items.filter((x) => x.outdated_index_record && x.status !== "closed" && !x.deadline_passed);
    if (copies.length) {
      notes.push(
        `${copies.map((x) => x.id).join(", ")}: alleen een verouderde kopie in de index (outdated_index_record); ` +
          "status en deadlines kunnen afwijken van het actuele record, dat eu_funding_get leest.",
      );
    }
    if (req.keywords) notes.push(KEYWORD_NOTE);
    if (req.programme) {
      notes.push(
        `Programma '${req.programme.input}' opgevat als: ${req.programme.programmes.length ? req.programme.programmes.map((p) => p.label).join("; ") : `id ${req.programme.ids.join(", ")} (niet in de lijst met bekende programma's)`}.`,
      );
    }
    if (req.deadlineFrom || req.deadlineTo) {
      notes.push("Deadlinefilter: een oproep telt mee als één van zijn deadlines in de periode valt.");
    }
    if (req.expiryFilter && req.deadlineTo && req.deadlineTo < req.today) {
      notes.push(`deadline_to (${req.deadlineTo}) ligt vóór vandaag; open of binnenkort openende oproepen hebben daar geen deadline meer. Gebruik status 'closed' of include_expired=true.`);
    }
    notes.push(DEADLINE_NOTE);
    if (items.length) notes.push(BUDGET_NOTE);
    if (items.some((x) => x.type === "cascade_funding")) notes.push(CASCADE_NOTE);
    const order = sortNote(req, !!merged);
    if (order) notes.push(order);
    if (req.reachableCut || total > EU_FUNDING_MAX_REACHABLE) {
      notes.push(`Het portaal geeft hooguit 100 resultaten per verzoek en alleen de eerste ${nl(EU_FUNDING_MAX_REACHABLE)} van een zoekvraag.`);
    }
    if (total === 0 && req.keywords) {
      notes.push("Geen treffers: alle zoekwoorden moeten voorkomen; probeer minder of Engelstalige zoekwoorden.");
    }

    return {
      ...base,
      items,
      total,
      ...(expiredHidden !== undefined ? { expired_hidden: expiredHidden } : {}),
      endpoint: EU_FUNDING_SEARCH_ENDPOINT,
      params,
      access_note: notes.join(" "),
    };
  }

  /**
   * One call by id (see parseEuFundingId). A topic identifier also matches the
   * cascade calls run under that topic and, for older topics, an outdated index
   * copy; the current record of the topic itself is returned, the cascade calls
   * are counted. Several cascade calls only (no topic record) are returned as
   * candidates instead of picking one.
   */
  async get(input: string, options: { maxChars?: number } = {}, nowMs: number = Date.now()): Promise<EuFundingGetResult> {
    const maxChars = Math.min(EU_FUNDING_MAX_CHARS, Math.max(200, Math.floor(options.maxChars ?? EU_FUNDING_DEFAULT_MAX_CHARS)));
    const shape = parseEuFundingId(input);
    const notes: string[] = [BASE_NOTE];
    if (!shape) {
      throw new EuFundingInputError(
        "Geef een topic-identifier (bijv. 'HORIZON-CL5-2027-02-D3-01'), het nummer van een cascade-oproep, een EuropeAid-referentie of een portaal-URL.",
      );
    }

    const typeTerms = shape.kind === "number" ? ["2", "8"] : ["1", "2", "8"];
    const lookup =
      shape.kind === "number"
        ? { bool: { should: [{ terms: { callccm2Id: [shape.value] } }, { terms: { callIdentifier: [shape.value] } }] } }
        : { terms: { identifier: [shape.value] } };
    let query: Record<string, unknown> = { bool: { must: [{ terms: { type: typeTerms } }, lookup] } };
    let page = await this.fetchPage(query, TIE_BREAK, EU_FUNDING_MAX_ROWS, 1);
    let hits = page.results.map(asHit).filter((h): h is EuSearchHit => !!h);
    // identifier is matched exactly (case-sensitive); retry case-insensitively on the analysed field.
    if (shape.kind === "topic" && !hits.length) {
      const phrase = `"${shape.value.replace(/"/g, " ").trim()}"`;
      query = { bool: { must: [{ terms: { type: typeTerms } }, { text: { query: phrase, fields: ["identifier"], defaultOperator: "AND", lenient: true } }] } };
      page = await this.fetchPage(query, TIE_BREAK, EU_FUNDING_MAX_ROWS, 1);
      const wanted = shape.value.toLowerCase();
      hits = page.results.map(asHit).filter((h): h is EuSearchHit => !!h && first(h.metadata, "identifier")?.toLowerCase() === wanted);
    }
    // Not a topic: maybe the identifier of a call, whose topics are then the candidates.
    let callTopics = false;
    if (shape.kind === "topic" && !hits.length) {
      query = { bool: { must: [{ terms: { type: ["1"] } }, { terms: { callIdentifier: [shape.value] } }] } };
      page = await this.fetchPage(query, TIE_BREAK, EU_FUNDING_MAX_ROWS, 1);
      hits = page.results.map(asHit).filter((h): h is EuSearchHit => !!h && !isOutdatedCopy(h.url));
      callTopics = hits.length > 0;
    }
    const params: Record<string, string> = { text: "***", languages: '["en"]', query: JSON.stringify(query), sort: JSON.stringify(TIE_BREAK), pageSize: String(EU_FUNDING_MAX_ROWS), pageNumber: "1" };
    const base = { input: input.trim(), endpoint: EU_FUNDING_SEARCH_ENDPOINT, params };

    if (!hits.length) {
      notes.push(
        `Niets gevonden voor '${input.trim()}'. Een topic-identifier moet volledig zijn (bijv. 'HORIZON-CL5-2027-02-D3-01'); zoek anders met eu_funding_search op trefwoorden.`,
      );
      return { ...base, access_note: notes.join(" ") };
    }
    await this.learnProgrammes(hits.map((h) => first(h.metadata, "frameworkProgramme")).filter((id): id is string => !!id));

    if (callTopics) {
      const candidates = await this.items(hits, nowMs);
      notes.push(
        `'${input.trim()}' is een call met ${nl(page.total)} topic${page.total === 1 ? "" : "s"} (candidates${page.total > candidates.length ? `, de eerste ${candidates.length}` : ""}); haal één topic op met zijn identifier.`,
        DEADLINE_NOTE,
      );
      return { ...base, candidates, candidates_kind: "call_topics", access_note: notes.join(" ") };
    }

    const newest = (list: EuSearchHit[]) =>
      [...list].sort((a, b) => (first(b.metadata, "esDA_IngestDate") ?? "").localeCompare(first(a.metadata, "esDA_IngestDate") ?? ""));
    const pick = (code: string): EuSearchHit | undefined => {
      const ofType = hits.filter((h) => first(h.metadata, "type") === code);
      return newest(ofType.filter((h) => !isOutdatedCopy(h.url)))[0] ?? newest(ofType)[0];
    };
    const cascades = hits.filter((h) => first(h.metadata, "type") === "8");
    const external = pick("2");
    // A number can be both a cascade call and an external action call: do not choose.
    const collision = shape.kind === "number" && !!external && cascades.length > 0;
    const chosen = collision ? undefined : pick("1") ?? external ?? (cascades.length === 1 ? cascades[0] : undefined);

    if (!chosen) {
      const pool = collision && external ? [external, ...cascades] : cascades;
      const candidates = (await this.items(pool, nowMs)).sort((a, b) => (b.next_deadline ?? "").localeCompare(a.next_deadline ?? ""));
      notes.push(
        collision
          ? `Nummer ${shape.value} is zowel een cascade-oproep als een externe oproep (zie candidates); geef de EuropeAid-referentie of de portaal-URL.`
          : `'${input.trim()}' is het EU-topic waaronder ${nl(cascades.length)} cascade-oproepen van projecten vallen (zie candidates); er is geen record van het topic zelf. ` +
              "Haal één oproep op met zijn id (het nummer, cascade_call_id).",
      );
      notes.push(CASCADE_NOTE);
      return { ...base, candidates, candidates_kind: collision ? "number_collision" : "cascade_calls", access_note: notes.join(" ") };
    }

    const item = this.detail(chosen, nowMs, maxChars);
    if (!item) {
      notes.push(`Het record voor '${input.trim()}' kon niet worden gelezen.`);
      return { ...base, access_note: notes.join(" ") };
    }
    const result: EuFundingGetResult = { ...base, item, access_note: "" };
    if (item.type === "grant" && cascades.length) {
      const shown = (await this.items(cascades, nowMs))
        .sort((a, b) => Number(!!a.deadline_passed) - Number(!!b.deadline_passed) || (a.next_deadline ?? "").localeCompare(b.next_deadline ?? ""))
        .slice(0, RELATED_SHOWN);
      result.cascade_calls = { total: cascades.length, shown };
      notes.push(`Onder dit topic lopen ${nl(cascades.length)} cascade-oproepen van EU-gefinancierde projecten (cascade_calls; de eerste ${shown.length}, nog lopende eerst).`);
    }
    if (item.outdated_index_record) {
      notes.push("Van dit item staat alleen een verouderde kopie in de index van het portaal; status en deadlines kunnen achterlopen. Controleer de portaalpagina.");
    } else if (hits.some((h) => h !== chosen && isOutdatedCopy(h.url) && first(h.metadata, "type") === first(chosen.metadata, "type"))) {
      notes.push("De index bevat ook een verouderde kopie van dit item met een oude status; die is genegeerd.");
    }
    if (item.status !== "closed" && item.deadline_passed) {
      notes.push(`Het portaal noemt de status '${item.status}', maar alle deadlines zijn voorbij.`);
    }
    notes.push(DEADLINE_NOTE, BUDGET_NOTE);
    if (item.type === "grant" && item.call_budget) {
      notes.push("call_budget: alle budgetregels van de call, elke regel één keer geteld (regels die topics delen niet dubbel); bedragen van 0 in het overzicht gelden als niet opgegeven.");
    }
    if (item.type === "cascade_funding") notes.push(CASCADE_NOTE);
    if (item.truncated.length) notes.push(`Ingekort tot ${nl(maxChars)} tekens: ${item.truncated.join(", ")}; verhoog max_chars of lees de portaalpagina.`);
    result.access_note = notes.join(" ");
    return result;
  }

  private detail(hit: EuSearchHit, nowMs: number, maxChars: number): EuFundingDetail | undefined {
    const item = toEuFundingItem(hit, nowMs, this.extraProgrammes);
    if (!item) return undefined;
    const meta = hit.metadata;
    const detail: EuFundingDetail = { ...item, truncated: [] };
    delete detail.description_short;
    const text = (key: keyof EuFundingDetail, field: string) => {
      const raw = first(meta, field);
      if (!raw) return;
      const t = cut(htmlToText(raw), maxChars);
      if (!t.text) return;
      (detail as unknown as Record<string, unknown>)[key] = t.text;
      if (t.cut) detail.truncated.push(String(key));
    };

    if (item.type === "grant") {
      text("description", "descriptionByte");
      text("conditions", "topicConditions");
      const lines = parseBudgetOverview(jsonField(meta, "budgetOverview"));
      if (lines.length) {
        const own = topicBudget(lines, item.identifier);
        if (own.lines.length) detail.budget_lines = own.lines;
        const total = lines.reduce((s, l) => s + l.budget_eur, 0);
        const years = [...new Set(lines.flatMap((l) => Object.keys(l.budget_by_year)))].sort();
        detail.call_budget = { lines_total: lines.length, lines: lines.slice(0, CALL_BUDGET_ROWS_SHOWN), ...(total > 0 ? { total_eur: total } : {}), years };
      }
      const actions = jsonField(meta, "actions");
      if (Array.isArray(actions)) {
        detail.actions = actions.map(asRecord).filter((a): a is Record<string, unknown> => !!a).map((a) => {
          const types = Array.isArray(a.types) ? a.types.map((t) => asRecord(t)?.typeOfAction).filter((t): t is string => typeof t === "string") : [];
          const deadlines = Array.isArray(a.deadlineDates) ? a.deadlineDates.map((d) => normalizeEuDate(d) ?? epochDate(d)).filter((d): d is string => !!d) : [];
          const model = asRecord(a.submissionProcedure)?.abbreviation;
          const opening = normalizeEuDate(a.plannedOpeningDate) ?? epochDate(a.plannedOpeningDate);
          return {
            status: statusOf(String(asRecord(a.status)?.id ?? "")),
            types_of_action: types.map((t) => t.replace(/\s+/g, " ")),
            ...(opening ? { opening_date: opening } : {}),
            deadlines: sortDeadlines(deadlines),
            ...(typeof model === "string" && model ? { deadline_model: model } : {}),
          };
        });
      }
      const links = jsonField(meta, "links");
      if (Array.isArray(links)) {
        detail.submission_links = links.map(asRecord).filter((l): l is Record<string, unknown> => !!l && typeof l.url === "string").map((l) => {
          const opens = epochDate(l.startDate);
          const closes = epochDate(l.endDate);
          return {
            ...(typeof l.criterionDescription === "string" ? { type_of_action: l.criterionDescription } : {}),
            ...(typeof l.mgaDescription === "string" ? { grant_agreement_type: l.mgaDescription } : {}),
            url: String(l.url),
            ...(opens ? { opens } : {}),
            ...(closes ? { closes } : {}),
          };
        });
      }
    }
    if (item.type === "cascade_funding") {
      text("description", "description");
      text("application_info", "beneficiaryAdministration");
      text("further_information", "furtherInformation");
      text("timing_info", "duration");
    }
    if (item.type === "external_action") {
      const admin = first(meta, "beneficiaryAdministration")?.replace(/^[:\s]+/, "");
      if (admin) detail.beneficiary_administration = admin;
      const docs = jsonField(meta, "publicationDocuments");
      if (Array.isArray(docs)) {
        detail.documents = docs.map(asRecord).filter((d): d is Record<string, unknown> => !!d && typeof d.docUrl === "string").map((d) => {
          const date = typeof d.finalPublicDocDate === "string" ? d.finalPublicDocDate.slice(0, 10) : undefined;
          return {
            name: String(d.nameDoc ?? "document"),
            ...(typeof d.typeDoc === "string" ? { type: d.typeDoc } : {}),
            ...(typeof d.languageDoc === "string" ? { language: d.languageDoc } : {}),
            ...(date ? { date } : {}),
            url: String(d.docUrl),
          };
        });
      }
    }
    const infos = jsonField(meta, "latestInfos");
    if (Array.isArray(infos)) {
      const list = infos
        .map(asRecord)
        .filter((i): i is Record<string, unknown> => !!i && typeof i.content === "string")
        .map((i) => ({ date: typeof i.lastChangeDate === "string" ? i.lastChangeDate.slice(0, 10) : undefined, text: cut(htmlToText(String(i.content)), 400).text }))
        .filter((i) => i.text)
        .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
        .slice(0, LATEST_INFOS_SHOWN)
        .map((i) => (i.date ? i : { text: i.text }));
      if (list.length) detail.latest_infos = list;
    }
    return detail;
  }
}

const TYPE_LABEL: Record<EuFundingType, string> = {
  grant: "EU-topic",
  cascade_funding: "cascade-oproep",
  external_action: "externe oproep",
};

function euro(n: number): string {
  return `€ ${Math.round(n).toLocaleString("nl-NL")}`;
}

/** "Horizon Europe (HORIZON) · open · deadline 2027-02-02 · € 52.500.000" for a record snippet. */
export function describeEuFundingItem(x: EuFundingItem): string {
  const deadline = x.next_deadline
    ? `deadline ${x.next_deadline}${x.deadlines.length > 1 ? ` (${x.deadlines.length} deadlines)` : ""}`
    : x.deadlines.length
      ? `deadline voorbij (${x.deadlines.at(-1)})`
      : "";
  const budget = x.budget_eur !== undefined ? `${euro(x.budget_eur)}${x.budget_scope === "shared_budget_line" ? " (gedeeld)" : ""}` : "";
  const who = x.type === "cascade_funding" && x.project_acronym ? `project ${x.project_acronym}` : "";
  // An outdated copy's status and deadlines can lag behind the current record (eu_funding_get reads that one).
  const status = x.outdated_index_record ? `${x.status} volgens een verouderde kopie in de index` : x.status;
  return [TYPE_LABEL[x.type], x.programme_abbreviation ?? x.programme, who, status, deadline, budget].filter(Boolean).join(" · ");
}

/** One-line summary for eu_funding_search. */
export function summarizeEuFundingSearch(out: EuFundingSearchResult): string {
  if (out.total === null) return "Geen zoekopdracht uitgevoerd in het EU Funding & Tenders Portal (zie access_note).";
  const statusText = out.filters.status?.split(",").join("/") ?? "";
  let s = `${nl(out.total)} EU-oproepen (${statusText}) in het Funding & Tenders Portal`;
  if (out.query) s += ` voor '${out.query}'`;
  if (out.programme) s += ` in ${out.programme.programmes.map((p) => p.abbreviation ?? p.name).join("/") || out.programme.ids.join("/")}`;
  if (out.filters.deadline_from || out.filters.deadline_to) s += ` met deadline ${out.filters.deadline_from ?? "…"} t/m ${out.filters.deadline_to ?? "…"}`;
  if (out.items.length) s += `; getoond ${out.offset + 1}-${out.offset + out.items.length}`;
  else if (out.total && out.offset >= out.total) s += `; geen resultaten vanaf offset ${out.offset}`;
  if (out.expired_hidden) s += `; ${nl(out.expired_hidden)} als open aangeduide oproepen zonder resterende deadline weggelaten`;
  return s;
}

/** One-line summary for eu_funding_get. */
export function summarizeEuFundingGet(out: EuFundingGetResult): string {
  if (out.item) {
    const x = out.item;
    return `${x.title} (${x.id}): ${describeEuFundingItem(x)}`;
  }
  if (out.candidates?.length) {
    const n = out.candidates.length;
    if (out.candidates_kind === "call_topics") return `'${out.input}' is een call met ${n} ${n === 1 ? "topic" : "topics"}; kies er één op identifier.`;
    if (out.candidates_kind === "number_collision") return `Nummer '${out.input}' past op ${n} oproepen van verschillende soort; kies er één op id.`;
    return `${n} cascade-oproepen onder EU-topic '${out.input}'; kies er één op id.`;
  }
  return `Geen EU-oproep gevonden voor '${out.input}'.`;
}
