import { getBinary, SourceRequestError } from "./http.js";
import { logger } from "./logger.js";

/**
 * PDF text extraction.
 *
 * Most Dutch government "data" is text inside a PDF: Kamerstukken, aanbestedings-
 * aankondigingen, inspectierapporten, raadsstukken. Without extraction those
 * connectors can only ever return metadata and a link, which is why several tools
 * used to answer `pdf_not_extracted_in_lean_mode`.
 *
 * Backed by unpdf (a serverless build of pdf.js — no native modules, no canvas).
 * pdf.js is chatty on malformed fonts, so verbosity is pinned to 0: this server
 * speaks JSON-RPC over stdout on the stdio transport and a stray console line
 * would corrupt the protocol.
 */

/** Hard cap on a PDF we are willing to pull into memory. */
export const MAX_PDF_BYTES = 32 * 1024 * 1024;
/** Default cap on returned characters — tool callers can lower it, not raise it past this. */
export const MAX_PDF_TEXT_CHARS = 200_000;

export type PdfTextFailure =
  | "not_a_pdf"
  | "encrypted"
  | "corrupt"
  | "no_text_layer"
  | "too_large"
  | "fetch_failed"
  | "extraction_failed";

export interface PdfTextResult {
  ok: true;
  text: string;
  chars: number;
  truncated: boolean;
  pages: number;
  bytes: number;
}

export interface PdfTextError {
  ok: false;
  reason: PdfTextFailure;
  message: string;
}

/** A PDF always starts with "%PDF-" (optionally after a few junk bytes). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

/** Collapse pdf.js' per-item spacing into readable prose without losing paragraphs. */
export function normalizePdfText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function classifyError(error: unknown): { reason: PdfTextFailure; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("password") || lower.includes("encrypt")) {
    return { reason: "encrypted", message };
  }
  if (lower.includes("invalid pdf") || lower.includes("structure")) {
    return { reason: "corrupt", message };
  }
  return { reason: "extraction_failed", message };
}

/**
 * Extract text from PDF bytes.
 *
 * Returns a typed failure instead of throwing: a document without a text layer
 * (a scan) is a normal outcome that the caller should report, not an error.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  options: { maxChars?: number } = {},
): Promise<PdfTextResult | PdfTextError> {
  const maxChars = Math.max(1, Math.min(MAX_PDF_TEXT_CHARS, options.maxChars ?? 12_000));

  if (bytes.byteLength === 0) {
    return { ok: false, reason: "corrupt", message: "Empty response body" };
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      message: `PDF is ${bytes.byteLength} bytes, over the ${MAX_PDF_BYTES} byte cap`,
    };
  }
  if (!looksLikePdf(bytes)) {
    return { ok: false, reason: "not_a_pdf", message: "Response does not start with %PDF-" };
  }

  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    // pdf.js mutates the buffer it is handed; copy so a caller can reuse the bytes.
    const document = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    const { totalPages, text } = await extractText(document, { mergePages: true });

    const normalized = normalizePdfText(Array.isArray(text) ? text.join("\n\n") : text);
    if (!normalized) {
      return {
        ok: false,
        reason: "no_text_layer",
        message: "PDF parsed but contains no extractable text (likely a scan without OCR)",
      };
    }

    const truncated = normalized.length > maxChars;
    return {
      ok: true,
      text: truncated ? normalized.slice(0, maxChars) : normalized,
      chars: truncated ? maxChars : normalized.length,
      truncated,
      pages: totalPages,
      bytes: bytes.byteLength,
    };
  } catch (error) {
    const classified = classifyError(error);
    logger.warn({ err: classified.message }, "pdf_text_extraction_failed");
    return { ok: false, ...classified };
  }
}

/**
 * Fetch a PDF over the shared HTTP stack and extract its text in one step.
 *
 * A failed fetch is returned as a typed failure, not thrown: sources reach a PDF
 * as an *extra* on top of data they already have (a tender notice, a Kamerstuk),
 * and some publications simply have no PDF — TenderNed answers those with HTTP
 * 500. Losing the whole record over a missing attachment would be the wrong
 * trade, so the caller gets the reason and keeps its data.
 */
export async function fetchPdfText(
  url: string,
  options: {
    maxChars?: number;
    connector?: string;
    timeoutMs?: number;
    retries?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<(PdfTextResult | PdfTextError) & { source_url: string }> {
  try {
    const { data, meta } = await getBinary(url, {
      connector: options.connector,
      timeoutMs: options.timeoutMs ?? 30_000,
      // A missing PDF is usually deterministic; one retry is plenty for a
      // payload this size.
      retries: options.retries ?? 1,
      maxResponseBytes: MAX_PDF_BYTES,
      headers: { accept: "application/pdf, */*;q=0.1", ...(options.headers ?? {}) },
    });

    const result = await extractPdfText(data, { maxChars: options.maxChars });
    return { ...result, source_url: meta.url };
  } catch (error) {
    const status = error instanceof SourceRequestError ? error.status : undefined;
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ url, status, err: message }, "pdf_fetch_failed");
    return {
      ok: false,
      reason: "fetch_failed",
      message: status ? `${message} (HTTP ${status})` : message,
      source_url: url,
    };
  }
}
