import { describe, it, expect } from "vitest";
import { parseXml, extractSruNumberOfRecords, extractSruRecords } from "../src/utils/xml-parser.js";

describe("xml parser", () => {
  it("extracts sru records", () => {
    const xml = `<searchRetrieveResponse><numberOfRecords>2</numberOfRecords><records><record><recordData><doc><title>A</title></doc></recordData></record><record><recordData><doc><title>B</title></doc></recordData></record></records></searchRetrieveResponse>`;
    const parsed = parseXml(xml);
    const records = extractSruRecords(parsed);
    expect(records).toHaveLength(2);
    expect(extractSruNumberOfRecords(parsed)).toBe(2);
  });
});
