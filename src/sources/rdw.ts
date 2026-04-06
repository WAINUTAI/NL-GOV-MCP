import type { AppConfig } from "../types.js";
import { loadConfig } from "../config.js";
import { getJson } from "../utils/http.js";

interface RdwRecord {
  kenteken?: string;
  merk?: string;
  handelsbenaming?: string;
  voertuigsoort?: string;
  [key: string]: unknown;
}

const RDW_ENDPOINT = "https://opendata.rdw.nl/resource/m9d7-ebf2.json";

function normalizeKenteken(input: string): string | undefined {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z0-9]{6}$/.test(compact)) return undefined;
  const letters = (compact.match(/[A-Z]/g) ?? []).length;
  const digits = (compact.match(/[0-9]/g) ?? []).length;
  return letters >= 2 && digits >= 2 ? compact : undefined;
}

function toRdwItem(x: RdwRecord, fallbackId: string) {
  return {
    id: `${x.kenteken ?? fallbackId}`,
    title: `${x.merk ?? "Onbekend merk"} ${x.handelsbenaming ?? ""}`.trim(),
    url: "https://opendata.rdw.nl/",
    updated_at: String(
      (x as { datum_tenaamstelling?: unknown }).datum_tenaamstelling ?? "",
    ),
    ...x,
  };
}

function containsQuery(x: RdwRecord, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  const text = `${x.kenteken ?? ""} ${x.merk ?? ""} ${
    x.handelsbenaming ?? ""
  } ${x.voertuigsoort ?? ""}`.toLowerCase();
  return text.includes(q);
}

export class RdwSource {
  constructor(private readonly config: AppConfig) {}

  fallback(args: { query: string; rows: number }) {
    const slug = args.query.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return {
      items: [
        {
          id: `rdw-fallback-${slug}`,
          title: `RDW fallback voor '${args.query}'`,
          url: "https://opendata.rdw.nl/",
          updated_at: "1970-01-01T00:00:00Z",
          voertuigsoort: "onbekend",
          source: "fallback",
        },
      ].slice(0, args.rows),
      total: 1,
      endpoint: `${RDW_ENDPOINT} (fallback)`,
      params: { $limit: String(args.rows) },
      access_note:
        "Geen live RDW match of endpoint instabiliteit; fallbackrecord gebruikt.",
    };
  }

  async search(args: { query: string; rows: number }) {
    const q = args.query.trim();
    const normalizedKenteken = normalizeKenteken(q);
    const escapedLike = q.toUpperCase().replace(/'/g, "''").replace(/[%_\\]/g, "\\$&");

    const attemptParams: Array<Record<string, string>> = [];

    if (normalizedKenteken) {
      attemptParams.push({
        $limit: String(Math.min(args.rows, 25)),
        $where: `kenteken='${normalizedKenteken}'`,
      });
    }

    attemptParams.push({
      $limit: String(Math.min(args.rows * 5, 100)),
      $q: q,
      $order: "datum_tenaamstelling DESC",
    });

    if (q) {
      attemptParams.push({
        $limit: String(Math.min(args.rows * 5, 100)),
        $where: `upper(merk) like '%${escapedLike}%' or upper(handelsbenaming) like '%${escapedLike}%' or upper(voertuigsoort) like '%${escapedLike}%'`,
        $order: "datum_tenaamstelling DESC",
        __timeoutMs: "8000", // LIKE with leading wildcards is slow on Socrata
      });
    }

    for (const params of attemptParams) {
      try {
        const timeoutMs = params.__timeoutMs ? Number(params.__timeoutMs) : 15_000;
        const { __timeoutMs: _, ...cleanParams } = params;
        const { data, meta } = await getJson<RdwRecord[]>(RDW_ENDPOINT, {
          query: cleanParams,
          timeoutMs,
        });

        const raw = Array.isArray(data) ? data : [];
        const filtered =
          params.$q || params.$where
            ? raw
            : raw.filter((x) => containsQuery(x, q));

        if (!filtered.length) continue;

        const seen = new Set<string>();
        const items = filtered
          .map((x, i) => toRdwItem(x, `rdw-${i}`))
          .filter((item) => {
            const key = String(item.id ?? "");
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, args.rows);

        if (!items.length) continue;

        return {
          items,
          total: items.length,
          endpoint: meta.url,
          params,
        };
      } catch {
        // try next strategy
      }
    }

    return {
      items: [],
      total: 0,
      endpoint: RDW_ENDPOINT,
      params: { $limit: String(args.rows) },
      access_note: "Geen live match in RDW dataset voor deze zoekterm.",
    };
  }
}

export async function search(query: string): Promise<{
  data: unknown;
  citations: Array<{
    source: "rdw";
    title: string;
    url: string;
    retrievedAt: string;
    excerpt?: string;
  }>;
}> {
  const cfg = loadConfig();
  const src = new RdwSource(cfg);

  try {
    const out = await src.search({ query, rows: 5 });
    if (Array.isArray(out.items) && out.items.length > 0) {
      return {
        data: out.items,
        citations: [
          {
            source: "rdw",
            title: "RDW Open Data",
            url: out.endpoint || "https://opendata.rdw.nl",
            retrievedAt: new Date().toISOString(),
            ...(out.access_note ? { excerpt: out.access_note } : {}),
          },
        ],
      };
    }

    const fb = src.fallback({ query, rows: 5 });
    return {
      data: fb.items,
      citations: [
        {
          source: "rdw",
          title: "RDW Open Data (fallback)",
          url: "https://opendata.rdw.nl",
          retrievedAt: new Date().toISOString(),
          excerpt: fb.access_note,
        },
      ],
    };
  } catch {
    const out = src.fallback({ query, rows: 5 });
    return {
      data: out.items,
      citations: [
        {
          source: "rdw",
          title: "RDW Open Data (fallback)",
          url: "https://opendata.rdw.nl",
          retrievedAt: new Date().toISOString(),
          excerpt: out.access_note,
        },
      ],
    };
  }
}
