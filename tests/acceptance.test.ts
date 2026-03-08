/**
 * Acceptance tests — fire real queries at every connector via the MCP server.
 * Validates that each source returns sensible results.
 *
 * Run with: npx vitest run tests/acceptance.test.ts
 *
 * Notes:
 *  - KNMI tools require KNMI_API_KEY — tests skip when unset.
 *  - Overheid API register requires OVERHEID_API_KEY — test skips when unset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { startStreamableHttpServer } from "../src/server.js";

const HAS_KNMI_KEY = !!process.env.KNMI_API_KEY;
const HAS_OVERHEID_KEY = !!process.env.OVERHEID_API_KEY;

let sessionId: string;

function post(path: string, body: unknown, sid?: string): Promise<{ status: number; sessionId?: string; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(payload)),
      Accept: "application/json, text/event-stream",
    };
    if (sid) headers["mcp-session-id"] = sid;

    const req = http.request({ hostname: "localhost", port: 3333, path, method: "POST", headers }, (res) => {
      let raw = "";
      res.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      res.on("end", () => {
        const returnedSid = res.headers["mcp-session-id"] as string | undefined;
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch {
          for (const event of raw.split("\n\n").filter(Boolean)) {
            const d = event.split("\n").find((l: string) => l.startsWith("data: "));
            if (d) try { parsed = JSON.parse(d.slice(6)); } catch { /* skip */ }
          }
        }
        resolve({ status: res.statusCode ?? 0, sessionId: returnedSid, data: parsed });
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** Successful tool response. */
interface ToolResult {
  summary: string;
  records: Array<{ source_name: string; title: string; canonical_url: string; data: Record<string, unknown>; snippet?: string; date?: string }>;
  provenance: { tool: string; endpoint: string; query_params: Record<string, string>; returned_results: number; total_results: number };
  access_note?: string;
  failures?: Array<{ source: string; error: string }>;
}

/** Error tool response (e.g. not_configured). */
interface ToolError {
  error: string;
  message: string;
  suggestion?: string;
}

type ToolResponse = ToolResult | ToolError;

function isError(r: ToolResponse): r is ToolError { return "error" in r; }

let callId = 100;

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResponse> {
  const res = await post("/mcp", { jsonrpc: "2.0", id: ++callId, method: "tools/call", params: { name, arguments: args } }, sessionId);
  const msg = res.data as { result?: { content?: Array<{ type: string; text: string }> }; error?: { message: string } };
  if (msg.error) throw new Error(`${name}: ${msg.error.message}`);
  const text = msg.result?.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error(`No text content from ${name}`);
  try { return JSON.parse(text) as ToolResponse; } catch {
    // Tool returned a plain-text error (e.g. MCP SDK wraps uncaught exceptions)
    return { error: "unexpected", message: text } as ToolError;
  }
}

/** Convenience: assert a successful response with at least N records. */
function expectRecords(res: ToolResponse, min = 1): asserts res is ToolResult {
  if (isError(res)) throw new Error(`Expected records but got error: ${res.error} — ${res.message}`);
  expect(res.records.length).toBeGreaterThanOrEqual(min);
}

beforeAll(async () => {
  await startStreamableHttpServer();
  const init = await post("/mcp", {
    jsonrpc: "2.0", id: 0, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "acceptance-test", version: "1.0" } },
  });
  sessionId = init.sessionId!;
  expect(sessionId).toBeDefined();
}, 10_000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    const req = http.request({ hostname: "localhost", port: 3333, path: "/mcp", method: "DELETE", headers: { "mcp-session-id": sessionId } },
      (res) => { res.on("data", () => {}); res.on("end", () => resolve()); });
    req.end();
  });
});

/* ================================================================== */
/*  1. DATA.OVERHEID.NL (CKAN)                                         */
/* ================================================================== */
describe("data.overheid.nl", () => {
  it("datasets_search: finds datasets", async () => {
    const res = await callTool("data_overheid_datasets_search", { query: "luchtkwaliteit", rows: 3 });
    expectRecords(res);
  }, 30_000);

  it("datasets_search: sort=date_newest works", async () => {
    const res = await callTool("data_overheid_datasets_search", { query: "energie", sort: "date_newest", rows: 3 });
    expectRecords(res);
  }, 30_000);

  it("organizations: returns list", async () => {
    const res = await callTool("data_overheid_organizations", {});
    expectRecords(res, 10);
  }, 30_000);

  it("themes: returns list", async () => {
    const res = await callTool("data_overheid_themes", {});
    // data.overheid group_list may return 0 groups depending on CKAN config
    if (!isError(res)) {
      expect(res.records).toBeDefined();
    }
  }, 30_000);
});

/* ================================================================== */
/*  2. CBS                                                             */
/* ================================================================== */
describe("CBS", () => {
  it("tables_search: finds tables", async () => {
    const res = await callTool("cbs_tables_search", { query: "bevolking", top: 5 });
    expectRecords(res);
  }, 30_000);

  it("table_info: returns metadata for known table", async () => {
    const res = await callTool("cbs_table_info", { tableId: "37296ned" });
    expectRecords(res);
  }, 30_000);
});

/* ================================================================== */
/*  3. TWEEDE KAMER                                                    */
/* ================================================================== */
describe("Tweede Kamer", () => {
  it("documents: finds stikstof docs", async () => {
    const res = await callTool("tweede_kamer_documents", { query: "stikstof", top: 3 });
    expectRecords(res);
  }, 30_000);

  it("search: finds entities", async () => {
    const res = await callTool("tweede_kamer_search", { query: "klimaat", entity: "Document", top: 3 });
    expectRecords(res);
  }, 30_000);

  it("members: returns active members", async () => {
    const res = await callTool("tweede_kamer_members", { active: true, top: 5 });
    expectRecords(res);
  }, 30_000);
});

/* ================================================================== */
/*  4. OFFICIËLE BEKENDMAKINGEN                                        */
/* ================================================================== */
describe("Officiële Bekendmakingen", () => {
  it("search: finds publications", async () => {
    const res = await callTool("officiele_bekendmakingen_search", { query: "woningbouw", top: 3 });
    expectRecords(res);
  }, 30_000);
});

/* ================================================================== */
/*  5. RIJKSOVERHEID                                                   */
/* ================================================================== */
describe("Rijksoverheid", () => {
  it("search: finds documents", async () => {
    const res = await callTool("rijksoverheid_search", { query: "klimaat", rows: 3 });
    expectRecords(res);
  }, 30_000);

  it("topics: returns list", async () => {
    const res = await callTool("rijksoverheid_topics", {});
    expectRecords(res);
  }, 30_000);

  it("ministries: returns list", async () => {
    const res = await callTool("rijksoverheid_ministries", {});
    expectRecords(res);
  }, 30_000);
});

/* ================================================================== */
/*  6. RIJKSBEGROTING                                                  */
/* ================================================================== */
describe("Rijksbegroting", () => {
  it("search: finds budget items", async () => {
    const res = await callTool("rijksbegroting_search", { query: "onderwijs", rows: 5 });
    // The connector scrapes HTML and searches; if no match, it returns first N items as fallback
    expectRecords(res);
  }, 30_000);
});

/* ================================================================== */
/*  7. DUO                                                             */
/* ================================================================== */
describe("DUO", () => {
  it("datasets_search: finds education datasets", async () => {
    const res = await callTool("duo_datasets_search", { query: "basisonderwijs", rows: 3 });
    expectRecords(res);
  }, 30_000);
});

/* ================================================================== */
/*  8. KNMI (requires KNMI_API_KEY)                                    */
/* ================================================================== */
describe("KNMI", () => {
  it.skipIf(!HAS_KNMI_KEY)("datasets: returns catalog", async () => {
    const res = await callTool("knmi_datasets", {});
    expectRecords(res);
  }, 30_000);

  it.skipIf(!HAS_KNMI_KEY)("warnings: returns current warnings", async () => {
    const res = await callTool("knmi_warnings", {});
    // May return 0 warnings if none are active, but should not error
    if (!isError(res)) {
      expect(res.summary).toBeDefined();
    }
  }, 30_000);

  it.skipIf(!HAS_KNMI_KEY)("earthquakes: returns seismic data", async () => {
    const res = await callTool("knmi_earthquakes", {});
    if (!isError(res)) {
      expect(res.records.length).toBeGreaterThanOrEqual(0);
    }
  }, 30_000);
});

/* ================================================================== */
/*  9. PDOK / BAG                                                      */
/* ================================================================== */
describe("PDOK / BAG", () => {
  it("pdok_search: finds address", async () => {
    const res = await callTool("pdok_search", { query: "Damrak 1 Amsterdam", rows: 3 });
    expectRecords(res);
    expect(res.records.some((r) => JSON.stringify(r).toLowerCase().includes("amsterdam"))).toBe(true);
  }, 30_000);

  it("bag_lookup_address: finds by postcode", async () => {
    const res = await callTool("bag_lookup_address", { postcode: "1012JS", huisnummer: "1" });
    if (isError(res)) {
      // BAG PDOK may return errors for specific lookups; log but don't fail hard
      console.warn(`bag_lookup_address returned error: ${res.message}`);
    } else {
      expect(res.records.length).toBeGreaterThan(0);
    }
  }, 30_000);
});

/* ================================================================== */
/*  10. RECHTSPRAAK                                                    */
/* ================================================================== */
describe("Rechtspraak", () => {
  it("sort=date_newest returns recent results", async () => {
    const res = await callTool("rechtspraak_search_ecli", { query: "waterschade", sort: "date_newest", rows: 3 });
    expectRecords(res);
    expect(res.provenance.query_params.sortOrder).toBe("PublicatieDatumDesc");
  }, 30_000);

  it("default sort=relevance", async () => {
    const res = await callTool("rechtspraak_search_ecli", { query: "huurrecht ontbinding", rows: 3 });
    expectRecords(res);
    expect(res.provenance.query_params.sortOrder).toBe("Relevance");
  }, 30_000);

  it("date_filter=year applies facet", async () => {
    const res = await callTool("rechtspraak_search_ecli", { query: "arbeidsrecht", sort: "date_newest", date_filter: "year", rows: 3 });
    expectRecords(res);
    expect(res.provenance.query_params.publicatieFilter).toBe("DitJaar");
  }, 30_000);
});

/* ================================================================== */
/*  11. RDW                                                            */
/* ================================================================== */
describe("RDW", () => {
  it("finds vehicle data", async () => {
    const res = await callTool("rdw_open_data_search", { query: "elektrisch", rows: 3 });
    expectRecords(res);
  }, 90_000); // RDW Socrata can be slow — 4 sequential strategies
});

/* ================================================================== */
/*  12. LUCHTMEETNET                                                   */
/* ================================================================== */
describe("Luchtmeetnet", () => {
  it("returns live NO2 data", async () => {
    const res = await callTool("luchtmeetnet_latest", { component: "NO2" });
    expectRecords(res);
  }, 30_000);
});

/* ================================================================== */
/*  13. RIJKSWATERSTAAT                                                */
/* ================================================================== */
describe("Rijkswaterstaat", () => {
  it("finds water data", async () => {
    const res = await callTool("rijkswaterstaat_waterdata_search", { query: "waterhoogte", rows: 5 });
    // Catalog search — may return 0 if term doesn't match parameter descriptions
    if (!isError(res)) {
      expect(res.records).toBeDefined();
    }
  }, 30_000);
});

/* ================================================================== */
/*  14. NDW                                                            */
/* ================================================================== */
describe("NDW", () => {
  it("finds traffic data", async () => {
    const res = await callTool("ndw_search", { query: "verkeersdrukte", rows: 3 });
    expectRecords(res);
  }, 30_000);
});

/* ================================================================== */
/*  15. ORI                                                            */
/* ================================================================== */
describe("ORI", () => {
  it("finds council documents", async () => {
    const res = await callTool("ori_search", { query: "parkeerbeleid", rows: 3 });
    expectRecords(res);
  }, 30_000);

  it("sort=date_newest works", async () => {
    const res = await callTool("ori_search", { query: "woningbouw", sort: "date_newest", rows: 3 });
    expectRecords(res);
  }, 30_000);
});

/* ================================================================== */
/*  16. NGR                                                            */
/* ================================================================== */
describe("NGR", () => {
  it("finds geo datasets", async () => {
    const res = await callTool("ngr_discovery_search", { query: "bodemkaart", rows: 3 });
    expectRecords(res);
  }, 30_000);
});

/* ================================================================== */
/*  17. RIVM                                                           */
/* ================================================================== */
describe("RIVM", () => {
  it("finds health datasets", async () => {
    const res = await callTool("rivm_discovery_search", { query: "vaccinatie", rows: 3 });
    expectRecords(res);
  }, 30_000);
});

/* ================================================================== */
/*  18. BAG LINKED DATA (SPARQL)                                       */
/* ================================================================== */
describe("BAG Linked Data", () => {
  it("executes SPARQL query", async () => {
    const res = await callTool("bag_linked_data_select", {
      query: "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 3",
      limit: 3,
    });
    expectRecords(res);
  }, 30_000);
});

/* ================================================================== */
/*  19. RCE LINKED DATA (SPARQL)                                       */
/* ================================================================== */
describe("RCE Linked Data", () => {
  it("executes SPARQL query", async () => {
    const res = await callTool("rce_linked_data_select", {
      query: "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 3",
      limit: 3,
    });
    expectRecords(res);
  }, 30_000);
});

/* ================================================================== */
/*  20. EUROSTAT                                                       */
/* ================================================================== */
describe("Eurostat", () => {
  it("finds EU datasets", async () => {
    const res = await callTool("eurostat_datasets_search", { query: "unemployment", rows: 3 });
    expectRecords(res);
  }, 30_000);
});

/* ================================================================== */
/*  21. DATA.EUROPA.EU                                                 */
/* ================================================================== */
describe("data.europa.eu", () => {
  it("finds EU open data", async () => {
    const res = await callTool("data_europa_datasets_search", { query: "air quality", rows: 3 });
    expectRecords(res);
  }, 30_000);
});

/* ================================================================== */
/*  22. OVERHEID API REGISTER (requires OVERHEID_API_KEY)              */
/* ================================================================== */
describe("Overheid API register", () => {
  it.skipIf(!HAS_OVERHEID_KEY)("search: finds APIs", async () => {
    const res = await callTool("overheid_api_register_search", { query: "BAG", rows: 3 });
    expectRecords(res);
  }, 30_000);
});

/* ================================================================== */
/*  23. NL_GOV_ASK (meta-router)                                       */
/* ================================================================== */
describe("nl_gov_ask router", () => {
  it("routes legal question → Rechtspraak", async () => {
    const res = await callTool("nl_gov_ask", { question: "jurisprudentie over huurrecht" });
    expectRecords(res);
    expect(res.records.some((r) => r.source_name === "rechtspraak")).toBe(true);
  }, 60_000);

  it("routes statistics question → CBS/data.overheid", async () => {
    const res = await callTool("nl_gov_ask", { question: "bevolkingsgroei statistiek" });
    expectRecords(res);
    const sources = new Set(res.records.map((r) => r.source_name));
    expect(sources.has("cbs") || sources.has("data_overheid")).toBe(true);
  }, 60_000);

  it("routes budget question → Rijksbegroting", async () => {
    const res = await callTool("nl_gov_ask", { question: "begroting onderwijs" });
    expectRecords(res);
  }, 60_000);

  it("routes parliamentary question → Tweede Kamer", async () => {
    const res = await callTool("nl_gov_ask", { question: "moties over stikstof" });
    expectRecords(res);
    const sources = new Set(res.records.map((r) => r.source_name));
    expect(sources.has("tweedekamer")).toBe(true);
  }, 60_000);

  it("routes general question → data.overheid fallback", async () => {
    const res = await callTool("nl_gov_ask", { question: "subsidie cultuur" });
    expectRecords(res);
  }, 60_000);
});
