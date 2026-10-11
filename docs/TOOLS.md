# Tool Catalog

## data.overheid.nl
- `data_overheid_datasets_search`
- `data_overheid_dataset_get`
- `data_overheid_organizations`
- `data_overheid_themes`

## CBS
- `cbs_tables_search`
  - probeert CBS OData (v4 en v3); valt terug op data.overheid.nl CKAN-catalog als beide 0 resultaten geven (CBS v4 doet literal substring match — multi-word queries falen vaak)
  - bij CKAN-fallback: expliciete `access_note` zodat duidelijk is dat de endpoint en index wijzigen (minder specifiek op CBS-tabellen); alleen datasets van de organisatie CBS tellen mee, niet die van andere organisaties met een CBS-woord in de titel
  - elk record linkt naar de eigen StatLine-pagina van de tabel (`opendata.cbs.nl/#/CBS/nl/dataset/<id>`), een CKAN-dataset naar zijn data.overheid.nl-pagina
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
  - zoekt in titel en onderwerp (metadata, niet de volledige tekst); alle zoekwoorden moeten voorkomen (AND)
  - woorden van maximaal 3 tekens en "quoted phrases" matchen als heel woord, langere woorden ook binnen langere woorden ('fietspad' vindt 'fietspaden'); `access_note` noemt de gezochte vormen
  - `query` is optioneel naast `type` of een datum; `date_from`/`date_to` (YYYY-MM-DD, Nederlandse datum)
  - records linken naar de documentpagina op tweedekamer.nl; `pagination.total` is het echte aantal treffers
- `tweede_kamer_search`
  - OData-zoektocht op elke entiteit van het Gegevensmagazijn (Document, Zaak, Activiteit, Besluit, Stemming, Persoon, Fractie, Kamerstukdossier, ...)
  - `query` (AND, zelfde woordregels) is optioneel naast `filter` (ruwe OData `$filter`) of een datum; `date_from`/`date_to` filteren op de eigen datum van de entiteit
  - een onbekende entiteit of een geweigerde expressie geeft een expliciete fout, nooit een ongefilterde fallback
- `tweede_kamer_document_get`
  - default: lean metadata + resource endpoints
  - optional: `resolve_resource` to expose resolved file metadata/URL
  - optional: `include_text` to fetch a capped preview for text-like resources
  - PDF resources: `include_text` extracts the PDF text layer (`text_preview_source: "pdf_text_layer"`, `resource_pages`); a scan without OCR reports `text_preview_unavailable_reason: "pdf_no_text_layer"`
  - Word (.docx) resources: `include_text` extracts the document text; other binary formats report `text_preview_unavailable_reason` instead of raw bytes
  - `nl_gov_ask` can auto-deepen the top match on explicit content/summary questions
- `tweede_kamer_votes`
  - één rij per fractie (of per Kamerlid bij een hoofdelijke stemming), gekoppeld aan het besluit (`uitslag`, bv. 'Aangenomen.') en aan de zaak waarover gestemd is (nummer, titel, onderwerp, tweedekamer.nl-link)
  - filters: `query` (titel/onderwerp van de zaak, zelfde woordregels), `zaak_nummer`, `zaak_id`, `besluit_id`, `date` of `date_from`/`date_to` (datum van de stemming); nieuwste stemmingen eerst
- `tweede_kamer_members`
- `tweede_kamer_debatten`
  - wat er in debatten is gezegd, plenair en in commissies: één record per spreekbeurt of interruptie met spreker, fractie of functie, begin- en eindtijd, debat en tekst (uit de verslagen in het Gegevensmagazijn)
  - filters: `query` (woorden in de tekst, alle verplicht, zelfde woordregels als `tweede_kamer_documents`, accentongevoelig), `spreker` (naam of functie: 'Klaver', 'minister', 'voorzitter'), `fractie` (de voorzitter telt nooit voor een fractie), `debat` (woorden in het onderwerp van het debat), `soort` (`plenair`/`commissie`), `date` of `date_from`/`date_to` (standaard de afgelopen 7 dagen)
  - geen volledige-tekstindex: per aanroep worden de verslagen van hoogstens 20 vergaderingen gelezen (nieuwste eerst); `vergadering_offset` gaat verder, `access_note` zegt hoeveel er zijn; `vergadering_id` leest één vergadering (een plenaire dag met al zijn debatten of één commissiedebat)
  - `max_chars` (standaard 1500) begrenst `data.tekst` per fragment; `snippet` is de passage rond de treffer
  - links: een commissiedebat naar zijn pagina op tweedekamer.nl, een plenaire dag naar zijn verslag daar, anders naar het verslag in het Gegevensmagazijn
  - een verslag verschijnt dezelfde dag, ongecorrigeerd; het gecorrigeerde volgt later en het officiële verslag zijn de Handelingen (`officiele_bekendmakingen_search`, type Handelingen)

## Officiële Bekendmakingen
- `officiele_bekendmakingen_search`
  - alle zoekwoorden moeten voorkomen (stopwoorden tellen niet mee); een "quoted phrase" en een citaat als '2016/679' matchen exact; bij een woord met koppelteken ('OV-visie') komen eerst de exacte treffers, daarna stukken met de losse woorden
  - `authority` normaliseert de uitgever: een voorvoegsel 'Gemeente '/'Provincie ' wordt `authority_type`, 'Den Haag' wordt gezocht als ''s-Gravenhage', een waterschap onder zijn volledige naam; oudere of variante spellingen van dezelfde uitgever ('Utrecht (Utr)', tot 2015) tellen als die uitgever, en `access_note` noemt de uitgevers als een pagina er meerdere mengt
  - `publicatieblad` filtert op het blad (Gemeenteblad, Staatscourant, Staatsblad, Provinciaal blad, Waterschapsblad, ...; ook `gmb`, `stcrt`, `stb`, ...); een bladnaam in `type` wordt als publicatieblad toegepast, met een melding
  - `sort` (`relevance`, `date_newest`, `date_oldest`) en `date_from`/`date_to` werken op `date_field` (`dagtekening` of `publicatiedatum`)
  - elk record heeft dagtekening, publicatiedatum, vindplaats en directe PDF/HTML/XML-links; alleen de eerste ~10.000 treffers zijn te pagineren
- `officiele_bekendmakingen_record_get`
  - één publicatie op identifier (bv. `stcrt-2026-10001`) of zoek.officielebekendmakingen.nl-URL: volledige metadata (dagtekening, publicatiedatum, blad en vindplaats, onderwerpen, juridische grondslag, dossier en indieners bij Kamerstukken) plus directe PDF/HTML/XML-links
  - `include_text` haalt de tekst op (uit de XML-versie, of uit de PDF bij oudere publicaties en bijlagen), begrensd door `max_chars`

## Rijksoverheid
- `rijksoverheid_search`
  - Zoekt nieuws/documenten via het Rijksoverheid.nl RSS-platform (`https://www.rijksoverheid.nl/api/rss`), met **server-side** keyword-zoek (`resultSearchTerm`)
  - `type`: `news` (default, alleen nieuwsberichten) of `all` (nieuws + documenten + overige pagina's); `date_from`/`date_to` (YYYY-MM-DD, of YYYY-MM / YYYY voor een hele maand of een heel jaar) filteren **server-side**, vóór de limiet van 20, op de datum die Rijksoverheid.nl zelf toont; een onleesbare datum wordt genegeerd met een melding in `access_note`
  - Maximaal 20 resultaten per query, zonder paginatie; is de feed vol, dan is het echte aantal onbekend en blijft `total` leeg
  - Records: `date` (de getoonde datum als Amsterdamse kalenderdag: bij nieuws de publicatiedatum, bij documenten de documentdatum of die van de laatste versie), `issued` (volledige tijdstempel), `url_date` (alleen documenten: de datum uit het URL-pad, waarop de pagina is aangemaakt) en `type` (uit het URL-pad: news, document, video, ...); een herschreven zoekterm staat in `access_note`
- `rijksoverheid_schoolholidays`
  - Schoolvakanties per schooljaar/regio via de nog actieve `opendata.rijksoverheid.nl`-dataset

> De oude `rijksoverheid_document`, `rijksoverheid_topics` en `rijksoverheid_ministries` zijn verwijderd: hun onderliggende `opendata.rijksoverheid.nl/v1`-endpoints zijn opgeheven na de platformmigratie (2 juni 2026).

## Algemene Rekenkamer en SCP
- `rekenkamer_publicaties_search` — publicaties van de Algemene Rekenkamer op www.rekenkamer.nl: onderzoeksrapporten, verantwoordingsonderzoek, aandachtspunten bij begrotingen, brieven aan de Kamer; archief tot in de jaren negentig
- `scp_publicaties_search` — publicaties van het Sociaal en Cultureel Planbureau op www.scp.nl: rapporten, kerncijfers, Burgerperspectieven, beleidssignalementen; archief vooral vanaf eind 2019, enkele oudere
- beide sites draaien op het CMS van Rijksoverheid.nl en beantwoorden dezelfde RSS-zoekvraag op hun eigen host (`/api/rss`, gefilterd op documentpagina's); rijksoverheid.nl indexeert ze niet. Eén bron in de code (`RijksoverheidSource.searchPublications`), per site een eigen connector (`rekenkamer`, `scp`)
- parameters (beide tools gelijk):
  - `query` (optioneel): trefwoorden, geen volledige vragen (bv. Rekenkamer 'asielprocedure', 'subsidies', 'verantwoordingsonderzoek'; SCP 'mantelzorg', 'eenzaamheid', 'participatiewet'). Leeg: de nieuwste publicaties eerst
  - `date_from` / `date_to` (optioneel, inclusief): YYYY-MM-DD, of YYYY-MM / YYYY voor de eerste of laatste dag van die maand of dat jaar (Amsterdamse kalenderdagen); filteren server-side, vóór de limiet van 20, op `date`. Een onleesbare waarde wordt genegeerd met een waarschuwing in `access_note`
  - `top` (standaard 20, max 200, maar de feed levert er hooguit 20), `offset`/`limit`, `outputFormat`, `verbose`, `dryRun`
- limieten van het platform: hooguit 20 resultaten per zoekopdracht, gerangschikt op relevantie, zonder paginering; zit de feed vol, dan is het echte aantal onbekend en blijft `total` leeg (`access_note` zegt het)
- records: `title`, `url` (de publicatiepagina met het volledige rapport of de PDF), `date` (de datum die de site toont, als Amsterdamse kalenderdag), `issued`, `snippet` (alleen de teaser, geen volledige tekst), `url_date` (de datum uit het URL-pad: wanneer de pagina is aangemaakt) en `type` (uit het URL-pad: document, video, file); geen fijner documenttype. Foutpagina's, de homepage en vacatures worden weggelaten (gemeld)

## Rijksbegroting
- `rijksbegroting_search`
- `rijksbegroting_chapter`

## DUO
- `duo_datasets_search` — dataset catalogue (CKAN `package_search`)
- `duo_schools` — **per-school records** (CKAN datastore), not catalogue hits
  - inputs: `name` (free text), `municipality`, `place`, `postcode` (exact, case-insensitive input), `sector` (`po`|`vo`|`mbo`|`ho`), `top`, pagination/outputFormat/verbose/dryRun
  - output: naam, instellingscode/vestigingscode, bevoegd gezag, onderwijstype, adres, postcode, plaats, gemeente(+code), provincie, denominatie, telefoon, website
- `duo_exam_results` — **per-location exam results** (CKAN datastore)
  - inputs: `year` (dataset covers 2013–2017; a year outside that range returns 0 records with an explanation in `access_note`), `school` (free text), `municipality`, `onderwijstype` (VMBO/HAVO/VWO), `sortByScore`, `top`, pagination/outputFormat/verbose/dryRun
  - output: school, BRIN(+vestiging), gemeente, provincie, onderwijstype, schooljaar, examenkandidaten, geslaagden, gezakten, slagingspercentage, gemiddelde cijfers (schoolexamen/centraal examen/cijferlijst)
  - coverage note is returned in `access_note`: DUO publishes this per-location set for school years 2013–2017 only
- `duo_rio_search`

## API register (key required)
- `overheid_api_register_search` (`OVERHEID_API_KEY`)

## KNMI (key required)
- `knmi_datasets` (`KNMI_API_KEY`)
- `knmi_search_datasets` (`KNMI_API_KEY`)
- `knmi_latest_files` (`KNMI_API_KEY`)
  - lists the newest files first (`orderBy=created`, `sorting=desc`; without them the API lists the oldest)
- `knmi_latest_observations` (`KNMI_API_KEY`)
  - reads `10-minute-in-situ-meteorological-observations` (v1.0): `Actuele10mindataKNMIstations` (v2) has had no new files since 2025-10-02
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
  - raadsdocumenten, agendapunten, vergaderingen en besluiten van gemeenten, provincies en waterschappen via ORI Elastic `_search`
  - standaard moeten alle woorden voorkomen (`match: "all"`), `match: "any"` vraagt minstens één; de query accepteert "phrases", OR/AND/NOT in hoofdletters, -term en prefix*
  - `gemeente` beperkt tot één orgaan, ook een provincie of waterschap (exact tegen de live indexlijst; een naam zonder ORI-index levert 0 records en zegt dat); `bestuurslaag` (`gemeente`, `provincie`, `waterschap`) is een filter
  - `date_from`/`date_to` filteren op de vergaderdatum; `sort: "date_newest"` sorteert op vergaderdatum en laat datums na vandaag weg tenzij `date_to` gezet is
  - documenten linken naar hun bestand; waar de ORI-link bekend kapot is, gaat de link naar het bronsysteem (`link_note`), elders is `data.original_url` (ook per bijlage) de uitwijk; agendapunten en vergaderingen linken naar hun ORI-record (`link_type`) met hun documenten onder `attachments`
  - `data.date_type` zegt wat de datum is (vergaderdatum, documentdatum, ...); totalen boven 10.000 zijn een ondergrens; `access_note` waarschuwt bij een verouderde index en meldt een herschreven zoekterm
  - faalt ORI, dan volgt een foutmelding en geen leeg resultaat
  - records tonen een korte passage; de volledige tekst van een document leest `ori_document_get` met `data.index` en `data.id`
- `ori_document_get`
  - de tekst van één ORI-document via `GET /<index>/_doc/<id>` (alleen de benodigde velden): ORI's eigen tekstextractie per pagina (`--- pagina N ---`), als Markdown (`md_text`) waar ORI die heeft, anders de platte paginatekst; plus de metadata (titel, organisatie, vergaderdatum, bestandslink, `original_url`)
  - `index` (verplicht): de ORI-indexnaam uit `data.index` van `ori_search`, bv. `ori_delft`, `ori_leidschendam-voorburg`, `osi_noord-holland`, `owi_limburg`; geen gemeentenaam. Patroon `ori_|osi_|owi_` + kleine letters/cijfers/`_`/`-`
  - `id` (verplicht): het record-id uit `data.id` (of een `attachments[].id` in dezelfde index), bv. `1731608`; letters, cijfers, `_` en `-`, max. 64 tekens
  - `zoekterm` (optioneel, max. 200 tekens): alleen de pagina's met de term (zoals geschreven, anders pagina's met al zijn woorden; hoofdletters en accenten tellen niet); `zoekterm_pages` noemt ze, `access_note` telt de treffers
  - `pagina` (optioneel): een pagina of bereik, `3` of `'3-5'` (van laag naar hoog); te combineren met `zoekterm`. Een ongeldig bereik (`'5-3'`, tekst) wordt bij de invoervalidatie geweigerd
  - `max_chars` (standaard 12000, min 1, max 50000): begrenst de tekst; `text_truncated` en `next_pagina` zeggen waar je verder leest
  - output (`data`): naast de zoekvelden `text_available`, `text`, `text_format`, `text_source`, `page_count`, `pages_returned`, `text_chars`, `text_total_chars`, `text_truncated`, `next_pagina`, `zoekterm_pages`/`zoekterm_hits`, `type_label`, `ori_record_url`
  - agendapunten en vergaderingen hebben geen eigen tekst (`text_unavailable_reason: "not_a_document"`); hun documenten staan in `attachment_ids`. Een document zonder geëxtraheerde tekst (scan, audio) zegt dat en linkt het bestand; een tekst boven de responslimiet van 12 MB geeft de metadata zonder tekst, gemeld
  - een onbekende index of een onbekend id is een leeg resultaat dat dat zegt (`summary` noemt welk van de twee); een storing van ORI is een fout met `suggestion`
  - de tekst is ORI's automatische extractie; het bestand op `url` is de bron

## NDW
- `ndw_search`
  - live discovery op NDW open pages/docs (opendata/docs/dexter)
  - output genormaliseerd met `id/title/description/updated_at/source/url`
  - fallbackrecord bij onbereikbaarheid/instabiliteit

## Luchtmeetnet
- `luchtmeetnet_latest`
  - authless latest measurements
  - `plaats`: plaats-/stadsnaam (bv. 'Utrecht', 'Den Haag'). Wordt via `/stations` naar de meetstations van die plaats geresolved en per station bevraagd. Een plaats zonder meetstation levert een expliciete uitleg in `access_note` - geen landelijke cijfers alsof ze over die plaats gaan.
  - `component`: NO2, PM10, PM25, O3, SO2, CO
  - verrijkte output: `location_name/component/value/unit/timestamp` + coordinaten
  - drie endpoints, drie connectors: `/measurements` (`luchtmeetnet`), `/lki` (`luchtmeetnet_lki`) en `/stations` (`luchtmeetnet_stations`). `/measurements` is met regelmaat 502; onder een gedeelde connectornaam sloten drie van die fouten de circuit breaker voor de hele bron, inclusief de werkende LKI-fallback en de stationlijst.
  - fallback-measurement met vaste timestamp/waarde als geen enkel endpoint bereikbaar is

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
  - DSO Presenteren API v8 voor omgevingsplannen, omgevingsvisies, programma's, omgevingsverordeningen, waterschapsverordeningen, voorbereidingsbesluiten (voorbeschermingsregels), projectbesluiten en de AMvB's van het Rijk onder de Omgevingswet
  - werkt op documentniveau: welke documenten op een punt gelden, niet welke artikelen (een artikel kan een kleiner werkingsgebied hebben; `access_note` zegt dat)
  - `locatie`: adres, postcode (met of zonder spatie, met of zonder huisnummer) of plaats ("Brennerbaan 150, Utrecht", "3524 BN 150", "Lunetten, Utrecht"), via de PDOK Locatieserver herleid tot één RD-punt (EPSG:28992) en gezocht met `POST /regelingen/_zoek` (geometrie + header `Content-Crs`). Geeft alle documenten waarvan het werkingsgebied dat punt bevat, op volgorde gemeente, waterschap, provincie, Rijk (binnen een laag nieuwste eerst); `access_note` noemt het gevonden adres, het soort treffer en de RD-coördinaten. Geocodering:
    - noemt de invoer aan het begin of eind een gemeente of woonplaats (ook onder een andere naam: "Den Haag" voor 's-Gravenhage, ook naast een postcode), dan tellen alleen treffers daar; staat het adres niet bij de eerste tien, dan vraagt de tool het opnieuw binnen die plaats. Ligt de treffer in een andere woonplaats van die gemeente, dan zegt `access_note` dat ("Ligt in de woonplaats De Meern (gemeente Utrecht)")
    - een woord dat de eerste treffers niet dekken kan een plaats zijn die er niet bij stond ("Utrecht Centraal Station"): dan zoekt de tool binnen die plaats, en niets gevonden is een fout, nooit een andere plaats
    - de rest van de invoer moet op de treffer lijken: meer dan de helft van de woorden (alleen letters, minstens 3, zonder vulwoorden) begint met dezelfde vier letters als een woord van de treffer ("Brenerbaan" vindt "Brennerbaan"); met een postcode tellen alleen treffers met die postcode. Een rangtelwoord voor de straat hoort bij de naam: "1e Hugo de Grootstraat 10" is de Eerste Hugo de Grootstraat, nooit de Tweede
    - met huisnummer: het adres zelf (met de gevraagde toevoeging), dan hetzelfde nummer met een andere toevoeging, dan het middelpunt van de straat (gemeld); een andere straat dan de genoemde ("Oude Kerkstraat 1" voor "Kerkstraat 1") alleen als de genoemde niets oplevert, en dan gemeld; een adres dat niet in de genoemde plaats ligt geeft een fout
    - zonder huisnummer iets wat in de genoemde plaats niet als adres bestaat ("Utrecht Centraal"), of alleen een plaatsnaam: het middelpunt van die plaats, gemeld (voor alle documenten van een gemeente: `bevoegdGezag`)
    - zonder plaats en met een even goede treffer in een andere gemeente ("Lunetten"): een fout die de opties noemt
  - `bevoegdGezag`: de instantie die het document vaststelde, alleen haar eigen documenten (geen gebied). TOOI-code in elke schrijfwijze (`gm0344` gemeente Utrecht, `pv26` provincie Utrecht, `ws0636` Hoogheemraadschap De Stichtse Rijnlanden, `mnre1034` BZK) of een naam. Namen worden opgezocht in de DSO-catalogus zelf (`aangeleverdDoorEen`), dus elke gevonden code bestaat in het DSO; hoofdletters, accenten en het laagwoord (gemeente, provincie, waterschap/hoogheemraadschap/wetterskip, ministerie) maken niet uit, en gangbare namen en afkortingen werken ook (Den Bosch, Den Haag, Friesland, HDSR, AGV/Waternet, HHNK, HHSK, WDOD, BZK, IenW, LNV, LVVN, EZK, VRO, KGG)
    - een naam die meerdere lagen delen: de laag uit de naam of uit `typeBevoegdGezag`; anders de laag die het `documentType` vaststelt (`omgevingsplan` gemeente, `omgevingsverordening` provincie, `waterschapsverordening` waterschap: "Utrecht" + `omgevingsverordening` = `pv26`); anders gemeente, dan provincie, dan waterschap, dan ministerie ("Utrecht" = `gm0344`, "Limburg" = `pv31`). `access_note` zegt hoe de naam is opgevat en noemt de alternatieven
    - een onbekende naam geeft een fout met de dichtstbijzijnde namen; een naam die binnen één laag op meerdere instanties past een fout met de opties. "Rijk" of "Rijksoverheid" is geen bevoegd gezag (het Rijk levert per ministerie aan): fout met `typeBevoegdGezag: "ministerie"` of één ministerie als alternatief
    - een provincie als `bevoegdGezag` geeft alleen de documenten van de provincie zelf; `access_note` wijst dan op `provincie`
    - bij een waterschap zegt `access_note` dat de keur met de Omgevingswet (1 januari 2024) is opgegaan in de waterschapsverordening
  - `provincie`: een gebied, de provincie (naam of `pv`-code: "Utrecht", "Fryslân", `pv26`) plus al haar gemeenten (gemeentecodes uit de PDOK Locatieserver), in één `_zoek` met al die codes als `bevoegdGezag`. Waterschappen en het Rijk vallen erbuiten; elk record houdt zijn eigen bevoegd gezag. Niet samen met `bevoegdGezag` of `locatie`
  - verzoeken: `_zoek` haalt per pagina 200 op. Een bevoegd-gezaglijst zonder filter is één verzoek (de nieuwste 200; `access_note` meldt het als er meer zijn, zoals de 350 van `mnre1034`). Met `query`, `documentType` of `alleen_ter_inzage`, en altijd bij `locatie` en `provincie`, worden tot 10 pagina's (2.000 documenten) opgehaald; is er meer, dan zegt `access_note` dat alleen de nieuwste 2.000 zijn doorzocht. Een naam (geen code) laadt eerst de catalogus
  - zonder `locatie`/`bevoegdGezag`/`provincie` doorzoeken `query`, `documentType`, `typeBevoegdGezag` en `alleen_ter_inzage` de volledige catalogus (alle pagina's van `GET /regelingen` of `/ontwerpregelingen`, size 200, enkele tegelijk, enkele uren in het geheugen); `total` is dan het aantal treffers in heel Nederland. Zonder enig filter: de `rows` regelingen met de meest recente nieuwe versie (ontwerpen: de laatst geregistreerde) met het totaal van het DSO
  - `query`: alle woorden (stopwoorden niet meegerekend) moeten als heel woord voorkomen (hoofdletters en accenten maken niet uit) in titel, citeertitel, opschrift, bevoegd gezag of type, bij een ontwerp ook in de citeertitel van het ontwerpbesluit (het project of de straat: "Overvliet"); zonder treffers ook als deel van een woord (gemeld)
  - `documentType` is exact: `omgevingsplan`, `omgevingsvisie`, `programma`, `omgevingsverordening`, `waterschapsverordening`, `voorbereidingsbesluit` (alle typen "Voorbeschermingsregels…"), `projectbesluit` (incl. omgevingsplanregels), `aanwijzingsbesluit_n2000`; `omgevingsplan` geeft dus geen voorbeschermingsregels. Met `locatie`, `provincie` of een gemeente als `bevoegdGezag` noemt `access_note` dan de voorbeschermingsregels die tijdelijk deel van het omgevingsplan zijn (titel, identificatie, sinds; ook die van het Rijk, nooit die van een omgevingsverordening)
  - `soort: "ontwerpregelingen"`: ontwerpen, één record per ontwerpbesluit (`technischId`), nieuwste `bekendOp` eerst, met:
    - `besluitTitel`, de citeertitel van het ontwerpbesluit; zegt die meer dan de titel van de regeling, dan staat hij ook in de titel ("Omgevingsplan gemeente Montfoort — Ontwerp wijziging Omgevingsplan gemeente Montfoort, Laan van Overvliet")
    - `bekendOp`, `beginInzagetermijn`, `eindeInzagetermijn` en `terInzage`: `true`/`false` als het DSO de inzagetermijn heeft (vandaag in `NL_GOV_TIMEZONE`, standaard Europe/Amsterdam, binnen de termijn, grensdagen inbegrepen); `null` als het DSO er geen heeft (`inzagetermijnBekend: false`, bij ongeveer een derde van de recente ontwerpen; de termijn staat dan alleen in de bekendmaking, `canonical_url`)
    - `mogelijkTerInzage`: zo'n ontwerp zonder inzagetermijn in het DSO dat in de laatste 56 dagen is bekendgemaakt (zes weken inzage die vaak enkele dagen na de bekendmaking begint), met `dagenSindsBekendmaking`. Elk ontwerp zonder inzagetermijn in het DSO heeft `eindeInzagetermijnSchatting` (bekendOp plus zes weken, een schatting); `inzagetermijnOpvallendKort` als de termijn in het DSO korter is dan vier weken (meestal een kennisgeving achteraf)
    - `bekendmakingId` en `bekendmakingUrl`: de publicatie van het ontwerpbesluit op officielebekendmakingen.nl ("gmb-2026-409335"; `officiele_bekendmakingen_record_get` neemt het id). Die is leidend voor de precieze termijn en voor hoe en bij wie je reageert; `access_note` zegt dat, en dat de kennisgeving vaak een aparte publicatie is. Noemt de titel van een ontwerp-omgevingsplan geen onderwerp ("Omgevingsplan gemeente Soest"), dan staat de titel van die publicatie in `onderwerp` en achter de titel ("Omgevingsplan gemeente Soest — Beukenlaan 17"); `null` als die niet te vinden was. Opgezocht voor hooguit 25 getoonde ontwerpen, samen binnen 8 s; wat dan niet binnen is, ontbreekt
    - het DSO bevat alleen ontwerpen die als ontwerpbesluit (STOP) zijn aangeleverd; een ontwerp dat alleen met een kennisgeving is bekendgemaakt, ontbreekt
  - `alleen_ter_inzage` (impliceert `ontwerpregelingen`): eerst de ontwerpen met `terInzage: true`, daarna die met `mogelijkTerInzage`; `access_note` en `summary` geven beide aantallen. Met `bevoegdGezag` alleen diens eigen ontwerpen, met `provincie` die van de provincie en haar gemeenten, zonder beide heel Nederland
  - `geldigOp` (YYYY-MM-DD): tijdreis voor regelingen, verstuurd als `geldigOp` én `inWerkingOp` (alleen `geldigOp` betekent bij het DSO "geldig op die dag en vandaag in werking" en laat elke sindsdien gewijzigde regeling weg); zonder `locatie`/`bevoegdGezag`/`provincie` wordt een catalogus voor die datum geladen. `access_note` zegt dat versies tussen die dag en vandaag niet te zien zijn. Geldt niet voor ontwerpen (gemeld)
  - `rows`: standaard 50 met `locatie` (een punt heeft meestal 20-40 documenten en het Rijk komt als laatste), anders 20; max 200. Valt er iets af, dan zegt `access_note` per bestuurslaag wat ("Niet getoond (rows 10): 3 van de 9 documenten van de provincie, 13 van de 13 documenten van het Rijk; verhoog rows naar 26 voor de volledige lijst.")
  - volgorde en datums: regelingen nieuwste eerst op `beginGeldigheid` van de huidige versie, dus een nieuwe versie van een oud plan telt als recent. `versie`, `beginGeldigheid` en `eindGeldigheid` horen bij die versie (met `geldigOp`: de versie van die dag). `eindGeldigheid` is exclusief: op die dag geldt de volgende versie, deze geldt tot en met `versieGeldigTotEnMet`, de dag ervoor (de snippet zegt het ook); het is niet het einde van de regeling. `versie` is het volgnummer van de registratie in het DSO, niet het versienummer op lokaleregelgeving.overheid.nl of wetten.overheid.nl
  - bij `locatie` telt `summary` alle gevonden documenten per bestuurslaag ("gemeente 3, waterschap 1, provincie 9, Rijk 13"), ook als `rows` er minder toont. `access_note` zegt verder dat omgevingsvisies en programma's alleen het bestuursorgaan binden dat ze vaststelde, en (zonder `documentType` of met `omgevingsplan`) dat bestemmingsplannen van vóór 2024 (IMRO) hier als tijdelijk deel van het omgevingsplan kunnen gelden maar niet in de lijst staan, met een bbox voor `ruimtelijke_plannen_search`
  - records: `canonical_url` is de leesbare tekst, soort in `documentUrlType`: `lokale_regelgeving` (identifier.overheid.nl → lokaleregelgeving.overheid.nl) voor gemeente, provincie en waterschap; `wetten_overheid` voor Rijksregelingen met een BWB-id (ook de Omgevingswet en de Omgevingsregeling); anders `regels_op_de_kaart`; voor een ontwerp `officiele_bekendmakingen` (de bekendmaking van het ontwerpbesluit). `data` bevat o.a. `identificatie`, `uriIdentificatie` en `versie` (ontwerp: `technischId`, `ontwerpbesluitIdentificatie`), `citeerTitel` (als die van de titel verschilt), `bevoegdGezagCode`, `documentType` en `viewerUrl`; de snippet van een ontwerp zegt of het ter inzage ligt
  - twee Rijksrecords staan op elke locatie maar zijn geen regelgevend document: de Omgevingswet (`alleenVerwijzing`: alleen een verwijzing naar wetten.overheid.nl; type AMvB en datum 2020-08-01 zijn registratiegegevens van het DSO) en het Aansluitdocument Rijk (`technisch`). Ze blijven in de lijst, met een `opmerking` en een titel die het zegt
  - fouten: een onbekende naam, een niet of niet eenduidig gevonden adres of een ongeldige combinatie geeft een fout met `suggestion`, geen lege lijst. Zonder API-sleutel, en als het DSO de sleutel weigert (HTTP 400 bij een ongeldig formaat, 401/403), een typed `not_configured` error met aanvraaglink; een sleutel met tekens die een HTTP-header niet toestaat wordt niet verstuurd en geeft ook `not_configured`, zonder de waarde. Een storing van de Locatieserver wordt als zodanig genoemd. Geeft het DSO binnen 45 s geen antwoord, dan een `timeout`-fout; de zoekvraag loopt door en vult de catalogus voor de volgende aanroep. PDOK Omgevingswet-tegels zijn geen alternatief (vector tiles bevatten geen documentmetadata)
- `dso_omgevingsdocument_tekst` (`DSO_API_KEY`)
  - de regeltekst van één document via `GET /regelingen/{uriIdentificatie}/documentstructuur` (ontwerp: `/ontwerpregelingen/{technischId}/documentstructuur`, met de componenten onder `ontwerpDocumentComponenten`); STOP-XML wordt platte tekst: koppen (Hoofdstuk/Afdeling/Paragraaf/Artikel met nummer en titel), leden als "1. …", genummerde en geneste lijsten, begrippen als "term: definitie", tabellen als regels met " | " (ook met samengevoegde cellen onder de juiste kolom). Het hele document: welke artikelen op een locatie gelden, zegt de tool niet
  - `identificatie` accepteert "/akn/nl/act/…" (ook met een versiedeel "/nld@…"), "_akn_nl_act_…", een identifier.overheid.nl- of DSO-API-URL, een ontwerp-`technischId` of een ontwerpbesluit "/akn/nl/bill/…"; in de `uriIdentificatie` worden `/` en `-` allebei `_`
  - een ontwerp leest als de regeling na de wijziging: renvooi verwerkt (toegevoegde tekst erin, geschrapte tekst en onderdelen eruit). `access_note` zegt dat het ontwerp nog niet geldt en wijst op `weergave: "wijzigingen"`
  - `weergave: "wijzigingen"` (alleen voor een ontwerp; bij een regeling een fout): alleen wat het ontwerp verandert, uit de renvooi in het DSO, per artikel, begrip of divisietekst in documentvolgorde. [+tekst+] is toegevoegd, [-tekst-] geschrapt, [nieuw] en [vervalt] staan voor een heel onderdeel, […] voor weggelaten ongewijzigde tekst; opeenvolgende onderdelen die alleen een ander nummer krijgen worden samen 'alleen vernummerd'. Elk record heeft `wijziging` (`nieuw`, `vervalt`, `gewijzigd`, `vernummerd`) en `summary` telt ze. Te combineren met `onderdeel` en `zoekterm`. Een ontwerp zonder renvooi (een nieuwe regeling) geeft de tekst zelf, gemeld
  - tijdelijke delen: voorbeschermingsregels (uit een voorbereidingsbesluit) zijn een tijdelijk deel van het omgevingsplan (`_links.tijdelijkDelen` van de regeling, hooguit 10 gelezen) en gaan voor waar hun voorrangsregel dat bepaalt. `access_note` noemt ze (titel, type, bevoegd gezag, sinds, identificatie). Met `zoekterm` worden ze meegezocht: hun treffers heten "Voorbeschermingsregels: <titel> — Artikel …", met `tijdelijkDeel: true` en `tijdelijkDeelVan`, en `summary` telt ze apart. Een tijdelijk deel dat het DSO niet levert staat in `access_note` en laat de aanroep niet mislukken. Een tijdelijk deel dat zelf wordt opgevraagd noemt de regeling waar het bij hoort
  - `zoekterm`: alleen de artikelen (met hun leden), begrippen, divisieteksten en toelichtingsdelen met alle woorden, elk met het pad van koppen; hoofdletter- en accentongevoelig, ook binnen langere woorden; een begrippenlijst wordt per begrip doorzocht
    - een meervoud van 7 of meer letters op -en of -s vindt ook de stam (dubbele eindmedeklinker enkel, minstens 5 letters over): "dakkapellen" vindt "dakkapel", "windturbines" "windturbine"; `access_note` meldt het. Een meervoud met klinkerwissel niet: voor "zonnepanelen" zoek "zonnepan". Geen synoniemen
    - volgorde: de regels, dan bijlagen, dan de toelichting, die van de tijdelijke delen telkens na die van het document zelf
    - geen treffer valt stil weg: eerst krijgt elke treffer zijn kop en de passage met de zoekterm (tot 400 tekens), in hooguit de helft van `max_tekens`; daarna in volgorde de volledige tekst waar die past, anders alleen de regels met de zoekterm en wat ze inleidt (`ingekort: true`, `tekensOnderdeel`). Hooguit 40 onderdelen per aanroep; wat niet past staat met eId in `access_note` (max 25), op te vragen met `onderdeel`
    - de zoekterm vindt alleen het woord: een regel die via een algemene term of een afwijking geldt ("In afwijking van artikel 9.3"), herhaalt het misschien niet; lees dan de afdeling van de belangrijkste treffer
  - toelichting: een deel uit de toelichting heet "Toelichting bij Artikel …" (of "Toelichting: …") en heeft `toelichting: true`: uitleg, geen regel; de bindende tekst is het artikel zelf. Bijlagen zijn bindend en worden niet zo gemarkeerd
  - `onderdeel`: één deel met alles eronder, op eId/wId (ook als regel uit de inhoudsopgave, "Hoofdstuk 4 Bouwen [chp_4]") of label: "Artikel 4.24", "art. 4.1", "hfdst. 4", "afd. 4.2", "par. 4.2.1" of "§ 4.2.1", "Bijlage II"; een lid als "artikel 4.1 lid 2", "artikel 4.1, lid 2", "artikel 4.1, tweede lid", "artikel 4.1 2e lid" of "lid 2 van artikel 4.1". Regels gaan voor toelichting en bijlagen; andere delen met hetzelfde label staan in `access_note`. Niet gevonden: een fout die de leden van het artikel noemt (of dat het geen genummerde leden heeft), anders de dichtstbijzijnde labels. Maximaal 300 tekens
  - zonder `zoekterm`/`onderdeel`: het hele document als het in `max_tekens` past (standaard 12000, max 40000), anders het begin plus een inhoudsopgave met eIds in hooguit de helft van de ruimte, zo fijn als past (artikelen, paragrafen, afdelingen, of hoofdstukken en bijlagen; bij een programma of omgevingsvisie de divisies), voor een vervolgvraag
  - `geldigOp` (YYYY-MM-DD): de versie die op die dag geldig én in werking was (`geldigOp` + `inWerkingOp`); niet voor ontwerpen (gemeld)
  - een omgevingsplan van enkele MB wordt één keer opgehaald en geparsed 15 minuten bewaard (hooguit vier documenten); de documentstructuur mag tot 32 MiB zijn (andere calls 12 MiB), met een timeout van 30 s
  - Omgevingswet: het DSO bevat alleen een verwijzing ("De tekst van de Omgevingswet vindt u hier"), geen wettekst; `summary` en `access_note` zeggen dat en linken naar wetten.overheid.nl. Hetzelfde geldt voor een Rijksregeling met een wetten.overheid.nl-tekst waarvan het DSO minder dan 1.000 tekens heeft. Het Aansluitdocument Rijk (`/akn/nl/act/mnre1034/2021/OOWATRXX1`) is een technisch record zonder regels; `summary` en `access_note` zeggen dat en noemen waar de regels van het Rijk staan
  - fouten: een onbekende identificatie, een document dat het DSO niet heeft (HTTP 404; met `geldigOp` ook: geen versie die op die dag geldig én in werking was), een lege documentstructuur of een documentstructuur boven 32 MiB geven een fout met `suggestion` (lees via `canonical_url` of Regels op de kaart), nooit "0 tekens". HTTP 400/401/403 van het DSO is `not_configured` (sleutel ongeldig, onbekend of niet geautoriseerd), net als een ontbrekende sleutel of een sleutel met tekens die een HTTP-header niet toestaat (niet verstuurd)

## Rechtspraak
- `rechtspraak_search_ecli`
  - gebruikt Rechtspraak zoekfeed en extraheert ECLI
  - fallback genereert deterministisch ECLI-resultaat met `access_note`
  - de tekst van een uitspraak: `rechtspraak_uitspraak_get` met de ECLI
- `rechtspraak_uitspraak_get`
  - één uitspraak of conclusie van de Advocaat-Generaal op ECLI uit de open data van Rechtspraak (`https://data.rechtspraak.nl/uitspraken/content?id=<ECLI>`, metadata en tekst in één XML-document): instantie, uitspraak- en publicatiedatum, zaaknummer, procedures, rechtsgebieden, zittingsplaats, relaties met andere aanleggen ('In cassatie op …', 'Conclusie: …, Gevolgd'), wetsverwijzingen, vindplaatsen, inhoudsindicatie, inhoudsopgave en tekst
  - `ecli` (verplicht, max. 300 tekens): bv. `ECLI:NL:HR:2019:2006`, in elke schrijfwijze; een uitspraken.rechtspraak.nl-link of een zin die op een ECLI eindigt werkt ook. Geen ECLI, of een niet-Nederlandse (`ECLI:NL:` ontbreekt), geeft een fout vóór elke request
  - `onderdeel` (standaard `overzicht`): `overzicht` (metadata, inhoudsindicatie, inhoudsopgave en de beslissing; bij een conclusie het slotadvies), `beslissing` (het dictum), `overwegingen` (de motivering), `volledig` (de hele tekst met voetnoten; lange uitspraken gaan over `max_chars`, gebruik dan `sectie` of `zoekterm`)
  - `sectie` (optioneel, max. 200 tekens, in plaats van `onderdeel`): een sectie uit de inhoudsopgave (`'4'`, `'#2'`, `'kop'`), een alineanummer (`'4.3'`, `'r.o. 4.3'`) of woorden uit een sectietitel (`'beoordeling'`). Niet gevonden: `access_note` noemt de bestaande secties
  - `zoekterm` (optioneel, max. 200 tekens): alleen de alinea's met alle woorden, hoofdletter- en accentongevoelig, met sectie en alineanummer (`treffers`, `treffers_totaal`); zoekt in het deel dat `onderdeel` of `sectie` kiest, bij `overzicht` in de hele tekst met voetnoten. Lange alinea's worden teruggebracht tot de passages met de term (`ingekort: true`)
  - `max_chars` (standaard 12000, min 500, max 50000)
  - output (`data`): `ecli`, `documenttype`, `instantie`, `uitspraakdatum`, `publicatiedatum`, `zaaknummer`, `procedures`, `rechtsgebieden`, `relaties`, `wetsverwijzingen`, `vindplaatsen`, `url` (uitspraken.rechtspraak.nl), `data_url` (het open-data-document), `deeplink`, `tekst_gepubliceerd`, `inhoudsindicatie`, `soort` (`uitspraak`/`conclusie`), `inhoudsopgave` (max. 60 secties, ingekort gemeld), `onderdeel`, `onderdeel_label`, `methode`, `tekst`, `tekens_getoond`, `tekens_onderdeel`, `ingekort`
  - `access_note` zegt hoe de beslissing of de overwegingen zijn gevonden (sectie met `role="beslissing"`, sectietitel, kopregel in de tekst of slotsom), of dat er geen is herkend, en wanneer tekst is afgekapt op `max_chars`; bij een conclusie dat het een advies is en geen uitspraak
  - een uitspraak met alleen metadata (geen gepubliceerde tekst) geeft `tekst_gepubliceerd: false` en zegt dat; een tuchtrechtuitspraak (alleen metadata bij Rechtspraak) linkt naar tuchtrecht.overheid.nl. Een ECLI die Rechtspraak niet kent (HTTP 404) is een leeg resultaat dat dat zegt; een storing is een fout
  - de tekst is zoals gepubliceerd (geanonimiseerd)

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
  - carries `_meta: { "anthropic/alwaysLoad": true }` (the only tool that does): a client that defers tools behind a tool search (Claude Code) loads it upfront. The server's MCP `instructions` point to it as the starting point when the right source is unclear, and to the source's own tools for detail or full text
  - `question` is 1 to 2000 characters; decodes percent-encoded questions before routing
  - prioritizes school holiday queries to `rijksoverheid_schoolholidays` with fallback attempts
  - improved CBS ranking for municipality/education phrasing
  - specific-source routes run **before** the broad CBS/Tweede Kamer ones: elections, procurement, disciplinary law, agricultural parcels and per-school education
  - read, not searched, right after the EUR-Lex and DSO checks: a ruling named by a Dutch ECLI (as `rechtspraak_uitspraak_get` with onderdeel `overzicht`; up to 5 ECLIs, each read; a failure is an explicit error, never a search with the ECLI taken apart) and an artikel of a named national law ("artikel 3:4 Awb", "Artikel 6:162 BW", "Welke artikelen van de Participatiewet gaan over …"; "op 1 januari 2015" or "in 2015" sets the peildatum) as `wetten_bwb_tekst`, which gives candidates for an ambiguous name and its answer without records for a missing artikel or version. Not for omgevingsplannen, verordeningen, the APV, EU acts or a question about rulings or Kamerstukken on an artikel; a name the BWB does not know goes on to the other routes, which say so, and a BWB failure is also listed in `failures`. An ECLI next to Kamervragen, moties or a debate is the Tweede Kamer route's topic (searched whole), not a ruling to read; a question about what cites a ruling reads the ruling and points to `lido_verwijzingen_lijst`
  - a question with only ECLIs of the EU or another country (none `ECLI:NL`) gets no Rechtspraak search, which would take the ECLI apart into words: the answer has no records and says where the ruling is (EUR-Lex link for `ECLI:EU`, the e-Justice ECLI search for other countries)
  - a question naming the Algemene Rekenkamer, the SCP or the WODC searches that body's publications (`rekenkamer_publicaties_search`, `scp_publicaties_search`, `wodc_search`) with the topic words; a bare "Rekenkamer" only without a local scope (not "Rekenkamer Rotterdam", the Zuidelijke Rekenkamer or a rekenkamer of a named place). These routes yield when the question also names another source: the Tweede Kamer or its papers, a tender, an API, the Algoritmeregister, datasets or files
  - "Hoeveel inwoners heeft <gemeente>?" (also "inwonertal", "inwoners <plaats>", "bevolking van <plaats> in <jaar>") answers the number from CBS table 03759ned (bevolking op 1 januari, per year; a name of two municipalities gives both). A municipality comes first; otherwise a provincie or Nederland is answered from the same table. A former (opgeheven) municipality is marked with its last year in the table, a year the table does not have is named, and a place that is none of these is said to be so. CBS records link to the table's own page, and a dataset of another organisation from the data.overheid.nl fallback is no CBS answer
  - a Kamerbrief question goes to the Tweede Kamer route (type 'Brief regering'); a Kamerbrief, Kamervragen or motie from, to or about a minister, staatssecretaris or the kabinet ("Brief van de staatssecretaris aan de Tweede Kamer over …") stays on that route alone, without the office holder as a search word; on a content question ("samenvatting", "wat staat er in") the council route also adds the text of the best ORI document (as `ori_document_get`, 4000 characters, within 6 s)
  - `dryRun` plans the first route the question takes, from the same route chain the handler follows (`src/router/routes.ts`): `estimated_sources` are the source(s) that route asks (side by side for the multi-source and policy routes). When that route finds nothing, the next route of the chain gets the question, down to the data.overheid.nl catalogue. The KNMI route plans its files request when `KNMI_API_KEY` is set and none without it, and without `OVERHEID_API_KEY` a multi-source plan leaves out the API register, as the execution does
  - Omgevingswet questions go to the DSO (`dso_omgevingsdocumenten_search`) when `DSO_API_KEY` is set, after the EUR-Lex check and before the other routes. Detection is precision-first: a question another route answered before the DSO route keeps that route. Without the key the question takes the routes it took before; `dryRun` shows the planned DSO request(s)
    - triggers: (1) a question that names a DSO document (omgevingsplan, omgevingsvisie, omgevingsverordening, waterschapsverordening, omgevingsprogramma, omgevingsdocument, voorbereidingsbesluit, voorbeschermingsregels, projectbesluit, ontwerpregeling, "regels op de kaart" or NOVI; any capitalisation) with an address, place, body, provincie or the Rijk, or that asks for a list of them ("Welke omgevingsplannen zijn er?"), the newest ("de nieuwste omgevingsdocumenten") or ontwerpen; (2) the rules at an address, with nothing else in the question but rule words ("Welke regels gelden op Brennerbaan 150, Utrecht?", "Which rules apply at …") or a permission and a building topic ("Mag ik een dakkapel plaatsen op Oudegracht 100, Utrecht?", "Hoe hoog mag ik bouwen op …"); "onder de Omgevingswet" may be part of it. The address is a street with a street ending ("-straat", "-baan", "Grote Markt", "Laan van …") and a house number, or a postcode; (3) the ontwerpen ter inzage of a named gemeente, provincie, waterschap or place, and nothing else ("Welke ontwerpen liggen ter inzage in Amersfoort?")
    - not routed to the DSO: an address without a street ending ("Damrak 1") unless the question names a document; a place with "regels" but no address or document ("Welke regels gelden (onder de Omgevingswet) in Utrecht?"); ontwerpen without a place or document word; a question longer than 500 characters
    - guards: a question that also uses another route's words keeps its old route, also next to a document word: the council, Staten, parliament or government (raad, gemeenteraad, college, B&W, wethouder, burgemeester, PS, GS, Kamer, minister, kabinet), opinions and advice (vindt, mening, standpunt, kritiek, advies, VNG, IPO, IPLO), other sources and their documents (bekendmakingen and the publicatiebladen, uitspraken, rechtspraak, Raad van State, bezwaar, beroep, handhaving, boetes, aanbestedingen, subsidies, CBS, statistics, datasets and open data, API's, Rijksoverheid, news and press releases, the APV, the EU, bestemmingsplannen, structuurvisies, beleidsregels, vergunningen (not vergunningvrij or vergunningplichtig), and other verordeningen, besluiten, plannen, visies and programma's than the DSO's), money (kosten, leges, budget, begroting, belasting, WOZ), procedures and participation (zienswijze, inspraak, participatie, aanvraag, melding, invoering, overgangsrecht), and the law or a concept instead of a document (wet, wetgeving, wettekst, Bal, Bbl, Bkl, AMvB, Omgevingsregeling, instructieregels, keur, legger, definitie, verschil, "wat is een", "wat houdt", "sinds wanneer", "in werking getreden", "how does", and "hoe" other than "hoe hoog/groot/diep/breed/ver"). A verb such as "zegt", "regelt" or "stelt" needs the document as its subject ("Wat zegt het omgevingsplan …", not "Wat zegt de VNG over het omgevingsplan")
    - mapping: an address becomes `locatie` with the place or postcode written behind it (", Utrecht", " te Haarlem", " in Utrecht", " (Utrecht)", " Utrecht"), else the place the question names elsewhere; a year such as 2050 is no house number, and "1e" or "Tweede" before a street is part of its name. "in (de) provincie X", or a provincie's own name ("in Noord-Holland"), becomes the area `provincie` when the question asks for ontwerpen, for documents of every kind, for a plural or for omgevingsplannen ("provincie Utrecht" with omgevingsplan too); "de omgevingsvisie van de provincie Utrecht" stays `bevoegdGezag`. A verordening "in <gemeente>" ("Welke waterschapsverordening geldt in Utrecht?") and a place after "op" ("Welke omgevingsplannen gelden er op Schiphol?") become the point `locatie`. Otherwise a named gemeente, provincie or waterschap ("gemeente Utrecht", "in Utrecht", "omgevingsplan Utrecht", "Utrecht omgevingsplan", "heeft Utrecht …", "omgevingsplan of Groningen", "province of Utrecht", also in a question typed in lowercase) becomes `bevoegdGezag`; "in Nederland" names none. "gemeenten", "provincies", "waterschappen" and "het Rijk", "nationale" or NOVI become `typeBevoegdGezag`; one kind of document becomes `documentType` ("waterschapsregels" is the waterschapsverordening, NOVI the omgevingsvisie); "ontwerp" or "ontwerpen" asks for ontwerpregelingen, and "ter inzage" or "inzagetermijn" also adds `alleen_ter_inzage`; one explicit day with "gelden/golden/geldig/van kracht/in werking" ("golden op 1 januari 2025") becomes `geldigOp` (not for ontwerpen). A period or a bare year is not applied, and `access_note` says so; a year in a title ("Omgevingsvisie Amsterdam 2050") is no period
    - a question about the omgevingsplan with an address, an area or a gemeente gets the search's note on the voorbeschermingsregels that are temporarily part of the plan (`documentType` `omgevingsplan` leaves them out of the list)
    - an address asks the DSO for at least 50 records; the first page (`top`, default 10) holds one document of every bestuurslaag and `access_note` counts them per layer ("gemeente 3, waterschap 1, provincie 9, Rijk 13")
    - the route waits at most 20 s for the DSO; the search then runs on in the background and fills the catalogue cache for the next question
    - a question that named an address, place, body or area, or asked for ontwerpen, gets the DSO's answer even when it is empty, with an `access_note` that explains (for ontwerpen: not every inzagetermijn is in the DSO; the kennisgeving is in `officiele_bekendmakingen_search`). Only a question without such a scope (a document type or a layer over the whole country) that finds nothing falls through
    - when the DSO fails, gives no answer within 20 s, or does not know the name or address, the other routes answer and `access_note` says "DSO Omgevingsdocumenten eerst geprobeerd (<parameters>): <reason>" (a failure of the PDOK Locatieserver is named as such); a failure or timeout is also listed in `failures`
    - topic words ("over dakkapellen") are not searched in the DSO, which searches titles and metadata: `access_note` points to `dso_omgevingsdocument_tekst` with `zoekterm`
  - what was said in a Tweede Kamer debate goes to `tweede_kamer_debatten` (see `detectDebatIntent`): a question that names a debate and asks what was said ("Wat zei de VVD in het debat over stikstof?", "Wat werd er gezegd in het stikstofdebat?"), or asks what someone said in the Kamer, with a topic ("over …"), a debate, a fractie or a speaker; the period of the question applies, else the last 7 days
    - never for another body (gemeenteraad, Staten, Eerste Kamer), the agenda ("wanneer"), votes, moties or amendementen
    - when the verslagen give nothing or the search fails, the other routes answer and `access_note` says that the debates were searched first
  - the algorithms a government body uses go to the Algoritmeregister (see `detectAlgoritmeIntent`): a question that names algorithms or AI systems with an organisation ("de gemeente Amsterdam", "het UWV", "het Ministerie van Financiën"), a topic ("voor fraudedetectie") or high-risk AI; never a question about documents on algorithms (council papers, Kamerstukken, reports) or the law on them. With no result, the other routes answer and `access_note` says so
  - EU legislation runs before everything else: a CELEX number or EU citation (detected on the raw question, since the query rewriter strips `/`) goes to `eurlex_document` (or `eurlex_nl_omzetting` for a directive plus "omzetting"/"omgezet"); explicit terms like "EU-richtlijn", "europese verordening", "EUR-Lex" go to `eurlex_search`. A bare "verordening 2024/12" without an EU/EG marker is not treated as EU
  - extracts a place name from the question ("in Tilburg", "gemeente Land van Cuijk") to drive gemeente-scoped sources; falls back with an explanatory `access_note` when the name does not resolve
  - education questions prefer real per-school records (`duo_schools` / `duo_exam_results`) and fall back to the DUO dataset catalogue only when those return nothing
  - weather questions go to the KNMI route when `KNMI_API_KEY` is set: the newest files of the station observations (`10-minute-in-situ-meteorological-observations`), the warnings or the earthquakes dataset, as `knmi_latest_observations`, `knmi_warnings` and `knmi_earthquakes` (file names and times, not read-out values). Without the key it returns `not_configured`
  - air-quality questions route to Luchtmeetnet for the place named in the question; only unambiguous terms trigger it, so bare "stikstof" keeps routing to Tweede Kamer / CBS
  - CBS questions that find nothing with the full sentence retry with progressively narrower topic terms (municipality and quantity words removed - CBS table titles carry neither)
  - organisation and policy questions ("Wat doet de Belastingdienst met de BTW?", "GGZ-beleid gemeente Utrecht") are searched in documents: the council records (ORI) of a named municipality, otherwise official publications, Tweede Kamer and Rijksoverheid in parallel; a source that does not answer within 10 s is left out and named in `access_note`
  - guards: case-law, API-register and budget questions keep their own routes; "uitspraken" means court rulings only when no office holder is its speaker ("uitspraken van de minister" are statements); when a national actor comes before "gemeente X", the national sources answer instead of that council's records
  - each route searches the topic keywords of the question, without question frames and route words (such as "moties" for Tweede Kamer, which becomes a document-type filter); the terms used are reported in `access_note`. Time phrases without a date filter ("deze week", "onlangs") are left out of the terms, and `access_note` says no date filter was applied
  - the Officiële Bekendmakingen route turns a journal named in the question (Staatscourant, Gemeenteblad, Provinciaal blad, `stcrt`, `gmb`, ...) into the `publicatieblad` filter instead of a required search word; a question with a journal and no topic gets that journal's newest publications
  - the EUR-Lex search route passes a document number ("2016/679") on whole, so `eurlex_search` looks it up as that act
  - when no route answers, the data.overheid.nl catalogue fallback names the routes that were tried and whether they found nothing or failed

## Known limits / behavior notes
- KNMI `knmi_warnings` (`waarschuwingen_nederland_48h`) and `knmi_earthquakes` (`aardbevingen_nederland`) try multiple dataset candidates; only a 404 moves on to the next one. Any other failure (e.g. a 429 rate limit), or no candidate that exists, is reported as an error, never as 0 results.
- DUO `duo_schools` and `duo_exam_results` return per-school rows from the CKAN datastore; the exam dataset covers school years 2013–2017 (stated in `access_note`).
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

Search consolidated Dutch national legislation (BWB) via the KOOP SRU service. Keywords match the title index `overheidbwb.titel` (title search, not full text). Full-pattern tool: supports `offset`/`limit`/`top`, `outputFormat`, `verbose` and `dryRun`.

- **Inputs**: `query` (verplicht, max. 500 tekens, titelwoorden, bv. 'arbeid vreemdelingen', 'wegenverkeerswet', 'omgevingswet'; geen volledige zinnen), `peildatum` (optioneel, YYYY-MM-DD: de versies die op die dag gelden in plaats van vandaag, Nederlandse datum; vindt ook regelingen die sindsdien zijn ingetrokken), `top`, `offset`/`limit`, `outputFormat`, `verbose`, `dryRun`.
- **Eén record per regeling**: de versie (toestand) die vandaag of op `peildatum` geldt (de CQL krijgt `overheidbwb.geldigheidsdatum=<dag>`); gelden twee versies op dezelfde dag, dan de latere. De SRU rangschikt niet; de regeling waarvan de titel precies de zoekterm is, komt vooraan. Een regeling zonder versie die op die dag geldt (ingetrokken, of nog niet in werking) staat er niet bij. Is de zoekterm precies de titel van zo'n regeling ('Wet openbaarheid van bestuur' vandaag), dan noemt `access_note` haar met de hint om een `peildatum` binnen haar looptijd te geven; vindt de zoekterm vandaag niets maar op andere data wel, dan noemt `access_note` voorbeelden met hun periode.
- **Output**: `identifier` (BWBR-id), `title`, `type` (wet, AMvB, ministeriële regeling, ...), `authority`, `creator`, `geldig_vanaf`/`geldig_tot` (de geldigheidsperiode van deze versie; geen `geldig_tot`: geen einddatum bekend), `toestand`, `versie_url` (wetten.overheid.nl/{BWBR}/{geldig_vanaf}), `xml_url` (de XML van deze versie in de KOOP-repository), `metadata_gewijzigd` (laatste wijziging van het BWB-metadatarecord, niet van de wet of de tekst; `data.date` blijft als alias met dezelfde waarde), `rechtsgebied`, `peildatum` en `canonical_url` (zonder `peildatum` de kale wetten.overheid.nl/{BWBR}-link, die de versie van vandaag opent; met `peildatum` de `versie_url`). De record-`date` is `geldig_vanaf`.
- De tekst van een regeling of artikel: `wetten_bwb_tekst`.

## wetten_bwb_tekst

De tekst van een Nederlandse wet of regeling (BWB, wetten.overheid.nl) zoals die op een dag gold: één artikel (of lid), de artikelen met een zoekterm, of de inhoudsopgave met het begin van de tekst.

- **Inputs**:
  - `bwb_id` (max. 20 tekens): bv. `BWBR0005537` (Awb), `BWBR0037885` (Omgevingswet), `BWBR0005289` (BW Boek 6). Geef dit of `wet`
  - `wet` (max. 200 tekens): titel of officiële afkorting, bv. 'Awb', 'Algemene wet bestuursrecht', 'Sr', 'Gemeentewet', 'Woo', 'BW boek 6', of 'BW' met een artikel als '6:162'. Opgezocht via de afkortings- en titelindex van de BWB-SRU op de peildatum; een afkorting die meerdere regelingen delen ('Ow') of een term die alleen titelwoorden raakt, geeft kandidaten (met `bwb_id`, type, autoriteit, geldigheidsperiode en `versie_url`) in plaats van tekst, nooit een gok, ook niet bij één kandidaat op titelwoorden. Een titel of afkorting die op de peildatum niets aanwijst maar op andere data precies één regeling (de Wob, de Wro), wijst die regeling aan; geldt ze op de peildatum niet, dan volgt een fout met de periode waarin ze wel gold
  - `artikel` (max. 100 tekens): '3:4', 'art. 3:4', 'Artikel 2.1', '162', optioneel met lid ('3:4 lid 2') en onderdeel ('6:162 lid 2 sub b', 'onder b'; niet gevonden: het hele lid of artikel, gemeld). In een boek van het BW werkt ook boek:artikel ('6:162'). Hoofdletters en spaties tellen niet, leestekens wel: '3.4' matcht nooit '3:4' (de fout noemt het bestaande artikel)
  - `peildatum` (YYYY-MM-DD, standaard vandaag, Nederlandse datum): de versie die op die dag geldt. Een peildatum in de toekomst geeft een versie met alleen de wijzigingen die nu al vastgesteld zijn (gemeld)
  - `zoekterm` (max. 200 tekens): alle woorden moeten in het artikel (met kop) voorkomen, hoofdletter- en accentongevoelig, ook binnen langere woorden. Genegeerd als `artikel` gegeven is
  - `max_chars` (standaard 12000, min 500, max 50000)
- **Zonder `artikel` of `zoekterm`**: de hele tekst als die in `max_chars` past, anders de inhoudsopgave (zo veel kopniveaus als passen, gemeld) en het begin van de tekst.
- **Per artikel**: `artikel`, `titel`, `pad` (hoofdstuk › afdeling › ...), `in_bijlage`, `status` (`geldend`, `vervallen`, `nog niet in werking`), `in_werking_sinds`, `gewijzigd_bij` + `gewijzigd_bij_url` (de publicatie die het laatst wijzigde), `url` (deeplink op wetten.overheid.nl, met `&g=<peildatum>` als dat niet vandaag is), `tekst`, en bij afkappen `ingekort` + `tekens_volledig`. Elk record heeft ook `bwb_id`, `regeling`, `type`, `peildatum`, `versie_geldig_vanaf`, `versie_geldig_tot`, `versie_url` en `xml_url`; een record van de hele regeling daarnaast `authority`, `artikelen`, `artikelen_vervallen`, `inhoudsopgave`, `tekens_regeling` en `afgekapt`.
- **`access_note`** noemt altijd de versie (geldig van/tot), hoe een `wet` is opgevat, een vervallen of nog niet geldend artikel (met de peildatum voor de oude tekst), elk artikel dat meer dan eens voorkomt (ook in een bijlage), elke afkapping en wat niet getoond is met hoe je het opvraagt, en de bron: de geconsolideerde tekst uit de BWB-repository van KOOP; alleen de publicatie in Staatsblad of Staatscourant is authentiek.
- **Niet gevonden**: een onbekende wet of onbekend id, een regeling zonder geldige versie op de peildatum (met de periodes waarin ze wel gold) en een ontbrekend artikel of lid (met de bestaande artikelen) geven succes met 0 records: `access_note` zegt waarom, met suggesties, en `provenance.query_params.niet_gevonden` is `wet`, `bwb_id`, `versie` of `artikel`.
- **Fouten**: ongeldige invoer (bv. een ongeldig id) en een geweigerde zoekvraag blijven expliciete fouten met `suggestion`. Een storing is een typed fout (`http_error`, `malformed_response`, ...); een download die geen BWB-toestand is (een HTML-onderhoudspagina, een lege of afgebroken XML) wordt geweigerd en nooit bewaard.
- **Bron**: de SRU zoekt de versie (`x-connection=BWB`); de tekst komt uit de XML van die versie (`repository.officiele-overheidspublicaties.nl/bwb/...`, tot 25 MiB, timeout 60 s). Een geparste versie blijft 24 uur bewaard (hooguit vier).

## cvdr_search

Search Dutch decentralised/local regulations (CVDR) via the KOOP SRU service. All query words must occur (AND) in a regulation's title or text; uppercase `OR` and `NOT` between words are operators (AND binds tighter than OR). A place name in the query also finds other authorities' regulations that mention it, so restrict to the issuer with `organization` (whole words of the issuer name, case-insensitive; a leading 'Gemeente'/'Provincie' becomes `organization_type`; 'Den Haag' and 'Den Bosch' also match their official names) and/or `organization_type` (`Gemeente`, `Provincie`, `Waterschap`, ...). `query` may be empty when one of these is set. `offset`/`limit` page server-side through the whole result set and `total` is the real hit count. Returns CVDR id, title, `organization` and `organization_type` (the older `gemeente` field holds the same issuer), date and a lokaleregelgeving.overheid.nl link. A query CVDR refuses returns an error with the SRU diagnostic instead of an empty result.

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

Zoek in het Register van Overheidsorganisaties (ROO/TOOI) op naam of afkorting.

**Parameters:** `query` (deel van de naam of een afkorting; leeg = bladeren door het hele register, te combineren met `type`), `type` (optionele TOOI type-URI, bv. `https://identifier.overheid.nl/tooi/def/ont/Gemeente`), `enrich` (default true; verrijk de eerste 15 treffers van de getoonde pagina met contact/adres), `active_only` (alleen organisaties zonder einddatum; faalt liever dan ongefilterd te antwoorden als TOOI onbereikbaar is), plus standaard `top`, `offset`, `limit`, `outputFormat`, `verbose`, `dryRun`.

**Matching:** ongevoelig voor hoofdletters, accenten, apostroffen en koppeltekens; vindt ook registerafkortingen (UWV, RIVM, in elke schrijfwijze), officiële namen (''s-Gravenhage' voor Den Haag) en een paar generieke aliassen (GGD = gezondheidsdienst). Namen die de zoekterm zelf bevatten staan vóór treffers op alleen een alias. Opgeheven organisaties staan ook in het register en zijn gemarkeerd (`einddatum`/`opgeheven`).

**Levert per organisatie:** `title` (label), `organisatietype` (afgeleid uit type-URI), `tooi_uri` / `type_uri`, afkorting, `website`, `telefoon`, `bezoekadres`. De canonieke URL is de website (https), of de registerpagina van de organisatie als er geen website is, de verrijking is overgeslagen of de organisatie is opgeheven.

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


## Nieuwe tools (v0.3)

## `tenderned_aanbestedingen_search`

Zoekt aanbestedingspublicaties op TenderNed (aankondigingen, gunningen, marktconsultaties, vroegtijdige beëindigingen).

- **Inputs**: `query` (vrije tekst over naam/beschrijving/opdrachtgever), `opdrachtgever` (aanbestedende dienst, server-side via het TenderNed-register; alle diensten met die woorden in hun naam tellen mee, `access_note` noemt ze, een te brede naam zoals alleen 'Gemeente' wordt geweigerd), `typeOpdracht` (`leveringen`|`diensten`|`werken`|`all`), `procedure` (code, bv. `OPE`), `date_from`/`date_to` (JJJJ-MM-DD, publicatiedatum), `sort` (`relevance` of `date_newest`; standaard relevance met een query, anders nieuwste eerst), `page` (0-based), `top` (max 100), pagination/outputFormat/verbose/dryRun.
- **Zoeksyntax**: TenderNed combineert meerdere woorden met OR; zet de héle query tussen dubbele aanhalingstekens voor een exacte frase (één frase per query). AND/OR/NOT, + en - zijn geen operators.
- **Output**: publicatie_id, opdrachtgever, publicatie-/sluitingsdatum, type publicatie (+code), procedure, type opdracht, europees, kenmerk, beschrijving; canonical url is de TenderNed-aankondigingspagina.
- **Sluitingsdatum**: de zoekindex houdt de deadline van de oorspronkelijke aankondiging, ook na een rectificatie. Voor aankondigingen met een deadline in de toekomst of hooguit 180 dagen oud (max. 50 per aanroep, binnen ongeveer 3 seconden, eerder gestopt als de detailrecords traag of niet antwoorden) leest de tool het detailrecord: `sluitings_datum_gecontroleerd: true` en `sluitings_datum_oorspronkelijk` als die afweek; andere sluitingsdata komen ongecontroleerd uit de index.
- **Marktconsultaties (MAC)**: binnen dezelfde limieten leest de tool ook de aankondiging zelf (HTML-weergave, van de laatste rectificatie als die er is), ook voor recente consultaties zonder sluitingsdatum in de index. De termijn uit de aankondiging ('Termijn ontvangst antwoorden') wordt `sluitings_datum` (`sluitings_datum_bron: "aankondiging"`), TenderNed's veld `sluitingsDatumMarktconsultatie` gaat naar `sluitings_datum_oorspronkelijk` als het afwijkt en `sluitings_datum_opmerking` legt het verschil uit. `sluitings_datum_gecontroleerd` is alleen `true` als de aankondiging de datum bevestigt; een ongecontroleerde consultatie krijgt een opmerking dat TenderNed's veld vaak later ligt.
- **Let op**: TenderNed levert maximaal 100 publicaties per aanroep en alleen de eerste 10.000 resultaten van een query; `offset`/`page` worden daarnaar vertaald. Een ongeldig datumformaat wordt genegeerd en gemeld in `access_note` in plaats van stil mis te filteren.

## `tenderned_aanbesteding_get`

Detail van één publicatie op `publicatieId` (of `publicatie_id` uit de zoektool).

- **Inputs**: `publicatieId`/`publicatie_id`, `include_award` (default true), `include_text` (tekstlaag van de officiële aankondigings-PDF), `max_chars`.
- **Output**: dezelfde snake_case-velden als de zoektool (`publicatie_datum`, `sluitings_datum`, `type_publicatie`, ...) naast de oorspronkelijke camelCase-velden, plus CPV-codes, NUTS-codes, juridisch kader, opdrachtaard, aanbestedingsstatus, aanvang/voltooiing opdracht, `isGegund`, gerelateerde publicaties van dezelfde procedure en `pdfUrl`. De sluitingsdatum is de actuele deadline na een eventuele rectificatie (`sluitings_datum_bron` noemt het veld). Bij een marktconsultatie (MAC) is het de termijn uit de aankondiging zelf ('Termijn ontvangst antwoorden', met tijd en UTC-offset), gelezen uit de HTML-weergave, anders de PDF-tekst, van de laatste rectificatie als die er is (`sluitings_datum_bron: "aankondiging"`); TenderNed's eigen veld staat dan in `sluitings_datum_oorspronkelijk`, `sluitings_datum_opmerking` noemt beide en `sluitings_datum_gecontroleerd` is alleen `true` als de aankondiging de datum bevestigt. Kan de rectificatie niet worden gelezen en spreken de oorspronkelijke aankondiging en het veld elkaar tegen, dan is `sluitings_datum` de vroegste van de twee. Met `include_text`: `pdf_text`, `pdf_text_chars`, `pdf_text_truncated`, `pdf_pages` — of `pdf_text_unavailable_reason` met een typed reden.
- **Gunning** (`include_award`, één extra request naar de HTML-weergave): geraamde waarde (`geraamdeWaarde`) en bij gunningen de winnaar(s), gegunde waarden en contractdata in `gunning`. `gunning.totaleWaarde` is de waarde van alle gegunde opdrachten, `winnaars[].waarde` die van één winnaar; bij een raamovereenkomst is `raamovereenkomstMaximum` een plafond, geen gegund bedrag. Bedragen onder € 1.000 (bv. '1 Euro') en sluitingsdata in 2090 of later worden als placeholder gemarkeerd.

## `tuchtrecht_search`

Tuchtrechtuitspraken (gezondheidszorg, advocatuur, notariaat, accountants, diergeneeskunde, gerechtsdeurwaarders) via KOOP SRU.

- **Inputs**: `query` (trefwoorden, meerdere woorden worden AND-gecombineerd), `college` (exacte naam), `date_from`/`date_to` (ISO), `top`, pagination/outputFormat/verbose/dryRun.
- **Output**: ECLI, college, domein, plaats, zaaknummer, beslissing, uitspraakdatum, onderwerp, samenvatting, `tuchtrecht.overheid.nl`-link en `pdf_url`.
- **Waarom apart van Rechtspraak**: rechtspraak.nl bevat deze uitspraken niet. `nl_gov_ask` routeert tuchtrechtvragen daarom vóór de Rechtspraak-route.

## `samenwerkende_catalogi_search`

Productbeschrijvingen (dienstverlening) van gemeenten, provincies en waterschappen via KOOP SRU.

- **Inputs**: `query`, `organisatie` (exacte naam), `date_from`/`date_to`, `top`, pagination/outputFormat/verbose/dryRun.
- **Output**: titel, organisatie(+type), gebied, informatietype, doelgroep, samenvatting, gewijzigd-datum.

## `brp_gewaspercelen_search`

Landbouwpercelen met gewas uit de RVO Basisregistratie Gewaspercelen (PDOK WFS).

- **Inputs**: `gemeente` (wordt via de PDOK Locatieserver naar een bbox omgezet, ±8 km) of `bbox` (EPSG:28992), `gewas` (substring), `categorie` (`bouwland`|`grasland`|`natuurterrein`|`landschapselement`|`braakland`|`all`), `jaar`, `includeGeometry`, `top`, pagination/outputFormat/verbose/dryRun.
- **Output**: gewas, gewascode, categorie, jaar, status, oppervlakte (m²/ha), centroid, bbox en optioneel de GeoJSON-polygon (`outputFormat: "geojson"` werkt met `includeGeometry: true`).
- **Let op**: gewas/categorie/jaar filteren client-side (de MapServer-WFS negeert `cql_filter`); percelen liggen buiten de bebouwde kom, dus een stadscentrum-bbox levert legitiem 0 resultaten.

## `verkiezingsuitslagen_search`

Verkiezingsuitslagen per partij uit de Kiesraad-databank.

- **Inputs**: `verkiezing` (code `TK20251029`, soort `TK`/`gemeenteraad`/`Europees Parlement`, of leeg = meest recente), `gebied` (gemeente of provincie; leeg = landelijk), `list_elections` (lijst beschikbare verkiezingen), `top`, pagination/outputFormat/verbose/dryRun.
- **Output**: één record per partij met stemmen, percentage en zetels, plus gebiedscontext (kiesgerechtigden, opkomst, geldige/blanco/ongeldige stemmen) in elk record en in `access_note`.
- **Gedrag**: een onbekend gebied levert de landelijke uitslag mét uitleg in `access_note`; een onbekende verkiezingsnaam levert de lijst met beschikbare verkiezingen in plaats van een lege respons.

## `eurlex_search`

EU-wetgeving zoeken via EUR-Lex/CELLAR (SPARQL, geen key).

- **Inputs**: `query` (trefwoorden, alleen in titels gezocht, of een documentnummer), `type` (`REG`|`DIR`|`DEC`, optioneel), `top`, pagination/outputFormat/verbose/dryRun.
- **Output**: `celex`, `title` (NL, anders EN) + `title_language`, `document_type` + `document_type_label`, `date`, `in_force`, `eli`, `eurlex_url`, `cellar_url`, `match` (`title`, `title_partial` of `document_number`).
- **Woorden**: maximaal zes woorden van minstens twee tekens, met AND ('5G' werkt; stopwoorden en 'EU'/'EG'/'nr' tellen niet mee). Vindt de AND met tweeletterwoorden minder dan `top` handelingen, dan volgen titels met de overige woorden als `title_partial`.
- **Documentnummer**: een query die alleen een nummer is ('2016/679', 'Verordening (EU) 2016/679', 'Richtlijn 95/46/EG') geeft eerst die handeling, daarna handelingen waarvan de titel precies dat nummer noemt. Verordeningen van vóór 2015 lezen nummer/jaar ('Verordening (EG) 1998/2006' is 32006R1998, ook zonder 'nr.'); een nummer dat in beide vormen past ('2018/1999') geeft beide handelingen, tenzij '(EU)' of '(EG) nr.' kiest.

## `eurlex_document`

Metadata van één EU-handeling.

- **Inputs**: `id` = CELEX (`32016R0679`) of citaat (`Verordening (EU) 2016/679`, `Richtlijn 95/46/EG`), outputFormat/verbose/dryRun.
- **Output**: titel, type, datum, geldigheid, ELI en EUR-Lex-link, plus de nieuwste HvJ-arresten die de handeling uitleggen (`hvj_arresten`, `hvj_arresten_total`), de nieuwste wijzigingshandelingen met CELEX en datum (`amended_by`, max. 20; `amended_by_total`; rectificaties tellen niet mee) en de handelingen die haar intrekken (`repealed_by`).
- **Gedrag**: ongeldige invoer wordt vóór de request geweigerd, met voorbeeldformaten in `suggestion`.

## `eurlex_nl_omzetting`

Nederlandse nationale omzettingsmaatregelen bij een EU-richtlijn.

- **Inputs**: `id` = CELEX of citaat van een richtlijn, `top`, pagination/outputFormat/verbose/dryRun.
- **Output**: `directive_celex`, `title`, `measure_type`, `official_journal`, `identifier` (bv. `stb-2018-401`), `publication_date`, `notification_date`, `canonical_url` (Officiële Bekendmakingen als de identifier bekend is, anders EUR-Lex).
- **Let op**: alleen het Publicatieblad van de EU is authentiek; EUR-Lex-inhoud is herbruikbaar met bronvermelding.

## `lido_verwijzingen`

Tellingen van verwijzingen in LiDO (Linked Data Overheid, CC0).

- **Inputs**: `id` = ECLI (`ECLI:NL:HR:2019:2006`), BWB-id (`BWBR0011823`, optioneel met `artikel`), CELEX (`32016L0680`) of OEP-publicatie (`stb-2018-401`), outputFormat/verbose/dryRun.
- **Output**: één record met `input_id`, `kind`, `artikel`, `lido_id`, `total_references`, `per_type` (aflopend op aantal) en `portal_url` naar de lijstweergave in het LiDO-portaal.
- **Let op**: bij BWB tellen de aantallen voor de meest recente versie van de regeling of het artikel; verwijzingen naar oudere versies tellen niet mee.
- De lijst zelf: `lido_verwijzingen_lijst`.

## `lido_verwijzingen_lijst`

De gekoppelde documenten zelf (inkomend en uitgaand) uit LiDO, via de LiDO-service `get-links` (CC0).

- **Inputs**: `id` en `artikel` zoals bij `lido_verwijzingen`; optioneel `type` (LiDO-informatietype, bv. `Jurisprudentie`, `Wet`, `Verdrag`, `Amvb`, `Ministeriële-regeling`, `Officiele overheidspublicatie`); `offset`/`limit` (upstream gepagineerd, `limit` standaard 20 en maximaal 100); outputFormat/verbose/dryRun.
- **Output**: per gekoppeld document `lido_id`, `external_id` (ECLI, CELEX, wetten.overheid.nl-URI, ...), `title`, `type` + `type_uri`, `creator`/`authority`, `modified`, `url` (bron-URL uit `hasVersion`), `direction` (`uitgaand` = het opgevraagde item verwijst ernaar, `inkomend` = het verwijst naar het opgevraagde item, `beide`), `link_labels` en `juriconnect`. `summary` geeft het totaal, het getoonde bereik en de verdeling per type; `pagination.total` is het totaal.
- **Gedrag**: `total` en `offset` tellen verwijzingen (zelfde telling als `lido_verwijzingen`). Een document met meer dan één verwijzing (beide richtingen, of dezelfde verwijzing twee keer) staat per pagina één keer in `records`; `has_more` rekent op de verwijzingen. Het `type`-filter is strikt gevalideerd (alleen letters, cijfers, spaties, koppeltekens; max. 60 tekens) en bekende typen worden hoofdletter- en accentongevoelig naar de LiDO-spelling gezet (`wet` → `Wet`). Een onbekend item levert 0 records op, geen verzonnen record.
- **Auth**: LiDO documenteert `get-links` als niet-publieke service, maar dwingt geen account af. Zijn `LIDO_USERNAME` en `LIDO_PASSWORD` allebei gezet, dan gaat HTTP Basic auth mee op `get-links` (niet op `get-id`/`get-aantal-per-informatietype`). Een 401/403 geeft een duidelijke foutmelding die naar die variabelen verwijst.
- **Let op**: bij BWB gaat het om de meest recente versie van de regeling of het artikel, net als bij `lido_verwijzingen`.

## `algoritmeregister_search`

Algoritmes en AI-systemen die overheidsorganisaties hebben gepubliceerd in het Algoritmeregister (algoritmes.overheid.nl, ministerie van BZK; open JSON-API, geen key).

- **Inputs**: `query` (trefwoorden, bv. 'parkeervergunning', 'afvalinzameling'), `organisatie` (naam, plaatsnaam, afkorting zoals 'UWV' of 'IenW' in elke schrijfwijze, register-`org_id` of registercode), `include_children` (default true: ook onderliggende organisaties), `status` (`In gebruik`, `In ontwikkeling`, `Buiten gebruik`), `publicatiecategorie` (`Hoog-risico AI-systeem`, `Impactvolle algoritmes`, `Overige algoritmes`), `categorie` (thema), `organisatietype`, `top`/`offset`/`limit` (max. 100 per aanroep, upstream gepagineerd), outputFormat/verbose/dryRun.
- **Zoeken**: trefwoorden worden in alle velden gezocht met Nederlandse woordstammen en moeten allemaal voorkomen; "aanhalingstekens" zoeken een frase, 'of' geeft alternatieven en -woord sluit uit. Zonder exacte treffers antwoordt het register met vergelijkbare woorden (fuzzy); de samenvatting meldt dat ('Geen exacte treffers', of 'Vermoedelijk geen' als het is afgeleid). Met een organisatie of filter controleert de tool dat met de exacte zoekfunctie van het register (enkele extra requests).
- **Organisatie**: een kale plaatsnaam kiest de gemeente; de gekozen organisatie en andere kandidaten staan in `access_note`. Een niet-eenduidige naam levert geen algoritmes maar de passende organisaties; een onbekende naam geeft 0 resultaten en de samenvatting noemt gelijkende organisaties die wel publiceren.
- **Output**: per algoritme naam, organisatie, korte omschrijving, status, publicatiecategorie, thema's, leverancier, impact assessments, publicatiedatum en een link naar de pagina op algoritmes.overheid.nl; nieuwste publicatie eerst.
- **Let op**: het register bevat alleen wat organisaties zelf publiceren en is dus niet volledig. Omgevingsdiensten, veiligheidsregio's, GGD's en andere regionale samenwerkingsverbanden staan onder `organisatietype` 'veiligheidsregio'; zoek zo'n organisatie liever op naam.

## `wodc_search`

Onderzoeksrapporten van het Wetenschappelijk Onderzoek- en Datacentrum (WODC, ministerie van Justitie en Veiligheid) in de WODC Repository (`repository.wodc.nl`, DSpace 7, open REST-API, geen key), vanaf 1974: criminaliteit, recidive, de strafrechtketen, migratie, evaluaties van wetten.

- **Inputs**:
  - `query` (optioneel): trefwoorden, gezocht in de metadata én in de volledige tekst van de rapporten, alle woorden verplicht; `"aanhalingstekens"` voor een woordgroep, `OR` en `-woord` werken (bv. 'recidive', 'ondermijning', '"huiselijk geweld"', 'cybercrime -fraude'). Leeg: alles wat aan de filters voldoet
  - `date_from` / `date_to` (optioneel): gepubliceerd op of na / op of vóór, als YYYY, YYYY-MM of YYYY-MM-DD; een maand of jaar telt tot en met zijn laatste dag. Een ongeldige datum of `date_from` na `date_to` is een fout met `suggestion`
  - `series` (optioneel): reeks, als deel van de naam: 'Cahier', 'WODC Rapport', 'Factsheet', 'Memorandum', 'Justitiële verkenningen', of één nummer ('Cahier 2026-12')
  - `project` (optioneel): WODC-projectnummer, als deel van het nummer en hoofdletterongevoelig ('3606', of '3105' voor 3105a-3105g)
  - `author` (optioneel): auteur, als deel van de naam ('Achternaam, Initialen' in de repository), bv. 'Wartna'
  - `sort` (optioneel): `relevance` (standaard met trefwoorden), `newest` (standaard zonder), `oldest`
  - `top` (standaard 20, max 100), `offset`/`limit` (`limit` wordt begrensd op 100), `outputFormat`, `verbose`, `dryRun`
- **Paginering**: de repository pagineert zelf (DSpace `page`/`size`); de tool kiest de kleinste paginagrootte die het gevraagde venster in één pagina vangt, anders hooguit drie opeenvolgende pagina's. Een pagina van 100 kost de repository enkele seconden. `pagination.total` is het aantal treffers dat de repository meldt (`totalElements`).
- **Output** per rapport: `title` (met ondertitel), `authors`, `institutions`, `issued`, `series`, `projectnummers`, `type`, `subjects`, `abstract` (ingekort tot 600 tekens, `abstract_ingekort`; volledig via `wodc_document_get`), `publisher`, `url` (de persistente handle-URL), `item_url`, `news_urls` (het nieuwsbericht op wodc.nl), `related_urls` en `uuid`/`handle` voor `wodc_document_get`.
- **Let op**: een treffer kan alleen in de volledige tekst staan (de zoekdienst geeft geen markeringen); `access_note` zegt dat. Een zoekvraag die de repository weigert (HTTP 400/422) is een `http_error` met `suggestion`.

## `wodc_document_get`

Eén WODC-rapport op uuid of handle-URL uit `wodc_search`: volledige metadata, de bestanden van het item en de tekst.

- **Inputs**:
  - `id` (verplicht): uuid of handle-URL, bv. `cee6220c-e1b7-4507-a313-8891c35e77e4` of `https://repository.wodc.nl/handle/20.500.12832/3576`; ook een item-URL, `hdl:20.500.12832/3576` of alleen het handlenummer. Iets anders is een fout met `suggestion`
  - `max_chars` (standaard 10000, min 0, max 50000): tekens tekst (met `zoekterm`: van alle passages samen); `0` geeft alleen metadata en bestanden
  - `zoekterm` (optioneel): woorden die allemaal dicht bij elkaar moeten staan (binnen 400 tekens); `"aanhalingstekens"` voor exacte woorden. Geeft de passages eromheen (hooguit 20) in plaats van het begin, met `passages_totaal` en `woord_treffers`
  - `bestand` (optioneel): een ander bestand dan het hoofdrapport: 'samenvatting', 'summary', 'aanbiedingsbrief', 'factsheet', een deel van een bestandsnaam of een bestands-uuid. Niet gevonden: het hoofdrapport, gemeld met de lijst bestanden
  - `text_source` (standaard `auto`): `auto` (de tekst van de repository, de PDF als die ontbreekt of te kort is), `repository` (alleen de repositorytekst, snel), `pdf` (altijd de PDF)
- **Tekst**: de repository bewaart haar eigen tekstextractie per PDF, die stopt na 100.000 tekens. Is meer nodig (een `zoekterm`, een grotere `max_chars`), dan leest `auto` de PDF zelf, tot 200.000 tekens. `tekst_bron` zegt welke bron het werd, `tekst_onvolledig` dat de gelezen tekst niet het hele rapport is; elke afkapping staat in `access_note`.
- **Output**: de velden van `wodc_search` met het volledige abstract, plus `files` (per bestand `uuid`, `name`, `size_bytes`, `soort`, download-`url`, `repository_tekst`), `bestand`, `bestand_url`, `tekst_bron`, `tekst`, `tekst_lengte`, `tekst_ingekort`, `tekst_onvolledig`, `pdf_tekst_lengte`, `pdf_paginas`, `zoekterm`, `passages`, `passages_totaal`, `woord_treffers`.
- **Gedrag**: een item zonder bestanden (elders gepubliceerd) zegt dat en geeft de link; een ingetrokken item wordt gemeld. Een onbekend id is een leeg resultaat dat dat zegt. `access_note` vermeldt altijd dat de repository bij de rapporten geen licentie noemt (de website zelf is CC0).
