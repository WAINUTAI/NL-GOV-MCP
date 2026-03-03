import type { AppConfig } from "../types.js";
import { getJson, getText } from "../utils/http.js";

function uniqBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export class DuoSource {
  constructor(private readonly config: AppConfig) {}

  async datasetsCatalog(query: string, rows: number) {
    const endpoint = `${this.config.endpoints.duoDatasets}/api/3/action/package_search`;
    const params = { q: query, rows: String(rows) };
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, { query: params });
    const result = (data.result as Record<string, unknown> | undefined) ?? {};
    const items = (result.results as Array<Record<string, unknown>> | undefined) ?? [];
    const total = (result.count as number | undefined) ?? items.length;
    return { items, total, endpoint: meta.url, params };
  }

  private async searchCandidates(candidates: string[], top: number) {
    const cleaned = uniqBy(
      candidates.map((x) => x.trim()).filter(Boolean),
      (x) => x.toLowerCase(),
    ).slice(0, 5);

    const merged: Array<Record<string, unknown>> = [];
    let endpoint = `${this.config.endpoints.duoDatasets}/api/3/action/package_search`;

    for (const q of cleaned) {
      const out = await this.datasetsCatalog(q, top);
      endpoint = out.endpoint;
      for (const item of out.items) {
        merged.push({ ...item, helper_query: q });
      }
      if (merged.length >= top * 2) break;
    }

    const deduped = uniqBy(merged, (x) => String(x.id ?? x.name ?? x.title ?? ""));
    return {
      items: deduped.slice(0, top),
      total: deduped.length,
      endpoint,
      params: { attempted_queries: cleaned.join(" | "), rows: String(top) },
    };
  }

  async getSchools(args: {
    name?: string;
    municipality?: string;
    type?: string;
    top: number;
  }) {
    const base = [args.name, args.municipality, args.type].filter(Boolean).join(" ").trim();
    const candidates = [
      `${base} schoolvestigingen`,
      `${base} schoollocaties`,
      `${base} onderwijsinstellingen`,
      `${base} brin`,
      `${base} vo mbo hbo`,
      `${base} school`,
    ];
    return this.searchCandidates(candidates, args.top);
  }

  async getExamResults(args: {
    year?: number;
    school?: string;
    municipality?: string;
    top: number;
  }) {
    const base = [
      args.year ? String(args.year) : "",
      args.school ?? "",
      args.municipality ?? "",
    ]
      .join(" ")
      .trim();

    const candidates = [
      `examens voortgezet onderwijs ${base}`,
      `slagingspercentages ${base}`,
      `examenresultaten vo ${base}`,
      `centrale examens ${base}`,
      `diplomaresultaten ${base}`,
    ];

    return this.searchCandidates(candidates, args.top);
  }

  async rioSearch(query: string, top: number) {
    const endpoint = `${this.config.endpoints.duoRio}/search`;
    const params = { q: query, limit: String(top) };

    const { data, meta } = await getText(endpoint, { query: params });

    const trimmed = data.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const items = (parsed.results as Array<Record<string, unknown>> | undefined) ??
          (Array.isArray((parsed as { items?: unknown[] }).items)
            ? ((parsed as { items: unknown[] }).items as Array<Record<string, unknown>>)
            : []);
        return { items: items.slice(0, top), endpoint: meta.url, params };
      } catch {
        // continue to fallback below
      }
    }

    const fallbackItems: Array<Record<string, unknown>> = [
      {
        id: "rio-api-home",
        name: "RIO API home",
        description: "RIO API returned HTML shell from this host; use linked docs/endpoints",
        url: this.config.endpoints.duoRio,
        query,
      },
      {
        id: "rio-overview",
        name: "DUO open data overview",
        url: "https://duo.nl/open_onderwijsdata/overzicht-open-data.jsp",
        query,
      },
      {
        id: "duo-datasets",
        name: "DUO datasets portal",
        url: "https://onderwijsdata.duo.nl/datasets",
        query,
      },
    ].slice(0, top);

    return { items: fallbackItems, endpoint: meta.url, params };
  }
}
