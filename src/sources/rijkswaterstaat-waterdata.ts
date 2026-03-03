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

const RWS_ENDPOINT = "https://waterwebservices.rijkswaterstaat.nl/METADATASERVICES_DBO/OphalenCatalogus/";

export class RijkswaterstaatWaterdataSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: { query: string; rows: number }) {
    const { data, meta } = await postJson<RwsCatalogResponse>(
      RWS_ENDPOINT,
      { CatalogusFilter: { Eenheden: true, Grootheden: true, Hoedanigheden: true } },
      { timeoutMs: 20_000, retries: 1 },
    );

    const all = Array.isArray(data.AquoMetadataLijst) ? data.AquoMetadataLijst : [];
    const q = args.query.toLowerCase();
    const items = all
      .filter((x) => `${x.Parameter_Wat_Omschrijving ?? ""} ${x.Grootheid?.Omschrijving ?? ""}`.toLowerCase().includes(q))
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
}
