import { describe, expect, it } from "vitest";
import type { MCPRecord } from "../src/types.js";
import { enrichRelatedLinks } from "../src/utils/cross-reference.js";

function rec(args: Partial<MCPRecord>): MCPRecord {
  return {
    source_name: args.source_name ?? "test",
    title: args.title ?? "",
    canonical_url: args.canonical_url ?? "https://example.com",
    data: args.data ?? {},
    snippet: args.snippet,
    date: args.date,
  };
}

describe("cross-reference enrichment", () => {
  it("adds references_law links for shared BWBR ids", () => {
    const records: MCPRecord[] = [
      rec({
        source_name: "tweedekamer",
        title: "Voorstel bij BWBR0005416",
        canonical_url: "https://tk.example/1",
      }),
      rec({
        source_name: "officielebekendmakingen",
        title: "Tekst BWBR0005416",
        canonical_url: "https://ob.example/1",
      }),
    ];

    const out = enrichRelatedLinks(records);
    const links = ((out[0].data ?? {}) as Record<string, unknown>).related_links as Array<Record<string, unknown>>;

    expect(Array.isArray(links)).toBe(true);
    expect(links.some((x) => x.target_connector === "officielebekendmakingen" && x.relationship === "references_law")).toBe(true);
  });

  it("adds municipality links for CBS gemeentecode", () => {
    const records: MCPRecord[] = [
      rec({
        source_name: "cbs",
        title: "Bevolking",
        data: { gemeentecode: "GM0590" },
      }),
    ];

    const out = enrichRelatedLinks(records);
    const links = ((out[0].data ?? {}) as Record<string, unknown>).related_links as Array<Record<string, unknown>>;

    expect(Array.isArray(links)).toBe(true);
    expect(links.some((x) => x.target_connector === "bag_linked_data" && x.relationship === "about_municipality")).toBe(true);
  });
});
