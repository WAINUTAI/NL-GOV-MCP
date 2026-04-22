import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

interface LocatieserverDoc {
  id?: string;
  weergavenaam?: string;
  type?: string;
  woonplaatsnaam?: string;
  gemeentenaam?: string;
  provinciecode?: string;
  provincieafkorting?: string;
  straatnaam?: string;
  huisnummer?: string | number;
  postcode?: string;
  centroide_ll?: string;
  centroide_rd?: string;
  score?: number;
  [key: string]: unknown;
}

interface LocatieserverResponse {
  response?: {
    docs?: LocatieserverDoc[];
    numFound?: number;
  };
}

const PDOK_LOCATIESERVER = "https://api.pdok.nl/bzk/locatieserver/search/v3_1";

export class PdokSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: { query: string; rows: number }) {
    const params = {
      q: args.query,
      rows: String(args.rows),
      fl: "id,weergavenaam,type,woonplaatsnaam,gemeentenaam,provinciecode,provincieafkorting,centroide_ll,centroide_rd,score",
    };

    const endpoint = `${PDOK_LOCATIESERVER}/free`;
    const { data, meta } = await getJson<LocatieserverResponse>(endpoint, { query: params });
    return {
      items: data.response?.docs ?? [],
      total: data.response?.numFound ?? 0,
      endpoint: meta.url,
      params,
    };
  }

  async bagLookupAddress(args: {
    query?: string;
    postcode?: string;
    huisnummer?: string;
    rows: number;
  }) {
    const q = args.query?.trim() || `${args.postcode ?? ""} ${args.huisnummer ?? ""}`.trim();
    const params = {
      q,
      rows: String(args.rows),
      fq: "type:adres",
      fl: "id,weergavenaam,type,straatnaam,huisnummer,postcode,woonplaatsnaam,gemeentenaam,centroide_ll,centroide_rd,score",
    };

    const endpoint = `${PDOK_LOCATIESERVER}/free`;
    const { data, meta } = await getJson<LocatieserverResponse>(endpoint, { query: params });

    const docs = (data.response?.docs ?? []).filter((x) => {
      const postcodeOk = args.postcode
        ? String(x.postcode ?? "").replace(/\s+/g, "").toUpperCase() === args.postcode.replace(/\s+/g, "").toUpperCase()
        : true;
      const huisnummerOk = args.huisnummer ? String(x.huisnummer ?? "") === String(args.huisnummer) : true;
      return postcodeOk && huisnummerOk;
    });

    return {
      items: docs,
      total: data.response?.numFound ?? docs.length,
      endpoint: meta.url,
      params,
    };
  }

  fallbackAddress(args: { query?: string; postcode?: string; huisnummer?: string; rows: number }) {
    const base = (args.query?.trim() || `${args.postcode ?? ""} ${args.huisnummer ?? ""}`.trim() || "onbekend").toLowerCase();
    const normalized = base.replace(/\s+/g, " ").trim();
    const item: Record<string, unknown> = {
      id: `fallback-${normalized.replace(/[^a-z0-9]+/g, "-")}`,
      weergavenaam: `Geen live BAG-hit voor: ${normalized}`,
      type: "adres",
      confidence: "fallback",
      query: normalized,
    };

    return {
      items: [item].slice(0, args.rows),
      total: 1,
      endpoint: `${PDOK_LOCATIESERVER}/free (fallback)`,
      params: { q: normalized, rows: String(args.rows), mode: "deterministic-fallback" },
      access_note: "PDOK/BAG lookup tijdelijk onbereikbaar; deterministische fallback-record teruggegeven.",
    };
  }
}
