import type { AppConfig } from "../types.js";
import { getJson, getText } from "../utils/http.js";
import { validateRdBbox } from "../utils/geo.js";

// BAG panden and verblijfsobjecten per bbox, with bouwjaar, status and gebruiksdoel.
//
// Two PDOK services, because neither holds everything:
// - The BAG WFS (service.pdok.nl/lv/bag/wfs/v2_0) answers in a few hundred ms,
//   counts exactly (resultType=hits), filters on status/bouwjaar/gebruiksdoel
//   server-side and pages by startIndex. It holds only objects that still exist
//   or are about to: no 'Pand gesloopt', 'Niet gerealiseerd pand', 'Pand ten
//   onrechte opgevoerd', nor their verblijfsobject counterparts.
// - The BAG OGC API Features v2 (api.pdok.nl/kadaster/bag/ogc/v2) also holds
//   those ended statuses, with documentdatum/documentnummer and geconstateerd,
//   but gives no count, pages by cursor only and takes from one to sixty seconds
//   per request. It is asked only for the ended statuses.
//
// Both hosts match "pdok.nl" in inferConnectorName ("pdok_bag"), so every call
// passes its own connector: a slow OGC API must not trip the circuit of the WFS,
// and neither may trip the address tools.
export const BAG_WFS_ENDPOINT = "https://service.pdok.nl/lv/bag/wfs/v2_0";
export const BAG_OGC_BASE = "https://api.pdok.nl/kadaster/bag/ogc/v2";
export const BAG_WFS_CONNECTOR = "bag_panden_wfs";
export const BAG_OGC_CONNECTOR = "bag_panden_ogc";
const BAG_VIEWER = "https://bagviewer.kadaster.nl/lvbag/bag-viewer/";

const RD_URN = "urn:ogc:def:crs:EPSG::28992";
const WGS84_URN = "urn:ogc:def:crs:EPSG::4326";
const OGC_RD_CRS = "http://www.opengis.net/def/crs/EPSG/0/28992";
const OGC_CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84";
const OGC_PAGE = 1000;
/** Cursor pages per ended status: 5,000 demolished buildings is a whole town district. */
const OGC_MAX_PAGES = 5;

export type BagObjecttype = "pand" | "verblijfsobject";
export type BagBboxCrs = "EPSG:28992" | "WGS84";

/** Pand statuses the WFS holds, in BAG's own spelling. */
export const PAND_ACTIVE_STATUSES = [
  "Bouwvergunning verleend",
  "Bouw gestart",
  "Pand in gebruik (niet ingemeten)",
  "Pand in gebruik",
  "Verbouwing pand",
  "Sloopvergunning verleend",
  "Pand buiten gebruik",
] as const;
/** Pand statuses only the OGC API holds. */
export const PAND_ENDED_STATUSES = [
  "Pand gesloopt",
  "Niet gerealiseerd pand",
  "Pand ten onrechte opgevoerd",
] as const;
export const PAND_STATUSES = [...PAND_ACTIVE_STATUSES, ...PAND_ENDED_STATUSES] as const;

export const VBO_ACTIVE_STATUSES = [
  "Verblijfsobject gevormd",
  "Verblijfsobject in gebruik (niet ingemeten)",
  "Verblijfsobject in gebruik",
  "Verbouwing verblijfsobject",
  "Verblijfsobject buiten gebruik",
] as const;
export const VBO_ENDED_STATUSES = [
  "Verblijfsobject ingetrokken",
  "Niet gerealiseerd verblijfsobject",
  "Verblijfsobject ten onrechte opgevoerd",
] as const;
export const VBO_STATUSES = [...VBO_ACTIVE_STATUSES, ...VBO_ENDED_STATUSES] as const;

/** The gebruiksdoelen of the BAG (Catalogus BAG 2018), as the services spell them. */
export const BAG_GEBRUIKSDOELEN = [
  "woonfunctie",
  "bijeenkomstfunctie",
  "celfunctie",
  "gezondheidszorgfunctie",
  "industriefunctie",
  "kantoorfunctie",
  "logiesfunctie",
  "onderwijsfunctie",
  "sportfunctie",
  "winkelfunctie",
  "overige gebruiksfunctie",
] as const;

const ENDED: Record<BagObjecttype, readonly string[]> = {
  pand: PAND_ENDED_STATUSES,
  verblijfsobject: VBO_ENDED_STATUSES,
};
const ACTIVE: Record<BagObjecttype, readonly string[]> = {
  pand: PAND_ACTIVE_STATUSES,
  verblijfsobject: VBO_ACTIVE_STATUSES,
};

export interface BagObjectItem {
  objecttype: BagObjecttype;
  identificatie: string;
  title: string;
  status: string;
  bouwjaar?: number;
  /** As the source gives it: comma-separated for a pand with several functions. */
  gebruiksdoel?: string;
  gebruiksdoelen: string[];
  /** Pand: smallest and largest verblijfsobject oppervlakte inside it (WFS only). */
  oppervlakteMinM2?: number;
  oppervlakteMaxM2?: number;
  /** Verblijfsobject: gebruiksoppervlakte. */
  oppervlakteM2?: number;
  aantalVerblijfsobjecten?: number;
  /** Verblijfsobject: the pand(en) it lies in and that pand's status (WFS only). */
  pandIdentificatie?: string;
  pandStatus?: string;
  adres?: string;
  postcode?: string;
  woonplaats?: string;
  /** Date and number of the document behind the current status (OGC API only). */
  documentdatum?: string;
  documentnummer?: string;
  /** "J" when the object was registered from observation rather than from a permit (OGC API only). */
  geconstateerd?: string;
  lat?: number;
  lon?: number;
  bbox?: [number, number, number, number];
  bagUri?: string;
  url: string;
  bron: "wfs" | "ogc";
  geometry?: Record<string, unknown>;
}

export interface BagObjectSearchArgs {
  objecttype: BagObjecttype;
  bbox: string;
  bboxCrs: BagBboxCrs;
  /** Exact BAG statuses; omitted means every status the WFS holds (plus the ended ones with includeEnded). */
  statuses?: string[];
  includeEnded: boolean;
  bouwjaarMin?: number;
  bouwjaarMax?: number;
  gebruiksdoel?: string;
  offset: number;
  limit: number;
  includeGeometry: boolean;
}

export interface BagObjectSearchResult {
  items: BagObjectItem[];
  total: number | null;
  hasMore: boolean;
  endpoint: string;
  params: Record<string, string>;
  access_note?: string;
  failures: Array<{ connector: string; error: unknown }>;
}

interface GeoJsonFeature {
  id?: string;
  bbox?: number[];
  geometry?: { type?: string; coordinates?: unknown } & Record<string, unknown>;
  properties?: Record<string, unknown>;
}

interface GeoJsonCollection {
  features?: GeoJsonFeature[];
  links?: Array<{ rel?: string; href?: string }>;
}

type Bounds = [number, number, number, number];

/** NL in WGS84 with a margin, for validating a WGS84 bbox before it is sent. */
const WGS84_NL = { minLon: 2.5, maxLon: 7.6, minLat: 50.5, maxLat: 54 } as const;

export function parseBagBbox(
  bbox: string,
  crs: BagBboxCrs,
): { ok: true; bounds: Bounds } | { ok: false; reason: string } {
  if (crs === "EPSG:28992") {
    const v = validateRdBbox(bbox);
    if (!v.ok) return { ok: false, reason: v.reason ?? "invalid bbox" };
    return { ok: true, bounds: bbox.split(",").map((s) => Number(s.trim())) as Bounds };
  }
  const nums = bbox.split(",").map((s) => Number(s.trim()));
  if (nums.length !== 4) return { ok: false, reason: "bbox must have 4 comma-separated numbers (minlon,minlat,maxlon,maxlat in WGS84)" };
  if (nums.some((n) => !Number.isFinite(n))) return { ok: false, reason: "bbox contains non-numeric values" };
  const [minLon, minLat, maxLon, maxLat] = nums;
  if (minLon >= maxLon || minLat >= maxLat) return { ok: false, reason: "bbox min must be less than max for both axes" };
  if (minLon < WGS84_NL.minLon || maxLon > WGS84_NL.maxLon || minLat < WGS84_NL.minLat || maxLat > WGS84_NL.maxLat) {
    return { ok: false, reason: "bbox is outside the Netherlands (WGS84 lon 2.5..7.6, lat 50.5..54)" };
  }
  return { ok: true, bounds: [minLon, minLat, maxLon, maxLat] };
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A WGS84 envelope in urn:ogc:def:crs:EPSG::4326 is written lat/lon; RD is x/y. */
function envelope(bounds: Bounds, crs: BagBboxCrs): string {
  const [a, b, c, d] = bounds;
  const [lower, upper, srs] = crs === "EPSG:28992"
    ? [`${a} ${b}`, `${c} ${d}`, RD_URN]
    : [`${b} ${a}`, `${d} ${c}`, WGS84_URN];
  return `<gml:Envelope srsName="${srs}"><gml:lowerCorner>${lower}</gml:lowerCorner><gml:upperCorner>${upper}</gml:upperCorner></gml:Envelope>`;
}

const eq = (prop: string, value: string | number) =>
  `<PropertyIsEqualTo><ValueReference>${prop}</ValueReference><Literal>${xml(String(value))}</Literal></PropertyIsEqualTo>`;

/**
 * The FES 2.0 filter for one WFS query. The bbox goes inside it: WFS does not
 * allow the bbox parameter next to a filter.
 */
export function buildWfsFilter(args: {
  bounds: Bounds;
  crs: BagBboxCrs;
  statuses?: readonly string[];
  bouwjaarMin?: number;
  bouwjaarMax?: number;
  gebruiksdoel?: string;
}): string {
  const parts = [`<BBOX><ValueReference>geom</ValueReference>${envelope(args.bounds, args.crs)}</BBOX>`];
  if (args.statuses?.length) {
    const tests = args.statuses.map((s) => eq("status", s));
    parts.push(tests.length === 1 ? tests[0] : `<Or>${tests.join("")}</Or>`);
  }
  if (args.bouwjaarMin !== undefined) {
    parts.push(`<PropertyIsGreaterThanOrEqualTo><ValueReference>bouwjaar</ValueReference><Literal>${args.bouwjaarMin}</Literal></PropertyIsGreaterThanOrEqualTo>`);
  }
  if (args.bouwjaarMax !== undefined) {
    parts.push(`<PropertyIsLessThanOrEqualTo><ValueReference>bouwjaar</ValueReference><Literal>${args.bouwjaarMax}</Literal></PropertyIsLessThanOrEqualTo>`);
  }
  if (args.gebruiksdoel) {
    // A pand's gebruiksdoel is the comma-joined set of its verblijfsobjecten.
    parts.push(`<PropertyIsLike wildCard="*" singleChar="." escapeChar="!"><ValueReference>gebruiksdoel</ValueReference><Literal>*${xml(args.gebruiksdoel)}*</Literal></PropertyIsLike>`);
  }
  const body = parts.length === 1 ? parts[0] : `<And>${parts.join("")}</And>`;
  return `<Filter xmlns="http://www.opengis.net/fes/2.0" xmlns:gml="http://www.opengis.net/gml/3.2">${body}</Filter>`;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s ? s : undefined;
}

function boundsOf(feature: GeoJsonFeature): Bounds | undefined {
  if (Array.isArray(feature.bbox) && feature.bbox.length >= 4 && feature.bbox.every((n) => typeof n === "number")) {
    return [feature.bbox[0], feature.bbox[1], feature.bbox[2], feature.bbox[3]];
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
      minX = Math.min(minX, node[0]);
      minY = Math.min(minY, node[1]);
      maxX = Math.max(maxX, node[0]);
      maxY = Math.max(maxY, node[1]);
      return;
    }
    for (const child of node) walk(child);
  };
  walk(feature.geometry?.coordinates);
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : undefined;
}

function splitDoelen(value: string | undefined): string[] {
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function huisnummerLabel(props: Record<string, unknown>): string {
  const nummer = str(props.huisnummer) ?? "";
  const letter = str(props.huisletter) ?? "";
  const toevoeging = str(props.toevoeging) ?? "";
  return `${nummer}${letter}${toevoeging ? `-${toevoeging}` : ""}`;
}

export function bagViewerUrl(identificatie: string): string {
  return `${BAG_VIEWER}?objectId=${encodeURIComponent(identificatie)}`;
}

/** Normalise one WFS or OGC API feature (CRS84 lon/lat) into an item. */
export function toBagItem(
  objecttype: BagObjecttype,
  feature: GeoJsonFeature,
  bron: "wfs" | "ogc",
  includeGeometry: boolean,
): BagObjectItem {
  const p = feature.properties ?? {};
  const identificatie = str(p.identificatie) ?? String(feature.id ?? "");
  const status = str(p.status) ?? "";
  const bouwjaar = num(p.bouwjaar);
  const gebruiksdoel = str(p.gebruiksdoel);
  const bounds = boundsOf(feature);

  const item: BagObjectItem = {
    objecttype,
    identificatie,
    title: "",
    status,
    gebruiksdoel,
    gebruiksdoelen: splitDoelen(gebruiksdoel),
    url: bagViewerUrl(identificatie),
    bron,
  };
  if (bouwjaar !== undefined) item.bouwjaar = bouwjaar;
  if (bounds) {
    item.bbox = bounds;
    item.lon = (bounds[0] + bounds[2]) / 2;
    item.lat = (bounds[1] + bounds[3]) / 2;
  }
  const uri = str(p.rdf_seealso);
  if (uri) item.bagUri = uri;
  const datum = str(p.documentdatum);
  if (datum) item.documentdatum = datum;
  const docnr = str(p.documentnummer);
  if (docnr) item.documentnummer = docnr;
  const geconstateerd = str(p.geconstateerd);
  if (geconstateerd) item.geconstateerd = geconstateerd;

  if (objecttype === "pand") {
    const min = num(p.oppervlakte_min);
    const max = num(p.oppervlakte_max);
    if (min !== undefined) item.oppervlakteMinM2 = min;
    if (max !== undefined) item.oppervlakteMaxM2 = max;
    const aantal = num(p.aantal_verblijfsobjecten);
    if (aantal !== undefined) item.aantalVerblijfsobjecten = aantal;
    item.title = `Pand ${identificatie}${bouwjaar !== undefined ? ` (${bouwjaar})` : ""}`;
  } else {
    const opp = num(p.oppervlakte);
    if (opp !== undefined) item.oppervlakteM2 = opp;
    const straat = str(p.openbare_ruimte) ?? str(p.openbare_ruimte_naam);
    const woonplaats = str(p.woonplaats) ?? str(p.woonplaats_naam);
    const postcode = str(p.postcode);
    if (straat) item.adres = `${straat} ${huisnummerLabel(p)}`.trim();
    if (postcode) item.postcode = postcode;
    if (woonplaats) item.woonplaats = woonplaats;
    const pandId = str(p.pandidentificatie);
    if (pandId) item.pandIdentificatie = pandId;
    const pandStatus = str(p.pandstatus);
    if (pandStatus) item.pandStatus = pandStatus;
    item.title = item.adres
      ? [item.adres, [postcode, woonplaats].filter(Boolean).join(" ")].filter(Boolean).join(", ")
      : `Verblijfsobject ${identificatie}`;
  }

  if (includeGeometry && feature.geometry) item.geometry = feature.geometry as Record<string, unknown>;
  return item;
}

function parseHits(text: string): number | undefined {
  const match = /numberMatched="(\d+)"/.exec(text);
  return match ? Number(match[1]) : undefined;
}

export class BagPandenSource {
  /** Concurrent calls for the same count share one request (the map pages a bbox in parallel). */
  private readonly hitsInFlight = new Map<string, Promise<number>>();

  constructor(private readonly config: AppConfig) {}

  /** The plan a dry run reports: the WFS query, and the OGC API when ended statuses are asked. */
  plan(args: Pick<BagObjectSearchArgs, "objecttype" | "statuses" | "includeEnded">): { wfs: boolean; ogcStatuses: string[] } {
    const split = this.splitStatuses(args.objecttype, args.statuses, args.includeEnded);
    return { wfs: split.wfs, ogcStatuses: split.ended };
  }

  private splitStatuses(objecttype: BagObjecttype, statuses: string[] | undefined, includeEnded: boolean): {
    wfs: boolean;
    active?: string[];
    ended: string[];
  } {
    if (!statuses?.length) {
      return { wfs: true, active: undefined, ended: includeEnded ? [...ENDED[objecttype]] : [] };
    }
    const unique = [...new Set(statuses)];
    const active = unique.filter((s) => ACTIVE[objecttype].includes(s));
    const ended = unique.filter((s) => ENDED[objecttype].includes(s));
    return { wfs: active.length > 0, active, ended };
  }

  private wfsQuery(objecttype: BagObjecttype, filter: string): Record<string, string> {
    return {
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: `bag:${objecttype}`,
      filter,
    };
  }

  private wfsHits(objecttype: BagObjecttype, filter: string): Promise<number> {
    const key = `${objecttype}|${filter}`;
    const pending = this.hitsInFlight.get(key);
    if (pending) return pending;
    const promise = getText(BAG_WFS_ENDPOINT, {
      query: { ...this.wfsQuery(objecttype, filter), resultType: "hits" },
      connector: BAG_WFS_CONNECTOR,
      timeoutMs: 15_000,
    })
      .then(({ data }) => {
        const n = parseHits(data);
        if (n === undefined) throw new Error("BAG WFS hits response without numberMatched");
        return n;
      })
      .finally(() => this.hitsInFlight.delete(key));
    this.hitsInFlight.set(key, promise);
    return promise;
  }

  private async wfsPage(objecttype: BagObjecttype, filter: string, startIndex: number, count: number): Promise<{ features: GeoJsonFeature[]; url: string }> {
    const { data, meta } = await getJson<GeoJsonCollection>(BAG_WFS_ENDPOINT, {
      query: {
        ...this.wfsQuery(objecttype, filter),
        outputFormat: "application/json",
        // EPSG:4326 in this short form makes MapServer answer in CRS84 lon/lat.
        srsName: "EPSG:4326",
        // A stable order is what makes startIndex paging repeatable.
        sortBy: "identificatie",
        startIndex: String(startIndex),
        count: String(count),
      },
      connector: BAG_WFS_CONNECTOR,
      timeoutMs: 20_000,
    });
    return { features: data.features ?? [], url: meta.url };
  }

  /** Every feature of one ended status in the bbox, by cursor; `capped` when the page cap cut it. */
  private async ogcStatus(objecttype: BagObjecttype, status: string, bbox: string, crs: BagBboxCrs): Promise<{ features: GeoJsonFeature[]; capped: boolean; url: string }> {
    const features: GeoJsonFeature[] = [];
    let url: string | undefined = `${BAG_OGC_BASE}/collections/${objecttype}/items`;
    let query: Record<string, string> | undefined = {
      f: "json",
      limit: String(OGC_PAGE),
      bbox,
      "bbox-crs": crs === "EPSG:28992" ? OGC_RD_CRS : OGC_CRS84,
      status,
      profile: "rel-as-key",
    };
    let firstUrl = url;
    for (let page = 0; page < OGC_MAX_PAGES && url; page += 1) {
      const { data, meta }: { data: GeoJsonCollection; meta: { url: string } } = await getJson<GeoJsonCollection>(url, {
        ...(query ? { query } : {}),
        connector: BAG_OGC_CONNECTOR,
        timeoutMs: 30_000,
        retries: 1,
      });
      if (page === 0) firstUrl = meta.url;
      features.push(...(data.features ?? []));
      url = (data.links ?? []).find((l) => l.rel === "next")?.href;
      // The next link carries every parameter, the cursor included.
      query = undefined;
    }
    return { features, capped: Boolean(url), url: firstUrl };
  }

  async search(args: BagObjectSearchArgs): Promise<BagObjectSearchResult> {
    const { objecttype } = args;
    const params: Record<string, string> = { objecttype, bbox: args.bbox, bbox_crs: args.bboxCrs };
    if (args.statuses?.length) params.status = args.statuses.join("|");
    if (args.includeEnded) params.inclusief_beeindigd = "true";
    if (args.bouwjaarMin !== undefined) params.bouwjaar_min = String(args.bouwjaarMin);
    if (args.bouwjaarMax !== undefined) params.bouwjaar_max = String(args.bouwjaarMax);
    if (args.gebruiksdoel) params.gebruiksdoel = args.gebruiksdoel;

    const parsed = parseBagBbox(args.bbox, args.bboxCrs);
    if (!parsed.ok) {
      return { items: [], total: 0, hasMore: false, endpoint: BAG_WFS_ENDPOINT, params, failures: [], access_note: `Ongeldige bbox: ${parsed.reason}.` };
    }

    const split = this.splitStatuses(objecttype, args.statuses, args.includeEnded);
    const filter = buildWfsFilter({
      bounds: parsed.bounds,
      crs: args.bboxCrs,
      statuses: split.active,
      bouwjaarMin: args.bouwjaarMin,
      bouwjaarMax: args.bouwjaarMax,
      gebruiksdoel: args.gebruiksdoel,
    });
    const failures: BagObjectSearchResult["failures"] = [];
    const notes: string[] = [];

    // The ended statuses are fetched whole: they have no count to page against,
    // and the http cache keeps them for the next page of the same query.
    const endedPromise = split.ended.length
      ? Promise.allSettled(split.ended.map((s) => this.ogcStatus(objecttype, s, args.bbox, args.bboxCrs)))
      : Promise.resolve([]);

    let activeTotal = 0;
    let activeItems: BagObjectItem[] = [];
    let endpoint = BAG_WFS_ENDPOINT;
    if (split.wfs) {
      // Count and page side by side: a page past the end simply comes back empty.
      const [hits, page] = await Promise.all([
        this.wfsHits(objecttype, filter),
        this.wfsPage(objecttype, filter, args.offset, args.limit),
      ]);
      activeTotal = hits;
      endpoint = page.url;
      activeItems = page.features.map((f) => toBagItem(objecttype, f, "wfs", args.includeGeometry));
    }

    let ended: BagObjectItem[] = [];
    let endedCapped = false;
    const settled = await endedPromise;
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") {
        if (!split.wfs && i === 0) endpoint = result.value.url;
        endedCapped ||= result.value.capped;
        ended.push(...result.value.features.map((f) => toBagItem(objecttype, f, "ogc", args.includeGeometry)));
      } else {
        failures.push({ connector: BAG_OGC_CONNECTOR, error: result.reason });
      }
    });
    // Nothing came back at all: let the tool report the error itself.
    if (!split.wfs && failures.length && failures.length === settled.length) throw failures[0].error;

    // The OGC API filters on one status per request; the rest is done here.
    ended = ended
      .filter((x) => args.bouwjaarMin === undefined || (x.bouwjaar !== undefined && x.bouwjaar >= args.bouwjaarMin))
      .filter((x) => args.bouwjaarMax === undefined || (x.bouwjaar !== undefined && x.bouwjaar <= args.bouwjaarMax))
      .filter((x) => !args.gebruiksdoel || x.gebruiksdoelen.includes(args.gebruiksdoel))
      .sort((a, b) => a.identificatie.localeCompare(b.identificatie));

    // One list: the WFS objects by identificatie, then the ended ones by identificatie.
    const endedStart = Math.max(0, args.offset - activeTotal);
    const room = args.limit - activeItems.length;
    const items = room > 0 && split.ended.length ? [...activeItems, ...ended.slice(endedStart, endedStart + room)] : activeItems;
    const total = activeTotal + ended.length;

    if (endedCapped) {
      notes.push(`Beëindigde statussen afgekapt op ${OGC_MAX_PAGES * OGC_PAGE} objecten per status; maak de bbox kleiner voor een volledige telling.`);
    }
    if (failures.length) {
      notes.push(`De PDOK BAG OGC API (${split.ended.join(", ")}) gaf geen antwoord; deze lijst bevat alleen de bestaande objecten uit de BAG WFS.`);
    }
    if (!split.ended.length && !args.statuses?.length && !args.includeEnded) {
      notes.push(objecttype === "pand"
        ? "Zonder status-filter: alle bestaande panden (WFS). Gesloopte, niet gerealiseerde en ten onrechte opgevoerde panden alleen met inclusief_beeindigd=true of een expliciete status."
        : "Zonder status-filter: alle bestaande verblijfsobjecten (WFS). Ingetrokken, niet gerealiseerde en ten onrechte opgevoerde alleen met inclusief_beeindigd=true of een expliciete status.");
    }
    if (!total) notes.push("PDOK BAG bereikbaar, maar geen objecten in deze bbox met deze filters.");
    notes.push("Bron: PDOK BAG (Kadaster), dagelijks bijgewerkt.");

    return {
      items,
      total: endedCapped ? null : total,
      hasMore: args.offset + items.length < total || endedCapped,
      endpoint,
      params,
      access_note: notes.join(" "),
      failures,
    };
  }
}
