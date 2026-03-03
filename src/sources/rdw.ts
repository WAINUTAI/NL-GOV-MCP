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
