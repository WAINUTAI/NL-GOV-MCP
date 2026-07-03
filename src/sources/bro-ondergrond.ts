import type { AppConfig } from "../types.js";
import { getJson, getText } from "../utils/http.js";
import { parseXml } from "../utils/xml-parser.js";

/**
 * BRO (Basisregistratie Ondergrond) — publieke REST-services.
 *
 * Twee bevragingspaden op https://publiek.broservices.nl (keyless, geen PKI-cert
 * nodig voor deze publieke leveringsservices):
 *  1) Object-lookup op BRO-id (GMW/GLD/GMN/CPT/BHR). Deze registratieobject-services
 *     leveren XML (GML-achtig, dispatchDataResponse). getText + parseXml.
 *  2) Refcodes-domeinen (JSON) als een BRO-id-patroon niet herkend wordt: de
 *     zoekterm filtert de referentiecodelijsten op naam/omschrijving. getJson.
 */

const BRO_BASE = "https://publiek.broservices.nl";
const REFCODES_DOMAINS = `${BRO_BASE}/bro/refcodes/v1/domains`;

// BRO-id-prefix → leveringspad van de bijbehorende objectservice.
const OBJECT_SERVICE_PATHS: Record<string, string> = {
  GMW: "/gm/gmw/v1/objects/", // grondwatermonitoringput
  GLD: "/gm/gld/v1/objects/", // grondwaterstanddossier
  GMN: "/gm/gmn/v1/objects/", // grondwatermonitoringnet
  CPT: "/sr/cpt/v1/objects/", // sondering
  BHR: "/sr/bhrgt/v2/objects/", // geotechnisch booronderzoek
};

interface RefDomain {
  name?: unknown;
  uri?: unknown;
  description?: unknown;
}

interface BroItem {
  id: string;
  title: string;
  url: string;
  [key: string]: unknown;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** BRO-id = 3-letter objecttype + cijfers (bv. GMW000000036287). */
function detectObjectType(query: string): { broId: string; objectType: string; path: string } | undefined {
  const compact = query.trim().toUpperCase();
  const match = /^([A-Z]{3})\d{6,}$/.exec(compact);
  if (!match) return undefined;
  const prefix = match[1];
  const path = OBJECT_SERVICE_PATHS[prefix];
  if (!path) return undefined;
  return { broId: compact, objectType: prefix, path };
}

/**
 * Vind het registratieobject binnen dispatchDocument. De child-tag verschilt per
 * objecttype (GMW_PO, GLD_O, CPT_O, …); we pakken de eerste object-waarde.
 */
function findObjectNode(dispatchDocument: unknown): Record<string, unknown> | undefined {
  const dd = asObject(dispatchDocument);
  if (!dd) return undefined;
  for (const value of Object.values(dd)) {
    const node = asObject(value);
    if (node) return node;
  }
  return undefined;
}

export class BroOndergrondSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: { query: string; rows: number }) {
    const rows = Math.min(Math.max(args.rows, 1), this.config.limits.maxRows);
    const objectRef = detectObjectType(args.query);

    if (objectRef) {
      return this.lookupObject(objectRef);
    }
    return this.searchRefcodes(args.query, rows);
  }

  /** Pad 1: haal één BRO-object op via de XML-leveringsservice. */
  private async lookupObject(ref: { broId: string; objectType: string; path: string }) {
    const url = `${BRO_BASE}${ref.path}${ref.broId}`;
    const { data, meta } = await getText(url, {
      connector: "bro",
      timeoutMs: 15_000,
      retries: 1,
    });

    const parsed = asObject(parseXml(data));
    const response = asObject(parsed?.dispatchDataResponse) ?? parsed;
    const responseType = str(response?.responseType).toLowerCase();
    const node = findObjectNode(response?.dispatchDocument);

    if (!node || responseType === "rejection") {
      return {
        items: [],
        total: 0,
        endpoint: meta.url,
        params: { broId: ref.broId, objectType: ref.objectType },
        access_note: `Geen BRO-object gevonden voor '${ref.broId}' (${ref.objectType}).`,
      };
    }

    const broId = str(node.broId) || ref.broId;
    const registration = asObject(node.registrationHistory);
    const standardized = asObject(node.standardizedLocation);
    const stdLocation = asObject(standardized?.location);
    const delivered = asObject(node.deliveredLocation);
    const rdLocation = asObject(delivered?.location);

    // standardizedLocation levert WGS84 (EPSG:4258) als "lat lon".
    const wgsPos = str(stdLocation?.pos).trim();
    const [latRaw, lonRaw] = wgsPos.split(/\s+/);
    const wellCode = str(node.wellCode);
    const registrationTime = str(registration?.objectRegistrationTime);

    const item: BroItem = {
      id: broId,
      broId,
      title: `${ref.objectType} ${broId}${wellCode ? ` (${wellCode})` : ""}`.trim(),
      url,
      object_type: ref.objectType,
      quality_regime: str(node.qualityRegime),
      delivery_accountable_party: str(node.deliveryAccountableParty),
      registration_status: str(registration?.registrationStatus),
      registration_time: registrationTime,
      latitude: latRaw ?? "",
      longitude: lonRaw ?? "",
      rd_coordinates: str(rdLocation?.pos).trim(),
      well_code: wellCode,
      number_of_monitoring_tubes: str(node.numberOfMonitoringTubes),
      date: registrationTime,
    };

    return {
      items: [item],
      total: 1,
      endpoint: meta.url,
      params: { broId, objectType: ref.objectType },
      access_note:
        "BRO publieke leveringsservice (keyless); coördinaten in WGS84 (EPSG:4258) en RD (EPSG:28992).",
    };
  }

  /** Pad 2: filter de BRO-referentiecodedomeinen (JSON) op de zoekterm. */
  private async searchRefcodes(query: string, rows: number) {
    const { data, meta } = await getJson<{ refDomains?: unknown }>(REFCODES_DOMAINS, {
      connector: "bro",
      timeoutMs: 15_000,
      retries: 1,
    });

    const domains = Array.isArray(data?.refDomains)
      ? (data.refDomains as RefDomain[])
      : [];

    const q = query.trim().toLowerCase();
    const matched = q
      ? domains.filter((d) => {
          const hay = `${str(d.name)} ${str(d.description)}`.toLowerCase();
          return hay.includes(q);
        })
      : domains;

    const items: BroItem[] = matched.slice(0, rows).map((d) => {
      const name = str(d.name);
      return {
        id: name || "bro-refdomain",
        title: name || "BRO referentiedomein",
        url: REFCODES_DOMAINS,
        uri: str(d.uri),
        description: str(d.description),
        object_type: "refcode_domain",
      };
    });

    return {
      items,
      total: matched.length,
      endpoint: meta.url,
      params: { query, rows: String(rows) },
      access_note:
        "BRO refcodes-domeinen (keyless JSON). Geef een BRO-id (bv. GMW000000036287) om een object direct op te halen.",
    };
  }
}
