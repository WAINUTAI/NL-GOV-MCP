import { beforeEach, describe, expect, it, vi } from "vitest";
import { LuchtmeetnetSource, matchStationsByPlace } from "../src/sources/luchtmeetnet.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

const stations = [
  { number: "NL10639", location: "Utrecht-Constant Erzeijstraat" },
  { number: "NL10636", location: "Utrecht-Kardinaal de Jongweg" },
  { number: "NL10643", location: "Utrecht-Griftpark" },
  { number: "NL10418", location: "Rotterdam-Pleinweg" },
  { number: "NL49565", location: "Oude Meer-Aalsmeerderdijk" },
];

describe("matchStationsByPlace", () => {
  it("matches on the city part of a 'City-Street' station name", () => {
    expect(matchStationsByPlace(stations, "Utrecht").map((s) => s.number)).toEqual([
      "NL10639",
      "NL10636",
      "NL10643",
    ]);
  });

  it("is case- and accent-insensitive", () => {
    expect(matchStationsByPlace(stations, "rotterdam")).toHaveLength(1);
  });

  it("falls back to a contains match for a street or station name", () => {
    expect(matchStationsByPlace(stations, "Griftpark").map((s) => s.number)).toEqual(["NL10643"]);
  });

  it("does not match a different city that merely shares a prefix word", () => {
    expect(matchStationsByPlace(stations, "Oude")).toHaveLength(1);
    expect(matchStationsByPlace(stations, "Amsterdam")).toHaveLength(0);
  });

  it("returns nothing for empty input", () => {
    expect(matchStationsByPlace(stations, "  ")).toHaveLength(0);
  });
});

function stubLuchtmeetnet(options: {
  measurementsStatus?: number;
  stationsStatus?: number;
  lkiRows?: number;
} = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/stations")) {
      if (options.stationsStatus && options.stationsStatus >= 400) {
        return new Response("boom", { status: options.stationsStatus });
      }
      return jsonResponse({ pagination: { last_page: 1 }, data: stations });
    }
    if (url.includes("/measurements")) {
      if (options.measurementsStatus && options.measurementsStatus >= 400) {
        return new Response("bad gateway", { status: options.measurementsStatus });
      }
      const station = new URL(url).searchParams.get("station_number") ?? "NL00000";
      return jsonResponse({
        data: [
          {
            station_number: station,
            station_name: station,
            formula: "NO2",
            value: 12,
            unit: "ug/m3",
            timestamp_measured: "2026-08-26T04:00:00+00:00",
          },
        ],
      });
    }
    if (url.includes("/lki")) {
      const station = new URL(url).searchParams.get("station_number") || "NL10639";
      return jsonResponse({
        pagination: { last_page: 1 },
        data: Array.from({ length: options.lkiRows ?? 1 }, (_, i) => ({
          station_number: station || `NL1000${i}`,
          formula: "LKI",
          value: 3,
          timestamp_measured: "2026-08-26T03:00:00+00:00",
        })),
      });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestedUrls(fetchMock: ReturnType<typeof stubLuchtmeetnet>): string[] {
  return fetchMock.mock.calls.map((c) => (c as unknown as [string])[0]);
}

describe("LuchtmeetnetSource.latest", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("queries only the stations of the requested place", async () => {
    const fetchMock = stubLuchtmeetnet();
    const out = await new LuchtmeetnetSource(testConfig).latest({ plaats: "Utrecht", rows: 10 });

    const measurementCalls = requestedUrls(fetchMock).filter((u) => u.includes("/measurements"));
    expect(measurementCalls).toHaveLength(3);
    expect(measurementCalls.map((u) => new URL(u).searchParams.get("station_number")).sort()).toEqual([
      "NL10636",
      "NL10639",
      "NL10643",
    ]);
    expect(out.items).toHaveLength(3);
    expect(out.access_note).toContain("Utrecht-Griftpark");
  });

  it("reports a place without a measuring station instead of national data", async () => {
    const fetchMock = stubLuchtmeetnet();
    const out = await new LuchtmeetnetSource(testConfig).latest({ plaats: "Staphorst", rows: 10 });

    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("Geen Luchtmeetnet-meetstation gevonden");
    expect(requestedUrls(fetchMock).some((u) => u.includes("/measurements"))).toBe(false);
  });

  it("falls back to LKI per station when /measurements is down", async () => {
    const fetchMock = stubLuchtmeetnet({ measurementsStatus: 502 });
    const out = await new LuchtmeetnetSource(testConfig).latest({ plaats: "Utrecht", rows: 10 });

    const lkiCalls = requestedUrls(fetchMock).filter((u) => u.includes("/lki"));
    expect(lkiCalls).toHaveLength(3);
    expect(out.items.length).toBeGreaterThan(0);
    expect(out.items[0].unit).toBe("LKI (1-11)");
    expect(out.access_note).toContain("LKI");
    expect(out.access_note).toContain("Utrecht");
  });

  it("does not claim a place has no station when the station list is unreachable", async () => {
    stubLuchtmeetnet({ stationsStatus: 503 });
    const out = await new LuchtmeetnetSource(testConfig).latest({ plaats: "Utrecht", rows: 5 });

    expect(out.access_note ?? "").not.toContain("Geen Luchtmeetnet-meetstation gevonden");
    expect(out.items.length).toBeGreaterThan(0);
  });

  it("keeps the national path unchanged when no place is given", async () => {
    const fetchMock = stubLuchtmeetnet();
    const out = await new LuchtmeetnetSource(testConfig).latest({ rows: 5 });

    const measurementCalls = requestedUrls(fetchMock).filter((u) => u.includes("/measurements"));
    expect(measurementCalls).toHaveLength(1);
    expect(new URL(measurementCalls[0]).searchParams.get("station_number")).toBeNull();
    expect(out.items).toHaveLength(1);
  });

  it("uses separate connectors so a broken /measurements cannot lock out the LKI fallback", async () => {
    // Three failing calls are exactly the circuit-breaker threshold: with a
    // shared connector name the fourth call died with circuit_open before the
    // healthy fallback was ever tried.
    const source = new LuchtmeetnetSource(testConfig);
    stubLuchtmeetnet({ measurementsStatus: 502 });

    for (let i = 0; i < 4; i += 1) {
      const out = await source.latest({ plaats: "Utrecht", rows: 5 });
      expect(out.items.length, `call ${i + 1} returned no items`).toBeGreaterThan(0);
    }
  });
});
