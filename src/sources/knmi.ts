import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

export class KnmiSource {
  constructor(private readonly config: AppConfig, private readonly apiKey: string) {}

  async datasets() {
    const endpoint = `${this.config.endpoints.knmi}/datasets`;
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, {
      headers: { Authorization: this.apiKey },
    });
    const items = (data.datasets as Array<Record<string, unknown>> | undefined) ?? [];
    return { items, endpoint: meta.url, params: {} };
  }

  async latestFiles(datasetName: string, datasetVersion: string, top: number) {
    const endpoint = `${this.config.endpoints.knmi}/datasets/${datasetName}/versions/${datasetVersion}/files`;
    const params = { maxKeys: String(top) };
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, {
      query: params,
      headers: { Authorization: this.apiKey },
    });
    const items = (data.files as Array<Record<string, unknown>> | undefined) ?? [];
    return { items, endpoint: meta.url, params };
  }
}
