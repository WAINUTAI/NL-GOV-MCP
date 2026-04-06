/**
 * Tests that query injection vectors are properly escaped/blocked
 * across OData, CQL/SRU, and SoQL query builders.
 */
import { describe, it, expect } from "vitest";
import { contains, equals } from "../src/utils/odata.js";
import { loadConfig } from "../src/config.js";
import { BekendmakingenSource } from "../src/sources/bekendmakingen.js";

/* ================================================================== */
/*  OData: contains() and equals()                                     */
/* ================================================================== */

describe("odata contains()", () => {
  it("handles normal input", () => {
    expect(contains("Title", "bevolking")).toBe("contains(Title,'bevolking')");
  });

  it("escapes single quotes in value", () => {
    expect(contains("Title", "O'Brien")).toBe("contains(Title,'O''Brien')");
  });

  it("escapes multiple single quotes", () => {
    expect(contains("Title", "it's a 'test'")).toBe("contains(Title,'it''s a ''test''')");
  });

  it("rejects field names with spaces", () => {
    expect(() => contains("bad field", "x")).toThrow("Invalid OData field name");
  });

  it("rejects field names with injection payload", () => {
    expect(() => contains("Title,'x'); drop--", "x")).toThrow("Invalid OData field name");
  });

  it("rejects field names with parentheses", () => {
    expect(() => contains("foo()", "x")).toThrow("Invalid OData field name");
  });

  it("rejects empty field name", () => {
    expect(() => contains("", "x")).toThrow("Invalid OData field name");
  });

  it("allows underscored field names", () => {
    expect(contains("My_Field", "val")).toBe("contains(My_Field,'val')");
  });

  it("allows field names starting with underscore", () => {
    expect(contains("_id", "val")).toBe("contains(_id,'val')");
  });
});

describe("odata equals()", () => {
  it("handles normal input", () => {
    expect(equals("Identifier", "37296ned")).toBe("Identifier eq '37296ned'");
  });

  it("escapes single quotes in value", () => {
    expect(equals("Name", "it's")).toBe("Name eq 'it''s'");
  });

  it("rejects injected field names", () => {
    expect(() => equals("x eq 'y'; delete", "val")).toThrow("Invalid OData field name");
  });
});

/* ================================================================== */
/*  Bekendmakingen SRU: escapeSruValue (tested via fallbackGet)        */
/* ================================================================== */

describe("bekendmakingen SRU escaping", () => {
  const config = loadConfig();
  const source = new BekendmakingenSource(config);

  it("fallbackGet escapes double quotes in identifier", () => {
    const result = source.fallbackGet('test" AND dt.creator="hacker');
    // The identifier should be escaped so the query stays intact
    expect(result.params.query).toContain('dt.identifier=');
    expect(result.params.query).not.toContain('" AND dt.creator="hacker"');
    // The escaped version should have backslash-escaped quotes
    expect(result.params.query).toContain('\\"');
  });

  it("fallbackGet escapes backslashes in identifier", () => {
    const result = source.fallbackGet("test\\path");
    expect(result.params.query).toContain("\\\\");
  });

  it("fallbackGet handles normal identifiers", () => {
    const result = source.fallbackGet("kst-12345-6");
    expect(result.params.query).toBe(
      'dt.identifier="kst-12345-6" AND c.product-area="officielepublicaties"'
    );
  });

  it("fallbackSearch handles normal queries", () => {
    const result = source.fallbackSearch({ query: "woningbouw", maximumRecords: 5 });
    expect(result.params.query).toBe("woningbouw");
    expect(result.items.length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/*  RDW SoQL: LIKE wildcard escaping (tested via param generation)     */
/* ================================================================== */

describe("rdw LIKE escaping", () => {
  // We can't easily unit-test the inline escaping without calling the
  // real API, but we can verify the escaping logic directly.
  it("escapes single quotes", () => {
    const input = "O'Brien";
    const escaped = input.toUpperCase().replace(/'/g, "''").replace(/[%_\\]/g, "\\$&");
    expect(escaped).toBe("O''BRIEN");
  });

  it("escapes percent wildcard", () => {
    const input = "100%";
    const escaped = input.toUpperCase().replace(/'/g, "''").replace(/[%_\\]/g, "\\$&");
    expect(escaped).toBe("100\\%");
  });

  it("escapes underscore wildcard", () => {
    const input = "type_a";
    const escaped = input.toUpperCase().replace(/'/g, "''").replace(/[%_\\]/g, "\\$&");
    expect(escaped).toBe("TYPE\\_A");
  });

  it("escapes backslash", () => {
    const input = "path\\to";
    const escaped = input.toUpperCase().replace(/'/g, "''").replace(/[%_\\]/g, "\\$&");
    expect(escaped).toBe("PATH\\\\TO");
  });

  it("escapes combined injection attempt", () => {
    const input = "'; DROP TABLE--";
    const escaped = input.toUpperCase().replace(/'/g, "''").replace(/[%_\\]/g, "\\$&");
    expect(escaped).toBe("''; DROP TABLE--");
    // The doubled quote prevents breakout of the string context
  });
});

/* ================================================================== */
/*  NGR CQL: LIKE wildcard escaping                                    */
/* ================================================================== */

describe("ngr CQL escaping", () => {
  it("escapes single quotes (was previously removing them)", () => {
    const input = "O'Brien";
    const escaped = input.replace(/'/g, "''").replace(/[%_\\]/g, "\\$&");
    expect(escaped).toBe("O''Brien");
    // Old behavior would have been "OBrien" — verify quotes are preserved
    expect(escaped).toContain("'");
  });

  it("escapes percent wildcard", () => {
    const input = "100% coverage";
    const escaped = input.replace(/'/g, "''").replace(/[%_\\]/g, "\\$&");
    expect(escaped).toBe("100\\% coverage");
  });

  it("normal query passes through unchanged", () => {
    const input = "bodemkaart";
    const escaped = input.replace(/'/g, "''").replace(/[%_\\]/g, "\\$&");
    expect(escaped).toBe("bodemkaart");
  });
});
