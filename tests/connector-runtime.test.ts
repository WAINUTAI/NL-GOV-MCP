import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getConnectorCacheTtlMs, getConnectorCategory } from "../src/utils/connector-runtime.js";

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
