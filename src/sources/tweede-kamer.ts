import { setTimeout as sleep } from "node:timers/promises";
import { getBinary, getJson, getText, SourceRequestError } from "../utils/http.js";
import { fetchPdfText } from "../utils/pdf-text.js";
import { extractDocxText, MAX_DOCX_BYTES } from "../utils/docx-text.js";
import { errorResponse, mapSourceError } from "../utils/response.js";
import type { AppConfig, MCPErrorResponse } from "../types.js";

/** Public website; document and zaak pages live under /kamerstukken. */
export const TK_WEB_BASE = "https://www.tweedekamer.nl";

/**
 * The Gegevensmagazijn rejects any $filter with more than 100 nodes ("The node
 * count limit of '100' has been exceeded"); exactly 100 passes. Filters are
 * sized against this so a long query degrades with a note instead of failing
 * with HTTP 400. Our own constructs are counted exactly (below); the margin
 * only absorbs drift on the service side.
 */
const ODATA_NODE_LIMIT = 100;
const NODE_SAFETY_MARGIN = 2;
const NODE_BUDGET = ODATA_NODE_LIMIT - NODE_SAFETY_MARGIN;

/**
 * Node costs measured on the live service to one node (October 2026):
 * - contains()/startswith()/endswith() on a field: 4; on concat(' ',F) 6, on
 *   concat(concat(' ',F),' ') 8. These yield a non-nullable Boolean.
 * - `Field eq 'x'`: 4; a date, GUID or Boolean literal adds a conversion (5);
 *   each extra path segment (Besluit/Agendapunt/...) adds 1. A comparison on a
 *   nullable field yields a nullable Boolean.
 * - and/or: 1, plus 1 for the conversion the service inserts when it joins a
 *   nullable and a non-nullable Boolean. Ignoring that undercounted a word
 *   filter with `eq` amid the string calls by 10 nodes, so a two-letter word with
 *   one date bound was planned at 95 nodes and rejected at 106.
 * - any() over Besluit/Zaak: 5 plus its body; non-nullable.
 */
const NODES_CALL = 4;
const NODES_CONNECTIVE = 1;
const NODES_CONVERT = 1;
const NODES_DATE_CMP = 5;
const NODES_LITERAL_CMP = 5;
const NODES_LAMBDA = 5;

/**
 * Text filters scan the whole table; a few seconds is normal, 20 s happens for
 * short terms under load. A request the client gives up on keeps running on
 * the service: after three aborted searches a plain one took 7 s instead of
 * 1.8 s (October 2026). So a search is sent once with room to finish, not
 * twice with a 30 s timeout each (60 s, the second competing with the first);
 * only a 5xx or a dropped connection, which a second try can fix, is retried.
 */
const SEARCH_TIMEOUT_MS = 40_000;
const SEARCH_RETRY_DELAY_MS = 600;
/**
 * A 5xx after this long is the service giving up on the query itself ("OV":
 * HTTP 500 after 30.2 s, October 2026). The identical query would fail the
 * same way after as long again, so it is reported instead of retried.
 */
const SEARCH_RETRY_MAX_ELAPSED_MS = 20_000;
/** The count before a short-term search (see countCandidates) normally takes 1–3 s. */
const PROBE_TIMEOUT_MS = 15_000;
/** Lookups by Id (decision details, link data) take well under a second. */
const LOOKUP_TIMEOUT_MS = 15_000;
const LOOKUP_RETRIES = 1;
/** Nodes kept free when a plan with an estimated caller filter is rebuilt after HTTP 400. */
const RETRY_EXTRA_RESERVE = 20;

/** Entity sets published by the Gegevensmagazijn OData v4 service ($metadata). */
export const TK_ENTITIES = [
  "Activiteit",
  "ActiviteitActor",
  "Agendapunt",
  "Besluit",
  "Commissie",
  "CommissieContactinformatie",
  "CommissieZetel",
  "CommissieZetelVastPersoon",
  "CommissieZetelVastVacature",
  "CommissieZetelVervangerPersoon",
  "CommissieZetelVervangerVacature",
  "Document",
  "DocumentActor",
  "DocumentPublicatie",
  "DocumentPublicatieMetadata",
  "DocumentVersie",
  "Fractie",
  "FractieZetel",
  "FractieZetelPersoon",
  "FractieZetelVacature",
  "Kamerstukdossier",
  "Persoon",
  "PersoonContactinformatie",
  "PersoonGeschenk",
  "PersoonLoopbaan",
  "PersoonNevenfunctie",
  "PersoonNevenfunctieInkomsten",
  "PersoonOnderwijs",
  "PersoonReis",
  "Reservering",
  "Stemming",
  "ToegezegdAan",
  "Toezegging",
  "Vergadering",
  "Verslag",
  "Zaak",
  "ZaakActor",
  "Zaal",
] as const;

/** Text fields `query` is matched against, per entity. */
export const TK_QUERY_FIELDS: Record<string, string[]> = {
  Document: ["Titel", "Onderwerp"],
  Zaak: ["Titel", "Onderwerp"],
  Kamerstukdossier: ["Titel"],
  Activiteit: ["Onderwerp"],
  Agendapunt: ["Onderwerp"],
  Besluit: ["BesluitTekst"],
  Persoon: ["Achternaam", "Roepnaam", "Functie"],
  Fractie: ["NaamNL", "Afkorting"],
  Commissie: ["NaamNL", "Afkorting"],
  Vergadering: ["Titel"],
  Toezegging: ["Tekst"],
  Stemming: ["ActorNaam", "ActorFractie"],
};

/** The date that `date_from`/`date_to` filter on, per entity. */
export const TK_DATE_FIELDS: Record<string, string> = {
  Document: "Datum",
  Zaak: "GestartOp",
  Activiteit: "Datum",
  Vergadering: "Datum",
  // Agendapunt.Aanvangstijd is empty in practice; the meeting date lives on its Activiteit.
  Agendapunt: "Activiteit/Datum",
  Toezegging: "Aanmaakdatum",
  Besluit: "Agendapunt/Activiteit/Datum",
  Stemming: "Besluit/Agendapunt/Activiteit/Datum",
};

/**
 * What a record needs for a working link: the zaak number of a Document, the
 * newest document number of a Zaak. On a search these are looked up by Id for
 * the page afterwards: expanded on the search itself, the service evaluated
 * the text filter once more ("OV": 27 s with the expand, 17 s without; the
 * lookup takes under a second).
 */
const LINK_EXPANDS: Record<string, { nav: string; expand: string }> = {
  Document: { nav: "Zaak", expand: "Zaak($select=Id,Nummer,Soort;$top=3)" },
  Zaak: { nav: "Document", expand: "Document($select=Id,DocumentNummer,Soort,Datum;$orderby=Datum desc;$top=1)" },
};
/** Ids per lookup; keeps the URL short (25 ids ≈ 1.3 kB). */
const LOOKUP_BATCH = 25;

/**
 * Decision details for votes: outcome, the zaak voted on (with one document
 * number for its page) and the date of the voting session. Fetched for the
 * distinct Besluit ids of a page of votes, not expanded on every Stemming row:
 * expanding this on the vote query took 8–52 s (often past the timeout) where
 * the same query without it took 1–13 s and this lookup under 1 s.
 */
const BESLUIT_DETAIL_SELECT = "Id,BesluitSoort,BesluitTekst,StemmingsSoort,Status";
const BESLUIT_DETAIL_EXPAND =
  "Zaak($select=Id,Nummer,Soort,Titel,Onderwerp;$expand=Document($select=Id,DocumentNummer,Soort,Datum;$orderby=Datum desc;$top=1))," +
  "Agendapunt($select=Id,Onderwerp;$expand=Activiteit($select=Id,Datum,Soort))";

/**
 * Function words carry no topic and would only make an AND-search miss: "motie
 * over de stikstof" must find what "motie stikstof" finds.
 */
const STOPWORDS = new Set([
  // Dutch
  "aan", "al", "alle", "alles", "als", "ben", "bent", "bij", "daar", "dan", "dat", "de", "deze", "die", "dit",
  "doen", "doet", "door", "een", "eens", "en", "er", "even", "gaan", "gaat", "geen", "had", "heb", "hebben", "hebt",
  "heeft", "het", "hier", "hoe", "hun", "iets", "ik", "in", "is", "je", "jij", "jullie", "kan", "kon", "kun",
  "kunnen", "kunt", "maar", "mag", "me", "meer", "met", "mij", "moet", "moeten", "mogen", "naar", "niet", "nog",
  "nu", "of", "om", "ons", "ook", "op", "over", "te", "tot", "u", "uit", "van", "voor", "waar", "waarom",
  "wanneer", "was", "waren", "wat", "we", "wel", "welk", "welke", "werd", "wie", "wij", "wil", "wilt", "willen",
  "worden", "wordt", "zal", "zich", "zijn", "zo", "zou", "zouden", "zullen",
  // Dutch prepositions for "about" ("geef informatie inzake stikstof")
  "aangaande", "betreffende", "inzake", "omtrent", "rondom",
  // English
  "a", "about", "am", "an", "and", "are", "at", "be", "by", "can", "could", "did", "do", "does", "for", "from",
  "has", "have", "how", "i", "on", "or", "the", "to", "was", "were", "what", "when", "where", "which", "who",
  "why", "with", "would", "you", "your",
]);

/**
 * Words that say how to search, not what to search for. They used to be
 * stripped by the generic query rewriter; as AND-terms they would have to occur
 * in the title ("nieuwste stikstof" found nothing). Results are already sorted
 * newest first, so the recency words lose nothing.
 */
const NON_TOPIC_WORDS = new Set([
  // recency
  "laatste", "nieuwste", "recentste", "recente", "recent", "meest", "latest", "newest", "most",
  // meta words (as in the query rewriter's moderate mode)
  "informatie", "info", "gegevens", "resultaten", "overzicht", "lijst", "onderwerp", "thema", "topic",
  "information", "results", "overview",
  // question and request frames ("kun je mij vertellen over", "ik ben op zoek naar", "laten zien")
  "geef", "geven", "toon", "tonen", "laat", "laten", "zien", "zoek", "zoeken", "opzoeken", "vind", "vinden",
  "haal", "pak", "vertel", "vertellen", "verteld", "weet", "weten", "bekend", "zit", "graag", "alsjeblieft",
  "aub", "svp", "please", "show", "find", "give", "get", "search", "tell", "know", "looking", "need", "want",
  "hoeveel",
]);

/**
 * "data" is what the caller asks for in "geef mij data over stikstof" but the
 * topic in "open data". Such a word is dropped only as the object of the
 * request: nothing but stop and request words before it, and a word before it
 * ("geef mij data ...") or a stopword right after it ("data over ...").
 */
const DATA_WORDS = new Set(["data", "dataset", "datasets"]);

/**
 * Connectors and frames whose content words would otherwise become required
 * terms ("met betrekking tot" made "betrekking" one, "ik vraag" made "vraag"
 * one). Only the whole phrase is dropped: "gebied", "relatie" or "vraag" on
 * their own can be a topic.
 */
const CONNECTOR_PHRASES: RegExp[] = [
  /(?<![\p{L}\p{N}])met\s+betrekking\s+tot(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])ten\s+aanzien\s+van(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])op\s+het\s+gebied\s+van(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])in\s+relatie\s+tot(?![\p{L}\p{N}])/giu,
  // "ik vraag informatie over", "ik vraag me af", "vraag ik me af"
  /(?<![\p{L}\p{N}])(?:ik\s+vraag|vraag\s+ik)(?:\s+(?:me|mij)\s+af)?(?![\p{L}\p{N}])/giu,
  // "ik heb een vraag over", "mijn vraag betreffende"
  /(?<![\p{L}\p{N}])(?:een|mijn)\s+vraag(?=\s+(?:over|betreffende|inzake|omtrent|aangaande|rondom|about)(?![\p{L}\p{N}]))/giu,
];

/** Terms up to this length only match as a whole word ("OV" must not hit "provincie"). */
const SHORT_TERM_MAX_LENGTH = 3;
/**
 * Fewest boundary patterns per field before a whole-word term falls back to a
 * substring match. The first two cover " OV " (also at the start or end and as
 * the whole field) and "OV-"; a substring "EU" would also match "Europa",
 * which is worse than missing an occasional "(EU)".
 */
const WORD_PATTERNS_MIN = 2;
/** Below this many patterns per field the tool says which spellings were left out. */
const WORD_PATTERNS_CORE = 5;

/**
 * Each boundary pattern costs one more check of every row that passes the
 * plain contains() and the other filters, and how many rows that are depends
 * on the letters, not on the length of the term: "ing" is in 383,504 of the
 * 715,462 Document rows (every "-ing" word), "ov" in 278,727 ("over"), "vo" in
 * 257,052 ("voor"), against 94,007 for "eu" and 4,951 for "ict". The time
 * follows rows × fields × spellings, about 6 µs per check on top of 4 s
 * (Document, quiet service, October 2026): "ING" 12.8 s with two spellings,
 * 14.3 s with three, 19.6 s with four and about 30 s with six;
 * "OV" 10.9, 15.2 and 19.0 s; "EU" 12.2 s with six; "ICT" 4.9 s.
 *
 * So the rows are counted first (countCandidates) and each short whole-word
 * term gets as many spellings as this budget of checks allows, at least the
 * two most frequent ones. The service is often twice as slow as when quiet
 * (an hour later the same "EU" plan took 21 s), so the budget aims
 * at about 10 s quiet: a quarter of SEARCH_TIMEOUT_MS, and at three times the
 * load still under the ~30 s after which the service answers HTTP 500. Rare
 * letters ("IND", "ICT") get every spelling the node budget allows,
 * "EU" five of six (15,223 hits with four, 15,257 with six), "OM" and "NS"
 * three, "ING", "OV" and "VO" two ("OV": 1,080 of 1,092 hits).
 */
const BOUNDARY_CHECK_BUDGET = 1_000_000;
/**
 * Votes match the zaak text through Besluit/Zaak/any(), and the vote rows of
 * one decision (one per fractie) share that zaak, so a check costs about a
 * sixth: "OV" (961,512 vote rows) 6.9 s with two spellings, 8.9 s with three;
 * "ING" (805,085) 9.4 s with three, 18.8 s with six. This gives both three,
 * about 9 s when quiet.
 */
const VOTE_CHECK_BUDGET = 6_000_000;
/**
 * Spellings for a short term when the rows could not be counted (dryRun, or a
 * count the service refused): " t ", " t-" and "(t)". Fewer lose "(ICT)" from
 * the dossier title "Informatie- en communicatietechnologie (ICT)": 1,060
 * instead of 2,710 documents.
 */
const UNCOUNTED_PATTERNS = 3;

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZAAK_NUMMER_RE = /^\d{4}Z\d{3,6}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Invalid tool input. The tool turns this into an explicit error instead of a silent empty result. */
export class TweedeKamerInputError extends Error {
  constructor(
    message: string,
    readonly suggestion?: string,
  ) {
    super(message);
    this.name = "TweedeKamerInputError";
  }
}

export interface TkSearchTerm {
  text: string;
  /** "word": whole word or phrase only; "substring": anywhere, also inside longer words. */
  mode: "word" | "substring";
}

export interface ParsedTkQuery {
  terms: TkSearchTerm[];
  /** Stopwords left out of the AND-search. */
  ignored: string[];
}

/**
 * The kind of Boolean an expression yields. Comparisons on nullable fields give
 * a nullable one; string functions and any() a non-nullable one. A caller's raw
 * filter is "unknown" and is assumed to need a conversion at every join.
 */
type BoolKind = "nullable" | "nonnull" | "unknown";

interface FilterPart {
  expr: string;
  nodes: number;
  kind: BoolKind;
}

function toItems(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj.value)
    ? (obj.value as Array<Record<string, unknown>>)
    : [];
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

function str(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalizeContentType(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Office formats, archives and media are binary even when their MIME type mentions "xml". */
function isBinaryContentType(contentType: string): boolean {
  return /officedocument|msword|ms-excel|ms-powerpoint|opendocument|zip|octet-stream|^image\/|^audio\/|^video\//.test(contentType);
}

function isDocxContentType(contentType: string): boolean {
  return contentType.includes("wordprocessingml");
}

function isTextLikeContentType(contentType: string): boolean {
  if (isBinaryContentType(contentType)) return false;
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("html") ||
    contentType.includes("xhtml")
  );
}

/** A "text" body that is really an archive or full of NULs must never become a preview. */
function looksBinary(text: string): boolean {
  if (text.startsWith("PK\u0003\u0004")) return true;
  const sample = text.slice(0, 2048);
  if (!sample) return false;
  let control = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 0 || (code < 9) || (code > 13 && code < 32) || code === 0xfffd) control += 1;
  }
  return control / sample.length > 0.1;
}

function normalizeTextPreview(input: string, maxChars: number): { text: string; truncated: boolean } {
  const compact = input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return { text: compact, truncated: false };
  }
  return {
    text: `${compact.slice(0, Math.max(0, maxChars)).trimEnd()}…`,
    truncated: true,
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** Map a caller's entity name onto the case-exact entity set, or undefined. */
export function resolveTkEntity(input?: string): string | undefined {
  const wanted = (input ?? "").trim().toLowerCase() || "document";
  return TK_ENTITIES.find((e) => e.toLowerCase() === wanted);
}

/* ------------------------------------------------------------------ */
/*  Query parsing and filter building                                  */
/* ------------------------------------------------------------------ */

/**
 * Split a keyword query into AND-terms.
 *
 * - Quoted text ("sociale advocatuur") is one term, matched as a whole phrase.
 * - Unquoted terms of at most three characters ("WW", "EU", "ICT") match as a
 *   whole word only; longer terms match anywhere, so "fietspad" also finds
 *   "fietspaden" and "fietspadenplan".
 * - Dutch/English function words and words about the search itself
 *   ("laatste", "informatie", "geef", "kun je mij vertellen over", "ik ben op
 *   zoek naar") are dropped unless nothing else is left, and so are connector
 *   phrases such as "met betrekking tot". A word in capitals is kept ("OM" is
 *   the Openbaar Ministerie, not "om"), unless the whole query is in capitals.
 */
export function parseTkQuery(raw: string | undefined): ParsedTkQuery {
  const input = (raw ?? "").replace(/[“”„‟«»]/g, '"').trim();
  if (!input) return { terms: [], ignored: [] };

  const terms: TkSearchTerm[] = [];
  const seen = new Set<string>();
  const push = (text: string, mode: TkSearchTerm["mode"]) => {
    const key = `${mode}:${text.toLowerCase()}`;
    if (!text || seen.has(key)) return;
    seen.add(key);
    terms.push({ text, mode });
  };

  const rest = input.replace(/"([^"]*)"/g, (_m, phrase: string) => {
    const clean = phrase.replace(/\s+/g, " ").trim();
    if (clean) push(clean, "word");
    return " ";
  });

  const tokenize = (text: string) =>
    text
      .replace(/"/g, " ")
      .split(/\s+/)
      // Strip punctuation around a token but keep inner hyphens, dots and apostrophes ("WW-uitkering", "2.0").
      .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
      .filter(Boolean);

  let phraseWords: string[] = [];
  let unquoted = rest;
  for (const re of CONNECTOR_PHRASES) {
    unquoted = unquoted.replace(re, (m) => {
      phraseWords.push(...m.toLowerCase().split(/\s+/));
      return " ";
    });
  }
  let words = tokenize(unquoted);
  // A query that is nothing but such a phrase is searched as typed.
  if (!words.length && !terms.length && phraseWords.length) {
    words = tokenize(rest);
    phraseWords = [];
  }

  // "OM" (Openbaar Ministerie) is not the stopword "om", unless everything is in capitals.
  const allCaps = !/\p{Ll}/u.test(rest);
  const capitalised = (w: string) => !allCaps && w.length >= 2 && !/\p{Ll}/u.test(w);
  const stop = words.map((w) => {
    if (capitalised(w)) return false;
    const lower = w.toLowerCase();
    return STOPWORDS.has(lower) || NON_TOPIC_WORDS.has(lower);
  });
  // "data" as the object of the request, not as the topic (see DATA_WORDS);
  // with no topic after it ("geef mij data"), it is the topic.
  let topicBefore = false;
  words.forEach((w, i) => {
    if (stop[i]) return;
    const topicAfter = stop.some((s, j) => j > i && !s);
    if (!topicBefore && topicAfter && !capitalised(w) && DATA_WORDS.has(w.toLowerCase()) && (i > 0 || stop[i + 1] === true)) {
      stop[i] = true;
      return;
    }
    topicBefore = true;
  });
  const content = words.filter((_, i) => !stop[i]);
  const kept = content.length ? content : words;
  const ignored = [...phraseWords, ...(content.length ? words.filter((_, i) => stop[i]) : [])];

  for (const word of kept) {
    push(word, word.length <= SHORT_TERM_MAX_LENGTH ? "word" : "substring");
  }

  return { terms, ignored: Array.from(new Set(ignored.map((w) => w.toLowerCase()))) };
}

/**
 * Node count and resulting kind of joining parts left to right with and/or,
 * including the conversion the service adds between a nullable and a
 * non-nullable Boolean.
 */
function joinCost(parts: FilterPart[]): { nodes: number; kind: BoolKind } {
  let nodes = parts[0].nodes;
  let kind = parts[0].kind;
  for (const p of parts.slice(1)) {
    nodes += NODES_CONNECTIVE + p.nodes;
    if (kind === "unknown" || p.kind === "unknown") {
      nodes += NODES_CONVERT;
      kind = "unknown";
    } else if (kind !== p.kind) {
      nodes += NODES_CONVERT;
      kind = "nullable";
    }
  }
  return { nodes, kind };
}

function orJoin(parts: FilterPart[]): FilterPart {
  if (parts.length === 1) return parts[0];
  return { expr: `(${parts.map((p) => p.expr).join(" or ")})`, ...joinCost(parts) };
}

function andJoin(parts: FilterPart[]): FilterPart | undefined {
  if (!parts.length) return undefined;
  if (parts.length === 1) return parts[0];
  return { expr: parts.map((p) => `(${p.expr})`).join(" and "), ...joinCost(parts) };
}

function substringPart(fields: string[], text: string): FilterPart {
  const esc = escapeODataString(text);
  return orJoin(fields.map((f) => ({ expr: `contains(${f},'${esc}')`, nodes: NODES_CALL, kind: "nonnull" })));
}

interface WordPattern {
  expr: string;
  nodes: number;
  /** How the matched text looks, for notes ("EU-", "(EU)"). */
  label: string;
}

/**
 * Whole-word patterns, most frequent first (measured on all Tweede Kamer
 * documents for four acronyms, among them EU, ICT and UWV: the first five cover
 * about 99% of the whole-word hits; after the first three, "/t" added 1,216 hits and "t," 145,
 * with "/EU" alone 8% of those for EU and "PO/VO" common for VO). OData has no
 * word-boundary operator, so the boundary is spelled out as the characters
 * around the term. Padding the field with spaces through concat() lets one
 * pattern also match the term at the start or end of the field and a field
 * that is exactly the term: "Bos" in Persoon.Achternaam, "SP" in
 * Stemming.ActorFractie. A separate `eq` pattern used to do that and was the
 * first to be cut when the node budget was tight.
 */
function wordPatterns(field: string, text: string): WordPattern[] {
  const t = escapeODataString(text);
  const both = `concat(concat(' ',${field}),' ')`;
  const left = `concat(' ',${field})`;
  const right = `concat(${field},' ')`;
  return [
    { expr: `contains(${both},' ${t} ')`, nodes: NODES_CALL + 4, label: text },
    { expr: `contains(${left},' ${t}-')`, nodes: NODES_CALL + 2, label: `${text}-` },
    { expr: `contains(${field},'(${t})')`, nodes: NODES_CALL, label: `(${text})` },
    { expr: `contains(${right},'/${t} ')`, nodes: NODES_CALL + 2, label: `/${text}` },
    { expr: `contains(${left},' ${t},')`, nodes: NODES_CALL + 2, label: `${text},` },
    { expr: `contains(${field},' ${t})')`, nodes: NODES_CALL, label: `${text})` },
    { expr: `contains(${right},'-${t} ')`, nodes: NODES_CALL + 2, label: `-${text}` },
    { expr: `contains(${field},' ${t}:')`, nodes: NODES_CALL, label: `${text}:` },
    { expr: `contains(${left},' ${t}/')`, nodes: NODES_CALL + 2, label: `${text}/` },
    { expr: `contains(${field},' ${t}.')`, nodes: NODES_CALL, label: `${text}.` },
  ];
}

const WORD_PATTERNS_MAX = wordPatterns("F", "t").length;

/**
 * A whole-word term is "contains the term AND one of the boundary patterns".
 * The plain contains() goes first: the service then evaluates the costly
 * boundary patterns only on rows that contain the term at all, which takes a
 * short-term search from ~20 s to ~5 s.
 */
function wordPart(fields: string[], text: string, patternsPerField: number): FilterPart {
  const pre = substringPart(fields, text);
  const patterns = fields.flatMap((f) => wordPatterns(f, text).slice(0, patternsPerField));
  const boundary = orJoin(patterns.map(({ expr, nodes }) => ({ expr, nodes, kind: "nonnull" as const })));
  return { expr: `${pre.expr} and ${boundary.expr}`, ...joinCost([pre, boundary]) };
}

export interface WordPatternUse {
  text: string;
  /** Boundary patterns per field used for this whole-word term. */
  patterns: number;
  /** What kept it below the full set: the 100-node budget or the check budget for short terms on large tables. */
  limit?: "nodes" | "speed";
}

export interface TextFilterResult {
  part?: FilterPart;
  /** Terms actually applied (after any downgrade/drop). */
  applied: TkSearchTerm[];
  dropped: string[];
  downgraded: string[];
  /** Boundary patterns per field the node budget allowed for whole-word terms, when any are applied. */
  patternsPerField?: number;
  /** Per applied whole-word term: patterns used and what limited them. */
  wordPatterns?: WordPatternUse[];
}

export interface TextFilterOptions {
  /**
   * Limit the spellings of short whole-word terms for speed (default true).
   * Plans turn it off for the small entities and for votes on one zaak.
   */
  capShortTerms?: boolean;
  /**
   * Rows the spellings will be checked on: the count of the same filter with
   * plain contains() terms (see countCandidates). Unknown: UNCOUNTED_PATTERNS.
   */
  candidateRows?: number;
  /** Checks (rows × fields × spellings) a search may cost; default BOUNDARY_CHECK_BUDGET. */
  checkBudget?: number;
}

/** A term that is matched on word boundaries and short enough to be a common run of letters. */
function isShortWordTerm(t: TkSearchTerm): boolean {
  return t.mode === "word" && t.text.length <= SHORT_TERM_MAX_LENGTH;
}

/**
 * Spellings per field a short whole-word term may get for speed: what the
 * check budget allows for the counted rows, shared by the short terms of the
 * query, at least WORD_PATTERNS_MIN. The node budget can lower it further.
 */
export function shortTermPatternCap(
  candidateRows: number | undefined,
  fieldCount: number,
  shortTerms: number,
  checkBudget = BOUNDARY_CHECK_BUDGET,
): number {
  if (candidateRows === undefined || !Number.isFinite(candidateRows)) return UNCOUNTED_PATTERNS;
  if (candidateRows <= 0) return WORD_PATTERNS_MAX;
  const allowed = Math.floor(checkBudget / (candidateRows * Math.max(1, fieldCount) * Math.max(1, shortTerms)));
  return Math.max(WORD_PATTERNS_MIN, Math.min(WORD_PATTERNS_MAX, allowed));
}

/**
 * Where the text part sits in the final AND-chain. A number is a flat node
 * count that already includes the connectives (kept for callers that only
 * know a total); parts are joined exactly, conversions included.
 */
export type TextFilterContext = number | { before?: FilterPart[]; after?: FilterPart[]; extraReserve?: number };

/** Node count of the whole $filter once the text part is in place. */
function totalWith(part: FilterPart | undefined, context: TextFilterContext): number {
  if (typeof context === "number") return context + (part?.nodes ?? 0);
  const all = [...(context.before ?? []), ...(part ? [part] : []), ...(context.after ?? [])];
  return (andJoin(all)?.nodes ?? 0) + (context.extraReserve ?? 0);
}

/**
 * Build the AND-filter for the parsed terms within the node budget left over by
 * the other filters. Over budget, whole-word terms first fall back to fewer
 * boundary patterns, then to substring matching, and only then are trailing
 * terms dropped — each step is reported back so the tool can say so. Short
 * terms can also be capped for speed (see BOUNDARY_CHECK_BUDGET).
 */
export function buildTextFilter(
  terms: TkSearchTerm[],
  fields: string[],
  context: TextFilterContext,
  wrap: (inner: FilterPart) => FilterPart = (inner) => inner,
  options: TextFilterOptions = {},
): TextFilterResult {
  if (!terms.length || !fields.length) return { applied: [], dropped: [], downgraded: [] };

  // Longer (usually rarer) terms first: the service short-circuits the AND.
  // `pos` keeps the caller's order for reporting.
  const ordered = terms
    .map((t, pos) => ({ ...t, pos }))
    .sort((a, b) => {
      if (a.mode !== b.mode) return a.mode === "substring" ? -1 : 1;
      return b.text.length - a.text.length;
    });

  /** Most patterns per field this term may get, whatever the node budget. */
  const shortCap =
    options.capShortTerms === false
      ? WORD_PATTERNS_MAX
      : shortTermPatternCap(options.candidateRows, fields.length, terms.filter(isShortWordTerm).length, options.checkBudget);
  const capFor = (t: TkSearchTerm) => (isShortWordTerm(t) ? shortCap : WORD_PATTERNS_MAX);

  const build = (list: TkSearchTerm[], k: number): FilterPart | undefined => {
    const inner = andJoin(
      list.map((t) => (t.mode === "word" ? wordPart(fields, t.text, Math.min(k, capFor(t))) : substringPart(fields, t.text))),
    );
    return inner ? wrap(inner) : undefined;
  };
  const fits = (part: FilterPart | undefined) => !part || totalWith(part, context) <= NODE_BUDGET;

  let current = ordered;
  const downgraded: string[] = [];
  const dropped: string[] = [];
  const usage = (k: number): WordPatternUse[] =>
    [...current]
      .sort((a, b) => a.pos - b.pos)
      .filter((t) => t.mode === "word")
      .map((t) => {
        const cap = capFor(t);
        const patterns = Math.min(k, cap);
        // Held below its cap by the node budget: "nodes"; held by the cap itself: "speed".
        const limit: WordPatternUse["limit"] = k < cap ? "nodes" : cap < WORD_PATTERNS_MAX ? "speed" : undefined;
        return { text: t.text, patterns, ...(limit ? { limit } : {}) };
      });
  const done = (part: FilterPart | undefined, k?: number): TextFilterResult => ({
    part,
    applied: [...current].sort((a, b) => a.pos - b.pos).map(({ text, mode }) => ({ text, mode })),
    dropped,
    downgraded,
    ...(k !== undefined && current.some((t) => t.mode === "word") ? { patternsPerField: k, wordPatterns: usage(k) } : {}),
  });

  for (;;) {
    const words = current.filter((t) => t.mode === "word");
    if (words.length) {
      // No point trying more patterns than any term may get.
      const kStart = Math.max(WORD_PATTERNS_MIN, ...words.map(capFor));
      for (let k = kStart; k >= WORD_PATTERNS_MIN; k -= 1) {
        const part = build(current, k);
        if (fits(part)) return done(part, k);
      }
      // Downgrade the last whole-word term to a substring match.
      for (let i = current.length - 1; i >= 0; i -= 1) {
        if (current[i].mode === "word") {
          downgraded.push(current[i].text);
          current[i] = { ...current[i], mode: "substring" };
          break;
        }
      }
      continue;
    }
    const part = build(current, WORD_PATTERNS_MIN);
    if (fits(part) || current.length <= 1) return done(part);
    dropped.unshift(current[current.length - 1].text);
    current = current.slice(0, -1);
  }
}

/**
 * Upper estimate of the node count of a caller-supplied $filter, calibrated on
 * the service: contains(Titel,'x') = 4, Soort eq 'x' = 4, Datum ge 2024-01-01
 * = 5, Verwijderd eq false and Besluit_Id eq <guid> = 5. Every and/or also
 * counts the conversion it may need, since the kinds of the operands are not
 * known here. It only sizes our own query terms next to it; if the service
 * still rejects the whole, search() retries once with fewer patterns.
 */
export function estimateODataNodes(expr: string | undefined): number {
  if (!expr?.trim()) return 0;
  let nodes = 0;
  const withoutStrings = expr
    .replace(/'(?:[^']|'')*'/g, () => {
      nodes += 1;
      return " ";
    })
    // A GUID literal is one constant plus a conversion.
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, () => {
      nodes += 2;
      return " ";
    });
  const tokenRe = /([A-Za-z_][\w]*(?:\/[A-Za-z_][\w]*)*)\s*(\()?|(\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?)|(\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(withoutStrings))) {
    if (m[1]) {
      const word = m[1].toLowerCase();
      if (["eq", "ne", "gt", "ge", "lt", "le", "has", "in"].includes(word)) nodes += 2;
      else if (["and", "or"].includes(word)) nodes += NODES_CONNECTIVE + NODES_CONVERT;
      else if (word === "not") nodes += 1;
      else if (["true", "false", "null"].includes(word)) nodes += 2;
      else nodes += 1 + (m[1].split("/").length - 1) + (m[2] ? 1 : 0);
    } else if (m[3]) {
      nodes += 2;
    } else if (m[4]) {
      nodes += 1;
    }
  }
  return nodes;
}

/* ------------------------------------------------------------------ */
/*  Dates                                                              */
/* ------------------------------------------------------------------ */

function validateDay(value: string | undefined, label: string): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  const ok = DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
  if (!ok) {
    throw new TweedeKamerInputError(`Ongeldige ${label}: '${v.slice(0, 40)}'. Gebruik het formaat JJJJ-MM-DD.`, `Bijvoorbeeld ${label}: "2026-07-01".`);
  }
  return v;
}

/** A range that ends before it starts can only find nothing; say so instead of returning an empty page. */
function assertOrderedRange(from: string | undefined, to: string | undefined): void {
  if (from && to && from > to) {
    throw new TweedeKamerInputError(
      `date_from (${from}) ligt na date_to (${to}); zo'n periode bevat niets.`,
      "Draai de twee datums om, of laat er een weg.",
    );
  }
}

/** UTC offset of Europe/Amsterdam at local midnight of `day` ("+01:00" or "+02:00"). */
function amsterdamOffset(day: string): string {
  try {
    const probe = new Date(`${day}T00:00:00+01:00`);
    const name =
      new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Amsterdam", timeZoneName: "longOffset" })
        .formatToParts(probe)
        .find((p) => p.type === "timeZoneName")?.value ?? "";
    const m = /GMT([+-]\d{2}:\d{2})/.exec(name);
    return m ? m[1] : "+01:00";
  } catch {
    return "+01:00";
  }
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Dates outside this range bound nothing in the Gegevensmagazijn, and as
 * literals they break: the day after 9999-12-31 is year 10000, and before 1900
 * Amsterdam's local-mean-time offset turns 0001-01-01 into a time before the
 * smallest DateTimeOffset. Both are common "open end" sentinels, so such a
 * bound is left out (and reported) instead of failing with HTTP 400.
 */
const FIRST_FILTER_DAY = "1900-01-01";
const LAST_DAY = "9999-12-31";

/**
 * Day boundaries in Dutch local time. Tweede Kamer dates are local midnights
 * ("2026-10-01T00:00:00+02:00" is 30 September 22:00 UTC), so UTC boundaries
 * dropped the first day of a range and leaked the day after its end.
 */
export function tkDayRange(from?: string, to?: string): { start?: string; endExclusive?: string } {
  const out: { start?: string; endExclusive?: string } = {};
  if (from && from >= FIRST_FILTER_DAY) out.start = `${from}T00:00:00${amsterdamOffset(from)}`;
  if (to && to < LAST_DAY) {
    // Nothing is dated before 1900, so an earlier end means "nothing" either way.
    const next = to < FIRST_FILTER_DAY ? FIRST_FILTER_DAY : nextDay(to);
    out.endExclusive = `${next}T00:00:00${amsterdamOffset(next)}`;
  }
  return out;
}

/** Note for a given date bound that tkDayRange left out, or undefined. */
function openBoundNote(from?: string, to?: string): string | undefined {
  const notes: string[] = [];
  if (from && from < FIRST_FILTER_DAY) notes.push(`date_from ${from} legt geen ondergrens op`);
  if (to && to >= LAST_DAY) notes.push(`date_to ${to} legt geen bovengrens op`);
  return notes.length ? `${notes.join("; ")}.` : undefined;
}

function datePart(field: string, from?: string, to?: string): FilterPart | undefined {
  const range = tkDayRange(from, to);
  const segments = field.split("/").length - 1;
  const parts: FilterPart[] = [];
  if (range.start) parts.push({ expr: `${field} ge ${range.start}`, nodes: NODES_DATE_CMP + segments, kind: "nullable" });
  if (range.endExclusive) parts.push({ expr: `${field} lt ${range.endExclusive}`, nodes: NODES_DATE_CMP + segments, kind: "nullable" });
  return andJoin(parts);
}

/* ------------------------------------------------------------------ */
/*  Links and titles                                                   */
/* ------------------------------------------------------------------ */

function firstObject(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) return value.find((v) => v && typeof v === "object") as Record<string, unknown> | undefined;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Public page of a zaak; the site needs both the zaak number and one of its document numbers. */
export function tkKamerstukUrl(zaakNummer?: string, documentNummer?: string): string | undefined {
  const z = str(zaakNummer);
  const d = str(documentNummer);
  if (!z || !d) return undefined;
  return `${TK_WEB_BASE}/kamerstukken/detail?id=${encodeURIComponent(z)}&did=${encodeURIComponent(d)}`;
}

/** Direct download of the document file (PDF or Word) by document number. */
export function tkDownloadUrl(documentNummer?: string): string | undefined {
  const d = str(documentNummer);
  return d ? `${TK_WEB_BASE}/downloads/document?id=${encodeURIComponent(d)}` : undefined;
}

/**
 * Title that names the actual subject. For most Kamerstukken `Titel` is the
 * dossier title ("Belastingdienst", "Natuurbeleid") shared by hundreds of
 * documents, while `Onderwerp` says what this one is about. A generic subject
 * ("Memorie van toelichting") gets the dossier title appended.
 */
export function tkSubjectTitle(item: Record<string, unknown>, fallback = "Document"): string {
  const titel = str(item.Titel);
  const onderwerp = str(item.Onderwerp);
  if (!onderwerp) return titel || str(item.DocumentNummer) || str(item.Nummer) || str(item.Id) || fallback;
  if (!titel) return onderwerp;
  const lo = onderwerp.toLowerCase();
  const lt = titel.toLowerCase();
  if (lo === lt || lo.includes(lt)) return onderwerp;
  // "Motie van het lid X over Y" names its subject; "Voorstel van wet" or
  // "Nota naar aanleiding van het verslag" does not without the dossier title.
  const namesSubject = /\b(over|inzake|betreffende|omtrent|aangaande)\b|m\.b\.t\./i.test(onderwerp);
  if (onderwerp.length < 60 && !namesSubject) return `${onderwerp} – ${truncate(titel, 160)}`;
  return onderwerp;
}

export interface TkRecordView {
  title: string;
  url: string;
  snippet: string;
  date: string;
}

function day(value: unknown): string {
  const s = str(value);
  return s ? s.slice(0, 10) : "";
}

/** Title, link, snippet and date for one record of any entity. */
export function tkRecordView(entity: string, item: Record<string, unknown>, apiBase: string): TkRecordView {
  const apiUrl = str(item.api_url) || (str(item.Id) ? `${apiBase}/${entity}(${str(item.Id)})` : apiBase);
  const url = str(item.web_url) || str(item.download_url) || str(item.resource_url) || apiUrl;

  switch (entity) {
    case "Document": {
      const title = tkSubjectTitle(item);
      const dossier = str(item.Titel);
      const snippet = [str(item.Soort), str(item.DocumentNummer), dossier && !title.includes(dossier) ? `dossier: ${dossier}` : ""]
        .filter(Boolean)
        .join(" · ");
      return { title, url, snippet, date: str(item.Datum) };
    }
    case "Zaak": {
      const title = tkSubjectTitle(item, "Zaak");
      const snippet = [str(item.Soort), str(item.Nummer), str(item.Status)].filter(Boolean).join(" · ");
      return { title, url, snippet, date: str(item.GestartOp) || str(item.GewijzigdOp) };
    }
    case "Persoon": {
      const name = [item.Roepnaam, item.Tussenvoegsel, item.Achternaam].map(str).filter(Boolean).join(" ");
      return { title: name || str(item.Id) || "Persoon", url, snippet: str(item.Functie), date: str(item.GewijzigdOp) };
    }
    case "Fractie":
    case "Commissie":
      return { title: str(item.NaamNL) || str(item.Afkorting) || str(item.Id) || entity, url, snippet: str(item.Afkorting), date: str(item.GewijzigdOp) };
    case "Besluit":
      return { title: str(item.BesluitTekst) || str(item.BesluitSoort) || str(item.Id) || "Besluit", url, snippet: str(item.BesluitSoort), date: str(item.GewijzigdOp) };
    case "Stemming": {
      const actor = str(item.ActorFractie) || str(item.ActorNaam) || "Stemming";
      return { title: `${actor}: ${str(item.Soort) || "stemming"}`, url, snippet: str(item.Soort), date: str(item.GewijzigdOp) };
    }
    case "Toezegging":
      return { title: truncate(str(item.Tekst) || str(item.Nummer) || "Toezegging", 200), url, snippet: str(item.Status), date: str(item.Aanmaakdatum) || str(item.GewijzigdOp) };
    default: {
      const title = str(item.Titel) || str(item.Onderwerp) || str(item.NaamNL) || str(item.Naam) || str(item.Id) || entity;
      return { title, url, snippet: str(item.Onderwerp) || str(item.Soort), date: str(item.Datum) || str(item.GewijzigdOp) };
    }
  }
}

/** Add link fields to a record. Upstream fields stay untouched. */
function withLinks(entity: string, item: Record<string, unknown>, apiBase: string): Record<string, unknown> {
  const id = str(item.Id);
  const out: Record<string, unknown> = { ...item };
  if (id) out.api_url = `${apiBase}/${entity}(${id})`;

  if (entity === "Document") {
    const zaak = firstObject(item.Zaak);
    const web = tkKamerstukUrl(str(zaak?.Nummer), str(item.DocumentNummer));
    const download = tkDownloadUrl(str(item.DocumentNummer));
    if (web) out.web_url = web;
    if (download) out.download_url = download;
    if (id) out.resource_url = `${apiBase}/Document(${id})/Resource`;
  } else if (entity === "Zaak") {
    const doc = firstObject(item.Document);
    const web = tkKamerstukUrl(str(item.Nummer), str(doc?.DocumentNummer));
    if (web) out.web_url = web;
  }
  return out;
}

/** Outcome of a vote from the decision text ("Stemmen - aangenomen", "Verworpen."). */
function voteOutcome(besluitSoort: string, besluitTekst: string): string | null {
  const hay = `${besluitSoort} ${besluitTekst}`.toLowerCase();
  for (const word of ["aangenomen", "verworpen", "aangehouden", "ingetrokken", "vervallen"]) {
    if (hay.includes(word)) return word;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Error mapping                                                      */
/* ------------------------------------------------------------------ */

/**
 * Explicit errors for this source: input problems name the problem, and an
 * HTTP 400 from OData (bad field, bad orderby, filter too large) says so
 * instead of a bare "request failed".
 */
export function mapTweedeKamerError(error: unknown, context: Record<string, unknown> = {}): MCPErrorResponse {
  if (error instanceof TweedeKamerInputError) {
    return errorResponse({ error: "unexpected", message: error.message, suggestion: error.suggestion });
  }
  if (error instanceof SourceRequestError && error.status === 400) {
    return errorResponse({
      error: "http_error",
      message:
        "Tweede Kamer OData weigerde de aanvraag (HTTP 400). Meestal een veldnaam die niet bestaat voor deze entity, een ongeldige filter- of orderby-expressie, of een filter met meer dan 100 knopen.",
      suggestion:
        "Controleer veldnamen (zie https://gegevensmagazijn.tweedekamer.nl/OData/v4/2.0/$metadata), gebruik minder zoektermen of een eenvoudiger filter.",
      details: { endpoint: error.endpoint, status: 400, ...context },
    });
  }
  return mapSourceError(error, "Tweede Kamer", TK_WEB_BASE);
}

/* ------------------------------------------------------------------ */
/*  Source                                                             */
/* ------------------------------------------------------------------ */

export interface TkQueryPlan {
  entity: string;
  params: Record<string, string>;
  /** Dutch notes for access_note: how the query was interpreted and what was not applied. */
  notes: string[];
  terms: TkSearchTerm[];
  /** Fields the query terms were matched against (empty without query terms). */
  fields: string[];
  /** True when a rejected request can be retried with a smaller text filter. */
  shrinkable?: boolean;
  /**
   * The count to send before this plan, when it has short whole-word terms on
   * a large entity and was built without `candidateRows` (see countCandidates).
   */
  probe?: TkProbe;
}

/** A `$count` of the rows the boundary checks of a plan would run on. */
export interface TkProbe {
  entity: string;
  filter: string;
}

export interface TkPlanOptions {
  /** Nodes kept free beyond our own count (the rebuild after an HTTP 400). */
  extraReserve?: number;
  /** The probe's count; sizes the spellings of short terms (see BOUNDARY_CHECK_BUDGET). */
  candidateRows?: number;
}

/**
 * The count for a plan with short whole-word terms: the same filters with
 * every term as a plain contains(), which are the rows the service checks the
 * word-boundary spellings on. `others` are the plan's other parts in their
 * place around the text part, `wrap` its any() for votes.
 */
function probeFor(
  entity: string,
  terms: TkSearchTerm[],
  fields: string[],
  others: { before?: FilterPart[]; after?: FilterPart[] },
  wrap?: (inner: FilterPart) => FilterPart,
): TkProbe | undefined {
  if (!terms.some(isShortWordTerm)) return undefined;
  const plain = buildTextFilter(
    terms.map((t) => ({ ...t, mode: "substring" as const })),
    fields,
    others,
    wrap,
  );
  const filter = andJoin([...(others.before ?? []), ...(plain.part ? [plain.part] : []), ...(others.after ?? [])]);
  return filter ? { entity, filter: filter.expr } : undefined;
}

interface EntityPage {
  items: Array<Record<string, unknown>>;
  total: number | null;
  endpoint: string;
  params: Record<string, string>;
}

/**
 * Failures a second identical request can fix: a 5xx or a dropped connection.
 * Not a timeout: the service is still running the first one.
 */
function isTransient(error: unknown): boolean {
  if (!(error instanceof SourceRequestError)) return false;
  if (error.code === "network_error") return true;
  return error.code === "http_error" && (error.status ?? 0) >= 500;
}

/**
 * Deleted records stay as tombstones: every field null except Id and
 * GewijzigdOp, which is the newest of all (102,381 of 715,462 Documents,
 * October 2026). A listing without query terms put them on its first page,
 * titled by their GUID; text terms never match them.
 */
const NOT_DELETED: FilterPart = { expr: "Verwijderd eq false", nodes: NODES_LITERAL_CMP, kind: "nullable" };

const LINKS_FAILED_NOTE =
  "De links naar de kamerstukpagina's konden niet (allemaal) worden opgehaald; die records verwijzen naar het document of de API.";

function describeTerms(applied: TkSearchTerm[], fields: string[]): string {
  const list = applied.map((t) => `"${t.text}" (${t.mode === "word" ? "los woord" : "ook als deel van een woord"})`).join(" EN ");
  const base = `Zoektermen ${applied.length > 1 ? "(alle verplicht) " : ""}${list} in ${fields.join("/")}; hoofdletterongevoelig, wel accentgevoelig.`;
  // "politie" also finds "politiek": say how to ask for the word alone.
  const sub = applied.find((t) => t.mode === "substring");
  return sub ? `${base} Alleen het losse woord: geef de term tussen aanhalingstekens op, dus "${sub.text}" in plaats van ${sub.text}.` : base;
}

/** A query of only punctuation must not silently turn into an unfiltered listing. */
function assertSearchable(query: string | undefined, parsed: ParsedTkQuery): void {
  if (query?.trim() && !parsed.terms.length) {
    throw new TweedeKamerInputError(
      `De zoekterm '${query.trim().slice(0, 60)}' bevat geen letters of cijfers om op te zoeken.`,
      "Geef trefwoorden op, of laat query leeg en gebruik alleen filters.",
    );
  }
}

/**
 * Notes on how the query was applied. `dateHint` names the parameter that
 * narrows the rows (so a short term gets more spellings), when the tool has
 * one; `candidateRows` is the count those spellings were sized on.
 */
function textNotes(
  parsed: ParsedTkQuery,
  text: TextFilterResult,
  fields: string[],
  context: { dateHint?: string; candidateRows?: number } = {},
): string[] {
  const { dateHint, candidateRows } = context;
  const notes: string[] = [];
  if (text.applied.length) notes.push(describeTerms(text.applied, fields));
  if (parsed.ignored.length) notes.push(`Genegeerde stopwoorden: ${parsed.ignored.join(", ")}.`);
  const limited = (text.wordPatterns ?? []).filter((u) => u.patterns < WORD_PATTERNS_CORE);
  const spellings = (u: WordPatternUse) => {
    const labels = wordPatterns("F", u.text).map((p) => `"${p.label}"`);
    return { used: labels.slice(0, u.patterns).join(", "), left: labels.slice(u.patterns, WORD_PATTERNS_CORE).join(", ") };
  };
  const byNodes = limited.find((u) => u.limit === "nodes");
  if (byNodes) {
    const s = spellings(byNodes);
    notes.push(
      `Woordgrens-filter ingekort (API-limiet van 100 knopen): alleen ${s.used} gezocht ` +
        `(ook aan begin of eind en als hele waarde), niet ${s.left} e.d.`,
    );
  }
  const capped = limited.filter((u) => u.limit === "speed");
  if (capped.length) {
    const list = capped
      .map((u) => {
        const s = spellings(u);
        return `"${u.text}" alleen als ${s.used} (ook aan begin of eind en als hele waarde), niet als ${s.left} e.d.`;
      })
      .join(" ");
    const rows =
      candidateRows !== undefined && Number.isFinite(candidateRows)
        ? `De letters staan in ${candidateRows.toLocaleString("nl-NL")} records (binnen de overige filters)`
        : "Zo'n korte lettercombinatie komt in veel woorden voor";
    notes.push(
      `Korte zoekterm in de meest voorkomende schrijfwijzen gezocht: ${list} ${rows} en ` +
        `elke extra schrijfwijze kost de API een doorzoeking van al die records` +
        (dateHint ? `; met ${dateHint} (een kortere periode) worden meer schrijfwijzen gezocht.` : "."),
    );
  }
  if (text.downgraded.length) {
    notes.push(`Te veel korte termen voor de woordgrens-filter van de API; als deel van een woord gezocht: ${text.downgraded.join(", ")}.`);
  }
  if (text.dropped.length) {
    notes.push(`Filter te groot voor de Tweede Kamer-API (max. 100 knopen); deze termen zijn NIET toegepast: ${text.dropped.join(", ")}.`);
  }
  return notes;
}

export class TweedeKamerSource {
  constructor(private readonly config: AppConfig) {}

  private get apiBase(): string {
    return this.config.endpoints.tweedeKamer;
  }

  /**
   * `$count=true` makes the service report how many rows match the filter,
   * not just how many were returned. Without it the only number available is
   * the page size, and reporting that as the total told every caller their
   * 25 results were all there was. Verified present on Document, Zaak, Persoon,
   * Fractie, Besluit and Stemming; `null` when a response omits it.
   */
  private async fetchEntity(
    entity: string,
    params: Record<string, string>,
    options: { timeoutMs?: number; retries?: number } = {},
  ): Promise<{
    items: Array<Record<string, unknown>>;
    total: number | null;
    endpoint: string;
    params: Record<string, string>;
  }> {
    const endpoint = `${this.apiBase}/${entity}`;
    const query = { $count: "true", ...params };
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, { query, ...options });
    const rawCount = Number(data["@odata.count"]);
    return {
      items: toItems(data),
      total: Number.isFinite(rawCount) ? rawCount : null,
      endpoint: meta.url,
      params: query,
    };
  }

  /**
   * `send` once more after a 5xx or a dropped connection, which a second
   * request can fix. Not after a timeout (the service is still running the
   * first) and not after a 5xx that took longer than
   * SEARCH_RETRY_MAX_ELAPSED_MS (the service gave up on the query itself).
   */
  private async withTransientRetry<T>(send: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await send();
    } catch (error) {
      if (!isTransient(error) || Date.now() - started > SEARCH_RETRY_MAX_ELAPSED_MS) throw error;
      await sleep(SEARCH_RETRY_DELAY_MS);
      return await send();
    }
  }

  /** One search request (see SEARCH_TIMEOUT_MS and withTransientRetry). */
  private async fetchSearch(plan: TkQueryPlan): Promise<EntityPage> {
    return this.withTransientRetry(() =>
      this.fetchEntity(plan.entity, plan.params, { timeoutMs: SEARCH_TIMEOUT_MS, retries: 0 }),
    );
  }

  /**
   * How many rows a plan's word-boundary spellings would be checked on (see
   * BOUNDARY_CHECK_BUDGET): `$count` of its filters with plain contains()
   * terms, 1–3 s. A timeout, an outage or an open circuit is reported at once:
   * the heavier search would fail the same way, after up to 40 s and with one
   * more failure toward the circuit breaker. A count the service refuses (4xx)
   * leaves the rows unknown and the search goes ahead with UNCOUNTED_PATTERNS.
   */
  private async countCandidates(probe: TkProbe | undefined): Promise<number | undefined> {
    if (!probe) return undefined;
    try {
      const { data } = await this.withTransientRetry(() =>
        getJson<Record<string, unknown>>(`${this.apiBase}/${probe.entity}`, {
          query: { $count: "true", $top: "0", $filter: probe.filter },
          timeoutMs: PROBE_TIMEOUT_MS,
          retries: 0,
        }),
      );
      const count = Number(data["@odata.count"]);
      return Number.isFinite(count) && count >= 0 ? count : undefined;
    } catch (error) {
      const status = error instanceof SourceRequestError ? error.status : undefined;
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) return undefined;
      throw error;
    }
  }

  /**
   * Rows of `entity` by Id, in batches, with the given $select/$expand. A
   * failed batch leaves the rest usable and is reported as `failed`.
   */
  private async lookupByIds(
    entity: string,
    ids: string[],
    query: { $select: string; $expand: string },
  ): Promise<{ byId: Map<string, Record<string, unknown>>; failed: boolean }> {
    const byId = new Map<string, Record<string, unknown>>();
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += LOOKUP_BATCH) batches.push(ids.slice(i, i + LOOKUP_BATCH));
    const results = await Promise.allSettled(
      batches.map((batch) =>
        getJson<Record<string, unknown>>(`${this.apiBase}/${entity}`, {
          query: { $filter: `Id in (${batch.join(",")})`, ...query, $top: String(batch.length) },
          timeoutMs: LOOKUP_TIMEOUT_MS,
          retries: LOOKUP_RETRIES,
        }),
      ),
    );
    let failed = false;
    for (const result of results) {
      if (result.status === "rejected") {
        failed = true;
        continue;
      }
      for (const row of toItems(result.value.data)) {
        const id = str(row.Id).toLowerCase();
        if (id) byId.set(id, row);
      }
    }
    return { byId, failed };
  }

  /**
   * Records of a search page with their link data (see LINK_EXPANDS) and
   * their web, download and API links.
   */
  private async linkPage(entity: string, items: Array<Record<string, unknown>>): Promise<{ items: Array<Record<string, unknown>>; failed: boolean }> {
    const link = LINK_EXPANDS[entity];
    const ids = Array.from(new Set(items.map((item) => str(item.Id).toLowerCase()).filter((id) => GUID_RE.test(id))));
    let failed = false;
    let enriched = items;
    if (link && ids.length) {
      const found = await this.lookupByIds(entity, ids, { $select: "Id", $expand: link.expand });
      failed = found.failed;
      enriched = items.map((item) => {
        const row = found.byId.get(str(item.Id).toLowerCase());
        return row && row[link.nav] !== undefined ? { ...item, [link.nav]: row[link.nav] } : item;
      });
    }
    return { items: enriched.map((item) => withLinks(entity, item, this.apiBase)), failed };
  }

  /**
   * Build (without fetching) the OData request for tweede_kamer_search.
   * `extraReserve` leaves that many more nodes free (used for the retry after
   * the service rejected a plan whose caller filter was underestimated).
   */
  planSearch(
    args: {
      entity?: string;
      query?: string;
      top: number;
      filter?: string;
      orderby?: string;
      skip?: number;
      date_from?: string;
      date_to?: string;
    },
    options: TkPlanOptions = {},
  ): TkQueryPlan {
    const entity = resolveTkEntity(args.entity);
    if (!entity) {
      throw new TweedeKamerInputError(
        `Onbekende Tweede Kamer-entity '${String(args.entity).slice(0, 60)}'.`,
        `Kies een van: ${TK_ENTITIES.join(", ")}. Voor Kamerstukken: Document of Kamerstukdossier.`,
      );
    }

    const dateFrom = validateDay(args.date_from, "date_from");
    const dateTo = validateDay(args.date_to, "date_to");
    assertOrderedRange(dateFrom, dateTo);
    const parsed = parseTkQuery(args.query);
    const notes: string[] = [];

    const parts: FilterPart[] = [];
    const dateField = TK_DATE_FIELDS[entity];
    if (dateFrom || dateTo) {
      if (!dateField) {
        throw new TweedeKamerInputError(
          `date_from/date_to wordt niet ondersteund voor entity ${entity} (geen datumveld).`,
          `Datumfilters werken voor: ${Object.keys(TK_DATE_FIELDS).join(", ")}. Gebruik anders 'filter', bijv. "GewijzigdOp ge 2026-01-01T00:00:00Z".`,
        );
      }
      const part = datePart(dateField, dateFrom, dateTo);
      if (part) parts.push(part);
      notes.push(
        dateField.includes("/")
          ? `Datumfilter op ${entity}.${dateField} (Nederlandse tijd); de datum bij elk record is de wijzigingsdatum (GewijzigdOp).`
          : `Datumfilter op ${entity}.${dateField} (Nederlandse tijd).`,
      );
      const open = openBoundNote(dateFrom, dateTo);
      if (open) notes.push(open);
    }

    const userFilter = args.filter?.trim();
    if (!parsed.terms.length && entity !== "ToegezegdAan" && !/\bVerwijderd\b/i.test(userFilter ?? "")) {
      parts.unshift(NOT_DELETED);
    }
    if (userFilter) parts.push({ expr: userFilter, nodes: estimateODataNodes(userFilter), kind: "unknown" });

    assertSearchable(args.query, parsed);
    let terms: TkSearchTerm[] = [];
    let fields: string[] = [];
    let shrinkable = false;
    let probe: TkProbe | undefined;
    if (parsed.terms.length) {
      fields = TK_QUERY_FIELDS[entity] ?? [];
      if (!fields.length) {
        throw new TweedeKamerInputError(
          `'query' wordt niet ondersteund voor entity ${entity}.`,
          `Zoeken op tekst werkt voor: ${Object.keys(TK_QUERY_FIELDS).join(", ")}. Gebruik voor ${entity} de parameter 'filter'.`,
        );
      }
      // Entities without a date field are small (Persoon, Fractie, Commissie,
      // Kamerstukdossier: at most ~8,000 rows); only the large ones need the cap.
      const capShortTerms = Boolean(dateField);
      const others = [...parts];
      const text = buildTextFilter(parsed.terms, fields, { after: others, extraReserve: options.extraReserve }, undefined, {
        capShortTerms,
        candidateRows: options.candidateRows,
      });
      if (text.part) parts.unshift(text.part);
      terms = text.applied;
      notes.push(...textNotes(parsed, text, fields, { dateHint: dateField ? "date_from" : undefined, candidateRows: options.candidateRows }));
      // Only the caller's filter is estimated; our own parts are counted exactly.
      shrinkable = Boolean(userFilter) && (text.patternsPerField !== undefined || text.applied.length > 1);
      if (capShortTerms && options.candidateRows === undefined) probe = probeFor(entity, parsed.terms, fields, { after: others });
    }

    const params: Record<string, string> = {
      $top: String(args.top),
    };
    // ToegezegdAan has no GewijzigdOp; every other entity does.
    const orderby = args.orderby?.trim() || (entity === "ToegezegdAan" ? "" : "GewijzigdOp desc");
    if (orderby) params.$orderby = orderby;
    const filter = andJoin(parts);
    if (filter) params.$filter = filter.expr;
    if (typeof args.skip === "number" && args.skip > 0) params.$skip = String(args.skip);

    return { entity, params, notes, terms, fields, shrinkable, ...(probe ? { probe } : {}) };
  }

  /**
   * Generic OData search. Any upstream failure is thrown: the old catch-all
   * retried without filter and orderby, filtered one page locally and reported
   * the size of the whole collection as the total.
   *
   * The one exception is narrow: when the plan combines query terms with a
   * caller filter (whose node count is only estimated) and the service answers
   * HTTP 400, the same request is rebuilt once with a smaller text part. Same
   * filters, fewer word-boundary spellings; a second 400 is reported as is.
   */
  async search(args: {
    entity?: string;
    query?: string;
    top: number;
    filter?: string;
    orderby?: string;
    skip?: number;
    date_from?: string;
    date_to?: string;
  }) {
    const candidateRows = await this.countCandidates(this.planSearch(args).probe);
    let plan = this.planSearch(args, { candidateRows });
    let out: EntityPage;
    try {
      out = await this.fetchSearch(plan);
    } catch (error) {
      if (!(error instanceof SourceRequestError && error.status === 400 && plan.shrinkable)) throw error;
      const smaller = this.planSearch(args, { extraReserve: RETRY_EXTRA_RESERVE, candidateRows });
      if (smaller.params.$filter === plan.params.$filter) throw error;
      try {
        out = await this.fetchSearch(smaller);
      } catch {
        throw error;
      }
      plan = {
        ...smaller,
        notes: [
          ...smaller.notes,
          "De API weigerde de eerste aanvraag (HTTP 400, vermoedelijk de limiet van 100 knopen door de opgegeven filter); opnieuw gezocht met een kleinere woordgrens-filter.",
        ],
      };
    }
    const linked = await this.linkPage(plan.entity, out.items);
    return {
      ...out,
      entity: plan.entity,
      notes: linked.failed ? [...plan.notes, LINKS_FAILED_NOTE] : plan.notes,
      terms: plan.terms,
      fields: plan.fields,
      items: linked.items,
    };
  }

  /** Build (without fetching) the OData request for tweede_kamer_documents. */
  planDocuments(
    args: {
      query?: string;
      top: number;
      type?: string;
      date_from?: string;
      date_to?: string;
      skip?: number;
    },
    options: TkPlanOptions = {},
  ): TkQueryPlan {
    const dateFrom = validateDay(args.date_from, "date_from");
    const dateTo = validateDay(args.date_to, "date_to");
    assertOrderedRange(dateFrom, dateTo);
    const parts: FilterPart[] = [];
    const notes: string[] = [];

    const date = datePart("Datum", dateFrom, dateTo);
    if (date) parts.push(date);
    const open = openBoundNote(dateFrom, dateTo);
    if (open) notes.push(open);
    if (args.type?.trim()) {
      parts.push(substringPart(["Soort", "Titel"], args.type.trim()));
    }

    const parsed = parseTkQuery(args.query);
    assertSearchable(args.query, parsed);
    if (!parsed.terms.length) parts.unshift(NOT_DELETED);
    const fields = TK_QUERY_FIELDS.Document;
    const others = [...parts];
    const text = buildTextFilter(parsed.terms, fields, { after: others }, undefined, { candidateRows: options.candidateRows });
    if (text.part) parts.unshift(text.part);
    notes.push(...textNotes(parsed, text, fields, { dateHint: "date_from", candidateRows: options.candidateRows }));
    const probe = options.candidateRows === undefined ? probeFor("Document", parsed.terms, fields, { after: others }) : undefined;

    const params: Record<string, string> = {
      $top: String(args.top),
      $orderby: "Datum desc",
    };
    const filter = andJoin(parts);
    if (filter) params.$filter = filter.expr;
    if (typeof args.skip === "number" && args.skip > 0) params.$skip = String(args.skip);

    return {
      entity: "Document",
      params,
      notes,
      terms: text.applied,
      fields: text.applied.length ? fields : [],
      ...(probe ? { probe } : {}),
    };
  }

  async searchDocuments(args: {
    query?: string;
    top: number;
    type?: string;
    date_from?: string;
    date_to?: string;
    skip?: number;
  }) {
    const candidateRows = await this.countCandidates(this.planDocuments(args).probe);
    const plan = this.planDocuments(args, { candidateRows });
    const out = await this.fetchSearch(plan);
    const linked = await this.linkPage("Document", out.items);
    return {
      ...out,
      notes: linked.failed ? [...plan.notes, LINKS_FAILED_NOTE] : plan.notes,
      terms: plan.terms,
      fields: plan.fields,
      items: linked.items,
    };
  }

  async getDocument(args: {
    id: string;
    resolve_resource?: boolean;
    include_text?: boolean;
    max_chars?: number;
  }) {
    const docEndpoint = `${this.apiBase}/Document(${args.id})`;
    // The zaak number is what the public kamerstukken page needs; the document
    // itself only knows its own number.
    const { data, meta } = await getJson<Record<string, unknown>>(docEndpoint, {
      query: { $expand: LINK_EXPANDS.Document.expand },
    });

    const resourceUrl = `${this.apiBase}/Document(${args.id})/Resource`;
    const typedResourceUrl = `${this.apiBase}/Document(${args.id})/TK.DA.GGM.OData.Resource`;
    const maxChars = Math.max(1, Math.min(50_000, args.max_chars ?? 12_000));
    const contentType = normalizeContentType(data.ContentType);

    const linked = withLinks("Document", data, this.apiBase);
    const item: Record<string, unknown> = {
      ...linked,
      resource_url: resourceUrl,
      typed_resource_url: typedResourceUrl,
    };

    if (args.resolve_resource || args.include_text) {
      item.resource_resolved = true;
      item.resolved_resource_url = resourceUrl;
      item.resource_content_type = contentType || String(data.ContentType ?? "");
      item.resource_content_length = data.ContentLength ?? null;
    }

    if (args.include_text) {
      if (!contentType) {
        item.text_preview_unavailable_reason = "missing_content_type";
      } else if (contentType.includes("pdf")) {
        // Kamerstukken are overwhelmingly PDF; extract the text layer instead of
        // handing the caller a link it cannot read.
        const extracted = await fetchPdfText(resourceUrl, {
          maxChars,
          connector: "tweede_kamer",
        });
        item.resolved_resource_url = extracted.source_url;
        if (extracted.ok) {
          item.text_preview = extracted.text;
          item.text_preview_chars = extracted.chars;
          item.text_preview_truncated = extracted.truncated;
          item.text_preview_source = "pdf_text_layer";
          item.resource_pages = extracted.pages;
        } else {
          item.text_preview_unavailable_reason = `pdf_${extracted.reason}`;
        }
      } else if (isDocxContentType(contentType)) {
        // A .docx is a ZIP archive: read word/document.xml instead of the raw bytes.
        try {
          const { data: bytes, meta: resMeta } = await getBinary(resourceUrl, {
            connector: "tweede_kamer",
            timeoutMs: 30_000,
            retries: 1,
            maxResponseBytes: MAX_DOCX_BYTES,
          });
          item.resolved_resource_url = resMeta.url;
          const extracted = extractDocxText(bytes, { maxChars });
          if (extracted.ok) {
            item.text_preview = extracted.text;
            item.text_preview_chars = extracted.chars;
            item.text_preview_truncated = extracted.truncated;
            item.text_preview_source = "docx_document_xml";
          } else {
            item.text_preview_unavailable_reason = `docx_${extracted.reason}`;
          }
        } catch (error) {
          // The byte cap fails inside the download, before extractDocxText can say "too_large".
          const tooLarge = error instanceof SourceRequestError && /exceeded/i.test(error.message);
          const code = error instanceof SourceRequestError ? error.code : "unexpected";
          item.text_preview_unavailable_reason = tooLarge ? "docx_too_large" : `docx_fetch_failed:${code}`;
        }
      } else if (!isTextLikeContentType(contentType)) {
        item.text_preview_unavailable_reason = "content_type_not_supported";
      } else {
        const resource = await getText(resourceUrl, {
          disableCache: true,
          headers: {
            accept: "text/plain, text/html, application/json, application/xml;q=0.9, */*;q=0.1",
          },
        });
        item.resolved_resource_url = resource.meta.url;
        if (looksBinary(resource.data)) {
          item.text_preview_unavailable_reason = "binary_content";
        } else {
          const preview = normalizeTextPreview(resource.data, maxChars);
          item.text_preview = preview.text;
          item.text_preview_chars = preview.text.length;
          item.text_preview_truncated = preview.truncated;
        }
      }
    }

    return {
      item,
      endpoint: meta.url,
      params: {
        id: args.id,
        resolve_resource: String(Boolean(args.resolve_resource)),
        include_text: String(Boolean(args.include_text)),
        max_chars: String(maxChars),
      },
    };
  }

  /** Build (without fetching) the OData request for tweede_kamer_votes. */
  planVotes(
    args: {
      zaak_id?: string;
      besluit_id?: string;
      zaak_nummer?: string;
      query?: string;
      date?: string;
      date_from?: string;
      date_to?: string;
      top: number;
      skip?: number;
      /** Set by getVotes after looking the GUID up; without it both readings are tried. */
      zaak_id_kind?: "zaak" | "besluit";
    },
    options: TkPlanOptions = {},
  ): TkQueryPlan {
    const parts: FilterPart[] = [NOT_DELETED];
    const notes: string[] = [];
    const besluitIs = (id: string): FilterPart => ({ expr: `Besluit_Id eq ${id}`, nodes: NODES_LITERAL_CMP, kind: "nullable" });
    const zaakIs = (cond: string): FilterPart => ({ expr: `Besluit/Zaak/any(z: ${cond})`, nodes: NODES_LAMBDA + NODES_CALL, kind: "nonnull" });

    const zaakId = args.zaak_id?.trim();
    if (zaakId) {
      if (GUID_RE.test(zaakId)) {
        // zaak_id used to be sent as a Besluit_Id; accept both so old callers keep working.
        if (args.zaak_id_kind === "zaak") {
          parts.push(zaakIs(`z/Id eq ${zaakId}`));
        } else if (args.zaak_id_kind === "besluit") {
          parts.push(besluitIs(zaakId));
        } else {
          const either = [besluitIs(zaakId), zaakIs(`z/Id eq ${zaakId}`)];
          parts.push({ expr: either.map((p) => p.expr).join(" or "), ...joinCost(either) });
        }
      } else if (ZAAK_NUMMER_RE.test(zaakId)) {
        parts.push(zaakIs(`z/Nummer eq '${zaakId.toUpperCase()}'`));
      } else {
        throw new TweedeKamerInputError(
          `Ongeldige zaak_id '${zaakId.slice(0, 60)}': verwacht een GUID (Zaak- of Besluit-Id) of een zaaknummer zoals 2026Z15215.`,
          "Gebruik zaak_nummer voor een zaaknummer of query voor een onderwerp.",
        );
      }
    }
    const besluitId = args.besluit_id?.trim();
    if (besluitId) {
      if (!GUID_RE.test(besluitId)) {
        throw new TweedeKamerInputError(`Ongeldige besluit_id '${besluitId.slice(0, 60)}': verwacht een GUID.`);
      }
      parts.push(besluitIs(besluitId));
    }
    const zaakNummer = args.zaak_nummer?.trim();
    if (zaakNummer) {
      if (!ZAAK_NUMMER_RE.test(zaakNummer)) {
        throw new TweedeKamerInputError(`Ongeldig zaak_nummer '${zaakNummer.slice(0, 60)}': verwacht bijvoorbeeld 2026Z15215.`);
      }
      parts.push(zaakIs(`z/Nummer eq '${zaakNummer.toUpperCase()}'`));
    }

    const exactDay = validateDay(args.date, "date");
    if (exactDay && (args.date_from?.trim() || args.date_to?.trim())) {
      throw new TweedeKamerInputError(
        "Geef óf date (één dag) óf date_from/date_to op, niet allebei.",
        `Voor alleen ${exactDay}: laat date_from en date_to weg. Voor een periode: laat date weg.`,
      );
    }
    const dateFrom = exactDay ?? validateDay(args.date_from, "date_from");
    const dateTo = exactDay ?? validateDay(args.date_to, "date_to");
    assertOrderedRange(dateFrom, dateTo);
    if (dateFrom || dateTo) {
      const part = datePart(TK_DATE_FIELDS.Stemming, dateFrom, dateTo);
      if (part) parts.push(part);
      notes.push("Datumfilter op de datum van de stemmingsvergadering (Nederlandse tijd), niet op de wijzigingsdatum van het record.");
      const open = openBoundNote(dateFrom, dateTo);
      if (open) notes.push(open);
    }

    const parsed = parseTkQuery(args.query);
    assertSearchable(args.query, parsed);
    let terms: TkSearchTerm[] = [];
    let searched: string[] = [];
    let probe: TkProbe | undefined;
    if (parsed.terms.length) {
      const fields = ["z/Titel", "z/Onderwerp"];
      // One zaak or besluit leaves a handful of vote rows: nothing to count or cap.
      const capShortTerms = !(zaakId || besluitId || zaakNummer);
      const others = [...parts];
      const wrap = (inner: FilterPart): FilterPart => ({
        expr: `Besluit/Zaak/any(z: ${inner.expr})`,
        nodes: inner.nodes + NODES_LAMBDA,
        kind: "nonnull",
      });
      const text = buildTextFilter(parsed.terms, fields, { before: others }, wrap, {
        capShortTerms,
        candidateRows: options.candidateRows,
        checkBudget: VOTE_CHECK_BUDGET,
      });
      if (text.part) parts.push(text.part);
      terms = text.applied;
      searched = ["Zaak.Titel", "Zaak.Onderwerp"];
      notes.push(...textNotes(parsed, text, searched, { dateHint: "date of date_from", candidateRows: options.candidateRows }));
      if (capShortTerms && options.candidateRows === undefined) probe = probeFor("Stemming", parsed.terms, fields, { before: others }, wrap);
    }

    const filter = andJoin(parts);
    const params: Record<string, string> = {
      $top: String(args.top),
      // GewijzigdOp is when the record last changed (corrections touch votes
      // from months ago); the session date is when the vote took place.
      $orderby: "Besluit/Agendapunt/Activiteit/Datum desc,Besluit_Id,ActorFractie",
    };
    if (filter) params.$filter = filter.expr;
    if (typeof args.skip === "number" && args.skip > 0) params.$skip = String(args.skip);

    return { entity: "Stemming", params, notes, terms, fields: searched, ...(probe ? { probe } : {}) };
  }

  /**
   * Decision details (outcome, zaak, voting session) for the given Besluit ids.
   * A failure leaves the votes usable and is reported by the caller.
   */
  private fetchBesluiten(ids: string[]): Promise<{ byId: Map<string, Record<string, unknown>>; failed: boolean }> {
    return this.lookupByIds("Besluit", ids, { $select: BESLUIT_DETAIL_SELECT, $expand: BESLUIT_DETAIL_EXPAND });
  }

  /**
   * Votes per fractie (or member), each linked to its decision (Besluit) and the
   * motion, amendment or bill it was about (Zaak), including the outcome.
   */
  async getVotes(args: {
    zaak_id?: string;
    besluit_id?: string;
    zaak_nummer?: string;
    query?: string;
    date?: string;
    date_from?: string;
    date_to?: string;
    top: number;
    skip?: number;
  }) {
    const zaakId = args.zaak_id?.trim();
    // "Besluit_Id eq X or <lambda>" defeats the index (~12 s); one cheap lookup
    // tells which of the two the GUID is, and the vote query then takes ~2 s.
    const zaakIdKind = zaakId && GUID_RE.test(zaakId) ? await this.zaakIdKind(zaakId) : undefined;
    const voteArgs = { ...args, zaak_id_kind: zaakIdKind };
    const candidateRows = await this.countCandidates(this.planVotes(voteArgs).probe);
    const plan = this.planVotes(voteArgs, { candidateRows });
    const out = await this.fetchSearch(plan);

    const besluitIds = Array.from(
      new Set(out.items.map((v) => str(v.Besluit_Id).toLowerCase()).filter((id) => GUID_RE.test(id))),
    );
    const details = besluitIds.length ? await this.fetchBesluiten(besluitIds) : { byId: new Map(), failed: false };
    const notes = details.failed
      ? [
          ...plan.notes,
          "Besluit- en zaakgegevens (uitslag, motie, stemmingsdatum) konden niet (allemaal) worden opgehaald; de stemmingen zelf zijn volledig. Probeer het opnieuw of gebruik besluit_id.",
        ]
      : plan.notes;

    const items = out.items.map((vote) => {
      const { Besluit: rawBesluit, ...stemming } = vote;
      const besluit = details.byId.get(str(stemming.Besluit_Id).toLowerCase()) ?? firstObject(rawBesluit) ?? {};
      const agendapunt = firstObject(besluit.Agendapunt);
      const activiteit = firstObject(agendapunt?.Activiteit);
      const zaken = (Array.isArray(besluit.Zaak) ? (besluit.Zaak as Array<Record<string, unknown>>) : []).map((z) => {
        const doc = firstObject(z.Document);
        const nummer = str(z.Nummer);
        const docNummer = str(doc?.DocumentNummer);
        return {
          id: z.Id ?? null,
          nummer: nummer || null,
          soort: z.Soort ?? null,
          titel: z.Titel ?? null,
          onderwerp: z.Onderwerp ?? null,
          document_nummer: docNummer || null,
          web_url: tkKamerstukUrl(nummer, docNummer) ?? null,
          api_url: str(z.Id) ? `${this.apiBase}/Zaak(${str(z.Id)})` : null,
        };
      });
      const zaak = zaken[0];
      const besluitId = str(besluit.Id) || str(stemming.Besluit_Id);
      const besluitSoort = str(besluit.BesluitSoort);
      const besluitTekst = str(besluit.BesluitTekst);
      const besluitApi = besluitId ? `${this.apiBase}/Besluit(${besluitId})` : undefined;

      return {
        ...stemming,
        besluit_id: besluitId || null,
        besluit_soort: besluitSoort || null,
        besluit_tekst: besluitTekst || null,
        besluit_status: besluit.Status ?? null,
        stemmingssoort: besluit.StemmingsSoort ?? null,
        uitslag: voteOutcome(besluitSoort, besluitTekst),
        stemming_datum: activiteit?.Datum ?? null,
        agendapunt_onderwerp: agendapunt?.Onderwerp ?? null,
        zaken,
        zaak_id: zaak?.id ?? null,
        zaak_nummer: zaak?.nummer ?? null,
        zaak_soort: zaak?.soort ?? null,
        zaak_titel: zaak?.titel ?? null,
        zaak_onderwerp: zaak?.onderwerp ?? null,
        web_url: zaak?.web_url ?? undefined,
        api_url: besluitApi ?? (str(stemming.Id) ? `${this.apiBase}/Stemming(${str(stemming.Id)})` : undefined),
      } as Record<string, unknown>;
    });

    return { ...out, items, notes, terms: plan.terms, fields: plan.fields };
  }

  /** "zaak" when the GUID is a Zaak, "besluit" when the service says it is not; undefined if unsure. */
  private async zaakIdKind(guid: string): Promise<"zaak" | "besluit" | undefined> {
    try {
      await getJson<Record<string, unknown>>(`${this.apiBase}/Zaak(${guid})`, {
        query: { $select: "Id" },
        timeoutMs: 10_000,
        retries: 0,
      });
      return "zaak";
    } catch (error) {
      if (error instanceof SourceRequestError && error.status === 404) return "besluit";
      return undefined;
    }
  }

  /** Title, link, snippet and date for a vote row from getVotes. */
  static voteView(item: Record<string, unknown>): TkRecordView {
    const actor = str(item.ActorFractie) || str(item.ActorNaam) || "Stemming";
    const soort = str(item.Soort).toLowerCase() || "stemming";
    const subject = str(item.zaak_onderwerp) || str(item.zaak_titel) || str(item.agendapunt_onderwerp) || str(item.besluit_tekst);
    const title = subject ? `${actor} ${soort}: ${subject}` : `${actor} ${soort}`;
    const zaakLabel = [str(item.zaak_soort), str(item.zaak_nummer)].filter(Boolean).join(" ");
    const snippet = [str(item.besluit_tekst) || str(item.besluit_soort), zaakLabel, day(item.stemming_datum) ? `stemming ${day(item.stemming_datum)}` : ""]
      .filter(Boolean)
      .join(" · ");
    return {
      title,
      url: str(item.web_url) || str(item.api_url),
      snippet,
      date: str(item.stemming_datum) || str(item.GewijzigdOp),
    };
  }

  async getMembers(args: { fractie?: string; active?: boolean; top: number }) {
    // 1) Members
    const personsParams: Record<string, string> = {
      $top: String(Math.min(Math.max(args.top * 5, 50), 250)),
      $orderby: "Achternaam asc",
      $filter: "contains(Functie,'Tweede Kamerlid')",
    };
    const personsOut = await this.fetchEntity("Persoon", personsParams);

    // 2) Seating links (person -> seat)
    const linksParams: Record<string, string> = {
      $top: "250",
      $orderby: "GewijzigdOp desc",
    };
    if (args.active !== false) {
      linksParams.$filter = "TotEnMet eq null";
    }
    const linksOut = await this.fetchEntity("FractieZetelPersoon", linksParams);

    // 3) Seat -> faction
    const seatsOut = await this.fetchEntity("FractieZetel", { $top: "250" });
    const factionsOut = await this.fetchEntity("Fractie", { $top: "200" });

    const seatToFaction = new Map<string, string>();
    for (const seat of seatsOut.items) {
      const seatId = String(seat.Id ?? "");
      const fractieId = String(seat.Fractie_Id ?? "");
      if (seatId && fractieId) seatToFaction.set(seatId, fractieId);
    }

    const factionById = new Map<string, Record<string, unknown>>();
    for (const f of factionsOut.items) {
      const id = String(f.Id ?? "");
      if (id) factionById.set(id, f);
    }

    const activeLinkByPerson = new Map<string, Record<string, unknown>>();
    for (const link of linksOut.items) {
      const personId = String(link.Persoon_Id ?? "");
      if (!personId) continue;
      if (!activeLinkByPerson.has(personId)) {
        activeLinkByPerson.set(personId, link);
      }
    }

    const normFractieFilter = (args.fractie ?? "").trim().toLowerCase();

    const items: Array<Record<string, unknown>> = [];
    for (const p of personsOut.items) {
      const personId = String(p.Id ?? "");
      const link = activeLinkByPerson.get(personId);
      const seatId = String(link?.FractieZetel_Id ?? "");
      const factionId = seatToFaction.get(seatId) ?? "";
      const faction = factionById.get(factionId);
      const fractieAfkorting = String(faction?.Afkorting ?? "");
      const fractieNaam = String(faction?.NaamNL ?? faction?.NaamEN ?? "");

      if (normFractieFilter) {
        const hay = `${fractieAfkorting} ${fractieNaam}`.toLowerCase();
        if (!hay.includes(normFractieFilter)) continue;
      }

      const fullName = [p.Roepnaam, p.Tussenvoegsel, p.Achternaam]
        .map((x) => (x ? String(x).trim() : ""))
        .filter(Boolean)
        .join(" ");

      items.push({
        id: p.Id,
        name: fullName || String(p.Achternaam ?? p.Id ?? "Onbekend"),
        roepnaam: p.Roepnaam,
        achternaam: p.Achternaam,
        fractie: fractieAfkorting || undefined,
        fractie_naam: fractieNaam || undefined,
        start_date: link?.Van,
        end_date: link?.TotEnMet,
        roles: p.Functie,
        persoon_url: `${this.config.endpoints.tweedeKamer}/Persoon(${personId})`,
      });

      if (items.length >= args.top) break;
    }

    return {
      items,
      endpoint: personsOut.endpoint,
      params: {
        ...personsOut.params,
        fractie: args.fractie ?? "",
        active: String(args.active !== false),
      },
    };
  }
}
