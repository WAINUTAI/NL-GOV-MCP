# NL-GOV-MCP

MCP server for Dutch public-sector data sources with both **stdio** and **SSE/HTTP** transport.

## Features
- MCP tools with consistent response contract:
  - `summary`
  - `records[]`
  - `provenance`
  - optional `access_note`
- Graceful error mapping (`timeout`, `http_error`, `rate_limited`, `malformed_response`, `not_configured`, `unexpected`)
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
  - ORI/ODS (`ori_search` with deterministic fallback when endpoints are unstable)
  - NDW (`ndw_search` with REST/CKAN attempts + fallback)
  - Luchtmeetnet (`luchtmeetnet_latest`, authless, fallback if API unavailable)
  - Rechtspraak (`rechtspraak_search_ecli`, XML feed parse + deterministic fallback)
- Router/meta-tool: `nl_gov_ask` (NL/EN keyword routing with fallback, percent-encoded question decoding, stronger holiday/CBS/API routing)

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
