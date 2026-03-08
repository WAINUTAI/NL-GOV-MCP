import { describe, expect, it } from "vitest";
import { injectCbsTrends } from "../src/utils/cbs-trends.js";

describe("injectCbsTrends", () => {
  it("injects previous period and delta fields for a single measure over periods", () => {
    const out = injectCbsTrends([
      { Perioden: "2023JJ00", RegioS: "NL01", Bevolking: 100 },
      { Perioden: "2024JJ00", RegioS: "NL01", Bevolking: 130 },
      { Perioden: "2025JJ00", RegioS: "NL01", Bevolking: 117 },
    ]);

    expect(out[0].previous_period).toBeUndefined();
    expect(out[1].previous_period).toBe("2023JJ00");
    expect(out[1].previous_value).toBe(100);
    expect(out[1].delta).toBe(30);
    expect(out[1].delta_pct).toBe(30);
    expect(out[2].previous_period).toBe("2024JJ00");
    expect(out[2].delta).toBe(-13);
    expect(out[2].delta_pct).toBeCloseTo(-10, 6);
  });

  it("groups by non-period dimensions before computing deltas", () => {
    const out = injectCbsTrends([
      { Perioden: "2024JJ00", RegioS: "NL01", Waarde: 10 },
      { Perioden: "2025JJ00", RegioS: "NL01", Waarde: 12 },
      { Perioden: "2024JJ00", RegioS: "GM0599", Waarde: 30 },
      { Perioden: "2025JJ00", RegioS: "GM0599", Waarde: 45 },
    ]);

    expect(out[1].previous_value).toBe(10);
    expect(out[1].delta).toBe(2);
    expect(out[3].previous_value).toBe(30);
    expect(out[3].delta).toBe(15);
  });

  it("stays inert when multiple numeric measure columns are present", () => {
    const input = [
      { Perioden: "2024JJ00", RegioS: "NL01", WaardeA: 10, WaardeB: 20 },
      { Perioden: "2025JJ00", RegioS: "NL01", WaardeA: 12, WaardeB: 21 },
    ];

    const out = injectCbsTrends(input);
    expect(out).toEqual(input);
  });
});
