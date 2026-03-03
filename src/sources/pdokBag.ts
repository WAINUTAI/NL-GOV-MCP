import { loadConfig } from "../config.js";
import { PdokSource } from "./pdok.js";

type Citation = {
  source: "pdok_bag";
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
  const src = new PdokSource(cfg);
  const out = await src.bagLookupAddress({ query, rows: 5 });
  return {
    data: out.items,
    citations: [
      {
        source: "pdok_bag",
        title: "BAG via PDOK",
        url: out.endpoint || "https://api.pdok.nl",
        retrievedAt: new Date().toISOString(),
      },
    ],
  };
}
