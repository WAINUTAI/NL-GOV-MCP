# Tool Catalog

## Core data.overheid tools
- `data_overheid_datasets_search`
- `data_overheid_dataset_get`
- `data_overheid_organizations`
- `data_overheid_themes`

## CBS
- `cbs_tables_search`
- `cbs_table_info`
- `cbs_observations`

## Parliamentary / publications
- `tweede_kamer_documents`
- `officiele_bekendmakingen_search`

## Other Dutch government sources
- `rijksoverheid_search`
- `rijksbegroting_search`
- `duo_datasets_search`
- `duo_rio_search`

## Key-gated tools
- `overheid_api_register_search` (`OVERHEID_API_KEY`)
- `knmi_datasets` (`KNMI_API_KEY`)
- `knmi_latest_files` (`KNMI_API_KEY`)

## Meta tool
- `nl_gov_ask` keyword router (NL/EN keywords) with fallback to `data_overheid_datasets_search`

## Response contract
All tools return:
- `summary`
- `records`
- `provenance`
- optional `access_note`

Error shape:
- `error`
- `message`
- optional `suggestion`, `retry_after`, `details`
