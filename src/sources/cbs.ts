import { appCache, makeCacheKey } from "../cache.js";
import type { AppConfig } from "../types.js";
import { and, buildODataQuery, contains, equals } from "../utils/odata.js";
import { getJson } from "../utils/http.js";

function asItems(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.value)) return obj.value as Array<Record<string, unknown>>;

  const d = obj.d as Record<string, unknown> | undefined;
  if (d) {
    const results = d.results;
    if (Array.isArray(results)) return results as Array<Record<string, unknown>>;
    if (results && typeof results === "object") {
      return [results as Record<string, unknown>];
    }
  }

  return [];
}

function quote(v: string | number | boolean): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

export class CbsSource {
  constructor(private readonly config: AppConfig) {}

  private async tryCatalogRequest(query: string, limit: number) {
    const endpoint = `${this.config.endpoints.cbsV4}/Datasets`;
    const params = buildODataQuery({
      filter: query ? contains("Title", query) : undefined,
      top: limit,
    });

    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, {
      query: params,
    });

    return {
      items: asItems(data),
      endpoint: meta.url,
      params,
      base: this.config.endpoints.cbsV4,
    };
  }

  private async tryCatalogRequestV3(query: string, limit: number) {
    const endpoint = `${this.config.endpoints.cbsV3}/TableInfos`;
    const params: Record<string, string> = {
      $top: String(limit),
    };

    if (query) {
      params.$filter = `substringof('${query.replace(/'/g, "''")}',Title)`;
    }

    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, {
      query: params,
    });

    return {
      items: asItems(data),
      endpoint: meta.url,
      params,
      base: this.config.endpoints.cbsV3,
    };
  }

  async searchTables(query: string, limit: number): Promise<{
    items: Array<Record<string, unknown>>;
    endpoint: string;
    params: Record<string, string>;
    base: string;
  }> {
    const cacheKey = makeCacheKey("cbs:searchTables", { query, limit });
    const cached = appCache.get<{
      items: Array<Record<string, unknown>>;
      endpoint: string;
      params: Record<string, string>;
      base: string;
    }>(cacheKey);
    if (cached) return cached;

    let result;
    try {
      result = await this.tryCatalogRequest(query, limit);
    } catch {
      result = await this.tryCatalogRequestV3(query, limit);
    }

    appCache.set(cacheKey, result, this.config.cacheTtlMs.cbsCatalog);
    return result;
  }

  async getTableInfo(tableId: string): Promise<{
    tableId: string;
    info: Record<string, unknown>;
    endpoint: string;
    params: Record<string, string>;
    base: string;
  }> {
    const cacheKey = makeCacheKey("cbs:getTableInfo", { tableId });
    const cached = appCache.get<{
      tableId: string;
      info: Record<string, unknown>;
      endpoint: string;
      params: Record<string, string>;
      base: string;
    }>(cacheKey);
    if (cached) return cached;

    const probes = [
      `${this.config.endpoints.cbsV4}/${tableId}`,
      `${this.config.endpoints.cbsV4}/${tableId}/Properties`,
      `${this.config.endpoints.cbsV3}/${tableId}/TableInfos`,
      `${this.config.endpoints.cbsV3}/TableInfos`,
    ];

    let chosenEndpoint = probes[0];
    let raw: Record<string, unknown> | undefined;
    let base = this.config.endpoints.cbsV4;
    let params: Record<string, string> = {};

    for (const endpoint of probes) {
      try {
        if (endpoint.endsWith("/TableInfos")) {
          params = { $top: "1" };
        } else if (endpoint.endsWith("/TableInfos") || endpoint.endsWith("TableInfos")) {
          params = { $filter: equals("Identifier", tableId), $top: "1" };
        } else {
          params = { $top: "1" };
        }

        const { data, meta } = await getJson<Record<string, unknown>>(endpoint, {
          query: params,
        });
        chosenEndpoint = meta.url;
        raw = data;
        if (endpoint.includes(this.config.endpoints.cbsV3)) {
          base = this.config.endpoints.cbsV3;
        }
        break;
      } catch {
        // try next
      }
    }

    if (!raw) {
      // final fallback: return basic object
      const result = {
        tableId,
        info: { tableId },
        endpoint: `${this.config.endpoints.cbsV4}/${tableId}`,
        params: {},
        base: this.config.endpoints.cbsV4,
      };
      appCache.set(cacheKey, result, this.config.cacheTtlMs.cbsCatalog);
      return result;
    }

    const info = asItems(raw)[0] ?? raw;

    // Try enrich with measures + dimensions (best effort)
    const enrichTargets = ["MeasureCodes", "Dimensions", "Perioden", "RegioS"];
    for (const target of enrichTargets) {
      try {
        const enrichEndpoint = `${base}/${tableId}/${target}`;
        const { data } = await getJson<Record<string, unknown>>(enrichEndpoint, {
          query: { $top: 200 },
        });
        info[target] = asItems(data);
      } catch {
        // ignore missing endpoints
      }
    }

    const result = {
      tableId,
      info,
      endpoint: chosenEndpoint,
      params,
      base,
    };

    appCache.set(cacheKey, result, this.config.cacheTtlMs.cbsCatalog);
    return result;
  }

  async getObservations(args: {
    tableId: string;
    filters?: Record<string, string | number | boolean | Array<string | number | boolean>>;
    select?: string[];
    top?: number;
    skip?: number;
  }): Promise<{
    items: Array<Record<string, unknown>>;
    endpoint: string;
    params: Record<string, string>;
    base: string;
  }> {
    const { tableId } = args;
    const top = args.top ?? 100;

    const filterClauses: string[] = [];
    for (const [k, v] of Object.entries(args.filters ?? {})) {
      if (Array.isArray(v)) {
        const ors = v.map((x) => `${k} eq ${quote(x)}`).join(" or ");
        filterClauses.push(`(${ors})`);
      } else {
        filterClauses.push(`${k} eq ${quote(v)}`);
      }
    }

    const params = buildODataQuery({
      filter: and(...filterClauses),
      select: args.select,
      top,
      skip: args.skip,
    });

    const cacheKey = makeCacheKey("cbs:getObservations", {
      tableId,
      params,
    });
    const cached = appCache.get<{
      items: Array<Record<string, unknown>>;
      endpoint: string;
      params: Record<string, string>;
      base: string;
    }>(cacheKey);
    if (cached) return cached;

    let endpoint = `${this.config.endpoints.cbsV4}/${tableId}/Observations`;
    let base = this.config.endpoints.cbsV4;
    let data: Record<string, unknown>;
    let metaUrl: string;

    try {
      const out = await getJson<Record<string, unknown>>(endpoint, { query: params });
      data = out.data;
      metaUrl = out.meta.url;
    } catch {
      endpoint = `${this.config.endpoints.cbsV3}/${tableId}/TypedDataSet`;
      base = this.config.endpoints.cbsV3;
      const out = await getJson<Record<string, unknown>>(endpoint, { query: params });
      data = out.data;
      metaUrl = out.meta.url;
    }

    const result = {
      items: asItems(data),
      endpoint: metaUrl,
      params,
      base,
    };

    appCache.set(cacheKey, result, this.config.cacheTtlMs.default);
    return result;
  }

  async getDimensionValues(tableId: string, dimension: string): Promise<{
    items: Array<Record<string, unknown>>;
    endpoint: string;
    params: Record<string, string>;
    base: string;
  }> {
    const params = { $top: "1000" };
    const cacheKey = makeCacheKey("cbs:getDimensionValues", {
      tableId,
      dimension,
    });

    const cached = appCache.get<{
      items: Array<Record<string, unknown>>;
      endpoint: string;
      params: Record<string, string>;
      base: string;
    }>(cacheKey);
    if (cached) return cached;

    let endpoint = `${this.config.endpoints.cbsV4}/${tableId}/${dimension}`;
    let base = this.config.endpoints.cbsV4;
    let data: Record<string, unknown>;
    let metaUrl: string;

    try {
      const out = await getJson<Record<string, unknown>>(endpoint, { query: params });
      data = out.data;
      metaUrl = out.meta.url;
    } catch {
      endpoint = `${this.config.endpoints.cbsV3}/${tableId}/${dimension}`;
      base = this.config.endpoints.cbsV3;
      const out = await getJson<Record<string, unknown>>(endpoint, { query: params });
      data = out.data;
      metaUrl = out.meta.url;
    }

    const result = {
      items: asItems(data),
      endpoint: metaUrl,
      params,
      base,
    };

    appCache.set(cacheKey, result, this.config.cacheTtlMs.default);
    return result;
  }
}
