import { describe, expect, it } from "vitest";
import { detectEuIntent } from "../src/tools.js";

describe("detectEuIntent", () => {
  it("routes a bare or prefixed CELEX number to a document lookup", () => {
    expect(detectEuIntent("Wat is 32016R0679?")).toEqual({ kind: "document", celex: "32016R0679" });
    expect(detectEuIntent("Toon CELEX:32016L0680")).toEqual({ kind: "document", celex: "32016L0680" });
  });

  it("recognises EU citations on the raw question (slashes intact)", () => {
    expect(detectEuIntent("Wat regelt Verordening (EU) 2016/679?")).toEqual({ kind: "document", celex: "32016R0679" });
    expect(detectEuIntent("Is Richtlijn 95/46/EG nog van kracht?")).toEqual({ kind: "document", celex: "31995L0046" });
    expect(detectEuIntent("Uitvoeringsverordening (EU) 2023/1234")).toEqual({ kind: "document", celex: "32023R1234" });
  });

  it("routes a directive plus 'omzetting' to the transposition lookup", () => {
    expect(detectEuIntent("Hoe is Richtlijn (EU) 2016/680 omgezet in Nederland?")).toEqual({ kind: "transposition", celex: "32016L0680" });
    expect(detectEuIntent("omzetting 32019L1024")).toEqual({ kind: "transposition", celex: "32019L1024" });
  });

  it("does not treat a municipal bylaw number as an EU act", () => {
    expect(detectEuIntent("Wat staat in de verordening 2024/12 van gemeente Tilburg?")).toBeUndefined();
    expect(detectEuIntent("besluit 2020/3 van het college")).toBeUndefined();
  });

  it("uses explicit EU terms for a title search and strips them from the query", () => {
    expect(detectEuIntent("Welke Europese verordening over kunstmatige intelligentie?")).toEqual({ kind: "search", query: "kunstmatige intelligentie" });
    expect(detectEuIntent("EU-richtlijnen over gegevensbescherming")).toEqual({ kind: "search", query: "gegevensbescherming" });
    expect(detectEuIntent("zoek in EUR-Lex naar batterijen")).toMatchObject({ kind: "search" });
  });

  it("leaves ordinary Dutch questions alone", () => {
    expect(detectEuIntent("Welke verordeningen staan in het gemeenteblad?")).toBeUndefined();
    expect(detectEuIntent("Hoeveel inwoners heeft Utrecht?")).toBeUndefined();
    expect(detectEuIntent("Welke Europese richtlijnen zijn er?")).toBeUndefined();
  });
});
