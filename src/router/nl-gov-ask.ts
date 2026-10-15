/**
 * nl_gov_ask: the router that sends a natural-language question to the best
 * source(s). registerTools (tools.ts) registers it in its place in the tool
 * list and hands it the configuration, sources and record helpers it shares
 * with the other tools; what it reads from a question lives in ./intents.ts.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ENV_KEYS } from "../config.js";
import { mapTweedeKamerError, tkRecordView, tkSubjectTitle, type TweedeKamerSource } from "../sources/tweede-kamer.js";
import { DEBAT_DEFAULT_CHARS, type TweedeKamerDebattenSource, type DebatHit, type DebatSearchResult } from "../sources/tweede-kamer-debatten.js";
import { rewriteKeepingSyntax, type BekendmakingenSource } from "../sources/bekendmakingen.js";
import { ApiRegisterSource } from "../sources/api-register.js";
import { tenderNedRecordFields, type TenderNedSource } from "../sources/tenderned.js";
import { parseDocumentNumber, type EuCellarSource } from "../sources/eu-cellar.js";
import { DsoOmgevingsdocumentenSource, DsoInputError, DSO_PRESENTEREN_BASE, type DsoSearchItem } from "../sources/dso-omgevingsdocumenten.js";
import { ALGORITMEREGISTER_SEARCH_ENDPOINT, clampAlgoritmeRows, summarizeAlgoritmeSearch, type AlgoritmeregisterSource } from "../sources/algoritmeregister.js";
import { EU_FUNDING_SEARCH_ENDPOINT, buildEuFundingRequest, clampEuFundingRows, describeEuFundingItem, euFundingParams, summarizeEuFundingGet, summarizeEuFundingSearch, type EuFundingItem, type EuFundingSearchArgs, type EuFundingSource } from "../sources/eu-funding.js";
import { RVO_MAX_ROWS, RVO_SUBSIDIES_ENDPOINT, summarizeRvoSearch, type RvoSubsidiesSearchArgs, type RvoSubsidiesSource, type RvoSubsidyItem, type RvoSubsidyStatus } from "../sources/rvo-subsidies.js";
import { clampOnderzoekscallRows, mapOnderzoekscallError, summarizeOnderzoekscallsSearch, type OnderzoekscallItem, type OnderzoekscallsSearchArgs, type OnderzoekscallsSource } from "../sources/nl-onderzoekscalls.js";
import { mapSourceError, successResponse, toMcpToolPayload, errorResponse } from "../utils/response.js";
import { SourceRequestError } from "../utils/http.js";
import { parseTemporalRange } from "../utils/temporal.js";
import { getConnectorHealth } from "../utils/connector-runtime.js";
import { buildFormattedResponse, mergeAccessNotes } from "../utils/tool-runner.js";
import type { MCPRecord, AppConfig, ToolResult } from "../types.js";
import { rewriteQuery, extractKeywords, extractKeywordTerms, looseTimePhrases, rewriteNote, quotedQuery } from "../utils/query-rewriter.js";
import type { DataOverheidSource } from "../sources/data-overheid.js";
import { CBS_POPULATION_TABLE, cbsCatalogItemUrl, cbsMunicipalityPopulation, cbsTableUrl, type CbsSource } from "../sources/cbs.js";
import type { RijksoverheidSource } from "../sources/rijksoverheid.js";
import type { RijksbegrotingSource } from "../sources/rijksbegroting.js";
import type { DuoSource } from "../sources/duo.js";
import type { OriSource } from "../sources/ori.js";
import { UITSPRAAK_DEFAULT_CHARS } from "../sources/rechtspraak.js";
import { BWB_TEXT_DEFAULT_CHARS } from "../sources/wetten-bwb.js";
import { clampWodcRows, mapWodcError, WODC_SEARCH_ENDPOINT, type WodcItem, type WodcSource } from "../sources/wodc.js";
import type { LuchtmeetnetSource } from "../sources/luchtmeetnet.js";
import type { RechtspraakSource } from "../sources/rechtspraak.js";
import type { KoopCollectieSource } from "../sources/koop-collecties.js";
import type { BrpGewasperceelSource } from "../sources/brp-gewaspercelen.js";
import type { VerkiezingsuitslagenSource } from "../sources/verkiezingsuitslagen.js";
import { matchesTerm, hasTerm, CBS_TERMS, TK_TERMS, OB_TERMS, RIJK_TERMS, RIJK_OFFICE_TERMS, BUDGET_TERMS, DUO_TERMS, API_TERMS, CASE_LAW_TERMS, ENFORCEMENT_TERMS, EXAM_TERMS, SCHOOL_TERMS, duoSector, routeChain, firstRoute, type RouteFacts, type RouteId } from "./routes.js";
import { extractPlaceName, cbsNarrowingCandidates, extractLuchtComponent, extractVerkiezingHint, detectEuIntent, shouldDeepenTweedeKamerQuery, MUNICIPAL_SCOPE_WORDS, ORGANISATION_WORDS, uitsprakenSense, detectPolicyIntent, detectDebatIntent, detectAlgoritmeIntent, DSO_DOCUMENT_WORDS_RE, dsoWords, type DsoIntent, detectDsoIntent, toPhraseQuery, toOriQuery, oriPlacePhrase, detectEcliIntent, detectForeignEcliIntent, detectWetArtikelIntent, detectResearchOrgIntent, extractPopulationPlace, extractPopulationYear, type ResearchOrg, detectSubsidieIntent, narrowSubsidieIntent, type SubsidieIntent, type SubsidieSource } from "./intents.js";
import { KnmiSource } from "../sources/knmi.js";

/** data.match of a Tweede Kamer record that holds the words of a name apart, not as the phrase (nl_gov_ask). */
const TK_WORDS_APART = "woorden afzonderlijk";

function getRecordIdentifier(rec: MCPRecord): string | undefined {
  const data = (rec.data ?? {}) as Record<string, unknown>;
  const keys = ["ecli", "document_id", "cbs_table_id", "bwb_id", "url", "identifier", "id"];
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      return `${key}:${value.trim().toLowerCase()}`;
    }
  }
  if (rec.canonical_url) return `canonical:${rec.canonical_url.toLowerCase()}`;
  return undefined;
}

function metadataScore(rec: MCPRecord): number {
  const data = (rec.data ?? {}) as Record<string, unknown>;
  let score = Object.keys(data).length;
  if (rec.snippet) score += 2;
  if (rec.date) score += 1;
  if (rec.title) score += 1;
  if (rec.canonical_url) score += 1;
  return score;
}

/**
 * A question about an address gets every bestuurslaag that has rules at that
 * point (about 25 documents in a city); cut at `top`, the Rijk went missing.
 * The search's own default for a locatie.
 */
const DSO_LOCATIE_ROWS = 50;

/**
 * How long nl_gov_ask waits for the DSO. A cold catalogue takes about 5 s; a
 * hanging DSO retries for up to a minute, past the 60 s an MCP client waits.
 */
const DSO_ROUTE_DEADLINE_MS = 20_000;

/** The rows nl_gov_ask asks the DSO for. */
function dsoRows(intent: DsoIntent, top: number): number {
  return intent.locatie ? Math.max(top, DSO_LOCATIE_ROWS) : top;
}

/** The bestuurslagen in the order the search sorts an address answer, with their TOOI code prefix. */
const DSO_LAYERS: Array<{ layer: string; code: RegExp; label: string }> = [
  { layer: "gemeente", code: /^gm\d/i, label: "gemeente" },
  { layer: "waterschap", code: /^ws\d/i, label: "waterschap" },
  { layer: "provincie", code: /^pv\d/i, label: "provincie" },
  { layer: "ministerie", code: /^mnre\d/i, label: "Rijk" },
];

function dsoLayerOf(item: DsoSearchItem): string {
  const laag = (item.bestuurslaag ?? "").toLowerCase();
  return DSO_LAYERS.find((l) => l.code.test(item.bevoegdGezagCode ?? "") || laag.startsWith(l.layer))?.layer ?? "overig";
}

/**
 * An address answer in bestuurslaag order (as the search sorts it) whose first
 * page holds one document of every layer: cut at the page size, the Rijk and
 * often the provincie fell off. The rest follows in order on the next pages.
 */
function dsoLayerFirstPage(items: DsoSearchItem[], pageSize: number): DsoSearchItem[] {
  if (items.length <= pageSize) return items;
  const page = new Set<DsoSearchItem>();
  const layers = new Set<string>();
  for (const item of items) {
    if (page.size >= pageSize) break;
    const layer = dsoLayerOf(item);
    if (!layers.has(layer)) {
      layers.add(layer);
      page.add(item);
    }
  }
  for (const item of items) {
    if (page.size >= pageSize) break;
    page.add(item);
  }
  return [...items.filter((x) => page.has(x)), ...items.filter((x) => !page.has(x))];
}

/** "Op dit punt: 26 documenten (gemeente 3, waterschap 2, provincie 6, Rijk 15)". */
function dsoLayerNote(items: DsoSearchItem[], pageSize: number): string {
  const counts = [...DSO_LAYERS, { layer: "overig", label: "overig" }]
    .map(({ layer, label }) => [label, items.filter((x) => dsoLayerOf(x) === layer).length] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${n}`);
  const more = items.length > pageSize ? `; de eerste ${pageSize} tonen elke bestuurslaag, de rest volgt met offset ${pageSize}` : "";
  return `Op dit punt: ${items.length} ${items.length === 1 ? "document" : "documenten"} (${counts.join(", ")})${more}.`;
}

/** The DSO request nl_gov_ask plans for a question (dryRun). */
function dsoPlannedRequests(intent: DsoIntent, question: string, top: number) {
  const soort = intent.soort ?? "regelingen";
  const zoek = Boolean(intent.locatie || intent.bevoegdGezag || intent.provincie);
  const rows = dsoRows(intent, top);
  return [
    {
      connector: "dso_omgevingsdocumenten",
      method: zoek ? "POST" : "GET",
      url: `${DSO_PRESENTEREN_BASE}/${soort}${zoek ? "/_zoek" : ""}`,
      params: {
        ...(intent.locatie ? { locatie: intent.locatie } : {}),
        ...(intent.bevoegdGezag ? { bevoegdGezag: intent.bevoegdGezag } : {}),
        ...(intent.provincie ? { provincie: intent.provincie } : {}),
        ...(intent.typeBevoegdGezag ? { typeBevoegdGezag: intent.typeBevoegdGezag } : {}),
        ...(intent.documentType ? { documentType: intent.documentType } : {}),
        soort,
        ...(intent.alleenTerInzage ? { alleen_ter_inzage: true } : {}),
        ...(intent.geldigOp ? { geldigOp: intent.geldigOp } : {}),
        question,
        top,
        ...(rows !== top ? { rows } : {}),
      },
    },
  ];
}

/** Topic words after "over"/"voor" that the DSO search does not look at (it searches titles and metadata). */
const DSO_TOPIC_RE = /(?:^|[^\p{L}])(?:over|voor|betreffende|inzake)\s+((?:\p{Ll}[\p{L}-]*)(?:\s+(?:en|of|\p{Ll}[\p{L}-]*))*)/u;

const DSO_NOT_A_TOPIC = [
  "regels", "regel", "regelgeving", "gelden", "geldt", "golden", "gold", "staat", "staan", "zegt", "over", "voor",
  "omgevingswet", "documenten", "document", "adres", "locatie", "gemeente", "provincie", "waterschap", "mij", "mijn",
  "huis", "woning", "perceel", "kavel", "plek", "plaats", "gebied", "nu", "er",
  // Words the route already turned into parameters: the Rijk, the newest, ontwerpen ter inzage, a layer.
  "nationale", "rijk", "nieuwste", "recentste", "recente", "laatste", "ontwerp", "ontwerpen", "ter", "inzage",
  "gemeenten", "provincies", "waterschappen",
];

/** The topic words of a DSO question that no search parameter carries ("over dakkapellen"); `used` holds the parameter values. */
function dsoTopicWords(question: string, used: string[]): string[] {
  const tail = DSO_TOPIC_RE.exec(question)?.[1] ?? "";
  const usedWords = used.flatMap(dsoWords);
  return tail ? extractKeywords(tail, { exclude: [...DSO_NOT_A_TOPIC, ...usedWords] }).filter((w) => !DSO_DOCUMENT_WORDS_RE.test(w) && !usedWords.includes(w.toLowerCase())) : [];
}

/** A year the question asks a period for ("in 2025", "sinds 2024"), not one in a title ("Omgevingsvisie Amsterdam 2050"). */
const DSO_PERIOD_YEAR_RE = /(?:^|[^\p{L}])(?:in|sinds|vanaf|tot|tussen|uit|per|tijdens|na)\s+(?:het\s+jaar\s+)?(?:19|20)\d\d(?!\d)/iu;

/**
 * The search's notes in nl_gov_ask's terms: nl_gov_ask has no `rows` (the
 * paging note names `top`) and no `provincie` parameter ("in de provincie X").
 */
function dsoRouterNote(note: string | undefined, bevoegdGezagNaam?: string): string | undefined {
  const provincie = bevoegdGezagNaam?.replace(/^provincie\s+/i, "");
  return note
    ?.replace(/Niet getoond \(rows (\d+)\)/g, "Niet getoond (nl_gov_ask haalt er $1 op)")
    .replace(/; verhoog rows (?:naar \d+|\(max \d+\)) voor de volledige lijst\./g, ".")
    .replace(/Voor de provincie met al haar gemeenten: provincie '(pv\d+)'\./g, (_, code: string) => `Voor de provincie met al haar gemeenten: vraag naar 'in de provincie ${provincie ?? code}'.`);
}

/**
 * How long nl_gov_ask's document search waits for its sources. Tweede Kamer
 * regularly needs 30 s or times out; the other sources answer within a few
 * seconds, so the answer goes out without a straggler and names it.
 */
const POLICY_SEARCH_DEADLINE_MS = 10_000;

/**
 * Officiële Bekendmakingen refused the query: an SRU diagnostic without a
 * count or records (BekendmakingenSearchResult.diagnostic). Nothing was
 * searched, so nl_gov_ask reports it as a failure instead of "0 resultaten".
 */
class BekendmakingenRefusedError extends Error {
  constructor(readonly diagnostic: string) {
    super(`Officiële Bekendmakingen weigerde de zoekvraag (SRU-diagnose: ${diagnostic}); er is niet gezocht.`);
    this.name = "BekendmakingenRefusedError";
  }
}

/** Throw {@link BekendmakingenRefusedError} for a refused Officiële Bekendmakingen search. */
function assertBekendmakingenSearched(out: { items: unknown[]; diagnostic?: string }): void {
  if (out.diagnostic && !out.items.length) throw new BekendmakingenRefusedError(out.diagnostic);
}

function dedupeMergedRecords(records: MCPRecord[]): MCPRecord[] {
  const byId = new Map<string, MCPRecord>();
  const passthrough: MCPRecord[] = [];

  for (const rec of records) {
    const id = getRecordIdentifier(rec);
    if (!id) {
      passthrough.push(rec);
      continue;
    }

    const current = byId.get(id);
    if (!current) {
      byId.set(id, { ...rec, data: { ...(rec.data ?? {}) } });
      continue;
    }

    const currentScore = metadataScore(current);
    const nextScore = metadataScore(rec);
    const keep = nextScore > currentScore ? { ...rec, data: { ...(rec.data ?? {}) } } : current;
    const drop = keep === current ? rec : current;

    const keepData = (keep.data ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(keepData.also_found_in)
      ? (keepData.also_found_in as Array<Record<string, unknown>>)
      : [];

    const relation = {
      source_name: drop.source_name,
      canonical_url: drop.canonical_url,
    };

    const already = existing.some(
      (x) =>
        String(x.source_name ?? "") === relation.source_name &&
        String(x.canonical_url ?? "") === relation.canonical_url,
    );

    keepData.also_found_in = already ? existing : [...existing, relation];
    keep.data = keepData;

    byId.set(id, keep);
  }

  return [...byId.values(), ...passthrough];
}

/**
 * The text each ruling gets when nl_gov_ask reads the rulings a question names
 * by ECLI: one gets rechtspraak_uitspraak_get's default, several share about
 * that much between them.
 */
function uitspraakChars(count: number): number {
  return count > 1 ? Math.max(2_000, Math.floor(UITSPRAAK_DEFAULT_CHARS / count)) : UITSPRAAK_DEFAULT_CHARS;
}

/** How long nl_gov_ask waits for the text of the best ORI hit before answering without it. */
const ORI_DEEP_FETCH_DEADLINE_MS = 6_000;

/**
 * The period words that give a law's text a day of their own: the period's
 * first day ("vorig jaar": 1 januari of that year), as "in 2015" is 1 januari
 * 2015. How the answer names the day it took.
 */
const WET_RELATIVE_PATTERNS: Record<string, string> = {
  today: "vandaag",
  yesterday: "gisteren",
  this_year: "dit jaar: 1 januari",
  last_year: "vorig jaar: 1 januari",
  last_quarter: "vorig kwartaal: de eerste dag",
  last_month: "vorige maand: de eerste dag",
  last_week: "vorige week: maandag",
};

/** What a weather question gets from the KNMI route: warnings, earthquakes or the newest station observations. */
type KnmiKind = "observations" | "warnings" | "earthquakes";
const KNMI_KINDS: Record<KnmiKind, { label: string; tool: string; dataset: { name: string; version: string } }> = {
  observations: { label: "waarnemingen", tool: "knmi_latest_observations", dataset: { name: "10-minute-in-situ-meteorological-observations", version: "1.0" } },
  warnings: { label: "waarschuwingen", tool: "knmi_warnings", dataset: { name: "waarschuwingen_nederland_48h", version: "1.0" } },
  earthquakes: { label: "aardbevingen", tool: "knmi_earthquakes", dataset: { name: "aardbevingen_nederland", version: "2" } },
};

/** An office holder as the sender, addressee or subject of a Tweede Kamer paper: "van de minister", "aan de staatssecretaris", "over de staatssecretaris". */
const TK_PAPER_PARTY_RE = /\b(?:van|aan|door|naar|tot|over)\s+(?:de\s+|het\s+)?(?:minister(?:s|-president)?|staatssecretaris(?:sen)?|kabinet|regering|ministerie)\b/g;

/** A letter to or from the Kamer without the word Kamerbrief: "Brief van de staatssecretaris aan de Tweede Kamer over toeslagen". */
const TK_LETTER_RE = /\bbrie(?:f|ven)\b.*\b(?:aan|naar|van)\s+de\s+(?:tweede\s+)?kamer\b/;

/** The longest question nl_gov_ask takes: a question, not a document. */
const NL_GOV_ASK_QUESTION_MAX_CHARS = 2_000;

/**
 * The topic words for RVO's catalogue search, a long word cut to its stem.
 * RVO matches a word anywhere in a longer one, so the stem finds the other
 * forms too: "verduurzaming" missed the DUMAVA page ("verduurzamen"), which
 * "verduurzam" finds; "batterijen" missed "batterij". A quoted phrase and an
 * operator stay as they are.
 */
export function rvoStems(query: string): string {
  if (/["]|\bOR\b|(?:^|\s)-/.test(query)) return query;
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length >= 7 ? (/^(\p{L}{5,}?)(?:ingen|ing|en)$/u.exec(word)?.[1] ?? word) : word))
    .join(" ");
}

/** The research bodies nl_gov_ask reads the publications of, as their tools name them. */
const RESEARCH_ORGS: Record<ResearchOrg, { label: string; tool: string }> = {
  rekenkamer: { label: "Algemene Rekenkamer", tool: "rekenkamer_publicaties_search" },
  scp: { label: "Sociaal en Cultureel Planbureau", tool: "scp_publicaties_search" },
  wodc: { label: "WODC", tool: "wodc_search" },
};

/** What nl_gov_ask shares with the other tools: the configuration, the sources and the record helpers. */
export interface NlGovAskDeps {
  config: AppConfig;
  TOOL_ANNOTATIONS: { readonly readOnlyHint: true; readonly openWorldHint: true; };
  dataOverheid: DataOverheidSource;
  cbs: CbsSource;
  tk: TweedeKamerSource;
  debatten: TweedeKamerDebattenSource;
  bekend: BekendmakingenSource;
  rijksoverheid: RijksoverheidSource;
  rijksbegroting: RijksbegrotingSource;
  duo: DuoSource;
  ori: OriSource;
  luchtmeetnet: LuchtmeetnetSource;
  rechtspraak: RechtspraakSource;
  tenderned: TenderNedSource;
  tuchtrecht: KoopCollectieSource;
  samenwerkendeCatalogi: KoopCollectieSource;
  brpGewaspercelen: BrpGewasperceelSource;
  verkiezingsuitslagen: VerkiezingsuitslagenSource;
  euCellar: EuCellarSource;
  algoritmeregister: AlgoritmeregisterSource;
  record: (source: string, title: string, canonical_url: string, data: Record<string, unknown>, snippet?: string, date?: string) => MCPRecord;
  algoritmeRecord: (x: Awaited<ReturnType<AlgoritmeregisterSource["search"]>>["items"][number]) => MCPRecord;
  wodc: WodcSource;
  wodcRecord: (x: WodcItem) => MCPRecord;
  euFunding: EuFundingSource;
  euFundingRecord: (x: EuFundingItem) => MCPRecord;
  rvoSubsidies: RvoSubsidiesSource;
  rvoRecord: (x: RvoSubsidyItem & { status_info?: RvoSubsidyStatus }) => MCPRecord;
  onderzoekscalls: OnderzoekscallsSource;
  onderzoekscallRecord: (x: OnderzoekscallItem) => MCPRecord;
  /** rechtspraak_uitspraak_get: a ruling by ECLI. */
  uitspraakResult: (args: { ecli: string; onderdeel: "overzicht" | "beslissing" | "overwegingen" | "volledig"; sectie?: string; zoekterm?: string; max_chars: number }) => Promise<ToolResult>;
  /** wetten_bwb_tekst: the text of a national law or one of its artikelen. */
  wettenTekstResult: (args: { bwb_id?: string; wet?: string; artikel?: string; peildatum?: string; zoekterm?: string; max_chars: number }) => Promise<ToolResult>;
  debatRecords: (hits: DebatHit[], maxChars: number) => Promise<MCPRecord[]>;
  debatSummary: (out: DebatSearchResult) => string;
  debatNotes: (out: DebatSearchResult, single: boolean) => string | undefined;
  dsoRecord: (x: DsoSearchItem) => MCPRecord;
  prov: (tool: string, endpoint: string, query_params: Record<string, string>, returned_results: number, total_results?: number | null) => { tool: string; endpoint: string; query_params: Record<string, string>; timestamp: string; returned_results: number; total_results: number | undefined; };
  outputFormatSchema: z.ZodDefault<z.ZodEnum<{ json: "json"; csv: "csv"; geojson: "geojson"; markdown_table: "markdown_table"; }>>;
  paginationInputSchema: { offset: z.ZodDefault<z.ZodNumber>; limit: z.ZodOptional<z.ZodNumber>; };
}

export function registerNlGovAsk(server: McpServer, deps: NlGovAskDeps): void {
  const { config, TOOL_ANNOTATIONS, dataOverheid, cbs, tk, debatten, bekend, rijksoverheid, rijksbegroting, duo, ori, luchtmeetnet, rechtspraak, tenderned, tuchtrecht, samenwerkendeCatalogi, brpGewaspercelen, verkiezingsuitslagen, euCellar, algoritmeregister, record, algoritmeRecord, wodc, wodcRecord, euFunding, euFundingRecord, rvoSubsidies, rvoRecord, onderzoekscalls, onderzoekscallRecord, uitspraakResult, wettenTekstResult, debatRecords, debatSummary, debatNotes, dsoRecord, prov, outputFormatSchema, paginationInputSchema } = deps;

  /**
   * An ORI item as nl_gov_ask shows it, the way ori_search does: the passage
   * around the matched terms as snippet (kept out of `data`, so it is not sent
   * twice) instead of the bare record type.
   */
  function oriRecord({ snippet, ...item }: Record<string, unknown>): MCPRecord {
    return record("ori", String(item.title ?? item.id ?? "ORI item"), String(item.url ?? "https://www.openraadsinformatie.nl"), item, String(snippet ?? item.type ?? ""), String(item.publishedAt ?? ""));
  }

  /**
   * A Tweede Kamer document as nl_gov_ask shows it, the way
   * tweede_kamer_documents does: its subject rather than the dossier title that
   * hundreds of documents share, its kamerstuk page rather than the API
   * resource, and its type, number and date.
   */
  function tkDocumentRecord(item: Record<string, unknown>): MCPRecord {
    const view = tkRecordView("Document", item, config.endpoints.tweedeKamer);
    return record("tweedekamer", view.title, view.url, item, view.snippet, view.date);
  }

  // _meta "anthropic/alwaysLoad": Claude Code loads this entry point upfront instead of behind its tool search.
  server.registerTool("nl_gov_ask", { inputSchema: { question: z.string().min(1, "question is leeg").max(NL_GOV_ASK_QUESTION_MAX_CHARS, `question is te lang: maximaal ${NL_GOV_ASK_QUESTION_MAX_CHARS} tekens; stel een kortere vraag of gebruik de zoektool van de bron`), top: z.number().int().min(1).max(config.limits.maxRows).default(10), reference_now: z.string().optional(), timezone: z.string().optional(), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, description: "Use this when the best source is unclear: routes a question about Dutch government data to the best source(s); then use that source's own tool for full text. Reads dates ('vorige week', 'since 2020'). Policy questions ('GGZ-beleid gemeente Utrecht') search council records (ORI), publications, Tweede Kamer, Rijksoverheid. An ECLI gives that ruling, 'artikel 3:4 Awb' the law text ('op <datum>' too), Algemene Rekenkamer/SCP/WODC their reports, 'inwoners <gemeente>' a CBS count. Subsidy and funding questions ('welke subsidies zijn er voor waterstof', 'open EU-calls voor zorginnovatie', 'NWO call AI deadline') go to RVO, NWO/ZonMw or the EU Funding & Tenders Portal (topic words in English there); with a gemeente or provincie as funder the document routes answer. With DSO_API_KEY, Omgevingswet document questions go to the DSO first: an omgevingsplan, -visie, -verordening, -programma, waterschapsverordening, voorbereidingsbesluit, projectbesluit or ontwerpregeling with an address, place or body, or asking for a list, the newest or ontwerpen; 'welke regels gelden op <adres/postcode>' ('mag ik een dakkapel plaatsen op ...'); ontwerpen ter inzage of a named body or place. An address covers every bestuurslaag, 'in de provincie X' also its gemeenten; 'gelden op <dag>' sets the day. Questions about the law, procedures, costs, participation or politics, or naming another kind of source (publications, case law, enforcement, permits, tenders, statistics, news) skip the DSO, as do questions over 500 characters. For an address, place or ontwerpen an empty DSO answer stands; if the DSO fails, times out (20 s) or misses the place, other routes answer. Without an answer it falls back to the data.overheid.nl catalogue. access_note names the search terms and the routes tried.", annotations: TOOL_ANNOTATIONS, _meta: { "anthropic/alwaysLoad": true } }, async ({ question, top, reference_now, timezone, offset, limit, outputFormat, verbose, dryRun }) => {
    const decodedQuestion = (() => {
      try { return decodeURIComponent(question.replace(/\+/g, " ")); } catch { return question; }
    })();
    const temporal = parseTemporalRange(decodedQuestion, { now: reference_now, timeZone: timezone ?? config.temporal.defaultTimeZone });
    const questionForSearch = temporal?.cleanedQuery?.trim() ? temporal.cleanedQuery : decodedQuestion;
    const q = questionForSearch.toLowerCase();
    // Intent terms on word boundaries (matchesTerm, ./routes.ts).
    const has = (terms: readonly string[]) => hasTerm(q, terms);

    // "Uitspraken van de minister over jeugdzorg": "uitspraken" means statements
    // here and names the kind of answer, not its topic. As a search term it
    // found Tweede Kamer papers with "uitspraken" in the title on any subject.
    const uitspraken = uitsprakenSense(questionForSearch);
    const answerKindWords = uitspraken === "statements" ? ["uitspraak", "uitspraken"] : [];
    const keywords = (input: string, exclude: Iterable<string> = []): string[] =>
      extractKeywords(input, { exclude: [...exclude, ...answerKindWords] });
    // Runs of capitalised words the keywords grouped into one term ("Schiphol
    // Geluidsoverlast"): no phrase the question holds, unlike a quoted term or
    // "open data portaal". Tweede Kamer and Officiële Bekendmakingen get their
    // words (toPhraseQuery); only the Tweede Kamer route tries the phrase first.
    const nameTerms: ReadonlySet<string> = new Set(
      extractKeywordTerms(questionForSearch).filter((term) => term.kind === "name").map((term) => term.text),
    );

    // "Samenvatting van de laatste Kamerbrief over stikstof": the words that ask
    // for the content (which the route then reads) are no topic; as a required
    // search word "samenvatting" found a "Managementsamenvatting" on stikstof.
    const contentRequestWords = shouldDeepenTweedeKamerQuery(decodedQuestion)
      ? ["samenvatting", "samenvatten", "samengevat", "vat", "samen", "inhoud", "analyse", "analyseer", "summary", "summarize", "summarise", "erin", "daarin", "staat", "stond", "staan", "wat"]
      : [];
    // Route-specific words that select the source and are no search topic there.
    const tkRouteWords = ["tweede kamer", "parlement", "motie", "moties", "amendement", "amendementen", "kamerstuk", "kamerstukken", "kamervraag", "kamervragen", "debat", "debatten", "stemming", "stemmingen", "fractie", "fracties", "commissie", "commissies", "wetsvoorstel", "wetsvoorstellen", "kamerlid", "kamerleden", "minister-president", "premier", "kamerbrief", "kamerbrieven", "aangenomen", "verworpen"];
    // Officiële Bekendmakingen: a journal named in the question is the
    // publicatieblad filter, not a word every publication must contain, and
    // "bekendmakingen" only picks the route.
    const obJournalWords: Record<string, string> = {
      staatscourant: "Staatscourant",
      stcrt: "Staatscourant",
      gemeenteblad: "Gemeenteblad",
      gmb: "Gemeenteblad",
      staatsblad: "Staatsblad",
      tractatenblad: "Tractatenblad",
      "provinciaal blad": "Provinciaal blad",
      waterschapsblad: "Waterschapsblad",
    };
    const obRouteWords = ["bekendmaking", "bekendmakingen", "officiele publicatie", "officiële publicatie", "officiele publicaties", "officiële publicaties", ...Object.keys(obJournalWords)];
    // A question that names several sources ("Welke kamerstukken en
    // publicaties in de Staatscourant gaan over parkeerbeleid?") carries the
    // route words of all of them, and every source required the others'
    // words: Officiële Bekendmakingen "kamerstukken", Tweede Kamer
    // "staatscourant". The words that name a source or its kind of document,
    // and that the question contains, are no topic for any source.
    // Organisations that are also a source (CBS, DUO, Rijksoverheid) stay:
    // "Wat doet DUO met …" is about them. "publicaties" alone is generic, but
    // next to a journal ("publicaties in de Staatscourant") it names the
    // official publications too.
    const namesOfficialPublications = obRouteWords.some((word) => matchesTerm(q, word));
    const namedDocumentWords = [...tkRouteWords, ...obRouteWords, ...(namesOfficialPublications ? ["publicatie", "publicaties"] : [])]
      .filter((word) => matchesTerm(q, word));
    // Court rulings are what Rechtspraak holds: next to another source's
    // papers ("Welke uitspraken en kamervragen zijn er over huurbescherming?")
    // "uitspraken" names that source too, and Tweede Kamer found nothing with
    // it as a required word. On its own ("Uitspraak in de zaak tegen de
    // minister") it is what government news and parliamentary papers
    // respond to, and it stays.
    const namedRulingWords = uitspraken === "rulings" && namedDocumentWords.length ? ["uitspraak", "uitspraken"].filter((word) => matchesTerm(q, word)) : [];
    const namedRouteWords = [...namedDocumentWords, ...namedRulingWords];
    // Council papers are motions, amendments and votes too, in committees and
    // by fractions: in Open Raadsinformatie those words are no other source's.
    const councilDocumentWords = new Set(["motie", "moties", "amendement", "amendementen", "debat", "debatten", "stemming", "stemmingen", "fractie", "fracties", "commissie", "commissies", "aangenomen", "verworpen"]);
    const namedNationalRouteWords = namedRouteWords.filter((word) => !councilDocumentWords.has(word));
    /**
     * Topic keywords for one source: without its own route words (`own`) and
     * without the route words the question names (`named`). When those are
     * all the question has, they are its topic after all ("Welke kamerstukken
     * gaan over de Staatscourant?"): then only the source's own words go, as
     * before.
     */
    const topicTerms = (input: string, own: Iterable<string> = [], named: string[] = namedRouteWords): string[] => {
      const ownWords = [...own];
      const narrowed = keywords(input, [...ownWords, ...named]);
      return narrowed.length ? narrowed : keywords(input, ownWords);
    };

    // Topic keywords of the question, minus words the route already acts on
    // ("aanbestedingen" for TenderNed) and the route words of other sources.
    // The moderate rewrite only strips the question frame and kept "welke …
    // zijn er voor …", which OR-matching (TenderNed) and AND-matching (CKAN,
    // SRU) sources both choke on.
    const makeKeywordQuery = (input: string, exclude: Iterable<string> = []): string =>
      topicTerms(input, exclude).join(" ") || rewriteQuery(input, "moderate").rewritten;

    const makeStrictQuery = (input: string): string =>
      rewriteQuery(input, "strict").rewritten;

    // Rechtspraak gets the strict rewrite, not keywords; the route words the
    // question names come out of it as well ("Welke uitspraken en kamervragen
    // zijn er over huurbescherming?" made it require "kamervragen"). A word of
    // a name the question capitalised ("Europees Parlement") stays, unless the
    // name is a route word itself ("Tweede Kamer").
    const namedRouteTokens = new Set(namedRouteWords.flatMap((word) => word.split(/\s+/)));
    const makeRechtspraakQuery = (input: string): string => {
      const strict = makeStrictQuery(input);
      if (!namedRouteTokens.size) return strict;
      const nameWords = new Set(
        keywords(input)
          .filter((term) => term.includes(" ") && !term.split(" ").every((word) => namedRouteTokens.has(word)))
          .flatMap((term) => term.split(" ")),
      );
      const kept = strict.split(/\s+/).filter((word) => word && (!namedRouteTokens.has(word) || nameWords.has(word)));
      // Only route words (or the recency marker) left: they are the topic.
      return kept.some((word) => word !== "laatste") ? kept.join(" ") : strict;
    };

    // The question minus its frame ("Wat is het ..."), every other word kept.
    const makeModerateQuery = (input: string): string => rewriteQuery(input, "moderate").rewritten;

    // CBS keeps the moderate rewrite: its catalogue search is a case-sensitive
    // substring match on table titles and its candidate cascade is tuned to it.
    const makeCbsQuery = makeModerateQuery;

    // Report the search terms a route derived from the question (access_note).
    const queryNote = (used: string): string | undefined => rewriteNote({ original: decodedQuestion, rewritten: used });
    const temporalNote = temporal
      ? `Periode toegepast: ${temporal.from} t/m ${temporal.to} (${temporal.matchedPattern}).`
      : undefined;

    // The document type the Tweede Kamer route filters on, when the question names one.
    const tkType = /\bmoties?\b/.test(q)
      ? "Motie"
      : /\bamendementen?\b/.test(q)
        ? "Amendement"
        : /\bkamervra(?:ag|gen)\b/.test(q)
          ? "Schriftelijke vragen"
          : /\bkamerbrie(?:f|ven)\b/.test(q)
            ? "Brief regering"
            : undefined;
    // The Tweede Kamer topic without the route words. parseTkQuery matches a
    // quoted term as a whole phrase: a phrase the question holds goes quoted,
    // a run of capitalised words as its words (nameTerms). The Tweede Kamer
    // route tries such a name as a phrase first (tkNamedTopic: "Ring Utrecht"
    // is not every paper with "ring" in a word and "utrecht"), then the same
    // words loose (tkLooseTopic). When the phrase finds fewer papers than
    // asked for, tkTopic fills the rest: only the names (tkNameTopicTerms) as
    // their words. A phrase the question holds stays one: a quoted one, and a
    // fixed word group ("open data", "medische gegevens"), whose words apart
    // found papers on other subjects ("open" in "openbaar").
    // With a document type named, the office holders are its sender or
    // addressee ("Kamerbrief van de minister over stikstof"), no topic: as a
    // required word "minister" kept most letters out. Only they left: the topic.
    const tkRoleWords = tkType ? ["minister", "ministers", "kabinet", "regering", "staatssecretaris", "bewindspersoon", "bewindspersonen", "ministerie"] : [];
    // "Kamervragen over ECLI:NL:HR:2019:2006": the ECLI whole is the topic (a
    // title holds it as "ECLI:NL:..."); its parts, "ecli" alone, found
    // Kamervragen about other rulings. So for an ECLI of the EU or another country.
    const questionEclis = [...new Set((decodedQuestion.toUpperCase().match(/ECLI:[A-Z]{2}:[A-Z0-9]{1,7}:\d{4}:[A-Z0-9.]{1,25}/g) ?? []).map((e) => e.replace(/\.+$/, "")))];
    const tkTopicTerms = questionEclis.length
      ? questionEclis
      : topicTerms(questionForSearch, [...tkRouteWords, ...contentRequestWords], [...namedRouteWords, ...tkRoleWords]);
    const tkTopic = toPhraseQuery(tkTopicTerms, nameTerms);
    const tkNamedTopic = toPhraseQuery(tkTopicTerms);
    const tkLooseTopic = tkTopicTerms.join(" ");
    const tkNameTopicTerms = tkTopicTerms.filter((term) => nameTerms.has(term));
    // In a multi-source answer Tweede Kamer gets one search, with the document
    // type the question names, and without a topic the question minus its frame.
    const tkMultiQuery = tkTopic || makeModerateQuery(questionForSearch) || questionForSearch;
    const obJournals = [...new Set(Object.entries(obJournalWords).filter(([word]) => matchesTerm(q, word)).map(([, name]) => name))];
    const obPublicatieblad = obJournals.length ? obJournals.join(", ") : undefined;
    // The topic without the route words, a phrase the question holds as a
    // phrase and a run of capitalised words as its words (the SRU search
    // ranked "klimaatakkoord parijs" as a phrase below unrelated full texts);
    // with only a journal and no topic, that journal's newest publications.
    // Without either, the keywords as before. `looseQuery`: the same words
    // without quotes, for when no publication holds the phrase.
    const obSearch = (): { query: string; looseQuery?: string; publicatieblad?: string; sort?: "date_newest"; note?: string } => {
      const terms = topicTerms(questionForSearch, obRouteWords);
      const topic = toPhraseQuery(terms, nameTerms);
      const looseQuery = terms.join(" ") !== topic ? terms.join(" ") : undefined;
      if (!obPublicatieblad) return { query: topic || makeKeywordQuery(questionForSearch) || questionForSearch, looseQuery };
      return {
        query: topic,
        looseQuery,
        publicatieblad: obPublicatieblad,
        ...(topic ? {} : { sort: "date_newest" as const }),
        note: `Gefilterd op publicatieblad '${obPublicatieblad}'${topic ? "" : ", nieuwste eerst"}.`,
      };
    };
    const tenderRouteWords = ["aanbesteding", "aanbestedingen", "tender", "tenders", "tenderned", "gunning", "gunningen", "gegund", "marktconsultatie", "offerteaanvraag", "overheidsopdracht", "overheidsopdrachten", "inkoop", "procurement", "opdrachten"];
    // The catalogue holds nothing but data, so "data" is no search term there,
    // unless it is part of a term: extractKeywords keeps "open data portaal"
    // and "data strategie" whole.
    const catalogRouteWords = ["data", "dataset", "datasets", "gegevens", "databestand", "databestanden"];
    const effectiveLimit = limit ?? top;

    const requestDebug: Array<{
      connector: string;
      request_url: string;
      request_method: string;
      response_time_ms: number;
      cache_hit: boolean | null;
      cache_ttl_remaining_s: number | null;
    }> = [];
    const fallbackSteps: string[] = [];
    type AskFailures = NonNullable<ReturnType<typeof successResponse>["failures"]>;
    // Routes that ran without an answer. The catalogue fallback names them, so
    // that "Rechtspraak failed" no longer reads as "no source recognised"; a
    // failed route is also reported in `failures` of whatever answers next.
    const triedRoutes: string[] = [];
    const routeFailures: AskFailures = [];
    // Set when the DSO route ran without answering: whichever route answers
    // says that the DSO was tried and why it did not answer.
    let dsoNote: string | undefined;
    let debatNote: string | undefined;
    let algoritmeNote: string | undefined;
    // The subsidy route: the funders it asked without an answer, named by whichever route does.
    let subsidieNote: string | undefined;
    // The law-article route: why it did not answer, named by whichever route does.
    let wetNote: string | undefined;
    // The population route: the place it did not find, named by whichever route answers.
    let populationNote: string | undefined;
    const routeEmpty = (label: string, step: string) => {
      fallbackSteps.push(step);
      triedRoutes.push(`${label} (0 resultaten)`);
    };
    const routeFailed = (label: string, connector: string, error: unknown, step = `${connector}:search_failed`) => {
      const mapped = mapSourceError(error, label);
      const refused = error instanceof BekendmakingenRefusedError;
      fallbackSteps.push(refused ? `${connector}:query_refused` : step);
      triedRoutes.push(refused ? `${label} (zoekvraag geweigerd, niet gezocht)` : `${label} (mislukt: ${mapped.error})`);
      routeFailures.push({ connector, error_type: mapped.error, message: mapped.message });
    };

    const timed = async <T>(connector: string, fn: () => Promise<T>): Promise<T> => {
      const started = Date.now();
      const out = await fn();
      const elapsed = Date.now() - started;

      const endpoint =
        out && typeof out === "object" && "endpoint" in (out as Record<string, unknown>)
          ? String((out as Record<string, unknown>).endpoint ?? "")
          : "";

      requestDebug.push({
        connector,
        request_url: endpoint,
        request_method: "GET",
        response_time_ms: elapsed,
        cache_hit: null,
        cache_ttl_remaining_s: null,
      });

      return out;
    };

    /**
     * Officiële Bekendmakingen with the query obSearch made, or the policy
     * search's. A refused query is a failure (assertBekendmakingenSearched).
     * When no publication holds a phrase of the question, the same words
     * loose (`looseQuery`), as before phrases were sent; `query` is the one
     * that answered.
     */
    const searchBekendmakingen = async (
      query: string,
      looseQuery: string | undefined,
      args: Omit<Parameters<typeof bekend.search>[0], "query">,
    ): Promise<{ out: Awaited<ReturnType<typeof bekend.search>>; query: string }> => {
      const out = await timed("officiele_bekendmakingen", () => bekend.search({ ...args, query }));
      assertBekendmakingenSearched(out);
      if (out.items.length || !looseQuery || looseQuery === query) return { out, query };
      fallbackSteps.push(`officiele_bekendmakingen:loose_words:${looseQuery}`);
      const loose = await timed("officiele_bekendmakingen", () => bekend.search({ ...args, query: looseQuery }));
      assertBekendmakingenSearched(loose);
      return { out: loose, query: looseQuery };
    };

    const buildVerbose = () => {
      if (!verbose) return undefined;
      const health: Record<string, unknown> = {};
      for (const req of requestDebug) {
        if (!health[req.connector]) {
          health[req.connector] = getConnectorHealth(req.connector);
        }
      }
      return {
        requests: requestDebug,
        fallbacks_used: fallbackSteps,
        connector_health: health,
        temporal_context: temporal?.context,
      } as Record<string, unknown>;
    };

    const askSuccess = (args: {
      summary: string;
      records: MCPRecord[];
      provenance: ReturnType<typeof prov>;
      access_note?: string;
      failures?: AskFailures;
      total?: number | null;
    }) => {
      // A source that failed in the multi-source step and again on its own
      // route is one failure.
      const failures = [...routeFailures, ...(args.failures ?? [])].filter(
        (f, i, all) => all.findIndex((g) => g.error_type === f.error_type && g.message === f.message) === i,
      );
      // The router fetches up to `top` records and pages (offset/limit) within
      // those: a later offset cannot reach the source's other hits. With the
      // source's total as pagination total, has_more promised a next page
      // that came back empty. The pagination counts the records held; the
      // source's total stays in provenance.total_results and is named here.
      const held = args.records.length;
      const sourceTotal = typeof args.total === "number" && args.total > held ? args.total : undefined;
      const pagingNote = sourceTotal === undefined
        ? undefined
        : `De bron meldt ${sourceTotal.toLocaleString("nl-NL")} treffers; nl_gov_ask haalt er ${held} op en bladert met offset/limit alleen daarbinnen. ` +
          `Voor meer: ${top < config.limits.maxRows ? `verhoog 'top' (max ${config.limits.maxRows}) of ` : ""}gebruik de zoektool van de bron.`;
      return toMcpToolPayload(
        {
          ...buildFormattedResponse({
            summary: args.summary,
            records: args.records,
            provenance: args.provenance,
            outputFormat,
            offset,
            limit: effectiveLimit,
            total: held,
            access_note: mergeAccessNotes(dsoNote, debatNote, algoritmeNote, subsidieNote, wetNote, populationNote, args.access_note, pagingNote),
            failures: failures.length ? failures : undefined,
          }),
          verbose: buildVerbose(),
        },
      );
    };

    // The term lists of the routes are in ./routes.ts. "uitspraak" and
    // "uitspraken" are rulings only when no office holder is their subject
    // (uitsprakenSense); enforcement words also occur in policy questions.
    // A Dutch ECLI is read by the ECLI route; next to Kamervragen ("Kamervragen
    // over ECLI:NL:HR:2019:2006") it asks for no rulings search. Nor does one of
    // the EU or another country, which Rechtspraak.nl does not publish.
    const caseLawAsked = hasTerm(q.replace(/ecli:[a-z]{2}:[a-z0-9]{1,7}:\d{4}:[a-z0-9.]{1,25}/g, " "), CASE_LAW_TERMS) || uitspraken === "rulings";
    const rechtspraakAsked = caseLawAsked || has(ENFORCEMENT_TERMS);

    /**
     * What a CBS table search found: a table from its catalogue, or a CBS
     * dataset from the data.overheid.nl fallback. The fallback keeps only
     * datasets CBS published (CbsSource): a search of all of data.overheid.nl
     * found a waste calendar for "hoeveel inwoners heeft nijmegen", which is
     * no CBS answer.
     */
    const cbsItems = (out: Awaited<ReturnType<typeof cbs.searchTables>>) => out.items;

    const scoreCbsTable = (item: Record<string, unknown>): number => {
      const title = String(item.Title ?? item.title ?? "").toLowerCase();
      const summary = String(item.Summary ?? item.summary ?? "").toLowerCase();
      const text = `${title} ${summary}`;
      let score = 0;
      if (q.includes("gemeente") && text.includes("gemeente")) score += 4;
      if ((q.includes("opleidingsniveau") || q.includes("onderwijsniveau")) && (text.includes("opleiding") || text.includes("onderwijs"))) score += 5;
      if ((q.includes("inwoner") || q.includes("bevolking")) && (text.includes("bevolking") || text.includes("inwoner"))) score += 4;
      if (text.includes("regio")) score += 2;
      if (text.includes("period")) score += 2;
      const terms = makeCbsQuery(questionForSearch).split(/\s+/).filter(Boolean);
      for (const t of terms) if (text.includes(t)) score += 1;
      return score;
    };

    try {
      const likelyBudget = has(BUDGET_TERMS) || ((q.includes("hoeveel geeft") || q.includes("how much does")) && q.includes("uit"));
      // Detect multi-source intent: explicit signals OR implicit (question spans 2+ domain term lists, or uses "en ... ook/daarnaast/tevens")
      const explicitMulti = /(combineer|gecombineerd|vergel(?:ijk|ijken)|verhoud|versus|\bvs\b|zowel|naast|cross\s*source|multi\s*source)/i.test(decodedQuestion);
      const implicitMulti = /\b(?:en\s+(?:is\s+(?:er|daar)|zijn\s+er|ook|tevens|daarnaast|verder)|maar\s+ook|alsook|alsmede)\b/i.test(decodedQuestion);

      const plannerCandidates: Array<"cbs" | "tk" | "ob" | "rijk" | "budget" | "duo" | "api" | "rechtspraak"> = [];
      if (has(CBS_TERMS)) plannerCandidates.push("cbs");
      if (has(TK_TERMS)) plannerCandidates.push("tk");
      if (has(OB_TERMS)) plannerCandidates.push("ob");
      const rijkAsked = has(RIJK_TERMS) || (has(RIJK_OFFICE_TERMS) && !rechtspraakAsked);
      // "Kamerbrief van de minister over stikstof", "Kamervragen aan de
      // staatssecretaris", "Motie over de staatssecretaris", "Brief van de
      // staatssecretaris aan de Tweede Kamer": with a Tweede Kamer paper named,
      // an office holder after "van"/"aan"/"over" is its sender, addressee or
      // subject, no second source. "... en wat zegt de minister?" still asks Rijksoverheid.
      const qWithoutPaperParties = tkType || TK_LETTER_RE.test(q) ? q.replace(TK_PAPER_PARTY_RE, " ") : q;
      if (rijkAsked && hasTerm(qWithoutPaperParties, [...RIJK_TERMS, ...RIJK_OFFICE_TERMS])) plannerCandidates.push("rijk");
      if (likelyBudget) plannerCandidates.push("budget");
      if (has(DUO_TERMS)) plannerCandidates.push("duo");
      if (has(API_TERMS)) plannerCandidates.push("api");
      if (rechtspraakAsked) plannerCandidates.push("rechtspraak");

      const uniquePlannerCandidates = Array.from(new Set(plannerCandidates));
      const multiIntentSignal = explicitMulti || implicitMulti || uniquePlannerCandidates.length >= 2;
      // EU legislation goes first: "Verordening (EU) 2016/679" would otherwise hit OB_TERMS.
      const euIntent = detectEuIntent(decodedQuestion);
      // Omgevingswet documents (an omgevingsplan, -visie or -verordening, the
      // rules at an address, ontwerpen ter inzage) are in the DSO; see
      // detectDsoIntent. Only with a DSO key: without one such a question takes
      // the routes it took before.
      const dsoKey = process.env[ENV_KEYS.DSO_API_KEY]?.trim();
      const dsoIntent = dsoKey && !euIntent ? detectDsoIntent(decodedQuestion) : undefined;
      // What was said in a Tweede Kamer debate is in the verslagen; see detectDebatIntent.
      const debatIntent = !euIntent && !dsoIntent ? detectDebatIntent(decodedQuestion) : undefined;
      const debatArgs = debatIntent ? { ...debatIntent, date_from: temporal?.from, date_to: temporal?.to } : undefined;
      // The algorithms a government body uses are in the Algoritmeregister; see detectAlgoritmeIntent.
      const algoritmeIntent = !euIntent && !dsoIntent && !debatArgs ? detectAlgoritmeIntent(decodedQuestion) : undefined;
      // A ruling named by its ECLI is read, not searched (the search took the ECLI apart into words).
      const ecliIntent = detectEcliIntent(decodedQuestion);
      // Only rulings of other countries or the EU: not on Rechtspraak.nl, and never searched there as words.
      const foreignEclis = detectForeignEcliIntent(decodedQuestion);
      // An artikel of a named national law: its text in the BWB (wetten_bwb_tekst).
      // A relative day ("vorig jaar", "gisteren") is the period's first day: the
      // text as it read then. Not a bare year, which is the law's name or read
      // above ("in 2015"), nor a day the question already names.
      const wetIntent = (() => {
        const intent = detectWetArtikelIntent(decodedQuestion);
        const words = temporal ? WET_RELATIVE_PATTERNS[temporal.matchedPattern] : undefined;
        if (!intent || intent.peildatum || intent.peildatumOngeldig || !temporal || !words) return intent;
        return { ...intent, peildatum: temporal.from, peildatumBron: words };
      })();
      // The Algemene Rekenkamer, the SCP or the WODC named with a topic: their publications.
      const researchIntent = detectResearchOrgIntent(decodedQuestion);
      // Which subsidies or funding calls exist or are open: RVO, NWO/ZonMw or the EU portal; see detectSubsidieIntent.
      // Today where the question is asked, for a month in a deadline question ("sluiten in november").
      const askToday = (() => {
        const ref = reference_now ? new Date(reference_now) : new Date();
        const at = Number.isNaN(ref.getTime()) ? new Date() : ref;
        try {
          return new Intl.DateTimeFormat("en-CA", { timeZone: timezone ?? config.temporal.defaultTimeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
        } catch {
          return at.toISOString().slice(0, 10);
        }
      })();
      // "Erasmus+", "DEI+", "ESF+": in a question with spaces a plus belongs to a name and is no
      // form-encoded space, so the subsidy detection reads it as written (decodedQuestion has none).
      const subsidieQuestion = /\s/.test(question.trim())
        ? (() => {
            try { return decodeURIComponent(question); } catch { return question; }
          })()
        : decodedQuestion;
      const subsidieIntent = !euIntent && !dsoIntent && !debatArgs && !algoritmeIntent && !researchIntent ? detectSubsidieIntent(subsidieQuestion, askToday) : undefined;
      // The arguments each funder gets, the same for dryRun and execution. A deadline
      // question with a month or period ("die sluiten in november") limits the EU deadlines to it.
      const subsidieWindow = (intent: SubsidieIntent) =>
        intent.deadlineWindow ?? (intent.deadline && temporal ? { from: temporal.from, to: temporal.to, phrase: temporal.matchedPattern } : undefined);
      const subsidieEuArgs = (intent: SubsidieIntent): EuFundingSearchArgs => {
        const window = subsidieWindow(intent);
        return {
          query: intent.euQuery || undefined,
          // Calls for organisations that apply themselves; EuropeAid calls are for non-EU countries.
          type: ["grant", "cascade_funding"],
          programme: intent.euProgramme,
          ...(intent.soonOnly ? { status: ["forthcoming" as const] } : {}),
          ...(window ? { deadlineFrom: window.from, deadlineTo: window.to } : {}),
          offset: 0,
          limit: clampEuFundingRows(top),
        };
      };
      const subsidieRvoArgs = (intent: SubsidieIntent, withStatus = true): RvoSubsidiesSearchArgs => ({
        query: rvoStems(intent.query) || undefined,
        doelgroep: intent.doelgroep,
        land: intent.land,
        ...(withStatus && (intent.openOnly || intent.soonOnly) ? { status: intent.soonOnly ? ["bijna_open" as const] : ["open" as const, "bijna_open" as const] } : {}),
        include_status: true,
        offset: 0,
        limit: Math.min(top, RVO_MAX_ROWS),
      });
      const subsidieCallsArgs = (intent: SubsidieIntent): OnderzoekscallsSearchArgs => ({
        organisatie: intent.organisatie ?? "alle",
        query: intent.query || undefined,
        status: intent.soonOnly ? "binnenkort" : "actueel",
        offset: 0,
        limit: clampOnderzoekscallRows(top),
      });
      // "Hoeveel inwoners heeft Nijmegen?": the CBS population table for that municipality.
      const populationPlace = extractPopulationPlace(decodedQuestion);
      // The year it asks for, also one the period parser does not read ("in 1800").
      const populationYear = populationPlace
        ? extractPopulationYear(decodedQuestion) ?? (temporal ? Number(temporal.from.slice(0, 4)) : undefined)
        : undefined;
      // EUR-Lex looks up a document number ("2016/679") itself, which the
      // keyword extractor would split into "2016 679": a bare number goes
      // through as is, and other slashed tokens stay whole.
      const euSearchQuery = euIntent?.kind !== "search"
        ? ""
        : parseDocumentNumber(euIntent.query)
          ? euIntent.query
          : rewriteKeepingSyntax(euIntent.query, (text) => ({ original: text, rewritten: makeKeywordQuery(text), changed: true })).rewritten || euIntent.query;
      // Organisation/policy questions go to ORI, official publications,
      // parliament and government news instead of the dataset catalogue.
      const detectedPolicyIntent = detectPolicyIntent(decodedQuestion);
      // Not for a question a more specific route answers: case law
      // (Rechtspraak, also for "Uitspraken van de Raad van State" or "Beroep
      // tegen een besluit van de gemeente") and the API register ("Welke API
      // heeft de overheid voor adressen?"). Those routes run after the policy
      // routes, so without this guard they never saw such questions.
      const caseLawIntent = caseLawAsked || (has(ENFORCEMENT_TERMS) && detectedPolicyIntent?.strength !== "strong");
      const apiIntent = has(API_TERMS.filter((t) => /\bapi\b/.test(t)));
      const policyIntent = detectedPolicyIntent && !caseLawIntent && !apiIntent ? detectedPolicyIntent : undefined;
      // Strong signals (policy word, activity, council) search documents before
      // the national routes; a bare organisation noun ("uitgaven van de
      // overheid aan defensie") or a budget question first gets the route its
      // words picked, and documents only when that route has nothing.
      const policyEarly = policyIntent?.strength === "strong" && !likelyBudget;
      const policyExclusions = [...MUNICIPAL_SCOPE_WORDS, ...ORGANISATION_WORDS, ...obRouteWords];
      const policyTerms = policyIntent ? topicTerms(questionForSearch, policyExclusions) : [];
      // Open Raadsinformatie searched across all councils: council papers keep
      // their own words ("moties"), and a named municipality goes as a phrase
      // (oriPlacePhrase), not as a loose word every hit must contain.
      const policyOriQuery = (() => {
        if (!policyIntent) return "";
        const terms = topicTerms(questionForSearch, policyExclusions, namedNationalRouteWords);
        const place = policyIntent.gemeente;
        if (!place) return toOriQuery(terms);
        const withoutPlace = topicTerms(questionForSearch, [...policyExclusions, place], namedNationalRouteWords);
        // The place is no term of the question (a name the keywords split up): as before.
        if (withoutPlace.length === terms.length) return toOriQuery(terms);
        return [toOriQuery(withoutPlace), oriPlacePhrase(place)].filter(Boolean).join(" ");
      })();
      // A question that names a national publication or parliament explicitly
      // ("Verordening parkeren gemeente Utrecht" is in the gemeenteblad) is not
      // handed to the municipality's council records first.
      const namesNationalSource = has(OB_TERMS) || /\b(?:tweede kamer|eerste kamer|kamerstuk(?:ken)?|kamervra(?:ag|gen)|kamerlid|kamerleden|provinciaal blad)\b/.test(q);
      const gemeenteForOri = policyIntent?.gemeente && !namesNationalSource ? policyIntent.gemeente : undefined;
      const gemeenteTerms = gemeenteForOri
        ? // "de raad van Amsterdam": within Amsterdam's council records "raad" is in every document.
          topicTerms(questionForSearch, [...MUNICIPAL_SCOPE_WORDS, ...ORGANISATION_WORDS, "raad", "college", gemeenteForOri, ...contentRequestWords], namedNationalRouteWords)
        : [];

      // The routes this question takes, in the order below (./routes.ts): a
      // route runs only when the chain holds it, and dryRun plans the first.
      const routeFacts: RouteFacts = {
        q,
        place: extractPlaceName(decodedQuestion),
        eu: Boolean(euIntent),
        dso: Boolean(dsoIntent && dsoKey),
        ecli: Boolean(ecliIntent),
        foreignEcli: Boolean(foreignEclis),
        wetArtikel: Boolean(wetIntent),
        research: researchIntent?.org,
        subsidies: subsidieIntent?.sources,
        debat: Boolean(debatArgs),
        algoritme: Boolean(algoritmeIntent),
        multi: multiIntentSignal && uniquePlannerCandidates.length >= 2,
        // As the multi-source route runs them: the API register only with its key.
        multiSources: uniquePlannerCandidates.filter((c) => c !== "api" || Boolean(process.env[ENV_KEYS.OVERHEID_API_KEY])),
        budget: likelyBudget,
        rechtspraak: rechtspraakAsked,
        rijk: rijkAsked,
        oriGemeente: Boolean(gemeenteForOri) && gemeenteTerms.length > 0,
        policy: policyIntent && policyTerms.length ? (policyEarly ? "early" : "late") : undefined,
        policyMunicipal: Boolean(policyIntent?.municipal),
      };
      const routes = new Set(routeChain(routeFacts));
      // The KNMI route reads the newest files with its key, and answers that it needs one without.
      const knmiKey = process.env[ENV_KEYS.KNMI_API_KEY]?.trim();
      const knmiKind: KnmiKind = /\b(?:waarschuwing\w*|weeralarm|code\s+(?:geel|oranje|rood)|warnings?)\b/.test(q)
        ? "warnings"
        : /\b(?:aardbeving\w*|seismolog\w*|earthquakes?)\b/.test(q)
          ? "earthquakes"
          : "observations";
      const takes = (id: RouteId): boolean => routes.has(id);

      if (dryRun) {
        const endpointByCandidate: Record<string, string> = {
          cbs: config.endpoints.cbsV4,
          tk: config.endpoints.tweedeKamer,
          ob: config.endpoints.bekendmakingenSru,
          rijk: config.endpoints.rijksoverheid,
          budget: config.endpoints.rijksbegroting,
          duo: config.endpoints.duoDatasets,
          api: config.endpoints.apiRegister,
          rechtspraak: "https://uitspraken.rechtspraak.nl/api/zoek",
          eu_cellar: "https://publications.europa.eu/webapi/rdf/sparql",
          ori: "https://api.openraadsinformatie.nl/v1/elastic/_search",
          tenderned: "https://www.tenderned.nl/papi/tenderned-rs-tns/v2",
          tuchtrecht: config.endpoints.bekendmakingenSru,
          samenwerkende_catalogi: config.endpoints.bekendmakingenSru,
        };

        // The first route the handler below takes: the one that answers when
        // it finds something. When it finds nothing, the next route of the
        // chain gets the question, down to the data.overheid.nl catalogue.
        const first = firstRoute(routeFacts);
        const estimatedSources = first.sources;
        // ORI for a named municipality and the policy search send the topic
        // words of the document search.
        const plannedPolicy = first.id === "ori_gemeente" || first.id === "policy_early" || first.id === "policy";
        const multiPlanned = first.id === "multi";

        const policyQueryFor = (candidate: string): string =>
          candidate === "ori"
            ? gemeenteTerms.length ? toOriQuery(gemeenteTerms) : policyOriQuery
            : candidate === "rijk"
              ? policyTerms.join(" ")
              : toPhraseQuery(policyTerms, nameTerms);

        // The first query each route below sends, made with the same helper:
        // CBS keeps the moderate rewrite, Rechtspraak the strict one, Tweede
        // Kamer searches the topic without its route words and filters on the
        // document type the question names.
        // The document type the question names: on its own route and in the multi-source one.
        const tkPlannedType = tkType;
        const obPlanned = obSearch();
        const routeQueryFor = (candidate: string): string => {
          switch (candidate) {
            case "data_overheid":
              return makeKeywordQuery(questionForSearch, catalogRouteWords);
            case "cbs":
              return makeCbsQuery(questionForSearch);
            case "tk":
              return multiPlanned
                ? tkMultiQuery
                : tkNamedTopic || (tkType ? "" : makeModerateQuery(questionForSearch));
            case "rechtspraak":
              return makeRechtspraakQuery(questionForSearch);
            case "ob":
              return obPlanned.query;
            case "eu_cellar":
              return euIntent?.kind === "search" ? euSearchQuery : (euIntent?.celex ?? "");
            case "tenderned":
              return makeKeywordQuery(questionForSearch, tenderRouteWords) || questionForSearch;
            case "tuchtrecht":
            case "samenwerkende_catalogi":
              return makeStrictQuery(questionForSearch) || questionForSearch;
            default:
              return makeKeywordQuery(questionForSearch);
          }
        };

        type PlannedRequest = { connector: string; method: string; url: string; params: Record<string, unknown> };
        const defined = (params: Record<string, unknown>) => Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
        // Routes with their own request: an intent's parameters, or a place,
        // an election or a school sector read from the question.
        const specificRequests = (candidate: string): PlannedRequest[] | undefined => {
          if (candidate === "dso_omgevingsdocumenten" && dsoIntent) return dsoPlannedRequests(dsoIntent, decodedQuestion, top);
          if (candidate === "tweede_kamer_debatten" && debatArgs) {
            return [{
              connector: "tweede_kamer",
              method: "GET",
              url: `${config.endpoints.tweedeKamer}/Vergadering`,
              params: { ...defined(debatArgs), question: decodedQuestion, top },
            }];
          }
          if (candidate === "rechtspraak_uitspraak" && ecliIntent) {
            return ecliIntent.eclis.map((ecli) => ({
              connector: "rechtspraak",
              method: "GET",
              url: "https://data.rechtspraak.nl/uitspraken/content",
              params: { id: ecli, onderdeel: "overzicht", max_chars: uitspraakChars(ecliIntent.eclis.length), question: decodedQuestion },
            }));
          }
          if (candidate === "wetten_bwb" && wetIntent) {
            return [{
              connector: "wetten_bwb",
              method: "GET",
              url: "https://zoekservice.overheid.nl/sru/Search",
              params: defined({ wet: wetIntent.wet, artikel: wetIntent.artikel, zoekterm: wetIntent.zoekterm, peildatum: wetIntent.peildatum, question: decodedQuestion }),
            }];
          }
          if ((candidate === "rekenkamer" || candidate === "scp") && researchIntent) {
            return [{
              connector: candidate,
              method: "GET",
              url: rijksoverheid.publicationsRequestUrl({ site: candidate, query: researchIntent.query, date_from: temporal?.from, date_to: temporal?.to }),
              params: defined({ query: researchIntent.query, question: decodedQuestion, top, date_from: temporal?.from, date_to: temporal?.to }),
            }];
          }
          if (candidate === "wodc" && researchIntent) {
            return [{
              connector: "wodc",
              method: "GET",
              url: WODC_SEARCH_ENDPOINT,
              params: defined({ query: researchIntent.query || undefined, question: decodedQuestion, top: clampWodcRows(top), date_from: temporal?.from, date_to: temporal?.to }),
            }];
          }
          if (candidate === "cbs" && first.id === "cbs" && populationPlace) {
            return [{
              connector: "cbs",
              method: "GET",
              url: `${config.endpoints.cbsV3}/${CBS_POPULATION_TABLE}/TypedDataSet`,
              params: defined({ gemeente: populationPlace, jaar: populationYear, question: decodedQuestion, top }),
            }];
          }
          if (candidate === "algoritmeregister" && algoritmeIntent) {
            return [{
              connector: "algoritmeregister",
              method: "POST",
              url: ALGORITMEREGISTER_SEARCH_ENDPOINT,
              params: { ...algoritmeIntent, question: decodedQuestion, limit: top },
            }];
          }
          if (candidate === "eu_funding" && subsidieIntent) {
            // A multipart POST to the portal's search API; a named call is looked up by its id.
            let params: Record<string, unknown>;
            try {
              params = subsidieIntent.euId ? { id: subsidieIntent.euId } : euFundingParams(buildEuFundingRequest(subsidieEuArgs(subsidieIntent)));
            } catch {
              params = defined({ query: subsidieIntent.euQuery || undefined, programme: subsidieIntent.euProgramme });
            }
            return [{ connector: "eu_funding", method: "POST", url: EU_FUNDING_SEARCH_ENDPOINT, params: { ...params, question: decodedQuestion } }];
          }
          if (candidate === "rvo_subsidies" && subsidieIntent) {
            const args = subsidieRvoArgs(subsidieIntent);
            return [{
              connector: "rvo_subsidies",
              method: "GET",
              url: RVO_SUBSIDIES_ENDPOINT,
              params: defined({ page: "0,1,2,... (whole catalogue, kept 3 h)", query: args.query, doelgroep: args.doelgroep, land: args.land, status: args.status?.join(","), include_status: true, question: decodedQuestion, top: args.limit }),
            }];
          }
          if (candidate === "nl_onderzoekscalls" && subsidieIntent) {
            return onderzoekscalls.planSearch(subsidieCallsArgs(subsidieIntent)).map((r) => ({ connector: r.connector, method: "GET", url: r.url, params: { ...r.params, question: decodedQuestion } }));
          }
          if (first.id === "schoolvakanties") {
            const year = decodedQuestion.match(/\b(20\d{2})\b/)?.[1];
            return [{
              connector: candidate,
              method: "GET",
              url: `${config.endpoints.rijksoverheid}/infotypes/schoolholidays`,
              params: defined({ year: year ? Number(year) : undefined, region: q.match(/\b(noord|midden|zuid)\b/)?.[1], question: decodedQuestion }),
            }];
          }
          if (first.id === "verkiezingen") {
            return [{
              connector: "verkiezingsuitslagen",
              method: "GET",
              url: "https://www.verkiezingsuitslagen.nl",
              params: defined({ verkiezing: extractVerkiezingHint(q), gebied: routeFacts.place, question: decodedQuestion, top }),
            }];
          }
          if (first.id === "gewaspercelen") {
            return [{
              connector: "brp_gewaspercelen",
              method: "GET",
              url: "https://service.pdok.nl/rvo/brpgewaspercelen/wfs/v1_0",
              params: defined({ gemeente: routeFacts.place, question: decodedQuestion, top }),
            }];
          }
          if (first.id === "luchtmeetnet") {
            return [{
              connector: "luchtmeetnet",
              method: "GET",
              url: "https://api.luchtmeetnet.nl/open_api/measurements",
              params: defined({ plaats: routeFacts.place, component: extractLuchtComponent(q), question: decodedQuestion, top }),
            }];
          }
          if (first.id === "duo_scholen") {
            // Exam results first when the question asks for them, else the schools.
            const exam = has(EXAM_TERMS);
            return [{
              connector: "duo",
              method: "GET",
              url: config.endpoints.duoDatasets,
              params: defined({ kind: exam ? "examenresultaten" : "onderwijsvestigingen", gemeente: routeFacts.place, sector: exam ? undefined : duoSector(q), question: decodedQuestion, top }),
            }];
          }
          // Without its key the KNMI route answers that it needs one, without a request.
          if (first.id === "knmi") {
            if (!knmiKey) return [];
            const dataset = KNMI_KINDS[knmiKind].dataset;
            return [{
              connector: "knmi",
              method: "GET",
              url: `${config.endpoints.knmi}/datasets/${dataset.name}/versions/${dataset.version}/files`,
              params: { maxKeys: top, orderBy: "created", sorting: "desc", kind: knmiKind, question: decodedQuestion },
            }];
          }
          return undefined;
        };

        const plannedRequests = estimatedSources.flatMap<PlannedRequest>((candidate) => specificRequests(candidate) ?? [{
          connector: candidate,
          method: "GET",
          url: endpointByCandidate[candidate] ?? config.endpoints.dataOverheid,
          params: {
            // The terms the routes derive from the question, not the sentence itself.
            query: plannedPolicy && candidate !== "data_overheid" ? policyQueryFor(candidate) : routeQueryFor(candidate),
            question: decodedQuestion,
            ...(candidate === "tk" && !plannedPolicy && tkPlannedType ? { type: tkPlannedType } : {}),
            ...(candidate === "ob" && !plannedPolicy && obPlanned.publicatieblad ? { publicatieblad: obPlanned.publicatieblad, ...(obPlanned.sort ? { sort: obPlanned.sort } : {}) } : {}),
            ...(plannedPolicy && candidate === "ori" && gemeenteTerms.length ? { gemeente: gemeenteForOri } : {}),
            top,
            ...(temporal ? { date_from: temporal.from, date_to: temporal.to } : {}),
          },
        }]);

        const cacheStatus = estimatedSources.map((candidate) => ({
          connector: candidate,
          cache_policy: "hardcoded-ttl",
        }));

        const dryRunPayload = {
          dry_run: true,
          planned_requests: plannedRequests,
          estimated_sources: estimatedSources,
          cache_status: cacheStatus,
          ...(temporal
            ? {
                temporal: {
                  from: temporal.from,
                  to: temporal.to,
                  matched_pattern: temporal.matchedPattern,
                  reference_now: temporal.context.referenceNow,
                  time_zone: temporal.context.timeZone,
                  today: temporal.context.today,
                },
              }
            : {}),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(dryRunPayload, null, 2) }],
          structuredContent: dryRunPayload,
        };
      }

      if (takes("eu_cellar") && euIntent) try {
        if (euIntent.kind === "search") {
          const euQuery = euSearchQuery;
          const out = await timed("eu_cellar", () => euCellar.search({ query: euQuery, limit: top }));
          const records = out.items.map((x) => record("eu-cellar", String(x.title ?? x.celex ?? "EU-handeling"), String(x.eurlex_url ?? "https://eur-lex.europa.eu"), x, String(x.document_type_label ?? ""), String(x.date ?? "")));
          if (records.length) {
            return askSuccess({ summary: `Router: EUR-Lex (${records.length} EU-handelingen)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: mergeAccessNotes(queryNote(euQuery), out.access_note), total: out.total });
          }
        } else if (euIntent.kind === "transposition") {
          const out = await timed("eu_cellar", () => euCellar.nlTransposition({ id: euIntent.celex, limit: top }));
          const records = out.items.map((x) => record("eu-cellar", String(x.title ?? x.identifier ?? "Omzettingsmaatregel"), String(x.canonical_url ?? `https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=CELEX:${euIntent.celex}`), x, [x.measure_type, x.official_journal].filter(Boolean).join(" — "), String(x.publication_date ?? "")));
          if (records.length) {
            return askSuccess({ summary: `Router: EUR-Lex NL-omzetting ${euIntent.celex} (${records.length} maatregelen)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: out.access_note, total: out.total });
          }
        } else {
          const out = await timed("eu_cellar", () => euCellar.document({ id: euIntent.celex }));
          const records = out.items.map((x) => record("eu-cellar", String(x.title ?? x.celex ?? "EU-handeling"), String(x.eurlex_url ?? "https://eur-lex.europa.eu"), x, String(x.document_type_label ?? ""), String(x.date ?? "")));
          if (records.length) {
            return askSuccess({ summary: `Router: EUR-Lex ${euIntent.celex}`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: out.access_note, total: out.total });
          }
        }
        routeEmpty("EUR-Lex", `eu_cellar:${euIntent.kind}:no_results`);
      } catch (e) {
        routeFailed("EUR-Lex", "eu_cellar", e, `eu_cellar:${euIntent.kind}:failed`);
      }

      if (takes("dso") && dsoIntent && dsoKey) {
        const dsoLabel = "DSO Omgevingsdocumenten";
        const derived = Object.entries(dsoPlannedRequests(dsoIntent, decodedQuestion, top)[0].params)
          .filter(([key]) => !["question", "top", "rows", "soort"].includes(key))
          .map(([key, value]) => `${key} '${String(value)}'`)
          .join(", ");
        // The DSO did not answer: the other routes get the question, and their
        // answer says that the DSO was tried and why it did not answer.
        const dsoNotAnswered = (step: string, why: string, failure?: AskFailures[number]) => {
          fallbackSteps.push(step);
          if (failure) routeFailures.push(failure);
          dsoNote = `${dsoLabel} eerst geprobeerd${derived ? ` (${derived})` : ""}: ${why}. Dit antwoord komt van de andere routes van nl_gov_ask.`;
        };
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const source = new DsoOmgevingsdocumentenSource(config, dsoKey);
          const search = timed("dso_omgevingsdocumenten", () => source.search({ ...dsoIntent, rows: dsoRows(dsoIntent, top) }));
          const deadline = new Promise<"deadline">((resolve) => {
            deadlineTimer = setTimeout(() => resolve("deadline"), DSO_ROUTE_DEADLINE_MS);
          });
          const out = await Promise.race([search, deadline]);
          if (out === "deadline") {
            // The search runs on in the background and fills the catalogue cache for the next question.
            search.catch(() => undefined);
            const seconds = Math.round(DSO_ROUTE_DEADLINE_MS / 1000);
            dsoNotAnswered("dso_omgevingsdocumenten:timeout", `geen antwoord binnen ${seconds} s, niet op gewacht`, {
              connector: "dso_omgevingsdocumenten",
              error_type: "timeout",
              message: `${dsoLabel} gaf binnen ${seconds} s geen antwoord; niet op gewacht.`,
            });
          } else {
            const ordered = out.locatie ? dsoLayerFirstPage(out.items, effectiveLimit) : out.items;
            const records = ordered.map(dsoRecord);
            // A question that named its scope or asked for ontwerpen gets the
            // DSO's answer, also when that is nothing; only a bare document
            // type over the whole country falls through to the other routes.
            const specific = Boolean(out.locatie || out.bevoegdGezag || dsoIntent.provincie || dsoIntent.soort === "ontwerpregelingen" || dsoIntent.alleenTerInzage);
            if (records.length || specific) {
              const ontwerp = dsoIntent.soort === "ontwerpregelingen" || Boolean(dsoIntent.alleenTerInzage);
              const typePlural: Record<string, string> = { gemeente: "gemeenten", provincie: "provincies", waterschap: "waterschappen", ministerie: "ministeries" };
              const scope = out.locatie
                ? out.locatie.weergavenaam
                : dsoIntent.provincie
                  ? `gebied provincie ${dsoIntent.provincie} (provincie en gemeenten)`
                  : out.bevoegdGezag
                    ? (out.bevoegdGezag.naam ?? out.bevoegdGezag.code)
                    : dsoIntent.typeBevoegdGezag
                      ? `alle ${typePlural[dsoIntent.typeBevoegdGezag] ?? dsoIntent.typeBevoegdGezag}`
                      : "heel Nederland";
              // An ontwerp without an inzagetermijn in the DSO is only possibly ter inzage: counted apart.
              const confirmed = out.items.filter((x) => x.terInzage === true).length;
              const possibly = dsoIntent.alleenTerInzage ? out.items.filter((x) => x.terInzage !== true && x.mogelijkTerInzage).length : 0;
              const counted = possibly
                ? `${confirmed} ${confirmed === 1 ? "ontwerp" : "ontwerpen"} ter inzage, ${possibly} mogelijk ter inzage`
                : ontwerp
                  ? `${records.length} ${records.length === 1 ? "ontwerp" : "ontwerpen"}${dsoIntent.alleenTerInzage ? " ter inzage" : ""}`
                  : `${records.length} ${records.length === 1 ? "document" : "documenten"}`;
              const emptyNote = records.length
                ? undefined
                : dsoIntent.alleenTerInzage
                  ? "Geen ontwerp waarvan de in het DSO geregistreerde inzagetermijn vandaag loopt. Niet elk ontwerp heeft zijn inzagetermijn in het DSO: de kennisgeving staat in het Gemeenteblad, Provinciaal blad of Waterschapsblad (officiele_bekendmakingen_search), net als ontwerpbesluiten buiten het DSO, zoals die voor een omgevingsvergunning. De recentste ontwerpen: dso_omgevingsdocumenten_search met soort 'ontwerpregelingen', zonder alleen_ter_inzage."
                  : `Het DSO heeft voor deze zoekvraag geen ${ontwerp ? "ontwerpen" : "documenten"}. Besluiten van vóór de Omgevingswet en documenten buiten het DSO staan in de officiële bekendmakingen (officiele_bekendmakingen_search).`;
              const layerNote = out.locatie && out.items.length ? dsoLayerNote(out.items, effectiveLimit) : undefined;
              const used = [dsoIntent.locatie, dsoIntent.bevoegdGezag, dsoIntent.provincie, out.bevoegdGezag?.naam].filter((x): x is string => Boolean(x));
              const topics = records.length ? dsoTopicWords(decodedQuestion, used) : [];
              const topicNote = topics.length
                ? `Onderwerp '${topics.join(" ")}' is niet in de documenten doorzocht: het DSO zoekt op titel en metadata. Zoek in de regeltekst met dso_omgevingsdocument_tekst (identificatie, zoekterm '${topics[0]}'; een kortere stam vindt ook samenstellingen).`
                : undefined;
              // A year that is part of a title ("Omgevingsvisie Amsterdam 2050") asks for no period.
              const periodAsked = temporal && (temporal.matchedPattern !== "bare_year" || DSO_PERIOD_YEAR_RE.test(decodedQuestion));
              const periodNote = periodAsked && !dsoIntent.geldigOp
                ? `De periode uit de vraag (${temporal.from} t/m ${temporal.to}) is niet toegepast: dit zijn de ${ontwerp ? "ontwerpen die nu bekend zijn" : "documenten die vandaag gelden"}.${ontwerp ? "" : " Voor een andere dag: noem die dag ('gelden op 1 januari 2025') of gebruik dso_omgevingsdocumenten_search met geldigOp (JJJJ-MM-DD)."}`
                : undefined;
              return askSuccess({
                summary: `Router: DSO Omgevingsdocumenten — ${scope} (${counted})`,
                records,
                provenance: prov("nl_gov_ask", out.endpoint, out.query, records.length, out.total),
                access_note: mergeAccessNotes(
                  `Vraag over omgevingsdocumenten onder de Omgevingswet: gezocht in het DSO${derived ? ` (${derived})` : ""}.`,
                  emptyNote,
                  layerNote,
                  topicNote,
                  periodNote,
                  dsoRouterNote(out.access_note, out.bevoegdGezag?.naam),
                ),
                total: out.total,
              });
            }
            dsoNotAnswered("dso_omgevingsdocumenten:no_results", "0 documenten");
          }
        } catch (e) {
          if (e instanceof DsoInputError) {
            // A name or address the DSO does not know: the other routes still get the question.
            dsoNotAnswered("dso_omgevingsdocumenten:input_not_resolved", `${e.message} ${e.suggestion}`.trim().replace(/\.$/, ""));
          } else {
            // A failure of the PDOK Locatieserver, which finds the address, is PDOK's, not the DSO's.
            const locatieserver = e instanceof SourceRequestError && /^https:\/\/api\.pdok\.nl\//.test(e.endpoint);
            const mapped = mapSourceError(e, locatieserver ? "PDOK Locatieserver (locatie voor het DSO)" : dsoLabel);
            dsoNotAnswered("dso_omgevingsdocumenten:search_failed", `mislukt (${mapped.error}: ${mapped.message.replace(/\.$/, "")})`, {
              connector: "dso_omgevingsdocumenten",
              error_type: mapped.error,
              message: mapped.message,
            });
          }
        } finally {
          clearTimeout(deadlineTimer);
        }
      }

      if (takes("uitspraak") && ecliIntent) {
        // Each ruling as rechtspraak_uitspraak_get reads it: metadata,
        // inhoudsindicatie, inhoudsopgave and the beslissing.
        const maxChars = uitspraakChars(ecliIntent.eclis.length);
        const results = await Promise.all(ecliIntent.eclis.map(async (ecli) => {
          const started = Date.now();
          const out = await uitspraakResult({ ecli, onderdeel: "overzicht", max_chars: maxChars });
          requestDebug.push({ connector: "rechtspraak", request_url: "provenance" in out ? out.provenance.endpoint : "", request_method: "GET", response_time_ms: Date.now() - started, cache_hit: null, cache_ttl_remaining_s: null });
          return { ecli, out };
        }));
        const records: MCPRecord[] = [];
        const notes: string[] = [];
        const failures: AskFailures = [];
        let endpoint = "https://data.rechtspraak.nl/uitspraken/content";
        for (const { ecli, out } of results) {
          if ("error" in out) {
            failures.push({ connector: "rechtspraak", error_type: out.error, message: `${ecli}: ${out.message}` });
            continue;
          }
          endpoint = out.provenance.endpoint;
          records.push(...out.records);
          const said = [out.records.length ? undefined : out.summary, out.access_note].filter(Boolean).join(": ");
          if (said) notes.push(ecliIntent.eclis.length > 1 ? `${ecli}: ${said}` : said);
        }
        const read = results.length - failures.length;
        if (!read) {
          // Every ruling failed: an explicit error, not a search with the ECLI taken apart.
          return toMcpToolPayload(errorResponse({
            error: failures[0].error_type,
            message: `Rechtspraak.nl gaf de genoemde ${failures.length === 1 ? "uitspraak" : "uitspraken"} niet: ${failures.map((f) => f.message).join("; ")}`,
            suggestion: "Probeer het later opnieuw, of lees de uitspraak met rechtspraak_uitspraak_get.",
            details: { failures, route: "nl_gov_ask" },
          }));
        }
        const single = ecliIntent.eclis.length === 1 ? results[0].out : undefined;
        const summary = single && "summary" in single
          ? `Router: Rechtspraak uitspraak — ${single.summary}`
          : `Router: Rechtspraak — ${ecliIntent.eclis.length} uitspraken op ECLI gelezen (${records.length} gevonden)`;
        return askSuccess({
          summary,
          records,
          provenance: prov("nl_gov_ask", endpoint, { ecli: ecliIntent.eclis.join(","), onderdeel: "overzicht", max_chars: String(maxChars) }, records.length, records.length),
          access_note: mergeAccessNotes(
            `De vraag noemt ${ecliIntent.eclis.length === 1 ? "een uitspraak" : "uitspraken"} bij ECLI: ${ecliIntent.eclis.length === 1 ? "die is" : "die zijn"} zelf gelezen (zoals rechtspraak_uitspraak_get met onderdeel 'overzicht': metadata, inhoudsindicatie, inhoudsopgave en beslissing${ecliIntent.eclis.length > 1 ? `, tekst tot ${maxChars} tekens per uitspraak` : ""}). De overwegingen, de volledige tekst of een zoekterm in de tekst: rechtspraak_uitspraak_get.`,
            ecliIntent.skipped.length ? `Niet gelezen (meer dan ${ecliIntent.eclis.length} ECLI's in de vraag): ${ecliIntent.skipped.join(", ")}.` : undefined,
            ecliIntent.foreign.length ? `${ecliIntent.foreign.join(", ")} ${ecliIntent.foreign.length === 1 ? "is geen Nederlandse ECLI" : "zijn geen Nederlandse ECLI's"}: Rechtspraak.nl publiceert alleen ECLI:NL.` : undefined,
            ecliIntent.citations
              ? `De vraag vraagt naar wat ernaar verwijst: dit is de genoemde uitspraak zelf, niet de uitspraken of documenten die haar aanhalen. Die geeft lido_verwijzingen_lijst (id ${ecliIntent.eclis[0]}, type 'Jurisprudentie' voor alleen uitspraken); de aantallen per soort lido_verwijzingen.`
              : undefined,
            ...notes,
          ),
          failures: failures.length ? failures : undefined,
          total: records.length,
        });
      }

      if (takes("ecli_buitenland") && foreignEclis) {
        // No request: Rechtspraak.nl has ECLI:NL only, and eurlex_document reads legislation, not rulings.
        const eu = foreignEclis.filter((e) => e.startsWith("ECLI:EU:"));
        const other = foreignEclis.filter((e) => !e.startsWith("ECLI:EU:"));
        return askSuccess({
          summary: `Router: ${foreignEclis.join(", ")} ${foreignEclis.length === 1 ? "is geen Nederlandse ECLI" : "zijn geen Nederlandse ECLI's"} (0 resultaten)`,
          records: [],
          provenance: prov("nl_gov_ask", "https://e-justice.europa.eu/topics/legislation-and-case-law/european-case-law-identifier-ecli_nl", { ecli: foreignEclis.join(",") }, 0, 0),
          access_note: mergeAccessNotes(
            "Rechtspraak.nl publiceert alleen uitspraken met een ECLI:NL; met de ECLI als zoekwoorden vond de zoekfunctie Nederlandse uitspraken die er niets mee te maken hebben. Er is daarom niets gezocht.",
            eu.length
              ? `Een uitspraak van het Hof van Justitie of het Gerecht van de EU staat op EUR-Lex: ${eu.map((e) => `https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=ecli:${encodeURIComponent(e)}`).join(", ")} (of zoek de ECLI op curia.europa.eu). eurlex_document leest EU-wetgeving (CELEX), geen uitspraken.`
              : undefined,
            other.length
              ? `Een uitspraak van een ander land staat bij de rechtspraak van dat land; de ECLI-zoekmachine van het Europese e-justitieportaal (https://e-justice.europa.eu/topics/legislation-and-case-law/european-case-law-identifier-ecli_nl) zoekt in de deelnemende landen.`
              : undefined,
          ),
          total: 0,
        });
      }

      if (takes("wet_artikel") && wetIntent) {
        const described = [
          `wet '${wetIntent.wet}'`,
          wetIntent.artikel ? `artikel '${wetIntent.artikel}'` : undefined,
          wetIntent.zoekterm ? `zoekterm '${wetIntent.zoekterm}'` : undefined,
          wetIntent.peildatum ? `peildatum ${wetIntent.peildatum} (uit '${wetIntent.peildatumBron}')` : undefined,
          wetIntent.peildatumOngeldig ? `geen peildatum: '${wetIntent.peildatumOngeldig}' bestaat niet` : undefined,
        ].filter(Boolean).join(", ");
        const invalidDayNote = wetIntent.peildatumOngeldig
          ? `De datum '${wetIntent.peildatumOngeldig}' bestaat niet en is niet toegepast: dit is de tekst die vandaag geldt. Voor een andere dag: wetten_bwb_tekst met peildatum (JJJJ-MM-DD).`
          : undefined;
        const started = Date.now();
        const out = await wettenTekstResult({ wet: wetIntent.wet, artikel: wetIntent.artikel, zoekterm: wetIntent.zoekterm, peildatum: wetIntent.peildatum, max_chars: BWB_TEXT_DEFAULT_CHARS });
        requestDebug.push({ connector: "wetten_bwb", request_url: "provenance" in out ? out.provenance.endpoint : "", request_method: "GET", response_time_ms: Date.now() - started, cache_hit: null, cache_ttl_remaining_s: null });
        const routeNote = `Vraag over een artikel van een landelijke wet: tekst uit de BWB (wetten.overheid.nl), zoals wetten_bwb_tekst met ${described}.`;
        // niet_gevonden 'wet'/'bwb_id': the words read as a law's name are no law the BWB knows.
        const unknownLaw = !("error" in out) && ["wet", "bwb_id"].includes(out.provenance.query_params.niet_gevonden ?? "");
        if (!("error" in out) && !unknownLaw) {
          // Also when the law was found but the artikel or a version on that day was not: that is the answer.
          return askSuccess({
            summary: `Router: Wetten (BWB) — ${out.summary}`,
            records: out.records,
            provenance: prov("nl_gov_ask", out.provenance.endpoint, out.provenance.query_params, out.records.length, out.provenance.total_results),
            access_note: mergeAccessNotes(routeNote, invalidDayNote, out.access_note),
            total: out.records.length,
          });
        }
        // An unknown law, or a BWB failure (reported in failures): the other routes answer, and say so.
        fallbackSteps.push(unknownLaw ? "wetten_bwb:wet_not_resolved" : "wetten_bwb:failed");
        if ("error" in out) routeFailures.push({ connector: "wetten_bwb", error_type: out.error, message: out.message });
        wetNote = `Eerst gezocht in de BWB (${described}): ${("error" in out ? out.message : out.summary).replace(/\.$/, "")}. Dit antwoord komt van de andere routes van nl_gov_ask.`;
      }

      if (takes("debat") && debatArgs) {
        const described = Object.entries(debatArgs)
          .filter(([, v]) => v !== undefined)
          .map(([key, value]) => `${key} '${String(value)}'`)
          .join(", ");
        try {
          const out = await timed("tweede_kamer", () => debatten.search(debatArgs));
          if (out.hits.length) {
            const records = await debatRecords(out.hits.slice(0, top), DEBAT_DEFAULT_CHARS);
            return askSuccess({
              summary: `Router: Tweede Kamer-debatten — ${debatSummary(out)}`,
              records,
              provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.hits.length),
              access_note: mergeAccessNotes(
                `Vraag over wat er in een Kamerdebat is gezegd: gezocht in de verslagen van de Tweede Kamer (${described}). Meer of andere fragmenten: tweede_kamer_debatten.`,
                debatNotes(out, false),
              ),
              total: out.hits.length,
            });
          }
          fallbackSteps.push("tweede_kamer_debatten:no_results");
          debatNote = `Eerst gezocht in de verslagen van Kamerdebatten (${described}, ${out.searched.length} vergaderingen): niets gevonden. Dit antwoord komt van de andere routes van nl_gov_ask.`;
        } catch (e) {
          const mapped = mapTweedeKamerError(e);
          fallbackSteps.push("tweede_kamer_debatten:search_failed");
          routeFailures.push({ connector: "tweede_kamer", error_type: mapped.error, message: mapped.message });
          debatNote = `Eerst gezocht in de verslagen van Kamerdebatten (${described}): mislukt. Dit antwoord komt van de andere routes van nl_gov_ask.`;
        }
      }

      if (takes("algoritme") && algoritmeIntent) {
        const described = Object.entries(algoritmeIntent)
          .map(([key, value]) => `${key} '${String(value)}'`)
          .join(", ");
        try {
          const out = await timed("algoritmeregister", () => algoritmeregister.search({ ...algoritmeIntent, limit: clampAlgoritmeRows(top) }));
          if (out.items.length) {
            const records = out.items.map(algoritmeRecord);
            return askSuccess({
              summary: `Router: Algoritmeregister — ${summarizeAlgoritmeSearch(out)}`,
              records,
              provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total),
              access_note: mergeAccessNotes(
                `Vraag over algoritmes van de overheid: gezocht in het Algoritmeregister (${described}). Meer of filteren op status of categorie: algoritmeregister_search.`,
                out.access_note,
              ),
              total: out.total,
            });
          }
          fallbackSteps.push("algoritmeregister:no_results");
          algoritmeNote = `Eerst gezocht in het Algoritmeregister (${described}): niets gevonden. Dit antwoord komt van de andere routes van nl_gov_ask.`;
        } catch (e) {
          const mapped = mapSourceError(e, "Algoritmeregister", "https://algoritmes.overheid.nl");
          fallbackSteps.push("algoritmeregister:search_failed");
          routeFailures.push({ connector: "algoritmeregister", error_type: mapped.error, message: mapped.message });
          algoritmeNote = `Eerst gezocht in het Algoritmeregister (${described}): mislukt. Dit antwoord komt van de andere routes van nl_gov_ask.`;
        }
      }

      /** The publications of the research body the question names; undefined when it has none or fails. */
      const runResearch = async (org: ResearchOrg) => {
        if (!researchIntent) return undefined;
        const { label, tool } = RESEARCH_ORGS[org];
        const query = researchIntent.query;
        const queryNote = query ? `zoekwoorden '${query}'` : "zonder zoekwoorden: de nieuwste publicaties";
        try {
          let records: MCPRecord[];
          let out: { endpoint: string; params: Record<string, string>; total: number | null; access_note?: string };
          if (org === "wodc") {
            const res = await timed("wodc", () => wodc.search({ query: query || undefined, date_from: temporal?.from, date_to: temporal?.to, offset: 0, limit: clampWodcRows(top) }));
            records = res.items.map(wodcRecord);
            out = { endpoint: res.endpoint, params: res.params, total: res.total, access_note: res.access_note };
          } else {
            const res = await timed(org, () => rijksoverheid.searchPublications({ site: org, query, top, date_from: temporal?.from, date_to: temporal?.to }));
            const origin = org === "rekenkamer" ? "https://www.rekenkamer.nl" : "https://www.scp.nl";
            records = res.items.map((x) => record(org, String(x.title || x.id || `${label} publicatie`), String(x.url || origin), x, String(x.snippet ?? ""), String(x.date ?? "")));
            out = { endpoint: res.endpoint, params: res.params, total: res.total, access_note: res.access_note };
          }
          if (records.length) {
            return askSuccess({
              summary: `Router: ${label} (${records.length} publicaties)`,
              records,
              provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total),
              access_note: mergeAccessNotes(
                `De vraag noemt ${org === "rekenkamer" ? "de Algemene Rekenkamer" : org === "scp" ? "het SCP" : "het WODC"}: gezocht in de eigen publicaties (zoals ${tool}, ${queryNote}).`,
                temporalNote,
                out.access_note,
              ),
              total: out.total,
            });
          }
          routeEmpty(label, `${org}:no_results`);
        } catch (e) {
          if (org === "wodc") {
            const mapped = mapWodcError(e);
            fallbackSteps.push("wodc:search_failed");
            triedRoutes.push(`${label} (mislukt: ${mapped.error})`);
            routeFailures.push({ connector: "wodc", error_type: mapped.error, message: mapped.message });
          } else {
            routeFailed(label, org, e);
          }
        }
        return undefined;
      };

      /** What one funder of the subsidy route answered. */
      type SubsidiePart = {
        source: SubsidieSource;
        records: MCPRecord[];
        total: number | null;
        summary: string;
        endpoint: string;
        params: Record<string, string>;
        notes: Array<string | undefined>;
        failures: AskFailures;
      };
      const SUBSIDIE_LABELS: Record<SubsidieSource, string> = { eu_funding: "het EU Funding & Tenders Portal", rvo_subsidies: "RVO", nl_onderzoekscalls: "NWO en ZonMw" };
      const SUBSIDIE_TOOLS: Record<SubsidieSource, string> = { eu_funding: "eu_funding_search en eu_funding_get", rvo_subsidies: "rvo_subsidies_search en rvo_subsidie_get", nl_onderzoekscalls: "nl_onderzoek_calls_search en nl_onderzoek_call_get" };

      /** One funder of the subsidy route, as its own search tool answers; a failure is thrown. */
      const subsidiePart = async (source: SubsidieSource, intent: SubsidieIntent): Promise<SubsidiePart> => {
        if (source === "eu_funding") {
          if (intent.euId) {
            const id = intent.euId;
            const out = await timed("eu_funding", () => euFunding.get(id, { maxChars: 2_000 }));
            const x = out.item;
            const records = x
              ? [record("eu_funding", x.title, x.url, { ...x, cascade_calls: out.cascade_calls }, describeEuFundingItem(x), (x.next_deadline ?? x.deadlines.at(-1))?.slice(0, 10))]
              : (out.candidates ?? []).map(euFundingRecord);
            return {
              source, records, total: records.length, summary: summarizeEuFundingGet(out), endpoint: out.endpoint, params: out.params, failures: [],
              notes: [`De vraag noemt EU-oproep ${id}: die is zelf gelezen, zoals eu_funding_get (teksten tot 2.000 tekens; meer met max_chars).`, out.access_note],
            };
          }
          let out = await timed("eu_funding", () => euFunding.search(subsidieEuArgs(intent)));
          let soonNote: string | undefined;
          // Nothing announced yet: what is open now, said so.
          if (intent.soonOnly && !out.items.length) {
            const open = await timed("eu_funding", () => euFunding.search({ ...subsidieEuArgs(intent), status: undefined }));
            if (open.items.length) {
              soonNote = "Geen EU-oproep die nog moet openen (forthcoming); hieronder de oproepen die nu open zijn.";
              out = open;
            }
          }
          const searched = intent.translated.length
            ? `Het portaal is Engelstalig: gezocht op '${intent.euQuery}' (vertaald: ${intent.translated.map(([nl, en]) => `${nl} → ${en.replace(/"/g, "")}`).join(", ")}).`
            : intent.euQuery ? `Gezocht op '${intent.euQuery}'.` : undefined;
          const untranslated = intent.untranslated.length
            ? `Zonder vertaling meegestuurd: ${intent.untranslated.map((w) => `'${w}'`).join(", ")}. Het portaal is Engelstalig; vindt dit te weinig, zoek dan met Engelse trefwoorden in eu_funding_search.`
            : undefined;
          return {
            source, records: out.items.map(euFundingRecord), total: out.total, summary: summarizeEuFundingSearch(out), endpoint: out.endpoint, params: out.params, failures: [],
            notes: [soonNote, searched, untranslated, "Alleen oproepen voor subsidies (grants, ook prijzen) en cascade funding; EuropeAid-oproepen voor landen buiten de EU: eu_funding_search met type 'external_action'.", out.access_note],
          };
        }
        if (source === "rvo_subsidies") {
          let out = await timed("rvo_subsidies", () => rvoSubsidies.search(subsidieRvoArgs(intent)));
          let statusNote: string | undefined;
          // Nothing open among the matches: they are shown with their status, so a closed regeling is not silently missing.
          const checks = out.status_checks;
          if (!out.items.length && checks?.candidates) {
            const all = await timed("rvo_subsidies", () => rvoSubsidies.search(subsidieRvoArgs(intent, false)));
            if (all.items.length) {
              const wanted = intent.soonOnly ? "bijna open" : "open of bijna open";
              // Not every candidate checked: the read cap or the time limit for status pages was reached.
              statusNote = checks.all_checked
                ? `Geen van de ${checks.candidates} treffers staat bij RVO ${wanted} voor aanvragen; hieronder de treffers met hun huidige status.`
                : checks.checked
                  ? `Van ${checks.checked} van de ${checks.candidates} treffers is de status gelezen en daarvan staat er bij RVO geen ${wanted} voor aanvragen; hieronder de treffers met hun huidige status. Verder filteren: rvo_subsidies_search met status.`
                  : `De status van de ${checks.candidates} treffers kon niet op tijd van rvo.nl worden gelezen; hieronder de treffers met de status die wel bekend is. Verder filteren: rvo_subsidies_search met status.`;
              out = all;
            }
          }
          return {
            source, records: out.items.map(rvoRecord), total: out.total, summary: summarizeRvoSearch(out), endpoint: out.endpoint, params: out.params, failures: [],
            notes: [statusNote, out.access_note, "Alleen regelingen die RVO uitvoert; gemeentelijke, provinciale en waterschapsregelingen staan in CVDR (cvdr_search)."],
          };
        }
        let out = await timed("nl_onderzoekscalls", () => onderzoekscalls.search(subsidieCallsArgs(intent)));
        let soonNote: string | undefined;
        // Nothing opening soon: what is open now, said so.
        if (intent.soonOnly && !out.items.length && !out.failures.length) {
          const open = await timed("nl_onderzoekscalls", () => onderzoekscalls.search({ ...subsidieCallsArgs(intent), status: "actueel" }));
          if (open.items.length) {
            soonNote = "Geen call of subsidieronde die binnenkort opent; hieronder wat nu open is.";
            out = open;
          }
        }
        let items: OnderzoekscallItem[] = out.items;
        let deadlineNote: string | undefined;
        // The NWO overview shows no closing date: for a deadline question it is read from the
        // first call pages (at most 3; nwo.nl's crawl delay spaces them 3 s apart, see the source).
        const toRead = intent.deadline ? items.filter((x) => x.organisation === "nwo" && !x.deadline).slice(0, 3) : [];
        if (toRead.length) {
          const read = await Promise.allSettled(toRead.map((x) => timed("nl_onderzoekscalls", () => onderzoekscalls.get({ url: x.url, max_chars: 500 }))));
          const pages = new Map(read.flatMap((r, i) => (r.status === "fulfilled" ? [[toRead[i].url, r.value] as const] : [])));
          let earlier = 0;
          items = items.map((x) => {
            const d = pages.get(x.url);
            if (!d) return x;
            // The first closing date still ahead (an intentieverklaring or vooraanmelding can close
            // months before the full application), with the last one named next to it.
            const before = d.next_deadline !== undefined && d.next_deadline !== d.deadline;
            if (before) earlier += 1;
            const date = d.next_deadline ?? d.deadline;
            const text = before ? d.next_deadline_text : d.deadline_text;
            const label = before ? d.next_deadline_label : d.deadline_label;
            const later = before && d.deadline_text ? `; daarna ${d.deadline_label ?? "sluitingsdatum"} ${d.deadline_text}` : "";
            return {
              ...x,
              ...(date ? { deadline: date } : {}),
              ...(text ? { deadline_text: label ? `${text} (${label}${later})` : text } : {}),
              ...(!x.budget_text && d.budget_text ? { budget_text: d.budget_text, ...(d.budget_eur !== undefined ? { budget_eur: d.budget_eur } : {}) } : {}),
              ...(d.warnings.length ? { warnings: d.warnings } : {}),
            };
          });
          deadlineNote =
            `Het overzicht van nwo.nl toont geen sluitingsdatum: die is van de callpagina gelezen bij ${pages.size} van de eerste ${toRead.length} NWO-calls; de overige via nl_onderzoek_call_get.` +
            (earlier ? ` Bij ${earlier === 1 ? "één call" : `${earlier} calls`} sluit eerst een eerdere stap (intentieverklaring of vooraanmelding): de deadline is die eerstvolgende, de latere staat erachter; of die stap verplicht is, staat in de tekst van de call.` : "");
        }
        return {
          source, records: items.map(onderzoekscallRecord), total: out.total, summary: summarizeOnderzoekscallsSearch(out), endpoint: out.endpoint, params: out.params,
          failures: out.failures.map((f) => ({ connector: f.connector, error_type: f.error_type, message: f.message })),
          notes: [soonNote, deadlineNote, out.access_note],
        };
      };

      /**
       * The subsidy route: the funders the intent names, side by side, each with its
       * share of `top`. Undefined when none has anything: the next routes answer and
       * say that these were asked.
       */
      const runSubsidies = async (intent: SubsidieIntent) => {
        const settle = async (sources: SubsidieSource[], asking: SubsidieIntent) => {
          const settled = await Promise.allSettled(sources.map((source) => subsidiePart(source, asking)));
          const parts: SubsidiePart[] = [];
          const failures: AskFailures = [];
          settled.forEach((r, i) => {
            if (r.status === "fulfilled") {
              parts.push(r.value);
              failures.push(...r.value.failures);
            } else {
              const mapped = sources[i] === "nl_onderzoekscalls" ? mapOnderzoekscallError(r.reason) : mapSourceError(r.reason, SUBSIDIE_LABELS[sources[i]]);
              failures.push({ connector: sources[i], error_type: mapped.error, message: mapped.message });
            }
          });
          return { parts, failures };
        };
        const found = (ps: SubsidiePart[]) => ps.some((p) => p.records.length);
        const sameFailure = (a: AskFailures[number], b: AskFailures[number]) => a.connector === b.connector && a.message === b.message;
        let used = intent;
        let { parts, failures } = await settle(intent.sources, used);
        let asked = intent.sources;
        let narrowed: string | undefined;
        let widened: string | undefined;
        // Nothing with all topic words together (every word is required at RVO, NWO, ZonMw and the
        // EU portal): once more with only the most specific one before the question goes on.
        const narrow = parts.length && !found(parts) ? narrowSubsidieIntent(intent) : undefined;
        if (narrow) {
          const again = await settle(asked, narrow);
          if (found(again.parts)) {
            parts = again.parts;
            failures = again.failures;
          } else {
            failures = [...failures, ...again.failures.filter((f) => !failures.some((g) => sameFailure(f, g)))];
          }
          used = narrow;
          narrowed = `Met alle trefwoorden samen ('${intent.query}') niets gevonden; daarom gezocht op '${narrow.query}' alleen.`;
        }
        // RVO alone without a match: the national research funders get the question too.
        if (asked.length === 1 && asked[0] === "rvo_subsidies" && !found(parts)) {
          const more = await settle(["nl_onderzoekscalls"], used);
          parts = [...parts, ...more.parts];
          failures = [...failures, ...more.failures];
          asked = [...asked, "nl_onderzoekscalls"];
          widened = "Bij RVO niets gevonden: daarom ook gezocht in de calls van NWO en ZonMw.";
        }
        const labels = asked.map((s) => SUBSIDIE_LABELS[s]).join(", ");
        const described = [
          intent.euId ? `oproep ${intent.euId}` : intent.query ? `trefwoorden '${intent.query}'${narrow ? `, daarna alleen '${narrow.query}'` : ""}` : intent.euJointUndertaking ? undefined : "zonder trefwoorden",
          intent.doelgroep ? `doelgroep '${intent.doelgroep}'` : undefined,
          intent.land ? `land '${intent.land}'` : undefined,
          intent.euProgramme ? `EU-programma ${intent.euProgramme}` : undefined,
          intent.euJointUndertaking ? `joint undertaking: '${intent.euJointUndertaking}' in de oproepcode` : undefined,
          intent.soonOnly ? "binnenkort open" : intent.openOnly ? "alleen wat open is of binnenkort opent" : undefined,
        ].filter(Boolean).join(", ");
        const window = subsidieWindow(intent);
        const windowNote = window
          ? asked.includes("eu_funding")
            ? `Deadline tussen ${window.from} en ${window.to} (uit '${window.phrase}')${asked.length > 1 ? "; alleen op de EU-oproepen toegepast, RVO, NWO en ZonMw hebben geen deadlinefilter (zie de periode of deadline per record)" : ""}.`
            : `De periode uit de vraag ('${window.phrase}') is niet toegepast: RVO, NWO en ZonMw hebben geen deadlinefilter; zie de periode of deadline per record.`
          : undefined;
        const answering = parts.filter((p) => p.records.length);
        if (!answering.length) {
          routeFailures.push(...failures);
          fallbackSteps.push(parts.length ? "subsidies:no_results" : "subsidies:search_failed");
          subsidieNote = `Eerst gezocht naar subsidies en calls bij ${labels} (${described}): ${parts.length ? "niets gevonden" : "mislukt"}. Dit antwoord komt van de andere routes van nl_gov_ask.`;
          return undefined;
        }
        // Each funder that answered its share of `top`; what one leaves goes to the next, in order.
        const counts = answering.map((p) => Math.min(p.records.length, Math.ceil(top / answering.length)));
        let free = top - counts.reduce((a, b) => a + b, 0);
        answering.forEach((p, i) => {
          const more = Math.max(0, Math.min(free, p.records.length - counts[i]));
          counts[i] += more;
          free -= more;
        });
        const records = answering.flatMap((p, i) => p.records.slice(0, counts[i]));
        const totals = parts.map((p) => p.total);
        const total = totals.every((t): t is number => typeof t === "number") ? totals.reduce((a, b) => a + b, 0) : null;
        const provenance = parts.length === 1
          ? prov("nl_gov_ask", parts[0].endpoint, parts[0].params, records.length, parts[0].total)
          : prov(
              "nl_gov_ask",
              parts.map((p) => p.endpoint).join(" | "),
              Object.fromEntries(parts.flatMap((p) => Object.entries(p.params).map(([k, v]) => [`${p.source}.${k}`, v]))),
              records.length,
              total,
            );
        return askSuccess({
          summary: `Router: subsidies — ${parts.map((p) => p.summary).join("; ")}`,
          records,
          provenance,
          access_note: mergeAccessNotes(
            `Vraag over subsidies of financiering: gezocht bij ${labels} (${described}). Meer resultaten, filters of de volledige tekst: ${asked.map((s) => SUBSIDIE_TOOLS[s]).join("; ")}.`,
            windowNote,
            used.euSharedFund
              ? "EU-fondsen die in Nederland worden uitgevoerd (het landbouwbeleid GLB, EFRO, ESF+, Interreg) staan niet in het EU Funding & Tenders Portal. " +
                `Gezocht is bij RVO, dat de GLB-regelingen uitvoert (de andere fondsen staan er alleen in voor zover RVO ze uitvoert)${used.glbAsTopic ? ", op 'GLB' (Gemeenschappelijk Landbouwbeleid)" : ""}.`
              : undefined,
            narrowed,
            widened,
            ...parts.flatMap((p) => p.notes),
          ),
          failures: failures.length ? failures : undefined,
          total,
        });
      };

      if (takes("rekenkamer")) {
        const answered = await runResearch("rekenkamer");
        if (answered) return answered;
      }
      if (takes("scp")) {
        const answered = await runResearch("scp");
        if (answered) return answered;
      }
      if (takes("wodc")) {
        const answered = await runResearch("wodc");
        if (answered) return answered;
      }

      if (takes("subsidies") && subsidieIntent) {
        const answered = await runSubsidies(subsidieIntent);
        if (answered) return answered;
      }

      if (takes("multi")) {
        const failures: NonNullable<ReturnType<typeof successResponse>["failures"]> = [];

        const runnableCandidates = uniquePlannerCandidates.filter((candidate) => {
          if (candidate === "api" && !process.env[ENV_KEYS.OVERHEID_API_KEY]) {
            failures.push({
              connector: "api_register",
              error_type: "not_configured",
              message: "OVERHEID_API_KEY ontbreekt voor API-register queries",
            });
            return false;
          }
          return true;
        });

        const runCandidate = async (candidate: typeof runnableCandidates[number]) => {
          switch (candidate) {
            case "cbs": {
              const candidates = [makeCbsQuery(questionForSearch), questionForSearch];
              if (q.includes("inwoner") || q.includes("population")) candidates.push("bevolking");
              if (q.includes("opleidingsniveau") || q.includes("opleiding")) candidates.push("opleidingsniveau gemeenten");
              if (q.includes("werkloos")) candidates.push("werkloosheid");
              if (q.includes("emissie")) candidates.push("emissie");

              let query = candidates[0] || questionForSearch;
              let out = await timed("cbs", () => cbs.searchTables(query, Math.max(top, 8)));
              let items = cbsItems(out);

              if (!items.length) {
                for (const candidate of candidates.slice(1)) {
                  if (!candidate || !candidate.trim()) continue;
                  fallbackSteps.push(`cbs:fallback_candidate:${candidate}`);
                  out = await timed("cbs", () => cbs.searchTables(candidate, Math.max(top, 8)));
                  items = cbsItems(out);
                  if (items.length) {
                    query = candidate;
                    break;
                  }
                }
              }

              const sorted = [...items].sort((a, b) => scoreCbsTable(b) - scoreCbsTable(a));
              const records = sorted.slice(0, top).map((x) =>
                record("cbs", String(x.Title ?? x.Identifier ?? "CBS"), cbsCatalogItemUrl(x), x),
              );
              return { connector: "cbs", records, endpoint: out.endpoint, params: out.params, total: items.length, query };
            }
            case "tk": {
              const query = tkMultiQuery;
              const out = await timed("tweede_kamer", () => tk.searchDocuments({
                query,
                type: tkType,
                top,
                date_from: temporal?.from,
                date_to: temporal?.to,
              }));
              const records = out.items.map(tkDocumentRecord);
              return { connector: "tweede_kamer", records, endpoint: out.endpoint, params: out.params, total: out.items.length, query };
            }
            case "ob": {
              // Keywords, not the sentence: the SRU search ANDs every word. A
              // journal the question names is a filter (obSearch). A refused
              // query is a failure of this source, not 0 results.
              const ob = obSearch();
              const { out, query } = await searchBekendmakingen(ob.query, ob.looseQuery, {
                maximumRecords: top,
                publicatieblad: ob.publicatieblad,
                sort: ob.sort,
                date_from: temporal?.from,
                date_to: temporal?.to,
              });
              const records = out.items.map((x) =>
                record(
                  "officielebekendmakingen",
                  String(x.title ?? x.identifier ?? "Bekendmaking"),
                  String(x.canonical_url ?? x.identifier ?? "https://zoek.officielebekendmakingen.nl"),
                  x as Record<string, unknown>,
                ),
              );
              return { connector: "officiele_bekendmakingen", records, endpoint: out.endpoint, params: out.params, total: out.total, query };
            }
            case "rijk": {
              const query = makeKeywordQuery(questionForSearch) || questionForSearch;
              const out = await timed("rijksoverheid", () => rijksoverheid.search({
                query,
                top,
                date_from: temporal?.from,
                date_to: temporal?.to,
              }));
              const records = out.items.map((x) =>
                record("rijksoverheid", String(x.title ?? x.id ?? "Rijksoverheid"), String(x.canonical ?? x.url ?? "https://www.rijksoverheid.nl"), x),
              );
              return { connector: "rijksoverheid", records, endpoint: out.endpoint, params: out.params, total: out.total, query };
            }
            case "budget": {
              const query = makeKeywordQuery(questionForSearch) || questionForSearch;
              const out = await timed("rijksbegroting", () => rijksbegroting.search(query, top));
              const records = out.items.map((x) =>
                record("rijksbegroting", String(x.name ?? x.id ?? "Rijksbegroting"), String(x.url ?? "https://opendata.rijksbegroting.nl"), x),
              );
              return { connector: "rijksbegroting", records, endpoint: out.endpoint, params: out.params, total: out.total, query };
            }
            case "duo": {
              const query = makeKeywordQuery(questionForSearch) || questionForSearch;
              const out = await timed("duo", () => duo.datasetsCatalog(query, top));
              const records = out.items.map((x) =>
                record("duo", String(x.title ?? x.name ?? x.id ?? "DUO"), String(x.url ?? "https://onderwijsdata.duo.nl"), x),
              );
              return { connector: "duo", records, endpoint: out.endpoint, params: out.params, total: out.total, query };
            }
            case "api": {
              const apiKey = process.env[ENV_KEYS.OVERHEID_API_KEY];
              if (!apiKey) throw new Error("OVERHEID_API_KEY is not set");
              const query = makeKeywordQuery(questionForSearch) || questionForSearch;
              const out = await timed("api_register", () => new ApiRegisterSource(config, apiKey).search(query, top));
              const records = out.items.map((x) =>
                record("api-register", String(x.name ?? x.title ?? x.id ?? "API"), String(x.portalUrl ?? x.url ?? "https://apis.developer.overheid.nl"), x),
              );
              return { connector: "api_register", records, endpoint: out.endpoint, params: out.params, total: out.items.length, query };
            }
            case "rechtspraak": {
              const query = makeRechtspraakQuery(questionForSearch) || questionForSearch;
              const out = await timed("rechtspraak", () => rechtspraak.searchEcli({ query, rows: top, sort: "relevance" }));
              const records = out.items
                .filter((x) => Boolean(x.ecli))
                .map((x) =>
                  record("rechtspraak", String(x.title ?? x.ecli ?? x.id ?? "Rechtspraak uitspraak"), String(x.link ?? x.id ?? "https://data.rechtspraak.nl"), x as Record<string, unknown>, String(x.summary ?? x.ecli ?? ""), String(x.updated ?? "")),
                );
              return { connector: "rechtspraak", records, endpoint: out.endpoint, params: out.params, total: out.total, query };
            }
          }
        };

        const settled = await Promise.allSettled(runnableCandidates.map((c) => runCandidate(c)));

        const mergedRecordsRaw: MCPRecord[] = [];
        const successfulConnectors: string[] = [];
        const connectorLabelMap: Record<string, string> = {
          cbs: "CBS",
          tk: "Tweede Kamer",
          ob: "Officiële Bekendmakingen",
          rijk: "Rijksoverheid",
          budget: "Rijksbegroting",
          duo: "DUO",
          api: "API Register",
          rechtspraak: "Rechtspraak",
        };
        // The search terms each source got, when they differ from the question.
        const derivedQueries: string[] = [];

        settled.forEach((result, idx) => {
          const candidate = runnableCandidates[idx];

          if (result.status === "fulfilled") {
            const out = result.value;
            successfulConnectors.push(out.connector);
            if (queryNote(out.query)) derivedQueries.push(`${connectorLabelMap[candidate] ?? candidate} ${quotedQuery(out.query)}`);

            const annotated = out.records.map((rec) => {
              const data = { ...(rec.data ?? {}) };
              data._provenance = {
                connector: out.connector,
                endpoint: out.endpoint,
                query_params: out.params,
                returned_results: out.records.length,
                total_results: out.total,
              };
              return { ...rec, data };
            });

            mergedRecordsRaw.push(...annotated);
            return;
          }

          const mapped = mapSourceError(result.reason, connectorLabelMap[candidate] ?? candidate);
          failures.push({
            connector: candidate === "api" ? "api_register" : candidate,
            error_type: mapped.error,
            message: mapped.message,
          });
          triedRoutes.push(
            result.reason instanceof BekendmakingenRefusedError
              ? `${connectorLabelMap[candidate] ?? candidate} (zoekvraag geweigerd, niet gezocht)`
              : `${connectorLabelMap[candidate] ?? candidate} (mislukt: ${mapped.error})`,
          );
        });

        const mergedRecords = dedupeMergedRecords(mergedRecordsRaw);
        const dedupedCount = mergedRecordsRaw.length - mergedRecords.length;

        if (mergedRecords.length) {
          const notes: string[] = [];
          if (derivedQueries.length) {
            notes.push(`Zoektermen afgeleid uit de vraag: ${derivedQueries.join("; ")}.`);
          }
          if (obPublicatieblad && successfulConnectors.includes("officiele_bekendmakingen")) {
            notes.push(`Officiële Bekendmakingen gefilterd op publicatieblad '${obPublicatieblad}'${obSearch().sort ? ", nieuwste eerst" : ""}.`);
          }
          if (temporal) {
            notes.push(`Temporal range applied: ${temporal.from}..${temporal.to} (${temporal.matchedPattern}, ref=${temporal.context.referenceNow}, tz=${temporal.context.timeZone}).`);
          }
          if (failures.length) {
            notes.push(`Partial failures: ${failures.map((f) => `${f.connector}(${f.error_type})`).join(", ")}`);
          }
          if (dedupedCount > 0) {
            notes.push(`Deduplicated ${dedupedCount} duplicate records by identifier.`);
          }

          return askSuccess({
            summary: `Router: multi-source (${mergedRecords.length} resultaten uit ${successfulConnectors.length} bronnen)`,
            records: mergedRecords,
            provenance: prov(
              "nl_gov_ask",
              "multi-source-planner",
              {
                question: decodedQuestion,
                sources: successfulConnectors.join(","),
              },
              mergedRecords.length,
              mergedRecords.length,
            ),
            access_note: notes.length ? notes.join(" ") : undefined,
            failures: failures.length ? failures : undefined,
            total: mergedRecords.length,
          });
        }

        if (failures.length && !successfulConnectors.length) {
          return toMcpToolPayload(errorResponse({
            error: failures[0]?.error_type ?? "unexpected",
            message: `Alle geselecteerde bronnen faalden: ${failures.map((f) => `${f.connector} (${f.error_type})`).join(", ")}`,
            details: { failures },
          }));
        }
        // Some sources answered with nothing and others failed (or refused
        // the query): no "all sources failed", but on to the next routes,
        // whose answer names the failures.
        routeFailures.push(...failures);
        routeEmpty(`Meerdere bronnen: ${successfulConnectors.join(", ")}`, "multi_source:no_results");
      }

      if (takes("schoolvakanties")) {
        const yearMatch = decodedQuestion.match(/\b(20\d{2})\b/);
        const regionMatch = q.match(/\b(noord|midden|zuid)\b/);

        let out = await timed("rijksoverheid", () => rijksoverheid.schoolholidays({
          year: yearMatch ? Number(yearMatch[1]) : undefined,
          region: regionMatch ? regionMatch[1] : undefined,
        }));

        if (!out.items.length && regionMatch) {
          fallbackSteps.push("rijksoverheid:schoolholidays:no_region_match");
          out = await timed("rijksoverheid", () => rijksoverheid.schoolholidays({ year: yearMatch ? Number(yearMatch[1]) : undefined }));
        }
        if (!out.items.length && yearMatch) {
          fallbackSteps.push("rijksoverheid:schoolholidays:no_year_match");
          out = await timed("rijksoverheid", () => rijksoverheid.schoolholidays({ region: regionMatch ? regionMatch[1] : undefined }));
        }

        const records = out.items.map((x)=>record("rijksoverheid", String(x.title ?? x.region ?? "Schoolvakantie"), String(x.canonical ?? "https://www.rijksoverheid.nl"), x, String(x.region ?? ""), String(x.startdate ?? "")));
        if (records.length) {
          return askSuccess({ summary: `Router: Rijksoverheid schoolvakanties (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, records.length), total: records.length });
        }

        fallbackSteps.push("rijksoverheid:schoolholidays:fallback_search");
        const rijkOut = await timed("rijksoverheid", () => rijksoverheid.search({ query: "schoolvakantie", top }));
        const rijkRecords = rijkOut.items.map((x)=>record("rijksoverheid", String(x.title ?? x.id ?? "Rijksoverheid"), String(x.canonical ?? x.url ?? "https://www.rijksoverheid.nl"), x));
        if (rijkRecords.length) {
          return askSuccess({ summary: `Router: Rijksoverheid (${rijkRecords.length} resultaten)`, records: rijkRecords, provenance: prov("nl_gov_ask", rijkOut.endpoint, rijkOut.params, rijkRecords.length, rijkOut.total), total: rijkOut.total });
        }
        routeEmpty("Rijksoverheid schoolvakanties", "rijksoverheid:schoolholidays:no_results");
      }

      // Specific-source routes run before the broad statistical/parliamentary
      // ones: "verkiezingsuitslag in Tilburg" mentions a municipality, which the
      // CBS branch would otherwise happily swallow.
      if (takes("verkiezingen")) try {
        const gebied = extractPlaceName(decodedQuestion);
        const out = await timed("verkiezingsuitslagen", () =>
          verkiezingsuitslagen.uitslag({ verkiezing: extractVerkiezingHint(q), gebied }),
        );
        if (out.uitslag) {
          const u = out.uitslag;
          const records = u.partijen.slice(0, top).map((p) => record(
            "verkiezingsuitslagen",
            p.partij,
            u.url,
            { partij: p.partij, aantal_stemmen: p.aantalStemmen, percentage: p.percentage, aantal_zetels: p.aantalZetels, verkiezing: u.verkiezingCode, gebied: u.gebied, niveau: u.niveau, opkomst_percentage: u.opkomstPercentage },
            `${p.aantalStemmen ?? "?"} stemmen (${p.percentage ?? "?"}%)`,
            u.verkiezingDatum,
          ));
          if (records.length) {
            return askSuccess({
              summary: `Router: Verkiezingsuitslagen ${u.verkiezingNaam} — ${u.gebied} (${records.length} partijen)`,
              records,
              provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, u.partijen.length),
              access_note: mergeAccessNotes(`Opkomst ${u.opkomstPercentage ?? "?"}%.`, out.access_note),
              total: u.partijen.length,
            });
          }
        }
        routeEmpty("Verkiezingsuitslagen", "verkiezingsuitslagen:no_results");
      } catch (e) {
        // One dead upstream must not sink the router — fall through to the next source.
        routeFailed("Verkiezingsuitslagen", "verkiezingsuitslagen", e);
      }

      if (takes("tenderned")) try {
        // TenderNed ORs its search words, so every leftover "welke"/"zijn"/"voor"
        // pulled in unrelated tenders; send the topic only.
        const tenderQuery = makeKeywordQuery(questionForSearch, tenderRouteWords) || questionForSearch;
        const out = await timed("tenderned", () =>
          tenderned.search({ query: tenderQuery, rows: Math.min(top, 100), datumVanaf: temporal?.from, datumTot: temporal?.to }),
        );
        const records = out.items.map((x) => record(
          "tenderned",
          x.title,
          x.url,
          // As tenderned_aanbestedingen_search: a placeholder or unchecked closing date says so.
          tenderNedRecordFields(x),
          `${x.opdrachtgever}${x.typePublicatie ? ` — ${x.typePublicatie}` : ""}`.trim(),
          x.publicatieDatum,
        ));
        if (records.length) {
          return askSuccess({ summary: `Router: TenderNed (${records.length} publicaties)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: mergeAccessNotes(queryNote(tenderQuery), out.access_note), total: out.total });
        }
        routeEmpty("TenderNed", "tenderned:no_results");
      } catch (e) {
        routeFailed("TenderNed", "tenderned", e);
      }

      // Before the Rechtspraak route: disciplinary rulings are NOT on
      // rechtspraak.nl, and "tuchtrecht" is one of its trigger words.
      if (takes("tuchtrecht")) try {
        const tuchtQuery = makeStrictQuery(questionForSearch) || questionForSearch;
        const out = await timed("tuchtrecht", () =>
          tuchtrecht.search({ query: tuchtQuery, date_from: temporal?.from, date_to: temporal?.to, maximumRecords: top }),
        );
        const records = out.items.map((raw) => {
          const x = raw as import("../sources/koop-collecties.js").TuchtrechtItem;
          return record(
            "tuchtrecht",
            x.title,
            x.canonical_url,
            { ecli: x.identifier, college: x.college, domein: x.domein, zaaknummer: x.zaaknummer, beslissing: x.beslissing, uitspraakdatum: x.uitspraakdatum, onderwerp: x.onderwerp },
            [x.beslissing, x.onderwerp].filter(Boolean).join(" — ") || x.samenvatting,
            x.uitspraakdatum,
          );
        });
        if (records.length) {
          return askSuccess({ summary: `Router: Tuchtrecht (${records.length} uitspraken)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: mergeAccessNotes(queryNote(tuchtQuery), out.access_note), total: out.total });
        }
        routeEmpty("Tuchtrecht", "tuchtrecht:no_results");
      } catch (e) {
        routeFailed("Tuchtrecht", "tuchtrecht", e);
      }

      if (takes("gewaspercelen")) try {
        const gemeente = extractPlaceName(decodedQuestion);
        if (gemeente) {
          const out = await timed("brp_gewaspercelen", () =>
            brpGewaspercelen.search({ gemeente, categorie: "all", includeGeometry: false, rows: top }),
          );
          const records = out.items.map((x) => record(
            "brp_gewaspercelen",
            x.title,
            x.url,
            { gewas: x.gewas, categorie: x.categorie, jaar: x.jaar, oppervlakte_ha: x.oppervlakteHa, centroid: x.centroid },
            `${x.categorie}${x.oppervlakteHa !== null ? ` — ${x.oppervlakteHa} ha` : ""}`,
            x.jaar,
          ));
          if (records.length) {
            return askSuccess({ summary: `Router: BRP Gewaspercelen ${gemeente} (${records.length} percelen)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: out.access_note, total: out.total });
          }
          routeEmpty(`BRP Gewaspercelen ${gemeente}`, "brp_gewaspercelen:no_results");
        }
      } catch (e) {
        routeFailed("BRP Gewaspercelen", "brp_gewaspercelen", e);
      }

      if (takes("luchtmeetnet")) try {
        const plaats = extractPlaceName(decodedQuestion);
        const out = await timed("luchtmeetnet", () =>
          luchtmeetnet.latest({ plaats, component: extractLuchtComponent(q), rows: top }),
        );
        const records = out.items.map((x) => record(
          "luchtmeetnet",
          `${String(x.formula ?? "component")}-${String(x.station_name ?? x.station_number ?? "station")}`,
          "https://www.luchtmeetnet.nl",
          x,
          `${String(x.component ?? x.formula ?? "")}: ${String(x.value ?? "")} ${String(x.unit ?? "")}`.trim(),
          String(x.timestamp ?? x.timestamp_measured ?? ""),
        ));
        if (records.length) {
          // Without a recognised place these are stations from all over the
          // country. Saying so beats letting "luchtkwaliteit Utrecht" read as if
          // the returned Oude Meer station were Utrecht's.
          const scopeNote = plaats
            ? undefined
            : "Geen plaatsnaam in de vraag herkend; dit zijn landelijke metingen. Noem de plaats expliciet (bijv. 'luchtkwaliteit in Utrecht') voor lokale waarden.";
          return askSuccess({
            summary: `Router: Luchtmeetnet${plaats ? ` ${plaats}` : " — landelijk"} (${records.length} metingen)`,
            records,
            provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total),
            access_note:
              [scopeNote, (out as { access_note?: string }).access_note].filter(Boolean).join(" ") ||
              undefined,
            total: out.total,
          });
        }
        // A place without a measuring station is a real answer, not an empty one.
        const note = (out as { access_note?: string }).access_note;
        if (note && plaats) {
          return askSuccess({
            summary: `Router: Luchtmeetnet — geen meetstation voor ${plaats}`,
            records: [],
            provenance: prov("nl_gov_ask", out.endpoint, out.params, 0, 0),
            access_note: note,
            total: 0,
          });
        }
        routeEmpty("Luchtmeetnet", "luchtmeetnet:no_results");
      } catch (e) {
        routeFailed("Luchtmeetnet", "luchtmeetnet", e);
      }

      if (takes("catalogi")) try {
        const productQuery = makeStrictQuery(questionForSearch) || questionForSearch;
        const out = await timed("samenwerkende_catalogi", () =>
          samenwerkendeCatalogi.search({ query: productQuery, maximumRecords: top }),
        );
        const records = out.items.map((raw) => {
          const x = raw as import("../sources/koop-collecties.js").SamenwerkendeCatalogiItem;
          return record(
            "samenwerkende_catalogi",
            x.title,
            x.canonical_url,
            { organisatie: x.organisatie, organisatietype: x.organisatietype, gebied: x.gebied, doelgroep: x.doelgroep, samenvatting: x.samenvatting },
            [x.organisatie, x.doelgroep].filter(Boolean).join(" — "),
            x.gewijzigd,
          );
        });
        if (records.length) {
          return askSuccess({ summary: `Router: Samenwerkende Catalogi (${records.length} productbeschrijvingen)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: mergeAccessNotes(queryNote(productQuery), out.access_note), total: out.total });
        }
        routeEmpty("Samenwerkende Catalogi", "samenwerkende_catalogi:no_results");
      } catch (e) {
        routeFailed("Samenwerkende Catalogi", "samenwerkende_catalogi", e);
      }

      // Education: prefer real per-school records over the dataset catalogue when
      // the question is about a concrete school, place or exam performance.
      // SCHOOL_TERMS/EXAM_TERMS carry the plural forms DUO_TERMS lacks ("basisscholen"),
      // and word-boundary matching means those would otherwise miss entirely.
      if (takes("duo_scholen")) try {
        const gemeente = extractPlaceName(decodedQuestion);
        const wantsExam = has(EXAM_TERMS);
        const wantsSchools = has(SCHOOL_TERMS) || Boolean(gemeente);

        if (wantsExam) {
          const out = await timed("duo", () =>
            duo.getExamResults({ municipality: gemeente, sortByScore: /best|hoogst|beste|top/.test(q), top }),
          );
          const records = out.items.map((x) => record(
            "duo",
            `${x.school}${x.onderwijstype ? ` — ${x.onderwijstype}` : ""}`,
            x.url,
            { school: x.school, brin: x.brin, gemeente: x.gemeente, onderwijstype: x.onderwijstype, schooljaar: x.schooljaar, examenkandidaten: x.examenkandidaten, geslaagden: x.geslaagden, slagingspercentage: x.slagingspercentage, gemiddeld_cijfer_centraal_examen: x.gemiddeldCentraalExamen },
            `${x.slagingspercentage ?? "?"}% geslaagd`,
            x.schooljaar ? String(x.schooljaar) : undefined,
          ));
          if (records.length) {
            return askSuccess({ summary: `Router: DUO examenresultaten (${records.length} vestigingen)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: out.access_note, total: out.total });
          }
        }

        if (wantsSchools) {
          const sector = duoSector(q);
          const out = await timed("duo", () =>
            duo.getSchools({ municipality: gemeente, sector, top }),
          );
          const records = out.items.map((x) => record(
            "duo",
            x.naam,
            x.url,
            { naam: x.naam, instellingscode: x.instellingscode, vestigingscode: x.vestigingscode, onderwijstype: x.onderwijstype, straat: x.straat, postcode: x.postcode, plaats: x.plaats, gemeente: x.gemeente, denominatie: x.denominatie, website: x.website },
            [x.straat, x.postcode, x.plaats].filter(Boolean).join(", "),
          ));
          if (records.length) {
            return askSuccess({ summary: `Router: DUO onderwijsvestigingen (${records.length} scholen, ${sector})`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: out.access_note, total: out.total });
          }
        }
        if (wantsExam || wantsSchools) routeEmpty("DUO scholen/examens", "duo:per_school_no_results");
      } catch (e) {
        // Falls through to the DUO dataset-catalogue branch further down.
        routeFailed("DUO scholen/examens", "duo", e, "duo:per_school_search_failed");
      }

      if (takes("cbs")) {
        // "Hoeveel inwoners heeft Nijmegen?": the number itself, from the CBS
        // population table, rather than tables whose title has a question word.
        if (populationPlace) try {
          const out = await timed("cbs", () => cbsMunicipalityPopulation(config, populationPlace));
          const tableUrl = cbsTableUrl(CBS_POPULATION_TABLE);
          const tableName = `CBS-tabel ${CBS_POPULATION_TABLE} (Bevolking op 1 januari en gemiddeld; geslacht, leeftijd en regio)`;
          if (out.kind === "gemeente" && out.rows.length) {
            const askedYear = populationYear;
            const asked = askedYear !== undefined ? out.rows.find((r) => r.jaar === askedYear) : undefined;
            const ordered = asked ? [asked, ...out.rows.filter((r) => r !== asked)] : out.rows;
            const area = out.niveau === "gemeente" ? `gemeente ${out.naam}` : out.niveau === "provincie" ? `provincie ${out.naam}` : out.naam;
            const records = ordered.slice(0, top).map((r) => record(
              "cbs",
              `${out.naam}: ${r.bevolking_op_1_januari?.toLocaleString("nl-NL")} inwoners op 1 januari ${r.jaar}`,
              tableUrl,
              { ...(out.niveau === "gemeente" ? { gemeente: out.naam, gemeentecode: out.code } : { regio: out.naam, regiocode: out.code, niveau: out.niveau }), peildatum: `${r.jaar}-01-01`, bevolking_op_1_januari: r.bevolking_op_1_januari, gemiddelde_bevolking: r.gemiddelde_bevolking, perioden: r.periode, tabel: CBS_POPULATION_TABLE },
              `Bevolking op 1 januari ${r.jaar}${r.gemiddelde_bevolking !== null ? `; gemiddeld over ${r.jaar}: ${Math.round(r.gemiddelde_bevolking).toLocaleString("nl-NL")}` : ""}`,
              `${r.jaar}-01-01`,
            ));
            const head = ordered[0];
            const oldest = out.rows[out.rows.length - 1].jaar;
            const missingYear = askedYear !== undefined && !asked;
            const yearNote = missingYear
              ? `Voor ${askedYear} heeft de tabel geen cijfer voor ${out.naam} (de tabel heeft ${oldest} t/m ${out.rows[0].jaar}); daarom getoond vanaf het recentste jaar (${out.rows[0].jaar}), niet het gevraagde jaar.`
              : undefined;
            const formerNote = out.opgeheven
              ? `${out.naam} is geen gemeente meer: de tabel heeft cijfers t/m 1 januari ${out.opgeheven.laatsteJaar} en loopt tot ${out.opgeheven.tabelTot}. Het gebied hoort nu bij een andere gemeente; vraag naar die gemeente voor het huidige aantal.`
              : undefined;
            const figure = `${head.bevolking_op_1_januari?.toLocaleString("nl-NL")} inwoners op 1 januari ${head.jaar}`;
            const summary = missingYear
              ? `Router: CBS bevolking — ${out.naam}: geen cijfer voor ${askedYear} (tabel ${oldest}–${out.rows[0].jaar}); recentste: ${figure}`
              : out.opgeheven
                ? `Router: CBS bevolking — ${out.naam} (opgeheven gemeente): ${figure} (laatste cijfer)`
                : `Router: CBS bevolking — ${out.naam}: ${figure}`;
            return askSuccess({
              summary,
              records,
              provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.rows.length),
              access_note: mergeAccessNotes(
                `Aantal inwoners van ${area} (${out.code}) uit ${tableName}: totaal van alle leeftijden, beide geslachten; per jaar de bevolking op 1 januari, en het jaargemiddelde (leeg voor een jaar dat nog loopt). Andere uitsplitsingen: cbs_observations met tableId ${CBS_POPULATION_TABLE}.`,
                yearNote,
                formerNote,
              ),
              total: out.rows.length,
            });
          }
          if (out.kind === "ambiguous") {
            const records = out.candidates.map((c) => record("cbs", c.naam, tableUrl, { gemeente: c.naam, gemeentecode: c.code, tabel: CBS_POPULATION_TABLE }, `Gemeente ${c.code}`));
            return askSuccess({
              summary: `Router: CBS bevolking — '${populationPlace}' is de naam van ${out.candidates.length} gemeenten; kies er een`,
              records,
              provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, records.length),
              access_note: `Geen aantal gegeven: '${populationPlace}' past bij meer dan één gemeente in ${tableName} (${out.candidates.map((c) => `${c.naam}, ${c.code}`).join("; ")}). Vraag het opnieuw met de naam zoals hier, of gebruik cbs_observations met tableId ${CBS_POPULATION_TABLE} en RegioS.`,
              total: records.length,
            });
          }
          // No municipality, province or country of that name ("Amsterdam-Noord",
          // "Bonaire"): the CBS tables below, and the answer says no number was found.
          fallbackSteps.push(`cbs:population:no_gemeente:${populationPlace}`);
          populationNote = `Geen aantal inwoners gegeven: '${populationPlace}' is geen gemeente, provincie of 'Nederland' in ${tableName} (een wijk, woonplaats of gebied buiten Europees Nederland staat daar niet in). Hieronder wat de rest van de vraag vond; voor wijken en buurten: cbs_tables_search 'kerncijfers wijken en buurten'.`;
        } catch (e) {
          fallbackSteps.push("cbs:population:failed");
          const mapped = mapSourceError(e, "CBS bevolking");
          routeFailures.push({ connector: "cbs", error_type: mapped.error, message: mapped.message });
        }

        const candidates = [makeCbsQuery(questionForSearch), questionForSearch];
        if (q.includes("inwoner") || q.includes("population")) candidates.push("bevolking");
        if (q.includes("opleidingsniveau") || q.includes("opleiding")) candidates.push("opleidingsniveau gemeenten");
        if (q.includes("werkloos")) candidates.push("werkloosheid");
        // Appended last: progressively narrower topic terms for questions the
        // full-sentence candidates cannot match (see cbsNarrowingCandidates).
        candidates.push(
          ...cbsNarrowingCandidates(makeStrictQuery(questionForSearch), extractPlaceName(decodedQuestion)),
        );

        let usedCbsQuery = candidates[0] || questionForSearch;
        let out = await timed("cbs", () => cbs.searchTables(usedCbsQuery, Math.max(top, 8)));
        let items = cbsItems(out);

        if (!items.length) {
          for (const candidate of candidates.slice(1)) {
            if (!candidate || !candidate.trim()) continue;
            fallbackSteps.push(`cbs:fallback_candidate:${candidate}`);
            out = await timed("cbs", () => cbs.searchTables(candidate, Math.max(top, 8)));
            items = cbsItems(out);
            usedCbsQuery = candidate;
            if (items.length) break;
          }
        }

        if (items.length) {
          const sorted = [...items].sort((a, b) => scoreCbsTable(b) - scoreCbsTable(a));
          const municipalityEducation = (q.includes("gemeente") || q.includes("municipality")) && (q.includes("opleidingsniveau") || q.includes("opleiding") || q.includes("education"));

          if (municipalityEducation) {
            const best = sorted[0];
            const bestTableId = String(best.Identifier ?? best.id ?? "");
            if (bestTableId) {
              try {
                const obsOut = await timed("cbs", () => cbs.getObservations({ tableId: bestTableId, top }));
                const obsRecords = obsOut.items.map((x) => record("cbs", `Observatie ${bestTableId}`, `https://opendata.cbs.nl/#/CBS/nl/dataset/${bestTableId}`, x));
                if (obsRecords.length) {
                  const trendMeasure = obsOut.items.find((x) => typeof x.trend_measure === "string")?.trend_measure as string | undefined;
                  return askSuccess({
                    summary: `Router: CBS observaties (${obsRecords.length} resultaten)`,
                    records: obsRecords,
                    provenance: prov("nl_gov_ask", obsOut.endpoint, obsOut.params, obsRecords.length, obsRecords.length),
                    total: obsRecords.length,
                    access_note: mergeAccessNotes(queryNote(usedCbsQuery), trendMeasure ? `CBS trend enrichment applied for measure ${trendMeasure} (previous_period, previous_value, delta, delta_pct).` : undefined),
                  });
                }
              } catch {
                // fall through to table-level response
              }
            }
          }

          const records = sorted.slice(0, top).map((x) => record("cbs", String(x.Title ?? x.Identifier ?? "CBS"), cbsCatalogItemUrl(x), x));
          // items.length is de gefetchte buffer, niet de echte upstream-total, en kan
          // groter zijn dan de teruggegeven records (sorted.slice(0, top)); null zodat
          // has_more niet onterecht true wordt buiten de beschikbare records.
          return askSuccess({ summary: `Router: CBS (${records.length} resultaten${populationNote ? `; geen aantal inwoners voor '${populationPlace}'` : ""})`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, items.length), access_note: queryNote(usedCbsQuery), total: null });
        }
        routeEmpty("CBS", "cbs:no_results");
      }

      // A named municipality plus a policy or council question: its council
      // documents in Open Raadsinformatie answer it ("GGZ-beleid gemeente
      // Utrecht"); national sources would return other places' news.
      // ORI's explanation when it has no index for the municipality: that is
      // not an empty result, and the answer given instead says so.
      let oriScopeNote: string | undefined;
      /**
       * The text of the best document among ORI hits (ori_document_get), within
       * ORI_DEEP_FETCH_DEADLINE_MS: the record that replaces it, or a note why not.
       */
      const oriDeepFetch = async (items: Array<Record<string, unknown>>): Promise<{ record?: MCPRecord; position?: number; note: string }> => {
        const position = items.findIndex((x) => x.type === "MediaObject" && typeof x.index === "string" && typeof x.id === "string");
        if (position < 0) return { note: "Geen document onder de treffers om de tekst van mee te geven (alleen vergaderingen of agendapunten); hun documenten staan in attachment_ids, te lezen met ori_document_get." };
        const best = items[position];
        const index = String(best.index);
        const id = String(best.id);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const fetchDoc = timed("ori", () => ori.getDocument({ index, id, max_chars: 4000 }));
        fetchDoc.catch(() => undefined);
        const deadline = new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => resolve("deadline"), ORI_DEEP_FETCH_DEADLINE_MS);
        });
        const more = `De hele tekst of de pagina's met een zoekterm: ori_document_get (index '${index}', id '${id}').`;
        try {
          const res = await Promise.race([fetchDoc, deadline]);
          if (res === "deadline") {
            fallbackSteps.push(`ori:deep_fetch_deadline:${index}/${id}`);
            return { note: `De tekst van het bovenste document is niet afgewacht (geen antwoord binnen ${Math.round(ORI_DEEP_FETCH_DEADLINE_MS / 1000)} s). ${more}` };
          }
          const item = res.item;
          if (!item || !item.text_available || typeof item.text !== "string") {
            return { note: `ORI heeft geen tekst van het bovenste document ('${String(best.title ?? id)}'). ${more}` };
          }
          const text = item.text;
          const deepRecord = record("ori", String(item.title ?? best.title ?? id), String(item.url ?? best.url ?? res.endpoint), item, text.slice(0, 300), String(item.publishedAt ?? best.publishedAt ?? ""));
          return {
            record: deepRecord,
            position,
            note: `Omdat de vraag om de inhoud vroeg, staat de tekst van het bovenste document ('${String(item.title ?? id)}') erbij: ${text.length} tekens${item.text_truncated ? ", afgekapt" : ""}, ORI's automatische tekstextractie. ${more}`,
          };
        } catch {
          fallbackSteps.push(`ori:deep_fetch_failed:${index}/${id}`);
          return { note: `De tekst van het bovenste document ophalen is mislukt. ${more}` };
        } finally {
          clearTimeout(timer);
        }
      };
      if (takes("ori_gemeente") && gemeenteForOri) try {
        const gemeente = gemeenteForOri;
        if (gemeenteTerms.length) {
          const oriQuery = toOriQuery(gemeenteTerms);
          const out = await timed("ori", () => ori.search({ query: oriQuery, rows: top, gemeente }));
          let records = out.items.map(oriRecord);
          if (records.length) {
            // A question for the content ("vat samen", "wat staat erin"): the text of
            // the best document goes along, as the Tweede Kamer route does, when ORI
            // gives it within the time budget.
            const deep = shouldDeepenTweedeKamerQuery(decodedQuestion) ? await oriDeepFetch(out.items) : undefined;
            if (deep?.record) records = [deep.record, ...records.filter((_, i) => i !== deep.position)];
            return askSuccess({
              summary: `Router: Open Raadsinformatie ${gemeente} (${records.length} resultaten${deep?.record ? ", bovenste document verdiept" : ""})`,
              records,
              provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total),
              access_note: mergeAccessNotes(
                queryNote(oriQuery),
                `Vraag over gemeente ${gemeente}: gezocht in de raadsinformatie van die gemeente (Open Raadsinformatie).`,
                temporal ? "De periode uit de vraag is niet toegepast: deze ORI-zoekopdracht heeft geen datumfilter." : undefined,
                deep?.note,
                out.access_note,
              ),
              total: out.total,
            });
          }
          if (out.no_index) {
            // Nothing was searched: ORI holds no council records under this name.
            fallbackSteps.push(`ori:${gemeente}:no_index`);
            triedRoutes.push(`Open Raadsinformatie ${gemeente} (geen ORI-index, niet gezocht)`);
            oriScopeNote = out.access_note;
          } else {
            routeEmpty(`Open Raadsinformatie ${gemeente}`, `ori:${gemeente}:no_results`);
          }
        }
      } catch (e) {
        routeFailed(`Open Raadsinformatie ${gemeenteForOri}`, "ori", e);
      }

      if (takes("tk")) {
        // Topic words first, without the words that picked this route: every
        // term must occur in the title or subject, so "moties over stikstof"
        // found nothing and fell through to the bare candidate "motie" - the
        // latest motions on any subject. A multi-word term goes as a phrase
        // first ("Ring Utrecht", "Belastingdienst Toeslagen"), then as loose
        // words: a run of capitalised words is often no phrase in the papers
        // ("Schiphol Geluidsoverlast", "Wet Kwaliteitsborging Bouwen" for the
        // "Wet kwaliteitsborging voor het bouwen"), and as a phrase alone it
        // found nothing where the words found the papers. Both with the
        // document type the question names first.
        const tkCandidates: Array<{ query: string; type?: string }> = [];
        if (tkTopic) {
          const topicForms = [tkNamedTopic, tkLooseTopic];
          if (tkType) for (const query of topicForms) tkCandidates.push({ query, type: tkType });
          for (const query of topicForms) tkCandidates.push({ query });
          // Several topic terms rarely all stand in one title or subject
          // ("stikstof landbouw"): try the most specific ones on their own,
          // with the document type the question names. Never the bare type:
          // "motie" returns the latest motions on any subject, which read as an
          // answer about the topic.
          for (const term of [...tkTopicTerms].sort((a, b) => b.length - a.length).slice(0, tkTopicTerms.length > 1 ? 3 : 0)) {
            tkCandidates.push({ query: toPhraseQuery([term], nameTerms), ...(tkType ? { type: tkType } : {}) });
          }
        } else {
          // No topic ("Welke moties zijn er deze week ingediend?"): the latest
          // papers of the kind asked for are the answer.
          if (tkType) tkCandidates.push({ query: "", type: tkType });
          tkCandidates.push({ query: makeModerateQuery(questionForSearch) }, { query: questionForSearch });
        }
        const seenTk = new Set<string>();
        const uniqueTkCandidates = tkCandidates.filter((c) => {
          const key = `${c.query.trim().toLowerCase()}|${c.type ?? ""}`;
          if ((!c.query.trim() && !c.type) || seenTk.has(key)) return false;
          seenTk.add(key);
          return true;
        });

        // Without $count (count: false): this route reports the records it
        // holds, not the source's total, and the count made every search take
        // about twice as long (a phrase and then its words: 10-12 s, 5-7 s
        // without). The searches go one after the other, not side by side:
        // two at once each took as long as both in a row (October 2026), so
        // a phrase that answers alone would only have waited for the other.
        const searchTk = (candidate: { query: string; type?: string }) =>
          timed("tweede_kamer", () => tk.searchDocuments({ query: candidate.query, type: candidate.type, top, date_from: temporal?.from, date_to: temporal?.to, count: false }));

        let usedTk = uniqueTkCandidates[0] ?? { query: questionForSearch };
        let out = await searchTk(usedTk);
        let records = out.items.map(tkDocumentRecord);

        if (!records.length) {
          for (const candidate of uniqueTkCandidates.slice(1)) {
            fallbackSteps.push(`tweede_kamer:fallback_candidate:${candidate.query}${candidate.type ? ` (type ${candidate.type})` : ""}`);
            out = await searchTk(candidate);
            records = out.items.map(tkDocumentRecord);
            usedTk = candidate;
            if (records.length) break;
          }
        }

        // A name that few papers hold as a phrase hid the many that hold its
        // words apart: it can stand as a phrase in one motion's title, while
        // dozens of motions have its first word as their dossier title and
        // the other in their subject. When the phrase finds fewer papers than
        // asked for, the names as their words (tkTopic, with the same type)
        // fill the rest, after the phrase hits and marked in data.match. A
        // phrase that fills the page needs no second search; a phrase the
        // question holds (quoted, or a fixed word group) is not taken apart.
        let tkItems = out.items;
        let tkSourceNotes = out.notes;
        let tkSupplementNote: string | undefined;
        let tkParams = out.params;
        if (tkItems.length && tkItems.length < top && usedTk.query === tkNamedTopic && tkTopic !== tkNamedTopic) {
          const supplementType = usedTk.type;
          fallbackSteps.push(`tweede_kamer:loose_supplement:${tkTopic}${supplementType ? ` (type ${supplementType})` : ""}`);
          const phrases = tkNameTopicTerms.map((term) => `"${term}"`).join(" en ");
          const phraseCount = `${tkItems.length} ${tkItems.length === 1 ? "document bevat" : "documenten bevatten"} ${phrases} als woordgroep`;
          // "Afzonderlijk", not "los": the term notes say "los woord" for a whole word.
          const apart = `dezelfde woorden afzonderlijk (${tkTopic})`;
          try {
            const extra = await searchTk({ query: tkTopic, type: supplementType });
            const idOf = (item: Record<string, unknown>) => (typeof item.Id === "string" ? item.Id.trim() : "");
            const seen = new Set(tkItems.map(idOf).filter(Boolean));
            const added = extra.items
              .filter((item) => !idOf(item) || !seen.has(idOf(item)))
              .slice(0, top - tkItems.length)
              .map((item) => ({ ...item, match: TK_WORDS_APART }));
            if (added.length) {
              tkItems = [...tkItems, ...added];
              tkSourceNotes = [...new Set([...tkSourceNotes, ...extra.notes])];
              tkParams = { ...tkParams, supplement_query: tkTopic };
              tkSupplementNote = `${phraseCount}; aangevuld met ${added.length} ${added.length === 1 ? "document" : "documenten"} met ${apart}, gemarkeerd met data.match '${TK_WORDS_APART}'.`;
            } else {
              tkSupplementNote = `${phraseCount}; geen andere documenten met ${apart}.`;
            }
          } catch {
            fallbackSteps.push("tweede_kamer:loose_supplement_failed");
            tkSupplementNote = `${phraseCount}; aanvullen met documenten met ${apart} is mislukt.`;
          }
          records = tkItems.map(tkDocumentRecord);
        }
        // "deze week", "onlangs": left out of the search terms, but no date
        // filter either; say so, so the newest papers do not read as filtered.
        const tkTimePhrases = looseTimePhrases(questionForSearch);
        const tkNote = mergeAccessNotes(
          queryNote(usedTk.query),
          usedTk.type ? `Gefilterd op documentsoort '${usedTk.type}'.` : undefined,
          tkSupplementNote,
          // How Tweede Kamer matched the terms: a term of up to three letters
          // ("woz", "ov") only as a whole word, in which spellings, and any
          // term it could not apply. Its advice to quote a longer term is for
          // tweede_kamer_documents: quotes in a question do not reach it.
          ...tkSourceNotes.map((note) => note.replace(/ Alleen het losse woord: .*$/, "")),
          tkTimePhrases.length
            ? `Tijdsaanduiding ${tkTimePhrases.map((p) => `'${p}'`).join(", ")} is niet als datumfilter toegepast; de nieuwste documenten staan bovenaan.`
            : undefined,
        );

        if (records.length) {
          const shouldDeepen = shouldDeepenTweedeKamerQuery(decodedQuestion);
          if (shouldDeepen) {
            const topMatch = tkItems.find((item) => typeof item.Id === "string" && item.Id.trim()) as Record<string, unknown> | undefined;
            const topMatchId = typeof topMatch?.Id === "string" ? topMatch.Id.trim() : "";

            if (topMatchId) {
              try {
                const deepOut = await timed("tweede_kamer", () => tk.getDocument({
                  id: topMatchId,
                  resolve_resource: true,
                  include_text: true,
                  max_chars: 4000,
                }));
                const deepRecordData = deepOut.item as Record<string, unknown>;
                const deepSnippet = typeof deepRecordData.text_preview === "string"
                  ? deepRecordData.text_preview
                  : String(deepRecordData.Onderwerp ?? "");
                const deepRecord = record(
                  "tweedekamer",
                  tkSubjectTitle(deepRecordData, topMatchId),
                  String(deepRecordData.resolved_resource_url ?? deepRecordData.resource_url ?? "https://www.tweedekamer.nl"),
                  deepRecordData,
                  deepSnippet,
                  String(deepRecordData.Datum ?? ""),
                );

                const remainingRecords = records.filter((candidate) => {
                  const id = (candidate.data ?? {}) as Record<string, unknown>;
                  return String(id.Id ?? id.id ?? "") !== topMatchId;
                });

                const deepAccessNotes: string[] = [
                  "Top Tweede Kamer match was verdiept because the question asked for content/summary rather than only discovery.",
                ];

                if (typeof deepRecordData.text_preview === "string") {
                  deepAccessNotes.push(`Included capped text preview for top match (${deepRecordData.text_preview.length} chars${deepRecordData.text_preview_truncated ? ", truncated" : ""}).`);
                }

                return askSuccess({
                  summary: `Router: Tweede Kamer (${records.length} resultaten, top match verdiept)`,
                  records: [deepRecord, ...remainingRecords],
                  provenance: prov("nl_gov_ask", deepOut.endpoint, { ...tkParams, deep_document_id: topMatchId }, records.length, records.length),
                  total: records.length,
                  access_note: mergeAccessNotes(tkNote, deepAccessNotes.join(" ")),
                });
              } catch {
                fallbackSteps.push(`tweede_kamer:deep_fetch_failed:${topMatchId}`);
              }
            }
          }

          return askSuccess({ summary: `Router: Tweede Kamer (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, tkParams, records.length, records.length), access_note: tkNote, total: records.length });
        }
        // An honest 0 beats the latest papers on another subject.
        routeEmpty("Tweede Kamer", "tweede_kamer:no_results");
      }

      if (takes("ob")) try {
        // Keywords, not the sentence: the SRU search ANDs every word, so "Wat
        // staat er in ..." made each of those words mandatory. A journal the
        // question names ("in de Staatscourant") is a filter, not a word.
        // A refused query was not searched; that is no "0 resultaten".
        const ob = obSearch();
        const { out, query: obQuery } = await searchBekendmakingen(ob.query, ob.looseQuery, { maximumRecords: top, publicatieblad: ob.publicatieblad, sort: ob.sort, date_from: temporal?.from, date_to: temporal?.to });
        const records = out.items.map((x)=>record("officielebekendmakingen", String(x.title ?? x.identifier ?? "Bekendmaking"), String(x.canonical_url ?? x.identifier ?? "https://zoek.officielebekendmakingen.nl"), x as Record<string, unknown>));
        if (records.length) {
          const looseNote = obQuery !== ob.query ? `Met woordgroep niets gevonden voor ${ob.query}; daarom gezocht op de losse woorden.` : undefined;
          return askSuccess({ summary: `Router: Bekendmakingen (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: mergeAccessNotes(queryNote(obQuery), looseNote, ob.note), total: out.total });
        }
        routeEmpty("Officiële Bekendmakingen", "officiele_bekendmakingen:no_results");
      } catch (e) {
        // As the other routes: a failing source does not sink the router.
        routeFailed("Officiële Bekendmakingen", "officiele_bekendmakingen", e);
      }

      // Organisation and policy questions ("Wat doet de Belastingdienst met
      // de BTW?", "Wat is het kabinetsbeleid over stikstof?") are answered by
      // documents, not datasets: search official publications, parliament,
      // government news and, for municipal questions, council documents in
      // parallel. With a strong signal this runs here, before the Rijksoverheid
      // route, which would answer any question containing "beleid" with national
      // news only; otherwise it runs after the remaining routes (below).
      let policyNote: string | undefined;
      let policySearched = false;
      const runPolicySearch = async () => {
        policySearched = true;
        const plainQuery = policyTerms.join(" ");
        // Officiële Bekendmakingen and Tweede Kamer read a quoted phrase, as
        // ORI does: a phrase the question holds ("open data portaal", a
        // quoted term) is one phrase for each of them. A run of capitalised
        // words goes as its words (nameTerms): one search each, and such a
        // name is often no phrase in the documents. Rijksoverheid gets the
        // words.
        const phraseQuery = toPhraseQuery(policyTerms, nameTerms);
        const oriQuery = policyOriQuery;
        const oriPlaceNote = policyIntent?.municipal && policyIntent.gemeente && oriQuery.includes(oriPlacePhrase(policyIntent.gemeente))
          ? `Open Raadsinformatie is in alle raden doorzocht met de gemeente als woordgroep (${oriPlacePhrase(policyIntent.gemeente)}), niet als los woord.`
          : undefined;
        // ORI gives a lower bound instead of a total above 10,000 hits.
        type PolicyHit = { connector: string; label: string; records: MCPRecord[]; endpoint: string; params: Record<string, string>; total: number | null | undefined; totalLowerBound?: number };
        const jobs: Array<{ connector: string; label: string; run: () => Promise<PolicyHit> }> = [];
        if (policyIntent?.municipal) {
          jobs.push({
            connector: "ori",
            label: "Open Raadsinformatie",
            run: async () => {
              const out = await timed("ori", () => ori.search({ query: oriQuery, rows: top }));
              const records = out.items.map(oriRecord);
              return { connector: "ori", label: "Open Raadsinformatie", records, endpoint: out.endpoint, params: out.params, total: out.total, totalLowerBound: out.total_lower_bound };
            },
          });
        }
        jobs.push({
          connector: "officiele_bekendmakingen",
          label: "Officiële Bekendmakingen",
          run: async () => {
            const { out } = await searchBekendmakingen(phraseQuery, plainQuery, { maximumRecords: top, date_from: temporal?.from, date_to: temporal?.to });
            const records = out.items.map((x) => record("officielebekendmakingen", String(x.title ?? x.identifier ?? "Bekendmaking"), String(x.canonical_url ?? x.identifier ?? "https://zoek.officielebekendmakingen.nl"), x as Record<string, unknown>, String(x.authority ?? ""), String(x.date ?? "")));
            return { connector: "officiele_bekendmakingen", label: "Officiële Bekendmakingen", records, endpoint: out.endpoint, params: out.params, total: out.total };
          },
        });
        // Tweede Kamer requires every term in the title or subject, as the
        // other sources do, so it joins for any number of terms.
        jobs.push({
          connector: "tweede_kamer",
          label: "Tweede Kamer",
          run: async () => {
            const out = await timed("tweede_kamer", () => tk.searchDocuments({ query: phraseQuery, top, date_from: temporal?.from, date_to: temporal?.to }));
            const records = out.items.map(tkDocumentRecord);
            return { connector: "tweede_kamer", label: "Tweede Kamer", records, endpoint: out.endpoint, params: out.params, total: out.total };
          },
        });
        jobs.push({
          connector: "rijksoverheid",
          label: "Rijksoverheid",
          run: async () => {
            const out = await timed("rijksoverheid", () => rijksoverheid.search({ query: plainQuery, top, date_from: temporal?.from, date_to: temporal?.to }));
            const records = out.items.map((x) => record("rijksoverheid", String(x.title ?? x.id ?? "Rijksoverheid"), String(x.canonical ?? x.url ?? "https://www.rijksoverheid.nl"), x, String(x.snippet ?? ""), String(x.date ?? "")));
            return { connector: "rijksoverheid", label: "Rijksoverheid", records, endpoint: out.endpoint, params: out.params, total: out.total };
          },
        });

        // One slow source (Tweede Kamer often needs 30 s) must not hold up the
        // others: after the deadline the answer goes out without it, and says so.
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<"deadline">((resolve) => {
          deadlineTimer = setTimeout(() => resolve("deadline"), POLICY_SEARCH_DEADLINE_MS);
        });
        const settled = await Promise.allSettled(jobs.map((job) => Promise.race([job.run(), deadline])));
        clearTimeout(deadlineTimer);

        const policyFailures: AskFailures = [];
        const hits: PolicyHit[] = [];
        const sourceNotes: string[] = [];
        settled.forEach((result, idx) => {
          const job = jobs[idx];
          if (result.status === "fulfilled" && result.value !== "deadline") {
            hits.push(result.value);
            sourceNotes.push(`${job.label} ${result.value.records.length}`);
            return;
          }
          if (result.status === "fulfilled") {
            const seconds = Math.round(POLICY_SEARCH_DEADLINE_MS / 1000);
            policyFailures.push({ connector: job.connector, error_type: "timeout", message: `${job.label} gaf binnen ${seconds} s geen antwoord; niet op gewacht.` });
            sourceNotes.push(`${job.label} niet afgewacht (geen antwoord binnen ${seconds} s)`);
            return;
          }
          const mapped = mapSourceError(result.reason, job.label);
          policyFailures.push({ connector: job.connector, error_type: mapped.error, message: mapped.message });
          sourceNotes.push(result.reason instanceof BekendmakingenRefusedError ? `${job.label} weigerde de zoekvraag (niet gezocht)` : `${job.label} mislukt (${mapped.error})`);
        });
        const perSource = sourceNotes.join(", ");

        // Interleave the sources so the first page shows each of them, rather
        // than `top` records of whichever source happened to come first.
        const interleaved: MCPRecord[] = [];
        const longest = Math.max(0, ...hits.map((h) => h.records.length));
        for (let i = 0; i < longest; i++) {
          for (const hit of hits) {
            const rec = hit.records[i];
            if (!rec) continue;
            interleaved.push({
              ...rec,
              data: {
                ...(rec.data ?? {}),
                _provenance: {
                  connector: hit.connector,
                  endpoint: hit.endpoint,
                  query_params: hit.params,
                  returned_results: hit.records.length,
                  total_results: hit.total ?? null,
                  ...(hit.totalLowerBound !== undefined ? { total_lower_bound: hit.totalLowerBound } : {}),
                },
              },
            });
          }
        }
        const merged = dedupeMergedRecords(interleaved);

        if (merged.length) {
          const sources = hits.filter((h) => h.records.length).map((h) => h.connector);
          return askSuccess({
            summary: `Router: organisatie/beleid (${merged.length} resultaten uit ${sources.length} bronnen)`,
            records: merged,
            provenance: prov("nl_gov_ask", "policy-router", { question: decodedQuestion, query: plainQuery, sources: sources.join(",") }, merged.length, merged.length),
            access_note: mergeAccessNotes(
              queryNote(plainQuery),
              oriScopeNote,
              `Vraag behandeld als organisatie- of beleidsvraag: gezocht in documenten in plaats van in de datasetcatalogus. Resultaten per bron: ${perSource}.`,
              temporalNote,
              policyIntent?.municipal && temporal ? "Open Raadsinformatie is zonder datumfilter doorzocht." : undefined,
              oriPlaceNote,
            ),
            failures: policyFailures.length ? policyFailures : undefined,
            total: merged.length,
          });
        }

        fallbackSteps.push("policy:no_results");
        routeFailures.push(...policyFailures);
        policyNote = `Ook als organisatie- of beleidsvraag niets gevonden (${perSource}).`;
        return undefined;
      };

      if (takes("policy_early")) {
        const answered = await runPolicySearch();
        if (answered) return answered;
      }

      if (takes("rijk")) {
        const rijkQuery = makeKeywordQuery(questionForSearch) || questionForSearch;
        let out = await timed("rijksoverheid", () => rijksoverheid.search({ query: rijkQuery, top, date_from: temporal?.from, date_to: temporal?.to }));
        let records = out.items.map((x)=>record("rijksoverheid", String(x.title ?? x.id ?? "Rijksoverheid"), String(x.canonical ?? x.url ?? "https://www.rijksoverheid.nl"), x));

        if (!records.length && (q.includes("schoolvakantie") || q.includes("schoolvakanties"))) {
          fallbackSteps.push("rijksoverheid:search:fallback_schoolvakantie");
          out = await timed("rijksoverheid", () => rijksoverheid.search({ query: "schoolvakantie", top }));
          records = out.items.map((x)=>record("rijksoverheid", String(x.title ?? x.id ?? "Rijksoverheid"), String(x.canonical ?? x.url ?? "https://www.rijksoverheid.nl"), x));
        }

        if (records.length) {
          return askSuccess({ summary: `Router: Rijksoverheid (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: queryNote(String(out.params.query ?? rijkQuery)), total: out.total });
        }
        routeEmpty("Rijksoverheid", "rijksoverheid:no_results");
      }

      if (takes("budget")) {
        const budgetQuery = makeKeywordQuery(questionForSearch) || questionForSearch;
        const out = await timed("rijksbegroting", () => rijksbegroting.search(budgetQuery, top));
        const records = out.items.map((x)=>record("rijksbegroting", String(x.name ?? x.id ?? "Rijksbegroting"), String(x.url ?? "https://opendata.rijksbegroting.nl"), x));
        if (records.length) {
          return askSuccess({ summary: `Router: Rijksbegroting (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: queryNote(budgetQuery), total: out.total });
        }
        routeEmpty("Rijksbegroting", "rijksbegroting:no_results");
      }

      if (takes("duo")) {
        const duoQuery = makeKeywordQuery(questionForSearch) || questionForSearch;
        const out = await timed("duo", () => duo.datasetsCatalog(duoQuery, top));
        const records = out.items.map((x)=>record("duo", String(x.title ?? x.name ?? x.id ?? "DUO"), String(x.url ?? "https://onderwijsdata.duo.nl"), x));
        if (records.length) {
          return askSuccess({ summary: `Router: DUO (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: queryNote(duoQuery), total: out.total });
        }
        routeEmpty("DUO-datasets", "duo:catalog_no_results");
      }

      if (takes("knmi")) {
        if (!knmiKey) {
          return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI route vereist KNMI_API_KEY", suggestion: "Set KNMI_API_KEY and use knmi_* tools" }));
        }
        // As knmi_latest_observations, knmi_warnings and knmi_earthquakes: the newest files of that dataset.
        const { label, tool } = KNMI_KINDS[knmiKind];
        try {
          const source = new KnmiSource(config, knmiKey);
          const out: { items: Array<Record<string, unknown>>; endpoint: string; params: Record<string, string>; access_note?: string } = await timed("knmi", async () =>
            knmiKind === "warnings" ? source.warnings(top) : knmiKind === "earthquakes" ? source.earthquakes(top) : source.latestObservations(top));
          const records = out.items.map((x) => record("knmi", String(x.filename ?? x.name ?? `KNMI ${label}`), "https://developer.dataplatform.knmi.nl", x, undefined, String(x.lastModified ?? x.created ?? "")));
          if (records.length) {
            return askSuccess({
              summary: `Router: KNMI ${label} (${records.length} bestanden)`,
              records,
              provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, records.length),
              access_note: mergeAccessNotes(
                `Vraag over weer of klimaat: de nieuwste ${label}-bestanden van het KNMI Data Platform, zoals ${tool}. Dit zijn databestanden (bestandsnaam, tijd, grootte), geen uitgelezen meetwaarden of verwachting; de bestanden zelf zijn via het KNMI Data Platform te downloaden.`,
                out.access_note,
              ),
              total: records.length,
            });
          }
          routeEmpty(`KNMI ${label}`, `knmi:${knmiKind}:no_results`);
        } catch (e) {
          routeFailed(`KNMI ${label}`, "knmi", e, `knmi:${knmiKind}:failed`);
        }
      }

      if (takes("api")) {
        const apiKey = process.env[ENV_KEYS.OVERHEID_API_KEY];
        if (!apiKey) {
          return toMcpToolPayload(errorResponse({ error: "not_configured", message: "OVERHEID_API_KEY ontbreekt voor API-register queries", suggestion: "Set OVERHEID_API_KEY" }));
        }
        const apiQuery = makeKeywordQuery(questionForSearch) || questionForSearch;
        try {
          const out = await timed("api_register", () => new ApiRegisterSource(config, apiKey).search(apiQuery, top));
          const records = out.items.map((x)=>record("api-register", String(x.name ?? x.title ?? x.id ?? "API"), String(x.portalUrl ?? x.url ?? "https://apis.developer.overheid.nl"), x));
          if (records.length) {
            return askSuccess({ summary: `Router: API Register (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, records.length), access_note: mergeAccessNotes(queryNote(apiQuery), "Requires OVERHEID_API_KEY"), total: records.length });
          }
          routeEmpty("API-register", "api_register:no_results");
        } catch (apiError) {
          const mapped = mapSourceError(apiError, "API Register", "https://apis.developer.overheid.nl");
          return toMcpToolPayload(errorResponse({
            error: mapped.error,
            message: mapped.message,
            suggestion: mapped.suggestion,
            retry_after: mapped.retry_after,
            details: {
              ...(mapped.details ?? {}),
              connector: "api_register",
              route: "nl_gov_ask",
            },
          }));
        }
      }

      if (takes("rechtspraak")) {
        const rq = makeRechtspraakQuery(questionForSearch) || questionForSearch;
        try {
          const out = await timed("rechtspraak", () => rechtspraak.searchEcli({ query: rq, rows: top, sort: "relevance" }));
          const records = out.items
            .filter((x) => Boolean(x.ecli))
            .map((x) => record("rechtspraak", String(x.title ?? x.ecli ?? x.id ?? "Rechtspraak uitspraak"), String(x.link ?? x.id ?? "https://data.rechtspraak.nl"), x as Record<string, unknown>, String(x.summary ?? x.ecli ?? ""), String(x.updated ?? "")));
          if (records.length) {
            return askSuccess({ summary: `Router: Rechtspraak (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: mergeAccessNotes(queryNote(rq), (out as { access_note?: string }).access_note), total: out.total });
          }
          routeEmpty("Rechtspraak", "rechtspraak:no_results");
        } catch (e) {
          routeFailed("Rechtspraak", "rechtspraak", e);
        }
      }

      // A weak signal (only an organisation noun or a named municipality), or a
      // strong one on a budget question: documents after every route its
      // words picked, before the catalogue.
      if (takes("policy") && !policySearched) {
        const answered = await runPolicySearch();
        if (answered) return answered;
      }

      // Last resort: the dataset catalogue. It ANDs every word against dataset
      // metadata, so the full sentence ("Wat doet de Belastingdienst met de BTW?")
      // matched nothing; search the topic words instead.
      const catalogQuery = makeKeywordQuery(questionForSearch, catalogRouteWords) || questionForSearch;
      const out = await timed("data_overheid", () => dataOverheid.datasetsSearch({ query: catalogQuery, rows: top }));
      const records = out.items.map((d) => record("data.overheid.nl", String(d.title ?? d.id), `https://data.overheid.nl/dataset/${d.id}`, d as unknown as Record<string, unknown>, d.notes, d.metadata_modified));
      // Name the routes that ran: "no source recognised" is only true when
      // none did, and a failed source must not read as an empty one.
      const recognised = triedRoutes.length > 0 || policyNote !== undefined || dsoNote !== undefined || debatNote !== undefined || algoritmeNote !== undefined || subsidieNote !== undefined || wetNote !== undefined;
      const triedNote = triedRoutes.length ? `Eerst geprobeerd, zonder resultaat: ${[...new Set(triedRoutes)].join(", ")}.` : undefined;
      const catalogNote = records.length
        ? recognised
          ? "Daarom teruggevallen op de datasetcatalogus van data.overheid.nl; dit zijn datasets, geen antwoord van de herkende bron."
          : "Geen specifieke bron herkend voor deze vraag; dit zijn datasets uit de catalogus van data.overheid.nl."
        : `${recognised ? "Ook in de datasetcatalogus van data.overheid.nl zijn geen datasets gevonden." : "Geen specifieke bron herkend en geen datasets gevonden in data.overheid.nl."} Gebruik voor documenten een gerichte tool, zoals officiele_bekendmakingen_search, tweede_kamer_documents of ori_search (met 'gemeente').`;
      return askSuccess({
        summary: `Router fallback: data.overheid (${records.length} resultaten)`,
        records,
        provenance: prov("nl_gov_ask", out.endpoint, out.query, records.length, out.total),
        access_note: mergeAccessNotes(queryNote(catalogQuery), triedNote, oriScopeNote, policyNote, catalogNote),
        total: out.total,
      });
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "nl_gov_ask"));
    }
  });
}
