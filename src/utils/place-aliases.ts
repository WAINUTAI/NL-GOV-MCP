/**
 * Dutch place names, as the different sources actually spell them.
 *
 * The same municipality is published under genuinely different names depending
 * on who publishes it. For Den Haag alone:
 *
 *   Luchtmeetnet        "Den Haag-Bleriotlaan"   stations use the everyday name
 *   Kiesraad            "'s-Gravenhage"          official name
 *   DUO PLAATSNAAM      "'S-GRAVENHAGE"          official, upper-cased
 *   DUO GEMEENTENAAM    "S GRAVENHAGE"           apostrophe *and* hyphen dropped
 *
 * There is therefore no single canonical spelling to normalise to — a caller
 * has to try the variants until one resolves. Two things vary independently:
 * which *name* is used, and which *punctuation*. This module generates both.
 *
 * Scope check against the Kiesraad's 352 published areas: 's-Gravenhage and
 * 's-Hertogenbosch are the only official names carrying an apostrophe, and the
 * only two whose everyday name differs from the official one. Every other name
 * differs at most in hyphens and spacing, which the punctuation variants cover.
 */

/**
 * Names that refer to the same place. Every member is interchangeable with
 * every other; the first is the official name, for readability only.
 *
 * Kept deliberately short: the PDOK Locatieserver already resolves "Den Bosch"
 * and "Den Haag" itself, so this list exists for the sources that match names
 * exactly (Kiesraad, DUO, Luchtmeetnet) and for the names PDOK does *not* know
 * — the English and Frisian ones.
 */
const ALIAS_GROUPS: readonly (readonly string[])[] = [
  ["'s-Gravenhage", "Den Haag", "The Hague"],
  ["'s-Hertogenbosch", "Den Bosch"],
  // Kiesraad and PDOK publish the province as Fryslân; plenty of people type Friesland.
  ["Fryslân", "Friesland"],
  ["Leeuwarden", "Ljouwert"],
];

/**
 * Fold a place name to a comparison key: case, accents and punctuation removed.
 *
 * This is what makes DUO's two spellings of one municipality collapse onto each
 * other — "'S-GRAVENHAGE" and "S GRAVENHAGE" both key to "s gravenhage".
 */
export function placeKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const ALIASES_BY_KEY = new Map<string, readonly string[]>();
for (const group of ALIAS_GROUPS) {
  for (const member of group) {
    ALIASES_BY_KEY.set(placeKey(member), group);
  }
}

/**
 * Spellings of one name that differ only in punctuation.
 *
 * Needed because DUO filters server-side on an exact string: folding on our side
 * cannot help, we have to send the spelling it stores.
 */
function punctuationVariants(name: string): string[] {
  const withoutApostrophes = name.replace(/['’]/g, "");
  return [
    name,
    withoutApostrophes,
    name.replace(/-/g, " "),
    withoutApostrophes.replace(/-/g, " "),
  ];
}

/**
 * Every spelling a place may be stored under, caller's own first.
 *
 * Order matters: consumers try these in sequence and keep the first that
 * resolves, so the name the user actually typed gets the first shot.
 */
export function placeVariants(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];

  const group = ALIASES_BY_KEY.get(placeKey(trimmed)) ?? [];
  const ordered = [trimmed, ...group.filter((member) => placeKey(member) !== placeKey(trimmed))];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of ordered.flatMap(punctuationVariants)) {
    const cleaned = candidate.replace(/\s+/g, " ").trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/**
 * The folded keys a place may be stored under — for sources that match names
 * client-side against a list they already hold.
 */
export function placeKeys(name: string): Set<string> {
  return new Set(placeVariants(name).map(placeKey).filter(Boolean));
}
