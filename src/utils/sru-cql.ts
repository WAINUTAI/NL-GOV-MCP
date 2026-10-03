/**
 * CQL helpers for the KOOP SRU endpoints (repository.overheid.nl).
 *
 * The KOOP SRU parser accepts bare terms as free text, but ONLY one term at a
 * time: `c.product-area==tuchtrecht AND medicatiefout huisarts` is a CQL syntax
 * error (diagnostic info:srw/diagnostic/1/10, "mismatched input"), which the
 * server returns as a response with no records — a silent zero result rather
 * than a visible failure.
 *
 * So multi-word free text has to become `term AND term`, which is both valid and
 * the behaviour users expect from a search box. A quoted string is a phrase
 * (adjacent words, in order): `"zorg en veiligheid"` matches 1,730 publications
 * where `zorg AND veiligheid` matches 150,580 — useful when the caller quotes on
 * purpose, wrong as a default, because `"medicatiefout huisarts"` matches nothing
 * while `medicatiefout AND huisarts` finds 6 rulings.
 *
 * There are two renderers:
 *
 * - freeTextCql() is the plain AND-join the KOOP collection tools (tuchtrecht,
 *   samenwerkende catalogi) have always used. Its output is frozen: those tools
 *   do not report a rewritten query, so changing it would silently change their
 *   results.
 * - freeTextCqlPlan() is what officiele_bekendmakingen_search uses, and reports
 *   what it did so the tool can say so in access_note. Measured live (October
 *   2026), it improves on the AND-join in four ways:
 *   - Dutch function words ("en", "de", "van") are not made required terms. In
 *     long documents they change nothing (adding `AND en` left the count of a
 *     query unchanged), but short texts do not all contain them.
 *   - A hyphenated compound can be searched as the compound OR its parts. On its
 *     own the index reads a compound such as `OV-visie` as the phrase "OV visie"
 *     (a handful of publications in the measured case, against thousands for the
 *     parts ANDed), so it misses every text that only writes the two words
 *     apart. The caller decides whether to expand (bekendmakingen.ts puts the
 *     exact hits first).
 *   - Quoted phrases and slash citations ("2016/679") stay exact.
 *   - Apostrophes inside words ("'s-Gravenhage", "auto's") are kept, and
 *     characters the server chokes on (braces, wildcards) are stripped.
 */

/** Escape a value for use inside double-quoted CQL/SRU strings. */
export function escapeSruValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Characters that carry CQL meaning or break the upstream parser. Stripped from
 * bare terms rather than escaped: as a bare term they would break the parse, and
 * escaping them buys nothing for a full-text index.
 *
 * - double quotes, comparison operators, parentheses and slashes are CQL syntax;
 * - `{` / `}` make the server answer HTTP 500, even inside a quoted phrase;
 * - `*` and `?` are masking characters: a word cut off with `*` matched a single
 *   publication where the whole word matched thousands (the index already stems:
 *   the plural matches the same set), so a typed wildcard only ever hurts;
 * - `[ ] | ~ ^` have no meaning in a Dutch search box.
 *
 * Apostrophes are NOT in this list: a bare `'s-Gravenhage` parses fine and
 * matches 15,078 publications from 2026, where the stripped `s-Gravenhage`
 * matches 1,009; "auto's" needs its apostrophe just as much. Only apostrophes
 * used as quotation marks are dropped (see sanitizeToken).
 */
const CQL_META = /["()<>=/\\{}[\]|~^*?]/g;

/** Inside a quoted phrase only the characters that break the parser go. */
const PHRASE_META = /["\\{}[\]|~^*?]/g;

/**
 * A `+` between two letters or digits ("parkeren+wonen", "1+1") makes the
 * server reject the whole query ("mismatched input '<EOF>'"); a trailing one
 * ("65+", "LHBTI+") parses fine. An inner one joins two words, so it becomes a
 * space: "parkeren+wonen" is searched as parkeren AND wonen.
 */
const INNER_PLUS = /(?<=[\p{L}\p{N}])\+(?=[\p{L}\p{N}])/gu;

/**
 * A CQL sort clause typed into the search box ("zorg sortBy dt.date"). As free
 * text, "sortBy" is dropped as a keyword and "dt.date" is left as a word that
 * matches nothing; the tools have their own sort parameter.
 */
const TRAILING_SORT_CLAUSE = /(?:^|\s+)sortby(?:\s+[a-z]+\.[\w./-]*)+\s*$/i;

/** CQL keywords, which cannot appear as bare search terms. */
const CQL_KEYWORDS = new Set(["and", "or", "not", "prox", "sortby"]);

/**
 * Dutch (and a few English) function words that should not become required
 * terms. Deliberately conservative: words that double as a common abbreviation
 * once the query rewriter has lowercased them stay searchable — "om" (Openbaar
 * Ministerie), "als" (ALS), "is" (IS) — and so do the infixes that are part of
 * place names a user may type ("den" in Den Helder, where dropping it would leave
 * the adjective "helder").
 */
const STOPWORDS = new Set([
  "de", "het", "een", "en", "of", "van", "voor", "in", "op", "te", "met", "aan",
  "bij", "door", "tot", "uit", "over", "naar", "dat", "die", "dit", "deze",
  "'s", "'t", "the", "to", "for", "with", "from",
]);

function sanitizeToken(token: string): string {
  return token
    .replace(/[‘’]/g, "'")
    .replace(CQL_META, "")
    // Apostrophes as quotation marks ('woord') go; the elided article of
    // 's-Hertogenbosch / 't-Zand and word-internal ones (auto's) stay.
    .replace(/^'+(?![st]-)/i, "")
    .replace(/'+$/, "")
    // A leading or trailing hyphen is punctuation ("zorg-" in "zorg- en welzijn").
    .replace(/^-+|-+$/g, "")
    .trim();
}

function isSearchable(token: string): boolean {
  // Drop punctuation-only leftovers and single characters, which only add noise.
  return token.length > 1 && /[\p{L}\p{N}]/u.test(token);
}

/**
 * Split free text into CQL-safe bare terms — the plain tokenisation behind
 * freeTextCql(), unchanged since the KOOP collection tools started using it
 * except for an inner `+` (INNER_PLUS), which used to make the server reject
 * the query.
 *
 * Characters that carry CQL meaning (quotes, apostrophes, comparison operators,
 * parentheses, slashes) are stripped rather than escaped: as a bare term they
 * would break the parse, and escaping them buys nothing for a full-text index.
 */
export function freeTextCqlTerms(input: string | undefined): string[] {
  const raw = (input ?? "").trim();
  if (!raw) return [];

  return raw
    .replace(INNER_PLUS, " ")
    .split(/\s+/)
    .map((token) => token.replace(/["'()<>=/\\]/g, "").trim())
    // Drop punctuation-only leftovers and single characters, which only add noise.
    .filter((token) => token.length > 1 && /[\p{L}\p{N}]/u.test(token))
    // CQL keywords cannot appear as bare search terms.
    .filter((token) => !["and", "or", "not", "prox"].includes(token.toLowerCase()));
}

/**
 * Render free text as an AND-joined CQL fragment, or undefined when it is empty.
 * Frozen behaviour for koop-collecties.ts; new callers want freeTextCqlPlan().
 */
export function freeTextCql(input: string | undefined): string | undefined {
  const terms = freeTextCqlTerms(input);
  return terms.length ? terms.join(" AND ") : undefined;
}

/** The planner's tokenisation: every searchable token, function words included. */
function planTerms(input: string): string[] {
  return input
    .replace(INNER_PLUS, " ")
    .split(/\s+/)
    .map(sanitizeToken)
    .filter(isSearchable)
    .filter((token) => !CQL_KEYWORDS.has(token.toLowerCase()));
}

/** How free text was turned into CQL — so a tool can say what it searched for. */
export interface FreeTextCqlPlan {
  /** The CQL fragment, or undefined when nothing searchable is left. */
  cql?: string;
  /** Function words typed by the caller that were not made required terms. */
  droppedStopwords: string[];
  /** Hyphenated compounds searched as "compound OR parts". */
  expandedCompounds: string[];
  /** Hyphenated compounds kept exact because expandCompounds was off. */
  exactCompounds: string[];
  /** Quoted multi-word phrases searched as an exact phrase. */
  phrases: string[];
  /** CQL syntax typed into the free text and left out ("sortBy dt.date"). */
  droppedSyntax: string[];
}

function isStopword(token: string): boolean {
  return STOPWORDS.has(token.toLowerCase());
}

/**
 * A hyphenated compound worth splitting: at least two parts, each with a letter
 * and more than one character, none of them an elided article. "e-mail",
 * "'s-Gravenhage" and "COVID-19" (a part without letters) stay a single phrase —
 * splitting them would search for "mail", "Gravenhage" or every document that
 * mentions COVID.
 */
function compoundParts(term: string): string[] | undefined {
  if (!term.includes("-")) return undefined;
  const parts = term.split("-").filter(Boolean);
  if (parts.length < 2) return undefined;
  const splittable = parts.every(
    (part) => part.length > 1 && /\p{L}/u.test(part) && !/^'[st]$/i.test(part),
  );
  return splittable ? parts : undefined;
}

/**
 * The words a hyphenated compound is matched on besides the compound itself:
 * its parts without function words ("Bergen-op-Zoom" -> Bergen, Zoom), or
 * undefined when the term is not split at all.
 */
export function compoundSearchParts(term: string): string[] | undefined {
  const parts = compoundParts(term);
  if (!parts) return undefined;
  const content = parts.filter((part) => !isStopword(part));
  return content.length ? content : parts;
}

function renderTerm(term: string, plan: FreeTextCqlPlan, expandCompounds: boolean): string {
  const parts = compoundSearchParts(term);
  if (!parts) return term;
  if (!expandCompounds) {
    plan.exactCompounds.push(term);
    return term;
  }
  plan.expandedCompounds.push(term);
  return `("${escapeSruValue(term)}" OR (${parts.join(" AND ")}))`;
}

/**
 * A token with a slash between letters or digits: a citation or case number
 * ("2016/679", "C2023/2052"). Stripping the slash leaves a token that matches
 * nothing (the two numbers run together), and a bare slash is CQL syntax; quoted,
 * `"2016/679"` finds the publications citing that regulation and
 * `"C2023/2052"` the 2 tuchtrecht rulings with that case number.
 */
const SLASHED_TOKEN = /(^|\s)([^\s"]*[\p{L}\p{N}]\/[\p{L}\p{N}][^\s"]*)(?=\s|$)/gu;

/**
 * A quoted phrase must open at the start of a word and close at the end of one
 * (optionally followed by punctuation). Quotes anywhere else — `zorg"` or
 * `=="x` — are stray characters and are stripped like any other CQL syntax.
 */
const PHRASE = /(^|\s)"([^"]+)"(?=[\s,.;:!?]|$)/g;

export interface FreeTextCqlOptions {
  /**
   * Match hyphenated compounds as "compound OR parts" (default true). The
   * server does NOT reliably rank the exact compound first: in a measured
   * case, of the 6 publications with the exact compound, 3 ranked 1-3 among the
   * thousands of hits of `("X-visie" OR (X AND visie))`, one 24th and two below
   * 100. Sorted by date it is worse: every recent omgevingsvisie that mentions
   * the acronym somewhere lands above the policy documents asked for. A caller
   * that expands should therefore put the exact hits first itself (see
   * bekendmakingen.ts).
   */
  expandCompounds?: boolean;
}

/**
 * Plan the CQL for free text: AND-joined terms, quoted phrases kept as phrases,
 * function words left out (unless nothing else is left) and hyphenated compounds
 * matched as compound or parts.
 */
export function freeTextCqlPlan(input: string | undefined, options: FreeTextCqlOptions = {}): FreeTextCqlPlan {
  const expandCompounds = options.expandCompounds ?? true;
  const plan: FreeTextCqlPlan = { droppedStopwords: [], expandedCompounds: [], exactCompounds: [], phrases: [], droppedSyntax: [] };
  let raw = (input ?? "").trim();
  if (!raw) return plan;
  const sortClause = TRAILING_SORT_CLAUSE.exec(raw);
  if (sortClause) {
    plan.droppedSyntax.push(sortClause[0].trim());
    raw = raw.slice(0, sortClause.index).trim();
  }

  const parts: string[] = [];
  // "en/of" is a conjunction: left out, unless nothing else is searched for.
  const slashedStopwords: string[] = [];

  const rest = raw.replace(PHRASE, (_match, lead: string, inner: string) => {
    const words = inner
      .split(/\s+/)
      .map((word) => word.replace(PHRASE_META, "").trim())
      .filter((word) => /[\p{L}\p{N}]/u.test(word));
    // Several words, or one quoted compound ("OV-visie"): the caller asked for
    // exactly this, so it is not split.
    if (words.length > 1 || (words.length === 1 && compoundParts(words[0]))) {
      const phrase = words.join(" ");
      plan.phrases.push(phrase);
      parts.push(`"${escapeSruValue(phrase)}"`);
      return `${lead} `;
    }
    // A quoted single plain word is just a word: hand it back to the term handling.
    return `${lead}${words.join(" ")} `;
  }).replace(SLASHED_TOKEN, (_match, lead: string, token: string) => {
    const citation = token
      .replace(PHRASE_META, "")
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!citation) return `${lead} `;
    // "en/of" is a conjunction, not a citation.
    if (citation.split("/").every(isStopword)) {
      slashedStopwords.push(citation);
      return `${lead} `;
    }
    plan.phrases.push(citation);
    parts.push(`"${escapeSruValue(citation)}"`);
    return `${lead} `;
  });

  // A repeated word is one requirement, not two ("zorg zorg-" -> zorg).
  const seen = new Set<string>();
  const terms = planTerms(rest).filter((term) => {
    const key = term.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const content = terms.filter((term) => !isStopword(term));
  // Only function words typed ("de", "het", "en/of")? Then they are the query.
  const keep = content.length || parts.length ? content : terms;
  if (!keep.length && !parts.length) {
    for (const citation of slashedStopwords) {
      plan.phrases.push(citation);
      parts.push(`"${escapeSruValue(citation)}"`);
    }
  } else {
    plan.droppedStopwords.push(...slashedStopwords);
  }
  plan.droppedStopwords.push(...terms.filter((term) => !keep.includes(term)));

  for (const term of keep) parts.push(renderTerm(term, plan, expandCompounds));

  plan.cql = parts.length ? parts.join(" AND ") : undefined;
  return plan;
}
