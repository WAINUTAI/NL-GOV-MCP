import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseTagValue: true,
  trimValues: true,
});

export function parseXml(xml: string): unknown {
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
