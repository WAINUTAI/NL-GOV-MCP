import { describe, expect, it } from "vitest";
import {
  cbsNarrowingCandidates,
  extractLuchtComponent,
  extractPlaceName,
  extractVerkiezingHint,
} from "../src/tools.js";
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

  it("keeps both halves of a two-capital place name", () => {
    // "Den" alone prefix-matches the Den Haag stations and resolves to De Bilt
    // in the PDOK Locatieserver, so truncating here returned another city's data.
    expect(extractPlaceName("Wat is de luchtkwaliteit in Den Helder?")).toBe("Den Helder");
    expect(extractPlaceName("Wat is de luchtkwaliteit in Den Haag?")).toBe("Den Haag");
    expect(extractPlaceName("Gewaspercelen in Den Bosch")).toBe("Den Bosch");
  });

  it("keeps infix-joined place names whole", () => {
    expect(extractPlaceName("Scholen in Alphen aan den Rijn")).toBe("Alphen aan den Rijn");
    expect(extractPlaceName("Uitslag in Berkel en Rodenrijs")).toBe("Berkel en Rodenrijs");
    expect(extractPlaceName("Percelen in Capelle aan den IJssel")).toBe("Capelle aan den IJssel");
  });

  it("handles places that open on an apostrophe", () => {
    expect(extractPlaceName("Scholen in 's-Hertogenbosch")).toBe("'s-Hertogenbosch");
    expect(extractPlaceName("Percelen in 't Zand")).toBe("'t Zand");
  });

  it("strips trailing punctuation", () => {
    expect(extractPlaceName("Scholen in Utrecht.")).toBe("Utrecht");
    expect(extractPlaceName("Luchtkwaliteit in Den Helder!")).toBe("Den Helder");
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

describe("extractLuchtComponent", () => {
  it("maps named components to Luchtmeetnet formulas", () => {
    expect(extractLuchtComponent("wat is de no2-concentratie in amsterdam")).toBe("NO2");
    expect(extractLuchtComponent("stikstofdioxide in rotterdam")).toBe("NO2");
    expect(extractLuchtComponent("hoeveel fijnstof in utrecht")).toBe("PM10");
    expect(extractLuchtComponent("pm 2.5 waarden")).toBe("PM25");
    expect(extractLuchtComponent("ozon vandaag")).toBe("O3");
  });

  it("returns undefined for a general air-quality question", () => {
    expect(extractLuchtComponent("wat is de luchtkwaliteit in utrecht")).toBeUndefined();
  });

  it("does not treat bare nitrogen policy as a component", () => {
    expect(extractLuchtComponent("moties over stikstof")).toBeUndefined();
  });
});

describe("cbsNarrowingCandidates", () => {
  it("drops quantity words and the municipality, which never appear in CBS titles", () => {
    expect(cbsNarrowingCandidates("hoeveel woningen gebouwd rotterdam", "Rotterdam")).toEqual([
      "woningen gebouwd",
      "woningen",
    ]);
  });

  it("keeps the topic when no place was detected", () => {
    expect(cbsNarrowingCandidates("hoeveel woningen gebouwd")).toEqual([
      "woningen gebouwd",
      "woningen",
    ]);
  });

  it("handles a multi-word place name", () => {
    expect(cbsNarrowingCandidates("werkloosheid bergen op zoom", "Bergen op Zoom")).toEqual([
      "werkloosheid",
    ]);
  });

  it("returns a single candidate when narrowing yields one token", () => {
    expect(cbsNarrowingCandidates("hoeveel inwoners tilburg", "Tilburg")).toEqual(["inwoners"]);
  });

  it("returns nothing when only noise is left", () => {
    expect(cbsNarrowingCandidates("hoeveel in rotterdam", "Rotterdam")).toEqual([]);
  });
});
