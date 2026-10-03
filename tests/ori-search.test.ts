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
}

type Handler = (call: Call) => Response | Promise<Response>;

/**
 * Routes every request the ORI source makes: the index list, the organisation
 * names, the freshness aggregation, the attachment lookup, the index probe of
 * the no-index-list fallback, and the search itself.
 */
function mockOri(handlers: { search: Handler; aliases?: Handler; orgs?: Handler; freshness?: Handler; attachments?: Handler; probe?: Handler }) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
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

  it("reads lowercase or/and/not between terms as operators, and says so", async () => {
    const { searchCalls } = mockOri({ search: () => json(searchResponse([])) });

    const out = await new OriSource(config).search({ query: "parkeren or fietsen", rows: 5, gemeente: "Eindhoven" });

    expect((searchCalls()[0].body as Record<string, any>).query.bool.must[0].query_string).toEqual({ query: "parkeren OR fietsen", default_operator: "AND" });
    expect(out.params.q).toBe("parkeren OR fietsen");
    expect(out.access_note).toContain("gelezen als de operatoren OR, AND en NOT");
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
    await callTool({ query: "ov or fietsen", gemeente: "Eindhoven" });

    const sent = searchCalls().map((c) => (c.body as Record<string, any>).query.bool.must[0].query_string.query);
    expect(sent).toEqual(["OV OR fietsen", "OV NOT Stadsregio", '"sociale woningbouw"', "ov OR fietsen"]);
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

  it("summarises a name without an index as such", async () => {
    mockOri({ search: () => json(searchResponse([])) });

    const payload = await callTool({ query: "parkeren", gemeente: "Land van Cuijk" });

    expect(payload.summary).toBe("Geen ORI-index voor 'Land van Cuijk' — niet gezocht");
    expect(payload.records).toEqual([]);
  });
});
