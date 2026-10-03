import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RijksoverheidSource } from "../src/sources/rijksoverheid.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { testConfig, xmlResponse } from "./helpers/config.js";

function item(path: string, pubDate: string, title = path): string {
  return `<item>
    <title>${title}</title>
    <link>https://www.rijksoverheid.nl${path}</link>
    <description>Omschrijving</description>
    <pubDate>${pubDate}</pubDate>
    <guid isPermaLink="false">doc-${Buffer.from(path).toString("hex").slice(-12)}</guid>
  </item>`;
}

function rss(items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Zoeken</title><link>https://www.rijksoverheid.nl/</link>${items.join("")}</channel></rss>`;
}

/** A feed as full as the platform ever returns it: 20 items. */
function fullFeed(): string {
  return rss(
    Array.from({ length: 20 }, (_, i) =>
      item(`/actueel/nieuws/2026/07/${String(i + 1).padStart(2, "0")}/bericht-${i + 1}`, `Wed, ${String(i + 1).padStart(2, "0")} Jul 2026 10:00:00 GMT`),
    ),
  );
}

function mockFetch(body: string) {
  const fetchMock = vi.fn(async () => xmlResponse(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The decoded JSON `query` parameter of the n-th request. */
function sentQuery(fetchMock: ReturnType<typeof vi.fn>, n = 0): Record<string, unknown> {
  const url = new URL(String((fetchMock.mock.calls[n] as unknown as Array<unknown>)[0]));
  return JSON.parse(url.searchParams.get("query") ?? "{}") as Record<string, unknown>;
}

function periodFilter(query: Record<string, unknown>): Record<string, unknown> | undefined {
  return (query.filters as Array<Record<string, unknown>>).find((f) => f.field === "sort_date");
}

describe("RijksoverheidSource.search: server-side date filter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("sends date_from/date_to as a sort_date range on Amsterdam day boundaries (summer time)", async () => {
    const fetchMock = mockFetch(rss([]));
    await new RijksoverheidSource(testConfig).search({ query: "woningbouw", top: 20, type: "all", date_from: "2026-07-01", date_to: "2026-07-31" });

    expect(periodFilter(sentQuery(fetchMock))).toEqual({
      field: "sort_date",
      values: [{ name: "specificPeriod", from: "2026-06-30T22:00:00.000Z", to: "2026-07-31T21:59:59.999Z" }],
      type: "all",
    });
  });

  it("uses winter-time boundaries and handles a range across the DST switch", async () => {
    const fetchMock = mockFetch(rss([]));
    await new RijksoverheidSource(testConfig).search({ query: "woningbouw", top: 20, type: "all", date_from: "2025-01-01", date_to: "2025-03-30" });

    // 2025-03-30 is the switch to summer time: that day ends at 22:00 UTC.
    expect(periodFilter(sentQuery(fetchMock))?.values).toEqual([
      { name: "specificPeriod", from: "2024-12-31T23:00:00.000Z", to: "2025-03-30T21:59:59.999Z" },
    ]);
  });

  it("keeps the news content_type filter next to the period filter", async () => {
    const fetchMock = mockFetch(rss([]));
    await new RijksoverheidSource(testConfig).search({ query: "woningbouw", top: 20, date_from: "2026-07-01" });

    const query = sentQuery(fetchMock);
    expect(query.pageTitle).toBe("Nieuws");
    expect(query.filters).toEqual([
      { field: "content_type", values: ["pro:newsDocument"], type: "all" },
      { field: "sort_date", values: [{ name: "specificPeriod", from: "2026-06-30T22:00:00.000Z" }], type: "all" },
    ]);
  });

  it("accepts a full ISO timestamp as a day", async () => {
    const fetchMock = mockFetch(rss([]));
    await new RijksoverheidSource(testConfig).search({ query: "woningbouw", top: 20, type: "all", date_to: "2026-07-31T08:00:00Z" });

    expect(periodFilter(sentQuery(fetchMock))?.values).toEqual([{ name: "specificPeriod", to: "2026-07-31T21:59:59.999Z" }]);
  });

  it("ignores an invalid date with a note instead of sending it (the platform answers 500)", async () => {
    const fetchMock = mockFetch(rss([item("/actueel/nieuws/2026/07/03/a", "Fri, 03 Jul 2026 10:00:00 GMT")]));
    const out = await new RijksoverheidSource(testConfig).search({ query: "woningbouw", top: 20, type: "all", date_from: "gisteren", date_to: "2026-02-30" });

    expect(periodFilter(sentQuery(fetchMock))).toBeUndefined();
    expect(out.items).toHaveLength(1);
    // The warning leads the note and the ignored values are not echoed as if applied.
    expect(out.access_note.startsWith("Let op: date_from 'gisteren' en date_to '2026-02-30' is geen geldige datum")).toBe(true);
    expect(out.params.date_from).toBeUndefined();
    expect(out.params.date_to).toBeUndefined();
  });

  it.each([
    ["2026", "2026", "2025-12-31T23:00:00.000Z", "2026-12-31T22:59:59.999Z", "2026-01-01", "2026-12-31"],
    ["2026-07", "2026-07", "2026-06-30T22:00:00.000Z", "2026-07-31T21:59:59.999Z", "2026-07-01", "2026-07-31"],
    ["2024-02", "2024-02", "2024-01-31T23:00:00.000Z", "2024-02-29T22:59:59.999Z", "2024-02-01", "2024-02-29"],
  ])("widens date_from=%s and date_to=%s to the whole year or month", async (from, to, fromIso, toIso, fromDay, toDay) => {
    const fetchMock = mockFetch(rss([]));
    const out = await new RijksoverheidSource(testConfig).search({ query: "woningbouw", top: 20, type: "all", date_from: from, date_to: to });

    expect(periodFilter(sentQuery(fetchMock))?.values).toEqual([{ name: "specificPeriod", from: fromIso, to: toIso }]);
    // Provenance shows the period actually applied.
    expect(out.params).toMatchObject({ date_from: fromDay, date_to: toDay });
    expect(out.access_note).toContain(`Gelezen: date_from '${from}' als ${fromDay}, date_to '${to}' als ${toDay}.`);
  });

  it("filters a widened month on the safety net too", async () => {
    mockFetch(
      rss([
        item("/service/juni", "Tue, 30 Jun 2026 12:00:00 GMT"),
        item("/service/juli", "Fri, 10 Jul 2026 12:00:00 GMT"),
        item("/service/augustus", "Sat, 01 Aug 2026 12:00:00 GMT"),
      ]),
    );
    const out = await new RijksoverheidSource(testConfig).search({ query: "woningbouw", top: 20, type: "all", date_from: "2026-07", date_to: "2026-07" });

    expect(out.items.map((x) => x.url)).toEqual(["https://www.rijksoverheid.nl/service/juli"]);
  });

  it.each(["2026-13", "2026-00", "26-07-2026", "juli 2026", "2026-7"])("rejects %s with a warning", async (value) => {
    const fetchMock = mockFetch(rss([]));
    const out = await new RijksoverheidSource(testConfig).search({ query: "woningbouw", top: 20, type: "all", date_from: value });

    expect(periodFilter(sentQuery(fetchMock))).toBeUndefined();
    expect(out.access_note).toContain(`Let op: date_from '${value}' is geen geldige datum`);
  });

  it("drops items outside the period if the platform ever ignores the filter, by Amsterdam calendar day", async () => {
    mockFetch(
      rss([
        // 30 June 23:30 in Amsterdam: before the period.
        item("/service/a", "Tue, 30 Jun 2026 21:30:00 GMT"),
        // 1 July 00:30 in Amsterdam: inside the period.
        item("/service/b", "Tue, 30 Jun 2026 22:30:00 GMT"),
        item("/service/c", "Fri, 31 Jul 2026 21:00:00 GMT"),
        // 1 August 00:30 in Amsterdam: after the period.
        item("/service/d", "Fri, 31 Jul 2026 22:30:00 GMT"),
      ]),
    );
    const out = await new RijksoverheidSource(testConfig).search({ query: "woningbouw", top: 20, type: "all", date_from: "2026-07-01", date_to: "2026-07-31" });

    expect(out.items.map((x) => x.url)).toEqual([
      "https://www.rijksoverheid.nl/service/b",
      "https://www.rijksoverheid.nl/service/c",
    ]);
    expect(out.total).toBe(2);
    expect(out.access_note).toContain("date_from/date_to filteren server-side op date");
  });

  it("exposes the request URL for dry runs", () => {
    const src = new RijksoverheidSource(testConfig);
    const url = new URL(src.requestUrl({ query: "woningbouw", type: "all", date_from: "2026-07-01" }));

    expect(url.origin + url.pathname).toBe("https://www.rijksoverheid.nl/api/rss");
    const query = JSON.parse(url.searchParams.get("query") ?? "{}") as Record<string, unknown>;
    expect(query.resultSearchTerm).toBe("woningbouw");
    expect(periodFilter(query)).toBeDefined();
  });
});

describe("RijksoverheidSource.search: totals", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("does not present the 20 items of a full feed as the real total", async () => {
    mockFetch(fullFeed());
    const out = await new RijksoverheidSource(testConfig).search({ query: "woningbouw", top: 5, type: "all" });

    expect(out.items).toHaveLength(5);
    expect(out.total).toBeNull();
    expect(out.available).toBe(20);
    expect(out.access_note).toContain("De feed zat vol (20 items)");
  });

  it("explains an empty result and points out a reversed date range", async () => {
    mockFetch(rss([]));
    const out = await new RijksoverheidSource(testConfig).search({ query: "woningbouw", top: 20, type: "all", date_from: "2026-10-01", date_to: "2026-09-01" });

    expect(out.total).toBe(0);
    expect(out.access_note).toContain('Geen resultaten via het Rijksoverheid RSS-zoekplatform voor "woningbouw" (type=all, vanaf 2026-10-01, t/m 2026-09-01)');
    expect(out.access_note).not.toContain("of type=all");
    expect(out.access_note).toContain("date_from ligt na date_to.");
  });

  it("reports the real total when the feed is not full", async () => {
    mockFetch(rss([item("/actueel/nieuws/2026/07/03/a", "Fri, 03 Jul 2026 10:00:00 GMT"), item("/documenten/2026/07/02/b", "Thu, 02 Jul 2026 10:00:00 GMT")]));
    const out = await new RijksoverheidSource(testConfig).search({ query: "woningbouw", top: 20, type: "all" });

    expect(out.total).toBe(2);
    expect(out.available).toBe(2);
    expect(out.access_note).toContain("Dit zijn alle 2 treffers.");
  });
});

describe("RijksoverheidSource.search: date and type per item", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  async function searchOne(path: string, pubDate: string) {
    mockFetch(rss([item(path, pubDate)]));
    const out = await new RijksoverheidSource(testConfig).search({ query: "woningbouw", top: 20, type: "all" });
    return out.items[0];
  }

  it("uses the date the site shows and keeps a document's path date as url_date", async () => {
    // A revised document: the page shows 'Brochure 04-09-2025' (the current version);
    // the path still dates the first version.
    const x = await searchOne("/documenten/2024/10/16/brochure-afvalscheiding", "Thu, 04 Sep 2025 00:00:00 GMT");

    expect(x.date).toBe("2025-09-04");
    expect(x.date_source).toBe("issued");
    expect(x.issued).toBe("2025-09-04T00:00:00.000Z");
    expect(x.url_date).toBe("2024-10-16");
    expect(x.type).toBe("document");
  });

  it("does not date a news item by its path, which precedes an embargoed release", async () => {
    // Live example: path 2024/06/25, page shows 'Nieuwsbericht 26-06-2024 | 09:00'.
    const x = await searchOne(
      "/actueel/nieuws/2024/06/25/dienst-toeslagen-attendeert-150.000-huishoudens-op-mogelijk-recht-op-zorgtoeslag",
      "Wed, 26 Jun 2024 07:00:00 GMT",
    );

    expect(x.date).toBe("2024-06-26");
    expect(x.date_source).toBe("issued");
    expect(x.url_date).toBeUndefined();
    expect(x.type).toBe("news");
  });

  it("falls back to a document's path date only when the feed has no pubDate", async () => {
    mockFetch(rss([`<item><title>t</title><link>https://www.rijksoverheid.nl/documenten/2024/05/06/rapport</link><guid>g</guid></item>`]));
    const out = await new RijksoverheidSource(testConfig).search({ query: "rapport", top: 20, type: "all" });

    expect(out.items[0]).toMatchObject({ date: "2024-05-06", date_source: "url_path", issued: "", url_date: "2024-05-06" });
  });

  it("uses the Amsterdam calendar date of issued when the path has no date", async () => {
    // Documents are stamped at local midnight: 23:00 UTC is the next day in Amsterdam.
    const x = await searchOne("/service/zorgtoeslag", "Sun, 05 Mar 2023 23:00:00 GMT");

    expect(x.date).toBe("2023-03-06");
    expect(x.date_source).toBe("issued");
    expect(x.issued).toBe("2023-03-05T23:00:00.000Z");
    expect(x.type).toBe("webpage");
  });

  it("does not read the week date of an agenda path as its publication date", async () => {
    const x = await searchOne("/actueel/agenda/2026/08/31/agenda-staatssecretaris-week-36", "Wed, 23 Sep 2026 09:16:34 GMT");

    expect(x.date).toBe("2026-09-23");
    expect(x.date_source).toBe("issued");
    expect(x.type).toBe("agenda");
  });

  it("ignores an impossible date in the path", async () => {
    const x = await searchOne("/documenten/2024/13/45/raar", "Mon, 01 Apr 2024 10:00:00 GMT");

    expect(x.date).toBe("2024-04-01");
    expect(x.date_source).toBe("issued");
    expect(x.url_date).toBeUndefined();
  });

  it("keeps an unparseable pubDate as it is and leaves date_source empty without one", async () => {
    const odd = await searchOne("/service/x", "binnenkort");
    expect(odd.date).toBe("binnenkort");
    expect(odd.issued).toBe("binnenkort");

    clearHttpCache();
    mockFetch(rss([`<item><title>t</title><link>https://www.rijksoverheid.nl/service/y</link><guid>g</guid></item>`]));
    const out = await new RijksoverheidSource(testConfig).search({ query: "zonderdatum", top: 20, type: "all" });
    expect(out.items[0]).toMatchObject({ date: "", date_source: "", issued: "" });
  });

  it.each([
    ["/actueel/nieuws/2026/07/03/bericht", "news", undefined],
    ["/ministeries/ministerie-van-defensie/nieuws/2024/01/02/bericht", "news", undefined],
    ["/documenten/videos/2023/03/02/uitleg-zorgtoeslag", "video", "2023-03-02"],
    ["/documenten/kamerstukken/2019/05/06/brief", "document", "2019-05-06"],
    ["/actueel/weblogs/bzers-wereldwijd/2026/fietsen-in-tokio", "weblog", undefined],
    ["/vraag-en-antwoord/veiligheidsregios-en-crisisbeheersing/wat-doet-een-veiligheidsregio", "question_and_answer", undefined],
    ["/themas/onderwijs/basisvaardigheden", "topic", undefined],
    ["/onderwerpen/fiets", "topic", undefined],
    ["/ministeries/ministerie-van-justitie-en-veiligheid/organisatie", "webpage", undefined],
    ["/regering/bewindspersonen/willemijn-aerdts", "webpage", undefined],
  ])("classifies %s as %s", async (path, type, urlDate) => {
    const x = await searchOne(path, "Fri, 10 Jul 2026 10:00:00 GMT");

    expect(x.type).toBe(type);
    expect(x.date).toBe("2026-07-10");
    expect(x.date_source).toBe("issued");
    expect(x.url_date).toBe(urlDate);
  });
});

describe("rijksoverheid_search tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  async function callTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "rijksoverheid-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({ name: "rijksoverheid_search", arguments: args })) as {
        content: Array<{ type: string; text: string }>;
      };
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("leaves total empty for a full feed but still reports has_more within the feed", async () => {
    mockFetch(fullFeed());
    const out = await callTool({ query: "stikstof", type: "all", top: 3, offset: 2, limit: 3 });

    expect(out.pagination).toEqual({ offset: 2, limit: 3, total: null, has_more: true });
    expect((out.provenance as Record<string, unknown>).total_results).toBeUndefined();
    expect(out.records as unknown[]).toHaveLength(3);
  });

  it("reports has_more false at the end of a full feed", async () => {
    mockFetch(fullFeed());
    const out = await callTool({ query: "stikstof", type: "all", offset: 15, limit: 10 });

    expect(out.pagination).toEqual({ offset: 15, limit: 10, total: null, has_more: false });
    expect(out.records as unknown[]).toHaveLength(5);
  });

  it("uses the site's own date as record date, the same date the filter uses", async () => {
    mockFetch(rss([item("/documenten/2024/10/16/brochure-afvalscheiding", "Thu, 04 Sep 2025 00:00:00 GMT", "Brochure afvalscheiding")]));
    const out = await callTool({ query: "stikstof", type: "all", date_from: "2025-09-01", date_to: "2025-09-30" });

    const records = out.records as Array<Record<string, unknown>>;
    expect(records[0].date).toBe("2025-09-04");
    const data = records[0].data as Record<string, unknown>;
    expect(data.type).toBe("document");
    expect(data.url_date).toBe("2024-10-16");
    expect(out.pagination).toMatchObject({ total: 1, has_more: false });
  });

  it("does not report an ignored date filter in the provenance", async () => {
    mockFetch(rss([item("/actueel/nieuws/2026/07/03/a", "Fri, 03 Jul 2026 10:00:00 GMT")]));
    const out = await callTool({ query: "stikstof", date_from: "gisteren", date_to: "2026-07" });

    const params = (out.provenance as Record<string, unknown>).query_params as Record<string, unknown>;
    expect(params.date_from).toBeUndefined();
    expect(params.date_to).toBe("2026-07-31");
    expect(String(out.access_note)).toMatch(/^Let op: date_from 'gisteren'/);
  });

  it("reports a rewritten query and leaves plain keywords unremarked", async () => {
    mockFetch(rss([item("/actueel/nieuws/2026/07/03/fietspaden", "Fri, 03 Jul 2026 10:00:00 GMT")]));
    const rewritten = await callTool({ query: "Wat is het beleid over fietspaden?" });
    expect(String(rewritten.access_note).startsWith('Zoekterm herschreven: "Wat is het beleid over fietspaden?" → "beleid over fietspaden".')).toBe(true);

    clearHttpCache();
    mockFetch(rss([item("/actueel/nieuws/2026/07/03/fietspaden", "Fri, 03 Jul 2026 10:00:00 GMT")]));
    const plain = await callTool({ query: "fietspaden" });
    expect(String(plain.access_note ?? "")).not.toContain("Zoekterm herschreven");
  });

  it("plans the real RSS request with the period filter in a dry run", async () => {
    const fetchMock = mockFetch(rss([]));
    const out = await callTool({ query: "stikstof", type: "all", date_from: "2026-07-01", dryRun: true });

    expect(fetchMock).not.toHaveBeenCalled();
    const planned = (out.planned_requests as Array<Record<string, unknown>>)[0];
    const url = new URL(String(planned.url));
    expect(url.origin + url.pathname).toBe("https://www.rijksoverheid.nl/api/rss");
    const query = JSON.parse(url.searchParams.get("query") ?? "{}") as Record<string, unknown>;
    expect(periodFilter(query)).toBeDefined();
  });
});
