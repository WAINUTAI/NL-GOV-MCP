import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  amsterdamDay,
  buildNwoListRequest,
  buildZonmwListRequest,
  clampOnderzoekscallRows,
  featureText,
  mapOnderzoekscallError,
  nwoStatusOfLabel,
  nwoStatusTermIds,
  NWO_STATUS_TERMS,
  OnderzoekscallInputError,
  OnderzoekscallsSource,
  ONDERZOEKSCALL_CONNECTORS,
  ONDERZOEKSCALL_MAX_ROWS,
  onderzoekscallQuery,
  parseDutchDate,
  parseEuroAmount,
  parseNwoCallPage,
  parseNwoListing,
  parseZonmwCallPage,
  parseZonmwListing,
  parseZonmwStatusBlock,
  planPageWindow,
  resolveOnderzoekscallUrl,
  sectionedText,
  summarizeOnderzoekscall,
  summarizeOnderzoekscallsSearch,
  zonmwStatusFromDates,
} from "../src/sources/nl-onderzoekscalls.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { setCrawlDelaysEnabled, SourceRequestError } from "../src/utils/http.js";
import { htmlResponse, testConfig } from "./helpers/config.js";
import {
  CONTACT_NAME,
  CONTACT_PHONE,
  nwoCallPageHtml,
  nwoCards,
  nwoListingHtml,
  zonmwCallPageHtml,
  zonmwListingHtml,
  zonmwStatusBlockHtml,
  type ZonmwCardFixture,
} from "./helpers/onderzoekscalls-fixtures.js";

const NOW = new Date("2026-10-15T18:00:00Z");

/** fetch mock routed by URL; records every URL asked. */
function routedFetch(handler: (url: URL) => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      return handler(new URL(url));
    }),
  );
  return calls;
}

/** Without crawl delays: the mocked sites answer at once (the spacing has a test of its own). */
function source(): OnderzoekscallsSource {
  return new OnderzoekscallsSource(testConfig, () => NOW, { nwo: 0, zonmw: 0 });
}

const iso = (d: string) => ({ iso: d, text: d.slice(0, 10) });

/** n ZonMw cards; `kind` sets the dates relative to NOW. */
function zCards(prefix: string, n: number, kind: "open" | "expected" | "closed", startIndex = 0): ZonmwCardFixture[] {
  return Array.from({ length: n }, (_, i) => {
    const k = startIndex + i;
    const day = String(10 + (k % 18)).padStart(2, "0");
    return {
      slug: `${prefix}-${k}`,
      nid: String(50000 + k),
      title: `${prefix} subsidie ${k}`,
      start: kind === "expected" ? iso(`2026-11-${day}T08:00:00Z`) : iso(`2026-0${1 + (k % 8)}-01T08:00:00Z`),
      deadline: kind === "closed" ? iso(`2026-09-${day}T12:00:00Z`) : iso(`2027-01-${day}T12:00:00Z`),
    };
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  clearHttpCache();
  // On, as in production, with no starts booked by an earlier test.
  setCrawlDelaysEnabled(true);
});

describe("helpers", () => {
  it("parses plain euro amounts only", () => {
    expect(parseEuroAmount("€840.875")).toBe(840875);
    expect(parseEuroAmount("€ 240.000,-")).toBe(240000);
    expect(parseEuroAmount("€ 30.000,00")).toBe(30000);
    expect(parseEuroAmount("€600")).toBe(600);
    expect(parseEuroAmount("€ 1,5 miljoen")).toBeUndefined();
    expect(parseEuroAmount("€ 50.000 - € 125.000")).toBeUndefined();
    expect(parseEuroAmount(undefined)).toBeUndefined();
    // English pages write thousands with commas; on a Dutch page that is not an amount.
    expect(parseEuroAmount("€3,000,000", "en")).toBe(3000000);
    expect(parseEuroAmount("€3,000,000")).toBeUndefined();
    expect(parseEuroAmount("4 miljoen euro")).toBeUndefined();
  });

  it("parses Dutch dates and rejects impossible ones", () => {
    expect(parseDutchDate("12 november 2026")).toBe("2026-11-12");
    expect(parseDutchDate("1 Maart 2027")).toBe("2027-03-01");
    expect(parseDutchDate("31 februari 2027")).toBeUndefined();
    expect(parseDutchDate("begin februari 2027")).toBeUndefined();
  });

  it("applies ZonMw's own status rule to start and deadline", () => {
    expect(zonmwStatusFromDates("2026-11-12T08:00:00Z", "2027-01-28T13:00:00Z", NOW)).toEqual({ status: "binnenkort", label: "Verwacht" });
    expect(zonmwStatusFromDates("2026-09-01T08:00:00Z", "2026-10-27T13:00:00Z", NOW)).toEqual({ status: "open", label: "Open" });
    expect(zonmwStatusFromDates("2026-08-31T22:00:00Z", "2026-10-14T12:00:00Z", NOW)).toEqual({ status: "gesloten", label: "Gesloten" });
    // The deadline instant itself is closed.
    expect(zonmwStatusFromDates("2026-09-01T08:00:00Z", NOW.toISOString(), NOW)?.status).toBe("gesloten");
    expect(zonmwStatusFromDates(undefined, "2027-01-28T13:00:00Z", NOW)).toBeUndefined();
  });

  it("maps NWO labels and filters onto the status facet terms", () => {
    expect(nwoStatusOfLabel("Open voor aanvragen")).toBe("open");
    expect(nwoStatusOfLabel("doorlopend")).toBe("open");
    expect(nwoStatusOfLabel("In voorbereiding")).toBe("binnenkort");
    expect(nwoStatusOfLabel("Procedure loopt")).toBe("gesloten");
    expect(nwoStatusOfLabel("Uitgesteld")).toBeUndefined();
    expect(nwoStatusOfLabel("Open for applications")).toBe("open");
    expect(nwoStatusOfLabel("Upcoming")).toBe("binnenkort");
    expect(nwoStatusOfLabel("In progress")).toBe("gesloten");
    // A label of an NWO unit that nwo.nl does not use is left unmapped.
    expect(nwoStatusOfLabel("Open voor inschrijvingen")).toBeUndefined();
    expect(nwoStatusTermIds("actueel")).toEqual(["1866", "62163", "62164", "1868", "1869", "62162"]);
    expect(nwoStatusTermIds("binnenkort")).toEqual(["1869", "62162"]);
    expect(nwoStatusTermIds("gesloten")).toEqual(["62165", "1867"]);
    expect(nwoStatusTermIds("alle")).toEqual([]);
    // The parent term "Open calls" is never used.
    expect(NWO_STATUS_TERMS.some((t) => t.tid === "62286")).toBe(false);
  });

  it("builds the overview URLs the sites themselves use", () => {
    const nwo = buildNwoListRequest("waterstof opslag", "binnenkort", 2);
    expect(nwo.url).toBe("https://www.nwo.nl/calls?input=waterstof+opslag&f%5B0%5D=calls_bw_call_status%3A1869&f%5B1%5D=calls_bw_call_status%3A62162&page=2");
    expect(nwo.params).toEqual({ input: "waterstof opslag", "f[0]": "calls_bw_call_status:1869", "f[1]": "calls_bw_call_status:62162", page: "2" });
    expect(buildNwoListRequest("", "alle", 0).url).toBe("https://www.nwo.nl/calls");
    const zonmw = buildZonmwListRequest("zorginnovatie", 0);
    expect(zonmw.url).toBe("https://www.zonmw.nl/nl/subsidies?input=zorginnovatie&sort_bef_combine=field_subsidy_date_end_DESC");
    // No facet URL: zonmw.nl's robots.txt excludes them.
    expect(zonmw.url).not.toMatch(/f%5B|f\[/);
  });

  it("cuts a long query at a whole word and clamps rows", () => {
    const long = `${"cultureel erfgoed ".repeat(10)}digitalisering`;
    const q = onderzoekscallQuery(long);
    expect(q.cut).toBe(true);
    expect(q.term.length).toBeLessThanOrEqual(128);
    expect(long.startsWith(q.term)).toBe(true);
    expect(onderzoekscallQuery("  zorginnovatie  ")).toEqual({ term: "zorginnovatie", cut: false });
    expect(clampOnderzoekscallRows(500)).toBe(ONDERZOEKSCALL_MAX_ROWS);
    expect(clampOnderzoekscallRows(undefined)).toBe(10);
    expect(planPageWindow(10, 5)).toEqual({ first: 0, last: 1, skip: 10 });
    expect(planPageWindow(24, 12)).toEqual({ first: 2, last: 2, skip: 0 });
  });

  it("accepts only call pages of the NWO family and ZonMw", () => {
    expect(resolveOnderzoekscallUrl("https://www.nwo.nl/calls/waterstof-2026")).toEqual({ organisation: "nwo", url: "https://www.nwo.nl/calls/waterstof-2026" });
    expect(resolveOnderzoekscallUrl("www.nwo.nl/calls/waterstof-2026#criteria").url).toBe("https://www.nwo.nl/calls/waterstof-2026");
    expect(resolveOnderzoekscallUrl("http://regieorgaan-sia.nl/calls/x").url).toBe("https://regieorgaan-sia.nl/calls/x");
    expect(resolveOnderzoekscallUrl("https://www.zonmw.nl/nl/subsidie/zorginnovatie").organisation).toBe("zonmw");
    expect(() => resolveOnderzoekscallUrl("https://www.example.org/calls/x")).toThrow(OnderzoekscallInputError);
    expect(() => resolveOnderzoekscallUrl("file:///etc/passwd")).toThrow(OnderzoekscallInputError);
    expect(() => resolveOnderzoekscallUrl("ftp://www.nwo.nl/calls/x")).toThrow(OnderzoekscallInputError);
  });

  it("reads call paths only, without a query string", () => {
    expect(resolveOnderzoekscallUrl("https://www.nwo.nl/calls/waterstof-2026?utm_source=x").url).toBe("https://www.nwo.nl/calls/waterstof-2026");
    expect(resolveOnderzoekscallUrl("https://www.nwo.nl/calls/samenwerking-2026/2027").url).toBe("https://www.nwo.nl/calls/samenwerking-2026/2027");
    expect(resolveOnderzoekscallUrl("https://www.nko.nl/en/calls/onderwijs-2027").organisation).toBe("nwo");
    expect(resolveOnderzoekscallUrl("https://regieorgaan-sia.nl/calls/erfgoed-hbo/n1").url).toBe("https://regieorgaan-sia.nl/calls/erfgoed-hbo/n1");
    expect(resolveOnderzoekscallUrl("https://www.zonmw.nl/en/subsidy/zorginnovatie-2026").organisation).toBe("zonmw");
    // Overviews, facet URLs (excluded by zonmw.nl's robots.txt) and search pages are never fetched.
    expect(() => resolveOnderzoekscallUrl("https://www.zonmw.nl/nl/subsidies?f[0]=subsidy_status:open")).toThrow(/geen subsidiepagina/);
    expect(() => resolveOnderzoekscallUrl("https://www.nwo.nl/search?input=waterstof")).toThrow(/geen callpagina/);
    expect(() => resolveOnderzoekscallUrl("https://www.nwo.nl/calls")).toThrow(OnderzoekscallInputError);
  });

  it("joins list-valued features with semicolons", () => {
    expect(featureText('<a href="/a">Water</a>\n<a href="/b">Klimaat</a>')).toBe("Water; Klimaat");
    expect(featureText("<ul><li><a>Programma A</a></li><li><a>Programma B</a></li></ul>")).toBe("Programma A; Programma B");
    expect(featureText('<time datetime="2026-10-27T12:00:00Z">27 oktober 2026</time> 14:00 uur')).toBe("27 oktober 2026 14:00 uur");
    expect(featureText('Programma Erfgoed<a href="/x" hreflang="nl">Deelprogramma Digitalisering</a>')).toBe("Programma Erfgoed; Deelprogramma Digitalisering");
    expect(featureText('Zie <a href="/x">de regeling</a> voor details')).toBe("Zie de regeling voor details");
  });

  it("gives the Amsterdam calendar day of a deadline", () => {
    // 00:00 Amsterdam in summer time is 22:00 UTC the day before.
    expect(amsterdamDay("2027-05-12T22:00:00.000Z")).toBe("2027-05-13");
    expect(amsterdamDay("2026-12-01T13:00:00.000Z")).toBe("2026-12-01");
    expect(amsterdamDay("2026-11-12")).toBe("2026-11-12");
    expect(amsterdamDay(undefined)).toBeUndefined();
  });

  it("marks headings in the page text and leaves navigation out", () => {
    const text = sectionedText('<nav>Kruimelpad</nav><p>Inleiding.</p><h2 class="x">Voor wie</h2><p>Onderzoekers.</p><h2>Leeg</h2>');
    expect(text).toBe("Inleiding.\n\n## Voor wie\nOnderzoekers.\n\n## Leeg");
  });
});

describe("overview parsers", () => {
  it("reads NWO cards, the status facet and the pager", () => {
    const html = nwoListingHtml({
      cards: [
        { href: "/calls/waterstof-2026", title: "Waterstof &amp; opslag 2026", status: "Open voor aanvragen", budget: "&euro;2.400.000" },
        { href: "https://regieorgaan-sia.nl/calls/erfgoed-hbo", title: "Cultureel erfgoed hbo", status: "Doorlopend" },
        { href: "/calls/oud", title: "Afgesloten ronde", status: "Gesloten", budget: "&euro;840.875", closed: true },
      ],
      hasNext: true,
    });
    const out = parseNwoListing(html);
    expect(out).toBeDefined();
    expect(out?.items).toHaveLength(3);
    expect(out?.items[0]).toMatchObject({
      organisation: "nwo",
      title: "Waterstof & opslag 2026",
      url: "https://www.nwo.nl/calls/waterstof-2026",
      status: "open",
      status_label: "Open voor aanvragen",
      status_source: "label",
      budget_text: "€2.400.000",
      budget_eur: 2400000,
    });
    expect(out?.items[0].deadline).toBeUndefined();
    expect(out?.items[1]).toMatchObject({ status: "open", status_label: "Doorlopend", hosted_on: "regieorgaan-sia.nl" });
    expect(out?.items[1].budget_text).toBeUndefined();
    expect(out?.items[2]).toMatchObject({ status: "gesloten", budget_eur: 840875 });
    expect(out?.hasNext).toBe(true);
    expect(out?.sortLabel).toBe("Sluitingsdatum (eerder-later)");
    expect(out?.statusFacet?.get("1866")).toEqual({ label: "Open voor aanvragen", count: 21 });
    expect(out?.statusFacet?.get("62286")).toEqual({ label: "Open calls", count: 17 });
    expect(out?.statusFacet?.size).toBe(9);
  });

  it("tells an empty NWO result from a changed page", () => {
    expect(parseNwoListing(nwoListingHtml({ cards: [] }))?.items).toEqual([]);
    expect(parseNwoListing("<html><body><p>Onderhoud</p></body></html>")).toBeUndefined();
  });

  it("reads ZonMw cards with dates, programme, audience and the date-based status", () => {
    const html = zonmwListingHtml({
      total: 825,
      cards: [
        { slug: "zorginnovatie-wijk", nid: "54390", title: "Zorginnovatie in de wijk", start: { iso: "2026-11-12T08:00:00Z", text: "12 november 2026, 9.00 uur" }, deadline: { iso: "2027-01-28T13:00:00Z", text: "28 januari 2027, 14.00 uur" } },
        { slug: "erfgoed", nid: "51902", title: "Cultureel erfgoed en gezondheid", start: { iso: "2026-09-01T06:55:00Z", text: "1 september 2026, 8.55 uur" }, deadline: { iso: "2026-10-27T13:00:00Z", text: "27 oktober 2026, 14.00 uur" }, forWhom: "Op uitnodiging" },
        { slug: "zonder-datums", nid: "40000", title: "Zonder datums" },
      ],
    });
    const out = parseZonmwListing(html, NOW);
    expect(out?.total).toBe(825);
    expect(out?.sortLabel).toBe("Einddatum Nieuw - Oud");
    expect(out?.items[0]).toMatchObject({
      organisation: "zonmw",
      id: "54390",
      title: "Zorginnovatie in de wijk",
      url: "https://www.zonmw.nl/nl/subsidie/zorginnovatie-wijk",
      programme: "Voorbeeldprogramma Zorginnovatie",
      opening_date: "2026-11-12T08:00:00.000Z",
      opening_text: "12 november 2026, 9.00 uur",
      deadline: "2027-01-28T13:00:00.000Z",
      deadline_text: "28 januari 2027, 14.00 uur",
      status: "binnenkort",
      status_label: "Verwacht",
      status_source: "datums",
    });
    expect(out?.items[0].summary).toMatch(/^Deze subsidieoproep stimuleert/);
    expect(out?.items[1]).toMatchObject({ status: "open", for_whom: "Op uitnodiging" });
    // Without dates no status is guessed.
    expect(out?.items[2].status).toBeUndefined();
    expect(out?.items[2].status_label).toBeUndefined();
  });

  it("reads the ZonMw empty state and rejects a page without the count", () => {
    expect(parseZonmwListing(zonmwListingHtml({ total: 0, cards: [] }), NOW)).toEqual({ items: [], total: 0, sortLabel: "Einddatum Nieuw - Oud" });
    expect(parseZonmwListing("<html><body>Storing</body></html>", NOW)).toBeUndefined();
  });

  it("reads ZonMw's status block", () => {
    expect(parseZonmwStatusBlock(zonmwStatusBlockHtml("expected"))).toEqual({ status: "binnenkort", label: "Verwacht" });
    expect(parseZonmwStatusBlock(zonmwStatusBlockHtml("closed"))).toEqual({ status: "gesloten", label: "Gesloten" });
    expect(parseZonmwStatusBlock("<p>leeg</p>")).toBeUndefined();
  });
});

describe("call page parsers", () => {
  const twoStage = () =>
    nwoCallPageHtml({
      title: "Waterstof en opslag 2026",
      statusAnchors: [{ tid: "62286", label: "Open calls" }, { tid: "62164", label: "Open voor vooraanmelding" }],
      dates: [
        { label: "Sluitingsdatum vooraanmelding", iso: "2026-10-08T12:00:00Z", text: "8 oktober 2026" },
        { label: "Sluitingsdatum volledige aanvraag", iso: "2027-03-11T12:00:00Z", text: "11 maart 2027" },
      ],
      plainFeatures: [{ label: "Specifiek voor", value: '<a href="/calls?f%5B0%5D=calls_for%3A1">Interdisciplinaire samenwerking</a>\n<a href="/calls?f%5B0%5D=calls_for%3A2">Samenwerking met bedrijven</a>' }],
      budget: "&euro;2.000.000",
    });

  it("reads the NWO features, picks the final closing date and keeps the contact block out", () => {
    const out = parseNwoCallPage(twoStage(), "https://www.nwo.nl/calls/waterstof-2026", NOW);
    expect(out).toBeDefined();
    expect(out).toMatchObject({
      organisation: "nwo",
      title: "Waterstof en opslag 2026",
      status: "open",
      status_label: "Open voor vooraanmelding",
      status_source: "label",
      deadline: "2027-03-11T12:00:00.000Z",
      deadline_label: "Sluitingsdatum volledige aanvraag",
      deadline_text: "11 maart 2027 14:00 uur",
      // The vooraanmelding closed on 8 October: the full application is the next closing date too.
      next_deadline: "2027-03-11T12:00:00.000Z",
      next_deadline_label: "Sluitingsdatum volledige aanvraag",
      budget_text: "€2.000.000",
      budget_eur: 2000000,
      programme: "Waterstofprogramma",
    });
    expect(out?.intro).toMatch(/waterstof in de energietransitie/);
    expect(out?.dates.map((d) => d.label)).toEqual(["Sluitingsdatum vooraanmelding", "Sluitingsdatum volledige aanvraag"]);
    expect(out?.features).toContainEqual({ label: "Specifiek voor", value: "Interdisciplinaire samenwerking; Samenwerking met bedrijven" });
    expect(out?.features.map((f) => f.label)).toEqual(["Status", "Sluitingsdatum vooraanmelding", "Sluitingsdatum volledige aanvraag", "Specifiek voor", "Budget", "Onderzoeksprogramma"]);
    // One closing date is still ahead: no warning.
    expect(out?.warnings).toEqual([]);
    expect(out?.documents).toEqual([
      { title: "Waterstof 2026 | call for proposals PDF | 603.29 kB", url: "https://www.nwo.nl/sites/nwo/files/media-files/Call-for-proposals-waterstof-2026.pdf" },
      { title: "Download aanvraagformulier", url: "https://www.nwo.nl/sites/nwo/files/media-files/Aanvraagformulier-waterstof-2026.docx" },
    ]);
    expect(out?.fullText).toContain("## Waarvoor\nDe call financiert onderzoek naar de opslag van waterstof.");
    expect(out?.fullText).toContain("## Criteria\nWetenschappelijke kwaliteit");
    expect(out?.fullText).not.toMatch(/Oriënteren|Kruimelpad|class=/);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(CONTACT_NAME);
    expect(serialized).not.toContain(CONTACT_PHONE);
    expect(serialized).not.toContain("Onze medewerkers");
  });

  it("names the first closing date still ahead when an earlier step closes before the full application", () => {
    const html = nwoCallPageHtml({
      title: "Vroegdiagnostiek 2026",
      statusAnchors: [{ tid: "62286", label: "Open calls" }, { tid: "62163", label: "Open voor intentieverklaring" }],
      dates: [
        { label: "Sluitingsdatum intentieverklaring", iso: "2026-11-17T13:00:00Z", text: "17 november 2026" },
        { label: "Sluitingsdatum volledige aanvraag", iso: "2027-03-30T12:00:00Z", text: "30 maart 2027" },
      ],
    });
    const out = parseNwoCallPage(html, "https://www.nwo.nl/calls/vroegdiagnostiek", NOW);
    expect(out).toMatchObject({
      deadline: "2027-03-30T12:00:00.000Z",
      deadline_label: "Sluitingsdatum volledige aanvraag",
      next_deadline: "2026-11-17T13:00:00.000Z",
      next_deadline_label: "Sluitingsdatum intentieverklaring",
      next_deadline_text: "17 november 2026 14:00 uur",
    });
    // Every closing date after NOW: none is ahead, so no next_deadline.
    expect(parseNwoCallPage(html, "https://www.nwo.nl/calls/vroegdiagnostiek", new Date("2027-04-01T00:00:00Z"))?.next_deadline).toBeUndefined();
  });

  it("warns when an open NWO status sits next to closing dates in the past", () => {
    const html = nwoCallPageHtml({
      title: "Cultureel erfgoed 2026",
      statusAnchors: [{ tid: "62286", label: "Open calls" }, { tid: "1866", label: "Open voor aanvragen" }],
      dates: [{ label: "Sluitingsdatum volledige aanvraag", iso: "2026-10-08T12:00:00Z", text: "8 oktober 2026" }],
    });
    const out = parseNwoCallPage(html, "https://www.nwo.nl/calls/erfgoed", NOW);
    expect(out?.status).toBe("open");
    expect(out?.deadline).toBe("2026-10-08T12:00:00.000Z");
    expect(out?.warnings).toHaveLength(1);
    expect(out?.warnings[0]).toMatch(/Open voor aanvragen.*in het verleden/);
  });

  it("keeps a plain-text date and leaves the deadline empty when the page names none", () => {
    const html = nwoCallPageHtml({
      title: "Bijeenkomsten 2026",
      statusAnchors: [{ tid: "62286", label: "Open calls" }, { tid: "1868", label: "Doorlopend" }],
      plainFeatures: [{ label: "Aankomend ophaalmoment", value: "3 november 2026 14:00 uur" }],
    });
    const out = parseNwoCallPage(html, "https://www.nwo.nl/calls/bijeenkomsten", NOW);
    expect(out?.status_label).toBe("Doorlopend");
    expect(out?.deadline).toBeUndefined();
    expect(out?.dates).toEqual([{ label: "Aankomend ophaalmoment", date: "2026-11-03", text: "3 november 2026 14:00 uur" }]);
  });

  it("names several closing dates without picking one when none is the final application", () => {
    const html = nwoCallPageHtml({
      title: "Twee rondes",
      statusAnchors: [{ tid: "1866", label: "Open voor aanvragen" }],
      dates: [
        { label: "Sluitingsdatum ronde 1", iso: "2026-11-01T12:00:00Z", text: "1 november 2026" },
        { label: "Sluitingsdatum ronde 2", iso: "2027-02-01T12:00:00Z", text: "1 februari 2027" },
      ],
    });
    const out = parseNwoCallPage(html, "https://www.nwo.nl/calls/twee", NOW);
    expect(out?.deadline).toBeUndefined();
    expect(out?.warnings.join(" ")).toMatch(/meerdere sluitingsdata/);
  });

  it("reads an English page of an NWO unit with its own term ids by label", () => {
    const html = nwoCallPageHtml({
      title: "Promising approaches in education",
      statusAnchors: [{ tid: "2414", label: "In preparation" }],
      dates: [{ label: "Closing date full application", iso: "2027-03-31T12:00:00Z", text: "31 March 2027", time: "14:00 hrs. (s.t.c.)" }],
      budget: "&euro;3,000,000",
    });
    const out = parseNwoCallPage(html, "https://www.nko.nl/en/calls/promising-approaches", NOW);
    expect(out).toMatchObject({
      status: "binnenkort",
      status_label: "In preparation",
      deadline: "2027-03-31T12:00:00.000Z",
      deadline_label: "Closing date full application",
      budget_text: "€3,000,000",
      budget_eur: 3000000,
    });
    expect(out?.documents[0].url).toBe("https://www.nko.nl/sites/nwo/files/media-files/Call-for-proposals-waterstof-2026.pdf");
  });

  it("is not fooled by an NWO page that is not a call", () => {
    expect(parseNwoCallPage("<html><h1 class=\"articleHead__title\">Over NWO</h1></html>", "https://www.nwo.nl/over-nwo", NOW)).toBeUndefined();
  });

  it("reads a ZonMw subsidy page", () => {
    const html = zonmwCallPageHtml({
      title: "Zorginnovatie in de wijk",
      nid: "54390",
      deadline: { iso: "2027-01-28T13:00:00Z", text: "28 januari 2027, 14.00 uur" },
      opening: "12 november 2026",
      budget: "€ 240.000,-",
      perApplication: "€ 30.000,-",
      programmes: ["Programma Zorginnovatie", "Programma Preventie"],
      metadataStatus: "expected",
    });
    const words = parseZonmwCallPage(
      zonmwCallPageHtml({ title: "Zorginnovatie", nid: "2", deadline: { iso: "2027-01-28T13:00:00Z", text: "28 januari 2027" }, budget: "4 miljoen euro" }),
      "https://www.zonmw.nl/nl/subsidie/zorginnovatie",
    );
    // An amount in words stays text; no number is made up.
    expect(words?.budget_text).toBe("4 miljoen euro");
    expect(words).not.toHaveProperty("budget_eur");
    const out = parseZonmwCallPage(html, "https://www.zonmw.nl/nl/subsidie/zorginnovatie-wijk");
    expect(out).toMatchObject({
      organisation: "zonmw",
      title: "Zorginnovatie in de wijk",
      deadline: "2027-01-28T13:00:00.000Z",
      deadline_label: "Deadline",
      deadline_text: "28 januari 2027, 14.00 uur",
      opening_text: "12 november 2026",
      opening_date: "2026-11-12",
      budget_text: "€ 240.000,-",
      budget_eur: 240000,
      budget_per_application_text: "€ 30.000,-",
      budget_per_application_eur: 30000,
      programme: "Programma Zorginnovatie; Programma Preventie",
      statusBlockUrl: "https://www.zonmw.nl/nl/entity-date-status/54390/full",
      metadataStatus: "expected",
    });
    expect(out?.status).toBeUndefined();
    expect(out?.documents.map((d) => d.title)).toEqual(["Download volledige subsidieoproep", "Algemene subsidiebepalingen"]);
    expect(out?.fullText).toMatch(/^Deze subsidieoproep stimuleert zorginnovatie in de wijk\./);
    expect(out?.fullText).toContain("## Wie kan aanvragen\nEen samenwerkingsverband");
    expect(out?.fullText).toContain("## Relevante informatie");
    expect(out?.fullText).not.toContain("Op deze pagina");
    expect(JSON.stringify(out)).not.toContain(CONTACT_NAME);
    expect(JSON.stringify(out)).not.toContain(CONTACT_PHONE);
  });
});

describe("OnderzoekscallsSource.search — NWO", () => {
  it("filters by the site's status facet and takes the total from its counts", async () => {
    const calls = routedFetch(() => htmlResponse(nwoListingHtml({ cards: nwoCards("p0"), hasNext: true })));
    const out = await source().search({ organisatie: "nwo", limit: 10 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      "https://www.nwo.nl/calls?f%5B0%5D=calls_bw_call_status%3A1866&f%5B1%5D=calls_bw_call_status%3A62163&f%5B2%5D=calls_bw_call_status%3A62164&f%5B3%5D=calls_bw_call_status%3A1868&f%5B4%5D=calls_bw_call_status%3A1869&f%5B5%5D=calls_bw_call_status%3A62162",
    );
    expect(out.status).toBe("actueel");
    expect(out.items).toHaveLength(10);
    // 21 + 3 + 10 + 12 + 5 + 12 for the six open and forthcoming statuses.
    expect(out.total).toBe(63);
    expect(out.has_more).toBe(true);
    expect(out.failures).toEqual([]);
    expect(out.per_site[0].connector).toBe(ONDERZOEKSCALL_CONNECTORS.nwo);
    expect(out.params["nwo.page"]).toBe("0");
    expect(out.access_note).toMatch(/toont geen sluitingsdatum/);
    expect(out.access_note).toMatch(/Sluitingsdatum \(eerder-later\)/);
    expect(summarizeOnderzoekscallsSearch(out)).toBe("Calls en subsidierondes (open of binnenkort open) bij NWO: NWO: 63; getoond 10 vanaf offset 0");
  });

  it("maps an offset onto the site's pages of 12", async () => {
    const calls = routedFetch((url) => {
      const page = url.searchParams.get("page") ?? "0";
      return htmlResponse(nwoListingHtml({ cards: nwoCards(`p${page}`), hasNext: page === "0" }));
    });
    const out = await source().search({ organisatie: "nwo", status: "open", offset: 10, limit: 5 });
    expect(calls.map((u) => new URL(u).searchParams.get("page"))).toEqual([null, "1"]);
    expect(out.items.map((x) => x.title)).toEqual(["p0 call 11", "p0 call 12", "p1 call 1", "p1 call 2", "p1 call 3"]);
    expect(out.total).toBe(21 + 3 + 10 + 12);
    expect(out.params["nwo.page"]).toBe("0,1");
  });

  it("counts every leaf status for 'alle' and flags statuses it does not know", async () => {
    const extra = `<li class="facet-item form-item"><input type="checkbox" id="calls-bw-call-status-99999" class="form-checkbox" /><label for="calls-bw-call-status-99999" class="option"><span class="sticky-tail">Uitgesteld <span class="count">2</span></span></label></li>`;
    routedFetch(() =>
      htmlResponse(nwoListingHtml({ cards: [{ href: "/calls/x", title: "Uitgestelde call", status: "Uitgesteld" }], extraFacet: extra })),
    );
    const out = await source().search({ organisatie: "nwo", status: "alle" });
    // 175 + 21 + 3 + 12 + 10 + 12 + 5 + 18 + 2, without the parent "Open calls".
    expect(out.total).toBe(258);
    expect(out.items[0].status).toBeUndefined();
    expect(out.items[0].status_label).toBe("Uitgesteld");
    expect(out.access_note).toMatch(/'Uitgesteld' \(2\)/);
    expect(out.access_note).toMatch(/Onbekend NWO-statuslabel: 'Uitgesteld'/);
  });

  it("leaves the total unknown when the facet is missing", async () => {
    routedFetch(() => htmlResponse(nwoListingHtml({ cards: nwoCards("p0", 3), withFacet: false })));
    const out = await source().search({ organisatie: "nwo" });
    expect(out.total).toBeNull();
    expect(out.has_more).toBe(false);
    expect(out.access_note).toMatch(/totaal is onbekend/);
  });

  it("fails loudly on a page without the card list", async () => {
    routedFetch(() => htmlResponse("<html><body>Onderhoud</body></html>"));
    await expect(source().search({ organisatie: "nwo" })).rejects.toMatchObject({ code: "malformed_response" });
  });
});

describe("OnderzoekscallsSource.search — ZonMw", () => {
  // 30 subsidies for the query: 11 open and 1 expected on page 0, 5 open and 7 closed
  // on page 1 (the first closed one at index 17), 6 closed on page 2.
  const pages: Record<string, ZonmwCardFixture[]> = {
    "0": [...zCards("a", 11, "open"), ...zCards("b", 1, "expected")],
    "1": [...zCards("c", 5, "open"), ...zCards("d", 7, "closed")],
    "2": zCards("e", 6, "closed"),
  };
  const zonmw = () =>
    routedFetch((url) => {
      expect(url.hostname).toBe("www.zonmw.nl");
      expect(url.search).not.toMatch(/f%5B|f\[/);
      expect(url.searchParams.get("sort_bef_combine")).toBe("field_subsidy_date_end_DESC");
      return htmlResponse(zonmwListingHtml({ total: 30, cards: pages[url.searchParams.get("page") ?? "0"] ?? [] }));
    });

  it("reads up to the first closed subsidy and counts what comes before it", async () => {
    const calls = zonmw();
    const out = await source().search({ organisatie: "zonmw", query: "zorginnovatie", limit: 24 });
    expect(calls.map((u) => new URL(u).searchParams.get("page"))).toEqual([null, "1"]);
    expect(new URL(calls[0]).searchParams.get("input")).toBe("zorginnovatie");
    expect(out.total).toBe(17);
    expect(out.items).toHaveLength(17);
    expect(out.items.every((x) => x.status === "open" || x.status === "binnenkort")).toBe(true);
    expect(out.has_more).toBe(false);
    expect(out.params["zonmw.page"]).toBe("0,1");
    expect(out.access_note).toMatch(/robots\.txt/);
  });

  it("stops after one page when that holds the window, leaving the total open", async () => {
    const calls = zonmw();
    const out = await source().search({ organisatie: "zonmw", limit: 5 });
    expect(calls).toHaveLength(1);
    expect(out.items).toHaveLength(5);
    expect(out.total).toBeNull();
    expect(out.has_more).toBe(true);
    expect(summarizeOnderzoekscallsSearch(out)).toContain("ZonMw: 5+");
  });

  it("separates open from expected", async () => {
    zonmw();
    const open = await source().search({ organisatie: "zonmw", status: "open", limit: 24 });
    expect(open.total).toBe(16);
    clearHttpCache();
    const soon = await source().search({ organisatie: "zonmw", status: "binnenkort", limit: 24 });
    expect(soon.total).toBe(1);
    expect(soon.items[0]).toMatchObject({ status: "binnenkort", status_label: "Verwacht" });
  });

  it("pages closed subsidies from the first closed one on", async () => {
    zonmw();
    const first = await source().search({ organisatie: "zonmw", status: "gesloten", limit: 3 });
    expect(first.total).toBe(13);
    expect(first.items.map((x) => x.title)).toEqual(["d subsidie 0", "d subsidie 1", "d subsidie 2"]);
    expect(first.has_more).toBe(true);
    clearHttpCache();
    const calls = zonmw();
    const later = await source().search({ organisatie: "zonmw", status: "gesloten", offset: 8, limit: 5 });
    expect(calls.map((u) => new URL(u).searchParams.get("page"))).toEqual([null, "1", "2"]);
    expect(later.items.map((x) => x.title)).toEqual(["e subsidie 1", "e subsidie 2", "e subsidie 3", "e subsidie 4", "e subsidie 5"]);
    expect(later.has_more).toBe(false);
  });

  it("maps 'alle' straight onto the pages", async () => {
    const calls = zonmw();
    const out = await source().search({ organisatie: "zonmw", status: "alle", offset: 13, limit: 5 });
    expect(calls.map((u) => new URL(u).searchParams.get("page"))).toEqual(["1"]);
    expect(out.total).toBe(30);
    expect(out.items.map((x) => x.title)).toEqual(["c subsidie 1", "c subsidie 2", "c subsidie 3", "c subsidie 4", "d subsidie 0"]);
  });

  it("answers an empty result with a total of 0", async () => {
    routedFetch(() => htmlResponse(zonmwListingHtml({ total: 0, cards: [] })));
    const out = await source().search({ organisatie: "zonmw", query: "cultureel erfgoed" });
    expect(out.total).toBe(0);
    expect(out.items).toEqual([]);
    expect(out.has_more).toBe(false);
  });

  it("notes the sort when zonmw.nl ignores it", async () => {
    routedFetch(() => htmlResponse(zonmwListingHtml({ total: 3, cards: zCards("a", 3, "open"), sort: "title_ASC" })));
    const out = await source().search({ organisatie: "zonmw" });
    expect(out.access_note).toMatch(/sortering is 'Titel A - Z'/);
  });
});

describe("OnderzoekscallsSource.search — both organisations", () => {
  it("reports a failing site and still answers with the other", async () => {
    routedFetch((url) =>
      url.hostname === "www.nwo.nl"
        ? new Response("Forbidden", { status: 403 })
        : htmlResponse(zonmwListingHtml({ total: 2, cards: zCards("a", 2, "open") })),
    );
    const out = await source().search({ organisatie: "alle" });
    expect(out.organisations).toEqual(["nwo", "zonmw"]);
    expect(out.items).toHaveLength(2);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toMatchObject({ organisation: "nwo", connector: "nwo_calls", error_type: "http_error" });
    expect(out.total).toBe(2);
    expect(out.access_note).toMatch(/NWO gaf geen antwoord/);
    expect(summarizeOnderzoekscallsSearch(out)).toMatch(/\(NWO niet bereikbaar\)$/);
  });

  it("throws when no site answers", async () => {
    routedFetch(() => new Response("Forbidden", { status: 403 }));
    await expect(source().search({ organisatie: "alle" })).rejects.toBeInstanceOf(SourceRequestError);
  });

  it("plans the first request per organisation for dryRun", () => {
    const planned = source().planSearch({ query: "waterstof", status: "gesloten", offset: 30 });
    expect(planned.map((p) => p.connector)).toEqual(["nwo_calls", "zonmw_subsidies"]);
    expect(planned[0].url).toContain("page=2");
    expect(planned[0].url).toContain("calls_bw_call_status%3A62165");
    // ZonMw always starts at page 0 to find the first closed subsidy.
    expect(planned[1].url).toBe("https://www.zonmw.nl/nl/subsidies?input=waterstof&sort_bef_combine=field_subsidy_date_end_DESC");
  });
});

describe("OnderzoekscallsSource.get", () => {
  it("reads an NWO call page", async () => {
    const calls = routedFetch(() =>
      htmlResponse(
        nwoCallPageHtml({
          title: "Waterstof en opslag 2026",
          statusAnchors: [{ tid: "62286", label: "Open calls" }, { tid: "1866", label: "Open voor aanvragen" }],
          dates: [{ label: "Sluitingsdatum volledige aanvraag", iso: "2026-10-27T12:00:00Z", text: "27 oktober 2026" }],
          budget: "&euro;480.000",
        }),
      ),
    );
    const out = await source().get({ url: "https://www.nwo.nl/calls/waterstof-2026" });
    expect(calls).toEqual(["https://www.nwo.nl/calls/waterstof-2026"]);
    expect(out).toMatchObject({
      organisation: "nwo",
      status: "open",
      status_label: "Open voor aanvragen",
      deadline: "2026-10-27T12:00:00.000Z",
      budget_eur: 480000,
      truncated: false,
      endpoint: "https://www.nwo.nl/calls/waterstof-2026",
    });
    expect(out.text).toContain("## Waarvoor");
    expect(out.text_chars).toBe(out.text.length);
    expect(summarizeOnderzoekscall(out)).toBe(
      "NWO: Waterstof en opslag 2026 (status 'Open voor aanvragen'; Sluitingsdatum volledige aanvraag: 27 oktober 2026 14:00 uur; budget €480.000)",
    );
    expect(out.access_note).toMatch(/Contactpersonen van de pagina zijn weggelaten/);
    expect(JSON.stringify(out)).not.toContain(CONTACT_NAME);
  });

  it("names an earlier closing date in the summary and access_note", async () => {
    routedFetch(() =>
      htmlResponse(
        nwoCallPageHtml({
          title: "Vroegdiagnostiek 2026",
          statusAnchors: [{ tid: "62286", label: "Open calls" }, { tid: "62163", label: "Open voor intentieverklaring" }],
          dates: [
            { label: "Sluitingsdatum intentieverklaring", iso: "2026-11-17T13:00:00Z", text: "17 november 2026" },
            { label: "Sluitingsdatum volledige aanvraag", iso: "2027-03-30T12:00:00Z", text: "30 maart 2027" },
          ],
        }),
      ),
    );
    const out = await source().get({ url: "https://www.nwo.nl/calls/vroegdiagnostiek" });
    expect(summarizeOnderzoekscall(out)).toContain(
      "eerst Sluitingsdatum intentieverklaring: 17 november 2026 14:00 uur; Sluitingsdatum volledige aanvraag: 30 maart 2027 14:00 uur",
    );
    expect(out.access_note).toContain("De eerstvolgende sluitingsdatum is Sluitingsdatum intentieverklaring (17 november 2026 14:00 uur)");
  });

  it("cuts long text at max_chars and says so", async () => {
    const extraBody = `<p>${"Onderzoek naar cultureel erfgoed en digitalisering. ".repeat(60)}</p>`;
    routedFetch(() => htmlResponse(nwoCallPageHtml({ title: "Erfgoed", statusAnchors: [{ tid: "1868", label: "Doorlopend" }], extraBody })));
    const out = await source().get({ url: "https://www.nwo.nl/calls/erfgoed", max_chars: 600 });
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(602);
    expect(out.text.endsWith(" …")).toBe(true);
    expect(out.text_chars).toBeGreaterThan(600);
    expect(out.access_note).toMatch(/Tekst afgekapt na 600 van \d+ tekens/);
    expect(out.access_note).toMatch(/geen \(eenduidige\) sluitingsdatum/);
  });

  it("takes the ZonMw status from the page's own status block", async () => {
    const calls = routedFetch((url) =>
      url.pathname.includes("entity-date-status")
        ? htmlResponse(zonmwStatusBlockHtml("expected"))
        : htmlResponse(
            zonmwCallPageHtml({ title: "Zorginnovatie in de wijk", nid: "54390", deadline: { iso: "2027-01-28T13:00:00Z", text: "28 januari 2027, 14.00 uur" }, opening: "12 november 2026", perApplication: "€ 30.000,-", metadataStatus: "open" }),
          ),
    );
    const out = await source().get({ url: "https://www.zonmw.nl/nl/subsidie/zorginnovatie-wijk" });
    expect(calls).toEqual(["https://www.zonmw.nl/nl/subsidie/zorginnovatie-wijk", "https://www.zonmw.nl/nl/entity-date-status/54390/full"]);
    expect(out).toMatchObject({ status: "binnenkort", status_label: "Verwacht", status_source: "label", opening_date: "2026-11-12", budget_per_application_eur: 30000 });
    expect(out.params.status_block).toBe("https://www.zonmw.nl/nl/entity-date-status/54390/full");
    expect(out).not.toHaveProperty("statusBlockUrl");
    expect(out).not.toHaveProperty("fullText");
    // A budget per application is a budget: no "no budget" note.
    expect(out.access_note).not.toMatch(/geen budget/);
  });

  it("falls back to the page metadata when the status block fails", async () => {
    routedFetch((url) =>
      url.pathname.includes("entity-date-status")
        ? new Response("Not found", { status: 404 })
        : htmlResponse(zonmwCallPageHtml({ title: "Zorginnovatie", nid: "1", deadline: { iso: "2027-01-28T13:00:00Z", text: "28 januari 2027" }, metadataStatus: "closed" })),
    );
    const out = await source().get({ url: "https://www.zonmw.nl/nl/subsidie/zorginnovatie" });
    expect(out).toMatchObject({ status: "gesloten", status_label: "Gesloten", status_source: "paginagegevens" });
    expect(out.access_note).toMatch(/statusblok van zonmw\.nl was niet te lezen/);
    expect(out.access_note).toMatch(/geen budget/);
  });

  it("refuses other hosts without a request", async () => {
    const calls = routedFetch(() => htmlResponse("<html></html>"));
    await expect(source().get({ url: "https://www.example.org/calls/x" })).rejects.toBeInstanceOf(OnderzoekscallInputError);
    expect(calls).toEqual([]);
  });

  it("refuses a path that is not a call page without a request", async () => {
    const calls = routedFetch(() => htmlResponse("<html></html>"));
    const err = await source().get({ url: "https://www.zonmw.nl/nl/over-zonmw" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnderzoekscallInputError);
    expect(mapOnderzoekscallError(err)).toMatchObject({ error: "unexpected", message: expect.stringMatching(/geen subsidiepagina/) });
    expect(calls).toEqual([]);
  });

  it("refuses a call path whose page has no call layout", async () => {
    routedFetch(() => htmlResponse("<html><body><h1>Pagina verplaatst</h1></body></html>"));
    const err = await source().get({ url: "https://www.zonmw.nl/nl/subsidie/verplaatst" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnderzoekscallInputError);
    expect((err as Error).message).toMatch(/geen titel met kenmerken gevonden/);
  });

  it("spaces the requests to one site by its crawl delay, also when they are sent side by side", async () => {
    const starts: Array<[string, number]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        starts.push([url.hostname, Date.now()]);
        return htmlResponse(nwoCallPageHtml({ title: url.pathname, statusAnchors: [{ tid: "1868", label: "Doorlopend" }] }));
      }),
    );
    const paced = new OnderzoekscallsSource(testConfig, () => NOW, { nwo: 200, zonmw: 0 });
    await Promise.all(["a", "b", "c"].map((slug) => paced.get({ url: `https://www.nwo.nl/calls/${slug}` })));
    const gaps = starts.slice(1).map(([, t], i) => t - starts[i][1]);
    expect(starts).toHaveLength(3);
    // The starts are booked 200 ms apart; the work between a booked start and fetch itself
    // varies a little under load, so the gaps measured at fetch get some slack.
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(150);
    // A cached page goes to no site and waits for nothing.
    const before = Date.now();
    await paced.get({ url: "https://www.nwo.nl/calls/a" });
    expect(starts).toHaveLength(3);
    expect(Date.now() - before).toBeLessThan(150);
  });

  it("maps a missing page to a clear message", async () => {
    routedFetch(() => new Response("Not found", { status: 404 }));
    const err = await source().get({ url: "https://www.nwo.nl/calls/bestaat-niet" }).catch((e: unknown) => e);
    expect(mapOnderzoekscallError(err)).toMatchObject({
      error: "http_error",
      message: "Pagina niet gevonden op nwo.nl (HTTP 404).",
      suggestion: expect.stringMatching(/nl_onderzoek_calls_search/),
    });
  });
});
