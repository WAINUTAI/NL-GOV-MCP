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
  - CBS (v4 with v3 + catalog fallback)
  - Tweede Kamer (documents/search/document/votes/members)
  - Officiële Bekendmakingen (SRU XML search + record lookup)
  - Rijksoverheid (search/document/topics/ministries/schoolholidays)
  - Rijksbegroting (search + chapter helper)
  - DUO datasets + schools/exam helpers + RIO adapter
  - Overheid API register (gated by `OVERHEID_API_KEY`)
  - KNMI (gated by `KNMI_API_KEY`)
- Router/meta-tool: `nl_gov_ask` (NL/EN keyword routing with fallback)

## Run
```bash
npm ci
npm run check
npm test
npm run build
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

See `docs/SOURCES.md` and `docs/TOOLS.md`.
