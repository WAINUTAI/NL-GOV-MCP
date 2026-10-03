import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearHttpCache, markConnectorSuccess } from "../src/utils/connector-runtime.js";
import { GMB_RECORD, KST_RECORD, SRU_DIAGNOSTIC, creatorRecord, sruResponse } from "./helpers/bekendmakingen-fixtures.js";
import { xmlResponse } from "./helpers/config.js";

async function callToolRaw(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "bekendmakingen-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: result.isError, text: result.content[0].text };
  } finally {
    await client.close();
    await server.close();
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return JSON.parse((await callToolRaw(name, args)).text) as Record<string, any>;
}

function stubSru(handler: (url: URL) => Response) {
  const fetchMock = vi.fn(async (input: unknown) => handler(new URL(String(input))));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearHttpCache();
  markConnectorSuccess("officiele_bekendmakingen", 1);
});

afterEach(() => {
  // A failure test must not leave the circuit breaker open for the next file.
  markConnectorSuccess("officiele_bekendmakingen", 1);
});

describe("officiele_bekendmakingen_search tool", () => {
  it("returns records with a citation snippet and the real total", async () => {
    stubSru(() => xmlResponse(sruResponse([GMB_RECORD, KST_RECORD], 306)));
    const out = await callTool("officiele_bekendmakingen_search", { query: "afvalinzameling", top: 2 });
    expect(out.summary).toBe("2 bekendmakingen (van 306 treffers)");
    expect(out.records[0].snippet).toBe(
      "Gemeenteblad 2026, 104512 · Pijnacker-Nootdorp (gemeente) · ander besluit van algemene strekking · gepubliceerd 2026-04-02",
    );
    expect(out.records[1].date).toBe("2026-10-01");
    expect(out.provenance.total_results).toBe(306);
    expect(out.pagination).toEqual({ offset: 0, limit: 2, total: 306, has_more: true });
  });

  it("shows the publication date on records when date_field is publicatiedatum", async () => {
    const fetchMock = stubSru(() => xmlResponse(sruResponse([KST_RECORD], 1)));
    const out = await callTool("officiele_bekendmakingen_search", { query: "motie", date_field: "publicatiedatum", sort: "date_newest" });
    expect(out.records[0].date).toBe("2026-10-02");
    expect(out.records[0].data.date).toBe("2026-10-01");
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("query")).toContain("sortBy dt.available/sort.descending");
  });

  it("leaves a sort clause typed into the query out of the search, through the rewriter", async () => {
    const fetchMock = stubSru(() => xmlResponse(sruResponse([GMB_RECORD], 1)));
    const out = await callTool("officiele_bekendmakingen_search", { query: "parkeerbeleid sortBy dt.date" });
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("query")).toBe('parkeerbeleid AND c.product-area="officielepublicaties"');
    expect(out.access_note).toContain("'sortBy dt.date' uit de zoekterm genegeerd");
  });

  it("stops has_more at the upstream paging window", async () => {
    const records = Array.from({ length: 2 }, () => GMB_RECORD);
    stubSru(() => xmlResponse(sruResponse(records, 459711)));
    const out = await callTool("officiele_bekendmakingen_search", { query: "zorg", top: 2, startRecord: 9998 });
    expect(out.pagination).toMatchObject({ offset: 9997, total: 459711, has_more: false });
    expect(out.access_note).toContain("~10.000");
  });

  it("reports a rejected query without a total", async () => {
    stubSru(() => xmlResponse(SRU_DIAGNOSTIC));
    const out = await callTool("officiele_bekendmakingen_search", { query: "afvalinzameling" });
    expect(out.records).toEqual([]);
    expect(out.pagination.total).toBeNull();
    expect(out.provenance.total_results).toBeUndefined();
    expect(out.access_note).toContain("SRU-diagnose");
  });

  it("does not fabricate a record when the source is unreachable", async () => {
    stubSru(() => new Response("bad gateway", { status: 400 }));
    const out = await callTool("officiele_bekendmakingen_search", { query: "woningbouw" });
    expect(out.records).toEqual([]);
    expect(out.summary).toContain("bron niet bereikbaar");
    expect(out.pagination).toMatchObject({ total: null, has_more: false });
    expect(out.provenance.total_results).toBeUndefined();
    expect(out.failures[0]).toMatchObject({ connector: "officiele_bekendmakingen", error_type: "http_error" });
    expect(out.access_note).toContain("geen resultaten opgehaald");
  });

  it("passes the caller's own casing to place detection", async () => {
    stubSru(() => xmlResponse(sruResponse([KST_RECORD], 306)));
    const out = await callTool("officiele_bekendmakingen_search", { query: "Best practices afvalinzameling" });
    expect(out.access_note).toContain("authority: 'Best'");
    const lower = await callTool("officiele_bekendmakingen_search", { query: "best practices afvalinzameling" });
    expect(lower.access_note ?? "").not.toContain("authority: 'Best'");
  });

  it("keeps a quoted phrase and a slash citation intact through the query rewriter", async () => {
    const fetchMock = stubSru(() => xmlResponse(sruResponse([GMB_RECORD], 1730)));
    const phrase = await callTool("officiele_bekendmakingen_search", { query: 'Wat is "zorg en veiligheid"?' });
    await callTool("officiele_bekendmakingen_search", { query: "verordening 2016/679" });
    const queries = fetchMock.mock.calls.map((call) => new URL(String(call[0])).searchParams.get("query"));
    expect(queries[0]).toBe('"zorg en veiligheid" AND c.product-area="officielepublicaties"');
    expect(queries[1]).toBe('"2016/679" AND verordening AND c.product-area="officielepublicaties"');
    expect(phrase.access_note).toContain('Zoekterm herschreven: "Wat is "zorg en veiligheid"?" → ""zorg en veiligheid"".');
    expect(phrase.access_note ?? "").not.toContain("Stopwoorden");
  });

  it("puts the exact compound first and pages on positions, not on the distinct total", async () => {
    // The query rewriter lowercases; the index does not care.
    const exact = 'ov-visie AND c.product-area="officielepublicaties"';
    stubSru((url) =>
      xmlResponse(
        url.searchParams.get("query") === exact
          ? sruResponse([creatorRecord("kst-31305-412", "Tweede Kamer der Staten-Generaal")], 1)
          : sruResponse(
              [creatorRecord("kst-31305-412", "Tweede Kamer der Staten-Generaal"), creatorRecord("blg-907315", "Tweede Kamer der Staten-Generaal")],
              2,
            ),
      ),
    );
    const out = await callTool("officiele_bekendmakingen_search", { query: "OV-visie", top: 2 });
    expect(out.records.map((r: any) => r.data.identifier)).toEqual(["kst-31305-412"]);
    // Positions 1 (exact) + 2 (loose) = 3; the page covered 2 of them.
    expect(out.pagination).toEqual({ offset: 0, limit: 2, total: 2, has_more: true });
    expect(out.access_note).toContain("startRecord 3");
  });

  it("does not print a total the source did not give", async () => {
    stubSru(() => xmlResponse(sruResponse([GMB_RECORD, KST_RECORD], 0).replace("<sru:numberOfRecords>0</sru:numberOfRecords>", "")));
    const out = await callTool("officiele_bekendmakingen_search", { query: "afvalinzameling", top: 2 });
    expect(out.summary).toBe("2 bekendmakingen");
    expect(out.pagination).toMatchObject({ total: null, has_more: false });
    expect(out.access_note).toContain("het totaal is onbekend");
  });

  it("rejects an unknown authority_type in the schema", async () => {
    stubSru(() => xmlResponse(sruResponse([], 0)));
    const out = await callToolRaw("officiele_bekendmakingen_search", { query: "x", authority_type: "stadsdeel" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("authority_type");
  });
});

describe("officiele_bekendmakingen_record_get tool", () => {
  it("returns the record with links and a citation snippet", async () => {
    stubSru(() => xmlResponse(sruResponse([GMB_RECORD], 1)));
    const out = await callTool("officiele_bekendmakingen_record_get", { identifier: "gmb-2026-104512" });
    expect(out.records).toHaveLength(1);
    expect(out.records[0].snippet).toContain("Gemeenteblad 2026, 104512");
    expect(out.records[0].data.pdf_url).toContain("/pdf/gmb-2026-104512.pdf");
    expect(out.provenance.total_results).toBe(1);
  });

  it("says not found instead of returning an empty shell", async () => {
    stubSru(() => xmlResponse(sruResponse([], 0)));
    const out = await callTool("officiele_bekendmakingen_record_get", { identifier: "gmb-2099-1" });
    expect(out.records).toEqual([]);
    expect(out.summary).toBe("Bekendmaking gmb-2099-1 niet gevonden");
    expect(out.provenance.total_results).toBe(0);
  });

  it("names the record by its own identifier, whatever the case typed", async () => {
    stubSru((url) =>
      xmlResponse(url.searchParams.get("query")?.startsWith("dt.identifier==") ? sruResponse([], 0) : sruResponse([KST_RECORD], 1)),
    );
    const out = await callTool("officiele_bekendmakingen_record_get", { identifier: "KST-37020-IX-40" });
    expect(out.summary).toBe("Bekendmaking kst-37020-IX-40");
    expect(out.records[0].data.identifier).toBe("kst-37020-IX-40");
  });

  it("does not return a dossier member for a dossier number", async () => {
    stubSru((url) =>
      xmlResponse(
        url.searchParams.get("query")?.startsWith("dt.identifier==")
          ? sruResponse([], 0)
          : sruResponse([creatorRecord("kst-37020-IX-9", "Tweede Kamer der Staten-Generaal")], 40),
      ),
    );
    const out = await callTool("officiele_bekendmakingen_record_get", { identifier: "kst-37020-IX" });
    expect(out.records).toEqual([]);
    expect(out.summary).toBe("Bekendmaking kst-37020-IX niet gevonden");
    expect(out.access_note).toContain("kst-37020-IX-9");
  });

  it("does not fabricate a record when the source is unreachable", async () => {
    stubSru(() => new Response("nope", { status: 400 }));
    const out = await callTool("officiele_bekendmakingen_record_get", { identifier: "https://zoek.officielebekendmakingen.nl/kst-37020-IX-40.html" });
    expect(out.records).toEqual([]);
    expect(out.summary).toBe("Bekendmaking kst-37020-IX-40 niet opgehaald — bron niet bereikbaar");
    expect(out.failures[0].connector).toBe("officiele_bekendmakingen");
  });
});
