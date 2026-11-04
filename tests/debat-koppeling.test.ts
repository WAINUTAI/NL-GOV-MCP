import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { setCrawlDelaysEnabled } from "../src/utils/http.js";
import { GehoordSource, parseContribution, type GehoordContribution } from "../src/sources/gehoord.js";
import { parseVerslag, phrasePosition, TweedeKamerDebattenSource, type DebatFragment, type DebatVergadering, type DebatVerslag } from "../src/sources/tweede-kamer-debatten.js";
import { koppelingPages, officialPassage } from "../src/tools.js";
import {
  KOPPELING_DEADLINE_MS,
  KOPPELING_MAX_DAGEN,
  KOPPELING_MAX_VERSLAGEN,
  amsterdamDay,
  amsterdamLocalToEpoch,
  amsterdamOffsetMinutes,
  bestFragment,
  fragmentIntervals,
  koppelGehoord,
  koppelingCounts,
  matchVergadering,
  sameZaal,
  vergaderDag,
  type KoppelingDeps,
} from "../src/sources/debat-koppeling.js";
import { jsonResponse, testConfig, xmlResponse } from "./helpers/config.js";

/* ------------------------------------------------------------------ */
/*  Debat-koppeling: a Gehoord.de hit to its fragment in the official  */
/*  verslag (persoon_id + time overlap), with an honest status else.   */
/* ------------------------------------------------------------------ */

const BIKKERS = "1e232189-83d7-42d4-a048-c0c437b8b84f";
const PRICKAERTZ = "c0bfbae7-5c03-49e1-8bb6-a9ca2a4157ec";
const MUTLUER = "5855593f-f06c-42e5-950c-02762b7941bc";

function spreker(objectid: string, voornaam: string, verslagnaam: string, fractie: string): string {
  return `<spreker soort="Tweede Kamerlid" objectid="${objectid}"><fractie>${fractie}</fractie><aanhef>De heer</aanhef><verslagnaam>${verslagnaam}</verslagnaam><voornaam>${voornaam}</voornaam><functie>lid Tweede Kamer</functie></spreker>`;
}

/** 28 October 2026 (winter time, UTC+1): Prickaertz interrupts, Bikkers answers from the very second the interruption ends. */
const PLENAIR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<vlosCoreDocument soort="Tussenpublicatie" status="Ongecorrigeerd" xmlns="http://www.tweedekamer.nl/ggm/vergaderverslag/v1.0">
<vergadering soort="Plenair" objectid="e1d00454-a5bd-4242-909e-380b57074ba5"><titel>17e vergadering, woensdag 28 oktober 2026</titel><zaal>Plenaire zaal</zaal><vergaderjaar>2026-2027</vergaderjaar><vergaderingnummer>17</vergaderingnummer><datum>2026-10-28T00:00:00</datum>
<activiteit soort="Plenair debat"><onderwerp>Begroting Infrastructuur en Waterstaat 2027</onderwerp><activiteitdeel><activiteititem>
<woordvoerder objectid="w-1">${spreker(BIKKERS, "Bart", "Bikkers", "VVD")}<markeertijdbegin>2026-10-28T14:20:00</markeertijdbegin><markeertijdeind>2026-10-28T14:25:00</markeertijdeind><isvoorzitter>false</isvoorzitter>
<tekst><alinea><alineaitem>De heer <nadruk type="Vet">Bikkers</nadruk> (VVD):</alineaitem><alineaitem>Voorzitter. De VVD wil investeren in wegen.</alineaitem></alinea></tekst>
<interrumpant objectid="i-1">${spreker(PRICKAERTZ, "Erwin", "Prickaertz", "PVV")}<markeertijdbegin>2026-10-28T14:25:21</markeertijdbegin><markeertijdeind>2026-10-28T14:25:32</markeertijdeind><isvoorzitter>false</isvoorzitter>
<tekst><alinea><alineaitem>De heer <nadruk type="Vet">Prickaertz</nadruk> (PVV):</alineaitem><alineaitem>Hoe reflecteert meneer Bikkers hierop?</alineaitem></alinea></tekst></interrumpant>
</woordvoerder>
<woordvoerder objectid="w-2">${spreker(BIKKERS, "Bart", "Bikkers", "VVD")}<markeertijdbegin>2026-10-28T14:25:32</markeertijdbegin><markeertijdeind>2026-10-28T14:28:07</markeertijdeind><isvoorzitter>false</isvoorzitter>
<tekst><alinea><alineaitem>De heer <nadruk type="Vet">Bikkers</nadruk> (VVD):</alineaitem><alineaitem>Dit zijn twee vragen ineen. De heer Prickaertz begint erover dat de VVD natuur en milieu belangrijk vindt.</alineaitem></alinea></tekst>
</woordvoerder></activiteititem></activiteitdeel></activiteit></vergadering></vlosCoreDocument>`;

/** 8 October 2026 (summer time, UTC+2): a commissiedebat in the Klompezaal (written without the accent Gehoord uses). */
const COMMISSIE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<vlosCoreDocument soort="Eindpublicatie" status="Gecorrigeerd" xmlns="http://www.tweedekamer.nl/ggm/vergaderverslag/v1.0">
<vergadering soort="Commissie" objectid="x"><titel>IMF</titel><zaal>Klompezaal</zaal><datum>2026-10-08T00:00:00</datum>
<activiteit soort="Commissiedebat"><onderwerp>IMF</onderwerp><activiteitdeel><activiteititem>
<woordvoerder objectid="w-9">${spreker(MUTLUER, "Songül", "Mutluer", "PRO")}<markeertijdbegin>2026-10-08T10:05:00</markeertijdbegin><markeertijdeind>2026-10-08T10:09:00</markeertijdeind><isvoorzitter>false</isvoorzitter>
<tekst><alinea><alineaitem>Mevrouw <nadruk type="Vet">Mutluer</nadruk> (PRO):</alineaitem><alineaitem>Het IMF moet de schuldenlast van arme landen verlichten.</alineaitem></alinea></tekst>
</woordvoerder></activiteititem></activiteitdeel></activiteit></vergadering></vlosCoreDocument>`;

const KOSTIC = "d66383ca-deef-4470-8807-924313ae15e6";

/** 28 October 2026, as VLOS writes it: Kostić reads out a motie, which sits in a draadboekfragment inside her woordvoerder. */
const MOTIE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<vlosCoreDocument soort="Tussenpublicatie" status="Ongecorrigeerd" xmlns="http://www.tweedekamer.nl/ggm/vergaderverslag/v1.0">
<vergadering soort="Plenair" objectid="e1d00454-a5bd-4242-909e-380b57074ba5"><titel>17e vergadering, woensdag 28 oktober 2026</titel><zaal>Plenaire zaal</zaal><datum>2026-10-28T00:00:00</datum>
<activiteit soort="Plenair debat"><onderwerp>Luchtvaart</onderwerp><activiteitdeel><activiteititem>
<woordvoerder objectid="1fd2218c">${spreker(KOSTIC, "Ines", "Kostić", "PvdD")}<markeertijdbegin>2026-10-28T10:16:28</markeertijdbegin><markeertijdeind>2026-10-28T10:18:11</markeertijdeind><isvoorzitter>false</isvoorzitter>
<tekst><alinea><alineaitem>Kamerlid <nadruk type="Vet">Kostić</nadruk> (PvdD):</alineaitem><alineaitem>Voorzitter. Die gelden blijkbaar niet voor de luchtvaart. Daarom deze moties.</alineaitem></alinea></tekst>
<draadboekfragment soort="Motie indiening" objectid="16b28274"><markeertijdbegin>2026-10-28T10:17:03</markeertijdbegin><markeertijdeind>2026-10-28T10:17:25</markeertijdeind><isdraad>true</isdraad>
<tekst><alineagroep type="Motietekst"><alinea><alineaitem>De Kamer,</alineaitem></alinea><alinea><alineaitem>gehoord de beraadslaging,</alineaitem></alinea><alinea><alineaitem>verzoekt de regering een CO<nadruk type="Onderschrift">2</nadruk>-plafond per luchthaven wettelijk in te voeren,</alineaitem></alinea><alinea><alineaitem>en gaat over tot de orde van de dag.</alineaitem></alinea></alineagroep>
<alineagroep type="Motieinfo"><alinea><alineaitem>De <nadruk type="Vet">voorzitter</nadruk>:</alineaitem><alineaitem>Deze motie is voorgesteld door het lid Kostić.</alineaitem></alinea><alinea><alineaitem>Zij krijgt nr. <stuknummer>1318</stuknummer> (<dossiernummer>31936</dossiernummer>).</alineaitem></alinea></alineagroep></tekst>
<zaken><zaak soort="Motie"><titel>de motie-Kostić over een CO2-plafond</titel><sprekers>${spreker(KOSTIC, "Ines", "Kostić", "PvdD")}</sprekers></zaak></zaken></draadboekfragment>
</woordvoerder></activiteititem></activiteitdeel></activiteit>
<activiteit soort="Sluiting"><titel>Sluiting</titel><onderwerp>Sluiting</onderwerp><aanvangstijd>2026-10-28T19:27:06</aanvangstijd><eindtijd>2026-10-28T19:27:11</eindtijd>
<draadboekfragment soort="Tekst"><markeertijdbegin>2026-10-28T19:27:11</markeertijdbegin><tekst><alinea><alineaitem>Sluiting 19.27 uur.</alineaitem></alinea></tekst></draadboekfragment></activiteit>
</vergadering></vlosCoreDocument>`;

const PLENAIR_DEBATE = { id: 301001, chamber: "tk", title: "Begrotingen Infrastructuur en Waterstaat", status: "ended", hall: "Plenaire zaal", startsAt: "2026-10-28T09:15:00.000Z", url: "https://debatdirect.tweedekamer.nl/2026-10-28/x/plenaire-zaal/y" };
const COMMISSIE_DEBATE = { id: 265693, chamber: "tk", title: "IMF", status: "ended", hall: "Klompézaal", startsAt: "2026-10-08T08:00:22.000Z", url: "https://debatdirect.tweedekamer.nl/2026-10-08/x/klompezaal/imf" };
const EK_DEBATE = { id: 312818, chamber: "ek", title: "Embryowet", status: "live", hall: "Plenaire zaal", startsAt: "2026-11-03T09:30:00.000Z" };

function hit(id: number, debate: Record<string, unknown>, over: Record<string, unknown> = {}): GehoordContribution {
  return parseContribution({
    id,
    debateId: debate.id,
    text: "Dus ik ga proberen ze dan ook als twee maar te beantwoorden. Want de heer Bikkers begint over dat de VVD'er natuur en milieu belangrijk vindt.",
    speakerLabel: BIKKERS,
    speakerName: "Bart Bikkers",
    speakerParty: "VVD",
    startTime: "2026-10-28T13:25:32.720Z",
    endTime: "2026-10-28T13:27:09.000Z",
    debate,
    ...over,
  });
}

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
  verslag_status: "Ongecorrigeerd",
  verslag_soort: "Tussenpublicatie",
};
const VERG_COMMISSIE: DebatVergadering = {
  vergadering_id: "c0000000-0000-4000-8000-000000000001",
  verslag_id: "c0000000-0000-4000-8000-000000000002",
  soort: "Commissie",
  titel: "IMF",
  zaal: "Klompezaal",
  datum: "2026-10-08",
  aanvangstijd: "2026-10-08T10:00:00+02:00",
  verslag_status: "Gecorrigeerd",
  verslag_soort: "Eindpublicatie",
};

const NOW = Date.parse("2026-11-03T12:00:00Z");

/** Deps without HTTP: vergaderingen per day and verslagen by id, every call counted. Gehoord is never asked: each hit carries its debate. */
function fakeDeps(opts: {
  days?: Record<string, DebatVergadering[]>;
  verslagen?: Record<string, DebatVerslag>;
  failDays?: boolean;
  failVerslag?: boolean;
} = {}) {
  const calls = { days: [] as string[], verslagen: [] as string[] };
  const deps: KoppelingDeps = {
    now: () => NOW,
    debatten: {
      vergaderingenOp: async (day: string) => {
        calls.days.push(day);
        if (opts.failDays) throw new Error("Gegevensmagazijn 503");
        return opts.days?.[day] ?? [];
      },
      getVerslag: async (v) => {
        calls.verslagen.push(v.verslag_id);
        if (opts.failVerslag) throw new Error("timeout");
        const verslag = opts.verslagen?.[v.verslag_id];
        if (!verslag) throw new Error("not found");
        return verslag;
      },
    },
  };
  return { deps, calls };
}

const plenair = parseVerslag(PLENAIR_XML, VERG_PLENAIR.verslag_id);
const commissie = parseVerslag(COMMISSIE_XML, VERG_COMMISSIE.verslag_id);

/* ------------------------------------------------------------------ */

describe("parseVerslag keeps the speaker's TK Persoon id", () => {
  it("takes persoon_id from <spreker objectid>, for woordvoerders and interrumpanten", () => {
    expect(plenair.fragments.map((f) => [f.spreker, f.persoon_id, f.begin, f.eind])).toEqual([
      ["Bart Bikkers", BIKKERS, "2026-10-28T14:20:00", "2026-10-28T14:25:00"],
      ["Erwin Prickaertz", PRICKAERTZ, "2026-10-28T14:25:21", "2026-10-28T14:25:32"],
      ["Bart Bikkers", BIKKERS, "2026-10-28T14:25:32", "2026-10-28T14:28:07"],
    ]);
  });

  it("keeps the moties a woordvoerder reads out in its text, without the chair's note on the number", () => {
    const v = parseVerslag(MOTIE_XML, "m");
    expect(v.fragments).toHaveLength(1);
    expect(v.fragments[0].tekst).toBe(
      "Voorzitter. Die gelden blijkbaar niet voor de luchtvaart. Daarom deze moties.\nDe Kamer,\ngehoord de beraadslaging,\nverzoekt de regering een CO2-plafond per luchthaven wettelijk in te voeren,\nen gaat over tot de orde van de dag.",
    );
    expect(v.fragments[0].tekst).not.toContain("1318");
    // The Sluiting: the verslag holds the whole vergadering.
    expect(v.sluiting).toBe("2026-10-28T19:27:11");
    expect(plenair.sluiting).toBeUndefined();
  });

  it("leaves persoon_id out when the spreker has no objectid", () => {
    const v = parseVerslag(PLENAIR_XML.replace(/ objectid="1e232189[^"]*"/g, ""), "x");
    expect(v.fragments[0].persoon_id).toBeUndefined();
    expect(v.fragments[1].persoon_id).toBe(PRICKAERTZ);
  });
});

describe("UTC and Europe/Amsterdam time, both sides of the switch on 25 October 2026", () => {
  it("knows the offset: summer +2 until 25 October 01:00 UTC, winter +1 after", () => {
    expect(amsterdamOffsetMinutes(Date.parse("2026-10-24T12:00:00Z"))).toBe(120);
    expect(amsterdamOffsetMinutes(Date.parse("2026-10-25T00:59:59Z"))).toBe(120);
    expect(amsterdamOffsetMinutes(Date.parse("2026-10-25T01:00:00Z"))).toBe(60);
    expect(amsterdamOffsetMinutes(Date.parse("2026-10-28T12:00:00Z"))).toBe(60);
  });

  it("reads VLOS wall-clock times as Amsterdam time", () => {
    expect(new Date(amsterdamLocalToEpoch("2026-10-08T10:05:00")!).toISOString()).toBe("2026-10-08T08:05:00.000Z");
    expect(new Date(amsterdamLocalToEpoch("2026-10-24T14:25:32")!).toISOString()).toBe("2026-10-24T12:25:32.000Z");
    expect(new Date(amsterdamLocalToEpoch("2026-10-26T14:25:32")!).toISOString()).toBe("2026-10-26T13:25:32.000Z");
    expect(new Date(amsterdamLocalToEpoch("2026-10-28T14:25:32")!).toISOString()).toBe("2026-10-28T13:25:32.000Z");
    // Right after the switch, and in March the other way.
    expect(new Date(amsterdamLocalToEpoch("2026-10-25T03:30:00")!).toISOString()).toBe("2026-10-25T02:30:00.000Z");
    expect(new Date(amsterdamLocalToEpoch("2026-03-29T10:00:00")!).toISOString()).toBe("2026-03-29T08:00:00.000Z");
    expect(new Date(amsterdamLocalToEpoch("2026-03-28T10:00:00")!).toISOString()).toBe("2026-03-28T09:00:00.000Z");
  });

  it("honours an explicit offset or Z and refuses what is no time", () => {
    expect(amsterdamLocalToEpoch("2026-10-28T13:25:32.720Z")).toBe(Date.parse("2026-10-28T13:25:32.720Z"));
    expect(amsterdamLocalToEpoch("2026-10-08T10:00:00+02:00")).toBe(Date.parse("2026-10-08T08:00:00Z"));
    expect(amsterdamLocalToEpoch("gisteren")).toBeUndefined();
    expect(amsterdamLocalToEpoch(undefined)).toBeUndefined();
  });

  it("gives the Dutch calendar day of an instant", () => {
    expect(amsterdamDay("2026-10-25T23:30:00Z")).toBe("2026-10-26");
    expect(amsterdamDay("2026-10-24T22:30:00Z")).toBe("2026-10-25");
    expect(amsterdamDay("2026-10-24T21:30:00Z")).toBe("2026-10-24");
  });
});

describe("matching a Gehoord hit to a fragment", () => {
  const intervals = fragmentIntervals(plenair.fragments);
  const start = Date.parse("2026-10-28T13:25:32.720Z");
  const end = Date.parse("2026-10-28T13:27:09Z");

  it("picks the fragment of the same person with the largest overlap, not the one whose end touches the start", () => {
    const best = bestFragment({ persoonId: BIKKERS, start, end }, plenair.fragments, intervals);
    expect(best?.fragment.begin).toBe("2026-10-28T14:25:32");
    expect(best?.overlapMs).toBe(end - start);
  });

  it("never takes another person's fragment, even when it overlaps", () => {
    const best = bestFragment({ persoonId: PRICKAERTZ, start: Date.parse("2026-10-28T13:25:20Z"), end: Date.parse("2026-10-28T13:25:40Z") }, plenair.fragments, intervals);
    expect(best?.fragment.spreker).toBe("Erwin Prickaertz");
    expect(bestFragment({ persoonId: MUTLUER, start, end }, plenair.fragments, intervals)).toBeUndefined();
  });

  it("allows a few seconds of slack at the edges, no more", () => {
    // Bikkers' first fragment ends 14:25:00; a hit from 14:25:02 to 14:25:10 is within 3 s of it.
    const near = bestFragment({ persoonId: BIKKERS, start: Date.parse("2026-10-28T13:25:02Z"), end: Date.parse("2026-10-28T13:25:10Z") }, plenair.fragments, intervals);
    expect(near?.fragment.begin).toBe("2026-10-28T14:20:00");
    const far = bestFragment({ persoonId: BIKKERS, start: Date.parse("2026-10-28T13:25:10Z"), end: Date.parse("2026-10-28T13:25:20Z") }, plenair.fragments, intervals);
    expect(far).toBeUndefined();
  });

  it("says where in the fragment the middle of the hit falls, to show the right passage", () => {
    const mid = bestFragment({ persoonId: BIKKERS, start: Date.parse("2026-10-28T13:22:30Z"), end: Date.parse("2026-10-28T13:23:00Z") }, plenair.fragments, intervals);
    expect(mid?.positie).toBeCloseTo(0.55, 2);
  });

  it("ends a fragment without markeertijdeind at the next fragment's begin", () => {
    const frags = [
      { begin: "2026-10-28T10:00:00", persoon_id: "a" },
      { begin: "2026-10-28T10:05:00", eind: "2026-10-28T10:06:00", persoon_id: "b" },
    ] as DebatFragment[];
    const [a] = fragmentIntervals(frags);
    expect(a!.end - a!.start).toBe(5 * 60_000);
  });
});

describe("matching a Gehoord debate to a vergadering", () => {
  const other: DebatVergadering = { ...VERG_COMMISSIE, vergadering_id: "o", verslag_id: "o", zaal: "Troelstrazaal", titel: "Wadden" };

  it("takes the Plenair vergadering of the day for the plenary hall", () => {
    expect(matchVergadering(PLENAIR_DEBATE, [VERG_COMMISSIE, VERG_PLENAIR])).toBe(VERG_PLENAIR);
  });

  it("takes the committee vergadering in the same zaal, accents ignored, closest to the start", () => {
    const later = { ...VERG_COMMISSIE, vergadering_id: "later", aanvangstijd: "2026-10-08T10:40:00+02:00" };
    expect(matchVergadering(COMMISSIE_DEBATE, [other, later, VERG_COMMISSIE])).toBe(VERG_COMMISSIE);
  });

  it("compares the zaal on Gehoord's locationId, the Gegevensmagazijn Zaal folded to it, else on hall", () => {
    // Both write "Klompézaal"; locationId is the key without accents.
    expect(sameZaal("Klompézaal", { hall: "Klompézaal", locationId: "klompezaal" })).toBe(true);
    expect(sameZaal("Suze Groenewegzaal", { hall: "Suze Groenewegzaal", locationId: "suze-groenewegzaal" })).toBe(true);
    // locationId decides when it is there; hall only without it.
    expect(sameZaal("Thorbeckezaal", { hall: "Thorbecke", locationId: "thorbeckezaal" })).toBe(true);
    expect(sameZaal("Thorbeckezaal", { hall: "Thorbeckezaal", locationId: "troelstrazaal" })).toBe(false);
    expect(sameZaal("Klompezaal", { hall: "Klompézaal" })).toBe(true);
    expect(sameZaal(undefined, { hall: "Klompézaal" })).toBe(false);
    const accented = { ...VERG_COMMISSIE, zaal: "Klompézaal" };
    expect(matchVergadering({ ...COMMISSIE_DEBATE, hall: "Klompézaal", locationId: "klompezaal" }, [accented])).toBe(accented);
    expect(matchVergadering({ ...PLENAIR_DEBATE, hall: undefined, locationId: "plenaire-zaal" }, [VERG_COMMISSIE, VERG_PLENAIR])).toBe(VERG_PLENAIR);
  });

  it("times a committee debate by its real start (startedAt), not the agenda time (startsAt)", () => {
    // The agenda said 09:00 local, an hour early; the debate began at 10:00:22.
    const agendaEarly = { ...COMMISSIE_DEBATE, startsAt: "2026-10-08T07:00:00.000Z", startedAt: "2026-10-08T08:00:22.000Z" };
    expect(matchVergadering(agendaEarly, [VERG_COMMISSIE])).toBe(VERG_COMMISSIE);
    expect(matchVergadering({ ...agendaEarly, startedAt: undefined }, [VERG_COMMISSIE])).toBeUndefined();
    // Not begun: the agenda time is all there is.
    expect(matchVergadering({ ...COMMISSIE_DEBATE, startedAt: undefined }, [VERG_COMMISSIE])).toBe(VERG_COMMISSIE);
  });

  it("does not match another zaal or a start more than 45 minutes away", () => {
    expect(matchVergadering({ ...COMMISSIE_DEBATE, hall: "Troelstrazaal" }, [VERG_COMMISSIE])).toBeUndefined();
    expect(matchVergadering({ ...COMMISSIE_DEBATE, startsAt: "2026-10-08T09:00:00.000Z" }, [VERG_COMMISSIE])).toBeUndefined();
    expect(matchVergadering({ ...COMMISSIE_DEBATE, startsAt: undefined }, [VERG_COMMISSIE])).toBeUndefined();
  });

  it("with two plenary vergaderingen on a day, takes the one that had begun at the hit", () => {
    const evening = { ...VERG_PLENAIR, vergadering_id: "avond", aanvangstijd: "2026-10-28T19:00:00+01:00" };
    expect(matchVergadering(PLENAIR_DEBATE, [VERG_PLENAIR, evening], Date.parse("2026-10-28T13:25:32Z"))).toBe(VERG_PLENAIR);
    expect(matchVergadering(PLENAIR_DEBATE, [VERG_PLENAIR, evening], Date.parse("2026-10-28T19:30:00Z"))).toBe(evening);
  });
});

describe("vergaderDag: a night sitting belongs to the day it began", () => {
  it("puts a plenary debate starting after midnight under the previous day, across DST", () => {
    // 15 Oct 2026 00:30 summer time = 14 Oct 22:30Z; the sitting of 14 Oct ran to 01:15.
    expect(vergaderDag({ hall: "Plenaire zaal", startsAt: "2026-10-14T22:30:00.000Z" })).toBe("2026-10-14");
    // 29 Oct 2026 00:30 winter time = 28 Oct 23:30Z.
    expect(vergaderDag({ hall: "Plenaire zaal", startsAt: "2026-10-28T23:30:00.000Z" })).toBe("2026-10-28");
    expect(vergaderDag({ hall: "Plenaire zaal", startsAt: "2026-10-28T09:15:00.000Z" })).toBe("2026-10-28");
  });
  it("takes the real start (startedAt) over the agenda time, and knows the plenary hall by locationId", () => {
    expect(vergaderDag({ hall: "Plenaire zaal", startsAt: "2026-10-28T09:15:00.000Z", startedAt: "2026-10-28T23:30:00.000Z" })).toBe("2026-10-28");
    expect(vergaderDag({ hall: "Thorbeckezaal", startsAt: "2026-10-07T21:30:00.000Z", startedAt: "2026-10-08T07:30:00.000Z" })).toBe("2026-10-08");
    expect(vergaderDag({ locationId: "plenaire-zaal", startedAt: "2026-10-14T22:30:00.000Z" })).toBe("2026-10-14");
  });

  it("keeps a committee debate on its own calendar day and falls back to the hit time", () => {
    expect(vergaderDag({ hall: "Thorbeckezaal", startsAt: "2026-10-08T07:30:00.000Z" })).toBe("2026-10-08");
    expect(vergaderDag({ hall: "Plenaire zaal" }, "2026-10-28T13:25:32.720Z")).toBe("2026-10-28");
    expect(vergaderDag({ hall: "Plenaire zaal" })).toBeUndefined();
  });
});

describe("koppelGehoord: every status", () => {
  it("officieel: the plenary fragment, after the switch to winter time", async () => {
    const { deps, calls } = fakeDeps({ days: { "2026-10-28": [VERG_PLENAIR] }, verslagen: { [VERG_PLENAIR.verslag_id]: plenair } });
    const r = await koppelGehoord([hit(1, PLENAIR_DEBATE)], deps);
    const [k] = r.koppelingen;
    expect(k.status).toBe("officieel");
    expect(k.fragment?.tekst).toContain("De heer Prickaertz begint erover");
    expect(k.verslag).toEqual({ verslag_id: VERG_PLENAIR.verslag_id, status: "Ongecorrigeerd", publicatie: "Tussenpublicatie" });
    expect(k.overlap_s).toBe(96);
    expect(calls).toEqual({ days: ["2026-10-28"], verslagen: [VERG_PLENAIR.verslag_id] });
  });

  it("officieel: a committee debate in summer time, the zaal written without its accent", async () => {
    const { deps } = fakeDeps({ days: { "2026-10-08": [VERG_COMMISSIE] }, verslagen: { [VERG_COMMISSIE.verslag_id]: commissie } });
    const h = hit(2, COMMISSIE_DEBATE, { speakerLabel: MUTLUER, startTime: "2026-10-08T08:06:00.000Z", endTime: "2026-10-08T08:06:40.000Z" });
    const r = await koppelGehoord([h], deps);
    expect(r.koppelingen[0]).toMatchObject({ status: "officieel", verslag: { status: "Gecorrigeerd", publicatie: "Eindpublicatie" } });
    expect(r.koppelingen[0].fragment?.spreker).toBe("Songül Mutluer");
  });

  it("officieel: a motie read out, with the motie in the official text", async () => {
    const verslag = parseVerslag(MOTIE_XML, VERG_PLENAIR.verslag_id);
    const { deps } = fakeDeps({ days: { "2026-10-28": [VERG_PLENAIR] }, verslagen: { [VERG_PLENAIR.verslag_id]: verslag } });
    const h = hit(30, PLENAIR_DEBATE, { speakerLabel: KOSTIC, startTime: "2026-10-28T09:16:28Z", endTime: "2026-10-28T09:18:11Z" });
    const [k] = (await koppelGehoord([h], deps)).koppelingen;
    expect(k).toMatchObject({ status: "officieel", overlap_s: 103 });
    expect(k.fragment?.tekst).toContain("CO2-plafond per luchthaven");
  });

  it("niet_gekoppeld, not nog_geen_verslag, past the end of a complete verslag (eindpublicatie, or one with the Sluiting)", async () => {
    const late = { startTime: "2026-10-28T18:27:30Z", endTime: "2026-10-28T18:27:40Z" };
    const eind = { ...plenair, publicatie: "Eindpublicatie", status: "Gecorrigeerd" };
    const { deps } = fakeDeps({ days: { "2026-10-28": [VERG_PLENAIR] }, verslagen: { [VERG_PLENAIR.verslag_id]: eind } });
    const [a] = (await koppelGehoord([hit(31, PLENAIR_DEBATE, late)], deps)).koppelingen;
    expect(a.status).toBe("niet_gekoppeld");
    expect(a.reden).toBe("geen fragment van deze spreker rond dit tijdstip in het verslag (het verslag is compleet en loopt tot 14:28; dit fragment is van 19:27)");
    const gesloten = { ...plenair, sluiting: "2026-10-28T19:27:11" };
    const { deps: deps2 } = fakeDeps({ days: { "2026-10-28": [VERG_PLENAIR] }, verslagen: { [VERG_PLENAIR.verslag_id]: gesloten } });
    expect((await koppelGehoord([hit(32, PLENAIR_DEBATE, late)], deps2)).koppelingen[0].status).toBe("niet_gekoppeld");
  });

  it("nog_geen_verslag: a recent commissiedebat without a vergadering yet", async () => {
    const { deps } = fakeDeps();
    const recent = { ...COMMISSIE_DEBATE, id: 307212, hall: "Thorbeckezaal", debateType: "Commissiedebat", startsAt: "2026-10-29T14:01:30.000Z" };
    const r = await koppelGehoord([hit(3, recent, { startTime: "2026-10-29T14:30:00Z", endTime: "2026-10-29T14:31:00Z" })], deps);
    expect(r.koppelingen[0].status).toBe("nog_geen_verslag");
    expect(r.koppelingen[0].reden).toMatch(/2 tot 12 dagen/);
  });

  it("nog_geen_verslag: the tussenpublicatie does not reach the moment yet", async () => {
    const { deps } = fakeDeps({ days: { "2026-10-28": [VERG_PLENAIR] }, verslagen: { [VERG_PLENAIR.verslag_id]: plenair } });
    const r = await koppelGehoord([hit(4, PLENAIR_DEBATE, { startTime: "2026-10-28T16:00:00Z", endTime: "2026-10-28T16:01:00Z" })], deps);
    expect(r.koppelingen[0]).toMatchObject({ status: "nog_geen_verslag", vergadering: VERG_PLENAIR });
    expect(r.koppelingen[0].reden).toBe("het verslag (Tussenpublicatie) loopt nog maar tot 14:28; dit fragment is van 17:00");
  });

  it("nog_geen_verslag: a live debate", async () => {
    const { deps } = fakeDeps();
    const live = { ...PLENAIR_DEBATE, status: "live", startsAt: "2026-11-03T09:15:00.000Z" };
    const r = await koppelGehoord([hit(5, live, { startTime: "2026-11-03T10:00:00Z", endTime: "2026-11-03T10:01:00Z" })], deps);
    expect(r.koppelingen[0]).toMatchObject({ status: "nog_geen_verslag", reden: "het debat is nog bezig; het verslag volgt" });
  });

  it("geen_verslag_verwacht: a technische briefing by the hit's own debateType, for a guest speaker without a persoon-id too", async () => {
    const { deps } = fakeDeps();
    const briefing = { ...COMMISSIE_DEBATE, id: 999, title: "ROB-advies", debateType: "Technische briefing" };
    const r = await koppelGehoord([hit(6, briefing), hit(16, briefing, { speakerLabel: "Melanie Kalis", speakerParty: null })], deps);
    expect(r.koppelingen.map((k) => k.status)).toEqual(["geen_verslag_verwacht", "geen_verslag_verwacht"]);
    expect(r.koppelingen[0].reden).toBe("een technische briefing krijgt geen verslag in het Gegevensmagazijn");
  });

  it("geen_verslag_verwacht: a debate Gehoord marks cancelled, when no vergadering holds it", async () => {
    const { deps } = fakeDeps();
    const cancelled = { ...COMMISSIE_DEBATE, id: 292952, status: "cancelled", debateType: "Commissiedebat", startsAt: "2026-10-29T14:00:00.000Z" };
    const r = await koppelGehoord([hit(17, cancelled, { startTime: "2026-10-29T14:30:00Z", endTime: "2026-10-29T14:31:00Z" })], deps);
    expect(r.koppelingen[0]).toEqual({ status: "geen_verslag_verwacht", reden: "Gehoord.de meldt dit debat als geschrapt (cancelled): het is niet doorgegaan" });
  });

  it("eerste_kamer: no lookup at all", async () => {
    const { deps, calls } = fakeDeps();
    const r = await koppelGehoord([hit(7, EK_DEBATE, { speakerLabel: "vkyyicefojzk" })], deps);
    expect(r.koppelingen[0].status).toBe("eerste_kamer");
    expect(r.koppelingen[0].reden).toContain("officiele_bekendmakingen_search");
    expect(calls).toEqual({ days: [], verslagen: [] });
  });

  it("niet_gekoppeld: the verslag has no fragment of this person then, a speaker without a GUID, an old debate without a vergadering", async () => {
    const { deps } = fakeDeps({ days: { "2026-10-28": [VERG_PLENAIR] }, verslagen: { [VERG_PLENAIR.verslag_id]: plenair } });
    const old = { ...COMMISSIE_DEBATE, id: 1234, debateType: "Commissiedebat", startsAt: "2026-06-10T08:00:00.000Z" };
    const r = await koppelGehoord(
      [
        hit(8, PLENAIR_DEBATE, { speakerLabel: MUTLUER }),
        hit(9, PLENAIR_DEBATE, { speakerLabel: "" }),
        hit(10, old, { startTime: "2026-06-10T08:10:00Z", endTime: "2026-06-10T08:11:00Z" }),
      ],
      deps,
    );
    expect(r.koppelingen.map((k) => k.status)).toEqual(["niet_gekoppeld", "niet_gekoppeld", "niet_gekoppeld"]);
    expect(r.koppelingen[0].reden).toBe("geen fragment van deze spreker rond dit tijdstip in het verslag");
    expect(r.koppelingen[1].reden).toBe("spreker zonder persoon-id van de Tweede Kamer");
    expect(r.koppelingen[2].reden).toMatch(/geen vergadering met verslag gevonden in de Klompézaal/);
    expect(koppelingCounts(r.counts)).toBe("3 niet gekoppeld");
  });
});

describe("koppelGehoord: budgets", () => {
  it("links every hit whose verslag is read, asking the day's vergaderingen and the verslag once", async () => {
    const { deps, calls } = fakeDeps({ days: { "2026-10-28": [VERG_PLENAIR] }, verslagen: { [VERG_PLENAIR.verslag_id]: plenair } });
    const hits = Array.from({ length: 25 }, (_, i) => hit(100 + i, PLENAIR_DEBATE));
    const r = await koppelGehoord(hits, deps);
    expect(r.counts.officieel).toBe(25);
    expect(calls.days).toEqual(["2026-10-28"]);
    expect(calls.verslagen).toEqual([VERG_PLENAIR.verslag_id]);
  });

  it(`lists the vergaderingen of at most ${KOPPELING_MAX_DAGEN} days`, async () => {
    const { deps, calls } = fakeDeps();
    const hits = Array.from({ length: KOPPELING_MAX_DAGEN + 1 }, (_, d) => {
      const day = `2026-09-${String(d + 1).padStart(2, "0")}`;
      return hit(150 + d, { ...PLENAIR_DEBATE, id: 450 + d, startsAt: `${day}T08:15:00.000Z` }, { startTime: `${day}T12:00:00Z`, endTime: `${day}T12:01:00Z` });
    });
    const r = await koppelGehoord(hits, deps);
    expect(calls.days).toHaveLength(KOPPELING_MAX_DAGEN);
    expect(r.koppelingen.at(-1)).toEqual({ status: "niet_gekoppeld", reden: `limiet: per aanroep worden de vergaderingen van hooguit ${KOPPELING_MAX_DAGEN} dagen opgezocht` });
  });

  it("spends no verslag on a speaker without a TK Persoon id", async () => {
    const days: Record<string, DebatVergadering[]> = {};
    const verslagen: Record<string, DebatVerslag> = {};
    const hits: GehoordContribution[] = [];
    for (let d = 0; d < KOPPELING_MAX_VERSLAGEN + 1; d++) {
      const day = `2026-09-0${d + 1}`;
      const v = { ...VERG_PLENAIR, vergadering_id: `v${d}`, verslag_id: `s${d}`, datum: day, aanvangstijd: `${day}T10:15:00+02:00` };
      days[day] = [v];
      verslagen[v.verslag_id] = { ...plenair, verslag_id: v.verslag_id };
      // The first is a guest ("Onbekend (b0009d03)"): no GUID.
      hits.push(hit(250 + d, { ...PLENAIR_DEBATE, id: 500 + d, startsAt: `${day}T08:15:00.000Z` }, { startTime: `${day}T12:00:00Z`, endTime: `${day}T12:01:00Z`, ...(d === 0 ? { speakerLabel: "b0009d03" } : {}) }));
    }
    const { deps, calls } = fakeDeps({ days, verslagen });
    const r = await koppelGehoord(hits, deps);
    expect(calls.verslagen).toEqual(["s1", "s2", "s3", "s4"]);
    expect(r.koppelingen[0]).toMatchObject({ status: "niet_gekoppeld", reden: "spreker zonder persoon-id van de Tweede Kamer" });
    expect(r.koppelingen.slice(1).map((k) => k.reden)).not.toContain(`limiet: per aanroep worden hooguit ${KOPPELING_MAX_VERSLAGEN} verslagen gelezen`);
  });

  it("reads every debate's type from its hit: no lookup and no limit on how many", async () => {
    const { deps, calls } = fakeDeps();
    const hits = Array.from({ length: 8 }, (_, i) => hit(600 + i, { ...COMMISSIE_DEBATE, id: 700 + i, debateType: "Technische briefing", startsAt: "2026-10-29T14:00:00.000Z" }, { startTime: "2026-10-29T14:30:00Z", endTime: "2026-10-29T14:31:00Z" }));
    const r = await koppelGehoord(hits, deps);
    expect(r.counts).toMatchObject({ geen_verslag_verwacht: 8 });
    expect(calls).toEqual({ days: ["2026-10-29"], verslagen: [] });
  });

  it("gives every request the time left of the deadline and no retry", async () => {
    const seen: unknown[] = [];
    const { deps } = fakeDeps({ days: { "2026-10-28": [VERG_PLENAIR] }, verslagen: { [VERG_PLENAIR.verslag_id]: plenair } });
    const { vergaderingenOp, getVerslag } = deps.debatten;
    deps.debatten = {
      vergaderingenOp: (day, opts) => (seen.push(opts), vergaderingenOp(day)),
      getVerslag: (v, opts) => (seen.push(opts), getVerslag(v)),
    };
    const r = await koppelGehoord([hit(40, PLENAIR_DEBATE)], deps);
    expect(seen).toHaveLength(2);
    for (const opts of seen as Array<{ timeoutMs: number; retries: number }>) {
      expect(opts.retries).toBe(0);
      expect(opts.timeoutMs).toBeGreaterThan(KOPPELING_DEADLINE_MS - 5_000);
      expect(opts.timeoutMs).toBeLessThanOrEqual(KOPPELING_DEADLINE_MS);
    }
    expect(r.deadlineAt - Date.now()).toBeLessThanOrEqual(KOPPELING_DEADLINE_MS);
  });

  it(`reads at most ${KOPPELING_MAX_VERSLAGEN} verslagen; the hits of the others keep their transcript`, async () => {
    const days: Record<string, DebatVergadering[]> = {};
    const verslagen: Record<string, DebatVerslag> = {};
    const hits: GehoordContribution[] = [];
    for (let d = 0; d < KOPPELING_MAX_VERSLAGEN + 1; d++) {
      const day = `2026-09-0${d + 1}`;
      const v = { ...VERG_PLENAIR, vergadering_id: `v${d}`, verslag_id: `s${d}`, datum: day, aanvangstijd: `${day}T10:15:00+02:00` };
      days[day] = [v];
      verslagen[v.verslag_id] = { ...plenair, verslag_id: v.verslag_id };
      hits.push(hit(200 + d, { ...PLENAIR_DEBATE, id: 400 + d, startsAt: `${day}T08:15:00.000Z` }, { startTime: `${day}T12:00:00Z`, endTime: `${day}T12:01:00Z` }));
    }
    const { deps, calls } = fakeDeps({ days, verslagen });
    const r = await koppelGehoord(hits, deps);
    expect(calls.verslagen).toHaveLength(KOPPELING_MAX_VERSLAGEN);
    expect(r.koppelingen.at(-1)).toMatchObject({ status: "niet_gekoppeld", reden: `limiet: per aanroep worden hooguit ${KOPPELING_MAX_VERSLAGEN} verslagen gelezen` });
    expect(r.verslagen).toBe(KOPPELING_MAX_VERSLAGEN);
  });
});

describe("koppelGehoord: every failure degrades to the transcript", () => {
  it("the vergaderingen cannot be listed", async () => {
    const { deps } = fakeDeps({ failDays: true });
    const r = await koppelGehoord([hit(11, PLENAIR_DEBATE)], deps);
    expect(r.koppelingen[0]).toEqual({ status: "niet_gekoppeld", reden: "vergaderingen niet opgehaald: Gegevensmagazijn 503" });
  });

  it("the verslag cannot be read", async () => {
    const { deps } = fakeDeps({ days: { "2026-10-28": [VERG_PLENAIR] }, failVerslag: true });
    const r = await koppelGehoord([hit(12, PLENAIR_DEBATE)], deps);
    expect(r.koppelingen[0]).toMatchObject({ status: "niet_gekoppeld", reden: "verslag niet gelezen: timeout" });
  });

  it("a debate without a debateType: the date decides", async () => {
    const { deps } = fakeDeps();
    const recent = { ...COMMISSIE_DEBATE, startsAt: "2026-11-02T09:00:00.000Z" };
    const r = await koppelGehoord([hit(13, recent, { startTime: "2026-11-02T09:10:00Z", endTime: "2026-11-02T09:11:00Z" })], deps);
    expect(r.koppelingen[0].status).toBe("nog_geen_verslag");
  });

  it("a verslag that does not come in time", async () => {
    const { deps } = fakeDeps({ days: { "2026-10-28": [VERG_PLENAIR] } });
    deps.debatten.getVerslag = () => new Promise(() => undefined);
    deps.deadlineMs = 30;
    const r = await koppelGehoord([hit(14, PLENAIR_DEBATE)], deps);
    expect(r.koppelingen[0]).toMatchObject({ status: "niet_gekoppeld", reden: "verslag niet gelezen: time-out" });
  });
});

/* ------------------------------------------------------------------ */
/*  The tools, with HTTP mocked                                        */
/* ------------------------------------------------------------------ */

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
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

const TK_API = "https://gegevensmagazijn.tweedekamer.nl/OData/v4/2.0";

function vergaderingRow(v: DebatVergadering, gewijzigd: string) {
  return {
    Id: v.vergadering_id,
    Soort: v.soort,
    Titel: v.titel,
    Zaal: v.zaal,
    Vergaderjaar: v.vergaderjaar,
    VergaderingNummer: v.vergaderingnummer,
    Datum: `${v.datum}T00:00:00+01:00`,
    Aanvangstijd: v.aanvangstijd,
    Verslag: [{ Id: v.verslag_id, Soort: v.verslag_soort, Status: v.verslag_status, GewijzigdOp: gewijzigd, Verwijderd: false }],
  };
}

/** Gehoord and the Gegevensmagazijn, by host and path; every request recorded. */
function mockHttp(opts: { contributions: unknown[]; vergaderingen?: unknown[]; verslagXml?: string; tkStatus?: number; debate?: Record<string, unknown> }) {
  const urls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    urls.push(url);
    if (url.hostname === "gehoord.de") {
      if (url.pathname === "/api/v1/contributions") return jsonResponse({ data: opts.contributions, pagination: { total: opts.contributions.length, hasMore: false } });
      if (/^\/api\/v1\/debates\/\d+$/.test(url.pathname)) return jsonResponse({ data: { ...opts.debate, speakers: [] } });
      if (/\/contributions$/.test(url.pathname)) return jsonResponse({ data: opts.contributions, debate: opts.debate, pagination: { total: opts.contributions.length, hasMore: false } });
    }
    if (url.hostname === "gegevensmagazijn.tweedekamer.nl") {
      if (opts.tkStatus) return jsonResponse({ error: "x" }, opts.tkStatus);
      if (url.pathname.endsWith("/Vergadering")) return jsonResponse({ value: opts.vergaderingen ?? [] });
      if (url.pathname.includes("/Verslag(")) return xmlResponse(opts.verslagXml ?? "");
      if (url.pathname.endsWith("/Activiteit")) return jsonResponse({ value: [] });
    }
    return jsonResponse({ error: "unexpected" }, 404);
  }));
  return urls;
}

const raw = (id: number, debate: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
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

describe("gehoord_debatten_search with koppeling", () => {
  beforeEach(() => {
    clearHttpCache();
    setCrawlDelaysEnabled(false);
    vi.stubEnv("GEHOORD_KEY", "k");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  afterAll(() => setCrawlDelaysEnabled(true));

  it("shows the official text, speaker and link first and keeps the transcript and video link", async () => {
    const v = { ...VERG_PLENAIR, verslag_id: "a1a1a1a1-0000-4000-8000-000000000001" };
    const urls = mockHttp({
      contributions: [raw(241823, PLENAIR_DEBATE), raw(241824, EK_DEBATE, { speakerLabel: "vkyyicefojzk", speakerName: "Boris Dittrich", speakerParty: "D66", startTime: "2026-11-03T10:00:00Z" })],
      vergaderingen: [vergaderingRow(v, "2026-10-29T17:34:50+01:00")],
      verslagXml: PLENAIR_XML,
    });
    const out = await call("gehoord_debatten_search", { query: "Bikkers begint" });
    expect(out.summary).toMatch(/; officieel verslag gekoppeld: 1 van 2$/);
    const [tk, ek] = out.records;
    expect(tk.source_name).toBe("tweedekamer");
    expect(tk.title).toBe("Bart Bikkers (VVD): Begroting Infrastructuur en Waterstaat 2027");
    expect(tk.canonical_url).toBe("https://www.tweedekamer.nl/kamerstukken/plenaire_verslagen/detail/2026-2027/17");
    expect(tk.data).toMatchObject({
      koppeling: { status: "officieel", verslag_id: v.verslag_id, vergadering_id: v.vergadering_id, verslag_status: "Ongecorrigeerd", publicatie: "Tussenpublicatie", overlap_s: 96 },
      persoon_id: BIKKERS,
      spreker: "Bart Bikkers",
      begin: "2026-10-28T14:25:32",
      eind: "2026-10-28T14:28:07",
      start_time: "2026-10-28T13:25:32.720Z",
      tekst: "Dit zijn twee vragen ineen. De heer Prickaertz begint erover dat de VVD natuur en milieu belangrijk vindt.",
      gehoord_tekst: "Want de heer Bikkers begint over dat de VVD'er natuur en milieu belangrijk vindt.",
      gehoord_url: "https://gehoord.de/beraadslagingen/301001?segment=241823",
      verslag_url: `${TK_API}/Verslag(${v.verslag_id})/resource`,
    });
    expect(ek.source_name).toBe("gehoord");
    expect(ek.data.koppeling.status).toBe("eerste_kamer");
    expect(out.access_note).toContain("Koppeling met het officiële verslag van de Tweede Kamer: 1 officieel, 1 Eerste Kamer.");
    // The official text first, then the provider's caveat on the transcript; the gehoord.de link note for the EK record.
    expect(out.access_note).toMatch(/^Records met data\.koppeling\.status 'officieel'/);
    expect(out.access_note).toContain("niet om te citeren");
    expect(out.access_note).toContain("De link (fragment_url) opent het debat op gehoord.de");
    expect(tk.data.fragment_url).toBeUndefined();
    expect(tk.data.debat_pagina_url).toBeUndefined();
    expect(out.access_note).toContain("Ongecorrigeerd verslag");
    // One day list and one verslag; nothing asked of Gehoord beyond the search.
    expect(urls.filter((u) => u.hostname === "gehoord.de").map((u) => u.pathname)).toEqual(["/api/v1/contributions"]);
    expect(urls.filter((u) => u.pathname.includes("/Verslag("))).toHaveLength(1);
  });

  it("shows one official fragment once when more hits fall in it", async () => {
    const v = { ...VERG_PLENAIR, verslag_id: "a1a1a1a1-0000-4000-8000-000000000002" };
    mockHttp({
      contributions: [raw(1, PLENAIR_DEBATE), raw(2, PLENAIR_DEBATE, { startTime: "2026-10-28T13:27:10Z", endTime: "2026-10-28T13:28:00Z" })],
      vergaderingen: [vergaderingRow(v, "2026-10-29T17:34:50+01:00")],
      verslagXml: PLENAIR_XML,
    });
    const out = await call("gehoord_debatten_search", { query: "natuur" });
    expect(out.records[0].data.tekst).toBeDefined();
    expect(out.records[1].data.tekst).toBeUndefined();
    expect(out.records[1].data.koppeling.zelfde_fragment_als).toBe(1);
    expect(out.access_note).toContain("zelfde_fragment_als");
  });

  it("links a commissiedebat and gives its page from tkActivityNumber, without an Activiteit lookup", async () => {
    const v = { ...VERG_COMMISSIE, vergadering_id: "c0000000-0000-4000-8000-0000000000aa", verslag_id: "c0000000-0000-4000-8000-0000000000ab" };
    const debate = { ...COMMISSIE_DEBATE, hall: "Klompézaal", locationId: "klompezaal", debateType: "Commissiedebat", startedAt: COMMISSIE_DEBATE.startsAt, tkActivityId: "0647302f-4fcf-4dc9-b281-18e9ab406daf", tkActivityNumber: "2026A05087", subtitlesCondensed: false };
    const urls = mockHttp({
      contributions: [raw(51, debate, { speakerLabel: MUTLUER, speakerName: "Songül Mutluer", speakerParty: "PRO", text: "Het IMF moet de schulden verlichten.", startTime: "2026-10-08T08:06:00.000Z", endTime: "2026-10-08T08:06:40.000Z" })],
      vergaderingen: [{ ...vergaderingRow(v, "2026-10-12T10:00:00+02:00"), Datum: "2026-10-08T00:00:00+02:00" }],
      verslagXml: COMMISSIE_XML,
    });
    const out = await call("gehoord_debatten_search", { query: "IMF schulden" });
    const [r] = out.records;
    expect(r.data.koppeling.status).toBe("officieel");
    expect(r.canonical_url).toBe("https://www.tweedekamer.nl/debat_en_vergadering/commissievergaderingen/details?id=2026A05087");
    expect(r.data.debat_soort).toBe("Commissiedebat");
    expect(r.data.ondertiteling_samengevat).toBe(false);
    expect(urls.some((u) => u.pathname.endsWith("/Activiteit"))).toBe(false);
  });

  it("keeps the transcript, with the reason, when the Gegevensmagazijn fails", async () => {
    mockHttp({ contributions: [raw(3, PLENAIR_DEBATE)], tkStatus: 404 });
    const out = await call("gehoord_debatten_search", { query: "natuur" });
    expect(out.error).toBeUndefined();
    expect(out.records[0].source_name).toBe("gehoord");
    expect(out.records[0].data.tekst).toContain("Want de heer Bikkers begint");
    expect(out.records[0].data.koppeling).toMatchObject({ status: "niet_gekoppeld" });
    expect(out.records[0].data.koppeling.reden).toMatch(/^vergaderingen niet opgehaald/);
    expect(out.access_note).toContain("1 niet gekoppeld");
  });

  it("koppeling 'uit': only Gehoord, the transcript as before", async () => {
    const urls = mockHttp({ contributions: [raw(4, PLENAIR_DEBATE)] });
    const out = await call("gehoord_debatten_search", { query: "natuur", koppeling: "uit" });
    expect(urls.every((u) => u.hostname === "gehoord.de")).toBe(true);
    expect(out.records[0].source_name).toBe("gehoord");
    expect(out.records[0].data.koppeling).toBeUndefined();
    expect(out.summary).not.toContain("officieel");
    expect(out.access_note).not.toContain("Koppeling met het officiële verslag");
  });
});

describe("gehoord_debat_get with segment_id and koppeling", () => {
  beforeEach(() => {
    clearHttpCache();
    setCrawlDelaysEnabled(false);
    vi.stubEnv("GEHOORD_KEY", "k");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("links the segment to its official fragment; the fragments around it stay transcript", async () => {
    const v = { ...VERG_PLENAIR, verslag_id: "a1a1a1a1-0000-4000-8000-000000000003" };
    const { debate: _d, ...before } = raw(10, PLENAIR_DEBATE, { speakerLabel: PRICKAERTZ, speakerName: "Erwin Prickaertz", speakerParty: "PVV", startTime: "2026-10-28T13:25:21Z", endTime: "2026-10-28T13:25:32Z" });
    const { debate: _e, ...segment } = raw(11, PLENAIR_DEBATE);
    const urls = mockHttp({
      contributions: [before, segment],
      debate: { ...PLENAIR_DEBATE, debateType: "Plenair debat" },
      vergaderingen: [vergaderingRow(v, "2026-10-29T17:34:50+01:00")],
      verslagXml: PLENAIR_XML,
    });
    const out = await call("gehoord_debat_get", { debate_id: "301001", segment_id: 11, context: 1 });
    const [, first, seg] = out.records;
    expect(first.source_name).toBe("gehoord");
    expect(first.data.koppeling).toBeUndefined();
    expect(seg.source_name).toBe("tweedekamer");
    expect(seg.data).toMatchObject({ is_segment: true, positie: 1, koppeling: { status: "officieel" }, spreker: "Bart Bikkers" });
    expect(out.access_note).toContain("is gekoppeld aan het officiële verslag");
    // The debate is asked once, for the head record; the koppeling reuses it.
    expect(urls.filter((u) => u.pathname === "/api/v1/debates/301001")).toHaveLength(1);
  });
});

describe("nl_gov_ask answers a Gehoord question with linked hits", () => {
  beforeEach(() => {
    clearHttpCache();
    setCrawlDelaysEnabled(false);
    vi.stubEnv("GEHOORD_KEY", "k");
    vi.stubEnv("OVERHEID_API_KEY", "");
    vi.stubEnv("DSO_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("gives the official text for a Tweede Kamer hit", async () => {
    const v = { ...VERG_PLENAIR, verslag_id: "a1a1a1a1-0000-4000-8000-000000000004" };
    mockHttp({ contributions: [raw(21, PLENAIR_DEBATE)], vergaderingen: [vergaderingRow(v, "2026-10-29T17:34:50+01:00")], verslagXml: PLENAIR_XML });
    const out = await call("nl_gov_ask", { question: "Wat wordt er vandaag in de Tweede Kamer over natuur besproken?" });
    expect(out.summary).toMatch(/^Router: Gehoord\.de — .*officieel verslag gekoppeld: 1 van 1$/);
    expect(out.records[0]).toMatchObject({ source_name: "tweedekamer", data: { koppeling: { status: "officieel" }, spreker: "Bart Bikkers" } });
    expect(out.access_note).toContain("gekoppeld aan het officiële verslag");
  });
});

describe("the passage of a long official spreekbeurt", () => {
  it("centres on the first included term found, ignoring a term that is not there", () => {
    const filler = "Wij spreken vandaag over de begroting en over veel andere dingen. ".repeat(20);
    const text = `${filler}De provincie moet meer doen. ${filler}Het stikstofpakket schiet tekort. ${filler}`;
    expect(officialPassage(text, 400, ["landbouw", "stikstof"], 0).at).toBe(text.indexOf("stikstofpakket"));
    expect(officialPassage(text, 400, ["stikstof", "provincie"], 0).at).toBe(text.indexOf("provincie"));
    // A string is still one phrase.
    expect(officialPassage(text, 400, "stikstof provincie", 0.5).at).toBe(Math.round(text.length / 2));
  });

  const filler = "Wij spreken vandaag over de begroting en over veel andere dingen. ".repeat(20);
  const text = `${filler}Het stikstofpakket van dit kabinet schiet tekort. ${filler}`;

  it("finds the phrase as Gehoord does: a longer word inside a compound, a short one only whole", () => {
    expect(phrasePosition(text, "stikstof")).toBe(filler.length + 4);
    expect(phrasePosition("Een CO2-plafond per luchthaven", "co2 plafond")).toBe(4);
    expect(phrasePosition("De Wadden en het wad", "wad")).toBe(17);
    expect(phrasePosition(text, "stikstofslot")).toBe(-1);
  });

  it("shows the passage around a phrase inside a compound, not the opening", () => {
    const p = officialPassage(text, 400, "stikstof", 0);
    expect(p.at).toBe(filler.length + 4);
    expect(p.tekst).toContain("stikstofpakket");
    expect(p.ingekort).toBe(true);
  });

  it("falls back to where the hit falls in time", () => {
    expect(officialPassage(text, 400, "landbouw", 0.5).at).toBe(Math.round(text.length / 2));
  });
});

describe("TweedeKamerDebattenSource: shared downloads and today's list", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearHttpCache();
  });

  it("downloads a verslag once for callers side by side", async () => {
    const fetches: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      fetches.push(String(input));
      await new Promise((r) => setTimeout(r, 20));
      return xmlResponse(PLENAIR_XML);
    }));
    const src = new TweedeKamerDebattenSource(testConfig);
    const v = { verslag_id: "d0d0d0d0-0000-4000-8000-000000000001", verslag_gewijzigd: "x" };
    const [a, b, c] = await Promise.all([src.getVerslag(v), src.getVerslag(v), src.getVerslag(v)]);
    expect(fetches).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    // A failed download is not kept: the next call tries again.
    vi.stubGlobal("fetch", vi.fn(async () => xmlResponse("", 500)));
    const w = { verslag_id: "d0d0d0d0-0000-4000-8000-000000000002" };
    await expect(src.getVerslag(w, { retries: 0 })).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn(async () => xmlResponse(PLENAIR_XML)));
    await expect(src.getVerslag(w)).resolves.toMatchObject({ verslag_id: w.verslag_id });
  });

  it("keeps today's vergaderingen a minute, an earlier day's for the connector's ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (calls++, jsonResponse({ value: [] }))));
    const src = new TweedeKamerDebattenSource(testConfig);
    await src.vergaderingenOp("2026-11-03");
    await src.vergaderingenOp("2026-10-28");
    expect(calls).toBe(2);
    vi.setSystemTime(new Date("2026-11-03T12:01:30Z"));
    await src.vergaderingenOp("2026-11-03");
    await src.vergaderingenOp("2026-10-28");
    expect(calls).toBe(3);
  });
});

describe("the debate pages after the koppeling", () => {
  afterEach(() => vi.restoreAllMocks());

  it("look up a commissiedebat's page only in the time left, else the verslag stays the link", async () => {
    const seen: unknown[] = [];
    vi.spyOn(TweedeKamerDebattenSource.prototype, "commissieUrl").mockImplementation((_v, opts) => (seen.push(opts), new Promise(() => undefined)));
    const k = { status: "officieel" as const, vergadering: VERG_COMMISSIE };
    const started = Date.now();
    const pages = await koppelingPages([k], Date.now() + 1_200);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(pages.get(VERG_COMMISSIE.vergadering_id)).toBeUndefined();
    expect((seen[0] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(1_200);
    // No time left: no lookup at all; a plenary page needs none.
    seen.length = 0;
    const late = await koppelingPages([k, { status: "officieel" as const, vergadering: VERG_PLENAIR }], Date.now() - 1);
    expect(seen).toEqual([]);
    expect(late.get(VERG_PLENAIR.vergadering_id)).toBe("https://www.tweedekamer.nl/kamerstukken/plenaire_verslagen/detail/2026-2027/17");
  });

  it("take a commissiedebat's page from the Gehoord debate's tkActivityNumber, with no lookup", async () => {
    const seen: unknown[] = [];
    vi.spyOn(TweedeKamerDebattenSource.prototype, "commissieUrl").mockImplementation(async (_v, opts) => (seen.push(opts), "https://example.org/lookup"));
    const k = { status: "officieel" as const, vergadering: VERG_COMMISSIE };
    const pages = await koppelingPages([k, k], Date.now() + 5_000, [{ tkActivityNumber: "2026A05087" }, undefined]);
    expect(pages.get(VERG_COMMISSIE.vergadering_id)).toBe("https://www.tweedekamer.nl/debat_en_vergadering/commissievergaderingen/details?id=2026A05087");
    expect(seen).toEqual([]);
    // Without a number the lookup still runs.
    const looked = await koppelingPages([k], Date.now() + 5_000, [{}]);
    expect(looked.get(VERG_COMMISSIE.vergadering_id)).toBe("https://example.org/lookup");
    expect(seen).toHaveLength(1);
  });
});

describe("Gehoord getDebate with retries 0", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tries once with retries 0, so a 429 does not hold a slot", async () => {
    setCrawlDelaysEnabled(false);
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify({ error: "rate" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "0" } });
    }));
    const src = new GehoordSource(testConfig, "k");
    await expect(src.getDebate(1234, { retries: 0 })).rejects.toThrow();
    expect(calls).toBe(1);
    setCrawlDelaysEnabled(true);
  });
});

describe("gehoord_debatten_search with only official records", () => {
  beforeEach(() => {
    clearHttpCache();
    setCrawlDelaysEnabled(false);
    vi.stubEnv("GEHOORD_KEY", "k");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("leaves out the gehoord.de link note and keeps only the transcript passage it was found by", async () => {
    const v = { ...VERG_PLENAIR, verslag_id: "a1a1a1a1-0000-4000-8000-000000000009" };
    const long = `${"Dit is een lange zin uit de transcriptie. ".repeat(40)}Want de heer Bikkers begint over de natuur.`;
    mockHttp({ contributions: [raw(31, PLENAIR_DEBATE, { text: long })], vergaderingen: [vergaderingRow(v, "2026-10-29T17:34:50+01:00")], verslagXml: PLENAIR_XML });
    const out = await call("gehoord_debatten_search", { query: "Bikkers begint" });
    const [tk] = out.records;
    expect(tk.data.koppeling.status).toBe("officieel");
    expect(tk.data.gehoord_tekst.length).toBeLessThan(260);
    expect(tk.data.gehoord_tekst).toContain("Bikkers begint");
    expect(out.access_note).not.toContain("De link (fragment_url)");
    expect(out.access_note).toContain("automatische transcriptie");
    expect(out.access_note).toContain("niet om te citeren");
  });
});
