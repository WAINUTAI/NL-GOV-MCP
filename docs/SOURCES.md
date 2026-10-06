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
- entities used: `Document`, `Zaak`, `Besluit`, `Stemming`, `Persoon`, `FractieZetelPersoon`; `tweede_kamer_search` accepts every entity set of the service
- keyword search is an AND of `contains()` filters on title and subject; a search is sent once with a 40 s timeout and retried only after a 5xx or a dropped connection
- document files via `Document({id})/Resource`; text is extracted from PDF text layers and Word (.docx) files
- debates (`tweede_kamer_debatten`): `Vergadering` with its `Verslag` records (newest first, at most 20 per call, `$skip` for the next ones); the verslag itself (VLOS XML) via `Verslag({id})/resource`, the most corrected version (Gerectificeerd, Gecorrigeerd, Ongecorrigeerd; never a Casco voorpublicatie). There is no full-text search in the API: the XML is parsed and matched in the server. A commissiedebat links to its activiteit page, found by `Activiteit` with the same `Aanvangstijd`; a plenaire dag to `tweedekamer.nl/kamerstukken/plenaire_verslagen/detail/{vergaderjaar}/{nummer}`

## Officiële Bekendmakingen
- SRU endpoint `https://repository.overheid.nl/sru`
- connection: `officielepublicaties`
- filters: `w.publicatienaam` (journal), `dt.type` (document kind), `dt.creator` + `w.organisatietype` (publisher; place names are matched in their official spelling, e.g. 's-Gravenhage), `dt.date` (dagtekening) or `dt.available` (publication date); `sortBy` on the same date for `date_newest`/`date_oldest`
- free text goes through `src/utils/sru-cql.ts` (stopwords dropped, phrases and citations kept whole)

## Rijksoverheid
- News/document search: `https://www.rijksoverheid.nl/api/rss?query=<JSON>` — the RSS platform that replaced the retired `opendata.rijksoverheid.nl/v1/documents` API (migration 2 June 2026). `query` carries `filters` (content_type, and `sort_date` for date_from/date_to, the field the site's own period filter uses) + `resultSearchTerm` (server-side keyword). Keyless, returns RSS 2.0 XML, at most 20 items per query.
- School holidays: `https://opendata.rijksoverheid.nl/v1/infotypes/schoolholidays` — still live on the old host; queried per schoolyear.

## Rijksbegroting
- CKAN-compatible search adapter at `/api/3/action/package_search`

## DUO
- CKAN adapter on `https://onderwijsdata.duo.nl`
  - `datastore_search` (per-row) for `duo_schools` and `duo_exam_results` — every DUO resource is `datastore_active`, so rows are filterable server-side
  - `package_search` (catalogue) for `duo_datasets_search`
  - `package_show` resolves the current resource id per dataset by resource name, so a DUO re-upload (which mints a new resource id) does not break the connector; the last known id is the fallback
- Datasets used: `adressen_bo` (vestigingen po), `adressen_vo` (vestigingen vo), `adressen_mbo`, `adressen_ho` (instellingen), `03_voex-v1` (slagingspercentages per vestiging, schooljaren 2013–2017)
- Filter semantics: `GEMEENTENAAM` / `PLAATSNAAM` / `POSTCODE` match exactly and are stored uppercase (input is uppercased for you); a school name goes through the datastore full-text `q`
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
- Requires `DSO_API_KEY` via `x-api-key` header (`Accept: application/hal+json`); without it both tools return a typed `not_configured` error pointing to the request form. The DSO answers a malformed key with HTTP 400 and an unknown or unauthorised one with 401/403; both tools report those as `not_configured` too. The key is trimmed; a key with any character other than visible ASCII (a space inside it too) is never sent (a header error would quote it) and gives `not_configured` without the value
- `POST /regelingen/_zoek` (and `/ontwerpregelingen/_zoek`) for a location, a bevoegd gezag or a provincie area: body `geometrie` (GeoJSON Point in RD New, header `Content-Crs: http://www.opengis.net/def/crs/EPSG/0/28992`; WGS84 is not supported), `bevoegdGezag` (array of lowercase TOOI codes: `gm0344`, `pv26`, `ws0636`, `mnre1034`), `typeBevoegdGezag`; query `size=200`, `page` (from 1), `_sort=-geldigVanaf,identificatie` (on `/ontwerpregelingen/_zoek`: `-registratietijdstip,identificatie`, since ontwerpregelingen cannot be sorted on geldigVanaf; `identificatie` breaks the many ties so pages neither overlap nor skip). A bevoegd-gezag list without a filter is one page; with `query`/`documentType`/`alleen_ter_inzage`, a location or an area up to 10 pages (2,000 records)
- Time travel: `geldigOp` alone means "geldig on that day, in werking today" (the DSO's default for `inWerkingOp`), which leaves out every regeling amended since. The server sends `geldigOp` and `inWerkingOp` with the same day, on `_zoek`, the list, the catalogue and the documentstructuur. Not for ontwerpregelingen
- A provincie area is one `_zoek` with the provincie's code and those of all its gemeenten, taken from the Locatieserver (`fq=type:gemeente AND provinciecode:PV26`, `rows=100`) and kept six hours. Waterschappen and the Rijk are not included
- Locations are geocoded with the keyless PDOK Locatieserver (`https://api.pdok.nl/bzk/locatieserver/search/v3_1/free`, `rows=10`, `centroide_rd`); hits outside the RD extent of the Netherlands are dropped. A leading "postcode", "adres" or "locatie" is removed and a postcode loses its space ("3524 BN" → "3524BN"). A gemeente or woonplaats named at the start or end of the input (by any of its names, also next to a postcode) restricts the hits to that place, asked again with `fq=gemeentenaam:"…"` (or `woonplaatsnaam`) when the first ten lack the address. A word none of the first hits covers is looked up with `fq=type:(gemeente OR woonplaats)`; when it names a place ("Utrecht Centraal Station"), the input is searched within that place, and not finding it there is an error. The rest of the input must resemble the hit: more than half of its words (letters only, three or more, no fillers) must start a word of the hit with the same four letters. An ordinal before the street ("1e", "2de") only matches that street ("1e Hugo de Grootstraat" is "Eerste Hugo de Grootstraat"). With a house number, in this order: the address itself, the same number with another toevoeging, the street's centre, a postcode on the street; a hit on another street (a street word the input lacks, "Oude Kerkstraat" for "Kerkstraat") only after all of those. The street's centre and another street come with a note, as does a woonplaats other than the named gemeente's own name ("Ligt in de woonplaats De Meern (gemeente Utrecht)"). With a postcode only hits with that postcode; without a place, a hit of the same type in another gemeente scoring at least 95 % as high makes the input ambiguous (an error naming the options). These requests, and those for a provincie's gemeenten, run under their own connector `dso_locatieserver` (semi_live), so a PDOK failure during a DSO search does not open the circuit of the BAG or other PDOK tools
- The national catalogue (`GET /regelingen`, about 2,000 regelingen, and `GET /ontwerpregelingen`, about 1,150 ontwerpen; size 200, `_sort=identificatie`, ontwerpen `identificatie,registratietijdstip`) is fetched page by page, three at a time, and kept in memory for six hours, one per day. Today's catalogues are kept apart from those of other days (`geldigOp`, at most three, least recently used out first), so time travel never pushes today's out. An empty catalogue is never kept, and for today it is an error (`malformed_response`). It resolves bevoegd-gezag and provincie names (`aangeleverdDoorEen.naam` → `code`) and answers `query`/`documentType`/`typeBevoegdGezag`/`alleen_ter_inzage` searches without a location, bevoegd gezag or area. Without any filter: `GET /regelingen?size=<rows>&_sort=-geldigVanaf,identificatie` (`/ontwerpregelingen`: `-registratietijdstip,identificatie`)
- Ontwerpregelingen: one record per ontwerpbesluit (`technischId`); `besluitMetadata.citeerTitel` names the ontwerpbesluit (`besluitTitel`), `procedureverloop.bekendOp` its announcement and `procedureverloop.procedurestappen` the begin and end of the inzagetermijn. About a third of recent ontwerpen have no inzagetermijn steps: `terInzage` is then `null`, `eindeInzagetermijnSchatting` is `bekendOp` plus 41 days (six weeks counting the day of bekendmaking), and `mogelijkTerInzage` is set when `bekendOp` lies within the last 56 days (of the known termijnen, nearly all end 41-45 days after `bekendOp`). A termijn in the DSO shorter than 28 days is flagged `inzagetermijnOpvallendKort` (usually a kennisgeving after the fact)
- Bekendmaking of an ontwerp: a `HEAD` of identifier.overheid.nl + `ontwerpbesluitIdentificatie` without following the redirect; the `Location` (`https://zoek.officielebekendmakingen.nl/gmb-2026-409335.html`) gives `bekendmakingId` and `bekendmakingUrl`. For an ontwerp-omgevingsplan whose title names no subject, the publication's title comes from the Officiële Bekendmakingen SRU (`dt.identifier=="gmb-2026-409335"`, `recordSchema=gzd`) as `onderwerp`. At most 25 ontwerpen per search, eight at a time, 4 s per request and 8 s for all; what is not in by then is left out. Results are kept a day (an identifier that leads elsewhere an hour; a 5xx or 429 is asked again). The SRU request runs under connector `dso_bekendmakingen` (semi_live), apart from the bekendmakingen tools' circuit; the `HEAD` is a plain request, logged under that name
- Records that are no rule document of their own stay in the results, marked: `/akn/nl/act/mnre1034/2020/regOW01` (the Omgevingswet, `alleenVerwijzing`) and `/akn/nl/act/mnre1034/2021/OOWATRXX1` (Aansluitdocument Rijk, `technisch`), each with an `opmerking`. `eindGeldigheid` (`geregistreerdMet.eindGeldigheid`) is exclusive: `versieGeldigTotEnMet` is the day before
- With `documentType: "omgevingsplan"`, the voorbeschermingsregels of the plan are named from the same unfiltered answer: type "Voorbeschermingsregels Omgevingsplan" (`regelingtype_015`) by any body, or the generic "Voorbeschermingsregels" (`regelingtype_009`) of a gemeente; never a title with "omgevingsverordening", since provincies type theirs generically too
- Rule text: `GET /regelingen/{uriIdentificatie}/documentstructuur` (`uriIdentificatie` = `identificatie` with every `/` and `-` as `_`) or `GET /ontwerpregelingen/{technischId}/documentstructuur` (components under `_embedded.ontwerpDocumentComponenten`, with `wijzigactie` and the renvooi elements `NieuweTekst`/`VerwijderdeTekst`), next to a `GET` of the regeling itself for title and link. Each component carries STOP XML (`kop`, `inhoud`), converted to plain text by `src/sources/dso-regeltekst.ts` (a tokenizer that stays linear on any input; declarations, comments and processing instructions are skipped). The renvooi gives the text after the change, or with `weergave: "wijzigingen"` only the changes, marked. An omgevingsplan is several MB (Utrecht: 4.8 MB, under a second); the documentstructuur may be up to 32 MiB (other requests keep the 12 MiB cap; the HDSR waterschapsverordening is 11.9 MB, an ontwerp of it 14.4 MB), with a 30 s timeout. Parsed documents are kept 15 minutes, at most four
- Tijdelijke delen: the regeling's `_links.tijdelijkDelen` (the voorbeschermingsregels that are part of an omgevingsplan), at most 10, each by `GET /regelingen/{id}` and, for a `zoekterm`, its `/documentstructuur`; five at a time, 8 s timeout and one retry, kept with the parsed document. A tijdelijk deel's own `_links.tijdelijkDeelVan` names the regeling it belongs to
- For the Omgevingswet (`/akn/nl/act/mnre1034/2020/regOW01`) the DSO holds only a pointer ("De tekst van de Omgevingswet vindt u hier"), not the law; the text tool says so and links https://wetten.overheid.nl/BWBR0037885. The Aansluitdocument Rijk (`/akn/nl/act/mnre1034/2021/OOWATRXX1`) says only that it is there "ten behoeve van technisch aansluiten op DSO"; the text tool calls it a technical record without rules
- `dso_omgevingsdocumenten_search` answers within 45 s or returns a `timeout` error (the search runs on and fills the catalogue cache); the DSO route of `nl_gov_ask` waits 20 s
- Readable links: identifier.overheid.nl + `identificatie` redirects to lokaleregelgeving.overheid.nl for gemeente, provincie and waterschap; + `ontwerpbesluitIdentificatie` to the publication on zoek.officielebekendmakingen.nl. For Rijk regelingen the identifier does not resolve (except the Omgevingswet and Omgevingsregeling, which redirect to wetten.overheid.nl): an `identificatie` ending in a BWBR id links to wetten.overheid.nl, others to Regels op de kaart


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
- Gedrag: CVDR ondersteunt de default cql.serverChoice niet; vrije zoektermen lopen via de `keyword`-index, één `keyword=`-clause per woord met AND (de index kent geen phrase search); hoofdletter-OR en -NOT tussen woorden worden CQL-operators. `organization` gaat naar de `creator`-index (hele woorden, ook de officiële spelling van Den Haag en Den Bosch), `organization_type` naar `organisatieType`. `startRecord`/`maximumRecords` pagineren server-side en `numberOfRecords` is het echte totaal. Records worden genarmaliseerd naar CVDR-identifier, titel, uitvaardigende gemeente/organisatie (creator), datum (issued/modified) en een canonieke `lokaleregelgeving.overheid.nl`-link (preferredUrl uit enrichedData, met opbouw uit de identifier als fallback).

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
- **Gedrag:** De lijst-endpoint levert een platte JSON-array van `{ label, type, uri }` zonder server-side naamfilter of paginering. De connector haalt de volledige lijst op en filtert client-side op naam (ongevoelig voor hoofdletters, accenten, apostroffen en koppeltekens). Afkortingen, afwijkende officiële namen en einddatums komen in één gecachete query uit het TOOI SPARQL-endpoint (`https://standaarden.overheid.nl/tooi/sparql`, eigen connector `tooi_sparql`, zodat een TOOI-storing het register zelf niet blokkeert). Optioneel `type`-filter (TOOI-ontologie-URI) wordt wel server-side meegegeven. Teruggegeven treffers worden (tot 15) verrijkt met website + telefoon (`/contact`) en bezoekadres (`/adressen`); verrijking is best-effort en breekt de zoekopdracht niet bij fouten. Nuttig als utility voor cross-source koppeling: naam -> canonieke TOOI-URI.

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


## Nieuwe bronnen (v0.3)

## TenderNed (aanbestedingen)

- **Connector**: `tenderned` (category `semi_live`), plus `tenderned_recheck` voor de controle van sluitingsdata in de zoektool (eigen circuit breaker en slots, category `other` met dezelfde cache-TTL van 10 minuten)
- **Tools**: `tenderned_aanbestedingen_search`, `tenderned_aanbesteding_get`
- **Endpoints**: `https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties` (lijst), `/publicaties/{id}` (detail), `/publicaties/{id}/gerelateerd` (andere publicaties van dezelfde procedure), `/publicaties/{id}/html` (weergave met waarden, winnaars en contractdata), `/publicaties/{id}/pdf` (officiële aankondiging als PDF), `/aanbestedendediensten` (register van aanbestedende diensten)
- **Auth**: geen (publieke `papi`-API)
- **Geverifieerde queryparameters**: `search` (vrije tekst, woorden met OR), `typeOpdracht` (`L`=leveringen, `D`=diensten, `W`=werken), `procedure` (o.a. `OPE`, `NOP`, `MAC`, `OZB`, `CCD`), `publicatieDatumVanaf`, `publicatieDatumTot` (JJJJ-MM-DD), `aanbestedendeDienstId` (herhaalbaar; ids uit `/aanbestedendediensten`), `sort` (`relevantie` of `tappublicatiedatum`), `page` (0-based, max 99), `size` (max **100**, hoger geeft HTTP 400). Alleen de eerste 10.000 resultaten van een query zijn dus bereikbaar.
- **Belangrijk**: onbekende parameters worden stil genegeerd (geen 400). Een niet-ondersteund filter lijkt dus te werken terwijl het álles teruggeeft — daarom stuurt de connector uitsluitend bovenstaande, live geverifieerde parameters mee.
- **Detail**: CPV-codes, NUTS-regio, juridisch kader, procedure, aanvang/voltooiing opdracht, gunningsstatus en gerelateerde publicaties. Met `include_text` wordt de tekstlaag van de aankondigings-PDF geëxtraheerd (`utils/pdf-text.ts`).
- **Sortering**: `sort=relevantie` of `sort=tappublicatiedatum` (nieuwste eerst); de tool kiest relevantie bij een zoekterm en anders nieuwste eerst.

## Tuchtrecht (KOOP SRU)

- **Connector**: `tuchtrecht` (category `static`)
- **Tool**: `tuchtrecht_search`
- **Endpoint**: `https://repository.overheid.nl/sru` met `c.product-area==tuchtrecht` (~48k uitspraken)
- **Auth**: geen
- **Dekking**: tuchtcolleges gezondheidszorg (regionaal + centraal), advocatuur, notariaat, accountants, diergeneeskunde, gerechtsdeurwaarders. **Rechtspraak.nl bevat deze uitspraken niet** — `nl_gov_ask` routeert tuchtrechtvragen daarom vóór de Rechtspraak-route.
- **Velden**: ECLI, college, instantiedomein/-plaats, zaaknummer, beslissing, uitspraakdatum, onderwerp, samenvatting, `tuchtrecht.overheid.nl`-link en de PDF-manifestatie uit `enrichedData/itemUrl`.
- **Filters**: `dt.creator=="<college>"` (exact) en `dt.modified>=/<=` (ISO-datum).

## Samenwerkende Catalogi (KOOP SRU)

- **Connector**: `samenwerkende_catalogi` (category `static`)
- **Tool**: `samenwerkende_catalogi_search`
- **Endpoint**: `https://repository.overheid.nl/sru` met `c.product-area==samenwerkendecatalogi` (~55k productbeschrijvingen)
- **Auth**: geen
- **Inhoud**: welk product/dienst een gemeente, provincie of waterschap aanbiedt (paspoort, gehandicaptenparkeerkaart, schuldhulpverlening …), met organisatie, organisatietype, gebied, doelgroep en samenvatting.
- **Filters**: `dt.creator=="<organisatie>"` (exact) en `dt.modified>=/<=`.

### CQL-let op (geldt voor alle KOOP SRU-collecties)

Meerdere woorden vrije tekst moeten als losse termen met `AND` worden verbonden: `... AND tuchtklachten huisarts` is een **CQL-syntaxfout** die het endpoint beantwoordt met een diagnostic zónder records (stil nul-resultaat), en een phrase (`"tuchtklachten huisarts"`) matcht niets omdat deze indexen geen phrase-search hebben. `src/utils/sru-cql.ts` doet die splitsing centraal; dit repareerde meteen dezelfde latente bug in `officiele_bekendmakingen_search`.

## BRP Gewaspercelen (RVO, PDOK WFS)

- **Connector**: `brp_gewaspercelen` (category `static`)
- **Tool**: `brp_gewaspercelen_search`
- **Endpoint**: `https://service.pdok.nl/rvo/brpgewaspercelen/wfs/v1_0`, featuretype `brpgewaspercelen:BrpGewas`
- **Let op de host**: `api.pdok.nl/rvo/brpgewaspercelen/...` (OGC API Features) bestaat **niet** voor deze dataset (HTTP 404); alleen de `service.pdok.nl` WFS.
- **Auth**: geen
- **Velden**: gewas, gewascode, category (Bouwland/Grasland/Natuurterrein/Landschapselement/Braakland), jaar, status + polygon. Oppervlakte wordt lokaal berekend (shoelace, inclusief aftrek van binnenringen) omdat de bron geen oppervlakteveld levert.
- **Filtering**: de service is MapServer-based en negeert `cql_filter`; bbox is dus de enige server-side selector en gewas/categorie/jaar filteren client-side. Gemeentenaam wordt via de gedeelde geo-primitive (`utils/geo.ts`, ±8 km) naar een bbox omgezet.
- **Totaal**: het GeoJSON-antwoord bevat geen `numberMatched`; het totaal komt uit een aparte `resultType=hits`-call (kleine XML-respons) die parallel loopt en bij falen simpelweg het aantal opgehaalde features gebruikt.

## Kiesraad — Databank Verkiezingsuitslagen

- **Connector**: `verkiezingsuitslagen` (category `static`)
- **Tool**: `verkiezingsuitslagen_search`
- **Endpoints**: `https://www.verkiezingsuitslagen.nl/verkiezingen/detailJson/{code}` (landelijk + regio-index) en `/detailJson/{code}/{stemregioId}` (provincie/gemeente). De verkiezingenlijst wordt uit de server-rendered overzichtspagina `/verkiezingen` geparsed; een JSON-lijstendpoint bestaat niet.
- **Auth**: geen
- **Codes**: `TK`, `EK`, `EP`, `GR`, `PS`, `WS`, `ER`, `KC` + datum, bv. `TK20251029`.
- **Velden**: per partij stemmen, percentage en zetels; per gebied kiesgerechtigden, opkomst(percentage), geldige/blanco/ongeldige stemmen. Kiesraad levert Nederlandse getalnotatie (`1.790.634`, `16,94%`); de connector zet die om naar echte getallen.
- **Beperking**: de databank gaat tot gemeenteniveau. Uitslagen per stembureau en voorkeurstemmen per kandidaat staan als bestanden op data.overheid.nl en zitten niet in deze tool.

## EUR-Lex / CELLAR (EU-wetgeving)

- **Connector**: `eu_cellar` (category `static`)
- **Tools**: `eurlex_search`, `eurlex_document`, `eurlex_nl_omzetting`
- **Endpoint**: `https://publications.europa.eu/webapi/rdf/sparql` (CELLAR, Publicatiebureau van de EU)
- **Auth**: geen
- **Gedrag**: exacte CELEX-lookups en Virtuoso free-text (`bif:contains`) op titels; `FILTER(CONTAINS/REGEX)` scant het hele corpus (>10 s) en wordt niet gebruikt. Citaten (`Verordening (EU) 2016/679`, `Richtlijn 95/46/EG`) worden lokaal naar CELEX genormaliseerd; een zoekterm die alleen een documentnummer is ('2016/679') wordt een `VALUES`-lookup op de kandidaat-CELEX-nummers (verordening, richtlijn en besluit; vóór 2015 nummer/jaar), aangevuld met titels die dat nummer citeren. Wijzigings- en intrekkingshandelingen en HvJ-arresten komen uit de CELLAR-relaties van de handeling. Omzettingsmaatregelen komen uit de CELLAR-metadata van de richtlijn, gefilterd op Nederland.
- **Links**: `eurlex_url` (`https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=CELEX:<celex>`) en `cellar_url` (`https://publications.europa.eu/resource/celex/<celex>`).
- **Licentie/bronvermelding**: EUR-Lex-inhoud is herbruikbaar met bronvermelding; alleen de elektronische editie van het Publicatieblad van de EU is authentiek.

## LiDO — Linked Data Overheid (verwijzingen)

- **Connector**: `lido` (category `semi_live`)
- **Tools**: `lido_verwijzingen` (tellingen), `lido_verwijzingen_lijst` (de gekoppelde documenten)
- **Endpoints**: `https://linkeddata.overheid.nl/service/get-id` en `/service/get-aantal-per-informatietype` (publieke services), plus `/service/get-links?output=xml` voor de lijst (KOOP/Logius, XML)
- **Auth**: geen voor de publieke services. `get-links` staat bij LiDO onder "Niet-publieke services", maar LiDO dwingt geen account af (sept. 2026: zonder, met juiste en met onjuiste inloggegevens allemaal HTTP 200). Optioneel `LIDO_USERNAME` + `LIDO_PASSWORD`: alleen als beide gezet zijn gaat HTTP Basic auth mee, en uitsluitend op `get-links`. `/sparql` wordt niet gebruikt (weigert Basic auth).
- **Invoer**: ECLI, BWB-id (+ artikel), CELEX of OEP-publicatie (`stb-2018-401`, `stcrt-2024-20264`).
- **Gedrag**: tellingen komen uit `get-aantal-per-informatietype`; de lijst uit `get-links` met `start` (0-based offset) en `rows` (max. 100; LiDO valt daarboven stil terug op 20). Het totaal is de som van de `obj_type`-facetten; LiDO telt en pagineert per verwijzing, dus een document met meerdere verwijzingen staat meermaals in de upstream-lijst (de tool toont het per pagina één keer). Het typefilter gebruikt LiDO's eigen syntax `fq={!tag=obj_type}obj_type:"<type>"` (ongedocumenteerd voor `get-links`, wel door LiDO zelf gebruikt in portaal-URL's). Een onbekend ext-id geeft bij `get-links` een lege HTTP 400; dat wordt pas als "onbekend" gelezen na bevestiging via `get-aantal-per-informatietype`. Bij BWB gelden tellingen en lijst voor de meest recente versie.
- **Licentie**: CC0.

## Algoritmeregister (algoritmes.overheid.nl)

- **Connector**: `algoritmeregister` (category `other`, cache-TTL 10 minuten)
- **Tool**: `algoritmeregister_search`
- **Endpoints**: `POST https://algoritmes.overheid.nl/api/algoritme/NLD` (zoeken, JSON-body met `searchtext`, `organisation`, `include_children`, `status`, `publicationcategory`, `category`, `organisationtype`, `page`, `limit`), `/api/organisation/NLD` (organisaties op naam), `/api/organisation-relation/{org_id}` en `/api/organisation/{code}`, `/api/suggestion/NLD/{tekst}` (exacte treffers, om fuzzy resultaten te herkennen)
- **Auth**: geen (open API van het ministerie van BZK; OpenAPI op `https://algoritmes.overheid.nl/api/openapi.json`)
- **Gedrag**: het `organisation`-filter accepteert alleen het eigen `org_id` van het register (`gm0344`), dus een organisatienaam wordt eerst opgezocht; een niet-eenduidige naam levert kandidaten in plaats van resultaten. `limit` is maximaal 100 (hoger geeft HTTP 422). Zonder exacte treffers antwoordt het register met een fuzzy zoekopdracht die dat niet aangeeft; de connector stelt dat vast met de suggestie-endpoint en meldt het. Het register bevat alleen wat organisaties zelf publiceren.
