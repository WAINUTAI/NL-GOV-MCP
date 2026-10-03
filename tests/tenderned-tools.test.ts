import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { jsonResponse } from "./helpers/config.js";

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tenderned-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }> };
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  } finally {
    await client.close();
    await server.close();
  }
}

/** A fake /publicaties over `total` notices; detail, /gerelateerd and /html for single notices. */
function fakeTenderNed(total: number) {
  return vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/publicaties")) {
      const page = Number(url.searchParams.get("page"));
      const size = Number(url.searchParams.get("size"));
      const content = [];
      for (let i = page * size; i < Math.min(total, (page + 1) * size); i += 1) {
        content.push({
          publicatieId: String(i + 1),
          publicatieDatum: "2026-09-10",
          aanbestedingNaam: `Notice ${i + 1}`,
          typePublicatie: { code: "MAC", omschrijving: "Marktconsultatie" },
          sluitingsDatumMarktconsultatie: "2026-10-15",
        });
      }
      return jsonResponse({ content, totalElements: total });
    }
    if (url.pathname.endsWith("/gerelateerd")) return jsonResponse([]);
    if (url.pathname.endsWith("/html")) return jsonResponse({ html: '<table><tr class="header1"><th>1. Koper</th></tr></table>' });
    return jsonResponse({
      publicatieId: 450123,
      aanbestedingNaam: "Marktconsultatie Afvalinzameling",
      opdrachtgeverNaam: "Gemeente Harderwijk",
      publicatieDatum: "2026-09-10T10:26:00.637087",
      sluitingsDatumMarktconsultatie: "2026-10-15",
      typePublicatie: "Marktconsultatie",
      publicatieCode: "EFE1",
      aankondigingCode: { code: "MAC", omschrijving: "Marktconsultatie" },
      formType: "consultation",
    });
  });
}

describe("tenderned_aanbestedingen_search tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("reports the absolute position and an honest has_more on the last page", async () => {
    vi.stubGlobal("fetch", fakeTenderNed(101));
    const res = await callTool("tenderned_aanbestedingen_search", { query: "fietsbrug", top: 20, page: 5 });
    expect(res.pagination).toEqual({ offset: 100, limit: 20, total: 101, has_more: false });
    expect(res.summary).toBe("1 TenderNed publicaties");
    expect((res.records as unknown[]).length).toBe(1);
  });

  it("combines page and offset into one absolute start", async () => {
    vi.stubGlobal("fetch", fakeTenderNed(101));
    const res = await callTool("tenderned_aanbestedingen_search", { top: 20, page: 1, offset: 75 });
    const records = res.records as Array<{ data: Record<string, unknown> }>;
    expect(res.pagination).toMatchObject({ offset: 95, has_more: false });
    expect(records.map((r) => r.data.publicatie_id)).toEqual(["96", "97", "98", "99", "100", "101"]);
    expect((res.provenance as Record<string, unknown>).returned_results).toBe(6);
  });

  it("returns a clear error instead of an empty page past 10,000 results", async () => {
    vi.stubGlobal("fetch", fakeTenderNed(50_000));
    const res = await callTool("tenderned_aanbestedingen_search", { top: 100, page: 100 });
    expect(res.error).toBe("unexpected");
    expect(String(res.message)).toContain("10000");
    expect(String(res.suggestion)).toContain("date_from");
  });

  it("puts the upstream page and sort in the dry-run plan", async () => {
    const res = await callTool("tenderned_aanbestedingen_search", { top: 20, offset: 95, sort: "date_newest", dryRun: true });
    const planned = (res.planned_requests as Array<{ params: Record<string, unknown> }>)[0].params;
    expect(planned.sort).toBe("date_newest");
    expect(planned.page).toBe("4");
    expect(planned.size).toBe(23);
  });
});

describe("tenderned_aanbesteding_get tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("accepts publicatie_id as returned by search, and returns the search field names", async () => {
    vi.stubGlobal("fetch", fakeTenderNed(1));
    const search = await callTool("tenderned_aanbestedingen_search", { top: 1 });
    const hit = (search.records as Array<{ data: Record<string, unknown> }>)[0].data;

    clearHttpCache();
    const res = await callTool("tenderned_aanbesteding_get", { publicatie_id: "450123" });
    const record = (res.records as Array<{ date: string; data: Record<string, unknown> }>)[0];
    for (const key of Object.keys(hit)) expect(record.data).toHaveProperty(key);
    expect(record.data).toMatchObject({
      publicatie_id: "450123",
      publicatie_datum: "2026-09-10",
      sluitings_datum: hit.sluitings_datum,
      sluitings_datum_bron: hit.sluitings_datum_bron,
      type_publicatie: hit.type_publicatie,
      type_publicatie_code: hit.type_publicatie_code,
      // The original camelCase fields stay for existing callers.
      publicatieDatum: "2026-09-10T10:26:00.637087",
      typePublicatieCode: "MAC",
    });
    expect(record.date).toBe("2026-09-10");
  });

  it("accepts a numeric id", async () => {
    vi.stubGlobal("fetch", fakeTenderNed(1));
    const res = await callTool("tenderned_aanbesteding_get", { publicatieId: 450123 });
    expect((res.records as Array<{ data: Record<string, unknown> }>)[0].data.publicatie_id).toBe("450123");
  });

  it("rejects a missing, conflicting or non-numeric id without calling TenderNed", async () => {
    const fetchMock = fakeTenderNed(1);
    vi.stubGlobal("fetch", fetchMock);

    expect((await callTool("tenderned_aanbesteding_get", {})).message).toContain("publicatieId");
    expect((await callTool("tenderned_aanbesteding_get", { publicatieId: "1", publicatie_id: "2" })).message).toContain("verschillen");
    expect((await callTool("tenderned_aanbesteding_get", { publicatieId: "abc" })).message).toContain("alleen cijfers");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats the same id under both names as one", async () => {
    vi.stubGlobal("fetch", fakeTenderNed(1));
    const res = await callTool("tenderned_aanbesteding_get", { publicatieId: "450123", publicatie_id: 450123 });
    expect(res.error).toBeUndefined();
  });
});
