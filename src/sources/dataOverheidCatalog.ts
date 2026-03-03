import { loadConfig } from "../config.js";
import { DataOverheidSource } from "./data-overheid.js";

type Citation = {
  source: "data.overheid.nl";
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
  const src = new DataOverheidSource(cfg);
  const out = await src.datasetsSearch({ query, rows: 5 });
  return {
    data: out.items,
    citations: [
      {
        source: "data.overheid.nl",
        title: "data.overheid.nl",
        url: out.endpoint || "https://data.overheid.nl",
        retrievedAt: new Date().toISOString(),
      },
    ],
  };
}
