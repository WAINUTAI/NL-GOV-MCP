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
- `rijksoverheid_schoolholidays` blijft ongewijzigd van host, maar de **no-year-aanroep is gefixt**: `/infotypes/schoolholidays` (zonder schooljaar) geeft een JSON-*array* van schooljaar-documenten terug i.p.v. één object; de connector normaliseert nu `data` naar een lijst en itereert per document over `content`. Zonder jaar-argument komen nu alle beschikbare schooljaren terug (live: 66 items over 6 schooljaren) i.p.v. 0.
- `rijksoverheid_document`, `rijksoverheid_topics` en `rijksoverheid_ministries` zijn verwijderd (onderliggende endpoints opgeheven, geen schoon equivalent op het nieuwe platform). Netto: 67 → 64 tools.

### Rijkswaterstaat WaterWebservices-migratie (juli 2026)

Rijkswaterstaat heeft de klassieke WaterWebservices (`waterwebservices.rijkswaterstaat.nl`) uitgefaseerd (301 → HTML-foutpagina → `malformed_response`) en vervangen door het nieuwe WADAR-platform (go-live 5 dec 2025, oude omgeving uit eind april 2026). Beide RWS-tools zijn hierop herbouwd en live geverifieerd:

- Nieuwe host `https://ddapi20-waterwebservices.rijkswaterstaat.nl`; paden `/METADATASERVICES/OphalenCatalogus` en `/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen` (zonder de oude `_DBO`-suffix).
- `OphalenLaatsteWaarnemingen` vereist nu een expliciete `LocatieLijst`; het "alle stations in één keer"-model bestaat niet meer. `rijkswaterstaat_waterdata_measurements` resolvet de gevraagde meetgrootheid + locatie(s) tegen de catalogus (via `AquoMetadataLocatieLijst`), en valt zonder locatie terug op een lijst met referentiestations (Hoek van Holland, IJmuiden, Vlissingen, Lobith, …).
- Coördinaten zijn nu `Lat`/`Lon` (ETRS89, EPSG:4258) i.p.v. RD-`X`/`Y`; kwaliteit/status zijn enkelvoudige velden (`Kwaliteitswaardecode`, `Statuswaarde`) i.p.v. de oude `...Lijst`-arrays.
- Meetgrootheid-codes gecorrigeerd tegen de nieuwe catalogus: golfhoogte `GOLHTE` → `Hm0`, stroomsnelheid `STRMDg` → `STROOMSHD` (de oude codes bestaan niet meer en gaven stil 0 resultaten). `WATHTE`/`Q`/`T`/`WINDSHD`/`WINDRTG`/`ZICHT` ongewijzigd; `WATDTE` (waterdiepte) en `STROOMRTG` (stroomrichting) toegevoegd.
- De catalogus (quasi-statisch, ~1,5 MB) krijgt een eigen cache-TTL van 1 uur i.p.v. de 2-minuten "live"-TTL.

### Volledige live health-check + fixes (juli 2026)

Alle 64 tools zijn live tegen hun echte endpoints aangeroepen en geclassificeerd (50 OK / 7 leeg / 3 error / 4 geen-key). De v0.2-connectors die de testsuite niet dekte bleken te werken; de gevonden afwijkingen zijn per stuk live gediagnosticeerd en gefixt:

- **ruimtelijke_plannen_search** — gaf `malformed_response` doordat een PDOK WMS GetFeatureInfo-sample ~14,5 MB volledige plangeometrie teruggeeft en daarmee de globale 12 MB body-cap in `http.ts` overschreed. De connector gebruikt alleen `properties` (geometrie wordt weggegooid), dus de per-call cap is verhoogd (48 MB) en elke sample vangt nu zijn eigen fout op zodat één zware call de hele `Promise.all` niet meer sloopt.
- **bron_ongevallen_search** — de geadverteerde `gemeente`-parameter werkte niet (alleen `bbox`). Er is nu gemeente→bbox-resolutie via de PDOK Locatieserver (±12 km), net als bij ruimtelijke_plannen, met behoud van de client-side gemeentefilter.
- **knmi_latest_files** — de schema-default `datasetVersion="1"` gaf 404; de versie wordt nu automatisch uit de KNMI-datasetcatalogus geresolved (bv. `Actuele10mindataKNMIstations` → v2), met fallback `1`.
- **data_overheid_themes** — gaf altijd 0 (de data.overheid.nl-CKAN heeft geen `groups`). Nu gevoed uit de canonieke, keyless Overheid.nl thema-taxonomie (`waardelijsten.dcat-ap-donl.nl/overheid_taxonomiebeleidsagenda.json`): 17 hoofd- + 93 subthema's, dagcache.
- **duo_schools / duo_exam_results** — gaven vrijwel altijd 0 doordat de plaatsnaam met de zoekterm werd ge-AND (CKAN-titels bevatten geen gemeentenaam). Nu topic-first zoektermen; de gebruikersterm blijft als soft hint. Deze tools leveren dataset-catalogustreffers (landelijke DUO-datasets), niet per-school-records.

De question-suite (`scripts/test-queries.json`) is opgeschoond (3 dode cases voor verwijderde rijksoverheid-tools weg) en uitgebreid met 23 cases zodat alle v0.2-bronnen + measurements gedekt zijn (69 cases; `requireEnv` op de key-tools). Niet-bugs die bewust ongemoeid bleven: DSO (werkt; discovery geeft vaak 0) en bro_ondergrond (werkt met een BRO-id, by-design).

### Gratis-key-bronnen geconfigureerd + twee latente bugs opgelost (juli 2026)

Nadat de gratis API-keys waren aangevraagd, zijn de vier key-tools live geverifieerd. EP-Online en NS werkten meteen; twee connectors bleken latente bugs te hebben die pas met een echte key zichtbaar werden:

- **ned_energie_search** — NED's `/v1/utilizations` vereist een `validfrom`-datumbereik; zonder gaf het HTTP 400. De connector voegde dat bereik alleen toe bij expliciete `validFrom`/`validTo`, dus elke standaardaanroep faalde. Nu wordt zonder opgave standaard de laatste 7 dagen (t/m morgen) gebruikt. Live: een kale aanroep geeft nu ~20 datapunten.
- **dnb_statistics_search** — de connector gebruikte `api.portal.dnb.nl` als base-URL, maar dat is de **developer-portal-website** (data-calls → 404 HTML → `malformed_response`). De echte **gateway is `api.dnb.nl`** (`GET https://api.dnb.nl/statisticsdata/<versie>/<dataset-slug>` met `Ocp-Apim-Subscription-Key`). Base-URL gecorrigeerd; live geverifieerd met een echt dataset-pad.

Key-product-vereisten (gedocumenteerd in `.env.example`, README en SOURCES.md):
- **NS**: abonneer op het **"Ns-App"**-product (bevat de Reisinformatie API, gratis externe tier ~300 req/5 min). Het "Public-Travel-Information"-product is verouderd en NS keurt daar geen nieuwe abonnementen meer op goed.
- **DNB**: abonneer op het **"Public"**-product en genereer de key op de productpagina (self-service, geen goedkeuring; 30 calls/min).


## Delivered in v0.3 (augustus 2026)

Vijf nieuwe connectors + twee dwarsdoorsnijdende capabilities (39 → 44 connectors; 64 → 70 tools). Elke bron is vóór het bouwen live geverifieerd (bestaan, gratis toegang, echte queryparameters) en na het bouwen end-to-end getest via `scripts/live-check-new.ts` en de question-suite.

**Nieuwe connectors (allemaal keyless):**
- `tenderned_aanbestedingen_search` + `tenderned_aanbesteding_get` — aanbestedingen/gunningen (TenderNed `papi`)
- `tuchtrecht_search` — tuchtrechtuitspraken (KOOP SRU, ~48k)
- `samenwerkende_catalogi_search` — productbeschrijvingen gemeenten/provincies/waterschappen (KOOP SRU, ~55k)
- `brp_gewaspercelen_search` — landbouwpercelen met gewas (PDOK WFS, RVO)
- `verkiezingsuitslagen_search` — Kiesraad-databank verkiezingsuitslagen

**Herbouwd:**
- `duo_schools` / `duo_exam_results` — waren catalogus-zoekopdrachten (leverden datasetbeschrijvingen i.p.v. scholen, terwijl de README per-school antwoorden beloofde). Nu op de CKAN **datastore**: echte per-vestiging records met server-side filters op gemeente/plaats/postcode en full-text op naam; examenresultaten met slagingspercentage en sortering.

**Nieuwe gedeelde capabilities:**
- `src/utils/pdf-text.ts` — PDF-tekstextractie (unpdf/pdf.js, `verbosity: 0` zodat pdf.js-waarschuwingen de stdio-JSON-RPC-stream niet vervuilen). Hiermee levert `tweede_kamer_document_get` eindelijk Kamerstuk-tekst i.p.v. `pdf_not_extracted_in_lean_mode`, en `tenderned_aanbesteding_get` de tekst van de officiële aankondiging. Typed failure-redenen (`no_text_layer`, `encrypted`, `not_a_pdf`, `too_large`, `corrupt`).
- `src/utils/geo.ts` — gedeelde geo-primitive (Locatieserver-resolutie, bbox-opbouw, RD-extentvalidatie). `bron_ongevallen` en `ruimtelijke_plannen` hadden hier elk hun eigen kopie van; `brp_gewaspercelen` gebruikt dezelfde.
- `src/utils/http.ts` — `getBinary()` (binaire responses via dezelfde retry/circuit-breaker/limiter-stack; binaire bodies worden nooit gecachet).
- `src/utils/sru-cql.ts` — vrije tekst → geldige CQL.

**Onderweg gevonden en meegefixt:**
- **KOOP SRU multi-word bug** — `officiele_bekendmakingen_search` gaf bij elke zoekopdracht van twee of meer woorden 0 resultaten: `... AND bestemmingsplan Rotterdam` is een CQL-syntaxfout, die het endpoint beantwoordt met een diagnostic zonder records (stil nul-resultaat). De tool-beschrijving adviseerde nota bene zelf zulke queries. Nu AND-combineert `utils/sru-cql.ts` de termen; phrase-quoting is géén alternatief (deze indexen hebben geen phrase-search).
- **Router routeerde tuchtrecht naar Rechtspraak** — "tuchtrecht" stond in `rechtspraakTerms`, terwijl rechtspraak.nl deze uitspraken niet bevat. De tuchtrecht-route staat nu vóór de Rechtspraak-route.
- **Meervoudsvormen in de routerintent** — de router matcht op woordgrenzen, dus "basisscholen" matchte `basisschool` niet; onderwijsvragen in het meervoud vielen door naar de generieke fallback.
- **Luchtmeetnet: circuit breaker sloot zijn eigen fallback buiten** — `/measurements`, `/lki` en `/stations` deelden één connectornaam. `/measurements` is met regelmaat 502 (precies waarom deze bron een LKI-fallback heeft), dus drie van die fouten openden de breaker voor de héle bron: de werkende LKI-fallback én de stationlijst lagen vijf minuten plat. Een by-design failover werd zo een harde storing, met als bijeffect een onterecht "geen meetstation gevonden" voor plaatsen die er wél een hebben. Nu drie aparte connectornamen (`luchtmeetnet`, `luchtmeetnet_lki`, `luchtmeetnet_stations`), en de stationlijst maakt onderscheid tussen "geen station" en "lijst onbereikbaar".
- **Luchtkwaliteit kon niet per plaats** — `luchtmeetnet_latest` kende alleen een componentfilter, dus "luchtkwaliteit in Utrecht" was onbeantwoordbaar (ook via de directe tool). Nu resolvet `plaats` naar de meetstations van die stad via `/stations`.
- **CBS gaf 0 bij vragen die het onderwerp wél kent** — de kandidatenketen probeerde alleen de hele (herschreven) zin; CBS-tabeltitels bevatten nooit een gemeentenaam en zelden een vraagwoord. Er staat nu een versmallende fallback achteraan de keten (gemeentenaam + telwoorden eruit, daarna het meest onderscheidende woord). Bestaande, werkende zoekopdrachten blijven ongewijzigd omdat de nieuwe kandidaten pas draaien als de bestaande niets opleveren.

### Bewust uitgesloten in v0.3

- **Woo-index / open.overheid.nl** — niet haalbaar gebleken, en dat is geverifieerd, niet aangenomen:
  - De KOOP SRU-collectie `plooi` bestaat niet meer: een `scan` op `c.product-area` (`operation=scan&scanClause=c.product-area=a`) geeft exact zeven product areas — `datacollecties` (66k), `lokalebekendmakingen` (6k), `officielepublicaties` (6,6M), `samenwerkendecatalogi` (55k), `sgd` (455k), `tuchtrecht` (48k), `vd` (23k). `plooi`, `woo` en varianten geven 0 records.
  - De enige machine-leesbare route is de API achter de zoekportaal-SPA (`https://open.overheid.nl/overheid/openbaarmakingen/api/v0/zoeken`, gevonden in de front-end bundle). Die geeft **HTTP 401** op elke aanroep — met en zonder browser-UA, met Referer/Origin, met sessie-cookie, en zowel GET als POST. De front-end bundle bevat geen sleutel, dus het is een IP-/omgevingsgebonden blokkade, geen ontbrekende credential.
  - Conclusie: pas oppakken als KOOP een gedocumenteerde publieke API of een SRU-product-area voor Woo-openbaarmakingen levert. Een connector bouwen op een endpoint dat we niet kunnen aanroepen zou een tool opleveren die alleen `http_error` teruggeeft.
- **Uitslagen per stembureau / voorkeurstemmen** — de Kiesraad-databank gaat tot gemeenteniveau; stembureau-EML's staan als bestanden op data.overheid.nl (geen query-API).
- **Recentere VO-examencijfers per vestiging** — de CKAN-portal van DUO bevat exact één per-vestiging examendataset (`03_voex-v1`, t/m schooljaar 2017); nieuwere examencijfers publiceert DUO alleen als losse CSV-downloads op duo.nl zonder stabiele, ontdekbare URL's.

### Volgende kandidaten (uit hetzelfde bronnenonderzoek)

1. Gemeentelijke open-dataportalen (Rotterdam ~1.400, Groningen ~540, Utrecht ~310, Den Haag ~250, Amsterdam ~140 datasets; Amsterdam heeft een eigen API)
2. Klimaatmonitor (RWS) — energieverbruik/CO₂ per gemeente
3. AHN / BGT / BRT via PDOK (staat sinds priority A in deze backlog, nog niet afgerond)
4. TED (EU-aanbestedingen) als Europese tegenhanger van TenderNed
5. Entity-resolutielaag: gemeentecode ↔ TOOI ↔ BAG ↔ kadastrale gemeente ↔ politie-regiocode
