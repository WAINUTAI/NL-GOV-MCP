import type { AppConfig } from "../types.js";
import { getJson, SourceRequestError } from "../utils/http.js";
import { htmlToText } from "../utils/html-text.js";
import {
  fetchPdfText,
  restoreSubstitutedGlyphs,
  MAX_PDF_TEXT_CHARS,
  type PdfTextError,
  type PdfTextResult,
} from "../utils/pdf-text.js";

/**
 * TenderNed — the Dutch national public-procurement platform.
 *
 * Every Dutch contracting authority (Rijk, provincie, gemeente, waterschap,
 * zorg- and onderwijsinstelling) publishes its tender notices and awards here,
 * which makes it the missing "what does the government actually buy, from whom,
 * for how much" source alongside Rijksbegroting (planned) and Iv3 (spent).
 *
 * Keyless public API (`papi`), the same one tenderned.nl's own front end calls.
 * Verified server-side parameters on /publicaties: search, typeOpdracht,
 * procedure, publicatieDatumVanaf/-Tot, aanbestedendeDienstId (repeatable; ids
 * from /aanbestedendediensten), sort (relevantie | tappublicatiedatum), page
 * (0..99) and size (1..100). Unknown parameters are silently ignored by the
 * upstream, so only send verified ones — an unsupported filter would look like
 * it worked and quietly return everything.
 *
 * Detail data is spread over sibling endpoints: /publicaties/{id} (metadata),
 * /{id}/gerelateerd (other notices of the same procedure — the metadata itself
 * never carries them), /{id}/html (a labelled rendering of the notice with
 * values, winners and contract dates) and /{id}/pdf (the official notice).
 */
const BASE = "https://www.tenderned.nl/papi/tenderned-rs-tns/v2";
const PUBLICATIES = `${BASE}/publicaties`;
const AANBESTEDENDE_DIENSTEN = `${BASE}/aanbestedendediensten`;
const CONNECTOR = "tenderned";
/** Upstream rejects size > 100 with HTTP 400. */
const MAX_PAGE_SIZE = 100;
/** Upstream rejects page > 99 with HTTP 400, whatever the page size. */
const MAX_PAGE_INDEX = 99;
/** So only the first (99 + 1) * 100 results of any query can be reached. */
export const TENDERNED_MAX_REACHABLE = (MAX_PAGE_INDEX + 1) * MAX_PAGE_SIZE;
/** One lookup page; the register endpoint rejects larger pages. */
const AUTHORITY_LOOKUP_SIZE = 100;
/** Ids are repeated in the query string; keep the URL well under server limits. */
const MAX_AUTHORITY_IDS = 50;
/**
 * The register of contracting authorities (~2,700 names, 28 pages) changes
 * slowly; it is read whole and kept this long, because the register's own
 * search is accent- and apostrophe-sensitive ("Fryslan" misses "Fryslân").
 */
const AUTHORITY_REGISTER_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * TenderNed's search index keeps the closing date of the original notice; a
 * rectification only updates the detail record. Search re-reads the detail of
 * notices whose indexed deadline is at most this old (rectifications seen
 * moved deadlines by up to ~4 months) ...
 */
const DEADLINE_RECHECK_DAYS = 180;
/** ... for at most this many notices per call, latest deadlines first. */
const MAX_DEADLINE_CHECKS = 50;
/**
 * Those rechecks are best-effort enrichment of a search that already
 * succeeded, so they run on their own connector: a slow or failing detail
 * endpoint must neither open the circuit breaker for every TenderNed tool nor
 * occupy the connector slots that search and get need (the same split as
 * luchtmeetnet / luchtmeetnet_lki).
 */
const RECHECK_CONNECTOR = "tenderned_recheck";
/** Requests in flight per search (the HTTP layer runs at most 3 per connector). */
const RECHECK_CONCURRENCY = 3;
/** Wall-clock time all rechecks of one search may add; 50 take under 1 s when TenderNed is healthy. */
const RECHECK_BUDGET_MS = 3_000;
/** TenderNed fills "no real deadline" closing dates with dates like 2099-12-31 or 2125-12-31. */
const PLACEHOLDER_DATE_YEAR = 2090;
/** An amount under this is a placeholder ("1 Euro") or a rate, never a contract value. */
const PLACEHOLDER_VALUE_EUR = 1000;
const VIEWER_BASE = "https://www.tenderned.nl/aankondigingen/overzicht";

export type TenderTypeOpdracht = "leveringen" | "diensten" | "werken" | "all";
export type TenderSort = "relevance" | "date_newest";

const TYPE_OPDRACHT_CODE: Record<Exclude<TenderTypeOpdracht, "all">, string> = {
  leveringen: "L",
  diensten: "D",
  werken: "W",
};

/** The two sort keys tenderned.nl's own search page sends. */
const SORT_PARAM: Record<TenderSort, string> = {
  relevance: "relevantie",
  date_newest: "tappublicatiedatum",
};

export type SluitingsDatumBron = "sluitingsDatum" | "sluitingsDatumMarktconsultatie" | "";

export interface TenderNedItem {
  id: string;
  title: string;
  opdrachtgever: string;
  publicatieDatum: string;
  sluitingsDatum: string;
  /** Which upstream field `sluitingsDatum` was taken from. */
  sluitingsDatumBron: SluitingsDatumBron;
  /** True for TenderNed's "no real deadline" dates (year 2090 or later). */
  sluitingsDatumPlaceholder: boolean;
  /**
   * True when `sluitingsDatum` comes from (or was checked against) the detail
   * record, which carries rectifications; false when it is the search index's
   * date of the original notice.
   */
  sluitingsDatumGecontroleerd: boolean;
  /** Search only: the search index's closing date, when the detail record has another one. */
  sluitingsDatumOorspronkelijk?: string;
  /** Id of the latest rectification of this notice, when TenderNed reports one. */
  laatsteRectificatieId?: string;
  /** Notice type as shown on tenderned.nl (AAO, AGO, MAC, VBE, REC, ...). */
  typePublicatie: string;
  typePublicatieCode: string;
  /** eForms/TED form behind the notice (EF16, EF29, EFE1, SF03, ...). */
  publicatieCode: string;
  publicatieCodeOmschrijving: string;
  procedure: string;
  typeOpdracht: string;
  europees: boolean | null;
  beschrijving: string;
  kenmerk: string;
  url: string;
}

export interface TenderNedValue {
  /** The amount as printed, e.g. "800 000 Euro" or "1,00 EUR". */
  tekst: string;
  euro: number | null;
  /** True below € 1.000: a placeholder ("1 Euro") or a rate, not a contract value. */
  placeholder: boolean;
}

export interface TenderNedWinner {
  naam: string;
  perceel: string;
  /** This winner's own value; null when the notice only gives a value shared by several winners (see percelen). */
  waarde: TenderNedValue | null;
  datumWinnaarGekozen: string;
  datumContract: string;
}

/** A lot-level value that belongs to all winners of the lot together, never to one of them. */
export interface TenderNedLotResult {
  perceel: string;
  /** Older standard forms: the lot's total value, awarded jointly to several contractors. */
  waarde?: TenderNedValue | null;
  /** eForms: maximum value of the lot's framework agreement(s), a ceiling rather than an awarded amount. */
  raamovereenkomstMaximum?: TenderNedValue | null;
  /** Names of the lot's winners, as in winnaars. */
  winnaars: string[];
}

export interface TenderNedAward {
  /** Which rendering the data was read from. */
  bron: "eforms" | "standaardformulier";
  /** Value of all contracts awarded in the notice (or the sum of the lot totals of an older standard form). */
  totaleWaarde: TenderNedValue | null;
  /** Framework agreements: the maximum value of all framework agreements in the notice (a ceiling, not spend). */
  raamovereenkomstMaximum?: TenderNedValue | null;
  /** Framework agreements: the approximate (expected) value of all framework agreements in the notice. */
  raamovereenkomstWaardeBijBenadering?: TenderNedValue | null;
  percelen?: TenderNedLotResult[];
  winnaars: TenderNedWinner[];
}

export interface TenderNedRelated {
  id: string;
  datum: string;
  type: string;
  kenmerk?: string;
  formType?: string;
}

export interface TenderNedDetail extends TenderNedItem {
  cpvCodes: Array<{ code: string; omschrijving: string; hoofdopdracht: boolean }>;
  nutsCodes: Array<{ code: string; omschrijving: string }>;
  juridischKader: string;
  aanbestedingStatus: string;
  opdrachtAard: string;
  aanvangOpdrachtDatum: string;
  voltooiingOpdrachtDatum: string;
  isGegund: boolean | null;
  afgerondeAanbesteding: boolean | null;
  gerelateerdePublicaties: TenderNedRelated[];
  gerelateerdePublicaties_unavailable_reason?: string;
  /** Id of the latest rectification of this notice; "" when there is none. */
  laatsteRectificatieId: string;
  /** Set when TenderNed shows a text instead of a closing date (e.g. "Onbepaald"). */
  sluitingsDatumOpmerking?: string;
  geraamdeWaarde?: TenderNedValue | null;
  gunning?: TenderNedAward | null;
  gunning_unavailable_reason?: string;
  pdfUrl: string;
  pdf_text?: string;
  pdf_text_chars?: number;
  pdf_text_total_chars?: number;
  pdf_text_truncated?: boolean;
  pdf_text_restored_chars?: number;
  pdf_pages?: number;
  pdf_text_unavailable_reason?: string;
}

/** A request the source cannot honestly answer as asked (too broad, out of reach). */
export class TenderNedInputError extends Error {
  constructor(
    message: string,
    public readonly suggestion: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TenderNedInputError";
  }
}

interface CodeLabel {
  code?: unknown;
  omschrijving?: unknown;
}

interface PublicatieSummary {
  publicatieId?: unknown;
  publicatieDatum?: unknown;
  sluitingsDatum?: unknown;
  sluitingsDatumMarktconsultatie?: unknown;
  aanbestedingNaam?: unknown;
  opdrachtgeverNaam?: unknown;
  opdrachtBeschrijving?: unknown;
  typePublicatie?: CodeLabel;
  publicatiecode?: CodeLabel;
  procedure?: CodeLabel;
  typeOpdracht?: CodeLabel;
  europees?: unknown;
  kenmerk?: unknown;
  link?: { href?: unknown };
}

interface PublicatiePage {
  content?: PublicatieSummary[];
  totalElements?: unknown;
  totalPages?: unknown;
  number?: unknown;
  size?: unknown;
}

interface PublicatieDetail {
  publicatieId?: unknown;
  kenmerk?: unknown;
  aanbestedingNaam?: unknown;
  opdrachtgeverNaam?: unknown;
  opdrachtBeschrijving?: unknown;
  publicatieDatum?: unknown;
  sluitingsDatum?: unknown;
  sluitingsDatumMarktconsultatie?: unknown;
  aanvangOpdrachtDatum?: unknown;
  voltooiingOpdrachtDatum?: unknown;
  /** Despite the name: the description of the eForms form (publicatieCode). */
  typePublicatie?: unknown;
  publicatieCode?: unknown;
  /** The notice type that search calls typePublicatie. */
  aankondigingCode?: CodeLabel;
  looptijdCode?: CodeLabel;
  juridischKaderCode?: CodeLabel;
  nationaalOfEuropeesCode?: CodeLabel;
  typeOpdrachtCode?: CodeLabel;
  procedureCode?: CodeLabel;
  opdrachtAardCode?: CodeLabel;
  cpvCodes?: Array<{ code?: unknown; omschrijving?: unknown; isHoofdOpdracht?: unknown }>;
  nutsCodes?: CodeLabel[];
  aanbestedingStatus?: unknown;
  isGegund?: unknown;
  afgerondeAanbesteding?: unknown;
  publicatieIDLaatsteRectificatie?: unknown;
  formType?: unknown;
  gerelateerdePublicaties?: RelatedRow[];
}

interface RelatedRow {
  publicatieId?: unknown;
  publicatieDatum?: unknown;
  typePublicatie?: unknown;
  kenmerk?: unknown;
  formType?: unknown;
}

interface AuthorityPage {
  content?: Array<{ aanbestedendedienstId?: unknown; naam?: unknown }>;
  totalElements?: unknown;
}

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Free text as plain text. TenderNed passes HTML entities through ("P&amp;C",
 * "&nbsp;"); decode them per line so the description keeps its paragraphs.
 */
function cleanText(value: unknown): string {
  const raw = str(value);
  if (!raw) return "";
  return raw
    // Zero-width spaces (U+200B) and BOMs (U+FEFF) occur in titles and
    // are invisible noise; \s in the whitespace collapse does not cover them.
    .replace(/[\u200B\uFEFF]/g, "")
    .split(/\r?\n/)
    .map((line) => htmlToText(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function label(value: CodeLabel | undefined): string {
  if (!value) return "";
  const code = str(value.code);
  const omschrijving = str(value.omschrijving);
  if (code && omschrijving) return `${omschrijving} (${code})`;
  return omschrijving || code;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Accept both "2026-08-25" and a full ISO timestamp; upstream wants a plain date. */
function toDateParam(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
}

/**
 * The closing date as tenderned.nl shows it: market consultations use
 * sluitingsDatumMarktconsultatie, everything else sluitingsDatum. Search and
 * get both go through here so they always agree, and the field it came from is
 * reported. Either field is a fallback for the other, because a notice
 * sometimes only fills one.
 */
function pickClosingDate(
  isMarktconsultatie: boolean,
  sluitingsDatum: unknown,
  sluitingsDatumMarktconsultatie: unknown,
): { value: string; bron: SluitingsDatumBron } {
  const regular = { value: str(sluitingsDatum), bron: "sluitingsDatum" as const };
  const consultation = { value: str(sluitingsDatumMarktconsultatie), bron: "sluitingsDatumMarktconsultatie" as const };
  const order = isMarktconsultatie ? [consultation, regular] : [regular, consultation];
  return order.find((candidate) => candidate.value) ?? { value: "", bron: "" };
}

/** The closing date of a detail record, picked the same way as for a search row. */
function detailClosingDate(data: PublicatieDetail): { value: string; bron: SluitingsDatumBron } {
  return pickClosingDate(str(data.aankondigingCode?.code) === "MAC", data.sluitingsDatum, data.sluitingsDatumMarktconsultatie);
}

/**
 * A missing (4xx) or unreadable detail record is about that one notice. Any
 * other failure (timeout, network error, 5xx, rate limit, open circuit) means
 * the detail endpoint is struggling, so a closing-date recheck stops there.
 */
function isPerRecordFailure(error: unknown): boolean {
  if (!(error instanceof SourceRequestError)) return false;
  if (error.code === "malformed_response") return true;
  const status = error.status ?? 0;
  return error.code === "http_error" && status >= 400 && status < 500 && status !== 408;
}

export function isPlaceholderDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  return /^\d{4}-/.test(value) && year >= PLACEHOLDER_DATE_YEAR;
}

function mapSummary(row: PublicatieSummary): TenderNedItem {
  const id = str(row.publicatieId);
  const href = str(row.link?.href) || `${VIEWER_BASE}/${id}`;
  const typeCode = str(row.typePublicatie?.code);
  const closing = pickClosingDate(typeCode === "MAC", row.sluitingsDatum, row.sluitingsDatumMarktconsultatie);
  return {
    id,
    title: cleanText(row.aanbestedingNaam) || `TenderNed publicatie ${id}`,
    opdrachtgever: cleanText(row.opdrachtgeverNaam),
    publicatieDatum: str(row.publicatieDatum),
    sluitingsDatum: closing.value,
    sluitingsDatumBron: closing.bron,
    sluitingsDatumPlaceholder: isPlaceholderDate(closing.value),
    sluitingsDatumGecontroleerd: false,
    typePublicatie: str(row.typePublicatie?.omschrijving),
    typePublicatieCode: typeCode,
    publicatieCode: str(row.publicatiecode?.code),
    publicatieCodeOmschrijving: str(row.publicatiecode?.omschrijving),
    procedure: label(row.procedure),
    typeOpdracht: label(row.typeOpdracht),
    europees: bool(row.europees),
    beschrijving: cleanText(row.opdrachtBeschrijving),
    kenmerk: str(row.kenmerk),
    url: href,
  };
}

/**
 * Output fields shared by tenderned_aanbestedingen_search and
 * tenderned_aanbesteding_get, under one set of snake_case names, so a caller can
 * read a search hit and its detail record the same way.
 */
export function tenderNedRecordFields(x: TenderNedItem): Record<string, unknown> {
  return {
    publicatie_id: x.id,
    opdrachtgever: x.opdrachtgever,
    publicatie_datum: x.publicatieDatum.slice(0, 10),
    sluitings_datum: x.sluitingsDatum,
    sluitings_datum_bron: x.sluitingsDatumBron,
    sluitings_datum_placeholder: x.sluitingsDatumPlaceholder,
    sluitings_datum_gecontroleerd: x.sluitingsDatumGecontroleerd,
    ...(x.sluitingsDatumOorspronkelijk ? { sluitings_datum_oorspronkelijk: x.sluitingsDatumOorspronkelijk } : {}),
    ...(x.laatsteRectificatieId ? { laatste_rectificatie_id: x.laatsteRectificatieId } : {}),
    type_publicatie: x.typePublicatie,
    type_publicatie_code: x.typePublicatieCode,
    publicatie_code: x.publicatieCode,
    publicatie_code_omschrijving: x.publicatieCodeOmschrijving,
    procedure: x.procedure,
    type_opdracht: x.typeOpdracht,
    europees: x.europees,
    kenmerk: x.kenmerk,
    beschrijving: x.beschrijving,
  };
}

/**
 * Upstream pages are fixed windows [page*size, (page+1)*size) with page <= 99
 * and size <= 100. Pick the request(s) that cover [start, start+count): one page
 * whenever some size fits the whole window, otherwise two consecutive pages of
 * 100. `skip` is the index of `start` within the first page.
 */
export function planUpstreamWindow(start: number, count: number): { size: number; pages: number[]; skip: number } {
  const want = Math.max(1, Math.min(MAX_PAGE_SIZE, count));
  for (let size = want; size <= MAX_PAGE_SIZE; size++) {
    const page = Math.floor(start / size);
    if (page > MAX_PAGE_INDEX) continue;
    if (Math.floor((start + want - 1) / size) === page) return { size, pages: [page], skip: start - page * size };
  }
  const page = Math.min(MAX_PAGE_INDEX, Math.floor(start / MAX_PAGE_SIZE));
  const pages = page < MAX_PAGE_INDEX ? [page, page + 1] : [page];
  return { size: MAX_PAGE_SIZE, pages, skip: start - page * MAX_PAGE_SIZE };
}

type QueryShape = "empty" | "single" | "phrase" | "multi_or" | "mixed_quotes" | "multi_phrase";

/** How TenderNed will read the search text (behaviour verified against the live API). */
function queryShape(query: string): QueryShape {
  const q = query.trim();
  if (!q) return "empty";
  const quotes = (q.match(/"/g) ?? []).length;
  if (!quotes) return q.split(/\s+/).length > 1 ? "multi_or" : "single";
  if (/^"[^"]+"$/.test(q)) return "phrase";
  if (quotes % 2 === 0 && /^(?:"[^"]+"\s*)+$/.test(q)) return "multi_phrase";
  return "mixed_quotes";
}

/**
 * A name without case, accents, apostrophe style or punctuation, so that
 * "Gemeente Noardeast Fryslan" and "Gemeente ’s-Hertogenbosch" find
 * "Gemeente Noardeast-Fryslân" and "Gemeente 's-Hertogenbosch".
 */
function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** `needle` occurs in `haystack` as whole words ("gemeente utrecht" is not in "gemeente utrechtse heuvelrug"). */
function containsWholePhrase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  for (let idx = haystack.indexOf(needle); idx >= 0; idx = haystack.indexOf(needle, idx + 1)) {
    if (!isWordChar(haystack[idx - 1]) && !isWordChar(haystack[idx + needle.length])) return true;
  }
  return false;
}

/**
 * Register names close to a name that matched nothing: those containing it
 * as part of a word ("Gemeente Utrecht" → "Gemeente Utrechtse Heuvelrug"),
 * else those containing its longest word.
 */
function nearbyNames(register: Array<{ naam: string }>, needle: string, max = 5): string[] {
  if (!needle) return [];
  const normalized = register.map((row) => ({ naam: row.naam, key: normalizeName(row.naam) }));
  const partial = normalized.filter((row) => row.key.includes(needle));
  if (partial.length) return partial.slice(0, max).map((row) => row.naam);
  const longest = needle.split(" ").sort((a, b) => b.length - a.length)[0] ?? "";
  if (longest.length < 4) return [];
  return normalized.filter((row) => row.key.includes(longest)).slice(0, max).map((row) => row.naam);
}

function listNames(names: string[], max = 10): string {
  const shown = names.slice(0, max).map((n) => `'${n}'`).join(", ");
  return names.length > max ? `${shown} en ${names.length - max} meer` : shown;
}

/**
 * "03/10/2026" and "2023-06-26+02:00" (older eForms renderings) → "2026-10-03"
 * and "2023-06-26"; anything else is returned trimmed, as printed.
 */
function toIsoDate(value: string): string {
  const trimmed = value.trim();
  const iso = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?!\d)/);
  if (iso) return iso[1];
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return trimmed;
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

/** Older eForms renderings print some names as "[ Marsh B.V. ] ---". */
function cleanName(value: string): string {
  return value.replace(/^\[\s*([\s\S]*?)\s*\]\s*-*\s*$/, "$1").trim();
}

/** Parse "800 000 Euro", "1 234,50 EUR", "1.250.000,00 EUR"; null unless it is a euro amount. */
export function parseEuroAmount(text: string): number | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!/\b(?:euro|eur)\b|€/i.test(t)) return null;
  const match = t.match(/-?\d[\d .,]*/);
  if (!match) return null;
  let num = match[0].replace(/\s/g, "").replace(/[.,]$/, "");
  if (num.includes(",")) num = num.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(?:\.\d{3})+$/.test(num)) num = num.replace(/\./g, "");
  const value = Number(num);
  return Number.isFinite(value) ? value : null;
}

function toValue(text: string): TenderNedValue | null {
  const tekst = text.replace(/\s+/g, " ").trim();
  if (!tekst || tekst === "-") return null;
  const euro = parseEuroAmount(tekst);
  return { tekst, euro, placeholder: euro !== null && euro < PLACEHOLDER_VALUE_EUR };
}

interface HtmlRow {
  kind: "header1" | "header2" | "header3" | "row";
  label: string;
  value: string;
}

function stripColon(value: string): string {
  return value.replace(/\s*:\s*$/, "").trim();
}

/** Label/value rows of the eForms rendering: <tr><td>label:</td><td>value</td></tr>. */
function eformsRows(html: string): HtmlRow[] {
  const rows: HtmlRow[] = [];
  for (const match of html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)) {
    const header = /class="(header[123])"/i.exec(match[1])?.[1]?.toLowerCase() as HtmlRow["kind"] | undefined;
    const cells = [...match[2].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => htmlToText(cell[1]));
    if (header) rows.push({ kind: header, label: cells.join(" "), value: "" });
    else if (cells.length >= 2) rows.push({ kind: "row", label: stripColon(cells[0]), value: cells.slice(1).join(" ").trim() });
    else if (cells.length === 1) rows.push({ kind: "row", label: stripColon(cells[0]), value: "" });
  }
  return rows;
}

function labelKey(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The eForms labels TenderNed prints, in Dutch and in English (notices written
 * in English are rendered with English labels). TenderNed reworded several
 * labels over time; every wording below was seen in award notices published
 * between November 2023 and October 2026.
 */
const EFORMS_LABELS = {
  geraamdeWaarde: ["Geraamde waarde exclusief btw", "Estimated value excluding VAT"],
  totaleWaarde: [
    "Waarde van alle contracten toegekend in deze kennisgeving",
    "Waarde van alle in het kader van deze procedure gegunde opdrachten",
    "Value of all contracts awarded in this notice",
    "Value of all contracts awarded in this procedure",
  ],
  raamovereenkomstMaximum: [
    "Maximumwaarde van de raamovereenkomsten in deze aankondiging",
    "Maximumwaarde van de raamovereenkomsten in deze procedure",
    "Maximum value of the framework agreements in this notice",
    "Maximum value of the framework agreements in this procedure",
  ],
  raamovereenkomstWaardeBijBenadering: [
    "Waarde bij benadering van de raamovereenkomsten",
    "Geschatte waarde van de raamovereenkomsten",
    "Approximate value of the framework agreements",
  ],
  perceelRaamovereenkomstMaximum: ["Maximumwaarde van de raamovereenkomst", "Maximum value of the framework agreement"],
  winnaar: ["Winnaar", "Winner"],
  naam: ["Officiële naam", "Official name"],
  perceel: ["Identificatiecode van het perceel of de groep percelen", "Identifier of lot or group of lots"],
  winnaarWaarde: ["Waarde van de aanbesteding", "Waarde van het resultaat", "Value of the tender", "Value of the result"],
  datumWinnaarGekozen: ["Datum waarop de winnaar is gekozen", "Date on which the winner was chosen"],
  datumContract: ["Datum van sluiting van het contract", "Date of the conclusion of the contract"],
  /** Amounts in the results section that are deliberately not read: tender ranges and re-estimates, not award values. */
  nietGelezen: [
    "Waarde van de laagste ontvankelijke inschrijving",
    "Waarde van de hoogste ontvankelijke inschrijving",
    "Value of the lowest admissible tender",
    "Value of the highest admissible tender",
    "Opnieuw geraamde waarde van de raamovereenkomst",
    "Herraming van de waarde van de raamovereenkomst",
    "Re-estimated value of the framework agreement",
  ],
};
type EformsLabel = keyof typeof EFORMS_LABELS;
const EFORMS_LABEL_KEYS = Object.fromEntries(
  Object.entries(EFORMS_LABELS).map(([key, labels]) => [key, new Set(labels.map(labelKey))]),
) as Record<EformsLabel, Set<string>>;

function isLabel(row: HtmlRow, key: EformsLabel): boolean {
  return EFORMS_LABEL_KEYS[key].has(labelKey(row.label));
}

/** A results-section row that holds an amount the parser did not map. */
function looksLikeUnreadAmount(row: HtmlRow): boolean {
  return /waarde|value|inkomsten|revenue/i.test(row.label) && parseEuroAmount(row.value) !== null && !isLabel(row, "nietGelezen");
}

/** Section names of the eForms rendering per language ("Procedure" is the same in both). */
const EFORMS_SECTIONS: Record<"nl" | "en", RegExp> = {
  nl: /^(?:koper|perceel|resultaten|organisaties|wijziging)$/i,
  en: /^(?:buyer|lot|results|organisations|change)$/i,
};

/** Language of an eForms rendering, from its section names ("1. Koper" / "1. Buyer"). */
function eformsLanguage(rows: HtmlRow[]): "nl" | "en" | null {
  for (const row of rows) {
    if (row.kind !== "header1") continue;
    const name = /^\d+\.\s*(.+)$/.exec(row.label)?.[1]?.trim() ?? "";
    if (EFORMS_SECTIONS.nl.test(name)) return "nl";
    if (EFORMS_SECTIONS.en.test(name)) return "en";
  }
  return null;
}

interface ParsedEforms {
  geraamdeWaarde: TenderNedValue | null;
  gunning: TenderNedAward | null;
  taal: "nl" | "en" | null;
  /** Amounts or winners in the results section that could not be mapped, as "label: value". */
  nietGelezen: string[];
}

function parseEforms(html: string): ParsedEforms {
  const rows = eformsRows(html);
  const taal = eformsLanguage(rows);
  let section = "";
  let lot: TenderNedLotResult | null = null;
  const percelen: TenderNedLotResult[] = [];
  let geraamdeWaarde: TenderNedValue | null = null;
  const lotGeraamdeWaarden: TenderNedValue[] = [];
  let lots = 0;
  let totaleWaarde: TenderNedValue | null = null;
  let raamovereenkomstMaximum: TenderNedValue | null = null;
  let raamovereenkomstWaardeBijBenadering: TenderNedValue | null = null;
  const winnaars: TenderNedWinner[] = [];
  const nietGelezen: string[] = [];
  let unnamedWinners = 0;
  let current: TenderNedWinner | null = null;
  const close = () => {
    const winner: TenderNedWinner | null = current;
    current = null;
    if (!winner) return;
    if (!winner.naam) {
      unnamedWinners += 1;
      return;
    }
    winnaars.push(winner);
    lot?.winnaars.push(winner.naam);
  };
  const closeLot = () => {
    close();
    if (lot?.raamovereenkomstMaximum) percelen.push(lot);
    lot = null;
  };

  for (const row of rows) {
    if (row.kind === "header1") {
      closeLot();
      section = /^(\d+)\./.exec(row.label)?.[1] ?? "";
      continue;
    }
    if (row.kind === "header2" || row.kind === "header3") {
      close();
      if (row.kind === "header2" && section === "6") {
        closeLot();
        // "6.1 ID resultaat perceel: LOT-0001", also "Resultaat Lot Identifier" / "Result lot ldentifier".
        lot = { perceel: /:\s*(\S+)\s*$/.exec(row.label)?.[1] ?? "", winnaars: [] };
      }
      if (row.kind === "header2" && section === "5") lots += 1;
      continue;
    }
    if (isLabel(row, "geraamdeWaarde")) {
      const value = toValue(row.value);
      if (section === "2" && !geraamdeWaarde) geraamdeWaarde = value;
      if (section === "5" && value) lotGeraamdeWaarden.push(value);
      continue;
    }
    if (section !== "6") continue;
    const winner: TenderNedWinner | null = current;
    if (isLabel(row, "totaleWaarde")) {
      totaleWaarde ??= toValue(row.value);
    } else if (isLabel(row, "raamovereenkomstMaximum")) {
      raamovereenkomstMaximum ??= toValue(row.value);
    } else if (isLabel(row, "raamovereenkomstWaardeBijBenadering")) {
      raamovereenkomstWaardeBijBenadering ??= toValue(row.value);
    } else if (isLabel(row, "perceelRaamovereenkomstMaximum") && lot && !winner) {
      lot.raamovereenkomstMaximum = toValue(row.value);
    } else if (isLabel(row, "winnaar") && !row.value) {
      close();
      current = { naam: "", perceel: lot?.perceel ?? "", waarde: null, datumWinnaarGekozen: "", datumContract: "" };
    } else if (winner && isLabel(row, "naam")) {
      if (!winner.naam) winner.naam = cleanName(row.value);
    } else if (winner && isLabel(row, "perceel")) {
      winner.perceel = row.value;
    } else if (winner && isLabel(row, "winnaarWaarde")) {
      winner.waarde = toValue(row.value);
    } else if (winner && isLabel(row, "datumWinnaarGekozen")) {
      winner.datumWinnaarGekozen = toIsoDate(row.value);
    } else if (winner && isLabel(row, "datumContract")) {
      winner.datumContract = toIsoDate(row.value);
    } else if (looksLikeUnreadAmount(row)) {
      nietGelezen.push(`${row.label}: ${row.value}`);
    }
  }
  closeLot();
  if (unnamedWinners) nietGelezen.push(`${unnamedWinners} winnaar(s) zonder officiële naam`);

  const found = totaleWaarde || raamovereenkomstMaximum || raamovereenkomstWaardeBijBenadering || percelen.length || winnaars.length;
  const gunning: TenderNedAward | null = found
    ? {
        bron: "eforms",
        totaleWaarde,
        ...(raamovereenkomstMaximum ? { raamovereenkomstMaximum } : {}),
        ...(raamovereenkomstWaardeBijBenadering ? { raamovereenkomstWaardeBijBenadering } : {}),
        ...(percelen.length ? { percelen } : {}),
        winnaars,
      }
    : null;
  // Without a procedure-level estimate, a lot's estimate stands for the notice
  // only when there is exactly one lot.
  const singleLotEstimate = lots <= 1 && lotGeraamdeWaarden.length === 1 ? lotGeraamdeWaarden[0] : null;
  return { geraamdeWaarde: geraamdeWaarde ?? singleLotEstimate, gunning, taal, nietGelezen };
}

/** Text lines of the older (pre-eForms) standard-form rendering. */
function legacyLines(html: string): string[] {
  return html
    .replace(/<(?:h[1-6]|p|dt|dd|li|br|tr|div)\b[^>]*>/gi, "\n")
    .split("\n")
    .map((line) => htmlToText(line))
    .filter(Boolean);
}

/** Afdeling V ("Gunning van een opdracht") of the older standard forms; one block per lot. */
function parseLegacy(html: string): TenderNedAward | null {
  const lines = legacyLines(html);
  const winnaars: TenderNedWinner[] = [];
  const percelen: TenderNedLotResult[] = [];
  const totalParts: TenderNedValue[] = [];
  let blocks = 0;
  let inBlock = false;
  let perceel = "";
  let names: string[] = [];
  let datum = "";
  let waarde = "";
  let munt = "";
  let inContractant = false;
  let expect: "" | "datum" | "naam" | "waarde" = "";

  const flush = () => {
    if (!inBlock) return;
    blocks += 1;
    const value = waarde ? toValue(`${waarde} ${munt}`) : null;
    if (value) totalParts.push(value);
    // "Totale waarde van de opdracht/het perceel" is the value of the whole
    // block. With one contractor that is its contract value; several
    // contractors (a framework or a consortium) share it, so it stays at lot
    // level instead of being repeated as if each had won the full amount.
    const shared = names.length > 1 && value !== null;
    if (shared) percelen.push({ perceel, waarde: value, winnaars: [...names] });
    for (const naam of names) {
      winnaars.push({ naam, perceel, waarde: shared ? null : value, datumWinnaarGekozen: "", datumContract: datum });
    }
    perceel = "";
    names = [];
    datum = "";
    waarde = "";
    munt = "";
    inContractant = false;
    expect = "";
  };

  for (const line of lines) {
    if (/^Afdeling V\b/i.test(line)) {
      flush();
      inBlock = true;
      continue;
    }
    if (/^Afdeling (?:I|II|III|IV|VI)\b/i.test(line)) {
      flush();
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;

    if (expect === "datum") {
      datum = toIsoDate(line);
      expect = "";
      continue;
    }
    if (expect === "naam") {
      if (line !== "-") names.push(line);
      expect = "";
      continue;
    }
    if (expect === "waarde") {
      waarde = line;
      expect = "";
      continue;
    }

    let m: RegExpMatchArray | null;
    if ((m = line.match(/^Perceel nr\.?:\s*(.*)$/i))) {
      if (m[1] && m[1] !== "-") perceel = m[1];
    } else if ((m = line.match(/^Benaming:\s*(.*)$/i))) {
      if (m[1] && m[1] !== "-") perceel = perceel ? `${perceel} ${m[1]}` : m[1];
    } else if ((m = line.match(/^V\.2\.1\)[^:]*:\s*(.*)$/i))) {
      if (m[1]) datum = toIsoDate(m[1]);
      else expect = "datum";
    } else if (/^V\.2\.3\)/i.test(line)) {
      inContractant = true;
    } else if (/^V\.2\.[4-9]\)/i.test(line)) {
      inContractant = false;
    } else if (inContractant && (m = line.match(/^Officiële benaming:\s*(.*)$/i))) {
      if (m[1]) {
        if (m[1] !== "-") names.push(m[1]);
      } else expect = "naam";
    } else if ((m = line.match(/^Totale waarde van de opdracht\/het perceel:\s*(.*)$/i))) {
      if (m[1]) waarde = m[1];
      else expect = "waarde";
    } else if ((m = line.match(/^Munt:\s*(\S+)/i))) {
      munt = m[1];
    }
  }
  flush();

  // A total only when every award block has a value; lots are summed only when
  // each is a parseable euro amount. One lot's value is never shown as the total.
  let totaleWaarde: TenderNedValue | null = null;
  if (blocks === 1 && totalParts.length === 1) totaleWaarde = totalParts[0];
  else if (blocks > 1 && totalParts.length === blocks && totalParts.every((part) => part.euro !== null)) {
    const totalEuro = totalParts.reduce((sum, part) => sum + (part.euro ?? 0), 0);
    totaleWaarde = {
      tekst: totalParts.map((part) => part.tekst).join(" + "),
      euro: totalEuro,
      placeholder: totalEuro < PLACEHOLDER_VALUE_EUR,
    };
  }
  if (!totaleWaarde && !winnaars.length) return null;
  return { bron: "standaardformulier", totaleWaarde, ...(percelen.length ? { percelen } : {}), winnaars };
}

/**
 * Values, winners and contract dates from TenderNed's labelled HTML rendering of
 * a notice. Two layouts exist: eForms (table rows with label/value cells, every
 * notice since late 2023, in Dutch or English) and the older Dutch standard
 * forms (sections I..VI). Only known labels are read; an unknown layout yields
 * `format: "unknown"` and an eForms rendering in another language `taal: null`,
 * rather than a guess. Amounts in the results section that no known label
 * covers are listed in `nietGelezen`.
 */
export function parseNoticeHtml(html: string): {
  format: "eforms" | "standaardformulier" | "unknown";
  /** Language of the rendering's labels; null when it is not one the parser reads. */
  taal: "nl" | "en" | null;
  geraamdeWaarde: TenderNedValue | null;
  gunning: TenderNedAward | null;
  nietGelezen: string[];
} {
  if (/<tr\b[^>]*class="header1"/i.test(html)) {
    const parsed = parseEforms(html);
    return { format: "eforms", taal: parsed.taal, geraamdeWaarde: parsed.geraamdeWaarde, gunning: parsed.gunning, nietGelezen: parsed.nietGelezen };
  }
  if (/Afdeling\s+(?:I|V)\b/i.test(html)) {
    return { format: "standaardformulier", taal: "nl", geraamdeWaarde: null, gunning: parseLegacy(html), nietGelezen: [] };
  }
  return { format: "unknown", taal: null, geraamdeWaarde: null, gunning: null, nietGelezen: [] };
}

/** What a caller needs to read `gunning` correctly; bare nulls invite wrong conclusions. */
function awardNotes(gunning: TenderNedAward | null, nietGelezen: string[]): string[] {
  const notes: string[] = [];
  if (gunning) {
    const lotMaximum = Boolean(gunning.percelen?.some((p) => p.raamovereenkomstMaximum));
    const parts: string[] = [];
    if (gunning.raamovereenkomstMaximum || lotMaximum) {
      const where = [gunning.raamovereenkomstMaximum ? "gunning" : "", lotMaximum ? "gunning.percelen" : ""].filter(Boolean).join(" en ");
      parts.push(`raamovereenkomstMaximum (in ${where}) is het plafond van de raamovereenkomst(en)`);
    }
    if (gunning.raamovereenkomstWaardeBijBenadering) parts.push("raamovereenkomstWaardeBijBenadering is de verwachte waarde");
    const framework = parts.length > 0;
    if (framework) {
      notes.push(
        `Raamovereenkomst: ${parts.join("; ")}; ${parts.length > 1 ? "geen van beide is een" : "dat is geen"} gegund of besteed bedrag.` +
          (gunning.totaleWaarde ? "" : " Een totale contractwaarde (totaleWaarde) noemt de publicatie niet."),
      );
    }
    const shared = (gunning.percelen ?? []).filter((p) => p.waarde);
    if (shared.length) {
      notes.push(
        `Bij ${shared.length} perceel/percelen is één waarde gezamenlijk gegund aan meerdere opdrachtnemers; die staat in gunning.percelen[].waarde, niet per winnaar (winnaars[].waarde is daar leeg).`,
      );
    }
    const anyValue = Boolean(gunning.totaleWaarde) || framework || shared.length > 0 || gunning.winnaars.some((w) => w.waarde);
    if (gunning.winnaars.length && !anyValue) {
      notes.push("De gunningspublicatie noemt in de HTML-weergave geen gegunde waarde; zie pdf_text.");
    }
  }
  if (nietGelezen.length) {
    const shown = nietGelezen.slice(0, 5).map((x) => `'${x}'`).join(", ");
    const more = nietGelezen.length > 5 ? ` en ${nietGelezen.length - 5} meer` : "";
    notes.push(`Niet ingelezen uit de resultatensectie (onbekend label): ${shown}${more}; zie pdf_text.`);
  }
  return notes;
}

export class TenderNedSource {
  constructor(private readonly config: AppConfig) {}

  /**
   * TenderNed's whole register of contracting authorities. Its pages are
   * cached for hours, so only the first opdrachtgever search after a restart
   * reads them all.
   */
  private async loadAuthorityRegister(): Promise<Array<{ id: string; naam: string }>> {
    const fetchPage = (page: number) =>
      getJson<AuthorityPage>(AANBESTEDENDE_DIENSTEN, {
        query: { page: String(page), size: String(AUTHORITY_LOOKUP_SIZE) },
        connector: CONNECTOR,
        timeoutMs: 20_000,
        cacheTtlMs: AUTHORITY_REGISTER_TTL_MS,
      });
    const first = await fetchPage(0);
    const totalRaw = Number(first.data.totalElements);
    const pageCount = Number.isFinite(totalRaw)
      ? Math.min(MAX_PAGE_INDEX + 1, Math.ceil(totalRaw / AUTHORITY_LOOKUP_SIZE))
      : 1;
    const rest = await Promise.all(Array.from({ length: Math.max(0, pageCount - 1) }, (_, i) => fetchPage(i + 1)));
    const byId = new Map<string, string>();
    for (const page of [first, ...rest]) {
      for (const row of page.data.content ?? []) {
        const id = str(row.aanbestedendedienstId);
        if (id && !byId.has(id)) byId.set(id, cleanText(row.naam));
      }
    }
    return [...byId].map(([id, naam]) => ({ id, naam }));
  }

  /**
   * Registered contracting authorities whose name contains `name` as whole
   * words, ignoring case, accents, apostrophe style and punctuation. Throws
   * when the name is too broad to resolve completely: filtering on a silent
   * subset would undercount.
   */
  private async resolveOpdrachtgever(name: string): Promise<{
    matches: Array<{ id: string; naam: string }>;
    /** Names that come close when nothing matches. */
    nearby: string[];
    note?: string;
  }> {
    const needle = normalizeName(name);
    const tooBroad = (count: number, examples: string[]) =>
      new TenderNedInputError(
        `opdrachtgever '${name}' past op ${count} aanbestedende diensten in TenderNed; dat is te breed om volledig te filteren.`,
        "Geef de naam specifieker op, bijv. 'Gemeente Utrecht' of 'Ministerie van Defensie, Koninklijke Marine'.",
        { opdrachtgever: name, aantal_diensten: count, voorbeelden: examples.slice(0, 10) },
      );

    let register: Array<{ id: string; naam: string }>;
    let note: string | undefined;
    try {
      register = await this.loadAuthorityRegister();
    } catch {
      // The register's own search matches substrings but needs exact accents
      // and apostrophes; still better than not filtering at all.
      const { data } = await getJson<AuthorityPage>(AANBESTEDENDE_DIENSTEN, {
        query: { page: "0", size: String(AUTHORITY_LOOKUP_SIZE), search: name },
        connector: CONNECTOR,
        timeoutMs: 20_000,
      });
      register = (data.content ?? [])
        .map((row) => ({ id: str(row.aanbestedendedienstId), naam: cleanText(row.naam) }))
        .filter((row) => row.id);
      const totalRaw = Number(data.totalElements);
      if (Number.isFinite(totalRaw) && totalRaw > register.length) throw tooBroad(totalRaw, register.map((r) => r.naam));
      note =
        "Het volledige register van aanbestedende diensten kon niet worden geladen; de naam is opgezocht met TenderNeds eigen naamzoekfunctie, die accenten en apostrofs exact vergelijkt.";
    }

    const matches = register.filter((row) => containsWholePhrase(normalizeName(row.naam), needle));
    if (matches.length > MAX_AUTHORITY_IDS) throw tooBroad(matches.length, matches.map((m) => m.naam));
    return { matches, nearby: matches.length ? [] : nearbyNames(register, needle), ...(note ? { note } : {}) };
  }

  async search(args: {
    query?: string;
    typeOpdracht?: TenderTypeOpdracht;
    procedure?: string;
    datumVanaf?: string;
    datumTot?: string;
    rows: number;
    /** Zero-based upstream page of `rows` notices; ignored when `offset` is set. */
    page?: number;
    /** Absolute zero-based index of the first notice to return. */
    offset?: number;
    /** Contracting authority name, resolved to TenderNed's own authority ids. */
    opdrachtgever?: string;
    sort?: TenderSort;
  }): Promise<{
    items: TenderNedItem[];
    total: number;
    /** Absolute index of items[0] within the full result list. */
    offset: number;
    /** More results exist and are reachable after this window. */
    has_more: boolean;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const count = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(args.rows)));
    const start =
      args.offset !== undefined
        ? Math.max(0, Math.floor(args.offset))
        : Math.max(0, Math.floor(args.page ?? 0)) * count;

    if (start >= TENDERNED_MAX_REACHABLE) {
      throw new TenderNedInputError(
        `TenderNed geeft van een zoekvraag alleen de eerste ${TENDERNED_MAX_REACHABLE} resultaten vrij (pagina's 0-99 van maximaal 100); positie ${start} is niet bereikbaar.`,
        "Verfijn de zoekvraag met date_from/date_to, opdrachtgever, typeOpdracht of procedure en blader daarbinnen.",
        { offset: start, max_reachable: TENDERNED_MAX_REACHABLE },
      );
    }

    const typeCode =
      args.typeOpdracht && args.typeOpdracht !== "all"
        ? TYPE_OPDRACHT_CODE[args.typeOpdracht]
        : undefined;

    const notes: string[] = [];
    const filters: Record<string, string> = {};
    const searchTerm = (args.query ?? "").trim();
    if (searchTerm) filters.search = searchTerm;
    if (typeCode) filters.typeOpdracht = typeCode;
    if (args.procedure?.trim()) filters.procedure = args.procedure.trim().toUpperCase();

    const vanaf = toDateParam(args.datumVanaf);
    const tot = toDateParam(args.datumTot);
    if (vanaf) filters.publicatieDatumVanaf = vanaf;
    if (tot) filters.publicatieDatumTot = tot;
    if (args.sort) filters.sort = SORT_PARAM[args.sort];

    let authorityIds: string[] = [];
    const opdrachtgever = (args.opdrachtgever ?? "").trim().replace(/^"(.*)"$/, "$1").trim();
    if (opdrachtgever) {
      const resolved = await this.resolveOpdrachtgever(opdrachtgever);
      if (!resolved.matches.length) {
        const near = resolved.nearby.length ? ` Wel gevonden: ${listNames(resolved.nearby, 5)}.` : "";
        return {
          items: [],
          total: 0,
          offset: start,
          has_more: false,
          endpoint: AANBESTEDENDE_DIENSTEN,
          params: { ...filters, opdrachtgever },
          access_note: [
            `Geen aanbestedende dienst in TenderNed met '${opdrachtgever}' als (deel van de) naam; er is daarom niet gezocht.${near} Controleer de schrijfwijze, bijv. 'Gemeente Utrecht'.`,
            resolved.note,
          ]
            .filter(Boolean)
            .join(" "),
        };
      }
      authorityIds = resolved.matches.map((m) => m.id);
      const names = resolved.matches.map((m) => m.naam);
      notes.push(
        names.length === 1
          ? `Gefilterd op opdrachtgever ${listNames(names)} (TenderNed-register van aanbestedende diensten).`
          : `Gefilterd op ${names.length} aanbestedende diensten met '${opdrachtgever}' in de naam: ${listNames(names)}.`,
      );
      if (resolved.note) notes.push(resolved.note);
    }

    const plan = planUpstreamWindow(start, count);
    const requestUrl = (page: number): string => {
      const url = new URL(PUBLICATIES);
      url.searchParams.set("page", String(page));
      url.searchParams.set("size", String(plan.size));
      for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
      for (const id of authorityIds) url.searchParams.append("aanbestedendeDienstId", id);
      return url.toString();
    };

    const first = await getJson<PublicatiePage>(requestUrl(plan.pages[0]), { connector: CONNECTOR, timeoutMs: 20_000 });
    const rows = [...(first.data.content ?? [])];
    const fetchedPages = [plan.pages[0]];
    // The second page is only needed when the first was full and did not cover the window.
    if (plan.pages.length > 1 && rows.length === plan.size && plan.skip + count > rows.length) {
      const second = await getJson<PublicatiePage>(requestUrl(plan.pages[1]), { connector: CONNECTOR, timeoutMs: 20_000 });
      rows.push(...(second.data.content ?? []));
      fetchedPages.push(plan.pages[1]);
    }

    const reachable = Math.max(0, Math.min(count, TENDERNED_MAX_REACHABLE - start));
    const items = rows.slice(plan.skip, plan.skip + reachable).map(mapSummary);
    const totalRaw = Number(first.data.totalElements);
    const totalKnown = Number.isFinite(totalRaw);
    const total = totalKnown ? totalRaw : start + items.length;
    const end = start + items.length;
    const has_more = totalKnown && end < Math.min(total, TENDERNED_MAX_REACHABLE);

    if (args.rows > MAX_PAGE_SIZE) {
      notes.push(`TenderNed levert maximaal ${MAX_PAGE_SIZE} publicaties per aanroep; vraag de volgende op met offset=${end}.`);
    }
    if (!items.length) {
      if (totalKnown && total > 0 && start >= total) {
        notes.push(`Positie ${start} ligt voorbij het laatste resultaat (totaal ${total}).`);
      } else {
        notes.push(
          "TenderNed bereikbaar, maar geen publicaties voor deze zoekterm/filters. Probeer een bredere zoekterm of een ruimere periode.",
        );
      }
    }
    if (totalKnown && total > TENDERNED_MAX_REACHABLE && end >= TENDERNED_MAX_REACHABLE) {
      notes.push(
        `TenderNed geeft van een zoekvraag alleen de eerste ${TENDERNED_MAX_REACHABLE} van ${total} resultaten vrij; verfijn met datum, opdrachtgever of type om de rest te zien.`,
      );
    }
    if ((args.datumVanaf && !vanaf) || (args.datumTot && !tot)) {
      notes.push("Datumfilter genegeerd: gebruik het formaat JJJJ-MM-DD.");
    }
    switch (queryShape(searchTerm)) {
      case "multi_or":
        notes.push(
          "TenderNed combineert losse zoekwoorden met OF: een publicatie met één van de woorden telt mee. Zet de hele zoekterm tussen dubbele aanhalingstekens voor een exacte frase" +
            (authorityIds.length
              ? "."
              : ", of filter op aanbestedende dienst met de parameter 'opdrachtgever' van tenderned_aanbestedingen_search."),
        );
        break;
      case "mixed_quotes":
        notes.push(
          "Aanhalingstekens werken bij TenderNed alleen als de hele zoekterm één frase is; hier zijn ze genegeerd en worden de woorden met OF gecombineerd.",
        );
        break;
      case "multi_phrase":
        notes.push(
          "TenderNed ondersteunt één frase tussen aanhalingstekens per zoekvraag; met meerdere frases geeft TenderNed geen resultaten. Gebruik één frase en filter verder met de parameter 'opdrachtgever' van tenderned_aanbestedingen_search.",
        );
        break;
      default:
        break;
    }
    const recheck = await this.recheckDeadlines(items);
    if (recheck.checked) {
      notes.push(
        `sluitings_datum van ${recheck.checked} publicatie(s) met een lopende of recente termijn is gecontroleerd tegen het actuele detailrecord (sluitings_datum_gecontroleerd)` +
          (recheck.changed
            ? `; bij ${recheck.changed} daarvan week de zoekindex af, meestal door een rectificatie: sluitings_datum is de actuele termijn, sluitings_datum_oorspronkelijk die uit de zoekindex.`
            : "."),
      );
    }
    if (recheck.unchecked) {
      notes.push(
        `Bij ${recheck.unchecked} publicatie(s) komt sluitings_datum ongecontroleerd uit de zoekindex van TenderNed: de termijn van de oorspronkelijke aankondiging, die een rectificatie kan hebben verschoven. De actuele termijn geeft tenderned_aanbesteding_get.` +
          (recheck.cutShort
            ? " De controle tegen de detailrecords is deze keer niet afgemaakt, omdat TenderNed daar niet of te traag op antwoordde."
            : ""),
      );
    }
    const placeholders = items.filter((item) => item.sluitingsDatumPlaceholder).length;
    if (placeholders) {
      notes.push(
        `${placeholders} publicatie(s) hebben een sluitingsdatum in ${PLACEHOLDER_DATE_YEAR} of later: een plaatshouder van TenderNed, geen echte termijn (sluitings_datum_placeholder).`,
      );
    }

    const params: Record<string, string> = {
      page: fetchedPages.join(","),
      size: String(plan.size),
      ...filters,
    };
    if (authorityIds.length) params.aanbestedendeDienstId = authorityIds.join(",");

    return {
      items,
      total,
      offset: start,
      has_more,
      endpoint: first.meta.url,
      params,
      access_note: notes.length ? notes.join(" ") : undefined,
    };
  }

  /**
   * TenderNed's search index keeps the closing date of the original notice;
   * only the detail record follows rectifications (seen moving deadlines by up
   * to ~4 months, so an open tender can look closed in search). Re-read the
   * detail of notices whose indexed deadline is current or recent, so search
   * shows the same deadline as get.
   *
   * This is best-effort enrichment of a search that has already succeeded, so
   * it is bounded: its own connector (see RECHECK_CONNECTOR), at most
   * RECHECK_CONCURRENCY requests at a time, no new request after the first
   * sign of a struggling upstream, and RECHECK_BUDGET_MS of wall-clock time in
   * total. Whatever is not checked keeps the indexed date, marked unchecked.
   */
  private async recheckDeadlines(
    items: TenderNedItem[],
  ): Promise<{ checked: number; changed: number; unchecked: number; cutShort: boolean }> {
    const cutoff = new Date(Date.now() - DEADLINE_RECHECK_DAYS * 86_400_000).toISOString().slice(0, 10);
    const dated = items.filter((item) => item.sluitingsDatum && !item.sluitingsDatumPlaceholder);
    // Open and just-closed tenders matter most, so the latest deadlines go first.
    const candidates = dated
      .filter((item) => item.sluitingsDatum.slice(0, 10) >= cutoff)
      .sort((a, b) => (a.sluitingsDatum < b.sluitingsDatum ? 1 : a.sluitingsDatum > b.sluitingsDatum ? -1 : 0))
      .slice(0, MAX_DEADLINE_CHECKS);
    if (!candidates.length) return { checked: 0, changed: 0, unchecked: dated.length, cutShort: false };

    let checked = 0;
    let changed = 0;
    let nextIndex = 0;
    // Set on the first failure that is not about one record: start no further rechecks.
    let halted = false;
    // Set once the budget is spent: a response still in flight is discarded, so
    // nothing changes the items after search has returned them.
    let expired = false;

    const apply = (item: TenderNedItem, data: PublicatieDetail): void => {
      const closing = detailClosingDate(data);
      // A detail record without any closing date says nothing about the indexed one.
      if (!closing.value) return;
      if (closing.value !== item.sluitingsDatum) {
        item.sluitingsDatumOorspronkelijk = item.sluitingsDatum;
        item.sluitingsDatum = closing.value;
        item.sluitingsDatumBron = closing.bron;
        item.sluitingsDatumPlaceholder = isPlaceholderDate(closing.value);
        changed += 1;
      }
      const rectificatie = str(data.publicatieIDLaatsteRectificatie);
      if (rectificatie) item.laatsteRectificatieId = rectificatie;
      item.sluitingsDatumGecontroleerd = true;
      checked += 1;
    };

    const worker = async (): Promise<void> => {
      while (!halted && !expired && nextIndex < candidates.length) {
        const item = candidates[nextIndex++];
        try {
          const { data } = await getJson<PublicatieDetail>(`${PUBLICATIES}/${encodeURIComponent(item.id)}`, {
            connector: RECHECK_CONNECTOR,
            // A request outliving the budget runs out in the background on the
            // recheck connector; a shorter timeout would count a merely slow
            // upstream as a failure.
            timeoutMs: RECHECK_BUDGET_MS,
            retries: 0,
          });
          if (!expired) apply(item, data);
        } catch (error) {
          // The HTTP layer has already logged the failure; the indexed date stays, marked unchecked.
          if (!isPerRecordFailure(error)) halted = true;
        }
      }
    };

    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<false>((resolve) => {
      budgetTimer = setTimeout(() => {
        expired = true;
        resolve(false);
      }, RECHECK_BUDGET_MS);
    });
    const workers = Array.from({ length: Math.min(RECHECK_CONCURRENCY, candidates.length) }, () => worker());
    const finished = await Promise.race([Promise.all(workers).then(() => true as const), budget]);
    clearTimeout(budgetTimer);
    expired = true;
    return { checked, changed, unchecked: dated.length - checked, cutShort: halted || !finished };
  }

  /** Other notices of the same procedure; the detail record itself never lists them. */
  private async fetchRelated(id: string): Promise<{ items: TenderNedRelated[] } | { error: string }> {
    try {
      const { data } = await getJson<unknown>(`${PUBLICATIES}/${encodeURIComponent(id)}/gerelateerd`, {
        connector: CONNECTOR,
        timeoutMs: 20_000,
      });
      if (!Array.isArray(data)) return { error: "malformed_response" };
      return {
        items: (data as RelatedRow[]).map((r) => ({
          id: str(r.publicatieId),
          datum: str(r.publicatieDatum),
          type: str(r.typePublicatie),
          kenmerk: str(r.kenmerk),
          formType: str(r.formType),
        })),
      };
    } catch {
      // The HTTP layer has already logged the failure; the caller reports a typed reason.
      return { error: "fetch_failed" };
    }
  }

  private async fetchNoticeHtml(id: string): Promise<{ html: string } | { error: string }> {
    try {
      const { data } = await getJson<{ html?: unknown }>(`${PUBLICATIES}/${encodeURIComponent(id)}/html`, {
        connector: CONNECTOR,
        timeoutMs: 20_000,
      });
      const html = data && typeof data === "object" ? data.html : undefined;
      return typeof html === "string" && html.trim() ? { html } : { error: "malformed_response" };
    } catch {
      // The HTTP layer has already logged the failure; the caller reports a typed reason.
      return { error: "fetch_failed" };
    }
  }

  async get(args: {
    publicatieId: string;
    include_text?: boolean;
    max_chars?: number;
    /** Parse value, winner and contract data from the notice's HTML rendering (default true). */
    include_award?: boolean;
  }): Promise<{
    item: TenderNedDetail;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const id = args.publicatieId.trim();
    const includeAward = args.include_award !== false;
    const endpoint = `${PUBLICATIES}/${encodeURIComponent(id)}`;
    const { data, meta } = await getJson<PublicatieDetail>(endpoint, {
      connector: CONNECTOR,
      timeoutMs: 20_000,
    });
    const [related, noticeHtml] = await Promise.all([
      this.fetchRelated(id),
      includeAward ? this.fetchNoticeHtml(id) : Promise.resolve(undefined),
    ]);

    const notes: string[] = [];
    const typeCode = str(data.aankondigingCode?.code);
    const closing = detailClosingDate(data);
    const looptijd = str(data.looptijdCode?.code);
    const europeesCode = str(data.nationaalOfEuropeesCode?.code);

    // Upstream has never been seen to fill this, but keep whatever it sends.
    const relatedById = new Map<string, TenderNedRelated>();
    for (const r of data.gerelateerdePublicaties ?? []) {
      const rid = str(r.publicatieId);
      if (rid) relatedById.set(rid, { id: rid, datum: str(r.publicatieDatum), type: str(r.typePublicatie) });
    }
    if ("items" in related) for (const r of related.items) if (r.id && r.id !== id) relatedById.set(r.id, r);

    const pdfUrl = `${PUBLICATIES}/${encodeURIComponent(id)}/pdf`;
    const item: TenderNedDetail = {
      id: str(data.publicatieId) || id,
      title: cleanText(data.aanbestedingNaam) || `TenderNed publicatie ${id}`,
      opdrachtgever: cleanText(data.opdrachtgeverNaam),
      publicatieDatum: str(data.publicatieDatum),
      sluitingsDatum: closing.value,
      sluitingsDatumBron: closing.bron,
      sluitingsDatumPlaceholder: isPlaceholderDate(closing.value),
      // The detail record carries rectifications; search's index does not.
      sluitingsDatumGecontroleerd: true,
      // aankondigingCode is the notice type that search reports as typePublicatie;
      // the detail's own "typePublicatie" describes the eForms form instead.
      typePublicatie: str(data.aankondigingCode?.omschrijving) || str(data.typePublicatie),
      typePublicatieCode: typeCode,
      publicatieCode: str(data.publicatieCode),
      publicatieCodeOmschrijving: str(data.typePublicatie),
      procedure: label(data.procedureCode),
      typeOpdracht: label(data.typeOpdrachtCode),
      europees: europeesCode ? europeesCode === "EU" : null,
      beschrijving: cleanText(data.opdrachtBeschrijving),
      kenmerk: str(data.kenmerk),
      url: `${VIEWER_BASE}/${id}`,
      cpvCodes: (data.cpvCodes ?? []).map((c) => ({
        code: str(c.code),
        omschrijving: str(c.omschrijving),
        hoofdopdracht: c.isHoofdOpdracht === true,
      })),
      nutsCodes: (data.nutsCodes ?? []).map((c) => ({
        code: str(c.code),
        omschrijving: str(c.omschrijving),
      })),
      juridischKader: label(data.juridischKaderCode),
      aanbestedingStatus: str(data.aanbestedingStatus),
      opdrachtAard: label(data.opdrachtAardCode),
      aanvangOpdrachtDatum: str(data.aanvangOpdrachtDatum),
      voltooiingOpdrachtDatum: str(data.voltooiingOpdrachtDatum),
      isGegund: bool(data.isGegund),
      afgerondeAanbesteding: bool(data.afgerondeAanbesteding),
      gerelateerdePublicaties: [...relatedById.values()],
      laatsteRectificatieId: str(data.publicatieIDLaatsteRectificatie),
      pdfUrl,
    };

    // tenderned.nl shows the looptijd text ("Onbepaald") instead of a date for these codes.
    if (looptijd === "OBP" || looptijd === "OBK") item.sluitingsDatumOpmerking = str(data.looptijdCode?.omschrijving);
    if (item.sluitingsDatumPlaceholder) {
      notes.push(
        `sluitingsDatum ${item.sluitingsDatum} is een plaatshouder van TenderNed (jaar ${PLACEHOLDER_DATE_YEAR} of later), geen echte termijn.`,
      );
    }
    if (item.laatsteRectificatieId && item.laatsteRectificatieId !== item.id) {
      notes.push(
        `Deze publicatie is gerectificeerd (laatste rectificatie ${item.laatsteRectificatieId}); sluitings_datum is de termijn na rectificatie. De zoekindex van TenderNed en de aankondigings-PDF tonen mogelijk nog de oorspronkelijke termijn.`,
      );
    }
    if ("error" in related) {
      item.gerelateerdePublicaties_unavailable_reason = related.error;
      notes.push("Gerelateerde publicaties konden niet worden opgehaald; de lijst kan onvolledig zijn.");
    }

    if (noticeHtml) {
      if ("error" in noticeHtml) {
        item.gunning_unavailable_reason = noticeHtml.error;
        notes.push("Waarde- en gunningsgegevens konden niet worden opgehaald (HTML-weergave van TenderNed); zie pdfUrl.");
      } else {
        const parsed = parseNoticeHtml(noticeHtml.html);
        item.geraamdeWaarde = parsed.geraamdeWaarde;
        item.gunning = parsed.gunning;
        const gunning = parsed.gunning;
        const winners = gunning?.winnaars ?? [];
        const isAwardNotice = str(data.formType) === "result";
        if (parsed.format === "unknown") {
          item.gunning_unavailable_reason = "format_unrecognized";
          if (isAwardNotice) {
            notes.push("De HTML-weergave van deze gunningspublicatie heeft een onbekende opmaak; winnaar en waarde zijn niet gelezen, zie pdf_text.");
          }
        } else if (parsed.taal === null) {
          // Labels in a language the parser does not read: an empty result says nothing.
          item.gunning_unavailable_reason = "language_unsupported";
          notes.push("De HTML-weergave van deze publicatie is niet in het Nederlands of Engels; geraamde waarde, winnaar en gunningswaarde zijn niet gelezen, zie pdf_text.");
        } else if (isAwardNotice && item.isGegund === true && !winners.length) {
          item.gunning_unavailable_reason = "no_winner_in_notice";
          notes.push("Deze gunningspublicatie noemt in de HTML-weergave geen winnaar; zie pdf_text.");
        }
        // A contract notice of an awarded procedure: the winner is in the award notice.
        const awardNotices = item.gerelateerdePublicaties.filter((r) => r.formType === "result").map((r) => r.id);
        if (!isAwardNotice && item.isGegund === true && awardNotices.length) {
          notes.push(
            `De procedure is gegund; winnaar en waarde staan in gunningspublicatie ${awardNotices.join(", ")} (opvragen met tenderned_aanbesteding_get).`,
          );
        }
        notes.push(...awardNotes(gunning, parsed.nietGelezen));
        const values = [
          parsed.geraamdeWaarde,
          gunning?.totaleWaarde ?? null,
          gunning?.raamovereenkomstMaximum ?? null,
          gunning?.raamovereenkomstWaardeBijBenadering ?? null,
          ...(gunning?.percelen ?? []).flatMap((p) => [p.waarde ?? null, p.raamovereenkomstMaximum ?? null]),
          ...winners.map((w) => w.waarde),
        ];
        if (values.some((v) => v?.placeholder)) {
          notes.push(
            `Waarden onder € ${PLACEHOLDER_VALUE_EUR.toLocaleString("nl-NL")} (bijv. '1 Euro') zijn plaatshouders of tarieven, geen contractwaarde; ze zijn gemarkeerd met placeholder: true.`,
          );
        }
      }
    }

    if (args.include_text) {
      const extracted: (PdfTextResult | PdfTextError) & { source_url: string } = await fetchPdfText(
        pdfUrl,
        { maxChars: args.max_chars, connector: CONNECTOR },
      );
      if (extracted.ok) {
        const repaired = restoreSubstitutedGlyphs(extracted.text, [item.title, item.beschrijving, item.opdrachtgever]);
        item.pdf_text = repaired.text;
        item.pdf_text_chars = repaired.text.length;
        item.pdf_text_total_chars = extracted.total_chars;
        item.pdf_text_truncated = extracted.truncated;
        item.pdf_pages = extracted.pages;
        if (repaired.restored) {
          item.pdf_text_restored_chars = repaired.restored;
          notes.push(
            `${repaired.restored} teken(s) die de TenderNed-PDF als '#' toont (het teken ontbreekt in het PDF-lettertype) zijn hersteld uit de beschrijving.`,
          );
        }
        if (repaired.unresolved) {
          notes.push(
            `${repaired.unresolved} '#'-teken(s) midden in een woord staan zo in de PDF zelf: TenderNed tekent tekens die het PDF-lettertype mist (vaak een niet-afbrekend koppelteken) als '#'.`,
          );
        }
        if (extracted.truncated) {
          notes.push(
            `pdf_text is afgekapt op ${extracted.chars} van ${extracted.total_chars} tekens; zet max_chars hoger (standaard 12000, maximaal ${MAX_PDF_TEXT_CHARS}) voor meer tekst.`,
          );
        }
      } else {
        item.pdf_text_unavailable_reason = extracted.reason;
        notes.push(`Aankondigings-PDF kon niet als tekst worden gelezen (${extracted.reason}); gebruik pdfUrl.`);
      }
    }

    return {
      item,
      endpoint: meta.url,
      params: {
        publicatieId: id,
        include_text: String(Boolean(args.include_text)),
        include_award: String(includeAward),
      },
      access_note: notes.length ? notes.join(" ") : undefined,
    };
  }
}
