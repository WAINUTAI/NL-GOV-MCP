import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

export class ApiRegisterSource {
  constructor(private readonly config: AppConfig, private readonly apiKey: string) {}

  async search(query: string, top: number) {
    const endpoint = `${this.config.endpoints.apiRegister}/api/v1/apis`;
    const params = { q: query, limit: String(top) };
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, {
      query: params,
      headers: { "X-API-Key": this.apiKey },
    });

    const items = (data.items as Array<Record<string, unknown>> | undefined) ??
      (data.apis as Array<Record<string, unknown>> | undefined) ?? [];

    return { items, endpoint: meta.url, params };
  }
}
