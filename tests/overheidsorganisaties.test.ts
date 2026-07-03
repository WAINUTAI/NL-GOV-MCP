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

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const LIST = [
  {
    label: "gemeente Amsterdam",
    type: "https://identifier.overheid.nl/tooi/def/ont/Gemeente",
    uri: "https://identifier.overheid.nl/tooi/id/gemeente/gm0363",
  },
  {
    label: "gemeente Utrecht",
    type: "https://identifier.overheid.nl/tooi/def/ont/Gemeente",
    uri: "https://identifier.overheid.nl/tooi/id/gemeente/gm0344",
  },
  {
    label: "Ministerie van Financiën",
    type: "https://identifier.overheid.nl/tooi/def/ont/Ministerie",
    uri: "https://identifier.overheid.nl/tooi/id/ministerie/mnre1045",
  },
];

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

/** Router-mock: dispatcht op URL naar lijst, contact of adressen. */
function routedFetch() {
  return vi.fn(async (url: string) => {
    if (url.includes("/contact")) return jsonResponse(CONTACT);
    if (url.includes("/adressen")) return jsonResponse(ADRESSEN);
    return jsonResponse(LIST);
  });
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

    const listUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(listUrl).toContain("api-organisaties.overheid.nl/v1/overheidsorganisaties");
    expect(out.items).toHaveLength(1);
    const item = out.items[0];
    expect(item.title).toBe("gemeente Amsterdam");
    expect(item.organisatietype).toBe("Gemeente");
    expect(item.tooi_uri).toBe("https://identifier.overheid.nl/tooi/id/gemeente/gm0363");
    expect(out.total).toBe(1);
  });

  it("enriches each hit with website, phone and visiting address by default", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const src = await makeSource();
    const out = await src.search({ query: "amsterdam", rows: 20 });

    // list + contact + adressen
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const item = out.items[0];
    expect(item.website).toBe("https://www.amsterdam.nl");
    expect(item.telefoon).toBe("14 020");
    expect(item.bezoekadres).toBe("Amstel 1, 1011 PN AMSTERDAM");
    // canonical url wordt de website na verrijking
    expect(item.url).toBe("https://www.amsterdam.nl");
    expect(out.params.enrich).toBe("true");
  });

  it("skips enrichment (only the list call) when enrich=false", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);

    const src = await makeSource();
    const out = await src.search({ query: "gemeente", rows: 20, enrich: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.items).toHaveLength(2);
    expect(out.items[0].website).toBe("");
    expect(out.items[0].url).toBe("https://identifier.overheid.nl/tooi/id/gemeente/gm0363");
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

    const listUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stays resilient when contact/adres enrichment endpoints fail", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/contact") || url.includes("/adressen")) {
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
  });
});
