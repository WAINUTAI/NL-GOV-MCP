/**
 * Server-side query rewriter.
 *
 * Instead of relying on stopword lists (brittle, context-blind), this module
 * recognises the *structural frame* of a natural-language question and
 * extracts the topic payload.  A final lightweight cleanup pass removes
 * residual noise.
 *
 * Sensitivity levels:
 *   "strict"      – Aggressive: only keep core topic keywords.
 *                    Use for APIs that break on extra words (Rechtspraak).
 *   "moderate"    – Strip question framing but keep every content word.
 *                    Use for tolerant full-text APIs (CKAN, CBS, etc.).
 *   "passthrough" – Return input unchanged.
 *                    Use for SPARQL, identifiers, license plates, etc.
 *
 * What "moderate" must never do (it used to, and that made searches miss):
 *  - drop a meta word that belongs to a name or term: "Open Data Portaal" is a
 *    name, "open data" and "data beheer" are terms, not requests for
 *    data. A meta noun ("lijst", "overzicht", "informatie", "gegevens", "data")
 *    goes when it sits in a frame ("geef een overzicht van", "lijst van") or
 *    stands on its own next to the topic ("luchtkwaliteit gegevens", "actuele
 *    gegevens luchtkwaliteit"): AND- and substring-matching backends find
 *    nothing for the extra word.
 *  - eat the start of a word: the frames used to end on optional groups without
 *    a word boundary, so "Wat is erfpacht?" became "fpacht" and "Zoek
 *    overheidsdata" became "heidsdata".
 *  - throw away meaningful punctuation or one-character tokens: "B&W", "2.0",
 *    "Info+", "groep 8".
 *  - return an empty query.
 */

export type QuerySensitivity = "strict" | "moderate" | "passthrough";

/* ------------------------------------------------------------------ */
/*  0.  Building blocks                                               */
/* ------------------------------------------------------------------ */

/**
 * End of a word. `\b` is ASCII-only in JavaScript, so "er" would count as a
 * whole word in "eréén"; requiring whitespace or the end of the string is exact.
 */
const END = "(?=\\s|$)";

const NL_PREPOSITIONS = "over|van|voor|met|uit|naar|omtrent|betreffende|inzake|rond|rondom|aangaande";
/** Nouns that name the *kind* of answer rather than its topic. */
const NL_META_NOUNS = "informatie|info|gegevens|datasets?|data|resultaten|overzicht|lijst(?:je)?";
const EN_PREPOSITIONS = "about|on|for|of|regarding|related\\s+to";
const EN_META_NOUNS = "information|info|data|datasets?|results|details|list|overview";

/* ------------------------------------------------------------------ */
/*  1.  Question-frame patterns (NL + EN)                             */
/*      These match the "wrapper" around the actual topic. Each      */
/*      optional part must end on a word end, see END above.         */
/* ------------------------------------------------------------------ */

const QUESTION_FRAMES: RegExp[] = [
  // "Wat is / zijn / was … de / het …"
  new RegExp(
    `^(?:wat|welke?|hoeveel|wanneer|waar|wie|hoe)\\s+(?:is|zijn|was|waren|wordt|worden|heeft|hebben|kan|kunnen|mag|mogen|zal|zullen)${END}` +
      `(?:\\s+(?:de|het|een|er|daar|hier)${END})?\\s*`,
    "i",
  ),

  // "Geef (mij) (de) (informatie/datasets over) …". A meta noun only belongs to
  // the frame when a preposition follows it: "zoek data beheer" keeps "data".
  new RegExp(
    `^(?:geef|toon|laat|zoek|vind|haal|pak)${END}(?:\\s+(?:mij|me|ons|eens)${END})?(?:\\s+(?:de|het|een|alle|meer)${END})?` +
      `(?:\\s+(?:${NL_META_NOUNS}|uitspraken?)(?=\\s+(?:${NL_PREPOSITIONS})${END}))?` +
      `(?:\\s+(?:${NL_PREPOSITIONS})${END})?(?:\\s+(?:de|het|een|alle)${END})?\\s*`,
    "i",
  ),

  // "Ik wil / zoek (graag) (informatie over) …"
  new RegExp(
    `^ik\\s+(?:wil|zoek|vraag|ben\\s+op\\s+zoek\\s+naar)${END}(?:\\s+graag${END})?` +
      `(?:\\s+(?:informatie|info|gegevens|data|meer)(?=\\s+(?:${NL_PREPOSITIONS})${END}))?` +
      `(?:\\s+(?:${NL_PREPOSITIONS})${END})?\\s*`,
    "i",
  ),

  // "Kun je (mij) vertellen / zoeken / geven (over) …"
  new RegExp(
    `^(?:kun|kan)\\s+(?:je|jij|u)${END}(?:\\s+(?:mij|me)${END})?` +
      `(?:\\s+(?:vertellen|laten\\s+zien|zoeken|vinden|geven|opzoeken)${END})?(?:\\s+(?:over|naar|van|voor)${END})?\\s*`,
    "i",
  ),

  // "(Een) lijst van / overzicht van / informatie over …" without a verb.
  new RegExp(
    `^(?:(?:een|de|het)\\s+)?(?:(?:volledige|complete)\\s+)?(?:${NL_META_NOUNS})\\s+(?:${NL_PREPOSITIONS})${END}` +
      `(?:\\s+(?:de|het|een|alle)${END})?\\s*`,
    "i",
  ),

  // EN: "What is / are / was …"
  new RegExp(
    `^(?:what|which|how\\s+many|when|where|who)\\s+(?:is|are|was|were|does|do|has|have|can|could|will|would)${END}(?:\\s+(?:the|a|an)${END})?\\s*`,
    "i",
  ),
  // EN: "Show me …", "Find …", "Give me (the) (information about) …"
  new RegExp(
    `^(?:show|find|give|get|search|look\\s+up|tell)${END}(?:\\s+(?:me|us)${END})?(?:\\s+(?:the|a|an|all|some|more)${END})?` +
      `(?:\\s+(?:${EN_META_NOUNS})(?=\\s+(?:${EN_PREPOSITIONS})${END}))?(?:\\s+(?:${EN_PREPOSITIONS})${END})?(?:\\s+(?:the|all)${END})?\\s*`,
    "i",
  ),
  // EN: "(A) list of / overview of …"
  new RegExp(`^(?:(?:a|an|the)\\s+)?(?:${EN_META_NOUNS})\\s+(?:${EN_PREPOSITIONS})${END}(?:\\s+(?:the|all)${END})?\\s*`, "i"),
  // Comparison: "Vergelijk (de) …", "(Het) verschil tussen …", "(Een)
  // vergelijking tussen/van …". Runs after the question frames, so "Wat is het
  // verschil tussen …" loses both. What is compared is the topic; the verb or
  // noun of comparing is not, and an AND-matching source found nothing for it.
  new RegExp(`^(?:vergelijk|vergelijken)${END}(?:\\s+(?:de|het|een|alle)${END})?\\s*`, "i"),
  new RegExp(
    `^(?:(?:een|de|het)\\s+)?(?:vergelijking(?:en)?\\s+(?:tussen|van)|verschil(?:len)?\\s+tussen)${END}(?:\\s+(?:de|het|een|alle)${END})?\\s*`,
    "i",
  ),
];

/**
 * Comparison words that frame a question rather than name its topic, for
 * {@link extractKeywords}: the verb anywhere ("Vergelijk de moties met …",
 * "Kun je … vergelijken"), the noun only before "tussen" (or "van"/"met" for
 * "vergelijking"), so "regionale verschillen in de jeugdzorg" keeps its topic.
 */
const COMPARISON_VERBS = new Set(["vergelijk", "vergelijkt", "vergelijken", "vergeleken"]);
const COMPARISON_NOUNS: Record<string, Set<string>> = {
  vergelijking: new Set(["tussen", "van", "met"]),
  vergelijkingen: new Set(["tussen", "van", "met"]),
  verschil: new Set(["tussen"]),
  verschillen: new Set(["tussen"]),
};

/** Whether the token at `i` is a comparison frame word, see COMPARISON_VERBS. */
function isComparisonFrame(tokens: Token[], i: number): boolean {
  const token = tokens[i];
  if (token.phrase) return false;
  const lower = token.text.toLowerCase();
  if (COMPARISON_VERBS.has(lower)) return true;
  const next = tokens[i + 1];
  return Boolean(COMPARISON_NOUNS[lower] && next && !next.phrase && COMPARISON_NOUNS[lower].has(next.text.toLowerCase()));
}

/**
 * "Lijst moties" / "Overzicht subsidies": a leading list word directly followed
 * by a lowercase word is a frame. Deliberately case-sensitive on the next word —
 * "Lijst Pim Fortuyn" and "Lijst Lokaal Belang" are party names and stay whole.
 */
const LEADING_LIST_WORD = /^(?:[Ll]ijst|[Oo]verzicht)\s+(?=[a-zà-ÿ])/;

/* ------------------------------------------------------------------ */
/*  2.  Mid-sentence connectors / noise that sit between frame & topic*/
/* ------------------------------------------------------------------ */

const MID_NOISE: RegExp[] = [
  // "dat gaat over (het onderwerp)", "die gaan over", "met betrekking tot"
  new RegExp(`\\b(?:dat|die|welke?)\\s+(?:gaat|gaan|gingen)\\s+over${END}(?:\\s+het\\s+onderwerp${END})?`, "gi"),
  /\bmet\s+betrekking\s+tot\b/gi,
  /\bop\s+het\s+gebied\s+van\b/gi,
  /\bals\s+het\s+gaat\s+om\b/gi,
  /\bin\s+relatie\s+tot\b/gi,
  // Word end required: "het thema" must not eat the start of "het themapark".
  new RegExp(`\\bhet\\s+(?:onderwerp|thema|topic)${END}`, "gi"),
];

/* ------------------------------------------------------------------ */
/*  3.  Recency / meta markers to preserve intent but strip framing   */
/* ------------------------------------------------------------------ */

const RECENCY_MARKERS: RegExp[] = [
  /\b(?:(?:de|het)\s+)?(?:laatste|nieuwste|recentste|meest\s+recente)\b/gi,
  /\b(?:the\s+)?(?:latest|newest|most\s+recent)\b/gi,
];

/* ------------------------------------------------------------------ */
/*  4.  Trailing noise                                                */
/* ------------------------------------------------------------------ */

const TRAILING_NOISE: RegExp[] = [
  /\s*[?!.]+\s*$/,
  /\s+(?:alsjeblieft|aub|svp|please|graag)\s*$/i,
];

/** Text that ends on a letter-dot abbreviation such as "B.V." or "U.S.A.". */
const ABBREVIATION_END = /(?:^|[^\p{L}.])(?:\p{L}\.){2,}$/u;

/**
 * Strip trailing punctuation and politeness words. The dot of an abbreviation
 * at the end stays ("regels voor B.V." is no "regels voor b.v"); a "?" after
 * it still goes.
 */
function stripTrailingNoise(text: string): string {
  let out = text;
  for (const trail of TRAILING_NOISE) {
    out = out.replace(trail, (match, offset: number) =>
      match.trimStart().startsWith(".") && ABBREVIATION_END.test(`${out.slice(0, offset)}.`) ? "." : "",
    );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  5.  Strict-mode: domain-meta words that are never topic keywords  */
/*      These only apply in "strict" mode (e.g. Rechtspraak).        */
/* ------------------------------------------------------------------ */

const STRICT_META_WORDS = new Set([
  // NL legal/search meta
  "ecli", "nummer", "nummers", "number", "uitspraak", "uitspraken",
  "zaaknummer", "zaak", "zaken", "vonnis", "vonnissen", "arrest",
  "arresten", "beschikking", "beschikkingen", "jurisprudentie",
  "rechterlijke", "gerechtelijke", "procedure", "procedures",
  // NL generic question remnants
  "onderwerp", "thema", "topic", "betreft", "betreffende", "inzake",
  "aangaande", "hierover", "daarover", "informatie", "info", "gegevens",
  "data", "datasets", "resultaten", "overzicht", "lijst",
  // NL action/display remnants (laten zien, toon, etc.)
  "laten", "zien", "tonen", "vertellen", "verteld", "opzoeken",
  // comparison verbs ("Vergelijk de uitspraken over ...")
  "vergelijk", "vergelijkt", "vergelijken", "vergeleken",
  // recency words (handled separately, strip from tokens)
  "nieuwste", "recentste", "recente", "recent", "laatste", "meest",
  "latest", "newest", "most",
  // NL function words (safety net for anything frames missed)
  "aan", "al", "alle", "als", "bij", "daar", "dan", "dat", "de", "den",
  "der", "die", "dit", "door", "dus", "een", "elk", "en", "er", "gaat",
  "gaan", "geen", "haar", "had", "heeft", "hem", "het", "hier", "hij",
  "hoe", "hun", "iets", "ik", "in", "is", "ja", "je", "kan", "kon",
  "kun", "maar", "me", "meer", "men", "met", "mij", "mijn", "na",
  "naar", "niet", "nog", "nu", "of", "om", "omdat", "ons", "ook", "op",
  "over", "te", "ten", "tot", "uit", "uw", "van", "veel", "voor",
  "waar", "was", "wat", "we", "wel", "werd", "wie", "wij", "wil",
  "worden", "wordt", "zou", "zij", "zijn", "zo",
  // NL question words the frames leave behind ("Welke uitspraken zijn er ...")
  "welk", "welke", "hoeveel", "wanneer", "waarom",
  // EN function words
  "about", "all", "and", "any", "are", "around", "been", "but", "can",
  "did", "does", "find", "for", "from", "get", "give", "has", "have",
  "how", "its", "not", "off", "out", "own", "regarding", "show", "some",
  "that", "the", "was", "what", "when", "which", "who", "will", "with",
  "you",
]);

/**
 * Words that carry no topic in a natural-language question, for
 * {@link extractKeywords}. Unlike STRICT_META_WORDS this list keeps legal
 * vocabulary ("uitspraak", "procedure") and the data nouns ("data",
 * "gegevens", "informatie"): in "Wat doet het UWV met gegevens?" they are the
 * topic. It adds the question verbs that the frames do not cover ("doet",
 * "gebruikt", "ingediend").
 */
const KEYWORD_STOPWORDS = new Set([
  // question words
  "wat", "welk", "welke", "hoe", "hoeveel", "waar", "wanneer", "wie", "waarom",
  "waarover", "waarmee", "waarvoor", "waaraan", "hoezo",
  // auxiliaries and common question verbs
  "is", "zijn", "was", "waren", "wordt", "worden", "werd", "werden", "heeft", "hebben",
  "had", "hadden", "kan", "kun", "kunt", "kunnen", "kon", "konden", "mag", "mogen",
  "moet", "moeten", "zal", "zullen", "zou", "zouden", "wil", "wilt", "willen",
  "doet", "doen", "deed", "deden", "gedaan", "gaat", "gaan", "ging", "gingen",
  "staat", "staan", "stond", "zegt", "zeggen", "zei", "komt", "komen", "krijgt", "krijgen",
  "weet", "weten", "vind", "vindt", "vinden", "zie", "ziet", "zien", "geef", "geeft", "geven",
  "toon", "tonen", "zoek", "zoeken", "laat", "laten", "vertel", "vertellen",
  "gebruikt", "gebruiken", "gebruikte", "zet", "zetten", "pakt", "pakken",
  "ingediend", "gepubliceerd", "verschenen", "besproken", "gemaakt", "bekend",
  "bestaat", "bestaan", "hebt", "heb", "werkt", "werken", "werkte", "werkten",
  // pronouns, articles, function words
  "ik", "je", "jij", "u", "uw", "we", "wij", "ze", "zij", "hij", "het", "hem", "haar",
  "hun", "ons", "onze", "mij", "me", "mijn", "men", "die", "dat", "dit", "deze", "de",
  "den", "der", "een", "er", "daar", "hier", "aan", "al", "alle", "alles", "als", "bij",
  "dan", "door", "dus", "elk", "elke", "en", "of", "geen", "iets", "in", "maar", "meer",
  "met", "na", "naar", "niet", "nog", "nu", "om", "omdat", "ook", "op", "over", "te",
  "ten", "ter", "tot", "uit", "van", "veel", "voor", "wel", "zo", "toe", "sinds",
  "tussen", "binnen", "zonder", "tegen", "rond", "rondom", "omtrent", "inzake",
  "betreffende", "aangaande", "via", "per", "graag", "eens", "even", "precies",
  "momenteel", "tegenwoordig", "allemaal", "welbekend",
  // nouns that name the kind of answer, not its topic
  "informatie", "info", "overzicht", "lijst", "lijstje", "resultaten", "onderwerp",
  "thema", "topic", "datasets", "dataset",
  // recency
  "laatste", "nieuwste", "recentste", "recente", "recent", "meest",
  // English
  "what", "which", "how", "many", "much", "when", "where", "who", "why", "is", "are",
  "was", "were", "does", "do", "did", "has", "have", "had", "can", "could", "will",
  "would", "should", "the", "a", "an", "of", "for", "to", "on", "in", "about", "and",
  "or", "with", "by", "from", "at", "me", "us", "show", "find", "give", "get", "tell",
  "list", "overview", "information", "results", "latest", "newest", "most", "any",
  "some", "all", "there", "their", "its", "it", "this", "that", "these", "those",
]);

/**
 * Lowercase words that bind the parts of a name: "Raad van State", "Bergen op
 * Zoom", "Alphen aan den Rijn". Between two capitalised words they belong to the
 * name and survive strict filtering.
 */
const NAME_INFIXES = new Set(["aan", "bij", "de", "den", "der", "en", "het", "op", "ten", "ter", "van", "voor", "of", "the"]);

/**
 * Infixes that may glue capitalised words into one keyword term. "en" and "of"
 * are left out: "Amsterdam en Rotterdam" names two places, and searching it as
 * one phrase would find neither.
 */
const GROUP_INFIXES = new Set(["aan", "bij", "de", "den", "der", "het", "op", "ten", "ter", "van", "voor", "the"]);

/**
 * Function words that open a place name when capitalised mid-sentence before
 * another capitalised word: "Den Haag", "De Bilt", "Het Hogeland", "Ter Apel",
 * "Ten Boer".
 */
const NAME_LEADING_WORDS = new Set(["de", "den", "het", "ten", "ter"]);

/** Boolean operators that Lucene/Solr backends (ORI, CKAN) understand in capitals. */
const OPERATORS = new Set(["AND", "OR", "NOT"]);

/**
 * Nouns that name the kind of answer ("gegevens", "overzicht") rather than its
 * topic. In a keyword query they are noise for AND- and substring-matching
 * backends ("luchtkwaliteit gegevens" finds nothing in the CKAN catalogue,
 * "werkloosheid gegevens" no CBS table title), unless they belong to a term,
 * see {@link metaNounBinding}.
 */
const META_NOUNS = new Set([
  "informatie", "info", "gegevens", "data", "resultaten", "overzicht", "lijst", "lijstje",
  "onderwerp", "thema", "topic",
]);

/**
 * Words that follow a meta noun to form a term: "data beheer", "data
 * strategie", "informatie beveiliging" (a compound written apart). Kept short
 * and concrete; a missing entry only costs the meta noun, not the topic.
 */
const META_NOUN_HEADS = new Set([
  "officer", "officers", "science", "scientist", "scientists", "protection", "governance",
  "management", "manager", "managers", "lab", "labs", "analytics", "analyse", "analyses",
  "analist", "analisten", "engineer", "engineers", "engineering", "act", "strategie",
  "strategieën", "strategy", "ethiek", "ethics", "center", "centre", "centrum", "centra",
  "deling", "sharing", "platform", "space", "spaces", "lake", "warehouse", "mesh", "beheer",
  "beheerder", "kwaliteit", "quality", "gedreven", "driven", "privacy", "portaal", "portal",
  "infrastructuur", "architectuur", "beveiliging", "security", "huishouding", "voorziening",
  "uitwisseling", "bescherming", "minimalisatie", "literacy", "steward", "stewards", "avond",
  "bijeenkomst", "punt", "plicht", "verzoek", "verzoeken",
]);

/** The meta nouns that name data; only these form a term with a modifier ("open data"). */
const DATA_META_NOUNS = new Set(["informatie", "info", "gegevens", "data"]);

/**
 * Words before a data noun that make it a fixed term: "open data", "big data",
 * "open data portaal", "medische gegevens", "bijzondere gegevens",
 * "ruimtelijke informatie". An explicit list, not an adjective suffix:
 * "actuele", "beschikbare", "historische", "landelijke" and "regionale" only
 * qualify the request ("actuele gegevens luchtkwaliteit"), and keeping the
 * noun after them made AND-matching catalogues find nothing (7 datasets
 * became 0). A missing entry only costs the noun, not the topic.
 */
const META_NOUN_MODIFIERS = new Set([
  "open", "big", "linked", "chief", "ruwe",
  "medische", "persoonlijke", "bijzondere", "biometrische", "genetische",
  "strafrechtelijke", "justitiële", "politiële", "gevoelige", "vertrouwelijke", "geheime",
  "gerubriceerde", "ruimtelijke", "geografische",
]);

/**
 * How a meta noun ("data", "gegevens") is bound to a neighbour, if at all:
 * "head" when the next word makes a term of it ("data beheer"), "modifier"
 * when the previous word does ("open data", "medische gegevens"). Unbound meta
 * nouns are noise in a keyword query. Exported for the router, which uses the
 * same rule to tell a data request ("data over parkeren") from a term.
 */
export function metaNounBinding(
  prev: string | undefined,
  word: string,
  next: string | undefined,
): "head" | "modifier" | undefined {
  const lower = word.toLowerCase();
  if (!META_NOUNS.has(lower)) return undefined;
  if (next && META_NOUN_HEADS.has(next.toLowerCase())) return "head";
  const p = (prev ?? "").toLowerCase();
  if (p && DATA_META_NOUNS.has(lower) && META_NOUN_MODIFIERS.has(p)) return "modifier";
  return undefined;
}

/** An acronym such as "OM", "IT", "ALS", "WHO": two or more capitals. Not the operators. */
function isAcronym(text: string): boolean {
  return /^\p{Lu}{2,}$/u.test(text) && !OPERATORS.has(text);
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export interface RewriteResult {
  /** The cleaned query to send to the API (lowercase, no quotes or operators). */
  rewritten: string;
  /** The original query (for logging / provenance) */
  original: string;
  /** Whether any rewriting was performed */
  changed: boolean;
  /** What the rewriter did (human-readable, for access_note) */
  explanation?: string;
  /**
   * The rewritten query with the caller's search syntax kept: balanced quoted
   * phrases and capitalised AND/OR/NOT between terms. Only set when the input
   * carried such syntax. Use it for backends that parse Lucene/Solr syntax
   * (ORI Elasticsearch, CKAN); substring-matching backends (Tweede Kamer OData,
   * CBS catalogue) would search for the quote characters literally, which is why
   * `rewritten` stays plain.
   */
  syntaxQuery?: string;
  /** True when a recency word ("laatste", "nieuwste") was removed from the query. */
  recency?: boolean;
}

interface Token {
  /** Cleaned token text, original case. */
  text: string;
  /** Content of a quoted phrase in the input. */
  phrase: boolean;
  /** First word left after frame stripping, when no frame was stripped. */
  sentenceInitial: boolean;
}

interface Analysis {
  tokens: Token[];
  recency: boolean;
  /** Input contained no lowercase letter at all (shouting); case says nothing then. */
  allCaps: boolean;
}

const QUOTE_CHARS = /[“”„‟″«»]/g;
const PLACEHOLDER = /^(\d+)$/;

/** Keep letters, digits and the connectors that make tokens like "B&W", "2.0", "Info+", "NL-Alert". */
function cleanPieces(raw: string): string[] {
  return raw
    .replace(/[^\p{L}\p{N}\-&.+]/gu, " ")
    .split(/\s+/)
    .map((piece) => {
      let p = piece.replace(/^[.&+]+/, "").replace(/[-&]+$/, "");
      // "beleid." loses the sentence dot; "b.v." and "2.0" keep theirs.
      if (!/^(?:\p{L}\.){2,}$/u.test(p)) p = p.replace(/\.+$/, "");
      return p;
    })
    .filter((p) => /[\p{L}\p{N}]/u.test(p))
    // One character is noise when it is a lowercase letter ("u", the "s" of
    // "'s"), but a digit ("groep 8") or a capital ("Plan B") is content.
    .filter((p) => p.length > 1 || /^[\p{N}\p{Lu}]$/u.test(p));
}

function analyse(raw: string): Analysis {
  const original = raw.trim();
  const phrases: string[] = [];

  // Protect quoted phrases from frame stripping and filtering. An unbalanced
  // quote carries no phrase, and as a bare character it would break a Lucene
  // parse, so it is dropped.
  let text = original
    .replace(QUOTE_CHARS, '"')
    .replace(/"([^"]*)"/g, (_m, inner: string) => {
      const clean = inner.trim();
      if (!clean) return " ";
      phrases.push(clean);
      return ` ${phrases.length - 1} `;
    })
    .replace(/"/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Trailing "?" first, so a frame can end on the last word ("Wat is er?").
  text = stripTrailingNoise(text);
  const beforeFrames = text;
  for (const frame of QUESTION_FRAMES) text = text.replace(frame, "");
  if (LEADING_LIST_WORD.test(text) && /\s\S/.test(text)) text = text.replace(LEADING_LIST_WORD, "");
  const framesRemoved = text.length < beforeFrames.length;

  for (const noise of MID_NOISE) text = text.replace(noise, " ");
  text = stripTrailingNoise(text);

  const recency = RECENCY_MARKERS.some((marker) => {
    marker.lastIndex = 0;
    const hit = marker.test(original);
    marker.lastIndex = 0;
    return hit;
  });
  // Remove recency phrases from query body (the source handler deals with sort order)
  for (const marker of RECENCY_MARKERS) text = text.replace(marker, " ");

  const tokens: Token[] = [];
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const placeholder = PLACEHOLDER.exec(raw);
    if (placeholder) {
      const words = cleanPieces(phrases[Number(placeholder[1])] ?? "");
      if (words.length) tokens.push({ text: words.join(" "), phrase: true, sentenceInitial: false });
      continue;
    }
    for (const piece of cleanPieces(raw)) {
      tokens.push({ text: piece, phrase: false, sentenceInitial: tokens.length === 0 && !framesRemoved });
    }
  }

  return { tokens, recency, allCaps: !/\p{Ll}/u.test(original) };
}

/**
 * A capitalised word ("Data", "Den", "IJssel"); not an acronym ("OV", "UWV"),
 * an acronym compound ("OV-beleid") or an operator ("AND").
 */
function isTitleCase(text: string): boolean {
  return /^(?:IJ|\p{Lu})\p{Ll}/u.test(text);
}

/**
 * A word that the user capitalised in the middle of a sentence is part of a
 * name ("Open Data Portaal", "Den Haag") and survives word lists.
 */
function isName(token: Token, analysis: Analysis): boolean {
  return !analysis.allCaps && !token.sentenceInitial && isTitleCase(token.text);
}

/** Indexes of lowercase name infixes that sit between two capitalised words. */
function infixIndexes(tokens: Token[], analysis: Analysis, infixSet: Set<string> = NAME_INFIXES): Set<number> {
  const keep = new Set<number>();
  if (analysis.allCaps) return keep;
  for (let i = 1; i < tokens.length - 1; i++) {
    if (!infixSet.has(tokens[i].text) || tokens[i].phrase) continue;
    let j = i;
    while (j < tokens.length - 1 && infixSet.has(tokens[j].text)) j++;
    // "Uitspraken van de Raad van State": a sentence-initial question or meta
    // word is capitalised by grammar and opens no name ("Bergen op Zoom" does).
    const prev = tokens[i - 1];
    const prevLower = prev.text.toLowerCase();
    if (prev.sentenceInitial && (STRICT_META_WORDS.has(prevLower) || KEYWORD_STOPWORDS.has(prevLower))) continue;
    if (isTitleCase(prev.text) && isTitleCase(tokens[j].text)) {
      for (let k = i; k < j; k++) keep.add(k);
    }
  }
  return keep;
}

/** How the meta noun at `i` is bound to its neighbours, see {@link metaNounBinding}. */
function tokenBinding(tokens: Token[], i: number): "head" | "modifier" | undefined {
  const prev = tokens[i - 1];
  const next = tokens[i + 1];
  return metaNounBinding(prev && !prev.phrase ? prev.text : undefined, tokens[i].text, next && !next.phrase ? next.text : undefined);
}

/**
 * A meta noun standing on its own ("luchtkwaliteit gegevens"): not quoted, not
 * part of a name ("Open Data Portaal"), not an operand of AND/OR/NOT and not
 * bound into a term ("open data", "data beheer").
 */
function isLooseMetaNoun(tokens: Token[], i: number, analysis: Analysis): boolean {
  const t = tokens[i];
  if (t.phrase || !META_NOUNS.has(t.text.toLowerCase()) || isName(t, analysis)) return false;
  // "Lijst Pim Fortuyn", "Lijst Lokaal Belang": a capitalised meta noun that
  // opens a run of capitalised words names a party or list.
  const next = tokens[i + 1];
  if (!analysis.allCaps && isTitleCase(t.text) && next && !next.phrase && isTitleCase(next.text)) return false;
  if (OPERATORS.has(tokens[i - 1]?.text ?? "") || OPERATORS.has(next?.text ?? "")) return false;
  return !tokenBinding(tokens, i);
}

/** The query as words, lowercased: quotes and operator capitals removed. */
function plainQuery(tokens: Token[]): string {
  return tokens.map((t) => t.text.toLowerCase()).join(" ").trim();
}

/** The query with quoted phrases and AND/OR/NOT between terms kept, or undefined if there are none. */
function syntaxQuery(tokens: Token[]): string | undefined {
  let hasSyntax = false;
  const parts = tokens.map((t, i) => {
    if (t.phrase) {
      hasSyntax = true;
      return `"${t.text.toLowerCase()}"`;
    }
    if (OPERATORS.has(t.text) && i > 0 && i < tokens.length - 1 && !OPERATORS.has(tokens[i - 1].text)) {
      hasSyntax = true;
      return t.text;
    }
    return t.text.toLowerCase();
  });
  return hasSyntax ? parts.join(" ") : undefined;
}

function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Whether a recency word ("laatste", "nieuwste", "latest") occurs in a text. */
function hasRecencyMarker(text: string): boolean {
  return RECENCY_MARKERS.some((marker) => {
    marker.lastIndex = 0;
    const hit = marker.test(text);
    marker.lastIndex = 0;
    return hit;
  });
}

/**
 * A Dutch note describing a rewrite, for a tool's access_note — or undefined
 * when the query went out as typed (case, spacing and end punctuation such as
 * a "?" aside). Tools should report every rewrite: a silently changed query
 * makes a "0 results" or an odd hit list impossible to interpret. The note
 * says a recency word was left out only when it is really gone: strict mode
 * sends "laatste" along, and a quoted phrase keeps its words.
 */
export function rewriteNote(rw: Pick<RewriteResult, "original" | "rewritten" | "recency">): string | undefined {
  const original = rw.original.replace(/\s+/g, " ").trim();
  const rewritten = rw.rewritten.trim();
  const withoutEnd = (s: string) => normalizeForCompare(s).replace(/\s*[?!.]+$/, "");
  if (!rewritten || withoutEnd(original) === withoutEnd(rewritten)) return undefined;
  const shown = original.length > 200 ? `${original.slice(0, 197)}...` : original;
  const recency = rw.recency && !hasRecencyMarker(rewritten) ? " (tijdsaanduiding zoals 'laatste' of 'nieuwste' weggelaten; die bepaalt geen volgorde)" : "";
  return `Zoekterm herschreven: "${shown}" → ${quotedQuery(rewritten)}${recency}.`;
}

/**
 * A search query in quotes for a note, or as it is when it holds a phrase in
 * quotes of its own: '"ring utrecht"' in quotes again read as a doubled quote.
 */
export function quotedQuery(query: string): string {
  return query.includes('"') ? query : `"${query}"`;
}

export function rewriteQuery(
  raw: string,
  sensitivity: QuerySensitivity,
): RewriteResult {
  const original = String(raw ?? "").trim();

  if (sensitivity === "passthrough" || !original) {
    return { rewritten: original, original, changed: false };
  }

  const analysis = analyse(original);
  let tokens = analysis.tokens;

  if (sensitivity === "strict") {
    const infixes = infixIndexes(tokens, analysis);
    const all = tokens;
    tokens = tokens.filter(
      (t, i) =>
        t.phrase ||
        infixes.has(i) ||
        isName(t, analysis) ||
        // "OM", "ALS", "WHO": an acronym is no function word, even when its
        // lowercase form is one. "ECLI" stays a legal meta word.
        (!analysis.allCaps && isAcronym(t.text) && t.text !== "ECLI") ||
        Boolean(tokenBinding(all, i)) ||
        !STRICT_META_WORDS.has(t.text.toLowerCase()),
    );
  } else {
    // Moderate: a meta noun on its own goes when a topic word remains;
    // "data" alone or "lijst data" stays as typed.
    const loose = tokens.map((_, i) => isLooseMetaNoun(tokens, i, analysis));
    const hasTopic = tokens.some(
      (t, i) => !loose[i] && !OPERATORS.has(t.text) && (t.phrase || !META_NOUNS.has(t.text.toLowerCase())),
    );
    if (hasTopic) tokens = tokens.filter((_, i) => !loose[i]);
  }

  let rewritten = plainQuery(tokens);
  let syntax = syntaxQuery(tokens);

  // If strict mode stripped everything, fall back to moderate
  if (!rewritten && sensitivity === "strict") {
    const moderate = rewriteQuery(original, "moderate");
    rewritten = moderate.rewritten;
    syntax = moderate.syntaxQuery;
  }

  // Final fallback: never return an empty query. When the frames took
  // everything ("Wat is er?"), the words of the input itself are the best guess.
  if (!rewritten) {
    rewritten = cleanPieces(original.replace(QUOTE_CHARS, " ")).join(" ").toLowerCase() || original;
    syntax = undefined;
  }

  // Re-add recency marker for strict mode (Rechtspraak handler uses it)
  if (analysis.recency && sensitivity === "strict" && !/\blaatste\b/.test(rewritten)) {
    rewritten = `laatste ${rewritten}`;
    if (syntax) syntax = `laatste ${syntax}`;
  }

  const changed = rewritten !== normalizeForCompare(original);
  const result: RewriteResult = {
    rewritten,
    original,
    changed,
    ...(syntax && syntax !== rewritten ? { syntaxQuery: syntax } : {}),
    ...(analysis.recency ? { recency: true } : {}),
  };
  result.explanation = changed ? rewriteNote(result) : undefined;
  return result;
}

/*
 * Time phrases that the temporal parser (utils/temporal.ts) does not turn into
 * a date filter: "deze week", "deze maand", "de afgelopen weken", "de laatste
 * tijd", "onlangs". Left in a keyword query they are searched as topic words:
 * the Tweede Kamer route looked for motions with "week" in the title and found
 * none, where the question asked for the latest motions.
 */
const TIME_DETERMINERS = "deze|dit|afgelopen|vorige|vorig|komende|volgende|volgend|aanstaande|lopende|huidige|laatste|recente|this|last|past|next|coming";
const TIME_COUNTS = "\\d+|twee|drie|vier|vijf|zes|zeven|acht|negen|tien|twaalf|paar|two|three|four|five|six|few";
const TIME_UNITS = "dag|dagen|week|weken|maand|maanden|kwartaal|kwartalen|jaar|jaren|tijd|periode|day|days|weeks?|months?|quarters?|years?";
const TIME_PHRASE_RE = new RegExp(
  `(?<![\\p{L}\\d])(?:${TIME_DETERMINERS})\\s+(?:(?:${TIME_COUNTS})\\s+)?(?:${TIME_UNITS})(?![\\p{L}\\d])` +
    `|(?<![\\p{L}\\d])(?:onlangs|recentelijk|kortgeleden|zojuist|recently|lately)(?![\\p{L}\\d])`,
  "giu",
);

/** Apply `fn` to the parts of a text outside balanced quotes; a quoted phrase is searched as typed. */
function mapUnquoted(text: string, fn: (part: string) => string): string {
  const parts = text.replace(QUOTE_CHARS, '"').split('"');
  return parts.map((part, i) => (i % 2 === 1 && i < parts.length - 1 ? part : fn(part))).join('"');
}

/**
 * Time phrases in a question that no date filter covers ("deze week",
 * "onlangs"); {@link extractKeywords} leaves them out of the search terms. A
 * router can name them so that the answer does not read as filtered by date.
 */
export function looseTimePhrases(raw: string): string[] {
  const found: string[] = [];
  mapUnquoted(String(raw ?? ""), (part) => {
    for (const m of part.matchAll(TIME_PHRASE_RE)) found.push(m[0].replace(/\s+/g, " ").toLowerCase());
    return part;
  });
  return [...new Set(found)];
}

/** A token that is a search term in its own right, for telling an operator from a noun. */
function isKeywordContent(token: Token, analysis: Analysis): boolean {
  if (token.phrase) return true;
  if (OPERATORS.has(token.text)) return false;
  if (!analysis.allCaps && isAcronym(token.text)) return true;
  return !KEYWORD_STOPWORDS.has(token.text.toLowerCase());
}

/**
 * How {@link extractKeywordTerms} formed a term:
 * - "quoted": the user put it in quotes;
 * - "bound": a meta noun bound into a term ("open data portaal", "data
 *   strategie"), also when capitalised ("Open Data Portaal");
 * - "name": a run of capitalised words grouped into one term ("Ring Utrecht",
 *   but also "Schiphol Geluidsoverlast" or "Wet Kwaliteitsborging Bouwen"),
 *   which a document need not hold in that form;
 * - "word": a single word, acronym or number.
 */
export type KeywordTermKind = "quoted" | "bound" | "name" | "word";

export interface KeywordTerm {
  /** The term, lowercased. */
  text: string;
  kind: KeywordTermKind;
}

/**
 * Whether a run of capitalised words is a meta-noun term and nothing more:
 * "Open Data Portaal", "Open Data", "Data Strategie". "Lijst Pim Fortuyn" and
 * "Open Data Portaal Utrecht" are names.
 */
function isBoundRun(words: string[]): boolean {
  const i = words.findIndex((word) => META_NOUNS.has(word));
  if (i < 0) return false;
  const start = i > 0 && metaNounBinding(words[i - 1], words[i], undefined) === "modifier" ? i - 1 : i;
  const end = i + 1 < words.length && metaNounBinding(undefined, words[i], words[i + 1]) === "head" ? i + 1 : i;
  return end > start && start === 0 && end === words.length - 1;
}

/**
 * Topic keywords of a natural-language question, for routers that have to
 * turn "Wat doet de Belastingdienst met de BTW?" into a search ("belastingdienst",
 * "btw") instead of sending the sentence. Question frames, question verbs,
 * function words and time phrases ("deze week", "onlangs", see
 * {@link looseTimePhrases}) go; names, quoted phrases, numbers and tokens such
 * as "B&W" stay.
 *
 * A run of capitalised words is one term ("Open Data Portaal" ->
 * "open data portaal") so a caller can search it as a phrase; so is a meta
 * noun bound into a term ("open data", "open data portaal" in lowercase).
 * Acronyms survive even when they spell a function word ("OM", "IT", "ALS",
 * "WHO"); "OR" is dropped only as an operator between two terms. Terms are
 * lowercased and deduplicated. {@link extractKeywordTerms} also says how each
 * term was formed.
 *
 * `exclude` drops words (or multi-word terms) the caller already acts on, such
 * as the routing word itself ("aanbestedingen") or a place it scopes by. The
 * result can be empty; the caller decides what to do then.
 */
export function extractKeywords(raw: string, options: { exclude?: Iterable<string> } = {}): string[] {
  return extractKeywordTerms(raw, options).map((term) => term.text);
}

/**
 * {@link extractKeywords} with how each term was formed (see
 * {@link KeywordTermKind}). A caller that searches multi-word terms as
 * phrases can tell a phrase the question holds ("quoted", "bound") from a run
 * of capitalised words ("name"), which a source may only hold in other words:
 * "Schiphol Geluidsoverlast" as a phrase finds no paper about noise around
 * Schiphol.
 */
export function extractKeywordTerms(raw: string, options: { exclude?: Iterable<string> } = {}): KeywordTerm[] {
  const original = String(raw ?? "").trim();
  if (!original) return [];

  const analysis = analyse(mapUnquoted(original, (part) => part.replace(TIME_PHRASE_RE, " ")));
  const { tokens } = analysis;
  // Multi-word exclusions ("tweede kamer") are applied word by word: the
  // question's words arrive as separate tokens unless the user capitalised them.
  // They are cleaned like the tokens, so "'s-Hertogenbosch" matches the token
  // "s-hertogenbosch" that the question's apostrophe left.
  const exclude = new Set(
    [...(options.exclude ?? [])].flatMap((x) => cleanPieces(String(x ?? "")).map((w) => w.toLowerCase())),
  );
  const infixes = infixIndexes(tokens, analysis, GROUP_INFIXES);

  const terms: KeywordTerm[] = [];
  const lastTerm = (): string | undefined => terms[terms.length - 1]?.text;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.phrase) {
      terms.push({ text: token.text.toLowerCase(), kind: "quoted" });
      continue;
    }
    // "Vergelijk de moties met het kabinetsbeleid over stikstof": the topic is
    // what is compared. As a search word "vergelijk" made the Tweede Kamer
    // route find nothing and fall back to the single term "kabinetsbeleid".
    if (isComparisonFrame(tokens, i)) continue;

    // Group a run of capitalised words, with infixes between them, into one
    // name. The first word of a sentence is capitalised by grammar, not because
    // it is a name ("Parkeren Delft"), so it never starts one; nor does a
    // stopword, unless it opens a place name before another capitalised word
    // ("Den Haag", "De Bilt", "Ter Apel"): without it "Den Haag" became "haag".
    const next = tokens[i + 1];
    const opensName = NAME_LEADING_WORDS.has(token.text.toLowerCase()) && Boolean(next) && !next.phrase && isTitleCase(next.text);
    const canStart =
      !analysis.allCaps &&
      !token.sentenceInitial &&
      isTitleCase(token.text) &&
      (!KEYWORD_STOPWORDS.has(token.text.toLowerCase()) || opensName);
    if (canStart) {
      let j = i + 1;
      let end = i;
      while (j < tokens.length && !tokens[j].phrase && (isTitleCase(tokens[j].text) || infixes.has(j))) {
        if (isTitleCase(tokens[j].text)) end = j;
        j++;
      }
      if (end > i) {
        const words = tokens.slice(i, end + 1).map((t) => t.text.toLowerCase());
        // "Open Data Portaal" at the start of the input: "Open" is no name
        // start (sentence-initial), but it does bind "Data".
        const prev = tokens[i - 1];
        if (prev && !prev.phrase && metaNounBinding(prev.text, token.text, undefined) === "modifier" && lastTerm() === prev.text.toLowerCase()) {
          terms.pop();
          words.unshift(prev.text.toLowerCase());
        }
        terms.push({ text: words.join(" "), kind: isBoundRun(words) ? "bound" : "name" });
        i = end;
        continue;
      }
    }

    const lower = token.text.toLowerCase();

    if (OPERATORS.has(token.text)) {
      // "OV OR fietspaden": an operator between two terms is search syntax.
      // "de OR" is the works council (ondernemingsraad), a topic.
      const between = i > 0 && i < tokens.length - 1 && isKeywordContent(tokens[i - 1], analysis) && isKeywordContent(tokens[i + 1], analysis);
      if (!between && token.text === "OR" && !analysis.allCaps) terms.push({ text: lower, kind: "word" });
      continue;
    }

    // A meta noun bound into a term ("open data", "open data portaal",
    // "medische gegevens") is kept whole, so an exclusion of "data" cannot
    // turn "open data portaal" into "open portaal".
    const binding = META_NOUNS.has(lower) ? tokenBinding(tokens, i) : undefined;
    if (binding) {
      const words = [lower];
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      if (prev && !prev.phrase && metaNounBinding(prev.text, lower, undefined) === "modifier") {
        if (lastTerm() === prev.text.toLowerCase()) terms.pop();
        words.unshift(prev.text.toLowerCase());
      }
      if (next && !next.phrase && metaNounBinding(undefined, lower, next.text) === "head") {
        words.push(next.text.toLowerCase());
        i++;
      }
      terms.push({ text: words.join(" "), kind: "bound" });
      continue;
    }

    if (!analysis.allCaps && isAcronym(token.text)) {
      terms.push({ text: lower, kind: "word" });
      continue;
    }
    if (KEYWORD_STOPWORDS.has(lower)) continue;
    terms.push({ text: lower, kind: "word" });
  }

  // A name or phrase is excluded only when every word of it is ("Gemeente
  // Utrecht" when scoping by gemeente Utrecht); "Open Data Portaal" survives an
  // exclusion of "data".
  const seen = new Set<string>();
  return terms.filter(({ text }) => {
    if (text.split(" ").every((word) => exclude.has(word)) || seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}
