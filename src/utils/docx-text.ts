import { inflateRawSync } from "node:zlib";
import { normalizePdfText } from "./pdf-text.js";

/**
 * DOCX text extraction without dependencies.
 *
 * A .docx file is a ZIP archive; the running text lives in `word/document.xml`
 * as WordprocessingML. Tweede Kamer documents are mostly PDF, but a share of
 * answers to written questions and annexes is published as Word. Reading those
 * bytes as text handed callers the raw archive ("PK…[Content_Types].xml"), so
 * this module unpacks the one entry we need and turns its runs into prose.
 *
 * Scope is deliberately small: the main document body only (no headers,
 * footers, footnotes or comments), deflate or stored entries only, no ZIP64 and
 * no encryption. Anything outside that returns a typed failure instead of
 * garbage.
 */

/** Hard cap on a DOCX archive we are willing to pull into memory. */
export const MAX_DOCX_BYTES = 32 * 1024 * 1024;
/** Cap on the inflated document.xml — guards against a zip bomb. */
export const MAX_DOCX_XML_BYTES = 64 * 1024 * 1024;
/** Same ceiling the PDF extractor uses for returned characters. */
export const MAX_DOCX_TEXT_CHARS = 200_000;

export type DocxTextFailure =
  | "not_a_zip"
  | "not_a_docx"
  | "too_large"
  | "unsupported_zip"
  | "corrupt"
  | "no_text";

export interface DocxTextResult {
  ok: true;
  text: string;
  chars: number;
  truncated: boolean;
  bytes: number;
}

export interface DocxTextError {
  ok: false;
  reason: DocxTextFailure;
  message: string;
}

const SIG_LOCAL_HEADER = 0x04034b50;
const SIG_CENTRAL_HEADER = 0x02014b50;
const SIG_END_OF_CENTRAL_DIR = 0x06054b50;

/** Every ZIP archive (and so every DOCX) starts with a local file header "PK\x03\x04". */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

class ZipError extends Error {
  constructor(
    readonly reason: DocxTextFailure,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Read one entry from a ZIP archive by name.
 *
 * Sizes and offsets come from the central directory, not the local header: an
 * archive written in streaming mode leaves the local sizes at zero and puts the
 * real ones in a trailing data descriptor.
 */
export function readZipEntry(bytes: Uint8Array, name: string, maxOutputBytes = MAX_DOCX_XML_BYTES): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record sits in the last 22 bytes plus an
  // optional comment of at most 65535 bytes.
  let eocd = -1;
  const lowest = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let i = bytes.byteLength - 22; i >= lowest; i -= 1) {
    if (view.getUint32(i, true) === SIG_END_OF_CENTRAL_DIR) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("corrupt", "ZIP end-of-central-directory record not found");

  const entryCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || cdOffset === 0xffffffff) {
    throw new ZipError("unsupported_zip", "ZIP64 archives are not supported");
  }

  const decoder = new TextDecoder("utf-8");
  let p = cdOffset;
  for (let n = 0; n < entryCount; n += 1) {
    if (p + 46 > bytes.byteLength || view.getUint32(p, true) !== SIG_CENTRAL_HEADER) {
      throw new ZipError("corrupt", "ZIP central directory is truncated or malformed");
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const entryName = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;

    if (entryName !== name) continue;

    if (flags & 0x1) throw new ZipError("unsupported_zip", "Encrypted ZIP entries are not supported");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError("unsupported_zip", "ZIP64 entries are not supported");
    }
    if (uncompressedSize > maxOutputBytes) {
      throw new ZipError("too_large", `${name} inflates to ${uncompressedSize} bytes, over the ${maxOutputBytes} byte cap`);
    }
    if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== SIG_LOCAL_HEADER) {
      throw new ZipError("corrupt", `Local header for ${name} is missing`);
    }
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) throw new ZipError("corrupt", `Entry ${name} runs past the end of the archive`);
    const data = bytes.subarray(dataStart, dataEnd);

    if (method === 0) return data;
    if (method === 8) {
      try {
        // maxOutputLength stops a lying size field from inflating without bound.
        return new Uint8Array(inflateRawSync(data, { maxOutputLength: maxOutputBytes }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/maxOutputLength|buffer|too large/i.test(message)) {
          throw new ZipError("too_large", `${name} exceeds the ${maxOutputBytes} byte cap when inflated`);
        }
        throw new ZipError("corrupt", `Could not inflate ${name}: ${message}`);
      }
    }
    throw new ZipError("unsupported_zip", `Compression method ${method} is not supported`);
  }

  return null;
}

/** The five predefined XML entities plus numeric references; anything else stays literal. */
function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (match, ref: string) => {
    switch (ref) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
        return String.fromCodePoint(code);
      }
    }
  });
}

/**
 * Turn WordprocessingML into plain text.
 *
 * Only `<w:t>` runs carry visible text. Deleted runs (`<w:delText>`) and field
 * instructions (`<w:instrText>`, e.g. "PAGEREF _Toc… \h") are markup noise and
 * are dropped. Paragraph and row ends become newlines and tabs a space, so the
 * result reads like the document instead of one long line; a table row stays
 * on one line with its cells separated.
 */
export function docxXmlToText(xml: string): string {
  const out: string[] = [];
  const token =
    /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(?:tab|ptab)\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>|<w:noBreakHyphen\b[^>]*\/>|<w:tc\b[^>]*>|<\/w:p>|<\/w:tc>|<\/w:tr>/g;
  let cellDepth = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(xml))) {
    const tag = match[0];
    if (match[1] !== undefined) {
      out.push(decodeXmlText(match[1]));
    } else if (tag.startsWith("<w:tc")) {
      if (!tag.endsWith("/>")) cellDepth += 1;
    } else if (tag === "</w:tc>") {
      cellDepth = Math.max(0, cellDepth - 1);
      out.push("\t");
    } else if (tag.startsWith("<w:tab") || tag.startsWith("<w:ptab")) {
      out.push("\t");
    } else if (tag.startsWith("<w:noBreakHyphen")) {
      out.push("-");
    } else if (tag === "</w:p>" && cellDepth > 0) {
      // A paragraph inside a table cell: keep the row on one line.
      out.push(" ");
    } else {
      // </w:p>, </w:tr>, <w:br/>, <w:cr/>
      out.push("\n");
    }
  }
  return normalizePdfText(out.join(""));
}

/**
 * Extract the body text of a DOCX file.
 *
 * Returns a typed failure instead of throwing, mirroring extractPdfText: a Word
 * file without text (an embedded scan) or an unexpected archive is a normal
 * outcome the caller reports, not an error that should sink the whole record.
 */
export function extractDocxText(
  bytes: Uint8Array,
  options: { maxChars?: number } = {},
): DocxTextResult | DocxTextError {
  const maxChars = Math.max(1, Math.min(MAX_DOCX_TEXT_CHARS, options.maxChars ?? 12_000));

  if (bytes.byteLength === 0) return { ok: false, reason: "corrupt", message: "Empty response body" };
  if (bytes.byteLength > MAX_DOCX_BYTES) {
    return { ok: false, reason: "too_large", message: `DOCX is ${bytes.byteLength} bytes, over the ${MAX_DOCX_BYTES} byte cap` };
  }
  if (!looksLikeZip(bytes)) return { ok: false, reason: "not_a_zip", message: "Response does not start with a ZIP header" };

  let xmlBytes: Uint8Array | null;
  try {
    xmlBytes = readZipEntry(bytes, "word/document.xml");
  } catch (error) {
    if (error instanceof ZipError) return { ok: false, reason: error.reason, message: error.message };
    return { ok: false, reason: "corrupt", message: error instanceof Error ? error.message : String(error) };
  }
  if (!xmlBytes) {
    return { ok: false, reason: "not_a_docx", message: "Archive has no word/document.xml (not a Word document)" };
  }

  const text = docxXmlToText(new TextDecoder("utf-8").decode(xmlBytes));
  if (!text) return { ok: false, reason: "no_text", message: "Word document contains no text runs" };

  const truncated = text.length > maxChars;
  return {
    ok: true,
    text: truncated ? text.slice(0, maxChars) : text,
    chars: truncated ? maxChars : text.length,
    truncated,
    bytes: bytes.byteLength,
  };
}
