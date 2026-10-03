import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { TenderNedSource } from "../src/sources/tenderned.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

/** A date `offset` days from now, as TenderNed prints closing dates. */
const day = (offset: number) => `${new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)}T12:00:00`;

type Row = Record<string, unknown> & { publicatieId: string };

/**
 * TenderNed as observed: the search index keeps the closing date of the
 * original notice; the detail record (/publicaties/{id}) carries the date
 * after the latest rectification.
 */
function upstream(rows: Row[], details: Record<string, Record<string, unknown> | number> = {}) {
  return vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/publicaties")) return jsonResponse({ content: rows, totalElements: rows.length });
    if (url.pathname.endsWith("/gerelateerd")) return jsonResponse([]);
    if (url.pathname.endsWith("/html")) return jsonResponse({ html: '<table><tr class="header1"><th>1. Koper</th></tr></table>' });
    const id = url.pathname.split("/").pop() ?? "";
    const detail = details[id];
    if (typeof detail === "number") return jsonResponse({ message: "nope" }, detail);
    const row = rows.find((r) => r.publicatieId === id);
    return jsonResponse(
      detail ?? {
        publicatieId: Number(id),
        aankondigingCode: row?.typePublicatie,
        sluitingsDatum: row?.sluitingsDatum,
        sluitingsDatumMarktconsultatie: row?.sluitingsDatumMarktconsultatie,
      },
    );
  });
}

const detailCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map((c) => new URL((c as unknown as [string])[0]).pathname).filter((p) => /\/publicaties\/\d+$/.test(p));

const AAO = { code: "AAO", omschrijving: "Aankondiging opdracht" };

describe("TenderNedSource.search closing dates", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("shows the deadline after a rectification instead of the index's original one", async () => {
    // Shaped like 452210: the index says closed 68 days ago, the detail record says still open.
    const indexed = day(-68);
    const rectified = day(6);
    vi.stubGlobal(
      "fetch",
      upstream(
        [
          { publicatieId: "452210", typePublicatie: AAO, sluitingsDatum: indexed },
          { publicatieId: "2", typePublicatie: AAO, sluitingsDatum: day(20) },
        ],
        { "452210": { publicatieId: 452210, aankondigingCode: AAO, sluitingsDatum: rectified, publicatieIDLaatsteRectificatie: 455501 } },
      ),
    );

    const out = await new TenderNedSource(testConfig).search({ query: "afvalinzameling", rows: 5 });
    expect(out.items[0]).toMatchObject({
      sluitingsDatum: rectified,
      sluitingsDatumOorspronkelijk: indexed,
      sluitingsDatumGecontroleerd: true,
      laatsteRectificatieId: "455501",
    });
    expect(out.items[1]).toMatchObject({ sluitingsDatum: day(20), sluitingsDatumGecontroleerd: true });
    expect(out.items[1].sluitingsDatumOorspronkelijk).toBeUndefined();
    expect(out.access_note).toContain("sluitings_datum van 2 publicatie(s)");
    expect(out.access_note).toContain("bij 1 daarvan week de zoekindex af");
    expect(out.access_note).not.toContain("ongecontroleerd");
  });

  it("does not re-check old, placeholder or missing deadlines, and says what an unchecked date is", async () => {
    const fetchMock = upstream([
      { publicatieId: "75261", typePublicatie: AAO, sluitingsDatum: "2016-03-30T12:00:00" },
      { publicatieId: "410077", typePublicatie: AAO, sluitingsDatum: "2125-12-31T13:00:00" },
      { publicatieId: "3", typePublicatie: { code: "AGO", omschrijving: "Aankondiging gegunde opdracht" } },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TenderNedSource(testConfig).search({ rows: 5 });
    expect(detailCalls(fetchMock)).toEqual([]);
    expect(out.items.map((i) => i.sluitingsDatumGecontroleerd)).toEqual([false, false, false]);
    expect(out.access_note).toContain("Bij 1 publicatie(s) komt sluitings_datum ongecontroleerd uit de zoekindex");
    expect(out.access_note).toContain("tenderned_aanbesteding_get");
  });

  it("re-checks at most 50 notices per call, latest deadlines first", async () => {
    // Ids 1..60 with deadlines from 150 days ago (id 1) up to 27 days ahead (id 60).
    const rows = Array.from({ length: 60 }, (_, i) => ({ publicatieId: String(i + 1), typePublicatie: AAO, sluitingsDatum: day(3 * i - 150) }));
    const fetchMock = upstream(rows);
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TenderNedSource(testConfig).search({ rows: 100 });
    expect(detailCalls(fetchMock)).toHaveLength(50);
    const checked = out.items.filter((i) => i.sluitingsDatumGecontroleerd).map((i) => Number(i.id));
    expect(Math.min(...checked)).toBe(11);
    expect(checked).toHaveLength(50);
    expect(out.access_note).toContain("Bij 10 publicatie(s) komt sluitings_datum ongecontroleerd");
  });

  it("keeps the indexed date, marked unchecked, when the detail record cannot be read", async () => {
    vi.stubGlobal("fetch", upstream([{ publicatieId: "9", typePublicatie: AAO, sluitingsDatum: day(5) }], { "9": 404 }));
    const out = await new TenderNedSource(testConfig).search({ rows: 5 });
    expect(out.items[0]).toMatchObject({ sluitingsDatum: day(5), sluitingsDatumGecontroleerd: false });
    expect(out.access_note).toContain("ongecontroleerd");
  });

  it("reads a market consultation's detail deadline from the same field as get", async () => {
    const MAC = { code: "MAC", omschrijving: "Marktconsultatie" };
    vi.stubGlobal(
      "fetch",
      upstream(
        [{ publicatieId: "450123", typePublicatie: MAC, sluitingsDatum: "2099-12-31T09:00:00", sluitingsDatumMarktconsultatie: day(3) }],
        { "450123": { aankondigingCode: MAC, sluitingsDatum: "2099-12-31T09:00:00", sluitingsDatumMarktconsultatie: day(9) } },
      ),
    );
    const [item] = (await new TenderNedSource(testConfig).search({ rows: 5 })).items;
    expect(item).toMatchObject({
      sluitingsDatum: day(9),
      sluitingsDatumBron: "sluitingsDatumMarktconsultatie",
      sluitingsDatumOorspronkelijk: day(3),
      sluitingsDatumPlaceholder: false,
    });
  });
});

describe("TenderNedSource.get rectification", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("says the closing date is the one after the latest rectification", async () => {
    vi.stubGlobal(
      "fetch",
      upstream([], { "452210": { publicatieId: 452210, aankondigingCode: AAO, sluitingsDatum: day(6), publicatieIDLaatsteRectificatie: 455501 } }),
    );
    const out = await new TenderNedSource(testConfig).get({ publicatieId: "452210" });
    expect(out.item.laatsteRectificatieId).toBe("455501");
    expect(out.item.sluitingsDatumGecontroleerd).toBe(true);
    expect(out.access_note).toContain("gerectificeerd (laatste rectificatie 455501)");
  });

  it("adds no rectification note to a notice that was never rectified", async () => {
    vi.stubGlobal("fetch", upstream([], { "1": { publicatieId: 1, aankondigingCode: AAO, sluitingsDatum: day(6) } }));
    const out = await new TenderNedSource(testConfig).get({ publicatieId: "1" });
    expect(out.access_note ?? "").not.toContain("gerectificeerd");
  });
});

describe("search and get agree on a rectified closing date", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

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

  it("returns the same sluitings_datum from both tools", async () => {
    vi.stubGlobal(
      "fetch",
      upstream([{ publicatieId: "452210", typePublicatie: AAO, sluitingsDatum: day(-68), publicatieDatum: "2026-06-13" }], {
        "452210": { publicatieId: 452210, aankondigingCode: AAO, sluitingsDatum: day(6), publicatieIDLaatsteRectificatie: 455501, publicatieDatum: "2026-06-13T15:12:04" },
      }),
    );
    const search = await callTool("tenderned_aanbestedingen_search", { query: "afvalinzameling", top: 5 });
    const hit = (search.records as Array<{ data: Record<string, unknown> }>)[0].data;
    const get = await callTool("tenderned_aanbesteding_get", { publicatie_id: "452210" });
    const detail = (get.records as Array<{ data: Record<string, unknown> }>)[0].data;

    expect(hit).toMatchObject({
      sluitings_datum: day(6),
      sluitings_datum_oorspronkelijk: day(-68),
      sluitings_datum_gecontroleerd: true,
      laatste_rectificatie_id: "455501",
    });
    expect(detail).toMatchObject({ sluitings_datum: day(6), sluitings_datum_gecontroleerd: true, laatste_rectificatie_id: "455501" });
  });
});
