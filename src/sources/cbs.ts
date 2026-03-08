import { appCache, makeCacheKey } from "../cache.js";
import type { AppConfig } from "../types.js";
import { injectCbsTrends } from "../utils/cbs-trends.js";
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

  private async tryCatalogViaDataOverheid(query: string, limit: number) {
    const endpoint = `${this.config.endpoints.dataOverheid}/package_search`;

    const attemptParams: Array<Record<string, string>> = [
      { q: query, rows: String(limit), fq: "organization:cbs" },
      { q: query, rows: String(limit) },
    ];

    let chosenMetaUrl = endpoint;
    let chosenParams = attemptParams[0];
    let rows: Array<Record<string, unknown>> = [];

    for (const params of attemptParams) {
      const { data, meta } = await getJson<Record<string, unknown>>(endpoint, {
        query: params,
      });
      const result = (data.result as Record<string, unknown> | undefined) ?? {};
      const candidateRows = Array.isArray(result.results)
        ? (result.results as Array<Record<string, unknown>>)
        : [];

      chosenMetaUrl = meta.url;
      chosenParams = params;

      if (!candidateRows.length) {
        rows = candidateRows;
        continue;
      }

      const preferred = candidateRows.filter((row) => {
        const text = `${String(row.title ?? "")} ${String(row.organization ? (row.organization as Record<string, unknown>).title ?? "" : "")}`.toLowerCase();
        return text.includes("cbs") || text.includes("centraal bureau voor de statistiek");
      });

      rows = (preferred.length ? preferred : candidateRows).slice(0, limit);
      break;
    }

    const items = rows.map((row) => {
      const title = (row.title as string | undefined) ?? (row.name as string | undefined);
      const identifier = (row.id as string | undefined) ?? (row.name as string | undefined);
      return {
        Identifier: identifier,
        Title: title,
        Summary: row.notes,
        Modified: row.metadata_modified,
        Source: "data.overheid.nl (CBS fallback)",
        Raw: row,
      } as Record<string, unknown>;
    });

    return {
      items,
      endpoint: chosenMetaUrl,
      params: chosenParams,
      base: "data.overheid.nl/cbs-fallback",
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
      // CBS v4 OData uses literal substring match — multi-word queries often return 0.
      // Fall through to data.overheid when v4 succeeds but has no hits.
      if (!result.items.length) {
        result = await this.tryCatalogViaDataOverheid(query, limit);
      }
    } catch {
      try {
        result = await this.tryCatalogRequestV3(query, limit);
        if (!result.items.length) {
          result = await this.tryCatalogViaDataOverheid(query, limit);
        }
      } catch {
        result = await this.tryCatalogViaDataOverheid(query, limit);
      }
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
        if (endpoint === `${this.config.endpoints.cbsV3}/TableInfos`) {
          // Global TableInfos endpoint — needs filter by Identifier
          params = { $filter: equals("Identifier", tableId), $top: "1" };
        } else if (endpoint.endsWith("/TableInfos")) {
          // Table-specific TableInfos (e.g. /37296ned/TableInfos) — no filter needed
          params = { $top: "1" };
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

    const probes: Array<{ endpoint: string; base: string }> = [
      { endpoint: `${this.config.endpoints.cbsV4}/${tableId}/Observations`, base: this.config.endpoints.cbsV4 },
      { endpoint: `${this.config.endpoints.cbsV4}/${tableId}/TypedDataSet`, base: this.config.endpoints.cbsV4 },
      { endpoint: `${this.config.endpoints.cbsV3}/${tableId}/TypedDataSet`, base: this.config.endpoints.cbsV3 },
      { endpoint: `${this.config.endpoints.cbsV3}/${tableId}/UntypedDataSet`, base: this.config.endpoints.cbsV3 },
    ];

    let items: Array<Record<string, unknown>> = [];
    let chosenEndpoint = probes[0].endpoint;
    let chosenBase = probes[0].base;

    for (const probe of probes) {
      try {
        const out = await getJson<Record<string, unknown>>(probe.endpoint, { query: params });
        const parsed = asItems(out.data);
        if (parsed.length || probe === probes[probes.length - 1]) {
          items = parsed;
          chosenEndpoint = out.meta.url;
          chosenBase = probe.base;
          break;
        }
      } catch {
        // try next
      }
    }

    const result = {
      items: injectCbsTrends(items),
      endpoint: chosenEndpoint,
      params,
      base: chosenBase,
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
