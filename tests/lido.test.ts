import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { clampLidoRows, LidoSource, normalizeLidoType, parseLidoId } from "../src/sources/lido.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { SourceRequestError } from "../src/utils/http.js";
import { testConfig, xmlResponse } from "./helpers/config.js";

const HEAD = `<?xml version="1.0" encoding="UTF-8"?>`;

function perTypeXml(id: string, extId: string, counts: Array<[string, number]>): string {
  const enc = encodeURIComponent(id);
  const aantallen = counts
    .map(
      ([label, n]) =>
        `<aantal informatietype-label="${label}" url="https://linkeddata.overheid.nl/front/portal/spiegel-lijstweergave?id=${enc}&amp;fq=%7B%21tag%3Dobj_type%7Dobj_type%3A%22${label}%22">${n}</aantal>`,
    )
    .join("");
  return `${HEAD}<lido service="get-aantal-per-informatietype" id="${id}" ext-id="${extId}">${aantallen}</lido>`;
}

const ECLI_XML = perTypeXml(
  "http://linkeddata.overheid.nl/terms/jurisprudentie/id/ECLI:NL:HR:2019:2006",
  "ECLI:NL:HR:2019:2006",
  [
    ["Verdrag", 20],
    ["Jurisprudentie", 126],
    ["Wet", 14],
  ],
);
const CELEX_XML = perTypeXml(
  "http://linkeddata.overheid.nl/terms/eu-regelgeving/id/32016L0680",
  "CELEX:32016L0680",
  [
    ["Wet", 5],
    ["Jurisprudentie", 954],
  ],
);
const OEP_XML = perTypeXml("http://linkeddata.overheid.nl/terms/oep/id/stb-2018-401", "OEP:stb-2018-401", [
  ["Wet", 171],
  ["Jurisprudentie", 25],
]);
const BWB_ID = "http://linkeddata.overheid.nl/terms/bwb/id/BWBR0011823/1384514/2026-06-12/2026-06-12";
const GET_ID_XML = `${HEAD}<lido service="get-id" juriconnect-ref="BWBR0011823&amp;artikel=29"><id>${BWB_ID}</id></lido>`;
const GET_ID_EMPTY_XML = `${HEAD}<lido service="get-id" juriconnect-ref="BWBR0011353&amp;artikel=8"></lido>`;
const BWB_APIT_XML = `${HEAD}<lido service="get-aantal-per-informatietype" id="${BWB_ID}"><aantal informatietype-label="Jurisprudentie" url="x">42</aantal></lido>`;
const UNKNOWN_XML = `${HEAD}<lido service="get-aantal-per-informatietype" id="" ext-id="ECLI:NL:HR:2099:9999"></lido>`;

function calledUrl(fetchMock: ReturnType<typeof vi.fn>, i: number): URL {
  return new URL(String((fetchMock.mock.calls[i] as unknown as Array<unknown>)[0]));
}

describe("parseLidoId", () => {
  it("recognises the supported identifier kinds", () => {
    expect(parseLidoId("ECLI:NL:HR:2019:2006")).toEqual({ kind: "ecli", value: "ECLI:NL:HR:2019:2006" });
    expect(parseLidoId(" ecli:nl:hr:1998:aa9342 ")).toEqual({ kind: "ecli", value: "ECLI:NL:HR:1998:AA9342" });
    expect(parseLidoId("CELEX:32016L0680")).toEqual({ kind: "celex", value: "32016L0680" });
    expect(parseLidoId("32016L0680")).toEqual({ kind: "celex", value: "32016L0680" });
    expect(parseLidoId("62014CJ0362")).toEqual({ kind: "celex", value: "62014CJ0362" });
    expect(parseLidoId("BWBR0011823")).toEqual({ kind: "bwb", value: "BWBR0011823" });
    expect(parseLidoId("stb-2018-401")).toEqual({ kind: "oep", value: "stb-2018-401" });
    expect(parseLidoId("stcrt-2024-20264")).toEqual({ kind: "oep", value: "stcrt-2024-20264" });
    expect(parseLidoId("OEP:stb-2018-401")).toEqual({ kind: "oep", value: "stb-2018-401" });
  });

  it("rejects anything else", () => {
    for (const bad of ["", "hallo", "BWBR001", "ECLI:NL:HR", "32016L0680&x=1", "stb-2018-401 OR 1", "https://example.org"]) {
      expect(parseLidoId(bad)).toBeNull();
    }
  });
});

describe("LidoSource.references", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("counts references for an ECLI via get-aantal-per-informatietype", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(ECLI_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).references({ id: "ECLI:NL:HR:2019:2006" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = calledUrl(fetchMock, 0);
    expect(url.pathname).toBe("/service/get-aantal-per-informatietype");
    expect(url.searchParams.get("ext-id")).toBe("ECLI:NL:HR:2019:2006");

    expect(out.total).toBe(1);
    expect(out.items).toHaveLength(1);
    const item = out.items[0];
    expect(item.kind).toBe("ecli");
    expect(item.artikel).toBeNull();
    expect(item.lido_id).toBe("http://linkeddata.overheid.nl/terms/jurisprudentie/id/ECLI:NL:HR:2019:2006");
    expect(item.total_references).toBe(160);
    expect(item.per_type).toEqual([
      { type: "Jurisprudentie", count: 126 },
      { type: "Verdrag", count: 20 },
      { type: "Wet", count: 14 },
    ]);
    expect(new URL(String(item.portal_url)).searchParams.get("ext-id")).toBe("ECLI:NL:HR:2019:2006");
    expect(item.title).toBe("LiDO-verwijzingen naar ECLI:NL:HR:2019:2006");
    expect(out.access_note).toContain("CC0");
    expect(out.access_note).toContain("portal_url");
  });

  it("prefixes CELEX: for EU legislation", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(CELEX_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).references({ id: "32016L0680" });

    expect(calledUrl(fetchMock, 0).searchParams.get("ext-id")).toBe("CELEX:32016L0680");
    expect(out.items[0].kind).toBe("celex");
    expect(out.items[0].total_references).toBe(959);
    expect((out.items[0].per_type as Array<{ type: string }>)[0].type).toBe("Jurisprudentie");
  });

  it("prefixes OEP: for official publications", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(OEP_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).references({ id: "stb-2018-401" });

    expect(calledUrl(fetchMock, 0).searchParams.get("ext-id")).toBe("OEP:stb-2018-401");
    expect(out.items[0].kind).toBe("oep");
    expect(out.items[0].total_references).toBe(196);
  });

  it("resolves a BWB article with get-id first, then counts by LiDO id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xmlResponse(GET_ID_XML))
      .mockResolvedValueOnce(xmlResponse(BWB_APIT_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).references({ id: "BWBR0011823", artikel: "29" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = calledUrl(fetchMock, 0);
    expect(first.pathname).toBe("/service/get-id");
    expect(first.searchParams.get("juriconnect-ref")).toBe("BWBR0011823&artikel=29");
    const second = calledUrl(fetchMock, 1);
    expect(second.pathname).toBe("/service/get-aantal-per-informatietype");
    expect(second.searchParams.get("id")).toBe(BWB_ID);

    const item = out.items[0];
    expect(item.kind).toBe("bwb");
    expect(item.artikel).toBe("29");
    expect(item.lido_id).toBe(BWB_ID);
    expect(item.total_references).toBe(42);
    expect(new URL(String(item.portal_url)).searchParams.get("id")).toBe(BWB_ID);
    expect(item.title).toBe("LiDO-verwijzingen naar BWBR0011823 artikel 29");
    expect(out.access_note).toContain("oudere");
  });

  it("returns no items when get-id finds no BWB element", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(GET_ID_EMPTY_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).references({ id: "BWBR0011353", artikel: "8" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
  });

  it("returns no items when LiDO does not know the identifier", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => xmlResponse(UNKNOWN_XML)));

    const out = await new LidoSource(testConfig).references({ id: "ECLI:NL:HR:2099:9999" });

    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
  });

  it("rejects invalid identifiers and articles without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const src = new LidoSource(testConfig);

    await expect(src.references({ id: "geen-id" })).rejects.toThrow("Onbekend LiDO-identifier");
    await expect(src.references({ id: "BWBR0011823", artikel: "29&x=1" })).rejects.toThrow("artikelnummer");
    await expect(src.references({ id: "ECLI:NL:HR:2019:2006", artikel: "1" })).rejects.toThrow("BWB");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// get-links: de lijst met gekoppelde documenten (lido_verwijzingen_lijst)
// ---------------------------------------------------------------------------

const DC = 'xmlns:dcterms="http://purl.org/dc/terms/"';
const RL = 'xmlns:overheidrl="http://linkeddata.overheid.nl/terms/"';
const OH = 'xmlns:overheid="http://standaarden.overheid.nl/owms/terms/"';
const LX = "http://linkeddata.overheid.nl/terms/linktype/id/lx-referentie";

const SELF_ID = "http://linkeddata.overheid.nl/terms/jurisprudentie/id/ECLI:NL:HR:2019:2006";
const TREATY_ID = "http://linkeddata.overheid.nl/terms/bwb/id/BWBV0006603/10005350914/2017-08-27/2017-08-27";
const CITING_ID = "http://linkeddata.overheid.nl/terms/jurisprudentie/id/ECLI:NL:GHSHE:2024:3563";
const MUTUAL_ID = "http://linkeddata.overheid.nl/terms/jurisprudentie/id/ECLI:NL:PHR:2019:887";

function ref(idref: string, label: string, type = LX): string {
  return `<subject-ref type="${type}" idref="${idref}" groep="Jurisprudentie" kleur="#CA005A" label="${label}"></subject-ref>`;
}

function facets(objType: Array<[string, number]>, linkType: Array<[string, number]>): string {
  const ints = (pairs: Array<[string, number]>) => pairs.map(([n, c]) => `<int name="${n}">${c}</int>`).join("");
  return (
    `<facetten><facet name="obj_type">${ints(objType)}</facet>` +
    `<facet name="obj_organisatie"><int name="Gerechtshof &#39;s-Hertogenbosch">1</int></facet>` +
    `<facet name="obj_jaar"><int name="2019">8</int></facet>` +
    `<facet name="link_type">${ints(linkType)}</facet></facetten>`
  );
}

function selfSubject(id: string, incoming: string, outgoing: string): string {
  return (
    `<subject id="${id}"><dcterms:creator ${DC}>Hoge Raad der Nederlanden</dcterms:creator>` +
    `<dcterms:identifier type="intern" ${DC}>${id}</dcterms:identifier><overheidrl:aantal-links ${RL}></overheidrl:aantal-links>` +
    `<dcterms:identifier ${DC} type="extern">ECLI:NL:HR:2019:2006</dcterms:identifier>` +
    `<dcterms:type ${DC} resourceIdentifier="http://linkeddata.overheid.nl/terms/Jurisprudentie">Jurisprudentie</dcterms:type>` +
    `<dcterms:hasVersion ${DC}>http://deeplink.rechtspraak.nl/uitspraak?id=ECLI:NL:HR:2019:2006</dcterms:hasVersion>` +
    `<dcterms:modified ${DC}>2022-02-03T10:04:03Z</dcterms:modified>` +
    `<dcterms:title ${DC}>ECLI:NL:HR:2019:2006 - Hoge Raad, 20-12-2019 / 19/00135</dcterms:title>` +
    `<inkomende-links>${incoming}</inkomende-links><uitgaande-links>${outgoing}</uitgaande-links></subject>`
  );
}

const TREATY_SUBJECT =
  `<subject id="${TREATY_ID}"><dcterms:identifier ${DC} type="intern">${TREATY_ID}</dcterms:identifier>` +
  `<dcterms:identifier ${DC} type="extern">http://wetten.overheid.nl/id/BWBV0006603/2017-08-27/0</dcterms:identifier>` +
  `<dcterms:type resourceIdentifier="http://linkeddata.overheid.nl/terms/Verdrag" ${DC}>Verdrag</dcterms:type>` +
  `<dcterms:hasVersion ${DC}>http://wetten.overheid.nl/1.0:c:BWBV0006603&amp;g=2017-08-27</dcterms:hasVersion>` +
  `<dcterms:modified ${DC}>2017-08-27T00:00:00Z</dcterms:modified><dcterms:title ${DC}>Overeenkomst van Parijs</dcterms:title>` +
  `<overheidrl:isGeldigVanaf ${RL}>2017-08-27</overheidrl:isGeldigVanaf>` +
  `<overheidrl:heeftJuriconnect ${RL}>1.0:c:BWBV0006603&amp;g=2017-08-27</overheidrl:heeftJuriconnect>` +
  `<overheidrl:heeftJuriconnect ${RL}>jci1.3:c:BWBV0006603&amp;z=2017-08-27&amp;g=2017-08-27</overheidrl:heeftJuriconnect>` +
  `<overheid:authority ${OH}>Buitenlandse Zaken</overheid:authority>` +
  `<inkomende-links>${ref(SELF_ID, "Door computer herkende referentie")}</inkomende-links><uitgaande-links></uitgaande-links></subject>`;

const CITING_REFS = ref(SELF_ID, "Door computer herkende referentie") + ref(SELF_ID, "Door computer herkende referentie");

function citingSubject(outgoingRefs: string): string {
  return (
    `<subject id="${CITING_ID}"><dcterms:creator ${DC}>Gerechtshof &#39;s-Hertogenbosch</dcterms:creator>` +
    `<dcterms:identifier ${DC} type="intern">${CITING_ID}</dcterms:identifier>` +
    `<dcterms:identifier ${DC} type="extern">ECLI:NL:GHSHE:2024:3563</dcterms:identifier>` +
    `<dcterms:type ${DC} resourceIdentifier="http://linkeddata.overheid.nl/terms/Jurisprudentie">Jurisprudentie</dcterms:type>` +
    `<dcterms:hasVersion ${DC}>http://deeplink.rechtspraak.nl/uitspraak?id=ECLI:NL:GHSHE:2024:3563</dcterms:hasVersion>` +
    `<dcterms:title ${DC}>ECLI:NL:GHSHE:2024:3563 - Gerechtshof &#39;s-Hertogenbosch, Curaçao-zaak</dcterms:title>` +
    `<dcterms:title ${DC}>Tweede titel die genegeerd wordt</dcterms:title>` +
    `<inkomende-links></inkomende-links><uitgaande-links>${outgoingRefs}</uitgaande-links></subject>`
  );
}

// Zonder hasVersion: het record valt terug op de portal-URL.
const MUTUAL_SUBJECT =
  `<subject id="${MUTUAL_ID}"><dcterms:identifier ${DC} type="extern">ECLI:NL:PHR:2019:887</dcterms:identifier>` +
  `<dcterms:type ${DC}>Jurisprudentie</dcterms:type><dcterms:title ${DC}>Conclusie PG</dcterms:title>` +
  `<inkomende-links>${ref(SELF_ID, "Conclusie")}</inkomende-links><uitgaande-links>${ref(SELF_ID, "Arrest Hoge Raad")}</uitgaande-links></subject>`;

const SELF_INCOMING =
  ref(CITING_ID, "Door computer herkende referentie") + ref(CITING_ID, "Door computer herkende referentie") + ref(MUTUAL_ID, "Arrest Hoge Raad");
const SELF_OUTGOING =
  ref(TREATY_ID, "Door computer herkende referentie") + ref(MUTUAL_ID, "Conclusie", "http://linkeddata.overheid.nl/terms/linktype/id/rvr-conclusie-eerdereaanleg");

function linksXml(selfBlock: string): string {
  return (
    `${HEAD}<lido service="get-links" ext-id="ECLI:NL:HR:2019:2006" lido-id="${SELF_ID}"><paginering><start>20</start><rows>3</rows></paginering>` +
    facets(
      [
        ["Jurisprudentie", 126],
        ["Officiele overheidspublicatie", 7],
        ["Verdrag", 20],
        ["Wet", 14],
      ],
      [
        ["Door computer herkende referentie", 163],
        ["Conclusie", 1],
        ["Arrest Hoge Raad", 1],
      ],
    ) +
    selfBlock +
    TREATY_SUBJECT +
    citingSubject(CITING_REFS) +
    MUTUAL_SUBJECT +
    `</lido>`
  );
}

const LINKS_XML = linksXml(selfSubject(SELF_ID, SELF_INCOMING, SELF_OUTGOING));

// LiDO geeft één entry per verwijzing: CITING (dezelfde verwijzing twee keer) en
// MUTUAL (beide richtingen) staan er elk twee keer, direct na elkaar.
const DUP_XML =
  `${HEAD}<lido service="get-links" ext-id="ECLI:NL:HR:2019:2006" lido-id="${SELF_ID}"><paginering><start>0</start><rows>5</rows></paginering>` +
  facets(
    [
      ["Jurisprudentie", 4],
      ["Verdrag", 1],
    ],
    [
      ["Door computer herkende referentie", 3],
      ["Conclusie", 1],
      ["Arrest Hoge Raad", 1],
    ],
  ) +
  selfSubject(SELF_ID, SELF_INCOMING, SELF_OUTGOING) +
  TREATY_SUBJECT +
  citingSubject(CITING_REFS) +
  citingSubject(CITING_REFS) +
  MUTUAL_SUBJECT +
  MUTUAL_SUBJECT +
  `</lido>`;

// Type-filter "Wet": één gekoppeld item, één subject-ref (geen array).
const WET_ID = "http://linkeddata.overheid.nl/terms/bwb/id/BWBR0001903/1/2020-01-01/2020-01-01";
const WET_XML =
  `${HEAD}<lido service="get-links" ext-id="ECLI:NL:HR:2019:2006" lido-id="${SELF_ID}"><paginering><start>0</start><rows>20</rows></paginering>` +
  facets([["Wet", 14]], [["Door computer herkende referentie", 14]]) +
  selfSubject(SELF_ID, "", ref(WET_ID, "Door computer herkende referentie")) +
  `<subject id="${WET_ID}"><dcterms:type ${DC}>Wet</dcterms:type><dcterms:title ${DC}>Wetboek van Strafrecht, Artikel 1</dcterms:title>` +
  `<dcterms:hasVersion ${DC}>http://wetten.overheid.nl/1.0:c:BWBR0001854</dcterms:hasVersion>` +
  `<inkomende-links>${ref(SELF_ID, "Door computer herkende referentie")}</inkomende-links></subject></lido>`;

// Bekend item zonder koppelingen: alleen het item zelf (één subject, geen array).
const LONELY_ID = "http://linkeddata.overheid.nl/terms/jurisprudentie/id/ECLI:NL:RBAMS:2020:1";
const LONELY_XML =
  `${HEAD}<lido service="get-links" ext-id="ECLI:NL:RBAMS:2020:1" lido-id="${LONELY_ID}"><paginering><start>0</start><rows>20</rows></paginering>` +
  `<facetten><facet name="obj_type"></facet><facet name="obj_organisatie"></facet><facet name="obj_jaar"></facet><facet name="link_type"></facet></facetten>` +
  `<subject id="${LONELY_ID}"><dcterms:title ${DC}>Eenzame uitspraak</dcterms:title><inkomende-links></inkomende-links><uitgaande-links></uitgaande-links></subject></lido>`;

// get-links?id=<onbekend> geeft 200 zonder enig subject.
const NO_SUBJECT_XML =
  `${HEAD}<lido service="get-links" id="${BWB_ID}" lido-id="${BWB_ID}"><paginering><start>0</start><rows>20</rows></paginering>` +
  `<facetten><facet name="obj_type"></facet><facet name="obj_organisatie"></facet><facet name="obj_jaar"></facet><facet name="link_type"></facet></facetten></lido>`;

const BWB_LINKS_XML =
  `${HEAD}<lido service="get-links" id="${BWB_ID}" lido-id="${BWB_ID}"><paginering><start>0</start><rows>20</rows></paginering>` +
  facets([["Jurisprudentie", 1]], [["Door computer herkende referentie", 1]]) +
  `<subject id="${BWB_ID}"><dcterms:title ${DC}>Wet op het financieel toezicht, Artikel 29</dcterms:title>` +
  `<inkomende-links>${ref(CITING_ID, "Door computer herkende referentie")}</inkomende-links><uitgaande-links></uitgaande-links></subject>` +
  citingSubject(ref(BWB_ID, "Door computer herkende referentie")) +
  `</lido>`;

const LIDO_USER = "lido-test-user";
const LIDO_PASS = "s3cr3t-Pa55";
const LIDO_BASIC = `Basic ${Buffer.from(`${LIDO_USER}:${LIDO_PASS}`, "utf8").toString("base64")}`;

function calledHeaders(fetchMock: ReturnType<typeof vi.fn>, i: number): Record<string, string> {
  const init = (fetchMock.mock.calls[i] as unknown as Array<unknown>)[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

function hasAuthorization(fetchMock: ReturnType<typeof vi.fn>, i: number): boolean {
  return Object.keys(calledHeaders(fetchMock, i)).some((k) => k.toLowerCase() === "authorization");
}

function setLidoCredentials(user: string, pass: string): void {
  vi.stubEnv("LIDO_USERNAME", user);
  vi.stubEnv("LIDO_PASSWORD", pass);
}

describe("normalizeLidoType / clampLidoRows", () => {
  it("accepts informatietype labels and maps known ones to LiDO's exact spelling", () => {
    expect(normalizeLidoType(undefined)).toBeNull();
    expect(normalizeLidoType("   ")).toBeNull();
    expect(normalizeLidoType("Wet")).toBe("Wet");
    expect(normalizeLidoType(" wet ")).toBe("Wet");
    expect(normalizeLidoType("JURISPRUDENTIE")).toBe("Jurisprudentie");
    expect(normalizeLidoType("ministeriele-regeling")).toBe("Ministeriële-regeling");
    expect(normalizeLidoType("Officiële overheidspublicatie")).toBe("Officiele overheidspublicatie");
    expect(normalizeLidoType("regeling zbo")).toBe("Regeling ZBO");
    // Geldig maar niet in de bekende lijst: ongewijzigd door.
    expect(normalizeLidoType("Kamerstuk")).toBe("Kamerstuk");
    expect(normalizeLidoType("Wet 2")).toBe("Wet 2");
  });

  it("rejects anything that could break out of the Solr filter", () => {
    const attempts = [
      'Wet" OR obj_type:"Jurisprudentie',
      'Wet"',
      "Wet\\",
      "obj_type:Wet",
      "*:*",
      "{!lucene}Wet",
      "Wet) OR (x",
      "Wet\nJurisprudentie",
      "Wet\tBES",
      "Wet&rows=1000",
      "Wet;",
      "W".repeat(61),
    ];
    for (const bad of attempts) {
      expect(() => normalizeLidoType(bad), bad).toThrow("Ongeldig informatietype");
    }
  });

  it("clamps rows to 1..100 with LiDO's default of 20", () => {
    expect(clampLidoRows(undefined)).toBe(20);
    expect(clampLidoRows(Number.NaN)).toBe(20);
    expect(clampLidoRows(0)).toBe(1);
    expect(clampLidoRows(-5)).toBe(1);
    expect(clampLidoRows(5)).toBe(5);
    expect(clampLidoRows(100)).toBe(100);
    expect(clampLidoRows(150)).toBe(100);
    expect(clampLidoRows(7.9)).toBe(7);
  });
});

describe("LidoSource.links", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    // Deterministisch: een echte .env of shell-variabele mag deze tests niet beïnvloeden.
    setLidoCredentials("", "");
    clearHttpCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses get-links: items, direction, labels, total and facets", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(LINKS_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).links({ id: "ECLI:NL:HR:2019:2006", offset: 20, limit: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = calledUrl(fetchMock, 0);
    expect(url.pathname).toBe("/service/get-links");
    expect(url.searchParams.get("ext-id")).toBe("ECLI:NL:HR:2019:2006");
    expect(url.searchParams.get("output")).toBe("xml");
    expect(url.searchParams.get("start")).toBe("20");
    expect(url.searchParams.get("rows")).toBe("3");
    expect(url.searchParams.has("fq")).toBe(false);

    // total = som van de obj_type-facetten, niet het aantal items op deze pagina.
    expect(out.total).toBe(167);
    expect(out.offset).toBe(20);
    expect(out.limit).toBe(3);
    expect(out.page_entries).toBe(3);
    expect(out.lido_id).toBe(SELF_ID);
    expect(out.subject_title).toBe("ECLI:NL:HR:2019:2006 - Hoge Raad, 20-12-2019 / 19/00135");
    expect(new URL(String(out.portal_url)).searchParams.get("ext-id")).toBe("ECLI:NL:HR:2019:2006");
    expect(out.per_type).toEqual([
      { type: "Jurisprudentie", count: 126 },
      { type: "Verdrag", count: 20 },
      { type: "Wet", count: 14 },
      { type: "Officiele overheidspublicatie", count: 7 },
    ]);
    expect(out.per_link_type[0]).toEqual({ label: "Door computer herkende referentie", count: 163 });
    expect(out.params).toMatchObject({ id: "ECLI:NL:HR:2019:2006", "ext-id": "ECLI:NL:HR:2019:2006", start: "20", rows: "3" });
    expect(out.access_note).toContain("CC0");
    expect(out.access_note).toContain("get-links");

    // Het opgevraagde item zelf is geen gekoppeld document.
    expect(out.items).toHaveLength(3);
    const [treaty, citing, mutual] = out.items;

    expect(treaty).toEqual({
      lido_id: TREATY_ID,
      external_id: "http://wetten.overheid.nl/id/BWBV0006603/2017-08-27/0",
      title: "Overeenkomst van Parijs",
      type: "Verdrag",
      type_uri: "http://linkeddata.overheid.nl/terms/Verdrag",
      creator: null,
      authority: "Buitenlandse Zaken",
      modified: "2017-08-27T00:00:00Z",
      url: "http://wetten.overheid.nl/1.0:c:BWBV0006603&g=2017-08-27",
      direction: "uitgaand",
      link_labels: ["Door computer herkende referentie"],
      juriconnect: "1.0:c:BWBV0006603&g=2017-08-27",
    });

    // Herhaalde subject-refs met hetzelfde label → één label; herhaalde titel → de eerste.
    expect(citing.direction).toBe("inkomend");
    expect(citing.link_labels).toEqual(["Door computer herkende referentie"]);
    expect(citing.title).toBe("ECLI:NL:GHSHE:2024:3563 - Gerechtshof 's-Hertogenbosch, Curaçao-zaak");
    expect(citing.creator).toBe("Gerechtshof 's-Hertogenbosch");
    expect(citing.authority).toBeNull();
    expect(citing.external_id).toBe("ECLI:NL:GHSHE:2024:3563");

    // In beide lijsten van het opgevraagde item → "beide", met alle labels.
    expect(mutual.direction).toBe("beide");
    expect(mutual.link_labels).toEqual(["Conclusie", "Arrest Hoge Raad"]);
    expect(mutual.url).toBeNull();
    expect(mutual.lido_id).toBe(MUTUAL_ID);
  });

  it("lists a document with several links once per page, but keeps LiDO's entry count for paging", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => xmlResponse(DUP_XML)));

    const out = await new LidoSource(testConfig).links({ id: "ECLI:NL:HR:2019:2006", limit: 5 });

    expect(out.total).toBe(5);
    expect(out.page_entries).toBe(5);
    expect(out.items.map((i) => i.lido_id)).toEqual([TREATY_ID, CITING_ID, MUTUAL_ID]);
    expect(out.items[2]).toMatchObject({ direction: "beide", link_labels: ["Conclusie", "Arrest Hoge Raad"] });
  });

  it("handles a single subject (the item itself) and zero links", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => xmlResponse(LONELY_XML)));

    const out = await new LidoSource(testConfig).links({ id: "ECLI:NL:RBAMS:2020:1" });

    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.lido_id).toBe(LONELY_ID);
    expect(out.subject_title).toBe("Eenzame uitspraak");
    expect(out.per_type).toEqual([]);
  });

  it("falls back to the mirrored relation when the item's own link lists are empty", async () => {
    const xml = linksXml(selfSubject(SELF_ID, "", ""));
    vi.stubGlobal("fetch", vi.fn(async () => xmlResponse(xml)));

    const out = await new LidoSource(testConfig).links({ id: "ECLI:NL:HR:2019:2006" });

    expect(out.items.map((i) => i.direction)).toEqual(["uitgaand", "inkomend", "beide"]);
  });

  it("uses LiDO's default rows and clamps offset/limit before calling get-links", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(LINKS_XML));
    vi.stubGlobal("fetch", fetchMock);
    const src = new LidoSource(testConfig);

    await src.links({ id: "ECLI:NL:HR:2019:2006" });
    expect(calledUrl(fetchMock, 0).searchParams.get("start")).toBe("0");
    expect(calledUrl(fetchMock, 0).searchParams.get("rows")).toBe("20");

    clearHttpCache();
    const out = await src.links({ id: "ECLI:NL:HR:2019:2006", offset: -3, limit: 500 });
    expect(calledUrl(fetchMock, 1).searchParams.get("start")).toBe("0");
    expect(calledUrl(fetchMock, 1).searchParams.get("rows")).toBe("100");
    expect(out.limit).toBe(100);
  });

  it("sends the type filter as LiDO's obj_type filter query", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(WET_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).links({ id: "ECLI:NL:HR:2019:2006", type: "wet" });

    expect(calledUrl(fetchMock, 0).searchParams.get("fq")).toBe('{!tag=obj_type}obj_type:"Wet"');
    expect(out.type_filter).toBe("Wet");
    expect(out.params.type).toBe("Wet");
    expect(out.total).toBe(14);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ lido_id: WET_ID, direction: "uitgaand", type: "Wet" });
  });

  it("rejects invalid identifiers, articles and type filters without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const src = new LidoSource(testConfig);

    await expect(src.links({ id: "geen-id" })).rejects.toThrow("Onbekend LiDO-identifier");
    await expect(src.links({ id: "BWBR0011823", artikel: "29&x=1" })).rejects.toThrow("artikelnummer");
    await expect(src.links({ id: "ECLI:NL:HR:2019:2006", artikel: "1" })).rejects.toThrow("BWB");
    await expect(src.links({ id: "ECLI:NL:HR:2019:2006", type: 'Wet" OR obj_type:"Verdrag' })).rejects.toThrow("Ongeldig informatietype");
    await expect(src.links({ id: "ECLI:NL:HR:2019:2006", type: "{!lucene}*:*" })).rejects.toThrow("Ongeldig informatietype");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a BWB article with get-id, then lists links by LiDO id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xmlResponse(GET_ID_XML))
      .mockResolvedValueOnce(xmlResponse(BWB_LINKS_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).links({ id: "BWBR0011823", artikel: "29" });

    expect(calledUrl(fetchMock, 0).pathname).toBe("/service/get-id");
    expect(calledUrl(fetchMock, 0).searchParams.get("juriconnect-ref")).toBe("BWBR0011823&artikel=29");
    const second = calledUrl(fetchMock, 1);
    expect(second.pathname).toBe("/service/get-links");
    expect(second.searchParams.get("id")).toBe(BWB_ID);
    expect(second.searchParams.has("ext-id")).toBe(false);

    expect(out.lido_id).toBe(BWB_ID);
    expect(new URL(String(out.portal_url)).searchParams.get("id")).toBe(BWB_ID);
    expect(out.total).toBe(1);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ lido_id: CITING_ID, direction: "inkomend" });
    expect(out.params["juriconnect-ref"]).toBe("BWBR0011823&artikel=29");
    expect(out.access_note).toContain("oudere");
  });

  it("returns nothing when get-id finds no BWB element", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(GET_ID_EMPTY_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).links({ id: "BWBR0011353", artikel: "8" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.lido_id).toBeNull();
    expect(out.portal_url).toBeNull();
  });

  it("returns nothing when get-links has no subject for a LiDO id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xmlResponse(GET_ID_XML))
      .mockResolvedValueOnce(xmlResponse(NO_SUBJECT_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).links({ id: "BWBR0011823", artikel: "29" });

    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.lido_id).toBeNull();
    expect(out.portal_url).toBeNull();
  });

  it("treats get-links' empty HTTP 400 as unknown only after get-aantal-per-informatietype confirms it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xmlResponse("", 400))
      .mockResolvedValueOnce(xmlResponse(UNKNOWN_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).links({ id: "ECLI:NL:HR:2099:9999" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calledUrl(fetchMock, 1).pathname).toBe("/service/get-aantal-per-informatietype");
    expect(calledUrl(fetchMock, 1).searchParams.get("ext-id")).toBe("ECLI:NL:HR:2099:9999");
    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.lido_id).toBeNull();
    expect(out.portal_url).toBeNull();
  });

  it("rethrows a get-links 400 for an item LiDO does know", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xmlResponse("", 400))
      .mockResolvedValueOnce(xmlResponse(ECLI_XML));
    vi.stubGlobal("fetch", fetchMock);

    const err = await new LidoSource(testConfig).links({ id: "ECLI:NL:HR:2019:2006" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SourceRequestError);
    expect((err as SourceRequestError).status).toBe(400);
  });

  it("sends Basic auth only on get-links, and only when both env vars are set", async () => {
    setLidoCredentials(`  ${LIDO_USER} `, LIDO_PASS);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xmlResponse(GET_ID_XML))
      .mockResolvedValueOnce(xmlResponse(BWB_LINKS_XML));
    vi.stubGlobal("fetch", fetchMock);

    await new LidoSource(testConfig).links({ id: "BWBR0011823", artikel: "29" });

    expect(calledUrl(fetchMock, 0).pathname).toBe("/service/get-id");
    expect(hasAuthorization(fetchMock, 0)).toBe(false);
    expect(calledUrl(fetchMock, 1).pathname).toBe("/service/get-links");
    expect(calledHeaders(fetchMock, 1).Authorization).toBe(LIDO_BASIC);
  });

  it("keeps get-aantal-per-informatietype unauthenticated, in links() and references()", async () => {
    setLidoCredentials(LIDO_USER, LIDO_PASS);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xmlResponse("", 400))
      .mockResolvedValueOnce(xmlResponse(UNKNOWN_XML))
      .mockResolvedValueOnce(xmlResponse(ECLI_XML));
    vi.stubGlobal("fetch", fetchMock);
    const src = new LidoSource(testConfig);

    await src.links({ id: "ECLI:NL:HR:2099:9999" });
    await src.references({ id: "ECLI:NL:HR:2019:2006" });

    expect(calledUrl(fetchMock, 0).pathname).toBe("/service/get-links");
    expect(calledHeaders(fetchMock, 0).Authorization).toBe(LIDO_BASIC);
    expect(calledUrl(fetchMock, 1).pathname).toBe("/service/get-aantal-per-informatietype");
    expect(hasAuthorization(fetchMock, 1)).toBe(false);
    expect(calledUrl(fetchMock, 2).pathname).toBe("/service/get-aantal-per-informatietype");
    expect(hasAuthorization(fetchMock, 2)).toBe(false);
  });

  it("sends no Authorization header when only one of the env vars is set", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(LINKS_XML));
    vi.stubGlobal("fetch", fetchMock);
    const src = new LidoSource(testConfig);

    setLidoCredentials(LIDO_USER, "");
    await src.links({ id: "ECLI:NL:HR:2019:2006" });
    clearHttpCache();
    setLidoCredentials("   ", LIDO_PASS);
    await src.links({ id: "ECLI:NL:HR:2019:2006" });
    clearHttpCache();
    setLidoCredentials("", "");
    await src.links({ id: "ECLI:NL:HR:2019:2006" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i += 1) expect(hasAuthorization(fetchMock, i)).toBe(false);
  });

  it("never exposes the credentials in URLs, endpoint, params or access_note", async () => {
    setLidoCredentials(LIDO_USER, LIDO_PASS);
    const fetchMock = vi.fn(async () => xmlResponse(LINKS_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).links({ id: "ECLI:NL:HR:2019:2006", type: "Wet" });

    const serialized = JSON.stringify(out) + String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    const token = LIDO_BASIC.slice("Basic ".length);
    for (const secret of [LIDO_USER, LIDO_PASS, token]) expect(serialized).not.toContain(secret);
  });

  it("maps 401/403 on get-links to a clear Dutch error", async () => {
    const src = new LidoSource(testConfig);

    vi.stubGlobal("fetch", vi.fn(async () => xmlResponse("", 401)));
    const withoutCreds = (await src.links({ id: "ECLI:NL:HR:2019:2006" }).catch((e: unknown) => e)) as Error;
    expect(withoutCreds).toBeInstanceOf(Error);
    expect(withoutCreds.message).toContain("LiDO vereist nu een account voor get-links");
    expect(withoutCreds.message).toContain("LIDO_USERNAME");
    expect(withoutCreds.message).toContain("LIDO_PASSWORD");

    clearHttpCache();
    setLidoCredentials(LIDO_USER, LIDO_PASS);
    vi.stubGlobal("fetch", vi.fn(async () => xmlResponse("", 403)));
    const withCreds = (await src.links({ id: "ECLI:NL:HR:2019:2006" }).catch((e: unknown) => e)) as Error;
    expect(withCreds.message).toContain("HTTP 403");
    expect(withCreds.message).toContain("onjuist");
    expect(withCreds.message).not.toContain(LIDO_USER);
    expect(withCreds.message).not.toContain(LIDO_PASS);
  });
});

describe("lido_verwijzingen_lijst tool", () => {
  async function callTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "lido-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({ name: "lido_verwijzingen_lijst", arguments: args })) as {
        content: Array<{ type: string; text: string }>;
      };
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    } finally {
      await client.close();
      await server.close();
    }
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    setLidoCredentials("", "");
    clearHttpCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pages upstream and reports total, range and per-type split", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(LINKS_XML));
    vi.stubGlobal("fetch", fetchMock);

    const payload = await callTool({ id: "ECLI:NL:HR:2019:2006", offset: 20, limit: 150 });

    expect(calledUrl(fetchMock, 0).searchParams.get("start")).toBe("20");
    expect(calledUrl(fetchMock, 0).searchParams.get("rows")).toBe("100");
    // Niet nog eens lokaal gesliced: alle drie de items van de pagina komen terug.
    const records = payload.records as Array<{ title: string; canonical_url: string; snippet?: string }>;
    expect(records).toHaveLength(3);
    expect(payload.pagination).toEqual({ offset: 20, limit: 100, total: 167, has_more: true });
    expect(payload.summary).toContain("167 verwijzingen van/naar ECLI:NL:HR:2019:2006");
    expect(payload.summary).toContain("getoond 21-23");
    expect(payload.summary).not.toContain("unieke");
    expect(payload.summary).toContain("Jurisprudentie: 126");
    expect(records[0].title).toBe("Overeenkomst van Parijs");
    expect(records[0].canonical_url).toBe("http://wetten.overheid.nl/1.0:c:BWBV0006603&g=2017-08-27");
    expect(records[0].snippet).toBe("uitgaand — Verdrag — Door computer herkende referentie");
    // Zonder hasVersion → portal-URL van het opgevraagde item.
    expect(new URL(records[2].canonical_url).searchParams.get("ext-id")).toBe("ECLI:NL:HR:2019:2006");
    const provenance = payload.provenance as Record<string, unknown>;
    expect(provenance.tool).toBe("lido_verwijzingen_lijst");
    expect(provenance.total_results).toBe(167);
    expect(provenance.returned_results).toBe(3);
  });

  it("computes has_more from LiDO's entries, not from the deduplicated records", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => xmlResponse(DUP_XML)));

    const payload = await callTool({ id: "ECLI:NL:HR:2019:2006", limit: 5 });

    expect((payload.records as unknown[]).length).toBe(3);
    // 0 + 5 entries = total 5 → geen volgende pagina (op records gerekend zou dit ten onrechte true zijn).
    expect(payload.pagination).toEqual({ offset: 0, limit: 5, total: 5, has_more: false });
    expect(payload.summary).toContain("getoond 1-5, 3 unieke documenten");
  });

  it("keeps credentials out of dryRun output and rejects an injected type", async () => {
    setLidoCredentials(LIDO_USER, LIDO_PASS);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const dry = await callTool({ id: "ECLI:NL:HR:2019:2006", type: "wet", dryRun: true });
    const text = JSON.stringify(dry);
    expect(dry.dry_run).toBe(true);
    expect(text).toContain("get-links");
    expect(text).toContain('"type":"Wet"');
    for (const secret of [LIDO_USER, LIDO_PASS, LIDO_BASIC.slice("Basic ".length)]) expect(text).not.toContain(secret);

    const bad = await callTool({ id: "ECLI:NL:HR:2019:2006", type: 'Wet" OR "x' });
    expect(String(bad.message)).toContain("Ongeldig informatietype");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
