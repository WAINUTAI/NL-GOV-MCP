import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { setCrawlDelaysEnabled } from "../src/utils/http.js";
import {
  GehoordSource,
  GEHOORD_PARAMS,
  GEHOORD_SEGMENT_MAX_PAGES,
  GEHOORD_SPREKER_MAX_PAGES,
  contextWindow,
  gehoordDebateUrl,
  gehoordFragmentUrl,
  gehoordParties,
  gehoordPersoonUrl,
  gehoordQueryTerms,
  gehoordSearchNotes,
  gehoordSnippet,
  isGehoordPersoonId,
  matchesSpreker,
  parseContribution,
  parseDebate,
} from "../src/sources/gehoord.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

/* ------------------------------------------------------------------ */
/*  Gehoord.de: the source (parsing, links, filters, match, the        */
/*  segment window) and the three tools (missing key, 401/404, notes). */
/* ------------------------------------------------------------------ */

const TK_LIVE = {
  id: 312905,
  chamber: "tk",
  title: "Begroting Binnenlandse Zaken 2027",
  status: "live",
  hall: "Plenaire zaal",
  startsAt: "2026-11-03T15:30:19.000Z",
  url: "https://debatdirect.tweedekamer.nl/2026-11-03/binnenlandse-zaken/plenaire-zaal/begroting",
};
const TK_ENDED = { ...TK_LIVE, id: 312911, title: "Klimaat- en Energieverkenning in relatie tot de landbouw", status: "ended", hall: "Aletta Jacobszaal" };
const EK_LIVE = { id: 312818, chamber: "ek", title: "Initiatiefwetsvoorstel embryo's (36.416)", status: "live", hall: "Plenaire zaal", startsAt: "2026-11-03T09:30:00.000Z", url: "https://www.eerstekamer.nl/plenaire_vergadering/20261103" };

function contribution(id: number, debate: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    id,
    debateId: debate.id,
    text: `Voorzitter, de samenhang tussen landbouw en stikstof is groot; fragment ${id}.`,
    speakerLabel: "799bb30d-da26-429a-b10a-f801fcf07659",
    speakerName: "Wim Meulenkamp",
    speakerParty: "VVD",
    speakerRole: "Tweede Kamerlid",
    startMs: 8814642,
    endMs: 8844311,
    startTime: "2026-11-03T17:56:48.442Z",
    endTime: "2026-11-03T17:57:18.111Z",
    updatedAt: "2026-11-03T17:57:48.000Z",
    debate,
    ...over,
  };
}

const PVDD = { speakerLabel: "d66383ca-deef-4470-8807-924313ae15e6", speakerName: "Ines Kostić", speakerParty: "PvdD" };
const MINISTER = { speakerLabel: "aaaa", speakerName: "David van Weel", speakerParty: null, speakerRole: "Minister van Justitie en Veiligheid" };

/** A fetch mock that answers by path; records every request with its headers. */
function mockGehoord(route: (url: URL) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return route(url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function page(data: unknown[], total: number, offset: number, limit = 200, extra: Record<string, unknown> = {}) {
  return jsonResponse({ ...extra, data, pagination: { limit, offset, total, hasMore: offset + data.length < total } });
}

beforeEach(() => {
  clearHttpCache();
  setCrawlDelaysEnabled(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(() => setCrawlDelaysEnabled(true));

describe("Gehoord.de parsing and links", () => {
  it("keeps the raw speakerLabel as persoonId, the UTC times and the debate's id and chamber", () => {
    const c = parseContribution(contribution(241823, TK_LIVE));
    expect(c.persoonId).toBe("799bb30d-da26-429a-b10a-f801fcf07659");
    expect(c.startTime).toBe("2026-11-03T17:56:48.442Z");
    expect(c.endTime).toBe("2026-11-03T17:57:18.111Z");
    expect(c.debate).toMatchObject({ id: 312905, chamber: "tk", status: "live", url: TK_LIVE.url });
    expect(c.fragmentUrl).toBe("https://gehoord.de/beraadslagingen/312905?segment=241823");
  });

  it("builds the fragment and debate links the API does not return", () => {
    expect(gehoordFragmentUrl(312818, 240905)).toBe("https://gehoord.de/beraadslagingen/312818?segment=240905");
    expect(gehoordDebateUrl("312818")).toBe("https://gehoord.de/beraadslagingen/312818");
  });

  it("parses a debate with defaults for what is missing, and a contribution without its own debate", () => {
    const d = parseDebate({ ...EK_LIVE, debateType: "Plenaire vergadering", subtitlesCondensed: true, contributionCount: 197, tkDebateId: null });
    expect(d).toMatchObject({ id: 312818, chamber: "ek", debateType: "Plenaire vergadering", subtitlesCondensed: true, contributionCount: 197, gehoordUrl: "https://gehoord.de/beraadslagingen/312818" });
    expect(d.tkDebateId).toBeUndefined();
    const c = parseContribution({ id: 1, debateId: 312818, text: "x", speakerLabel: "vkyyicefojzk", speakerName: "Boris Dittrich" }, d);
    expect(c.debate.chamber).toBe("ek");
    expect(c.persoonId).toBe("vkyyicefojzk");
  });

  it("keeps the full debate object every hit now carries", () => {
    const full = {
      ...TK_ENDED,
      id: 303748,
      hall: "Thorbeckezaal",
      locationId: "thorbeckezaal",
      debateType: "Commissiedebat",
      startsAt: "2026-10-28T09:00:00.000Z",
      startedAt: "2026-10-28T09:01:37.000Z",
      endedAt: "2026-10-28T11:19:15.000Z",
      tkDebateId: "117edd5e-a12a-4404-95e8-7cd718e17f42",
      tkActivityId: "0647302f-4fcf-4dc9-b281-18e9ab406daf",
      tkActivityNumber: "2026A05087",
      subtitlesCondensed: false,
      contributionCount: 112,
    };
    const c = parseContribution(contribution(9, full));
    expect(c.debate).toMatchObject({
      locationId: "thorbeckezaal",
      debateType: "Commissiedebat",
      startedAt: "2026-10-28T09:01:37.000Z",
      tkDebateId: "117edd5e-a12a-4404-95e8-7cd718e17f42",
      tkActivityId: "0647302f-4fcf-4dc9-b281-18e9ab406daf",
      tkActivityNumber: "2026A05087",
      subtitlesCondensed: false,
      contributionCount: 112,
    });
    // An older answer without the flag: unknown, not false.
    expect(parseContribution(contribution(10, TK_ENDED)).debate.subtitlesCondensed).toBeUndefined();
  });

  it("knows a persoon-id Gehoord filters on, and the Eerste Kamer's own person page", () => {
    expect(isGehoordPersoonId("799bb30d-da26-429a-b10a-f801fcf07659")).toBe(true);
    expect(isGehoordPersoonId("vkyyicefojzk")).toBe(true);
    expect(isGehoordPersoonId("Klaver")).toBe(false);
    expect(isGehoordPersoonId("van Weel")).toBe(false);
    expect(gehoordPersoonUrl("vkyyicefojzk")).toBe("https://www.eerstekamer.nl/id/vkyyicefojzk");
    expect(gehoordPersoonUrl("799bb30d-da26-429a-b10a-f801fcf07659")).toBeUndefined();
    expect(gehoordPersoonUrl("Melanie Kalis")).toBeUndefined();
    expect(gehoordPersoonUrl(undefined)).toBeUndefined();
  });
});

describe("Gehoord.de filters and match", () => {
  it("maps a fractie to every label Gehoord files it under, per kamer, and leaves another label as it is", () => {
    // GroenLinks-PvdA is 'GL-PvdA' up to late September 2026 and 'PRO' since: one fractie (live, 4 Nov 2026).
    expect(gehoordParties("GroenLinks-PvdA", "tk")).toEqual(["GL-PvdA", "PRO"]);
    expect(gehoordParties("groenlinks pvda")).toEqual(["GL-PvdA", "PRO"]);
    expect(gehoordParties("PRO", "tk")).toEqual(["GL-PvdA", "PRO"]);
    expect(gehoordParties("GL", "ek")).toEqual(["PRO"]);
    // The ChristenUnie is 'CU' in the Tweede Kamer, 'ChristenUnie' in the Eerste Kamer.
    expect(gehoordParties("ChristenUnie", "tk")).toEqual(["CU"]);
    expect(gehoordParties("ChristenUnie", "ek")).toEqual(["ChristenUnie"]);
    expect(gehoordParties("CU", "ek")).toEqual(["ChristenUnie"]);
    expect(gehoordParties("ChristenUnie")).toEqual(["CU", "ChristenUnie"]);
    expect(gehoordParties("Partij voor de Dieren")).toEqual(["PvdD"]);
    expect(gehoordParties(" vvd ")).toEqual(["vvd"]);
  });

  it("asks each label of a fractie with several and merges them newest first, the totals added up", async () => {
    const pro = { ...PVDD, speakerParty: "PRO", speakerName: "Julian Bushoff" };
    const gl = { ...PVDD, speakerParty: "GL-PvdA", speakerName: "Jesse Klaver" };
    const at = (iso: string) => ({ startTime: iso });
    const calls = mockGehoord((url) => {
      const party = url.searchParams.get("party");
      if (party === "PRO") return page([contribution(11, TK_LIVE, { ...pro, ...at("2026-11-04T09:05:00Z") }), contribution(12, TK_LIVE, { ...pro, ...at("2026-10-01T09:00:00Z") }), contribution(13, TK_LIVE, { ...pro, ...at("2026-09-10T09:00:00Z") })], 47, 0, 3);
      return page([contribution(21, TK_ENDED, { ...gl, ...at("2026-09-21T16:02:00Z") }), contribution(22, TK_ENDED, { ...gl, ...at("2026-09-01T10:00:00Z") }), contribution(23, TK_ENDED, { ...gl, ...at("2026-08-01T10:00:00Z") })], 63, 0, 3);
    });
    const src = new GehoordSource(testConfig, "k");
    const out = await src.search({ query: "stikstof", kamer: "tk", fractie: "GroenLinks-PvdA", top: 3, offset: 0 });
    expect(calls.map((c) => c.url.searchParams.get("party")).sort()).toEqual(["GL-PvdA", "PRO"]);
    expect(calls.map((c) => [c.url.searchParams.get("limit"), c.url.searchParams.get("offset")])).toEqual([["3", "0"], ["3", "0"]]);
    expect(out.items.map((c) => c.id)).toEqual([11, 12, 21]);
    expect(out).toMatchObject({ parties: ["GL-PvdA", "PRO"], upstreamTotal: 110, hasMore: true, nextOffset: 3 });
    expect(out.labelsCapped).toBeUndefined();
    const notes = gehoordSearchNotes(out, { query: "stikstof", kamer: "tk", fractie: "GroenLinks-PvdA", offset: 0 }).join(" ");
    expect(notes).toContain("'GL-PvdA' en 'PRO' (GL-PvdA heet sinds eind september 2026 'PRO'): elk label apart gevraagd en samengevoegd");

    // The Eerste Kamer: one label, one request.
    await src.search({ query: "embryo", kamer: "ek", fractie: "ChristenUnie", top: 3, offset: 0 });
    expect(calls[2].url.searchParams.get("party")).toBe("ChristenUnie");
    expect(calls).toHaveLength(3);
  });

  it("filters a fractie with several labels here when a spreker name is filtered here too", async () => {
    const hits = [
      contribution(1, TK_ENDED, { ...PVDD, speakerParty: "PRO", speakerName: "Habtamu de Hoop" }),
      contribution(2, TK_ENDED, { ...PVDD, speakerParty: "GL-PvdA", speakerName: "Habtamu de Hoop" }),
      contribution(3, TK_ENDED, { ...PVDD, speakerParty: "VVD", speakerName: "Hans de Hoop" }),
    ];
    const calls = mockGehoord(() => page(hits, 3, 0));
    const out = await new GehoordSource(testConfig, "k").search({ query: "woningbouw", kamer: "tk", fractie: "GL-PvdA", spreker: "de Hoop", top: 5, offset: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get("party")).toBeNull();
    expect(out.items.map((c) => c.id)).toEqual([1, 2]);
  });

  it("stops merging labels past the first 200 hits of a label and says to continue per label", async () => {
    const many = (party: string, base: number, startHour: number) =>
      Array.from({ length: 200 }, (_, i) => contribution(base + i, TK_ENDED, { ...PVDD, speakerParty: party, startTime: new Date(Date.UTC(2026, 9, 30, startHour) - i * 60_000 * (party === "PRO" ? 1 : 3)).toISOString() }));
    mockGehoord((url) => (url.searchParams.get("party") === "PRO" ? page(many("PRO", 1000, 12), 500, 0) : page(many("GL-PvdA", 5000, 11), 500, 0)));
    const out = await new GehoordSource(testConfig, "k").search({ query: "stikstof", fractie: "PRO", kamer: "tk", top: 200, offset: 100 });
    // PRO's 200th hit is the newer last one: only hits up to there are in place.
    const proLast = Date.UTC(2026, 9, 30, 12) - 199 * 60_000;
    expect(out.items.every((c) => Date.parse(c.startTime!) >= proLast)).toBe(true);
    // 200 PRO + 47 GL-PvdA hits in place; from 100 on, 147 of them.
    expect(out.items).toHaveLength(147);
    expect(out).toMatchObject({ labelsCapped: true, hasMore: true, upstreamTotal: 1000 });
    expect(out.nextOffset).toBeUndefined();
    const notes = gehoordSearchNotes(out, { query: "stikstof", kamer: "tk", fractie: "PRO", offset: 100 }).join(" ");
    expect(notes).toContain("zoek dan per label (fractie 'GL-PvdA' of 'PRO')");
  });

  it("reads a query as Gehoord does: quoted phrases whole, -word excluded, woordgroep as one phrase", () => {
    expect(gehoordQueryTerms("stikstof provincie")).toEqual({ include: ["stikstof", "provincie"], exclude: [] });
    expect(gehoordQueryTerms('"medische isotopen" -pallas')).toEqual({ include: ["medische isotopen"], exclude: ["pallas"] });
    expect(gehoordQueryTerms('stikstof -"Pallas reactor"', "een")).toEqual({ include: ["stikstof"], exclude: ["Pallas reactor"] });
    expect(gehoordQueryTerms("stikstof provincie", "woordgroep")).toEqual({ include: ["stikstof provincie"], exclude: [] });
  });

  it("centres the snippet on the first search term found, not on an excluded one", () => {
    const text = `${"Wij spreken over de begroting en vele andere zaken vandaag. ".repeat(8)}Daarna kwam de provincie ter sprake. ${"Nog meer tekst over andere dingen. ".repeat(4)}Ook stikstof werd genoemd. ${"Tot slot nog meer woorden. ".repeat(8)}`;
    expect(gehoordSnippet(text, ["stikstof", "provincie"])).toContain("provincie ter sprake");
    expect(gehoordSnippet(text, ["stikstof"])).toContain("Ook stikstof werd genoemd");
    expect(gehoordSnippet(text, ["onbekend"]).startsWith("Wij spreken")).toBe(true);
  });

  it("matches a speaker by the words of the name or the function", () => {
    expect(matchesSpreker({ speakerName: "David van Weel", speakerRole: "Minister van Justitie en Veiligheid" }, "van Weel")).toBe(true);
    expect(matchesSpreker({ speakerName: "David van Weel", speakerRole: "Minister van Justitie en Veiligheid" }, "minister")).toBe(true);
    expect(matchesSpreker({ speakerName: "Ines Kostić" }, "kostic")).toBe(true);
    expect(matchesSpreker({ speakerName: "Jesse Klaver" }, "Klaas")).toBe(false);
  });

  it("searches in one request with the API's own offset, match 'alle' by default", async () => {
    const calls = mockGehoord(() => page([contribution(1, TK_LIVE)], 431, 10, 5, { query: { q: "stikstof", match: "all", terms: { include: ["stikstof"], exclude: [] } } }));
    const out = await new GehoordSource(testConfig, "test-key").search({ query: "stikstof", top: 5, offset: 10 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe("/api/v1/contributions");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ q: "stikstof", match: "all", limit: "5", offset: "10" });
    expect(calls[0].headers.Authorization).toBe("Bearer test-key");
    expect(out).toMatchObject({ filtered: false, upstreamTotal: 431, hasMore: true, nextOffset: 11, match: "alle", terms: { include: ["stikstof"], exclude: [] } });
  });

  it("maps match: alle → all, een → any, woordgroep → no match parameter (the API's phrase)", async () => {
    const calls = mockGehoord(() => page([], 0, 0, 25));
    const src = new GehoordSource(testConfig, "k");
    await src.search({ query: "stikstof provincie", match: "alle", top: 25, offset: 0 });
    await src.search({ query: "stikstof provincie", match: "een", top: 25, offset: 0 });
    const phrase = await src.search({ query: "stikstof provincie", match: "woordgroep", top: 25, offset: 0 });
    expect(calls.map((c) => c.url.searchParams.get("match"))).toEqual(["all", "any", null]);
    // No echo of query.terms: the same rules here.
    expect(phrase.terms).toEqual({ include: ["stikstof provincie"], exclude: [] });
  });

  it("lets Gehoord filter kamer, fractie, a persoon-id and the debate: one request, only parameters the endpoint knows", async () => {
    const calls = mockGehoord(() => page([contribution(1, TK_ENDED, PVDD)], 63, 0, 25, { query: { terms: { include: ["stikstof"], exclude: [] } } }));
    const src = new GehoordSource(testConfig, "k");
    const out = await src.search({ query: "stikstof", kamer: "tk", fractie: "VVD", spreker: "d66383ca-deef-4470-8807-924313ae15e6", debat_id: "117edd5e-a12a-4404-95e8-7cd718e17f42", date_from: "2026-10-01", date_to: "2026-10-31", top: 25, offset: 0 });
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      q: "stikstof",
      match: "all",
      from: "2026-10-01",
      to: "2026-10-31",
      chamber: "tk",
      party: "VVD",
      speaker: "d66383ca-deef-4470-8807-924313ae15e6",
      debateId: "117edd5e-a12a-4404-95e8-7cd718e17f42",
      limit: "25",
      offset: "0",
    });
    expect(out).toMatchObject({ filtered: false, upstreamTotal: 63, parties: ["VVD"] });
    // An Eerste Kamer id is a persoon-id too.
    await src.search({ query: "embryo", kamer: "ek", spreker: "vkyyicefojzk", top: 25, offset: 0 });
    expect(calls[1].url.searchParams.get("speaker")).toBe("vkyyicefojzk");
  });

  it("sends every endpoint only the parameters it knows (Gehoord answers anything else with HTTP 400)", async () => {
    const calls = mockGehoord((url) => {
      if (/^\/api\/v1\/debates\/\d+$/.test(url.pathname)) return jsonResponse({ data: { ...TK_ENDED, speakers: [] } });
      if (url.pathname.endsWith("/contributions") && url.pathname !== "/api/v1/contributions") return page([], 0, 0, 25, { debate: TK_ENDED });
      return page([], 0, 0, 25);
    });
    const src = new GehoordSource(testConfig, "k");
    await src.search({ query: "stikstof", match: "een", kamer: "ek", fractie: "VVD", spreker: "vkyyicefojzk", debat_id: 312905, date_from: "2026-10-01", top: 5, offset: 0 });
    await src.search({ query: "stikstof", spreker: "Klaver", top: 5, offset: 0 });
    await src.listDebates({ kamer: "tk", status: "cancelled", date_from: "2026-10-01", date_to: "2026-10-31", top: 5, offset: 0 });
    await src.getDebate(312905);
    await src.getContributions(312905, { limit: 5, offset: 0 });
    const endpointOf = (path: string): keyof typeof GEHOORD_PARAMS =>
      path === "/api/v1/contributions" ? "contributions" : path === "/api/v1/debates" ? "debates" : path.endsWith("/contributions") ? "debateContributions" : "debate";
    expect(calls.map((c) => endpointOf(c.url.pathname))).toEqual(["contributions", "contributions", "debates", "debate", "debateContributions"]);
    for (const c of calls) {
      const known: readonly string[] = GEHOORD_PARAMS[endpointOf(c.url.pathname)];
      expect([...c.url.searchParams.keys()].filter((k) => !known.includes(k)), c.url.href).toEqual([]);
    }
    // And the client refuses one before any request.
    await expect((src as unknown as { get: (p: string, q: Record<string, string>) => Promise<unknown> }).get("/debates", { q: "x" })).rejects.toThrow(/kent de parameter/);
    expect(calls).toHaveLength(5);
  });

  it("filters a spreker given by name here: pages of 200 with Gehoord's own filters, and says where to go on", async () => {
    const hits = Array.from({ length: 200 }, (_, i) => contribution(1000 + i, TK_ENDED, i % 50 === 0 ? MINISTER : {}));
    const calls = mockGehoord((url) => {
      const offset = Number(url.searchParams.get("offset"));
      return page(offset === 0 ? hits : [], 200, offset);
    });
    const src = new GehoordSource(testConfig, "k");
    const out = await src.search({ query: "stikstof", fractie: "VVD", kamer: "tk", spreker: "van Weel", top: 25, offset: 0 });
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ q: "stikstof", match: "all", chamber: "tk", party: "VVD", limit: "200", offset: "0" });
    expect(out.items.map((c) => c.id)).toEqual([1000, 1050, 1100, 1150]);
    expect(out).toMatchObject({ filtered: true, scanned: 200, upstreamTotal: 200, hasMore: false });
    expect(out.params.spreker).toBe("van Weel (hier gefilterd op naam of functie)");
    expect(out.nextOffset).toBeUndefined();
  });

  it("goes on after the last fragment shown when more match than top, and scans at most three pages", async () => {
    const all = Array.from({ length: 1000 }, (_, i) => contribution(i, TK_ENDED, i % 3 === 0 ? MINISTER : {}));
    const calls = mockGehoord((url) => {
      const offset = Number(url.searchParams.get("offset"));
      return page(all.slice(offset, offset + 200), all.length, offset);
    });
    const src = new GehoordSource(testConfig, "k");
    const few = await src.search({ query: "stikstof", spreker: "minister", top: 2, offset: 0 });
    expect(few.items.map((c) => c.id)).toEqual([0, 3]);
    expect(few.nextOffset).toBe(4);
    expect(calls).toHaveLength(1);

    const none = await src.search({ query: "stikstof", spreker: "Klaver", top: 5, offset: 0 });
    expect(none.items).toEqual([]);
    expect(none.scanned).toBe(GEHOORD_SPREKER_MAX_PAGES * 200);
    expect(none.nextOffset).toBe(600);
    // The first page of the same query comes from the response cache.
    expect(calls).toHaveLength(3);
  });
});

describe("Gehoord.de segment window", () => {
  it("cuts the window at the edges of the debate", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    expect(contextWindow(items, 0, 2)).toMatchObject({ position: 0, windowStart: 0, items: [{ id: 0 }, { id: 1 }, { id: 2 }] });
    expect(contextWindow(items, "9", 3)?.items.map((x) => x.id)).toEqual([6, 7, 8, 9]);
    expect(contextWindow(items, 42, 3)).toBeUndefined();
  });

  it("pages through the debate to find the fragment and reads one page more for the window", async () => {
    const all = Array.from({ length: 450 }, (_, i) => contribution(5000 + i, TK_ENDED));
    const calls = mockGehoord((url) => {
      const offset = Number(url.searchParams.get("offset"));
      expect(url.pathname).toBe("/api/v1/debates/312911/contributions");
      return page(all.slice(offset, offset + 200).map(({ debate: _d, ...c }) => c), all.length, offset, 200, { debate: { ...TK_ENDED, subtitlesCondensed: true } });
    });
    const out = await new GehoordSource(testConfig, "k").getContributionsAround(312911, 5000 + 399, 2);
    expect(out.found).toBe(true);
    expect(out.position).toBe(399);
    expect(out.items.map((c) => c.id)).toEqual([5397, 5398, 5399, 5400, 5401]);
    expect(out.items[0].debate.chamber).toBe("tk");
    expect(out.debate?.subtitlesCondensed).toBe(true);
    expect(calls.map((c) => c.url.searchParams.get("offset"))).toEqual(["0", "200", "400"]);
  });

  it("stops at the page cap and says so when the fragment is not there", async () => {
    const calls = mockGehoord((url) => {
      const offset = Number(url.searchParams.get("offset"));
      return page(Array.from({ length: 200 }, (_, i) => contribution(offset + i, TK_ENDED)), 100_000, offset);
    });
    const out = await new GehoordSource(testConfig, "k").getContributionsAround(312911, 99_999, 3);
    expect(out).toMatchObject({ found: false, capped: true, scanned: GEHOORD_SEGMENT_MAX_PAGES * 200, items: [] });
    expect(calls).toHaveLength(GEHOORD_SEGMENT_MAX_PAGES);
  });
});

/* ------------------------------------------------------------------ */
/*  The tools                                                           */
/* ------------------------------------------------------------------ */

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
const tools = new Map<string, { schema: Record<string, { parse: (v: unknown) => unknown }>; handler: Handler; description: string }>();
registerTools({
  registerTool(name: string, cfg: { description?: string; inputSchema?: Record<string, { parse: (v: unknown) => unknown }> }, handler: Handler) {
    tools.set(name, { schema: cfg.inputSchema ?? {}, handler, description: cfg.description ?? "" });
  },
} as unknown as McpServer);

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  const parsed: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.schema)) parsed[key] = schema.parse(args[key]);
  const out = await tool.handler(parsed);
  return JSON.parse(out.content[0].text);
}

describe("Gehoord.de tools", () => {
  it("are registered, carry the caveats and point both ways to the official verslagen", () => {
    for (const name of ["gehoord_debatten_search", "gehoord_debatten_list", "gehoord_debat_get"]) {
      const d = tools.get(name)?.description ?? "";
      expect(d, name).toContain("Requires GEHOORD_KEY");
      expect(d, name).toMatch(/NOT for quoting/);
      expect(d, name).toContain("tweede_kamer_debatten");
      expect(d, name).toMatch(/not official/);
    }
    expect(tools.get("gehoord_debatten_search")!.description).toMatch(/match 'alle' \(default\) needs every word in any order/);
    expect(tools.get("gehoord_debatten_search")!.description).not.toMatch(/query is ONE literal phrase|search again for each other word/);
    expect(tools.get("tweede_kamer_debatten")!.description).toContain("gehoord_debatten_search");
  });

  it("answer not_configured without GEHOORD_KEY, without a request", async () => {
    vi.stubEnv("GEHOORD_KEY", "");
    const calls = mockGehoord(() => jsonResponse({}));
    for (const [name, args] of [["gehoord_debatten_search", { query: "stikstof" }], ["gehoord_debatten_list", {}], ["gehoord_debat_get", { debate_id: "1" }]] as const) {
      const out = await call(name, args);
      expect(out.error, name).toBe("not_configured");
      expect(out.message).toBe("GEHOORD_KEY ontbreekt");
      expect(out.suggestion).toContain("tweede_kamer_debatten");
    }
    vi.stubEnv("GEHOORD_KEY", "met spatie");
    expect((await call("gehoord_debatten_list", {})).error).toBe("not_configured");
    expect(calls).toHaveLength(0);
  });

  it("map a refused key (401) to not_configured and an unknown debate (404) to not found", async () => {
    vi.stubEnv("GEHOORD_KEY", "bad-key");
    mockGehoord(() => jsonResponse({ error: { code: "unauthorized", message: "Ongeldige of ontbrekende API-sleutel." } }, 401));
    const refused = await call("gehoord_debatten_search", { query: "stikstof" });
    expect(refused.error).toBe("not_configured");
    expect(refused.message).toContain("HTTP 401");
    expect(JSON.stringify(refused)).not.toContain("bad-key");

    vi.stubEnv("GEHOORD_KEY", "good-key");
    clearHttpCache();
    mockGehoord(() => jsonResponse({ error: { code: "not_found", message: "Geen debat gevonden voor id '999'." } }, 404));
    const missing = await call("gehoord_debat_get", { debate_id: 999 });
    expect(missing.error).toBe("http_error");
    expect(missing.message).toMatch(/Debat 999 niet gevonden.*HTTP 404/);
    expect(missing.suggestion).toContain("gehoord_debatten_list");
  });

  it("refuse a malformed date or id before any request", async () => {
    vi.stubEnv("GEHOORD_KEY", "k");
    const calls = mockGehoord(() => jsonResponse({}));
    expect((await call("gehoord_debatten_search", { query: "stikstof", date_from: "1-10-2026" })).message).toContain("JJJJ-MM-DD");
    expect((await call("gehoord_debat_get", { debate_id: "../debates" })).message).toContain("geen geldig Gehoord-id");
    expect(calls).toHaveLength(0);
  });

  it("search: fragment link first, official page in data, persoon_id and UTC times, and the live and Eerste Kamer notes", async () => {
    vi.stubEnv("GEHOORD_KEY", "k");
    mockGehoord(() => page([contribution(241823, TK_LIVE), contribution(240905, EK_LIVE, { speakerLabel: "vkyyicefojzk", speakerName: "Boris Dittrich", speakerParty: "D66", speakerRole: "Eerste Kamerlid" })], 2, 0, 25, { query: { q: "stikstof" } }));
    const out = await call("gehoord_debatten_search", { query: "stikstof", koppeling: "uit" });
    expect(out.summary).toMatch(/^2 fragmenten in 2 debatten \(van 2 treffers\); meest aan het woord: Wim Meulenkamp \(VVD\) 1, Boris Dittrich \(D66\) 1$/);
    const [tk, ek] = out.records;
    expect(tk.canonical_url).toBe("https://gehoord.de/beraadslagingen/312905?segment=241823");
    expect(tk.title).toBe("Wim Meulenkamp (VVD): Begroting Binnenlandse Zaken 2027");
    expect(tk.data).toMatchObject({
      fragment_id: 241823,
      debat_id: 312905,
      kamer: "tk",
      debat_status: "live",
      persoon_id: "799bb30d-da26-429a-b10a-f801fcf07659",
      start_time: "2026-11-03T17:56:48.442Z",
      end_time: "2026-11-03T17:57:18.111Z",
      debat_url: TK_LIVE.url,
      fragment_url: tk.canonical_url,
    });
    expect(tk.snippet).toContain("stikstof");
    expect(ek.data.kamer).toBe("ek");
    expect(tk.data.persoon_url).toBeUndefined();
    expect(ek.data.persoon_url).toBe("https://www.eerstekamer.nl/id/vkyyicefojzk");
    expect(out.access_note).toContain("niet om te citeren");
    expect(out.access_note).toContain("officiele_bekendmakingen_search");
    expect(out.access_note).toContain("Debat nog live");
    expect(out.access_note).toContain("geen hoofdletters en geen leestekens");
    expect(out.access_note).toContain("vaste persoons-id van de Eerste Kamer");
    expect(out.access_note).toContain("Gezocht op het woord 'stikstof' (match 'alle'");
    // The hits do not say whether their subtitles are condensed: the general warning.
    expect(out.access_note).toContain("gehoord_debat_get toont per debat of dat zo is");
    expect(out.pagination).toEqual({ offset: 0, limit: 25, total: 2, has_more: false });
  });

  it("search with a spreker name: says how many hits were scanned, that Gehoord filters only a persoon-id, and where to continue", async () => {
    vi.stubEnv("GEHOORD_KEY", "k");
    const hits = Array.from({ length: 900 }, (_, i) => contribution(i, TK_ENDED, i === 5 ? PVDD : {}));
    mockGehoord((url) => {
      const offset = Number(url.searchParams.get("offset"));
      return page(hits.slice(offset, offset + 200), 900, offset);
    });
    const out = await call("gehoord_debatten_search", { query: "stikstof", fractie: "PvdD", spreker: "Kostić", top: 10 });
    expect(out.records).toHaveLength(1);
    expect(out.summary).toMatch(/^1 fragment in 1 debat \(600 van 900 treffers doorzocht\)/);
    expect(out.access_note).toContain("Gehoord.de filtert zelf op fractie 'PvdD'.");
    expect(out.access_note).toMatch(/Gehoord\.de filtert alleen op een persoon-id, niet op een naam: spreker 'Kostić' is hier toegepast op naam en functie, op treffer 1 t\/m 600 van 900/);
    expect(out.access_note).toContain("Zoek verder met offset=600, of geef als spreker de persoon_id");
    expect(out.pagination).toMatchObject({ total: null, has_more: true });
    expect(out.provenance.total_results).toBeUndefined();
  });

  it("search: shows how the query was read, the vergaderdag, the total of Gehoord's own filters and the per-hit caveats", async () => {
    vi.stubEnv("GEHOORD_KEY", "k");
    const condensed = { ...TK_ENDED, subtitlesCondensed: true, debateType: "Plenair debat" };
    const calls = mockGehoord(() => page([contribution(1, condensed), contribution(2, { ...TK_LIVE, subtitlesCondensed: false })], 83, 0, 25, {
      query: { q: "stikstof provincie -pallas", match: "all", terms: { include: ["stikstof", "provincie"], exclude: ["pallas"] } },
    }));
    const out = await call("gehoord_debatten_search", { query: "stikstof provincie -pallas", kamer: "tk", date_from: "2026-10-01", date_to: "2026-11-03", koppeling: "uit" });
    expect(calls[0].url.searchParams.get("match")).toBe("all");
    expect(out.access_note).toContain("Gezocht op alle woorden 'stikstof' EN 'provincie' (in elke volgorde), zonder 'pallas' (match 'alle'");
    expect(out.access_note).toContain("vergaderdag 2026-10-01 t/m 2026-11-03 (zoals de Kamer dateert");
    expect(out.access_note).toContain("samengevat en dus niet letterlijk (subtitlesCondensed; per record data.ondertiteling_samengevat)");
    expect(out.records.map((r: { data: { ondertiteling_samengevat: boolean } }) => r.data.ondertiteling_samengevat)).toEqual([true, false]);
    expect(out.records[0].data.debat_soort).toBe("Plenair debat");
    expect(out.pagination).toEqual({ offset: 0, limit: 25, total: 83, has_more: true });
    expect(out.provenance.query_params).toMatchObject({ q: "stikstof provincie -pallas", match: "all", chamber: "tk", from: "2026-10-01", to: "2026-11-03" });
  });

  it("search without hits: suggests match 'alle' for a phrase and names the party labels", async () => {
    vi.stubEnv("GEHOORD_KEY", "k");
    mockGehoord(() => page([], 0, 0, 25));
    const phrase = await call("gehoord_debatten_search", { query: "stikstof provincie", match: "woordgroep" });
    expect(phrase.access_note).toContain("Gezocht op de letterlijke woordgroep 'stikstof provincie'");
    expect(phrase.access_note).toContain("zoek met match 'alle'");
    const party = await call("gehoord_debatten_search", { query: "stikstof", fractie: "Groen Links" });
    expect(party.access_note).toContain("fractie gaat als exact partijlabel naar Gehoord.de");
  });

  it("list: the official page as url, debate type and count, the condensed-subtitles note", async () => {
    vi.stubEnv("GEHOORD_KEY", "k");
    const calls = mockGehoord(() => page([{ ...TK_LIVE, debateType: "Plenair debat", contributionCount: 120, subtitlesCondensed: true, startedAt: "2026-11-03T15:31:00.000Z", endedAt: null }], 1, 0, 25));
    const out = await call("gehoord_debatten_list", { status: "live", kamer: "tk", date_from: "2026-11-03", date_to: "2026-11-03" });
    expect(Object.fromEntries(calls[0].url.searchParams)).toMatchObject({ chamber: "tk", status: "live", from: "2026-11-03", to: "2026-11-03" });
    expect(out.summary).toBe("1 debat, waarvan 1 nu live");
    expect(out.records[0].canonical_url).toBe(TK_LIVE.url);
    expect(out.records[0].snippet).toBe("Tweede Kamer · Plenair debat · live · Plenaire zaal · 120 fragmenten · samengevatte ondertiteling (niet letterlijk)");
    expect(out.records[0].data).toMatchObject({ debat_id: 312905, kamer: "tk", aantal_fragmenten: 120, gehoord_url: "https://gehoord.de/beraadslagingen/312905" });
    expect(out.access_note).toContain("samengevat en dus niet letterlijk");
    expect(out.access_note).toContain("Debat nog live");
  });

  it("list: a cancelled debate, with its status asked of Gehoord and explained", async () => {
    vi.stubEnv("GEHOORD_KEY", "k");
    const cancelled = { ...TK_ENDED, id: 307210, title: "Begroting Onderwijs, Cultuur en Wetenschap 2027", status: "cancelled", debateType: "Plenair debat", startedAt: null, contributionCount: 0, subtitlesCondensed: false };
    const calls = mockGehoord(() => page([cancelled], 43, 0, 25));
    const out = await call("gehoord_debatten_list", { status: "cancelled" });
    expect(calls[0].url.searchParams.get("status")).toBe("cancelled");
    expect(out.summary).toBe("1 debat van 43");
    expect(out.records[0].snippet).toContain("geschrapt");
    expect(out.records[0].data.debat_status).toBe("cancelled");
    expect(out.access_note).toContain("Status 'cancelled' (geschrapt)");
    expect(tools.get("gehoord_debatten_list")!.schema.status.parse("scheduled")).toBe("scheduled");
  });

  it("list: no live debate is an answer, not an error", async () => {
    vi.stubEnv("GEHOORD_KEY", "k");
    mockGehoord(() => page([], 0, 0, 25));
    const out = await call("gehoord_debatten_list", { status: "live" });
    expect(out.summary).toBe("Er is nu geen debat live bij Gehoord.de");
    expect(out.records).toEqual([]);
  });

  it("get with segment_id: the debate with its speakers first, then the window around the fragment", async () => {
    vi.stubEnv("GEHOORD_KEY", "k");
    const all = Array.from({ length: 30 }, (_, i) => contribution(700 + i, EK_LIVE));
    mockGehoord((url) => {
      if (url.pathname === "/api/v1/debates/312818") {
        return jsonResponse({ data: { ...EK_LIVE, debateType: "Plenaire vergadering", subtitlesCondensed: false, speakers: [{ speakerLabel: "vkyyicefojzk", name: "Boris Dittrich", party: "D66", role: "Eerste Kamerlid", politicianId: "vkyyicefojzk", source: "tk_api" }] }, links: {} });
      }
      const offset = Number(url.searchParams.get("offset"));
      return page(all.slice(offset, offset + 200), all.length, offset, 200, { debate: EK_LIVE });
    });
    const out = await call("gehoord_debat_get", { debate_id: "312818", segment_id: 710, context: 2 });
    expect(out.summary).toBe("Debat 'Initiatiefwetsvoorstel embryo's (36.416)' (Eerste Kamer, Plenaire vergadering, live): fragment 9-13 van 30 rond fragment 710 (positie 11)");
    const [head, ...frags] = out.records;
    expect(head.data.sprekers).toEqual([{ persoon_id: "vkyyicefojzk", persoon_url: "https://www.eerstekamer.nl/id/vkyyicefojzk", naam: "Boris Dittrich", fractie: "D66", functie: "Eerste Kamerlid" }]);
    expect(head.canonical_url).toBe(EK_LIVE.url);
    expect(frags.map((r: { data: { fragment_id: number } }) => r.data.fragment_id)).toEqual([708, 709, 710, 711, 712]);
    expect(frags.map((r: { data: { is_segment: boolean } }) => r.data.is_segment)).toEqual([false, false, true, false, false]);
    expect(frags[2].data.positie).toBe(10);
    expect(out.access_note).toContain("Debat nog live");
    expect(out.access_note).toContain("geen hoofdletters en geen leestekens");
    expect(out.access_note).not.toContain("samengevat en dus niet letterlijk");
  });

  it("get without segment_id: the fragments in debate order, paged", async () => {
    vi.stubEnv("GEHOORD_KEY", "k");
    const all = Array.from({ length: 30 }, (_, i) => contribution(700 + i, TK_ENDED));
    mockGehoord((url) => {
      if (url.pathname === "/api/v1/debates/312911") return jsonResponse({ data: { ...TK_ENDED, subtitlesCondensed: true, speakers: [] } });
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return page(all.slice(offset, offset + limit), all.length, offset, limit, { debate: TK_ENDED });
    });
    const out = await call("gehoord_debat_get", { debate_id: 312911, top: 10, offset: 10, max_chars: 0 });
    expect(out.summary).toMatch(/fragment 11-20 van 30$/);
    expect(out.records).toHaveLength(11);
    expect(out.records[1].data.tekst).toBeUndefined();
    expect(out.pagination).toEqual({ offset: 10, limit: 10, total: 30, has_more: true });
    expect(out.access_note).toContain("Volgende fragmenten: offset=20.");
    expect(out.access_note).toContain("samengevat en dus niet letterlijk");
  });
});
