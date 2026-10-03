import type { AppConfig } from "../types.js";
import { getHttpCache, makeHttpCacheKey, setHttpCache } from "../utils/connector-runtime.js";
import { getJson } from "../utils/http.js";

// Register van Overheidsorganisaties (ROO/TOOI) — keyless JSON API.
// De lijst-endpoint levert een platte array van { label, type, uri } zonder
// server-side naam-filter of paginering, dus we halen de volledige lijst op en
// filteren client-side op naam. Optioneel verrijken we de teruggegeven treffers
// met contact + bezoekadres via de dedicated sub-endpoints.
const BASE = "https://api-organisaties.overheid.nl/v1";
const LIST_ENDPOINT = `${BASE}/overheidsorganisaties`;
const CONNECTOR = "overheidsorganisaties";

// The list endpoint only carries the preferred name. Abbreviations ("UWV"), the
// official name when it differs ("'s-Gravenhage" for gemeente Den Haag) and the
// end date of dissolved organisations live in the same register, but only on the
// per-organisation detail records. The TOOI SPARQL endpoint (KOOP, keyless)
// serves exactly those register fields for all organisations in one small query,
// so one cached call replaces ~1,450 detail calls. It runs under its own
// connector name so a TOOI outage cannot open the circuit for the register itself.
const TOOI_SPARQL = "https://standaarden.overheid.nl/tooi/sparql";
const TOOI_CONNECTOR = "tooi_sparql";
const TOOI_META_CACHE_TTL_MS = 60 * 60 * 1000;
// TOOI usually answers in well under 0.5 s. A search waits for it at most this
// long after the (shared) TOOI request started; the request itself runs on and
// fills the cache for later calls. Only active_only, which cannot work without
// the end dates, waits for the full request.
const TOOI_META_WAIT_MS = 2_500;
const TOOI_META_TIMEOUT_MS = 8_000;
const TOOI_META_SPARQL = `PREFIX tooiont: <https://identifier.overheid.nl/tooi/def/ont/>
SELECT ?org ?afk ?off ?offIncl ?end WHERE {
  { ?org tooiont:afkorting ?afk }
  UNION
  { ?org tooiont:officieleNaamExclSoort ?off ;
         tooiont:voorkeursnaamExclSoort ?pref .
    FILTER(STR(?off) != STR(?pref))
    OPTIONAL { ?org tooiont:officieleNaamInclSoort ?offIncl } }
  UNION
  { ?org tooiont:einddatum ?end }
}`;
/** Key of the parsed TOOI metadata in the shared HTTP cache (see loadMeta). */
const TOOI_META_CACHE_KEY = makeHttpCacheKey({
  connector: TOOI_CONNECTOR,
  method: "PARSED",
  url: TOOI_SPARQL,
  body: TOOI_META_SPARQL,
});

// Human-readable pages for an organisation. A TOOI URI resolves (via content
// negotiation) to the TOOI item page; organisaties.overheid.nl shows the register's
// contact page but needs the internal systeemId, which only /identificatie returns.
// Any slug after the systeemId works, so the label is used for readability.
const TOOI_ITEM_PAGE = "https://standaarden.overheid.nl/tooi/waardelijsten/item?id=";
const ROO_PAGE = "https://organisaties.overheid.nl/";

// Bovengrens voor verrijking: elke treffer kost 2-3 extra requests (contact +
// adressen, soms identificatie). Alleen de eerste ENRICH_CAP treffers van de
// getoonde pagina worden verrijkt, om de fair-use (100 req/s) te respecteren.
const ENRICH_CAP = 15;

/**
 * Generic names the register does not carry as abbreviations. Each group lists
 * spellings that mean the same thing; a query containing one is also matched
 * with the others, but only at the start of a word ("Fryslân" must not find
 * "Westfriesland"). Kept deliberately small: register data comes first.
 */
const NAME_ALIASES: string[][] = [
  // Most GGD regions are registered under their full name ("Gemeentelijke
  // Gezondheidsdienst ...", "Gemeenschappelijke ...", "Geneeskundige ..."), two
  // under the body that runs them: "Dienst Gezondheid & Jeugd Zuid-Holland Zuid"
  // and "Veiligheids- en Gezondheidsregio Gelderland-Midden" (VGGM).
  ["GGD", "Gezondheidsdienst", "Dienst Gezondheid", "Gezondheidsregio"],
  ["Den Bosch", "'s-Hertogenbosch"],
  ["Friesland", "Fryslân"],
];

/** Type words in front of a name; "Den Haag" should rank "gemeente Den Haag" as exact. */
const SOORT_PREFIX = /^(?:gemeente|provincie|ministerie van|waterschap|openbaar lichaam) /;

export interface OverheidsorganisatieItem {
  id: string;
  title: string;
  /** The https website; the register page when there is none, enrichment was skipped or the organisation is dissolved. */
  url: string;
  organisatietype: string;
  type_uri: string;
  tooi_uri: string;
  /** Website from the register, normalised to https; "" when unknown or not enriched. */
  website: string;
  telefoon: string;
  bezoekadres: string;
  /** Abbreviation(s) from the register, comma-separated; "" when none or unknown. */
  afkorting: string;
  /** End date from the register; "" when the organisation has none or TOOI was unreachable. */
  einddatum: string;
  /** True when einddatum lies in the past; null when TOOI was unreachable. */
  opgeheven: boolean | null;
  /** organisaties.overheid.nl page when known, otherwise the TOOI item page. */
  register_url: string;
  /** Which name matched the query: naam, afkorting, officiele_naam or losse_woorden ("" when browsing). */
  matched_on: string;
}

export interface OverheidsorganisatiesSearchArgs {
  query?: string;
  rows: number;
  type?: string;
  enrich?: boolean;
  activeOnly?: boolean;
  /** The page the caller will show (offset/limit within `rows`); only its first ENRICH_CAP hits are enriched. */
  page?: { offset: number; limit: number };
}

export interface OverheidsorganisatiesOptions {
  /** How long a search waits for the TOOI metadata (ms after the TOOI request started); tests shorten it. */
  metaWaitMs?: number;
}

interface ContactResponse {
  internetadressen?: unknown;
  telefoonnummers?: unknown;
}

interface OrgMeta {
  afkortingen: string[];
  officieleNamen: string[];
  einddatum: string;
}

type MetaOutcome = { ok: true; value: Map<string, OrgMeta> } | { ok: false; error: unknown };

type MatchKind = "naam" | "afkorting" | "officiele_naam" | "losse_woorden";

interface NameVariant {
  kind: Exclude<MatchKind, "losse_woorden">;
  spaced: string;
  joined: string;
}

function asOrgList(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === "object") {
    const items = (data as Record<string, unknown>).items;
    if (Array.isArray(items)) return items as Array<Record<string, unknown>>;
  }
  return [];
}

// Leidt een leesbaar organisatietype af uit de TOOI-ontologie-URI, bv.
// ".../tooi/def/ont/Gemeente" -> "Gemeente".
function shortType(typeUri: string): string {
  if (!typeUri) return "";
  const seg = typeUri.split("/").filter(Boolean).pop() ?? "";
  return seg;
}

function firstStringField(v: unknown, field: string): string {
  if (!Array.isArray(v)) return "";
  for (const entry of v) {
    if (entry && typeof entry === "object") {
      const val = (entry as Record<string, unknown>)[field];
      if (typeof val === "string" && val.trim()) return val;
    }
  }
  return "";
}

/**
 * Turn a register website into a usable https URL. The register stores some sites
 * without a scheme ("www.defensie.nl") and a few with http://; Dutch government
 * websites must serve HTTPS (with HSTS) since 2023, so both become https://.
 * Anything that is not a plain http(s) host is dropped.
 */
export function normalizeWebsite(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s || /[\s<>"{}|\\^`]/.test(s)) return "";
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s);
  if (hasScheme && !/^https?:\/\//i.test(s)) return "";
  // Keep the register's spelling apart from the scheme ("https://www.x.nl" stays as is).
  const candidate = hasScheme ? s.replace(/^https?:\/\//i, "https://") : `https://${s.replace(/^\/+/, "")}`;
  try {
    const u = new URL(candidate);
    if (!u.hostname.includes(".") || u.username || u.password) return "";
    return candidate;
  } catch {
    return "";
  }
}

function firstWebsite(v: unknown): string {
  if (!Array.isArray(v)) return "";
  for (const entry of v) {
    if (entry && typeof entry === "object") {
      const url = normalizeWebsite(String((entry as Record<string, unknown>).url ?? ""));
      if (url) return url;
    }
  }
  return "";
}

function formatBezoekadres(data: unknown): string {
  if (!Array.isArray(data)) return "";
  const entries = data.filter(
    (e): e is Record<string, unknown> => !!e && typeof e === "object",
  );
  const visit =
    entries.find((e) => String(e.adresType ?? "").toLowerCase() === "bezoekadres") ??
    entries[0];
  if (!visit) return "";
  const straat = `${String(visit.openbareRuimte ?? "")} ${String(
    visit.huisnummer ?? "",
  )}`.trim();
  const postbus = String(visit.postbus ?? "").trim();
  const line1 = straat || (postbus ? `Postbus ${postbus}` : "");
  const plaats = `${String(visit.postcode ?? "")} ${String(
    visit.woonplaats ?? "",
  )}`.trim();
  return [line1, plaats].filter(Boolean).join(", ");
}

const APOSTROPHES = /['’‘`´]/g;
const HYPHENS = /[-‐‑‒–—]/g;

function baseFold(s: string): string {
  return String(s ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(APOSTROPHES, "");
}

/**
 * Fold a name for matching: lowercase, accents stripped ("Fryslân" → "fryslan"),
 * apostrophes dropped and every other non-alphanumeric run turned into one space
 * ("'s-Gravenhage" → "s gravenhage", "Hunze en Aa's" → "hunze en aas").
 */
export function foldName(s: string): string {
  return baseFold(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Like foldName, but hyphenated parts are joined ("Noord-Holland" → "noordholland",
 * "'s-Gravenhage" → "sgravenhage"). Only hyphens are joined: removing every space
 * would let "UWV" match "LandboUW, Visserij".
 */
function foldJoined(s: string): string {
  return baseFold(s).replace(HYPHENS, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

interface Folded {
  spaced: string;
  joined: string;
}

function fold(s: string): Folded {
  return { spaced: foldName(s), joined: foldJoined(s) };
}

interface QueryVariant extends Folded {
  /** Display form of the alias that produced this variant; null for the query itself. */
  alias: string | null;
}

/** The folded query plus the spellings from NAME_ALIASES it contains. */
function queryVariants(query: string): QueryVariant[] {
  const own = fold(query);
  const out: QueryVariant[] = [{ ...own, alias: null }];
  const padded = ` ${own.spaced} `;
  for (const group of NAME_ALIASES) {
    for (const member of group) {
      const m = foldName(member);
      if (!padded.includes(` ${m} `)) continue;
      for (const other of group) {
        if (other === member) continue;
        const replaced = padded.replace(` ${m} `, ` ${foldName(other)} `).trim();
        if (out.some((v) => v.spaced === replaced)) continue;
        // The variant is already folded; foldJoined of it equals it except for hyphens, which are gone.
        out.push({ spaced: replaced, joined: foldJoined(replaced), alias: `${member} = ${other}` });
      }
    }
  }
  return out;
}

/**
 * 0 = the whole name (also without a type word like "gemeente"), 1 = starts at a
 * word, 2 = inside a word. Alias variants only count at the start of a word.
 */
function phraseScore(name: Folded, v: QueryVariant): number | null {
  if (!v.spaced) return null;
  const pairs: Array<[string, string]> = [
    [name.spaced, v.spaced],
    [name.joined, v.joined],
  ];
  if (pairs.some(([n, q]) => q && (n === q || n.replace(SOORT_PREFIX, "") === q))) return 0;
  if (pairs.some(([n, q]) => q && (n.startsWith(q) || n.includes(` ${q}`)))) return 1;
  if (v.alias) return null;
  return pairs.some(([n, q]) => q && n.includes(q)) ? 2 : null;
}

/** The promise's value when it settles within `ms` (already settled counts), else null. */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function tooiItemPage(uri: string): string {
  return `${TOOI_ITEM_PAGE}${encodeURIComponent(uri)}`;
}

function rooPage(systeemId: string, label: string): string {
  const slug =
    label
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "organisatie";
  return `${ROO_PAGE}${encodeURIComponent(systeemId)}/${slug}`;
}

interface SparqlJson {
  results?: { bindings?: Array<Record<string, { value?: string } | undefined>> };
}

function parseMeta(data: SparqlJson): Map<string, OrgMeta> {
  const bindings = data?.results?.bindings;
  if (!Array.isArray(bindings)) {
    throw new Error("TOOI SPARQL gaf een onverwacht antwoord (geen results.bindings).");
  }
  // The register holds hundreds of abbreviations and end dates; an empty answer
  // is an upstream fault and must not turn every organisation into "not dissolved".
  if (bindings.length === 0) {
    throw new Error("TOOI SPARQL gaf geen afkortingen of einddata terug.");
  }
  const meta = new Map<string, OrgMeta>();
  const add = (list: string[], v: string | undefined) => {
    const s = v?.trim();
    if (s && !list.includes(s)) list.push(s);
  };
  for (const row of bindings) {
    const org = row.org?.value;
    if (!org) continue;
    let m = meta.get(org);
    if (!m) {
      m = { afkortingen: [], officieleNamen: [], einddatum: "" };
      meta.set(org, m);
    }
    add(m.afkortingen, row.afk?.value);
    add(m.officieleNamen, row.off?.value);
    add(m.officieleNamen, row.offIncl?.value);
    const end = row.end?.value?.slice(0, 10);
    if (end && /^\d{4}-\d{2}-\d{2}$/.test(end) && (!m.einddatum || end > m.einddatum)) m.einddatum = end;
  }
  return meta;
}

interface Candidate {
  org: Record<string, unknown>;
  meta?: OrgMeta;
  opgeheven: boolean | null;
  score: number;
  matchedOn: MatchKind | "";
  /** True when only a NAME_ALIASES spelling matched, not the query itself. */
  viaAlias: boolean;
}

function toBaseItem(c: Pick<Candidate, "org" | "meta" | "opgeheven" | "matchedOn">): OverheidsorganisatieItem {
  const o = c.org;
  const uri = String(o.uri ?? "");
  const label = String(o.label ?? "");
  const typeUri = String(o.type ?? "");
  const registerUrl = uri ? tooiItemPage(uri) : LIST_ENDPOINT;
  return {
    id: uri,
    title: label || uri || "Overheidsorganisatie",
    url: registerUrl,
    organisatietype: shortType(typeUri),
    type_uri: typeUri,
    tooi_uri: uri,
    website: "",
    telefoon: "",
    bezoekadres: "",
    afkorting: c.meta?.afkortingen.join(", ") ?? "",
    einddatum: c.meta?.einddatum ?? "",
    opgeheven: c.opgeheven,
    register_url: registerUrl,
    matched_on: c.matchedOn,
  };
}

export class OverheidsorganisatiesSource {
  private readonly metaWaitMs: number;
  /** The TOOI request in progress, shared by concurrent searches, and when it started. */
  private metaInFlight?: { outcome: Promise<MetaOutcome>; startedAt: number };

  constructor(
    private readonly config: AppConfig,
    options: OverheidsorganisatiesOptions = {},
  ) {
    this.metaWaitMs = options.metaWaitMs ?? TOOI_META_WAIT_MS;
  }

  /**
   * Abbreviations, differing official names and end dates per TOOI URI. Only a
   * parsed, non-empty answer is cached: the HTTP cache would also keep a 200 reply
   * that is a maintenance page or has no rows, and serve it for an hour after TOOI
   * has recovered.
   */
  private async loadMeta(): Promise<Map<string, OrgMeta>> {
    const cached = getHttpCache<Map<string, OrgMeta>>(TOOI_META_CACHE_KEY);
    if (cached) return cached.value;
    const { data } = await getJson<SparqlJson>(TOOI_SPARQL, {
      query: { query: TOOI_META_SPARQL },
      headers: { Accept: "application/sparql-results+json" },
      connector: TOOI_CONNECTOR,
      timeoutMs: TOOI_META_TIMEOUT_MS,
      // Optional data: a failed call is retried by the next search.
      retries: 0,
      disableCache: true,
    });
    const meta = parseMeta(data);
    setHttpCache(TOOI_META_CACHE_KEY, meta, TOOI_META_CACHE_TTL_MS, TOOI_CONNECTOR);
    return meta;
  }

  /** Start the TOOI request, or join the one in progress. The outcome never rejects. */
  private metaRequest(): { outcome: Promise<MetaOutcome>; startedAt: number } {
    if (!this.metaInFlight) {
      const request = {
        outcome: this.loadMeta().then(
          (value): MetaOutcome => ({ ok: true, value }),
          (error: unknown): MetaOutcome => ({ ok: false, error }),
        ),
        startedAt: Date.now(),
      };
      this.metaInFlight = request;
      void request.outcome.then(() => {
        if (this.metaInFlight === request) this.metaInFlight = undefined;
      });
    }
    return this.metaInFlight;
  }

  private async enrichItem(c: Candidate): Promise<OverheidsorganisatieItem> {
    const base = toBaseItem(c);
    const uri = base.tooi_uri;
    if (!uri) return base;
    const enc = encodeURIComponent(uri);

    let website = "";
    let telefoon = "";
    let bezoekadres = "";
    let registerUrl = base.register_url;

    let linkWebsite = "";
    // Contact (+ identificatie when needed) and adressen run side by side, so the
    // extra identificatie call does not lengthen enrichment when upstream is slow.
    const contactPart = (async () => {
      try {
        const { data } = await getJson<ContactResponse>(
          `${BASE}/overheidsorganisaties/${enc}/contact`,
          { connector: CONNECTOR, timeoutMs: 15_000 },
        );
        website = firstWebsite(data.internetadressen);
        telefoon = firstStringField(data.telefoonnummers, "nummer");
      } catch {
        // Verrijking is best-effort; ontbrekend contact mag de zoekopdracht niet breken.
      }

      // Without a website the register's own contact page is the most useful link.
      // A dissolved organisation's listed website is often dead or redirects to a
      // successor ("www.uden.nl" no longer resolves), so it links to the register
      // too. Only then is the extra /identificatie call (for the systeemId) worth it.
      linkWebsite = c.opgeheven === true ? "" : website;
      if (linkWebsite) return;
      try {
        const { data } = await getJson<Record<string, unknown>>(
          `${BASE}/overheidsorganisaties/${enc}/identificatie`,
          { connector: CONNECTOR, timeoutMs: 15_000 },
        );
        const systeemId = String(data?.systeemId ?? "").trim();
        if (/^\d+$/.test(systeemId)) registerUrl = rooPage(systeemId, base.title);
      } catch {
        // idem: blijft de TOOI-pagina.
      }
    })();

    const adressenPart = (async () => {
      try {
        const { data } = await getJson<unknown>(
          `${BASE}/overheidsorganisaties/${enc}/adressen`,
          { connector: CONNECTOR, timeoutMs: 15_000 },
        );
        bezoekadres = formatBezoekadres(data);
      } catch {
        // idem: adressen best-effort.
      }
    })();

    await Promise.all([contactPart, adressenPart]);

    return {
      ...base,
      url: linkWebsite || registerUrl,
      website,
      telefoon,
      bezoekadres,
      register_url: registerUrl,
    };
  }

  async search(args: OverheidsorganisatiesSearchArgs): Promise<{
    items: OverheidsorganisatieItem[];
    total: number;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const query = String(args.query ?? "").trim();
    const listQuery: Record<string, string> = {};
    if (args.type) listQuery.type = args.type;

    // Only the register list may fail the call; TOOI metadata is best-effort and
    // may not hold up a search (unless active_only). The wait counts from the start
    // of the shared TOOI request, so a search that joins a request which is already
    // late does not wait again.
    const metaPending = this.metaRequest();
    const { data, meta } = await getJson<unknown>(LIST_ENDPOINT, {
      query: listQuery,
      connector: CONNECTOR,
      timeoutMs: 20_000,
    });
    const metaResult: MetaOutcome | null = args.activeOnly
      ? await metaPending.outcome
      : await settleWithin(metaPending.outcome, metaPending.startedAt + this.metaWaitMs - Date.now());
    const orgMeta = metaResult?.ok ? metaResult.value : undefined;
    if (args.activeOnly && !orgMeta) {
      const reason = !metaResult || metaResult.ok ? "" : metaResult.error instanceof Error ? metaResult.error.message : String(metaResult.error);
      throw new Error(
        `active_only kan niet worden toegepast: de einddata uit TOOI (standaarden.overheid.nl) zijn niet bereikbaar${reason ? ` (${reason.slice(0, 200)})` : ""}. Probeer het later opnieuw of zoek zonder active_only.`,
      );
    }

    const today = todayIso();
    const all: Candidate[] = asOrgList(data).map((org) => {
      const m = orgMeta?.get(String(org.uri ?? ""));
      return {
        org,
        meta: m,
        opgeheven: orgMeta ? Boolean(m?.einddatum && m.einddatum < today) : null,
        score: 0,
        matchedOn: "",
        viaAlias: false,
      };
    });
    const pool = args.activeOnly ? all.filter((c) => c.opgeheven === false) : all;

    const notes: string[] = [];
    const folded = foldName(query);
    let matched: Candidate[];
    if (!query) {
      matched = pool;
    } else if (!folded) {
      // Only punctuation ("&", "("): folding leaves nothing, so match the characters as written.
      const raw = query.toLowerCase();
      matched = pool
        .filter((c) => String(c.org.label ?? "").toLowerCase().includes(raw))
        .map((c) => ({ ...c, score: 2, matchedOn: "naam" as const }));
    } else {
      const variants = queryVariants(query);
      const namesOf = (c: Candidate): NameVariant[] => [
        { kind: "naam", ...fold(String(c.org.label ?? "")) },
        ...(c.meta?.afkortingen ?? []).map((a) => ({ kind: "afkorting" as const, ...fold(a) })),
        ...(c.meta?.officieleNamen ?? []).map((n) => ({ kind: "officiele_naam" as const, ...fold(n) })),
      ];

      const usedAliases = new Set<string>();
      matched = [];
      for (const c of pool) {
        let best: { score: number; kind: MatchKind; alias: string | null } | null = null;
        for (const name of namesOf(c)) {
          if (!name.spaced) continue;
          for (const v of variants) {
            const score = phraseScore(name, v);
            if (score === null) continue;
            // On a tie the query itself beats an alias, so the alias note only
            // appears when an alias found something the query did not.
            if (!best || score < best.score || (score === best.score && best.alias !== null && v.alias === null)) {
              best = { score, kind: name.kind, alias: v.alias };
            }
          }
        }
        if (best) {
          if (best.alias) usedAliases.add(best.alias);
          matched.push({ ...c, score: best.score, matchedOn: best.kind, viaAlias: best.alias !== null });
        }
      }

      // No organisation carries the query as one phrase: fall back to names that
      // contain every query word at the start of a word ("GGD Utrecht" →
      // "Gemeentelijke Gezondheidsdienst Regio Utrecht"). Single words gain nothing
      // here, and words of one or two letters would match almost anything.
      if (!matched.length) {
        const wordSets = variants
          .map((v) => ({ words: v.spaced.split(" ").filter((w) => w.length >= 2), alias: v.alias }))
          .filter((v) => v.words.length >= 2 && v.words.some((w) => w.length >= 3));
        if (wordSets.length) {
          for (const c of pool) {
            const words = namesOf(c).flatMap((n) => [...n.spaced.split(" "), ...n.joined.split(" ")]);
            const hit = wordSets.find((set) => set.words.every((q) => words.some((w) => w.startsWith(q))));
            if (hit) {
              if (hit.alias) usedAliases.add(hit.alias);
              matched.push({ ...c, score: 3, matchedOn: "losse_woorden", viaAlias: hit.alias !== null });
            }
          }
          if (matched.length) {
            notes.push(
              `Geen organisatie draagt '${query}' als geheel in naam of afkorting; getoond zijn organisaties waarvan de namen alle zoekwoorden bevatten.`,
            );
          }
        }
      }

      // Best name match first; on a tie the register name exactly as typed ("Duo+")
      // before a folded or abbreviation match ("DUO"), then names that hold the
      // query itself before names only an alias found ("Gezondheidsregio" lists
      // VGGM before the GGD regions), then current organisations before dissolved
      // ones. Array sort is stable, so ties keep the register order.
      const typed = query.normalize("NFC").toLowerCase().replace(/\s+/g, " ");
      const notAsTyped = (c: Candidate) =>
        Number(String(c.org.label ?? "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim() !== typed);
      matched.sort(
        (a, b) =>
          a.score - b.score ||
          notAsTyped(a) - notAsTyped(b) ||
          Number(a.viaAlias) - Number(b.viaAlias) ||
          Number(a.opgeheven === true) - Number(b.opgeheven === true),
      );
      if (usedAliases.size) {
        notes.push(`Zoekterm ook gezocht onder synoniem: ${[...usedAliases].join("; ")}.`);
      }
    }

    const total = matched.length;
    const sliced = matched.slice(0, args.rows);

    // Enrich the best-ranked hits of the page the caller shows, at most ENRICH_CAP;
    // hits outside the page are dropped by the caller and need no calls.
    const wantsEnrich = args.enrich !== false;
    const pageStart = Math.max(0, Math.min(args.page?.offset ?? 0, sliced.length));
    const pageEnd = Math.min(sliced.length, pageStart + Math.max(0, args.page?.limit ?? sliced.length));
    const enrichEnd = wantsEnrich ? Math.min(pageEnd, pageStart + ENRICH_CAP) : pageStart;
    const items = await Promise.all(
      sliced.map((c, i) => (i >= pageStart && i < enrichEnd ? this.enrichItem(c) : toBaseItem(c))),
    );
    const notEnriched = pageEnd - enrichEnd;

    const params: Record<string, string> = {
      query,
      ...(args.type ? { type: args.type } : {}),
      enrich: String(wantsEnrich),
      ...(args.activeOnly ? { active_only: "true" } : {}),
    };

    if (wantsEnrich && notEnriched > 0) {
      notes.push(
        `Verrijking (website, telefoon, adres) alleen voor de eerste ${ENRICH_CAP} treffers van deze pagina; ` +
          `${notEnriched} ${notEnriched === 1 ? "treffer is" : "treffers zijn"} niet verrijkt (url = registerpagina). ` +
          "Verfijn de zoekterm of blader met offset/limit voor hun contactgegevens.",
      );
    }
    if (!metaResult) {
      notes.push(
        `Afkortingen, officiële namen en einddata uit TOOI (standaarden.overheid.nl) waren niet bereikbaar (geen antwoord binnen ${(this.metaWaitMs / 1000).toLocaleString("nl-NL")} s): er is alleen op de registernaam gezocht en 'opgeheven' is onbekend (null).`,
      );
    } else if (!metaResult.ok) {
      notes.push(
        "Afkortingen, officiële namen en einddata uit TOOI (standaarden.overheid.nl) waren niet bereikbaar: er is alleen op de registernaam gezocht en 'opgeheven' is onbekend (null).",
      );
    } else if (!args.activeOnly) {
      const dissolved = matched.filter((c) => c.opgeheven === true).length;
      if (dissolved) {
        notes.push(
          `${dissolved} van de ${total} treffers ${dissolved === 1 ? "is" : "zijn"} opgeheven (einddatum in het verleden, veld 'opgeheven'); gebruik active_only=true voor alleen bestaande organisaties.`,
        );
      }
    }
    if (!items.length) {
      notes.push(
        query
          ? !folded
            ? `Zoekterm '${query}' bevat geen letters of cijfers.`
            : `Geen overheidsorganisatie gevonden voor '${query}'. Controleer de schrijfwijze of laat 'query' leeg om de volledige lijst te bladeren.`
          : all.length
            ? "Geen bestaande (niet-opgeheven) organisaties in deze selectie."
            : "Geen overheidsorganisaties ontvangen van het register.",
      );
    }

    return {
      items,
      total,
      endpoint: meta.url,
      params,
      access_note: notes.length ? notes.join(" ") : undefined,
    };
  }
}
