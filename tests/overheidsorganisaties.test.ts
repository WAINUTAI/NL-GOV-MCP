import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

const config = loadConfig();

// De HTTP-laag cachet responses in een module-level Map (connector-runtime).
// Dat is correct productiegedrag, maar zonder isolatie lekt de lijst-cache tussen
// tests: de register-lijst-URL is identiek voor elke zoekterm (naam-filter gebeurt
// client-side), dus na de eerste test zou fetch niet meer worden aangeroepen.
// We resetten daarom de module-graph per test en laden de source dynamisch, zodat
// elke test start met een lege HTTP-cache.
async function makeSource(): Promise<
  InstanceType<
    typeof import("../src/sources/overheidsorganisaties.js").OverheidsorganisatiesSource
  >
> {
  const mod = await import("../src/sources/overheidsorganisaties.js");
  return new mod.OverheidsorganisatiesSource(config);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TOOI = "https://identifier.overheid.nl/tooi/id/";
const ONT = "https://identifier.overheid.nl/tooi/def/ont/";

const LIST = [
  { label: "gemeente Amsterdam", type: `${ONT}Gemeente`, uri: `${TOOI}gemeente/gm0363` },
  { label: "gemeente Utrecht", type: `${ONT}Gemeente`, uri: `${TOOI}gemeente/gm0344` },
  { label: "Ministerie van Financiën", type: `${ONT}Ministerie`, uri: `${TOOI}ministerie/mnre1045` },
];

/** A register list with the cases these tests cover: browsing, abbreviations and aliases, usable links. */
const BIG_LIST = [
  { label: "gemeente Den Haag", type: `${ONT}Gemeente`, uri: `${TOOI}gemeente/gm0518` },
  { label: "Veiligheidsregio Haaglanden", type: `${ONT}Samenwerkingsorganisatie`, uri: `${TOOI}so/so0044` },
  { label: "Metropoolregio Rotterdam Den Haag", type: `${ONT}Samenwerkingsorganisatie`, uri: `${TOOI}so/so0830` },
  { label: "Uitvoeringsinstituut Werknemersverzekeringen", type: `${ONT}Zbo`, uri: `${TOOI}zbo/zb000117` },
  {
    label: "ministerie van Landbouw, Visserij, Voedselzekerheid en Natuur",
    type: `${ONT}Ministerie`,
    uri: `${TOOI}ministerie/mnre1153`,
  },
  { label: "GGD Groningen", type: `${ONT}Samenwerkingsorganisatie`, uri: `${TOOI}so/so0824` },
  { label: "Gemeenschappelijke Gezondheidsdienst Zeeland", type: `${ONT}Samenwerkingsorganisatie`, uri: `${TOOI}so/so0346` },
  {
    label: "Gemeentelijke Gezondheidsdienst Regio Utrecht",
    type: `${ONT}Samenwerkingsorganisatie`,
    uri: `${TOOI}so/so0444`,
  },
  { label: "provincie Fryslân", type: `${ONT}Provincie`, uri: `${TOOI}provincie/pv21` },
  { label: "Afvalbeheer Westfriesland", type: `${ONT}Samenwerkingsorganisatie`, uri: `${TOOI}so/so0309` },
  { label: "gemeente 's-Hertogenbosch", type: `${ONT}Gemeente`, uri: `${TOOI}gemeente/gm0796` },
  { label: "provincie Noord-Holland", type: `${ONT}Provincie`, uri: `${TOOI}provincie/pv27` },
  { label: "waterschap Hunze en Aa's", type: `${ONT}Waterschap`, uri: `${TOOI}waterschap/ws0646` },
  { label: "waterschap Reest en Wieden", type: `${ONT}Waterschap`, uri: `${TOOI}waterschap/ws0648` },
  { label: "waterschap Vechtstromen", type: `${ONT}Waterschap`, uri: `${TOOI}waterschap/ws0663` },
];

function lit(value: string) {
  return { type: "literal", value };
}

/** TOOI SPARQL answer: abbreviations, a differing official name and end dates. */
const TOOI_META = {
  head: { vars: ["org", "afk", "off", "offIncl", "end"] },
  results: {
    bindings: [
      { org: { type: "uri", value: `${TOOI}zbo/zb000117` }, afk: lit("UWV") },
      { org: { type: "uri", value: `${TOOI}ministerie/mnre1153` }, afk: lit("LVVN") },
      { org: { type: "uri", value: `${TOOI}so/so0830` }, afk: lit("MRDH") },
      { org: { type: "uri", value: `${TOOI}gemeente/gm0518` }, off: lit("'s-Gravenhage"), offIncl: lit("gemeente 's-Gravenhage") },
      { org: { type: "uri", value: `${TOOI}waterschap/ws0648` }, end: { type: "literal", datatype: "http://www.w3.org/2001/XMLSchema#date", value: "2015-12-31" } },
      // A temporary body with an end date in the future is still active.
      { org: { type: "uri", value: `${TOOI}waterschap/ws0663` }, end: lit("2999-12-31") },
    ],
  },
};

const CONTACT = {
  internetadressen: [{ url: "https://www.amsterdam.nl", label: "algemeen" }],
  telefoonnummers: [{ label: "algemeen", nummer: "14 020" }],
  emailadressen: [],
};

const ADRESSEN = [
  { adresType: "Postadres", postbus: "202", postcode: "1000 AE", woonplaats: "AMSTERDAM" },
  {
    adresType: "Bezoekadres",
    openbareRuimte: "Amstel",
    huisnummer: "1",
    postcode: "1011 PN",
    woonplaats: "AMSTERDAM",
  },
];

const isTooi = (url: string) => url.includes("standaarden.overheid.nl/tooi/sparql");
const isRegister = (url: string) => url.includes("api-organisaties.overheid.nl");

/** Router-mock: dispatcht op URL naar lijst, contact, adressen, identificatie of TOOI SPARQL. */
function routedFetch(opts: {
  list?: unknown;
  contact?: unknown;
  identificatie?: unknown;
  tooi?: () => Response;
} = {}) {
  return vi.fn(async (url: string) => {
    if (isTooi(url)) return opts.tooi ? opts.tooi() : jsonResponse(TOOI_META);
    if (url.includes("/contact")) return jsonResponse(opts.contact ?? CONTACT);
    if (url.includes("/adressen")) return jsonResponse(ADRESSEN);
    if (url.includes("/identificatie")) return jsonResponse(opts.identificatie ?? {});
    return jsonResponse(opts.list ?? LIST);
  });
}

function registerCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((c) => String((c as unknown as Array<unknown>)[0])).filter(isRegister);
}

describe("OverheidsorganisatiesSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // Verse module-graph -> lege HTTP-cache, zodat fetch-call-tellingen per test kloppen.
    vi.resetModules();
  });

  it("filters the register by name substring and derives organisatietype from the TOOI type URI", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const src = await makeSource();
    const out = await src.search({ query: "amsterdam", rows: 20 });

    const listUrl = registerCalls(fetchMock)[0];
    expect(listUrl).toContain("api-organisaties.overheid.nl/v1/overheidsorganisaties");
    expect(out.items).toHaveLength(1);
    const item = out.items[0];
    expect(item.title).toBe("gemeente Amsterdam");
    expect(item.organisatietype).toBe("Gemeente");
    expect(item.tooi_uri).toBe("https://identifier.overheid.nl/tooi/id/gemeente/gm0363");
    expect(item.matched_on).toBe("naam");
    expect(out.total).toBe(1);
  });

  it("enriches each hit with website, phone and visiting address by default", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const src = await makeSource();
    const out = await src.search({ query: "amsterdam", rows: 20 });

    // list + contact + adressen (no /identificatie: there is a website)
    expect(registerCalls(fetchMock)).toHaveLength(3);
    const item = out.items[0];
    expect(item.website).toBe("https://www.amsterdam.nl");
    expect(item.telefoon).toBe("14 020");
    expect(item.bezoekadres).toBe("Amstel 1, 1011 PN AMSTERDAM");
    // canonical url wordt de website na verrijking
    expect(item.url).toBe("https://www.amsterdam.nl");
    expect(out.params.enrich).toBe("true");
  });

  it("skips enrichment (only the list call) when enrich=false and links to the TOOI register page", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const src = await makeSource();
    const out = await src.search({ query: "gemeente", rows: 20, enrich: false });

    expect(registerCalls(fetchMock)).toHaveLength(1);
    expect(out.items).toHaveLength(2);
    expect(out.items[0].website).toBe("");
    // A usable page, not the bare TOOI identifier; the identifier stays in tooi_uri.
    expect(out.items[0].url).toBe(
      "https://standaarden.overheid.nl/tooi/waardelijsten/item?id=https%3A%2F%2Fidentifier.overheid.nl%2Ftooi%2Fid%2Fgemeente%2Fgm0363",
    );
    expect(out.items[0].register_url).toBe(out.items[0].url);
    expect(out.items[0].tooi_uri).toBe("https://identifier.overheid.nl/tooi/id/gemeente/gm0363");
    expect(out.params.enrich).toBe("false");
  });

  it("passes an optional TOOI type filter to the list endpoint query", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const src = await makeSource();
    await src.search({
      query: "",
      rows: 5,
      type: "https://identifier.overheid.nl/tooi/def/ont/Ministerie",
      enrich: false,
    });

    const listUrl = registerCalls(fetchMock)[0];
    expect(listUrl).toContain("type=");
    expect(listUrl).toContain("Ministerie");
  });

  it("returns an empty result with a helpful access_note when nothing matches", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const src = await makeSource();
    const out = await src.search({ query: "zzz-bestaat-niet", rows: 20 });

    expect(out.items).toHaveLength(0);
    expect(out.total).toBe(0);
    expect(out.access_note).toContain("Geen overheidsorganisatie gevonden");
    // alleen de lijst-call; niets om te verrijken
    expect(registerCalls(fetchMock)).toHaveLength(1);
  });

  it("stays resilient when contact/adres enrichment endpoints fail", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (isTooi(url)) return jsonResponse(TOOI_META);
      if (url.includes("/contact") || url.includes("/adressen") || url.includes("/identificatie")) {
        return new Response("upstream down", { status: 502 });
      }
      return jsonResponse(LIST);
    });
    vi.stubGlobal("fetch", fetchMock);

    const src = await makeSource();
    const out = await src.search({ query: "utrecht", rows: 20 });

    expect(out.items).toHaveLength(1);
    const item = out.items[0];
    expect(item.title).toBe("gemeente Utrecht");
    // verrijking mislukte maar de basisvelden blijven intact
    expect(item.website).toBe("");
    expect(item.bezoekadres).toBe("");
    expect(item.tooi_uri).toBe("https://identifier.overheid.nl/tooi/id/gemeente/gm0344");
    expect(item.url).toContain("standaarden.overheid.nl/tooi/waardelijsten/item?id=");
  });
});

describe("OverheidsorganisatiesSource browse mode", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("returns the whole (type-filtered) register when query is omitted, in register order", async () => {
    const fetchMock = routedFetch({ list: BIG_LIST.filter((o) => o.type.endsWith("Waterschap")) });
    vi.stubGlobal("fetch", fetchMock);

    const src = await makeSource();
    const out = await src.search({ rows: 50, type: `${ONT}Waterschap`, enrich: false });

    expect(out.total).toBe(3);
    expect(out.items.map((i) => i.title)).toEqual([
      "waterschap Hunze en Aa's",
      "waterschap Reest en Wieden",
      "waterschap Vechtstromen",
    ]);
    expect(out.params.query).toBe("");
    expect(out.items.every((i) => i.matched_on === "")).toBe(true);
  });

  it("marks dissolved organisations and says how many there are", async () => {
    vi.stubGlobal("fetch", routedFetch({ list: BIG_LIST.filter((o) => o.type.endsWith("Waterschap")) }));

    const src = await makeSource();
    const out = await src.search({ query: "", rows: 50, enrich: false });

    const reest = out.items.find((i) => i.title === "waterschap Reest en Wieden");
    expect(reest).toMatchObject({ einddatum: "2015-12-31", opgeheven: true });
    // An end date in the future is not dissolved.
    expect(out.items.find((i) => i.title === "waterschap Vechtstromen")).toMatchObject({ einddatum: "2999-12-31", opgeheven: false });
    expect(out.items.find((i) => i.title === "waterschap Hunze en Aa's")).toMatchObject({ einddatum: "", opgeheven: false });
    expect(out.access_note).toContain("1 van de 3 treffers is opgeheven");
    expect(out.access_note).toContain("active_only=true");
  });

  it("drops dissolved organisations with activeOnly", async () => {
    vi.stubGlobal("fetch", routedFetch({ list: BIG_LIST.filter((o) => o.type.endsWith("Waterschap")) }));

    const src = await makeSource();
    const out = await src.search({ rows: 50, enrich: false, activeOnly: true });

    expect(out.total).toBe(2);
    expect(out.items.map((i) => i.title)).not.toContain("waterschap Reest en Wieden");
    expect(out.params.active_only).toBe("true");
    expect(out.access_note ?? "").not.toContain("opgeheven");
  });

  it("treats an empty TOOI answer as unavailable, not as 'nothing is dissolved'", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        list: BIG_LIST.filter((o) => o.type.endsWith("Waterschap")),
        tooi: () => jsonResponse({ head: { vars: [] }, results: { bindings: [] } }),
      }),
    );

    const src = await makeSource();
    const out = await src.search({ rows: 50, enrich: false });

    expect(out.items.every((i) => i.opgeheven === null)).toBe(true);
    expect(out.access_note).toContain("niet bereikbaar");
    await expect(src.search({ rows: 50, enrich: false, activeOnly: true })).rejects.toThrow(/active_only/);
  });

  it("refuses activeOnly instead of returning unfiltered rows when TOOI is unreachable", async () => {
    vi.stubGlobal("fetch", routedFetch({ list: BIG_LIST, tooi: () => jsonResponse({ error: "down" }, 400) }));

    const src = await makeSource();
    await expect(src.search({ rows: 50, enrich: false, activeOnly: true })).rejects.toThrow(
      /active_only kan niet worden toegepast/,
    );
  });

  it("does not cache an unusable 200 answer from TOOI, so the next search uses TOOI once it is back (review)", async () => {
    const unusable: Array<[string, () => Response]> = [
      ["maintenance page", () => new Response("<html><body>Onderhoud</body></html>", { status: 200, headers: { "content-type": "text/html" } })],
      ["no rows", () => jsonResponse({ head: { vars: [] }, results: { bindings: [] } })],
    ];
    for (const [label, badAnswer] of unusable) {
      vi.resetModules();
      let tooiUp = false;
      let tooiCalls = 0;
      vi.stubGlobal(
        "fetch",
        routedFetch({
          list: BIG_LIST,
          tooi: () => {
            tooiCalls += 1;
            return tooiUp ? jsonResponse(TOOI_META) : badAnswer();
          },
        }),
      );
      const src = await makeSource();

      const down = await src.search({ query: "UWV", rows: 10, enrich: false });
      expect(down.items, label).toEqual([]);
      expect(down.access_note, label).toContain("niet bereikbaar");
      await expect(src.search({ rows: 50, enrich: false, activeOnly: true }), label).rejects.toThrow(/active_only/);

      tooiUp = true;
      const back = await src.search({ query: "UWV", rows: 10, enrich: false });
      expect(back.items.map((i) => i.title), label).toEqual(["Uitvoeringsinstituut Werknemersverzekeringen"]);
      const active = await src.search({ rows: 50, enrich: false, activeOnly: true });
      expect(active.items.map((i) => i.title), label).not.toContain("waterschap Reest en Wieden");
      // A parsed answer is cached: the last search did not ask TOOI again.
      expect(tooiCalls, label).toBe(3);
    }
  });
});

describe("OverheidsorganisatiesSource name matching", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function search(query: string, extra: Partial<{ rows: number }> = {}) {
    vi.stubGlobal("fetch", routedFetch({ list: BIG_LIST }));
    const src = await makeSource();
    return src.search({ query, rows: extra.rows ?? 50, enrich: false });
  }

  it("finds an organisation by its register abbreviation", async () => {
    const out = await search("UWV");
    expect(out.items.map((i) => i.title)).toEqual(["Uitvoeringsinstituut Werknemersverzekeringen"]);
    expect(out.items[0]).toMatchObject({ afkorting: "UWV", matched_on: "afkorting" });
  });

  it("does not match a short query across word boundaries ('UWV' in 'LandboUW, Visserij')", async () => {
    const out = await search("uwv");
    expect(out.items.map((i) => i.title)).not.toContain(
      "ministerie van Landbouw, Visserij, Voedselzekerheid en Natuur",
    );
  });

  it("finds Den Haag by its official name 's-Gravenhage, with or without apostrophe and hyphen", async () => {
    for (const q of ["Gravenhage", "'s-Gravenhage", "s Gravenhage", "sGravenhage", "gemeente 's-Gravenhage"]) {
      const out = await search(q);
      expect(out.items.map((i) => i.title), q).toEqual(["gemeente Den Haag"]);
      expect(out.items[0].matched_on, q).toBe("officiele_naam");
    }
  });

  it("ranks the whole-name match first and keeps phrase semantics ('Den Haag' does not match 'Haaglanden')", async () => {
    const out = await search("Den Haag");
    expect(out.items.map((i) => i.title)).toEqual(["gemeente Den Haag", "Metropoolregio Rotterdam Den Haag"]);
  });

  it("folds accents and hyphens", async () => {
    expect((await search("Fryslan")).items.map((i) => i.title)).toEqual(["provincie Fryslân"]);
    expect((await search("Noordholland")).items.map((i) => i.title)).toEqual(["provincie Noord-Holland"]);
    expect((await search("Hunze en Aas")).items.map((i) => i.title)).toEqual(["waterschap Hunze en Aa's"]);
  });

  it("matches GGD regions registered under their full name via the GGD alias", async () => {
    const out = await search("GGD");
    expect(out.items.map((i) => i.title)).toEqual([
      "GGD Groningen",
      "Gemeenschappelijke Gezondheidsdienst Zeeland",
      "Gemeentelijke Gezondheidsdienst Regio Utrecht",
    ]);
    expect(out.access_note).toContain("GGD = Gezondheidsdienst");
  });

  it("also finds the GGD regions registered as 'Dienst Gezondheid' or 'Gezondheidsregio' (review)", async () => {
    const list = [
      ...BIG_LIST,
      { label: "Dienst Gezondheid & Jeugd Zuid-Holland Zuid", type: `${ONT}Samenwerkingsorganisatie`, uri: `${TOOI}so/so0030` },
      { label: "Veiligheids- en Gezondheidsregio Gelderland-Midden", type: `${ONT}Samenwerkingsorganisatie`, uri: `${TOOI}so/so0476` },
      // Not a GGD: 'Gezondheidszorg' is no alias.
      { label: "Inspectie Gezondheidszorg en Jeugd", type: `${ONT}Organisatieonderdeel`, uri: `${TOOI}oorg/oorg12354` },
    ];
    vi.stubGlobal("fetch", routedFetch({ list }));
    const src = await makeSource();

    const out = await src.search({ query: "GGD", rows: 50, enrich: false });
    expect(out.items.map((i) => i.title)).toEqual([
      "GGD Groningen",
      "Gemeenschappelijke Gezondheidsdienst Zeeland",
      "Gemeentelijke Gezondheidsdienst Regio Utrecht",
      "Dienst Gezondheid & Jeugd Zuid-Holland Zuid",
      "Veiligheids- en Gezondheidsregio Gelderland-Midden",
    ]);
    expect(out.access_note).toContain("GGD = Dienst Gezondheid");
    expect(out.access_note).toContain("GGD = Gezondheidsregio");

    const region = await src.search({ query: "GGD Gelderland-Midden", rows: 10, enrich: false });
    expect(region.items.map((i) => i.title)).toEqual(["Veiligheids- en Gezondheidsregio Gelderland-Midden"]);
  });

  it("ranks names that hold the query itself before names only an alias found (review: VGGM fell off a short page)", async () => {
    // As in the register, both bodies come after the GGD regions, so register
    // order alone would put them last among the equally scored alias hits.
    const list = [
      ...BIG_LIST,
      { label: "Dienst Gezondheid & Jeugd Zuid-Holland Zuid", type: `${ONT}Samenwerkingsorganisatie`, uri: `${TOOI}so/so0030` },
      { label: "Veiligheids- en Gezondheidsregio Gelderland-Midden", type: `${ONT}Samenwerkingsorganisatie`, uri: `${TOOI}so/so0476` },
    ];
    vi.stubGlobal("fetch", routedFetch({ list }));
    const src = await makeSource();
    const titles = async (query: string, rows = 50) =>
      (await src.search({ query, rows, enrich: false })).items.map((i) => i.title);

    expect(await titles("Gezondheidsregio", 1)).toEqual(["Veiligheids- en Gezondheidsregio Gelderland-Midden"]);
    // The alias hits still follow, in register order.
    expect(await titles("Gezondheidsregio")).toEqual([
      "Veiligheids- en Gezondheidsregio Gelderland-Midden",
      "GGD Groningen",
      "Gemeenschappelijke Gezondheidsdienst Zeeland",
      "Gemeentelijke Gezondheidsdienst Regio Utrecht",
      "Dienst Gezondheid & Jeugd Zuid-Holland Zuid",
    ]);
    expect(await titles("Dienst Gezondheid", 1)).toEqual(["Dienst Gezondheid & Jeugd Zuid-Holland Zuid"]);
    expect(await titles("Gezondheidsdienst")).toEqual([
      "Gemeenschappelijke Gezondheidsdienst Zeeland",
      "Gemeentelijke Gezondheidsdienst Regio Utrecht",
      "GGD Groningen",
      "Dienst Gezondheid & Jeugd Zuid-Holland Zuid",
      "Veiligheids- en Gezondheidsregio Gelderland-Midden",
    ]);
    // A better alias score still wins: the whole name beats a word-start match.
    expect(await titles("Friesland")).toEqual(["provincie Fryslân", "Afvalbeheer Westfriesland"]);
  });

  it("puts a dissolved name that holds the query before a current one only an alias found", async () => {
    const list = [
      { label: "Gemeentelijke Gezondheidsdienst Noordrand", type: `${ONT}Samenwerkingsorganisatie`, uri: `${TOOI}so/so0901` },
      { label: "Veiligheids- en Gezondheidsregio Zuidrand", type: `${ONT}Samenwerkingsorganisatie`, uri: `${TOOI}so/so0902` },
    ];
    const meta = {
      head: TOOI_META.head,
      results: {
        bindings: [{ org: { type: "uri", value: `${TOOI}so/so0902` }, end: lit("2019-12-31") }],
      },
    };
    vi.stubGlobal("fetch", routedFetch({ list, tooi: () => jsonResponse(meta) }));
    const src = await makeSource();
    const out = await src.search({ query: "Gezondheidsregio", rows: 10, enrich: false });
    expect(out.items.map((i) => [i.title, i.opgeheven])).toEqual([
      ["Veiligheids- en Gezondheidsregio Zuidrand", true],
      ["Gemeentelijke Gezondheidsdienst Noordrand", false],
    ]);
  });

  it("applies aliases only at the start of a word ('Fryslân' does not find 'Westfriesland')", async () => {
    const fry = await search("Fryslân");
    expect(fry.items.map((i) => i.title)).toEqual(["provincie Fryslân"]);
    const fri = await search("Friesland");
    // The literal substring still matches, but the alias hit ranks first.
    expect(fri.items.map((i) => i.title)).toEqual(["provincie Fryslân", "Afvalbeheer Westfriesland"]);
  });

  it("maps Den Bosch to 's-Hertogenbosch", async () => {
    const out = await search("Den Bosch");
    expect(out.items.map((i) => i.title)).toEqual(["gemeente 's-Hertogenbosch"]);
    expect(out.access_note).toContain("Den Bosch = 's-Hertogenbosch");
  });

  it("falls back to all words when no name holds the query as a phrase, and says so", async () => {
    const out = await search("GGD Utrecht");
    expect(out.items.map((i) => i.title)).toEqual(["Gemeentelijke Gezondheidsdienst Regio Utrecht"]);
    expect(out.items[0].matched_on).toBe("losse_woorden");
    expect(out.access_note).toContain("alle zoekwoorden");
    const both = await search("Uitvoeringsinstituut Werknemersverzekeringen (UWV)");
    expect(both.items.map((i) => i.title)).toEqual(["Uitvoeringsinstituut Werknemersverzekeringen"]);
  });

  it("returns nothing (with a note) for a query without letters or digits", async () => {
    const out = await search("'-");
    expect(out.items).toEqual([]);
    expect(out.access_note).toContain("bevat geen letters of cijfers");
  });

  it("matches a query of only punctuation as written ('&', '('), as the plain substring filter did (review)", async () => {
    const list = [
      ...BIG_LIST,
      { label: "waterschap Vallei & Eem", type: `${ONT}Waterschap`, uri: `${TOOI}waterschap/ws0665` },
      { label: "gemeente Bergen (NH)", type: `${ONT}Gemeente`, uri: `${TOOI}gemeente/gm0373` },
    ];
    vi.stubGlobal("fetch", routedFetch({ list }));
    const src = await makeSource();

    const amp = await src.search({ query: "&", rows: 10, enrich: false });
    expect(amp.items.map((i) => [i.title, i.matched_on])).toEqual([["waterschap Vallei & Eem", "naam"]]);
    expect((await src.search({ query: "(", rows: 10, enrich: false })).items.map((i) => i.title)).toEqual(["gemeente Bergen (NH)"]);
    expect((await src.search({ query: "'-", rows: 10, enrich: false })).items).toEqual([]);
  });

  it("ranks the register name exactly as typed above an abbreviation that folds the same ('Duo+' vs DUO, review)", async () => {
    // Register order puts DUO first, so only the tie-break can lift 'Duo+'.
    const list = [
      { label: "Dienst Uitvoering Onderwijs", type: `${ONT}Organisatieonderdeel`, uri: `${TOOI}oorg/oorg10010` },
      { label: "Duo+", type: `${ONT}Samenwerkingsorganisatie`, uri: `${TOOI}so/so0868` },
    ];
    const meta = { results: { bindings: [{ org: { type: "uri", value: `${TOOI}oorg/oorg10010` }, afk: lit("DUO") }] } };
    vi.stubGlobal("fetch", routedFetch({ list, tooi: () => jsonResponse(meta) }));
    const src = await makeSource();

    const typed = await src.search({ query: "Duo+", rows: 10, enrich: false });
    expect(typed.items.map((i) => [i.title, i.matched_on])).toEqual([
      ["Duo+", "naam"],
      ["Dienst Uitvoering Onderwijs", "afkorting"],
    ]);
    // Without the exact spelling both are equal matches and the register order stays.
    const loose = await src.search({ query: "duo", rows: 10, enrich: false });
    expect(loose.items.map((i) => i.title)).toEqual(["Dienst Uitvoering Onderwijs", "Duo+"]);
  });

  it("still searches the register names when TOOI is unreachable, and says what is missing", async () => {
    vi.stubGlobal("fetch", routedFetch({ list: BIG_LIST, tooi: () => jsonResponse({ error: "down" }, 400) }));
    const src = await makeSource();
    const uwv = await src.search({ query: "UWV", rows: 10, enrich: false });
    expect(uwv.items).toEqual([]);
    expect(uwv.access_note).toContain("niet bereikbaar");

    const haag = await src.search({ query: "Den Haag", rows: 10, enrich: false });
    expect(haag.items[0]).toMatchObject({ title: "gemeente Den Haag", opgeheven: null, afkorting: "" });
  });
});

describe("OverheidsorganisatiesSource canonical url", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("adds https:// to a website stored without a scheme and upgrades http://", async () => {
    const list = [{ label: "ministerie van Defensie", type: `${ONT}Ministerie`, uri: `${TOOI}ministerie/mnre1018` }];
    vi.stubGlobal("fetch", routedFetch({ list, contact: { internetadressen: [{ url: "www.defensie.nl" }] } }));
    let src = await makeSource();
    let out = await src.search({ query: "Defensie", rows: 5 });
    expect(out.items[0]).toMatchObject({
      url: "https://www.defensie.nl",
      website: "https://www.defensie.nl",
      tooi_uri: `${TOOI}ministerie/mnre1018`,
    });

    vi.resetModules();
    vi.stubGlobal("fetch", routedFetch({ list, contact: { internetadressen: [{ url: "http://www.lintjes.nl" }] } }));
    src = await makeSource();
    out = await src.search({ query: "Defensie", rows: 5 });
    expect(out.items[0].url).toBe("https://www.lintjes.nl");
  });

  it("links to the register's organisation page when there is no website", async () => {
    const list = [{ label: "Omgevingsdienst Veluwe", type: `${ONT}Samenwerkingsorganisatie`, uri: `${TOOI}so/so1091` }];
    const fetchMock = routedFetch({
      list,
      contact: { internetadressen: [] },
      identificatie: { label: "Omgevingsdienst Veluwe", systeemId: "29847749", uri: `${TOOI}so/so1091` },
    });
    vi.stubGlobal("fetch", fetchMock);

    const src = await makeSource();
    const out = await src.search({ query: "Omgevingsdienst Veluwe", rows: 5 });

    expect(registerCalls(fetchMock).some((u) => u.includes("/identificatie"))).toBe(true);
    expect(out.items[0]).toMatchObject({
      website: "",
      url: "https://organisaties.overheid.nl/29847749/Omgevingsdienst_Veluwe",
      register_url: "https://organisaties.overheid.nl/29847749/Omgevingsdienst_Veluwe",
    });
  });

  it("links a dissolved organisation to the register page, keeping its old website in 'website'", async () => {
    const list = [{ label: "waterschap Reest en Wieden", type: `${ONT}Waterschap`, uri: `${TOOI}waterschap/ws0648` }];
    vi.stubGlobal(
      "fetch",
      routedFetch({
        list,
        contact: { internetadressen: [{ url: "https://www.wrw.nl" }] },
        identificatie: { systeemId: "12345" },
      }),
    );

    const src = await makeSource();
    const out = await src.search({ query: "Reest", rows: 5 });

    expect(out.items[0]).toMatchObject({
      opgeheven: true,
      website: "https://www.wrw.nl",
      url: "https://organisaties.overheid.nl/12345/waterschap_Reest_en_Wieden",
    });
  });

  it("ignores an unusable systeemId and keeps the TOOI page", async () => {
    const list = [{ label: "Omgevingsdienst Veluwe", type: `${ONT}Samenwerkingsorganisatie`, uri: `${TOOI}so/so1091` }];
    vi.stubGlobal("fetch", routedFetch({ list, contact: {}, identificatie: { systeemId: "../evil" } }));
    const src = await makeSource();
    const out = await src.search({ query: "Veluwe", rows: 5 });
    expect(out.items[0].url).toBe(
      "https://standaarden.overheid.nl/tooi/waardelijsten/item?id=https%3A%2F%2Fidentifier.overheid.nl%2Ftooi%2Fid%2Fso%2Fso1091",
    );
  });
});

describe("normalizeWebsite / foldName", () => {
  it("normalises register websites to https and rejects non-web values", async () => {
    const { normalizeWebsite } = await import("../src/sources/overheidsorganisaties.js");
    expect(normalizeWebsite("www.defensie.nl")).toBe("https://www.defensie.nl");
    expect(normalizeWebsite(" https://www.leiden.nl/gemeente ")).toBe("https://www.leiden.nl/gemeente");
    expect(normalizeWebsite("http://www.lintjes.nl")).toBe("https://www.lintjes.nl");
    expect(normalizeWebsite("HTTP://www.x.nl/a?b=1")).toBe("https://www.x.nl/a?b=1");
    expect(normalizeWebsite("https://www.x.nl/<script>")).toBe("");
    expect(normalizeWebsite("mailto:info@example.nl")).toBe("");
    expect(normalizeWebsite("javascript:alert(1)")).toBe("");
    expect(normalizeWebsite("geen website")).toBe("");
    expect(normalizeWebsite("localhost")).toBe("");
    expect(normalizeWebsite("")).toBe("");
  });

  it("folds case, accents, apostrophes and punctuation", async () => {
    const { foldName } = await import("../src/sources/overheidsorganisaties.js");
    expect(foldName("'s-Gravenhage")).toBe("s gravenhage");
    expect(foldName("Noardeast-Fryslân")).toBe("noardeast fryslan");
    expect(foldName("Hunze en Aa’s")).toBe("hunze en aas");
    expect(foldName("Vallei & Eem")).toBe("vallei eem");
  });
});

/** n GGD regions, all registered under the full name the GGD alias matches. */
function ggdList(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    label: `Gemeentelijke Gezondheidsdienst Regio ${String(i + 1).padStart(2, "0")}`,
    type: `${ONT}Samenwerkingsorganisatie`,
    uri: `${TOOI}so/so${String(9000 + i)}`,
  }));
}

describe("OverheidsorganisatiesSource enrichment cap (review: 'GGD' lost all websites)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("enriches the first 15 hits of a 17-hit query instead of none, and says how many were not enriched", async () => {
    const fetchMock = routedFetch({ list: ggdList(17) });
    vi.stubGlobal("fetch", fetchMock);

    const src = await makeSource();
    const out = await src.search({ query: "GGD", rows: 20 });

    expect(out.total).toBe(17);
    expect(out.items.slice(0, 15).every((i) => i.website === "https://www.amsterdam.nl" && i.url === i.website)).toBe(true);
    expect(out.items.slice(15).map((i) => i.website)).toEqual(["", ""]);
    expect(out.items[15].url).toContain("standaarden.overheid.nl/tooi/waardelijsten/item?id=");
    // list + 15 x (contact + adressen); the contact has a website, so no /identificatie.
    expect(registerCalls(fetchMock)).toHaveLength(1 + 15 * 2);
    expect(out.params.enrich).toBe("true");
    expect(out.access_note).toContain("alleen voor de eerste 15 treffers van deze pagina; 2 treffers zijn niet verrijkt");
  });

  it("enriches the page the caller shows, not the hits before its offset", async () => {
    const fetchMock = routedFetch({ list: ggdList(18) });
    vi.stubGlobal("fetch", fetchMock);

    const src = await makeSource();
    const out = await src.search({ query: "GGD", rows: 20, page: { offset: 15, limit: 5 } });

    expect(out.items.slice(0, 15).every((i) => i.website === "")).toBe(true);
    expect(out.items.slice(15).every((i) => i.website === "https://www.amsterdam.nl")).toBe(true);
    expect(registerCalls(fetchMock)).toHaveLength(1 + 3 * 2);
    expect(out.access_note ?? "").not.toContain("niet verrijkt");
  });

  it("enriches nothing beyond a small page (limit < 15)", async () => {
    const fetchMock = routedFetch({ list: ggdList(17) });
    vi.stubGlobal("fetch", fetchMock);

    const src = await makeSource();
    const out = await src.search({ query: "GGD", rows: 20, page: { offset: 0, limit: 5 } });

    expect(out.items.filter((i) => i.website).length).toBe(5);
    expect(registerCalls(fetchMock)).toHaveLength(1 + 5 * 2);
  });
});

describe("OverheidsorganisatiesSource TOOI wait budget (review: TOOI hang blocked every search ~20 s)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** TOOI answers only after release(); counts TOOI requests. */
  function gatedTooi(list: unknown = BIG_LIST) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let tooiCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (isTooi(url)) {
        tooiCalls += 1;
        await gate;
        return jsonResponse(TOOI_META);
      }
      if (url.includes("/contact")) return jsonResponse(CONTACT);
      if (url.includes("/adressen")) return jsonResponse(ADRESSEN);
      if (url.includes("/identificatie")) return jsonResponse({});
      return jsonResponse(list);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { release, tooiCalls: () => tooiCalls };
  }

  async function makeSourceWithWait(metaWaitMs: number) {
    const mod = await import("../src/sources/overheidsorganisaties.js");
    return new mod.OverheidsorganisatiesSource(config, { metaWaitMs });
  }

  it("answers from the register alone when TOOI does not answer in time, and uses TOOI once it has", async () => {
    const tooi = gatedTooi();
    const src = await makeSourceWithWait(50);

    const started = Date.now();
    const haag = await src.search({ query: "Den Haag", rows: 10, enrich: false });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(haag.items[0]).toMatchObject({ title: "gemeente Den Haag", opgeheven: null, afkorting: "" });
    expect(haag.access_note).toContain("niet bereikbaar (geen antwoord binnen 0,05 s)");

    // The same TOOI request keeps running; once it answers, later searches use it.
    tooi.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const uwv = await src.search({ query: "UWV", rows: 10, enrich: false });
    expect(uwv.items.map((i) => i.title)).toEqual(["Uitvoeringsinstituut Werknemersverzekeringen"]);
    expect(tooi.tooiCalls()).toBe(1);
  });

  it("shares one TOOI request between concurrent searches", async () => {
    const tooi = gatedTooi();
    const src = await makeSourceWithWait(20);
    await Promise.all([
      src.search({ query: "UWV", rows: 10, enrich: false }),
      src.search({ query: "Den Haag", rows: 10, enrich: false }),
    ]);
    expect(tooi.tooiCalls()).toBe(1);
    tooi.release();
  });

  it("does not wait again when it joins a TOOI request that is already late", async () => {
    const tooi = gatedTooi();
    const src = await makeSourceWithWait(300);

    let started = Date.now();
    await src.search({ query: "Den Haag", rows: 10, enrich: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);

    started = Date.now();
    const second = await src.search({ query: "Amsterdam", rows: 10, enrich: false });
    expect(Date.now() - started).toBeLessThan(150);
    expect(second.access_note).toContain("niet bereikbaar");
    expect(tooi.tooiCalls()).toBe(1);
    tooi.release();
  });

  it("lets active_only wait for TOOI beyond the budget, since it needs the end dates", async () => {
    const tooi = gatedTooi(BIG_LIST.filter((o) => o.type.endsWith("Waterschap")));
    const src = await makeSourceWithWait(10);
    setTimeout(() => tooi.release(), 100);

    const out = await src.search({ rows: 50, enrich: false, activeOnly: true });

    expect(out.items.map((i) => i.title)).toEqual(["waterschap Hunze en Aa's", "waterschap Vechtstromen"]);
    expect(out.access_note ?? "").not.toContain("niet bereikbaar");
  });
});
