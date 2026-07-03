import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { BroOndergrondSource } from "../src/sources/bro-ondergrond.js";

const config = loadConfig();

function xmlResponse(xml: string): Response {
  return new Response(xml, {
    status: 200,
    headers: { "content-type": "application/xml" },
  });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const GMW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<dispatchDataResponse xmlns="http://www.broservices.nl/xsd/dsgmw/1.1"
  xmlns:brocom="http://www.broservices.nl/xsd/brocommon/3.0"
  xmlns:gmwcommon="http://www.broservices.nl/xsd/gmwcommon/3.0"
  xmlns:gml="http://www.opengis.net/gml/3.2">
  <brocom:responseType>dispatch</brocom:responseType>
  <dispatchDocument>
    <GMW_PO gml:id="BRO_0003">
      <brocom:broId>GMW000000036287</brocom:broId>
      <brocom:deliveryAccountableParty>62251686</brocom:deliveryAccountableParty>
      <brocom:qualityRegime>IMBRO</brocom:qualityRegime>
      <wellCode>GMW38B125170</wellCode>
      <numberOfMonitoringTubes>1</numberOfMonitoringTubes>
      <deliveredLocation>
        <gmwcommon:location srsName="urn:ogc:def:crs:EPSG::28992">
          <gml:pos>118300.381 439767.501</gml:pos>
        </gmwcommon:location>
      </deliveredLocation>
      <standardizedLocation>
        <brocom:location srsName="urn:ogc:def:crs:EPSG::4258">
          <gml:pos>51.945145560 4.853433240</gml:pos>
        </brocom:location>
      </standardizedLocation>
      <registrationHistory>
        <brocom:objectRegistrationTime>2020-09-15T10:17:39+02:00</brocom:objectRegistrationTime>
        <brocom:registrationStatus>geregistreerd</brocom:registrationStatus>
      </registrationHistory>
    </GMW_PO>
  </dispatchDocument>
</dispatchDataResponse>`;

const REJECTION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<dispatchDataResponse xmlns="http://www.broservices.nl/xsd/dsgmw/1.1"
  xmlns:brocom="http://www.broservices.nl/xsd/brocommon/3.0">
  <brocom:responseType>rejection</brocom:responseType>
  <brocom:rejectionReason>Het opgevraagde object bestaat niet.</brocom:rejectionReason>
</dispatchDataResponse>`;

describe("BroOndergrondSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("looks up a GMW object by BRO-id and normalizes XML coordinates", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(GMW_XML));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BroOndergrondSource(config);
    const out = await src.search({ query: "GMW000000036287", rows: 20 });

    const calledUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("/gm/gmw/v1/objects/GMW000000036287");
    expect(out.items).toHaveLength(1);

    const item = out.items[0];
    expect(item.broId).toBe("GMW000000036287");
    expect(item.object_type).toBe("GMW");
    expect(item.well_code).toBe("GMW38B125170");
    expect(item.latitude).toBe("51.945145560");
    expect(item.longitude).toBe("4.853433240");
    expect(item.rd_coordinates).toBe("118300.381 439767.501");
    expect(item.registration_status).toBe("geregistreerd");
    expect(out.endpoint).toContain("GMW000000036287");
  });

  it("routes a CPT id to the sondering service path", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(REJECTION_XML));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BroOndergrondSource(config);
    await src.search({ query: "cpt000000012345", rows: 5 });

    const calledUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("/sr/cpt/v1/objects/CPT000000012345");
  });

  it("returns empty with an access_note on a rejection response", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(REJECTION_XML));
    vi.stubGlobal("fetch", fetchMock);

    const src = new BroOndergrondSource(config);
    const out = await src.search({ query: "GMW999999999999", rows: 5 });

    expect(out.items).toHaveLength(0);
    expect(out.total).toBe(0);
    expect(out.access_note).toContain("Geen BRO-object");
  });

  it("filters refcodes domains when the query is not a BRO-id", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        refDomains: [
          {
            name: "BHR_AfwijkendGrondwaterRegime",
            uri: "urn:bro:bhr:AnomalousGroundwaterRegime",
            description: "De lijst met de waarden voor afwijkend grondwater regime.",
          },
          { name: "BRO_DATE", uri: "urn:bro:DateFormat", description: null },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const src = new BroOndergrondSource(config);
    const out = await src.search({ query: "grondwater", rows: 20 });

    const calledUrl = String((fetchMock.mock.calls[0] as unknown as Array<unknown>)[0]);
    expect(calledUrl).toContain("/bro/refcodes/v1/domains");
    expect(out.items).toHaveLength(1);
    expect(out.items[0].id).toBe("BHR_AfwijkendGrondwaterRegime");
    expect(out.items[0].object_type).toBe("refcode_domain");
    expect(out.total).toBe(1);
  });

  it("returns a capped refcodes list for an empty-ish query with no matches", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        refDomains: [
          { name: "BRO_DATE", uri: "urn:bro:DateFormat", description: null },
          { name: "BRO_TYPE", uri: "urn:bro:TypeFormat", description: "iets" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const src = new BroOndergrondSource(config);
    const out = await src.search({ query: "zzzz-no-match", rows: 20 });

    expect(out.items).toHaveLength(0);
    expect(out.total).toBe(0);
    expect(out.endpoint).toContain("/bro/refcodes/v1/domains");
  });
});
