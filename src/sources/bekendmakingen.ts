import type { AppConfig } from "../types.js";
import { getText } from "../utils/http.js";
import {
  extractSruNumberOfRecords,
  extractSruRecords,
  parseXml,
} from "../utils/xml-parser.js";

function toStringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["#text"] === "string") return obj["#text"];
  }
  return undefined;
}

/** Escape a value for use inside double-quoted CQL/SRU strings. */
function escapeSruValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function extractMeta(record: Record<string, unknown>) {
  const meta = (record.originalData as Record<string, unknown> | undefined)?.meta as
    | Record<string, unknown>
    | undefined;
  const owmskern = meta?.owmskern as Record<string, unknown> | undefined;
  const tpmeta = meta?.tpmeta as Record<string, unknown> | undefined;
  const enriched = record.enrichedData as Record<string, unknown> | undefined;

  const identifier = toStringValue(owmskern?.identifier) ?? toStringValue(record.identifier);
  const title = toStringValue(owmskern?.title) ?? toStringValue(record.title);
  const date = toStringValue((meta?.owmsmantel as Record<string, unknown> | undefined)?.date);
  const authority = toStringValue(owmskern?.creator);
  const canonical =
    toStringValue(enriched?.preferredUrl) ??
    (identifier ? `https://zoek.officielebekendmakingen.nl/${identifier}` : undefined);

  return {
    identifier,
    title,
    date,
    authority,
    canonical,
    type: toStringValue(owmskern?.type),
    productArea: toStringValue(tpmeta?.["product-area"]),
  };
}

export class BekendmakingenSource {
  constructor(private readonly config: AppConfig) {}

  fallbackSearch(args: {
    query: string;
    maximumRecords: number;
    startRecord?: number;
    type?: string;
    authority?: string;
    date_from?: string;
    date_to?: string;
  }) {
    const slug = (args.query || "zoekterm").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "zoekterm";
    const identifier = `ob-fallback-${slug}`;
    const canonicalUrl = `https://zoek.officielebekendmakingen.nl/resultaten?zoekterm=${encodeURIComponent(args.query || "")}`;

    return {
      items: [
        {
          identifier,
          title: `Fallback bekendmaking voor '${args.query}'`,
          date: new Date(0).toISOString(),
          authority: args.authority ?? "fallback",
          canonical_url: canonicalUrl,
          publication_type: args.type ?? "fallback",
          mode: "deterministic-fallback",
        } satisfies Record<string, unknown>,
      ].slice(0, Math.max(1, args.maximumRecords)),
      total: 1,
      endpoint: `${this.config.endpoints.bekendmakingenSru} (fallback)`,
      params: {
        operation: "searchRetrieve",
        version: "2.0",
        query: args.query,
        maximumRecords: String(args.maximumRecords),
        startRecord: String(args.startRecord ?? 1),
        recordSchema: "gzd",
        mode: "deterministic-fallback",
      } as Record<string, string>,
      access_note:
        "Officiële Bekendmakingen endpoint tijdelijk niet bereikbaar; fallbackrecord gebruikt.",
    };
  }

  fallbackGet(identifier: string) {
    const canonicalUrl = `https://zoek.officielebekendmakingen.nl/${identifier}`;
    return {
      item: {
        identifier,
        title: `Fallback bekendmaking ${identifier}`,
        date: new Date(0).toISOString(),
        authority: "fallback",
        canonical_url: canonicalUrl,
        publication_type: "fallback",
        product_area: "officielepublicaties",
        mode: "deterministic-fallback",
      } as Record<string, unknown>,
      endpoint: `${this.config.endpoints.bekendmakingenSru} (fallback)`,
      params: {
        operation: "searchRetrieve",
        version: "2.0",
        query: `dt.identifier="${escapeSruValue(identifier)}" AND c.product-area="officielepublicaties"`,
        maximumRecords: "1",
        startRecord: "1",
        recordSchema: "gzd",
        mode: "deterministic-fallback",
      } as Record<string, string>,
      access_note:
        "Officiële Bekendmakingen endpoint tijdelijk niet bereikbaar; fallbackrecord gebruikt.",
    };
  }

  async search(args: {
    query: string;
    maximumRecords: number;
    startRecord?: number;
    type?: string;
    authority?: string;
    date_from?: string;
    date_to?: string;
  }) {
    const endpoint = this.config.endpoints.bekendmakingenSru;

    const cqlParts: string[] = [];
    // On this SRU endpoint, free-text terms work directly; keyword="..." is unsupported.
    if (args.query?.trim()) cqlParts.push(args.query.trim());
    cqlParts.push('c.product-area="officielepublicaties"');
    if (args.type?.trim()) cqlParts.push(`dt.type="${escapeSruValue(args.type.trim())}"`);
    if (args.authority?.trim()) cqlParts.push(`dt.creator="${escapeSruValue(args.authority.trim())}"`);
    if (args.date_from?.trim()) cqlParts.push(`dt.date>=${args.date_from.trim()}`);
    if (args.date_to?.trim()) cqlParts.push(`dt.date<=${args.date_to.trim()}`);

    const params: Record<string, string | number> = {
      operation: "searchRetrieve",
      version: "2.0",
      query: cqlParts.join(" AND "),
      maximumRecords: args.maximumRecords,
      startRecord: args.startRecord ?? 1,
      recordSchema: "gzd",
    };

    const { data, meta } = await getText(endpoint, { query: params });
    const parsed = parseXml(data);
    const records = extractSruRecords(parsed);
    const total = extractSruNumberOfRecords(parsed);

    const items = records.map((r) => {
      const m = extractMeta(r);
      return {
        ...r,
        identifier: m.identifier,
        title: m.title,
        date: m.date,
        authority: m.authority,
        canonical_url: m.canonical,
        publication_type: m.type,
      } as Record<string, unknown>;
    });

    return {
      items,
      total,
      endpoint: meta.url,
      params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    };
  }

  async getRecord(identifier: string) {
    const endpoint = this.config.endpoints.bekendmakingenSru;
    const params: Record<string, string | number> = {
      operation: "searchRetrieve",
      version: "2.0",
      query: `dt.identifier="${escapeSruValue(identifier)}" AND c.product-area="officielepublicaties"`,
      maximumRecords: 1,
      startRecord: 1,
      recordSchema: "gzd",
    };

    const { data, meta } = await getText(endpoint, { query: params });
    const parsed = parseXml(data);
    const records = extractSruRecords(parsed);

    const first = records[0] ?? {};
    const m = extractMeta(first);

    return {
      item: {
        ...first,
        identifier: m.identifier ?? identifier,
        title: m.title,
        date: m.date,
        authority: m.authority,
        canonical_url:
          m.canonical ?? `https://zoek.officielebekendmakingen.nl/${identifier}`,
        publication_type: m.type,
        product_area: m.productArea,
      } as Record<string, unknown>,
      endpoint: meta.url,
      params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    };
  }
}
