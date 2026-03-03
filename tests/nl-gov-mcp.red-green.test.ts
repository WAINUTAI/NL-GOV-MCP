import { describe, it, expect, vi, beforeEach } from "vitest";
import { nlGovMcpQuery } from "../src/nlGovMcp.js";

import * as cbs from "../src/sources/cbsStatline.js";
import * as rdw from "../src/sources/rdw.js";
import * as bag from "../src/sources/pdokBag.js";
import * as ob from "../src/sources/officieleBekendmakingen.js";
import * as catalog from "../src/sources/dataOverheidCatalog.js";

describe("NL-GOV-MCP RED/GREEN contract tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("routeert een CBS/StatLine vraag naar cbs_statline (en NIET naar RDW/BAG)", async () => {
    vi.spyOn(cbs, "search").mockResolvedValue({
      data: {
        dataset: "Bevolking; kerncijfers",
        rows: [{ gemeente: "Amsterdam", waarde: 921402 }],
      },
      citations: [
        {
          source: "cbs_statline",
          title: "CBS StatLine",
          url: "https://opendata.cbs.nl",
          retrievedAt: new Date().toISOString(),
        },
      ],
    });

    const rdwSpy = vi.spyOn(rdw, "search").mockResolvedValue({ data: null, citations: [] });
    const bagSpy = vi.spyOn(bag, "search").mockResolvedValue({ data: null, citations: [] });

    const res = await nlGovMcpQuery("Wat is de bevolking van Amsterdam in 2024?");

    expect(res.routedTo).toContain("cbs_statline");
    expect(res.routedTo).not.toContain("rdw");
    expect(res.routedTo).not.toContain("pdok_bag");

    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.citations[0]?.source).toBe("cbs_statline");
    expect(res.answer.toLowerCase()).toContain("amsterdam");

    expect(rdwSpy).not.toHaveBeenCalled();
    expect(bagSpy).not.toHaveBeenCalled();
  });

  it("routeert kenteken/voertuig-vraag naar rdw", async () => {
    vi.spyOn(rdw, "search").mockResolvedValue({
      data: { kenteken: "12ABCD", merk: "TESLA", voertuigsoort: "Personenauto" },
      citations: [
        {
          source: "rdw",
          title: "RDW Open Data",
          url: "https://opendata.rdw.nl",
          retrievedAt: new Date().toISOString(),
        },
      ],
    });

    const res = await nlGovMcpQuery("Geef voertuiggegevens voor kenteken 12ABCD");

    expect(res.routedTo).toEqual(["rdw"]);
    expect(res.data).toMatchObject({ kenteken: "12ABCD" });
    expect(res.citations.map((c) => c.source)).toContain("rdw");
  });

  it("routeert BAG/Adres-vraag naar pdok_bag", async () => {
    vi.spyOn(bag, "search").mockResolvedValue({
      data: { adres: "Dam 1, 1012JS Amsterdam", bagId: "0363010000..." },
      citations: [
        {
          source: "pdok_bag",
          title: "BAG via PDOK",
          url: "https://api.pdok.nl",
          retrievedAt: new Date().toISOString(),
        },
      ],
    });

    const res = await nlGovMcpQuery("Wat is het BAG-id van Dam 1, 1012JS Amsterdam?");

    expect(res.routedTo).toEqual(["pdok_bag"]);
    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.citations[0]?.url).toContain("pdok");
  });

  it("kan multi-source routeren: regeling/wet + cijfers => OB + CBS", async () => {
    vi.spyOn(ob, "search").mockResolvedValue({
      data: { documents: [{ title: "Regeling XYZ", id: "gmb-2025-..." }] },
      citations: [
        {
          source: "officiele_bekendmakingen",
          title: "Officiële Bekendmakingen",
          url: "https://zoek.officielebekendmakingen.nl",
          retrievedAt: new Date().toISOString(),
        },
      ],
    });

    vi.spyOn(cbs, "search").mockResolvedValue({
      data: { dataset: "Emissies", rows: [{ jaar: 2024, waarde: 123.4 }] },
      citations: [
        {
          source: "cbs_statline",
          title: "CBS StatLine",
          url: "https://opendata.cbs.nl",
          retrievedAt: new Date().toISOString(),
        },
      ],
    });

    const res = await nlGovMcpQuery(
      "Wat zegt de regeling XYZ en hoe verhouden de emissiecijfers zich in 2024?",
    );

    expect(res.routedTo).toEqual(
      expect.arrayContaining(["officiele_bekendmakingen", "cbs_statline"]),
    );
    expect(res.citations.map((c) => c.source)).toEqual(
      expect.arrayContaining(["officiele_bekendmakingen", "cbs_statline"]),
    );
  });

  it("geeft nette fout met bronlabel als expliciete bron faalt, maar blijft structured", async () => {
    vi.spyOn(cbs, "search").mockRejectedValue(new Error("Timeout"));
    const fallbackSpy = vi.spyOn(catalog, "search");

    const res = await nlGovMcpQuery("CBS: bevolking Amsterdam 2024");

    expect(res.errors?.length).toBeGreaterThan(0);
    expect(res.errors?.[0]?.source).toBe("cbs_statline");
    expect(res.citations).toEqual([]);
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it("enforce: succes => altijd minstens 1 citation met url + retrievedAt", async () => {
    vi.spyOn(rdw, "search").mockResolvedValue({
      data: { kenteken: "12ABCD" },
      citations: [
        {
          source: "rdw",
          title: "RDW",
          url: "https://opendata.rdw.nl",
          retrievedAt: new Date().toISOString(),
        },
      ],
    });

    const res = await nlGovMcpQuery("kenteken 12ABCD");
    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.citations[0]?.url).toMatch(/^https?:\/\//);
    expect(res.citations[0]?.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
