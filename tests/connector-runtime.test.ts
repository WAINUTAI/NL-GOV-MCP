import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clearHttpCache, getConnectorCacheTtlMs, getConnectorCategory, getHttpCache, getHttpCacheStats, setHttpCache } from "../src/utils/connector-runtime.js";
import { SourceRequestError } from "../src/utils/http.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Connector names the code passes to the HTTP layer: `connector: "x"` and `const ..._CONNECTOR = "x"`. */
function connectorNamesInSource(): string[] {
  const names = new Set<string>();
  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
  for (const file of files) {
    const text = readFileSync(join(SRC, file), "utf8");
    for (const m of text.matchAll(/\bconnector:\s*"([a-z0-9_]+)"/g)) names.add(m[1]);
    for (const m of text.matchAll(/\bconst\s+[A-Z_]*CONNECTOR[A-Z_]*\s*=\s*"([a-z0-9_]+)"/g)) names.add(m[1]);
  }
  return [...names].sort();
}

describe("connector categories", () => {
  it("gives the Algoritmeregister the catalogue (discovery) cache lifetime", () => {
    expect(getConnectorCategory("algoritmeregister")).toBe("discovery");
    expect(getConnectorCacheTtlMs("algoritmeregister")).toBe(30 * 60 * 1000);
  });

  it("gives TenderNed's deadline rechecks the category of TenderNed itself", () => {
    expect(getConnectorCategory("tenderned_recheck")).toBe(getConnectorCategory("tenderned"));
    expect(getConnectorCategory("tenderned_recheck")).toBe("semi_live");
  });

  it("files TOOI organisation metadata as static", () => {
    expect(getConnectorCategory("tooi_sparql")).toBe("static");
  });

  it("falls back to 'other' for an unknown connector", () => {
    expect(getConnectorCategory("no_such_connector")).toBe("other");
  });

  it("has a category for every connector name the sources use", () => {
    const names = connectorNamesInSource();
    // The scan itself must see the connectors, or this test proves nothing.
    expect(names).toEqual(expect.arrayContaining(["algoritmeregister", "tenderned", "tenderned_recheck", "luchtmeetnet_lki"]));
    expect(names.filter((n) => getConnectorCategory(n) === "other")).toEqual([]);
  });
});

describe("shared HTTP response cache", () => {
  const MB = 1024 * 1024;

  it("keeps the cached bodies within a byte budget, oldest out first, and never caches a huge body", () => {
    clearHttpCache();
    setHttpCache("huge", "x", 60_000, "ori", 10 * MB);
    expect(getHttpCache("huge")).toBeUndefined();
    for (let i = 0; i < 20; i++) setHttpCache(`doc-${i}`, i, 60_000, "ori", 4 * MB);
    const stats = getHttpCacheStats();
    expect(stats.bytes).toBeLessThanOrEqual(64 * MB);
    expect(getHttpCache("doc-0")).toBeUndefined();
    expect(getHttpCache("doc-19")?.value).toBe(19);
    // Replacing an entry counts its size once.
    setHttpCache("doc-19", 19, 60_000, "ori", 4 * MB);
    expect(getHttpCacheStats().bytes).toBe(stats.bytes);
    clearHttpCache();
    expect(getHttpCacheStats()).toEqual({ entries: 0, bytes: 0 });
  });
});

describe("SourceRequestError", () => {
  it("cuts a giant endpoint URL instead of echoing it in error details", () => {
    const url = `https://example.org/search?q=${"w".repeat(10_000)}`;
    const error = new SourceRequestError({ message: "failed", endpoint: url, code: "http_error", status: 414 });
    expect(error.endpoint.length).toBeLessThan(600);
    expect(error.endpoint.startsWith("https://example.org/search?q=www")).toBe(true);
    expect(error.endpoint).toContain(`(${url.length} tekens)`);
  });
});
