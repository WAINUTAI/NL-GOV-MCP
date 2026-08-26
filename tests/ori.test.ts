import { describe, expect, it } from "vitest";
import { gemeenteToIndexSlug, indexToGemeente } from "../src/sources/ori.js";

describe("gemeenteToIndexSlug", () => {
  it("matches how ORI names its per-municipality indices", () => {
    expect(gemeenteToIndexSlug("Delft")).toBe("delft");
    expect(gemeenteToIndexSlug("Berg en Dal")).toBe("berg_en_dal");
    expect(gemeenteToIndexSlug("Baarle-Nassau")).toBe("baarle_nassau");
  });

  it("folds case and accents", () => {
    expect(gemeenteToIndexSlug("FRYSLÂN")).toBe("fryslan");
  });
});

describe("indexToGemeente", () => {
  it("reads the municipality back out of an index name", () => {
    // The documents carry only a numeric organisation id, so the index name is
    // the only legible source for this field.
    expect(indexToGemeente("ori_delft_20250407054803")).toBe("Delft");
    expect(indexToGemeente("ori_den_haag_20250408204203")).toBe("Den Haag");
    expect(indexToGemeente("ori_berg_en_dal_20250402174603")).toBe("Berg En Dal");
  });

  it("returns nothing for an index it does not recognise", () => {
    expect(indexToGemeente(undefined)).toBe("");
    expect(indexToGemeente("something_else")).toBe("");
    expect(indexToGemeente("ori_")).toBe("");
  });
});
