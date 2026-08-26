import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  VerkiezingsuitslagenSource,
  parseDutchNumber,
  parseVerkiezingenOverview,
} from "../src/sources/verkiezingsuitslagen.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { htmlResponse, jsonResponse, testConfig } from "./helpers/config.js";

const overviewHtml = `
<div class="row">
<a href="/verkiezingen/detail/GR20260318">
  <span class="uitslag col-md-6 GR">
    <span class="verkiezingsnaam">Gemeenteraad</span>
    <span class="datum">18 maart 2026</span>
    <span class="opkomst">Opkomst: <span class="value">53,75%</span></span>
  </span>
</a>
<a href="/verkiezingen/detail/TK20251029">
  <span class="uitslag col-md-6 TK">
    <span class="verkiezingsnaam">Tweede Kamer</span>
    <span class="datum">29 oktober 2025</span>
    <span class="opkomst">Opkomst: <span class="value">78,3%</span></span>
  </span>
</a>
</div>`;

const nationalPayload = {
  Info: { Code: "TK20251029", Name: "Tweede Kamer", Date: "29 oktober 2025" },
  Stemregio: {
    StemregioId: 745610,
    Naam: "Nederland",
    Kiesgerechtigden: "13.589.128",
    Opkomst: "10.640.324",
    OpkomstPercentage: "78,3%",
    AantalGeldigeStemmen: "10.571.990",
    AantalBlancoStemmen: "40.128",
    AantalOngeldigeStemmen: "28.206",
    Partij: [
      { Naam: "D66", AantalStemmen: "1.790.634", AantalZetels: "26", Percentage: "16,94%", PartijUri: "d66" },
      { Naam: "PVV", AantalStemmen: "1.520.000", AantalZetels: "22", Percentage: "14,38%", PartijUri: "pvv" },
    ],
  },
  Regios: {
    Regios: [
      {
        Id: 2,
        Name: "Provincie",
        Options: [
          { Id: 745610, Value: "-" },
          { Id: 745612, Value: "Fryslân" },
        ],
      },
      {
        Id: 3,
        Name: "Gemeente",
        Options: [
          { Id: 745610, Value: "-" },
          { Id: 745792, Value: "Aalsmeer" },
        ],
      },
    ],
  },
};

const gemeentePayload = {
  Info: { Code: "TK20251029", Name: "Tweede Kamer", Date: "29 oktober 2025" },
  Stemregio: {
    StemregioId: 745792,
    Naam: "Aalsmeer",
    Kiesgerechtigden: "23.684",
    Opkomst: "19.689",
    OpkomstPercentage: "83,13%",
    AantalGeldigeStemmen: "19.589",
    Partij: [
      { Naam: "VVD", AantalStemmen: "4.496", AantalZetels: null, Percentage: "22,95%", PartijUri: "vvd" },
    ],
  },
};

function stubKiesraad() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/verkiezingen")) return htmlResponse(overviewHtml);
    if (url.includes("/detailJson/TK20251029/745792")) return jsonResponse(gemeentePayload);
    if (url.includes("/detailJson/TK20251029/745612")) {
      return jsonResponse({ ...gemeentePayload, Stemregio: { ...gemeentePayload.Stemregio, StemregioId: 745612, Naam: "Fryslân" } });
    }
    if (url.includes("/detailJson/")) return jsonResponse(nationalPayload);
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("parseDutchNumber", () => {
  it("parses Dutch thousands and decimal separators", () => {
    expect(parseDutchNumber("1.790.634")).toBe(1790634);
    expect(parseDutchNumber("16,94%")).toBe(16.94);
    expect(parseDutchNumber("78,3%")).toBe(78.3);
    expect(parseDutchNumber(42)).toBe(42);
  });

  it("returns null for missing or non-numeric values", () => {
    expect(parseDutchNumber(null)).toBeNull();
    expect(parseDutchNumber("")).toBeNull();
    expect(parseDutchNumber("n.v.t.")).toBeNull();
  });
});

describe("parseVerkiezingenOverview", () => {
  it("extracts code, name, date and turnout newest-first", () => {
    const items = parseVerkiezingenOverview(overviewHtml);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      code: "GR20260318",
      soort: "Gemeenteraad",
      naam: "Gemeenteraad",
      datum: "18 maart 2026",
      opkomst: "53,75%",
    });
    expect(items[1].code).toBe("TK20251029");
  });
});

describe("VerkiezingsuitslagenSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("returns the national result for an explicit code without listing elections", async () => {
    const fetchMock = stubKiesraad();
    const source = new VerkiezingsuitslagenSource(testConfig);
    const out = await source.uitslag({ verkiezing: "TK20251029" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.uitslag).toMatchObject({
      gebied: "Nederland",
      niveau: "land",
      kiesgerechtigden: 13589128,
      opkomstPercentage: 78.3,
      geldigeStemmen: 10571990,
    });
    expect(out.uitslag!.partijen[0]).toMatchObject({
      partij: "D66",
      aantalStemmen: 1790634,
      percentage: 16.94,
      aantalZetels: 26,
    });
  });

  it("drills down to a municipality by name", async () => {
    stubKiesraad();
    const source = new VerkiezingsuitslagenSource(testConfig);
    const out = await source.uitslag({ verkiezing: "TK20251029", gebied: "aalsmeer" });

    expect(out.uitslag).toMatchObject({ gebied: "Aalsmeer", niveau: "gemeente", opkomstPercentage: 83.13 });
    expect(out.params.stemregioId).toBe("745792");
  });

  it("matches a province name with diacritics", async () => {
    stubKiesraad();
    const source = new VerkiezingsuitslagenSource(testConfig);
    const out = await source.uitslag({ verkiezing: "TK20251029", gebied: "fryslan" });

    expect(out.uitslag?.niveau).toBe("provincie");
    expect(out.params.stemregioId).toBe("745612");
  });

  it("falls back to the national result and explains an unknown area", async () => {
    stubKiesraad();
    const source = new VerkiezingsuitslagenSource(testConfig);
    const out = await source.uitslag({ verkiezing: "TK20251029", gebied: "Atlantis" });

    expect(out.uitslag?.niveau).toBe("land");
    expect(out.access_note).toContain("niet gevonden");
  });

  it("resolves an election kind to the most recent matching election", async () => {
    stubKiesraad();
    const source = new VerkiezingsuitslagenSource(testConfig);
    const out = await source.uitslag({ verkiezing: "tweede kamer" });

    expect(out.params.verkiezing).toBe("TK20251029");
  });

  it("defaults to the most recent election when none is given", async () => {
    stubKiesraad();
    const source = new VerkiezingsuitslagenSource(testConfig);
    const out = await source.uitslag({});

    expect(out.params.verkiezing).toBe("GR20260318");
    expect(out.access_note).toContain("meest recente");
  });

  it("lists available elections with a hint when the name is unknown", async () => {
    stubKiesraad();
    const source = new VerkiezingsuitslagenSource(testConfig);
    const out = await source.uitslag({ verkiezing: "Landdag" });

    expect(out.uitslag).toBeUndefined();
    expect(out.verkiezingen).toHaveLength(2);
    expect(out.access_note).toContain("niet gevonden");
  });
});
