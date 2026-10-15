import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RVO_STATUS_CHECK_MAX,
  RVO_STATUS_ENRICH_MAX,
  RvoSubsidiesInputError,
  RvoSubsidiesSource,
  buildRvoCatalogue,
  extractRvoFlight,
  findRvoPageNode,
  parseRvoPage,
  parseRvoQuery,
  renderRvoElements,
  rvoFlightTextRows,
  rvoHtmlLines,
  rvoLegalReferences,
  rvoStatusCode,
  rvoStatusFromNode,
  summarizeRvoGet,
  summarizeRvoSearch,
  toRvoItem,
  type RvoSubsidieGetFound,
} from "../src/sources/rvo-subsidies.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { SourceRequestError } from "../src/utils/http.js";
import { htmlResponse, jsonResponse, testConfig } from "./helpers/config.js";
import {
  BMKB_DETAIL,
  BMKB_ID,
  DDP_ID,
  DDP_NODE,
  DEI_WATERSTOF_ID,
  DUMAVA_ID,
  DUMAVA_INTRO_ROW,
  DUMAVA_NODE,
  DUMAVA_TEXT_ROWS,
  FVO_ID,
  FVO_NODE,
  NEDERWIEK_ID,
  RVO_LIST,
  RVO_ROWS,
  SEB_ID,
  SEB_NODE,
  SEL_ID,
  SEL_NODE,
  STUDI_WATERSTOF_ID,
  SWIM_ID,
  SWIM_NODE,
  TOGS_ID,
  fillerRow,
  rvoFlight,
  rvoNodePage,
  rvoPageHtml,
} from "./helpers/rvo-subsidies-fixtures.js";

const row = (id: string) => RVO_ROWS.find((r) => r.id === id)!;
const pathOf = (id: string) => String(row(id).url);

interface Router {
  rows?: unknown[];
  /** Page HTML by path. */
  pages?: Record<string, string>;
  /** Detail records by id. */
  details?: Record<string, unknown>;
  /** List pages that answer 404. */
  failPages?: number[];
  /** HTTP status of a public page not in `pages` (default 404). */
  pageStatus?: number;
  /** Milliseconds to wait before answering a URL (a slow rvo.nl). */
  delay?: (url: URL) => number;
}

/** fetch mock serving the list, detail records and public pages; records every URL. */
function serve(router: Router) {
  const calls: string[] = [];
  const waits: Promise<unknown>[] = [];
  const rows = router.rows ?? RVO_ROWS;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      const ms = router.delay?.(url) ?? 0;
      if (ms > 0) {
        const wait = new Promise((resolve) => setTimeout(resolve, ms));
        waits.push(wait);
        await wait;
      }
      if (`${url.origin}${url.pathname}` === RVO_LIST) {
        const page = Number(url.searchParams.get("page"));
        if (router.failPages?.includes(page)) return jsonResponse({ ok: false, message: "Not found" }, 404);
        return jsonResponse(rows.slice(page * 50, page * 50 + 50));
      }
      if (url.pathname.startsWith("/api/v1/opendata/subsidies/")) {
        const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        const detail = router.details?.[id];
        return detail ? jsonResponse(detail) : jsonResponse({ ok: false, message: "Not found" }, 404);
      }
      const html = router.pages?.[url.pathname];
      return html ? htmlResponse(html) : htmlResponse("<html><body>Pagina niet gevonden</body></html>", router.pageStatus ?? 404);
    }),
  );
  return {
    calls,
    listCalls: () => calls.filter((c) => c.startsWith(`${RVO_LIST}?`)),
    pageCalls: () => calls.filter((c) => !c.includes("/api/v1/opendata/")),
    /** Until the slow answers are in and handled, so no request of this test holds a connector slot. */
    settled: async () => {
      await Promise.allSettled(waits);
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
}

/** Pages of the fixture rows that have page data. */
function fixturePages(): Record<string, string> {
  return {
    [pathOf(SWIM_ID)]: rvoNodePage(pathOf(SWIM_ID), SWIM_ID, SWIM_NODE),
    [pathOf(DDP_ID)]: rvoNodePage(pathOf(DDP_ID), DDP_ID, DDP_NODE),
    [pathOf(FVO_ID)]: rvoNodePage(pathOf(FVO_ID), FVO_ID, FVO_NODE),
    [pathOf(SEL_ID)]: rvoNodePage(pathOf(SEL_ID), SEL_ID, SEL_NODE),
    [pathOf(SEB_ID)]: rvoNodePage(pathOf(SEB_ID), SEB_ID, SEB_NODE),
    [pathOf(DUMAVA_ID)]: rvoNodePage(pathOf(DUMAVA_ID), DUMAVA_ID, DUMAVA_NODE, { ...DUMAVA_TEXT_ROWS, ...DUMAVA_INTRO_ROW }),
    [pathOf(STUDI_WATERSTOF_ID)]: rvoNodePage(pathOf(STUDI_WATERSTOF_ID), STUDI_WATERSTOF_ID, {
      ...SEB_NODE,
      id: STUDI_WATERSTOF_ID,
      startDate: "2026-05-18T09:00:00+02:00",
      endDate: "2027-03-31T17:00:00+02:00",
      budget: { total: 10000000 },
      subsidyStatus: { type: "taxonomy_term--subsidy_status", id: "94e83236-55c0-4976-a735-5e7c84cb01b8", name: "Open voor aanvragen" },
    }),
    [pathOf(DEI_WATERSTOF_ID)]: rvoNodePage(pathOf(DEI_WATERSTOF_ID), DEI_WATERSTOF_ID, { ...FVO_NODE, id: DEI_WATERSTOF_ID }),
  };
}

/** The DUMAVA detail as the API gives it: rich-text blocks, null for every other block. */
const DUMAVA_DETAIL = {
  ...row(DUMAVA_ID),
  body: [null, null, DUMAVA_TEXT_ROWS["16"], null, null, "<h2>Hoeveel subsidie krijgt u?</h2>\n", null, DUMAVA_TEXT_ROWS["18"], null, "<h2>Meer weten?</h2>\n", null, null],
};

const NOW = new Date("2026-10-15T12:00:00+02:00");

beforeEach(() => {
  clearHttpCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("toRvoItem and the catalogue", () => {
  it("reads a list row: absolute url, plain intro, countries and the page level", () => {
    const item = toRvoItem(row(DUMAVA_ID))!;
    expect(item.url).toBe("https://www.rvo.nl/subsidies-financiering/dumava");
    expect(item.path).toBe("/subsidies-financiering/dumava");
    expect(item.intro).not.toContain("rvo_custom");
    expect(item.intro.endsWith("in de kosten om te verduurzamen.")).toBe(true);
    expect(item.main_page).toBe(true);
    expect(item.parent_path).toBeUndefined();

    const bmkb = toRvoItem(row(BMKB_ID))!;
    expect(bmkb.intro).toContain("in de toekomst. Om de financieringsmogelijkheden"); // &nbsp; decoded
    expect(bmkb.countries).toEqual([
      { name: "Nederland", code: "NL" },
      { name: "Caribisch Nederland", code: "BQ" },
      { name: "Bonaire" },
      { name: "Saba" },
    ]);

    const dei = toRvoItem(row(DEI_WATERSTOF_ID))!;
    expect(dei.title).toBe("DEI+: Waterstof en groene chemie");
    expect(dei.main_page).toBe(false);
    expect(dei.parent_path).toBe("/subsidies-financiering/dei");

    const wind = toRvoItem(row(NEDERWIEK_ID))!;
    expect(wind.main_page).toBe(false);
    expect(wind.parent_path).toBe("/onderwerpen/windenergie-op-zee");

    expect(toRvoItem(row(TOGS_ID))!.subjects).toEqual(["Ondernemen en bedrijfsvoering"]);
    expect(toRvoItem({ id: "x" })).toBeUndefined();
    expect(toRvoItem({ id: "x", url: "geen-pad" })).toBeUndefined();
  });

  it("drops duplicate ids and names the nearest page up the path that is in the catalogue", () => {
    const parent = { ...fillerRow(1), title: "Studies voor Duurzame Industrie (STUDI)", url: "/subsidies-financiering/studi" };
    const cat = buildRvoCatalogue([row(STUDI_WATERSTOF_ID), row(STUDI_WATERSTOF_ID), parent, row(DEI_WATERSTOF_ID)], 1, []);
    expect(cat.entries).toHaveLength(3);
    expect(cat.byId.get(STUDI_WATERSTOF_ID)!.item.parent_title).toBe("Studies voor Duurzame Industrie (STUDI)");
    // The DEI+ landing page is not in the open data list (as live): no parent title.
    expect(cat.byId.get(DEI_WATERSTOF_ID)!.item.parent_title).toBeUndefined();
    expect(cat.complete).toBe(true);
    expect(buildRvoCatalogue([], 2, [1]).complete).toBe(false);
  });
});

describe("parseRvoQuery", () => {
  it("requires every word and leaves out stop words and words every page is about", () => {
    expect(parseRvoQuery("subsidie voor waterstof")).toEqual({
      groups: [[{ text: "waterstof", phrase: false, wholeWord: false }]],
      excluded: [],
      ignored: ["subsidie", "voor"],
    });
    // Nothing else left: the generic word is searched after all.
    expect(parseRvoQuery("subsidie").groups).toEqual([[{ text: "subsidie", phrase: false, wholeWord: false }]]);
  });

  it("reads uppercase OR and NOT, -word and quoted phrases; lowercase or is a word", () => {
    const q = parseRvoQuery('waterstof OR elektrolyse -mobiliteit NOT covid "groene chemie"');
    expect(q.groups.map((g) => g.map((t) => t.text))).toEqual([["waterstof"], ["elektrolyse", "groene chemie"]]);
    expect(q.groups[1][1].phrase).toBe(true);
    expect(q.excluded.map((t) => t.text)).toEqual(["mobiliteit", "covid"]);
    const lower = parseRvoQuery("waterstof or elektrolyse");
    expect(lower.groups.map((g) => g.map((t) => t.text))).toEqual([["waterstof", "elektrolyse"]]);
    expect(lower.ignored).toEqual(["or"]);
  });

  it("splits compounds with hyphens and treats short words as whole words", () => {
    const q = parseRvoQuery("MKB-kredieten AI");
    expect(q.groups[0]).toEqual([
      { text: "mkb", phrase: false, wholeWord: true },
      { text: "kredieten", phrase: false, wholeWord: false },
      { text: "ai", phrase: false, wholeWord: true },
    ]);
  });
});

describe("RvoSubsidiesSource.search: catalogue", () => {
  it("reads list pages until a short one and searches the catalogue locally", async () => {
    const rows = [...Array.from({ length: 50 }, (_, i) => fillerRow(i)), ...RVO_ROWS];
    const net = serve({ rows });
    const source = new RvoSubsidiesSource(testConfig);
    const out = await source.search({ query: "waterstof", include_status: false });

    const pages = net.listCalls().map((c) => Number(new URL(c).searchParams.get("page")));
    expect(pages).toContain(0);
    expect(pages).toContain(1);
    // Never more than the workers that were already under way past the last page.
    expect(Math.max(...pages)).toBeLessThanOrEqual(3);
    expect(out.catalogue).toMatchObject({ entries: 62, complete: true, missing_pages: [], stale: false });
    expect(out.items.map((x) => x.id)).toEqual([SWIM_ID, DEI_WATERSTOF_ID, STUDI_WATERSTOF_ID]);
    expect(out.total).toBe(3);
    expect(out.items[0].score).toBeGreaterThan(out.items[1].score!); // the regeling's own page first
    expect(out.params).toMatchObject({ query: "waterstof", page_size: "50", sort: "relevance" });
    expect(out.access_note).toContain("CC0");
    expect(out.access_note).toContain("niet opgevraagd (include_status=false)");
    expect(net.pageCalls()).toHaveLength(0);

    // The catalogue is cached: a second search asks nothing upstream.
    const before = net.calls.length;
    await source.search({ query: "covid", include_status: false });
    expect(net.calls.length).toBe(before);
  });

  it("reports a list page that could not be read and keeps the rest", async () => {
    const rows = [...Array.from({ length: 50 }, (_, i) => fillerRow(i)), ...RVO_ROWS];
    serve({ rows, failPages: [1] });
    const out = await new RvoSubsidiesSource(testConfig).search({ query: "testpagina", include_status: false, limit: 5 });
    expect(out.catalogue).toMatchObject({ complete: false, missing_pages: [1], entries: 50 });
    expect(out.total).toBe(50);
    expect(out.access_note).toContain("Onvolledige catalogus: lijstpagina 1");
  });

  it("stops reading after 3 failed pages instead of asking every page", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => fillerRow(i));
    const net = serve({ rows, failPages: [1, 2, 3] });
    const out = await new RvoSubsidiesSource(testConfig).search({ query: "testpagina", include_status: false, limit: 1 });
    // At most the pages the 3 workers already had under way when the third failure came in.
    expect(net.listCalls().length).toBeLessThanOrEqual(6);
    expect(out.catalogue).toMatchObject({ missing_pages: [1, 2, 3], truncated: "stopped", complete: false });
    expect(out.catalogue.entries).toBe(50 * (net.listCalls().length - 3));
    expect(out.access_note).toContain("Onvolledige catalogus: lijstpagina 1, 2, 3 (50 items per pagina)");
    expect(out.access_note).toContain("het lezen gestopt");
  });

  it("fails when no list page can be read", async () => {
    const net = serve({ failPages: [0, 1, 2, 3] });
    const error = await new RvoSubsidiesSource(testConfig).search({ query: "waterstof" }).catch((e: unknown) => e);
    expect(net.listCalls().length).toBeLessThanOrEqual(3);
    expect(error).toBeInstanceOf(SourceRequestError);
    expect((error as SourceRequestError).status).toBe(404);
  });

  it("serves the previous catalogue, marked stale, when a refresh fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    serve({});
    const source = new RvoSubsidiesSource(testConfig);
    await source.search({ query: "covid", include_status: false });
    vi.setSystemTime(new Date(NOW.getTime() + 4 * 60 * 60 * 1000));
    serve({ failPages: [0, 1, 2] });
    const out = await source.search({ query: "covid", include_status: false });
    expect(out.items.map((x) => x.id)).toEqual([TOGS_ID]);
    expect(out.catalogue.stale).toBe(true);
    expect(out.access_note).toContain("kon niet worden ververst");
  });
});

describe("RvoSubsidiesSource.search: filters, sorting and paging", () => {
  it("matches excluded words, OR and phrases in title, intro, regeling names and tags", async () => {
    serve({});
    const source = new RvoSubsidiesSource(testConfig);
    const noMobility = await source.search({ query: "waterstof -mobiliteit", include_status: false });
    expect(noMobility.items.map((x) => x.id)).toEqual([DEI_WATERSTOF_ID, STUDI_WATERSTOF_ID]);
    const either = await source.search({ query: "coronavirus OR dieselverbruik", include_status: false });
    expect(either.items.map((x) => x.id).sort()).toEqual([SEL_ID, TOGS_ID].sort());
    const phrase = await source.search({ query: '"maatschappelijk vastgoed"', include_status: false });
    expect(phrase.items.map((x) => x.id)).toEqual([DUMAVA_ID]);
    const none = await source.search({ query: "waterstof zeevaart", include_status: false });
    expect(none.total).toBe(0);
    expect(none.access_note).toContain("alle zoekwoorden moeten voorkomen");
  });

  it("resolves doelgroep, onderwerp and land against the catalogue's own values", async () => {
    serve({});
    const source = new RvoSubsidiesSource(testConfig);
    const mkb = await source.search({ doelgroep: "mkb", query: "waterstof", include_status: false });
    expect(mkb.filters.doelgroep).toBe("MKB (ook zzp)");
    expect(mkb.total).toBe(3);

    const onderwerp = await source.search({ onderwerp: "ondernemen en bedrijfsvoering", include_status: false });
    expect(onderwerp.items.map((x) => x.id)).toEqual([TOGS_ID]);

    const byCode = await source.search({ land: "gh", include_status: false });
    const byName = await source.search({ land: "Ghana", include_status: false });
    expect(byCode.items.map((x) => x.id)).toEqual([DDP_ID]);
    expect(byName.items.map((x) => x.id)).toEqual([DDP_ID]);
    expect(byCode.filters.land).toBe("Ghana");
  });

  it("returns nothing for a value the catalogue does not hold, and says which values exist", async () => {
    const net = serve({ pages: fixturePages() });
    const out = await new RvoSubsidiesSource(testConfig).search({ query: "zorginnovatie", doelgroep: "ruimtevaarders" });
    expect(out.total).toBe(0);
    expect(out.items).toEqual([]);
    expect(out.filters.doelgroep).toBe("ruimtevaarders (onbekend)");
    expect(out.access_note).toContain("Doelgroep 'ruimtevaarders' komt in de catalogus niet voor");
    expect(out.access_note).toContain("MKB (ook zzp)");
    expect(net.pageCalls()).toHaveLength(0);

    const land = await new RvoSubsidiesSource(testConfig).search({ land: "Atlantis", include_status: false });
    expect(land.total).toBe(0);
    expect(land.access_note).toContain("Land 'Atlantis' komt in de catalogus niet voor");
  });

  it("filters on changed_since and main pages, sorts by creation and pages locally", async () => {
    serve({});
    const source = new RvoSubsidiesSource(testConfig);
    await expect(source.search({ changed_since: "1 oktober" })).rejects.toBeInstanceOf(RvoSubsidiesInputError);

    const recent = await source.search({ changed_since: "2026-10-01", sort: "created", include_status: false });
    expect(recent.items.map((x) => x.id)).toEqual([SEB_ID, DDP_ID, SEL_ID, DUMAVA_ID, FVO_ID]);

    const main = await source.search({ query: "waterstof", main_pages_only: true, include_status: false });
    expect(main.items.map((x) => x.id)).toEqual([SWIM_ID]);

    const page = await source.search({ sort: "changed", offset: 2, limit: 3, include_status: false });
    expect(page.total).toBe(RVO_ROWS.length);
    expect(page.items).toHaveLength(3);
    expect(page.has_more).toBe(true);
    expect(summarizeRvoSearch(page)).toContain("getoond 3-5");
  });
});

describe("RvoSubsidiesSource.search: status from the public pages", () => {
  it("reads the pages of the results for status, period and budget, once", async () => {
    const net = serve({ pages: fixturePages() });
    const source = new RvoSubsidiesSource(testConfig);
    const out = await source.search({ query: "waterstof" });
    const byId = new Map(out.items.map((x) => [x.id, x.status_info!]));
    expect(byId.get(SWIM_ID)).toMatchObject({
      status: "tijdelijk_gesloten",
      status_label: "Tijdelijk gesloten voor aanvragen",
      application_start: "2026-04-01T09:00:00+02:00",
      application_end: "2026-05-13T17:00:00+02:00",
      period_text: "1 april 2026 09:00 tot 13 mei 2026 17:00",
      budget_total_eur: 45000000,
      status_source_url: "https://www.rvo.nl/subsidies-financiering/waterstof-mobiliteit",
    });
    expect(byId.get(STUDI_WATERSTOF_ID)!.status).toBe("open");
    expect(byId.get(DEI_WATERSTOF_ID)!.status).toBe("gesloten");
    expect(net.pageCalls()).toHaveLength(3);
    expect(out.params.status_pages).toContain("3 pagina's");
    expect(out.access_note).toContain("niet in de open-data-API");
    expect(summarizeRvoSearch(out)).toContain("status getoond:");

    await source.search({ query: "waterstof" });
    expect(net.pageCalls()).toHaveLength(3); // cached
  });

  it("marks a page that cannot be read as unknown, with the reason", async () => {
    serve({ pages: {} });
    const out = await new RvoSubsidiesSource(testConfig).search({ query: "covid" });
    expect(out.items[0].status_info).toEqual({
      status: "onbekend",
      status_source_url: "https://www.rvo.nl/subsidies-financiering/togs",
      status_note: "Status onbekend: de pagina bestaat niet (meer) (HTTP 404).",
    });
  });

  it("filters by status by reading the candidates' pages in ranking order", async () => {
    serve({ pages: fixturePages() });
    const out = await new RvoSubsidiesSource(testConfig).search({ query: "waterstof", status: ["open", "bijna_open"] });
    expect(out.items.map((x) => x.id)).toEqual([STUDI_WATERSTOF_ID]);
    expect(out.total).toBe(1);
    expect(out.status_checks).toEqual({ candidates: 3, checked: 3, unreadable: 0, matches: 1, all_checked: true });
    expect(out.filters.status).toBe("Open voor aanvragen | Bijna open voor aanvragen");
    expect(out.has_more).toBe(false);
  });

  it(`stops after ${RVO_STATUS_CHECK_MAX} page reads and then gives no total`, async () => {
    const rows = Array.from({ length: 45 }, (_, i) => fillerRow(i));
    const pages: Record<string, string> = {};
    for (const r of rows) pages[String(r.url)] = rvoNodePage(String(r.url), String(r.id), { ...FVO_NODE, id: r.id });
    const net = serve({ rows, pages });
    const out = await new RvoSubsidiesSource(testConfig).search({ query: "testpagina", status: ["open"] });
    expect(net.pageCalls()).toHaveLength(RVO_STATUS_CHECK_MAX);
    expect(out.items).toEqual([]);
    expect(out.total).toBeNull();
    expect(out.has_more).toBe(true);
    expect(out.status_checks).toMatchObject({ candidates: 45, checked: RVO_STATUS_CHECK_MAX, matches: 0, all_checked: false });
    expect(out.access_note).toContain("De overige 5 zijn niet gecontroleerd");
    expect(summarizeRvoSearch(out)).toContain("minstens 0");
  });
});

describe("RvoSubsidiesSource: time limits", () => {
  /** A deadline or budget of 0,1 s, and pages that take 0,6 s. */
  const LIMIT = 100;
  const SLOW = 600;
  const listPage = (url: URL) => (`${url.origin}${url.pathname}` === RVO_LIST ? Number(url.searchParams.get("page")) : undefined);
  const labelledPage = (r: Record<string, unknown>, label: string) =>
    rvoNodePage(String(r.url), String(r.id), { ...FVO_NODE, id: r.id, subsidyStatus: { name: label } });

  it("stops loading the catalogue at the deadline, once for all callers: pages under way are missing, the rest unknown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const rows = Array.from({ length: 1000 }, (_, i) => fillerRow(i));
    const net = serve({ rows, delay: (url) => ((listPage(url) ?? 0) >= 2 ? SLOW : 0) });
    const source = new RvoSubsidiesSource(testConfig, { catalogueDeadlineMs: LIMIT });
    const started = performance.now();
    const [a, b] = await Promise.all([
      source.search({ query: "testpagina", include_status: false, limit: 1 }),
      source.search({ query: "testpagina", include_status: false, limit: 1 }),
    ]);
    expect(performance.now() - started).toBeLessThan(SLOW - 100);
    // Pages 0 and 1 read; 2, 3 and 4 were under way at the deadline. One load for both callers.
    expect(net.listCalls()).toHaveLength(5);
    expect(a.catalogue).toMatchObject({ entries: 100, pages_read: 2, missing_pages: [2, 3, 4], truncated: "deadline", complete: false, stale: false });
    expect(b.catalogue).toEqual(a.catalogue);
    expect(a.total).toBe(100);
    expect(a.access_note).toContain("Onvolledige catalogus: lijstpagina 2, 3, 4 (50 items per pagina) kon niet (op tijd) worden gelezen.");
    expect(a.access_note).toContain("Het laden van de catalogus is na 0,1 s afgebroken (rvo.nl was traag): de lijstpagina's na pagina 4 ontbreken ook.");
    expect(a.access_note).toContain("Een aanroep na 5 minuten laadt de catalogus opnieuw.");

    // The late answers change nothing and start no further pages; the incomplete catalogue is kept 5 minutes.
    await net.settled();
    expect(net.listCalls()).toHaveLength(5);
    const cached = await source.search({ query: "testpagina", include_status: false, limit: 1 });
    expect(net.listCalls()).toHaveLength(5);
    expect(cached.catalogue.missing_pages).toEqual([2, 3, 4]);

    vi.setSystemTime(new Date(NOW.getTime() + 6 * 60 * 1000));
    const fast = serve({ rows });
    const reloaded = await source.search({ query: "testpagina", include_status: false, limit: 1 });
    expect(fast.listCalls().length).toBeGreaterThanOrEqual(21);
    expect(reloaded.catalogue).toMatchObject({ entries: 1000, missing_pages: [], complete: true });
    expect(reloaded.access_note).not.toContain("Onvolledige catalogus");
  });

  it("knows where the list ends when a short page came in, and misses only the pages under way", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => fillerRow(i));
    const net = serve({ rows, delay: (url) => (listPage(url) === 1 ? SLOW : 0) });
    const out = await new RvoSubsidiesSource(testConfig, { catalogueDeadlineMs: LIMIT }).search({ query: "testpagina", include_status: false, limit: 1 });
    expect(out.catalogue).toMatchObject({ entries: 70, missing_pages: [1], complete: false });
    expect(out.catalogue.truncated).toBeUndefined();
    expect(out.access_note).toContain("lijstpagina 1 (50 items per pagina) kon niet (op tijd) worden gelezen");
    expect(out.access_note).not.toContain("afgebroken");
    await net.settled();
  });

  it("fails with a timeout when no list page comes in time, and keeps a complete catalogue over a slow, incomplete refresh", async () => {
    const slow = serve({ delay: () => SLOW });
    const error = await new RvoSubsidiesSource(testConfig, { catalogueDeadlineMs: LIMIT }).search({ query: "waterstof" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceRequestError);
    expect((error as SourceRequestError).code).toBe("timeout");
    expect((error as SourceRequestError).message).toBe("RVO open data gaf binnen 0,1 s geen lijstpagina terug.");
    await slow.settled();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const rows = [...Array.from({ length: 50 }, (_, i) => fillerRow(i)), ...RVO_ROWS];
    serve({ rows });
    const source = new RvoSubsidiesSource(testConfig, { catalogueDeadlineMs: LIMIT });
    expect((await source.search({ query: "covid", include_status: false })).catalogue.complete).toBe(true);
    vi.setSystemTime(new Date(NOW.getTime() + 4 * 60 * 60 * 1000));
    const net = serve({ rows, delay: (url) => (listPage(url) === 1 ? SLOW : 0) });
    const out = await source.search({ query: "covid", include_status: false });
    expect(out.items.map((x) => x.id)).toEqual([TOGS_ID]); // on list page 1, which the refresh missed
    expect(out.catalogue).toMatchObject({ entries: 62, complete: true, stale: true });
    expect(out.access_note).toContain("kon niet worden ververst");
    await net.settled();
  });

  it("gives a result whose page was not read within the time budget status 'onbekend', and remembers the late read", async () => {
    const net = serve({ pages: fixturePages(), delay: (url) => (url.pathname === pathOf(SWIM_ID) ? SLOW : 0) });
    const source = new RvoSubsidiesSource(testConfig, { statusBudgetMs: LIMIT });
    const started = performance.now();
    const out = await source.search({ query: "waterstof" });
    expect(performance.now() - started).toBeLessThan(SLOW - 100);
    expect(out.items.find((x) => x.id === SWIM_ID)!.status_info).toEqual({
      status: "onbekend",
      status_source_url: "https://www.rvo.nl/subsidies-financiering/waterstof-mobiliteit",
      status_note: "Status onbekend: de pagina is niet gelezen binnen de tijdslimiet (0,1 s voor de statuspagina's van een zoekvraag); rvo_subsidie_get leest haar apart.",
    });
    expect(out.items.find((x) => x.id === STUDI_WATERSTOF_ID)!.status_info!.status).toBe("open");
    expect(out.total).toBe(3);
    expect(out.params.status_pages).toContain("2 pagina's");
    expect(out.access_note).toContain("Van 1 resultaat is de pagina niet binnen de tijdslimiet van 0,1 s gelezen; de status is daar onbekend.");
    expect(summarizeRvoSearch(out)).toContain("1 niet op tijd gelezen");

    // The read that came in late is kept: the next search shows it without asking again.
    await net.settled();
    const again = await source.search({ query: "waterstof" });
    expect(again.items.find((x) => x.id === SWIM_ID)!.status_info!.status).toBe("tijdelijk_gesloten");
    expect(again.access_note).not.toContain("tijdslimiet");
    expect(net.pageCalls()).toHaveLength(3);
  });

  it("with a status filter, counts candidates not read in time as unchecked: no total, more to come", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => fillerRow(i));
    const pages: Record<string, string> = {};
    for (const r of rows) pages[String(r.url)] = labelledPage(r, "Open voor aanvragen");
    const slowPaths = new Set(rows.slice(2).map((r) => String(r.url)));
    const net = serve({ rows, pages, delay: (url) => (slowPaths.has(url.pathname) ? SLOW : 0) });
    const started = performance.now();
    const out = await new RvoSubsidiesSource(testConfig, { statusBudgetMs: LIMIT }).search({ query: "testpagina", status: ["open"], limit: 10 });
    expect(performance.now() - started).toBeLessThan(SLOW - 100);
    // The first batch of 6: two pages read, three under way and one not started at the deadline.
    expect(net.pageCalls()).toHaveLength(5);
    expect(out.items.map((x) => x.title)).toEqual(["Testpagina 0", "Testpagina 1"]);
    expect(out.total).toBeNull();
    expect(out.has_more).toBe(true);
    expect(out.status_checks).toEqual({ candidates: 12, checked: 2, unreadable: 0, matches: 2, all_checked: false });
    expect(out.access_note).toContain("De overige 10 zijn niet gecontroleerd, dus het totaal is onbekend");
    expect(out.access_note).toContain("De tijdslimiet van 0,1 s voor het lezen van statuspagina's is bereikt: 4 pagina's zijn niet op tijd gelezen");
    expect(summarizeRvoSearch(out)).toContain("minstens 2 pagina's");
    await net.settled();
  });

  it(`reads the status of at most ${RVO_STATUS_ENRICH_MAX} results per search and says so`, async () => {
    const rows = Array.from({ length: 12 }, (_, i) => fillerRow(i));
    const pages: Record<string, string> = {};
    for (const r of rows) pages[String(r.url)] = labelledPage(r, "Gesloten voor aanvragen");
    const net = serve({ rows, pages });
    const out = await new RvoSubsidiesSource(testConfig).search({ query: "testpagina", limit: 12 });
    expect(RVO_STATUS_ENRICH_MAX).toBe(10);
    expect(net.pageCalls()).toHaveLength(10);
    expect(out.items.filter((x) => x.status_info)).toHaveLength(10);
    expect(out.params.status_pages).toContain("10 pagina's");
    expect(out.access_note).toContain("Status opgevraagd voor de eerste 10 resultaten (hooguit 10 per aanroep)");
    expect(summarizeRvoSearch(out)).toContain("status opgevraagd voor de eerste 10 (hooguit 10 per aanroep); status getoond: 10 'Gesloten voor aanvragen'");
  });

  it("asks a page that fails with a server error twice, not three times", async () => {
    const net = serve({ pages: {}, pageStatus: 500 });
    const out = await new RvoSubsidiesSource(testConfig).search({ query: "covid" });
    expect(net.pageCalls()).toEqual(["https://www.rvo.nl/subsidies-financiering/togs", "https://www.rvo.nl/subsidies-financiering/togs"]);
    expect(out.items[0].status_info?.status_note).toBe("Status onbekend: de pagina was niet te lezen (http_error 500).");
  });
});

describe("flight payload", () => {
  it("reads text rows that follow each other without a line end, by UTF-8 length", () => {
    const rows = { "16": "€ 2.500 – vóór", "1a": "<p>ë</p>\nregel 2" };
    const flight = rvoFlight({ id: DUMAVA_ID, node: DUMAVA_NODE, textRows: rows });
    const parsed = rvoFlightTextRows(flight);
    expect(parsed.get("16")).toBe(rows["16"]);
    expect(parsed.get("1a")).toBe(rows["1a"]);
  });

  it("joins the pushed chunks, finds the node with real values and resolves its text references", () => {
    const html = rvoPageHtml({
      path: "/subsidies-financiering/dumava",
      flight: rvoFlight({ id: DUMAVA_ID, node: { ...DUMAVA_NODE, title: "$$5 korting" }, textRows: { ...DUMAVA_TEXT_ROWS, ...DUMAVA_INTRO_ROW }, decoyFirst: true }),
      chunkSize: 97,
    });
    const node = findRvoPageNode(extractRvoFlight(html), DUMAVA_ID)!;
    expect(node.title).toBe("$5 korting");
    expect(node.intro).toBe(DUMAVA_INTRO_ROW["19"]);
    const blocks = node.contentElements as Array<{ text?: string }>;
    expect(blocks[2].text).toBe(DUMAVA_TEXT_ROWS["16"]);
    expect((node.subsidyStatus as { name: string }).name).toBe("Open voor aanvragen");
    expect(findRvoPageNode(extractRvoFlight(html), FVO_ID)).toBeUndefined();
  });
});

describe("rvoStatusFromNode", () => {
  const url = "https://www.rvo.nl/subsidies-financiering/x";

  it("takes the label, period and budget as the page gives them", () => {
    const s = rvoStatusFromNode(DUMAVA_NODE, url, NOW);
    expect(s).toEqual({
      status: "open",
      status_label: "Open voor aanvragen",
      application_start: "2026-06-01T09:00:00+02:00",
      application_end: "2026-10-16T17:00:00+02:00",
      period_text: "1 juni 2026 09:00 tot 16 oktober 2026 17:00",
      period_state: "running",
      budget_total_eur: 405000000,
      budget_in_progress_eur: 206719285,
      budget_available_eur: 198280715,
      budget_date: "2026-10-12",
      budget_note: "€ 113.301.823 is nog gereserveerd voor integrale verduurzamingsprojecten.",
      page_checked_at: "2026-10-12T12:00:00+02:00",
      status_source_url: url,
      status_evidence:
        'subsidyStatus.name="Open voor aanvragen"; startDate=2026-06-01T09:00:00+02:00; endDate=2026-10-16T17:00:00+02:00; ' +
        "budget.total=405000000; budget.negotiation=206719285 (paginagegevens van https://www.rvo.nl/subsidies-financiering/x)",
    });
  });

  it("does not let the amount still available go below zero and keeps the change notice", () => {
    const s = rvoStatusFromNode(SEL_NODE, url, NOW);
    expect(s).toMatchObject({
      status: "tijdelijk_gesloten",
      period_state: "ended",
      budget_total_eur: 23600000,
      budget_in_progress_eur: 57559747,
      budget_available_eur: 0,
      subsidy_info: "Minimaal € 3.000, maximaal € 600.000",
      subsidy_info_title: "Hoogte subsidie",
      change_notice: "De subsidie sluit op 2 oktober om 17:00 uur. We hebben de webpagina hierop aangepast.",
    });
    expect(s.status_note).toBeUndefined();
  });

  it("says where the label and the dates disagree, without changing the label", () => {
    const notStarted = rvoStatusFromNode(DDP_NODE, url, NOW);
    expect(notStarted.status).toBe("open");
    expect(notStarted.period_state).toBe("not_started");
    expect(notStarted.status_note).toBe("Label 'Open voor aanvragen', maar de aanvraagperiode op de pagina begint pas op 7 december 2026 09:00.");

    const ended = rvoStatusFromNode(DUMAVA_NODE, url, new Date("2026-11-01T12:00:00+01:00"));
    expect(ended.status_note).toBe("Label 'Open voor aanvragen', maar de einddatum op de pagina (16 oktober 2026 17:00) is voorbij.");

    const closedRunning = rvoStatusFromNode(SWIM_NODE, url, new Date("2026-05-01T12:00:00+02:00"));
    expect(closedRunning.status_note).toBe(
      "Label 'Tijdelijk gesloten voor aanvragen', terwijl de periode op de pagina (1 april 2026 09:00 tot 13 mei 2026 17:00) nog loopt.",
    );

    const soon = rvoStatusFromNode(SEB_NODE, url, NOW);
    expect(soon).toMatchObject({ status: "bijna_open", period_state: "not_started", subsidy_info_title: "Subsidiebedrag" });
    expect(soon.status_note).toBeUndefined();
  });

  it("handles pages without dates, without times, without a label or with another label", () => {
    const closed = rvoStatusFromNode(FVO_NODE, url, NOW);
    expect(closed.status).toBe("gesloten");
    expect(closed.application_start).toBeUndefined();
    expect(closed.period_state).toBeUndefined();

    const datesOnly = rvoStatusFromNode({ ...DUMAVA_NODE, disableTime: true }, url, NOW);
    expect(datesOnly.period_text).toBe("1 juni 2026 tot 16 oktober 2026");

    const none = rvoStatusFromNode({ ...FVO_NODE, subsidyStatus: null }, url, NOW);
    expect(none.status).toBe("onbekend");
    expect(none.status_note).toBe("De pagina toont geen statuslabel.");

    expect(rvoStatusCode("Op aanvraag")).toBe("overig");
    expect(rvoStatusCode(" open voor AANVRAGEN ")).toBe("open");
    expect(rvoStatusCode(undefined)).toBe("onbekend");
  });
});

describe("rvoStatusFromNode: a period of days", () => {
  const url = "https://www.rvo.nl/subsidies-financiering/x";
  // As rvo.nl gives a period without times: each day's midnight, disableTime set.
  const days = { ...DUMAVA_NODE, startDate: "2026-03-02T00:00:00+01:00", endDate: "2026-12-31T00:00:00+01:00", disableTime: true };

  it("counts the last day as part of the period, as 'tot 31 december 2026' on the page does", () => {
    const lastDay = rvoStatusFromNode(days, url, new Date("2026-12-31T23:30:00+01:00"));
    expect(lastDay).toMatchObject({ period_text: "2 maart 2026 tot 31 december 2026", period_state: "running" });
    expect(lastDay.status_note).toBeUndefined();

    const after = rvoStatusFromNode(days, url, new Date("2027-01-01T00:30:00+01:00"));
    expect(after.period_state).toBe("ended");
    expect(after.status_note).toBe("Label 'Open voor aanvragen', maar de einddatum op de pagina (31 december 2026) is voorbij.");
  });

  it("starts the period on its first day in Amsterdam time", () => {
    expect(rvoStatusFromNode(days, url, new Date("2026-03-01T23:30:00+01:00")).period_state).toBe("not_started");
    expect(rvoStatusFromNode(days, url, new Date("2026-03-02T00:10:00+01:00")).period_state).toBe("running");
  });
});

describe("parseRvoPage", () => {
  const path = "/subsidies-financiering/fvo";
  const url = `https://www.rvo.nl${path}`;

  it("ignores a page that is another page (the old URL redirects there)", () => {
    const html = rvoPageHtml({
      path,
      canonical: "https://www.rvo.nl/onderwerpen/internationaal-innoveren/regelingen",
      flag: "Open voor aanvragen",
      flight: rvoFlight({ id: FVO_ID, node: FVO_NODE }),
    });
    const read = parseRvoPage(html, FVO_ID, url, NOW);
    expect(read.status.status).toBe("onbekend");
    expect(read.status.status_note).toContain("verwijst door naar https://www.rvo.nl/onderwerpen/internationaal-innoveren/regelingen");
    expect(read.elements).toBeUndefined();
  });

  it("falls back to the rendered flag, and says when there is nothing to read", () => {
    const flagOnly = parseRvoPage(rvoPageHtml({ path, flag: "Gesloten voor aanvragen" }), FVO_ID, url, NOW);
    expect(flagOnly.status).toMatchObject({ status: "gesloten", status_label: "Gesloten voor aanvragen" });
    expect(flagOnly.status.status_note).toContain("Alleen het statuslabel");

    const empty = parseRvoPage(rvoPageHtml({ path }), FVO_ID, url, NOW);
    expect(empty.status.status).toBe("onbekend");
    expect(empty.status.status_note).toContain("niet gevonden op de pagina");
  });

  it("returns the node's blocks with the status", () => {
    const read = parseRvoPage(rvoNodePage(path, FVO_ID, FVO_NODE), FVO_ID, url, NOW);
    expect(read.status.status).toBe("gesloten");
    expect(read.elements).toHaveLength(1);
  });
});

describe("text and references", () => {
  it("turns HTML into lines with headings, list items and table rows", () => {
    const lines = rvoHtmlLines(
      "<h2>Budget</h2><p>Totaal &euro; 5&nbsp;miljoen.</p><ul><li><p>eerste</p></li><li>tweede<ul><li>sub</li></ul></li></ul>" +
        "<h3>Tabel</h3><table><tr><th>Voertuig</th><th>Bedrag</th></tr><tr><td>N1</td><td>€ 60.000</td></tr></table>" +
        "<ul class=\"buttons\"><li>[rvo_custom:upnl:upnl7_eh3_aanvraag_beheren]</li></ul><p>Einde<br>regel</p>",
    );
    expect(lines).toEqual(["## Budget", "Totaal € 5 miljoen.", "- eerste", "- tweede", "- sub", "### Tabel", "Voertuig | Bedrag", "N1 | € 60.000", "Einde", "regel"]);
  });

  it("renders all blocks of a page in order and lists downloads and skipped blocks", () => {
    const node = findRvoPageNode(extractRvoFlight(rvoNodePage("/subsidies-financiering/dumava", DUMAVA_ID, DUMAVA_NODE, DUMAVA_TEXT_ROWS)), DUMAVA_ID)!;
    const r = renderRvoElements(node.contentElements as unknown[]);
    expect(r.lines.filter((l) => l.startsWith("#"))).toEqual([
      "## Advies over uw aanvraag",
      "## Voor wie?",
      "## Hoeveel subsidie krijgt u?",
      "### Subsidiebedragen losse maatregelen",
      "## Voorwaarden",
      "## Aanvragen",
      "## Meer weten?",
      "### Officiële wettekst van de regeling",
    ]);
    expect(r.lines).toContain("- onderwijs. Dat zijn gebouwen van een basisschool, middelbare school, universiteit, mbo- of hbo-instelling;");
    expect(r.lines).toContain("- De subsidiebedragen zijn minimaal € 2.500 en maximaal € 1,5 miljoen.");
    expect(r.lines).toContain("- Download: SBI-codes DUMAVA 2026");
    expect(r.downloads[0]).toEqual({
      title: "SBI-codes DUMAVA 2026",
      url: "https://www.rvo.nl/sites/default/files/2026-05/SBI-codes%20Subsidieregeling%20duurzaam%20maatschappelijk%20vastgoed%20%28DUMAVA%29.pdf",
      mimetype: "application/pdf",
      size_bytes: 292012,
    });
    expect(r.links).toHaveLength(3);
    expect([...r.skipped]).toEqual([["video", 1]]);
  });

  it("finds wetten.overheid.nl, Staatscourant and EUR-Lex links, unwrapping Outlook safelinks", () => {
    const safelink =
      "https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwetten.overheid.nl%2FBWBR0049842%2F2025-04-01&amp;data=05%7C02%7Cvoorbeeld%40example.org%7C0%7C&amp;reserved=0";
    const refs = rvoLegalReferences(
      [
        `<p><a href="${safelink}">Regeling</a> en <a href="https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=CELEX:02021R2115-20240525">GLB-verordening</a>.</p>`,
        `<a href="https://eur-lex.europa.eu/eli/reg/2014/651/oj/nld">AGVV</a><a href="https://wetten.overheid.nl/BWBR0049842/2025-04-01">Zelfde</a><a href="/node/4608">intern</a>`,
      ],
      [{ title: "Publicatie Staatscourant 2026", url: "https://zoek.officielebekendmakingen.nl/stcrt-2026-16962.html" }],
    );
    expect(refs).toEqual([
      { kind: "bwb", id: "BWBR0049842", url: "https://wetten.overheid.nl/BWBR0049842/2025-04-01", label: "Regeling" },
      { kind: "eur_lex", id: "02021R2115-20240525", url: "https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=CELEX:02021R2115-20240525", label: "GLB-verordening" },
      { kind: "eur_lex", id: "/eli/reg/2014/651/oj", url: "https://eur-lex.europa.eu/eli/reg/2014/651/oj/nld", label: "AGVV" },
      { kind: "officiele_bekendmaking", id: "stcrt-2026-16962", url: "https://zoek.officielebekendmakingen.nl/stcrt-2026-16962.html", label: "Publicatie Staatscourant 2026" },
    ]);
    expect(JSON.stringify(refs)).not.toContain("example.org");
  });
});

describe("RvoSubsidiesSource.get", () => {
  function getRouter(extraPages: Record<string, string> = {}) {
    return serve({ pages: { ...fixturePages(), ...extraPages }, details: { [DUMAVA_ID]: DUMAVA_DETAIL, [BMKB_ID]: BMKB_DETAIL } });
  }

  it("reads one regeling by uuid: the page's blocks as text, status, references and downloads", async () => {
    const net = getRouter();
    const out = (await new RvoSubsidiesSource(testConfig).get({ id: DUMAVA_ID })) as RvoSubsidieGetFound;
    expect(net.listCalls()).toHaveLength(0); // a uuid needs no catalogue
    expect(out.item.title).toBe("Subsidieregeling duurzaam maatschappelijk vastgoed (DUMAVA)");
    expect(out.text_source).toBe("pagina");
    expect(out.text.split("\n")[0]).toBe(out.item.intro);
    expect(out.text).toContain("## Voor wie?");
    expect(out.text).toContain("- U vraagt subsidie aan vóórdat u start met de verduurzaming of een contract tekent met een aannemer.");
    expect(out.sections).toEqual(["Advies over uw aanvraag", "Voor wie?", "Hoeveel subsidie krijgt u?", "Voorwaarden", "Aanvragen", "Meer weten?"]);
    expect(out.text_truncated).toBe(false);
    expect(out.status_info?.status).toBe("open");
    expect(out.legal_references.map((r) => r.id)).toEqual(["stcrt-2026-16962", "stcrt-2025-17361", "BWBR0046993"]);
    expect(out.downloads).toHaveLength(1);
    expect(out.endpoint).toBe(`${RVO_LIST}/${DUMAVA_ID}`);
    expect(out.params).toMatchObject({ id: DUMAVA_ID, page: "https://www.rvo.nl/subsidies-financiering/dumava" });
    expect(out.access_note).toContain("alle blokken van de openbare pagina");
    expect(summarizeRvoGet(out)).toMatch(/^RVO: Subsidieregeling duurzaam maatschappelijk vastgoed \(DUMAVA\); Open voor aanvragen; aanvraagperiode 1 juni 2026 09:00 tot 16 oktober 2026 17:00; budget € 405\.000\.000; tekst \d+ tekens \(pagina\)$/);
  });

  it("resolves a slug, a path or a URL through the catalogue", async () => {
    getRouter();
    const source = new RvoSubsidiesSource(testConfig);
    for (const id of ["dumava", "/subsidies-financiering/dumava", "https://www.rvo.nl/subsidies-financiering/DUMAVA/"]) {
      const out = await source.get({ id, readPage: false });
      expect("notFound" in out).toBe(false);
      expect((out as RvoSubsidieGetFound).item.id).toBe(DUMAVA_ID);
      expect((out as RvoSubsidieGetFound).params.input).toBe(id);
    }
  });

  it("does not guess between pages that share a slug, and suggests pages for an unknown one", async () => {
    getRouter();
    const source = new RvoSubsidiesSource(testConfig);
    const shared = await source.get({ id: "waterstof-en-groene-chemie" });
    expect(shared).toMatchObject({ notFound: true, message: "'waterstof-en-groene-chemie' past bij 2 pagina's; geef het volledige pad of de uuid." });
    expect(("notFound" in shared ? shared.suggestions : []).map((s) => s.id).sort()).toEqual([DEI_WATERSTOF_ID, STUDI_WATERSTOF_ID].sort());

    const unknown = await source.get({ id: "waterstof-xyz" });
    expect(unknown).toMatchObject({ notFound: true, message: "Geen pagina 'waterstof-xyz' in de RVO-catalogus (open data)." });
    expect(("notFound" in unknown ? unknown.suggestions : []).map((s) => s.id)).toContain(SWIM_ID);
    expect(JSON.stringify(unknown)).not.toContain("score");

    const gone = await source.get({ id: "11111111-2222-4333-8444-555555555555" });
    expect(gone).toMatchObject({ notFound: true, message: "RVO open data kent geen pagina met id 11111111-2222-4333-8444-555555555555 (HTTP 404)." });
  });

  it("links a page that rvo.nl has but the open data lacks, and reads nothing from it", async () => {
    const hub = (canonical: string) =>
      `<!DOCTYPE html><html lang="nl"><head><title>Investeringssubsidie duurzame energie en energiebesparing (ISDE) | RVO.nl</title>` +
      `<link rel="canonical" href="${canonical}"/></head><body><h1>ISDE</h1></body></html>`;
    const net = getRouter({ "/subsidies-financiering/isde": hub("https://www.rvo.nl/subsidies-financiering/isde"), "/subsidies-financiering/oud": hub("https://www.rvo.nl/subsidies-financiering/isde") });
    const source = new RvoSubsidiesSource(testConfig);
    const isde = await source.get({ id: "isde" });
    expect(isde).toMatchObject({
      notFound: true,
      site_page: "https://www.rvo.nl/subsidies-financiering/isde",
      message:
        "Geen pagina 'isde' in de RVO-catalogus (open data), maar rvo.nl heeft er wel een: https://www.rvo.nl/subsidies-financiering/isde " +
        "('Investeringssubsidie duurzame energie en energiebesparing (ISDE)'). Die staat niet in de open data, en in haar paginagegevens staan geen status, periode of budget.",
    });
    expect(net.pageCalls()).toContain("https://www.rvo.nl/subsidies-financiering/isde");
    // A page that redirects to another one says nothing about the slug asked; another host is never asked.
    expect(await source.get({ id: "oud" })).toMatchObject({ notFound: true, message: "Geen pagina 'oud' in de RVO-catalogus (open data)." });
    const before = net.calls.length;
    expect(await source.get({ id: "https://www.example.org/subsidies-financiering/isde" })).toMatchObject({ notFound: true });
    expect(net.calls.slice(before).filter((c) => !c.startsWith("https://www.rvo.nl/"))).toEqual([]);
  });

  it("without the page: the API's rich text, with what is missing said, a section and truncation", async () => {
    const net = getRouter();
    const source = new RvoSubsidiesSource(testConfig);
    const out = (await source.get({ id: BMKB_ID, readPage: false })) as RvoSubsidieGetFound;
    expect(net.pageCalls()).toHaveLength(0);
    expect(out.text_source).toBe("api");
    expect(out.status_info).toBeUndefined();
    expect(out.sections).toEqual(["Budget", "Voorwaarden", "Aanvragen", "Na uw aanvraag", "Wet- en regelgeving"]);
    expect(out.legal_references).toEqual([
      { kind: "bwb", id: "BWBR0035474", url: "https://wetten.overheid.nl/BWBR0035474/#Hoofdstuk3_Titeldeel3.11", label: "Regeling nationale EZ-subsidies: Borgstelling MKB-kredieten" },
    ]);
    expect(out.access_note).toContain("2 blokken van de pagina");
    expect(out.access_note).toContain("read_page=false");

    const section = (await source.get({ id: BMKB_ID, readPage: false, sectie: "voorwaarden" })) as RvoSubsidieGetFound;
    expect(section.text).toBe(
      "## Voorwaarden\nDe BMKB is bestemd voor ondernemingen met maximaal 250 werknemers (fte) met een jaaromzet tot € 50 miljoen of een balanstotaal tot € 43 miljoen. Ook een VOF, eenmanszaak of maatschap komen in aanmerking.\nLees meer over de voorwaarden",
    );

    const missing = (await source.get({ id: BMKB_ID, readPage: false, sectie: "Subsidiebedrag" })) as RvoSubsidieGetFound;
    expect(missing.text).toBe("");
    expect(missing.access_note).toContain("Geen sectie met 'Subsidiebedrag' in de kop; secties: Budget; Voorwaarden;");

    const short = (await source.get({ id: BMKB_ID, readPage: false, maxChars: 300 })) as RvoSubsidieGetFound;
    expect(short.text_truncated).toBe(true);
    expect(short.text.length).toBeLessThanOrEqual(302);
    expect(short.text.endsWith("\n…")).toBe(true);
    expect(short.text_chars).toBeGreaterThan(300);
    expect(short.access_note).toContain(`Tekst ingekort: ${short.text.length} van ${short.text_chars} tekens`);
  });

  it("falls back to the API text when the page redirects elsewhere or is gone", async () => {
    const redirected = rvoPageHtml({
      path: "/subsidies-financiering/dumava",
      canonical: "https://www.rvo.nl/onderwerpen/verduurzamen",
      flight: rvoFlight({ id: DUMAVA_ID, node: DUMAVA_NODE, textRows: DUMAVA_TEXT_ROWS }),
    });
    getRouter({ "/subsidies-financiering/dumava": redirected });
    const out = (await new RvoSubsidiesSource(testConfig).get({ id: DUMAVA_ID })) as RvoSubsidieGetFound;
    expect(out.text_source).toBe("api");
    expect(out.status_info?.status).toBe("onbekend");
    expect(out.status_info?.status_note).toContain("verwijst door naar https://www.rvo.nl/onderwerpen/verduurzamen");
    expect(out.text).toContain("## Voorwaarden");
    expect(out.access_note).toContain("8 blokken van de pagina");

    serve({ pages: {}, details: { [BMKB_ID]: BMKB_DETAIL } });
    const gone = (await new RvoSubsidiesSource(testConfig).get({ id: BMKB_ID })) as RvoSubsidieGetFound;
    expect(gone.status_info).toMatchObject({ status: "onbekend", status_note: "Status onbekend: de pagina bestaat niet (meer) (HTTP 404)." });
    expect(gone.text_source).toBe("api");
  });

  it("refuses an empty id", async () => {
    serve({});
    await expect(new RvoSubsidiesSource(testConfig).get({ id: "  " })).rejects.toBeInstanceOf(RvoSubsidiesInputError);
  });
});
