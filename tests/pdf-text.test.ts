import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractPdfText,
  fetchPdfText,
  looksLikePdf,
  normalizePdfText,
} from "../src/utils/pdf-text.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { buildSamplePdf } from "./helpers/pdf-fixture.js";

describe("looksLikePdf", () => {
  it("recognises the PDF header", () => {
    expect(looksLikePdf(buildSamplePdf())).toBe(true);
  });

  it("rejects other payloads", () => {
    expect(looksLikePdf(new TextEncoder().encode("<html>nope</html>"))).toBe(false);
    expect(looksLikePdf(new Uint8Array([0, 1, 2, 3]))).toBe(false);
  });
});

describe("normalizePdfText", () => {
  it("collapses runs of spaces and blank lines but keeps paragraphs", () => {
    expect(normalizePdfText("  Regel   een \n\n\n\n Regel  twee \n")).toBe("Regel een\n\nRegel twee");
  });
});

describe("extractPdfText", () => {
  it("extracts the text layer and reports page count", async () => {
    const out = await extractPdfText(buildSamplePdf("Kamerstuk over stikstofbeleid"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toBe("Kamerstuk over stikstofbeleid");
    expect(out.pages).toBe(1);
    expect(out.truncated).toBe(false);
    expect(out.chars).toBe("Kamerstuk over stikstofbeleid".length);
  });

  it("truncates at maxChars", async () => {
    const out = await extractPdfText(buildSamplePdf("abcdefghij"), { maxChars: 4 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toBe("abcd");
    expect(out.truncated).toBe(true);
    expect(out.chars).toBe(4);
  });

  it("does not mutate the caller's buffer", async () => {
    const bytes = buildSamplePdf("Blijft heel");
    const before = bytes.byteLength;
    await extractPdfText(bytes);
    expect(bytes.byteLength).toBe(before);
    // A second extraction from the same buffer must still work.
    const second = await extractPdfText(bytes);
    expect(second.ok).toBe(true);
  });

  it("reports a typed failure for a non-PDF payload", async () => {
    const out = await extractPdfText(new TextEncoder().encode("<html>error page</html>"));
    expect(out).toMatchObject({ ok: false, reason: "not_a_pdf" });
  });

  it("reports a typed failure for an empty body", async () => {
    const out = await extractPdfText(new Uint8Array(0));
    expect(out).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("reports a typed failure for a PDF header without a readable body", async () => {
    const out = await extractPdfText(new TextEncoder().encode("%PDF-1.4 truncated"));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(["corrupt", "extraction_failed", "no_text_layer"]).toContain(out.reason);
  });
});

describe("fetchPdfText", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("fetches over the shared HTTP stack and returns the resolved url", async () => {
    const pdf = buildSamplePdf("Aankondiging");
    const fetchMock = vi.fn(async () =>
      new Response(pdf.buffer as ArrayBuffer, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchPdfText("https://example.nl/doc.pdf", { connector: "tenderned" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toBe("Aankondiging");
    expect(out.source_url).toBe("https://example.nl/doc.pdf");

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).accept).toContain("application/pdf");
  });

  it("returns a typed failure instead of throwing when the PDF cannot be fetched", async () => {
    // TenderNed answers publications without a PDF with HTTP 500; the caller
    // must keep the record it already has.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const out = await fetchPdfText("https://example.nl/missing.pdf", { retries: 0 });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("fetch_failed");
    expect(out.message).toContain("500");
    expect(out.source_url).toBe("https://example.nl/missing.pdf");
  });
});
