import type { AppConfig } from "../types.js";
import { getText } from "../utils/http.js";
import { extractSruNumberOfRecords, extractSruRecords, parseXml } from "../utils/xml-parser.js";

export class BekendmakingenSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: { query: string; maximumRecords: number; startRecord?: number }) {
    const endpoint = this.config.endpoints.bekendmakingenSru;
    const params: Record<string, string | number> = {
      operation: "searchRetrieve",
      version: "1.2",
      "x-connection": "officielepublicaties",
      query: args.query,
      maximumRecords: args.maximumRecords,
      startRecord: args.startRecord ?? 1,
    };

    const { data, meta } = await getText(endpoint, { query: params });
    const parsed = parseXml(data);
    const records = extractSruRecords(parsed);
    const total = extractSruNumberOfRecords(parsed);
    return { items: records, total, endpoint: meta.url, params: Object.fromEntries(Object.entries(params).map(([k,v])=>[k,String(v)])) };
  }
}
