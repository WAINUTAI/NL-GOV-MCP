# NL-GOV-MCP

Dutch public-sector data is scattered across many sources that do not natively work together. CBS does not know what Tweede Kamer publishes. BAG does not know what DUO knows. Rechtspraak is disconnected from Rijksbegroting.

`NL-GOV-MCP` connects what the Dutch government has not connected itself: **one interface, many sources, one question, one answer — with provenance**.

It is an open-source [Model Context Protocol](https://modelcontextprotocol.io/) server that lets AI assistants search, combine, and return data from Dutch public-sector sources. Built by [WAiNuT](https://wainut.ai), a one-stop AI shop in the Netherlands (AI Recruitment, AI Consulting & Implementation, AI & Data Training).

## What can you do with this?

Ask in plain Dutch or English. The server routes to the right sources, retrieves data, and returns structured results with source traceability.

Examples:
- *"Hoeveel sociale huurwoningen zijn er gebouwd in Rotterdam sinds 2020?"* → combines relevant housing/statistics sources
- *"Wat heeft de Tweede Kamer besloten over stikstof afgelopen maand?"* → parliamentary search with temporal parsing
- *"Welke basisschool in Tilburg scoort het best?"* → DUO-related dataset/search helpers
- *"Toon alle rechtspraak over huurrecht dit jaar"* → Rechtspraak search with date-aware mapping
- *"Wat is de luchtkwaliteit in Utrecht?"* → live Luchtmeetnet retrieval
- *"Geef me de rijksbegroting voor onderwijs"* → Rijksbegroting search + chapter navigation

## How is this different from data.overheid.nl?

`data.overheid.nl` is primarily a catalog that tells you where data lives.

`NL-GOV-MCP` actively retrieves and normalizes data across many sources, can combine cross-source results, and returns a consistent MCP response contract ready for assistants and automations.

## Sources

| Source | What it covers |
|---|---|
| CBS | Statistics Netherlands (demographics, economy, housing, labour; v4/v3 + fallback) |
| Tweede Kamer | Parliamentary documents, search, voting records, member info |
| Officiële Bekendmakingen | Official publications (SRU/XML search + lookup) |
| Rijksoverheid | National government search, docs, topics, ministries, school holidays |
| Rijksbegroting | National budget data + chapter helper |
| DUO | Education datasets + school/exam helpers + RIO adapter |
| data.overheid.nl | National open data catalog (CKAN) |
| Overheid API register | API directory (requires `OVERHEID_API_KEY`) |
| KNMI | Weather datasets/files, warnings, earthquakes (requires `KNMI_API_KEY`) |
| PDOK / BAG | Geospatial search and BAG address registry |
| Rechtspraak | Court rulings via official `uitspraken.rechtspraak.nl` search backend |
| RDW | Vehicle open data |
| Luchtmeetnet | Live air quality measurements |
| Rijkswaterstaat | Water data catalog |
| NDW | Traffic discovery/metadata |
| ORI | Open Raadsinformatie discovery |
| NGR | National Geo Register (CSW metadata) |
| RIVM | Public-health discovery |
| Kadaster BAG (Linked Data) | SPARQL access to building/address linked data |
| RCE (Linked Data) | SPARQL access to cultural heritage linked data |
| Eurostat | EU statistics search + preview |
| data.europa.eu | EU open data catalog |

## Features
- MCP tools with consistent response contract:
  - `summary`
  - `records[]`
  - `provenance`
  - optional `access_note`
  - optional `failures[]` (for partial multi-source failures)
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
- Router/meta-tool: `nl_gov_ask` (NL/EN keyword routing with fallback, percent-encoded question decoding, stronger holiday/CBS/API routing, and multi-source parallel planning when explicit cross-source intent is detected)
- Unified temporal parser (NL/EN) for natural date ranges (e.g. `vorige week`, `afgelopen maand`, `dit jaar`, `sinds 2020`, `tussen 2018 en 2022`) and connector-level date-filter mapping.
- Structured output + pagination (first rollout on high-volume tools): optional `outputFormat` (`json|csv|geojson|markdown_table`) and `offset`/`limit` with `pagination` metadata.
- `nl_gov_ask` now supports `dryRun` (planned calls only, no outbound requests) and `verbose` (request timings, fallback steps, connector health snapshot).
- `cbs_tables_search`, `cbs_observations`, `data_overheid_datasets_search`, `duo_datasets_search`, `tweede_kamer_documents`, and `tweede_kamer_search` also support `dryRun` + `verbose` for low-cost debugging and reproducibility.

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
