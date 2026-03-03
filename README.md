# NL-GOV-MCP

MCP server for Dutch public-sector data sources with both **stdio** and **SSE/HTTP** transport.

## Features
- MCP tools with consistent response contract:
  - `summary`
  - `records[]`
  - `provenance`
  - optional `access_note`
- Graceful error mapping (`timeout`, `http_error`, `rate_limited`, `malformed_response`, `not_configured`, `circuit_open`, `unexpected`)
- Built-in runtime resilience (zero-config):
  - per-connector concurrency limiter (default 3 in-flight, queued with timeout)
  - per-connector circuit breaker (threshold/cooldown/probe)
  - in-process HTTP response cache with hardcoded TTL by connector category
  - per-connector health counters/state (exposed on SSE via `/health/sources`)
- Source connectors:
  - data.overheid.nl
  - CBS (v4 with v3 + data.overheid catalog fallback; multi-endpoint observation fallback)
  - Tweede Kamer (documents/search/document/votes/members)
  - Officiële Bekendmakingen (SRU XML search + record lookup)
  - Rijksoverheid (search/document/topics/ministries/schoolholidays)
  - Rijksbegroting (search + chapter helper)
  - DUO datasets + schools/exam helpers (multi-query enrichment with helper provenance) + RIO adapter
  - Overheid API register (gated by `OVERHEID_API_KEY`, official API + deterministic HTML scoring fallback)
  - KNMI (gated by `KNMI_API_KEY`, includes discovery attempts for warnings/earthquakes with explicit availability notes)
  - PDOK/BAG (`pdok_search`, `bag_lookup_address`)
  - ORI/ODS (`ori_search` via live ORI Elastic discovery/extraction + fallback)
  - NDW (`ndw_search` via live NDW discovery pages/docs + normalized output + fallback)
  - Luchtmeetnet (`luchtmeetnet_latest`, authless, enriched measurement shape + fallback)
  - RDW (`rdw_open_data_search`, live voertuig open data)
  - Rijkswaterstaat Waterdata (`rijkswaterstaat_waterdata_search`, live catalog metadata)
  - NGR (`ngr_discovery_search`, live CSW metadata discovery)
  - Rechtspraak (`rechtspraak_search_ecli`, official `uitspraken.rechtspraak.nl/api/zoek` integration with normalized records + deterministic no-match fallback)
  - RIVM (`rivm_discovery_search`, discovery-first with deterministic fallback)
  - Linked Data/SPARQL:
    - Kadaster BAG (`bag_linked_data_select`, SELECT-only + LIMIT guardrails + fallback)
    - RCE (`rce_linked_data_select`, SELECT-only + LIMIT guardrails + fallback)
  - EU bonus:
    - Eurostat (`eurostat_datasets_search`, `eurostat_dataset_preview`)
    - data.europa.eu CKAN (`data_europa_datasets_search`)
- Router/meta-tool: `nl_gov_ask` (NL/EN keyword routing with fallback, percent-encoded question decoding, stronger holiday/CBS/API routing)

### Rechtspraak behavior notes
- `rechtspraak_search_ecli` now mirrors the official frontend search backend (`/api/zoek`) instead of relying on the legacy open-data feed query behavior.
- Date/publication filters can be inferred from natural-language hints in `query`, e.g.:
  - `tot 1 maand geleden` → publicatie-range `BinnenEenMaand` (frontend `pd2` equivalent)
  - `heel 2026` / `dit jaar` → publicatie-range `DitJaar` (frontend `pd3` equivalent)
- Response includes facet-driven context in `access_note` when filters are applied (e.g. `BinnenEenMaand=7`, `DitJaar=24`) for frontend parity checks.

## Run
```bash
npm ci
npm run check
npm test
npm run build
npm run test:questions
```

### stdio transport
```bash
npm run dev
# or
npm run start
```

### SSE transport
```bash
npm run dev:sse
# or
npm run start:sse
```
SSE endpoints:
- `GET /mcp` (SSE stream)
- `POST /messages?sessionId=...`
- `GET /health`
- `GET /health/sources` (per-connector runtime health snapshot)

## Claude Desktop integration (stdio)
You can run this MCP directly from Claude Desktop after cloning/building.

1. Build the project:
```bash
npm ci
npm run build
```
2. Add an MCP server entry in Claude Desktop config using the built entrypoint:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\\Claude\\claude_desktop_config.json`

Example:
```json
{
  "mcpServers": {
    "nl-gov-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/NL-GOV-MCP/dist/src/index.js"],
      "env": {
        "OVERHEID_API_KEY": "...",
        "KNMI_API_KEY": "..."
      }
    }
  }
}
```
3. Restart Claude Desktop.

## Env vars
- `NL_GOV_HTTP_PORT` (default `3333`)
- `KNMI_API_KEY` (required for KNMI tools)
- `OVERHEID_API_KEY` (required for API register tool)

## Docker
```bash
docker build -f docker/Dockerfile -t nl-gov-mcp .
docker run --rm -p 3333:3333 nl-gov-mcp
```

See `docs/SOURCES.md`, `docs/TOOLS.md`, and `docs/BACKLOG-SOURCES.md`.

## License
This project is licensed under the Apache License 2.0.

- License text: [LICENSE](./LICENSE)
- Additional notices: [NOTICE](./NOTICE)
