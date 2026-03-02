# Sources

## data.overheid.nl
- CKAN action API
- endpoints: `package_search`, `package_show`, `organization_list`, `group_list`

## CBS
- Primary: `https://odata4.cbs.nl/CBS`
- Fallback: `https://opendata.cbs.nl/ODataApi/OData`

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
