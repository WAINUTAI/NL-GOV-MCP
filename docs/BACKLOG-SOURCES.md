# Source Backlog (Open data + free API calls)

Captured from operator guidance on 2026-03-02.

## Priority A (high-impact, open + free)

1. **PDOK (Kadaster)**
   - Scope: BAG/BGT/BRT/TOPNL/AHN via OGC/WMS/WFS/WMTS
   - Why: geo base layer for most public-sector use cases
   - Adapter needed: OGC adapter

2. **Nationaal GeoRegister (NGR)**
   - Scope: dataset/service discovery via GeoNetwork/CSW/API
   - Why: automatic source discovery and metadata harvesting
   - Adapter needed: geo-discovery adapter

3. **Open Raadsinformatie / ORI (ODS)**
   - Scope: agenda, besluiten, moties, stukken for municipalities/provinces/water boards
   - Why: governance/public decision workflows
   - Adapter needed: ORI/ODS adapter

4. **NDW Open Data**
   - Scope: traffic/flow products and feeds
   - Why: mobility dashboards and policy monitoring
   - Adapter needed: NDW REST/feed adapter

5. **RDW Open Data**
   - Scope: vehicle + parking related open datasets
   - Why: municipal mobility and enforcement insights
   - Adapter needed: REST JSON adapter

6. **Rijkswaterstaat Waterdata**
   - Scope: water levels, flow, water temp via services
   - Why: infra/water operations
   - Adapter needed: REST/OGC adapter

7. **Luchtmeetnet API**
   - Scope: air quality measurements
   - Why: public health + environment use cases
   - Adapter needed: REST JSON adapter

8. **Rijksfinanciën / Rijksbegroting**
   - Scope: budget tables (CSV/JSON)
   - Why: public finance analysis
   - Adapter needed: REST/CSV adapter

9. **Rechtspraak Open Data**
   - Scope: case law metadata and ECLI references
   - Why: legal and policy intelligence
   - Adapter needed: REST adapter

10. **RIVM public APIs + Atlas API** ✅
    - Scope: health/environment APIs and map services
    - Why: policy + monitoring scenarios
    - Adapter delivered: `rivm_discovery_search` (discovery + deterministic fallback)

11. **Linked Data/SPARQL endpoints** ✅
    - Scope: Kadaster BAG linked data, RCE linked data
    - Why: semantic cross-source querying
    - Adapter delivered: `bag_linked_data_select`, `rce_linked_data_select` (SELECT-only, LIMIT cap)

## Priority B (open but mixed/conditional)

- **DSO / Omgevingswet APIs** (partially delivered)
  - Adapter delivered: `dso_omgevingsdocumenten_search` — discovery-only metadata (titel, type, bevoegd gezag, geldigheidsdatums, viewer-link) via DSO Omgevingsdocumenten Presenteren API v8 (`https://service.omgevingswet.overheid.nl/publiek/omgevingsdocumenten/api/presenteren/v8`). Vereist `DSO_API_KEY` (header `x-api-key`).
  - PDOK Omgevingswet geometrieën (`api.pdok.nl/kadaster/omgevingswet-geometrieen/ogc/v2`) is vector-tiles only — geen OGC API Features `/items` — en daarom niet bruikbaar als open fallback voor documentmetadata.
  - Geometrie-filtering via `_zoek` (Point/Polygon in EPSG:28992) en aanvullende velden (status, regelteksten, annotaties) zijn nog niet opgenomen; volgende iteratie kan `geometrie` body-filter en `geldigOp`/`inWerkingOp` tijdreis-parameters toevoegen.
  - Beheer-/aanbieden-API's (CPA aanbieden, Omgevingsdocument aanbieden, Behandeldienstconfiguratie beheren) blijven uit scope (PKIoverheid-cert vereist).

- **Ruimtelijkeplannen.nl (Wro/Bro plans)** ✅
  - Scope: vigerende, vervallen en ontwerp ruimtelijke plannen (bestemmingsplan, structuurvisie, amvb, regeling)
  - Why: locatiegebonden planologie voor gemeenten/provincies, status- en gemeentefilter
  - Adapter delivered: `ruimtelijke_plannen_search` (PDOK WMS GetFeatureInfo op `plangebied`-laag, keyless, CC-0)

## Optional EU bonus

- **Eurostat Statistics API** ✅ (`eurostat_datasets_search`, `eurostat_dataset_preview`)
- **data.europa.eu Search API** ✅ (`data_europa_datasets_search`)

## Explicit exclusion (for now)

- **Public WOZ-value API** (not available as open public API in desired form)

## Implementation order recommendation

1. OGC adapter (PDOK + RWS + broad geo ecosystem)
2. REST JSON adapter (RDW, Luchtmeetnet, Rijksfinanciën, Rechtspraak)
3. ORI/ODS adapter (raads-/bestuursinformatie)
4. Optional SPARQL adapter (Kadaster/RCE)

## Next concrete actions

- [x] Add `pdok_search` + first `bag_lookup_address` tool scaffold
- [x] Add `ori_search` tool scaffold and first endpoint wiring
- [x] Strengthen `ori_search` with ORI Elastic live extraction
- [x] Add `ndw_search` tool scaffold with sample feed integration
- [x] Strengthen `ndw_search` live retrieval path + normalized output
- [x] Add `luchtmeetnet_latest` tool (authless)
- [x] Enrich `luchtmeetnet_latest` output fields (location/component/value/unit/timestamp)
- [x] Add `rdw_open_data_search`
- [x] Add `rijkswaterstaat_waterdata_search`
- [x] Add `ngr_discovery_search`
- [x] Add `rechtspraak_search_ecli` tool
- [x] Add `rivm_discovery_search` tool
- [x] Add guarded SPARQL tools for BAG + RCE linked data
- [x] Add EU bonus helpers (`eurostat_*`, `data_europa_datasets_search`)
- [x] Add `ruimtelijke_plannen_search` (Wro/Bro plannen via PDOK WMS) met status- en gemeentefilter

## Delivered in v0.2 (juli 2026)

Vijftien nieuwe connectors toegevoegd (24 → 39 connectors; tools 52 → 64: +15 nieuw, −3 opgeschoond, zie Rijksoverheid hieronder), na een geverifieerd bronnenonderzoek (bestaan + gratis toegang + geen overlap, elk los adversarieel gecheckt):

**Keyless (11):**
- `data_politie_search` — misdaad-/overlastcijfers per gemeente/wijk/buurt (CBS dataderden OData v3)
- `cbs_iv3_search` — gemeente-/provinciefinanciën, Iv3 (CBS dataderden OData v3)
- `wetten_bwb_search` — geconsolideerde nationale wetgeving, BWB (KOOP SRU)
- `cvdr_search` — lokale/decentrale regelgeving, CVDR (KOOP SRU)
- `bestuurlijke_gebieden_search` — gemeente-/provinciegrenzen + codes (PDOK OGC API Features)
- `brk_kadastrale_kaart_search` — kadastrale percelen/grenzen (PDOK OGC API Features)
- `bron_ongevallen_search` — geregistreerde verkeersongevallen (Rijkswaterstaat WFS)
- `nza_zorgbeeld_search` — actuele wachttijden medisch-specialistische zorg (NZa, keyless read)
- `overheidsorganisaties_search` — Register van Overheidsorganisaties + TOOI-URI's (KOOP)
- `ovapi_departures` — realtime OV-vertrektijden per halte + GTFS (OVapi/NDOV)
- `bro_ondergrond_search` — grondwater/sonderingen/boringen (BRO publieke REST)

**Gratis API-key (4):**
- `ned_energie_search` — Nationaal Energie Dashboard (`NED_API_KEY`)
- `ep_online_energielabel` — RVO energielabels per adres (`EP_ONLINE_API_KEY`)
- `ns_reisinformatie` — NS reisadviezen/vertrektijden/verstoringen (`NS_API_KEY`)
- `dnb_statistics_search` — DNB Statistics (`DNB_API_KEY`, gratis 'Public'-product)

Alle 11 keyless connectors zijn live geverifieerd tegen de echte endpoints; de OData-connectors gebruiken `trim()`-filtering i.v.m. de vaste-breedte spatie-padding op CBS-dimensiekeys.

### Bewust uitgesloten
- **KVK Handelsregister-API** — betaald abonnement (niet passend voor een open project). De gratis KVK Open Datasets (HVDS, keyless) bevragen alleen op KVK-nummer, geen naam; overgeslagen in v0.2.
- **Waarstaatjegemeente OData** — toegang beperkt tot gemeentelijke medewerkers, niet publiek.
- **WOZ-waardeloket** — werkt maar zit achter een anti-bot/WAF met ongedocumenteerde sessie-flow; te fragiel voor een breed-gedraaide open server.
- **Eerste Kamer / CPB / Rijksvastgoedbedrijf** — geen machine-leesbare query-API (alleen bestandsdownloads).

### Rijksoverheid RSS-migratie (juli 2026)

Rijksoverheid.nl migreerde op 2 juni 2026 naar een nieuw platform; de oude open-data-API (`opendata.rijksoverheid.nl/v1/documents`, `/infotypes/subject`, `/infotypes/ministry`) is opgeheven (HTTP 404). Alleen `/infotypes/schoolholidays` leeft nog.

- `rijksoverheid_search` is herbouwd op het nieuwe keyless RSS-platform `https://www.rijksoverheid.nl/api/rss?query=<JSON>` — met **server-side** keyword-zoek (`resultSearchTerm`) en een `content_type`-filter (`type: news|all`). Dit is functioneel beter dan de oude API, die alleen client-side kon filteren.
- `rijksoverheid_schoolholidays` blijft ongewijzigd (oude host nog actief).
- `rijksoverheid_document`, `rijksoverheid_topics` en `rijksoverheid_ministries` zijn verwijderd (onderliggende endpoints opgeheven, geen schoon equivalent op het nieuwe platform). Netto: 67 → 64 tools.
