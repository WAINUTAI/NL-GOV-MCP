/**
 * Runs nl_gov_ask offline, for real, with fetch stubbed: every request is
 * recorded and answered with an empty but valid response, so each route
 * finds nothing and the question walks down the route chain. The trace tells
 * which source the execution asked first, to hold the dryRun plan against.
 *
 * Framework-free (no vitest import), so a script can use it as well.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../../src/tools.js";
import { TTLCache } from "../../src/cache.js";
import { clearHttpCache, getAllConnectorHealth, markConnectorSuccess } from "../../src/utils/connector-runtime.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

export interface TracedRequest {
  /** The source in dryRun's vocabulary (estimated_sources), or the host when unknown. */
  source: string;
  method: string;
  url: string;
  /** How many responses had been delivered when the request went out: 0 for the first route's requests. */
  wave: number;
}

export interface AskTrace {
  requests: TracedRequest[];
  /** The sources of the requests sent before any response came back: the first route, all of it when it runs its sources side by side. */
  firstSources: string[];
  summary?: string;
  error?: string;
}

/** The SRU collection a repository.overheid.nl request searches. */
function sruSource(url: URL): string {
  const cql = url.searchParams.get("query") ?? "";
  if (/c\.product-area==tuchtrecht/.test(cql)) return "tuchtrecht";
  if (/c\.product-area==samenwerkendecatalogi/.test(cql)) return "samenwerkende_catalogi";
  return "ob";
}

/** The source a request belongs to, named as dryRun names it. */
export function sourceOfUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "unknown";
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (host.endsWith("cbs.nl")) return "cbs";
  if (host === "gegevensmagazijn.tweedekamer.nl") return "tk";
  if (host === "repository.overheid.nl") return sruSource(url);
  if (host.endsWith("rijksoverheid.nl")) return "rijk";
  if (host.endsWith("rijksbegroting.nl") || host.endsWith("rijksfinancien.nl")) return "budget";
  if (host.endsWith("duo.nl") || host.endsWith("onderwijsregistratie.nl")) return "duo";
  if (host === "apis.developer.overheid.nl") return "api";
  // A ruling read by its ECLI, apart from the case-law search.
  if (host === "data.rechtspraak.nl" && path.startsWith("/uitspraken/content")) return "rechtspraak_uitspraak";
  if (host.endsWith("rechtspraak.nl")) return "rechtspraak";
  if (host === "zoekservice.overheid.nl" && url.searchParams.get("x-connection") === "BWB") return "wetten_bwb";
  if (host === "repository.officiele-overheidspublicaties.nl" && path.startsWith("/bwb/")) return "wetten_bwb";
  if (host === "www.rekenkamer.nl") return "rekenkamer";
  if (host === "www.scp.nl") return "scp";
  if (host === "repository.wodc.nl") return "wodc";
  if (host === "publications.europa.eu" || host === "eur-lex.europa.eu") return "eu_cellar";
  if (host === "api.openraadsinformatie.nl") return "ori";
  if (host === "algoritmes.overheid.nl") return "algoritmeregister";
  if (host === "www.tenderned.nl") return "tenderned";
  if (host.endsWith("luchtmeetnet.nl")) return "luchtmeetnet";
  if (host.endsWith("verkiezingsuitslagen.nl")) return "verkiezingsuitslagen";
  if (host === "service.pdok.nl" && path.includes("/rvo/brpgewaspercelen/")) return "brp_gewaspercelen";
  // The PDOK Locatieserver finds the gemeente for BRP Gewaspercelen (a
  // search on type gemeente) and the address or place for the DSO.
  if (host === "api.pdok.nl") return url.searchParams.get("fq") === "type:gemeente" ? "brp_gewaspercelen" : "dso_omgevingsdocumenten";
  if (host.endsWith("omgevingswet.overheid.nl")) return "dso_omgevingsdocumenten";
  if (host === "data.overheid.nl") return "data_overheid";
  return host;
}

const EMPTY_SRU = '<?xml version="1.0" encoding="UTF-8"?><sru:searchRetrieveResponse xmlns:sru="http://docs.oasis-open.org/ns/search-ws/sruResponse"><sru:version>2.0</sru:version><sru:numberOfRecords>0</sru:numberOfRecords></sru:searchRetrieveResponse>';

/** An empty answer every JSON source reads as "nothing found". */
const EMPTY_JSON = {
  value: [],
  "@odata.count": 0,
  success: true,
  result: { count: 0, results: [] },
  results: { bindings: [] },
  head: { vars: [] },
  hits: { total: { value: 0, relation: "eq" }, hits: [] },
  type: "FeatureCollection",
  features: [],
  numberMatched: 0,
  numberReturned: 0,
  response: { numFound: 0, docs: [] },
  content: [],
  totalElements: 0,
  items: [],
  data: [],
  total: 0,
  count: 0,
  _embedded: { apis: [] },
};

function emptyResponse(url: string): Response {
  const source = sourceOfUrl(url);
  // Rechtspraak.nl does not know the ECLI: the ruling is not found.
  if (source === "rechtspraak_uitspraak") return new Response("Not found", { status: 404 });
  if (source === "ob" || source === "tuchtrecht" || source === "samenwerkende_catalogi" || source === "wetten_bwb") {
    return new Response(EMPTY_SRU, { status: 200, headers: { "content-type": "application/xml" } });
  }
  return new Response(JSON.stringify(EMPTY_JSON), { status: 200, headers: { "content-type": "application/json" } });
}

export interface AskHarness {
  /** nl_gov_ask with dryRun. */
  plan(question: string): Promise<Record<string, any>>;
  /** nl_gov_ask executed with fetch stubbed. */
  trace(question: string): Promise<AskTrace>;
}

/** Fixed, so the time words in a question resolve the same on every run. */
export const REFERENCE_NOW = "2026-10-06T10:00:00+02:00";

export function createAskHarness(): AskHarness {
  const tools = new Map<string, { schema: Record<string, { parse: (v: unknown) => unknown }>; handler: Handler }>();
  registerTools({
    registerTool(name: string, cfg: { inputSchema?: Record<string, { parse: (v: unknown) => unknown }> }, handler: Handler) {
      tools.set(name, { schema: cfg.inputSchema ?? {}, handler });
    },
  } as unknown as McpServer);
  const ask = tools.get("nl_gov_ask")!;

  const call = async (args: Record<string, unknown>) => {
    const parsed: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(ask.schema)) parsed[key] = schema.parse(args[key]);
    return ask.handler(parsed);
  };

  return {
    async plan(question) {
      const out = await call({ question, dryRun: true, reference_now: REFERENCE_NOW });
      return JSON.parse(out.content[0].text);
    },

    async trace(question) {
      // No cache hits and no open circuits from an earlier question.
      clearHttpCache();
      for (const connector of Object.keys(getAllConnectorHealth())) markConnectorSuccess(connector, 0);
      const requests: TracedRequest[] = [];
      let delivered = 0;
      const realFetch = globalThis.fetch;
      // Nor from the sources' own caches (CBS, data.overheid.nl).
      const realCacheGet = TTLCache.prototype.get;
      TTLCache.prototype.get = function () {
        return undefined;
      } as typeof TTLCache.prototype.get;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        requests.push({ source: sourceOfUrl(url), method: init?.method ?? "GET", url, wave: delivered });
        // Answer on a later turn of the event loop: a route that runs its
        // sources side by side sends all of them before the first answer.
        await new Promise((resolve) => setImmediate(resolve));
        delivered += 1;
        return emptyResponse(url);
      }) as typeof fetch;
      try {
        const out = await call({ question, top: 5, reference_now: REFERENCE_NOW });
        const text = out.content.map((c) => c.text).join("\n");
        let body: Record<string, any> = {};
        try {
          body = JSON.parse(text);
        } catch {
          // A non-JSON output format; the requests still tell the route.
        }
        // An error answer is { error, message } instead of a summary with records.
        const error = typeof body.error === "string" ? `${body.error}: ${String(body.message ?? "")}` : undefined;
        const firstSources = [...new Set(requests.filter((r) => r.wave === 0).map((r) => r.source))];
        // The KNMI and API-register routes answer without a request when their key is missing.
        if (!requests.length && error) {
          if (/KNMI_API_KEY/.test(error)) firstSources.push("knmi");
          else if (/OVERHEID_API_KEY/.test(error)) firstSources.push("api");
        }
        return { requests, firstSources, summary: typeof body.summary === "string" ? body.summary : undefined, error };
      } finally {
        globalThis.fetch = realFetch;
        TTLCache.prototype.get = realCacheGet;
      }
    },
  };
}

/**
 * dryRun's sources as the trace sees them: the debate route asks the Tweede
 * Kamer, as the document route does. Sorted, for comparing as a set: a route
 * that asks its sources side by side has no order between them.
 */
export function asTraced(sources: readonly string[]): string[] {
  return [...new Set(sources.map((s) => (s === "tweede_kamer_debatten" ? "tk" : s)))].sort();
}
