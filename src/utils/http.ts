import { setTimeout as sleep } from "node:timers/promises";
import {
  acquireConnectorSlot,
  getCircuitDecision,
  getConnectorCacheTtlMs,
  getHttpCache,
  inferConnectorName,
  makeHttpCacheKey,
  markConnectorCall,
  markConnectorFailure,
  markConnectorSuccess,
  setHttpCache,
} from "./connector-runtime.js";
import { logger } from "./logger.js";

export class SourceRequestError extends Error {
  public readonly status?: number;
  public readonly code:
    | "timeout"
    | "http_error"
    | "rate_limited"
    | "malformed_response"
    | "network_error"
    | "circuit_open";
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
  connector?: string;
  cacheTtlMs?: number;
  disableCache?: boolean;
}

export interface HttpMeta {
  url: string;
  status: number;
  elapsedMs: number;
  method: "GET" | "POST";
  connector: string;
  cacheHit: boolean;
  cacheTtlRemainingS?: number;
  queueWaitMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;

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

interface CachedHttpPayload {
  status: number;
  headers: Array<[string, string]>;
  body: string;
}

function countsTowardCircuit(error: SourceRequestError): boolean {
  if (error.code === "timeout") return true;
  if (error.code === "rate_limited") return true;
  if (error.code === "http_error" && (error.status ?? 0) >= 500) return true;
  return false;
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
  const connector = options.connector ?? inferConnectorName(fullUrl);

  const cacheEnabled =
    !options.disableCache && (method === "GET" || method === "POST");
  const cacheTtlMs = options.cacheTtlMs ?? getConnectorCacheTtlMs(connector);
  const cacheKey = cacheEnabled
    ? makeHttpCacheKey({ connector, method, url: fullUrl, body })
    : undefined;

  markConnectorCall(connector);

  if (cacheEnabled && cacheKey) {
    const cached = getHttpCache<CachedHttpPayload>(cacheKey);
    if (cached) {
      markConnectorSuccess(connector, 0);
      const response = new Response(cached.value.body, {
        status: cached.value.status,
        headers: new Headers(cached.value.headers),
      });

      const meta: HttpMeta = {
        url: fullUrl,
        status: cached.value.status,
        elapsedMs: 0,
        method,
        connector,
        cacheHit: true,
        cacheTtlRemainingS: cached.ttlRemainingS,
        queueWaitMs: 0,
      };

      logger.info(
        {
          method,
          url: fullUrl,
          connector,
          status: cached.value.status,
          elapsedMs: 0,
          cacheHit: true,
          cacheTtlRemainingS: cached.ttlRemainingS,
        },
        "source_request_cache_hit",
      );

      return { response, meta };
    }
  }

  const circuit = getCircuitDecision(connector);
  if (circuit.open) {
    throw new SourceRequestError({
      message: `Circuit open for connector '${connector}'`,
      endpoint: fullUrl,
      code: "circuit_open",
      status: 503,
      retryAfter: circuit.retryAfterS,
    });
  }

  const queueStart = Date.now();
  let releaseSlot: (() => void) | undefined;

  try {
    releaseSlot = await acquireConnectorSlot(connector, DEFAULT_QUEUE_TIMEOUT_MS);
  } catch {
    const error = new SourceRequestError({
      message: `Request queue timeout after ${DEFAULT_QUEUE_TIMEOUT_MS}ms`,
      endpoint: fullUrl,
      code: "timeout",
    });
    markConnectorFailure(connector, {
      countTowardCircuit: false,
      responseTimeMs: Date.now() - queueStart,
    });
    throw error;
  }

  const queueWaitMs = Date.now() - queueStart;

  let attempt = 0;
  let lastError: unknown;

  try {
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

        const networkElapsedMs = Date.now() - started;
        const totalElapsedMs = Date.now() - queueStart;

        logger.info(
          {
            method,
            url: fullUrl,
            connector,
            status: response.status,
            attempt,
            networkElapsedMs,
            elapsedMs: totalElapsedMs,
            queueWaitMs,
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

          const error = new SourceRequestError({
            message: `Rate limited by source (${fullUrl})`,
            endpoint: fullUrl,
            code: "rate_limited",
            status: 429,
            retryAfter,
          });
          markConnectorFailure(connector, {
            countTowardCircuit: true,
            responseTimeMs: totalElapsedMs,
          });
          throw error;
        }

        if (response.status >= 500) {
          if (attempt <= retries) {
            await sleep(Math.pow(2, attempt) * 300);
            continue;
          }

          const error = new SourceRequestError({
            message: `Source request failed with status ${response.status}`,
            endpoint: fullUrl,
            code: "http_error",
            status: response.status,
          });
          markConnectorFailure(connector, {
            countTowardCircuit: true,
            responseTimeMs: totalElapsedMs,
          });
          throw error;
        }

        if (!response.ok) {
          const error = new SourceRequestError({
            message: `Source request failed with status ${response.status}`,
            endpoint: fullUrl,
            code: "http_error",
            status: response.status,
          });
          markConnectorFailure(connector, {
            countTowardCircuit: false,
            responseTimeMs: totalElapsedMs,
          });
          throw error;
        }

        if (cacheEnabled && cacheKey && cacheTtlMs > 0) {
          const clone = response.clone();
          const bodyText = await clone.text();
          const headerPairs: Array<[string, string]> = [];
          response.headers.forEach((value, key) => {
            headerPairs.push([key, value]);
          });

          setHttpCache(
            cacheKey,
            {
              status: response.status,
              headers: headerPairs,
              body: bodyText,
            } satisfies CachedHttpPayload,
            cacheTtlMs,
            connector,
          );
        }

        markConnectorSuccess(connector, totalElapsedMs);

        return {
          response,
          meta: {
            url: fullUrl,
            status: response.status,
            elapsedMs: totalElapsedMs,
            method,
            connector,
            cacheHit: false,
            queueWaitMs,
          },
        };
      } catch (error) {
        lastError = error;

        if (error instanceof SourceRequestError) {
          // Mark failures for final SourceRequestErrors not already marked above.
          if (
            error.code === "timeout" ||
            error.code === "network_error" ||
            error.code === "malformed_response"
          ) {
            markConnectorFailure(connector, {
              countTowardCircuit: countsTowardCircuit(error),
              responseTimeMs: Date.now() - queueStart,
            });
          }
          throw error;
        }

        if (error instanceof Error && error.name === "AbortError") {
          if (attempt <= retries) {
            await sleep(Math.pow(2, attempt) * 250);
            continue;
          }

          const timeoutError = new SourceRequestError({
            message: `Source timeout after ${timeoutMs}ms`,
            endpoint: fullUrl,
            code: "timeout",
          });
          markConnectorFailure(connector, {
            countTowardCircuit: true,
            responseTimeMs: Date.now() - queueStart,
          });
          throw timeoutError;
        }

        if (attempt <= retries) {
          await sleep(Math.pow(2, attempt) * 250);
          continue;
        }

        const networkError = new SourceRequestError({
          message:
            error instanceof Error
              ? error.message
              : "Network error while contacting source",
          endpoint: fullUrl,
          code: "network_error",
        });
        markConnectorFailure(connector, {
          countTowardCircuit: false,
          responseTimeMs: Date.now() - queueStart,
        });
        throw networkError;
      }
    }
  } finally {
    releaseSlot?.();
  }

  const fallbackError = new SourceRequestError({
    message:
      lastError instanceof Error ? lastError.message : "Unhandled request failure",
    endpoint: fullUrl,
    code: "network_error",
  });
  markConnectorFailure(connector, {
    countTowardCircuit: false,
    responseTimeMs: Date.now() - queueStart,
  });
  throw fallbackError;
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
    markConnectorFailure(meta.connector, {
      countTowardCircuit: false,
      responseTimeMs: meta.elapsedMs,
    });
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

export async function postJson<T>(
  url: string,
  body: unknown,
  options: RequestOptions = {},
): Promise<{ data: T; meta: HttpMeta }> {
  const { response, meta } = await request("POST", url, options, body);
  try {
    const data = (await response.json()) as T;
    return { data, meta };
  } catch (error) {
    markConnectorFailure(meta.connector, {
      countTowardCircuit: false,
      responseTimeMs: meta.elapsedMs,
    });
    throw new SourceRequestError({
      message:
        error instanceof Error ? error.message : "Failed to parse JSON response",
      endpoint: meta.url,
      code: "malformed_response",
      status: meta.status,
    });
  }
}
