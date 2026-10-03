import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { OriSource, oriFailureHint } from "../src/sources/ori.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { SourceRequestError } from "../src/utils/http.js";

const config = loadConfig();
const NOW = new Date("2026-10-03T10:00:00Z");

const ALIASES = {
  ori_heemskerk_20250506181303: { aliases: {} },
  ori_heemskerk_20251120105722: { aliases: { ori_heemskerk: {} } },
  ori_eindhoven_20250413114006: { aliases: { ori_eindhoven: {} } },
  "ori_leidschendam-voorburg_20250424000000": { aliases: { "ori_leidschendam-voorburg": {} } },
  ori_den_haag_20250408204203: { aliases: { ori_den_haag: {} } },
  ori_cuijk_20250407000000: { aliases: { ori_cuijk: {} } },
  ori_groningen_20250415000000: { aliases: { ori_groningen: {} } },
  osi_groningen_20250329063305: { aliases: { osi_groningen: {} } },
  "osi_noord-holland_20250720165905": { aliases: { "osi_noord-holland": {} } },
  "owi_aa-en-maas_20250722063705": { aliases: { "owi_aa-en-maas": {} } },
};

const ORGS = {
  hits: {
    total: { value: 8, relation: "eq" },
    hits: [
      { _index: "ori_eindhoven_20250413114006", _source: { name: "Gemeente Eindhoven", classification: "Municipality" } },
      { _index: "ori_leidschendam-voorburg_20250424000000", _source: { name: "Gemeente Leidschendam-Voorburg", classification: "Municipality" } },
      { _index: "ori_den_haag_20250408204203", _source: { name: "Gemeente Den Haag", classification: "Municipality" } },
      { _index: "ori_cuijk_20250407000000", _source: { name: "Gemeente Cuijk", classification: "Municipality" } },
      { _index: "ori_groningen_20250415000000", _source: { name: "Gemeente Groningen", classification: "Municipality" } },
      { _index: "osi_groningen_20250329063305", _source: { name: "Provincie Groningen", classification: "Municipality" } },
      { _index: "osi_noord-holland_20250720165905", _source: { name: "Provincie Noord-Holland", classification: "Province" } },
      { _index: "owi_aa-en-maas_20250722063705", _source: { name: "Aa en Maas", classification: "Water board" } },
    ],
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function hit(index: string, id: string, source: Record<string, unknown>, highlight?: Record<string, string[]>) {
  return { _index: index, _id: id, _source: { "@id": id, ...source }, ...(highlight ? { highlight } : {}) };
}

function searchResponse(hits: unknown[], total: { value: number; relation: string } = { value: hits.length, relation: "eq" }, extra: Record<string, unknown> = {}) {
  return { took: 5, timed_out: false, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 }, hits: { total, hits }, ...extra };
}

interface Call {
  url: URL;
  method: string;
  body?: Record<string, unknown>;
  redirect?: string;
}

type Handler = (call: Call) => Response | Promise<Response>;

/**
 * Routes every request the ORI source makes: the index list, the organisation
 * names, the freshness aggregation, the attachment lookup (which also brings
 * the meetings of agenda items), the index probe of the no-index-list
 * fallback, the check of a meeting page (HEAD), the meeting lookup in a
 * council information system's own API (GET on another host), and the search
 * itself.
 */
function mockOri(handlers: { search: Handler; aliases?: Handler; orgs?: Handler; freshness?: Handler; attachments?: Handler; probe?: Handler; page?: Handler; api?: Handler }) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      redirect: init?.redirect,
    };
    calls.push(call);
    if (call.method === "HEAD") return handlers.page ? handlers.page(call) : new Response(null, { status: 404 });
    if (call.url.hostname !== "api.openraadsinformatie.nl") return handlers.api ? handlers.api(call) : new Response(null, { status: 404 });
    const body = call.body as Record<string, any> | undefined;
    if (call.url.pathname.endsWith("/_aliases")) return handlers.aliases ? handlers.aliases(call) : json(ALIASES);
    if (JSON.stringify(body?.query ?? "").includes('"Organization"')) return handlers.orgs ? handlers.orgs(call) : json(ORGS);
    if (body?.aggs?.newest) {
      return handlers.freshness
        ? handlers.freshness(call)
        : json({ ...searchResponse([]), aggregations: { newest: { value: Date.parse("2026-09-25T19:00:00Z") } } });
    }
    if (body?.query?.ids) return handlers.attachments ? handlers.attachments(call) : json(searchResponse([]));
    if (body?.aggs?.indices) return handlers.probe ? handlers.probe(call) : json(searchResponse([]));
    return handlers.search(call);
  });
  vi.stubGlobal("fetch", fetchMock);
  const searchCalls = () => calls.filter((c) => c.body && "highlight" in c.body);
  return { calls, searchCalls };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  clearHttpCache();
});

afterEach(() => {
  vi.useRealTimers();
});

const AGENDA_ITEM = hit("ori_eindhoven_20250413114006", "7900101", {
  "@type": "AgendaItem",
  name: "412 Uitvoerings- en beleidskader parkeren en mobiliteit",
  last_discussed_at: "2026-07-07T09:30:00+02:00",
  attachment: ["7900104", "7900105"],
});
const DOCUMENT = hit(
  "ori_eindhoven_20250413114006",
  "7700412",
  {
    "@type": "MediaObject",
    name: "Commissieadvies Rekenkamerrapport",
    url: "https://api.openraadsinformatie.nl/v1/resolve/api.notubiz.nl/document/16600412",
    original_url: "https://api.notubiz.nl/document/16600412/1",
    last_discussed_at: "2026-03-10T19:00:00+01:00",
    size_in_bytes: 103125,
  },
  { text: ["Het Rekenkamerrapport over het parkeerbeleid is behandeld"] },
);

describe("OriSource.search — scope", () => {
  it("searches the index ORI actually has for a hyphenated name, through its alias", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([hit("ori_leidschendam-voorburg_20250424000000", "1", { "@type": "MediaObject", name: "Parkeerbeleid", url: "https://x.example/1", last_discussed_at: "2025-12-09T19:30:00+00:00" })])) });

    const out = await new OriSource(config).search({ query: "parkeren", rows: 5, gemeente: "Leidschendam-Voorburg" });

    const call = searchCalls()[0];
    expect(call.url.pathname).toBe("/v1/elastic/ori_leidschendam-voorburg/_search");
    expect(call.url.searchParams.get("ignore_unavailable")).toBe("true");
    expect(out.items[0].organization).toBe("Leidschendam-Voorburg");
    expect(out.scope_label).toBe("Leidschendam-Voorburg");
    expect(out.no_index).toBeUndefined();
  });

  it("says plainly that a municipality has no ORI index, and does not search", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([])) });

    const out = await new OriSource(config).search({ query: "parkeren", rows: 5, gemeente: "Land van Cuijk" });

    expect(searchCalls()).toHaveLength(0);
    expect(out.no_index).toBe(true);
    expect(out.items).toEqual([]);
    expect(out.total).toBeNull();
    expect(out.access_note).toContain("ORI heeft geen index voor 'Land van Cuijk'");
    expect(out.access_note).toContain("Cuijk");
    expect(out.access_note).not.toContain("Controleer de gemeentenaam");
  });

  it("turns bestuurslaag into an index filter instead of a query word", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([])) });

    await new OriSource(config).search({ query: "parkeren", rows: 5, bestuurslaag: "provincie" });

    const call = searchCalls()[0];
    expect(call.url.pathname).toBe("/v1/elastic/osi_*/_search");
    expect(JSON.stringify(call.body)).not.toContain("provincie");
  });

  it("combines gemeente and bestuurslaag", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([])) });

    const out = await new OriSource(config).search({ query: "parkeren", rows: 5, gemeente: "Groningen", bestuurslaag: "provincie" });

    expect(searchCalls()[0].url.pathname).toBe("/v1/elastic/osi_groningen/_search");
    expect(out.scope_label).toBe("Provincie Groningen");
  });

  it("reports a bestuurslaag ORI does not have and leaves the query untouched", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([])) });

    const out = await new OriSource(config).search({ query: "parkeren", rows: 5, bestuurslaag: "rijk" });

    const call = searchCalls()[0];
    expect(call.url.pathname).toBe("/v1/elastic/_search");
    expect(JSON.stringify(call.body)).not.toContain("rijk");
    expect(out.access_note).toContain("bestuurslaag 'rijk' is niet toegepast");
  });

  it("falls back to exact index names when the index list cannot be loaded", async () => {
    const { searchCalls } = mockOri({
      aliases: () => json({ error: "down" }, 404),
      search: () => json(searchResponse([hit("ori_den_haag_20250408204203", "2", { "@type": "MediaObject", name: "Stuk", url: "https://x.example/2" })])),
    });

    const out = await new OriSource(config).search({ query: "parkeren", rows: 5, gemeente: "Den Haag" });

    const path = decodeURIComponent(searchCalls()[0].url.pathname);
    expect(path).toContain("ori_den_haag_2*");
    // Bounded to the exact slug plus its timestamp, never a prefix like ori_den_haag*.
    expect(path).not.toMatch(/ori_den_haag\*/);
    expect(path).not.toContain("osi_");
    expect(out.items[0].organization).toBe("Den Haag");
    expect(out.access_note).toContain("indexlijst kon niet worden geladen");
  });

  it("keeps the layer of a type word when the index list cannot be loaded", async () => {
    const { searchCalls, calls } = mockOri({
      aliases: () => json({ error: "down" }, 503),
      search: () => json(searchResponse([hit("osi_provincie-utrecht_20250405180703", "3", { "@type": "MediaObject", name: "Statenstuk", url: "https://x.example/3" })])),
    });

    const out = await new OriSource(config).search({ query: "mobiliteit", rows: 5, gemeente: "Provincie Utrecht" });

    const path = decodeURIComponent(searchCalls()[0].url.pathname);
    expect(path).toContain("osi_provincie-utrecht_2*");
    expect(path).not.toContain("ori_");
    expect(path).not.toContain("owi_");
    // The type word decides; no probe needed.
    expect(calls.some((c) => (c.body as Record<string, any> | undefined)?.aggs?.indices)).toBe(false);
    expect(out.params.bestuurslaag).toBe("provincie");
    expect(out.scope_label).toBe("Provincie Utrecht");
  });

  it("searches a bare name as gemeente first when the index list cannot be loaded, and names the other layer", async () => {
    const { searchCalls } = mockOri({
      aliases: () => json({ error: "down" }, 503),
      probe: () =>
        json({ ...searchResponse([]), aggregations: { indices: { buckets: [{ key: "osi_groningen_20250329063305", doc_count: 9 }, { key: "ori_groningen_20250329064314", doc_count: 9 }] } } }),
      search: () => json(searchResponse([])),
    });

    const out = await new OriSource(config).search({ query: "mobiliteit", rows: 5, gemeente: "Groningen" });

    expect(decodeURIComponent(searchCalls()[0].url.pathname)).toBe("/v1/elastic/ori_groningen_20250329064314/_search");
    expect(out.params.bestuurslaag).toBe("gemeente");
    expect(out.access_note).toContain("'Groningen' is gezocht als gemeente; ORI heeft ook Provincie Groningen");
  });

  it("finds a bare province name without the index list", async () => {
    const { searchCalls } = mockOri({
      aliases: () => json({ error: "down" }, 503),
      probe: () => json({ ...searchResponse([]), aggregations: { indices: { buckets: [{ key: "osi_noord-holland_20250720165905", doc_count: 9 }] } } }),
      search: () => json(searchResponse([])),
    });

    const out = await new OriSource(config).search({ query: "mobiliteit", rows: 5, gemeente: "Noord-Holland" });

    expect(decodeURIComponent(searchCalls()[0].url.pathname)).toBe("/v1/elastic/osi_noord-holland_20250720165905/_search");
    expect(out.scope_label).toBe("Provincie Noord-Holland");
    expect(out.params.bestuurslaag).toBe("provincie");
  });

  it("searches both copies of a re-ingested index and says so", async () => {
    const { searchCalls } = mockOri({
      search: () =>
        json(
          searchResponse([
            hit("ori_heemskerk_20250506181303", "4066594", { "@type": "Meeting", name: "Raadsbrede Commissie", last_discussed_at: "2023-03-29T20:00:00+00:00" }),
            hit("ori_heemskerk_20251120105722", "7434319", { "@type": "Meeting", name: "Commissievergadering ABV", last_discussed_at: "2016-03-15T20:30:00+01:00" }),
          ]),
        ),
    });

    const out = await new OriSource(config).search({ query: "begroting", rows: 5, gemeente: "Heemskerk" });

    expect(decodeURIComponent(searchCalls()[0].url.pathname)).toBe("/v1/elastic/ori_heemskerk,ori_heemskerk_20250506181303/_search");
    expect(out.items[0].url).toBe("https://api.openraadsinformatie.nl/v1/elastic/ori_heemskerk_20250506181303/_doc/4066594");
    expect(out.items[1].url).toBe("https://api.openraadsinformatie.nl/v1/elastic/ori_heemskerk/_doc/7434319");
    expect(out.access_note).toContain("oudere index zonder alias (ori_heemskerk_20250506181303)");
  });

  it("reports an empty shard set as a missing index, not as zero results", async () => {
    mockOri({
      aliases: () => json({ error: "down" }, 404),
      search: () => json({ ...searchResponse([]), _shards: { total: 0, successful: 0, skipped: 0, failed: 0 } }),
    });

    const out = await new OriSource(config).search({ query: "parkeren", rows: 5, gemeente: "Nergenshuizen" });

    expect(out.no_index).toBe(true);
    expect(out.access_note).toContain("geen (bereikbare) index");
  });
});

describe("OriSource.search — request", () => {
  it("asks for every term, only the small fields, and a highlighted snippet", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([])) });

    await new OriSource(config).search({ query: "sociale woningbouw", rows: 20, gemeente: "Eindhoven" });

    const body = searchCalls()[0].body as Record<string, any>;
    expect(body.query.bool.must[0].query_string).toEqual({ query: "sociale woningbouw", default_operator: "AND" });
    expect(body._source).not.toContain("text");
    expect(body._source).not.toContain("text_pages");
    expect(body._source).toContain("original_url");
    expect(body.highlight.fields.text).toBeDefined();
    expect(body.size).toBe(40);
    expect(body.sort).toBeUndefined();
  });

  it("matches any term when asked", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([])) });

    await new OriSource(config).search({ query: "sociale woningbouw", rows: 20, match: "any" });

    expect((searchCalls()[0].body as Record<string, any>).query.bool.must[0].query_string.default_operator).toBe("OR");
  });

  it("sorts on a real date field server-side and leaves out dates after today", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([])) });

    const out = await new OriSource(config).search({ query: "motie", rows: 10, gemeente: "Eindhoven", sort: "date_newest" });

    const body = searchCalls()[0].body as Record<string, any>;
    expect(body.sort[0]).toEqual({ _score: { order: "desc" } });
    expect(body.sort[1]).toEqual({ last_discussed_at: { order: "desc", unmapped_type: "date" } });
    expect(JSON.stringify(body)).not.toContain("datePublished");
    const inner = body.query.function_score.query.bool;
    expect(inner.must[0].query_string.query).toBe("motie");
    const range = inner.filter[0].bool.should[0].range.last_discussed_at;
    expect(range).toMatchObject({ lte: "now/d", format: "strict_date_optional_time", time_zone: "Europe/Amsterdam" });
    expect(out.params.date_to).toBe("vandaag");
    expect(out.access_note).toContain("Gesorteerd op vergaderdatum");
    expect(out.access_note).toContain("na vandaag");
  });

  it("puts documents dated by an iBabs report list after records with a meeting date", async () => {
    const { searchCalls } = mockOri({
      search: () =>
        json(
          searchResponse([
            hit("ori_eindhoven_20250413114006", "1", { "@type": "MediaObject", name: "Raadsvoorstel", url: "https://api.openraadsinformatie.nl/v1/resolve/ibabs/agenda_item/1", last_discussed_at: "2026-07-09T19:00:00+00:00" }),
            hit("ori_eindhoven_20250413114006", "2", { "@type": "MediaObject", name: "Motie ParkStart", url: "https://api.openraadsinformatie.nl/v1/resolve/ibabs/report/2", last_discussed_at: "2026-09-30T00:00:00+02:00" }),
          ]),
        ),
    });

    const out = await new OriSource(config).search({ query: "begroting", rows: 10, sort: "date_newest" });

    const scoring = (searchCalls()[0].body as Record<string, any>).query.function_score;
    // Every record scores 2, a report-list document 1; _score leads the sort.
    expect(scoring.functions).toEqual([
      { filter: { bool: { must_not: [{ prefix: { url: "https://api.openraadsinformatie.nl/v1/resolve/ibabs/report/" } }] } }, weight: 2 },
    ]);
    expect(scoring.boost_mode).toBe("replace");
    expect(out.items[1].date_type).toBe("lijstdatum (iBabs-rapportlijst)");
    expect(out.access_note).toContain("stukken uit iBabs-rapportlijsten");
  });

  it("explains a list date in a relevance search", async () => {
    mockOri({
      search: () =>
        json(searchResponse([hit("ori_eindhoven_20250413114006", "2", { "@type": "MediaObject", name: "Motie ParkStart", url: "https://api.openraadsinformatie.nl/v1/resolve/ibabs/report/2", last_discussed_at: "2026-09-30T00:00:00+02:00" })])),
    });

    const out = await new OriSource(config).search({ query: "parkstart", rows: 10, gemeente: "Eindhoven" });

    expect(out.items[0].date_type).toBe("lijstdatum (iBabs-rapportlijst)");
    expect(out.access_note).toContain("geen vergaderdatum");
  });

  it("keeps a lowercase or/and/not a search word, quoted, and says how it read one between terms", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([])) });

    // nl_gov_ask keeps the acronym OR (ondernemingsraad) as the topic word "or".
    const out = await new OriSource(config).search({ query: "instemming or reorganisatie", rows: 5, gemeente: "Eindhoven" });

    expect((searchCalls()[0].body as Record<string, any>).query.bool.must[0].query_string).toEqual({ query: 'instemming "or" reorganisatie', default_operator: "AND" });
    expect(out.params.q).toBe('instemming "or" reorganisatie');
    expect(out.access_note).toContain("'or' tussen zoektermen is als zoekwoord gezocht");
    expect(out.access_note).toContain("OR, AND of NOT in hoofdletters");
  });

  it("still reads uppercase OR/AND/NOT as operators, without a note", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([])) });

    const out = await new OriSource(config).search({ query: "parkeren OR fietsen NOT stikstof", rows: 5, gemeente: "Eindhoven" });

    expect((searchCalls()[0].body as Record<string, any>).query.bool.must[0].query_string.query).toBe("parkeren OR fietsen NOT stikstof");
    expect(out.access_note ?? "").not.toContain("zoekwoord gezocht");
  });

  it("quotes a lowercase operator word at the edge without a note", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([])) });

    const out = await new OriSource(config).search({ query: "or personeelsbeleid", rows: 5, gemeente: "Eindhoven" });

    expect((searchCalls()[0].body as Record<string, any>).query.bool.must[0].query_string.query).toBe('"or" personeelsbeleid');
    expect(out.access_note ?? "").not.toContain("zoekwoord gezocht");
  });

  it("applies date_from/date_to as a real range on meeting date, and start_date for reports", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([])) });

    const out = await new OriSource(config).search({ query: "parkeren", rows: 5, gemeente: "Eindhoven", date_from: "2026-07-08", date_to: "2026-07-31" });

    const should = (searchCalls()[0].body as Record<string, any>).query.bool.filter[0].bool.should;
    expect(should[0].range.last_discussed_at).toMatchObject({ gte: "2026-07-08||/d", lte: "2026-07-31||/d" });
    expect(should[1].bool.must_not[0].exists.field).toBe("last_discussed_at");
    expect(should[1].bool.filter[0].range.start_date).toMatchObject({ gte: "2026-07-08||/d", lte: "2026-07-31||/d" });
    expect(out.params.date_from).toBe("2026-07-08");
    expect(out.access_note).toContain("Het datumfilter werkt op de vergaderdatum");
  });

  it("does not search when date_from lies after date_to", async () => {
    const { calls } = mockOri({ search: () => json(searchResponse([])) });

    const out = await new OriSource(config).search({ query: "parkeren", rows: 5, date_from: "2026-08-01", date_to: "2026-07-01" });

    expect(calls).toHaveLength(0);
    expect(out.access_note).toContain("ligt na date_to");
  });

  it("retries once as simple_query_string when ORI rejects the syntax", async () => {
    let attempt = 0;
    const { searchCalls } = mockOri({
      search: () => (++attempt === 1 ? json({ error: "parse" }, 400) : json(searchResponse([DOCUMENT]))),
    });

    const out = await new OriSource(config).search({ query: "NOT NOT parkeren", rows: 5, gemeente: "Eindhoven" });

    const second = searchCalls()[1].body as Record<string, any>;
    expect(second.query.bool.must[0].simple_query_string.query).toBe("NOT NOT parkeren");
    expect(out.items).toHaveLength(1);
    expect(out.access_note).toContain("eenvoudige zoekterm");
  });
});

describe("OriSource.search — honest failures", () => {
  it("throws on an upstream error instead of returning a fake empty result", async () => {
    mockOri({ search: () => json({ error: "unavailable" }, 503) });

    await expect(new OriSource(config).search({ query: "parkeren", rows: 200, gemeente: "Den Haag", sort: "date_newest" })).rejects.toBeInstanceOf(SourceRequestError);
  });

  it("explains timeouts and oversized answers as failures, not as empty results", () => {
    const timeout = new SourceRequestError({ message: "Source timeout after 20000ms", endpoint: "x", code: "timeout" });
    const oversize = new SourceRequestError({ message: "Response body exceeded 12582912 bytes", endpoint: "x", code: "malformed_response" });
    expect(oriFailureHint(timeout)).toContain("geen leeg resultaat");
    expect(oriFailureHint(oversize)).toContain("groter dan 12 MB");
    expect(oriFailureHint(new Error("x"))).toBeUndefined();
  });

  it("reports failed shards and server-side timeouts as incomplete results", async () => {
    mockOri({
      search: () => json({ ...searchResponse([DOCUMENT]), timed_out: true, _shards: { total: 331, successful: 329, skipped: 0, failed: 2 } }),
    });

    const out = await new OriSource(config).search({ query: "parkeren", rows: 5 });

    expect(out.items).toHaveLength(1);
    expect(out.access_note).toContain("2 van 331 ORI-indexen gaven een fout");
    expect(out.access_note).toContain("onvolledig");
  });

  it("gives a genuine empty result without blaming the municipality name", async () => {
    mockOri({ search: () => json(searchResponse([])) });

    const out = await new OriSource(config).search({ query: "sociale woningbouw", rows: 5, gemeente: "Eindhoven" });

    expect(out.total).toBe(0);
    expect(out.access_note).toContain("Geen ORI-resultaten voor 'sociale woningbouw' in Eindhoven");
    expect(out.access_note).toContain("match='any'");
    expect(out.access_note).not.toContain("Controleer de gemeentenaam");
  });
});

describe("OriSource.search — totals, freshness, records", () => {
  it("reports a capped total as a lower bound and does not advise a gemeente that is already set", async () => {
    mockOri({ search: () => json(searchResponse([DOCUMENT], { value: 10000, relation: "gte" })) });

    const out = await new OriSource(config).search({ query: "raad", rows: 5, gemeente: "Eindhoven" });

    expect(out.total).toBeNull();
    expect(out.total_lower_bound).toBe(10000);
    expect(out.access_note).toContain("ORI telt niet verder dan 10000 treffers");
    expect(out.access_note).not.toContain("'gemeente'");
  });

  it("warns when the newest meeting in the searched index is old", async () => {
    mockOri({
      search: () => json(searchResponse([DOCUMENT])),
      freshness: () => json({ ...searchResponse([]), aggregations: { newest: { value: Date.parse("2026-07-08T07:30:00Z") } } }),
    });

    const out = await new OriSource(config).search({ query: "parkeren", rows: 5, gemeente: "Eindhoven" });

    expect(out.access_note).toContain("de nieuwste vergadering in ORI voor Eindhoven is van 8 juli 2026 (87 dagen geleden)");
  });

  it("keeps quiet about freshness for a current index, and survives a failed freshness check", async () => {
    mockOri({ search: () => json(searchResponse([DOCUMENT])) });
    const fresh = await new OriSource(config).search({ query: "parkeren", rows: 5, gemeente: "Eindhoven" });
    expect(fresh.access_note ?? "").not.toContain("loopt achter");

    clearHttpCache();
    mockOri({ search: () => json(searchResponse([DOCUMENT])), freshness: () => json({ error: "x" }, 400) });
    const out = await new OriSource(config).search({ query: "parkeren", rows: 5, gemeente: "Eindhoven" });
    expect(out.items).toHaveLength(1);
    expect(out.access_note ?? "").not.toContain("loopt achter");
  });

  it("links documents to their file and agenda items to their ORI record plus their attachments", async () => {
    mockOri({
      search: () => json(searchResponse([AGENDA_ITEM, DOCUMENT])),
      attachments: (call) => {
        expect((call.body as Record<string, any>).query.ids.values).toEqual(["7900104", "7900105"]);
        return json(searchResponse([hit("ori_eindhoven_20250413114006", "7900104", { name: "Raadsvoorstel parkeren", url: "https://api.openraadsinformatie.nl/v1/resolve/api.notubiz.nl/document/1" })]));
      },
    });

    const out = await new OriSource(config).search({ query: "beleidskader parkeren", rows: 5, gemeente: "Eindhoven" });

    const [agenda, doc] = out.items;
    expect(agenda.url).toBe("https://api.openraadsinformatie.nl/v1/elastic/ori_eindhoven/_doc/7900101");
    expect(agenda.link_type).toBe("ori_record");
    expect(agenda.attachments).toEqual([{ id: "7900104", name: "Raadsvoorstel parkeren", url: "https://api.openraadsinformatie.nl/v1/resolve/api.notubiz.nl/document/1" }]);
    expect(doc.url).toBe("https://api.openraadsinformatie.nl/v1/resolve/api.notubiz.nl/document/16600412");
    expect(doc.link_type).toBe("document");
    expect(out.items.every((x) => x.url !== "https://www.openraadsinformatie.nl")).toBe(true);
  });

  it("gives a report the link of its document", async () => {
    mockOri({
      search: () => json(searchResponse([hit("ori_eindhoven_20250413114006", "5958644", { "@type": "Report", name: "Schriftelijke vragen", start_date: "2024-12-16T00:00:00+01:00", attachment: "5958645" })])),
      attachments: () => json(searchResponse([hit("ori_eindhoven_20250413114006", "5958645", { name: "Vragen VVD", url: "https://api.openraadsinformatie.nl/v1/resolve/ibabs/report/20b2" })])),
    });

    const out = await new OriSource(config).search({ query: "vragen", rows: 5, gemeente: "Eindhoven" });

    expect(out.items[0].url).toBe("https://api.openraadsinformatie.nl/v1/resolve/ibabs/report/20b2");
    expect(out.items[0].link_type).toBe("document");
  });

  it("links attachments of hosts with a broken ORI resolver to the source system", async () => {
    mockOri({
      search: () => json(searchResponse([AGENDA_ITEM])),
      attachments: () =>
        json(
          searchResponse([
            hit("ori_eindhoven_20250413114006", "7900104", {
              name: "Nieuwsbrief",
              url: "https://api.openraadsinformatie.nl/v1/resolve/raad.hardinxveld-giessendam.nl/api/v1/meetings/1126/documents/33692",
              original_url: "http://raad.hardinxveld-giessendam.nl/api/v1/meetings/1126/documents/33692",
            }),
          ]),
        ),
    });

    const out = await new OriSource(config).search({ query: "beleidskader", rows: 5, gemeente: "Eindhoven" });

    expect(out.items[0].attachments).toEqual([{ id: "7900104", name: "Nieuwsbrief", url: "https://raad.hardinxveld-giessendam.nl/api/v1/meetings/1126/documents/33692" }]);
  });

  it("links attachments with a dead '//' resolve path to the source system and keeps original_url as fallback on the rest", async () => {
    mockOri({
      search: () => json(searchResponse([AGENDA_ITEM])),
      attachments: () =>
        json(
          searchResponse([
            hit("ori_dronten_20250328165903", "7900104", {
              name: "Jaarrekening 2023",
              url: "https://api.openraadsinformatie.nl/v1/resolve/gemeenteraad.dronten.nl/api//v1/meetings/1002/documents/1899",
              original_url: "https://gemeenteraad.dronten.nl/api//v1/meetings/1002/documents/1899",
            }),
            hit("ori_dronten_20250328165903", "7900105", {
              name: "Raadsvoorstel",
              url: "https://api.openraadsinformatie.nl/v1/resolve/gemeenteraad.dronten.nl/api/v1/meetings/1406/documents/22158",
              original_url: "https://gemeenteraad.dronten.nl/api/v1/meetings/1406/documents/22158",
            }),
          ]),
        ),
    });

    const out = await new OriSource(config).search({ query: "beleidskader", rows: 5, gemeente: "Eindhoven" });

    expect(out.items[0].attachments).toEqual([
      { id: "7900104", name: "Jaarrekening 2023", url: "https://gemeenteraad.dronten.nl/api//v1/meetings/1002/documents/1899" },
      {
        id: "7900105",
        name: "Raadsvoorstel",
        url: "https://api.openraadsinformatie.nl/v1/resolve/gemeenteraad.dronten.nl/api/v1/meetings/1406/documents/22158",
        original_url: "https://gemeenteraad.dronten.nl/api/v1/meetings/1406/documents/22158",
      },
    ]);
  });

  it("gives a report the fallback link of its document too", async () => {
    mockOri({
      search: () => json(searchResponse([hit("ori_eindhoven_20250413114006", "5958644", { "@type": "Report", name: "Schriftelijke vragen", start_date: "2024-12-16T00:00:00+01:00", attachment: "5958645" })])),
      attachments: () =>
        json(searchResponse([hit("ori_eindhoven_20250413114006", "5958645", { name: "Vragen VVD", url: "https://api.openraadsinformatie.nl/v1/resolve/ibabs/report/20b2", original_url: "https://api1.ibabs.eu/publicdownload.aspx?site=eindhoven&id=20b2" })])),
    });

    const out = await new OriSource(config).search({ query: "vragen", rows: 5, gemeente: "Eindhoven" });

    expect(out.items[0].url).toBe("https://api.openraadsinformatie.nl/v1/resolve/ibabs/report/20b2");
    expect(out.items[0].original_url).toBe("https://api1.ibabs.eu/publicdownload.aspx?site=eindhoven&id=20b2");
  });

  it("keeps the search when the attachment lookup fails", async () => {
    mockOri({ search: () => json(searchResponse([AGENDA_ITEM])), attachments: () => json({ error: "x" }, 400) });

    const out = await new OriSource(config).search({ query: "beleidskader", rows: 5, gemeente: "Eindhoven" });

    expect(out.items[0].link_type).toBe("ori_record");
    expect(out.access_note).toContain("bijlagen");
  });

  it("merges duplicates of one source document and still fills the page", async () => {
    const copy = (id: string, date: string) =>
      hit("ori_eindhoven_20250413114006", id, { "@type": "MediaObject", name: "Parkeeragenda 2025-2026.pdf", url: `https://api.openraadsinformatie.nl/v1/resolve/${id}`, original_url: `https://api.notubiz.nl/document/${id}/1`, size_in_bytes: 4242, last_discussed_at: date });
    mockOri({
      search: () =>
        json(
          searchResponse([
            copy("1", "2026-02-01T19:00:00+01:00"),
            copy("2", "2026-03-01T19:00:00+01:00"),
            copy("3", "2026-04-01T19:00:00+01:00"),
            DOCUMENT,
          ]),
        ),
    });

    const out = await new OriSource(config).search({ query: "parkeeragenda", rows: 2, gemeente: "Eindhoven" });

    expect(out.items.map((x) => x.id)).toEqual(["1", "7700412"]);
    expect(out.items[0].duplicate_ids).toEqual(["2", "3"]);
    expect(out.access_note).toContain("2 dubbele record(s)");
  });

  it("keeps one letter received by several councils as one record per council in a national search", async () => {
    const letter = (index: string, id: string) =>
      hit(index, id, { "@type": "MediaObject", name: "20260701-ledenbrief-loga-inclusief-voorbeeldreglement", url: `https://api.openraadsinformatie.nl/v1/resolve/ibabs/report/${id}`, size_in_bytes: 250404, last_discussed_at: "2026-07-06T00:00:00+02:00" });
    mockOri({ search: () => json(searchResponse([letter("ori_eindhoven_20250413114006", "7948000"), letter("ori_den_haag_20250408204203", "7948134"), letter("ori_cuijk_20250407000000", "7947122")])) });

    const out = await new OriSource(config).search({ query: "ledenbrief", rows: 10 });

    expect(out.items.map((x) => x.organization)).toEqual(["Eindhoven", "Den Haag", "Cuijk"]);
    expect(out.items.every((x) => x.duplicate_ids === undefined)).toBe(true);
    expect(out.access_note ?? "").not.toContain("samengevoegd");
  });
});

describe("OriSource.search — index list availability", () => {
  it("does not hold up a search without gemeente for an index list that hangs", async () => {
    let releaseAliases: (r: Response) => void = () => {};
    mockOri({
      aliases: () => new Promise<Response>((resolve) => (releaseAliases = resolve)),
      search: () => json(searchResponse([hit("ori_bodegraven-reeuwijk_20250101000000", "1", { "@type": "MediaObject", name: "Stuk", url: "https://x.example/1" })])),
    });

    const started = performance.now();
    const out = await new OriSource(config).search({ query: "afvalinzameling", rows: 5 });
    const elapsed = performance.now() - started;
    releaseAliases(json({ error: "late" }, 503));

    // The catalogue would take its full timeout; the search waits at most the grace period.
    expect(elapsed).toBeLessThan(4_000);
    expect(out.items[0].organization).toBe("Bodegraven-Reeuwijk");
  });

  it("names hits from the index list when it loads in time", async () => {
    mockOri({ search: () => json(searchResponse([hit("osi_groningen_20250329063305", "1", { "@type": "MediaObject", name: "Stuk", url: "https://x.example/1" })])) });

    const out = await new OriSource(config).search({ query: "afvalinzameling", rows: 5 });

    expect(out.items[0].organization).toBe("Provincie Groningen");
  });

  it("asks for the index list once, without retries, and not again for a while after a failure", async () => {
    const { calls } = mockOri({ aliases: () => json({ error: "down" }, 503), search: () => json(searchResponse([])) });
    const ori = new OriSource(config);

    await ori.search({ query: "parkeren", rows: 5, gemeente: "Eindhoven" });
    await ori.search({ query: "parkeren", rows: 5, gemeente: "Eindhoven" });

    expect(calls.filter((c) => c.url.pathname.endsWith("/_aliases"))).toHaveLength(1);
  });
});

describe("OriSource.search — meeting pages", () => {
  const MEETING_GUID = "0a1b2c3d-0000-4000-8000-000000000001";
  const ITEM_GUID = "0a1b2c3d-0000-4000-8000-0000000000a1";
  const IBABS_USED = "https://api.openraadsinformatie.nl/v1/resolve/ibabs/GetMeetingsByDateRange/Sitename%3DNoord-holland/StartDate%3D2026-06-09T00%3A00%3A00/EndDate%3D2026-06-11T00%3A00%3A00";
  const IBABS_PAGE = `https://noordholland.bestuurlijkeinformatie.nl/Agenda/Index/${MEETING_GUID}`;
  const provenance = (system: string, kind: string, fields: Record<string, string>) => ({
    was_generated_by: { same_as: `https://openbesluitvorming.nl/voc/mapping/x/${system}/${kind}/1`, ...fields },
  });
  const html = (status = 200) => new Response(null, { status, headers: { "content-type": "text/html; charset=utf-8" } });
  const heads = (calls: Call[]) => calls.filter((c) => c.method === "HEAD").map((c) => c.url.href);

  const ibabsMeeting = (id = "8100001", guid = MEETING_GUID) =>
    hit("osi_noord-holland_20250720165905", id, {
      "@type": "Meeting",
      name: "Statencommissie Mobiliteit",
      last_discussed_at: "2026-06-10T13:00:00+00:00",
      ...provenance("ibabs", "meeting", { original_identifier: guid, used: IBABS_USED }),
    });

  it("links a meeting to its checked page in the council information system and keeps the ORI record", async () => {
    const { calls } = mockOri({ search: () => json(searchResponse([ibabsMeeting()])), page: () => html() });

    const out = await new OriSource(config).search({ query: "fietspaden", rows: 5, gemeente: "Provincie Noord-Holland" });

    const meeting = out.items[0];
    expect(meeting.url).toBe(IBABS_PAGE);
    expect(meeting.link_type).toBe("meeting_page");
    expect(meeting.source_system).toBe("iBabs");
    expect(meeting.ori_record_url).toBe("https://api.openraadsinformatie.nl/v1/elastic/osi_noord-holland/_doc/8100001");
    expect(meeting.link_note).toContain("Vergaderpagina in iBabs");
    // Checked without following redirects: a removed meeting redirects to an empty page or a list.
    const head = calls.find((c) => c.method === "HEAD");
    expect(head?.url.href).toBe(IBABS_PAGE);
    expect(head?.redirect).toBe("manual");
  });

  it("keeps the ORI record, and says why, when the page does not work", async () => {
    const cases: Array<[() => Response, string]> = [
      [() => html(403), "HTTP 403"],
      [() => new Response(null, { status: 303, headers: { location: "https://elders.example/" } }), "HTTP 303, doorverwezen"],
      [() => new Response(null, { status: 200, headers: { "content-type": "application/json" } }), "geen HTML-pagina"],
    ];
    for (const [response, reason] of cases) {
      clearHttpCache();
      mockOri({ search: () => json(searchResponse([ibabsMeeting()])), page: response });

      const out = await new OriSource(config).search({ query: "fietspaden", rows: 5, gemeente: "Provincie Noord-Holland" });

      expect(out.items[0].url).toBe("https://api.openraadsinformatie.nl/v1/elastic/osi_noord-holland/_doc/8100001");
      expect(out.items[0].link_type).toBe("ori_record");
      expect(out.items[0].source_system).toBe("iBabs");
      expect(out.items[0].link_note).toContain(`De vergaderpagina in iBabs werkt niet (${reason})`);
      expect(out.items[0].link_note).toContain("JSON uit de ORI-API, geen webpagina");
      expect(out.items[0].ori_record_url).toBeUndefined();
    }
  });

  it("treats a page whose connection fails as not working", async () => {
    mockOri({ search: () => json(searchResponse([ibabsMeeting()])), page: () => Promise.reject(new TypeError("fetch failed")) });

    const out = await new OriSource(config).search({ query: "fietspaden", rows: 5, gemeente: "Provincie Noord-Holland" });

    expect(out.items[0].link_type).toBe("ori_record");
    expect(out.items[0].link_note).toContain("werkt niet (geen verbinding)");
  });

  it("reports a page that did not answer in time as not checked, not as broken", async () => {
    mockOri({
      search: () => json(searchResponse([ibabsMeeting()])),
      page: () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    });

    const out = await new OriSource(config).search({ query: "fietspaden", rows: 5, gemeente: "Provincie Noord-Holland" });

    expect(out.items[0].link_type).toBe("ori_record");
    expect(out.items[0].source_system).toBe("iBabs");
    expect(out.items[0].link_note).toContain("De vergaderpagina in iBabs is niet gecontroleerd (geen antwoord binnen 2,5 s)");
    expect(out.items[0].link_note).not.toContain("werkt niet");
  });

  it("checks a page once, also across searches", async () => {
    const { calls } = mockOri({ search: () => json(searchResponse([ibabsMeeting("8100001"), ibabsMeeting("8100002")])), page: () => html() });
    const ori = new OriSource(config);

    await ori.search({ query: "fietspaden", rows: 5, gemeente: "Provincie Noord-Holland" });
    await ori.search({ query: "stikstof", rows: 5, gemeente: "Provincie Noord-Holland" });

    expect(heads(calls)).toEqual([IBABS_PAGE]);
  });

  it("links an iBabs agenda item to its meeting's page, anchored on the item, via one lookup", async () => {
    const item = hit("osi_noord-holland_20250720165905", "8100010", {
      "@type": "AgendaItem",
      name: "Fietspaden langs provinciale wegen",
      parent: "8100001",
      attachment: ["8100011"],
      last_discussed_at: "2026-06-10T13:00:00+00:00",
      ...provenance("ibabs", "agenda_item", { reference_identifier: ITEM_GUID }),
    });
    const { calls } = mockOri({
      search: () => json(searchResponse([item])),
      attachments: (call) => {
        expect((call.body as Record<string, any>).query.ids.values).toEqual(["8100011", "8100001"]);
        return json(
          searchResponse([
            ibabsMeeting(),
            hit("osi_noord-holland_20250720165905", "8100011", { name: "Notitie fietspaden", url: "https://api.openraadsinformatie.nl/v1/resolve/ibabs/agenda/1" }),
          ]),
        );
      },
      page: () => html(),
    });

    const out = await new OriSource(config).search({ query: "fietspaden", rows: 5, gemeente: "Provincie Noord-Holland" });

    expect(out.items[0].url).toBe(`${IBABS_PAGE}#${ITEM_GUID}`);
    expect(out.items[0].link_type).toBe("meeting_page");
    expect(out.items[0].link_note).toContain("met een anker op het agendapunt");
    expect(out.items[0].attachments).toEqual([{ id: "8100011", name: "Notitie fietspaden", url: "https://api.openraadsinformatie.nl/v1/resolve/ibabs/agenda/1" }]);
    expect(heads(calls)).toEqual([IBABS_PAGE]);
  });

  it("follows a nested Notubiz agenda item up to its meeting", async () => {
    const subItem = hit("ori_eindhoven_20250413114006", "7900201", {
      "@type": "AgendaItem",
      name: "Afvalinzameling: nieuwe inzamelroutes",
      parent: "7900200",
      last_discussed_at: "2026-06-16T19:30:00+02:00",
      ...provenance("notubiz", "agenda_item", { reference_identifier: "9900002" }),
    });
    const lookups: string[][] = [];
    const { calls } = mockOri({
      search: () => json(searchResponse([subItem])),
      attachments: (call) => {
        const ids = (call.body as Record<string, any>).query.ids.values as string[];
        lookups.push(ids);
        if (ids.includes("7900200")) {
          return json(
            searchResponse([
              hit("ori_eindhoven_20250413114006", "7900200", { "@type": "AgendaItem", parent: "7900100", ...provenance("notubiz", "agenda_item", { reference_identifier: "9900001" }) }),
            ]),
          );
        }
        return json(searchResponse([hit("ori_eindhoven_20250413114006", "7900100", { "@type": "Meeting", ...provenance("notubiz", "meeting", { original_identifier: "1400001" }) })]));
      },
      page: () => html(),
    });

    const out = await new OriSource(config).search({ query: "afvalinzameling", rows: 5, gemeente: "Eindhoven" });

    expect(lookups).toEqual([["7900200"], ["7900100"]]);
    expect(out.items[0].url).toBe("https://eindhoven.raadsinformatie.nl/vergadering/1400001#ai_9900002");
    expect(out.items[0].source_system).toBe("Notubiz");
    expect(heads(calls)).toEqual(["https://eindhoven.raadsinformatie.nl/vergadering/1400001"]);
  });

  it("keeps an agenda item on its ORI record when its meeting cannot be looked up", async () => {
    const item = hit("ori_eindhoven_20250413114006", "7900201", {
      "@type": "AgendaItem",
      name: "Parkeerbeleid binnenstad",
      parent: "7900100",
      last_discussed_at: "2026-06-16T19:30:00+02:00",
      ...provenance("notubiz", "agenda_item", { reference_identifier: "9900002" }),
    });
    const { calls } = mockOri({ search: () => json(searchResponse([item])), attachments: () => json({ error: "x" }, 400), page: () => html() });

    const out = await new OriSource(config).search({ query: "parkeerbeleid", rows: 5, gemeente: "Eindhoven" });

    expect(out.items[0].link_type).toBe("ori_record");
    expect(out.items[0].link_note).toContain("Geen openbare webpagina bekend");
    expect(out.access_note).toContain("De bijlagen en vergaderingen van agendapunten");
    expect(heads(calls)).toEqual([]);
  });

  it("links a Parlaeus agenda item from its own record, and needs no lookup for it", async () => {
    const parlaeusItem = hit("ori_maastricht_20250408232130", "7954121", {
      "@type": "AgendaItem",
      name: "Woningbouwprogramma",
      parent: "7954120",
      last_discussed_at: "2026-07-07T17:00:00",
      ...provenance("parlaeus", "meeting", {
        reference_identifier: "11112222333344445555666677778888",
        had_primary_source: "https://voorbeeld.parlaeus.nl/receive/opendata?fn=agenda_detail&agid=aaaabbbbccccddddeeeeffff00001111",
      }),
    });
    // A GemeenteOplossingen meeting without the host ORI read it from has no page to look up.
    const goMeeting = hit("ori_groningen_20250329064314", "7938185", {
      "@type": "Meeting",
      name: "Commissie Woningbouw",
      last_discussed_at: "2026-07-01T15:00:00+00:00",
      ...provenance("gemeenteoplossingen", "meeting", { original_identifier: "5000" }),
    });
    const { calls } = mockOri({ search: () => json(searchResponse([parlaeusItem, goMeeting])), page: () => html() });

    const out = await new OriSource(config).search({ query: "woningbouw", rows: 5 });

    expect(out.items[0].url).toBe("https://voorbeeld.parlaeus.nl/user/agenda/action=view/ag=aaaabbbbccccddddeeeeffff00001111");
    expect(out.items[0].link_type).toBe("meeting_page");
    expect(out.items[1].link_type).toBe("ori_record");
    expect(out.items[1].source_system).toBe("GemeenteOplossingen");
    expect(out.items[1].link_note).toContain("Geen openbare webpagina bekend");
    expect(heads(calls)).toEqual(["https://voorbeeld.parlaeus.nl/user/agenda/action=view/ag=aaaabbbbccccddddeeeeffff00001111"]);
    // No lookup for records that need none.
    expect(calls.some((c) => Boolean((c.body as Record<string, any> | undefined)?.query?.ids))).toBe(false);
  });

  it("checks at most 20 pages per search and says so for the rest", async () => {
    const meetings = Array.from({ length: 22 }, (_, i) => ibabsMeeting(String(8200000 + i), `0a1b2c3d-0000-4000-8000-${String(i).padStart(12, "0")}`));
    const { calls } = mockOri({ search: () => json(searchResponse(meetings)), page: () => html() });

    const out = await new OriSource(config).search({ query: "fietspaden", rows: 22, gemeente: "Provincie Noord-Holland" });

    expect(heads(calls)).toHaveLength(20);
    expect(out.items.filter((x) => x.link_type === "meeting_page")).toHaveLength(20);
    expect(out.items.filter((x) => String(x.link_note).includes("niet gecontroleerd"))).toHaveLength(2);
  });

  describe("GemeenteOplossingen and Haarlem, confirmed through the system's API", () => {
    const GO_USED = "https://api.openraadsinformatie.nl/v1/resolve/gemeenteoplossingen/gemeenteraad.groningen.nl/api/v1/meetings%3Fdate_from%3D1782864000%26date_to%3D1783036800";
    const GO_API = "https://gemeenteraad.groningen.nl/api/v1/meetings/5423";
    const GO_PAGE = "https://gemeenteraad.groningen.nl/Vergaderingen/gemeenteraad/2026/1-juli/15:00";
    const goMeeting = hit("ori_groningen_20250415000000", "7938185", {
      "@type": "Meeting",
      name: "Raadsvergadering",
      last_discussed_at: "2026-07-01T15:00:00+00:00",
      ...provenance("gemeenteoplossingen", "meeting", { original_identifier: "5423", used: GO_USED }),
    });
    const goItem = hit("ori_groningen_20250415000000", "7938190", {
      "@type": "AgendaItem",
      name: "Fietspaden in de binnenstad",
      parent: "7938185",
      last_discussed_at: "2026-07-01T15:00:00+00:00",
      ...provenance("gemeenteoplossingen", "agenda_item", { reference_identifier: "38439" }),
    });
    const gets = (calls: Call[]) => calls.filter((c) => c.method === "GET" && c.url.hostname !== "api.openraadsinformatie.nl").map((c) => c.url.href);

    it("links a meeting and its agenda item to the page the GemeenteOplossingen API names", async () => {
      const { calls } = mockOri({
        search: () => json(searchResponse([goItem, goMeeting])),
        attachments: () => json(searchResponse([goMeeting])),
        api: () => json({ id: 5423, confidential: false, fullUrl: GO_PAGE, items: [] }),
      });

      const out = await new OriSource(config).search({ query: "fietspaden", rows: 5, gemeente: "Groningen" });

      for (const item of out.items) {
        expect(item.url).toBe(GO_PAGE);
        expect(item.link_type).toBe("meeting_page");
        expect(item.source_system).toBe("GemeenteOplossingen");
        expect(item.link_note).toContain("bevestigd via de API van GemeenteOplossingen");
      }
      expect(out.items[0].link_note).toContain("Pagina van de vergadering met dit agendapunt");
      expect(out.items[0].link_note).not.toContain("anker");
      expect(out.items[1].ori_record_url).toBe("https://api.openraadsinformatie.nl/v1/elastic/ori_groningen/_doc/7938185");
      // One API lookup for both, without following redirects; no HEAD, since any path answers 200 there.
      expect(gets(calls)).toEqual([GO_API]);
      expect(calls.find((c) => c.url.href === GO_API)?.redirect).toBe("manual");
      expect(heads(calls)).toEqual([]);
    });

    it("keeps the ORI record, and says why, when the API does not confirm the meeting", async () => {
      const cases: Array<[() => Response, string]> = [
        // GemeenteOplossingen answers HTTP 500 for a meeting it does not have.
        [() => json({ status: "Internal Server Error", code: 500, result: null }, 500), "HTTP 500"],
        [() => json({ id: 5423, fullUrl: "https://elders.example/Vergaderingen/Raad" }), "geen pagina op deze site"],
        [() => json({ id: 5423, confidential: true, fullUrl: GO_PAGE }), "besloten vergadering"],
        [() => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }), "staat niet in het antwoord"],
      ];
      for (const [response, reason] of cases) {
        clearHttpCache();
        mockOri({ search: () => json(searchResponse([goMeeting])), api: response });

        const out = await new OriSource(config).search({ query: "fietspaden", rows: 5, gemeente: "Groningen" });

        expect(out.items[0].link_type).toBe("ori_record");
        expect(out.items[0].url).toBe("https://api.openraadsinformatie.nl/v1/elastic/ori_groningen/_doc/7938185");
        expect(out.items[0].link_note).toContain("niet bevestigd door de API van GemeenteOplossingen");
        expect(out.items[0].link_note).toContain(reason);
      }
    });

    it("links Haarlem to the Notubiz page once the Notubiz API has the meeting, and not when it is gone", async () => {
      const meeting = hit("ori_haarlem_20250416182404", "7951001", {
        "@type": "Meeting",
        name: "Commissie Ontwikkeling",
        last_discussed_at: "2026-06-11T19:30:00+02:00",
        ...provenance("notubiz", "meeting", { original_identifier: "1400001" }),
      });
      const item = hit("ori_haarlem_20250416182404", "7951002", {
        "@type": "AgendaItem",
        name: "Parkeerbeleid binnenstad",
        parent: "7951001",
        last_discussed_at: "2026-06-11T19:30:00+02:00",
        ...provenance("notubiz", "agenda_item", { reference_identifier: "9900001" }),
      });
      const api = "https://api.notubiz.nl/events/meetings/1400001?format=json&version=1.17.0";
      const page = "https://gemeentebestuur-haarlem.notubiz.nl/vergadering/1400001";
      const { calls } = mockOri({
        search: () => json(searchResponse([meeting, item])),
        attachments: () => json(searchResponse([meeting])),
        api: () => json({ meeting: { id: 1400001, confidential: 0, url: `${page}/Commissie+Ontwikkeling` } }),
      });

      const out = await new OriSource(config).search({ query: "parkeerbeleid", rows: 5 });

      expect(out.items[0].url).toBe(page);
      expect(out.items[1].url).toBe(`${page}#ai_9900001`);
      expect(out.items.every((x) => x.link_type === "meeting_page")).toBe(true);
      expect(out.items[1].link_note).toContain("bevestigd via de API van Notubiz");
      expect(gets(calls)).toEqual([api]);
      // The page itself sits behind a bot check and is not asked.
      expect(heads(calls)).toEqual([]);

      clearHttpCache();
      mockOri({ search: () => json(searchResponse([meeting])), api: () => json({ resource: "meeting", error_code: 404 }, 404) });
      const gone = await new OriSource(config).search({ query: "parkeerbeleid", rows: 5 });
      expect(gone.items[0].link_type).toBe("ori_record");
      expect(gone.items[0].link_note).toContain("niet bevestigd door de API van Notubiz (HTTP 404)");
    });
  });

  describe("time limit", () => {
    const meetings = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ibabsMeeting(String(8300000 + from + i), `0a1b2c3d-0000-4000-8000-${String(from + i).padStart(12, "0")}`));

    it("stops waiting for page checks after the time limit and drops the checks still queued", async () => {
      let answered = 0;
      const { calls } = mockOri({
        search: () => json(searchResponse(meetings(25))),
        // A portal that answers, but only after the search's time limit.
        page: () => new Promise<Response>((resolve) => setTimeout(() => {
          answered += 1;
          resolve(html());
        }, 150)),
      });
      const ori = new OriSource(config, { pageLinkBudgetMs: 50 });

      const out = await ori.search({ query: "fietspaden", rows: 25, gemeente: "Provincie Noord-Holland" });

      // Returned before any page answered.
      expect(answered).toBe(0);
      expect(out.items.every((x) => x.link_type === "ori_record")).toBe(true);
      expect(out.items.filter((x) => String(x.link_note).includes("tijdslimiet"))).toHaveLength(20);
      expect(out.items.filter((x) => String(x.link_note).includes("meer dan 20"))).toHaveLength(5);
      expect(heads(calls)).toHaveLength(10);

      // The checks under way finish in the background and are kept for the next
      // search; the queued ones are never made, and the returned records do not change.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(answered).toBe(10);
      expect(heads(calls)).toHaveLength(10);
      expect(out.items.every((x) => x.link_type === "ori_record")).toBe(true);
      const again = await ori.search({ query: "fietspaden", rows: 25, gemeente: "Provincie Noord-Holland" });
      expect(again.items.filter((x) => x.link_type === "meeting_page")).toHaveLength(10);
    });

    it("says so when an agenda item's meeting was still being looked up", async () => {
      const item = hit("osi_noord-holland_20250720165905", "8100010", {
        "@type": "AgendaItem",
        name: "Fietspaden langs provinciale wegen",
        parent: "8100001",
        last_discussed_at: "2026-06-10T13:00:00+00:00",
        ...provenance("ibabs", "agenda_item", { reference_identifier: ITEM_GUID }),
      });
      const { calls } = mockOri({
        search: () => json(searchResponse([item])),
        attachments: () => new Promise<Response>((resolve) => setTimeout(() => resolve(json(searchResponse([ibabsMeeting()]))), 120)),
        page: () => html(),
      });

      const out = await new OriSource(config, { pageLinkBudgetMs: 30 }).search({ query: "fietspaden", rows: 5, gemeente: "Provincie Noord-Holland" });

      expect(out.items[0].link_type).toBe("ori_record");
      expect(out.items[0].source_system).toBe("iBabs");
      expect(out.items[0].link_note).toContain("De vergadering van dit agendapunt is niet opgezocht (tijdslimiet");
      expect(heads(calls)).toEqual([]);
    });

    it("leaves a host that missed two checks in a row alone for a while, also in the next search", async () => {
      const { calls } = mockOri({
        search: (call) => json(searchResponse(String(JSON.stringify(call.body)).includes("stikstof") ? meetings(1, 2) : meetings(2))),
        page: () => Promise.reject(new TypeError("fetch failed")),
      });
      const ori = new OriSource(config);

      const first = await ori.search({ query: "fietspaden", rows: 5, gemeente: "Provincie Noord-Holland" });
      const second = await ori.search({ query: "stikstof", rows: 5, gemeente: "Provincie Noord-Holland" });

      expect(first.items.every((x) => String(x.link_note).includes("werkt niet (geen verbinding)"))).toBe(true);
      expect(second.items[0].link_type).toBe("ori_record");
      expect(second.items[0].link_note).toContain("is niet gecontroleerd (noordholland.bestuurlijkeinformatie.nl gaf kort daarvoor geen antwoord)");
      expect(heads(calls)).toHaveLength(2);

      // After the pause the host is asked again.
      vi.setSystemTime(new Date(NOW.getTime() + 3 * 60 * 1000));
      await ori.search({ query: "stikstof", rows: 5, gemeente: "Provincie Noord-Holland" });
      expect(heads(calls)).toHaveLength(3);
    });

    it("also leaves a host alone after two checks that timed out, which it reports as not checked", async () => {
      const { calls } = mockOri({
        search: (call) => json(searchResponse(String(JSON.stringify(call.body)).includes("stikstof") ? meetings(1, 2) : meetings(2))),
        page: () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
      });
      const ori = new OriSource(config);

      const first = await ori.search({ query: "fietspaden", rows: 5, gemeente: "Provincie Noord-Holland" });
      const second = await ori.search({ query: "stikstof", rows: 5, gemeente: "Provincie Noord-Holland" });

      expect(first.items.every((x) => String(x.link_note).includes("is niet gecontroleerd (geen antwoord binnen 2,5 s)"))).toBe(true);
      expect(second.items[0].link_note).toContain("is niet gecontroleerd (noordholland.bestuurlijkeinformatie.nl gaf kort daarvoor geen antwoord)");
      expect(heads(calls)).toHaveLength(2);
    });

    it("asks a paused host once after the pause, not a whole round of checks, and pauses it again when it is still down", async () => {
      const { calls } = mockOri({
        search: (call) => json(searchResponse(String(JSON.stringify(call.body)).includes("stikstof") ? meetings(6, 10) : meetings(2))),
        page: () => Promise.reject(new TypeError("fetch failed")),
      });
      const ori = new OriSource(config);
      await ori.search({ query: "fietspaden", rows: 5, gemeente: "Provincie Noord-Holland" });
      expect(heads(calls)).toHaveLength(2);

      vi.setSystemTime(new Date(NOW.getTime() + 3 * 60 * 1000));
      const after = await ori.search({ query: "stikstof", rows: 10, gemeente: "Provincie Noord-Holland" });

      // One check goes; the other five wait for its answer and are left out.
      expect(heads(calls)).toHaveLength(3);
      expect(after.items.filter((x) => String(x.link_note).includes("werkt niet (geen verbinding)"))).toHaveLength(1);
      expect(after.items.filter((x) => String(x.link_note).includes("gaf kort daarvoor geen antwoord"))).toHaveLength(5);
      // The miss started a new pause.
      await ori.search({ query: "stikstof", rows: 10, gemeente: "Provincie Noord-Holland" });
      expect(heads(calls)).toHaveLength(3);
    });

    it("lets every check through again once the one check after the pause is answered", async () => {
      let down = true;
      const { calls } = mockOri({
        search: (call) => json(searchResponse(String(JSON.stringify(call.body)).includes("stikstof") ? meetings(1, 10) : String(JSON.stringify(call.body)).includes("woningbouw") ? meetings(3, 20) : meetings(2))),
        page: () => (down ? Promise.reject(new TypeError("fetch failed")) : html()),
      });
      const ori = new OriSource(config);
      await ori.search({ query: "fietspaden", rows: 5, gemeente: "Provincie Noord-Holland" });

      down = false;
      vi.setSystemTime(new Date(NOW.getTime() + 3 * 60 * 1000));
      await ori.search({ query: "stikstof", rows: 5, gemeente: "Provincie Noord-Holland" });
      const next = await ori.search({ query: "woningbouw", rows: 5, gemeente: "Provincie Noord-Holland" });

      expect(heads(calls)).toHaveLength(2 + 1 + 3);
      expect(next.items.every((x) => x.link_type === "meeting_page")).toBe(true);
    });

    it("keeps asking a host after a single miss: one slow page does not pause a working site", async () => {
      let first = true;
      const { calls } = mockOri({
        search: (call) => json(searchResponse(String(JSON.stringify(call.body)).includes("stikstof") ? meetings(1, 1) : meetings(1))),
        page: () => {
          if (!first) return html();
          first = false;
          return Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        },
      });
      const ori = new OriSource(config);

      await ori.search({ query: "fietspaden", rows: 5, gemeente: "Provincie Noord-Holland" });
      const second = await ori.search({ query: "stikstof", rows: 5, gemeente: "Provincie Noord-Holland" });

      expect(heads(calls)).toHaveLength(2);
      expect(second.items[0].link_type).toBe("meeting_page");
    });
  });
});

describe("ori_search tool", () => {
  async function callTool(args: Record<string, unknown>): Promise<Record<string, any>> {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ori-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({ name: "ori_search", arguments: args })) as { content: Array<{ type: string; text: string }> };
      return JSON.parse(result.content[0].text) as Record<string, any>;
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("returns working links, a text snippet, the date label and a lower-bound total", async () => {
    mockOri({ search: () => json(searchResponse([AGENDA_ITEM, DOCUMENT], { value: 10000, relation: "gte" })) });

    const payload = await callTool({ query: "beleidskader", gemeente: "Eindhoven", rows: 5 });

    expect(payload.summary).toBe("2 ORI resultaten — Eindhoven (van 10000+ treffers)");
    const [agenda, doc] = payload.records;
    expect(agenda.canonical_url).toBe("https://api.openraadsinformatie.nl/v1/elastic/ori_eindhoven/_doc/7900101");
    expect(doc.canonical_url).toBe("https://api.openraadsinformatie.nl/v1/resolve/api.notubiz.nl/document/16600412");
    expect(doc.snippet).toBe("Het Rekenkamerrapport over het parkeerbeleid is behandeld");
    expect(doc.snippet).not.toBe("MediaObject");
    expect(doc.data.snippet).toBeUndefined();
    expect(doc.data.date_type).toBe("vergaderdatum");
    expect(doc.date).toBe("2026-03-10T19:00:00+01:00");
    expect(payload.provenance.total_results).toBeUndefined();
    expect(payload.access_note).toContain("ORI telt niet verder dan 10000");
  });

  it("accepts date_from/date_to and match, and rejects a malformed date", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([])) });

    const ok = await callTool({ query: "parkeren", date_from: "2026-07-08", match: "any" });
    expect(ok.error).toBeUndefined();
    const body = searchCalls()[0].body as Record<string, any>;
    expect(body.query.bool.must[0].query_string.default_operator).toBe("OR");
    expect(body.query.bool.filter[0].bool.should[0].range.last_discussed_at.gte).toBe("2026-07-08||/d");

    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ori-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({ name: "ori_search", arguments: { query: "parkeren", date_from: "8 juli 2026" } })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("YYYY-MM-DD");
      const impossible = (await client.callTool({ name: "ori_search", arguments: { query: "parkeren", date_to: "2026-02-30" } })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(impossible.isError).toBe(true);
      expect(impossible.content[0].text).toContain("existing date");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns an error, not an empty success, when ORI fails", async () => {
    mockOri({ search: () => json({ error: "unavailable" }, 503) });

    const payload = await callTool({ query: "parkeren", gemeente: "Eindhoven", rows: 200 });

    expect(payload.error).toBe("http_error");
    expect(payload.records).toBeUndefined();
    expect(payload.suggestion).toContain("geen leeg resultaat");
  });

  it("passes search syntax on as typed instead of lowercasing operators into required words", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([])) });

    await callTool({ query: "OV OR fietsen", gemeente: "Eindhoven" });
    await callTool({ query: "OV NOT Stadsregio", gemeente: "Eindhoven" });
    await callTool({ query: '"sociale woningbouw"', gemeente: "Eindhoven" });
    await callTool({ query: "parkeren OR fietsen", gemeente: "Eindhoven" });

    const sent = searchCalls().map((c) => (c.body as Record<string, any>).query.bool.must[0].query_string.query);
    expect(sent).toEqual(["OV OR fietsen", "OV NOT Stadsregio", '"sociale woningbouw"', "parkeren OR fietsen"]);
  });

  it("keeps a lowercase 'or' a search word through the rewriter, and tells the caller how to write the operator", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([])) });

    const payload = await callTool({ query: "parkeren or fietsen", gemeente: "Eindhoven" });

    expect((searchCalls()[0].body as Record<string, any>).query.bool.must[0].query_string.query).toBe('parkeren "or" fietsen');
    expect(payload.access_note).toContain("OR, AND of NOT in hoofdletters");
  });

  it("still strips the question frame from a plain question", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([])) });

    const payload = await callTool({ query: "Wat zijn de laatste besluiten over parkeerbeleid?", gemeente: "Eindhoven" });

    expect((searchCalls()[0].body as Record<string, any>).query.bool.must[0].query_string.query).toBe("besluiten over parkeerbeleid");
    // The rewrite is reported, as the other rewriting tools do.
    expect(payload.access_note).toContain('Zoekterm herschreven: "Wat zijn de laatste besluiten over parkeerbeleid?" → "besluiten over parkeerbeleid"');

    const plain = await callTool({ query: "parkeerbeleid", gemeente: "Eindhoven" });
    expect(String(plain.access_note ?? "")).not.toContain("Zoekterm herschreven");
  });

  it("gives a meeting its checked page as canonical_url and keeps the ORI record in the data", async () => {
    const guid = "0a1b2c3d-0000-4000-8000-0000000000f1";
    const page = `https://noordholland.bestuurlijkeinformatie.nl/Agenda/Index/${guid}`;
    mockOri({
      search: () =>
        json(
          searchResponse([
            hit("osi_noord-holland_20250720165905", "8300001", {
              "@type": "Meeting",
              name: "Statencommissie Natuur",
              last_discussed_at: "2026-06-15T13:00:00+00:00",
              was_generated_by: {
                same_as: `https://openbesluitvorming.nl/voc/mapping/noord-holland/ibabs/meeting/${guid}`,
                original_identifier: guid,
                used: "https://api.openraadsinformatie.nl/v1/resolve/ibabs/GetMeetingsByDateRange/Sitename%3DNoord-holland/StartDate%3D2026-06-14T00%3A00%3A00/EndDate%3D2026-06-16T00%3A00%3A00",
              },
            }),
          ]),
        ),
      page: () => new Response(null, { status: 200, headers: { "content-type": "text/html" } }),
    });

    const payload = await callTool({ query: "stikstof", gemeente: "Provincie Noord-Holland" });

    expect(payload.records[0].canonical_url).toBe(page);
    expect(payload.records[0].data.link_type).toBe("meeting_page");
    expect(payload.records[0].data.source_system).toBe("iBabs");
    expect(payload.records[0].data.ori_record_url).toBe("https://api.openraadsinformatie.nl/v1/elastic/osi_noord-holland/_doc/8300001");
  });

  it("summarises a name without an index as such", async () => {
    mockOri({ search: () => json(searchResponse([])) });

    const payload = await callTool({ query: "parkeren", gemeente: "Land van Cuijk" });

    expect(payload.summary).toBe("Geen ORI-index voor 'Land van Cuijk' — niet gezocht");
    expect(payload.records).toEqual([]);
  });
});
