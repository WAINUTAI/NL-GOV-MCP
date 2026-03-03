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

## Tweede Kamer
- `tweede_kamer_documents`
- `tweede_kamer_search`
- `tweede_kamer_document_get`
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

## ORI / Open Raadsinformatie
- `ori_search`
  - probeert meerdere bekende ORI endpoints
  - bij instabiele endpointtoegang: deterministische fallback met `access_note`

## NDW
- `ndw_search`
  - probeert NDW REST + CKAN endpointvarianten
  - fallbackrecord bij onbereikbaarheid/instabiliteit

## Luchtmeetnet
- `luchtmeetnet_latest`
  - authless latest measurements
  - fallback-measurement met vaste timestamp/waarde als endpoint niet bereikbaar is

## Rechtspraak
- `rechtspraak_search_ecli`
  - gebruikt Rechtspraak zoekfeed en extraheert ECLI
  - fallback genereert deterministisch ECLI-resultaat met `access_note`

## Meta router
- `nl_gov_ask`
  - decodes percent-encoded questions before routing
  - prioritizes school holiday queries to `rijksoverheid_schoolholidays` with fallback attempts
  - improved CBS ranking for municipality/education phrasing

## Known limits / behavior notes
- KNMI `knmi_warnings` and `knmi_earthquakes` try multiple likely datasets and return a clear `access_note` if no public dataset name currently resolves.
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
