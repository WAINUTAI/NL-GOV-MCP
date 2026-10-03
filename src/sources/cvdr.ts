import type { AppConfig } from "../types.js";
import { getText } from "../utils/http.js";
import { placeKey, placeVariants } from "../utils/place-aliases.js";
import {
  extractSruNumberOfRecords,
  extractSruRecords,
  parseXml,
} from "../utils/xml-parser.js";

/** SRU endpoint (KOOP zoekservice) that serves the CVDR local-regulations collection. */
const CVDR_SRU_ENDPOINT = "https://zoekservice.overheid.nl/sru/Search";
const CVDR_CONNECTION = "cvdr";

/**
 * Values of the CVDR `organisatieType` SRU index. Together they cover the whole
 * collection (verified live: their counts add up to the database total), so every
 * regulation has exactly one of these issuer types.
 */
export const CVDR_ORGANIZATION_TYPES = [
  "Gemeente",
  "Provincie",
  "Waterschap",
  "RegionaalSamenwerkingsorgaan",
  "Deelgemeente",
  "CaribischOpenbaarLichaam",
  "Koninkrijksdeel",
  "NederlandseAntillen",
] as const;

export type CvdrOrganizationType = (typeof CVDR_ORGANIZATION_TYPES)[number];

/** Read a scalar text value from a fast-xml-parser node (string, number, or { "#text": ... }). */
function toStringValue(value: unknown): string | undefined {
  // An element can repeat (e.g. two dcterms:type); the first one is the primary value.
  if (Array.isArray(value)) return toStringValue(value[0]);
  let text: string | undefined;
  if (typeof value === "string") text = value;
  else if (typeof value === "number") text = String(value);
  else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["#text"] === "string") text = obj["#text"];
    else if (typeof obj["#text"] === "number") text = String(obj["#text"]);
  }
  // Empty elements such as <dcterms:issued/> parse to "": treat them as absent so the
  // date fallback chain moves on instead of returning an empty date.
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

/** Read an attribute from a fast-xml-parser node (attributes carry no prefix in parseXml). */
function attributeValue(value: unknown, name: string): string | undefined {
  const node = Array.isArray(value) ? value[0] : value;
  if (!node || typeof node !== "object") return undefined;
  const attr = (node as Record<string, unknown>)[name];
  return typeof attr === "string" && attr.trim() ? attr.trim() : undefined;
}

/** Escape a value for use inside double-quoted CQL/SRU strings. */
function escapeSruValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** CQL boolean keywords: as a bare term they would be parsed as operators. */
const CQL_RESERVED = new Set(["and", "or", "not", "prox", "sortby"]);

/**
 * Render one search word as a CQL term: bare when that is unambiguous, quoted
 * otherwise. Quoting is not enough for the uppercase words AND, OR and NOT: KOOP's
 * backend still reads them as operators inside quotes and fails with SRU
 * diagnostic 1/1 "General system error" (verified live: keyword="OR" fails,
 * keyword="or" finds 6064). The index is case-insensitive, so they are lowercased.
 */
function cqlTerm(word: string): string {
  const plain = word === "*" || /^[\p{L}\p{N}][\p{L}\p{N}*-]*$/u.test(word);
  if (plain && !CQL_RESERVED.has(word.toLowerCase())) return word;
  const safe = CQL_RESERVED.has(word.toLowerCase()) ? word.toLowerCase() : word;
  return `"${escapeSruValue(safe)}"`;
}

type QueryOperator = "AND" | "OR" | "NOT";

/** A standalone uppercase AND/OR/NOT in the query is a boolean operator, as in most search boxes. */
function queryOperator(word: string): QueryOperator | undefined {
  return word === "AND" || word === "OR" || word === "NOT" ? word : undefined;
}

/**
 * The CVDR `keyword` index has no phrase search: a quoted multi-word value is
 * matched as "all of these words, anywhere in the regulation" (verified live:
 * keyword="Amsterdam parkeren", keyword="parkeren Amsterdam" and
 * keyword=Amsterdam AND keyword=parkeren all return the same 2691 records).
 * Spelling that AND out per word keeps those results while making the
 * semantics visible in the provenance. Double quotes are dropped because a
 * phrase cannot be expressed anyway.
 *
 * Uppercase AND, OR and NOT between words are applied as CQL operators
 * ("parkeren OR fietsen", "subsidie NOT sport"); other words are ANDed. AND binds
 * tighter than OR, as in most search boxes: "a b OR c" is (a AND b) OR c. CQL
 * itself gives all booleans equal precedence, so OR groups get parentheses.
 */
function keywordClause(query: string): string | undefined {
  const words = query
    .split(/\s+/)
    .map((w) => w.replace(/"/g, ""))
    .filter(Boolean);
  if (!words.length) return undefined;
  // A query made of operator words only ("OR") is a search for those words.
  if (words.every((w) => queryOperator(w))) {
    return words.map((w) => `keyword=${cqlTerm(w)}`).join(" AND ");
  }

  // Each OR group is a list of terms, each joined to the previous one by AND or NOT.
  const groups: Array<Array<{ op: "AND" | "NOT"; term: string }>> = [[]];
  let pending: QueryOperator | undefined;
  for (const word of words) {
    const op = queryOperator(word);
    if (op) {
      // "AND NOT" means NOT; otherwise the last of several operators counts.
      pending = op === "AND" && pending === "NOT" ? "NOT" : op;
      continue;
    }
    const term = `keyword=${cqlTerm(word)}`;
    let group = groups[groups.length - 1];
    if (pending === "OR" && group.length) {
      group = [];
      groups.push(group);
    }
    // A leading NOT has nothing to subtract from: start from all regulations.
    if (pending === "NOT" && !group.length) group.push({ op: "AND", term: "keyword=*" });
    group.push({ op: pending === "NOT" ? "NOT" : "AND", term });
    pending = undefined;
  }

  const filled = groups.filter((g) => g.length);
  const render = (g: (typeof groups)[number]) =>
    g.map((t, i) => (i === 0 ? t.term : `${t.op} ${t.term}`)).join(" ");
  if (filled.length === 1) return render(filled[0]);
  return filled.map((g) => (g.length > 1 ? `(${render(g)})` : render(g))).join(" OR ");
}

/**
 * Split an organisation argument into the issuer name and an implied issuer type.
 * CVDR stores the bare name ("Harderwijk", "Utrecht"), so "Gemeente Harderwijk"
 * would match nothing on the creator index; the prefix becomes a type filter.
 * Water authorities keep their prefix: it is part of their stored name
 * ("Waterschap Rivierenland").
 */
function splitOrganization(raw: string): { name: string; impliedType?: CvdrOrganizationType } {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  const match = /^(gemeente|provincie)\s+(.+)$/i.exec(trimmed);
  if (!match) return { name: trimmed };
  const impliedType: CvdrOrganizationType = match[1].toLowerCase() === "gemeente" ? "Gemeente" : "Provincie";
  return { name: match[2], impliedType };
}

/**
 * CQL for the issuing organisation, on the dcterms `creator` index. That index
 * matches whole words, case-insensitively, and a multi-word value as adjacent
 * words ("Gooise Meren", "Hunze en Aa's"); wildcards are not supported. Names
 * whose official spelling differs from the everyday one ("Den Haag" is stored as
 * "'s-Gravenhage") are OR-ed with their aliases.
 *
 * Punctuation matters on this index: a hyphenated compound is one token and an
 * inner apostrophe is kept (verified live: creator="Bergen op Zoom" 897 vs
 * "Bergen-op-Zoom" 0, "Noord-Holland" 1604 vs "Noord Holland" 0, "Hunze en Aa's"
 * 120 vs "Hunze en Aas" 0). So every distinct spelling is OR-ed, including the
 * hyphenated form of a spaced name, and only exact (case-insensitive) duplicates
 * are dropped. A spelling that does not occur simply adds no hits.
 */
function organizationClause(name: string): string | undefined {
  // Only names with a letter or digit can match anything.
  if (!placeKey(name)) return undefined;
  const seen = new Set<string>();
  const names: string[] = [];
  const add = (variant: string) => {
    const cleaned = variant.replace(/\s+/g, " ").trim();
    const key = cleaned.toLowerCase();
    if (!placeKey(cleaned) || seen.has(key)) return;
    seen.add(key);
    names.push(cleaned);
  };
  const variants = placeVariants(name);
  for (const variant of variants) add(variant);
  // placeVariants turns hyphens into spaces but not back: "Noord Holland" is stored
  // as "Noord-Holland".
  for (const variant of variants) if (/\s/.test(variant)) add(variant.replace(/\s+/g, "-"));
  if (!names.length) return undefined;
  const parts = names.map((n) => `creator="${escapeSruValue(n)}"`);
  return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

/**
 * Build the CQL query for CVDR. The CVDR SRU index does not support the default
 * cql.serverChoice; free-text search runs against the 'keyword' index.
 */
function buildCql(args: {
  query: string;
  organization?: string;
  organizationType?: CvdrOrganizationType;
}): string {
  const clauses: string[] = [];
  const keyword = keywordClause(args.query.trim());
  if (args.organization) {
    const org = organizationClause(args.organization);
    if (org) clauses.push(org);
  }
  if (args.organizationType) clauses.push(`organisatieType=${args.organizationType}`);
  if (keyword) {
    // Keep a keyword OR/NOT from reaching across the issuer filters. Search words
    // contain no spaces, so " OR "/" NOT " can only be operators.
    const wrap = clauses.length > 0 && / (?:OR|NOT) /.test(keyword);
    clauses.unshift(wrap ? `(${keyword})` : keyword);
  }
  return clauses.length ? clauses.join(" AND ") : "keyword=*";
}

/**
 * Turn a CVDR identifier (e.g. "CVDR357364_1") into its canonical
 * lokaleregelgeving.overheid.nl URL (e.g. .../CVDR357364/1).
 */
function cvdrCanonicalUrl(identifier: string): string {
  const [base, version] = identifier.split("_");
  return version
    ? `https://lokaleregelgeving.overheid.nl/${base}/${version}`
    : `https://lokaleregelgeving.overheid.nl/${identifier}`;
}

/** CVDR writes some dates as an XML Schema date with a zone ("2026-07-21Z"); keep the calendar date. */
function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const dateOnly = /^(\d{4}-\d{2}-\d{2})(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  return dateOnly ? dateOnly[1] : value;
}

/** Map an issuer type as CVDR writes it (index value or "overheid:Waterschap" scheme) to the index value. */
function toOrganizationType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const local = value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value;
  const known = CVDR_ORGANIZATION_TYPES.find((t) => t.toLowerCase() === local.toLowerCase());
  return known ?? (local || undefined);
}

/**
 * Narrow one parsed SRU <gzd> record into the useful CVDR fields.
 * With removeNSPrefix the tags are local names: overheidrg:meta → meta,
 * dcterms:title → title, dcterms:creator → creator, dcterms:issued → issued, etc.
 */
function extractCvdr(record: Record<string, unknown>) {
  const original = record.originalData as Record<string, unknown> | undefined;
  const meta = original?.meta as Record<string, unknown> | undefined;
  const owmskern = meta?.owmskern as Record<string, unknown> | undefined;
  const owmsmantel = meta?.owmsmantel as Record<string, unknown> | undefined;
  const enriched = record.enrichedData as Record<string, unknown> | undefined;

  const identifier = toStringValue(owmskern?.identifier) ?? toStringValue(record.identifier);
  const title = toStringValue(owmskern?.title) ?? toStringValue(record.title);
  // dcterms:creator is the issuing body: a municipality, but just as often a
  // province, water authority or joint arrangement.
  const organization = toStringValue(owmskern?.creator);
  const organizationType =
    toOrganizationType(toStringValue(enriched?.organisatietype)) ??
    toOrganizationType(attributeValue(owmskern?.creator, "scheme"));
  const date = normalizeDate(
    toStringValue(owmsmantel?.issued) ??
      toStringValue(owmskern?.modified) ??
      toStringValue(owmsmantel?.modified),
  );

  const canonical =
    toStringValue(enriched?.preferred_url) ??
    toStringValue(enriched?.preferredUrl) ??
    (identifier ? cvdrCanonicalUrl(identifier) : undefined);

  return { identifier, title, organization, organizationType, date, canonical };
}

/**
 * CVDR refused the query itself (an SRU diagnostic), as opposed to a network or
 * HTTP failure. Sending the same request again gives the same answer, so callers
 * get advice to change the query rather than to retry.
 */
export class CvdrQueryError extends Error {
  readonly suggestion =
    "CVDR kon deze zoekvraag niet uitvoeren; dezelfde aanroep herhalen geeft hetzelfde resultaat. Pas de zoekvraag aan: gebruik gewone zoekwoorden zonder leestekens, of zoek op https://lokaleregelgeving.overheid.nl. Blijft een eenvoudige zoekvraag falen, dan is het een storing bij KOOP.";

  constructor(
    message: string,
    readonly diagnostic: string,
  ) {
    super(message);
    this.name = "CvdrQueryError";
  }
}

/**
 * KOOP answers a query it cannot run (unsupported index, backend failure) with
 * HTTP 200 and an SRU <diagnostics> document. Without this check that would read
 * as "0 regelingen", a silent empty result for what is really an error.
 * Diagnostics next to actual records are informational and do not fail the call,
 * nor does SRU diagnostic 61 (first record position out of range): paging past
 * the end is an empty page, not an error.
 */
function assertNoFatalDiagnostics(parsed: unknown, recordCount: number): void {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("CVDR SRU gaf een onleesbaar antwoord.");
  }
  const root = parsed as Record<string, unknown>;
  const response = root.searchRetrieveResponse as Record<string, unknown> | undefined;
  const container = (response?.diagnostics ?? root.diagnostics) as Record<string, unknown> | undefined;
  if (container && recordCount === 0) {
    const diagnostic = Array.isArray(container.diagnostic) ? container.diagnostic[0] : container.diagnostic;
    const d = (diagnostic ?? {}) as Record<string, unknown>;
    const uri = toStringValue(d.uri) ?? "";
    if (!/\/61$/.test(uri)) {
      const message = toStringValue(d.message) ?? "onbekende fout";
      const details = toStringValue(d.details);
      throw new CvdrQueryError(`CVDR SRU meldt een fout: ${message}${details ? ` (${details})` : ""}.`, uri);
    }
  }
  if (!response) {
    throw new Error("CVDR SRU gaf een onverwacht antwoord (geen searchRetrieveResponse).");
  }
}

export interface CvdrSearchArgs {
  query: string;
  maximumRecords: number;
  /** 1-based SRU position of the first record to return; callers map their offset onto it. */
  startRecord?: number;
  organization?: string;
  organization_type?: CvdrOrganizationType;
}

function planSearch(args: CvdrSearchArgs) {
  const split = args.organization?.trim() ? splitOrganization(args.organization) : undefined;
  // A value without any letters or digits cannot become a creator clause; ignore it
  // rather than report a filter that was never applied.
  const org = split && organizationClause(split.name) ? split : undefined;
  // An explicit organization_type wins over the one implied by a "Gemeente …" prefix.
  const organizationType = args.organization_type ?? org?.impliedType;
  const startRecord = Math.max(1, Math.floor(args.startRecord ?? 1));

  const params: Record<string, string | number> = {
    "x-connection": CVDR_CONNECTION,
    operation: "searchRetrieve",
    version: "1.2",
    query: buildCql({ query: args.query, organization: org?.name, organizationType }),
    maximumRecords: args.maximumRecords,
    startRecord,
  };
  return { params, org, organizationType, startRecord };
}

export class CvdrSource {
  constructor(private readonly config: AppConfig) {}

  /** The exact SRU parameters search() would send, for dry runs. */
  requestParams(args: CvdrSearchArgs): Record<string, string> {
    const { params } = planSearch(args);
    return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
  }

  async search(args: CvdrSearchArgs) {
    const { params, org, organizationType, startRecord } = planSearch(args);

    const { data, meta } = await getText(CVDR_SRU_ENDPOINT, {
      query: params,
      connector: "cvdr",
    });
    const parsed = parseXml(data);
    const records = extractSruRecords(parsed);
    assertNoFatalDiagnostics(parsed, records.length);
    const total = extractSruNumberOfRecords(parsed);

    const items = records.map((r) => {
      const m = extractCvdr(r);
      return {
        identifier: m.identifier,
        title: m.title,
        // Kept for backward compatibility: despite its name this has always held the
        // issuer (creator), which can also be a province or water authority.
        gemeente: m.organization,
        organization: m.organization,
        organization_type: m.organizationType,
        date: m.date,
        canonical_url: m.canonical,
      } as Record<string, unknown>;
    });

    const notes = [
      "Bron: CVDR lokale regelgeving via KOOP SRU. Zoekwoorden worden met AND gecombineerd (OR en NOT in hoofdletters tussen woorden werken als operator) en matchen op titel én tekst, dus een plaatsnaam in de query vindt ook regelingen van andere overheden die die plaats noemen; filter op uitgever met 'organization'.",
      "'gemeente' is de uitgevende organisatie (ook provincie, waterschap of samenwerkingsverband); zie 'organization' en 'organization_type'.",
    ];
    if (org?.name) {
      notes.push(
        `Gefilterd op uitgever met '${org.name}' in de naam (match op hele woorden; bijv. 'Utrecht' omvat zowel de gemeente als de provincie Utrecht${organizationType ? "" : ", combineer zo nodig met organization_type"}).`,
      );
      if (total === 0) notes.push(await this.emptyIssuerNote(args.query, org.name, organizationType));
    }
    if (organizationType) notes.push(`Gefilterd op organisatietype ${organizationType}.`);
    if (total > 0 && startRecord > total) {
      notes.push(`offset ${startRecord - 1} ligt voorbij het totaal van ${total} treffers.`);
    }

    return {
      items,
      total,
      endpoint: meta.url,
      params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      access_note: notes.join(" "),
    };
  }

  /**
   * Zero hits with an issuer filter has two very different causes: the issuer name
   * matches nothing in CVDR (a spelling problem), or the issuer exists but has no
   * regulation with these words (a real answer). One count-only request on the
   * issuer alone tells them apart; if that check fails the note stays generic
   * rather than guessing.
   */
  private async emptyIssuerNote(
    query: string,
    organization: string,
    organizationType: CvdrOrganizationType | undefined,
  ): Promise<string> {
    const spellingHint =
      "CVDR gebruikt officiële namen (bijv. 's-Gravenhage, 's-Hertogenbosch, 'Waterschap Hunze en Aa's'); controleer de spelling.";
    const issuer = `een uitgever met '${organization}' in de naam${organizationType ? ` en organisatietype ${organizationType}` : ""}`;

    // Without search words the main query already was the issuer filter on its own.
    let issuerTotal: number | undefined = keywordClause(query.trim()) ? undefined : 0;
    if (issuerTotal === undefined) {
      try {
        const { data } = await getText(CVDR_SRU_ENDPOINT, {
          query: {
            "x-connection": CVDR_CONNECTION,
            operation: "searchRetrieve",
            version: "1.2",
            query: buildCql({ query: "", organization, organizationType }),
            maximumRecords: 0,
            startRecord: 1,
          },
          connector: "cvdr",
        });
        const parsed = parseXml(data);
        assertNoFatalDiagnostics(parsed, 0);
        issuerTotal = extractSruNumberOfRecords(parsed);
      } catch {
        issuerTotal = undefined;
      }
    }

    if (issuerTotal === 0) return `CVDR kent geen regelingen van ${issuer}: ${spellingHint}`;
    if (issuerTotal !== undefined) {
      return `CVDR heeft ${issuerTotal} regelingen van ${issuer}, maar geen enkele bevat alle zoekwoorden.`;
    }
    return `Geen treffers; als de uitgever wel regelingen zou moeten hebben: ${spellingHint}`;
  }
}
