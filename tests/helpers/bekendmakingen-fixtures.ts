/**
 * SRU fixtures for officielepublicaties, shaped like the live responses of
 * repository.overheid.nl/sru (October 2026), trimmed to the fields the source reads.
 */

const NS =
  'xmlns:overheidwetgeving="http://standaarden.overheid.nl/wetgeving/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
  'xmlns:sru="http://docs.oasis-open.org/ns/search-ws/sruResponse" xmlns:gzd="http://standaarden.overheid.nl/sru" ' +
  'xmlns:c="http://standaarden.overheid.nl/collectie/"';

export function sruResponse(records: string[], total: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?><sru:searchRetrieveResponse ${NS}><sru:version>2.0</sru:version>` +
    `<sru:numberOfRecords>${total}</sru:numberOfRecords><sru:records>${records.join("")}</sru:records>` +
    `<sru:resultCountPrecision>info:srw/vocabulary/resultCountPrecision/1/estimate</sru:resultCountPrecision>` +
    `</sru:searchRetrieveResponse>`;
}

/** What the server sends for a query it cannot parse: HTTP 200, no count, a diagnostic. */
export const SRU_DIAGNOSTIC = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><searchRetrieveResponse xmlns="http://docs.oasis-open.org/ns/search-ws/sruResponse" xmlns:ns3="http://docs.oasis-open.org/ns/search-ws/diagnostic"><version>2.0</version><diagnostics><ns3:diagnostic><ns3:uri>info:srw/diagnostic/1/10</ns3:uri><ns3:message>line 1:13 mismatched input 'c.product-area' expecting {&lt;EOF&gt;, AND, OR, NOT, PROX, SORTBY}</ns3:message></ns3:diagnostic></diagnostics></searchRetrieveResponse>`;

function record(body: { kern: string; mantel: string; tp: string; enriched: string }): string {
  return `<sru:record><sru:recordSchema>http://standaarden.overheid.nl/sru/</sru:recordSchema><sru:recordData><gzd:gzd>` +
    `<gzd:originalData><overheidwetgeving:meta><overheidwetgeving:owmskern>${body.kern}</overheidwetgeving:owmskern>` +
    `<overheidwetgeving:owmsmantel>${body.mantel}</overheidwetgeving:owmsmantel>` +
    `<overheidwetgeving:tpmeta><c:product-area>officielepublicaties</c:product-area>${body.tp}</overheidwetgeving:tpmeta>` +
    `</overheidwetgeving:meta></gzd:originalData><gzd:enrichedData>${body.enriched}</gzd:enrichedData></gzd:gzd></sru:recordData></sru:record>`;
}

const REPO = "https://repository.overheid.nl/frbr/officielepublicaties";

export const GMB_RECORD = record({
  kern:
    "<dcterms:identifier>gmb-2026-104512</dcterms:identifier>" +
    "<dcterms:title>Beleidsregels afvalinzameling gemeente Pijnacker-Nootdorp</dcterms:title>" +
    '<dcterms:type scheme="OVERHEIDop.Rubriek">ander besluit van algemene strekking</dcterms:type>' +
    '<dcterms:creator scheme="OVERHEID.Gemeente">Pijnacker-Nootdorp</dcterms:creator>' +
    "<dcterms:modified>2026-04-02</dcterms:modified>",
  mantel:
    "<dcterms:available>2026-04-02</dcterms:available><dcterms:date>2026-04-02</dcterms:date>" +
    "<dcterms:source>RICHTLIJN 2008/98/EG (kaderrichtlijn afvalstoffen)]|[https://eur-lex.europa.eu/legal-content/NL/TXT/HTML/?uri=CELEX:32008L0098</dcterms:source>" +
    "<dcterms:source>artikel 4:81 van de Algemene wet bestuursrecht]|[1.0:c:BWBR0005537&amp;artikel=4%3A81&amp;g=2026-01-01</dcterms:source>" +
    '<dcterms:subject scheme="OVERHEID.TaxonomieBeleidsagendaDecentraal">Recht | Organisatie en beleid</dcterms:subject>' +
    '<dcterms:publisher scheme="OVERHEID.Gemeente">Pijnacker-Nootdorp</dcterms:publisher>',
  tp:
    "<c:content-area>officielepublicaties/gmb/2026</c:content-area>" +
    "<overheidwetgeving:betreftRegeling>CVDR700412_1</overheidwetgeving:betreftRegeling>" +
    "<overheidwetgeving:jaargang>2026</overheidwetgeving:jaargang>" +
    '<overheidwetgeving:organisatietype scheme="OVERHEID.Organisatietype">gemeente</overheidwetgeving:organisatietype>' +
    "<overheidwetgeving:publicatienummer>104512</overheidwetgeving:publicatienummer>" +
    "<overheidwetgeving:publicatienaam>Gemeenteblad</overheidwetgeving:publicatienaam>" +
    '<overheidwetgeving:gebiedsmarkering scheme="OVERHEIDop.locatietype"><overheidwetgeving:Gemeente>' +
    '<overheidwetgeving:gemeentenaam scheme="OVERHEID.Gemeente">Pijnacker-Nootdorp</overheidwetgeving:gemeentenaam>' +
    "<overheidwetgeving:ligtInProvincie>Zuid-Holland</overheidwetgeving:ligtInProvincie></overheidwetgeving:Gemeente></overheidwetgeving:gebiedsmarkering>",
  enriched:
    `<gzd:url>${REPO}/gmb/2026/gmb-2026-104512/1/xml/gmb-2026-104512.xml</gzd:url>` +
    "<gzd:preferredUrl>https://zoek.officielebekendmakingen.nl/gmb-2026-104512.html</gzd:preferredUrl>" +
    `<gzd:itemUrl manifestation="html">${REPO}/gmb/2026/gmb-2026-104512/1/html/gmb-2026-104512.html</gzd:itemUrl>` +
    `<gzd:itemUrl manifestation="metadata">${REPO}/gmb/2026/gmb-2026-104512/1/metadata/metadata.xml</gzd:itemUrl>` +
    `<gzd:itemUrl manifestation="odt">${REPO}/gmb/2026/gmb-2026-104512/1/odt/gmb-2026-104512.odt</gzd:itemUrl>` +
    `<gzd:itemUrl manifestation="pdf">${REPO}/gmb/2026/gmb-2026-104512/1/pdf/gmb-2026-104512.pdf</gzd:itemUrl>` +
    `<gzd:itemUrl manifestation="xml">${REPO}/gmb/2026/gmb-2026-104512/1/xml/gmb-2026-104512.xml</gzd:itemUrl>`,
});

export const KST_RECORD = record({
  kern:
    "<dcterms:identifier>kst-37020-IX-40</dcterms:identifier>" +
    "<dcterms:title>Vaststelling van de begrotingsstaat van het Ministerie van Financiën (IXB) voor het jaar 2027; Motie</dcterms:title>" +
    "<dcterms:type>Kamerstuk</dcterms:type>" +
    "<dcterms:creator>Tweede Kamer der Staten-Generaal</dcterms:creator><dcterms:modified>2026-10-02</dcterms:modified>",
  mantel:
    "<dcterms:available>2026-10-02</dcterms:available><dcterms:date>2026-10-01</dcterms:date><dcterms:issued>2026-10-01</dcterms:issued>" +
    "<dcterms:subject>Financiën | Begroting</dcterms:subject>",
  tp:
    "<overheidwetgeving:documenttitel>Motie van de leden Dassen en Stultiens over een SER-advies</overheidwetgeving:documenttitel>" +
    "<overheidwetgeving:dossiertitel>Vaststelling van de begrotingsstaat van het Ministerie van Financiën (IXB)</overheidwetgeving:dossiertitel>" +
    "<overheidwetgeving:indiener>L.A.J.M. Dassen</overheidwetgeving:indiener><overheidwetgeving:indiener>L.C.J. Stultiens</overheidwetgeving:indiener>" +
    "<overheidwetgeving:ondernummer>40</overheidwetgeving:ondernummer>" +
    "<overheidwetgeving:organisatietype>staten generaal</overheidwetgeving:organisatietype>" +
    "<overheidwetgeving:publicatienaam>Kamerstuk</overheidwetgeving:publicatienaam>" +
    "<overheidwetgeving:vergaderjaar>2026-2027</overheidwetgeving:vergaderjaar>" +
    "<overheidwetgeving:dossiernummer>37020-IX</overheidwetgeving:dossiernummer>" +
    "<overheidwetgeving:subrubriek>Motie</overheidwetgeving:subrubriek>",
  enriched:
    "<gzd:preferredUrl>https://zoek.officielebekendmakingen.nl/kst-37020-IX-40.html</gzd:preferredUrl>" +
    `<gzd:itemUrl manifestation="pdf">${REPO}/kst/37020-IX/kst-37020-IX-40/1/pdf/kst-37020-IX-40.pdf</gzd:itemUrl>` +
    `<gzd:itemUrl manifestation="xml">${REPO}/kst/37020-IX/kst-37020-IX-40/1/xml/kst-37020-IX-40.xml</gzd:itemUrl>`,
});

/** A Kamerstuk attachment: only a PDF manifestation, like most of them. */
export const BLG_RECORD = record({
  kern:
    "<dcterms:identifier>blg-1093410</dcterms:identifier><dcterms:title>Voortgangsrapportage fietsparkeren bij stations</dcterms:title>" +
    "<dcterms:type>Bijlage</dcterms:type><dcterms:creator>Tweede Kamer der Staten-Generaal</dcterms:creator>",
  mantel: "<dcterms:available>2024-02-12</dcterms:available><dcterms:date>2024-02-12</dcterms:date>",
  tp:
    "<overheidwetgeving:hoofddocument>kst-31305-412</overheidwetgeving:hoofddocument>" +
    "<overheidwetgeving:ondernummer>412</overheidwetgeving:ondernummer>" +
    "<overheidwetgeving:organisatietype>staten generaal</overheidwetgeving:organisatietype>" +
    "<overheidwetgeving:publicatienaam>Kamerstuk</overheidwetgeving:publicatienaam>" +
    "<overheidwetgeving:vergaderjaar>2023-2024</overheidwetgeving:vergaderjaar>" +
    "<overheidwetgeving:dossiernummer>31305</overheidwetgeving:dossiernummer>",
  enriched:
    "<gzd:preferredUrl>https://zoek.officielebekendmakingen.nl/blg-1093410.html</gzd:preferredUrl>" +
    `<gzd:itemUrl manifestation="pdf">${REPO}/blg/onopgemaakt/blg-1093410/1/pdf/blg-1093410.pdf</gzd:itemUrl>`,
});

/** One item of a plenary meeting: the meeting number is publicatienummer, the item handelingenitemnummer. */
export const HANDELINGEN_RECORD = record({
  kern:
    "<dcterms:identifier>h-tk-20242025-42-4</dcterms:identifier><dcterms:title>Debat over woningbouw</dcterms:title>" +
    "<dcterms:type>Handelingen</dcterms:type><dcterms:creator>Tweede Kamer der Staten-Generaal</dcterms:creator>",
  mantel: "<dcterms:available>2025-04-07</dcterms:available><dcterms:date>2025-01-16</dcterms:date>",
  tp:
    "<overheidwetgeving:datumVergadering>2025-01-16</overheidwetgeving:datumVergadering>" +
    "<overheidwetgeving:handelingenitemnummer>4</overheidwetgeving:handelingenitemnummer>" +
    "<overheidwetgeving:organisatietype>staten generaal</overheidwetgeving:organisatietype>" +
    "<overheidwetgeving:publicatienummer>42</overheidwetgeving:publicatienummer>" +
    "<overheidwetgeving:publicatienaam>Handelingen</overheidwetgeving:publicatienaam>" +
    "<overheidwetgeving:vergaderjaar>2024-2025</overheidwetgeving:vergaderjaar>",
  enriched: "<gzd:preferredUrl>https://zoek.officielebekendmakingen.nl/h-tk-20242025-42-4.html</gzd:preferredUrl>",
});

/** An answer to Kamervragen: numbered in the Aanhangsel (aanhangselnummer), not by publicatienummer. */
export const AANHANGSEL_RECORD = record({
  kern:
    "<dcterms:identifier>ah-tk-20192020-4046</dcterms:identifier><dcterms:title>Antwoord op vragen over afvalinzameling</dcterms:title>" +
    "<dcterms:type>Kamervragen (Aanhangsel)</dcterms:type><dcterms:creator>Tweede Kamer der Staten-Generaal</dcterms:creator>",
  mantel: "<dcterms:available>2020-09-08</dcterms:available><dcterms:date>2020-09-08</dcterms:date>",
  tp:
    "<overheidwetgeving:aanhangselnummer>4046</overheidwetgeving:aanhangselnummer>" +
    "<overheidwetgeving:organisatietype>staten generaal</overheidwetgeving:organisatietype>" +
    "<overheidwetgeving:publicatienaam>Kamervragen (Aanhangsel)</overheidwetgeving:publicatienaam>" +
    "<overheidwetgeving:vergaderjaar>2019-2020</overheidwetgeving:vergaderjaar>" +
    "<overheidwetgeving:vraagnummer>2020Z14131</overheidwetgeving:vraagnummer>",
  enriched: "<gzd:preferredUrl>https://zoek.officielebekendmakingen.nl/ah-tk-20192020-4046.html</gzd:preferredUrl>",
});

export function utrechtRecord(id: string, kind: "gemeente" | "provincie", journal: string): string {
  return record({
    kern:
      `<dcterms:identifier>${id}</dcterms:identifier><dcterms:title>Jaarstukken 2025</dcterms:title>` +
      "<dcterms:type>overige overheidsinformatie</dcterms:type><dcterms:creator>Utrecht</dcterms:creator>",
    mantel: "<dcterms:available>2026-05-08</dcterms:available><dcterms:date>2026-05-08</dcterms:date>",
    tp:
      "<overheidwetgeving:jaargang>2026</overheidwetgeving:jaargang>" +
      `<overheidwetgeving:organisatietype>${kind}</overheidwetgeving:organisatietype>` +
      `<overheidwetgeving:publicatienummer>7695</overheidwetgeving:publicatienummer>` +
      `<overheidwetgeving:publicatienaam>${journal}</overheidwetgeving:publicatienaam>`,
    enriched: `<gzd:preferredUrl>https://zoek.officielebekendmakingen.nl/${id}.html</gzd:preferredUrl>`,
  });
}

/** A minimal record: just an identifier and its publisher. */
export function creatorRecord(id: string, creator: string, kind = "gemeente"): string {
  return record({
    kern: `<dcterms:identifier>${id}</dcterms:identifier><dcterms:title>Publicatie ${id}</dcterms:title><dcterms:creator>${creator}</dcterms:creator>`,
    mantel: "<dcterms:available>2026-09-01</dcterms:available><dcterms:date>2026-09-01</dcterms:date>",
    tp: `<overheidwetgeving:organisatietype>${kind}</overheidwetgeving:organisatietype>`,
    enriched: `<gzd:preferredUrl>https://zoek.officielebekendmakingen.nl/${id}.html</gzd:preferredUrl>`,
  });
}

/** Trimmed publication XML (the "xml" manifestation). */
export const GMB_XML = `<officiele-publicatie><metadata><meta name="OVERHEIDop.externMetadataRecord" content="https://zoek.officielebekendmakingen.nl/gmb-2026-104512/metadata.xml" /></metadata><kop><titel>GEMEENTEBLAD</titel><subtitel>Officiële uitgave van de gemeente Pijnacker-Nootdorp</subtitel></kop><gemeenteblad><regeling><aanhef><preambule><al>Het college van burgemeester en wethouders;</al><al>gelet op artikel 4:81 van de Algemene wet bestuursrecht &amp; de <nadruk type="vet">A</nadruk>fvalstoffenverordening;</al></preambule></aanhef></regeling></gemeenteblad></officiele-publicatie>`;
