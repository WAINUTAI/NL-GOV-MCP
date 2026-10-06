import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DsoInputError,
  DsoOmgevingsdocumentenSource,
  clearDsoCaches,
  documentLink,
  parseDsoIdentificatie,
} from "../src/sources/dso-omgevingsdocumenten.js";
import { registerTools } from "../src/tools.js";
import { clearHttpCache, getConnectorHealth } from "../src/utils/connector-runtime.js";
import { SourceRequestError } from "../src/utils/http.js";
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

const sampleResponse = {
  _embedded: {
    regelingen: [
      {
        identificatie: "/akn/nl/act/gm0344/2024/omgevingsplan-001",
        officieleTitel: "Omgevingsplan Utrecht",
        citeerTitel: "Omgevingsplan Utrecht 2024",
        type: { code: "/join/id/stop/regelingtype_002", waarde: "Omgevingsplan" },
        aangeleverdDoorEen: { naam: "gemeente Utrecht", bestuurslaag: "gemeentebestuur", code: "gm0344" },
        geregistreerdMet: {
          versie: 3,
          beginInwerking: "2024-01-01",
          beginGeldigheid: "2024-01-01",
          tijdstipRegistratie: "2024-01-01T00:00:00Z",
        },
        _links: { self: { href: "https://service.omgevingswet.overheid.nl/.../regelingen/abc" } },
      },
      {
        identificatie: "/akn/nl/act/pv24/2024/omgevingsvisie-001",
        officieleTitel: "Omgevingsvisie provincie Utrecht",
        type: { code: "/join/id/stop/regelingtype_001", waarde: "Omgevingsvisie" },
        aangeleverdDoorEen: { naam: "provincie Utrecht", bestuurslaag: "provinciebestuur", code: "pv24" },
        geregistreerdMet: {
          versie: 1,
          beginInwerking: "2023-06-01",
          beginGeldigheid: "2023-06-01",
          tijdstipRegistratie: "2023-06-01T00:00:00Z",
        },
        _links: { self: { href: "https://service.omgevingswet.overheid.nl/.../regelingen/def" } },
      },
    ],
  },
  page: { size: 20, totalElements: 2, totalPages: 1, number: 1 },
};

function mockFetchOnce(payload: unknown) {
  const fetchMock = vi.fn(async () => {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/hal+json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("DsoOmgevingsdocumentenSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("throws when API key is missing", async () => {
    const src = new DsoOmgevingsdocumentenSource(config);
    await expect(src.search({ rows: 5 })).rejects.toThrow(/DSO_API_KEY/);
  });

  it("uses GET /regelingen and forwards x-api-key when no bevoegd-gezag filter", async () => {
    const fetchMock = mockFetchOnce(sampleResponse);
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    const out = await src.search({ rows: 11 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/presenteren/v8/regelingen");
    expect(url).not.toContain("/_zoek");
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");

    expect(out.items).toHaveLength(2);
    expect(out.items[0].title).toBe("Omgevingsplan Utrecht");
    expect(out.items[0].documentType).toBe("Omgevingsplan");
    expect(out.items[0].bevoegdGezag).toBe("gemeente Utrecht");
    expect(out.items[0].bevoegdGezagCode).toBe("gm0344");
    expect(out.items[0].viewerUrl).toContain("regels-op-de-kaart/viewer");
    expect(out.total).toBe(2);
  });

  it("POSTs to /regelingen/_zoek when bevoegd-gezag filter is provided", async () => {
    const fetchMock = mockFetchOnce(sampleResponse);
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    await src.search({ rows: 12, typeBevoegdGezag: "gemeente", bevoegdGezag: "gm0344" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/regelingen/_zoek");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.typeBevoegdGezag).toEqual(["gemeente"]);
    expect(body.bevoegdGezag).toEqual(["gm0344"]);
  });

  it("filters client-side by documentType (case-insensitive substring on type.waarde)", async () => {
    mockFetchOnce(sampleResponse);
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    const out = await src.search({ rows: 13, documentType: "omgevingsvisie" });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].documentType).toBe("Omgevingsvisie");
  });

  it("filters client-side by free-text query against title and bevoegd-gezag fields", async () => {
    mockFetchOnce(sampleResponse);
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    const out = await src.search({ rows: 14, query: "provincie utrecht" });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].bevoegdGezag).toBe("provincie Utrecht");
  });

  it("returns total from page.totalElements when present", async () => {
    mockFetchOnce({ ...sampleResponse, page: { ...sampleResponse.page, totalElements: 4711 } });
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    const out = await src.search({ rows: 15 });

    expect(out.total).toBe(4711);
  });
});

/* ------------------------------------------------------------------ */
/*  Locatie, names, catalogue, ontwerp, links, text                    */
/* ------------------------------------------------------------------ */

const DSO = "https://service.omgevingswet.overheid.nl/publiek/omgevingsdocumenten/api/presenteren/v8";
const RD_CRS = "http://www.opengis.net/def/crs/EPSG/0/28992";

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

/** Answer every fetch with `handler`; returns the calls made, in order. */
function mockDso(handler: (call: Call) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const call: Call = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const out = handler(call);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/hal+json" } });
    }),
  );
  return calls;
}

const TYPES: Record<string, string> = {
  Omgevingsplan: "/join/id/stop/regelingtype_003",
  Omgevingsvisie: "/join/id/stop/regelingtype_006",
  Programma: "/join/id/stop/regelingtype_010",
  Omgevingsverordening: "/join/id/stop/regelingtype_004",
  Waterschapsverordening: "/join/id/stop/regelingtype_005",
  Voorbeschermingsregels: "/join/id/stop/regelingtype_009",
  "Voorbeschermingsregels Omgevingsplan": "/join/id/stop/regelingtype_015",
  AMvB: "/join/id/stop/regelingtype_001",
};

function regeling(code: string, naam: string, type: string, identificatie: string, title: string, beginGeldigheid: string) {
  const bestuurslaag = code.startsWith("gm") ? "gemeente" : code.startsWith("pv") ? "provincie" : code.startsWith("ws") ? "waterschap" : "ministerie";
  return {
    identificatie,
    officieleTitel: title,
    type: { code: TYPES[type], waarde: type },
    aangeleverdDoorEen: { naam, bestuurslaag, code },
    geregistreerdMet: { beginGeldigheid, beginInwerking: beginGeldigheid, tijdstipRegistratie: `${beginGeldigheid}T09:00:00Z`, versie: 1 },
    _links: { self: { href: `${DSO}/regelingen/${identificatie.replace(/\//g, "_")}` } },
  };
}

const OMGEVINGSPLAN_UTRECHT = regeling("gm0344", "gemeente Utrecht", "Omgevingsplan", "/akn/nl/act/gm0344/2020/omgevingsplan", "Omgevingsplan gemeente Utrecht", "2026-09-18");
const DAKKAPELLEN = regeling("gm0344", "gemeente Utrecht", "Voorbeschermingsregels Omgevingsplan", "/akn/nl/act/gm0344/2026/Regelinga44d27cdbfa1498d847f11d6696e2cde", "Voorbereidingsbesluit dakkapellen zijkant en achterkant van woningen", "2026-10-03");
const ACTIEPLAN_GELUID = regeling("gm0344", "gemeente Utrecht", "Programma", "/akn/nl/act/gm0344/2026/Regelingf30063b6af59436d9592ddb988eb8352", "Actieplan Geluid en Trillingen gemeente Utrecht", "2026-06-24");
const VISIE_PV26 = regeling("pv26", "provincie Utrecht", "Omgevingsvisie", "/akn/nl/act/pv26/2023/omgevingsvisie", "Omgevingsvisie provincie Utrecht", "2024-01-01");
const VERORDENING_PV26 = regeling("pv26", "provincie Utrecht", "Omgevingsverordening", "/akn/nl/act/pv26/2022/omgevingsverordening", "Omgevingsverordening provincie Utrecht", "2025-10-13");
const WSV_HDSR = regeling("ws0636", "Hoogheemraadschap De Stichtse Rijnlanden", "Waterschapsverordening", "/akn/nl/act/ws0636/2023/HDSRWSV", "Waterschapsverordening Hoogheemraadschap De Stichtse Rijnlanden", "2026-05-20");
const OMGEVINGSWET = regeling("mnre1034", "ministerie van Binnenlandse Zaken en Koninkrijksrelaties", "AMvB", "/akn/nl/act/mnre1034/2020/regOW01", "Omgevingswet", "2020-08-01");
const BAL = regeling("mnre1034", "ministerie van Binnenlandse Zaken en Koninkrijksrelaties", "AMvB", "/akn/nl/act/mnre1034/2018/BWBR0041330", "Besluit activiteiten leefomgeving", "2026-10-01");
const NOVI = regeling("mnre1034", "ministerie van Binnenlandse Zaken en Koninkrijksrelaties", "Omgevingsvisie", "/akn/nl/act/mnre1034/2023/NOVI011", "Nationale Omgevingsvisie", "2021-02-23");
const VISIE_HEUVELRUG = regeling("gm1581", "gemeente Utrechtse Heuvelrug", "Omgevingsvisie", "/akn/nl/act/gm1581/2022/omgevingsvisie", "Omgevingsvisie Utrechtse Heuvelrug", "2022-07-01");
const PLAN_BERGEN_NH = regeling("gm0373", "gemeente Bergen (NH)", "Omgevingsplan", "/akn/nl/act/gm0373/2020/omgevingsplan", "Omgevingsplan gemeente Bergen NH", "2024-08-15");
const PLAN_BERGEN_L = regeling("gm0893", "gemeente Bergen (L)", "Omgevingsplan", "/akn/nl/act/gm0893/2020/omgevingsplan", "Omgevingsplan gemeente Bergen (L)", "2024-05-01");

const CATALOGUE = [OMGEVINGSPLAN_UTRECHT, DAKKAPELLEN, ACTIEPLAN_GELUID, VISIE_PV26, VERORDENING_PV26, WSV_HDSR, OMGEVINGSWET, BAL, NOVI, VISIE_HEUVELRUG, PLAN_BERGEN_NH, PLAN_BERGEN_L];

/** GET /regelingen as the DSO pages it: `size` per page, `page` from 1. */
function cataloguePage(call: Call, items: unknown[], key: "regelingen" | "ontwerpregelingen" = "regelingen") {
  const size = Number(call.url.searchParams.get("size") ?? 20);
  const page = Number(call.url.searchParams.get("page") ?? 1);
  return {
    _embedded: { [key]: items.slice((page - 1) * size, page * size) },
    page: { number: page, size, totalElements: items.length, totalPages: Math.ceil(items.length / size) },
  };
}

function zoekPage(items: unknown[], key: "regelingen" | "ontwerpregelingen" = "regelingen") {
  return { _embedded: { [key]: items }, page: { number: 1, size: 200, totalElements: items.length, totalPages: 1 } };
}

describe("DSO bevoegd gezag: codes and names", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearDsoCaches();
    clearHttpCache();
  });

  /** The catalogue for name resolution, then the bevoegd gezag's documents. */
  function namesAndZoek(): Call[] {
    return mockDso((call) => {
      if (call.method === "GET" && call.url.pathname.endsWith("/regelingen")) return cataloguePage(call, CATALOGUE);
      const code = (call.body?.bevoegdGezag as string[] | undefined)?.[0];
      return zoekPage(CATALOGUE.filter((x) => x.aangeleverdDoorEen.code === code));
    });
  }

  it("sends a code in any case as one _zoek request of 200, without the catalogue", async () => {
    const calls = mockDso(() => zoekPage([ACTIEPLAN_GELUID, OMGEVINGSPLAN_UTRECHT, DAKKAPELLEN]));
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ bevoegdGezag: "GM0344", rows: 2 });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toMatch(/\/regelingen\/_zoek$/);
    expect(calls[0].url.searchParams.get("size")).toBe("200");
    expect(calls[0].body).toEqual({ bevoegdGezag: ["gm0344"] });
    // Newest first, then sliced to rows; total is the DSO's own count.
    expect(out.items.map((x) => x.title)).toEqual([DAKKAPELLEN.officieleTitel, OMGEVINGSPLAN_UTRECHT.officieleTitel]);
    expect(out.total).toBe(3);
    expect(out.scope).toBe("bevoegd_gezag");
  });

  it("reads a bare place name as the gemeente and names the provincie as alternative", async () => {
    const calls = namesAndZoek();
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ bevoegdGezag: "Utrecht", rows: 20 });

    const zoek = calls.find((c) => c.method === "POST");
    expect(zoek?.body).toEqual({ bevoegdGezag: ["gm0344"] });
    expect(out.bevoegdGezag).toEqual({ code: "gm0344", naam: "gemeente Utrecht" });
    expect(out.access_note).toContain("opgevat als gemeente Utrecht (gm0344)");
    expect(out.access_note).toContain("provincie Utrecht (pv26)");
    expect(out.items).toHaveLength(3);
  });

  it("takes the provincie from the name or from typeBevoegdGezag", async () => {
    const calls = namesAndZoek();
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    const named = await src.search({ bevoegdGezag: "provincie utrecht", rows: 20 });
    const typed = await src.search({ bevoegdGezag: "Utrecht", typeBevoegdGezag: "provincie", rows: 20 });

    expect(named.bevoegdGezag?.code).toBe("pv26");
    expect(typed.bevoegdGezag?.code).toBe("pv26");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
      { bevoegdGezag: ["pv26"] },
      { bevoegdGezag: ["pv26"], typeBevoegdGezag: ["provincie"] },
    ]);
    // The catalogue is fetched once and kept.
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("finds a waterschap by its name with or without the layer word", async () => {
    namesAndZoek();
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    for (const name of ["De Stichtse Rijnlanden", "Hoogheemraadschap De Stichtse Rijnlanden", "stichtse rijnlanden"]) {
      const out = await src.search({ bevoegdGezag: name, rows: 5 });
      expect(out.bevoegdGezag?.code).toBe("ws0636");
      expect(out.items[0].title).toBe(WSV_HDSR.officieleTitel);
    }
  });

  it("refuses a name that fits several gemeenten and lists them", async () => {
    namesAndZoek();
    const err = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ bevoegdGezag: "Bergen", rows: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(DsoInputError);
    expect(err.message).toContain("gm0373");
    expect(err.message).toContain("gm0893");
  });

  it("suggests close names for an unknown one", async () => {
    namesAndZoek();
    const err = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ bevoegdGezag: "Utrect", rows: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(DsoInputError);
    expect(err.suggestion).toContain("gemeente Utrecht (gm0344)");
    expect(err.suggestion).toContain("provincie Utrecht (pv26)");
  });
});

describe("DSO catalogue search", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearDsoCaches();
    clearHttpCache();
  });

  it("pages through the whole catalogue for a query and matches every word, whole", async () => {
    // 450 regelingen: three pages of 200; the provincie's omgevingsvisie is on the last.
    const filler = Array.from({ length: 440 }, (_, i) =>
      regeling("gm0001", "gemeente Voorbeeld", "Programma", `/akn/nl/act/gm0001/2024/p${i}`, `Programma ${i}`, "2024-01-01"),
    );
    const items = [...filler, VISIE_HEUVELRUG, NOVI, VISIE_PV26];
    const calls = mockDso((call) => cataloguePage(call, items));

    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ query: "omgevingsvisie Utrecht", rows: 20 });

    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(calls.every((c) => c.url.searchParams.get("size") === "200" && c.url.searchParams.get("_sort") === "identificatie")).toBe(true);
    // "Utrechtse Heuvelrug" is no whole-word "Utrecht"; the NOVI has no "Utrecht".
    expect(out.items.map((x) => x.title)).toEqual(["Omgevingsvisie provincie Utrecht"]);
    expect(out.total).toBe(1);
    expect(out.scope).toBe("catalogus");
    expect(out.access_note).toContain("volledige DSO-catalogus (443 regelingen");
  });

  it("falls back to parts of words when no document has the whole words", async () => {
    mockDso((call) => cataloguePage(call, CATALOGUE));
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ query: "visie heuvelrug", rows: 20 });
    expect(out.items.map((x) => x.title)).toEqual(["Omgevingsvisie Utrechtse Heuvelrug"]);
    expect(out.access_note).toContain("deel van een woord");
  });

  it("matches documentType exactly: an omgevingsplan is no voorbereidingsbesluit", async () => {
    mockDso((call) => (call.method === "POST" ? zoekPage([DAKKAPELLEN, OMGEVINGSPLAN_UTRECHT, ACTIEPLAN_GELUID]) : cataloguePage(call, CATALOGUE)));
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");

    const plan = await src.search({ bevoegdGezag: "gm0344", documentType: "omgevingsplan", rows: 20 });
    expect(plan.items.map((x) => x.documentType)).toEqual(["Omgevingsplan"]);
    expect(plan.total).toBe(1);

    const besluit = await src.search({ bevoegdGezag: "gm0344", documentType: "voorbereidingsbesluit", rows: 20 });
    expect(besluit.items.map((x) => x.documentType)).toEqual(["Voorbeschermingsregels Omgevingsplan"]);

    const waterschap = await src.search({ documentType: "waterschapsverordening", rows: 20 });
    expect(waterschap.items.map((x) => x.bevoegdGezagCode)).toEqual(["ws0636"]);
  });

  it("filters the catalogue on typeBevoegdGezag and passes geldigOp", async () => {
    const calls = mockDso((call) => cataloguePage(call, CATALOGUE));
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ typeBevoegdGezag: "provincie", geldigOp: "2025-01-01", rows: 20 });
    expect(out.items.map((x) => x.bevoegdGezagCode)).toEqual(["pv26", "pv26"]);
    expect(calls[0].url.searchParams.get("geldigOp")).toBe("2025-01-01");
  });
});

describe("DSO locatie", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearDsoCaches();
    clearHttpCache();
  });

  const BRENNERBAAN = { weergavenaam: "Brennerbaan 150, 3524BN Utrecht", type: "adres", centroide_rd: "POINT(138180.745 453109.293)" };

  it("geocodes the address and posts its RD point with Content-Crs, gemeente to Rijk", async () => {
    const calls = mockDso((call) => {
      if (call.url.hostname === "api.pdok.nl") return { response: { numFound: 1, docs: [BRENNERBAAN] } };
      return zoekPage([OMGEVINGSWET, VISIE_PV26, BAL, OMGEVINGSPLAN_UTRECHT, WSV_HDSR, DAKKAPELLEN, NOVI, VERORDENING_PV26]);
    });
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ locatie: "Brennerbaan 150, Utrecht", rows: 20 });

    expect(calls[0].url.hostname).toBe("api.pdok.nl");
    expect(calls[0].url.searchParams.get("q")).toBe("Brennerbaan 150, Utrecht");
    const zoek = calls[1];
    expect(zoek.url.pathname).toMatch(/\/regelingen\/_zoek$/);
    expect(zoek.body).toEqual({ geometrie: { type: "Point", coordinates: [138180.745, 453109.293] } });
    expect(zoek.headers["Content-Crs"]).toBe(RD_CRS);

    // Gemeente, waterschap, provincie, Rijk; newest first within each.
    expect(out.items.map((x) => x.bevoegdGezagCode)).toEqual(["gm0344", "gm0344", "ws0636", "pv26", "pv26", "mnre1034", "mnre1034", "mnre1034"]);
    expect(out.items[0].title).toBe(DAKKAPELLEN.officieleTitel);
    expect(out.items.slice(5).map((x) => x.title)).toEqual(["Besluit activiteiten leefomgeving", "Nationale Omgevingsvisie", "Omgevingswet"]);
    expect(out.total).toBe(8);
    expect(out.access_note).toContain("Brennerbaan 150, 3524BN Utrecht");
    expect(out.access_note).toContain("RD 138180.745, 453109.293");
  });

  it("returns an error, not an empty success, when the address is not found", async () => {
    mockDso(() => ({ response: { numFound: 0, docs: [] } }));
    const err = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ locatie: "Nergensstraat 1, Nergenshuizen", rows: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(DsoInputError);
    expect(err.message).toContain("Nergensstraat 1, Nergenshuizen");
    expect(err.suggestion).toContain("Brennerbaan 150, Utrecht");
  });

  it("does not accept a fuzzy hit that shares only the house number", async () => {
    mockDso(() => ({ response: { docs: [{ weergavenaam: "Hoeverweg 99999G, Egmond aan den Hoef", type: "adres", centroide_rd: "POINT(108502.74 517351.14)" }] } }));
    const err = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ locatie: "Xyzzystraat 99999 Nergenshuizen", rows: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(DsoInputError);
  });

  it("accepts a postcode with house number", async () => {
    mockDso((call) => (call.url.hostname === "api.pdok.nl" ? { response: { docs: [BRENNERBAAN] } } : zoekPage([OMGEVINGSPLAN_UTRECHT])));
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ locatie: "3524 BN 150", rows: 5 });
    expect(out.locatie?.weergavenaam).toBe("Brennerbaan 150, 3524BN Utrecht");
    expect(out.items).toHaveLength(1);
  });
});

describe("DSO ontwerpregelingen", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearDsoCaches();
    clearHttpCache();
  });

  function ontwerp(code: string, naam: string, type: string, act: string, bill: string, bekendOp: string, begin?: string, einde?: string) {
    const stappen = [
      { soortStap: { waarde: "Vaststelling" }, voltooidOp: bekendOp },
      { soortStap: { waarde: "Publicatie" }, voltooidOp: bekendOp },
      ...(begin ? [{ soortStap: { waarde: "Begin inzagetermijn" }, voltooidOp: begin }] : []),
      ...(einde ? [{ soortStap: { waarde: "Einde inzagetermijn" }, voltooidOp: einde }] : []),
    ];
    return {
      identificatie: act,
      technischId: `${act}${bill}`.replace(/\//g, "_"),
      ontwerpbesluitIdentificatie: bill,
      officieleTitel: `${type} ${naam}`,
      type: { code: TYPES[type], waarde: type },
      aangeleverdDoorEen: { naam, bestuurslaag: "provincie", code },
      geregistreerdMet: { versie: 1, tijdstipRegistratie: `${bekendOp}T08:00:00Z` },
      procedureverloop: { bekendOp, procedurestappen: stappen },
    };
  }

  const OPEN = ontwerp("pv26", "provincie Utrecht", "Omgevingsverordening", "/akn/nl/act/pv26/2022/omgevingsverordening", "/akn/nl/bill/pv26/2026/3_1200", "2026-09-28", "2026-09-29", "2026-11-09");
  const CLOSED = ontwerp("pv26", "provincie Utrecht", "Omgevingsvisie", "/akn/nl/act/pv26/2023/omgevingsvisie", "/akn/nl/bill/pv26/2025/1_1093", "2026-01-05", "2026-01-06", "2026-02-16");
  const ENDS_TODAY = ontwerp("pv26", "provincie Utrecht", "Programma", "/akn/nl/act/pv26/2025/2_49", "/akn/nl/bill/pv26/2026/2_1098", "2026-08-25", "2026-08-26", "2026-10-06");

  it("keeps one record per ontwerpbesluit, newest first, with its inzagetermijn and link", async () => {
    const calls = mockDso(() => zoekPage([CLOSED, OPEN, ENDS_TODAY, OPEN], "ontwerpregelingen"));
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ soort: "ontwerpregelingen", bevoegdGezag: "pv26", rows: 20, today: "2026-10-06" });

    expect(calls[0].url.pathname).toMatch(/\/ontwerpregelingen\/_zoek$/);
    expect(out.items.map((x) => x.ontwerpbesluitIdentificatie)).toEqual(["/akn/nl/bill/pv26/2026/3_1200", "/akn/nl/bill/pv26/2026/2_1098", "/akn/nl/bill/pv26/2025/1_1093"]);
    const [open, endsToday, closed] = out.items;
    expect(open).toMatchObject({ soort: "ontwerpregeling", bekendOp: "2026-09-28", beginInzagetermijn: "2026-09-29", eindeInzagetermijn: "2026-11-09", terInzage: true });
    expect(open.technischId).toBe("_akn_nl_act_pv26_2022_omgevingsverordening_akn_nl_bill_pv26_2026_3_1200");
    expect(open.documentUrl).toBe("https://identifier.overheid.nl/akn/nl/bill/pv26/2026/3_1200");
    expect(open.documentUrlType).toBe("officiele_bekendmakingen");
    // The last day of the inzagetermijn still counts.
    expect(endsToday.terInzage).toBe(true);
    expect(closed.terInzage).toBe(false);
  });

  it("alleen_ter_inzage searches the whole ontwerp catalogue for open ones", async () => {
    const calls = mockDso((call) => cataloguePage(call, [CLOSED, OPEN, ENDS_TODAY], "ontwerpregelingen"));
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ alleenTerInzage: true, rows: 20, today: "2026-10-06" });

    expect(calls[0].url.pathname).toMatch(/\/ontwerpregelingen$/);
    expect(out.items.map((x) => x.terInzage)).toEqual([true, true]);
    expect(out.total).toBe(2);
  });
});

describe("DSO document links and identifiers", () => {
  it("links each layer to its readable text", () => {
    expect(documentLink(OMGEVINGSPLAN_UTRECHT)).toEqual({ url: "https://identifier.overheid.nl/akn/nl/act/gm0344/2020/omgevingsplan", type: "lokale_regelgeving" });
    expect(documentLink(VISIE_PV26).url).toBe("https://identifier.overheid.nl/akn/nl/act/pv26/2023/omgevingsvisie");
    expect(documentLink(WSV_HDSR).url).toBe("https://identifier.overheid.nl/akn/nl/act/ws0636/2023/HDSRWSV");
    expect(documentLink(BAL)).toEqual({ url: "https://wetten.overheid.nl/BWBR0041330", type: "wetten_overheid" });
    expect(documentLink(OMGEVINGSWET).url).toBe("https://wetten.overheid.nl/BWBR0037885");
    // A Rijk regeling without a known text page: Regels op de kaart, not a link that does not resolve.
    expect(documentLink(NOVI)).toEqual({ url: "https://omgevingswet.overheid.nl/regels-op-de-kaart", type: "regels_op_de_kaart" });
  });

  it("reads every identifier form the text tool accepts", () => {
    expect(parseDsoIdentificatie("/akn/nl/act/gm0344/2020/omgevingsplan")).toEqual({ kind: "regeling", uriIdentificatie: "_akn_nl_act_gm0344_2020_omgevingsplan", identificatie: "/akn/nl/act/gm0344/2020/omgevingsplan" });
    expect(parseDsoIdentificatie("_akn_nl_act_gm0344_2020_omgevingsplan")).toEqual({ kind: "regeling", uriIdentificatie: "_akn_nl_act_gm0344_2020_omgevingsplan" });
    expect(parseDsoIdentificatie("https://identifier.overheid.nl/akn/nl/act/gm0344/2020/omgevingsplan/nld@2026-08-19;09031012")).toMatchObject({ kind: "regeling", uriIdentificatie: "_akn_nl_act_gm0344_2020_omgevingsplan" });
    expect(parseDsoIdentificatie("_akn_nl_act_pv26_2024_2_37_1074_akn_nl_bill_pv26_2024_2_1074")).toEqual({ kind: "ontwerpregeling", technischId: "_akn_nl_act_pv26_2024_2_37_1074_akn_nl_bill_pv26_2024_2_1074" });
    expect(parseDsoIdentificatie("/akn/nl/bill/pv26/2024/2_1074")).toEqual({ kind: "ontwerpbesluit", ontwerpbesluitIdentificatie: "/akn/nl/bill/pv26/2024/2_1074" });
    expect(parseDsoIdentificatie("https://lokaleregelgeving.overheid.nl/CVDR696280/7")).toBeUndefined();
    expect(parseDsoIdentificatie("omgevingsplan Utrecht")).toBeUndefined();
  });
});

describe("DSO document text", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearDsoCaches();
    clearHttpCache();
  });

  const STRUCTUUR = {
    _embedded: {
      documentComponenten: [
        {
          identificatie: "body",
          expressie: "body",
          type: "LICHAAM",
          volgordeNummer: 0,
          _embedded: {
            documentComponenten: [
              {
                identificatie: "gm0344_x__chp_1__art_1.1",
                expressie: "chp_1__art_1.1",
                type: "ARTIKEL",
                volgordeNummer: 0,
                kop: "<Kop><Label>Artikel</Label><Nummer>1.1</Nummer><Opschrift>Dakkapellen</Opschrift></Kop>",
                inhoud: "<Inhoud><Al>Een dakkapel heeft een plat dak.</Al></Inhoud>",
              },
            ],
          },
        },
      ],
    },
  };

  it("fetches the documentstructuur by uriIdentificatie and keeps the parsed document", async () => {
    const calls = mockDso((call) => (call.url.pathname.endsWith("/documentstructuur") ? STRUCTUUR : DAKKAPELLEN));
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    const first = await src.documentText({ identificatie: "/akn/nl/act/gm0344/2026/Regelinga44d27cdbfa1498d847f11d6696e2cde" });
    const second = await src.documentText({ identificatie: "_akn_nl_act_gm0344_2026_Regelinga44d27cdbfa1498d847f11d6696e2cde" });

    const structuur = calls.filter((c) => c.url.pathname.endsWith("/documentstructuur"));
    expect(structuur).toHaveLength(1);
    expect(structuur[0].url.pathname).toBe("/publiek/omgevingsdocumenten/api/presenteren/v8/regelingen/_akn_nl_act_gm0344_2026_Regelinga44d27cdbfa1498d847f11d6696e2cde/documentstructuur");
    expect(first.doc.sections.map((s) => s.heading)).toContain("Artikel 1.1 Dakkapellen");
    expect(first.item?.title).toBe(DAKKAPELLEN.officieleTitel);
    expect(second.doc).toBe(first.doc);
  });

  it("reads an ontwerp through its technischId and leaves geldigOp out", async () => {
    const calls = mockDso((call) => (call.url.pathname.endsWith("/documentstructuur") ? STRUCTUUR : { ...VISIE_PV26, technischId: "_akn_nl_act_pv26_2023_omgevingsvisie_akn_nl_bill_pv26_2025_1_1093", ontwerpbesluitIdentificatie: "/akn/nl/bill/pv26/2025/1_1093" }));
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").documentText({ identificatie: "_akn_nl_act_pv26_2023_omgevingsvisie_akn_nl_bill_pv26_2025_1_1093", geldigOp: "2025-01-01" });

    expect(out.kind).toBe("ontwerpregeling");
    expect(calls.every((c) => c.url.pathname.includes("/ontwerpregelingen/_akn_nl_act_pv26_2023_omgevingsvisie_akn_nl_bill_pv26_2025_1_1093"))).toBe(true);
    expect(calls.every((c) => !c.url.searchParams.has("geldigOp"))).toBe(true);
    expect(out.access_note).toContain("geldigOp");
  });

  it("turns a 404 into a clear error", async () => {
    mockDso(() => new Response("{}", { status: 404 }));
    const err = await new DsoOmgevingsdocumentenSource(config, "test-key").documentText({ identificatie: "_akn_nl_act_gm0344_2099_bestaatniet" }).catch((e) => e);
    expect(err).toBeInstanceOf(DsoInputError);
    expect(err.message).toContain("niet gevonden");
  });
});

import { uriIdentificatieFor, type DsoSearchArgs } from "../src/sources/dso-omgevingsdocumenten.js";

/* ------------------------------------------------------------------ */
/*  Time travel, identifiers, names, locatie, ontwerpen, area, rows    */
/* ------------------------------------------------------------------ */

function resetDso() {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearDsoCaches();
  clearHttpCache();
}

describe("DSO time travel: geldigOp goes with inWerkingOp", () => {
  beforeEach(resetDso);

  const both = (c: Call) => c.url.searchParams.get("geldigOp") === "2025-01-01" && c.url.searchParams.get("inWerkingOp") === "2025-01-01";

  it("sends both on the catalogue, _zoek and the plain list, and says so", async () => {
    const calls = mockDso((call) => (call.method === "POST" ? zoekPage([OMGEVINGSPLAN_UTRECHT]) : cataloguePage(call, CATALOGUE)));
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");

    const catalogus = await src.search({ query: "omgevingsplan", geldigOp: "2025-01-01", rows: 5 });
    const zoek = await src.search({ bevoegdGezag: "gm0344", geldigOp: "2025-01-01", rows: 5 });
    const lijst = await src.search({ geldigOp: "2025-01-01", rows: 5 });

    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every(both)).toBe(true);
    for (const out of [catalogus, zoek, lijst]) {
      expect(out.query).toMatchObject({ geldigOp: "2025-01-01", inWerkingOp: "2025-01-01" });
      expect(out.access_note).toContain("geldig en in werking");
    }
  });

  it("keeps today's catalogue apart from a geldigOp catalogue", async () => {
    const calls = mockDso((call) => cataloguePage(call, CATALOGUE));
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    await src.search({ query: "omgevingsplan", rows: 5 });
    await src.search({ query: "omgevingsplan", geldigOp: "2025-01-01", rows: 5 });
    await src.search({ query: "omgevingsvisie", rows: 5 });

    expect(calls.map((c) => c.url.searchParams.get("geldigOp"))).toEqual([null, "2025-01-01"]);
  });

  it("sends both on the text's metadata and documentstructuur, not for an ontwerp", async () => {
    // An empty documentstructuur is refused as an error, so give it one artikel.
    const artikel = { identificatie: "art_1", expressie: "art_1", type: "ARTIKEL", volgordeNummer: 0, inhoud: "<Inhoud><Al>Tekst.</Al></Inhoud>" };
    const structuur = { _embedded: { documentComponenten: [artikel], ontwerpDocumentComponenten: [artikel] } };
    const calls = mockDso((call) => (call.url.pathname.endsWith("/documentstructuur") ? structuur : OMGEVINGSPLAN_UTRECHT));
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    await src.documentText({ identificatie: "/akn/nl/act/gm0344/2020/omgevingsplan", geldigOp: "2025-01-01" });
    expect(calls).toHaveLength(2);
    expect(calls.every(both)).toBe(true);

    const ontwerpCalls = mockDso((call) => (call.url.pathname.endsWith("/documentstructuur") ? structuur : { ...VISIE_PV26, technischId: "_akn_nl_act_pv26_2023_omgevingsvisie_akn_nl_bill_pv26_2025_1_1093" }));
    await src.documentText({ identificatie: "_akn_nl_act_pv26_2023_omgevingsvisie_akn_nl_bill_pv26_2025_1_1093", geldigOp: "2025-01-01" });
    expect(ontwerpCalls.every((c) => !c.url.searchParams.has("geldigOp") && !c.url.searchParams.has("inWerkingOp"))).toBe(true);
  });
});

describe("DSO identifiers with a hyphen", () => {
  beforeEach(resetDso);

  it("writes '/' and '-' as '_' in uriIdentificatie, as the DSO does", () => {
    expect(uriIdentificatieFor("/akn/nl/act/gm0119/2025/programma-biodiversiteit")).toBe("_akn_nl_act_gm0119_2025_programma_biodiversiteit");
    expect(uriIdentificatieFor("/akn/nl/act/gm0344/2020/omgevingsplan/")).toBe("_akn_nl_act_gm0344_2020_omgevingsplan");
    expect(parseDsoIdentificatie("/akn/nl/act/mnre1153/2013/Kempenland-West")).toEqual({ kind: "regeling", uriIdentificatie: "_akn_nl_act_mnre1153_2013_Kempenland_West", identificatie: "/akn/nl/act/mnre1153/2013/Kempenland-West" });
    expect(parseDsoIdentificatie("_akn_nl_act_gm0119_2025_programma-biodiversiteit")).toEqual({ kind: "regeling", uriIdentificatie: "_akn_nl_act_gm0119_2025_programma_biodiversiteit" });
    expect(parseDsoIdentificatie("https://identifier.overheid.nl/akn/nl/act/gm0119/2025/programma-biodiversiteit")).toMatchObject({ uriIdentificatie: "_akn_nl_act_gm0119_2025_programma_biodiversiteit" });
    expect(parseDsoIdentificatie("/akn/nl/act/gm0344/2020/omgevingsplan/nld@2026-08-19;0903/")).toMatchObject({ uriIdentificatie: "_akn_nl_act_gm0344_2020_omgevingsplan" });
    // The ontwerpbesluit keeps its own spelling: it is matched as it stands in the DSO.
    expect(parseDsoIdentificatie("/akn/nl/bill/gm0335/2026/besluit-omgevingsplan-20260925-134901")).toEqual({ kind: "ontwerpbesluit", ontwerpbesluitIdentificatie: "/akn/nl/bill/gm0335/2026/besluit-omgevingsplan-20260925-134901" });
  });

  it("gives the search records the uriIdentificatie the text tool reads", async () => {
    const meppel = regeling("gm0119", "gemeente Meppel", "Programma", "/akn/nl/act/gm0119/2025/programma-biodiversiteit", "Programma biodiversiteit van de gemeente Meppel", "2025-07-08");
    mockDso(() => zoekPage([meppel]));
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ bevoegdGezag: "gm0119", rows: 5 });
    expect(out.items[0].uriIdentificatie).toBe("_akn_nl_act_gm0119_2025_programma_biodiversiteit");
    // The readable text keeps the identificatie as it is.
    expect(out.items[0].documentUrl).toBe("https://identifier.overheid.nl/akn/nl/act/gm0119/2025/programma-biodiversiteit");
  });
});

describe("DSO names: layers, document types and aliases", () => {
  beforeEach(resetDso);

  const PV31 = regeling("pv31", "provincie Limburg", "Omgevingsverordening", "/akn/nl/act/pv31/2023/omgevingsverordening", "Omgevingsverordening Limburg", "2025-02-03");
  const WS0665 = regeling("ws0665", "waterschap Limburg", "Waterschapsverordening", "/akn/nl/act/ws0665/2023/wsv", "Waterschapsverordening Waterschap Limburg", "2026-09-30");
  const PV21 = regeling("pv21", "provincie Fryslân", "Programma", "/akn/nl/act/pv21/2026/fasn", "Friese Aanpak Stikstofreductie en Natuurherstel", "2026-09-21");
  const WS0653 = regeling("ws0653", "Wetterskip Fryslân", "Waterschapsverordening", "/akn/nl/act/ws0653/2023/wsv", "Waterschapsverordening Wetterskip Fryslân", "2026-01-01");
  const GM0796 = regeling("gm0796", "gemeente 's-Hertogenbosch", "Omgevingsplan", "/akn/nl/act/gm0796/2020/omgevingsplan", "Omgevingsplan gemeente 's-Hertogenbosch", "2026-01-01");
  const GM0518 = regeling("gm0518", "gemeente Den Haag", "Omgevingsplan", "/akn/nl/act/gm0518/2020/omgevingsplan", "Omgevingsplan gemeente Den Haag", "2026-01-09");
  const GM0184 = regeling("gm0184", "gemeente Urk", "Programma", "/akn/nl/act/gm0184/2026/wonen", "Programma Wonen 2.0 Gemeente Urk", "2026-03-25");
  const NAMES = [...CATALOGUE, PV31, WS0665, PV21, WS0653, GM0796, GM0518, GM0184];

  function names(): Call[] {
    return mockDso((call) => {
      if (call.method === "GET") return cataloguePage(call, NAMES);
      const codes = (call.body?.bevoegdGezag as string[] | undefined) ?? [];
      return zoekPage(NAMES.filter((x) => codes.includes(x.aangeleverdDoorEen.code)));
    });
  }

  const resolve = async (bevoegdGezag: string, extra: Partial<DsoSearchArgs> = {}) =>
    new DsoOmgevingsdocumentenSource(config, "test-key").search({ bevoegdGezag, rows: 5, ...extra });

  it("lets documentType pick the layer of a bare name", async () => {
    names();
    const verordening = await resolve("Utrecht", { documentType: "omgevingsverordening" });
    expect(verordening.bevoegdGezag?.code).toBe("pv26");
    expect(verordening.items.map((x) => x.title)).toEqual(["Omgevingsverordening provincie Utrecht"]);
    expect(verordening.access_note).toContain("een omgevingsverordening stelt een provincie vast");
    expect(verordening.access_note).toContain("ook mogelijk: gemeente Utrecht (gm0344)");
    expect((await resolve("Limburg", { documentType: "waterschapsverordening" })).bevoegdGezag?.code).toBe("ws0665");
    // Without a type the gemeente still comes first.
    expect((await resolve("Utrecht")).bevoegdGezag?.code).toBe("gm0344");
  });

  it("reads a bare provincie name as the provincie, not the waterschap of the same name", async () => {
    names();
    expect((await resolve("Limburg")).bevoegdGezag?.code).toBe("pv31");
    expect((await resolve("Fryslân")).bevoegdGezag?.code).toBe("pv21");
    expect((await resolve("Limburg", { typeBevoegdGezag: "waterschap" })).bevoegdGezag?.code).toBe("ws0665");
  });

  it("knows everyday names and abbreviations", async () => {
    names();
    expect((await resolve("Den Bosch")).bevoegdGezag?.code).toBe("gm0796");
    expect((await resolve("'s-Gravenhage")).bevoegdGezag?.code).toBe("gm0518");
    expect((await resolve("Friesland")).bevoegdGezag?.code).toBe("pv21");
    expect((await resolve("HDSR")).bevoegdGezag?.code).toBe("ws0636");
    expect((await resolve("BZK")).bevoegdGezag?.code).toBe("mnre1034");
  });

  it("explains the Rijk, writes Dutch plurals and keeps short-name suggestions close", async () => {
    names();
    const rijk = await resolve("Rijk").catch((e) => e);
    expect(rijk).toBeInstanceOf(DsoInputError);
    expect(rijk.suggestion).toContain("typeBevoegdGezag 'ministerie'");
    const waterschap = await resolve("Utrecht", { typeBevoegdGezag: "waterschap" }).catch((e) => e);
    expect(waterschap.message).toContain("onder de waterschappen");
    const provincie = await resolve("provincie Frieslant").catch((e) => e);
    expect(provincie.message).toContain("onder de provincies");
    expect(provincie.suggestion).toContain("provincie Fryslân (pv21)");
    // "Urq" is one letter from Urk; "XYZ" is two letters from everything and gets no guesses.
    expect((await resolve("Urq").catch((e) => e)).suggestion).toContain("gemeente Urk (gm0184)");
    expect((await resolve("XYZ").catch((e) => e)).details.suggestions).toEqual([]);
  });

  it("says that a provincie as bevoegdGezag is its own documents only", async () => {
    names();
    const out = await resolve("pv26", { alleenTerInzage: false });
    expect(out.access_note).toContain("alleen de documenten die de provincie zelf vaststelt");
    expect(out.access_note).toContain("provincie 'pv26'");
  });

  it("refuses an over-long name before any matching", async () => {
    const calls = names();
    const err = await resolve("q".repeat(201)).catch((e) => e);
    expect(err).toBeInstanceOf(DsoInputError);
    expect(calls).toHaveLength(0);
  });
});

describe("DSO locatie: places, postcodes and ambiguity", () => {
  beforeEach(resetDso);

  type Doc = Record<string, unknown>;
  const doc = (type: string, weergavenaam: string, plaats: { wp?: string; gm: string }, score: number, rd: string, extra: Doc = {}): Doc => ({
    type,
    weergavenaam,
    woonplaatsnaam: plaats.wp,
    gemeentenaam: plaats.gm,
    score,
    centroide_rd: `POINT(${rd})`,
    ...extra,
  });
  const UTRECHT = { wp: "Utrecht", gm: "Utrecht" };
  const DEN_HAAG = { wp: "'s-Gravenhage", gm: "'s-Gravenhage" };

  /** PDOK answers per request: the free search, then (with fq) the search within a place. */
  function pdok(first: Doc[], within: Doc[] = []): Call[] {
    return mockDso((call) => {
      if (call.url.hostname === "api.pdok.nl") return { response: { docs: call.url.searchParams.has("fq") ? within : first } };
      return zoekPage([OMGEVINGSPLAN_UTRECHT, WSV_HDSR, VERORDENING_PV26, OMGEVINGSWET]);
    });
  }
  const search = (locatie: string, rows = 20) => new DsoOmgevingsdocumentenSource(config, "test-key").search({ locatie, rows });

  it("takes a landmark within the place it names, not the best hit elsewhere", async () => {
    const calls = pdok([
      doc("weg", "Centraal Busstation, Breda", { wp: "Breda", gm: "Breda" }, 14.3, "112000 400000"),
      doc("weg", "Metrostation Centraal Station, Amsterdam", { wp: "Amsterdam", gm: "Amsterdam" }, 13.9, "121000 487000"),
      doc("gemeente", "Gemeente Utrecht", { gm: "Utrecht" }, 10.2, "133587 455921"),
      doc("woonplaats", "Utrecht, Utrecht, Utrecht", UTRECHT, 8.8, "134987.52 455643.648"),
    ]);
    const out = await search("Utrecht Centraal");

    expect(out.locatie?.weergavenaam).toBe("Utrecht, Utrecht, Utrecht");
    expect(out.access_note).toContain("'centraal' niet gevonden in Utrecht");
    // Asked once more within the gemeente before falling back on its centre.
    const within = calls.find((c) => c.url.hostname === "api.pdok.nl" && c.url.searchParams.has("fq"));
    expect(within?.url.searchParams.get("fq")).toBe('gemeentenaam:"Utrecht"');
    expect(within?.url.searchParams.get("q")).toBe("centraal");
  });

  it("asks which place is meant when a name fits several gemeenten", async () => {
    const LUNETTEN = [
      doc("weg", "Lunetten, Nijkerk", { wp: "Nijkerk", gm: "Nijkerk" }, 12.54, "165000 476000"),
      doc("weg", "de Lunetten, Beverwijk", { wp: "Beverwijk", gm: "Beverwijk" }, 12.23, "105000 497000"),
      doc("weg", "Knooppunt Lunetten, Utrecht", UTRECHT, 12.23, "137677.17 451921.277"),
    ];
    pdok(LUNETTEN);
    const err = await search("Lunetten").catch((e) => e);
    expect(err).toBeInstanceOf(DsoInputError);
    expect(err.message).toContain("niet eenduidig");
    expect(err.message).toContain("Knooppunt Lunetten, Utrecht");

    resetDso();
    pdok([LUNETTEN[2], LUNETTEN[0], LUNETTEN[1]]);
    expect((await search("Lunetten, Utrecht")).locatie?.weergavenaam).toBe("Knooppunt Lunetten, Utrecht");
  });

  it("reads Den Haag as 's-Gravenhage and takes the address with the house number asked for", async () => {
    pdok([doc("adres", "Spui 70, 2511BT 's-Gravenhage", DEN_HAAG, 15.47, "81611.373 454909.349", { huisnummer: 70, huis_nlt: "70", postcode: "2511BT" })]);
    expect((await search("Spui 70, Den Haag")).locatie?.weergavenaam).toBe("Spui 70, 2511BT 's-Gravenhage");

    resetDso();
    pdok([
      doc("weg", "Lange Voorhout, 's-Gravenhage", DEN_HAAG, 17.3, "81100 455300"),
      doc("adres", "Lange Voorhout 58A-1, 2514EG 's-Gravenhage", DEN_HAAG, 16.76, "81200 455400", { huisnummer: 58, huis_nlt: "58A-1", postcode: "2514EG" }),
      doc("adres", "Lange Voorhout 1, 2514EA 's-Gravenhage", DEN_HAAG, 16.62, "81117.057 455303.484", { huisnummer: 1, huis_nlt: "1", postcode: "2514EA" }),
    ]);
    const out = await search("Lange Voorhout 1 Den Haag");
    expect(out.locatie).toMatchObject({ weergavenaam: "Lange Voorhout 1, 2514EA 's-Gravenhage", type: "adres" });
  });

  it("sends a postcode without its space, also after 'postcode'", async () => {
    const postcode = doc("postcode", "Brennerbaan, 3524BN Utrecht", UTRECHT, 9.43, "138109.145 453197.774", { postcode: "3524BN" });
    const calls = pdok([doc("woonplaats", "Echteld, Neder-Betuwe, Gelderland", { wp: "Echteld", gm: "Neder-Betuwe" }, 9.83, "160000 435000"), postcode]);
    expect((await search("3524 BN")).locatie?.weergavenaam).toBe("Brennerbaan, 3524BN Utrecht");
    expect(calls[0].url.searchParams.get("q")).toBe("3524BN");

    resetDso();
    const adres = doc("adres", "Brennerbaan 150, 3524BN Utrecht", UTRECHT, 13.22, "138180.745 453109.293", { huisnummer: 150, huis_nlt: "150", postcode: "3524BN" });
    const again = pdok([adres]);
    expect((await search("postcode 3524 BN 150")).locatie?.weergavenaam).toBe("Brennerbaan 150, 3524BN Utrecht");
    expect(again[0].url.searchParams.get("q")).toBe("3524BN 150");
  });

  it("reads 'Spui 70' as a street in several places, not as the village Spui, and lets a postcode decide", async () => {
    const SPUI = [
      doc("woonplaats", "Spui, Terneuzen, Zeeland", { wp: "Spui", gm: "Terneuzen" }, 12.44, "45000 365000"),
      doc("adres", "Spui 70, 1703MN Heerhugowaard", { wp: "Heerhugowaard", gm: "Dijk en Waard" }, 11.3, "113000 521000", { huisnummer: 70, huis_nlt: "70", postcode: "1703MN" }),
      doc("adres", "Spui 70, 2511BT 's-Gravenhage", DEN_HAAG, 10.81, "81611.373 454909.349", { huisnummer: 70, huis_nlt: "70", postcode: "2511BT" }),
    ];
    pdok(SPUI);
    const err = await search("Spui 70").catch((e) => e);
    expect(err).toBeInstanceOf(DsoInputError);
    expect(err.message).toContain("Spui 70, 1703MN Heerhugowaard; Spui 70, 2511BT 's-Gravenhage");

    resetDso();
    pdok(SPUI);
    expect((await search("Spui 70 2511 BT")).locatie?.weergavenaam).toBe("Spui 70, 2511BT 's-Gravenhage");
  });

  it("refuses a foreign address and a street that does not exist in the place named", async () => {
    pdok([
      doc("weg", "de Linden, Wagenborgen", { wp: "Wagenborgen", gm: "Eemsdelta" }, 12.1, "256000 593000"),
      doc("woonplaats", "Linden, Land van Cuijk, Noord-Brabant", { wp: "Linden", gm: "Land van Cuijk" }, 11.94, "189000 412000"),
    ]);
    expect(await search("Unter den Linden 1 Berlin").catch((e) => e)).toBeInstanceOf(DsoInputError);

    resetDso();
    pdok(
      [doc("gemeente", "Gemeente Utrecht", { gm: "Utrecht" }, 10.25, "133587 455921"), doc("woonplaats", "Utrecht, Utrecht, Utrecht", UTRECHT, 8.82, "134987.52 455643.648")],
      [doc("weg", "5 Meiplein, Utrecht", UTRECHT, 5.41, "136000 456000"), doc("adres", "Ariënslaan 5-5, 3573PT Utrecht", UTRECHT, 3.1, "137000 457000", { huisnummer: 5, huis_nlt: "5-5" })],
    );
    const err = await search("Nonexistentstraat 5 Utrecht").catch((e) => e);
    expect(err).toBeInstanceOf(DsoInputError);
    expect(err.message).toContain("niet gevonden in Utrecht");
  });

  const AMSTERDAM = { wp: "Amsterdam", gm: "Amsterdam" };

  it("reads '1e' or '2e' before a street as part of its name and takes the house number after it", async () => {
    pdok([
      doc("weg", "Eerste Hugo de Grootstraat, Amsterdam", AMSTERDAM, 23.23, "119800 487900"),
      doc("adres", "Eerste Hugo de Grootstraat 10-H, 1052KP Amsterdam", AMSTERDAM, 22.81, "119850 487950", { huisnummer: 10, huis_nlt: "10-H", postcode: "1052KP" }),
    ]);
    const hugo = await search("1e Hugo de Grootstraat 10, Amsterdam");
    expect(hugo.locatie).toMatchObject({ weergavenaam: "Eerste Hugo de Grootstraat 10-H, 1052KP Amsterdam", type: "adres" });
    expect(hugo.access_note).not.toContain("niet gevonden");

    // "2e Daalsedijk" is no "1e Daalsedijk", whatever numbers that one has.
    resetDso();
    const calls = pdok([
      doc("weg", "1e Daalsedijk, Utrecht", UTRECHT, 10.25, "136200 457100"),
      doc("adres", "1e Daalsedijk 10, 3513TB Utrecht", UTRECHT, 10.2, "136250 457150", { huisnummer: 10, huis_nlt: "10", postcode: "3513TB" }),
      doc("weg", "2e Daalsedijk, Utrecht", UTRECHT, 10.2, "136900 457900"),
    ]);
    const daal = await search("2e Daalsedijk 10, Utrecht");
    expect(daal.locatie?.weergavenaam).toBe("2e Daalsedijk, Utrecht");
    expect(daal.access_note).toContain("Huisnummer 10 niet gevonden; gebruikt: het middelpunt van 2e Daalsedijk, Utrecht.");
    // Asked again within Utrecht, with the ordinal.
    expect(calls.find((c) => c.url.searchParams.get("fq") === 'gemeentenaam:"Utrecht"')?.url.searchParams.get("q")).toBe("2e daalsedijk 10");
  });

  it("never answers with another city than the one named, also when the first hits hold nothing there", async () => {
    const calls = mockDso((call) => {
      if (call.url.hostname !== "api.pdok.nl") return zoekPage([OMGEVINGSPLAN_UTRECHT]);
      const fq = call.url.searchParams.get("fq");
      if (fq === "type:(gemeente OR woonplaats)") {
        return { response: { docs: [doc("gemeente", "Gemeente Utrecht", { gm: "Utrecht" }, 9.79, "133587 455921"), doc("woonplaats", "Utrecht, Utrecht, Utrecht", UTRECHT, 8.82, "134987.52 455643.648")] } };
      }
      if (fq) return { response: { docs: [] } };
      return { response: { docs: [doc("weg", "Metrostation Centraal Station, Amsterdam", AMSTERDAM, 23.12, "121900 488500"), doc("weg", "Centraal Busstation, Breda", { wp: "Breda", gm: "Breda" }, 14.21, "112000 400000")] } };
    });
    for (const input of ["Utrecht Centraal Station", "Station Utrecht Centraal"]) {
      const err = await search(input).catch((e) => e);
      expect(err).toBeInstanceOf(DsoInputError);
      expect(err.message).toBe(`Locatie '${input}' niet gevonden in Utrecht (PDOK Locatieserver).`);
    }
    // The place looked up, then searched within; no documents of Amsterdam asked for.
    expect(calls.some((c) => c.url.searchParams.get("fq") === 'gemeentenaam:"Utrecht"' && c.url.searchParams.get("q") === "station centraal")).toBe(true);
    expect(calls.every((c) => c.url.hostname === "api.pdok.nl")).toBe(true);
  });

  it("reads Den Haag and Den Bosch also next to a postcode", async () => {
    pdok([
      doc("adres", "Spui 70, 2511BT 's-Gravenhage", DEN_HAAG, 24.18, "81611.373 454909.349", { huisnummer: 70, huis_nlt: "70", postcode: "2511BT" }),
      doc("postcode", "Spui, 2511BT 's-Gravenhage", DEN_HAAG, 21.74, "81600 454900", { postcode: "2511BT" }),
    ]);
    expect((await search("Spui 70, 2511 BT Den Haag")).locatie?.weergavenaam).toBe("Spui 70, 2511BT 's-Gravenhage");
    expect((await search("2511 BT Den Haag")).locatie?.weergavenaam).toBe("Spui, 2511BT 's-Gravenhage");

    resetDso();
    const BOSCH = { wp: "'s-Hertogenbosch", gm: "'s-Hertogenbosch" };
    pdok([
      doc("adres", "Markt 1A, 5211JV 's-Hertogenbosch", BOSCH, 21.04, "149500 411500", { huisnummer: 1, huis_nlt: "1A", postcode: "5211JV" }),
      doc("adres", "Markt 1, 5211JV 's-Hertogenbosch", BOSCH, 21.02, "149510 411510", { huisnummer: 1, huis_nlt: "1", postcode: "5211JV" }),
    ]);
    expect((await search("Markt 1, 5211 JV Den Bosch")).locatie?.weergavenaam).toBe("Markt 1, 5211JV 's-Hertogenbosch");
  });

  it("keeps the street asked for: another woonplaats of the gemeente, its centre, or another street, each said", async () => {
    const OUDE_1A = doc("adres", "Oude Kerkstraat 1A-BS, 3572TG Utrecht", UTRECHT, 10.21, "136500 456500", { huisnummer: 1, huis_nlt: "1A-BS", postcode: "3572TG" });
    const KERKSTRAAT = doc("weg", "Kerkstraat, Utrecht", UTRECHT, 10.09, "136000 455000");
    const OUDE_1 = doc("adres", "Oude Kerkstraat 1, 3572TG Utrecht", UTRECHT, 9.69, "136510 456510", { huisnummer: 1, huis_nlt: "1", postcode: "3572TG" });
    const MEERN = doc("adres", "Kerkstraat 1, 3454VE De Meern", { wp: "De Meern", gm: "Utrecht" }, 6.79, "128000 453000", { huisnummer: 1, huis_nlt: "1", postcode: "3454VE" });

    pdok([OUDE_1A, KERKSTRAAT, OUDE_1], [OUDE_1A, KERKSTRAAT, MEERN, OUDE_1]);
    const meern = await search("Kerkstraat 1, Utrecht");
    expect(meern.locatie?.weergavenaam).toBe("Kerkstraat 1, 3454VE De Meern");
    expect(meern.access_note).toContain("Ligt in de woonplaats De Meern (gemeente Utrecht).");

    resetDso();
    pdok([OUDE_1A, KERKSTRAAT, OUDE_1]);
    const street = await search("Kerkstraat 1, Utrecht");
    expect(street.locatie?.weergavenaam).toBe("Kerkstraat, Utrecht");
    expect(street.access_note).toContain("Huisnummer 1 niet gevonden; gebruikt: het middelpunt van Kerkstraat, Utrecht.");

    resetDso();
    pdok([OUDE_1A, OUDE_1]);
    const other = await search("Kerkstraat 1, Utrecht");
    expect(other.locatie?.weergavenaam).toBe("Oude Kerkstraat 1, 3572TG Utrecht");
    expect(other.access_note).toContain("gebruikt: Oude Kerkstraat 1, 3572TG Utrecht (een andere straat)");
  });

  it("asks the Locatieserver under its own connector, apart from the BAG tools", async () => {
    pdok([doc("adres", "Brennerbaan 150, 3524BN Utrecht", UTRECHT, 13.22, "138180.745 453109.293", { huisnummer: 150, huis_nlt: "150", postcode: "3524BN" })]);
    await search("Brennerbaan 150, Utrecht");
    expect(getConnectorHealth("dso_locatieserver").total_calls).toBeGreaterThan(0);
    expect(getConnectorHealth("pdok_bag").total_calls).toBe(0);
  });
});

describe("DSO ontwerpen: unknown inzagetermijn and besluit titles", () => {
  beforeEach(resetDso);

  function draft(code: string, naam: string, title: string, act: string, bill: string, bekendOp: string, termijn?: [string, string], besluit?: string) {
    const stappen = [
      { soortStap: { waarde: "Vaststelling" }, voltooidOp: bekendOp },
      { soortStap: { waarde: "Publicatie" }, voltooidOp: bekendOp },
      ...(termijn ? [{ soortStap: { waarde: "Begin inzagetermijn" }, voltooidOp: termijn[0] }, { soortStap: { waarde: "Einde inzagetermijn" }, voltooidOp: termijn[1] }] : []),
    ];
    return {
      identificatie: act,
      technischId: `${act}${bill}`.replace(/[/-]/g, "_"),
      ontwerpbesluitIdentificatie: bill,
      officieleTitel: title,
      type: { code: TYPES.Programma, waarde: "Programma" },
      aangeleverdDoorEen: { naam, bestuurslaag: code.startsWith("gm") ? "gemeente" : "provincie", code },
      geregistreerdMet: { versie: 1, tijdstipRegistratie: `${bekendOp}T08:00:00Z` },
      procedureverloop: { bekendOp, procedurestappen: stappen },
      ...(besluit ? { besluitMetadata: { citeerTitel: besluit } } : {}),
    };
  }

  const OPEN = draft("gm0335", "gemeente Montfoort", "Omgevingsplan gemeente Montfoort", "/akn/nl/act/gm0335/2020/omgevingsplan", "/akn/nl/bill/gm0335/2026/besluit-omgevingsplan-20260925-134901", "2026-09-28", ["2026-09-29", "2026-11-09"], "Ontwerp wijziging Omgevingsplan gemeente Montfoort, Laan van Overvliet");
  const RECENT_NO_TERMIJN = draft("pv26", "provincie Utrecht", "Beleidsprogramma Provinciaal Programma Wonen en Werken 2026 provincie Utrecht", "/akn/nl/act/pv26/2026/2_50", "/akn/nl/bill/pv26/2026/2_1108", "2026-08-28", undefined, "Ontwerp Beleidsprogramma Provinciaal Programma Wonen en Werken 2026 provincie Utrecht");
  const OLD_NO_TERMIJN = draft("pv26", "provincie Utrecht", "Programma Oud provincie Utrecht", "/akn/nl/act/pv26/2025/2_10", "/akn/nl/bill/pv26/2025/2_900", "2025-01-10");
  const CLOSED = draft("pv26", "provincie Utrecht", "Programma Dicht provincie Utrecht", "/akn/nl/act/pv26/2025/2_11", "/akn/nl/bill/pv26/2026/2_901", "2026-01-05", ["2026-01-06", "2026-02-16"]);

  it("leaves terInzage unknown without a termijn in the DSO, never false", async () => {
    mockDso(() => zoekPage([RECENT_NO_TERMIJN, OLD_NO_TERMIJN, CLOSED], "ontwerpregelingen"));
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ soort: "ontwerpregelingen", bevoegdGezag: "pv26", rows: 20, today: "2026-10-06" });
    const byBill = Object.fromEntries(out.items.map((x) => [x.ontwerpbesluitIdentificatie, x]));
    expect(byBill["/akn/nl/bill/pv26/2026/2_1108"]).toMatchObject({ terInzage: null, inzagetermijnBekend: false, mogelijkTerInzage: true });
    expect(byBill["/akn/nl/bill/pv26/2025/2_900"]).toMatchObject({ terInzage: null, inzagetermijnBekend: false, mogelijkTerInzage: false });
    expect(byBill["/akn/nl/bill/pv26/2026/2_901"]).toMatchObject({ terInzage: false, inzagetermijnBekend: true, mogelijkTerInzage: false });
  });

  it("alleen_ter_inzage gives the confirmed ones first, then the recent ones without a termijn, and counts both", async () => {
    mockDso((call) => cataloguePage(call, [OLD_NO_TERMIJN, RECENT_NO_TERMIJN, CLOSED, OPEN], "ontwerpregelingen"));
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ alleenTerInzage: true, rows: 20, today: "2026-10-06" });

    expect(out.items.map((x) => [x.bevoegdGezagCode, x.terInzage, x.mogelijkTerInzage])).toEqual([
      ["gm0335", true, false],
      ["pv26", null, true],
    ]);
    expect(out.total).toBe(2);
    expect(out.access_note).toContain("Ter inzage: 1 met een inzagetermijn in het DSO");
    expect(out.access_note).toContain("daarna 1 mogelijk ter inzage");
    expect(out.access_note).toContain("bekendgemaakt sinds 2026-08-11");
  });

  it("adds the ontwerpbesluit's citeertitel when it names more, and finds it by query", async () => {
    mockDso((call) => cataloguePage(call, [OPEN, RECENT_NO_TERMIJN], "ontwerpregelingen"));
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    const out = await src.search({ soort: "ontwerpregelingen", query: "Laan van Overvliet", rows: 5, today: "2026-10-06" });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].title).toBe("Omgevingsplan gemeente Montfoort — Ontwerp wijziging Omgevingsplan gemeente Montfoort, Laan van Overvliet");
    expect(out.items[0].besluitTitel).toBe("Ontwerp wijziging Omgevingsplan gemeente Montfoort, Laan van Overvliet");
    // "Ontwerp <the same title>" says nothing more: the regeling title stays.
    const same = await src.search({ soort: "ontwerpregelingen", query: "Wonen en Werken", rows: 5, today: "2026-10-06" });
    expect(same.items[0].title).toBe("Beleidsprogramma Provinciaal Programma Wonen en Werken 2026 provincie Utrecht");
  });

  const plan = (code: string, naam: string, bill: string, bekendOp: string, termijn?: [string, string]) => ({
    ...draft(code, naam, `Omgevingsplan ${naam}`, `/akn/nl/act/${code}/2020/omgevingsplan`, bill, bekendOp, termijn),
    type: { code: TYPES.Omgevingsplan, waarde: "Omgevingsplan" },
  });
  const SOEST = plan("gm0342", "gemeente Soest", "/akn/nl/bill/gm0342/2026/4_26", "2026-08-31", ["2026-09-01", "2026-10-12"]);
  const ZONDER_PUBLICATIE = plan("gm0340", "gemeente Rhenen", "/akn/nl/bill/gm0340/2026/11433f567a9e", "2026-09-15", ["2026-09-16", "2026-10-27"]);
  const BEKENDMAKINGEN: Record<string, string> = {
    "/akn/nl/bill/gm0342/2026/4_26": "gmb-2026-409335",
    "/akn/nl/bill/gm0335/2026/besluit-omgevingsplan-20260925-134901": "gmb-2026-453391",
    "/akn/nl/bill/pv26/2026/2_1108": "prb-2026-14769",
  };
  const sru = (id: string, title: string) =>
    '<?xml version="1.0" encoding="UTF-8"?><sru:searchRetrieveResponse xmlns:sru="http://docs.oasis-open.org/ns/search-ws/sruResponse" xmlns:gzd="http://standaarden.overheid.nl/sru" xmlns:overheidwetgeving="http://standaarden.overheid.nl/wetgeving/" xmlns:dcterms="http://purl.org/dc/terms/">' +
    `<sru:numberOfRecords>1</sru:numberOfRecords><sru:records><sru:record><sru:recordData><gzd:gzd><gzd:originalData><overheidwetgeving:meta><overheidwetgeving:owmskern><dcterms:identifier>${id}</dcterms:identifier><dcterms:title>${title}</dcterms:title></overheidwetgeving:owmskern></overheidwetgeving:meta></gzd:originalData></gzd:gzd></sru:recordData></sru:record></sru:records></sru:searchRetrieveResponse>`;

  it("finds the bekendmaking of each ontwerp shown, and the subject of an omgevingsplan titled by its name only", async () => {
    const calls = mockDso((call) => {
      if (call.url.hostname === "identifier.overheid.nl") {
        const id = BEKENDMAKINGEN[call.url.pathname];
        return id ? new Response(null, { status: 302, headers: { location: `https://zoek.officielebekendmakingen.nl/${id}.html` } }) : new Response(null, { status: 404 });
      }
      if (call.url.hostname === "repository.overheid.nl") {
        return new Response(sru("gmb-2026-409335", "Ontwerpwijziging Omgevingsplan gemeente Soest: Beukenlaan 17"), { status: 200, headers: { "content-type": "application/xml" } });
      }
      return zoekPage([SOEST, OPEN, ZONDER_PUBLICATIE, RECENT_NO_TERMIJN], "ontwerpregelingen");
    });
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ soort: "ontwerpregelingen", bevoegdGezag: "gm0342", rows: 20, today: "2026-10-06" });
    const byBill = Object.fromEntries(out.items.map((x) => [x.ontwerpbesluitIdentificatie, x]));

    const soest = byBill["/akn/nl/bill/gm0342/2026/4_26"];
    expect(soest).toMatchObject({
      bekendmakingId: "gmb-2026-409335",
      bekendmakingUrl: "https://zoek.officielebekendmakingen.nl/gmb-2026-409335.html",
      onderwerp: "Ontwerpwijziging Omgevingsplan gemeente Soest: Beukenlaan 17",
      title: "Omgevingsplan gemeente Soest — Beukenlaan 17",
    });
    // A title that names its subject keeps it, with the bekendmaking; no title asked for it.
    expect(byBill[OPEN.ontwerpbesluitIdentificatie]).toMatchObject({ bekendmakingId: "gmb-2026-453391", title: expect.stringContaining("Laan van Overvliet") });
    expect(byBill[OPEN.ontwerpbesluitIdentificatie]).not.toHaveProperty("onderwerp");
    // No publication found: the subject is unknown, not guessed.
    expect(byBill[ZONDER_PUBLICATIE.ontwerpbesluitIdentificatie]).toMatchObject({ onderwerp: null, title: "Omgevingsplan gemeente Rhenen" });
    expect(byBill[ZONDER_PUBLICATIE.ontwerpbesluitIdentificatie]).not.toHaveProperty("bekendmakingId");
    // Possibly ter inzage: its age and an estimated end, and the bekendmaking is leading.
    expect(byBill[RECENT_NO_TERMIJN.ontwerpbesluitIdentificatie]).toMatchObject({ bekendmakingId: "prb-2026-14769", dagenSindsBekendmaking: 39, eindeInzagetermijnSchatting: "2026-10-08" });
    expect(out.access_note).toContain("officiele_bekendmakingen_record_get met bekendmakingId");
    expect(out.access_note).toContain("kan afwijken van de kennisgeving");

    // One redirect request each, without following it; a title only for the bare plan title that had a publication.
    const redirects = calls.filter((c) => c.url.hostname === "identifier.overheid.nl");
    expect(redirects.every((c) => c.method === "HEAD")).toBe(true);
    expect(calls.filter((c) => c.url.hostname === "repository.overheid.nl")).toHaveLength(1);
    expect(getConnectorHealth("dso_bekendmakingen").total_calls).toBe(1);
    expect(getConnectorHealth("officiele_bekendmakingen").total_calls).toBe(0);
  });

  it("answers without the bekendmaking when identifier.overheid.nl does not answer in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) =>
          new URL(String(input)).hostname === "identifier.overheid.nl"
            ? new Promise<never>(() => undefined)
            : new Response(JSON.stringify(zoekPage([SOEST], "ontwerpregelingen")), { status: 200, headers: { "content-type": "application/hal+json" } }),
        ),
      );
      let out: Awaited<ReturnType<DsoOmgevingsdocumentenSource["search"]>> | undefined;
      const pending = new DsoOmgevingsdocumentenSource(config, "test-key").search({ soort: "ontwerpregelingen", bevoegdGezag: "gm0342", rows: 5, today: "2026-10-06" }).then((v) => (out = v));
      for (let i = 0; i < 20 && !out; i++) await vi.advanceTimersByTimeAsync(1_000);
      await pending;
      expect(out?.items[0]).toMatchObject({ terInzage: true, onderwerp: null });
      expect(out?.items[0]).not.toHaveProperty("bekendmakingId");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DSO provincie as an area", () => {
  beforeEach(resetDso);

  const GEMEENTEN = [
    { gemeentecode: "0344", gemeentenaam: "Utrecht", provinciecode: "PV26", provincienaam: "Utrecht" },
    { gemeentecode: "0321", gemeentenaam: "Houten", provinciecode: "PV26", provincienaam: "Utrecht" },
  ];

  it("searches the provincie and its gemeenten in one _zoek and says what is left out", async () => {
    const calls = mockDso((call) => {
      if (call.url.hostname === "api.pdok.nl") return { response: { docs: GEMEENTEN } };
      if (call.method === "GET") return cataloguePage(call, CATALOGUE);
      return zoekPage([OMGEVINGSPLAN_UTRECHT, VISIE_PV26, VERORDENING_PV26]);
    });
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ provincie: "Utrecht", documentType: "omgevingsplan", rows: 20 });

    const pdokCall = calls.find((c) => c.url.hostname === "api.pdok.nl");
    expect(pdokCall?.url.searchParams.get("fq")).toBe("type:gemeente AND provinciecode:PV26");
    const zoek = calls.find((c) => c.method === "POST");
    expect(zoek?.body).toEqual({ bevoegdGezag: ["pv26", "gm0344", "gm0321"] });
    expect(out.scope).toBe("provincie");
    expect(out.provincie).toEqual({ code: "pv26", naam: "provincie Utrecht", gemeenten: 2 });
    expect(out.items.map((x) => x.title)).toEqual(["Omgevingsplan gemeente Utrecht"]);
    expect(out.access_note).toContain("Waterschappen en het Rijk vallen erbuiten");
  });

  it("does not combine an area with bevoegdGezag or locatie", async () => {
    const calls = mockDso(() => ({}));
    const err = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ provincie: "Utrecht", bevoegdGezag: "gm0344", rows: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(DsoInputError);
    expect(calls).toHaveLength(0);
  });
});

describe("DSO rows and paging", () => {
  beforeEach(resetDso);

  const BRENNERBAAN = { weergavenaam: "Brennerbaan 150, 3524BN Utrecht", type: "adres", woonplaatsnaam: "Utrecht", gemeentenaam: "Utrecht", huisnummer: 150, huis_nlt: "150", postcode: "3524BN", centroide_rd: "POINT(138180.745 453109.293)" };

  it("names per bestuurslaag what rows left out", async () => {
    mockDso((call) => (call.url.hostname === "api.pdok.nl" ? { response: { docs: [BRENNERBAAN] } } : zoekPage([OMGEVINGSWET, VISIE_PV26, BAL, OMGEVINGSPLAN_UTRECHT, WSV_HDSR, DAKKAPELLEN, NOVI, VERORDENING_PV26])));
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ locatie: "Brennerbaan 150, Utrecht", rows: 4 });
    expect(out.items).toHaveLength(4);
    expect(out.access_note).toContain("Niet getoond (rows 4): 1 van de 2 documenten van de provincie, 3 van de 3 documenten van het Rijk; verhoog rows naar 8");
  });

  it("returns up to 50 at a location and 20 elsewhere when rows is not given", async () => {
    const many = Array.from({ length: 30 }, (_, i) => regeling("mnre1034", "ministerie van Binnenlandse Zaken en Koninkrijksrelaties", "Programma", `/akn/nl/act/mnre1034/2024/p${i}`, `Programma ${i}`, "2024-01-01"));
    mockDso((call) => (call.url.hostname === "api.pdok.nl" ? { response: { docs: [BRENNERBAAN] } } : zoekPage(many)));
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    expect((await src.search({ locatie: "Brennerbaan 150, Utrecht" })).items).toHaveLength(30);
    expect((await src.search({ bevoegdGezag: "mnre1034" })).items).toHaveLength(20);
  });

  it("breaks ties in the _zoek sort, so pages neither overlap nor skip", async () => {
    const calls = mockDso((call) => zoekPage([OMGEVINGSPLAN_UTRECHT], call.url.pathname.includes("ontwerp") ? "ontwerpregelingen" : "regelingen"));
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    await src.search({ bevoegdGezag: "gm0344", rows: 5 });
    await src.search({ bevoegdGezag: "gm0344", soort: "ontwerpregelingen", rows: 5 });
    expect(calls.map((c) => c.url.searchParams.get("_sort"))).toEqual(["-geldigVanaf,identificatie", "-registratietijdstip,identificatie"]);
  });

  it("exposes the version the dates belong to, and that eindGeldigheid is the first day of the next", async () => {
    mockDso(() => zoekPage([{ ...WSV_HDSR, geregistreerdMet: { ...WSV_HDSR.geregistreerdMet, versie: 7, eindGeldigheid: "2026-10-07" } }]));
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ bevoegdGezag: "ws0636", rows: 5 });
    expect(out.items[0]).toMatchObject({ versie: 7, beginGeldigheid: "2026-05-20", eindGeldigheid: "2026-10-07", versieGeldigTotEnMet: "2026-10-06" });
    expect(out.access_note).toContain("eindGeldigheid is exclusief: op die dag geldt al de volgende versie");
    expect(out.access_note).toContain("niet het einde van de regeling");
    expect(out.access_note).toContain("versie is het volgnummer van de registratie in het DSO");
    // A waterschap's keur is in its verordening now.
    expect(out.access_note).toContain("opgegaan in zijn waterschapsverordening");
  });
});

/* ------------------------------------------------------------------ */
/*  Counts per bestuurslaag, non-rule records, voorbeschermingsregels  */
/* ------------------------------------------------------------------ */

const AANSLUITDOCUMENT = regeling("mnre1034", "ministerie van Binnenlandse Zaken en Koninkrijksrelaties", "AMvB", "/akn/nl/act/mnre1034/2021/OOWATRXX1", "Aansluitdocument Rijk", "2021-12-01");
const AT_BRENNERBAAN = [OMGEVINGSWET, AANSLUITDOCUMENT, VISIE_PV26, BAL, OMGEVINGSPLAN_UTRECHT, WSV_HDSR, DAKKAPELLEN, NOVI, VERORDENING_PV26];
const BRENNERBAAN_150 = { weergavenaam: "Brennerbaan 150, 3524BN Utrecht", type: "adres", woonplaatsnaam: "Utrecht", gemeentenaam: "Utrecht", huisnummer: 150, huis_nlt: "150", postcode: "3524BN", centroide_rd: "POINT(138180.745 453109.293)" };

describe("DSO locatie: what was found per bestuurslaag", () => {
  beforeEach(resetDso);

  it("counts everything found per bestuurslaag and marks the records that are no rule document", async () => {
    mockDso((call) => (call.url.hostname === "api.pdok.nl" ? { response: { docs: [BRENNERBAAN_150] } } : zoekPage(AT_BRENNERBAAN)));
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ locatie: "Brennerbaan 150, Utrecht", rows: 3 });

    expect(out.items).toHaveLength(3);
    expect(out.perBestuurslaag).toEqual([
      { laag: "gemeente", aantal: 2 },
      { laag: "waterschap", aantal: 1 },
      { laag: "provincie", aantal: 2 },
      { laag: "Rijk", aantal: 4 },
    ]);
    expect(out.access_note).toContain("Op dit punt 9 documenten: gemeente 2, waterschap 1, provincie 2, Rijk 4.");
    expect(out.access_note).toContain("'Aansluitdocument Rijk' (technisch aansluitdocument) en 'Omgevingswet' (alleen een verwijzing naar de wet) geen regelgevende documenten");
    expect(out.access_note).toContain("Omgevingsvisies en programma's binden alleen het bestuursorgaan");
    expect(out.access_note).toContain("bestemmingsplannen en andere ruimtelijke plannen van vóór 2024 (IMRO)");
    expect(out.access_note).toContain("ruimtelijke_plannen_search (bbox '138176,453104,138186,453114')");

    const all = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ locatie: "Brennerbaan 150, Utrecht", rows: 20 });
    const wet = all.items.find((x) => x.identificatie === OMGEVINGSWET.identificatie);
    expect(wet).toMatchObject({ alleenVerwijzing: true, documentUrl: "https://wetten.overheid.nl/BWBR0037885" });
    expect(wet?.opmerking).toContain("in werking sinds 1 januari 2024");
    expect(all.items.find((x) => x.identificatie === AANSLUITDOCUMENT.identificatie)).toMatchObject({ technisch: true, opmerking: expect.stringContaining("bevat geen regels") });
    expect(all.items.filter((x) => x.alleenVerwijzing || x.technisch)).toHaveLength(2);
  });
});

describe("DSO omgevingsplan and its voorbeschermingsregels", () => {
  beforeEach(resetDso);

  const HYPERSCALE = regeling("mnre1034", "ministerie van Binnenlandse Zaken en Koninkrijksrelaties", "Voorbeschermingsregels Omgevingsplan", "/akn/nl/act/mnre1034/2023/OOWVbbTijdelijkDeel0344", "Voorbeschermingsregels hyperscale datacentra", "2024-01-01");
  const VBB_PV26 = regeling("pv26", "provincie Utrecht", "Voorbeschermingsregels", "/akn/nl/act/pv26/2023/12_18_gm0344", "Voorbereidingsbesluit provincie Utrecht 2023 - gemeente Utrecht", "2024-01-01");
  const VBB_NH = regeling("pv27", "provincie Noord-Holland", "Voorbeschermingsregels", "/akn/nl/act/pv27/2024/vbb_gm0363", "Voorbereidingsbesluit omgevingsverordening NH2022 gemeente Amsterdam", "2024-06-01");

  it("names a gemeente's own voorbeschermingsregels, which documentType 'omgevingsplan' leaves out, from the same answer", async () => {
    const calls = mockDso(() => zoekPage([DAKKAPELLEN, OMGEVINGSPLAN_UTRECHT, ACTIEPLAN_GELUID]));
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ bevoegdGezag: "gm0344", documentType: "omgevingsplan", rows: 20 });

    expect(calls).toHaveLength(1);
    expect(out.items.map((x) => x.title)).toEqual(["Omgevingsplan gemeente Utrecht"]);
    expect(out.access_note).toContain(`voorbeschermingsregels uit 1 voorbereidingsbesluit: '${DAKKAPELLEN.officieleTitel}' (${DAKKAPELLEN.identificatie}, sinds 2026-10-03)`);
    expect(out.access_note).toContain("documentType 'voorbereidingsbesluit'");

    resetDso();
    mockDso(() => zoekPage([OMGEVINGSPLAN_UTRECHT, ACTIEPLAN_GELUID]));
    const none = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ bevoegdGezag: "gm0344", documentType: "omgevingsplan", rows: 20 });
    expect(none.access_note).toContain("Voorbeschermingsregels (uit een voorbereidingsbesluit) bij het omgevingsplan: geen in het DSO.");
  });

  it("at a location: those of the omgevingsplan by any body, never a provincie's for its omgevingsverordening", async () => {
    mockDso((call) => (call.url.hostname === "api.pdok.nl" ? { response: { docs: [BRENNERBAAN_150] } } : zoekPage([OMGEVINGSPLAN_UTRECHT, DAKKAPELLEN, HYPERSCALE, VBB_PV26, VBB_NH, VERORDENING_PV26])));
    const out = await new DsoOmgevingsdocumentenSource(config, "test-key").search({ locatie: "Brennerbaan 150, Utrecht", documentType: "omgevingsplan", rows: 20 });

    expect(out.items.map((x) => x.title)).toEqual(["Omgevingsplan gemeente Utrecht"]);
    expect(out.access_note).toContain("voorbeschermingsregels uit 2 voorbereidingsbesluiten");
    expect(out.access_note).toContain(DAKKAPELLEN.identificatie);
    expect(out.access_note).toContain(`${HYPERSCALE.identificatie}, sinds 2024-01-01, ministerie van Binnenlandse Zaken en Koninkrijksrelaties`);
    expect(out.access_note).not.toContain(VBB_PV26.identificatie);
    expect(out.access_note).not.toContain("NH2022");
  });

  it("adds nothing for a provincie as bevoegd gezag or for another document type", async () => {
    mockDso(() => zoekPage([VBB_NH, VBB_PV26]));
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    expect((await src.search({ bevoegdGezag: "pv27", documentType: "omgevingsplan", rows: 20 })).access_note).not.toContain("oorbeschermingsregels");
    expect((await src.search({ bevoegdGezag: "gm0344", documentType: "programma", rows: 20 })).access_note).not.toContain("oorbeschermingsregels");
  });
});

/* ------------------------------------------------------------------ */
/*  Catalogue cache                                                    */
/* ------------------------------------------------------------------ */

describe("DSO catalogue cache", () => {
  beforeEach(resetDso);

  it("never keeps an empty catalogue: a DSO hiccup does not break names for hours", async () => {
    let empty = true;
    mockDso((call) => (call.method === "GET" ? (empty ? { page: { totalElements: 0 } } : cataloguePage(call, CATALOGUE)) : zoekPage([OMGEVINGSPLAN_UTRECHT])));
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");

    const err = await src.search({ bevoegdGezag: "Utrecht", rows: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(SourceRequestError);
    expect(err.code).toBe("malformed_response");
    empty = false;
    expect((await src.search({ bevoegdGezag: "Utrecht", rows: 5 })).bevoegdGezag?.code).toBe("gm0344");
  });

  it("may find another day's catalogue empty, and does not keep that either", async () => {
    const calls = mockDso(() => ({ page: { totalElements: 0 } }));
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    expect((await src.search({ query: "omgevingsplan", geldigOp: "2019-01-01", rows: 5 })).items).toEqual([]);
    await src.search({ query: "omgevingsplan", geldigOp: "2019-01-01", rows: 5 });
    expect(calls).toHaveLength(2);
  });

  it("keeps today's catalogue while other days come and go, the least recently used first", async () => {
    const calls = mockDso((call) => cataloguePage(call, CATALOGUE));
    const src = new DsoOmgevingsdocumentenSource(config, "test-key");
    const on = (geldigOp?: string) => src.search({ query: "omgevingsplan", geldigOp, rows: 5 });
    const loads = (geldigOp: string | null) => calls.filter((c) => c.url.searchParams.get("geldigOp") === geldigOp).length;

    await on();
    for (const day of ["2025-01-01", "2025-02-01", "2025-03-01"]) await on(day);
    await on("2025-01-01"); // used again: now the most recent of the three
    await on("2025-04-01"); // pushes out 2025-02-01, the least recently used
    await on("2025-01-01");
    expect(loads("2025-01-01")).toBe(1);
    await on("2025-02-01");
    expect(loads("2025-02-01")).toBe(2);

    // However many other days, today's stays.
    for (const day of ["2025-05-01", "2025-06-01", "2025-07-01", "2025-08-01"]) await on(day);
    await on();
    expect(loads(null)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/*  The search as a tool: summary, key, deadline                       */
/* ------------------------------------------------------------------ */

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
const tools = new Map<string, { schema: Record<string, { parse: (v: unknown) => unknown }>; handler: Handler }>();
registerTools({
  registerTool(name: string, cfg: { inputSchema?: Record<string, { parse: (v: unknown) => unknown }> }, handler: Handler) {
    tools.set(name, { schema: cfg.inputSchema ?? {}, handler });
  },
} as unknown as McpServer);

async function searchTool(args: Record<string, unknown>): Promise<Record<string, any>> {
  const tool = tools.get("dso_omgevingsdocumenten_search")!;
  const parsed: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.schema)) parsed[key] = schema.parse(args[key]);
  const out = await tool.handler(parsed);
  return JSON.parse(out.content[0].text);
}

describe("dso_omgevingsdocumenten_search as a tool", () => {
  beforeEach(() => {
    resetDso();
    vi.unstubAllEnvs();
  });

  it("gives the counts per bestuurslaag at a location, and marks the non-rule records in their title", async () => {
    vi.stubEnv("DSO_API_KEY", "test-key");
    mockDso((call) => (call.url.hostname === "api.pdok.nl" ? { response: { docs: [BRENNERBAAN_150] } } : zoekPage(AT_BRENNERBAAN)));
    const all = await searchTool({ locatie: "Brennerbaan 150, Utrecht" });
    expect(all.summary).toBe("9 DSO omgevingsdocumenten — Brennerbaan 150, 3524BN Utrecht (gemeente 2, waterschap 1, provincie 2, Rijk 4)");
    const titles = all.records.map((r: { title: string }) => r.title);
    expect(titles).toContain("Omgevingswet (alleen een verwijzing in het DSO)");
    expect(titles).toContain("Aansluitdocument Rijk (technisch DSO-document, geen regels)");

    const few = await searchTool({ locatie: "Brennerbaan 150, Utrecht", rows: 3 });
    expect(few.summary).toBe("3 DSO omgevingsdocumenten — Brennerbaan 150, 3524BN Utrecht (van 9: gemeente 2, waterschap 1, provincie 2, Rijk 4)");
  });

  it("counts the ontwerpen ter inzage apart from those possibly so", async () => {
    vi.stubEnv("DSO_API_KEY", "test-key");
    // Relative to the real today: the tool has no today of its own.
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const draft = (bill: string, bekendOp: string, termijn?: [string, string]) => ({
      identificatie: "/akn/nl/act/gm0001/2024/programma",
      technischId: `_akn_nl_act_gm0001_2024_programma${bill.replace(/[/-]/g, "_")}`,
      ontwerpbesluitIdentificatie: bill,
      officieleTitel: "Programma Voorbeeld",
      type: { code: TYPES.Programma, waarde: "Programma" },
      aangeleverdDoorEen: { naam: "gemeente Voorbeeld", bestuurslaag: "gemeente", code: "gm0001" },
      procedureverloop: {
        bekendOp,
        procedurestappen: termijn ? [{ soortStap: { waarde: "Begin inzagetermijn" }, voltooidOp: termijn[0] }, { soortStap: { waarde: "Einde inzagetermijn" }, voltooidOp: termijn[1] }] : [],
      },
    });
    mockDso((call) =>
      call.url.hostname === "identifier.overheid.nl"
        ? new Response(null, { status: 404 })
        : cataloguePage(call, [draft("/akn/nl/bill/gm0001/2026/1", day(-10), [day(-9), day(30)]), draft("/akn/nl/bill/gm0001/2026/2", day(-12)), draft("/akn/nl/bill/gm0001/2026/3", day(-11))], "ontwerpregelingen"),
    );
    const open = await searchTool({ alleen_ter_inzage: true });
    expect(open.summary).toBe("3 DSO ontwerp-omgevingsdocumenten (1 ter inzage, 2 mogelijk ter inzage)");
    const all = await searchTool({ soort: "ontwerpregelingen", query: "Voorbeeld" });
    expect(all.summary).toBe("3 DSO ontwerp-omgevingsdocumenten (waarvan 1 ter inzage, 2 mogelijk ter inzage)");
  });

  it("reads a key of only whitespace as missing, and never sends or repeats a key with characters no header holds", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("DSO_API_KEY", "   ");
    const blank = await searchTool({ bevoegdGezag: "gm0344" });
    expect(blank.error).toBe("not_configured");
    expect(blank.suggestion).toContain("api-key-aanvragen");

    vi.stubEnv("DSO_API_KEY", "FAKEKEY-CANARY\nX");
    const broken = await searchTool({ bevoegdGezag: "gm0344" });
    expect(broken.error).toBe("not_configured");
    expect(broken.message).toContain("ongeldige tekens");
    expect(JSON.stringify(broken)).not.toContain("CANARY");
    expect(fetchMock).not.toHaveBeenCalled();

    // The source itself refuses to send it, without quoting it.
    const err = await new DsoOmgevingsdocumentenSource(config, "FAKEKEY-CANARY\nX").search({ bevoegdGezag: "gm0344" }).catch((e) => e);
    expect(err.message).not.toContain("CANARY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives up after 45 s with a clear timeout, before the client's own 60 s", async () => {
    vi.stubEnv("DSO_API_KEY", "test-key");
    vi.spyOn(DsoOmgevingsdocumentenSource.prototype, "search").mockReturnValue(new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let out: Record<string, any> | undefined;
      const pending = searchTool({ bevoegdGezag: "Utrecht" }).then((v) => (out = v));
      await vi.advanceTimersByTimeAsync(44_999);
      expect(out).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(out).toMatchObject({ error: "timeout", message: "DSO Omgevingsdocumenten gaf binnen 45 s geen antwoord." });
    } finally {
      vi.useRealTimers();
    }
  });
});
