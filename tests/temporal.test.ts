import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPORAL_TIME_ZONE, parseTemporalRange } from "../src/utils/temporal.js";

const NOW = new Date("2026-03-03T12:00:00Z");

describe("parseTemporalRange", () => {
  it("parses today/today", () => {
    const out = parseTemporalRange("cbs cijfers vandaag", NOW);
    expect(out).toBeDefined();
    expect(out?.from).toBe("2026-03-03");
    expect(out?.to).toBe("2026-03-03");
    expect(out?.context.timeZone).toBe(DEFAULT_TEMPORAL_TIME_ZONE);
    expect(out?.context.referenceNow).toBe("2026-03-03T12:00:00.000Z");
  });

  it("parses yesterday", () => {
    const out = parseTemporalRange("wat was het gisteren", NOW);
    expect(out?.from).toBe("2026-03-02");
    expect(out?.to).toBe("2026-03-02");
  });

  it("parses last week", () => {
    const out = parseTemporalRange("last week verkeersdata", NOW);
    expect(out?.from).toBe("2026-02-23");
    expect(out?.to).toBe("2026-03-01");
  });

  it("parses last month", () => {
    const out = parseTemporalRange("afgelopen maand emissie", NOW);
    expect(out?.from).toBe("2026-02-01");
    expect(out?.to).toBe("2026-02-28");
  });

  it("parses last quarter", () => {
    const out = parseTemporalRange("last quarter budget", NOW);
    expect(out?.from).toBe("2025-10-01");
    expect(out?.to).toBe("2025-12-31");
  });

  it("parses this year", () => {
    const out = parseTemporalRange("dit jaar uitgaven", NOW);
    expect(out?.from).toBe("2026-01-01");
    expect(out?.to).toBe("2026-03-03");
  });

  it("parses since year", () => {
    const out = parseTemporalRange("sinds 2020 woningbouw", NOW);
    expect(out?.from).toBe("2020-01-01");
    expect(out?.to).toBe("2026-03-03");
  });

  it("parses between years", () => {
    const out = parseTemporalRange("tussen 2018 en 2022 bevolking", NOW);
    expect(out?.from).toBe("2018-01-01");
    expect(out?.to).toBe("2022-12-31");
  });

  it("uses configured timezone calendar day instead of raw UTC day", () => {
    const out = parseTemporalRange("vandaag stikstof", {
      now: "2026-03-07T23:30:00Z",
      timeZone: "Europe/Amsterdam",
    });

    expect(out?.from).toBe("2026-03-08");
    expect(out?.to).toBe("2026-03-08");
    expect(out?.context.today).toBe("2026-03-08");
    expect(out?.context.timeZone).toBe("Europe/Amsterdam");
  });

  it("supports timezone override for reproducible client context", () => {
    const out = parseTemporalRange("today permits", {
      now: "2026-03-07T23:30:00Z",
      timeZone: "America/New_York",
    });

    expect(out?.from).toBe("2026-03-07");
    expect(out?.to).toBe("2026-03-07");
    expect(out?.context.today).toBe("2026-03-07");
    expect(out?.context.timeZone).toBe("America/New_York");
  });
});
