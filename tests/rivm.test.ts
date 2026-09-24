import { beforeEach, describe, expect, it, vi } from "vitest";
import { RivmSource } from "../src/sources/rivm.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { testConfig, xmlResponse } from "./helpers/config.js";

/** One gmd:MD_Metadata record in the shape data.rivm.nl's CSW returns it. */
function mdMetadata(id: string, title: string, abstract: string): string {
  return `
    <gmd:MD_Metadata xmlns:gmd="http://www.isotc211.org/2005/gmd" xmlns:gco="http://www.isotc211.org/2005/gco" xmlns:xlink="http://www.w3.org/1999/xlink">
      <gmd:fileIdentifier><gco:CharacterString>${id}</gco:CharacterString></gmd:fileIdentifier>
      <gmd:identificationInfo>
        <gmd:MD_DataIdentification>
          <gmd:citation xlink:title="attribuut, geen titel">
            <gmd:CI_Citation>
              <gmd:title><gco:CharacterString>${title}</gco:CharacterString></gmd:title>
            </gmd:CI_Citation>
          </gmd:citation>
          <gmd:abstract><gco:CharacterString>${abstract}</gco:CharacterString></gmd:abstract>
        </gmd:MD_DataIdentification>
      </gmd:identificationInfo>
    </gmd:MD_Metadata>`;
}

function cswResponse(records: string, prolog = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${prolog}
<csw:GetRecordsResponse xmlns:csw="http://www.opengis.net/cat/csw/2.0.2">
  <csw:SearchStatus timestamp="2026-09-24T18:45:16" />
  <csw:SearchResults numberOfRecordsMatched="1" numberOfRecordsReturned="1" elementSet="summary" nextRecord="0">${records}
  </csw:SearchResults>
</csw:GetRecordsResponse>`;
}

function stubCsw(body: string) {
  const fetchMock = vi.fn(async () => xmlResponse(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("RivmSource CSW search", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("maps identifier, title and abstract from a gmd:MD_Metadata record", async () => {
    stubCsw(
      cswResponse(
        mdMetadata(
          "43fe76cf-96c6-416c-8b7d-532936b46551",
          "Stikstofdioxide (NO2) &amp; fijnstof",
          "Jaargemiddelde luchtkwaliteit &#x2014; RIVM",
        ),
      ),
    );
    const out = await new RivmSource(testConfig).search({ query: "luchtkwaliteit", rows: 5 });

    expect(out.endpoint).toBe("https://data.rivm.nl/meta/srv/eng/csw");
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      id: "43fe76cf-96c6-416c-8b7d-532936b46551",
      title: "Stikstofdioxide (NO2) & fijnstof",
      description: "Jaargemiddelde luchtkwaliteit — RIVM",
      url: "https://data.rivm.nl/geonetwork/srv/dut/catalog.search#/metadata/43fe76cf-96c6-416c-8b7d-532936b46551",
      source: "rivm-csw",
    });
  });

  it("does not expand entities declared in a DOCTYPE", async () => {
    stubCsw(
      cswResponse(
        mdMetadata("abc-1", "Titel &geheim;", "Samenvatting &geheim;"),
        `<!DOCTYPE csw:GetRecordsResponse [<!ENTITY geheim "UITGEBREID">]>`,
      ),
    );
    const out = await new RivmSource(testConfig).search({ query: "titel", rows: 5 });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].title).toBe("Titel &geheim;");
    expect(out.items[0].description).toBe("Samenvatting &geheim;");
    expect(JSON.stringify(out)).not.toContain("UITGEBREID");
  });

  it("keeps numeric-looking identifiers and titles as strings, leading zeros intact", async () => {
    stubCsw(cswResponse(mdMetadata("0344", "0x1F", "")));
    const out = await new RivmSource(testConfig).search({ query: "0344", rows: 5 });

    expect(out.items).toHaveLength(1);
    expect(out.items[0].id).toBe("0344");
    expect(out.items[0].title).toBe("0x1F");
    expect(out.items[0].url).toMatch(/\/metadata\/0344$/);
  });
});
