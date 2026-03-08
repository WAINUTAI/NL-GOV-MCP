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

### CBS trend enrichment
- `cbs_observations` now injects lightweight trend fields when the result shape clearly supports it:
  - `previous_period`
  - `previous_value`
  - `delta`
  - `delta_pct`
- This only activates when there is a single clear period dimension and one numeric measure, so it stays inert on ambiguous wide tables.

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
npm run test:live
```

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NL_GOV_HTTP_PORT` | `3333` | HTTP port for SSE transport |
| `NL_GOV_TIMEZONE` | `Europe/Amsterdam` | Default timezone used by `nl_gov_ask` for natural date parsing |
| `KNMI_API_KEY` | — | Required for KNMI weather tools |
| `OVERHEID_API_KEY` | — | Required for API register tool |

### Transport modes

#### stdio transport (Claude Desktop, Claude Code)

```bash
npm run dev     # development
npm run start   # production
```

#### SSE/HTTP transport

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

### Claude Desktop integration

Build the project, then add an entry to your Claude Desktop config.

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "nl-gov-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/NL-GOV-MCP/dist/src/index.js"],
}
      "env": {
        "OVERHEID_API_KEY": "...",
        "KNMI_API_KEY": "...",
        "NL_GOV_TIMEZONE": "Europe/Amsterdam"
      }
    }
  }
}
```

### Docker

```bash
docker build -f docker/Dockerfile -t nl-gov-mcp .
docker run --rm -p 3333:3333 nl-gov-mcp
```

## Source-specific details

### Tweede Kamer document retrieval

You can use the generic `nl_gov_ask` tool (which routes to the right source automatically), or target specific sources with dedicated tools like `tweede_kamer_documents`.

All Tweede Kamer tools support:
- Natural date parsing (`vorige maand`, `sinds 2023`, etc.)
- Pagination via `offset` and `limit`
- Output format selection (`json`, `csv`, `markdown_table`)
- Dry run mode for debugging

### Rechtspraak details

The Rechtspraak tool (`rechtspraak_search`, used by `nl_gov_ask` and standalone) maps ECLI to full document URL and publication date. You can filter by:
- Date range
- Court type
- Legal domain

Results include direct links to the full rulings on uitspraken.rechtspraak.nl.

### CBS observations

When querying CBS observations:
- Trend enrichment is automatic when the result has a single period dimension and one numeric measure
- Use `outputFormat: "json"` for machine-readable output
- Use `verbose: true` to see fallback steps and timing

### DUO and education data

DUO datasets include school performance data, exam results, and RIO (school registry) information. Use the `duo_datasets_search` tool to discover available datasets, then use specific tools for retrieval.

## Documentation

Full documentation is available in the `/docs` folder:

- [Architecture overview](./docs/ARCHITECTURE.md)
- [Tool reference](./docs/TOOLS.md)
- [Source connectors](./docs/CONNECTORS.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)

## Contributing

Contributions are welcome! Please read the [contributing guide](./CONTRIBUTING.md) before submitting PRs.

### Adding new sources

1. Create a new connector in `src/connectors/`
2. Implement the `SourceConnector` interface
3. Add the source to the registry in `src/registry.ts`
4. Add tests in `tests/connectors/`
5. Update this README with the new source

## License

MIT License - see [LICENSE](./LICENSE) for details.
