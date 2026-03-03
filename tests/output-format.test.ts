import { describe, expect, it } from "vitest";
import { applyOutputFormat, paginateRecords } from "../src/utils/output-format.js";
import type { MCPRecord } from "../src/types.js";

function rec(data: Record<string, unknown>): MCPRecord {
  return {
    source_name: "test",
    title: "title",
    canonical_url: "https://example.com",
    data,
  };
}

describe("output format helpers", () => {
  it("renders csv", () => {
    const out = applyOutputFormat({
      records: [rec({ id: 1, name: "alpha" })],
      outputFormat: "csv",
    });

    expect(out.output_format).toBe("csv");
    expect(typeof out.formatted_output).toBe("string");
    expect(String(out.formatted_output)).toContain("data.id");
    expect(String(out.formatted_output)).toContain("alpha");
  });

  it("renders geojson when coordinates exist", () => {
    const out = applyOutputFormat({
      records: [rec({ latitude: 52.08, longitude: 4.31 })],
      outputFormat: "geojson",
    });

    expect(out.output_format).toBe("geojson");
    const geo = out.formatted_output as Record<string, unknown>;
    expect(geo.type).toBe("FeatureCollection");
  });

  it("falls back to json for geojson without location", () => {
    const out = applyOutputFormat({
      records: [rec({ id: 123 })],
      outputFormat: "geojson",
    });

    expect(out.output_format).toBe("json");
    expect(out.access_note).toContain("fallback naar json");
  });

  it("paginates records", () => {
    const out = paginateRecords([1, 2, 3, 4], { offset: 1, limit: 2, total: 4 });
    expect(out.page).toEqual([2, 3]);
    expect(out.pagination.has_more).toBe(true);
    expect(out.pagination.total).toBe(4);
  });
});
