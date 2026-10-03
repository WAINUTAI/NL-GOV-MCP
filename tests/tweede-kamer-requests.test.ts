import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { TweedeKamerSource } from "../src/sources/tweede-kamer.js";
import { SourceRequestError } from "../src/utils/http.js";
import { clearHttpCache, getConnectorHealth, markConnectorSuccess } from "../src/utils/connector-runtime.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

/**
 * How searches reach the Gegevensmagazijn. A short whole-word term such as
 * "OV" (in "over") used to take three filter passes (count, ordered page and
 * an $expand for the links), time out at 30 s, be sent again identically while
 * the service was still running the first, fail after 60 s and count toward
 * the circuit breaker each time.
 */

type Payload = Record<string, any>;

async function callTool(name: string, args: Record<string, unknown>): Promise<Payload> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tk-requests-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }> };
    return JSON.parse(result.content[0].text) as Payload;
  } finally {
    await client.close();
    await server.close();
  }
}

const urlOf = (fetchMock: ReturnType<typeof vi.fn>, call: number) => new URL(String(fetchMock.mock.calls[call][0]));
/** What fetch rejects with when the request's AbortSignal fires (the timeout). */
const aborted = () => new DOMException("This operation was aborted", "AbortError");
const isLookup = (input: string) => (new URL(input).searchParams.get("$filter") ?? "").startsWith("Id in (");
/** The count before a search with a short term: same filters, plain contains(), no rows. */
const isProbe = (input: string) => new URL(input).searchParams.get("$top") === "0";
/** The search requests themselves: neither the count before nor the link lookup after. */
const searchUrls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => !isProbe(u) && !isLookup(u)).map((u) => new URL(u));
const counted = (rows: number) => jsonResponse({ "@odata.count": rows, value: [] });
/** Settles a source call to "resolved" or the SourceRequestError code. */
const outcome = (pending: Promise<unknown>) =>
  pending.then(
    () => "resolved",
    (error: unknown) => (error instanceof SourceRequestError ? error.code : String(error)),
  );

const DOC_ID = "eb749f13-9fed-43b6-b869-04027676d08a";
const DOC = {
  Id: DOC_ID,
  Soort: "Brief regering",
  DocumentNummer: "2026D40001",
  Titel: "Openbaar vervoer",
  Onderwerp: "Toekomst van het OV in de regio",
  Datum: "2026-09-30T00:00:00+02:00",
};
const ZAAK_ID = "64db5eb1-4ad8-4ee1-88c5-9960d34d6423";
const ZAAK = { Id: ZAAK_ID, Nummer: "2026Z18001", Soort: "Motie", Titel: "Openbaar vervoer", Onderwerp: "Motie over het OV" };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearHttpCache();
  // The breaker state is per process; failures from one test must not open it for the next.
  markConnectorSuccess("tweede_kamer", 0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a search is sent once", () => {
  it("reports a timeout instead of sending the same search again", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (isProbe(input)) return counted(278_727);
      throw aborted();
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_documents", { query: "OV", top: 5 });

    expect(searchUrls(fetchMock)).toHaveLength(1);
    expect(payload.error).toBe("timeout");
    expect(getConnectorHealth("tweede_kamer").consecutive_failures).toBe(1);
  });

  it("gives the search 40 s, not 30 s twice", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = vi.fn((input: string, init?: RequestInit) =>
      isProbe(input)
        ? Promise.resolve(counted(278_727))
        : // Hangs until the request's own timeout aborts it.
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(aborted()));
          }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const settled = outcome(new TweedeKamerSource(testConfig).searchDocuments({ query: "OV", top: 5 }));
    await vi.advanceTimersByTimeAsync(39_900);
    expect(searchUrls(fetchMock)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);

    expect(await settled).toBe("timeout");
    expect(searchUrls(fetchMock)).toHaveLength(1);
  });

  it("tries once more after a 5xx, which a second request can fix", async () => {
    let searches = 0;
    const fetchMock = vi.fn(async (input: string) => {
      if (isProbe(input)) return counted(278_727);
      if (isLookup(input)) return jsonResponse({ value: [{ Id: DOC_ID, Zaak: [] }] });
      searches += 1;
      return searches === 1 ? new Response("", { status: 503 }) : jsonResponse({ "@odata.count": 42, value: [DOC] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_documents", { query: "OV", top: 1 });

    expect(searches).toBe(2);
    const [first, second] = searchUrls(fetchMock);
    expect(second.searchParams.get("$filter")).toBe(first.searchParams.get("$filter"));
    expect(payload.error).toBeUndefined();
    expect(payload.pagination.total).toBe(42);
    expect(getConnectorHealth("tweede_kamer").consecutive_failures).toBe(0);
  });

  it("reports a 5xx that persists after the second request", async () => {
    const fetchMock = vi.fn(async (input: string) => (isProbe(input) ? counted(147_778) : new Response("", { status: 502 })));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_search", { entity: "Zaak", query: "OV" });

    expect(searchUrls(fetchMock)).toHaveLength(2);
    expect(payload.error).toBe("http_error");
  });

  it("does not repeat a 5xx that came after the service ran the query for over 20 s", async () => {
    // "OV": HTTP 500 after 30.2 s, the service giving up on the query itself.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fetchMock = vi.fn((input: string) =>
      isProbe(input)
        ? Promise.resolve(counted(278_727))
        : new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("", { status: 500 })), 30_200)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const settled = outcome(new TweedeKamerSource(testConfig).searchDocuments({ query: "OV", top: 5 }));
    await vi.advanceTimersByTimeAsync(35_000);

    expect(await settled).toBe("http_error");
    expect(searchUrls(fetchMock)).toHaveLength(1);
  });

  it("does the same for votes", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (isProbe(input)) return counted(961_512);
      throw aborted();
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_votes", { query: "OV", top: 5 });

    expect(searchUrls(fetchMock)).toHaveLength(1);
    expect(payload.error).toBe("timeout");
  });
});

describe("a short term is counted before it is searched", () => {
  it("gives letters that are in many rows fewer spellings, and says how many rows", async () => {
    // "ING" is three letters but in 383,504 Documents ("-ing"): with every spelling the
    // search took 27-33 s and timed out once at 40 s.
    const fetchMock = vi.fn(async (input: string) =>
      isProbe(input) ? counted(383_504) : isLookup(input) ? jsonResponse({ value: [] }) : jsonResponse({ "@odata.count": 0, value: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_documents", { query: "ING", top: 5 });

    const probe = urlOf(fetchMock, 0);
    expect(probe.pathname.endsWith("/Document")).toBe(true);
    expect(probe.searchParams.get("$count")).toBe("true");
    expect(probe.searchParams.get("$top")).toBe("0");
    expect(probe.searchParams.get("$filter")).toBe("(contains(Titel,'ING') or contains(Onderwerp,'ING'))");
    const [search] = searchUrls(fetchMock);
    const filter = search.searchParams.get("$filter")!;
    expect(filter).toContain("contains(concat(concat(' ',Titel),' '),' ING ')");
    expect(filter).toContain("contains(concat(' ',Onderwerp),' ING-')");
    expect(filter).not.toContain("'(ING)'");
    expect(payload.access_note).toContain("De letters staan in 383.504 records");
  });

  it("searches rare letters in every spelling the node budget allows", async () => {
    const fetchMock = vi.fn(async (input: string) => (isProbe(input) ? counted(4_951) : jsonResponse({ "@odata.count": 0, value: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_documents", { query: "ICT", top: 5 });

    const filter = searchUrls(fetchMock)[0].searchParams.get("$filter")!;
    expect(filter).toContain("'(ICT)'");
    expect(filter).toContain("'/ICT '");
    expect(filter).toContain("' ICT,'");
    expect(payload.access_note).not.toContain("Korte zoekterm");
  });

  it("goes ahead with three spellings when the service refuses the count", async () => {
    const fetchMock = vi.fn(async (input: string) =>
      isProbe(input) ? new Response("", { status: 400 }) : jsonResponse({ "@odata.count": 0, value: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_search", { entity: "Zaak", query: "ICT", top: 5 });

    expect(payload.error).toBeUndefined();
    const filter = searchUrls(fetchMock)[0].searchParams.get("$filter")!;
    expect(filter).toContain("'(ICT)'");
    expect(filter).not.toContain("'/ICT '");
    expect(payload.access_note).toContain("Zo'n korte lettercombinatie komt in veel woorden voor");
  });

  it("reports a count that times out at once, without sending the heavier search", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = vi.fn(
      (_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(aborted()));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const settled = outcome(new TweedeKamerSource(testConfig).getVotes({ query: "OV", top: 5 }));
    await vi.advanceTimersByTimeAsync(15_100);

    expect(await settled).toBe("timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isProbe(String(fetchMock.mock.calls[0][0]))).toBe(true);
    // One failure toward the circuit breaker, not two.
    expect(getConnectorHealth("tweede_kamer").consecutive_failures).toBe(1);
  });

  it("counts nothing for long terms, small entities or votes on one zaak", async () => {
    const fetchMock = vi.fn(async (_input: string) => jsonResponse({ "@odata.count": 0, value: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await callTool("tweede_kamer_documents", { query: "parkeerbeleid" });
    await callTool("tweede_kamer_search", { entity: "Persoon", query: "Bos" });
    await callTool("tweede_kamer_votes", { query: "OV", zaak_nummer: "2026Z15215" });

    expect(fetchMock.mock.calls.map((c) => String(c[0])).filter(isProbe)).toEqual([]);
  });
});

describe("links are looked up by Id after the search", () => {
  it("keeps the $expand off the search and builds the page link from the lookup", async () => {
    const fetchMock = vi.fn(async (input: string) =>
      isProbe(input)
        ? counted(278_727)
        : isLookup(input)
          ? jsonResponse({ value: [{ Id: DOC_ID, Zaak: [{ Id: ZAAK_ID, Nummer: "2026Z18001", Soort: "Brief regering" }] }] })
          : jsonResponse({ "@odata.count": 1, value: [DOC] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_documents", { query: "OV", top: 5 });

    // Count, search, lookup.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const search = urlOf(fetchMock, 1);
    expect(search.searchParams.get("$expand")).toBeNull();
    expect(search.searchParams.get("$count")).toBe("true");
    const lookup = urlOf(fetchMock, 2);
    expect(lookup.pathname.endsWith("/Document")).toBe(true);
    expect(lookup.searchParams.get("$filter")).toBe(`Id in (${DOC_ID})`);
    expect(lookup.searchParams.get("$select")).toBe("Id");
    expect(lookup.searchParams.get("$expand")).toBe("Zaak($select=Id,Nummer,Soort;$top=3)");

    const rec = payload.records[0];
    expect(rec.canonical_url).toBe("https://www.tweedekamer.nl/kamerstukken/detail?id=2026Z18001&did=2026D40001");
    expect(rec.data.Zaak).toEqual([{ Id: ZAAK_ID, Nummer: "2026Z18001", Soort: "Brief regering" }]);
    expect(payload.access_note).not.toContain("links naar de kamerstukpagina");
  });

  it("links a Zaak to its page through its newest document", async () => {
    const fetchMock = vi.fn(async (input: string) =>
      isProbe(input)
        ? counted(147_778)
        : isLookup(input)
          ? jsonResponse({ value: [{ Id: ZAAK_ID, Document: [{ Id: "d-9", DocumentNummer: "2026D47272", Soort: "Motie" }] }] })
          : jsonResponse({ "@odata.count": 1, value: [ZAAK] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_search", { entity: "Zaak", query: "OV" });

    expect(searchUrls(fetchMock)[0].searchParams.get("$expand")).toBeNull();
    expect(urlOf(fetchMock, 2).searchParams.get("$expand")).toContain("Document(");
    expect(payload.records[0].canonical_url).toBe("https://www.tweedekamer.nl/kamerstukken/detail?id=2026Z18001&did=2026D47272");
  });

  it("keeps the records and says so when the lookup fails", async () => {
    const fetchMock = vi.fn(async (input: string) =>
      isLookup(input) ? new Response("", { status: 404 }) : jsonResponse({ "@odata.count": 1, value: [DOC] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool("tweede_kamer_documents", { query: "OV", top: 5 });

    expect(payload.error).toBeUndefined();
    expect(payload.records).toHaveLength(1);
    // No zaak number: the direct download, still specific.
    expect(payload.records[0].canonical_url).toBe("https://www.tweedekamer.nl/downloads/document?id=2026D40001");
    expect(payload.access_note).toContain("links naar de kamerstukpagina's konden niet (allemaal) worden opgehaald");
  });

  it("does not look anything up for an empty page or an entity without page links", async () => {
    const fetchMock = vi.fn(async (_input: string) => jsonResponse({ "@odata.count": 0, value: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await callTool("tweede_kamer_documents", { query: "OV" });
    // The count and the search; no lookup.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((c) => String(c[0])).filter(isLookup)).toEqual([]);

    const persoon = vi.fn(async () => jsonResponse({ "@odata.count": 1, value: [{ Id: DOC_ID, Achternaam: "Bos" }] }));
    vi.stubGlobal("fetch", persoon);
    await callTool("tweede_kamer_search", { entity: "Persoon", query: "Bos" });
    expect(persoon).toHaveBeenCalledTimes(1);
  });
});
