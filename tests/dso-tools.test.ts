import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { clearDsoCaches, DSO_PRESENTEREN_BASE } from "../src/sources/dso-omgevingsdocumenten.js";
import { jsonResponse } from "./helpers/config.js";

/* ------------------------------------------------------------------ */
/*  Harness: call a tool handler without an MCP transport              */
/* ------------------------------------------------------------------ */

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
const tools = new Map<string, { schema: Record<string, { parse: (v: unknown) => unknown }>; handler: Handler }>();
registerTools({
  registerTool(name: string, cfg: { inputSchema?: Record<string, { parse: (v: unknown) => unknown }> }, handler: Handler) {
    tools.set(name, { schema: cfg.inputSchema ?? {}, handler });
  },
} as unknown as McpServer);

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const tool = tools.get(name)!;
  const parsed: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.schema)) parsed[key] = schema.parse(args[key]);
  const out = await tool.handler(parsed);
  return JSON.parse(out.content[0].text);
}

const PLAN = {
  identificatie: "/akn/nl/act/gm0344/2020/omgevingsplan",
  officieleTitel: "Omgevingsplan gemeente Utrecht",
  type: { code: "/join/id/stop/regelingtype_003", waarde: "Omgevingsplan" },
  aangeleverdDoorEen: { naam: "gemeente Utrecht", bestuurslaag: "gemeente", code: "gm0344" },
  geregistreerdMet: { beginGeldigheid: "2026-09-18", beginInwerking: "2026-09-18" },
};

const STRUCTUUR = {
  _embedded: {
    documentComponenten: [
      {
        identificatie: "body",
        expressie: "body",
        type: "LICHAAM",
        volgordeNummer: 0,
        _embedded: {
          documentComponenten: [
            {
              identificatie: "gm0344_a__chp_4",
              expressie: "chp_4",
              type: "HOOFDSTUK",
              volgordeNummer: 0,
              kop: "<Kop><Label>Hoofdstuk</Label><Nummer>4</Nummer><Opschrift>Bouwen</Opschrift></Kop>",
              _embedded: {
                documentComponenten: [
                  {
                    identificatie: "gm0344_b__chp_4__art_4.24",
                    expressie: "chp_4__art_4.24",
                    type: "ARTIKEL",
                    volgordeNummer: 0,
                    kop: "<Kop><Label>Artikel</Label><Nummer>4.24</Nummer><Opschrift>Dakkapel aan de voorkant</Opschrift></Kop>",
                    inhoud: "<Inhoud><Al>Een dakkapel aan de voorkant heeft een plat dak.</Al></Inhoud>",
                  },
                  {
                    identificatie: "gm0344_c__chp_4__art_4.25",
                    expressie: "chp_4__art_4.25",
                    type: "ARTIKEL",
                    volgordeNummer: 1,
                    kop: "<Kop><Label>Artikel</Label><Nummer>4.25</Nummer><Opschrift>Erker</Opschrift></Kop>",
                    inhoud: "<Inhoud><Al>Een erker is niet hoger dan de eerste verdieping.</Al></Inhoud>",
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  },
};

let urls: URL[] = [];
function mockDso() {
  urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.pathname.endsWith("/_zoek")) return jsonResponse({ _embedded: { regelingen: [PLAN] }, page: { number: 1, size: 200, totalElements: 1, totalPages: 1 } });
      if (url.pathname.endsWith("/documentstructuur")) return jsonResponse(STRUCTUUR);
      return jsonResponse(PLAN);
    }),
  );
}

beforeEach(() => {
  clearHttpCache();
  clearDsoCaches();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("DSO tools without DSO_API_KEY", () => {
  it("both answer not_configured with the request link", async () => {
    vi.stubEnv("DSO_API_KEY", "");
    const search = await call("dso_omgevingsdocumenten_search", { bevoegdGezag: "gm0344" });
    const tekst = await call("dso_omgevingsdocument_tekst", { identificatie: "/akn/nl/act/gm0344/2020/omgevingsplan" });
    for (const out of [search, tekst]) {
      expect(out.error).toBe("not_configured");
      expect(out.suggestion).toContain("api-key-aanvragen");
    }
  });
});

describe("dso_omgevingsdocumenten_search", () => {
  it("keeps the fields the map panel reads and links to the readable text", async () => {
    vi.stubEnv("DSO_API_KEY", "test-key");
    mockDso();
    const out = await call("dso_omgevingsdocumenten_search", { bevoegdGezag: "gm0344", rows: 20 });

    expect(urls).toHaveLength(1);
    expect(out.summary).toBe("1 DSO omgevingsdocumenten — gm0344");
    const [rec] = out.records;
    expect(rec.title).toBe("Omgevingsplan gemeente Utrecht");
    expect(rec.canonical_url).toBe("https://identifier.overheid.nl/akn/nl/act/gm0344/2020/omgevingsplan");
    expect(rec.date).toBe("2026-09-18");
    expect(rec.data).toMatchObject({
      bevoegdGezag: "gemeente Utrecht",
      bevoegdGezagCode: "gm0344",
      documentType: "Omgevingsplan",
      identificatie: "/akn/nl/act/gm0344/2020/omgevingsplan",
      uriIdentificatie: "_akn_nl_act_gm0344_2020_omgevingsplan",
      viewerUrl: "https://omgevingswet.overheid.nl/regels-op-de-kaart/viewer",
    });
    expect(rec.data.raw).toBeUndefined();
    expect(out.provenance).toMatchObject({ tool: "dso_omgevingsdocumenten_search", returned_results: 1, total_results: 1 });
  });
});

describe("dso_omgevingsdocument_tekst", () => {
  beforeEach(() => {
    vi.stubEnv("DSO_API_KEY", "test-key");
    mockDso();
  });

  it("returns the parts with the zoekterm as records with their path", async () => {
    const out = await call("dso_omgevingsdocument_tekst", { identificatie: "/akn/nl/act/gm0344/2020/omgevingsplan", zoekterm: "dakkapel" });

    expect(out.summary).toBe("1 onderdeel met 'dakkapel' in Omgevingsplan gemeente Utrecht");
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toMatchObject({
      title: "Artikel 4.24 Dakkapel aan de voorkant — Omgevingsplan gemeente Utrecht",
      canonical_url: "https://identifier.overheid.nl/akn/nl/act/gm0344/2020/omgevingsplan",
      data: {
        pad: "Hoofdstuk 4 Bouwen",
        eId: "chp_4__art_4.24",
        uriIdentificatie: "_akn_nl_act_gm0344_2020_omgevingsplan",
        tekst: "Artikel 4.24 Dakkapel aan de voorkant\nEen dakkapel aan de voorkant heeft een plat dak.",
      },
    });
    expect(out.provenance).toMatchObject({ tool: "dso_omgevingsdocument_tekst", total_results: 1 });
    expect(urls.some((u) => u.pathname.endsWith("/regelingen/_akn_nl_act_gm0344_2020_omgevingsplan/documentstructuur"))).toBe(true);
  });

  it("returns the whole text when it fits, with the default max_tekens", async () => {
    const out = await call("dso_omgevingsdocument_tekst", { identificatie: "_akn_nl_act_gm0344_2020_omgevingsplan" });
    expect(out.records).toHaveLength(1);
    expect(out.records[0].data).toMatchObject({ onderdeel: "Volledige tekst", afgekapt: false });
    expect(out.records[0].data.tekst).toContain("Artikel 4.25 Erker");
    expect(out.provenance.query_params.max_tekens).toBe("12000");
  });

  it("answers an onderdeel that does not exist with an error naming the ones that do", async () => {
    const out = await call("dso_omgevingsdocument_tekst", { identificatie: "/akn/nl/act/gm0344/2020/omgevingsplan", onderdeel: "Artikel 4.99" });
    expect(out.error).toBe("unexpected");
    expect(out.message).toContain("Artikel 4.99");
    expect(out.suggestion).toContain("Artikel 4.24, Artikel 4.25");
  });

  it("refuses an identifier it cannot read", async () => {
    const out = await call("dso_omgevingsdocument_tekst", { identificatie: "https://lokaleregelgeving.overheid.nl/CVDR696280/7" });
    expect(out.error).toBe("unexpected");
    expect(out.suggestion).toContain("identificatie");
    expect(urls).toHaveLength(0);
  });

  it("reads a URL with a broken %-escape, or a path id with a slash, as an unknown identifier", async () => {
    for (const identificatie of ["https://identifier.overheid.nl/akn/%E0%A4%A", "_akn_nl_act_x/y"]) {
      const out = await call("dso_omgevingsdocument_tekst", { identificatie });
      expect(out.error).toBe("unexpected");
      expect(out.message).toContain("Onbekende identificatie");
      expect(out.suggestion).toContain("uriIdentificatie");
    }
    expect(urls).toHaveLength(0);
  });

  it("names an artikel without numbered leden instead of listing other artikelen", async () => {
    const out = await call("dso_omgevingsdocument_tekst", { identificatie: "/akn/nl/act/gm0344/2020/omgevingsplan", onderdeel: "artikel 4.24, eerste lid" });
    expect(out.message).toBe("Onderdeel 'artikel 4.24, eerste lid' niet gevonden in Omgevingsplan gemeente Utrecht: Artikel 4.24 bestaat, maar heeft geen genummerde leden.");
    expect(out.suggestion).toContain("Bestaande onderdelen: Artikel 4.24.");
  });

  it("refuses an onderdeel too long to be an eId or label, without fetching", async () => {
    const out = await call("dso_omgevingsdocument_tekst", { identificatie: "/akn/nl/act/gm0344/2020/omgevingsplan", onderdeel: ",".repeat(5000) });
    expect(out.error).toBe("unexpected");
    expect(out.message).toContain("te lang");
    expect(urls).toHaveLength(0);
    expect(() => tools.get("dso_omgevingsdocument_tekst")!.schema.zoekterm.parse("x".repeat(201))).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/*  Text tool: ontwerpen, toelichting, placeholders and failures       */
/* ------------------------------------------------------------------ */

function mockFetch(answer: (url: URL) => Response) {
  urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      urls.push(url);
      return answer(url);
    }),
  );
}

const ONTWERP_ID = "_akn_nl_act_pv26_2022_omgevingsverordening_akn_nl_bill_pv26_2025_3_1091";
const ONTWERP = {
  identificatie: "/akn/nl/act/pv26/2022/omgevingsverordening",
  technischId: ONTWERP_ID,
  ontwerpbesluitIdentificatie: "/akn/nl/bill/pv26/2025/3_1091",
  officieleTitel: "Omgevingsverordening provincie Utrecht",
  type: { code: "/join/id/stop/regelingtype_004", waarde: "Omgevingsverordening" },
  aangeleverdDoorEen: { naam: "provincie Utrecht", bestuurslaag: "provincie", code: "pv26" },
};
// The shape of /ontwerpregelingen/{technischId}/documentstructuur (text from that ontwerp, Artikel 2.4).
const ONTWERP_STRUCTUUR = {
  _embedded: {
    ontwerpDocumentComponenten: [
      {
        identificatie: "body",
        expressie: "body",
        type: "LICHAAM",
        _embedded: {
          ontwerpDocumentComponenten: [
            {
              identificatie: "pv26_1068__art_2.4",
              expressie: "chp_2__art_2.4",
              type: "ARTIKEL",
              kop: "<Kop><Label>Artikel</Label><Nummer>2.4</Nummer><Opschrift>Omgevingswaarde wateroverlast</Opschrift></Kop>",
              _embedded: {
                ontwerpDocumentComponenten: [
                  {
                    identificatie: "pv26_1068__art_2.4__para_4",
                    expressie: "chp_2__art_2.4__para_4",
                    type: "LID",
                    bevatRenvooi: true,
                    kop: "<Kop><Nummer>4.</Nummer></Kop>",
                    inhoud: "<Inhoud><Al>Deze <VerwijderdeTekst>omgevingswaarde is</VerwijderdeTekst><NieuweTekst>omgevingswaarden zijn</NieuweTekst> een inspanningsverplichting.</Al></Inhoud>",
                  },
                ],
              },
            },
            { identificatie: "pv26_1068__art_2.12", expressie: "chp_2__art_2.12_inst2", type: "ARTIKEL", wijzigactie: "verwijder", kop: "<Kop><Label>Artikel</Label><Nummer>2.12</Nummer></Kop>", inhoud: "<Inhoud><Al>Vervalt.</Al></Inhoud>" },
          ],
        },
      },
    ],
  },
};

// GET …/regelingen/_akn_nl_act_mnre1034_2020_regOW01 and its documentstructuur (6 Oct 2026, _links left out).
const OMGEVINGSWET = {
  identificatie: "/akn/nl/act/mnre1034/2020/regOW01",
  officieleTitel: "Omgevingswet",
  aangeleverdDoorEen: { naam: "ministerie van Binnenlandse Zaken en Koninkrijksrelaties", bestuurslaag: "ministerie", code: "mnre1034" },
  type: { code: "/join/id/stop/regelingtype_001", waarde: "AMvB" },
  geregistreerdMet: { beginInwerking: "2020-08-01", beginGeldigheid: "2020-08-01", versie: 1 },
  citeerTitel: "Omgevingswet",
};
const OMGEVINGSWET_STRUCTUUR = {
  _embedded: {
    documentComponenten: [
      {
        identificatie: "body",
        expressie: "body",
        type: "LICHAAM",
        volgordeNummer: 0,
        _embedded: {
          documentComponenten: [
            {
              identificatie: "mnre1034_1__chp_1",
              expressie: "chp_1",
              type: "HOOFDSTUK",
              volgordeNummer: 0,
              _embedded: {
                documentComponenten: [
                  {
                    identificatie: "mnre1034_1__chp_1__art_1.1",
                    expressie: "chp_1__art_1.1",
                    type: "ARTIKEL",
                    volgordeNummer: 0,
                    inhoud: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Inhoud xmlns="https://standaarden.overheid.nl/stop/imop/tekst/"><Al>Op deze locatie is de Omgevingswet van toepassing. De tekst van de Omgevingswet vindt u <ExtRef soort="URL" ref="https://iplo.nl/regelgeving/">hier</ExtRef>.</Al></Inhoud>',
                    kop: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Kop xmlns="https://standaarden.overheid.nl/stop/imop/tekst/"><Label>Artikel</Label><Nummer>1.1</Nummer><Opschrift>Omgevingswet</Opschrift></Kop>',
                  },
                ],
              },
              kop: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Kop xmlns="https://standaarden.overheid.nl/stop/imop/tekst/"><Label>HOOFDSTUK</Label><Nummer>1</Nummer><Opschrift>Omgevingswet</Opschrift></Kop>',
            },
          ],
        },
      },
    ],
  },
};

describe("dso_omgevingsdocument_tekst beyond a plain regeling", () => {
  beforeEach(() => {
    vi.stubEnv("DSO_API_KEY", "test-key");
  });

  it("reads an ontwerp: its ontwerpDocumentComponenten, as the ontwerp would make the regeling", async () => {
    mockFetch((url) => (url.pathname.endsWith("/documentstructuur") ? jsonResponse(ONTWERP_STRUCTUUR) : jsonResponse(ONTWERP)));
    const out = await call("dso_omgevingsdocument_tekst", { identificatie: ONTWERP_ID });

    const tekst = "Artikel 2.4 Omgevingswaarde wateroverlast\n4. Deze omgevingswaarden zijn een inspanningsverplichting.";
    expect(urls.every((u) => u.pathname.includes(`/ontwerpregelingen/${ONTWERP_ID}`))).toBe(true);
    expect(out.summary).toBe(`Regeltekst Omgevingsverordening provincie Utrecht (${tekst.length} tekens)`);
    expect(out.records[0].data).toMatchObject({ technischId: ONTWERP_ID, tekensDocument: tekst.length, tekst });
    expect(out.access_note).toContain("Ontwerp, nog niet geldend: de tekst is de regeling zoals dit ontwerp haar zou maken");
  });

  it("never presents an empty documentstructuur as a text of 0 tekens", async () => {
    mockFetch((url) => (url.pathname.endsWith("/documentstructuur") ? jsonResponse({ _embedded: { ontwerpDocumentComponenten: [] } }) : jsonResponse(ONTWERP)));
    const out = await call("dso_omgevingsdocument_tekst", { identificatie: ONTWERP_ID });
    expect(out.error).toBe("unexpected");
    expect(out.message).toContain("geen regeltekst");
    expect(out.records).toBeUndefined();
  });

  it("says a documentstructuur over the size cap is too large, not malformed", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    mockFetch((url) => {
      if (!url.pathname.endsWith("/documentstructuur")) return jsonResponse(PLAN);
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent > 33 * 1024 * 1024) return controller.close();
          controller.enqueue(chunk);
          sent += chunk.byteLength;
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
    const out = await call("dso_omgevingsdocument_tekst", { identificatie: "/akn/nl/act/gm0344/2020/omgevingsplan" });
    expect(out.error).toBe("unexpected");
    expect(out.message).toContain("te groot");
    expect(out.suggestion).toContain("canonical_url");
  });

  it("labels a toelichting part as such and finds a plural by its stem", async () => {
    const structuur = structuredClone(STRUCTUUR);
    structuur._embedded.documentComponenten.push({
      identificatie: "recital",
      expressie: "recital",
      type: "TOELICHTING",
      volgordeNummer: 1,
      kop: "<Kop><Opschrift>Toelichting</Opschrift></Kop>",
      _embedded: {
        documentComponenten: [
          { identificatie: "gm0344_t", expressie: "recital__div_1", type: "DIVISIETEKST", volgordeNummer: 0, kop: "<Kop><Opschrift>Artikel 4.24 Dakkapel aan de voorkant</Opschrift></Kop>", inhoud: "<Inhoud><Al>Dakkapellen aan de achterkant zijn vergunningvrij.</Al></Inhoud>" },
        ],
      },
    } as never);
    mockFetch((url) => (url.pathname.endsWith("/documentstructuur") ? jsonResponse(structuur) : jsonResponse(PLAN)));
    const out = await call("dso_omgevingsdocument_tekst", { identificatie: "/akn/nl/act/gm0344/2020/omgevingsplan", zoekterm: "dakkapellen" });

    expect(out.records.map((r: { title: string }) => r.title)).toEqual([
      "Artikel 4.24 Dakkapel aan de voorkant — Omgevingsplan gemeente Utrecht",
      "Toelichting bij Artikel 4.24 Dakkapel aan de voorkant — Omgevingsplan gemeente Utrecht",
    ]);
    expect(out.records[0].data.toelichting).toBeUndefined();
    expect(out.records[1].data).toMatchObject({ toelichting: true, onderdeelType: "DIVISIETEKST" });
    expect(out.access_note).toContain("'dakkapellen' als 'dakkapel'");
    expect(out.access_note).toContain("uitleg, geen regels");
  });

  it("says the DSO holds only a pointer for the Omgevingswet, in every mode", async () => {
    mockFetch((url) => (url.pathname.endsWith("/documentstructuur") ? jsonResponse(OMGEVINGSWET_STRUCTUUR) : jsonResponse(OMGEVINGSWET)));
    const id = "/akn/nl/act/mnre1034/2020/regOW01";

    const whole = await call("dso_omgevingsdocument_tekst", { identificatie: id });
    expect(whole.summary).toBe("Alleen een verwijzing in het DSO: de tekst van Omgevingswet staat op https://wetten.overheid.nl/BWBR0037885");
    expect(whole.access_note.startsWith("Omgevingswet: het DSO bevat alleen een verwijzing, niet de wettekst")).toBe(true);
    expect(whole.records[0].data.tekst).toContain("vindt u hier (https://iplo.nl/regelgeving/).");

    const search = await call("dso_omgevingsdocument_tekst", { identificatie: id, zoekterm: "omgevingsplan" });
    expect(search.records).toEqual([]);
    expect(search.summary).toContain("Alleen een verwijzing");
    expect(search.access_note).toContain("https://wetten.overheid.nl/BWBR0037885");
    expect(search.access_note).not.toContain("Probeer een kortere");

    const onderdeel = await call("dso_omgevingsdocument_tekst", { identificatie: id, onderdeel: "Artikel 2.4" });
    expect(onderdeel.message).toContain("staat niet in het DSO");
    expect(onderdeel.suggestion).toBe("Lees de wet op https://wetten.overheid.nl/BWBR0037885.");
  });
});

/* ------------------------------------------------------------------ */
/*  Text tool: tijdelijke delen, renvooi, technical records, room      */
/* ------------------------------------------------------------------ */

// A voorbeschermingsregels regeling that is a tijdelijk deel of PLAN (test data in the DSO's shape).
const DEEL_ID = "_akn_nl_act_gm0344_2026_Regelingtest";
const DEEL = {
  identificatie: "/akn/nl/act/gm0344/2026/Regelingtest",
  officieleTitel: "Voorbereidingsbesluit dakkapellen achterkant",
  type: { code: "/join/id/stop/regelingtype_015", waarde: "Voorbeschermingsregels Omgevingsplan" },
  aangeleverdDoorEen: { naam: "gemeente Utrecht", bestuurslaag: "gemeente", code: "gm0344" },
  geregistreerdMet: { beginGeldigheid: "2026-10-03", beginInwerking: "2026-10-03", versie: 1 },
  _links: { tijdelijkDeelVan: { href: `${DSO_PRESENTEREN_BASE}/regelingen/_akn_nl_act_gm0344_2020_omgevingsplan?geldigOp=2026-10-06&inWerkingOp=2026-10-06` } },
};
const DEEL_STRUCTUUR = {
  _embedded: {
    documentComponenten: [
      {
        identificatie: "body",
        expressie: "body",
        type: "LICHAAM",
        conditieArtikel: { kop: "<Kop><Opschrift>Voorrangsregel</Opschrift></Kop>", inhoud: "<Inhoud><Al>Waar deze regels afwijken van het omgevingsplan, gelden alleen deze regels.</Al></Inhoud>" },
        _embedded: {
          documentComponenten: [
            {
              identificatie: "gm0344_t__chp_1__art_1.3",
              expressie: "chp_1__art_1.3",
              type: "ARTIKEL",
              kop: "<Kop><Label>Artikel</Label><Nummer>1.3</Nummer><Opschrift>Omgevingsvergunning voor dakkapellen achterkant</Opschrift></Kop>",
              inhoud: "<Inhoud><Al>Het is verboden zonder omgevingsvergunning een dakkapel in het achterdakvlak te plaatsen.</Al></Inhoud>",
            },
          ],
        },
      },
    ],
  },
};
const PLAN_MET_DEEL = {
  ...PLAN,
  _links: {
    tijdelijkDelen: [
      { href: `${DSO_PRESENTEREN_BASE}/regelingen/${DEEL_ID}?geldigOp=2026-10-06&inWerkingOp=2026-10-06` },
      // A link that does not lead to the DSO is never followed.
      { href: "https://elders.example/presenteren/v8/regelingen/_akn_nl_act_gm0344_2026_x" },
    ],
  },
};

function mockPlanMetDeel(deel: (url: URL) => Response = (url) => jsonResponse(url.pathname.endsWith("/documentstructuur") ? DEEL_STRUCTUUR : DEEL)) {
  mockFetch((url) => {
    if (url.pathname.includes(`/regelingen/${DEEL_ID}`)) return deel(url);
    return jsonResponse(url.pathname.endsWith("/documentstructuur") ? STRUCTUUR : PLAN_MET_DEEL);
  });
}

describe("dso_omgevingsdocument_tekst and the tijdelijke delen of an omgevingsplan", () => {
  beforeEach(() => {
    vi.stubEnv("DSO_API_KEY", "test-key");
  });

  it("lists the tijdelijke delen without a zoekterm, and searches them with one", async () => {
    mockPlanMetDeel();
    const whole = await call("dso_omgevingsdocument_tekst", { identificatie: PLAN.identificatie });
    expect(whole.access_note).toContain(
      "Bij dit omgevingsplan hoort 1 tijdelijk deel dat niet in deze tekst staat; het gaat voor waar zijn voorrangsregel dat bepaalt: Voorbereidingsbesluit dakkapellen achterkant (Voorbeschermingsregels Omgevingsplan, gemeente Utrecht, sinds 2026-10-03, identificatie /akn/nl/act/gm0344/2026/Regelingtest).",
    );
    // Its metadata only: no text fetched without a zoekterm, and nothing outside the DSO.
    expect(urls.some((u) => u.pathname.endsWith(`${DEEL_ID}/documentstructuur`))).toBe(false);
    expect(urls.every((u) => u.hostname === "service.omgevingswet.overheid.nl")).toBe(true);

    const out = await call("dso_omgevingsdocument_tekst", { identificatie: PLAN.identificatie, zoekterm: "dakkapel" });
    expect(out.summary).toBe("1 onderdeel met 'dakkapel' in Omgevingsplan gemeente Utrecht en 1 in het tijdelijke deel (voorbeschermingsregels)");
    expect(out.records.map((r: { title: string }) => r.title)).toEqual([
      "Artikel 4.24 Dakkapel aan de voorkant — Omgevingsplan gemeente Utrecht",
      "Voorbeschermingsregels: Voorbereidingsbesluit dakkapellen achterkant — Artikel 1.3 Omgevingsvergunning voor dakkapellen achterkant",
    ]);
    expect(out.records[1]).toMatchObject({
      canonical_url: "https://identifier.overheid.nl/akn/nl/act/gm0344/2026/Regelingtest",
      date: "2026-10-03",
      data: {
        tijdelijkDeel: true,
        tijdelijkDeelVan: "/akn/nl/act/gm0344/2020/omgevingsplan",
        identificatie: "/akn/nl/act/gm0344/2026/Regelingtest",
        uriIdentificatie: DEEL_ID,
        documentType: "Voorbeschermingsregels Omgevingsplan",
        eId: "chp_1__art_1.3",
      },
    });
    expect(out.access_note).toContain("Ook doorzocht: het tijdelijke deel van dit omgevingsplan");
    expect(out.provenance.total_results).toBe(2);
  });

  it("does not fail when a tijdelijk deel cannot be read, and says so", async () => {
    mockPlanMetDeel(() => jsonResponse({ title: "Niet gevonden" }, 404));
    const out = await call("dso_omgevingsdocument_tekst", { identificatie: PLAN.identificatie, zoekterm: "dakkapel" });
    expect(out.records).toHaveLength(1);
    expect(out.access_note).toContain(`Tijdelijk deel van dit omgevingsplan niet te lezen: ${DEEL_ID} (HTTP 404).`);
    expect(out.access_note).not.toContain("Ook doorzocht");
  });

  it("names the regeling a tijdelijk deel belongs to when it is read on its own", async () => {
    mockPlanMetDeel();
    const out = await call("dso_omgevingsdocument_tekst", { identificatie: DEEL.identificatie });
    expect(out.summary).toContain("Regeltekst Voorbereidingsbesluit dakkapellen achterkant");
    expect(out.records[0].data.tekst.split("\n")[0]).toBe("Voorrangsregel");
    expect(out.access_note.startsWith("Dit is een tijdelijk deel van Omgevingsplan gemeente Utrecht (/akn/nl/act/gm0344/2020/omgevingsplan)")).toBe(true);
  });
});

describe("dso_omgevingsdocument_tekst: renvooi, technical records and room", () => {
  beforeEach(() => {
    vi.stubEnv("DSO_API_KEY", "test-key");
  });

  it("shows only what an ontwerp changes with weergave 'wijzigingen', and refuses it for a regeling without fetching", async () => {
    mockFetch((url) => (url.pathname.endsWith("/documentstructuur") ? jsonResponse(ONTWERP_STRUCTUUR) : jsonResponse(ONTWERP)));
    const regeling = await call("dso_omgevingsdocument_tekst", { identificatie: "/akn/nl/act/pv26/2022/omgevingsverordening", weergave: "wijzigingen" });
    expect(regeling.error).toBe("unexpected");
    expect(regeling.message).toContain("alleen voor een ontwerp");
    expect(urls).toHaveLength(0);

    const out = await call("dso_omgevingsdocument_tekst", { identificatie: ONTWERP_ID, weergave: "wijzigingen" });
    expect(out.summary).toBe("2 wijzigingen in ontwerp Omgevingsverordening provincie Utrecht: 1 gewijzigd, 0 nieuw, 1 vervallen, 0 alleen vernummerd");
    expect(out.records.map((r: { title: string; data: Record<string, unknown> }) => [r.title, r.data.wijziging, r.data.tekst])).toEqual([
      ["Artikel 2.4 Omgevingswaarde wateroverlast — Omgevingsverordening provincie Utrecht", "gewijzigd", "Artikel 2.4 Omgevingswaarde wateroverlast\n4. Deze [-omgevingswaarde is-][+omgevingswaarden zijn+] een inspanningsverplichting."],
      ["Artikel 2.12 — Omgevingsverordening provincie Utrecht", "vervalt", "[vervalt] Artikel 2.12\nVervalt."],
    ]);
    expect(out.access_note).toContain("[+tekst+] = toegevoegd, [-tekst-] = geschrapt");
    expect(out.provenance).toMatchObject({ query_params: { weergave: "wijzigingen" }, returned_results: 2, total_results: 2 });

    // The default view points to it.
    const nieuw = await call("dso_omgevingsdocument_tekst", { identificatie: ONTWERP_ID });
    expect(nieuw.access_note).toContain("roep deze tool aan met weergave 'wijzigingen'");
  });

  it("says the Aansluitdocument Rijk is a technical record without rules", async () => {
    const aansluit = {
      identificatie: "/akn/nl/act/mnre1034/2021/OOWATRXX1",
      officieleTitel: "Aansluitdocument Rijk",
      aangeleverdDoorEen: { naam: "ministerie van Binnenlandse Zaken en Koninkrijksrelaties", bestuurslaag: "ministerie", code: "mnre1034" },
      type: { code: "/join/id/stop/regelingtype_001", waarde: "AMvB" },
      geregistreerdMet: { beginInwerking: "2021-12-01", beginGeldigheid: "2021-12-01", versie: 1 },
    };
    const structuur = {
      _embedded: {
        documentComponenten: [
          {
            identificatie: "body",
            expressie: "body",
            type: "LICHAAM",
            _embedded: {
              documentComponenten: [
                { identificatie: "mnre1034_x__art_1.1", expressie: "chp_1__art_1.1", type: "ARTIKEL", kop: "<Kop><Label>Artikel</Label><Nummer>1.1</Nummer><Opschrift>Regels</Opschrift></Kop>", inhoud: "<Inhoud><Al>Dit document is tijdelijk ten behoeve van technisch aansluiten op DSO.</Al></Inhoud>" },
              ],
            },
          },
        ],
      },
    };
    mockFetch((url) => jsonResponse(url.pathname.endsWith("/documentstructuur") ? structuur : aansluit));
    const out = await call("dso_omgevingsdocument_tekst", { identificatie: aansluit.identificatie });
    expect(out.summary).toBe("Technisch aansluitdocument zonder regels: Aansluitdocument Rijk");
    expect(out.access_note).toContain("Aansluitdocument Rijk is een technisch aansluitdocument in het DSO");
    expect(out.access_note).toContain("het bevat geen regels");
  });

  it("returns a hit too long for max_tekens as its passages, marked ingekort, with its eId for the rest", async () => {
    const items = Array.from({ length: 40 }, (_, i) => `<Li><LiNummer>${i + 1}.</LiNummer><Al>${i === 29 ? "een dakkapel in het achterdakvlak" : `een ander bouwwerk nummer ${i + 1} met een lange omschrijving`};</Al></Li>`).join("");
    const structuur = structuredClone(STRUCTUUR);
    structuur._embedded.documentComponenten[0]._embedded.documentComponenten[0]._embedded.documentComponenten.push({
      identificatie: "gm0344_d__chp_4__art_4.30",
      expressie: "chp_4__art_4.30",
      type: "ARTIKEL",
      volgordeNummer: 2,
      kop: "<Kop><Label>Artikel</Label><Nummer>4.30</Nummer><Opschrift>Vergunningvrij</Opschrift></Kop>",
      inhoud: `<Inhoud><Al>Geen vergunning is nodig voor:</Al><Lijst>${items}</Lijst></Inhoud>`,
    } as never);
    mockFetch((url) => jsonResponse(url.pathname.endsWith("/documentstructuur") ? structuur : PLAN));
    const out = await call("dso_omgevingsdocument_tekst", { identificatie: PLAN.identificatie, zoekterm: "dakkapel", max_tekens: 500 });
    expect(out.records.map((r: { title: string }) => r.title)).toEqual([
      "Artikel 4.24 Dakkapel aan de voorkant — Omgevingsplan gemeente Utrecht",
      "Artikel 4.30 Vergunningvrij — Omgevingsplan gemeente Utrecht",
    ]);
    expect(out.records[1].data).toMatchObject({ ingekort: true, eId: "chp_4__art_4.30" });
    expect(out.records[1].data.tekst).toContain("30. een dakkapel in het achterdakvlak;");
    expect(out.records[1].data.tekensOnderdeel).toBeGreaterThan(500);
    expect(out.access_note).toContain("Ingekort wegens max_tekens (500): Artikel 4.30 Vergunningvrij [chp_4__art_4.30]");
  });
});

describe("DSO tools with a key the DSO refuses", () => {
  it("report a malformed key (HTTP 400) or an unknown one (401) as configuration, without the key", async () => {
    vi.stubEnv("DSO_API_KEY", "FAKE-KEY-7731");
    for (const status of [400, 401]) {
      clearHttpCache();
      clearDsoCaches();
      mockFetch(() => jsonResponse({ title: "De API key heeft een ongeldig formaat." }, status));
      const tekst = await call("dso_omgevingsdocument_tekst", { identificatie: "/akn/nl/act/gm0344/2020/omgevingsplan" });
      const search = await call("dso_omgevingsdocumenten_search", { bevoegdGezag: "gm0344" });
      for (const out of [tekst, search]) {
        expect(out.error).toBe("not_configured");
        expect(out.message).toContain(`HTTP ${status}`);
        expect(out.message).not.toContain("niet gevonden");
        expect(out.suggestion).toContain("DSO_API_KEY");
        expect(JSON.stringify(out)).not.toContain("FAKE-KEY-7731");
      }
    }
  });

  it("still reports a document the DSO does not have (404) as not found", async () => {
    vi.stubEnv("DSO_API_KEY", "test-key");
    mockFetch(() => jsonResponse({ title: "Resource niet gevonden" }, 404));
    const out = await call("dso_omgevingsdocument_tekst", { identificatie: "_akn_nl_act_gm0344_2099_bestaatniet" });
    expect(out.error).toBe("unexpected");
    expect(out.message).toContain("niet gevonden in het DSO");
  });
});
