import { XMLParser } from "fast-xml-parser";

// Bovengrens op de invoergrootte om geheugen-/CPU-uitputting door extreem grote
// (of opgeblazen) XML-payloads te voorkomen.
const MAX_XML_BYTES = 20 * 1024 * 1024; // 20 MB

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  // processEntities: false schakelt uitbreiding van custom DOCTYPE/ENTITY-declaraties
  // uit (bescherming tegen entity-expansion / "billion laughs"). Standaard XML-entities
  // zoals &amp; &lt; &gt; &quot; &apos; blijven gewoon werken.
  processEntities: false,
  // parseTagValue blijft aan zodat numerieke waarden getallen blijven (geen regressie
  // in bestaande SRU-parsing), maar leadingZeros:false voorkomt dat codes met
  // voorloopnullen ("0344") naar 344 worden gecoerceerd; hex:false voorkomt dat
  // strings als "0x.." of achtige patronen als hex worden geïnterpreteerd.
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
  return parser.parse(xml);
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
