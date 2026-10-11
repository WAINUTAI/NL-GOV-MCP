import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("../src/utils/pdf-text.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/pdf-text.js")>();
  return { ...actual, fetchPdfText: vi.fn() };
});

import {
  cleanWodcQuery,
  fileKind,
  findPassages,
  normalizeRepositoryText,
  parseWodcDate,
  parseWodcId,
  pickMainFile,
  planWodcWindow,
  toWodcItem,
  WODC_REPOSITORY_TEXT_LIMIT,
  type WodcFile,
} from "../src/sources/wodc.js";
import { fetchPdfText } from "../src/utils/pdf-text.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { jsonResponse } from "./helpers/config.js";

const API = "https://repository.wodc.nl/server/api";
const SEARCH = `${API}/discover/search/objects`;
const UUID = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";

const pdfMock = vi.mocked(fetchPdfText);

function md(values: Record<string, string[]>): Record<string, Array<{ value: string }>> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.map((value) => ({ value }))]));
}

/** A small, neutral DSpace item. */
function item(over: Record<string, unknown> = {}, meta: Record<string, string[]> = {}): Record<string, unknown> {
  return {
    id: UUID,
    uuid: UUID,
    name: "Recidive onder justitiabelen",
    handle: "20.500.12832/1001",
    withdrawn: false,
    metadata: md({
      "dc.title": ["Recidive onder justitiabelen"],
      "dc.title.alternative": ["Een verkenning"],
      "dc.title.english": ["Reoffending among offenders"],
      "dc.contributor.author": ["Jansen, A.", "Bakker, B.", "Visser, C."],
      "dc.contributor.institution": ["WODC"],
      "dc.date.issued": ["2025-03-14"],
      "dc.relation.ispartofseries": ["Cahier 2025-01"],
      "dc.identifier.project": ["3001a"],
      "dc.identifier.uri": ["https://repository.wodc.nl/handle/20.500.12832/1001"],
      "dc.type": ["Rapport"],
      "dc.subject": ["R::Recidive", "J::Jeugdigen"],
      "dc.description.abstract": ["Dit onderzoek beschrijft de recidive van justitiabelen. ".repeat(20).trim()],
      "dc.relation.uri": ["https://www.wodc.nl/actueel/nieuws/2025/03/14/recidive", "https://example.org/elders.pdf"],
      ...meta,
    }),
    ...over,
  };
}

function searchPage(items: Record<string, unknown>[], total: number) {
  return jsonResponse({
    _embedded: {
      searchResult: {
        page: { number: 0, size: items.length, totalElements: total },
        _embedded: { objects: items.map((indexableObject) => ({ hitHighlights: null, _embedded: { indexableObject } })) },
      },
    },
  });
}

function bitstream(uuid: string, name: string, sizeBytes: number) {
  return { uuid, name, sizeBytes, _links: { content: { href: `${API}/core/bitstreams/${uuid}/content` } } };
}

function withBundles(raw: Record<string, unknown>, bundles: Array<{ name: string; bitstreams: ReturnType<typeof bitstream>[] }>) {
  return {
    ...raw,
    _embedded: {
      bundles: {
        _embedded: {
          bundles: bundles.map((b) => ({
            name: b.name,
            _embedded: { bitstreams: { page: { totalElements: b.bitstreams.length }, _embedded: { bitstreams: b.bitstreams } } },
          })),
        },
      },
    },
  };
}

const REPORT = bitstream("aaaaaaaa-0000-0000-0000-000000000001", "rapport-recidive.pdf", 2_000_000);
const SUMMARY = bitstream("aaaaaaaa-0000-0000-0000-000000000002", "samenvatting-recidive.pdf", 200_000);
const LETTER = bitstream("aaaaaaaa-0000-0000-0000-000000000003", "aanbiedingsbrief-recidive.pdf", 90_000);
const REPORT_TXT = bitstream("bbbbbbbb-0000-0000-0000-000000000001", "rapport-recidive.pdf.txt", 50_000);
const SUMMARY_TXT = bitstream("bbbbbbbb-0000-0000-0000-000000000002", "samenvatting-recidive.pdf.txt", 5_000);

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain;charset=UTF-8" } });
}

function notFound(): Response {
  return jsonResponse({ status: 404, error: "Not Found" }, 404);
}

/** fetch mock routing on the URL; records every URL requested. */
function routedFetch(handler: (url: URL) => Response) {
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      urls.push(url);
      return handler(url);
    }),
  );
  return urls;
}

type Payload = Record<string, any>;

async function callTool(name: string, args: Record<string, unknown>): Promise<Payload> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "wodc-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }> };
    return JSON.parse(result.content[0].text) as Payload;
  } finally {
    await client.close();
    await server.close();
  }
}

beforeEach(() => {
  vi.unstubAllGlobals();
  pdfMock.mockReset();
  clearHttpCache();
});

describe("WODC helpers", () => {
  it("keeps words, phrases, -word and OR in a query and removes syntax the repository rejects", () => {
    expect(cleanWodcQuery('"huiselijk geweld" -jeugd')).toEqual({ query: '"huiselijk geweld" -jeugd', removed: [] });
    expect(cleanWodcQuery("(recidive")).toEqual({ query: "recidive", removed: ["("] });
    expect(cleanWodcQuery("art:12 c++").query).toBe("art 12 c");
    expect(cleanWodcQuery('"open einde').query).toBe("open einde");
    expect(cleanWodcQuery("recidive OR").query).toBe("recidive");
    expect(cleanWodcQuery("recidive OR jeugd").query).toBe("recidive OR jeugd");
    expect(cleanWodcQuery("  ").query).toBeUndefined();
    expect(cleanWodcQuery("~").query).toBeUndefined();
  });

  it("accepts a year, a month or a day as date and rejects the rest", () => {
    expect(parseWodcDate("date_from", "2024")).toBe("2024");
    expect(parseWodcDate("date_from", "2024-03")).toBe("2024-03");
    expect(parseWodcDate("date_to", "2024-02-29")).toBe("2024-02-29");
    expect(parseWodcDate("date_to", undefined)).toBeUndefined();
    expect(() => parseWodcDate("date_from", "2025-13")).toThrow(/geen datum/);
    expect(() => parseWodcDate("date_from", "2023-02-29")).toThrow(/geen datum/);
    expect(() => parseWodcDate("date_from", "14 maart")).toThrow(/geen datum/);
  });

  it("maps an offset window onto page and size", () => {
    expect(planWodcWindow(0, 20)).toEqual({ size: 20, pages: [0], skip: 0 });
    expect(planWodcWindow(20, 3)).toEqual({ size: 4, pages: [5], skip: 0 });
    expect(planWodcWindow(5, 10)).toEqual({ size: 15, pages: [0], skip: 5 });
    // No page holds 150-249: two pages of 50 instead of two of 100.
    expect(planWodcWindow(150, 100)).toEqual({ size: 50, pages: [3, 4], skip: 0 });
    expect(planWodcWindow(10, 100)).toEqual({ size: 55, pages: [0, 1], skip: 10 });
  });

  it("reads a uuid, a handle or a repository URL as item id", () => {
    expect(parseWodcId(UUID.toUpperCase())).toEqual({ uuid: UUID });
    expect(parseWodcId(`https://repository.wodc.nl/items/${UUID}`)).toEqual({ uuid: UUID });
    expect(parseWodcId(`https://repository.wodc.nl/entities/publication/${UUID}`)).toEqual({ uuid: UUID });
    expect(parseWodcId("https://repository.wodc.nl/handle/20.500.12832/1001")).toEqual({ handle: "20.500.12832/1001" });
    expect(parseWodcId("hdl:20.500.12832/1001")).toEqual({ handle: "20.500.12832/1001" });
    expect(parseWodcId("https://hdl.handle.net/20.500.12832/1001")).toEqual({ handle: "20.500.12832/1001" });
    expect(parseWodcId("1001")).toEqual({ handle: "20.500.12832/1001" });
    expect(() => parseWodcId("Cahier 2025-01")).toThrow(/geen WODC-item/);
    // A link from another site is never read for the handle or uuid in it.
    expect(() => parseWodcId("https://evil.example.com/handle/20.500.12832/1001")).toThrow(/geen link naar de WODC-repository \(host evil\.example\.com\)/);
    expect(() => parseWodcId(`https://evil.example.com/items/${UUID}`)).toThrow(/geen link naar de WODC-repository/);
  });

  it("maps DSpace metadata to a report", () => {
    const x = toWodcItem(item());
    expect(x).toMatchObject({
      uuid: UUID,
      handle: "20.500.12832/1001",
      title: "Recidive onder justitiabelen",
      subtitle: "Een verkenning",
      title_english: "Reoffending among offenders",
      authors: ["Jansen, A.", "Bakker, B.", "Visser, C."],
      issued: "2025-03-14",
      series: ["Cahier 2025-01"],
      projectnummers: ["3001a"],
      subjects: ["Recidive", "Jeugdigen"],
      url: "https://repository.wodc.nl/handle/20.500.12832/1001",
      item_url: `https://repository.wodc.nl/items/${UUID}`,
      news_urls: ["https://www.wodc.nl/actueel/nieuws/2025/03/14/recidive"],
      related_urls: ["https://example.org/elders.pdf"],
    });
    // Without dc.identifier.uri the handle gives the canonical URL.
    expect(toWodcItem(item({}, { "dc.identifier.uri": [] })).url).toBe("https://repository.wodc.nl/handle/20.500.12832/1001");
  });

  it("joins the lines of the repository's text and keeps paragraphs", () => {
    expect(normalizeRepositoryText("Eerste regel \n\ntweede regel. \n\n\n\n \n\nNieuwe alinea‑tekst")).toBe("Eerste regel\ntweede regel.\n\nNieuwe alinea-tekst");
  });

  it("recognises the kind of a file and picks the report", () => {
    expect(fileKind("aanbiednota-x.pdf")).toBe("aanbiedingsbrief");
    expect(fileKind("Samenvatting-x.pdf")).toBe("samenvatting");
    expect(fileKind("summary-x.pdf")).toBe("summary");
    expect(fileKind("ov-1974-02-volledige-tekst_tcm28.pdf")).toBe("rapport");
    expect(fileKind("2345-onderzoek.pdf")).toBe("overig");
    // Older names carry the kind after a number or title.
    expect(fileKind("3322-vroegtijdig ingrijpen-samenvatting.pdf")).toBe("samenvatting");
    expect(fileKind("ob264_summary_tcm28-69414.pdf")).toBe("summary");
    expect(fileKind("addendum-aanbiednota-x.pdf")).toBe("aanbiedingsbrief");
    expect(fileKind("2346-volledige-tekst_tcm28-73091.pdf")).toBe("rapport");
    expect(fileKind("ob271-inleiding.pdf")).toBe("overig");
    const file = (name: string, size: number): WodcFile => ({ uuid: name, name, size_bytes: size, soort: fileKind(name), url: "", repository_tekst: true });
    expect(pickMainFile([file("samenvatting.pdf", 9), file("rapport.pdf", 5)])?.name).toBe("rapport.pdf");
    expect(pickMainFile([file("aanbiedingsbrief.pdf", 9), file("onderzoek.pdf", 5)])?.name).toBe("onderzoek.pdf");
    expect(pickMainFile([file("summary.pdf", 3), file("samenvatting.pdf", 4)])?.name).toBe("samenvatting.pdf");
  });

  it("finds the passages holding every word, accents ignored", () => {
    const text = `${"Inleiding. ".repeat(80)}De continuïteit van zorg na detentie verkleint de recidive. ${"Methode. ".repeat(120)}Alleen recidive hier. ${"Slot. ".repeat(80)}Continuiteit en recidive opnieuw.`;
    const out = findPassages(text, "continuiteit recidive");
    expect(out.total).toBe(2);
    expect(out.counts).toEqual({ continuiteit: 2, recidive: 3 });
    expect(out.passages[0].tekst).toContain("De continuïteit van zorg na detentie verkleint de recidive.");
    expect(findPassages(text, '"zorg na"').total).toBe(1);
    expect(findPassages(text, "recidive onbekendwoord")).toMatchObject({ total: 0, counts: { recidive: 3, onbekendwoord: 0 } });
  });
});

describe("wodc_search tool", () => {
  it("searches with relevance, date range and filters, and returns linked records", async () => {
    const urls = routedFetch((u) => {
      if (u.origin + u.pathname === SEARCH) return searchPage([item()], 42);
      throw new Error(`unexpected ${u}`);
    });
    const payload = await callTool("wodc_search", { query: "recidive", date_from: "2024", date_to: "2026-06", series: "Cahier", project: "3001", author: "Jansen", top: 5 });

    const p = urls[0].searchParams;
    expect(p.get("query")).toBe("recidive");
    expect(p.get("dsoType")).toBe("ITEM");
    expect(p.get("sort")).toBe("score,DESC");
    // The repository ends a month on its first day; date_to is sent as the month's last day.
    expect(p.get("f.dateIssued")).toBe("[2024 TO 2026-06-30],equals");
    expect(p.get("f.series")).toBe("Cahier,contains");
    expect(p.get("f.project")).toBe("3001,contains");
    expect(p.get("f.author")).toBe("Jansen,contains");
    expect(p.get("page")).toBe("0");
    expect(p.get("size")).toBe("5");

    expect(payload.summary).toContain("42 WODC-rapporten gevonden");
    expect(payload.pagination).toEqual({ offset: 0, limit: 5, total: 42, has_more: true });
    expect(payload.provenance).toMatchObject({ tool: "wodc_search", total_results: 42, returned_results: 1 });
    const rec = payload.records[0];
    expect(rec.title).toBe("Recidive onder justitiabelen: Een verkenning");
    expect(rec.canonical_url).toBe("https://repository.wodc.nl/handle/20.500.12832/1001");
    expect(rec.date).toBe("2025-03-14");
    expect(rec.snippet).toMatch(/^Jansen, A\.; Bakker, B\. e\.a\. · Cahier 2025-01 · project 3001a — Dit onderzoek/);
    expect(rec.data.uuid).toBe(UUID);
    expect(rec.data.abstract_ingekort).toBe(true);
    expect(rec.data.abstract.length).toBeLessThanOrEqual(602);
    expect(payload.access_note).toContain("volledige tekst");
    expect(payload.access_note).toContain("1 januari");
  });

  it("lists newest first without keywords and pages through offset", async () => {
    const urls = routedFetch(() => searchPage([item(), item({ uuid: OTHER })], 22));
    const payload = await callTool("wodc_search", { offset: 20, top: 3 });
    expect(urls[0].searchParams.get("sort")).toBe("dc.date.issued,DESC");
    expect(urls[0].searchParams.get("page")).toBe("5");
    expect(urls[0].searchParams.get("size")).toBe("4");
    expect(urls[0].searchParams.has("query")).toBe(false);
    expect(payload.records).toHaveLength(2);
    expect(payload.pagination).toMatchObject({ offset: 20, total: 22, has_more: false });
  });

  it("returns an empty page for an offset past the last report, whatever the repository sends", async () => {
    // DSpace's page number overflows for a huge offset and answers with the first items.
    routedFetch(() => searchPage([item(), item({ uuid: OTHER })], 22));
    const past = await callTool("wodc_search", { offset: 50 });
    expect(past.records).toEqual([]);
    expect(past.summary).toContain("geen op deze pagina");
    expect(past.access_note).toContain("offset 50 ligt voorbij het laatste van de 22 rapporten");
    expect(past.pagination).toMatchObject({ offset: 50, total: 22, has_more: false });
    // An offset past what the repository can page to is refused by the input schema (a plain-text MCP error).
    await expect(callTool("wodc_search", { offset: 4294967296 })).rejects.toThrow();
  });

  it("says when nothing is found and reports removed syntax", async () => {
    routedFetch(() => searchPage([], 0));
    const payload = await callTool("wodc_search", { query: "(xqzzy" });
    expect(payload.summary).toBe("Geen WODC-rapporten gevonden");
    expect(payload.records).toEqual([]);
    expect(payload.access_note).toContain("gezocht op: xqzzy");
  });

  it("rejects a bad date without calling the repository, and plans in dryRun", async () => {
    const urls = routedFetch(() => searchPage([], 0));
    const bad = await callTool("wodc_search", { date_from: "2025-13" });
    expect(bad.error).toBe("unexpected");
    expect(bad.message).toContain("geen datum");
    const reversed = await callTool("wodc_search", { date_from: "2026", date_to: "2024" });
    expect(reversed.message).toContain("na date_to");
    const dry = await callTool("wodc_search", { query: "recidive", sort: "oldest", dryRun: true });
    expect(dry.planned_requests[0]).toMatchObject({ connector: "wodc", url: SEARCH, params: { query: "recidive", sort: "dc.date.issued,ASC" } });
    expect(urls).toHaveLength(0);
  });

  it("maps a rejected query and a failing repository to errors", async () => {
    routedFetch(() => jsonResponse({ status: 422 }, 422));
    const rejected = await callTool("wodc_search", { query: "recidive" });
    expect(rejected.error).toBe("http_error");
    expect(rejected.message).toContain("HTTP 422");
    clearHttpCache();
    routedFetch(() => new Response("bad gateway", { status: 502 }));
    const failed = await callTool("wodc_search", { query: "jeugd" });
    expect(failed.error).toBe("http_error");
    expect(failed.records).toBeUndefined();
  });
});

describe("wodc_document_get tool", () => {
  const fullBundles = [
    { name: "ORIGINAL", bitstreams: [LETTER, REPORT, SUMMARY] },
    { name: "TEXT", bitstreams: [REPORT_TXT, SUMMARY_TXT] },
  ];

  it("returns metadata, files and the repository's text of the report", async () => {
    const report = "Rapport \n\nRecidive onder justitiabelen \n\n\n\nInleiding \n\nDe recidive daalt.";
    const urls = routedFetch((u) => {
      if (u.pathname.endsWith(`/core/items/${UUID}`)) return jsonResponse(withBundles(item(), fullBundles));
      if (u.pathname.endsWith(`/bitstreams/${REPORT_TXT.uuid}/content`)) return textResponse(report);
      throw new Error(`unexpected ${u}`);
    });
    const payload = await callTool("wodc_document_get", { id: UUID });
    expect(urls[0].searchParams.get("embed")).toBe("bundles/bitstreams");
    const d = payload.records[0].data;
    expect(payload.records[0].canonical_url).toBe("https://repository.wodc.nl/handle/20.500.12832/1001");
    expect(d.bestand).toBe("rapport-recidive.pdf");
    expect(d.tekst_bron).toBe("repository");
    expect(d.tekst).toBe("Rapport\nRecidive onder justitiabelen\n\nInleiding\nDe recidive daalt.");
    expect(d.tekst_ingekort).toBeUndefined();
    expect(d.tekst_onvolledig).toBeUndefined();
    expect(d.abstract.length).toBeGreaterThan(600);
    expect(d.files.map((f: WodcFile) => [f.soort, f.repository_tekst])).toEqual([["aanbiedingsbrief", false], ["rapport", true], ["samenvatting", true]]);
    expect(d.files[1].url).toBe(`${API}/core/bitstreams/${REPORT.uuid}/content`);
    expect(payload.summary).toContain("uit de repository");
    expect(payload.access_note).toContain("geen licentie");
    expect(pdfMock).not.toHaveBeenCalled();
  });

  it("resolves a handle, reads another file and states truncation", async () => {
    const urls = routedFetch((u) => {
      if (u.pathname.endsWith("/pid/find")) return jsonResponse(item());
      if (u.pathname.endsWith(`/core/items/${UUID}`)) return jsonResponse(withBundles(item(), fullBundles));
      if (u.pathname.endsWith(`/bitstreams/${SUMMARY_TXT.uuid}/content`)) return textResponse("Samenvatting " + "woord ".repeat(100));
      throw new Error(`unexpected ${u}`);
    });
    const payload = await callTool("wodc_document_get", { id: "https://repository.wodc.nl/handle/20.500.12832/1001", bestand: "samenvatting", max_chars: 50 });
    expect(urls[0].searchParams.get("id")).toBe("hdl:20.500.12832/1001");
    const d = payload.records[0].data;
    expect(d.bestand).toBe("samenvatting-recidive.pdf");
    expect(d.tekst_ingekort).toBe(true);
    expect(d.tekst.length).toBeLessThanOrEqual(52);
    expect(payload.access_note).toContain("Tekst ingekort tot 50 van");
  });

  it("reads the PDF for a zoekterm when the repository's text stops at its limit", async () => {
    const cut = "Begin van het rapport. ".repeat(Math.ceil(WODC_REPOSITORY_TEXT_LIMIT / 23)).slice(0, WODC_REPOSITORY_TEXT_LIMIT);
    routedFetch((u) => {
      if (u.pathname.endsWith(`/core/items/${UUID}`)) return jsonResponse(withBundles(item(), fullBundles));
      if (u.pathname.endsWith(`/bitstreams/${REPORT_TXT.uuid}/content`)) return textResponse(cut);
      throw new Error(`unexpected ${u}`);
    });
    const pdfText = `${"Inleiding. ".repeat(50)}Hoofdstuk 7 bespreekt de recidive na drie jaar.`;
    pdfMock.mockResolvedValue({ ok: true, text: pdfText, chars: pdfText.length, total_chars: pdfText.length, truncated: false, pages: 120, bytes: 2_000_000, source_url: REPORT._links.content.href });

    const payload = await callTool("wodc_document_get", { id: UUID, zoekterm: "recidive drie jaar" });
    expect(pdfMock).toHaveBeenCalledWith(REPORT._links.content.href, expect.objectContaining({ connector: "wodc" }));
    const d = payload.records[0].data;
    expect(d.tekst_bron).toBe("pdf");
    expect(d.pdf_paginas).toBe(120);
    expect(d.tekst_onvolledig).toBeUndefined();
    expect(d.passages_totaal).toBe(1);
    expect(d.passages[0].tekst).toContain("Hoofdstuk 7 bespreekt de recidive na drie jaar.");
    expect(d.tekst).toBeUndefined();
    expect(payload.summary).toContain("1 passage met 'recidive drie jaar'");
  });

  it("keeps the repository's text and says it is only the beginning when the PDF is not wanted", async () => {
    const cut = "x".repeat(WODC_REPOSITORY_TEXT_LIMIT);
    routedFetch((u) => {
      if (u.pathname.endsWith(`/core/items/${UUID}`)) return jsonResponse(withBundles(item(), fullBundles));
      if (u.pathname.endsWith(`/bitstreams/${REPORT_TXT.uuid}/content`)) return textResponse(cut);
      throw new Error(`unexpected ${u}`);
    });
    const payload = await callTool("wodc_document_get", { id: UUID, zoekterm: "recidive", text_source: "repository" });
    expect(pdfMock).not.toHaveBeenCalled();
    const d = payload.records[0].data;
    expect(d.tekst_onvolledig).toBe(true);
    expect(d.passages_totaal).toBe(0);
    expect(payload.access_note).toContain("stopt na 100000 tekens");
    expect(payload.access_note).toContain("text_source 'pdf'");
    expect(payload.access_note).toContain("'recidive' komt niet voor in de gelezen tekst (niet de hele tekst");
  });

  it("falls back to the PDF when the repository has no text, and reports a scan without text layer", async () => {
    routedFetch((u) => {
      if (u.pathname.endsWith(`/core/items/${UUID}`)) return jsonResponse(withBundles(item(), [{ name: "ORIGINAL", bitstreams: [REPORT] }]));
      throw new Error(`unexpected ${u}`);
    });
    pdfMock.mockResolvedValue({ ok: false, reason: "no_text_layer", message: "scan", source_url: REPORT._links.content.href });
    const payload = await callTool("wodc_document_get", { id: UUID });
    const d = payload.records[0].data;
    expect(d.files[0].repository_tekst).toBe(false);
    expect(d.tekst).toBeUndefined();
    expect(payload.summary).toContain("geen tekst");
    expect(payload.access_note).toContain("geen tekstlaag");
  });

  it("uses the PDF when the repository's text cannot be read", async () => {
    routedFetch((u) => {
      if (u.pathname.endsWith(`/core/items/${UUID}`)) return jsonResponse(withBundles(item(), fullBundles));
      if (u.pathname.endsWith(`/bitstreams/${REPORT_TXT.uuid}/content`)) return jsonResponse({ status: 403 }, 403);
      throw new Error(`unexpected ${u}`);
    });
    pdfMock.mockResolvedValue({ ok: true, text: "Tekst uit de PDF.", chars: 17, total_chars: 17, truncated: false, pages: 1, bytes: 10, source_url: "" });
    const payload = await callTool("wodc_document_get", { id: UUID });
    expect(payload.records[0].data).toMatchObject({ tekst_bron: "pdf", tekst: "Tekst uit de PDF." });
    expect(payload.access_note).toContain("kon niet worden gelezen (HTTP 403)");
  });

  it("gives the link of a report published elsewhere when the item holds no files", async () => {
    routedFetch((u) => {
      if (u.pathname.endsWith(`/core/items/${UUID}`)) return jsonResponse(withBundles(item(), []));
      throw new Error(`unexpected ${u}`);
    });
    const payload = await callTool("wodc_document_get", { id: UUID });
    expect(payload.records).toHaveLength(1);
    expect(payload.records[0].data.files).toEqual([]);
    expect(payload.access_note).toContain("geen bestanden en dus geen tekst; de publicatie staat elders: https://example.org/elders.pdf");
    expect(pdfMock).not.toHaveBeenCalled();
  });

  it("only fetches the item with max_chars 0", async () => {
    const urls = routedFetch((u) => {
      if (u.pathname.endsWith(`/core/items/${UUID}`)) return jsonResponse(withBundles(item(), fullBundles));
      throw new Error(`unexpected ${u}`);
    });
    const payload = await callTool("wodc_document_get", { id: UUID, max_chars: 0 });
    expect(urls).toHaveLength(1);
    expect(payload.summary).toContain("alleen metadata en bestanden");
  });

  it("reports an unknown item as not found and rejects an id that is none", async () => {
    routedFetch(() => notFound());
    const missing = await callTool("wodc_document_get", { id: OTHER });
    expect(missing.records).toEqual([]);
    expect(missing.summary).toContain("niet gevonden");
    expect(missing.provenance.total_results).toBe(0);
    const missingHandle = await callTool("wodc_document_get", { id: "hdl:20.500.12832/999999" });
    expect(missingHandle.summary).toContain("niet gevonden");
    const bad = await callTool("wodc_document_get", { id: "recidive" });
    expect(bad.error).toBe("unexpected");
  });
});
