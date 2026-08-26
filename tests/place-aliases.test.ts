import { describe, expect, it } from "vitest";
import { placeKey, placeKeys, placeVariants } from "../src/utils/place-aliases.js";

describe("placeKey", () => {
  it("folds the spellings one source uses for one municipality", () => {
    // DUO stores the same place as "'S-GRAVENHAGE" (PLAATSNAAM) and
    // "S GRAVENHAGE" (GEMEENTENAAM); both have to compare equal.
    expect(placeKey("'S-GRAVENHAGE")).toBe("s gravenhage");
    expect(placeKey("S GRAVENHAGE")).toBe("s gravenhage");
    expect(placeKey("'s-Gravenhage")).toBe("s gravenhage");
  });

  it("folds accents and case", () => {
    expect(placeKey("Fryslân")).toBe("fryslan");
    expect(placeKey("UTRECHT")).toBe("utrecht");
  });

  it("folds hyphen and spacing differences", () => {
    expect(placeKey("Sint-Michielsgestel")).toBe(placeKey("Sint Michielsgestel"));
    expect(placeKey("Den Haag-Bleriotlaan")).toBe("den haag bleriotlaan");
  });
});

describe("placeVariants", () => {
  it("puts the caller's own spelling first", () => {
    expect(placeVariants("Den Haag")[0]).toBe("Den Haag");
    expect(placeVariants("'s-Gravenhage")[0]).toBe("'s-Gravenhage");
  });

  it("offers the official name for an everyday one, and back", () => {
    expect(placeVariants("Den Haag")).toContain("'s-Gravenhage");
    expect(placeVariants("'s-Gravenhage")).toContain("Den Haag");
    expect(placeVariants("Den Bosch")).toContain("'s-Hertogenbosch");
    expect(placeVariants("'s-Hertogenbosch")).toContain("Den Bosch");
  });

  it("offers the punctuation spellings a source may store", () => {
    // DUO's GEMEENTENAAM drops both the apostrophe and the hyphen.
    expect(placeVariants("Den Haag")).toContain("s Gravenhage");
    expect(placeVariants("Den Haag")).toContain("s-Gravenhage");
  });

  it("covers English and Frisian names the Locatieserver does not know", () => {
    expect(placeVariants("The Hague")).toContain("'s-Gravenhage");
    expect(placeVariants("Friesland")).toContain("Fryslân");
    expect(placeVariants("Ljouwert")).toContain("Leeuwarden");
  });

  it("leaves an ordinary place alone", () => {
    expect(placeVariants("Utrecht")).toEqual(["Utrecht"]);
    expect(placeVariants("Tilburg")).toEqual(["Tilburg"]);
  });

  it("returns nothing for empty input", () => {
    expect(placeVariants("")).toEqual([]);
    expect(placeVariants("   ")).toEqual([]);
  });

  it("does not repeat a spelling", () => {
    const variants = placeVariants("Den Haag");
    expect(new Set(variants).size).toBe(variants.length);
  });
});

describe("placeKeys", () => {
  it("collects every folded key a place may be stored under", () => {
    const keys = placeKeys("Den Haag");
    expect(keys.has("den haag")).toBe(true);
    expect(keys.has("s gravenhage")).toBe(true);
    expect(keys.has("the hague")).toBe(true);
  });
});
