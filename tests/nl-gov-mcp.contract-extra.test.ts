import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { nlGovMcpQuery } from "../src/nlGovMcp.js";

import * as cbs from "../src/sources/cbsStatline.js";
import * as rdw from "../src/sources/rdw.js";
import * as ob from "../src/sources/officieleBekendmakingen.js";
import * as catalog from "../src/sources/dataOverheidCatalog.js";

const CitationSchema = z.object({
  source: z.string(),
  title: z.string(),
  url: z.string().url(),
  retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T/),
  excerpt: z.string().optional(),
});

const RouteDecisionSchema = z.object({
  explicit: z.boolean(),
  matchedRules: z.array(z.string()),
  initialSources: z.array(z.string()),
  finalSources: z.array(z.string()),
  fallbackUsed: z.boolean(),
});

const ResultSchema = z.object({
  query: z.string(),
  routedTo: z.array(z.string()),
  data: z.unknown(),
  answer: z.string(),
  citations: z.array(CitationSchema),
  errors: z
    .array(
      z.object({
        source: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
  meta: z
    .object({
      routeDecision: RouteDecisionSchema,
    })
    .optional(),
});

describe("NL-GOV-MCP extra contract guarantees", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("deterministische routing: zelfde query => zelfde routedTo + matchedRules", async () => {
    vi.spyOn(cbs, "search").mockResolvedValue({
      data: { rows: [{ gemeente: "Amsterdam", waarde: 1 }] },
      citations: [
        {
          source: "cbs_statline",
          title: "CBS",
          url: "https://opendata.cbs.nl",
          retrievedAt: new Date().toISOString(),
        },
      ],
    });

    const q = "Wat is de bevolking van Amsterdam in 2024?";
    const r1 = await nlGovMcpQuery(q);
    const r2 = await nlGovMcpQuery(q);

    expect(r1.routedTo).toEqual(r2.routedTo);
    expect(r1.meta?.routeDecision.matchedRules).toEqual(
      r2.meta?.routeDecision.matchedRules,
    );
  });

  it("schema-validatie: success output voldoet aan contract", async () => {
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
    const parsed = ResultSchema.parse(res);

    expect(parsed.routedTo).toEqual(["rdw"]);
    expect(parsed.citations.length).toBeGreaterThan(0);
  });

  it("schema-validatie: error output blijft structured", async () => {
    vi.spyOn(cbs, "search").mockRejectedValue(new Error("429 Too Many Requests"));

    const res = await nlGovMcpQuery("CBS: bevolking Amsterdam 2024");
    const parsed = ResultSchema.parse(res);

    expect(parsed.errors?.length).toBeGreaterThan(0);
    expect(parsed.errors?.[0]?.source).toBe("cbs_statline");
    expect(parsed.citations).toEqual([]);
  });

  it("citations de-dup: gelijke source+url niet dubbel", async () => {
    vi.spyOn(ob, "search").mockResolvedValue({
      data: { docs: [{ id: "gmb-1" }] },
      citations: [
        {
          source: "officiele_bekendmakingen",
          title: "OB",
          url: "https://zoek.officielebekendmakingen.nl",
          retrievedAt: new Date().toISOString(),
        },
      ],
    });

    vi.spyOn(cbs, "search").mockResolvedValue({
      data: { rows: [{ jaar: 2024, waarde: 123.4 }] },
      citations: [
        {
          source: "cbs_statline",
          title: "CBS",
          url: "https://opendata.cbs.nl",
          retrievedAt: new Date().toISOString(),
        },
        {
          source: "cbs_statline",
          title: "CBS duplicate",
          url: "https://opendata.cbs.nl",
          retrievedAt: new Date().toISOString(),
        },
      ],
    });

    const res = await nlGovMcpQuery(
      "Wat zegt de regeling XYZ en hoe verhouden de emissiecijfers zich in 2024?",
    );

    const cbsCitations = res.citations.filter((c) => c.source === "cbs_statline");
    expect(cbsCitations.length).toBe(1);
  });

  it("rate-limit scenario: nette error en fallback op data.overheid bij niet-expliciete route", async () => {
    vi.spyOn(cbs, "search").mockRejectedValue(new Error("429 Too Many Requests"));
    vi.spyOn(catalog, "search").mockResolvedValue({
      data: [{ id: "fallback-dataset" }],
      citations: [
        {
          source: "data.overheid.nl",
          title: "data.overheid.nl",
          url: "https://data.overheid.nl",
          retrievedAt: new Date().toISOString(),
        },
      ],
    });

    const res = await nlGovMcpQuery("bevolking nederland cijfers");

    expect(res.routedTo).toEqual(["data.overheid.nl"]);
    expect(res.errors?.some((e) => e.source === "cbs_statline")).toBe(true);
    expect(res.citations.length).toBeGreaterThan(0);
  });
});
