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

## Key features

### Consistent response contract
Every tool returns the same shape:
- `summary`
- `records[]`
- `provenance`
- optional `access_note`
- optional `failures[]`

### Built-in resilience (zero-config)
No setup required — the following run automatically in-process:
- Per-connector circuit breaker (auto-disables after repeated failures, probes for recovery)
- Per-connector concurrency limiter (default 3 in-flight, overflow queued with timeout)
- In-process HTTP response cache with hardcoded TTL per source category
- Per-connector health counters (exposed via `/health/sources` on SSE transport)
- Shared composable tool runner for search-style tools (single implementation for pagination, formatting, dry-run and verbose diagnostics rollout)

### Graceful error handling
Typed errors:
- `timeout`
- `http_error`
- `rate_limited`
- `malformed_response`
- `not_configured`
- `circuit_open`
- `unexpected`

This lets assistants respond meaningfully instead of failing hard.

### Structured output
Optional `outputFormat` on supported tools:
- `json`
- `csv`
- `geojson`
- `markdown_table`

Pagination via `offset` / `limit` with metadata (`pagination`).

### Debug modes
- `dryRun`: shows planned API calls without executing them
- `verbose`: adds request timings, fallback steps, and connector health snapshots

Available on `nl_gov_ask` and major individual tools (`cbs_tables_search`, `cbs_observations`, `data_overheid_datasets_search`, `duo_datasets_search`, `tweede_kamer_documents`, `tweede_kamer_search`, `officiele_bekendmakingen_search`, `rijksoverheid_search`, `rijksbegroting_search`, `overheid_api_register_search`).

### Smart routing + temporal parsing
- `nl_gov_ask` routes by intent, and can run multi-source queries in parallel.
- Natural date expressions in NL/EN are currently parsed in `nl_gov_ask` and mapped to source filters (`vorige week`, `sinds 2020`, `between 2018 and 2022`, etc.).
- Temporal parsing is resolved server-side with a real reference timestamp, cross-platform via Node runtime APIs (Windows/macOS/Linux).
- Default timezone: `Europe/Amsterdam`.
- Override options for `nl_gov_ask`:
  - tool input: `timezone`
  - tool input: `reference_now`
  - environment: `NL_GOV_TIMEZONE`
  - config: `config/default.json` → `temporal.defaultTimeZone`

### Cross-reference linking
Post-processing adds `related_links[]` when records share key identifiers (e.g. `ECLI`, `BWBR`, municipality codes), and can enrich legal references with direct links to `wetten.overheid.nl`.

## Quick start

```bash
npm ci
npm run check
npm test
npm run build
npm run test:questions
```

### stdio transport (Claude Desktop, Claude Code)

```bash
npm run dev     # development
npm run start   # production
```

### SSE/HTTP transport

```bash
npm run dev:sse    # development
npm run start:sse  # production
```

SSE endpoints:

| Endpoint | Description |
|----------|-------------|
| `GET /mcp` | SSE stream |
| `POST /messages?sessionId=...` | Message endpoint |
| `GET /health` | Server health check |
| `GET /health/sources` | Per-connector runtime health snapshot |

### Docker

```bash
docker build -f docker/Dockerfile -t nl-gov-mcp .
docker run --rm -p 3333:3333 nl-gov-mcp
```

## Claude Desktop integration

Build the project, then add an entry to your Claude Desktop config.

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "nl-gov-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/NL-GOV-MCP/dist/src/index.js"],
      "env": {
        "OVERHEID_API_KEY": "...",
        "KNMI_API_KEY": "...",
        "NL_GOV_TIMEZONE": "Europe/Amsterdam"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NL_GOV_HTTP_PORT` | `3333` | HTTP port for SSE transport |
| `NL_GOV_TIMEZONE` | `Europe/Amsterdam` | Default timezone used by `nl_gov_ask` for natural date parsing |
| `KNMI_API_KEY` | — | Required for KNMI weather tools |
| `OVERHEID_API_KEY` | — | Required for API register tool |

## Rechtspraak details

`rechtspraak_search_ecli` mirrors the official frontend search backend (`/api/zoek`) instead of the legacy open-data feed.

Date/publication filters are inferred from natural language:
- *"tot 1 maand geleden"* → `BinnenEenMaand`
- *"heel 2026"* / *"dit jaar"* → `DitJaar`

Responses include facet-driven context in `access_note` when filters are applied.

## Documentation

See:
- `docs/SOURCES.md`
- `docs/TOOLS.md`
- `docs/BACKLOG-SOURCES.md`

## Contributing

NL-GOV-MCP is open source. If you find a bug, want to add a source connector, or improve existing ones — PRs are welcome.

## License

This project is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for additional details.

---

Built and maintained by [WAiNuT](https://wainut.ai) — AI Recruitment, AI Consulting & Implementation, AI & Data Training.
For custom implementations, government integrations, or AI training: [get in touch](https://wainut.ai).
