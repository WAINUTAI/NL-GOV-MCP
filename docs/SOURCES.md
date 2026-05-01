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
- Base configured as `https://opendata.rijksoverheid.nl/v1`
- adapters target `/search` and `/dossiers`

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
