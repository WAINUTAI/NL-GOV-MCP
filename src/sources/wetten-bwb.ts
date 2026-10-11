import type { AppConfig } from "../types.js";
import { getText, SourceRequestError } from "../utils/http.js";
import {
  extractSruNumberOfRecords,
  extractSruRecords,
  parseXml,
} from "../utils/xml-parser.js";
import { foldText, parseXmlTree, splitLid, zoektermWords, type XmlElement, type XmlNode } from "./dso-regeltekst.js";

/** SRU endpoint (KOOP zoekservice) that serves the BWB consolidated-legislation collection. */
export const BWB_SRU_ENDPOINT = "https://zoekservice.overheid.nl/sru/Search";
const BWB_CONNECTION = "BWB";
const WETTEN_URL = "https://wetten.overheid.nl";
const BWB_REPOSITORY = "https://repository.officiele-overheidspublicaties.nl/bwb/";

export const BWB_TEXT_DEFAULT_CHARS = 12_000;
export const BWB_TEXT_MAX_CHARS = 50_000;
/** The largest toestand is the Besluit activiteiten leefomgeving, about 16 MB of XML. */
const BWB_XML_MAX_BYTES = 25 * 1024 * 1024;
/** A toestand URL never changes content: parsed documents are kept a day, a few at a time. */
const DOC_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DOC_CACHE_MAX = 4;
/** How many hits wetten_bwb_search looks through for the regeling with exactly the title searched for. */
const EXACT_TITLE_LOOKUP = 200;

const BWB_ID = /^BWB[RV]\d{7}$/i;
/** geldigheidsperiode_einddatum of a version without a known end. */
const OPEN_END = "9999-12-31";

/** Read a scalar text value from a fast-xml-parser node (string, number, or { "#text": ... }). */
function toStringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["#text"] === "string") return obj["#text"];
    if (typeof obj["#text"] === "number") return String(obj["#text"]);
  }
  return undefined;
}

function toStringList(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).map(toStringValue).filter((v): v is string => Boolean(v));
}

/**
 * Input as typed or pasted: zero-width, bidi and other format characters (Unicode Cf)
 * are dropped, emoji become a space. Neither is ever part of a law's title or afkorting.
 */
export function cleanBwbInput(text: string): string {
  return text
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}︎️⃣]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Escape a value for use inside double-quoted CQL/SRU strings. */
function escapeSruValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function cqlValue(term: string): string {
  // Quote multi-word terms so CQL treats them as an ordered phrase.
  return /\s/.test(term) ? `"${escapeSruValue(term)}"` : escapeSruValue(term);
}

/**
 * Build the CQL query for BWB. The BWB SRU index rejects generic indexes
 * (cql.textAndIndexes, dcterms.title …); it exposes its own indexes such as
 * overheidbwb.titel. Free-text terms are matched against the title index.
 */
function buildCql(query: string): string {
  const term = query.trim();
  if (!term) return "overheidbwb.titel=*";
  return `overheidbwb.titel=${cqlValue(term)}`;
}

/**
 * The SRU returns one record per toestand (a consolidated version), not per
 * regeling: a title search for the Awb returns hundreds of its old versions.
 * overheidbwb.geldigheidsdatum keeps the version that is geldig on that day,
 * one per regeling.
 */
export function bwbSearchCql(query: string, peildatum: string): string {
  return `${buildCql(query)} and overheidbwb.geldigheidsdatum=${peildatum}`;
}

/** Today in the Netherlands, YYYY-MM-DD. */
export function todayAmsterdam(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());
}

/** One toestand (version) of a regeling, as the SRU describes it. */
export interface BwbRegeling {
  identifier: string;
  title?: string;
  type?: string;
  authority?: string;
  creator?: string;
  /** First day this version is geldig. */
  geldig_vanaf?: string;
  /** Last day this version is geldig; absent when no end is known. */
  geldig_tot?: string;
  /** "http://wetten.overheid.nl/id/BWBR0005537/2026-08-15/0". */
  toestand?: string;
  /** The toestand's XML in the KOOP repository. */
  xml_url?: string;
  /** When the BWB metadata record last changed; not a date of the law or its text. */
  metadata_gewijzigd?: string;
  rechtsgebied?: string[];
  /** Start of the zichtperiode: which of two versions for the same day is the later view. */
  zicht_vanaf?: string;
}

/**
 * Narrow one parsed SRU <gzd> record into the useful BWB fields.
 * With removeNSPrefix the tags are local names: overheidbwb:meta → meta,
 * dcterms:title → title, overheid:authority → authority, etc.
 */
function extractBwb(record: Record<string, unknown>): BwbRegeling | undefined {
  const original = record.originalData as Record<string, unknown> | undefined;
  const meta = original?.meta as Record<string, unknown> | undefined;
  const owmskern = meta?.owmskern as Record<string, unknown> | undefined;
  const owmsmantel = meta?.owmsmantel as Record<string, unknown> | undefined;
  const ipm = meta?.bwbipm as Record<string, unknown> | undefined;
  const enriched = record.enrichedData as Record<string, unknown> | undefined;

  const identifier = toStringValue(owmskern?.identifier) ?? toStringValue(record.identifier);
  if (!identifier) return undefined;
  const end = toStringValue(ipm?.geldigheidsperiode_einddatum);
  const rechtsgebied = toStringList(ipm?.rechtsgebied);
  return {
    identifier,
    title: toStringValue(owmskern?.title) ?? toStringValue(record.title),
    type: toStringList(owmskern?.type)[0],
    authority: toStringValue(owmskern?.authority),
    creator: toStringValue(owmskern?.creator),
    geldig_vanaf: toStringValue(ipm?.geldigheidsperiode_startdatum),
    geldig_tot: end && end !== OPEN_END ? end : undefined,
    toestand: toStringValue(ipm?.toestand),
    xml_url: toStringValue(enriched?.locatie_toestand),
    metadata_gewijzigd: toStringValue(owmskern?.modified) ?? toStringValue(owmsmantel?.created),
    ...(rechtsgebied.length ? { rechtsgebied } : {}),
    zicht_vanaf: toStringValue(ipm?.zichtperiode_startdatum),
  };
}

/** The later of two records of the same regeling: the newer view, then the higher version number. */
function laterVersion(a: BwbRegeling, b: BwbRegeling): BwbRegeling {
  const za = a.zicht_vanaf ?? "";
  const zb = b.zicht_vanaf ?? "";
  if (za !== zb) return zb > za ? b : a;
  const version = (r: BwbRegeling) => Number(/\/(\d+)$/.exec(r.toestand ?? "")?.[1] ?? 0);
  return version(b) > version(a) ? b : a;
}

/** One record per regeling, in the order of the first: two versions valid on the same day keep the later. */
function onePerRegeling(items: BwbRegeling[]): BwbRegeling[] {
  const byId = new Map<string, BwbRegeling>();
  for (const item of items) {
    const prev = byId.get(item.identifier);
    byId.set(item.identifier, prev ? laterVersion(prev, item) : item);
  }
  return [...byId.values()];
}

/** The page of a version on wetten.overheid.nl: /BWBR0005537/2026-08-15. */
export function bwbVersieUrl(r: Pick<BwbRegeling, "identifier" | "geldig_vanaf">): string {
  return r.geldig_vanaf ? `${WETTEN_URL}/${r.identifier}/${r.geldig_vanaf}` : `${WETTEN_URL}/${r.identifier}`;
}

/** The message of an SRU diagnostic (a rejected query), if the response is one. */
function sruDiagnostic(parsed: unknown): string | undefined {
  const root = (parsed ?? {}) as Record<string, unknown>;
  const response = (root.searchRetrieveResponse ?? root) as Record<string, unknown>;
  const diagnostics = response.diagnostics as Record<string, unknown> | undefined;
  if (!diagnostics) return undefined;
  const first = (Array.isArray(diagnostics.diagnostic) ? diagnostics.diagnostic[0] : diagnostics.diagnostic) as Record<string, unknown> | undefined;
  return [toStringValue(first?.message), toStringValue(first?.details)].filter(Boolean).join(": ") || "SRU-diagnose";
}

/** "Wet openbaarheid van bestuur (BWBR0005252, geldig 2016-10-01 t/m 2022-04-30)". */
function describeVersion(r: BwbRegeling): string {
  const period = r.geldig_vanaf ? `geldig ${r.geldig_vanaf}${r.geldig_tot ? ` t/m ${r.geldig_tot}` : " zonder einddatum"}` : undefined;
  return `${r.title ?? r.identifier} (${[r.identifier, period].filter(Boolean).join(", ")})`;
}

/**
 * What went wrong, said as such, with what to ask instead:
 * - not_found: no regeling with this id, or none with this title or afkorting;
 * - no_version: the regeling (or regelingen with this name) exist, but none is geldig on the peildatum;
 * - input: the call itself cannot be answered (no id or wet, a zoekterm without words, a query the SRU rejects);
 * - upstream: the BWB answered, but without the text it should have.
 * not_found and no_version are answers (no records, with a note); input and upstream are errors.
 */
export type BwbTekstErrorKind = "not_found" | "no_version" | "input" | "upstream";

export class BwbTekstError extends Error {
  constructor(
    readonly kind: BwbTekstErrorKind,
    message: string,
    readonly suggestion: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BwbTekstError";
  }
}

/* ------------------------------------------------------------------ */
/*  Toestand XML → text                                                */
/* ------------------------------------------------------------------ */

export interface BwbArtikel {
  /** "Artikel 3:4". */
  label: string;
  /** The label as matched: "3:4". */
  key: string;
  /** Kop title, e.g. "(uitoefening taken en bevoegdheden)" in the Omgevingswet. */
  titel?: string;
  /** Headings above it: ["Hoofdstuk 3 Algemene bepalingen over besluiten", "Afdeling 3.2 …"]. */
  pad: string[];
  /** BWB status: "goed" (geldend), "vervallen" or "nogniet" (not yet in force). */
  status?: string;
  /** Date this text of the artikel took effect (for a vervallen artikel: when it lapsed). */
  inwerking?: string;
  /** Publication of that change, e.g. "Stb.1994-1". */
  bron?: string;
  bronUrl?: string;
  /** Short JCI reference, e.g. "jci1.3:c:BWBR0005537&artikel=3:4". */
  jci?: string;
  /** Lines [from, to) of the document. */
  from: number;
  to: number;
  leden: Array<{ nr: string; from: number; to: number }>;
  bijlage: boolean;
}

export interface BwbKop {
  text: string;
  depth: number;
  firstArtikel?: number;
  lastArtikel?: number;
}

export interface BwbDocument {
  bwbId?: string;
  /** Toestand date in the XML (inwerkingtreding of this version). */
  toestandDatum?: string;
  citeertitel?: string;
  lines: string[];
  artikelen: BwbArtikel[];
  koppen: BwbKop[];
  totalChars: number;
}

/** Bookkeeping and history in the toestand, not text of the regeling. */
const SKIP = new Set(["meta-data", "bwb-inputbestand", "bwb-wijzigingen", "redactionele-correcties", "jcis", "citeertitel"]);
/** Text-level elements: their text runs on in the sentence around them. */
const INLINE = new Set(["extref", "intref", "nadruk", "sup", "inf", "redactie", "afkorting", "unl", "omissie", "noot", "noot.nr", "noot.al", "br", "inline-plaatje"]);

const SUPERSCRIPT: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻" };
const SUBSCRIPT: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉" };

function squash(text: string): string {
  return text.replace(/­/g, "").replace(/\s+/g, " ").trim();
}

function elements(node: XmlElement): XmlElement[] {
  return node.children.filter((c): c is XmlElement => typeof c !== "string");
}

function child(node: XmlElement, name: string): XmlElement | undefined {
  return elements(node).find((c) => c.name === name);
}

/** "m<sup>3</sup>" is "m³", "E<inf>s</inf>" is "E_s". */
function scriptText(text: string, map: Record<string, string>, mark: string): string {
  const t = squash(text);
  if (!t) return "";
  return [...t].every((c) => map[c]) ? [...t].map((c) => map[c]).join("") : `${mark}${t}`;
}

function inlineText(node: XmlNode): string {
  if (typeof node === "string") return node.replace(/\s+/g, " ");
  if (SKIP.has(node.name)) return "";
  if (node.name === "br") return "\n";
  if (node.name === "plaatje" || node.name === "illustratie" || node.name === "inline-plaatje") return " [afbeelding] ";
  const text = node.children.map(inlineText).join("");
  if (node.name === "sup") return scriptText(text, SUPERSCRIPT, "^");
  if (node.name === "inf") return scriptText(text, SUBSCRIPT, "_");
  return text;
}

/** "Artikel 2.1 (uitoefening taken en bevoegdheden)", "Hoofdstuk 3 Algemene bepalingen over besluiten". */
function kopText(kop: XmlElement): string {
  return elements(kop)
    .filter((c) => !SKIP.has(c.name))
    .map((c) => squash(inlineText(c)))
    .filter(Boolean)
    .join(" ");
}

function paragraphLines(text: string, indent: string): string[] {
  return text.split("\n").map(squash).filter(Boolean).map((line) => indent + line);
}

function prefixFirst(prefix: string, lines: string[], indent: string): string[] {
  if (!prefix) return lines;
  if (!lines.length) return [indent + prefix];
  return [`${indent}${prefix} ${lines[0].trimStart()}`, ...lines.slice(1)];
}

function renderBlocks(nodes: XmlNode[], indent: string): string[] {
  const lines: string[] = [];
  let run = "";
  const flush = () => {
    lines.push(...paragraphLines(run, indent));
    run = "";
  };
  for (const node of nodes) {
    if (typeof node === "string" || INLINE.has(node.name)) {
      run += inlineText(node);
    } else {
      flush();
      lines.push(...renderBlock(node, indent));
    }
  }
  flush();
  return lines;
}

/** "1" → "1.", "a." stays "a.". */
function numberPrefix(el: XmlElement | undefined): string {
  const nr = el ? squash(inlineText(el)) : "";
  return nr && !/[.)°]$/.test(nr) ? `${nr}.` : nr;
}

function renderBlock(el: XmlElement, indent: string): string[] {
  if (SKIP.has(el.name)) return [];
  switch (el.name) {
    case "kop": {
      const text = kopText(el);
      return text ? [indent + text] : [];
    }
    case "lid":
      return prefixFirst(numberPrefix(child(el, "lidnr")), renderBlocks(el.children.filter((c) => typeof c === "string" || c.name !== "lidnr"), indent), indent);
    case "li":
      return prefixFirst(numberPrefix(child(el, "li.nr")), renderBlocks(el.children.filter((c) => typeof c === "string" || c.name !== "li.nr"), indent), indent);
    case "lijst":
      return elements(el).flatMap((c) => renderBlock(c, `${indent}  `));
    case "plaatje":
    case "illustratie":
      return [`${indent}[afbeelding]`];
    case "table": {
      const lines: string[] = [];
      const title = child(el, "title");
      if (title) lines.push(...paragraphLines(inlineText(title), indent));
      const rows: XmlElement[] = [];
      const collect = (e: XmlElement) => {
        for (const c of elements(e)) {
          if (c.name === "row") rows.push(c);
          else if (c.name !== "title" && c.name !== "colspec") collect(c);
        }
      };
      collect(el);
      for (const row of rows) {
        const cells = elements(row)
          .filter((c) => c.name === "entry")
          .map((entry) => renderBlocks(entry.children, "").map((l) => l.trim()).join(" "));
        if (cells.some(Boolean)) lines.push(`${indent}${cells.join(" | ")}`);
      }
      return lines;
    }
    default:
      return renderBlocks(el.children, indent);
  }
}

/** "art. 3:4", "Artikel 3:4", " 3 : 4 " → "3:4". A "3.4" stays "3.4". */
export function artikelKey(text: string): string {
  return foldText(text)
    .trim()
    .replace(/^(?:artikel|art\.?)\s*/, "")
    .replace(/\s+/g, "")
    .replace(/\.$/, "");
}

/** Publication ids ("stb-2002-54") the artikel's brondata names; old publications have none. */
function publicationIds(meta: XmlElement | undefined): Set<string> {
  const ids = new Set<string>();
  const visit = (e: XmlElement) => {
    for (const c of elements(e)) {
      if (c.name === "publicatie" && c.attrs.urlidentifier) ids.add(c.attrs.urlidentifier.toLowerCase());
      visit(c);
    }
  };
  if (meta) visit(meta);
  return ids;
}

/** "Stb.2002-54" → "stb-2002-54". */
function bronId(bron: string): string | undefined {
  const m = /^([A-Za-z]+)\.\s*(\d{4})-(\d+)$/.exec(bron.trim());
  return m ? `${m[1].toLowerCase()}-${m[2]}-${m[3]}` : undefined;
}

/** The short JCI 1.3 reference in an element's own meta-data. */
function ownJci(meta: XmlElement | undefined): string | undefined {
  const jcis = meta ? child(meta, "jcis") : undefined;
  const jci = jcis ? elements(jcis).find((j) => j.attrs.versie === "1.3") : undefined;
  return jci?.attrs["korte-verwijzing"] || undefined;
}

class DocumentBuilder {
  readonly lines: string[] = [];
  readonly artikelen: BwbArtikel[] = [];
  readonly koppen: BwbKop[] = [];
  private readonly pad: string[] = [];
  private bijlage = 0;
  private readonly structural = new WeakMap<XmlElement, boolean>();

  /** An artikel or a heading with a kop somewhere below: walked part by part instead of rendered as one block. */
  private hasStructure(el: XmlElement): boolean {
    const known = this.structural.get(el);
    if (known !== undefined) return known;
    let result = el.name === "artikel" || (el.name !== "kop" && Boolean(child(el, "kop")));
    if (!result) for (const c of elements(el)) if (!SKIP.has(c.name) && this.hasStructure(c)) result = true;
    this.structural.set(el, result);
    return result;
  }

  private blank(): void {
    if (this.lines.length && this.lines[this.lines.length - 1] !== "") this.lines.push("");
  }

  walk(el: XmlElement): void {
    if (SKIP.has(el.name)) return;
    if (el.name === "artikel") return this.artikel(el);
    if (!this.hasStructure(el)) {
      this.lines.push(...renderBlock(el, ""));
      return;
    }
    const kop = el.name === "kop" ? undefined : child(el, "kop");
    const isBijlage = el.name === "bijlage";
    if (isBijlage) this.bijlage++;
    let heading: BwbKop | undefined;
    if (kop) {
      const text = kopText(kop);
      if (text) {
        heading = { text, depth: this.pad.length };
        this.koppen.push(heading);
        this.blank();
        this.lines.push(text);
        this.pad.push(text);
      }
    }
    const first = this.artikelen.length;
    let run = "";
    const flush = () => {
      this.lines.push(...paragraphLines(run, ""));
      run = "";
    };
    for (const c of el.children) {
      if (c === kop) continue;
      if (typeof c === "string" || INLINE.has(c.name)) {
        run += inlineText(c);
        continue;
      }
      flush();
      this.walk(c);
    }
    flush();
    if (heading) {
      this.pad.pop();
      if (this.artikelen.length > first) {
        heading.firstArtikel = first;
        heading.lastArtikel = this.artikelen.length - 1;
      }
    }
    if (isBijlage) this.bijlage--;
  }

  private artikel(el: XmlElement): void {
    const kop = child(el, "kop");
    const meta = child(el, "meta-data");
    const heading = kop ? kopText(kop) : "";
    const nr = kop ? squash(inlineText(child(kop, "nr") ?? kop)) : "";
    const label = squash(el.attrs.label ?? "") || (nr ? `Artikel ${nr}` : heading) || "Artikel";
    const titel = kop && child(kop, "titel") ? squash(inlineText(child(kop, "titel") as XmlElement)) : undefined;
    this.blank();
    const from = this.lines.length;
    this.lines.push(heading || label);
    const leden: BwbArtikel["leden"] = [];
    let run = "";
    const flush = () => {
      this.lines.push(...paragraphLines(run, ""));
      run = "";
    };
    for (const c of el.children) {
      if (c === kop) continue;
      if (typeof c === "string" || INLINE.has(c.name)) {
        run += inlineText(c);
        continue;
      }
      flush();
      const start = this.lines.length;
      this.lines.push(...renderBlock(c, ""));
      if (c.name === "lid") leden.push({ nr: numberPrefix(child(c, "lidnr")).replace(/\.$/, "").toLowerCase(), from: start, to: this.lines.length });
    }
    flush();
    const bron = el.attrs.bron || undefined;
    const pubId = bron ? bronId(bron) : undefined;
    this.artikelen.push({
      label,
      key: artikelKey(label),
      ...(titel ? { titel } : {}),
      pad: [...this.pad],
      status: el.attrs.status || undefined,
      inwerking: el.attrs.inwerking || undefined,
      bron,
      bronUrl: pubId && publicationIds(meta).has(pubId) ? `https://zoek.officielebekendmakingen.nl/${pubId}` : undefined,
      jci: ownJci(meta),
      from,
      to: this.lines.length,
      leden,
      bijlage: this.bijlage > 0,
    });
  }
}

/** The text model of one BWB toestand XML: lines in document order, with its artikelen and headings. */
export function parseBwbToestand(xml: string): BwbDocument {
  const root = parseXmlTree(xml);
  const toestand = elements(root).find((e) => e.name === "toestand") ?? root;
  let citeertitel: string | undefined;
  const findCiteertitel = (e: XmlElement): void => {
    for (const c of elements(e)) {
      if (citeertitel) return;
      // Read here, left out of the text (SKIP): the intitule already names the regeling there.
      if (c.name === "citeertitel") citeertitel = squash(c.children.map(inlineText).join("")) || undefined;
      else if (c.name !== "meta-data" && c.name !== "artikel") findCiteertitel(c);
    }
  };
  findCiteertitel(toestand);
  const builder = new DocumentBuilder();
  builder.walk(toestand);
  const lines = builder.lines;
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return {
    bwbId: toestand.attrs["bwb-id"],
    toestandDatum: toestand.attrs.inwerkingtreding,
    citeertitel,
    lines,
    artikelen: builder.artikelen,
    koppen: builder.koppen,
    totalChars: lines.join("\n").length,
  };
}

/**
 * Why a download is not a BWB toestand, or undefined when it is: a <toestand> with a bwb-id that is
 * closed (not cut off). An HTML maintenance page or an empty body has no toestand.
 */
export function bwbToestandProblem(xml: string, doc: BwbDocument): string | undefined {
  if (!xml.trim()) return "lege respons";
  if (!doc.bwbId) return /<html[\s>]/i.test(xml) ? "een HTML-pagina in plaats van XML" : "geen <toestand>-element met bwb-id";
  if (!xml.trimEnd().endsWith("</toestand>")) return "de XML is afgebroken (geen </toestand> aan het eind)";
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Selecting text: artikel, zoekterm, table of contents               */
/* ------------------------------------------------------------------ */

export interface BwbTextPart {
  artikel?: BwbArtikel;
  lid?: string;
  /** The onderdeel asked for ("sub b", "onder b"): "b". */
  onderdeel?: string;
  /** The onderdeel was not found in the text: the whole lid (or artikel) is given. */
  onderdeelNietGevonden?: boolean;
  tekst: string;
  /** Shortened to fit max_chars: the kop and the lines with the zoekterm, or the beginning. */
  ingekort?: boolean;
  /** Length of the whole artikel (or lid) when shortened. */
  tekensVolledig?: number;
}

export interface BwbTextSelection {
  mode: "artikel" | "zoekterm" | "volledig" | "begin_met_inhoudsopgave";
  parts: BwbTextPart[];
  totalChars: number;
  truncated: boolean;
  matches?: number;
  /** Matching artikelen left out for max_chars. */
  omitted?: string[];
  inhoudsopgave?: string;
  inhoudsopgaveVolledig?: boolean;
  /** Heading levels kept when the full table of contents does not fit. */
  inhoudsopgaveNiveaus?: number;
  /** The (reduced) table of contents still did not fit and was cut at a line. */
  inhoudsopgaveAfgekapt?: boolean;
  notFound?: { reason: string; suggestions: string[] };
}

function artikelText(doc: BwbDocument, a: { from: number; to: number }): string {
  return doc.lines.slice(a.from, a.to).join("\n");
}

/** "Artikel 3:4" → "3:4", for ranges in the table of contents. */
function shortLabel(label: string): string {
  return label.replace(/^artikel\s+/i, "");
}

/** Headings with the artikelen under them: "  Afdeling 3.2 Zorgvuldigheid en belangenafweging (art. 3:2–3:4)". */
export function bwbTableOfContents(doc: BwbDocument, maxDepth = Number.POSITIVE_INFINITY): string {
  const lines: string[] = [];
  for (const k of doc.koppen) {
    if (k.depth > maxDepth) continue;
    const first = k.firstArtikel !== undefined ? doc.artikelen[k.firstArtikel] : undefined;
    const last = k.lastArtikel !== undefined ? doc.artikelen[k.lastArtikel] : undefined;
    const range = first && last ? ` (art. ${shortLabel(first.label)}${last !== first ? `–${shortLabel(last.label)}` : ""})` : "";
    lines.push(`${"  ".repeat(k.depth)}${k.text}${range}`);
  }
  const loose = doc.artikelen.filter((a) => !a.pad.length);
  if (loose.length) {
    const shown = loose.slice(0, 200).map((a) => shortLabel(a.label));
    lines.push(`Artikelen: ${shown.join(", ")}${loose.length > shown.length ? ` … (${loose.length} in totaal)` : ""}`);
  }
  return lines.join("\n");
}

/** Cut at the last line break before `max` when there is one in the second half. */
function cutAtLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return cut > max / 2 ? text.slice(0, cut) : text.slice(0, max);
}

/** Labels around one that is not there: same chapter number first, in document order. */
function nearbyArtikelen(doc: BwbDocument, key: string, max = 10): string[] {
  const all = doc.artikelen.filter((a) => !a.bijlage);
  const head = (k: string) => k.split(/[.:]/)[0];
  const same = all.filter((a) => head(a.key) === head(key));
  const pool = same.length ? same : all;
  const at = pool.findIndex((a) => a.key.localeCompare(key, "nl", { numeric: true }) >= 0);
  const center = at < 0 ? pool.length : at;
  const start = Math.max(0, Math.min(center - Math.floor(max / 2), pool.length - max));
  return pool.slice(start, start + max).map((a) => a.label);
}

function missingArtikel(doc: BwbDocument, wanted: string, key: string): { reason: string; suggestions: string[] } {
  // "3.4" where the law numbers "3:4" (or the other way round): named, never applied silently.
  const swapped = key.includes(".") ? key.replace(/\./g, ":") : key.includes(":") ? key.replace(/:/g, ".") : undefined;
  const other = swapped ? doc.artikelen.find((a) => a.key === swapped) : undefined;
  if (other) {
    return {
      reason: `Deze regeling heeft geen artikel '${wanted}'; wel ${other.label} (deze regeling nummert met '${swapped?.includes(":") ? ":" : "."}').`,
      suggestions: [other.label],
    };
  }
  const suggestions = nearbyArtikelen(doc, key);
  return { reason: `Deze regeling heeft geen artikel '${wanted}' (${doc.artikelen.length} artikelen).`, suggestions };
}

/** "6:162 lid 2 sub b", "art. 3:4, aanhef en onder a" → the label without the onderdeel, and "b" / "a". */
export function splitOnderdeel(text: string): { label: string; onderdeel?: string } {
  const m = /[,\s]+(?:aanhef\s+en\s+)?(?:sub|onder|onderdeel)\s+([a-z]{1,3}|\d{1,3})[.°)]?$/i.exec(text.trim());
  return m && m.index > 0 ? { label: text.trim().slice(0, m.index).trim(), onderdeel: m[1].toLowerCase() } : { label: text.trim() };
}

/** The book of the Burgerlijk Wetboek a BWB id is ("6" for BWBR0005289), if it is one. */
function bwBoek(bwbId: string | undefined): string | undefined {
  if (!bwbId) return undefined;
  const id = bwbId.toUpperCase();
  return Object.keys(BW_BOEKEN).find((boek) => BW_BOEKEN[boek] === id);
}

const indentOf = (line: string) => /^\s*/.exec(line)?.[0].length ?? 0;

/**
 * Onderdeel `nr` ("b") in the lines of a lid or artikel: the unindented lines before
 * the list (the aanhef) and the list item numbered `nr` at the outermost list level,
 * with the items nested under it.
 */
function onderdeelLines(lines: string[], nr: string): string[] | undefined {
  const head = new RegExp(`^(\\s+)${nr}[.)°]?\\s`, "i");
  const outer = Math.min(...lines.filter((l) => /^\s+\S/.test(l)).map(indentOf));
  const at = lines.findIndex((l) => indentOf(l) === outer && head.test(l));
  if (at < 0) return undefined;
  let end = at + 1;
  while (end < lines.length && indentOf(lines[end]) > outer) end++;
  const aanhef = lines.slice(0, at).filter((l) => indentOf(l) === 0);
  return [...aanhef, ...lines.slice(at, end)];
}

/**
 * The text a call asks for: one artikel (or lid), the artikelen with all words of
 * a zoekterm, or the whole regeling, or its beginning with a table of contents
 * when it is longer than maxChars.
 */
export function selectBwbText(doc: BwbDocument, options: { artikel?: string; zoekterm?: string; maxChars: number }): BwbTextSelection {
  const { maxChars } = options;
  const totalChars = doc.totalChars;

  if (options.artikel?.trim()) {
    const wanted = cleanBwbInput(options.artikel);
    const { label: withLid, onderdeel } = splitOnderdeel(wanted);
    const { label, lid } = splitLid(withLid);
    let key = artikelKey(label);
    const byKey = (k: string) => doc.artikelen.filter((a) => a.key === k).sort((a, b) => Number(a.bijlage) - Number(b.bijlage));
    let found = byKey(key);
    // A book of the BW numbers its artikelen without the book: "6:162" is artikel 162 of Boek 6.
    const boek = bwBoek(doc.bwbId);
    const bookPrefix = boek ? /^(\d+a?):(.+)$/.exec(key) : null;
    if (!found.length && boek && bookPrefix) {
      if (bookPrefix[1] !== boek) {
        return {
          mode: "artikel",
          parts: [],
          totalChars,
          truncated: false,
          notFound: { reason: `'${label}' is een artikel van Boek ${bookPrefix[1]} BW; deze regeling is Boek ${boek} BW.`, suggestions: [`wet 'BW boek ${bookPrefix[1]}'`] },
        };
      }
      key = bookPrefix[2];
      found = byKey(key);
    }
    if (!found.length) return { mode: "artikel", parts: [], totalChars, truncated: false, notFound: missingArtikel(doc, label, key) };
    let parts: BwbTextPart[];
    if (lid) {
      const a = found[0];
      const l = a.leden.find((x) => x.nr === lid.toLowerCase());
      if (!l) {
        const nrs = a.leden.map((x) => x.nr);
        return {
          mode: "artikel",
          parts: [],
          totalChars,
          truncated: false,
          notFound: {
            reason: nrs.length ? `${a.label} heeft geen lid ${lid}; wel ${nrs.length === 1 ? "lid" : "de leden"} ${nrs.join(", ")}.` : `${a.label} heeft geen genummerde leden.`,
            suggestions: [a.label],
          },
        };
      }
      const lidLines = doc.lines.slice(l.from, l.to);
      const sub = onderdeel ? onderdeelLines(lidLines, onderdeel) : undefined;
      parts = [{
        artikel: a,
        lid,
        ...(onderdeel ? { onderdeel, ...(sub ? {} : { onderdeelNietGevonden: true }) } : {}),
        tekst: [doc.lines[a.from], ...(sub ?? lidLines)].join("\n"),
      }];
    } else if (onderdeel) {
      const a = found[0];
      const sub = onderdeelLines(doc.lines.slice(a.from, a.to), onderdeel);
      parts = [{ artikel: a, onderdeel, ...(sub ? { tekst: sub.join("\n") } : { onderdeelNietGevonden: true, tekst: artikelText(doc, a) }) }];
    } else {
      parts = found.map((a) => ({ artikel: a, tekst: artikelText(doc, a) }));
    }
    let remaining = maxChars;
    let truncated = false;
    const shown: BwbTextPart[] = [];
    for (const p of parts) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (p.tekst.length > remaining) {
        shown.push({ ...p, tekst: p.tekst.slice(0, remaining), ingekort: true, tekensVolledig: p.tekst.length });
        truncated = true;
        remaining = 0;
      } else {
        shown.push(p);
        remaining -= p.tekst.length;
      }
    }
    return { mode: "artikel", parts: shown, totalChars, truncated, matches: found.length };
  }

  const words = zoektermWords(options.zoekterm ?? "");
  if (words.length) {
    const hit = (text: string) => {
      const folded = foldText(text);
      return words.every(({ word, stem }) => folded.includes(word) || (stem !== undefined && folded.includes(stem)));
    };
    const lineHit = (line: string) => {
      const folded = foldText(line);
      return words.some(({ word, stem }) => folded.includes(word) || (stem !== undefined && folded.includes(stem)));
    };
    const matches = doc.artikelen.filter((a) => hit(artikelText(doc, a)));
    let remaining = maxChars;
    const parts: BwbTextPart[] = [];
    const omitted: string[] = [];
    for (const a of matches) {
      const tekst = artikelText(doc, a);
      if (tekst.length <= remaining) {
        parts.push({ artikel: a, tekst });
        remaining -= tekst.length;
      } else if (remaining >= 300) {
        // The kop and the lines with a word of the zoekterm, as far as they fit.
        const lines = doc.lines.slice(a.from, a.to);
        const excerpt = [lines[0], ...lines.slice(1).filter(lineHit)].join("\n");
        const cut = excerpt.slice(0, remaining);
        parts.push({ artikel: a, tekst: cut, ingekort: true, tekensVolledig: tekst.length });
        remaining -= cut.length;
      } else {
        omitted.push(a.label);
      }
    }
    return {
      mode: "zoekterm",
      parts,
      totalChars,
      truncated: omitted.length > 0 || parts.some((p) => p.ingekort),
      matches: matches.length,
      ...(omitted.length ? { omitted } : {}),
    };
  }

  const full = doc.lines.join("\n");
  if (full.length <= maxChars) return { mode: "volledig", parts: [{ tekst: full }], totalChars, truncated: false };
  // At most two thirds of max_chars for the table of contents, the rest for the beginning of the text.
  // A table of contents that does not fit loses its deepest headings first, then is cut.
  const budget = Math.floor((maxChars * 2) / 3);
  const deepest = doc.koppen.reduce((d, k) => Math.max(d, k.depth), 0);
  let depth = deepest;
  let toc = bwbTableOfContents(doc);
  while (toc.length > budget && depth > 0) toc = bwbTableOfContents(doc, --depth);
  const inhoudsopgave = cutAtLine(toc, budget);
  const begin = full.slice(0, Math.max(0, maxChars - inhoudsopgave.length));
  return {
    mode: "begin_met_inhoudsopgave",
    parts: [{ tekst: begin }],
    totalChars,
    truncated: true,
    inhoudsopgave,
    inhoudsopgaveVolledig: depth === deepest && inhoudsopgave.length === toc.length,
    inhoudsopgaveAfgekapt: inhoudsopgave.length < toc.length,
    ...(depth < deepest ? { inhoudsopgaveNiveaus: depth + 1 } : {}),
  };
}

/* ------------------------------------------------------------------ */
/*  Resolving a regeling                                              */
/* ------------------------------------------------------------------ */

/**
 * Names whose official afkorting is missing or shared in the BWB, each id checked
 * against the SRU (11 Oct 2026). Others resolve through the afkorting and title
 * indexes; an afkorting several regelingen share ('Ow', 'BW') gives candidates.
 */
const BW_BOEKEN: Record<string, string> = {
  "1": "BWBR0002656",
  "2": "BWBR0003045",
  "3": "BWBR0005291",
  "4": "BWBR0002761",
  "5": "BWBR0005288",
  "6": "BWBR0005289",
  "7": "BWBR0005290",
  "7a": "BWBR0006000",
  "8": "BWBR0005034",
  "10": "BWBR0030068",
};
const ALIASES: Record<string, string> = {
  "avg-uitvoeringswet": "BWBR0040940",
  "uitvoeringswet avg": "BWBR0040940",
};

/** "BW 6", "BW boek 6", "Boek 6 BW", "Burgerlijk Wetboek Boek 6", "6:162 BW"-less forms → BWB id. */
function aliasId(wet: string): string | undefined {
  const w = foldText(wet).replace(/\s+/g, " ").trim();
  if (ALIASES[w]) return ALIASES[w];
  const bw = /^(?:bw|burgerlijk wetboek)\s*(?:boek\s*)?(\d+a?)$/.exec(w) ?? /^boek\s*(\d+a?)\s*(?:bw|van het burgerlijk wetboek|burgerlijk wetboek)$/.exec(w);
  return bw ? BW_BOEKEN[bw[1]] : undefined;
}

/** 'BW' (no book) with artikel '6:162': the book the artikel names, when the BWB has it. */
function bwBoekVanArtikel(wet: string, artikel: string | undefined): string | undefined {
  if (!artikel || !/^(?:bw|burgerlijk wetboek)$/.test(foldText(wet).replace(/\s+/g, " ").trim())) return undefined;
  const boek = /^(\d+a?):/.exec(artikelKey(cleanBwbInput(artikel)))?.[1];
  return boek && BW_BOEKEN[boek] ? boek : undefined;
}

export interface BwbSruPage {
  items: BwbRegeling[];
  total: number;
  endpoint: string;
  params: Record<string, string>;
}

export type BwbKandidaatBasis = "naam" | "andere_data" | "titelwoorden";

export type BwbTekstResult =
  | {
      kind: "kandidaten";
      wet: string;
      candidates: BwbRegeling[];
      total: number;
      /**
       * "naam": several regelingen geldig on the peildatum have `wet` as afkorting or title;
       * "andere_data": several have it as afkorting, none geldig on the peildatum;
       * "titelwoorden": none has it as title or afkorting, these only have its words in their title.
       */
      basis: BwbKandidaatBasis;
      peildatum: string;
      endpoint: string;
      params: Record<string, string>;
    }
  | {
      kind: "tekst";
      regeling: BwbRegeling;
      doc: BwbDocument;
      selection: BwbTextSelection;
      peildatum: string;
      vandaag: boolean;
      /** How a `wet` was resolved, when it was. */
      resolved?: string;
      xmlUrl: string;
      sruEndpoint: string;
    };

export class WettenBwbSource {
  private readonly docs = new Map<string, { doc: BwbDocument; expires: number }>();
  private readonly loading = new Map<string, Promise<BwbDocument>>();

  constructor(private readonly config: AppConfig) {}

  /**
   * One SRU page, one record per regeling (or every version with `allVersions`).
   * A query the SRU rejects is an error, never an empty result.
   */
  private async sru(query: string, maximumRecords: number, startRecord = 1, allVersions = false): Promise<BwbSruPage> {
    const params: Record<string, string | number> = {
      "x-connection": BWB_CONNECTION,
      operation: "searchRetrieve",
      version: "1.2",
      query,
      maximumRecords,
      startRecord,
    };
    const { data, meta } = await getText(BWB_SRU_ENDPOINT, { query: params, connector: "wetten_bwb" });
    let parsed: unknown;
    try {
      parsed = parseXml(data);
    } catch (error) {
      throw new SourceRequestError({ message: `BWB SRU answer could not be read: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300), endpoint: meta.url, code: "malformed_response", status: meta.status });
    }
    const root = (parsed ?? {}) as Record<string, unknown>;
    // An answer that is no SRU response (an error page with HTTP 200) is a failure, never "no regeling".
    if (!root.searchRetrieveResponse && root.numberOfRecords === undefined) {
      throw new SourceRequestError({ message: "BWB SRU answered without a searchRetrieveResponse", endpoint: meta.url, code: "malformed_response", status: meta.status });
    }
    const diagnostic = sruDiagnostic(parsed);
    if (diagnostic) {
      throw new BwbTekstError("input", `De BWB-zoekdienst weigerde de zoekvraag (${diagnostic}).`, "Gebruik gewone woorden zonder leestekens of jokertekens, of een BWB-id.", { query });
    }
    const items = extractSruRecords(parsed)
      .map(extractBwb)
      .filter((r): r is BwbRegeling => Boolean(r));
    return {
      items: allVersions ? items : onePerRegeling(items),
      total: extractSruNumberOfRecords(parsed),
      endpoint: meta.url,
      params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    };
  }

  async search(args: { query: string; maximumRecords: number; startRecord?: number; peildatum?: string }) {
    const today = todayAmsterdam();
    const peildatum = args.peildatum ?? today;
    const query = cleanBwbInput(args.query);
    const notes = [
      "Bron: BWB geconsolideerde wetgeving via KOOP SRU. Gezocht op de titel-index (overheidbwb.titel).",
      `Per regeling de versie (toestand) die geldig is op ${peildatum}${args.peildatum ? "" : " (vandaag)"}; geldig_vanaf/geldig_tot is de geldigheidsperiode van die versie (geen geldig_tot: geen einddatum bekend), metadata_gewijzigd de laatste wijziging van het metadatarecord in de BWB, niet van de wet of de wettekst.`,
      "Regelingen zonder versie die op die dag geldt (ingetrokken, of nog niet in werking) staan er niet bij; zoek die met een peildatum binnen hun looptijd. De tekst van een regeling of artikel: wetten_bwb_tekst.",
    ];
    if (args.query.trim() && !query) {
      // Only invisible characters or emoji: nothing to search on, and never "every regeling".
      return { items: [] as Record<string, unknown>[], total: 0, endpoint: BWB_SRU_ENDPOINT, params: { query: args.query }, access_note: [...notes, "De zoekvraag bevat alleen onzichtbare tekens of emoji: er is niet gezocht. Geef woorden uit de titel."].join(" ") };
    }
    let page = await this.sru(bwbSearchCql(query, peildatum), args.maximumRecords, args.startRecord ?? 1);
    const wanted = foldText(query).replace(/\s+/g, " ").trim();
    const sameTitle = (r: BwbRegeling) => foldText(r.title ?? "").replace(/\s+/g, " ").trim() === wanted;
    // The SRU does not rank: the regeling with exactly this title ('Gemeentewet') can be far down
    // among the regelingen that only have the word in their title. It comes first.
    if (wanted && (args.startRecord ?? 1) === 1 && page.total > page.items.length && page.total <= EXACT_TITLE_LOOKUP && !page.items.some(sameTitle)) {
      const wider = await this.sru(bwbSearchCql(query, peildatum), Math.min(page.total, EXACT_TITLE_LOOKUP));
      const exact = wider.items.filter(sameTitle);
      if (exact.length) page = { ...page, items: [...exact, ...page.items].slice(0, Math.max(page.items.length, exact.length)) };
    }
    const ordered = [...page.items.filter(sameTitle), ...page.items.filter((r) => !sameTitle(r))];

    const items = ordered.map((r) => {
      const { zicht_vanaf: _zicht, ...rest } = r;
      return {
        ...rest,
        bwb_id: r.identifier,
        // Kept for clients of the earlier version: the same value as metadata_gewijzigd.
        date: r.metadata_gewijzigd,
        peildatum,
        // Without a peildatum the bare id: wetten.overheid.nl opens the version in force today.
        canonical_url: args.peildatum ? bwbVersieUrl(r) : `${WETTEN_URL}/${r.identifier}`,
        versie_url: bwbVersieUrl(r),
      } as Record<string, unknown>;
    });

    if (ordered.length && sameTitle(ordered[0])) notes.push(`${ordered[0].title} (${ordered[0].identifier}) heeft precies deze titel en staat bovenaan.`);
    if (query !== args.query.replace(/\s+/g, " ").trim()) notes.push(`Onzichtbare tekens of emoji zijn uit de zoekvraag gehaald; gezocht op '${query}'.`);
    // All hits are on this page, and none is the regeling with exactly this title: say whether it
    // (or anything) exists at other dates, so a repealed law (the Wob, the Wro) is not silently missing.
    const complete = (args.startRecord ?? 1) === 1 && page.total <= args.maximumRecords;
    if (wanted && complete && !page.items.some(sameTitle)) {
      const any = await this.sru(buildCql(query), 50);
      if (page.total === 0 && any.total > 0) {
        notes.push(
          `Geen regeling met deze titel geldt op ${peildatum}, maar de BWB heeft wel ${any.total} versies van regelingen met deze titel op andere data, bijv. ${any.items.slice(0, 3).map(describeVersion).join("; ")}. Geef een peildatum binnen die periode.`,
        );
      }
      const named = any.items.filter(sameTitle);
      if (named.length) {
        notes.push(
          `${named.map((r) => `${r.title} (${r.identifier})`).join("; ")} ${named.length === 1 ? "staat" : "staan"} er niet bij: geen versie geldt op ${peildatum} (ingetrokken, of nog niet in werking). wetten_bwb_tekst met dat bwb_id noemt de looptijd; zoek anders met een peildatum daarbinnen.`,
        );
      }
    }

    return {
      items,
      total: page.total,
      endpoint: page.endpoint,
      params: page.params,
      access_note: notes.join(" "),
    };
  }

  /** The version of regeling `id` geldig on `peildatum`; an explicit error when there is none or the id is unknown. */
  private async versionOf(id: string, peildatum: string): Promise<BwbRegeling & { sruEndpoint: string }> {
    const page = await this.sru(`dcterms.identifier=${id} and overheidbwb.geldigheidsdatum=${peildatum}`, 5);
    const version = page.items[0];
    if (version) return { ...version, sruEndpoint: page.endpoint };
    const any = await this.sru(`dcterms.identifier=${id}`, 100, 1, true);
    if (!any.total) {
      throw new BwbTekstError("not_found", `Onbekend BWB-id ${id}: de BWB heeft geen regeling met dit id.`, "Zoek het id op met wetten_bwb_search (titelwoorden), of geef wet met de titel of afkorting.", { bwb_id: id });
    }
    const title = any.items[0]?.title ?? id;
    let range = "";
    if (any.items.length === any.total) {
      const starts = any.items.map((r) => r.geldig_vanaf).filter((d): d is string => Boolean(d)).sort();
      const open = any.items.some((r) => !r.geldig_tot);
      const ends = any.items.map((r) => r.geldig_tot).filter((d): d is string => Boolean(d)).sort();
      if (starts.length) range = ` De versies in de BWB beslaan ${starts[0]} t/m ${open ? "heden (geen einddatum)" : ends[ends.length - 1]}.`;
    }
    throw new BwbTekstError(
      "no_version",
      `${title} (${id}) heeft geen versie die geldig is op ${peildatum}: de regeling gold toen nog niet of niet meer.${range}`,
      "Kies een peildatum binnen de looptijd van de regeling, of laat peildatum weg voor de versie van vandaag (als de regeling nog geldt).",
      { bwb_id: id, peildatum, versies_in_bwb: any.total },
    );
  }

  /** A `wet` as title or afkorting: one regeling, or the candidates when it is ambiguous. */
  private async resolveWet(wet: string, peildatum: string): Promise<{ id: string; how: string } | { candidates: BwbRegeling[]; total: number; endpoint: string; params: Record<string, string>; basis?: BwbKandidaatBasis }> {
    const alias = aliasId(wet);
    if (alias) return { id: alias, how: `'${wet}' opgevat als ${alias}` };
    const wanted = foldText(wet).replace(/\s+/g, " ").trim();
    const sameTitle = (r: BwbRegeling) => foldText(r.title ?? "").replace(/\s+/g, " ").trim() === wanted;

    if (wet.length <= 25) {
      const byAfkorting = await this.sru(`overheidbwb.afkorting=${cqlValue(wet.trim())} and overheidbwb.geldigheidsdatum=${peildatum}`, 20);
      if (byAfkorting.items.length === 1) return { id: byAfkorting.items[0].identifier, how: `afkorting '${wet}' = ${byAfkorting.items[0].title ?? byAfkorting.items[0].identifier}` };
      if (byAfkorting.items.length > 1) {
        const exact = byAfkorting.items.filter(sameTitle);
        if (exact.length === 1) return { id: exact[0].identifier, how: `titel '${exact[0].title}'` };
        return { candidates: byAfkorting.items, total: byAfkorting.total, endpoint: byAfkorting.endpoint, params: byAfkorting.params };
      }
    }

    const byTitle = await this.sru(bwbSearchCql(wet, peildatum), 50);
    const exact = byTitle.items.filter(sameTitle);
    if (exact.length === 1) return { id: exact[0].identifier, how: `titel '${exact[0].title}'` };
    if (exact.length > 1) return { candidates: exact, total: exact.length, endpoint: byTitle.endpoint, params: byTitle.params };
    if (!exact.length) {
      // The regeling with exactly this title or afkorting may not be geldig on the peildatum (the Wro,
      // the Wob): that is said as such, not answered with other regelingen that mention it.
      const anyDate = await this.sru(buildCql(wet), 50);
      const named = anyDate.items.filter(sameTitle);
      if (named.length === 1) return { id: named[0].identifier, how: `titel '${named[0].title}'` };
      if (wet.length <= 25) {
        const afkortingAnyDate = await this.sru(`overheidbwb.afkorting=${cqlValue(wet.trim())}`, 20);
        const ids = new Set(afkortingAnyDate.items.map((r) => r.identifier));
        if (ids.size === 1) return { id: afkortingAnyDate.items[0].identifier, how: `afkorting '${wet}' = ${afkortingAnyDate.items[0].title ?? afkortingAnyDate.items[0].identifier}` };
        // The afkorting of more than one regeling, none geldig on the peildatum (WRO 1965, Wro 2008).
        if (ids.size > 1) return { candidates: afkortingAnyDate.items, total: ids.size, endpoint: afkortingAnyDate.endpoint, params: afkortingAnyDate.params, basis: "andere_data" };
      }
    }
    // Only words of the title: candidates to choose from, even when there is one, never read as the regeling meant.
    if (byTitle.items.length) return { candidates: byTitle.items.slice(0, 10), total: byTitle.total, endpoint: byTitle.endpoint, params: byTitle.params, basis: "titelwoorden" };

    const any = await this.sru(buildCql(wet), 5);
    if (any.total) {
      throw new BwbTekstError(
        "no_version",
        `Geen regeling met '${wet}' in de titel of als afkorting geldt op ${peildatum}; wel op andere data, bijv. ${any.items.slice(0, 3).map(describeVersion).join("; ")}.`,
        "Kies een peildatum binnen die periode, of geef het bwb_id.",
        { wet, peildatum },
      );
    }
    throw new BwbTekstError("not_found", `Geen regeling gevonden met '${wet}' als titel of afkorting.`, "Zoek met wetten_bwb_search (titelwoorden) en geef het bwb_id, of gebruik de officiële afkorting (bijv. 'Awb', 'Sr', 'Gemw').", { wet });
  }

  private document(url: string): Promise<BwbDocument> {
    const cached = this.docs.get(url);
    if (cached && cached.expires > Date.now()) {
      this.docs.delete(url);
      this.docs.set(url, cached);
      return Promise.resolve(cached.doc);
    }
    // Two calls for the same toestand at once share one download and one parse.
    const pending = this.loading.get(url);
    if (pending) return pending;
    const load = this.loadDocument(url).finally(() => this.loading.delete(url));
    this.loading.set(url, load);
    return load;
  }

  private async loadDocument(url: string): Promise<BwbDocument> {
    // Not in the shared HTTP cache: a toestand is megabytes; the parsed text is kept here instead.
    const { data } = await getText(url, { connector: "wetten_bwb", timeoutMs: 60_000, retries: 1, disableCache: true, maxResponseBytes: BWB_XML_MAX_BYTES });
    let doc: BwbDocument;
    try {
      // A JSON round trip gives every kept string its own copy: slices of the XML (16 MB for the Bal)
      // would otherwise keep the whole download alive as long as the document is cached.
      doc = JSON.parse(JSON.stringify(parseBwbToestand(data))) as BwbDocument;
    } catch (error) {
      throw new SourceRequestError({ message: `BWB toestand XML could not be read: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300), endpoint: url, code: "malformed_response" });
    }
    // A maintenance page or a cut-off download (200 all the same) is an error, never a regeling without the
    // artikel asked for, and is not cached: the next call downloads again. Many regelingen (circulaires,
    // beleidsregels) have no <artikel>, so the check is on the toestand itself, not on its artikelen.
    const problem = bwbToestandProblem(data, doc);
    if (problem) {
      throw new BwbTekstError("upstream", `De KOOP-repository gaf geen bruikbare BWB-toestand terug: ${problem}.`, "Waarschijnlijk een tijdelijke storing; probeer het later opnieuw.", { xml_url: url });
    }
    this.docs.set(url, { doc, expires: Date.now() + DOC_CACHE_TTL_MS });
    while (this.docs.size > DOC_CACHE_MAX) this.docs.delete(this.docs.keys().next().value as string);
    return doc;
  }

  async tekst(args: { bwb_id?: string; wet?: string; artikel?: string; peildatum?: string; zoekterm?: string; max_chars?: number }): Promise<BwbTekstResult> {
    const today = todayAmsterdam();
    const peildatum = args.peildatum ?? today;
    const maxChars = Math.max(1, Math.min(BWB_TEXT_MAX_CHARS, args.max_chars ?? BWB_TEXT_DEFAULT_CHARS));
    const rawId = args.bwb_id === undefined ? undefined : cleanBwbInput(args.bwb_id);
    const wet = args.wet === undefined ? undefined : cleanBwbInput(args.wet);
    if (rawId && !BWB_ID.test(rawId)) {
      throw new BwbTekstError("input", `'${rawId}' is geen BWB-id.`, "Een BWB-id ziet eruit als BWBR0005537 (regeling) of BWBV0001000 (verdrag); geef anders wet met de titel of afkorting.", { bwb_id: rawId });
    }
    if (!rawId && !wet) throw new BwbTekstError("input", "Geef bwb_id of wet.", "Bijv. bwb_id 'BWBR0005537' of wet 'Awb' / 'Algemene wet bestuursrecht'.");
    if (args.zoekterm !== undefined && args.zoekterm.trim() && !zoektermWords(args.zoekterm).length) {
      throw new BwbTekstError("input", `Zoekterm '${args.zoekterm}' bevat geen woorden.`, "Geef een of meer woorden, bijv. 'belangenafweging'.");
    }

    let id = rawId?.toUpperCase();
    let resolved: string | undefined;
    if (!id && wet) {
      const boek = bwBoekVanArtikel(wet, args.artikel);
      if (BWB_ID.test(wet)) {
        id = wet.toUpperCase();
      } else if (boek) {
        id = BW_BOEKEN[boek];
        resolved = `'${wet}' met artikel '${args.artikel?.trim()}' opgevat als Burgerlijk Wetboek Boek ${boek} (${id})`;
      } else {
        const r = await this.resolveWet(wet, peildatum);
        if ("candidates" in r) return { kind: "kandidaten", wet, candidates: r.candidates, total: r.total, basis: r.basis ?? "naam", peildatum, endpoint: r.endpoint, params: r.params };
        id = r.id;
        resolved = r.how;
      }
    }

    const version = await this.versionOf(id as string, peildatum);
    const { sruEndpoint, zicht_vanaf: _zicht, ...regeling } = version;
    // Only the KOOP repository is fetched, whatever URL the SRU record names.
    if (!regeling.xml_url || !regeling.xml_url.startsWith(BWB_REPOSITORY)) {
      throw new BwbTekstError("upstream", `De BWB noemt geen XML-bestand in de KOOP-repository voor de versie van ${regeling.title ?? id} die op ${peildatum} geldt.`, `Lees de tekst op ${bwbVersieUrl(regeling)}.`, { bwb_id: id, peildatum, xml_url: regeling.xml_url });
    }
    const doc = await this.document(regeling.xml_url);
    if (!doc.lines.length) {
      throw new BwbTekstError("upstream", `De XML van de versie van ${regeling.title ?? id} die op ${peildatum} geldt, bevat geen tekst.`, `Lees de tekst op ${bwbVersieUrl(regeling)}.`, { bwb_id: id, peildatum, xml_url: regeling.xml_url });
    }
    const selection = selectBwbText(doc, { artikel: args.artikel, zoekterm: args.zoekterm, maxChars });
    return { kind: "tekst", regeling, doc, selection, peildatum, vandaag: peildatum === today, resolved, xmlUrl: regeling.xml_url, sruEndpoint };
  }
}
