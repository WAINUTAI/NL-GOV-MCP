# TODO.md — NL-GOV-MCP

Local working TODO only.
Do **not** commit or push this file unless explicitly requested.

Opgeschoond op 2026-03-08.

## Launch / now

### 1) Run the question suite
- Command: `npm run test:questions`
- Why: `check`, `test`, and `build` are green, but this is still the most relevant regression check for real user questions.

### 2) Add a focused live test profile
- Goal: add `npm run test:live`
- Scope should stay lean:
  - Rechtspraak
  - Tweede Kamer
  - Officiële Bekendmakingen
  - Rijksoverheid
  - 1-2 geo/data connectors that matter most
- Why: launch risk is now more about upstream behavior than local TypeScript correctness.

### 3) CBS trend injection
Still worth doing before/around launch.

Goal:
- add derived trend fields such as:
  - `previous_period`
  - `delta`
  - `delta_pct`

Why:
- high user value
- relatively contained scope
- makes CBS answers more decision-ready without making the MCP much heavier

## Useful later (not launch-critical)

### 4) Geospatial combo-query
Goal:
- combined geo query flows across:
  - PDOK
  - BAG
  - Kadaster-linked sources

Why later:
- useful, but broader product surface
- more design/integration work than current launch blockers

## Only build if there is a concrete use case

### 5) Bulk export helper
Status: deprioritized.

Example idea:
- `bulk: true`
- row cap (e.g. 10k)
- truncation metadata

Why not now:
- pushes the MCP toward ETL / extraction instead of lean chat-native retrieval
- increases payload size, latency, and complexity
- not needed for the current launch story

### 6) OpenAPI / JSON Schema export
Status: deprioritized.

Example idea:
- `dist/schema.json`
- optional `/schema`

Why not now:
- mainly useful for external integrators, SDK generation, and typed non-chat clients
- current primary use case is MCP attached to chat/agent tools that already consume runtime tool schemas
- adds maintenance surface without much launch value

## Not needed unless product direction changes

### 7) Temporal parser beyond `nl_gov_ask`
Current state:
- natural-language temporal parsing lives in `nl_gov_ask`
- individual tools mostly already accept explicit date inputs like:
  - `date_from`
  - `date_to`
  - `year`

Conclusion:
- only do this if individual tools themselves must accept phrases like:
  - `vandaag`
  - `vorige week`
  - `sinds 2020`
- otherwise leave it alone

## Blocked / conditional

### 8) DSO / Omgevingswet APIs
Blocked by:
- access model
- confidentiality / exposure assumptions
- endpoint availability clarity

Only proceed when:
- service-level assumptions are confirmed

## Done already

These are no longer active TODO items:
- composable / shared tool runner
- structured output rollout on major tools
- pagination rollout on major tools
- `dryRun` rollout on major search tools
- `verbose` rollout on major search tools
- cross-reference linking via `related_links[]`
- temporal/timezone hardening in `nl_gov_ask`
- stdio logging fix for MCP transport
- Tweede Kamer lean document deepening
- Rechtspraak recency-intent fix

---

If this file drifts from reality, trust code + tests + current product direction over old notes.
