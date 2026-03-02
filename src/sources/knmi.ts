import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

function normalize(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

export class KnmiSource {
  constructor(private readonly config: AppConfig, private readonly apiKey: string) {}

  private headers() {
    return { Authorization: this.apiKey };
  }

  async datasets() {
    const endpoint = `${this.config.endpoints.knmi}/datasets`;
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, {
      headers: this.headers(),
    });
    const items = (data.datasets as Array<Record<string, unknown>> | undefined) ?? [];
    return { items, endpoint: meta.url, params: {} };
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

  async warnings(top = 20) {
    return this.latestFiles("waarschuwingen_huidige", "1", top);
  }

  async earthquakes(top = 20) {
    return this.latestFiles("knmi_seismologie", "1", top);
  }
}
