import { XMLParser } from "fast-xml-parser";

// Bovengrens op de invoergrootte om geheugen-/CPU-uitputting door extreem grote
// (of opgeblazen) XML-payloads te voorkomen.
const MAX_XML_BYTES = 20 * 1024 * 1024; // 20 MB

const XML_REFERENCE = /&(?:(amp|lt|gt|quot|apos)|#([0-9]+)|#x([0-9a-fA-F]+));/g;
const PREDEFINED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Decodeert wat elke XML-parser hoort te decoderen, en niets meer:
 *  - de vijf voorgedefinieerde entities &amp; &lt; &gt; &quot; &apos;
 *  - numerieke tekenreferenties, decimaal (&#233;) en hex (&#x20AC;), alleen voor
 *    geldige codepoints: 1..0x10FFFF zonder surrogaten (D800–DFFF).
 * Alles daarbuiten blijft letterlijk staan: onbekende named entities (&nbsp;), in een
 * DOCTYPE gedeclareerde entities en misvormde of ongeldige referenties. Eén pass over
 * de invoer, dus "&amp;lt;" wordt "&lt;" en nooit "<".
 */
function decodeXmlReferences(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(XML_REFERENCE, (match, name?: string, dec?: string, hex?: string) => {
    if (name) return PREDEFINED_ENTITIES[name];
    const codePoint = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
    const valid = codePoint >= 1 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
    return valid ? String.fromCodePoint(codePoint) : match;
  });
}

/**
 * CDATA-inhoud is letterlijk: "&amp;" in een CDATA-sectie is gewoon de tekst "&amp;".
 * fast-xml-parser 5.x stuurt CDATA-inhoud (zonder cdataPropName) echter óók door
 * tagValueProcessor, zonder te melden dat het CDATA is. Daarom zet parseXml vóór het
 * parsen deze marker direct achter elke "<![CDATA[" waarvan de sectie een "&" bevat;
 * tagValueProcessor herkent de marker, haalt hem weg en decodeert niets. Secties
 * zonder "&" krijgen geen marker en lopen dus precies als voorheen door de
 * getalparsing.
 *
 * U+0000 mag nergens in een XML-document staan (ook niet als tekenreferentie, en
 * decodeXmlReferences maakt hem nooit aan), dus de marker botst niet met echte inhoud.
 * Staat "<![CDATA[" ergens anders dan als echte CDATA-opener (in commentaar, in de
 * DOCTYPE of in een attribuutwaarde), dan is de marker onschadelijk: commentaar en
 * DOCTYPE vallen weg en attributen halen hem weg.
 */
const CDATA_OPEN = "<![CDATA[";
const CDATA_CLOSE = "]]>";
const CDATA_MARKER = "\u0000cdata\u0000";

function markCdataWithReferences(xml: string): string {
  let open = xml.indexOf(CDATA_OPEN);
  if (open === -1) return xml;
  const parts: string[] = [];
  let last = 0;
  // Posities van de eerstvolgende "]]>" en "&" worden hergebruikt zolang ze voorbij
  // de huidige opener liggen, zodat dit ook bij veel CDATA-secties lineair blijft.
  let close = -2;
  let amp = -2;
  while (open !== -1) {
    const start = open + CDATA_OPEN.length;
    if (close !== -1 && close < start) close = xml.indexOf(CDATA_CLOSE, start);
    if (amp !== -1 && amp < start) amp = xml.indexOf("&", start);
    if (amp !== -1 && (close === -1 || amp < close)) {
      parts.push(xml.slice(last, start), CDATA_MARKER);
      last = start;
    }
    open = xml.indexOf(CDATA_OPEN, start);
  }
  parts.push(xml.slice(last));
  return parts.join("");
}

function stripCdataMarkers(value: string): string {
  return value.split(CDATA_MARKER).join("");
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  // processEntities: false zet fast-xml-parser's eigen entity-verwerking helemaal uit:
  // in een DOCTYPE gedeclareerde entities worden nooit uitgebreid (bescherming tegen
  // entity-expansion / "billion laughs"), maar de parser decodeert dan ook zélf niets,
  // ook &amp; en &#39; niet. Dat doen tagValueProcessor en attributeValueProcessor
  // hieronder (decodeXmlReferences): alleen de vijf voorgedefinieerde entities en
  // numerieke tekenreferenties, in tekst en attributen. CDATA blijft letterlijk.
  processEntities: false,
  tagValueProcessor: (_tagName: string, value: string) =>
    value.startsWith(CDATA_MARKER) ? stripCdataMarkers(value) : decodeXmlReferences(value),
  attributeValueProcessor: (_attrName: string, value: string) =>
    decodeXmlReferences(value.includes(CDATA_MARKER) ? stripCdataMarkers(value) : value),
  // parseTagValue blijft aan zodat numerieke waarden getallen blijven (geen regressie
  // in bestaande SRU-parsing), maar leadingZeros:false voorkomt dat codes met
  // voorloopnullen ("0344") naar 344 worden gecoerceerd; hex:false voorkomt dat
  // strings als "0x.." of achtige patronen als hex worden geïnterpreteerd.
  // fast-xml-parser parseert alleen waarden die tagValueProcessor ongewijzigd
  // teruggeeft; waarden zonder referenties gaan dus precies als voorheen door de
  // getalparsing, gedecodeerde waarden blijven strings.
  parseTagValue: true,
  numberParseOptions: { leadingZeros: false, hex: false, eNotation: true },
  trimValues: true,
});

export function parseXml(xml: string): unknown {
  if (typeof xml === "string" && Buffer.byteLength(xml, "utf8") > MAX_XML_BYTES) {
    throw new Error(
      `XML-invoer te groot (> ${MAX_XML_BYTES} bytes); parsing geweigerd ter bescherming tegen resource-uitputting.`,
    );
  }
  return parser.parse(typeof xml === "string" ? markCdataWithReferences(xml) : xml);
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function extractSruRecords(parsed: unknown): Array<Record<string, unknown>> {
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as Record<string, unknown>;
  const response =
    (root.searchRetrieveResponse as Record<string, unknown> | undefined) ?? root;
  const recordsObj = response.records as Record<string, unknown> | undefined;
  const records = asArray<unknown>(recordsObj?.record as unknown);

  return records.map((record) => {
    if (!record || typeof record !== "object") return {};
    const recordObj = record as Record<string, unknown>;
    const data = (recordObj.recordData as Record<string, unknown> | undefined) ?? {};
    const keys = Object.keys(data);
    if (keys.length === 1) {
      const first = data[keys[0]];
      if (first && typeof first === "object") {
        return first as Record<string, unknown>;
      }
    }
    return data;
  });
}

export function extractSruNumberOfRecords(parsed: unknown): number {
  if (!parsed || typeof parsed !== "object") return 0;
  const root = parsed as Record<string, unknown>;
  const response =
    (root.searchRetrieveResponse as Record<string, unknown> | undefined) ?? root;
  const n = response.numberOfRecords;
  if (typeof n === "number") return n;
  if (typeof n === "string") {
    const parsedInt = Number.parseInt(n, 10);
    return Number.isNaN(parsedInt) ? 0 : parsedInt;
  }
  return 0;
}
