import type { AppConfig } from "../types.js";
import { and, buildODataQuery } from "../utils/odata.js";
import { getJson } from "../utils/http.js";

/**
 * data.politie.nl misdaadcijfers via de CBS "dataderden" OData v3 endpoint.
 *
 * KRITIEK: host dataderden.cbs.nl matcht inferConnectorName → "cbs". Daarom geven
 * we ALTIJD expliciet `connector: CONNECTOR` mee aan elke getJson-call, zodat de
 * cache/circuit-breaker deze bron los van CBS StatLine telt.
 */
const CONNECTOR = "data_politie";
const DATADERDEN_ROOT = "https://dataderden.cbs.nl/ODataApi/OData";
const DEFAULT_TABLE = "47013NED";

/** Dimensies die in de TypedDataSet-rijen als sleutelkolom voorkomen. */
const DIMENSION_KEYS = new Set(["ID", "SoortMisdrijf", "RegioS", "Perioden"]);

type Dimension = "RegioS" | "SoortMisdrijf" | "Perioden";

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

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Exacte dimensie-match die de vaste-breedte spatie-padding tolereert die CBS op
 * dataderden-keys kan gebruiken (bv. Gemeenten "GM1680   "). trim() wordt door de
 * OData v3-server ondersteund en vermijdt prefix-over-matching van startswith.
 */
function filterEq(field: string, value: string): string {
  return `trim(${field}) eq '${value.replace(/'/g, "''")}'`;
}

/**
 * Bouwt de query-string met %20 voor spaties. De OData v3 `$filter` bevat spaties
 * (`RegioS eq 'GM0363'`); URLSearchParams zou die als '+' encoden, wat de
 * dataderden OData-parser als een letterlijke '+' kan lezen i.p.v. een spatie.
 * encodeURIComponent geeft %20 en houdt de filter dus intact.
 */
function buildUrl(endpoint: string, params: Record<string, string>): string {
  const qs = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return qs ? `${endpoint}?${qs}` : endpoint;
}

/** Herkent of een opgegeven waarde al een dimensie-code is (dan geen naam-lookup). */
function looksLikeCode(dimension: Dimension, value: string): boolean {
  const v = value.trim();
  if (dimension === "RegioS") return /^[A-Za-z]{2}\d/.test(v); // NL01, PV20, GM0363, WK..., BU...
  if (dimension === "SoortMisdrijf") return /^[\d.]+$/.test(v); // 0.0.0, 1.1.1
  return true; // Perioden wordt apart afgehandeld
}

export class DataPolitieSource {
  constructor(private readonly config: AppConfig) {}

  private canonicalUrl(tableId: string): string {
    return `https://data.politie.nl/#/CBS/nl/dataset/${tableId}/table`;
  }

  private toDataItem(row: Record<string, unknown>, tableId: string): Record<string, unknown> {
    const regio = String(row.RegioS ?? "").trim();
    const soort = String(row.SoortMisdrijf ?? "").trim();
    const periode = String(row.Perioden ?? "").trim();

    // Alleen de meetwaarde-kolommen (namen verschillen per tabel, bv.
    // GeregistreerdeMisdrijven_1, Aangiften_2, Internetaangiften_3) selecteren.
    const measures: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!DIMENSION_KEYS.has(key)) measures[key] = value;
    }

    return {
      id: `${tableId}:${String(row.ID ?? "")}`,
      title: `${soort || "misdrijf"} · ${regio || "regio"} · ${periode || "periode"}`,
      tableId,
      soortMisdrijf: soort,
      regio,
      periode,
      ...measures,
      url: this.canonicalUrl(tableId),
    };
  }

  private toDimensionItem(
    row: Record<string, unknown>,
    tableId: string,
    dimension: Dimension,
  ): Record<string, unknown> {
    return {
      key: String(row.Key ?? "").trim(),
      title: String(row.Title ?? "").trim(),
      description: String(row.Description ?? ""),
      dimension,
      tableId,
      url: this.canonicalUrl(tableId),
    };
  }

  /** Zet een (mogelijk) naam-invoer om naar de dimensie-code (Key). */
  private async resolveKey(
    tableId: string,
    dimension: Dimension,
    value: string,
  ): Promise<string> {
    const trimmed = value.trim();
    if (looksLikeCode(dimension, trimmed)) return trimmed;

    const endpoint = `${DATADERDEN_ROOT}/${tableId}/${dimension}`;
    const { data } = await getJson<Record<string, unknown>>(
      buildUrl(endpoint, { $top: "5000" }),
      { connector: CONNECTOR },
    );
    const needle = trimmed.toLowerCase();
    const hit = asItems(data).find((r) =>
      String(r.Title ?? "").toLowerCase().includes(needle),
    );
    return hit ? String(hit.Key ?? "").trim() : trimmed;
  }

  async search(args: {
    query?: string;
    tableId?: string;
    regio?: string;
    soortMisdrijf?: string;
    periode?: string;
    dimension?: Dimension;
    rows: number;
    skip?: number;
  }): Promise<{
    items: Array<Record<string, unknown>>;
    total: number | null;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const tableId = (args.tableId ?? DEFAULT_TABLE).trim();
    const rows = args.rows;

    // Verkenmodus: lever de waarden van een dimensie (RegioS / SoortMisdrijf / Perioden).
    if (args.dimension) {
      const dimension = args.dimension;
      const params: Record<string, string> = { $top: String(rows) };
      if (typeof args.skip === "number") params.$skip = String(args.skip);

      const endpoint = `${DATADERDEN_ROOT}/${tableId}/${dimension}`;
      const { data, meta } = await getJson<Record<string, unknown>>(
        buildUrl(endpoint, params),
        { connector: CONNECTOR },
      );

      let items = asItems(data).map((r) => this.toDimensionItem(r, tableId, dimension));
      if (args.query) {
        const needle = args.query.toLowerCase();
        items = items.filter(
          (it) =>
            String(it.title).toLowerCase().includes(needle) ||
            String(it.key).toLowerCase().includes(needle),
        );
      }

      return {
        items,
        // Upstream levert geen count; null i.p.v. de paginagrootte, zodat een
        // consument "x van y" niet met een verzonnen y toont.
        total: null,
        endpoint: meta.url,
        params,
        access_note: `Dimensie-verkenning van '${dimension}' in tabel ${tableId}. Gebruik een teruggegeven 'key' als filterwaarde in een vervolg-zoekopdracht.`,
      };
    }

    // Datamodus: TypedDataSet met $filter op RegioS / SoortMisdrijf / Perioden.
    const clauses: string[] = [];

    if (args.regio) {
      const key = await this.resolveKey(tableId, "RegioS", args.regio);
      clauses.push(filterEq("RegioS", key));
    }
    if (args.soortMisdrijf) {
      const key = await this.resolveKey(tableId, "SoortMisdrijf", args.soortMisdrijf);
      clauses.push(filterEq("SoortMisdrijf", key));
    }
    if (args.periode) {
      const periode = args.periode.trim();
      // Kaal jaartal → alle perioden binnen dat jaar; anders exacte periode-key.
      if (/^\d{4}$/.test(periode)) {
        clauses.push(`startswith(Perioden,${quote(periode)})`);
      } else {
        clauses.push(filterEq("Perioden", periode));
      }
    }

    const params = buildODataQuery({
      filter: and(...clauses),
      top: rows,
      skip: args.skip,
    });

    const endpoint = `${DATADERDEN_ROOT}/${tableId}/TypedDataSet`;
    const { data, meta } = await getJson<Record<string, unknown>>(
      buildUrl(endpoint, params),
      { connector: CONNECTOR },
    );

    const items = asItems(data).map((r) => this.toDataItem(r, tableId));

    return {
      items,
      // Upstream levert geen count; null i.p.v. de paginagrootte, zodat een
      // consument "x van y" niet met een verzonnen y toont.
      total: null,
      endpoint: meta.url,
      params,
      access_note:
        "Misdaadcijfers via CBS/politie OData (dataderden.cbs.nl). RegioS en SoortMisdrijf accepteren zowel een code als een naam (naam wordt via de dimensie-lijst omgezet). Zet 'dimension' op RegioS/SoortMisdrijf/Perioden om geldige filterwaarden te verkennen. Perioden: kaal jaartal (bv. 2023) matcht alle maanden/jaartotalen van dat jaar.",
    };
  }
}
