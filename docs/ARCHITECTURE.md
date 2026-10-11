# Architecture

Technical overview of how NL-GOV-MCP is structured internally.

## Layer diagram

```
                         ┌─────────────────────┐
                         │    MCP Client        │
                         │  (Claude, Open WebUI)│
                         └─────────┬───────────┘
                                   │
                     ┌─────────────┼─────────────┐
                     │   index.ts — transport     │
                     │   stdio │ SSE │ Stream HTTP │
                     └─────────────┬─────────────┘
                                   │
                     ┌─────────────┴─────────────┐
                     │   server.ts                │
                     │   createServer()           │
                     │   McpServer + registerTools│
                     └─────────────┬─────────────┘
                                   │
                     ┌─────────────┴─────────────┐
                     │   tools.ts                 │
                     │   85 tool handlers         │
                     │   Zod schemas + logic      │
                     └───┬────────┬────────┬─────┘
                         │        │        │
              ┌──────────┘        │        └──────────┐
              ▼                   ▼                    ▼
     ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
     │  sources/*.ts   │  │  utils/*.ts     │  │  types.ts      │
     │  50 connectors  │  │  shared infra   │  │  contracts     │
     └───────┬────────┘  └────────────────┘  └────────────────┘
             │
             ▼
     ┌────────────────┐
     │  http.ts        │
     │  getJson/getText│
     │  postJson       │
     └───────┬────────┘
             │
             ▼
     ┌────────────────────────────┐
     │  connector-runtime.ts      │
     │  cache │ circuit │ queue   │
     └───────────────────────────┘
```

## Request lifecycle

A single tool call flows through these steps:

```
1. MCP client sends tool call (e.g. cbs_tables_search)
          │
2. tools.ts handler validates input (Zod)
          │
3. Handler calls source method  (e.g. CbsSource.tablesSearch)
          │
4. Source builds URL + params, calls http.getJson()
          │
5. http.ts checks cache → circuit breaker → acquires slot → fetch
          │
6. Source normalizes API response into MCPRecord[]
          │
7. Handler applies: cross-reference → pagination → output format
          │
8. toMcpToolPayload() wraps as MCP response
          │
9. Transport sends JSON back to client
```

## Key files

### Core

| File | Role |
|------|------|
| `src/index.ts` | Entry point. Reads `--sse` / `--streamable-http` flags or `MCP_TRANSPORT` env, starts the matching transport. |
| `src/server.ts` | Creates `McpServer` with the server `instructions` (`SERVER_INSTRUCTIONS`, sent at `initialize`), calls `registerTools()`, sets up Express routes for HTTP transports, adds `/health` and `/health/sources` endpoints. |
| `src/tools.ts` | All 85 tool registrations. Each tool has a Zod input schema and an async handler that calls a source, transforms results, and returns via `toMcpToolPayload()`. |
| `src/router/` | The `nl_gov_ask` router: `nl-gov-ask.ts` holds its registration and handler (called from `registerTools()`), `intents.ts` what it reads from a question (places, EU acts, policy and council questions, debates, Algoritmeregister, DSO documents, ECLIs, law articles, research bodies, population questions), `routes.ts` the route chain: which routes a question takes and in what order, shared by the handler and `dryRun`. |
| `src/types.ts` | Shared TypeScript interfaces: `MCPRecord`, `Provenance`, `MCPToolResponse`, `MCPErrorResponse`, `AppConfig`. |
| `src/config.ts` | Loads `config/default.json`, merges env var overrides. |

### Sources (50 connectors)

Each source is a class with one or more async methods. All methods return a normalized shape:

```typescript
{
  items: NormalizedItem[],   // mapped from API-specific format
  total: number,             // total result count from API
  endpoint: string,          // actual URL called
  query: Record<string, string>  // query params sent
}
```

The tool handler in `tools.ts` maps `items` to `MCPRecord[]` and wraps provenance.

| Source file | API type | Connector name |
|-------------|----------|----------------|
| `data-overheid.ts` | CKAN REST | `data_overheid` |
| `cbs.ts` | OData v4 + v3 fallback | `cbs` |
| `tweede-kamer.ts` | OData v4 + REST | `tweede_kamer` |
| `tweede-kamer-debatten.ts` | OData v4 + VLOS XML (verslagen) | `tweede_kamer` |
| `rechtspraak.ts` | POST JSON (search) + open data XML (one ruling by ECLI) | `rechtspraak` |
| `bekendmakingen.ts` | SRU/XML | `officiele_bekendmakingen` |
| `rijksoverheid.ts` | RSS 2.0 XML (`/api/rss`, one platform, several sites in `RSS_SITES`) + REST (school holidays) | `rijksoverheid`, `rekenkamer`, `scp` |
| `rijksbegroting.ts` | HTML scraping | `rijksbegroting` |
| `duo.ts` | REST + OData | `duo` |
| `api-register.ts` | REST (key required) | `api_register` |
| `knmi.ts` | REST (key required) | `knmi` |
| `pdok.ts` | REST (PDOK Locatieserver) | `pdok_bag` |
| `ori.ts` | Elasticsearch (`_search`, and `_doc` for one document's text) | `ori`, `ori_pages` |
| `ndw.ts` | SPARQL | `ndw` |
| `luchtmeetnet.ts` | REST | `luchtmeetnet` |
| `rdw.ts` | CKAN | `rdw` |
| `rijkswaterstaat-waterdata.ts` | CKAN | `rws_waterdata` |
| `ngr.ts` | OGC CSW | `ngr` |
| `rivm.ts` | GeoNetwork CSW + directory listing | `rivm` |
| `sparql-linked-data.ts` | SPARQL (read-only) | `bag_linked_data` / `rce_linked_data` |
| `eurostat.ts` | REST | `eurostat` |
| `data-europa.ts` | Custom Search API | `data_europa` |
| `ruimtelijke-plannen.ts` | PDOK WMS GetFeatureInfo | `ruimtelijke_plannen` |
| `dso-omgevingsdocumenten.ts` | REST HAL (key required) | `dso_omgevingsdocumenten`, `dso_locatieserver`, `dso_bekendmakingen` |
| `bagDetail.ts` | Kadaster REST (key required) | `pdok_bag` (bag_address_detail) |
| `data-politie.ts` | OData v3 (dataderden) | `data_politie` |
| `cbs-iv3.ts` | OData v3 (dataderden) | `cbs_iv3` |
| `wetten-bwb.ts` | SRU/XML (KOOP) + BWB toestand XML from the KOOP repository (article text) | `wetten_bwb` |
| `cvdr.ts` | SRU/XML (KOOP) | `cvdr` |
| `bestuurlijke-gebieden.ts` | OGC API Features | `bestuurlijke_gebieden` |
| `brk-kadastrale-kaart.ts` | OGC API Features | `brk_kadastrale_kaart` |
| `bron-ongevallen.ts` | OGC WFS (GeoJSON) | `bron_ongevallen` |
| `nza-zorgbeeld.ts` | REST | `nza_zorgbeeld` |
| `overheidsorganisaties.ts` | REST (ROO) + TOOI SPARQL | `overheidsorganisaties`, `tooi_sparql` |
| `ovapi.ts` | REST | `ovapi` |
| `bro-ondergrond.ts` | REST (XML/JSON) | `bro` |
| `ned.ts` | REST (key required) | `ned` |
| `ep-online.ts` | REST (key required) | `ep_online` |
| `ns-reisinformatie.ts` | REST (key required) | `ns` |
| `dnb-statistics.ts` | REST (key required) | `dnb` |
| `ruimtelijke-plannen.ts` | PDOK WMS GetFeatureInfo + Locatieserver | `ruimtelijke_plannen` |
| `dso-omgevingsdocumenten.ts` | DSO Presenteren API v8 (REST/HAL+JSON, key required) + PDOK Locatieserver + identifier.overheid.nl and the Officiële Bekendmakingen SRU (bekendmaking of an ontwerp) | `dso_omgevingsdocumenten`; its Locatieserver and bekendmakingen lookups under `dso_locatieserver` and `dso_bekendmakingen`, apart from the circuits of the PDOK and bekendmakingen tools |
| `dso-regeltekst.ts` | STOP XML of the DSO documentstructuur → plain text (no I/O) | used by `dso_omgevingsdocument_tekst` |
| `tenderned.ts` | REST JSON (`papi`) + HTML award parse + PDF text extraction | `tenderned`, `tenderned_recheck` |
| `koop-collecties.ts` | KOOP SRU 2.0, one class per product-area | `tuchtrecht`, `samenwerkende_catalogi` |
| `brp-gewaspercelen.ts` | PDOK WFS 2.0 (GeoJSON) + Locatieserver | `brp_gewaspercelen` |
| `verkiezingsuitslagen.ts` | Kiesraad JSON endpoints + HTML overview parse | `verkiezingsuitslagen` |
| `eu-cellar.ts` | CELLAR SPARQL (EU Publications Office, keyless) | `eu_cellar` |
| `lido.ts` | LiDO REST services (XML): public counts + `get-links` list | `lido` |
| `algoritmeregister.ts` | REST JSON (POST search, keyless) | `algoritmeregister` |
| `wodc.ts` | DSpace 7 REST (discovery search, items, bitstreams) + PDF text extraction | `wodc` |

### Utilities

| File | Purpose |
|------|---------|
| `http.ts` | `getJson()`, `getText()`, `postJson()`, `getBinary()` — all HTTP goes through here. Adds timeout (10s default), retry with exponential backoff (2 retries default), cache lookup, circuit breaker check, concurrency slot acquisition. Throws typed `SourceRequestError`. |
| `connector-runtime.ts` | Per-connector state machine: health counters, circuit breaker (3 failures → open, 5 min cooldown, probe-on-recovery), concurrency limiter (max 3 in-flight, queue with 30s timeout), HTTP response cache (TTL by source category, max 1000 entries, LRU eviction). |
| `response.ts` | Factory functions: `successResponse()`, `errorResponse()`, `mapSourceError()` (translates `SourceRequestError` → typed MCP error), `toMcpToolPayload()` (wraps result for MCP transport). |
| `tool-runner.ts` | `buildFormattedResponse()` — the standard post-processing pipeline: cross-reference enrichment → pagination → output formatting → wrap as success response. Also `dryRunPayload()` and `singleConnectorVerbose()`. |
| `temporal.ts` | Parses natural NL/EN date expressions (`vorige week`, `since 2020`, `tussen 2018 en 2022`) into ISO date ranges. Timezone-aware (default: `Europe/Amsterdam`). |
| `query-rewriter.ts` | Strips question framing from queries ("Wat is...", "Geef mij...") to extract topic keywords. Three levels: `strict`, `moderate`, `passthrough`. |
| `output-format.ts` | Converts `MCPRecord[]` to CSV, GeoJSON, or Markdown table. Handles pagination slicing. |
| `cross-reference.ts` | Extracts identifiers (ECLI, BWBR, gemeente codes) from records and adds `related_links[]` for cross-source matching. |
| `cbs-trends.ts` | Enriches CBS observations with `previous_period`, `previous_value`, `delta`, `delta_pct` when result shape is unambiguous. |
| `logger.ts` | Pino JSON logger, level via `LOG_LEVEL` env. |
| `xml-parser.ts` | `fast-xml-parser` wrapper for SRU/XML sources. |
| `sru-cql.ts` | Free text → valid CQL for the KOOP SRU endpoints. Multi-word input must be AND-joined: a bare phrase is a CQL syntax error the endpoint answers with zero records, and these indexes have no phrase search. |
| `geo.ts` | Shared geo primitive for bbox-driven sources: PDOK Locatieserver lookups (gemeente/woonplaats → RD centroid), bbox construction and EPSG:28992 extent validation. Used by `bron-ongevallen`, `ruimtelijke-plannen` and `brp-gewaspercelen`. |
| `pdf-text.ts` | PDF text-layer extraction (unpdf/pdf.js). `verbosity: 0` is mandatory: on the stdio transport a stray pdf.js console line would corrupt the JSON-RPC stream. Returns typed failures (`no_text_layer`, `encrypted`, `not_a_pdf`, `too_large`, `corrupt`) instead of throwing, and caps both the download (32 MB) and the returned characters. |

## Resilience stack

All resilience is automatic and per-connector. The connector name is inferred from the endpoint URL by `inferConnectorName()`.

```
Request arrives
    │
    ├─ Cache hit? → return cached response (0ms)
    │
    ├─ Circuit open? → throw circuit_open error
    │
    ├─ Concurrency slot available? → proceed
    │   └─ No → queue (30s timeout, then throw timeout)
    │
    ├─ fetch with AbortController timeout (10s)
    │
    ├─ HTTP 429? → retry with Retry-After or exponential backoff
    ├─ HTTP 5xx? → retry with backoff
    ├─ AbortError? → retry with backoff
    │
    ├─ Success → cache response, mark success, reset circuit
    └─ Final failure → mark failure, maybe open circuit
```

**Cache TTL by category:**

| Category | TTL | Sources |
|----------|-----|---------|
| static | 1 hour | CBS, Rijksbegroting, DUO, Eurostat |
| semi_live | 10 min | Tweede Kamer, Rechtspraak, Bekendmakingen, Rijksoverheid, Algemene Rekenkamer, SCP, data.overheid, PDOK, data.europa, the DSO search's Locatieserver and bekendmakingen lookups |
| live | 2 min | Luchtmeetnet, NDW, RDW, Rijkswaterstaat, KNMI |
| discovery | 30 min | NGR, RIVM, ORI, API Register, BAG/RCE Linked Data, Ruimtelijke Plannen, DSO Omgevingsdocumenten, Algoritmeregister, WODC |

The table names the main sources; `CONNECTOR_CATEGORY` in `connector-runtime.ts` is the full list. The cache holds at most 64 MB of response bodies (oldest out first) and never caches a body over 4 MB. Large documents bypass it where it would hold megabytes: the BWB toestand XML (`wetten_bwb_tekst`) and the DSO documentstructuur are parsed once and kept in a small in-source cache instead, and ORI document texts are not cached.

## nl_gov_ask router

`nl_gov_ask` is the one tool that takes a natural-language question. Its router decodes the question, parses date expressions against a real reference time (`temporal.ts`), detects the intent and picks one or more source routes: specific routes first (EU legislation, DSO/Omgevingswet with `DSO_API_KEY`, Tweede Kamer debates, the Algoritmeregister, elections, procurement, disciplinary law, per-school education, air quality), then the broad document and statistics routes, and finally the data.overheid.nl catalogue. Detection is precision-first: a question another route already answered keeps that route. Each route calls the same source classes as the individual tools, searches the topic keywords of the question rather than the sentence, and reports the terms, the routes tried and why one fell through in `access_note`; a failing route is listed in `failures`. The routes and their guards are described in `docs/TOOLS.md` under "Meta router".

## Server instructions and tool metadata

`createServer()` passes `SERVER_INSTRUCTIONS` to the `McpServer`; the client receives them at `initialize`. With a tool search (Claude Code) only tool names and these instructions load upfront, so they say when to reach for this server (start with `nl_gov_ask` when the source is unclear, then that source's own tools), how to read results (cite canonical URLs; `error` is a failure, `failures` lists sources that failed while others answered, zero records without either is a real empty answer, `access_note` explains filters, truncation and fallbacks) and which keys exist. `nl_gov_ask` is registered with `_meta: { "anthropic/alwaysLoad": true }` so it is loaded upfront as well; no other tool carries it. `tests/server-metadata.test.ts` checks both, and that the instructions and every tool description stay within the 2,048 characters at which Claude Code cuts them.

## Response contract

Every tool returns either a success or error shape, serialized as JSON via `toMcpToolPayload()`:

```typescript
// Success
{
  summary: string;
  records: MCPRecord[];           // { title, date?, source_name, canonical_url, snippet?, data? }
  provenance: Provenance;         // { tool, endpoint, query_params, timestamp, total_results?, returned_results }
  access_note?: string;
  failures?: FailureRecord[];
  pagination?: { offset, limit, total, has_more };
  output_format?: "json" | "csv" | "geojson" | "markdown_table";
  formatted_output?: string | Record;
  verbose?: Record;
}

// Error
{
  error: "timeout" | "http_error" | "rate_limited" | "malformed_response"
       | "not_configured" | "circuit_open" | "unexpected";
  message: string;
  suggestion?: string;
  retry_after?: number;
  details?: Record;
}
```

## Adding a new source connector

1. **Create `src/sources/my-source.ts`** — a class with async methods that call `getJson()` / `postJson()` / `getText()` and return `{ items, total, endpoint, query }`.

2. **Register the connector** in `connector-runtime.ts` — add an entry to `CONNECTOR_CATEGORY` and a hostname match to `inferConnectorName()`.

3. **Register tools** in `tools.ts` — define a Zod input schema, call your source method, map results to `MCPRecord[]`, and return via `buildFormattedResponse()` + `toMcpToolPayload()`.

4. **Add tests** — unit tests in `tests/` mocking HTTP calls, and optionally a smoke test for live connectivity.

The HTTP client, caching, circuit breaker, retry, and concurrency limiting are automatic once `getJson()`/`postJson()` is used and the connector name resolves.

## Transport modes

All three transports expose the same 85 tools and are created by `server.ts`:

| Mode | Protocol | Session model | Use case |
|------|----------|---------------|----------|
| **stdio** | stdin/stdout | Single session (process lifetime) | Claude Desktop, Claude Code |
| **SSE** | `GET /mcp` + `POST /messages?sessionId=` | Per-connection, in-memory map | Open WebUI, legacy MCP clients |
| **Streamable HTTP** | `POST /mcp` + `GET /mcp` + `DELETE /mcp` | `mcp-session-id` header, in-memory map | MCP spec 2025-03-26 compliant clients |

HTTP transports also serve `/health` and `/health/sources` for monitoring.

Each HTTP session gets its own `McpServer` from `createServer()` (roughly 14 MB per session). Sessions are bounded: one without requests and without an open stream for `NL_GOV_SESSION_TTL_MS` (default 30 min) is closed, and at `NL_GOV_MAX_SESSIONS` (default 100 per transport) the least recently used one is closed to make room. `NL_GOV_HTTP_HOST` sets the interface to bind, `NL_GOV_ALLOWED_ORIGINS` an Origin allowlist (others get `403`). A body that is not valid JSON gets `400` with JSON-RPC error `-32700`, one over 1 MB `413` with `-32600`, without stack traces or file paths.
