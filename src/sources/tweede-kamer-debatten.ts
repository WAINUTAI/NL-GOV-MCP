/**
 * What was said in Tweede Kamer debates: the verslagen of the Gegevensmagazijn
 * (VLOS XML), one per vergadering: a plenaire vergaderdag with all its debates,
 * or one commissiedebat. Every spreekbeurt and interruptie becomes a fragment
 * with its spreker, fractie or functie, tijdstip and text.
 *
 * The API has no full-text search over verslagen. A search therefore lists the
 * vergaderingen of a period (newest first), downloads at most
 * DEBAT_MAX_VERSLAGEN verslagen per call and matches here; vergadering_offset
 * continues where a call stopped. A debat has its verslag the same day, as an
 * ongecorrigeerde tussenpublicatie; the gecorrigeerde eindpublicatie follows
 * weeks later. The official record is the Handelingen.
 */
import { getJson, getText, SourceRequestError } from "../utils/http.js";
import { foldText, parseXmlTree, type XmlElement, type XmlNode } from "./dso-regeltekst.js";
import { parseTkQuery, tkDayRange, TweedeKamerInputError, type TkSearchTerm } from "./tweede-kamer.js";
import type { AppConfig } from "../types.js";

/** Verslagen downloaded per call: a plenaire vergaderdag is up to 3 MB, a commissiedebat about 300 kB. */
export const DEBAT_MAX_VERSLAGEN = 20;
/** The period searched when no date is given: the last week. */
export const DEBAT_DEFAULT_DAYS = 7;
export const DEBAT_DEFAULT_CHARS = 1_500;
export const DEBAT_MAX_CHARS = 20_000;
const CONCURRENCY = 4;
const SNIPPET_RADIUS = 160;
// A plenaire dag is megabytes of text even parsed: few are kept. Room for one search
// (DEBAT_MAX_VERSLAGEN) plus the verslagen of a Gehoord koppeling (4) right after it,
// so the nl_gov_ask fallback does not download again what the search just read.
const PARSED_CACHE_MAX = 24;
// The Vergadering list of today: a plenaire vergadering gets a new tussenpublicatie every hour or so.
const TODAY_LIST_TTL_MS = 60_000;
const LIST_TIMEOUT_MS = 20_000;
const VERSLAG_TIMEOUT_MS = 30_000;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type DebatSoort = "plenair" | "commissie";

export interface DebatFragment {
  /** Position in the verslag, from 1: fragments of one verslag are in the order they were spoken. */
  volgnummer: number;
  /** The debat: the onderwerp of the activiteit in the verslag (a plenaire dag holds several). */
  debat: string;
  debat_soort?: string;
  /** "woordvoerder" holds the floor; "interrumpant" interrupts a woordvoerder. */
  rol: "woordvoerder" | "interrumpant";
  voorzitter: boolean;
  /** "Annelotte Lammers"; verslagnaam is the name the verslag uses ("Lammers"). */
  spreker: string;
  verslagnaam: string;
  fractie?: string;
  /** "minister van Justitie en Veiligheid"; for a Kamerlid "lid Tweede Kamer". */
  functie?: string;
  spreker_soort?: string;
  /** The TK Persoon GUID: the objectid of <spreker>; Gehoord.de's speakerLabel for the Tweede Kamer. */
  persoon_id?: string;
  begin?: string;
  eind?: string;
  tekst: string;
}

/**
 * One <activiteit> of a verslag: a debate, or the opening, the regeling van
 * werkzaamheden, the sluiting. Its objectid is the Debat Direct id of the
 * debate, which Gehoord.de calls tkDebateId: the direct link from a Gehoord
 * debate to its part of the verslag. It is not the Activiteit Id of the
 * OData API. A begrotingsdebat split over the day is one activiteit per part,
 * each with its own objectid and the same parlisid.
 */
export interface DebatActiviteit {
  objectid: string;
  soort?: string;
  titel: string;
  onderwerp?: string;
  /** The Activiteit Nummer ('2026A05087') when the verslag fills it; the commissievergadering page on tweedekamer.nl. */
  parlisid?: string;
  /** Local Amsterdam time, as written. */
  aanvang?: string;
  eind?: string;
  /** Its fragments, nested activiteiten included: fragments[fragmentVan .. fragmentTot - 1]. */
  fragmentVan: number;
  fragmentTot: number;
}

export interface DebatVerslag {
  verslag_id: string;
  /** Plenair or Commissie. */
  soort: string;
  titel: string;
  zaal?: string;
  vergaderjaar?: string;
  vergaderingnummer?: string;
  datum?: string;
  aanvang?: string;
  /** Ongecorrigeerd, Gecorrigeerd or Gerectificeerd. */
  status?: string;
  /** Tussenpublicatie or Eindpublicatie. */
  publicatie?: string;
  /** When the vergadering was closed (its Sluiting activiteit), local time: the verslag holds the whole vergadering. */
  sluiting?: string;
  fragments: DebatFragment[];
  /** Every activiteit in document order, with its block of fragments. */
  activiteiten: DebatActiviteit[];
}

/* ------------------------------------------------------------------ */
/*  Parsing                                                            */
/* ------------------------------------------------------------------ */

function elements(node: XmlElement, name?: string): XmlElement[] {
  return node.children.filter((c): c is XmlElement => typeof c !== "string" && (!name || c.name === name));
}

function first(node: XmlElement | undefined, name: string): XmlElement | undefined {
  return node ? elements(node, name)[0] : undefined;
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function inline(node: XmlNode): string {
  return typeof node === "string" ? node : node.children.map(inline).join("");
}

function childText(node: XmlElement | undefined, name: string): string {
  const child = first(node, name);
  return child ? squash(inline(child)) : "";
}

/** "2026-10-05T14:31:42" as written: Dutch local time without an offset. */
function localTime(value: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ? value : undefined;
}

/** The paragraphs of a <tekst>: every <alinea>, its items run on, motions in an <alineagroep> included. */
function paragraphs(node: XmlElement): string[][] {
  const out: string[][] = [];
  for (const child of elements(node)) {
    if (child.name === "alinea") {
      const items = elements(child, "alineaitem").map((item) => squash(inline(item))).filter(Boolean);
      if (items.length) out.push(items);
    } else {
      out.push(...paragraphs(child));
    }
  }
  return out;
}

/**
 * The text of a spreekbeurt without the label it opens with ("Mevrouw
 * <nadruk>Lammers</nadruk> (Groep Markuszower):"), which repeats the spreker.
 */
export function vlosText(tekst: XmlElement | undefined): string {
  if (!tekst) return "";
  const paras = paragraphs(tekst);
  const label = paras[0]?.[0];
  if (label && label.endsWith(":") && label.length <= 160) paras[0] = paras[0].slice(1);
  return paras.map((items) => items.join(" ")).filter(Boolean).join("\n");
}

const TUSSENVOEGSELS = /^(?:(?:van|de|den|der|ten|ter|te|het|'t|in|op|aan|uit|von)\s+)+/i;

/** "Thom" and "Van Campen" make "Thom van Campen"; "Tony van Dijck" already holds the first name. */
export function sprekerNaam(voornaam: string, verslagnaam: string): string {
  if (!voornaam) return verslagnaam;
  if (!verslagnaam) return voornaam;
  if (foldText(verslagnaam).startsWith(`${foldText(voornaam)} `)) return verslagnaam;
  return `${voornaam} ${verslagnaam.replace(TUSSENVOEGSELS, (m) => m.toLowerCase())}`;
}

/**
 * The moties a woordvoerder reads out. VLOS puts each in a <draadboekfragment
 * soort="Motie indiening"> inside the woordvoerder, after its <tekst>, and the
 * woordvoerder's markeertijden cover the reading: without them a spreekbeurt
 * of moties would be "Daarom deze moties." Only the motie itself, not the
 * chair's note on its number (alineagroep Motieinfo).
 */
function motieTexts(node: XmlElement): string[] {
  return elements(node, "draadboekfragment")
    .filter((d) => /^motie/i.test(d.attrs.soort ?? ""))
    .map((d) => {
      const tekst = first(d, "tekst");
      if (!tekst) return "";
      const parts = elements(tekst).filter((c) => !(c.name === "alineagroep" && c.attrs.type === "Motieinfo"));
      return paragraphs({ ...tekst, children: parts }).map((items) => items.join(" ")).filter(Boolean).join("\n");
    })
    .filter(Boolean);
}

function fragmentOf(node: XmlElement, debat: { titel: string; soort?: string }, volgnummer: number): DebatFragment | undefined {
  const tekst = [vlosText(first(node, "tekst")), ...motieTexts(node)].filter(Boolean).join("\n");
  if (!tekst) return undefined;
  const spreker = first(node, "spreker");
  const verslagnaam = childText(spreker, "verslagnaam");
  const fractie = childText(spreker, "fractie");
  const functie = childText(spreker, "functie");
  return {
    volgnummer,
    debat: debat.titel,
    debat_soort: debat.soort || undefined,
    rol: node.name === "interrumpant" ? "interrumpant" : "woordvoerder",
    voorzitter: childText(node, "isvoorzitter") === "true",
    spreker: sprekerNaam(childText(spreker, "voornaam"), verslagnaam) || "Onbekende spreker",
    verslagnaam,
    fractie: fractie || undefined,
    functie: functie || undefined,
    spreker_soort: spreker?.attrs.soort || undefined,
    persoon_id: spreker?.attrs.objectid || undefined,
    begin: localTime(childText(node, "markeertijdbegin")),
    eind: localTime(childText(node, "markeertijdeind")),
    tekst,
  };
}

/**
 * A VLOS verslag as its vergadering and fragments. Woordvoerders and the
 * interrumpanten nested in them are taken in document order, each with the
 * activiteit (debat) around it; the moties a woordvoerder reads out are part of
 * its text. Stemmingen, other draadboekfragmenten (the chair's procedural
 * notes) and parts without spoken text yield nothing. Every activiteit is
 * listed with its objectid, parlisid, times and the range of its fragments.
 */
export function parseVerslag(xml: string, verslagId: string): DebatVerslag {
  const root = parseXmlTree(xml);
  const doc = first(root, "vlosCoreDocument") ?? root;
  const vergadering = first(doc, "vergadering");
  const titel = childText(vergadering, "titel");
  const fragments: DebatFragment[] = [];
  const activiteiten: DebatActiviteit[] = [];
  let sluiting: string | undefined;

  const walk = (node: XmlElement, debat: { titel: string; soort?: string }) => {
    for (const child of elements(node)) {
      if (child.name === "activiteit") {
        if (child.attrs.soort === "Sluiting") sluiting = localTime(childText(child, "eindtijd")) ?? localTime(childText(child, "aanvangstijd")) ?? sluiting;
        const onderwerp = childText(child, "onderwerp") || childText(child, "titel");
        const objectid = (child.attrs.objectid ?? "").trim();
        const entry: DebatActiviteit | undefined = objectid
          ? {
            objectid,
            soort: child.attrs.soort || undefined,
            titel: childText(child, "titel") || onderwerp,
            onderwerp: onderwerp || undefined,
            parlisid: childText(child, "parlisid") || undefined,
            aanvang: localTime(childText(child, "aanvangstijd")),
            eind: localTime(childText(child, "eindtijd")),
            fragmentVan: fragments.length,
            fragmentTot: fragments.length,
          }
          : undefined;
        if (entry) activiteiten.push(entry);
        walk(child, { titel: onderwerp || titel, soort: child.attrs.soort });
        if (entry) entry.fragmentTot = fragments.length;
      } else if (child.name === "woordvoerder" || child.name === "interrumpant") {
        const fragment = fragmentOf(child, debat, fragments.length + 1);
        if (fragment) fragments.push(fragment);
        walk(child, debat);
      } else if (child.name !== "tekst" && child.name !== "spreker" && child.name !== "sprekers") {
        walk(child, debat);
      }
    }
  };
  if (vergadering) walk(vergadering, { titel });

  return {
    verslag_id: verslagId,
    soort: vergadering?.attrs.soort ?? "",
    titel,
    zaal: childText(vergadering, "zaal") || undefined,
    vergaderjaar: childText(vergadering, "vergaderjaar") || undefined,
    vergaderingnummer: childText(vergadering, "vergaderingnummer") || undefined,
    datum: childText(vergadering, "datum").slice(0, 10) || undefined,
    aanvang: localTime(childText(vergadering, "aanvangstijd")),
    status: doc.attrs.status || undefined,
    publicatie: doc.attrs.soort || undefined,
    sluiting,
    fragments,
    activiteiten,
  };
}

/* ------------------------------------------------------------------ */
/*  Matching                                                           */
/* ------------------------------------------------------------------ */

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface TextMatcher {
  terms: TkSearchTerm[];
  /** Where the first term first matches in the folded text, -1 if not every term matches. */
  match(foldedText: string): number;
}

/**
 * The words of a query, with the word rules of tweede_kamer_documents: a word
 * of up to 3 characters or a "quoted phrase" matches as a whole word, a longer
 * word also inside a longer one ("stikstof" finds "stikstofuitstoot"). Unlike
 * the API this ignores accents. Every term must match (AND).
 */
export function textMatcher(query: string | undefined): TextMatcher | undefined {
  const { terms } = parseTkQuery(query);
  if (!terms.length) return undefined;
  const tests = terms.map((term) => {
    const folded = foldText(term.text).replace(/\s+/g, " ");
    if (term.mode === "substring") return (text: string) => text.indexOf(folded);
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(folded).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "u");
    return (text: string) => re.exec(text)?.index ?? -1;
  });
  return {
    terms,
    match(text) {
      let at = -1;
      for (const [i, test] of tests.entries()) {
        const pos = test(text);
        if (pos < 0) return -1;
        if (i === 0) at = pos;
      }
      return at;
    },
  };
}

/**
 * Where a Gehoord.de phrase falls in a text, by Gehoord's own rule: a phrase of
 * more than 4 characters matches inside a longer word too ("stikstof" in
 * "stikstofpakket"), a shorter one only as a whole word. Case, accents and the
 * punctuation between words ("CO2-plafond") are ignored. -1 when it is not there.
 */
export function phrasePosition(text: string, phrase: string | undefined): number {
  const words = foldText((phrase ?? "").replace(/"/g, " ")).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return -1;
  const body = words.map(escapeRegExp).join("[^\\p{L}\\p{N}]+");
  const re = words.join(" ").length <= 4 ? new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "u") : new RegExp(body, "u");
  return re.exec(foldText(text))?.index ?? -1;
}

/**
 * Where the first of several Gehoord.de search terms falls in a text: the
 * earliest position any of them has (each by phrasePosition), -1 when none is
 * there. A string is one phrase. Excluded terms are not passed.
 */
export function termsPosition(text: string, terms: string | string[] | undefined): number {
  const list = typeof terms === "string" ? [terms] : terms ?? [];
  let at = -1;
  for (const term of list) {
    const pos = phrasePosition(text, term);
    if (pos >= 0 && (at < 0 || pos < at)) at = pos;
  }
  return at;
}

/** The page of a commissievergadering on tweedekamer.nl by its Activiteit Nummer ('2026A05087'). */
export function commissieUrlVoorNummer(nummer: string): string {
  return `https://www.tweedekamer.nl/debat_en_vergadering/commissievergaderingen/details?id=${encodeURIComponent(nummer)}`;
}

/** The passage around a position, on word boundaries, with "…" where it is cut. */
export function snippetAt(text: string, at: number, radius = SNIPPET_RADIUS): string {
  const flat = text.replace(/\s+/g, " ");
  if (flat.length <= radius * 2) return flat;
  let start = Math.max(0, at - radius);
  let end = Math.min(flat.length, Math.max(at, 0) + radius);
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space >= 0 && space < at) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > Math.max(at, start)) end = space;
  }
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

function normaliseParty(value: string): string {
  return foldText(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

/** "VVD", "vvd", "Groep Markuszower" or "Markuszower": the fractie as written, or a part of 4+ characters. */
export function fractieMatches(fractie: string | undefined, wanted: string): boolean {
  const have = normaliseParty(fractie ?? "");
  const want = normaliseParty(wanted);
  if (!have || !want) return false;
  return have === want || (want.length >= 4 && have.includes(want));
}

/**
 * Every word of `wanted` in the name, verslagnaam or functie of the spreker:
 * "Klaver", "van Weel", "minister", "staatssecretaris Defensie"; "voorzitter"
 * finds the chair.
 */
export function sprekerMatches(fragment: DebatFragment, wanted: string): boolean {
  const haystack = foldText(
    [fragment.spreker, fragment.verslagnaam, fragment.functie ?? "", fragment.voorzitter ? "voorzitter" : ""].join(" | "),
  );
  const words = foldText(wanted).split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);
  return words.length > 0 && words.every((w) => haystack.includes(w));
}

/* ------------------------------------------------------------------ */
/*  Source                                                             */
/* ------------------------------------------------------------------ */

export interface DebatVergadering {
  vergadering_id: string;
  verslag_id: string;
  soort: string;
  titel: string;
  zaal?: string;
  vergaderjaar?: string;
  vergaderingnummer?: number;
  datum?: string;
  aanvangstijd?: string;
  /** When the vergadering ended (v5 Eindtijd); empty while it runs. */
  eindtijd?: string;
  verslag_status?: string;
  verslag_soort?: string;
  verslag_gewijzigd?: string;
}

const STATUS_RANK: Record<string, number> = { Gerectificeerd: 3, Gecorrigeerd: 2, Ongecorrigeerd: 1 };

/** The verslag to read: the most corrected one, an eindpublicatie before a tussenpublicatie, then the newest. Never a casco. */
export function pickVerslag(verslagen: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  const rank = (v: Record<string, unknown>) => [
    STATUS_RANK[String(v.Status)] ?? 0,
    v.Soort === "Eindpublicatie" ? 1 : 0,
    Date.parse(String(v.GewijzigdOp ?? "")) || 0,
  ];
  return verslagen
    .filter((v) => v && v.Verwijderd !== true && (STATUS_RANK[String(v.Status)] ?? 0) > 0)
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i];
      return 0;
    })[0];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
}

function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today in the Netherlands, YYYY-MM-DD. */
function todayAmsterdam(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());
}

export interface DebatSearchArgs {
  query?: string;
  spreker?: string;
  fractie?: string;
  debat?: string;
  soort?: DebatSoort;
  vergadering_id?: string;
  date?: string;
  date_from?: string;
  date_to?: string;
  vergadering_offset?: number;
  max_vergaderingen?: number;
}

export interface DebatHit {
  fragment: DebatFragment;
  vergadering: DebatVergadering;
  /** Passage around the first match, or the opening of the text. */
  snippet: string;
}

export interface DebatSearchResult {
  hits: DebatHit[];
  /** The vergaderingen searched, newest first. */
  searched: DebatVergadering[];
  /** Vergaderingen whose verslag could not be read. */
  failed: DebatVergadering[];
  /** How many vergaderingen match the period and soort; null if the API gave no count. */
  totalVergaderingen: number | null;
  vergaderingOffset: number;
  period: { from?: string; to?: string; defaulted: boolean };
  terms: TkSearchTerm[];
  endpoint: string;
  params: Record<string, string>;
}

/** A request's own time budget: the koppeling gives what is left of its deadline, without a retry. */
export interface DebatRequestOptions {
  timeoutMs?: number;
  retries?: number;
}

export class TweedeKamerDebattenSource {
  private readonly parsed = new Map<string, DebatVerslag>();
  /** Downloads under way, so callers side by side share one (a plenaire dag is 1-3 MB). */
  private readonly loading = new Map<string, Promise<DebatVerslag>>();

  constructor(private readonly config: AppConfig) {}

  private get apiBase(): string {
    return this.config.endpoints.tweedeKamer;
  }

  static plenairUrl(v: Pick<DebatVergadering, "soort" | "vergaderjaar" | "vergaderingnummer">): string | undefined {
    if (v.soort !== "Plenair" || !v.vergaderjaar || !v.vergaderingnummer) return undefined;
    return `https://www.tweedekamer.nl/kamerstukken/plenaire_verslagen/detail/${v.vergaderjaar}/${v.vergaderingnummer}`;
  }

  verslagUrl(verslagId: string): string {
    return `${this.apiBase}/Verslag(${verslagId})/resource`;
  }

  /** The vergaderingen to search, newest first, each with the verslag to read. */
  async listVergaderingen(args: DebatSearchArgs): Promise<{
    vergaderingen: DebatVergadering[];
    total: number | null;
    endpoint: string;
    params: Record<string, string>;
    period: DebatSearchResult["period"];
  }> {
    const select = "Id,Soort,Titel,Zaal,Vergaderjaar,Nummer,Datum,Aanvangstijd";
    const expand = "Verslag($filter=Verwijderd eq false;$select=Id,Soort,Status,GewijzigdOp,Verwijderd)";
    const vergaderingId = args.vergadering_id?.trim();
    if (vergaderingId) {
      if (!GUID_RE.test(vergaderingId)) {
        throw new TweedeKamerInputError(
          `vergadering_id '${vergaderingId}' is geen GUID.`,
          "Gebruik het vergadering_id uit een eerder resultaat van tweede_kamer_debatten.",
        );
      }
      const endpoint = `${this.apiBase}/Vergadering(${vergaderingId})`;
      const params = { $select: select, $expand: expand };
      try {
        const { data, meta } = await getJson<Record<string, unknown>>(endpoint, { query: params, timeoutMs: LIST_TIMEOUT_MS });
        const v = this.toVergadering(data);
        return { vergaderingen: v ? [v] : [], total: v ? 1 : 0, endpoint: meta.url, params, period: { defaulted: false } };
      } catch (error) {
        if (error instanceof SourceRequestError && error.status === 404) {
          return { vergaderingen: [], total: 0, endpoint, params, period: { defaulted: false } };
        }
        throw error;
      }
    }

    for (const [name, value] of Object.entries({ date: args.date, date_from: args.date_from, date_to: args.date_to })) {
      if (value && !DAY_RE.test(value)) {
        throw new TweedeKamerInputError(`${name} '${value}' is geen datum.`, "Gebruik YYYY-MM-DD, bijvoorbeeld 2026-10-01.");
      }
    }
    let from = args.date ?? args.date_from;
    let to = args.date ?? args.date_to;
    const defaulted = !from && !to;
    if (defaulted) {
      to = todayAmsterdam();
      from = shiftDay(to, -(DEBAT_DEFAULT_DAYS - 1));
    }
    if (from && to && from > to) {
      throw new TweedeKamerInputError(`date_from ${from} ligt na date_to ${to}.`);
    }
    const range = tkDayRange(from, to);
    const filter = ["Verwijderd eq false", "Verslag/any(v:v/Verwijderd eq false and v/Status ne 'Casco')"];
    if (range.start) filter.push(`Datum ge ${range.start}`);
    if (range.endExclusive) filter.push(`Datum lt ${range.endExclusive}`);
    if (args.soort) filter.push(`Soort eq '${args.soort === "plenair" ? "Plenair" : "Commissie"}'`);
    const top = Math.min(Math.max(args.max_vergaderingen ?? DEBAT_MAX_VERSLAGEN, 1), DEBAT_MAX_VERSLAGEN);
    const params: Record<string, string> = {
      $count: "true",
      $top: String(top),
      $select: select,
      $filter: filter.join(" and "),
      // Id orders vergaderingen that start at the same moment, so vergadering_offset pages are stable.
      $orderby: "Datum desc,Aanvangstijd desc,Id",
      $expand: expand,
    };
    if (args.vergadering_offset) params.$skip = String(args.vergadering_offset);
    const endpoint = `${this.apiBase}/Vergadering`;
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, { query: params, timeoutMs: LIST_TIMEOUT_MS });
    const rows = Array.isArray(data.value) ? (data.value as Array<Record<string, unknown>>) : [];
    const count = Number(data["@odata.count"]);
    return {
      vergaderingen: rows.map((row) => this.toVergadering(row)).filter((v): v is DebatVergadering => Boolean(v)),
      total: Number.isFinite(count) ? count : null,
      endpoint: meta.url,
      params,
      period: { from, to, defaulted },
    };
  }

  /**
   * Every vergadering of one day (YYYY-MM-DD, Dutch date) with a verslag to
   * read, plenary and committee: what a Gehoord.de debate is matched against
   * (debat-koppeling). A day holds a few dozen at most. Datum is local
   * midnight (+01:00/+02:00), so the filter is the Amsterdam day.
   */
  async vergaderingenOp(day: string, opts: DebatRequestOptions = {}): Promise<DebatVergadering[]> {
    if (!DAY_RE.test(day)) throw new TweedeKamerInputError(`'${day}' is geen datum.`, "Gebruik YYYY-MM-DD.");
    const range = tkDayRange(day, day);
    const filter = ["Verwijderd eq false", "Verslag/any(v:v/Verwijderd eq false and v/Status ne 'Casco')"];
    if (range.start) filter.push(`Datum ge ${range.start}`);
    if (range.endExclusive) filter.push(`Datum lt ${range.endExclusive}`);
    const { data } = await getJson<Record<string, unknown>>(`${this.apiBase}/Vergadering`, {
      query: {
        $top: "100",
        $select: "Id,Soort,Titel,Zaal,Vergaderjaar,Nummer,Datum,Aanvangstijd,Eindtijd",
        $filter: filter.join(" and "),
        $orderby: "Aanvangstijd,Id",
        $expand: "Verslag($filter=Verwijderd eq false;$select=Id,Soort,Status,GewijzigdOp,Verwijderd)",
      },
      timeoutMs: Math.min(LIST_TIMEOUT_MS, opts.timeoutMs ?? LIST_TIMEOUT_MS),
      ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
      // Today's list points at the newest tussenpublicatie: not ten minutes old.
      ...(day === todayAmsterdam() ? { cacheTtlMs: TODAY_LIST_TTL_MS } : {}),
    });
    const rows = Array.isArray(data.value) ? (data.value as Array<Record<string, unknown>>) : [];
    return rows.map((row) => this.toVergadering(row)).filter((v): v is DebatVergadering => Boolean(v));
  }

  private toVergadering(row: Record<string, unknown>): DebatVergadering | undefined {
    const verslag = pickVerslag(Array.isArray(row.Verslag) ? (row.Verslag as Array<Record<string, unknown>>) : []);
    if (!verslag || !str(row.Id) || !str(verslag.Id)) return undefined;
    // API v5: Nummer (was VergaderingNummer).
    const nummer = Number(row.Nummer);
    return {
      vergadering_id: str(row.Id),
      verslag_id: str(verslag.Id),
      soort: str(row.Soort),
      titel: str(row.Titel),
      zaal: str(row.Zaal) || undefined,
      vergaderjaar: str(row.Vergaderjaar) || undefined,
      vergaderingnummer: Number.isFinite(nummer) ? nummer : undefined,
      datum: str(row.Datum).slice(0, 10) || undefined,
      aanvangstijd: str(row.Aanvangstijd) || undefined,
      eindtijd: str(row.Eindtijd) || undefined,
      verslag_status: str(verslag.Status) || undefined,
      verslag_soort: str(verslag.Soort) || undefined,
      verslag_gewijzigd: str(verslag.GewijzigdOp) || undefined,
    };
  }

  /**
   * One verslag, parsed. Kept parsed per version (a tussenpublicatie grows
   * during the day), not in the HTTP cache: a plenaire dag is megabytes of XML.
   */
  async getVerslag(v: Pick<DebatVergadering, "verslag_id" | "verslag_gewijzigd">, opts: DebatRequestOptions = {}): Promise<DebatVerslag> {
    const key = `${v.verslag_id}|${v.verslag_gewijzigd ?? ""}`;
    const cached = this.parsed.get(key);
    if (cached) {
      this.parsed.delete(key);
      this.parsed.set(key, cached);
      return cached;
    }
    const running = this.loading.get(key);
    if (running) return running;
    const load = (async () => {
      const { data } = await getText(this.verslagUrl(v.verslag_id), {
        timeoutMs: Math.min(VERSLAG_TIMEOUT_MS, opts.timeoutMs ?? VERSLAG_TIMEOUT_MS),
        retries: opts.retries ?? 1,
        disableCache: true,
        headers: { Accept: "application/xml, text/xml" },
      });
      const verslag = parseVerslag(data.replace(/^\uFEFF/, ""), v.verslag_id);
      this.parsed.set(key, verslag);
      while (this.parsed.size > PARSED_CACHE_MAX) {
        const oldest = this.parsed.keys().next().value;
        if (oldest === undefined) break;
        this.parsed.delete(oldest);
      }
      return verslag;
    })();
    this.loading.set(key, load);
    try {
      return await load;
    } finally {
      this.loading.delete(key);
    }
  }

  /**
   * The fragments that match, in the order of the vergaderingen (newest first)
   * and within a verslag in the order they were spoken. Chair fragments never
   * match a fractie: the voorzitter does not speak for a party.
   */
  async search(args: DebatSearchArgs): Promise<DebatSearchResult> {
    const matcher = textMatcher(args.query);
    if (args.query?.trim() && !matcher) {
      throw new TweedeKamerInputError(`De zoekvraag '${args.query}' bevat geen zoekwoorden.`, "Geef een onderwerp, bijvoorbeeld 'stikstof'.");
    }
    const debatMatcher = textMatcher(args.debat);
    const listed = await this.listVergaderingen(args);

    const verslagen: Array<DebatVerslag | undefined> = new Array(listed.vergaderingen.length);
    let next = 0;
    const worker = async () => {
      while (next < listed.vergaderingen.length) {
        const i = next++;
        try {
          verslagen[i] = await this.getVerslag(listed.vergaderingen[i]);
        } catch {
          verslagen[i] = undefined;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, listed.vergaderingen.length) }, worker));

    const hits: DebatHit[] = [];
    const failed: DebatVergadering[] = [];
    listed.vergaderingen.forEach((vergadering, i) => {
      const verslag = verslagen[i];
      if (!verslag) {
        failed.push(vergadering);
        return;
      }
      const debatCache = new Map<string, boolean>();
      for (const fragment of verslag.fragments) {
        if (debatMatcher) {
          let ok = debatCache.get(fragment.debat);
          if (ok === undefined) {
            ok = debatMatcher.match(foldText(`${fragment.debat} | ${vergadering.titel}`)) >= 0;
            debatCache.set(fragment.debat, ok);
          }
          if (!ok) continue;
        }
        if (args.fractie && (fragment.voorzitter || !fractieMatches(fragment.fractie, args.fractie))) continue;
        if (args.spreker && !sprekerMatches(fragment, args.spreker)) continue;
        let at = 0;
        if (matcher) {
          at = matcher.match(foldText(fragment.tekst));
          if (at < 0) continue;
        }
        // foldText keeps the length of Dutch text (it only drops combining marks), so the position carries over closely enough for a snippet.
        hits.push({ fragment, vergadering, snippet: snippetAt(fragment.tekst, matcher ? at : 0) });
      }
    });

    return {
      hits,
      searched: listed.vergaderingen,
      failed,
      totalVergaderingen: listed.total,
      vergaderingOffset: args.vergadering_offset ?? 0,
      period: listed.period,
      terms: matcher?.terms ?? [],
      endpoint: listed.endpoint,
      params: listed.params,
    };
  }

  /**
   * The page of a commissiedebat on tweedekamer.nl, found through the
   * activiteit that starts at the same moment (the verslag and the agenda do
   * not share an id). Undefined when there is not exactly one such activiteit
   * or the lookup fails; the caller falls back to the verslag itself. A
   * Gehoord.de hit needs no lookup: its tkActivityNumber is the Nummer
   * (commissieUrlVoorNummer), else the parlisid of its activiteit in the
   * verslag.
   */
  async commissieUrl(v: Pick<DebatVergadering, "soort" | "aanvangstijd" | "titel">, opts: { timeoutMs?: number } = {}): Promise<string | undefined> {
    if (v.soort !== "Commissie" || !v.aanvangstijd || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(v.aanvangstijd)) {
      return undefined;
    }
    try {
      const { data } = await getJson<Record<string, unknown>>(`${this.apiBase}/Activiteit`, {
        query: {
          $select: "Nummer,Onderwerp",
          $filter: `Aanvangstijd eq ${v.aanvangstijd} and Verwijderd eq false`,
          // Every activiteit of that moment (six at once is real), in a fixed
          // order: a page cut by the default order could miss the debate.
          $orderby: "Id",
          $top: "100",
        },
        timeoutMs: Math.min(10_000, opts.timeoutMs ?? 10_000),
        retries: 0,
      });
      const rows = Array.isArray(data.value) ? (data.value as Array<Record<string, unknown>>) : [];
      const titel = foldText(v.titel);
      const same = rows.filter((r) => titel && foldText(str(r.Onderwerp)).startsWith(titel.slice(0, 40)));
      const pick = same.length === 1 ? same[0] : rows.length === 1 ? rows[0] : undefined;
      const nummer = str(pick?.Nummer);
      return nummer ? commissieUrlVoorNummer(nummer) : undefined;
    } catch {
      return undefined;
    }
  }
}
