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
                     │   48 tool handlers         │
                     │   Zod schemas + logic      │
                     └───┬────────┬────────┬─────┘
                         │        │        │
              ┌──────────┘        │        └──────────┐
              ▼                   ▼                    ▼
     ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
     │  sources/*.ts   │  │  utils/*.ts     │  │  types.ts      │
     │  22 connectors  │  │  shared infra   │  │  contracts     │
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
| `src/server.ts` | Creates `McpServer`, calls `registerTools()`, sets up Express routes for HTTP transports, adds `/health` and `/health/sources` endpoints. |
| `src/tools.ts` | All 48 tool registrations. Each tool has a Zod input schema and an async handler that calls a source, transforms results, and returns via `toMcpToolPayload()`. |
| `src/types.ts` | Shared TypeScript interfaces: `MCPRecord`, `Provenance`, `MCPToolResponse`, `MCPErrorResponse`, `AppConfig`. |
| `src/config.ts` | Loads `config/default.json`, merges env var overrides. |

### Sources (22 connectors)

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
| `rechtspraak.ts` | POST JSON | `rechtspraak` |
| `bekendmakingen.ts` | SRU/XML | `officiele_bekendmakingen` |
| `rijksoverheid.ts` | REST | `rijksoverheid` |
| `rijksbegroting.ts` | HTML scraping | `rijksbegroting` |
| `duo.ts` | REST + OData | `duo` |
| `api-register.ts` | REST (key required) | `api_register` |
| `knmi.ts` | REST (key required) | `knmi` |
| `pdok.ts` / `pdokBag.ts` | REST + SPARQL | `pdok_bag` |
| `ori.ts` | Elasticsearch | `ori` |
| `ndw.ts` | SPARQL | `ndw` |
| `luchtmeetnet.ts` | REST | `luchtmeetnet` |
| `rdw.ts` | CKAN | `rdw` |
| `rijkswaterstaat-waterdata.ts` | CKAN | `rws_waterdata` |
| `ngr.ts` | OGC CSW | `ngr` |
| `rivm.ts` | GeoNetwork CSW + directory listing | `rivm` |
| `sparql-linked-data.ts` | SPARQL (read-only) | `bag_linked_data` / `rce_linked_data` |
| `eurostat.ts` | REST | `eurostat` |
| `data-europa.ts` | Custom Search API | `data_europa` |

### Utilities

| File | Purpose |
|------|---------|
| `http.ts` | `getJson()`, `getText()`, `postJson()` — all HTTP goes through here. Adds timeout (10s default), retry with exponential backoff (2 retries default), cache lookup, circuit breaker check, concurrency slot acquisition. Throws typed `SourceRequestError`. |
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
| semi_live | 10 min | Tweede Kamer, Rechtspraak, Bekendmakingen, Rijksoverheid, data.overheid, PDOK, data.europa |
| live | 2 min | Luchtmeetnet, NDW, RDW, Rijkswaterstaat, KNMI |
| discovery | 30 min | NGR, RIVM, ORI, API Register, BAG/RCE Linked Data |

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

All three transports expose the same 48 tools and are created by `server.ts`:

| Mode | Protocol | Session model | Use case |
|------|----------|---------------|----------|
| **stdio** | stdin/stdout | Single session (process lifetime) | Claude Desktop, Claude Code |
| **SSE** | `GET /mcp` + `POST /messages?sessionId=` | Per-connection, in-memory map | Open WebUI, legacy MCP clients |
| **Streamable HTTP** | `POST /mcp` + `GET /mcp` + `DELETE /mcp` | `mcp-session-id` header, in-memory map | MCP spec 2025-03-26 compliant clients |

HTTP transports also serve `/health` and `/health/sources` for monitoring.
