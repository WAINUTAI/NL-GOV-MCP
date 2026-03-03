import type { AppConfig } from "../types.js";
import { SourceRequestError, getJson } from "../utils/http.js";

function normalize(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

const KNMI_KNOWN_DATASETS: Array<Record<string, unknown>> = [
  {
    datasetName: "Actuele10mindataKNMIstations",
    version: "2",
    description: "10-minute in-situ meteorological observations (stations)",
  },
  {
    datasetName: "10-minute-in-situ-meteorological-observations",
    version: "1.0",
    description: "10-minute in-situ meteorological observations (legacy naming)",
  },
  {
    datasetName: "daggegevens_stations",
    version: "1",
    description: "Daily station weather data (historical)",
  },
  {
    datasetName: "uurgegevens_stations",
    version: "1",
    description: "Hourly station weather data",
  },
  {
    datasetName: "radar_reflectivity_composites",
    version: "1",
    description: "Radar reflectivity composites",
  },
  {
    datasetName: "waarschuwingen_huidige",
    version: "1",
    description: "Current weather warnings (dataset name may vary by platform release)",
  },
  {
    datasetName: "knmi_seismologie",
    version: "1",
    description: "Seismology / earthquakes (dataset name may vary by platform release)",
  },
];

export class KnmiSource {
  constructor(private readonly config: AppConfig, private readonly apiKey: string) {}

  private headers() {
    return { Authorization: this.apiKey };
  }

  async datasets() {
    return {
      items: KNMI_KNOWN_DATASETS,
      endpoint: "https://developer.dataplatform.knmi.nl/open-data-api (known dataset catalog)",
      params: {},
    };
  }

  async searchDatasets(query?: string) {
    const out = await this.datasets();
    const q = (query ?? "").trim().toLowerCase();
    const items = q
      ? out.items.filter((x) => {
          const hay = `${normalize(x.name)} ${normalize(x.datasetName)} ${normalize(x.description)}`;
          return q.split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
        })
      : out.items;

    return {
      items,
      endpoint: out.endpoint,
      params: { query: query ?? "" },
    };
  }

  async latestFiles(datasetName: string, datasetVersion: string, top: number) {
    const endpoint = `${this.config.endpoints.knmi}/datasets/${datasetName}/versions/${datasetVersion}/files`;
    const params = { maxKeys: String(top) };
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, {
      query: params,
      headers: this.headers(),
    });
    const items = (data.files as Array<Record<string, unknown>> | undefined) ?? [];
    return { items, endpoint: meta.url, params };
  }

  async fileDownloadUrl(datasetName: string, datasetVersion: string, filename: string) {
    const endpoint = `${this.config.endpoints.knmi}/datasets/${datasetName}/versions/${datasetVersion}/files/${filename}/url`;
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, {
      headers: this.headers(),
    });

    return {
      item: {
        datasetName,
        datasetVersion,
        filename,
        temporaryDownloadUrl: data.temporaryDownloadUrl,
      },
      endpoint: meta.url,
      params: { datasetName, datasetVersion, filename },
    };
  }

  async latestObservations(top = 20) {
    return this.latestFiles("Actuele10mindataKNMIstations", "2", top);
  }

  private async discoverByTerms(terms: string[]): Promise<Array<{ datasetName: string; version: string }>> {
    const out = await this.datasets();
    const found = out.items
      .map((x) => ({
        datasetName: String(x.datasetName ?? x.name ?? ""),
        version: String(x.version ?? "1"),
        text: `${normalize(x.datasetName)} ${normalize(x.name)} ${normalize(x.description)}`,
      }))
      .filter((x) => x.datasetName && terms.some((t) => x.text.includes(t)));

    return found.map(({ datasetName, version }) => ({ datasetName, version }));
  }

  private async firstWorkingDataset(
    candidates: Array<{ datasetName: string; version: string }>,
    top: number,
  ) {
    let lastError: unknown;
    const attempted: string[] = [];

    for (const c of candidates) {
      attempted.push(`${c.datasetName}@${c.version}`);
      try {
        const out = await this.latestFiles(c.datasetName, c.version, top);
        return {
          ...out,
          access_note: undefined,
          attempted,
        };
      } catch (error) {
        lastError = error;
        if (error instanceof SourceRequestError && error.status === 404) {
          continue;
        }
      }
    }

    return {
      items: [],
      endpoint:
        "https://developer.dataplatform.knmi.nl/open-data-api (no matching warning/earthquake dataset found)",
      params: { attempted: attempted.join(","), top: String(top) },
      access_note:
        "KNMI dataset voor deze categorie lijkt momenteel niet publiek vindbaar via bekende datasetnamen. Gebruik knmi_datasets/knmi_search_datasets om actuele namen te verifiëren.",
      lastError,
    };
  }

  async warnings(top = 20) {
    const discovered = await this.discoverByTerms(["waarschu", "warning", "alert"]);
    return this.firstWorkingDataset(
      [
        { datasetName: "waarschuwingen_huidige", version: "1" },
        { datasetName: "weather-warnings", version: "1" },
        { datasetName: "weather_warnings", version: "1" },
        ...discovered,
      ],
      top,
    );
  }

  async earthquakes(top = 20) {
    const discovered = await this.discoverByTerms(["seismo", "earthquake", "aardbeving"]);
    return this.firstWorkingDataset(
      [
        { datasetName: "knmi_seismologie", version: "1" },
        { datasetName: "earthquakes", version: "1" },
        { datasetName: "seismology", version: "1" },
        ...discovered,
      ],
      top,
    );
  }
}
