import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, testConfig } from "./helpers/config.js";

/**
 * The closing-date recheck of tenderned_aanbestedingen_search is best-effort:
 * a slow or failing detail endpoint must not break or stall the TenderNed
 * tools themselves. Connector state (circuit breaker, slots) is module-level,
 * so every test loads a fresh copy of the modules.
 */
type Source = import("../src/sources/tenderned.js").TenderNedSource;
type Runtime = typeof import("../src/utils/connector-runtime.js");

let newSource: () => Source;
let runtime: Runtime;

beforeEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  const { TenderNedSource } = await import("../src/sources/tenderned.js");
  runtime = await import("../src/utils/connector-runtime.js");
  newSource = () => new TenderNedSource(testConfig);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A date `offset` days from now, as TenderNed prints closing dates. */
const day = (offset: number) => `${new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)}T12:00:00`;
const AAO = { code: "AAO", omschrijving: "Aankondiging opdracht" };

/** `n` open notices with ids 500000.. and deadlines 10.. days ahead. */
const openNotices = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ publicatieId: String(500000 + i), typePublicatie: AAO, sluitingsDatum: day(10 + i) }));

/**
 * /publicaties answers at once; /publicaties/{id} goes through `detail`, which
 * returns a Response (or a promise of one) or undefined for the default: a
 * detail record whose deadline is 30 days later than the indexed one.
 */
function upstream(
  rows: Array<{ publicatieId: string; sluitingsDatum: string }>,
  detail: (id: string) => Response | undefined | Promise<Response | undefined> = () => undefined,
) {
  return vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/publicaties")) return jsonResponse({ content: rows, totalElements: rows.length });
    if (url.pathname.endsWith("/gerelateerd")) return jsonResponse([]);
    const id = url.pathname.split("/").pop() ?? "";
    const custom = await detail(id);
    if (custom) return custom;
    const row = rows.find((r) => r.publicatieId === id);
    const indexed = row?.sluitingsDatum ?? day(5);
    const shifted = `${new Date(Date.parse(`${indexed.slice(0, 10)}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10)}T12:00:00`;
    return jsonResponse({ publicatieId: Number(id), aankondigingCode: AAO, sluitingsDatum: shifted });
  });
}

const detailCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map((c) => new URL((c as unknown as [string])[0]).pathname).filter((p) => /\/publicaties\/\d+$/.test(p)).length;

describe("TenderNed closing-date recheck isolation", () => {
  it("runs on its own connector, so a failing detail endpoint cannot open the circuit for search and get", async () => {
    const rows = openNotices(10);
    const fetchMock = upstream(rows, (id) => (rows.some((r) => r.publicatieId === id) ? jsonResponse({ message: "Service Unavailable" }, 503) : undefined));
    vi.stubGlobal("fetch", fetchMock);
    const source = newSource();

    const out = await source.search({ query: "afvalinzameling", rows: 10 });
    expect(out.items).toHaveLength(10);
    expect(out.items.every((i) => i.sluitingsDatumGecontroleerd === false)).toBe(true);
    expect(out.access_note).toContain("Bij 10 publicatie(s) komt sluitings_datum ongecontroleerd");
    expect(out.access_note).toContain("niet afgemaakt");
    // No new recheck after the first wave failed (one request per parallel slot, no retries).
    expect(detailCalls(fetchMock)).toBe(3);

    expect(runtime.getConnectorHealth("tenderned")).toMatchObject({ circuit_open: false, consecutive_failures: 0 });
    expect(runtime.getConnectorHealth("tenderned_recheck").total_failures).toBe(3);

    // TenderNed's own tools keep working ...
    const again = await source.search({ query: "fietsbrug", rows: 10 });
    expect(again.items).toHaveLength(10);
    const got = await source.get({ publicatieId: "123", include_award: false });
    expect(got.item.sluitingsDatumGecontroleerd).toBe(true);
    // ... while the recheck, behind its own open circuit, sends nothing more.
    expect(runtime.getConnectorHealth("tenderned_recheck").circuit_open).toBe(true);
    expect(detailCalls(fetchMock)).toBe(4); // the 3 failed rechecks + the get
    expect(again.access_note).toContain("niet afgemaakt");
  });

  it("keeps checking the other notices when one detail record is missing", async () => {
    const rows = openNotices(6);
    const fetchMock = upstream(rows, (id) => (id === "500002" ? jsonResponse({ message: "not found" }, 404) : undefined));
    vi.stubGlobal("fetch", fetchMock);

    const out = await newSource().search({ rows: 10 });
    expect(detailCalls(fetchMock)).toBe(6);
    expect(out.items.filter((i) => i.sluitingsDatumGecontroleerd)).toHaveLength(5);
    expect(out.items.find((i) => i.id === "500002")).toMatchObject({ sluitingsDatumGecontroleerd: false });
    expect(out.access_note).toContain("Bij 1 publicatie(s) komt sluitings_datum ongecontroleerd");
    expect(out.access_note).not.toContain("niet afgemaakt");
  });

  it("stops at its time budget without holding up get, and discards answers that arrive later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const rows = openNotices(50);
    const slow = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    // Every recheck takes 2 s; the get below asks for a notice that answers at once.
    const fetchMock = upstream(rows, async (id) => {
      if (rows.some((r) => r.publicatieId === id)) await slow(2_000);
      return undefined;
    });
    vi.stubGlobal("fetch", fetchMock);
    const source = newSource();

    let searched: Awaited<ReturnType<Source["search"]>> | undefined;
    const search = source.search({ rows: 50 }).then((out) => (searched = out));
    await vi.advanceTimersByTimeAsync(10);
    // Three rechecks hold the recheck connector; get has its own slots.
    expect(detailCalls(fetchMock)).toBe(3);
    let gotAt: number | undefined;
    void source.get({ publicatieId: "123", include_award: false }).then(() => (gotAt = Date.now()));
    await vi.advanceTimersByTimeAsync(10);
    expect(gotAt).toBeDefined();
    expect(searched).toBeUndefined();

    // First wave answers at 2 s, the second wave would at 4 s: the 3 s budget ends the recheck.
    await vi.advanceTimersByTimeAsync(3_000);
    await search;
    expect(searched).toBeDefined();
    const checked = () => searched!.items.filter((i) => i.sluitingsDatumGecontroleerd).length;
    const shifted = () => searched!.items.filter((i) => i.sluitingsDatumOorspronkelijk).length;
    expect(checked()).toBe(3);
    expect(shifted()).toBe(3);
    expect(searched!.access_note).toContain("Bij 47 publicatie(s) komt sluitings_datum ongecontroleerd");
    expect(searched!.access_note).toContain("niet afgemaakt");
    expect(detailCalls(fetchMock)).toBe(3 + 3 + 1); // two waves of rechecks + the get

    // The second wave still lands, but no longer changes what search returned.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(checked()).toBe(3);
    expect(shifted()).toBe(3);
    expect(runtime.getConnectorHealth("tenderned")).toMatchObject({ circuit_open: false, consecutive_failures: 0 });
  });
});
