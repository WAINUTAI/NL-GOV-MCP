# Tool Catalog

## data.overheid.nl
- `data_overheid_datasets_search`
- `data_overheid_dataset_get`
- `data_overheid_organizations`
- `data_overheid_themes`

## CBS
- `cbs_tables_search`
  - probeert CBS OData (v4 en v3); valt terug op data.overheid.nl CKAN-catalog als beide 0 resultaten geven (CBS v4 doet literal substring match — multi-word queries falen vaak)
  - bij CKAN-fallback: expliciete `access_note` zodat duidelijk is dat de endpoint en index wijzigen (minder specifiek op CBS-tabellen)
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
  - Zoekt nieuws/documenten via het Rijksoverheid.nl RSS-platform (`https://www.rijksoverheid.nl/api/rss`), met **server-side** keyword-zoek (`resultSearchTerm`)
  - `type`: `news` (default, alleen nieuwsberichten) of `all` (alle content: nieuws + documenten + persberichten); `date_from`/`date_to` filteren client-side op publicatiedatum
  - Levert ~20 resultaten per query (het RSS-platform biedt geen eenvoudige paginatie); records bevatten titel, canonieke URL, samenvatting en datum
- `rijksoverheid_schoolholidays`
  - Schoolvakanties per schooljaar/regio via de nog actieve `opendata.rijksoverheid.nl`-dataset

> De oude `rijksoverheid_document`, `rijksoverheid_topics` en `rijksoverheid_ministries` zijn verwijderd: hun onderliggende `opendata.rijksoverheid.nl/v1`-endpoints zijn opgeheven na de platformmigratie (2 juni 2026).

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
  - default field list bevat `centroide_ll` en `centroide_rd` zodat adres-records direct lat/lon (EPSG:4326) en RD (EPSG:28992) coördinaten meeleveren
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

## Ruimtelijkeplannen.nl (Wro/Bro)
- `ruimtelijke_plannen_search`
  - PDOK WMS GetFeatureInfo op de `plangebied`-laag (keyless, CC-0)
  - sampling-strategie: bij `gemeente` worden alle woonplaats-centroïden uit PDOK Locatieserver bevraagd (1.5 km half-width per cel); bij alleen een `bbox` valt de tool terug op een 3x3 sample-grid
  - status-filter is een conceptuele alias bovenop de officiële IMRO-planstatussen: `vigerend` matcht `vastgesteld` + `geconsolideerd` + `onherroepelijk`; `vervallen` matcht `vervallen` + `ingetrokken`; `ontwerp` matcht `ontwerp` + `voorontwerp`
  - input-validatie: bbox wordt vooraf gecontroleerd op formaat (4 numerieke waarden, min<max) en op de EPSG:28992 (RD New) extent voor Nederland; ongeldige bbox of niet-bestaande gemeente geven een duidelijke `access_note` zonder upstream WMS-aanroep en zonder de circuit breaker te belasten
  - discovery-only: response bevat `id`, `naam`, `planType`, `status`, `gemeente`, `datum` en directe viewer-URL; géén juridische tekst extractie

## DSO Omgevingsdocumenten (key required)
- `dso_omgevingsdocumenten_search` (`DSO_API_KEY`)
  - DSO Presenteren API v8 (`/regelingen` of `/regelingen/_zoek`) voor omgevingsplannen, omgevingsvisies, programma's en omgevingsverordeningen onder de Omgevingswet
  - filters: `query` (vrije tekst, client-side substring op titel/citeertitel/opschrift/bevoegd gezag), `bevoegdGezag` (TOOI-code), `typeBevoegdGezag` (gemeente/provincie/waterschap/ministerie), `documentType`
  - zonder API-sleutel: typed `not_configured` error met aanvraaglink; PDOK Omgevingswet-tegels zijn geen alternatief (vector tiles bevatten geen documentmetadata)
  - discovery-only: response bevat metadata + viewer-link naar regels-op-de-kaart; géén regelteksten of annotaties

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


## Nieuwe tools (v0.2)

### `data_politie_search`

Search Dutch registered crime statistics (data.politie.nl / CBS dataderden). Filters: `regio` (RegioS code of naam), `soortMisdrijf` (code of naam), `periode` (kaal jaartal of exacte key), `tableId` (default 47013NED). Zet `dimension` op RegioS/SoortMisdrijf/Perioden om geldige filterwaarden te verkennen. Ondersteunt paginatie (`top`/`offset`/`limit`), `outputFormat`, `verbose` en `dryRun`.

### `cbs_iv3_search`

Search CBS Iv3 municipal/provincial finance statistics. Filters: `gemeente` (Gemeenten code of naam), `taakveldBalanspost`, `categorie`, `verslagsoort` (code of naam, bv. begroting/jaarrekening), `tableId` (default 45071NED). Zet `dimension` op Gemeenten/TaakveldBalanspost/Categorie/Verslagsoort om geldige filterwaarden te verkennen. Ondersteunt paginatie (`top`/`offset`/`limit`), `outputFormat`, `verbose` en `dryRun`.

## wetten_bwb_search

Search consolidated Dutch national legislation (BWB) via the KOOP SRU service. Keywords match the title index `overheidbwb.titel` (title search, not full text). Full-pattern tool: supports `offset`/`limit`/`top`, `outputFormat`, `verbose` and `dryRun`. Returns BWBR id, title, competent authority, date and a wetten.overheid.nl link.

## cvdr_search

Search Dutch decentralised/local regulations (CVDR) via the KOOP SRU service. Keywords match the `keyword` index. Full-pattern tool: supports `offset`/`limit`/`top`, `outputFormat`, `verbose` and `dryRun`. Returns CVDR id, title, issuing municipality/authority, date and a lokaleregelgeving.overheid.nl link.

## bestuurlijke_gebieden_search

Search Dutch administrative areas (gemeente/provincie/land) via PDOK Bestuurlijke Gebieden OGC API Features. Filter by exact `naam`, `code`, or an RD New (EPSG:28992) `bbox`. Read-only, keyless. Returns naam, code, identificatie, parent province/country, bbox/centroid and optional GeoJSON geometry (set `includeGeometry=true` for `outputFormat=geojson`). Supports pagination, outputFormat (json/csv/geojson/markdown_table), verbose and dryRun.

## brk_kadastrale_kaart_search

Search Dutch cadastral parcels and map objects (BRK Kadastrale Kaart) via PDOK OGC API Features. bbox-driven (RD New / EPSG:28992). Read-only, keyless. Collections: perceel, kadastralegrens, openbareruimtenaam, bebouwing, nummeraanduidingreeks. Returns kadastrale aanduiding (gemeente/sectie/perceelnummer), grootte (m2), bbox/centroid and optional GeoJSON geometry (set `includeGeometry=true` for `outputFormat=geojson`). Supports pagination, outputFormat (json/csv/geojson/markdown_table), verbose and dryRun. A `bbox` is required.

## bron_ongevallen_search

Zoekt Nederlandse verkeersongevallen (Rijkswaterstaat BRON) via WFS 2.0.0 GetFeature binnen een EPSG:28992 (RD New) bounding box.

**Input:** `bbox` (verplicht, `minx,miny,maxx,maxy` in RD New), `jaar` (`2022`|`2023`|`2024`|`2022_2024`, default `2024`), `afloop` (`letsel`|`dodelijk`|`ums`|`all`, default `all`), `gemeente` (substring-filter), `query` (substring op straat/plaats/gemeente), plus `top`/`offset`/`limit`/`outputFormat` (incl. `geojson`)/`verbose`/`dryRun`.

**Output:** per ongeval id, titel (aard — straat, plaats), jaar, afloop, aard, aantal partijen, vervoerswijzen, locatievelden, maximumsnelheid, RD-coördinaten en een canonieke WFS GetFeature-URL. `total` = `numberMatched` binnen de bbox.

**Voorbeeld:** `bbox='190000,442000,195000,445000', jaar='2023', afloop='dodelijk'`.

## nza_zorgbeeld_search

Search current NZa Zorgbeeld waiting times for Dutch hospital / medical-specialist (MSZ) care.

- **Bron:** NZa Zorgbeeld (`https://zorgbeeld.nza.nl/openapi/WaitingTimeMSZ`), keyless, live (cache-TTL 2 min).
- **Input:** `query` (optioneel, keywords op zorgaanbieder/locatie/specialisme/behandeling/plaats), `kvk` (optioneel, KVK-nummer voor server-side beperking), `treatmentType` (`Behandeling` | `Polikliniekbezoek` | `Diagnostiek`), plus `top`, `offset`/`limit`, `outputFormat`, `verbose`, `dryRun` (vol patroon).
- **Output:** zorgaanbieder, locatie, specialisme, behandeling, behandeltype, wachttijd in dagen (`waitingTimeDays`, `null` bij te weinig observaties), peildatum, adres, KVK-/AGB-code.
- **Let op:** zonder `kvk` wordt de complete dataset opgehaald en client-side gefilterd; `total` reflecteert treffers in de opgehaalde snapshot, geen server-side telling.

## overheidsorganisaties_search

Zoek in het Register van Overheidsorganisaties (ROO/TOOI) op naam.

**Parameters:** `query` (naam-substring), `type` (optionele TOOI type-URI, bv. `https://identifier.overheid.nl/tooi/def/ont/Gemeente`), `enrich` (default true; verrijk met contact/adres, auto-uit boven 15 treffers), plus standaard `top`, `offset`, `limit`, `outputFormat`, `verbose`, `dryRun`.

**Levert per organisatie:** `title` (label), `organisatietype` (afgeleid uit type-URI), `tooi_uri` / `type_uri`, `website`, `telefoon`, `bezoekadres`, canonieke `url` (website indien verrijkt, anders de TOOI-URI). Records zijn lean.

**Voorbeeld:** `query="Amsterdam"` -> gemeente Amsterdam met TOOI-URI `.../gemeente/gm0363`, website amsterdam.nl, telefoon 14 020, bezoekadres Amstel 1.

## ovapi_departures

Realtime vertrektijden van het Nederlandse openbaar vervoer voor één halte (OVapi / KV78Turbo).

- **Input:** `timingPointCode` (verplicht, bv. `32002646`), `line` (optioneel lijnnummerfilter), `top`, `offset`/`limit`, `outputFormat`, `verbose`, `dryRun`.
- **Output:** per vertrek `line`, `lineName`, `destination`, `transportType`, `operator`, `targetDepartureTime`, `expectedDepartureTime`, `delayMinutes`, `tripStopStatus`, `stopName`, `town`.
- **Let op:** vereist een haltecode (geen haltenaam). Codes zijn op te zoeken via 9292 of de OVapi/GTFS-index (`https://gtfs.ovapi.nl/nl/`). Bron is keyless en live (cache 2 min).

## bro_ondergrond_search

Bevraagt de BRO (Basisregistratie Ondergrond) publieke REST-services op `publiek.broservices.nl` (keyless).

- **Input:** `query` (verplicht) — óf een BRO-object-id (GMW/GLD/GMN/CPT/BHR + cijfers, bv. `GMW000000036287`) voor een directe object-lookup, óf een trefwoord om de BRO refcode-domeinen te filteren. Plus `top`, `offset`/`limit` (paginatie), `outputFormat` (json/csv/geojson/markdown_table), `verbose`, `dryRun`.
- **Output:** genormaliseerde records met `broId`, `object_type`, `quality_regime`, `registration_status`, `latitude`/`longitude` (WGS84), `rd_coordinates` (RD/EPSG:28992), `well_code` en canonical object-URL. Bij refcode-zoek: `name`, `uri`, `description` per domein.
- **Read-only, openWorldHint.** Geen API-key nodig.

## ned_energie_search

Search NED.nl (Nationaal Energie Dashboard) opwek/verbruik per energiebron via `/v1/utilizations`. **Key-required** (`NED_API_KEY`, header `X-AUTH-TOKEN`); zonder sleutel volgt een `not_configured`-fout.

- **Inputs:** `type` (alias zon/wind/wind_offshore/gas/kern/verbruik of NED-code), `point` (0=NL, 1-12=provincies, 14=offshore), `granularity` (10min/15min/hour/day/month/year), `activity` (providing/consuming/import/export), `classification` (forecast/current), `timezone` (utc/cet), `validFrom`/`validTo` (tijdvenster op validfrom), `rows`.
- **Output:** per datapunt id, titel (bron · tijdstip), canonical url (`https://api.ned.nl/v1/utilizations/{id}`), energiebron + label, capaciteit (kW), volume (kWh), benuttingsgraad (%), CO2-emissie (kg), emissiefactor, validfrom/validto, lastupdate.
- **Categorie:** live (cache-TTL 2 min).

## `ep_online_energielabel`

Look up the registered energy label (energielabel) for a Dutch address from EP-Online (RVO). Query by `postcode` + `huisnummer` (optioneel `huisletter`, `huisnummertoevoeging`, `detailaanduiding`) of by `bagId` (BAG verblijfsobject-id). Returns energieklasse, registratiedatum, opnamedatum, geldigTot, gebouwtype/-klasse, BAG-ids, EnergieIndex, energiebehoefte, primaireFossieleEnergie, aandeelHernieuwbareEnergie, berekendEnergieverbruik, bouwjaar, certificaathouder. Requires `EP_ONLINE_API_KEY` (Authorization-header, kale key).

## NS Reisinformatie (key required)
- `ns_reisinformatie` (`NS_API_KEY`)
  - NS (Nederlandse Spoorwegen) Reisinformatie API met één `operation`-parameter: `disruptions` (v3, verstoringen/werkzaamheden), `departures` (v2, vertrektijden per station), `arrivals` (v2, aankomsttijden), `trips` (v3, reisadvies)
  - params: `operation`, `station` (vereist voor departures/arrivals), `fromStation`+`toStation` (vereist voor trips), `dateTime` (optioneel ISO-8601), `isActive` (disruptions-filter), `rows` (→ maxJourneys)
  - zonder API-sleutel: typed `not_configured` error met aanvraaglink naar apiportal.ns.nl
  - realtime (`live`): returns lean records met NS-deeplink als canonical url

## dnb_statistics_search

Haalt datapunten op uit de DNB Statistics API (De Nederlandsche Bank).

- **Input**: `dataset` (verplicht: code, pad of volledige endpoint-URL), `query` (optioneel vrije-tekstfilter, client-side), `startPeriod`, `endPeriod` (optionele SDMX-periodes), `rows`.
- **Output**: records met `period`, `value`, `unit`, `label`, `frequency` per datapunt.
- **Auth**: `DNB_API_KEY` vereist (header `Ocp-Apim-Subscription-Key`); zonder key `not_configured`.
- **Voorbeeld**: `{ "dataset": "interest-rates", "startPeriod": "2023", "rows": 24 }`.
