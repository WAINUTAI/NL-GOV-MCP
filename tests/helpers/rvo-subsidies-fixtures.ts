/**
 * Fixtures for the RVO subsidies source, captured from the live responses of
 * www.rvo.nl (October 2026) and trimmed: list rows of /api/v1/opendata/subsidies, one
 * detail record, and the page data (Next.js flight payload) of a few regeling pages.
 */

export const RVO_LIST = "https://www.rvo.nl/api/v1/opendata/subsidies";

export const BMKB_ID = "530035f0-7833-448f-adee-a36988bc6dc7";
export const TF_ID = "89c4fee3-4683-4916-b7f7-50c6e3d7b3b7";
export const SWIM_ID = "08708250-1bfb-47f0-b109-3bbcb58a11e9";
export const DEI_WATERSTOF_ID = "15858536-b326-411b-97bc-253de022ffae";
export const DUMAVA_ID = "57a2bf91-a56b-4d41-baee-12f8334dc1fc";
export const DDP_ID = "2fe96b17-e44e-4233-8535-6dfc5eafc92c";
export const FVO_ID = "0738dce6-61ec-49e4-b4dd-4f9b46f48cc7";
export const NEDERWIEK_ID = "0da9b7cc-9647-47f5-8458-d5233c71b2c1";
export const STUDI_WATERSTOF_ID = "08d1d7ea-9da4-4bb8-80ac-080509e99420";
export const TOGS_ID = "344e0557-5254-4339-91b4-2ea407575499";
export const SEL_ID = "a60516b9-3e2e-45ec-beda-bc3ea525ceed";
export const SEB_ID = "4f34422f-c6db-4033-8000-e3da080ca3c1";

/** List rows as the API returns them (sectors, tags and countries cut to a few). */
export const RVO_ROWS: Array<Record<string, unknown>> = [
  {
    id: BMKB_ID,
    title: "Borgstelling MKB-kredieten (BMKB)",
    created: "2010-12-22T14:08:53+00:00",
    changed: "2026-03-13T09:30:11+00:00",
    intro:
      "Heeft u als ondernemer te weinig onderpand om geld te lenen? Informeer bij uw financier naar de mogelijkheden van de Borgstelling MKB-kredieten (BMKB). De BMKB vergroot het onderpand en daarmee ook de financierbaarheid van de onderneming, ook in de toekomst.&nbsp;Om de financieringsmogelijkheden voor verduurzamingsinvesteringen door het mkb te vergroten is de BMKB verruimd met een groen luik, de BMKB-G.",
    countries: [
      { name: "Nederland", isoalpha2: "NL" },
      { name: "Caribisch Nederland", isoalpha2: "BQ" },
      { name: "Bonaire", isoalpha2: "" },
      { name: "Saba", isoalpha2: "" },
    ],
    sectors: ["Biotechnologie", "Bosbouw en hout(bewerkings)industrie", "Bouw en infrastructuur", "Chemie en kunststoffen"],
    subjects: ["Innovatie, onderzoek en onderwijs"],
    subsidies: ["Besluit Borgstelling MKB Kredieten (BMKB)"],
    tags: ["Innovatie", "Circulair ondernemen", "Bedrijfsfinanciering", "SDG1 Geen armoede", "SDG8 Eerlijk werk en economische groei"],
    targets: ["Financier", "MKB (ook zzp)", "Agrarisch ondernemer"],
    type: "subsidy",
    url: "/subsidies-financiering/bmkb",
  },
  {
    id: TF_ID,
    title: "Transitiefaciliteit (TF)",
    created: "2012-08-06T07:18:16+00:00",
    changed: "2025-04-16T11:00:57+00:00",
    intro:
      "De Transitiefaciliteit (TF) stimuleerde Nederlandse mkb-bedrijven en kennisinstellingen om actief te worden op de veelbelovende markten Colombia, Vietnam en Zuid-Afrika. Het doel van het programma was om het ondernemingsklimaat in deze landen te verbeteren en de omvang van de handel, investeringen en diensten door Nederlandse bedrijven te vergroten.",
    countries: [
      { name: "Zuid-Afrika", isoalpha2: "ZA" },
      { name: "Vietnam", isoalpha2: "VN" },
      { name: "Colombia", isoalpha2: "CO" },
    ],
    sectors: ["Energiesector", "Vervoer en logistiek", "Watersector"],
    subjects: ["Internationaal ondernemen", "Ontwikkelingssamenwerking"],
    subsidies: ["Transitiefaciliteit", "Programma ontwikkelingssamenwerking"],
    tags: ["Biobased economy", "Klimaatadaptatie", "SDG8 Eerlijk werk en economische groei", "SDG17 Partnerschap om doelstellingen te bereiken"],
    targets: ["MKB (ook zzp)", "School / Kennisinstelling"],
    type: "subsidy",
    url: "/subsidies-financiering/transitiefaciliteit-tf",
  },
  {
    id: SWIM_ID,
    title: "Subsidieregeling Waterstof in mobiliteit (SWIM)",
    created: "2024-07-15T11:54:53+00:00",
    changed: "2026-08-27T11:02:07+00:00",
    intro:
      "Investeert u in een waterstoftankstation, waterstofvoertuigen en/of - werktuigen? En werkt u in een samenwerkingsverband? Dan komt u mogelijk in aanmerking voor de subsidieregeling Waterstof in mobiliteit (SWIM).&nbsp;[rvo_custom:upnl:upnl7_eh3_aanvraag_beheren]",
    countries: [{ name: "Nederland", isoalpha2: "NL" }],
    sectors: ["Vervoer en logistiek", "Transportmiddelenindustrie"],
    subjects: ["Klimaat en energie"],
    subsidies: ["Subsidieregeling Waterstof in Mobiliteit (SWIM)"],
    tags: ["Duurzame mobiliteit", "UPNL inregelconcept", "Transportregelingen"],
    targets: ["Grootbedrijf", "MKB (ook zzp)"],
    type: "subsidy",
    url: "/subsidies-financiering/waterstof-mobiliteit",
  },
  {
    id: DEI_WATERSTOF_ID,
    title: "DEI+: Waterstof en groene chemie ",
    created: "2022-06-16T18:43:37+00:00",
    changed: "2026-09-18T12:11:17+00:00",
    intro:
      "Wilt u als bedrijf een innovatie testen of demonstreren die bijdraagt aan de waterstofeconomie? Bijvoorbeeld een innovatieve techniek voor de productie of opslag van waterstof? Vraag dan subsidie aan met de regeling Demonstratie Energie- en Klimaatinnovatie (DEI+): Waterstof en groene chemie.[rvo_custom:eloket:login1-eh3-aanvraag-bekijken]",
    countries: [
      { name: "Nederland", isoalpha2: "NL" },
      { name: "Sint Eustatius", isoalpha2: "" },
      { name: "Bonaire", isoalpha2: "" },
      { name: "Caribisch Nederland", isoalpha2: "BQ" },
    ],
    sectors: ["Chemie en kunststoffen", "Energiesector", "Milieusector", "Waterstofsector"],
    subjects: ["Klimaat en energie"],
    subsidies: ["Demonstratie Energie- en Klimaatinnovatie (DEI+)", "Energy Innovation NL"],
    tags: ["Groen gas", "Waterstof", "CO2-reductie", "eLoket"],
    targets: ["Grootbedrijf", "MKB (ook zzp)", "Non-profit / NGO", "School / Kennisinstelling"],
    type: "subsidy",
    url: "/subsidies-financiering/dei/waterstof-en-groene-chemie",
  },
  {
    id: DUMAVA_ID,
    title: "Subsidieregeling duurzaam maatschappelijk vastgoed (DUMAVA)",
    created: "2022-03-23T14:01:08+00:00",
    changed: "2026-10-12T08:50:25+00:00",
    intro:
      "Bent u eigenaar van maatschappelijk vastgoed? Of houdt u zich bezig met het verduurzamen van maatschappelijk vastgoed zoals scholen, overheidsgebouwen, zorginstellingen, sportaccommodaties of monumenten? De subsidieregeling duurzaam maatschappelijk vastgoed (DUMAVA) komt eigenaren van bestaand maatschappelijk vastgoed tegemoet in de kosten om te verduurzamen.[rvo_custom:eloket:login2-eh2+-subsidie-aanvragen][rvo_custom:eloket:login2-eh2+-aanvraag-beheren]",
    countries: [{ name: "Nederland", isoalpha2: "NL" }],
    sectors: ["Bouw en infrastructuur", "Woning- en projectinrichting"],
    subjects: ["Bouwen en wonen", "Klimaat en energie"],
    subsidies: ["Investeringssubsidie duurzaam maatschappelijk vastgoed (DUMAVA)"],
    tags: ["eLoket", "Duurzaam bouwen en verbouwen", "Maatschappelijk vastgoed", "Verduurzamen", "Klimaatadaptatie"],
    targets: ["Overheid", "Non-profit / NGO", "Particulier / Vereniging / (Ver)huurder", "School / Kennisinstelling", "MKB (ook zzp)"],
    type: "subsidy",
    url: "/subsidies-financiering/dumava",
  },
  {
    id: DDP_ID,
    title: "Dutch Diamonds Partnerships (DDP)",
    created: "2026-08-03T11:55:32+00:00",
    changed: "2026-10-15T07:50:50+00:00",
    intro:
      "Dutch Diamonds Partnerships (DDP) wil de duurzame, klimaatvriendelijke transformatie van de water- en voedselsector versterken. Het subsidieprogramma stimuleert ook de marktontwikkeling in andere sectoren en waardeketens.Aanvragen vanaf 7 december 2026 tot en met 15 februari 2027.",
    countries: [
      { name: "Ivoorkust", isoalpha2: "CI" },
      { name: "Bangladesh", isoalpha2: "BD" },
      { name: "Benin", isoalpha2: "BJ" },
      { name: "Ghana", isoalpha2: "GH" },
    ],
    sectors: ["Voedingsmiddelen", "Watersector"],
    subjects: ["Internationaal ondernemen", "Ontwikkelingssamenwerking"],
    subsidies: ["Dutch Diamonds Partnerships (DDP)", "Programma ontwikkelingssamenwerking"],
    tags: ["SDG17 Partnerschap om doelstellingen te bereiken", "SDG2 Geen honger", "SDG6 Schoon water en sanitair"],
    targets: ["MKB (ook zzp)", "Non-profit / NGO", "School / Kennisinstelling"],
    type: "subsidy",
    url: "/subsidies-financiering/ddp",
  },
  {
    id: FVO_ID,
    title: "Fonds Verantwoord Ondernemen (FVO)",
    created: "2019-02-26T10:00:11+00:00",
    changed: "2026-10-02T06:57:11+00:00",
    intro:
      "Het Fonds Verantwoord Ondernemen (FVO) is gesloten. U kunt niet meer aanvragen.Op deze pagina vindt u informatie over FVO projectadministratie en aanvullende subsidieregelingen waarvoor u nog een aanvraag kunt doen.",
    countries: [],
    sectors: ["Agrarische sector", "Biotechnologie"],
    subjects: ["Internationaal ondernemen", "Ontwikkelingssamenwerking"],
    subsidies: ["Programma zakendoen", "Fonds Verantwoord Ondernemen (FVO)"],
    tags: ["Ontwikkelingssamenwerking", "Internationaal MVO", "Maatschappelijk Verantwoord Ondernemen"],
    targets: ["Non-profit / NGO"],
    type: "subsidy",
    url: "/subsidies-financiering/fvo",
  },
  {
    id: NEDERWIEK_ID,
    title: "Vergunning windpark Nederwiek I-A",
    created: "2025-08-26T10:40:04+00:00",
    changed: "2026-09-10T10:57:23+00:00",
    intro:
      "U kon tot en met 30 oktober 2025 een aanvraag indienen voor een windpark op kavel I-A in windenergiegebied Nederwiek op de Noordzee. De vergunning is voor de bouw en exploitatie van een windpark met een vermogen van 1 gigawatt (GW). We hebben geen aanvragen ontvangen. Op deze pagina leest u meer over de gevolgen hiervan.",
    countries: [{ name: "Nederland", isoalpha2: "NL" }],
    sectors: ["Windenergie"],
    subjects: ["Klimaat en energie"],
    subsidies: ["Offshore Wind Energy", "Vergunning windpark Nederwiek I-A"],
    tags: ["Duurzame energie", "Hernieuwbare energie", "Wind", "Wind op zee"],
    targets: ["Grootbedrijf"],
    type: "subsidy",
    url: "/onderwerpen/windenergie-op-zee/nederwiek-i-a",
  },
  {
    id: STUDI_WATERSTOF_ID,
    title: "STUDI: Waterstof en groene chemie (GroenvermogenNL)",
    created: "2024-04-03T10:48:35+00:00",
    changed: "2026-08-27T09:55:22+00:00",
    intro:
      "Wilt u een innovatie of uitontwikkelde technologie testen of demonstreren voor het gebruik van waterelektrolyse, elektrochemie of waterstoftransport? Wilt u onderzoeken of dit haalbaar is? En helpt u met het vervolgproject de CO2-uitstoot in de Nederlandse industrie binnen 10 jaar na uw studie verminderen? Vraag dan de subsidie Studies voor Duurzame Industrie (STUDI): Waterstof en groene chemie aan.[rvo_custom:upnl:upnl7_eh3_aanvragen_studi_waterstof][rvo_custom:upnl:upnl7_eh3_aanvraag_beheren]",
    countries: [{ name: "Nederland", isoalpha2: "NL" }],
    sectors: ["Agrarische sector", "Biotechnologie"],
    subjects: ["Klimaat en energie", "Innovatie, onderzoek en onderwijs"],
    subsidies: ["Energy Innovation NL", "Studies voor Duurzame Industrie (STUDI)", "STUDI: Waterstof en groene chemie"],
    tags: ["UPNL inregelconcept", "Topsectorenbeleid", "Energiebeleid"],
    targets: ["Grootbedrijf", "MKB (ook zzp)", "School / Kennisinstelling"],
    type: "subsidy",
    url: "/subsidies-financiering/studi/waterstof-en-groene-chemie",
  },
  {
    id: TOGS_ID,
    title: "Tegemoetkoming schade COVID-19 (TOGS)",
    created: "2020-03-18T13:30:01+00:00",
    changed: "2024-07-04T09:26:42+00:00",
    intro:
      "Hoort uw onderneming bij die sectoren die het meest zijn geraakt door de overheidsmaatregelen rond het coronavirus (COVID-19)? Lijdt u schade door de noodgedwongen sluiting, de inperking van bijeenkomsten en/of het negatieve reisadvies buitenland? Dan kón u via de Beleidsregel tegemoetkoming ondernemers getroffen sectoren COVID-19 (TOGS) een eenmalige tegemoetkoming van € 4.000 ontvangen. U bent vrij in het doel van besteding.",
    countries: [{ name: "Nederland", isoalpha2: "NL" }],
    sectors: ["Agrarische sector", "Consumentengoederen en detailhandel", "Creatieve industrie"],
    subjects: ["Ondernemen  en bedrijfsvoering"],
    subsidies: ["Tegemoetkoming schade COVID-19"],
    tags: ["COVID", "SDG8 Eerlijk werk en economische groei", "Staatssteun"],
    targets: ["MKB (ook zzp)"],
    type: "subsidy",
    url: "/subsidies-financiering/togs",
  },
  {
    id: SEL_ID,
    title: "Subsidie emissieloos landbouwmaterieel (SEL)",
    created: "2026-03-05T11:43:00+00:00",
    changed: "2026-10-02T15:00:05+00:00",
    intro:
      "Bespaar op uw dieselverbruik door te investeren in een elektrische landbouwmachine of tractor. Met deze subsidie profiteert u van financieel voordeel en helpt u de uitstoot van broeikasgassen te verminderen. Samen werken we aan het doel van een klimaatneutraal Nederland in 2050.[rvo_custom:upnl:upnl7_eh3_aanvraag_beheren]",
    countries: [{ name: "Nederland", isoalpha2: "NL" }],
    sectors: ["Agrarische sector"],
    subjects: ["Klimaat en energie", "Landbouw"],
    subsidies: ["Subsidie emissieloos landbouwmaterieel (SEL)"],
    tags: ["Elektronische apparatuur", "Klimaatneutraal", "Emissiereductie"],
    targets: ["Agrarisch ondernemer", "MKB (ook zzp)"],
    type: "subsidy",
    url: "/subsidies-financiering/sel",
  },
  {
    id: SEB_ID,
    title: "Subsidie Sociaal-economische begeleiding (SEB) ",
    created: "2026-09-08T14:39:00+00:00",
    changed: "2026-10-14T07:29:36+00:00",
    intro:
      "Wilt u agrariërs met uw samenwerkingsverband begeleiden bij het maken van keuzes over de toekomst van hun bedrijf? Vraag dan subsidie aan om een provinciaal knooppunt te starten. Agrariërs kunnen ontdekken welke mogelijkheden er zijn. En kunnen begeleiding krijgen door een erkend agrarisch bedrijfsadviseur.&nbsp;",
    countries: [{ name: "Nederland", isoalpha2: "NL" }],
    sectors: ["Agrarische sector"],
    subjects: ["Landbouw"],
    subsidies: ["Subsidie Sociaal-economische begeleiding (SEB)", "Agro 2"],
    tags: ["2026", "Subsidie"],
    targets: ["Agrarisch ondernemer"],
    type: "subsidy",
    url: "/subsidies-financiering/subsidie-sociaal-economische-begeleiding-seb",
  },
];

/** A synthetic list row (neutral text) to fill list pages. */
export function fillerRow(i: number): Record<string, unknown> {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    title: `Testpagina ${i}`,
    created: "2020-01-01T00:00:00+00:00",
    changed: "2021-01-01T00:00:00+00:00",
    intro: "Pagina zonder bijzondere inhoud.",
    countries: [],
    sectors: [],
    subjects: [],
    subsidies: [],
    tags: [],
    targets: [],
    type: "subsidy",
    url: `/subsidies-financiering/testpagina-${i}`,
  };
}

/** Detail record of BMKB as GET /api/v1/opendata/subsidies/<id> returns it (sectors cut). */
export const BMKB_DETAIL: Record<string, unknown> = {
  ...RVO_ROWS[0],
  body: [
    null,
    null,
    "<p>Met het borgstellingskrediet staat het ministerie van Economische Zaken voor een deel garant voor bedrijven die een lening willen afsluiten, maar de financier niet genoeg zekerheid kunnen bieden ('onderpand', zoals gebouwen of machines).</p><h3>Webportaal en helpdesk voor financiers</h3><p>Er is een <a href=\"http://garanties.senternovem.nl/\">webportaal speciaal en alleen toegankelijk voor financiers</a>. Dit bevat het volgende: de Handleiding BMKB, een portaal om meldingen/wijzigingen door te voeren, de mogelijkheid om vragen aan ons te stellen.</p><h2>Budget</h2><p>De BMKB is verruimd tot en met 1 juli 2027. Bedrijven met een kredietbehoefte tot € 333.333 kunnen driekwart financieren met BMKB-krediet, anders ligt de grens op maximaal de helft van de kredietverstrekking. Verder is het maximum van het BMKB-krediet tijdelijk verhoogd van € 1 miljoen naar € 1,5 miljoen. Op het BMKB-krediet is een overheidsborgstelling van 90% van toepassing.</p><h2>Voorwaarden</h2><p>De BMKB is bestemd voor ondernemingen met maximaal 250 werknemers (fte) met een jaaromzet tot € 50 miljoen of een balanstotaal tot € 43 miljoen. Ook een VOF, eenmanszaak of maatschap komen in aanmerking.</p><p><a href=\"/node/2052844\" data-entity-type=\"node\" data-entity-uuid=\"9f2f94b8-334b-450b-9378-b4b967d1ecdb\" data-entity-substitution=\"canonical\">Lees meer over de voorwaarden</a></p>",
    "<h2>Aanvragen</h2><p>U vraagt de BMKB niet zelf aan. Dit gebeurt via uw financier.</p><p><a href=\"/node/4608\">Lees meer over het aanvraagproces</a></p><h2>Na uw aanvraag</h2><p>De financier is bij het afsluiten van het borgstellingskrediet een eenmalige garantieprovisie verschuldigd aan ons.</p><h2>Wet- en regelgeving</h2><ul><li>Voor de BMKB geldt de volgende wettekst: <a href=\"https://wetten.overheid.nl/BWBR0035474/#Hoofdstuk3_Titeldeel3.11\">Regeling nationale EZ-subsidies:&nbsp; Borgstelling MKB-kredieten</a>.</li><li>Op de BMKB-regeling zijn 'de minimissteun' bepalingen van de Europese Commissie van toepassing. Meer informatie vindt u op het formulier&nbsp;Verklaring De-minimissteun&nbsp;op de pagina <a href=\"/node/874196\">Standaardformulieren</a>.</li></ul>",
  ],
};

// ---------------------------------------------------------------------------
// Page data

/** Text rows of the DUMAVA page: long strings are referenced as "$16" etc. */
export const DUMAVA_TEXT_ROWS: Record<string, string> = {
  "16": "<h2>Voor wie?</h2>\n<p>Om DUMAVA aan te vragen, moet het vastgoed in Nederland staan en eigendom zijn van een maatschappelijke instelling binnen deze sectoren:</p>\n",
  "17": "<ul>\n<li data-list-item-id=\"e932dd95bedefbe597463f38a13f0ad96\">De subsidie is 20% van de projectkosten, het energieadvies en het energielabel samen.</li>\n<li data-list-item-id=\"efd7457429903daab335b0c2e90cda7b5\">De subsidiebedragen zijn&nbsp;minimaal € 2.500 en maximaal<span> </span>€ 1,5 miljoen.</li>\n</ul>\n",
  "18": "<h2>Voorwaarden</h2>\n<p>Om in aanmerking te komen voor DUMAVA moet u aan een aantal voorwaarden voldoen. Bijvoorbeeld:</p>\n<ul>\n<li data-list-item-id=\"e4097bf717a557f3e0309ac3c1b3554ef\">U vraagt subsidie aan vóórdat u start met de verduurzaming of een contract tekent met een aannemer.</li>\n<li data-list-item-id=\"e83ff425f33e942885f1d715f3cf1d543\">U voert verduurzamingsmaatregelen uit op basis van een passend verduurzamingsadvies.</li>\n</ul>\n",
};

/** The DUMAVA page node (trimmed), with its blocks as the page data holds them. */
export const DUMAVA_NODE: Record<string, unknown> = {
  id: DUMAVA_ID,
  title: "Subsidieregeling duurzaam maatschappelijk vastgoed (DUMAVA)",
  type: "subsidy",
  intro: "$19",
  contentElements: [
    { id: "7317174c-6d03-459e-95f9-6f64aa075b59", type: "notice", isWide: false, childElements: [{ id: "e43efdab-6ede-42a8-8a6d-86b0e7ef344d", type: "wysiwyg", text: "" }] },
    {
      id: "648fb27d-b5ef-4d3f-95f2-82578e1c7700",
      type: "frame",
      isWide: false,
      childElements: [
        {
          id: "d40df52c-889d-426a-9c76-bd805178f46c",
          type: "wysiwyg",
          text: "<h2>Advies over uw aanvraag</h2>\n<p>Weet u niet zeker of u voldoet aan de voorwaarden? Neem contact met ons op voor een adviesgesprek.<br><br><a class=\"ck-link--as-button\" href=\"https://www.rvo.nl/subsidies-financiering/dumava/adviesgesprek_formulier\">Vraag een adviesgesprek aan</a></p>\n",
        },
      ],
    },
    { id: "aa75fe1b-8f9a-40b1-b1ba-cb977ce453f6", type: "wysiwyg", text: "$16" },
    {
      id: "6c328f72-9f07-4a8a-85ea-927599e86b71",
      type: "vector_image",
      caption:
        "<ul>\n<li data-list-item-id=\"e1007e70940f1f26aa286b36a5d4c4442\">decentrale overheid, zoals een gebouw met een publieke functie dat eigendom is van de gemeente, provincie of waterschap;</li>\n<li data-list-item-id=\"e0422e6974f12940e5a02929f1a7f5a25\">onderwijs. Dat zijn gebouwen van een basisschool, middelbare school, universiteit, mbo- of hbo-instelling;</li>\n</ul>",
      width: 1000,
      height: 1000,
      uri: "/sites/default/files/2026-06/DUMAVA%20Voor%20wie.svg",
      uriRet: "",
      altText: "",
    },
    {
      id: "a04791e1-f799-4ff7-94d0-d20a78666e39",
      type: "downloads",
      files: [
        {
          id: "f195c263-4459-4bde-b2cd-b5c42f61520f",
          type: "file",
          name: "SBI-codes DUMAVA 2026",
          uri: "/sites/default/files/2026-05/SBI-codes%20Subsidieregeling%20duurzaam%20maatschappelijk%20vastgoed%20%28DUMAVA%29.pdf",
          mimetype: "application/pdf",
          size: 292012,
        },
      ],
    },
    { id: "802d7d27-c8ed-4254-90eb-b90631a1a6e9", type: "wysiwyg", text: "<h2>Hoeveel subsidie krijgt u?</h2>\n" },
    {
      id: "a98e7452-988c-461e-9417-64a8a92ef70d",
      type: "accordion",
      panels: [
        {
          id: "a561ffc3-c0a6-4669-a4ad-b05469d26f5e",
          type: "panel",
          title: "Subsidiebedragen losse maatregelen",
          childElements: [{ id: "81ba4e2a-e72d-42ee-b766-7f8dd468dc26", type: "wysiwyg", text: "$17" }],
        },
      ],
    },
    { id: "2fa29810-e261-41cf-803d-7775f19a00e0", type: "wysiwyg", text: "$18" },
    {
      id: "bb1d2e9e-d515-4e6f-a2c7-6f40a1855e35",
      type: "call_to_action",
      hasBorder: true,
      childElements: [
        {
          id: "e543b076-d6aa-46ac-888e-9b5c94c006c1",
          type: "wysiwyg",
          text: "<h2>Aanvragen</h2>\n<p>Vraag deze subsidie aan vanaf maandag 1 juni 2026, 9:00 uur tot en met vrijdag 16 oktober 2026, 17:00 uur.&nbsp;Voor uw aanvraag heeft u minimaal nodig:&nbsp;eHerkenning&nbsp;niveau 2+ en machtiging RVO diensten op niveau 2+.</p>\n<ul class=\"buttons\">\n<li data-list-item-id=\"eca90bc0c0731c1006757471adce0cbfb\"><a href=\"https://login.rvo.nl/accessrouter/eloket/login2?pwk_gid=a3ccf609-05ef-4f9c-a3c5-8d457eca4d9f\">Direct aanvragen</a></li>\n</ul>\n",
        },
      ],
    },
    { id: "dc010946-4ca9-4656-bc28-061fd4a98164", type: "wysiwyg", text: "<h2>Meer weten?</h2>\n" },
    {
      id: "dfa599c1-8301-4fd5-84e1-1ad9be9e0009",
      type: "accordion",
      panels: [
        {
          id: "d6b605d3-7a6e-4bcc-974d-8f66613a2141",
          type: "panel",
          title: "Officiële wettekst van de regeling",
          childElements: [
            {
              id: "47eed532-cd53-4c6e-8a3a-0497215c0fef",
              type: "links",
              links: [
                { uri: "https://zoek.officielebekendmakingen.nl/stcrt-2026-16962.html", title: "Publicatie Staatscourant 2026" },
                { uri: "https://www.officielebekendmakingen.nl/stcrt-2025-17361.html", title: "Publicatie Staatscourant 2025" },
                { uri: "https://wetten.overheid.nl/BWBR0046993/2023-09-18/0", title: "Publicatie Staatscourant 2023" },
              ],
            },
          ],
        },
      ],
    },
    { id: "0f0e0d0c-0b0a-4909-8807-060504030201", type: "video", uri: "https://www.rvo.nl/video", name: "Uitlegvideo" },
  ],
  startDate: "2026-06-01T09:00:00+02:00",
  endDate: "2026-10-16T17:00:00+02:00",
  budget: {
    negotiation: 206719285,
    total: 405000000,
    budgetDate: "2026-10-12",
    subsidyInformationTitle: "subsidy_amount_budget",
    additionalInfo: "€ 113.301.823 is nog gereserveerd voor integrale verduurzamingsprojecten.",
  },
  disableTime: false,
  subsidyStatus: { type: "taxonomy_term--subsidy_status", id: "94e83236-55c0-4976-a735-5e7c84cb01b8", name: "Open voor aanvragen", color: "#39870c" },
  checked: "2026-10-12T12:00:00+02:00",
  notifications: { subscriptionEnabled: true, changes: "" },
};

export const DUMAVA_INTRO_ROW: Record<string, string> = {
  "19": "<p>Bent u eigenaar van maatschappelijk vastgoed? De subsidieregeling duurzaam maatschappelijk vastgoed (DUMAVA) komt eigenaren van bestaand maatschappelijk vastgoed tegemoet in de kosten om te verduurzamen.</p>",
};

/** Status parts of other pages (contentElements cut to one block). */
export const SWIM_NODE: Record<string, unknown> = {
  id: SWIM_ID,
  title: "Subsidieregeling Waterstof in mobiliteit (SWIM)",
  type: "subsidy",
  contentElements: [{ id: "c1", type: "wysiwyg", text: "<h2>Hoeveel subsidie krijgt u?</h2>\n<p>U krijgt maximaal € 12 miljoen subsidie.</p>" }],
  startDate: "2026-04-01T09:00:00+02:00",
  endDate: "2026-05-13T17:00:00+02:00",
  budget: { total: 45000000, subsidyInformationTitle: "subdidy_budget_term" },
  disableTime: false,
  subsidyStatus: { type: "taxonomy_term--subsidy_status", id: "e8af4b1b-358b-4f8a-b609-4f2804367926", name: "Tijdelijk gesloten voor aanvragen", color: "#f2bfbb" },
  checked: "2026-08-27T12:04:33+02:00",
  notifications: { subscriptionEnabled: true, changes: "" },
};

export const DDP_NODE: Record<string, unknown> = {
  id: DDP_ID,
  title: "Dutch Diamonds Partnerships (DDP)",
  type: "subsidy",
  contentElements: [{ id: "c1", type: "wysiwyg", text: "<p>Het subsidieprogramma stimuleert ook de marktontwikkeling in andere sectoren en waardeketens.</p>" }],
  startDate: "2026-12-07T09:00:00+01:00",
  endDate: "2027-02-15T17:00:00+01:00",
  budget: {
    total: 51000000,
    subsidyInformationTitle: "subsidy_budget",
    additionalInfo: "Het aan te vragen subsidiebedrag is minimaal 500.000 euro en maximaal 3 miljoen euro per aanvraag.",
  },
  disableTime: false,
  subsidyStatus: { type: "taxonomy_term--subsidy_status", id: "94e83236-55c0-4976-a735-5e7c84cb01b8", name: "Open voor aanvragen", color: "#39870c" },
  checked: "2026-10-15T09:50:00+02:00",
  notifications: { subscriptionEnabled: false, changes: "" },
};

export const FVO_NODE: Record<string, unknown> = {
  id: FVO_ID,
  title: "Fonds Verantwoord Ondernemen (FVO)",
  type: "subsidy",
  contentElements: [{ id: "c1", type: "wysiwyg", text: "<p>Het Fonds Verantwoord Ondernemen (FVO) is gesloten. U kunt niet meer aanvragen.</p>" }],
  budget: { subsidyInformationTitle: "subsidy_amount_budget" },
  disableTime: false,
  subsidyStatus: { type: "taxonomy_term--subsidy_status", id: "0a00df3d-3b84-41f1-8fd4-ae46029ae885", name: "Gesloten voor aanvragen", color: "#d51b1e" },
  checked: "2026-10-02T08:55:00+02:00",
  notifications: { subscriptionEnabled: false, changes: "" },
};

export const SEL_NODE: Record<string, unknown> = {
  id: SEL_ID,
  title: "Subsidie emissieloos landbouwmaterieel (SEL)",
  type: "subsidy",
  description: "Minimaal € 3.000, maximaal € 600.000",
  contentElements: [{ id: "c1", type: "wysiwyg", text: "<p>Er zijn meer aanvragen dan er geld beschikbaar is.</p>" }],
  startDate: "2026-06-02T09:00:00+02:00",
  endDate: "2026-10-02T17:00:00+02:00",
  budget: {
    negotiation: 57559747,
    total: 23600000,
    descriptionTitle: "Hoogte subsidie",
    subsidyInformationTitle: "subdidy_budget_term",
    additionalInfo: "Er zijn meer aanvragen dan er geld beschikbaar is. Met een loting is bepaald in welke volgorde we de aanvragen behandelen.",
  },
  disableTime: false,
  subsidyStatus: { type: "taxonomy_term--subsidy_status", id: "e8af4b1b-358b-4f8a-b609-4f2804367926", name: "Tijdelijk gesloten voor aanvragen", color: "#f2bfbb" },
  checked: "2026-10-02T17:00:00+02:00",
  notifications: { subscriptionEnabled: true, changes: "De subsidie sluit op 2 oktober om 17:00 uur. We hebben de webpagina hierop aangepast. " },
};

export const SEB_NODE: Record<string, unknown> = {
  id: SEB_ID,
  title: "Subsidie Sociaal-economische begeleiding (SEB) ",
  type: "subsidy",
  description: "1.000.000 tot maximaal € 2.950.000",
  contentElements: [{ id: "c1", type: "wysiwyg", text: "<p>Vraag dan subsidie aan om een provinciaal knooppunt te starten.</p>" }],
  startDate: "2026-11-17T09:00:00+01:00",
  endDate: "2026-12-17T17:00:00+01:00",
  budget: { total: 35400000, descriptionTitle: "Subsidiebedrag:", subsidyInformationTitle: "subsidy_amount_term" },
  disableTime: false,
  subsidyStatus: { type: "taxonomy_term--subsidy_status", id: "7c18f9f2-91da-4eb7-8488-55f50f25492e", name: "Bijna open voor aanvragen", color: "#c3dbb6" },
  checked: "2026-10-14T10:00:00+02:00",
  notifications: { subscriptionEnabled: true, changes: "" },
};

/** A node of a page that is not the regeling (all page nodes share these extra keys). */
const NODE_EXTRAS = { status: true, created: "2022-03-23T15:01:08+01:00", changed: "2026-10-12T10:50:25+02:00" };

/**
 * The page's flight payload as rvo.nl renders it: a bootstrap row, the text rows, the
 * row holding the node, and a second copy of the node that only points back to the
 * first (the way Next.js dedupes it). Text rows have no line end of their own.
 */
export function rvoFlight(args: { id: string; node: Record<string, unknown>; textRows?: Record<string, string>; decoyFirst?: boolean }): string {
  const text = Object.entries(args.textRows ?? {})
    .map(([ref, t]) => `${ref}:T${Buffer.byteLength(t, "utf8").toString(16)},${t}`)
    .join("");
  const nodeRow = `5:["$","$L1e",null,{"children":["$","div",null,{"node":${JSON.stringify({ ...args.node, ...NODE_EXTRAS })}}]}]\n`;
  const decoy = `6:["$","$L1f",null,{"node":{"id":"${args.id}","subsidyStatus":"$5:props:children:props:node:subsidyStatus","contentElements":"$5:props:children:props:node:contentElements"}}]\n`;
  const head = `0:{"P":null,"b":"build","p":"","c":["","subsidies-financiering"],"i":false}\n1e:I[3341,["static/chunks/1.js"],"SubsidyPage"]\n`;
  return head + (args.decoyFirst ? decoy + text + nodeRow : text + nodeRow + decoy);
}

/** A page of rvo.nl around a flight payload: canonical link, status flag, the payload in script chunks. */
export function rvoPageHtml(args: {
  path: string;
  flight?: string;
  canonical?: string;
  flag?: string;
  chunkSize?: number;
}): string {
  const size = args.chunkSize ?? 400;
  const chunks: string[] = [];
  const flight = args.flight ?? "";
  for (let i = 0; i < flight.length; i += size) chunks.push(flight.slice(i, i + size));
  const scripts = chunks.map((c) => `<script>self.__next_f.push([1,${JSON.stringify(c)}])</script>`).join("");
  const flag = args.flag
    ? `<div class="subsidy-flag-wrapper"><span aria-hidden="true" role="note" class="Flag_a-flag__R6us_ Flag_a-flag-tag__9IoV2"><span class="Flag_a-flag-flag__oT3ao" style="background-color:#f2bfbb"></span><span>${args.flag}</span></span></div>`
    : "";
  return (
    `<!DOCTYPE html><html lang="nl"><head><meta charSet="utf-8"/><title>RVO.nl</title>` +
    `<link rel="canonical" href="${args.canonical ?? `https://www.rvo.nl${args.path}`}"/></head>` +
    `<body><h1 class="rvo-heading"><div class="rvo-heading__content">Pagina</div></h1>${flag}` +
    `<script>(self.__next_f=self.__next_f||[]).push([0])</script>${scripts}</body></html>`
  );
}

/** The page of a fixture row with the given node (and text rows). */
export function rvoNodePage(path: string, id: string, node: Record<string, unknown>, textRows?: Record<string, string>): string {
  return rvoPageHtml({ path, flight: rvoFlight({ id, node, textRows }) });
}
