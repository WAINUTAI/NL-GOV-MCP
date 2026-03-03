import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

interface EurostatDataResponse {
  id?: string[];
  size?: Record<string, number>;
  value?: Record<string, number>;
  label?: string;
  source?: string;
  updated?: string;
  extension?: Record<string, unknown>;
}

export class EurostatSource {
  constructor(private readonly config: AppConfig) {}

  async previewDataset(args: { dataset: string; rows: number; filters?: Record<string, string> }) {
    const rows = Math.min(args.rows, this.config.limits.maxRows);
    const query: Record<string, string | number> = {
      format: "JSON",
      lang: "en",
    };
    for (const [k, v] of Object.entries(args.filters ?? {})) {
      if (!v) continue;
      query[k] = v;
    }

    const endpoint = `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${encodeURIComponent(args.dataset)}`;
    const { data, meta } = await getJson<EurostatDataResponse>(endpoint, {
      query,
      timeoutMs: 20_000,
      retries: 1,
    });

    const values = data.value ?? {};
    const itemEntries = Object.entries(values).slice(0, rows);
    const items = itemEntries.map(([key, value]) => ({
      observation_key: key,
      value,
      dataset: args.dataset,
      dimensions: data.id ?? [],
      updated: data.updated,
      source: data.source,
    }));

    return {
      items,
      total: Object.keys(values).length,
      endpoint: meta.url,
      params: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
      ...(items.length ? {} : { access_note: "Eurostat dataset bereikbaar, maar geen waarden in deze selectie." }),
    };
  }

  searchFallback(args: { query: string; rows: number }) {
    const normalized = args.query.toLowerCase();
    const catalog = [
      { code: "nama_10_gdp", title: "GDP and main components", keywords: ["gdp", "bbp", "economy", "economie"] },
      { code: "une_rt_m", title: "Unemployment by sex and age", keywords: ["werkloos", "unemployment", "arbeid"] },
      { code: "tps00001", title: "Population on 1 January", keywords: ["bevolking", "population", "inwoners"] },
      { code: "hlth_cd_asdr2", title: "Standardised death rate", keywords: ["health", "zorg", "mortality"] },
    ];

    const scored = catalog
      .map((x) => {
        const text = `${x.code} ${x.title} ${x.keywords.join(" ")}`.toLowerCase();
        let score = 0;
        for (const t of normalized.split(/\s+/).filter(Boolean)) if (text.includes(t)) score += 1;
        return { ...x, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, args.rows);

    return {
      items: scored.map((x) => ({
        id: x.code,
        title: x.title,
        source: "eurostat-catalog-fallback",
        url: `https://ec.europa.eu/eurostat/databrowser/view/${x.code}/default/table?lang=en`,
        score: x.score,
      })),
      total: scored.length,
      endpoint: "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{dataset} (fallback catalog)",
      params: { q: args.query, rows: String(args.rows) },
      access_note: "Eurostat heeft geen stabiele open search endpoint; deterministische catalog fallback gebruikt.",
    };
  }
}
