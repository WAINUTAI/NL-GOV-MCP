import type { AppConfig } from "../types.js";
import { and, buildODataQuery } from "../utils/odata.js";
import { getJson } from "../utils/http.js";

/**
 * CBS Iv3 gemeente-/provinciefinanciën via de CBS "dataderden" OData v3 endpoint.
 *
 * KRITIEK: host dataderden.cbs.nl matcht inferConnectorName → "cbs". Daarom geven
 * we ALTIJD expliciet `connector: CONNECTOR` mee aan elke getJson-call.
 */
const CONNECTOR = "cbs_iv3";
const DATADERDEN_ROOT = "https://dataderden.cbs.nl/ODataApi/OData";
const DEFAULT_TABLE = "45071NED";

/** Dimensies die in de TypedDataSet-rijen als sleutelkolom voorkomen. */
const DIMENSION_KEYS = new Set([
  "ID",
  "Gemeenten",
  "TaakveldBalanspost",
  "Categorie",
  "Verslagsoort",
  "Perioden",
]);

type Dimension = "Gemeenten" | "TaakveldBalanspost" | "Categorie" | "Verslagsoort";

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

/**
 * Exacte dimensie-match die de vaste-breedte spatie-padding tolereert die CBS op
 * dataderden-keys gebruikt (bv. Gemeenten staat opgeslagen als "GM1680   ").
 * trim() wordt door de CBS OData v3-server ondersteund en vermijdt de prefix-
 * over-matching die startswith zou geven op codes als "0.1" vs "0.10".
 */
function filterEq(field: string, value: string): string {
  return `trim(${field}) eq '${value.replace(/'/g, "''")}'`;
}

/** Herkent of een opgegeven waarde al een dimensie-code is (dan geen naam-lookup). */
function looksLikeCode(dimension: Dimension, value: string): boolean {
  const v = value.trim();
  if (dimension === "Gemeenten") return /^[A-Za-z]{2}\d/.test(v); // GM1680, PV20
  if (dimension === "TaakveldBalanspost") return /^[\d.]+$/.test(v); // 0.1
  if (dimension === "Categorie") return /^[A-Za-z]{0,2}[\d.]+$/.test(v); // L1.1
  if (dimension === "Verslagsoort") return /^\d{4}[A-Za-z]/.test(v); // 2025X000
  return false;
}

export class CbsIv3Source {
  constructor(private readonly config: AppConfig) {}

  private canonicalUrl(tableId: string): string {
    return `https://opendata.cbs.nl/#/CBS/nl/dataset/${tableId}/table`;
  }

  private toDataItem(row: Record<string, unknown>, tableId: string): Record<string, unknown> {
    const gemeente = String(row.Gemeenten ?? "").trim();
    const taakveld = String(row.TaakveldBalanspost ?? "").trim();
    const categorie = String(row.Categorie ?? "").trim();
    const verslagsoort = String(row.Verslagsoort ?? "").trim();

    // Alleen de bedrag-kolommen (namen verschillen per tabel, bv.
    // k_1ePlaatsing_1, k_2ePlaatsing_2) selecteren; geen ruwe upstream-dump.
    const amounts: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!DIMENSION_KEYS.has(key)) amounts[key] = value;
    }

    return {
      id: `${tableId}:${String(row.ID ?? "")}`,
      title: `${gemeente || "gemeente"} · ${taakveld || "taakveld"} · ${verslagsoort || "verslag"}`,
      tableId,
      gemeente,
      taakveldBalanspost: taakveld,
      categorie,
      verslagsoort,
      ...amounts,
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
    const { data } = await getJson<Record<string, unknown>>(endpoint, {
      query: { $top: "5000" },
      connector: CONNECTOR,
    });
    const needle = trimmed.toLowerCase();
    const hit = asItems(data).find((r) =>
      String(r.Title ?? "").toLowerCase().includes(needle),
    );
    return hit ? String(hit.Key ?? "").trim() : trimmed;
  }

  async search(args: {
    query?: string;
    tableId?: string;
    gemeente?: string;
    taakveldBalanspost?: string;
    categorie?: string;
    verslagsoort?: string;
    dimension?: Dimension;
    rows: number;
    skip?: number;
  }): Promise<{
    items: Array<Record<string, unknown>>;
    total: number | null;
    hasMore?: boolean;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const tableId = (args.tableId ?? DEFAULT_TABLE).trim();
    const rows = args.rows;

    // Verkenmodus: lever de waarden van een dimensie.
    if (args.dimension) {
      const dimension = args.dimension;
      const params: Record<string, string> = { $top: String(rows) };
      if (typeof args.skip === "number") params.$skip = String(args.skip);

      const endpoint = `${DATADERDEN_ROOT}/${tableId}/${dimension}`;
      const { data, meta } = await getJson<Record<string, unknown>>(endpoint, {
        query: params,
        connector: CONNECTOR,
      });

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

    // Datamodus: TypedDataSet met $filter op de financiële dimensies.
    const clauses: string[] = [];

    if (args.gemeente) {
      const key = await this.resolveKey(tableId, "Gemeenten", args.gemeente);
      clauses.push(filterEq("Gemeenten", key));
    }
    if (args.taakveldBalanspost) {
      const key = await this.resolveKey(tableId, "TaakveldBalanspost", args.taakveldBalanspost);
      clauses.push(filterEq("TaakveldBalanspost", key));
    }
    if (args.categorie) {
      const key = await this.resolveKey(tableId, "Categorie", args.categorie);
      clauses.push(filterEq("Categorie", key));
    }
    if (args.verslagsoort) {
      const key = await this.resolveKey(tableId, "Verslagsoort", args.verslagsoort);
      clauses.push(filterEq("Verslagsoort", key));
    }

    const params = buildODataQuery({
      filter: and(...clauses),
      top: rows,
      skip: args.skip,
    });

    const endpoint = `${DATADERDEN_ROOT}/${tableId}/TypedDataSet`;
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, {
      query: params,
      connector: CONNECTOR,
    });

    const items = asItems(data).map((r) => this.toDataItem(r, tableId));

    const notes = [
      "CBS Iv3 gemeente-/provinciefinanciën via OData (dataderden.cbs.nl). Gemeenten, TaakveldBalanspost, Categorie en Verslagsoort accepteren zowel een code als een naam (naam wordt via de dimensie-lijst omgezet). Verslagsoort onderscheidt o.a. begroting vs. jaarrekening. Zet 'dimension' om geldige filterwaarden te verkennen.",
    ];

    // The table is indexed taakveld-major, so a municipality filter alone fills
    // an entire page with the first few of its 145 task fields — looking, to a
    // caller that sums what it got, like a budget an order of magnitude too low.
    // Narrowing to one Categorie + Verslagsoort returns all 145 in a single call.
    const pageFull = items.length >= rows;
    if (pageFull && args.gemeente && !(args.categorie && args.verslagsoort)) {
      notes.push(
        `Let op: dit is één pagina van ${rows} rijen, geen volledige gemeente. De tabel is taakveld-major geordend, dus deze rijen beslaan slechts de eerste van circa 145 taakvelden — optellen geeft een veel te laag totaal. Filter op één 'categorie' én 'verslagsoort' om alle taakvelden van deze gemeente in één aanroep te krijgen.`,
      );
    }

    return {
      items,
      // Upstream levert geen count; null i.p.v. de paginagrootte, zodat een
      // consument "x van y" niet met een verzonnen y toont.
      total: null,
      hasMore: pageFull,
      endpoint: meta.url,
      params,
      access_note: notes.join(" "),
    };
  }
}
