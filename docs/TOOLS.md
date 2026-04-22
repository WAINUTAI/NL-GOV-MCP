# Tool Catalog

## data.overheid.nl
- `data_overheid_datasets_search`
- `data_overheid_dataset_get`
- `data_overheid_organizations`
- `data_overheid_themes`

## CBS
- `cbs_tables_search`
- `cbs_table_info`
- `cbs_observations`
  - injects lightweight trend fields when the result shape clearly supports it:
    - `previous_period`
    - `previous_value`
    - `delta`
    - `delta_pct`
  - only activates when there is a single clear period dimension and one numeric measure

## Tweede Kamer
- `tweede_kamer_documents`
- `tweede_kamer_search`
- `tweede_kamer_document_get`
  - default: lean metadata + resource endpoints
  - optional: `resolve_resource` to expose resolved file metadata/URL
  - optional: `include_text` to fetch a capped preview for text-like resources
  - PDFs stay resource-only in lean mode (no built-in PDF text extraction)
  - `nl_gov_ask` can auto-deepen the top match on explicit content/summary questions
- `tweede_kamer_votes`
- `tweede_kamer_members`

## Officiële Bekendmakingen
- `officiele_bekendmakingen_search`
- `officiele_bekendmakingen_record_get`

## Rijksoverheid
- `rijksoverheid_search`
- `rijksoverheid_document`
- `rijksoverheid_topics`
- `rijksoverheid_ministries`
- `rijksoverheid_schoolholidays`

## Rijksbegroting
- `rijksbegroting_search`
- `rijksbegroting_chapter`

## DUO
- `duo_datasets_search`
- `duo_schools`
- `duo_exam_results`
- `duo_rio_search`

## API register (key required)
- `overheid_api_register_search` (`OVERHEID_API_KEY`)

## KNMI (key required)
- `knmi_datasets` (`KNMI_API_KEY`)
- `knmi_search_datasets` (`KNMI_API_KEY`)
- `knmi_latest_files` (`KNMI_API_KEY`)
- `knmi_latest_observations` (`KNMI_API_KEY`)
- `knmi_warnings` (`KNMI_API_KEY`)
- `knmi_earthquakes` (`KNMI_API_KEY`)

## PDOK / BAG
- `pdok_search`
- `bag_lookup_address`
  - gebruikt PDOK Locatieserver v3_1
  - bij tijdelijke onbereikbaarheid: deterministische fallback met duidelijke `access_note`
- `bag_address_detail`
  - resolves an address (free-text `query` or PDOK `pdok_id`) to authoritative BAG detail
  - step 1: PDOK Locatieserver `/free` + `/lookup` for official `adresseerbaarobject_id` + `pandid`
  - step 2: Kadaster BAG REST (`/lvbag/individuelebevragingen/v2/verblijfsobjecten/{id}` + `/panden/{id}`) for `oppervlakte_m2`, `gebruiksdoelen`, `bouwjaar`, statuses
  - requires `BAG_API_KEY` for step 2; without it the tool returns Locatieserver-only (`data_kwaliteit: "lookup_only"`)
  - response flags `data_kwaliteit`: `hard` (both REST hits) | `partial` (one) | `lookup_only` (none)
  - complements `bag_linked_data_select` when the Labs SPARQL endpoint is slow or down

## ORI / Open Raadsinformatie
- `ori_search`
  - endpoint discovery via ORI Elastic `_search`
  - extractie van live hits naar `id/title/type/organization/publishedAt/url`
  - bij instabiele endpointtoegang: deterministische fallback met `access_note`

## NDW
- `ndw_search`
  - live discovery op NDW open pages/docs (opendata/docs/dexter)
  - output genormaliseerd met `id/title/description/updated_at/source/url`
  - fallbackrecord bij onbereikbaarheid/instabiliteit

## Luchtmeetnet
- `luchtmeetnet_latest`
  - authless latest measurements
  - verrijkte output: `location_name/component/value/unit/timestamp` + coordinaten
  - fallback-measurement met vaste timestamp/waarde als endpoint niet bereikbaar is

## RDW
- `rdw_open_data_search`
  - live query op RDW open dataset (voertuigen)
  - zoek op kenteken/merk/handelsbenaming/voertuigsoort

## Rijkswaterstaat Waterdata
- `rijkswaterstaat_waterdata_search`
  - live cataloguszoeking via Waterwebservices metadata
  - resultaten bevatten parameter + eenheid/categorie/hoedanigheid
- `rijkswaterstaat_waterdata_measurements`
  - real-time metingen van RWS stations (waterstanden, golven, debiet, temperatuur)
  - combineert meettype + optionele locatienaam in zoekopdracht
  - retourneert actuele waarden met timestamp, eenheid en stationsinformatie

## Nationaal GeoRegister (NGR)
- `ngr_discovery_search`
  - CSW discovery via GetRecords (CQL AnyText)
  - retourneert metadatarecords met titel + metadata URL

## Rechtspraak
- `rechtspraak_search_ecli`
  - gebruikt Rechtspraak zoekfeed en extraheert ECLI
  - fallback genereert deterministisch ECLI-resultaat met `access_note`

## RIVM
- `rivm_discovery_search`
  - discovery/search helper for RIVM public datasets
  - primary: GeoNetwork CSW (`data.rivm.nl/geonetwork/srv/eng/csw`) with CQL AnyText
  - secondary: directory listing fallback (`data.rivm.nl/data/`)
  - deterministic fallback record when live discovery is unstable

## Linked Data / SPARQL (guarded)
- `bag_linked_data_select`
  - Kadaster BAG SPARQL endpoint (`SELECT` only)
  - keyword guardrails block update/construct/service-style operations
  - comment-stripper is URI-aware: `#` inside `<http://...#fragment>` is not mistaken for a SPARQL `#` comment (previously caused valid queries with `XMLSchema#` / `rdf-schema#` prefixes to be rejected as "Alleen SELECT")
  - LIMIT is capped (max 100)
  - deterministic fallback on endpoint instability
  - when the Labs SPARQL endpoint is down, prefer `bag_address_detail` for authoritative per-address detail
- `rce_linked_data_select`
  - RCE SPARQL endpoint (`SELECT` only)
  - same read-only guardrails and LIMIT cap
  - deterministic fallback on instability

## EU bonus
- `eurostat_datasets_search`
  - deterministic Eurostat dataset catalog helper (search suggestions)
- `eurostat_dataset_preview`
  - fetches preview observations from Eurostat dataset code
- `data_europa_datasets_search`
  - data.europa.eu Search API helper (`data.europa.eu/api/hub/search/search`) (+ fallback)

## Meta router
- `nl_gov_ask`
  - decodes percent-encoded questions before routing
  - prioritizes school holiday queries to `rijksoverheid_schoolholidays` with fallback attempts
  - improved CBS ranking for municipality/education phrasing

## Known limits / behavior notes
- KNMI `knmi_warnings` (`waarschuwingen_nederland_48h`) and `knmi_earthquakes` (`aardbevingen_nederland`) try multiple dataset candidates and return a clear `access_note` if none currently resolves.
- DUO `duo_schools` and `duo_exam_results` aggregate several query variants and include `helper_query` in record data for provenance.
- API register search uses official endpoints first; if unavailable, deterministic HTML-card scoring fallback is used.

## Response contract
All success responses return:
- `summary`
- `records`
- `provenance`
- optional `access_note`

Error responses return:
- `error`
- `message`
- optional `suggestion`, `retry_after`, `details`
