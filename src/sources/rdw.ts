import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

interface RdwRecord {
  kenteken?: string;
  merk?: string;
  handelsbenaming?: string;
  voertuigsoort?: string;
  [key: string]: unknown;
}

const RDW_ENDPOINT = "https://opendata.rdw.nl/resource/m9d7-ebf2.json";

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
      access_note: "Geen live RDW match of endpoint instabiliteit; fallbackrecord gebruikt.",
    };
  }

  async search(args: { query: string; rows: number }) {
    const params = { $limit: String(Math.min(args.rows * 5, 100)), $order: "datum_tenaamstelling DESC" };
    const { data, meta } = await getJson<RdwRecord[]>(RDW_ENDPOINT, { query: params, timeoutMs: 15_000 });

    const q = args.query.toLowerCase();
    const items = (Array.isArray(data) ? data : [])
      .filter((x) => {
        const text = `${x.kenteken ?? ""} ${x.merk ?? ""} ${x.handelsbenaming ?? ""} ${x.voertuigsoort ?? ""}`.toLowerCase();
        return !q || text.includes(q);
      })
      .slice(0, args.rows)
      .map((x, i) => ({
        id: `${x.kenteken ?? `rdw-${i}`}`,
        title: `${x.merk ?? "Onbekend merk"} ${x.handelsbenaming ?? ""}`.trim(),
        url: "https://opendata.rdw.nl/",
        updated_at: String(x.datum_tenaamstelling ?? ""),
        ...x,
      }));

    return {
      items,
      total: items.length,
      endpoint: meta.url,
      params,
      ...(items.length ? {} : { access_note: "Geen live match in RDW dataset voor deze zoekterm." }),
    };
  }
}
