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

10. **RIVM public APIs + Atlas API**
    - Scope: health/environment APIs and map services
    - Why: policy + monitoring scenarios
    - Adapter needed: REST + map adapter

11. **Linked Data/SPARQL endpoints**
    - Scope: Kadaster BAG linked data, RCE linked data
    - Why: semantic cross-source querying
    - Adapter needed: SPARQL adapter

## Priority B (open but mixed/conditional)

- **DSO / Omgevingswet APIs**
  - Availability depends on confidentiality/access profile
  - Add once endpoint access model is confirmed per service

## Optional EU bonus

- **Eurostat Statistics API**
- **data.europa.eu CKAN API**

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
- [x] Add `ndw_search` tool scaffold with sample feed integration
- [x] Add `luchtmeetnet_latest` tool (authless)
- [x] Add `rechtspraak_search_ecli` tool
