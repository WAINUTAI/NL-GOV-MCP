/**
 * Plain text from an HTML fragment, for metadata fields that carry HTML (e.g. the
 * escaped HTML in Samenwerkende Catalogi's dcterms:abstract, which after XML
 * decoding is real "<p>…</p>" with "&nbsp;" and "&hellip;").
 *
 * Deliberately small: no DOM, no dependency. Steps, in this order:
 *  1. drop <script>/<style> blocks (content included) and HTML comments;
 *  2. strip real tags only — "<" directly followed by a letter (optionally after
 *     "/"), so plain text like "a < b" or "5 > 3" survives. Block-level tags become
 *     a space so "aan.</p><p>Voor" does not glue into "aan.Voor";
 *  3. decode HTML entities — after stripping, so an escaped "&lt;b&gt;" ends up as
 *     the literal text "<b>" instead of being stripped as a tag;
 *  4. collapse whitespace (including the U+00A0 that &#160; produces) and trim.
 */

const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
// Tag name, then optional attributes; quoted attribute values may contain ">".
const TAG = /<\/?([a-zA-Z][a-zA-Z0-9:._-]*)(?:\s(?:[^<>"']|"[^"]*"|'[^']*')*)?\/?>/g;

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt",
  "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hr", "li", "nav", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul",
]);

const HTML_REFERENCE = /&(?:([a-zA-Z][a-zA-Z0-9]*)|#([0-9]+)|#[xX]([0-9a-fA-F]+));/g;

/** Named entities seen in Dutch government HTML; anything else stays literal. */
const NAMED_ENTITIES: Record<string, string> = {
  // XML's five, plus typography
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: " ", shy: "",
  hellip: "…", ndash: "–", mdash: "—", middot: "·", bull: "•",
  lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
  laquo: "«", raquo: "»",
  euro: "€", copy: "©", reg: "®", trade: "™", deg: "°",
  // Latin-1 letters common in Dutch
  aacute: "á", agrave: "à", auml: "ä", acirc: "â",
  Aacute: "Á", Agrave: "À", Auml: "Ä", Acirc: "Â",
  eacute: "é", egrave: "è", euml: "ë", ecirc: "ê",
  Eacute: "É", Egrave: "È", Euml: "Ë", Ecirc: "Ê",
  iacute: "í", igrave: "ì", iuml: "ï", icirc: "î",
  Iacute: "Í", Igrave: "Ì", Iuml: "Ï", Icirc: "Î",
  oacute: "ó", ograve: "ò", ouml: "ö", ocirc: "ô",
  Oacute: "Ó", Ograve: "Ò", Ouml: "Ö", Ocirc: "Ô",
  uacute: "ú", ugrave: "ù", uuml: "ü", ucirc: "û",
  Uacute: "Ú", Ugrave: "Ù", Uuml: "Ü", Ucirc: "Û",
  ccedil: "ç", Ccedil: "Ç", ntilde: "ñ", Ntilde: "Ñ",
};

/**
 * One pass, so "&amp;nbsp;" becomes the text "&nbsp;" and never a space. Numeric
 * references follow the same rule as utils/xml-parser.ts: only codepoints
 * 1..0x10FFFF outside the surrogate range; anything else stays literal.
 */
function decodeHtmlReferences(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(HTML_REFERENCE, (match, name?: string, dec?: string, hex?: string) => {
    if (name) return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : match;
    const codePoint = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
    const valid = codePoint >= 1 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
    return valid ? String.fromCodePoint(codePoint) : match;
  });
}

export function htmlToText(value: string): string {
  const withoutTags = value
    .replace(SCRIPT_OR_STYLE, " ")
    .replace(COMMENT, " ")
    .replace(TAG, (_tag, name: string) => (BLOCK_TAGS.has(name.toLowerCase()) ? " " : ""));
  return decodeHtmlReferences(withoutTags)
    .replace(/\u00ad/g, "") // soft hyphen, whether written as &shy;, &#173; or raw
    .replace(/\s+/g, " ")
    .trim();
}
