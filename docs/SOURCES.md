# Sources

## data.overheid.nl
- CKAN action API
- endpoints: `package_search`, `package_show`, `organization_list`, `group_list`

## CBS
- Primary: `https://datasets.cbs.nl/odata/v1/CBS`
- Fallback: `https://opendata.cbs.nl/ODataApi/OData`
- Second fallback: `data.overheid.nl` (CBS organization filter)

## Tweede Kamer
- `https://gegevensmagazijn.tweedekamer.nl/OData/v4/2.0`
- entities used: `Document`, `Zaak`

## Officiële Bekendmakingen
- SRU endpoint `https://repository.overheid.nl/sru`
- connection: `officielepublicaties`

## Rijksoverheid
- News/document search: `https://www.rijksoverheid.nl/api/rss?query=<JSON>` — the RSS platform that replaced the retired `opendata.rijksoverheid.nl/v1/documents` API (migration 2 June 2026). `query` carries `filters` (content_type) + `resultSearchTerm` (server-side keyword). Keyless, returns RSS 2.0 XML.
- School holidays: `https://opendata.rijksoverheid.nl/v1/infotypes/schoolholidays` — still live on the old host; queried per schoolyear.

## Rijksbegroting
- CKAN-compatible search adapter at `/api/3/action/package_search`

## DUO
- CKAN datasets adapter on `https://onderwijsdata.duo.nl`
- RIO adapter on `https://lod.onderwijsregistratie.nl/rio-api`

## API register
- `https://apis.developer.overheid.nl` (requires `OVERHEID_API_KEY`)

## KNMI
- `https://api.dataplatform.knmi.nl/open-data/v1` (requires `KNMI_API_KEY`)

## Ruimtelijkeplannen.nl (Wro/Bro)
- WMS GetFeatureInfo on `https://service.pdok.nl/kadaster/ruimtelijke-plannen/wms/v1_0` (`plangebied` layer, EPSG:28992, keyless, CC-0)
- Geocoding via PDOK Locatieserver (`https://api.pdok.nl/bzk/locatieserver/search/v3_1/free`) for gemeente → woonplaats centroids (sampled with 1.5 km half-width) or fallback to a national bbox
- Bbox is validated against the EPSG:28992 (RD New) extent for the Netherlands before any WMS call to avoid wasting circuit-breaker budget on malformed input

## DSO Omgevingsdocumenten
- Presenteren API v8 base: `https://service.omgevingswet.overheid.nl/publiek/omgevingsdocumenten/api/presenteren/v8`
- `GET /regelingen` for general listing, `POST /regelingen/_zoek` when a `bevoegdGezag` or `typeBevoegdGezag` filter is provided
- Requires `DSO_API_KEY` via `x-api-key` header; without it the tool returns a typed `not_configured` error pointing to the request form
- Discovery-only: returns metadata (titel, type, bevoegd gezag, geldigheidsdatums, viewer-link). No juridische tekst extraction.


## Nieuwe bronnen (v0.2)

## data.politie.nl (misdaadcijfers)

- **Connector**: `data_politie` (category: static)
- **Endpoint**: `https://dataderden.cbs.nl/ODataApi/OData/{tableId}` (CBS "dataderden" OData v3, keyless)
- **Kerntabellen**: `47013NED` (geregistreerde misdrijven; dimensies SoortMisdrijf, RegioS, Perioden), `47018NED` (maandcijfers wijk/buurt), `84468NED`.
- **Auth**: geen (openbaar). Deelt host met CBS StatLine-derden; connector wordt daarom expliciet meegegeven aan elke request.
- **Gedrag**: filtert `TypedDataSet` op RegioS/SoortMisdrijf/Perioden via `$filter` (eq + startswith voor jaartallen). RegioS/SoortMisdrijf accepteren code of naam (naam wordt via de dimensie-lijst omgezet). `dimension`-modus levert geldige filterwaarden (Key/Title) uit RegioS, SoortMisdrijf of Perioden.

## CBS Iv3 (gemeente-/provinciefinanciën)

- **Connector**: `cbs_iv3` (category: static)
- **Endpoint**: `https://dataderden.cbs.nl/ODataApi/OData/{tableId}` (CBS "dataderden" OData v3, keyless)
- **Kerntabel**: `45071NED` (gemeentefinanciën; dimensies Gemeenten, TaakveldBalanspost, Categorie, Verslagsoort).
- **Auth**: geen (openbaar). Deelt host met CBS StatLine-derden; connector wordt expliciet meegegeven aan elke request.
- **Gedrag**: filtert `TypedDataSet` op Gemeenten/TaakveldBalanspost/Categorie/Verslagsoort via `$filter` (eq, gecombineerd met `and`). Alle dimensies accepteren code of naam (naam wordt via de dimensie-lijst omgezet; bv. Verslagsoort 'begroting'/'jaarrekening'). `dimension`-modus levert geldige filterwaarden (Key/Title).

## BWB geconsolideerde wetgeving (wetten_bwb)

- Endpoint: `https://zoekservice.overheid.nl/sru/Search` (KOOP SRU, `x-connection=BWB`, `version=1.2`, `operation=searchRetrieve`).
- Auth: geen (keyless).
- Categorie: static.
- Bron: geconsolideerde nationale wet- en regelgeving (Basiswettenbestand) zoals ontsloten via wetten.overheid.nl.
- Gedrag: BWB gebruikt eigen SRU-indexen; generieke indexen (cql.textAndIndexes, dcterms.title) worden geweigerd. De vrije zoekterm wordt op de titel-index `overheidbwb.titel` gematcht (meerwoords termen als CQL-phrase gequote). Records worden genarmaliseerd naar BWBR-identifier, titel, bevoegd gezag (authority), datum en een canonieke `https://wetten.overheid.nl/{BWBR}`-link.

## CVDR lokale regelgeving (cvdr)

- Endpoint: `https://zoekservice.overheid.nl/sru/Search` (KOOP SRU, `x-connection=cvdr`, `version=1.2`, `operation=searchRetrieve`).
- Auth: geen (keyless).
- Categorie: static.
- Bron: Centrale Voorziening Decentrale Regelgeving — verordeningen en regelingen van gemeenten, provincies en waterschappen.
- Gedrag: CVDR ondersteunt de default cql.serverChoice niet; vrije zoektermen lopen via de `keyword`-index (meerwoords termen als CQL-phrase gequote). Records worden genarmaliseerd naar CVDR-identifier, titel, uitvaardigende gemeente/organisatie (creator), datum (issued/modified) en een canonieke `lokaleregelgeving.overheid.nl`-link (preferredUrl uit enrichedData, met opbouw uit de identifier als fallback).

## PDOK Bestuurlijke Gebieden (bestuurlijke_gebieden)

- Endpoint: `https://api.pdok.nl/kadaster/bestuurlijkegebieden/ogc/v1` (OGC API Features, GeoJSON).
- Keyless. Category: static (60m cache). Bijgewerkt op basis van de kadastrale registratie (BRK).
- Collecties: `gemeentegebied`, `provinciegebied`, `landgebied`.
- Zoek op exacte `naam` (hoofdlettergevoelig, exacte match op de naam-property), `code`, of een RD New (EPSG:28992) bbox (met `bbox-crs`). Geeft naam, code, identificatie, bovenliggende provincie/land, berekende bbox/centroïde en optioneel de volledige GeoJSON-geometrie terug.
- LET OP: host api.pdok.nl matcht in inferConnectorName op "pdok.nl" → "pdok_bag"; de bron geeft daarom altijd expliciet `connector: "bestuurlijke_gebieden"` mee.

## PDOK BRK Kadastrale Kaart (brk_kadastrale_kaart)

- Endpoint: `https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1` (OGC API Features, GeoJSON).
- Keyless. Category: semi_live (10m cache); brondata wordt dagelijks bijgewerkt.
- Collecties: `perceel`, `kadastralegrens`, `openbareruimtenaam`, `bebouwing`, `nummeraanduidingreeks`.
- bbox-gedreven: geef een RD New (EPSG:28992) bbox 'minx,miny,maxx,maxy' (met `bbox-crs`). Geeft de kadastrale aanduiding (gemeente/sectie/perceelnummer), grootte (m2), berekende bbox/centroïde en optioneel de volledige GeoJSON-geometrie terug. Geen persoonsgegevens.
- LET OP: host api.pdok.nl matcht in inferConnectorName op "pdok.nl" → "pdok_bag"; de bron geeft daarom altijd expliciet `connector: "brk_kadastrale_kaart"` mee.

## BRON Verkeersongevallen (Rijkswaterstaat WFS)

- **Connector:** `bron_ongevallen` (category: static — jaarlijkse update)
- **Endpoint:** `https://geo.rijkswaterstaat.nl/services/ogc/gdr/verkeersongevallen_nederland/ows` (OGC WFS 2.0.0)
- **Auth:** geen (keyless)
- **Feature types:** `ongevallen_2022`, `ongevallen_2023`, `ongevallen_2024`, `ongevallen_2022_2024` (gecombineerd), plus `wegvakgeografie_01012025` (niet ontsloten via deze tool).
- **Werking:** `GetFeature` met `outputFormat=application/json` (GeoJSON), `srsName=EPSG:28992`, `count=` en een `bbox=minx,miny,maxx,maxy,EPSG:28992` in RD New. De bbox is verplicht; zoeken over de volledige landelijke dataset wordt geweigerd. `numberMatched` uit de respons levert het echte totaal (kan groter zijn dan de opgehaalde pagina). Severity (`afloop`), gemeente en straat/plaats worden client-side gefilterd.
- **Records:** ongeval-id, aard, afloop (Letsel/Dodelijk/UMS), aantal partijen, betrokken vervoerswijzen (partij_N_objecttype), straatnaam/woonplaats/gemeente/provincie, maximumsnelheid en RD-coördinaten.

## NZa Zorgbeeld (wachttijden MSZ)

- **Endpoint:** `https://zorgbeeld.nza.nl/openapi/WaitingTimeMSZ` (GET, keyless, geen auth)
- **Formaat:** XML (root `<TL_RESTs>` met `<TL_REST>`-records). OpenAPI-spec: `https://zorgbeeld.nza.nl/rest-doc/openapi/swagger.json`.
- **Query-param:** alleen `KVKNummer` (server-side beperking tot één zorgaanbieder). Overige filtering (zoekterm, specialisme, behandeltype) gebeurt client-side op de opgehaalde set.
- **Gedrag:** actuele wachttijden medisch-specialistische zorg per instelling/locatie/specialisme/behandeltype. Levert zorgaanbieder, specialisme, wachttijd in dagen, peildatum (`Date`), adres, KVK/AGB-codes. `WaitingTime` ontbreekt bij `InsufficientObservations=Ja` (dan `waitingTimeDays: null`). Zonder `kvk` wordt de volledige set opgehaald (grote payload); `total` telt eerlijk de treffers in de opgehaalde snapshot.

## Register van Overheidsorganisaties (ROO / TOOI)

- **Connector:** `overheidsorganisaties` (static, keyless)
- **Endpoint:** `https://api-organisaties.overheid.nl/v1/overheidsorganisaties` (lijst) en `.../{organisatieUri}/contact`, `.../{organisatieUri}/adressen` (verrijking)
- **Auth:** geen sleutel nodig. Fair use: 100 req/s.
- **OpenAPI:** https://api-organisaties.overheid.nl/v1/openapi.json
- **Gedrag:** De lijst-endpoint levert een platte JSON-array van `{ label, type, uri }` zonder server-side naamfilter of paginering. De connector haalt de volledige lijst op en filtert client-side op naam (case-insensitive substring). Optioneel `type`-filter (TOOI-ontologie-URI) wordt wel server-side meegegeven. Teruggegeven treffers worden (tot 15) verrijkt met website + telefoon (`/contact`) en bezoekadres (`/adressen`); verrijking is best-effort en breekt de zoekopdracht niet bij fouten. Nuttig als utility voor cross-source koppeling: naam -> canonieke TOOI-URI.

## OVapi (realtime openbaar vervoer)

- **Endpoint:** `http://v0.ovapi.nl/tpc/{timingPointCode}` (halte + realtime passages). Aanvullend: `http://v0.ovapi.nl/stopareacode/{code}` en de GTFS static index `https://gtfs.ovapi.nl/nl/`.
- **Auth:** geen (keyless). Let op: `v0.ovapi.nl` draait op **plain HTTP** (geen geldig HTTPS-cert) — de `http://`-URL is bewust en correct.
- **Categorie:** live (cache-TTL 2 min).
- **Gedrag:** geeft per halte (timingpointcode) de actuele vertrekken terug: lijn (`LinePublicNumber`), bestemming (`DestinationName50`), transporttype, geplande (`TargetDepartureTime`) + verwachte (`ExpectedDepartureTime`) vertrektijd, vertraging in minuten en realtime status (`TripStopStatus`). Gesorteerd op verwachte vertrektijd. De gebruiker heeft een **haltecode** nodig (bv. 32002646), op te zoeken via 9292 of de GTFS-index.

## BRO — Basisregistratie Ondergrond (publieke REST-services)

- **Endpoint (base):** `https://publiek.broservices.nl/`
  - Object-services (leveren XML, GML-achtig `dispatchDataResponse`): `/gm/gmw/v1/objects/{broId}` (grondwatermonitoringput), `/gm/gld/v1/objects/{broId}` (grondwaterstanddossier), `/gm/gmn/v1/objects/{broId}` (monitoringnet), `/sr/cpt/v1/objects/{broId}` (sondering), `/sr/bhrgt/v2/objects/{broId}` (geotechnisch booronderzoek).
  - Refcodes (JSON): `/bro/refcodes/v1/domains` (referentiecodelijsten).
- **Key vereist:** Nee. Keyless publieke leveringsservices (geen PKI-clientcertificaat nodig voor deze publieke read-only services).
- **Gedrag:** Een zoekterm die matcht op een BRO-id-patroon (3 letters + cijfers, bv. `GMW000000036287`) wordt gerouteerd naar de bijbehorende XML-objectservice; de put/objectgegevens worden genormaliseerd naar broId, objecttype, kwaliteitsregime, registratiestatus + WGS84 (EPSG:4258) en RD (EPSG:28992) coördinaten. Elke andere zoekterm filtert de BRO refcode-domeinen (JSON) op naam/omschrijving. Category: `semi_live`.

## NED.nl — Nationaal Energie Dashboard

- **Endpoint:** `https://api.ned.nl/v1/utilizations` (vervangt het verouderde `api.netanders.io/v1`).
- **Auth:** VERPLICHT. Persoonlijke API-sleutel via je NED-account (https://ned.nl/nl/api), meegestuurd als HTTP-header `X-AUTH-TOKEN: <api-key>`. Env-var `NED_API_KEY`.
- **Rate limit:** 200 requests / 5 minuten.
- **Respons:** Hydra / JSON-LD (API Platform): records in `hydra:member`, totaal in `hydra:totalItems`, paginatie via `hydra:view`.
- **Gedrag:** Levert opwek/verbruik per energiebron (zon, wind op land, wind op zee, fossiel gas, kern, aardgas, elektriciteitsvraag) en periode: capaciteit (kW), volume (kWh), benuttingsgraad (%), CO2-emissie (kg) en emissiefactor. Ondersteunt forecasts (classification=1) en gemeten waarden (classification=2). Parameters: `point` (gebied), `type` (energiebron), `granularity` (10min/kwartier/uur/dag/maand/jaar), `granularitytimezone` (UTC/CET), `activity`, `classification`, en tijdvenster via `validfrom[after]`/`validfrom[before]`.

## EP-Online energielabels (RVO)

- **Tool:** `ep_online_energielabel`
- **Endpoint:** `https://public.ep-online.nl/api/v5/PandEnergielabel/Adres` (postcode + huisnummer) en `.../PandEnergielabel/AdresseerbaarObject/{bagId}`
- **Auth:** VERPLICHT. `EP_ONLINE_API_KEY` als kale waarde in de `Authorization`-header (geen `Bearer`-prefix). Aanvragen via https://www.ep-online.nl/.
- **Categorie:** semi_live (cache-TTL 10m).
- **Gedrag:** Read-only lookup van geregistreerde energielabels uit het landelijke EP-Online register. Sluit aan op de BAG-adresflow (postcode+huisnummer, of BAG verblijfsobject-id). Geeft energieklasse, registratie-/opnamedatum, geldig-tot, gebouwtype, BAG-ids en energie-indicatoren (EnergieIndex, energiebehoefte, primaire fossiele energie, aandeel hernieuwbaar, berekend energieverbruik, bouwjaar). Een adres zonder geregistreerd label geeft een leeg resultaat.

## NS Reisinformatie (key required)
- Base: `https://gateway.apiportal.ns.nl/reisinformatie-api/api`
- Endpoints per operatie (versies verschillen): `v3/disruptions` (verstoringen + werkzaamheden), `v2/departures` (vertrektijden per station), `v2/arrivals` (aankomsttijden), `v3/trips` (reisadvies from/to)
- Auth: `NS_API_KEY` via header `Ocp-Apim-Subscription-Key` (Azure API Management gateway); zonder sleutel geeft de tool een typed `not_configured` error met aanvraaglink (https://apiportal.ns.nl/)
- **Belangrijk — juiste product**: registreer op https://apiportal.ns.nl/ en abonneer op het **"Ns-App"**-product; dat bevat de Reisinformatie API (gratis externe tier ~300 requests/5 min). NIET het "Public-Travel-Information"-product: dat bevat alleen de verouderde Price API en NS keurt daar geen nieuwe abonnementen meer op goed. De primary key staat daarna op je NS-portal Profiel-pagina.
- Realtime data (categorie `live`, cache-TTL 2 min). Tijden zijn ISO-8601 in Europe/Amsterdam.
- Records zijn lean: id, title, url (publieke NS-deeplink), type, date + domeinvelden (direction/track/operator voor departures, phase/cause/type voor disruptions, transfers/duration voor trips).

## DNB Statistics API

- **Connector**: `dnb` (category `static`)
- **Tool**: `dnb_statistics_search`
- **Gateway (API-calls)**: `https://api.dnb.nl` — bijv. `GET https://api.dnb.nl/statisticsdata/<versie>/<dataset-slug>`. LET OP: `api.portal.dnb.nl` is alleen de developer-portal-website (accounts + subscriptions); data-calls dáárheen geven 404 HTML.
- **Auth**: KEY-VEREIST. Subscription key via HTTP-header `Ocp-Apim-Subscription-Key`. Gratis: maak een My DNB-account op https://api.portal.dnb.nl/, abonneer op het product **'Public'** en genereer de key op de productpagina (self-service, geen goedkeuring; rate limit 30 calls/min). Kopieer de primary key naar `DNB_API_KEY`.
- **Data**: Engelstalige datasets o.a. rente, wisselkoersen, hypotheken, balansen pensioenfondsen/verzekeraars, betalingsbalans. Respons is `{ records: [...], lastReleaseDate, _metadata }`; per datapunt periode/waarde (+ dataset-specifieke velden zoals currency/typeOfRate).
- **dataset-argument**: geef het pad `statisticsdata/<versie>/<dataset-slug>` (bijv. `statisticsdata/v2026061000/exchange-rates-of-the-euro-and-gold-price-day`) of een volledige URL. De dataset-slugs staan in de API-docs op het portaal (APIs → DNB Statistics API). De datapunt-parser is defensief (accepteert records/observations/data/value/results-containers en period/value/unit in diverse casings).
