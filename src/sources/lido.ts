import { ENV_KEYS } from "../config.js";
import type { AppConfig } from "../types.js";
import { getText, SourceRequestError } from "../utils/http.js";
import { parseXml } from "../utils/xml-parser.js";

/**
 * LiDO (Linked Data Overheid, KOOP/Logius) — verwijzingen.
 *
 * Tellingen (references) lopen via de door LiDO als "Publieke services"
 * gedocumenteerde endpoints get-id, get-aantal en get-aantal-per-informatietype
 * (https://linkeddata.overheid.nl/front/portal/services).
 *
 * De lijst met gekoppelde documenten (links) komt uit get-links. LiDO documenteert
 * die onder "Niet-publieke services" (gebruikersnaam + wachtwoord), maar dwingt dat
 * op dit moment niet af en valideert het ook niet. Zijn LIDO_USERNAME en
 * LIDO_PASSWORD allebei gezet, dan gaat HTTP Basic auth mee — uitsluitend op
 * get-links; get-id en get-aantal-per-informatietype blijven anoniem. /sparql
 * (weigert Basic auth), URI-dereferencing en portal-scraping worden niet gebruikt.
 */
const LIDO_SERVICE_BASE = "https://linkeddata.overheid.nl/service";
const LIDO_PORTAL_LIST = "https://linkeddata.overheid.nl/front/portal/spiegel-lijstweergave";
const LIDO_CONNECTOR = "lido";
const LIDO_TIMEOUT_MS = 20_000;
const LIDO_RETRIES = 1;

/** get-links: standaard paginagrootte van LiDO. */
export const LIDO_LINKS_DEFAULT_ROWS = 20;
/** get-links: hoogste rows die LiDO honoreert; daarboven valt het stil terug op 20. */
export const LIDO_LINKS_MAX_ROWS = 100;

const ECLI_RE = /^ECLI:[A-Z]{2}:[A-Z0-9]{1,7}:[0-9]{4}:[A-Z0-9.]{1,25}$/i;
const CELEX_RE = /^(?:CELEX:)?([1-9][0-9]{4}[A-Z]{1,2}[0-9]{1,6}(?:\([0-9]{1,3}\))?)$/i;
const BWB_RE = /^BWB[RV][0-9]{7}$/i;
const OEP_RE = /^(?:OEP:)?((?:stb|stcrt|trb|kst|blg|ah|h)-[0-9a-z]+(?:-[0-9a-z]+){1,4})$/i;
/** Artikelnummer zoals "29", "7:658", "6.2", "1a". */
const ARTIKEL_RE = /^[0-9A-Za-z]{1,10}(?:[.:][0-9A-Za-z]{1,10}){0,3}$/;
/**
 * Informatietype-filter voor get-links. Gaat als Solr-frasewaarde de query in, dus
 * strikt: alleen letters (ook met accent), cijfers, spaties en koppeltekens.
 */
const TYPE_LABEL_RE = /^[\p{L}0-9 -]{1,60}$/u;
const TYPE_LABEL_MAX = 60;

/**
 * Informatietype-labels zoals LiDO ze in zijn facetten gebruikt (live verzameld,
 * sept. 2026). Het filter is hoofdlettergevoelig ("wet" geeft 0, "Wet" 14), dus
 * invoer die hier hoofdletter- en accentongevoelig op past, krijgt de exacte
 * LiDO-spelling. Andere geldige labels gaan ongewijzigd door.
 */
const KNOWN_TYPE_LABELS = [
  "Amvb",
  "BWB Beleidsregel",
  "BWB Reglement",
  "Circulaire",
  "Europese Regelgeving",
  "Jurisprudentie",
  "KB",
  "Ministeriële-regeling",
  "Officiele overheidspublicatie",
  "Regeling ZBO",
  "Rijkswet",
  "Uitvoeringsinformatie",
  "Verdrag",
  "Wet",
  "Wet BES",
];

function foldLabel(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const KNOWN_TYPE_BY_KEY = new Map(KNOWN_TYPE_LABELS.map((label) => [foldLabel(label), label]));

export interface LidoResult {
  items: Array<Record<string, unknown>>;
  total: number | null;
  endpoint: string;
  params: Record<string, string>;
  access_note: string;
}

export interface LidoLinksResult extends LidoResult {
  /** 0-based offset van deze pagina binnen alle gekoppelde documenten. */
  offset: number;
  /** Gebruikte paginagrootte (rows), na begrenzing op 1..100. */
  limit: number;
  /**
   * Aantal entries dat LiDO op deze pagina gaf. LiDO telt en pagineert per
   * verwijzing (link): een document met meerdere verwijzingen van/naar het item
   * staat er meermaals. items bevat elk document één keer, dus paginering (has_more,
   * volgende offset) moet op dit getal rekenen, niet op items.length.
   */
  page_entries: number;
  /** LiDO-id van het opgevraagde item; null als LiDO het item niet kent. */
  lido_id: string | null;
  portal_url: string | null;
  subject_title: string | null;
  type_filter: string | null;
  per_type: Array<{ type: string; count: number }>;
  per_link_type: Array<{ label: string; count: number }>;
}

export type LidoDirection = "inkomend" | "uitgaand" | "beide";

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

/**
 * Valideer en normaliseer het informatietype-filter. Leeg/afwezig → null.
 * Gooit bij alles wat de Solr-query zou kunnen openbreken (quotes, backslashes,
 * dubbele punten, haakjes, accolades, wildcards, regeleinden, ...).
 */
export function normalizeLidoType(input: string | null | undefined): string | null {
  if (input === undefined || input === null) return null;
  const s = String(input).normalize("NFC").trim();
  if (!s) return null;
  if (s.length > TYPE_LABEL_MAX || !TYPE_LABEL_RE.test(s)) {
    throw new Error(
      `Ongeldig informatietype voor 'type': ${JSON.stringify(s.slice(0, TYPE_LABEL_MAX))}. ` +
        `Gebruik alleen letters, cijfers, spaties en koppeltekens (max. ${TYPE_LABEL_MAX} tekens), ` +
        'bijvoorbeeld "Jurisprudentie", "Wet" of "Verdrag".',
    );
  }
  return KNOWN_TYPE_BY_KEY.get(foldLabel(s)) ?? s;
}

/** Paginagrootte voor get-links: standaard 20, begrensd op 1..100 (LiDO-maximum). */
export function clampLidoRows(limit: number | null | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return LIDO_LINKS_DEFAULT_ROWS;
  return Math.min(LIDO_LINKS_MAX_ROWS, Math.max(1, Math.floor(limit)));
}

function clampOffset(offset: number | null | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
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

/**
 * Eerste niet-lege tekst van een (mogelijk herhaald) element. parseXml heeft XML-
 * entities en tekenreferenties al gedecodeerd; hier niet nog eens decoderen.
 */
function firstText(value: unknown): string | undefined {
  for (const node of asArray(value)) {
    const t = textOf(node)?.trim();
    if (t) return t;
  }
  return undefined;
}

function attrOf(node: unknown, name: string): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const v = (node as Record<string, unknown>)[name];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function objects(value: unknown): Array<Record<string, unknown>> {
  return asArray(value).filter((v): v is Record<string, unknown> => !!v && typeof v === "object");
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

/**
 * Basic-auth-header voor get-links, alleen als LIDO_USERNAME én LIDO_PASSWORD na
 * trimmen niet leeg zijn. Wordt per request uit process.env gelezen en nergens
 * anders bewaard, gelogd of teruggegeven.
 */
function lidoAuthHeader(): Record<string, string> | undefined {
  const user = (process.env[ENV_KEYS.LIDO_USERNAME] ?? "").trim();
  const pass = (process.env[ENV_KEYS.LIDO_PASSWORD] ?? "").trim();
  if (!user || !pass) return undefined;
  return { Authorization: `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}` };
}

function validateLidoInput(id: string, artikelInput: string | undefined) {
  const parsedId = parseLidoId(id);
  if (!parsedId) {
    throw new Error(
      `Onbekend LiDO-identifier: ${JSON.stringify(String(id ?? "").slice(0, 100))}. ` +
        "Gebruik een ECLI (ECLI:NL:HR:2019:2006), CELEX-nummer (32016L0680), BWB-id (BWBR0011823) " +
        "of OEP-publicatie (stb-2018-401).",
    );
  }
  const artikelRaw = artikelInput?.trim();
  const artikel = artikelRaw ? artikelRaw : null;
  if (artikel !== null) {
    if (parsedId.kind !== "bwb") {
      throw new Error("Parameter 'artikel' is alleen van toepassing op een BWB-id (bijv. BWBR0011823).");
    }
    if (!ARTIKEL_RE.test(artikel)) {
      throw new Error(`Ongeldig artikelnummer: ${JSON.stringify(artikel.slice(0, 40))}.`);
    }
  }
  return { parsedId, artikel };
}

function externalId(kind: Exclude<LidoKind, "bwb">, value: string): string {
  return kind === "ecli" ? value : kind === "celex" ? `CELEX:${value}` : `OEP:${value}`;
}

/** Facet-tellingen (naam → aantal), aflopend; null als het facet ontbreekt. */
function facetCounts(root: Record<string, unknown>, name: string): Array<{ label: string; count: number }> | null {
  const facetten = root.facetten;
  if (!facetten || typeof facetten !== "object") return null;
  const facet = objects((facetten as Record<string, unknown>).facet).find((f) => f.name === name);
  if (!facet) return null;
  return objects(facet.int)
    .map((node) => ({ label: attrOf(node, "name") ?? "", count: Number.parseInt(textOf(node) ?? "", 10) }))
    .filter((f) => f.label && Number.isFinite(f.count))
    .sort((a, b) => b.count - a.count);
}

const ACCESS_NOTE_BASE =
  "Bron: LiDO (Linked Data Overheid) van KOOP/Logius, licentie CC0. Dit zijn tellingen van " +
  "inkomende en uitgaande verwijzingen uit de publieke LiDO-services (get-id, " +
  "get-aantal-per-informatietype); de volledige lijst met verwijzingen is te bekijken op portal_url.";

const ACCESS_NOTE_BWB =
  " Let op: bij wetgeving (BWB) gelden de aantallen voor de door get-id teruggegeven, meest " +
  "recente versie van de regeling of het artikel (zie lido_id). Verwijzingen naar oudere " +
  "versies tellen niet mee, dus het werkelijke aantal verwijzingen kan fors hoger liggen.";

const ACCESS_NOTE_LINKS =
  "Bron: LiDO (Linked Data Overheid) van KOOP/Logius, licentie CC0. Deze lijst komt uit de " +
  "LiDO-service get-links, die LiDO als niet-publieke service documenteert; een LiDO-account " +
  "wordt daarvoor op dit moment niet afgedwongen. direction is relatief ten opzichte van het " +
  "opgevraagde item: 'uitgaand' = het opgevraagde item verwijst ernaar, 'inkomend' = het verwijst " +
  "naar het opgevraagde item, 'beide' = wederzijds. total telt verwijzingen (som van de " +
  "informatietype-facetten, zelfde telling als lido_verwijzingen) en offset/limit lopen over die " +
  "verwijzingen; een document met meer dan één verwijzing staat per pagina één keer in de lijst. " +
  "De lijst staat ook op portal_url.";

export class LidoSource {
  constructor(private readonly config: AppConfig) {}

  private async fetchXml(service: string, query: Record<string, string>, headers?: Record<string, string>) {
    const { data, meta } = await getText(`${LIDO_SERVICE_BASE}/${service}`, {
      query,
      connector: LIDO_CONNECTOR,
      timeoutMs: LIDO_TIMEOUT_MS,
      retries: LIDO_RETRIES,
      ...(headers ? { headers } : {}),
    });
    return { root: lidoRoot(data), url: meta.url };
  }

  /** BWB (+ artikel) → LiDO-id van de meest recente versie via get-id; id null als LiDO niets vindt. */
  private async resolveBwb(value: string, artikel: string | null): Promise<{ id: string | null; url: string; ref: string }> {
    const ref = artikel !== null ? `${value}&artikel=${artikel}` : value;
    const idResp = await this.fetchXml("get-id", { "juriconnect-ref": ref });
    const found = textOf(idResp.root.id)?.trim();
    return { id: found ? found : null, url: idResp.url, ref };
  }

  async references(args: { id: string; artikel?: string }): Promise<LidoResult> {
    const { parsedId, artikel } = validateLidoInput(args.id, args.artikel);

    const { kind, value } = parsedId;
    const params: Record<string, string> = { id: value };
    if (artikel !== null) params.artikel = artikel;
    const accessNote = kind === "bwb" ? ACCESS_NOTE_BASE + ACCESS_NOTE_BWB : ACCESS_NOTE_BASE;

    let countQuery: Record<string, string>;
    let lidoId: string | null = null;
    let portal: string;

    if (kind === "bwb") {
      const resolved = await this.resolveBwb(value, artikel);
      params["juriconnect-ref"] = resolved.ref;
      if (!resolved.id) {
        return { items: [], total: 0, endpoint: resolved.url, params, access_note: accessNote };
      }
      lidoId = resolved.id;
      countQuery = { id: resolved.id };
      portal = portalUrl("id", resolved.id);
    } else {
      const extId = externalId(kind, value);
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

  /**
   * De gekoppelde documenten zelf (inkomend en uitgaand), gepagineerd via get-links.
   * offset → start (0-based offset in de lijst), limit → rows (1..100).
   */
  async links(args: { id: string; artikel?: string; type?: string; offset?: number; limit?: number }): Promise<LidoLinksResult> {
    const { parsedId, artikel } = validateLidoInput(args.id, args.artikel);
    const typeFilter = normalizeLidoType(args.type);
    const offset = clampOffset(args.offset);
    const rows = clampLidoRows(args.limit);

    const { kind, value } = parsedId;
    const params: Record<string, string> = { id: value };
    if (artikel !== null) params.artikel = artikel;
    if (typeFilter !== null) params.type = typeFilter;
    params.start = String(offset);
    params.rows = String(rows);
    const accessNote = kind === "bwb" ? ACCESS_NOTE_LINKS + ACCESS_NOTE_BWB : ACCESS_NOTE_LINKS;

    const empty = (endpoint: string): LidoLinksResult => ({
      items: [],
      total: 0,
      endpoint,
      params,
      access_note: accessNote,
      offset,
      limit: rows,
      page_entries: 0,
      lido_id: null,
      portal_url: null,
      subject_title: null,
      type_filter: typeFilter,
      per_type: [],
      per_link_type: [],
    });

    let itemQuery: Record<string, string>;
    let extId: string | null = null;
    if (kind === "bwb") {
      const resolved = await this.resolveBwb(value, artikel);
      params["juriconnect-ref"] = resolved.ref;
      if (!resolved.id) return empty(resolved.url);
      itemQuery = { id: resolved.id };
    } else {
      extId = externalId(kind, value);
      params["ext-id"] = extId;
      itemQuery = { "ext-id": extId };
    }

    const query: Record<string, string> = { ...itemQuery, output: "xml", start: String(offset), rows: String(rows) };
    // Ongedocumenteerd voor get-links, maar dezelfde filtersyntax die LiDO zelf in
    // de portaal-URL's van get-aantal-per-informatietype zet.
    if (typeFilter !== null) query.fq = `{!tag=obj_type}obj_type:"${typeFilter}"`;

    const auth = lidoAuthHeader();
    let resp: { root: Record<string, unknown>; url: string };
    try {
      resp = await this.fetchXml("get-links", query, auth);
    } catch (error) {
      if (error instanceof SourceRequestError && (error.status === 401 || error.status === 403)) {
        throw new Error(
          auth
            ? `LiDO weigert get-links met de ingestelde inloggegevens (HTTP ${error.status}). ` +
                "Controleer LIDO_USERNAME en LIDO_PASSWORD; die lijken onjuist of niet (meer) geldig."
            : `LiDO vereist nu een account voor get-links (HTTP ${error.status}). ` +
                "Stel LIDO_USERNAME en LIDO_PASSWORD in (account aan te vragen via https://linkeddata.overheid.nl). " +
                "Alleen tellingen zijn zonder account beschikbaar via lido_verwijzingen.",
        );
      }
      if (error instanceof SourceRequestError && error.status === 400 && extId !== null) {
        // get-links beantwoordt een onbekend ext-id met een lege HTTP 400. Niet elke
        // 400 als "onbekend" lezen: bevestigen via de publieke telling (id="").
        const check = await this.fetchXml("get-aantal-per-informatietype", { "ext-id": extId });
        const knownId = typeof check.root.id === "string" ? check.root.id.trim() : "";
        if (!knownId) return empty(check.url);
      }
      throw error;
    }

    const root = resp.root;
    const subjects = objects(root.subject);
    const rootLidoId = attrOf(root, "lido-id");
    const self = (rootLidoId ? subjects.find((s) => attrOf(s, "id") === rootLidoId) : undefined) ?? subjects[0];
    if (!self) {
      // Geen subject voor het opgevraagde item zelf: LiDO kent het niet. Niets verzinnen.
      return empty(resp.url);
    }
    const selfId = attrOf(self, "id") ?? rootLidoId ?? null;

    // Richting per gekoppeld item, vanuit de links van het opgevraagde item.
    const incoming = new Map<string, Set<string>>();
    const outgoing = new Map<string, Set<string>>();
    const collect = (container: unknown, into: Map<string, Set<string>>) => {
      const refs = container && typeof container === "object" ? objects((container as Record<string, unknown>)["subject-ref"]) : [];
      for (const ref of refs) {
        const idref = attrOf(ref, "idref");
        if (!idref) continue;
        const labels = into.get(idref) ?? new Set<string>();
        const label = attrOf(ref, "label");
        if (label) labels.add(label);
        into.set(idref, labels);
      }
    };
    collect(self["inkomende-links"], incoming);
    collect(self["uitgaande-links"], outgoing);

    const entries = subjects.filter((s) => s !== self);
    const mapped = entries.map((s) => {
      const lidoId = attrOf(s, "id") ?? null;
      const intern = objects(s.identifier).find((n) => n.type === "intern");
      const extern = objects(s.identifier).find((n) => n.type === "extern");
      const typeNode = asArray(s.type as unknown)[0];

      let inc = lidoId ? incoming.get(lidoId) : undefined;
      let out = lidoId ? outgoing.get(lidoId) : undefined;
      if (!inc && !out && selfId) {
        // Terugval op de gespiegelde relatie in het gekoppelde item zelf.
        const mirrorIn = new Map<string, Set<string>>();
        const mirrorOut = new Map<string, Set<string>>();
        collect(s["inkomende-links"], mirrorIn);
        collect(s["uitgaande-links"], mirrorOut);
        out = mirrorIn.get(selfId);
        inc = mirrorOut.get(selfId);
      }
      const direction: LidoDirection | null = inc && out ? "beide" : out ? "uitgaand" : inc ? "inkomend" : null;
      const labels = [...new Set([...(out ?? []), ...(inc ?? [])])];

      return {
        lido_id: lidoId ?? firstText(intern) ?? null,
        external_id: firstText(extern) ?? null,
        title: firstText(s.title) ?? null,
        type: firstText(typeNode) ?? null,
        type_uri: attrOf(typeNode, "resourceIdentifier") ?? null,
        creator: firstText(s.creator) ?? null,
        authority: firstText(s.authority) ?? null,
        modified: firstText(s.modified) ?? null,
        url: firstText(s.hasVersion) ?? null,
        direction,
        link_labels: labels,
        juriconnect: firstText(s.heeftJuriconnect) ?? null,
      };
    });

    // LiDO geeft één entry per verwijzing: een document met meerdere verwijzingen
    // van/naar het item (beide richtingen, of dezelfde verwijzing twee keer) staat
    // er meermaals, direct na elkaar. Richting en labels zijn hierboven al per
    // document samengevoegd, dus de herhaling voegt niets toe. Dedupe binnen de
    // pagina; paginering rekent verder op page_entries (zie LidoLinksResult).
    const seen = new Set<string>();
    const items = mapped.filter((item) => {
      if (!item.lido_id) return true;
      if (seen.has(item.lido_id)) return false;
      seen.add(item.lido_id);
      return true;
    });

    const perTypeFacet = facetCounts(root, "obj_type");
    const perType = (perTypeFacet ?? []).map((f) => ({ type: f.label, count: f.count }));
    const perLinkType = facetCounts(root, "link_type") ?? [];
    const total = perTypeFacet ? perType.reduce((sum, t) => sum + t.count, 0) : null;

    const portal = kind === "bwb" ? (selfId ? portalUrl("id", selfId) : null) : portalUrl("ext-id", extId as string);

    return {
      items,
      total,
      endpoint: resp.url,
      params,
      access_note: accessNote,
      offset,
      limit: rows,
      page_entries: entries.length,
      lido_id: selfId,
      portal_url: portal,
      subject_title: firstText(self.title) ?? null,
      type_filter: typeFilter,
      per_type: perType,
      per_link_type: perLinkType,
    };
  }
}
