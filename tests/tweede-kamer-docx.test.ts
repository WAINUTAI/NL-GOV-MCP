import { deflateRawSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { docxXmlToText, extractDocxText, looksLikeZip, readZipEntry } from "../src/utils/docx-text.js";
import { TweedeKamerSource } from "../src/sources/tweede-kamer.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { testConfig } from "./helpers/config.js";

/* ------------------------------------------------------------------ */
/*  Minimal ZIP writer, so every fixture byte is visible in this file  */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipInput {
  name: string;
  data: string | Uint8Array;
  method?: 0 | 8;
  /** Lie about the inflated size in the central directory (zip-bomb test). */
  declaredSize?: number;
}

function buildZip(entries: ZipInput[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = typeof entry.data === "string" ? enc.encode(entry.data) : entry.data;
    const method = entry.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const name = enc.encode(entry.name);
    const crc = crc32(raw);
    const size = entry.declaredSize ?? raw.byteLength;

    const local = new Uint8Array(30 + name.byteLength + body.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.byteLength, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(body, 30 + name.byteLength);

    const central = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.byteLength, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.byteLength, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.byteLength;
  }

  const cdSize = centrals.reduce((n, c) => n + c.byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p);
    p += part.byteLength;
  }
  return out;
}

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>AH 999</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Antwoord van de minister </w:t></w:r><w:r><w:t>(ontvangen 1 maart 2026)</w:t></w:r></w:p>
<w:p><w:r><w:t>Vraag 1:</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Klopt het &amp; is het &lt;correct&gt;?</w:t></w:r></w:p>
<w:p><w:r><w:delText>verwijderde tekst</w:delText></w:r><w:r><w:instrText> PAGEREF _Toc1 \\h </w:instrText></w:r><w:r><w:t>Antwoord: nee</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>tweede regel&#233;</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cel 1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>cel 2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`;

function buildDocx(xml = DOCUMENT_XML, method: 0 | 8 = 8): Uint8Array {
  return buildZip([
    { name: "[Content_Types].xml", data: "<Types/>", method },
    { name: "word/document.xml", data: xml, method },
  ]);
}

describe("docx-text", () => {
  it("extracts paragraphs, tabs, breaks and entities from word/document.xml", () => {
    const out = extractDocxText(buildDocx());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toContain("AH 999\nAntwoord van de minister (ontvangen 1 maart 2026)");
    expect(out.text).toContain("Vraag 1: Klopt het & is het <correct>?");
    expect(out.text).toContain("Antwoord: nee\ntweede regelé");
    expect(out.text).toContain("cel 1 cel 2");
    // Deleted runs and field codes are markup, not text.
    expect(out.text).not.toContain("verwijderde tekst");
    expect(out.text).not.toContain("PAGEREF");
    // Never the raw archive.
    expect(out.text).not.toContain("PK");
    expect(out.text).not.toContain("[Content_Types]");
    expect(out.truncated).toBe(false);
  });

  it("reads stored (uncompressed) entries too", () => {
    const out = extractDocxText(buildDocx(DOCUMENT_XML, 0));
    expect(out.ok && out.text.startsWith("AH 999")).toBe(true);
  });

  it("truncates to maxChars", () => {
    const out = extractDocxText(buildDocx(), { maxChars: 10 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toBe("AH 999\nAnt");
    expect(out.chars).toBe(10);
    expect(out.truncated).toBe(true);
  });

  it("returns typed failures instead of garbage", () => {
    expect(extractDocxText(new Uint8Array(0))).toMatchObject({ ok: false, reason: "corrupt" });
    expect(extractDocxText(new TextEncoder().encode("%PDF-1.4 nope"))).toMatchObject({ ok: false, reason: "not_a_zip" });
    expect(extractDocxText(buildZip([{ name: "xl/workbook.xml", data: "<x/>" }]))).toMatchObject({ ok: false, reason: "not_a_docx" });
    expect(extractDocxText(buildDocx("<w:document><w:body></w:body></w:document>"))).toMatchObject({ ok: false, reason: "no_text" });
    const zip = buildDocx();
    expect(extractDocxText(zip.subarray(0, zip.byteLength - 10))).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("refuses an entry that claims or inflates beyond the cap", () => {
    const big = "x".repeat(5000);
    const declared = buildZip([{ name: "word/document.xml", data: big }]);
    expect(() => readZipEntry(declared, "word/document.xml", 1000)).toThrow(/cap/);
    // Lying central directory: claims 10 bytes but inflates to 5000.
    const lying = buildZip([{ name: "word/document.xml", data: big, declaredSize: 10 }]);
    expect(() => readZipEntry(lying, "word/document.xml", 1000)).toThrow(/cap/);
  });

  it("recognises the ZIP signature", () => {
    expect(looksLikeZip(buildDocx())).toBe(true);
    expect(looksLikeZip(new TextEncoder().encode("hello"))).toBe(false);
  });

  it("maps WordprocessingML without a body to empty text", () => {
    expect(docxXmlToText("<w:document/>")).toBe("");
    expect(docxXmlToText("<w:p><w:r><w:t/></w:r></w:p>")).toBe("");
  });
});

describe("TweedeKamerSource.getDocument with Word resources", () => {
  const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  function metadata(id: string, contentType: string) {
    return new Response(
      JSON.stringify({
        Id: id,
        DocumentNummer: "2026D40115",
        Titel: null,
        Onderwerp: "Antwoord op vragen over de jeugdzorg",
        ContentType: contentType,
        Zaak: [{ Id: "z-1", Nummer: "2026Z17702", Soort: "Schriftelijke vragen" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  it("extracts docx text instead of returning the raw ZIP bytes", async () => {
    const docx = buildDocx();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/Resource")) {
        return new Response(docx.buffer as ArrayBuffer, { status: 200, headers: { "content-type": DOCX_TYPE } });
      }
      return metadata("doc-docx", DOCX_TYPE);
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TweedeKamerSource(testConfig).getDocument({ id: "doc-docx", include_text: true });

    expect(out.item.text_preview_source).toBe("docx_document_xml");
    expect(String(out.item.text_preview)).toContain("Antwoord: nee");
    expect(String(out.item.text_preview)).not.toContain("PK");
    expect(out.item.text_preview_unavailable_reason).toBeUndefined();
    // The document now also carries a link to its public page.
    expect(out.item.web_url).toBe("https://www.tweedekamer.nl/kamerstukken/detail?id=2026Z17702&did=2026D40115");
    expect(out.item.download_url).toBe("https://www.tweedekamer.nl/downloads/document?id=2026D40115");
  });

  it("reports a typed reason when the docx is damaged", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/Resource")) {
        return new Response(new TextEncoder().encode("PK\u0003\u0004 broken").buffer as ArrayBuffer, {
          status: 200,
          headers: { "content-type": DOCX_TYPE },
        });
      }
      return metadata("doc-bad", DOCX_TYPE);
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TweedeKamerSource(testConfig).getDocument({ id: "doc-bad", include_text: true });
    expect(out.item.text_preview).toBeUndefined();
    expect(out.item.text_preview_unavailable_reason).toBe("docx_corrupt");
  });

  it("says a Word file is too large when the download passes the byte cap", async () => {
    // 33 chunks of 1 MiB: over the 32 MiB cap, which stops the download before extractDocxText.
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/Resource")) {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= 33) return controller.close();
            sent += 1;
            controller.enqueue(chunk);
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": DOCX_TYPE } });
      }
      return metadata("doc-huge", DOCX_TYPE);
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TweedeKamerSource(testConfig).getDocument({ id: "doc-huge", include_text: true });
    expect(out.item.text_preview).toBeUndefined();
    expect(out.item.text_preview_unavailable_reason).toBe("docx_too_large");
  });

  it("names the failure when the Word file cannot be downloaded", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/Resource") ? new Response("", { status: 404 }) : metadata("doc-gone", DOCX_TYPE),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TweedeKamerSource(testConfig).getDocument({ id: "doc-gone", include_text: true });
    expect(out.item.text_preview_unavailable_reason).toBe("docx_fetch_failed:http_error");
  });

  it("does not read other office formats as text", async () => {
    const fetchMock = vi.fn(async () => metadata("doc-xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TweedeKamerSource(testConfig).getDocument({ id: "doc-xls", include_text: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.item.text_preview).toBeUndefined();
    expect(out.item.text_preview_unavailable_reason).toBe("content_type_not_supported");
  });

  it("refuses a 'text' resource whose body is really an archive", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/Resource")) {
        return new Response("PK\u0003\u0004\u0014\u0000\u0006\u0000[Content_Types].xml", { status: 200, headers: { "content-type": "application/xml" } });
      }
      return metadata("doc-fake-xml", "application/xml");
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TweedeKamerSource(testConfig).getDocument({ id: "doc-fake-xml", include_text: true });
    expect(out.item.text_preview).toBeUndefined();
    expect(out.item.text_preview_unavailable_reason).toBe("binary_content");
  });
});
