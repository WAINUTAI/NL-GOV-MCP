import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { koppelingPages, registerTools } from "../src/tools.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { setCrawlDelaysEnabled } from "../src/utils/http.js";
import { parseContribution, type GehoordContribution } from "../src/sources/gehoord.js";
import { parseVerslag, TweedeKamerDebattenSource, type DebatVergadering, type DebatVerslag } from "../src/sources/tweede-kamer-debatten.js";
import { debatDagen, debatDirectDag, debatKandidaten, koppelGehoord, type KoppelingDeps } from "../src/sources/debat-koppeling.js";
import { jsonResponse, xmlResponse } from "./helpers/config.js";

/* ------------------------------------------------------------------ */
/*  Debat-koppeling by debate id: Gehoord's tkDebateId is the objectid */
/*  of the debate's <activiteit> in the VLOS verslag. The fragment is  */
/*  matched inside that activiteit; zaal and time are the fallback.    */
/* ------------------------------------------------------------------ */

const BIKKERS = "1e232189-83d7-42d4-a048-c0c437b8b84f";
const PRICKAERTZ = "c0bfbae7-5c03-49e1-8bb6-a9ca2a4157ec";
const VOORZITTER = "2d9c8a4f-0d1b-4c43-9b1e-6b6d1c6f0001";
const KAMERLID = "7a4c3e21-5b6d-4e8f-9a0b-1c2d3e4f5a6b";

// The activiteit objectids of 28 October 2026: the begroting IenW split in two parts around the regeling.
const IENW_1 = "7438fcd5-6549-4a26-ad9e-2c00cad0e9ac";
const REGELING = "c8dcc19e-5cc7-4352-823b-c34cb644b2b6";
const IENW_2 = "bee3a017-d3d3-4616-89e4-51d6e79f1dd9";
const STALE = "0b6e6f43-1f6e-4b8e-8d47-3a9d1f0c0a11";

function spreker(objectid: string, voornaam: string, verslagnaam: string, fractie: string): string {
  return `<spreker soort="Tweede Kamerlid" objectid="${objectid}"><fractie>${fractie}</fractie><verslagnaam>${verslagnaam}</verslagnaam><voornaam>${voornaam}</voornaam><functie>lid Tweede Kamer</functie></spreker>`;
}

function woordvoerder(who: string, begin: string, eind: string, tekst: string, voorzitter = false): string {
  return `<woordvoerder objectid="w">${who}<markeertijdbegin>${begin}</markeertijdbegin><markeertijdeind>${eind}</markeertijdeind><isvoorzitter>${voorzitter}</isvoorzitter><tekst><alinea><alineaitem>Label:</alineaitem><alineaitem>${tekst}</alineaitem></alinea></tekst></woordvoerder>`;
}

function activiteit(objectid: string, soort: string, titel: string, parlisid: string, aanvang: string, eind: string, body: string): string {
  return `<activiteit soort="${soort}" objectid="${objectid}"><titel>${titel}</titel><onderwerp>${titel}</onderwerp>${parlisid ? `<parlisid>${parlisid}</parlisid>` : "<parlisid />"}<aanvangstijd>${aanvang}</aanvangstijd><eindtijd>${eind}</eindtijd><activiteitdeel><activiteititem>${body}</activiteititem></activiteitdeel></activiteit>`;
}

function vlos(soort: "Plenair" | "Commissie", titel: string, zaal: string, datum: string, activiteiten: string, publicatie = "Tussenpublicatie", status = "Ongecorrigeerd"): string {
  return `<?xml version="1.0" encoding="UTF-8"?><vlosCoreDocument soort="${publicatie}" status="${status}" xmlns="http://www.tweedekamer.nl/ggm/vergaderverslag/v1.0"><vergadering soort="${soort}" objectid="v"><titel>${titel}</titel><zaal>${zaal}</zaal><vergaderjaar>2026-2027</vergaderjaar><vergaderingnummer>17</vergaderingnummer><datum>${datum}T00:00:00</datum>${activiteiten}</vergadering></vlosCoreDocument>`;
}

const BIKKERS_SPREKER = spreker(BIKKERS, "Bart", "Bikkers", "VVD");

/** 28 October 2026 (UTC+1), as VLOS has it: Bikkers speaks in both parts of the begroting IenW, a regeling in between. */
const SPLIT_XML = vlos(
  "Plenair",
  "17e vergadering, woensdag 28 oktober 2026",
  "Plenaire zaal",
  "2026-10-28",
  activiteit("2c3450bc-7ced-4f5b-a749-8168b971dbad", "Opening", "Opening", "", "2026-10-28T10:15:42", "2026-10-28T10:15:49", "") +
    activiteit(IENW_1, "Plenair debat", "Begrotingen Infrastructuur en Waterstaat en Mobiliteitsfonds 2027", "2026A05415", "2026-10-28T10:56:57", "2026-10-28T13:40:35",
      woordvoerder(BIKKERS_SPREKER, "2026-10-28T11:00:00", "2026-10-28T11:05:00", "Eerste termijn: de VVD wil investeren in wegen.")) +
    activiteit(REGELING, "Regeling van werkzaamheden", "Regeling van werkzaamheden", "", "2026-10-28T13:40:44", "2026-10-28T13:41:19",
      woordvoerder(spreker(VOORZITTER, "Thom", "Van Campen", "VVD"), "2026-10-28T13:40:44", "2026-10-28T13:41:19", "Ik stel voor om toe te voegen aan de agenda.", true)) +
    activiteit(IENW_2, "Plenair debat", "Begrotingen Infrastructuur en Waterstaat en Mobiliteitsfonds 2027", "2026A05415", "2026-10-28T13:41:19", "2026-10-28T17:22:21",
      woordvoerder(BIKKERS_SPREKER, "2026-10-28T14:25:32", "2026-10-28T14:28:07", "Dit zijn twee vragen ineen. De heer Prickaertz begint erover dat de VVD natuur en milieu belangrijk vindt.")),
);

const VERG_PLENAIR: DebatVergadering = {
  vergadering_id: "4b3ce9ac-5000-4cf6-be9a-4fb865064e57",
  verslag_id: "2e3c5ee9-6a4f-4332-9204-cccba3997555",
  soort: "Plenair",
  titel: "17e vergadering, woensdag 28 oktober 2026",
  zaal: "Plenaire zaal",
  vergaderjaar: "2026-2027",
  vergaderingnummer: 17,
  datum: "2026-10-28",
  aanvangstijd: "2026-10-28T10:15:00+01:00",
  eindtijd: "2026-10-28T19:27:11+01:00",
  verslag_status: "Ongecorrigeerd",
  verslag_soort: "Tussenpublicatie",
};

const IENW_URL = "https://debatdirect.tweedekamer.nl/2026-10-28/infrastructuur-waterstaat/plenaire-zaal/begroting-infrastructuur-en-waterstaat-2027-10-15";
const plenairDebate = (tkDebateId: string | undefined, over: Record<string, unknown> = {}) => ({
  id: tkDebateId === IENW_1 ? 303711 : 303722,
  chamber: "tk",
  tkDebateId,
  title: "Begrotingen Infrastructuur en Waterstaat en Mobiliteitsfonds 2027",
  status: "ended",
  hall: "Plenaire zaal",
  locationId: "plenaire-zaal",
  debateType: "Plenair debat",
  startsAt: "2026-10-28T09:56:57.000Z",
  startedAt: "2026-10-28T09:56:57.000Z",
  url: IENW_URL,
  tkActivityId: null,
  tkActivityNumber: null,
  ...over,
});

function hit(id: number, debate: Record<string, unknown>, over: Record<string, unknown> = {}): GehoordContribution {
  return parseContribution({
    id,
    debateId: debate.id,
    text: "Want de heer Bikkers begint over dat de VVD'er natuur en milieu belangrijk vindt.",
    speakerLabel: BIKKERS,
    speakerName: "Bart Bikkers",
    speakerParty: "VVD",
    startTime: "2026-10-28T13:25:32.720Z",
    endTime: "2026-10-28T13:27:09.000Z",
    debate,
    ...over,
  });
}

const NOW = Date.parse("2026-11-04T12:00:00Z");

function fakeDeps(opts: { days?: Record<string, DebatVergadering[]>; verslagen?: Record<string, DebatVerslag> } = {}) {
  const calls = { days: [] as string[], verslagen: [] as string[] };
  const deps: KoppelingDeps = {
    now: () => NOW,
    debatten: {
      vergaderingenOp: async (day: string) => {
        calls.days.push(day);
        return opts.days?.[day] ?? [];
      },
      getVerslag: async (v) => {
        calls.verslagen.push(v.verslag_id);
        const verslag = opts.verslagen?.[v.verslag_id];
        if (!verslag) throw new Error("not found");
        return verslag;
      },
    },
  };
  return { deps, calls };
}

const split = parseVerslag(SPLIT_XML, VERG_PLENAIR.verslag_id);

describe("parseVerslag lists every activiteit with its objectid, parlisid, times and fragments", () => {
  it("keeps the two parts of a split begroting apart, each with its own fragments and the shared parlisid", () => {
    expect(split.activiteiten.map((a) => [a.objectid, a.soort, a.parlisid, a.fragmentVan, a.fragmentTot])).toEqual([
      ["2c3450bc-7ced-4f5b-a749-8168b971dbad", "Opening", undefined, 0, 0],
      [IENW_1, "Plenair debat", "2026A05415", 0, 1],
      [REGELING, "Regeling van werkzaamheden", undefined, 1, 2],
      [IENW_2, "Plenair debat", "2026A05415", 2, 3],
    ]);
    expect(split.activiteiten[3]).toMatchObject({ titel: "Begrotingen Infrastructuur en Waterstaat en Mobiliteitsfonds 2027", aanvang: "2026-10-28T13:41:19", eind: "2026-10-28T17:22:21" });
    expect(split.fragments[2].tekst).toContain("Prickaertz begint erover");
  });

  it("reads the meeting day from a Debat Direct url, and adds the day before for a plenary debate after midnight", () => {
    expect(debatDirectDag(IENW_URL)).toBe("2026-10-28");
    expect(debatDirectDag("https://gehoord.de/beraadslagingen/1")).toBeUndefined();
    expect(debatDagen(plenairDebate(IENW_2))).toEqual(["2026-10-28"]);
    // 00:20 on 15 October (summer time): the url's day and the sitting of the 14th.
    const night = plenairDebate(IENW_2, { startedAt: "2026-10-14T22:20:00.000Z", url: "https://debatdirect.tweedekamer.nl/2026-10-15/x/plenaire-zaal/y" });
    expect(debatDagen(night)).toEqual(["2026-10-15", "2026-10-14"]);
    // Without a url: vergaderDag alone.
    expect(debatDagen({ ...night, url: undefined })).toEqual(["2026-10-14"]);
  });
});

describe("koppelGehoord by debate id (methode debat_id)", () => {
  it("direct match: the activiteit with the tkDebateId, its fragment and parlisid, one day and one verslag", async () => {
    const { deps, calls } = fakeDeps({ days: { "2026-10-28": [VERG_PLENAIR] }, verslagen: { [VERG_PLENAIR.verslag_id]: split } });
    const [k] = (await koppelGehoord([hit(1, plenairDebate(IENW_2))], deps)).koppelingen;
    expect(k).toMatchObject({ status: "officieel", methode: "debat_id", overlap_s: 96, activiteit: { objectid: IENW_2, parlisid: "2026A05415", soort: "Plenair debat" } });
    expect(k.fragment?.tekst).toContain("De heer Prickaertz begint erover");
    expect(calls).toEqual({ days: ["2026-10-28"], verslagen: [VERG_PLENAIR.verslag_id] });
  });

  it("split begroting: each part's hit stays inside its own activiteit, even where the speaker spoke in the other", async () => {
    const { deps } = fakeDeps({ days: { "2026-10-28": [VERG_PLENAIR] }, verslagen: { [VERG_PLENAIR.verslag_id]: split } });
    const deel1 = hit(2, plenairDebate(IENW_1), { startTime: "2026-10-28T10:01:00Z", endTime: "2026-10-28T10:02:00Z" });
    const deel2 = hit(3, plenairDebate(IENW_2));
    // Gehoord says part 1, at a moment inside part 1 where Bikkers has no fragment: not looked for elsewhere.
    const leeg = hit(4, plenairDebate(IENW_1), { startTime: "2026-10-28T11:30:00Z", endTime: "2026-10-28T11:31:00Z" });
    const r = await koppelGehoord([deel1, deel2, leeg], deps);
    expect(r.koppelingen[0]).toMatchObject({ status: "officieel", methode: "debat_id", activiteit: { objectid: IENW_1 } });
    expect(r.koppelingen[0].fragment?.tekst).toContain("Eerste termijn");
    expect(r.koppelingen[1]).toMatchObject({ status: "officieel", methode: "debat_id", activiteit: { objectid: IENW_2 } });
    expect(r.koppelingen[1].fragment?.tekst).toContain("twee vragen ineen");
    expect(r.koppelingen[2]).toMatchObject({ status: "niet_gekoppeld", methode: "debat_id", activiteit: { objectid: IENW_1 } });
    expect(r.koppelingen[2].reden).toMatch(/^geen fragment van deze spreker rond dit tijdstip in dit debat/);
    expect(r.verslagen).toBe(1);
  });

  it("a hit Gehoord files under a debate but that runs past its activiteit's end is looked for in the whole verslag", async () => {
    // 14 Oct 2026 (begroting VWS deel 1): Gehoord counts the stemmingen after the debate to it, the VLOS has them in their own activiteit.
    const { deps } = fakeDeps({ days: { "2026-10-28": [VERG_PLENAIR] }, verslagen: { [VERG_PLENAIR.verslag_id]: split } });
    // Part 1 ends 13:40:35; the chair speaks in the regeling 13:40:44-13:41:19 (12:40:44Z).
    const voorzitter = hit(12, plenairDebate(IENW_1), { speakerLabel: VOORZITTER, speakerName: "Thom van Campen", startTime: "2026-10-28T12:40:30Z", endTime: "2026-10-28T12:41:15Z" });
    // Bikkers at a moment he spoke only in part 2, filed under part 1: the fragment that is there.
    const deel2tijd = hit(13, plenairDebate(IENW_1));
    const r = await koppelGehoord([voorzitter, deel2tijd], deps);
    expect(r.koppelingen[0]).toMatchObject({ status: "officieel", methode: "debat_id", activiteit: { objectid: REGELING } });
    expect(r.koppelingen[0].fragment?.tekst).toContain("toe te voegen aan de agenda");
    expect(r.koppelingen[1]).toMatchObject({ status: "officieel", methode: "debat_id", activiteit: { objectid: IENW_2 } });
    expect(r.koppelingen[1].fragment?.tekst).toContain("twee vragen ineen");
  });

  it("stale id: no activiteit has it, so zaal and time link it, without reading another verslag", async () => {
    const { deps, calls } = fakeDeps({ days: { "2026-10-28": [VERG_PLENAIR] }, verslagen: { [VERG_PLENAIR.verslag_id]: split } });
    const [k] = (await koppelGehoord([hit(5, plenairDebate(STALE))], deps)).koppelingen;
    expect(k).toMatchObject({ status: "officieel", methode: "zaal_tijd", activiteit: { objectid: IENW_2, parlisid: "2026A05415" } });
    expect(k.fragment?.tekst).toContain("twee vragen ineen");
    expect(calls.verslagen).toEqual([VERG_PLENAIR.verslag_id]);
  });

  it("without a tkDebateId the route is zaal and time, as before", async () => {
    const { deps } = fakeDeps({ days: { "2026-10-28": [VERG_PLENAIR] }, verslagen: { [VERG_PLENAIR.verslag_id]: split } });
    const [k] = (await koppelGehoord([hit(6, plenairDebate(undefined))], deps)).koppelingen;
    expect(k).toMatchObject({ status: "officieel", methode: "zaal_tijd" });
  });

  it("no verslag yet: a recent commissiedebat with a tkDebateId reads nothing and is nog_geen_verslag, without a methode", async () => {
    // The day has only a vergadering in another zaal, hours later: not a candidate.
    const elders: DebatVergadering = { vergadering_id: "e1", verslag_id: "e2", soort: "Commissie", titel: "Iets anders", zaal: "Troelstrazaal", aanvangstijd: "2026-11-03T16:00:00+01:00", eindtijd: "2026-11-03T18:00:00+01:00" };
    const { deps, calls } = fakeDeps({ days: { "2026-11-03": [elders] } });
    const debate = { id: 312900, chamber: "tk", tkDebateId: "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d", title: "Woningbouw", status: "ended", hall: "Thorbeckezaal", locationId: "thorbeckezaal", debateType: "Commissiedebat", startsAt: "2026-11-03T09:00:00.000Z", startedAt: "2026-11-03T09:02:00.000Z", url: "https://debatdirect.tweedekamer.nl/2026-11-03/x/thorbeckezaal/woningbouw-10-00" };
    const [k] = (await koppelGehoord([hit(7, debate, { startTime: "2026-11-03T09:30:00Z", endTime: "2026-11-03T09:31:00Z" })], deps)).koppelingen;
    expect(k.status).toBe("nog_geen_verslag");
    expect(k.methode).toBeUndefined();
    expect(calls.verslagen).toEqual([]);
  });
});

describe("two debates in one zaal on one day", () => {
  // Thorbeckezaal, 29 October 2026 (UTC+1): A 10:00-10:15, B 10:45-12:00. Debat Direct started B's stream at 10:20,
  // so zaal and time pick A (20 minutes off against 25); the id finds B.
  const A = "aaaaaaaa-0000-4000-8000-00000000000a";
  const B = "bbbbbbbb-0000-4000-8000-00000000000b";
  const vergA: DebatVergadering = { vergadering_id: "va", verslag_id: "a5a5a5a5-0000-4000-8000-000000000001", soort: "Commissie", titel: "Procedurevergadering", zaal: "Thorbeckezaal", datum: "2026-10-29", aanvangstijd: "2026-10-29T10:00:00+01:00", eindtijd: "2026-10-29T10:15:00+01:00", verslag_status: "Ongecorrigeerd", verslag_soort: "Tussenpublicatie" };
  const vergB: DebatVergadering = { vergadering_id: "vb", verslag_id: "b5b5b5b5-0000-4000-8000-000000000002", soort: "Commissie", titel: "Vreemdelingen- en asielbeleid", zaal: "Thorbeckezaal", datum: "2026-10-29", aanvangstijd: "2026-10-29T10:45:00+01:00", eindtijd: "2026-10-29T12:00:00+01:00", verslag_status: "Ongecorrigeerd", verslag_soort: "Tussenpublicatie" };
  const lid = spreker(KAMERLID, "Anna", "Jansen", "CDA");
  const verslagA = parseVerslag(vlos("Commissie", "Procedurevergadering", "Thorbeckezaal", "2026-10-29",
    activiteit(A, "Procedurevergadering", "Procedurevergadering", "2026A06001", "2026-10-29T10:00:00", "2026-10-29T10:15:00", woordvoerder(lid, "2026-10-29T10:05:00", "2026-10-29T10:06:00", "Een procedurevoorstel.")), "Eindpublicatie", "Gecorrigeerd"), vergA.verslag_id);
  const verslagB = parseVerslag(vlos("Commissie", "Vreemdelingen- en asielbeleid", "Thorbeckezaal", "2026-10-29",
    activiteit(B, "Commissiedebat", "Vreemdelingen- en asielbeleid", "2026A06002", "2026-10-29T10:45:00", "2026-10-29T12:00:00", woordvoerder(lid, "2026-10-29T10:48:00", "2026-10-29T10:55:00", "Het asielbeleid moet beter."))), vergB.verslag_id);
  const debate = (tkDebateId?: string) => ({ id: 303800, chamber: "tk", tkDebateId, title: "Vreemdelingen- en asielbeleid", status: "ended", hall: "Thorbeckezaal", locationId: "thorbeckezaal", debateType: "Commissiedebat", startsAt: "2026-10-29T09:45:00.000Z", startedAt: "2026-10-29T09:20:00.000Z", url: "https://debatdirect.tweedekamer.nl/2026-10-29/x/thorbeckezaal/y", tkActivityNumber: null });
  const at = { speakerLabel: KAMERLID, speakerName: "Anna Jansen", speakerParty: "CDA", startTime: "2026-10-29T09:50:00Z", endTime: "2026-10-29T09:51:00Z" };

  it("by id: reads A (the zaal-and-time match), does not find the id, then reads B and links there", async () => {
    const { deps, calls } = fakeDeps({ days: { "2026-10-29": [vergA, vergB] }, verslagen: { [vergA.verslag_id]: verslagA, [vergB.verslag_id]: verslagB } });
    const [k] = (await koppelGehoord([hit(8, debate(B), at)], deps)).koppelingen;
    expect(k).toMatchObject({ status: "officieel", methode: "debat_id", vergadering: { vergadering_id: "vb" }, activiteit: { objectid: B, parlisid: "2026A06002" } });
    expect(k.fragment?.tekst).toBe("Het asielbeleid moet beter.");
    expect(calls.verslagen).toEqual([vergA.verslag_id, vergB.verslag_id]);
  });

  it("without the id, zaal and time stop at A", async () => {
    const { deps } = fakeDeps({ days: { "2026-10-29": [vergA, vergB] }, verslagen: { [vergA.verslag_id]: verslagA, [vergB.verslag_id]: verslagB } });
    const [k] = (await koppelGehoord([hit(9, debate(undefined), at)], deps)).koppelingen;
    expect(k).toMatchObject({ status: "niet_gekoppeld", methode: "zaal_tijd", vergadering: { vergadering_id: "va" } });
  });

  it("orders the candidates: the match, then the same zaal, then another zaal near the start; nothing far away", () => {
    const anders: DebatVergadering = { ...vergB, vergadering_id: "vc", verslag_id: "c", zaal: "Groen van Prinstererzaal", aanvangstijd: "2026-10-29T10:30:00+01:00", eindtijd: undefined };
    const ver: DebatVergadering = { ...vergB, vergadering_id: "vd", verslag_id: "d", zaal: "Troelstrazaal", aanvangstijd: "2026-10-29T14:00:00+01:00" };
    expect(debatKandidaten(debate(B), [ver, anders, vergB, vergA], vergA).map((v) => v.vergadering_id)).toEqual(["va", "vb", "vc"]);
  });

  it("reads every zaal-and-time verslag before a candidate: a debate without a verslag takes no other hit's slot", async () => {
    // 3 November: a hoorzitting in the Troelstrazaal at 12:31 has no verslag yet; a Thorbeckezaal vergadering 10:00-13:52 is a candidate.
    const thorbecke: DebatVergadering = { ...vergA, vergadering_id: "vt", verslag_id: "7ef9c158-0000-4000-8000-000000000003", titel: "Commissie", datum: "2026-11-03", aanvangstijd: "2026-11-03T10:00:00+01:00", eindtijd: "2026-11-03T13:52:00+01:00" };
    const hoorzitting = { id: 307206, chamber: "tk", tkDebateId: "3e3e3e3e-0000-4000-8000-00000000003e", title: "Hoorzitting", status: "ended", hall: "Troelstrazaal", locationId: "troelstrazaal", debateType: "Hoorzitting", startsAt: "2026-11-03T11:30:00.000Z", startedAt: "2026-11-03T11:31:00.000Z", url: "https://debatdirect.tweedekamer.nl/2026-11-03/x/troelstrazaal/hoorzitting-12-30" };
    const zonder = hit(14, hoorzitting, { speakerLabel: KAMERLID, startTime: "2026-11-03T11:40:00Z", endTime: "2026-11-03T11:41:00Z" });
    const plenair = hit(15, plenairDebate(IENW_2));
    const days = { "2026-11-03": [thorbecke], "2026-10-28": [VERG_PLENAIR] };
    const verslagen = { [thorbecke.verslag_id]: parseVerslag(vlos("Commissie", "Commissie", "Thorbeckezaal", "2026-11-03", ""), thorbecke.verslag_id), [VERG_PLENAIR.verslag_id]: split };
    for (const order of [[zonder, plenair], [plenair, zonder]]) {
      const { deps, calls } = fakeDeps({ days, verslagen });
      const r = await koppelGehoord(order, { ...deps, maxVerslagen: 1 });
      const [kz, kp] = order[0] === zonder ? r.koppelingen : [...r.koppelingen].reverse();
      expect(calls.verslagen).toEqual([VERG_PLENAIR.verslag_id]);
      expect(kp).toMatchObject({ status: "officieel", methode: "debat_id", activiteit: { objectid: IENW_2 } });
      expect(kz.status).toBe("nog_geen_verslag");
      expect(kz.reden).toMatch(/2 tot 12 dagen/);
    }
    // With budget left the candidate is read; it does not hold the id, so the status stays.
    const { deps, calls } = fakeDeps({ days, verslagen });
    const [k] = (await koppelGehoord([zonder], deps)).koppelingen;
    expect(calls.verslagen).toEqual([thorbecke.verslag_id]);
    expect(k.status).toBe("nog_geen_verslag");
  });

  it("spends at most the verslag budget on candidates", async () => {
    const { deps, calls } = fakeDeps({ days: { "2026-10-29": [vergA, vergB] }, verslagen: { [vergA.verslag_id]: verslagA, [vergB.verslag_id]: verslagB } });
    const [k] = (await koppelGehoord([hit(10, debate(B), at)], { ...deps, maxVerslagen: 1 })).koppelingen;
    expect(calls.verslagen).toEqual([vergA.verslag_id]);
    // A is read and lacks the id: zaal and time there.
    expect(k).toMatchObject({ status: "niet_gekoppeld", methode: "zaal_tijd" });
  });
});

describe("a plenary night sitting past midnight", () => {
  // 14 October 2026 (UTC+2): the sitting runs to 01:15 on the 15th; Debat Direct dates the night debate the 15th.
  const NIGHT = "d1d1d1d1-0000-4000-8000-00000000000d";
  const verg14: DebatVergadering = { ...VERG_PLENAIR, vergadering_id: "p14", verslag_id: "f1f1f1f1-0000-4000-8000-000000000014", titel: "10e vergadering, dinsdag 14 oktober 2026", datum: "2026-10-14", aanvangstijd: "2026-10-14T14:00:00+02:00", eindtijd: "2026-10-15T01:15:00+02:00" };
  const verg15: DebatVergadering = { ...VERG_PLENAIR, vergadering_id: "p15", verslag_id: "f1f1f1f1-0000-4000-8000-000000000015", titel: "11e vergadering, woensdag 15 oktober 2026", datum: "2026-10-15", aanvangstijd: "2026-10-15T10:15:00+02:00", eindtijd: "2026-10-15T23:00:00+02:00" };
  const verslag14 = parseVerslag(vlos("Plenair", verg14.titel, "Plenaire zaal", "2026-10-14",
    activiteit(NIGHT, "Plenair debat", "Wet op de nacht", "", "2026-10-15T00:10:00", "2026-10-15T01:10:00", woordvoerder(BIKKERS_SPREKER, "2026-10-15T00:30:00", "2026-10-15T00:34:00", "Ook om half een 's nachts wil de VVD dit.")), "Tussenpublicatie"), verg14.verslag_id);

  it("finds the activiteit in the sitting of the day before, looking at both days", async () => {
    const { deps, calls } = fakeDeps({ days: { "2026-10-14": [verg14], "2026-10-15": [verg15] }, verslagen: { [verg14.verslag_id]: verslag14 } });
    const debate = plenairDebate(NIGHT, { title: "Wet op de nacht", startsAt: "2026-10-14T22:10:00.000Z", startedAt: "2026-10-14T22:10:00.000Z", url: "https://debatdirect.tweedekamer.nl/2026-10-15/x/plenaire-zaal/wet-op-de-nacht" });
    const [k] = (await koppelGehoord([hit(11, debate, { startTime: "2026-10-14T22:31:00Z", endTime: "2026-10-14T22:32:00Z" })], deps)).koppelingen;
    expect(k).toMatchObject({ status: "officieel", methode: "debat_id", vergadering: { vergadering_id: "p14" }, activiteit: { objectid: NIGHT } });
    expect(k.fragment?.tekst).toContain("half een");
    expect(calls.days.sort()).toEqual(["2026-10-14", "2026-10-15"]);
    expect(calls.verslagen).toEqual([verg14.verslag_id]);
  });
});

/* ------------------------------------------------------------------ */
/*  Through the tool: methode in data.koppeling, the commissie page     */
/*  from the verslag's parlisid when Gehoord has no tkActivityNumber.   */
/* ------------------------------------------------------------------ */

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
const tools = new Map<string, { schema: Record<string, { parse: (v: unknown) => unknown }>; handler: Handler }>();
registerTools({
  registerTool(name: string, cfg: { inputSchema?: Record<string, { parse: (v: unknown) => unknown }> }, handler: Handler) {
    tools.set(name, { schema: cfg.inputSchema ?? {}, handler });
  },
} as unknown as McpServer);

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const tool = tools.get(name)!;
  const parsed: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.schema)) parsed[key] = schema.parse(args[key]);
  return JSON.parse((await tool.handler(parsed)).content[0].text);
}

describe("gehoord_debatten_search links by debate id", () => {
  beforeEach(() => {
    clearHttpCache();
    setCrawlDelaysEnabled(false);
    vi.stubEnv("GEHOORD_KEY", "k");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(() => setCrawlDelaysEnabled(true));

  const STARTUPS = "e5e5e5e5-0000-4000-8000-0000000000e5";
  const COMMISSIE_XML = vlos("Commissie", "Start-ups en scale-ups", "Thorbeckezaal", "2026-10-28",
    activiteit(STARTUPS, "Commissiedebat", "Start-ups en scale-ups", "2026A05087", "2026-10-28T10:00:00", "2026-10-28T12:19:15", woordvoerder(spreker(PRICKAERTZ, "Erwin", "Prickaertz", "PVV"), "2026-10-28T10:20:00", "2026-10-28T10:24:00", "Start-ups verdienen minder regels.")));

  it("gives methode debat_id and the commissie page from the activiteit's parlisid, with no Activiteit lookup", async () => {
    const urls: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      urls.push(url);
      if (url.hostname === "gehoord.de" && url.pathname === "/api/v1/contributions") {
        const debate = { id: 303748, chamber: "tk", tkDebateId: STARTUPS, title: "Start-ups en scale-ups", status: "ended", hall: "Thorbeckezaal", locationId: "thorbeckezaal", debateType: "Commissiedebat", startsAt: "2026-10-28T09:00:00.000Z", startedAt: "2026-10-28T09:00:40.000Z", url: "https://debatdirect.tweedekamer.nl/2026-10-28/x/thorbeckezaal/start-ups-en-scale-ups-10-00", tkActivityId: null, tkActivityNumber: null };
        const c = { id: 900, debateId: 303748, text: "Start-ups verdienen minder regels.", speakerLabel: PRICKAERTZ, speakerName: "Erwin Prickaertz", speakerParty: "PVV", startTime: "2026-10-28T09:21:00Z", endTime: "2026-10-28T09:22:00Z", debate };
        return jsonResponse({ data: [c], pagination: { total: 1, hasMore: false } });
      }
      if (url.hostname === "gegevensmagazijn.tweedekamer.nl") {
        if (url.pathname.endsWith("/Vergadering")) {
          return jsonResponse({ value: [{ Id: "c0000000-0000-4000-8000-0000000000c1", Soort: "Commissie", Titel: "Start-ups en scale-ups", Zaal: "Thorbeckezaal", Vergaderjaar: "2026-2027", Nummer: 12, Datum: "2026-10-28T00:00:00+01:00", Aanvangstijd: "2026-10-28T10:00:00+01:00", Eindtijd: "2026-10-28T12:19:15+01:00", Verslag: [{ Id: "c0000000-0000-4000-8000-0000000000c2", Soort: "Tussenpublicatie", Status: "Ongecorrigeerd", GewijzigdOp: "2026-11-02T13:40:14+01:00", Verwijderd: false }] }] });
        }
        if (url.pathname.includes("/Verslag(")) return xmlResponse(COMMISSIE_XML);
        if (url.pathname.endsWith("/Activiteit")) return jsonResponse({ value: [] });
      }
      return jsonResponse({ error: "unexpected" }, 404);
    }));
    const out = await call("gehoord_debatten_search", { query: "start-ups regels" });
    const [r] = out.records;
    expect(r.source_name).toBe("tweedekamer");
    expect(r.data.koppeling).toMatchObject({ status: "officieel", methode: "debat_id" });
    expect(r.data.tekst).toBe("Start-ups verdienen minder regels.");
    expect(r.canonical_url).toBe("https://www.tweedekamer.nl/debat_en_vergadering/commissievergaderingen/details?id=2026A05087");
    expect(urls.some((u) => u.pathname.endsWith("/Activiteit"))).toBe(false);
    // The Vergadering list asks for Eindtijd, which orders the candidates.
    expect(urls.find((u) => u.pathname.endsWith("/Vergadering"))?.searchParams.get("$select")).toContain("Eindtijd");
  });

  it("koppelingPages: Gehoord's tkActivityNumber wins over the parlisid; the parlisid only for a commissie page", async () => {
    const lookup = vi.spyOn(TweedeKamerDebattenSource.prototype, "commissieUrl").mockResolvedValue("https://example.org/lookup");
    const commissie: DebatVergadering = { vergadering_id: "vc1", verslag_id: "x", soort: "Commissie", titel: "Start-ups en scale-ups" };
    const k = { status: "officieel" as const, vergadering: commissie, activiteit: { objectid: STARTUPS, parlisid: "2026A05087", titel: "Start-ups en scale-ups" } };
    const viaParlis = await koppelingPages([k], Date.now() + 5_000, [{ tkActivityNumber: undefined }]);
    expect(viaParlis.get("vc1")).toBe("https://www.tweedekamer.nl/debat_en_vergadering/commissievergaderingen/details?id=2026A05087");
    const viaGehoord = await koppelingPages([k], Date.now() + 5_000, [{ tkActivityNumber: "2026A09999" }]);
    expect(viaGehoord.get("vc1")).toBe("https://www.tweedekamer.nl/debat_en_vergadering/commissievergaderingen/details?id=2026A09999");
    const plenair = { status: "officieel" as const, vergadering: VERG_PLENAIR, activiteit: { objectid: IENW_2, parlisid: "2026A05415", titel: "IenW" } };
    const plen = await koppelingPages([plenair], Date.now() + 5_000, [{}]);
    expect(plen.get(VERG_PLENAIR.vergadering_id)).toBe("https://www.tweedekamer.nl/kamerstukken/plenaire_verslagen/detail/2026-2027/17");
    expect(lookup).not.toHaveBeenCalled();
  });
});
