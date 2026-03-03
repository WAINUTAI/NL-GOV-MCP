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

  it("routeert CBS-vraag naar cbs_statline (niet naar RDW/BAG)", async () => {
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

    const rdwSpy = vi.spyOn(rdw, "search").mockResolvedValue({
      data: null,
      citations: [],
    });
    const bagSpy = vi.spyOn(bag, "search").mockResolvedValue({
      data: null,
      citations: [],
    });

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

  it("routeert kenteken-vraag naar rdw", async () => {
    vi.spyOn(rdw, "search").mockResolvedValue({
      data: {
        kenteken: "12ABCD",
        merk: "TESLA",
        voertuigsoort: "Personenauto",
      },
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

  it("routeert BAG/adres-vraag naar pdok_bag", async () => {
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
    expect(res.citations[0]?.source).toBe("pdok_bag");
    expect(res.answer.toLowerCase()).toContain("dam");
  });

  it("routeert juridische publicatie-vraag naar officiele_bekendmakingen", async () => {
    vi.spyOn(ob, "search").mockResolvedValue({
      data: [{ identifier: "stcrt-2024-12345", title: "Staatscourant test" }],
      citations: [
        {
          source: "officiele_bekendmakingen",
          title: "Officiële Bekendmakingen",
          url: "https://zoek.officielebekendmakingen.nl",
          retrievedAt: new Date().toISOString(),
        },
      ],
    });

    const res = await nlGovMcpQuery("Zoek bekendmaking over vergunning en verordening");

    expect(res.routedTo).toEqual(["officiele_bekendmakingen"]);
    expect(res.citations[0]?.source).toBe("officiele_bekendmakingen");
  });

  it("foutafhandeling: bij bronfout valt terug op data.overheid met errors gevuld", async () => {
    vi.spyOn(cbs, "search").mockRejectedValue(new Error("CBS timeout"));
    vi.spyOn(catalog, "search").mockResolvedValue({
      data: [{ id: "dataset-1", title: "Fallback dataset" }],
      citations: [
        {
          source: "data.overheid.nl",
          title: "data.overheid.nl",
          url: "https://data.overheid.nl",
          retrievedAt: new Date().toISOString(),
        },
      ],
    });

    const res = await nlGovMcpQuery("CBS bevolking Nederland");

    expect(res.routedTo).toEqual(["data.overheid.nl"]);
    expect(res.citations[0]?.source).toBe("data.overheid.nl");
    expect(Array.isArray(res.errors)).toBe(true);
    expect(res.errors?.some((e) => e.source === "cbs_statline")).toBe(true);
  });

  it("succesresultaten bevatten altijd minimaal 1 citation", async () => {
    vi.spyOn(catalog, "search").mockResolvedValue({
      data: [{ id: "abc", title: "Open dataset" }],
      citations: [
        {
          source: "data.overheid.nl",
          title: "data.overheid.nl",
          url: "https://data.overheid.nl",
          retrievedAt: new Date().toISOString(),
        },
      ],
    });

    const res = await nlGovMcpQuery("is er data over luchtkwaliteit");
    expect(res.citations.length).toBeGreaterThan(0);
    expect(typeof res.citations[0]?.url).toBe("string");
  });
});
