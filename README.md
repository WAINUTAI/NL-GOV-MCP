# NL-GOV-MCP

Dutch public-sector data is scattered across many sources that do not natively work together. CBS does not know what Tweede Kamer publishes. BAG does not know what DUO knows. Rechtspraak is disconnected from Rijksbegroting.

`NL-GOV-MCP` connects what the Dutch government has not connected itself: **one interface, many sources, one question, one answer — with provenance**.

It is an open-source [Model Context Protocol](https://modelcontextprotocol.io/) server that lets AI assistants search, combine, and return data from Dutch public-sector sources. Built by [WAINUT](https://wainut.ai), a one-stop AI shop in the Netherlands (AI Recruitment, AI Consulting & Implementation, AI & Data Training).

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

## Sources (22 connectors, 50 tools)

| Source | What it covers |
|---|---|
| CBS | Statistics Netherlands (demographics, economy, housing, labour; v4/v3 + fallback) |
| Tweede Kamer | Parliamentary documents, search, voting records, member info; single-document retrieval can optionally resolve resource URLs and include capped text previews for text-like formats |
| Officiële Bekendmakingen | Official publications (SRU/XML search + lookup) |
| Rijksoverheid | National government search, docs, topics, ministries, school holidays |
| Rijksbegroting | National budget data + chapter helper |
| DUO | Education datasets + school/exam helpers + RIO adapter |
| data.overheid.nl | National open data catalog (CKAN) |
| Overheid API register | API directory (requires `OVERHEID_API_KEY`) |
| KNMI | Weather datasets/files, warnings, earthquakes (requires `KNMI_API_KEY`) |
| PDOK / BAG | Geospatial search, BAG address registry, and authoritative per-address detail (oppervlakte, bouwjaar, gebruiksdoelen) via Kadaster Individuele Bevragingen REST API |
| Rechtspraak | Court rulings via official `uitspraken.rechtspraak.nl` search backend |
| RDW | Vehicle open data |
| Luchtmeetnet | Live air quality measurements |
| Rijkswaterstaat | Water data catalog + real-time measurements |
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
- optional `pagination` (offset, limit, total, has_more)
- optional `verbose` (request timings, connector health snapshots)

### Built-in resilience (zero-config)
No setup required — the following run automatically in-process:
- Per-connector circuit breaker (auto-disables after repeated failures, probes for recovery)
- Per-connector concurrency limiter (default 3 in-flight, overflow queued with timeout)
- In-process HTTP response cache with hardcoded TTL per source category
- Per-connector health counters (exposed via `/health/sources` on SSE transport)

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

### Structured output & debug modes
- `outputFormat`: `json` (default), `csv`, `geojson`, `markdown_table`
- `offset` / `limit`: pagination with metadata
- `dryRun`: shows planned API calls without executing them
- `verbose`: adds request timings, fallback steps, and connector health snapshots

Available on `nl_gov_ask` and major individual tools: `cbs_tables_search`, `cbs_observations`, `data_overheid_datasets_search`, `duo_datasets_search`, `tweede_kamer_documents`, `tweede_kamer_search`, `officiele_bekendmakingen_search`, `rijksoverheid_search`, `rijksbegroting_search`, `overheid_api_register_search`.

### CBS trend enrichment
- `cbs_observations` injects lightweight trend fields when the result shape clearly supports it:
  - `previous_period`
  - `previous_value`
  - `delta`
  - `delta_pct`
- This only activates when there is a single clear period dimension and one numeric measure, so it stays inert on ambiguous wide tables.

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

Requires **Node.js >= 22**.

```bash
npm ci
npm run build
npm run dev                    # start stdio server (for Claude Desktop / Claude Code)
npm run dev:sse                # SSE/HTTP server on port 3333
npm run dev:streamable-http    # Streamable HTTP server on port 3333 (MCP spec 2025-03-26)
```

To verify your setup:

```bash
npm run check        # type-check without emitting
npm test             # unit tests
npm run test:questions  # integration test suite (offline fixtures)
npm run test:live    # integration test suite (live API calls)
```

## Configuration

### Transport modes

Three transport modes are supported. All expose the same 50 tools.

#### stdio (Claude Desktop, Claude Code)

```bash
npm run dev     # development
npm run start   # production
```

#### SSE/HTTP (Open WebUI, legacy MCP clients)

```bash
npm run dev:sse    # development
npm run start:sse  # production
```

| Endpoint | Description |
|----------|-------------|
| `GET /mcp` | SSE stream |
| `POST /messages?sessionId=...` | Message endpoint |
| `GET /health` | Server health check |
| `GET /health/sources` | Per-connector runtime health snapshot |

#### Streamable HTTP (MCP spec 2025-03-26)

```bash
npm run dev:streamable-http    # development
npm run start:streamable-http  # production
```

| Endpoint | Description |
|----------|-------------|
| `POST /mcp` | Initialize session + send messages |
| `GET /mcp` | Open SSE stream for server-initiated messages |
| `DELETE /mcp` | Terminate session |
| `GET /health` | Server health check |
| `GET /health/sources` | Per-connector runtime health snapshot |

Session management uses the `mcp-session-id` header.

#### Selecting transport via environment

Instead of CLI flags, you can set `MCP_TRANSPORT`:

```bash
MCP_TRANSPORT=sse node dist/src/index.js
MCP_TRANSPORT=streamable-http node dist/src/index.js
```

### Docker

```bash
docker build -f docker/Dockerfile -t nl-gov-mcp .
docker run --rm -p 3333:3333 \
  -e KNMI_API_KEY=your-key \
  -e OVERHEID_API_KEY=your-key \
  nl-gov-mcp
```

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

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NL_GOV_HTTP_PORT` | `3333` | HTTP port for SSE transport |
| `NL_GOV_TIMEZONE` | `Europe/Amsterdam` | Default timezone used by `nl_gov_ask` for natural date parsing |
| `KNMI_API_KEY` | — | Required for KNMI weather tools ([get a free token](https://developer.dataplatform.knmi.nl/open-data-api#token)) |
| `OVERHEID_API_KEY` | — | Required for API register tool ([request a key](https://apis.developer.overheid.nl/apis/key-aanvragen)) |
| `BAG_API_KEY` | — | Required for authoritative per-address detail via `bag_address_detail` (Kadaster Individuele Bevragingen REST). Without it the tool returns Locatieserver-only (`data_kwaliteit: "lookup_only"`). ([request access](https://www.kadaster.nl/zakelijk/producten/adressen-en-gebouwen/bag-api-individuele-bevragingen)) |
| `DSO_API_KEY` | — | Reserved for future Omgevingswet/DSO connector ([request access](https://developer.omgevingswet.overheid.nl/formulieren/api-key-aanvragen-0/)) |
| `MCP_TRANSPORT` | `stdio` | Transport mode: `stdio`, `sse`, or `streamable-http` (alternative to CLI flags) |
| `LOG_LEVEL` | `info` | Pino log level (`debug`, `info`, `warn`, `error`, `silent`) |

## Source-specific details

### Tweede Kamer document retrieval

- `tweede_kamer_documents` stays lean and returns search/discovery metadata.
- `tweede_kamer_document_get` can optionally:
  - resolve the underlying resource URL / file metadata
  - include a capped text preview for text-like resources
- PDFs remain resource-only in lean mode (no built-in PDF text extraction).
- `nl_gov_ask` may automatically deepen the top Tweede Kamer match when the user explicitly asks for content/summary rather than only discovery.

### Rechtspraak details

`rechtspraak_search_ecli` mirrors the official frontend search backend (`/api/zoek`) instead of the legacy open-data feed.

Uses structured parameters instead of natural-language parsing:
- `sort`: `relevance` (default), `date_newest` (publication date desc), `ruling_newest` (ruling date desc)
- `date_filter`: `week`, `month`, `year`, `last_year` (maps to Rechtspraak facet filters)

The LLM interprets user intent and maps it to these parameters. A lightweight server-side query rewriter strips residual question framing as a safety net.

Responses include facet-driven context in `access_note` when filters are applied.

## Documentation

See:
- `docs/ARCHITECTURE.md` — technical internals, layer diagram, request lifecycle, resilience stack
- `docs/SOURCES.md` — endpoint details per connector
- `docs/TOOLS.md` — full tool catalog with behavior notes
- `docs/BACKLOG-SOURCES.md` — planned integrations

## Contributing

PRs are welcome — bug fixes, new source connectors, or improvements to existing ones.

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for setup, workflow, and a step-by-step guide for adding a new source connector.

## License

This project is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for required attribution.

**WAINUT** and **NL-GOV-MCP** are trademarks of WAINUT B.V. The Apache License 2.0 does not grant permission to use these names, trademarks, or branding to imply endorsement of derivative works. Forks and derivative works must retain the [NOTICE](NOTICE) file as required by the license.

---

**About WAINUT** — WAINUT is your one-stop AI shop in the Netherlands. We help organizations adopt AI and build an AI-enabled workforce — from recruiting the right talent, to implementing the right tools, to training teams that actually use them.

Exploring AI for your organization? → [wainut.ai](https://wainut.ai) — Unleash Your Potential.