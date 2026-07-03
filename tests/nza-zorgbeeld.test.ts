import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { NzaZorgbeeldSource } from "../src/sources/nza-zorgbeeld.js";

const config = loadConfig();

function xmlResponse(xml: string): Response {
  return new Response(xml, {
    status: 200,
    headers: { "content-type": "application/xml" },
  });
}

const SAMPLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<TL_RESTs>
  <TL_REST>
    <Date>2026-06-23T09:27:31.822Z</Date>
    <WaitingTime>21</WaitingTime>
    <InsufficientObservations>Nee</InsufficientObservations>
    <KVKNumber>41055629</KVKNumber>
    <CareProvider>Radboudumc</CareProvider>
    <CareProvider_AGBCode>06020502</CareProvider_AGBCode>
    <LocationKey>350a9eb2-afe6-4e43-b3df-539cdd686528</LocationKey>
    <Location_AGBCode>06020502</Location_AGBCode>
    <Location>Radboudumc</Location>
    <Street>Geert Grooteplein Zuid</Street>
    <StreetNumber>10</StreetNumber>
    <PostalCode>6525GA</PostalCode>
    <City>Nijmegen</City>
    <TreatmentKey>382d36c5-83d7-49bc-9bdf-2f70d02ef6eb</TreatmentKey>
    <TreatmentNumber>55</TreatmentNumber>
    <Treatment>Diagnostische en/of therapeutische kijkoperatie knie (orthopedie)</Treatment>
    <TreatmentType>Behandeling</TreatmentType>
    <Specialism>Orthopedie (305)</Specialism>
    <AllCareproviders>true</AllCareproviders>
  </TL_REST>
  <TL_REST>
    <Date>2026-06-23T09:27:31.822Z</Date>
    <InsufficientObservations>Ja</InsufficientObservations>
    <KVKNumber>41055629</KVKNumber>
    <CareProvider>Radboudumc</CareProvider>
    <Location>Radboudumc</Location>
    <TreatmentKey>aaa</TreatmentKey>
    <Treatment>Cataract-operatie</Treatment>
    <TreatmentType>Polikliniekbezoek</TreatmentType>
    <Specialism>Oogheelkunde (301)</Specialism>
    <City>Nijmegen</City>
  </TL_REST>
</TL_RESTs>`;

describe("NzaZorgbeeldSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes XML records and passes KVKNummer server-side", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(SAMPLE_XML));
    vi.stubGlobal("fetch", fetchMock);

    const src = new NzaZorgbeeldSource(config);
    const out = await src.search({ kvk: "41055629", rows: 20 });

    const calledUrl = String(
      (fetchMock.mock.calls[0] as unknown as Array<unknown>)[0],
    );
    expect(calledUrl).toContain("WaitingTimeMSZ");
    expect(calledUrl).toContain("KVKNummer=41055629");

    expect(out.items.length).toBe(2);
    const first = out.items[0];
    expect(first.careProvider).toBe("Radboudumc");
    expect(first.specialism).toBe("Orthopedie (305)");
    expect(first.waitingTimeDays).toBe(21);
    expect(first.title).toContain("Radboudumc");
    expect(first.address).toContain("6525GA");
    // AGB-code met voorloopnul mag niet naar getal coerceren.
    expect(first.agbCode).toBe("06020502");
  });

  it("returns null waiting time when observations are insufficient", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(SAMPLE_XML));
    vi.stubGlobal("fetch", fetchMock);

    const src = new NzaZorgbeeldSource(config);
    const out = await src.search({ rows: 20 });

    const cataract = out.items.find((i) => i.treatment === "Cataract-operatie");
    expect(cataract).toBeDefined();
    expect(cataract?.waitingTimeDays).toBeNull();
    expect(cataract?.insufficientObservations).toBe("Ja");
  });

  it("filters client-side on query text and treatmentType", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(SAMPLE_XML));
    vi.stubGlobal("fetch", fetchMock);

    const src = new NzaZorgbeeldSource(config);
    const out = await src.search({
      query: "oogheelkunde",
      treatmentType: "Polikliniekbezoek",
      rows: 20,
    });

    expect(out.items.length).toBe(1);
    expect(out.items[0].specialism).toBe("Oogheelkunde (301)");
    expect(out.total).toBe(1);
    expect(out.access_note).toBeTruthy();
  });

  it("returns empty result for an empty <TL_RESTs/> response", async () => {
    const fetchMock = vi.fn(async () => xmlResponse("<TL_RESTs/>"));
    vi.stubGlobal("fetch", fetchMock);

    const src = new NzaZorgbeeldSource(config);
    const out = await src.search({ kvk: "68666276", rows: 20 });

    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.endpoint).toContain("WaitingTimeMSZ");
  });

  it("caps results to the requested rows", async () => {
    const fetchMock = vi.fn(async () => xmlResponse(SAMPLE_XML));
    vi.stubGlobal("fetch", fetchMock);

    const src = new NzaZorgbeeldSource(config);
    const out = await src.search({ rows: 1 });

    expect(out.items.length).toBe(1);
    // total blijft eerlijk over de opgehaalde set.
    expect(out.total).toBe(2);
  });
});
