import { beforeEach, describe, expect, it, vi } from "vitest";
import { RijkswaterstaatWaterdataSource } from "../src/sources/rijkswaterstaat-waterdata.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import type { AppConfig } from "../src/types.js";

const config: AppConfig = {
  server: { name: "nl-gov-mcp", version: "0.1.0", httpPort: 3333 },
  temporal: { defaultTimeZone: "Europe/Amsterdam" },
  cacheTtlMs: {
    default: 0,
    cbsCatalog: 0,
    tkEntityLists: 0,
    knmiObservations: 0,
    knmiHistorical: 0,
    dataOverheidDatasetList: 0,
    rijksoverheidLists: 0,
  },
  limits: { defaultRows: 25, maxRows: 200 },
  endpoints: {
    dataOverheid: "https://data.overheid.nl/data/api/3/action",
    cbsV4: "https://odata4.cbs.nl/CBS",
    cbsV3: "https://opendata.cbs.nl/ODataApi/OData",
    tweedeKamer: "https://gegevensmagazijn.tweedekamer.nl/OData/v4/2.0",
    bekendmakingenSru: "https://repository.overheid.nl/sru",
    rijksoverheid: "https://opendata.rijksoverheid.nl/v1",
    knmi: "https://api.dataplatform.knmi.nl/open-data/v1",
    rijksbegroting: "https://opendata.rijksbegroting.nl",
    duoDatasets: "https://onderwijsdata.duo.nl",
    duoRio: "https://lod.onderwijsregistratie.nl/rio-api",
    apiRegister: "https://apis.developer.overheid.nl",
  },
};

const CATALOG_URL =
  "https://ddapi20-waterwebservices.rijkswaterstaat.nl/METADATASERVICES/OphalenCatalogus";

// Fake catalog: WATHTE mapped to hoekvanholland, Q to lobith, Hm0 to someplace.
const FAKE_CATALOG = {
  Succesvol: true,
  AquoMetadataLijst: [
    {
      AquoMetadata_MessageID: 248,
      Parameter_Wat_Omschrijving: "Waterhoogte Oppervlaktewater t.o.v. NAP in cm",
      Grootheid: { Code: "WATHTE", Omschrijving: "Waterhoogte" },
      Eenheid: { Code: "cm", Omschrijving: "centimeter" },
      Hoedanigheid: { Code: "NAP", Omschrijving: "t.o.v. Normaal Amsterdams Peil" },
    },
    {
      AquoMetadata_MessageID: 300,
      Parameter_Wat_Omschrijving: "Debiet in m3/s",
      Grootheid: { Code: "Q", Omschrijving: "Debiet" },
      Eenheid: { Code: "m3/s", Omschrijving: "kubieke meter per seconde" },
      Hoedanigheid: { Code: "NVT", Omschrijving: "niet van toepassing" },
    },
    {
      AquoMetadata_MessageID: 400,
      Parameter_Wat_Omschrijving: "Significante golfhoogte in cm",
      Grootheid: { Code: "Hm0", Omschrijving: "Significante golfhoogte" },
      Eenheid: { Code: "cm", Omschrijving: "centimeter" },
      Hoedanigheid: { Code: "NVT", Omschrijving: "niet van toepassing" },
    },
  ],
  LocatieLijst: [
    {
      Locatie_MessageID: 8248,
      Code: "hoekvanholland",
      Naam: "Hoek van Holland",
      Lat: 51.9769,
      Lon: 4.1198,
      Coordinatenstelsel: "ETRS89",
      Omschrijving: "Hoek van Holland",
    },
    {
      Locatie_MessageID: 9000,
      Code: "lobith",
      Naam: "Lobith",
      Lat: 51.8395,
      Lon: 6.1136,
      Coordinatenstelsel: "ETRS89",
      Omschrijving: "Lobith",
    },
    {
      Locatie_MessageID: 9200,
      Code: "someplace",
      Naam: "Someplace",
      Lat: 52.0,
      Lon: 5.0,
      Coordinatenstelsel: "ETRS89",
      Omschrijving: "Someplace test station",
    },
  ],
  AquoMetadataLocatieLijst: [
    // NB: capital "D" in AquoMetaData_MessageID (matches the connector's lookup).
    { AquoMetaData_MessageID: 248, Locatie_MessageID: 8248 },
    { AquoMetaData_MessageID: 300, Locatie_MessageID: 9000 },
    { AquoMetaData_MessageID: 400, Locatie_MessageID: 9200 },
  ],
};

const FAKE_LATEST = {
  Succesvol: true,
  WaarnemingenLijst: [
    {
      AquoMetadata: {
        Grootheid: { Code: "WATHTE", Omschrijving: "Waterhoogte" },
        Eenheid: { Code: "cm", Omschrijving: "centimeter" },
        Hoedanigheid: { Code: "NAP", Omschrijving: "t.o.v. Normaal Amsterdams Peil" },
      },
      Locatie: {
        Code: "hoekvanholland",
        Naam: "Hoek van Holland",
        Lat: 51.9769,
        Lon: 4.1198,
        Coordinatenstelsel: "ETRS89",
        Omschrijving: "Hoek van Holland",
      },
      MetingenLijst: [
        {
          Meetwaarde: { Waarde_Numeriek: 74.0, Waarde_Alfanumeriek: "74" },
          Tijdstip: "2026-07-03T18:10:00.000+01:00",
          WaarnemingMetadata: {
            Kwaliteitswaardecode: "00",
            Statuswaarde: "Ongecontroleerd",
            Referentievlak: "NAP",
          },
        },
      ],
    },
  ],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface Captured {
  catalogUrl?: string;
  catalogBody?: Record<string, unknown>;
  latestUrl?: string;
  latestBody?: Record<string, unknown>;
}

/**
 * Stub fetch so catalog and latest POSTs are routed by URL. The connector
 * makes TWO sequential POSTs during latestMeasurements (catalog, then latest);
 * request bodies are captured (parsed from the JSON string init.body).
 */
function installRwsFetch() {
  const captured: Captured = {};
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const bodyStr = typeof init?.body === "string" ? init.body : undefined;
    if (u.includes("/METADATASERVICES/OphalenCatalogus")) {
      captured.catalogUrl = u;
      captured.catalogBody = bodyStr
        ? (JSON.parse(bodyStr) as Record<string, unknown>)
        : undefined;
      return jsonResponse(FAKE_CATALOG);
    }
    if (u.includes("/OphalenLaatsteWaarnemingen")) {
      captured.latestUrl = u;
      captured.latestBody = bodyStr
        ? (JSON.parse(bodyStr) as Record<string, unknown>)
        : undefined;
      return jsonResponse(FAKE_LATEST);
    }
    throw new Error(`Unexpected fetch URL: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, captured };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function grootheidCode(body: Record<string, unknown> | undefined): unknown {
  return (body as any)?.AquoPlusWaarnemingMetadataLijst?.[0]?.AquoMetadata?.Grootheid?.Code;
}
function locatieLijst(body: Record<string, unknown> | undefined): any[] {
  return ((body as any)?.LocatieLijst as any[]) ?? [];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("RijkswaterstaatWaterdataSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("search() maps a catalog parameter and posts to the catalog endpoint", async () => {
    const { fetchMock } = installRwsFetch();
    const src = new RijkswaterstaatWaterdataSource(config);
    const out = await src.search({ query: "waterhoogte", rows: 10 });

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CATALOG_URL);

    expect(out.items).toHaveLength(1);
    const item = out.items[0];
    expect(item.id).toBe("248");
    expect(item.title).toContain("Waterhoogte");
    expect(item.category).toBe("Waterhoogte");
    expect(item.grootheid_code).toBe("WATHTE");
    expect(item.unit).toBe("cm");
  });

  it("latestMeasurements() resolves a named location and maps the observation", async () => {
    const { captured } = installRwsFetch();
    const src = new RijkswaterstaatWaterdataSource(config);
    const out = await src.latestMeasurements({
      query: "waterstand hoek van holland",
      rows: 10,
    });

    // (a) requested Grootheid code
    expect(grootheidCode(captured.latestBody)).toBe("WATHTE");

    // (b) LocatieLijst entry with coord mapping (X = Lon, Y = Lat)
    const loc = locatieLijst(captured.latestBody).find((l) => l.Code === "hoekvanholland");
    expect(loc).toBeDefined();
    expect(loc.X).toBe(4.1198);
    expect(loc.Y).toBe(51.9769);
    expect(loc.Coordinatenstelsel).toBe("ETRS89");

    // (c) mapped item
    const item = out.items[0];
    expect(item.location_name).toBe("Hoek van Holland");
    expect(item.value).toBe(74);
    expect(item.unit).toBe("cm");
    expect(item.timestamp).toBeTruthy();
    expect(item.quality).toBe("00");
    expect(item.status).toBe("Ongecontroleerd");
  });

  it("maps the golfhoogte keyword to Grootheid code Hm0 in the request body", async () => {
    const { captured } = installRwsFetch();
    const src = new RijkswaterstaatWaterdataSource(config);
    await src.latestMeasurements({ query: "golfhoogte someplace", rows: 10 });

    expect(grootheidCode(captured.latestBody)).toBe("Hm0");
  });

  it("falls back to a priority station when no location is given", async () => {
    const { captured } = installRwsFetch();
    const src = new RijkswaterstaatWaterdataSource(config);
    await src.latestMeasurements({ query: "waterstand", rows: 10 });

    const codes = locatieLijst(captured.latestBody).map((l) => l.Code);
    expect(codes.length).toBeGreaterThan(0);
    expect(codes).toContain("hoekvanholland");
  });
});
