import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import {
  BAG_OGC_BASE,
  BAG_WFS_ENDPOINT,
  BagPandenSource,
  buildWfsFilter,
  parseBagBbox,
  toBagItem,
} from "../src/sources/bag-panden.js";
import { clearHttpCache, getConnectorCategory } from "../src/utils/connector-runtime.js";

const config = loadConfig();
const BBOX = "132800,453500,134600,455300";

function jsonResponse(p: unknown, status = 200): Response {
  return new Response(JSON.stringify(p), { status, headers: { "content-type": "application/json" } });
}

function hitsResponse(n: number): Response {
  return new Response(
    `<?xml version="1.0"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="${n}" numberReturned="0"></wfs:FeatureCollection>`,
    { status: 200, headers: { "content-type": "text/xml" } },
  );
}

const wfsPand = (id: string, status: string, bouwjaar = 1960) => ({
  type: "Feature",
  id: `pand.${id}`,
  bbox: [5.09, 52.08, 5.0902, 52.0802],
  geometry: { type: "Polygon", coordinates: [[[5.09, 52.08], [5.0902, 52.08], [5.0902, 52.0802], [5.09, 52.08]]] },
  properties: {
    identificatie: id,
    rdf_seealso: `http://bag.basisregistraties.overheid.nl/bag/id/pand/${id}`,
    bouwjaar,
    status,
    gebruiksdoel: "kantoorfunctie,woonfunctie",
    oppervlakte_min: 40,
    oppervlakte_max: 120,
    aantal_verblijfsobjecten: 6,
  },
});

const ogcPand = (id: string, status: string, bouwjaar = 1961) => ({
  type: "Feature",
  id: `uuid-${id}`,
  geometry: { type: "Polygon", coordinates: [[[5.08, 52.07], [5.0804, 52.07], [5.0804, 52.0702], [5.08, 52.07]]] },
  properties: {
    identificatie: id,
    rdf_seealso: `http://bag.basisregistraties.overheid.nl/bag/id/pand/${id}`,
    bouwjaar,
    status,
    gebruiksdoel: null,
    aantal_verblijfsobjecten: 0,
    documentdatum: "2022-08-25",
    documentnummer: "HZ_WABO-22-11583",
    geconstateerd: "N",
  },
});

/** Route a mocked fetch by service: WFS hits, WFS GetFeature, OGC API items. */
function routedFetch(handlers: {
  hits?: (url: URL) => Response;
  wfs?: (url: URL) => Response;
  ogc?: (url: URL) => Response;
}) {
  return vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    if (url.href.startsWith(BAG_WFS_ENDPOINT)) {
      if (url.searchParams.get("resultType") === "hits") return handlers.hits?.(url) ?? hitsResponse(0);
      return handlers.wfs?.(url) ?? jsonResponse({ type: "FeatureCollection", features: [] });
    }
    if (url.href.startsWith(BAG_OGC_BASE)) return handlers.ogc?.(url) ?? jsonResponse({ type: "FeatureCollection", features: [], links: [] });
    throw new Error(`unexpected url ${url.href}`);
  });
}

describe("BAG panden helpers", () => {
  it("validates RD and WGS84 bboxes", () => {
    expect(parseBagBbox(BBOX, "EPSG:28992")).toEqual({ ok: true, bounds: [132800, 453500, 134600, 455300] });
    expect(parseBagBbox("5.085,52.075,5.105,52.09", "WGS84")).toEqual({ ok: true, bounds: [5.085, 52.075, 5.105, 52.09] });
    expect(parseBagBbox("1,2,3", "EPSG:28992").ok).toBe(false);
    expect(parseBagBbox(BBOX, "WGS84").ok).toBe(false);
    expect(parseBagBbox("5.1,52.09,5.0,52.07", "WGS84").ok).toBe(false);
  });

  it("puts the bbox inside the FES filter, lat/lon for WGS84, with an Or over statuses", () => {
    const rd = buildWfsFilter({ bounds: [132800, 453500, 134600, 455300], crs: "EPSG:28992" });
    expect(rd).toContain("<BBOX>");
    expect(rd).toContain("urn:ogc:def:crs:EPSG::28992");
    expect(rd).toContain("<gml:lowerCorner>132800 453500</gml:lowerCorner>");
    expect(rd).not.toContain("<And>");

    const wgs = buildWfsFilter({
      bounds: [5.085, 52.075, 5.105, 52.09],
      crs: "WGS84",
      statuses: ["Bouwvergunning verleend", "Bouw gestart"],
      bouwjaarMin: 2020,
      bouwjaarMax: 2030,
      gebruiksdoel: "woonfunctie",
    });
    expect(wgs).toContain("<gml:lowerCorner>52.075 5.085</gml:lowerCorner>");
    expect(wgs).toContain("<And>");
    expect(wgs).toContain("<Or>");
    expect(wgs).toContain("<Literal>Bouw gestart</Literal>");
    expect(wgs).toContain("PropertyIsGreaterThanOrEqualTo");
    expect(wgs).toContain("PropertyIsLessThanOrEqualTo");
    expect(wgs).toContain("<Literal>*woonfunctie*</Literal>");
  });

  it("normalises a WFS pand and an OGC verblijfsobject", () => {
    const pand = toBagItem("pand", wfsPand("0344100000000405", "Bouw gestart", 2025), "wfs", false);
    expect(pand).toMatchObject({
      identificatie: "0344100000000405",
      status: "Bouw gestart",
      bouwjaar: 2025,
      gebruiksdoelen: ["kantoorfunctie", "woonfunctie"],
      oppervlakteMinM2: 40,
      oppervlakteMaxM2: 120,
      aantalVerblijfsobjecten: 6,
      url: "https://bagviewer.kadaster.nl/lvbag/bag-viewer/?objectId=0344100000000405",
      bron: "wfs",
    });
    // The fixture is a triangle: its area centroid, not the bbox middle (which lies on its long side).
    expect(pand.lon).toBeCloseTo(5.0901333, 6);
    expect(pand.lat).toBeCloseTo(52.0800667, 6);
    expect(pand.bbox).toEqual([5.09, 52.08, 5.0902, 52.0802]);

    // A block around a courtyard: centroid and bbox middle both fall in the courtyard; the point goes onto the roof.
    const ring = (a: number, b: number) => [[5.09 + a, 52.08 + a], [5.09 + b, 52.08 + a], [5.09 + b, 52.08 + b], [5.09 + a, 52.08 + b], [5.09 + a, 52.08 + a]];
    const courtyard = toBagItem("pand", {
      geometry: { type: "Polygon", coordinates: [ring(0, 0.0004), ring(0.0001, 0.0003)] },
      properties: { identificatie: "0344100000000999", status: "Pand in gebruik" },
    }, "wfs", false);
    const inBlock = (v: number, base: number) => v - base > 0 && v - base < 0.0004;
    const inYard = (v: number, base: number) => v - base > 0.0001 && v - base < 0.0003;
    expect(inBlock(courtyard.lon!, 5.09) && inBlock(courtyard.lat!, 52.08)).toBe(true);
    expect(inYard(courtyard.lon!, 5.09) && inYard(courtyard.lat!, 52.08)).toBe(false);
    expect(pand.geometry).toBeUndefined();

    const vbo = toBagItem("verblijfsobject", {
      geometry: { type: "Point", coordinates: [5.09, 52.08] },
      properties: { identificatie: "0344010000003410", status: "Verblijfsobject ingetrokken", openbare_ruimte_naam: "Admiraal Helfrichlaan", huisnummer: 537, huisletter: "a", toevoeging: "2", postcode: "3527KV", woonplaats_naam: "Utrecht", oppervlakte: 81, gebruiksdoel: "woonfunctie" },
    }, "ogc", true);
    expect(vbo.title).toBe("Admiraal Helfrichlaan 537a-2, 3527KV Utrecht");
    expect(vbo.oppervlakteM2).toBe(81);
    expect(vbo.lat).toBe(52.08);
    expect(vbo.geometry).toEqual({ type: "Point", coordinates: [5.09, 52.08] });
  });
});

describe("BagPandenSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("counts with resultType=hits and pages the WFS by startIndex, sorted by identificatie", async () => {
    const fetchMock = routedFetch({
      hits: () => hitsResponse(1627),
      wfs: () => jsonResponse({ type: "FeatureCollection", features: [wfsPand("0344100000000001", "Bouwvergunning verleend")] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await new BagPandenSource(config).search({
      objecttype: "pand", bbox: BBOX, bboxCrs: "EPSG:28992", statuses: ["Bouwvergunning verleend"], includeEnded: false, offset: 400, limit: 200, includeGeometry: false,
    });

    expect(out.total).toBe(1627);
    expect(out.hasMore).toBe(true);
    expect(out.items[0].status).toBe("Bouwvergunning verleend");
    expect(out.failures).toEqual([]);
    const page = fetchMock.mock.calls.map((c) => new URL(String(c[0]))).find((u) => u.searchParams.get("outputFormat"));
    expect(page?.searchParams.get("startIndex")).toBe("400");
    expect(page?.searchParams.get("count")).toBe("200");
    expect(page?.searchParams.get("sortBy")).toBe("identificatie");
    expect(page?.searchParams.get("srsName")).toBe("EPSG:4326");
    expect(page?.searchParams.get("typeNames")).toBe("bag:pand");
    expect(page?.searchParams.get("filter")).toContain("<Literal>Bouwvergunning verleend</Literal>");
    // The WFS holds no ended statuses, so the OGC API is not asked.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith(BAG_OGC_BASE))).toBe(false);
  });

  it("asks the OGC API for an ended status, follows the cursor and filters bouwjaar locally", async () => {
    const fetchMock = routedFetch({
      ogc: (url) => url.searchParams.get("cursor")
        ? jsonResponse({ features: [ogcPand("0344100000000003", "Pand gesloopt", 1990)], links: [] })
        : jsonResponse({
            features: [ogcPand("0344100000000002", "Pand gesloopt", 1950), ogcPand("0344100000000001", "Pand gesloopt", 1975)],
            links: [{ rel: "next", href: `${BAG_OGC_BASE}/collections/pand/items?cursor=abc&f=json` }],
          }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await new BagPandenSource(config).search({
      objecttype: "pand", bbox: BBOX, bboxCrs: "EPSG:28992", statuses: ["Pand gesloopt"], includeEnded: false, bouwjaarMin: 1960, offset: 0, limit: 50, includeGeometry: false,
    });

    expect(out.items.map((x) => x.identificatie)).toEqual(["0344100000000001", "0344100000000003"]);
    expect(out.total).toBe(2);
    expect(out.items[0]).toMatchObject({ bron: "ogc", documentnummer: "HZ_WABO-22-11583", documentdatum: "2022-08-25", geconstateerd: "N" });
    const first = new URL(String(fetchMock.mock.calls[0][0]));
    expect(first.searchParams.get("status")).toBe("Pand gesloopt");
    expect(first.searchParams.get("bbox-crs")).toBe("http://www.opengis.net/def/crs/EPSG/0/28992");
    // No WFS request: only an ended status was asked.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith(BAG_WFS_ENDPOINT))).toBe(false);
  });

  it("lists the existing objects first, then the ended ones, across one offset", async () => {
    const fetchMock = routedFetch({
      hits: () => hitsResponse(2),
      wfs: (url) => jsonResponse({
        features: [wfsPand("0344100000000010", "Pand in gebruik"), wfsPand("0344100000000011", "Pand in gebruik")].slice(Number(url.searchParams.get("startIndex"))),
      }),
      ogc: (url) => jsonResponse({ features: url.searchParams.get("status") === "Pand gesloopt" ? [ogcPand("0344100000000001", "Pand gesloopt")] : [], links: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const src = new BagPandenSource(config);

    const all = await src.search({ objecttype: "pand", bbox: BBOX, bboxCrs: "EPSG:28992", includeEnded: true, offset: 0, limit: 10, includeGeometry: false });
    expect(all.items.map((x) => x.status)).toEqual(["Pand in gebruik", "Pand in gebruik", "Pand gesloopt"]);
    expect(all.total).toBe(3);
    expect(all.hasMore).toBe(false);
    const statuses = fetchMock.mock.calls.map((c) => new URL(String(c[0]))).filter((u) => u.href.startsWith(BAG_OGC_BASE)).map((u) => u.searchParams.get("status"));
    expect(statuses.sort()).toEqual(["Niet gerealiseerd pand", "Pand gesloopt", "Pand ten onrechte opgevoerd"]);

    const second = await src.search({ objecttype: "pand", bbox: BBOX, bboxCrs: "EPSG:28992", includeEnded: true, offset: 2, limit: 10, includeGeometry: false });
    expect(second.items.map((x) => x.identificatie)).toEqual(["0344100000000001"]);
  });

  it("keeps the WFS answer and reports a failure when the OGC API is down", async () => {
    vi.stubGlobal("fetch", routedFetch({
      hits: () => hitsResponse(1),
      wfs: () => jsonResponse({ features: [wfsPand("0344100000000010", "Bouw gestart")] }),
      ogc: () => jsonResponse({ code: "NotFound" }, 404),
    }));

    const out = await new BagPandenSource(config).search({
      objecttype: "pand", bbox: BBOX, bboxCrs: "EPSG:28992", statuses: ["Bouw gestart", "Pand gesloopt"], includeEnded: false, offset: 0, limit: 10, includeGeometry: false,
    });
    expect(out.items.map((x) => x.status)).toEqual(["Bouw gestart"]);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].connector).toBe("bag_panden_ogc");
    expect(out.access_note).toContain("alleen de bestaande objecten");
  });

  it("gives up on a hanging OGC API after beeindigd_timeout_ms, without retry, and keeps the WFS answer", async () => {
    let ogcCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.href.startsWith(BAG_WFS_ENDPOINT)) {
        if (url.searchParams.get("resultType") === "hits") return hitsResponse(1);
        return jsonResponse({ features: [wfsPand("0344100000000010", "Bouw gestart")] });
      }
      ogcCalls += 1;
      // Hangs until aborted, like the OGC API on a bad day.
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }));

    const started = Date.now();
    const out = await new BagPandenSource(config).search({
      objecttype: "pand", bbox: BBOX, bboxCrs: "EPSG:28992", statuses: ["Bouw gestart", "Pand gesloopt"], includeEnded: false, offset: 0, limit: 10, includeGeometry: false, endedTimeoutMs: 1_000,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ogcCalls).toBe(1);
    expect(out.items.map((x) => x.status)).toEqual(["Bouw gestart"]);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].connector).toBe("bag_panden_ogc");
  });

  it("answers an invalid bbox with a note and no request", async () => {
    const fetchMock = routedFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const out = await new BagPandenSource(config).search({ objecttype: "verblijfsobject", bbox: "1,2,3", bboxCrs: "EPSG:28992", includeEnded: false, offset: 0, limit: 10, includeGeometry: false });
    expect(out.items).toEqual([]);
    expect(out.access_note).toContain("Ongeldige bbox");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("files both connectors with their own circuits", () => {
    expect(getConnectorCategory("bag_panden_wfs")).toBe("semi_live");
    expect(getConnectorCategory("bag_panden_ogc")).toBe("semi_live");
  });
});

describe("bag_panden_search and bag_verblijfsobjecten_search tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bag-panden-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      return await fn(client);
    } finally {
      await client.close();
      await server.close();
    }
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return withClient(async (client) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }> };
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    });
  }

  it("lists both tools with bbox as the only required input", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      for (const name of ["bag_panden_search", "bag_verblijfsobjecten_search"]) {
        const tool = tools.find((t) => t.name === name);
        expect(tool).toBeDefined();
        expect((tool?.description ?? "").length).toBeLessThan(2048);
        expect(tool?.inputSchema.required).toEqual(["bbox"]);
        expect(tool?.annotations?.readOnlyHint).toBe(true);
      }
    });
  });

  it("returns records with status, bouwjaar, centroid and BAG viewer link, paged by the source", async () => {
    vi.stubGlobal("fetch", routedFetch({
      hits: () => hitsResponse(450),
      wfs: () => jsonResponse({ features: [wfsPand("0344100000000405", "Verbouwing pand", 1931)] }),
    }));

    const out = await callTool("bag_panden_search", { bbox: BBOX, status: ["Verbouwing pand"], offset: 200, limit: 1 });
    const records = out.records as Array<{ source_name: string; canonical_url: string; data: Record<string, unknown> }>;
    expect(records).toHaveLength(1);
    expect(records[0].source_name).toBe("bag_panden");
    expect(records[0].canonical_url).toBe("https://bagviewer.kadaster.nl/lvbag/bag-viewer/?objectId=0344100000000405");
    expect(records[0].data).toMatchObject({ status: "Verbouwing pand", bouwjaar: 1931, aantal_verblijfsobjecten: 6, bron: "PDOK BAG WFS" });
    expect(typeof records[0].data.lat).toBe("number");
    expect(out.pagination).toEqual({ offset: 200, limit: 1, total: 450, has_more: true });
    expect(out.summary).toBe("1 van 450 BAG panden");
    expect((out.provenance as { total_results?: number }).total_results).toBe(450);
  });

  it("rejects a pand status on the verblijfsobjecten tool", async () => {
    const result = await withClient((client) => client.callTool({ name: "bag_verblijfsobjecten_search", arguments: { bbox: BBOX, status: ["Pand gesloopt"] } })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("plans the WFS and the OGC API in a dry run", async () => {
    const fetchMock = routedFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const out = await callTool("bag_verblijfsobjecten_search", { bbox: BBOX, status: ["Verblijfsobject gevormd", "Verblijfsobject ingetrokken"], dryRun: true });
    expect(out.dry_run).toBe(true);
    expect(out.estimated_sources).toEqual(["bag_panden_wfs", "bag_panden_ogc"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
