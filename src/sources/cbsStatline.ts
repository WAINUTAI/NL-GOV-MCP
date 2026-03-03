import { loadConfig } from "../config.js";
import { CbsSource } from "./cbs.js";

type Citation = {
  source: "cbs_statline";
  title: string;
  url: string;
  retrievedAt: string;
  excerpt?: string;
};

export async function search(query: string): Promise<{
  data: unknown;
  citations: Citation[];
}> {
  const cfg = loadConfig();
  const src = new CbsSource(cfg);
  const out = await src.searchTables(query, 5);
  return {
    data: out.items,
    citations: [
      {
        source: "cbs_statline",
        title: "CBS StatLine",
        url: out.endpoint || "https://opendata.cbs.nl",
        retrievedAt: new Date().toISOString(),
      },
    ],
  };
}
