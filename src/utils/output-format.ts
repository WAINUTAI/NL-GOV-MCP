import type { MCPRecord, MCPToolResponse } from "../types.js";

export type OutputFormat = NonNullable<MCPToolResponse["output_format"]>;

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function flattenRecord(record: MCPRecord): Record<string, string> {
  const out: Record<string, string> = {
    source_name: String(record.source_name ?? ""),
    title: String(record.title ?? ""),
    canonical_url: String(record.canonical_url ?? ""),
    date: String(record.date ?? ""),
    snippet: String(record.snippet ?? ""),
  };

  const data = record.data ?? {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[`data.${key}`] = String(value);
      continue;
    }
    out[`data.${key}`] = JSON.stringify(value);
  }

  return out;
}

function escapeCsv(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function recordsToCsv(records: MCPRecord[]): string {
  const flattened = records.map(flattenRecord);
  const headerSet = new Set<string>();
  for (const row of flattened) {
    for (const key of Object.keys(row)) headerSet.add(key);
  }
  const headers = Array.from(headerSet);

  const lines = [headers.join(",")];
  for (const row of flattened) {
    const values = headers.map((h) => escapeCsv(String(row[h] ?? "")));
    lines.push(values.join(","));
  }

  return lines.join("\n");
}

function recordsToMarkdownTable(records: MCPRecord[]): string {
  const flattened = records.map(flattenRecord);
  const headerSet = new Set<string>();
  for (const row of flattened) {
    for (const key of Object.keys(row)) headerSet.add(key);
  }
  const headers = Array.from(headerSet);
  if (!headers.length) return "";

  const sanitize = (v: string) => v.replace(/\|/g, "\\|").replace(/\n/g, " ");

  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];

  for (const row of flattened) {
    const values = headers.map((h) => sanitize(String(row[h] ?? "")));
    lines.push(`| ${values.join(" | ")} |`);
  }

  return lines.join("\n");
}

function findGeometry(record: MCPRecord): Record<string, unknown> | undefined {
  const data = (record.data ?? {}) as Record<string, unknown>;

  const geometry = data.geometry;
  if (
    geometry &&
    typeof geometry === "object" &&
    typeof (geometry as Record<string, unknown>).type === "string" &&
    (geometry as Record<string, unknown>).coordinates !== undefined
  ) {
    return geometry as Record<string, unknown>;
  }

  const lat =
    asNumber(data.lat) ??
    asNumber(data.latitude) ??
    asNumber(data.y) ??
    asNumber(data.breedtegraad);
  const lon =
    asNumber(data.lon) ??
    asNumber(data.lng) ??
    asNumber(data.longitude) ??
    asNumber(data.x) ??
    asNumber(data.lengtegraad);

  if (lat !== undefined && lon !== undefined) {
    return {
      type: "Point",
      coordinates: [lon, lat],
    };
  }

  return undefined;
}

function recordsToGeoJson(records: MCPRecord[]):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false } {
  const features: Array<Record<string, unknown>> = [];

  for (const rec of records) {
    const geometry = findGeometry(rec);
    if (!geometry) continue;

    features.push({
      type: "Feature",
      geometry,
      properties: {
        source_name: rec.source_name,
        title: rec.title,
        canonical_url: rec.canonical_url,
        date: rec.date,
        snippet: rec.snippet,
        ...(rec.data ?? {}),
      },
    });
  }

  if (!features.length) return { ok: false };

  return {
    ok: true,
    value: {
      type: "FeatureCollection",
      features,
    },
  };
}

export function applyOutputFormat(args: {
  records: MCPRecord[];
  outputFormat: OutputFormat;
}): {
  output_format: OutputFormat;
  formatted_output?: string | Record<string, unknown>;
  access_note?: string;
} {
  const { records, outputFormat } = args;

  if (outputFormat === "json") {
    return { output_format: "json" };
  }

  if (outputFormat === "csv") {
    return {
      output_format: "csv",
      formatted_output: recordsToCsv(records),
    };
  }

  if (outputFormat === "markdown_table") {
    return {
      output_format: "markdown_table",
      formatted_output: recordsToMarkdownTable(records),
    };
  }

  const geo = recordsToGeoJson(records);
  if (geo.ok) {
    return {
      output_format: "geojson",
      formatted_output: geo.value,
    };
  }

  return {
    output_format: "json",
    access_note:
      "outputFormat=geojson gevraagd, maar records bevatten geen bruikbare locatievelden; fallback naar json.",
  };
}

export function paginateRecords<T>(
  records: T[],
  args: { offset: number; limit: number; total?: number | null },
): {
  page: T[];
  pagination: NonNullable<MCPToolResponse["pagination"]>;
} {
  const offset = Math.max(0, args.offset);
  const limit = Math.max(1, args.limit);

  const page = records.slice(offset, offset + limit);

  const total = typeof args.total === "number" ? args.total : null;
  const hasMore = total !== null ? offset + page.length < total : offset + limit < records.length;

  return {
    page,
    pagination: {
      offset,
      limit,
      total,
      has_more: hasMore,
    },
  };
}
