import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { assemblePages, OriSource, pageRanges, pagesWithTerm, parsePagina } from "../src/sources/ori.js";
import { clearHttpCache, getHttpCacheStats } from "../src/utils/connector-runtime.js";

const config = loadConfig();

const ALIASES = {
  ori_delft_20250407054803: { aliases: { ori_delft: {} } },
  ori_den_haag_20250408204203: { aliases: { ori_den_haag: {} } },
  ori_heemskerk_20250506181303: { aliases: {} },
  ori_heemskerk_20251120105722: { aliases: { ori_heemskerk: {} } },
};

const ORGS = {
  hits: {
    total: { value: 3, relation: "eq" },
    hits: [
      { _index: "ori_delft_20250407054803", _source: { name: "Gemeente Delft", classification: "Municipality" } },
      { _index: "ori_den_haag_20250408204203", _source: { name: "Gemeente Den Haag", classification: "Municipality" } },
      { _index: "ori_heemskerk_20251120105722", _source: { name: "Gemeente Heemskerk", classification: "Municipality" } },
    ],
  },
};

/** A public Delft council document (Rekenkamer research proposal on parking policy), text shortened. */
const DOC_SOURCE = {
  "@id": "1731608",
  "@type": "MediaObject",
  name: "Onderzoeksvoorstel DRK- parkeerbeleid",
  file_name: "Onderzoeksvoorstel DRK- parkeerbeleid.pdf",
  url: "https://api.openraadsinformatie.nl/v1/resolve/api.notubiz.nl/document/14846776",
  original_url: "https://api.notubiz.nl/document/14846776/1",
  content_type: "application/pdf",
  size_in_bytes: 109101,
  last_discussed_at: "2024-11-27T20:00:00+01:00",
  date_modified: "2024-11-22T09:57:30+01:00",
  is_referenced_by: "1731603",
};

const MD_PAGES = [
  "## Onderzoeksvoorstel Parkeerbeleid gemeente Delft\n\n### 1. Inleiding\n\nHet thema parkeren leeft in Nederlandse gemeenten. In het coalitieakkoord\n2022-2026 staat dat het autoluwe gebied wordt uitgebreid.",
  "### 2. Doel van het onderzoek\n\nDe Rekenkamer wil de gemeenteraad inzicht bieden in het parkeerbeleid en de parkeernormen.",
  "### 3. Planning\n\nHet onderzoek start in 2025; de gemeenteraad ontvangt het rapport na de zomer.",
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function docResponse(source: Record<string, unknown>, id = "1731608") {
  return { _index: "ori_delft_20250407054803", _type: "_doc", _id: id, _version: 1, found: true, _source: source };
}

function withPages(texts: string[], field: "md_text" | "text_pages" = "md_text") {
  return field === "md_text"
    ? { md_text: texts, text_pages: texts.map((_, i) => ({ page_number: i + 1 })) }
    : { text_pages: texts.map((text, i) => ({ text, page_number: i + 1 })) };
}

interface Call {
  url: URL;
  method: string;
  includes: string[];
}

/** Routes the index list, the organisation names and GET /<index>/_doc/<id>. */
function mockOri(doc: (call: Call) => Response | Promise<Response>, aliases: () => Response = () => json(ALIASES)) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const call: Call = { url, method: init?.method ?? "GET", includes: (url.searchParams.get("_source_includes") ?? "").split(",").filter(Boolean) };
      calls.push(call);
      if (url.pathname.endsWith("/_aliases")) return aliases();
      if (url.pathname.endsWith("/_search")) return json(ORGS);
      return doc(call);
    }),
  );
  const docCalls = () => calls.filter((c) => c.url.pathname.includes("/_doc/"));
  return { calls, docCalls };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearHttpCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ori_document_get helpers", () => {
  it("reads a page or a page range", () => {
    expect(parsePagina("3")).toEqual({ from: 3, to: 3 });
    expect(parsePagina(" 3 - 5 ")).toEqual({ from: 3, to: 5 });
    expect(parsePagina(4)).toEqual({ from: 4, to: 4 });
    expect(parsePagina("5-3")).toBeUndefined();
    expect(parsePagina("0")).toBeUndefined();
    expect(parsePagina("drie")).toBeUndefined();
  });

  it("writes page lists as ranges", () => {
    expect(pageRanges([1, 2, 3, 5, 7, 8])).toBe("1-3, 5, 7-8");
    expect(pageRanges([])).toBe("");
  });

  it("cuts at max_chars and says where to continue", () => {
    const pages = [{ page: 1, text: "a".repeat(50) }, { page: 2, text: "b".repeat(50) }, { page: 3, text: "c".repeat(50) }];
    const out = assemblePages(pages, 100, true);
    expect(out.text.length).toBe(100);
    expect(out.pagesReturned).toEqual([1, 2]);
    expect(out.truncated).toBe(true);
    expect(out.lastPartial).toBe(true);
    expect(out.nextPage).toBe(2);
    expect(out.text.startsWith("--- pagina 1 ---\n")).toBe(true);
  });

  it("matches a term without case or accents, and through lost ligatures", () => {
    const pages = [
      { page: 1, text: "Het Coëfficiënt-besluit" },
      { page: 2, text: "De warmtetransi�e en warmtene�en" },
    ];
    expect(pagesWithTerm(pages, "coefficient").pages.map((p) => p.page)).toEqual([1]);
    const lig = pagesWithTerm(pages, "warmtetransitie");
    expect(lig.pages.map((p) => p.page)).toEqual([2]);
    expect(pagesWithTerm(pages, "warmtenetten").hits).toBe(1);
    const words = pagesWithTerm(pages, "besluit coefficient");
    expect(words.allWords).toBe(true);
    expect(words.pages.map((p) => p.page)).toEqual([1]);
    expect(pagesWithTerm(pages, "parkeren").pages).toEqual([]);
  });
});

describe("OriSource.getDocument", () => {
  it("returns md_text page by page with metadata, fetching only the needed fields", async () => {
    const { docCalls } = mockOri(() => json(docResponse({ ...DOC_SOURCE, ...withPages(MD_PAGES) })));

    const out = await new OriSource(config).getDocument({ index: "ori_delft", id: "1731608" });

    const call = docCalls()[0];
    expect(call.url.href.startsWith("https://api.openraadsinformatie.nl/v1/elastic/ori_delft/_doc/1731608")).toBe(true);
    expect(call.includes).toContain("md_text");
    expect(call.includes).toContain("text_pages.page_number");
    expect(call.includes).not.toContain("text");
    expect(call.includes).not.toContain("text_pages");
    const item = out.item!;
    expect(item.index).toBe("ori_delft");
    expect(item.id).toBe("1731608");
    expect(item.title).toBe("Onderzoeksvoorstel DRK- parkeerbeleid");
    expect(item.organization).toBe("Delft");
    expect(item.url).toBe(DOC_SOURCE.url);
    expect(item.original_url).toBe(DOC_SOURCE.original_url);
    expect(item.ori_record_url).toBe("https://api.openraadsinformatie.nl/v1/elastic/ori_delft/_doc/1731608");
    expect(item.is_referenced_by).toBe("1731603");
    expect(item.text_format).toBe("markdown");
    expect(item.text_source).toBe("md_text");
    expect(item.page_count).toBe(3);
    expect(item.pages_returned).toBe("1-3");
    expect(item.text_truncated).toBe(false);
    expect(String(item.text)).toContain("--- pagina 2 ---\n### 2. Doel van het onderzoek");
    expect(item.text_chars).toBe(String(item.text).length);
    expect(out.access_note).toContain("automatische extractie");
  });

  it("keeps a document's text out of the shared HTTP cache", async () => {
    const { docCalls } = mockOri(() => json(docResponse({ ...DOC_SOURCE, ...withPages(MD_PAGES) })));
    const ori = new OriSource(config);
    await ori.getDocument({ index: "ori_delft", id: "1731608" });
    const before = getHttpCacheStats().bytes;
    await ori.getDocument({ index: "ori_delft", id: "1731608", pagina: "2" });

    // Fetched again, never served (and kept, megabytes at a time) from the response cache.
    expect(docCalls()).toHaveLength(2);
    expect(getHttpCacheStats().bytes).toBe(before);
  });

  it("states truncation and gives the page range to continue with", async () => {
    mockOri(() => json(docResponse({ ...DOC_SOURCE, ...withPages(MD_PAGES) })));

    const out = await new OriSource(config).getDocument({ index: "ori_delft", id: "1731608", max_chars: 260 });

    const item = out.item!;
    expect(item.text_truncated).toBe(true);
    expect(String(item.text).length).toBe(260);
    expect(item.pages_returned).toBe("1-2");
    expect(item.next_pagina).toBe("2-3");
    expect(out.access_note).toContain("Tekst afgekapt op 260 van");
    expect(out.access_note).toContain("pagina '2-3'");
  });

  it("does not send a reader back to a page that alone is longer than max_chars", async () => {
    mockOri(() => json(docResponse({ ...DOC_SOURCE, ...withPages(MD_PAGES) })));

    const out = await new OriSource(config).getDocument({ index: "ori_delft", id: "1731608", max_chars: 40 });

    expect(out.item!.pages_returned).toBe("1");
    expect(out.item!.next_pagina).toBe("2-3");
    expect(out.access_note).toContain("Pagina 1 alleen is al langer dan max_chars");
  });

  it("reads a page range, and says when a page does not exist", async () => {
    mockOri(() => json(docResponse({ ...DOC_SOURCE, ...withPages(MD_PAGES) })));
    const ori = new OriSource(config);

    const two = await ori.getDocument({ index: "ori_delft", id: "1731608", pagina: "2-3" });
    expect(two.item!.pages_returned).toBe("2-3");
    expect(String(two.item!.text)).not.toContain("Inleiding");

    const none = await ori.getDocument({ index: "ori_delft", id: "1731608", pagina: 9 });
    expect(none.item!.text).toBe("");
    expect(none.item!.pages_returned).toBe("");
    expect(none.access_note).toContain("Pagina 9 bestaat niet: het document heeft 3 pagina's");
  });

  it("returns only the pages that hold the zoekterm, with their page numbers", async () => {
    mockOri(() => json(docResponse({ ...DOC_SOURCE, ...withPages(MD_PAGES) })));
    const ori = new OriSource(config);

    const out = await ori.getDocument({ index: "ori_delft", id: "1731608", zoekterm: "Gemeenteraad" });
    expect(out.item!.zoekterm_pages).toBe("2-3");
    expect(out.item!.zoekterm_hits).toBe(2);
    expect(out.item!.pages_returned).toBe("2-3");
    expect(String(out.item!.text)).not.toContain("Inleiding");
    expect(out.access_note).toContain("'Gemeenteraad' komt 2 keer voor, op 2 van de 3 doorzochte pagina's");

    const missing = await ori.getDocument({ index: "ori_delft", id: "1731608", zoekterm: "fietsenstalling" });
    expect(missing.item!.zoekterm_pages).toBe("");
    expect(missing.item!.text).toBe("");
    expect(missing.access_note).toContain("'fietsenstalling' komt niet voor in de tekst");
  });

  it("falls back to the page texts when a document has no md_text", async () => {
    const { docCalls } = mockOri((call) =>
      call.includes.includes("md_text")
        ? json(docResponse({ ...DOC_SOURCE, text_pages: [{ page_number: 1 }, { page_number: 2 }] }))
        : json(docResponse(withPages(["Besluit van de raad.", "Ondertekening."], "text_pages"))),
    );

    const out = await new OriSource(config).getDocument({ index: "ori_delft", id: "1731608" });

    expect(docCalls()[1].includes).toEqual(["text_pages", "text"]);
    expect(out.item!.text_source).toBe("text_pages");
    expect(out.item!.text_format).toBe("text");
    expect(out.item!.text).toBe("--- pagina 1 ---\nBesluit van de raad.\n\n--- pagina 2 ---\nOndertekening.");
  });

  it("names pages without text instead of returning empty blocks", async () => {
    mockOri(() => json(docResponse({ ...DOC_SOURCE, ...withPages(["Aanhef.", "", " \n", "Ondertekening."]) })));

    const out = await new OriSource(config).getDocument({ index: "ori_delft", id: "1731608" });

    expect(out.item!.pages_without_text).toBe("2-3");
    expect(out.item!.pages_returned).toBe("1, 4");
    expect(out.access_note).toContain("Pagina 2-3 hebben geen tekst in ORI");
  });

  it("fills a page md_text left empty from ORI's plain page text", async () => {
    const { docCalls } = mockOri((call) =>
      call.includes.includes("md_text")
        ? json(docResponse({ ...DOC_SOURCE, ...withPages(["", "Aanhef.", ""]) }))
        : json(docResponse(withPages(["Onderzoeksvoorstel\nNovember 2024", "Aanhef.", ""], "text_pages"))),
    );

    const out = await new OriSource(config).getDocument({ index: "ori_delft", id: "1731608" });

    expect(docCalls()[1].includes).toEqual(["text_pages"]);
    expect(out.item!.pages_plain_text).toBe("1");
    expect(out.item!.pages_without_text).toBe("3");
    expect(out.item!.text).toBe("--- pagina 1 ---\nOnderzoeksvoorstel\nNovember 2024\n\n--- pagina 2 ---\nAanhef.");
    expect(out.access_note).toContain("Pagina 1 staat hier als platte tekst");
  });

  it("does not call an empty md_text page empty when the plain text fetch failed", async () => {
    mockOri((call) =>
      call.includes.includes("md_text") ? json(docResponse({ ...DOC_SOURCE, ...withPages(["", "Aanhef."]) })) : json({ error: "down" }, 503),
    );

    const out = await new OriSource(config).getDocument({ index: "ori_delft", id: "1731608" });

    expect(out.item!.pages_without_text).toBe("1");
    expect(out.access_note).toContain("dit zegt niet dat er geen tekst is");
    expect(out.access_note).not.toContain("die inhoud staat alleen in het bestand");
  });

  it("numbers md_text pages past the 100 pages text_pages covers", async () => {
    const md = Array.from({ length: 102 }, (_, i) => `Tekst van pagina ${i + 1}.`);
    mockOri(() => json(docResponse({ ...DOC_SOURCE, md_text: md, text_pages: md.slice(0, 100).map((_, i) => ({ page_number: i + 1 })) })));

    const out = await new OriSource(config).getDocument({ index: "ori_delft", id: "1731608", pagina: "101-102" });

    expect(out.item!.page_count).toBe(102);
    expect(out.item!.text).toBe("--- pagina 101 ---\nTekst van pagina 101.\n\n--- pagina 102 ---\nTekst van pagina 102.");
    expect(out.access_note).not.toContain("geen paginanummers");
  });

  it("says plainly that ORI extracted no text, and links the file", async () => {
    mockOri(() => json(docResponse({ ...DOC_SOURCE, md_text: ["", ""], text_pages: [{ page_number: 1 }, { page_number: 2 }] })));

    const out = await new OriSource(config).getDocument({ index: "ori_delft", id: "1731608" });

    expect(out.item!.text_available).toBe(false);
    expect(out.item!.text_unavailable_reason).toBe("no_extracted_text");
    expect(out.item!.text).toBeUndefined();
    expect(out.item!.page_count).toBe(2);
    expect(out.access_note).toContain("geen tekst gehaald");
    expect(out.access_note).toContain(DOC_SOURCE.url);
  });

  it("does not call a failed plain-text fetch 'no text'", async () => {
    mockOri((call) => (call.includes.includes("md_text") ? json(docResponse({ ...DOC_SOURCE })) : json({ error: "bad request" }, 400)));

    const out = await new OriSource(config).getDocument({ index: "ori_delft", id: "1731608" });

    expect(out.item!.text_unavailable_reason).toBe("text_fetch_failed");
    expect(out.access_note).toContain("dit zegt niet dat er geen tekst is");
  });

  it("returns the record without text when the text is past the response cap", async () => {
    const { docCalls } = mockOri((call) =>
      call.includes.includes("md_text")
        ? new Response(`{"_source":{"md_text":["${"x".repeat(12 * 1024 * 1024 + 10)}"]}}`, { status: 200 })
        : json(docResponse({ ...DOC_SOURCE, text_pages: [{ page_number: 1 }] })),
    );

    const out = await new OriSource(config).getDocument({ index: "ori_delft", id: "1731608" });

    expect(docCalls().some((c) => !c.includes.includes("md_text"))).toBe(true);
    expect(out.item!.text_unavailable_reason).toBe("text_too_large");
    expect(out.item!.url).toBe(DOC_SOURCE.url);
    expect(out.access_note).toContain("te groot");
  });

  it("explains that an agenda item has no text of its own and points to its documents", async () => {
    mockOri(() =>
      json(
        docResponse(
          { "@id": "1731603", "@type": "AgendaItem", name: "Delftse Rekenkamer", last_discussed_at: "2024-11-27T20:00:00+01:00", attachment: ["1731604", "1731608"] },
          "1731603",
        ),
      ),
    );

    const out = await new OriSource(config).getDocument({ index: "ori_delft", id: "1731603" });

    expect(out.item!.text_unavailable_reason).toBe("not_a_document");
    expect(out.item!.attachment_ids).toEqual(["1731604", "1731608"]);
    expect(out.access_note).toContain("agendapunt, geen document");
    expect(out.access_note).toContain("attachment_ids");
  });

  it("tells an unknown id from an unknown index", async () => {
    mockOri(() => json({ _index: "ori_delft_20250407054803", _type: "_doc", _id: "999", found: false }, 404));
    const ori = new OriSource(config);

    const id = await ori.getDocument({ index: "ori_delft", id: "999" });
    expect(id.item).toBeUndefined();
    expect(id.not_found).toBe("id");
    expect(id.access_note).toContain("ORI heeft geen record '999' in Delft (ori_delft)");

    const index = await ori.getDocument({ index: "ori_den-haag", id: "1" });
    expect(index.not_found).toBe("index");
    expect(index.access_note).toContain("Bedoeld is waarschijnlijk 'ori_den_haag' (Den Haag)");

    const copy = await ori.getDocument({ index: "ori_heemskerk", id: "5" });
    expect(copy.access_note).toContain("ori_heemskerk_20250506181303");
  });

  it("does not guess which part was wrong without the index list", async () => {
    mockOri(
      () => json({ error: { type: "index_not_found_exception" }, status: 404 }, 404),
      () => json({ error: "down" }, 500),
    );

    const out = await new OriSource(config).getDocument({ index: "ori_delft", id: "1" });

    expect(out.not_found).toBe("index_or_id");
    expect(out.access_note).toContain("de index of het id bestaat niet");
  });
});

describe("ori_document_get tool", () => {
  async function client() {
    const server = createServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: "test", version: "1" });
    await c.connect(b);
    return c;
  }

  it("returns one record with the document link as canonical URL", async () => {
    mockOri(() => json(docResponse({ ...DOC_SOURCE, ...withPages(MD_PAGES) })));
    const c = await client();

    const res = await c.callTool({ name: "ori_document_get", arguments: { index: "ori_delft", id: "1731608", pagina: "1" } });

    const sc = res.structuredContent as { summary: string; records: Array<Record<string, any>>; provenance: Record<string, any> };
    expect(sc.records).toHaveLength(1);
    expect(sc.records[0].canonical_url).toBe(DOC_SOURCE.url);
    expect(sc.records[0].data.pages_returned).toBe("1");
    expect(sc.summary).toContain("pagina 1 van 3");
    expect(sc.provenance.tool).toBe("ori_document_get");
    expect(sc.provenance.query_params).toMatchObject({ index: "ori_delft", id: "1731608", pagina: "1" });
  });

  it("rejects an index that is not an ORI index name, without a request", async () => {
    const { calls } = mockOri(() => json({}));
    const c = await client();

    for (const index of ["../_cat/indices", "Delft", "ori_delft/_search"]) {
      const res = await c.callTool({ name: "ori_document_get", arguments: { index, id: "1" } });
      expect(res.isError).toBe(true);
    }
    expect(calls.filter((x) => x.url.pathname.includes("/_doc/"))).toHaveLength(0);
  });

  it("rejects a page range that runs backwards or is out of bounds, without a request", async () => {
    const { calls } = mockOri(() => json({}));
    const c = await client();

    for (const pagina of ["5-3", "0", 1_000_000]) {
      const res = await c.callTool({ name: "ori_document_get", arguments: { index: "ori_delft", id: "1", pagina } });
      expect(res.isError).toBe(true);
    }
    expect(calls.filter((x) => x.url.pathname.includes("/_doc/"))).toHaveLength(0);
  });

  it("reports an ORI failure as an error, not as a missing document", async () => {
    mockOri(() => json({ error: "down" }, 503));
    const c = await client();

    const res = await c.callTool({ name: "ori_document_get", arguments: { index: "ori_delft", id: "1731608" } });

    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.error).toBe("http_error");
    expect(String(sc.suggestion)).toContain("zegt niet dat het document niet bestaat");
  });
});
