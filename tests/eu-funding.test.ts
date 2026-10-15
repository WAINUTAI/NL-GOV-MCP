import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EU_FUNDING_PROGRAMMES,
  EuFundingInputError,
  EuFundingSource,
  brusselsToday,
  buildEuFundingRequest,
  describeEuFundingItem,
  euFundingParams,
  normalizeEuDate,
  parseBudgetOverview,
  parseEuFundingId,
  planEuFundingWindow,
  resolveEuFundingProgramme,
  summarizeEuFundingGet,
  summarizeEuFundingSearch,
  toEuFundingItem,
  toEuSearchText,
  topicBudget,
} from "../src/sources/eu-funding.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { SourceRequestError } from "../src/utils/http.js";
import { jsonResponse, testConfig } from "./helpers/config.js";
import {
  CASCADE_HIT,
  CREA_SHARED_HIT,
  CURRENT_CLOSED_HIT,
  ESF_ZERO_HIT,
  FACET_PROGRAMME,
  MSCA_DN_HIT,
  OUTDATED_OPEN_HIT,
  PROSPECT_HIT,
  TOPIC_HIT,
  searchBody,
} from "./helpers/eu-funding-fixtures.js";

/** 2026-10-15 12:00 in Brussels. */
const NOW = Date.parse("2026-10-15T10:00:00Z");
const TODAY_MS = Date.parse("2026-10-15T00:00:00Z");
const SEARCH = "https://api.tech.ec.europa.eu/search-api/prod/rest/search";
const FACET = "https://api.tech.ec.europa.eu/search-api/prod/rest/facet";

interface Call {
  url: URL;
  method: string;
  query: { bool: { must: Array<Record<string, any>>; must_not?: Array<Record<string, any>> } };
  sort?: Array<{ field: string; order: string }>;
  languages?: string[];
  partTypes: Record<string, string>;
}

/** fetch mock that decodes the multipart parts (query, sort, languages) of every request. */
function formFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const form = init?.body as FormData;
    const partTypes: Record<string, string> = {};
    const parts: Record<string, unknown> = {};
    // lib "DOM" without "DOM.Iterable": collect the entries with forEach.
    const entries: Array<[string, FormDataEntryValue]> = [];
    form.forEach((value, name) => entries.push([name, value]));
    for (const [name, value] of entries) {
      partTypes[name] = typeof value === "string" ? "string" : value.type;
      parts[name] = typeof value === "string" ? value : JSON.parse(await value.text());
    }
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      query: parts.query as Call["query"],
      sort: parts.sort as Call["sort"],
      languages: parts.languages as string[],
      partTypes,
    };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

/** A deep copy of a hit with metadata fields replaced. */
function withMeta(hit: unknown, patch: Record<string, unknown>, top: Record<string, unknown> = {}): Record<string, any> {
  const copy = JSON.parse(JSON.stringify(hit)) as Record<string, any>;
  Object.assign(copy.metadata, patch);
  return Object.assign(copy, top);
}

const ranges = (c: Call) => c.query.bool.must.filter((m) => m.range).map((m) => m.range.deadlineDate);
const isCount = (c: Call) => c.url.searchParams.get("pageSize") === "1";
const isPassedCutOff = (c: Call) => ranges(c).some((r) => r.lt !== undefined);
const isAllAhead = (c: Call) => !!c.query.bool.must_not;

const src = () => new EuFundingSource(testConfig);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearHttpCache();
});

describe("programmes", () => {
  it("reads abbreviation and period from the portal's labels", () => {
    const h2020 = EU_FUNDING_PROGRAMMES.find((p) => p.id === "31045243");
    expect(h2020).toMatchObject({ name: "Horizon 2020 Framework Programme", abbreviation: "H2020", period: "2014-2020" });
    expect(EU_FUNDING_PROGRAMMES.find((p) => p.id === "43353764")).toMatchObject({ name: "Erasmus", abbreviation: "ERASMUS" });
  });

  it("resolves an abbreviation to every period that uses it", () => {
    expect(resolveEuFundingProgramme("HORIZON").ids).toEqual(["43108390"]);
    expect(resolveEuFundingProgramme("life")).toMatchObject({ ids: ["43252405", "31107710"], match: "abbreviation" });
    expect(resolveEuFundingProgramme("Erasmus+").ids).toEqual(["43353764"]);
  });

  it("resolves part of a name and a numeric id, also an unknown one", () => {
    expect(resolveEuFundingProgramme("Digital Europe")).toMatchObject({ ids: ["43152860"], match: "name" });
    expect(resolveEuFundingProgramme("43108390").programmes[0].abbreviation).toBe("HORIZON");
    expect(resolveEuFundingProgramme("12345")).toEqual({ input: "12345", ids: ["12345"], programmes: [], match: "id" });
  });

  it("rejects a programme it does not know instead of searching without the filter", () => {
    expect(() => resolveEuFundingProgramme("Nationaal Groeifonds")).toThrow(EuFundingInputError);
  });
});

describe("normalizeEuDate and brusselsToday", () => {
  it("keeps only the day for midnight UTC and the UTC time otherwise", () => {
    expect(normalizeEuDate("2026-10-29T00:00:00.000+0000")).toBe("2026-10-29");
    expect(normalizeEuDate("2026-06-28T22:59:00.000+0000")).toBe("2026-06-28T22:59:00Z");
    expect(normalizeEuDate("2026-11-05")).toBe("2026-11-05");
    expect(normalizeEuDate("not a date")).toBeUndefined();
    expect(normalizeEuDate(undefined)).toBeUndefined();
  });

  it("takes today's date in Brussels, not in UTC", () => {
    expect(brusselsToday(Date.parse("2026-10-15T22:30:00Z"))).toBe("2026-10-16");
    expect(brusselsToday(NOW)).toBe("2026-10-15");
  });
});

describe("toEuSearchText", () => {
  it("removes the syntax the live API answers with 0 results", () => {
    expect(toEuSearchText("robotics:AI")).toBe("robotics AI");
    expect(toEuSearchText("robotics/AI")).toBe("robotics AI");
  });

  it("joins a EuropeAid reference with dashes, as the portal does", () => {
    expect(toEuSearchText("EuropeAid/187686/ID/ACT/MK")).toBe("EuropeAid-187686-ID-ACT-MK");
  });

  it("keeps phrases, OR and exclusion, and drops an unpaired quote", () => {
    expect(toEuSearchText('"cultural heritage" OR museums -tourism')).toBe('"cultural heritage" OR museums -tourism');
    expect(toEuSearchText('"zorginnovatie')).toBe("zorginnovatie");
  });
});

describe("planEuFundingWindow", () => {
  it("serves a window from one page when one page size holds it", () => {
    expect(planEuFundingWindow(0, 20)).toEqual({ pageSize: 20, pages: [1], skip: 0 });
    expect(planEuFundingWindow(80, 40)).toEqual({ pageSize: 40, pages: [3], skip: 0 });
  });

  it("uses two pages of 100 when no single page can hold the window", () => {
    expect(planEuFundingWindow(150, 100)).toEqual({ pageSize: 100, pages: [2, 3], skip: 50 });
  });
});

describe("buildEuFundingRequest", () => {
  it("defaults to open and forthcoming grants, cascade and external calls with a deadline from today", () => {
    const req = buildEuFundingRequest({}, NOW);
    const typeAndStatus = [{ terms: { type: ["1", "8", "2"] } }, { terms: { status: ["31094502", "31094501"] } }];
    expect(req.query).toEqual({ bool: { must: [...typeAndStatus, { range: { deadlineDate: { gte: TODAY_MS } } }] } });
    expect(req.unfilteredQuery).toEqual({ bool: { must: typeAndStatus } });
    expect(req.expiryFilter).toBe(true);
    expect(req.sortName).toBe("deadline");
    expect(req.sort).toEqual([
      { field: "deadlineDate", order: "ASC" },
      { field: "identifier", order: "ASC" },
      { field: "callccm2Id", order: "ASC" },
    ]);
  });

  it("puts the deadline window and today's bound in one range clause, in epoch milliseconds", () => {
    const req = buildEuFundingRequest({ deadlineFrom: "2026-01-01", deadlineTo: "2026-12-31" }, NOW);
    const r = (req.query as any).bool.must.filter((m: any) => m.range);
    expect(r).toEqual([{ range: { deadlineDate: { gte: TODAY_MS, lte: Date.parse("2026-12-31T23:59:59.999Z") } } }]);
    // Without the expiry bound the caller's own window stays.
    expect((req.unfilteredQuery as any).bool.must.filter((m: any) => m.range)).toEqual([
      { range: { deadlineDate: { gte: Date.parse("2026-01-01T00:00:00Z"), lte: Date.parse("2026-12-31T23:59:59.999Z") } } },
    ]);
  });

  it("has no expiry bound when closed calls are asked for or include_expired is set", () => {
    expect(buildEuFundingRequest({ status: ["closed"] }, NOW).expiryFilter).toBe(false);
    expect(buildEuFundingRequest({ status: ["open", "closed"] }, NOW).expiryFilter).toBe(false);
    const req = buildEuFundingRequest({ includeExpired: true }, NOW);
    expect(req.expiryFilter).toBe(false);
    expect((req.query as any).bool.must.some((m: any) => m.range)).toBe(false);
  });

  it("adds keywords as the portal's text clause (all words) and sorts by relevance", () => {
    const req = buildEuFundingRequest({ query: "cultural heritage", programme: "HORIZON", type: ["grant"] }, NOW);
    const must = (req.query as any).bool.must;
    expect(must).toContainEqual({ terms: { type: ["1"] } });
    expect(must).toContainEqual({ terms: { frameworkProgramme: ["43108390"] } });
    const text = must.find((m: any) => m.text).text;
    expect(text).toMatchObject({ query: "cultural heritage", defaultOperator: "AND" });
    expect(text.fields).toEqual(expect.arrayContaining(["title", "description", "identifier", "callIdentifier", "typesOfAction"]));
    expect(req.sort[0]).toEqual({ field: "relevance", order: "DESC" });
    expect(req.sort.slice(1).map((s) => s.field)).toEqual(["identifier", "callccm2Id"]);
  });

  it("rejects bad dates and an inverted window", () => {
    expect(() => buildEuFundingRequest({ deadlineFrom: "15-10-2026" }, NOW)).toThrow(EuFundingInputError);
    expect(() => buildEuFundingRequest({ deadlineFrom: "2026-02-30" }, NOW)).toThrow(EuFundingInputError);
    expect(() => buildEuFundingRequest({ deadlineFrom: "2026-12-01", deadlineTo: "2026-11-01" }, NOW)).toThrow(/ligt na/);
  });

  it("describes the planned requests as string params for provenance and dryRun", () => {
    const params = euFundingParams(buildEuFundingRequest({ limit: 20 }, NOW));
    expect(params).toMatchObject({ text: "***", languages: '["en"]', pageSize: "20", pageNumber: "1", count_without_deadline_filter: "pageSize=1&pageNumber=1" });
    expect(JSON.parse(params.query).bool.must).toHaveLength(3);
    expect(params.order).toMatch(/^next_deadline/);
    const closed = euFundingParams(buildEuFundingRequest({ status: ["closed"], sort: "title" }, NOW));
    expect(closed.order).toBeUndefined();
    expect(closed.count_without_deadline_filter).toBeUndefined();
    expect(JSON.parse(closed.sort)[0]).toEqual({ field: "title", order: "ASC" });
  });

  it("cuts the window at the 10,000 results the API can page to", () => {
    const req = buildEuFundingRequest({ status: ["closed"], offset: 9_990, limit: 20 }, NOW);
    expect(req).toMatchObject({ limit: 10, reachableCut: true });
    expect(buildEuFundingRequest({ status: ["closed"], offset: 10_000 }, NOW).plan.pages).toEqual([]);
  });
});

describe("budget overview", () => {
  const lines = (hit: Record<string, any>) => parseBudgetOverview(JSON.parse(hit.metadata.budgetOverview[0]));

  it("counts a budget line once although it is listed once per type of action", () => {
    const [line] = lines(MSCA_DN_HIT);
    expect(line.types_of_action).toHaveLength(3);
    expect(line.budget_eur).toBe(628_033_846);
    expect(topicBudget(lines(MSCA_DN_HIT), "HORIZON-MSCA-2026-DN-01-01")).toMatchObject({ budget_eur: 628_033_846, shared_with: [] });
  });

  it("names the other topics of a shared budget line", () => {
    const budget = topicBudget(lines(CREA_SHARED_HIT), "CREA-MEDIA-2027-TVONLINE-1");
    expect(budget.shared_with).toEqual(["CREA-MEDIA-2027-TVONLINE-2", "CREA-MEDIA-2027-TVONLINE-3"]);
    expect(budget.budget_eur).toBe(23_300_000);
  });

  it("gives a topic only its own line of the call's overview", () => {
    const all = lines(TOPIC_HIT);
    expect(all.map((l) => l.budget_eur)).toEqual([30_000_000, 52_500_000]);
    const own = topicBudget(all, "HORIZON-CL4-2027-02-MAT-PROD-32-two-stage");
    expect(own.budget_eur).toBe(52_500_000);
    expect(own.lines[0]).toMatchObject({ expected_grants: 6, min_contribution_eur: 7_000_000, max_contribution_eur: 9_000_000, deadlines: ["2027-02-02", "2027-09-02"], deadline_model: "two-stage" });
  });

  it("leaves out expected grants and contributions the overview gives as 0", () => {
    const [line] = lines(ESF_ZERO_HIT);
    expect(line.budget_eur).toBe(900_000);
    expect(line).not.toHaveProperty("expected_grants");
    expect(line).not.toHaveProperty("min_contribution_eur");
    expect(line).not.toHaveProperty("max_contribution_eur");
  });
});

describe("toEuFundingItem", () => {
  it("maps a topic with its own budget, deadlines and portal page", () => {
    const x = toEuFundingItem(TOPIC_HIT, NOW)!;
    expect(x).toMatchObject({
      type: "grant",
      id: "HORIZON-CL4-2027-02-MAT-PROD-32-two-stage",
      call_identifier: "HORIZON-CL4-2027-02-two-stage",
      programme_id: "43108390",
      programme: "Horizon Europe (HORIZON)",
      programme_abbreviation: "HORIZON",
      programme_period: "2021 - 2027",
      status: "open",
      opening_date: "2026-10-13",
      deadlines: ["2027-02-02", "2027-09-02"],
      next_deadline: "2027-02-02",
      deadline_passed: false,
      deadline_model: "two-stage",
      budget_eur: 52_500_000,
      budget_scope: "topic",
      types_of_action: ["HORIZON Innovation Actions"],
      url: "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/HORIZON-CL4-2027-02-MAT-PROD-32-two-stage",
    });
    expect(x.description_short?.length).toBeLessThanOrEqual(282);
    expect(x.outdated_index_record).toBeUndefined();
  });

  it("links a cascade call by its own number, not the index's URL of the parent topic", () => {
    expect(CASCADE_HIT.url).toContain("competitive-calls-cs/46786367");
    const x = toEuFundingItem(CASCADE_HIT, NOW)!;
    expect(x).toMatchObject({
      type: "cascade_funding",
      id: "13882",
      cascade_call_id: "13882",
      identifier: "DIGITAL-ECCC-2024-DEPLOY-NCC-06-MS-COORDINATION",
      title: "Enhancing the Cybersecurity Capabilities of the Domestic SME Sector (SSNS-NCC-HU-FSTP-2026)",
      parent_topic_title: "Deploying The Network of National Coordination Centres with Member States",
      project_acronym: "NCC-HU",
      programme_abbreviation: "DIGITAL",
      status: "open",
      deadlines: ["2026-06-28T22:59:00Z"],
      deadline_passed: true,
      budget_eur: 2_000_000,
      budget_scope: "cascade_call",
      url: "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/competitive-calls-cs/13882",
    });
    expect(x.next_deadline).toBeUndefined();
  });

  it("maps an external action call with its reference, contract type and PROSPECT link", () => {
    const x = toEuFundingItem(PROSPECT_HIT, NOW)!;
    expect(x).toMatchObject({
      type: "external_action",
      id: "EuropeAid/187686/ID/ACT/MK",
      contract_type: "Twinning",
      programme_abbreviation: "RELEX-PROSPECT",
      programme_period: "2014 - 2020 / 2021 - 2027",
      budget_eur: 1_300_000,
      budget_scope: "external_action_call",
      next_deadline: "2026-11-05T22:59:00Z",
      url: "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/prospect-details/187686PROSPECTSEN",
    });
  });

  it("flags an outdated index copy whose status was never updated", () => {
    const x = toEuFundingItem(OUTDATED_OPEN_HIT, NOW)!;
    expect(x).toMatchObject({ status: "open", outdated_index_record: true, deadline_passed: true });
    expect(x.budget_eur).toBeUndefined();
  });

  it("marks a shared budget line and names the other topics", () => {
    expect(toEuFundingItem(CREA_SHARED_HIT, NOW)).toMatchObject({
      budget_eur: 23_300_000,
      budget_scope: "shared_budget_line",
      budget_shared_with: ["CREA-MEDIA-2027-TVONLINE-2", "CREA-MEDIA-2027-TVONLINE-3"],
    });
  });

  it("does not count a day-only deadline as passed during that day", () => {
    const hit = withMeta(TOPIC_HIT, { deadlineDate: ["2026-10-15T00:00:00.000+0000"] });
    expect(toEuFundingItem(hit, Date.parse("2026-10-15T21:00:00Z"))).toMatchObject({ next_deadline: "2026-10-15", deadline_passed: false });
    expect(toEuFundingItem(hit, Date.parse("2026-10-15T22:30:00Z"))).toMatchObject({ deadline_passed: true });
  });

  it("skips tenders and other types", () => {
    expect(toEuFundingItem(withMeta(TOPIC_HIT, { type: ["0"] }), NOW)).toBeUndefined();
  });
});

/** Two-stage cascade call with one cut-off passed and one ahead. */
const CASCADE_PASSED_CUTOFF = withMeta(CASCADE_HIT, {
  callccm2Id: ["13999"],
  callTitle: ["Second open call for pilots"],
  deadlineDate: ["2026-09-01T17:00:00.000+0000", "2026-11-01T17:00:00.000+0000"],
}, { reference: "13999COMPETITIVE_CALLen" });

describe("EuFundingSource.search", () => {
  it("sends multipart JSON parts with the portal key and orders by next deadline", async () => {
    const calls = formFetch((c) => {
      if (isCount(c)) return jsonResponse(searchBody([TOPIC_HIT], 1202, 1, 1));
      if (isPassedCutOff(c)) return jsonResponse(searchBody([CASCADE_PASSED_CUTOFF], 1));
      if (isAllAhead(c)) return jsonResponse(searchBody([TOPIC_HIT], 533, 1, 20));
      return new Response("unexpected", { status: 418 });
    });
    const out = await src().search({}, NOW);

    for (const c of calls) {
      expect(c.method).toBe("POST");
      expect(`${c.url.origin}${c.url.pathname}`).toBe(SEARCH);
      expect(c.url.searchParams.get("apiKey")).toBe("SEDIA");
      expect(c.url.searchParams.get("text")).toBe("***");
      expect(c.partTypes).toMatchObject({ query: "application/json", languages: "application/json", sort: "application/json" });
      expect(c.languages).toEqual(["en"]);
    }
    expect(calls).toHaveLength(3);
    // The call with a passed cut-off sorts by its next deadline (1 Nov), before the topic (2 Feb).
    expect(out.items.map((x) => x.id)).toEqual(["13999", "HORIZON-CL4-2027-02-MAT-PROD-32-two-stage"]);
    expect(out.items[0].next_deadline).toBe("2026-11-01T17:00:00Z");
    expect(out.total).toBe(534);
    expect(out.expired_hidden).toBe(668);
    expect(out.params.order).toBe("next_deadline (merged)");
    expect(out.access_note).toMatch(/Weggelaten: 668 van de 1\.202/);
    expect(out.access_note).toMatch(/eerstvolgende deadline eerst/);
    expect(summarizeEuFundingSearch(out)).toBe(
      "534 EU-oproepen (open/forthcoming) in het Funding & Tenders Portal; getoond 1-2; 668 als open aangeduide oproepen zonder resterende deadline weggelaten",
    );
  });

  it("falls back to the upstream deadline order when the calls with a passed cut-off do not fit in one page", async () => {
    const calls = formFetch((c) => {
      if (isCount(c)) return jsonResponse(searchBody([], 2000, 1, 1));
      if (isPassedCutOff(c)) return jsonResponse(searchBody(Array(100).fill(CASCADE_PASSED_CUTOFF), 150));
      return jsonResponse(searchBody([TOPIC_HIT], 900, 1, 20));
    });
    const out = await src().search({}, NOW);
    const plain = calls.find((c) => !isCount(c) && !isPassedCutOff(c) && !isAllAhead(c));
    expect(plain).toBeDefined();
    expect(out.total).toBe(900);
    expect(out.params.order).toBeUndefined();
    expect(out.access_note).toMatch(/telt de vroegste, ook als die al voorbij is/);
  });

  it("searches closed calls without a deadline bound or count request", async () => {
    const calls = formFetch(() => jsonResponse(searchBody([CURRENT_CLOSED_HIT], 427, 1, 3)));
    const out = await src().search({ query: "hydrogen", status: ["closed"], sort: "newest", limit: 3 }, NOW);
    expect(calls).toHaveLength(1);
    expect(ranges(calls[0])).toEqual([]);
    expect(calls[0].query.bool.must).toContainEqual({ terms: { status: ["31094503"] } });
    expect(calls[0].sort?.[0]).toEqual({ field: "startDate", order: "DESC" });
    expect(out.expired_hidden).toBeUndefined();
    expect(out.items[0]).toMatchObject({ status: "closed", deadline_passed: true });
    expect(out.access_note).toMatch(/Engelse termen/);
  });

  it("names a shown outdated copy whose deadline is still ahead: the current record may differ", async () => {
    const copy = withMeta(OUTDATED_OPEN_HIT, { deadlineDate: ["2027-01-26T00:00:00.000+0000"] });
    formFetch(() => jsonResponse(searchBody([copy], 1, 1, 20)));
    const out = await src().search({ sort: "identifier" }, NOW);
    expect(out.items[0]).toMatchObject({ outdated_index_record: true, next_deadline: "2027-01-26" });
    expect(out.access_note).toContain(
      "HORIZON-CL5-2023-D3-03-08: alleen een verouderde kopie in de index (outdated_index_record); status en deadlines kunnen afwijken van het actuele record, dat eu_funding_get leest.",
    );
  });

  it("warns when shown items are labelled open although all deadlines passed (include_expired)", async () => {
    formFetch(() => jsonResponse(searchBody([OUTDATED_OPEN_HIT], 1202, 1, 20)));
    const out = await src().search({ includeExpired: true, sort: "identifier" }, NOW);
    expect(out.items[0].outdated_index_record).toBe(true);
    expect(out.access_note).toMatch(/deadline_passed/);
  });

  it("pages a window over two upstream pages of 100", async () => {
    const page = (n: number) => Array.from({ length: 100 }, (_, i) => withMeta(TOPIC_HIT, { identifier: [`TOPIC-${n}-${i}`] }));
    const calls = formFetch((c) => {
      if (isCount(c)) return jsonResponse(searchBody([], 600, 1, 1));
      const n = Number(c.url.searchParams.get("pageNumber"));
      return jsonResponse(searchBody(page(n), 534, n, 100));
    });
    const out = await src().search({ offset: 150, limit: 100, sort: "newest" }, NOW);
    const pages = calls.filter((c) => !isCount(c)).map((c) => `${c.url.searchParams.get("pageNumber")}/${c.url.searchParams.get("pageSize")}`);
    expect(pages).toEqual(["2/100", "3/100"]);
    expect(out.items).toHaveLength(100);
    expect(out.items[0].id).toBe("TOPIC-2-50");
    expect(out.items[99].id).toBe("TOPIC-3-49");
    expect(out.params.pageNumber).toBe("2,3");
  });

  it("does not request past the first 10,000 results", async () => {
    const calls = formFetch(() => jsonResponse(searchBody([], 0)));
    const out = await src().search({ status: ["closed"], offset: 10_000 }, NOW);
    expect(calls).toHaveLength(0);
    expect(out.total).toBeNull();
    expect(out.access_note).toMatch(/eerste 10\.000/);
  });

  it("names a programme missing from the table through the facet endpoint", async () => {
    const facet = JSON.parse(JSON.stringify(FACET_PROGRAMME));
    facet.facets[0].values = [{ apiVersion: "2.157", rawValue: "49999999", value: "Example Programme  (EXAMPLE )", count: 1 }];
    const calls = formFetch((c) => {
      if (c.url.pathname.endsWith("/facet")) return jsonResponse(facet);
      return jsonResponse(searchBody([withMeta(TOPIC_HIT, { frameworkProgramme: ["49999999"] })], 1, 1, 20));
    });
    const out = await src().search({ status: ["closed"] }, NOW);
    const facetCall = calls.find((c) => c.url.pathname.endsWith("/facet"))!;
    expect(`${facetCall.url.origin}${facetCall.url.pathname}`).toBe(FACET);
    expect(facetCall.query.bool.must).toEqual([{ terms: { frameworkProgramme: ["49999999"] } }]);
    expect(out.items[0]).toMatchObject({ programme_id: "49999999", programme: "Example Programme (EXAMPLE)", programme_abbreviation: "EXAMPLE" });
  });

  it("keeps the id when the facet endpoint fails", async () => {
    formFetch((c) =>
      c.url.pathname.endsWith("/facet")
        ? new Response("bad", { status: 400 })
        : jsonResponse(searchBody([withMeta(TOPIC_HIT, { frameworkProgramme: ["49999998"] })], 1, 1, 20)),
    );
    const out = await src().search({ status: ["closed"] }, NOW);
    expect(out.items[0].programme_id).toBe("49999998");
    expect(out.items[0].programme).toBeUndefined();
  });

  it("serves a repeated search from the cache", async () => {
    const calls = formFetch(() => jsonResponse(searchBody([TOPIC_HIT], 1, 1, 20)));
    await src().search({ status: ["closed"] }, NOW);
    await src().search({ status: ["closed"] }, NOW);
    expect(calls).toHaveLength(1);
  });

  it("retries a 5xx once and then reports an http_error", async () => {
    const calls = formFetch(() => new Response("down", { status: 503 }));
    const err = await src().search({ status: ["closed"] }, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(SourceRequestError);
    expect(err).toMatchObject({ code: "http_error", status: 503 });
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 4xx", async () => {
    const calls = formFetch(() => new Response('{"type":"businessError"}', { status: 400 }));
    await expect(src().search({ status: ["closed"] }, NOW)).rejects.toMatchObject({ code: "http_error", status: 400 });
    expect(calls).toHaveLength(1);
  });

  it("reports an answer without results/totalResults as malformed", async () => {
    formFetch(() => jsonResponse({ apiVersion: "2.157", message: "?" }));
    await expect(src().search({ status: ["closed"] }, NOW)).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("rejects an unknown programme before any request", async () => {
    const calls = formFetch(() => jsonResponse(searchBody([], 0)));
    await expect(src().search({ programme: "Regionale Deal" }, NOW)).rejects.toBeInstanceOf(EuFundingInputError);
    expect(calls).toHaveLength(0);
  });
});

describe("parseEuFundingId", () => {
  it("reads topic identifiers, numbers, EuropeAid references and portal URLs", () => {
    expect(parseEuFundingId("HORIZON-CL5-2027-02-D3-01")).toEqual({ kind: "topic", value: "HORIZON-CL5-2027-02-D3-01" });
    expect(parseEuFundingId("13882")).toEqual({ kind: "number", value: "13882" });
    expect(parseEuFundingId("EuropeAid/187686/ID/ACT/MK")).toEqual({ kind: "number", value: "187686" });
    expect(parseEuFundingId("187686PROSPECTSEN")).toEqual({ kind: "number", value: "187686" });
    const portal = "https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities";
    expect(parseEuFundingId(`${portal}/topic-details/ESF-2027-PEP-ENGAGEMENT`)).toEqual({ kind: "topic", value: "ESF-2027-PEP-ENGAGEMENT" });
    expect(parseEuFundingId(`${portal}/competitive-calls-cs/13882`)).toEqual({ kind: "number", value: "13882" });
    expect(parseEuFundingId(`${portal}/prospect-details/187686PROSPECTSEN`)).toEqual({ kind: "number", value: "187686" });
    expect(parseEuFundingId(`${portal}/topic-details/187686PROSPECTSEN`)).toEqual({ kind: "number", value: "187686" });
    expect(parseEuFundingId("https://webgate.ec.europa.eu/prospect/external/publishedcalls.htm?callId=186989")).toEqual({ kind: "number", value: "186989" });
    expect(parseEuFundingId("https://ec.europa.eu/info/funding-tenders/opportunities/data/topicDetails/esf-2027-pep-engagement.json")).toEqual({ kind: "topic", value: "esf-2027-pep-engagement" });
    expect(parseEuFundingId("https://example.org/elsewhere")).toBeUndefined();
    expect(parseEuFundingId("  ")).toBeUndefined();
  });
});

describe("EuFundingSource.get", () => {
  it("returns a topic with its budget lines, the call's budget, actions, links and texts", async () => {
    const calls = formFetch(() => jsonResponse(searchBody([TOPIC_HIT], 1)));
    const out = await src().get("HORIZON-CL4-2027-02-MAT-PROD-32-two-stage", {}, NOW);
    expect(calls[0].query.bool.must).toEqual([
      { terms: { type: ["1", "2", "8"] } },
      { terms: { identifier: ["HORIZON-CL4-2027-02-MAT-PROD-32-two-stage"] } },
    ]);
    const x = out.item!;
    expect(x.budget_eur).toBe(52_500_000);
    expect(x.budget_lines).toHaveLength(1);
    expect(x.call_budget).toMatchObject({ lines_total: 2, total_eur: 82_500_000, years: ["2027"] });
    expect(x.actions).toEqual([
      { status: "open", types_of_action: ["HORIZON-IA HORIZON Innovation Actions"], opening_date: "2026-10-13", deadlines: ["2027-02-02", "2027-09-02"], deadline_model: "two-stage" },
    ]);
    expect(x.submission_links?.[0]).toMatchObject({ type_of_action: "HORIZON Innovation Actions", grant_agreement_type: "HORIZON Lump Sum Grant", opens: "2026-10-13", closes: "2027-02-02" });
    expect(x.latest_infos?.[0].date).toBe("2026-10-14");
    expect(x.description).toMatch(/^Expected Outcome:/);
    expect(x.conditions).toMatch(/Admissibility/);
    expect(x.truncated).toEqual([]);
    expect(x).not.toHaveProperty("description_short");
    expect(summarizeEuFundingGet(out)).toMatch(/\(HORIZON-CL4-2027-02-MAT-PROD-32-two-stage\): EU-topic · HORIZON · open · deadline 2027-02-02 \(2 deadlines\) · € 52\.500\.000$/);
  });

  it("cuts texts at max_chars and says which", async () => {
    formFetch(() => jsonResponse(searchBody([TOPIC_HIT], 1)));
    const out = await src().get("HORIZON-CL4-2027-02-MAT-PROD-32-two-stage", { maxChars: 200 }, NOW);
    expect(out.item!.description!.length).toBeLessThanOrEqual(202);
    expect(out.item!.truncated).toEqual(["description", "conditions"]);
    expect(out.access_note).toMatch(/Ingekort tot 200 tekens: description, conditions/);
  });

  it("prefers the current record over an outdated copy that still says open", async () => {
    formFetch(() => jsonResponse(searchBody([OUTDATED_OPEN_HIT, CURRENT_CLOSED_HIT], 2)));
    const out = await src().get("HORIZON-CL5-2023-D3-03-08", {}, NOW);
    expect(out.item).toMatchObject({ status: "closed", deadlines: ["2023-10-10"] });
    expect(out.item!.outdated_index_record).toBeUndefined();
    expect(out.access_note).toMatch(/verouderde kopie .* genegeerd/);
  });

  it("says so when only an outdated copy exists", async () => {
    formFetch(() => jsonResponse(searchBody([OUTDATED_OPEN_HIT], 1)));
    const out = await src().get("HORIZON-CL5-2023-D3-03-08", {}, NOW);
    expect(out.item).toMatchObject({ status: "open", outdated_index_record: true, deadline_passed: true });
    expect(out.access_note).toMatch(/alleen een verouderde kopie/);
    expect(out.access_note).toMatch(/noemt de status 'open', maar alle deadlines zijn voorbij/);
  });

  it("finds a cascade call by its number and reads the project's texts", async () => {
    const calls = formFetch(() => jsonResponse(searchBody([CASCADE_HIT], 1)));
    const out = await src().get("13882", {}, NOW);
    expect(calls[0].query.bool.must).toEqual([
      { terms: { type: ["2", "8"] } },
      { bool: { should: [{ terms: { callccm2Id: ["13882"] } }, { terms: { callIdentifier: ["13882"] } }] } },
    ]);
    expect(out.item).toMatchObject({ type: "cascade_funding", id: "13882", project_name: "National Coordination Centre - Hungary" });
    expect(out.item!.description).toMatch(/^WHO CAN SUBMIT/);
    expect(out.item!.application_info).toMatch(/HOW TO SUBMIT/);
    expect(out.item!.further_information).toBeTruthy();
    expect(out.item!.timing_info).toMatch(/WHEN IS THE CALL/);
    expect(out.access_note).toMatch(/door het uitvoerende EU-project zelf/);
  });

  it("finds an external action call by its EuropeAid reference", async () => {
    formFetch(() => jsonResponse(searchBody([PROSPECT_HIT], 1)));
    const out = await src().get("EuropeAid/187686/ID/ACT/MK", {}, NOW);
    expect(out.item).toMatchObject({ type: "external_action", beneficiary_administration: "Ministry of Transport and Public Enterprise for State Roads" });
    expect(out.item!.documents?.[0]).toEqual({
      name: "Twinning Fiche",
      type: "pdf",
      language: "EN",
      date: "2026-09-03",
      url: "https://webgate.ec.europa.eu/prospect/internal/noauth/externalDocumentDownload.htm?id=2214470&lang=EN",
    });
  });

  it("matches a topic identifier in another case through the analysed field", async () => {
    const calls = formFetch((c) =>
      jsonResponse(c.query.bool.must.some((m) => m.text) ? searchBody([TOPIC_HIT, withMeta(TOPIC_HIT, { identifier: ["HORIZON-CL4-2027-02-OTHER"] })], 2) : searchBody([], 0)),
    );
    const out = await src().get("horizon-cl4-2027-02-mat-prod-32-two-stage", {}, NOW);
    expect(calls).toHaveLength(2);
    expect(calls[1].query.bool.must[1]).toEqual({ text: { query: '"horizon-cl4-2027-02-mat-prod-32-two-stage"', fields: ["identifier"], defaultOperator: "AND", lenient: true } });
    expect(out.item?.id).toBe("HORIZON-CL4-2027-02-MAT-PROD-32-two-stage");
  });

  it("lists the topics of a call identifier as candidates", async () => {
    const calls = formFetch((c) =>
      jsonResponse(
        c.query.bool.must.some((m) => m.terms?.callIdentifier)
          ? searchBody([TOPIC_HIT, withMeta(TOPIC_HIT, { identifier: ["HORIZON-CL4-2027-02-DIGITAL-EMERGING-52-two-stage"] })], 2)
          : searchBody([], 0),
      ),
    );
    const out = await src().get("HORIZON-CL4-2027-02-two-stage", {}, NOW);
    expect(calls).toHaveLength(3);
    expect(out.item).toBeUndefined();
    expect(out.candidates_kind).toBe("call_topics");
    expect(out.candidates?.map((c) => c.id)).toEqual(["HORIZON-CL4-2027-02-MAT-PROD-32-two-stage", "HORIZON-CL4-2027-02-DIGITAL-EMERGING-52-two-stage"]);
    expect(summarizeEuFundingGet(out)).toBe("'HORIZON-CL4-2027-02-two-stage' is een call met 2 topics; kies er één op identifier.");
  });

  it("counts the cascade calls that run under a topic", async () => {
    const parent = withMeta(CURRENT_CLOSED_HIT, { identifier: ["DIGITAL-ECCC-2024-DEPLOY-NCC-06-MS-COORDINATION"] });
    formFetch(() => jsonResponse(searchBody([CASCADE_HIT, parent, CASCADE_PASSED_CUTOFF], 3)));
    const out = await src().get("DIGITAL-ECCC-2024-DEPLOY-NCC-06-MS-COORDINATION", {}, NOW);
    expect(out.item?.type).toBe("grant");
    expect(out.cascade_calls?.total).toBe(2);
    // Calls with a deadline left come first.
    expect(out.cascade_calls?.shown.map((c) => c.id)).toEqual(["13999", "13882"]);
  });

  it("returns cascade calls as candidates when the topic itself has no record", async () => {
    formFetch(() => jsonResponse(searchBody([CASCADE_HIT, CASCADE_PASSED_CUTOFF], 2)));
    const out = await src().get("DIGITAL-ECCC-2024-DEPLOY-NCC-06-MS-COORDINATION", {}, NOW);
    expect(out.item).toBeUndefined();
    expect(out.candidates_kind).toBe("cascade_calls");
    expect(out.candidates).toHaveLength(2);
  });

  it("does not choose when a number is both a cascade call and an external action call", async () => {
    formFetch(() => jsonResponse(searchBody([CASCADE_HIT, PROSPECT_HIT], 2)));
    const out = await src().get("13882", {}, NOW);
    expect(out.item).toBeUndefined();
    expect(out.candidates_kind).toBe("number_collision");
    expect(out.candidates?.map((c) => c.type).sort()).toEqual(["cascade_funding", "external_action"]);
  });

  it("reports an id it cannot find", async () => {
    formFetch(() => jsonResponse(searchBody([], 0)));
    const out = await src().get("HORIZON-NOPE-2099-01", {}, NOW);
    expect(out.item).toBeUndefined();
    expect(out.candidates).toBeUndefined();
    expect(out.access_note).toMatch(/Niets gevonden voor 'HORIZON-NOPE-2099-01'/);
    expect(summarizeEuFundingGet(out)).toBe("Geen EU-oproep gevonden voor 'HORIZON-NOPE-2099-01'.");
  });

  it("rejects input that is no id", async () => {
    await expect(src().get("https://example.org/x", {}, NOW)).rejects.toBeInstanceOf(EuFundingInputError);
  });
});

describe("describeEuFundingItem", () => {
  it("summarises type, programme, project, status, deadline and budget", () => {
    expect(describeEuFundingItem(toEuFundingItem(TOPIC_HIT, NOW)!)).toBe("EU-topic · HORIZON · open · deadline 2027-02-02 (2 deadlines) · € 52.500.000");
    expect(describeEuFundingItem(toEuFundingItem(CASCADE_HIT, NOW)!)).toBe(
      "cascade-oproep · DIGITAL · project NCC-HU · open · deadline voorbij (2026-06-28T22:59:00Z) · € 2.000.000",
    );
    expect(describeEuFundingItem(toEuFundingItem(CREA_SHARED_HIT, NOW)!)).toMatch(/€ 23\.300\.000 \(gedeeld\)$/);
  });

  it("says when the status and deadline come from an outdated copy in the index", () => {
    const copy = toEuFundingItem(withMeta(OUTDATED_OPEN_HIT, { deadlineDate: ["2027-01-26T00:00:00.000+0000"] }), NOW)!;
    expect(describeEuFundingItem(copy)).toBe("EU-topic · HORIZON · open volgens een verouderde kopie in de index · deadline 2027-01-26");
  });
});
