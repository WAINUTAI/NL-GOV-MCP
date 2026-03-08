# TODO.md — NL-GOV-MCP

Local working TODO only.
Do **not** commit or push this file unless explicitly requested.

Opgeschoond op 2026-03-08.

## Launch / now

Launch-critical restpunten uit de vorige ronde zijn nu afgerond:

- `npm run test:questions` draait nu groen genoeg voor launch:
  - PASS 47
  - FAIL 0
  - SKIP 2
  - alleen transient API-register onbeschikbaarheid skippen nu netjes i.p.v. de hele suite rood te trekken
- `npm run test:live` bestaat nu en draait op een lean subset van de belangrijkste connectors
- CBS trend enrichment is ingebouwd voor observaties wanneer de result-shape dat veilig ondersteunt

## Useful later (not launch-critical)

### 1) Geospatial combo-query
Goal:
- combined geo query flows across:
  - PDOK
  - BAG
  - Kadaster-linked sources

Why later:
- useful, but broader product surface
- more design/integration work than current launch blockers

## Only build if there is a concrete use case

### 2) Bulk export helper
Status: deprioritized.

Example idea:
- `bulk: true`
- row cap (e.g. 10k)
- truncation metadata

Why not now:
- pushes the MCP toward ETL / extraction instead of lean chat-native retrieval
- increases payload size, latency, and complexity
- not needed for the current launch story

### 3) OpenAPI / JSON Schema export
Status: deprioritized.

Example idea:
- `dist/schema.json`
- optional `/schema`

Why not now:
- mainly useful for external integrators, SDK generation, and typed non-chat clients
- current primary use case is MCP attached to chat/agent tools that already consume runtime tool schemas
- adds maintenance surface without much launch value

## Not needed unless product direction changes

### 4) Temporal parser beyond `nl_gov_ask`
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

### 5) DSO / Omgevingswet APIs
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
- Tweede Kamer auto-deepening in `nl_gov_ask` for content/summary intent
- Rechtspraak recency-intent fix
- focused live test profile (`npm run test:live`)
- question suite hardening for transient API-register source outages
- CBS trend enrichment (`previous_period`, `previous_value`, `delta`, `delta_pct`) when safely derivable

---

If this file drifts from reality, trust code + tests + current product direction over old notes.
