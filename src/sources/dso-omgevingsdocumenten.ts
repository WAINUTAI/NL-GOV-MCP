import type { AppConfig } from "../types.js";
import { getJson, getText, postJson, SourceRequestError } from "../utils/http.js";
import { LOCATIESERVER_FREE, parseRdPoint, RD_EXTENT, type RdPoint } from "../utils/geo.js";
import { logger } from "../utils/logger.js";
import { placeKey, placeVariants } from "../utils/place-aliases.js";
import { extractSruRecords, parseXml } from "../utils/xml-parser.js";
import { buildDsoDocument, foldText, type DsoDocument, type DsoDocumentComponent } from "./dso-regeltekst.js";

export const DSO_PRESENTEREN_BASE =
  "https://service.omgevingswet.overheid.nl/publiek/omgevingsdocumenten/api/presenteren/v8";

const DSO_VIEWER_BASE = "https://omgevingswet.overheid.nl/regels-op-de-kaart/viewer";
/** Regels op de kaart: the only public page for a Rijk regeling without a wetten.overheid.nl text. */
export const DSO_RODK_URL = "https://omgevingswet.overheid.nl/regels-op-de-kaart";
const IDENTIFIER_BASE = "https://identifier.overheid.nl";
const WETTEN_BASE = "https://wetten.overheid.nl";

/** The DSO takes geometry in RD New only; without this header it assumes WGS84 and refuses. */
const RD_CRS = "http://www.opengis.net/def/crs/EPSG/0/28992";
const CONNECTOR = "dso_omgevingsdocumenten";
/**
 * The DSO's own lookups elsewhere, each under its own connector name: a PDOK or
 * SRU failure during a DSO search must not open the circuit of the BAG,
 * bestuurlijke-gebieden or bekendmakingen tools.
 */
const LOCATIE_CONNECTOR = "dso_locatieserver";
const BEKENDMAKING_CONNECTOR = "dso_bekendmakingen";
/** Largest page the DSO serves. */
const DSO_PAGE_SIZE = 200;
/** Catalogue pages fetched at once: the connector runs three requests at a time anyway. */
const CATALOGUE_CONCURRENCY = 3;
/** The national catalogue changes a few times a day; a new day starts a new one. */
const CATALOGUE_TTL_MS = 6 * 60 * 60 * 1000;
/** Catalogues of other days (geldigOp) kept beside today's, which is never pushed out by them. */
const PAST_CATALOGUE_MAX = 3;
/** Guards against a runaway page count (the catalogue holds about 2,000 regelingen). */
const MAX_CATALOGUE_PAGES = 50;
/** Pages of one location or bevoegd gezag fetched when filters need them all. */
const MAX_ZOEK_PAGES = 10;
const DOCUMENT_TTL_MS = 15 * 60 * 1000;
const DOCUMENT_CACHE_MAX = 4;
/** Time for a documentstructuur: an omgevingsplan is several megabytes of JSON. */
const DOCUMENT_TIMEOUT_MS = 30_000;
/** Longest bevoegdGezag, provincie, query or locatie taken: no name or address comes near it. */
const DSO_MAX_INPUT_CHARS = 200;
/**
 * How long after its bekendmaking an ontwerp without an inzagetermijn in the DSO
 * may still be ter inzage: six weeks (Awb 3:16) that often start a few days
 * after publication. Of the known termijnen, nearly all end 41-45 days after bekendOp.
 */
const TER_INZAGE_DAYS = 56;
/** Six weeks (Awb 3:16) counted from the day of bekendmaking: the earliest an inzagetermijn ends. */
const INZAGE_TERMIJN_DAYS = 41;
/** An inzagetermijn in the DSO shorter than this is no real one, often an administrative kennisgeving. */
const SHORT_INZAGE_DAYS = 28;
/** Records returned when rows is not given; a location usually has 20-40 documents, the Rijk's last. */
const DEFAULT_ROWS = 20;
const DEFAULT_ROWS_LOCATIE = 50;
/** Ontwerpen per search whose bekendmaking is looked up (redirect, title), all within BEKENDMAKING_BUDGET_MS. */
const MAX_BEKENDMAKING_LOOKUPS = 25;
const BEKENDMAKING_TIMEOUT_MS = 4_000;
const BEKENDMAKING_BUDGET_MS = 8_000;
const BEKENDMAKING_TTL_MS = 24 * 60 * 60 * 1000;
const BEKENDMAKING_CACHE_MAX = 1_000;
const ZOEK_BEKENDMAKINGEN_BASE = "https://zoek.officielebekendmakingen.nl";

export const DSO_DOCUMENT_TYPES = [
  "omgevingsplan",
  "omgevingsvisie",
  "programma",
  "omgevingsverordening",
  "waterschapsverordening",
  "voorbereidingsbesluit",
  "projectbesluit",
  "aanwijzingsbesluit_n2000",
] as const;
export type DocumentType = (typeof DSO_DOCUMENT_TYPES)[number];
export type BevoegdGezagType = "gemeente" | "provincie" | "waterschap" | "ministerie";
export type DsoSoort = "regelingen" | "ontwerpregelingen";

/**
 * Which DSO regeling types (type.waarde) a documentType stands for. Exact names:
 * "Voorbeschermingsregels Omgevingsplan" is the rule set of a voorbereidingsbesluit,
 * not an omgevingsplan.
 */
const DOCUMENT_TYPE_NAMES: Record<DocumentType, (waarde: string) => boolean> = {
  omgevingsplan: (w) => w === "omgevingsplan",
  omgevingsvisie: (w) => w === "omgevingsvisie",
  programma: (w) => w === "programma",
  omgevingsverordening: (w) => w === "omgevingsverordening",
  waterschapsverordening: (w) => w === "waterschapsverordening",
  // Voorbeschermingsregels, … Omgevingsplan, … Omgevingsverordening: what a voorbereidingsbesluit lays down.
  voorbereidingsbesluit: (w) => w.startsWith("voorbeschermingsregels"),
  projectbesluit: (w) => w === "projectbesluit" || w === "omgevingsplanregels projectbesluit",
  aanwijzingsbesluit_n2000: (w) => w === "aanwijzingsbesluit n2000",
};

/** STOP regelingtype codes (waardelijst soortregeling), for an item without a type name. */
const DOCUMENT_TYPE_CODES: Record<DocumentType, string[]> = {
  omgevingsplan: ["regelingtype_003"],
  omgevingsvisie: ["regelingtype_006"],
  programma: ["regelingtype_010"],
  omgevingsverordening: ["regelingtype_004"],
  waterschapsverordening: ["regelingtype_005"],
  voorbereidingsbesluit: ["regelingtype_009", "regelingtype_015", "regelingtype_016"],
  projectbesluit: ["regelingtype_007", "regelingtype_014"],
  aanwijzingsbesluit_n2000: ["regelingtype_012"],
};

interface ProcedureStap {
  soortStap?: { code?: string; waarde?: string };
  voltooidOp?: string;
}

interface RegelingItem {
  identificatie?: string;
  /** Ontwerpregelingen: one per ontwerpbesluit, "<regeling>_<ontwerpbesluit>" with "/" as "_". */
  technischId?: string;
  ontwerpbesluitIdentificatie?: string;
  officieleTitel?: string;
  citeerTitel?: string;
  opschrift?: string;
  publicatieID?: string;
  expressionId?: string;
  inwerkingTot?: string;
  geldigTot?: string;
  type?: { code?: string; waarde?: string };
  aangeleverdDoorEen?: { naam?: string; bestuurslaag?: string; code?: string };
  geregistreerdMet?: {
    versie?: number;
    beginInwerking?: string;
    beginGeldigheid?: string;
    eindGeldigheid?: string;
    tijdstipRegistratie?: string;
    eindRegistratie?: string;
  };
  procedureverloop?: { bekendOp?: string; ontvangenOp?: string; procedurestappen?: ProcedureStap[] };
  /** Ontwerpregelingen: the ontwerpbesluit, whose citeertitel names the change ("…, Laan van Overvliet"). */
  besluitMetadata?: { citeerTitel?: string };
  _links?: { self?: { href?: string } };
}

interface ListResponse {
  _embedded?: { regelingen?: RegelingItem[]; ontwerpregelingen?: RegelingItem[] };
  page?: { totalElements?: number; size?: number; number?: number; totalPages?: number };
}

export interface DsoSearchArgs {
  query?: string;
  /** The issuing body: TOOI code (gm0344, PV26) or a name ("Utrecht", "provincie Utrecht"). */
  bevoegdGezag?: string;
  /** An area: the provincie (name or pv code) and every gemeente in it, each with its own documents. */
  provincie?: string;
  typeBevoegdGezag?: BevoegdGezagType;
  documentType?: DocumentType;
  /** Address, postcode with house number, or place. */
  locatie?: string;
  soort?: DsoSoort;
  alleenTerInzage?: boolean;
  /** YYYY-MM-DD: the regelingen valid on that day (time travel). */
  geldigOp?: string;
  /** Records returned; default 50 with locatie, else 20. */
  rows?: number;
  /** Today (YYYY-MM-DD) for ter_inzage; defaults to today in the server's time zone. */
  today?: string;
}

/** Where documentUrl leads. */
export type DsoDocumentUrlType = "lokale_regelgeving" | "wetten_overheid" | "officiele_bekendmakingen" | "regels_op_de_kaart";

export interface DsoSearchItem {
  id: string;
  title: string;
  soort: "regeling" | "ontwerpregeling";
  documentType?: string;
  documentTypeCode?: string;
  bevoegdGezag?: string;
  bestuurslaag?: string;
  bevoegdGezagCode?: string;
  identificatie?: string;
  /** identificatie with "/" and "-" as "_": the {uriIdentificatie} of the DSO's regeling paths. */
  uriIdentificatie?: string;
  technischId?: string;
  ontwerpbesluitIdentificatie?: string;
  /** Ontwerp: the ontwerpbesluit's citeertitel; the title carries it too when it says more than the regeling's. */
  besluitTitel?: string;
  /** The regeling's citeertitel, when it differs from the title ("Projectbesluit Dijkversterking …"). */
  citeerTitel?: string;
  /** Version number of the current consolidated version (the DSO's registration count), which the dates below describe. */
  versie?: number;
  /** Start of the current version: a new version of an old plan has a recent date. */
  beginGeldigheid?: string;
  /**
   * The first day this version no longer applies (exclusive): on that day the
   * next version applies, so this one holds through the day before
   * (versieGeldigTotEnMet). Not the end of the regeling.
   */
  eindGeldigheid?: string;
  /** The last day this version applies: eindGeldigheid minus one day. */
  versieGeldigTotEnMet?: string;
  beginInwerking?: string;
  inwerkingTot?: string;
  geldigTot?: string;
  bekendOp?: string;
  beginInzagetermijn?: string;
  eindeInzagetermijn?: string;
  /** Today falls within the inzagetermijn (both days included); null: the DSO has no inzagetermijn for it. */
  terInzage?: boolean | null;
  /** Ontwerp: whether the DSO holds the inzagetermijn (its end) at all. */
  inzagetermijnBekend?: boolean;
  /** Ontwerp without an inzagetermijn in the DSO, announced in the last 56 days: possibly still ter inzage. */
  mogelijkTerInzage?: boolean;
  /** Ontwerp possibly ter inzage: days since bekendOp, so six weeks need not be counted by hand. */
  dagenSindsBekendmaking?: number;
  /** Ontwerp without an inzagetermijn in the DSO: bekendOp plus six weeks, an estimate (the real termijn often starts later). */
  eindeInzagetermijnSchatting?: string;
  /** The inzagetermijn in the DSO is under four weeks: usually an administrative kennisgeving, not the real termijn. */
  inzagetermijnOpvallendKort?: boolean;
  /** Ontwerp: the publication of its ontwerpbesluit on officielebekendmakingen.nl ("gmb-2026-409335"). */
  bekendmakingId?: string;
  bekendmakingUrl?: string;
  /**
   * Ontwerp with a title that names no subject ("Omgevingsplan gemeente Soest"):
   * the title of its publication, which does ("…: Beukenlaan 17"); null when that
   * could not be found either.
   */
  onderwerp?: string | null;
  /** A DSO record that only points to the law elsewhere (the Omgevingswet): no rules in the DSO. */
  alleenVerwijzing?: boolean;
  /** A technical DSO record without rules (the Rijk's aansluitdocument). */
  technisch?: boolean;
  /** Why a record is no ordinary rule document (alleenVerwijzing, technisch). */
  opmerking?: string;
  documentUrl: string;
  documentUrlType: DsoDocumentUrlType;
  viewerUrl: string;
  selfUrl?: string;
  raw: RegelingItem;
}

export interface DsoSearchResult {
  items: DsoSearchItem[];
  /** Matches within what was searched (see scope), or the size of the unfiltered list. */
  total: number;
  endpoint: string;
  query: Record<string, string>;
  access_note?: string;
  /** What was searched: one location, one bevoegd gezag, a provincie with its gemeenten, the whole catalogue, or the first page of the plain list. */
  scope: "locatie" | "bevoegd_gezag" | "provincie" | "catalogus" | "lijst";
  bevoegdGezag?: { code: string; naam?: string };
  provincie?: { code: string; naam?: string; gemeenten: number };
  locatie?: { invoer: string; weergavenaam: string; type?: string; rd: RdPoint };
  /** Locatie: every document found (not only those shown), per bestuurslaag, in the order gemeente, waterschap, provincie, Rijk. */
  perBestuurslaag?: Array<{ laag: string; aantal: number }>;
  /** Ontwerpen: of all found, those with an inzagetermijn in the DSO that includes today, and those possibly ter inzage. */
  terInzageAantal?: { bevestigd: number; mogelijk: number };
}

/** A request the DSO cannot answer as asked: unknown name, address not found, bad identifier. */
export class DsoInputError extends Error {
  constructor(
    message: string,
    public readonly suggestion: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DsoInputError";
  }
}

/* ------------------------------------------------------------------ */
/*  Document links                                                     */
/* ------------------------------------------------------------------ */

/**
 * Rijk regelingen whose identifier.overheid.nl entry redirects to their BWB text
 * on wetten.overheid.nl (followed on 6 Oct 2026). Other Rijk identifiers, such as
 * the NOVI's or a programma's, do not resolve there.
 */
const RIJK_BWB_IDS: Record<string, string> = {
  "/akn/nl/act/mnre1034/2020/regOW01": "BWBR0037885", // Omgevingswet
  "/akn/nl/act/mnre1034/2019/reg0001": "BWBR0045528", // Omgevingsregeling
};

/**
 * Rijk records in the DSO that are no rule document of their own. They stay in
 * the results (they are real DSO records, found at every location), marked so
 * that they are not read as one: their type and date are registration data.
 */
const DSO_NON_RULE_RECORDS: Record<string, Pick<DsoSearchItem, "alleenVerwijzing" | "technisch" | "opmerking">> = {
  "/akn/nl/act/mnre1034/2020/regOW01": {
    alleenVerwijzing: true,
    opmerking:
      "Alleen een verwijzing naar de Omgevingswet, geen regels in het DSO. De Omgevingswet is een wet, in werking sinds 1 januari 2024; type AMvB en datum 2020-08-01 zijn registratiegegevens van het DSO. De wettekst: https://wetten.overheid.nl/BWBR0037885.",
  },
  "/akn/nl/act/mnre1034/2021/OOWATRXX1": {
    technisch: true,
    opmerking: "Technisch aansluitdocument van het Rijk in het DSO ('tijdelijk ten behoeve van technisch aansluiten op DSO'); bevat geen regels.",
  },
};

/**
 * Why DSO_API_KEY cannot be sent, or undefined when it can: missing (also
 * whitespace only), or with characters no HTTP header may hold. A header
 * error would quote the value, so such a key never reaches a request.
 */
export function dsoApiKeyProblem(key: string | undefined): "ontbreekt" | "ongeldige tekens" | undefined {
  const trimmed = key?.trim();
  if (!trimmed) return "ontbreekt";
  return /^[\x21-\x7e]+$/.test(trimmed) ? undefined : "ongeldige tekens";
}

/**
 * The best human-readable page of a document:
 *  - an ontwerp: its ontwerpbesluit on identifier.overheid.nl, which redirects to the publication;
 *  - a regeling of a gemeente, provincie or waterschap: identifier.overheid.nl, which redirects
 *    to the consolidated text on lokaleregelgeving.overheid.nl;
 *  - a Rijk regeling: its BWB text on wetten.overheid.nl where known, else Regels op de kaart.
 */
export function documentLink(item: Pick<RegelingItem, "identificatie" | "ontwerpbesluitIdentificatie" | "aangeleverdDoorEen">): { url: string; type: DsoDocumentUrlType } {
  if (item.ontwerpbesluitIdentificatie?.startsWith("/akn/")) {
    return { url: `${IDENTIFIER_BASE}${item.ontwerpbesluitIdentificatie}`, type: "officiele_bekendmakingen" };
  }
  const id = item.identificatie ?? "";
  const code = (item.aangeleverdDoorEen?.code ?? /^\/akn\/nl\/act\/([^/]+)\//.exec(id)?.[1] ?? "").toLowerCase();
  if (id.startsWith("/akn/") && /^(?:gm|pv|ws)\d+$/.test(code)) {
    return { url: `${IDENTIFIER_BASE}${id}`, type: "lokale_regelgeving" };
  }
  const bwb = /(BWBR\d+)$/.exec(id)?.[1] ?? RIJK_BWB_IDS[id];
  if (bwb) return { url: `${WETTEN_BASE}/${bwb}`, type: "wetten_overheid" };
  return { url: DSO_RODK_URL, type: "regels_op_de_kaart" };
}

/**
 * identificatie as a path segment of the DSO API: every "/" and "-" becomes "_"
 * (the spec's uriIdentificatie; "…/2025/programma-biodiversiteit" is
 * "…_2025_programma_biodiversiteit"). A trailing "/" is dropped.
 */
export function uriIdentificatieFor(identificatie: string): string {
  return identificatie.replace(/\/+$/, "").replace(/[/-]/g, "_");
}

/**
 * The version of a regeling legally valid on a day. geldigOp alone means
 * "geldig then, in werking today" (the DSO's default for inWerkingOp), which
 * leaves out every regeling amended since; both together are the time travel.
 */
function tijdreis(geldigOp: string): { geldigOp: string; inWerkingOp: string } {
  return { geldigOp, inWerkingOp: geldigOp };
}

/* ------------------------------------------------------------------ */
/*  Bevoegd gezag names                                                */
/* ------------------------------------------------------------------ */

export const BEVOEGD_GEZAG_CODE = /^(?:gm|pv|ws|mnre)\d+$/i;

export interface BevoegdGezagEntry {
  code: string;
  naam: string;
  layer: BevoegdGezagType;
}

export function layerOfCode(code: string | undefined): BevoegdGezagType | undefined {
  const c = (code ?? "").toLowerCase();
  if (/^gm\d/.test(c)) return "gemeente";
  if (/^pv\d/.test(c)) return "provincie";
  if (/^ws\d/.test(c)) return "waterschap";
  if (/^mnre\d/.test(c)) return "ministerie";
  return undefined;
}

const LAYER_PLURAL: Record<BevoegdGezagType, string> = {
  gemeente: "gemeenten",
  provincie: "provincies",
  waterschap: "waterschappen",
  ministerie: "ministeries",
};

const LAYER_WORDS: Array<[RegExp, BevoegdGezagType]> = [
  [/^gemeente\s+/, "gemeente"],
  [/^provincie\s+/, "provincie"],
  [/^(?:waterschap|hoogheemraadschap|wetterskip)\s+(?:van\s+)?/, "waterschap"],
  [/^ministerie\s+(?:van\s+)?/, "ministerie"],
];

/** Lowercase words without diacritics and punctuation: "Bergen (NH)" → "bergen nh". */
function nameKey(name: string): string {
  return foldText(name).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function splitLayer(key: string): { layer?: BevoegdGezagType; core: string } {
  for (const [re, layer] of LAYER_WORDS) if (re.test(key)) return { layer, core: key.replace(re, "") };
  return { core: key };
}

const NAME_FILLERS = new Set(["de", "het", "van", "en"]);

/**
 * Short names and abbreviations people use for a body whose DSO name is longer,
 * as name cores (layer word left out). Place names with another everyday or
 * official form (Den Bosch, 's-Gravenhage, Friesland) come from place-aliases.
 */
const NAME_ABBREVIATIONS: Record<string, string> = {
  hdsr: "de stichtse rijnlanden",
  agv: "amstel gooi en vecht",
  waternet: "amstel gooi en vecht",
  hhnk: "hollands noorderkwartier",
  hhsk: "schieland en de krimpenerwaard",
  wdod: "drents overijsselse delta",
  bzk: "binnenlandse zaken en koninkrijksrelaties",
  ienw: "infrastructuur en waterstaat",
  "i en w": "infrastructuur en waterstaat",
  lnv: "landbouw natuur en voedselkwaliteit",
  lvvn: "landbouw visserij voedselzekerheid en natuur",
  ez: "economische zaken",
  ezk: "economische zaken en klimaat",
  vro: "volkshuisvesting en ruimtelijke ordening",
  kgg: "klimaat en groene groei",
};

/** The Rijk as a whole: no one bevoegd gezag, but every ministerie. */
const RIJK_NAMES = new Set(["rijk", "het rijk", "rijksoverheid", "de rijksoverheid"]);

/** The other names a name core may stand for: "den bosch" → "s hertogenbosch", "bzk" → "binnenlandse zaken …". */
function aliasCores(core: string): string[] {
  const out = new Set(placeVariants(core).map(placeKey));
  if (NAME_ABBREVIATIONS[core]) out.add(NAME_ABBREVIATIONS[core]);
  out.delete(core);
  return [...out].filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/** Gemeente, waterschap, provincie, Rijk: the order of a location's documents, closest rules first. */
const LAYER_ORDER: BevoegdGezagType[] = ["gemeente", "waterschap", "provincie", "ministerie"];
/**
 * Which body a bare name shared by several layers means: the gemeente
 * ("Utrecht"), else the provincie ("Limburg", "Fryslân"), else the waterschap.
 */
const NAME_LAYER_ORDER: BevoegdGezagType[] = ["gemeente", "provincie", "waterschap", "ministerie"];
/** A document type only one layer adopts picks that layer for a bare name. */
const DOCUMENT_TYPE_LAYER: Partial<Record<DocumentType, BevoegdGezagType>> = {
  omgevingsplan: "gemeente",
  omgevingsverordening: "provincie",
  waterschapsverordening: "waterschap",
};

function describe(entry: BevoegdGezagEntry): string {
  return `${entry.naam} (${entry.code})`;
}

/** Every bevoegd gezag that has a regeling in the DSO, with each name it delivered under. */
export function bevoegdGezagEntries(items: RegelingItem[]): BevoegdGezagEntry[] {
  const seen = new Map<string, BevoegdGezagEntry>();
  for (const item of items) {
    const code = item.aangeleverdDoorEen?.code?.toLowerCase();
    const naam = item.aangeleverdDoorEen?.naam?.trim();
    const layer = layerOfCode(code);
    if (!code || !naam || !layer) continue;
    seen.set(`${code}|${naam}`, { code, naam, layer });
  }
  return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * A bevoegd gezag from a name, matched against the names the DSO's own regelingen
 * carry, so the code always exists there. Case and accents do not matter, and
 * the layer word may be left out ("De Stichtse Rijnlanden"); everyday names and
 * abbreviations work too (Den Bosch, Friesland, HDSR, BZK). A name several
 * layers share is the layer the name or typeBevoegdGezag says; otherwise the
 * layer a documentType belongs to (an omgevingsverordening is provinciaal);
 * otherwise the gemeente ("Utrecht"), then the provincie ("Limburg"). The
 * others come back as alternatives.
 */
export function resolveBevoegdGezagName(
  input: string,
  entries: BevoegdGezagEntry[],
  typeBevoegdGezag?: BevoegdGezagType,
  documentType?: DocumentType,
): { entry: BevoegdGezagEntry; alternatives: BevoegdGezagEntry[]; byWords: boolean; byDocumentType: boolean } {
  if (input.length > DSO_MAX_INPUT_CHARS) {
    throw new DsoInputError(`Bevoegd gezag is langer dan ${DSO_MAX_INPUT_CHARS} tekens.`, "Geef de naam of de TOOI-code van één bevoegd gezag, bijv. 'Utrecht' of gm0344.");
  }
  const key = nameKey(input);
  const { layer: named, core } = splitLayer(key);
  if (!named && RIJK_NAMES.has(core)) {
    throw new DsoInputError(
      `'${input}' is geen enkel bevoegd gezag: het Rijk levert aan per ministerie.`,
      "Gebruik typeBevoegdGezag 'ministerie' voor de documenten van alle ministeries, of één ministerie, bijv. 'BZK' (mnre1034) of 'ministerie van Infrastructuur en Waterstaat' (mnre1130).",
    );
  }
  const layer = named ?? typeBevoegdGezag;
  const pool = entries
    .filter((e) => !layer || e.layer === layer)
    .map((e) => {
      const k = nameKey(e.naam);
      return { entry: e, key: k, core: splitLayer(k).core };
    });

  let matches = pool.filter((x) => x.key === key || x.core === core);
  if (!matches.length) {
    const aliases = new Set(aliasCores(core));
    matches = pool.filter((x) => aliases.has(x.core));
  }
  const byWords = !matches.length;
  if (byWords) {
    // Every word of the name, whole: "Stichtse Rijnlanden", "Binnenlandse Zaken".
    const words = core.split(" ").filter((w) => w && !NAME_FILLERS.has(w));
    matches = words.length
      ? pool.filter((x) => {
          const own = new Set(x.core.split(" "));
          return words.every((w) => own.has(w));
        })
      : [];
  }
  const byCode = [...new Map(matches.map((x) => [x.entry.code, x.entry])).values()];

  if (!byCode.length) {
    // A short name allows one typo ("Ure" for Urk), not two ("BZK" is no "Urk").
    // A distance is never below the difference in length: those are skipped unmeasured.
    const maxDistance = core.length <= 4 ? 1 : Math.max(2, Math.floor(core.length / 3));
    const close = pool
      .filter((x) => Math.abs(x.core.length - core.length) <= maxDistance)
      .map((x) => ({ entry: x.entry, distance: levenshtein(core, x.core) }))
      .filter((x) => x.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance || NAME_LAYER_ORDER.indexOf(a.entry.layer) - NAME_LAYER_ORDER.indexOf(b.entry.layer));
    const suggestions = [...new Map(close.map((x) => [x.entry.code, x.entry])).values()].slice(0, 5).map(describe);
    throw new DsoInputError(
      `Bevoegd gezag '${input}' niet gevonden onder de ${layer ? LAYER_PLURAL[layer] : "bevoegde gezagen"} met regelingen in het DSO.`,
      suggestions.length
        ? `Bedoelde u: ${suggestions.join(", ")}? Geef die naam of de TOOI-code op.`
        : "Geef de naam zoals 'gemeente Utrecht', 'provincie Utrecht' of 'De Stichtse Rijnlanden', of een TOOI-code zoals gm0344, pv26 of ws0636. Voor het Rijk: typeBevoegdGezag 'ministerie'.",
      { suggestions },
    );
  }

  const byName = NAME_LAYER_ORDER.find((l) => byCode.some((e) => e.layer === l));
  const preferred = documentType ? DOCUMENT_TYPE_LAYER[documentType] : undefined;
  const byDocumentType = !layer && Boolean(preferred) && preferred !== byName && byCode.some((e) => e.layer === preferred);
  const chosenLayer = layer ?? (byDocumentType ? preferred : byName);
  const inLayer = byCode.filter((e) => e.layer === chosenLayer);
  if (inLayer.length > 1) {
    const options = inLayer.slice(0, 8).map(describe);
    throw new DsoInputError(
      `'${input}' past op meerdere ${chosenLayer ? LAYER_PLURAL[chosenLayer] : "bevoegde gezagen"}: ${options.join(", ")}.`,
      `Geef de volledige naam of de TOOI-code van één ervan op, bijv. '${inLayer[0].code}'.`,
      { suggestions: options },
    );
  }
  return { entry: inLayer[0], alternatives: byCode.filter((e) => e.code !== inLayer[0].code), byWords, byDocumentType };
}

/* ------------------------------------------------------------------ */
/*  Matching and ordering                                              */
/* ------------------------------------------------------------------ */

const QUERY_STOPWORDS = new Set(["de", "het", "een", "van", "voor", "in", "op", "en", "der", "den", "te", "ter", "aan", "bij", "met", "over", "uit", "naar", "om", "the", "of", "and"]);

function queryWords(query: string): string[] {
  const words = nameKey(query).split(" ").filter(Boolean);
  const content = words.filter((w) => !QUERY_STOPWORDS.has(w));
  return content.length ? content : words;
}

/** What a query is matched against; for an ontwerp also its ontwerpbesluit's citeertitel (the project, the street). */
function haystack(item: RegelingItem): string {
  return nameKey(
    [item.officieleTitel, item.citeerTitel, item.opschrift, item.besluitMetadata?.citeerTitel, item.aangeleverdDoorEen?.naam, item.type?.waarde]
      .filter(Boolean)
      .join(" "),
  );
}

/** Every word of the query, whole: "omgevingsvisie Utrecht" is not "Utrechtse Heuvelrug". */
function matchesWholeWords(item: RegelingItem, words: string[]): boolean {
  const own = new Set(haystack(item).split(" "));
  return words.every((w) => own.has(w));
}

/** Every word of the query, also inside a longer word ("visie" in "omgevingsvisie"). */
function matchesPartialWords(item: RegelingItem, words: string[]): boolean {
  const text = haystack(item);
  return words.every((w) => text.includes(w));
}

export function matchesDocumentType(item: Pick<RegelingItem, "type">, documentType?: DocumentType): boolean {
  if (!documentType) return true;
  const waarde = (item.type?.waarde ?? "").trim().toLowerCase();
  if (waarde) return DOCUMENT_TYPE_NAMES[documentType](waarde);
  const code = item.type?.code ?? "";
  return DOCUMENT_TYPE_CODES[documentType].some((c) => code.endsWith(c));
}

function layerOfItem(item: RegelingItem): BevoegdGezagType | undefined {
  const byCode = layerOfCode(item.aangeleverdDoorEen?.code);
  if (byCode) return byCode;
  const laag = (item.aangeleverdDoorEen?.bestuurslaag ?? "").toLowerCase();
  return LAYER_ORDER.find((l) => laag.startsWith(l));
}

/** Gemeente, waterschap, provincie, Rijk: from the closest rules to the most general. */
function layerRank(item: DsoSearchItem): number {
  const layer = layerOfItem(item.raw);
  return layer ? LAYER_ORDER.indexOf(layer) : LAYER_ORDER.length;
}

function dateOf(item: DsoSearchItem): string {
  const registratie = item.raw.geregistreerdMet?.tijdstipRegistratie ?? "";
  return item.soort === "ontwerpregeling"
    ? (item.bekendOp ?? registratie)
    : (item.beginGeldigheid ?? item.beginInwerking ?? registratie);
}

function sortItems(items: DsoSearchItem[], byLayer: boolean): DsoSearchItem[] {
  return [...items].sort(
    (a, b) =>
      (byLayer ? layerRank(a) - layerRank(b) : 0) ||
      dateOf(b).localeCompare(dateOf(a)) ||
      a.title.localeCompare(b.title, "nl"),
  );
}

const LAYER_OF_ONE: Record<BevoegdGezagType, string> = { gemeente: "van de gemeente", waterschap: "van het waterschap", provincie: "van de provincie", ministerie: "van het Rijk" };
const LAYER_OF_MANY: Record<BevoegdGezagType, string> = { gemeente: "van gemeenten", waterschap: "van waterschappen", provincie: "van provincies", ministerie: "van het Rijk" };

/**
 * What rows left out, per bestuurslaag: at a location the Rijk comes last, so a
 * low rows silently drops the Omgevingswet. "Niet getoond (rows 20): 6 van de
 * 13 documenten van het Rijk; verhoog rows naar 26 voor de volledige lijst."
 */
function cutNote(items: DsoSearchItem[], rows: number, maxRows: number): string {
  const layers = new Map<string, { cut: number; all: number; codes: Set<string> }>();
  items.forEach((x, i) => {
    const layer = layerOfItem(x.raw) ?? "overig";
    const counts = layers.get(layer) ?? { cut: 0, all: 0, codes: new Set<string>() };
    counts.all++;
    if (i >= rows) counts.cut++;
    counts.codes.add(x.bevoegdGezagCode ?? "");
    layers.set(layer, counts);
  });
  const parts = [...layers]
    .filter(([, c]) => c.cut)
    .map(([layer, c]) => {
      const of = layer === "overig" ? "zonder bestuurslaag" : (c.codes.size > 1 ? LAYER_OF_MANY : LAYER_OF_ONE)[layer as BevoegdGezagType];
      return `${c.cut} van de ${c.all} documenten ${of}`;
    });
  return `Niet getoond (rows ${rows}): ${parts.join(", ")}; verhoog rows ${items.length <= maxRows ? `naar ${items.length}` : `(max ${maxRows})`} voor de volledige lijst.`;
}

const LAYER_LABEL: Record<BevoegdGezagType, string> = { gemeente: "gemeente", waterschap: "waterschap", provincie: "provincie", ministerie: "Rijk" };

/** Documents per bestuurslaag, gemeente to Rijk: "gemeente 3, waterschap 1, provincie 9, Rijk 13". */
function layerCounts(items: DsoSearchItem[]): Array<{ laag: string; aantal: number }> {
  const counts = new Map<string, number>();
  for (const x of items) {
    const layer = layerOfItem(x.raw);
    const laag = layer ? LAYER_LABEL[layer] : "overig";
    counts.set(laag, (counts.get(laag) ?? 0) + 1);
  }
  return [...LAYER_ORDER.map((l) => LAYER_LABEL[l]), "overig"].filter((laag) => counts.has(laag)).map((laag) => ({ laag, aantal: counts.get(laag) as number }));
}

/**
 * Voorbeschermingsregels that belong to an omgevingsplan: typed so, by
 * whichever body (also the Rijk's for a gemeente's plan), or a gemeente's own
 * generic ones; a gemeente protects nothing but its omgevingsplan. Never those
 * of an omgevingsverordening, which provincies type generically as well.
 */
function isPlanVoorbescherming(item: RegelingItem): boolean {
  if (/omgevingsverordening/i.test(`${item.officieleTitel ?? ""} ${item.citeerTitel ?? ""}`)) return false;
  const waarde = (item.type?.waarde ?? "").trim().toLowerCase();
  const code = item.type?.code ?? "";
  const ownPlan = layerOfItem(item) === "gemeente";
  if (waarde) return waarde === "voorbeschermingsregels omgevingsplan" || (waarde === "voorbeschermingsregels" && ownPlan);
  return code.endsWith("regelingtype_015") || (code.endsWith("regelingtype_009") && ownPlan);
}

/** What documentType 'omgevingsplan' left out: the plan's voorbeschermingsregels, each with identificatie and date. */
function voorbeschermingNote(found: RegelingItem[], complete: boolean): string {
  if (!found.length) return `Voorbeschermingsregels (uit een voorbereidingsbesluit) bij het omgevingsplan: ${complete ? "geen" : "geen gevonden"} in het DSO.`;
  const newest = [...found].sort((a, b) => (b.geregistreerdMet?.beginGeldigheid ?? "").localeCompare(a.geregistreerdMet?.beginGeldigheid ?? ""));
  const named = newest.slice(0, 5).map((x) => {
    const title = (x.officieleTitel ?? x.citeerTitel ?? x.opschrift ?? "Voorbeschermingsregels").replace(/\s+/g, " ").trim();
    const begin = x.geregistreerdMet?.beginGeldigheid?.slice(0, 10);
    const by = layerOfItem(x) === "gemeente" ? "" : `, ${x.aangeleverdDoorEen?.naam ?? x.aangeleverdDoorEen?.code ?? "?"}`;
    return `'${title}' (${x.identificatie ?? "?"}${begin ? `, sinds ${begin}` : ""}${by})`;
  });
  return (
    `Niet getoond met documentType 'omgevingsplan', maar tijdelijk deel van het omgevingsplan: voorbeschermingsregels uit ${found.length} ${found.length === 1 ? "voorbereidingsbesluit" : "voorbereidingsbesluiten"}: ` +
    `${named.join("; ")}${found.length > named.length ? `; en ${found.length - named.length} meer` : ""}. Toon ze met documentType 'voorbereidingsbesluit'.`
  );
}

function stapDatum(stappen: ProcedureStap[], waarde: string): string | undefined {
  return stappen.find((s) => (s.soortStap?.waarde ?? "").toLowerCase() === waarde)?.voltooidOp?.slice(0, 10);
}

/** The calendar day `days` before a YYYY-MM-DD day. */
function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/** Calendar days from one YYYY-MM-DD day to another. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Words that say an ontwerpbesluit is a draft rather than what it is about. */
const BESLUIT_FILLERS = new Set(["ontwerp", "ontwerpbesluit", "terinzagelegging", "de", "het", "van", "en", "een"]);

/**
 * Whether an ontwerpbesluit's citeertitel says more than the regeling's title:
 * "Ontwerp wijziging Omgevingsplan gemeente Montfoort, Laan van Overvliet" does,
 * "Ontwerp Actieplan geluid 2025-2029" for "Actieplan Geluid 2025-2029" does not.
 */
function addsToTitle(title: string, besluitTitel: string): boolean {
  const own = new Set(nameKey(title).split(" "));
  return nameKey(besluitTitel).split(" ").some((w) => w && !BESLUIT_FILLERS.has(w) && !own.has(w));
}

function normalize(item: RegelingItem, today: string): DsoSearchItem {
  const reg = item.geregistreerdMet ?? {};
  const ontwerp = Boolean(item.technischId || item.ontwerpbesluitIdentificatie);
  const link = documentLink(item);
  // Some titles carry the line breaks and indentation of their source XML.
  const title = (item.officieleTitel ?? item.citeerTitel ?? item.opschrift ?? "Omgevingsdocument").replace(/\s+/g, " ").trim();
  const citeerTitel = item.citeerTitel?.replace(/\s+/g, " ").trim();
  const base: DsoSearchItem = {
    id: (ontwerp ? item.technischId : undefined) ?? item.identificatie ?? item.expressionId ?? "",
    title,
    soort: ontwerp ? "ontwerpregeling" : "regeling",
    documentType: item.type?.waarde,
    documentTypeCode: item.type?.code,
    bevoegdGezag: item.aangeleverdDoorEen?.naam,
    bestuurslaag: item.aangeleverdDoorEen?.bestuurslaag,
    bevoegdGezagCode: item.aangeleverdDoorEen?.code,
    identificatie: item.identificatie,
    ...(ontwerp
      ? { technischId: item.technischId, ontwerpbesluitIdentificatie: item.ontwerpbesluitIdentificatie }
      : { uriIdentificatie: item.identificatie ? uriIdentificatieFor(item.identificatie) : undefined, versie: reg.versie }),
    ...(!ontwerp && citeerTitel && nameKey(citeerTitel) !== nameKey(title) ? { citeerTitel } : {}),
    beginGeldigheid: reg.beginGeldigheid,
    eindGeldigheid: reg.eindGeldigheid,
    // eindGeldigheid is exclusive: on that day the next version applies.
    ...(reg.eindGeldigheid && /^\d{4}-\d{2}-\d{2}/.test(reg.eindGeldigheid) ? { versieGeldigTotEnMet: daysBefore(reg.eindGeldigheid.slice(0, 10), 1) } : {}),
    beginInwerking: reg.beginInwerking,
    inwerkingTot: item.inwerkingTot,
    geldigTot: item.geldigTot,
    documentUrl: link.url,
    documentUrlType: link.type,
    viewerUrl: DSO_VIEWER_BASE,
    selfUrl: item._links?.self?.href,
    ...(item.identificatie ? DSO_NON_RULE_RECORDS[item.identificatie] : undefined),
    raw: item,
  };
  if (!ontwerp) return base;
  const stappen = item.procedureverloop?.procedurestappen ?? [];
  const begin = stapDatum(stappen, "begin inzagetermijn");
  const einde = stapDatum(stappen, "einde inzagetermijn");
  const bekendOp = item.procedureverloop?.bekendOp?.slice(0, 10) ?? stapDatum(stappen, "publicatie");
  const besluitTitel = item.besluitMetadata?.citeerTitel?.replace(/\s+/g, " ").trim() || undefined;
  const mogelijkTerInzage = !einde && Boolean(bekendOp && bekendOp <= today && bekendOp >= daysBefore(today, TER_INZAGE_DAYS));
  // About a third of recent ontwerpen carry no inzagetermijn in the DSO: their
  // termijn is only in the bekendmaking, so terInzage is unknown (null), not false.
  return {
    ...base,
    title: besluitTitel && addsToTitle(base.title, besluitTitel) ? `${base.title} — ${besluitTitel}` : base.title,
    besluitTitel,
    bekendOp,
    beginInzagetermijn: begin,
    eindeInzagetermijn: einde,
    terInzage: einde ? (begin ?? bekendOp ?? "") <= today && today <= einde : null,
    inzagetermijnBekend: Boolean(einde),
    mogelijkTerInzage,
    ...(mogelijkTerInzage && bekendOp ? { dagenSindsBekendmaking: daysBetween(bekendOp, today) } : {}),
    ...(!einde && bekendOp ? { eindeInzagetermijnSchatting: daysBefore(bekendOp, -INZAGE_TERMIJN_DAYS) } : {}),
    // "9 tot en met 10 mei" for a six-week termijn: a kennisgeving after the fact, not the termijn.
    ...(begin && einde && daysBetween(begin, einde) < SHORT_INZAGE_DAYS ? { inzagetermijnOpvallendKort: true } : {}),
  };
}

/**
 * Words of a title that say nothing about what a document regulates: the
 * document type, the layer, and what the DSO puts before a regeling title.
 */
const GENERIC_TITLE_WORDS = new Set(["omgevingsplan", "omgevingsvisie", "programma", "gemeente", "provincie", "waterschap", "hoogheemraadschap", "technische", "publicatie", "vangnetregeling", "ontwerp", "wijziging", "ontwerpwijziging", "de", "het", "van", "en"]);

/** A title that is only the regeling and its body ("Omgevingsplan gemeente Soest"): it names no subject. */
function genericTitle(item: DsoSearchItem, title = item.title): boolean {
  const own = new Set([...nameKey(item.bevoegdGezag ?? "").split(" "), ...nameKey(item.documentType ?? "").split(" ")]);
  return nameKey(title)
    .split(" ")
    .every((w) => !w || GENERIC_TITLE_WORDS.has(w) || own.has(w));
}

/** The subject in a publication's title: "Beukenlaan 17" of "Ontwerpwijziging Omgevingsplan gemeente Soest: Beukenlaan 17". */
function subjectOf(item: DsoSearchItem, publicationTitle: string): string {
  const parts = /^(.+?)(?:\s+[-–]\s+|:\s+)(.+)$/.exec(publicationTitle);
  return parts && genericTitle(item, parts[1]) ? parts[2] : publicationTitle;
}

/* ------------------------------------------------------------------ */
/*  Locatie: from an address or place to one RD point                  */
/* ------------------------------------------------------------------ */

interface LocatieDoc {
  weergavenaam?: string;
  centroide_rd?: string;
  type?: string;
  woonplaatsnaam?: string;
  gemeentenaam?: string;
  huisnummer?: number;
  huis_nlt?: string;
  postcode?: string;
  score?: number;
}

/** What the Locatieserver is asked for each hit. */
const LOCATIE_FIELDS = "weergavenaam,centroide_rd,type,woonplaatsnaam,gemeentenaam,huisnummer,huis_nlt,postcode,score";

/** The fields a hit may lack, read from its weergavenaam ("Lange Voorhout 58A-1, 2514EG 's-Gravenhage"). */
function completeLocatieDoc(doc: LocatieDoc): LocatieDoc {
  const naam = doc.weergavenaam ?? "";
  const out = { ...doc };
  if (doc.type === "adres" && doc.huisnummer === undefined) {
    const nummer = /\s(\d{1,5})([^\s,]*)\s*,/.exec(naam);
    if (nummer) {
      out.huisnummer = Number(nummer[1]);
      out.huis_nlt ??= `${nummer[1]}${nummer[2]}`;
    }
  }
  out.postcode ??= /(?:^|\s)([1-9]\d{3}[A-Z]{2})(?=\s|$)/.exec(naam)?.[1];
  if (!doc.woonplaatsnaam && ["adres", "weg", "postcode"].includes(doc.type ?? "")) {
    out.woonplaatsnaam = /,\s*(?:[1-9]\d{3}[A-Z]{2}\s+)?([^,]+)$/.exec(naam)?.[1]?.trim();
  }
  return out;
}

/** Words that only fill an address or place name: "Unter den Linden", "Laan van Nieuw Guinea". */
const LOCATIE_FILLERS = new Set(["de", "den", "der", "het", "van", "aan", "op", "in", "bij", "te", "ter", "en", "the", "postcode", "adres"]);

/**
 * The input as the Locatieserver reads it best: without a leading "postcode"
 * or "adres", and with a postcode's space taken out ("3524 BN" → "3524BN": with
 * the space PDOK puts the woonplaats Echteld first). Lowercase letters count as
 * a postcode only at the start, so "Rijksstraatweg 1000 de Meern" stays as it is.
 */
function locatieQuery(input: string): string {
  return input
    .replace(/^\s*(?:postcode|adres|locatie)\s*:?\s+/i, "")
    .replace(/^([1-9]\d{3})\s?(?!sa|sd|ss)([a-z]{2})(?![\p{L}])/iu, (_, digits: string, letters: string) => `${digits}${letters.toUpperCase()}`)
    .replace(/(^|[^\p{L}\d])([1-9]\d{3})\s?(?!SA|SD|SS)([A-Z]{2})(?![\p{L}])/gu, "$1$2$3")
    .replace(/\s+/g, " ")
    .trim();
}

interface LocatieParts {
  postcode?: string;
  huisnummer?: number;
  toevoeging?: string;
  /** The ordinal a street name starts with: 1 for "1e Hogeweg", 2 for "2de Daalsedijk". */
  ordinal?: number;
  /** The folded words without digits: what the place, street or landmark is called. */
  key: string;
}

/**
 * An ordinal before a street name, at the start of the input or of a part
 * after a comma: "1e Hugo de Grootstraat 10", "Amsterdam, 2e Weteringdwarsstraat 5".
 * Elsewhere it is a house number with a toevoeging ("Dorpsstraat 12e").
 */
const STREET_ORDINAL = /(^|,\s*)(\d{1,2})(?:e|de|ste)(?=\s+\p{L})/iu;
/** How PDOK writes an ordinal street name in full: "Eerste Hugo de Grootstraat". */
const ORDINAL_WORDS = ["", "eerste", "tweede", "derde", "vierde", "vijfde", "zesde", "zevende", "achtste", "negende", "tiende"];

function locatieParts(query: string): LocatieParts {
  const postcode = /(?:^|[^\p{L}\d])([1-9]\d{3}[A-Z]{2})(?![\p{L}])/u.exec(query)?.[1];
  const ordinal = STREET_ORDINAL.exec(query);
  // The house number follows the street: "1e" in "1e Hugo de Grootstraat 10" is part of the name.
  const withoutOrdinal = ordinal ? query.replace(STREET_ORDINAL, "$1") : query;
  const nummer = /(?:^|[\s,])(\d{1,5})(?:\s?([a-z])(?![\p{L}]))?(?=$|[\s,-])/iu.exec(withoutOrdinal);
  return {
    postcode,
    huisnummer: nummer ? Number(nummer[1]) : undefined,
    toevoeging: nummer?.[2]?.toUpperCase(),
    ...(ordinal ? { ordinal: Number(ordinal[2]) } : {}),
    key: nameKey(query).split(" ").filter((w) => w && !/\d/.test(w)).join(" "),
  };
}

/** The ordinal as the input wrote it, for a new query: "2e". */
function ordinalWord(parts: LocatieParts): string {
  return parts.ordinal ? `${parts.ordinal}e` : "";
}

/** A hit on the street with the ordinal asked for: "1e Hogeweg" is "Eerste Hogeweg" too, never "2e Hogeweg". */
function hasOrdinal(doc: LocatieDoc, ordinal: number): boolean {
  const own = new RegExp(`^${ordinal}(?:e|de|ste)$`);
  return nameKey(doc.weergavenaam ?? "")
    .split(" ")
    .some((w) => own.test(w) || (ORDINAL_WORDS[ordinal] !== undefined && w === ORDINAL_WORDS[ordinal]));
}

/** A gemeente or woonplaats the input names, by any of its names ("Den Haag" for 's-Gravenhage). */
interface NamedPlace {
  naam: string;
  field: "gemeentenaam" | "woonplaatsnaam";
  keys: Set<string>;
  /** The input's words without the place name. */
  rest: string[];
}

/**
 * The place an input names, from the gemeenten and woonplaatsen of the hits:
 * a name of one of them as whole words at the start or the end of the input
 * ("Brennerbaan 150, Utrecht", "Utrecht Centraal"). A place name in the middle
 * is part of a street ("Unter den Linden 1 Berlin" is not in Linden), unless
 * `middle` allows it (an input without a house number: "Station Utrecht Centraal").
 */
function namedPlace(key: string, docs: LocatieDoc[], middle = false): NamedPlace | undefined {
  const words = key.split(" ").filter(Boolean);
  const found: Array<{ naam: string; keys: Set<string>; length: number; start: number; atEnd: boolean }> = [];
  for (const naam of new Set(docs.flatMap((d) => [d.gemeentenaam, d.woonplaatsnaam]).filter((n): n is string => Boolean(n)))) {
    const keys = new Set(placeVariants(naam).map(placeKey).filter(Boolean));
    for (const k of keys) {
      const length = k.split(" ").length;
      if (words.length >= length && words.slice(-length).join(" ") === k) found.push({ naam, keys, length, start: words.length - length, atEnd: true });
      else if (words.slice(0, length).join(" ") === k) found.push({ naam, keys, length, start: 0, atEnd: false });
      else if (middle) {
        const start = words.findIndex((_, i) => words.slice(i, i + length).join(" ") === k);
        if (start > 0) found.push({ naam, keys, length, start, atEnd: false });
      }
    }
  }
  // The end first (the usual "street, place"), then the longest name.
  const best = found.sort((a, b) => Number(b.atEnd) - Number(a.atEnd) || b.length - a.length)[0];
  if (!best) return undefined;
  // A gemeente holds its woonplaatsen: "Veldhuizerweg 5, Utrecht" may lie in De Meern.
  const field = docs.some((d) => d.gemeentenaam && best.keys.has(placeKey(d.gemeentenaam))) ? "gemeentenaam" : "woonplaatsnaam";
  const rest = [...words.slice(0, best.start), ...words.slice(best.start + best.length)];
  return { naam: best.naam, field, keys: best.keys, rest };
}

function inPlace(doc: LocatieDoc, place: NamedPlace): boolean {
  return [doc.woonplaatsnaam, doc.gemeentenaam].some((n) => n && place.keys.has(placeKey(n)));
}

/** The words that must be found: letters only, three or more, no fillers. */
function contentWords(words: string[]): string[] {
  return words.filter((w) => /^\p{L}{3,}$/u.test(w) && !LOCATIE_FILLERS.has(w));
}

/**
 * Whether a hit is called what the input says: more than half of the words
 * start a word of the hit by their first four letters ("Brenerbaan" is
 * "Brennerbaan"; "den" does not count, so "Unter den Linden, Berlin" is no
 * "de Linden, Wagenborgen"). The Locatieserver always answers something.
 */
function resembles(words: string[], doc: LocatieDoc): boolean {
  if (!words.length) return true;
  const found = nameKey(doc.weergavenaam ?? "").split(" ");
  const hits = words.filter((w) => found.some((f) => f.startsWith(w.slice(0, 4)))).length;
  return hits * 2 > words.length;
}

function hasPostcode(doc: LocatieDoc, postcode: string): boolean {
  return (doc.postcode ?? nameKey(doc.weergavenaam ?? "").replace(/\s/g, "").toUpperCase()).includes(postcode);
}

/** An address with the house number asked for: "Lange Voorhout 1", not "58A-1"; "1G-1" is in building 1. */
function isAddress(doc: LocatieDoc, parts: LocatieParts): boolean {
  return doc.type === "adres" && parts.huisnummer !== undefined && doc.huisnummer === parts.huisnummer;
}

/** That address exactly: with the toevoeging asked for, or without one when none was asked. */
function isExactAddress(doc: LocatieDoc, parts: LocatieParts): boolean {
  const nlt = (doc.huis_nlt ?? "").toUpperCase();
  return isAddress(doc, parts) && (parts.toevoeging ? nlt.startsWith(`${parts.huisnummer}${parts.toevoeging}`) : nlt === String(parts.huisnummer));
}

/** The street of an address, road or postcode hit, its ordinal written out: "oude kerkstraat" of "Oude Kerkstraat 1, 3572TG Utrecht". */
function streetWords(doc: LocatieDoc): string[] {
  const naam = doc.weergavenaam ?? "";
  const street = doc.type === "adres" ? (/^(.*?)\s+\d/.exec(naam)?.[1] ?? "") : naam.split(",")[0];
  return nameKey(street)
    .split(" ")
    .map((w) => {
      const ordinal = /^(\d{1,2})(?:e|de|ste)$/.exec(w);
      return ordinal ? (ORDINAL_WORDS[Number(ordinal[1])] ?? w) : w;
    })
    .filter((w) => /^\p{L}{3,}$/u.test(w) && !LOCATIE_FILLERS.has(w));
}

/**
 * Whether a hit lies on another street than the input names: its street has a
 * word the input lacks ("Oude Kerkstraat 1" for "Kerkstraat 1", "Tweede …" for
 * a street asked without ordinal). Prefixes count, so "Burg." is "Burgemeester".
 */
function otherStreet(doc: LocatieDoc, words: string[], parts: LocatieParts): boolean {
  if (!words.length || !["adres", "weg", "postcode"].includes(doc.type ?? "")) return false;
  const asked = parts.ordinal ? ORDINAL_WORDS[parts.ordinal] : undefined;
  return streetWords(doc).some((s) => s !== asked && !words.some((w) => s.startsWith(w.slice(0, 4)) || w.startsWith(s.slice(0, 4))));
}

/**
 * How well a hit answers the input, lower is better. With a house number: the
 * address itself, the same number with another toevoeging, the street, a
 * postcode of the street; each on another street only after all of those.
 * With a postcode alone the postcode; otherwise the name without extra words.
 */
function locatieRank(doc: LocatieDoc, words: string[], parts: LocatieParts): number {
  const other = otherStreet(doc, words, parts);
  if (parts.huisnummer !== undefined) {
    const kind = isExactAddress(doc, parts) ? 0 : isAddress(doc, parts) ? 1 : doc.type === "weg" ? 2 : doc.type === "postcode" ? 3 : undefined;
    if (kind === undefined) return Number.POSITIVE_INFINITY;
    return other ? kind + 4 : kind;
  }
  if (parts.postcode) return doc.type === "postcode" ? 0 : 1;
  return other ? 1 : 0;
}

/**
 * The hit that matches best (locatieRank), in the Locatieserver's order among
 * equals: with a postcode only hits with that postcode, with an ordinal only
 * the street with that ordinal. A street without the house number, or another
 * street than the one named, comes with a note that says so.
 */
function pickLocatie(docs: LocatieDoc[], words: string[], parts: LocatieParts): { doc: LocatieDoc; rank: number; note?: string } | undefined {
  let best: { doc: LocatieDoc; rank: number } | undefined;
  for (const doc of docs) {
    if (!resembles(words, doc) || (parts.postcode && !hasPostcode(doc, parts.postcode)) || (parts.ordinal && !hasOrdinal(doc, parts.ordinal))) continue;
    const rank = locatieRank(doc, words, parts);
    if (rank !== Number.POSITIVE_INFINITY && (!best || rank < best.rank)) best = { doc, rank };
  }
  if (!best || parts.huisnummer === undefined) return best;
  const nummer = `${parts.huisnummer}${parts.toevoeging ?? ""}`;
  const note =
    best.rank % 4 >= 2
      ? `Huisnummer ${nummer} niet gevonden; gebruikt: het middelpunt van ${best.doc.weergavenaam}${best.rank >= 4 ? " (een andere straat dan gevraagd)" : ""}.`
      : best.rank >= 4
        ? `Geen huisnummer ${nummer} gevonden aan de gevraagde straat; gebruikt: ${best.doc.weergavenaam} (een andere straat).`
        : undefined;
  return { ...best, note };
}

/** Calendar day (YYYY-MM-DD) in a time zone. */
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function listItems(data: ListResponse, soort: DsoSoort): RegelingItem[] {
  return data._embedded?.[soort] ?? [];
}

/** One record per regeling (identificatie) or per ontwerpbesluit (technischId). */
function dedupe(items: RegelingItem[], soort: DsoSoort): RegelingItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = (soort === "ontwerpregelingen" ? item.technischId : item.identificatie) ?? JSON.stringify(item).slice(0, 200);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ------------------------------------------------------------------ */
/*  Identifiers for the text tool                                      */
/* ------------------------------------------------------------------ */

export type DsoIdentificatie =
  | { kind: "regeling"; uriIdentificatie: string; identificatie?: string }
  | { kind: "ontwerpregeling"; technischId: string }
  | { kind: "ontwerpbesluit"; ontwerpbesluitIdentificatie: string };

/**
 * What dso_omgevingsdocument_tekst accepts: "/akn/nl/act/…" (also with an
 * expression part "/nld@…"), its uriIdentificatie "_akn_nl_act_…", an
 * identifier.overheid.nl or DSO API URL, an ontwerp's technischId (it holds
 * "_akn_nl_bill_"), or an ontwerpbesluit "/akn/nl/bill/…".
 */
export function parseDsoIdentificatie(input: string): DsoIdentificatie | undefined {
  let id = input.trim();
  if (/^https?:\/\//i.test(id)) {
    let url: URL;
    try {
      url = new URL(id);
    } catch {
      return undefined;
    }
    const host = url.hostname.toLowerCase();
    if (host === "identifier.overheid.nl") {
      id = decodeURIComponent(url.pathname);
    } else if (host.endsWith("omgevingswet.overheid.nl")) {
      const m = /\/(regelingen|ontwerpregelingen)\/([^/?#]+)/.exec(url.pathname);
      if (!m) return undefined;
      // A path segment holds no "-": the DSO writes it as "_", as in uriIdentificatie.
      const segment = decodeURIComponent(m[2]).replace(/-/g, "_");
      return m[1] === "ontwerpregelingen" ? { kind: "ontwerpregeling", technischId: segment } : { kind: "regeling", uriIdentificatie: segment };
    } else {
      return undefined;
    }
  }
  if (/^akn\//i.test(id)) id = `/${id}`;
  if (id.startsWith("/akn/")) {
    // "/akn/nl/act/gm0344/2020/omgevingsplan/nld@2026-08-19;0903" is a version of the work before it.
    id = id.replace(/\/+$/, "").replace(/\/[a-z]{3}@[^/]*$/i, "").replace(/\/+$/, "");
    if (/^\/akn\/nl\/bill\//i.test(id)) return { kind: "ontwerpbesluit", ontwerpbesluitIdentificatie: id };
    if (/^\/akn\/nl\/act\//i.test(id)) return { kind: "regeling", uriIdentificatie: uriIdentificatieFor(id), identificatie: id };
    return undefined;
  }
  if (/^_akn_nl_act_/i.test(id)) {
    // A uriIdentificatie written with the identificatie's "-" ("…_programma-biodiversiteit").
    id = id.replace(/-/g, "_");
    return id.includes("_akn_nl_bill_") ? { kind: "ontwerpregeling", technischId: id } : { kind: "regeling", uriIdentificatie: id };
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Caches                                                             */
/* ------------------------------------------------------------------ */

interface Catalogue {
  items: RegelingItem[];
  /** totalElements the DSO reported. */
  total: number;
  endpoint: string;
}

interface CachedDocument {
  doc: DsoDocument;
  endpoint: string;
}

/** A provincie as an area: its own code and those of its gemeenten. */
interface ProvincieGebied {
  code: string;
  naam?: string;
  gemeenten: Array<{ code: string; naam?: string }>;
  endpoint: string;
}

// Module-level: tools.ts makes a source per call.
// Today's catalogues apart from those of other days (geldigOp): time travel never pushes today's out.
const catalogueCache = new Map<string, { promise: Promise<Catalogue>; expiresAt: number }>();
const pastCatalogueCache = new Map<string, { promise: Promise<Catalogue>; expiresAt: number }>();
const documentCache = new Map<string, { promise: Promise<CachedDocument>; expiresAt: number }>();
const provincieCache = new Map<string, { promise: Promise<ProvincieGebied>; expiresAt: number }>();
/** ontwerpbesluitIdentificatie → its bekendmaking ("gmb-2026-409335"), null when it has none. */
const bekendmakingIdCache = new Map<string, { value: string | null; expiresAt: number }>();
/** bekendmaking id → the publication's title, null when the SRU has none. */
const bekendmakingTitelCache = new Map<string, { value: string | null; expiresAt: number }>();

/** Forget the catalogues, documents, provincie areas and bekendmakingen (tests). */
export function clearDsoCaches(): void {
  catalogueCache.clear();
  pastCatalogueCache.clear();
  documentCache.clear();
  provincieCache.clear();
  bekendmakingIdCache.clear();
  bekendmakingTitelCache.clear();
}

/**
 * A load kept for ttlMs, least recently used out first. A failed load is not
 * kept, nor one that `keep` refuses (an empty catalogue): the next call tries again.
 */
function cached<T>(
  cache: Map<string, { promise: Promise<T>; expiresAt: number }>,
  key: string,
  ttlMs: number,
  max: number,
  load: () => Promise<T>,
  keep?: (value: T) => boolean,
): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.promise;
  }
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
  while (cache.size >= max) cache.delete(cache.keys().next().value as string);
  const promise = load();
  cache.set(key, { promise, expiresAt: now + ttlMs });
  const forget = () => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  };
  promise.then((value) => {
    if (keep && !keep(value)) forget();
  }, forget);
  return promise;
}

/** A small value kept for ttlMs; the oldest entry goes first when the map is full. */
function remember<T>(cache: Map<string, { value: T; expiresAt: number }>, key: string, value: T, ttlMs: number): T {
  if (cache.size >= BEKENDMAKING_CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function recalled<T>(cache: Map<string, { value: T; expiresAt: number }>, key: string): { value: T } | undefined {
  const hit = cache.get(key);
  return hit && hit.expiresAt > Date.now() ? { value: hit.value } : undefined;
}

/* ------------------------------------------------------------------ */
/*  Source                                                             */
/* ------------------------------------------------------------------ */

/**
 * Largest documentstructuur read (decoded bytes), for that call only; other
 * calls keep the 12 MiB of http.ts. The HDSR waterschapsverordening is 11.9 MB,
 * an ontwerp of it 14.4 MB (about 130 MB peak memory while read and parsed).
 * Parsed, it is kept in documentCache (at most DOCUMENT_CACHE_MAX documents).
 */
const DOCUMENT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Regelingen of which the DSO holds only a pointer, not the text ("De tekst van
 * de Omgevingswet vindt u hier"), with where the text is.
 */
const DSO_PLACEHOLDERS: Record<string, string> = {
  "/akn/nl/act/mnre1034/2020/regOW01": "https://wetten.overheid.nl/BWBR0037885", // Omgevingswet
};
/** A Rijk regeling with a wetten.overheid.nl text and less DSO text than this is such a pointer too. */
const PLACEHOLDER_MAX_CHARS = 1_000;

/**
 * Regelingen the DSO holds for a technical purpose, without rules: the Rijk's
 * "Aansluitdocument" says only "Dit document is tijdelijk ten behoeve van
 * technisch aansluiten op DSO". A short text that says so is one as well.
 */
const DSO_TECHNICAL_DOCUMENTS = new Set(["/akn/nl/act/mnre1034/2021/OOWATRXX1"]);
const TECHNICAL_TEXT = /ten behoeve van technisch aansluiten/i;

/**
 * Tijdelijke delen of a regeling (the voorbeschermingsregels of an omgevingsplan)
 * read at most, and how: small documents, five at a time with a short timeout and
 * one retry, so a DSO that does not answer adds seconds to the call, not a minute.
 */
const MAX_TIJDELIJKE_DELEN = 10;
const TIJDELIJK_DEEL_CONCURRENCY = 5;
const TIJDELIJK_DEEL_TIMEOUT_MS = 8_000;

/** A tijdelijk deel of a regeling: its metadata, its text when asked for, or why it could not be read. */
export interface DsoTijdelijkDeel {
  uriIdentificatie: string;
  item?: DsoSearchItem;
  doc?: DsoDocument;
  error?: string;
}

/**
 * The tijdelijke delen of a parsed document, read once: kept as long as that
 * document is (documentCache), so per day and for at most a quarter of an hour.
 */
const tijdelijkeDelenOf = new WeakMap<DsoDocument, Map<string, { item: Promise<DsoSearchItem>; doc?: Promise<DsoDocument> }>>();

/** The uriIdentificatie in a DSO _links href to a regeling; nothing for a link elsewhere. */
function regelingLinkId(href: unknown): string | undefined {
  if (typeof href !== "string" || !href.startsWith(`${DSO_PRESENTEREN_BASE}/regelingen/`)) return undefined;
  const segment = /^\/regelingen\/([^/?#]+)/.exec(href.slice(DSO_PRESENTEREN_BASE.length))?.[1];
  try {
    return segment ? decodeURIComponent(segment) : undefined;
  } catch {
    return undefined;
  }
}

/** A HAL link is one object or a list of them. */
function linkList(value: unknown): Array<{ href?: unknown }> {
  return (Array.isArray(value) ? value : value ? [value] : []).filter((l): l is { href?: unknown } => typeof l === "object" && l !== null);
}

export class DsoOmgevingsdocumentenSource {
  constructor(
    private readonly config: AppConfig,
    private readonly apiKey?: string,
  ) {}

  hasKey(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim());
  }

  /** A key with characters no header may hold is refused here: fetch's error would quote it. */
  private headers(): Record<string, string> {
    if (dsoApiKeyProblem(this.apiKey)) throw new Error(`DSO_API_KEY ${dsoApiKeyProblem(this.apiKey)}: niet verstuurd.`);
    return { "x-api-key": (this.apiKey as string).trim(), Accept: "application/hal+json" };
  }

  private today(): string {
    return todayIn(this.config.temporal.defaultTimeZone);
  }

  /**
   * Every regeling (or ontwerpregeling) in the DSO: GET /{soort} page by page,
   * the first page and then the rest a few at a time, kept in memory for hours.
   * Searches without a bevoegd gezag or location run on it, so a query sees all
   * of the Netherlands instead of the first page of 20. A catalogue is kept per
   * day: one for another geldigOp is loaded with that date and never mixed with
   * today's, and kept apart, so time travel never pushes today's out. An empty
   * catalogue is never kept: today's is an error, another day's may really be empty.
   */
  catalogue(soort: DsoSoort, geldigOp?: string): Promise<Catalogue> {
    const today = this.today();
    const day = soort === "regelingen" ? (geldigOp ?? today) : today;
    const past = day !== today;
    return cached(
      past ? pastCatalogueCache : catalogueCache,
      `${soort}|${day}`,
      CATALOGUE_TTL_MS,
      past ? PAST_CATALOGUE_MAX : 4,
      () => this.loadCatalogue(soort, soort === "regelingen" ? geldigOp : undefined),
      (catalogue) => catalogue.items.length > 0,
    );
  }

  private async loadCatalogue(soort: DsoSoort, geldigOp?: string): Promise<Catalogue> {
    const url = `${DSO_PRESENTEREN_BASE}/${soort}`;
    // Sorted on identificatie: a registration during the paging must not shift the pages.
    // An ontwerpregeling shares it with the other ontwerpen of its regeling: the registration time tells them apart.
    const query = {
      size: String(DSO_PAGE_SIZE),
      _sort: soort === "ontwerpregelingen" ? "identificatie,registratietijdstip" : "identificatie",
      ...(geldigOp ? tijdreis(geldigOp) : {}),
    };
    const fetchPage = (page: number) =>
      getJson<ListResponse>(url, { query: { ...query, page: String(page) }, headers: this.headers(), connector: CONNECTOR, disableCache: true, timeoutMs: 20_000 });
    const first = await fetchPage(1);
    const total = first.data.page?.totalElements ?? listItems(first.data, soort).length;
    const pages = Math.min(MAX_CATALOGUE_PAGES, first.data.page?.totalPages ?? Math.ceil(total / DSO_PAGE_SIZE));
    const rest = await mapLimit(
      Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2),
      CATALOGUE_CONCURRENCY,
      fetchPage,
    );
    const items = dedupe([first, ...rest].flatMap((r) => listItems(r.data, soort)), soort).map(({ _links, ...item }) => item);
    // Today the DSO holds thousands: an empty answer is a fault, not "no such bevoegd gezag".
    if (!items.length && !geldigOp) {
      throw new SourceRequestError({ message: `Het DSO gaf een lege catalogus (${soort}).`, endpoint: first.meta.url, code: "malformed_response" });
    }
    return { items, total, endpoint: first.meta.url };
  }

  /** Locatieserver hits for a query, inside the Netherlands only. */
  private async locatieDocs(q: string, fq?: string): Promise<{ docs: LocatieDoc[]; endpoint: string }> {
    const { data, meta } = await getJson<{ response?: { docs?: LocatieDoc[] } }>(LOCATIESERVER_FREE, {
      query: { q, rows: "10", fl: LOCATIE_FIELDS, ...(fq ? { fq } : {}) },
      connector: LOCATIE_CONNECTOR,
      timeoutMs: 10_000,
      retries: 1,
    });
    const docs = (data.response?.docs ?? [])
      .filter((d) => {
        const rd = parseRdPoint(d.centroide_rd);
        return rd && rd[0] >= RD_EXTENT.minX && rd[0] <= RD_EXTENT.maxX && rd[1] >= RD_EXTENT.minY && rd[1] <= RD_EXTENT.maxY;
      })
      .map(completeLocatieDoc);
    return { docs, endpoint: meta.url };
  }

  /**
   * An address, postcode or place as an RD point, via the PDOK Locatieserver,
   * whose fuzzy search always answers something ("Utrecht Centraal" gives a bus
   * station in Breda first). So: ten hits; when the input names a gemeente or
   * woonplaats (also as "Den Haag" for 's-Gravenhage) only hits there count,
   * and the rest of the input must resemble the hit; with a house number the
   * address itself, not the street. Without a place, a name that fits places in
   * several gemeenten equally well ("Lunetten") is an error naming them.
   */
  async geocode(locatie: string): Promise<{ invoer: string; weergavenaam: string; type?: string; rd: RdPoint; endpoint: string; note?: string }> {
    const invoer = locatie.trim();
    const notFound = (endpoint: string, message = `Locatie '${invoer}' niet gevonden via de PDOK Locatieserver.`) =>
      new DsoInputError(
        message,
        "Geef een adres in Nederland ('Brennerbaan 150, Utrecht'), een postcode, met of zonder huisnummer ('3524 BN 150'), of een plaats ('Lunetten, Utrecht'). Voor alle documenten van een gemeente: bevoegdGezag; van een provincie en haar gemeenten: provincie.",
        { endpoint },
      );
    if (invoer.length > DSO_MAX_INPUT_CHARS) throw notFound(LOCATIESERVER_FREE, `Locatie is langer dan ${DSO_MAX_INPUT_CHARS} tekens.`);
    const q = locatieQuery(invoer);
    const parts = locatieParts(q);
    const { docs, endpoint } = await this.locatieDocs(q);
    const done = (doc: LocatieDoc, note?: string) => ({
      invoer,
      weergavenaam: doc.weergavenaam ?? invoer,
      type: doc.type,
      rd: parseRdPoint(doc.centroide_rd) as RdPoint,
      endpoint,
      note,
    });

    /**
     * Within a place the input names: the best hit there, asked again within the
     * place when the first hits lack the address; else the place's centre, said
     * so, for a spot without an address ("Utrecht Centraal"). `listed`: the
     * Locatieserver put the place among its first hits; when it did not
     * ("Utrecht Centraal Station" gives Amsterdam's metro station), finding
     * nothing there is an error, never another place.
     */
    const withinPlace = async (place: NamedPlace, listed: boolean) => {
      const words = contentWords(place.rest);
      let best = pickLocatie(docs.filter((d) => inPlace(d, place)), words, parts);
      if (words.length && (!best || (parts.huisnummer !== undefined && best.rank >= 2))) {
        const nummer = parts.huisnummer !== undefined ? `${parts.huisnummer}${parts.toevoeging ?? ""}` : "";
        const restQ = [ordinalWord(parts), ...place.rest, nummer, parts.postcode ?? ""].filter(Boolean).join(" ");
        const within = await this.locatieDocs(restQ, `${place.field}:"${place.naam.replace(/"/g, "")}"`);
        const there = pickLocatie(within.docs.filter((d) => inPlace(d, place)), words, parts);
        if (there && (!best || there.rank < best.rank)) best = there;
      }
      if (best) {
        // "Kerkstraat 1, Utrecht" is in De Meern, a woonplaats of the gemeente Utrecht.
        const woonplaats = best.doc.woonplaatsnaam;
        const elders = place.field === "gemeentenaam" && woonplaats && !place.keys.has(placeKey(woonplaats)) ? `Ligt in de woonplaats ${woonplaats} (gemeente ${place.naam}).` : undefined;
        return done(best.doc, [best.note, elders].filter(Boolean).join(" ") || undefined);
      }
      if (parts.huisnummer !== undefined) throw notFound(endpoint, `Adres '${invoer}' niet gevonden in ${place.naam} (PDOK Locatieserver).`);
      // A postcode decides on its own ("2511 BT Den Haag"); the place adds nothing to it.
      if (parts.postcode) return undefined;
      if (!listed) throw notFound(endpoint, `Locatie '${invoer}' niet gevonden in ${place.naam} (PDOK Locatieserver).`);
      const centre = docs.find((d) => d.type === "woonplaats" && inPlace(d, place)) ?? docs.find((d) => d.type === "gemeente" && inPlace(d, place));
      if (!centre) throw notFound(endpoint);
      return done(centre, `'${place.rest.join(" ")}' niet gevonden in ${place.naam}; gebruikt: het middelpunt van ${centre.weergavenaam}.`);
    };

    // A house number after nothing but a place name belongs to a street ("Spui 70"
    // is no address in the village Spui). With a postcode the place name still
    // counts, in any of its names ("Spui 70, 2511 BT Den Haag" is in 's-Gravenhage).
    const named = namedPlace(parts.key, docs);
    const place = named && (parts.huisnummer === undefined || contentWords(named.rest).length) ? named : undefined;
    if (place) {
      const found = await withinPlace(place, true);
      if (found) return found;
    }

    const words = contentWords(parts.key.split(" "));
    const picked = pickLocatie(docs, words, parts);
    if (!picked) throw notFound(endpoint);
    // A word of the input the hit lacks may be a place the first hits never
    // reached ("Utrecht Centraal Station", "Station Rotterdam Centraal"): look it
    // up among the gemeenten and woonplaatsen, and search within it instead.
    if (!parts.postcode && !place) {
      const hit = nameKey(picked.doc.weergavenaam ?? "").split(" ");
      const missed = words.filter((w) => !hit.some((f) => f.startsWith(w.slice(0, 4))));
      if (missed.length) {
        const places = await this.locatieDocs(missed.join(" "), "type:(gemeente OR woonplaats)");
        const other = namedPlace(parts.key, places.docs, parts.huisnummer === undefined);
        const covers = other && [...other.keys].some((k) => k.split(" ").some((w) => missed.includes(w)));
        if (other && covers && !inPlace(picked.doc, other) && (parts.huisnummer === undefined || contentWords(other.rest).length)) {
          const found = await withinPlace(other, false);
          if (found) return found;
        }
      }
    }
    // No place given, and the same kind of hit in other gemeenten about as good: ask which one.
    const score = picked.doc.score ?? 0;
    const elsewhere = parts.postcode || picked.doc.score === undefined
      ? []
      : docs.filter(
          (d) =>
            d.gemeentenaam !== picked.doc.gemeentenaam &&
            d.type === picked.doc.type &&
            (d.score ?? 0) >= score * 0.95 &&
            resembles(words, d) &&
            (!parts.ordinal || hasOrdinal(d, parts.ordinal)) &&
            (d.type !== "adres" || isAddress(d, parts)),
        );
    if (elsewhere.length) {
      const options = [...new Map([picked.doc, ...elsewhere].map((d) => [d.gemeentenaam, d.weergavenaam])).values()].slice(0, 6);
      throw new DsoInputError(
        `Locatie '${invoer}' is niet eenduidig: ${options.join("; ")}.`,
        `Voeg de plaats toe, bijv. '${invoer}, ${elsewhere[0].woonplaatsnaam ?? elsewhere[0].gemeentenaam}', of geef een postcode.`,
        { endpoint, suggestions: options },
      );
    }
    return done(picked.doc, picked.note);
  }

  /**
   * The bekendmaking of an ontwerpbesluit: identifier.overheid.nl redirects its
   * AKN identifier to the publication ("…/gmb-2026-409335.html"). One request
   * that does not follow the redirect; kept a day. null: it leads elsewhere;
   * undefined: no answer now (asked again next time).
   */
  private async bekendmakingId(ontwerpbesluit: string): Promise<string | null | undefined> {
    const hit = recalled(bekendmakingIdCache, ontwerpbesluit);
    if (hit) return hit.value;
    const url = `${IDENTIFIER_BASE}${ontwerpbesluit}`;
    const started = Date.now();
    try {
      const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(BEKENDMAKING_TIMEOUT_MS) });
      await response.body?.cancel().catch(() => undefined);
      logger.info({ method: "HEAD", url, connector: BEKENDMAKING_CONNECTOR, status: response.status, elapsedMs: Date.now() - started }, "source_request");
      if (response.status >= 500 || response.status === 429) return undefined;
      const location = response.headers.get("location") ?? "";
      const id = /^https:\/\/zoek\.officielebekendmakingen\.nl\/([a-z]+-\d{4}-\d+)(?:\.html)?$/i.exec(location)?.[1]?.toLowerCase() ?? null;
      return remember(bekendmakingIdCache, ontwerpbesluit, id, id ? BEKENDMAKING_TTL_MS : 60 * 60 * 1000);
    } catch (error) {
      logger.info({ method: "HEAD", url, connector: BEKENDMAKING_CONNECTOR, ok: false, reason: (error as { name?: string })?.name, elapsedMs: Date.now() - started }, "source_request");
      return undefined;
    }
  }

  /** A publication's title, from the SRU of officielebekendmakingen.nl: one short request, kept a day. */
  private async bekendmakingTitel(id: string): Promise<string | null | undefined> {
    const hit = recalled(bekendmakingTitelCache, id);
    if (hit) return hit.value;
    try {
      const { data } = await getText(this.config.endpoints.bekendmakingenSru, {
        query: { operation: "searchRetrieve", version: "2.0", query: `dt.identifier=="${id}"`, maximumRecords: 1, startRecord: 1, recordSchema: "gzd" },
        connector: BEKENDMAKING_CONNECTOR,
        timeoutMs: BEKENDMAKING_TIMEOUT_MS,
        retries: 0,
      });
      const record = extractSruRecords(parseXml(data))[0] as { originalData?: { meta?: { owmskern?: { title?: unknown } } } } | undefined;
      const title = record?.originalData?.meta?.owmskern?.title;
      return remember(bekendmakingTitelCache, id, typeof title === "string" && title.trim() ? title.replace(/\s+/g, " ").trim() : null, BEKENDMAKING_TTL_MS);
    } catch {
      return undefined;
    }
  }

  /**
   * For the ontwerpen shown (at most MAX_BEKENDMAKING_LOOKUPS): the
   * bekendmaking of each, and for an omgevingsplan whose title names no subject
   * ("Omgevingsplan gemeente Soest") the title of that publication, which does.
   * Best effort within BEKENDMAKING_BUDGET_MS: what is not found in time is
   * left out, and an omgevingsplan's subject is then unknown (onderwerp null).
   */
  private async addBekendmakingen(items: DsoSearchItem[]): Promise<void> {
    const ontwerpen = items
      .filter((x) => x.soort === "ontwerpregeling" && /^\/akn\/nl\/bill\/[\w.@;:-]+(?:\/[\w.@;:-]+)*$/.test(x.ontwerpbesluitIdentificatie ?? ""))
      .slice(0, MAX_BEKENDMAKING_LOOKUPS);
    if (!ontwerpen.length) return;
    const unnamed = new Set(ontwerpen.filter((x) => genericTitle(x) && (x.documentType ?? "").toLowerCase() === "omgevingsplan"));
    const found = new Map<DsoSearchItem, Partial<DsoSearchItem>>();
    const work = mapLimit(ontwerpen, 8, async (x) => {
      const id = await this.bekendmakingId(x.ontwerpbesluitIdentificatie as string);
      if (!id) return;
      const link = { bekendmakingId: id, bekendmakingUrl: `${ZOEK_BEKENDMAKINGEN_BASE}/${id}.html` };
      found.set(x, link);
      if (!unnamed.has(x)) return;
      const titel = await this.bekendmakingTitel(id);
      if (titel && addsToTitle(x.title, titel)) found.set(x, { ...link, onderwerp: titel, title: `${x.title} — ${subjectOf(x, titel)}` });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, BEKENDMAKING_BUDGET_MS);
    });
    await Promise.race([work.catch(() => undefined), budget]);
    clearTimeout(timer);
    // What has come in so far; a lookup that ends later changes nothing.
    for (const x of ontwerpen) Object.assign(x, unnamed.has(x) ? { onderwerp: null } : {}, found.get(x));
  }

  /**
   * A provincie as an area: its code (from the DSO's own names, or as given)
   * and the codes of the gemeenten in it, from the PDOK Locatieserver, kept for hours.
   */
  private async provincieGebied(input: string): Promise<ProvincieGebied> {
    let code: string;
    let naam: string | undefined;
    if (/^pv\d+$/i.test(input)) {
      code = input.toLowerCase();
    } else {
      const catalogue = await this.catalogue("regelingen");
      let entry: BevoegdGezagEntry;
      try {
        entry = resolveBevoegdGezagName(/^provincie\s/i.test(input) ? input : `provincie ${input}`, bevoegdGezagEntries(catalogue.items)).entry;
      } catch (e) {
        if (!(e instanceof DsoInputError)) throw e;
        throw new DsoInputError(`Provincie '${input}' niet gevonden.`, `${e.details?.suggestions && (e.details.suggestions as string[]).length ? `Bedoelde u: ${(e.details.suggestions as string[]).join(", ")}? ` : ""}Geef een van de twaalf provincies als naam ('Utrecht', 'Fryslân') of code (pv20 tot en met pv31).`);
      }
      code = entry.code;
      naam = entry.naam;
    }
    const gebied = await cached(provincieCache, code, CATALOGUE_TTL_MS, 12, async () => {
      const { data, meta } = await getJson<{ response?: { docs?: Array<{ gemeentecode?: string; gemeentenaam?: string; provincienaam?: string }> } }>(LOCATIESERVER_FREE, {
        query: { q: "*", fq: `type:gemeente AND provinciecode:${code.toUpperCase()}`, rows: "100", fl: "gemeentecode,gemeentenaam,provinciecode,provincienaam" },
        connector: LOCATIE_CONNECTOR,
        timeoutMs: 10_000,
        retries: 1,
      });
      const docs = data.response?.docs ?? [];
      const gemeenten = [...new Map(docs.filter((d) => /^\d{4}$/.test(d.gemeentecode ?? "")).map((d) => [`gm${d.gemeentecode}`, { code: `gm${d.gemeentecode}`, naam: d.gemeentenaam }])).values()];
      if (!gemeenten.length) {
        throw new DsoInputError(`Geen gemeenten gevonden in provincie ${code} (PDOK Locatieserver).`, "Geef een provincie als naam ('Utrecht', 'Fryslân') of code (pv20 tot en met pv31).", { endpoint: meta.url });
      }
      return { code, naam: docs[0]?.provincienaam ? `provincie ${docs[0].provincienaam}` : undefined, gemeenten, endpoint: meta.url };
    });
    return { ...gebied, naam: naam ?? gebied.naam };
  }

  /** POST /{soort}/_zoek, all pages when `full` (bounded), otherwise the first. */
  private async zoek(soort: DsoSoort, body: Record<string, unknown>, options: { geometry: boolean; geldigOp?: string; full: boolean }) {
    const url = `${DSO_PRESENTEREN_BASE}/${soort}/_zoek`;
    const query = {
      size: String(DSO_PAGE_SIZE),
      // Newest first, so a first page that is not the whole list holds the latest documents;
      // identificatie breaks the many ties (one date for hundreds of Rijk regelingen), so pages neither overlap nor skip.
      _sort: soort === "ontwerpregelingen" ? "-registratietijdstip,identificatie" : "-geldigVanaf,identificatie",
      ...(options.geldigOp ? tijdreis(options.geldigOp) : {}),
    };
    const headers = { ...this.headers(), ...(options.geometry ? { "Content-Crs": RD_CRS } : {}) };
    const fetchPage = (page: number) => postJson<ListResponse>(url, body, { query: { ...query, page: String(page) }, headers, connector: CONNECTOR });
    const first = await fetchPage(1);
    const total = first.data.page?.totalElements ?? listItems(first.data, soort).length;
    const pages = Math.ceil(total / DSO_PAGE_SIZE);
    const wanted = options.full ? Math.min(pages, MAX_ZOEK_PAGES) : 1;
    const rest = await mapLimit(Array.from({ length: Math.max(0, wanted - 1) }, (_, i) => i + 2), CATALOGUE_CONCURRENCY, fetchPage);
    const items = dedupe([first, ...rest].flatMap((r) => listItems(r.data, soort)), soort);
    return { items, total, endpoint: first.meta.url, complete: wanted >= pages, query };
  }

  async search(args: DsoSearchArgs): Promise<DsoSearchResult> {
    if (!this.hasKey()) {
      throw new Error("DSO_API_KEY is required for dso_omgevingsdocumenten_search");
    }
    for (const [name, value] of [["bevoegdGezag", args.bevoegdGezag], ["provincie", args.provincie], ["query", args.query], ["locatie", args.locatie]] as const) {
      if (value && value.length > DSO_MAX_INPUT_CHARS) {
        throw new DsoInputError(`${name} is langer dan ${DSO_MAX_INPUT_CHARS} tekens.`, "Geef een naam, een paar zoekwoorden of één adres.");
      }
    }
    const bgInput = args.bevoegdGezag?.trim();
    const pvInput = args.provincie?.trim();
    if (pvInput && (bgInput || args.locatie?.trim())) {
      throw new DsoInputError(
        "provincie gaat niet samen met bevoegdGezag of locatie.",
        "Geef provincie (een gebied: de provincie en al haar gemeenten), bevoegdGezag (één instantie, alleen haar eigen documenten) of locatie (één punt).",
      );
    }

    // Only an ontwerp has an inzagetermijn: alleen_ter_inzage searches the ontwerpregelingen.
    const soort: DsoSoort = args.alleenTerInzage ? "ontwerpregelingen" : (args.soort ?? "regelingen");
    const ontwerp = soort === "ontwerpregelingen";
    const today = args.today ?? this.today();
    const geldigOp = ontwerp ? undefined : args.geldigOp;
    const query = args.query?.trim() || undefined;
    const rows = Math.min(Math.max(args.rows ?? (args.locatie?.trim() ? DEFAULT_ROWS_LOCATIE : DEFAULT_ROWS), 1), this.config.limits.maxRows);
    const notes: string[] = [];
    const params: Record<string, string> = {
      ...(ontwerp ? { soort } : {}),
      ...(query ? { q: query } : {}),
      ...(args.documentType ? { documentType: args.documentType } : {}),
      ...(args.typeBevoegdGezag ? { typeBevoegdGezag: args.typeBevoegdGezag } : {}),
      ...(args.alleenTerInzage ? { alleen_ter_inzage: "true" } : {}),
      ...(geldigOp ? tijdreis(geldigOp) : {}),
    };
    if (ontwerp && args.geldigOp) notes.push("geldigOp geldt niet voor ontwerpregelingen en is niet toegepast.");
    if (geldigOp) {
      notes.push(
        `Tijdreis: de versies die op ${geldigOp} geldig en in werking waren (geldigOp en inWerkingOp ${geldigOp}). ` +
          "Versies tussen die dag en vandaag zie je niet: een hoger versienummer nu kan meerdere wijzigingen omvatten. Tel bij een vergelijking documenten, geen opsommingen.",
      );
    }

    // A code goes as is (one request, the frontend's map panel); a name is
    // resolved against the catalogue, so the code it gives exists in the DSO.
    let bevoegdGezag: DsoSearchResult["bevoegdGezag"];
    if (bgInput) {
      if (BEVOEGD_GEZAG_CODE.test(bgInput)) {
        bevoegdGezag = { code: bgInput.toLowerCase() };
      } else {
        const catalogue = await this.catalogue("regelingen");
        const resolved = resolveBevoegdGezagName(bgInput, bevoegdGezagEntries(catalogue.items), args.typeBevoegdGezag, args.documentType);
        bevoegdGezag = { code: resolved.entry.code, naam: resolved.entry.naam };
        const others = resolved.alternatives.slice(0, 4).map(describe);
        notes.push(
          `Bevoegd gezag '${bgInput}' opgevat als ${describe(resolved.entry)}` +
            (resolved.byDocumentType ? ` (een ${args.documentType} stelt een ${resolved.entry.layer} vast)` : "") +
            (others.length ? `; ook mogelijk: ${others.join(", ")} (geef die naam of code, of typeBevoegdGezag, op).` : "."),
        );
      }
      params.bevoegdGezag = bevoegdGezag.code;
      // bevoegdGezag is who adopted a document, not an area: a provincie's own documents only.
      if (layerOfCode(bevoegdGezag.code) === "provincie") {
        notes.push(
          (args.documentType === "omgevingsplan" ? "Een provincie stelt geen omgevingsplan vast. " : "") +
            `bevoegdGezag ${bevoegdGezag.naam ?? bevoegdGezag.code}: alleen de documenten die de provincie zelf vaststelt, niet die van de gemeenten en waterschappen in de provincie. Voor de provincie met al haar gemeenten: provincie '${bevoegdGezag.code}'.`,
        );
      }
    }

    // An area: the provincie's own code and those of its gemeenten, in one _zoek.
    let provincie: DsoSearchResult["provincie"];
    let areaCodes: string[] | undefined;
    if (pvInput) {
      const gebied = await this.provincieGebied(pvInput);
      provincie = { code: gebied.code, naam: gebied.naam, gemeenten: gebied.gemeenten.length };
      areaCodes = [gebied.code, ...gebied.gemeenten.map((g) => g.code)];
      params.provincie = gebied.code;
      notes.push(
        `Gebied ${gebied.naam ?? gebied.code} (${gebied.code}): de documenten van de provincie zelf en van haar ${gebied.gemeenten.length} gemeenten (gemeenten volgens de PDOK Locatieserver). ` +
          "Waterschappen en het Rijk vallen erbuiten; bevoegdGezag van elk document blijft de instantie die het vaststelde.",
      );
    }

    let locatie: DsoSearchResult["locatie"];
    if (args.locatie?.trim()) {
      const geo = await this.geocode(args.locatie.trim());
      locatie = { invoer: geo.invoer, weergavenaam: geo.weergavenaam, type: geo.type, rd: geo.rd };
      params.locatie = geo.invoer;
      params.rd = `${geo.rd[0]},${geo.rd[1]}`;
      const point = geo.type && !["adres", "postcode"].includes(geo.type)
        ? ` Een ${geo.type} is één punt (het middelpunt); voor alle documenten van een gemeente: bevoegdGezag.`
        : "";
      notes.push(
        `Locatie '${geo.invoer}' gevonden als ${geo.weergavenaam} (${geo.type ?? "?"}, RD ${geo.rd[0]}, ${geo.rd[1]}; PDOK Locatieserver).${geo.note ? ` ${geo.note}` : ""} ` +
          `Getoond: de documenten waarvan het werkingsgebied dat punt bevat, van gemeente, waterschap, provincie en Rijk. Dit is documentniveau: of een afzonderlijk artikel op dat punt geldt (het kan een kleiner werkingsgebied hebben), is niet gecontroleerd.${point}`,
      );
    }

    const filtered = Boolean(query || args.documentType || args.alleenTerInzage);
    let source: RegelingItem[];
    let endpoint: string;
    let scope: DsoSearchResult["scope"];
    let unfilteredTotal: number;
    let complete = true;

    if (locatie || bevoegdGezag || areaCodes) {
      const body: Record<string, unknown> = {
        ...(locatie ? { geometrie: { type: "Point", coordinates: locatie.rd } } : {}),
        ...(areaCodes ? { bevoegdGezag: areaCodes } : bevoegdGezag ? { bevoegdGezag: [bevoegdGezag.code] } : {}),
        ...(args.typeBevoegdGezag ? { typeBevoegdGezag: [args.typeBevoegdGezag] } : {}),
      };
      // Every page only when a filter, the layer order or an area needs them all;
      // the plain bevoegd-gezag list stays one request.
      const out = await this.zoek(soort, body, { geometry: Boolean(locatie), geldigOp, full: filtered || Boolean(locatie) || Boolean(areaCodes) });
      source = out.items;
      endpoint = out.endpoint;
      scope = locatie ? "locatie" : areaCodes ? "provincie" : "bevoegd_gezag";
      unfilteredTotal = out.total;
      complete = out.complete;
      Object.assign(params, { size: out.query.size, _sort: out.query._sort });
    } else if (filtered || args.typeBevoegdGezag) {
      const catalogue = await this.catalogue(soort, geldigOp);
      source = catalogue.items;
      endpoint = catalogue.endpoint;
      scope = "catalogus";
      unfilteredTotal = catalogue.total;
      notes.push(`Doorzocht: de volledige DSO-catalogus (${catalogue.total} ${soort}, ${catalogue.items.length} opgehaald).`);
    } else {
      const url = `${DSO_PRESENTEREN_BASE}/${soort}`;
      const listQuery = {
        size: String(rows),
        page: "1",
        _sort: ontwerp ? "-registratietijdstip,identificatie" : "-geldigVanaf,identificatie",
        ...(geldigOp ? tijdreis(geldigOp) : {}),
      };
      const { data, meta } = await getJson<ListResponse>(url, { query: listQuery, headers: this.headers(), connector: CONNECTOR });
      source = dedupe(listItems(data, soort), soort);
      endpoint = meta.url;
      scope = "lijst";
      unfilteredTotal = data.page?.totalElements ?? source.length;
      Object.assign(params, listQuery);
      notes.push(
        ontwerp
          ? `Zonder zoekfilter: de ${source.length} laatst geregistreerde van ${unfilteredTotal} ontwerpregelingen.`
          : `Zonder zoekfilter: de ${source.length} van ${unfilteredTotal} regelingen met de meest recente nieuwe versie (beginGeldigheid).`,
      );
      notes.push("Zoek met locatie, bevoegdGezag, provincie, query of documentType.");
    }

    let matched = source.filter(
      (x) =>
        matchesDocumentType(x, args.documentType) &&
        (!args.typeBevoegdGezag || scope !== "catalogus" || layerOfItem(x) === args.typeBevoegdGezag),
    );
    if (query) {
      const words = queryWords(query);
      const whole = matched.filter((x) => matchesWholeWords(x, words));
      if (whole.length) {
        matched = whole;
      } else {
        matched = matched.filter((x) => matchesPartialWords(x, words));
        if (matched.length) notes.push(`Geen documenten met de hele woorden '${words.join(" ")}'; getoond: documenten waarin ze als deel van een woord staan.`);
      }
    }

    const byLayer = scope === "locatie";
    let items = sortItems(matched.map((x) => normalize(x, today)), byLayer);
    const since = daysBefore(today, TER_INZAGE_DAYS);
    if (args.alleenTerInzage) {
      // Confirmed first; then those whose termijn only the bekendmaking holds.
      const open = items.filter((x) => x.terInzage === true);
      const possibly = items.filter((x) => x.terInzage === null && x.mogelijkTerInzage);
      items = [...open, ...possibly];
      notes.push(
        `Ter inzage: ${open.length} met een inzagetermijn in het DSO die vandaag (${today}) omvat` +
          (possibly.length
            ? `; daarna ${possibly.length} mogelijk ter inzage (mogelijkTerInzage): zonder inzagetermijn in het DSO en bekendgemaakt sinds ${since}. Controleer hun termijn in de bekendmaking (bekendmakingId; dagenSindsBekendmaking telt de dagen sinds bekendOp, zes weken zijn 42 dagen).`
            : `. Geen ontwerpen zonder inzagetermijn in het DSO die sinds ${since} zijn bekendgemaakt.`),
      );
    }
    const terInzageAantal = ontwerp
      ? { bevestigd: items.filter((x) => x.terInzage === true).length, mogelijk: items.filter((x) => x.terInzage === null && x.mogelijkTerInzage).length }
      : undefined;

    // Unfiltered, the DSO's own count; filtered (or the catalogue), the matches found.
    const total = !filtered && scope !== "catalogus" ? unfilteredTotal : items.length;
    if (scope === "bevoegd_gezag" || scope === "locatie" || scope === "provincie") {
      if (!complete) {
        notes.push(`Het DSO heeft ${unfilteredTotal} ${soort} voor deze zoekvraag; ${filtered || scope !== "bevoegd_gezag" ? `alleen de nieuwste ${MAX_ZOEK_PAGES * DSO_PAGE_SIZE} zijn doorzocht` : `de nieuwste ${source.length} opgehaald`}.`);
      } else if (filtered) {
        notes.push(`${items.length} van de ${unfilteredTotal} ${soort} van deze zoekvraag voldoen aan het filter.`);
      }
    }
    // documentType 'omgevingsplan' leaves out the voorbeschermingsregels a voorbereidingsbesluit
    // adds to the plan for a while: named from the same, unfiltered answer.
    if (args.documentType === "omgevingsplan" && !ontwerp && (scope === "locatie" || scope === "provincie" || (scope === "bevoegd_gezag" && layerOfCode(bevoegdGezag?.code) === "gemeente"))) {
      notes.push(voorbeschermingNote(source.filter(isPlanVoorbescherming), complete));
    }
    if (bevoegdGezag && layerOfCode(bevoegdGezag.code) === "waterschap") {
      notes.push("De keur van een waterschap is met de Omgevingswet (1 januari 2024) opgegaan in zijn waterschapsverordening.");
    }

    let perBestuurslaag: DsoSearchResult["perBestuurslaag"];
    if (scope === "locatie" && items.length) {
      perBestuurslaag = layerCounts(items);
      const nonRule = items.filter((x) => x.alleenVerwijzing || x.technisch);
      notes.push(
        `Op dit punt ${items.length} ${items.length === 1 ? "document" : "documenten"}: ${perBestuurslaag.map((l) => `${l.laag} ${l.aantal}`).join(", ")}.` +
          (nonRule.length
            ? ` Daarvan ${nonRule.length === 1 ? "is" : "zijn"} ${nonRule.map((x) => `'${x.title}' (${x.alleenVerwijzing ? "alleen een verwijzing naar de wet" : "technisch aansluitdocument"})`).join(" en ")} ${nonRule.length === 1 ? "geen regelgevend document" : "geen regelgevende documenten"} (zie opmerking).`
            : ""),
      );
      if (items.some((x) => /^(?:omgevingsvisie|programma)$/i.test(x.documentType ?? ""))) {
        notes.push("Omgevingsvisies en programma's binden alleen het bestuursorgaan dat ze vaststelde; burgers en bedrijven binden het omgevingsplan, de omgevings- en waterschapsverordening, voorbeschermingsregels, projectbesluiten en de AMvB's en regelingen van het Rijk.");
      }
      if (!args.documentType || args.documentType === "omgevingsplan") {
        const [x, y] = (locatie as NonNullable<typeof locatie>).rd.map((c) => Math.round(c));
        notes.push(
          "Niet in deze lijst: bestemmingsplannen en andere ruimtelijke plannen van vóór 2024 (IMRO), die als tijdelijk deel van het omgevingsplan hier ook kunnen gelden. " +
            `Zoek ze met ruimtelijke_plannen_search (bbox '${x - 5},${y - 5},${x + 5},${y + 5}') of bekijk ze in Regels op de kaart.`,
        );
      }
    }

    const shown = items.slice(0, rows);
    if (ontwerp) await this.addBekendmakingen(shown);
    if (ontwerp) {
      notes.push(
        "Eén record per ontwerpbesluit (een regeling kan meerdere ontwerpen hebben; de titel noemt het besluit als dat meer zegt). " +
          `terInzage: vandaag (${today}) valt binnen de inzagetermijn; null als het DSO geen inzagetermijn heeft (inzagetermijnBekend false, bij ongeveer een derde van de recente ontwerpen): die staat dan alleen in de bekendmaking. ` +
          "De inzagetermijn is zoals het bevoegd gezag hem in het DSO aanleverde en kan afwijken van de kennisgeving (bijv. een dag later als hij op een zondag eindigt). " +
          "Leidend voor de precieze termijn en voor hoe en bij wie je kunt reageren is de bekendmaking: officiele_bekendmakingen_record_get met bekendmakingId (de kennisgeving is vaak een aparte publicatie; zoek die met officiele_bekendmakingen_search). " +
          "Het DSO bevat alleen ontwerpen die als ontwerpbesluit (STOP) zijn aangeleverd; een ontwerp dat alleen met een kennisgeving is bekendgemaakt, ontbreekt. Link voor de gebruiker: bekendmakingUrl of canonical_url.",
      );
      if (shown.some((x) => x.eindeInzagetermijnSchatting)) {
        notes.push("eindeInzagetermijnSchatting (zonder termijn in het DSO): bekendOp plus zes weken (afdeling 3.4 Awb), een schatting; de echte termijn begint vaak enkele dagen later.");
      }
      if (shown.some((x) => x.inzagetermijnOpvallendKort)) {
        notes.push("inzagetermijnOpvallendKort: de termijn in het DSO is korter dan vier weken, meestal een kennisgeving achteraf; de werkelijke termijn staat in de bekendmaking.");
      }
      if (shown.some((x) => x.onderwerp !== undefined)) {
        notes.push("onderwerp: de titel van de bekendmaking, waar de DSO-titel alleen het omgevingsplan noemt; null als die niet te vinden was (het onderwerp staat dan in de bekendmaking).");
      }
    }
    if (items.length > rows) notes.push(cutNote(items, rows, this.config.limits.maxRows));
    if (shown.some((x) => x.eindGeldigheid)) {
      notes.push(
        `beginGeldigheid en eindGeldigheid horen bij de getoonde versie (${geldigOp ? `die van ${geldigOp}` : "de huidige"}). eindGeldigheid is exclusief: op die dag geldt al de volgende versie, deze geldt tot en met de dag ervoor (versieGeldigTotEnMet). Het is niet het einde van de regeling.`,
      );
    }
    if (shown.some((x) => (x.versie ?? 0) > 1)) {
      notes.push("versie is het volgnummer van de registratie in het DSO, niet het versienummer op lokaleregelgeving.overheid.nl of wetten.overheid.nl; de versiedata van de Rijksregels in het DSO vallen niet altijd samen met die op wetten.overheid.nl.");
    }
    notes.push("Bron: DSO Omgevingsdocumenten Presenteren API v8. De regeltekst: dso_omgevingsdocument_tekst met identificatie (ontwerp: technischId).");

    return {
      items: shown,
      total,
      endpoint,
      query: params,
      access_note: notes.join(" "),
      scope,
      bevoegdGezag,
      provincie,
      locatie,
      ...(perBestuurslaag ? { perBestuurslaag } : {}),
      ...(terInzageAantal ? { terInzageAantal } : {}),
    };
  }

  /**
   * The regeltekst of one document: its documentstructuur turned into sections
   * (see dso-regeltekst.ts), with the document's metadata for title and link.
   * Parsed documents are kept a quarter of an hour: a zoekterm and a follow-up
   * onderdeel on the same omgevingsplan fetch it once.
   *
   * A regeling's tijdelijke delen (_links.tijdelijkDelen: the voorbeschermingsregels
   * that are part of an omgevingsplan) come along when asked: their metadata
   * ("lijst"), or with their text as well ("tekst", for a zoekterm). A tijdelijk
   * deel read on its own names the regeling it belongs to (tijdelijkDeelVan).
   */
  async documentText(args: { identificatie: string; geldigOp?: string; weergave?: "nieuw" | "wijzigingen"; tijdelijkeDelen?: "lijst" | "tekst" }): Promise<{
    doc: DsoDocument;
    item?: DsoSearchItem;
    kind: "regeling" | "ontwerpregeling";
    pathId: string;
    endpoint: string;
    access_note?: string;
    /** The DSO holds only a pointer for this regeling; its text is at url. */
    placeholder?: { url: string };
    /** A technical record without rules (the Aansluitdocument Rijk). */
    technisch?: boolean;
    /** Its tijdelijke delen (at most MAX_TIJDELIJKE_DELEN), when asked for, and how many it has. */
    tijdelijkeDelen?: DsoTijdelijkDeel[];
    tijdelijkeDelenTotaal?: number;
    /** It is itself a tijdelijk deel of this regeling. */
    tijdelijkDeelVan?: { uriIdentificatie: string; item?: DsoSearchItem };
  }> {
    if (!this.hasKey()) {
      throw new Error("DSO_API_KEY is required for dso_omgevingsdocument_tekst");
    }
    const unknownId = () =>
      new DsoInputError(
        `Onbekende identificatie '${args.identificatie.slice(0, 120)}'.`,
        "Gebruik identificatie ('/akn/nl/act/gm0344/2020/omgevingsplan'), uriIdentificatie ('_akn_nl_act_gm0344_2020_omgevingsplan') of, voor een ontwerp, technischId uit dso_omgevingsdocumenten_search.",
      );
    let parsed: DsoIdentificatie | undefined;
    try {
      parsed = parseDsoIdentificatie(args.identificatie);
    } catch (error) {
      // A pasted URL with a broken %-escape is an identifier we cannot read, nothing else.
      if (!(error instanceof URIError)) throw error;
    }
    if (!parsed) throw unknownId();
    // A "/" or "\" in a path id never names a document; the DSO would answer with a bare HTTP 400.
    if (/[/\\]/.test(parsed.kind === "regeling" ? parsed.uriIdentificatie : parsed.kind === "ontwerpregeling" ? parsed.technischId : "")) throw unknownId();
    const notes: string[] = [];
    let kind: "regeling" | "ontwerpregeling";
    let pathId: string;
    if (parsed.kind === "ontwerpbesluit") {
      const catalogue = await this.catalogue("ontwerpregelingen");
      const hits = catalogue.items.filter((x) => x.ontwerpbesluitIdentificatie === parsed.ontwerpbesluitIdentificatie && x.technischId);
      if (!hits.length) {
        throw new DsoInputError(
          `Geen ontwerpregeling bij ontwerpbesluit '${parsed.ontwerpbesluitIdentificatie}' in het DSO.`,
          "Gebruik technischId uit dso_omgevingsdocumenten_search met soort 'ontwerpregelingen'.",
        );
      }
      if (hits.length > 1) notes.push(`Ontwerpbesluit ${parsed.ontwerpbesluitIdentificatie} bevat ${hits.length} ontwerpregelingen; getoond: ${hits[0].technischId}.`);
      kind = "ontwerpregeling";
      pathId = hits[0].technischId as string;
    } else if (parsed.kind === "ontwerpregeling") {
      kind = "ontwerpregeling";
      pathId = parsed.technischId;
    } else {
      kind = "regeling";
      pathId = parsed.uriIdentificatie;
    }
    const geldigOp = kind === "regeling" ? args.geldigOp : undefined;
    if (args.geldigOp && kind !== "regeling") notes.push("geldigOp geldt niet voor ontwerpregelingen en is niet toegepast.");

    const base = `${DSO_PRESENTEREN_BASE}/${kind === "regeling" ? "regelingen" : "ontwerpregelingen"}/${encodeURIComponent(pathId)}`;
    const query = geldigOp ? tijdreis(geldigOp) : undefined;
    const notFound = (error: unknown): never => {
      // Only a 404 means "not there": a 400 is a malformed DSO_API_KEY (or a parameter the DSO
      // refuses) and a 401/403 an unknown key, which the tool reports as configuration errors.
      if (error instanceof SourceRequestError && error.status === 404) {
        throw new DsoInputError(
          `Omgevingsdocument '${args.identificatie.slice(0, 120)}' niet gevonden in het DSO${geldigOp ? ` (geldig op ${geldigOp})` : ""}.`,
          `Gebruik identificatie, uriIdentificatie of technischId uit dso_omgevingsdocumenten_search${geldigOp ? "; of het DSO heeft geen versie die op die datum geldig én in werking was" : ""}.`,
          { endpoint: error.endpoint, status: error.status },
        );
      }
      if (error instanceof SourceRequestError && error.code === "malformed_response" && /exceeded/i.test(error.message)) {
        throw new DsoInputError(
          `Omgevingsdocument '${args.identificatie.slice(0, 120)}' is te groot om als tekst op te halen (documentstructuur groter dan ${DOCUMENT_MAX_BYTES / (1024 * 1024)} MB).`,
          `Lees het document via canonical_url uit dso_omgevingsdocumenten_search, of in Regels op de kaart (${DSO_RODK_URL}).`,
          { endpoint: error.endpoint },
        );
      }
      throw error;
    };
    const metadata = getJson<RegelingItem>(base, { query, headers: this.headers(), connector: CONNECTOR }).catch(notFound);
    const structure = cached(documentCache, `${base}|${geldigOp ?? this.today()}`, DOCUMENT_TTL_MS, DOCUMENT_CACHE_MAX, async () => {
      const { data, meta } = await getJson<{ _embedded?: DsoDocumentComponent["_embedded"] }>(`${base}/documentstructuur`, {
        query,
        headers: this.headers(),
        connector: CONNECTOR,
        timeoutMs: DOCUMENT_TIMEOUT_MS,
        retries: 1,
        // Parsed below and kept in documentCache; the raw megabytes need not be cached too.
        disableCache: true,
        maxResponseBytes: DOCUMENT_MAX_BYTES,
      });
      // A regeling's components are documentComponenten, an ontwerp's ontwerpDocumentComponenten.
      const doc = buildDsoDocument(data._embedded?.documentComponenten ?? data._embedded?.ontwerpDocumentComponenten ?? []);
      // Never "0 tekens" as if that were the text; and an empty parse is not cached.
      if (!doc.totalChars) {
        throw new DsoInputError(
          `Het DSO gaf voor '${args.identificatie.slice(0, 120)}' geen regeltekst terug (lege documentstructuur).`,
          `Lees het document via canonical_url uit dso_omgevingsdocumenten_search, of in Regels op de kaart (${DSO_RODK_URL}).`,
          { endpoint: meta.url },
        );
      }
      return { doc, endpoint: meta.url };
    }).catch(notFound);
    const [meta, { doc, endpoint }] = await Promise.all([metadata, structure]);
    const item = meta.data ? normalize(meta.data, this.today()) : undefined;
    const title = item?.title ?? args.identificatie;

    // The DSO holds only a pointer for some Rijk laws: say so, with where the text is.
    const identificatie = item?.identificatie ?? (parsed.kind === "regeling" ? parsed.identificatie : undefined);
    const placeholderUrl =
      (identificatie ? DSO_PLACEHOLDERS[identificatie] : undefined) ??
      (item?.documentUrlType === "wetten_overheid" && doc.totalChars < PLACEHOLDER_MAX_CHARS ? item.documentUrl : undefined);
    if (placeholderUrl) {
      notes.unshift(`${title}: het DSO bevat alleen een verwijzing, niet de wettekst; lees en doorzoek de wet op ${placeholderUrl}.`);
    }
    // A technical record the DSO lists among the Rijk's documents, without a single rule.
    const technisch =
      !placeholderUrl &&
      ((identificatie !== undefined && DSO_TECHNICAL_DOCUMENTS.has(identificatie)) ||
        (doc.totalChars < PLACEHOLDER_MAX_CHARS && doc.sections.some((s) => TECHNICAL_TEXT.test(s.body))));
    if (technisch) {
      notes.unshift(
        `${title} is een technisch aansluitdocument in het DSO (de tekst zegt alleen dat het er is 'ten behoeve van technisch aansluiten op DSO'); het bevat geen regels. De regels van het Rijk staan in de AMvB's (Besluit activiteiten leefomgeving, Besluit bouwwerken leefomgeving, Besluit kwaliteit leefomgeving, Omgevingsbesluit) en de Omgevingsregeling.`,
      );
    }
    if (kind === "ontwerpregeling") {
      notes.push(
        !doc.renvooi
          ? "Ontwerp, nog niet geldend: de tekst zoals het ontwerp ter inzage ligt."
          : args.weergave === "wijzigingen"
            ? "Ontwerp, nog niet geldend."
            : "Ontwerp, nog niet geldend: de tekst is de regeling zoals dit ontwerp haar zou maken (toegevoegde tekst verwerkt, geschrapte tekst en onderdelen weggelaten). Alleen wat het ontwerp wijzigt, met [+toegevoegde+] en [-geschrapte-] tekst: roep deze tool aan met weergave 'wijzigingen'.",
      );
    }

    const links = (meta.data as { _links?: { tijdelijkDelen?: unknown; tijdelijkDeelVan?: unknown } } | undefined)?._links;
    const delen = kind === "regeling" ? [...new Set(linkList(links?.tijdelijkDelen).map((l) => regelingLinkId(l.href)).filter((id): id is string => Boolean(id)))] : [];
    const parentId = kind === "regeling" ? linkList(links?.tijdelijkDeelVan).map((l) => regelingLinkId(l.href)).find(Boolean) : undefined;
    const [tijdelijkeDelen, parent] = await Promise.all([
      args.tijdelijkeDelen && delen.length ? this.tijdelijkeDelen(doc, delen.slice(0, MAX_TIJDELIJKE_DELEN), query, args.tijdelijkeDelen === "tekst") : undefined,
      // Best effort: the regeling it belongs to by title; without it, by its identifier.
      parentId ? this.regelingItem(parentId, query).catch(() => undefined) : undefined,
    ]);
    return {
      doc,
      item,
      kind,
      pathId,
      endpoint,
      access_note: notes.length ? notes.join(" ") : undefined,
      ...(placeholderUrl ? { placeholder: { url: placeholderUrl } } : {}),
      ...(technisch ? { technisch } : {}),
      ...(tijdelijkeDelen ? { tijdelijkeDelen, tijdelijkeDelenTotaal: delen.length } : {}),
      ...(parentId ? { tijdelijkDeelVan: { uriIdentificatie: parentId, item: parent } } : {}),
    };
  }

  /** One regeling's metadata, by uriIdentificatie (a tijdelijk deel, or the regeling one belongs to). */
  private async regelingItem(uriIdentificatie: string, query: Record<string, string> | undefined): Promise<DsoSearchItem> {
    const { data } = await getJson<RegelingItem>(`${DSO_PRESENTEREN_BASE}/regelingen/${encodeURIComponent(uriIdentificatie)}`, {
      query,
      headers: this.headers(),
      connector: CONNECTOR,
      timeoutMs: TIJDELIJK_DEEL_TIMEOUT_MS,
      retries: 1,
    });
    return normalize(data, this.today());
  }

  /**
   * The tijdelijke delen of a document, a few at a time, each read once per
   * document (tijdelijkeDelenOf). One that cannot be read says so and does not
   * fail the call; the next call tries it again.
   */
  private tijdelijkeDelen(doc: DsoDocument, ids: string[], query: Record<string, string> | undefined, withText: boolean): Promise<DsoTijdelijkDeel[]> {
    let read = tijdelijkeDelenOf.get(doc);
    if (!read) {
      read = new Map();
      tijdelijkeDelenOf.set(doc, read);
    }
    const memo = read;
    return mapLimit(ids, TIJDELIJK_DEEL_CONCURRENCY, async (id): Promise<DsoTijdelijkDeel> => {
      let entry = memo.get(id);
      if (!entry) {
        entry = { item: this.regelingItem(id, query) };
        memo.set(id, entry);
      }
      if (withText && !entry.doc) entry.doc = this.tijdelijkDeelDoc(id, query);
      try {
        const [item, deel] = await Promise.all([entry.item, withText ? entry.doc : undefined]);
        return { uriIdentificatie: id, item, ...(deel ? { doc: deel } : {}) };
      } catch (error) {
        memo.delete(id);
        return { uriIdentificatie: id, error: error instanceof SourceRequestError && error.status ? `HTTP ${error.status}` : "geen antwoord van het DSO" };
      }
    });
  }

  private async tijdelijkDeelDoc(uriIdentificatie: string, query: Record<string, string> | undefined): Promise<DsoDocument> {
    const { data } = await getJson<{ _embedded?: DsoDocumentComponent["_embedded"] }>(`${DSO_PRESENTEREN_BASE}/regelingen/${encodeURIComponent(uriIdentificatie)}/documentstructuur`, {
      query,
      headers: this.headers(),
      connector: CONNECTOR,
      timeoutMs: TIJDELIJK_DEEL_TIMEOUT_MS,
      retries: 1,
      // Parsed and kept with the document it belongs to (tijdelijkeDelenOf).
      disableCache: true,
    });
    return buildDsoDocument(data._embedded?.documentComponenten ?? []);
  }
}
