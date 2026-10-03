import type { AppConfig } from "../types.js";
import { getText } from "../utils/http.js";
import { htmlToText } from "../utils/html-text.js";
import { fetchPdfText } from "../utils/pdf-text.js";
import { placeKey, placeVariants } from "../utils/place-aliases.js";
import type { RewriteResult } from "../utils/query-rewriter.js";
import { extractSruRecords, parseXml } from "../utils/xml-parser.js";
import { compoundSearchParts, escapeSruValue, freeTextCqlPlan } from "../utils/sru-cql.js";

/*
 * Officiële Bekendmakingen via the KOOP SRU endpoint (repository.overheid.nl/sru,
 * product area "officielepublicaties").
 *
 * Index behaviour this module relies on, all verified live (October 2026):
 *
 * - `dt.creator="X"` is a case- and accent-insensitive PHRASE CONTAINMENT match:
 *   "Utrecht" also matches "Rechtbank Utrecht", "Binnenlandse Zaken" matches
 *   "Ministerie van Binnenlandse Zaken en Koninkrijksrelaties", and
 *   "Gemeente Gouda" matches nothing, because the source stores "Gouda".
 * - `w.organisatietype` carries the kind of publisher ("gemeente", "provincie",
 *   "waterschap", "ministerie", "staten generaal", ...) on every record, which is
 *   what tells gemeente Utrecht (103,496 publications) from provincie Utrecht
 *   (11,445).
 * - `w.publicatienaam` is the journal (Gemeenteblad, Staatscourant, Provinciaal
 *   blad, ...). `dt.type` is the document kind ("Kamerstuk", "beleidsregel",
 *   "ander besluit van algemene strekking"); `dt.type="Staatscourant"` matches 0.
 * - `dt.date` is the date of the document itself (dagtekening, DCTERMS.issued on
 *   the website); `dt.available` is the publication date the website shows as
 *   "Datum publicatie". For kst-37020-IX-40 they are 2026-10-01 and 2026-10-02;
 *   for Handelingen they can be months apart.
 * - `<cql> sortBy dt.date/sort.descending` sorts server-side (`/descending`
 *   without the "sort." prefix is a diagnostic; the sortKeys parameter is
 *   ignored).
 * - startRecord >= 10000 is answered with an nginx HTTP 504 within ~100 ms, for
 *   any maximumRecords: only the first ~10,000 hits of a result set are reachable.
 * - An invalid query is not an HTTP error but a 200 response with a
 *   <diagnostics> block and no numberOfRecords. A clause the server cannot use
 *   (`dt.date<=2026-02-29`) is different: it is ignored, with a
 *   SEARCH-IGNOREDQTEXT diagnostic next to the count and records of the rest.
 * - `dt.identifier="x"` matches every identifier containing x as whole tokens
 *   ("kst-37020-IX" gives that dossier's 40 documents); `dt.identifier=="x"` is
 *   exact but case-sensitive.
 * - `dt.creator=="x"` is exact too, but no use for authority: the source has
 *   older and variant spellings ("Utrecht (Utr)" up to early 2016, "Súdwest
 *   Fryslân" up to 2016) that an exact match on one name misses. They are the
 *   same publisher (FORMER_CREATOR_SPELLING, publisherNote).
 * - CQL NOT is accepted but unusable for free text: `... NOT
 *   cql.textAndIndexes="x"` changes how the other bare terms match (259 -> 555).
 */

const SEARCH_PAGE = "https://zoek.officielebekendmakingen.nl/resultaten";
const DOCUMENT_PAGE = "https://zoek.officielebekendmakingen.nl";

/** Highest startRecord the SRU server still serves (see the module comment). */
export const SRU_MAX_START_RECORD = 9999;

/** Default and maximum number of characters of document text record_get returns. */
export const DEFAULT_TEXT_CHARS = 12_000;
export const MAX_TEXT_CHARS = 100_000;

/** w.organisatietype values, as the source publishes them (scan of the index). */
export const AUTHORITY_TYPES = [
  "gemeente",
  "provincie",
  "waterschap",
  "ministerie",
  "staten generaal",
  "zelfstandig bestuursorgaan",
  "regionaal samenwerkingsorgaan",
  "rechterlijke macht",
  "dienst en agentschap",
  "openbaar lichaam voor bedrijf en beroep",
  "adviescollege",
  "hoog college van staat",
  "politiekorps",
  "ggd",
  "deelgemeente",
] as const;
export type AuthorityType = (typeof AUTHORITY_TYPES)[number];

export type BekendmakingenSort = "relevance" | "date_newest" | "date_oldest";
export type BekendmakingenDateField = "dagtekening" | "publicatiedatum";

/* ------------------------------------------------------------------ */
/*  Journals (publicatiebladen)                                        */
/* ------------------------------------------------------------------ */

interface Journal {
  /** The w.publicatienaam value. */
  name: string;
  /** Spellings a caller may use, compared after placeKey() folding. */
  aliases: string[];
  /** True when the name is ALSO a dt.type value ("Kamerstuk" is both). */
  alsoDocumentType?: boolean;
}

const JOURNALS: readonly Journal[] = [
  { name: "Gemeenteblad", aliases: ["gmb"] },
  { name: "Provinciaal blad", aliases: ["prb", "provinciaalblad", "provinciale blad"] },
  { name: "Waterschapsblad", aliases: ["wsb"] },
  { name: "Blad gemeenschappelijke regeling", aliases: ["bgr"] },
  { name: "Staatscourant", aliases: ["stcrt"] },
  { name: "Staatsblad", aliases: ["stb"] },
  { name: "Tractatenblad", aliases: ["trb"] },
  { name: "Kamerstuk", aliases: ["kamerstukken", "kst"], alsoDocumentType: true },
  { name: "Handelingen", aliases: ["handeling"], alsoDocumentType: true },
  { name: "Kamervragen (Aanhangsel)", aliases: ["aanhangsel", "aanhangsel van de handelingen", "ah"], alsoDocumentType: true },
  { name: "Kamervragen zonder antwoord", aliases: ["kv"], alsoDocumentType: true },
  { name: "Niet-dossierstuk", aliases: ["nds"], alsoDocumentType: true },
  { name: "Agenda", aliases: [], alsoDocumentType: true },
];

const JOURNAL_BY_KEY = new Map<string, Journal>();
for (const journal of JOURNALS) {
  for (const spelling of [journal.name, ...journal.aliases]) {
    JOURNAL_BY_KEY.set(placeKey(spelling), journal);
  }
}

export const JOURNAL_NAMES = JOURNALS.map((journal) => journal.name);

function findJournal(value: string): Journal | undefined {
  return JOURNAL_BY_KEY.get(placeKey(value));
}

/** Split "Gemeenteblad, Provinciaal blad" into known journal names and unknown leftovers. */
export function resolvePublicatiebladen(input: string | undefined): { names: string[]; unknown: string[] } {
  const names: string[] = [];
  const unknown: string[] = [];
  for (const raw of (input ?? "").split(/[,;]/)) {
    const value = raw.trim();
    if (!value) continue;
    const journal = findJournal(value);
    if (journal) {
      if (!names.includes(journal.name)) names.push(journal.name);
    } else if (!unknown.includes(value)) {
      unknown.push(value);
    }
  }
  return { names, unknown };
}

/* ------------------------------------------------------------------ */
/*  Authority (publisher) normalisation                                */
/* ------------------------------------------------------------------ */

interface AuthorityPrefix {
  pattern: RegExp;
  type: AuthorityType;
  /**
   * Water authorities carry their prefix in the official name ("Waterschap
   * Rivierenland", "Hoogheemraadschap van Rijnland"), so the name as typed is
   * what is searched; "Gemeente Gouda" never is a creator. The stripped name is
   * only a fallback: as a containment match, "Rijnland" also hits
   * "Hoogheemraadschap De Stichtse Rijnlanden" (15,744 extra publications).
   */
  keepTyped: boolean;
}

const AUTHORITY_PREFIXES: readonly AuthorityPrefix[] = [
  { pattern: /^gemeente\s+/i, type: "gemeente", keepTyped: false },
  { pattern: /^provincie\s+/i, type: "provincie", keepTyped: false },
  { pattern: /^(?:waterschap|hoogheemraadschap(?:\s+van)?|wetterskip)\s+/i, type: "waterschap", keepTyped: true },
];

/**
 * Creator spellings that differ from the official municipality name. PDOK and the
 * Kiesraad call it "Hengelo (O)"; Officiële Bekendmakingen publishes it as
 * "Hengelo" (15,421 publications, 0 under "Hengelo (O)"). Every other one of the
 * 342 municipalities and 12 provinces was checked to be published under its
 * official name.
 */
const CREATOR_SPELLING: Record<string, string> = {
  [placeKey("Hengelo (O)")]: "Hengelo",
};

export interface ResolvedAuthority {
  /** The authority as the caller typed it. */
  input: string;
  /** dt.creator values to OR together. */
  names: string[];
  /** w.organisatietype restriction, from authority_type or a "Gemeente "/"Provincie " prefix. */
  type?: string;
  /** True when the type came from a prefix in the name rather than authority_type. */
  typeFromPrefix: boolean;
  /** The kind a "Gemeente "/"Provincie "/water-board prefix names, also when authority_type overrides it. */
  prefixType?: AuthorityType;
  /**
   * Water authority typed with its prefix: the names to use instead when the
   * typed name is not a publisher at all ("Hoogheemraadschap Rijnland" — the
   * source says "Hoogheemraadschap van Rijnland"). search() checks the count.
   */
  fallbackNames?: string[];
}

/** Turn a typed authority ("Gemeente Den Haag") into creator names plus an organisation type. */
export function resolveAuthority(authority: string | undefined, authorityType?: string): ResolvedAuthority | undefined {
  const input = (authority ?? "").trim().replace(/\s+/g, " ");
  const explicitType = (authorityType ?? "").trim().toLowerCase() || undefined;
  if (!input) return undefined;

  let base = input;
  let prefixType: AuthorityType | undefined;
  let keepTyped = true;
  for (const prefix of AUTHORITY_PREFIXES) {
    const stripped = input.replace(prefix.pattern, "");
    if (stripped !== input && stripped.trim()) {
      base = stripped.trim();
      prefixType = prefix.type;
      keepTyped = prefix.keepTyped;
      break;
    }
  }

  const names: string[] = [];
  const add = (name: string) => {
    const clean = name.trim();
    if (clean && !names.includes(clean)) names.push(clean);
  };
  const respelled = CREATOR_SPELLING[placeKey(base)];
  if (respelled) add(respelled);
  // placeVariants: the name as typed first, then its aliases (Den Haag ->
  // 's-Gravenhage) and punctuation variants. The index tokenises "'s-Gravenhage"
  // so that "s Gravenhage" matches nothing — sending each spelling is the only
  // way to hit whichever one the source stores.
  for (const variant of placeVariants(base)) add(variant);

  const type = explicitType ?? prefixType;
  const typeFromPrefix = !explicitType && Boolean(prefixType);
  if (prefixType && keepTyped) {
    return { input, names: [input], type, typeFromPrefix, prefixType, fallbackNames: names.filter((name) => name !== input).slice(0, 8) };
  }
  return { input, names: names.slice(0, 8), type, typeFromPrefix, prefixType };
}

function authorityCql(authority: ResolvedAuthority): string {
  const clauses = authority.names.map((name) => `dt.creator="${escapeSruValue(name)}"`);
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
}

/** The names in a variant list that differ by more than punctuation, first spelling kept. */
function distinctPlaceNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = placeKey(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function quoteList(values: string[], joiner = " of "): string {
  return values.map((value) => `'${value}'`).join(joiner);
}

/* ------------------------------------------------------------------ */
/*  Place names in free text                                           */
/* ------------------------------------------------------------------ */

/**
 * The 342 municipalities of 1 January 2026 (PDOK Locatieserver), spelled as
 * Officiële Bekendmakingen publishes them as creator. Only used to SUGGEST an
 * authority filter when a place name appears in the query, so a municipal
 * reorganisation making this list stale costs a suggestion, never a result.
 */
const MUNICIPALITIES: readonly string[] = [
  "'s-Gravenhage", "'s-Hertogenbosch", "Aa en Hunze", "Aalsmeer", "Aalten", "Achtkarspelen",
  "Alblasserdam", "Albrandswaard", "Alkmaar", "Almelo", "Almere", "Alphen aan den Rijn",
  "Alphen-Chaam", "Altena", "Ameland", "Amersfoort", "Amstelveen", "Amsterdam", "Apeldoorn",
  "Arnhem", "Assen", "Asten", "Baarle-Nassau", "Baarn", "Barendrecht", "Barneveld", "Beek",
  "Beekdaelen", "Beesel", "Berg en Dal", "Bergeijk", "Bergen (L)", "Bergen (NH)",
  "Bergen op Zoom", "Berkelland", "Bernheze", "Best", "Beuningen", "Beverwijk", "Bladel",
  "Blaricum", "Bloemendaal", "Bodegraven-Reeuwijk", "Boekel", "Borger-Odoorn", "Borne",
  "Borsele", "Boxtel", "Breda", "Bronckhorst", "Brummen", "Brunssum", "Bunnik", "Bunschoten",
  "Buren", "Capelle aan den IJssel", "Castricum", "Coevorden", "Cranendonck", "Culemborg",
  "Dalfsen", "Dantumadiel", "De Bilt", "De Fryske Marren", "De Ronde Venen", "De Wolden",
  "Delft", "Den Helder", "Deurne", "Deventer", "Diemen", "Dijk en Waard", "Dinkelland",
  "Doesburg", "Doetinchem", "Dongen", "Dordrecht", "Drechterland", "Drimmelen", "Dronten",
  "Druten", "Duiven", "Echt-Susteren", "Edam-Volendam", "Ede", "Eemnes", "Eemsdelta", "Eersel",
  "Eijsden-Margraten", "Eindhoven", "Elburg", "Emmen", "Enkhuizen", "Enschede", "Epe",
  "Ermelo", "Etten-Leur", "Geertruidenberg", "Geldrop-Mierlo", "Gemert-Bakel", "Gennep",
  "Gilze en Rijen", "Goeree-Overflakkee", "Goes", "Goirle", "Gooise Meren", "Gorinchem",
  "Gouda", "Groningen", "Gulpen-Wittem", "Haaksbergen", "Haarlem", "Haarlemmermeer",
  "Halderberge", "Hardenberg", "Harderwijk", "Hardinxveld-Giessendam", "Harlingen", "Hattem",
  "Heemskerk", "Heemstede", "Heerde", "Heerenveen", "Heerlen", "Heeze-Leende", "Heiloo",
  "Hellendoorn", "Helmond", "Hendrik-Ido-Ambacht", "Hengelo", "Het Hogeland", "Heumen",
  "Heusden", "Hillegom", "Hilvarenbeek", "Hilversum", "Hoeksche Waard", "Hof van Twente",
  "Hollands Kroon", "Hoogeveen", "Hoorn", "Horst aan de Maas", "Houten", "Huizen", "Hulst",
  "IJsselstein", "Kaag en Braassem", "Kampen", "Kapelle", "Katwijk", "Kerkrade", "Koggenland",
  "Krimpen aan den IJssel", "Krimpenerwaard", "Laarbeek", "Land van Cuijk", "Landgraaf",
  "Landsmeer", "Lansingerland", "Laren", "Leeuwarden", "Leiden", "Leiderdorp",
  "Leidschendam-Voorburg", "Lelystad", "Leudal", "Leusden", "Lingewaard", "Lisse", "Lochem",
  "Loon op Zand", "Lopik", "Losser", "Maasdriel", "Maasgouw", "Maashorst", "Maassluis",
  "Maastricht", "Medemblik", "Meerssen", "Meierijstad", "Meppel", "Middelburg",
  "Midden-Delfland", "Midden-Drenthe", "Midden-Groningen", "Moerdijk", "Molenlanden",
  "Montferland", "Montfoort", "Mook en Middelaar", "Neder-Betuwe", "Nederweert", "Nieuwegein",
  "Nieuwkoop", "Nijkerk", "Nijmegen", "Nissewaard", "Noardeast-Fryslân", "Noord-Beveland",
  "Noordenveld", "Noordoostpolder", "Noordwijk", "Nuenen, Gerwen en Nederwetten", "Nunspeet",
  "Oegstgeest", "Oirschot", "Oisterwijk", "Oldambt", "Oldebroek", "Oldenzaal", "Olst-Wijhe",
  "Ommen", "Oost Gelre", "Oosterhout", "Ooststellingwerf", "Oostzaan", "Opmeer", "Opsterland",
  "Oss", "Oude IJsselstreek", "Ouder-Amstel", "Oudewater", "Overbetuwe", "Papendrecht",
  "Peel en Maas", "Pekela", "Pijnacker-Nootdorp", "Purmerend", "Putten", "Raalte",
  "Reimerswaal", "Renkum", "Renswoude", "Reusel-De Mierden", "Rheden", "Rhenen", "Ridderkerk",
  "Rijssen-Holten", "Rijswijk", "Roerdalen", "Roermond", "Roosendaal", "Rotterdam",
  "Rozendaal", "Rucphen", "Schagen", "Scherpenzeel", "Schiedam", "Schiermonnikoog",
  "Schouwen-Duiveland", "Simpelveld", "Sint-Michielsgestel", "Sittard-Geleen", "Sliedrecht",
  "Sluis", "Smallingerland", "Soest", "Someren", "Son en Breugel", "Stadskanaal", "Staphorst",
  "Stede Broec", "Steenbergen", "Steenwijkerland", "Stein", "Stichtse Vecht",
  "Súdwest-Fryslân", "Terneuzen", "Terschelling", "Texel", "Teylingen", "Tholen", "Tiel",
  "Tilburg", "Tubbergen", "Twenterand", "Tynaarlo", "Tytsjerksteradiel", "Uitgeest",
  "Uithoorn", "Urk", "Utrecht", "Utrechtse Heuvelrug", "Vaals", "Valkenburg aan de Geul",
  "Valkenswaard", "Veendam", "Veenendaal", "Veere", "Veldhoven", "Velsen", "Venlo", "Venray",
  "Vijfheerenlanden", "Vlaardingen", "Vlieland", "Vlissingen", "Voerendaal", "Voorne aan Zee",
  "Voorschoten", "Voorst", "Vught", "Waadhoeke", "Waalre", "Waalwijk", "Waddinxveen",
  "Wageningen", "Wassenaar", "Waterland", "Weert", "West Betuwe", "West Maas en Waal",
  "Westerkwartier", "Westerveld", "Westervoort", "Westerwolde", "Westland", "Weststellingwerf",
  "Wierden", "Wijchen", "Wijdemeren", "Wijk bij Duurstede", "Winterswijk", "Woensdrecht",
  "Woerden", "Wormerland", "Woudenberg", "Zaanstad", "Zaltbommel", "Zandvoort", "Zeewolde",
  "Zeist", "Zevenaar", "Zoetermeer", "Zoeterwoude", "Zuidplas", "Zundert", "Zutphen",
  "Zwartewaterland", "Zwijndrecht", "Zwolle",
];

const PROVINCES: readonly string[] = [
  "Drenthe", "Flevoland", "Fryslân", "Gelderland", "Groningen", "Limburg", "Noord-Brabant",
  "Noord-Holland", "Overijssel", "Utrecht", "Zeeland", "Zuid-Holland",
];

/**
 * Municipality names that are also everyday Dutch words ("best", "buren",
 * "putten", "leiden", "houten", "weert") or a common abbreviation ("OSS"). They
 * only count as a place when the caller wrote them as a name: capital first,
 * the rest lower case.
 */
const COMMON_WORD_PLACES = new Set(
  ["Assen", "Beek", "Best", "Buren", "Delft", "Duiven", "Goes", "Hoorn", "Houten", "Huizen",
    "Hulst", "Kampen", "Leiden", "Losser", "Oss", "Putten", "Sluis", "Voorst", "Waterland", "Weert"].map(placeKey),
);

/**
 * A place name right after one of these words is part of an institution's name
 * ("Universiteit Utrecht", "Rechtbank Den Haag", "Universiteit van Amsterdam"),
 * not the municipality or province as publisher.
 */
const INSTITUTION_BEFORE_PLACE = / (?:universiteit|hogeschool|rechtbank|gerechtshof|veiligheidsregio|omgevingsdienst)(?: van)? $/;

/** Does `key` occur in the folded haystack other than as part of an institution's name? */
function placeNamedOnItsOwn(haystack: string, key: string): boolean {
  const needle = ` ${key} `;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) {
    if (!INSTITUTION_BEFORE_PLACE.test(haystack.slice(0, index + 1))) return true;
  }
  return false;
}

interface PlaceEntry {
  /** The creator name to suggest. */
  name: string;
  kinds: Set<"gemeente" | "provincie">;
  /** Folded spellings that point at this place (official name and aliases). */
  keys: string[];
}

let placeIndex: PlaceEntry[] | undefined;

function getPlaceIndex(): PlaceEntry[] {
  if (placeIndex) return placeIndex;
  const byName = new Map<string, PlaceEntry>();
  const addPlace = (name: string, kind: "gemeente" | "provincie") => {
    const entry = byName.get(name) ?? { name, kinds: new Set(), keys: [] };
    entry.kinds.add(kind);
    // placeVariants adds the aliases from place-aliases.ts: Den Haag, The Hague,
    // Den Bosch, Friesland, Ljouwert.
    for (const variant of [name, ...placeVariants(name)]) {
      const key = placeKey(variant);
      if (key && !entry.keys.includes(key)) entry.keys.push(key);
    }
    byName.set(name, entry);
  };
  for (const name of MUNICIPALITIES) addPlace(name, "gemeente");
  for (const name of PROVINCES) addPlace(name, "provincie");
  placeIndex = [...byName.values()];
  return placeIndex;
}

/** Is `name` written with a capital somewhere in `text`, as a whole word? */
function capitalisedIn(text: string, key: string): boolean {
  const folded = text.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const pattern = new RegExp(`(?:^|[^\\p{L}])${key.charAt(0).toUpperCase()}${key.slice(1)}(?![\\p{L}])`, "u");
  return pattern.test(folded);
}

export interface DetectedPlace {
  name: string;
  kinds: Array<"gemeente" | "provincie">;
}

/** Municipality and province names mentioned in free text, longest match first. */
export function detectPlaces(text: string | undefined): DetectedPlace[] {
  const raw = (text ?? "").trim();
  if (!raw) return [];
  const haystack = ` ${placeKey(raw)} `;

  const hits: Array<{ entry: PlaceEntry; key: string }> = [];
  for (const entry of getPlaceIndex()) {
    const key = entry.keys.find((candidate) => placeNamedOnItsOwn(haystack, candidate));
    if (!key) continue;
    if (COMMON_WORD_PLACES.has(key) && !capitalisedIn(raw, key)) continue;
    hits.push({ entry, key });
  }

  // "Midden-Groningen" also contains "groningen": keep only the longest match.
  const kept = hits.filter(
    (hit) => !hits.some((other) => other !== hit && other.key.length > hit.key.length && ` ${other.key} `.includes(` ${hit.key} `)),
  );
  return kept.map(({ entry, key }) => {
    // "gemeente Utrecht" / "provincie Utrecht" in the text settles which one is meant.
    const named = [...entry.kinds].filter((kind) => haystack.includes(` ${kind} ${key} `));
    return { name: entry.name, kinds: named.length ? named : [...entry.kinds] };
  });
}

/** Dutch access_note suggesting an authority filter for place names in the query. */
export function placeSuggestionNote(text: string | undefined): string | undefined {
  const places = detectPlaces(text).slice(0, 3);
  if (!places.length) return undefined;
  const suggestions = places.map((place) => {
    const kinds = place.kinds.length > 1
      ? ` met authority_type '${place.kinds.join("' of '")}'`
      : ` (authority_type '${place.kinds[0]}')`;
    return `authority: '${place.name}'${kinds}`;
  });
  return (
    `De zoekterm noemt ${quoteList(places.map((place) => place.name), " en ")}; die naam wordt nu als vrije tekst ` +
    `gezocht en levert ook landelijke stukken op waarin hij toevallig voorkomt. Zoekt u publicaties ván die ` +
    `organisatie, gebruik dan ${suggestions.join(", of ")} en laat de naam weg uit de zoekterm.`
  );
}

/* ------------------------------------------------------------------ */
/*  Record mapping                                                     */
/* ------------------------------------------------------------------ */

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return scalar((value as Record<string, unknown>)["#text"]);
  }
  return undefined;
}

/** All values of a possibly repeated element. */
function strings(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of list) {
    const text = scalar(entry);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/** First value of a possibly repeated element. */
function first(value: unknown): string | undefined {
  return strings(value)[0];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** enrichedData carries one itemUrl per manifestation (pdf, html, xml, odt, metadata). */
function manifestationUrls(enriched: Record<string, unknown>): Record<string, string> {
  const urls: Record<string, string> = {};
  const raw = enriched.itemUrl;
  for (const entry of Array.isArray(raw) ? raw : [raw]) {
    const obj = asObject(entry);
    const manifestation = scalar(obj.manifestation);
    const url = scalar(obj);
    if (manifestation && url && !urls[manifestation]) urls[manifestation] = url;
  }
  return urls;
}

interface BekendmakingMeta {
  identifier?: string;
  title?: string;
  date?: string;
  publicationDate?: string;
  modified?: string;
  authority?: string;
  authorityType?: string;
  type?: string;
  productArea?: string;
  journal?: string;
  number?: string;
  year?: string;
  dossier?: string;
  subNumber?: string;
  sessionYear?: string;
  /** Handelingen: the item within the meeting (tpmeta handelingenitemnummer). */
  handelingenItem?: string;
  /** Kamervragen (Aanhangsel): the number in the Aanhangsel (tpmeta aanhangselnummer). */
  aanhangselNumber?: string;
  documentTitle?: string;
  dossierTitle?: string;
  subrubriek?: string;
  mainDocument?: string;
  submitters: string[];
  subjects: string[];
  legalBasis: string[];
  publisher?: string;
  concernsRegulation?: string;
  municipality?: string;
  province?: string;
  canonical?: string;
  urls: Record<string, string>;
}

function extractMeta(record: Record<string, unknown>): BekendmakingMeta {
  const meta = asObject(asObject(record.originalData).meta);
  const owmskern = asObject(meta.owmskern);
  const owmsmantel = asObject(meta.owmsmantel);
  const tpmeta = asObject(meta.tpmeta);
  const enriched = asObject(record.enrichedData);
  const area = asObject(asObject(tpmeta.gebiedsmarkering).Gemeente);

  const identifier = first(owmskern.identifier) ?? first(record.identifier);
  return {
    identifier,
    title: first(owmskern.title) ?? first(record.title),
    date: first(owmsmantel.date),
    publicationDate: first(owmsmantel.available),
    modified: first(owmskern.modified),
    authority: strings(owmskern.creator).join("; ") || undefined,
    authorityType: first(tpmeta.organisatietype),
    type: first(owmskern.type),
    productArea: first(tpmeta["product-area"]),
    journal: first(tpmeta.publicatienaam),
    number: first(tpmeta.publicatienummer),
    year: first(tpmeta.jaargang),
    dossier: first(tpmeta.dossiernummer),
    subNumber: first(tpmeta.ondernummer),
    sessionYear: first(tpmeta.vergaderjaar),
    handelingenItem: first(tpmeta.handelingenitemnummer),
    aanhangselNumber: first(tpmeta.aanhangselnummer),
    documentTitle: first(tpmeta.documenttitel),
    dossierTitle: first(tpmeta.dossiertitel),
    subrubriek: first(tpmeta.subrubriek),
    mainDocument: first(tpmeta.hoofddocument),
    submitters: strings(tpmeta.indiener),
    subjects: strings(owmsmantel.subject),
    legalBasis: strings(owmsmantel.source),
    publisher: first(owmsmantel.publisher),
    concernsRegulation: first(tpmeta.betreftRegeling),
    municipality: first(area.gemeentenaam),
    province: first(area.ligtInProvincie),
    canonical: first(enriched.preferredUrl) ?? (identifier ? `${DOCUMENT_PAGE}/${identifier}` : undefined),
    urls: manifestationUrls(enriched),
  };
}

/** "II" for the Tweede Kamer (h-tk-…, ah-tk-…), "I" for the Eerste Kamer (h-ek-…, ah-ek-…). */
function chamber(identifier: string | undefined): string | undefined {
  const match = /^a?h-(tk|ek)-/i.exec(identifier ?? "");
  if (!match) return undefined;
  return match[1].toLowerCase() === "tk" ? "II" : "I";
}

/**
 * Where the publication appears, the way it is cited: "Gemeenteblad 2026,
 * 104512", "Kamerstuk 37020-IX nr. 40 (vergaderjaar 2026-2027)", "Handelingen II
 * 2024-2025, nr. 42, item 4", "Aanhangsel Handelingen II 2019-2020, nr. 4046".
 */
function vindplaats(m: BekendmakingMeta): string | undefined {
  if (!m.journal) return undefined;
  const house = chamber(m.identifier);
  // Every item of one meeting shares the meeting number; the item tells them apart.
  if (/^handelingen$/i.test(m.journal) && m.sessionYear && m.number) {
    return `Handelingen${house ? ` ${house}` : ""} ${m.sessionYear}, nr. ${m.number}${m.handelingenItem ? `, item ${m.handelingenItem}` : ""}`;
  }
  if (/^kamervragen \(aanhangsel\)$/i.test(m.journal) && m.sessionYear && m.aanhangselNumber) {
    return `Aanhangsel Handelingen${house ? ` ${house}` : ""} ${m.sessionYear}, nr. ${m.aanhangselNumber}`;
  }
  if (m.dossier) {
    const bijlage = /^bijlage$/i.test(m.type ?? "") ? ", bijlage" : "";
    return `${m.journal} ${m.dossier}${m.subNumber ? ` nr. ${m.subNumber}` : ""}${bijlage}${m.sessionYear ? ` (vergaderjaar ${m.sessionYear})` : ""}`;
  }
  const year = m.year ?? m.sessionYear;
  if (year && m.number) return `${m.journal} ${year}, ${m.number}`;
  if (year) return `${m.journal} ${year}`;
  return m.journal;
}

/**
 * dcterms:source holds the legal basis as "label]|[reference": an EUR-Lex URL,
 * or a JCI reference ("1.0:c:BWBR0005537&artikel=4%3A81&g=2026-01-01") that
 * wetten.overheid.nl resolves as /jci1.0:c:… to the cited article.
 */
export function parseLegalBasis(value: string): { label: string; url?: string; reference?: string } {
  const separator = value.indexOf("]|[");
  const label = (separator === -1 ? value : value.slice(0, separator)).replace(/^\[+|\]+$/g, "").replace(/\s+/g, " ").trim();
  const reference = separator === -1 ? undefined : value.slice(separator + 3).replace(/^\[+|\]+$/g, "").trim();
  if (!reference) return { label };
  if (/^https?:\/\//i.test(reference)) return { label, url: reference };
  const jci = /^(?:jci)?(\d+\.\d+:[cv]:BWB[RV]\d+.*)$/i.exec(reference);
  if (jci) return { label, url: `https://wetten.overheid.nl/jci${jci[1].replace(/%3A/gi, ":")}` };
  return { label, reference };
}

/** One line that says what and where the publication is — not just who published it. */
export function bekendmakingSnippet(item: Record<string, unknown>): string {
  const text = (key: string) => (typeof item[key] === "string" && item[key] ? String(item[key]) : undefined);
  const authority = text("authority");
  const authorityType = text("authority_type");
  const documentTitle = text("document_title");
  const parts = [
    text("vindplaats"),
    authority ? `${authority}${authorityType ? ` (${authorityType})` : ""}` : undefined,
    text("publication_type"),
    text("publication_date") ? `gepubliceerd ${text("publication_date")}` : undefined,
    documentTitle && documentTitle !== text("title") ? documentTitle : undefined,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** The fields search results carry. Existing field names are unchanged. */
function searchItem(m: BekendmakingMeta): Record<string, unknown> {
  const item: Record<string, unknown> = {
    identifier: m.identifier,
    title: m.title,
    date: m.date,
    // `date` has always been the dagtekening (dt.date): the date ON the
    // document, which for Kamerstukken and Handelingen precedes publication.
    date_type: "dagtekening",
    publication_date: m.publicationDate,
    authority: m.authority,
    authority_type: m.authorityType,
    canonical_url: m.canonical,
    publication_type: m.type,
    product_area: m.productArea,
    publicatieblad: m.journal,
    vindplaats: vindplaats(m),
    document_title: m.documentTitle,
    pdf_url: m.urls.pdf,
    html_url: m.urls.html,
    xml_url: m.urls.xml,
  };
  return item;
}

/** record_get: everything the SRU record holds, not just the search fields. */
function fullItem(m: BekendmakingMeta): Record<string, unknown> {
  return {
    ...searchItem(m),
    modified: m.modified,
    publisher: m.publisher,
    subjects: m.subjects.length ? m.subjects : undefined,
    legal_basis: m.legalBasis.length ? m.legalBasis.map(parseLegalBasis) : undefined,
    concerns_regulation: m.concernsRegulation,
    municipality: m.municipality,
    province: m.province,
    dossier_number: m.dossier,
    sub_number: m.subNumber,
    session_year: m.sessionYear,
    handelingen_item: m.handelingenItem,
    aanhangsel_number: m.aanhangselNumber,
    dossier_title: m.dossierTitle,
    subrubriek: m.subrubriek,
    main_document: m.mainDocument,
    submitters: m.submitters.length ? m.submitters : undefined,
    publication_number: m.number,
    publication_year: m.year,
    odt_url: m.urls.odt,
    metadata_url: m.urls.metadata,
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * The diagnostic of an SRU response, message plus details: "SEARCH-IGNOREDQTEXT:
 * [:2026-02-29] is not a valid range constraint against type date". A diagnostic
 * is not always a rejection — see SruPage.rejected.
 */
export function extractSruDiagnostic(parsed: unknown): string | undefined {
  const root = asObject(parsed);
  const response = asObject(root.searchRetrieveResponse ?? root);
  const list = asObject(response.diagnostics).diagnostic;
  if (list === undefined) return undefined;
  const firstDiagnostic = asObject(Array.isArray(list) ? list[0] : list);
  const head = scalar(firstDiagnostic.message) ?? scalar(firstDiagnostic.uri) ?? "onbekende SRU-diagnose";
  const details = scalar(firstDiagnostic.details);
  return details && details !== head ? `${head}: ${details}` : head;
}

/**
 * numberOfRecords, or undefined when the response does not carry a usable one —
 * a rejected query, or a throttled answer without a count. The shared
 * extractSruNumberOfRecords reads both as 0, which here would be reported as
 * "no publications".
 */
export function sruTotal(parsed: unknown): number | undefined {
  const root = asObject(parsed);
  const response = asObject(root.searchRetrieveResponse ?? root);
  const value = response.numberOfRecords;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return Number.parseInt(value, 10);
  return undefined;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface NormalizedSruDate {
  /** The YYYY-MM-DD to send, undefined for no input, null for unusable input. */
  date: string | undefined | null;
  /** Set when a full date was read differently from how it was typed. */
  readAs?: "reformatted" | "nonexistent";
}

/**
 * A date the index accepts (YYYY-MM-DD). "2026" and "2026-06" are widened to the
 * first or last day, an ISO timestamp is cut to its date, DD-MM-YYYY is read as
 * the Dutch notation. A day past the end of its month ("2026-02-29",
 * "2026-04-31") is not sent as typed: the server then ignores the whole bound
 * (diagnostic SEARCH-IGNOREDQTEXT) and returns unfiltered results. As a bound it
 * means the same as the last day of the month (to) or the first of the next one
 * (from), so that is what is sent. Anything else is rejected — sent as-is it
 * would be a CQL syntax error, i.e. a silent zero.
 */
export function normalizeSruDateDetailed(value: string | undefined, edge: "from" | "to"): NormalizedSruDate {
  const raw = (value ?? "").trim();
  if (!raw) return { date: undefined };

  let ymd: [number, number, number] | undefined;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/.exec(raw);
  if (match) ymd = [Number(match[1]), Number(match[2]), Number(match[3])];
  match = ymd ? null : /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(raw);
  if (match) ymd = [Number(match[3]), Number(match[2]), Number(match[1])];
  if (ymd) {
    const [year, month, day] = ymd;
    if (month < 1 || month > 12 || day < 1 || day > 31) return { date: null };
    const last = daysInMonth(year, month);
    if (day <= last) {
      const date = isoDate(year, month, day);
      return date === raw.slice(0, 10) ? { date } : { date, readAs: "reformatted" };
    }
    if (edge === "to") return { date: isoDate(year, month, last), readAs: "nonexistent" };
    return { date: month === 12 ? isoDate(year + 1, 1, 1) : isoDate(year, month + 1, 1), readAs: "nonexistent" };
  }

  match = /^(\d{4})-(\d{2})$/.exec(raw);
  if (match) {
    const month = Number(match[2]);
    if (month < 1 || month > 12) return { date: null };
    const day = edge === "from" ? 1 : daysInMonth(Number(match[1]), month);
    return { date: isoDate(Number(match[1]), month, day) };
  }
  match = /^(\d{4})$/.exec(raw);
  if (match) return { date: edge === "from" ? `${match[1]}-01-01` : `${match[1]}-12-31` };
  return { date: null };
}

export function normalizeSruDate(value: string | undefined, edge: "from" | "to"): string | undefined | null {
  return normalizeSruDateDetailed(value, edge).date;
}

/** The access_note sentence for a date bound that was not used exactly as typed. */
function dateNote(label: "date_from" | "date_to", raw: string | undefined, normalized: NormalizedSruDate): string | undefined {
  if (normalized.date === null) {
    return `${label} '${raw}' genegeerd: gebruik JJJJ-MM-DD (of JJJJ, JJJJ-MM, DD-MM-JJJJ).`;
  }
  if (normalized.readAs === "nonexistent") {
    return `${label} '${raw}' bestaat niet als datum; gebruikt als ${normalized.date} (zelfde grens).`;
  }
  if (normalized.readAs === "reformatted") return `${label} '${raw}' gelezen als ${normalized.date}.`;
  return undefined;
}

/** A link that runs the same free-text search on the website. */
export function manualSearchUrl(query: string): string {
  const terms = query.trim();
  if (!terms) return SEARCH_PAGE;
  const cql = `(c.product-area=="officielepublicaties")and(cql.textAndIndexes="${terms.replace(/"/g, "")}")`;
  return `${SEARCH_PAGE}?q=${encodeURIComponent(cql)}&zv=${encodeURIComponent(terms)}&col=AlleBekendmakingen`;
}

const MANIFESTATION_EXTENSION = /\.(?:html?|pdf|xml|odt)$/i;

/** "gmb-2026-104512", "kst-37020-IX-40", "h-tk-20242025-42-4", "blg-1093410". */
const IDENTIFIER_SEGMENT = /^[a-z]+(?:-[a-z]+)*-\d[\w-]*$/i;

/**
 * Accept a bare identifier, a website URL or a repository URL. The identifier
 * is not always the last path segment: metadata URLs end in "metadata.xml"
 * (…/kst-37020-IX-40/metadata.xml, …/gmb-2026-104512/1/metadata/metadata.xml),
 * so the last segment shaped like an identifier is taken.
 */
export function normalizeBekendmakingIdentifier(input: string): string {
  let id = input.trim();
  if (/^https?:\/\//i.test(id)) {
    id = id.replace(/[?#].*$/, "").replace(/\/+$/, "");
    const segments = id.split("/").filter(Boolean).map((segment) => segment.replace(MANIFESTATION_EXTENSION, ""));
    id = [...segments].reverse().find((segment) => IDENTIFIER_SEGMENT.test(segment)) ?? segments.pop() ?? id;
  }
  return id.replace(MANIFESTATION_EXTENSION, "");
}

const INLINE_XML_TAGS = /<\/?(?:nadruk|extref|intref|sup|sub|inf|unl|i|b|u|span|a)\b[^>]*>/gi;

/**
 * Text of a KOOP publication XML. Element boundaries become spaces — "<al>" is a
 * paragraph, and htmlToText (which knows HTML block tags only) would otherwise
 * glue "GEMEENTEBLAD" onto "Officiële uitgave".
 */
export function publicationXmlToText(xml: string): string {
  const body = xml
    .replace(/<\?[\s\S]*?\?>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<metadata\b[\s\S]*?<\/metadata>/gi, " ")
    .replace(INLINE_XML_TAGS, "")
    .replace(/<[^>]*>/g, " ");
  return htmlToText(body);
}

/* ------------------------------------------------------------------ */
/*  Query rewriting that keeps search syntax                           */
/* ------------------------------------------------------------------ */

const HELD = /zqx(\d+)xqz/g;

/** A token whose apostrophe is part of the word: "'s-Gravenhage", "‘t-Zand", "auto's". */
function isApostropheWord(token: string): boolean {
  return /^['‘’][st]-\p{L}/iu.test(token) || /\p{L}['’]\p{L}/u.test(token);
}

/**
 * Run the generic query rewriter (question frames, filler words) without letting
 * it destroy what freeTextCqlPlan reads: it replaces every character but letters,
 * digits and hyphens with a space, so '"zorg en veiligheid"' became
 * zorg AND veiligheid (150,580 hits instead of the phrase's 1,730), "2016/679"
 * became 2016 AND 679 and "'s-Gravenhage" lost its apostrophe. Quoted phrases,
 * slash citations and apostrophe words are held out of the rewrite and put back,
 * and so is a trailing CQL sort clause ("sortBy dt.date"), which the rewriter
 * would turn into the words "dt" and "date"; freeTextCqlPlan leaves it out.
 */
export function rewriteKeepingSyntax(query: string, rewrite: (text: string) => RewriteResult): RewriteResult {
  const held: string[] = [];
  // Sentence punctuation after a token stays outside, for the rewriter to drop.
  const hold = (segment: string) => {
    const [, body, tail] = /^(.*?)([?!.,;:]*)$/su.exec(segment) ?? ["", segment, ""];
    return `zqx${held.push(body) - 1}xqz${tail}`;
  };
  const masked = query
    .replace(/(^|\s)(sortby(?:\s+[a-z]+\.[\w./-]*)+)\s*$/i, (_match, lead: string, clause: string) => `${lead}${hold(clause)}`)
    .replace(/[“”„]/g, '"')
    .replace(/(^|\s)("[^"]+")(?=[\s,.;:!?]|$)/g, (_match, lead: string, phrase: string) => `${lead}${hold(phrase)}`)
    .replace(/(^|\s)([^\s"]*[\p{L}\p{N}]\/[\p{L}\p{N}][^\s"]*)(?=\s|$)/gu, (_match, lead: string, token: string) => `${lead}${hold(token)}`)
    .replace(/(^|\s)([^\s"]+)/g, (match, lead: string, token: string) => (isApostropheWord(token) ? `${lead}${hold(token)}` : match));
  if (!held.length) return rewrite(query);

  const restore = (text: string) => text.replace(HELD, (_match, index: string) => held[Number(index)] ?? "");
  const { syntaxQuery: maskedSyntax, ...out } = rewrite(masked);
  const rewritten = restore(out.rewritten).replace(/\s+/g, " ").trim();
  // The syntax form carries the placeholders too. As in the rewriter, it is
  // only set when it differs from the plain query.
  const syntaxQuery = maskedSyntax ? restore(maskedSyntax).replace(/\s+/g, " ").trim() : undefined;
  return {
    ...out,
    original: query,
    rewritten,
    explanation: out.explanation ? restore(out.explanation) : undefined,
    ...(syntaxQuery && syntaxQuery !== rewritten ? { syntaxQuery } : {}),
  };
}

/* ------------------------------------------------------------------ */
/*  Source                                                             */
/* ------------------------------------------------------------------ */

export interface BekendmakingenSearchArgs {
  query: string;
  maximumRecords: number;
  startRecord?: number;
  /** Document kind (dt.type), e.g. "Kamerstuk", "beleidsregel". */
  type?: string;
  /** Publisher name (dt.creator), e.g. "Gouda", "Gemeente Den Haag". */
  authority?: string;
  /** Publisher kind (w.organisatietype), e.g. "gemeente", "provincie". */
  authority_type?: string;
  /** Journal(s) (w.publicatienaam), e.g. "Gemeenteblad" or "Gemeenteblad, Provinciaal blad". */
  publicatieblad?: string;
  date_from?: string;
  date_to?: string;
  /** Which date date_from/date_to and sort use. Default: dagtekening (dt.date). */
  date_field?: BekendmakingenDateField;
  sort?: BekendmakingenSort;
  /** The caller's own words, before any query rewriting — used to spot place names. */
  originalQuery?: string;
  /**
   * Also find a hyphenated compound ("OV-visie") where its parts occur as
   * separate words, after the exact hits (relevance order only). Off by default:
   * nl_gov_ask passes whole questions, where a loose match is mostly noise and
   * an empty result lets the router try another source.
   */
  expandCompounds?: boolean;
}

export interface BekendmakingenSearchResult {
  items: Array<Record<string, unknown>>;
  /**
   * numberOfRecords as the server reports it (an estimate by its own account);
   * null when no usable count came back.
   */
  total: number | null;
  /**
   * Result positions the caller can page through, when that differs from total:
   * an exact-first compound search drops publications already listed, so pages
   * can hold fewer records than requested while positions run on.
   */
  positions?: number;
  /** Positions this page covers (next page: startRecord + page_span). */
  page_span?: number;
  endpoint: string;
  params: Record<string, string>;
  access_note?: string;
  /** Set when the server rejected the query: total is then not a real count. */
  diagnostic?: string;
}

/** One SRU response, read without guessing. */
interface SruPage {
  records: Array<Record<string, unknown>>;
  total?: number;
  url: string;
  diagnostic?: string;
  /** A diagnostic with neither a count nor records: the query was rejected. */
  rejected: boolean;
}

/**
 * Exact-first compound search is used while the exact compound has at most this
 * many hits: all of them can then be fetched to drop them from the loose part.
 * A compound with more exact hits fills many pages on its own and is searched
 * exactly, with a note.
 */
const EXACT_FIRST_LIMIT = 100;

const PRODUCT_AREA = 'c.product-area="officielepublicaties"';

function itemIdentifier(item: Record<string, unknown>): string | undefined {
  return typeof item.identifier === "string" ? item.identifier.toLowerCase() : undefined;
}

/**
 * Creator names the source used for a municipality before its current one: the
 * same publisher, not another one. "Utrecht (Utr)" (16,503 publications,
 * 2009-04-08 to 2016-01-04) and "Groningen (Gr)" (604, 2009-04-01 to
 * 2015-12-29) are all organisatietype gemeente. They cannot be recognised by
 * folding the name, so they are listed here.
 *
 * A scan of all 342 municipalities and 12 provinces (October 2026: per name,
 * `dt.creator="X" AND w.organisatietype=<kind>` minus every creator found so
 * far) turned up these other creators next to the official names:
 * - "Utrecht (Utr)" and "Groningen (Gr)": this list;
 * - "Súdwest Fryslân" (2,146, 2011-02-10 to 2016-02-25), "Den Haag" (906
 *   gemeente records, 2007-2015), "Friesland" (139 provincie records),
 *   "gemeente Noardeast-Fryslân" and "provincie Drenthe"/"Flevoland"/"Zeeland"
 *   (1 each): spellings that differ from the requested name only in
 *   punctuation, by an alias (place-aliases.ts) or by a "gemeente "/"provincie "
 *   prefix; publisherNote recognises those by folding the name;
 * - "Midden-Groningen": another municipality, which the containment match finds.
 * Bergen (NH) and Bergen (L) are municipalities of their own, not older spellings.
 */
const FORMER_CREATOR_SPELLING: Record<string, { current: string; period: string }> = {
  [placeKey("Utrecht (Utr)")]: { current: "Utrecht", period: "tot begin 2016" },
  [placeKey("Groningen (Gr)")]: { current: "Groningen", period: "tot en met 2015" },
};

/** The current publisher name for an older creator spelling, else undefined. */
export function currentCreatorName(creator: string): string | undefined {
  return FORMER_CREATOR_SPELLING[placeKey(creator)]?.current;
}

let officialPlaceNames: Map<string, string> | undefined;

/** The official spelling of a municipality or province ("s gravenhage" -> "'s-Gravenhage"), else undefined. */
function officialPlaceName(name: string): string | undefined {
  officialPlaceNames ??= new Map([...MUNICIPALITIES, ...PROVINCES].map((place) => [placeKey(place), place]));
  return officialPlaceNames.get(placeKey(name));
}

/** "gemeente Noardeast-Fryslân": the kind written into a creator name. */
const CREATOR_KIND_PREFIX = /^(?:gemeente|provincie)\s+/i;

interface FoldedSpelling {
  /** The name the records are counted under. */
  publisher: string;
  count: number;
  /** For an older spelling: when the source used it. */
  period?: string;
}

/**
 * dt.creator is a containment match with stemming: "Groningen" also finds
 * Midden-Groningen, "Bergen" finds Bergen (NH), Bergen (L), Bergen op Zoom and
 * Berg en Dal — whether or not an organisation type is set. Say so when a page
 * shows it.
 *
 * Other spellings of the requested publisher are not other publishers: the
 * older "Utrecht (Utr)", and every creator that folds onto one of the requested
 * names once case, accents, punctuation and a "gemeente "/"provincie " prefix
 * are ignored — "Súdwest Fryslân" for Súdwest-Fryslân, "Den Haag" for
 * 's-Gravenhage (an alias the search sends too), "gemeente Noardeast-Fryslân".
 * They are counted under one name (the official one for a municipality or
 * province) and explained, never listed as a publisher that "cannot be excluded".
 */
function publisherNote(authority: ResolvedAuthority, typeSet: boolean, items: Array<Record<string, unknown>>): string | undefined {
  const wanted = new Set(authority.names.map(placeKey));
  const isWanted = (creator: string) => wanted.has(placeKey(creator.replace(CREATOR_KIND_PREFIX, "")));
  const creators = items
    .map((item) => ({
      creator: typeof item.authority === "string" ? item.authority : "",
      kind: typeof item.authority_type === "string" ? item.authority_type.toLowerCase() : "",
    }))
    .filter(({ creator }) => creator);

  // The name the requested publisher is counted under: its official spelling,
  // else the spelling most of its records on this page carry.
  let requested = authority.names.map(officialPlaceName).find((name): name is string => Boolean(name));
  if (!requested) {
    const frequency = new Map<string, number>();
    for (const { creator } of creators) {
      if (isWanted(creator)) frequency.set(creator, (frequency.get(creator) ?? 0) + 1);
    }
    requested = [...frequency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }

  const counts = new Map<string, number>();
  const folded = new Map<string, FoldedSpelling>();
  for (const { creator, kind } of creators) {
    let publisher = creator;
    let period: string | undefined;
    const former = FORMER_CREATOR_SPELLING[placeKey(creator)];
    if (requested && isWanted(creator)) {
      publisher = requested;
    } else if (former) {
      publisher = requested && wanted.has(placeKey(former.current)) ? requested : former.current;
      period = former.period;
    }
    if (publisher !== creator) {
      const seen = folded.get(creator) ?? { publisher, count: 0, period };
      seen.count += 1;
      folded.set(creator, seen);
    }
    // Without a type, gemeente and provincie Utrecht share the name: key by kind too.
    const key = `${publisher}${!typeSet && kind ? ` (${kind})` : ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const foldedNote = (counted: boolean) =>
    folded.size
      ? [...folded.entries()]
          .map(([spelling, { publisher, count, period }]) => {
            const records = `${count} ${count === 1 ? "record" : "records"} op deze pagina ${count === 1 ? "heeft" : "hebben"} authority '${spelling}'`;
            const same = `dezelfde uitgever als '${publisher}'${counted ? " (in de telling hierboven daaronder meegeteld)" : ""}`;
            return period
              ? `${records}: zo schreef de bron gemeente ${publisher} ${period}. Het is ${same}, geen andere organisatie.`
              : `${records}: een andere schrijfwijze van ${same}, geen andere organisatie.`;
          })
          .join(" ")
      : undefined;
  if (counts.size < 2) return foldedNote(false);

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const listed = ranked.slice(0, 5).map(([name, count]) => `${name}: ${count}`).join(", ");
  const head =
    `authority '${authority.input}' matcht op deze pagina meerdere uitgevers: ${listed}` +
    `${ranked.length > 5 ? ` en ${ranked.length - 5} andere` : ""}. ` +
    "De bron zoekt op naamdelen.";
  const counted = foldedNote(true);
  const tail = counted ? ` ${counted}` : "";
  if (!typeSet) {
    return `${head} Beperk met authority_type (bijv. 'gemeente' of 'provincie'), met 'Gemeente …'/'Provincie …' of met de volledige naam.${tail}`;
  }
  const exact = ranked.find(([name]) => isWanted(name));
  const others = ranked.filter(([name]) => !isWanted(name)).map(([name]) => name);
  // Every name on the page is the requested publisher: nothing to exclude.
  if (!others.length) return foldedNote(false);
  if (exact) {
    return (
      `${head} '${exact[0]}' is al de volledige naam; ${quoteList(others.slice(0, 3), ", ")} ` +
      `${others.length > 1 ? "vallen" : "valt"} daarmee niet uit te sluiten — herken die records aan het veld authority.${tail}`
    );
  }
  return `${head} Gebruik de volledige naam van de bedoelde uitgever, bijv. ${quoteList(others.slice(0, 2))}.${tail}`;
}

export class BekendmakingenSource {
  constructor(private readonly config: AppConfig) {}

  /**
   * The SRU endpoint could not be reached. No record is invented: a fabricated
   * "Fallback bekendmaking" with a 1970 date used to stand in for real results,
   * and was counted as one.
   */
  fallbackSearch(args: {
    query: string;
    maximumRecords: number;
    startRecord?: number;
    type?: string;
    authority?: string;
    date_from?: string;
    date_to?: string;
  }) {
    return {
      items: [] as Array<Record<string, unknown>>,
      total: null as number | null,
      endpoint: `${this.config.endpoints.bekendmakingenSru} (niet bereikbaar)`,
      params: {
        operation: "searchRetrieve",
        version: "2.0",
        query: args.query,
        maximumRecords: String(args.maximumRecords),
        startRecord: String(args.startRecord ?? 1),
        recordSchema: "gzd",
        mode: "unavailable",
      } as Record<string, string>,
      access_note:
        "Officiële Bekendmakingen (SRU) was niet bereikbaar of gaf een fout; er zijn geen resultaten opgehaald. " +
        `Probeer het later opnieuw of zoek handmatig: ${manualSearchUrl(args.query)}`,
    };
  }

  /** Same for a single record: no stand-in item, only where to look by hand. */
  fallbackGet(identifier: string) {
    const id = normalizeBekendmakingIdentifier(identifier);
    return {
      item: null as Record<string, unknown> | null,
      endpoint: `${this.config.endpoints.bekendmakingenSru} (niet bereikbaar)`,
      params: {
        operation: "searchRetrieve",
        version: "2.0",
        query: `dt.identifier=="${escapeSruValue(id)}" AND ${PRODUCT_AREA}`,
        maximumRecords: "1",
        startRecord: "1",
        recordSchema: "gzd",
        mode: "unavailable",
      } as Record<string, string>,
      access_note:
        "Officiële Bekendmakingen (SRU) was niet bereikbaar of gaf een fout; de bekendmaking is niet opgehaald. " +
        `Probeer het later opnieuw of open ${DOCUMENT_PAGE}/${encodeURIComponent(id)}.html`,
    };
  }

  private async fetchSru(query: string, startRecord: number, maximumRecords: number): Promise<SruPage> {
    const { data, meta } = await getText(this.config.endpoints.bekendmakingenSru, {
      query: { operation: "searchRetrieve", version: "2.0", query, maximumRecords, startRecord, recordSchema: "gzd" },
    });
    const parsed = parseXml(data);
    const records = extractSruRecords(parsed);
    const total = sruTotal(parsed);
    const diagnostic = extractSruDiagnostic(parsed);
    return { records, total, url: meta.url, diagnostic, rejected: Boolean(diagnostic) && total === undefined && !records.length };
  }

  /**
   * Number of records for a query (maximumRecords=0: no records, just the
   * count). Only ever used to explain a result, so it fails quietly and fast,
   * and says "unknown" rather than 0 when the answer carries no real count.
   */
  private async count(query: string): Promise<number | undefined> {
    try {
      const { data } = await getText(this.config.endpoints.bekendmakingenSru, {
        query: { operation: "searchRetrieve", version: "2.0", query, maximumRecords: 0, startRecord: 1, recordSchema: "gzd" },
        timeoutMs: 8_000,
        retries: 1,
      });
      const parsed = parseXml(data);
      if (extractSruDiagnostic(parsed)) return undefined;
      return sruTotal(parsed);
    } catch {
      return undefined;
    }
  }

  async search(args: BekendmakingenSearchArgs): Promise<BekendmakingenSearchResult> {
    const endpoint = this.config.endpoints.bekendmakingenSru;
    const notes: string[] = [];

    const dateSorted = args.sort === "date_newest" || args.sort === "date_oldest";
    const expand = Boolean(args.expandCompounds) && !dateSorted;
    const plan = freeTextCqlPlan(args.query, { expandCompounds: expand });
    let authority = resolveAuthority(args.authority, args.authority_type);
    const dateIndex = args.date_field === "publicatiedatum" ? "dt.available" : "dt.date";

    // Journals: from publicatieblad, plus a journal name passed as `type` —
    // dt.type="Staatscourant" matches nothing, so that is what the caller meant.
    const journals = resolvePublicatiebladen(args.publicatieblad);
    let type = args.type?.trim() || undefined;
    if (type) {
      const asJournal = findJournal(type);
      if (asJournal && !asJournal.alsoDocumentType) {
        if (!journals.names.includes(asJournal.name)) journals.names.push(asJournal.name);
        notes.push(
          `type '${type}' is een publicatieblad, geen documentsoort; toegepast als publicatieblad-filter (${asJournal.name}).`,
        );
        type = undefined;
      }
    }
    if (journals.unknown.length) {
      notes.push(
        `Onbekend publicatieblad ${quoteList(journals.unknown)}; toch als filter toegepast. Bekende waarden: ${JOURNAL_NAMES.join(", ")}.`,
      );
    }

    const from = normalizeSruDateDetailed(args.date_from, "from");
    const to = normalizeSruDateDetailed(args.date_to, "to");
    for (const note of [dateNote("date_from", args.date_from, from), dateNote("date_to", args.date_to, to)]) {
      if (note) notes.push(note);
    }

    const authorityType = authority?.type ?? (args.authority_type?.trim().toLowerCase() || undefined);
    const typeClause = authorityType ? `w.organisatietype="${escapeSruValue(authorityType)}"` : undefined;

    // A water authority typed with its prefix is searched under that name only;
    // the bare name is a fallback for when the typed name is no publisher at all.
    let authorityFellBack = false;
    if (authority?.fallbackNames?.length) {
      const typedCount = await this.count([PRODUCT_AREA, authorityCql(authority), ...(typeClause ? [typeClause] : [])].join(" AND "));
      if (typedCount === 0) {
        notes.push(
          `Uitgever '${authority.input}' komt in de bron niet voor; gezocht als ${quoteList(distinctPlaceNames(authority.fallbackNames))}` +
            `${authorityType ? ` met organisatietype '${authorityType}'` : ""}.`,
        );
        authority = { ...authority, names: authority.fallbackNames, fallbackNames: undefined };
        authorityFellBack = true;
      }
    }

    // Everything but the free text. On this SRU endpoint, free-text terms work
    // directly; keyword="..." is unsupported. Multi-word input must be AND-joined
    // — a bare phrase is a CQL syntax error that the endpoint answers with zero
    // records (see sru-cql.ts).
    const filters: string[] = [PRODUCT_AREA];
    if (type) filters.push(`dt.type="${escapeSruValue(type)}"`);
    const allJournals = [...journals.names, ...journals.unknown];
    if (allJournals.length) {
      const clauses = allJournals.map((name) => `w.publicatienaam="${escapeSruValue(name)}"`);
      filters.push(clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`);
    }
    if (authority) filters.push(authorityCql(authority));
    if (typeClause) filters.push(typeClause);
    if (from.date) filters.push(`${dateIndex}>=${from.date}`);
    if (to.date) filters.push(`${dateIndex}<=${to.date}`);

    const withText = (text: string | undefined) => [...(text ? [text] : []), ...filters].join(" AND ");
    const filterCql = withText(plan.cql);
    const sortClause =
      args.sort === "date_newest"
        ? ` sortBy ${dateIndex}/sort.descending`
        : args.sort === "date_oldest"
          ? ` sortBy ${dateIndex}/sort.ascending`
          : "";

    const startRecord = Math.max(1, args.startRecord ?? 1);
    const params: Record<string, string> = {
      operation: "searchRetrieve",
      version: "2.0",
      query: `${filterCql}${sortClause}`,
      maximumRecords: String(args.maximumRecords),
      startRecord: String(startRecord),
      recordSchema: "gzd",
    };

    if (plan.exactCompounds.length && args.expandCompounds && dateSorted) {
      notes.push(
        `Bij sortering op datum is ${quoteList(plan.exactCompounds)} alleen als exacte term gezocht; met sort 'relevance' ` +
          "volgen na de exacte treffers ook stukken waarin de losse woorden voorkomen.",
      );
    }
    if (plan.droppedStopwords.length) {
      notes.push(`Stopwoorden niet als verplichte zoekterm gebruikt: ${plan.droppedStopwords.join(", ")}.`);
    }
    if (plan.droppedSyntax.length) {
      notes.push(`${quoteList(plan.droppedSyntax, ", ")} uit de zoekterm genegeerd; sorteer met de parameter sort.`);
    }
    // One spelling per name in the note; the CQL carries the punctuation variants.
    const authorityNames = authority ? distinctPlaceNames(authority.names) : [];
    // "Provincie Utrecht" with authority_type 'gemeente': the explicit type wins, and the note says so.
    const prefixOverridden = Boolean(authority?.prefixType && authority.type && authority.prefixType !== authority.type);
    if (
      authority &&
      !authorityFellBack &&
      (authority.names.length > 1 || authority.names[0] !== authority.input || authority.typeFromPrefix || prefixOverridden)
    ) {
      notes.push(
        `authority '${authority.input}' gezocht als uitgever ${quoteList(authorityNames)}` +
          `${authority.names.length > authorityNames.length ? " (met spellingsvarianten)" : ""}` +
          `${authority.type ? ` met organisatietype '${authority.type}'` : ""}` +
          `${prefixOverridden ? ` (authority_type '${authority.type}' gaat voor op het voorvoegsel in de naam, dat op '${authority.prefixType}' wijst)` : ""}.`,
      );
    }

    // Deep paging: the server answers startRecord >= 10000 with HTTP 504. Ask
    // for the count instead of failing, and say why there are no records.
    if (startRecord > SRU_MAX_START_RECORD) {
      const total = await this.count(filterCql);
      notes.push(
        "De bron geeft via paginering alleen de eerste ~10.000 treffers vrij " +
          `(startRecord ${startRecord.toLocaleString("nl-NL")} is te hoog; het maximum is ${SRU_MAX_START_RECORD.toLocaleString("nl-NL")})` +
          `${total !== undefined ? `; deze zoekvraag heeft ${total.toLocaleString("nl-NL")} treffers` : ""}. ` +
          "Verfijn met date_from/date_to, authority, authority_type, publicatieblad of type, of gebruik sort.",
      );
      return {
        items: [],
        total: total ?? null,
        endpoint,
        params,
        access_note: notes.join(" "),
        ...(total === undefined ? { diagnostic: "start_record_beyond_limit" } : {}),
      };
    }

    let page: {
      items: Array<Record<string, unknown>>;
      total?: number;
      positions?: number;
      span?: number;
      url: string;
      diagnostics: string[];
      rejected?: string;
    };
    if (plan.expandedCompounds.length) {
      const exactPlan = freeTextCqlPlan(args.query, { expandCompounds: false });
      page = await this.exactFirstPage({
        exactCql: withText(exactPlan.cql),
        looseCql: filterCql,
        compounds: plan.expandedCompounds,
        startRecord,
        maximumRecords: args.maximumRecords,
        params,
        notes,
      });
    } else {
      const sru = await this.fetchSru(params.query, startRecord, args.maximumRecords);
      page = {
        items: sru.records.map((record) => searchItem(extractMeta(record))),
        total: sru.total,
        url: sru.url,
        diagnostics: sru.diagnostic && !sru.rejected ? [sru.diagnostic] : [],
        rejected: sru.rejected ? sru.diagnostic : undefined,
      };
    }

    if (page.rejected) {
      notes.push(
        `De bron weigerde de zoekvraag (SRU-diagnose: ${page.rejected}); dit is een fout, geen "0 resultaten". ` +
          "Vereenvoudig de zoektermen of filters.",
      );
      return { items: [], total: null, endpoint: page.url, params, access_note: notes.join(" "), diagnostic: page.rejected };
    }
    for (const diagnostic of page.diagnostics) {
      notes.push(
        `De bron negeerde een deel van de zoekvraag (SRU-diagnose: ${diagnostic}); de resultaten zijn zonder dat deel ` +
          "berekend en kunnen dus te ruim zijn.",
      );
    }

    const { items } = page;
    const total = page.total ?? null;
    if (total === null) {
      notes.push("De bron gaf geen totaal aantal treffers mee; het totaal is onbekend.");
    }

    if (!items.length && startRecord === 1) {
      if (authority) {
        const known = await this.count([PRODUCT_AREA, authorityCql(authority), ...(typeClause ? [typeClause] : [])].join(" AND "));
        if (known === 0) {
          notes.push(
            `Geen uitgever gevonden die overeenkomt met authority '${authority.input}'${authorityType ? ` (organisatietype '${authorityType}')` : ""}. ` +
              "De bron gebruikt de officiële naam zonder voorvoegsel, bijv. 'Gouda', ''s-Gravenhage', 'Súdwest-Fryslân', 'Zuid-Holland', " +
              "'Waterschap Rivierenland' of 'Ministerie van Financiën'. Kamerstukken staan onder 'Tweede Kamer der Staten-Generaal', niet onder het ministerie.",
          );
        } else if (known !== undefined && total === 0) {
          notes.push(
            `Uitgever ${quoteList(authorityNames)}${authorityType ? ` (${authorityType})` : ""} heeft ${known.toLocaleString("nl-NL")} publicaties in de bron, maar geen enkele voldoet aan ` +
              "de overige zoektermen en filters; verbreed de zoektermen, het datumbereik of type/publicatieblad.",
          );
        }
      }
      if (type && total === 0) {
        notes.push(
          `Geen resultaten met type '${type}'. type filtert op documentsoort (dt.type), bijv. 'Kamerstuk', 'beleidsregel', ` +
            "'verordening', 'ander besluit van algemene strekking', 'omgevingsvergunning'; " +
            "voor Gemeenteblad, Staatscourant, Provinciaal blad of Waterschapsblad gebruikt u publicatieblad.",
        );
      }
    }

    if (authority && items.length) {
      const publishers = publisherNote(authority, Boolean(authorityType), items);
      if (publishers) notes.push(publishers);
    }

    if (!authority) {
      const suggestion = placeSuggestionNote(args.originalQuery ?? args.query);
      if (suggestion) notes.push(suggestion);
    }

    const reachable = SRU_MAX_START_RECORD - 1 + args.maximumRecords;
    if (total !== null && total > reachable) {
      notes.push(
        `Van de ${total.toLocaleString("nl-NL")} treffers zijn via paginering alleen de eerste ~10.000 op te halen ` +
          "(de bron weigert startRecord ≥ 10.000); verfijn de zoekvraag of gebruik sort om de gewenste stukken vooraan te krijgen.",
      );
    }

    return {
      items,
      total,
      ...(page.positions !== undefined ? { positions: page.positions } : {}),
      ...(page.span !== undefined ? { page_span: page.span } : {}),
      endpoint: page.url,
      params,
      access_note: notes.length ? notes.join(" ") : undefined,
    };
  }

  /**
   * A hyphenated compound in relevance order: first every publication with the
   * exact compound, then the ones where its parts occur as separate words. The
   * server cannot be asked for that order — it ranks the exact hits anywhere
   * between 1 and beyond 100 among the loose ones, and a CQL NOT to separate
   * the two changes how the other terms are matched (259 -> 555) — so the two
   * result sets are stitched together here.
   *
   * Positions 1..E (E = exact hits) are the exact result set; position E+k is
   * position k of the loose query, which also contains the exact hits. Those are
   * dropped, so a page can hold fewer records than requested while positions
   * stay stable and no publication is skipped or repeated across pages.
   */
  private async exactFirstPage(input: {
    exactCql: string;
    looseCql: string;
    compounds: string[];
    startRecord: number;
    maximumRecords: number;
    params: Record<string, string>;
    notes: string[];
  }) {
    const { exactCql, looseCql, compounds, maximumRecords: size, params, notes } = input;
    const start = input.startRecord;
    const firstCompound = compounds[0];
    // The words the loose query actually requires: "Bergen-op-Zoom" -> Bergen EN Zoom.
    const looseWords = (compoundSearchParts(firstCompound) ?? firstCompound.split("-").filter(Boolean)).join(" EN ");

    // Page 1 of both lists can be fetched at once; later pages need E first.
    const [exact, looseFirst] = await Promise.all([
      this.fetchSru(exactCql, start, size),
      start === 1 ? this.fetchSru(looseCql, 1, size) : Promise.resolve(undefined),
    ]);
    const toItems = (page: SruPage) => page.records.map((record) => searchItem(extractMeta(record)));
    const diagnostics = [exact, looseFirst].flatMap((page) => (page?.diagnostic && !page.rejected ? [page.diagnostic] : []));
    if (exact.rejected) return { items: [], url: exact.url, diagnostics, rejected: exact.diagnostic };

    const exactTotal = exact.total;
    if (exactTotal === undefined || exactTotal > EXACT_FIRST_LIMIT) {
      // Too many exact hits to stitch (or no count to stitch with): search the
      // compound exactly, as the source does by itself.
      params.query = exactCql;
      if (exactTotal !== undefined) {
        notes.push(
          `${quoteList(compounds)} is als exacte term gezocht (${exactTotal.toLocaleString("nl-NL")} treffers). ` +
            `Schrijf de woorden los (${firstCompound.split("-").filter(Boolean).join(" ")}) om ook stukken te vinden waarin ze los voorkomen.`,
        );
      }
      return { items: toItems(exact), total: exactTotal, url: exact.url, diagnostics };
    }

    params.exact_first_query = exactCql;
    const exactItems = toItems(exact);
    const looseCount = Math.max(0, size - exactItems.length);
    const looseStart = Math.max(1, start - exactTotal);
    let loose = looseFirst;
    if (!loose || looseStart !== 1) {
      loose = await this.fetchSru(looseCql, looseStart, looseCount);
      if (loose.diagnostic && !loose.rejected) diagnostics.push(loose.diagnostic);
    }
    if (loose.rejected) return { items: [], url: loose.url, diagnostics, rejected: loose.diagnostic };
    const looseTotal = loose.total;

    // The exact hits are in the loose list too; drop them there.
    const looseItems = toItems(loose).slice(0, looseCount);
    let exactIds = new Set(exactItems.map(itemIdentifier).filter((id): id is string => Boolean(id)));
    if (looseItems.length && exactTotal > 0 && exactIds.size < exactTotal) {
      const all = await this.fetchSru(exactCql, 1, exactTotal);
      exactIds = new Set(toItems(all).map(itemIdentifier).filter((id): id is string => Boolean(id)));
    }
    const fresh = looseItems.filter((item) => !exactIds.has(itemIdentifier(item) ?? ""));
    const items = [...exactItems, ...fresh];

    const positions = looseTotal === undefined ? undefined : exactTotal + looseTotal;
    const span = positions === undefined ? size : Math.max(0, Math.min(size, positions - start + 1));
    if (exactTotal === 0) {
      notes.push(`${quoteList(compounds)} komt nergens letterlijk voor; gezocht op de losse woorden (${looseWords}).`);
    } else {
      notes.push(
        `Samengestelde zoekterm ${quoteList(compounds)}: eerst de ${exactTotal.toLocaleString("nl-NL")} publicaties met precies die term, ` +
          `daarna die waarin de losse woorden voorkomen (${looseWords})` +
          `${looseTotal !== undefined ? `; samen ${looseTotal.toLocaleString("nl-NL")}` : ""}.`,
      );
      if (fresh.length < looseItems.length) {
        notes.push(
          `Deze pagina telt ${items.length} records in plaats van ${exactItems.length + looseItems.length}: ` +
            `${looseItems.length - fresh.length} publicatie(s) met de exacte term stonden al bovenaan. ` +
            `De volgende pagina begint bij startRecord ${start + span}.`,
        );
      }
    }
    return {
      items,
      // Every exact hit is also a loose hit: the loose count is the number of
      // distinct publications.
      total: looseTotal,
      positions: exactTotal > 0 ? positions : undefined,
      span: exactTotal > 0 ? span : undefined,
      url: exact.url,
      diagnostics,
    };
  }

  async getRecord(
    identifier: string,
    options: { include_text?: boolean; max_chars?: number } = {},
  ): Promise<{
    item: Record<string, unknown> | null;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const id = normalizeBekendmakingIdentifier(identifier);
    const paramsFor = (query: string, maximumRecords: number): Record<string, string> => ({
      operation: "searchRetrieve",
      version: "2.0",
      query,
      maximumRecords: String(maximumRecords),
      startRecord: "1",
      recordSchema: "gzd",
    });
    const sameId = (record: Record<string, unknown>) => (extractMeta(record).identifier ?? "").toLowerCase() === id.toLowerCase();

    // dt.identifier="x" matches every identifier CONTAINING x ("kst-37020-IX"
    // gives the 40 documents of that dossier, "stcrt-2026" 32,189), so the first
    // hit is not necessarily the one asked for. "==" is exact but case-sensitive
    // ("KST-37020-IX-40" gives 0); the containment query then finds it in any
    // case, and only a record with exactly this identifier is accepted.
    const exactQuery = `dt.identifier=="${escapeSruValue(id)}" AND ${PRODUCT_AREA}`;
    let params = paramsFor(exactQuery, 1);
    let page = await this.fetchSru(exactQuery, 1, 1);
    let match = page.records.find(sameId);
    let looseTotal: number | undefined;
    let similar: string[] = [];

    if (!match) {
      const looseQuery = `dt.identifier="${escapeSruValue(id)}" AND ${PRODUCT_AREA}`;
      const loose = await this.fetchSru(looseQuery, 1, 20);
      if (!loose.rejected || page.rejected) {
        params = paramsFor(looseQuery, 20);
        page = loose;
      }
      match = loose.records.find(sameId);
      looseTotal = loose.total;
      similar = loose.records.map((record) => extractMeta(record).identifier).filter((value): value is string => Boolean(value));
    }

    if (!match) {
      // Not found is not a record: this used to return an item made of the
      // identifier alone, with a link that leads nowhere — or another publication.
      return {
        item: null,
        endpoint: page.url,
        params,
        access_note: page.rejected
          ? `De bron weigerde de opvraging (SRU-diagnose: ${page.diagnostic}).`
          : `Geen bekendmaking gevonden met identifier '${id}'.` +
            (similar.length
              ? ` Het is wel een deel van ${looseTotal !== undefined ? `${looseTotal.toLocaleString("nl-NL")} ` : ""}andere identifiers ` +
                `(bijv. ${quoteList(similar.slice(0, 3), ", ")}), zoals een dossiernummer of jaargang; vraag één daarvan op of zoek met officiele_bekendmakingen_search.`
              : " Identifiers zien eruit als 'gmb-2026-104512', 'stcrt-2026-10001' of 'kst-37020-IX-40'; zoek ze op met officiele_bekendmakingen_search."),
      };
    }

    const item = fullItem(extractMeta(match));
    const notes: string[] = [];

    if (options.include_text) {
      const maxChars = Math.max(1, Math.min(MAX_TEXT_CHARS, options.max_chars ?? DEFAULT_TEXT_CHARS));
      const text = await this.documentText(item, maxChars);
      Object.assign(item, text);
      if (typeof text.text === "string") {
        notes.push(
          `Documenttekst opgenomen uit de ${String(text.text_format).toUpperCase()}-versie (${text.text_chars} tekens${text.text_truncated ? `, afgekapt op ${maxChars}; verhoog max_chars (max ${MAX_TEXT_CHARS}) voor meer` : ""}).`,
        );
      } else {
        notes.push(`Documenttekst niet beschikbaar: ${text.text_unavailable_reason}. Gebruik pdf_url of canonical_url.`);
      }
    }

    return {
      item,
      endpoint: page.url,
      params,
      access_note: notes.length ? notes.join(" ") : undefined,
    };
  }

  /**
   * The publication text: from the XML manifestation when there is one (clean
   * body text, no website chrome), otherwise from the PDF — older publications
   * and Kamerstuk attachments only have a PDF.
   */
  private async documentText(item: Record<string, unknown>, maxChars: number): Promise<Record<string, unknown>> {
    const xmlUrl = typeof item.xml_url === "string" ? item.xml_url : undefined;
    const pdfUrl = typeof item.pdf_url === "string" ? item.pdf_url : undefined;
    let xmlFailure: string | undefined;

    if (xmlUrl) {
      try {
        const { data } = await getText(xmlUrl, { timeoutMs: 30_000, retries: 1, disableCache: true });
        const text = publicationXmlToText(data);
        if (text) {
          // text_chars is the length returned, as fetchPdfText reports it.
          return {
            text: text.slice(0, maxChars),
            text_chars: Math.min(text.length, maxChars),
            text_truncated: text.length > maxChars,
            text_format: "xml",
            text_source_url: xmlUrl,
          };
        }
        xmlFailure = "XML-versie bevat geen tekst";
      } catch (error) {
        xmlFailure = `XML-versie niet op te halen (${error instanceof Error ? error.message : String(error)})`;
      }
    }

    if (pdfUrl) {
      const pdf = await fetchPdfText(pdfUrl, { maxChars });
      if (pdf.ok) {
        return {
          text: pdf.text,
          text_chars: pdf.chars,
          text_truncated: pdf.truncated,
          text_format: "pdf",
          text_source_url: pdf.source_url,
        };
      }
      return { text_unavailable_reason: [xmlFailure, `PDF: ${pdf.reason} (${pdf.message})`].filter(Boolean).join("; ") };
    }

    return { text_unavailable_reason: xmlFailure ?? "geen XML- of PDF-versie bij deze publicatie" };
  }
}
