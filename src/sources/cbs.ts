import { appCache, makeCacheKey } from "../cache.js";
import type { AppConfig } from "../types.js";
import { injectCbsTrends } from "../utils/cbs-trends.js";
import { and, buildODataQuery, contains, equals } from "../utils/odata.js";
import { getJson } from "../utils/http.js";
import { placeKey, placeKeys } from "../utils/place-aliases.js";

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

/** CBS as an organisation of the data.overheid.nl catalogue (title "CBS OpenData"). */
const CBS_CKAN_ORGANIZATION = "centraal-bureau-voor-de-statistiek";

/** A data.overheid.nl dataset that CBS published (by its organisation, not a word in its title). */
function isCbsDataset(row: Record<string, unknown>): boolean {
  const org = (row.organization ?? {}) as Record<string, unknown>;
  const name = String(org.name ?? "").toLowerCase();
  const title = String(org.title ?? "").toLowerCase();
  return name === CBS_CKAN_ORGANIZATION || name === "cbs" || /(?:^|[^a-z])cbs(?:$|[^a-z])|centraal bureau voor de statistiek/.test(title);
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
    // The v3 catalogue of all tables is the ODataCatalog next to the ODataApi
    // (".../ODataApi/OData/TableInfos" does not exist and answered 404).
    const endpoint = `${new URL(this.config.endpoints.cbsV3).origin}/ODataCatalog/Tables`;
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

    // Without the organisation filter only datasets CBS published count: a
    // search of the whole catalogue found "De afvalkalender" for a population
    // question, which is no CBS table.
    const attemptParams: Array<Record<string, string>> = [
      // The organisation's name in the catalogue ("organization:cbs" matched nothing).
      { q: query, rows: String(limit), fq: `organization:${CBS_CKAN_ORGANIZATION}` },
      { q: query, rows: String(Math.min(100, limit * 3)) },
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

      const cbsRows = params.fq ? candidateRows : candidateRows.filter(isCbsDataset);
      rows = cbsRows.slice(0, limit);
      if (rows.length) break;
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
    access_note?: string;
  }> {
    const cacheKey = makeCacheKey("cbs:searchTables", { query, limit });
    const cached = appCache.get<{
      items: Array<Record<string, unknown>>;
      endpoint: string;
      params: Record<string, string>;
      base: string;
      access_note?: string;
    }>(cacheKey);
    if (cached) return cached;

    let result: {
      items: Array<Record<string, unknown>>;
      endpoint: string;
      params: Record<string, string>;
      base: string;
      access_note?: string;
    };
    let usedFallback = false;
    try {
      result = await this.tryCatalogRequest(query, limit);
      // CBS v4 OData uses literal substring match — multi-word queries often return 0.
      // Fall through to data.overheid when v4 succeeds but has no hits.
      if (!result.items.length) {
        result = await this.tryCatalogViaDataOverheid(query, limit);
        usedFallback = true;
      }
    } catch {
      try {
        result = await this.tryCatalogRequestV3(query, limit);
        if (!result.items.length) {
          result = await this.tryCatalogViaDataOverheid(query, limit);
          usedFallback = true;
        }
      } catch {
        result = await this.tryCatalogViaDataOverheid(query, limit);
        usedFallback = true;
      }
    }

    if (usedFallback) {
      result = {
        ...result,
        access_note:
          "CBS OData (v4/v3) gaf 0 resultaten voor deze query (literal substring match werkt niet goed voor multi-word); teruggevallen op data.overheid.nl CKAN-catalog (breder index, minder specifiek op CBS-tabellen). Probeer kortere, specifiekere trefwoorden voor directe CBS-hits.",
      };
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
    const enrichResults = await Promise.allSettled(
      enrichTargets.map(async (target) => {
        const enrichEndpoint = `${base}/${tableId}/${target}`;
        // Beperk de dimensie-preview: 4 lijsten van elk max 30 items houdt de
        // token-payload richting het LLM behapbaar. Volledige lijsten zijn
        // opvraagbaar via getDimensionValues.
        const { data } = await getJson<Record<string, unknown>>(enrichEndpoint, {
          query: { $top: 30 },
        });
        return { target, items: asItems(data) };
      }),
    );
    for (const result of enrichResults) {
      if (result.status === "fulfilled") {
        info[result.value.target] = result.value.items;
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

/**
 * The CBS table with the population of every municipality on 1 January and
 * its yearly average, since 1988 ("Bevolking op 1 januari en gemiddeld;
 * geslacht, leeftijd en regio"). Its totals: both sexes, all ages, any marital status.
 */
export const CBS_POPULATION_TABLE = "03759ned";
const POPULATION_TOTALS = { Geslacht: "T001038", Leeftijd: "10000", BurgerlijkeStaat: "T001019" } as const;

/** The StatLine page of a CBS table. */
export function cbsTableUrl(tableId: string): string {
  return `https://opendata.cbs.nl/#/CBS/nl/dataset/${tableId}`;
}

/**
 * The page of a record cbs.searchTables returned: a CBS table its StatLine
 * page, a dataset of the data.overheid.nl fallback its catalogue page.
 */
export function cbsCatalogItemUrl(item: Record<string, unknown>): string {
  const id = String(item.Identifier ?? item.identifier ?? "").trim();
  if (!id) return "https://www.cbs.nl";
  return String(item.Source ?? "").startsWith("data.overheid.nl") ? `https://data.overheid.nl/dataset/${id}` : cbsTableUrl(id);
}

export interface CbsPopulationRow {
  periode: string;
  jaar: number;
  bevolking_op_1_januari: number | null;
  gemiddelde_bevolking: number | null;
}

/** Which kind of area a population figure is for: a municipality, a province or the country (RegioS GM, PV, NL01). */
export type CbsPopulationLevel = "gemeente" | "provincie" | "land";

export type CbsPopulationResult =
  | {
      kind: "gemeente";
      code: string;
      naam: string;
      rows: CbsPopulationRow[];
      endpoint: string;
      params: Record<string, string>;
      /** A municipality, or (when no municipality has the name) a province or the country. */
      niveau: CbsPopulationLevel;
      /** A former municipality: its last year in the table, and the table's newest year. */
      opgeheven?: { laatsteJaar: number; tabelTot: number };
    }
  /** Several municipalities that exist today carry the name ("Bergen"). */
  | { kind: "ambiguous"; candidates: Array<{ code: string; naam: string }>; endpoint: string; params: Record<string, string> }
  | { kind: "not_found"; endpoint: string; params: Record<string, string> };

/** "'s-Gravenhage (gemeente)", "Bergen (NH.)", "Fryslân (PV)": the name without CBS's qualifier, for matching. */
function regioName(title: string): string {
  return title.replace(/\s*\((?:gemeente|PV|[A-Za-z.]{1,6}\.)\)\s*$/u, "").trim();
}

function regioLevel(key: string): CbsPopulationLevel {
  return key.startsWith("GM") ? "gemeente" : key.startsWith("PV") ? "provincie" : "land";
}

/** The country in the table: its row gives the table's newest year. */
const POPULATION_COUNTRY = "NL01";

/** An OData v3 URL with %20 for spaces in $filter (see data-politie.ts). */
function odataUrl(endpoint: string, params: Record<string, string>): string {
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `${endpoint}?${qs}`;
}

/**
 * The population of one municipality from {@link CBS_POPULATION_TABLE}: its
 * code from the table's RegioS list (by name, also "Den Haag" for
 * 's-Gravenhage), then the totals per year. A name of several municipalities
 * that exist today is ambiguous; a former municipality ("Hengelo (Gld.)")
 * only counts when no current one has the name.
 */
export async function cbsMunicipalityPopulation(
  config: AppConfig,
  place: string,
): Promise<CbsPopulationResult> {
  const base = `${config.endpoints.cbsV3}/${CBS_POPULATION_TABLE}`;
  const regioParams = { $filter: "startswith(Key,'GM') or startswith(Key,'PV') or startswith(Key,'NL')", $select: "Key,Title" };
  const cacheKey = makeCacheKey("cbs:populationRegios", { v: 2 });
  // Key trimmed for the codes, Raw as the table has it: "NL01  " and "PV21  " are padded, and the filter needs that.
  let regios = appCache.get<Array<{ Key: string; Raw: string; Title: string }>>(cacheKey);
  let regioUrl = odataUrl(`${base}/RegioS`, regioParams);
  if (!regios) {
    const out = await getJson<Record<string, unknown>>(regioUrl);
    regioUrl = out.meta.url;
    regios = asItems(out.data).map((x) => ({ Key: String(x.Key ?? "").trim(), Raw: String(x.Key ?? ""), Title: String(x.Title ?? "").trim() }));
    if (regios.length) appCache.set(cacheKey, regios, config.cacheTtlMs.cbsCatalog);
  }
  const wanted = placeKeys(place);
  const named = regios.filter((r) => wanted.has(placeKey(regioName(r.Title))));
  // A municipality first ("Utrecht", "Groningen"): a province or the country only when none has the name.
  const municipalities = named.filter((r) => r.Key.startsWith("GM"));
  const matched = municipalities.length ? municipalities : named;
  if (!matched.length) return { kind: "not_found", endpoint: regioUrl, params: regioParams };

  // With the country's row, whose newest year is the table's: a former municipality stops before it.
  const country = regios.find((r) => r.Key === POPULATION_COUNTRY);
  const filterKeys = [...new Set([...matched.map((r) => r.Raw), ...(country ? [country.Raw] : [])])];
  const dataParams = {
    $filter: [
      `(${filterKeys.map((k) => `RegioS eq '${k.replace(/'/g, "''")}'`).join(" or ")})`,
      ...Object.entries(POPULATION_TOTALS).map(([k, v]) => `${k} eq '${v}'`),
    ].join(" and "),
    $select: "RegioS,Perioden,BevolkingOp1Januari_1,GemiddeldeBevolking_2",
  };
  const out = await getJson<Record<string, unknown>>(odataUrl(`${base}/TypedDataSet`, dataParams));
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const byRegio = new Map<string, CbsPopulationRow[]>();
  for (const x of asItems(out.data)) {
    const periode = String(x.Perioden ?? "").trim();
    const jaar = Number(periode.slice(0, 4));
    const row = { periode, jaar, bevolking_op_1_januari: num(x.BevolkingOp1Januari_1), gemiddelde_bevolking: num(x.GemiddeldeBevolking_2) };
    if (!Number.isFinite(jaar) || row.bevolking_op_1_januari === null) continue;
    const key = String(x.RegioS ?? "").trim();
    byRegio.set(key, [...(byRegio.get(key) ?? []), row]);
  }
  const latest = Math.max(0, ...[...byRegio.values()].flat().map((r) => r.jaar));
  // Municipalities that exist today have the latest year; a former one stops at its merger.
  const current = matched.filter((r) => byRegio.get(r.Key)?.some((row) => row.jaar === latest));
  const chosen = current.length ? current : matched.filter((r) => byRegio.has(r.Key));
  const params = { ...dataParams, table: CBS_POPULATION_TABLE };
  if (!chosen.length) return { kind: "not_found", endpoint: out.meta.url, params };
  if (chosen.length > 1) return { kind: "ambiguous", candidates: chosen.map((r) => ({ code: r.Key, naam: r.Title })), endpoint: out.meta.url, params };
  const [gemeente] = chosen;
  const rows = [...(byRegio.get(gemeente.Key) ?? [])].sort((a, b) => b.jaar - a.jaar);
  const niveau = regioLevel(gemeente.Key);
  const opgeheven = niveau === "gemeente" && rows.length && rows[0].jaar < latest ? { laatsteJaar: rows[0].jaar, tabelTot: latest } : undefined;
  return { kind: "gemeente", code: gemeente.Key, naam: regioName(gemeente.Title), rows, endpoint: out.meta.url, params, niveau, ...(opgeheven ? { opgeheven } : {}) };
}
