import { describe, expect, it } from "vitest";
import { shouldDeepenTweedeKamerQuery } from "../src/tools.js";

describe("shouldDeepenTweedeKamerQuery", () => {
  it("detects explicit summary/content intent in Dutch", () => {
    expect(shouldDeepenTweedeKamerQuery("Vat dit kamerstuk samen")).toBe(true);
    expect(shouldDeepenTweedeKamerQuery("Wat staat er in deze motie?")).toBe(true);
    expect(shouldDeepenTweedeKamerQuery("Wat heeft de Tweede Kamer besloten over stikstof afgelopen maand?")).toBe(true);
  });

  it("detects explicit summary/content intent in English", () => {
    expect(shouldDeepenTweedeKamerQuery("What does this document say about nitrogen policy?")).toBe(true);
    expect(shouldDeepenTweedeKamerQuery("Summarize this parliamentary letter")).toBe(true);
  });

  it("does not deepen plain discovery queries", () => {
    expect(shouldDeepenTweedeKamerQuery("Welke kamerstukken zijn er over stikstof?")).toBe(false);
    expect(shouldDeepenTweedeKamerQuery("Toon recente moties over wonen")).toBe(false);
  });
});
