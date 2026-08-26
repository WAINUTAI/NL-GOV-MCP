/**
 * CQL helpers for the KOOP SRU endpoints (repository.overheid.nl).
 *
 * The KOOP SRU parser accepts bare terms as free text, but ONLY one term at a
 * time: `c.product-area==tuchtrecht AND medicatiefout huisarts` is a CQL syntax
 * error (diagnostic info:srw/diagnostic/1/10, "mismatched input"), which the
 * server returns as a response with no records — a silent zero result rather
 * than a visible failure. Quoting the phrase is no fix either: these indexes have
 * no phrase search, so `"medicatiefout huisarts"` matches nothing.
 *
 * So multi-word free text has to become `term AND term`, which is both valid and
 * the behaviour users expect from a search box.
 */

/** Escape a value for use inside double-quoted CQL/SRU strings. */
export function escapeSruValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Split free text into CQL-safe bare terms.
 *
 * Characters that carry CQL meaning (quotes, comparison operators, parentheses,
 * slashes) are stripped rather than escaped: as a bare term they would break the
 * parse, and escaping them buys nothing for a full-text index.
 */
export function freeTextCqlTerms(input: string | undefined): string[] {
  const raw = (input ?? "").trim();
  if (!raw) return [];

  return raw
    .split(/\s+/)
    .map((token) => token.replace(/["'()<>=/\\]/g, "").trim())
    // Drop punctuation-only leftovers and single characters, which only add noise.
    .filter((token) => token.length > 1 && /[\p{L}\p{N}]/u.test(token))
    // CQL keywords cannot appear as bare search terms.
    .filter((token) => !["and", "or", "not", "prox"].includes(token.toLowerCase()));
}

/** Render free text as an AND-joined CQL fragment, or undefined when it is empty. */
export function freeTextCql(input: string | undefined): string | undefined {
  const terms = freeTextCqlTerms(input);
  return terms.length ? terms.join(" AND ") : undefined;
}
