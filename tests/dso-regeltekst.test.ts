import { describe, expect, it } from "vitest";
import {
  buildDsoDocument,
  findOnderdeel,
  foldText,
  nearbyLabels,
  renderSections,
  selectDsoText,
  splitLid,
  stopKop,
  stopXmlToText,
  tableOfContents,
  zoektermWords,
  type DsoDocumentComponent,
} from "../src/sources/dso-regeltekst.js";

const NS = 'xmlns="https://standaarden.overheid.nl/stop/imop/tekst/"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

describe("stopXmlToText", () => {
  it("renders a begrip as 'term: definitie'", () => {
    const xml = `${XML}<Begrip ${NS} wId="b1" eId="b1"><Term>Dakkapel</Term><Definitie><Al>Een constructie ter vergroting van de kap.</Al></Definitie></Begrip>`;
    expect(stopXmlToText(xml)).toBe("Dakkapel: Een constructie ter vergroting van de kap.");
  });

  it("keeps mixed content in order and a newline in the source as a space", () => {
    const xml = `<Inhoud ${NS}><Al>In afwijking van het <IntRef ref="para_1">eerste</IntRef> lid gaan de <ExtRef soort="URL" ref="https://x">regels
                    </ExtRef>
                    voor.</Al></Inhoud>`;
    expect(stopXmlToText(xml)).toBe("In afwijking van het eerste lid gaan de regels voor.");
  });

  it("breaks the line only at <br/> and decodes only predefined and numeric references", () => {
    const xml = `<!DOCTYPE x [<!ENTITY xxe "boom">]><Inhoud ${NS}><Al>Hoogte &lt; 3 m &amp; ge&#239;ntegreerd<br/>&xxe; blijft staan</Al></Inhoud>`;
    expect(stopXmlToText(xml)).toBe("Hoogte < 3 m & geïntegreerd\n&xxe; blijft staan");
  });

  it("numbers list items and indents a nested list; an unnumbered list gets dashes", () => {
    const xml = `<Inhoud ${NS}><Al>De volgende gegevens:</Al><Lijst type="expliciet">
      <Li><LiNummer>a.</LiNummer><Al>een situatietekening met daarop:</Al>
        <Lijst type="expliciet"><Li><LiNummer>1.</LiNummer><Al>de afmetingen van het perceel;</Al></Li><Li><LiNummer>2.</LiNummer><Al>de wegzijde;</Al></Li></Lijst>
      </Li>
      <Li><LiNummer>b.</LiNummer><Al>de hoogte.</Al></Li>
    </Lijst><Lijst type="ongemarkeerd"><Li><Al>wonen</Al></Li></Lijst></Inhoud>`;
    expect(stopXmlToText(xml).split("\n")).toEqual([
      "De volgende gegevens:",
      "a. een situatietekening met daarop:",
      "   1. de afmetingen van het perceel;",
      "   2. de wegzijde;",
      "b. de hoogte.",
      "- wonen",
    ]);
  });

  it("flattens a table to one line per row", () => {
    const xml = `<Inhoud ${NS}><table><title>Afstanden</title><tgroup cols="2"><colspec colname="c1"/><thead><row><entry><Al><strong>Categorie</strong></Al></entry><entry><Al>Afstand</Al></entry></row></thead>
      <tbody><row><entry><Al>1</Al></entry><entry><Al>10 m</Al></entry></row><row><entry/><entry/></row></tbody></tgroup></table></Inhoud>`;
    expect(stopXmlToText(xml).split("\n")).toEqual(["Afstanden", "Categorie | Afstand", "1 | 10 m"]);
  });

  it("keeps every cell of a table in its column when a cell spans columns or rows", () => {
    // Shaped as Tabel 22.3.27 and 22.3.23 of the Utrecht omgevingsplan: namest/nameend and morerows.
    const xml = `<Inhoud ${NS}><table><title>Emissiegrenswaarden</title><tgroup cols="4">
      <colspec colname="col1" colnum="1"/><colspec colname="col2" colnum="2"/><colspec colname="col3" colnum="3"/><colspec colname="col4" colnum="4"/>
      <thead><row><entry colname="col1">Stof</entry><entry colname="col2" namest="col2" nameend="col4">Emissiegrenswaarden in mg/l</entry></row>
      <row><entry colname="col1"/><entry namest="col2" nameend="col3">Etmaalmonster</entry><entry colname="col4">Steekmonster</entry></row></thead>
      <tbody><row><entry colname="col1" morerows="1">Zuiveringtechnisch werk</entry><entry namest="col2" nameend="col3">30 mg/l</entry><entry colname="col4">60 mg/l</entry></row>
      <row><entry colname="col2">binnen de kom</entry><entry colname="col3">5</entry><entry colname="col4">10</entry></row>
      <row><entry>Onopgeloste stoffen</entry><entry>1</entry><entry>2</entry><entry>3</entry></row></tbody></tgroup></table></Inhoud>`;
    expect(stopXmlToText(xml).split("\n")).toEqual([
      "Emissiegrenswaarden",
      "Stof | Emissiegrenswaarden in mg/l",
      " | Etmaalmonster |  | Steekmonster",
      "Zuiveringtechnisch werk | 30 mg/l |  | 60 mg/l",
      " | binnen de kom | 5 | 10",
      "Onopgeloste stoffen | 1 | 2 | 3",
    ]);
  });

  it("adds the URL of a link whose text says nothing on its own, and only then", () => {
    // The DSO's Omgevingswet: "vindt u hier" with the address in the ExtRef.
    const xml = `<Inhoud ${NS}><Al>De tekst vindt u <ExtRef soort="URL" ref="https://iplo.nl/regelgeving/">hier</ExtRef>; zie ook <ExtRef soort="URL" ref="https://x">artikel 2.29</ExtRef>.</Al></Inhoud>`;
    expect(stopXmlToText(xml)).toBe("De tekst vindt u hier (https://iplo.nl/regelgeving/); zie ook artikel 2.29.");
  });

  it("reads renvooi as the text after the change: deleted text out, added text in", () => {
    const xml = `<Inhoud ${NS}><Al>Deze <VerwijderdeTekst>omgevingswaarde is</VerwijderdeTekst><NieuweTekst>omgevingswaarden zijn</NieuweTekst> een plicht.</Al>` +
      `<Al wijzigactie="verwijder">Een geschrapte zin.</Al><Lijst wijzigactie="verwijder"><Li><LiNummer>a.</LiNummer><Al>weg</Al></Li></Lijst><Al wijzigactie="voegtoe">Een nieuwe zin.</Al>` +
      `<Lijst wijzigactie="verwijderContainer"><Al>Blijft staan.</Al></Lijst><VerwijderdeTekst/></Inhoud>`;
    expect(stopXmlToText(xml).split("\n")).toEqual(["Deze omgevingswaarden zijn een plicht.", "Een nieuwe zin.", "Blijft staan."]);
    expect(stopKop(`<Kop><Label>HOOFDSTUK</Label><Nummer>\n  <VerwijderdeTekst>24</VerwijderdeTekst>\n  <NieuweTekst>23</NieuweTekst>\n</Nummer><Opschrift>SLOTBEPALINGEN</Opschrift></Kop>`).text).toBe("HOOFDSTUK 23 SLOTBEPALINGEN");
  });

  it("does not backtrack on a malformed DOCTYPE", () => {
    // Exponential before: 26 pairs took ~140 ms, every two more pairs four times as long.
    const started = performance.now();
    const text = stopXmlToText("<Al>x</Al><!DOCTYPE" + "[]".repeat(40));
    expect(performance.now() - started).toBeLessThan(100);
    expect(text.startsWith("x")).toBe(true);
  });

  it("parses in linear time however many declarations, comments, CDATA sections, DOCTYPEs or tags are left open", () => {
    // Quadratic before: 100 000 characters of "<!DOCTYPE" took 2.3 s, each opener scanning to the end.
    for (const opener of ["<!DOCTYPE", "<?", "<!--", "<![CDATA[", "<!DOCTYPE[", "<!DOCTYPE[<!DOCTYPE[]x", "<a b='", "</a  "]) {
      const xml = `<Al>x</Al>${opener.repeat(Math.ceil(100_000 / opener.length))}`;
      const started = performance.now();
      const text = stopXmlToText(xml);
      expect(performance.now() - started, opener).toBeLessThan(250);
      expect(text.startsWith("x")).toBe(true);
    }
  });

  it("still skips a complete declaration, comment and DOCTYPE with an internal subset, and keeps CDATA as text", () => {
    expect(stopXmlToText(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><!-- c --><Al>tekst <![CDATA[a < b]]></Al>`)).toBe("tekst a < b");
  });

  it("marks renvooi in the renvooi view and reads the text before the change in the oud view", () => {
    const xml =
      `<Inhoud ${NS}><Al>In het gebied <NieuweTekst>NIEUW </NieuweTekst>X worden gronden gebruikt voor:</Al><Lijst>` +
      `<Li><LiNummer>a.</LiNummer><Al>wegen;</Al></Li><Li wijzigactie="voegtoe"><LiNummer>b.</LiNummer><Al>speelvoorzieningen;</Al></Li>` +
      `<Li><LiNummer><VerwijderdeTekst>b</VerwijderdeTekst><NieuweTekst>c</NieuweTekst>.</LiNummer><Al>terrassen.</Al></Li>` +
      `<Li wijzigactie="verwijder"><LiNummer>d.</LiNummer><Al>kiosken.</Al></Li></Lijst></Inhoud>`;
    expect(stopXmlToText(xml, "renvooi").split("\n")).toEqual([
      "In het gebied [+NIEUW +]X worden gronden gebruikt voor:",
      "a. wegen;",
      "[+b. speelvoorzieningen;+]",
      "[-b-][+c+]. terrassen.",
      "[-d. kiosken.-]",
    ]);
    expect(stopXmlToText(xml, "oud").split("\n")).toEqual(["In het gebied X worden gronden gebruikt voor:", "a. wegen;", "b. terrassen.", "d. kiosken."]);
    expect(stopXmlToText(xml).split("\n")).toEqual(["In het gebied NIEUW X worden gronden gebruikt voor:", "a. wegen;", "b. speelvoorzieningen;", "c. terrassen."]);
    expect(stopKop(`<Kop><Label>Artikel</Label><Nummer><VerwijderdeTekst>21.29</VerwijderdeTekst><NieuweTekst>21.30</NieuweTekst></Nummer><Opschrift>Parkeren</Opschrift></Kop>`, "renvooi").text).toBe(
      "Artikel [-21.29-][+21.30+] Parkeren",
    );
  });

  it("reads the parts of a kop", () => {
    expect(stopKop(`${XML}<Kop ${NS}><Label>Artikel</Label><Nummer>4.24</Nummer><Opschrift>Dakkapel aan de voorkant</Opschrift></Kop>`)).toEqual({
      label: "Artikel",
      nummer: "4.24",
      opschrift: "Dakkapel aan de voorkant",
      text: "Artikel 4.24 Dakkapel aan de voorkant",
    });
  });
});

/* ------------------------------------------------------------------ */
/*  A small omgevingsplan, shaped as the DSO's documentstructuur       */
/* ------------------------------------------------------------------ */

const kop = (label: string, nummer: string, opschrift = "") =>
  `${XML}<Kop ${NS}>${label ? `<Label>${label}</Label>` : ""}${nummer ? `<Nummer>${nummer}</Nummer>` : ""}${opschrift ? `<Opschrift>${opschrift}</Opschrift>` : ""}</Kop>`;
const inhoud = (body: string) => `${XML}<Inhoud ${NS}>${body}</Inhoud>`;
const begrip = (id: string, term: string, def: string) => `<Begrip wId="${id}" eId="${id}"><Term>${term}</Term><Definitie><Al>${def}</Al></Definitie></Begrip>`;

function plan(): DsoDocumentComponent[] {
  return [
    {
      identificatie: "body",
      expressie: "body",
      type: "LICHAAM",
      volgordeNummer: 0,
      _embedded: {
        documentComponenten: [
          {
            identificatie: "gm9999_1__chp_1",
            expressie: "chp_1",
            type: "HOOFDSTUK",
            volgordeNummer: 0,
            kop: kop("Hoofdstuk", "1", "Algemene bepalingen"),
            _embedded: {
              documentComponenten: [
                {
                  identificatie: "gm9999_2__chp_1__art_1.1",
                  expressie: "chp_1__art_1.1",
                  type: "ARTIKEL",
                  volgordeNummer: 0,
                  kop: kop("Artikel", "1.1", "Begrippen"),
                  inhoud: inhoud(`<Begrippenlijst>${begrip("gm9999_b1", "Dakkapel", "Een constructie ter vergroting van de kap.")}${begrip("gm9999_b2", "Erker", "Een uitbouw aan de voorkant.")}</Begrippenlijst>`),
                  _embedded: {
                    documentComponenten: [
                      { identificatie: "gm9999_b1", expressie: "chp_1__art_1.1__item_1", type: "BEGRIP", volgordeNummer: 0, inhoud: begrip("gm9999_b1", "Dakkapel", "Een constructie ter vergroting van de kap.") },
                      { identificatie: "gm9999_b2", expressie: "chp_1__art_1.1__item_2", type: "BEGRIP", volgordeNummer: 1, inhoud: begrip("gm9999_b2", "Erker", "Een uitbouw aan de voorkant.") },
                    ],
                  },
                },
              ],
            },
          },
          { identificatie: "gm9999_1__chp_2", expressie: "chp_2", type: "HOOFDSTUK", volgordeNummer: 1, gereserveerd: true, kop: kop("Hoofdstuk", "2") },
          {
            identificatie: "gm9999_1__chp_3",
            expressie: "chp_3",
            type: "HOOFDSTUK",
            volgordeNummer: 2,
            kop: kop("Hoofdstuk", "3", "Bouwen"),
            _embedded: {
              documentComponenten: [
                {
                  identificatie: "gm9999_3__chp_3__art_3.1",
                  expressie: "chp_3__art_3.1",
                  type: "ARTIKEL",
                  volgordeNummer: 0,
                  kop: kop("Artikel", "3.1", "Dakkapel aan de achterkant"),
                  _embedded: {
                    documentComponenten: [
                      { identificatie: "gm9999_4__para_1", expressie: "chp_3__art_3.1__para_1", type: "LID", volgordeNummer: 0, kop: kop("", "1."), inhoud: inhoud("<Al>Een dakkapel aan de achterkant is vergunningvrij.</Al>") },
                      { identificatie: "gm9999_4__para_2", expressie: "chp_3__art_3.1__para_2", type: "LID", volgordeNummer: 1, kop: kop("", "2."), inhoud: inhoud('<Al>Het eerste lid geldt niet in een <IntRef ref="x">beschermd stadsgezicht</IntRef>.</Al>') },
                    ],
                  },
                },
                {
                  identificatie: "gm9999_5__chp_3__art_3.2",
                  expressie: "chp_3__art_3.2",
                  type: "ARTIKEL",
                  volgordeNummer: 1,
                  kop: kop("Artikel", "3.2", "Geïntegreerde zonnepanelen"),
                  inhoud: inhoud("<Al>Zonnepanelen op een plat dak zijn toegestaan.</Al>"),
                },
              ],
            },
          },
        ],
      },
    },
    {
      identificatie: "recital",
      expressie: "recital",
      type: "TOELICHTING",
      volgordeNummer: 1,
      kop: kop("", "", "Toelichting"),
      _embedded: {
        documentComponenten: [
          { identificatie: "gm9999_6__div", expressie: "recital__div_1", type: "DIVISIETEKST", volgordeNummer: 0, kop: kop("", "", "Artikel 3.1 Dakkapel aan de achterkant"), inhoud: inhoud("<Al>Een dakkapel aan de achterkant hindert de straat niet.</Al>") },
        ],
      },
    },
  ];
}

describe("DSO document structure", () => {
  it("renders headings, leden as '1. …', begrippen once and a gereserveerd hoofdstuk", () => {
    const doc = buildDsoDocument(plan());
    const text = selectDsoText(doc, { maxChars: 10_000 });
    expect(text.mode).toBe("volledig");
    expect(text.parts[0].tekst.split("\n")).toEqual([
      "Hoofdstuk 1 Algemene bepalingen",
      "",
      "Artikel 1.1 Begrippen",
      "Dakkapel: Een constructie ter vergroting van de kap.",
      "Erker: Een uitbouw aan de voorkant.",
      "",
      "Hoofdstuk 2 [gereserveerd]",
      "",
      "Hoofdstuk 3 Bouwen",
      "",
      "Artikel 3.1 Dakkapel aan de achterkant",
      "1. Een dakkapel aan de achterkant is vergunningvrij.",
      "2. Het eerste lid geldt niet in een beschermd stadsgezicht.",
      "",
      "Artikel 3.2 Geïntegreerde zonnepanelen",
      "Zonnepanelen op een plat dak zijn toegestaan.",
      "",
      "Toelichting",
      "",
      "Artikel 3.1 Dakkapel aan de achterkant",
      "Een dakkapel aan de achterkant hindert de straat niet.",
    ]);
    expect(doc.totalChars).toBe(text.parts[0].tekst.length);
  });

  it("zoekterm returns the matching begrip and artikelen with their path, case and accents ignored", () => {
    const doc = buildDsoDocument(plan());
    const hits = selectDsoText(doc, { zoekterm: "DAKKAPEL", maxChars: 10_000 });
    expect(hits.mode).toBe("zoekterm");
    expect(hits.matches).toBe(3);
    expect(hits.parts.map((p) => [p.title, p.pad, p.eId])).toEqual([
      ["Begrip: Dakkapel", "Hoofdstuk 1 Algemene bepalingen > Artikel 1.1 Begrippen", "chp_1__art_1.1__item_1"],
      ["Artikel 3.1 Dakkapel aan de achterkant", "Hoofdstuk 3 Bouwen", "chp_3__art_3.1"],
      // The toelichting copies the artikel's heading; its title says what it is.
      ["Toelichting bij Artikel 3.1 Dakkapel aan de achterkant", "Toelichting", "recital__div_1"],
    ]);
    expect(hits.parts.map((p) => p.toelichting ?? false)).toEqual([false, false, true]);
    // The tekst itself stays the source text.
    expect(hits.parts[2].tekst.startsWith("Artikel 3.1 Dakkapel aan de achterkant\n")).toBe(true);
    // A begrip on its own, not the whole begrippenlijst.
    expect(hits.parts[0].tekst).toBe("Dakkapel: Een constructie ter vergroting van de kap.");

    // Every word must occur; accents do not matter.
    const both = selectDsoText(doc, { zoekterm: "geintegreerde plat", maxChars: 10_000 });
    expect(both.parts.map((p) => p.eId)).toEqual(["chp_3__art_3.2"]);
    expect(selectDsoText(doc, { zoekterm: "dakkapel zonnepanelen", maxChars: 10_000 }).matches).toBe(0);
  });

  it("zoekterm also finds a plural's stem, and only for long plurals", () => {
    const doc = buildDsoDocument(plan());
    const plural = selectDsoText(doc, { zoekterm: "dakkapellen", maxChars: 10_000 });
    // The begrip and the artikel say "dakkapel" only.
    expect(plural.parts.map((p) => p.eId)).toEqual(["chp_1__art_1.1__item_1", "chp_3__art_3.1", "recital__div_1"]);
    expect(plural.stems).toEqual([{ word: "dakkapellen", stem: "dakkapel" }]);

    expect(zoektermWords("Dakkapellen windturbines bouwwerken")).toEqual([
      { word: "dakkapellen", stem: "dakkapel" },
      { word: "windturbines", stem: "windturbine" },
      { word: "bouwwerken", stem: "bouwwerk" },
    ]);
    // Short words keep no stem ("huis" must not find "huidige"); "foto's" is "foto".
    expect(zoektermWords("huis geen bomen plannen foto's")).toEqual([
      { word: "huis", stem: undefined },
      { word: "geen", stem: undefined },
      { word: "bomen", stem: undefined },
      { word: "plannen", stem: undefined },
      { word: "foto", stem: undefined },
    ]);
    expect(selectDsoText(doc, { zoekterm: "dakkapellen zonnepanelen", maxChars: 10_000 }).matches).toBe(0);
  });

  it("zoekterm ignores soft hyphens and zero-width spaces in the text", () => {
    expect(foldText("omgevings\u00ADvergunning en fijn\u200Bstof")).toBe("omgevingsvergunning en fijnstof");
  });

  it("zoekterm lists the regels before the toelichting, wherever the toelichting stands", () => {
    const components = plan();
    components[1].volgordeNummer = -1; // the toelichting first in the document
    const doc = buildDsoDocument(components);
    const hits = selectDsoText(doc, { zoekterm: "dakkapel achterkant", maxChars: 10_000 });
    expect(hits.parts.map((p) => p.eId)).toEqual(["chp_3__art_3.1", "recital__div_1"]);
  });

  it("zoekterm names the hits that do not fit in max_tekens at all, in their order", () => {
    const doc = buildDsoDocument(plan());
    const hits = selectDsoText(doc, { zoekterm: "dakkapel", maxChars: 150 });
    expect(hits.truncated).toBe(true);
    // The begrip fits; Artikel 3.1 does not even in short, and nothing after it skips the queue.
    expect(hits.parts.map((p) => p.eId)).toEqual(["chp_1__art_1.1__item_1"]);
    expect(hits.omitted).toEqual([
      { title: "Artikel 3.1 Dakkapel aan de achterkant", eId: "chp_3__art_3.1" },
      { title: "Toelichting bij Artikel 3.1 Dakkapel aan de achterkant", eId: "recital__div_1" },
    ]);
    expect(hits.parts.reduce((n, p) => n + p.tekst.length, 0)).toBeLessThanOrEqual(150);
  });

  it("onderdeel finds a part by label, abbreviation, lid and eId, the regels before the toelichting", () => {
    const doc = buildDsoDocument(plan());
    expect(findOnderdeel(doc, "Artikel 3.1").map((s) => s.eId)).toEqual(["chp_3__art_3.1"]);
    expect(findOnderdeel(doc, "art. 3.1 lid 2").map((s) => s.eId)).toEqual(["chp_3__art_3.1__para_2"]);
    expect(findOnderdeel(doc, "hoofdstuk 3").map((s) => s.eId)).toEqual(["chp_3"]);
    expect(findOnderdeel(doc, "recital__div_1").map((s) => s.type)).toEqual(["DIVISIETEKST"]);

    const lid = selectDsoText(doc, { onderdeel: "artikel 3.1 lid 2", maxChars: 10_000 });
    expect(lid.parts[0].title).toBe("Artikel 3.1 lid 2");
    expect(lid.parts[0].tekst).toBe("2. Het eerste lid geldt niet in een beschermd stadsgezicht.");

    const hoofdstuk = selectDsoText(doc, { onderdeel: "Hoofdstuk 3", maxChars: 10_000 });
    expect(hoofdstuk.parts[0].tekst).toContain("Artikel 3.2 Geïntegreerde zonnepanelen");
    expect(hoofdstuk.parts[0].tekst).not.toContain("Toelichting");

    const missing = selectDsoText(doc, { onderdeel: "Artikel 9.9", maxChars: 10_000 });
    expect(missing.parts).toEqual([]);
    expect(missing.notFound?.suggestions).toEqual(["Artikel 1.1", "Artikel 3.1", "Artikel 3.2"]);
  });

  it("onderdeel reads the Dutch ways to cite a lid", () => {
    const doc = buildDsoDocument(plan());
    for (const onderdeel of ["artikel 3.1, tweede lid", "Artikel 3.1 tweede lid", "art. 3.1, 2e lid", "lid 2 van artikel 3.1", "tweede lid van artikel 3.1", "Artikel 3.1, lid 2."]) {
      expect(findOnderdeel(doc, onderdeel).map((s) => s.eId), onderdeel).toEqual(["chp_3__art_3.1__para_2"]);
    }
    expect(splitLid("lid 2")).toEqual({ label: "lid 2" });
    expect(splitLid("Artikel 4.24")).toEqual({ label: "Artikel 4.24" });
  });

  it("onderdeel names what is missing: an artikel without numbered leden, or a lid it does not have", () => {
    const doc = buildDsoDocument(plan());
    const noLeden = selectDsoText(doc, { onderdeel: "Artikel 3.2 lid 1", maxChars: 10_000 });
    expect(noLeden.notFound).toEqual({ reason: "Artikel 3.2 bestaat, maar heeft geen genummerde leden.", suggestions: ["Artikel 3.2"] });
    const noLid = selectDsoText(doc, { onderdeel: "artikel 3.1, vijfde lid", maxChars: 10_000 });
    expect(noLid.notFound).toEqual({ reason: "Artikel 3.1 heeft geen lid 5; wel de leden 1, 2.", suggestions: ["Artikel 3.1 lid 1", "Artikel 3.1 lid 2"] });
  });

  it("onderdeel takes a table-of-contents line as it is, and its eId round-trips", () => {
    const doc = buildDsoDocument(plan());
    const toc = tableOfContents(doc, 10_000).text.split("\n");
    for (const line of toc) {
      const eId = /\[([^\]]+)\]$/.exec(line)?.[1] as string;
      expect(findOnderdeel(doc, eId)[0]?.eId, line).toBe(eId);
      expect(findOnderdeel(doc, line.trim())[0]?.eId, line).toBe(eId);
    }
  });

  it("suggests the nearest labels of the same hoofdstuk for one that does not exist", () => {
    const components = plan();
    const hoofdstuk3 = components[0]._embedded!.documentComponenten![2];
    hoofdstuk3._embedded!.documentComponenten!.push(
      ...[3, 4, 5, 6, 7, 8, 30, 31].map((n, i) => ({ identificatie: `x_${n}`, expressie: `chp_3__art_3.${n}`, type: "ARTIKEL", volgordeNummer: 10 + i, kop: kop("Artikel", `3.${n}`), inhoud: inhoud("<Al>x</Al>") })),
    );
    const doc = buildDsoDocument(components);
    expect(nearbyLabels(doc, "Artikel 3.29")).toEqual(["Artikel 3.6", "Artikel 3.7", "Artikel 3.8", "Artikel 3.30", "Artikel 3.31"]);
    expect(nearbyLabels(doc, "Artikel 3.29 lid 2")).toEqual(nearbyLabels(doc, "Artikel 3.29"));
  });

  it("parses an onderdeel in linear time, however it is padded", () => {
    // The old /^(.*?)[,\s]+lid…/ took ~640 ms on 40,000 commas.
    const doc = buildDsoDocument(plan());
    const started = performance.now();
    findOnderdeel(doc, `${",".repeat(40_000)}x`);
    findOnderdeel(doc, `${", ".repeat(20_000)}lid 2`);
    nearbyLabels(doc, `${",".repeat(40_000)}x`);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("returns the beginning and a table of contents when the document is too long", () => {
    const doc = buildDsoDocument(plan());
    const out = selectDsoText(doc, { maxChars: 500 });
    expect(out.mode).toBe("begin_met_inhoudsopgave");
    expect(out.truncated).toBe(true);
    expect(out.parts[0].tekst.startsWith("Hoofdstuk 1 Algemene bepalingen")).toBe(true);
    expect(out.parts[0].tekst.length + (out.inhoudsopgave?.length ?? 0)).toBeLessThanOrEqual(500);
    expect(out.parts[0].tekst.endsWith("[…]")).toBe(true);
    expect(out.inhoudsopgave).toContain("Hoofdstuk 3 Bouwen [chp_3]");
    expect(out.inhoudsopgave).toContain("Hoofdstuk 2 [gereserveerd] [chp_2]");
  });

  it("drops the finer levels of the table of contents until it fits", () => {
    const doc = buildDsoDocument(plan());
    const full = tableOfContents(doc, 10_000);
    expect(full.level).toBe("artikelen");
    expect(full.text).toContain("  Artikel 3.1 Dakkapel aan de achterkant [chp_3__art_3.1]");
    const coarse = tableOfContents(doc, 120);
    expect(coarse.level).toBe("hoofdstukken en bijlagen");
    expect(coarse.text).not.toContain("Artikel");
  });
});

/* ------------------------------------------------------------------ */
/*  An ontwerp: real DSO data, trimmed                                 */
/* ------------------------------------------------------------------ */

// GET …/ontwerpregelingen/_akn_nl_act_pv26_2022_omgevingsverordening_akn_nl_bill_pv26_2025_3_1091/documentstructuur
// (6 Oct 2026), cut down to Artikel 2.4 lid 4, both copies of Artikel 2.12 and Artikel 3.4, without the
// <?xml?> declarations and namespaces: ontwerpDocumentComponenten at every level, renvooi in kop and
// inhoud, and components with wijzigactie voegtoe, verwijder and verwijderContainer.
const ONTWERP_PV26: DsoDocumentComponent[] = [
  {
    identificatie: "body", expressie: "body", type: "LICHAAM", volgordeNummer: 0, bevatRenvooi: false,
    _embedded: { ontwerpDocumentComponenten: [
      {
        identificatie: "pv26_1068__chp_2", expressie: "chp_2", type: "HOOFDSTUK", volgordeNummer: 1, bevatRenvooi: false, kop: "<Kop><Label>Hoofdstuk</Label><Nummer>2</Nummer><Opschrift>Watersysteem</Opschrift></Kop>",
        _embedded: { ontwerpDocumentComponenten: [
          {
            identificatie: "pv26_1068__chp_2__subchp_2.1", expressie: "chp_2__subchp_2.1", type: "AFDELING", volgordeNummer: 0, bevatRenvooi: false, kop: "<Kop><Label>Afdeling</Label><Nummer>2.1</Nummer><Opschrift>Omgevingswaarden en monitoring regionale waterkering en wateroverlast</Opschrift></Kop>",
            _embedded: { ontwerpDocumentComponenten: [
              {
                identificatie: "pv26_1068__chp_2__subchp_2.1__subsec_2.1.2", expressie: "chp_2__subchp_2.1__subsec_2.1.2", type: "PARAGRAAF", volgordeNummer: 1, bevatRenvooi: false, kop: "<Kop><Label>Paragraaf</Label><Nummer>2.1.2</Nummer><Opschrift>Omgevingswaarde regionale waterkering en wateroverlast</Opschrift></Kop>",
                _embedded: { ontwerpDocumentComponenten: [
                  {
                    identificatie: "pv26_1068__chp_2__subchp_2.1__subsec_2.1.2__art_2.4", expressie: "chp_2__subchp_2.1__subsec_2.1.2__art_2.4", type: "ARTIKEL", volgordeNummer: 2, bevatRenvooi: false, kop: "<Kop><Label>Artikel</Label><Nummer>2.4</Nummer><Opschrift>Omgevingswaarde wateroverlast binnen de bebouwde kom Hoogheemraadschap De Stichtse Rijnlanden</Opschrift></Kop>",
                    _embedded: { ontwerpDocumentComponenten: [
                      { identificatie: "pv26_1068__chp_2__subchp_2.1__subsec_2.1.2__art_2.4__para_4", expressie: "chp_2__subchp_2.1__subsec_2.1.2__art_2.4__para_4", type: "LID", volgordeNummer: 3, bevatRenvooi: true, kop: "<Kop><Nummer>4.</Nummer></Kop>", inhoud: "<Inhoud><Al>Deze <VerwijderdeTekst>omgevingswaarde is</VerwijderdeTekst><NieuweTekst>omgevingswaarden zijn</NieuweTekst> een inspanningsverplichting.</Al></Inhoud>" },
                    ] },
                  },
                ] },
              },
              {
                identificatie: "pv26_1068__chp_2__subchp_2.1__subsec_2.1.3", expressie: "chp_2__subchp_2.1__subsec_2.1.3", type: "PARAGRAAF", volgordeNummer: 2, bevatRenvooi: false, kop: "<Kop><Label>Paragraaf</Label><Nummer>2.1.3</Nummer><Opschrift>Monitoring regionale waterkering en wateroverlast</Opschrift></Kop>",
                _embedded: { ontwerpDocumentComponenten: [
                  {
                    identificatie: "pv26_1091__chp_2__subchp_2.1__subsec_2.1.3__art_2.12", expressie: "chp_2__subchp_2.1__subsec_2.1.3__art_2.12", type: "ARTIKEL", volgordeNummer: 0, wijzigactie: "voegtoe", bevatRenvooi: true, kop: "<Kop><Label>Artikel</Label><Nummer>2.12</Nummer><Opschrift>Instructieregel monitoring omgevingswaarde regionale waterkering</Opschrift></Kop>",
                    _embedded: { ontwerpDocumentComponenten: [
                      { identificatie: "pv26_1091__chp_2__subchp_2.1__subsec_2.1.3__art_2.12__para_1", expressie: "chp_2__subchp_2.1__subsec_2.1.3__art_2.12__para_1", type: "LID", volgordeNummer: 0, bevatRenvooi: false, kop: "<Kop><Nummer>1.</Nummer></Kop>", inhoud: "<Inhoud><Al>Het waterschap is belast met de uitvoering van de monitoring voor de omgevingswaarden, bedoeld in <IntRef ref=\"chp_2__subchp_2.1__subsec_2.1.2__art_2.2\">Artikel 2.2</IntRef> en <IntRef ref=\"chp_2__subchp_2.1__subsec_2.1.2__art_2.3\">Artikel 2.3</IntRef>.</Al></Inhoud>" },
                    ] },
                  },
                  { identificatie: "pv26_1068__chp_2__subchp_2.1__subsec_2.1.3__art_2.12", expressie: "chp_2__subchp_2.1__subsec_2.1.3__art_2.12_inst2", type: "ARTIKEL", volgordeNummer: 1, wijzigactie: "verwijder", bevatRenvooi: true, kop: "<Kop><Label>Artikel</Label><Nummer>2.12</Nummer><Opschrift>Instructieregel monitoring omgevingswaarde regionale kering</Opschrift></Kop>", inhoud: "<Inhoud><Al>Het waterschap is belast met de uitvoering van de monitoring voor de omgevingswaarden, bedoeld in <IntRef ref=\"chp_2__subchp_2.1__subsec_2.1.2__art_2.2\">Artikel 2.2</IntRef> en <IntRef ref=\"chp_2__subchp_2.1__subsec_2.1.2__art_2.3\">Artikel 2.3</IntRef>.</Al></Inhoud>" },
                ] },
              },
            ] },
          },
        ] },
      },
      {
        identificatie: "pv26_1068__chp_3", expressie: "chp_3", type: "HOOFDSTUK", volgordeNummer: 2, bevatRenvooi: false, kop: "<Kop><Label>Hoofdstuk</Label><Nummer>3</Nummer><Opschrift>Ondergrond en bodem</Opschrift></Kop>",
        _embedded: { ontwerpDocumentComponenten: [
          {
            identificatie: "pv26_1068__chp_3__subchp_3.1", expressie: "chp_3__subchp_3.1", type: "AFDELING", volgordeNummer: 0, bevatRenvooi: false, kop: "<Kop><Label>Afdeling</Label><Nummer>3.1</Nummer><Opschrift>Grondwaterbeheer</Opschrift></Kop>",
            _embedded: { ontwerpDocumentComponenten: [
              {
                identificatie: "pv26_1068__chp_3__subchp_3.1__subsec_3.1.3", expressie: "chp_3__subchp_3.1__subsec_3.1.3", type: "PARAGRAAF", volgordeNummer: 2, bevatRenvooi: false, kop: "<Kop><Label>Paragraaf</Label><Nummer>3.1.3</Nummer><Opschrift>Activiteiten met grondwater</Opschrift></Kop>",
                _embedded: { ontwerpDocumentComponenten: [
                  {
                    identificatie: "pv26_1068__chp_3__subchp_3.1__subsec_3.1.3__art_3.4", expressie: "chp_3__subchp_3.1__subsec_3.1.3__art_3.4", type: "ARTIKEL", volgordeNummer: 0, bevatRenvooi: false, kop: "<Kop><Label>Artikel</Label><Nummer>3.4</Nummer><Opschrift>Vrijstelling vergunningplicht bij klein open bodemenergiesysteem</Opschrift></Kop>",
                    _embedded: { ontwerpDocumentComponenten: [
                      { identificatie: "pv26_1068__chp_3__subchp_3.1__subsec_3.1.3__art_3.4__para_1", expressie: "chp_3__subchp_3.1__subsec_3.1.3__art_3.4__para_1", type: "LID", volgordeNummer: 0, wijzigactie: "verwijderContainer", bevatRenvooi: true, kop: "<Kop><Nummer><VerwijderdeTekst>1.</VerwijderdeTekst></Nummer></Kop>", inhoud: "<Inhoud><Al wijzigactie=\"verwijder\">Het verbod in <ExtRef soort=\"URL\" ref=\"https://wetten.overheid.nl/BWBR0041330/2024-01-01#Hoofdstuk3_Afdeling3.2_Paragraaf3.2.6_Artikel3.19\">artikel 3.19</ExtRef> van het Besluit activiteiten leefomgeving om zonder een omgevingsvergunning een open bodemenergiesysteem aan te leggen of te gebruiken geldt niet in het <IntIoRef ref=\"pv26_1068__cmp_2__content_o_1__list_o_1__item_o_47__ref_o_1\" wId=\"pv26_1068__chp_3__subchp_3.1__subsec_3.1.3__art_3.4__para_1__ref_2_inst2\" eId=\"chp_3__subchp_3.1__subsec_3.1.3__art_3.4__para_1__ref_2_inst2\">Gebied klein open bodemenergiesysteem</IntIoRef>, als de hoeveelheid grondwater die wordt onttrokken niet meer bedraagt dan 10 m3/u.</Al><Al wijzigactie=\"voegtoe\">[Vervallen per &lt;datum&gt;]</Al></Inhoud>" },
                      { identificatie: "pv26_1068__chp_3__subchp_3.1__subsec_3.1.3__art_3.4__para_2", expressie: "chp_3__subchp_3.1__subsec_3.1.3__art_3.4__para_2_inst2", type: "LID", volgordeNummer: 1, wijzigactie: "verwijder", bevatRenvooi: true, kop: "<Kop><Nummer>2.</Nummer></Kop>", inhoud: "<Inhoud><Al>Het eerste lid geldt niet voor het aanleggen of gebruiken van een open bodemenergiesysteem dat gelegen is in een interferentiegebied dat is opgenomen in een omgevingsplan.</Al></Inhoud>" },
                    ] },
                  },
                ] },
              },
            ] },
          },
        ] },
      },
    ] },
  },
];

const ONTWERP_MONTFOORT: DsoDocumentComponent[] = [
  {
    identificatie: "body", expressie: "body", type: "LICHAAM", volgordeNummer: 0, bevatRenvooi: false,
    _embedded: { ontwerpDocumentComponenten: [
      {
        identificatie: "gm0335_1-0__chp_20", expressie: "chp_20", type: "HOOFDSTUK", volgordeNummer: 19, bevatRenvooi: true, gereserveerd: "<gereserveerd wijzigactie='verwijder'/>", kop: "<Kop><Label>HOOFDSTUK</Label><Nummer>20</Nummer><Opschrift wijzigactie=\"voegtoe\">PROJECTGEBONDEN REGELS</Opschrift></Kop>",
        _embedded: { ontwerpDocumentComponenten: [
          { identificatie: "gm0335_d65cc8afd5fe46d7a39da3d9fef14c14__chp_20__title_20.1", expressie: "chp_20__title_20.1", type: "TITEL", volgordeNummer: 0, wijzigactie: "voegtoe", bevatRenvooi: true, gereserveerd: "<gereserveerd/>", kop: "<Kop><Label>Titel</Label><Nummer>20.1</Nummer><Opschrift>Titel</Opschrift></Kop>" },
        ] },
      },
      { identificatie: "gm0335_1-0__chp_23", expressie: "chp_23", type: "HOOFDSTUK", volgordeNummer: 22, bevatRenvooi: true, kop: "<Kop><Label>HOOFDSTUK</Label><Nummer>\n                        <VerwijderdeTekst>24</VerwijderdeTekst>\n                        <NieuweTekst>23</NieuweTekst>\n                     </Nummer><Opschrift>SLOTBEPALINGEN</Opschrift></Kop>" },
    ] },
  },
];

describe("DSO ontwerp structure", () => {
  it("reads ontwerpDocumentComponenten and renders the regeling as the ontwerp would make it", () => {
    const doc = buildDsoDocument(ONTWERP_PV26);
    expect(doc.renvooi).toBe(true);
    expect(renderSections(doc, 0, doc.sections.length).split("\n")).toEqual([
      "Hoofdstuk 2 Watersysteem",
      "",
      "Afdeling 2.1 Omgevingswaarden en monitoring regionale waterkering en wateroverlast",
      "",
      "Paragraaf 2.1.2 Omgevingswaarde regionale waterkering en wateroverlast",
      "",
      "Artikel 2.4 Omgevingswaarde wateroverlast binnen de bebouwde kom Hoogheemraadschap De Stichtse Rijnlanden",
      // <VerwijderdeTekst>omgevingswaarde is</VerwijderdeTekst><NieuweTekst>omgevingswaarden zijn</NieuweTekst>
      "4. Deze omgevingswaarden zijn een inspanningsverplichting.",
      "",
      "Paragraaf 2.1.3 Monitoring regionale waterkering en wateroverlast",
      "",
      // The added Artikel 2.12; the deleted one (wijzigactie verwijder, "regionale kering") is gone.
      "Artikel 2.12 Instructieregel monitoring omgevingswaarde regionale waterkering",
      "1. Het waterschap is belast met de uitvoering van de monitoring voor de omgevingswaarden, bedoeld in Artikel 2.2 en Artikel 2.3.",
      "",
      "Hoofdstuk 3 Ondergrond en bodem",
      "",
      "Afdeling 3.1 Grondwaterbeheer",
      "",
      "Paragraaf 3.1.3 Activiteiten met grondwater",
      "",
      // Lid 1 loses its container and its old text but keeps the added sentence; lid 2 is deleted.
      "Artikel 3.4 Vrijstelling vergunningplicht bij klein open bodemenergiesysteem",
      "[Vervallen per <datum>]",
    ]);
    expect(doc.sections.some((s) => s.eId.endsWith("_inst2"))).toBe(false);
  });

  it("finds the new wording with zoekterm and onderdeel, and not the deleted wording", () => {
    const doc = buildDsoDocument(ONTWERP_PV26);
    expect(selectDsoText(doc, { zoekterm: "omgevingswaarden zijn", maxChars: 10_000 }).parts.map((p) => p.eId)).toEqual(["chp_2__subchp_2.1__subsec_2.1.2__art_2.4"]);
    // Only in the deleted <Al> of Artikel 3.4 lid 1 and in the deleted lid 2.
    expect(selectDsoText(doc, { zoekterm: "onttrokken", maxChars: 10_000 }).matches).toBe(0);
    expect(selectDsoText(doc, { zoekterm: "interferentiegebied", maxChars: 10_000 }).matches).toBe(0);
    expect(selectDsoText(doc, { onderdeel: "artikel 2.4, vierde lid", maxChars: 10_000 }).parts[0].tekst).toBe("4. Deze omgevingswaarden zijn een inspanningsverplichting.");
    expect(findOnderdeel(doc, "Artikel 2.12").map((s) => s.eId)).toEqual(["chp_2__subchp_2.1__subsec_2.1.3__art_2.12"]);
    expect(tableOfContents(doc, 10_000).text).toContain("Artikel 2.12 Instructieregel monitoring omgevingswaarde regionale waterkering [chp_2__subchp_2.1__subsec_2.1.3__art_2.12]");
  });

  it("reads gereserveerd as an ontwerp gives it, and renvooi in a kop", () => {
    // Omgevingsplan gemeente Montfoort, ontwerp of 25 Sep 2026: hoofdstuk 20 is no longer gereserveerd
    // (<gereserveerd wijzigactie='verwijder'/>), its new titel 20.1 is (<gereserveerd/>); hoofdstuk 24 becomes 23.
    const doc = buildDsoDocument(ONTWERP_MONTFOORT);
    expect(renderSections(doc, 0, doc.sections.length).split("\n")).toEqual([
      "HOOFDSTUK 20 PROJECTGEBONDEN REGELS",
      "",
      "Titel 20.1 Titel [gereserveerd]",
      "",
      "HOOFDSTUK 23 SLOTBEPALINGEN",
    ]);
    expect(tableOfContents(doc, 10_000).text).toContain("  Titel 20.1 Titel [gereserveerd] [chp_20__title_20.1]");
  });

  it("lists the divisies of a programma in the table of contents", () => {
    const divisie = (eId: string, nummer: string, opschrift: string, children: DsoDocumentComponent[] = []): DsoDocumentComponent => ({
      identificatie: `pv26_x__${eId}`, expressie: eId, type: "DIVISIE", kop: kop("Hoofdstuk", nummer, opschrift), _embedded: { ontwerpDocumentComponenten: children },
    });
    const tekst = (eId: string, opschrift: string): DsoDocumentComponent => ({ identificatie: `pv26_x__${eId}`, expressie: eId, type: "DIVISIETEKST", kop: kop("", "", opschrift), inhoud: inhoud("<Al>tekst</Al>") });
    // Divisie 3 as the provincie Utrecht's Programma Wonen en Werken has it: the whole heading in <Label>.
    const thema: DsoDocumentComponent = { identificatie: "pv26_x__div_3", expressie: "div_3", type: "DIVISIE", kop: "<Kop><Label>Hoofdstuk 3 Thema Wonen</Label></Kop>" };
    const doc = buildDsoDocument([
      { identificatie: "body", expressie: "body", type: "LICHAAM", _embedded: { ontwerpDocumentComponenten: [divisie("div_1", "1", "Inleiding", [tekst("div_1__content_1", "Aanleiding")]), divisie("div_2", "2", "Wonen"), thema] } },
    ]);
    expect(tableOfContents(doc, 10_000).text.split("\n")).toEqual([
      "Hoofdstuk 1 Inleiding [div_1]",
      "  Aanleiding [div_1__content_1]",
      "Hoofdstuk 2 Wonen [div_2]",
      "Hoofdstuk 3 Thema Wonen [div_3]",
    ]);
    expect(findOnderdeel(doc, "div_1__content_1")[0].heading).toBe("Aanleiding");
    expect(findOnderdeel(doc, "hoofdstuk 3").map((s) => s.eId)).toEqual(["div_3"]);
    expect(findOnderdeel(doc, "Hoofdstuk 2").map((s) => s.eId)).toEqual(["div_2"]);
  });
});

/* ------------------------------------------------------------------ */
/*  Fitting hits into max_tekens, tijdelijke delen                     */
/* ------------------------------------------------------------------ */

const filler = (n: number) => Array.from({ length: n }, (_, i) => `woord${i}`).join(" ");
const li = (nummer: string, body: string) => `<Li><LiNummer>${nummer}</LiNummer><Al>${body}</Al></Li>`;

/** An article shaped like Bbl artikel 2.29: a long list, the dakkapel only in item d with its eisen. */
function besluit(): DsoDocumentComponent[] {
  const lijst = ["a", "b", "c", "e", "f"].map((n) => li(`${n}.`, `een bouwwerk van soort ${n}: ${filler(40)};`));
  lijst.splice(3, 0, `<Li><LiNummer>d.</LiNummer><Al>een dakkapel in het achterdakvlak, als wordt voldaan aan de volgende eisen:</Al><Lijst>${li("1°.", "voorzien van een plat dak;")}${li("2°.", "niet hoger dan 1,75 m.")}</Lijst></Li>`);
  return [
    // The toelichting first in the document: it still comes last.
    {
      identificatie: "recital", expressie: "recital", type: "TOELICHTING", volgordeNummer: -1, kop: kop("", "", "Toelichting"),
      _embedded: { documentComponenten: [{ identificatie: "x__div", expressie: "recital__div_1", type: "DIVISIETEKST", kop: kop("", "", "Artikel 2.29 Vergunningvrije bouwwerken"), inhoud: inhoud("<Al>Een dakkapel aan de achterkant is vergunningvrij.</Al>") }] },
    },
    {
      identificatie: "body", expressie: "body", type: "LICHAAM", volgordeNummer: 0,
      _embedded: {
        documentComponenten: [
          { identificatie: "x__art_2.28", expressie: "chp_2__art_2.28", type: "ARTIKEL", volgordeNummer: 0, kop: kop("Artikel", "2.28", "Toepassingsbereik"), inhoud: inhoud("<Al>Deze paragraaf gaat ook over een dakkapel.</Al>") },
          { identificatie: "x__art_2.29", expressie: "chp_2__art_2.29", type: "ARTIKEL", volgordeNummer: 1, kop: kop("Artikel", "2.29", "Vergunningvrije bouwwerken"), inhoud: inhoud(`<Al>Het verbod geldt niet voor de volgende bouwwerken:</Al><Lijst>${lijst.join("")}</Lijst>`) },
          { identificatie: "x__art_5.20", expressie: "chp_5__art_5.20", type: "ARTIKEL", volgordeNummer: 2, kop: kop("Artikel", "5.20", "Energiezuinigheid"), inhoud: inhoud("<Al>Bij het vernieuwen van een dakkapel gelden andere eisen.</Al>") },
        ],
      },
    },
    {
      identificatie: "bijlage", expressie: "cmp_I", type: "BIJLAGE", volgordeNummer: 1, kop: kop("Bijlage", "I", "Tabellen"),
      _embedded: { documentComponenten: [{ identificatie: "x__cmp_I__content_1", expressie: "cmp_I__content_1", type: "DIVISIETEKST", kop: kop("", "", "Tabel dakkapel"), inhoud: inhoud("<Al>Maten van een dakkapel.</Al>") }] },
    },
  ];
}

describe("DSO zoekterm within max_tekens", () => {
  it("ranks the regels before bijlagen and toelichting, and gives a hit too long for max_tekens its passages with what introduces them", () => {
    const doc = buildDsoDocument(besluit());
    const full = selectDsoText(doc, { onderdeel: "Artikel 2.29", maxChars: 40_000 }).parts[0].tekst;
    const hits = selectDsoText(doc, { zoekterm: "dakkapel", maxChars: 1_500 });
    expect(full.length).toBeGreaterThan(1_500);
    expect(hits.parts.map((p) => p.eId)).toEqual(["chp_2__art_2.28", "chp_2__art_2.29", "chp_5__art_5.20", "cmp_I__content_1", "recital__div_1"]);
    // Before: Artikel 2.29 left out (only named) while the shorter hits after it went in.
    expect(hits.parts[1]).toMatchObject({ title: "Artikel 2.29 Vergunningvrije bouwwerken", tekensVolledig: full.length });
    expect(hits.parts[1].tekst.split("\n")).toEqual([
      "Artikel 2.29 Vergunningvrije bouwwerken",
      "Het verbod geldt niet voor de volgende bouwwerken:",
      "[…]",
      "d. een dakkapel in het achterdakvlak, als wordt voldaan aan de volgende eisen:",
      "   1°. voorzien van een plat dak;",
      "   2°. niet hoger dan 1,75 m.",
      "[…]",
    ]);
    expect(hits.shortened).toEqual([{ title: "Artikel 2.29 Vergunningvrije bouwwerken", eId: "chp_2__art_2.29", chars: full.length }]);
    expect(hits.omitted).toEqual([]);
    expect(hits.truncated).toBe(true);
    expect(hits.parts.reduce((n, p) => n + p.tekst.length, 0)).toBeLessThanOrEqual(1_500);
    // With room, the whole artikel.
    const roomy = selectDsoText(doc, { zoekterm: "dakkapel", maxChars: 12_000 });
    expect(roomy.parts[1].tekst).toBe(full);
    expect(roomy.parts[1].tekensVolledig).toBeUndefined();
    expect(roomy.shortened).toEqual([]);
  });

  it("gives every hit that fits at least its heading and the passage with the term, the rest named in order", () => {
    const artikelen = Array.from({ length: 30 }, (_, i): DsoDocumentComponent => ({
      identificatie: `x__art_${i + 1}`,
      expressie: `art_${i + 1}`,
      type: "ARTIKEL",
      volgordeNummer: i,
      kop: kop("Artikel", String(i + 1), `Onderwerp ${i + 1}`),
      inhoud: inhoud(`<Al>${filler(60)} een erker aan de voorkant ${filler(60)}</Al>`),
    }));
    const doc = buildDsoDocument([{ identificatie: "body", expressie: "body", type: "LICHAAM", _embedded: { documentComponenten: artikelen } }]);
    const hits = selectDsoText(doc, { zoekterm: "erker", maxChars: 4_000 });
    expect(hits.matches).toBe(30);
    expect(hits.parts.length).toBeGreaterThan(5);
    for (const part of hits.parts) {
      expect(part.tekst.split("\n")[0]).toBe(part.title);
      expect(part.tekst).toContain("een erker aan de voorkant");
    }
    expect(hits.parts.reduce((n, p) => n + p.tekst.length, 0)).toBeLessThanOrEqual(4_000);
    const listed = [...hits.parts.map((p) => p.eId), ...(hits.omitted ?? []).map((o) => o.eId)];
    expect(listed).toEqual(artikelen.slice(0, listed.length).map((a) => a.expressie));
  });

  it("also searches the tijdelijke delen: after the document's own regels, before its toelichting", () => {
    const voorbescherming = buildDsoDocument([
      {
        identificatie: "body",
        expressie: "body",
        type: "LICHAAM",
        conditieArtikel: { kop: kop("", "", "Voorrangsregel"), inhoud: inhoud("<Al>Waar deze regels afwijken van het omgevingsplan, gelden alleen deze regels.</Al>") },
        _embedded: {
          documentComponenten: [
            { identificatie: "gm9999_v__art_1.3", expressie: "chp_1__art_1.3", type: "ARTIKEL", kop: kop("Artikel", "1.3", "Omgevingsvergunning"), inhoud: inhoud("<Al>Het is verboden zonder omgevingsvergunning een dakkapel in het achterdakvlak te plaatsen.</Al>") },
          ],
        },
      },
      {
        identificatie: "gm9999_v__recital",
        expressie: "artrecital",
        type: "ARTIKELGEWIJZE_TOELICHTING",
        kop: kop("", "", "Artikelsgewijze toelichting"),
        _embedded: { documentComponenten: [{ identificatie: "gm9999_v__t1", expressie: "artrecital__content_1", type: "DIVISIETEKST", kop: kop("", "", "Artikel 1.3"), inhoud: inhoud("<Al>De dakkapel wordt getoetst.</Al>") }] },
      },
    ]);
    const hits = selectDsoText(buildDsoDocument(plan()), { zoekterm: "dakkapel", maxChars: 10_000, tijdelijkeDelen: [voorbescherming] });
    expect(hits.parts.map((p) => [p.eId, p.tijdelijkDeel])).toEqual([
      ["chp_1__art_1.1__item_1", undefined],
      ["chp_3__art_3.1", undefined],
      ["chp_1__art_1.3", 0],
      ["recital__div_1", undefined],
      ["artrecital__content_1", 0],
    ]);
    expect(hits.parts[4].title).toBe("Toelichting bij Artikel 1.3");
    expect(hits).toMatchObject({ matches: 5, matchesTijdelijk: 2 });
  });
});

/* ------------------------------------------------------------------ */
/*  An ontwerp's changes (weergave "wijzigingen")                      */
/* ------------------------------------------------------------------ */

const io = (work: string, version: string) => `<ExtIoRef ref="/join/id/regdata/gm9999/2026/${work}/nld@${version}">/join/id/regdata/gm9999/2026/${work}/nld@${version}</ExtIoRef>`;
const gio = (id: string, volgordeNummer: number, term: string, definitie: string, wijzigactie?: string): DsoDocumentComponent => ({
  identificatie: `gm9999_x__${id}`,
  expressie: id,
  type: "BEGRIP",
  volgordeNummer,
  bevatRenvooi: true,
  ...(wijzigactie ? { wijzigactie } : {}),
  inhoud: `<Begrip${wijzigactie ? ` wijzigactie="${wijzigactie}"` : ""} wId="gm9999_x__${id}"><Term>${term}</Term><Definitie>${definitie}</Definitie></Begrip>`,
});
const lid = (id: string, volgordeNummer: number, nummer: string, tekst: string, extra: Partial<DsoDocumentComponent> = {}): DsoDocumentComponent => ({
  identificatie: `gm9999_x__${id}`,
  expressie: id,
  type: "LID",
  volgordeNummer,
  kop: `<Kop><Nummer>${nummer}</Nummer></Kop>`,
  inhoud: `<Inhoud><Al>${tekst}</Al></Inhoud>`,
  ...extra,
});
const renummer = (oud: string, nieuw: string, opschrift: string) =>
  `<Kop><Label>Artikel</Label><Nummer><VerwijderdeTekst>${oud}</VerwijderdeTekst><NieuweTekst>${nieuw}</NieuweTekst></Nummer><Opschrift>${opschrift}</Opschrift></Kop>`;

/** An ontwerp of a fictional omgevingsplan, with the kinds of renvooi the DSO delivers. */
function ontwerpWijzigingen(): DsoDocumentComponent[] {
  const begrippen = [
    // A new version of the same informatieobject.
    gio("cmp_II__item_1", 0, "VERKEER H21", `<Al wijzigactie="verwijder">${io("aaa", "2026-07-24;1")}</Al><Al wijzigactie="voegtoe">${io("aaa", "2026-09-11;2")}</Al>`),
    // Removed here, added again further down: the list is reordered.
    gio("cmp_II__item_2_inst2", 1, "WONEN H21", `<Al>${io("bbb", "2026-07-24;1")}</Al>`, "verwijder"),
    gio("cmp_II__item_2", 2, "PARKEERKELDER H21", `<Al>${io("ccc", "2026-09-11;1")}</Al>`, "voegtoe"),
    gio("cmp_II__item_3", 3, "WONEN H21", `<Al>${io("bbb", "2026-09-11;2")}</Al>`, "voegtoe"),
  ];
  const artikelen: DsoDocumentComponent[] = [
    {
      identificatie: "gm9999_x__art_21.15",
      expressie: "chp_21__art_21.15",
      type: "ARTIKEL",
      volgordeNummer: 0,
      bevatRenvooi: true,
      kop: "<Kop><Label>Artikel</Label><Nummer>21.15</Nummer><Opschrift>Verkeer</Opschrift></Kop>",
      inhoud:
        `<Inhoud><Al>In het gebied X worden gronden gebruikt voor:</Al><Lijst>${li("a.", "wegen;")}<Li wijzigactie="voegtoe"><LiNummer>b.</LiNummer><Al>speelvoorzieningen;</Al></Li>` +
        `<Li><LiNummer><VerwijderdeTekst>b</VerwijderdeTekst><NieuweTekst>c</NieuweTekst>.</LiNummer><Al>terrassen.</Al></Li></Lijst></Inhoud>`,
    },
    { identificatie: "gm9999_y__art_21.29", expressie: "chp_21__art_21.29", type: "ARTIKEL", volgordeNummer: 1, wijzigactie: "voegtoe", bevatRenvooi: true, kop: "<Kop><Label>Artikel</Label><Nummer>21.29</Nummer><Opschrift>Parkeerkelder</Opschrift></Kop>", inhoud: "<Inhoud><Al>In het gebied PARKEERKELDER H21 is parkeren toegestaan.</Al></Inhoud>" },
    { identificatie: "gm9999_x__art_21.29", expressie: "chp_21__art_21.30", type: "ARTIKEL", volgordeNummer: 2, bevatRenvooi: true, kop: renummer("21.29", "21.30", "Parkeren"), _embedded: { ontwerpDocumentComponenten: [lid("chp_21__art_21.30__para_1", 0, "1.", "Er is voldoende parkeergelegenheid.")] } },
    { identificatie: "gm9999_x__art_21.30", expressie: "chp_21__art_21.31", type: "ARTIKEL", volgordeNummer: 3, bevatRenvooi: true, kop: renummer("21.30", "21.31", "Bouwen - parkeren"), _embedded: { ontwerpDocumentComponenten: [lid("chp_21__art_21.31__para_1", 0, "1.", "Een vergunning vraagt voldoende parkeergelegenheid.")] } },
    {
      identificatie: "gm9999_x__art_21.31",
      expressie: "chp_21__art_21.32",
      type: "ARTIKEL",
      volgordeNummer: 4,
      bevatRenvooi: true,
      kop: renummer("21.31", "21.32", "Bouwen"),
      _embedded: {
        ontwerpDocumentComponenten: [
          lid("chp_21__art_21.32__para_1_inst2", -1, "1.", "Oud eerste lid.", { wijzigactie: "verwijder", bevatRenvooi: true }),
          lid("chp_21__art_21.32__para_1", 0, "<VerwijderdeTekst>2</VerwijderdeTekst><NieuweTekst>1</NieuweTekst>.", "Onderkeldering is toegestaan.", { bevatRenvooi: true }),
          lid("chp_21__art_21.32__para_2", 1, "2.", "In het gebied X is bouwen <VerwijderdeTekst>niet </VerwijderdeTekst>toegestaan.", { bevatRenvooi: true }),
          lid("chp_21__art_21.32__para_3", 2, "3.", "Nieuw lid.", { wijzigactie: "voegtoe", bevatRenvooi: true }),
          lid("chp_21__art_21.32__para_4", 3, "4.", "Ongewijzigd lid."),
        ],
      },
    },
  ];
  return [
    {
      identificatie: "body",
      expressie: "body",
      type: "LICHAAM",
      volgordeNummer: 0,
      _embedded: {
        ontwerpDocumentComponenten: [
          { identificatie: "gm9999_x__chp_21", expressie: "chp_21", type: "HOOFDSTUK", volgordeNummer: 0, kop: "<Kop><Label>Hoofdstuk</Label><Nummer>21</Nummer><Opschrift>Ontwikkelingen</Opschrift></Kop>", _embedded: { ontwerpDocumentComponenten: artikelen } },
        ],
      },
    },
    {
      identificatie: "gm9999_x__cmp_II",
      expressie: "cmp_II",
      type: "BIJLAGE",
      volgordeNummer: 1,
      kop: "<Kop><Label>Bijlage</Label><Nummer>II</Nummer><Opschrift>Informatieobjecten</Opschrift></Kop>",
      _embedded: {
        ontwerpDocumentComponenten: [
          { identificatie: "gm9999_x__cmp_II__content_1", expressie: "cmp_II__content_1", type: "DIVISIETEKST", volgordeNummer: 0, bevatRenvooi: true, inhoud: `<Inhoud><Begrippenlijst>${begrippen.map((b) => b.inhoud).join("")}</Begrippenlijst></Inhoud>`, _embedded: { ontwerpDocumentComponenten: begrippen } },
        ],
      },
    },
  ];
}

describe("DSO ontwerp changes", () => {
  it("lists only what an ontwerp changes, marked, with renumbered parts and a reordered list for what they are", () => {
    const doc = buildDsoDocument(ontwerpWijzigingen());
    const changes = selectDsoText(doc, { weergave: "wijzigingen", maxChars: 10_000 });
    expect(changes).toMatchObject({ mode: "wijzigingen", matches: 9, onderdelen: 5, truncated: false, wijzigingen: { gewijzigd: 3, nieuw: 3, vervalt: 1, vernummerd: 2 } });
    expect(changes.parts.map((p) => [p.title, p.wijziging])).toEqual([
      ["Artikel 21.15 Verkeer", "gewijzigd"],
      ["Artikel 21.29 Parkeerkelder", "nieuw"],
      ["Alleen vernummerd (2 onderdelen, tekst ongewijzigd)", "vernummerd"],
      ["Artikel 21.32 Bouwen", "gewijzigd"],
      ["Bijlage II Informatieobjecten: wijzigingen in 3 begrippen", "gewijzigd"],
    ]);
    expect(changes.parts.map((p) => p.tekst.split("\n"))).toEqual([
      ["Artikel 21.15 Verkeer", "In het gebied X worden gronden gebruikt voor:", "a. wegen;", "[+b. speelvoorzieningen;+]", "[-b-][+c+]. terrassen."],
      ["[nieuw] Artikel 21.29 Parkeerkelder", "In het gebied PARKEERKELDER H21 is parkeren toegestaan."],
      ["Artikel [-21.29-][+21.30+] Parkeren", "Artikel [-21.30-][+21.31+] Bouwen - parkeren"],
      ["Artikel [-21.31-][+21.32+] Bouwen", "[vervalt] 1. Oud eerste lid.", "[-2-][+1+]. (alleen vernummerd)", "2. In het gebied X is bouwen [-niet -]toegestaan.", "[nieuw] 3. Nieuw lid.", "[…]"],
      [
        "VERKEER H21: nieuwe versie van /join/id/regdata/gm9999/2026/aaa ([-nld@2026-07-24;1-] [+nld@2026-09-11;2+])",
        "[nieuw] PARKEERKELDER H21: /join/id/regdata/gm9999/2026/ccc/nld@2026-09-11;1",
        "WONEN H21: nieuwe versie van /join/id/regdata/gm9999/2026/bbb ([-nld@2026-07-24;1-] [+nld@2026-09-11;2+])",
      ],
    ]);
    expect(changes.parts[0]).toMatchObject({ eId: "chp_21__art_21.15", pad: "Hoofdstuk 21 Ontwikkelingen" });
    // The regeling as the ontwerp makes it is unchanged: the new wording, the deleted lid gone.
    expect(selectDsoText(doc, { onderdeel: "Artikel 21.32", maxChars: 10_000 }).parts[0].tekst.split("\n")).toEqual([
      "Artikel 21.32 Bouwen",
      "1. Onderkeldering is toegestaan.",
      "2. In het gebied X is bouwen toegestaan.",
      "3. Nieuw lid.",
      "4. Ongewijzigd lid.",
    ]);
  });

  it("narrows the changes to an onderdeel or a zoekterm", () => {
    const doc = buildDsoDocument(ontwerpWijzigingen());
    expect(selectDsoText(doc, { weergave: "wijzigingen", onderdeel: "Artikel 21.32", maxChars: 10_000 }).parts.map((p) => p.eId)).toEqual(["chp_21__art_21.32"]);
    expect(selectDsoText(doc, { weergave: "wijzigingen", zoekterm: "speelvoorzieningen", maxChars: 10_000 }).parts.map((p) => p.eId)).toEqual(["chp_21__art_21.15"]);
    expect(selectDsoText(doc, { weergave: "wijzigingen", onderdeel: "Artikel 99", maxChars: 10_000 }).notFound).toBeDefined();
  });

  it("reads a heading or status the ontwerp changes, and parts it adds or removes whole", () => {
    expect(selectDsoText(buildDsoDocument(ONTWERP_MONTFOORT), { weergave: "wijzigingen", maxChars: 10_000 }).parts.map((p) => [p.wijziging, p.tekst])).toEqual([
      ["gewijzigd", "HOOFDSTUK 20 [+PROJECTGEBONDEN REGELS+] [-gereserveerd-]"],
      ["nieuw", "[nieuw] Titel 20.1 Titel [gereserveerd]"],
      ["vernummerd", "HOOFDSTUK [-24-][+23+] SLOTBEPALINGEN"],
    ]);
    const pv26 = selectDsoText(buildDsoDocument(ONTWERP_PV26), { weergave: "wijzigingen", maxChars: 10_000 }).parts;
    expect(pv26.map((p) => [p.eId, p.wijziging])).toEqual([
      ["chp_2__subchp_2.1__subsec_2.1.2__art_2.4", "gewijzigd"],
      ["chp_2__subchp_2.1__subsec_2.1.3__art_2.12", "nieuw"],
      ["chp_2__subchp_2.1__subsec_2.1.3__art_2.12_inst2", "vervalt"],
      ["chp_3__subchp_3.1__subsec_3.1.3__art_3.4", "gewijzigd"],
    ]);
    expect(pv26[0].tekst).toContain("4. Deze [-omgevingswaarde is-][+omgevingswaarden zijn+] een inspanningsverplichting.");
    expect(pv26[2].tekst.startsWith("[vervalt] Artikel 2.12 Instructieregel monitoring omgevingswaarde regionale kering")).toBe(true);
    expect(pv26[3].tekst).toContain("[vervalt] 2. Het eerste lid geldt niet");
  });
});
