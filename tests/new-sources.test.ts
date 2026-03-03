import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { PdokSource } from "../src/sources/pdok.js";
import { OriSource } from "../src/sources/ori.js";
import { NdwSource } from "../src/sources/ndw.js";
import { LuchtmeetnetSource } from "../src/sources/luchtmeetnet.js";
import { RechtspraakSource } from "../src/sources/rechtspraak.js";
import { RivmSource } from "../src/sources/rivm.js";
import { SparqlLinkedDataSource } from "../src/sources/sparql-linked-data.js";
import { EurostatSource } from "../src/sources/eurostat.js";
import { DataEuropaSource } from "../src/sources/data-europa.js";
import { RdwSource } from "../src/sources/rdw.js";

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
    expect(out.items[0].component).toBe("no2");
    expect(out.items[0].timestamp).toBe("1970-01-01T00:00:00Z");
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

  it("rivm fallback is deterministic", () => {
    const src = new RivmSource(config);
    const out = src.fallback({ query: "lucht", rows: 1 });
    expect(out.items.length).toBe(1);
    expect(String(out.items[0].id)).toContain("rivm-fallback-lucht");
  });

  it("sparql fallback and guardrails work", async () => {
    const src = new SparqlLinkedDataSource(config, "https://example.org/sparql", "Example");
    const fallback = src.fallback({ query: "SELECT * WHERE { ?s ?p ?o }", limit: 1 });
    expect(fallback.items.length).toBe(1);

    await expect(src.select({ query: "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }", limit: 10 })).rejects.toThrow(/SELECT/i);
    await expect(src.select({ query: "SELECT * WHERE { ?s ?p ?o } DELETE { ?s ?p ?o }", limit: 10 })).rejects.toThrow(/niet toegestaan/i);
  });

  it("eurostat and data-europa fallbacks are deterministic", () => {
    const eurostat = new EurostatSource(config);
    const euroOut = eurostat.searchFallback({ query: "population", rows: 2 });
    expect(euroOut.items.length).toBeGreaterThan(0);

    const deu = new DataEuropaSource(config);
    const deuOut = deu.fallback({ query: "climate", rows: 1 });
    expect(String(deuOut.items[0].id)).toContain("data-europa-fallback-climate");
  });

  it("rdw fallback is deterministic", () => {
    const rdw = new RdwSource(config);
    const out = rdw.fallback({ query: "toyota", rows: 1 });
    expect(String(out.items[0].id)).toContain("rdw-fallback-toyota");
  });
});
