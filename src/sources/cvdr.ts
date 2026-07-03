import type { AppConfig } from "../types.js";
import { getText } from "../utils/http.js";
import {
  extractSruNumberOfRecords,
  extractSruRecords,
  parseXml,
} from "../utils/xml-parser.js";

/** SRU endpoint (KOOP zoekservice) that serves the CVDR local-regulations collection. */
const CVDR_SRU_ENDPOINT = "https://zoekservice.overheid.nl/sru/Search";
const CVDR_CONNECTION = "cvdr";

/** Read a scalar text value from a fast-xml-parser node (string, number, or { "#text": ... }). */
function toStringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["#text"] === "string") return obj["#text"];
    if (typeof obj["#text"] === "number") return String(obj["#text"]);
  }
  return undefined;
}

/** Escape a value for use inside double-quoted CQL/SRU strings. */
function escapeSruValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build the CQL query for CVDR. The CVDR SRU index does not support the default
 * cql.serverChoice; free-text search runs against the 'keyword' index.
 */
function buildCql(query: string): string {
  const term = query.trim();
  if (!term) return "keyword=*";
  const value = /\s/.test(term) ? `"${escapeSruValue(term)}"` : escapeSruValue(term);
  return `keyword=${value}`;
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
  const gemeente = toStringValue(owmskern?.creator);
  const date =
    toStringValue(owmsmantel?.issued) ??
    toStringValue(owmskern?.modified) ??
    toStringValue((owmsmantel as Record<string, unknown> | undefined)?.modified);

  const canonical =
    toStringValue(enriched?.preferredUrl) ??
    (identifier ? cvdrCanonicalUrl(identifier) : undefined);

  return { identifier, title, gemeente, date, canonical };
}

export class CvdrSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: { query: string; maximumRecords: number; startRecord?: number }) {
    const params: Record<string, string | number> = {
      "x-connection": CVDR_CONNECTION,
      operation: "searchRetrieve",
      version: "1.2",
      query: buildCql(args.query),
      maximumRecords: args.maximumRecords,
      startRecord: args.startRecord ?? 1,
    };

    const { data, meta } = await getText(CVDR_SRU_ENDPOINT, {
      query: params,
      connector: "cvdr",
    });
    const parsed = parseXml(data);
    const records = extractSruRecords(parsed);
    const total = extractSruNumberOfRecords(parsed);

    const items = records.map((r) => {
      const m = extractCvdr(r);
      return {
        identifier: m.identifier,
        title: m.title,
        gemeente: m.gemeente,
        date: m.date,
        canonical_url: m.canonical,
      } as Record<string, unknown>;
    });

    return {
      items,
      total,
      endpoint: meta.url,
      params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      access_note:
        "Bron: CVDR lokale regelgeving via KOOP SRU. Gezocht op de keyword-index.",
    };
  }
}
