import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ALGORITME_ORGANISATIETYPES,
  ALGORITME_ORGANISATIETYPES_BROKEN,
  AlgoritmeregisterSource,
  normalizeAlgoritmeCategorie,
  pickMinistry,
  pickOrganisation,
  planAlgoritmeWindow,
  summarizeAlgoritmeSearch,
  toAlgoritmeItem,
  type OrganisationCandidate,
} from "../src/sources/algoritmeregister.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { SourceRequestError } from "../src/utils/http.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

const SEARCH = "https://algoritmes.overheid.nl/api/algoritme/NLD";
const ORG_SEARCH = "https://algoritmes.overheid.nl/api/organisation/NLD";

interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

/** fetch mock that records method, URL and JSON body of every request. */
function routedFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

function algo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Chatbot Afvalwijzer",
    organization: "Gemeente Zaltbommel",
    preferred_name: null,
    department: null,
    description_short: "<p>De gemeente gebruikt een <b>chatbot</b> op haar website.</p>",
    type: null,
    category: ["Organisatie en bedrijfsvoering"],
    status: "In gebruik",
    goal: "<p>Lange tekst</p>",
    provider: "Voorbeeld Software B.V.",
    begin_date: "2026-09",
    end_date: null,
    impacttoetsen: null,
    impacttoetsen_grouping: [{ title: "Data Protection Impact Assessment (DPIA)", link: null }],
    publication_category: "Overige algoritmes",
    lars: "81000001",
    language: "NLD",
    create_dt: "2026-09-29T13:29:52.399171Z",
    code: "gemeente-zaltbommel",
    org_id: "gm0297",
    hierarchy_path: "",
    ...over,
  };
}

function page(results: unknown[], total: number, selected: Array<{ key: string; value: string }> = []) {
  return jsonResponse({ results, total_count: total, filter_data: {}, selected_filters: selected });
}

function orgOverview(results: Array<Record<string, unknown>>, total = results.length) {
  return jsonResponse({ results, total_count: total, filter_data: { organisationtype: [] }, selected_filters: [] });
}

const UTRECHT_ORGS = [
  { code: "gemeente-utrecht", count: 45, name: "Gemeente Utrecht", show_page: false, roo_type: "Gemeente", org_id: "gm0344", has_children: false },
  { code: "provincie-utrecht", count: 8, name: "Provincie Utrecht", show_page: false, roo_type: "Provincie", org_id: "pv26", has_children: false },
  { code: "omgevingsdienst-regio-utrecht", count: 2, name: "Omgevingsdienst regio Utrecht", show_page: false, roo_type: "Regionaal samenwerkingsorgaan", org_id: "so0697", has_children: false },
];

/** Live: the register's organisation search answers "Ministerie van <anything>" with these 14. */
const MINISTRY_LIST: Array<[string, string, number]> = [
  ["mnre1090", "Ministerie van Financiën", 140],
  ["mnre1058", "Ministerie van Justitie en Veiligheid", 14],
  ["mnre1018", "Ministerie van Defensie", 5],
  ["mnre1025", "Ministerie van Volksgezondheid, Welzijn en Sport", 5],
  ["mnre1045", "Ministerie van Economische Zaken en Klimaat", 4],
  ["mnre1034", "Ministerie van Binnenlandse Zaken en Koninkrijksrelaties", 3],
  ["mnre1013", "Ministerie van Buitenlandse Zaken", 3],
  ["mnre1130", "Ministerie van Infrastructuur en Waterstaat", 3],
  ["mnre1153", "Ministerie van Landbouw, Natuur en Voedselkwaliteit", 3],
  ["oorg12355", "Inspectie van het Onderwijs (OCW)", 2],
  ["mnre1109", "Ministerie van Onderwijs, Cultuur en Wetenschap", 2],
  ["mnre1073", "Ministerie van Sociale Zaken en Werkgelegenheid", 2],
  ["mnre1171", "Ministerie van Volkshuisvesting en Ruimtelijke Ordening", 2],
  ["mnre1010", "Ministerie van Algemene Zaken", 1],
];

/** Live: the organisation overview with organisationtype 'ministerie' (all 14 ministries that publish). */
const MINISTRY_TYPE_LIST: Array<[string, string, number]> = [
  ...MINISTRY_LIST.filter(([id]) => id !== "oorg12355"),
  ["mnre1162", "Asiel en Migratie", 2],
];

function cand(org_id: string, name: string, count = 1): OrganisationCandidate {
  return { org_id, name, count };
}

const MINISTRIES = MINISTRY_LIST.map(([id, name, count]) => cand(id, name, count));
const ministry = (id: string) => MINISTRIES.find((m) => m.org_id === id)!;
const ALL_MINISTRIES = MINISTRY_TYPE_LIST.map(([id, name, count]) => cand(id, name, count));

/** One organisation as the overview (POST) and the name list (GET) return it. */
function orgRow(org_id: string, name: string, count: number): Record<string, unknown> {
  return { code: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), count, name, org_id, show_page: false, has_children: false };
}

const SUGGEST = "https://algoritmes.overheid.nl/api/suggestion/NLD/";
const suggestUrl = (search: string) => `${SUGGEST}${encodeURIComponent(search)}`;

/** A suggestion answer with `n` exact hits that are not the rows under test. */
function otherHits(n: number) {
  return jsonResponse({ algorithms: Array.from({ length: n }, (_, i) => ({ name: `Elders ${i}`, organization: "Gemeente Elders", lars: String(90000000 + i) })) });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearHttpCache();
});

describe("planAlgoritmeWindow", () => {
  it("uses the limit as page size when the offset is on a page boundary", () => {
    expect(planAlgoritmeWindow(0, 20)).toEqual({ pageSize: 20, pages: [1], skip: 0 });
    expect(planAlgoritmeWindow(40, 20)).toEqual({ pageSize: 20, pages: [3], skip: 0 });
  });

  it("finds the smallest single page that holds an unaligned window", () => {
    // Items 30..49: page 2 of 25 (items 25..49), skip 5.
    expect(planAlgoritmeWindow(30, 20)).toEqual({ pageSize: 25, pages: [2], skip: 5 });
    expect(planAlgoritmeWindow(95, 10)).toEqual({ pageSize: 15, pages: [7], skip: 5 });
  });

  it("falls back to two pages of 100 and clamps the limit to the upstream maximum", () => {
    expect(planAlgoritmeWindow(150, 100)).toEqual({ pageSize: 100, pages: [2, 3], skip: 50 });
    expect(planAlgoritmeWindow(0, 150)).toEqual({ pageSize: 100, pages: [1], skip: 0 });
    expect(planAlgoritmeWindow(-5, Number.NaN)).toEqual({ pageSize: 20, pages: [1], skip: 0 });
  });
});

describe("pickOrganisation", () => {
  const utrecht = UTRECHT_ORGS.map((o) => cand(o.org_id, o.name, o.count));

  it("reads a bare place name as the municipality and reports the other matches", () => {
    const r = pickOrganisation("Utrecht", utrecht);
    expect(r.status).toBe("resolved");
    expect(r.match).toBe("naam");
    expect(r.organisation?.org_id).toBe("gm0344");
    expect(r.alternatives.map((a) => a.org_id)).toEqual(["pv26", "so0697"]);
  });

  it("prefers the municipality on a tie even when upstream lists the province first", () => {
    const r = pickOrganisation("Groningen", [cand("pv20", "Provincie Groningen", 20), cand("gm0014", "Gemeente Groningen", 15)]);
    expect(r.organisation?.org_id).toBe("gm0014");
  });

  it("prefers the province over other bodies on a tie without a municipality", () => {
    const r = pickOrganisation("Fryslân", [
      cand("gm1970", "Gemeente Noardeast Fryslân", 7),
      cand("ws0653", "Wetterskip Fryslân", 2),
      cand("pv21", "Provincie Fryslân", 1),
    ]);
    expect(r.organisation?.org_id).toBe("pv21");
  });

  it("takes an exact name over a prefix match and ignores accents", () => {
    expect(pickOrganisation("provincie utrecht", utrecht).organisation?.org_id).toBe("pv26");
    const fin = pickOrganisation("Financien", [cand("mnre1090", "Ministerie van Financiën", 140)]);
    expect(fin.match).toBe("naam");
    expect(fin.organisation?.org_id).toBe("mnre1090");
  });

  it("does not guess between several partial matches", () => {
    const r = pickOrganisation("Gemeente", [cand("gm0363", "Gemeente Amsterdam", 72), cand("gm0344", "Gemeente Utrecht", 45)], 211);
    expect(r.status).toBe("ambiguous");
    expect(r.organisation).toBeUndefined();
    expect(r.candidate_total).toBe(211);
  });

  it("accepts a single partial match", () => {
    const r = pickOrganisation("Regio Rivierenland", [cand("so0866", "Gemeenschappelijke regeling Regio Rivierenland", 2)]);
    expect(r.status).toBe("resolved");
    expect(r.match).toBe("deel");
  });

  it("does not swap in an organisation that only shares a word (upstream similarity fallback)", () => {
    // The name search can answer a place with only another one that shares a word.
    const r = pickOrganisation("West Betuwe", [cand("gm1740", "Gemeente Neder-Betuwe", 3)]);
    expect(r.status).toBe("not_found");
    expect(r.organisation).toBeUndefined();
    expect(r.alternatives.map((a) => a.org_id)).toEqual(["gm1740"]);
  });

  it("does not take a stem match for another organisation", () => {
    // Upstream stems 'Rijnland' to match 'Rijnlanden'.
    const r = pickOrganisation("Hoogheemraadschap van Rijnland", [cand("ws0636", "HDSR Hoogheemraadschap De Stichtse Rijnlanden", 2)]);
    expect(r.status).toBe("not_found");
    expect(r.alternatives.map((a) => a.org_id)).toEqual(["ws0636"]);
  });

  it("requires the type the input names", () => {
    expect(pickOrganisation("Veiligheidsregio Flevoland", [cand("pv24", "Provincie Flevoland", 3)]).status).toBe("not_found");
    const water = pickOrganisation("Waterschap Rijnland", [cand("ws0616", "Hoogheemraadschap van Rijnland", 1)]);
    expect(water.match).toBe("naam");
    expect(pickOrganisation("Rijnland", [cand("ws0616", "Hoogheemraadschap van Rijnland", 1)]).match).toBe("naam");
  });

  it("only names a few look-alikes that share a word with the input", () => {
    const noise = pickOrganisation("Veiligheidsregio Flevoland", [cand("so0636", "Veiligheidsregio Amsterdam-Amstelland", 2), cand("so0679", "Veiligheidsregio Twente", 1)]);
    expect(noise.status).toBe("not_found");
    expect(noise.alternatives).toEqual([]);
    const many = pickOrganisation("Gemeente Hengelo", [cand("gm0363", "Gemeente Amsterdam", 72), cand("gm0344", "Gemeente Utrecht", 45)], 211);
    expect(many).toMatchObject({ status: "not_found", alternatives: [] });
  });

  it("accepts one candidate for an abbreviation the register matched on other text", () => {
    expect(pickOrganisation("CBS", [cand("zb000193", "Centraal Bureau voor de Statistiek", 1)])).toMatchObject({ status: "resolved", match: "deel" });
    expect(pickOrganisation("UWV", [cand("zb000117", "Uitvoeringsinstituut Werknemersverzekeringen", 12)]).organisation?.org_id).toBe("zb000117");
    expect(pickOrganisation("duo", [cand("oorg10148", "Dienst Uitvoering Onderwijs", 7)]).status).toBe("resolved");
    // Not an abbreviation: a misspelling the fallback answered with a look-alike.
    expect(pickOrganisation("West Betuve", [cand("gm1740", "Gemeente Neder-Betuwe", 3)]).status).toBe("not_found");
  });

  it("accepts abbreviations in any case, with a type word, and not only the initials", () => {
    // Live: the register's organisation search answers each of these with only this organisation.
    const uwv = cand("zb000117", "Uitvoeringsinstituut Werknemersverzekeringen", 12);
    for (const input of ["uwv", "Uwv"]) expect(pickOrganisation(input, [uwv]).organisation?.org_id).toBe("zb000117");
    const ienw = cand("mnre1130", "Ministerie van Infrastructuur en Waterstaat", 3);
    for (const input of ["IenW", "Ministerie van IenW"]) expect(pickOrganisation(input, [ienw]).organisation?.org_id).toBe("mnre1130");
    expect(pickOrganisation("Ministerie van VWS", [cand("mnre1025", "Ministerie van Volksgezondheid, Welzijn en Sport", 5)])).toMatchObject({
      status: "resolved",
      match: "deel",
      organisation: { org_id: "mnre1025" },
    });
    expect(pickOrganisation("rws", [cand("oorg10004", "Rijkswaterstaat", 3)]).status).toBe("resolved");
    expect(pickOrganisation("RvIG", [cand("oorg10103", "Rijksdienst voor Identiteitsgegevens", 22)]).status).toBe("resolved");
    expect(pickOrganisation("MinFin", [cand("mnre1090", "Ministerie van Financiën", 140)]).status).toBe("resolved");
  });

  it("names the single candidate as a look-alike when the token is no abbreviation of it", () => {
    // Live: the organisation search prefix-matches 'OM' to Gemeente Ommen only; OM is the Openbaar Ministerie.
    const ommen = cand("gm0175", "Gemeente Ommen", 3);
    expect(pickOrganisation("OM", [ommen])).toMatchObject({ status: "not_found", alternatives: [ommen] });
    expect(pickOrganisation("Venl", [cand("gm0983", "Gemeente Venlo", 4)]).status).toBe("not_found");
    // A misspelling of one word, not an abbreviation.
    expect(pickOrganisation("Weet", [cand("gm0988", "Gemeente Weert", 6)]).status).toBe("not_found");
    // The type word the input names must match.
    const r = pickOrganisation("Gemeente UWV", [cand("zb000117", "Uitvoeringsinstituut Werknemersverzekeringen", 12)]);
    expect(r).toMatchObject({ status: "not_found", alternatives: [{ org_id: "zb000117" }] });
  });

  it("reads 'Min' in front of an abbreviation as the ministry's type word", () => {
    // Live: the search answers 'MinEZK' with BZK only, whose type word alone holds m-i-n-e.
    // EZK is a known abbreviation of another ministry, so BZK is not even a look-alike.
    for (const input of ["MinEZK", "minezk", "Min EZK"]) {
      expect(pickOrganisation(input, [ministry("mnre1034")])).toMatchObject({ status: "not_found", alternatives: [] });
    }
    // Live: the search answers each of these with the right ministry only.
    for (const input of ["MinIenW", "Min IenW", "Min. IenW", "minienw"]) {
      expect(pickOrganisation(input, [ministry("mnre1130")])).toMatchObject({ status: "resolved", match: "deel", organisation: { org_id: "mnre1130" } });
    }
    expect(pickOrganisation("MinBuZa", [ministry("mnre1013")]).organisation?.org_id).toBe("mnre1013");
    // After the ministry's type word the start of a word counts.
    for (const input of ["MinFin", "minfin", "Min. Fin", "Ministerie van Fin"]) {
      expect(pickOrganisation(input, [ministry("mnre1090")]).organisation?.org_id).toBe("mnre1090");
    }
    expect(pickOrganisation("MinDef", [ministry("mnre1018")]).organisation?.org_id).toBe("mnre1018");
  });

  it("takes the one ministry a typed abbreviation fits when the search lists them all", () => {
    const cases: Array<[string, string]> = [
      ["Ministerie van JenV", "mnre1058"],
      ["Ministerie van I&W", "mnre1130"],
      ["Ministerie van J&V", "mnre1058"],
      ["MinSZW", "mnre1073"],
      ["MinEZK", "mnre1045"],
      ["MinVRO", "mnre1171"],
    ];
    for (const [input, id] of cases) {
      expect(pickOrganisation(input, MINISTRIES, 14)).toMatchObject({ status: "resolved", match: "deel", organisation: { org_id: id } });
    }
    // A known ministry abbreviation needs no complete list: the table names the ministry.
    expect(pickOrganisation("Ministerie van JenV", MINISTRIES, 40).organisation?.org_id).toBe("mnre1058");
    // Only filler words after the type word: every ministry fits, nothing is guessed.
    expect(pickOrganisation("Ministerie van", MINISTRIES, 14).status).toBe("ambiguous");
    // The word itself cut short is no 'Min' form ("ist" would fit Infrastructuur en Waterstaat).
    expect(pickOrganisation("Minist", MINISTRIES, 14).status).toBe("not_found");
    // A type-less abbreviation is not picked from a list.
    expect(pickOrganisation("JenV", MINISTRIES, 14).status).toBe("not_found");
  });

  it("lets a typed abbreviation use the type word only when it starts with its letter", () => {
    // Live: 'Hoogheemraadschap HHNK' lists these three; HH is Hoogheemraadschap itself.
    const boards = [
      cand("ws0651", "Hoogheemraadschap Hollands Noorderkwartier", 3),
      cand("ws0636", "HDSR Hoogheemraadschap De Stichtse Rijnlanden", 2),
      cand("ws0372", "Hoogheemraadschap van Delfland", 1),
    ];
    expect(pickOrganisation("Hoogheemraadschap HHNK", boards, 3)).toMatchObject({ status: "resolved", organisation: { org_id: "ws0651" } });
    // In a partial list the one fit seen need not be the only one.
    expect(pickOrganisation("Hoogheemraadschap HHNK", boards, 40).status).toBe("not_found");
    // 'van' does not lend its v to an abbreviation that does not start with the type word's letter.
    expect(pickOrganisation("MinVRO", [ministry("mnre1153")]).status).toBe("not_found");
  });

  it("requires the capitals of a mixed-case abbreviation to start words", () => {
    // Live: the search answers 'MinVenJ' (the old Veiligheid en Justitie) with VWS only;
    // v-e-n-j does occur in that order in "Volksgezondheid, Welzijn en Sport".
    const vws = ministry("mnre1025");
    expect(pickOrganisation("MinVenJ", [vws])).toMatchObject({ status: "not_found", alternatives: [{ org_id: "mnre1025" }] });
    expect(pickOrganisation("VenJ", [vws]).status).toBe("not_found");
    expect(pickOrganisation("Ministerie van VenJ", MINISTRIES, 14).status).toBe("not_found");
    // A capital inside the word the previous one started still fits ('G' in 'Identiteitsgegevens').
    expect(pickOrganisation("RvIG", [cand("oorg10103", "Rijksdienst voor Identiteitsgegevens", 22)]).status).toBe("resolved");
    expect(pickOrganisation("KvK", [cand("zb000184", "Kamer van Koophandel", 4)]).status).toBe("resolved");
    expect(pickOrganisation("SodM", [cand("zb000999", "Staatstoezicht op de Mijnen", 1)]).status).toBe("resolved");
    expect(pickOrganisation("NZa", [cand("zb000158", "Nederlandse Zorgautoriteit (NZa)", 3)]).status).toBe("resolved");
  });

  describe("ministry abbreviations", () => {
    const withAenM = [...MINISTRIES, cand("mnre1162", "Asiel en Migratie", 2)];

    it("takes a ministry form only to the ministry the table of abbreviations names", () => {
      const cases: Array<[string, string]> = [
        ["MinOCW", "mnre1109"],
        ["Ministerie van OCW", "mnre1109"],
        ["Min. OCW", "mnre1109"],
        ["Ministerie OCW", "mnre1109"],
        ["ministerie van ocw", "mnre1109"],
        ["MinOC&W", "mnre1109"],
        ["MinLNV", "mnre1153"],
        ["MinLVVN", "mnre1153"],
        ["MinBZ", "mnre1013"],
        ["Ministerie van AZ", "mnre1010"],
        // The letters a-m also occur in "Algemene Zaken"; A&M is Asiel en Migratie.
        ["Ministerie van A&M", "mnre1162"],
        ["MinAenM", "mnre1162"],
      ];
      for (const [input, id] of cases) {
        expect(pickOrganisation(input, withAenM, 15)).toMatchObject({ status: "resolved", match: "deel", organisation: { org_id: id } });
      }
    });

    it("does not take another organisation when the named ministry is not among the candidates", () => {
      // Live: 'MinOCW' and 'Ministerie van OCW' find only the inspectorate, whose name holds "(OCW)".
      const inspectie = cand("oorg12355", "Inspectie van het Onderwijs (OCW)", 2);
      for (const input of ["MinOCW", "Ministerie van OCW"]) {
        expect(pickOrganisation(input, [inspectie])).toMatchObject({ status: "not_found", alternatives: [] });
      }
      expect(pickOrganisation("Ministerie van A&M", MINISTRIES, 14)).toMatchObject({ status: "not_found", alternatives: [] });
    });

    it("names the ministries an unknown abbreviation fits instead of choosing one", () => {
      // v-e-n-w fits "Volksgezondheid, Welzijn en Sport"; VenW was Verkeer en Waterstaat.
      expect(pickOrganisation("Ministerie van VenW", withAenM, 15)).toMatchObject({ status: "not_found", alternatives: [{ org_id: "mnre1025" }] });
      expect(pickOrganisation("MinVenW", [ministry("mnre1025")])).toMatchObject({ status: "not_found", alternatives: [{ org_id: "mnre1025" }] });
    });

    it("leaves a bare abbreviation to the organisation search", () => {
      // Bare forms are resolved by resolveOrganisation, which knows whether the ministry publishes.
      expect(pickOrganisation("OCW", [cand("oorg12355", "Inspectie van het Onderwijs (OCW)", 2)]).organisation?.org_id).toBe("oorg12355");
    });

    it("does not take an unknown ministry form from candidates that need not hold every ministry", () => {
      // The name search's list lacks Asiel en Migratie, and a short form finds one ministry at most.
      expect(pickOrganisation("MinJus", [ministry("mnre1058")])).toMatchObject({ status: "not_found", alternatives: [{ org_id: "mnre1058" }] });
      expect(pickOrganisation("MinOnd", MINISTRIES, 14)).toMatchObject({ status: "not_found", alternatives: [{ org_id: "mnre1109" }] });
    });
  });

  describe("pickMinistry (the register's list of all ministries)", () => {
    it("takes a ministry form the table does not know when it names exactly one ministry", () => {
      const cases: Array<[string, string]> = [
        // The letters start one word of the name.
        ["MinJus", "mnre1058"],
        ["Minjus", "mnre1058"],
        ["MINJUS", "mnre1058"],
        ["Min. Jus", "mnre1058"],
        ["MinOnd", "mnre1109"],
        ["Ministerie van Financ", "mnre1090"],
        ["Ministerie van Onderw", "mnre1109"],
        ["MinAsiel", "mnre1162"],
        // Each capital starts the next word, the letters after it continue that word.
        ["MinSoZaWe", "mnre1073"],
        ["Ministerie van SoZa", "mnre1073"],
        ["MinEcZa", "mnre1045"],
        // Short names the table lists, so that lower case works too.
        ["minsozawe", "mnre1073"],
        ["MinBiZa", "mnre1034"],
        ["minbiza", "mnre1034"],
        ["MinBuZa", "mnre1013"],
      ];
      for (const [input, id] of cases) {
        expect(pickMinistry(input, ALL_MINISTRIES, 14)).toMatchObject({ status: "resolved", match: "deel", organisation: { org_id: id } });
      }
    });

    it("does not take a ministry whose name the letters merely occur in", () => {
      // VenW was Verkeer en Waterstaat: in "Volksgezondheid, Welzijn en Sport" the word after V is not "en".
      for (const input of ["MinVenW", "Ministerie van VenW"]) {
        expect(pickMinistry(input, ALL_MINISTRIES, 14)).toMatchObject({ status: "not_found", alternatives: [{ org_id: "mnre1025" }] });
      }
      // IenM was Infrastructuur en Milieu; VenJ (Veiligheid en Justitie) has its words the other way round.
      for (const input of ["MinIenM", "MinVenJ"]) expect(pickMinistry(input, ALL_MINISTRIES, 14).status).toBe("not_found");
      // A&M is Asiel en Migratie, never Algemene Zaken (M starts no word there).
      const withoutAenM = ALL_MINISTRIES.filter((m) => m.org_id !== "mnre1162");
      expect(pickMinistry("Ministerie van A&M", withoutAenM, 13)).toMatchObject({ status: "not_found", alternatives: [] });
    });

    it("names the ministries a form fits when it names several or the list is incomplete", () => {
      // "Vol" starts both Volksgezondheid and Volkshuisvesting.
      const vol = pickMinistry("MinVol", ALL_MINISTRIES, 14);
      expect(vol.status).toBe("not_found");
      expect(vol.alternatives.slice(0, 2).map((c) => c.org_id)).toEqual(["mnre1025", "mnre1171"]);
      // Without every ministry in the list, the one fit seen need not be the only one.
      expect(pickMinistry("MinJus", ALL_MINISTRIES, 40)).toMatchObject({ status: "not_found", alternatives: [{ org_id: "mnre1058" }] });
    });

    it("leaves names, known abbreviations and plain words to pickOrganisation", () => {
      expect(pickMinistry("MinOCW", ALL_MINISTRIES, 14).organisation?.org_id).toBe("mnre1109");
      expect(pickMinistry("Ministerie van Defensie", ALL_MINISTRIES, 14)).toMatchObject({ status: "resolved", match: "exact" });
      // "Zaken" is a word of five names: no guess.
      expect(pickMinistry("Ministerie van Zaken", ALL_MINISTRIES, 14).status).toBe("ambiguous");
    });
  });

  it("does not let an input of single letters fit every candidate", () => {
    // Live: the search answers 'I&W' with DUS-I only; before, every candidate 'contained all words'.
    const dusi = cand("988964", "Dienst Uitvoering Subsidies aan Instellingen (DUS-I)", 1);
    expect(pickOrganisation("I&W", [dusi])).toMatchObject({ status: "not_found", alternatives: [{ org_id: "988964" }] });
    expect(pickOrganisation("J & V", [dusi]).status).toBe("not_found");
  });
});

describe("normalizeAlgoritmeCategorie", () => {
  it("maps case and accent variants to the register's theme", () => {
    expect(normalizeAlgoritmeCategorie("sociale  zekerheid")).toEqual({ value: "Sociale zekerheid", known: true });
    expect(normalizeAlgoritmeCategorie("overheidsfinancien")).toEqual({ value: "Overheidsfinanciën", known: true });
    expect(normalizeAlgoritmeCategorie("Defensie")).toEqual({ value: "Defensie", known: false });
  });
});

describe("toAlgoritmeItem", () => {
  it("keeps the useful fields as plain text and links to the algorithm page", () => {
    const item = toAlgoritmeItem(algo({ begin_date: "-", category: "Recht", impacttoetsen: "<p>DPIA gedaan</p>", impacttoetsen_grouping: null }));
    expect(item).toMatchObject({
      id: "81000001",
      title: "Chatbot Afvalwijzer",
      organisation: "Gemeente Zaltbommel",
      organisation_id: "gm0297",
      organisation_code: "gemeente-zaltbommel",
      description_short: "De gemeente gebruikt een chatbot op haar website.",
      status: "In gebruik",
      publication_category: "Overige algoritmes",
      category: ["Recht"],
      provider: "Voorbeeld Software B.V.",
      impact_assessments: [],
      published_at: "2026-09-29T13:29:52.399171Z",
      url: "https://algoritmes.overheid.nl/nl/algoritme/81000001",
      organisation_url: "https://algoritmes.overheid.nl/nl/organisatie/gm0297",
    });
    // "-" placeholder and null type are dropped, not passed on as values.
    expect(item).not.toHaveProperty("begin_date");
    expect(item).not.toHaveProperty("type");
    expect(toAlgoritmeItem(algo())?.impact_assessments).toEqual(["Data Protection Impact Assessment (DPIA)"]);
  });

  it("skips a row without LARS id instead of inventing a link", () => {
    expect(toAlgoritmeItem(algo({ lars: null }))).toBeUndefined();
  });
});

describe("AlgoritmeregisterSource.search", () => {
  it("posts a keyword search and maps the results", async () => {
    const calls = routedFetch((c) => {
      if (c.url === SEARCH) return page([algo()], 51, [{ key: "searchtext", value: "chatbot" }]);
      if (c.url.includes("/api/suggestion/NLD/")) return jsonResponse({ algorithms: [{ name: "Chatbot Afvalwijzer", organization: "Gemeente Zaltbommel", lars: "81000001" }] });
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ query: "  chatbot ", limit: 20 });

    expect(calls[0]).toMatchObject({ url: SEARCH, method: "POST", body: { searchtext: "chatbot", page: 1, limit: 20 } });
    expect(calls[0].body).not.toHaveProperty("organisation");
    expect(out.total).toBe(51);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].url).toBe("https://algoritmes.overheid.nl/nl/algoritme/81000001");
    expect(out.fuzzy).toBeUndefined();
    expect(out.access_note).toContain("niet volledig");
    expect(out.params).toMatchObject({ searchtext: "chatbot", page: "1", limit: "20" });
    expect(summarizeAlgoritmeSearch(out)).toBe("51 algoritmes in het Algoritmeregister voor 'chatbot'; getoond 1-1");
  });

  it("resolves an organisation name to its org_id and names the alternatives", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH) return orgOverview(UTRECHT_ORGS);
      if (c.url === SEARCH) return page([algo({ organization: "Gemeente Utrecht", org_id: "gm0344" })], 45, [{ key: "organisation", value: "Gemeente Utrecht" }]);
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Utrecht", limit: 5 });

    expect(calls[0]).toMatchObject({ url: ORG_SEARCH, method: "POST", body: { searchtext: "Utrecht" } });
    expect(calls[1].body).toMatchObject({ organisation: "gm0344", include_children: true, searchtext: "" });
    expect(out.total).toBe(45);
    expect(out.access_note).toContain("Organisatie 'Utrecht' opgevat als Gemeente Utrecht (gm0344)");
    expect(out.access_note).toContain("Provincie Utrecht (pv26, 8 algoritmes)");
    expect(summarizeAlgoritmeSearch(out)).toContain("45 algoritmes in het Algoritmeregister van Gemeente Utrecht");
    // No keywords: no suggestion lookup for the fuzzy check.
    expect(calls.some((c) => c.url.includes("/api/suggestion/"))).toBe(false);
  });

  it("tries the register's own name for a place before calling an everyday name ambiguous", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH && c.body?.searchtext === "Gemeente Den Bosch") {
        // The register's name search matches on "den".
        return orgOverview([
          { code: "gemeente-den-haag", count: 44, name: "Gemeente Den Haag", org_id: "gm0518", show_page: false, has_children: false },
          { code: "gemeente-den-helder", count: 2, name: "Gemeente Den Helder", org_id: "gm0400", show_page: false, has_children: false },
        ]);
      }
      if (c.url === ORG_SEARCH && c.body?.searchtext === "'s-Hertogenbosch") {
        return orgOverview([{ code: "gemeente-s-hertogenbosch", count: 2, name: "Gemeente 's-Hertogenbosch", org_id: "gm0796", show_page: false, has_children: false }]);
      }
      if (c.url === SEARCH) return page([algo({ organization: "Gemeente 's-Hertogenbosch", org_id: "gm0796" })], 2);
      throw new Error(`unexpected ${c.url} ${JSON.stringify(c.body)}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Gemeente Den Bosch" });

    expect(calls.map((c) => c.body?.searchtext ?? c.body?.organisation)).toEqual(["Gemeente Den Bosch", "'s-Hertogenbosch", ""]);
    expect(calls[2].body).toMatchObject({ organisation: "gm0796" });
    expect(out.access_note).toContain("Organisatie 'Gemeente Den Bosch' opgevat als Gemeente 's-Hertogenbosch (gm0796)");
  });

  it("keeps the first answer when no alias resolves", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH && c.body?.searchtext === "Friesland") return orgOverview([]);
      if (c.url === ORG_SEARCH && c.body?.searchtext === "Fryslân") {
        return orgOverview([
          { code: "a", count: 7, name: "Gemeente Noardeast Fryslân", org_id: "gm1970", show_page: false, has_children: false },
          { code: "b", count: 2, name: "Wetterskip Fryslân", org_id: "ws0653", show_page: false, has_children: false },
          { code: "c", count: 1, name: "Provincie Fryslân", org_id: "pv21", show_page: false, has_children: false },
        ]);
      }
      if (c.url === SEARCH) return page([], 1);
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Friesland" });

    expect(calls.at(-1)?.body).toMatchObject({ organisation: "pv21" });
    expect(out.organisation?.match).toBe("naam");
  });

  it("accepts a register org_id and takes the display name from the register's echo", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH) return orgOverview([]);
      if (c.url.endsWith("/api/organisation-relation/189378")) {
        return jsonResponse({ org_id: "189378", hierarchy: [{ org_id: "mnre1090", name: "Financiën" }, { org_id: "189378", name: "Directoraat-generaal Belastingdienst" }] });
      }
      if (c.url === SEARCH) return page([algo({ organization: "Belastingdienst", org_id: "189378" })], 69, [{ key: "organisation", value: "Belastingdienst" }]);
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "189378" });

    expect(calls.map((c) => c.url)).toEqual([ORG_SEARCH, "https://algoritmes.overheid.nl/api/organisation-relation/189378", SEARCH]);
    expect(out.organisation?.match).toBe("org_id");
    expect(out.organisation?.organisation?.name).toBe("Belastingdienst");
    expect(out.access_note).toContain("Organisatie: Belastingdienst (189378).");
  });

  it("accepts a register code via the code lookup", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH) return orgOverview([]);
      if (c.url.includes("/api/organisation-relation/")) return jsonResponse({ org_id: "gemeente-staphorst", hierarchy_path: "", hierarchy: [] });
      if (c.url.endsWith("/api/organisation/gemeente-staphorst")) return jsonResponse({ code: "gemeente-staphorst", org_id: "gm0180" });
      if (c.url === SEARCH) return page([algo({ organization: "Gemeente Staphorst", org_id: "gm0180" })], 4, [{ key: "organisation", value: "Gemeente Staphorst" }]);
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "gemeente-staphorst" });

    expect(calls.at(-1)?.body).toMatchObject({ organisation: "gm0180" });
    expect(out.organisation?.match).toBe("code");
    expect(summarizeAlgoritmeSearch(out)).toContain("4 algoritmes in het Algoritmeregister van Gemeente Staphorst");
  });

  it("says so when an organisation is unknown or has nothing published, without searching", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH) return orgOverview([]);
      if (c.url.endsWith("/api/organisation/NLD/Afvalverwijdering%20Utrecht")) {
        return jsonResponse({ organisations: [{ name: "Afvalverwijdering Utrecht", code: "afvalverwijdering-utrecht", org_id: "so0329", show_page: false, count: 0 }] });
      }
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Afvalverwijdering Utrecht", query: "chatbot" });

    // A name with a space is no id or code: no relation/code lookups, and no algorithm search.
    expect(calls.map((c) => c.url)).toEqual([ORG_SEARCH, `${ORG_SEARCH}/Afvalverwijdering%20Utrecht`]);
    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.access_note).toContain("Wel in het register bekend, maar zonder gepubliceerde algoritmes: Afvalverwijdering Utrecht");
    expect(summarizeAlgoritmeSearch(out)).toContain("Geen organisatie met gepubliceerde algoritmes gevonden voor 'Afvalverwijdering Utrecht'");
  });

  it("treats a 404 from the code lookup as not found", async () => {
    routedFetch((c) => {
      if (c.url === ORG_SEARCH) return orgOverview([]);
      if (c.url.includes("/api/organisation-relation/")) return jsonResponse({ org_id: "zzz", hierarchy: [] });
      if (c.url.endsWith("/api/organisation/zzz")) return jsonResponse({ detail: "Kan corresponderende org_id niet vinden." }, 404);
      if (c.url.endsWith("/api/organisation/NLD/zzz")) return jsonResponse(null);
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "zzz" });

    expect(out.organisation?.status).toBe("not_found");
    expect(out.total).toBe(0);
    expect(out.access_note).toContain("Controleer de schrijfwijze");
  });

  it("returns no algorithms and the candidates for an ambiguous organisation", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH) {
        return orgOverview(
          [
            { code: "gemeente-amsterdam", count: 72, name: "Gemeente Amsterdam", org_id: "gm0363", show_page: false, has_children: false },
            { code: "gemeente-utrecht", count: 45, name: "Gemeente Utrecht", org_id: "gm0344", show_page: false, has_children: false },
          ],
          211,
        );
      }
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Gemeente" });

    expect(calls).toHaveLength(1);
    expect(out.total).toBeNull();
    expect(out.items).toEqual([]);
    expect(out.access_note).toContain("Gemeente Amsterdam (gm0363, 72 algoritmes)");
    expect(summarizeAlgoritmeSearch(out)).toContain("niet eenduidig: 211 organisaties");
  });

  it("reports a municipality without published algorithms instead of one that shares a word", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH) return orgOverview([orgRow("gm1740", "Gemeente Neder-Betuwe", 3)]);
      if (c.url === `${ORG_SEARCH}/West%20Betuwe`) {
        return jsonResponse({
          organisations: [orgRow("gm1960", "Gemeente West Betuwe", 0), orgRow("so0856", "Bedrijfsvoeringsorganisatie West Betuwe", 0)],
        });
      }
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "West Betuwe", limit: 5 });

    expect(calls.some((c) => c.url === SEARCH)).toBe(false);
    expect(out.items).toEqual([]);
    expect(out.organisation).toMatchObject({ status: "not_found", without_algorithms: ["Gemeente West Betuwe (gm1960)"] });
    expect(summarizeAlgoritmeSearch(out)).toBe(
      "Geen organisatie met gepubliceerde algoritmes gevonden voor 'West Betuwe' in het Algoritmeregister. Wel bekend zonder gepubliceerde algoritmes: Gemeente West Betuwe (gm1960).",
    );
    expect(out.access_note).toContain("gelijkende naam die wel algoritmes publiceren: Gemeente Neder-Betuwe (gm1740, 3 algoritmes)");
  });

  it("finds a full name with a type word that the name search answers with unrelated organisations", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH) {
        return orgOverview([orgRow("gm0363", "Gemeente Amsterdam", 72), orgRow("gm0344", "Gemeente Utrecht", 45)], 211);
      }
      if (c.url === `${ORG_SEARCH}/Gemeente%20Hengelo`) return jsonResponse({ organisations: [orgRow("gm0164", "Gemeente Hengelo", 0)] });
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Gemeente Hengelo" });

    expect(calls).toHaveLength(2);
    expect(out.organisation?.status).toBe("not_found");
    expect(out.access_note).toContain("Wel in het register bekend, maar zonder gepubliceerde algoritmes: Gemeente Hengelo (gm0164).");
    expect(out.access_note).not.toContain("Gemeente Amsterdam");
  });

  it("does not resolve a water board to another one whose name merely stems the same", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH) return orgOverview([orgRow("ws0636", "HDSR Hoogheemraadschap De Stichtse Rijnlanden", 2)]);
      if (c.url === `${ORG_SEARCH}/Rijnland`) {
        return jsonResponse({
          organisations: [
            orgRow("ws0636", "HDSR Hoogheemraadschap De Stichtse Rijnlanden", 2),
            orgRow("ws0616", "Hoogheemraadschap van Rijnland", 0),
            orgRow("so0507", "Samenwerkingsorgaan Holland Rijnland", 0),
          ],
        });
      }
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Rijnland" });

    expect(calls.some((c) => c.url === SEARCH)).toBe(false);
    expect(out.organisation).toMatchObject({ status: "not_found", without_algorithms: ["Hoogheemraadschap van Rijnland (ws0616)"] });
    expect(out.organisation?.alternatives.map((a) => a.org_id)).toEqual(["ws0636"]);
  });

  it("looks a type-prefixed name up without the type word when the register uses another one", async () => {
    routedFetch((c) => {
      if (c.url === ORG_SEARCH) return orgOverview([]);
      if (c.url === `${ORG_SEARCH}/Waterschap%20Rijnland`) return jsonResponse(null);
      if (c.url === `${ORG_SEARCH}/Rijnland`) return jsonResponse({ organisations: [orgRow("ws0616", "Hoogheemraadschap van Rijnland", 0)] });
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Waterschap Rijnland" });

    expect(out.organisation).toMatchObject({ status: "not_found", without_algorithms: ["Hoogheemraadschap van Rijnland (ws0616)"] });
  });

  it("resolves a name from the full list when it has algorithms the name search did not return", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH) return orgOverview([orgRow("gm1740", "Gemeente Neder-Betuwe", 3)]);
      if (c.url === `${ORG_SEARCH}/West%20Betuwe`) return jsonResponse({ organisations: [orgRow("gm1960", "Gemeente West Betuwe", 4)] });
      if (c.url === SEARCH) return page([algo({ organization: "Gemeente West Betuwe", org_id: "gm1960" })], 4);
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "West Betuwe" });

    expect(calls.at(-1)?.body).toMatchObject({ organisation: "gm1960" });
    expect(out.organisation).toMatchObject({ status: "resolved", match: "naam" });
  });

  it("calls a name ambiguous when it is an organisation without algorithms and also part of another's name", async () => {
    routedFetch((c) => {
      if (c.url === ORG_SEARCH) return orgOverview([orgRow("so0700", "Omgevingsdienst Haaglanden", 3)]);
      if (c.url === `${ORG_SEARCH}/Haaglanden`) {
        return jsonResponse({ organisations: [orgRow("so0700", "Omgevingsdienst Haaglanden", 3), orgRow("so0044", "Veiligheidsregio Haaglanden", 0)] });
      }
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Haaglanden" });

    expect(out.total).toBeNull();
    expect(out.organisation?.status).toBe("ambiguous");
    expect(out.organisation?.alternatives.map((a) => a.org_id)).toEqual(["so0044", "so0700"]);
    expect(out.access_note).toContain("Veiligheidsregio Haaglanden (so0044, 0 algoritmes); Omgevingsdienst Haaglanden (so0700, 3 algoritmes)");
  });

  it("resolves a lower-case or type-prefixed abbreviation the organisation search answers with one organisation", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH && c.body?.searchtext === "uwv") return orgOverview([orgRow("zb000117", "Uitvoeringsinstituut Werknemersverzekeringen", 12)]);
      if (c.url === ORG_SEARCH && c.body?.organisationtype === "ministerie") {
        return orgOverview(MINISTRY_TYPE_LIST.map(([id, name, count]) => orgRow(id, name, count)));
      }
      if (c.url === `${ORG_SEARCH}/uwv`) return jsonResponse({ organisations: [orgRow("zb000117", "Uitvoeringsinstituut Werknemersverzekeringen", 12)] });
      if (c.url === SEARCH) return page([algo({ organization: "x", org_id: String(c.body?.organisation) })], 12);
      throw new Error(`unexpected ${c.url}`);
    });
    const src = new AlgoritmeregisterSource(testConfig);

    const uwv = await src.search({ organisatie: "uwv" });
    expect(calls.at(-1)?.body).toMatchObject({ organisation: "zb000117" });
    expect(uwv.access_note).toContain("Organisatie 'uwv' opgevat als Uitvoeringsinstituut Werknemersverzekeringen (zb000117)");
    expect(summarizeAlgoritmeSearch(uwv)).toContain("12 algoritmes in het Algoritmeregister van Uitvoeringsinstituut Werknemersverzekeringen");

    const vws = await src.search({ organisatie: "Ministerie van VWS" });
    expect(calls.at(-1)?.body).toMatchObject({ organisation: "mnre1025" });
    expect(vws.organisation).toMatchObject({ status: "resolved", match: "deel" });
  });

  describe("'Min' and '&' abbreviations", () => {
    const ministryRows = MINISTRY_LIST.map(([id, name, count]) => orgRow(id, name, count));
    const row = (id: string) => ministryRows.find((r) => r.org_id === id)!;
    const searchPage = (c: Call) => page([algo({ name: "Afvalinzameling plannen", organization: "x", org_id: String(c.body?.organisation) })], 3);

    const typeRows = MINISTRY_TYPE_LIST.map(([id, name, count]) => orgRow(id, name, count));
    const isTypeList = (c: Call) => c.url === ORG_SEARCH && c.body?.organisationtype === "ministerie";

    it("resolves a known ministry abbreviation from the register's list of ministries, without the name search", async () => {
      const calls = routedFetch((c) => {
        if (isTypeList(c)) return orgOverview(typeRows);
        if (c.url === SEARCH) return searchPage(c);
        throw new Error(`unexpected ${c.url} ${JSON.stringify(c.body)}`);
      });
      const src = new AlgoritmeregisterSource(testConfig);
      // Live, the name search answers 'MinOCW' and 'Ministerie van OCW' with the inspectorate only,
      // 'MinEZK' with BZK only, and 'Ministerie van A&M' with every ministry.
      const cases: Array<[string, string, string]> = [
        ["MinOCW", "mnre1109", "Ministerie van Onderwijs, Cultuur en Wetenschap"],
        ["Ministerie van OCW", "mnre1109", "Ministerie van Onderwijs, Cultuur en Wetenschap"],
        ["MinEZK", "mnre1045", "Ministerie van Economische Zaken en Klimaat"],
        ["Min. SZW", "mnre1073", "Ministerie van Sociale Zaken en Werkgelegenheid"],
        ["Ministerie van JenV", "mnre1058", "Ministerie van Justitie en Veiligheid"],
        ["Ministerie van A&M", "mnre1162", "Asiel en Migratie"],
      ];

      for (const [input, id, name] of cases) {
        clearHttpCache();
        const before = calls.length;
        const out = await src.search({ organisatie: input });
        const made = calls.slice(before);
        expect(made).toHaveLength(2);
        expect(made[0].body).toEqual({ page: 1, limit: 100, organisationtype: "ministerie" });
        expect(made[1].body).toMatchObject({ organisation: id });
        expect(out.organisation).toMatchObject({ status: "resolved", match: "deel", organisation: { org_id: id } });
        expect(out.access_note).toContain(`Organisatie '${input}' opgevat als ${name} (${id})`);
        expect(summarizeAlgoritmeSearch(out)).toContain(`3 algoritmes in het Algoritmeregister van ${name}`);
      }
    });

    it("reports a known ministry without published algorithms instead of another organisation", async () => {
      const calls = routedFetch((c) => {
        if (isTypeList(c)) return orgOverview(typeRows.filter((r) => r.org_id !== "mnre1109"));
        if (c.url.endsWith("/api/organisation-relation/mnre1109")) {
          return jsonResponse({ org_id: "mnre1109", hierarchy: [{ org_id: "mnre1109", name: "Ministerie van Onderwijs, Cultuur en Wetenschap", count: null, has_children: null }] });
        }
        throw new Error(`unexpected ${c.url} ${JSON.stringify(c.body)}`);
      });

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "MinOCW", query: "fietspaden" });

      expect(calls.some((c) => c.url === SEARCH)).toBe(false);
      expect(out.total).toBe(0);
      expect(out.organisation).toMatchObject({ status: "not_found", alternatives: [], without_algorithms: ["Ministerie van Onderwijs, Cultuur en Wetenschap (mnre1109)"] });
      expect(out.access_note).toContain("Wel in het register bekend, maar zonder gepubliceerde algoritmes: Ministerie van Onderwijs, Cultuur en Wetenschap (mnre1109)");
    });

    it("keeps the not-found answer when the lookup of a known ministry without algorithms fails", async () => {
      routedFetch((c) => {
        if (isTypeList(c)) return orgOverview([]);
        if (c.url.includes("/api/organisation-relation/")) return jsonResponse({ detail: "Bad request" }, 400);
        throw new Error(`unexpected ${c.url} ${JSON.stringify(c.body)}`);
      });

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Ministerie van SZW" });

      expect(out.organisation).toMatchObject({ status: "not_found", alternatives: [], without_algorithms: [] });
    });

    it("reads a bare ministry abbreviation as the ministry and names an organisation that carries it", async () => {
      const calls = routedFetch((c) => {
        // Live: the name search answers 'OCW' with the inspectorate only, 'VWS' with the ministry.
        if (c.url === ORG_SEARCH && c.body?.searchtext === "OCW") return orgOverview([orgRow("oorg12355", "Inspectie van het Onderwijs (OCW)", 2)]);
        if (c.url === ORG_SEARCH && c.body?.searchtext === "VWS") return orgOverview([row("mnre1025")]);
        if (isTypeList(c)) return orgOverview(typeRows);
        if (c.url === SEARCH) return searchPage(c);
        throw new Error(`unexpected ${c.url} ${JSON.stringify(c.body)}`);
      });
      const src = new AlgoritmeregisterSource(testConfig);

      const ocw = await src.search({ organisatie: "OCW" });
      expect(calls.map((c) => c.body?.searchtext ?? c.body?.organisationtype)).toEqual(["OCW", "ministerie", ""]);
      expect(calls.at(-1)?.body).toMatchObject({ organisation: "mnre1109" });
      expect(ocw.organisation).toMatchObject({ status: "resolved", organisation: { org_id: "mnre1109" }, alternatives: [{ org_id: "oorg12355" }] });
      expect(ocw.access_note).toContain(
        "Organisatie 'OCW' opgevat als Ministerie van Onderwijs, Cultuur en Wetenschap (mnre1109). Ook passend: Inspectie van het Onderwijs (OCW) (oorg12355, 2 algoritmes)",
      );

      const before = calls.length;
      const vws = await src.search({ organisatie: "VWS" });
      expect(calls.slice(before).map((c) => c.body?.searchtext)).toEqual(["VWS", ""]);
      expect(vws.organisation?.organisation?.org_id).toBe("mnre1025");
    });

    it("resolves a ministry form the table does not know when it names one ministry in the list of all ministries", async () => {
      const calls = routedFetch((c) => {
        // Live: the name search finds nothing for 'MinJus', only the inspectorate for 'MinOnd',
        // and every ministry but Asiel en Migratie for 'Ministerie van Financ'.
        if (c.url === ORG_SEARCH && c.body?.searchtext === "MinJus") return orgOverview([]);
        if (c.url === ORG_SEARCH && c.body?.searchtext === "MinOnd") return orgOverview([orgRow("oorg12355", "Inspectie van het Onderwijs (OCW)", 2)]);
        if (c.url === ORG_SEARCH && c.body?.searchtext === "Ministerie van Financ") return orgOverview(ministryRows);
        if (isTypeList(c)) return orgOverview(typeRows);
        if (c.url === SEARCH) return searchPage(c);
        throw new Error(`unexpected ${c.url} ${JSON.stringify(c.body)}`);
      });
      const src = new AlgoritmeregisterSource(testConfig);
      const cases: Array<[string, string, string]> = [
        ["MinJus", "mnre1058", "Ministerie van Justitie en Veiligheid"],
        ["MinOnd", "mnre1109", "Ministerie van Onderwijs, Cultuur en Wetenschap"],
        ["Ministerie van Financ", "mnre1090", "Ministerie van Financiën"],
      ];

      for (const [input, id, name] of cases) {
        clearHttpCache();
        const before = calls.length;
        const out = await src.search({ organisatie: input });
        const made = calls.slice(before);
        expect(made.map((c) => c.body?.searchtext ?? c.body?.organisationtype)).toEqual([input, "ministerie", ""]);
        expect(made.at(-1)?.body).toMatchObject({ organisation: id });
        expect(out.organisation).toMatchObject({ status: "resolved", match: "deel", organisation: { org_id: id } });
        expect(out.access_note).toContain(`Organisatie '${input}' opgevat als ${name} (${id})`);
      }
    });

    it("resolves the common short names SoZaWe and BiZa through the table, in any case and also alone", async () => {
      routedFetch((c) => {
        // Live, the name search finds nothing for 'SoZaWe' or 'BiZa' alone.
        if (c.url === ORG_SEARCH && typeof c.body?.searchtext === "string" && c.body.searchtext !== "") return orgOverview([]);
        if (isTypeList(c)) return orgOverview(typeRows);
        if (c.url === SEARCH) return searchPage(c);
        throw new Error(`unexpected ${c.url} ${JSON.stringify(c.body)}`);
      });
      const src = new AlgoritmeregisterSource(testConfig);
      const cases: Array<[string, string]> = [
        ["MinSoZaWe", "mnre1073"],
        ["minsozawe", "mnre1073"],
        ["SoZaWe", "mnre1073"],
        ["sozawe", "mnre1073"],
        // Live, the name search answers 'MinBiZa' with Buitenlandse Zaken only; BiZa is Binnenlandse Zaken.
        ["MinBiZa", "mnre1034"],
        ["BiZa", "mnre1034"],
        ["BIZA", "mnre1034"],
        // EZK is Economische Zaken en Klimaat, never BZK, whose type word holds m-i-n-e.
        ["MinEZK", "mnre1045"],
        ["EZK", "mnre1045"],
      ];
      for (const [input, id] of cases) {
        const out = await src.search({ organisatie: input });
        expect(out.organisation, input).toMatchObject({ status: "resolved", organisation: { org_id: id } });
      }
    });

    it("resolves the official name of the ministry the register lists without its type word", async () => {
      const calls = routedFetch((c) => {
        // Live: the name search lists Asiel en Migratie, which as a name without a type word did not match.
        if (c.url === ORG_SEARCH && typeof c.body?.searchtext === "string" && c.body.searchtext !== "") return orgOverview([orgRow("mnre1162", "Asiel en Migratie", 2)]);
        if (isTypeList(c)) return orgOverview(typeRows);
        if (c.url === SEARCH) return searchPage(c);
        throw new Error(`unexpected ${c.url} ${JSON.stringify(c.body)}`);
      });
      const src = new AlgoritmeregisterSource(testConfig);

      for (const input of ["Ministerie van Asiel en Migratie", "Ministerie Asiel en Migratie"]) {
        clearHttpCache();
        const before = calls.length;
        const out = await src.search({ organisatie: input });
        expect(calls.slice(before).map((c) => c.body?.searchtext ?? c.body?.organisationtype)).toEqual([input, "ministerie", ""]);
        expect(out.organisation).toMatchObject({ status: "resolved", match: "naam", organisation: { org_id: "mnre1162" } });
        expect(out.access_note).toContain(`Organisatie '${input}' opgevat als Asiel en Migratie (mnre1162)`);
      }
      // Another name after the ministry's type word is no ministry of the list.
      clearHttpCache();
      const other = await src.search({ organisatie: "Ministerie van Wegen en Vaarwegen" });
      expect(other.organisation?.status).toBe("not_found");
    });

    it("names the ministries an unknown 'Min' form fits instead of choosing one", async () => {
      const calls = routedFetch((c) => {
        // VenW (Verkeer en Waterstaat) is no current ministry; its letters fit VWS.
        if (c.url === ORG_SEARCH && c.body?.searchtext === "MinVenW") return orgOverview([row("mnre1025"), row("mnre1130")]);
        if (isTypeList(c)) return orgOverview(typeRows);
        throw new Error(`unexpected ${c.url} ${JSON.stringify(c.body)}`);
      });

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "MinVenW" });

      expect(calls.map((c) => c.body?.searchtext ?? c.body?.organisationtype)).toEqual(["MinVenW", "ministerie"]);
      expect(out.organisation).toMatchObject({ status: "not_found", alternatives: [{ org_id: "mnre1025" }] });
      expect(summarizeAlgoritmeSearch(out)).toContain("Gelijkende naam met gepubliceerde algoritmes: Ministerie van Volksgezondheid, Welzijn en Sport (mnre1025, 5 algoritmes)");
    });

    it("keeps a 'Min' form unresolved when no ministry fits, naming what the search found", async () => {
      const calls = routedFetch((c) => {
        // Live: 'MinVenJ' finds VWS only; no ministry is abbreviated V-en-J.
        if (c.url === ORG_SEARCH && c.body?.searchtext === "MinVenJ") return orgOverview([row("mnre1025")]);
        if (isTypeList(c)) return orgOverview(typeRows);
        if (c.url === `${ORG_SEARCH}/MinVenJ`) return jsonResponse({ organisations: [] });
        if (c.url.endsWith("/api/organisation/MinVenJ") || c.url.endsWith("/api/organisation/minvenj")) {
          return jsonResponse({ detail: "Kan corresponderende org_id niet vinden." }, 404);
        }
        throw new Error(`unexpected ${c.url} ${JSON.stringify(c.body)}`);
      });

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "MinVenJ", query: "parkeerbeleid" });

      expect(calls.some((c) => c.url === SEARCH)).toBe(false);
      expect(out.organisation).toMatchObject({ status: "not_found", alternatives: [{ org_id: "mnre1025" }] });
      expect(summarizeAlgoritmeSearch(out)).toContain("Gelijkende naam met gepubliceerde algoritmes: Ministerie van Volksgezondheid, Welzijn en Sport (mnre1025, 5 algoritmes)");
    });

    it("reads '&' as 'en' when the search answers with an organisation the abbreviation does not fit", async () => {
      const calls = routedFetch((c) => {
        // Live: 'I&W' finds only DUS-I; 'IenW' finds the ministry.
        if (c.url === ORG_SEARCH && c.body?.searchtext === "I&W") return orgOverview([orgRow("988964", "Dienst Uitvoering Subsidies aan Instellingen (DUS-I)", 1)]);
        if (c.url === ORG_SEARCH && c.body?.searchtext === "IenW") return orgOverview([row("mnre1130")]);
        if (c.url === `${ORG_SEARCH}/IenW`) return jsonResponse({ organisations: [] });
        if (c.url === SEARCH) return searchPage(c);
        throw new Error(`unexpected ${c.url} ${JSON.stringify(c.body)}`);
      });

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "I&W" });

      expect(calls.map((c) => c.body?.searchtext ?? c.url)).toEqual(["I&W", "IenW", ""]);
      expect(calls.at(-1)?.body).toMatchObject({ organisation: "mnre1130" });
      expect(out.access_note).toContain("Organisatie 'I&W' opgevat als Ministerie van Infrastructuur en Waterstaat (mnre1130)");
    });
  });

  it("looks an upper-case org_id up in lower case", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH) return orgOverview([]);
      if (c.url.endsWith("/api/organisation-relation/gm0344")) {
        return jsonResponse({ org_id: "gm0344", hierarchy: [{ org_id: "gm0344", name: "Gemeente Utrecht", count: null, has_children: null }] });
      }
      if (c.url === SEARCH) {
        return page([algo({ name: "Parkeervergunningen toekennen", organization: "Gemeente Utrecht", org_id: "gm0344" })], 45, [{ key: "organisation", value: "Gemeente Utrecht" }]);
      }
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "GM0344" });

    expect(calls.map((c) => c.url)).toEqual([ORG_SEARCH, "https://algoritmes.overheid.nl/api/organisation-relation/gm0344", SEARCH]);
    expect(out.organisation).toMatchObject({ status: "resolved", match: "org_id", organisation: { org_id: "gm0344", name: "Gemeente Utrecht" } });
  });

  it("asks a register code in lower case when it is unknown as typed", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH) return orgOverview([]);
      if (c.url.endsWith("/api/organisation/Gemeente-Staphorst")) return jsonResponse({ detail: "Kan corresponderende org_id niet vinden." }, 404);
      if (c.url.endsWith("/api/organisation/gemeente-staphorst")) return jsonResponse({ code: "gemeente-staphorst", org_id: "gm0180" });
      if (c.url === SEARCH) return page([algo({ name: "Woningbouwplanning", organization: "Gemeente Staphorst", org_id: "gm0180" })], 4, [{ key: "organisation", value: "Gemeente Staphorst" }]);
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Gemeente-Staphorst" });

    // No digit: not an org_id, so no relation lookup.
    expect(calls.some((c) => c.url.includes("/api/organisation-relation/"))).toBe(false);
    expect(calls.at(-1)?.body).toMatchObject({ organisation: "gm0180" });
    expect(out.organisation?.match).toBe("code");
  });

  it("does not take a prefix match for an abbreviation and names it as a look-alike", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH) return orgOverview([orgRow("gm0175", "Gemeente Ommen", 3)]);
      // No digit, so no org_id; the code is asked as typed and in lower case.
      if (c.url.endsWith("/api/organisation/OM") || c.url.endsWith("/api/organisation/om")) {
        return jsonResponse({ detail: "Kan corresponderende org_id niet vinden." }, 404);
      }
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "OM" });

    expect(calls.some((c) => c.url === SEARCH)).toBe(false);
    expect(calls.some((c) => c.url.includes("/api/organisation-relation/"))).toBe(false);
    expect(out.items).toEqual([]);
    expect(out.organisation).toMatchObject({ status: "not_found", without_algorithms: [] });
    expect(summarizeAlgoritmeSearch(out)).toBe(
      "Geen organisatie met gepubliceerde algoritmes gevonden voor 'OM' in het Algoritmeregister. " +
        "Gelijkende naam met gepubliceerde algoritmes: Gemeente Ommen (gm0175, 3 algoritmes); geef de org_id als organisatie als die bedoeld is.",
    );
  });

  it("names an organisation from the name list as a look-alike when the input is only part of its name", async () => {
    const calls = routedFetch((c) => {
      // Live: the organisation search finds nothing for 'Rot'; the name list matches substrings.
      if (c.url === ORG_SEARCH) return orgOverview([]);
      if (c.url === `${ORG_SEARCH}/Rot`) {
        return jsonResponse({ organisations: [orgRow("gm0599", "Gemeente Rotterdam", 30), orgRow("128285", "Belastingdienst Douane Rotterdam Haven", 0)] });
      }
      if (c.url.endsWith("/api/organisation/Rot") || c.url.endsWith("/api/organisation/rot")) {
        return jsonResponse({ detail: "Kan corresponderende org_id niet vinden." }, 404);
      }
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Rot" });

    expect(calls.some((c) => c.url === SEARCH)).toBe(false);
    expect(out.organisation).toMatchObject({
      status: "not_found",
      alternatives: [{ org_id: "gm0599" }],
      without_algorithms: [],
      similar_without_algorithms: ["Belastingdienst Douane Rotterdam Haven (128285)"],
    });
    expect(summarizeAlgoritmeSearch(out)).toContain("Gelijkende naam met gepubliceerde algoritmes: Gemeente Rotterdam (gm0599, 30 algoritmes)");
  });

  it("does not present organisations that merely resemble the name as known without algorithms", async () => {
    routedFetch((c) => {
      if (c.url === ORG_SEARCH) {
        return orgOverview([
          orgRow("oorg10264", "Politie", 20),
          orgRow("860512", "Nationaal Cyber Security Centrum", 3),
          orgRow("oorg10118", "Nationaal Archief", 1),
          orgRow("243087", "Nationaal Coördinator Groningen", 1),
        ]);
      }
      // The name list matches substrings: "nationale politie" in "Internationale Politiesamenwerking".
      if (c.url === `${ORG_SEARCH}/Nationale%20Politie`) return jsonResponse({ organisations: [orgRow("058094", "Internationale Politiesamenwerking", 0)] });
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Nationale Politie" });

    expect(out.organisation).toMatchObject({
      status: "not_found",
      without_algorithms: [],
      similar_without_algorithms: ["Internationale Politiesamenwerking (058094)"],
    });
    expect(out.organisation?.alternatives.map((a) => a.org_id)).toEqual(["oorg10264"]);
    const summary = summarizeAlgoritmeSearch(out);
    expect(summary).toBe(
      "Geen organisatie met gepubliceerde algoritmes gevonden voor 'Nationale Politie' in het Algoritmeregister. " +
        "Gelijkende naam met gepubliceerde algoritmes: Politie (oorg10264, 20 algoritmes); geef de org_id als organisatie als die bedoeld is.",
    );
    expect(out.access_note).not.toContain("Wel in het register bekend");
    expect(out.access_note).toContain("Gelijkende namen in het register zonder gepubliceerde algoritmes: Internationale Politiesamenwerking (058094).");
  });

  it("looks a register code up directly when the name search lists more organisations than it returns", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH) {
        // 'gemeente-urk' matches every gemeente; Urk is not among the first page.
        return orgOverview([orgRow("gm0363", "Gemeente Amsterdam", 72), orgRow("gm0344", "Gemeente Utrecht", 45)], 211);
      }
      if (c.url.endsWith("/api/organisation-relation/gemeente-urk")) return jsonResponse({ org_id: "gemeente-urk", hierarchy: [] });
      if (c.url.endsWith("/api/organisation/gemeente-urk")) return jsonResponse({ code: "gemeente-urk", org_id: "gm0184" });
      if (c.url === SEARCH) return page([algo({ organization: "Gemeente Urk", org_id: "gm0184" })], 2, [{ key: "organisation", value: "Gemeente Urk" }]);
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "gemeente-urk" });

    expect(calls.at(-1)?.body).toMatchObject({ organisation: "gm0184" });
    expect(out.organisation).toMatchObject({ status: "resolved", match: "code" });
    expect(summarizeAlgoritmeSearch(out)).toContain("2 algoritmes in het Algoritmeregister van Gemeente Urk");
  });

  it("never requests a keyword page beyond the exact total, where upstream switches to fuzzy hits", async () => {
    const calls = routedFetch((c) => {
      if (c.url === SEARCH && c.body?.page === 1) return page([algo()], 51);
      // Upstream answers a page past the last exact hit with fuzzy hits and another total.
      if (c.url === SEARCH) return page([algo({ lars: "81000002", name: "Afvalwijzer (chatbot)" })], 76);
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ query: "chatbot", offset: 60, limit: 20 });

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ page: 1, limit: 1 });
    expect(out.items).toEqual([]);
    expect(out.total).toBe(51);
    expect(out.params).toMatchObject({ page: "1", limit: "1" });
    expect(summarizeAlgoritmeSearch(out)).toContain("geen resultaten vanaf offset 60");
  });

  it("probes the total before a deeper keyword page that does hold exact hits", async () => {
    const calls = routedFetch((c) => {
      if (c.url === SEARCH && c.body?.limit === 1) return page([algo()], 51);
      if (c.url === SEARCH) return page(Array.from({ length: 11 }, (_, i) => algo({ lars: String(1000 + i) })), 51);
      if (c.url.includes("/api/suggestion/NLD/")) return jsonResponse({ algorithms: [{ name: "x", organization: "y", lars: "1" }] });
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ query: "chatbot", offset: 40, limit: 20 });

    expect(calls[1].body).toMatchObject({ page: 3, limit: 20 });
    expect(out.items).toHaveLength(11);
    expect(out.params).toMatchObject({ page: "3", limit: "20", total_probe: "page=1&limit=1" });
  });

  it("flags results as fuzzy when the exact search finds nothing", async () => {
    const calls = routedFetch((c) => {
      if (c.url === SEARCH) return page([algo()], 76);
      if (c.url.includes("/api/suggestion/NLD/")) return jsonResponse({ algorithms: [] });
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ query: "chatbott" });

    expect(calls[1].url).toBe("https://algoritmes.overheid.nl/api/suggestion/NLD/chatbott");
    expect(out.fuzzy).toBe(true);
    expect(out.access_note).toContain("geen exacte treffers voor 'chatbott'");
    expect(summarizeAlgoritmeSearch(out)).toBe(
      "Geen exacte treffers voor 'chatbott'; 76 algoritmes met vergelijkbare woorden (fuzzy) in het Algoritmeregister; getoond 1-1",
    );
  });

  describe("fuzzy hits within an organisation or filter", () => {
    const BELASTINGDIENST = [orgRow("189378", "Belastingdienst", 69)];
    const OBN = algo({ name: "Signaalmodel kantoortoets OB (OBN)", organization: "Belastingdienst", org_id: "189378", lars: "45443116", description_short: "Selectie van aangiften omzetbelasting.", provider: null });
    const ANPR = algo({ name: "Risicoselectie van posten met kentekengegevens", organization: "Belastingdienst", org_id: "189378", lars: "25673438", description_short: "ANPR-actie.", provider: null });
    const verifyUrl = suggestUrl('parkeercontrole "Signaalmodel kantoortoets OB (OBN)"');
    const ownNameUrl = suggestUrl('"Signaalmodel kantoortoets OB (OBN)"');
    const obnHit = () => jsonResponse({ algorithms: [{ name: OBN.name, organization: "Belastingdienst", lars: "45443116" }] });

    it("flags them when the register has exact hits only elsewhere and confirms the row is none", async () => {
      const calls = routedFetch((c) => {
        if (c.url === ORG_SEARCH) return orgOverview(BELASTINGDIENST);
        if (c.url === SEARCH) return page([OBN, ANPR], 2);
        // 14 exact hits register-wide: the suggestion list is full (10) and holds neither row.
        if (c.url === suggestUrl("parkeercontrole")) return otherHits(10);
        if (c.url === verifyUrl) return jsonResponse({ algorithms: [] });
        // The row's name alone does find the row, so its absence above means no exact hit.
        if (c.url === ownNameUrl) return obnHit();
        throw new Error(`unexpected ${c.url}`);
      });

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Belastingdienst", query: "parkeercontrole" });

      expect(calls.map((c) => c.url)).toContain(verifyUrl);
      expect(out).toMatchObject({ fuzzy: true, fuzzy_certain: true });
      expect(summarizeAlgoritmeSearch(out)).toBe(
        "Geen exacte treffers voor 'parkeercontrole' bij Belastingdienst; 2 algoritmes met vergelijkbare woorden (fuzzy) in het Algoritmeregister; getoond 1-2",
      );
      expect(out.access_note).toContain("Binnen deze organisatie zijn er geen exacte treffers voor 'parkeercontrole'");
      expect(out.access_note).toContain("Elders in het register zijn er wel exacte treffers");
    });

    it("decides from a complete list of exact hits without asking about a row", async () => {
      const calls = routedFetch((c) => {
        if (c.url === ORG_SEARCH) return orgOverview(BELASTINGDIENST);
        if (c.url === SEARCH) return page([OBN], 1);
        if (c.url === suggestUrl("parkeercontrole")) return otherHits(3);
        throw new Error(`unexpected ${c.url}`);
      });

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Belastingdienst", query: "parkeercontrole" });

      expect(calls.filter((c) => c.url.startsWith(SUGGEST))).toHaveLength(1);
      expect(out).toMatchObject({ fuzzy: true, fuzzy_certain: true });
    });

    it("keeps hits that are in the complete list of exact hits", async () => {
      routedFetch((c) => {
        if (c.url === ORG_SEARCH) return orgOverview(BELASTINGDIENST);
        if (c.url === SEARCH) return page([OBN], 1);
        if (c.url === suggestUrl("parkeercontrole")) return jsonResponse({ algorithms: [{ name: OBN.name, organization: "Belastingdienst", lars: "45443116" }] });
        throw new Error(`unexpected ${c.url}`);
      });

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Belastingdienst", query: "parkeercontrole" });

      expect(out.fuzzy).toBeUndefined();
      expect(summarizeAlgoritmeSearch(out)).toBe("1 algoritme in het Algoritmeregister van Belastingdienst voor 'parkeercontrole'; getoond 1-1");
    });

    it("asks the register about a row even when it contains the keyword, and keeps it when confirmed", async () => {
      const calls = routedFetch((c) => {
        if (c.url === ORG_SEARCH) return orgOverview(BELASTINGDIENST);
        if (c.url === SEARCH) return page([algo({ ...OBN, description_short: "<p>Signalen van <b>fraude</b> bij aangiften.</p>" })], 3);
        if (c.url === suggestUrl("fraude")) return otherHits(10);
        if (c.url === suggestUrl('fraude "Signaalmodel kantoortoets OB (OBN)"')) return obnHit();
        throw new Error(`unexpected ${c.url}`);
      });

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Belastingdienst", query: "fraude" });

      expect(calls.filter((c) => c.url.startsWith(SUGGEST))).toHaveLength(2);
      expect(out.fuzzy).toBeUndefined();
    });

    it("flags rows that contain a short keyword only inside other words when the register says they are no hit", async () => {
      // Live: Belastingdienst + 'kind' returned only this row, which mentions kinderopvangtoeslag and
      // kindgebonden budget; the register's exact search with the row's name finds nothing.
      const WGS = algo({
        name: "Experiment Vroegsignalering WGS1",
        organization: "Belastingdienst",
        org_id: "189378",
        lars: "31415926",
        description_short: "<p>Signalen over schulden bij kinderopvangtoeslag en kindgebonden budget.</p>",
        provider: null,
      });
      const calls = routedFetch((c) => {
        if (c.url === ORG_SEARCH) return orgOverview(BELASTINGDIENST);
        if (c.url === SEARCH) return page([WGS], 1);
        if (c.url === suggestUrl("kind")) return otherHits(10);
        if (c.url === suggestUrl('kind "Experiment Vroegsignalering WGS1"')) return jsonResponse({ algorithms: [] });
        if (c.url === suggestUrl('"Experiment Vroegsignalering WGS1"')) {
          return jsonResponse({ algorithms: [{ name: WGS.name, organization: "Belastingdienst", lars: "31415926" }] });
        }
        throw new Error(`unexpected ${c.url}`);
      });

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Belastingdienst", query: "kind" });

      expect(calls.filter((c) => c.url.startsWith(SUGGEST))).toHaveLength(3);
      expect(out).toMatchObject({ fuzzy: true, fuzzy_certain: true });
      expect(summarizeAlgoritmeSearch(out)).toBe(
        "Geen exacte treffers voor 'kind' bij Belastingdienst; 1 algoritme met vergelijkbare woorden (fuzzy) in het Algoritmeregister; getoond 1-1",
      );
    });

    it("adds the organisation to a name many algorithms share", async () => {
      // Live: Provincie Utrecht + 'tekst' returned only 'Anonimiseren', which mentions 'tekstuele';
      // the name occurs at many organisations, so only name plus organisation singles the row out.
      const ANON = algo({ name: "Anonimiseren", organization: "Provincie Utrecht", org_id: "pv26", lars: "15443292", description_short: "<p>Modellen die op tekstuele wijze bepalen wat privacygevoelig is.</p>", provider: null });
      const calls = routedFetch((c) => {
        if (c.url === ORG_SEARCH) return orgOverview([orgRow("pv26", "Provincie Utrecht", 8)]);
        if (c.url === SEARCH) return page([ANON], 1);
        if (c.url === suggestUrl("tekst")) return otherHits(10);
        if (c.url === suggestUrl('tekst "Anonimiseren"')) return otherHits(10);
        if (c.url === suggestUrl('tekst "Anonimiseren" "Provincie Utrecht"')) return jsonResponse({ algorithms: [] });
        if (c.url === suggestUrl('"Anonimiseren" "Provincie Utrecht"')) {
          return jsonResponse({ algorithms: [{ name: "Anonimiseren", organization: "Provincie Utrecht", lars: "15443292" }] });
        }
        throw new Error(`unexpected ${c.url}`);
      });

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Provincie Utrecht", query: "tekst" });

      expect(calls.filter((c) => c.url.startsWith(SUGGEST))).toHaveLength(4);
      expect(out).toMatchObject({ fuzzy: true, fuzzy_certain: true });
    });

    it("does not conclude 'no hit' when the row's own name does not find the row", async () => {
      routedFetch((c) => {
        if (c.url === ORG_SEARCH) return orgOverview(BELASTINGDIENST);
        if (c.url === SEARCH) return page([algo({ ...OBN, description_short: "<p>Signalen van <b>fraude</b> bij aangiften.</p>" })], 3);
        if (c.url === suggestUrl("fraude")) return otherHits(10);
        if (c.url === suggestUrl('fraude "Signaalmodel kantoortoets OB (OBN)"')) return jsonResponse({ algorithms: [] });
        // The name phrase misses its own row (tokenisation): the check above says nothing.
        if (c.url === ownNameUrl) return jsonResponse({ algorithms: [] });
        throw new Error(`unexpected ${c.url}`);
      });

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Belastingdienst", query: "fraude" });

      // Undecided by the register; the row contains the keyword, so it is not called fuzzy.
      expect(out.fuzzy).toBeUndefined();
    });

    it("keeps a row the register confirms as an exact hit although it lacks the keyword's form", async () => {
      routedFetch((c) => {
        if (c.url === ORG_SEARCH) return orgOverview(BELASTINGDIENST);
        if (c.url === SEARCH) return page([OBN], 1);
        if (c.url === suggestUrl("parkeercontrole")) return otherHits(10);
        if (c.url === verifyUrl) return obnHit();
        throw new Error(`unexpected ${c.url}`);
      });

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Belastingdienst", query: "parkeercontrole" });

      expect(out.fuzzy).toBeUndefined();
    });

    it("asks about a row without the keyword when the first row cannot be settled", async () => {
      const calls = routedFetch((c) => {
        if (c.url === ORG_SEARCH) return orgOverview(BELASTINGDIENST);
        if (c.url === SEARCH) return page([algo({ ...ANPR, description_short: "Controle van kentekens." }), OBN], 2);
        if (c.url === suggestUrl("parkeercontrole")) return otherHits(10);
        // The first row cannot be settled: full lists without it, also with the organisation.
        if (c.url === suggestUrl('parkeercontrole "Risicoselectie van posten met kentekengegevens"')) return otherHits(10);
        if (c.url === suggestUrl('parkeercontrole "Risicoselectie van posten met kentekengegevens" "Belastingdienst"')) return otherHits(10);
        if (c.url === verifyUrl) return jsonResponse({ algorithms: [] });
        if (c.url === ownNameUrl) return obnHit();
        throw new Error(`unexpected ${c.url}`);
      });

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Belastingdienst", query: "parkeercontrole" });

      expect(calls.map((c) => c.url)).toContain(verifyUrl);
      expect(out).toMatchObject({ fuzzy: true, fuzzy_certain: true });
    });

    it("says 'vermoedelijk' when the register cannot confirm it", async () => {
      routedFetch((c) => {
        if (c.url === ORG_SEARCH) return orgOverview(UTRECHT_ORGS);
        if (c.url === SEARCH) {
          return page([algo({ name: "Digitale assistent Stadsloket", organization: "Gemeente Utrecht", org_id: "gm0344", lars: "81000004", description_short: "Via de chatwidget op de website.", provider: null })], 1);
        }
        if (c.url === suggestUrl("chatbot")) return otherHits(10);
        // The row's own name occurs in more than 10 algorithms, also with the organisation: the list is full without it.
        if (c.url === suggestUrl('chatbot "Digitale assistent Stadsloket"')) return otherHits(10);
        if (c.url === suggestUrl('chatbot "Digitale assistent Stadsloket" "Gemeente Utrecht"')) return otherHits(10);
        throw new Error(`unexpected ${c.url}`);
      });

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatie: "Utrecht", query: "chatbot" });

      expect(out).toMatchObject({ fuzzy: true, fuzzy_certain: false });
      expect(summarizeAlgoritmeSearch(out)).toBe(
        "Vermoedelijk geen exacte treffers voor 'chatbot' bij Gemeente Utrecht; 1 algoritme met vergelijkbare woorden (fuzzy) in het Algoritmeregister; getoond 1-1",
      );
      expect(out.access_note).toContain("Geen van deze resultaten bevat 'chatbot'; vermoedelijk zijn er binnen deze organisatie geen exacte treffers");
    });

    it("applies to the other filters too and does not combine an OR query with a phrase", async () => {
      const calls = routedFetch((c) => {
        if (c.url === SEARCH) return page([OBN], 8);
        if (c.url === suggestUrl("parkeercontrole or handhaving")) return otherHits(10);
        throw new Error(`unexpected ${c.url}`);
      });

      const out = await new AlgoritmeregisterSource(testConfig).search({
        query: "parkeercontrole of handhaving",
        publicatiecategorie: "Hoog-risico AI-systeem",
      });

      expect(calls.filter((c) => c.url.startsWith(SUGGEST))).toHaveLength(1);
      expect(out).toMatchObject({ fuzzy: true, fuzzy_certain: false });
      expect(summarizeAlgoritmeSearch(out)).toContain(
        "Vermoedelijk geen exacte treffers voor 'parkeercontrole of handhaving' (publicatiecategorie: Hoog-risico AI-systeem); 8 algoritmes",
      );
      expect(out.access_note).toContain("binnen deze filters");
    });
  });

  it("sends Dutch 'of' as the OR operator to the exact check, like the search does", async () => {
    const calls = routedFetch((c) => {
      if (c.url === SEARCH) return page([algo()], 372);
      if (c.url.includes("/api/suggestion/NLD/")) return jsonResponse({ algorithms: [{ name: "x", organization: "y", lars: "1" }] });
      throw new Error(`unexpected ${c.url}`);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ query: "chatbot of anonimiseren" });

    expect(calls[1].url).toBe("https://algoritmes.overheid.nl/api/suggestion/NLD/chatbot%20or%20anonimiseren");
    expect(out.fuzzy).toBeUndefined();
  });

  it("does not claim fuzzy results when the exact check fails", async () => {
    routedFetch((c) => {
      if (c.url === SEARCH) return page([algo()], 51);
      return jsonResponse({ detail: "Not found" }, 404);
    });

    const out = await new AlgoritmeregisterSource(testConfig).search({ query: "chatbot" });

    expect(out.items).toHaveLength(1);
    expect(out.fuzzy).toBeUndefined();
  });

  it("passes filters, normalises the theme and flags an unknown one", async () => {
    const calls = routedFetch((c) => {
      if (c.url === SEARCH) return page([], 0);
      throw new Error(`unexpected ${c.url}`);
    });
    const src = new AlgoritmeregisterSource(testConfig);

    const known = await src.search({ categorie: "sociale zekerheid", status: "In ontwikkeling", publicatiecategorie: "Hoog-risico AI-systeem", organisatietype: "gemeente" });
    expect(calls[0].body).toMatchObject({
      category: "Sociale zekerheid",
      status: "In ontwikkeling",
      publicationcategory: "Hoog-risico AI-systeem",
      organisationtype: "gemeente",
    });
    expect(known.access_note).not.toContain("geen bekende categorie");

    const unknown = await src.search({ categorie: "Defensie" });
    expect(calls.at(-1)?.body).toMatchObject({ category: "Defensie" });
    expect(unknown.access_note).toContain("Categorie 'Defensie' is geen bekende categorie");
  });

  it("says that the register does not use every organisation type when a type finds nothing", async () => {
    const calls = routedFetch((c) => {
      // Live: no organisation has type 'omgevingsdienst'; omgevingsdiensten are filed under 'veiligheidsregio'.
      if (c.url === SEARCH && c.body?.organisationtype === "omgevingsdienst") return page([], 0);
      if (c.url === SEARCH) return page([algo({ name: "Afvalinzameling plannen", organization: "Omgevingsdienst Haaglanden", org_id: "so0700" })], 66);
      throw new Error(`unexpected ${c.url}`);
    });
    const src = new AlgoritmeregisterSource(testConfig);

    const none = await src.search({ organisatietype: "omgevingsdienst" });
    expect(none.total).toBe(0);
    expect(none.access_note).toContain("Geen treffers met organisatietype 'omgevingsdienst'");
    expect(none.access_note).toContain("staan onder 'veiligheidsregio'");
    // The type is the only filter, so the zero is its own: no extra count.
    expect(calls).toHaveLength(1);
    expect(none.params.organisationtype_probe).toBeUndefined();

    const some = await src.search({ organisatietype: "veiligheidsregio" });
    expect(some.access_note).not.toContain("Geen treffers met organisatietype");
  });

  describe("a zero with an organisation type and other constraints", () => {
    /** The type alone has `typeTotal` algorithms; any other constraint gives none. */
    function typeRegister(typeTotal: number | "error") {
      return routedFetch((c) => {
        if (c.url === ORG_SEARCH) return orgOverview(UTRECHT_ORGS);
        if (c.url !== SEARCH) throw new Error(`unexpected ${c.url}`);
        const { page: _p, limit: _l, searchtext, organisationtype, ...rest } = c.body ?? {};
        if (!searchtext && organisationtype && !Object.keys(rest).length) {
          if (typeTotal === "error") return jsonResponse({ detail: "Unprocessable" }, 422);
          return page(typeTotal ? [algo({ name: "Afvalinzameling plannen" })] : [], typeTotal);
        }
        return page([], 0);
      });
    }

    it("does not blame the type when the type alone has hits, and names what the zero comes from", async () => {
      const calls = typeRegister(988);
      const src = new AlgoritmeregisterSource(testConfig);

      const filtered = await src.search({ organisatietype: "gemeente", status: "Buiten gebruik", categorie: "Verkeer" });
      expect(filtered.total).toBe(0);
      expect(calls).toHaveLength(2);
      expect(calls[1].body).toEqual({ searchtext: "", organisationtype: "gemeente", page: 1, limit: 1 });
      expect(filtered.access_note).not.toContain("Geen treffers met organisatietype");
      expect(filtered.access_note).toContain(
        "Organisatietype 'gemeente' heeft op zichzelf wel treffers (988 algoritmes); de nul komt door de combinatie met status en categorie.",
      );
      expect(filtered.params.organisationtype_probe).toBe("organisationtype=gemeente&page=1&limit=1");

      const withOrg = await src.search({ organisatietype: "gemeente", organisatie: "Provincie Utrecht", query: "parkeerbeleid" });
      expect(withOrg.access_note).not.toContain("Geen treffers met organisatietype");
      expect(withOrg.access_note).toContain("de nul komt door de combinatie met organisatie en zoekwoorden.");
    });

    it("keeps the note that the register does not use every type when the type alone finds nothing too", async () => {
      const calls = typeRegister(0);

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatietype: "omgevingsdienst", status: "In gebruik" });

      expect(calls).toHaveLength(2);
      expect(out.access_note).toContain("Geen treffers met organisatietype 'omgevingsdienst'");
      expect(out.access_note).not.toContain("op zichzelf wel treffers");
    });

    it("makes no claim about the type when the count fails, and still returns the empty result", async () => {
      typeRegister("error");

      const out = await new AlgoritmeregisterSource(testConfig).search({ organisatietype: "provincie", publicatiecategorie: "Hoog-risico AI-systeem" });

      expect(out.total).toBe(0);
      expect(out.access_note).not.toContain("Geen treffers met organisatietype");
      expect(out.access_note).not.toContain("op zichzelf wel treffers");
    });
  });

  it("sends include_children=false and explains the scope for an organisation with children", async () => {
    const calls = routedFetch((c) => {
      if (c.url === ORG_SEARCH) {
        return orgOverview([{ code: "ministerie-fin", count: 140, name: "Ministerie van Financiën", roo_type: "Ministerie", org_id: "mnre1090", show_page: false, has_children: true }]);
      }
      if (c.url === SEARCH) return page([algo({ organization: "Ministerie van Financiën", org_id: "mnre1090" })], 11);
      throw new Error(`unexpected ${c.url}`);
    });
    const src = new AlgoritmeregisterSource(testConfig);

    const own = await src.search({ organisatie: "Ministerie van Financiën", includeChildren: false });
    expect(calls[1].body).toMatchObject({ organisation: "mnre1090", include_children: false });
    expect(own.access_note).toContain("Alleen Ministerie van Financiën zelf");

    const all = await src.search({ organisatie: "Ministerie van Financiën" });
    expect(calls.at(-1)?.body).toMatchObject({ include_children: true });
    expect(all.access_note).toContain("Inclusief onderliggende organisaties");
  });

  it("rejects a response without results/total_count as malformed", async () => {
    routedFetch(() => jsonResponse({ detail: "something else" }));

    const err = (await new AlgoritmeregisterSource(testConfig).search({ query: "x" }).catch((e: unknown) => e)) as SourceRequestError;

    expect(err).toBeInstanceOf(SourceRequestError);
    expect(err.code).toBe("malformed_response");
  });
});

describe("algoritmeregister_search tool", () => {
  async function callTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "algoritmeregister-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({ name: "algoritmeregister_search", arguments: args })) as {
        content: Array<{ type: string; text: string }>;
      };
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("returns records linking to the algorithm page, with upstream paging", async () => {
    const calls = routedFetch((c) => {
      if (c.url === SEARCH) return page([algo(), algo({ lars: "81000003", organization: "Gemeente Maasdriel", org_id: "gm0263" })], 2);
      if (c.url.includes("/api/suggestion/NLD/")) return jsonResponse({ algorithms: [{ name: "x", organization: "y", lars: "1" }] });
      throw new Error(`unexpected ${c.url}`);
    });

    const payload = await callTool({ query: "chatbot", limit: 150 });

    // limit is capped at the register's maximum of 100 per call.
    expect(calls[0].body).toMatchObject({ page: 1, limit: 100 });
    const records = payload.records as Array<{ title: string; canonical_url: string; snippet: string; date: string; source_name: string }>;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      source_name: "algoritmeregister",
      title: "Chatbot Afvalwijzer",
      canonical_url: "https://algoritmes.overheid.nl/nl/algoritme/81000001",
      date: "2026-09-29",
    });
    expect(records[0].snippet).toBe("Gemeente Zaltbommel · In gebruik · Overige algoritmes — De gemeente gebruikt een chatbot op haar website.");
    expect(payload.pagination).toEqual({ offset: 0, limit: 100, total: 2, has_more: false });
    expect(payload.summary).toBe("2 algoritmes in het Algoritmeregister voor 'chatbot'; getoond 1-2");
    const provenance = payload.provenance as Record<string, unknown>;
    expect(provenance.tool).toBe("algoritmeregister_search");
    expect(provenance.endpoint).toBe(SEARCH);
    expect(provenance.total_results).toBe(2);
    expect(provenance.returned_results).toBe(2);
  });

  it("omits the total for an ambiguous organisation instead of reporting 0", async () => {
    routedFetch((c) => {
      if (c.url === ORG_SEARCH) {
        return orgOverview([
          { code: "a", count: 3, name: "Omgevingsdienst Haaglanden", org_id: "so0700", show_page: false, has_children: false },
          { code: "b", count: 2, name: "Omgevingsdienst regio Utrecht", org_id: "so0697", show_page: false, has_children: false },
        ]);
      }
      // No organisation is called just 'Omgevingsdienst'.
      if (c.url === `${ORG_SEARCH}/Omgevingsdienst`) {
        return jsonResponse({ organisations: [orgRow("so0700", "Omgevingsdienst Haaglanden", 3), orgRow("079389", "Gemeenschappelijke regeling Omgevingsdienst Haaglanden", 0)] });
      }
      throw new Error(`unexpected ${c.url}`);
    });

    const payload = await callTool({ organisatie: "Omgevingsdienst" });

    expect(payload.records).toEqual([]);
    expect(payload.pagination).toMatchObject({ total: null, has_more: false });
    expect((payload.provenance as Record<string, unknown>).total_results).toBeUndefined();
    expect(String(payload.access_note)).toContain("Omgevingsdienst Haaglanden (so0700, 3 algoritmes)");
  });

  it("plans a POST in dryRun without calling the register", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const dry = await callTool({ query: "chatbot", organisatie: "Utrecht", offset: 30, limit: 20, dryRun: true });

    expect(fetchMock).not.toHaveBeenCalled();
    const planned = (dry.planned_requests as Array<Record<string, unknown>>)[0];
    expect(planned.method).toBe("POST");
    expect(planned.url).toBe(SEARCH);
    expect(planned.params).toMatchObject({ searchtext: "chatbot", organisation: "<org_id>", include_children: true, page: "2", limit: 25, organisatie: "Utrecht" });
  });

  it("does not offer the organisation types the register answers with HTTP 500", async () => {
    // A 500 is retried and counts toward the shared circuit breaker: three such calls
    // would make the tool unavailable for everyone.
    for (const broken of ALGORITME_ORGANISATIETYPES_BROKEN) {
      expect(ALGORITME_ORGANISATIETYPES as readonly string[]).not.toContain(broken);
    }
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "algoritmeregister-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client
        .callTool({ name: "algoritmeregister_search", arguments: { organisatietype: "ggdregio" } })
        .catch((e: unknown) => ({ isError: true, content: [{ type: "text", text: String(e) }] }))) as {
        isError?: boolean;
        content: Array<{ type: string; text: string }>;
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("organisatietype");
    } finally {
      await client.close();
      await server.close();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an upstream validation error to an error payload", async () => {
    routedFetch(() => jsonResponse({ detail: [{ msg: "Input should be less than or equal to 100" }] }, 422));

    const payload = await callTool({ query: "chatbot" });

    expect(payload.error).toBe("http_error");
    expect(String(payload.message)).toContain("Algoritmeregister request failed (HTTP 422)");
  });
});
