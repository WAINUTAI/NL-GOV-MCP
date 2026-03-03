import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { PdokSource } from "../src/sources/pdok.js";
import { OriSource } from "../src/sources/ori.js";
import { NdwSource } from "../src/sources/ndw.js";
import { LuchtmeetnetSource } from "../src/sources/luchtmeetnet.js";
import { RechtspraakSource } from "../src/sources/rechtspraak.js";

const config = loadConfig();

describe("new source fallbacks", () => {
  it("pdok fallback is deterministic", () => {
    const src = new PdokSource(config);
    const out = src.fallbackAddress({ query: "Damrak 1 Amsterdam", rows: 1 });
    expect(out.items.length).toBe(1);
    expect(String(out.items[0].id)).toContain("fallback-damrak-1-amsterdam");
    expect(out.access_note).toContain("fallback");
  });

  it("luchtmeetnet fallback has stable record", () => {
    const src = new LuchtmeetnetSource(config);
    const out = src.fallback({ component: "NO2", rows: 1 });
    expect(out.items[0].formula).toBe("no2");
    expect(out.items[0].timestamp_measured).toBe("1970-01-01T00:00:00Z");
  });

  it("rechtspraak fallback emits ecli", () => {
    const src = new RechtspraakSource(config);
    const out = src.fallback({ query: "ECLI:NL:HR:2024:123", rows: 1 });
    expect(String(out.items[0].ecli)).toBe("ECLI:NL:HR:2024:123");
  });

  it("ori and ndw fallback return one result", () => {
    const ori = new OriSource(config);
    const ndw = new NdwSource(config);

    const oriOut = ori.fallback({ query: "woningbouw", rows: 1, bestuurslaag: "gemeente" });
    const ndwOut = ndw.fallback({ query: "doorstroming", rows: 1 });

    expect(oriOut.items.length).toBe(1);
    expect(ndwOut.items.length).toBe(1);
  });
});
