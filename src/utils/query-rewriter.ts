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
 *   "moderate"    – Strip question framing but keep contextual words.
 *                    Use for tolerant full-text APIs (CKAN, CBS, etc.).
 *   "passthrough" – Return input unchanged.
 *                    Use for SPARQL, identifiers, license plates, etc.
 */

export type QuerySensitivity = "strict" | "moderate" | "passthrough";

/* ------------------------------------------------------------------ */
/*  1.  Question-frame patterns (NL + EN)                             */
/*      These match the "wrapper" around the actual topic.            */
/* ------------------------------------------------------------------ */

const QUESTION_FRAMES: RegExp[] = [
  // "Wat is / zijn / was … de / het …"
  /^(?:wat|welke?|hoeveel|wanneer|waar|wie|hoe)\s+(?:is|zijn|was|waren|wordt|worden|heeft|hebben|kan|kunnen|mag|mogen|zal|zullen)\s+(?:de|het|een|er|daar|hier)?\s*/i,

  // "Geef (mij) (de) (informatie/datasets) (over) …"
  /^(?:geef|toon|laat|zoek|vind|haal|pak)\s+(?:mij|me|ons|eens)?\s*(?:de|het|een|alle|meer)?\s*(?:informatie|info|gegevens|datasets?|data|resultaten|overzicht|lijst|uitspraken?)?\s*(?:over|van|voor|met|uit|naar|omtrent|betreffende|inzake|rondom|aangaande)?\s*/i,

  // "Ik wil / zoek (graag) (informatie) (over) …"
  /^(?:ik\s+(?:wil|zoek|vraag|ben\s+op\s+zoek\s+naar)\s+(?:graag\s+)?(?:informatie|info|gegevens|data|meer)?\s*(?:over|van|voor|naar|omtrent)?)\s*/i,

  // "Kun je (mij) vertellen / zoeken / geven (over) …"
  /^(?:kun|kan)\s+(?:je|jij|u)\s+(?:mij|me)?\s*(?:vertellen|laten\s+zien|zoeken|vinden|geven|opzoeken)?\s*(?:over|naar|van|voor)?\s*/i,

  // EN: "What is / are / was …", "Show me …", "Find …", "Give me …"
  /^(?:what|which|how\s+many|when|where|who)\s+(?:is|are|was|were|does|do|has|have|can|could|will|would)\s+(?:the|a|an)?\s*/i,
  /^(?:show|find|give|get|search|look\s+up|tell)\s+(?:me|us)?\s*(?:the|a|an|all|some|more)?\s*(?:information|info|data|results|details)?\s*(?:about|on|for|of|regarding|related\s+to)?\s*/i,
];

/* ------------------------------------------------------------------ */
/*  2.  Mid-sentence connectors / noise that sit between frame & topic*/
/* ------------------------------------------------------------------ */

const MID_NOISE: RegExp[] = [
  // "dat gaat over (het onderwerp)", "die gaan over", "met betrekking tot"
  /\b(?:dat|die|welke?)\s+(?:gaat|gaan|gingen)\s+(?:over)\s*(?:het\s+onderwerp)?\s*/gi,
  /\bmet\s+betrekking\s+tot\b/gi,
  /\bop\s+het\s+gebied\s+van\b/gi,
  /\bals\s+het\s+gaat\s+om\b/gi,
  /\bin\s+relatie\s+tot\b/gi,
  /\b(?:het\s+onderwerp|het\s+thema|het\s+topic)\s*/gi,
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
  // EN function words
  "about", "all", "and", "any", "are", "around", "been", "but", "can",
  "did", "does", "find", "for", "from", "get", "give", "has", "have",
  "how", "its", "not", "off", "out", "own", "regarding", "show", "some",
  "that", "the", "was", "what", "when", "which", "who", "will", "with",
  "you",
]);

/* ------------------------------------------------------------------ */
/*  6.  Moderate-mode: only the most obvious non-topic words          */
/* ------------------------------------------------------------------ */

const MODERATE_META_WORDS = new Set([
  "informatie", "info", "gegevens", "data", "resultaten", "overzicht",
  "lijst", "onderwerp", "thema", "topic",
]);

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export interface RewriteResult {
  /** The cleaned query to send to the API */
  rewritten: string;
  /** The original query (for logging / provenance) */
  original: string;
  /** Whether any rewriting was performed */
  changed: boolean;
  /** What the rewriter did (human-readable, for access_note) */
  explanation?: string;
}

export function rewriteQuery(
  raw: string,
  sensitivity: QuerySensitivity,
): RewriteResult {
  const original = raw.trim();

  if (sensitivity === "passthrough" || !original) {
    return { rewritten: original, original, changed: false };
  }

  let q = original;

  // Step 1: Strip question frames
  for (const frame of QUESTION_FRAMES) {
    q = q.replace(frame, "");
  }

  // Step 2: Strip mid-sentence connectors
  for (const noise of MID_NOISE) {
    q = q.replace(noise, " ");
  }

  // Step 3: Strip trailing noise
  for (const trail of TRAILING_NOISE) {
    q = q.replace(trail, "");
  }

  // Step 4: For recency, keep a marker but strip the framing
  let hasRecency = false;
  for (const marker of RECENCY_MARKERS) {
    if (marker.test(original)) {
      hasRecency = true;
      break;
    }
  }
  // Remove recency phrases from query body (the source handler deals with sort order)
  for (const marker of RECENCY_MARKERS) {
    q = q.replace(marker, " ");
  }

  // Step 5: Tokenize and filter based on sensitivity
  const metaWords = sensitivity === "strict" ? STRICT_META_WORDS : MODERATE_META_WORDS;

  const tokens = q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")  // keep letters, numbers, hyphens
    .split(/\s+/)
    .filter((t) => t.length > 1 && !metaWords.has(t));

  let rewritten = tokens.join(" ").trim();

  // If strict mode stripped everything, fall back to moderate
  if (!rewritten && sensitivity === "strict") {
    const moderateTokens = q
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !MODERATE_META_WORDS.has(t));
    rewritten = moderateTokens.join(" ").trim();
  }

  // Final fallback: return original if rewriting produced nothing
  if (!rewritten) {
    return { rewritten: original, original, changed: false };
  }

  // Re-add recency marker for strict mode (Rechtspraak handler uses it)
  if (hasRecency && sensitivity === "strict" && !/\blaatste\b/.test(rewritten)) {
    rewritten = `laatste ${rewritten}`;
  }

  const changed = rewritten !== original.toLowerCase().trim();

  return {
    rewritten,
    original,
    changed,
    explanation: changed
      ? `Query herschreven: "${original}" → "${rewritten}"${hasRecency ? " (recency-intent behouden)" : ""}`
      : undefined,
  };
}
