import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

/**
 * EP-Online — het landelijke register van energielabels (RVO).
 * Publieke API v5: https://public.ep-online.nl/swagger/index.html
 *
 * Auth: standaard `Authorization`-header met de kale API-key als waarde
 * (geen "Bearer "-prefix). Bevestigd via /swagger/v5/swagger.json
 * ("Standaard Authorization header met de API-key").
 */
const EP_ONLINE_BASE = "https://public.ep-online.nl/api/v5";

/** Publieke register-website (canonical fallback-link per label). */
const EP_ONLINE_SITE = "https://www.ep-online.nl";

/** Ruwe upstream-vorm (PandEnergielabelV5, PascalCase). Alles optioneel + defensief. */
interface EpLabelRaw {
  Energieklasse?: string;
  Registratiedatum?: string;
  Opnamedatum?: string;
  Geldig_tot?: string;
  Gebouwtype?: string;
  Gebouwklasse?: string;
  Gebouwsubtype?: string;
  Postcode?: string;
  Huisnummer?: number;
  Huisletter?: string | null;
  Huisnummertoevoeging?: string | null;
  Detailaanduiding?: string | null;
  BAGVerblijfsobjectID?: string | null;
  BAGLigplaatsID?: string | null;
  BAGStandplaatsID?: string | null;
  BAGPandIDs?: string[] | null;
  EnergieIndex?: number | null;
  Energiebehoefte?: number | null;
  PrimaireFossieleEnergie?: number | null;
  Aandeel_hernieuwbare_energie?: number | null;
  BerekendeEnergieverbruik?: number | null;
  Bouwjaar?: number;
  Certificaathouder?: string | null;
}

export interface EpOnlineSearchArgs {
  /** Postcode zonder spatie, bijv. "3511LX". Vereist samen met huisnummer (tenzij bagId). */
  postcode?: string;
  /** Huisnummer. Vereist samen met postcode (tenzij bagId). */
  huisnummer?: string | number;
  huisletter?: string;
  huisnummertoevoeging?: string;
  detailaanduiding?: string;
  /** BAG verblijfsobject-id — gebruikt het AdresseerbaarObject-endpoint i.p.v. Adres. */
  bagId?: string;
  rows: number;
}

export interface EpOnlineItem {
  id: string;
  title: string;
  url: string;
  energieklasse?: string;
  registratiedatum?: string;
  opnamedatum?: string;
  geldigTot?: string;
  gebouwtype?: string;
  gebouwklasse?: string;
  gebouwsubtype?: string;
  postcode?: string;
  huisnummer?: number;
  huisletter?: string;
  huisnummertoevoeging?: string;
  bagVerblijfsobjectId?: string;
  bagPandIds?: string[];
  energieIndex?: number;
  energiebehoefte?: number;
  primaireFossieleEnergie?: number;
  aandeelHernieuwbareEnergie?: number;
  berekendEnergieverbruik?: number;
  bouwjaar?: number;
  certificaathouder?: string;
}

/** Normaliseer postcode: verwijder spaties, uppercase (EP-Online eist ^[1-9][0-9]{3}[A-Z]{2}$). */
function normalizePostcode(postcode: string): string {
  return postcode.replace(/\s+/g, "").toUpperCase();
}

/**
 * Beide endpoints kunnen een array van labels teruggeven, of (afhankelijk van
 * upstream-gedrag) een enkel object. Narrow defensief naar een array.
 */
function asLabels(data: unknown): EpLabelRaw[] {
  if (Array.isArray(data)) return data as EpLabelRaw[];
  if (data && typeof data === "object") return [data as EpLabelRaw];
  return [];
}

function optString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value);
  return s.trim() === "" ? undefined : s;
}

function optNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function addressLabel(item: EpLabelRaw): string {
  const parts = [
    optString(item.Postcode),
    optNumber(item.Huisnummer) !== undefined ? String(item.Huisnummer) : undefined,
    optString(item.Huisletter),
    optString(item.Huisnummertoevoeging),
  ].filter(Boolean);
  return parts.join(" ").trim();
}

function normalize(item: EpLabelRaw): EpOnlineItem {
  const address = addressLabel(item);
  const klasse = optString(item.Energieklasse) ?? "onbekend";
  const bagId = optString(item.BAGVerblijfsobjectID);
  const bagPandIds = Array.isArray(item.BAGPandIDs)
    ? item.BAGPandIDs.map((x) => String(x)).filter((x) => x.trim() !== "")
    : undefined;
  return {
    id: bagId ?? address ?? "ep-online-label",
    title: `Energielabel ${klasse}${address ? ` — ${address}` : ""}`,
    url: EP_ONLINE_SITE,
    energieklasse: optString(item.Energieklasse),
    registratiedatum: optString(item.Registratiedatum),
    opnamedatum: optString(item.Opnamedatum),
    geldigTot: optString(item.Geldig_tot),
    gebouwtype: optString(item.Gebouwtype),
    gebouwklasse: optString(item.Gebouwklasse),
    gebouwsubtype: optString(item.Gebouwsubtype),
    postcode: optString(item.Postcode),
    huisnummer: optNumber(item.Huisnummer),
    huisletter: optString(item.Huisletter),
    huisnummertoevoeging: optString(item.Huisnummertoevoeging),
    bagVerblijfsobjectId: bagId,
    bagPandIds: bagPandIds && bagPandIds.length > 0 ? bagPandIds : undefined,
    energieIndex: optNumber(item.EnergieIndex),
    energiebehoefte: optNumber(item.Energiebehoefte),
    primaireFossieleEnergie: optNumber(item.PrimaireFossieleEnergie),
    aandeelHernieuwbareEnergie: optNumber(item.Aandeel_hernieuwbare_energie),
    berekendEnergieverbruik: optNumber(item.BerekendeEnergieverbruik),
    bouwjaar: optNumber(item.Bouwjaar),
    certificaathouder: optString(item.Certificaathouder),
  };
}

export class EpOnlineSource {
  constructor(
    private readonly config: AppConfig,
    private readonly apiKey: string,
  ) {}

  async search(args: EpOnlineSearchArgs): Promise<{
    items: EpOnlineItem[];
    total: number;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const headers: Record<string, string> = {
      // EP-Online verwacht de kale API-key als Authorization-waarde (geen "Bearer").
      Authorization: this.apiKey,
      Accept: "application/json",
    };

    const bagId = optString(args.bagId);
    const params: Record<string, string> = {};

    let url: string;
    let query: Record<string, string> | undefined;

    if (bagId) {
      url = `${EP_ONLINE_BASE}/PandEnergielabel/AdresseerbaarObject/${encodeURIComponent(bagId)}`;
      params.bagId = bagId;
    } else {
      const postcode = optString(args.postcode);
      const huisnummer =
        args.huisnummer !== undefined && args.huisnummer !== null
          ? String(args.huisnummer).trim()
          : undefined;
      if (!postcode || !huisnummer) {
        throw new Error(
          "ep_online_energielabel vereist postcode + huisnummer, of een bagId.",
        );
      }
      const normalizedPostcode = normalizePostcode(postcode);
      query = { postcode: normalizedPostcode, huisnummer };
      const huisletter = optString(args.huisletter);
      const huisnummertoevoeging = optString(args.huisnummertoevoeging);
      const detailaanduiding = optString(args.detailaanduiding);
      if (huisletter) query.huisletter = huisletter;
      if (huisnummertoevoeging) query.huisnummertoevoeging = huisnummertoevoeging;
      if (detailaanduiding) query.detailaanduiding = detailaanduiding;

      url = `${EP_ONLINE_BASE}/PandEnergielabel/Adres`;
      Object.assign(params, query);
    }

    const { data, meta } = await getJson<unknown>(url, {
      query,
      headers,
      connector: "ep_online",
    });

    const labels = asLabels(data);
    const items = labels.slice(0, Math.max(1, args.rows)).map(normalize);

    return {
      items,
      total: labels.length,
      endpoint: meta.url,
      params,
      access_note:
        "Bron: EP-Online energielabelregister (RVO), publieke API v5. Alleen geregistreerde labels; een adres zonder label geeft een leeg resultaat.",
    };
  }
}
