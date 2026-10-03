import { describe, expect, it } from "vitest";
import {
  apiMeetingCheck,
  buildOriCatalogue,
  dedupeOriItems,
  documentLink,
  fallbackIndexPatterns,
  gemeenteToIndexSlug,
  hasOriQuerySyntax,
  indexToGemeente,
  LIST_DATE_TYPE,
  meetingPage,
  parseBestuurslaag,
  quoteOperatorWords,
  recordProvenance,
  resolveOriScope,
  toOriItem,
  toQueryStringSyntax,
} from "../src/sources/ori.js";

/** A slice of the real GET /_aliases answer (2026-10), irregular slugs included. */
const ALIASES: Record<string, { aliases: Record<string, object> }> = {
  ori_delft_20250407054803: { aliases: { ori_delft: {} } },
  "ori_leidschendam-voorburg_20250424000000": { aliases: { "ori_leidschendam-voorburg": {} } },
  "ori_midden-groningen_20250427000000": { aliases: { "ori_midden-groningen": {} } },
  "ori_borger-odoorn_20250406000000": { aliases: { "ori_borger-odoorn": {} } },
  ori_capelle_ad_ijssel_20250406045703: { aliases: { ori_capelle_ad_ijssel: {} } },
  ori_hofvantwente_20250330162310: { aliases: { ori_hofvantwente: {} } },
  ori_den_bosch_20250407152804: { aliases: { ori_den_bosch: {} } },
  ori_den_haag_20250408204203: { aliases: { ori_den_haag: {} } },
  ori_ijsselstein_20250421000000: { aliases: { ori_ijsselstein: {} } },
  ori_gilze_en_rijen_20250414184203: { aliases: { ori_gilze_en_rijen: {} } },
  ori_baarle_nassau_20250402000000: { aliases: { ori_baarle_nassau: {} } },
  "ori_alphen-chaam_20250316121003": { aliases: { "ori_alphen-chaam": {} } },
  ori_amsterdam_20250317151602: { aliases: { ori_amsterdam: {} } },
  ori_amsterdam_zuidoost_20250318000000: { aliases: { ori_amsterdam_zuidoost: {} } },
  ori_groningen_20250415000000: { aliases: { ori_groningen: {} } },
  ori_bergen_20250402200044: { aliases: { ori_bergen: {} } },
  ori_bergen_nh_20250325120304: { aliases: { ori_bergen_nh: {} } },
  // Re-ingested: the old copy lost its alias; it is one entry with the alias, but still searched.
  ori_heemskerk_20250506181303: { aliases: {} },
  ori_heemskerk_20251120105722: { aliases: { ori_heemskerk: {} } },
  ori_noordwijk_20250531081504: { aliases: { ori_noordwijk: {} } },
  ori_cuijk_20250407000000: { aliases: { ori_cuijk: {} } },
  ori_berg_en_dal_20250402174603: { aliases: { ori_berg_en_dal: {} } },
  osi_groningen_20250329063305: { aliases: { osi_groningen: {} } },
  "osi_noord-holland_20250720165905": { aliases: { "osi_noord-holland": {} } },
  "osi_provincie-utrecht_20250405180703": { aliases: { "osi_provincie-utrecht": {} } },
  osi_fryslan_20250603052004: { aliases: { osi_fryslan: {} } },
  osi_limburg_20250719094106: { aliases: { osi_limburg: {} } },
  "owi_aa-en-maas_20250722063705": { aliases: { "owi_aa-en-maas": {} } },
  owi_hoogheemraadschap_van_delfland_20250726032903: { aliases: { owi_hoogheemraadschap_van_delfland: {} } },
  owi_limburg_20250726113703: { aliases: { owi_limburg: {} } },
  owi_wetterskip_fryslan_20250611042613: { aliases: { owi_wetterskip_fryslan: {} } },
  ".kibana_1": { aliases: { ".kibana": {} } },
};

function org(index: string, name: string, classification = "Municipality") {
  return { _index: index, _source: { name, classification } };
}

/** Top-level Organization records, as ORI stores them. osi_provincie-utrecht is left out on purpose. */
const ORGS = [
  org("ori_delft_20250407054803", "Gemeente Delft"),
  org("ori_leidschendam-voorburg_20250424000000", "Gemeente Leidschendam-Voorburg"),
  org("ori_midden-groningen_20250427000000", "Gemeente Midden-Groningen"),
  org("ori_borger-odoorn_20250406000000", "Gemeente Borger-Odoorn"),
  org("ori_capelle_ad_ijssel_20250406045703", "Gemeente Capelle aan den IJssel"),
  org("ori_hofvantwente_20250330162310", "Gemeente Hof van Twente"),
  org("ori_den_bosch_20250407152804", "Gemeente 's-Hertogenbosch"),
  org("ori_den_haag_20250408204203", "Gemeente Den Haag"),
  org("ori_ijsselstein_20250421000000", "Gemeente IJsselstein"),
  org("ori_gilze_en_rijen_20250414184203", "Gemeente Gilze en Rijen"),
  org("ori_baarle_nassau_20250402000000", "Gemeente Baarle-Nassau"),
  org("ori_alphen-chaam_20250316121003", "Gemeente Alphen-Chaam"),
  org("ori_amsterdam_20250317151602", "Gemeente Amsterdam"),
  org("ori_amsterdam_zuidoost_20250318000000", "Amsterdam Stadsdeel Zuidoost"),
  org("ori_groningen_20250415000000", "Gemeente Groningen"),
  org("ori_bergen_20250402200044", "Gemeente Bergen (L)"),
  org("ori_bergen_nh_20250325120304", "Gemeente Bergen NH"),
  org("ori_heemskerk_20251120105722", "Gemeente Heemskerk"),
  org("ori_noordwijk_20250531081504", "Gemeente Noordwijkerhout"),
  org("ori_cuijk_20250407000000", "Gemeente Cuijk"),
  org("ori_berg_en_dal_20250402174603", "Gemeente Berg en Dal"),
  org("osi_groningen_20250329063305", "Provincie Groningen"),
  org("osi_noord-holland_20250720165905", "Provincie Noord-Holland", "Province"),
  org("osi_fryslan_20250603052004", "Provincie Fryslân"),
  org("osi_limburg_20250719094106", "Provincie Limburg", "Province"),
  org("owi_aa-en-maas_20250722063705", "Aa en Maas", "Water board"),
  org("owi_hoogheemraadschap_van_delfland_20250726032903", "Hoogheemraadschap van Delfland", "Water board"),
  org("owi_limburg_20250726113703", "Waterschap Limburg", "Water board"),
  org("owi_wetterskip_fryslan_20250611042613", "Wetterskip Fryslân", "Water board"),
];

const catalogue = buildOriCatalogue(ALIASES, ORGS);

function entryFor(index: string) {
  return catalogue.entries.find((e) => e.index === index);
}

describe("gemeenteToIndexSlug", () => {
  it("matches how ORI names most per-municipality indices", () => {
    expect(gemeenteToIndexSlug("Delft")).toBe("delft");
    expect(gemeenteToIndexSlug("Berg en Dal")).toBe("berg_en_dal");
    expect(gemeenteToIndexSlug("Baarle-Nassau")).toBe("baarle_nassau");
  });

  it("folds case and accents", () => {
    expect(gemeenteToIndexSlug("FRYSLÂN")).toBe("fryslan");
  });
});

describe("indexToGemeente", () => {
  it("reads the municipality back out of an index name", () => {
    expect(indexToGemeente("ori_delft_20250407054803")).toBe("Delft");
    expect(indexToGemeente("ori_den_haag_20250408204203")).toBe("Den Haag");
    // Connecting words stay lowercase and "ij" is one letter: no more "Berg En Dal" / "Ijsselstein".
    expect(indexToGemeente("ori_berg_en_dal_20250402174603")).toBe("Berg en Dal");
    expect(indexToGemeente("ori_ijsselstein_20250421000000")).toBe("IJsselstein");
    expect(indexToGemeente("ori_bergen_op_zoom_20250402000000")).toBe("Bergen op Zoom");
    expect(indexToGemeente("ori_reusel-de_mierden_20250627100706")).toBe("Reusel-De Mierden");
    expect(indexToGemeente("ori_noordwijk_20250531081504")).toBe("Noordwijk");
  });

  it("returns nothing for an index it does not recognise", () => {
    expect(indexToGemeente(undefined)).toBe("");
    expect(indexToGemeente("something_else")).toBe("");
    expect(indexToGemeente("ori_")).toBe("");
  });
});

describe("buildOriCatalogue", () => {
  it("names every index after ORI's own organisation record", () => {
    expect(entryFor("ori_ijsselstein")?.name).toBe("IJsselstein");
    expect(entryFor("ori_gilze_en_rijen")?.name).toBe("Gilze en Rijen");
    expect(entryFor("ori_leidschendam-voorburg")?.name).toBe("Leidschendam-Voorburg");
    expect(entryFor("ori_baarle_nassau")?.name).toBe("Baarle-Nassau");
    expect(entryFor("ori_den_bosch")?.name).toBe("'s-Hertogenbosch");
    expect(entryFor("ori_capelle_ad_ijssel")?.name).toBe("Capelle aan den IJssel");
    expect(entryFor("ori_amsterdam_zuidoost")?.name).toBe("Amsterdam Stadsdeel Zuidoost");
  });

  it("names provinces and water boards too, with their type word", () => {
    expect(entryFor("osi_noord-holland")?.name).toBe("Provincie Noord-Holland");
    expect(entryFor("osi_fryslan")?.name).toBe("Provincie Fryslân");
    expect(entryFor("owi_aa-en-maas")?.name).toBe("Waterschap Aa en Maas");
    expect(entryFor("owi_hoogheemraadschap_van_delfland")?.name).toBe("Hoogheemraadschap van Delfland");
    expect(entryFor("owi_limburg")?.name).toBe("Waterschap Limburg");
    expect(entryFor("osi_noord-holland")?.layer).toBe("provincie");
    expect(entryFor("owi_limburg")?.layer).toBe("waterschap");
  });

  it("falls back to a readable slug name when ORI has no organisation record", () => {
    expect(entryFor("osi_provincie-utrecht")?.name).toBe("Provincie Utrecht");
    const bare = buildOriCatalogue({ "osi_noord-holland_20250720165905": { aliases: { "osi_noord-holland": {} } }, "owi_aa-en-maas_20250722063705": { aliases: { "owi_aa-en-maas": {} } } });
    expect(bare.entries.map((e) => e.name)).toEqual(["Provincie Noord-Holland", "Waterschap Aa en Maas"]);
  });

  it("corrects the one organisation record that names the wrong municipality", () => {
    expect(entryFor("ori_noordwijk")?.name).toBe("Noordwijk");
  });

  it("folds a re-ingested index into one entry and keeps its unaliased copy to search along", () => {
    const heemskerk = catalogue.entries.filter((e) => e.slug === "heemskerk");
    expect(heemskerk).toHaveLength(1);
    expect(heemskerk[0].index).toBe("ori_heemskerk");
    // The old copy is not stale: it is the only source for 2018-2023.
    expect(heemskerk[0].copies).toEqual(["ori_heemskerk_20250506181303"]);
    expect(catalogue.byIndex.get("ori_heemskerk_20250506181303")).toBe(heemskerk[0]);
    expect(catalogue.byIndex.get("ori_heemskerk_20251120105722")).toBe(heemskerk[0]);
    expect(entryFor("ori_delft")?.copies).toEqual([]);
  });

  it("uses the newest concrete index and keeps the others when a body has no alias at all", () => {
    const out = buildOriCatalogue({ ori_x_20240101000000: { aliases: {} }, ori_x_20250101000000: { aliases: {} } });
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].index).toBe("ori_x_20250101000000");
    expect(out.entries[0].copies).toEqual(["ori_x_20240101000000"]);
  });

  it("ignores indices that are not ORI bodies", () => {
    expect(catalogue.entries.some((e) => e.index.startsWith("."))).toBe(false);
  });
});

describe("resolveOriScope", () => {
  const resolve = (name: string, layer?: "gemeente" | "provincie" | "waterschap") => resolveOriScope(catalogue, name, layer);

  it("resolves names whose slug cannot be derived from the name", () => {
    expect(resolve("Leidschendam-Voorburg").entry?.index).toBe("ori_leidschendam-voorburg");
    expect(resolve("Leidschendam Voorburg").entry?.index).toBe("ori_leidschendam-voorburg");
    expect(resolve("Midden-Groningen").entry?.index).toBe("ori_midden-groningen");
    expect(resolve("Borger-Odoorn").entry?.index).toBe("ori_borger-odoorn");
    expect(resolve("Capelle aan den IJssel").entry?.index).toBe("ori_capelle_ad_ijssel");
    expect(resolve("Capelle a/d IJssel").entry?.index).toBe("ori_capelle_ad_ijssel");
    expect(resolve("Hof van Twente").entry?.index).toBe("ori_hofvantwente");
    expect(resolve("gemeente IJsselstein").entry?.index).toBe("ori_ijsselstein");
  });

  it("knows the everyday and official names of Den Haag and Den Bosch", () => {
    expect(resolve("Den Haag").entry?.index).toBe("ori_den_haag");
    expect(resolve("'s-Gravenhage").entry?.index).toBe("ori_den_haag");
    expect(resolve("'s-Hertogenbosch").entry?.index).toBe("ori_den_bosch");
    expect(resolve("Den Bosch").entry?.index).toBe("ori_den_bosch");
  });

  it("matches exactly, never on a prefix", () => {
    const alphen = resolve("Alphen");
    expect(alphen.entry).toBeUndefined();
    expect(alphen.suggestions.map((e) => e.index)).toContain("ori_alphen-chaam");

    const amsterdam = resolve("Amsterdam");
    expect(amsterdam.entry?.index).toBe("ori_amsterdam");
    expect(amsterdam.related.map((e) => e.index)).toEqual(["ori_amsterdam_zuidoost"]);
  });

  it("reports a municipality without an index, with near names", () => {
    const out = resolve("Land van Cuijk");
    expect(out.entry).toBeUndefined();
    expect(out.suggestions.map((e) => e.name)).toContain("Cuijk");
  });

  it("prefers the gemeente for a bare name and lists the other layer", () => {
    const groningen = resolve("Groningen");
    expect(groningen.entry?.index).toBe("ori_groningen");
    expect(groningen.alternatives.map((e) => e.index)).toEqual(["osi_groningen"]);
  });

  it("applies bestuurslaag and type words as a real filter", () => {
    expect(resolve("Groningen", "provincie").entry?.index).toBe("osi_groningen");
    expect(resolve("Provincie Groningen").entry?.index).toBe("osi_groningen");
    expect(resolve("Provincie Noord-Holland").entry?.index).toBe("osi_noord-holland");
    expect(resolve("Noord-Holland").entry?.index).toBe("osi_noord-holland");
    expect(resolve("Utrecht", "provincie").entry?.index).toBe("osi_provincie-utrecht");
    expect(resolve("Hoogheemraadschap van Delfland").entry?.index).toBe("owi_hoogheemraadschap_van_delfland");
    expect(resolve("Delfland", "waterschap").entry?.index).toBe("owi_hoogheemraadschap_van_delfland");
    expect(resolve("Waterschap Aa en Maas").entry?.index).toBe("owi_aa-en-maas");
    expect(resolve("Limburg").entry?.index).toBe("osi_limburg");
    expect(resolve("Limburg", "waterschap").entry?.index).toBe("owi_limburg");
    expect(resolve("Friesland").entry?.index).toBe("osi_fryslan");
    expect(resolve("Wetterskip Fryslân").entry?.index).toBe("owi_wetterskip_fryslan");
  });

  it("says when a name exists only in another layer", () => {
    const out = resolve("Delft", "provincie");
    expect(out.entry).toBeUndefined();
    expect(out.alternatives.map((e) => e.index)).toEqual(["ori_delft"]);
  });

  it("flags the other Bergen", () => {
    const out = resolve("Bergen");
    expect(out.entry?.index).toBe("ori_bergen");
    expect(out.related.map((e) => e.name)).toContain("Bergen NH");
  });
});

describe("parseBestuurslaag", () => {
  it("maps the three ORI layers and their common spellings", () => {
    expect(parseBestuurslaag("gemeente")).toEqual({ layer: "gemeente" });
    expect(parseBestuurslaag("Gemeenten")).toEqual({ layer: "gemeente" });
    expect(parseBestuurslaag("provincie")).toEqual({ layer: "provincie" });
    expect(parseBestuurslaag(" Provincies ")).toEqual({ layer: "provincie" });
    expect(parseBestuurslaag("waterschap")).toEqual({ layer: "waterschap" });
    expect(parseBestuurslaag("hoogheemraadschap")).toEqual({ layer: "waterschap" });
  });

  it("reports values ORI does not have instead of searching for them", () => {
    expect(parseBestuurslaag("rijk")).toEqual({ unrecognised: "rijk" });
    expect(parseBestuurslaag(undefined)).toEqual({});
    expect(parseBestuurslaag("  ")).toEqual({});
  });
});

describe("toQueryStringSyntax", () => {
  it("leaves ordinary queries alone", () => {
    expect(toQueryStringSyntax("uitvoerings- en beleidskader ov en fietsen")).toBe("uitvoerings- en beleidskader ov en fietsen");
    expect(toQueryStringSyntax("OV-visie")).toBe("OV-visie");
    expect(toQueryStringSyntax("B&W")).toBe("B&W");
  });

  it("keeps phrases, prefixes, operators and balanced groups", () => {
    expect(toQueryStringSyntax('"sociale woningbouw"')).toBe('"sociale woningbouw"');
    expect(toQueryStringSyntax("parkeer*")).toBe("parkeer*");
    expect(toQueryStringSyntax("(OV OR fietsen) visie")).toBe("(OV OR fietsen) visie");
    expect(toQueryStringSyntax("-motie OV")).toBe("-motie OV");
  });

  it("neutralises syntax that made ORI answer HTTP 400 or search a field", () => {
    expect(toQueryStringSyntax("2016/679")).toBe("2016\\/679");
    expect(toQueryStringSyntax("raadsvoorstel: OV")).toBe("raadsvoorstel\\: OV");
    expect(toQueryStringSyntax("wat is OV?")).toBe("wat is OV\\?");
    expect(toQueryStringSyntax('"OV')).toBe("OV");
    expect(toQueryStringSyntax("(OV")).toBe("\\(OV");
    expect(toQueryStringSyntax("[concept]")).toBe("\\[concept\\]");
  });

  it("drops lone and dangling operators", () => {
    expect(toQueryStringSyntax("OV -")).toBe("OV");
    expect(toQueryStringSyntax("OV AND")).toBe("OV");
    expect(toQueryStringSyntax("OR OV")).toBe("OV");
    expect(toQueryStringSyntax("AND")).toBe("");
  });
});

describe("hasOriQuerySyntax", () => {
  it("recognises the syntax a caller means, so the tool does not lowercase it away", () => {
    expect(hasOriQuerySyntax("OV OR fietsen")).toBe(true);
    expect(hasOriQuerySyntax("OV NOT Stadsregio")).toBe(true);
    expect(hasOriQuerySyntax('"sociale woningbouw"')).toBe(true);
    expect(hasOriQuerySyntax("parkeer*")).toBe(true);
    expect(hasOriQuerySyntax("(OV OR fietsen) visie")).toBe(true);
    expect(hasOriQuerySyntax("OV -Stadsregio")).toBe(true);
  });

  it("leaves plain keywords and questions to the rewriter", () => {
    expect(hasOriQuerySyntax("parkeerbeleid woningbouw")).toBe(false);
    expect(hasOriQuerySyntax("Leidschendam-Voorburg OV-visie")).toBe(false);
    expect(hasOriQuerySyntax("Wat zijn de laatste besluiten over parkeerbeleid?")).toBe(false);
    expect(hasOriQuerySyntax("ORGANISATIE NOTA")).toBe(false);
  });
});

describe("quoteOperatorWords", () => {
  it("keeps a lowercase or/and/not a search word, quoted, and reports the ones between two terms", () => {
    expect(quoteOperatorWords("instemming or reorganisatie")).toEqual({ query: 'instemming "or" reorganisatie', quoted: ["or"], between: ["or"] });
    expect(quoteOperatorWords("parkeren and fietsen").query).toBe('parkeren "and" fietsen');
    expect(quoteOperatorWords("afvalinzameling not stikstof").query).toBe('afvalinzameling "not" stikstof');
    expect(quoteOperatorWords("woningbouw Or jeugdzorg")).toMatchObject({ query: 'woningbouw "Or" jeugdzorg', between: ["Or"] });
  });

  it("quotes them at the edges too, without reporting them as ambiguous", () => {
    expect(quoteOperatorWords("or personeelsbeleid")).toEqual({ query: '"or" personeelsbeleid', quoted: ["or"], between: [] });
    expect(quoteOperatorWords("fietspaden or")).toEqual({ query: 'fietspaden "or"', quoted: ["or"], between: [] });
    expect(quoteOperatorWords("not")).toEqual({ query: '"not"', quoted: ["not"], between: [] });
  });

  it("leaves uppercase operators, phrases and other words alone", () => {
    expect(quoteOperatorWords("parkeren OR fietsen")).toEqual({ query: "parkeren OR fietsen", quoted: [], between: [] });
    expect(quoteOperatorWords("(parkeren OR fietsen) NOT stikstof").query).toBe("(parkeren OR fietsen) NOT stikstof");
    expect(quoteOperatorWords('"fietsen or wandelen" beleid').query).toBe('"fietsen or wandelen" beleid');
    expect(quoteOperatorWords('"fietsen" or wandelen').query).toBe('"fietsen" "or" wandelen');
    expect(quoteOperatorWords("woningbouw organisatie notulen android").quoted).toEqual([]);
  });

  it("does not count an uppercase operator next to it as a term", () => {
    expect(quoteOperatorWords("parkeren OR or").between).toEqual([]);
  });
});

describe("fallbackIndexPatterns", () => {
  it("covers ORI's slug spellings of one layer, bounded to that exact slug", () => {
    expect(fallbackIndexPatterns("Provincie Utrecht", "provincie")).toEqual(
      expect.arrayContaining(["osi_utrecht_2*", "osi_provincie-utrecht_2*"]),
    );
    expect(fallbackIndexPatterns("Provincie Utrecht", "provincie").every((p) => p.startsWith("osi_"))).toBe(true);
    expect(fallbackIndexPatterns("Hoogheemraadschap van Delfland", "waterschap")).toContain("owi_hoogheemraadschap_van_delfland_2*");
    expect(fallbackIndexPatterns("Leidschendam-Voorburg", "gemeente")).toContain("ori_leidschendam-voorburg_2*");
    expect(fallbackIndexPatterns("Den Haag", "gemeente")).toContain("ori_den_haag_2*");
  });

  it("never becomes a prefix wildcard that reaches a longer name", () => {
    const bergen = fallbackIndexPatterns("Bergen", "gemeente");
    expect(bergen).toEqual(["ori_bergen_2*"]);
    expect(bergen.every((p) => p.endsWith("_2*"))).toBe(true);
  });
});

const NOW = Date.parse("2026-10-03T10:00:00Z");

/** ORI's provenance block of a record (was_generated_by), as the search returns it. */
function provenanceOf(system: string, kind: string, fields: Record<string, string>) {
  return { was_generated_by: { same_as: `https://openbesluitvorming.nl/voc/mapping/x/${system}/${kind}/1`, ...fields } };
}

const IBABS_MEETING_ID = "0a1b2c3d-0000-4000-8000-000000000001";
const IBABS_ITEM_ID = "0a1b2c3d-0000-4000-8000-0000000000a1";

describe("recordProvenance", () => {
  it("reads the council information system and its ids from ORI's provenance block", () => {
    expect(recordProvenance(provenanceOf("notubiz", "meeting", { original_identifier: "1400001", had_primary_source: "https://api.notubiz.nl/events/meetings/1400001" }))).toEqual({
      system: "notubiz",
      originalId: "1400001",
      referenceId: "",
      used: "",
      primarySource: "https://api.notubiz.nl/events/meetings/1400001",
    });
  });

  it("copes with a record without one", () => {
    expect(recordProvenance({ name: "x" }).system).toBe("");
    expect(recordProvenance(undefined).originalId).toBe("");
  });
});

describe("meetingPage", () => {
  const ibabs = (site: string) =>
    recordProvenance(
      provenanceOf("ibabs", "meeting", {
        original_identifier: IBABS_MEETING_ID,
        used: `https://api.openraadsinformatie.nl/v1/resolve/ibabs/GetMeetingsByDateRange/Sitename%3D${site}/StartDate%3D2026-06-09T00%3A00%3A00/EndDate%3D2026-06-11T00%3A00%3A00`,
      }),
    );

  it("builds the iBabs page from the sitename ORI read the meeting with, anchored on an agenda item", () => {
    const page = `https://noordholland.bestuurlijkeinformatie.nl/Agenda/Index/${IBABS_MEETING_ID}`;
    expect(meetingPage("osi_noord-holland_20250720165905", ibabs("Noord-holland"))).toEqual({ page, url: page, system: "iBabs" });
    const item = recordProvenance(provenanceOf("ibabs", "agenda_item", { reference_identifier: IBABS_ITEM_ID }));
    expect(meetingPage("osi_noord-holland_20250720165905", ibabs("Noord-holland"), item)?.url).toBe(`${page}#${IBABS_ITEM_ID}`);
    expect(meetingPage("ori_mook_en_middelaar_20250527041503", ibabs("Mook%20en%20Middelaar"))?.page).toBe(
      `https://mookenmiddelaar.bestuurlijkeinformatie.nl/Agenda/Index/${IBABS_MEETING_ID}`,
    );
  });

  it("builds the Notubiz page on the organisation's own site, anchored on an agenda item", () => {
    const meeting = recordProvenance(provenanceOf("notubiz", "meeting", { original_identifier: "1400001" }));
    const item = recordProvenance(provenanceOf("notubiz", "agenda_item", { reference_identifier: "9900001" }));
    expect(meetingPage("ori_eindhoven_20250413114006", meeting, item)).toEqual({
      page: "https://eindhoven.raadsinformatie.nl/vergadering/1400001",
      url: "https://eindhoven.raadsinformatie.nl/vergadering/1400001#ai_9900001",
      system: "Notubiz",
    });
    // Labels the slug does not predict, the layer's domain, and the twin of a
    // site Notubiz publishes under its bot-checked notubiz.nl.
    expect(meetingPage("ori_den_bosch_20250407152804", meeting)?.page).toBe("https://s-hertogenbosch.raadsinformatie.nl/vergadering/1400001");
    expect(meetingPage("osi_zuid_holland_20250604055220", meeting)?.page).toBe("https://pzh.stateninformatie.nl/vergadering/1400001");
    expect(meetingPage("owi_waterschap_amstel_gooi_en_vecht_20250610045825", meeting)?.page).toBe("https://agv.waterschapsinformatie.nl/vergadering/1400001");
    expect(meetingPage("ori_hoeksche_waard_20250420212403", meeting)?.page).toBe("https://hoekschewaard.raadsinformatie.nl/vergadering/1400001");
    // A page that can be checked itself needs no API.
    expect(meetingPage("ori_eindhoven_20250413114006", meeting)?.api).toBeUndefined();
  });

  it("links Haarlem to the page Notubiz publishes and has the Notubiz API confirm the meeting", () => {
    // gemeentebestuur.haarlem.nl is a retired site: every /vergadering/<id> is "Pagina niet gevonden".
    const meeting = recordProvenance(provenanceOf("notubiz", "meeting", { original_identifier: "1400001" }));
    const item = recordProvenance(provenanceOf("notubiz", "agenda_item", { reference_identifier: "9900001" }));
    expect(meetingPage("ori_haarlem_20250416182404", meeting, item)).toEqual({
      page: "https://gemeentebestuur-haarlem.notubiz.nl/vergadering/1400001",
      url: "https://gemeentebestuur-haarlem.notubiz.nl/vergadering/1400001#ai_9900001",
      system: "Notubiz",
      api: "https://api.notubiz.nl/events/meetings/1400001?format=json&version=1.17.0",
    });
  });

  it("has the GemeenteOplossingen API name the page, on the host ORI read the meeting from", () => {
    const meeting = recordProvenance(
      provenanceOf("gemeenteoplossingen", "meeting", {
        original_identifier: "5000",
        used: "https://api.openraadsinformatie.nl/v1/resolve/gemeenteoplossingen/gemeenteraad.groningen.nl/api/v1/meetings%3Fdate_from%3D1782864000%26date_to%3D1783036800",
      }),
    );
    const item = recordProvenance(provenanceOf("gemeenteoplossingen", "agenda_item", { reference_identifier: "38000" }));
    const expected = { page: "", url: "", system: "GemeenteOplossingen", api: "https://gemeenteraad.groningen.nl/api/v1/meetings/5000" };
    expect(meetingPage("ori_groningen_20250329064314", meeting)).toEqual(expected);
    // Its pages have no anchor per agenda item: an agenda item gets its meeting's page.
    expect(meetingPage("ori_groningen_20250329064314", meeting, item)).toEqual(expected);
    // An empty path segment ("api//v1") does not matter; the host does.
    const doubled = recordProvenance(provenanceOf("gemeenteoplossingen", "meeting", { original_identifier: "5000", used: "https://api.openraadsinformatie.nl/v1/resolve/gemeenteoplossingen/gemeenteraad.groningen.nl/api//v1/meetings" }));
    expect(meetingPage("ori_groningen_20250329064314", doubled)?.api).toBe("https://gemeenteraad.groningen.nl/api/v1/meetings/5000");
  });

  it("asks only the GemeenteOplossingen host it knows for the index, whatever host ORI's data names", () => {
    const via = (host: string) =>
      recordProvenance(
        provenanceOf("gemeenteoplossingen", "meeting", {
          original_identifier: "5000",
          used: `https://api.openraadsinformatie.nl/v1/resolve/gemeenteoplossingen/${host}/api/v1/meetings`,
        }),
      );
    // Addresses and names inside a network, and a public site that is not this council's.
    for (const host of ["10.0.0.5", "169.254.169.254", "127.0.0.1", "localhost.localdomain", "intranet.local", "metadata.internal", "gemeenteraad.voorbeeld.nl", "raad.dordrecht.nl"]) {
      expect(meetingPage("ori_groningen_20250329064314", via(host)), host).toBeUndefined();
    }
    // The host is right for its own index, and only there; an index not in the table gets no lookup.
    expect(meetingPage("ori_dordrecht_20250328033305", via("raad.dordrecht.nl"))?.api).toBe("https://raad.dordrecht.nl/api/v1/meetings/5000");
    expect(meetingPage("ori_voorbeeldstad_20250101000000", via("gemeenteraad.voorbeeld.nl"))).toBeUndefined();
  });

  it("builds the Parlaeus page from the meeting named in ORI's source request, also for an agenda item", () => {
    const item = recordProvenance(
      provenanceOf("parlaeus", "meeting", {
        reference_identifier: "11112222333344445555666677778888",
        had_primary_source: "https://voorbeeld.parlaeus.nl/receive/opendata?fn=agenda_detail&agid=aaaabbbbccccddddeeeeffff00001111",
      }),
    );
    expect(meetingPage("ori_maastricht_20250408232130", item)).toEqual({
      page: "https://voorbeeld.parlaeus.nl/user/agenda/action=view/ag=aaaabbbbccccddddeeeeffff00001111",
      url: "https://voorbeeld.parlaeus.nl/user/agenda/action=view/ag=aaaabbbbccccddddeeeeffff00001111",
      system: "Parlaeus",
    });
  });

  it("derives nothing it cannot build reliably", () => {
    // A GemeenteOplossingen meeting without the host ORI read it from, or with an id that is not a number.
    expect(meetingPage("ori_groningen_20250329064314", recordProvenance(provenanceOf("gemeenteoplossingen", "meeting", { original_identifier: "5000" })))).toBeUndefined();
    expect(meetingPage("ori_groningen_20250329064314", recordProvenance(provenanceOf("gemeenteoplossingen", "meeting", { original_identifier: "x", used: "https://api.openraadsinformatie.nl/v1/resolve/gemeenteoplossingen/gemeenteraad.groningen.nl/api/v1/meetings" })))).toBeUndefined();
    // A Notubiz index whose meetings Notubiz no longer has, or that is not in the table.
    expect(meetingPage("ori_leiden_20250424224414", recordProvenance(provenanceOf("notubiz", "meeting", { original_identifier: "1400001" })))).toBeUndefined();
    // Ids that do not have the system's shape.
    expect(meetingPage("ori_eindhoven_20250413114006", recordProvenance(provenanceOf("notubiz", "meeting", { original_identifier: "abc" })))).toBeUndefined();
    expect(meetingPage("osi_noord-holland_20250720165905", recordProvenance(provenanceOf("ibabs", "meeting", { original_identifier: "1400001", used: "https://x/Sitename%3DNoord-holland/" })))).toBeUndefined();
    expect(meetingPage("osi_noord-holland_20250720165905", recordProvenance(provenanceOf("ibabs", "meeting", { original_identifier: IBABS_MEETING_ID })))).toBeUndefined();
    expect(meetingPage("ori_eindhoven_20250413114006", recordProvenance({}))).toBeUndefined();
  });
});

describe("apiMeetingCheck", () => {
  const go = { page: "", url: "", system: "GemeenteOplossingen", api: "https://gemeenteraad.voorbeeld.nl/api/v1/meetings/5000" };
  const haarlem = {
    page: "https://gemeentebestuur-haarlem.notubiz.nl/vergadering/1400001",
    url: "https://gemeentebestuur-haarlem.notubiz.nl/vergadering/1400001",
    system: "Notubiz",
    api: "https://api.notubiz.nl/events/meetings/1400001?format=json&version=1.17.0",
  };

  it("takes the page GemeenteOplossingen names for the meeting", () => {
    const fullUrl = "https://gemeenteraad.voorbeeld.nl/Vergaderingen/Commissie-Woningbouw/2026/1-juli/15:00";
    expect(apiMeetingCheck(go, { id: 5000, confidential: false, fullUrl })).toEqual({ ok: true, url: fullUrl });
  });

  it("rejects a GemeenteOplossingen answer about another meeting, a closed one, or a page elsewhere", () => {
    const fullUrl = "https://gemeenteraad.voorbeeld.nl/Vergaderingen/Raad/2026/1-juli/15:00";
    expect(apiMeetingCheck(go, { id: 5001, fullUrl }).ok).toBe(false);
    expect(apiMeetingCheck(go, { id: 5000, confidential: true, fullUrl })).toEqual({ ok: false, reason: "besloten vergadering" });
    expect(apiMeetingCheck(go, { id: 5000, fullUrl: "https://elders.example/Vergaderingen/Raad" }).ok).toBe(false);
    expect(apiMeetingCheck(go, { id: 5000, fullUrl: "http://gemeenteraad.voorbeeld.nl/Vergaderingen/Raad" }).ok).toBe(false);
    expect(apiMeetingCheck(go, { id: 5000, fullUrl: "/Vergaderingen/Raad" }).ok).toBe(false);
    expect(apiMeetingCheck(go, undefined).ok).toBe(false);
    expect(apiMeetingCheck(go, [1, 2]).ok).toBe(false);
  });

  it("confirms a Notubiz meeting that the API has, public and on the linked site", () => {
    expect(apiMeetingCheck(haarlem, { meeting: { id: 1400001, confidential: 0, url: "https://gemeentebestuur-haarlem.notubiz.nl/vergadering/1400001/Raad" } })).toEqual({ ok: true });
    expect(apiMeetingCheck(haarlem, { meeting: { id: 1400001, confidential: 1 } })).toEqual({ ok: false, reason: "besloten vergadering" });
    expect(apiMeetingCheck(haarlem, { meeting: { id: 1400001, url: "https://elders.notubiz.nl/vergadering/1400001" } }).ok).toBe(false);
    expect(apiMeetingCheck(haarlem, { meeting: { id: 1400002 } }).ok).toBe(false);
    expect(apiMeetingCheck(haarlem, { id: 1400001 }).ok).toBe(false);
  });
});

describe("toOriItem", () => {
  it("links a document to its file and keeps the source system URL", () => {
    const item = toOriItem(
      {
        _index: "ori_eindhoven_20250413114006",
        _id: "7700412",
        _source: {
          "@id": "7700412",
          "@type": "MediaObject",
          name: "Commissieadvies Rekenkamerrapport",
          url: "https://api.openraadsinformatie.nl/v1/resolve/api.notubiz.nl/document/16600412",
          original_url: "https://api.notubiz.nl/document/16600412/1",
          last_discussed_at: "2026-03-10T19:00:00+01:00",
          date_modified: "2026-03-09T10:43:52+01:00",
          size_in_bytes: 103125,
        },
        highlight: { text: ["Het Rekenkamerrapport  over\nhet parkeerbeleid is behandeld"] },
      },
      undefined,
      NOW,
    );
    expect(item.url).toBe("https://api.openraadsinformatie.nl/v1/resolve/api.notubiz.nl/document/16600412");
    expect(item.link_type).toBe("document");
    expect(item.original_url).toBe("https://api.notubiz.nl/document/16600412/1");
    expect(item.snippet).toBe("Het Rekenkamerrapport over het parkeerbeleid is behandeld");
    expect(item.date_type).toBe("vergaderdatum");
    expect(item.date_field).toBe("last_discussed_at");
    expect(item.date_modified).toBe("2026-03-09T10:43:52+01:00");
    expect(item.organization).toBe("Eindhoven");
    expect(item.bestuurslaag).toBe("gemeente");
    expect(item.future_date).toBeUndefined();
  });

  it("never falls back to the ORI homepage for records without a document", () => {
    const item = toOriItem(
      {
        _index: "ori_eindhoven_20250413114006",
        _id: "7900101",
        _source: { "@id": "7900101", "@type": "AgendaItem", name: "412 Uitvoerings- en beleidskader parkeren", last_discussed_at: "2026-07-07T09:30:00+02:00" },
      },
      catalogue,
      NOW,
    );
    expect(item.url).toBe("https://api.openraadsinformatie.nl/v1/elastic/ori_eindhoven_20250413114006/_doc/7900101");
    expect(item.url).not.toBe("https://www.openraadsinformatie.nl");
    expect(item.link_type).toBe("ori_record");
    expect(item.link_note).toContain("Geen openbare webpagina");
    expect(item.snippet).toBe("Agendapunt — vergaderdatum 2026-07-07");
  });

  it("names the system of a GemeenteOplossingen meeting while it still links to its ORI record", () => {
    const item = toOriItem(
      {
        _index: "ori_groningen_20250415000000",
        _id: "7800001",
        _source: { "@id": "7800001", "@type": "Meeting", name: "Commissie Fietspaden", last_discussed_at: "2026-06-03T19:30:00+00:00", ...provenanceOf("gemeenteoplossingen", "meeting", { original_identifier: "5000" }) },
      },
      catalogue,
      NOW,
    );
    expect(item.link_type).toBe("ori_record");
    expect(item.url).toBe("https://api.openraadsinformatie.nl/v1/elastic/ori_groningen/_doc/7800001");
    expect(item.source_system).toBe("GemeenteOplossingen");
    // The page is looked up during the search (OriSource); a record on its own has none.
    expect(item.link_note).toContain("Geen openbare webpagina bekend");
    expect(item.link_note).toContain("JSON uit de ORI-API, geen webpagina");
  });

  it("uses the stable alias in record links and the catalogue name", () => {
    const item = toOriItem(
      { _index: "osi_noord-holland_20250720165905", _id: "7931672", _source: { "@type": "Meeting", name: "PS-vergadering", last_discussed_at: "2026-06-29T10:00:00+00:00" } },
      catalogue,
      NOW,
    );
    expect(item.url).toBe("https://api.openraadsinformatie.nl/v1/elastic/osi_noord-holland/_doc/7931672");
    expect(item.organization).toBe("Provincie Noord-Holland");
    expect(item.bestuurslaag).toBe("provincie");
  });

  it("labels a report's own date and flags dates after today", () => {
    const report = toOriItem(
      { _index: "ori_raalte_20250626155704", _id: "5958644", _source: { "@type": "Report", name: "Schriftelijke vragen", start_date: "2024-12-16T00:00:00+01:00", attachment: "5958645", classification: "Schriftelijke vragen" } },
      undefined,
      NOW,
    );
    expect(report.publishedAt).toBe("2024-12-16T00:00:00+01:00");
    expect(report.date_type).toBe("documentdatum");
    expect(report.date_field).toBe("start_date");
    expect(report.attachment_ids).toEqual(["5958645"]);
    expect(report.classification).toBe("Schriftelijke vragen");

    const planned = toOriItem(
      { _index: "ori_gouda_20250504060505", _id: "1", _source: { "@type": "MediaObject", name: "VNG congres", url: "https://x.example/1", last_discussed_at: "2026-11-23T00:00:00+01:00" } },
      undefined,
      NOW,
    );
    expect(planned.future_date).toBe(true);
  });

  it("labels the date of an iBabs report-list document as a list date, not a meeting", () => {
    const item = toOriItem(
      {
        _index: "ori_gouda_20250504060505",
        _id: "7911708",
        _source: {
          "@type": "MediaObject",
          name: "Uitnodiging VNG Uitvoeringscongres 26 november 2026",
          url: "https://api.openraadsinformatie.nl/v1/resolve/ibabs/report/3f1c",
          last_discussed_at: "2026-11-26T00:00:00+01:00",
        },
      },
      undefined,
      NOW,
    );
    expect(item.date_type).toBe(LIST_DATE_TYPE);
    expect(item.date_field).toBe("last_discussed_at");
    expect(item.snippet).toBe("Document — lijstdatum 2026-11-26");

    const meeting = toOriItem(
      { _index: "ori_gouda_20250504060505", _id: "2", _source: { "@type": "MediaObject", name: "Raadsvoorstel", url: "https://api.openraadsinformatie.nl/v1/resolve/ibabs/agenda_item/9a", last_discussed_at: "2026-07-08T19:00:00+00:00" } },
      undefined,
      NOW,
    );
    expect(meeting.date_type).toBe("vergaderdatum");
  });

  it("links to the source system where ORI's resolver always answers 404", () => {
    const item = toOriItem(
      {
        _index: "ori_hardinxveld-giessendam_20250330055702",
        _id: "7372060",
        _source: {
          "@type": "MediaObject",
          name: "Nieuwsbrief",
          url: "https://api.openraadsinformatie.nl/v1/resolve/raad.hardinxveld-giessendam.nl/api/v1/meetings/1126/documents/33692",
          original_url: "http://raad.hardinxveld-giessendam.nl/api/v1/meetings/1126/documents/33692",
          last_discussed_at: "2025-09-01T19:30:00+00:00",
        },
      },
      undefined,
      NOW,
    );
    expect(item.url).toBe("https://raad.hardinxveld-giessendam.nl/api/v1/meetings/1126/documents/33692");
    expect(item.link_type).toBe("document");
    expect(item.link_note).toContain("HTTP 404");
    expect(item.ori_resolve_url).toBe("https://api.openraadsinformatie.nl/v1/resolve/raad.hardinxveld-giessendam.nl/api/v1/meetings/1126/documents/33692");

    expect(documentLink("https://api.openraadsinformatie.nl/v1/resolve/ris.gemeenteraadhuizen.nl/api/v1/meetings/1/documents/2", "https://ris.gemeenteraadhuizen.nl/api/v1/meetings/1/documents/2"))
      .toEqual({ url: "https://ris.gemeenteraadhuizen.nl/api/v1/meetings/1/documents/2", viaOriginal: true });
    // Every other host keeps ORI's resolve link.
    expect(documentLink("https://api.openraadsinformatie.nl/v1/resolve/api.notubiz.nl/document/1", "https://api.notubiz.nl/document/1/1"))
      .toEqual({ url: "https://api.openraadsinformatie.nl/v1/resolve/api.notubiz.nl/document/1", viaOriginal: false });
    // Without an original_url there is nothing better to link to.
    expect(documentLink("https://api.openraadsinformatie.nl/v1/resolve/ris.gemeenteraadhuizen.nl/x", "").url).toBe("https://api.openraadsinformatie.nl/v1/resolve/ris.gemeenteraadhuizen.nl/x");
  });

  it("links a document whose resolve path holds '//' (Dronten's 'api//v1') to the source system", () => {
    const resolve = "https://api.openraadsinformatie.nl/v1/resolve/gemeenteraad.dronten.nl/api//v1/meetings/82/documents/539";
    const original = "https://gemeenteraad.dronten.nl/api//v1/meetings/82/documents/539";
    const item = toOriItem(
      {
        _index: "ori_dronten_20250328165903",
        _id: "123",
        _source: { "@type": "MediaObject", name: "Jaarrekening 2023", url: resolve, original_url: original, last_discussed_at: "2024-07-04T19:30:00+00:00" },
      },
      undefined,
      NOW,
    );
    // ORI answers 404 for the resolve link; the source system serves the PDF at its own (double-slash) URL.
    expect(item.url).toBe(original);
    expect(item.link_type).toBe("document");
    expect(item.ori_resolve_url).toBe(resolve);
    expect(item.link_note).toContain("HTTP 404");
    expect(item.original_url).toBeUndefined();

    // Dronten's newer records ('api/v1') resolve fine and keep ORI's link, with original_url as fallback.
    const fine = toOriItem(
      {
        _index: "ori_dronten_20250328165903",
        _id: "124",
        _source: {
          "@type": "MediaObject",
          name: "Raadsvoorstel",
          url: "https://api.openraadsinformatie.nl/v1/resolve/gemeenteraad.dronten.nl/api/v1/meetings/1406/documents/22158",
          original_url: "https://gemeenteraad.dronten.nl/api/v1/meetings/1406/documents/22158",
          last_discussed_at: "2026-07-02T19:30:00+00:00",
        },
      },
      undefined,
      NOW,
    );
    expect(fine.url).toBe("https://api.openraadsinformatie.nl/v1/resolve/gemeenteraad.dronten.nl/api/v1/meetings/1406/documents/22158");
    expect(fine.original_url).toBe("https://gemeenteraad.dronten.nl/api/v1/meetings/1406/documents/22158");
    expect(fine.link_note).toBeUndefined();

    // The scheme's own '//' does not count, and an http:// original stays as stored outside the two known hosts.
    expect(documentLink("https://api.openraadsinformatie.nl/v1/resolve/api.notubiz.nl/document/1", "https://api.notubiz.nl/document/1/1").viaOriginal).toBe(false);
    expect(documentLink("https://api.openraadsinformatie.nl/v1/resolve/x.example//a", "http://x.example//a")).toEqual({ url: "http://x.example//a", viaOriginal: true });
  });

  it("links a record from the unaliased copy of an index to that copy, where it exists", () => {
    const fromCopy = toOriItem({ _index: "ori_heemskerk_20250506181303", _id: "4066594", _source: { "@type": "Meeting", name: "Raadsbrede Commissie" } }, catalogue, NOW);
    expect(fromCopy.url).toBe("https://api.openraadsinformatie.nl/v1/elastic/ori_heemskerk_20250506181303/_doc/4066594");
    expect(fromCopy.organization).toBe("Heemskerk");
    const fromAlias = toOriItem({ _index: "ori_heemskerk_20251120105722", _id: "7434319", _source: { "@type": "Meeting", name: "Commissievergadering ABV" } }, catalogue, NOW);
    expect(fromAlias.url).toBe("https://api.openraadsinformatie.nl/v1/elastic/ori_heemskerk/_doc/7434319");
  });

  it("decodes HTML entities in titles without eating literal angle brackets", () => {
    const title = (name: string) => toOriItem({ _index: "ori_apeldoorn_1", _id: "1", _source: { "@type": "AgendaItem", name } }, undefined, NOW).title;
    expect(title("Advisering Auditcomit&eacute; over de Turap")).toBe("Advisering Auditcomité over de Turap");
    expect(title("20220712 B&amp;W besluit")).toBe("20220712 B&W besluit");
    expect(title("Raadsvoorstel <concept>")).toBe("Raadsvoorstel <concept>");
  });

  it("strips HTML from descriptions", () => {
    const item = toOriItem(
      { _index: "ori_x_1", _id: "1", _source: { "@type": "AgendaItem", name: "Punt", description: "<p>Voorstel&nbsp;over <b>OV</b></p>" } },
      undefined,
      NOW,
    );
    expect(item.description).toBe("Voorstel over OV");
    expect(item.snippet).toBe("Voorstel over OV");
  });
});

describe("dedupeOriItems", () => {
  const doc = (id: string, title: string, size: number, date: string, url = `https://api.notubiz.nl/document/${id}/1`) =>
    toOriItem(
      { _index: "ori_eindhoven_1", _id: id, _source: { "@type": "MediaObject", name: title, url: `https://api.openraadsinformatie.nl/v1/resolve/${id}`, original_url: url, size_in_bytes: size, last_discussed_at: date } },
      undefined,
      NOW,
    );

  it("merges the same file attached to several meetings", () => {
    const out = dedupeOriItems([
      doc("16400101", "Rapport rekenkamer Jeugdzorg 2025", 18204511, "2025-12-16T14:00:00+01:00"),
      doc("16500101", "Rapport rekenkamer Jeugdzorg 2025.pdf", 18204511, "2026-03-10T19:00:00+01:00"),
      doc("1", "Ander stuk", 10, "2026-01-01T00:00:00+01:00"),
    ]);
    expect(out.merged).toBe(1);
    expect(out.items).toHaveLength(2);
    expect(out.items[0].duplicate_ids).toEqual(["16500101"]);
    expect(out.items[0].also_discussed_at).toEqual(["2026-03-10T19:00:00+01:00"]);
  });

  it("merges versions of one notubiz document", () => {
    const out = dedupeOriItems([
      doc("5", "Motie A", 100, "2026-01-01T00:00:00+01:00", "https://api.notubiz.nl/document/555/1"),
      doc("6", "Motie A (gewijzigd)", 120, "2026-01-02T00:00:00+01:00", "https://api.notubiz.nl/document/555/2"),
    ]);
    expect(out.items).toHaveLength(1);
  });

  it("keeps different files with the same title apart", () => {
    const out = dedupeOriItems([
      doc("7", "Motie", 100, "2026-01-01T00:00:00+01:00"),
      doc("8", "Motie", 101, "2026-01-01T00:00:00+01:00"),
    ]);
    expect(out.merged).toBe(0);
    expect(out.items).toHaveLength(2);
  });

  it("merges a report with its own PDF and gives the report the PDF link", () => {
    const report = toOriItem(
      { _index: "ori_raalte_1", _id: "5958644", _source: { "@type": "Report", name: "Schriftelijke vragen", start_date: "2024-12-16T00:00:00+01:00", attachment: "5958645" } },
      undefined,
      NOW,
    );
    const pdf = toOriItem(
      { _index: "ori_raalte_1", _id: "5958645", _source: { "@type": "MediaObject", name: "Schriftelijke vragen fractie VVD", url: "https://api.openraadsinformatie.nl/v1/resolve/ibabs/report/20b2", last_discussed_at: "2024-12-16T00:00:00+01:00" } },
      undefined,
      NOW,
    );
    const out = dedupeOriItems([report, pdf]);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].type).toBe("Report");
    expect(out.items[0].url).toBe("https://api.openraadsinformatie.nl/v1/resolve/ibabs/report/20b2");
    expect(out.items[0].link_type).toBe("document");
    expect(out.items[0].link_note).toBeUndefined();
  });

  it("gives a report merged with its PDF the PDF's fallback links as well", () => {
    const report = toOriItem(
      { _index: "ori_raalte_1", _id: "5958644", _source: { "@type": "Report", name: "Schriftelijke vragen", start_date: "2024-12-16T00:00:00+01:00", attachment: "5958645" } },
      undefined,
      NOW,
    );
    const withOriginal = toOriItem(
      { _index: "ori_raalte_1", _id: "5958645", _source: { "@type": "MediaObject", name: "Vragen VVD", url: "https://api.openraadsinformatie.nl/v1/resolve/ibabs/report/20b2", original_url: "https://api1.ibabs.eu/publicdownload.aspx?site=raalte&id=20b2", last_discussed_at: "2024-12-16T00:00:00+01:00" } },
      undefined,
      NOW,
    );
    const merged = dedupeOriItems([report, withOriginal]).items[0];
    expect(merged.original_url).toBe("https://api1.ibabs.eu/publicdownload.aspx?site=raalte&id=20b2");

    const viaSource = toOriItem(
      { _index: "ori_raalte_1", _id: "5958645", _source: { "@type": "MediaObject", name: "Vragen VVD", url: "https://api.openraadsinformatie.nl/v1/resolve/x.example/api//v1/documents/1", original_url: "https://x.example/api//v1/documents/1", last_discussed_at: "2024-12-16T00:00:00+01:00" } },
      undefined,
      NOW,
    );
    const report2 = toOriItem(
      { _index: "ori_raalte_1", _id: "5958644", _source: { "@type": "Report", name: "Schriftelijke vragen", start_date: "2024-12-16T00:00:00+01:00", attachment: "5958645" } },
      undefined,
      NOW,
    );
    const merged2 = dedupeOriItems([report2, viaSource]).items[0];
    expect(merged2.url).toBe("https://x.example/api//v1/documents/1");
    expect(merged2.ori_resolve_url).toBe("https://api.openraadsinformatie.nl/v1/resolve/x.example/api//v1/documents/1");
    expect(merged2.link_note).toContain("HTTP 404");
  });

  it("merges the same record served from two copies of an index", () => {
    const a = toOriItem({ _index: "ori_heemskerk_20250506181303", _id: "9", _source: { "@type": "AgendaItem", name: "Punt" } }, undefined, NOW);
    const b = toOriItem({ _index: "ori_heemskerk_20251120105722", _id: "9", _source: { "@type": "AgendaItem", name: "Punt" } }, undefined, NOW);
    expect(dedupeOriItems([a, b]).items).toHaveLength(1);
  });

  it("never merges the same file across organisations", () => {
    // Live: one VRHM letter in Krimpenerwaard, Gouda and Waddinxveen became one Krimpenerwaard record.
    const file = (index: string, id: string, date: string) =>
      toOriItem(
        { _index: index, _id: id, _source: { "@type": "MediaObject", name: "2023.0510 Aanbieding ontwerp-Programmabegroting 2024 VRHM - raden", url: `https://api.openraadsinformatie.nl/v1/resolve/ibabs/agenda_item/${id}`, size_in_bytes: 219765, last_discussed_at: date } },
        catalogue,
        NOW,
      );
    const out = dedupeOriItems([
      file("ori_delft_20250407054803", "1", "2023-07-04T19:00:00+00:00"),
      file("ori_den_haag_20250408204203", "2", "2023-06-07T20:00:00+00:00"),
      file("ori_delft_20250407054803", "3", "2023-06-21T19:00:00+00:00"),
    ]);
    expect(out.items.map((x) => [x.organization, x.id])).toEqual([["Delft", "1"], ["Den Haag", "2"]]);
    expect(out.items[0].duplicate_ids).toEqual(["3"]);
    expect(out.items[0].also_discussed_at).toEqual(["2023-06-21T19:00:00+00:00"]);
    expect(out.items[1].duplicate_ids).toBeUndefined();
  });

  it("merges an agenda item held by both copies of a re-ingested index, and nothing else", () => {
    // The copies use other ids and stored the meeting an hour apart.
    const item = (index: string, id: string, name: string, date: string) =>
      toOriItem({ _index: index, _id: id, _source: { "@type": "AgendaItem", name, last_discussed_at: date } }, catalogue, NOW);
    const out = dedupeOriItems([
      item("ori_heemskerk_20251120105722", "7434337", "Stand van zaken Jeugdzorg (doorgeleid door de fractie CDA)", "2016-03-16T20:00:00+01:00"),
      item("ori_heemskerk_20250506181303", "4057418", "Stand van zaken Jeugdzorg (doorgeleid door de fractie CDA)", "2016-03-16T20:00:00+00:00"),
      // Same title, same day, same copy: two meetings that day, kept apart.
      item("ori_heemskerk_20251120105722", "7434350", "Opening en mededelingen", "2016-03-16T19:00:00+01:00"),
      item("ori_heemskerk_20251120105722", "7434322", "Opening en mededelingen", "2016-03-16T20:00:00+01:00"),
    ]);
    expect(out.items.map((x) => x.id)).toEqual(["7434337", "7434350", "7434322"]);
    expect(out.items[0].duplicate_ids).toEqual(["4057418"]);
    // Same day: not reported as another meeting.
    expect(out.items[0].also_discussed_at).toBeUndefined();
  });
});
