import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "./logger.js";

export class SourceRequestError extends Error {
  public readonly status?: number;
  public readonly code:
    | "timeout"
    | "http_error"
    | "rate_limited"
    | "malformed_response"
    | "network_error";
  public readonly retryAfter?: number;
  public readonly endpoint: string;

  constructor(args: {
    message: string;
    endpoint: string;
    code: SourceRequestError["code"];
    status?: number;
    retryAfter?: number;
  }) {
    super(args.message);
    this.name = "SourceRequestError";
    this.endpoint = args.endpoint;
    this.code = args.code;
    this.status = args.status;
    this.retryAfter = args.retryAfter;
  }
}

export interface RequestOptions {
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  timeoutMs?: number;
  retries?: number;
}

export interface HttpMeta {
  url: string;
  status: number;
  elapsedMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;

function withQuery(url: string, query?: RequestOptions["query"]): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    u.searchParams.set(key, String(value));
  }
  return u.toString();
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const asNum = Number(headerValue);
  if (!Number.isNaN(asNum)) return asNum;
  const dt = Date.parse(headerValue);
  if (!Number.isNaN(dt)) {
    const seconds = Math.max(0, Math.round((dt - Date.now()) / 1000));
    return seconds;
  }
  return undefined;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function request(
  method: "GET" | "POST",
  url: string,
  options: RequestOptions = {},
  body?: unknown,
): Promise<{ response: Response; meta: HttpMeta }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const fullUrl = withQuery(url, options.query);

  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    const started = Date.now();
    attempt += 1;
    try {
      const response = await fetchWithTimeout(
        fullUrl,
        {
          method,
          headers: {
            "User-Agent": "nl-gov-mcp/0.1.0",
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers ?? {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        },
        timeoutMs,
      );

      const elapsedMs = Date.now() - started;

      logger.info(
        {
          method,
          url: fullUrl,
          status: response.status,
          elapsedMs,
          attempt,
        },
        "source_request",
      );

      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        if (attempt <= retries) {
          const waitMs = (retryAfter ?? Math.pow(2, attempt)) * 1000;
          await sleep(waitMs);
          continue;
        }
        throw new SourceRequestError({
          message: `Rate limited by source (${fullUrl})`,
          endpoint: fullUrl,
          code: "rate_limited",
          status: 429,
          retryAfter,
        });
      }

      if (response.status >= 500 && attempt <= retries) {
        await sleep(Math.pow(2, attempt) * 300);
        continue;
      }

      if (!response.ok) {
        throw new SourceRequestError({
          message: `Source request failed with status ${response.status}`,
          endpoint: fullUrl,
          code: "http_error",
          status: response.status,
        });
      }

      return {
        response,
        meta: { url: fullUrl, status: response.status, elapsedMs },
      };
    } catch (error) {
      lastError = error;

      if (error instanceof SourceRequestError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        if (attempt <= retries) {
          await sleep(Math.pow(2, attempt) * 250);
          continue;
        }
        throw new SourceRequestError({
          message: `Source timeout after ${timeoutMs}ms`,
          endpoint: fullUrl,
          code: "timeout",
        });
      }

      if (attempt <= retries) {
        await sleep(Math.pow(2, attempt) * 250);
        continue;
      }

      throw new SourceRequestError({
        message:
          error instanceof Error
            ? error.message
            : "Network error while contacting source",
        endpoint: fullUrl,
        code: "network_error",
      });
    }
  }

  throw new SourceRequestError({
    message:
      lastError instanceof Error
        ? lastError.message
        : "Unhandled request failure",
    endpoint: fullUrl,
    code: "network_error",
  });
}

export async function getJson<T>(
  url: string,
  options: RequestOptions = {},
): Promise<{ data: T; meta: HttpMeta }> {
  const { response, meta } = await request("GET", url, options);
  try {
    const data = (await response.json()) as T;
    return { data, meta };
  } catch (error) {
    throw new SourceRequestError({
      message:
        error instanceof Error ? error.message : "Failed to parse JSON response",
      endpoint: meta.url,
      code: "malformed_response",
      status: meta.status,
    });
  }
}

export async function getText(
  url: string,
  options: RequestOptions = {},
): Promise<{ data: string; meta: HttpMeta }> {
  const { response, meta } = await request("GET", url, options);
  const data = await response.text();
  return { data, meta };
}
