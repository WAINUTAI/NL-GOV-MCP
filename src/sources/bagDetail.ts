import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

const PDOK_LOCATIESERVER = "https://api.pdok.nl/bzk/locatieserver/search/v3_1";
const BAG_REST = "https://api.bag.kadaster.nl/lvbag/individuelebevragingen/v2";

interface LocatieserverLookupDoc {
  id?: string;
  weergavenaam?: string;
  type?: string;
  adresseerbaarobject_id?: string;
  nummeraanduiding_id?: string;
  pandid?: string | string[];
  woonplaatscode?: string;
  gemeentecode?: string;
  straatnaam?: string;
  huisnummer?: string | number;
  huisletter?: string;
  huisnummertoevoeging?: string;
  postcode?: string;
  woonplaatsnaam?: string;
  gemeentenaam?: string;
  centroide_ll?: string;
  centroide_rd?: string;
  [key: string]: unknown;
}

interface LocatieserverLookupResponse {
  response?: {
    docs?: LocatieserverLookupDoc[];
    numFound?: number;
  };
}

interface BagVerblijfsobjectResponse {
  verblijfsobject?: {
    identificatie?: string;
    status?: string;
    gebruiksdoelen?: string[];
    oppervlakte?: number;
    maaktDeelUitVan?: string[];
    heeftAlsHoofdadres?: { identificatie?: string };
    geconstateerd?: boolean;
    documentdatum?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface BagPandResponse {
  pand?: {
    identificatie?: string;
    status?: string;
    oorspronkelijkBouwjaar?: number | string;
    geconstateerd?: boolean;
    documentdatum?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface BagAddressDetail {
  weergavenaam: string | null;
  postcode: string | null;
  gemeentenaam: string | null;
  pdok_id: string | null;
  nummeraanduiding_id: string | null;
  verblijfsobject_id: string | null;
  pand_ids: string[];
  oppervlakte_m2: number | null;
  gebruiksdoelen: string[];
  verblijfsobject_status: string | null;
  bouwjaar: number | null;
  pand_status: string | null;
  data_kwaliteit: "hard" | "partial" | "lookup_only";
  notes: string[];
}

export class BagDetailSource {
  constructor(private readonly config: AppConfig) {}

  private apiKey(): string | null {
    const key = process.env.BAG_API_KEY?.trim();
    return key && key.length > 0 ? key : null;
  }

  async resolveAddress(args: { query?: string; pdok_id?: string }) {
    if (args.pdok_id) {
      const endpoint = `${PDOK_LOCATIESERVER}/lookup`;
      const params = { id: args.pdok_id, fl: "*" };
      const { data, meta } = await getJson<LocatieserverLookupResponse>(endpoint, {
        query: params,
        timeoutMs: 15_000,
        retries: 1,
      });
      const doc = data.response?.docs?.[0] ?? null;
      return { doc, endpoint: meta.url, params };
    }

    const q = (args.query ?? "").trim();
    if (!q) {
      throw new Error("bag_address_detail: ofwel `query` ofwel `pdok_id` is vereist.");
    }
    const endpoint = `${PDOK_LOCATIESERVER}/free`;
    const params = {
      q,
      rows: "1",
      fq: "type:adres",
      fl: "id,weergavenaam,type,straatnaam,huisnummer,postcode,woonplaatsnaam,gemeentenaam,centroide_ll,centroide_rd",
    };
    const { data, meta } = await getJson<LocatieserverLookupResponse>(endpoint, {
      query: params,
      timeoutMs: 15_000,
      retries: 1,
    });
    const first = data.response?.docs?.[0];
    if (!first?.id) {
      return { doc: null, endpoint: meta.url, params };
    }
    const lookupEndpoint = `${PDOK_LOCATIESERVER}/lookup`;
    const lookupParams = { id: first.id, fl: "*" };
    const lookup = await getJson<LocatieserverLookupResponse>(lookupEndpoint, {
      query: lookupParams,
      timeoutMs: 15_000,
      retries: 1,
    });
    return {
      doc: lookup.data.response?.docs?.[0] ?? null,
      endpoint: lookup.meta.url,
      params: lookupParams,
    };
  }

  async getVerblijfsobject(id: string, apiKey: string) {
    const endpoint = `${BAG_REST}/verblijfsobjecten/${encodeURIComponent(id)}`;
    const { data, meta } = await getJson<BagVerblijfsobjectResponse>(endpoint, {
      headers: {
        "X-Api-Key": apiKey,
        Accept: "application/hal+json",
        "Accept-Crs": "epsg:28992",
      },
      timeoutMs: 15_000,
      retries: 1,
    });
    return { data, endpoint: meta.url };
  }

  async getPand(id: string, apiKey: string) {
    const endpoint = `${BAG_REST}/panden/${encodeURIComponent(id)}`;
    const { data, meta } = await getJson<BagPandResponse>(endpoint, {
      headers: {
        "X-Api-Key": apiKey,
        Accept: "application/hal+json",
        "Accept-Crs": "epsg:28992",
      },
      timeoutMs: 15_000,
      retries: 1,
    });
    return { data, endpoint: meta.url };
  }

  async lookupDetail(args: { query?: string; pdok_id?: string }): Promise<{
    detail: BagAddressDetail;
    endpoints: string[];
  }> {
    const endpoints: string[] = [];
    const notes: string[] = [];
    const resolved = await this.resolveAddress(args);
    endpoints.push(resolved.endpoint);

    const detail: BagAddressDetail = {
      weergavenaam: resolved.doc?.weergavenaam ?? null,
      postcode: resolved.doc?.postcode ?? null,
      gemeentenaam: resolved.doc?.gemeentenaam ?? null,
      pdok_id: resolved.doc?.id ?? null,
      nummeraanduiding_id: resolved.doc?.nummeraanduiding_id ?? null,
      verblijfsobject_id: resolved.doc?.adresseerbaarobject_id ?? null,
      pand_ids: normalizePandIds(resolved.doc?.pandid),
      oppervlakte_m2: null,
      gebruiksdoelen: [],
      verblijfsobject_status: null,
      bouwjaar: null,
      pand_status: null,
      data_kwaliteit: "lookup_only",
      notes,
    };

    if (!resolved.doc) {
      notes.push("Adres niet gevonden in PDOK Locatieserver.");
      return { detail, endpoints };
    }

    const apiKey = this.apiKey();
    if (!apiKey) {
      notes.push("BAG_API_KEY niet geconfigureerd; oppervlakte/bouwjaar niet opgehaald.");
      return { detail, endpoints };
    }

    let voHit = false;
    if (detail.verblijfsobject_id) {
      try {
        const vo = await this.getVerblijfsobject(detail.verblijfsobject_id, apiKey);
        endpoints.push(vo.endpoint);
        const v = vo.data.verblijfsobject;
        if (v) {
          voHit = true;
          detail.oppervlakte_m2 =
            typeof v.oppervlakte === "number" ? v.oppervlakte : null;
          detail.gebruiksdoelen = Array.isArray(v.gebruiksdoelen)
            ? v.gebruiksdoelen.filter((g): g is string => typeof g === "string")
            : [];
          detail.verblijfsobject_status = typeof v.status === "string" ? v.status : null;
          const voPandIds = Array.isArray(v.maaktDeelUitVan)
            ? v.maaktDeelUitVan.filter((p): p is string => typeof p === "string")
            : [];
          if (voPandIds.length > 0) {
            detail.pand_ids = dedupe([...detail.pand_ids, ...voPandIds]);
          }
        }
      } catch (err) {
        notes.push(`BAG verblijfsobject-lookup mislukt: ${(err as Error).message}`);
      }
    } else {
      notes.push("Geen adresseerbaarobject_id uit Locatieserver; verblijfsobject-detail overgeslagen.");
    }

    let pandHit = false;
    const firstPand = detail.pand_ids[0];
    if (firstPand) {
      try {
        const pand = await this.getPand(firstPand, apiKey);
        endpoints.push(pand.endpoint);
        const p = pand.data.pand;
        if (p) {
          pandHit = true;
          const bj =
            typeof p.oorspronkelijkBouwjaar === "number"
              ? p.oorspronkelijkBouwjaar
              : typeof p.oorspronkelijkBouwjaar === "string"
              ? Number(p.oorspronkelijkBouwjaar)
              : NaN;
          detail.bouwjaar = Number.isFinite(bj) ? (bj as number) : null;
          detail.pand_status = typeof p.status === "string" ? p.status : null;
        }
      } catch (err) {
        notes.push(`BAG pand-lookup mislukt: ${(err as Error).message}`);
      }
    } else if (!detail.verblijfsobject_id) {
      notes.push("Geen pand-id beschikbaar; bouwjaar niet opgehaald.");
    }

    if (voHit && pandHit) detail.data_kwaliteit = "hard";
    else if (voHit || pandHit) detail.data_kwaliteit = "partial";
    else detail.data_kwaliteit = "lookup_only";

    return { detail, endpoints };
  }
}

function normalizePandIds(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.filter((x): x is string => typeof x === "string" && x.length > 0);
  }
  if (typeof input === "string" && input.length > 0) return [input];
  return [];
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
