import type { AppConfig } from "../types.js";
import { postJson } from "../utils/http.js";

interface RwsCatalogItem {
  AquoMetadata_MessageID?: number;
  Parameter_Wat_Omschrijving?: string;
  Eenheid?: { Code?: string; Omschrijving?: string };
  Grootheid?: { Code?: string; Omschrijving?: string };
  Hoedanigheid?: { Code?: string; Omschrijving?: string };
  [key: string]: unknown;
}

interface RwsCatalogResponse {
  AquoMetadataLijst?: RwsCatalogItem[];
  Succesvol?: boolean;
  Foutmelding?: string;
}

interface RwsMeasurement {
  Tijdstip?: string;
  Meetwaarde?: { Waarde_Numeriek?: number; Waarde_Alfanumeriek?: string };
  WaarnemingMetadata?: { StatuswaardeLijst?: string[]; KwaliteitswaardecodeLijst?: string[] };
  [key: string]: unknown;
}

interface RwsObservation {
  Locatie?: { Code?: string; Naam?: string; X?: number; Y?: number; [key: string]: unknown };
  MetingenLijst?: RwsMeasurement[];
  AquoMetadata?: {
    Grootheid?: { Code?: string; Omschrijving?: string };
    Eenheid?: { Code?: string; Omschrijving?: string };
    Hoedanigheid?: { Code?: string; Omschrijving?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface RwsObservationsResponse {
  WaarnemingenLijst?: RwsObservation[];
  Succesvol?: boolean;
  Foutmelding?: string;
}

const RWS_CATALOG_ENDPOINT =
  "https://waterwebservices.rijkswaterstaat.nl/METADATASERVICES_DBO/OphalenCatalogus/";
const RWS_LATEST_ENDPOINT =
  "https://waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES_DBO/OphalenLaatsteWaarnemingen/";

const HTTP_OPTS = { timeoutMs: 25_000, retries: 2 };

/** Map user-friendly keywords to RWS Grootheid codes. */
const MEASUREMENT_TYPES: Record<string, { code: string; label: string }> = {
  waterstand:  { code: "WATHTE",    label: "Waterhoogte" },
  waterhoogte: { code: "WATHTE",    label: "Waterhoogte" },
  waterlevel:  { code: "WATHTE",    label: "Waterhoogte" },
  golfhoogte:  { code: "GOLHTE",    label: "Golfhoogte" },
  golven:      { code: "GOLHTE",    label: "Golfhoogte" },
  debiet:      { code: "Q",         label: "Debiet" },
  afvoer:      { code: "Q",         label: "Debiet" },
  stroming:    { code: "STRMDg",    label: "Stroomsnelheid" },
  stroomsnelheid: { code: "STRMDG", label: "Stroomsnelheid" },
  temperatuur: { code: "T",         label: "Temperatuur" },
  windsnelheid:{ code: "WINDSHD",   label: "Windsnelheid" },
  windrichting:{ code: "WINDRTG",   label: "Windrichting" },
  zicht:       { code: "ZICHT",     label: "Zicht" },
};

function resolveGrootheidCode(query: string): { code: string; label: string } {
  const q = query.toLowerCase().trim();
  for (const [keyword, entry] of Object.entries(MEASUREMENT_TYPES)) {
    if (q.includes(keyword)) return entry;
  }
  // Default to water level – the most common measurement type
  return { code: "WATHTE", label: "Waterhoogte" };
}

export class RijkswaterstaatWaterdataSource {
  constructor(private readonly config: AppConfig) {}

  /** Search the RWS metadata catalog for available parameters. */
  async search(args: { query: string; rows: number }) {
    const { data, meta } = await postJson<RwsCatalogResponse>(
      RWS_CATALOG_ENDPOINT,
      { CatalogusFilter: { Eenheden: true, Grootheden: true, Hoedanigheden: true } },
      HTTP_OPTS,
    );

    const all = Array.isArray(data.AquoMetadataLijst) ? data.AquoMetadataLijst : [];
    const q = args.query.toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    const items = all
      .filter((x) => {
        const hay = `${x.Parameter_Wat_Omschrijving ?? ""} ${x.Grootheid?.Omschrijving ?? ""}`.toLowerCase();
        return tokens.some((t) => hay.includes(t));
      })
      .slice(0, args.rows)
      .map((x) => ({
        id: String(x.AquoMetadata_MessageID ?? ""),
        title: String(x.Parameter_Wat_Omschrijving ?? "RWS parameter"),
        unit: x.Eenheid?.Code,
        category: x.Grootheid?.Omschrijving,
        quality: x.Hoedanigheid?.Omschrijving,
        url: "https://waterinfo.rws.nl",
        ...x,
      }));

    return {
      items,
      total: items.length,
      endpoint: meta.url,
      params: { q: args.query, rows: String(args.rows) },
      ...(items.length ? {} : { access_note: "Catalogus live bereikbaar, maar geen match op query." }),
    };
  }

  /**
   * Fetch latest measurements from RWS.
   * Uses the OphalenLaatsteWaarnemingen endpoint for real-time observation data.
   */
  async latestMeasurements(args: { query: string; rows: number }) {
    const { code, label } = resolveGrootheidCode(args.query);

    const body = {
      AquoPlusWaarnemingMetadataLijst: [
        {
          AquoMetadata: {
            Grootheid: { Code: code },
          },
        },
      ],
    };

    const { data, meta } = await postJson<RwsObservationsResponse>(
      RWS_LATEST_ENDPOINT,
      body,
      HTTP_OPTS,
    );

    if (data.Succesvol === false) {
      return {
        items: [] as Array<Record<string, unknown>>,
        total: 0,
        totalBeforeFilter: 0,
        endpoint: meta.url,
        params: { grootheid: code, query: args.query, rows: String(args.rows) },
        access_note: data.Foutmelding
          ? `RWS fout: ${data.Foutmelding}`
          : "RWS heeft geen resultaten geretourneerd.",
      };
    }

    const observations = Array.isArray(data.WaarnemingenLijst) ? data.WaarnemingenLijst : [];

    // Filter by location name if query contains a place name (after removing known measurement keywords)
    const locationFilter = args.query
      .toLowerCase()
      .replace(/\b(waterstand|waterhoogte|golfhoogte|debiet|afvoer|temperatuur|windsnelheid|windrichting|stroming|golven)\b/g, "")
      .trim();

    const filtered = locationFilter
      ? observations.filter((obs) => {
          const locName = `${obs.Locatie?.Naam ?? ""} ${obs.Locatie?.Code ?? ""}`.toLowerCase();
          return locationFilter.split(/\s+/).filter(Boolean).some((t) => locName.includes(t));
        })
      : observations;

    const items = filtered.slice(0, args.rows).map((obs) => {
      const latest = obs.MetingenLijst?.[obs.MetingenLijst.length - 1];
      return {
        location_code: obs.Locatie?.Code ?? "",
        location_name: obs.Locatie?.Naam ?? "",
        x: obs.Locatie?.X,
        y: obs.Locatie?.Y,
        measurement_type: label,
        grootheid_code: code,
        value: latest?.Meetwaarde?.Waarde_Numeriek ?? null,
        value_text: latest?.Meetwaarde?.Waarde_Alfanumeriek ?? null,
        unit: obs.AquoMetadata?.Eenheid?.Code ?? "",
        unit_description: obs.AquoMetadata?.Eenheid?.Omschrijving ?? "",
        timestamp: latest?.Tijdstip ?? "",
        quality: latest?.WaarnemingMetadata?.KwaliteitswaardecodeLijst?.join(", ") ?? "",
        status: latest?.WaarnemingMetadata?.StatuswaardeLijst?.join(", ") ?? "",
        url: "https://waterinfo.rws.nl",
      };
    });

    return {
      items,
      total: items.length,
      totalBeforeFilter: observations.length,
      endpoint: meta.url,
      params: { grootheid: code, query: args.query, rows: String(args.rows) },
      ...(items.length === 0 && observations.length > 0
        ? { access_note: `${observations.length} meetpunten gevonden maar geen match op locatie '${locationFilter}'. Laat de locatie weg om alle stations te zien.` }
        : {}),
    };
  }
}
