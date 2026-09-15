import type { AppConfig } from "../types.js";
import { getText } from "../utils/http.js";
import { parseXml } from "../utils/xml-parser.js";

/**
 * LiDO (Linked Data Overheid, KOOP/Logius) — verwijzingstellingen.
 *
 * Bewust ALLEEN de door LiDO als "Publieke services" gedocumenteerde endpoints:
 * get-id, get-aantal en get-aantal-per-informatietype
 * (https://linkeddata.overheid.nl/front/portal/services). get-links, /sparql,
 * URI-dereferencing en portal-scraping zijn officieel niet-publiek of
 * ongedocumenteerd en worden hier niet gebruikt.
 */
const LIDO_SERVICE_BASE = "https://linkeddata.overheid.nl/service";
const LIDO_PORTAL_LIST = "https://linkeddata.overheid.nl/front/portal/spiegel-lijstweergave";
const LIDO_CONNECTOR = "lido";
const LIDO_TIMEOUT_MS = 20_000;
const LIDO_RETRIES = 1;

const ECLI_RE = /^ECLI:[A-Z]{2}:[A-Z0-9]{1,7}:[0-9]{4}:[A-Z0-9.]{1,25}$/i;
const CELEX_RE = /^(?:CELEX:)?([1-9][0-9]{4}[A-Z]{1,2}[0-9]{1,6}(?:\([0-9]{1,3}\))?)$/i;
const BWB_RE = /^BWB[RV][0-9]{7}$/i;
const OEP_RE = /^(?:OEP:)?((?:stb|stcrt|trb|kst|blg|ah|h)-[0-9a-z]+(?:-[0-9a-z]+){1,4})$/i;
/** Artikelnummer zoals "29", "7:658", "6.2", "1a". */
const ARTIKEL_RE = /^[0-9A-Za-z]{1,10}(?:[.:][0-9A-Za-z]{1,10}){0,3}$/;

export interface LidoResult {
  items: Array<Record<string, unknown>>;
  total: number | null;
  endpoint: string;
  params: Record<string, string>;
  access_note: string;
}

type LidoKind = "ecli" | "celex" | "bwb" | "oep";

export function parseLidoId(input: string): { kind: LidoKind; value: string } | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s || s.length > 80) return null;
  if (ECLI_RE.test(s)) return { kind: "ecli", value: s.toUpperCase() };
  if (BWB_RE.test(s)) return { kind: "bwb", value: s.toUpperCase() };
  const celex = CELEX_RE.exec(s);
  if (celex) return { kind: "celex", value: celex[1].toUpperCase() };
  const oep = OEP_RE.exec(s);
  if (oep) return { kind: "oep", value: oep[1].toLowerCase() };
  return null;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const t = (value as Record<string, unknown>)["#text"];
    if (typeof t === "string" || typeof t === "number") return String(t);
  }
  return undefined;
}

function lidoRoot(xml: string): Record<string, unknown> {
  const parsed = parseXml(xml) as Record<string, unknown> | undefined;
  const root = parsed?.lido;
  if (!root || typeof root !== "object") {
    throw new Error("LiDO gaf een onverwacht antwoord (geen <lido>-element).");
  }
  return root as Record<string, unknown>;
}

function portalUrl(param: "ext-id" | "id", value: string): string {
  const u = new URL(LIDO_PORTAL_LIST);
  u.searchParams.set(param, value);
  return u.toString();
}

const ACCESS_NOTE_BASE =
  "Bron: LiDO (Linked Data Overheid) van KOOP/Logius, licentie CC0. Dit zijn tellingen van " +
  "inkomende en uitgaande verwijzingen uit de publieke LiDO-services (get-id, " +
  "get-aantal-per-informatietype); de volledige lijst met verwijzingen is te bekijken op portal_url.";

const ACCESS_NOTE_BWB =
  " Let op: bij wetgeving (BWB) gelden de aantallen voor de door get-id teruggegeven, meest " +
  "recente versie van de regeling of het artikel (zie lido_id). Verwijzingen naar oudere " +
  "versies tellen niet mee, dus het werkelijke aantal verwijzingen kan fors hoger liggen.";

export class LidoSource {
  constructor(private readonly config: AppConfig) {}

  private async fetchXml(service: string, query: Record<string, string>) {
    const { data, meta } = await getText(`${LIDO_SERVICE_BASE}/${service}`, {
      query,
      connector: LIDO_CONNECTOR,
      timeoutMs: LIDO_TIMEOUT_MS,
      retries: LIDO_RETRIES,
    });
    return { root: lidoRoot(data), url: meta.url };
  }

  async references(args: { id: string; artikel?: string }): Promise<LidoResult> {
    const parsedId = parseLidoId(args.id);
    if (!parsedId) {
      throw new Error(
        `Onbekend LiDO-identifier: ${JSON.stringify(String(args.id ?? "").slice(0, 100))}. ` +
          "Gebruik een ECLI (ECLI:NL:HR:2019:2006), CELEX-nummer (32016L0680), BWB-id (BWBR0011823) " +
          "of OEP-publicatie (stb-2018-401).",
      );
    }
    const artikelRaw = args.artikel?.trim();
    const artikel = artikelRaw ? artikelRaw : null;
    if (artikel !== null) {
      if (parsedId.kind !== "bwb") {
        throw new Error("Parameter 'artikel' is alleen van toepassing op een BWB-id (bijv. BWBR0011823).");
      }
      if (!ARTIKEL_RE.test(artikel)) {
        throw new Error(`Ongeldig artikelnummer: ${JSON.stringify(artikel.slice(0, 40))}.`);
      }
    }

    const { kind, value } = parsedId;
    const params: Record<string, string> = { id: value };
    if (artikel !== null) params.artikel = artikel;
    const accessNote = kind === "bwb" ? ACCESS_NOTE_BASE + ACCESS_NOTE_BWB : ACCESS_NOTE_BASE;

    let countQuery: Record<string, string>;
    let lidoId: string | null = null;
    let portal: string;

    if (kind === "bwb") {
      const ref = artikel !== null ? `${value}&artikel=${artikel}` : value;
      const idResp = await this.fetchXml("get-id", { "juriconnect-ref": ref });
      params["juriconnect-ref"] = ref;
      const found = textOf(idResp.root.id)?.trim();
      if (!found) {
        return { items: [], total: 0, endpoint: idResp.url, params, access_note: accessNote };
      }
      lidoId = found;
      countQuery = { id: found };
      portal = portalUrl("id", found);
    } else {
      const extId = kind === "ecli" ? value : kind === "celex" ? `CELEX:${value}` : `OEP:${value}`;
      params["ext-id"] = extId;
      countQuery = { "ext-id": extId };
      portal = portalUrl("ext-id", extId);
    }

    const countResp = await this.fetchXml("get-aantal-per-informatietype", countQuery);
    const endpoint = countResp.url;
    const rootId = typeof countResp.root.id === "string" ? countResp.root.id.trim() : "";
    if (rootId) lidoId = rootId;
    if (!lidoId) {
      // LiDO kent dit item niet (id=""): geen record verzinnen.
      return { items: [], total: 0, endpoint, params, access_note: accessNote };
    }

    const perType = asArray(countResp.root.aantal as unknown)
      .map((node) => {
        const obj = node && typeof node === "object" ? (node as Record<string, unknown>) : {};
        const type = typeof obj["informatietype-label"] === "string" ? obj["informatietype-label"] : "";
        const count = Number.parseInt(textOf(node) ?? "", 10);
        return { type: type.trim(), count };
      })
      .filter((t) => t.type && Number.isFinite(t.count))
      .sort((a, b) => b.count - a.count);

    const total = perType.reduce((sum, t) => sum + t.count, 0);
    const label = kind === "bwb" && artikel !== null ? `${value} artikel ${artikel}` : params["ext-id"] ?? value;

    return {
      items: [
        {
          input_id: args.id.trim(),
          kind,
          artikel,
          lido_id: lidoId,
          total_references: total,
          per_type: perType,
          portal_url: portal,
          title: `LiDO-verwijzingen naar ${label}`,
        },
      ],
      total: 1,
      endpoint,
      params,
      access_note: accessNote,
    };
  }
}
