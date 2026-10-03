import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TENDERNED_MAX_REACHABLE,
  TenderNedInputError,
  TenderNedSource,
  planUpstreamWindow,
  tenderNedRecordFields,
} from "../src/sources/tenderned.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

/** A fake /publicaties that pages over `total` notices with ids "1".."total". */
function fakeUpstream(total: number, extra: (id: number) => Record<string, unknown> = () => ({})) {
  return vi.fn(async (input: string) => {
    const url = new URL(input);
    const page = Number(url.searchParams.get("page"));
    const size = Number(url.searchParams.get("size"));
    if (page > 99 || size > 100 || size < 1) return jsonResponse({ message: "bad paging" }, 400);
    const content = [];
    for (let i = page * size; i < Math.min(total, (page + 1) * size); i += 1) {
      content.push({ publicatieId: String(i + 1), aanbestedingNaam: `Notice ${i + 1}`, ...extra(i + 1) });
    }
    return jsonResponse({ content, totalElements: total, number: page, size });
  });
}

function calledUrls(fetchMock: ReturnType<typeof vi.fn>): URL[] {
  return fetchMock.mock.calls.map((call) => new URL((call as unknown as [string])[0]));
}

describe("planUpstreamWindow", () => {
  it("uses the window size itself for aligned windows", () => {
    expect(planUpstreamWindow(0, 20)).toEqual({ size: 20, pages: [0], skip: 0 });
    expect(planUpstreamWindow(40, 20)).toEqual({ size: 20, pages: [2], skip: 0 });
  });

  it("picks one larger page when it covers an unaligned window", () => {
    const plan = planUpstreamWindow(95, 20);
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0] * plan.size + plan.skip).toBe(95);
    expect(plan.skip + 20).toBeLessThanOrEqual(plan.size);
  });

  it("falls back to two pages of 100 when no single page fits", () => {
    expect(planUpstreamWindow(150, 100)).toEqual({ size: 100, pages: [1, 2], skip: 50 });
  });

  it("never plans a page above the upstream maximum of 99", () => {
    for (const [start, count] of [[5000, 20], [9990, 20], [9999, 1], [1999, 1], [2000, 20]]) {
      const plan = planUpstreamWindow(start, count);
      expect(Math.max(...plan.pages)).toBeLessThanOrEqual(99);
      expect(plan.pages[0] * plan.size + plan.skip).toBe(start);
    }
    // The very last reachable page cannot be followed by another one.
    expect(planUpstreamWindow(9990, 20)).toEqual({ size: 100, pages: [99], skip: 90 });
  });

  it("covers every window below the reachable maximum", () => {
    for (let start = 0; start < TENDERNED_MAX_REACHABLE; start += 997) {
      for (const count of [1, 7, 20, 33, 100]) {
        const plan = planUpstreamWindow(start, count);
        expect(plan.pages[0] * plan.size + plan.skip).toBe(start);
        const covered = plan.size * plan.pages.length - plan.skip;
        expect(covered).toBeGreaterThanOrEqual(Math.min(count, TENDERNED_MAX_REACHABLE - start));
      }
    }
  });
});

describe("TenderNedSource.search paging", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("translates an absolute offset into upstream paging and reports has_more correctly", async () => {
    const fetchMock = fakeUpstream(101);
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TenderNedSource(testConfig).search({ rows: 20, offset: 95 });
    expect(out.items.map((i) => i.id)).toEqual(["96", "97", "98", "99", "100", "101"]);
    expect(out.offset).toBe(95);
    expect(out.total).toBe(101);
    expect(out.has_more).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the legacy page argument and is honest on the last page", async () => {
    vi.stubGlobal("fetch", fakeUpstream(101));
    const src = new TenderNedSource(testConfig);

    const middle = await src.search({ rows: 20, page: 4 });
    expect(middle.offset).toBe(80);
    expect(middle.items[0].id).toBe("81");
    expect(middle.has_more).toBe(true);

    const last = await src.search({ rows: 20, page: 5 });
    expect(last.offset).toBe(100);
    expect(last.items.map((i) => i.id)).toEqual(["101"]);
    expect(last.has_more).toBe(false);
  });

  it("fetches two upstream pages when the window straddles them", async () => {
    const fetchMock = fakeUpstream(1000);
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TenderNedSource(testConfig).search({ rows: 100, offset: 150 });
    expect(out.items).toHaveLength(100);
    expect(out.items[0].id).toBe("151");
    expect(out.items[99].id).toBe("250");
    expect(out.params.page).toBe("1,2");
    expect(calledUrls(fetchMock).map((u) => u.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(out.has_more).toBe(true);
  });

  it("does not request a second page when the first one already ends the results", async () => {
    const fetchMock = fakeUpstream(160);
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TenderNedSource(testConfig).search({ rows: 100, offset: 150 });
    expect(out.items.map((i) => i.id)).toEqual(["151", "152", "153", "154", "155", "156", "157", "158", "159", "160"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.has_more).toBe(false);
  });

  it("stops at the 10,000 results TenderNed exposes and says so", async () => {
    vi.stubGlobal("fetch", fakeUpstream(20_000));
    const out = await new TenderNedSource(testConfig).search({ rows: 20, offset: 9990 });
    expect(out.items).toHaveLength(10);
    expect(out.items[9].id).toBe("10000");
    expect(out.has_more).toBe(false);
    expect(out.access_note).toContain("eerste 10000 van 20000");
  });

  it("rejects a position past the reachable window instead of returning an empty page", async () => {
    const fetchMock = fakeUpstream(20_000);
    vi.stubGlobal("fetch", fetchMock);
    const error = await new TenderNedSource(testConfig).search({ rows: 20, offset: 10_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenderNedInputError);
    expect((error as TenderNedInputError).message).toContain("10000");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains an offset beyond the last result", async () => {
    vi.stubGlobal("fetch", fakeUpstream(50));
    const out = await new TenderNedSource(testConfig).search({ rows: 20, offset: 60 });
    expect(out.items).toEqual([]);
    expect(out.has_more).toBe(false);
    expect(out.access_note).toContain("voorbij het laatste resultaat (totaal 50)");
  });

  it("caps one call at 100 and points to the next offset", async () => {
    vi.stubGlobal("fetch", fakeUpstream(500));
    const out = await new TenderNedSource(testConfig).search({ rows: 200, offset: 0 });
    expect(out.items).toHaveLength(100);
    expect(out.access_note).toContain("maximaal 100");
    expect(out.access_note).toContain("offset=100");
  });
});

describe("TenderNedSource.search sort and query syntax", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("sends the sort keys tenderned.nl itself uses, and nothing by default", async () => {
    const fetchMock = fakeUpstream(5);
    vi.stubGlobal("fetch", fetchMock);
    const src = new TenderNedSource(testConfig);

    await src.search({ query: "fietsbrug", rows: 5, sort: "date_newest" });
    await src.search({ query: "fietsbrug", rows: 5, sort: "relevance" });
    await src.search({ query: "fietsbrug", rows: 5 });

    const sorts = calledUrls(fetchMock).map((u) => u.searchParams.get("sort"));
    expect(sorts).toEqual(["tappublicatiedatum", "relevantie", null]);
  });

  it("explains that loose words are OR-matched", async () => {
    vi.stubGlobal("fetch", fakeUpstream(5));
    const out = await new TenderNedSource(testConfig).search({ query: "Gemeente Utrecht", rows: 5 });
    expect(out.access_note).toContain("met OF");
    expect(out.access_note).toContain("opdrachtgever");
  });

  it("does not add the OR note for a single word or a whole-query phrase", async () => {
    vi.stubGlobal("fetch", fakeUpstream(5));
    const src = new TenderNedSource(testConfig);
    expect((await src.search({ query: "fietsbrug", rows: 5 })).access_note ?? "").not.toContain("met OF");
    expect((await src.search({ query: '"openbare verlichting"', rows: 5 })).access_note ?? "").not.toContain("OF");
  });

  it("warns about quote usage TenderNed does not support", async () => {
    vi.stubGlobal("fetch", fakeUpstream(5));
    const src = new TenderNedSource(testConfig);
    expect((await src.search({ query: '"jeugdzorg" "Zwolle"', rows: 5 })).access_note).toContain("één frase");
    expect((await src.search({ query: '"openbare verlichting" lantaarnpalen', rows: 5 })).access_note).toContain(
      "hele zoekterm één frase",
    );
  });
});

describe("TenderNedSource.search opdrachtgever", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  type Authority = { aanbestedendedienstId: string; naam: string };

  /**
   * Shaped like TenderNed's register: pages of at most 100, and a `search`
   * that is a case-insensitive substring match which does NOT ignore accents
   * or apostrophe style ('Fryslan' misses 'Fryslân', ’s misses 's).
   */
  function registerResponse(authorities: Authority[], url: URL): Response {
    const page = Number(url.searchParams.get("page"));
    const size = Number(url.searchParams.get("size"));
    if (size > 100) return jsonResponse({ message: "must be less than or equal to 100" }, 400);
    const search = url.searchParams.get("search");
    const hits = search ? authorities.filter((a) => a.naam.toLowerCase().includes(search.toLowerCase())) : authorities;
    return jsonResponse({ content: hits.slice(page * size, (page + 1) * size), totalElements: hits.length });
  }

  function withAuthorities(authorities: Authority[], failRegisterPage?: number) {
    const publicaties = fakeUpstream(3);
    return vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/aanbestedendediensten")) {
        const isPage = !url.searchParams.get("search") && Number(url.searchParams.get("page")) === failRegisterPage;
        // A 4xx: a 5xx would be retried and count toward the shared circuit breaker.
        if (isPage) return jsonResponse({ message: "kapot" }, 404);
        return registerResponse(authorities, url);
      }
      return publicaties(input);
    });
  }

  const registerCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    calledUrls(fetchMock).filter((u) => u.pathname.endsWith("/aanbestedendediensten"));
  const publicatieCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    calledUrls(fetchMock).filter((u) => u.pathname.endsWith("/publicaties"));

  it("filters server-side on whole-name matches only", async () => {
    const fetchMock = withAuthorities([
      { aanbestedendedienstId: "utrecht", naam: "Gemeente Utrecht" },
      { aanbestedendedienstId: "heuvelrug", naam: "Gemeente Utrechtse Heuvelrug" },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TenderNedSource(testConfig).search({ opdrachtgever: "gemeente utrecht", rows: 5 });
    const [lookup] = registerCalls(fetchMock);
    const [publicaties] = publicatieCalls(fetchMock);
    expect(lookup.pathname).toBe("/papi/tenderned-rs-tns/v2/aanbestedendediensten");
    expect(publicaties.searchParams.getAll("aanbestedendeDienstId")).toEqual(["utrecht"]);
    expect(publicaties.searchParams.get("search")).toBeNull();
    expect(out.params.aanbestedendeDienstId).toBe("utrecht");
    expect(out.access_note).toContain("'Gemeente Utrecht'");
    expect(out.access_note).not.toContain("Heuvelrug");
  });

  it("does not suggest the opdrachtgever filter when it is already applied", async () => {
    vi.stubGlobal("fetch", withAuthorities([{ aanbestedendedienstId: "utrecht", naam: "Gemeente Utrecht" }]));
    const out = await new TenderNedSource(testConfig).search({ opdrachtgever: "Gemeente Utrecht", query: "openbare verlichting", rows: 5 });
    expect(out.access_note).toContain("met OF");
    expect(out.access_note).not.toContain("parameter 'opdrachtgever'");
  });

  it("includes every unit of an organisation and repeats the id parameter", async () => {
    const fetchMock = withAuthorities([
      { aanbestedendedienstId: "a", naam: "Ministerie van Defensie, Koninklijke Marine" },
      { aanbestedendedienstId: "b", naam: "Ministerie van Defensie - Defensie Pijpleiding Organisatie" },
      { aanbestedendedienstId: "c", naam: "Nederlandse Defensie Academie" },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TenderNedSource(testConfig).search({
      opdrachtgever: "Ministerie van Defensie",
      query: '"openbare verlichting"',
      rows: 5,
    });
    const [publicaties] = publicatieCalls(fetchMock);
    expect(publicaties.searchParams.getAll("aanbestedendeDienstId")).toEqual(["a", "b"]);
    expect(publicaties.searchParams.get("search")).toBe('"openbare verlichting"');
    expect(out.access_note).toContain("2 aanbestedende diensten");
  });

  it("ignores accents, apostrophe style and punctuation, which the register's own search does not", async () => {
    const register = [
      { aanbestedendedienstId: "nf", naam: "Gemeente Noardeast-Fryslân" },
      { aanbestedendedienstId: "ws", naam: "Wetterskip Fryslân" },
      { aanbestedendedienstId: "dji1", naam: "Dienst Justitiële Inrichtingen - Specialistisch Inkoop Centrum" },
      { aanbestedendedienstId: "dji2", naam: "Inkoop Uitvoeringscentrum Dienst Justitiële Inrichtingen (IUC DJI)" },
      { aanbestedendedienstId: "dbosch", naam: "Gemeente 's-Hertogenbosch" },
      { aanbestedendedienstId: "omrop", naam: "Stichting Omrop Fryslan" },
    ];
    // The mocked register search is accent-sensitive, like the live one.
    const direct = registerResponse(register, new URL("https://x/aanbestedendediensten?page=0&size=100&search=Noardeast-Fryslan"));
    expect(await direct.json()).toMatchObject({ totalElements: 0 });

    const cases: Array<[string, string]> = [
      ["Gemeente Noardeast-Fryslan", "nf"],
      ["gemeente noardeast fryslan", "nf"],
      ["Wetterskip Fryslan", "ws"],
      ["Dienst Justitiele Inrichtingen", "dji1,dji2"],
      ["Gemeente ’s-Hertogenbosch", "dbosch"],
      ["Fryslan", "nf,ws,omrop"],
    ];
    for (const [name, ids] of cases) {
      clearHttpCache();
      vi.stubGlobal("fetch", withAuthorities(register));
      const out = await new TenderNedSource(testConfig).search({ opdrachtgever: name, rows: 5 });
      expect(out.params.aanbestedendeDienstId, name).toBe(ids);
    }
  });

  it("reads every page of the register once and reuses it", async () => {
    const register = Array.from({ length: 250 }, (_, i) => ({ aanbestedendedienstId: `id${i}`, naam: `Stichting nummer ${i}` }));
    register.push({ aanbestedendedienstId: "target", naam: "Gemeente Noardeast-Fryslân" });
    const fetchMock = withAuthorities(register);
    vi.stubGlobal("fetch", fetchMock);

    const src = new TenderNedSource(testConfig);
    const out = await src.search({ opdrachtgever: "Gemeente Noardeast-Fryslan", rows: 5 });
    expect(out.params.aanbestedendeDienstId).toBe("target");
    const pages = registerCalls(fetchMock).map((u) => u.searchParams.get("page"));
    expect(pages.sort()).toEqual(["0", "1", "2"]);
    expect(registerCalls(fetchMock).every((u) => u.searchParams.get("search") === null)).toBe(true);

    await src.search({ opdrachtgever: "Gemeente Noardeast-Fryslân", rows: 5 });
    expect(registerCalls(fetchMock)).toHaveLength(3);
  });

  it("falls back to the register's own search, and says so, when the register cannot be read", async () => {
    const fetchMock = withAuthorities(
      [
        { aanbestedendedienstId: "utrecht", naam: "Gemeente Utrecht" },
        ...Array.from({ length: 150 }, (_, i) => ({ aanbestedendedienstId: `id${i}`, naam: `Stichting ${i}` })),
      ],
      1,
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TenderNedSource(testConfig).search({ opdrachtgever: "Gemeente Utrecht", rows: 5 });
    expect(out.params.aanbestedendeDienstId).toBe("utrecht");
    expect(registerCalls(fetchMock).some((u) => u.searchParams.get("search") === "Gemeente Utrecht")).toBe(true);
    expect(out.access_note).toContain("accenten en apostrofs exact");
  });

  it("says so, names near matches, and does not search, when no authority matches", async () => {
    const fetchMock = withAuthorities([
      { aanbestedendedienstId: "x", naam: "Gemeente Utrechtse Heuvelrug" },
      { aanbestedendedienstId: "y", naam: "Provincie Gelderland" },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const out = await new TenderNedSource(testConfig).search({ opdrachtgever: "Gemeente Utrecht", rows: 5 });
    expect(publicatieCalls(fetchMock)).toHaveLength(0);
    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.has_more).toBe(false);
    expect(out.access_note).toContain("Geen aanbestedende dienst");
    expect(out.access_note).toContain("Gemeente Utrechtse Heuvelrug");
    expect(out.access_note).not.toContain("Gelderland");
  });

  it("rejects a name too broad to resolve completely", async () => {
    const many = Array.from({ length: 451 }, (_, i) => ({ aanbestedendedienstId: `g${i}`, naam: `Gemeente ${i}` }));
    const fetchMock = withAuthorities(many);
    vi.stubGlobal("fetch", fetchMock);

    const error = await new TenderNedSource(testConfig).search({ opdrachtgever: "Gemeente", rows: 5 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenderNedInputError);
    expect((error as TenderNedInputError).message).toContain("451");
    expect(publicatieCalls(fetchMock)).toHaveLength(0);
  });
});

describe("TenderNedSource.search mapping", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("uses the market-consultation closing date for MAC notices, as tenderned.nl does", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          content: [
            {
              publicatieId: "220500",
              typePublicatie: { code: "MAC", omschrijving: "Marktconsultatie" },
              sluitingsDatum: "2099-12-31T09:00:00",
              sluitingsDatumMarktconsultatie: "2021-03-11",
            },
            {
              publicatieId: "411343",
              typePublicatie: { code: "AAO", omschrijving: "Aankondiging opdracht" },
              publicatiecode: { code: "EF16", omschrijving: "Aankondiging van een opdracht - algemene richtlijn" },
              sluitingsDatum: "2026-04-14T11:00:00",
            },
            {
              publicatieId: "410077",
              typePublicatie: { code: "AAO", omschrijving: "Aankondiging opdracht" },
              sluitingsDatum: "2125-12-31T13:00:00",
            },
          ],
          totalElements: 3,
        }),
      ),
    );

    const out = await new TenderNedSource(testConfig).search({ rows: 5 });
    expect(out.items[0]).toMatchObject({
      sluitingsDatum: "2021-03-11",
      sluitingsDatumBron: "sluitingsDatumMarktconsultatie",
      sluitingsDatumPlaceholder: false,
    });
    expect(out.items[1]).toMatchObject({
      sluitingsDatum: "2026-04-14T11:00:00",
      sluitingsDatumBron: "sluitingsDatum",
      typePublicatieCode: "AAO",
      publicatieCode: "EF16",
      publicatieCodeOmschrijving: "Aankondiging van een opdracht - algemene richtlijn",
    });
    expect(out.items[2]).toMatchObject({ sluitingsDatumPlaceholder: true });
    expect(out.access_note).toContain("1 publicatie(s) hebben een sluitingsdatum in 2090 of later");
  });

  it("decodes HTML entities and drops zero-width spaces but keeps paragraphs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          content: [
            {
              publicatieId: "421444",
              aanbestedingNaam: "\u200B\u200BMarktconsultatie P&amp;C",
              opdrachtgeverNaam: "Gemeente Ede &amp; Wageningen",
              opdrachtBeschrijving: "Organiseer het werk&nbsp;en voer regie op de P&amp;C-cyclus.\n\nTweede   alinea:\n•\tpunt een",
            },
          ],
          totalElements: 1,
        }),
      ),
    );

    const [item] = (await new TenderNedSource(testConfig).search({ rows: 5 })).items;
    expect(item.title).toBe("Marktconsultatie P&C");
    expect(item.opdrachtgever).toBe("Gemeente Ede & Wageningen");
    expect(item.beschrijving).toBe("Organiseer het werk en voer regie op de P&C-cyclus.\n\nTweede alinea:\n• punt een");
  });

  it("exposes one snake_case field set for search and get", () => {
    const fields = tenderNedRecordFields({
      id: "450123",
      title: "Marktconsultatie Afvalinzameling",
      opdrachtgever: "Gemeente Harderwijk",
      publicatieDatum: "2026-09-10T10:26:00.637087",
      sluitingsDatum: "2026-10-15",
      sluitingsDatumBron: "sluitingsDatumMarktconsultatie",
      sluitingsDatumPlaceholder: false,
      sluitingsDatumGecontroleerd: true,
      sluitingsDatumOorspronkelijk: "2026-10-01",
      laatsteRectificatieId: "441000",
      typePublicatie: "Marktconsultatie",
      typePublicatieCode: "MAC",
      publicatieCode: "EFE1",
      publicatieCodeOmschrijving: "Vrijwillige aankondiging van voorafgaande marktconsultatie",
      procedure: "Marktconsultatie (MAC)",
      typeOpdracht: "Diensten (D)",
      europees: false,
      beschrijving: "",
      kenmerk: "620011",
      url: "https://www.tenderned.nl/aankondigingen/overzicht/450123",
    });
    expect(fields).toMatchObject({
      publicatie_id: "450123",
      publicatie_datum: "2026-09-10",
      sluitings_datum: "2026-10-15",
      sluitings_datum_bron: "sluitingsDatumMarktconsultatie",
      sluitings_datum_gecontroleerd: true,
      sluitings_datum_oorspronkelijk: "2026-10-01",
      laatste_rectificatie_id: "441000",
      type_publicatie: "Marktconsultatie",
      type_publicatie_code: "MAC",
      publicatie_code: "EFE1",
    });
  });

  it("leaves the rectification fields out when there is nothing to report", () => {
    const fields = tenderNedRecordFields({
      id: "1",
      title: "t",
      opdrachtgever: "",
      publicatieDatum: "2026-09-10",
      sluitingsDatum: "",
      sluitingsDatumBron: "",
      sluitingsDatumPlaceholder: false,
      sluitingsDatumGecontroleerd: false,
      typePublicatie: "",
      typePublicatieCode: "",
      publicatieCode: "",
      publicatieCodeOmschrijving: "",
      procedure: "",
      typeOpdracht: "",
      europees: null,
      beschrijving: "",
      kenmerk: "",
      url: "",
    });
    expect(fields).not.toHaveProperty("sluitings_datum_oorspronkelijk");
    expect(fields).not.toHaveProperty("laatste_rectificatie_id");
    expect(fields.sluitings_datum_gecontroleerd).toBe(false);
  });
});
