import { beforeEach, describe, expect, it, vi } from "vitest";
import { DuoSource } from "../src/sources/duo.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

const schoolRow = {
  _id: 1,
  PROVINCIE: "Noord-Brabant",
  "BEVOEGD GEZAG NUMMER": 20091,
  INSTELLINGSCODE: "32JK",
  VESTIGINGSCODE: "32JK00",
  VESTIGINGSNAAM: "Basisschool Franciscus",
  STRAATNAAM: "Kerkstraat",
  "HUISNUMMER-TOEVOEGING": "13",
  POSTCODE: "5041EB",
  PLAATSNAAM: "TILBURG",
  GEMEENTENUMMER: "0855",
  GEMEENTENAAM: "TILBURG",
  DENOMINATIE: "Rooms-Katholiek",
  TELEFOONNUMMER: "0135431234",
  INTERNETADRES: "www.franciscusschool.nl",
};

const examRow = {
  _id: 9104,
  SCHOOLJAAR: 2017,
  "BRIN NUMMER": "18XU",
  BRINVESTIGINGSNUMMER: "18XU01",
  "INSTELLINGSNAAM VESTIGING": "Beatrix College loc. Reeshof",
  "GEMEENTENAAM VESTIGING": "TILBURG",
  "PROVINCIE VESTIGING": "Noord-Brabant",
  "ONDERWIJSTYPE VO": "VMBO",
  EXAMENKANDIDATEN: 84,
  GESLAAGDEN: 84,
  GEZAKTEN: 0,
  SLAGINGSPERCENTAGE: 100.0,
  "GEMIDDELD CIJFER SCHOOLEXAMEN": 6.4,
  "GEMIDDELD CIJFER CENTRAAL EXAMEN": 6.3,
  "GEMIDDELD CIJFER CIJFERLIJST": 6.4,
};

function stubCkan(options: { packageShowFails?: boolean; records?: unknown[]; total?: number } = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("package_show")) {
      if (options.packageShowFails) return new Response("boom", { status: 404 });
      // CKAN returns the resources of one package per call, so key the fixture
      // on the requested package id the way the real API does.
      const packageId = new URL(url).searchParams.get("id") ?? "";
      const resourcesByPackage: Record<string, Array<Record<string, unknown>>> = {
        adressen_bo: [
          { id: "bestuur-id", name: "Adressen bevoegde gezagen basisonderwijs", datastore_active: true },
          { id: "fresh-id", name: "Alle vestigingen in het basisonderwijs", datastore_active: true },
        ],
        adressen_vo: [
          { id: "vo-bestuur-id", name: "Adressen van besturen in het voortgezet onderwijs", datastore_active: true },
          { id: "vo-id", name: "Adressen van vestigingen in het voortgezet onderwijs", datastore_active: true },
        ],
        "03_voex-v1": [
          { id: "exam-id", name: "Slagingspercentages en gemiddelde examencijfers per vestiging", datastore_active: true },
        ],
      };
      return jsonResponse({
        success: true,
        result: { resources: resourcesByPackage[packageId] ?? [] },
      });
    }
    if (url.includes("datastore_search")) {
      return jsonResponse({
        success: true,
        result: {
          total: options.total ?? 56,
          records: options.records ?? [schoolRow],
        },
      });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function datastoreUrl(fetchMock: ReturnType<typeof stubCkan>): URL {
  const call = fetchMock.mock.calls
    .map((c) => (c as unknown as [string])[0])
    .find((u) => u.includes("datastore_search"));
  return new URL(call!);
}

describe("DuoSource.getSchools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("returns per-school records, not catalogue hits", async () => {
    stubCkan();
    const out = await new DuoSource(testConfig).getSchools({ municipality: "Tilburg", top: 5 });

    expect(out.total).toBe(56);
    expect(out.items[0]).toMatchObject({
      naam: "Basisschool Franciscus",
      instellingscode: "32JK",
      vestigingscode: "32JK00",
      straat: "Kerkstraat 13",
      postcode: "5041EB",
      plaats: "TILBURG",
      gemeente: "TILBURG",
      gemeentecode: "0855",
      denominatie: "Rooms-Katholiek",
      website: "www.franciscusschool.nl",
    });
    expect(out.items[0].url).toBe("https://www.franciscusschool.nl");
  });

  it("uppercases exact filters and passes a name as free text", async () => {
    const fetchMock = stubCkan();
    await new DuoSource(testConfig).getSchools({
      municipality: "tilburg",
      place: "berkel-enschot",
      postcode: "5041 eb",
      name: "Franciscus",
      top: 5,
    });

    const url = datastoreUrl(fetchMock);
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual({
      GEMEENTENAAM: "TILBURG",
      PLAATSNAAM: "BERKEL-ENSCHOT",
      POSTCODE: "5041EB",
    });
    expect(url.searchParams.get("q")).toBe("Franciscus");
    expect(url.searchParams.get("sort")).toBe("VESTIGINGSNAAM asc");
  });

  it("resolves the current resource id by name", async () => {
    const fetchMock = stubCkan();
    await new DuoSource(testConfig).getSchools({ sector: "po", top: 5 });

    expect(datastoreUrl(fetchMock).searchParams.get("resource_id")).toBe("fresh-id");
  });

  it("falls back to the known resource id when the lookup fails", async () => {
    const fetchMock = stubCkan({ packageShowFails: true });
    await new DuoSource(testConfig).getSchools({ sector: "po", top: 5 });

    expect(datastoreUrl(fetchMock).searchParams.get("resource_id")).toBe(
      "dcc9c9a5-6d01-410b-967f-810557588ba4",
    );
  });

  it("selects the sector-specific dataset and name field", async () => {
    const fetchMock = stubCkan({
      records: [{ ...schoolRow, ONDERWIJSSTRUCTUUR: "HAVO/VWO" }],
    });
    const out = await new DuoSource(testConfig).getSchools({ sector: "vo", top: 5 });

    expect(datastoreUrl(fetchMock).searchParams.get("resource_id")).toBe("vo-id");
    expect(out.items[0].onderwijstype).toBe("HAVO/VWO");
    expect(out.params.sector).toBe("vo");
  });

  it("explains an empty result", async () => {
    stubCkan({ records: [], total: 0 });
    const out = await new DuoSource(testConfig).getSchools({ municipality: "Nergenshuizen", top: 5 });

    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("Geen scholen gevonden");
  });
});

describe("DuoSource.getExamResults", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("returns per-school exam results with parsed numbers", async () => {
    stubCkan({ records: [examRow], total: 23 });
    const out = await new DuoSource(testConfig).getExamResults({ municipality: "Tilburg", top: 5 });

    expect(out.total).toBe(23);
    expect(out.items[0]).toMatchObject({
      school: "Beatrix College loc. Reeshof",
      brin: "18XU",
      brinVestiging: "18XU01",
      gemeente: "TILBURG",
      onderwijstype: "VMBO",
      schooljaar: 2017,
      examenkandidaten: 84,
      geslaagden: 84,
      slagingspercentage: 100,
      gemiddeldCentraalExamen: 6.3,
    });
    expect(out.access_note).toContain("2013 t/m 2017");
  });

  it("sorts by pass rate when asked and filters exactly", async () => {
    const fetchMock = stubCkan({ records: [examRow], total: 1 });
    await new DuoSource(testConfig).getExamResults({
      municipality: "tilburg",
      onderwijstype: "vwo",
      year: 2017,
      sortByScore: true,
      top: 5,
    });

    const url = datastoreUrl(fetchMock);
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual({
      SCHOOLJAAR: 2017,
      "GEMEENTENAAM VESTIGING": "TILBURG",
      "ONDERWIJSTYPE VO": "VWO",
    });
    expect(url.searchParams.get("sort")).toBe("SLAGINGSPERCENTAGE desc");
  });

  it("explains a school year outside the dataset coverage instead of failing", async () => {
    stubCkan({ records: [], total: 0 });
    const out = await new DuoSource(testConfig).getExamResults({ year: 2024, top: 5 });

    expect(out.items).toHaveLength(0);
    expect(out.access_note).toContain("Schooljaar 2024 valt buiten de dekking");
  });

  it("sorts newest school year first by default", async () => {
    const fetchMock = stubCkan({ records: [examRow], total: 1 });
    await new DuoSource(testConfig).getExamResults({ top: 5 });

    expect(datastoreUrl(fetchMock).searchParams.get("sort")).toBe(
      "SCHOOLJAAR desc, SLAGINGSPERCENTAGE desc",
    );
  });
});
