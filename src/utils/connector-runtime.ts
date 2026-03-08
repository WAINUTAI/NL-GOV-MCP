import { createHash } from "node:crypto";

export type ConnectorCategory =
  | "static"
  | "semi_live"
  | "live"
  | "discovery"
  | "other";

const TTL_BY_CATEGORY_MS: Record<ConnectorCategory, number> = {
  static: 60 * 60 * 1000,
  semi_live: 10 * 60 * 1000,
  live: 2 * 60 * 1000,
  discovery: 30 * 60 * 1000,
  other: 10 * 60 * 1000,
};

const CONNECTOR_CATEGORY: Record<string, ConnectorCategory> = {
  cbs: "static",
  rijksbegroting: "static",
  duo: "static",
  eurostat: "static",

  tweede_kamer: "semi_live",
  rechtspraak: "semi_live",
  officiele_bekendmakingen: "semi_live",
  rijksoverheid: "semi_live",
  data_overheid: "semi_live",
  pdok_bag: "semi_live",
  data_europa: "semi_live",

  luchtmeetnet: "live",
  ndw: "live",
  rdw: "live",
  rws_waterdata: "live",
  knmi: "live",

  ngr: "discovery",
  rivm: "discovery",
  ori: "discovery",
  api_register: "discovery",
  bag_linked_data: "discovery",
  rce_linked_data: "discovery",
};

const FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_PER_CONNECTOR = 3;
const QUEUE_TIMEOUT_MS = 30_000;
const CACHE_MAX_ENTRIES = 1000;

interface QueueItem {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RuntimeState {
  lastSuccess?: string;
  lastFailure?: string;
  consecutiveFailures: number;
  totalCalls: number;
  totalFailures: number;
  totalResponseTimeMs: number;
  measuredCalls: number;

  circuitOpenUntil?: number;
  probeInFlight: boolean;

  inFlight: number;
  queue: QueueItem[];
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  connector: string;
}

export interface ConnectorHealthSnapshot {
  last_success: string | null;
  last_failure: string | null;
  consecutive_failures: number;
  total_calls: number;
  total_failures: number;
  avg_response_time_ms: number;
  circuit_open: boolean;
  circuit_retry_after_s: number;
  in_flight: number;
  queue_depth: number;
}

const states = new Map<string, RuntimeState>();
const responseCache = new Map<string, CacheEntry<unknown>>();

function nowIso(): string {
  return new Date().toISOString();
}

function getState(connector: string): RuntimeState {
  const existing = states.get(connector);
  if (existing) return existing;

  const created: RuntimeState = {
    consecutiveFailures: 0,
    totalCalls: 0,
    totalFailures: 0,
    totalResponseTimeMs: 0,
    measuredCalls: 0,
    probeInFlight: false,
    inFlight: 0,
    queue: [],
  };
  states.set(connector, created);
  return created;
}

export function inferConnectorName(endpointUrl: string): string {
  try {
    const url = new URL(endpointUrl);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();

    if (host.includes("cbs.nl")) return "cbs";
    if (host.includes("tweedekamer.nl")) return "tweede_kamer";
    if (host.includes("repository.overheid.nl") || host.includes("officielebekendmakingen.nl")) {
      return "officiele_bekendmakingen";
    }
    if (host.includes("rijksoverheid.nl")) return "rijksoverheid";
    if (host.includes("rijksbegroting.nl")) return "rijksbegroting";
    if (host.includes("onderwijsdata.duo.nl") || host.includes("onderwijsregistratie.nl")) {
      return "duo";
    }
    if (host.includes("developer.overheid.nl")) return "api_register";
    if (host.includes("knmi.nl")) return "knmi";
    if (host.includes("pdok.nl") || host.includes("kadaster.nl")) {
      if (host.includes("labs.kadaster.nl")) return "bag_linked_data";
      return "pdok_bag";
    }
    if (host.includes("nationaalgeoregister.nl")) return "ngr";
    if (host.includes("ori") && host.includes("overheid")) return "ori";
    if (host.includes("ndw")) return "ndw";
    if (host.includes("rdw.nl")) return "rdw";
    if (host.includes("waterinfo.rws.nl") || host.includes("rijkswaterstaat")) {
      return "rws_waterdata";
    }
    if (host.includes("luchtmeetnet")) return "luchtmeetnet";
    if (host.includes("rechtspraak.nl")) return "rechtspraak";
    if (host.includes("rivm.nl")) return "rivm";
    if (host.includes("eurostat")) return "eurostat";
    if (host.includes("data.europa.eu")) return "data_europa";
    if (host.includes("cultureelerfgoed.nl")) return "rce_linked_data";
    if (host.includes("data.overheid.nl") || path.includes("/data/api/3/action")) {
      return "data_overheid";
    }

    return host || "unknown";
  } catch {
    return "unknown";
  }
}

export function getConnectorCategory(connector: string): ConnectorCategory {
  return CONNECTOR_CATEGORY[connector] ?? "other";
}

export function getConnectorCacheTtlMs(connector: string): number {
  return TTL_BY_CATEGORY_MS[getConnectorCategory(connector)];
}

export function markConnectorCall(connector: string): void {
  const state = getState(connector);
  state.totalCalls += 1;
}

export function markConnectorSuccess(connector: string, responseTimeMs: number): void {
  const state = getState(connector);
  state.lastSuccess = nowIso();
  state.consecutiveFailures = 0;
  state.circuitOpenUntil = undefined;
  state.probeInFlight = false;
  state.totalResponseTimeMs += Math.max(0, responseTimeMs);
  state.measuredCalls += 1;
}

export function markConnectorFailure(
  connector: string,
  args: { countTowardCircuit: boolean; responseTimeMs?: number },
): void {
  const state = getState(connector);
  state.lastFailure = nowIso();
  state.totalFailures += 1;

  if (typeof args.responseTimeMs === "number") {
    state.totalResponseTimeMs += Math.max(0, args.responseTimeMs);
    state.measuredCalls += 1;
  }

  if (!args.countTowardCircuit) {
    if (state.probeInFlight) state.probeInFlight = false;
    return;
  }

  state.consecutiveFailures += 1;

  if (state.probeInFlight || state.consecutiveFailures >= FAILURE_THRESHOLD) {
    state.circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    state.probeInFlight = false;
  }
}

export function getCircuitDecision(connector: string):
  | { open: true; retryAfterS: number }
  | { open: false; probe: boolean } {
  const state = getState(connector);
  const now = Date.now();

  if (state.circuitOpenUntil && now < state.circuitOpenUntil) {
    const retryAfterS = Math.max(1, Math.ceil((state.circuitOpenUntil - now) / 1000));
    return { open: true, retryAfterS };
  }

  if (state.circuitOpenUntil && now >= state.circuitOpenUntil) {
    if (state.probeInFlight) {
      return { open: true, retryAfterS: 1 };
    }

    state.probeInFlight = true;
    return { open: false, probe: true };
  }

  return { open: false, probe: false };
}

function releaseConnectorSlot(connector: string): void {
  const state = getState(connector);
  state.inFlight = Math.max(0, state.inFlight - 1);

  const next = state.queue.shift();
  if (!next) return;

  clearTimeout(next.timer);
  state.inFlight += 1;
  next.resolve(() => releaseConnectorSlot(connector));
}

export async function acquireConnectorSlot(
  connector: string,
  timeoutMs = QUEUE_TIMEOUT_MS,
): Promise<() => void> {
  const state = getState(connector);

  if (state.inFlight < MAX_CONCURRENT_PER_CONNECTOR) {
    state.inFlight += 1;
    return () => releaseConnectorSlot(connector);
  }

  return await new Promise<() => void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = state.queue.findIndex((q) => q.timer === timer);
      if (idx >= 0) state.queue.splice(idx, 1);
      reject(new Error(`Queue timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    state.queue.push({
      timer,
      resolve,
      reject,
    });
  });
}

function evictExpiredCacheEntries(): void {
  const now = Date.now();
  for (const [key, entry] of responseCache.entries()) {
    if (now > entry.expiresAt) responseCache.delete(key);
  }
}

function enforceCacheCap(): void {
  while (responseCache.size > CACHE_MAX_ENTRIES) {
    const oldest = responseCache.keys().next().value as string | undefined;
    if (!oldest) break;
    responseCache.delete(oldest);
  }
}

export function makeHttpCacheKey(args: {
  connector: string;
  method: string;
  url: string;
  body?: unknown;
}): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(args));
  return hash.digest("hex");
}

export function getHttpCache<T>(key: string):
  | { value: T; ttlRemainingS: number; connector: string }
  | undefined {
  evictExpiredCacheEntries();

  const entry = responseCache.get(key);
  if (!entry) return undefined;

  const ttlRemainingS = Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  if (ttlRemainingS <= 0) {
    responseCache.delete(key);
    return undefined;
  }

  // Basic LRU behavior: refresh insertion order on hit.
  responseCache.delete(key);
  responseCache.set(key, entry);

  return {
    value: entry.value as T,
    ttlRemainingS,
    connector: entry.connector,
  };
}

export function setHttpCache<T>(
  key: string,
  value: T,
  ttlMs: number,
  connector: string,
): void {
  if (ttlMs <= 0) return;
  evictExpiredCacheEntries();
  responseCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    connector,
  });
  enforceCacheCap();
}

export function getConnectorHealth(connector: string): ConnectorHealthSnapshot {
  const state = getState(connector);
  const avg = state.measuredCalls
    ? Number((state.totalResponseTimeMs / state.measuredCalls).toFixed(2))
    : 0;
  const circuitRetryAfterS = state.circuitOpenUntil
    ? Math.max(0, Math.ceil((state.circuitOpenUntil - Date.now()) / 1000))
    : 0;

  return {
    last_success: state.lastSuccess ?? null,
    last_failure: state.lastFailure ?? null,
    consecutive_failures: state.consecutiveFailures,
    total_calls: state.totalCalls,
    total_failures: state.totalFailures,
    avg_response_time_ms: avg,
    circuit_open: circuitRetryAfterS > 0,
    circuit_retry_after_s: circuitRetryAfterS,
    in_flight: state.inFlight,
    queue_depth: state.queue.length,
  };
}

export function getAllConnectorHealth(): Record<string, ConnectorHealthSnapshot> {
  const result: Record<string, ConnectorHealthSnapshot> = {};
  for (const key of states.keys()) {
    result[key] = getConnectorHealth(key);
  }
  return result;
}
