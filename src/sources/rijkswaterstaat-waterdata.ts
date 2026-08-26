import type { AppConfig } from "../types.js";
import { postJson } from "../utils/http.js";

const RWS_BASE = "https://ddapi20-waterwebservices.rijkswaterstaat.nl";
const RWS_CATALOG_ENDPOINT = RWS_BASE + "/METADATASERVICES/OphalenCatalogus";
const RWS_LATEST_ENDPOINT = RWS_BASE + "/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen";

const HTTP_OPTS = { timeoutMs: 25_000, retries: 2, connector: "rws_waterdata" } as const;
const CATALOG_CACHE_MS = 60 * 60 * 1000; // catalog is quasi-static; override the 2-min "live" TTL
const MAX_LOCATIONS = 25; // cap locations sent per latest-observations request

/** Accent/space-insensitive key for matching place names and station codes. */
function norm(s: string): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Reference stations used when the user gives no explicit location. */
const PRIORITY_STATIONS = [
  "hoek van holland",
  "ijmuiden",
  "vlissingen",
  "den helder",
  "harlingen",
  "delfzijl",
  "scheveningen",
  "lobith",
  "maassluis",
  "dordrecht",
  "rotterdam",
  "terneuzen",
];

/**
 * Map user-friendly keywords to RWS Grootheid codes. Iterate in insertion
 * order (specific keywords first) and match with `query.includes(keyword)`.
 * These codes were live-verified against the new (WADAR) catalog; the old
 * GOLHTE/STRMDg codes no longer exist.
 */
const MEASUREMENT_TYPES: Record<string, { code: string; label: string }> = {
  waterhoogte: { code: "WATHTE", label: "Waterhoogte" },
  waterstand: { code: "WATHTE", label: "Waterhoogte" },
  waterlevel: { code: "WATHTE", label: "Waterhoogte" },
  waterdiepte: { code: "WATDTE", label: "Waterdiepte" },
  golfhoogte: { code: "Hm0", label: "Significante golfhoogte" },
  golven: { code: "Hm0", label: "Significante golfhoogte" },
  debiet: { code: "Q", label: "Debiet" },
  afvoer: { code: "Q", label: "Debiet" },
  stroomsnelheid: { code: "STROOMSHD", label: "Stroomsnelheid" },
  stroomrichting: { code: "STROOMRTG", label: "Stroomrichting" },
  stroming: { code: "STROOMSHD", label: "Stroomsnelheid" },
  temperatuur: { code: "T", label: "Temperatuur" },
  windsnelheid: { code: "WINDSHD", label: "Windsnelheid" },
  windrichting: { code: "WINDRTG", label: "Windrichting" },
  doorzicht: { code: "ZICHT", label: "Doorzicht" },
  zicht: { code: "ZICHT", label: "Doorzicht" },
};

/** Regex that strips known measurement keywords, leaving the place-name. */
const MEASUREMENT_KEYWORD_RE = new RegExp(
  `\\b(${Object.keys(MEASUREMENT_TYPES).join("|")})\\b`,
  "gi",
);

function resolveGrootheidCode(query: string): { code: string; label: string } {
  const q = query.toLowerCase();
  for (const [keyword, entry] of Object.entries(MEASUREMENT_TYPES)) {
    if (q.includes(keyword)) return entry;
  }
  // Default to water level – the most common measurement type.
  return { code: "WATHTE", label: "Waterhoogte" };
}

interface RwsCatalogAquoItem {
  AquoMetadata_MessageID?: number;
  Parameter_Wat_Omschrijving?: string;
  Grootheid?: { Code?: string; Omschrijving?: string };
  Eenheid?: { Code?: string; Omschrijving?: string };
  Hoedanigheid?: { Code?: string; Omschrijving?: string };
  [key: string]: unknown;
}

interface RwsCatalogLocation {
  Locatie_MessageID?: number;
  Code?: string;
  Naam?: string;
  Lat?: number;
  Lon?: number;
  Coordinatenstelsel?: string;
  Omschrijving?: string;
  [key: string]: unknown;
}

interface RwsCatalogMetaLocatie {
  // NB: capital "D" in Data — differs from AquoMetadata_MessageID in the item list.
  AquoMetaData_MessageID?: number;
  Locatie_MessageID?: number;
  [key: string]: unknown;
}

interface RwsCatalogResponse {
  Succesvol?: boolean;
  Foutmelding?: string;
  AquoMetadataLijst?: RwsCatalogAquoItem[];
  LocatieLijst?: RwsCatalogLocation[];
  AquoMetadataLocatieLijst?: RwsCatalogMetaLocatie[];
  [key: string]: unknown;
}

interface RwsLatestMeting {
  Tijdstip?: string;
  Meetwaarde?: { Waarde_Numeriek?: number; Waarde_Alfanumeriek?: string; [key: string]: unknown };
  WaarnemingMetadata?: {
    // New API: singular strings, not the old *Lijst arrays.
    Kwaliteitswaardecode?: string;
    Statuswaarde?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface RwsLatestObservation {
  AquoMetadata?: {
    Grootheid?: { Code?: string; Omschrijving?: string };
    Eenheid?: { Code?: string; Omschrijving?: string };
    Hoedanigheid?: { Code?: string; Omschrijving?: string };
    [key: string]: unknown;
  };
  Locatie?: {
    Code?: string;
    Naam?: string;
    Lat?: number;
    Lon?: number;
    Coordinatenstelsel?: string;
    Omschrijving?: string;
    [key: string]: unknown;
  };
  MetingenLijst?: RwsLatestMeting[];
  [key: string]: unknown;
}

interface RwsLatestResponse {
  Succesvol?: boolean;
  Foutmelding?: string;
  WaarnemingenLijst?: RwsLatestObservation[];
  [key: string]: unknown;
}

export class RijkswaterstaatWaterdataSource {
  constructor(private readonly config: AppConfig) {}

  /** Fetch the RWS metadata catalog (cached; quasi-static). */
  private async fetchCatalog(withLocations: boolean) {
    const body = {
      CatalogusFilter: {
        Grootheden: true,
        Eenheden: true,
        Hoedanigheden: true,
        ...(withLocations ? { Locaties: true } : {}),
      },
    };
    return postJson<RwsCatalogResponse>(RWS_CATALOG_ENDPOINT, body, {
      ...HTTP_OPTS,
      cacheTtlMs: CATALOG_CACHE_MS,
    });
  }

  /** Search the RWS metadata catalog for available parameters. */
  async search(args: { query: string; rows: number }) {
    const { data, meta } = await this.fetchCatalog(false);

    const all = Array.isArray(data.AquoMetadataLijst) ? data.AquoMetadataLijst : [];
    const tokens = args.query.toLowerCase().split(/\s+/).filter(Boolean);

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
        unit_description: x.Eenheid?.Omschrijving,
        category: x.Grootheid?.Omschrijving,
        grootheid_code: x.Grootheid?.Code,
        quality: x.Hoedanigheid?.Omschrijving,
        quality_code: x.Hoedanigheid?.Code,
        url: "https://waterinfo.rws.nl",
      }));

    return {
      items,
      // Upstream levert geen count; null i.p.v. de paginagrootte, zodat een
      // consument "x van y" niet met een verzonnen y toont.
      total: null,
      endpoint: meta.url,
      params: { q: args.query, rows: String(args.rows) },
      ...(items.length
        ? {}
        : { access_note: "Catalogus live bereikbaar, maar geen match op query." }),
    };
  }

  /**
   * Fetch latest measurements from RWS via OphalenLaatsteWaarnemingen.
   * Resolves the requested measurement type + location(s) against the catalog,
   * then queries only the relevant stations (the API requires an explicit
   * LocatieLijst).
   */
  async latestMeasurements(args: { query: string; rows: number }) {
    const { code, label } = resolveGrootheidCode(args.query);

    const { data: cat } = await this.fetchCatalog(true);

    const aquoList = Array.isArray(cat.AquoMetadataLijst) ? cat.AquoMetadataLijst : [];
    const locationList = Array.isArray(cat.LocatieLijst) ? cat.LocatieLijst : [];
    const mapping = Array.isArray(cat.AquoMetadataLocatieLijst)
      ? cat.AquoMetadataLocatieLijst
      : [];

    // AquoMetadata_MessageIDs whose Grootheid matches the requested code.
    const metaIds = new Set<number>();
    for (const m of aquoList) {
      if (m.Grootheid?.Code === code && typeof m.AquoMetadata_MessageID === "number") {
        metaIds.add(m.AquoMetadata_MessageID);
      }
    }

    // Locatie_MessageIDs that support the requested measurement type.
    const locIds = new Set<number>();
    for (const link of mapping) {
      if (
        typeof link.AquoMetaData_MessageID === "number" &&
        metaIds.has(link.AquoMetaData_MessageID) &&
        typeof link.Locatie_MessageID === "number"
      ) {
        locIds.add(link.Locatie_MessageID);
      }
    }

    const candidateLocations = locationList.filter(
      (l) => typeof l.Locatie_MessageID === "number" && locIds.has(l.Locatie_MessageID),
    );

    // Place-name the user asked for (measurement keywords removed).
    const locationFilter = args.query
      .replace(MEASUREMENT_KEYWORD_RE, " ")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    let selected: RwsCatalogLocation[];
    if (locationFilter) {
      const nf = norm(locationFilter);
      const filterTokens = locationFilter
        .split(/\s+/)
        .map(norm)
        .filter(Boolean);
      // Prefer an exact station-code match first.
      const exact = candidateLocations.filter((l) => norm(l.Code ?? "") === nf);
      if (exact.length) {
        selected = exact;
      } else {
        selected = candidateLocations.filter((l) => {
          const nn = norm(l.Naam ?? "");
          const nc = norm(l.Code ?? "");
          if (nf && (nn.includes(nf) || nc.includes(nf))) return true;
          return filterTokens.some((t) => nn.includes(t) || nc.includes(t));
        });
      }
    } else {
      // No location given: prefer the priority reference stations, in order.
      const chosen: RwsCatalogLocation[] = [];
      const used = new Set<RwsCatalogLocation>();
      for (const priority of PRIORITY_STATIONS) {
        const np = norm(priority);
        const match = candidateLocations
          .filter((l) => !used.has(l))
          .filter((l) => {
            const nn = norm(l.Naam ?? "");
            const nc = norm(l.Code ?? "");
            return nn.includes(np) || nc.includes(np);
          })
          .sort((a, b) => (a.Naam ?? "").length - (b.Naam ?? "").length)[0];
        if (match) {
          chosen.push(match);
          used.add(match);
        }
      }
      for (const l of candidateLocations) {
        if (!used.has(l)) {
          chosen.push(l);
          used.add(l);
        }
      }
      selected = chosen;
    }

    selected = selected.slice(0, MAX_LOCATIONS);

    if (selected.length === 0) {
      return {
        items: [] as Array<Record<string, unknown>>,
        total: 0,
        totalBeforeFilter: 0,
        endpoint: RWS_LATEST_ENDPOINT,
        params: { grootheid: code, query: args.query, rows: String(args.rows) },
        access_note: locationFilter
          ? `Geen RWS-meetstation gevonden voor locatie '${locationFilter}' met meting '${label}'. Laat de locatie weg voor de belangrijkste stations.`
          : `Geen meetstations beschikbaar voor '${label}'.`,
      };
    }

    const body = {
      LocatieLijst: selected.map((l) => ({
        Code: l.Code,
        X: l.Lon,
        Y: l.Lat,
        Coordinatenstelsel: "ETRS89",
      })),
      AquoPlusWaarnemingMetadataLijst: [{ AquoMetadata: { Grootheid: { Code: code } } }],
    };

    const { data: obsData, meta } = await postJson<RwsLatestResponse>(
      RWS_LATEST_ENDPOINT,
      body,
      HTTP_OPTS,
    );

    if (obsData.Succesvol === false) {
      return {
        items: [] as Array<Record<string, unknown>>,
        total: 0,
        totalBeforeFilter: 0,
        endpoint: meta.url,
        params: { grootheid: code, query: args.query, rows: String(args.rows) },
        access_note: obsData.Foutmelding
          ? `RWS fout: ${obsData.Foutmelding}`
          : "RWS heeft geen resultaten geretourneerd.",
      };
    }

    const observations = Array.isArray(obsData.WaarnemingenLijst)
      ? obsData.WaarnemingenLijst
      : [];

    const items = observations.map((obs) => {
      const list = obs.MetingenLijst;
      const latest = Array.isArray(list) ? list[list.length - 1] : undefined;
      return {
        location_code: obs.Locatie?.Code ?? "",
        location_name: obs.Locatie?.Naam ?? "",
        lat: obs.Locatie?.Lat,
        lon: obs.Locatie?.Lon,
        measurement_type: label,
        grootheid_code: code,
        reference: obs.AquoMetadata?.Hoedanigheid?.Omschrijving ?? "",
        value: latest?.Meetwaarde?.Waarde_Numeriek ?? null,
        value_text: latest?.Meetwaarde?.Waarde_Alfanumeriek ?? null,
        unit: obs.AquoMetadata?.Eenheid?.Code ?? "",
        unit_description: obs.AquoMetadata?.Eenheid?.Omschrijving ?? "",
        timestamp: latest?.Tijdstip ?? "",
        quality: latest?.WaarnemingMetadata?.Kwaliteitswaardecode ?? "",
        status: latest?.WaarnemingMetadata?.Statuswaarde ?? "",
        url: "https://waterinfo.rws.nl",
      };
    });

    // Freshest first: inactive stations return stale last-values.
    items.sort((a, b) => {
      const ta = Date.parse(String(a.timestamp || ""));
      const tb = Date.parse(String(b.timestamp || ""));
      const va = Number.isNaN(ta) ? -Infinity : ta;
      const vb = Number.isNaN(tb) ? -Infinity : tb;
      return vb - va;
    });

    const sliced = items.slice(0, args.rows);

    return {
      items: sliced,
      total: sliced.length,
      totalBeforeFilter: observations.length,
      endpoint: meta.url,
      params: { grootheid: code, query: args.query, rows: String(args.rows) },
      ...(observations.length === 0
        ? { access_note: `Geen actuele waarnemingen voor '${label}' op de geselecteerde stations.` }
        : {}),
    };
  }
}
