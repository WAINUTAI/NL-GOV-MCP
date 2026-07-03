import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { OvapiSource } from "../src/sources/ovapi.js";

const config = loadConfig();

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makePass(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    TransportType: "TRAM",
    OperatorCode: "HTM",
    DataOwnerCode: "HTM",
    LinePublicNumber: "2",
    LinePlanningNumber: "2",
    LineName: "Kraaijenstein - Leidschendam Leidsenhage",
    DestinationName50: "Leidschendam",
    JourneyNumber: 20149,
    TimingPointCode: "32002646",
    TimingPointName: "Ternoot",
    TimingPointTown: "Den Haag",
    TripStopStatus: "DRIVING",
    TargetDepartureTime: "2026-07-03T17:14:00",
    ExpectedDepartureTime: "2026-07-03T17:16:00",
    ...overrides,
  };
}

// NOTE: the HTTP layer caches GET responses by URL (ovapi is a "live" connector
// with a 2-min TTL). Every case must therefore hit a DISTINCT haltecode, or the
// first response is replayed from cache to the rest — mirroring how the NS suite
// keeps its cases isolated by using distinct URLs.
function tpcResponse(
  passes: Record<string, Record<string, unknown>>,
  code = "32002646",
): Response {
  return jsonResponse({
    [code]: {
      Stop: {
        TimingPointCode: code,
        TimingPointName: "Ternoot",
        TimingPointTown: "Den Haag",
        StopAreaCode: "2645",
      },
      Passes: passes,
    },
  });
}

describe("OvapiSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes passes into realtime departures and computes delay", async () => {
    const fetchMock = vi.fn(async () =>
      tpcResponse({
        HTM_20260703_2_20149_0: makePass({}),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const src = new OvapiSource(config);
    const out = await src.search({ timingPointCode: "32002646", rows: 20 });

    const calledUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("v0.ovapi.nl/tpc/32002646");
    expect(out.items).toHaveLength(1);

    const dep = out.items[0];
    expect(dep.line).toBe("2");
    expect(dep.destination).toBe("Leidschendam");
    expect(dep.transportType).toBe("TRAM");
    expect(dep.targetDepartureTime).toBe("2026-07-03T17:14:00");
    expect(dep.expectedDepartureTime).toBe("2026-07-03T17:16:00");
    expect(dep.delayMinutes).toBe(2);
    expect(dep.stopName).toBe("Ternoot");
    expect(dep.town).toBe("Den Haag");
    expect(dep.title).toBe("TRAM 2 → Leidschendam");
    expect(dep.url).toBe("http://v0.ovapi.nl/tpc/32002646");
  });

  it("sorts departures by expected departure time ascending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        tpcResponse(
          {
            late: makePass({
              DestinationName50: "Later",
              ExpectedDepartureTime: "2026-07-03T18:30:00",
              TargetDepartureTime: "2026-07-03T18:30:00",
            }),
            early: makePass({
              DestinationName50: "Earlier",
              ExpectedDepartureTime: "2026-07-03T17:05:00",
              TargetDepartureTime: "2026-07-03T17:05:00",
            }),
          },
          "32002647",
        ),
      ),
    );

    const src = new OvapiSource(config);
    const out = await src.search({ timingPointCode: "32002647", rows: 20 });

    expect(out.items.map((d) => d.destination)).toEqual(["Earlier", "Later"]);
  });

  it("filters departures by line number when line is provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        tpcResponse(
          {
            a: makePass({ LinePublicNumber: "2", DestinationName50: "Lijn twee" }),
            b: makePass({ LinePublicNumber: "6", DestinationName50: "Lijn zes" }),
          },
          "32002648",
        ),
      ),
    );

    const src = new OvapiSource(config);
    const out = await src.search({ timingPointCode: "32002648", line: "6", rows: 20 });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].destination).toBe("Lijn zes");
    expect(out.params.line).toBe("6");
  });

  it("respects the rows cap while reporting the full total", async () => {
    const passes: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 8; i++) {
      passes[`p${i}`] = makePass({
        ExpectedDepartureTime: `2026-07-03T17:${String(10 + i).padStart(2, "0")}:00`,
        TargetDepartureTime: `2026-07-03T17:${String(10 + i).padStart(2, "0")}:00`,
      });
    }
    vi.stubGlobal("fetch", vi.fn(async () => tpcResponse(passes, "32002649")));

    const src = new OvapiSource(config);
    const out = await src.search({ timingPointCode: "32002649", rows: 3 });

    expect(out.items).toHaveLength(3);
    expect(out.total).toBe(8);
  });

  it("returns an empty result with a helpful note when the halte has no passes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tpcResponse({}, "32002650")));

    const src = new OvapiSource(config);
    const out = await src.search({ timingPointCode: "32002650", rows: 20 });

    expect(out.items).toHaveLength(0);
    expect(out.total).toBe(0);
    expect(out.access_note).toContain("Geen actuele vertrekken");
  });

  it("does not hit the network when no timingpointcode is given", async () => {
    const fetchMock = vi.fn(async () => tpcResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const src = new OvapiSource(config);
    const out = await src.search({ timingPointCode: "   ", rows: 20 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("geldige haltecode");
  });
});
