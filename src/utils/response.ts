import type {
  MCPErrorResponse,
  MCPRecord,
  MCPToolResponse,
  ToolResult,
} from "../types.js";
import { SourceRequestError } from "./http.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function successResponse(args: {
  summary: string;
  records: MCPRecord[];
  provenance: MCPToolResponse["provenance"];
  access_note?: string;
  failures?: MCPToolResponse["failures"];
  pagination?: MCPToolResponse["pagination"];
  output_format?: MCPToolResponse["output_format"];
  formatted_output?: MCPToolResponse["formatted_output"];
  verbose?: MCPToolResponse["verbose"];
}): MCPToolResponse {
  return {
    summary: args.summary,
    records: args.records,
    provenance: args.provenance,
    access_note: args.access_note,
    failures: args.failures,
    pagination: args.pagination,
    output_format: args.output_format,
    formatted_output: args.formatted_output,
    verbose: args.verbose,
  };
}

export function errorResponse(args: {
  error: MCPErrorResponse["error"];
  message: string;
  suggestion?: string;
  retry_after?: number;
  details?: Record<string, unknown>;
}): MCPErrorResponse {
  return {
    error: args.error,
    message: args.message,
    suggestion: args.suggestion,
    retry_after: args.retry_after,
    details: args.details,
  };
}

export function mapSourceError(
  error: unknown,
  sourceLabel: string,
  fallbackUrl?: string,
): MCPErrorResponse {
  if (error instanceof SourceRequestError) {
    if (error.code === "timeout") {
      return errorResponse({
        error: "timeout",
        message: `${sourceLabel} did not respond in time`,
        suggestion: fallbackUrl
          ? `Try again or visit ${fallbackUrl} directly`
          : "Try again with a narrower query",
        details: { endpoint: error.endpoint },
      });
    }

    if (error.code === "rate_limited") {
      return errorResponse({
        error: "rate_limited",
        message: `${sourceLabel} rate limit reached`,
        retry_after: error.retryAfter,
        suggestion: "Try again later or narrow your query",
        details: { endpoint: error.endpoint, status: error.status },
      });
    }

    if (error.code === "malformed_response") {
      return errorResponse({
        error: "malformed_response",
        message: `${sourceLabel} returned malformed data`,
        suggestion: fallbackUrl
          ? `Try again or visit ${fallbackUrl} directly`
          : "Try again later",
        details: { endpoint: error.endpoint, status: error.status },
      });
    }

    if (error.code === "circuit_open") {
      return errorResponse({
        error: "circuit_open",
        message: `${sourceLabel} is temporarily unavailable (circuit open)`,
        retry_after: error.retryAfter,
        suggestion: "Try again after cooldown or narrow the query",
        details: { endpoint: error.endpoint, status: error.status },
      });
    }

    return errorResponse({
      error: "http_error",
      message: `${sourceLabel} request failed${
        error.status ? ` (HTTP ${error.status})` : ""
      }`,
      suggestion: fallbackUrl
        ? `Try again or visit ${fallbackUrl} directly`
        : "Try again later",
      details: { endpoint: error.endpoint, status: error.status },
    });
  }

  return errorResponse({
    error: "unexpected",
    message: error instanceof Error ? error.message : "Unexpected error",
    suggestion: fallbackUrl
      ? `Try again or visit ${fallbackUrl} directly`
      : "Try again later",
  });
}

export function toMcpToolPayload(result: ToolResult): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
}
