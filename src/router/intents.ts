/**
 * What nl_gov_ask reads from a question: places, EU acts, policy and council
 * questions, rulings versus statements, debates, the Algoritmeregister and
 * Omgevingswet documents in the DSO, and the phrase queries built from its terms.
 */
import { parseTkQuery } from "../sources/tweede-kamer.js";
import { normalizeCelex } from "../sources/eu-cellar.js";
import type { DocumentType as DsoDocumentType, DsoSearchArgs } from "../sources/dso-omgevingsdocumenten.js";
import { extractKeywords, metaNounBinding } from "../utils/query-rewriter.js";

/**
 * Lowercase words that bind the parts of a Dutch place name together:
 * "Alphen aan den Rijn", "Bergen op Zoom", "Berkel en Rodenrijs". They only ever
 * appear *between* capitalised words, so a match still has to end on one.
 */
const PLACE_INFIXES = "aan|bij|de|den|der|en|het|op|ten|ter|van|['’]t";

/**
 * One place name: a capitalised word followed by any number of further
 * capitalised words, optionally bound by the infixes above.
 *
 * Shaped as `capital (infix* capital)*` rather than `capital (infix capital)*`,
 * because the second half of a Dutch place name is not always introduced by an
 * infix: "Den Helder" and "Den Haag" are two capitals in a row, and the earlier
 * pattern stopped after "Den". That truncation was not harmless — "Den" prefix-
 * matches the "Den Haag-…" Luchtmeetnet stations and resolves to De Bilt in the
 * PDOK Locatieserver, so a question about Den Helder came back with Den Haag's
 * air quality and parcels 89 km away.
 *
 * "'s-Hertogenbosch" and "'t Zand" open on an apostrophe, hence the prefix.
 */
const PLACE_CORE = `(?:['’]s-|['’]t\\s+)?[A-ZÀ-Þ][\\wÀ-ÿ'’-]*(?:(?:\\s+(?:${PLACE_INFIXES}))*\\s+[A-ZÀ-Þ][\\wÀ-ÿ'’-]*)*`;

const GEMEENTE_PLACE_RE = new RegExp(`\\bgemeente\\s+(${PLACE_CORE})`);

const IN_PLACE_RE = new RegExp(`\\bin\\s+(${PLACE_CORE})`);

/**
 * Pull a place name out of a raw (non-lowercased) question so bbox- and
 * gemeente-scoped sources can be driven from natural language: "in Tilburg",
 * "gemeente Land van Cuijk". Exported for router-intent tests.
 *
 * Over-capturing ("in Amsterdam en Utrecht") is preferred over truncating: an
 * unresolvable name makes a source answer "not found", which is honest, while a
 * truncated one silently resolves to a different place.
 */
export function extractPlaceName(text: string): string | undefined {
  const gemeenteMatch = GEMEENTE_PLACE_RE.exec(text);
  const inMatch = IN_PLACE_RE.exec(text);
  const raw = (gemeenteMatch?.[1] ?? inMatch?.[1] ?? "").trim().replace(/[?.,;:!]+$/, "");
  return raw.length >= 3 ? raw : undefined;
}

/**
 * Narrow a natural question down to CBS-searchable topic words.
 *
 * CBS table titles are national and topical ("Woningen; ...", "Bevolking; ..."):
 * they never carry a municipality name and rarely a question word, so searching
 * the full sentence — even after the generic rewriter — returns nothing. These
 * candidates are only ever tried AFTER the existing ones come back empty, so a
 * query that works today keeps its current result.
 */
export function cbsNarrowingCandidates(strictQuery: string, place?: string): string[] {
  const placeTokens = new Set(
    (place ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
  // Quantity/question words survive the shared rewriter (its frames only strip
  // them directly before a verb) but never appear in a CBS table title.
  const quantityWords = new Set([
    "hoeveel", "aantal", "aantallen", "veel", "many", "much", "count",
    "welke", "welk", "wat", "hoe", "waar", "wanneer", "wie",
  ]);

  const tokens = strictQuery
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter((t) => t.length > 2 && !quantityWords.has(t) && !placeTokens.has(t));

  if (!tokens.length) return [];

  const joined = tokens.join(" ");
  // Longest token = most distinctive noun; the last resort when even the
  // narrowed phrase finds nothing ("woningen gebouwd" -> "woningen").
  const longest = [...tokens].sort((a, b) => b.length - a.length)[0];

  return [...new Set([joined, longest])].filter(Boolean);
}

/** Map an air-quality component named in a (lowercased) question to a Luchtmeetnet formula. */
export function extractLuchtComponent(lowered: string): string | undefined {
  if (/\bno2\b|stikstofdioxide/.test(lowered)) return "NO2";
  if (/\bpm\s?2[.,]?5\b|\bpm25\b/.test(lowered)) return "PM25";
  if (/\bpm\s?10\b|fijn\s?stof/.test(lowered)) return "PM10";
  if (/\bozon\b|\bo3\b/.test(lowered)) return "O3";
  if (/\bso2\b|zwaveldioxide/.test(lowered)) return "SO2";
  return undefined;
}

/** Map an election kind mentioned in a (lowercased) question to a Kiesraad code prefix. */
export function extractVerkiezingHint(lowered: string): string | undefined {
  if (/tweede\s*kamer/.test(lowered)) return "TK";
  if (/gemeenteraad/.test(lowered)) return "GR";
  if (/provinciale\s*staten/.test(lowered)) return "PS";
  if (/europe(es|se)\s*parlement|europese verkiezing/.test(lowered)) return "EP";
  if (/eerste\s*kamer/.test(lowered)) return "EK";
  if (/waterschap/.test(lowered)) return "WS";
  const code = /\b([a-z]{2})\s?(\d{8})\b/.exec(lowered);
  return code ? `${code[1].toUpperCase()}${code[2]}` : undefined;
}

export type EuIntent =
  | { kind: "document"; celex: string }
  | { kind: "transposition"; celex: string }
  | { kind: "search"; query: string };

const EU_CELEX_TOKEN = /(?:^|[^\p{L}\d])(?:celex\s*:?\s*)?(3\d{4}[RLD]\d{4})(?=$|[^\p{L}\d])/iu;

// Tight citation shape: a bare "verordening 2024/12" can be a municipal bylaw, so
// regulations and decisions need an EU/EG/EEG marker; directives are EU-only.
const EU_CITATION = /(?:uitvoerings|gedelegeerde\s+)?(verordening|richtlijn|besluit)\s*(\((?:eu|eg|eeg|euratom)\)|\b(?:eu|eg|eeg)\b)?\s*(?:nr\.?\s*)?\d{1,4}\s*\/\s*\d{1,4}(\s*\/\s*(?:eu|eg|eeg)\b)?/iu;

const EU_SEARCH_TRIGGER = /(?:^|[^\p{L}\d-])(?:eur-?lex|eu-(?:richtlijn|verordening|wetgeving)(?:en)?|europese\s+(?:richtlijn|verordening|wetgeving)(?:en)?|omzetting\s+(?:van\s+(?:de\s+|een\s+)?)?(?:eu-)?richtlijn(?:en)?)(?=$|[^\p{L}\d-])/iu;

const EU_STRIP_WORDS = /(?:^|[^\p{L}\d-])(?:eur-?lex|eu|eu-richtlijn(?:en)?|eu-verordening(?:en)?|eu-wetgeving|europese|europees|richtlijn(?:en)?|verordening(?:en)?|wetgeving|omzetting|welke|zijn|er|over|op|het|gebied|van|de|een|in)(?=$|[^\p{L}\d-])/giu;

/** EU acts better known by their name than by their number. */
const EU_NAMED_ACTS: Array<[RegExp, string]> = [
  [/(?:^|[^\p{L}])(?:avg|gdpr|algemene\s+verordening\s+gegevensbescherming)(?=$|[^\p{L}])/iu, "32016R0679"],
  [/(?:^|[^\p{L}])kaderrichtlijn\s+water(?=$|[^\p{L}])/iu, "32000L0060"],
  [/(?:^|[^\p{L}])habitatrichtlijn(?=$|[^\p{L}])/iu, "31992L0043"],
  [/(?:^|[^\p{L}])vogelrichtlijn(?=$|[^\p{L}])/iu, "32009L0147"],
];
/**
 * A question about other documents on a named act (rulings, fines,
 * parliamentary papers, council records, news), which other routes answer:
 * "Uitspraken over de AVG", "Kamervragen over de Habitatrichtlijn".
 */
const EU_NAMED_ACT_OTHER_SOURCE_RE = /(?:^|[^\p{L}])(?:uitspra(?:ak|ken)|jurisprudentie|rechtspraak|rechter\p{L}*|rechtbank\p{L}*|vonnis\p{L}*|arrest\p{L}*|boetes?|sancties?|handhaving|toezicht\p{L}*|autoriteit|kamervra\p{L}*|kamerstuk\p{L}*|kamerbrie\p{L}*|moties?|amendement\p{L}*|\p{L}*debat\p{L}*|tweede\s+kamer|gemeente\p{L}*|provincie\p{L}*|raad|nieuws|beleid|rapport\p{L}*|onderzoek\p{L}*|datalek\p{L}*|klachten?|algoritme\p{L}*|minister\p{L}*|staatssecretaris\p{L}*|kabinet|regering|premier|wethouders?|burgemeesters?)(?=$|[^\p{L}])/iu;

/**
 * Narrow EU-legislation intent for nl_gov_ask. Runs on the RAW question: the
 * query rewriter strips '/', which would destroy citations like "2016/679".
 */
export function detectEuIntent(question: string): EuIntent | undefined {
  const raw = String(question ?? "");
  let celex: string | null = null;
  const token = EU_CELEX_TOKEN.exec(raw);
  if (token) celex = normalizeCelex(token[1]);
  if (!celex) {
    const cit = EU_CITATION.exec(raw);
    if (cit && (cit[2] || cit[3] || cit[1].toLowerCase() === "richtlijn")) celex = normalizeCelex(cit[0]);
  }
  // "Wat zegt de AVG over het verwerkingsregister?", "Hoe is de Kaderrichtlijn Water omgezet?": the act by its name.
  if (!celex && raw.length <= 300 && !EU_NAMED_ACT_OTHER_SOURCE_RE.test(raw)) {
    celex = EU_NAMED_ACTS.find(([re]) => re.test(raw))?.[1] ?? null;
  }
  if (celex) {
    const isDirective = celex.charAt(5) === "L";
    return isDirective && /omzet|omgezet|implementatie|ge[iï]mplementeerd|transpos/i.test(raw) ? { kind: "transposition", celex } : { kind: "document", celex };
  }
  if (!EU_SEARCH_TRIGGER.test(raw)) return undefined;
  const query = raw.replace(/[?!.,;:]/g, " ").replace(EU_STRIP_WORDS, " ").replace(/\s+/g, " ").trim();
  return query ? { kind: "search", query } : undefined;
}

export function shouldDeepenTweedeKamerQuery(question: string): boolean {
  const q = question.trim().toLowerCase();
  if (!q) return false;

  const explicitContentIntent = [
    /\bvat(?:\s+\w+){0,4}\s+samen\b/i,
    /\bsamenvatting\b/i,
    /\bsummary\b/i,
    /\bsummar(?:ise|ize)\b/i,
    /\bwat\s+staat\s+er(?:in|\s+in)\b/i,
    /\binhoud\b/i,
    /\bleg\s+uit\b/i,
    /\banalyse(?:er)?\b/i,
    /\bwat\s+is\s+besloten\b/i,
    /\bwat\s+heeft\s+de\s+tweede\s+kamer\s+besloten\b/i,
    /\bwat\s+besluiten\s+deze\s+stukken\b/i,
    /\bwhat\s+does\s+(?:this|the)\s+(?:document|motion|letter|brief|stuk)\s+say\b/i,
    /\bwhat\s+is\s+in\s+(?:this|the)\s+(?:document|motion|letter|brief|stuk)\b/i,
  ];

  return explicitContentIntent.some((pattern) => pattern.test(q));
}

/** Words that only say "a municipality"; dropped from a search that is already scoped to one. */
export const MUNICIPAL_SCOPE_WORDS = ["gemeente", "gemeenten", "gemeentes", "gemeentelijk", "gemeentelijke", "gemeenteraad", "gemeenteraden"];

/**
 * Words that place a question in a municipal council: the council, its members
 * and its papers, whose documents live in Open Raadsinformatie. Plain
 * "gemeente(n)" is not among them; it only names the kind of organisation
 * ("Rechtspraak over gemeentelijke belastingen" is no council question).
 */
const COUNCIL_RE = /(?:^|[^\p{L}])(?:gemeenteraad|gemeenteraden|raadslid|raadsleden|raadsvoorstel(?:len)?|raadsbesluit(?:en)?|raadsbrie(?:f|ven)|raadsinformatiebrie(?:f|ven)|raadsvergadering(?:en)?|raadsinformatie|wethouders?|burgemeesters?|collegebesluit(?:en)?|b&w)(?=$|[^\p{L}])/iu;

/** "gemeente", "gemeenten", "gemeentelijke": a municipal question, but no signal of its own. */
const MUNICIPALITY_NOUN_RE = /(?:^|[^\p{L}])(?:gemeente|gemeenten|gemeentes|gemeentelijke?)(?=$|[^\p{L}])/iu;

/** Generic organisation nouns: they mark an organisation question but are no search topic. */
export const ORGANISATION_WORDS = ["overheid", "overheden", "organisatie", "organisaties", "overheidsorganisatie", "overheidsorganisaties", "uitvoeringsorganisatie", "uitvoeringsorganisaties"];

const ORGANISATION_RE = /(?:^|[^\p{L}])(?:gemeente|gemeenten|gemeentes|provincie|provincies|waterschap|waterschappen|ministerie|ministeries|overheid|overheden|overheidsorganisaties?|uitvoeringsorganisaties?|veiligheidsregio(?:'s)?|agentschap(?:pen)?)(?=$|[^\p{L}])/iu;

/**
 * National actors. When one of them is the subject, "in Amsterdam" is where
 * something happens, not the municipality whose council records answer it
 * ("Wat doet het kabinet aan woningnood in Amsterdam?").
 */
const NATIONAL_ACTOR_RE = /(?:^|[^\p{L}])(?:kabinet|regering|ministers?|ministerie|ministeries|staatssecretaris(?:sen)?|rijksoverheid|tweede\s+kamer|eerste\s+kamer)(?=$|[^\p{L}])/iu;

const RULING_WORD_RE = /(?:^|[^\p{L}])uitspra(?:ak|ken)(?=$|[^\p{L}])/iu;

/**
 * Courts, judges and case-law words: with one of them named, "uitspraken" are
 * rulings. "hof" is the court of appeal, but not in the municipality name "Hof
 * van Twente". The chambers of a court ("meervoudige kamer", "strafkamer")
 * are named here so that "kamer" in them is not read as parliament.
 */
const COURT_RE = /(?:^|[^\p{L}])(?:\p{L}*rechters?|rechtbank(?:en)?|gerechtsh(?:of|oven)|hof(?!\s+van\s+twente)|raad\s+van\s+state|hoge\s+raad|centrale\s+raad\s+van\s+beroep|college\s+van\s+beroep|tuchtcolleges?|ecli|jurisprudentie|rechtspraak|rechterlijke?|(?:meervoudige|enkelvoudige|civiele)\s+kamer|(?:straf|kanton|belasting|ondernemings|pacht|familie|handels)kamer)(?=$|[^\p{L}])/iu;

/**
 * Office holders, politicians and bodies that make statements. "Uitspraken van
 * de minister over jeugdzorg" asks what the minister said; "uitspraken" is the usual
 * Dutch word for that as well as for court rulings. Bare "partij(en)" is not
 * among them: "tussen partijen" names the parties to a court case.
 */
const STATEMENT_SPEAKER = String.raw`(?:kabinet|regering|ministers?|minister-president|premier|staatssecretaris(?:sen)?|bewindslieden|bewindspersonen?|(?:tweede\s+|eerste\s+)?kamer|kamerleden|kamerlid|politicus|politici|(?:politieke\s+|coalitie|oppositie|regerings)partij(?:en)?|fracties?|fractievoorzitters?|lijsttrekkers?|wethouders?|burgemeesters?|gemeenteraad|raadsleden|raadslid|raad|college|gedeputeerden?|commissaris|koning|president)`;

/** "de", "het" or "een", then at most one word ("de demissionaire minister", "minister Keijzer" needs none). */
const SPEAKER_LEAD = String.raw`(?:(?:de|het|een)\s+)?(?:\p{L}+\s+)?`;

const UITSPRAAK = String.raw`uitspra(?:ak|ken)`;

const WORD_START = String.raw`(?:^|[^\p{L}])`;

const WORD_END = String.raw`(?=$|[^\p{L}])`;

/** The rest of the clause up to a word boundary: no sentence or clause mark in between. */
const CLAUSE_GAP = String.raw`(?:[^.!?;:]*[^\p{L}.!?;:])?`;

/** Speech verbs: with one of them the speaker made statements ("Wat zei de minister", "de premier zegt"). */
const SPEECH_VERB = String.raw`(?:zei|zeiden|zegt|zeggen)`;

/**
 * Forms of "doen", the verb of "een uitspraak doen". They tie the speaker to
 * the word only when "uitspraak" is their object ("Welke uitspraken deed de
 * premier", "Deed de premier uitspraken"), not in "Wat doet het college met de
 * uitspraak over de parkeervergunning?", where the college acts on a ruling.
 */
const DO_VERB = String.raw`(?:deed|deden|doet|doen)`;

/**
 * Auxiliaries. "heeft de minister" is a statement only with a statement
 * participle in the same clause ("Welke uitspraken heeft het kabinet gedaan"),
 * not in "Heeft de staatssecretaris de uitspraak aangevochten?" or "Welke
 * uitspraak heeft de minister verloren?", where the office holder is a party.
 */
const AUX_VERB = String.raw`(?:heeft|hebben|had|hadden)`;

const STATEMENT_PARTICIPLE = String.raw`(?:gedaan|gezegd|geuit|uitgesproken|herhaald|teruggenomen)`;

/** Prepositions that make "de uitspraak" the thing talked about or acted on ("met de uitspraak", "na de uitspraak"). */
const TOPIC_PREPOSITION = String.raw`(?:over|met|tegen|na|naar|bij|op|in|aan|voor|door|om|ondanks|volgens|rond|rondom|omtrent|inzake|sinds|zonder|uit|tot|onder)`;

/** A determiner and at most one other word (no preposition) before "uitspraak" as the object of "doen": "deed de premier een opvallende uitspraak". */
const OBJECT_LEAD = String.raw`(?:(?:de|het|een|die|deze|dit|dat|geen|zulke|enkele|veel|vele|meerdere)\s+)?(?:(?!${TOPIC_PREPOSITION}\s)\p{L}+\s+)?`;

/**
 * "uitspraak" in a prepositional phrase ("met de uitspraak", "na de recente
 * uitspraak"): a ruling talked about or acted on, not something a speaker
 * says. A possessive keeps it the speaker's own ("in zijn uitspraak").
 */
const TOPIC_UITSPRAAK_RE = new RegExp(String.raw`${WORD_START}${TOPIC_PREPOSITION}\s+(?:(?:de|het|een|deze|die|dit|dat)\s+)?(?:(?!(?:zijn|haar|hun|diens|mijn|onze|jullie)\s)\p{L}+\s+)?${UITSPRAAK}${WORD_END}`, "giu");

/**
 * A speaker tied to "uitspraak"/"uitspraken". Checked on the question as
 * typed: its owner ("uitspraken van de minister", "gedaan door het kabinet",
 * "uitspraken die de wethouder deed"), the subject of a speech verb ("Wat zei
 * de premier") or of an auxiliary with a statement participle ("Welke
 * uitspraken heeft het kabinet gedaan"). An office holder that is only named
 * somewhere in the question is often a party to a case instead ("Uitspraak
 * over verblijfsvergunning tegen de staatssecretaris", "Uitspraken die de
 * staatssecretaris heeft verloren").
 */
const LINKED_SPEAKER_RES = [
  new RegExp(String.raw`${WORD_START}${UITSPRAAK}\s+(?:(?:gedaan|gedane)\s+)?(?:van|door)\s+${SPEAKER_LEAD}${STATEMENT_SPEAKER}${WORD_END}`, "iu"),
  new RegExp(String.raw`${WORD_START}(?:gedaan|gedane)\s+door\s+${SPEAKER_LEAD}${STATEMENT_SPEAKER}${WORD_END}`, "iu"),
  new RegExp(String.raw`${WORD_START}${UITSPRAAK}\s+die\s+${SPEAKER_LEAD}${STATEMENT_SPEAKER}${WORD_END}${CLAUSE_GAP}(?:${DO_VERB}|${SPEECH_VERB}|${STATEMENT_PARTICIPLE}|uitte|uitten)${WORD_END}`, "iu"),
  new RegExp(String.raw`${WORD_START}${SPEECH_VERB}\s+${SPEAKER_LEAD}${STATEMENT_SPEAKER}${WORD_END}`, "iu"),
  new RegExp(String.raw`${WORD_START}${STATEMENT_SPEAKER}\s+${SPEECH_VERB}\s+(?:\p{L}+\s+){0,3}${UITSPRAAK}${WORD_END}`, "iu"),
  new RegExp(String.raw`${WORD_START}${AUX_VERB}\s+${SPEAKER_LEAD}${STATEMENT_SPEAKER}${WORD_END}${CLAUSE_GAP}${STATEMENT_PARTICIPLE}${WORD_END}`, "iu"),
  new RegExp(String.raw`${WORD_START}${STATEMENT_SPEAKER}\s+${AUX_VERB}\s+(?:\p{L}+\s+){0,3}${UITSPRAAK}${WORD_END}${CLAUSE_GAP}${STATEMENT_PARTICIPLE}${WORD_END}`, "iu"),
];

/**
 * A speaker as the subject of "doen" with "uitspraak" as its object. Checked
 * on the question with every "uitspraak" in a prepositional phrase set aside
 * (TOPIC_UITSPRAAK_RE): "uitspraak" before the verb in the same clause
 * ("Welke uitspraken over migratie deed de premier", but not "Uitspraak over
 * de parkeervergunning wat doet het college ermee", whose object is "wat"),
 * or right after the speaker or verb ("Deed de premier uitspraken", "De
 * premier deed een opvallende uitspraak").
 */
const DO_STATEMENT_RES = [
  new RegExp(String.raw`${WORD_START}${UITSPRAAK}${WORD_END}(?:(?![^\p{L}](?:wat|hoe|waarom)[^\p{L}])[^.!?;:,])*[^\p{L}.!?;:,]${DO_VERB}\s+${SPEAKER_LEAD}${STATEMENT_SPEAKER}${WORD_END}`, "iu"),
  new RegExp(String.raw`${WORD_START}${DO_VERB}\s+${SPEAKER_LEAD}${STATEMENT_SPEAKER}\s+${OBJECT_LEAD}${UITSPRAAK}${WORD_END}`, "iu"),
  new RegExp(String.raw`${WORD_START}${STATEMENT_SPEAKER}\s+${DO_VERB}\s+${OBJECT_LEAD}${UITSPRAAK}${WORD_END}`, "iu"),
];

/** Whether an office holder or body in the question is the speaker of "uitspraak"/"uitspraken". */
function hasLinkedSpeaker(question: string): boolean {
  if (LINKED_SPEAKER_RES.some((re) => re.test(question))) return true;
  const withoutTopics = question.replace(TOPIC_UITSPRAAK_RE, (m) => m.replace(/uitspra(?:ak|ken)$/iu, "…"));
  return DO_STATEMENT_RES.some((re) => re.test(withoutTopics));
}

/**
 * Words that only occur in court proceedings: appeal, the parties and their
 * roles, a case against someone, contesting a ruling and its outcome ("de
 * uitspraak aangevochten", "in het gelijk gesteld", "gelijk gekregen", "het
 * besluit … vernietigd"). With one of them "uitspraken" are rulings, also when
 * an office holder is tied to the word ("Welke uitspraken heeft de
 * staatssecretaris in hoger beroep verloren?"). Words that are also a policy
 * topic ("bezwaar", "geschil", "bestemmingsplan", "beroep" as a trade) are not
 * among them, nor bare "verloren"/"gewonnen" ("Uitspraken van de premier over
 * de gewonnen verkiezingen"); without a tied speaker the question is read as
 * rulings anyway ("Welke uitspraak heeft de minister verloren?").
 */
const LITIGATION_RE = /(?:^|[^\p{L}])(?:hoger\s+beroep|in\s+beroep|beroep\s+(?:tegen|ingesteld|aangetekend)|beroepschrift(?:en)?|beroepszaak|beroepszaken|cassatie|bezwaarschrift(?:en)?|(?:tussen\s+(?:de\s+)?|proces)partijen|procespartij|eisers?|eiseres|gedaagden?|verweerders?|verweerster|appellant(?:e|en)?|kort\s+geding|rechtszaak|rechtszaken|za(?:ak|ken)\s+tegen|aangevochten|aanvechten|aanvecht|aanvocht(?:en)?|(?:vecht|vechten|vocht|vochten)\s+(?:[^.!?;:]*\s)?aan(?=\s*(?:$|[.!?;:,]))|in\s+het\s+gelijk\s+(?:gesteld|stelde|stelden|stelt)|gelijk\s+(?:gekregen|kreeg|kregen|krijgt|krijgen)|vernietiging\s+van\s+(?:het|de)\s+(?:besluit|beschikking|vonnis|uitspraak)|(?:besluit(?:en)?|beschikkingen?|vonnis(?:sen)?)\s+(?:\p{L}+\s+){0,3}vernietigd)(?=$|[^\p{L}])/iu;

/**
 * What "uitspraak"/"uitspraken" means in a question, if it occurs. With a
 * court named ("Uitspraken van de rechtbank over de gemeente") or a word of
 * court proceedings ("Uitspraak huurgeschil tussen partijen") the word means
 * rulings. It means statements, which court rulings do not answer, only when
 * an office holder or body is tied to it as its speaker ("Uitspraken van de
 * minister over jeugdzorg", "Welke uitspraken deed de premier over migratie?",
 * "Uitspraken van de wethouder van Utrecht"). Every other question asks for
 * rulings: "Welke uitspraken zijn er over huurrecht?", and also "Uitspraak in
 * de zaak tegen de minister van Justitie", "Heeft de staatssecretaris de
 * uitspraak aangevochten?" and "Wat doet het college met de uitspraak?",
 * where the office holder is a party or acts on a ruling. A speaker named
 * only by surname is not recognised.
 */
export function uitsprakenSense(question: string): "rulings" | "statements" | undefined {
  const raw = String(question ?? "");
  if (!RULING_WORD_RE.test(raw)) return undefined;
  if (COURT_RE.test(raw) || LITIGATION_RE.test(raw)) return "rulings";
  return hasLinkedSpeaker(raw) ? "statements" : "rulings";
}

/** Whether a question asks for court rulings with "uitspraak"/"uitspraken". Exported for router tests. */
export function asksForRulings(question: string): boolean {
  return uitsprakenSense(question) === "rulings";
}

/**
 * Policy vocabulary, compounds included ("GGZ-beleid", "kabinetsbeleid",
 * "woonstrategie", "omgevingsvisie"). "visie" is matched only on its own or as
 * a compound with a linking -s or hyphen, so "televisie" and "revisie" stay out.
 */
const POLICY_RE = /(?:^|[^\p{L}])(?:[\p{L}-]*beleid(?:s\p{L}*)?|[\p{L}-]*strategie(?:ën|s)?|(?:\p{L}+-)?visie|\p{L}+svisie|omgevingsvisie|toekomstvisie|aanpak|plannen|ambities?|maatregelen|inzet|toepassing(?:en)?)(?=$|[^\p{L}])/iu;

/** Questions about what an organisation does: "Wat doet …", "Hoe gaat … om met …". */
const ORGANISATION_ACTIVITY_RES = [
  /\bwat\s+(?:doet|doen|deed|deden)\b/i,
  /\bhoe\s+(?:gaat|gaan|ging|gingen)\b[\s\S]*\bom\s+met\b/i,
  /\bhoe\s+(?:gebruikt|gebruiken|zet|zetten|pakt|pakken|werkt|werken)\b/i,
  /\b(?:werkt|werken)\s+(?:aan|met)\b/i,
  /\b(?:van\s+plan|bezig\s+met)\b/i,
];

/** Words that ask for data rather than documents. */
const DATA_INTENT_WORDS = new Set(["data", "dataset", "datasets", "gegevens", "databestand", "databestanden", "cijfers", "statistiek", "statistieken", "tabel", "tabellen"]);

/**
 * A question that asks for data rather than documents ("Welke data is er over
 * verkeersongevallen?"); the catalogue fallback is the right answer there.
 * A data word only counts on its own: lowercase (a capitalised "Data"
 * mid-sentence is part of a name), not a compound ("data-uitwisseling") and not the
 * first half of a term ("open data portaal", "data strategie"). Before, a
 * lowercase question about an open data portaal went to the catalogue, which
 * dropped "data" and searched "open portaal".
 */
export function hasDataIntent(question: string): boolean {
  const words = String(question ?? "").split(/[^\p{L}\p{N}&+-]+/u).filter(Boolean);
  return words.some((word, i) => {
    const lower = word.toLowerCase();
    if (!DATA_INTENT_WORDS.has(lower)) return false;
    const sentenceInitial = i === 0 && /^\p{Lu}\p{Ll}/u.test(word);
    if (word !== lower && !sentenceInitial) return false;
    return metaNounBinding(undefined, lower, words[i + 1]) !== "head";
  });
}

// No "i" flag on these: PLACE_CORE relies on capitals to know where a place name ends.
const GEMEENTE_PLACE_ANY_CASE_RE = new RegExp(`\\b[Gg]emeente\\s+(${PLACE_CORE})`);

/**
 * "de raad van Amsterdam", "het college in Delft", "burgemeester van Tilburg".
 * "raad" and "college" only in lowercase: capitalised they open the name of a
 * court or body ("Raad van State", "Centrale Raad van Beroep", "College van
 * Beroep voor het bedrijfsleven"), which is no municipality.
 */
const GOVERNANCE_PLACE_RE = new RegExp(`(?:^|[^\\p{L}])(?:[Gg]emeenteraad|raad|college|[Bb]urgemeester|[Ww]ethouders?)\\s+(?:van|in)\\s+(${PLACE_CORE})`, "u");

/** Places that extractPlaceName can return but that have no municipal ORI index. */
const NOT_A_MUNICIPALITY = new Set([
  "nederland", "europa", "eu", "tweede kamer", "eerste kamer", "noord-holland", "zuid-holland",
  "noord-brabant", "gelderland", "overijssel", "drenthe", "friesland", "fryslân", "flevoland",
  "limburg", "zeeland", "randstad",
  // Second halves of the names of courts and bodies: "raad van State",
  // "college van Beroep", "raad van Bestuur", "college van B en W".
  "state", "beroep", "bestuur", "toezicht", "commissarissen", "advies", "state-generaal",
  "b en w", "burgemeester en wethouders", "gedeputeerde staten", "ministers", "europese unie",
]);

/** Lowercase infixes inside a place name ("Bergen op Zoom"); a name never ends on one. */
const PLACE_INFIX_WORDS = new Set(["aan", "bij", "de", "den", "der", "en", "het", "op", "ten", "ter", "van"]);

export interface PolicyIntent {
  /**
   * Municipality named in the question; scopes an ORI search to its council
   * index. Not set when a national actor is the subject ("Wat doet het kabinet
   * voor de gemeente Groningen?").
   */
  gemeente?: string;
  /** The question concerns municipal councils, so ORI is a relevant source even without a named municipality. */
  municipal: boolean;
  /** What made the router treat this as an organisation/policy question. */
  signals: Array<"beleid" | "activiteit" | "organisatie" | "gemeente">;
  /**
   * "strong": a policy word, an activity question or the council itself; the
   * router searches documents before its national routes (Rijksoverheid, DUO).
   * "weak": only an organisation noun or a named municipality; the document
   * search is then a last resort before the catalogue, after every route that
   * a question word picked (Rijksbegroting for "uitgaven van de overheid").
   */
  strength: "strong" | "weak";
}

/**
 * Clean a captured place name and reject what is no municipality. The place
 * pattern lets infixes join capitalised words, so "de raad van Amsterdam van
 * het OV" captured "Amsterdam van het OV"; an acronym ends a place name.
 */
function cleanPlace(raw: string | undefined): string | undefined {
  const words = (raw ?? "").trim().replace(/[?.,;:!]+$/, "").split(/\s+/).filter(Boolean);
  if (!words.length || /^\p{Lu}{2,}$/u.test(words[0])) return undefined;
  let end = words.findIndex((w, i) => i > 0 && /^\p{Lu}{2,}$/u.test(w));
  if (end < 0) end = words.length;
  while (end > 1 && PLACE_INFIX_WORDS.has(words[end - 1].toLowerCase())) end--;
  const place = words.slice(0, end).join(" ");
  if (place.length < 3 || NOT_A_MUNICIPALITY.has(place.toLowerCase())) return undefined;
  return place;
}

/**
 * Organisation and policy questions ("Wat doet de Belastingdienst met de BTW?",
 * "GGZ-beleid gemeente Utrecht") have no dataset as answer: they are answered by
 * council documents (ORI), official publications, parliamentary papers and
 * government news. Without this the router sent them to the dataset catalogue,
 * which matched the whole sentence against dataset titles and found nothing.
 *
 * Returns undefined for questions without an organisation or policy signal, and
 * for data questions ("Welke gegevens heeft de gemeente over parkeren?") unless
 * they also carry a policy or activity signal. The router uses
 * {@link PolicyIntent.strength} to decide how early the document search runs,
 * and skips it for case-law and API questions.
 */
export function detectPolicyIntent(question: string): PolicyIntent | undefined {
  const raw = String(question ?? "").trim();
  if (!raw) return undefined;

  const policy = POLICY_RE.test(raw);
  const activity = ORGANISATION_ACTIVITY_RES.some((re) => re.test(raw));
  const organisation = ORGANISATION_RE.test(raw);
  const municipalityNounMatch = MUNICIPALITY_NOUN_RE.exec(raw);
  const municipalityNoun = Boolean(municipalityNounMatch);
  const gemeenteMatch = GEMEENTE_PLACE_ANY_CASE_RE.exec(raw);
  const governanceMatch = GOVERNANCE_PLACE_RE.exec(raw);
  const councilMatch = COUNCIL_RE.exec(raw);
  const governancePlace = cleanPlace(governanceMatch?.[1]);
  const council = Boolean(councilMatch) || Boolean(governancePlace);
  const strong = policy || activity || council;

  if (hasDataIntent(raw) && !strong) return undefined;

  // A national actor named before any municipal word is the subject: "Wat
  // doet het kabinet voor de gemeente Groningen?" and "Wat zegt de minister
  // over de gemeente Groningen?" ask what the cabinet or minister does or
  // says, which council records do not answer (searching Groningen's for
  // "kabinet" returned council papers, a national ORI search motions from
  // other councils). Such a question is no municipal one; the national
  // sources answer it. "Wat vindt de gemeenteraad van Utrecht van de plannen
  // van het kabinet?" keeps its council.
  const nationalIndex = NATIONAL_ACTOR_RE.exec(raw)?.index;
  const municipalIndex = Math.min(
    ...[municipalityNounMatch, gemeenteMatch, governanceMatch, councilMatch].map((m) => m?.index ?? Number.POSITIVE_INFINITY),
  );
  const nationalSubject = nationalIndex !== undefined && nationalIndex < municipalIndex;

  // A municipality to scope by: named as "gemeente X" / "de raad van X" when no
  // national actor is the subject, or "in X" when the question is about policy
  // or a municipality and no national actor appears at all.
  const named = nationalSubject ? undefined : (cleanPlace(gemeenteMatch?.[1]) ?? governancePlace);
  const inPlace = (strong || municipalityNoun) && nationalIndex === undefined ? cleanPlace(extractPlaceName(raw)) : undefined;
  const gemeente = named ?? inPlace;

  if (!strong && !organisation && !municipalityNoun && !gemeente) return undefined;

  const municipal = !nationalSubject && (council || municipalityNoun || Boolean(gemeente));
  const signals: PolicyIntent["signals"] = [];
  if (policy) signals.push("beleid");
  if (activity) signals.push("activiteit");
  if (organisation) signals.push("organisatie");
  if (municipal) signals.push("gemeente");

  return { ...(gemeente ? { gemeente } : {}), municipal, signals, strength: strong ? "strong" : "weak" };
}

/**
 * Questions longer than this get no DSO intent and keep the route they had
 * before the DSO route: real questions are far shorter, and the detector's
 * work stays bounded whatever nl_gov_ask is sent.
 */
const DEBAT_QUESTION_MAX_CHARS = 300;

export type DebatIntent = {
  /** Words in what was said: the topic after "over". */
  query?: string;
  /** Words in the debate subject: "stikstof" of "het stikstofdebat". */
  debat?: string;
  fractie?: string;
  spreker?: string;
};

/** Fracties as a question writes them, to the name in the verslagen. Upper case only where the name is a common word ("PRO", "SP"). */
const DEBAT_FRACTIES: Array<[RegExp, string]> = [
  [/\bVVD\b/, "VVD"], [/\bCDA\b/, "CDA"], [/\bPVV\b/, "PVV"], [/\bD66\b/i, "D66"], [/\bSP\b/, "SP"], [/\bPRO\b/, "PRO"],
  [/\bJA21\b/i, "JA21"], [/\bSGP\b/, "SGP"], [/\bDENK\b/, "DENK"], [/\bBBB\b/, "BBB"], [/\bFvD\b/, "FvD"], [/\bChristenUnie\b/i, "ChristenUnie"],
  [/\bGL-PvdA\b|\bGroenLinks-PvdA\b/i, "GroenLinks-PvdA"], [/\bPvdD\b|\bPartij voor de Dieren\b/i, "PvdD"], [/\bVolt\b/, "Volt"],
  [/\b50PLUS\b/i, "50PLUS"], [/\bNSC\b/, "NSC"], [/\bGroep Markuszower\b/i, "Groep Markuszower"],
];

/** Speaking, in the past or present: what someone said, argued or answered. */
const DEBAT_SPEECH = /\b(?:zei|zeiden|zegt|zeggen|gezegd|sprak|spraken|gesproken|uitspraak|uitspraken|inbreng|betoog|betoogde|beweerde|antwoordde|citaat|citaten)\b/;

/** "in het debat", "tijdens het commissiedebat", "in debatten". */
const DEBAT_IN = /\b(?:in|tijdens|uit|bij)\s+(?:het\s+|de\s+|een\s+)?\p{L}*debat(?:ten)?\b/u;

/** A debate word, alone or in a compound ("stikstofdebat", "commissiedebat"). */
const DEBAT_WORD = /(?<![\p{L}\p{N}])(\p{L}*?)debat(?:ten)?(?![\p{L}\p{N}])/u;

const DEBAT_KIND_PREFIXES = new Set(["", "kamer", "commissie", "plenair", "plenaire", "tweeminuten", "dertigleden", "begrotings", "wetgevings", "nota", "spoed", "interpellatie", "het"]);

/** Another body than the Tweede Kamer, or a question about the agenda, votes or moties: other routes. */
const DEBAT_OTHER = /\b(?:gemeenteraad|raadsvergadering|raadsleden|raadslid|provinciale staten|statenvergadering|statenleden|eerste kamer|senaat|europees parlement|waterschap|wanneer|agenda|gepland|stem(?:de|den|ming|mingen)|motie|moties|amendement|amendementen|aangenomen|verworpen)\b/;

const DEBAT_SPREKER_FUNCTIES: Array<[RegExp, string]> = [
  [/\b(?:premier|minister-president)\b/, "minister-president"],
  [/\bstaatssecretaris(?:sen)?\b/, "staatssecretaris"],
  [/\bminister(?:s)?\b/, "minister"],
  [/\b(?:kamer)?voorzitter\b/, "voorzitter"],
];

/**
 * A question about what was said in a Tweede Kamer debate, for
 * tweede_kamer_debatten. Precision first: it names a debate and asks what was
 * said ("Wat zei de VVD in het debat over stikstof?"), or asks what someone
 * said in the Kamer ("Wat heeft de minister in de Tweede Kamer gezegd over
 * Pallas?"), and gives a topic ("over …"), a debate ("het stikstofdebat"), a
 * fractie or a speaker. Never: a question about another body, the agenda, votes,
 * moties or amendementen, or one longer than DEBAT_QUESTION_MAX_CHARS.
 */
export function detectDebatIntent(question: string): DebatIntent | undefined {
  const text = String(question ?? "").trim();
  if (!text || text.length > DEBAT_QUESTION_MAX_CHARS) return undefined;
  const q = text.toLowerCase();
  if (DEBAT_OTHER.test(q)) return undefined;
  const debatWord = DEBAT_WORD.exec(q);
  const speech = DEBAT_SPEECH.test(q);
  const inKamer = /\b(?:in de (?:tweede )?kamer|in het parlement|kamerlid|kamerleden)\b/.test(q);
  if (!(debatWord && (speech || DEBAT_IN.test(q))) && !(speech && inKamer)) return undefined;

  const intent: DebatIntent = {};
  const fracties = DEBAT_FRACTIES.filter(([re]) => re.test(text)).map(([, name]) => name);
  if (fracties.length === 1) intent.fractie = fracties[0];
  const functie = DEBAT_SPREKER_FUNCTIES.find(([re]) => re.test(q));
  if (functie) intent.spreker = functie[1];
  if (!intent.spreker) {
    // "Wat zei Klaver …", "Wat heeft Van Campen gezegd …": a capitalised name after the verb.
    const name = /\b(?:zei|zegt|sprak|heeft|hebben|had)\s+((?:(?:van|de|der|den|ten|ter)\s+)*[A-Z][\p{L}'-]+(?:\s+(?:(?:van|de|der|den|ten|ter)\s+)*[A-Z][\p{L}'-]+)?)/u.exec(text);
    const candidate = name?.[1];
    if (candidate && !DEBAT_FRACTIES.some(([re]) => re.test(candidate)) && !/^(?:De|Het|Een|Er|Ik|Je|U|Wij|We|Zij|Ze|Tweede|Kamer)\b/.test(candidate)) {
      intent.spreker = candidate;
    }
  }
  const prefix = debatWord?.[1] ?? "";
  if (prefix.length >= 4 && !DEBAT_KIND_PREFIXES.has(prefix)) intent.debat = prefix;

  // The topic: what follows "over", up to where the question goes on about the debate, the Kamer or the time.
  const over = /\bover\s+(.+?)(?=\s+(?:in|tijdens|bij|gezegd|gesproken|vorige|afgelopen|deze|dit|vandaag|gisteren|eergisteren)\b|[?.!]|$)/u.exec(text);
  if (over) {
    const topic = parseTkQuery(over[1].replace(/\b(?:het|de|een)\s+\p{L}*debat(?:ten)?\b/giu, " ")).terms
      .map((t) => (t.mode === "word" && /\s/.test(t.text) ? `"${t.text}"` : t.text))
      .join(" ");
    if (topic) intent.query = topic;
  }
  return intent.query || intent.debat || intent.fractie || intent.spreker ? intent : undefined;
}

const ALGORITME_QUESTION_MAX_CHARS = 300;

export type AlgoritmeIntent = {
  organisatie?: string;
  query?: string;
  publicatiecategorie?: "Hoog-risico AI-systeem";
};

const ALGORITME_WORD = /\b(?:algoritmes?|algoritmen|algoritmeregister|ai-systemen|ai-systeem)\b/;

/** Documents about algorithms (council papers, Kamerstukken, reports, rulings) are other routes. */
const ALGORITME_OTHER = /\b(?:raad|gemeenteraad|raadsvoorstel\w*|raadsvragen|raadsinformatiebrief\w*|motie\w*|amendement\w*|kamervra\w*|kamerbrie\w*|kamerstuk\w*|\w*debat\w*|rekenkamer\w*|rapport\w*|onderzoek\w*|wetsvoorstel\w*|nieuws|uitspra\w*|rechter\w*|vonnis\w*|toezicht\w*|wet|wetten|wetgeving|regels|eisen|verordening|ai act)\b/;

const ALGORITME_BODIES = /\b(?:gemeente|provincie|waterschap|hoogheemraadschap)\s+((?:'s-)?[A-Z][\p{L}'.-]*(?:[\s-]+(?:aan|den|de|op|van|[A-Z][\p{L}'.-]*))*)/u;

const ALGORITME_MINISTERIE = /\b[Mm]inisterie\s+van\s+([A-Z][\p{L}'.-]*(?:\s+(?:en|van|[A-Z][\p{L}'.-]*))*)/u;

const ALGORITME_AGENCIES = /\b(UWV|DUO|SVB|CJIB|RDW|IND|CBS|RIVM|Belastingdienst|Dienst Toeslagen|Rijkswaterstaat|Kadaster|Politie|Nationale Politie|Rechtspraak|Kamer van Koophandel)\b/;

/**
 * A question about the algorithms a government body uses or has registered,
 * for the Algoritmeregister ("Welke algoritmes gebruikt de gemeente
 * Amsterdam?", "Welke hoog-risico AI-systemen gebruikt het UWV?"). Precision
 * first: it names algorithms or AI systems and an organisation, a topic ("voor
 * fraudedetectie") or high-risk AI. Never: a question about documents on
 * algorithms (council papers, Kamerstukken, reports, rulings) or about the law
 * on them, which other routes answer.
 */
export function detectAlgoritmeIntent(question: string): AlgoritmeIntent | undefined {
  const text = String(question ?? "").trim();
  if (!text || text.length > ALGORITME_QUESTION_MAX_CHARS) return undefined;
  const q = text.toLowerCase();
  if (!ALGORITME_WORD.test(q) || ALGORITME_OTHER.test(q)) return undefined;
  const intent: AlgoritmeIntent = {};
  const body = ALGORITME_BODIES.exec(text);
  const ministerie = ALGORITME_MINISTERIE.exec(text);
  const agency = ALGORITME_AGENCIES.exec(text);
  if (body) intent.organisatie = `${body[0].split(/\s+/)[0].toLowerCase()} ${body[1].replace(/\s+(?:aan|den|de|op|van)$/, "")}`;
  else if (ministerie) intent.organisatie = `Ministerie van ${ministerie[1].replace(/\s+(?:en|van)$/, "")}`;
  else if (agency) intent.organisatie = agency[1];
  if (/\bhoog[- ]?risico\b/.test(q)) intent.publicatiecategorie = "Hoog-risico AI-systeem";
  const topic = /\b(?:voor|bij het|bij de|om)\s+(.+?)[?.!]*$/u.exec(text);
  if (topic && !(intent.organisatie && topic[1].includes(intent.organisatie.split(" ").pop() ?? ""))) {
    // "voor vergunningverlening in Utrecht": the place is no topic word.
    const words = parseTkQuery(topic[1].replace(/\s+in\s+(?:'s-)?[A-Z][\p{L}'.-]*.*$/u, "")).terms.map((t) => t.text).join(" ");
    if (words) intent.query = words;
  }
  // The register named on its own ("Algoritmeregister omgevingsdienst"): the other words are the search.
  if (/\balgoritmeregister\b/.test(q) && !intent.organisatie && !intent.query && !intent.publicatiecategorie) {
    const words = extractKeywords(text, { exclude: ["algoritmeregister", "algoritme", "algoritmes", "algoritmen", "register", "staat", "staan", "in", "het"] }).join(" ");
    return words ? { query: words } : {};
  }
  return intent.organisatie || intent.query || intent.publicatiecategorie ? intent : undefined;
}

const DSO_QUESTION_MAX_CHARS = 500;

/** The Omgevingswet documents the DSO holds, as a question names them. */
const DSO_DOCUMENT_NOUNS = [
  "omgevingsplan(?:nen)?",
  "omgevingsvisies?",
  "omgevingsverordening(?:en)?",
  "waterschapsverordening(?:en)?",
  "omgevingsprogramma(?:'s|s)?",
  "omgevingsdocument(?:en)?",
  "voorbereidingsbesluit(?:en)?",
  "voorbeschermingsregels?",
  "projectbesluit(?:en)?",
  "ontwerpregeling(?:en)?",
];

export const DSO_DOCUMENT_WORDS_RE = new RegExp(`(?:^|[^\\p{L}])(?:${DSO_DOCUMENT_NOUNS.join("|")})(?=$|[^\\p{L}])|regels\\s+op\\s+de\\s+kaart`, "iu");

/** One document word as a lowercase token (the apostrophe of "programma's" splits it off). */
const DSO_DOCUMENT_TOKEN_RE = new RegExp(`^(?:${DSO_DOCUMENT_NOUNS.join("|")}|novi)$`, "u");

/** The document words with a case-free first letter only, for patterns whose PLACE_CORE needs its capitals. */
const DSO_DOCUMENT_NOUNS_CASED = DSO_DOCUMENT_NOUNS.map((n) => `[${n[0].toUpperCase()}${n[0]}]${n.slice(1)}`).join("|");

/** "de NOVI", the Nationale Omgevingsvisie: in capitals only. */
const DSO_NOVI_RE = /(?:^|[^\p{L}])NOVI(?=$|[^\p{L}])/u;

/** A document word in the plural: the question asks for every such document. */
const DSO_PLURAL_DOCUMENT_RE = /(?:^|[^\p{L}])(?:omgevingsplannen|omgevingsvisies|omgevingsverordeningen|waterschapsverordeningen|omgevingsprogramma(?:'s|s)|omgevingsdocumenten|voorbereidingsbesluiten|voorbeschermingsregels|projectbesluiten|ontwerpregelingen|ontwerpen)(?=$|[^\p{L}])/iu;

/** Words that ask for a list, which a document word without a place may get. */
const DSO_LIST_RE = /(?:^|[^\p{L}])(?:welke|hoeveel|alle|lijst|overzicht|toon|geef|noem|which|list|zijn\s+er|bestaan)(?=$|[^\p{L}])/iu;

/**
 * Qualifiers that keep a question on the documents: "onder de Omgevingswet"
 * names the regime, not the law's text, and "beroep aan huis" is no appeal.
 * Masked before the checks below.
 */
const DSO_NEUTRAL_PHRASE_RE = /(?:^|[^\p{L}])(?:onder\s+de\s+(?:nieuwe\s+)?omgevingswet|beroep\s+aan\s+huis|aan[\s-]huis[\s-]gebonden\s+beroep(?:en)?)(?=$|[^\p{L}])/giu;

/**
 * Words that give a question another route, also next to a document word:
 * the council, Staten, parliament or government as the subject, opinions,
 * other sources and their documents, money, procedures and participation,
 * and the law or a concept rather than a document. Lowercase whole words;
 * DSO_OTHER_ROUTE_WORD_RE has the word families.
 */
const DSO_OTHER_ROUTE_WORDS = new Set([
  "kabinet", "regering", "premier", "stemde", "stemden", "stemt", "besprak", "bespraken", "bespreekt", "bespreken", "besproken",
  "besloot", "besloten", "beslist", "woo", "wob", "vng", "ipo", "iplo", "bzk",
  "vindt", "vond", "vonden", "denkt", "denken", "dacht", "dachten", "zei", "zeiden", "mening", "standpunt", "reageert", "reageerde", "kritiek", "oordeel", "oordeelt", "adviseert", "adviseerde",
  "rechtspraak", "gesanctioneerd", "gegund", "inkoop", "procurement", "cbs", "cijfers", "rijksoverheid", "nieuws", "toespraak",
  "api", "apis", "apv", "eu", "europese", "europa", "notitie", "onderzoek", "keur", "legger",
  "kost", "kosten", "kostte", "kostten", "gekost", "geld", "begroot", "budget", "uitgaven", "woz", "planning",
  "inwoners", "wetten", "wetgeving", "omgevingsregeling", "bkl", "bal", "bbl", "amvb", "amvbs", "prijs", "prijzen", "vragen", "vraag", "aangenomen", "verworpen",
  "definitie", "betekenis", "betekent", "betekenen", "verschil", "verschillen", "waarom", "why", "wie", "who", "bindend", "moet", "moeten", "bewoners",
]);

/** Word families with the same effect: prefixes, compounds of another document type, permits, the law. */
const DSO_OTHER_ROUTE_WORD_RE = new RegExp(
  "^(?:raads|college|staten|gedeputeerde|wethouder|burgemeester|kamer|parlement|minister|staatssecretaris|fractie|motie|amendement|stemming|agenda|commissie|rekenkamer|ombudsman|vacature|klacht|persbericht|persconferentie|nieuwsbericht" +
    "|bekendmaking|publicatie|uitspra|rechter|rechtbank|rechtszaak|rechtszaken|gerechtshof|bestuursrecht|beroep|bezwaar|jurisprudentie|ecli|vonnis|arrest|tucht|handhav|boete|sanctie|overtreding|beschikking|dwangsom" +
    "|aanbesteding|tender|gunning|marktconsultatie|offerteaanvra|overheidsopdracht|statistiek|dataset|databestand|algoritme|bestemmingsplan|structuurvisie|beleidsregel" +
    "|jaarrekening|financ|investe|belasting|heffing|tarie|leges|inspraak|zienswijze|evaluat|aanvra|melding|invoering|inwerkingtreding|implementatie|overgang|ambtena|medewerker" +
    "|wets|wettelijk|wettekst|instructieregel|juridisch|verplicht|advie|reactie|politie|partij|verkiezing|griffie|commissaris|protest|petitie|referendum" +
    "|bijeenkomst|webinar|cursus|training|opleiding|software|leverancier|applicatie|systeem|storing|omgevingsdienst|staalkaart|modelregel|handreiking" +
    "|informatiepunt|uitleg|voorbeeld|vergelijk|geschiedenis|historie|voortgang|monitor|antwoord|beantwoord|besluitvorming|vaststelling|ingediend" +
    "|toezicht|inspectie|rapport)" +
    "|(?:raad|raden|blad|courant|nota|brief|brieven|avond|wet)$" +
    "|debat|vergader|begroting|subsidie|participatie|vergunning(?!s?vrij|s?plichtig)" +
    "|(?<!omgevings)(?<!waterschaps)verordening(?:en)?$|(?<!voorbereidings)(?<!project)besluit(?:en)?$|(?<!omgevings)programma$|(?<!omgevings)visies?$|(?<!omgevings)plan(?:nen)?$|.(?<!omgevings)document(?:en)?$",
  "u",
);

/** Phrases with the same effect: parliament, data, definitions and how-it-works questions. */
const DSO_OTHER_ROUTE_PHRASE_RE = /(?:^|[^\p{L}])(?:open\s+data|data\s+over|dagelijks\s+bestuur|algemeen\s+bestuur|stand\s+van\s+zaken|b\s*(?:&|en)\s*w|sinds\s+wanneer|in\s+werking\s+(?:getreden|treedt|trad|traden|treden)|wat\s+(?:is|zijn)\s+(?:een|eigenlijk)|wat\s+houdt|wat\s+(?:vind|vindt|vinden|vond|vonden)|wie\s+(?:stelt|stellen|maakt|maken|beslist|beslissen|bepaalt|bepalen|neemt|nemen)|what\s+is\s+an?|how\s+(?:does|do|is|are))(?=$|[^\p{L}])/u;

/** Abbreviations in capitals: Provinciale and Gedeputeerde Staten, associations, agencies. */
const DSO_OTHER_ROUTE_ACRONYM_RE = /(?:^|[^\p{L}])(?:PS|GS|VNG|IPO|IPLO|BZK|RCE|ILT|PBL)(?=$|[^\p{L}])/u;

/** Verbs whose subject must be the document: "Wat zegt het omgevingsplan", not "Wat zegt de VNG over het omgevingsplan". */
const DSO_DOCUMENT_SUBJECT_VERBS = new Set(["zegt", "zeggen", "regelt", "regelen", "schrijft", "schreef", "stelt", "stelde", "doet", "deed", "gaat", "ging", "meldt", "meldde"]);

const DSO_ARTICLES = new Set(["de", "het", "een", "dit", "deze", "dat", "die", "the"]);

/** "Hoe hoog mag ik bouwen" asks for rules; any other "hoe" asks how something works or went. */
const DSO_HOW_RULES = new Set(["hoog", "hoger", "groot", "groter", "diep", "dieper", "breed", "breder", "ver", "verder", "dicht", "high", "big", "tall", "far", "deep", "wide"]);

/** The question's words in lowercase, letters only. */
export function dsoWords(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
}

/** Whether a question belongs to another route (see the word lists above). */
function dsoOtherRoute(text: string): boolean {
  if (DSO_OTHER_ROUTE_ACRONYM_RE.test(text) || COUNCIL_RE.test(text) || DSO_OTHER_ROUTE_PHRASE_RE.test(text.toLowerCase())) return true;
  const words = dsoWords(text);
  const documentFollows = (i: number) => {
    const j = DSO_ARTICLES.has(words[i] ?? "") ? i + 1 : i;
    return DSO_DOCUMENT_TOKEN_RE.test(words[j] ?? "") || DSO_DOCUMENT_TOKEN_RE.test(words[j + 1] ?? "");
  };
  return words.some(
    (w, i) =>
      DSO_OTHER_ROUTE_WORDS.has(w) ||
      DSO_OTHER_ROUTE_WORD_RE.test(w) ||
      ((w === "hoe" || w === "how") && !DSO_HOW_RULES.has(words[i + 1] ?? "")) ||
      (DSO_DOCUMENT_SUBJECT_VERBS.has(w) && !documentFollows(i + 1)),
  );
}

/** documentType per word, for a question that names exactly one kind of document. */
const DSO_TYPE_WORDS: Array<[RegExp, DsoDocumentType]> = [
  [/(?:^|[^\p{L}])omgevingsplan(?:nen)?(?=$|[^\p{L}])/iu, "omgevingsplan"],
  [/(?:^|[^\p{L}])omgevingsvisies?(?=$|[^\p{L}])/iu, "omgevingsvisie"],
  [DSO_NOVI_RE, "omgevingsvisie"],
  [/(?:^|[^\p{L}])omgevingsverordening(?:en)?(?=$|[^\p{L}])/iu, "omgevingsverordening"],
  [/(?:^|[^\p{L}])(?:waterschapsverordening(?:en)?|waterschapsregels)(?=$|[^\p{L}])/iu, "waterschapsverordening"],
  [/(?:^|[^\p{L}])omgevingsprogramma(?:'s|s)?(?=$|[^\p{L}])/iu, "programma"],
  [/(?:^|[^\p{L}])(?:voorbereidingsbesluit(?:en)?|voorbeschermingsregels?)(?=$|[^\p{L}])/iu, "voorbereidingsbesluit"],
  [/(?:^|[^\p{L}])projectbesluit(?:en)?(?=$|[^\p{L}])/iu, "projectbesluit"],
];

const DUTCH_MONTHS: Record<string, number> = {
  januari: 1, jan: 1, februari: 2, feb: 2, maart: 3, mrt: 3, april: 4, apr: 4, mei: 5, juni: 6, jun: 6, juli: 7, jul: 7,
  augustus: 8, aug: 8, september: 9, sep: 9, sept: 9, oktober: 10, okt: 10, november: 11, nov: 11, december: 12, dec: 12,
};

const DSO_STREET_SUFFIXES = "straat|straatweg|laan|weg|plein|gracht|burgwal|kade|singel|baan|dijk|dreef|hof|pad|steeg|markt|park|plantsoen|ring|wal|haven|veld|dam|allee|boulevard|kanaal|erf|zijde|brink|oord|kwartier|plaats";

const DSO_STREET_SUFFIX_RE = new RegExp(`(?:${DSO_STREET_SUFFIXES})$`, "u");

const DSO_STREET_SUFFIX_WORD_RE = new RegExp(`^(?:${DSO_STREET_SUFFIXES})$`, "u");

/** Lowercase words inside a street name: "Van Asch van Wijckstraat", "Weg der Verenigde Naties". */
const DSO_STREET_INFIXES = "van|de|der|den|des|het|['’]t|ter|ten|en";

const DSO_STREET_INFIX_RE = new RegExp(`^(?:${DSO_STREET_INFIXES})$`, "u");

/** Place names that end like a street ("Amsterdam 31 december" is no address). */
const DSO_PLACES_LIKE_STREETS = new Set(["amsterdam", "rotterdam", "schiedam", "zaandam", "edam", "volendam", "monnickendam", "alblasserdam", "leidschendam", "veendam", "moerdijk", "langedijk", "stadskanaal", "barneveld", "westerveld", "noordenveld"]);

/** A house number, but no year: "Omgevingsvisie Amsterdam 2050" and "invoering 2024" are no address. */
const DSO_HOUSE_NUMBER = "(?!(?:19|20)\\d\\d(?![\\d\\p{L}]))\\d{1,5}(?:\\s?[a-zA-Z](?![\\p{L}])|-[\\dA-Za-z]{1,4}(?![\\p{L}\\d]))?";

/**
 * Capitalised words (an ordinal like "1e" or "Tweede" and infixes allowed),
 * then a house number, after a word that introduces an address ("op", "aan",
 * "bij", "voor", "adres") or at the very start. Every other start needs that
 * word and a space, so a long run of name characters is scanned once.
 */
const DSO_ADDRESS_RE = new RegExp(
  `(?:^|[^\\p{L}](?:op|aan|bij|voor|nabij|rond(?:om)?|adres|at)\\s+(?:(?:de|het)\\s+)?)` +
    `((?:(?:\\d{1,2}(?:e|de|ste)|Eerste|Tweede|Derde|Vierde)\\s+)?(?:['’]s-|['’]t\\s+)?[A-ZÀ-Þ][\\p{L}'’.-]*(?:\\s+(?:(?:${DSO_STREET_INFIXES})\\s+)*(?:['’]s-)?[A-ZÀ-Þ][\\p{L}'’.-]*){0,4})` +
    `\\s+(${DSO_HOUSE_NUMBER})(?![\\p{L}\\d])`,
  "dgu",
);

/** Words that open an address phrase at the start of a question ("Op Brennerbaan 150"), not the street. */
const DSO_ADDRESS_LEAD_WORDS = new Set(["op", "aan", "bij", "voor", "nabij", "rond", "rondom", "adres"]);

/** Capitalised words before a number that name no street ("voor Box 3", "op Schiphol Terminal 3"). */
const DSO_NOT_A_STREET = new Set([
  "artikel", "hoofdstuk", "afdeling", "paragraaf", "bijlage", "lid", "natura", "box", "groep", "fase", "categorie", "formule", "euro", "covid", "windkracht",
  "terminal", "rijksmonument", "monument", "sectie", "code", "klasse", "niveau", "zone", "gate", "pier", "versie", "week", "dag", "jaar", "nummer",
]);

/** A number followed by these is a day, a unit or a duration, not a house number. */
const DSO_NOT_AFTER_HOUSE_NUMBER = new Set([
  ...Object.keys(DUTCH_MONTHS),
  "uur", "uren", "minuut", "minuten", "dag", "dagen", "week", "weken", "maand", "maanden", "jaar", "jaren", "meter", "m", "km", "cm", "mm",
  "kilo", "kg", "gram", "ton", "liter", "procent", "euro", "mw", "kw", "kwh", "gw", "db", "graden", "keer", "stuks", "personen", "mensen",
]);

/** A Dutch postcode, letters in capitals ("2026 de" is no postcode). */
const DSO_POSTCODE_RE = /(?:^|[^\p{L}\d])([1-9]\d{3})\s?(?!SA|SD|SS)([A-Z]{2})(?![\p{L}\d])/dgu;

/** Two capitals after a number that are a unit or a country, not postcode letters ("1000 MW", "3500 KG"). */
const DSO_POSTCODE_UNITS = new Set(["MW", "KW", "KG", "GW", "GB", "MB", "TB", "KB", "PJ", "TJ", "GJ", "MJ", "KV", "KM", "CM", "MM", "HA", "PK", "CC", "ML", "CL", "DL", "MG", "KJ", "EU", "NL", "US", "UK", "VS"]);

/** What may stand right before a postcode for it to be one: "op 3524 BN", "postcode 3524 BN", "adres: 3524 BN". */
const DSO_BEFORE_POSTCODE_RE = /(?:^|[^\p{L}])(?:op|aan|bij|voor|nabij|postcode|adres|at)\s*:?\s*$|,\s*$/iu;

const DSO_POSTCODE_AFTER_RE = /\s*,?\s*([1-9]\d{3})\s?(?!SA|SD|SS)([A-Z]{2})(?![\p{L}\d])/uy;

const DSO_NUMBER_AFTER_RE = /\s*,?\s*(\d{1,5}(?:\s?[a-zA-Z](?![\p{L}]))?)(?![\p{L}\d])/uy;

/** The place written behind an address: ", Utrecht", " te Utrecht", " in (de gemeente) Utrecht", " (Utrecht)", " Utrecht". */
const DSO_PLACE_AFTER_RE = new RegExp(`(?:\\s*,\\s*|\\s+te\\s+|\\s+in\\s+(?:de\\s+gemeente\\s+)?|\\s*\\(\\s*|\\s+)(${PLACE_CORE})`, "uy");

/** "provincie Utrecht", "Hoogheemraadschap De Stichtse Rijnlanden", "gemeente Utrecht". */
const DSO_BODY_RE = new RegExp(`(?:^|[^\\p{L}])((?:[Gg]emeente|[Pp]rovincie|[Ww]aterschap|[Hh]oogheemraadschap(?:\\s+van)?|[Ww]etterskip)\\s+${PLACE_CORE})`, "du");

/** "province of Utrecht", "municipality of Ede". */
const DSO_ENGLISH_BODY_RE = new RegExp(`(?:^|[^\\p{L}])([Pp]rovince|[Mm]unicipality)\\s+of\\s+(?:the\\s+)?(${PLACE_CORE})`, "du");

/** "in de provincie Utrecht", "in the province of Utrecht": an area, not the provincie as the body that adopts. */
const DSO_PROVINCE_AREA_RE = new RegExp(`(?:^|[^\\p{L}])(?:in|binnen)\\s+(?:de\\s+|the\\s+)?(?:[Pp]rovincie|[Pp]rovince\\s+of)\\s+(${PLACE_CORE})`, "du");

const DSO_IN_PLACE_RE = new RegExp(`(?:^|[^\\p{L}])in\\s+(${PLACE_CORE})`, "du");

/**
 * The place right after a document word: "omgevingsplan Utrecht", "Omgevingsvisie
 * van Amsterdam", "the omgevingsplan of Groningen", "het omgevingsplan voor Utrecht".
 */
const DSO_DOCUMENT_PLACE_RE = new RegExp(`(?:^|[^\\p{L}])(?:${DSO_DOCUMENT_NOUNS_CASED})\\s+(?:([Vv]an|[Vv]oor|of|for)\\s+(?:de\\s+|het\\s+|the\\s+)?)?(${PLACE_CORE})`, "du");

/** The place before the document word: "Utrecht omgevingsplan" at the start, "the Utrecht omgevingsplan". */
const DSO_PLACE_DOCUMENT_RE = new RegExp(`(?:^|[^\\p{L}]the\\s+)(${PLACE_CORE})\\s+(?:${DSO_DOCUMENT_NOUNS_CASED})(?=$|[^\\p{L}])`, "du");

/** "heeft Utrecht", "geldt voor Rotterdam", "gelden er voor Ede". */
const DSO_VERB_PLACE_RE = new RegExp(`(?:^|[^\\p{L}])(?:[Hh]eeft|[Hh]ebben|geldt|gelden|gold|golden)\\s+(?:er\\s+)?(?:voor\\s+)?(${PLACE_CORE})`, "du");

/** "in het centrum van Utrecht": any "van <Place>", the last resort. */
const DSO_OF_PLACE_RE = new RegExp(`(?:^|[^\\p{L}])van\\s+(?:de\\s+|het\\s+)?(${PLACE_CORE})`, "du");

/** "Welke omgevingsplannen gelden er op Schiphol?": a place without a number, as a point. */
const DSO_AT_PLACE_RE = new RegExp(`(?:^|[^\\p{L}])op\\s+(${PLACE_CORE})\\s*[?.!]?\\s*$`, "du");

/** A place in a question typed in lowercase: after "gemeente", "provincie", "van", "in" or a document word. */
const DSO_LOWER_PLACE = "(?:(?:den|['’]s-|['’]t)\\s*)?\\p{Ll}[\\p{Ll}'’-]+(?:\\s+(?:aan|op|bij|en)\\s+\\p{Ll}[\\p{Ll}'’-]+)?";

const DSO_LOWER_BODY_RE = new RegExp(`(?:^|[^\\p{L}])(gemeente|provincie|waterschap)\\s+(${DSO_LOWER_PLACE})`, "du");

const DSO_LOWER_PLACE_RE = new RegExp(`(?:^|[^\\p{L}])(?:(?:${DSO_DOCUMENT_NOUNS_CASED})\\s+(?:van\\s+|of\\s+)?|in\\s+)(${DSO_LOWER_PLACE})(?=\\s*(?:[?.!,]|over\\b|voor\\b|\\d|$))`, "du");

/** Lowercase words that are no place after those cues. */
const DSO_LOWER_NOT_A_PLACE = new Set([
  "de", "het", "een", "die", "dat", "deze", "dit", "mijn", "onze", "uw", "alle", "elke", "welke", "wat", "regels", "regel", "over", "voor", "met", "zonder",
  "heel", "nationale", "rijk", "nu", "er", "hier", "daar", "toepassing", "werking", "kracht", "inzage", "ontwerp", "ontwerpen", "gemeente", "provincie",
  "waterschap", "buurt", "wijk", "centrum", "stad", "dorp", "totaal", "principe", "feite", "gebruik", "voorbereiding", "ontwikkeling", "belang", "geval",
  "kaart", "praktijk", "algemeen", "wijzigen", "gewijzigd", "vastgesteld", "zien", "vinden", "bouwen",
]);

/** Words that open a question or describe a document: no place, also when capitalised before a document word. */
const DSO_NOT_A_PLACE_START = new Set([
  "welke", "welk", "wat", "wie", "waar", "wanneer", "hoe", "hoeveel", "is", "zijn", "heeft", "hebben", "toon", "geef", "laat", "lees", "zoek", "mag", "kan",
  "geldt", "gelden", "ligt", "liggen", "wordt", "de", "het", "een", "nieuwste", "nieuwe", "recente", "recentste", "laatste", "alle", "nationale", "ontwerp",
  "ontwerpen", "gemeentelijke", "provinciale", "huidige", "oude", "geldende", "actuele", "vigerende", "which", "what", "show", "the", "all", "list", "mijn",
  "onze", "uw", "dit", "deze", "die", "elk", "elke",
]);

/** Words a place name cannot hold: it ends before them ("provincie Gelderland de Omgevingswet"). */
const DSO_NOT_A_PLACE_WORD_RE = new RegExp(`^(?:\\p{L}*wet|${DSO_DOCUMENT_NOUNS.join("|")}|raad|staten|kamer|regels?|artikel|hoofdstuk|afdeling|paragraaf|bijlage|novi|dso)$`, "iu");

/** English names of places the DSO knows in Dutch. */
const DSO_ENGLISH_PLACES: Record<string, string> = { "north holland": "Noord-Holland", "south holland": "Zuid-Holland", "north brabant": "Noord-Brabant", "the hague": "Den Haag", frisia: "Fryslân" };

/** Provincie names no gemeente shares: "in Noord-Holland" is an area like "in de provincie Noord-Holland". */
const DSO_PROVINCES = new Set(["noord-holland", "zuid-holland", "noord-brabant", "brabant", "gelderland", "overijssel", "drenthe", "friesland", "fryslân", "flevoland", "limburg", "zeeland"]);

/** Capitalised words that name no place: an unscoped list question with any other capitalised word is not answered nationwide. */
const DSO_NOT_A_PLACE_CAPITAL = new RegExp(`^(?:${DSO_DOCUMENT_NOUNS.join("|")}|novi|dso|rijk|nationale|nederland|europa|regels|kaart|omgevingswet|ontwerp\\p{L}*)$`, "iu");

/** A body or place the question names ("gemeente Utrecht", "Utrecht"), and where it stands in the question. */
interface DsoPlaceHit {
  name: string;
  start: number;
  end: number;
}

/** A place cut where it runs on into the question ("Gelderland de Omgevingswet"), English names in Dutch, no country. */
function dsoPlace(captured: string | undefined, start: number): DsoPlaceHit | undefined {
  const words = (captured ?? "").replace(/[?.,;:!)]+$/, "").split(/\s+/).filter(Boolean);
  if (!words.length || DSO_NOT_A_PLACE_WORD_RE.test(words[0])) return undefined;
  let end = words.findIndex((w, i) => i > 0 && DSO_NOT_A_PLACE_WORD_RE.test(w));
  if (end < 0) end = words.length;
  while (end > 1 && PLACE_INFIX_WORDS.has(words[end - 1].toLowerCase())) end--;
  const place = words.slice(0, end).join(" ");
  if (place.length < 2 || /^(?:nederland|europa|eu|(?:the\s+)?netherlands)$/i.test(place)) return undefined;
  return { name: DSO_ENGLISH_PLACES[place.toLowerCase()] ?? place, start, end: start + place.length };
}

/** The place in a pattern's capture group (the pattern has the "d" flag). */
function dsoPlaceIn(re: RegExp, text: string, group = 1): DsoPlaceHit | undefined {
  const m = re.exec(text);
  return m?.[group] && m.indices?.[group] ? dsoPlace(m[group], m.indices[group][0]) : undefined;
}

/** A place in a lowercase question, unless it is a common word after the same cue ("in werking", "van toepassing"). */
function dsoLowerPlaceIn(re: RegExp, text: string, group: number): DsoPlaceHit | undefined {
  const hit = dsoPlaceIn(re, text, group);
  return hit && !hit.name.split(/\s+/).some((w) => DSO_LOWER_NOT_A_PLACE.has(w)) ? hit : undefined;
}

/** Replace a span by "§", so the checks after it neither read it nor join words across it. */
function dsoMask(text: string, hit: { start: number; end: number } | undefined): string {
  return hit ? text.slice(0, hit.start) + "§".repeat(Math.max(0, hit.end - hit.start)) + text.slice(hit.end) : text;
}

interface DsoAddressHit {
  /** As the search's locatie takes it: "Brennerbaan 150, Utrecht", "3524 BN 150". */
  locatie: string;
  /** A street with a street ending, or with a postcode, or a postcode; else only capitalised words before a number. */
  strict: boolean;
  /** A place or postcode is written behind it. */
  hasPlace: boolean;
  start: number;
  end: number;
}

/** The postcode, or the place, written behind an address that ends at `end`. */
function dsoAfterAddress(text: string, end: number): { place?: string; postcode?: string; end: number } {
  DSO_POSTCODE_AFTER_RE.lastIndex = end;
  const pc = DSO_POSTCODE_AFTER_RE.exec(text);
  const postcode = pc && !DSO_POSTCODE_UNITS.has(pc[2]) ? `${pc[1]} ${pc[2]}` : undefined;
  if (postcode) end = DSO_POSTCODE_AFTER_RE.lastIndex;
  DSO_PLACE_AFTER_RE.lastIndex = end;
  const m = DSO_PLACE_AFTER_RE.exec(text);
  const place = m ? dsoPlace(m[1], DSO_PLACE_AFTER_RE.lastIndex - m[1].length) : undefined;
  return { postcode, place: place?.name, end: place?.end ?? end };
}

/**
 * The address a question names: a street that ends like one ("Brennerbaan",
 * "Grote Markt", "Laan van Meerdervoort") with a house number, or a postcode
 * after "op", "postcode" or "adres", each with the place or postcode written
 * behind it. Without a street suffix only capitalised words and a number
 * with a place behind them, which counts only next to a document word.
 */
function dsoAddress(text: string): DsoAddressHit | undefined {
  let lenient: DsoAddressHit | undefined;
  for (const m of text.matchAll(DSO_ADDRESS_RE)) {
    let [start] = m.indices![1];
    const numberEnd = m.indices![2][1];
    const words = m[1].split(/\s+/);
    // "Op Brennerbaan 150" at the start: the word opens the address, it is no part of the street.
    const led = words.length > 1 && DSO_ADDRESS_LEAD_WORDS.has(words[0].toLowerCase());
    if (led) start += words.shift()!.length + 1;
    const next = /^\s*([\p{L}%]+)/u.exec(text.slice(numberEnd, numberEnd + 24))?.[1]?.toLowerCase();
    if (next && DSO_NOT_AFTER_HOUSE_NUMBER.has(next)) continue;
    const head = words.find((w) => /^\p{Lu}/u.test(w) && !/^(?:Eerste|Tweede|Derde|Vierde)$/.test(w))?.toLowerCase() ?? "";
    if (DSO_NOT_A_STREET.has(head)) continue;
    const after = dsoAfterAddress(text, numberEnd);
    const hit: DsoAddressHit = {
      locatie: [`${words.join(" ")} ${m[2]}`, after.postcode ?? after.place].filter(Boolean).join(", "),
      strict: dsoStrictStreet(words) || Boolean(after.postcode),
      hasPlace: Boolean(after.postcode ?? after.place),
      start,
      end: after.end,
    };
    if (hit.strict) return hit;
    // Without a street ending: after "op", "voor" and the like, and with a place behind it.
    if (!lenient && after.place && (m.indices![1][0] > 0 || led)) lenient = hit;
  }
  for (const m of text.matchAll(DSO_POSTCODE_RE)) {
    if (DSO_POSTCODE_UNITS.has(m[2])) continue;
    const [start, end] = [m.indices![1][0], m.indices![2][1]];
    DSO_NUMBER_AFTER_RE.lastIndex = end;
    const number = DSO_NUMBER_AFTER_RE.exec(text);
    if (!number && !DSO_BEFORE_POSTCODE_RE.test(text.slice(Math.max(0, start - 12), start))) continue;
    const after = dsoAfterAddress(text, number ? DSO_NUMBER_AFTER_RE.lastIndex : end);
    return { locatie: [`${m[1]} ${m[2]}`, number?.[1]].filter(Boolean).join(" "), strict: true, hasPlace: true, start, end: after.end };
  }
  return lenient;
}

/**
 * A street name: its last word ends like a street and is more than the
 * ending ("Brennerbaan", "'s-Gravendijkwal"); or the bare ending after
 * another capitalised word ("Grote Markt"); or a street word opening the
 * name ("Laan van Meerdervoort", "Weg der Verenigde Naties"). Not "Ring 10",
 * "de Dam 4 mei" or "Amsterdam 31".
 */
function dsoStrictStreet(words: string[]): boolean {
  const named = words.filter((w) => !/^\d/.test(w));
  const capitals = named.filter((w) => /^(?:\p{Lu}|['’]s-)/u.test(w)).length;
  const last = (named[named.length - 1] ?? "").toLowerCase().replace(/^['’]s-/, "");
  const suffix = DSO_STREET_SUFFIX_RE.exec(last)?.[0];
  if (suffix) return last.length > suffix.length ? !DSO_PLACES_LIKE_STREETS.has(last) : capitals >= 2;
  return named.length >= 3 && DSO_STREET_SUFFIX_WORD_RE.test(named[0].toLowerCase()) && DSO_STREET_INFIX_RE.test(named[1]);
}

/** The question's words outside the masked spans, all from the given sets. */
function dsoOnlyWords(text: string, ...allowed: ReadonlySet<string>[]): boolean {
  return dsoWords(text).every((w) => allowed.some((set) => set.has(w)));
}

/** Words a question about the rules at an address may hold besides the address and its place. */
const DSO_ADDRESS_QUESTION_WORDS = new Set([
  ...Object.keys(DUTCH_MONTHS),
  "welke", "welk", "wat", "zijn", "is", "er", "zit", "zitten", "de", "het", "een", "op", "aan", "bij", "voor", "nabij", "rond", "rondom", "in", "te", "ter", "van",
  "en", "of", "ook", "nu", "hier", "daar", "dit", "deze", "die", "dat", "mijn", "ons", "onze", "me", "mij", "ik", "je", "u", "men", "we", "wij", "nog", "al",
  "alle", "allemaal", "precies", "eigenlijk", "graag", "toon", "laat", "zien", "geef", "noem", "lijst", "overzicht", "gelden", "geldt", "golden", "gold",
  "geldig", "geldende", "actuele", "huidige", "toepassing", "momenteel", "vandaag", "per", "vanaf", "tot", "sindsdien", "bijgekomen", "gewijzigd", "veranderd",
  "nieuw", "nieuwe", "adres", "postcode", "huisnummer", "locatie", "perceel", "kavel", "pand", "huis", "woning", "tuin", "achtertuin", "voortuin", "plek",
  "grond", "terrein", "onder",
  "rijk", "gemeente", "provincie", "waterschap", "gemeentelijke", "provinciale", "kan", "kun", "kunt", "kunnen", "hoe", "hoog", "hoger", "groot", "groter",
  "diep", "breed", "ver", "which", "what", "are", "the", "at", "on", "for", "there", "my", "to", "can", "apply", "applies",
]);

/** Rule words: "Welke regels gelden op <adres>". */
const DSO_ADDRESS_RULE_WORDS = new Set(["regels", "regel", "regelgeving", "regelingen", "regeling", "omgevingsregels", "omgevingsplanregels", "waterschapsregels", "bouwregels", "rules", "regulations", "zoning"]);

/** Permission words: "Mag ik een dakkapel plaatsen op <adres>", with a building topic. */
const DSO_ADDRESS_PERMISSION_WORDS = new Set(["mag", "mogen", "toegestaan", "verboden", "vergunningvrij", "vergunningsvrij", "vergunningplichtig", "vergunningsplichtig", "allowed"]);

/** What one builds or changes on a plot: the topics of an omgevingsplan and the Bbl. */
const DSO_BUILDING_TOPICS = new Set([
  "bouwen", "bouw", "verbouwen", "bijbouwen", "plaatsen", "maken", "aanleggen", "neerzetten", "zetten", "slopen", "sloop", "kappen", "vellen", "splitsen",
  "dakkapel", "dakkapellen", "aanbouw", "uitbouw", "opbouw", "dakopbouw", "optopping", "bijgebouw", "bijgebouwen", "bijbehorend", "bijbehorende", "bouwwerk",
  "bouwwerken", "schuur", "schuurtje", "schutting", "erfafscheiding", "hek", "hekwerk", "tuinhuis", "tuinhuisje", "blokhut", "carport", "overkapping", "veranda",
  "serre", "uitrit", "inrit", "boom", "bomen", "zonnepanelen", "dakterras", "balkon", "gevel", "kozijnen", "airco", "warmtepomp", "bed", "and", "breakfast", "b",
  "mantelzorgwoning", "woningsplitsing", "bouwhoogte", "goothoogte", "hoogte", "bouwvlak", "bestemming", "functie", "gebruik", "wonen", "build", "extension",
]);

/** Words a question for the ontwerpen ter inzage of a body or place may hold besides that name. */
const DSO_ONTWERP_QUESTION_WORDS = new Set([
  ...Object.keys(DUTCH_MONTHS),
  "welke", "welk", "wat", "zijn", "is", "er", "liggen", "ligt", "lagen", "lag", "nu", "momenteel", "op", "dit", "moment", "ter", "inzage", "ontwerp",
  "ontwerpen", "de", "het", "een", "in", "bij", "van", "alle", "nog", "toon", "geef", "overzicht", "lijst", "recent", "recente", "nieuwste", "laatste", "open",
  "zie", "zien", "laat", "kan", "ik", "gemeente", "provincie", "waterschap", "hoogheemraadschap", "wetterskip", "vandaag",
]);

/** "ontwerp" or "ontwerpen" as a word of its own: "ontwerpbegroting" and "wetsontwerp" are other documents. */
const DSO_ONTWERP_WORD_RE = /(?:^|[^\p{L}-])ontwerp(?:en)?(?=$|[^\p{L}-])/iu;

const DSO_TER_INZAGE_RE = /\bter\s+inzage\b|\binzagetermijn(?:en)?\b/i;

/** "de Nationale Omgevingsvisie", "de programma's van het Rijk": the Rijk's documents (bevoegd gezag type ministerie). */
const DSO_RIJK_RE = /(?:^|[^\p{L}])(?:nationale|het\s+rijk)(?=$|[^\p{L}])/iu;

const DSO_APPLY_RE = /(?:^|[^\p{L}])(?:gelden|geldt|golden|gold|van\s+toepassing)(?=$|[^\p{L}])/iu;

const DSO_RECENT_RE = /(?:^|[^\p{L}])(?:nieuwste|recentste|recente?|laatste|onlangs|net\s+(?:gepubliceerd|vastgesteld))(?=$|[^\p{L}])/iu;

/** "gelden op 1 januari 2025": the day the question asks the rules for (geldigOp). */
const DSO_VALIDITY_RE = /(?:^|[^\p{L}])(?:gelden|geldt|golden|gold|geldig|van\s+kracht|in\s+werking)(?=$|[^\p{L}])/iu;

/** The calendar days a question names: "1 januari 2025", "2025-01-01", "1-1-2025". */
function explicitDays(text: string): string[] {
  const days = new Set<string>();
  const add = (y: number, m: number, d: number) => {
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d) days.add(date.toISOString().slice(0, 10));
  };
  for (const m of text.matchAll(/(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g)) add(Number(m[1]), Number(m[2]), Number(m[3]));
  for (const m of text.matchAll(/(?<![\d/-])(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?![\d/-])/g)) add(Number(m[3]), Number(m[2]), Number(m[1]));
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})\s+(\p{L}+)\.?\s+(\d{4})(?!\d)/gu)) {
    const month = DUTCH_MONTHS[m[2].toLowerCase()];
    if (month) add(Number(m[3]), month, Number(m[1]));
  }
  return [...days];
}

/** What nl_gov_ask passes to dso_omgevingsdocumenten_search; the field names are the search's own. */
export type DsoIntent = Pick<DsoSearchArgs, "locatie" | "bevoegdGezag" | "typeBevoegdGezag" | "documentType" | "soort" | "alleenTerInzage" | "geldigOp"> & {
  /** An area: the provincie's own documents and those of every gemeente in it (the search's `provincie`). */
  provincie?: string;
};

/**
 * A question about Omgevingswet documents, for the DSO. Precision first: a
 * question another route answered before the DSO route keeps that route.
 *  - It names a document (omgevingsplan, omgevingsvisie, omgevingsverordening,
 *    waterschapsverordening, omgevingsprogramma, omgevingsdocument,
 *    voorbereidingsbesluit, voorbeschermingsregels, projectbesluit,
 *    ontwerpregeling, "regels op de kaart", NOVI) with a scope (address,
 *    place, body, provincie area, the Rijk), or asks for a list or the
 *    newest, or for ontwerpen;
 *  - or it asks which rules apply at an address (a street with a street
 *    ending and a house number, or a postcode), with nothing but rule,
 *    permission and building words besides ("Welke regels gelden op
 *    Brennerbaan 150, Utrecht?", "Mag ik een dakkapel plaatsen op ...");
 *  - or it asks for the ontwerpen ter inzage of a named gemeente, provincie,
 *    waterschap or place, and for nothing else.
 * Never: a question longer than DSO_QUESTION_MAX_CHARS; a question about the
 * law, a definition or how something works; one about money, procedures,
 * participation, the council, Staten, parliament or government; one that
 * names another source or another kind of document (dsoOtherRoute).
 *
 * Where: an address becomes `locatie` with the place or postcode written
 * behind it (or "in Utrecht" elsewhere); "in de provincie X", or "in
 * Noord-Holland", asking for ontwerpen, all documents or omgevingsplannen is
 * the area `provincie`; a verordening "in <gemeente>" is the point there;
 * otherwise the body or place the question names is `bevoegdGezag`. What:
 * documentType when the question names one kind; "ontwerp" or "ter inzage"
 * asks for ontwerpregelingen; a day the rules "gelden op" is geldigOp.
 * `maxChars` is for tests that time the detector on long input.
 */
export function detectDsoIntent(question: string, maxChars = DSO_QUESTION_MAX_CHARS): DsoIntent | undefined {
  const text = String(question ?? "");
  if (text.length > maxChars) return undefined;
  const raw = text.replace(/\s+/g, " ").trim();
  if (!raw) return undefined;

  // The address and the neutral qualifiers are read first and masked, so a
  // street name ("Burgemeester Reigerstraat") is no council word below.
  const neutral = raw.replace(DSO_NEUTRAL_PHRASE_RE, (m) => "§".repeat(m.length));
  const address = dsoAddress(neutral);
  let masked = dsoMask(neutral, address);
  if (dsoOtherRoute(masked)) return undefined;

  const documentWords = DSO_DOCUMENT_WORDS_RE.test(masked) || DSO_NOVI_RE.test(masked);
  const terInzage = DSO_TER_INZAGE_RE.test(masked);
  const ontwerp = terInzage || /(?:^|[^\p{L}])ontwerp/iu.test(masked);
  const types = [...new Set(DSO_TYPE_WORDS.filter(([re]) => re.test(masked)).map(([, type]) => type))];
  const documentType = types.length === 1 ? types[0] : undefined;
  const plural = DSO_PLURAL_DOCUMENT_RE.test(masked);
  const lowercase = !/\p{Lu}/u.test(raw.slice(1));

  // Bodies and places, each masked once read.
  const english = DSO_ENGLISH_BODY_RE.exec(masked);
  const englishBody = english?.indices?.[2] ? dsoPlace(english[2], english.indices[2][0]) : undefined;
  const lowerBody = lowercase ? DSO_LOWER_BODY_RE.exec(masked) : null;
  const lowerBodyPlace = lowerBody ? dsoLowerPlaceIn(DSO_LOWER_BODY_RE, masked, 2) : undefined;
  const body =
    dsoPlaceIn(DSO_BODY_RE, masked) ??
    (englishBody && english ? { ...englishBody, name: `${/^p/i.test(english[1]) ? "provincie" : "gemeente"} ${englishBody.name}` } : undefined) ??
    (lowerBodyPlace && lowerBody ? { ...lowerBodyPlace, name: `${lowerBody[1]} ${lowerBodyPlace.name}` } : undefined);
  const area = dsoPlaceIn(DSO_PROVINCE_AREA_RE, masked);
  masked = dsoMask(dsoMask(masked, area), body);
  const documentPlace = DSO_DOCUMENT_PLACE_RE.exec(masked);
  const nextTo = documentPlace?.indices?.[2] ? dsoPlace(documentPlace[2], documentPlace.indices[2][0]) : undefined;
  // "het omgevingsplan voor Utrecht" yields to "in": "een voorbereidingsbesluit voor Lunetten in Utrecht".
  const forPlace = /^(?:[Vv]oor|for)$/.test(documentPlace?.[1] ?? "");
  const inPlace = dsoPlaceIn(DSO_IN_PLACE_RE, masked);
  const placeFirst = dsoPlaceIn(DSO_PLACE_DOCUMENT_RE, masked);
  // Without a document word only "in <place>" counts: "gelden voor Airbnb" names no place.
  const place = !documentWords
    ? inPlace
    : ((forPlace ? undefined : nextTo) ??
      inPlace ??
      nextTo ??
      dsoPlaceIn(DSO_VERB_PLACE_RE, masked) ??
      (placeFirst && !DSO_NOT_A_PLACE_START.has(placeFirst.name.split(" ")[0].toLowerCase()) && !/(?:se|sche)$/i.test(placeFirst.name) ? placeFirst : undefined) ??
      dsoPlaceIn(DSO_OF_PLACE_RE, masked) ??
      (lowercase ? dsoLowerPlaceIn(DSO_LOWER_PLACE_RE, masked, 1) : undefined));
  const placeFromIn = Boolean(place && place === inPlace);
  masked = dsoMask(masked, place);

  // Which rules apply at an address, and nothing else.
  const words = dsoWords(masked);
  const ruleWord = words.some((w) => DSO_ADDRESS_RULE_WORDS.has(w));
  const permission = words.some((w) => DSO_ADDRESS_PERMISSION_WORDS.has(w)) && words.some((w) => DSO_BUILDING_TOPICS.has(w));
  const addressRules =
    Boolean(address?.strict) &&
    (ruleWord || permission) &&
    dsoOnlyWords(masked, DSO_ADDRESS_QUESTION_WORDS, DSO_ADDRESS_RULE_WORDS, DSO_ADDRESS_PERMISSION_WORDS, DSO_BUILDING_TOPICS);
  // The ontwerpen ter inzage of a body or place, and nothing else.
  const ontwerpenTerInzage = DSO_ONTWERP_WORD_RE.test(masked) && terInzage && Boolean(body || area || place) && dsoOnlyWords(masked, DSO_ONTWERP_QUESTION_WORDS);
  if (!documentWords && !addressRules && !ontwerpenTerInzage) return undefined;

  // An address keeps its place; without one written behind it, the place the question names elsewhere.
  const addressPlace = address && !address.hasPlace ? (body?.name.replace(/^gemeente\s+/i, "") ?? place?.name) : undefined;
  const verordeningHere =
    placeFromIn && !body && (documentType === "waterschapsverordening" || (documentType === "omgevingsverordening" && !DSO_PROVINCES.has(place!.name.toLowerCase())));
  const locatie =
    address && (address.strict || documentWords)
      ? [address.locatie, addressPlace].filter(Boolean).join(", ")
      : // A verordening "in Amersfoort" is the one that applies there, not the gemeente's own (none).
        documentWords && verordeningHere
        ? place!.name
        : // "Welke omgevingsplannen gelden er op Schiphol?": the point.
          documentWords && !body && !place && !area && DSO_APPLY_RE.test(masked)
          ? dsoPlaceIn(DSO_AT_PLACE_RE, masked)?.name
          : undefined;

  // "in de provincie Utrecht" is an area when the question asks for ontwerpen,
  // for documents of every kind or in the plural, or for omgevingsplannen,
  // which only gemeenten adopt ("provincie Utrecht" + omgevingsplan is one
  // too); so is a provincie's own name "in Noord-Holland". "de omgevingsvisie
  // van de provincie Utrecht" is the provincie's own.
  const areaWanted = ontwerp || !documentType || documentType === "omgevingsplan" || plural;
  const provincieBody = body && /^provincie\s/i.test(body.name) ? body.name.replace(/^provincie\s+/i, "") : undefined;
  const provinceNamed = place && !body && DSO_PROVINCES.has(place.name.toLowerCase()) ? place.name : undefined;
  const provincie = locatie
    ? undefined
    : area && areaWanted
      ? area.name
      : provincieBody && documentType === "omgevingsplan"
        ? provincieBody
        : provinceNamed && (documentType === "omgevingsplan" || (placeFromIn && areaWanted))
          ? provinceNamed
          : undefined;
  const bevoegdGezag = locatie || provincie ? undefined : (body?.name ?? place?.name ?? (area ? `provincie ${area.name}` : undefined));
  const typeBevoegdGezag = locatie || bevoegdGezag || provincie
    ? undefined
    : /\b(?:gemeenten|gemeentes)\b/i.test(masked)
      ? "gemeente"
      : /\bprovincies\b/i.test(masked)
        ? "provincie"
        : /\bwaterschappen\b/i.test(masked)
          ? "waterschap"
          : DSO_RIJK_RE.test(masked) || DSO_NOVI_RE.test(masked)
            ? "ministerie"
            : undefined;
  // Only a single day the rules "gelden op"; a year or a period stays today's list (the route says so).
  const days = !ontwerp && DSO_VALIDITY_RE.test(masked) ? explicitDays(raw) : [];
  const geldigOp = days.length === 1 ? days[0] : undefined;

  if (!locatie && !bevoegdGezag && !provincie && !typeBevoegdGezag) {
    // Nowhere: only a list, the newest documents or ontwerpen, and not when a
    // capitalised word that may be a place went unread ("Omgevingsplan Artikel 22").
    const list = (plural && DSO_LIST_RE.test(masked)) || DSO_RECENT_RE.test(masked) || ontwerp;
    const unread = raw
      .split(/[^\p{L}'’-]+/u)
      .slice(1)
      .some((w) => /^\p{Lu}/u.test(w) && !w.split("-").some((part) => DSO_NOT_A_PLACE_CAPITAL.test(part.replace(/['’]s$/, ""))));
    if (!list || unread) return undefined;
  }
  return {
    ...(locatie ? { locatie } : {}),
    ...(bevoegdGezag ? { bevoegdGezag } : {}),
    ...(provincie ? { provincie } : {}),
    ...(typeBevoegdGezag ? { typeBevoegdGezag } : {}),
    ...(documentType ? { documentType } : {}),
    ...(ontwerp ? { soort: "ontwerpregelingen" as const } : {}),
    ...(terInzage ? { alleenTerInzage: true } : {}),
    ...(geldigOp ? { geldigOp } : {}),
  };
}

/**
 * Keyword terms as a query for the sources that read quoted phrases: ORI
 * (Elasticsearch query_string), Tweede Kamer (parseTkQuery matches a quoted
 * term as a whole phrase) and Officiële Bekendmakingen (freeTextCqlPlan keeps
 * a quoted phrase). Multi-word terms (names, quoted phrases, "open data
 * portaal") become phrases; unquoted, each source made every word a term of
 * its own, so "open data portaal" matched any document with "data" in it.
 *
 * A term in `loose` goes as its words: a run of capitalised words that the
 * keywords grouped into one term (extractKeywordTerms kind "name") is often
 * no phrase in the documents. Tweede Kamer and Officiële Bekendmakingen AND
 * every word, and "Schiphol Geluidsoverlast" or "Wet Kwaliteitsborging
 * Bouwen" as a phrase found nothing or unrelated publications.
 */
export function toPhraseQuery(terms: string[], loose: ReadonlySet<string> = new Set()): string {
  return terms.map((t) => (t.includes(" ") && !loose.has(t) ? `"${t.replace(/"/g, "")}"` : t)).join(" ");
}

/** Keyword terms as an Elasticsearch query_string for ORI, see {@link toPhraseQuery}. */
export function toOriQuery(terms: string[]): string {
  return toPhraseQuery(terms);
}

/**
 * A municipality as a national ORI search names it: a phrase. A loose town
 * name that is also a common word matched unrelated text (Kampen: the verb
 * "kampen met", and "kamp" through stemming), and a one-word name in
 * quotes is still that one stemmed word, so it is bound to "gemeente". A
 * longer name ("Bergen op Zoom") is a phrase of its own.
 */
export function oriPlacePhrase(place: string): string {
  const name = place.replace(/"/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  return /\s/.test(name) ? `"${name}"` : `"gemeente ${name}"`;
}

/* ------------------------------------------------------------------ */
/*  Rulings by ECLI, articles of national laws, research bodies and   */
/*  the population of a municipality                                   */
/* ------------------------------------------------------------------ */

/** ECLI:<land>:<gerecht>:<jaar>:<volgnummer>, as rechtspraak.ts reads one. */
const ECLI_IN_QUESTION_RE = /ECLI:[A-Z]{2}:[A-Z0-9]{1,7}:\d{4}:[A-Z0-9.]{1,25}/g;

/** At most this many rulings of one question are read. */
export const ECLI_QUESTION_MAX = 5;

export interface EcliIntent {
  /** The Dutch ECLIs of the question, at most {@link ECLI_QUESTION_MAX}, in order. */
  eclis: string[];
  /** Dutch ECLIs past the maximum: named, not read. */
  skipped: string[];
  /** ECLIs of other countries or the EU, which Rechtspraak.nl does not publish. */
  foreign: string[];
  /** The question asks for the rulings that cite it ("Uitspraken die verwijzen naar ECLI:..."): LiDO lists those. */
  citations?: true;
}

/** Parliamentary papers about a ruling ("Kamervragen over ECLI:NL:HR:2019:2006"): the Tweede Kamer route's. */
const ECLI_OTHER_SOURCE_RE = /(?:^|[^\p{L}])(?:kamervra\p{L}*|kamerstuk\p{L}*|kamerbrie\p{L}*|moties?|amendement\p{L}*|\p{L}*debat\p{L}*|tweede\s+kamer|eerste\s+kamer|wetsvoorstel\p{L}*)(?=$|[^\p{L}])/iu;
/** Rulings or documents that cite the ruling, not the ruling itself. */
const ECLI_CITATIONS_RE = /(?:^|[^\p{L}])(?:verwijz\p{L}*|verwezen|verwijst|citeer\p{L}*|citeren|geciteerd|aangehaald|aanhalen|cited|citing)(?=$|[^\p{L}])/iu;

/**
 * The rulings a question names by ECLI ("Wat besliste de Hoge Raad in
 * ECLI:NL:HR:2019:2006?"), also in a uitspraken.rechtspraak.nl link: they are
 * read by ECLI, never searched with the ECLI taken apart into words. Only a
 * Dutch ECLI makes the intent.
 */
export function detectEcliIntent(question: string): EcliIntent | undefined {
  let text = String(question ?? "");
  try {
    text = decodeURIComponent(text);
  } catch {
    // Not %-encoded after all.
  }
  const found = [...new Set([...text.toUpperCase().matchAll(ECLI_IN_QUESTION_RE)].map((m) => m[0].replace(/\.+$/, "")))];
  const dutch = found.filter((e) => e.startsWith("ECLI:NL:"));
  if (!dutch.length || ECLI_OTHER_SOURCE_RE.test(text)) return undefined;
  return {
    eclis: dutch.slice(0, ECLI_QUESTION_MAX),
    skipped: dutch.slice(ECLI_QUESTION_MAX),
    foreign: found.filter((e) => !e.startsWith("ECLI:NL:")),
    ...(ECLI_CITATIONS_RE.test(text) ? { citations: true } : {}),
  };
}

/**
 * The ECLIs of a question that names only rulings of other countries or the EU
 * ("ECLI:EU:C:2014:317"), or undefined. Rechtspraak.nl publishes ECLI:NL only:
 * its search would take the ECLI apart into words ("eu c 2014 317") and find
 * Dutch rulings with those numbers. Next to Kamerstukken it is their topic, as
 * with a Dutch ECLI.
 */
export function detectForeignEcliIntent(question: string): string[] | undefined {
  let text = String(question ?? "");
  try {
    text = decodeURIComponent(text);
  } catch {
    // Not %-encoded after all.
  }
  const found = [...new Set([...text.toUpperCase().matchAll(ECLI_IN_QUESTION_RE)].map((m) => m[0].replace(/\.+$/, "")))];
  if (!found.length || found.some((e) => e.startsWith("ECLI:NL:")) || ECLI_OTHER_SOURCE_RE.test(text)) return undefined;
  return found;
}

const WET_QUESTION_MAX_CHARS = 300;

/** "artikel 3:4", "art. 6:162", "artikel 5.1 lid 2", "artikel 3:4, tweede lid"; also in capitals ("ARTIKEL 3:4") and in English ("article 3:4"). */
const ARTIKEL = String.raw`(?:[Aa]rtikel|ARTIKEL|[Aa]rticle|ARTICLE|[Aa]rt\.?|ART\.?)\s+(\d{1,4}[a-z]?(?:[:.]\d{1,4}[a-z]?){0,3})(?:(?:\s*,)?\s+lid\s+(\d{1,2})|(?:\s*,)?\s+(eerste|tweede|derde|vierde|vijfde|zesde|zevende|achtste|negende|tiende)\s+lid(?:\s*,)?)?`;
const LID_ORDINALS = ["eerste", "tweede", "derde", "vierde", "vijfde", "zesde", "zevende", "achtste", "negende", "tiende"];

/** Words that end a law's name written out ("Wet open overheid over ..."). */
const WET_NAME_STOP = "over|gaan|gaat|ging|zegt|zei|staat|stond|stonden|regelt|regelde|bepaalt|luidt|luidde|is|was|in|op|per|sinds|vanaf|tot|en|of|die|dat|wat|welke|artikel|artikelen|art|lid|bij|na|geeft|gaf|noemt|stelt|schrijft|verbiedt|verplicht|heeft|had|kent|maakt|moet|mag|kan|wordt|werd|zijn|waren";
/** A further word of a law's name: lowercase, or a year ("Wegenverkeerswet 1994"). */
const WET_NAME_WORD = String.raw`(?!(?:${WET_NAME_STOP})(?![\p{L}-]))(?:\p{Ll}[\p{L}-]*|(?:19|20)\d\d(?!\d))`;
/** The first word after "Wet": also a name or an acronym ("Wet Bibob", "wet BIG"). */
const WET_FIRST_NAME_WORD = String.raw`(?:${WET_NAME_WORD}|(?!(?:ARTIKEL|ART|[Aa]rtikel|[Aa]rt)(?![\p{L}-]))\p{Lu}[\p{L}-]*)`;

/**
 * A national law or regulation as a question names it, for wetten_bwb_tekst's
 * `wet`: the BW with a book, a Wetboek, a "Wet ..."/"Besluit ..." written out,
 * a one-word law ("Omgevingswet", "Gemeentewet", "Grondwet"), the regulations
 * the Omgevingswet came with and the common official afkortingen. Never a
 * local or EU instrument (omgevingsplan, APV, verordening, AVG, richtlijn).
 */
const LAW_ALTERNATIVES = [
  String.raw`[Bb]oek\s+\d{1,2}a?\s+(?:van\s+het\s+)?(?:BW|Burgerlijk\s+Wetboek)`,
  String.raw`(?:BW|Burgerlijk\s+Wetboek)\s+[Bb]oek\s+\d{1,2}a?`,
  String.raw`Wetboek\s+van\s+(?:[Bb]urgerlijke\s+)?\p{L}+`,
  String.raw`Burgerlijk\s+Wetboek`,
  String.raw`(?:Algemene\s+wet|[Ww]et|Besluit)\s+(?:op\s+(?:de|het)\s+)?${WET_FIRST_NAME_WORD}(?:\s+${WET_NAME_WORD}){0,6}`,
  String.raw`\p{L}[\p{L}-]{2,}wet(?:\s+(?:19|20)\d\d(?!\d))?`,
  String.raw`(?:Omgevingsbesluit|Bouwbesluit(?:\s+2012)?|Activiteitenbesluit(?:\s+milieubeheer)?|Invoeringsbesluit\s+Omgevingswet)`,
  String.raw`(?:Awb|AWB|BW|Sr|Sv|Rv|Gw|Woo|Wob|Wmo(?:\s+2015)?|Ow|Bkl|Bbl|Bal|Wvw|WVW(?:\s+1994)?|Wro|Wabo|Wpg|Vw(?:\s+2000)?|Wft|Awr|Gemw|Pw)`,
];
const LAW = `(?:${LAW_ALTERNATIVES.join("|")})`;
const LAW_END = String.raw`(?=$|[^\p{L}\d])`;

/** "artikel 3:4 (van) (de) Awb". */
const ARTIKEL_LAW_RE = new RegExp(String.raw`(?:^|[^\p{L}])${ARTIKEL}(?:\s*,)?\s+(?:(?:van|uit|in)\s+)?(?:de\s+|het\s+)?(${LAW})${LAW_END}`, "u");
/** "Wet open overheid artikel 3.3", "Awb, art. 3:4". */
const LAW_ARTIKEL_RE = new RegExp(String.raw`(?:^|[^\p{L}])(${LAW})(?:\s*,)?\s+${ARTIKEL}(?=$|[^\p{L}\d:.])`, "u");
/** "Welke artikelen van de Participatiewet gaan over de kostendelersnorm?" */
const ARTIKELEN_LAW_TOPIC_RE = new RegExp(String.raw`(?:^|[^\p{L}])[Aa]rtikelen\s+(?:van|uit|in)\s+(?:de\s+|het\s+)?(${LAW})\s+(?:\p{L}+\s+){0,3}?(?:over|betreffende|inzake|met)\s+(.+?)[\s?.!]*$`, "u");
/** "Wat staat er in de Gemeentewet over de burgemeester?", "Wat zegt de Woningwet over woningcorporaties?" */
const LAW_TOPIC_RE = new RegExp(String.raw`^\s*(?:[Ww]at\s+(?:staat|stond|staan|stonden)\s+(?:er\s+)?in|[Ww]at\s+(?:zegt|zei|regelt|regelde|bepaalt|bepaalde))\s+(?:de\s+|het\s+)?(${LAW})\s+(?:over|betreffende|inzake|omtrent)\s+(.+?)[\s?.!]*$`, "u");
/** A relative clause after the topic ("de kostendelersnorm die in 2015 werd ingevoerd"): no topic words, no day. */
const TOPIC_CLAUSE_RE = /\s+(?:die|dat|welke|waarin|waarbij|waarmee|waardoor|zoals|sinds|toen)\s.*$/iu;
/** A year as a period ("in 2015"), no topic word; "Natura 2000" keeps its number. */
const TOPIC_YEAR_RE = /(?:^|\s)(?:in|sinds|vanaf|per|anno|tot)\s+(?:het\s+jaar\s+)?(?:19|20)\d\d(?!\d)/giu;
/** A count of cases under an artikel ("Hoeveel boetes zijn er uitgedeeld op grond van artikel 5 WVW?"): statistics, not the law's text. */
const WET_COUNT_RE = /(?:^|[^\p{L}])(?:hoeveel|aantal|how\s+many)(?=$|[^\p{L}])/iu;
const WET_CASES_RE = /(?:^|[^\p{L}])(?:boetes?|bekeuring\p{L}*|sancties?|overtreding\p{L}*|zaken|gevallen|keer|mensen|personen|veroordeling\p{L}*|vervolg\p{L}*|opgelegd|uitgedeeld|uitgeschreven|geregistreerd|ingediend|verleend|aangehouden|fines|cases)(?=$|[^\p{L}])/iu;

/** Another source's documents about an article (rulings, parliamentary papers), or an EU or local instrument. */
const WET_OTHER_SOURCE_RE = /(?:^|[^\p{L}])(?:uitspra(?:ak|ken)|jurisprudentie|rechtspraak|rechters?|rechtbank\p{L}*|gerechtsh(?:of|oven)|vonnis\p{L}*|arresten?|ecli|hoge\s+raad|raad\s+van\s+state|kamervra\p{L}*|kamerstuk\p{L}*|kamerbrie\p{L}*|moties?|amendement\p{L}*|wetsvoorstel\p{L}*|\p{L}*debat\p{L}*|tweede\s+kamer|eerste\s+kamer|\p{L}*verordening\p{L}*|richtlijn\p{L}*|avg|gdpr)(?=$|[^\p{L}])/iu;

const MONTHS: Record<string, number> = { januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12 };

function isoDay(y: number, m: number, d: number): string | undefined {
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().startsWith(iso) ? iso : undefined;
}

/**
 * The day a question asks a law's text for: "op 1 januari 2015", "per
 * 1-7-2020", "op 2020-07-01", or a year ("in 2015": its first day). A year
 * that is part of the law's name ("Wmo 2015") is no day.
 */
/**
 * A day the question names that does not exist ("op 31 februari 2020"): the
 * words, so the answer can say it was not applied.
 */
export function wetPeildatumOngeldig(text: string): string | undefined {
  const named = new RegExp(String.raw`(?:^|[^\p{L}])(?:op|per|geldig\s+op|geldend\s+op)\s+(\d{1,2})\s+(${Object.keys(MONTHS).join("|")})\s+((?:19|20)\d\d)(?!\d)`, "iu").exec(text);
  if (named && !isoDay(Number(named[3]), MONTHS[named[2].toLowerCase()], Number(named[1]))) return named[0].trim();
  const dmy = /(?:^|[^\p{L}])(?:op|per)\s+(\d{1,2})[-/](\d{1,2})[-/]((?:19|20)\d\d)(?!\d)/iu.exec(text);
  if (dmy && !isoDay(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]))) return dmy[0].trim();
  const ymd = /(?:^|[^\p{L}])(?:op|per)\s+((?:19|20)\d\d)-(\d\d)-(\d\d)(?!\d)/iu.exec(text);
  if (ymd && !isoDay(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]))) return ymd[0].trim();
  return undefined;
}

export function wetPeildatum(text: string, lawName = ""): { peildatum: string; bron: string } | undefined {
  const named = new RegExp(String.raw`(?:^|[^\p{L}])(?:op|per|geldig\s+op|geldend\s+op)\s+(\d{1,2})\s+(${Object.keys(MONTHS).join("|")})\s+((?:19|20)\d\d)(?!\d)`, "iu").exec(text);
  if (named) {
    const day = isoDay(Number(named[3]), MONTHS[named[2].toLowerCase()], Number(named[1]));
    if (day) return { peildatum: day, bron: named[0].trim() };
  }
  const dmy = /(?:^|[^\p{L}])(?:op|per)\s+(\d{1,2})[-/](\d{1,2})[-/]((?:19|20)\d\d)(?!\d)/iu.exec(text);
  if (dmy) {
    const day = isoDay(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
    if (day) return { peildatum: day, bron: dmy[0].trim() };
  }
  const ymd = /(?:^|[^\p{L}])(?:op|per)\s+((?:19|20)\d\d)-(\d\d)-(\d\d)(?!\d)/iu.exec(text);
  if (ymd) {
    const day = isoDay(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
    if (day) return { peildatum: day, bron: ymd[0].trim() };
  }
  const year = /(?:^|[^\p{L}])(?:in|per|sinds|vanaf|anno)\s+(?:het\s+jaar\s+)?((?:19|20)\d\d)(?!\d)/iu.exec(text);
  if (year && !lawName.includes(year[1])) return { peildatum: `${year[1]}-01-01`, bron: year[0].trim() };
  return undefined;
}

export interface WetArtikelIntent {
  /** The law as the question names it: wetten_bwb_tekst's `wet`. */
  wet: string;
  /** The artikel label, with a lid ("3:4 lid 2"). */
  artikel?: string;
  /** "Welke artikelen van <wet> gaan over <onderwerp>": the onderwerp. */
  zoekterm?: string;
  /** The day the text is asked for (YYYY-MM-DD), when the question names one. */
  peildatum?: string;
  /** The words the peildatum was read from ("op 1 januari 2015"). */
  peildatumBron?: string;
  /** A day the question names that does not exist ("op 31 februari 2020"): not applied, and said so. */
  peildatumOngeldig?: string;
}

/** "BW", "Burgerlijk Wetboek" with "6:162": book 6, artikel 162 (the BWB holds each book as a regeling of its own). */
function bwBook(law: string, artikel: string): { wet: string; artikel: string } | undefined {
  if (!/^(?:BW|Burgerlijk\s+Wetboek)$/u.test(law)) return undefined;
  const m = /^(\d{1,2}a?):(.+)$/u.exec(artikel);
  return m ? { wet: `BW boek ${m[1]}`, artikel: m[2] } : undefined;
}

/**
 * A question about an artikel of a named national law ("Wat staat er in
 * artikel 3:4 van de Awb?", "Artikel 6:162 BW", "Hoe luidde artikel 3:4 Awb
 * op 1 januari 2015?"), or about which artikelen of one deal with a subject:
 * for wetten_bwb_tekst. Precision first: the artikel and the law are named
 * next to each other; a local or EU instrument (omgevingsplan, APV,
 * verordening, AVG, richtlijn) is no law here, and a question about rulings
 * or parliamentary papers on an artikel is another route's.
 */
export function detectWetArtikelIntent(question: string): WetArtikelIntent | undefined {
  const text = String(question ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > WET_QUESTION_MAX_CHARS || WET_OTHER_SOURCE_RE.test(text)) return undefined;
  if (WET_COUNT_RE.test(text) && WET_CASES_RE.test(text)) return undefined;
  /** The day, read from the question without a relative clause about the topic. */
  const dayOf = (source: string, wet: string): Pick<WetArtikelIntent, "peildatum" | "peildatumBron" | "peildatumOngeldig"> => {
    const day = wetPeildatum(source, wet);
    if (day) return { peildatum: day.peildatum, peildatumBron: day.bron };
    const invalid = wetPeildatumOngeldig(source);
    return invalid ? { peildatumOngeldig: invalid } : {};
  };
  const fromParts = (law: string, label: string, lid?: string, ordinal?: string): WetArtikelIntent => {
    const lidNumber = lid ?? (ordinal ? String(LID_ORDINALS.indexOf(ordinal.toLowerCase()) + 1) : undefined);
    const wet = law.replace(/\s+/g, " ").trim();
    const book = bwBook(wet, label);
    return {
      wet: book?.wet ?? wet,
      artikel: `${book?.artikel ?? label}${lidNumber ? ` lid ${lidNumber}` : ""}`,
      ...dayOf(text, wet),
    };
  };
  const after = ARTIKEL_LAW_RE.exec(text);
  if (after) return fromParts(after[4], after[1], after[2], after[3]);
  const before = LAW_ARTIKEL_RE.exec(text);
  if (before) return fromParts(before[1], before[2], before[3], before[4]);
  const lawTopic = LAW_TOPIC_RE.exec(text);
  // "Wat zegt de Omgevingswet over de regels in Rotterdam?": a place's rules, not the law's text.
  const topic = ARTIKELEN_LAW_TOPIC_RE.exec(text) ?? (lawTopic && !IN_PLACE_RE.test(lawTopic[2]) ? lawTopic : null);
  if (topic) {
    const clause = TOPIC_CLAUSE_RE.exec(topic[2]);
    const words = topic[2].replace(TOPIC_CLAUSE_RE, "").replace(TOPIC_YEAR_RE, " ").replace(/^\s*(?:de|het|een)\s+/iu, "");
    const zoekterm = parseTkQuery(words).terms.map((t) => t.text).join(" ");
    if (!zoekterm) return undefined;
    const wet = topic[1].replace(/\s+/g, " ").trim();
    return { wet, zoekterm, ...dayOf(clause ? text.replace(clause[0], " ") : text, wet) };
  }
  return undefined;
}

/** The research bodies with a route of their own: their publications answer the question. */
export type ResearchOrg = "rekenkamer" | "scp" | "wodc";

export interface ResearchOrgIntent {
  org: ResearchOrg;
  /** Topic words without the body's name and the words around it ("onderzocht", "rapport"); empty: the newest. */
  query: string;
}

const WODC_RE = /(?:^|[^\p{L}])wodc(?=$|[^\p{L}])|wetenschappelijk\s+onderzoek-?\s*en\s+(?:documentatie|data)centrum/iu;
const SCP_RE = /(?:^|[^\p{L}])scp(?=$|[^\p{L}])|sociaal(?:\s+en\s+|-)cultureel\s+planbureau/iu;
const ALGEMENE_REKENKAMER_RE = /(?:^|[^\p{L}])algemene\s+rekenkamer(?=$|[^\p{L}])/iu;
/** "de Rekenkamer", "Rekenkamerrapport", "rekenkameronderzoek"; not "rekenkamercommissie". */
const REKENKAMER_RE = /(?:^|[^\p{L}])(?:(\p{L}+)\s+)?rekenkamer(?:rapport(?:en)?|onderzoek(?:en)?)?(?=$|[^\p{L}])/iu;
/** A rekenkamer of a region, province or municipality, or the European one. */
const OTHER_REKENKAMER_WORDS = new Set(["zuidelijke", "noordelijke", "randstedelijke", "lokale", "gemeentelijke", "provinciale", "regionale", "europese", "stedelijke"]);
const LOCAL_SCOPE_RE = /(?:^|[^\p{L}])(?:gemeente\p{L}*|provincie\p{L}*|provinciale|gemeenteraad|raad|raadsleden|wethouders?|staten|rekenkamercommissie\p{L}*|waterschap\p{L}*)(?=$|[^\p{L}])/iu;
/** A capitalised name after "van", "in", "voor" or "te": a place unless it names the Rijk or one of its parts. */
const NAMED_SCOPE_RE = /(?:^|[^\p{L}])(?:van|in|voor|te|bij)\s+(?:de\s+gemeente\s+)?(\p{Lu}[\p{L}'’-]*)/gu;
const NATIONAL_NAMES = new Set([
  "justitie", "defensie", "financien", "financiën", "binnenlandse", "buitenlandse", "economische", "sociale", "infrastructuur", "volksgezondheid",
  "onderwijs", "landbouw", "klimaat", "asiel", "migratie", "rijk", "rijksoverheid", "nederland", "europa", "eu", "kamer", "tweede", "eerste", "staat",
  "koninkrijk", "belastingdienst", "toeslagen", "uwv", "duo", "ind", "coa", "politie", "ict", "ns", "prorail", "caribisch", "bonaire", "verantwoordingsdag",
]);
/**
 * Another source the question names next to the body: parliamentary papers or
 * the Tweede Kamer itself, a tender, an API, the Algoritmeregister or a data
 * file ("Wat zegt de Rekenkamer en wat besliste de Tweede Kamer over
 * Defensie?", "Aanbesteding van het SCP", "Welke API heeft het WODC?").
 */
const RESEARCH_OTHER_SOURCE_RE = /(?:^|[^\p{L}])(?:kamervra\p{L}*|kamerbrie\p{L}*|kamerstuk\p{L}*|moties?|amendement\p{L}*|\p{L}*debat\p{L}*|tweede\s+kamer|kamerleden|kamerlid|aanbested\p{L}*|tender\p{L}*|api(?:'s|s)?|algoritmeregister|dataset\p{L}*|databestand\p{L}*|bestand(?:en)?|download\p{L}*|open\s+data)(?=$|[^\p{L}])/iu;

/** Words that name the body or the kind of publication, not its subject. */
const RESEARCH_NOT_A_TOPIC = [
  "algemene", "rekenkamer", "rekenkamerrapport", "rekenkamerrapporten", "rekenkameronderzoek", "rekenkameronderzoeken",
  "scp", "sociaal", "cultureel", "planbureau", "wodc", "wetenschappelijk", "onderzoek", "datacentrum", "documentatiecentrum",
  "onderzoeken", "onderzocht", "onderzoekt", "rapport", "rapporten", "rapportage", "publicatie", "publicaties", "gepubliceerd", "publiceert", "publiceerde",
  "nieuwste", "nieuwe", "recente", "recent", "recentste", "laatste", "zegt", "zei", "zeggen", "schrijft", "schreef", "concludeerde", "concludeert", "conclusie", "conclusies",
  "cijfers", "heeft", "hebben", "welke", "wat", "over", "naar",
];

/**
 * A question that names the Algemene Rekenkamer, the SCP or the WODC: their
 * publications answer it ("Wat heeft de Rekenkamer onderzocht over
 * woningbouw?"). A bare "Rekenkamer" is the Algemene only without a local
 * scope: "Rekenkamer Rotterdam", "de Zuidelijke Rekenkamer" or a rekenkamer
 * of a named municipality are others, whose reports are council records.
 * Parliamentary papers about a report, and a question naming two of the
 * bodies, are left to the other routes.
 */
export function detectResearchOrgIntent(question: string): ResearchOrgIntent | undefined {
  const text = String(question ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > WET_QUESTION_MAX_CHARS || RESEARCH_OTHER_SOURCE_RE.test(text)) return undefined;
  const orgs: ResearchOrg[] = [];
  if (WODC_RE.test(text)) orgs.push("wodc");
  if (SCP_RE.test(text)) orgs.push("scp");
  if (ALGEMENE_REKENKAMER_RE.test(text)) {
    orgs.push("rekenkamer");
  } else {
    const m = REKENKAMER_RE.exec(text);
    if (m) {
      const before = (m[1] ?? "").toLowerCase();
      const end = m.index + m[0].length;
      // "Rekenkamer Rotterdam", "Rekenkamer Metropool Amsterdam", "rekenkamer van Arnhem".
      const namedAfter = /^\s+(?:(?:van|voor)\s+(?:de\s+)?)?\p{Lu}/u.test(text.slice(end));
      // "Rekenkamerrapport over de omgevingsvisie van Amersfoort": a local rekenkamer's.
      const namedPlace = [...text.matchAll(NAMED_SCOPE_RE)].some((x) => !NATIONAL_NAMES.has(x[1].toLowerCase()));
      if (!OTHER_REKENKAMER_WORDS.has(before) && !namedAfter && !namedPlace && !LOCAL_SCOPE_RE.test(text) && !extractPlaceName(text)) orgs.push("rekenkamer");
    }
  }
  if (orgs.length !== 1) return undefined;
  // "SCP-rapport", "WODC-rapporten": the body and the kind of publication, apart. A year is
  // the period (date_from/date_to), not a word the publication must contain.
  const words = text.replace(/(?<![\p{L}])(scp|wodc|rekenkamer)-(?=\p{L})/giu, "$1 ").replace(/(?<![\p{L}\d])(?:19|20)\d\d(?![\p{L}\d])/gu, " ");
  const query = extractKeywords(words, { exclude: RESEARCH_NOT_A_TOPIC }).join(" ");
  return { org: orgs[0], query };
}

/** "hoeveel inwoners", "aantal inwoners", "inwonertal": the question asks the population itself. */
const POPULATION_COUNT_RE = /(?:^|[^\p{L}])(?:hoeveel\s+inwoners|aantal\s+inwoners|inwonertal|inwoneraantal|inwonersaantal|bevolkingsomvang|hoe\s+groot\s+is\s+de\s+bevolking|population\s+of)(?=$|[^\p{L}])/iu;
/** A part or another measure of the population, which the totals do not answer. */
const POPULATION_OTHER_RE = /(?:^|[^\p{L}])(?:per\s+inwoner|ouder|ouderen|jonger|jongeren|leeftijd\p{L}*|vrouwen|mannen|kinderen|\d+[-+]?(?:jarigen|plussers)|migratie\p{L}*|herkomst|achtergrond|nationaliteit\p{L}*|werkloos\p{L}*|inkomen\p{L}*|opleiding\p{L}*|wijk|wijken|buurt|buurten|groei|bevolkingsgroei|prognose\p{L}*|verwacht\p{L}*|huishoudens?|per\s+gemeente|alle\s+gemeenten|provincie)(?=$|[^\p{L}])/iu;
const POPULATION_PLACE_RE = new RegExp(String.raw`(?:^|[^\p{L}])(?:[Ii]nwoners|[Ii]nwonertal|[Ii]nwoneraantal|[Ii]nwonersaantal|[Bb]evolking|[Bb]evolkingsomvang|[Pp]opulation)\s+(?:(?:heeft|telt|had|telde|van|in|of)\s+)?(?:de\s+)?(?:gemeente\s+)?(${PLACE_CORE})`, "u");
/**
 * The question is only the population word and a place, perhaps with a year:
 * "inwoners Amsterdam", "Bevolking van Zwolle in 2023", "Inwonertal Delft 2015".
 */
const POPULATION_BARE_RE = new RegExp(String.raw`^\s*(?:[Hh]et\s+)?(?:[Aa]antal\s+)?(?:[Ii]nwoners|[Ii]nwonertal|[Ii]nwoneraantal|[Ii]nwonersaantal|[Bb]evolking|[Bb]evolkingsomvang)\s+(?:(?:van|in)\s+)?(?:de\s+)?(?:gemeente\s+)?${PLACE_CORE}(?:\s+(?:(?:in|op|per)\s+)?(?:1\s+januari\s+)?\d{4})?\s*[?.!]?\s*$`, "u");
/** The country and the regions without a population figure in the table. */
const POPULATION_NOT_A_PLACE_RE = /^(?:Holland|Europa|Randstad|Caribisch Nederland)$/iu;
const POPULATION_QUESTION_MAX_CHARS = 300;

/**
 * The municipality whose number of inhabitants a question asks ("Hoeveel
 * inwoners heeft Nijmegen?", "Aantal inwoners van Den Haag", "Hoeveel
 * inwoners had Zwolle op 1 januari 2025?"), for the CBS population table.
 * Not for a part of the population (ages, origin, a wijk) or another measure
 * per inhabitant.
 */
export function extractPopulationPlace(question: string): string | undefined {
  const text = String(question ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > POPULATION_QUESTION_MAX_CHARS) return undefined;
  if (!(POPULATION_COUNT_RE.test(text) || POPULATION_BARE_RE.test(text)) || POPULATION_OTHER_RE.test(text)) return undefined;
  const raw = POPULATION_PLACE_RE.exec(text)?.[1] ?? extractPlaceName(text);
  const place = raw?.replace(/[?.,;:!]+$/, "").trim();
  // A region without a figure of its own: the CBS tables answer that, as before.
  // "Nederland" and the provinces are in the population table too (cbsMunicipalityPopulation).
  return place && place.length >= 2 && !POPULATION_NOT_A_PLACE_RE.test(place) ? place : undefined;
}

/**
 * The year a population question asks for, also one outside the table
 * ("in 1800", "in 2999"), which the period parser leaves alone: a year the
 * table does not have is said so, not answered with the newest.
 */
export function extractPopulationYear(question: string): number | undefined {
  const m = /(?:^|[^\p{L}\d])(?:(?:in|op|per|anno|van)\s+(?:1\s+januari\s+)?)?(1\d{3}|2\d{3})(?![\p{L}\d])/u.exec(String(question ?? ""));
  return m ? Number(m[1]) : undefined;
}
