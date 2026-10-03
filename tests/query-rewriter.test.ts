import { describe, expect, it } from "vitest";
import { extractKeywordTerms, extractKeywords, looseTimePhrases, metaNounBinding, rewriteNote, rewriteQuery } from "../src/utils/query-rewriter.js";

const moderate = (q: string) => rewriteQuery(q, "moderate").rewritten;
const strict = (q: string) => rewriteQuery(q, "strict").rewritten;

describe("rewriteQuery moderate: content words survive", () => {
  it("keeps meta-looking words that are part of the search term", () => {
    // Was "open portaal": "data" sat on a meta-word list and was deleted anywhere.
    expect(moderate("Open Data Portaal")).toBe("open data portaal");
    expect(moderate("open data portaal")).toBe("open data portaal");
    expect(moderate("open data")).toBe("open data");
    expect(moderate("open data beleid")).toBe("open data beleid");
    expect(moderate("medische gegevens")).toBe("medische gegevens");
    expect(moderate("data strategie gemeente")).toBe("data strategie gemeente");
  });

  it("drops a meta noun that stands on its own next to the topic", () => {
    // AND- and substring-matching backends found nothing for the extra word:
    // the CKAN catalogue returned 0 instead of 112 datasets, CBS no table title.
    expect(moderate("luchtkwaliteit gegevens overzicht")).toBe("luchtkwaliteit");
    expect(moderate("informatie luchtkwaliteit")).toBe("luchtkwaliteit");
    expect(moderate("werkloosheid gegevens")).toBe("werkloosheid");
    expect(moderate("bevolking informatie")).toBe("bevolking");
    expect(moderate("data bevolking")).toBe("bevolking");
    expect(moderate("Data bevolking")).toBe("bevolking");
    expect(moderate("LUCHTKWALITEIT GEGEVENS")).toBe("luchtkwaliteit");
    expect(moderate("informatiebeleid data lijst")).toBe("informatiebeleid");
    expect(rewriteNote(rewriteQuery("werkloosheid gegevens", "moderate"))).toBe(
      'Zoekterm herschreven: "werkloosheid gegevens" → "werkloosheid".',
    );
  });

  it("drops a meta noun after a qualifier that makes no term", () => {
    // Any word ending like an adjective used to bind the noun, so the CKAN
    // catalogue (which ANDs every word) went from 7 datasets to 0 for
    // "actuele gegevens luchtkwaliteit" and from 118 to 5 for "beschikbare
    // gegevens parkeren".
    expect(moderate("actuele gegevens luchtkwaliteit")).toBe("actuele luchtkwaliteit");
    expect(moderate("beschikbare gegevens parkeren")).toBe("beschikbare parkeren");
    expect(moderate("historische gegevens luchtkwaliteit")).toBe("historische luchtkwaliteit");
    expect(moderate("landelijke gegevens parkeren")).toBe("landelijke parkeren");
    expect(moderate("regionale data werkloosheid")).toBe("regionale werkloosheid");
    expect(moderate("openbare informatie verkeer")).toBe("openbare verkeer");
    expect(extractKeywords("actuele gegevens luchtkwaliteit", { exclude: ["gegevens"] })).toEqual(["actuele", "luchtkwaliteit"]);
  });

  it("keeps a meta noun after the modifiers of a fixed term", () => {
    expect(moderate("ruimtelijke informatie")).toBe("ruimtelijke informatie");
    expect(moderate("bijzondere gegevens zorg")).toBe("bijzondere gegevens zorg");
    expect(moderate("biometrische gegevens")).toBe("biometrische gegevens");
    expect(moderate("big data")).toBe("big data");
    expect(metaNounBinding("medische", "gegevens", undefined)).toBe("modifier");
    expect(metaNounBinding("actuele", "gegevens", undefined)).toBeUndefined();
    // A modifier binds the data nouns only, not "lijst" or "overzicht".
    expect(metaNounBinding("open", "lijst", undefined)).toBeUndefined();
  });

  it("keeps a meta noun that is quoted, an operand or the only word", () => {
    expect(moderate('"luchtkwaliteit gegevens"')).toBe("luchtkwaliteit gegevens");
    expect(rewriteQuery("data AND bevolking", "moderate").syntaxQuery).toBe("data AND bevolking");
    expect(moderate("data")).toBe("data");
    expect(moderate("gegevens informatie")).toBe("gegevens informatie");
  });

  it("drops a leading list word only when it is clearly a frame", () => {
    expect(moderate("Lijst moties")).toBe("moties");
    expect(moderate("overzicht subsidies")).toBe("subsidies");
    expect(moderate("Lijst van moties over ICT")).toBe("moties over ict");
    // Party names: "Lijst" followed by a capital is part of the name.
    expect(moderate("Lijst Pim Fortuyn")).toBe("lijst pim fortuyn");
    expect(moderate("Lijst Lokaal Belang")).toBe("lijst lokaal belang");
  });

  it("keeps tokens with meaningful punctuation and one-character content", () => {
    expect(moderate("B&W Utrecht")).toBe("b&w utrecht");
    expect(moderate("Info+ 2.0")).toBe("info+ 2.0");
    expect(moderate("NL-Alert")).toBe("nl-alert");
    expect(moderate("groep 8")).toBe("groep 8");
    expect(moderate("Plan B")).toBe("plan b");
    expect(moderate("C++")).toBe("c++");
  });

  it("still strips characters that break query parsers", () => {
    // '/' opens a regex in Lucene query_string, ':' names a field.
    expect(moderate("2016/679")).toBe("2016 679");
    expect(moderate("titel:stikstof (motie)")).toBe("titel stikstof motie");
    expect(moderate("beleid.")).toBe("beleid");
  });

  it("does not eat the start of a word after a frame", () => {
    // The old frames ended on optional groups without a word boundary.
    expect(moderate("Wat is erfpacht?")).toBe("erfpacht");
    expect(moderate("Zoek overheidsdata")).toBe("overheidsdata");
    expect(moderate("Toon dataverkeer")).toBe("dataverkeer");
    expect(moderate("ik zoek datacentra")).toBe("datacentra");
    expect(moderate("find media")).toBe("media");
    expect(moderate("What is another word")).toBe("another word");
    expect(moderate("het themapark")).toBe("het themapark");
  });

  it("still strips question frames", () => {
    expect(moderate("Wat zijn de moties over ICT?")).toBe("moties over ict");
    expect(moderate("Geef een overzicht van de moties over ICT")).toBe("moties over ict");
    expect(moderate("Geef me informatie over luchtkwaliteit in Den Haag")).toBe("luchtkwaliteit in den haag");
    expect(moderate("Kun je mij vertellen over woningbouw")).toBe("woningbouw");
    expect(moderate("Show me information about air quality")).toBe("air quality");
    expect(moderate("WAT ZIJN DE MOTIES")).toBe("moties");
  });

  it("keeps a meta noun after a command verb when no preposition follows", () => {
    // "zoek data beheer": the noun is the object, not a frame.
    expect(moderate("zoek data beheer")).toBe("data beheer");
  });

  it("leaves ordinary keyword queries exactly as before", () => {
    for (const q of ["parkeerbeleid", "luchtkwaliteit", "woningbouw", "stikstof", "voortgezet onderwijs", "waterstand Lobith", "PFAS"]) {
      expect(moderate(q)).toBe(q.toLowerCase());
      expect(rewriteQuery(q, "moderate").changed).toBe(false);
    }
  });

  it("never returns an empty query", () => {
    expect(moderate("Wat is er?")).toBe("wat is er");
    expect(moderate("?")).toBe("?");
    expect(moderate("data")).toBe("data");
    expect(strict("data")).toBe("data");
    expect(strict("de het een")).not.toBe("");
  });

  it("returns empty input unchanged", () => {
    expect(rewriteQuery("   ", "moderate")).toMatchObject({ rewritten: "", changed: false });
    expect(rewriteQuery("Wat is erfpacht?", "passthrough").rewritten).toBe("Wat is erfpacht?");
  });
});

describe("rewriteQuery syntaxQuery", () => {
  it("keeps quoted phrases for Lucene/Solr backends, plain words in rewritten", () => {
    const rw = rewriteQuery('"Open Data Portaal" Zaltbommel', "moderate");
    expect(rw.rewritten).toBe("open data portaal zaltbommel");
    expect(rw.syntaxQuery).toBe('"open data portaal" zaltbommel');
  });

  it("protects a quoted phrase from frames and word lists", () => {
    const rw = rewriteQuery('Geef informatie over "lijst van moties"', "moderate");
    expect(rw.syntaxQuery).toBe('"lijst van moties"');
    expect(rewriteQuery('"data" uitspraken', "strict").rewritten).toBe("data");
  });

  it("accepts typographic quotes and ignores an unbalanced quote", () => {
    expect(rewriteQuery("“open data” beleid", "moderate").syntaxQuery).toBe('"open data" beleid');
    const stray = rewriteQuery('open "data beleid', "moderate");
    expect(stray.rewritten).toBe("open data beleid");
    expect(stray.syntaxQuery).toBeUndefined();
  });

  it("keeps capitalised boolean operators between terms only", () => {
    expect(rewriteQuery("OV AND beleid", "moderate").syntaxQuery).toBe("ov AND beleid");
    // A leading "OR" is not an operator (and would be a Lucene parse error).
    expect(rewriteQuery("OR advies reorganisatie", "moderate").syntaxQuery).toBeUndefined();
    expect(rewriteQuery("ov and beleid", "moderate").syntaxQuery).toBeUndefined();
  });

  it("is absent when the input has no search syntax", () => {
    expect(rewriteQuery("Open Data Portaal", "moderate").syntaxQuery).toBeUndefined();
  });
});

describe("rewriteQuery strict", () => {
  it("strips function words and legal meta words as before", () => {
    expect(strict("jurisprudentie over huurrecht")).toBe("huurrecht");
    expect(strict("Zijn er tuchtklachten over een huisarts?")).toBe("tuchtklachten huisarts");
    expect(strict("Welke uitspraken zijn er over huurrecht?")).toBe("huurrecht");
  });

  it("keeps capitalised words mid-sentence as names", () => {
    expect(strict("uitspraken over een Open Data Portaal")).toBe("open data portaal");
    expect(strict("uitspraken van de Raad van State over stikstof")).toBe("raad van state stikstof");
    // A capitalised first word is grammar, not the start of a name...
    expect(strict("Uitspraken van de Raad van State over stikstof")).toBe("raad van state stikstof");
    // ...unless it is a name itself.
    expect(strict("Bergen op Zoom parkeren")).toBe("bergen op zoom parkeren");
    expect(strict("luchtkwaliteit in Den Haag")).toBe("luchtkwaliteit den haag");
  });

  it("keeps acronyms that spell a function word", () => {
    expect(strict("uitspraken over het OM en ALS")).toBe("om als");
    expect(strict("uitspraken over de WHO")).toBe("who");
    // ECLI stays a legal meta word; an all-caps input carries no acronyms.
    expect(strict("ECLI uitspraken huurrecht")).toBe("huurrecht");
    expect(strict("UITSPRAKEN OVER HET OM")).toBe("uitspraken over het om");
  });

  it("re-adds the recency marker for Rechtspraak", () => {
    const rw = rewriteQuery("laatste uitspraken huurrecht", "strict");
    expect(rw.rewritten).toBe("laatste huurrecht");
    expect(rw.recency).toBe(true);
  });
});

describe("rewriteQuery end punctuation", () => {
  it("keeps the dot of an abbreviation at the end of the query", () => {
    expect(moderate("regels voor B.V.")).toBe("regels voor b.v.");
    expect(moderate("Wat zijn de regels voor een B.V.?")).toBe("regels voor een b.v.");
    expect(moderate("parkeerbeleid.")).toBe("parkeerbeleid");
    expect(moderate("woningbouw 2.0.")).toBe("woningbouw 2.0");
  });
});

describe("rewriteNote", () => {
  it("describes a rewrite in Dutch", () => {
    expect(rewriteNote(rewriteQuery("Wat zijn de moties over ICT?", "moderate"))).toBe(
      'Zoekterm herschreven: "Wat zijn de moties over ICT?" → "moties over ict".',
    );
  });

  it("stays silent when only case or spacing differ", () => {
    expect(rewriteNote(rewriteQuery("Open  Data Portaal", "moderate"))).toBeUndefined();
    expect(rewriteNote({ original: "B&W", rewritten: "b&w" })).toBeUndefined();
  });

  it("mentions a removed recency word", () => {
    expect(rewriteNote(rewriteQuery("laatste nieuws stikstof", "moderate"))).toMatch(/"nieuws stikstof".*laatste/);
  });

  it("does not say a recency word was left out when the query still carries it", () => {
    // Strict mode sends "laatste" along (and turns "nieuwste" into it).
    const strictNote = rewriteNote(rewriteQuery("nieuwste jurisprudentie huurrecht", "strict"));
    expect(strictNote).toBe('Zoekterm herschreven: "nieuwste jurisprudentie huurrecht" → "laatste huurrecht".');
    // A quoted phrase keeps its words.
    expect(rewriteNote(rewriteQuery('Wat staat er over "de laatste fase" van woningbouw?', "moderate"))).not.toContain("weggelaten");
  });

  it("stays silent when only end punctuation differs", () => {
    expect(rewriteNote({ original: "Hoeveel inwoners heeft Amsterdam?", rewritten: "hoeveel inwoners heeft amsterdam" })).toBeUndefined();
    expect(rewriteNote(rewriteQuery("parkeerbeleid Utrecht!", "moderate"))).toBeUndefined();
    expect(rewriteNote(rewriteQuery("Wat is het parkeerbeleid?", "moderate"))).toBe('Zoekterm herschreven: "Wat is het parkeerbeleid?" → "parkeerbeleid".');
  });

  it("matches the explanation field of a changed rewrite", () => {
    const rw = rewriteQuery("Geef informatie over parkeren", "moderate");
    expect(rw.changed).toBe(true);
    expect(rw.explanation).toBe(rewriteNote(rw));
  });

  it("shortens a very long original", () => {
    const note = rewriteNote({ original: `${"woord ".repeat(60)}?`, rewritten: "woord" });
    expect(note!.length).toBeLessThan(260);
    expect(note).toContain("...");
  });
});

describe("extractKeywords", () => {
  it("turns an organisation question into topic keywords", () => {
    expect(extractKeywords("Wat doet de Belastingdienst met de BTW?")).toEqual(["belastingdienst", "btw"]);
    expect(extractKeywords("Hoe gebruikt het UWV persoonlijke begeleiding?")).toEqual(["uwv", "persoonlijke", "begeleiding"]);
    expect(extractKeywords("Wat is het kabinetsbeleid over stikstof?")).toEqual(["kabinetsbeleid", "stikstof"]);
  });

  it("keeps a run of capitalised words together as one term", () => {
    expect(extractKeywords("Welke gemeenten hebben een Open Data Portaal?")).toEqual(["gemeenten", "open data portaal"]);
    expect(extractKeywords("Wat doet de Raad van State met de BTW?")).toEqual(["raad van state", "btw"]);
  });

  it("does not glue separate names or the first word of a sentence into a phrase", () => {
    expect(extractKeywords("Wat doen Amsterdam en Rotterdam met het OV?")).toEqual(["amsterdam", "rotterdam", "ov"]);
    expect(extractKeywords("Parkeren Delft")).toEqual(["parkeren", "delft"]);
    expect(extractKeywords("OV-beleid Rijkswaterstaat")).toEqual(["ov-beleid", "rijkswaterstaat"]);
  });

  it("keeps quoted phrases, numbers and punctuation tokens", () => {
    expect(extractKeywords('Welke gemeenten werken met "omgekeerd inzamelen"?')).toEqual(["gemeenten", "omgekeerd inzamelen"]);
    expect(extractKeywords("besluiten van B&W over groep 8")).toEqual(["besluiten", "b&w", "groep", "8"]);
  });

  it("drops the words a route already acts on", () => {
    expect(extractKeywords("Welke aanbestedingen zijn er voor jeugdzorg?", { exclude: ["aanbestedingen"] })).toEqual(["jeugdzorg"]);
    expect(extractKeywords("Welke moties zijn ingediend over stikstof", { exclude: ["moties", "tweede kamer"] })).toEqual(["stikstof"]);
    expect(extractKeywords("moties in de tweede kamer over wonen", { exclude: ["tweede kamer", "moties"] })).toEqual(["wonen"]);
  });

  it("drops a name only when all of its words are excluded", () => {
    expect(extractKeywords("Wat doet de Gemeente Utrecht met het OV?", { exclude: ["gemeente", "Utrecht"] })).toEqual(["ov"]);
    expect(extractKeywords("Welke gemeenten hebben een Open Data Portaal?", { exclude: ["gemeenten", "data"] })).toEqual(["open data portaal"]);
  });

  it("keeps a place name that opens with a function word", () => {
    // "Den" is a stopword; the name lost it and became "haag".
    expect(extractKeywords("Wat doet Den Haag aan armoede?")).toEqual(["den haag", "armoede"]);
    expect(extractKeywords("Woningbouw in Het Hogeland")).toEqual(["woningbouw", "het hogeland"]);
    expect(extractKeywords("Wat doet de gemeente De Bilt aan afvalinzameling?", { exclude: ["gemeente", "De Bilt"] })).toEqual(["afvalinzameling"]);
    // Lowercase it stays a function word.
    expect(extractKeywords("Wat doet de Raad van State met parkeerbeleid?")).toEqual(["raad van state", "parkeerbeleid"]);
  });

  it("excludes a place whose name starts with an apostrophe", () => {
    // The question's token lost its apostrophe; the exclusion kept it and never matched.
    expect(
      extractKeywords("Wat is het beleid van de gemeente 's-Hertogenbosch over parkeren?", { exclude: ["gemeente", "'s-Hertogenbosch"] }),
    ).toEqual(["beleid", "parkeren"]);
    expect(extractKeywords("Wat doet de gemeente 's-Gravenhage aan afvalinzameling?", { exclude: ["gemeente", "'s-Gravenhage"] })).toEqual([
      "afvalinzameling",
    ]);
  });

  it("handles infix place names", () => {
    expect(
      extractKeywords("Hoe gaat de gemeente Capelle aan den IJssel om met zwerfafval?", { exclude: ["gemeente", "Capelle aan den IJssel"] }),
    ).toEqual(["zwerfafval"]);
  });

  it("keeps acronyms that spell a function word", () => {
    // "om", "it", "als", "who" and "or" are stopwords in lowercase, so the
    // organisation the question was about disappeared.
    expect(extractKeywords("Wat doet het OM met ondermijning?")).toEqual(["om", "ondermijning"]);
    expect(extractKeywords("Wat doet de Belastingdienst met IT?")).toEqual(["belastingdienst", "it"]);
    expect(extractKeywords("Wat doet het kabinet tegen ALS?")).toEqual(["kabinet", "als"]);
    expect(extractKeywords("Wat zegt de WHO over vaccins?")).toEqual(["who", "vaccins"]);
    expect(extractKeywords("Advies van de OR over reorganisatie")).toEqual(["advies", "or", "reorganisatie"]);
    // Between two terms OR is an operator; an all-caps question has no acronyms.
    expect(extractKeywords("OV OR fietspaden")).toEqual(["ov", "fietspaden"]);
    expect(extractKeywords("WAT DOET HET OM MET ICT")).toEqual(["ict"]);
  });

  it("keeps a meta noun bound into a term whole, also in lowercase", () => {
    expect(extractKeywords("welke gemeenten hebben een open data portaal?")).toEqual(["gemeenten", "open data portaal"]);
    expect(extractKeywords("Open Data Portaal")).toEqual(["open data portaal"]);
    expect(extractKeywords("welke gemeenten hebben een open data portaal?", { exclude: ["data", "gegevens"] })).toEqual(["gemeenten", "open data portaal"]);
    expect(extractKeywords("Wat doet de overheid met medische gegevens?")).toEqual(["overheid", "medische gegevens"]);
    // A data word on its own can still be excluded.
    expect(extractKeywords("Welke data is er over verkeersongevallen?", { exclude: ["data"] })).toEqual(["verkeersongevallen"]);
  });

  it("leaves out time phrases that no date filter covers", () => {
    // "deze week" is no pattern of the temporal parser; "week" stayed as the
    // topic and the Tweede Kamer route searched titles for it.
    expect(extractKeywords("Welke moties zijn er deze week ingediend?")).toEqual(["moties"]);
    expect(extractKeywords("Welke moties zijn deze maand ingediend?")).toEqual(["moties"]);
    expect(extractKeywords("Welke amendementen zijn er onlangs ingediend?")).toEqual(["amendementen"]);
    expect(extractKeywords("Welke moties zijn er de laatste weken ingediend?")).toEqual(["moties"]);
    expect(extractKeywords("Wat doet het kabinet de afgelopen 3 maanden aan stikstof?")).toEqual(["kabinet", "stikstof"]);
    expect(extractKeywords("Wat doet het kabinet de laatste tijd aan jeugdzorg?")).toEqual(["kabinet", "jeugdzorg"]);
    // A quoted phrase is searched as typed; a unit without a time word stays.
    expect(extractKeywords('Zoek "deze week" programma')).toEqual(["deze week", "programma"]);
    expect(extractKeywords("Wat doet de overheid aan de vierdaagse werkweek?")).toEqual(["overheid", "vierdaagse", "werkweek"]);
  });

  it("names the time phrases it left out", () => {
    expect(looseTimePhrases("Welke moties zijn er deze week ingediend?")).toEqual(["deze week"]);
    expect(looseTimePhrases("Welke amendementen zijn er onlangs ingediend?")).toEqual(["onlangs"]);
    expect(looseTimePhrases('Zoek "deze week" programma')).toEqual([]);
    expect(looseTimePhrases("Welke moties over stikstof?")).toEqual([]);
  });

  it("returns nothing for a question without a topic", () => {
    expect(extractKeywords("Wat is er?")).toEqual([]);
    expect(extractKeywords("")).toEqual([]);
  });

  it("treats a comparison as the frame of the question, not as its topic", () => {
    // "vergelijk" was a required word: the Tweede Kamer route found nothing and
    // fell back to the single term "kabinetsbeleid".
    expect(extractKeywords("Vergelijk de moties met het kabinetsbeleid over stikstof", { exclude: ["moties"] })).toEqual(["kabinetsbeleid", "stikstof"]);
    expect(extractKeywords("Wat is het verschil tussen huurtoeslag en zorgtoeslag?")).toEqual(["huurtoeslag", "zorgtoeslag"]);
    expect(extractKeywords("Een vergelijking tussen de woningbouw in Utrecht en Amsterdam")).toEqual(["woningbouw", "utrecht", "amsterdam"]);
    expect(extractKeywords("Kun je het parkeerbeleid van Delft en Leiden vergelijken?")).toEqual(["parkeerbeleid", "delft", "leiden"]);
    expect(extractKeywords("vergelijking van fietspaden")).toEqual(["fietspaden"]);
  });

  it("keeps a comparison noun that is part of the topic", () => {
    expect(extractKeywords("Wat zijn de regionale verschillen in de jeugdzorg?")).toEqual(["regionale", "verschillen", "jeugdzorg"]);
    expect(extractKeywords('Zoek "verschil tussen" afvalinzameling')).toEqual(["verschil tussen", "afvalinzameling"]);
  });
});

describe("extractKeywordTerms", () => {
  it("tells a run of capitalised words from a phrase the question holds", () => {
    // A name need not stand in a document in that form: as a phrase,
    // "schiphol geluidsoverlast" found no motion about noise around Schiphol.
    expect(extractKeywordTerms("Welke moties gaan over Schiphol Geluidsoverlast?")).toEqual([
      { text: "moties", kind: "word" },
      { text: "schiphol geluidsoverlast", kind: "name" },
    ]);
    expect(extractKeywordTerms("Welke kamerstukken gaan over de Wet Kwaliteitsborging Bouwen?")).toContainEqual({ text: "wet kwaliteitsborging bouwen", kind: "name" });
    expect(extractKeywordTerms("Welke kamerstukken gaan over Den Haag en afvalinzameling?")).toContainEqual({ text: "den haag", kind: "name" });
    expect(extractKeywordTerms('Welke moties gaan over "omgekeerd inzamelen"?')).toContainEqual({ text: "omgekeerd inzamelen", kind: "quoted" });
  });

  it("marks a meta noun bound into a term as bound, capitalised or not", () => {
    expect(extractKeywordTerms("Welke gemeenten hebben een open data portaal?")).toContainEqual({ text: "open data portaal", kind: "bound" });
    expect(extractKeywordTerms("Welke gemeenten hebben een Open Data Portaal?")).toContainEqual({ text: "open data portaal", kind: "bound" });
    expect(extractKeywordTerms("Open Data Portaal van de gemeente")).toContainEqual({ text: "open data portaal", kind: "bound" });
    expect(extractKeywordTerms("Hoe werkt de data strategie?")).toContainEqual({ text: "data strategie", kind: "bound" });
    // A longer name that holds such a term is a name.
    expect(extractKeywordTerms("Wat is het beleid voor de Open Data Portaal Utrecht?")).toContainEqual({ text: "open data portaal utrecht", kind: "name" });
  });

  it("gives the same terms as extractKeywords", () => {
    for (const question of [
      "Welke moties gaan over Schiphol Geluidsoverlast?",
      "Welke gemeenten hebben een Open Data Portaal?",
      'Welke moties gaan over "omgekeerd inzamelen" in Den Haag?',
      "Wat doet de Belastingdienst met de BTW?",
    ]) {
      expect(extractKeywordTerms(question, { exclude: ["moties"] }).map((term) => term.text)).toEqual(extractKeywords(question, { exclude: ["moties"] }));
    }
  });
});

describe("rewriteQuery comparison frames", () => {
  it("strips a leading comparison like the other question frames", () => {
    expect(moderate("Vergelijk de moties over stikstof")).toBe("moties over stikstof");
    expect(moderate("Wat is het verschil tussen huurtoeslag en zorgtoeslag?")).toBe("huurtoeslag en zorgtoeslag");
    expect(moderate("Een vergelijking van fietspaden")).toBe("fietspaden");
    expect(strict("Vergelijk uitspraken over huurrecht")).toBe("huurrecht");
    // Not at the start, and not a frame: the words stay.
    expect(moderate("regionale verschillen in de jeugdzorg")).toBe("regionale verschillen in de jeugdzorg");
  });
});
