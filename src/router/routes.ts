/**
 * Which routes nl_gov_ask takes for a question, in the order it tries them.
 *
 * One decision for both modes: the handler asks for the chain before it runs
 * and enters each route only when the chain holds it, and dryRun plans the
 * first route of the same chain. The handler tries the routes in this order;
 * a route that finds nothing hands the question to the next one, and
 * data.overheid.nl ends every chain. Pure: no I/O, no environment.
 */

/** Escape a term for use inside a regular expression. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A term on word boundaries, not as a substring: a short token ("mp") does
 * not match inside another word ("temperatuur", "lamp", "pomp"). Works for
 * multi-word terms ("tweede kamer", "raad van state") and hyphens
 * ("defensie-uitgaven").
 */
export function matchesTerm(haystack: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  return new RegExp(`\\b${escapeRegExp(t)}\\b`).test(haystack);
}

/** Whether the lowercased question holds one of the terms. */
export function hasTerm(q: string, terms: readonly string[]): boolean {
  return terms.some((t) => matchesTerm(q, t));
}

export const CBS_TERMS = ["cbs", "statistiek", "statistieken", "statistics", "bevolking", "population", "inwoner", "inwoners", "inflatie", "werkloos", "werkloosheid", "woning", "woningen", "inkomen", "inkomens", "economie", "bbp", "gdp", "import", "export", "geboorte", "geboortes", "sterfte", "sterfgevallen", "bevolkingsgroei", "inwonertal", "inwoneraantal", "inwonersaantal", "geregistreerde misdrijven", "geregistreerde criminaliteit", "opleidingsniveau", "opleiding", "onderwijsniveau", "emissie", "emissies"];
export const TK_TERMS = ["tweede kamer", "parlement", "motie", "moties", "amendement", "amendementen", "kamerstuk", "kamerstukken", "kamervraag", "kamervragen", "debat", "debatten", "stemming", "stemmingen", "fractie", "fracties", "commissie", "commissies", "wetsvoorstel", "wetsvoorstellen", "kamerlid", "kamerleden", "minister-president", "premier", "kamerbrief", "kamerbrieven"];
export const OB_TERMS = ["staatsblad", "staatscourant", "tractatenblad", "gemeenteblad", "provinciaal blad", "waterschapsblad", "bekendmaking", "bekendmakingen", "verordening", "verordeningen", "regeling", "regelingen", "officieel besluit", "officiele publicatie", "officiële publicatie", "officiele publicaties", "officiële publicaties", "stcrt", "gmb"];
export const RIJK_TERMS = ["rijksoverheid", "kabinet", "minister", "ministerie", "beleid", "toespraak", "schoolvakantie", "schoolvakanties", "school holiday", "school holidays", "vakantie regio"];
export const BUDGET_TERMS = ["begroting", "begrotingen", "rijksbegroting", "budget", "uitgaven", "spending", "rijksfinanci", "begrotingsartikel", "defensie-uitgaven"];
export const DUO_TERMS = ["school", "scholen", "leerling", "leerlingen", "student", "studenten", "leraar", "leraren", "docent", "docenten", "teacher", "onderwijs", "education", "slagingspercentage", "slagingspercentages", "examen", "examens", "diploma", "diplomas", "duo", "basisschool", "basisscholen", "middelbare", "mbo", "hbo", "universiteit", "universiteiten"];
export const WEATHER_TERMS = ["weer", "weather", "temperatuur", "rain", "regen", "wind", "storm", "klimaat", "earthquake", "earthquakes", "aardbeving", "aardbevingen", "seismologie", "knmi", "weerwaarschuwing", "weerwaarschuwingen", "weeralarm"];
/**
 * "Wat zegt de staatssecretaris over het omgevingsplan?": Rijksoverheid, but
 * not next to case law, where the staatssecretaris is a party ("Uitspraak
 * over een verblijfsvergunning tegen de staatssecretaris").
 */
export const RIJK_OFFICE_TERMS = ["staatssecretaris", "staatssecretarissen"];
// Not "data over": "Open data over bomen in Amsterdam" asks for datasets, not an API.
export const API_TERMS = ["welke api", "which api", "is er een api", "api heeft"];
// Case-law words split in three: the first set always means rulings, the
// second also occurs in policy questions ("Wat doet de gemeente aan
// handhaving?", "mensen met een zwaar beroep"), and "uitspraak" /
// "uitspraken" are rulings only when no office holder is their subject
// ("Uitspraken van de minister over jeugdzorg" asks for statements, see
// uitsprakenSense).
export const CASE_LAW_TERMS = ["jurisprudentie", "rechtspraak", "rechtszaak", "rechtszaken", "rechterlijke uitspraak", "rechterlijk", "ecli", "vonnis", "vonnissen", "arrest", "arresten", "gerechtshof", "rechtbank", "raad van state", "hoge raad", "centrale raad van beroep", "college van beroep", "tuchtrecht", "bestuursrecht"];
export const ENFORCEMENT_TERMS = ["beschikking", "gesanctioneerd", "sanctie", "sancties", "handhaving", "boete", "overtreding", "beroep", "bezwaar"];
export const VERKIEZING_TERMS = ["verkiezing", "verkiezingen", "statenverkiezing", "statenverkiezingen", "kamerverkiezing", "kamerverkiezingen", "gemeenteraadsverkiezing", "gemeenteraadsverkiezingen", "waterschapsverkiezing", "waterschapsverkiezingen", "verkiezingsuitslag", "verkiezingsuitslagen", "kiesraad", "opkomst", "opkomstpercentage", "gestemd", "stembureau", "stembureaus", "kiesgerechtigden", "election", "election results"];
export const AANBESTEDING_TERMS = ["aanbesteding", "aanbestedingen", "tender", "tenders", "tenderned", "gunning", "gunningen", "gegund", "marktconsultatie", "offerteaanvraag", "overheidsopdracht", "overheidsopdrachten", "inkoop", "procurement"];
// Disciplinary law has its own collection; rechtspraak.nl does not carry it.
export const TUCHTRECHT_TERMS = ["tuchtrecht", "tuchtcollege", "tuchtcolleges", "tuchtklacht", "tuchtklachten", "tuchtzaak", "tuchtzaken", "berisping", "doorhaling", "tuchtrechter"];
export const GEWAS_TERMS = ["gewasperceel", "gewaspercelen", "landbouwperceel", "landbouwpercelen", "landbouwgrond", "akkerbouw", "gewas", "gewassen", "teelt", "grondgebruik", "agrarisch"];
export const CATALOGI_TERMS = ["productbeschrijving", "productbeschrijvingen", "samenwerkende catalogi", "gemeentelijke dienstverlening", "welke gemeenten bieden", "loket"];
// Only unambiguous air-quality words: bare "stikstof" is a parliamentary and
// agricultural topic, so it must keep routing to Tweede Kamer / CBS.
export const LUCHT_TERMS = ["luchtkwaliteit", "luchtvervuiling", "luchtverontreiniging", "fijnstof", "fijn stof", "smog", "stikstofdioxide", "no2", "pm10", "pm2.5", "pm25", "ozon", "luchtmeetnet", "air quality"];
export const EXAM_TERMS = ["examen", "examens", "eindexamen", "slagingspercentage", "geslaagd", "geslaagden", "gezakt", "examencijfer", "examencijfers", "examenresultaten"];
export const SCHOOL_TERMS = ["school", "scholen", "basisschool", "basisscholen", "middelbare school", "middelbare scholen", "onderwijsinstelling", "onderwijsinstellingen", "vestiging", "vestigingen", "schooladres", "schooladressen"];

/** The school holidays by name: "Wanneer is de herfstvakantie in regio zuid?". */
const NAMED_SCHOOL_HOLIDAY_RE = /(?:^|[^\p{L}])(?:herfst|kerst|voorjaars|mei|zomer)vakanties?(?=$|[^\p{L}])/u;
/** A recess of a council or parliament is no school holiday ("zomervakantie van de Tweede Kamer"). */
const NOT_A_SCHOOL_HOLIDAY_RE = /(?:^|[^\p{L}])(?:kamer|reces|raad|gemeenteraad|staten)(?=$|[^\p{L}])/u;

/** A school holiday question: answered from the Rijksoverheid holiday calendar. */
export function isSchoolHolidayQuestion(q: string): boolean {
  return q.includes("schoolvakantie") || q.includes("schoolvakanties") || q.includes("school holiday") || q.includes("school holidays") ||
    (NAMED_SCHOOL_HOLIDAY_RE.test(q) && !NOT_A_SCHOOL_HOLIDAY_RE.test(q));
}

/**
 * A local regulation by its name: "Afvalstoffenverordening Rotterdam",
 * "Huisvestingsverordening Amsterdam", "APV Utrecht". Its text is in the
 * Gemeenteblad (Officiële Bekendmakingen); the word-boundary terms miss the
 * compounds. Not the Omgevingswet's own instruments (omgevingsverordening,
 * waterschapsverordening), which have the DSO.
 */
export const LOCAL_REGULATION_RE = /(?:^|[^\p{L}])(?:(?!omgevings|waterschaps)\p{L}{3,}verordening(?:en)?|apv(?:'s)?|algemene plaatselijke verordening(?:en)?)(?=$|[^\p{L}])/u;

/** The school sector a per-school DUO question asks for. */
export function duoSector(q: string): "vo" | "mbo" | "ho" | "po" {
  return /middelbare|voortgezet|havo|vwo|vmbo|middelbaar/.test(q)
    ? "vo"
    : /\bmbo\b|beroepsonderwijs/.test(q)
      ? "mbo"
      : /\bhbo\b|universiteit|hogeschool|hoger onderwijs/.test(q)
        ? "ho"
        : "po";
}

/**
 * What the route decision reads from a question. The handler derives the
 * intents (they need its query helpers); the term routes match `q` here.
 */
export interface RouteFacts {
  /** The question without its time phrase, lowercased: what the term lists match. */
  q: string;
  /** The place the question names (extractPlaceName). */
  place: string | undefined;
  /** An EU act or EU search (detectEuIntent). */
  eu: boolean;
  /** An Omgevingswet document question with DSO_API_KEY set (detectDsoIntent). */
  dso: boolean;
  /** Rulings the question names by a Dutch ECLI (detectEcliIntent). */
  ecli: boolean;
  /** Only ECLIs of other countries or the EU, none Dutch (detectForeignEcliIntent). */
  foreignEcli: boolean;
  /** An artikel of a named national law (detectWetArtikelIntent). */
  wetArtikel: boolean;
  /** The Algemene Rekenkamer, the SCP or the WODC named with a topic (detectResearchOrgIntent). */
  research: "rekenkamer" | "scp" | "wodc" | undefined;
  /** What was said in a Tweede Kamer debate (detectDebatIntent). */
  debat: boolean;
  /** The algorithms of a government body (detectAlgoritmeIntent). */
  algoritme: boolean;
  /** Two or more planner sources and a multi-source signal: they run side by side. */
  multi: boolean;
  /** The planner sources the multi-source route runs (without the API register when its key is missing). */
  multiSources: string[];
  /** A budget question. */
  budget: boolean;
  /** Case law or enforcement words: the Rechtspraak route. */
  rechtspraak: boolean;
  /** Rijksoverheid words, or a staatssecretaris without case law (RIJK_OFFICE_TERMS). */
  rijk: boolean;
  /** A named municipality with topic words left: its council records in ORI. */
  oriGemeente: boolean;
  /** An organisation or policy question with topic words: early (strong signal) or late. */
  policy: "early" | "late" | undefined;
  /** The policy search also reads council records (ORI). */
  policyMunicipal: boolean;
}

export type RouteId =
  | "eu_cellar"
  | "dso"
  | "uitspraak"
  | "ecli_buitenland"
  | "wet_artikel"
  | "debat"
  | "algoritme"
  | "rekenkamer"
  | "scp"
  | "wodc"
  | "multi"
  | "schoolvakanties"
  | "verkiezingen"
  | "tenderned"
  | "tuchtrecht"
  | "gewaspercelen"
  | "luchtmeetnet"
  | "catalogi"
  | "duo_scholen"
  | "cbs"
  | "ori_gemeente"
  | "tk"
  | "ob"
  | "policy_early"
  | "rijk"
  | "budget"
  | "duo"
  | "knmi"
  | "api"
  | "rechtspraak"
  | "policy"
  | "data_overheid";

export interface Route {
  id: RouteId;
  matches: (f: RouteFacts) => boolean;
  /** The sources the route asks, as dryRun names them (estimated_sources). */
  sources: (f: RouteFacts) => string[];
}

const one = (source: string) => () => [source];
const policySources = (f: RouteFacts) => [...(f.policyMunicipal ? ["ori"] : []), "ob", "tk", "rijk"];

/** The routes in the order the handler tries them. */
export const ROUTES: readonly Route[] = [
  // EU legislation first: "Verordening (EU) 2016/679" would otherwise hit the publication words.
  { id: "eu_cellar", matches: (f) => f.eu, sources: one("eu_cellar") },
  { id: "dso", matches: (f) => f.dso, sources: one("dso_omgevingsdocumenten") },
  // A ruling named by its ECLI and an artikel of a named law are read, not searched.
  { id: "uitspraak", matches: (f) => f.ecli, sources: one("rechtspraak_uitspraak") },
  // No request: a ruling of another country or the EU is not on Rechtspraak.nl; the answer says where it is.
  { id: "ecli_buitenland", matches: (f) => f.foreignEcli, sources: () => [] },
  { id: "wet_artikel", matches: (f) => f.wetArtikel, sources: one("wetten_bwb") },
  { id: "debat", matches: (f) => f.debat, sources: one("tweede_kamer_debatten") },
  { id: "algoritme", matches: (f) => f.algoritme, sources: one("algoritmeregister") },
  // A research body named in the question: its own publications.
  { id: "rekenkamer", matches: (f) => f.research === "rekenkamer", sources: one("rekenkamer") },
  { id: "scp", matches: (f) => f.research === "scp", sources: one("scp") },
  { id: "wodc", matches: (f) => f.research === "wodc", sources: one("wodc") },
  { id: "multi", matches: (f) => f.multi, sources: (f) => f.multiSources },
  { id: "schoolvakanties", matches: (f) => isSchoolHolidayQuestion(f.q), sources: one("rijk") },
  // Specific sources before the broad statistical and parliamentary routes.
  { id: "verkiezingen", matches: (f) => hasTerm(f.q, VERKIEZING_TERMS), sources: one("verkiezingsuitslagen") },
  { id: "tenderned", matches: (f) => hasTerm(f.q, AANBESTEDING_TERMS), sources: one("tenderned") },
  { id: "tuchtrecht", matches: (f) => hasTerm(f.q, TUCHTRECHT_TERMS), sources: one("tuchtrecht") },
  { id: "gewaspercelen", matches: (f) => hasTerm(f.q, GEWAS_TERMS) && Boolean(f.place), sources: one("brp_gewaspercelen") },
  { id: "luchtmeetnet", matches: (f) => hasTerm(f.q, LUCHT_TERMS), sources: one("luchtmeetnet") },
  { id: "catalogi", matches: (f) => hasTerm(f.q, CATALOGI_TERMS), sources: one("samenwerkende_catalogi") },
  {
    id: "duo_scholen",
    // Exam results or schools: with an exam word, a school word or a place.
    matches: (f) =>
      (hasTerm(f.q, DUO_TERMS) || hasTerm(f.q, SCHOOL_TERMS) || hasTerm(f.q, EXAM_TERMS)) &&
      (hasTerm(f.q, EXAM_TERMS) || hasTerm(f.q, SCHOOL_TERMS) || Boolean(f.place)),
    sources: one("duo"),
  },
  { id: "cbs", matches: (f) => hasTerm(f.q, CBS_TERMS), sources: one("cbs") },
  { id: "ori_gemeente", matches: (f) => f.oriGemeente, sources: one("ori") },
  { id: "tk", matches: (f) => hasTerm(f.q, TK_TERMS), sources: one("tk") },
  { id: "ob", matches: (f) => hasTerm(f.q, OB_TERMS) || LOCAL_REGULATION_RE.test(f.q), sources: one("ob") },
  { id: "policy_early", matches: (f) => f.policy === "early", sources: policySources },
  { id: "rijk", matches: (f) => f.rijk, sources: one("rijk") },
  { id: "budget", matches: (f) => f.budget, sources: one("budget") },
  { id: "duo", matches: (f) => hasTerm(f.q, DUO_TERMS), sources: one("duo") },
  // No request: the answer is that the KNMI route needs its key.
  { id: "knmi", matches: (f) => hasTerm(f.q, WEATHER_TERMS), sources: one("knmi") },
  { id: "api", matches: (f) => hasTerm(f.q, API_TERMS), sources: one("api") },
  { id: "rechtspraak", matches: (f) => f.rechtspraak, sources: one("rechtspraak") },
  { id: "policy", matches: (f) => f.policy === "late", sources: policySources },
  { id: "data_overheid", matches: () => true, sources: one("data_overheid") },
];

/** The routes a question takes, in order; data.overheid.nl is always last. */
export function routeChain(facts: RouteFacts): RouteId[] {
  return ROUTES.filter((route) => route.matches(facts)).map((route) => route.id);
}

/** The first route of the chain and the sources it asks: what dryRun plans. */
export function firstRoute(facts: RouteFacts): { id: RouteId; sources: string[] } {
  const route = ROUTES.find((r) => r.matches(facts))!;
  return { id: route.id, sources: route.sources(facts) };
}
