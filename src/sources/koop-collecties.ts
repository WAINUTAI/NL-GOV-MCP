import type { AppConfig } from "../types.js";
import { getText } from "../utils/http.js";
import {
  extractSruNumberOfRecords,
  extractSruRecords,
  parseXml,
} from "../utils/xml-parser.js";
import { escapeSruValue, freeTextCql } from "../utils/sru-cql.js";

/**
 * Two more KOOP collections on the SRU endpoint this server already speaks.
 *
 * `repository.overheid.nl/sru` serves seven product areas; the server used only
 * `officielepublicaties`. A `scan` on c.product-area shows what was left on the
 * table, of which two are directly useful:
 *
 * - tuchtrecht (~48k)          — disciplinary rulings for regulated professions
 *                                (healthcare, bar, notaries, accountants, vets).
 *                                Rechtspraak.nl does NOT carry these.
 * - samenwerkendecatalogi (~55k) — which product/service each municipality,
 *                                province or water authority offers, with the
 *                                responsible authority and target audience.
 *
 * Both reuse the CQL/gzd parsing that bekendmakingen.ts already relies on.
 */
const SRU_ENDPOINT = "https://repository.overheid.nl/sru";

export type KoopCollection = "tuchtrecht" | "samenwerkendecatalogi";

const CONNECTOR_BY_COLLECTION: Record<KoopCollection, string> = {
  tuchtrecht: "tuchtrecht",
  samenwerkendecatalogi: "samenwerkende_catalogi",
};

export interface TuchtrechtItem {
  identifier: string;
  title: string;
  college: string;
  domein: string;
  plaats: string;
  zaaknummer: string;
  beslissing: string;
  uitspraakdatum: string;
  onderwerp: string;
  samenvatting: string;
  canonical_url: string;
  pdf_url: string;
}

export interface SamenwerkendeCatalogiItem {
  identifier: string;
  title: string;
  organisatie: string;
  organisatietype: string;
  gebied: string;
  informatietype: string;
  doelgroep: string;
  gewijzigd: string;
  samenvatting: string;
  canonical_url: string;
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const text = obj["#text"];
    if (typeof text === "string") return text;
    if (typeof text === "number") return String(text);
  }
  return "";
}

/** Join repeated elements (fast-xml-parser gives a scalar or an array). */
function toJoined(value: unknown, separator = ", "): string {
  if (Array.isArray(value)) {
    return value.map(toStringValue).filter(Boolean).join(separator);
  }
  return toStringValue(value);
}

/** ISO date (YYYY-MM-DD) only — anything else is dropped rather than sent as CQL. */
function toIsoDate(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

/** Collapse the whitespace-padded abstracts these collections ship with. */
function compact(value: string, maxChars = 600): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
}

interface GzdParts {
  owmskern: Record<string, unknown>;
  owmsmantel: Record<string, unknown>;
  tpmeta: Record<string, unknown>;
  enriched: Record<string, unknown>;
}

function splitRecord(record: Record<string, unknown>): GzdParts {
  const original = record.originalData as Record<string, unknown> | undefined;
  const meta = original?.meta as Record<string, unknown> | undefined;
  return {
    owmskern: (meta?.owmskern as Record<string, unknown> | undefined) ?? {},
    owmsmantel: (meta?.owmsmantel as Record<string, unknown> | undefined) ?? {},
    tpmeta: (meta?.tpmeta as Record<string, unknown> | undefined) ?? {},
    enriched: (record.enrichedData as Record<string, unknown> | undefined) ?? {},
  };
}

/** enrichedData carries one itemUrl per manifestation (pdf/xml/metadata). */
function itemUrl(enriched: Record<string, unknown>, manifestation: string): string {
  const raw = enriched.itemUrl;
  const entries = Array.isArray(raw) ? raw : [raw];
  for (const entry of entries) {
    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      if (String(obj.manifestation ?? "") === manifestation) return toStringValue(obj);
    }
  }
  return "";
}

function extractTuchtrecht(record: Record<string, unknown>): TuchtrechtItem {
  const { owmskern, owmsmantel, tpmeta, enriched } = splitRecord(record);
  const identifier = toStringValue(owmskern.identifier);

  return {
    identifier,
    title: toStringValue(owmskern.title) || identifier,
    college: toStringValue(owmskern.creator) || toStringValue(owmskern.authority),
    domein: toStringValue(tpmeta.instantieDomein),
    plaats: toStringValue(tpmeta.instantiePlaats),
    zaaknummer: toStringValue(tpmeta.zaaknummer),
    beslissing: toStringValue(tpmeta.beslissing),
    uitspraakdatum:
      toStringValue(tpmeta.uitspraakdatum) || toStringValue(owmskern.modified),
    onderwerp: toJoined(owmsmantel.subject),
    samenvatting: compact(toStringValue(owmsmantel.description)),
    canonical_url:
      toStringValue(enriched.preferredUrl) ||
      (identifier ? `https://tuchtrecht.overheid.nl/${identifier}` : ""),
    pdf_url: itemUrl(enriched, "pdf"),
  };
}

function extractSamenwerkendeCatalogi(
  record: Record<string, unknown>,
): SamenwerkendeCatalogiItem {
  const { owmskern, owmsmantel, enriched } = splitRecord(record);
  const identifier = toStringValue(owmskern.identifier);
  const authority = owmskern.authority as Record<string, unknown> | string | undefined;
  const organisatietype =
    authority && typeof authority === "object"
      ? String((authority as Record<string, unknown>).scheme ?? "").replace(/^overheid:/, "")
      : "";

  return {
    identifier,
    title: toStringValue(owmskern.title) || identifier,
    organisatie: toStringValue(owmskern.creator) || toStringValue(owmskern.authority),
    organisatietype,
    gebied: toStringValue(owmskern.spatial),
    informatietype: toStringValue(owmskern.type),
    doelgroep: toJoined(owmsmantel.audience),
    gewijzigd: toStringValue(owmskern.modified),
    samenvatting: compact(
      toStringValue(owmsmantel.abstract) || toStringValue(owmsmantel.description),
    ),
    canonical_url:
      toStringValue(enriched.preferredUrl) ||
      toStringValue(enriched.url) ||
      itemUrl(enriched, "metadata"),
  };
}

export interface KoopCollectionSearchArgs {
  query?: string;
  /** Exact dcterms:creator match (college for tuchtrecht, organisation for SC). */
  organisatie?: string;
  date_from?: string;
  date_to?: string;
  maximumRecords: number;
  startRecord?: number;
}

export class KoopCollectieSource {
  constructor(
    private readonly config: AppConfig,
    private readonly collection: KoopCollection,
  ) {}

  private buildCql(args: KoopCollectionSearchArgs): string {
    const parts = [`c.product-area==${this.collection}`];

    // Free text works directly on this endpoint (keyword="..." is unsupported),
    // but only as single AND-joined terms — see utils/sru-cql.ts.
    const term = freeTextCql(args.query);
    if (term) parts.push(term);

    const organisatie = (args.organisatie ?? "").trim();
    if (organisatie) parts.push(`dt.creator=="${escapeSruValue(organisatie)}"`);

    const from = toIsoDate(args.date_from);
    const to = toIsoDate(args.date_to);
    if (from) parts.push(`dt.modified>=${from}`);
    if (to) parts.push(`dt.modified<=${to}`);

    return parts.join(" AND ");
  }

  async search(args: KoopCollectionSearchArgs): Promise<{
    items: Array<TuchtrechtItem | SamenwerkendeCatalogiItem>;
    total: number;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const params: Record<string, string | number> = {
      operation: "searchRetrieve",
      version: "2.0",
      query: this.buildCql(args),
      maximumRecords: args.maximumRecords,
      startRecord: args.startRecord ?? 1,
      recordSchema: "gzd",
    };

    const { data, meta } = await getText(SRU_ENDPOINT, {
      query: params,
      connector: CONNECTOR_BY_COLLECTION[this.collection],
    });

    const parsed = parseXml(data);
    const records = extractSruRecords(parsed);
    const total = extractSruNumberOfRecords(parsed);

    const items =
      this.collection === "tuchtrecht"
        ? records.map(extractTuchtrecht)
        : records.map(extractSamenwerkendeCatalogi);

    const ignoredDates =
      (args.date_from && !toIsoDate(args.date_from)) || (args.date_to && !toIsoDate(args.date_to));

    const notes = [
      this.collection === "tuchtrecht"
        ? "Bron: tuchtrecht.overheid.nl via KOOP SRU (tuchtcolleges gezondheidszorg, advocatuur, notariaat, accountants, diergeneeskunde, gerechtsdeurwaarders). Niet te verwarren met Rechtspraak.nl, dat deze uitspraken niet bevat."
        : "Bron: Samenwerkende Catalogi via KOOP SRU — productbeschrijvingen (dienstverlening) van gemeenten, provincies en waterschappen.",
      ignoredDates ? "Datumfilter genegeerd: gebruik het formaat JJJJ-MM-DD." : "",
      items.length ? "" : "Geen resultaten; probeer een bredere zoekterm of laat het organisatiefilter weg (dat matcht exact).",
    ].filter(Boolean);

    return {
      items,
      total,
      endpoint: meta.url,
      params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      access_note: notes.join(" "),
    };
  }
}
