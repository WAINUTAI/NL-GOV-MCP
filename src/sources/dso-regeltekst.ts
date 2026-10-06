/**
 * Plain text from DSO regeltekst: the STOP XML fragments (imop-tekst) that the
 * DSO Presenteren API returns per document component in its documentstructuur
 * (`kop` and `inhoud` of every hoofdstuk, artikel, lid, begrip, divisietekst).
 *
 * A small tokenizer instead of parseXml: fast-xml-parser groups children by
 * element name and so loses the order of mixed content ("in afwijking van het
 * <IntRef>eerste</IntRef> lid"), which a legal text cannot afford. As in
 * parseXml, only the five predefined entities and numeric character references
 * are decoded; a DOCTYPE or any other entity is never expanded.
 *
 * An ontwerp carries renvooi: what it adds and removes. The text here is the
 * regeling as the ontwerp would make it: added text in, deleted text out; the
 * "renvooi" view marks the changes instead ([+added+], [-deleted-]).
 */

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Renvooi view: text this element adds (+) or deletes (-). */
  mark?: "+" | "-";
}

type XmlNode = XmlElement | string;

// Start and end tag at a position. A tag holds no "<" (nor does an XML attribute value): a broken
// tag stops at the next "<" instead of scanning on, so a run of them stays linear.
const START_TAG = /<([A-Za-z_][\w.:-]*)((?:\s+[^\s=/<>]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
const END_TAG = /<\/([A-Za-z_][\w.:-]*)\s*>/y;
const XML_ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const XML_REFERENCE = /&(?:(amp|lt|gt|quot|apos)|#([0-9]+)|#x([0-9a-fA-F]+));/g;
const PREDEFINED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeReferences(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(XML_REFERENCE, (match, name?: string, dec?: string, hex?: string) => {
    if (name) return PREDEFINED_ENTITIES[name];
    const codePoint = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
    const valid = codePoint >= 1 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
    return valid ? String.fromCodePoint(codePoint) : match;
  });
}

/** "imop:Al" and "Al" are the same element here. */
function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * How an ontwerp's renvooi is read: "nieuw" is the regeling as the ontwerp would
 * make it, "oud" the regeling before it, "renvooi" both, with the changes marked.
 * A regeling has no renvooi and reads the same in every view.
 */
export type RenvooiView = "nieuw" | "oud" | "renvooi";

/**
 * What renvooi does to an element in a view. Nieuw: deleted text (<VerwijderdeTekst>,
 * an element with wijzigactie "verwijder") is left out; added text (<NieuweTekst>)
 * and the content of a removed container (wijzigactie "verwijderContainer") stay, in
 * the place of the element. Oud: the other way round. Renvooi: everything stays,
 * added and deleted text marked.
 */
function renvooi(name: string, attrs: Record<string, string>, view: RenvooiView): "drop" | "unwrap" | "+" | "-" | undefined {
  const added = name === "NieuweTekst" || attrs.wijzigactie === "voegtoe";
  const deleted = name === "VerwijderdeTekst" || attrs.wijzigactie === "verwijder";
  if (view === "renvooi") return added ? "+" : deleted ? "-" : undefined;
  if (view === "nieuw" ? deleted : added) return "drop";
  if (name === (view === "nieuw" ? "NieuweTekst" : "VerwijderdeTekst")) return "unwrap";
  return attrs.wijzigactie === (view === "nieuw" ? "verwijderContainer" : "nieuweContainer") ? "unwrap" : undefined;
}

/**
 * Where `needle` next starts at or after `from`. The last answer is kept per needle:
 * thousands of unterminated "<!--" ask for the same "-->" and must not each scan to the end.
 */
function finder(xml: string): (needle: string, from: number) => number {
  const last = new Map<string, { from: number; at: number }>();
  return (needle, from) => {
    const prev = last.get(needle);
    if (prev && prev.from <= from && (prev.at < 0 || from <= prev.at)) return prev.at;
    const at = xml.indexOf(needle, from);
    last.set(needle, { from, at });
    return at;
  };
}

/**
 * Parse a fragment, one token at a time: a declaration, comment, CDATA section or
 * DOCTYPE (with any internal subset) is skipped (CDATA kept as text), an end tag
 * closes, a start tag opens, text is text, and a "<" that starts none of these is
 * text too. Every scan is bounded by its terminator or the next "<", and a
 * terminator that is not there is not searched for twice: linear on any input.
 */
function parseFragment(xml: string, view: RenvooiView = "nieuw"): XmlElement {
  const root: XmlElement = { name: "#root", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const find = finder(xml);
  // The end of a DOCTYPE once past an internal subset: "<!DOCTYPE[" repeated reaches the same "]".
  const afterSubset = new Map<number, number>();
  const doctypeEnd = (from: number): number => {
    const passed: number[] = [];
    let end = -1;
    for (let i = from; i < xml.length; ) {
      const known = afterSubset.get(i);
      if (known !== undefined) {
        end = known;
        break;
      }
      const c = xml[i];
      if (c === ">") {
        end = i + 1;
        break;
      }
      if (c === "<") break;
      if (c !== "[") {
        i++;
        continue;
      }
      const close = find("]", i + 1);
      if (close < 0) break;
      i = close + 1;
      passed.push(i);
    }
    for (const i of passed) afterSubset.set(i, end);
    return end;
  };
  let pos = 0;
  while (pos < xml.length) {
    const top = stack[stack.length - 1];
    const lt = xml.indexOf("<", pos);
    if (lt !== pos) {
      const end = lt < 0 ? xml.length : lt;
      top.children.push(decodeReferences(xml.slice(pos, end)));
      pos = end;
      continue;
    }
    let end = -1;
    if (xml.startsWith("<?", pos)) {
      const close = find("?>", pos + 2);
      if (close >= 0) end = close + 2;
    } else if (xml.startsWith("<!--", pos)) {
      const close = find("-->", pos + 4);
      if (close >= 0) end = close + 3;
    } else if (xml.startsWith("<![CDATA[", pos)) {
      const close = find("]]>", pos + 9);
      if (close >= 0) {
        top.children.push(xml.slice(pos + 9, close));
        end = close + 3;
      }
    } else if (xml.startsWith("<!DOCTYPE", pos)) {
      end = doctypeEnd(pos + 9);
    } else if (xml[pos + 1] === "/") {
      END_TAG.lastIndex = pos;
      const m = END_TAG.exec(xml);
      if (m) {
        // Close the nearest open element of that name; a stray end tag is ignored.
        const name = localName(m[1]);
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i].name === name) {
            stack.length = i;
            break;
          }
        }
        end = END_TAG.lastIndex;
      }
    } else {
      START_TAG.lastIndex = pos;
      const m = START_TAG.exec(xml);
      if (m) {
        const attrs: Record<string, string> = {};
        for (const a of m[2].matchAll(XML_ATTRIBUTE)) attrs[localName(a[1])] = decodeReferences(a[2] ?? a[3] ?? "");
        const name = localName(m[1]);
        const action = renvooi(name, attrs, view);
        // Dropped: parsed into a detached element. Unwrapped: its children go straight to the parent.
        const element: XmlElement = { name, attrs, children: action === "unwrap" ? top.children : [] };
        // Marked once: text inside an added element is not marked again.
        if ((action === "+" || action === "-") && !stack.some((e) => e.mark === action)) element.mark = action;
        if (action !== "drop" && action !== "unwrap") top.children.push(element);
        if (!m[3]) stack.push(element);
        end = START_TAG.lastIndex;
      }
    }
    if (end < 0) {
      top.children.push("<");
      pos++;
    } else {
      pos = end;
    }
  }
  return root;
}

/** Text-level elements: their text runs on in the sentence around them. Renvooi's only stay in the renvooi view. */
const INLINE = new Set([
  "IntRef", "IntIoRef", "ExtRef", "ExtIoRef", "NootRef", "Nadruk", "Contact", "Abbr",
  "strong", "b", "i", "u", "sup", "sub", "em", "span", "a", "InlineTekstAfbeelding",
  "NieuweTekst", "VerwijderdeTekst",
]);

/** Text an element adds or deletes, marked: "[+speelvoorzieningen;+]", "[-21.29-]". */
function markText(text: string, mark: "+" | "-" | undefined): string {
  return mark && text.trim() ? `[${mark}${text}${mark}]` : text;
}

/** Lines of a block element that adds or deletes it whole, marked from its first character to its last. */
function markLines(lines: string[], mark: "+" | "-" | undefined): string[] {
  if (!mark || !lines.length) return lines;
  const out = [...lines];
  const first = out[0];
  const indent = first.length - first.trimStart().length;
  out[0] = `${first.slice(0, indent)}[${mark}${first.slice(indent)}`;
  out[out.length - 1] += `${mark}]`;
  return out;
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Link text that says nothing without its target ("vindt u hier"): the URL is added. */
const POINTER_LINK_TEXT = /^(?:hier|klik hier|link|deze link|via deze link|website|deze website|deze pagina)?$/i;

/**
 * All text of an element. Only a <br/> breaks the line: a newline in the XML
 * source is whitespace like any other (pretty-printed fragments have them
 * inside an <IntRef>).
 */
function inlineText(node: XmlNode): string {
  if (typeof node === "string") return node.replace(/\s+/g, " ");
  if (node.name === "br") return "\n";
  return markText(inlineContent(node), node.mark);
}

/** The text of an element without its own renvooi mark (a block's mark spans its lines). */
function inlineContent(node: XmlElement): string {
  const text = node.children.map(inlineText).join("");
  if (node.name === "ExtRef" && /^https?:\/\//i.test(node.attrs.ref ?? "") && POINTER_LINK_TEXT.test(squash(text))) {
    return squash(text) ? `${text} (${node.attrs.ref})` : node.attrs.ref;
  }
  return text;
}

function childElements(node: XmlElement, name: string): XmlElement[] {
  return node.children.filter((c): c is XmlElement => typeof c !== "string" && c.name === name);
}

function firstChild(node: XmlElement, name: string): XmlElement | undefined {
  return childElements(node, name)[0];
}

/** Lines of a paragraph, split where it has a <br/>. */
function paragraphLines(text: string, indent: string): string[] {
  return text.split("\n").map(squash).filter(Boolean).map((line) => indent + line);
}

/** The first line of `lines` prefixed with a list number or term, the rest as they are. */
function prefixFirst(prefix: string, lines: string[], indent: string): string[] {
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
    if (typeof node === "string") {
      run += inlineText(node);
    } else if (node.name === "br" || INLINE.has(node.name)) {
      run += inlineText(node);
    } else {
      flush();
      lines.push(...markLines(renderBlock(node, indent), node.mark));
    }
  }
  flush();
  return lines;
}

/** Columns a table can have; a colnum beyond it is ignored rather than allocated. */
const MAX_TABLE_COLUMNS = 500;

/**
 * The cells of each row of a tgroup, every cell in its own column: a cell that
 * spans columns (namest/nameend) or rows (morerows) leaves empty cells where it
 * spans, so the values after it stay under their header. Empty cells at the end
 * of a row are left off.
 */
function tableRows(group: XmlElement): string[][] {
  const columns = new Map<string, number>();
  childElements(group, "colspec").forEach((spec, i) => {
    const num = Number(spec.attrs.colnum);
    const index = Number.isInteger(num) && num >= 1 ? num - 1 : i;
    if (spec.attrs.colname && index < MAX_TABLE_COLUMNS) columns.set(spec.attrs.colname, index);
  });
  const rows: XmlElement[] = [];
  const collectRows = (el: XmlElement) => {
    for (const c of el.children) {
      if (typeof c === "string") continue;
      if (c.name === "row") rows.push(c);
      else if (c.name !== "title" && c.name !== "colspec") collectRows(c);
    }
  };
  collectRows(group);
  // Per column: rows still taken by a morerows cell above.
  let covered: number[] = [];
  return rows.map((row) => {
    const cells: string[] = [];
    const next = covered.map((n) => Math.max(0, n - 1));
    let col = 0;
    for (const entry of childElements(row, "entry")) {
      while ((covered[col] ?? 0) > 0) col++;
      // At namest or colname; without either (or with an unknown name), the next free column.
      const start = columns.get(entry.attrs.namest ?? "") ?? columns.get(entry.attrs.colname ?? "") ?? col;
      const end = Math.max(start, columns.get(entry.attrs.nameend ?? "") ?? start);
      if (start >= MAX_TABLE_COLUMNS) break;
      cells[start] = squash(renderBlocks(entry.children, "").join(" "));
      for (let c = start + 1; c <= end; c++) cells[c] = "";
      const more = Number(entry.attrs.morerows);
      if (more > 0) for (let c = start; c <= end; c++) next[c] = Math.max(next[c] ?? 0, more);
      col = end + 1;
    }
    covered = next;
    const filled = Array.from(cells, (c) => c ?? "");
    while (filled.length && !filled[filled.length - 1]) filled.pop();
    return filled;
  });
}

function renderBlock(node: XmlElement, indent: string): string[] {
  switch (node.name) {
    case "Al":
      return paragraphLines(inlineContent(node), indent);
    case "Lijst": {
      const lines: string[] = [];
      for (const child of node.children) {
        if (typeof child === "string") {
          lines.push(...paragraphLines(inlineText(child), indent));
        } else if (child.name === "Li") {
          // "a.", "1°", or a dash for an unnumbered (ongemarkeerd) list.
          const nummer = squash(inlineText(firstChild(child, "LiNummer") ?? "")) || "-";
          const content = renderBlocks(child.children.filter((c) => typeof c === "string" || c.name !== "LiNummer"), `${indent}   `);
          lines.push(...markLines(prefixFirst(nummer, content, indent), child.mark));
        } else {
          lines.push(...markLines(renderBlock(child, indent), child.mark));
        }
      }
      return lines;
    }
    case "Begrip": {
      // "Term: definitie", the way a begrippenlijst reads.
      const term = squash(inlineText(firstChild(node, "Term") ?? ""));
      const definitie = firstChild(node, "Definitie");
      const lines = definitie ? renderBlocks(definitie.children, `${indent}   `) : [];
      const rest = node.children.filter((c) => typeof c !== "string" && c.name !== "Term" && c.name !== "Definitie");
      return [...(term ? prefixFirst(`${term}:`, lines, indent) : lines), ...renderBlocks(rest, indent)];
    }
    case "table": {
      // A table as one line per row, cells separated by " | ".
      const lines: string[] = [];
      const title = squash(inlineText(firstChild(node, "title") ?? ""));
      if (title) lines.push(indent + title);
      const groups: XmlElement[] = [];
      const findGroups = (el: XmlElement) => {
        for (const c of el.children) if (typeof c !== "string" && c.name !== "row") (c.name === "tgroup" ? groups.push(c) : findGroups(c));
      };
      findGroups(node);
      for (const group of groups.length ? groups : [node]) {
        for (const cells of tableRows(group)) if (cells.some(Boolean)) lines.push(indent + cells.join(" | "));
      }
      return lines;
    }
    case "Figuur": {
      const titel = squash(inlineText(firstChild(node, "Titel") ?? ""));
      const bijschrift = squash(inlineText(firstChild(node, "Bijschrift") ?? ""));
      return [`${indent}[Figuur${titel ? `: ${titel}` : ""}${bijschrift ? ` — ${bijschrift}` : ""}]`];
    }
    default:
      return renderBlocks(node.children, indent);
  }
}

/** Readable plain text of a STOP `inhoud` fragment: paragraphs, numbered lists, begrippen, tables. */
export function stopXmlToText(xml: string | undefined, view: RenvooiView = "nieuw"): string {
  if (!xml) return "";
  return renderBlocks(parseFragment(xml, view).children, "").join("\n");
}

export interface StopKop {
  label: string;
  nummer: string;
  opschrift: string;
  /** "Artikel 2.3 Begrippen", or only the parts the kop has. */
  text: string;
}

/** The parts of a STOP `kop` fragment (<Kop><Label/><Nummer/><Opschrift/></Kop>). */
export function stopKop(xml: string | undefined, view: RenvooiView = "nieuw"): StopKop {
  const root = xml ? parseFragment(xml, view) : undefined;
  const kop = root ? (firstChild(root, "Kop") ?? root) : undefined;
  // In the renvooi view a deleted and an added Opschrift both stay; an old and a new Nummer
  // pretty-printed on lines of their own read as one: "[-24-][+23+]".
  const part = (name: string) => (kop ? squash(childElements(kop, name).map(inlineText).join(" ")).replace(/-\] \[\+/g, "-][+") : "");
  const label = part("Label");
  const nummer = part("Nummer");
  const opschrift = part("Opschrift");
  return { label, nummer, opschrift, text: [label, nummer, opschrift].filter(Boolean).join(" ") };
}

/* ------------------------------------------------------------------ */
/*  Document structure                                                 */
/* ------------------------------------------------------------------ */

/**
 * One component of GET …/documentstructuur, as the DSO returns it. An ontwerp
 * (…/ontwerpregelingen/{technischId}/documentstructuur) nests its components
 * as ontwerpDocumentComponenten, marks what it changes with wijzigactie, and
 * gives gereserveerd/vervallen as an XML string ("<gereserveerd/>").
 */
export interface DsoDocumentComponent {
  identificatie?: string;
  expressie?: string;
  type?: string;
  volgordeNummer?: number;
  kop?: string;
  inhoud?: string;
  gereserveerd?: boolean | string;
  vervallen?: boolean | string;
  /** Ontwerp: voegtoe, verwijder, nieuweContainer or verwijderContainer. */
  wijzigactie?: string;
  bevatRenvooi?: boolean;
  conditieArtikel?: { kop?: string; inhoud?: string };
  _embedded?: { documentComponenten?: DsoDocumentComponent[]; ontwerpDocumentComponenten?: DsoDocumentComponent[] };
}

/** The components of a documentstructuur (or of one component), regeling or ontwerp. */
function documentComponents(embedded: DsoDocumentComponent["_embedded"]): DsoDocumentComponent[] {
  return embedded?.documentComponenten ?? embedded?.ontwerpDocumentComponenten ?? [];
}

/** gereserveerd/vervallen: true, or an ontwerp's "<vervallen/>", but not one the ontwerp removes. */
function flagSet(value: boolean | string | undefined): boolean {
  if (typeof value !== "string") return Boolean(value);
  return value.trim() !== "" && value.trim() !== "false" && !/wijzigactie\s*=\s*["']verwijder["']/.test(value);
}

export interface DsoSection {
  index: number;
  /** Work id (identificatie), stable across versions. */
  wId: string;
  /** Expression id (expressie), e.g. "chp_4__subchp_4.1__art_4.1". */
  eId: string;
  type: string;
  parent: number;
  /** Index after the last descendant: the subtree is sections[index, end). */
  end: number;
  /** "Artikel 2.3": Label and Nummer of the kop, "" when it has neither. */
  label: string;
  heading: string;
  body: string;
  status?: "gereserveerd" | "vervallen";
  /** Its text is already in the parent's inhoud (a Begrip of a Begrippenlijst). */
  contained: boolean;
}

export interface DsoDocument {
  sections: DsoSection[];
  /** Characters of the whole document as text. */
  totalChars: number;
  /** An ontwerp that adds or removes text: rendered as it would read after the change. */
  renvooi?: boolean;
  /** Such an ontwerp's changes, in document order (see collectChanges). */
  wijzigingen?: DsoChange[];
}

/** What an ontwerp does to a part: adds it, removes it, changes its text, or only renumbers it. */
export type DsoChangeKind = "nieuw" | "vervalt" | "gewijzigd" | "vernummerd";

export interface DsoChange {
  kind: DsoChangeKind;
  eId: string;
  wId: string;
  type: string;
  /** Heading as the ontwerp would make it (as it was, for a part it removes), or "Begrip: …". */
  title: string;
  /** Headings of the parts it sits in, outermost first, joined with " > ". */
  pad: string;
  /** The change: [+added+] and [-deleted-] text; [nieuw] or [vervalt] before a whole part; […] for unchanged text left out. */
  tekst: string;
  toelichting?: boolean;
}

/**
 * Flatten the component tree into sections in document order. A component's
 * inhoud can hold its children's text as well: an artikel's Begrippenlijst also
 * comes as one BEGRIP component per term. Those children are marked `contained`,
 * so the text is not rendered twice but a single begrip can still be found.
 *
 * In an ontwerp, a component it deletes (wijzigactie "verwijder") is left out
 * with everything under it; of a removed container ("verwijderContainer") only
 * the kop goes, its content and children stay.
 */
export function buildDsoDocument(components: DsoDocumentComponent[]): DsoDocument {
  const sections: DsoSection[] = [];
  let renvooi = false;
  const kept = (list: DsoDocumentComponent[]) => {
    const out = list.filter((c) => c.wijzigactie !== "verwijder");
    if (out.length < list.length) renvooi = true;
    return out.sort((a, b) => (a.volgordeNummer ?? 0) - (b.volgordeNummer ?? 0));
  };
  const visit = (component: DsoDocumentComponent, parent: number, contained: boolean) => {
    if (component.wijzigactie || component.bevatRenvooi) renvooi = true;
    const kop = stopKop(component.wijzigactie === "verwijderContainer" ? undefined : component.kop);
    const index = sections.length;
    const section: DsoSection = {
      index,
      wId: component.identificatie ?? "",
      eId: component.expressie ?? "",
      type: component.type ?? "",
      parent,
      end: index + 1,
      label: [kop.label, kop.nummer.replace(/\.$/, "")].filter(Boolean).join(" "),
      heading: kop.text,
      body: stopXmlToText(component.inhoud),
      status: flagSet(component.vervallen) ? "vervallen" : flagSet(component.gereserveerd) ? "gereserveerd" : undefined,
      contained,
    };
    sections.push(section);
    if (component.conditieArtikel?.inhoud || component.conditieArtikel?.kop) {
      // The "voorrangsregel" of voorbeschermingsregels, delivered on the lichaam.
      const conditie = stopKop(component.conditieArtikel.kop);
      sections.push({
        index: sections.length,
        wId: `${section.wId}#conditieArtikel`,
        eId: `${section.eId}#conditieArtikel`,
        type: "CONDITIEARTIKEL",
        parent: index,
        end: sections.length + 1,
        label: "",
        heading: conditie.text || "Conditieartikel",
        body: stopXmlToText(component.conditieArtikel.inhoud),
        contained: false,
      });
    }
    for (const child of kept(documentComponents(component._embedded))) {
      const inParent = Boolean(component.inhoud && child.identificatie && component.inhoud.includes(`"${child.identificatie}"`));
      visit(child, index, inParent);
    }
    section.end = sections.length;
  };
  for (const component of kept([...components])) visit(component, -1, false);
  const doc: DsoDocument = { sections, totalChars: 0, ...(renvooi ? { renvooi, wijzigingen: collectChanges(components) } : {}) };
  doc.totalChars = renderSections(doc, 0, sections.length).length;
  return doc;
}

/** Section types that open a new block of text, with a blank line before them. */
const LEAF_TYPES = new Set(["LID", "BEGRIP"]);

/** Lines of a section; `marker` ("[gereserveerd]") follows the heading. */
function sectionLines(section: Pick<DsoSection, "type" | "heading" | "body">, marker = ""): string[] {
  const body = section.body ? section.body.split("\n") : [];
  if (section.type === "LID") {
    // "1. tekst van het lid" on one line, as a printed article reads.
    const lines = section.heading ? prefixFirst(section.heading, body, "") : body;
    return marker ? [...lines, marker] : lines;
  }
  const heading = [section.heading, marker].filter(Boolean).join(" ");
  return heading ? [heading, ...body] : body;
}

/**
 * Text of sections[from, to). A section whose text is in its parent's inhoud is
 * skipped, unless it is the first one asked for (a single begrip).
 */
export function renderSections(doc: DsoDocument, from: number, to: number): string {
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    const section = doc.sections[i];
    if (section.contained && i !== from) continue;
    const lines = sectionLines(section, section.status ? `[${section.status}]` : "");
    if (!lines.length) continue;
    if (out.length && !LEAF_TYPES.has(section.type)) out.push("");
    out.push(...lines);
  }
  return out.join("\n");
}

/** Headings of a section's ancestors, outermost first. */
export function sectionPath(doc: DsoDocument, section: DsoSection): string[] {
  const path: string[] = [];
  for (let p = section.parent; p >= 0; p = doc.sections[p].parent) {
    const heading = doc.sections[p].heading;
    if (heading) path.unshift(heading);
  }
  return path;
}

/* ------------------------------------------------------------------ */
/*  Renvooi: what an ontwerp changes                                   */
/* ------------------------------------------------------------------ */

type WholeChange = "nieuw" | "vervalt";

const WHOLE_MARKER: Record<WholeChange, string> = { nieuw: "[nieuw]", vervalt: "[vervalt]" };

/** Renvooi markup in a kop, inhoud or gereserveerd/vervallen string. */
const RENVOOI_MARKUP = /NieuweTekst|VerwijderdeTekst|wijzigactie/;

function wholeChange(component: DsoDocumentComponent): WholeChange | undefined {
  return component.wijzigactie === "voegtoe" ? "nieuw" : component.wijzigactie === "verwijder" ? "vervalt" : undefined;
}

function byVolgorde(list: DsoDocumentComponent[]): DsoDocumentComponent[] {
  return [...list].sort((a, b) => (a.volgordeNummer ?? 0) - (b.volgordeNummer ?? 0));
}

/** Whether the component's own kop, inhoud or status carries renvooi (not its children's). */
function ownRenvooi(component: DsoDocumentComponent): boolean {
  const { wijzigactie, bevatRenvooi, kop, inhoud, gereserveerd, vervallen } = component;
  return Boolean(wijzigactie || bevatRenvooi) || [kop, inhoud, gereserveerd, vervallen].some((v) => typeof v === "string" && RENVOOI_MARKUP.test(v));
}

/** "[gereserveerd]" as a view reads it; in the renvooi view "[+vervallen+]" when the ontwerp sets it, "[-…-]" when it lifts it. */
function statusMarker(component: DsoDocumentComponent, view: RenvooiView): string {
  const markers: string[] = [];
  for (const name of ["vervallen", "gereserveerd"] as const) {
    const value = component[name];
    if (!value || (typeof value === "string" && /^\s*(?:false)?\s*$/.test(value))) continue;
    const action = typeof value === "string" ? /wijzigactie\s*=\s*["'](\w+)["']/.exec(value)?.[1] : undefined;
    if (action === "verwijder" ? view === "nieuw" : action === "voegtoe" && view === "oud") continue;
    markers.push(view === "renvooi" && (action === "verwijder" || action === "voegtoe") ? `[${action === "voegtoe" ? "+" : "-"}${name}${action === "voegtoe" ? "+" : "-"}]` : `[${name}]`);
  }
  return markers.join(" ");
}

/** The kop as a view reads it; a removed container has none after the change, a new one none before. */
function viewKop(component: DsoDocumentComponent, view: RenvooiView): StopKop {
  const gone = (view === "nieuw" && component.wijzigactie === "verwijderContainer") || (view === "oud" && component.wijzigactie === "nieuweContainer");
  return stopKop(gone ? undefined : component.kop, view);
}

function componentLines(component: DsoDocumentComponent, view: RenvooiView): string[] {
  const section = { type: component.type ?? "", heading: viewKop(component, view).text, body: stopXmlToText(component.inhoud, view) };
  return sectionLines(section, statusMarker(component, view));
}

/** Whether a component's text or kop changes, or only its number. */
function textChange(component: DsoDocumentComponent): "gewijzigd" | "vernummerd" | undefined {
  if (!ownRenvooi(component)) return undefined;
  if (component.wijzigactie === "verwijderContainer" || component.wijzigactie === "nieuweContainer") return "gewijzigd";
  const before = viewKop(component, "oud");
  const after = viewKop(component, "nieuw");
  const changed =
    before.label !== after.label ||
    before.opschrift !== after.opschrift ||
    statusMarker(component, "oud") !== statusMarker(component, "nieuw") ||
    stopXmlToText(component.inhoud, "oud") !== stopXmlToText(component.inhoud, "nieuw");
  return changed ? "gewijzigd" : before.nummer !== after.nummer ? "vernummerd" : undefined;
}

/** A long changed text: only the changed lines, with what introduces them. */
const CHANGE_FOCUS_CHARS = 800;

function changedLines(lines: string[]): string[] {
  if (lines.join("\n").length <= CHANGE_FOCUS_CHARS) return lines;
  return focusLines(lines, (line) => /\[[+-]/.test(line));
}

/** The title of a part: its heading, "Begrip: term", or a lid named after its artikel; a toelichting says so. */
function titleFor(type: string, heading: string, body: string, toelichting: boolean, artikel?: string): string {
  const begripTerm = type === "BEGRIP" ? body.split(":")[0] : "";
  // A lid is called after its article: "Artikel 4.1 lid 2", not "2.".
  const lidTitle = type === "LID" && artikel !== undefined ? `${artikel} lid ${heading.replace(/\.$/, "")}` : "";
  const title = lidTitle || heading || (begripTerm ? `Begrip: ${begripTerm}` : type.toLowerCase());
  if (!toelichting || /toelichting/i.test(title)) return title;
  return /^(?:artikel|hoofdstuk|afdeling|paragraaf|§|bijlage)\b/i.test(title) ? `Toelichting bij ${title}` : `Toelichting: ${title}`;
}

/**
 * What an ontwerp changes, read from the renvooi in its documentstructuur, per
 * unit (an artikel with its leden, a begrip, a divisietekst) in document order:
 *  - nieuw / vervalt: a part it adds or removes whole (wijzigactie voegtoe /
 *    verwijder on the component or one above it), as it would read or as it read;
 *  - gewijzigd: its heading and the parts whose text changes, with [+added+] and
 *    [-deleted-] text, [nieuw]/[vervalt] before a lid it adds or removes, a
 *    renumbered lid as "(alleen vernummerd)" and […] where unchanged text is left out;
 *  - vernummerd: only a number changes ("Artikel [-21.32-][+21.34+] …"), the text not.
 * A hoofdstuk or afdeling appears only for a change to its own heading.
 */
function collectChanges(components: DsoDocumentComponent[]): DsoChange[] {
  const changes: DsoChange[] = [];
  const holds = (component: DsoDocumentComponent, child: DsoDocumentComponent) =>
    Boolean(component.inhoud && child.identificatie && component.inhoud.includes(`"${child.identificatie}"`));

  const unitChange = (unit: DsoDocumentComponent, inherited: WholeChange | undefined, pad: string, toelichting: boolean): DsoChange | undefined => {
    // The unit and its parts (leden, …) in order: what the ontwerp does to each, and whether the one above has the same.
    const parts: Array<{ component: DsoDocumentComponent; whole?: WholeChange; repeat: boolean; contained: boolean }> = [];
    const gather = (component: DsoDocumentComponent, above: WholeChange | undefined, contained: boolean) => {
      const whole = wholeChange(component) ?? above;
      parts.push({ component, whole, repeat: whole !== undefined && whole === above, contained });
      for (const child of byVolgorde(documentComponents(component._embedded))) gather(child, whole, holds(component, child));
    };
    gather(unit, inherited, false);
    const whole = parts[0].whole;
    const view: RenvooiView = whole === "vervalt" ? "oud" : "nieuw";
    const kop = viewKop(unit, view);
    const change = (kind: DsoChangeKind, lines: string[]): DsoChange => ({
      kind,
      eId: unit.expressie ?? "",
      wId: unit.identificatie ?? "",
      type: unit.type ?? "",
      title: titleFor(unit.type ?? "", kop.text, stopXmlToText(unit.inhoud, view), toelichting),
      pad,
      tekst: lines.join("\n"),
      ...(toelichting ? { toelichting: true } : {}),
    });
    if (whole) {
      const lines = parts.filter((p) => !p.contained).flatMap((p) => componentLines(p.component, view));
      if (lines.length) lines[0] = `${WHOLE_MARKER[whole]} ${lines[0]}`;
      return change(whole, lines);
    }

    const states = parts.map((p) => (p.contained ? undefined : (p.whole ?? textChange(p.component))));
    if (!states.some(Boolean)) return undefined;
    const heading = [stopKop(unit.kop, "renvooi").text, statusMarker(unit, "renvooi")].filter(Boolean).join(" ");
    if (states.every((s) => !s || s === "vernummerd")) {
      const leden = parts.slice(1).filter((_, i) => states[i + 1]).map((p) => stopKop(p.component.kop, "renvooi").text.replace(/\.$/, ""));
      return change("vernummerd", [`${heading}${leden.length ? ` (${leden.length === 1 ? "lid" : "leden"} ${leden.join(", ")})` : ""}`]);
    }
    const lines: string[] = [];
    const gap = () => {
      if (lines[lines.length - 1] !== "[…]") lines.push("[…]");
    };
    parts.forEach((p, i) => {
      const state = states[i];
      if (p.contained) return;
      if (i === 0) {
        if (state === "gewijzigd") {
          lines.push(...changedLines(componentLines(unit, "renvooi")));
        } else {
          if (heading) lines.push(heading);
          if (unit.inhoud) gap();
        }
      } else if (!state) {
        gap();
      } else if (state === "vernummerd") {
        lines.push(`${stopKop(p.component.kop, "renvooi").text} (alleen vernummerd)`);
      } else if (state === "gewijzigd") {
        lines.push(...changedLines(componentLines(p.component, "renvooi")));
      } else {
        const own = componentLines(p.component, state === "vervalt" ? "oud" : "nieuw");
        if (own.length && !p.repeat) own[0] = `${WHOLE_MARKER[state]} ${own[0]}`;
        lines.push(...own);
      }
    });
    return change("gewijzigd", lines);
  };

  const walk = (list: DsoDocumentComponent[], path: string[], inherited: WholeChange | undefined, toelichting: boolean) => {
    for (const component of byVolgorde(list)) {
      const children = documentComponents(component._embedded);
      const inToelichting = toelichting || TOELICHTING_TYPES.has(component.type ?? "");
      const holdsChildren = children.some((child) => holds(component, child));
      const pad = path.join(" > ");
      // A unit as textUnits reads it; one whose begrippen are its children is read per begrip.
      if (!holdsChildren && (UNIT_TYPES.has(component.type ?? "") || (!children.length && component.inhoud))) {
        const change = unitChange(component, inherited, pad, inToelichting);
        if (change) changes.push(change);
        continue;
      }
      const own = wholeChange(component);
      const whole = own ?? inherited;
      const kop = viewKop(component, whole === "vervalt" ? "oud" : "nieuw");
      if (own) {
        // A hoofdstuk or afdeling added or removed: its heading here, its artikelen each on their own.
        const line = [`${WHOLE_MARKER[own]} ${kop.text || component.type?.toLowerCase()}`, statusMarker(component, own === "vervalt" ? "oud" : "nieuw")].filter(Boolean).join(" ");
        changes.push({ kind: own, eId: component.expressie ?? "", wId: component.identificatie ?? "", type: component.type ?? "", title: titleFor(component.type ?? "", kop.text, "", inToelichting), pad, tekst: line, ...(inToelichting ? { toelichting: true } : {}) });
      } else if (!whole) {
        const state = textChange({ ...component, inhoud: undefined });
        if (state) {
          const line = [stopKop(component.kop, "renvooi").text, statusMarker(component, "renvooi")].filter(Boolean).join(" ");
          changes.push({ kind: state, eId: component.expressie ?? "", wId: component.identificatie ?? "", type: component.type ?? "", title: titleFor(component.type ?? "", kop.text, "", inToelichting), pad, tekst: line, ...(inToelichting ? { toelichting: true } : {}) });
        }
      }
      walk(children, kop.text ? [...path, kop.text] : path, whole, inToelichting);
    }
  };
  walk(components, [], undefined, false);
  return changes;
}

/* ------------------------------------------------------------------ */
/*  Selecting text: zoekterm, onderdeel, table of contents             */
/* ------------------------------------------------------------------ */

/**
 * Lowercase without diacritics: "Geïntegreerd" and "geintegreerd" match. Soft
 * hyphens and zero-width characters go too ("omgevings\u00ADvergunning" is one word).
 */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "").toLowerCase();
}

/**
 * The stem a plural also matches by: "dakkapellen" → "dakkapel", "bouwwerken" →
 * "bouwwerk", "windturbines" → "windturbine". Only for a word of 7 letters or
 * more ending in -en or -s, with a doubled final consonant undoubled, and only
 * when 5 letters or more remain: "huis", "geen" or "plannen" are never cut down
 * to a fragment that matches unrelated words. A plural that changes its vowel
 * ("zonnepanelen", "bomen") has no stem here.
 */
function pluralStem(word: string): string | undefined {
  if (word.length < 7 || !/^\p{L}+$/u.test(word)) return undefined;
  let stem = word.endsWith("en") ? word.slice(0, -2) : word.endsWith("s") ? word.slice(0, -1) : undefined;
  if (!stem) return undefined;
  if (/([b-df-hj-np-tv-z])\1$/.test(stem)) stem = stem.slice(0, -1);
  return stem.length >= 5 ? stem : undefined;
}

/** The words of a zoekterm, folded, each with the stem it also matches by; "foto's" is "foto". */
export function zoektermWords(zoekterm: string): Array<{ word: string; stem?: string }> {
  return foldText(zoekterm)
    .replace(/['’]s(?=$|[^\p{L}\p{N}])/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => ({ word, stem: pluralStem(word) }));
}

const TOELICHTING_TYPES = new Set(["TOELICHTING", "ALGEMENE_TOELICHTING", "ARTIKELGEWIJZE_TOELICHTING"]);

/** The section is (in) the toelichting: explanation of the regels, not a regel itself. Bijlagen are binding. */
function inToelichting(doc: DsoDocument, section: DsoSection): boolean {
  for (let s: DsoSection | undefined = section; s; s = s.parent >= 0 ? doc.sections[s.parent] : undefined) {
    if (TOELICHTING_TYPES.has(s.type)) return true;
  }
  return false;
}

/** Section types searched as one unit: an artikel with its leden, a divisietekst, a begrip. */
const UNIT_TYPES = new Set(["ARTIKEL", "DIVISIETEKST", "BEGRIP", "CONDITIEARTIKEL"]);

/**
 * The units a zoekterm is matched against, in document order. An artikel or
 * divisietekst that holds a begrippenlijst is split into its begrippen, so a
 * search for "dakkapel" returns that one definition, not three hundred.
 */
export function textUnits(doc: DsoDocument): Array<{ from: number; to: number }> {
  const units: Array<{ from: number; to: number }> = [];
  const visit = (i: number) => {
    const section = doc.sections[i];
    const leaf = section.end === i + 1;
    if (UNIT_TYPES.has(section.type) || (leaf && section.body)) {
      const containedChildren: number[] = [];
      for (let c = i + 1; c < section.end; c = doc.sections[c].end) if (doc.sections[c].contained) containedChildren.push(c);
      if (!containedChildren.length) {
        units.push({ from: i, to: section.end });
        return;
      }
      for (let c = i + 1; c < section.end; c = doc.sections[c].end) visit(c);
      return;
    }
    for (let c = i + 1; c < section.end; c = doc.sections[c].end) visit(c);
  };
  for (let i = 0; i < doc.sections.length; i = doc.sections[i].end) visit(i);
  return units;
}

// Abbreviations only before a number: "artikel 4.1" itself starts with "art".
const ONDERDEEL_ALIASES: Array<[RegExp, string]> = [
  [/^art\.?\s*(?=\d)/, "artikel "],
  [/^(?:hfdst|hfd|hst|h)\.?\s*(?=\d)/, "hoofdstuk "],
  [/^afd\.?\s*(?=\d)/, "afdeling "],
  [/^(?:par|§)\.?\s*(?=\d)/, "paragraaf "],
];

function normalizeLabel(text: string): string {
  let label = foldText(text).replace(/\s+/g, " ").trim();
  for (const [re, full] of ONDERDEEL_ALIASES) label = label.replace(re, full);
  return label.replace(/\.$/, "").replace(/\s+/g, " ").trim();
}

/** Sections in the regels before those in the toelichting and bijlagen. */
function inLichaam(doc: DsoDocument, section: DsoSection): boolean {
  let top = section;
  while (top.parent >= 0) top = doc.sections[top.parent];
  return top.type === "LICHAAM";
}

const ORDINALS = [
  "eerste", "tweede", "derde", "vierde", "vijfde", "zesde", "zevende", "achtste", "negende", "tiende",
  "elfde", "twaalfde", "dertiende", "veertiende", "vijftiende", "zestiende", "zeventiende", "achttiende", "negentiende", "twintigste",
];
// Each anchored on one separator character before "lid" or the ordinal, never on a lazy
// prefix: linear on any input (a run of commas made the old /^(.*?)[,\s]+lid…/ quadratic).
const LID_AFTER = /[,\s]lid\s+(\w+)\.?$/i;
const ORDINAL_LID_AFTER = new RegExp(`[,\\s](${ORDINALS.join("|")}|\\d+(?:e|de|ste))\\s+lid\\.?$`, "i");
const LID_BEFORE = new RegExp(`^(?:lid\\s+(\\w+)|(${ORDINALS.join("|")}|\\d+(?:e|de|ste))\\s+lid)\\s+(?:van|uit)\\s+(?:het\\s+)?(\\S.*)$`, "i");

function lidNumber(word: string): string {
  const ordinal = ORDINALS.indexOf(word.toLowerCase());
  return ordinal >= 0 ? String(ordinal + 1) : word.replace(/^(\d+)(?:e|de|ste)$/i, "$1").replace(/\.$/, "").toLowerCase();
}

function trimSeparators(text: string): string {
  let end = text.length;
  while (end > 0 && /[,\s]/.test(text[end - 1])) end--;
  return text.slice(0, end).trim();
}

/**
 * An onderdeel split into its label and lid: "artikel 4.1 lid 2", "artikel 4.1, lid 2",
 * "artikel 4.1, tweede lid", "artikel 4.1 2e lid" and "lid 2 van artikel 4.1" are all
 * ("artikel 4.1", "2"). A bare "lid 2" has no label and stays as it is.
 */
export function splitLid(onderdeel: string): { label: string; lid?: string } {
  const text = onderdeel.trim();
  for (const re of [LID_AFTER, ORDINAL_LID_AFTER]) {
    const m = re.exec(text);
    const label = m ? trimSeparators(text.slice(0, m.index)) : "";
    if (m && label) return { label, lid: lidNumber(m[1]) };
  }
  const before = LID_BEFORE.exec(text);
  if (before) return { label: before[3].trim(), lid: lidNumber(before[1] ?? before[2]) };
  return { label: text };
}

/** Sections whose label is `label`, those in the regels first. */
function labelMatches(doc: DsoDocument, label: string): DsoSection[] {
  const wanted = normalizeLabel(label);
  if (!wanted) return [];
  let matches = doc.sections.filter((s) => s.label && normalizeLabel(s.label) === wanted);
  // A kop with its whole heading in one element (a programma's "<Label>Hoofdstuk 3 Thema Wonen</Label>"):
  // the heading starts with the label.
  if (!matches.length) matches = doc.sections.filter((s) => s.heading && `${normalizeLabel(s.heading)} `.startsWith(`${wanted} `));
  return matches.sort((a, b) => Number(inLichaam(doc, b)) - Number(inLichaam(doc, a)));
}

/** The numbered leden of an artikel. */
function ledenOf(doc: DsoDocument, artikel: DsoSection): DsoSection[] {
  return doc.sections.slice(artikel.index + 1, artikel.end).filter((c) => c.parent === artikel.index && c.type === "LID");
}

/**
 * Sections an `onderdeel` names: a wId or eId (also as a table-of-contents line,
 * "Hoofdstuk 4 Bouwen [chp_4]"), or a label such as "Artikel 2.3",
 * "artikel 2.3 lid 2", "artikel 2.3, tweede lid", "Hoofdstuk 4", "Bijlage II".
 */
export function findOnderdeel(doc: DsoDocument, onderdeel: string): DsoSection[] {
  const wanted = onderdeel.trim();
  if (!wanted) return [];
  const bracketed = /\[([^\][\s]+)\]$/.exec(wanted)?.[1];
  for (const id of bracketed ? [wanted, bracketed] : [wanted]) {
    const byId = doc.sections.filter((s) => s.wId === id || s.eId === id || s.eId.toLowerCase() === id.toLowerCase());
    if (byId.length) return byId;
  }

  const { label, lid } = splitLid(wanted);
  const matches = labelMatches(doc, label);
  if (!lid) return matches;
  return matches.flatMap((s) => ledenOf(doc, s).filter((c) => c.heading.replace(/\.$/, "").toLowerCase() === lid));
}

/**
 * Why an onderdeel was not found, and what to ask for instead: the leden an
 * artikel does have (or that it has none), else the labels closest to it.
 */
function missingOnderdeel(doc: DsoDocument, onderdeel: string): { reason?: string; suggestions: string[] } {
  const { label, lid } = splitLid(onderdeel);
  const artikel = lid ? labelMatches(doc, label)[0] : undefined;
  if (artikel) {
    const name = artikel.label || artikel.heading;
    const leden = ledenOf(doc, artikel).map((c) => c.heading.replace(/\.$/, "")).filter(Boolean);
    if (!leden.length) return { reason: `${name} bestaat, maar heeft geen genummerde leden.`, suggestions: [name] };
    return { reason: `${name} heeft geen lid ${lid}; wel ${leden.length === 1 ? "lid" : "de leden"} ${leden.join(", ")}.`, suggestions: leden.slice(0, 10).map((n) => `${name} lid ${n}`) };
  }
  return { suggestions: nearbyLabels(doc, label) };
}

/** Labels that come closest to an onderdeel that was not found, for the suggestion. */
export function nearbyLabels(doc: DsoDocument, onderdeel: string, max = 5): string[] {
  const label = normalizeLabel(splitLid(onderdeel).label);
  const kind = label.split(" ")[0];
  const number = label.slice(kind.length).trim();
  const numberOf = (s: DsoSection) => normalizeLabel(s.label).slice(kind.length).trim();
  const sameKind = doc.sections.filter((s) => s.label && normalizeLabel(s.label).startsWith(`${kind} `));
  // The same hoofdstuk (4.24 for 4.99, not 40.1), the nearest numbers first, shown in document order.
  const chapter = number.split(".")[0];
  const close = number ? sameKind.filter((s) => numberOf(s).split(".")[0] === chapter) : [];
  const unique = [...new Map((close.length ? close : sameKind).map((s) => [s.label, s])).values()];
  const target = Number(number.split(".").pop());
  if (!close.length || !Number.isFinite(target)) return unique.slice(0, max).map((s) => s.label);
  const distance = (s: DsoSection) => {
    const d = Math.abs(Number(numberOf(s).split(".").pop()) - target);
    return Number.isNaN(d) ? Number.MAX_SAFE_INTEGER : d;
  };
  return unique
    .sort((a, b) => distance(a) - distance(b) || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((s) => s.label);
}

/** Types listed in the table of contents, from coarse to fine. */
const TOC_TIERS: string[][] = [
  ["HOOFDSTUK", "BIJLAGE", "TOELICHTING"],
  ["TITEL", "AFDELING", "ALGEMENE_TOELICHTING", "ARTIKELGEWIJZE_TOELICHTING"],
  ["PARAGRAAF", "SUBPARAGRAAF", "SUBSUBPARAGRAAF"],
  ["ARTIKEL"],
];

/**
 * The table-of-contents tier of a section (1 = hoofdstuk … 4 = artikel), if it
 * has one. A programma or omgevingsvisie is built from divisies instead: in the
 * lichaam, a divisie counts by its nesting and a divisietekst as an artikel.
 */
function tocTier(doc: DsoDocument, section: DsoSection): number | undefined {
  const tier = TOC_TIERS.findIndex((types) => types.includes(section.type));
  if (tier >= 0) return tier + 1;
  if ((section.type !== "DIVISIE" && section.type !== "DIVISIETEKST") || !inLichaam(doc, section)) return undefined;
  if (section.type === "DIVISIETEKST") return TOC_TIERS.length;
  let nesting = 0;
  for (let p = section.parent; p >= 0; p = doc.sections[p].parent) if (doc.sections[p].type === "DIVISIE") nesting++;
  return Math.min(nesting + 1, TOC_TIERS.length - 1);
}

/**
 * Table of contents of the document, one line per heading with its eId, as
 * fine-grained as fits in `maxChars`: articles if they fit, else down to
 * paragraphs, afdelingen or only hoofdstukken.
 */
export function tableOfContents(doc: DsoDocument, maxChars: number): { text: string; level: string; complete: boolean } {
  const levelNames = ["hoofdstukken en bijlagen", "afdelingen", "paragrafen", "artikelen"];
  const tiers = doc.sections.map((s) => tocTier(doc, s));
  let fallback = { text: "", level: levelNames[0], complete: false };
  for (let tier = TOC_TIERS.length; tier >= 1; tier--) {
    const listed = (i: number) => (tiers[i] ?? Infinity) <= tier;
    const lines: string[] = [];
    for (const s of doc.sections) {
      if (!listed(s.index) || !s.heading) continue;
      let depth = 0;
      for (let p = s.parent; p >= 0; p = doc.sections[p].parent) if (listed(p)) depth++;
      lines.push(`${"  ".repeat(depth)}${s.heading}${s.status ? ` [${s.status}]` : ""} [${s.eId}]`);
    }
    const text = lines.join("\n");
    if (text.length <= maxChars) return { text, level: levelNames[tier - 1], complete: true };
    if (tier === 1) {
      const cut = text.lastIndexOf("\n", maxChars - 2);
      fallback = { text: `${text.slice(0, cut > 0 ? cut : maxChars - 2)}\n…`, level: levelNames[0], complete: false };
    }
  }
  return fallback;
}

/** Characters of regeltekst a call returns by default, and at most. */
export const DSO_TEXT_DEFAULT_CHARS = 12_000;
export const DSO_TEXT_MAX_CHARS = 40_000;

export interface DsoTextPart {
  /**
   * Heading of the part ("Artikel 4.26 Dakkapel"), or "Begrip: dakkapel"; a
   * part of the toelichting says so ("Toelichting bij Artikel 4.26 Dakkapel").
   */
  title: string;
  /** Headings of the parts it sits in, outermost first, joined with " > ". */
  pad: string;
  eId: string;
  wId: string;
  type: string;
  tekst: string;
  /** Explanation from the toelichting, not a regel. */
  toelichting?: boolean;
  /** zoekterm: from tijdelijkeDelen[tijdelijkDeel] instead of the document itself. */
  tijdelijkDeel?: number;
  /** Did not fit in full: tekst holds its heading and the passages that matter; this many characters in full. */
  tekensVolledig?: number;
  /** weergave wijzigingen: what the ontwerp does to the part. */
  wijziging?: DsoChangeKind;
}

export interface DsoTextSelection {
  mode: "volledig" | "begin_met_inhoudsopgave" | "zoekterm" | "onderdeel" | "wijzigingen";
  parts: DsoTextPart[];
  /** Characters of the whole document as text. */
  totalChars: number;
  /** Text was cut to fit max_tekens. */
  truncated: boolean;
  inhoudsopgave?: string;
  inhoudsopgaveNiveau?: string;
  /** zoekterm: units that matched; onderdeel: sections that matched; wijzigingen: changes. */
  matches?: number;
  /** zoekterm: of the matches, those in the tijdelijke delen. */
  matchesTijdelijk?: number;
  /** Matches left out for lack of room (heading and eId), at most 25. */
  omitted?: Array<{ title: string; eId: string; tijdelijkDeel?: number }>;
  /** Parts shown only in part (tekensVolledig), in order. */
  shortened?: Array<{ title: string; eId: string; chars: number; tijdelijkDeel?: number }>;
  /** wijzigingen: the changes per kind (also those not shown). */
  wijzigingen?: Record<DsoChangeKind, number>;
  /** wijzigingen: the parts the changes make (consecutive renumberings, and begrippen of one list, are one part). */
  onderdelen?: number;
  /** zoekterm: the plural words that also matched by their stem. */
  stems?: Array<{ word: string; stem: string }>;
  notFound?: { reason?: string; suggestions: string[] };
}

/** At most `max` characters, cut at a line end where possible and marked "[…]". */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - 4);
  const cut = text.lastIndexOf("\n", room);
  return `${text.slice(0, cut > room * 0.6 ? cut : room).trimEnd()}\n[…]`;
}

/** One line of at most `max` characters, cut at a space and marked "…". */
function cutLine(line: string, max: number): string {
  if (line.length <= max) return line;
  const space = line.lastIndexOf(" ", max - 1);
  return `${line.slice(0, space > max * 0.6 ? space : max - 1).trimEnd()}…`;
}

/**
 * The title of a part. A toelichting copies the heading of the artikel it
 * explains; its title says it is the toelichting, so it is not read as the rule.
 */
function partTitle(doc: DsoDocument, section: DsoSection): string {
  const parent = section.parent >= 0 ? doc.sections[section.parent] : undefined;
  return titleFor(section.type, section.heading, section.body, inToelichting(doc, section), parent ? parent.label || parent.heading : undefined);
}

function partFor(doc: DsoDocument, from: number, to: number, tekst = renderSections(doc, from, to)): DsoTextPart {
  const section = doc.sections[from];
  return {
    title: partTitle(doc, section),
    pad: sectionPath(doc, section).join(" > "),
    eId: section.eId,
    wId: section.wId,
    type: section.type,
    tekst,
    ...(inToelichting(doc, section) ? { toelichting: true } : {}),
  };
}

/* ------------------------------------------------------------------ */
/*  Fitting hits into max_tekens                                       */
/* ------------------------------------------------------------------ */

/** Characters every hit gets at least: its heading and a passage around the first match. */
const SHORT_CHARS = 400;
const SNIPPET_CHARS = 200;
/** Parts per call at most, however short; the rest are only named. */
const MAX_PARTS = 40;
/** A part that does not fit in full gets this much for its passages: a third of max_tekens, at least 2000. */
const FOCUS_MIN_CHARS = 2_000;

/** A line as it reads after the change: renvooi marks and [nieuw]/[vervalt] taken out. */
function plainLine(line: string): string {
  return line
    .trim()
    .replace(/^\[(?:nieuw|vervalt)\]\s*/, "")
    .replace(/\[-[^\]]*?-\]/g, "")
    .replace(/\[\+([^\]]*?)\+\]|\[\+|\+\]/g, "$1");
}

/** A list item that hangs on the line opening its list: "b. een dakkapel …", "2°. …". */
const SUB_ITEM = /^(?:[a-z]{1,3}\.|\d+°\.?)\s/i;
/** How far up a line looks for what introduces it. */
const MAX_CONTEXT_LINES = 400;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The lines that matter, with what introduces them and "[…]" where lines are left
 * out: the first line (the heading), every hit with the lines below it that are
 * indented further (its sub-items), and above it each line it hangs on: the
 * nearest less indented line, and for a lettered item at the margin the aanhef
 * or lid that opens its list. Bbl artikel 2.29 for "dakkapel": the heading, the
 * aanhef, "b. een dakkapel in het achterdakvlak …" and its eisen 1° to 5°.
 */
function focusLines(lines: string[], isHit: (line: string) => boolean): string[] {
  const keep = new Set<number>([0]);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim() || !isHit(lines[i])) continue;
    keep.add(i);
    const level = indentOf(lines[i]);
    for (let j = i + 1; j < lines.length && lines[j].trim() && indentOf(lines[j]) > level; j++) keep.add(j);
    let at = level;
    let item = SUB_ITEM.test(plainLine(lines[i]));
    for (let k = i - 1; k > 0 && k >= i - MAX_CONTEXT_LINES && (at > 0 || item); k--) {
      if (!lines[k].trim()) continue;
      const indent = indentOf(lines[k]);
      if (indent < at) {
        keep.add(k);
        at = indent;
        item = SUB_ITEM.test(plainLine(lines[k]));
      } else if (indent === 0 && at === 0 && !SUB_ITEM.test(plainLine(lines[k]))) {
        keep.add(k);
        item = false;
      }
    }
  }
  const out: string[] = [];
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!keep.has(i)) continue;
    if (i > last + 1) out.push("[…]");
    out.push(lines[i]);
    last = i;
  }
  if (last < lines.length - 1) out.push("[…]");
  return out;
}

/** Where the first of `needles` (folded) starts in `text`, as an index into text; -1 if none. */
function matchAt(text: string, needles: string[]): number {
  const first = (folded: string) => {
    let best = -1;
    for (const needle of needles) {
      const at = folded.indexOf(needle);
      if (at >= 0 && (best < 0 || at < best)) best = at;
    }
    return best;
  };
  const folded = foldText(text);
  // Folding usually keeps every position ("é" becomes "e"); a soft hyphen it drops shifts them.
  if (folded.length === text.length) return first(folded);
  let mapped = "";
  const origin: number[] = [];
  for (let i = 0; i < text.length; ) {
    const char = String.fromCodePoint(text.codePointAt(i) as number);
    const f = foldText(char);
    mapped += f;
    for (let k = 0; k < f.length; k++) origin.push(i);
    i += char.length;
  }
  const at = first(mapped);
  return at < 0 ? -1 : origin[at];
}

/** The heading and about 200 characters around the first match: what every hit shows at least. */
function snippet(text: string, needles: string[]): string {
  const lines = text.split("\n");
  const lead = cutLine(lines[0], 150);
  const at = lines.findIndex((line, i) => i > 0 && needles.some((n) => foldText(line).includes(n)));
  if (at < 0) {
    // The match is in the heading: the text after it.
    const next = lines.findIndex((line, i) => i > 0 && line.trim());
    return next < 0 ? lead : `${lead}\n${cutLine(lines[next].trim(), SNIPPET_CHARS)}`;
  }
  const line = lines[at].trim();
  const pos = Math.max(0, matchAt(line, needles));
  let start = Math.max(0, pos - 60);
  if (start > 0) {
    const space = line.lastIndexOf(" ", start);
    start = space > 0 && pos - space < 120 ? space + 1 : start;
  }
  let end = Math.min(line.length, start + SNIPPET_CHARS);
  if (end < line.length) {
    const space = line.lastIndexOf(" ", end);
    if (space > pos) end = space;
  }
  return `${lead}\n${at > 1 ? "[…]\n" : ""}${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

interface Candidate {
  /** The part with its full text. */
  part: DsoTextPart;
  /** At most SHORT_CHARS characters: the heading and the first match. */
  short: () => string;
  /** The passages that matter, at most `max` characters. */
  focus: (max: number) => string;
}

/**
 * Fit hits, in order of priority, into maxChars without dropping one silently:
 *  1. each its short form (heading and first match), in half the room;
 *  2. in the same order, the full text where it still fits, else its passages
 *     (focus): a long artikel early in the list does not push out the rest;
 *  3. with room left, the next hits in full or short, until one does not fit.
 * What is left is only named (omitted); what is shown in part says so
 * (tekensVolledig, shortened).
 */
function pack(candidates: Candidate[], maxChars: number): Pick<DsoTextSelection, "parts" | "omitted" | "shortened"> {
  const shown: Array<{ candidate: Candidate; tekst: string }> = [];
  const shortOf = (c: Candidate) => (c.part.tekst.length <= SHORT_CHARS ? c.part.tekst : c.short());
  let used = 0;
  let next = 0;
  for (; next < candidates.length && shown.length < MAX_PARTS; next++) {
    const tekst = shortOf(candidates[next]);
    if (shown.length && used + tekst.length > maxChars / 2) break;
    shown.push({ candidate: candidates[next], tekst });
    used += tekst.length;
  }
  const focusMax = Math.max(FOCUS_MIN_CHARS, Math.floor(maxChars / 3));
  for (const s of shown) {
    const full = s.candidate.part.tekst;
    if (s.tekst === full) continue;
    const room = maxChars - used;
    if (full.length - s.tekst.length <= room) {
      used += full.length - s.tekst.length;
      s.tekst = full;
      continue;
    }
    const target = Math.min(s.tekst.length + room, focusMax);
    if (target <= s.tekst.length) continue;
    const focused = s.candidate.focus(target);
    if (focused.length > s.tekst.length && focused.length <= target) {
      used += focused.length - s.tekst.length;
      s.tekst = focused;
    }
  }
  for (; next < candidates.length && shown.length < MAX_PARTS; next++) {
    const c = candidates[next];
    const room = maxChars - used;
    const tekst = c.part.tekst.length <= room ? c.part.tekst : shortOf(c);
    if (tekst.length > room) break;
    shown.push({ candidate: c, tekst });
    used += tekst.length;
  }
  const source = (p: DsoTextPart) => (p.tijdelijkDeel !== undefined ? { tijdelijkDeel: p.tijdelijkDeel } : {});
  const parts = shown.map(({ candidate: { part }, tekst }) => (tekst === part.tekst ? part : { ...part, tekst, tekensVolledig: part.tekst.length }));
  return {
    parts,
    omitted: candidates.slice(next, next + 25).map(({ part }) => ({ title: part.title, eId: part.eId, ...source(part) })),
    shortened: parts.filter((p) => p.tekensVolledig).map((p) => ({ title: p.title, eId: p.eId, chars: p.tekensVolledig as number, ...source(p) })),
  };
}

/** Hits for a zoekterm: the regels first, then bijlagen, then toelichting; a tijdelijk deel's after the document's own. */
function zoektermCandidates(docs: DsoDocument[], words: Array<{ word: string; stem?: string }>): Array<Candidate & { tier: number }> {
  const needles = words.flatMap(({ word, stem }) => (stem ? [word, stem] : [word]));
  const isHit = (line: string) => needles.some((n) => foldText(line).includes(n));
  const hits: Array<Candidate & { tier: number; order: number }> = [];
  docs.forEach((doc, d) => {
    for (const { from, to } of textUnits(doc)) {
      const tekst = renderSections(doc, from, to);
      const folded = foldText(tekst);
      // A unit holds every word, or a plural's stem ("dakkapellen" finds "dakkapel").
      if (!words.every(({ word, stem }) => folded.includes(word) || (stem !== undefined && folded.includes(stem)))) continue;
      const section = doc.sections[from];
      const toelichting = inToelichting(doc, section);
      const tier = (toelichting ? 4 : inLichaam(doc, section) ? 0 : 2) + (d > 0 ? 1 : 0);
      const part = { ...partFor(doc, from, to, tekst), ...(d > 0 ? { tijdelijkDeel: d - 1 } : {}) };
      hits.push({
        part,
        tier,
        order: hits.length,
        short: () => snippet(tekst, needles),
        focus: (max) => cutText(focusLines(tekst.split("\n"), isHit).join("\n"), max),
      });
    }
  });
  return hits.sort((a, b) => a.tier - b.tier || a.order - b.order);
}

/** Term and definitie of a begrip's change ("[nieuw] TERM: definitie"). */
function begripOf(change: DsoChange): { term: string; definitie: string } {
  const text = squash(change.tekst.replace(/^\[(?:nieuw|vervalt)\]\s*/, ""));
  // An informatieobject's term can hold ": " itself ("BOUWAANDUIDING: PLAT DAK H21"); its definitie is the reference.
  const reference = /: (?:\[[+-])?\/join\/id\//.exec(text);
  const colon = reference ? reference.index : text.indexOf(": ");
  return colon < 0 ? { term: text, definitie: "" } : { term: text.slice(0, colon), definitie: text.slice(colon + 2) };
}

/**
 * The lines of consecutive begrip changes in one list (a begrippenlijst, the
 * informatieobjecten of a bijlage). A begrip removed and added under the same
 * term is one line: the ontwerp reorders the list, and only a changed
 * definitie (a new version of an informatieobject) is a change.
 */
function begripLines(run: DsoChange[]): string[] {
  const added = new Map<string, DsoChange>();
  const removed = new Map<string, DsoChange>();
  for (const change of run) {
    const map = change.kind === "nieuw" ? added : change.kind === "vervalt" ? removed : undefined;
    if (map && !map.has(begripOf(change).term)) map.set(begripOf(change).term, change);
  }
  const lines: string[] = [];
  for (const change of run) {
    const { term, definitie } = begripOf(change);
    const before = removed.get(term);
    const after = added.get(term);
    if (!before || !after || (change !== before && change !== after)) {
      const swap = change.kind === "gewijzigd" ? /^\[-(\S+)-\] \[\+(\S+)\+\]$/.exec(definitie) : null;
      lines.push((swap && newVersion(term, swap[1], swap[2])) || change.tekst);
    } else if (change === after) {
      const old = begripOf(before).definitie;
      lines.push(old === definitie ? `${term}: ${definitie} (alleen verplaatst in de lijst)` : (newVersion(term, old, definitie) ?? `${term}: [-${old}-] [+${definitie}+]`));
    }
  }
  return lines;
}

const INFORMATIEOBJECT_VERSION = /^(\/join\/id\/regdata\/\S+?)\/(\w{3}@\S+)$/;

/** A begrip that now points to a new version of the same informatieobject (a GIO with changed geometry). */
function newVersion(term: string, before: string, after: string): string | undefined {
  const a = INFORMATIEOBJECT_VERSION.exec(before);
  const b = INFORMATIEOBJECT_VERSION.exec(after);
  return a && b && a[1] === b[1] ? `${term}: nieuwe versie van ${a[1]} ([-${a[2]}-] [+${b[2]}+])` : undefined;
}

/**
 * The changes of an ontwerp as parts, in document order. Consecutive parts that
 * are only renumbered make one part, as do consecutive begrippen of one list.
 */
function changeCandidates(changes: DsoChange[]): Candidate[] {
  const runs: DsoChange[][] = [];
  const key = (c: DsoChange) => (c.kind === "vernummerd" ? "vernummerd" : c.type === "BEGRIP" ? `begrip|${c.pad}` : undefined);
  for (const change of changes) {
    const last = runs[runs.length - 1];
    if (last && key(change) !== undefined && key(change) === key(last[0])) last.push(change);
    else runs.push([change]);
  }
  return runs.map((run) => {
    const [first] = run;
    const single = run.length === 1;
    const renumbered = first.kind === "vernummerd";
    const lines = single || renumbered ? run.map((c) => c.tekst) : begripLines(run);
    const list = first.pad.split(" > ").pop() || "Begrippen";
    const part: DsoTextPart = {
      title: single ? `${first.title}${renumbered ? " (alleen vernummerd)" : ""}` : renumbered ? `Alleen vernummerd (${run.length} onderdelen, tekst ongewijzigd)` : `${list}: wijzigingen in ${lines.length} begrippen`,
      pad: first.pad,
      eId: single ? first.eId : "",
      wId: single ? first.wId : "",
      type: single ? first.type : renumbered ? "VERNUMMERD" : "BEGRIPPEN",
      tekst: lines.join("\n"),
      ...(first.toelichting ? { toelichting: true } : {}),
      wijziging: single || renumbered ? first.kind : "gewijzigd",
    };
    return { part, short: () => cutText(part.tekst, SHORT_CHARS), focus: (max: number) => cutText(part.tekst, max) };
  });
}

/**
 * The text a dso_omgevingsdocument_tekst call returns, within `maxChars`:
 *  - weergave "wijzigingen" (an ontwerp with renvooi): only what it changes (see
 *    collectChanges), within the onderdeel and with the zoekterm if given;
 *  - zoekterm: the units (artikelen, begrippen, divisieteksten) whose heading or
 *    text holds every word (or a plural's stem), case- and accent-insensitive,
 *    with their path, also in `tijdelijkeDelen` (the voorbeschermingsregels of an
 *    omgevingsplan); the regels first, then bijlagen, then the toelichting. Every
 *    hit that fits gets at least its heading and first match (see pack);
 *  - onderdeel: that part with everything under it;
 *  - neither: the whole document when it fits, else its beginning plus a table
 *    of contents whose eIds a follow-up call can pass as onderdeel.
 */
export function selectDsoText(
  doc: DsoDocument,
  options: { zoekterm?: string; onderdeel?: string; maxChars: number; weergave?: "nieuw" | "wijzigingen"; tijdelijkeDelen?: DsoDocument[] },
): DsoTextSelection {
  const { maxChars } = options;
  const totalChars = doc.totalChars;
  const words = zoektermWords(options.zoekterm ?? "");
  const stems = words.filter((w) => w.stem).map((w) => ({ word: w.word, stem: w.stem as string }));
  const withStems = stems.length ? { stems } : {};

  if (options.weergave === "wijzigingen") {
    let changes = doc.wijzigingen ?? [];
    if (options.onderdeel?.trim()) {
      const found = findOnderdeel(doc, options.onderdeel);
      if (!found.length) {
        return { mode: "wijzigingen", parts: [], totalChars, truncated: false, matches: 0, notFound: missingOnderdeel(doc, options.onderdeel) };
      }
      const root = found[0].eId;
      changes = changes.filter((c) => c.eId === root || c.eId.startsWith(`${root}__`));
    }
    if (words.length) {
      changes = changes.filter((c) => {
        const text = foldText(`${c.title}\n${c.tekst}`);
        return words.every(({ word, stem }) => text.includes(word) || (stem !== undefined && text.includes(stem)));
      });
    }
    const counts: Record<DsoChangeKind, number> = { nieuw: 0, vervalt: 0, gewijzigd: 0, vernummerd: 0 };
    for (const c of changes) counts[c.kind]++;
    const candidates = changeCandidates(changes);
    const packed = pack(candidates, maxChars);
    return {
      mode: "wijzigingen",
      ...packed,
      totalChars,
      truncated: Boolean(packed.shortened?.length || packed.omitted?.length),
      matches: changes.length,
      onderdelen: candidates.length,
      wijzigingen: counts,
      ...withStems,
    };
  }

  if (options.onderdeel?.trim()) {
    const found = findOnderdeel(doc, options.onderdeel);
    if (!found.length) {
      return { mode: "onderdeel", parts: [], totalChars, truncated: false, matches: 0, notFound: missingOnderdeel(doc, options.onderdeel) };
    }
    const part = partFor(doc, found[0].index, found[0].end);
    const truncated = part.tekst.length > maxChars;
    return {
      mode: "onderdeel",
      parts: [{ ...part, tekst: cutText(part.tekst, maxChars) }],
      totalChars,
      truncated,
      matches: found.length,
      omitted: found.slice(1, 26).map((s) => ({ title: partTitle(doc, s), eId: s.eId })),
    };
  }

  if (words.length) {
    const hits = zoektermCandidates([doc, ...(options.tijdelijkeDelen ?? [])], words);
    const packed = pack(hits, maxChars);
    const tijdelijk = hits.filter((h) => h.part.tijdelijkDeel !== undefined).length;
    return {
      mode: "zoekterm",
      ...packed,
      totalChars,
      truncated: Boolean(packed.shortened?.length || packed.omitted?.length) || packed.parts.length < hits.length,
      matches: hits.length,
      ...(tijdelijk ? { matchesTijdelijk: tijdelijk } : {}),
      ...withStems,
    };
  }

  const all = renderSections(doc, 0, doc.sections.length);
  const title = "Volledige tekst";
  if (all.length <= maxChars) {
    return { mode: "volledig", parts: [{ title, pad: "", eId: "", wId: "", type: "DOCUMENT", tekst: all }], totalChars, truncated: false };
  }
  // Half the room for the table of contents at most, the rest for the beginning.
  const toc = tableOfContents(doc, Math.floor(maxChars / 2));
  const begin = cutText(all, maxChars - toc.text.length);
  return {
    mode: "begin_met_inhoudsopgave",
    parts: [{ title: "Begin van de tekst", pad: "", eId: "", wId: "", type: "DOCUMENT", tekst: begin }],
    totalChars,
    truncated: true,
    inhoudsopgave: toc.text,
    inhoudsopgaveNiveau: toc.level,
  };
}
