import { loadConfig } from "../config.js";
import { BekendmakingenSource } from "./bekendmakingen.js";

type Citation = {
  source: "officiele_bekendmakingen";
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
  const src = new BekendmakingenSource(cfg);
  const out = await src.search({
    query,
    maximumRecords: 5,
    startRecord: 1,
  });

  return {
    data: out.items,
    citations: [
      {
        source: "officiele_bekendmakingen",
        title: "Officiële Bekendmakingen",
        url: out.endpoint || "https://zoek.officielebekendmakingen.nl",
        retrievedAt: new Date().toISOString(),
      },
    ],
  };
}
