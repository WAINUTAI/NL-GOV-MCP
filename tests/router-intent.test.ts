import { describe, expect, it } from "vitest";
import { extractPlaceName, extractVerkiezingHint } from "../src/tools.js";
import { freeTextCql, freeTextCqlTerms, escapeSruValue } from "../src/utils/sru-cql.js";

describe("extractPlaceName", () => {
  it("picks up an explicit gemeente", () => {
    expect(extractPlaceName("Hoeveel scholen heeft gemeente Tilburg?")).toBe("Tilburg");
    expect(extractPlaceName("Gewaspercelen in gemeente Land van Cuijk")).toBe("Land van Cuijk");
  });

  it("picks up a place after 'in'", () => {
    expect(extractPlaceName("Welke basisscholen zijn er in Tilburg?")).toBe("Tilburg");
    expect(extractPlaceName("Wat was de uitslag in Bergen op Zoom?")).toBe("Bergen op Zoom");
  });

  it("strips trailing punctuation", () => {
    expect(extractPlaceName("Scholen in Utrecht.")).toBe("Utrecht");
  });

  it("returns undefined without a capitalised place", () => {
    expect(extractPlaceName("Welke basisscholen zijn er?")).toBeUndefined();
    expect(extractPlaceName("scholen in de buurt")).toBeUndefined();
  });
});

describe("extractVerkiezingHint", () => {
  it("maps election kinds to Kiesraad prefixes", () => {
    expect(extractVerkiezingHint("uitslag tweede kamerverkiezingen")).toBe("TK");
    expect(extractVerkiezingHint("opkomst gemeenteraad 2026")).toBe("GR");
    expect(extractVerkiezingHint("provinciale staten uitslag")).toBe("PS");
    expect(extractVerkiezingHint("europees parlement zetels")).toBe("EP");
    expect(extractVerkiezingHint("eerste kamer samenstelling")).toBe("EK");
    expect(extractVerkiezingHint("waterschap verkiezing")).toBe("WS");
  });

  it("recognises an explicit election code", () => {
    expect(extractVerkiezingHint("uitslag tk20251029")).toBe("TK20251029");
  });

  it("returns undefined when no election kind is mentioned", () => {
    expect(extractVerkiezingHint("hoeveel stemmen kreeg de motie")).toBeUndefined();
  });
});

describe("freeTextCql", () => {
  it("AND-joins multi-word input (a bare phrase is a CQL syntax error)", () => {
    expect(freeTextCql("tuchtklachten huisarts")).toBe("tuchtklachten AND huisarts");
    expect(freeTextCql("bestemmingsplan Rotterdam")).toBe("bestemmingsplan AND Rotterdam");
  });

  it("passes a single term through unchanged", () => {
    expect(freeTextCql("paspoort")).toBe("paspoort");
  });

  it("returns undefined for empty input", () => {
    expect(freeTextCql(undefined)).toBeUndefined();
    expect(freeTextCql("   ")).toBeUndefined();
    expect(freeTextCql("? !")).toBeUndefined();
  });

  it("strips CQL metacharacters instead of passing them through", () => {
    // An injected index expression collapses into one inert search term.
    expect(freeTextCqlTerms('zorg" OR dt.creator=="x')).toEqual(["zorg", "dt.creatorx"]);
    expect(freeTextCql("(stikstof)")).toBe("stikstof");
  });

  it("drops CQL boolean keywords typed as search words", () => {
    expect(freeTextCql("zorg and veiligheid")).toBe("zorg AND veiligheid");
  });

  it("drops single characters and punctuation-only tokens", () => {
    expect(freeTextCqlTerms("a bc - de")).toEqual(["bc", "de"]);
  });
});

describe("escapeSruValue", () => {
  it("escapes backslashes and quotes for quoted CQL values", () => {
    expect(escapeSruValue('Centraal "Tucht" College')).toBe('Centraal \\"Tucht\\" College');
    expect(escapeSruValue("a\\b")).toBe("a\\\\b");
  });
});
