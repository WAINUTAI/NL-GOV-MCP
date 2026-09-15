import { beforeEach, describe, expect, it, vi } from "vitest";
import { LidoSource, parseLidoId } from "../src/sources/lido.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { testConfig, xmlResponse } from "./helpers/config.js";

const HEAD = `<?xml version="1.0" encoding="UTF-8"?>`;

function perTypeXml(id: string, extId: string, counts: Array<[string, number]>): string {
  const enc = encodeURIComponent(id);
  const aantallen = counts
    .map(
      ([label, n]) =>
        `<aantal informatietype-label="${label}" url="https://linkeddata.overheid.nl/front/portal/spiegel-lijstweergave?id=${enc}&amp;fq=%7B%21tag%3Dobj_type%7Dobj_type%3A%22${label}%22">${n}</aantal>`,
    )
    .join("");
  return `${HEAD}<lido service="get-aantal-per-informatietype" id="${id}" ext-id="${extId}">${aantallen}</lido>`;
}

const ECLI_XML = perTypeXml(
  "http://linkeddata.overheid.nl/terms/jurisprudentie/id/ECLI:NL:HR:2019:2006",
  "ECLI:NL:HR:2019:2006",
  [
    ["Verdrag", 20],
    ["Jurisprudentie", 126],
    ["Wet", 14],
  ],
);
const CELEX_XML = perTypeXml(
  "http://linkeddata.overheid.nl/terms/eu-regelgeving/id/32016L0680",
  "CELEX:32016L0680",
  [
    ["Wet", 5],
    ["Jurisprudentie", 954],
  ],
);
const OEP_XML = perTypeXml("http://linkeddata.overheid.nl/terms/oep/id/stb-2018-401", "OEP:stb-2018-401", [
  ["Wet", 171],
  ["Jurisprudentie", 25],
]);
const BWB_ID = "http://linkeddata.overheid.nl/terms/bwb/id/BWBR0011823/1384514/2026-06-12/2026-06-12";
const GET_ID_XML = `${HEAD}<lido service="get-id" juriconnect-ref="BWBR0011823&amp;artikel=29"><id>${BWB_ID}</id></lido>`;
const GET_ID_EMPTY_XML = `${HEAD}<lido service="get-id" juriconnect-ref="BWBR0011353&amp;artikel=8"></lido>`;
const BWB_APIT_XML = `${HEAD}<lido service="get-aantal-per-informatietype" id="${BWB_ID}"><aantal informatietype-label="Jurisprudentie" url="x">42</aantal></lido>`;
const UNKNOWN_XML = `${HEAD}<lido service="get-aantal-per-informatietype" id="" ext-id="ECLI:NL:HR:2099:9999"></lido>`;

function calledUrl(fetchMock: ReturnType<typeof vi.fn>, i: number): URL {
  return new URL(String((fetchMock.mock.calls[i] as unknown as Array<unknown>)[0]));
}

describe("parseLidoId", () => {
  it("recognises the supported identifier kinds", () => {
    expect(parseLidoId("ECLI:NL:HR:2019:2006")).toEqual({ kind: "ecli", value: "ECLI:NL:HR:2019:2006" });
    expect(parseLidoId(" ecli:nl:hr:1998:aa9342 ")).toEqual({ kind: "ecli", value: "ECLI:NL:HR:1998:AA9342" });
    expect(parseLidoId("CELEX:32016L0680")).toEqual({ kind: "celex", value: "32016L0680" });
    expect(parseLidoId("32016L0680")).toEqual({ kind: "celex", value: "32016L0680" });
    expect(parseLidoId("62014CJ0362")).toEqual({ kind: "celex", value: "62014CJ0362" });
    expect(parseLidoId("BWBR0011823")).toEqual({ kind: "bwb", value: "BWBR0011823" });
    expect(parseLidoId("stb-2018-401")).toEqual({ kind: "oep", value: "stb-2018-401" });
    expect(parseLidoId("stcrt-2024-20264")).toEqual({ kind: "oep", value: "stcrt-2024-20264" });
    expect(parseLidoId("OEP:stb-2018-401")).toEqual({ kind: "oep", value: "stb-2018-401" });
  });

  it("rejects anything else", () => {
    for (const bad of ["", "hallo", "BWBR001", "ECLI:NL:HR", "32016L0680&x=1", "stb-2018-401 OR 1", "https://example.org"]) {
      expect(parseLidoId(bad)).toBeNull();
    }
  });
});

describe("LidoSource.references", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("counts references for an ECLI via get-aantal-per-informatietype", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(ECLI_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).references({ id: "ECLI:NL:HR:2019:2006" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = calledUrl(fetchMock, 0);
    expect(url.pathname).toBe("/service/get-aantal-per-informatietype");
    expect(url.searchParams.get("ext-id")).toBe("ECLI:NL:HR:2019:2006");

    expect(out.total).toBe(1);
    expect(out.items).toHaveLength(1);
    const item = out.items[0];
    expect(item.kind).toBe("ecli");
    expect(item.artikel).toBeNull();
    expect(item.lido_id).toBe("http://linkeddata.overheid.nl/terms/jurisprudentie/id/ECLI:NL:HR:2019:2006");
    expect(item.total_references).toBe(160);
    expect(item.per_type).toEqual([
      { type: "Jurisprudentie", count: 126 },
      { type: "Verdrag", count: 20 },
      { type: "Wet", count: 14 },
    ]);
    expect(new URL(String(item.portal_url)).searchParams.get("ext-id")).toBe("ECLI:NL:HR:2019:2006");
    expect(item.title).toBe("LiDO-verwijzingen naar ECLI:NL:HR:2019:2006");
    expect(out.access_note).toContain("CC0");
    expect(out.access_note).toContain("portal_url");
  });

  it("prefixes CELEX: for EU legislation", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(CELEX_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).references({ id: "32016L0680" });

    expect(calledUrl(fetchMock, 0).searchParams.get("ext-id")).toBe("CELEX:32016L0680");
    expect(out.items[0].kind).toBe("celex");
    expect(out.items[0].total_references).toBe(959);
    expect((out.items[0].per_type as Array<{ type: string }>)[0].type).toBe("Jurisprudentie");
  });

  it("prefixes OEP: for official publications", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(OEP_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).references({ id: "stb-2018-401" });

    expect(calledUrl(fetchMock, 0).searchParams.get("ext-id")).toBe("OEP:stb-2018-401");
    expect(out.items[0].kind).toBe("oep");
    expect(out.items[0].total_references).toBe(196);
  });

  it("resolves a BWB article with get-id first, then counts by LiDO id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(xmlResponse(GET_ID_XML))
      .mockResolvedValueOnce(xmlResponse(BWB_APIT_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).references({ id: "BWBR0011823", artikel: "29" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = calledUrl(fetchMock, 0);
    expect(first.pathname).toBe("/service/get-id");
    expect(first.searchParams.get("juriconnect-ref")).toBe("BWBR0011823&artikel=29");
    const second = calledUrl(fetchMock, 1);
    expect(second.pathname).toBe("/service/get-aantal-per-informatietype");
    expect(second.searchParams.get("id")).toBe(BWB_ID);

    const item = out.items[0];
    expect(item.kind).toBe("bwb");
    expect(item.artikel).toBe("29");
    expect(item.lido_id).toBe(BWB_ID);
    expect(item.total_references).toBe(42);
    expect(new URL(String(item.portal_url)).searchParams.get("id")).toBe(BWB_ID);
    expect(item.title).toBe("LiDO-verwijzingen naar BWBR0011823 artikel 29");
    expect(out.access_note).toContain("oudere");
  });

  it("returns no items when get-id finds no BWB element", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(GET_ID_EMPTY_XML));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new LidoSource(testConfig).references({ id: "BWBR0011353", artikel: "8" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
  });

  it("returns no items when LiDO does not know the identifier", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => xmlResponse(UNKNOWN_XML)));

    const out = await new LidoSource(testConfig).references({ id: "ECLI:NL:HR:2099:9999" });

    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
  });

  it("rejects invalid identifiers and articles without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const src = new LidoSource(testConfig);

    await expect(src.references({ id: "geen-id" })).rejects.toThrow("Onbekend LiDO-identifier");
    await expect(src.references({ id: "BWBR0011823", artikel: "29&x=1" })).rejects.toThrow("artikelnummer");
    await expect(src.references({ id: "ECLI:NL:HR:2019:2006", artikel: "1" })).rejects.toThrow("BWB");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
