import type { MCPRecord, MCPToolResponse } from "../types.js";
import { getConnectorHealth } from "./connector-runtime.js";
import { applyOutputFormat, paginateRecords, type OutputFormat } from "./output-format.js";
import { successResponse } from "./response.js";
import { enrichRelatedLinks } from "./cross-reference.js";

export function mergeAccessNotes(...notes: Array<string | undefined>): string | undefined {
  const clean = notes.map((n) => (n ?? "").trim()).filter(Boolean);
  return clean.length ? clean.join(" ") : undefined;
}

export function buildFormattedResponse(args: {
  summary: string;
  records: MCPRecord[];
  provenance: MCPToolResponse["provenance"];
  outputFormat: OutputFormat;
  offset: number;
  limit: number;
  total?: number | null;
  access_note?: string;
  failures?: NonNullable<MCPToolResponse["failures"]>;
  verbose?: Record<string, unknown>;
}): MCPToolResponse {
  const linkedRecords = enrichRelatedLinks(args.records);

  const paged = paginateRecords(linkedRecords, {
    offset: args.offset,
    limit: args.limit,
    total: args.total === undefined ? args.records.length : args.total,
  });

  const formatted = applyOutputFormat({
    records: paged.page,
    outputFormat: args.outputFormat,
  });

  return successResponse({
    summary: args.summary,
    records: paged.page,
    provenance: args.provenance,
    pagination: paged.pagination,
    output_format: formatted.output_format,
    formatted_output: formatted.formatted_output,
    access_note: mergeAccessNotes(args.access_note, formatted.access_note),
    failures: args.failures,
    verbose: args.verbose,
  });
}

export function dryRunPayload(args: {
  connector: string;
  url: string;
  params: Record<string, unknown>;
}): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> } {
  const payload = {
    dry_run: true,
    planned_requests: [
      {
        connector: args.connector,
        method: "GET",
        url: args.url,
        params: args.params,
      },
    ],
    estimated_sources: [args.connector],
    cache_status: [
      {
        connector: args.connector,
        cache_policy: "hardcoded-ttl",
      },
    ],
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

export function singleConnectorVerbose(args: {
  enabled: boolean;
  connector: string;
  endpoint: string;
  responseTimeMs: number;
}): Record<string, unknown> | undefined {
  if (!args.enabled) return undefined;

  return {
    requests: [
      {
        connector: args.connector,
        request_url: args.endpoint,
        request_method: "GET",
        response_time_ms: args.responseTimeMs,
        cache_hit: null,
        cache_ttl_remaining_s: null,
      },
    ],
    fallbacks_used: [],
    connector_health: {
      [args.connector]: getConnectorHealth(args.connector),
    },
  };
}
