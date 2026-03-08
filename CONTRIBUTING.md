# Contributing

Thanks for your interest in NL-GOV-MCP! This guide covers everything you need to get started.

## Prerequisites

- **Node.js >= 22** (LTS recommended)
- npm (comes with Node)
- Git

## Setup

```bash
git clone https://github.com/WAINUTAI/NL-GOV-MCP.git
cd NL-GOV-MCP
npm ci
npm run build
```

Verify everything works:

```bash
npm run check   # type-check
npm test        # unit tests
```

## Optional API keys

Most tools work without any keys. Two sources require a free API key:

| Variable | Where to get it |
|----------|----------------|
| `KNMI_API_KEY` | [KNMI Developer Portal](https://developer.dataplatform.knmi.nl/open-data-api#token) |
| `OVERHEID_API_KEY` | [Overheid API Register](https://apis.developer.overheid.nl/apis/key-aanvragen) |
| `BAG_API_KEY` | [Kadaster BAG API](https://www.kadaster.nl/zakelijk/producten/adressen-en-gebouwen/bag-api-individuele-bevragingen) |

Copy `.env.example` to `.env` and fill in the keys you have:

```bash
cp .env.example .env
```

## Development workflow

1. **Fork** the repo and create a feature branch from `main`
2. Make your changes
3. Run `npm run check && npm test` — both must pass
4. Commit with a clear message describing *what* and *why*
5. Open a PR against `main`

### Running locally

```bash
npm run dev                    # stdio (for Claude Desktop / Claude Code)
npm run dev:sse                # HTTP server on port 3333
npm run dev:streamable-http    # Streamable HTTP on port 3333
```

### Testing

```bash
npm test              # unit tests (mocked, fast)
npm run test:watch    # re-runs on file changes
npm run test:live     # live API calls (requires network)
```

## Adding a new source connector

This is the most common contribution. Follow these four steps:

### 1. Create the source class

Create `src/sources/my-source.ts`:

```typescript
import { getJson } from "../utils/http.js";
import type { AppConfig } from "../types.js";

export class MySource {
  constructor(private readonly config: AppConfig) {}

  async search(query: string, rows: number) {
    const url = "https://api.example.nl/v1/search";
    const { data, meta } = await getJson<{ results: any[]; total: number }>(url, {
      query: { q: query, rows },
      connector: "my_source",      // explicit name, or let inferConnectorName() handle it
    });

    return {
      items: data.results.map((r) => ({
        id: r.id,
        title: r.title,
        url: r.url,
        // ... normalize fields
      })),
      total: data.total,
      endpoint: meta.url,
      query: { q: query, rows: String(rows) },
    };
  }
}
```

By using `getJson()` you automatically get: caching, retry, circuit breaker, concurrency limiting, and structured error handling.

### 2. Register the connector

In `src/utils/connector-runtime.ts`:

- Add to `CONNECTOR_CATEGORY` (pick `static`, `semi_live`, `live`, or `discovery`)
- Add a hostname match to `inferConnectorName()` (only needed if you didn't pass `connector` explicitly)

### 3. Register the tool

In `src/tools.ts`:

```typescript
server.registerTool("my_source_search", {
  description: "Search My Source for ...",
  inputSchema: {
    query: z.string().describe("Search terms"),
    rows: z.number().optional().default(10).describe("Number of results"),
    outputFormat: z.enum(["json", "csv", "markdown_table"]).optional().default("json"),
    offset: z.number().optional().default(0),
    limit: z.number().optional().default(25),
  },
}, async (args) => {
  const config = loadConfig();
  const source = new MySource(config);
  const out = await source.search(args.query, args.rows);

  const records = out.items.map((item) => ({
    title: item.title,
    source_name: "My Source",
    canonical_url: item.url,
    data: { id: item.id },
  }));

  return toMcpToolPayload(buildFormattedResponse({
    summary: `${records.length} results from My Source`,
    records,
    provenance: { tool: "my_source_search", endpoint: out.endpoint, query_params: out.query, timestamp: new Date().toISOString(), returned_results: records.length, total_results: out.total },
    outputFormat: args.outputFormat ?? "json",
    offset: args.offset ?? 0,
    limit: args.limit ?? 25,
    total: out.total,
  }));
});
```

### 4. Add tests

Create `tests/my-source.test.ts` with mocked HTTP responses. See existing tests for patterns (e.g. `tests/response.test.ts`, `tests/output-format.test.ts`).

## Code style

- TypeScript strict mode
- ES modules (`import`/`export`, `.js` extensions in imports)
- No linter enforced yet — follow the patterns in existing files
- Keep source connectors focused: one class per file, normalized return shape
- Prefer simple code over abstractions

## Questions?

Open an issue at [github.com/WAINUTAI/NL-GOV-MCP/issues](https://github.com/WAINUTAI/NL-GOV-MCP/issues).
