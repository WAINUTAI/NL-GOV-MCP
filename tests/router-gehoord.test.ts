import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { detectDebatIntent, detectGehoordIntent, gehoordLongestTerm, gehoordQuery } from "../src/router/intents.js";
import { logger } from "../src/utils/logger.js";
import { createAskHarness } from "./helpers/route-trace.js";

/* ------------------------------------------------------------------ */
/*  The Gehoord.de route of nl_gov_ask: debates now or today and the   */
/*  Eerste Kamer, only with GEHOORD_KEY; and the debate route asking   */
/*  Gehoord when the verslagen have nothing.                           */
/* ------------------------------------------------------------------ */

/** Questions the Gehoord route takes with the key. */
const GEHOORD_QUESTIONS = [
  "Welk debat is er nu live in de Tweede Kamer?",
  "Welke debatten zijn er vandaag in de Tweede Kamer?",
  "Wat wordt er op dit moment besproken in de Kamer?",
  "Wat zei de minister in de Eerste Kamer over embryo's?",
  "Wat werd er gisteren gezegd in de Eerste Kamer?",
  "Wat wordt er vandaag in de Tweede Kamer over stikstof besproken?",
];

/** Near misses: the agenda, votes, moties, other bodies, or no Kamer and no now/today. */
const NOT_GEHOORD = [
  "Wanneer is het debat over stikstof in de Tweede Kamer?",
  "Wat staat er vandaag op de agenda van de Tweede Kamer?",
  "Welke moties zijn vandaag aangenomen in de Tweede Kamer?",
  "Wat besprak de gemeenteraad van Utrecht vandaag over parkeren?",
  "Welke debatten waren er over stikstof in september?",
  "Wat is nu de werkloosheid in Nederland?",
  "Stemmingen in de Eerste Kamer over het wetsvoorstel",
  // Rulings: "uitspraak" of a court is no speech in the Kamer.
  "Welke uitspraken deed de rechter vandaag over de Tweede Kamer?",
  "Wat is de uitspraak van de Hoge Raad over de Kamer vandaag?",
];

describe("detectGehoordIntent", () => {
  it("reads which debates run now or ran today, and in which Kamer", () => {
    expect(detectGehoordIntent("Welk debat is er nu live in de Tweede Kamer?")).toEqual({ kind: "list", kamer: "tk", status: "live" });
    expect(detectGehoordIntent("Welke debatten zijn er vandaag in de Tweede Kamer?")).toEqual({ kind: "list", kamer: "tk" });
    expect(detectGehoordIntent("Wat wordt er op dit moment besproken in de Kamer?")).toEqual({ kind: "list", status: "live" });
    expect(detectGehoordIntent("Wat werd er gisteren gezegd in de Eerste Kamer?")).toEqual({ kind: "list", kamer: "ek" });
  });

  it("searches a topic by its terms: Eerste Kamer without punctuation, now/today in either Kamer", () => {
    expect(detectGehoordIntent("Wat zei de minister in de Eerste Kamer over embryo's?")).toEqual({ kind: "search", kamer: "ek", query: "embryos", spreker: "minister" });
    expect(detectGehoordIntent("Wat wordt er vandaag in de Tweede Kamer over stikstof besproken?")).toEqual({ kind: "search", kamer: "tk", query: "stikstof" });
    expect(detectGehoordIntent("Wat zei de VVD in de senaat over de Omgevingswet?")).toEqual({ kind: "search", kamer: "ek", query: "Omgevingswet", fractie: "VVD" });
  });

  it("leaves the agenda, votes, moties, other bodies and timeless Tweede Kamer questions alone", () => {
    for (const q of NOT_GEHOORD) expect(detectGehoordIntent(q), q).toBeUndefined();
  });

  it("takes a court's ruling for no speech, but keeps a ruling someone talks about in the Kamer", () => {
    expect(detectGehoordIntent("Welke uitspraken deed de rechter vandaag over de Tweede Kamer?")).toBeUndefined();
    expect(detectGehoordIntent("Wat zei de minister vandaag in de Kamer over de uitspraak van de Hoge Raad?")).toMatchObject({ kind: "search", spreker: "minister" });
  });

  it("never reads the Kamer as a speaker", () => {
    expect(detectGehoordIntent("Wat heeft de Eerste Kamer gezegd over de Wet op de inlichtingen- en veiligheidsdiensten?")).toEqual({ kind: "search", kamer: "ek", query: "Wet inlichtingen veiligheidsdiensten" });
    expect(detectGehoordIntent("Wat heeft de Kamer vandaag besproken over de zorg?")).toEqual({ kind: "search", query: "zorg" });
    // A name with a lowercase particle stays a name.
    expect(detectDebatIntent("Wat heeft van Campen gezegd in het debat over stikstof?")).toMatchObject({ spreker: "van Campen" });
  });

  it("reads 'debatteert', 'nu' as today only, and an Eerste Kamerlid as the Eerste Kamer", () => {
    expect(detectGehoordIntent("Waar debatteert de Tweede Kamer nu over?")).toEqual({ kind: "list", kamer: "tk", status: "live" });
    expect(detectGehoordIntent("Wat wordt er nu gezegd over stikstof in de Tweede Kamer?")).toEqual({ kind: "search", kamer: "tk", query: "stikstof", nu: true });
    expect(detectDebatIntent("Wat zei Eerste Kamerlid Nicolaï over de asielwetten?")).toBeUndefined();
    expect(detectGehoordIntent("Wat zei Eerste Kamerlid Nicolaï over de asielwetten?")).toEqual({ kind: "search", kamer: "ek", query: "asielwetten" });
  });

  it("does not change what detectDebatIntent reads", () => {
    expect(detectDebatIntent("Wat zei de VVD in het debat over stikstof?")).toEqual({ fractie: "VVD", query: "stikstof" });
    expect(detectDebatIntent("Wat zei de minister in de Eerste Kamer over embryo's?")).toBeUndefined();
  });

  it("passes every term to Gehoord (match 'alle'), a quoted phrase whole", () => {
    expect(gehoordQuery("stikstof")).toBe("stikstof");
    expect(gehoordQuery('stikstof "medische isotopen"')).toBe('stikstof "medische isotopen"');
    expect(gehoordQuery("Pallas reactor isotopen")).toBe("Pallas reactor isotopen");
    expect(gehoordQuery('"Pallas"  isotopen')).toBe("Pallas isotopen");
    expect(gehoordQuery("")).toBe("");
    expect(detectGehoordIntent("Wat wordt er vandaag in de Tweede Kamer over stikstof en de provincie besproken?")).toEqual({ kind: "search", kamer: "tk", query: "stikstof provincie" });
  });

  it("keeps the longest term for one more search when all terms find nothing", () => {
    expect(gehoordLongestTerm("Wet inlichtingen veiligheidsdiensten")).toBe("veiligheidsdiensten");
    expect(gehoordLongestTerm("toekomst pensioenstelsel")).toBe("pensioenstelsel");
    expect(gehoordLongestTerm('stikstof "medische isotopen"')).toBe('"medische isotopen"');
    expect(gehoordLongestTerm("stikstof")).toBeUndefined();
    expect(gehoordLongestTerm("")).toBeUndefined();
  });
});

const EK_DEBAT = { id: 312818, chamber: "ek", title: "Wijziging van de Wet op de inlichtingen- en veiligheidsdiensten 2017", status: "ended", hall: "Plenaire zaal", startsAt: "2026-10-06T08:30:00.000Z", url: "https://www.eerstekamer.nl/plenaire_vergadering/20261006" };
const EK_HIT = {
  id: 9001,
  debateId: 312818,
  text: "de veiligheidsdiensten moeten binnen de wet blijven werken",
  speakerLabel: "vkyyicefp9z2",
  speakerName: "Peter Nicolaï",
  speakerParty: "PvdD",
  speakerRole: "Eerste Kamerlid",
  startTime: "2026-10-06T09:00:00.000Z",
  endTime: "2026-10-06T09:01:00.000Z",
  debate: EK_DEBAT,
};
function gehoordJson(data: unknown[], extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ data, pagination: { limit: 200, offset: 0, total: data.length, hasMore: false }, ...extra }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("nl_gov_ask and Gehoord.de", () => {
  const harness = createAskHarness();
  const logLevel = logger.level;
  beforeAll(() => {
    logger.level = "warn";
    vi.stubEnv("OVERHEID_API_KEY", "");
    vi.stubEnv("KNMI_API_KEY", "");
    vi.stubEnv("DSO_API_KEY", "");
  });
  afterEach(() => vi.stubEnv("GEHOORD_KEY", ""));
  afterAll(() => {
    vi.unstubAllEnvs();
    logger.level = logLevel;
  });

  it("plans and asks Gehoord.de first for these questions with the key", async () => {
    vi.stubEnv("GEHOORD_KEY", "test-key");
    for (const question of GEHOORD_QUESTIONS) {
      const plan = await harness.plan(question);
      expect(plan.estimated_sources, question).toEqual(["gehoord"]);
      const trace = await harness.trace(question);
      expect(trace.firstSources, question).toEqual(["gehoord"]);
    }
  });

  it("plans the Gehoord request with the intent's parameters", async () => {
    vi.stubEnv("GEHOORD_KEY", "test-key");
    const live = await harness.plan("Welk debat is er nu live in de Tweede Kamer?");
    expect(live.planned_requests[0]).toMatchObject({ connector: "gehoord", method: "GET", url: "https://gehoord.de/api/v1/debates", params: { kamer: "tk", status: "live" } });
    const ek = await harness.plan("Wat zei de minister in de Eerste Kamer over embryo's?");
    expect(ek.planned_requests[0]).toMatchObject({ url: "https://gehoord.de/api/v1/contributions", params: { query: "embryos", kamer: "ek", spreker: "minister" } });
  });

  it("asks Gehoord.de before the verslagen for a question about now, and searches today only", async () => {
    vi.stubEnv("GEHOORD_KEY", "test-key");
    const plan = await harness.plan("Wat wordt er nu gezegd over stikstof in de Tweede Kamer?");
    expect(plan.estimated_sources).toEqual(["gehoord"]);
    expect(plan.planned_requests[0]).toMatchObject({ url: "https://gehoord.de/api/v1/contributions", params: { query: "stikstof", kamer: "tk", date_from: "2026-10-06", date_to: "2026-10-06" } });
    // Without the key the verslagen answer it, as before.
    vi.stubEnv("GEHOORD_KEY", "");
    expect((await harness.plan("Wat wordt er nu gezegd over stikstof in de Tweede Kamer?")).estimated_sources).not.toContain("gehoord");
  });

  it("routes as before without the key", async () => {
    vi.stubEnv("GEHOORD_KEY", "");
    for (const question of GEHOORD_QUESTIONS) {
      const plan = await harness.plan(question);
      expect(plan.estimated_sources, question).not.toContain("gehoord");
    }
  });

  it("keeps the near misses off the route with the key", async () => {
    vi.stubEnv("GEHOORD_KEY", "test-key");
    for (const question of NOT_GEHOORD) {
      const plan = await harness.plan(question);
      expect(plan.estimated_sources, question).not.toContain("gehoord");
    }
  });

  it("answers 'nothing live now' instead of falling through", async () => {
    vi.stubEnv("GEHOORD_KEY", "test-key");
    const trace = await harness.trace("Welk debat is er nu live in de Tweede Kamer?");
    expect(trace.summary).toBe("Router: Gehoord.de — Er is nu geen debat live bij Gehoord.de");
    expect(trace.requests.map((r) => r.source)).toEqual(["gehoord"]);
  });

  it("searches once more with the longest term when all terms together find nothing, and says so", async () => {
    vi.stubEnv("GEHOORD_KEY", "test-key");
    const question = "Wat heeft de Eerste Kamer gezegd over de Wet op de inlichtingen- en veiligheidsdiensten?";
    const trace = await harness.trace(question, (url) =>
      url.hostname === "gehoord.de" && url.searchParams.get("q") === "veiligheidsdiensten" ? gehoordJson([EK_HIT]) : undefined,
    );
    const asked = trace.requests.filter((r) => r.source === "gehoord").map((r) => new URL(r.url).searchParams.get("q"));
    expect(asked).toEqual(["Wet inlichtingen veiligheidsdiensten", "veiligheidsdiensten"]);
    expect(trace.summary).toMatch(/^Router: Gehoord\.de — 1 fragment/);
    expect(trace.body.access_note).toContain("Met alle woorden ('Wet inlichtingen veiligheidsdiensten') vond Gehoord.de niets; daarna gezocht op alleen het langste woord 'veiligheidsdiensten'.");

    // The debate route's Gehoord fallback does the same; one term is not searched twice.
    const fallback = await harness.trace("Wat zei de VVD in het debat over stikstof en de provincie?");
    expect(fallback.requests.filter((r) => r.source === "gehoord").map((r) => new URL(r.url).searchParams.get("q"))).toEqual(["stikstof provincie", "provincie"]);
    const one = await harness.trace("Wat zei de VVD in het debat over stikstof?");
    expect(one.requests.filter((r) => r.source === "gehoord")).toHaveLength(1);
  });

  it("lists today's debates that run or ran before the planned ones, without the cancelled, counted per status", async () => {
    vi.stubEnv("GEHOORD_KEY", "test-key");
    const debate = (id: number, status: string, title: string) => ({ id, chamber: "tk", title, status, hall: "Plenaire zaal", startsAt: "2026-10-06T12:00:00.000Z" });
    // Gehoord's order: newest id first, so the planned debates come first.
    const day = [debate(9, "scheduled", "Belastingplan"), debate(8, "scheduled", "Procedurevergadering"), debate(7, "cancelled", "Juridische beroepen"), debate(6, "live", "Begroting KGG"), debate(5, "ended", "Procedurevergadering IenW")];
    const trace = await harness.trace("Welke debatten zijn er vandaag in de Tweede Kamer?", (url) => (url.hostname === "gehoord.de" && url.pathname === "/api/v1/debates" ? gehoordJson(day) : undefined));
    const sent = trace.requests.filter((r) => r.source === "gehoord").map((r) => Object.fromEntries(new URL(r.url).searchParams));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chamber: "tk", limit: "200", from: "2026-10-06", to: "2026-10-06" });
    expect(sent[0].status).toBeUndefined();
    expect(trace.body.records.map((r: { title: string }) => r.title)).toEqual(["Begroting KGG", "Procedurevergadering IenW", "Belastingplan", "Procedurevergadering"]);
    expect(trace.summary).toBe("Router: Gehoord.de — 4 debatten: 1 live, 1 afgelopen, 2 gepland, 1 geschrapt (niet getoond)");
    expect(trace.body.access_note).toContain("eerst die nu live zijn, dan de afgelopen, dan de geplande");
    expect(trace.body.access_note).not.toContain("er zijn geweest");
  });

  it("asks Gehoord.de after the verslagen for a debate question they do not answer, only with the key", async () => {
    const question = "Wat zei de VVD in het debat over stikstof?";
    vi.stubEnv("GEHOORD_KEY", "test-key");
    const withKey = await harness.trace(question);
    expect(withKey.firstSources).toEqual(["tk"]);
    const gehoord = withKey.requests.filter((r) => r.source === "gehoord");
    expect(gehoord).toHaveLength(1);
    // Gehoord filters the Kamer and the fractie itself: one request of top hits, no scan.
    const sent = Object.fromEntries(new URL(gehoord[0].url).searchParams);
    expect(sent).toMatchObject({ q: "stikstof", match: "all", chamber: "tk", party: "VVD" });
    expect(sent.limit).not.toBe("200");

    vi.stubEnv("GEHOORD_KEY", "");
    const without = await harness.trace(question);
    expect(without.requests.some((r) => r.source === "gehoord")).toBe(false);
  });
});
