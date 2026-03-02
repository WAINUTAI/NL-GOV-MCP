import { describe, it, expect } from "vitest";
import { mapSourceError } from "../src/utils/response.js";
import { SourceRequestError } from "../src/utils/http.js";

describe("mapSourceError", () => {
  it("maps timeout", () => {
    const err = new SourceRequestError({ message: "t", endpoint: "x", code: "timeout" });
    const out = mapSourceError(err, "CBS");
    expect(out.error).toBe("timeout");
  });

  it("maps rate limit", () => {
    const err = new SourceRequestError({ message: "r", endpoint: "x", code: "rate_limited", status: 429, retryAfter: 30 });
    const out = mapSourceError(err, "CBS");
    expect(out.error).toBe("rate_limited");
    expect(out.retry_after).toBe(30);
  });
});
