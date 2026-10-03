import type { AppConfig } from "../types.js";
import { getJson, postJson, SourceRequestError } from "../utils/http.js";
import { htmlToText } from "../utils/html-text.js";
import { placeKey, placeVariants } from "../utils/place-aliases.js";

/**
 * Open Raadsinformatie (ORI) — one Elasticsearch 7.9 cluster with one index per
 * government body:
 *
 *   ori_<slug>_<timestamp>   gemeenten (and Amsterdam's stadsdelen)
 *   osi_<slug>_<timestamp>   provincies
 *   owi_<slug>_<timestamp>   waterschappen
 *
 * Each index has a stable alias without the timestamp (`ori_delft`). The slugs
 * are irregular — `ori_capelle_ad_ijssel`, `ori_hofvantwente`,
 * `ori_kaag_en_brasssem`, `ori_den_bosch`, `osi_provincie-utrecht`, hyphens in
 * some names and underscores in others — so an index cannot be derived from a
 * name. This module therefore resolves names against the live index list
 * (GET /_aliases) and the official name ORI stores in every index's top-level
 * Organization record ("Gemeente Leidschendam-Voorburg", "Provincie Fryslân").
 *
 * Field facts the code below relies on (checked against GET /_mapping of all
 * 331 indices):
 *   - there is no `datePublished`; sorting on it is a 400 in every index;
 *   - `last_discussed_at` (date of the last meeting that discussed the record)
 *     is mapped everywhere and set on documents, agenda items and meetings;
 *   - Reports carry `start_date`/`end_date` instead; Persons carry no date;
 *   - only documents (MediaObject) carry `url`/`original_url`;
 *   - documents carry their full text three times (`text`, `md_text`,
 *     `text_pages`), which is why an unrestricted `_source` blew through the
 *     12 MB response cap at 50-200 rows.
 */

export type OriLayer = "gemeente" | "provincie" | "waterschap";
type OriPrefix = "ori_" | "osi_" | "owi_";

const LAYER_PREFIX: Record<OriLayer, OriPrefix> = { gemeente: "ori_", provincie: "osi_", waterschap: "owi_" };
const PREFIX_LAYER: Record<OriPrefix, OriLayer> = { ori_: "gemeente", osi_: "provincie", owi_: "waterschap" };
const PREFIXES = Object.keys(PREFIX_LAYER) as OriPrefix[];
/** Order in which a bare name like "Groningen" or "Utrecht" is resolved. */
const LAYER_ORDER: OriLayer[] = ["gemeente", "provincie", "waterschap"];

interface OriItem {
  id?: string;
  title?: string;
  type?: string;
  organization?: string;
  publishedAt?: string;
  url?: string;
  [key: string]: unknown;
}

interface ElasticHit {
  _id?: string;
  _index?: string;
  _source?: Record<string, unknown>;
  highlight?: Record<string, string[]>;
}

interface ElasticResponse {
  timed_out?: boolean;
  _shards?: { total?: number; successful?: number; skipped?: number; failed?: number };
  hits?: {
    total?: { value?: number; relation?: string } | number;
    hits?: ElasticHit[];
  };
  aggregations?: Record<
    string,
    { value?: number | null; value_as_string?: string; buckets?: Array<{ key?: string; doc_count?: number }> } | undefined
  >;
}

type AliasesResponse = Record<string, { aliases?: Record<string, unknown> } | undefined>;

const ORI_BASE = "https://api.openraadsinformatie.nl/v1/elastic";
const ORI_SEARCH = `${ORI_BASE}/_search`;
const CONNECTOR = "ori";

/** The index list changes a few times a year; one day of caching is plenty. */
const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed load, wait this long before trying the index list again. */
const CATALOGUE_RETRY_MS = 2 * 60 * 1000;
/** The index list normally answers in well under a second; a hung request must not hold up searches. */
const CATALOGUE_TIMEOUT_MS = 6_000;
/** A search without gemeente only needs the list for names; it waits at most this long for a load in progress. */
const CATALOGUE_GRACE_MS = 1_500;
/** Newest meeting older than this is reported as a stale index. Covers the summer recess. */
const STALE_AFTER_DAYS = 60;
const SEARCH_TIMEOUT_MS = 20_000;
/** Server-side budget, below the client timeout so ORI returns partial hits instead of nothing. */
const SERVER_TIMEOUT = "15s";
const MAX_ATTACHMENT_LOOKUP = 100;
const MAX_ATTACHMENTS_PER_RECORD = 5;

/**
 * Only these fields come back in `_source`. Everything heavy (`text`, `md_text`,
 * `text_pages`, `@context`, `was_generated_by`, member lists) stays upstream;
 * the snippet is cut server-side by the highlighter instead.
 */
const SOURCE_FIELDS = [
  "@id", "@type", "name", "title", "file_name", "url", "original_url", "content_type",
  "size_in_bytes", "last_discussed_at", "start_date", "date_modified", "description",
  "classification", "attachment",
];

/** ORI's top-level Organization record is wrong for this index (Noordwijkerhout merged into Noordwijk in 2019). */
const NAME_OVERRIDES: Record<string, string> = { ori_noordwijk: "Noordwijk" };

const RESOLVE_PREFIX = "https://api.openraadsinformatie.nl/v1/resolve/";

/**
 * Source hosts for which ORI's resolver answers every document with HTTP 404
 * while the source system's own link (original_url) serves the file. Checked
 * 2026-10-03 on the two newest documents of each of the 331 indices, and on the
 * oldest and a random document of each of the 316 indices holding documents:
 * these two hosts failed on every document, at any date, and Dronten on every
 * "//" link (see resolveIsBroken); every other failure was a document that is
 * gone at the source as well (original_url answers 400/404/500 too).
 */
const RESOLVE_BROKEN_HOSTS = new Set(["raad.hardinxveld-giessendam.nl", "ris.gemeenteraadhuizen.nl"]);

/** Documents behind an iBabs report list ("lijst moties", "toezeggingen", "ingekomen stukken"). */
const IBABS_REPORT_PREFIX = `${RESOLVE_PREFIX}ibabs/report/`;

const TYPE_LABELS: Record<string, string> = {
  MediaObject: "Document",
  AgendaItem: "Agendapunt",
  Meeting: "Vergadering",
  Report: "Rapport/lijstitem",
  Person: "Persoon",
  Organization: "Organisatie",
  Membership: "Lidmaatschap",
  ImageObject: "Afbeelding",
};

/* ------------------------------------------------------------------ */
/*  Names and keys                                                     */
/* ------------------------------------------------------------------ */

const TYPE_WORD_RE = /^\s*(gemeente|provincie|waterschap|hoogheemraadschap(?:\s+van)?|wetterskip)\s+/i;

function layerOfTypeWord(word: string): OriLayer | undefined {
  const w = word.toLowerCase();
  if (w === "gemeente") return "gemeente";
  if (w === "provincie") return "provincie";
  if (/^(waterschap|hoogheemraadschap|wetterskip)/.test(w)) return "waterschap";
  return undefined;
}

/**
 * Comparison key for an organisation name: case, accents, punctuation and the
 * type word ("Gemeente", "Provincie", "Hoogheemraadschap van") removed, the
 * "a/d" and "St." abbreviations ORI uses in slugs spelled out, a leading "'s"
 * dropped, and finally all spaces removed — so "Hof van Twente" meets the slug
 * `hofvantwente` and "Capelle aan den IJssel" meets `capelle_ad_ijssel`.
 */
function orgKey(raw: string): string {
  let key = placeKey(raw)
    .replace(/^(gemeente|provincie|waterschap|hoogheemraadschap van|hoogheemraadschap|wetterskip) /, "")
    .replace(/^s /, "");
  key = ` ${key} `.replace(/ a d | ad /g, " aan den ").replace(/ st /g, " sint ").trim();
  return key.replace(/\s+/g, "");
}

/** Same as orgKey but keeps word boundaries, for "is there also X Y?" hints. */
function spacedOrgKey(raw: string): string {
  return placeKey(raw)
    .replace(/^(gemeente|provincie|waterschap|hoogheemraadschap van|hoogheemraadschap|wetterskip) /, "")
    .replace(/^s /, "");
}

const LOWERCASE_WORDS = new Set(["aan", "bij", "de", "den", "der", "en", "het", "in", "op", "over", "te", "ten", "ter", "van"]);

function capitalise(word: string): string {
  if (!word) return word;
  if (word.startsWith("ij")) return `IJ${word.slice(2)}`;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Readable name from a slug alone — only used when ORI has no Organization
 * record for an index or the record could not be fetched. Connecting words stay
 * lowercase ("Berg en Dal", "Bergen op Zoom"), "ij" becomes "IJ", and every part
 * after a hyphen is capitalised ("Reusel-De Mierden").
 */
function nameFromSlug(prefix: OriPrefix, slug: string): string {
  // In water-board slugs a hyphen stands for a space (`aa-en-maas`); in province
  // slugs only after "provincie-" (`provincie-utrecht`, but `noord-holland`).
  const cleaned = (prefix === "owi_" ? slug.replace(/-/g, "_") : slug).replace(/^provincie[_-]/, "");
  const words = cleaned.split("_").filter(Boolean);
  const name = words
    .map((word, wi) =>
      word
        .split("-")
        .map((part, pi) => (wi > 0 && pi === 0 && LOWERCASE_WORDS.has(part) ? part : capitalise(part)))
        .join("-"),
    )
    .join(" ");
  if (prefix === "osi_") return `Provincie ${name}`;
  if (prefix === "owi_" && !/^(Waterschap|Hoogheemraadschap|Wetterskip)\b/.test(name)) return `Waterschap ${name}`;
  return name;
}

/**
 * The name shown in `organization`: municipalities without the generic
 * "Gemeente " (as before: "Delft", now also "IJsselstein", "'s-Hertogenbosch"),
 * provinces and water boards with their type word, because "Groningen" and
 * "Limburg" are each two different bodies in ORI.
 */
function displayName(prefix: OriPrefix, slug: string, oriName?: string): string {
  const override = NAME_OVERRIDES[`${prefix}${slug}`];
  if (override) return override;
  const name = oriName?.replace(/\s+/g, " ").trim();
  if (!name) return nameFromSlug(prefix, slug);
  if (prefix === "ori_") return name.replace(/^Gemeente\s+/i, "");
  if (prefix === "osi_") return /^Provincie\b/i.test(name) ? name : `Provincie ${name}`;
  return /^(Waterschap|Hoogheemraadschap|Wetterskip)\b/i.test(name) ? name : `Waterschap ${name}`;
}

/** Municipality index slug as ORI usually spells it: lowercase, spaces to underscores. */
export function gemeenteToIndexSlug(gemeente: string): string {
  return placeKey(gemeente).replace(/\s+/g, "_");
}

/**
 * Municipality name out of an `ori_` index name, from the slug alone. The live
 * catalogue (ORI's own organisation names) takes precedence; this is the
 * fallback when that is unavailable.
 */
export function indexToGemeente(index: string | undefined): string {
  if (!index || !index.startsWith("ori_")) return "";
  const slug = index.slice("ori_".length).replace(/_\d{8,}$/, "");
  if (!slug) return "";
  return displayName("ori_", slug);
}

/** Organisation name of a concrete index, from its slug (no index list needed). */
function concreteName(index: string): string {
  const prefix = prefixOf(index);
  return prefix ? displayName(prefix, index.slice(prefix.length).replace(/_\d{8,}$/, "")) : index;
}

/** Type words ORI keeps in some province and water-board slugs (`osi_provincie-utrecht`, `owi_hoogheemraadschap_van_delfland`). */
const SLUG_TYPE_WORDS: Record<OriPrefix, string[]> = {
  ori_: [""],
  osi_: ["", "provincie-", "provincie_"],
  owi_: ["", "waterschap_", "hoogheemraadschap_", "hoogheemraadschap_van_", "wetterskip_"],
};

/**
 * Index patterns for a name in one layer, for when the index list is
 * unavailable: every slug spelling ORI uses (underscores or hyphens, with or
 * without the type word), each as `<slug>_2*`. That pattern reaches exactly
 * the concrete indices of that slug — the aliased one and any unaliased copy —
 * and never a longer name: `ori_bergen_2*` does not reach `ori_bergen_nh_…`.
 */
export function fallbackIndexPatterns(input: string, layer: OriLayer): string[] {
  const prefix = LAYER_PREFIX[layer];
  const bases = new Set<string>();
  for (const variant of placeVariants(input.replace(TYPE_WORD_RE, "") || input)) {
    const base = gemeenteToIndexSlug(variant);
    if (!base) continue;
    bases.add(base);
    bases.add(base.replace(/_/g, "-"));
  }
  const patterns = new Set<string>();
  for (const base of bases) for (const typeWord of SLUG_TYPE_WORDS[prefix]) patterns.add(`${prefix}${typeWord}${base}_2*`);
  return [...patterns];
}

/* ------------------------------------------------------------------ */
/*  Catalogue                                                          */
/* ------------------------------------------------------------------ */

export interface OriIndexEntry {
  /** What a search path uses: ORI's stable alias, or the concrete index when it has none. */
  index: string;
  /**
   * Other concrete indices of the same body that the alias does not cover
   * (Heemskerk: an older iBabs index next to the current one). They hold
   * records the alias lacks, so a scoped search includes them.
   */
  copies: string[];
  prefix: OriPrefix;
  layer: OriLayer;
  slug: string;
  /** Organisation name, see displayName(). */
  name: string;
  keys: string[];
  spacedKeys: string[];
}

export interface OriCatalogue {
  entries: OriIndexEntry[];
  /** Concrete index names and aliases → entry, to name the organisation of a hit. */
  byIndex: Map<string, OriIndexEntry>;
}

function prefixOf(index: string): OriPrefix | undefined {
  return PREFIXES.find((p) => index.startsWith(p));
}

/**
 * Build the catalogue from GET /_aliases and the top-level Organization records.
 *
 * An index can exist twice for one body. Heemskerk has its current index behind
 * the alias `ori_heemskerk` and an older one without an alias; the old one is
 * not a stale duplicate (it holds 16,020 records against 7,031 and is the only
 * source for 2018-2023, under other ids). Both concrete names map to one entry,
 * and a scoped search covers the alias plus the unaliased copy; records that
 * appear in both are merged by dedupeOriItems.
 */
export function buildOriCatalogue(aliases: AliasesResponse, orgHits: ElasticHit[] = []): OriCatalogue {
  const groups = new Map<string, { prefix: OriPrefix; slug: string; alias?: string; concretes: string[]; unaliased: string[] }>();
  for (const [concrete, info] of Object.entries(aliases ?? {})) {
    const prefix = prefixOf(concrete);
    if (!prefix) continue;
    const alias = Object.keys(info?.aliases ?? {}).find((a) => a.startsWith(prefix));
    const slug = (alias ?? concrete).slice(prefix.length).replace(/_\d{8,}$/, "");
    if (!slug) continue;
    const id = `${prefix}${slug}`;
    const group = groups.get(id) ?? { prefix, slug, concretes: [], unaliased: [] };
    if (alias) group.alias = alias;
    else group.unaliased.push(concrete);
    group.concretes.push(concrete);
    groups.set(id, group);
  }

  const wanted: Record<OriPrefix, string> = { ori_: "Municipality", osi_: "Province", owi_: "Water board" };
  const oriNames = new Map<string, { name: string; exact: boolean }>();
  for (const hit of orgHits) {
    const index = hit._index ?? "";
    const prefix = prefixOf(index);
    const name = typeof hit._source?.name === "string" ? hit._source.name : "";
    if (!prefix || !name) continue;
    const exact = hit._source?.classification === wanted[prefix];
    const seen = oriNames.get(index);
    if (!seen || (exact && !seen.exact)) oriNames.set(index, { name, exact });
  }

  const entries: OriIndexEntry[] = [];
  const byIndex = new Map<string, OriIndexEntry>();
  for (const group of groups.values()) {
    const newestFirst = [...group.concretes].sort().reverse();
    const oriName = newestFirst.map((c) => oriNames.get(c)?.name).find(Boolean);
    const name = displayName(group.prefix, group.slug, oriName);
    const sources = [group.slug, name, ...(oriName ? [oriName] : [])];
    const index = group.alias ?? newestFirst[0];
    const entry: OriIndexEntry = {
      index,
      copies: group.unaliased.filter((c) => c !== index).sort().reverse(),
      prefix: group.prefix,
      layer: PREFIX_LAYER[group.prefix],
      slug: group.slug,
      name,
      keys: [...new Set(sources.map(orgKey).filter(Boolean))],
      spacedKeys: [...new Set(sources.map(spacedOrgKey).filter(Boolean))],
    };
    entries.push(entry);
    byIndex.set(entry.index, entry);
    for (const concrete of group.concretes) byIndex.set(concrete, entry);
  }
  entries.sort((a, b) => a.index.localeCompare(b.index));
  return { entries, byIndex };
}

export interface OriScopeResolution {
  entry?: OriIndexEntry;
  /** Same name in another layer ("Groningen": gemeente and provincie). */
  alternatives: OriIndexEntry[];
  /** Separate indices under a longer name ("Amsterdam" → its stadsdelen; "Bergen" → "Bergen NH"). */
  related: OriIndexEntry[];
  /** Near names, only when nothing matched exactly. */
  suggestions: OriIndexEntry[];
  /** Layer that was applied: the explicit bestuurslaag, else one implied by "Provincie …". */
  layer?: OriLayer;
}

/**
 * Exact lookup of a gemeente/provincie/waterschap name in the catalogue.
 *
 * Exact after normalisation — never a prefix — because a prefix is what made
 * "Alphen" search Alphen-Chaam and "Amsterdam" pull in Amsterdam-Zuidoost.
 * Aliases from utils/place-aliases (Den Haag/'s-Gravenhage, Den Bosch/
 * 's-Hertogenbosch, Friesland/Fryslân) are tried as well.
 */
export function resolveOriScope(catalogue: OriCatalogue, input: string, layer?: OriLayer): OriScopeResolution {
  const typeWord = TYPE_WORD_RE.exec(input)?.[1];
  const wantLayer = layer ?? (typeWord ? layerOfTypeWord(typeWord.split(/\s+/)[0]) : undefined);
  const core = input.replace(TYPE_WORD_RE, "").trim();
  const variants = placeVariants(core || input);
  const keys = new Set(variants.map(orgKey).filter(Boolean));
  const spaced = [...new Set(variants.map(spacedOrgKey).filter(Boolean))];

  const matches = catalogue.entries
    .filter((e) => e.keys.some((k) => keys.has(k)))
    .sort((a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer));
  const entry = matches.find((e) => !wantLayer || e.layer === wantLayer);
  const alternatives = matches.filter((e) => e !== entry);

  if (entry) {
    const related = catalogue.entries.filter(
      (e) => e !== entry && !alternatives.includes(e) && e.layer === entry.layer &&
        e.spacedKeys.some((s) => spaced.some((p) => s.startsWith(`${p} `))),
    );
    return { entry, alternatives, related, suggestions: [], layer: wantLayer };
  }

  // Nothing exact: offer names sharing a distinctive word, or starting with the input.
  const words = spaced.flatMap((s) => s.split(" ")).filter((w) => w.length >= 4);
  const prefixes = spaced.filter((p) => p.length >= 3);
  const suggestions = catalogue.entries
    .filter((e) => !wantLayer || e.layer === wantLayer)
    .filter((e) =>
      e.spacedKeys.some((s) => prefixes.some((p) => s.startsWith(p)) || s.split(" ").some((w) => words.includes(w))),
    )
    .slice(0, 6);
  return { alternatives, related: [], suggestions, layer: wantLayer };
}

/* ------------------------------------------------------------------ */
/*  Parameters                                                         */
/* ------------------------------------------------------------------ */

/**
 * Map the free-text `bestuurslaag` parameter to an index prefix. Anything else
 * is reported back instead of being glued onto the query, which is what used to
 * happen ("parkeren gemeente") and only added noise.
 */
export function parseBestuurslaag(value: string | undefined): { layer?: OriLayer; unrecognised?: string } {
  const raw = value?.trim();
  if (!raw) return {};
  const v = raw.toLowerCase();
  if (/^(gemeente|gemeenten|gemeentelijk|gemeenteraad|municipality|municipalities|ori|ori_)$/.test(v)) return { layer: "gemeente" };
  if (/^(provincie|provincies|provinciaal|provinciale staten|province|provinces|osi|osi_)$/.test(v)) return { layer: "provincie" };
  if (/^(waterschap|waterschappen|hoogheemraadschap|hoogheemraadschappen|wetterskip|water ?board|water ?boards|owi|owi_)$/.test(v)) return { layer: "waterschap" };
  return { unrecognised: raw };
}

function parenthesesBalanced(query: string): boolean {
  let depth = 0;
  for (const c of query.replace(/\\[()]/g, "")) {
    if (c === "(") depth += 1;
    else if (c === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * The query goes to Elasticsearch as a query_string (the same Lucene syntax as
 * the old URI `q=`), now with default_operator AND. query_string is kept over
 * simple_query_string because it drops a stopword per field: ORI analyses
 * titles with the Dutch analyzer, so "en" in "Uitvoerings- en beleidskader"
 * exists in the text but not in the title, and simple_query_string then
 * rejected every agenda item matched on its title.
 *
 * What it keeps: "phrases", trailing `*`, uppercase AND/OR/NOT, `-term`,
 * balanced parentheses. What it neutralises, because each made the whole
 * search an HTTP 400 or silently searched a non-existent field: `/` (regex),
 * `:` (field), `\ [ ] { } ^ ~ ! < > = ?`, an odd number of quotes, unbalanced
 * parentheses, lone `+`/`-` and an operator with nothing on one side.
 */
export function toQueryStringSyntax(query: string): string {
  let q = query.trim();
  if ((q.match(/"/g) ?? []).length % 2 === 1) q = q.replace(/"/g, " ");
  q = q.replace(/[\\/:[\]{}^~!<>=?]/g, (c) => `\\${c}`);
  if (!parenthesesBalanced(q)) q = q.replace(/[()]/g, (c) => `\\${c}`);
  q = q
    .replace(/(^|\s)[-+](?=\s|$)/g, "$1")
    .replace(/(^|\s)(AND|OR|NOT|&&|\|\|)(?=\s*$)/g, "$1")
    .replace(/^\s*(AND|OR|&&|\|\|)\s+/, "");
  return q.replace(/\s+/g, " ").trim();
}

/**
 * True when the caller wrote search syntax: uppercase AND/OR/NOT, && or ||,
 * quotes, `*`, parentheses, or a `+`/`-` in front of a word. The tool's query
 * rewriter lowercases and strips symbols, which turned "OV OR fietsen" into
 * the three required words "ov or fietsen"; such a query is passed on as typed.
 */
export function hasOriQuerySyntax(query: string): boolean {
  return /(^|\s)(AND|OR|NOT)(?=\s|$)|&&|\|\||["*()]|(^|\s)[+-](?=[\p{L}\p{N}"(])/u.test(query);
}

const OPERATOR_WORDS: Record<string, string> = { or: "OR", and: "AND", not: "NOT" };

/**
 * "ov or fietsen": with every word required, a lowercase operator word is a
 * required term of its own ("or"), which narrows an OR query to junk and turns
 * NOT around. Between two terms and outside a quoted phrase, "or", "and" and
 * "not" (any case) are therefore read as the operator. None of them is a Dutch
 * word; elsewhere they stay words.
 */
export function operatorWordsToSyntax(query: string): { query: string; changed: boolean } {
  const parts = query.split(/(\s+)/);
  const isTerm = (p: string | undefined) => Boolean(p && p.trim() && !/^(AND|OR|NOT|&&|\|\|)$/.test(p));
  let inPhrase = false;
  let changed = false;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part.trim()) continue;
    const word = part.toLowerCase();
    if (!inPhrase && OPERATOR_WORDS[word] && part !== OPERATOR_WORDS[word] && isTerm(parts[i - 2]) && isTerm(parts[i + 2])) {
      parts[i] = OPERATOR_WORDS[word];
      changed = true;
    }
    if ((part.match(/"/g) ?? []).length % 2 === 1) inPhrase = !inPhrase;
  }
  return { query: parts.join(""), changed };
}

function rangeBound(value: string): string {
  return value === "now" ? "now/d" : `${value}||/d`;
}

/**
 * Date window on the record's own date: the meeting date for documents, agenda
 * items and meetings, and `start_date` for Reports (which have no meeting date).
 * Day bounds are whole days in Dutch time. The explicit format is needed
 * because `start_date` is mapped as strict_date_time, which rejects a bare
 * "2026-07-08" with an HTTP 400 for the whole search.
 */
function dateRangeClause(from?: string, to?: string): Record<string, unknown> | undefined {
  if (!from && !to) return undefined;
  const range = {
    ...(from ? { gte: rangeBound(from) } : {}),
    ...(to ? { lte: rangeBound(to) } : {}),
    format: "strict_date_optional_time",
    time_zone: "Europe/Amsterdam",
  };
  return {
    bool: {
      should: [
        { range: { last_discussed_at: range } },
        { bool: { must_not: [{ exists: { field: "last_discussed_at" } }], filter: [{ range: { start_date: range } }] } },
      ],
      minimum_should_match: 1,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Records                                                            */
/* ------------------------------------------------------------------ */

/**
 * Entities decoded, whitespace collapsed — but no tag stripping: escaping "<"
 * first keeps a literal "<concept>" in a title, while htmlToText still turns
 * "Auditcomit&eacute;" into "Auditcomité" and "B&amp;W" into "B&W".
 */
function decodeTitle(value: string): string {
  return htmlToText(value.replace(/</g, "&lt;"));
}

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function idList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(str).filter(Boolean);
  const one = str(value);
  return one ? [one] : [];
}

/**
 * Snippet from the highlighter: the passage around the matched terms, or the
 * opening of the text when only the title matched (no_match_size). Document
 * text is extracted PDF text, so a literal "<" is kept; descriptions can hold
 * HTML and get tags stripped.
 */
function snippetFromHighlight(hit: ElasticHit): string {
  const fromText = hit.highlight?.text;
  const text = fromText?.length
    ? decodeTitle(fromText.join(" … "))
    : htmlToText((hit.highlight?.description ?? []).join(" … "));
  return text.length > 500 ? `${text.slice(0, 497)}…` : text;
}

/**
 * Whether ORI's resolver answers this resolve URL with HTTP 404: every link of
 * the hosts in RESOLVE_BROKEN_HOSTS, and every link whose path holds an empty
 * segment ("//"), which the resolver cannot look up — Dronten's records up to
 * July 2025 ("gemeenteraad.dronten.nl/api//v1/meetings/…", 7,747 documents).
 */
function resolveIsBroken(url: string): boolean {
  if (!url.startsWith(RESOLVE_PREFIX)) return false;
  const rest = url.slice(RESOLVE_PREFIX.length);
  return RESOLVE_BROKEN_HOSTS.has(rest.split("/")[0]) || rest.includes("//");
}

/**
 * The link to use for a document: ORI's resolve URL, except where that resolver
 * answers 404 (see resolveIsBroken) — there the source system's own URL.
 */
export function documentLink(url: string, originalUrl: string): { url: string; viaOriginal: boolean } {
  if (originalUrl && resolveIsBroken(url)) {
    const host = url.slice(RESOLVE_PREFIX.length).split("/")[0];
    // Both hosts serve https; Hardinxveld-Giessendam's stored http:// only redirects there.
    return { url: RESOLVE_BROKEN_HOSTS.has(host) ? originalUrl.replace(/^http:\/\//, "https://") : originalUrl, viaOriginal: true };
  }
  return { url: url || originalUrl, viaOriginal: false };
}

/** link_note of a document linked to its source system because ORI's resolve link is dead. */
const VIA_ORIGINAL_NOTE = "ORI's resolve-link geeft voor dit document HTTP 404; de link gaat rechtstreeks naar het bronsysteem (original_url).";

/** A document's links as kept on an attachment: its link, plus the source system's own link as fallback. */
interface AttachmentLink {
  id: string;
  name: string;
  url: string;
  original_url?: string;
}

/** date_type of a document dated by an iBabs report list rather than by a meeting. */
export const LIST_DATE_TYPE = "lijstdatum (iBabs-rapportlijst)";

export function toOriItem(hit: ElasticHit, catalogue: OriCatalogue | undefined, now = Date.now()): OriItem {
  const source = hit._source ?? {};
  const index = hit._index ?? "";
  const entry = catalogue?.byIndex.get(index);
  const prefix = prefixOf(index);
  const id = str(source["@id"]) || str(hit._id);
  const type = str(source["@type"]) || "record";
  const title = decodeTitle(str(source.name) || str(source.title) || str(source.file_name)) || "ORI item";

  const meetingDate = str(source.last_discussed_at);
  const reportDate = meetingDate ? "" : str(source.start_date);
  const date = meetingDate || reportDate;
  // A document from an iBabs report list carries the list's date in
  // last_discussed_at: a deadline, an event or a receipt date at midnight, not
  // a meeting ("Uitnodiging VNG congres" dated the day of the congress).
  const listDate = Boolean(meetingDate) && str(source.url).startsWith(IBABS_REPORT_PREFIX);
  const dateWord = listDate ? "lijstdatum" : meetingDate ? "vergaderdatum" : "datum";

  const originalUrl = str(source.original_url);
  const link = documentLink(str(source.url), originalUrl);
  const documentUrl = link.url;
  // Records from an unaliased copy (see buildOriCatalogue) only exist under its own name.
  const recordIndex = entry && !entry.copies.includes(index) ? entry.index : index;
  const recordUrl = id && recordIndex ? `${ORI_BASE}/${recordIndex}/_doc/${encodeURIComponent(str(hit._id) || id)}` : "";

  const description = htmlToText(str(source.description));
  const snippet = snippetFromHighlight(hit);
  const label = TYPE_LABELS[type] ?? type;
  const linkFields: Record<string, string> = !documentUrl
    ? { link_note: `Geen openbare webpagina voor dit ${label.toLowerCase()} in ORI; de link is het ORI-bronrecord (JSON).` }
    : link.viaOriginal
      ? { ori_resolve_url: str(source.url), link_note: VIA_ORIGINAL_NOTE }
      : originalUrl && originalUrl !== documentUrl ? { original_url: originalUrl } : {};
  const classification = idList(source.classification).join(", ");

  return {
    id,
    title,
    type,
    organization: entry?.name ?? (prefix ? displayName(prefix, index.slice(prefix.length).replace(/_\d{8,}$/, "")) : ""),
    bestuurslaag: prefix ? PREFIX_LAYER[prefix] : "",
    index: recordIndex,
    publishedAt: date,
    date_type: listDate ? LIST_DATE_TYPE : meetingDate ? "vergaderdatum" : reportDate ? "documentdatum" : "",
    date_field: meetingDate ? "last_discussed_at" : reportDate ? "start_date" : "",
    ...(date && Date.parse(date) > now ? { future_date: true } : {}),
    ...(str(source.date_modified) ? { date_modified: str(source.date_modified) } : {}),
    url: documentUrl || recordUrl,
    link_type: documentUrl ? "document" : "ori_record",
    ...linkFields,
    ...(str(source.content_type) ? { content_type: str(source.content_type) } : {}),
    ...(typeof source.size_in_bytes === "number" ? { size_in_bytes: source.size_in_bytes } : {}),
    ...(classification ? { classification } : {}),
    ...(description || snippet ? { description: (description || snippet).slice(0, 500) } : {}),
    snippet: snippet || description.slice(0, 300) || `${label}${date ? ` — ${dateWord} ${date.slice(0, 10)}` : ""}`,
    ...(idList(source.attachment).length ? { attachment_ids: idList(source.attachment) } : {}),
  };
}

function titleKey(title: string): string {
  return placeKey(title.replace(/\.(pdf|docx?|xlsx?|pptx?)$/i, ""));
}

/** notubiz exposes versions of one file as /document/<id>/<version>. */
function sourceUrlKey(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/(\/document\/\d+)\/\d+$/, "$1").toLowerCase();
}

/**
 * The organisation a record belongs to, for de-duplication: its index without
 * the timestamp, so the two copies of a re-ingested body share it.
 */
function orgScope(item: OriItem): string {
  return str(item.index).replace(/_\d{8,}$/, "") || str(item.organization);
}

/**
 * One source document often comes back several times within one organisation:
 * attached to several meetings (same file, other notubiz id), once as a Report
 * and once as that Report's PDF, or from both copies of a re-ingested index.
 * Records are merged on the same id, or — within one organisation — the same
 * source URL, the same file name and byte size, or (for agenda items and
 * meetings found in two copies of one index) the same type, title and day. The
 * first (best-ranked) record stays, the rest are listed on it.
 *
 * Never across organisations: a VNG letter that ten councils received is ten
 * councils that had it on their agenda, which is what a national search is for.
 */
export function dedupeOriItems(items: OriItem[]): { items: OriItem[]; merged: number } {
  const kept: OriItem[] = [];
  const byKey = new Map<string, OriItem>();
  let merged = 0;

  for (const item of items) {
    const scope = orgScope(item);
    // ORI ids are one sequence across all indices, so an id needs no scope.
    const keys = [`id:${item.id}`];
    const original = str(item.original_url) || (item.link_type === "document" ? str(item.url) : "");
    if (item.type === "MediaObject") {
      if (original) keys.push(`src:${scope}|${sourceUrlKey(original)}`);
      if (str(item.url)) keys.push(`src:${scope}|${sourceUrlKey(str(item.url))}`);
      if (typeof item.size_in_bytes === "number" && item.title) keys.push(`file:${scope}|${titleKey(item.title)}|${item.size_in_bytes}`);
    }
    const attachments = Array.isArray(item.attachment_ids) ? (item.attachment_ids as string[]) : [];
    if (item.type === "Report" && attachments.length === 1) keys.push(`id:${attachments[0]}`);
    // Two copies of one index hold the same agenda items under other ids, and
    // one copy stored the meeting time an hour off — so: same day, other copy.
    const day = str(item.publishedAt).slice(0, 10);
    const copyKey = item.type !== "MediaObject" && day ? `copy:${scope}|${item.type}|${titleKey(str(item.title))}|${day}` : undefined;

    let target = keys.map((k) => byKey.get(k)).find(Boolean);
    if (!target && copyKey) {
      const twin = byKey.get(copyKey);
      if (twin && str(twin.index) !== str(item.index)) target = twin;
    }
    if (!target) {
      kept.push(item);
      for (const k of keys) byKey.set(k, item);
      if (copyKey && !byKey.has(copyKey)) byKey.set(copyKey, item);
      continue;
    }

    merged += 1;
    target.duplicate_ids = [...((target.duplicate_ids as string[] | undefined) ?? []), str(item.id)];
    const dates = new Set((target.also_discussed_at as string[] | undefined) ?? []);
    const days = new Set([str(target.publishedAt).slice(0, 10), ...[...dates].map((d) => d.slice(0, 10))]);
    if (item.publishedAt && !days.has(day)) dates.add(item.publishedAt);
    if (dates.size) target.also_discussed_at = [...dates].sort().reverse();
    // A Report kept ahead of its own PDF takes over the PDF's link, fallback included.
    if (target.link_type !== "document" && item.link_type === "document") {
      target.url = item.url;
      target.link_type = "document";
      delete target.link_note;
      for (const k of ["original_url", "ori_resolve_url", "link_note"]) if (item[k]) target[k] = item[k];
    }
    for (const k of keys) if (!byKey.has(k)) byKey.set(k, target);
  }
  return { items: kept, merged };
}

/* ------------------------------------------------------------------ */
/*  Source                                                             */
/* ------------------------------------------------------------------ */

export interface OriSearchArgs {
  query: string;
  rows: number;
  sort?: "relevance" | "date_newest";
  bestuurslaag?: string;
  gemeente?: string;
  /** YYYY-MM-DD, inclusive. */
  date_from?: string;
  /** YYYY-MM-DD, inclusive. */
  date_to?: string;
  /** "all" (default): every term must occur. "any": at least one. */
  match?: "all" | "any";
}

export interface OriSearchResult {
  items: OriItem[];
  /** Exact total, or null when ORI only gives a lower bound (see total_lower_bound). */
  total: number | null;
  /** Set when ORI stopped counting ("10000+"). */
  total_lower_bound?: number;
  /** Organisation the search was scoped to, for the summary. */
  scope_label?: string;
  /** True when the name did not resolve to any ORI index — nothing was searched. */
  no_index?: boolean;
  endpoint: string;
  params: Record<string, string>;
  access_note?: string;
}

/** Hint for an ORI request that failed, so the error says what to change. */
export function oriFailureHint(error: unknown): string | undefined {
  if (!(error instanceof SourceRequestError)) return undefined;
  if (error.code === "timeout") {
    return "ORI reageerde niet binnen 20 seconden. Dit is een storing of overbelasting bij ORI, geen leeg resultaat: probeer het opnieuw, verlaag 'rows' of beperk met 'gemeente' of 'date_from'.";
  }
  if (error.code === "malformed_response" && /exceeded/i.test(error.message)) {
    return "Het ORI-antwoord was groter dan 12 MB. Dit is geen leeg resultaat: verlaag 'rows' of beperk met 'gemeente' of 'date_from'.";
  }
  if (error.code === "http_error" && error.status === 400) {
    return "ORI weigerde de zoekopdracht (HTTP 400). Vereenvoudig de zoekterm.";
  }
  return "De ORI-zoekopdracht is mislukt; dit is geen leeg resultaat. Probeer het later opnieuw.";
}

function formatDateNl(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Amsterdam" });
}

function listNames(entries: OriIndexEntry[], max = 8): string {
  const names = entries.slice(0, max).map((e) => e.name);
  return entries.length > max ? `${names.join(", ")} en ${entries.length - max} meer` : names.join(", ");
}

export class OriSource {
  private catalogue?: { value: OriCatalogue; expiresAt: number };
  private catalogueLoad?: Promise<OriCatalogue | undefined>;
  private catalogueRetryAt = 0;
  private catalogueLoadStartedAt = 0;

  constructor(private readonly config: AppConfig) {}

  /** hasOriQuerySyntax, reachable for the tool layer through the class. */
  static hasQuerySyntax(query: string): boolean {
    return hasOriQuerySyntax(query);
  }

  async search(args: OriSearchArgs): Promise<OriSearchResult> {
    const notes: string[] = [];
    const query = args.query.trim();
    const match = args.match ?? "all";
    const wantDateSort = args.sort === "date_newest";
    const gemeente = args.gemeente?.trim();

    if (args.date_from && args.date_to && args.date_from > args.date_to) {
      return {
        items: [],
        total: 0,
        endpoint: ORI_SEARCH,
        params: { q: query, date_from: args.date_from, date_to: args.date_to },
        access_note: `date_from (${args.date_from}) ligt na date_to (${args.date_to}); er is niet gezocht.`,
      };
    }

    const { layer, unrecognised } = parseBestuurslaag(args.bestuurslaag);
    if (unrecognised) {
      notes.push(`bestuurslaag '${unrecognised}' is niet toegepast: ORI kent alleen 'gemeente', 'provincie' en 'waterschap'.`);
    }

    // Only a gemeente needs the index list before searching; otherwise it is
    // only used to name the organisation of each hit, loads alongside, and is
    // never waited on for long (see catalogueForNaming).
    const cataloguePromise = this.loadCatalogue();
    const catalogue = gemeente ? await cataloguePromise : undefined;

    // --- scope ------------------------------------------------------
    let path: string;
    let pathQuery: Record<string, string> | undefined;
    let scopeLabel: string | undefined;
    let appliedLayer = layer;
    if (gemeente) {
      // A named index that disappeared since the list was cached gives an empty
      // shard set (reported below) instead of an HTTP 404.
      pathQuery = { ignore_unavailable: "true", allow_no_indices: "true" };
      if (catalogue) {
        const scope = resolveOriScope(catalogue, gemeente, layer);
        appliedLayer = scope.layer;
        if (!scope.entry) {
          const layerText = scope.layer ? `${scope.layer} ` : "";
          const otherLayer = scope.alternatives.length
            ? ` Wel gevonden in een andere bestuurslaag: ${listNames(scope.alternatives)}.`
            : "";
          const similar = scope.suggestions.length ? ` Vergelijkbare namen in ORI: ${listNames(scope.suggestions)}.` : "";
          return {
            items: [],
            total: null,
            no_index: true,
            scope_label: gemeente,
            endpoint: `${ORI_BASE}/_aliases`,
            params: { q: query, gemeente, ...(scope.layer ? { bestuurslaag: scope.layer } : {}) },
            access_note: [
              ...notes,
              `ORI heeft geen index voor ${layerText}'${gemeente}', dus er is niet gezocht. Niet elke gemeente, provincie of waterschap levert aan Open Raadsinformatie; dit zegt niets over wat de organisatie zelf publiceert.${otherLayer}${similar}`,
            ].join(" "),
          };
        }
        path = `${ORI_BASE}/${[scope.entry.index, ...scope.entry.copies].join(",")}/_search`;
        scopeLabel = scope.entry.name;
        appliedLayer = scope.entry.layer;
        if (scope.alternatives.length && !scope.layer) {
          const searchedAs = scope.entry.layer === "gemeente" ? `gemeente ${scope.entry.name}` : scope.entry.name;
          notes.push(`'${gemeente}' is gezocht als ${searchedAs}; ORI heeft ook ${listNames(scope.alternatives)} (kies die met bestuurslaag).`);
        }
        if (scope.related.length) {
          notes.push(`ORI heeft aparte indexen voor ${listNames(scope.related)}; die zijn niet meegezocht.`);
        }
        if (scope.entry.copies.length) {
          notes.push(
            `ORI heeft voor ${scope.entry.name} naast ${scope.entry.index} een oudere index zonder alias (${scope.entry.copies.join(", ")}) met records die de nieuwe mist; beide zijn doorzocht. Records die in beide staan zijn samengevoegd, maar het totaal kan ze dubbel tellen.`,
          );
        }
      } else {
        const fallback = await this.fallbackScope(gemeente, layer, pathQuery, notes);
        path = `${ORI_BASE}/${fallback.indices.join(",")}/_search`;
        scopeLabel = fallback.label;
        appliedLayer = fallback.layer;
      }
    } else if (layer) {
      path = `${ORI_BASE}/${LAYER_PREFIX[layer]}*/_search`;
      scopeLabel = `alle ${layer === "gemeente" ? "gemeenten" : layer === "provincie" ? "provincies" : "waterschappen"}`;
    } else {
      path = ORI_SEARCH;
    }

    // --- request ----------------------------------------------------
    const effectiveTo = args.date_to ?? (wantDateSort ? "now" : undefined);
    const dateClause = dateRangeClause(args.date_from, effectiveTo);
    const operatorWords = operatorWordsToSyntax(query);
    if (operatorWords.changed) {
      notes.push("'or', 'and' en 'not' tussen zoektermen zijn gelezen als de operatoren OR, AND en NOT.");
    }
    // A query that was only operators ("AND") is searched as the plain word.
    const luceneQuery = toQueryStringSyntax(operatorWords.query) || toQueryStringSyntax(query.toLowerCase());
    const operator = match === "any" ? "OR" : "AND";
    const textClause = (kind: "query_string" | "simple_query_string"): Record<string, unknown> => {
      if (!query) return { match_all: {} };
      return kind === "query_string"
        ? { query_string: { query: luceneQuery, default_operator: operator } }
        : { simple_query_string: { query, default_operator: operator } };
    };
    // Over-fetch so de-duplication can still fill the page.
    const fetchSize = Math.min(Math.max(args.rows * 2, args.rows + 5), args.rows + 50);
    const buildBody = (kind: "query_string" | "simple_query_string"): Record<string, unknown> => {
      const filtered = { bool: { must: [textClause(kind)], ...(dateClause ? { filter: [dateClause] } : {}) } };
      return {
        size: fetchSize,
        timeout: SERVER_TIMEOUT,
        _source: SOURCE_FIELDS,
        // Newest first by meeting date. Documents of an iBabs report list carry
        // the list's date instead (deadlines, event dates), which would crowd
        // out real meetings; scoring every record 2 and those 1, with _score
        // leading the sort, puts them after the records with a meeting date.
        query: wantDateSort
          ? {
              function_score: {
                query: filtered,
                functions: [{ filter: { bool: { must_not: [{ prefix: { url: IBABS_REPORT_PREFIX } }] } }, weight: 2 }],
                score_mode: "sum",
                boost_mode: "replace",
              },
            }
          : filtered,
        ...(wantDateSort
          ? {
              sort: [
                { _score: { order: "desc" } },
                { last_discussed_at: { order: "desc", unmapped_type: "date" } },
                { start_date: { order: "desc", unmapped_type: "date" } },
              ],
            }
          : {}),
        highlight: {
          pre_tags: [""],
          post_tags: [""],
          fields: {
            text: { fragment_size: 220, number_of_fragments: 2, no_match_size: 220 },
            description: { fragment_size: 220, number_of_fragments: 1, no_match_size: 220 },
          },
        },
      };
    };

    const params: Record<string, string> = {
      q: luceneQuery || query,
      size: String(args.rows),
      match,
      sort: wantDateSort ? "last_discussed_at:desc" : "_score:desc",
      ...(args.date_from ? { date_from: args.date_from } : {}),
      ...(args.date_to ? { date_to: args.date_to } : wantDateSort ? { date_to: "vandaag" } : {}),
      ...(gemeente ? { gemeente } : {}),
      ...(appliedLayer ? { bestuurslaag: appliedLayer } : {}),
    };

    const runSearch = async () => {
      const options = { connector: CONNECTOR, timeoutMs: SEARCH_TIMEOUT_MS, retries: 1, query: pathQuery };
      try {
        return await postJson<ElasticResponse>(path, buildBody("query_string"), options);
      } catch (error) {
        // The sanitiser cannot catch every malformed operator sequence ("NOT NOT
        // x"); simple_query_string never rejects syntax, so retry once with it.
        if (!(error instanceof SourceRequestError) || error.status !== 400 || !query) throw error;
        const out = await postJson<ElasticResponse>(path, buildBody("simple_query_string"), options);
        notes.push("ORI weigerde de zoeksyntax; er is gezocht als eenvoudige zoekterm (simple_query_string).");
        return out;
      }
    };

    // Freshness runs alongside and may fail without affecting the search.
    const [searchOutcome, freshnessOutcome] = await Promise.allSettled([runSearch(), this.newestMeeting(path, pathQuery)]);
    if (searchOutcome.status === "rejected") throw searchOutcome.reason;
    const { data, meta } = searchOutcome.value;

    const shards = data._shards ?? {};
    if (gemeente && (shards.total ?? 0) === 0) {
      return {
        items: [],
        total: null,
        no_index: true,
        scope_label: scopeLabel ?? gemeente,
        endpoint: meta.url,
        params,
        access_note: [...notes, `ORI heeft geen (bereikbare) index voor '${gemeente}', dus er is niet gezocht.`].join(" "),
      };
    }
    if ((shards.failed ?? 0) > 0) {
      notes.push(`${shards.failed} van ${shards.total} ORI-indexen gaven een fout; de resultaten zijn onvolledig.`);
    }
    if (data.timed_out) {
      notes.push(`ORI brak de zoekopdracht na ${SERVER_TIMEOUT} af; de resultaten zijn onvolledig. Verlaag 'rows' of beperk de zoekopdracht.`);
    }

    // --- records ----------------------------------------------------
    const hits: ElasticHit[] = Array.isArray(data.hits?.hits) ? (data.hits?.hits as ElasticHit[]) : [];
    const namingCatalogue = catalogue ?? (await this.catalogueForNaming(cataloguePromise));
    const mapped = hits.map((hit) => toOriItem(hit, namingCatalogue)).filter((x) => x.id || x.title);
    const deduped = dedupeOriItems(mapped);
    const items = deduped.items.slice(0, args.rows);
    await this.attachAttachments(items, path, pathQuery, notes);

    const { total, lowerBound } = describeTotal(data);

    if (lowerBound !== undefined) {
      const tips = ["specifiekere termen"];
      if (match === "any") tips.push("match='all'");
      if (!gemeente) tips.push("'gemeente'");
      if (!args.date_from && !args.date_to) tips.push("'date_from'/'date_to'");
      notes.push(`ORI telt niet verder dan ${lowerBound} treffers; het werkelijke aantal ligt hoger. Verfijn met ${tips.join(", ")}.`);
    }
    if (deduped.merged > 0) {
      notes.push(`${deduped.merged} dubbele record(s) van hetzelfde brondocument zijn samengevoegd (zie duplicate_ids en also_discussed_at).`);
    }
    if (wantDateSort) {
      notes.push(
        `Gesorteerd op vergaderdatum (last_discussed_at: de laatste vergadering waarin het stuk is besproken), niet op publicatiedatum; rapporten zonder vergaderdatum en daarna stukken uit iBabs-rapportlijsten (date_type '${LIST_DATE_TYPE}': een deadline, evenement- of lijstdatum, geen vergadering) staan achteraan.${args.date_to ? "" : " Stukken met een datum na vandaag (geplande vergaderingen, foutieve datums) zijn weggelaten; geef date_to op om ze mee te nemen."}`,
      );
    } else if (items.some((x) => x.date_type === LIST_DATE_TYPE)) {
      notes.push(`date_type '${LIST_DATE_TYPE}': de datum komt uit een iBabs-rapportlijst (bijv. een deadline of evenementdatum) en is geen vergaderdatum.`);
    }
    if (items.some((x) => x.future_date)) {
      notes.push("Records met future_date hebben een datum na vandaag (geplande vergadering of foutieve datum).");
    }
    if (dateClause && !wantDateSort) {
      notes.push("Het datumfilter werkt op de vergaderdatum (last_discussed_at; voor rapporten start_date), niet op de publicatiedatum.");
    }
    if (!items.length) {
      const hints: string[] = [];
      if (match === "all" && query.split(/\s+/).length > 1) hints.push("match='any' (een van de termen)");
      if (args.date_from || args.date_to) hints.push("een ruimer datumbereik");
      notes.push(`Geen ORI-resultaten voor '${query}'${scopeLabel ? ` in ${scopeLabel}` : ""}${hints.length ? `; probeer ${hints.join(" of ")}` : ""}.`);
    }
    if (freshnessOutcome.status === "fulfilled" && freshnessOutcome.value) {
      const newest = freshnessOutcome.value;
      const days = Math.floor((Date.now() - Date.parse(newest)) / 86_400_000);
      if (days > STALE_AFTER_DAYS) {
        notes.push(
          `Let op: de nieuwste vergadering in ORI${scopeLabel ? ` voor ${scopeLabel}` : ""} is van ${formatDateNl(newest)} (${days} dagen geleden). ORI loopt achter; recentere stukken ontbreken waarschijnlijk in deze bron, ook als ze wel bestaan.`,
        );
      }
    }

    return {
      items,
      total,
      ...(lowerBound !== undefined ? { total_lower_bound: lowerBound } : {}),
      ...(scopeLabel ? { scope_label: scopeLabel } : {}),
      endpoint: meta.url,
      params,
      ...(notes.length ? { access_note: notes.join(" ") } : {}),
    };
  }

  /**
   * Live list of ORI indices plus their organisation names, cached for a day.
   * Returns undefined when the list cannot be loaded; the caller then falls
   * back to index names tried by spelling and slug-derived organisation names.
   * Both requests normally take well under a second; one short attempt keeps a
   * hung index list from holding up a gemeente search for long.
   */
  private async loadCatalogue(): Promise<OriCatalogue | undefined> {
    const now = Date.now();
    if (this.catalogue && this.catalogue.expiresAt > now) return this.catalogue.value;
    if (now < this.catalogueRetryAt) return this.catalogue?.value;
    if (!this.catalogueLoad) {
      this.catalogueLoadStartedAt = now;
      this.catalogueLoad = (async () => {
        const [aliases, orgs] = await Promise.allSettled([
          getJson<AliasesResponse>(`${ORI_BASE}/_aliases`, {
            connector: CONNECTOR,
            timeoutMs: CATALOGUE_TIMEOUT_MS,
            retries: 0,
            cacheTtlMs: CATALOGUE_TTL_MS,
          }),
          postJson<ElasticResponse>(
            ORI_SEARCH,
            {
              size: 1000,
              _source: ["name", "classification"],
              query: {
                bool: {
                  filter: [
                    { term: { "@type": "Organization" } },
                    { terms: { "classification.keyword": ["Municipality", "Province", "Water board"] } },
                  ],
                },
              },
            },
            { connector: CONNECTOR, timeoutMs: CATALOGUE_TIMEOUT_MS, retries: 0, cacheTtlMs: CATALOGUE_TTL_MS },
          ),
        ]);
        // A failed refresh keeps serving the previous list rather than none.
        if (aliases.status === "rejected") {
          this.catalogueRetryAt = Date.now() + CATALOGUE_RETRY_MS;
          return this.catalogue?.value;
        }
        const orgHits: ElasticHit[] =
          orgs.status === "fulfilled" && Array.isArray(orgs.value.data.hits?.hits) ? (orgs.value.data.hits?.hits as ElasticHit[]) : [];
        const value = buildOriCatalogue(aliases.value.data, orgHits);
        if (!value.entries.length) {
          this.catalogueRetryAt = Date.now() + CATALOGUE_RETRY_MS;
          return this.catalogue?.value;
        }
        // Without names the catalogue still matches on slugs; retry the names sooner.
        this.catalogue = { value, expiresAt: Date.now() + (orgHits.length ? CATALOGUE_TTL_MS : CATALOGUE_RETRY_MS) };
        return value;
      })().finally(() => {
        this.catalogueLoad = undefined;
      });
    }
    // A list past its day keeps serving while the refresh runs; only the very
    // first load is waited for.
    return this.catalogue ? this.catalogue.value : this.catalogueLoad;
  }

  /**
   * The index list for naming the hits of a search without gemeente: the
   * cached one (even if a refresh is due), or a load in progress if it finishes
   * within CATALOGUE_GRACE_MS of its start. Otherwise the hits keep
   * slug-derived names rather than the search waiting for a slow index list.
   */
  private async catalogueForNaming(load: Promise<OriCatalogue | undefined>): Promise<OriCatalogue | undefined> {
    if (this.catalogue) return this.catalogue.value;
    const wait = Math.max(0, CATALOGUE_GRACE_MS - (Date.now() - this.catalogueLoadStartedAt));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), wait);
    });
    try {
      return await Promise.race([load.catch(() => undefined), grace]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Scope for a gemeente when the index list is unavailable. The layer comes
   * from bestuurslaag or a type word ("Provincie Utrecht" searches provinces
   * only, as with the list). A bare name follows the same gemeente-first rule:
   * ORI is asked which spellings exist in which layer, and the first layer
   * that has one is searched.
   */
  private async fallbackScope(
    gemeente: string,
    layer: OriLayer | undefined,
    pathQuery: Record<string, string> | undefined,
    notes: string[],
  ): Promise<{ indices: string[]; label: string; layer: OriLayer }> {
    notes.push("De ORI-indexlijst kon niet worden geladen; de index is op naam geprobeerd (exacte schrijfwijze).");
    const typeWord = TYPE_WORD_RE.exec(gemeente)?.[1];
    const implied = layer ?? (typeWord ? layerOfTypeWord(typeWord.split(/\s+/)[0]) : undefined);
    if (implied) return { indices: fallbackIndexPatterns(gemeente, implied), label: gemeente, layer: implied };

    const present = await this.existingIndices(LAYER_ORDER.flatMap((l) => fallbackIndexPatterns(gemeente, l)), pathQuery);
    if (!present) {
      notes.push("Alleen gemeente-indexen zijn geprobeerd; geef bestuurslaag op voor een provincie of waterschap.");
      return { indices: fallbackIndexPatterns(gemeente, "gemeente"), label: gemeente, layer: "gemeente" };
    }
    const chosen = LAYER_ORDER.find((l) => present.some((c) => c.startsWith(LAYER_PREFIX[l]))) ?? "gemeente";
    const inLayer = present.filter((c) => c.startsWith(LAYER_PREFIX[chosen]));
    const others = present.filter((c) => !c.startsWith(LAYER_PREFIX[chosen]));
    if (others.length) {
      notes.push(`'${gemeente}' is gezocht als ${chosen}; ORI heeft ook ${others.map(concreteName).join(", ")} (kies die met bestuurslaag).`);
    }
    if (!inLayer.length) return { indices: fallbackIndexPatterns(gemeente, "gemeente"), label: gemeente, layer: "gemeente" };
    const label = chosen === "provincie" ? `Provincie ${gemeente}` : chosen === "waterschap" ? `Waterschap ${gemeente}` : gemeente;
    return { indices: inLayer, label, layer: chosen };
  }

  /** Concrete indices that exist (and hold records) among these names and patterns; undefined when ORI cannot say. */
  private async existingIndices(patterns: string[], pathQuery: Record<string, string> | undefined): Promise<string[] | undefined> {
    try {
      const { data } = await postJson<ElasticResponse>(
        `${ORI_BASE}/${patterns.join(",")}/_search`,
        { size: 0, aggs: { indices: { terms: { field: "_index", size: 50 } } } },
        { connector: CONNECTOR, timeoutMs: 10_000, retries: 0, query: pathQuery },
      );
      return (data.aggregations?.indices?.buckets ?? []).map((b) => str(b.key)).filter(Boolean);
    } catch {
      return undefined;
    }
  }

  /**
   * Newest meeting date (up to today) in the searched indices. Meetings and
   * agenda items are used rather than documents: a handful of documents carry
   * dates months ahead, while meeting dates stop where ORI stopped ingesting.
   * Cached by the HTTP layer per scope, so repeated searches cost nothing.
   */
  private async newestMeeting(path: string, pathQuery?: Record<string, string>): Promise<string | undefined> {
    try {
      const { data } = await postJson<ElasticResponse>(
        path,
        {
          size: 0,
          query: {
            bool: {
              filter: [
                { terms: { "@type": ["Meeting", "AgendaItem"] } },
                { range: { last_discussed_at: { lte: "now" } } },
              ],
            },
          },
          aggs: { newest: { max: { field: "last_discussed_at" } } },
        },
        { connector: CONNECTOR, timeoutMs: 10_000, retries: 0, query: pathQuery },
      );
      const value = data.aggregations?.newest?.value;
      return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Agenda items, meetings and reports have no file of their own; their
   * documents are separate MediaObjects. One lookup fetches the links of the
   * attachments on this page, so a Report links to its PDF and an agenda item
   * lists its documents. A failed lookup leaves the ORI-record links in place.
   */
  private async attachAttachments(
    items: OriItem[],
    path: string,
    pathQuery: Record<string, string> | undefined,
    notes: string[],
  ): Promise<void> {
    const ids = [...new Set(items.flatMap((x) => (Array.isArray(x.attachment_ids) ? (x.attachment_ids as string[]).slice(0, MAX_ATTACHMENTS_PER_RECORD) : [])))].slice(0, MAX_ATTACHMENT_LOOKUP);
    if (!ids.length) return;
    let docs: Map<string, Omit<AttachmentLink, "id">>;
    try {
      const { data } = await postJson<ElasticResponse>(
        path,
        { size: ids.length, _source: ["name", "file_name", "url", "original_url"], query: { ids: { values: ids } } },
        { connector: CONNECTOR, timeoutMs: 10_000, retries: 0, query: pathQuery },
      );
      docs = new Map();
      for (const hit of data.hits?.hits ?? []) {
        const s = hit._source ?? {};
        const original = str(s.original_url);
        const { url, viaOriginal } = documentLink(str(s.url), original);
        // As on a document: the source system's own link travels along as fallback.
        const fallback = !viaOriginal && original && original !== url ? { original_url: original } : {};
        if (hit._id && url) docs.set(hit._id, { name: decodeTitle(str(s.name) || str(s.file_name)), url, ...fallback });
      }
    } catch {
      notes.push("De bijlagen van agendapunten en rapporten konden niet worden opgehaald; die records linken naar hun ORI-bronrecord.");
      return;
    }
    for (const item of items) {
      const attached = (Array.isArray(item.attachment_ids) ? (item.attachment_ids as string[]) : [])
        .slice(0, MAX_ATTACHMENTS_PER_RECORD)
        .map((id) => ({ id, ...docs.get(id) }))
        .filter((a): a is AttachmentLink => Boolean(a.url));
      if (!attached.length) continue;
      item.attachments = attached;
      // A Report is a wrapper around its document, so its document is its link.
      if (item.type === "Report" && item.link_type !== "document") {
        item.url = attached[0].url;
        item.link_type = "document";
        item.link_note = "Link naar het document dat bij dit ORI-rapport hoort.";
        if (attached[0].original_url) item.original_url = attached[0].original_url;
      }
    }
  }
}

/**
 * Elasticsearch caps its hit counter: `{"value":10000,"relation":"gte"}` means
 * "at least 10000". That floor is returned as a lower bound, never as the total.
 */
function describeTotal(data: ElasticResponse): { total: number | null; lowerBound?: number } {
  const raw = data.hits?.total;
  if (typeof raw === "number") return { total: raw };
  const value = Number(raw?.value);
  if (!Number.isFinite(value)) return { total: null };
  if (raw?.relation === "gte") return { total: null, lowerBound: value };
  return { total: value };
}
