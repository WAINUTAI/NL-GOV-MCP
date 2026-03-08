# TODO.md — NL-GOV-MCP

Actuele open punten, opgeschoond op 2026-03-08.

## Immediate / operational

1. **Run question suite after latest temporal/timezone changes**
   - Command: `npm run test:questions`
   - Reason: `check`, `test`, and `build` are green, but the question suite remains the main real-world integration regression check.

2. **Commit and push current temporal/timezone patch**
   - Includes:
     - server-side temporal context with explicit timezone handling
     - `NL_GOV_TIMEZONE`
     - `reference_now` / `timezone` support in `nl_gov_ask`
     - README clarification that natural date parsing currently lives in `nl_gov_ask`

## Open product / engineering items

### 1) CBS trend injection
Still open.

Goal:
- add derived trend fields such as:
  - `previous_period`
  - `delta`
  - `delta_pct`

Why:
- makes CBS outputs more decision-ready without forcing downstream consumers to compute deltas manually.

### 2) Geospatial combo-query
Still open.

Goal:
- add combined geo query flows across:
  - PDOK
  - BAG
  - Kadaster-linked sources

Why:
- this unlocks more useful location-based public-sector workflows than isolated source calls.

### 3) Bulk export helper
Still open.

Goal:
- support bulk-style export patterns such as:
  - `bulk: true`
  - max row ceiling (target idea previously: up to 10k)
  - explicit truncation metadata when the cap is hit

Why:
- useful for data extraction and downstream analysis pipelines.

### 4) Live integration test profile
Still open.

Goal:
- add a dedicated live test command, e.g.:
  - `npm run test:live`

Current state:
- available now:
  - `npm run check`
  - `npm run test`
  - `npm run build`
  - `npm run test:questions`
- missing:
  - per-connector live integration test profile

Why:
- separates unit/contract checks from real upstream endpoint validation.

### 5) OpenAPI / JSON Schema export
Still open.

Goal:
- generate schema artifacts such as:
  - `dist/schema.json`
- optionally expose via HTTP endpoint:
  - `/schema`

Why:
- improves interoperability, tool discovery, and external integration.

## Decision point (not necessarily required)

### Temporal parser rollout beyond `nl_gov_ask`
Currently **not implemented tool-wide**.

Current state:
- natural-language temporal parsing lives in `nl_gov_ask`
- individual tools mostly already accept explicit date inputs like:
  - `date_from`
  - `date_to`
  - `year`

Decision needed:
- only build this if we want individual tools themselves to accept phrases like:
  - `vandaag`
  - `vorige week`
  - `sinds 2020`

Conclusion:
- this is a product choice, not an urgent technical gap.

## Conditional / backlog item

### DSO / Omgevingswet APIs
Still conditional.

Blocked by:
- access model / confidentiality / endpoint availability confirmation

Only proceed when:
- service-level access assumptions are confirmed.

## Already done (removed from active TODO)

These were previously open, but are no longer active TODO items:

- composable / shared tool runner
- structured output rollout
- pagination rollout on major tools
- `dryRun` rollout on major search tools
- `verbose` rollout on major search tools
- cross-reference linking via `related_links[]`

---

If this file drifts from reality, prefer code + tests + `git log` over old chat summaries.
