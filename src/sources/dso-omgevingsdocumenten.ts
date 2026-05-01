import type { AppConfig } from "../types.js";
import { getJson, postJson } from "../utils/http.js";

const DSO_PRESENTEREN_BASE =
  "https://service.omgevingswet.overheid.nl/publiek/omgevingsdocumenten/api/presenteren/v8";

const DSO_VIEWER_BASE = "https://omgevingswet.overheid.nl/regels-op-de-kaart/viewer";

export type DocumentType = "omgevingsplan" | "omgevingsvisie" | "programma" | "omgevingsverordening";
export type BevoegdGezagType = "gemeente" | "provincie" | "waterschap" | "ministerie";

interface RegelingItem {
  identificatie?: string;
  officieleTitel?: string;
  citeerTitel?: string;
  opschrift?: string;
  publicatieID?: string;
  expressionId?: string;
  inwerkingTot?: string;
  geldigTot?: string;
  type?: { code?: string; waarde?: string };
  aangeleverdDoorEen?: { naam?: string; bestuurslaag?: string; code?: string };
  geregistreerdMet?: {
    versie?: number;
    beginInwerking?: string;
    beginGeldigheid?: string;
    eindGeldigheid?: string;
    tijdstipRegistratie?: string;
    eindRegistratie?: string;
  };
  _links?: { self?: { href?: string } };
}

interface RegelingenResponse {
  _embedded?: { regelingen?: RegelingItem[] };
  page?: { totalElements?: number; size?: number; number?: number };
}

export interface DsoSearchArgs {
  query?: string;
  bevoegdGezag?: string;
  typeBevoegdGezag?: BevoegdGezagType;
  documentType?: DocumentType;
  rows: number;
}

export interface DsoSearchItem {
  id: string;
  title: string;
  documentType?: string;
  documentTypeCode?: string;
  bevoegdGezag?: string;
  bestuurslaag?: string;
  bevoegdGezagCode?: string;
  beginGeldigheid?: string;
  eindGeldigheid?: string;
  beginInwerking?: string;
  inwerkingTot?: string;
  geldigTot?: string;
  viewerUrl: string;
  selfUrl?: string;
  raw: RegelingItem;
}

function viewerUrlFor(item: RegelingItem): string {
  const id = item.identificatie;
  if (id && /^https?:/i.test(id)) {
    return `${DSO_VIEWER_BASE}/regels?source=${encodeURIComponent(id)}`;
  }
  return DSO_VIEWER_BASE;
}

function matchesQuery(item: RegelingItem, query?: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  const haystack = [
    item.officieleTitel,
    item.citeerTitel,
    item.opschrift,
    item.aangeleverdDoorEen?.naam,
    item.type?.waarde,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function matchesDocumentType(item: RegelingItem, documentType?: DocumentType): boolean {
  if (!documentType) return true;
  const t = (item.type?.waarde ?? "").toLowerCase();
  return t.includes(documentType.toLowerCase());
}

function normalize(item: RegelingItem): DsoSearchItem {
  const reg = item.geregistreerdMet ?? {};
  return {
    id: item.identificatie ?? item.expressionId ?? "",
    title: item.officieleTitel ?? item.citeerTitel ?? item.opschrift ?? "Omgevingsdocument",
    documentType: item.type?.waarde,
    documentTypeCode: item.type?.code,
    bevoegdGezag: item.aangeleverdDoorEen?.naam,
    bestuurslaag: item.aangeleverdDoorEen?.bestuurslaag,
    bevoegdGezagCode: item.aangeleverdDoorEen?.code,
    beginGeldigheid: reg.beginGeldigheid,
    eindGeldigheid: reg.eindGeldigheid,
    beginInwerking: reg.beginInwerking,
    inwerkingTot: item.inwerkingTot,
    geldigTot: item.geldigTot,
    viewerUrl: viewerUrlFor(item),
    selfUrl: item._links?.self?.href,
    raw: item,
  };
}

export class DsoOmgevingsdocumentenSource {
  constructor(
    private readonly config: AppConfig,
    private readonly apiKey?: string,
  ) {}

  hasKey(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim());
  }

  async search(args: DsoSearchArgs): Promise<{
    items: DsoSearchItem[];
    total: number;
    endpoint: string;
    query: Record<string, string>;
  }> {
    if (!this.hasKey()) {
      throw new Error("DSO_API_KEY is required for dso_omgevingsdocumenten_search");
    }

    const headers: Record<string, string> = {
      "x-api-key": this.apiKey as string,
      Accept: "application/hal+json",
    };

    const useZoek = Boolean(args.bevoegdGezag || args.typeBevoegdGezag);
    const size = String(Math.min(Math.max(args.rows, 1), this.config.limits.maxRows));

    if (useZoek) {
      const body: Record<string, unknown> = {};
      if (args.typeBevoegdGezag) body.typeBevoegdGezag = [args.typeBevoegdGezag];
      if (args.bevoegdGezag) body.bevoegdGezag = [args.bevoegdGezag];

      const url = `${DSO_PRESENTEREN_BASE}/regelingen/_zoek`;
      const queryParams: Record<string, string> = { size, page: "1" };

      const { data, meta } = await postJson<RegelingenResponse>(url, body, {
        query: queryParams,
        headers,
        connector: "dso_omgevingsdocumenten",
      });

      const all = data._embedded?.regelingen ?? [];
      const filtered = all.filter((x) => matchesQuery(x, args.query) && matchesDocumentType(x, args.documentType));

      return {
        items: filtered.slice(0, args.rows).map(normalize),
        total: data.page?.totalElements ?? all.length,
        endpoint: meta.url,
        query: {
          ...queryParams,
          ...(args.typeBevoegdGezag ? { typeBevoegdGezag: args.typeBevoegdGezag } : {}),
          ...(args.bevoegdGezag ? { bevoegdGezag: args.bevoegdGezag } : {}),
          ...(args.query ? { q: args.query } : {}),
          ...(args.documentType ? { documentType: args.documentType } : {}),
        },
      };
    }

    const url = `${DSO_PRESENTEREN_BASE}/regelingen`;
    const queryParams: Record<string, string> = { size, page: "1" };

    const { data, meta } = await getJson<RegelingenResponse>(url, {
      query: queryParams,
      headers,
      connector: "dso_omgevingsdocumenten",
    });

    const all = data._embedded?.regelingen ?? [];
    const filtered = all.filter((x) => matchesQuery(x, args.query) && matchesDocumentType(x, args.documentType));

    return {
      items: filtered.slice(0, args.rows).map(normalize),
      total: data.page?.totalElements ?? all.length,
      endpoint: meta.url,
      query: {
        ...queryParams,
        ...(args.query ? { q: args.query } : {}),
        ...(args.documentType ? { documentType: args.documentType } : {}),
      },
    };
  }
}
