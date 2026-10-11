import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RijksoverheidSource, rssSearchTerm } from "../src/sources/rijksoverheid.js";
import { createServer } from "../src/server.js";
import { clearHttpCache, getConnectorCategory } from "../src/utils/connector-runtime.js";
import { testConfig, xmlResponse } from "./helpers/config.js";

function item(origin: string, path: string, pubDate: string, title = path): string {
  return `<item>
    <title>${title}</title>
    <link>${origin}${path}</link>
    <description>Teaser van ${title}</description>
    <pubDate>${pubDate}</pubDate>
    <guid isPermaLink="false">doc-${Buffer.from(path).toString("hex").slice(-12)}</guid>
  </item>`;
}

function rss(origin: string, items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Zoeken</title><link>${origin}/</link>${items.join("")}</channel></rss>`;
}

const RK = "https://www.rekenkamer.nl";
const SCP = "https://www.scp.nl";

/** A feed as full as the platform ever returns it: 20 publications. */
function fullFeed(origin: string): string {
  return rss(
    origin,
    Array.from({ length: 20 }, (_, i) =>
      item(origin, `/documenten/2026/05/${String(i + 1).padStart(2, "0")}/rapport-${i + 1}`, `Fri, ${String(i + 1).padStart(2, "0")} May 2026 09:00:00 GMT`, `Rapport ${i + 1}`),
    ),
  );
}

function mockFetch(body: string) {
  const fetchMock = vi.fn(async () => xmlResponse(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentUrl(fetchMock: ReturnType<typeof vi.fn>, n = 0): URL {
  return new URL(String((fetchMock.mock.calls[n] as unknown as Array<unknown>)[0]));
}

function sentQuery(fetchMock: ReturnType<typeof vi.fn>, n = 0): Record<string, unknown> {
  return JSON.parse(sentUrl(fetchMock, n).searchParams.get("query") ?? "{}") as Record<string, unknown>;
}

describe("rijksoverheid_search stays as it was", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("requests exactly the same URLs as before the RSS source served other sites", async () => {
    const source = new RijksoverheidSource(testConfig);
    expect(source.requestUrl({ query: "stikstof" })).toBe(
      "https://www.rijksoverheid.nl/api/rss?query=%7B%22filters%22%3A%5B%7B%22field%22%3A%22content_type%22%2C%22values%22%3A%5B%22pro%3AnewsDocument%22%5D%2C%22type%22%3A%22all%22%7D%5D%2C%22resultSearchTerm%22%3A%22stikstof%22%2C%22pageTitle%22%3A%22Nieuws%22%7D",
    );
    expect(source.requestUrl({ query: "woningbouw", type: "all", date_from: "2026-07-01", date_to: "2026-07-31" })).toBe(
      "https://www.rijksoverheid.nl/api/rss?query=%7B%22filters%22%3A%5B%7B%22field%22%3A%22sort_date%22%2C%22values%22%3A%5B%7B%22name%22%3A%22specificPeriod%22%2C%22from%22%3A%222026-06-30T22%3A00%3A00.000Z%22%2C%22to%22%3A%222026-07-31T21%3A59%3A59.999Z%22%7D%5D%2C%22type%22%3A%22all%22%7D%5D%2C%22resultSearchTerm%22%3A%22woningbouw%22%2C%22pageTitle%22%3A%22Zoeken%22%7D",
    );

    const fetchMock = mockFetch(rss("https://www.rijksoverheid.nl", []));
    await source.search({ query: "stikstof", top: 20 });
    expect(String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0])).toBe(source.requestUrl({ query: "stikstof" }));
  });
});

describe("RijksoverheidSource.searchPublications", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it.each([
    ["rekenkamer", RK],
    ["scp", SCP],
  ] as const)("asks %s's own RSS platform for document pages only", async (site, origin) => {
    const fetchMock = mockFetch(rss(origin, []));
    await new RijksoverheidSource(testConfig).searchPublications({ site, query: "asielprocedure", top: 20 });

    const url = sentUrl(fetchMock);
    expect(url.origin + url.pathname).toBe(`${origin}/api/rss`);
    expect(sentQuery(fetchMock)).toEqual({
      // type "all" is required by the platform: without it the answer is HTTP 400.
      filters: [{ field: "content_type", values: ["pro:downloadDocument"], type: "all" }],
      resultSearchTerm: "asielprocedure",
      pageTitle: "Zoeken",
    });
  });

  it("sends the period as a sort_date range and an empty search term without a query", async () => {
    const fetchMock = mockFetch(rss(RK, []));
    await new RijksoverheidSource(testConfig).searchPublications({ site: "rekenkamer", top: 20, date_from: "2026-08-12", date_to: "2026-10-11" });

    const query = sentQuery(fetchMock);
    expect(query.resultSearchTerm).toBe("");
    expect(query.filters).toEqual([
      { field: "content_type", values: ["pro:downloadDocument"], type: "all" },
      { field: "sort_date", values: [{ name: "specificPeriod", from: "2026-08-11T22:00:00.000Z", to: "2026-10-11T21:59:59.999Z" }], type: "all" },
    ]);
  });

  it("cuts a search term the platform would answer with HTTP 500 at a whole word, and says so", async () => {
    const fetchMock = mockFetch(rss(RK, []));
    const long = Array.from({ length: 30 }, (_, i) => `woord${i}`).join(" ");
    const out = await new RijksoverheidSource(testConfig).searchPublications({ site: "rekenkamer", query: long, top: 20 });

    const term = String(sentQuery(fetchMock).resultSearchTerm);
    expect(term.length).toBeLessThanOrEqual(128);
    expect(long.startsWith(`${term} `)).toBe(true);
    expect(out.access_note).toContain("De zoekvraag is ingekort tot de eerste 128 tekens");
    expect(rssSearchTerm("stikstof")).toEqual({ term: "stikstof", cut: false });
  });

  it("maps a publication with the site's date, the path date and its kind", async () => {
    mockFetch(rss(RK, [item(RK, "/documenten/2026/05/20/beslistermijnen-in-de-asielprocedure", "Wed, 20 May 2026 09:00:00 GMT", "Beslistermijnen in de asielprocedure")]));
    const out = await new RijksoverheidSource(testConfig).searchPublications({ site: "rekenkamer", query: "asielprocedure", top: 20 });

    expect(out.items[0]).toMatchObject({
      title: "Beslistermijnen in de asielprocedure",
      url: `${RK}/documenten/2026/05/20/beslistermijnen-in-de-asielprocedure`,
      snippet: "Teaser van Beslistermijnen in de asielprocedure",
      date: "2026-05-20",
      date_source: "issued",
      url_date: "2026-05-20",
      type: "document",
    });
    expect(out.total).toBe(1);
    expect(out.params).toEqual({ site: "www.rekenkamer.nl", query: "asielprocedure", top: "20" });
    expect(out.access_note).toContain("Dit zijn alle 1 treffers.");
    expect(out.access_note).toContain("alleen titel, datum en teaser");
  });

  it("uses the Amsterdam day of a publication stamped late in the evening UTC", async () => {
    mockFetch(rss(SCP, [item(SCP, "/documenten/2026/10/05/mantelzorg-versterken", "Sun, 04 Oct 2026 22:01:00 GMT")]));
    const out = await new RijksoverheidSource(testConfig).searchPublications({ site: "scp", query: "mantelzorg", top: 20 });

    expect(out.items[0]).toMatchObject({ date: "2026-10-05", issued: "2026-10-04T22:01:00.000Z", url_date: "2026-10-05" });
  });

  it("drops error pages, the homepage and vacancies, and says so", async () => {
    mockFetch(
      rss(RK, [
        item(RK, "/error/404", "Mon, 01 Jun 2026 10:00:00 GMT", "Pagina niet gevonden"),
        item(RK, "/", "Mon, 01 Jun 2026 10:00:00 GMT", "Algemene Rekenkamer"),
        item(RK, "/werken-bij/vacatures/onderzoeker", "Mon, 01 Jun 2026 10:00:00 GMT", "Onderzoeker"),
        item(RK, "/documenten/2026/06/01/echt-rapport", "Mon, 01 Jun 2026 10:00:00 GMT", "Echt rapport"),
        item(RK, "/site/binaries/site-content/collections/documents/2026/06/01/rapport/rapport.pdf", "Mon, 01 Jun 2026 10:00:00 GMT", "Rapport (PDF)"),
      ]),
    );
    const out = await new RijksoverheidSource(testConfig).searchPublications({ site: "rekenkamer", query: "rapport", top: 20 });

    expect(out.items.map((x) => x.title)).toEqual(["Echt rapport", "Rapport (PDF)"]);
    expect(out.items[1].type).toBe("file");
    expect(out.total).toBe(2);
    expect(out.access_note).toContain("3 item(s) die geen publicatie zijn (foutpagina, homepage of vacature) weggelaten.");
  });

  it("does not present the 20 items of a full feed as the real total", async () => {
    mockFetch(fullFeed(SCP));
    const out = await new RijksoverheidSource(testConfig).searchPublications({ site: "scp", query: "zorg", top: 5 });

    expect(out.total).toBeNull();
    expect(out.items).toHaveLength(5);
    expect(out.available).toBe(20);
    expect(out.access_note).toContain("De feed zat vol (20 items)");
  });

  it("explains an empty result instead of reporting success, and a reversed range", async () => {
    mockFetch(rss(SCP, []));
    const out = await new RijksoverheidSource(testConfig).searchPublications({ site: "scp", query: "xyzzy", top: 20, date_from: "2026-09", date_to: "2026-01" });

    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.access_note).toContain('Geen publicaties van het Sociaal en Cultureel Planbureau gevonden via het RSS-zoekplatform van www.scp.nl (zoekterm "xyzzy"');
    expect(out.access_note).toContain("date_from ligt na date_to.");
  });

  it("describes a listing without search term as the newest publications", async () => {
    mockFetch(rss(RK, [item(RK, "/documenten/2026/10/09/parallel-audit", "Fri, 09 Oct 2026 08:00:00 GMT")]));
    const out = await new RijksoverheidSource(testConfig).searchPublications({ site: "rekenkamer", query: "  ", top: 20, date_from: "2026-08-12" });

    expect(out.params.query).toBe("");
    expect(out.access_note).toContain("Zonder zoekterm: de nieuwste publicaties (documentpagina's) van www.rekenkamer.nl");
  });

  it("ignores an invalid date with a warning instead of sending it", async () => {
    const fetchMock = mockFetch(rss(RK, [item(RK, "/documenten/2026/06/01/a", "Mon, 01 Jun 2026 10:00:00 GMT")]));
    const out = await new RijksoverheidSource(testConfig).searchPublications({ site: "rekenkamer", query: "a", top: 20, date_from: "vorige week" });

    expect((sentQuery(fetchMock).filters as unknown[]).length).toBe(1);
    expect(out.access_note).toMatch(/^Let op: date_from 'vorige week' is geen geldige datum/);
  });

  it("drops items outside the period if the platform ever ignores the filter", async () => {
    mockFetch(rss(RK, [item(RK, "/documenten/2026/06/01/in", "Mon, 01 Jun 2026 10:00:00 GMT", "in"), item(RK, "/documenten/2019/06/01/uit", "Sat, 01 Jun 2019 10:00:00 GMT", "uit")]));
    const out = await new RijksoverheidSource(testConfig).searchPublications({ site: "rekenkamer", query: "x", top: 20, date_from: "2026" });

    expect(out.items.map((x) => x.title)).toEqual(["in"]);
  });

  it("reads a path date without leading zeros, as on old Rekenkamer pages", async () => {
    mockFetch(rss(RK, [item(RK, "/documenten/1999/12/2/dienstpistolen", "Thu, 02 Dec 1999 00:00:00 GMT", "Dienstpistolen")]));
    const out = await new RijksoverheidSource(testConfig).searchPublications({ site: "rekenkamer", query: "dienstpistolen", top: 20 });

    expect(out.items[0]).toMatchObject({ date: "1999-12-02", url_date: "1999-12-02" });
  });

  it("treats a page that is no RSS feed as a failure, not as no results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html><html><body>Onderhoud</body></html>", { status: 200, headers: { "content-type": "text/html" } })));

    await expect(new RijksoverheidSource(testConfig).searchPublications({ site: "scp", query: "mantelzorg", top: 20 })).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("files the Rekenkamer and SCP connectors with their own circuits", () => {
    expect(getConnectorCategory("rekenkamer")).toBe("semi_live");
    expect(getConnectorCategory("scp")).toBe("semi_live");
  });
});

describe("rekenkamer_publicaties_search and scp_publicaties_search tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "rekenkamer-scp-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ type: string; text: string }>;
      };
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("lists both tools with descriptions within the length limit", async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "rekenkamer-scp-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      for (const name of ["rekenkamer_publicaties_search", "scp_publicaties_search"]) {
        const tool = tools.find((t) => t.name === name);
        expect(tool).toBeDefined();
        expect((tool?.description ?? "").length).toBeLessThan(2048);
        expect(tool?.inputSchema.required ?? []).toEqual([]);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns publication records with the official URL and provenance", async () => {
    mockFetch(rss(RK, [item(RK, "/documenten/2026/05/20/beslistermijnen-in-de-asielprocedure", "Wed, 20 May 2026 09:00:00 GMT", "Beslistermijnen in de asielprocedure")]));
    const out = await callTool("rekenkamer_publicaties_search", { query: "asielprocedure" });

    const records = out.records as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source_name: "rekenkamer",
      title: "Beslistermijnen in de asielprocedure",
      canonical_url: `${RK}/documenten/2026/05/20/beslistermijnen-in-de-asielprocedure`,
      date: "2026-05-20",
    });
    const provenance = out.provenance as Record<string, unknown>;
    expect(provenance.tool).toBe("rekenkamer_publicaties_search");
    expect(String(provenance.endpoint)).toMatch(/^https:\/\/www\.rekenkamer\.nl\/api\/rss\?query=/);
    expect(out.pagination).toMatchObject({ total: 1, has_more: false });
  });

  it("leaves total empty for a full feed but pages within it", async () => {
    mockFetch(fullFeed(SCP));
    const out = await callTool("scp_publicaties_search", { query: "zorg", top: 3, offset: 2, limit: 3 });

    expect(out.pagination).toEqual({ offset: 2, limit: 3, total: null, has_more: true });
    expect((out.records as Array<Record<string, unknown>>)[0].source_name).toBe("scp");
  });

  it("says what the page shows: part of the feed, or nothing past its end, never the count of records not on it", async () => {
    mockFetch(fullFeed(RK));
    const part = await callTool("rekenkamer_publicaties_search", { query: "zorg", offset: 5, limit: 5 });
    expect(part.summary).toBe("5 van 20 publicaties van de Algemene Rekenkamer (6-10)");
    const past = await callTool("rekenkamer_publicaties_search", { query: "zorg", offset: 9007199254740991 });
    expect(past.records).toEqual([]);
    expect(past.summary).toBe("Geen publicaties van de Algemene Rekenkamer op deze pagina: offset 9007199254740991 ligt voorbij de 20 opgehaalde");
  });

  it("refuses a query longer than a URL can carry instead of sending it", async () => {
    const fetchMock = mockFetch(fullFeed(SCP));
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "rss-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      for (const name of ["scp_publicaties_search", "rijksoverheid_search"]) {
        const result = (await client.callTool({ name, arguments: { query: "r".repeat(10_000) } })) as { isError?: boolean };
        expect(result.isError, name).toBe(true);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("works without a query", async () => {
    const fetchMock = mockFetch(rss(SCP, [item(SCP, "/documenten/2026/10/05/mantelzorg", "Sun, 04 Oct 2026 22:01:00 GMT")]));
    const out = await callTool("scp_publicaties_search", { date_from: "2026-08-12" });

    expect(sentQuery(fetchMock).resultSearchTerm).toBe("");
    expect(out.records as unknown[]).toHaveLength(1);
  });

  it("plans the request on the site's own host in a dry run", async () => {
    const fetchMock = mockFetch(rss(SCP, []));
    const out = await callTool("scp_publicaties_search", { query: "mantelzorg", date_from: "2026-07", dryRun: true });

    expect(fetchMock).not.toHaveBeenCalled();
    const planned = (out.planned_requests as Array<Record<string, unknown>>)[0];
    const url = new URL(String(planned.url));
    expect(url.origin + url.pathname).toBe(`${SCP}/api/rss`);
    expect(planned.connector).toBe("scp");
  });

  it("reports an upstream failure as an error, not as an empty result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404, headers: { "content-type": "text/html" } })));
    const out = await callTool("rekenkamer_publicaties_search", { query: "asielprocedure" });

    expect(out.error).toBeDefined();
    expect(out.records).toBeUndefined();
  });
});
