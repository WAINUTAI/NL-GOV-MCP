import { randomUUID } from "node:crypto";

import type { AppConfig } from "../types.js";
import { getText, postJson, SourceRequestError } from "../utils/http.js";
import { foldText, parseXmlTree, zoektermWords, type XmlElement, type XmlNode } from "./dso-regeltekst.js";

interface RechtspraakItem {
  id?: string;
  title?: string;
  summary?: string;
  updated?: string;
  link?: string;
  ecli?: string;
  [key: string]: unknown;
}

interface RechtspraakApiResult {
  Tekstfragment?: string;
  Titel?: string;
  TitelEmphasis?: string;
  InterneUrl?: string;
  DeeplinkUrl?: string;
  Uitspraakdatum?: string;
  Publicatiedatum?: string;
  PublicatiedatumDate?: string;
  Rechtsgebieden?: string[];
  Proceduresoorten?: string[];
  [key: string]: unknown;
}

interface RechtspraakFacetItem {
  Identifier?: string;
  NodeType?: string | number;
  Count?: number;
  level?: number;
}

interface RechtspraakApiResponse {
  Results?: RechtspraakApiResult[];
  ResultCount?: number;
  FacetCounts?: {
    DatumPublicatie?: RechtspraakFacetItem[];
    DatumUitspraak?: RechtspraakFacetItem[];
    [key: string]: unknown;
  };
}

type RechtspraakSortOrder =
  | "Relevance"
  | "PublicatieDatumDesc"
  | "UitspraakDatumDesc"
  | "UitspraakDatumAsc";

const RECHTSPRAAK_SEARCH_PAGE = "https://uitspraken.rechtspraak.nl/resultaat";
const RECHTSPRAAK_SEARCH_API = "https://uitspraken.rechtspraak.nl/api/zoek";
const RECHTSPRAAK_CONTENT = "https://data.rechtspraak.nl/uitspraken/content";

function extractEcli(value: string): string | undefined {
  const m = value.match(/ECLI:[A-Z]{2}:[A-Z0-9]+:[0-9]{4}:[A-Z0-9.:-]+/i);
  return m ? m[0].toUpperCase() : undefined;
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function toIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();

  const m = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return undefined;
  const [, dd, mm, yyyy] = m;
  const parsed = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function correlationId32(): string {
  return randomUUID().replace(/-/g, "");
}

function resolveSearchTerm(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

function mapResult(item: RechtspraakApiResult): RechtspraakItem {
  const emphasis = String(item.TitelEmphasis ?? "").trim();
  const title = String(item.Titel ?? "").trim();
  const snippet = String(item.Tekstfragment ?? "").trim();
  const url = String(item.InterneUrl ?? item.DeeplinkUrl ?? "").trim();
  const ecli =
    extractEcli(`${emphasis} ${url} ${title}`) ??
    undefined;

  return {
    id: ecli ?? (url || `${RECHTSPRAAK_SEARCH_PAGE}`),
    title: [emphasis, title].filter(Boolean).join(", ") || ecli || "Rechtspraak uitspraak",
    summary: snippet,
    updated: toIsoDate(String(item.PublicatiedatumDate ?? item.Publicatiedatum ?? "")),
    link: url || (ecli ? `${RECHTSPRAAK_CONTENT}?id=${encodeURIComponent(ecli)}` : RECHTSPRAAK_SEARCH_PAGE),
    ecli,
    uitspraakdatum: item.Uitspraakdatum,
    publicatiedatum: item.Publicatiedatum,
    rechtsgebieden: toArray(item.Rechtsgebieden),
    procedures: toArray(item.Proceduresoorten),
  };
}

/** Where a human can continue the search themselves when this server found nothing. */
function searchPageUrl(query: string): string {
  const explicitEcli = extractEcli(query);
  return explicitEcli
    ? `${RECHTSPRAAK_CONTENT}?id=${encodeURIComponent(explicitEcli)}`
    : `${RECHTSPRAAK_SEARCH_PAGE}?zoekterm=${encodeURIComponent(query)}&inhoudsindicatie=zt0&sort=Relevance&publicatiestatus=ps1`;
}

function facetCount(
  facets: RechtspraakApiResponse["FacetCounts"] | undefined,
  facetName: "DatumPublicatie" | "DatumUitspraak",
  identifier: string,
): number | undefined {
  const group = toArray(facets?.[facetName]);
  const match = group.find((x) => String(x.Identifier ?? "") === identifier);
  const count = match?.Count;
  return typeof count === "number" ? count : undefined;
}

/* ------------------------------------------------------------------ */
/*  One ruling: metadata and text from data.rechtspraak.nl              */
/* ------------------------------------------------------------------ */

/** The human-readable page of a ruling; inziendocument?id= and deeplink.rechtspraak.nl redirect here. */
const RECHTSPRAAK_DETAILS = "https://uitspraken.rechtspraak.nl/details";

export const UITSPRAAK_DEFAULT_CHARS = 12_000;
export const UITSPRAAK_MAX_CHARS = 50_000;

/** ECLI:<land>:<gerecht>:<jaar>:<volgnummer>: a court code of 1-7 and an ordinal of at most 25 characters. */
const ECLI_IN_TEXT = /ECLI:[A-Z]{2}:[A-Z0-9]{1,7}:\d{4}:[A-Z0-9.]{1,25}/;

/**
 * The ECLI in what a caller passed: "ecli:nl:hr:2019:2006", a uitspraken.rechtspraak.nl
 * link (also %-encoded) or a sentence ending in one. Undefined when there is none.
 */
export function normalizeEcli(value: string): string | undefined {
  let text = value.trim();
  try {
    text = decodeURIComponent(text);
  } catch {
    // Not %-encoded after all: read as given.
  }
  const m = text.toUpperCase().match(ECLI_IN_TEXT);
  return m ? m[0].replace(/\.+$/, "") : undefined;
}

/** Sites whose links name a ruling by its ECLI. */
const ECLI_LINK_HOSTS = new Set(["uitspraken.rechtspraak.nl", "data.rechtspraak.nl", "deeplink.rechtspraak.nl"]);

/**
 * The one ECLI a caller asks for: a bare ECLI (any case) or a link of Rechtspraak.nl
 * (uitspraken, data or deeplink.rechtspraak.nl). A link to another site, or text
 * naming more than one ECLI, is refused with what to give instead, never read as
 * one of them.
 */
export function readEcliInput(value: string): { ecli: string } | { invalid: string; suggestion: string } {
  const text = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(?:www\.|[a-z0-9-]+\.rechtspraak\.nl\/)/i.test(text)) {
    let host = "";
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase();
    } catch {
      // Unreadable as a URL: refused below.
    }
    if (!ECLI_LINK_HOSTS.has(host)) {
      return {
        invalid: `'${text.slice(0, 100)}' is geen link van Rechtspraak.nl${host ? ` (host ${host})` : ""}.`,
        suggestion: "Geef de ECLI zelf, bijv. 'ECLI:NL:HR:2019:2006', of een link van uitspraken.rechtspraak.nl, data.rechtspraak.nl of deeplink.rechtspraak.nl.",
      };
    }
  }
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // Not %-encoded after all: read as given.
  }
  const all = [...new Set((decoded.toUpperCase().match(new RegExp(ECLI_IN_TEXT.source, "g")) ?? []).map((e) => e.replace(/\.+$/, "")))];
  if (all.length > 1) {
    return {
      invalid: `Meer dan één ECLI opgegeven (${all.slice(0, 5).join(", ")}${all.length > 5 ? ", …" : ""}); deze tool leest één uitspraak per aanroep.`,
      suggestion: "Roep de tool per ECLI aan.",
    };
  }
  const ecli = normalizeEcli(text);
  return ecli
    ? { ecli }
    : { invalid: `Geen geldige ECLI: '${text.slice(0, 100)}'.`, suggestion: "Een ECLI ziet eruit als 'ECLI:NL:HR:2019:2006' (land, gerecht, jaar, volgnummer). Zoek de ECLI met rechtspraak_search_ecli." };
}

export function uitspraakDetailsUrl(ecli: string): string {
  return `${RECHTSPRAAK_DETAILS}?id=${ecli}`;
}

/**
 * A tuchtrecht ruling (ECLI:NL:TGZ…, TAHVD, …) is registered at Rechtspraak with
 * metadata only; its text is on tuchtrecht.overheid.nl, which the metadata names.
 */
export function tuchtrechtUrl(meta: Pick<UitspraakMeta, "ecli" | "deeplink">): string | undefined {
  return meta.deeplink && /^https?:\/\/tuchtrecht\.overheid\.nl\//i.test(meta.deeplink) ? `https://tuchtrecht.overheid.nl/${meta.ecli}` : undefined;
}

/** The open data document (XML: metadata and text) of a ruling. */
export function uitspraakDataUrl(ecli: string): string {
  return `${RECHTSPRAAK_CONTENT}?id=${ecli}`;
}

export interface UitspraakRelatie {
  ecli?: string;
  /** As Rechtspraak words it: "In cassatie op: ECLI:NL:GHDHA:2018:2591, Bekrachtiging/bevestiging". */
  omschrijving: string;
  /** cassatie, hogerberoep, conclusie, ... (from psi:type). */
  soort?: string;
  aanleg?: "eerdere aanleg" | "latere aanleg";
  /** What the later instance did with it: gevolgd, bekrachtiging/bevestiging, vernietiging met verwijzen, ... */
  gevolg?: string;
}

export interface UitspraakMeta {
  ecli: string;
  titel?: string;
  instantie?: string;
  uitspraakdatum?: string;
  publicatiedatum?: string;
  gewijzigd?: string;
  zaaknummer?: string;
  /** "Uitspraak" or "Conclusie" (dcterms:type). */
  documenttype?: string;
  procedures: string[];
  rechtsgebieden: string[];
  zittingsplaats?: string;
  /** What this publication replaces (dcterms:replaces): the LJN of an older ruling, or an earlier ECLI. */
  vervangt?: string;
  relaties: UitspraakRelatie[];
  wetsverwijzingen: string[];
  vindplaatsen: string[];
  deeplink?: string;
}

/** titel: a section heading; kop: a bridgehead or heading line; tabel: one table row. */
export type UitspraakBlockKind = "titel" | "kop" | "tekst" | "tabel";

export interface UitspraakBlock {
  /** Index in sections of the innermost section; -1 before the first (the kop: court, parties, zaaknummer). */
  section: number;
  /** Number of the paragraph (rechtsoverweging) the block belongs to: "4.3". */
  nr?: string;
  kind: UitspraakBlockKind;
  text: string;
  /** Labels of the footnotes the block refers to. */
  notes: string[];
}

export interface UitspraakSection {
  nr?: string;
  title: string;
  /** role attribute of the section: "beslissing", "overwegingen", "procesverloop", ... */
  role?: string;
  level: number;
  parent: number;
  /** Blocks [from, to): its heading, its text and any subsections. */
  from: number;
  to: number;
  /** Read from a numbered heading line ("6. Beslissing") in a text without section markup. */
  derived?: boolean;
}

export interface ParsedUitspraak {
  meta: UitspraakMeta;
  /** The text element: <uitspraak> or <conclusie> (of an Advocaat-Generaal); undefined when no text is published. */
  soort?: "uitspraak" | "conclusie";
  inhoudsindicatie?: string;
  blocks: UitspraakBlock[];
  sections: UitspraakSection[];
  footnotes: Array<{ label: string; text: string }>;
}

function childElements(node: XmlElement, name?: string): XmlElement[] {
  return node.children.filter((c): c is XmlElement => typeof c !== "string" && (name === undefined || c.name === name));
}

function allDescendants(node: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const child of childElements(node)) {
    if (child.name === name) out.push(child);
    else allDescendants(child, name, out);
  }
  return out;
}

function squashText(node: XmlNode | undefined): string {
  if (node === undefined) return "";
  const raw = typeof node === "string" ? node : node.children.map(squashText).join(" ");
  return raw.replace(/\s+/g, " ").trim();
}

/** Lines of inline text: whitespace runs squashed, line breaks (<?linebreak?>) kept. */
function cleanLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Elements that make a <para> a container rather than a line of text. */
const NESTED_BLOCKS = new Set(["para", "parablock", "paragroup", "table", "informaltable", "itemizedlist", "orderedlist", "blockquote"]);

/** "29.    De Werkgroep betoogt", "5.4.3 Anders dan": the paragraph number a line starts with. */
function leadingNr(text: string): string | undefined {
  const m = text.match(/^(\d{1,3}(?:\.\d{1,3})+|\d{1,3}\.)\.?\s+\S/);
  return m ? m[1].replace(/\.+$/, "") : undefined;
}

function normalizeNr(nr: string | undefined): string | undefined {
  const n = nr?.replace(/\s+/g, "").replace(/\.+$/, "");
  return n || undefined;
}

class UitspraakBuilder {
  readonly blocks: UitspraakBlock[] = [];
  readonly sections: UitspraakSection[] = [];
  private current = -1;
  private depth = 0;
  /** Number of the enclosing <paragroup>, and the prefix its first line still needs. */
  private groupNr?: string;
  private pendingPrefix?: string;
  /** Number of the last numbered line, for the unnumbered lines that continue it. */
  private carry?: string;

  constructor(private readonly labels: Map<string, string>) {}

  private inline(node: XmlNode, refs: string[]): string {
    if (typeof node === "string") return node.replace(/\s+/g, " ");
    switch (node.name) {
      case "linebreak":
        return "\n";
      case "footnote-ref": {
        const label = this.labels.get(node.attrs.linkend ?? "");
        if (!label) return "";
        refs.push(label);
        return `[noot ${label}]`;
      }
      case "footnote":
        return "";
      case "mediaobject":
      case "inlinemediaobject":
        return " [afbeelding] ";
      default:
        return node.children.map((c) => this.inline(c, refs)).join("");
    }
  }

  private emit(kind: UitspraakBlockKind, node: XmlNode | XmlNode[]): void {
    const refs: string[] = [];
    const nodes = Array.isArray(node) ? node : [node];
    let text = cleanLines(nodes.map((n) => this.inline(n, refs)).join(""));
    if (!text) return;
    let nr = this.groupNr ?? this.carry;
    if (kind === "tekst" && !this.groupNr) {
      const lead = leadingNr(text);
      if (lead) nr = this.carry = lead;
    }
    if (this.pendingPrefix && kind !== "titel") {
      text = `${this.pendingPrefix} ${text}`;
      this.pendingPrefix = undefined;
    }
    this.blocks.push({ section: this.current, nr, kind, text, notes: [...new Set(refs)] });
  }

  walk(node: XmlElement): void {
    for (const child of node.children) {
      if (typeof child === "string") {
        if (child.trim()) this.emit("tekst", child);
        continue;
      }
      switch (child.name) {
        case "section":
          this.section(child);
          break;
        case "paragroup":
          this.paragroup(child);
          break;
        case "para":
        case "simpara":
          if (childElements(child).some((c) => NESTED_BLOCKS.has(c.name))) this.walk(child);
          else this.emit("tekst", child);
          break;
        case "bridgehead":
        case "title":
          this.emit("kop", child);
          break;
        case "table":
        case "informaltable":
          this.table(child);
          break;
        case "mediaobject":
          this.emit("tekst", child);
          break;
        case "nr":
        case "footnote":
          break;
        default:
          this.walk(child);
      }
    }
  }

  private section(el: XmlElement): void {
    const titleEl = childElements(el, "title")[0];
    const nrEl = titleEl ? childElements(titleEl, "nr")[0] : undefined;
    const nr = normalizeNr(squashText(nrEl));
    const title = titleEl ? cleanLines(titleEl.children.filter((c) => c !== nrEl).map((c) => this.inline(c, [])).join("")).replace(/\n/g, " ") : "";
    const index = this.sections.length;
    this.sections.push({ nr, title, role: el.attrs.role || undefined, level: this.depth + 1, parent: this.current, from: this.blocks.length, to: this.blocks.length });
    const parent = this.current;
    const outerGroup = this.groupNr;
    this.current = index;
    this.depth++;
    this.groupNr = undefined;
    this.carry = undefined;
    const heading = [nr, title].filter(Boolean).join(" ");
    if (heading) this.blocks.push({ section: index, kind: "titel", text: heading, notes: [] });
    this.walk({ ...el, children: el.children.filter((c) => c !== titleEl) });
    this.sections[index].to = this.blocks.length;
    this.current = parent;
    this.depth--;
    this.groupNr = outerGroup;
    this.carry = undefined;
  }

  private paragroup(el: XmlElement): void {
    const nr = normalizeNr(squashText(childElements(el, "nr")[0]));
    const outer = this.groupNr;
    if (nr) {
      this.groupNr = nr;
      this.pendingPrefix = nr;
    }
    this.walk(el);
    // A number that introduced nothing (an empty paragroup) is not carried on.
    this.pendingPrefix = undefined;
    this.groupNr = outer;
    this.carry = undefined;
  }

  private table(el: XmlElement): void {
    const caption = childElements(el, "title")[0];
    if (caption) this.emit("kop", caption);
    for (const row of allDescendants(el, "row")) {
      const cells = childElements(row, "entry").map((entry) => cleanLines(entry.children.map((c) => this.inline(c, [])).join(" ")).replace(/\n/g, " "));
      if (cells.some(Boolean)) this.blocks.push({ section: this.current, nr: this.groupNr ?? this.carry, kind: "tabel", text: cells.join(" | "), notes: [] });
    }
  }
}

/**
 * A text without section markup (older rulings) gets its sections from its
 * numbered heading lines: "1. Het geding in feitelijke instanties" … "6. Beslissing".
 * Only a short line without closing punctuation counts, and only in sequence
 * from 1, so a numbered dictum line ("1. wijst de vordering af.") never does.
 */
function deriveSections(blocks: UitspraakBlock[], sections: UitspraakSection[]): void {
  let expected = 1;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== "tekst") continue;
    const m = b.text.match(/^(\d{1,2})\.\s+(\p{Lu}[^.:;!?\n]{1,80})$/u);
    if (!m || Number(m[1]) !== expected) continue;
    expected++;
    if (sections.length) sections[sections.length - 1].to = i;
    sections.push({ nr: m[1], title: m[2].trim(), level: 1, parent: -1, from: i, to: blocks.length, derived: true });
    b.kind = "titel";
  }
  for (let s = 0; s < sections.length; s++) {
    for (let i = sections[s].from; i < sections[s].to; i++) blocks[i].section = s;
  }
}

function lastSegment(uri: string | undefined, separator: "/" | "#"): string | undefined {
  if (!uri) return undefined;
  const at = uri.lastIndexOf(separator);
  const tail = at >= 0 ? uri.slice(at + 1) : uri;
  return tail || undefined;
}

function parseMeta(rdf: XmlElement | undefined, ecli: string): UitspraakMeta {
  const descriptions = rdf ? childElements(rdf, "Description") : [];
  const main = descriptions.find((d) => !d.attrs.about) ?? descriptions[0];
  const page = descriptions.find((d) => d.attrs.about);
  const texts = (desc: XmlElement | undefined, name: string) => (desc ? childElements(desc, name).map(squashText).filter(Boolean) : []);
  const one = (desc: XmlElement | undefined, name: string) => texts(desc, name)[0];
  const relaties = (main ? childElements(main, "relation") : []).map((r): UitspraakRelatie => {
    const aanleg = r.attrs.aanleg ?? "";
    return {
      ecli: normalizeEcli(r.attrs.resourceIdentifier ?? "") ?? normalizeEcli(squashText(r)),
      omschrijving: squashText(r).replace(/\s+:/g, ":"),
      soort: lastSegment(r.attrs.type, "/"),
      aanleg: /eerdereAanleg$/i.test(aanleg) ? "eerdere aanleg" : /latereAanleg$/i.test(aanleg) ? "latere aanleg" : undefined,
      gevolg: lastSegment(r.attrs.gevolg, "#"),
    };
  });
  const hasVersion = main ? childElements(main, "hasVersion")[0] : undefined;
  return {
    ecli: normalizeEcli(one(main, "identifier") ?? "") ?? ecli,
    titel: one(page, "title")?.replace(/\s+,/g, ","),
    instantie: one(main, "creator"),
    uitspraakdatum: one(main, "date"),
    publicatiedatum: one(main, "issued"),
    gewijzigd: one(main, "modified"),
    zaaknummer: texts(main, "zaaknummer").join(", ") || undefined,
    documenttype: one(main, "type"),
    procedures: texts(main, "procedure"),
    rechtsgebieden: texts(main, "subject"),
    zittingsplaats: one(main, "spatial"),
    vervangt: one(main, "replaces"),
    relaties,
    wetsverwijzingen: texts(main, "references"),
    vindplaatsen: hasVersion ? allDescendants(hasVersion, "li").map(squashText).filter(Boolean) : [],
    deeplink: page?.attrs.about,
  };
}

/** Blocks of an element as plain lines: the inhoudsindicatie. */
function plainBlocks(el: XmlElement | undefined): string | undefined {
  if (!el) return undefined;
  const builder = new UitspraakBuilder(new Map());
  builder.walk(el);
  const text = builder.blocks.map((b) => b.text).join("\n").trim();
  // An inhoudsindicatie of only "-" says there is none.
  return text && !/^[-–.\s]*$/.test(text) ? text : undefined;
}

/**
 * Read an open-rechtspraak document: the RDF metadata, the inhoudsindicatie and
 * the text (<uitspraak>, or <conclusie> for an Advocaat-Generaal) as blocks in
 * document order, with its sections and footnotes. The text is kept as
 * published, anonymisation ("[gedaagde]") included.
 */
export function parseUitspraakXml(xml: string, ecli: string): ParsedUitspraak {
  // <?linebreak?> breaks a line inside a paragraph; the tree parser skips processing instructions.
  const tree = parseXmlTree(xml.replace(/<\?linebreak\s*\?>/g, "<linebreak/>"));
  const root = childElements(tree, "open-rechtspraak")[0];
  if (!root) {
    throw new SourceRequestError({
      message: "Antwoord van data.rechtspraak.nl is geen open-rechtspraak-document",
      endpoint: RECHTSPRAAK_CONTENT,
      code: "malformed_response",
    });
  }
  const meta = parseMeta(childElements(root, "RDF")[0], ecli);
  const body = childElements(root).find((c) => c.name === "uitspraak" || c.name === "conclusie");
  const inhoudsindicatie = plainBlocks(childElements(root, "inhoudsindicatie")[0]);
  if (!body) return { meta, inhoudsindicatie, blocks: [], sections: [], footnotes: [] };

  const labels = new Map<string, string>();
  const footnoteEls = allDescendants(body, "footnote");
  footnoteEls.forEach((f, i) => {
    if (f.attrs.id) labels.set(f.attrs.id, f.attrs.label || String(i + 1));
  });
  const builder = new UitspraakBuilder(labels);
  builder.walk(body);
  const footnotes = footnoteEls
    .map((f, i) => {
      const nested = new UitspraakBuilder(labels);
      nested.walk(f);
      return { label: f.attrs.label || String(i + 1), text: nested.blocks.map((b) => b.text).join("\n") };
    })
    .filter((f) => f.text);
  const { blocks, sections } = builder;
  if (!sections.length) deriveSections(blocks, sections);
  return { meta, soort: body.name as "uitspraak" | "conclusie", inhoudsindicatie, blocks, sections, footnotes };
}

/* ------------------------------------------------------------------ */
/*  Selecting text: beslissing, overwegingen, sectie, zoekterm          */
/* ------------------------------------------------------------------ */

export type UitspraakOnderdeel = "overzicht" | "beslissing" | "overwegingen" | "volledig";

type Range = { from: number; to: number };

interface FoundPart {
  ranges: Range[];
  label: string;
  methode: string;
}

const BESLISSING_TITLE = /^(?:de\s+)?(?:beslissing|dictum|(?:the\s+)?decision)\b/i;
const BESLISSING_LINE = /^(?:\d+(?:\.\d+)*\.?\s+)?(?:de\s+)?(?:beslissing|dictum|(?:the\s+)?decision)\s*:?$/i;
const SLOTSOM_TITLE = /^(?:de\s+)?(?:slotsom|conclusie|conclusion)\b/i;
const SLOTSOM_LINE = /^(?:\d+(?:\.\d+)*\.?\s+)?(?:de\s+)?(?:slotsom|conclusie|conclusion)\s*:?$/i;
const OVERWEGINGEN_TITLE = /(?:^|\s)(?:beoordeling|overwegingen|overweging|motivering|bespreking|assessment|considerations)\b/i;
const APPENDIX_LINE = /^(?:bijlagen?|lijst van (?:gebruikte )?afkortingen|afkortingenlijst|annex)\b/i;
/** Sections that set out the case before the court weighs it. */
const INTRO_TITLE = /procesverloop|procedure|proceedings|geding|feiten|facts|geschil|dispute|vordering|uitgangspunten|ontstaan en loop|inleiding|verloop/i;

/** "B E S L I S S I N G" reads as "BESLISSING". */
function unspaced(text: string): string {
  return /^(?:\p{L} ){3,}\p{L}$/u.test(text) ? text.replace(/ /g, "") : text;
}

function sectionLabel(section: UitspraakSection): string {
  return [section.nr, section.title].filter(Boolean).join(" ") || "(sectie zonder titel)";
}

/** Top-level sections: the parts of the text in order. */
function topSections(doc: ParsedUitspraak): number[] {
  return doc.sections.map((s, i) => (s.parent === -1 ? i : -1)).filter((i) => i >= 0);
}

/** The block a heading line sits in, to the end of its section (or of the text). */
function lineRange(doc: ParsedUitspraak, test: RegExp): { range: Range; text: string } | undefined {
  for (let i = doc.blocks.length - 1; i >= 0; i--) {
    const b = doc.blocks[i];
    if (b.kind === "tabel" || b.text.length > 60 || !test.test(unspaced(b.text))) continue;
    // Before the first section (the text is only partly marked up) it runs to where the sections begin.
    const next = doc.sections.find((s) => s.from > i);
    const end = b.section >= 0 && !doc.sections[b.section].derived ? doc.sections[b.section].to : b.section < 0 && next ? next.from : doc.blocks.length;
    return { range: { from: i, to: end }, text: b.text };
  }
  return undefined;
}

function lastTitled(doc: ParsedUitspraak, test: RegExp): number | undefined {
  for (let i = doc.sections.length - 1; i >= 0; i--) if (test.test(unspaced(doc.sections[i].title))) return i;
  return undefined;
}

function sectionRange(doc: ParsedUitspraak, index: number): Range {
  return { from: doc.sections[index].from, to: doc.sections[index].to };
}

/**
 * Where the decision is: a section marked role="beslissing", else a section
 * titled "Beslissing"/"De beslissing"/"Dictum", else such a heading line in the
 * text, else the slotsom or conclusie. In a conclusie of an Advocaat-Generaal
 * the closing "Conclusie" (the advice) comes first. The method says which.
 */
export function findBeslissing(doc: ParsedUitspraak): FoundPart | undefined {
  const found = locateBeslissing(doc);
  if (!found) return undefined;
  // A list of abbreviations or a bijlage after the signature is no part of the decision.
  let trimmed = false;
  const ranges = found.ranges.map((r) => {
    for (let i = r.from + 1; i < r.to; i++) {
      const b = doc.blocks[i];
      if (b.kind !== "tabel" && b.text.length <= 60 && APPENDIX_LINE.test(b.text)) {
        trimmed = true;
        return { from: r.from, to: i };
      }
    }
    return r;
  });
  return trimmed ? { ...found, ranges, methode: `${found.methode}; de bijlage erna is niet meegenomen (onderdeel 'volledig' of een sectie geeft die wel)` } : found;
}

function locateBeslissing(doc: ParsedUitspraak): FoundPart | undefined {
  const slotsom = (): FoundPart | undefined => {
    const s = lastTitled(doc, SLOTSOM_TITLE);
    if (s !== undefined) {
      return doc.soort === "conclusie"
        ? { ranges: [sectionRange(doc, s)], label: sectionLabel(doc.sections[s]), methode: `conclusie van de Advocaat-Generaal: sectie '${sectionLabel(doc.sections[s])}' (een advies aan de rechter, geen beslissing)` }
        : { ranges: [sectionRange(doc, s)], label: sectionLabel(doc.sections[s]), methode: `slotsom: sectie '${sectionLabel(doc.sections[s])}' (geen sectie of kop 'Beslissing' gevonden)` };
    }
    const line = lineRange(doc, SLOTSOM_LINE);
    return line ? { ranges: [line.range], label: line.text, methode: `slotsom: kopregel '${line.text}' in de tekst (geen sectie of kop 'Beslissing' gevonden)` } : undefined;
  };
  if (doc.soort === "conclusie") {
    const found = slotsom();
    if (found) return found;
  }
  const marked = doc.sections.map((s, i) => (s.role === "beslissing" ? i : -1)).filter((i) => i >= 0 && !doc.sections.slice(0, i).some((p) => p.role === "beslissing" && p.to >= doc.sections[i].to));
  if (marked.length) {
    return { ranges: marked.map((i) => sectionRange(doc, i)), label: marked.map((i) => sectionLabel(doc.sections[i])).join("; "), methode: 'rol: sectie gemarkeerd als role="beslissing"' };
  }
  const titled = lastTitled(doc, BESLISSING_TITLE);
  if (titled !== undefined) {
    const s = doc.sections[titled];
    return { ranges: [sectionRange(doc, titled)], label: sectionLabel(s), methode: s.derived ? `kopregel '${s.nr}. ${s.title}' in de tekst (geen sectie-opmaak)` : `sectietitel '${sectionLabel(s)}'` };
  }
  const line = lineRange(doc, BESLISSING_LINE);
  if (line) return { ranges: [line.range], label: line.text, methode: `kopregel '${line.text}' in de tekst` };
  return doc.soort === "conclusie" ? undefined : slotsom();
}

/**
 * The court's reasoning: sections marked role="overwegingen", else sections
 * titled "beoordeling"/"overwegingen"/"motivering", else the sections between
 * the opening ones (procesverloop, feiten, geschil) and the beslissing.
 */
export function findOverwegingen(doc: ParsedUitspraak): FoundPart | undefined {
  const top = topSections(doc);
  const marked = top.filter((i) => doc.sections[i].role === "overwegingen");
  if (marked.length) {
    // A marked section of only its heading (the CRvB writes "OVERWEGINGEN" so) is followed by the
    // unmarked sections that hold the reasoning: they run on to the next marked one (the beslissing).
    const followers: number[] = [];
    const ranges = marked.map((i): Range => {
      const s = doc.sections[i];
      if (s.to - s.from > 1) return sectionRange(doc, i);
      let j = top.indexOf(i) + 1;
      while (j < top.length && !doc.sections[top[j]].role) j++;
      if (j >= top.length || j === top.indexOf(i) + 1) return sectionRange(doc, i);
      followers.push(...top.slice(top.indexOf(i) + 1, j));
      return { from: s.from, to: doc.sections[top[j]].from };
    });
    const labels = [...marked, ...followers].sort((x, y) => x - y).map((i) => sectionLabel(doc.sections[i]));
    return {
      ranges,
      label: labels.join("; "),
      methode: followers.length
        ? 'rol: sectie gemarkeerd als role="overwegingen" (alleen een kop) met de ongemarkeerde secties erna tot de volgende gemarkeerde sectie'
        : 'rol: secties gemarkeerd als role="overwegingen"',
    };
  }
  const titled = top.filter((i) => OVERWEGINGEN_TITLE.test(doc.sections[i].title));
  if (titled.length) {
    return { ranges: titled.map((i) => sectionRange(doc, i)), label: titled.map((i) => sectionLabel(doc.sections[i])).join("; "), methode: `sectietitel ${titled.map((i) => `'${sectionLabel(doc.sections[i])}'`).join(", ")}` };
  }
  const beslissing = findBeslissing(doc);
  const end = beslissing?.ranges[0].from;
  if (end === undefined || !top.length) return undefined;
  let first = 0;
  while (first < top.length && INTRO_TITLE.test(doc.sections[top[first]].title) && !BESLISSING_TITLE.test(doc.sections[top[first]].title)) first++;
  const between = top.slice(first).filter((i) => doc.sections[i].from < end);
  if (!between.length || first === 0) return undefined;
  const from = doc.sections[between[0]].from;
  return {
    ranges: [{ from, to: end }],
    label: between.map((i) => sectionLabel(doc.sections[i])).join("; "),
    methode: `positie: de secties tussen '${sectionLabel(doc.sections[top[first - 1]])}' en de beslissing (geen sectie gemarkeerd of getiteld als overwegingen)`,
  };
}

/** Section ids for a follow-up call: the section number, or "#n" when it has none (or shares it). */
function sectionIds(doc: ParsedUitspraak): string[] {
  const counts = new Map<string, number>();
  for (const s of doc.sections) if (s.nr) counts.set(s.nr, (counts.get(s.nr) ?? 0) + 1);
  return doc.sections.map((s, i) => (s.nr && counts.get(s.nr) === 1 ? s.nr : `#${i + 1}`));
}

function rangeChars(doc: ParsedUitspraak, range: Range): number {
  let n = 0;
  for (let i = range.from; i < range.to; i++) n += doc.blocks[i].text.length + 1;
  return n;
}

export interface UitspraakTocEntry {
  sectie: string;
  titel: string;
  rol?: string;
  niveau?: number;
  tekens: number;
}

/** The table of contents: every section with its id, title, role and length; the kop first. */
export function uitspraakInhoudsopgave(doc: ParsedUitspraak): UitspraakTocEntry[] {
  const ids = sectionIds(doc);
  const toc: UitspraakTocEntry[] = [];
  const kopEnd = doc.sections.length ? doc.sections[0].from : 0;
  if (kopEnd > 0) toc.push({ sectie: "kop", titel: "Kop (gerecht, partijen, zaaknummer)", tekens: rangeChars(doc, { from: 0, to: kopEnd }) });
  doc.sections.forEach((s, i) => {
    toc.push({
      sectie: ids[i],
      titel: s.title || "(sectie zonder titel)",
      ...(s.role ? { rol: s.role } : {}),
      ...(s.level > 1 ? { niveau: s.level } : {}),
      tekens: rangeChars(doc, s),
    });
  });
  return toc;
}

/** "r.o. 4.3." → "4.3": a sectie as matched. */
function normalizeSectie(sectie: string): string {
  return sectie
    .trim()
    .replace(/^(?:r\.?\s*o\.?|rov\.?|rechtsoverweging|overweging|sectie|hoofdstuk|punt|§)\s*/i, "")
    .replace(/\.+$/, "")
    .trim();
}

/** Words that never pick a section by its title on their own. */
const SECTIE_STOPWORDS = new Set(["het", "een", "van", "voor", "aan", "door", "bij", "naar", "over", "tot", "uit", "als", "dat", "die", "met", "ten", "ter", "der", "des", "and", "not", "the"]);

/** The words of a sectie matched against section titles: numbers, and words of three letters or more that are no stopword. */
function sectieTitleWords(s: string): string[] {
  return zoektermWords(s)
    .map((w) => w.word)
    .filter((w) => /^\d+$/.test(w) || (w.length >= 3 && !SECTIE_STOPWORDS.has(w)));
}

/** Whether a sectie names something to look for: an id, a number or a meaningful title word; '") OR ("' names nothing. */
export function sectieIsReadable(sectie: string): boolean {
  const s = normalizeSectie(sectie);
  // One id-like token ('4', '#2', '4.3', 'II', 'kop') may be a section number or id.
  return /^#?[\p{L}\p{N}]{1,8}(?:\.[\p{L}\p{N}]+)*$/u.test(s) || sectieTitleWords(s).length > 0;
}

/** One section by number ("4"), id ("#3", "kop"), paragraph number ("4.3", "r.o. 4.3") or title words ("beoordeling"). */
function findSectie(doc: ParsedUitspraak, sectie: string): FoundPart | { suggestions: string[] } {
  const s = normalizeSectie(sectie);
  const ids = sectionIds(doc);
  const pick = (i: number): FoundPart => ({ ranges: [sectionRange(doc, i)], label: sectionLabel(doc.sections[i]), methode: "sectie" });
  if (/^kop$/i.test(s) && doc.sections.length && doc.sections[0].from > 0) {
    return { ranges: [{ from: 0, to: doc.sections[0].from }], label: "kop", methode: "sectie" };
  }
  const byId = ids.findIndex((id) => id === s);
  if (byId >= 0) return pick(byId);
  if (/^\d+(?:\.\d+)*$/.test(s)) {
    // The first run of blocks with that number (and its subnumbers): a dictum line "1." later on is another paragraph.
    const first = doc.blocks.findIndex((b) => b.kind !== "titel" && (b.nr === s || b.nr?.startsWith(`${s}.`)));
    if (first >= 0) {
      let end = first + 1;
      while (end < doc.blocks.length && doc.blocks[end].kind !== "titel" && (doc.blocks[end].nr === s || doc.blocks[end].nr?.startsWith(`${s}.`))) end++;
      return { ranges: [{ from: first, to: end }], label: `nr. ${s}`, methode: "paragraafnummer" };
    }
  } else {
    // Whole words (or the start of one: 'beoordel' finds 'Beoordeling'), never a fragment inside a word.
    const words = sectieTitleWords(s);
    const titles = doc.sections.map((x) => foldText(x.title));
    const exact = titles.findIndex((t) => t === foldText(s));
    const titleWords = titles.map((t) => t.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    const containing = words.length ? titleWords.findIndex((tw) => words.every((w) => tw.some((x) => (/^\d+$/.test(w) ? x === w : x.startsWith(w))))) : -1;
    if (exact >= 0) return pick(exact);
    if (containing >= 0) return pick(containing);
  }
  return { suggestions: uitspraakInhoudsopgave(doc).slice(0, 20).map((e) => `${e.sectie} ${e.titel}`) };
}

function renderRange(doc: ParsedUitspraak, ranges: Range[], withNotes: boolean): string {
  const lines: string[] = [];
  const notes = new Set<string>();
  for (const r of ranges) {
    for (let i = r.from; i < r.to; i++) {
      const b = doc.blocks[i];
      if (b.kind === "titel") {
        const level = b.section >= 0 ? doc.sections[b.section].level : 1;
        if (lines.length) lines.push("");
        lines.push(`${"#".repeat(Math.min(level + 1, 4))} ${b.text}`);
      } else {
        lines.push(b.text);
      }
      for (const n of b.notes) notes.add(n);
    }
  }
  let text = lines.join("\n").trim();
  if (withNotes && notes.size) {
    const shown = doc.footnotes.filter((f) => notes.has(f.label));
    if (shown.length) text += `\n\nVoetnoten:\n${shown.map((f) => `[noot ${f.label}] ${f.text}`).join("\n")}`;
  }
  return text;
}

/** Cut at max characters, at a line end when one is near; the caller states the cut. */
function cutText(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const room = Math.max(1, max - 4); // " […]" fits within max
  const lineEnd = text.lastIndexOf("\n", room);
  const at = lineEnd > room * 0.8 ? lineEnd : room;
  return { text: `${text.slice(0, at).trimEnd()} […]`, cut: true };
}

const PASSAGE_FULL = 1_500;
const PASSAGE_WINDOW = 500;

export interface UitspraakTreffer {
  sectie?: string;
  nr?: string;
  ingekort?: boolean;
}

export interface UitspraakTekst {
  /** What the text is: "beslissing", "overwegingen", "volledig", "sectie", "zoekterm". */
  modus: UitspraakOnderdeel | "sectie" | "zoekterm";
  /** The part shown, as the text names it: "5 De beslissing", "nr. 4.3". */
  label?: string;
  /** How the beslissing or overwegingen were found. */
  methode?: string;
  tekst: string;
  /** Length of the whole selected part (or of all hits), before max_chars. */
  tekensOnderdeel: number;
  ingekort: boolean;
  treffers?: UitspraakTreffer[];
  treffersTotaal?: number;
  /** The part asked for is not in the text (or could not be recognised). */
  notFound?: { reason: string; suggestions: string[] };
}

/** The passages of a long hit that hold a word of the zoekterm. */
function passages(lines: string[], words: Array<{ word: string; stem?: string }>): { text: string; cut: boolean } {
  const whole = lines.join("\n");
  if (whole.length <= PASSAGE_FULL) return { text: whole, cut: false };
  const parts: string[] = [];
  for (const line of lines) {
    const folded = foldText(line);
    const hit = words.map((w) => folded.indexOf(w.word) >= 0 ? folded.indexOf(w.word) : w.stem ? folded.indexOf(w.stem) : -1).filter((i) => i >= 0);
    if (!hit.length) continue;
    if (line.length <= PASSAGE_FULL) {
      parts.push(line);
      continue;
    }
    // foldText keeps the length of text without combining marks; close enough to place a window.
    const at = Math.min(...hit);
    const from = Math.max(0, at - PASSAGE_WINDOW);
    const to = Math.min(line.length, at + PASSAGE_WINDOW);
    parts.push(`${from > 0 ? "…" : ""}${line.slice(from, to).trim()}${to < line.length ? "…" : ""}`);
  }
  return { text: parts.join("\n…\n"), cut: true };
}

function searchUitspraak(doc: ParsedUitspraak, ranges: Range[], zoekterm: string, maxChars: number, wholeDocument: boolean): Pick<UitspraakTekst, "tekst" | "treffers" | "treffersTotaal" | "ingekort" | "tekensOnderdeel"> {
  const words = zoektermWords(zoekterm);
  const matches = (text: string) => {
    const folded = foldText(text);
    return words.every((w) => folded.includes(w.word) || (w.stem !== undefined && folded.includes(w.stem)));
  };
  // A unit is a numbered paragraph with the lines that continue it, or a line of its own.
  const units: Array<{ sectie?: string; nr?: string; lines: string[]; notes: string[] }> = [];
  for (const r of ranges) {
    for (let i = r.from; i < r.to; i++) {
      const b = doc.blocks[i];
      const prev = units[units.length - 1];
      const sectie = b.section >= 0 ? sectionLabel(doc.sections[b.section]) : "Kop";
      if (b.kind !== "titel" && b.nr && prev && prev.nr === b.nr && prev.sectie === sectie && i > r.from) {
        prev.lines.push(b.text);
        prev.notes.push(...b.notes);
      } else {
        units.push({ sectie, nr: b.kind === "titel" ? undefined : b.nr, lines: [b.text], notes: [...b.notes] });
      }
    }
  }
  const referenced = new Set(units.flatMap((u) => u.notes));
  for (const f of doc.footnotes) {
    if (wholeDocument || referenced.has(f.label)) units.push({ sectie: `Voetnoot ${f.label}`, lines: [f.text], notes: [] });
  }
  const hits = units.filter((u) => matches(u.lines.join("\n")));
  const shown: UitspraakTreffer[] = [];
  const parts: string[] = [];
  let used = 0;
  let total = 0;
  let cut = false;
  for (const hit of hits) {
    const passage = passages(hit.lines, words);
    const header = `[${[hit.sectie, hit.nr].filter(Boolean).join(" › ")}]`;
    const part = `${header}\n${passage.text}`;
    total += part.length + 2;
    if (shown.length && used + part.length > maxChars) {
      cut = true;
      continue;
    }
    const fitted = cutText(part, maxChars - used);
    parts.push(fitted.text);
    used += fitted.text.length + 2;
    cut ||= fitted.cut;
    shown.push({ sectie: hit.sectie, ...(hit.nr ? { nr: hit.nr } : {}), ...(passage.cut || fitted.cut ? { ingekort: true } : {}) });
  }
  return { tekst: parts.join("\n\n"), treffers: shown, treffersTotaal: hits.length, ingekort: cut || shown.length < hits.length, tekensOnderdeel: total };
}

/**
 * The text a call asks for. A sectie wins over onderdeel; a zoekterm searches
 * within the selected part (in "overzicht": the whole text) and returns the
 * paragraphs holding every word, each with its section and number.
 */
export function selectUitspraakText(
  doc: ParsedUitspraak,
  options: { onderdeel?: UitspraakOnderdeel; sectie?: string; zoekterm?: string; maxChars?: number },
): UitspraakTekst {
  const maxChars = Math.max(1, Math.min(UITSPRAAK_MAX_CHARS, options.maxChars ?? UITSPRAAK_DEFAULT_CHARS));
  const onderdeel = options.onderdeel ?? "overzicht";
  const all: Range = { from: 0, to: doc.blocks.length };
  let part: FoundPart | undefined;
  let modus: UitspraakTekst["modus"] = onderdeel;
  if (options.sectie?.trim()) {
    const found = findSectie(doc, options.sectie);
    if (!("ranges" in found)) {
      return { modus: "sectie", tekst: "", tekensOnderdeel: 0, ingekort: false, notFound: { reason: `Sectie '${options.sectie}' niet gevonden.`, suggestions: found.suggestions } };
    }
    part = found;
    modus = "sectie";
  } else if (onderdeel === "beslissing" || onderdeel === "overwegingen") {
    part = onderdeel === "beslissing" ? findBeslissing(doc) : findOverwegingen(doc);
    if (!part) {
      const reason =
        onderdeel === "beslissing"
          ? "Geen beslissing herkend: geen sectie met role=\"beslissing\", geen sectie of kopregel 'Beslissing'/'Dictum' en geen slotsom."
          : "Geen overwegingen herkend: geen sectie met role=\"overwegingen\" of een titel als 'Beoordeling', en geen secties tussen feiten/procesverloop en beslissing.";
      return { modus: onderdeel, tekst: "", tekensOnderdeel: 0, ingekort: false, notFound: { reason, suggestions: uitspraakInhoudsopgave(doc).slice(0, 20).map((e) => `${e.sectie} ${e.titel}`) } };
    }
  } else if (onderdeel === "volledig") {
    part = { ranges: [all], label: "volledige tekst", methode: "" };
  }

  const words = zoektermWords(options.zoekterm ?? "");
  if (words.length) {
    const ranges = part?.ranges ?? [all];
    const found = searchUitspraak(doc, ranges, options.zoekterm ?? "", maxChars, modus === "overzicht" || modus === "volledig");
    return { modus: "zoekterm", label: part?.label, methode: part?.methode || undefined, ...found };
  }

  if (onderdeel === "overzicht" && !part) {
    // The overzicht shows the beslissing; without one it shows no text (the inhoudsopgave still lists the parts).
    const beslissing = findBeslissing(doc);
    if (!beslissing) return { modus: "overzicht", tekst: "", tekensOnderdeel: 0, ingekort: false };
    const full = renderRange(doc, beslissing.ranges, true);
    const cut = cutText(full, maxChars);
    return { modus: "overzicht", label: beslissing.label, methode: beslissing.methode, tekst: cut.text, tekensOnderdeel: full.length, ingekort: cut.cut };
  }
  const chosen = part as FoundPart;
  const full = renderRange(doc, chosen.ranges, true);
  const cut = cutText(full, maxChars);
  return { modus, label: chosen.label, methode: chosen.methode || undefined, tekst: cut.text, tekensOnderdeel: full.length, ingekort: cut.cut };
}

export class RechtspraakSource {
  constructor(private readonly config: AppConfig) {}

  /**
   * One ruling or conclusie from the open data service, metadata and text in one
   * document (up to ~1 MB for a long conclusie). An ECLI Rechtspraak does not know
   * answers 404: doc is then undefined. A known ECLI without published text comes
   * back with metadata only (doc.soort undefined).
   */
  async getUitspraak(ecli: string): Promise<{ doc?: ParsedUitspraak; endpoint: string; params: Record<string, string> }> {
    const params = { id: ecli };
    try {
      const { data, meta } = await getText(RECHTSPRAAK_CONTENT, {
        query: params,
        timeoutMs: 30_000,
        retries: 1,
        headers: { Accept: "application/xml" },
      });
      return { doc: parseUitspraakXml(data, ecli), endpoint: meta.url, params };
    } catch (error) {
      if (error instanceof SourceRequestError && error.status === 404) {
        return { endpoint: uitspraakDataUrl(ecli), params };
      }
      throw error;
    }
  }

  async searchEcli(args: {
    query: string;
    rows: number;
    sort?: "relevance" | "date_newest" | "ruling_newest";
    date_filter?: "week" | "month" | "year" | "last_year";
  }) {
    // Map structured parameters to API values
    const sortOrder: RechtspraakSortOrder =
      args.sort === "date_newest" ? "PublicatieDatumDesc"
      : args.sort === "ruling_newest" ? "UitspraakDatumDesc"
      : "Relevance";

    const filterMap: Record<string, "BinnenEenWeek" | "BinnenEenMaand" | "DitJaar" | "VorigJaar"> = {
      week: "BinnenEenWeek",
      month: "BinnenEenMaand",
      year: "DitJaar",
      last_year: "VorigJaar",
    };
    const filterIdentifier = args.date_filter ? filterMap[args.date_filter] : undefined;

    const searchTerm = resolveSearchTerm(args.query);

    const payload = {
      StartRow: 0,
      PageSize: Math.min(Math.max(args.rows, 1), 50),
      ShouldReturnHighlights: true,
      ShouldCountFacets: true,
      SortOrder: sortOrder,
      SearchTerms: [{ Term: searchTerm, Field: "AlleVelden" }],
      Contentsoorten: [] as Array<Record<string, unknown>>,
      Rechtsgebieden: [] as Array<Record<string, unknown>>,
      Instanties: [] as Array<Record<string, unknown>>,
      DatumPublicatie: filterIdentifier
        ? [
            {
              NodeType: 4,
              Identifier: filterIdentifier,
              level: 0,
            },
          ]
        : ([] as Array<Record<string, unknown>>),
      DatumUitspraak: [] as Array<Record<string, unknown>>,
      Advanced: {
        PublicatieStatus: "AlleenGepubliceerd",
      },
      CorrelationId: correlationId32(),
      Proceduresoorten: [] as Array<Record<string, unknown>>,
    };

    const referer = `${RECHTSPRAAK_SEARCH_PAGE}?zoekterm=${encodeURIComponent(searchTerm)}&inhoudsindicatie=zt0&sort=${encodeURIComponent(sortOrder)}&publicatiestatus=ps1`;

    const { data, meta } = await postJson<RechtspraakApiResponse>(
      RECHTSPRAAK_SEARCH_API,
      payload,
      {
        timeoutMs: 20_000,
        retries: 2,
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          Referer: referer,
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
          __RequestVerificationToken: "ELEMENT_NOT_FOUND",
        },
      },
    );

    const items = toArray(data.Results)
      .map(mapResult)
      .filter((x) => Boolean(x.ecli))
      .slice(0, args.rows);

    const total =
      typeof data.ResultCount === "number" ? data.ResultCount : items.length;

    const accessNotes: string[] = [];
    if (filterIdentifier) {
      const publicatieCount = facetCount(
        data.FacetCounts,
        "DatumPublicatie",
        filterIdentifier,
      );
      accessNotes.push(
        publicatieCount === undefined
          ? `Filter actief: ${filterIdentifier}.`
          : `Filter actief: ${filterIdentifier} (facetcount=${publicatieCount}).`,
      );
    }
    if (sortOrder !== "Relevance") {
      accessNotes.push(`Sortering: ${sortOrder}.`);
    }

    const monthCount = facetCount(data.FacetCounts, "DatumPublicatie", "BinnenEenMaand");
    const yearCount = facetCount(data.FacetCounts, "DatumPublicatie", "DitJaar");
    if (monthCount !== undefined || yearCount !== undefined) {
      accessNotes.push(
        `Facetcontrole publicatiedatum: BinnenEenMaand=${monthCount ?? "n/a"}, DitJaar=${yearCount ?? "n/a"}.`,
      );
    }

    if (!items.length) {
      // A search that matched nothing returns nothing. This used to answer with
      // a synthesised record titled "Geen passende Rechtspraak-uitspraak
      // gevonden voor '<query>'", which a caller counting records read as one
      // ruling found.
      return {
        items: [],
        total: 0,
        endpoint: meta.url,
        params: {
          term: searchTerm,
          rows: String(args.rows),
          sortOrder,
          ...(filterIdentifier ? { publicatieFilter: filterIdentifier } : {}),
        },
        access_note: [
          accessNotes.join(" ") || "Geen passende ECLI-match gevonden voor deze zoekterm.",
          `Zoek handmatig verder op ${searchPageUrl(searchTerm)}.`,
        ]
          .filter(Boolean)
          .join(" "),
      };
    }

    return {
      items,
      total,
      endpoint: meta.url,
      params: {
        term: searchTerm,
        rows: String(args.rows),
        sortOrder,
        ...(filterIdentifier ? { publicatieFilter: filterIdentifier } : {}),
      },
      ...(accessNotes.length ? { access_note: accessNotes.join(" ") } : {}),
    };
  }

  /**
   * The search service was unreachable.
   *
   * Returns nothing rather than a synthesised "fallback uitspraak" record: an
   * invented ruling is the last thing a legal question should get back, and the
   * note carries a working search link instead.
   */
  fallback(args: { query: string; rows: number }) {
    return {
      items: [] as RechtspraakItem[],
      total: 0,
      endpoint: `${RECHTSPRAAK_SEARCH_API} (niet bereikbaar)`,
      params: {
        term: args.query,
        rows: String(args.rows),
      },
      access_note: `De Rechtspraak-zoekservice was niet bereikbaar, dus er zijn geen uitspraken opgehaald voor '${args.query}'. Probeer het later opnieuw of zoek op ${searchPageUrl(args.query)}.`,
    };
  }
}
