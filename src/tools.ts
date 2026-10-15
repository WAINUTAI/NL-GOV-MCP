import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, ENV_KEYS } from "./config.js";
import { DataOverheidSource } from "./sources/data-overheid.js";
import { CbsSource, cbsCatalogItemUrl } from "./sources/cbs.js";
import { TweedeKamerSource, mapTweedeKamerError, tkRecordView, tkSubjectTitle } from "./sources/tweede-kamer.js";
import { DEBAT_DEFAULT_CHARS, DEBAT_DEFAULT_DAYS, DEBAT_MAX_CHARS, DEBAT_MAX_VERSLAGEN, TweedeKamerDebattenSource, type DebatFragment, type DebatHit, type DebatSearchResult } from "./sources/tweede-kamer-debatten.js";
import { BekendmakingenSource, AUTHORITY_TYPES, MAX_TEXT_CHARS, SRU_MAX_START_RECORD, bekendmakingSnippet, normalizeBekendmakingIdentifier, rewriteKeepingSyntax } from "./sources/bekendmakingen.js";
import { RijksoverheidSource } from "./sources/rijksoverheid.js";
import { RijksbegrotingSource } from "./sources/rijksbegroting.js";
import { DuoSource } from "./sources/duo.js";
import { ApiRegisterSource } from "./sources/api-register.js";
import { KnmiSource } from "./sources/knmi.js";
import { PdokSource } from "./sources/pdok.js";
import { ORI_ID_RE, ORI_INDEX_RE, ORI_PAGINA_RE, ORI_TEXT_DEFAULT_CHARS, ORI_TEXT_MAX_CHARS, OriSource, oriDocumentFailureHint, oriFailureHint, parsePagina } from "./sources/ori.js";
import { NdwSource } from "./sources/ndw.js";
import { LuchtmeetnetSource } from "./sources/luchtmeetnet.js";
import { RechtspraakSource, UITSPRAAK_DEFAULT_CHARS, UITSPRAAK_MAX_CHARS, readEcliInput, sectieIsReadable, selectUitspraakText, tuchtrechtUrl, uitspraakDataUrl, uitspraakDetailsUrl, uitspraakInhoudsopgave } from "./sources/rechtspraak.js";
import { RdwSource } from "./sources/rdw.js";
import { RijkswaterstaatWaterdataSource } from "./sources/rijkswaterstaat-waterdata.js";
import { NgrSource } from "./sources/ngr.js";
import { RuimtelijkePlannenSource } from "./sources/ruimtelijke-plannen.js";
import { RivmSource } from "./sources/rivm.js";
import { SparqlLinkedDataSource, SPARQL_LIMIT_CAP } from "./sources/sparql-linked-data.js";
import { BagDetailSource } from "./sources/bagDetail.js";
import { EurostatSource } from "./sources/eurostat.js";
import { DataEuropaSource } from "./sources/data-europa.js";
import { DataPolitieSource } from "./sources/data-politie.js";
import { CbsIv3Source } from "./sources/cbs-iv3.js";
import { BWB_SRU_ENDPOINT, BWB_TEXT_DEFAULT_CHARS, BWB_TEXT_MAX_CHARS, BwbTekstError, bwbSearchCql, bwbVersieUrl, todayAmsterdam, WettenBwbSource, type BwbArtikel, type BwbRegeling } from "./sources/wetten-bwb.js";
import { CvdrSource, CVDR_ORGANIZATION_TYPES, CvdrQueryError } from "./sources/cvdr.js";
import { BestuurlijkeGebiedenSource } from "./sources/bestuurlijke-gebieden.js";
import { BrkKadastraleKaartSource } from "./sources/brk-kadastrale-kaart.js";
import { BronOngevallenSource } from "./sources/bron-ongevallen.js";
import { NzaZorgbeeldSource } from "./sources/nza-zorgbeeld.js";
import { OverheidsorganisatiesSource } from "./sources/overheidsorganisaties.js";
import { OvapiSource } from "./sources/ovapi.js";
import { BroOndergrondSource } from "./sources/bro-ondergrond.js";
import { NedSource } from "./sources/ned.js";
import { EpOnlineSource } from "./sources/ep-online.js";
import { NsReisinformatieSource } from "./sources/ns-reisinformatie.js";
import { DnbStatisticsSource } from "./sources/dnb-statistics.js";
import { TenderNedSource, TENDERNED_MAX_REACHABLE, TenderNedInputError, planUpstreamWindow, tenderNedRecordFields } from "./sources/tenderned.js";
import { KoopCollectieSource } from "./sources/koop-collecties.js";
import { BrpGewasperceelSource } from "./sources/brp-gewaspercelen.js";
import { VerkiezingsuitslagenSource } from "./sources/verkiezingsuitslagen.js";
import { EuCellarSource, normalizeCelex } from "./sources/eu-cellar.js";
import { LidoSource, parseLidoId, normalizeLidoType, clampLidoRows } from "./sources/lido.js";
import { DsoOmgevingsdocumentenSource, DsoInputError, DSO_DOCUMENT_TYPES, DSO_PRESENTEREN_BASE, DSO_RODK_URL, dsoApiKeyProblem, type DsoSearchItem } from "./sources/dso-omgevingsdocumenten.js";
import { DSO_TEXT_DEFAULT_CHARS, DSO_TEXT_MAX_CHARS, selectDsoText, zoektermWords, type DsoTextPart } from "./sources/dso-regeltekst.js";
import { WodcSource, WODC_SEARCH_ENDPOINT, WODC_MAX_ROWS, WODC_MAX_OFFSET, WODC_DEFAULT_CHARS, WODC_MAX_CHARS, WODC_MAX_PASSAGES, clampWodcRows, mapWodcError, planWodcWindow, shortAbstract, type WodcItem } from "./sources/wodc.js";
import { AlgoritmeregisterSource, ALGORITMEREGISTER_SEARCH_ENDPOINT, ALGORITMEREGISTER_ORG_ENDPOINT, ALGORITMEREGISTER_MAX_ROWS, ALGORITME_STATUSSEN, ALGORITME_PUBLICATIECATEGORIEEN, ALGORITME_ORGANISATIETYPES, clampAlgoritmeRows, planAlgoritmeWindow, summarizeAlgoritmeSearch } from "./sources/algoritmeregister.js";
import { EuFundingSource, EuFundingInputError, EU_FUNDING_SEARCH_ENDPOINT, EU_FUNDING_PORTAL, EU_FUNDING_MAX_ROWS, EU_FUNDING_DEFAULT_ROWS, EU_FUNDING_MAX_REACHABLE, EU_FUNDING_DEFAULT_MAX_CHARS, EU_FUNDING_MAX_CHARS, EU_FUNDING_STATUSES, EU_FUNDING_TYPES, EU_FUNDING_SORTS, EU_FUNDING_PROGRAMME_ABBREVIATIONS, clampEuFundingRows, buildEuFundingRequest, euFundingParams, describeEuFundingItem, summarizeEuFundingSearch, summarizeEuFundingGet, type EuFundingItem } from "./sources/eu-funding.js";
import { RvoSubsidiesSource, RvoSubsidiesInputError, RVO_SUBSIDIES_ENDPOINT, RVO_SUBSIDIES_CONNECTOR, RVO_SUBSIDIES_PAGES_CONNECTOR, RVO_STATUSSEN, RVO_DOELGROEPEN, RVO_ONDERWERPEN, RVO_SORTS, RVO_DEFAULT_ROWS, RVO_MAX_ROWS, RVO_STATUS_CHECK_MAX, RVO_STATUS_ENRICH_MAX, RVO_TEXT_DEFAULT_CHARS, RVO_TEXT_MAX_CHARS, rvoPageUrl, summarizeRvoSearch, summarizeRvoGet, type RvoSubsidyItem, type RvoSubsidyStatus } from "./sources/rvo-subsidies.js";
import { OnderzoekscallsSource, ONDERZOEKSCALL_STATUS_FILTERS, ONDERZOEKSCALL_MAX_ROWS, ONDERZOEKSCALL_DEFAULT_ROWS, ONDERZOEKSCALL_MAX_OFFSET, ONDERZOEKSCALL_DEFAULT_CHARS, ONDERZOEKSCALL_MAX_CHARS, ONDERZOEKSCALL_CONNECTORS, clampOnderzoekscallRows, resolveOnderzoekscallUrl, summarizeOnderzoekscallsSearch, summarizeOnderzoekscall, amsterdamDay, mapOnderzoekscallError, type OnderzoekscallItem } from "./sources/nl-onderzoekscalls.js";
import { mapSourceError, nowIso, successResponse, toMcpToolPayload, errorResponse } from "./utils/response.js";
import { SourceRequestError } from "./utils/http.js";
import { applyOutputFormat } from "./utils/output-format.js";
import { buildFormattedResponse, dryRunPayload, mergeAccessNotes, singleConnectorVerbose } from "./utils/tool-runner.js";
import type { MCPRecord, ToolResult } from "./types.js";
import { rewriteQuery, rewriteNote } from "./utils/query-rewriter.js";
import { logger } from "./utils/logger.js";
import { registerNlGovAsk } from "./router/nl-gov-ask.js";
export { extractPlaceName, cbsNarrowingCandidates, extractLuchtComponent, extractVerkiezingHint, type EuIntent, detectEuIntent, shouldDeepenTweedeKamerQuery, MUNICIPAL_SCOPE_WORDS, ORGANISATION_WORDS, uitsprakenSense, asksForRulings, hasDataIntent, type PolicyIntent, detectPolicyIntent, type DebatIntent, detectDebatIntent, type AlgoritmeIntent, detectAlgoritmeIntent, type DsoIntent, detectDsoIntent, toPhraseQuery, toOriQuery, oriPlacePhrase } from "./router/intents.js";

const config = loadConfig();

/** MCP annotations shared by all tools — every tool is read-only and queries external public APIs. */
const TOOL_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true } as const;
const dataOverheid = new DataOverheidSource(config);
const cbs = new CbsSource(config);
const tk = new TweedeKamerSource(config);
const debatten = new TweedeKamerDebattenSource(config);
const bekend = new BekendmakingenSource(config);
const rijksoverheid = new RijksoverheidSource(config);
const rijksbegroting = new RijksbegrotingSource(config);
const duo = new DuoSource(config);
const pdok = new PdokSource(config);
const ori = new OriSource(config);
const ndw = new NdwSource(config);
const luchtmeetnet = new LuchtmeetnetSource(config);
const rechtspraak = new RechtspraakSource(config);
const rdw = new RdwSource(config);
const rwsWaterdata = new RijkswaterstaatWaterdataSource(config);
const ngr = new NgrSource(config);
const ruimtelijkePlannen = new RuimtelijkePlannenSource(config);
const rivm = new RivmSource(config);
const bagLinkedData = new SparqlLinkedDataSource(config, "https://api.labs.kadaster.nl/datasets/bag/lv/services/default/sparql", "Kadaster BAG Linked Data");
const bagDetail = new BagDetailSource(config);
const rceLinkedData = new SparqlLinkedDataSource(config, "https://api.linkeddata.cultureelerfgoed.nl/datasets/rce/cho/services/cho/sparql", "RCE Linked Data");
const eurostat = new EurostatSource(config);
const dataEuropa = new DataEuropaSource(config);
const dataPolitie = new DataPolitieSource(config);
const cbsIv3 = new CbsIv3Source(config);
const wettenBwb = new WettenBwbSource(config);
const cvdr = new CvdrSource(config);
const bestuurlijkeGebieden = new BestuurlijkeGebiedenSource(config);
const brkKadastraleKaart = new BrkKadastraleKaartSource(config);
const bronOngevallen = new BronOngevallenSource(config);
const nzaZorgbeeld = new NzaZorgbeeldSource(config);
const overheidsorganisaties = new OverheidsorganisatiesSource(config);
const ovapi = new OvapiSource(config);
const broOndergrond = new BroOndergrondSource(config);
const tenderned = new TenderNedSource(config);
const tuchtrecht = new KoopCollectieSource(config, "tuchtrecht");
const samenwerkendeCatalogi = new KoopCollectieSource(config, "samenwerkendecatalogi");
const brpGewaspercelen = new BrpGewasperceelSource(config);
const verkiezingsuitslagen = new VerkiezingsuitslagenSource(config);
const euCellar = new EuCellarSource(config);
const lido = new LidoSource(config);
const algoritmeregister = new AlgoritmeregisterSource(config);
const wodc = new WodcSource(config);
const euFunding = new EuFundingSource(config);
const rvoSubsidies = new RvoSubsidiesSource(config);
const onderzoekscalls = new OnderzoekscallsSource(config);

function record(source: string, title: string, canonical_url: string, data: Record<string, unknown>, snippet?: string, date?: string): MCPRecord {
  return { source_name: source, title, canonical_url, data, snippet, date };
}

/** An Algoritmeregister item as algoritmeregister_search and nl_gov_ask show it. */
function algoritmeRecord(x: Awaited<ReturnType<AlgoritmeregisterSource["search"]>>["items"][number]): MCPRecord {
  const meta = [x.organisation, x.status, x.publication_category].filter(Boolean).join(" · ");
  const desc = x.description_short.length > 240 ? `${x.description_short.slice(0, 239)}…` : x.description_short;
  return record("algoritmeregister", x.title, x.url, x as unknown as Record<string, unknown>, [meta, desc].filter(Boolean).join(" — "), x.published_at?.slice(0, 10));
}

/** An EU funding call as eu_funding_search and nl_gov_ask show it, dated by its next deadline (else its last, else its opening). */
function euFundingRecord(x: EuFundingItem): MCPRecord {
  return record("eu_funding", x.title, x.url, x as unknown as Record<string, unknown>, [describeEuFundingItem(x), x.description_short].filter(Boolean).join(" — "), (x.next_deadline ?? x.deadlines.at(-1) ?? x.opening_date)?.slice(0, 10));
}

/**
 * An RVO page as rvo_subsidies_search and nl_gov_ask show it: the status label,
 * period and budget as rvo.nl shows them (when the page was read), and for a
 * sub-page the regeling it belongs to.
 */
function rvoRecord(x: RvoSubsidyItem & { status_info?: RvoSubsidyStatus }): MCPRecord {
  const s = x.status_info;
  const meta = [
    s ? (s.status_label ?? "status onbekend") : "",
    s?.period_text ? `aanvragen ${s.period_text}` : "",
    s?.budget_total_eur !== undefined ? `budget € ${s.budget_total_eur.toLocaleString("nl-NL")}` : "",
    x.main_page ? "" : x.parent_title ? `onderdeel van ${x.parent_title}` : "subpagina",
  ].filter(Boolean).join(" · ");
  const intro = x.intro.length > 240 ? `${x.intro.slice(0, 239)}…` : x.intro;
  return record("rvo", x.title, x.url, x as unknown as Record<string, unknown>, [meta, intro].filter(Boolean).join(" — "), x.changed?.slice(0, 10));
}

/** A call or subsidy round of NWO or ZonMw, dated by its deadline as an Amsterdam day (a 00:00 deadline is 22:00Z the day before). */
function onderzoekscallRecord(x: OnderzoekscallItem): MCPRecord {
  const meta = [x.organisation === "nwo" ? "NWO" : "ZonMw", x.status_label, x.deadline_text ? `deadline ${x.deadline_text}` : "", x.budget_text ? `budget ${x.budget_text}` : "", x.programme, x.for_whom].filter(Boolean).join(" · ");
  return record(x.organisation, x.title, x.url, x as unknown as Record<string, unknown>, [meta, x.summary].filter(Boolean).join(" — "), amsterdamDay(x.deadline));
}

/** "Statsch, P.D., Burger, A.M. e.a. · Cahier 2026-12 · project 3105g" */
function wodcMeta(x: WodcItem): string {
  const authors = x.authors.length > 2 ? `${x.authors.slice(0, 2).join("; ")} e.a.` : x.authors.join("; ");
  return [authors, x.series.join(", "), x.projectnummers.length ? `project ${x.projectnummers.join(", ")}` : ""].filter(Boolean).join(" · ");
}

/** A WODC report as wodc_search shows it: the abstract shortened, the full one via wodc_document_get. */
function wodcRecord(x: WodcItem): MCPRecord {
  const abstract = shortAbstract(x.abstract);
  const snippet = shortAbstract(x.abstract, 240).text;
  return record("wodc", x.subtitle ? `${x.title}: ${x.subtitle}` : x.title, x.url, { ...x, abstract: abstract.text, abstract_ingekort: abstract.cut || undefined }, [wodcMeta(x), snippet].filter(Boolean).join(" — "), x.issued);
}

/** "Annelotte Lammers (Groep Markuszower)", "David van Weel (minister van Justitie en Veiligheid)", "Thom van Campen (voorzitter)". */
function debatSprekerLabel(f: DebatFragment): string {
  const role = f.voorzitter ? "voorzitter" : f.fractie || (f.functie && !/^lid tweede kamer$/i.test(f.functie) ? f.functie : "");
  return role ? `${f.spreker} (${role})` : f.spreker;
}

/**
 * Records for debate fragments. A commissiedebat links to its page on
 * tweedekamer.nl (looked up once per vergadering on the page), a plenaire dag
 * to its verslag there; otherwise the verslag in the Gegevensmagazijn.
 */
async function debatRecords(hits: DebatHit[], maxChars: number): Promise<MCPRecord[]> {
  const lookups = new Map<string, Promise<string | undefined>>();
  for (const { vergadering: v } of hits) {
    if (v.soort === "Commissie" && !lookups.has(v.vergadering_id) && lookups.size < 10) lookups.set(v.vergadering_id, debatten.commissieUrl(v));
  }
  const pages = new Map<string, string | undefined>();
  for (const [id, url] of lookups) pages.set(id, await url);
  return hits.map(({ fragment: f, vergadering: v, snippet }) => {
    const verslagUrl = debatten.verslagUrl(v.verslag_id);
    const url = TweedeKamerDebattenSource.plenairUrl(v) ?? pages.get(v.vergadering_id) ?? verslagUrl;
    const tekst = maxChars > 0 ? (f.tekst.length > maxChars ? `${f.tekst.slice(0, maxChars).replace(/\s+\S*$/, "")} …` : f.tekst) : undefined;
    return record("tweedekamer", `${debatSprekerLabel(f)}: ${f.debat}`, url, {
      vergadering_id: v.vergadering_id,
      verslag_id: v.verslag_id,
      vergadering: v.titel,
      vergadering_soort: v.soort,
      datum: v.datum ?? null,
      zaal: v.zaal ?? null,
      debat: f.debat,
      debat_soort: f.debat_soort ?? null,
      volgnummer: f.volgnummer,
      rol: f.rol,
      voorzitter: f.voorzitter,
      spreker: f.spreker,
      fractie: f.fractie ?? null,
      functie: f.functie ?? null,
      begin: f.begin ?? null,
      eind: f.eind ?? null,
      tekst,
      tekst_lengte: f.tekst.length,
      tekst_ingekort: tekst !== undefined && f.tekst.length > maxChars ? true : undefined,
      verslag_status: v.verslag_status ?? null,
      verslag_url: verslagUrl,
    }, snippet, f.begin ?? v.datum);
  });
}

/** "12 fragmenten in 3 debatten (20 vergaderingen doorzocht); meest aan het woord: …" */
function debatSummary(out: DebatSearchResult): string {
  const n = out.hits.length;
  const searched = `${out.searched.length} vergadering${out.searched.length === 1 ? "" : "en"} doorzocht`;
  if (!n) return `Geen debatfragmenten gevonden (${searched})`;
  const debatCount = new Set(out.hits.map((h) => `${h.vergadering.vergadering_id}|${h.fragment.debat}`)).size;
  const bySpreker = new Map<string, number>();
  for (const h of out.hits) {
    if (h.fragment.voorzitter) continue;
    const label = debatSprekerLabel(h.fragment);
    bySpreker.set(label, (bySpreker.get(label) ?? 0) + 1);
  }
  const top = [...bySpreker].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, count]) => `${label} ${count}`);
  return `${n} fragment${n === 1 ? "" : "en"} in ${debatCount} debat${debatCount === 1 ? "" : "ten"} (${searched})${top.length ? `; meest aan het woord: ${top.join(", ")}` : ""}`;
}

function debatNotes(out: DebatSearchResult, single: boolean): string | undefined {
  const searchedTo = out.vergaderingOffset + out.searched.length;
  const more = !single && out.totalVergaderingen !== null && out.totalVergaderingen > searchedTo;
  const oldest = out.searched.at(-1)?.datum;
  const uncorrected = out.searched.some((v) => v.verslag_status === "Ongecorrigeerd");
  return mergeAccessNotes(
    "Eén record per spreekbeurt of interruptie uit de verslagen van de Tweede Kamer (Gegevensmagazijn); de link gaat naar het debat op tweedekamer.nl of naar het verslag zelf.",
    out.period.defaulted && out.period.from && out.period.to ? `Geen datum opgegeven: de vergaderingen van ${out.period.from} t/m ${out.period.to} zijn doorzocht.` : undefined,
    more
      ? `Doorzocht: vergadering ${out.vergaderingOffset + 1} t/m ${searchedTo} van ${out.totalVergaderingen} in deze periode (nieuwste eerst${oldest ? `, de oudste van ${oldest}` : ""}). Zoek verder met vergadering_offset=${searchedTo}.`
      : undefined,
    out.failed.length ? `Het verslag van ${out.failed.map((v) => `'${v.titel}' (${v.datum ?? "?"})`).join(", ")} kon niet worden gelezen; die fragmenten ontbreken. Probeer het opnieuw.` : undefined,
    uncorrected ? "Ongecorrigeerde verslagen zijn de voorlopige tekst; het officiële verslag zijn de Handelingen." : undefined,
    out.terms.length ? `Gezocht op: ${out.terms.map((t) => (t.mode === "word" ? `"${t.text}"` : t.text)).join(" EN ")}.` : undefined,
    out.hits.length === 0 && !single
      ? "Debatten van vóór deze periode: verruim date_from, of zoek in de Handelingen met officiele_bekendmakingen_search (type 'Handelingen')."
      : undefined,
  );
}

/**
 * A DSO omgevingsdocument as dso_omgevingsdocumenten_search and nl_gov_ask show
 * it: linked to its readable text (documentUrl), dated by the start of its
 * current version or, for an ontwerp, by its announcement. An ontwerp's snippet
 * says whether it is ter inzage, or that the DSO does not know; a version that
 * a newer one replaces says through which day it applies. A DSO record that is
 * no rule document (the Omgevingswet's pointer, the Rijk's aansluitdocument)
 * says so in its title.
 */
function dsoRecord(x: DsoSearchItem): MCPRecord {
  const date = x.soort === "ontwerpregeling" ? x.bekendOp : (x.beginGeldigheid ?? x.beginInwerking);
  const inzage =
    x.soort !== "ontwerpregeling"
      ? undefined
      : x.terInzage === true
        ? `ter inzage tot en met ${x.eindeInzagetermijn}`
        : x.terInzage === false
          ? `inzagetermijn ${x.beginInzagetermijn ?? "?"} tot en met ${x.eindeInzagetermijn ?? "?"}${x.inzagetermijnOpvallendKort ? " (opvallend kort; de werkelijke termijn staat in de bekendmaking)" : ""}`
          : x.mogelijkTerInzage
            ? `mogelijk ter inzage: geen inzagetermijn in het DSO, bekendgemaakt ${x.dagenSindsBekendmaking} dagen geleden; zie de bekendmaking`
            : "geen inzagetermijn in het DSO";
  const versie = x.versieGeldigTotEnMet ? `deze versie${x.versie ? ` (${x.versie})` : ""} geldt tot en met ${x.versieGeldigTotEnMet}, vanaf ${x.eindGeldigheid?.slice(0, 10)} de volgende` : undefined;
  const bekendmaking = x.bekendmakingId ? `bekendmaking ${x.bekendmakingId}` : undefined;
  const snippet = [x.documentType, inzage, versie, bekendmaking, x.opmerking].filter(Boolean).join(" · ") || undefined;
  const title = x.alleenVerwijzing ? `${x.title} (alleen een verwijzing in het DSO)` : x.technisch ? `${x.title} (technisch DSO-document, geen regels)` : x.title;
  return record("dso_omgevingsdocumenten", title, x.documentUrl, { ...x, raw: undefined }, snippet, date);
}

/**
 * `total_results` is omitted when a source cannot know it.
 *
 * Sources pass `null` for "upstream gives no count". Echoing the page size there
 * — which several connectors used to do — makes a client render "10 of 10" for a
 * query holding thousands, so a null is dropped from the payload instead of
 * being coerced to a number.
 */
function prov(tool: string, endpoint: string, query_params: Record<string, string>, returned_results: number, total_results?: number | null) {
  return {
    tool,
    endpoint,
    query_params,
    timestamp: nowIso(),
    returned_results,
    total_results: total_results ?? undefined,
  };
}

/**
 * The summary of a page cut locally from `fetched` records: "20 publicaties",
 * "5 van 20 publicaties (6-10)", or, for an offset past the last record, that the
 * page is empty: never the count of records that are not on it.
 */
function pageSummary(fetched: number, offset: number, limit: number, noun: string): string {
  const shown = Math.max(0, Math.min(limit, fetched - offset));
  if (shown === fetched) return `${fetched} ${noun}`;
  if (!shown) return `Geen ${noun} op deze pagina: offset ${offset} ligt voorbij de ${fetched} opgehaalde`;
  return `${shown} van ${fetched} ${noun} (${offset + 1}-${offset + shown})`;
}

/** Longest keyword query the search tools take: a URL with more is refused upstream (HTTP 414/400). */
const SEARCH_QUERY_MAX = 500;

const outputFormatSchema = z.enum(["json", "csv", "geojson", "markdown_table"]).default("json");
const cbsFilterScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const cbsFilterValueSchema = z.union([cbsFilterScalarSchema, z.array(cbsFilterScalarSchema)]);
const paginationInputSchema = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(config.limits.maxRows).optional(),
};

export function registerTools(server: McpServer): void {
  server.registerTool("data_overheid_datasets_search", {
    description: "Search the Dutch national open data catalog (data.overheid.nl). Use concise topic keywords, not full sentences. Combine with 'organization' or 'theme' filters to narrow results.",
    inputSchema: { query: z.string().describe("Short topic keywords for dataset search. Extract the core subject from the user's question. Examples: 'luchtkwaliteit', 'bevolkingsgroei gemeente', 'energieverbruik'. Do NOT pass full natural-language questions."), sort: z.enum(["relevance", "date_newest"]).default("relevance").describe("Use 'date_newest' when user asks for recent/latest/newest datasets. Use 'relevance' for general searches."), rows: z.number().int().min(1).max(config.limits.maxRows).default(config.limits.defaultRows), organization: z.string().optional(), theme: z.string().optional(), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) },
    annotations: TOOL_ANNOTATIONS,
  }, async (args) => {
    const rw = rewriteQuery(args.query, "moderate");
    // CKAN (Solr) understands quoted phrases, so the caller's quotes are kept here.
    const ckanQuery = rw.syntaxQuery ?? rw.rewritten;
    try {
      const effectiveLimit = args.limit ?? args.rows;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(args.rows, args.offset + effectiveLimit));

      if (args.dryRun) {
        return dryRunPayload({
          connector: "data_overheid",
          url: `${config.endpoints.dataOverheid}/package_search`,
          params: {
            q: ckanQuery,
            rows: fetchRows,
            sort: args.sort,
            organization: args.organization,
            theme: args.theme,
          },
        });
      }

      const started = Date.now();
      const out = await dataOverheid.datasetsSearch({
        query: ckanQuery,
        rows: fetchRows,
        sort: args.sort,
        organization: args.organization,
        theme: args.theme,
      });
      const responseTimeMs = Date.now() - started;

      const records = out.items.map((d) => record("data.overheid.nl", String(d.title ?? d.id), `https://data.overheid.nl/dataset/${d.id}`, d as unknown as Record<string, unknown>, d.notes, d.metadata_modified));
      const response = buildFormattedResponse({
        summary: `${records.length} datasets gevonden`,
        records,
        provenance: prov("data_overheid_datasets_search", out.endpoint, out.query, Math.min(effectiveLimit, Math.max(0, records.length - args.offset)), out.total),
        outputFormat: args.outputFormat,
        offset: args.offset,
        limit: effectiveLimit,
        total: out.total,
        access_note: rewriteNote({ ...rw, rewritten: ckanQuery }),
        verbose: singleConnectorVerbose({
          enabled: args.verbose,
          connector: "data_overheid",
          endpoint: out.endpoint,
          responseTimeMs,
        }),
      });
      return toMcpToolPayload(response);
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "data.overheid.nl", "https://data.overheid.nl")); }
  });

  server.registerTool("data_overheid_dataset_get", { inputSchema: { id: z.string() }, description: "Get full details for a specific dataset from data.overheid.nl by ID.", annotations: TOOL_ANNOTATIONS }, async ({ id }) => {
    try {
      const out = await dataOverheid.datasetsGet(id);
      const d = out.item;
      const records = [record("data.overheid.nl", String(d.title ?? d.id), `https://data.overheid.nl/dataset/${d.id}`, d as unknown as Record<string, unknown>, d.notes, d.metadata_modified)];
      return toMcpToolPayload(successResponse({ summary: `Dataset ${id} opgehaald`, records, provenance: prov("data_overheid_dataset_get", out.endpoint, out.query, 1, 1) }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "data.overheid.nl", "https://data.overheid.nl")); }
  });

  server.registerTool("data_overheid_organizations", { description: "List all publishing organizations on data.overheid.nl.", annotations: TOOL_ANNOTATIONS }, async () => {
    try {
      const out = await dataOverheid.organizations();
      const total = out.items.length;
      const capped = out.items.slice(0, config.limits.maxRows);
      const records = capped.map((x) => record("data.overheid.nl", String(x.title ?? x.name ?? "organisatie"), `https://data.overheid.nl`, x as Record<string, unknown>));
      const access_note = total > records.length ? `Resultaat afgekapt op ${records.length} van ${total} organisaties om de payload te beperken.` : undefined;
      return toMcpToolPayload(successResponse({ summary: `${records.length} organisaties`, records, provenance: prov("data_overheid_organizations", out.endpoint, {}, records.length, total), access_note }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "data.overheid.nl")); }
  });

  server.registerTool("data_overheid_themes", { description: "List all dataset themes/categories on data.overheid.nl.", annotations: TOOL_ANNOTATIONS }, async () => {
    try {
      const out = await dataOverheid.themes();
      const total = out.items.length;
      const capped = out.items.slice(0, config.limits.maxRows);
      const records = capped.map((x) => record("data.overheid.nl", String(x.title ?? x.name ?? "thema"), `https://data.overheid.nl`, x as Record<string, unknown>));
      const access_note = total > records.length ? `Resultaat afgekapt op ${records.length} van ${total} thema's om de payload te beperken.` : undefined;
      return toMcpToolPayload(successResponse({ summary: `${records.length} thema's`, records, provenance: prov("data_overheid_themes", out.endpoint, {}, records.length, total), access_note }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "data.overheid.nl")); }
  });

  server.registerTool("cbs_tables_search", { description: "Search CBS (Statistics Netherlands) statistical tables. Use concise Dutch or English topic keywords.", inputSchema: { query: z.string().describe("Short statistical topic keywords. Examples: 'bevolking leeftijd', 'woningprijzen', 'werkloosheid regio', 'inflatie'. Do NOT pass full questions."), top: z.number().int().min(1).max(config.limits.maxRows).default(20), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, annotations: TOOL_ANNOTATIONS }, async ({ query, top, offset, limit, outputFormat, verbose, dryRun }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));

      if (dryRun) {
        return dryRunPayload({
          connector: "cbs",
          url: `${config.endpoints.cbsV4}/Datasets`,
          params: { query: rw.rewritten, top: fetchRows },
        });
      }

      const started = Date.now();
      const out = await cbs.searchTables(rw.rewritten, fetchRows);
      const responseTimeMs = Date.now() - started;

      // Each table's own StatLine page; a dataset of the data.overheid.nl fallback its catalogue page.
      const records = out.items.map((x) => record("cbs", String(x.Title ?? x.title ?? x.Identifier ?? "CBS tabel"), cbsCatalogItemUrl(x), x));
      const response = buildFormattedResponse({
        summary: `${records.length} CBS tabellen`,
        records,
        provenance: prov("cbs_tables_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), records.length),
        outputFormat,
        offset,
        limit: effectiveLimit,
        // Upstream (CBS v4 / data.overheid fallback) levert geen betrouwbare totaal-count;
        // null laat has_more terugvallen op de records-heuristiek i.p.v. onterecht false.
        total: null,
        access_note: mergeAccessNotes(rewriteNote(rw), out.access_note),
        verbose: singleConnectorVerbose({
          enabled: verbose,
          connector: "cbs",
          endpoint: out.endpoint,
          responseTimeMs,
        }),
      });
      return toMcpToolPayload(response);
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "CBS", "https://www.cbs.nl")); }
  });

  server.registerTool("cbs_table_info", { description: "Get metadata and column definitions for a specific CBS statistical table by table ID.", inputSchema: { tableId: z.string() }, annotations: TOOL_ANNOTATIONS }, async ({ tableId }) => {
    try {
      const out = await cbs.getTableInfo(tableId);
      const records = [record("cbs", String((out.info.Title as string | undefined) ?? tableId), `https://opendata.cbs.nl/#/CBS/nl/dataset/${tableId}`, out.info)];
      return toMcpToolPayload(successResponse({ summary: `CBS tabel ${tableId}`, records, provenance: prov("cbs_table_info", out.endpoint, out.params, 1, 1) }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "CBS")); }
  });

  server.registerTool("cbs_observations", { description: "Fetch observations (data rows) from a CBS statistical table. Supports column selection and dimension filtering.", inputSchema: { tableId: z.string(), top: z.number().int().min(1).max(config.limits.maxRows).default(50), select: z.array(z.string()).optional(), filters: z.record(z.string(), cbsFilterValueSchema).optional(), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, annotations: TOOL_ANNOTATIONS }, async ({ tableId, top, select, filters, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));

      if (dryRun) {
        return dryRunPayload({
          connector: "cbs",
          url: `${config.endpoints.cbsV4}/${tableId}/Observations`,
          params: { top: fetchRows, select: select ?? [], filters: filters ?? {} },
        });
      }

      const started = Date.now();
      const out = await cbs.getObservations({ tableId, top: fetchRows, select, filters: filters as Record<string, string | number | boolean | Array<string | number | boolean>> | undefined });
      const responseTimeMs = Date.now() - started;

      const records = out.items.map((x) => record("cbs", `Observatie ${tableId}`, `https://opendata.cbs.nl/#/CBS/nl/dataset/${tableId}`, x));
      const trendMeasure = out.items.find((x) => typeof x.trend_measure === "string")?.trend_measure as string | undefined;
      const response = buildFormattedResponse({
        summary: `${records.length} observaties`,
        records,
        access_note: trendMeasure ? `CBS trend enrichment applied for measure ${trendMeasure} (previous_period, previous_value, delta, delta_pct).` : undefined,
        provenance: prov("cbs_observations", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), records.length),
        outputFormat,
        offset,
        limit: effectiveLimit,
        // CBS OData levert hier geen totaal-count; null i.p.v. records.length zodat
        // has_more op de records-heuristiek valt.
        total: null,
        verbose: singleConnectorVerbose({
          enabled: verbose,
          connector: "cbs",
          endpoint: out.endpoint,
          responseTimeMs,
        }),
      });
      return toMcpToolPayload(response);
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "CBS")); }
  });

  // Tweede Kamer: query terms, links, titles and totals come from src/sources/tweede-kamer.ts.
  // The search scope is metadata (title/subject); the access_note says so on every keyword search.
  const tkScopeNote = "Zoekt in titel en onderwerp (metadata), niet in de volledige tekst; haal de inhoud op met tweede_kamer_document_get (include_text).";
  // Names the fields actually searched: Persoon is matched on Achternaam/Roepnaam/Functie, not on a title.
  const tkFieldList = (fields: string[]) =>
    fields.length > 1 ? `${fields.slice(0, -1).join(", ")} of ${fields[fields.length - 1]}` : (fields[0] ?? "de doorzochte velden");
  const tkZeroNote = (terms: number, fields: string[]) =>
    terms > 1
      ? `Geen resultaten: alle zoektermen moeten samen voorkomen in ${tkFieldList(fields)}. Probeer minder termen of een synoniem.`
      : terms === 1
        ? `Geen resultaten in ${tkFieldList(fields)}. Probeer een synoniem of een kortere vorm van het woord.`
        : undefined;
  const tkCountLabel = (shown: number, total: number | null) => (total !== null ? `${shown} van ${total}` : `${shown}`);

  server.registerTool("tweede_kamer_documents", { description: "Search Dutch Parliament (Tweede Kamer) documents by title and subject (metadata only, not the full text; use tweede_kamer_document_get with include_text for the content). All keywords must match (AND). Keywords of up to 3 characters (e.g. 'EU', 'ICT') and \"quoted phrases\" match as whole words; longer keywords also match inside longer words ('fietspad' finds 'fietspaden'). Short keywords whose letters occur in many records ('OV' in 'over', 'ING' in '-ing') are matched in fewer forms ('OV', 'OV-') to stay within the API's time limit; the number of forms follows a count of the records containing the letters, which date_from narrows. The access_note says which forms were searched. Case-insensitive but accent-sensitive. Optionally filter by document type and date range. Records link to the document page on tweedekamer.nl; pagination.total is the real number of matches.", inputSchema: { query: z.string().optional().describe("Policy topic keywords, all required. Examples: 'stikstof', 'woningbouw', 'EU landbouw', '\"openbaar vervoer\"'. Do NOT pass full questions. Optional when type or a date is given."), top: z.number().int().min(1).max(config.limits.maxRows).default(25), type: z.string().optional().describe("Document type, substring match on Soort (or Titel), e.g. 'Motie', 'Brief regering', 'Amendement'."), date_from: z.string().optional().describe("YYYY-MM-DD, document date on or after (Dutch local date)."), date_to: z.string().optional().describe("YYYY-MM-DD, document date on or before (Dutch local date)."), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, annotations: TOOL_ANNOTATIONS }, async ({ query, top, type, date_from, date_to, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;

      if (dryRun) {
        const plan = tk.planDocuments({ query, top: effectiveLimit, type, date_from, date_to, skip: offset });
        return dryRunPayload({
          connector: "tweede_kamer",
          url: `${config.endpoints.tweedeKamer}/Document`,
          params: { $count: "true", ...plan.params },
        });
      }

      const started = Date.now();
      // Upstream $skip/$top: the page is fetched where it lives instead of
      // fetching from row 0 and slicing, which capped reachable results at maxRows.
      const out = await tk.searchDocuments({ query, top: effectiveLimit, type, date_from, date_to, skip: offset });
      const responseTimeMs = Date.now() - started;

      const records = out.items.map((x) => {
        const view = tkRecordView("Document", x, config.endpoints.tweedeKamer);
        return record("tweedekamer", view.title, view.url, x, view.snippet, view.date);
      });
      const total = out.total;
      const response = buildFormattedResponse({
        summary: `${tkCountLabel(records.length, total)} Tweede Kamer documenten`,
        records,
        access_note: mergeAccessNotes(
          out.terms.length ? tkScopeNote : undefined,
          ...out.notes,
          records.length === 0 ? tkZeroNote(out.terms.length, out.fields) : undefined,
        ),
        provenance: prov("tweede_kamer_documents", out.endpoint, out.params, records.length, total),
        outputFormat,
        offset: 0,
        limit: effectiveLimit,
        total: null,
        verbose: singleConnectorVerbose({
          enabled: verbose,
          connector: "tweede_kamer",
          endpoint: out.endpoint,
          responseTimeMs,
        }),
      });
      // The records already are the requested page; report it at its real offset.
      response.pagination = {
        offset,
        limit: effectiveLimit,
        total,
        has_more: total !== null ? offset + records.length < total : records.length >= effectiveLimit,
      };
      return toMcpToolPayload(response);
    } catch(e){ return toMcpToolPayload(mapTweedeKamerError(e)); }
  });

  server.registerTool("tweede_kamer_search", { description: "Advanced OData search on Tweede Kamer entities (Document, Zaak, Activiteit, Agendapunt, Besluit, Stemming, Persoon, Fractie, Commissie, Kamerstukdossier, Vergadering, Toezegging, and the other entity sets of the Gegevensmagazijn). 'query' is an AND keyword search on the entity's text fields (Document and Zaak: Titel and Onderwerp; same word rules as tweede_kamer_documents) and is optional when 'filter' or a date is given. 'filter' and 'orderby' take raw OData v4 expressions with the entity's field names. date_from/date_to filter the entity's own date (Document.Datum, Zaak.GestartOp, Activiteit.Datum, Vergadering.Datum, Toezegging.Aanmaakdatum, Agendapunt/Besluit/Stemming via the meeting or voting session). Agendapunt, Besluit and Stemming records carry that meeting date as 'vergaderdatum', which is also their record date; GewijzigdOp is when the record last changed. An unknown entity, an unsupported query/date or a rejected expression returns an explicit error, never an unfiltered fallback.", inputSchema: { query: z.string().optional().describe("Topic keywords, all required. Examples: 'zorg', 'migratie', 'ICT onderwijs'. Do NOT pass full questions. Optional when filter or a date is given."), entity: z.string().default("Document").describe("Entity set, e.g. Document, Zaak, Activiteit, Besluit, Stemming, Persoon, Fractie, Kamerstukdossier (case-insensitive)."), top: z.number().int().min(1).max(config.limits.maxRows).default(25), filter: z.string().optional().describe("Raw OData $filter, e.g. \"Soort eq 'Motie'\". Combined with query using AND."), orderby: z.string().optional().describe("Raw OData $orderby; default 'GewijzigdOp desc'. To sort by meeting date: 'Activiteit/Datum desc' (Agendapunt), 'Agendapunt/Activiteit/Datum desc' (Besluit), 'Besluit/Agendapunt/Activiteit/Datum desc' (Stemming)."), skip: z.number().int().min(0).optional(), date_from: z.string().optional().describe("YYYY-MM-DD, on or after (Dutch local date) on the entity's date field."), date_to: z.string().optional().describe("YYYY-MM-DD, on or before (Dutch local date) on the entity's date field."), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, annotations: TOOL_ANNOTATIONS }, async ({ query, entity, top, filter, orderby, skip, date_from, date_to, offset, limit, outputFormat, verbose, dryRun }) => {
    const effectiveOffset = skip ?? offset;
    const effectiveLimit = limit ?? top;
    try {
      if (dryRun) {
        const plan = tk.planSearch({ query, entity, top: effectiveLimit, filter, orderby, skip: effectiveOffset, date_from, date_to });
        return dryRunPayload({
          connector: "tweede_kamer",
          url: `${config.endpoints.tweedeKamer}/${plan.entity}`,
          params: { $count: "true", ...plan.params },
        });
      }

      const started = Date.now();
      const out = await tk.search({ query, entity, top: effectiveLimit, filter, orderby, skip: effectiveOffset, date_from, date_to });
      const responseTimeMs = Date.now() - started;

      const records = out.items.map((x) => {
        const view = tkRecordView(out.entity, x, config.endpoints.tweedeKamer);
        return record("tweedekamer", view.title, view.url, x, view.snippet, view.date);
      });
      const formatted = applyOutputFormat({ records, outputFormat });
      return toMcpToolPayload(successResponse({
        summary: `${tkCountLabel(records.length, out.total)} Tweede Kamer records (${out.entity})`,
        records,
        provenance: prov("tweede_kamer_search", out.endpoint, out.params, records.length, out.total),
        output_format: formatted.output_format,
        formatted_output: formatted.formatted_output,
        access_note: mergeAccessNotes(
          "Upstream paging via skip/top; pagination.total is het aantal treffers volgens de bron ($count).",
          out.terms.length && (out.entity === "Document" || out.entity === "Zaak") ? tkScopeNote : undefined,
          ...out.notes,
          records.length === 0 ? tkZeroNote(out.terms.length, out.fields) : undefined,
          formatted.access_note,
        ),
        pagination: {
          offset: effectiveOffset,
          limit: effectiveLimit,
          total: out.total,
          has_more: out.total !== null ? effectiveOffset + records.length < out.total : records.length >= effectiveLimit,
        },
        verbose: singleConnectorVerbose({
          enabled: verbose,
          connector: "tweede_kamer",
          endpoint: out.endpoint,
          responseTimeMs,
        }),
      }));
    } catch(e){ return toMcpToolPayload(mapTweedeKamerError(e, { entity, filter, orderby })); }
  });

  server.registerTool("tweede_kamer_document_get", { description: "Get full details of a specific Tweede Kamer document by ID (GUID). Can optionally resolve resource URLs and include a text preview: extracted from PDF text layers and Word (.docx) files; other binary formats report text_preview_unavailable_reason instead of raw bytes.", inputSchema: { id: z.string(), resolve_resource: z.boolean().default(false), include_text: z.boolean().default(false), max_chars: z.number().int().min(1).max(50000).optional() }, annotations: TOOL_ANNOTATIONS }, async ({ id, resolve_resource, include_text, max_chars }) => {
    try {
      const out = await tk.getDocument({ id, resolve_resource, include_text, max_chars });
      const r = out.item as Record<string, unknown>;
      const textPreview = typeof r.text_preview === "string" ? r.text_preview : undefined;
      const contentType = String(r.resource_content_type ?? r.ContentType ?? "");
      const notes: string[] = [];

      if (resolve_resource || include_text) {
        notes.push(`Resource resolved as ${contentType || "unknown content type"}.`);
      }
      if (include_text && textPreview) {
        notes.push(`Included text preview (${textPreview.length} chars${r.text_preview_truncated ? ", truncated" : ""}).`);
        if (r.text_preview_source === "docx_document_xml") {
          notes.push("Tekst uit de hoofdtekst van het Word-bestand (word/document.xml); kop- en voetteksten en voetnoten zijn niet meegenomen.");
        }
      } else if (include_text && r.text_preview_unavailable_reason === "content_type_not_supported") {
        notes.push(`Text preview unavailable: tekstextractie wordt voor ${contentType || "dit bestandstype"} niet ondersteund; open het bestand via download_url of resource_url.`);
      } else if (include_text && typeof r.text_preview_unavailable_reason === "string") {
        notes.push(`Text preview unavailable: ${r.text_preview_unavailable_reason}.`);
      }

      const records = [
        record(
          "tweedekamer",
          tkSubjectTitle(r, id),
          String(r.resolved_resource_url ?? r.resource_url ?? r.web_url ?? `https://www.tweedekamer.nl`),
          r,
          textPreview ?? String(r.Onderwerp ?? ""),
          String(r.Datum ?? ""),
        ),
      ];

      return toMcpToolPayload(successResponse({
        summary: `Tweede Kamer document ${id}`,
        records,
        provenance: prov("tweede_kamer_document_get", out.endpoint, out.params, 1, 1),
        access_note: notes.length ? notes.join(" ") : undefined,
      }));
    } catch(e){ return toMcpToolPayload(mapTweedeKamerError(e)); }
  });

  server.registerTool("tweede_kamer_votes", { description: "Retrieve Tweede Kamer votes: one row per fractie (or per member in a roll-call vote), each linked to its decision (Besluit: outcome such as 'Aangenomen.' or 'Verworpen.', field uitslag) and to the motion, amendment or bill voted on (Zaak: number, title, subject and a tweedekamer.nl link). Filter by query (keywords in the zaak title/subject, same word rules as tweede_kamer_documents), zaak_nummer (e.g. 2026Z15215), zaak_id, besluit_id, or the date of the voting session (date, or date_from/date_to, YYYY-MM-DD). Newest voting sessions first.", inputSchema: { zaak_id: z.string().optional().describe("Zaak GUID or zaak number of the motion/amendment/bill; a Besluit GUID is also accepted."), besluit_id: z.string().optional().describe("Besluit (decision) GUID."), zaak_nummer: z.string().optional().describe("Zaak number, e.g. 2026Z15215."), query: z.string().optional().describe("Keywords matched against the title and subject of the voted zaak, all required. Example: 'stikstof', 'EU'."), date: z.string().optional().describe("YYYY-MM-DD: votes held on this day (date of the voting session, Dutch local date)."), date_from: z.string().optional().describe("YYYY-MM-DD: voting sessions on or after this day."), date_to: z.string().optional().describe("YYYY-MM-DD: voting sessions on or before this day."), top: z.number().int().min(1).max(config.limits.maxRows).default(100), offset: z.number().int().min(0).default(0) }, annotations: TOOL_ANNOTATIONS }, async ({ zaak_id, besluit_id, zaak_nummer, query, date, date_from, date_to, top, offset }) => {
    try {
      const out = await tk.getVotes({ zaak_id, besluit_id, zaak_nummer, query, date, date_from, date_to, top, skip: offset });
      const records = out.items.map((x) => {
        const view = TweedeKamerSource.voteView(x);
        return record("tweedekamer", view.title, view.url, x, view.snippet, view.date);
      });
      // The decisions are counted on this page only; with more votes upstream, say so.
      const besluiten = new Set(out.items.map((x) => String(x.besluit_id ?? "")).filter(Boolean)).size;
      const besluitLabel = `${besluiten} besluit${besluiten === 1 ? "" : "en"}`;
      const morePages = out.total !== null && out.total > records.length;
      return toMcpToolPayload(successResponse({
        summary: `${tkCountLabel(records.length, out.total)} stemmingen${besluiten ? (morePages ? ` (deze pagina: ${besluitLabel})` : ` over ${besluitLabel}`) : ""}`,
        records,
        provenance: prov("tweede_kamer_votes", out.endpoint, out.params, records.length, out.total),
        access_note: mergeAccessNotes(
          "Eén record per fractie (of Kamerlid bij hoofdelijke stemming) per besluit; de uitslag staat in besluit_tekst/uitslag, de motie of het wetsvoorstel in zaak_nummer/zaak_onderwerp.",
          ...out.notes,
          records.length === 0 ? "Geen stemmingen gevonden voor deze filters." : undefined,
          records.length === 0 && (date || date_from || date_to)
            ? "De datum is die van de stemmingsvergadering, niet die van registratie of wijziging (stemmingen worden soms een dag later geregistreerd)."
            : undefined,
        ),
        pagination: {
          offset,
          limit: top,
          total: out.total,
          has_more: out.total !== null ? offset + records.length < out.total : records.length >= top,
        },
      }));
    } catch(e){ return toMcpToolPayload(mapTweedeKamerError(e)); }
  });

  server.registerTool("tweede_kamer_members", { description: "List current or former Tweede Kamer members. Optionally filter by parliamentary group (fractie).", inputSchema: { fractie: z.string().optional(), active: z.boolean().default(true), top: z.number().int().min(1).max(config.limits.maxRows).default(50) }, annotations: TOOL_ANNOTATIONS }, async ({ fractie, active, top }) => {
    try { const out = await tk.getMembers({ fractie, active, top }); const records = out.items.map((x)=>record("tweedekamer", String(x.name ?? x.id ?? "Kamerlid"), String(x.persoon_url ?? "https://www.tweedekamer.nl"), x, String(x.fractie ?? ""), String(x.start_date ?? ""))); return toMcpToolPayload(successResponse({ summary: `${records.length} Kamerleden`, records, provenance: prov("tweede_kamer_members", out.endpoint, out.params, records.length, null) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Tweede Kamer", "https://www.tweedekamer.nl")); }
  });

  server.registerTool("tweede_kamer_debatten", { description: `Search what was said in Tweede Kamer debates, plenary and committee: the verslagen (stenograms) in the Gegevensmagazijn, one record per spreekbeurt or interruptie with speaker, fractie or function, time and text. Filter by words in the text (query; all required, same word rules as tweede_kamer_documents, accents ignored), spreker (name or function: 'Klaver', 'van Weel', 'minister', 'voorzitter'), fractie ('VVD', 'PRO'), debat (words in the debate subject), soort (plenair or commissie) and date or date_from/date_to (YYYY-MM-DD; default the last ${DEBAT_DEFAULT_DAYS} days). There is no full-text index: each call reads the verslagen of at most ${DEBAT_MAX_VERSLAGEN} vergaderingen in the period, newest first, and vergadering_offset continues with the next ones; the access_note says how many there are. vergadering_id (from an earlier result) reads one vergadering: a plenary day with all its debates, or one committee debate. A debate's verslag appears the same day, uncorrected; the corrected one follows weeks later and the official record is the Handelingen (officiele_bekendmakingen_search, type Handelingen, also for debates long ago). Not live.`, inputSchema: { query: z.string().optional().describe("Words in what was said, all required. Examples: 'stikstof', 'medische isotopen', '\"gehoord de beraadslaging\"'. Do NOT pass full questions."), spreker: z.string().optional().describe("Speaker name or function, e.g. 'Klaver', 'Van Campen', 'minister', 'staatssecretaris'."), fractie: z.string().optional().describe("Fractie of the speaker, e.g. 'VVD', 'CDA', 'PRO'. The chair never counts for a fractie."), debat: z.string().optional().describe("Words in the debate subject, e.g. 'Pallas', 'Oekraïne', 'begroting'."), soort: z.enum(["plenair", "commissie"]).optional().describe("Only plenary days or only committee debates."), vergadering_id: z.string().optional().describe("Vergadering GUID from an earlier result: read that one vergadering (no date needed)."), date: z.string().optional().describe("YYYY-MM-DD: vergaderingen on this day."), date_from: z.string().optional().describe("YYYY-MM-DD: vergaderingen on or after this day."), date_to: z.string().optional().describe("YYYY-MM-DD: vergaderingen on or before this day."), vergadering_offset: z.number().int().min(0).default(0).describe(`Skip this many vergaderingen (newest first): the next ${DEBAT_MAX_VERSLAGEN} when the period holds more.`), max_chars: z.number().int().min(0).max(DEBAT_MAX_CHARS).default(DEBAT_DEFAULT_CHARS).describe("Characters of text per fragment in data.tekst (0: only the snippet)."), top: z.number().int().min(1).max(config.limits.maxRows).default(25), offset: z.number().int().min(0).default(0) }, annotations: TOOL_ANNOTATIONS }, async ({ query, spreker, fractie, debat, soort, vergadering_id, date, date_from, date_to, vergadering_offset, max_chars, top, offset }) => {
    try {
      const out = await debatten.search({ query, spreker, fractie, debat, soort, vergadering_id, date, date_from, date_to, vergadering_offset });
      const page = out.hits.slice(offset, offset + top);
      const records = await debatRecords(page, max_chars);
      return toMcpToolPayload(successResponse({
        summary: debatSummary(out),
        records,
        provenance: prov("tweede_kamer_debatten", out.endpoint, out.params, records.length, out.hits.length),
        access_note: debatNotes(out, Boolean(vergadering_id)),
        pagination: { offset, limit: top, total: out.hits.length, has_more: offset + records.length < out.hits.length },
      }));
    } catch(e){ return toMcpToolPayload(mapTweedeKamerError(e)); }
  });

  server.registerTool("officiele_bekendmakingen_search", {
    description:
      "Search Officiële Bekendmakingen (Dutch official publications: Gemeenteblad, Staatscourant, Staatsblad, Provinciaal blad, Waterschapsblad, Kamerstukken, Handelingen). Use legal/policy topic keywords; every word must occur (Dutch stopwords such as 'en' are ignored; a quoted phrase such as \"zorg en veiligheid\" and a citation such as '2016/679' match exactly; for a hyphenated term like 'OV-visie' the publications with that exact term come first, followed by those where both words occur separately). " +
      "To find what one municipality, province or water board published, set 'authority' (and 'authority_type') rather than putting the place name in the query: a place name in the query also matches national documents that merely mention it, and the response suggests the filter when it spots one. " +
      "Filter by 'publicatieblad' (journal), 'type' (document kind) and a date range, and use sort='date_newest' for the latest publications. Each record carries the document date (date, dagtekening), the publication date, the citation (vindplaats) and direct PDF/HTML/XML links. Only the first ~10,000 hits of a result set can be paged through (upstream limit).",
    inputSchema: {
      query: z.string().describe("Legal or policy topic keywords. Examples: 'bestemmingsplan', 'subsidieregeling', 'parkeerbeleid'. Do NOT pass full questions, and put an organisation name in 'authority' instead."),
      top: z.number().int().min(1).max(100).default(20),
      startRecord: z.number().int().min(1).default(1),
      type: z.string().optional().describe("Document kind (dt.type), e.g. 'Kamerstuk', 'beleidsregel', 'verordening', 'ander besluit van algemene strekking', 'omgevingsvergunning', 'Handelingen'. Not the journal: a journal name such as 'Staatscourant' or 'Gemeenteblad' is applied as publicatieblad (with a note)."),
      publicatieblad: z.string().optional().describe("Journal (publicatienaam): 'Gemeenteblad', 'Staatscourant', 'Staatsblad', 'Provinciaal blad', 'Waterschapsblad', 'Blad gemeenschappelijke regeling', 'Tractatenblad', 'Kamerstuk', 'Handelingen', 'Kamervragen (Aanhangsel)', 'Kamervragen zonder antwoord'. Abbreviations gmb, stcrt, stb, prb, wsb, bgr, trb and kst also work; separate several journals with commas."),
      authority: z.string().optional().describe("Publishing organisation as the source names it, e.g. 'Gouda', 'Den Haag' (searched as ''s-Gravenhage'), 'Zuid-Holland', 'Waterschap Rivierenland', 'Ministerie van Financiën'. A 'Gemeente '/'Provincie ' prefix is stripped and becomes authority_type; a water board is searched under its full name ('Hoogheemraadschap van Rijnland') with authority_type 'waterschap'. Matches names containing these words ('Utrecht' also matches 'Rechtbank Utrecht', 'Groningen' also 'Midden-Groningen'); access_note lists the publishers when a page mixes several, and counts older or variant spellings of the same publisher ('Utrecht (Utr)', 'Súdwest Fryslân', 'Den Haag') as that publisher. Kamerstukken are published by 'Tweede Kamer der Staten-Generaal', not by a ministry."),
      authority_type: z.enum(AUTHORITY_TYPES).optional().describe("Kind of publishing organisation. Use it to tell gemeente Utrecht from provincie Utrecht, or without 'authority' to search e.g. all municipalities ('gemeente')."),
      date_from: z.string().optional().describe("YYYY-MM-DD (YYYY and YYYY-MM are widened, DD-MM-YYYY is accepted). Applies to date_field."),
      date_to: z.string().optional().describe("YYYY-MM-DD (YYYY and YYYY-MM are widened, DD-MM-YYYY is accepted). Applies to date_field."),
      date_field: z.enum(["dagtekening", "publicatiedatum"]).default("dagtekening").describe("Date used by date_from/date_to and sort: 'dagtekening' = the date on the document (field date); 'publicatiedatum' = the date it was published (field publication_date). They differ for e.g. Kamerstukken and Handelingen."),
      sort: z.enum(["relevance", "date_newest", "date_oldest"]).default("relevance").describe("Use 'date_newest' for recent/latest publications (sorted server-side on date_field). 'relevance' for general searches."),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, top, startRecord, type, publicatieblad, authority, authority_type, date_from, date_to, date_field, sort, offset, limit, outputFormat, verbose, dryRun }) => {
    // The rewriter strips question frames but also every quote, slash and
    // apostrophe; phrases, citations and words like 's-Gravenhage are kept out of it.
    const rw = rewriteKeepingSyntax(query, (text) => rewriteQuery(text, "moderate"));
    const effectiveLimit = limit ?? top;
    const effectiveStartRecord = Math.max(1, startRecord + offset);
    const searchArgs = {
      query: rw.rewritten,
      maximumRecords: effectiveLimit,
      startRecord: effectiveStartRecord,
      type,
      publicatieblad,
      authority,
      authority_type,
      date_from,
      date_to,
      date_field,
      sort,
      // The rewriter lowercases; place-name detection needs the caller's casing.
      originalQuery: query,
      expandCompounds: true,
    };

    if (dryRun) {
      return dryRunPayload({
        connector: "officiele_bekendmakingen",
        url: config.endpoints.bekendmakingenSru,
        params: {
          query: rw.rewritten,
          maximumRecords: effectiveLimit,
          startRecord: effectiveStartRecord,
          type,
          publicatieblad,
          authority,
          authority_type,
          date_from,
          date_to,
          date_field,
          sort,
        },
      });
    }

    try {
      const started = Date.now();
      const out = await bekend.search(searchArgs);
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record(
        "officielebekendmakingen",
        String(x.title ?? x.identifier ?? "Bekendmaking"),
        String(x.canonical_url ?? `https://zoek.officielebekendmakingen.nl/${x.identifier ?? ""}`),
        x,
        bekendmakingSnippet(x),
        String((date_field === "publicatiedatum" ? x.publication_date ?? x.date : x.date) ?? ""),
      ));
      // A rejected query has no real count; numberOfRecords is then absent, not 0.
      const total = out.diagnostic ? null : out.total;
      // An exact-first compound search drops duplicates, so a page can cover more
      // positions than it holds records.
      const nextStart = effectiveStartRecord + (out.page_span ?? records.length);
      const pageable = out.diagnostic ? null : out.positions ?? total;
      const formatted = applyOutputFormat({ records, outputFormat });
      return toMcpToolPayload(successResponse({
        summary: `${records.length} bekendmakingen${typeof total === "number" ? ` (van ${total.toLocaleString("nl-NL")} treffers)` : ""}`,
        records,
        provenance: prov("officiele_bekendmakingen_search", out.endpoint, out.params, records.length, total),
        pagination: {
          offset: effectiveStartRecord - 1,
          limit: effectiveLimit,
          total,
          // Upstream refuses startRecord >= 10000, so a next page beyond that
          // does not exist for the caller even when the total says it should.
          has_more: typeof pageable === "number" && nextStart - 1 < pageable && nextStart <= SRU_MAX_START_RECORD,
        },
        output_format: formatted.output_format,
        formatted_output: formatted.formatted_output,
        access_note: mergeAccessNotes(rw.explanation, out.access_note, formatted.access_note),
        verbose: singleConnectorVerbose({
          enabled: verbose,
          connector: "officiele_bekendmakingen",
          endpoint: out.endpoint,
          responseTimeMs,
        }),
      }));
    } catch (e) {
      logger.warn({ err: e, tool: "officiele_bekendmakingen_search" }, "Primary source failed");
      const failure = mapSourceError(e, "Officiële Bekendmakingen");
      const fallback = bekend.fallbackSearch({ query: rw.rewritten, maximumRecords: effectiveLimit, startRecord: effectiveStartRecord, type, authority, date_from, date_to });
      const formatted = applyOutputFormat({ records: [], outputFormat });
      return toMcpToolPayload(successResponse({
        summary: "0 bekendmakingen — bron niet bereikbaar",
        records: [],
        provenance: prov("officiele_bekendmakingen_search", fallback.endpoint, fallback.params, 0, fallback.total),
        pagination: {
          offset: effectiveStartRecord - 1,
          limit: effectiveLimit,
          total: fallback.total,
          has_more: false,
        },
        failures: [{ connector: "officiele_bekendmakingen", error_type: failure.error, message: failure.message }],
        output_format: formatted.output_format,
        formatted_output: formatted.formatted_output,
        access_note: mergeAccessNotes(fallback.access_note, formatted.access_note),
        verbose: singleConnectorVerbose({
          enabled: verbose,
          connector: "officiele_bekendmakingen",
          endpoint: fallback.endpoint,
          responseTimeMs: 0,
        }),
      }));
    }
  });

  server.registerTool("officiele_bekendmakingen_record_get", {
    description:
      "Get one official publication (bekendmaking) by identifier, e.g. 'gmb-2026-104512' or 'kst-37020-IX-40' (a zoek.officielebekendmakingen.nl URL also works). Returns the full metadata — document date and publication date, journal and citation (vindplaats), subjects, legal basis, dossier and submitters for Kamerstukken — plus direct PDF/HTML/XML links. Set include_text to also get the document text (from the XML version, or from the PDF for older publications and attachments).",
    inputSchema: {
      identifier: z.string().describe("Publication identifier as returned by officiele_bekendmakingen_search, e.g. 'gmb-2026-104512', 'stcrt-2026-10001', 'kst-37020-IX-40'."),
      include_text: z.boolean().default(false).describe("Also fetch the document text."),
      max_chars: z.number().int().min(1).max(MAX_TEXT_CHARS).optional().describe(`Maximum characters of text when include_text is set (default 12000, max ${MAX_TEXT_CHARS}).`),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ identifier, include_text, max_chars }) => {
    const id = normalizeBekendmakingIdentifier(identifier);
    try {
      const out = await bekend.getRecord(id, { include_text, max_chars });
      const r = out.item;
      if (!r) {
        return toMcpToolPayload(successResponse({
          summary: `Bekendmaking ${id} niet gevonden`,
          records: [],
          provenance: prov("officiele_bekendmakingen_record_get", out.endpoint, out.params, 0, 0),
          access_note: out.access_note,
        }));
      }
      const records = [record(
        "officielebekendmakingen",
        String(r.title ?? r.identifier ?? id),
        String(r.canonical_url ?? `https://zoek.officielebekendmakingen.nl/${id}`),
        r,
        bekendmakingSnippet(r),
        String(r.date ?? ""),
      )];
      return toMcpToolPayload(successResponse({
        summary: `Bekendmaking ${String(r.identifier ?? id)}`,
        records,
        provenance: prov("officiele_bekendmakingen_record_get", out.endpoint, out.params, 1, 1),
        access_note: out.access_note,
      }));
    } catch (e) {
      logger.warn({ err: e, tool: "officiele_bekendmakingen_record_get", identifier }, "Primary source failed");
      const failure = mapSourceError(e, "Officiële Bekendmakingen");
      const fallback = bekend.fallbackGet(id);
      return toMcpToolPayload(successResponse({
        summary: `Bekendmaking ${id} niet opgehaald — bron niet bereikbaar`,
        records: [],
        provenance: prov("officiele_bekendmakingen_record_get", fallback.endpoint, fallback.params, 0, null),
        failures: [{ connector: "officiele_bekendmakingen", error_type: failure.error, message: failure.message }],
        access_note: fallback.access_note,
      }));
    }
  });

  server.registerTool("rijksoverheid_search", { description: "Search Rijksoverheid.nl content via the government's RSS search platform. Server-side keyword search returns at most 20 results per query, ranked by relevance, with no pagination; when the feed is full the real number of matches is unknown and total is left empty. date_from/date_to are applied server-side before that cap. Each item has date (the date Rijksoverheid.nl itself shows for the item, as an Amsterdam calendar day: for news the publication date, for documents the document date, for a revised document that of its latest version; date_from/date_to filter on this same date), issued (that date as a full timestamp), url_date (documents only: the date in the URL path, when the page was created, which for a revised document dates its first version; not when it went online) and type (page kind from the URL path: news, document, video, agenda, weblog, question_and_answer, topic, webpage); the feed carries no finer document type and no ministry. Use topic keywords. type='news' returns news only; type='all' returns news + documents + other pages.", inputSchema: { query: z.string().max(SEARCH_QUERY_MAX).describe("Government topic keywords. Examples: 'energietransitie', 'pensioenwet', 'toeslagen'. Do NOT pass full questions."), top: z.number().int().min(1).max(config.limits.maxRows).default(20), type: z.enum(["news", "all"]).optional().default("news").describe("'news' = only news documents; 'all' = news + policy documents + other pages. The platform returns at most 20 items per query."), date_from: z.string().optional().describe("Start of the period, inclusive: YYYY-MM-DD, or YYYY-MM / YYYY for the first day of that month or year (Amsterdam calendar days). Filters server-side on the item's date. An unreadable value is ignored with a warning in access_note."), date_to: z.string().optional().describe("End of the period, inclusive: YYYY-MM-DD, or YYYY-MM / YYYY for the last day of that month or year (Amsterdam calendar days). Filters server-side on the item's date. An unreadable value is ignored with a warning in access_note."), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, annotations: TOOL_ANNOTATIONS }, async ({ query, top, type, date_from, date_to, offset, limit, outputFormat, verbose, dryRun }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));

      if (dryRun) {
        return dryRunPayload({
          connector: "rijksoverheid",
          url: rijksoverheid.requestUrl({ query: rw.rewritten, type, date_from, date_to }),
          params: { query: rw.rewritten, top: fetchRows, type, date_from, date_to },
        });
      }

      const started = Date.now();
      const out = await rijksoverheid.search({ query: rw.rewritten, top: fetchRows, type, date_from, date_to });
      const responseTimeMs = Date.now() - started;

      const records = out.items.map((x)=>record("rijksoverheid", String(x.title ?? x.id ?? "Rijksoverheid item"), String(x.url ?? "https://www.rijksoverheid.nl"), x, String(x.snippet ?? ""), String(x.date ?? "")));
      const response = buildFormattedResponse({
        summary: pageSummary(records.length, offset, effectiveLimit, "resultaten"),
        records,
        provenance: prov("rijksoverheid_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total),
        outputFormat,
        offset,
        limit: effectiveLimit,
        // null when the 20-item feed was full: the real number of matches is unknown.
        total: out.total,
        // Records are cut to `top` before paging, so whether a later page has data
        // comes from what the feed returned, not from the (unknown) total.
        hasMore: offset + effectiveLimit < out.available,
        access_note: mergeAccessNotes(rewriteNote(rw), out.access_note),
        verbose: singleConnectorVerbose({
          enabled: verbose,
          connector: "rijksoverheid",
          endpoint: out.endpoint,
          responseTimeMs,
        }),
      });
      return toMcpToolPayload(response);
    } catch(e){ return toMcpToolPayload(mapSourceError(e, "Rijksoverheid", "https://www.rijksoverheid.nl")); }
  });

  server.registerTool("rijksoverheid_schoolholidays", { description: "Get Dutch school holiday dates. Optionally filter by year and region (noord, midden, zuid).", inputSchema: { year: z.number().int().min(2000).max(2100).optional(), region: z.string().optional() }, annotations: TOOL_ANNOTATIONS }, async ({ year, region }) => {
    try { const out = await rijksoverheid.schoolholidays({ year, region }); const records = out.items.map((x)=>record("rijksoverheid", String(x.title ?? x.name ?? x.region ?? x.id ?? "Schoolvakantie"), String(x.url ?? "https://www.rijksoverheid.nl"), x, String(x.region ?? ""), String(x.startdate ?? x.date ?? ""))); return toMcpToolPayload(successResponse({ summary: `${records.length} schoolvakantie records`, records, provenance: prov("rijksoverheid_schoolholidays", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Rijksoverheid", "https://www.rijksoverheid.nl")); }
  });

  // The Rekenkamer and the SCP publish on the CMS of Rijksoverheid.nl: one RSS source
  // (RijksoverheidSource.searchPublications), one tool per site.
  const publicationSites = [
    { tool: "rekenkamer_publicaties_search", site: "rekenkamer", name: "Algemene Rekenkamer", ref: "de Algemene Rekenkamer", host: "www.rekenkamer.nl", about: "audits of central government spending and policy: onderzoeksrapporten, verantwoordingsonderzoek, aandachtspunten bij begrotingen, brieven aan de Kamer", archive: "back to the 1990s", examples: "'asielprocedure', 'subsidies', 'verantwoordingsonderzoek'" },
    { tool: "scp_publicaties_search", site: "scp", name: "Sociaal en Cultureel Planbureau (SCP)", ref: "het SCP", host: "www.scp.nl", about: "social and cultural research: rapporten, kerncijfers, Burgerperspectieven, beleidssignalementen", archive: "mostly from late 2019 on, a few older", examples: "'mantelzorg', 'eenzaamheid', 'participatiewet'" },
  ] as const;
  for (const p of publicationSites) {
    server.registerTool(p.tool, { description: `Search the publications of the ${p.name} on ${p.host}: ${p.about}. Uses the site's own RSS search (the platform of Rijksoverheid.nl, which does not index ${p.host}). At most 20 results per query, ranked by relevance, no pagination; when the feed is full the real number of matches is unknown and total is left empty. Without query: the newest publications first, so date_from alone answers "what did they publish recently". date_from/date_to filter server-side, before the 20-cap, on date: the date the site shows (Amsterdam calendar day). Each record: title, url (the publication page with the full report/PDF), date, snippet (teaser only, no full text), url_date (date in the URL path: when the page was created) and type (from the URL path: document, video, file); no finer document type. Archive: ${p.archive}.`, inputSchema: { query: z.string().max(SEARCH_QUERY_MAX).optional().describe(`Topic keywords; leave empty for the newest publications. Examples: ${p.examples}. Do NOT pass full questions.`), top: z.number().int().min(1).max(config.limits.maxRows).default(20), date_from: z.string().optional().describe("Start of the period, inclusive: YYYY-MM-DD, or YYYY-MM / YYYY for the first day of that month or year (Amsterdam calendar days). An unreadable value is ignored with a warning in access_note."), date_to: z.string().optional().describe("End of the period, inclusive: YYYY-MM-DD, or YYYY-MM / YYYY for the last day of that month or year (Amsterdam calendar days). An unreadable value is ignored with a warning in access_note."), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, annotations: TOOL_ANNOTATIONS }, async ({ query, top, date_from, date_to, offset, limit, outputFormat, verbose, dryRun }) => {
      const rw = rewriteQuery(query ?? "", "moderate");
      const origin = `https://${p.host}`;
      try {
        const effectiveLimit = limit ?? top;
        const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));

        if (dryRun) {
          return dryRunPayload({
            connector: p.site,
            url: rijksoverheid.publicationsRequestUrl({ site: p.site, query: rw.rewritten, date_from, date_to }),
            params: { query: rw.rewritten, top: fetchRows, date_from, date_to },
          });
        }

        const started = Date.now();
        const out = await rijksoverheid.searchPublications({ site: p.site, query: rw.rewritten, top: fetchRows, date_from, date_to });
        const responseTimeMs = Date.now() - started;

        const records = out.items.map((x)=>record(p.site, String(x.title || x.id || `${p.name} publicatie`), String(x.url || origin), x, String(x.snippet ?? ""), String(x.date ?? "")));
        const response = buildFormattedResponse({
          summary: pageSummary(records.length, offset, effectiveLimit, `publicaties van ${p.ref}`),
          records,
          provenance: prov(p.tool, out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total),
          outputFormat,
          offset,
          limit: effectiveLimit,
          // null when the 20-item feed was full: the real number of matches is unknown.
          total: out.total,
          hasMore: offset + effectiveLimit < out.available,
          access_note: mergeAccessNotes(rewriteNote(rw), out.access_note),
          verbose: singleConnectorVerbose({ enabled: verbose, connector: p.site, endpoint: out.endpoint, responseTimeMs }),
        });
        return toMcpToolPayload(response);
      } catch(e){ return toMcpToolPayload(mapSourceError(e, p.name, origin)); }
    });
  }

  server.registerTool("rijksbegroting_search", { description: "Search Dutch national budget (Rijksbegroting) datasets. Use budget/policy topic keywords.", inputSchema: { query: z.string().describe("Budget or policy topic keywords. Examples: 'defensie', 'infrastructuur', 'zorg uitgaven'. Do NOT pass full questions."), top: z.number().int().min(1).max(config.limits.maxRows).default(20), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, annotations: TOOL_ANNOTATIONS }, async ({ query, top, offset, limit, outputFormat, verbose, dryRun }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));

      if (dryRun) {
        return dryRunPayload({
          connector: "rijksbegroting",
          url: `${config.endpoints.rijksbegroting}/api/3/action/package_search`,
          params: { q: rw.rewritten, rows: fetchRows },
        });
      }

      const started = Date.now();
      const out = await rijksbegroting.search(rw.rewritten, fetchRows);
      const responseTimeMs = Date.now() - started;

      const records = out.items.map((x)=>record("rijksbegroting", String(x.title ?? x.name ?? x.id ?? "Rijksbegroting dataset"), String(x.url ?? "https://opendata.rijksbegroting.nl"), x));
      const response = buildFormattedResponse({
        summary: `${records.length} Rijksbegroting datasets`,
        records,
        provenance: prov("rijksbegroting_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total),
        outputFormat,
        offset,
        limit: effectiveLimit,
        total: out.total,
        access_note: rewriteNote(rw),
        verbose: singleConnectorVerbose({
          enabled: verbose,
          connector: "rijksbegroting",
          endpoint: out.endpoint,
          responseTimeMs,
        }),
      });
      return toMcpToolPayload(response);
    } catch(e){ return toMcpToolPayload(mapSourceError(e, "Rijksbegroting", "https://opendata.rijksbegroting.nl")); }
  });

  server.registerTool("rijksbegroting_chapter", { description: "Get a specific chapter from the Dutch national budget (Rijksbegroting) by year and chapter code.", inputSchema: { year: z.number().int().min(2000).max(2100), chapter: z.string() }, annotations: TOOL_ANNOTATIONS }, async ({ year, chapter }) => {
    try { const out = await rijksbegroting.getChapter(year, chapter); const records = out.items.map((x)=>{ const rec = x as Record<string, unknown>; return record("rijksbegroting", String(rec.name ?? rec.id ?? "Begrotingshoofdstuk"), String(rec.url ?? "https://opendata.rijksbegroting.nl"), rec); }); return toMcpToolPayload(successResponse({ summary: `${records.length} chapter matches`, records, provenance: prov("rijksbegroting_chapter", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Rijksbegroting", "https://opendata.rijksbegroting.nl")); }
  });

  server.registerTool("duo_datasets_search", { description: "Search DUO (Dutch education authority) open datasets. Use education topic keywords.", inputSchema: { query: z.string().describe("Education topic keywords. Examples: 'voortgezet onderwijs', 'leerlingaantallen', 'mbo diploma'. Do NOT pass full questions."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, annotations: TOOL_ANNOTATIONS }, async ({ query, rows, offset, limit, outputFormat, verbose, dryRun }) => {
    const rw = rewriteQuery(query, "moderate");
    // DUO's catalogue is CKAN too: quoted phrases are understood there.
    const ckanQuery = rw.syntaxQuery ?? rw.rewritten;
    try {
      const effectiveLimit = limit ?? rows;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(rows, offset + effectiveLimit));

      if (dryRun) {
        return dryRunPayload({
          connector: "duo",
          url: `${config.endpoints.duoDatasets}/api/3/action/package_search`,
          params: { q: ckanQuery, rows: fetchRows },
        });
      }

      const started = Date.now();
      const out = await duo.datasetsCatalog(ckanQuery, fetchRows);
      const responseTimeMs = Date.now() - started;

      const records = out.items.map((x)=>record("duo", String(x.title ?? x.name ?? x.id ?? "DUO dataset"), String(x.url ?? "https://onderwijsdata.duo.nl"), x));
      const response = buildFormattedResponse({
        summary: `${records.length} DUO datasets`,
        records,
        provenance: prov("duo_datasets_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total),
        outputFormat,
        offset,
        limit: effectiveLimit,
        total: out.total,
        access_note: rewriteNote({ ...rw, rewritten: ckanQuery }),
        verbose: singleConnectorVerbose({
          enabled: verbose,
          connector: "duo",
          endpoint: out.endpoint,
          responseTimeMs,
        }),
      });
      return toMcpToolPayload(response);
    } catch(e){ return toMcpToolPayload(mapSourceError(e, "DUO", "https://onderwijsdata.duo.nl")); }
  });

  server.registerTool("duo_schools", {
    description: "Find individual Dutch schools and education institutions (per vestiging) from DUO's address registers. Returns real school records — name, BRIN/instellingscode, address, municipality, denomination, phone, website — not dataset descriptions. Filter by municipality, place, postcode and sector (po/vo/mbo/ho); pass a school name as free-text search.",
    inputSchema: {
      name: z.string().optional().describe("School or institution name (free-text search across all fields). Example: 'Beatrix College', 'Sint Jozef'."),
      municipality: z.string().optional().describe("Municipality (gemeente) name, exact match, case-insensitive input. Example: 'Tilburg'."),
      place: z.string().optional().describe("Place (woonplaats) name, exact match, case-insensitive input. Example: 'Berkel-Enschot'."),
      postcode: z.string().optional().describe("Postcode, with or without space. Example: '5041 EB' or '5041EB'."),
      sector: z.enum(["po", "vo", "mbo", "ho"]).default("po").describe("Education sector: po = primary (basisonderwijs), vo = secondary, mbo = vocational, ho = higher education."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ name, municipality, place, postcode, sector, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) return dryRunPayload({ connector: "duo", url: `${config.endpoints.duoDatasets}/api/3/action/datastore_search`, params: { sector, name, municipality, place, postcode, limit: fetchRows } });
      const started = Date.now();
      const out = await duo.getSchools({ name, municipality, place, postcode, sector, top: fetchRows });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record(
        "duo",
        x.naam || "School",
        x.url,
        { naam: x.naam, instellingscode: x.instellingscode, vestigingscode: x.vestigingscode, bevoegd_gezag: x.bevoegdGezag, onderwijstype: x.onderwijstype, straat: x.straat, postcode: x.postcode, plaats: x.plaats, gemeente: x.gemeente, gemeentecode: x.gemeentecode, provincie: x.provincie, denominatie: x.denominatie, telefoon: x.telefoon, website: x.website },
        [x.straat, x.postcode, x.plaats].filter(Boolean).join(", "),
      ));
      const response = buildFormattedResponse({ summary: `${records.length} onderwijsvestigingen (${sector})`, records, provenance: prov("duo_schools", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total), outputFormat, offset, limit: effectiveLimit, total: out.total, access_note: out.access_note, verbose: singleConnectorVerbose({ enabled: verbose, connector: "duo", endpoint: out.endpoint, responseTimeMs }) });
      return toMcpToolPayload(response);
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "DUO", "https://onderwijsdata.duo.nl")); }
  });

  server.registerTool("duo_exam_results", {
    description: "Get per-school (per vestiging) secondary-education exam results from DUO: pass rate (slagingspercentage), number of candidates, passes/failures and average school/central exam marks. Filter by school year, municipality, school name and education type (VMBO/HAVO/VWO). Use sortByScore to rank schools by pass rate. Coverage: school years 2013-2017.",
    inputSchema: {
      year: z.number().int().min(2000).max(2100).optional().describe("School year. The dataset covers 2013-2017; a year outside that range returns 0 records with an explanation in access_note. Leave empty for all covered years, newest first."),
      school: z.string().optional().describe("School name (free-text search). Example: 'Beatrix College'."),
      municipality: z.string().optional().describe("Municipality of the school location, exact match, case-insensitive input. Example: 'Tilburg'."),
      onderwijstype: z.string().optional().describe("Education type: VMBO, HAVO or VWO (exact match, case-insensitive input)."),
      sortByScore: z.boolean().default(false).describe("Sort by pass rate (slagingspercentage) descending — use when asked which school scores best."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ year, school, municipality, onderwijstype, sortByScore, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) return dryRunPayload({ connector: "duo", url: `${config.endpoints.duoDatasets}/api/3/action/datastore_search`, params: { year, school, municipality, onderwijstype, sortByScore, limit: fetchRows } });
      const started = Date.now();
      const out = await duo.getExamResults({ year, school, municipality, onderwijstype, sortByScore, top: fetchRows });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record(
        "duo",
        `${x.school}${x.onderwijstype ? ` — ${x.onderwijstype}` : ""}`,
        x.url,
        { school: x.school, brin: x.brin, brin_vestiging: x.brinVestiging, gemeente: x.gemeente, provincie: x.provincie, onderwijstype: x.onderwijstype, schooljaar: x.schooljaar, examenkandidaten: x.examenkandidaten, geslaagden: x.geslaagden, gezakten: x.gezakten, slagingspercentage: x.slagingspercentage, gemiddeld_cijfer_schoolexamen: x.gemiddeldSchoolexamen, gemiddeld_cijfer_centraal_examen: x.gemiddeldCentraalExamen, gemiddeld_cijfer_cijferlijst: x.gemiddeldCijferlijst },
        `${x.slagingspercentage ?? "?"}% geslaagd (${x.geslaagden ?? "?"}/${x.examenkandidaten ?? "?"})`,
        x.schooljaar ? String(x.schooljaar) : undefined,
      ));
      const response = buildFormattedResponse({ summary: `${records.length} examenresultaten per vestiging`, records, provenance: prov("duo_exam_results", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total), outputFormat, offset, limit: effectiveLimit, total: out.total, access_note: out.access_note, verbose: singleConnectorVerbose({ enabled: verbose, connector: "duo", endpoint: out.endpoint, responseTimeMs }) });
      return toMcpToolPayload(response);
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "DUO", "https://onderwijsdata.duo.nl")); }
  });

  server.registerTool("duo_rio_search", { description: "Search the DUO Register Instellingen en Opleidingen (RIO). Use institution or program names.", inputSchema: { query: z.string().describe("Institution or education program name. Examples: 'Universiteit Utrecht', 'geneeskunde', 'HBO informatica'. Do NOT pass full questions."), top: z.number().int().min(1).max(config.limits.maxRows).default(20) }, annotations: TOOL_ANNOTATIONS }, async ({ query, top }) => {
    const rw = rewriteQuery(query, "moderate");
    try { const out = await duo.rioSearch(rw.rewritten, top); const records = out.items.map((x)=>record("duo-rio", String(x.naam ?? x.name ?? x.id ?? "RIO"), String(x.url ?? "https://duo.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} RIO resultaten`, records, provenance: prov("duo_rio_search", out.endpoint, out.params, records.length, records.length), access_note: rewriteNote(rw) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "DUO RIO", "https://lod.onderwijsregistratie.nl")); }
  });

  server.registerTool("overheid_api_register_search", { description: "Search the Dutch government API register (developer.overheid.nl). Use API/data topic keywords. Requires OVERHEID_API_KEY.", inputSchema: { query: z.string().describe("API or data topic keywords. Examples: 'BAG adressen', 'KvK', 'BRP'. Do NOT pass full questions."), top: z.number().int().min(1).max(config.limits.maxRows).default(20), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, annotations: TOOL_ANNOTATIONS }, async ({ query, top, offset, limit, outputFormat, verbose, dryRun }) => {
    const rw = rewriteQuery(query, "moderate");
    const effectiveLimit = limit ?? top;
    const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));

    if (dryRun) {
      return dryRunPayload({
        connector: "api_register",
        url: config.endpoints.apiRegister,
        params: { query: rw.rewritten, top: fetchRows },
      });
    }

    const apiKey = process.env[ENV_KEYS.OVERHEID_API_KEY];
    if (!apiKey) return toMcpToolPayload(errorResponse({ error: "not_configured", message: "OVERHEID_API_KEY ontbreekt", suggestion: "Set OVERHEID_API_KEY to use this tool" }));

    try {
      const started = Date.now();
      const out = await new ApiRegisterSource(config, apiKey).search(rw.rewritten, fetchRows);
      const responseTimeMs = Date.now() - started;

      const records = out.items.map((x)=>record("api-register", String(x.name ?? x.title ?? x.id ?? "API"), String(x.portalUrl ?? x.url ?? "https://apis.developer.overheid.nl"), x));
      const response = buildFormattedResponse({
        summary: `${records.length} API's`,
        records,
        provenance: prov("overheid_api_register_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), records.length),
        outputFormat,
        offset,
        limit: effectiveLimit,
        // API-register (JSON of HTML-scrape fallback) levert geen totaal-count;
        // null i.p.v. records.length zodat has_more op de records-heuristiek valt.
        total: null,
        access_note: mergeAccessNotes(rewriteNote(rw), "Requires OVERHEID_API_KEY"),
        verbose: singleConnectorVerbose({
          enabled: verbose,
          connector: "api_register",
          endpoint: out.endpoint,
          responseTimeMs,
        }),
      });
      return toMcpToolPayload(response);
    } catch(e){ return toMcpToolPayload(mapSourceError(e, "Overheid API Register", "https://apis.developer.overheid.nl")); }
  });

  server.registerTool("knmi_datasets", { description: "List all available KNMI weather datasets. Requires KNMI_API_KEY.", annotations: TOOL_ANNOTATIONS }, async () => {
    const apiKey = process.env[ENV_KEYS.KNMI_API_KEY];
    if (!apiKey) return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI_API_KEY ontbreekt", suggestion: "Set KNMI_API_KEY to use KNMI tools" }));
    try { const out = await new KnmiSource(config, apiKey).datasets(); const records = out.items.map((x)=>record("knmi", String(x.name ?? x.datasetName ?? "KNMI dataset"), "https://developer.dataplatform.knmi.nl", x)); return toMcpToolPayload(successResponse({ summary: `${records.length} KNMI datasets`, records, provenance: prov("knmi_datasets", out.endpoint, out.params, records.length, records.length), access_note: out.access_note })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "KNMI")); }
  });

  server.registerTool("knmi_search_datasets", { description: "Search KNMI weather datasets by keyword. Requires KNMI_API_KEY.", inputSchema: { query: z.string().optional() }, annotations: TOOL_ANNOTATIONS }, async ({ query }) => {
    const apiKey = process.env[ENV_KEYS.KNMI_API_KEY];
    if (!apiKey) return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI_API_KEY ontbreekt", suggestion: "Set KNMI_API_KEY to use KNMI tools" }));
    try { const out = await new KnmiSource(config, apiKey).searchDatasets(query); const records = out.items.map((x)=>record("knmi", String(x.name ?? x.datasetName ?? "KNMI dataset"), "https://developer.dataplatform.knmi.nl", x)); return toMcpToolPayload(successResponse({ summary: `${records.length} KNMI dataset matches`, records, provenance: prov("knmi_search_datasets", out.endpoint, out.params, records.length, records.length), access_note: out.access_note })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "KNMI")); }
  });

  server.registerTool("knmi_latest_files", { description: "Get latest data files from a specific KNMI dataset. Requires KNMI_API_KEY.", inputSchema: { datasetName: z.string(), datasetVersion: z.string().optional().describe("Dataset version. When omitted, it is auto-resolved from the KNMI dataset catalog (e.g. Actuele10mindataKNMIstations -> version 2); falls back to '1' for unknown datasets."), top: z.number().int().min(1).max(200).default(50) }, annotations: TOOL_ANNOTATIONS }, async ({ datasetName, datasetVersion, top }) => {
    const apiKey = process.env[ENV_KEYS.KNMI_API_KEY];
    if (!apiKey) return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI_API_KEY ontbreekt", suggestion: "Set KNMI_API_KEY to use KNMI tools" }));
    try { const out = await new KnmiSource(config, apiKey).latestFiles(datasetName, datasetVersion, top); const records = out.items.map((x)=>record("knmi", String(x.filename ?? x.name ?? "KNMI file"), "https://developer.dataplatform.knmi.nl", x)); return toMcpToolPayload(successResponse({ summary: `${records.length} KNMI files`, records, provenance: prov("knmi_latest_files", out.endpoint, out.params, records.length, records.length), access_note: "Requires KNMI_API_KEY" })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "KNMI")); }
  });

  server.registerTool("knmi_latest_observations", { description: "Get the latest KNMI weather observation files. Requires KNMI_API_KEY.", inputSchema: { top: z.number().int().min(1).max(200).default(20) }, annotations: TOOL_ANNOTATIONS }, async ({ top }) => {
    const apiKey = process.env[ENV_KEYS.KNMI_API_KEY];
    if (!apiKey) return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI_API_KEY ontbreekt", suggestion: "Set KNMI_API_KEY to use KNMI tools" }));
    try { const out = await new KnmiSource(config, apiKey).latestObservations(top); const records = out.items.map((x)=>record("knmi", String(x.filename ?? x.name ?? "Observation file"), "https://developer.dataplatform.knmi.nl", x)); return toMcpToolPayload(successResponse({ summary: `${records.length} observation files`, records, provenance: prov("knmi_latest_observations", out.endpoint, out.params, records.length, records.length), access_note: "Requires KNMI_API_KEY" })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "KNMI")); }
  });

  server.registerTool("knmi_warnings", { description: "Get current KNMI weather warnings for the Netherlands. Requires KNMI_API_KEY.", inputSchema: { top: z.number().int().min(1).max(200).default(20) }, annotations: TOOL_ANNOTATIONS }, async ({ top }) => {
    const apiKey = process.env[ENV_KEYS.KNMI_API_KEY];
    if (!apiKey) return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI_API_KEY ontbreekt", suggestion: "Set KNMI_API_KEY to use KNMI tools" }));
    try { const out = await new KnmiSource(config, apiKey).warnings(top); const records = out.items.map((x)=>record("knmi", String(x.filename ?? x.name ?? "Warning file"), "https://developer.dataplatform.knmi.nl", x)); const accessNote = (out as { access_note?: string }).access_note ?? "Requires KNMI_API_KEY"; return toMcpToolPayload(successResponse({ summary: `${records.length} warning files`, records, provenance: prov("knmi_warnings", out.endpoint, out.params, records.length, records.length), access_note: accessNote })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "KNMI")); }
  });

  server.registerTool("knmi_earthquakes", { description: "Get recent earthquake data from KNMI. Requires KNMI_API_KEY.", inputSchema: { top: z.number().int().min(1).max(200).default(20) }, annotations: TOOL_ANNOTATIONS }, async ({ top }) => {
    const apiKey = process.env[ENV_KEYS.KNMI_API_KEY];
    if (!apiKey) return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI_API_KEY ontbreekt", suggestion: "Set KNMI_API_KEY to use KNMI tools" }));
    try { const out = await new KnmiSource(config, apiKey).earthquakes(top); const records = out.items.map((x)=>record("knmi", String(x.filename ?? x.name ?? "Earthquake file"), "https://developer.dataplatform.knmi.nl", x)); const accessNote = (out as { access_note?: string }).access_note ?? "Requires KNMI_API_KEY"; return toMcpToolPayload(successResponse({ summary: `${records.length} earthquake files`, records, provenance: prov("knmi_earthquakes", out.endpoint, out.params, records.length, records.length), access_note: accessNote })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "KNMI")); }
  });

  server.registerTool("pdok_search", { inputSchema: { query: z.string().describe("Address or location search string. Examples: 'Damrak 1 Amsterdam', 'Utrecht Centraal', 'Gemeente Eindhoven'. Use Dutch place names and addresses."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search PDOK Locatieserver for Dutch addresses and locations. Use specific address strings or place names.", annotations: TOOL_ANNOTATIONS }, async ({ query, rows }) => {
    try {
      const out = await pdok.search({ query, rows });
      const records = out.items.map((x) => record("pdok", String(x.weergavenaam ?? x.id ?? "PDOK locatie"), "https://www.pdok.nl", x, String(x.type ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} PDOK resultaten`, records, provenance: prov("pdok_search", out.endpoint, out.params, records.length, out.total) }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "PDOK", "https://www.pdok.nl"));
    }
  });

  server.registerTool("bag_lookup_address", { inputSchema: { query: z.string().optional(), postcode: z.string().optional(), huisnummer: z.string().optional(), rows: z.number().int().min(1).max(config.limits.maxRows).default(10) }, description: "Lookup BAG (Basisregistratie Adressen en Gebouwen) address details via PDOK Locatieserver. Search by free text, postcode, or house number.", annotations: TOOL_ANNOTATIONS }, async ({ query, postcode, huisnummer, rows }) => {
    if (!query && !postcode) {
      return toMcpToolPayload(errorResponse({ error: "unexpected", message: "Geef minimaal query of postcode op", suggestion: "Gebruik query='Damrak 1 Amsterdam' of postcode+huisnummer" }));
    }
    try {
      const out = await pdok.bagLookupAddress({ query, postcode, huisnummer, rows });
      const records = out.items.map((x) => record("bag", String(x.weergavenaam ?? x.id ?? "BAG adres"), "https://www.pdok.nl", x, String(x.straatnaam ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} BAG adressen`, records, provenance: prov("bag_lookup_address", out.endpoint, out.params, records.length, out.total) }));
    } catch {
      const out = pdok.fallbackAddress({ query, postcode, huisnummer, rows });
      const records = out.items.map((x) => record("bag", String(x.weergavenaam ?? x.id ?? "BAG adres"), "https://www.pdok.nl", x));
      return toMcpToolPayload(successResponse({ summary: `${records.length} BAG fallback resultaten`, records, provenance: prov("bag_lookup_address", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
    }
  });

  // A real calendar day: "2026-13-45" passes a pattern but makes ORI answer HTTP 400.
  const oriDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), "Use an existing date (YYYY-MM-DD)");
  server.registerTool("ori_search", { inputSchema: { query: z.string().describe("Council topic keywords. Examples: 'parkeerbeleid', 'bestemmingsplan', 'raadsvergadering woningbouw'. Do NOT pass full questions. By default all words must occur (see 'match')."), sort: z.enum(["relevance", "date_newest"]).default("relevance").describe("'date_newest' sorts server-side by meeting date (last_discussed_at, the last meeting that discussed the record — not the publication date) and leaves out dates after today unless date_to is set. 'relevance' for general searches."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20), bestuurslaag: z.string().optional().describe("Filter by government layer: 'gemeente', 'provincie' or 'waterschap'. Other values are not applied (reported in access_note)."), gemeente: z.string().optional().describe("Scope to one body, e.g. 'Delft', 'Den Haag', 'Leidschendam-Voorburg', 'Provincie Noord-Holland', 'Hoogheemraadschap van Delfland'. Matched exactly against the live ORI index list (gemeenten, provincies, waterschappen); a name without an ORI index returns no records and says so. Without it a search runs across all indices."), date_from: oriDate.optional().describe("Only records dated on or after this day (YYYY-MM-DD). Filters on the meeting date (last_discussed_at; start_date for reports)."), date_to: oriDate.optional().describe("Only records dated on or before this day (YYYY-MM-DD), same date field as date_from."), match: z.enum(["all", "any"]).default("all").describe("'all' (default): every word must occur. 'any': at least one word (broad, many more hits).") }, description: "Search Open Raadsinformatie (ORI) — council documents, agenda items, meetings and decisions of Dutch municipalities, provinces and water boards. Use policy topic keywords; set 'gemeente' to answer 'what did the council of X discuss', 'bestuurslaag' to restrict to a layer, 'date_from'/'date_to' for a period and 'sort' for recency. Results show a short passage; ori_document_get (data.index, data.id) reads a document's full text or only the pages with a term. The query accepts \"phrases\", uppercase OR/AND/NOT, -term and prefix*; a lowercase or/and/not is searched as a word (e.g. OR = ondernemingsraad). Documents link to their file (data.original_url, also on each attachment, is the source system's own link if ORI's link fails; where ORI's link is known to fail the link already goes to the source system, see link_note); meetings and agenda items link to the meeting's page in the council information system (link_type 'meeting_page'; iBabs, Notubiz, Parlaeus or GemeenteOplossingen, see source_system; an agenda item to its meeting's page, anchored on the item where possible) when that page answered a check during the search, or where a page cannot be checked itself, when the system's own API confirmed the meeting (GemeenteOplossingen, whose API also names the page, and Haarlem's Notubiz site); else, also when the checks ran out of time (about 3 s per search), to their ORI API record, which is JSON and not a web page (link_type 'ori_record', reason in link_note); ori_record_url keeps the ORI record next to a meeting page, and their documents are under 'attachments'. data.date_type says what the date is (vergaderdatum, documentdatum, or an iBabs list date such as a deadline). Totals above 10000 are reported as a lower bound; access_note warns when the ORI index is stale.", annotations: TOOL_ANNOTATIONS }, async ({ query, sort, rows, bestuurslaag, gemeente, date_from, date_to, match }) => {
    // The rewriter lowercases and drops symbols, so with every word required
    // "parkeren OR fietsen" became three required words. Search syntax goes through as typed.
    const rw = rewriteQuery(query, OriSource.hasQuerySyntax(query) ? "passthrough" : "moderate");
    try {
      const out = await ori.search({ query: rw.rewritten, rows, sort, bestuurslaag, gemeente, date_from, date_to, match });
      // The snippet is the record's own field; keep it out of `data` so it is not sent twice.
      const records = out.items.map(({ snippet, ...x }) => record("ori", String(x.title ?? x.id ?? "ORI item"), String(x.url ?? ""), x, String(snippet ?? x.type ?? ""), String(x.publishedAt ?? "")));
      const scope = out.scope_label ?? gemeente;
      const totalText = out.total != null ? ` (van ${out.total} treffers)` : out.total_lower_bound != null ? ` (van ${out.total_lower_bound}+ treffers)` : "";
      const summary = out.no_index ? `Geen ORI-index voor '${scope}' — niet gezocht` : `${records.length} ORI resultaten${scope ? ` — ${scope}` : ""}${totalText}`;
      return toMcpToolPayload(successResponse({ summary, records, provenance: prov("ori_search", out.endpoint, out.params, records.length, out.total ?? undefined), access_note: mergeAccessNotes(rewriteNote(rw), out.access_note) }));
    } catch (e) {
      const mapped = mapSourceError(e, "ORI", "https://www.openraadsinformatie.nl");
      return toMcpToolPayload({ ...mapped, suggestion: oriFailureHint(e) ?? mapped.suggestion });
    }
  });

  server.registerTool("ori_document_get", {
    description: "Read the text of one Open Raadsinformatie (ORI) document. index and id come from an ori_search record (data.index, data.id), or an attachments[].id with the same index. Returns ORI's extracted text page by page ('--- pagina N ---'), as Markdown where ORI has it, with the metadata (title, organisation, meeting date, file link, original_url). zoekterm returns only the pages holding a term (zoekterm_pages lists them; case and accents ignored); pagina ('3' or '3-5') reads a page range; max_chars caps the text (default 12000, max 50000) and next_pagina says where to continue. Agenda items and meetings have no text of their own (their documents are in attachment_ids). A document ORI extracted no text from (scans, audio) says so and links the file. The text is ORI's automatic extraction; the file at url is the source.",
    inputSchema: {
      index: z.string().regex(ORI_INDEX_RE, "Use the ORI index name from ori_search's data.index, e.g. 'ori_delft', 'osi_noord-holland', 'owi_limburg'.").describe("ORI index name from ori_search's data.index, e.g. 'ori_delft', 'ori_leidschendam-voorburg', 'osi_noord-holland'. Not a municipality name."),
      id: z.string().regex(ORI_ID_RE, "Use the record id from ori_search's data.id, e.g. '1731608'.").describe("Record id from ori_search's data.id (or attachments[].id), e.g. '1731608'."),
      zoekterm: z.string().max(200).optional().describe("Only the pages that contain this term (as written; else pages with all its words), e.g. 'parkeernorm'."),
      pagina: z.union([z.number().int().min(1).max(99_999), z.string().regex(ORI_PAGINA_RE, "Use a page number or range, e.g. '3' or '3-5'.").refine((v) => parsePagina(v) !== undefined, "A range runs from a lower to a higher page, e.g. '3-5'.")]).optional().describe("Page or page range, e.g. 3 or '3-5'. Combines with zoekterm."),
      max_chars: z.number().int().min(1).max(ORI_TEXT_MAX_CHARS).default(ORI_TEXT_DEFAULT_CHARS).describe(`Maximum characters of text (default ${ORI_TEXT_DEFAULT_CHARS}, max ${ORI_TEXT_MAX_CHARS}).`),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ index, id, zoekterm, pagina, max_chars }) => {
    try {
      const out = await ori.getDocument({ index, id, zoekterm, pagina, max_chars });
      const r = out.item;
      if (!r) {
        return toMcpToolPayload(successResponse({
          summary: out.not_found === "index" ? `ORI-index '${index}' bestaat niet` : `ORI-record ${index}/${id} niet gevonden`,
          records: [],
          provenance: prov("ori_document_get", out.endpoint, out.params, 0, 0),
          access_note: out.access_note,
        }));
      }
      const label = String(r.type_label ?? r.type);
      const pages = r.text_available
        ? r.pages_returned
          ? `pagina ${String(r.pages_returned)} van ${String(r.page_count)}, ${String(r.text_chars)} tekens${r.text_truncated ? " (afgekapt)" : ""}`
          : `geen pagina's geselecteerd (${String(r.page_count)} pagina's)`
        : "geen tekst";
      const snippet = [label, String(r.organization ?? ""), pages].filter(Boolean).join(" — ");
      const records = [record("ori", String(r.title ?? id), String(r.url ?? out.endpoint), r, snippet, String(r.publishedAt ?? ""))];
      return toMcpToolPayload(successResponse({
        summary: `ORI ${label.toLowerCase()} '${String(r.title ?? id)}'${r.organization ? ` (${String(r.organization)})` : ""} — ${pages}`,
        records,
        provenance: prov("ori_document_get", out.endpoint, out.params, 1, 1),
        access_note: out.access_note,
      }));
    } catch (e) {
      logger.warn({ err: e, tool: "ori_document_get", index, id }, "Primary source failed");
      const mapped = mapSourceError(e, "ORI", "https://www.openraadsinformatie.nl");
      return toMcpToolPayload({ ...mapped, suggestion: oriDocumentFailureHint(e) });
    }
  });

  server.registerTool("ndw_search", { inputSchema: { query: z.string().describe("Traffic data topic keywords. Examples: 'verkeersdrukte A2', 'snelheid', 'filedata'. Do NOT pass full questions."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search NDW open traffic data (Dutch road network). Use traffic topic or road keywords.", annotations: TOOL_ANNOTATIONS }, async ({ query, rows }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const out = await ndw.search({ query: rw.rewritten, rows });
      const records = out.items.map((x) => record("ndw", String(x.title ?? x.id ?? "NDW item"), String(x.url ?? "https://www.ndw.nu"), x, String(x.description ?? ""), String(x.updated_at ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} NDW resultaten`, records, provenance: prov("ndw_search", out.endpoint, out.params, records.length, out.total), access_note: mergeAccessNotes(rewriteNote(rw), (out as { access_note?: string }).access_note) }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "NDW", "https://www.ndw.nu"));
    }
  });

  server.registerTool("luchtmeetnet_latest", { inputSchema: { component: z.string().optional().describe("Optional component filter: NO2, PM10, PM25, O3, SO2, CO."), plaats: z.string().optional().describe("Optional place/city name, e.g. 'Utrecht' or 'Den Haag'. Resolved to that place's measuring stations; places without a station return an explanation instead of national data."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Fetch latest air quality measurements from Luchtmeetnet. Filter by place (city) and/or component (e.g. NO2, PM10, PM2.5, O3). Use for 'luchtkwaliteit', 'fijnstof', 'smog' questions.", annotations: TOOL_ANNOTATIONS }, async ({ component, plaats, rows }) => {
    try {
      const out = await luchtmeetnet.latest({ component, plaats, rows });
      const records = out.items.map((x) => record("luchtmeetnet", `${String(x.formula ?? "component")}-${String(x.station_name ?? x.station_number ?? "station")}`, "https://www.luchtmeetnet.nl", x, `${String(x.component ?? x.formula ?? "")}: ${String(x.value ?? "")} ${String(x.unit ?? "")}`, String(x.timestamp ?? x.timestamp_measured ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} luchtmeetnet metingen`, records, provenance: prov("luchtmeetnet_latest", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch {
      const out = luchtmeetnet.fallback({ component, rows });
      const records = out.items.map((x) => record("luchtmeetnet", `${String(x.formula ?? "component")}-${String(x.station_name ?? x.station_number ?? "station")}`, "https://www.luchtmeetnet.nl", x, `${String(x.component ?? x.formula ?? "")}: ${String(x.value ?? "")} ${String(x.unit ?? "")}`, String(x.timestamp ?? x.timestamp_measured ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} luchtmeetnet fallback metingen`, records, provenance: prov("luchtmeetnet_latest", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
    }
  });

  server.registerTool("rdw_open_data_search", { inputSchema: { query: z.string().describe("Vehicle data keywords or license plate (kenteken). Examples: 'AB-123-CD', 'elektrisch', 'terugroepactie'. For license plate lookups, pass the plate directly."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search RDW open vehicle data (Dutch vehicle registry). Use a license plate (kenteken) or vehicle topic keywords.", annotations: TOOL_ANNOTATIONS }, async ({ query, rows }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const live = await rdw.search({ query: rw.rewritten, rows });
      if (live.items.length) {
        const records = live.items.map((x) => record("rdw", String(x.title ?? x.kenteken ?? x.id ?? "RDW voertuig"), "https://opendata.rdw.nl", x as Record<string, unknown>, String(x.voertuigsoort ?? ""), String(x.updated_at ?? "")));
        return toMcpToolPayload(successResponse({ summary: `${records.length} RDW resultaten`, records, provenance: prov("rdw_open_data_search", live.endpoint, live.params, records.length, live.total), access_note: mergeAccessNotes(rewriteNote(rw), (live as { access_note?: string }).access_note) }));
      }

      const out = rdw.fallback({ query, rows });
      const records = out.items.map((x) => record("rdw", String(x.title ?? x.id ?? "RDW voertuig"), "https://opendata.rdw.nl", x as Record<string, unknown>, String(x.voertuigsoort ?? ""), String(x.updated_at ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} RDW fallback resultaten`, records, provenance: prov("rdw_open_data_search", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
    } catch {
      const out = rdw.fallback({ query, rows });
      const records = out.items.map((x) => record("rdw", String(x.title ?? x.id ?? "RDW voertuig"), "https://opendata.rdw.nl", x as Record<string, unknown>, String(x.voertuigsoort ?? ""), String(x.updated_at ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} RDW fallback resultaten`, records, provenance: prov("rdw_open_data_search", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
    }
  });

  server.registerTool("rijkswaterstaat_waterdata_search", { inputSchema: { query: z.string().describe("Water management topic keywords. Examples: 'waterstand', 'golfhoogte', 'debiet Rijn', 'waterkwaliteit'. Do NOT pass full questions."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search Rijkswaterstaat water data catalog (water levels, waves, flow, quality). Use water management topic keywords.", annotations: TOOL_ANNOTATIONS }, async ({ query, rows }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const out = await rwsWaterdata.search({ query: rw.rewritten, rows });
      const records = out.items.map((x) => record("rijkswaterstaat-waterdata", String(x.title ?? x.id ?? "RWS waterdata"), "https://waterinfo.rws.nl", x as Record<string, unknown>, String(x.category ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} RWS waterdata resultaten`, records, provenance: prov("rijkswaterstaat_waterdata_search", out.endpoint, out.params, records.length, out.total), access_note: mergeAccessNotes(rewriteNote(rw), (out as { access_note?: string }).access_note) }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Rijkswaterstaat Waterdata", "https://waterinfo.rws.nl"));
    }
  });

  server.registerTool("rijkswaterstaat_waterdata_measurements", { inputSchema: { query: z.string().describe("Water measurement query with optional location. Examples: 'waterstand Maas', 'golfhoogte Noordzee', 'debiet Rijn', 'waterstand Lobith', 'temperatuur IJsselmeer'. Combine a measurement type with an optional location name."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Get latest real-time water measurements (water levels, waves, flow, temperature) from Rijkswaterstaat stations. Returns actual measured values with timestamps.", annotations: TOOL_ANNOTATIONS }, async ({ query, rows }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const out = await rwsWaterdata.latestMeasurements({ query: rw.rewritten, rows });
      const records = out.items.map((x) => record("rijkswaterstaat-waterdata", `${x.location_name} – ${x.measurement_type}`, "https://waterinfo.rws.nl", x as Record<string, unknown>, `${x.value ?? "?"} ${x.unit}`));
      return toMcpToolPayload(successResponse({ summary: `${records.length} RWS metingen (${out.totalBeforeFilter ?? records.length} stations totaal)`, records, provenance: prov("rijkswaterstaat_waterdata_measurements", out.endpoint, out.params, records.length, out.totalBeforeFilter ?? out.total), access_note: mergeAccessNotes(rewriteNote(rw), (out as { access_note?: string }).access_note) }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Rijkswaterstaat Waterdata", "https://waterinfo.rws.nl"));
    }
  });

  server.registerTool("ngr_discovery_search", { inputSchema: { query: z.string().describe("Geo/spatial data topic keywords. Examples: 'bodemkaart', 'hoogtemodel', 'kadastrale grenzen', 'natura 2000'. Do NOT pass full questions."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search Nationaal GeoRegister (NGR) for geospatial metadata (maps, WMS/WFS services). Use spatial data topic keywords.", annotations: TOOL_ANNOTATIONS }, async ({ query, rows }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const out = await ngr.search({ query: rw.rewritten, rows });
      const records = out.items.map((x) => record("ngr", String(x.title ?? x.id ?? "NGR metadata"), String(x.url ?? "https://www.nationaalgeoregister.nl"), x as Record<string, unknown>));
      return toMcpToolPayload(successResponse({ summary: `${records.length} NGR metadata records`, records, provenance: prov("ngr_discovery_search", out.endpoint, out.params, records.length, out.total), access_note: mergeAccessNotes(rewriteNote(rw), (out as { access_note?: string }).access_note) }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Nationaal GeoRegister", "https://www.nationaalgeoregister.nl"));
    }
  });

  /** Both DSO tools without a key: the same answer, and how to get one. */
  const dsoNotConfigured = () =>
    toMcpToolPayload(
      errorResponse({
        error: "not_configured",
        message: "DSO_API_KEY ontbreekt",
        suggestion:
          "Vraag een sleutel aan via https://developer.omgevingswet.overheid.nl/formulieren/api-key-aanvragen-0/ en zet DSO_API_KEY. Lees-only PDOK-tegeldata is geen alternatief; vector tiles bevatten geen documentmetadata.",
      }),
    );
  /** A DSO_API_KEY that is missing or would be refused as a header: the payload to return, never the value. */
  const dsoKeyProblem = (apiKey: string | undefined) => {
    const problem = dsoApiKeyProblem(apiKey);
    if (problem === "ontbreekt") return dsoNotConfigured();
    if (!problem) return undefined;
    // Never the value itself: it may be (part of) a real key.
    return toMcpToolPayload(
      errorResponse({
        error: "not_configured",
        message: "DSO_API_KEY bevat ongeldige tekens (spaties, regeleinden of andere tekens die een HTTP-header niet toestaat) en is niet verstuurd.",
        suggestion: "Zet in DSO_API_KEY alleen de sleutel zelf, zonder aanhalingstekens of witruimte erin.",
      }),
    );
  };
  const dsoInputError = (e: DsoInputError) => toMcpToolPayload(errorResponse({ error: "unexpected", message: e.message, suggestion: e.suggestion, details: e.details }));
  /**
   * Any other failure of the DSO tools. The DSO refuses a malformed DSO_API_KEY with
   * HTTP 400 and an unknown one with 401/403: a configuration error, not a missing
   * document. A broken %-escape in a pasted URL is an input error; a Locatieserver
   * failure is named as such. The key itself is never in a message.
   */
  const dsoSourceError = (e: unknown) => {
    if (e instanceof URIError) {
      return dsoInputError(new DsoInputError("Identificatie met een ongeldige %-codering.", "Geef identificatie ('/akn/nl/act/gm0344/2020/omgevingsplan'), uriIdentificatie of technischId uit dso_omgevingsdocumenten_search."));
    }
    if (e instanceof SourceRequestError && e.endpoint.startsWith(DSO_PRESENTEREN_BASE) && (e.status === 400 || e.status === 401 || e.status === 403)) {
      return toMcpToolPayload(
        errorResponse({
          error: "not_configured",
          message:
            e.status === 400
              ? "Het DSO weigerde het verzoek (HTTP 400): meestal een DSO_API_KEY met een ongeldig formaat, anders een parameter die het DSO niet accepteert."
              : `Het DSO weigerde DSO_API_KEY (HTTP ${e.status}): de sleutel is onbekend, ingetrokken of niet geautoriseerd.`,
          suggestion: "Controleer DSO_API_KEY (de volledige sleutel, zonder aanhalingstekens) of vraag een nieuwe aan via https://developer.omgevingswet.overheid.nl/formulieren/api-key-aanvragen-0/.",
          details: { endpoint: e.endpoint, status: e.status },
        }),
      );
    }
    const locatieserver = e instanceof SourceRequestError && /^https:\/\/api\.pdok\.nl\//.test(e.endpoint);
    return toMcpToolPayload(mapSourceError(e, locatieserver ? "PDOK Locatieserver (locatie voor het DSO)" : "DSO Omgevingsdocumenten", DSO_RODK_URL));
  };

  /**
   * Longest wait for dso_omgevingsdocumenten_search: a name or area loads the
   * national catalogue first, and a hanging DSO must give a clear error before
   * the MCP client's own 60 s timeout.
   */
  const DSO_SEARCH_DEADLINE_MS = 45_000;

  server.registerTool(
    "dso_omgevingsdocumenten_search",
    {
      description:
        "Search Omgevingswet documents in the DSO (Digitaal Stelsel Omgevingswet) at document level: omgevingsplannen, omgevingsvisies, programma's, omgevingsverordeningen, waterschapsverordeningen, voorbereidingsbesluiten (voorbeschermingsregels), projectbesluiten and the Rijk's AMvB's; soort 'ontwerpregelingen' gives the drafts, with their inzagetermijn where the DSO has one. Requires DSO_API_KEY. " +
        "'locatie' (address, postcode or place): the documents whose werkingsgebied covers that point, all layers; not which artikelen apply there (an artikel can have a smaller werkingsgebied). " +
        "'bevoegdGezag' (TOOI code such as gm0344, or a name): only the documents that body issued itself; 'provincie': the provincie's plus those of all its gemeenten. Without these, 'query' and 'documentType' search the national catalogue. " +
        "Returns metadata, most recently changed first (by the start of the current version): title, type, bevoegd gezag, versie with beginGeldigheid and eindGeldigheid (exclusive; versieGeldigTotEnMet is the last day; not the end of the regeling), canonical_url to the readable text (for an ontwerp its publication) and identificatie (technischId for an ontwerp) for dso_omgevingsdocument_tekst, which returns the rule text. " +
        "Two Rijk records at every location hold no rules (Omgevingswet: a pointer only; Aansluitdocument Rijk: technical); title and opmerking say so. access_note says what was searched and, per bestuurslaag, what was found and left out.",
      inputSchema: {
        query: z.string().max(200).optional().describe("Words that must all occur (whole words, case and accents ignored) in title, citeertitel, opschrift, bevoegd gezag or type, and for an ontwerp also its ontwerpbesluit's citeertitel (the project or street), e.g. 'omgevingsvisie Utrecht', 'geluid'. Without bevoegdGezag, provincie or locatie the whole catalogue is searched."),
        locatie: z.string().max(200).optional().describe("Address, postcode (with or without house number) or place, e.g. 'Brennerbaan 150, Utrecht', '3524 BN 150' or 'Lunetten, Utrecht'. Resolved via the PDOK Locatieserver to one point, within the gemeente or woonplaats the input names ('Den Haag' and 's-Gravenhage both work, also next to a postcode), never in another place; an unknown address or a name that fits several places is an error naming them. A missing house number or another street than the one named is stated in access_note. Returns the documents whose werkingsgebied covers the point, all layers. A place name becomes its centre point: use bevoegdGezag or provincie for all documents of a gemeente or provincie."),
        bevoegdGezag: z.string().max(200).optional().describe("The issuing body: only the documents it adopted itself, not those of other bodies in its area. TOOI code in any case (gm0344 = gemeente Utrecht, pv26 = provincie Utrecht, ws0636 = Hoogheemraadschap De Stichtse Rijnlanden) or a name ('Utrecht', 'gemeente Utrecht', 'provincie Utrecht', 'De Stichtse Rijnlanden', also 'Den Bosch', 'Friesland', 'HDSR', 'BZK'). A bare name is the gemeente, else the provincie ('Limburg'), else the waterschap; documentType omgevingsverordening picks the provincie and waterschapsverordening the waterschap ('Utrecht' + omgevingsverordening = pv26). access_note names the alternatives. Not together with provincie."),
        provincie: z.string().max(200).optional().describe("An area: a provincie by name or code ('Utrecht', 'Fryslân', 'pv26'), giving the documents of the provincie itself plus those of all gemeenten in it (gemeenten from the PDOK Locatieserver). Waterschappen and the Rijk are not included. Works with soort, alleen_ter_inzage, documentType, typeBevoegdGezag and query; each record still names its issuing bevoegdGezag. Not together with bevoegdGezag or locatie."),
        typeBevoegdGezag: z.enum(["gemeente", "provincie", "waterschap", "ministerie"]).optional().describe("Filter on the layer of the issuing body; also picks the layer for a name such as 'Utrecht'."),
        documentType: z.enum(DSO_DOCUMENT_TYPES).optional().describe("Exact document type. 'voorbereidingsbesluit' = voorbeschermingsregels (also those of an omgevingsplan or omgevingsverordening); 'omgevingsplan' is the omgevingsplan only; 'projectbesluit' includes its omgevingsplanregels."),
        soort: z.enum(["regelingen", "ontwerpregelingen"]).default("regelingen").describe("'regelingen' (default): documents in force. 'ontwerpregelingen': drafts, one record per ontwerpbesluit, with besluitTitel, bekendOp, beginInzagetermijn, eindeInzagetermijn and terInzage: true or false when the DSO has the inzagetermijn, null when it has none (inzagetermijnBekend false, about a third of recent drafts; the termijn is then only in the bekendmaking). mogelijkTerInzage marks such a draft announced in the last 56 days. bekendmakingId/bekendmakingUrl: the publication of the ontwerpbesluit (officiele_bekendmakingen_record_get takes the id), which is leading for the exact termijn and how to respond; onderwerp: the publication's title where the DSO title names no subject, null when unknown."),
        alleen_ter_inzage: z.boolean().default(false).describe("Only drafts ter inzage today (implies soort 'ontwerpregelingen'): first those whose inzagetermijn in the DSO includes today, then those without an inzagetermijn in the DSO announced in the last 56 days, marked mogelijkTerInzage (check the bekendmaking); access_note gives both counts. With bevoegdGezag: only that body's own drafts; with provincie: those of the provincie and its gemeenten; with neither: every draft in the Netherlands, each with its bevoegd gezag."),
        // The same calendar-day check as ori_search's dates.
        geldigOp: oriDate.optional().describe("YYYY-MM-DD: the versions that were geldig and in werking on that day (sent as geldigOp and inWerkingOp) instead of today's; not for ontwerpregelingen."),
        rows: z.number().int().min(1).max(config.limits.maxRows).optional().describe(`Maximum records (1-${config.limits.maxRows}). Default 50 with locatie, where one point usually has 20-40 documents and the Rijk's come last; else 20. access_note says per bestuurslaag what was left out.`),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ query, locatie, bevoegdGezag, provincie, typeBevoegdGezag, documentType, soort, alleen_ter_inzage, geldigOp, rows }) => {
      const apiKey = process.env[ENV_KEYS.DSO_API_KEY];
      const keyProblem = dsoKeyProblem(apiKey);
      if (keyProblem) return keyProblem;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const src = new DsoOmgevingsdocumentenSource(config, (apiKey as string).trim());
        const search = src.search({ query, locatie, bevoegdGezag, provincie, typeBevoegdGezag, documentType, soort, alleenTerInzage: alleen_ter_inzage, geldigOp, rows });
        const deadline = new Promise<"deadline">((resolve) => {
          deadlineTimer = setTimeout(() => resolve("deadline"), DSO_SEARCH_DEADLINE_MS);
        });
        const out = await Promise.race([search, deadline]);
        if (out === "deadline") {
          // The search runs on in the background and fills the catalogue cache for the next call.
          search.catch(() => undefined);
          const seconds = Math.round(DSO_SEARCH_DEADLINE_MS / 1000);
          return toMcpToolPayload(
            errorResponse({
              error: "timeout",
              message: `DSO Omgevingsdocumenten gaf binnen ${seconds} s geen antwoord.`,
              suggestion: "Probeer het zo opnieuw: wat intussen binnenkomt wordt bewaard. Of zoek gerichter: bevoegdGezag als TOOI-code (gm0344) in plaats van een naam, of een locatie.",
              details: { endpoint: DSO_PRESENTEREN_BASE, timeout_s: seconds },
            }),
          );
        }
        const records = out.items.map(dsoRecord);
        const scope = out.locatie
          ? ` — ${out.locatie.weergavenaam}`
          : out.bevoegdGezag
            ? ` — ${out.bevoegdGezag.naam ? `${out.bevoegdGezag.naam} (${out.bevoegdGezag.code})` : out.bevoegdGezag.code}`
            : out.provincie
              ? ` — ${out.provincie.naam ?? out.provincie.code} (${out.provincie.code}) en haar ${out.provincie.gemeenten} gemeenten`
              : "";
        // Of everything found, not only the records shown: per bestuurslaag at a location, and
        // for ontwerpen those ter inzage by their DSO termijn apart from those possibly so.
        const layers = out.perBestuurslaag?.map((l) => `${l.laag} ${l.aantal}`).join(", ");
        const inzage = out.terInzageAantal;
        const terInzage =
          inzage && (alleen_ter_inzage || inzage.bevestigd || inzage.mogelijk)
            ? `${alleen_ter_inzage ? "" : "waarvan "}${inzage.bevestigd} ter inzage${inzage.mogelijk ? `, ${inzage.mogelijk} mogelijk ter inzage` : ""}`
            : undefined;
        const breakdown = [layers, terInzage].filter(Boolean).join("; ");
        const of = out.total > records.length ? `van ${out.total}` : "";
        const counts = of && breakdown ? ` (${of}: ${breakdown})` : of || breakdown ? ` (${of || breakdown})` : "";
        return toMcpToolPayload(
          successResponse({
            summary: `${records.length} DSO ${soort === "ontwerpregelingen" || alleen_ter_inzage ? "ontwerp-omgevingsdocumenten" : "omgevingsdocumenten"}${scope}${counts}`,
            records,
            provenance: prov("dso_omgevingsdocumenten_search", out.endpoint, out.query, records.length, out.total),
            access_note: out.access_note,
          }),
        );
      } catch (e) {
        if (e instanceof DsoInputError) return dsoInputError(e);
        return dsoSourceError(e);
      } finally {
        clearTimeout(deadlineTimer);
      }
    },
  );

  server.registerTool(
    "dso_omgevingsdocument_tekst",
    {
      description:
        "Read the rule text (regeltekst) of one DSO omgevingsdocument as plain text, by hoofdstuk, afdeling and artikel, with leden, begrippen and tables. It does not tell which artikelen apply at a location. Requires DSO_API_KEY. " +
        "Pass the identificatie from dso_omgevingsdocumenten_search (or uriIdentificatie, an identifier.overheid.nl URL, an ontwerp's technischId). The Rijk's AMvB's work too (Bbl = '/akn/nl/act/mnre1034/2018/BWBR0041297'; search with typeBevoegdGezag 'ministerie'). " +
        "'zoekterm': only the artikelen, begrippen and toelichting parts holding every word, with heading path, regels first; a hit over max_tekens gives its passages (ingekort: true, eId for the rest). It finds the word only: a rule applying through a general term or an afwijking may not repeat it, so also read the main hit's afdeling. " +
        "'onderdeel': one part by eId or label ('Artikel 4.24', 'artikel 4.1 lid 2'). " +
        "Toelichting parts (toelichting: true) explain a rule and are not binding. An omgevingsplan's voorbeschermingsregels are a tijdelijk deel that prevails where it deviates: access_note lists them, zoekterm searches them (tijdelijkDeel: true). " +
        "An ontwerp reads as the regeling after the change; weergave 'wijzigingen' shows only the changes. " +
        "Without zoekterm or onderdeel a long document returns its beginning plus a table of contents whose eIds work as onderdeel. For the Omgevingswet the DSO holds only a pointer (access_note links wetten.overheid.nl); the Aansluitdocument Rijk has no rules.",
      inputSchema: {
        identificatie: z.string().min(1).max(500).describe("identificatie, uriIdentificatie or (ontwerp) technischId from dso_omgevingsdocumenten_search, e.g. '/akn/nl/act/gm0344/2020/omgevingsplan'."),
        zoekterm: z.string().max(200).optional().describe("Words that must all occur in a part, case and accents ignored, e.g. 'dakkapel' or 'dakkapel achterkant'. Plain text matching: a word also matches inside longer words ('dakkapel' finds 'dakkapellen'), and a plural of 7+ letters ending in -en or -s also matches its stem ('dakkapellen' finds 'dakkapel', 'windturbines' finds 'windturbine'). A plural that changes its vowel does not: 'zonnepanelen' misses 'zonnepaneel', so search 'zonnepan'. No synonyms."),
        onderdeel: z.string().optional().describe("One part: an eId or wId (from the table of contents or a zoekterm result), or a label such as 'Artikel 4.24', 'artikel 4.1 lid 2', 'Hoofdstuk 4', 'Afdeling 4.2', 'Bijlage II'."),
        weergave: z.enum(["nieuw", "wijzigingen"]).default("nieuw").describe("For an ontwerp: 'nieuw' (default) is the regeling as the ontwerp would make it; 'wijzigingen' only what the ontwerp changes, with [+added+] and [-deleted-] text, [nieuw]/[vervalt] before whole parts and renumbered parts listed as 'alleen vernummerd' (use it for 'wat verandert er'). Combine with onderdeel or zoekterm to narrow it."),
        geldigOp: oriDate.optional().describe("YYYY-MM-DD: the version geldig and in werking on that day instead of today (sent as geldigOp and inWerkingOp; not for ontwerpregelingen)."),
        max_tekens: z.number().int().min(500).max(DSO_TEXT_MAX_CHARS).default(DSO_TEXT_DEFAULT_CHARS).describe(`Maximum characters of text returned (default ${DSO_TEXT_DEFAULT_CHARS}, max ${DSO_TEXT_MAX_CHARS}).`),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ identificatie, zoekterm, onderdeel, weergave, geldigOp, max_tekens }) => {
      const apiKey = process.env[ENV_KEYS.DSO_API_KEY];
      const keyProblem = dsoKeyProblem(apiKey);
      if (keyProblem) return keyProblem;
      // An eId or label is short; a long onderdeel is not one (and must not reach the label matching).
      if (onderdeel && onderdeel.length > 300) {
        return dsoInputError(new DsoInputError(`Onderdeel van ${onderdeel.length} tekens: te lang voor een eId of label.`, "Geef een eId uit de inhoudsopgave of een label zoals 'Artikel 4.24' of 'artikel 4.1 lid 2'."));
      }
      const onlyOntwerp = () =>
        dsoInputError(
          new DsoInputError(
            "weergave 'wijzigingen' is er alleen voor een ontwerp: een regeling zelf heeft geen renvooi.",
            "Geef de technischId van een ontwerp uit dso_omgevingsdocumenten_search met soort 'ontwerpregelingen', of laat weergave weg.",
          ),
        );
      // An ontwerp is named by its technischId ("…_akn_nl_bill_…"), its ontwerpbesluit ("/akn/nl/bill/…") or an ontwerpregelingen URL.
      if (weergave === "wijzigingen" && !/akn[/_]nl[/_]bill[/_]|\/ontwerpregelingen\//i.test(identificatie)) return onlyOntwerp();
      try {
        const src = new DsoOmgevingsdocumentenSource(config, (apiKey as string).trim());
        // As selectDsoText reads them: weergave wijzigingen first, then onderdeel, then zoekterm.
        const searching = zoektermWords(zoekterm ?? "").length > 0 && !onderdeel?.trim() && weergave !== "wijzigingen";
        const out = await src.documentText({ identificatie, geldigOp, weergave, tijdelijkeDelen: searching ? "tekst" : "lijst" });
        if (weergave === "wijzigingen" && out.kind !== "ontwerpregeling") return onlyOntwerp();
        // An ontwerp of a new regeling (or one that changes no text) has no renvooi: its text is the change.
        const wijzigingen = weergave === "wijzigingen" && Boolean(out.doc.renvooi);
        const delen = out.tijdelijkeDelen ?? [];
        const searched = delen.filter((t) => t.doc);
        const sel = selectDsoText(out.doc, {
          zoekterm,
          onderdeel,
          maxChars: max_tekens,
          weergave: wijzigingen ? "wijzigingen" : "nieuw",
          tijdelijkeDelen: searching ? searched.map((t) => t.doc as NonNullable<typeof t.doc>) : undefined,
        });
        const item = out.item;
        const docTitle = item?.title ?? identificatie;
        const placeholder = out.placeholder;
        if (sel.notFound) {
          return dsoInputError(
            placeholder
              ? new DsoInputError(`Onderdeel '${onderdeel}' staat niet in het DSO: van ${docTitle} bevat het DSO alleen een verwijzing, niet de wettekst.`, `Lees de wet op ${placeholder.url}.`)
              : new DsoInputError(
                  `Onderdeel '${onderdeel}' niet gevonden in ${docTitle}${sel.notFound.reason ? `: ${sel.notFound.reason}` : "."}`,
                  `${sel.notFound.suggestions.length ? `Bestaande onderdelen: ${sel.notFound.suggestions.join(", ")}. ` : ""}Roep de tool zonder onderdeel en zoekterm aan voor de inhoudsopgave met eIds, of zoek met zoekterm.`,
                ),
          );
        }
        const url = item?.documentUrl ?? DSO_RODK_URL;
        const date = item ? (item.soort === "ontwerpregeling" ? item.bekendOp : (item.beginGeldigheid ?? item.beginInwerking)) : undefined;
        const documentFields = {
          document: docTitle,
          identificatie: item?.identificatie,
          ...(out.kind === "ontwerpregeling" ? { technischId: out.pathId } : { uriIdentificatie: out.pathId }),
          bevoegdGezag: item?.bevoegdGezag,
          bevoegdGezagCode: item?.bevoegdGezagCode,
          documentType: item?.documentType,
          ...(geldigOp && out.kind === "regeling" ? { geldigOp } : {}),
        };
        // A tijdelijk deel by what it is: "Voorbeschermingsregels: Voorbereidingsbesluit dakkapellen …".
        const deelLabel = (t: (typeof delen)[number]) => (/^voorbeschermingsregels/i.test(t.item?.documentType ?? "") ? "Voorbeschermingsregels" : "Tijdelijk deel");
        const deelTitle = (t: (typeof delen)[number]) => t.item?.title ?? t.uriIdentificatie;
        const partFields = (part: DsoTextPart) => ({
          onderdeel: part.title,
          ...(part.pad ? { pad: part.pad } : {}),
          ...(part.eId ? { eId: part.eId, wId: part.wId } : {}),
          onderdeelType: part.type,
          ...(part.toelichting ? { toelichting: true } : {}),
          ...(part.wijziging ? { wijziging: part.wijziging } : {}),
          ...(part.tekensVolledig ? { ingekort: true, tekensOnderdeel: part.tekensVolledig } : {}),
          tekst: part.tekst,
        });
        const wholeDocument = sel.mode === "volledig" || sel.mode === "begin_met_inhoudsopgave";
        let first = true;
        const records = sel.parts.map((part) => {
          const deel = part.tijdelijkDeel !== undefined ? searched[part.tijdelijkDeel] : undefined;
          if (deel) {
            return record(
              "dso_omgevingsdocumenten",
              `${deelLabel(deel)}: ${deelTitle(deel)} — ${part.title}`,
              deel.item?.documentUrl ?? DSO_RODK_URL,
              {
                document: deelTitle(deel),
                identificatie: deel.item?.identificatie,
                uriIdentificatie: deel.uriIdentificatie,
                bevoegdGezag: deel.item?.bevoegdGezag,
                bevoegdGezagCode: deel.item?.bevoegdGezagCode,
                documentType: deel.item?.documentType,
                tijdelijkDeel: true,
                tijdelijkDeelVan: item?.identificatie ?? identificatie,
                ...partFields(part),
              },
              part.tekst.slice(0, 300),
              deel.item?.beginGeldigheid,
            );
          }
          const own = record(
            "dso_omgevingsdocumenten",
            wholeDocument ? docTitle : `${part.title} — ${docTitle}`,
            url,
            {
              ...documentFields,
              ...partFields(part),
              ...(first && sel.inhoudsopgave ? { inhoudsopgave: sel.inhoudsopgave } : {}),
              ...(first ? { tekensDocument: sel.totalChars, afgekapt: sel.truncated } : {}),
            },
            part.tekst.slice(0, 300),
            date,
          );
          first = false;
          return own;
        });
        const shown = records.length;
        const deelMatches = sel.matchesTijdelijk ?? 0;
        const ownMatches = (sel.matches ?? 0) - deelMatches;
        const counts = sel.wijzigingen;
        const summary =
          placeholder && (sel.mode === "volledig" || !sel.matches)
            ? `Alleen een verwijzing in het DSO: de tekst van ${docTitle} staat op ${placeholder.url}`
            : out.technisch && sel.mode === "volledig"
              ? `Technisch aansluitdocument zonder regels: ${docTitle}`
              : sel.mode === "volledig"
                ? `Regeltekst ${docTitle} (${sel.totalChars} tekens)`
                : sel.mode === "begin_met_inhoudsopgave"
                  ? `Begin van ${docTitle} met inhoudsopgave (${sel.totalChars} tekens in totaal)`
                  : sel.mode === "wijzigingen" && counts
                    ? `${sel.matches ?? 0} ${sel.matches === 1 ? "wijziging" : "wijzigingen"} in ontwerp ${docTitle}${onderdeel ? ` (${onderdeel})` : ""}${zoekterm ? ` met '${zoekterm}'` : ""}: ${counts.gewijzigd} gewijzigd, ${counts.nieuw} nieuw, ${counts.vervalt} vervallen, ${counts.vernummerd} alleen vernummerd${shown < (sel.onderdelen ?? 0) ? ` (${shown} van ${sel.onderdelen} onderdelen getoond)` : ""}`
                    : sel.mode === "zoekterm"
                      ? `${ownMatches} ${ownMatches === 1 ? "onderdeel" : "onderdelen"} met '${zoekterm}' in ${docTitle}${deelMatches ? ` en ${deelMatches} in ${searched.length === 1 ? "het tijdelijke deel" : "de tijdelijke delen"}${searched.every((t) => deelLabel(t) === "Voorbeschermingsregels") ? " (voorbeschermingsregels)" : ""}` : ""}${shown < (sel.matches ?? 0) ? ` (${shown} getoond)` : ""}`
                      : `${sel.parts[0]?.title ?? onderdeel} — ${docTitle}`;
        // A part by name, a tijdelijk deel's with its own title in front.
        const named = (p: { title: string; eId: string; tijdelijkDeel?: number }) => {
          const deel = p.tijdelijkDeel !== undefined ? searched[p.tijdelijkDeel] : undefined;
          return `${deel ? `${deelLabel(deel)}: ${deelTitle(deel)} — ` : ""}${p.title}${p.eId ? ` [${p.eId}]` : ""}`;
        };
        const omitted = sel.omitted?.length ? sel.omitted.map(named).join("; ") : undefined;
        // At most ten named; a broad zoekterm shortens dozens.
        const shortList = sel.shortened ?? [];
        const shortened = shortList.length
          ? `${shortList.slice(0, 10).map((s) => `${named(s)} (${s.chars} tekens)`).join("; ")}${shortList.length > 10 ? ` en ${shortList.length - 10} meer` : ""}`
          : undefined;
        const fromDeel = [...(sel.omitted ?? []), ...shortList].some((p) => p.tijdelijkDeel !== undefined);
        const listed = (sel.onderdelen ?? sel.matches ?? 0) - shown > (sel.omitted?.length ?? 0) ? " …" : "";
        const modeNote =
          sel.mode === "begin_met_inhoudsopgave"
            ? `Het document is ${sel.totalChars} tekens; getoond: het begin en de inhoudsopgave (tot en met ${sel.inhoudsopgaveNiveau}). Vraag een deel op met onderdeel (een eId uit de inhoudsopgave, of bijv. 'Artikel 1.1') of zoek met zoekterm.`
            : sel.mode === "zoekterm" || sel.mode === "wijzigingen"
              ? sel.matches
                ? [
                    shortened
                      ? `Ingekort wegens max_tekens (${max_tekens}): ${shortened}; tekst geeft daarvan de kop en ${sel.mode === "zoekterm" ? "de passages met de zoekterm, met wat ze inleidt" : "het begin"} (ingekort: true). Vraag de volledige tekst op met onderdeel (het eId${fromDeel ? "; bij een tijdelijk deel met diens identificatie" : ""}).`
                      : undefined,
                    omitted
                      ? `Niet getoond wegens max_tekens (${max_tekens}): ${omitted}${listed}. ${
                          sel.mode === "wijzigingen"
                            ? "Vraag ze op met weergave 'wijzigingen' en onderdeel (een eId, of een deel als 'Hoofdstuk 5'), of beperk ze met zoekterm"
                            : "Vraag ze op met onderdeel"
                        }; of verhoog max_tekens (max ${DSO_TEXT_MAX_CHARS}).`
                      : undefined,
                  ].filter(Boolean).join(" ") || undefined
                : placeholder
                  ? undefined
                  : sel.mode === "wijzigingen"
                    ? `Geen wijzigingen${onderdeel ? ` in '${onderdeel}'` : ""}${zoekterm ? ` met alle woorden van '${zoekterm}'` : ""} in dit ontwerp.`
                    : `Geen onderdelen met alle woorden van '${zoekterm}'. Probeer een kortere of andere zoekterm, of vraag de inhoudsopgave op (zonder zoekterm).`
              : [
                  sel.truncated ? `Onderdeel afgekapt op ${max_tekens} tekens; vraag een kleiner onderdeel op (zie de koppen) of verhoog max_tekens (max ${DSO_TEXT_MAX_CHARS}).` : undefined,
                  omitted ? `Ook gevonden onder dezelfde naam: ${omitted}.` : undefined,
                ].filter(Boolean).join(" ") || undefined;
        const wijzigingenNote = wijzigingen
          ? "Weergave 'wijzigingen': alleen wat dit ontwerp verandert, uit de renvooi in het DSO. [+tekst+] = toegevoegd, [-tekst-] = geschrapt; [nieuw] en [vervalt] staan voor een heel onderdeel dat erbij komt of vervalt; 'alleen vernummerd' = alleen het nummer verandert, de tekst niet; […] = ongewijzigde tekst weggelaten. Een begrip in een bijlage met 'nieuwe versie van /join/id/regdata/…' verwijst naar een nieuwe versie van dat informatieobject (de kaart verandert)."
          : weergave === "wijzigingen"
            ? "Dit ontwerp heeft geen renvooi in het DSO (een nieuwe regeling, of een ontwerp dat geen tekst wijzigt): getoond is de tekst zelf."
            : undefined;
        // The tijdelijke delen (voorbeschermingsregels) that are part of this regeling, or the regeling a tijdelijk deel is part of.
        const soortDocument = /omgevingsplan/i.test(item?.documentType ?? "") ? "dit omgevingsplan" : "deze regeling";
        const deelList = (list: typeof delen) =>
          list
            .map((t) => `${deelTitle(t)} (${[t.item?.documentType, t.item?.bevoegdGezag, t.item?.beginGeldigheid ? `sinds ${t.item.beginGeldigheid}` : undefined, `identificatie ${t.item?.identificatie ?? t.uriIdentificatie}`].filter(Boolean).join(", ")})`)
            .join("; ");
        const readable = delen.filter((t) => !t.error);
        const failed = delen.filter((t) => t.error);
        const extra = (out.tijdelijkeDelenTotaal ?? 0) - delen.length;
        const voorrang = (n: number) => (n === 1 ? "het gaat voor waar zijn voorrangsregel dat bepaalt" : "ze gaan voor waar hun voorrangsregel dat bepaalt");
        const deelNote =
          [
            searching && searched.length
              ? `Ook doorzocht: ${searched.length === 1 ? "het tijdelijke deel" : `de ${searched.length} tijdelijke delen`} van ${soortDocument} (${voorrang(searched.length)}): ${deelList(searched)}. ${deelMatches ? "Treffers daarin heten '<soort>: <titel> — <onderdeel>' (tijdelijkDeel: true); lees verder met hun identificatie." : "Daarin geen treffers."}`
              : undefined,
            !searching && readable.length
              ? `Bij ${soortDocument} ${delen.length === 1 ? "hoort 1 tijdelijk deel dat niet in deze tekst staat" : `horen ${delen.length} tijdelijke delen die niet in deze tekst staan`}; ${voorrang(delen.length)}: ${deelList(readable)}. Lees ${delen.length === 1 ? "het" : "ze"} met deze tool (identificatie); met zoekterm ${delen.length === 1 ? "wordt het" : "worden ze"} meegezocht.`
              : undefined,
            failed.length ? `${failed.length === 1 ? "Tijdelijk deel" : "Tijdelijke delen"} van ${soortDocument} niet te lezen: ${failed.map((t) => `${t.uriIdentificatie} (${t.error})`).join("; ")}.` : undefined,
            extra > 0 ? `Plus ${extra} ${extra === 1 ? "tijdelijk deel" : "tijdelijke delen"}, niet getoond.` : undefined,
          ]
            .filter(Boolean)
            .join(" ") || undefined;
        const parent = out.tijdelijkDeelVan;
        const parentNote = parent
          ? `Dit is een tijdelijk deel van ${parent.item ? `${parent.item.title} (${parent.item.identificatie ?? parent.uriIdentificatie})` : parent.uriIdentificatie}: deze regels horen bij die regeling en gaan daarop voor waar hun voorrangsregel dat bepaalt.`
          : undefined;
        const stemNote = sel.stems?.length ? `Meervoud ook gezocht als stam: ${sel.stems.map((s) => `'${s.word}' als '${s.stem}'`).join(", ")}.` : undefined;
        const toelichtingNote = sel.parts.some((p) => p.toelichting)
          ? "Onderdelen met 'Toelichting bij …' (toelichting: true) komen uit de toelichting: uitleg, geen regels; de bindende tekst is het artikel zelf."
          : undefined;
        return toMcpToolPayload(
          successResponse({
            summary,
            records,
            provenance: prov(
              "dso_omgevingsdocument_tekst",
              out.endpoint,
              {
                identificatie,
                ...(zoekterm ? { zoekterm } : {}),
                ...(onderdeel ? { onderdeel } : {}),
                ...(weergave === "wijzigingen" ? { weergave } : {}),
                ...(geldigOp ? { geldigOp } : {}),
                max_tekens: String(max_tekens),
              },
              shown,
              sel.mode === "wijzigingen" ? (sel.onderdelen ?? 0) : sel.mode === "zoekterm" ? (sel.matches ?? 0) : shown,
            ),
            access_note: mergeAccessNotes(
              out.access_note,
              parentNote,
              deelNote,
              wijzigingenNote,
              modeNote,
              stemNote,
              toelichtingNote,
              // Without records there is no canonical_url to point at: name the link itself.
              `Tekst uit de documentstructuur van het DSO (STOP-XML omgezet naar platte tekst); de officiële weergave staat op ${records.length ? "canonical_url" : url}.`,
            ),
          }),
        );
      } catch (e) {
        if (e instanceof DsoInputError) return dsoInputError(e);
        return dsoSourceError(e);
      }
    },
  );

  server.registerTool("ruimtelijke_plannen_search", {
    inputSchema: {
      query: z.string().optional().describe("Optional plan-name keywords (substring match on naam/identificatie/typeplan). Examples: 'centrum', 'bestemmingsplan'. Do NOT pass full questions."),
      bbox: z.string().optional().describe("Optional RD New (EPSG:28992) bounding box 'minx,miny,maxx,maxy'. If omitted, derived from gemeente or defaults to NL-wide."),
      gemeente: z.string().optional().describe("Optional gemeente name. Resolved to a 10km bbox via PDOK Locatieserver and used as substring filter on naamoverheid."),
      status: z.enum(["vigerend", "vervallen", "ontwerp", "vastgesteld", "all"]).optional().default("all").describe("Plan status filter. 'vigerend' matches vastgesteld/geconsolideerd/onherroepelijk; 'all' returns every status."),
      rows: z.number().int().min(1).max(config.limits.maxRows).optional().default(20),
    },
    description: "Search Ruimtelijkeplannen.nl (Wro/Bro plans) via PDOK WMS GetFeatureInfo. Returns plan id, naam, planType, status, gemeente, datum and viewer URL. Discovery-only — no juridische tekst extraction.",
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, bbox, gemeente, status, rows }) => {
    try {
      const out = await ruimtelijkePlannen.search({ query, bbox, gemeente, status: status ?? "all", rows: rows ?? 20 });
      const records = out.items.map((x) => record(
        "ruimtelijke_plannen",
        x.title,
        x.viewerUrl,
        { id: x.id, planType: x.planType, status: x.status, gemeente: x.gemeente, identificatie: x.id, raw: x.raw },
        `${x.planType} — ${x.status} — ${x.gemeente}`.trim(),
        x.date,
      ));
      return toMcpToolPayload(successResponse({
        summary: `${records.length} ruimtelijke plannen`,
        records,
        provenance: prov("ruimtelijke_plannen_search", out.endpoint, out.params, records.length, out.total),
        access_note: out.access_note,
      }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Ruimtelijke Plannen (PDOK WMS)", "https://www.ruimtelijkeplannen.nl"));
    }
  });

  server.registerTool("rechtspraak_search_ecli", { inputSchema: { query: z.string().describe("1-3 core legal topic keywords ONLY. Extract the subject from the user's question. Examples: 'waterschade', 'huurrecht ontbinding', 'arbeidsrecht ontslag'. NEVER include question words, verbs, articles, or full sentences. This API is extremely sensitive to extra words."), sort: z.enum(["relevance", "date_newest", "ruling_newest"]).default("relevance").describe("Use 'date_newest' when user asks for recent/latest/newest results (sorted by publication date). Use 'ruling_newest' to sort by ruling date. Use 'relevance' for general searches."), date_filter: z.enum(["week", "month", "year", "last_year"]).optional().describe("Optional publication date filter. Use 'week' for past 7 days, 'month' for past month, 'year' for this year, 'last_year' for previous year. Only set when user explicitly mentions a time period."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search Dutch case law (Rechtspraak) for ECLI references. IMPORTANT: Pass only topic keywords in 'query', not full sentences. Use 'sort' and 'date_filter' parameters to control recency and time period — do NOT encode these in the query string. For the text of a ruling (beslissing, overwegingen, full text) pass its ECLI to rechtspraak_uitspraak_get.", annotations: TOOL_ANNOTATIONS }, async ({ query, sort, date_filter, rows }) => {
    const rw = rewriteQuery(query, "strict");
    try {
      const out = await rechtspraak.searchEcli({ query: rw.rewritten, rows, sort, date_filter });
      const records = out.items.map((x) => record("rechtspraak", String(x.title ?? x.ecli ?? x.id ?? "Rechtspraak uitspraak"), String(x.link ?? x.id ?? "https://data.rechtspraak.nl"), x, String(x.summary ?? x.ecli ?? ""), String(x.updated ?? "")));
      const notes = mergeAccessNotes(rw.explanation, (out as { access_note?: string }).access_note);
      return toMcpToolPayload(successResponse({ summary: `${records.length} Rechtspraak resultaten`, records, provenance: prov("rechtspraak_search_ecli", out.endpoint, out.params, records.length, out.total), access_note: notes }));
    } catch {
      const out = rechtspraak.fallback({ query: rw.rewritten, rows });
      const records = out.items.map((x) => record("rechtspraak", String(x.title ?? x.ecli ?? "Fallback uitspraak"), String(x.link ?? x.id ?? "https://data.rechtspraak.nl"), x, String(x.summary ?? ""), String(x.updated ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} Rechtspraak fallback resultaten`, records, provenance: prov("rechtspraak_search_ecli", out.endpoint, out.params, records.length, out.total), access_note: mergeAccessNotes(rw.explanation, out.access_note) }));
    }
  });

  /**
   * rechtspraak_uitspraak_get as a result object; nl_gov_ask reads a ruling
   * the question names by its ECLI through it as well.
   */
  async function uitspraakResult({ ecli: input, onderdeel, sectie, zoekterm, max_chars }: { ecli: string; onderdeel: "overzicht" | "beslissing" | "overwegingen" | "volledig"; sectie?: string; zoekterm?: string; max_chars: number }): Promise<ToolResult> {
    const read = readEcliInput(input);
    if ("invalid" in read) return errorResponse({ error: "unexpected", message: read.invalid, suggestion: read.suggestion });
    const { ecli } = read;
    if (sectie !== undefined && sectie.trim() && !sectieIsReadable(sectie)) {
      return errorResponse({ error: "unexpected", message: `Sectie '${sectie.slice(0, 100)}' bevat geen nummer, sectie-id of woord om op te zoeken.`, suggestion: "Geef een sectie uit de inhoudsopgave ('4', '#2', 'kop'), een paragraafnummer ('4.3') of woorden uit een sectietitel ('beoordeling'); zonder sectie geeft onderdeel 'overzicht' de inhoudsopgave." });
    }
    if (!ecli.startsWith("ECLI:NL:")) {
      return errorResponse({ error: "unexpected", message: `${ecli} is geen Nederlandse ECLI: Rechtspraak.nl publiceert alleen uitspraken met een ECLI:NL:…`, suggestion: "Geef een ECLI die begint met 'ECLI:NL:'." });
    }
    const url = uitspraakDetailsUrl(ecli);
    const queryParams: Record<string, string> = { ecli, onderdeel, max_chars: String(max_chars), ...(sectie ? { sectie } : {}), ...(zoekterm ? { zoekterm } : {}) };
    try {
      const out = await rechtspraak.getUitspraak(ecli);
      const doc = out.doc;
      if (!doc) {
        return successResponse({
          summary: `${ecli} niet gevonden op Rechtspraak.nl`,
          records: [],
          provenance: prov("rechtspraak_uitspraak_get", out.endpoint, queryParams, 0, 0),
          access_note: `data.rechtspraak.nl kent ${ecli} niet (HTTP 404): de ECLI bestaat niet of de uitspraak is niet gepubliceerd. Controleer de ECLI of zoek met rechtspraak_search_ecli.`,
        });
      }
      const m = doc.meta;
      const title = m.titel ?? [m.ecli, [m.instantie, m.uitspraakdatum].filter(Boolean).join(", ")].filter(Boolean).join(" ");
      const tuchtrechtPagina = tuchtrechtUrl(m);
      const pageUrl = tuchtrechtPagina ?? url;
      const notes: string[] = [];
      const metaFields: Record<string, unknown> = {
        ecli: m.ecli,
        documenttype: m.documenttype ?? (doc.soort === "conclusie" ? "Conclusie" : doc.soort === "uitspraak" ? "Uitspraak" : undefined),
        instantie: m.instantie,
        uitspraakdatum: m.uitspraakdatum,
        publicatiedatum: m.publicatiedatum,
        zaaknummer: m.zaaknummer,
        ...(m.procedures.length ? { procedures: m.procedures } : {}),
        ...(m.rechtsgebieden.length ? { rechtsgebieden: m.rechtsgebieden } : {}),
        ...(m.zittingsplaats ? { zittingsplaats: m.zittingsplaats } : {}),
        ...(m.vervangt ? { vervangt: m.vervangt } : {}),
        relaties: m.relaties,
        ...(m.wetsverwijzingen.length ? { wetsverwijzingen: m.wetsverwijzingen } : {}),
        ...(m.vindplaatsen.length ? { vindplaatsen: m.vindplaatsen } : {}),
        url: pageUrl,
        data_url: uitspraakDataUrl(ecli),
        ...(m.deeplink ? { deeplink: m.deeplink } : {}),
        tekst_gepubliceerd: Boolean(doc.soort && doc.blocks.length),
        ...(doc.inhoudsindicatie ? { inhoudsindicatie: doc.inhoudsindicatie } : {}),
      };
      const snippet = doc.inhoudsindicatie ? (doc.inhoudsindicatie.length > 300 ? `${doc.inhoudsindicatie.slice(0, 299)}…` : doc.inhoudsindicatie) : undefined;

      if (!doc.soort || !doc.blocks.length) {
        // Metadata only: Rechtspraak registered the ruling but published no text (yet).
        const asked = sectie || zoekterm || onderdeel !== "overzicht";
        return successResponse({
          summary: tuchtrechtPagina ? `${ecli}: tuchtrechtuitspraak, tekst op tuchtrecht.overheid.nl` : `${ecli}: alleen metadata, geen tekst gepubliceerd`,
          records: [record("rechtspraak", title, pageUrl, metaFields, snippet, m.uitspraakdatum)],
          provenance: prov("rechtspraak_uitspraak_get", out.endpoint, queryParams, 1, 1),
          access_note: tuchtrechtPagina
            ? `${ecli} is een tuchtrechtuitspraak: Rechtspraak.nl heeft er alleen metadata van, de tekst staat op ${tuchtrechtPagina}${asked ? " (het gevraagde onderdeel of de zoekterm is hier dus niet te beantwoorden)" : ""}. Tuchtrechtuitspraken zoek je met tuchtrecht_search.`
            : `Rechtspraak.nl heeft van ${ecli} alleen metadata gepubliceerd, geen tekst${doc.inhoudsindicatie ? "" : " en geen inhoudsindicatie"}${asked ? ", dus het gevraagde onderdeel of de zoekterm is niet te beantwoorden" : ""}. De tekst kan later alsnog verschijnen op ${url}.`,
        });
      }

      const sel = selectUitspraakText(doc, { onderdeel, sectie, zoekterm, maxChars: max_chars });
      const toc = uitspraakInhoudsopgave(doc);
      const TOC_MAX = 60;
      const isConclusie = doc.soort === "conclusie";
      const partName = isConclusie ? "conclusie" : "beslissing";
      if (sel.notFound) {
        notes.push(`${sel.notFound.reason}${sel.notFound.suggestions.length ? ` Bestaande secties: ${sel.notFound.suggestions.join(", ")}.` : " De tekst heeft geen secties: vraag onderdeel 'volledig' of zoek met zoekterm."}`);
      } else if (sel.modus === "zoekterm") {
        const shown = sel.treffers?.length ?? 0;
        const total = sel.treffersTotaal ?? 0;
        const scope = sectie ? ` in sectie '${sectie}'` : onderdeel === "beslissing" || onderdeel === "overwegingen" ? ` in de ${onderdeel}${sel.label ? ` (${sel.label})` : ""}` : "";
        const passagesOnly = sel.treffers?.some((t) => t.ingekort);
        notes.push(total
          ? `${total} ${total === 1 ? "alinea bevat" : "alinea's bevatten"} alle woorden van '${zoekterm}'${scope}${shown < total ? `; ${shown} getoond binnen max_chars (${max_chars})` : ""}.${passagesOnly ? " Lange alinea's zijn teruggebracht tot de passages met de zoekterm of afgekapt op max_chars (ingekort: true); vraag zo'n alinea helemaal op met sectie (het nummer)." : ""}`
          : `Geen alinea${scope} bevat alle woorden van '${zoekterm}'. Probeer minder of andere woorden: geen synoniemen, een woord matcht ook binnen langere woorden, en wetsartikelen staan vaak als 'art. 13' in de tekst.`);
      } else if (sel.modus === "overzicht" && !sel.methode) {
        notes.push(`Geen ${partName} herkend (geen sectie met role="beslissing", geen sectie of kopregel 'Beslissing'/'Dictum', geen slotsom); zie de inhoudsopgave, vraag een sectie op of onderdeel 'volledig'.`);
      }
      if (sel.methode && (sel.modus === "overzicht" || sel.modus === "beslissing" || sel.modus === "overwegingen")) {
        notes.push(`${sel.modus === "overwegingen" ? "Overwegingen" : isConclusie ? "Conclusie" : "Beslissing"} gevonden via ${sel.methode}.`);
      }
      if (sel.ingekort && sel.modus !== "zoekterm") {
        notes.push(`Tekst ingekort: ${sel.tekst.length} van ${sel.tekensOnderdeel} tekens getoond (max_chars ${max_chars}, max ${UITSPRAAK_MAX_CHARS}); vraag een sectie op of zoek met zoekterm voor de rest.`);
      }
      if (isConclusie) notes.push("Dit is een conclusie van de Advocaat-Generaal (Parket bij de Hoge Raad): een advies aan de rechter, geen uitspraak. De uitspraak zelf staat bij relaties (latere aanleg).");
      if (toc.length > TOC_MAX) notes.push(`Inhoudsopgave ingekort: ${TOC_MAX} van ${toc.length} secties getoond.`);

      const data: Record<string, unknown> = {
        ...metaFields,
        soort: doc.soort,
        inhoudsopgave: toc.slice(0, TOC_MAX),
        onderdeel: sel.modus,
        ...(sel.label ? { onderdeel_label: sel.label } : {}),
        ...(sel.methode ? { methode: sel.methode } : {}),
        ...(sel.treffers ? { treffers: sel.treffers, treffers_totaal: sel.treffersTotaal } : {}),
        tekst: sel.tekst,
        tekens_getoond: sel.tekst.length,
        tekens_onderdeel: sel.tekensOnderdeel,
        ingekort: sel.ingekort,
      };
      const summary = sel.notFound
        ? `${title}: ${sel.modus === "sectie" ? `sectie '${sectie}'` : sel.modus} niet gevonden`
        : sel.modus === "zoekterm"
          ? `${title}: ${sel.treffersTotaal ?? 0} ${sel.treffersTotaal === 1 ? "alinea" : "alinea's"} met '${zoekterm}'`
          : sel.modus === "overzicht"
            ? `${title}: overzicht${sel.label ? ` met ${partName} (${sel.label})` : `, ${partName} niet herkend`}`
            : `${title}: ${sel.modus === "sectie" ? "sectie" : sel.modus}${sel.label ? ` (${sel.label})` : ""}`;
      return successResponse({
        summary,
        records: [record("rechtspraak", title, pageUrl, data, snippet ?? sel.tekst.slice(0, 300), m.uitspraakdatum)],
        provenance: prov("rechtspraak_uitspraak_get", out.endpoint, queryParams, 1, 1),
        access_note: notes.length ? notes.join(" ") : undefined,
      });
    } catch (e) {
      return mapSourceError(e, "Rechtspraak (data.rechtspraak.nl)", url);
    }
  }

  server.registerTool("rechtspraak_uitspraak_get", {
    description:
      "Read one Dutch court ruling (uitspraak) or Advocaat-Generaal conclusie by ECLI from Rechtspraak's open data (data.rechtspraak.nl): metadata (instantie, dates, zaaknummer, rechtsgebied, procedure), relations to other instances ('In cassatie op …', 'Conclusie: …, Gevolgd'), inhoudsindicatie, a table of contents (inhoudsopgave) and text. " +
      "onderdeel 'overzicht' (default) adds the beslissing (dictum; in a conclusie the closing advice); 'beslissing', 'overwegingen' or 'volledig' return that part; sectie returns one section or numbered paragraph from the inhoudsopgave. zoekterm returns only the paragraphs holding every word, with section and paragraph number. " +
      "The output says how the beslissing or overwegingen were found (marked section, section title, heading line in the text, or slotsom) and when text was cut at max_chars. Some rulings have metadata but no published text: tekst_gepubliceerd is then false. Text is as published (anonymised). Find ECLIs with rechtspraak_search_ecli.",
    inputSchema: {
      ecli: z.string().min(1).max(300).describe("ECLI of the ruling or conclusie, e.g. 'ECLI:NL:HR:2019:2006' (any case; a uitspraken.rechtspraak.nl link also works)."),
      onderdeel: z.enum(["overzicht", "beslissing", "overwegingen", "volledig"]).default("overzicht").describe("'overzicht' (default): metadata, inhoudsindicatie, inhoudsopgave and the beslissing. 'beslissing': the dictum. 'overwegingen': the court's reasoning. 'volledig': the whole text with footnotes (long rulings exceed max_chars: use sectie or zoekterm)."),
      sectie: z.string().max(200).optional().describe("One part instead of onderdeel: a sectie from the inhoudsopgave ('4', '#2', 'kop'), a paragraph number ('4.3', 'r.o. 4.3') or words of a section title ('beoordeling')."),
      zoekterm: z.string().max(200).optional().describe("Words that must all occur in a paragraph, case and accents ignored, e.g. 'zorgplicht' or 'artikel 2 EVRM'. Searches the part chosen by onderdeel or sectie; with 'overzicht' the whole text and its footnotes."),
      max_chars: z.number().int().min(500).max(UITSPRAAK_MAX_CHARS).default(UITSPRAAK_DEFAULT_CHARS).describe(`Maximum characters of text returned (default ${UITSPRAAK_DEFAULT_CHARS}, max ${UITSPRAAK_MAX_CHARS}).`),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async (args) => toMcpToolPayload(await uitspraakResult(args)));

  server.registerTool("rivm_discovery_search", { inputSchema: { query: z.string().describe("Public health topic keywords. Examples: 'vaccinatie', 'luchtkwaliteit gezondheid', 'PFAS', 'infectieziekten'. Do NOT pass full questions."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search/discover RIVM (Dutch public health institute) datasets and API references. Use health/environment topic keywords.", annotations: TOOL_ANNOTATIONS }, async ({ query, rows }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const out = await rivm.search({ query: rw.rewritten, rows });
      const records = out.items.map((x) => record("rivm", String(x.title ?? x.id ?? "RIVM item"), String(x.url ?? "https://www.rivm.nl"), x as Record<string, unknown>, String(x.description ?? ""), String(x.updated_at ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} RIVM discovery resultaten`, records, provenance: prov("rivm_discovery_search", out.endpoint, out.params, records.length, out.total), access_note: mergeAccessNotes(rewriteNote(rw), (out as { access_note?: string }).access_note) }));
    } catch {
      const out = rivm.fallback({ query, rows });
      const records = out.items.map((x) => record("rivm", String(x.title ?? x.id ?? "RIVM item"), String(x.url ?? "https://www.rivm.nl"), x as Record<string, unknown>, String(x.description ?? ""), String(x.updated_at ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} RIVM fallback resultaten`, records, provenance: prov("rivm_discovery_search", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
    }
  });

  server.registerTool("bag_linked_data_select", { inputSchema: { query: z.string(), limit: z.number().int().min(1).max(SPARQL_LIMIT_CAP).default(25) }, description: "Execute a read-only SPARQL SELECT query on Kadaster BAG linked data (buildings and addresses). Only SELECT queries are allowed; LIMIT is capped.", annotations: TOOL_ANNOTATIONS }, async ({ query, limit }) => {
    try {
      const out = await bagLinkedData.select({ query, limit });
      const records = out.items.map((x, i) => record("bag-linked-data", `BAG row ${i + 1}`, "https://api.labs.kadaster.nl/datasets/bag/lv", x, out.safeQuery));
      return toMcpToolPayload(successResponse({ summary: `${records.length} BAG linked-data rows`, records, provenance: prov("bag_linked_data_select", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch (e) {
      if (e instanceof Error && /SELECT|toegestaan|keyword/i.test(e.message)) {
        return toMcpToolPayload(errorResponse({ error: "unexpected", message: e.message, suggestion: "Gebruik een read-only SELECT query met een kleine LIMIT" }));
      }
      const out = bagLinkedData.fallback({ query, limit });
      const records = out.items.map((x, i) => record("bag-linked-data", `BAG fallback row ${i + 1}`, "https://api.labs.kadaster.nl/datasets/bag/lv", x, String(x.note ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} BAG linked-data fallback rows`, records, provenance: prov("bag_linked_data_select", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
    }
  });

  server.registerTool("bag_address_detail", {
    inputSchema: {
      query: z.string().describe("Free-text address (e.g. 'Kelvinring 23a Alblasserdam'). Either `query` or `pdok_id` must be provided.").optional(),
      pdok_id: z.string().describe("PDOK Locatieserver id (e.g. 'adr-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx') as returned by bag_lookup_address. Preferred over `query` when known.").optional(),
    },
    description: "Resolve an address (PDOK Locatieserver id or free-text) and fetch authoritative BAG building/unit detail from the Kadaster Individuele Bevragingen REST API: oppervlakte_m2, bouwjaar, gebruiksdoelen, verblijfsobject-status, pand-status. Requires BAG_API_KEY for full detail; falls back to Locatieserver-only when missing. Use this instead of bag_linked_data_select when the linked-data SPARQL endpoint is down or when you already have an address id.",
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, pdok_id }) => {
    try {
      const out = await bagDetail.lookupDetail({ query, pdok_id });
      const rec = record(
        "bag",
        out.detail.weergavenaam ?? out.detail.pdok_id ?? "BAG address detail",
        "https://api.bag.kadaster.nl/lvbag/individuelebevragingen/v2/",
        out.detail as unknown as Record<string, unknown>,
        out.detail.weergavenaam ?? undefined,
      );
      const hint =
        out.detail.data_kwaliteit === "hard"
          ? "Oppervlakte + bouwjaar uit BAG REST API (HARD)."
          : out.detail.data_kwaliteit === "partial"
          ? "Gedeeltelijke hit: niet alle BAG REST velden beschikbaar."
          : "Alleen Locatieserver-lookup gelukt; BAG REST detail ontbreekt.";
      return toMcpToolPayload(successResponse({
        summary: `BAG detail ${out.detail.data_kwaliteit} voor ${out.detail.weergavenaam ?? out.detail.pdok_id ?? "(onbekend)"}`,
        records: [rec],
        provenance: prov("bag_address_detail", out.endpoints[0] ?? "https://api.pdok.nl/bzk/locatieserver/search/v3_1", { endpoints: String(out.endpoints.length) }, 1, 1),
        access_note: mergeAccessNotes(hint, out.detail.notes.join(" | ") || undefined),
      }));
    } catch (e) {
      return toMcpToolPayload(errorResponse(mapSourceError(e, "bag_address_detail")));
    }
  });

  server.registerTool("rce_linked_data_select", { inputSchema: { query: z.string(), limit: z.number().int().min(1).max(SPARQL_LIMIT_CAP).default(25) }, description: "Execute a read-only SPARQL SELECT query on RCE cultural heritage linked data. Only SELECT queries are allowed; LIMIT is capped.", annotations: TOOL_ANNOTATIONS }, async ({ query, limit }) => {
    try {
      const out = await rceLinkedData.select({ query, limit });
      const records = out.items.map((x, i) => record("rce-linked-data", `RCE row ${i + 1}`, "https://linkeddata.cultureelerfgoed.nl", x, out.safeQuery));
      return toMcpToolPayload(successResponse({ summary: `${records.length} RCE linked-data rows`, records, provenance: prov("rce_linked_data_select", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch (e) {
      if (e instanceof Error && /SELECT|toegestaan|keyword/i.test(e.message)) {
        return toMcpToolPayload(errorResponse({ error: "unexpected", message: e.message, suggestion: "Gebruik een read-only SELECT query met een kleine LIMIT" }));
      }
      const out = rceLinkedData.fallback({ query, limit });
      const records = out.items.map((x, i) => record("rce-linked-data", `RCE fallback row ${i + 1}`, "https://linkeddata.cultureelerfgoed.nl", x, String(x.note ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} RCE linked-data fallback rows`, records, provenance: prov("rce_linked_data_select", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
    }
  });

  server.registerTool("eurostat_datasets_search", { inputSchema: { query: z.string().describe("EU statistics topic keywords. Examples: 'GDP growth', 'unemployment rate', 'energy consumption'. Do NOT pass full questions."), rows: z.number().int().min(1).max(config.limits.maxRows).default(10) }, description: "Search Eurostat for EU statistics datasets by topic keywords.", annotations: TOOL_ANNOTATIONS }, async ({ query, rows }) => {
    const rw = rewriteQuery(query, "moderate");
    const out = eurostat.searchFallback({ query: rw.rewritten, rows });
    const records = out.items.map((x) => record("eurostat", String(x.title ?? x.id ?? "Eurostat dataset"), String(x.url ?? "https://ec.europa.eu/eurostat"), x as Record<string, unknown>));
    return toMcpToolPayload(successResponse({ summary: `${records.length} Eurostat dataset suggesties`, records, provenance: prov("eurostat_datasets_search", out.endpoint, out.params, records.length, out.total), access_note: mergeAccessNotes(rewriteNote(rw), out.access_note) }));
  });

  server.registerTool("eurostat_dataset_preview", { inputSchema: { dataset: z.string(), rows: z.number().int().min(1).max(config.limits.maxRows).default(10), filters: z.record(z.string(), z.string()).optional() }, description: "Fetch preview observations from a Eurostat dataset by dataset code. Optionally filter by dimension values.", annotations: TOOL_ANNOTATIONS }, async ({ dataset, rows, filters }) => {
    try {
      const out = await eurostat.previewDataset({ dataset, rows, filters });
      const records = out.items.map((x) => record("eurostat", `${dataset}:${String(x.observation_key ?? "obs")}`, `https://ec.europa.eu/eurostat/databrowser/view/${encodeURIComponent(dataset)}/default/table?lang=en`, x as Record<string, unknown>, String(x.value ?? ""), String(x.updated ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} Eurostat observaties`, records, provenance: prov("eurostat_dataset_preview", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Eurostat", "https://ec.europa.eu/eurostat"));
    }
  });

  server.registerTool("data_europa_datasets_search", { inputSchema: { query: z.string().describe("EU open data topic keywords. Examples: 'air quality', 'transport statistics', 'agriculture'. Do NOT pass full questions."), rows: z.number().int().min(1).max(config.limits.maxRows).default(10) }, description: "Search the EU open data portal (data.europa.eu) for datasets by topic keywords.", annotations: TOOL_ANNOTATIONS }, async ({ query, rows }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const out = await dataEuropa.datasetsSearch({ query: rw.rewritten, rows });
      const records = out.items.map((x) => record("data-europa", String(x.title ?? x.id ?? "Dataset"), String(x.url ?? "https://data.europa.eu/data"), x as Record<string, unknown>, String(x.notes ?? ""), String(x.metadata_modified ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} data.europa.eu datasets`, records, provenance: prov("data_europa_datasets_search", out.endpoint, out.params, records.length, out.total), access_note: mergeAccessNotes(rewriteNote(rw), (out as { access_note?: string }).access_note) }));
    } catch {
      const out = dataEuropa.fallback({ query, rows });
      const records = out.items.map((x) => record("data-europa", String(x.title ?? x.id ?? "Dataset"), String(x.url ?? "https://data.europa.eu/data"), x as Record<string, unknown>, String(x.notes ?? ""), String(x.metadata_modified ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} data.europa.eu fallback datasets`, records, provenance: prov("data_europa_datasets_search", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
    }
  });

  registerNlGovAsk(server, { config, TOOL_ANNOTATIONS, dataOverheid, cbs, tk, debatten, bekend, rijksoverheid, rijksbegroting, duo, ori, luchtmeetnet, rechtspraak, tenderned, tuchtrecht, samenwerkendeCatalogi, brpGewaspercelen, verkiezingsuitslagen, euCellar, algoritmeregister, record, algoritmeRecord, wodc, wodcRecord, euFunding, euFundingRecord, rvoSubsidies, rvoRecord, onderzoekscalls, onderzoekscallRecord, uitspraakResult, wettenTekstResult, debatRecords, debatSummary, debatNotes, dsoRecord, prov, outputFormatSchema, paginationInputSchema });

  server.registerTool("data_politie_search", {
    description: "Search Dutch registered crime statistics (data.politie.nl / CBS dataderden OData). Filter by region (RegioS gemeente/wijk/buurt code or name), crime type (SoortMisdrijf code or name) and period. Set 'dimension' to explore valid filter values.",
    inputSchema: {
      query: z.string().optional().describe("Free-text filter, used only in dimension-explore mode (matches dimension title/key)."),
      tableId: z.string().default("47013NED").describe("CBS dataderden table id. Examples: 47013NED (registered crimes), 47018NED (monthly wijk/buurt), 84468NED."),
      regio: z.string().optional().describe("RegioS code (e.g. GM0363, NL01, WK036300) or name (e.g. Amsterdam). Names are resolved to a code via the RegioS dimension."),
      soortMisdrijf: z.string().optional().describe("SoortMisdrijf code (e.g. 0.0.0, 1.1.1) or name (e.g. diefstal). Names are resolved via the SoortMisdrijf dimension."),
      periode: z.string().optional().describe("Period: bare year (e.g. 2023 = all months/year-totals of that year) or exact key (e.g. 2023MM01, 2023JJ00)."),
      dimension: z.enum(["RegioS", "SoortMisdrijf", "Perioden"]).optional().describe("Explore the values of a dimension instead of fetching data rows."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, tableId, regio, soortMisdrijf, periode, dimension, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));

      if (dryRun) {
        return dryRunPayload({
          connector: "data_politie",
          url: `https://dataderden.cbs.nl/ODataApi/OData/${tableId}/${dimension ?? "TypedDataSet"}`,
          params: { query, regio, soortMisdrijf, periode, dimension, top: fetchRows },
        });
      }

      const started = Date.now();
      const out = await dataPolitie.search({ query, tableId, regio, soortMisdrijf, periode, dimension, rows: fetchRows });
      const responseTimeMs = Date.now() - started;

      const records = out.items.map((x) => record("data.politie.nl", String(x.title ?? x.id ?? "misdrijfcijfer"), String(x.url ?? "https://data.politie.nl"), x as Record<string, unknown>));
      const response = buildFormattedResponse({
        summary: `${records.length} ${dimension ? "dimensiewaarden" : "misdaadcijfers"}`,
        records,
        provenance: prov("data_politie_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total),
        outputFormat,
        offset,
        limit: effectiveLimit,
        // dataderden OData levert hier geen betrouwbare totaal-count; null laat has_more op de records-heuristiek vallen.
        total: null,
        access_note: out.access_note,
        verbose: singleConnectorVerbose({ enabled: verbose, connector: "data_politie", endpoint: out.endpoint, responseTimeMs }),
      });
      return toMcpToolPayload(response);
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "data.politie.nl", "https://data.politie.nl")); }
  });

  server.registerTool("cbs_iv3_search", {
    description: "Search CBS Iv3 municipal/provincial finance statistics (CBS dataderden OData). Filter by municipality (Gemeenten code or name), task field / balance post (TaakveldBalanspost), category (Categorie) and report type (Verslagsoort; e.g. budget vs. annual accounts). Set 'dimension' to explore valid filter values.",
    inputSchema: {
      query: z.string().optional().describe("Free-text filter, used only in dimension-explore mode (matches dimension title/key)."),
      tableId: z.string().default("45071NED").describe("CBS dataderden table id. Default 45071NED (gemeentefinanciën)."),
      gemeente: z.string().optional().describe("Gemeenten code (e.g. GM1680) or name (e.g. Rotterdam). Names are resolved via the Gemeenten dimension."),
      taakveldBalanspost: z.string().optional().describe("TaakveldBalanspost code (e.g. 0.1) or name."),
      categorie: z.string().optional().describe("Categorie code (e.g. L1.1) or name."),
      verslagsoort: z.string().optional().describe("Verslagsoort code (e.g. 2025X000) or name (e.g. begroting, jaarrekening). Names are resolved via the Verslagsoort dimension."),
      dimension: z.enum(["Gemeenten", "TaakveldBalanspost", "Categorie", "Verslagsoort"]).optional().describe("Explore the values of a dimension instead of fetching data rows."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, tableId, gemeente, taakveldBalanspost, categorie, verslagsoort, dimension, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));

      if (dryRun) {
        return dryRunPayload({
          connector: "cbs_iv3",
          url: `https://dataderden.cbs.nl/ODataApi/OData/${tableId}/${dimension ?? "TypedDataSet"}`,
          params: { query, gemeente, taakveldBalanspost, categorie, verslagsoort, dimension, top: fetchRows },
        });
      }

      const started = Date.now();
      const out = await cbsIv3.search({ query, tableId, gemeente, taakveldBalanspost, categorie, verslagsoort, dimension, rows: fetchRows });
      const responseTimeMs = Date.now() - started;

      const records = out.items.map((x) => record("cbs.iv3", String(x.title ?? x.id ?? "gemeentefinancien"), String(x.url ?? "https://opendata.cbs.nl"), x as Record<string, unknown>));
      const response = buildFormattedResponse({
        summary: `${records.length} ${dimension ? "dimensiewaarden" : "financiele posten"}`,
        records,
        provenance: prov("cbs_iv3_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total),
        outputFormat,
        offset,
        limit: effectiveLimit,
        // dataderden OData levert hier geen betrouwbare totaal-count; null laat has_more op de records-heuristiek vallen.
        total: null,
        // Een volle pagina betekent hier vrijwel zeker meer rijen upstream.
        hasMore: out.hasMore,
        access_note: out.access_note,
        verbose: singleConnectorVerbose({ enabled: verbose, connector: "cbs_iv3", endpoint: out.endpoint, responseTimeMs }),
      });
      return toMcpToolPayload(response);
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "CBS Iv3", "https://opendata.cbs.nl")); }
  });

  server.registerTool("wetten_bwb_search", {
    description: "Search Dutch consolidated national legislation (BWB, wetten.overheid.nl) via KOOP SRU. Keywords are matched against the law title index (overheidbwb.titel). Returns one record per regeling: the version (toestand) geldig today, or on peildatum, with BWBR id, title, type, competent authority, that version's validity period (geldig_vanaf/geldig_tot) and a wetten.overheid.nl link. Regelingen without a version geldig that day (repealed, or not yet in force) are left out; find them with a peildatum inside their period. Pass title keywords only, not full sentences. For the text of a law or an artikel use wetten_bwb_tekst.",
    inputSchema: { query: z.string().max(SEARCH_QUERY_MAX).describe("Law/regulation title keywords, e.g. 'arbeid vreemdelingen', 'wegenverkeerswet', 'omgevingswet'. Matched against the BWB title index (overheidbwb.titel), not full text."), peildatum: oriDate.optional().describe("YYYY-MM-DD: the versions geldig on this day instead of today (Dutch local date); also finds regelingen repealed since."), top: z.number().int().min(1).max(config.limits.maxRows).default(20), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, peildatum, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) return dryRunPayload({ connector: "wetten_bwb", url: "https://zoekservice.overheid.nl/sru/Search", params: { "x-connection": "BWB", operation: "searchRetrieve", version: "1.2", query: bwbSearchCql(query, peildatum ?? todayAmsterdam()), maximumRecords: fetchRows } });
      const started = Date.now();
      const out = await wettenBwb.search({ query, maximumRecords: fetchRows, peildatum });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record("wetten-bwb", String(x.title ?? x.identifier ?? "BWB regeling"), String(x.canonical_url ?? "https://wetten.overheid.nl"), x as Record<string, unknown>, [x.type, x.authority, x.geldig_vanaf ? `versie geldig vanaf ${String(x.geldig_vanaf)}` : undefined].filter(Boolean).join(" · "), x.geldig_vanaf ? String(x.geldig_vanaf) : undefined));
      const response = buildFormattedResponse({ summary: pageSummary(records.length, offset, effectiveLimit, "BWB wetten"), records, provenance: prov("wetten_bwb_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total), outputFormat, offset, limit: effectiveLimit, total: out.total, access_note: out.access_note, verbose: singleConnectorVerbose({ enabled: verbose, connector: "wetten_bwb", endpoint: out.endpoint, responseTimeMs }) });
      return toMcpToolPayload(response);
    } catch (e) {
      if (e instanceof BwbTekstError) return toMcpToolPayload(errorResponse({ error: e.kind === "upstream" ? "malformed_response" : "unexpected", message: e.message, suggestion: e.suggestion, details: e.details }));
      return toMcpToolPayload(mapSourceError(e, "BWB wetgeving", "https://wetten.overheid.nl"));
    }
  });

  /** A regeling as wetten_bwb_tekst lists it among candidates. */
  const bwbCandidate = (r: BwbRegeling) =>
    record("wetten-bwb", r.title ?? r.identifier, bwbVersieUrl(r), { bwb_id: r.identifier, title: r.title, type: r.type, authority: r.authority, geldig_vanaf: r.geldig_vanaf, geldig_tot: r.geldig_tot, versie_url: bwbVersieUrl(r) }, [r.identifier, r.type, r.authority].filter(Boolean).join(" · "), r.geldig_vanaf);
  const BWB_STATUS: Record<string, string> = { goed: "geldend", vervallen: "vervallen", nogniet: "nog niet in werking" };

  /**
   * wetten_bwb_tekst as a result object; nl_gov_ask reads an artikel of a law
   * the question names through it as well.
   */
  async function wettenTekstResult({ bwb_id, wet, artikel, peildatum, zoekterm, max_chars }: { bwb_id?: string; wet?: string; artikel?: string; peildatum?: string; zoekterm?: string; max_chars: number }): Promise<ToolResult> {
    const searching = Boolean(zoekterm?.trim()) && !artikel?.trim();
    const asked: Record<string, string> = Object.fromEntries(
      Object.entries({ bwb_id, wet, artikel, peildatum, zoekterm: searching ? zoekterm : undefined, max_chars: String(max_chars) }).filter((kv): kv is [string, string] => typeof kv[1] === "string" && kv[1] !== ""),
    );
    try {
      const out = await wettenBwb.tekst({ bwb_id, wet, artikel, peildatum, zoekterm: searching ? zoekterm : undefined, max_chars });
      if (out.kind === "kandidaten") {
        const records = out.candidates.map(bwbCandidate);
        const shownOf = out.total > records.length ? ` (${records.length} van ${out.total} getoond)` : "";
        return successResponse({
          summary: out.basis === "titelwoorden"
            ? `'${out.wet}' is geen titel of afkorting; ${out.total} ${out.total === 1 ? "regeling heeft" : "regelingen hebben"} die woorden in de titel; kies met bwb_id`
            : `'${out.wet}' is niet eenduidig: ${out.total} regelingen${out.basis === "andere_data" ? `, geen geldt op ${out.peildatum}` : ""}; kies er een met bwb_id`,
          records,
          provenance: prov("wetten_bwb_tekst", out.endpoint, out.params, records.length, out.total),
          access_note: out.basis === "titelwoorden"
            ? `Geen tekst opgehaald: geen regeling heeft '${out.wet}' als titel of afkorting; wel staan die woorden in de titel van deze regelingen die gelden op ${out.peildatum}${shownOf}. Roep wetten_bwb_tekst opnieuw aan met het bwb_id van de bedoelde regeling, of zoek met wetten_bwb_search.`
            : out.basis === "andere_data"
            ? `Geen tekst opgehaald: '${out.wet}' is de afkorting van meer dan één regeling, en geen daarvan geldt op ${out.peildatum} (ingetrokken, of nog niet in werking); geldig_vanaf/geldig_tot is die van één versie. Roep wetten_bwb_tekst opnieuw aan met het bwb_id van de bedoelde regeling en een peildatum binnen haar looptijd.`
            : `Geen tekst opgehaald: '${out.wet}' past bij meer dan één regeling die geldt op ${out.peildatum}${shownOf}. Roep wetten_bwb_tekst opnieuw aan met het bwb_id van de bedoelde regeling.`,
        });
      }

      const { regeling, doc, selection: sel, peildatum: dag, vandaag } = out;
      const title = doc.citeertitel ?? regeling.title ?? regeling.identifier;
      const versieUrl = bwbVersieUrl(regeling);
      const regelingFields = {
        bwb_id: regeling.identifier,
        regeling: title,
        type: regeling.type,
        peildatum: dag,
        versie_geldig_vanaf: regeling.geldig_vanaf,
        versie_geldig_tot: regeling.geldig_tot,
        versie_url: versieUrl,
        xml_url: out.xmlUrl,
      };
      const params: Record<string, string> = { bwb_id: regeling.identifier, peildatum: dag, max_chars: String(max_chars), sru: out.sruEndpoint };
      if (wet) params.wet = wet;
      if (artikel) params.artikel = artikel;
      if (searching && zoekterm) params.zoekterm = zoekterm;

      if (sel.notFound) {
        // Not found is an answer, as in rechtspraak_uitspraak_get: no records, and why, with what there is.
        const suggestions = sel.notFound.suggestions;
        const existing = suggestions.length ? (suggestions.every((s) => /^Artikel /i.test(s)) ? ` Bestaande artikelen: ${suggestions.join(", ")}.` : ` Probeer: ${suggestions.join(", ")}.`) : "";
        return successResponse({
          summary: `Artikel '${artikel}' niet gevonden in ${title} (versie geldig vanaf ${regeling.geldig_vanaf ?? "onbekend"})`,
          records: [],
          provenance: prov("wetten_bwb_tekst", out.xmlUrl, { ...params, niet_gevonden: "artikel" }, 0, 0),
          access_note: `Geen tekst opgehaald: ${sel.notFound.reason}${existing} Roep de tool zonder artikel aan voor de inhoudsopgave, of zoek met zoekterm. Versie (toestand) van ${title} (${regeling.identifier}) die geldig is op ${dag}: geldig vanaf ${regeling.geldig_vanaf ?? "onbekend"}${regeling.geldig_tot ? ` t/m ${regeling.geldig_tot}` : ", zonder bekende einddatum"}; ${versieUrl}.`,
        });
      }

      const deepLink = (a: BwbArtikel) => (a.jci ? `https://wetten.overheid.nl/${a.jci}${vandaag ? "" : `&g=${dag}`}` : versieUrl);
      const artikelFields = (a: BwbArtikel) => ({
        artikel: a.label,
        ...(a.titel ? { titel: a.titel } : {}),
        ...(a.pad.length ? { pad: a.pad.join(" › ") } : {}),
        ...(a.bijlage ? { in_bijlage: true } : {}),
        status: a.status ? (BWB_STATUS[a.status] ?? a.status) : undefined,
        in_werking_sinds: a.inwerking,
        gewijzigd_bij: a.bron,
        gewijzigd_bij_url: a.bronUrl,
        url: deepLink(a),
      });

      const notes: string[] = [
        `Versie (toestand) van ${title} (${regeling.identifier}) die geldig is op ${dag}${vandaag ? " (vandaag)" : ""}: geldig vanaf ${regeling.geldig_vanaf ?? "onbekend"}${regeling.geldig_tot ? ` t/m ${regeling.geldig_tot}` : ", zonder bekende einddatum"}.`,
      ];
      if (out.resolved) notes.push(`Regeling bepaald uit wet: ${out.resolved}.`);
      if (dag > todayAmsterdam()) notes.push("Peildatum in de toekomst: deze versie bevat alleen wijzigingen die nu al vastgesteld zijn.");

      let records: MCPRecord[];
      let summary: string;
      if (sel.mode === "artikel" || sel.mode === "zoekterm") {
        records = sel.parts.map((p) => {
          const a = p.artikel as BwbArtikel;
          const label = `${a.label}${p.lid ? ` lid ${p.lid}` : ""}${p.onderdeel && !p.onderdeelNietGevonden ? ` onder ${p.onderdeel}` : ""}`;
          if (sel.mode === "zoekterm") {
            // Many hits: per artikel only what tells them apart; the regeling and its version are in access_note.
            return record(
              "wetten-bwb",
              `${label}${a.titel ? ` ${a.titel}` : ""}`,
              deepLink(a),
              {
                bwb_id: regeling.identifier,
                artikel: a.label,
                ...(a.titel ? { titel: a.titel } : {}),
                ...(a.status && a.status !== "goed" ? { status: BWB_STATUS[a.status] ?? a.status } : {}),
                ...(p.ingekort ? { ingekort: true, tekens_volledig: p.tekensVolledig } : {}),
                tekst: p.tekst,
              },
              undefined,
              a.inwerking,
            );
          }
          return record(
            "wetten-bwb",
            `${label}${a.titel ? ` ${a.titel}` : ""} — ${title}`,
            deepLink(a),
            {
              ...regelingFields,
              ...artikelFields(a),
              ...(p.lid ? { lid: p.lid } : {}),
              ...(p.onderdeel ? { onderdeel: p.onderdeel } : {}),
              ...(p.ingekort ? { ingekort: true, tekens_volledig: p.tekensVolledig } : {}),
              tekst: p.tekst,
            },
            p.tekst.slice(0, 300),
            a.inwerking,
          );
        });
        const shown = sel.parts.length;
        if (sel.mode === "artikel") {
          const first = sel.parts[0]?.artikel;
          const part = sel.parts[0];
          if (part?.onderdeel) {
            notes.push(part.onderdeelNietGevonden
              ? `Onderdeel ${part.onderdeel} niet gevonden als genummerd onderdeel van ${first?.label ?? artikel}${part.lid ? ` lid ${part.lid}` : ""}: ${part.lid ? "het hele lid" : "het hele artikel"} is getoond.`
              : `Getoond: de aanhef en onderdeel ${part.onderdeel} van ${first?.label ?? artikel}${part.lid ? ` lid ${part.lid}` : ""}.`);
          }
          summary = `${first?.label ?? artikel}${part?.lid ? ` lid ${part.lid}` : ""}${part?.onderdeel && !part.onderdeelNietGevonden ? ` onder ${part.onderdeel}` : ""} ${title} (versie geldig vanaf ${regeling.geldig_vanaf ?? "onbekend"})${first?.status && first.status !== "goed" ? ` — ${BWB_STATUS[first.status] ?? first.status}` : ""}`;
          if ((sel.matches ?? 0) > 1) notes.push(`'${artikel}' komt ${sel.matches} keer voor in deze regeling (ook in een bijlage); ${shown === sel.matches ? "alle getoond" : `${shown} getoond`}.`);
          for (const p of sel.parts) {
            const a = p.artikel as BwbArtikel;
            if (a.status === "vervallen") notes.push(`${a.label} is vervallen${a.inwerking ? ` sinds ${a.inwerking}` : ""}${a.bron ? ` (${a.bron})` : ""}: de tekst zegt alleen dat het vervallen is.${a.inwerking ? ` De tekst van daarvoor: peildatum vóór ${a.inwerking}.` : ""}`);
            if (a.status === "nogniet") notes.push(`${a.label} is nog niet in werking getreden: de tekst staat al in de geconsolideerde versie, maar geldt (nog) niet.`);
            if (p.ingekort) notes.push(`${a.label} afgekapt op ${p.tekst.length} van ${p.tekensVolledig} tekens; vraag een lid op ('${a.label} lid 1') of verhoog max_chars (max ${BWB_TEXT_MAX_CHARS}).`);
          }
        } else {
          const matches = sel.matches ?? 0;
          summary = matches
            ? `${matches} ${matches === 1 ? "artikel" : "artikelen"} met '${zoekterm}' in ${title}${shown < matches ? ` (${shown} getoond)` : ""}`
            : `Geen artikelen met '${zoekterm}' in ${title}`;
          if (!matches) notes.push(`Geen artikel bevat alle woorden van '${zoekterm}'. Probeer een kortere of andere zoekterm, of vraag de inhoudsopgave op (zonder zoekterm).`);
          const shortened = sel.parts.filter((p) => p.ingekort).map((p) => (p.artikel as BwbArtikel).label);
          if (shortened.length) notes.push(`Ingekort wegens max_chars (${max_chars}): ${shortened.join(", ")}; tekst geeft de kop en de regels met de zoekterm (ingekort: true). Vraag het hele artikel op met artikel.`);
          if (sel.omitted?.length) notes.push(`Niet getoond wegens max_chars (${max_chars}): ${sel.omitted.slice(0, 30).join(", ")}${sel.omitted.length > 30 ? ` en ${sel.omitted.length - 30} meer` : ""}. Vraag ze op met artikel, of verhoog max_chars (max ${BWB_TEXT_MAX_CHARS}).`);
          notes.push("Zoekterm: alle woorden moeten in het artikel (met kop) voorkomen; hoofdletters en accenten tellen niet, een woord matcht ook binnen langere woorden.");
        }
      } else {
        const tekst = sel.parts[0]?.tekst ?? "";
        const vervallen = doc.artikelen.filter((a) => a.status === "vervallen").length;
        records = [record(
          "wetten-bwb",
          title,
          versieUrl,
          {
            ...regelingFields,
            authority: regeling.authority,
            artikelen: doc.artikelen.length,
            ...(vervallen ? { artikelen_vervallen: vervallen } : {}),
            ...(sel.inhoudsopgave !== undefined ? { inhoudsopgave: sel.inhoudsopgave } : {}),
            tekst,
            tekens_regeling: sel.totalChars,
            afgekapt: sel.truncated,
          },
          tekst.slice(0, 300),
          regeling.geldig_vanaf,
        )];
        summary = sel.mode === "volledig" ? `Tekst ${title} (${sel.totalChars} tekens)` : `Begin van ${title} met inhoudsopgave (${sel.totalChars} tekens in totaal)`;
        if (sel.mode === "begin_met_inhoudsopgave") {
          notes.push(`De regeling is ${sel.totalChars} tekens; getoond: de inhoudsopgave${sel.inhoudsopgaveVolledig ? "" : sel.inhoudsopgaveNiveaus ? ` (alleen ${sel.inhoudsopgaveNiveaus === 1 ? "het bovenste niveau" : `de bovenste ${sel.inhoudsopgaveNiveaus} niveaus`} koppen${sel.inhoudsopgaveAfgekapt ? ", afgekapt" : ""})` : " (afgekapt)"} en de eerste ${tekst.length} tekens van de tekst. Vraag een artikel op met artikel, of zoek met zoekterm.`);
        }
      }
      notes.push(`Bron: geconsolideerde tekst uit de BWB (KOOP); XML van deze versie: ${out.xmlUrl}. Alleen de publicatie in Staatsblad of Staatscourant is authentiek.`);

      return successResponse({
        summary,
        records,
        provenance: prov("wetten_bwb_tekst", out.xmlUrl, params, records.length, sel.mode === "zoekterm" ? (sel.matches ?? 0) : records.length),
        access_note: notes.join(" "),
      });
    } catch (e) {
      if (!(e instanceof BwbTekstError)) return mapSourceError(e, "BWB wetgeving", "https://wetten.overheid.nl");
      if (e.kind === "input") return errorResponse({ error: "unexpected", message: e.message, suggestion: e.suggestion, details: e.details });
      if (e.kind === "upstream") return errorResponse({ error: "malformed_response", message: e.message, suggestion: e.suggestion, details: e.details });
      // An unknown regeling, or none geldig on the peildatum: an answer without records, as in
      // rechtspraak_uitspraak_get and wodc_document_get. niet_gevonden says what was not found:
      // 'wet' (no regeling has that name), 'bwb_id' (no regeling has that id) or 'versie'
      // (the regeling exists, but has no version geldig on the peildatum).
      const knownId = typeof e.details?.bwb_id === "string" ? e.details.bwb_id : undefined;
      const nietGevonden = knownId ? (e.kind === "no_version" ? "versie" : "bwb_id") : "wet";
      return successResponse({
        summary: e.message,
        records: [],
        provenance: prov("wetten_bwb_tekst", BWB_SRU_ENDPOINT, { ...asked, ...(knownId ? { bwb_id: knownId } : {}), niet_gevonden: nietGevonden }, 0, 0),
        access_note: `Geen tekst opgehaald: ${e.message} ${e.suggestion}`,
      });
    }
  }

  server.registerTool("wetten_bwb_tekst", {
    description:
      "Read the text of a Dutch national law or regulation (BWB, wetten.overheid.nl) as geldig on a day: one artikel (or lid), the artikelen containing a zoekterm, or the table of contents with the beginning of the text. Name it by bwb_id (from wetten_bwb_search) or wet (title or official afkorting: 'Awb', 'Sr', 'Gemeentewet', 'BW boek 6'); an ambiguous wet ('Ow'), or one that only matches words of titles, returns candidates, never a guess. " +
      "peildatum (default today) picks the version (toestand) geldig that day. Each artikel comes with its status (geldend, vervallen, nog niet in werking), the date its text took effect, the publication that last changed it and a wetten.overheid.nl deep link. " +
      "An unknown law or id, a day without a geldige version, or a missing artikel returns no records and says so in access_note, with suggestions (provenance.query_params.niet_gevonden: wet, bwb_id, versie or artikel); shortened text is always marked. The text is the consolidated text from the KOOP BWB repository, not the authentic Staatsblad publication.",
    inputSchema: {
      bwb_id: z.string().max(20).optional().describe("BWB id, e.g. 'BWBR0005537' (Awb), 'BWBR0037885' (Omgevingswet), 'BWBR0005289' (BW Boek 6). Give this or wet."),
      wet: z.string().max(200).optional().describe("Title or official afkorting, e.g. 'Awb', 'Algemene wet bestuursrecht', 'Sr', 'Gemeentewet', 'Woo', 'BW boek 6'."),
      artikel: z.string().max(100).optional().describe("Artikel label: '3:4', 'art. 3:4', 'Artikel 2.1', '162', optionally with a lid ('3:4 lid 2') and onderdeel ('6:162 lid 2 sub b'); a BW book also takes '6:162'. Case and spaces are ignored, punctuation is not: '3.4' never matches '3:4' (the error names the existing one)."),
      peildatum: oriDate.optional().describe("YYYY-MM-DD: the version geldig on this day instead of today (Dutch local date)."),
      zoekterm: z.string().max(200).optional().describe("Words that must all occur in an artikel, case and accents ignored; a word also matches inside longer words. Ignored when artikel is given."),
      max_chars: z.number().int().min(500).max(BWB_TEXT_MAX_CHARS).default(BWB_TEXT_DEFAULT_CHARS).describe(`Maximum characters of text returned (default ${BWB_TEXT_DEFAULT_CHARS}, max ${BWB_TEXT_MAX_CHARS}).`),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async (args) => toMcpToolPayload(await wettenTekstResult(args)));

  server.registerTool("cvdr_search", {
    description: "Search Dutch decentralised/local regulations (CVDR: municipal, provincial and water-authority bylaws) via KOOP SRU. All query words must occur (AND) somewhere in a regulation's title or text (uppercase OR and NOT between words work as operators), so a place name in the query also finds other authorities' regulations that merely mention that place: use 'organization' (and/or 'organization_type') to restrict to the issuing body. Returns CVDR id, title, issuer (organization, organization_type; the older 'gemeente' field holds the same issuer, which may also be a province or water authority), date and a lokaleregelgeving.overheid.nl link. offset/limit page server-side through the whole result set; total is the real hit count. Pass topic keywords only.",
    inputSchema: {
      query: z.string().describe("Local-regulation topic keywords, e.g. 'hondenbelasting', 'parkeerverordening', 'afvalstoffenheffing'. Every word must match (AND), in title or text; uppercase OR and NOT between words are operators ('parkeren OR fietsen', 'subsidie NOT sport'; AND binds tighter than OR). May be empty when 'organization' or 'organization_type' is set."),
      organization: z.string().optional().describe("Issuing organisation as CVDR names it, e.g. 'Harderwijk', 'Gooise Meren', 'Waterschap Rivierenland', 'Utrecht'. Matches whole words of the issuer name, case-insensitive, no wildcards; 'Utrecht' matches both the municipality and the province, so add organization_type to narrow. A leading 'Gemeente'/'Provincie' is turned into organization_type; 'Den Haag' and 'Den Bosch' also match their official names ('s-Gravenhage, 's-Hertogenbosch)."),
      organization_type: z.enum(CVDR_ORGANIZATION_TYPES).optional().describe("Issuer type (CVDR organisatieType), e.g. 'Gemeente', 'Provincie', 'Waterschap', 'RegionaalSamenwerkingsorgaan'."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, organization, organization_type, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      // offset maps onto the 1-based SRU startRecord, so every page of the result set
      // is reachable instead of only the first maxRows records fetched from record 1.
      const searchArgs = { query, organization, organization_type, maximumRecords: effectiveLimit, startRecord: offset + 1 };
      if (dryRun) return dryRunPayload({ connector: "cvdr", url: "https://zoekservice.overheid.nl/sru/Search", params: cvdr.requestParams(searchArgs) });
      const started = Date.now();
      const out = await cvdr.search(searchArgs);
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record("cvdr", String(x.title ?? x.identifier ?? "CVDR regeling"), String(x.canonical_url ?? "https://lokaleregelgeving.overheid.nl"), x as Record<string, unknown>, String(x.organization ?? x.gemeente ?? ""), String(x.date ?? "")));
      // The records already are the requested page (cut upstream), so they are formatted
      // from position 0 and the pagination is then reported against the caller's offset.
      const response = buildFormattedResponse({ summary: `${records.length} CVDR regelingen`, records, provenance: prov("cvdr_search", out.endpoint, out.params, records.length, out.total), outputFormat, offset: 0, limit: effectiveLimit, total: out.total, access_note: out.access_note, verbose: singleConnectorVerbose({ enabled: verbose, connector: "cvdr", endpoint: out.endpoint, responseTimeMs }) });
      response.pagination = { offset, limit: effectiveLimit, total: out.total, has_more: offset + records.length < out.total };
      return toMcpToolPayload(response);
    } catch (e) {
      const mapped = mapSourceError(e, "CVDR lokale regelgeving", "https://lokaleregelgeving.overheid.nl");
      // CVDR refused the query itself: retrying the same call cannot help.
      if (e instanceof CvdrQueryError) {
        mapped.suggestion = e.suggestion;
        mapped.details = { ...mapped.details, sru_diagnostic: e.diagnostic };
      }
      return toMcpToolPayload(mapped);
    }
  });

  const celexSuggestion = "Use a CELEX number (32016R0679) or an EU citation ('Verordening (EU) 2016/679', 'Richtlijn (EU) 2016/680', 'Richtlijn 95/46/EG').";
  const toEuRecord = (x: Record<string, unknown>) => record("eu-cellar", String(x.title ?? x.celex ?? "EU-handeling"), String(x.eurlex_url ?? "https://eur-lex.europa.eu"), x, String(x.document_type_label ?? ""), String(x.date ?? ""));

  server.registerTool("eurlex_search", {
    description: "Search EU legislation (EUR-Lex/CELLAR) by keywords in the Dutch title, or by document number. Returns CELEX, Dutch title, type, date, in-force status, EUR-Lex link and match ('title', 'title_partial' or 'document_number'). Up to six words of at least two characters are combined with AND ('5G' works; stopwords and 'EU'/'EG'/'nr' are ignored). Two-letter words are often abbreviations a title spells out, so when the AND with them finds fewer than top acts, titles matching the other words follow as match 'title_partial'. A query that is only a document number ('2016/679', 'Verordening (EU) 2016/679', 'Richtlijn 95/46/EG') returns that act first, then acts whose title cites exactly that number. Regulations before 2015 are read number/year ('Verordening (EG) 1998/2006' is 32006R1998); a number that fits both styles ('2018/1999') returns both acts unless '(EU)' or '(EG) nr.' says which. Titles use official EU terminology (e.g. 'artificiële intelligentie', not 'kunstmatige intelligentie'): if results are few or irrelevant, search again with official or alternative terms, or with fewer words.",
    inputSchema: { query: z.string().describe("Dutch title keywords, e.g. 'artificiële intelligentie', '5G', 'gegevensbescherming' (matched against titles only), or a document number such as '2016/679'."), type: z.enum(["REG", "DIR", "DEC"]).optional().describe("REG=regulation, DIR=directive, DEC=decision."), top: z.number().int().min(1).max(config.limits.maxRows).default(20), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, type, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) return dryRunPayload({ connector: "eu_cellar", url: "https://publications.europa.eu/webapi/rdf/sparql", params: { query, type, limit: fetchRows } });
      const started = Date.now();
      const out = await euCellar.search({ query, type, limit: fetchRows });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map(toEuRecord);
      const response = buildFormattedResponse({ summary: `${records.length} EU-handelingen`, records, provenance: prov("eurlex_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total), outputFormat, offset, limit: effectiveLimit, total: out.total, access_note: out.access_note, verbose: singleConnectorVerbose({ enabled: verbose, connector: "eu_cellar", endpoint: out.endpoint, responseTimeMs }) });
      return toMcpToolPayload(response);
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "EUR-Lex/CELLAR", "https://eur-lex.europa.eu")); }
  });

  server.registerTool("eurlex_document", {
    description: "Fetch metadata of one EU legal act (EUR-Lex/CELLAR) by CELEX number or citation: Dutch title, type, date, in-force status, ELI and EUR-Lex link, plus the newest CJEU rulings interpreting it (hvj_arresten, hvj_arresten_total), the newest acts amending it with CELEX and date (amended_by, up to 20; amended_by_total; corrigenda are not counted) and the acts repealing it (repealed_by).",
    inputSchema: { id: z.string().describe("CELEX (32016R0679) or citation ('Richtlijn (EU) 2016/680')."), outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ id, outputFormat, verbose, dryRun }) => {
    const celex = normalizeCelex(id);
    if (!celex) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Ongeldig CELEX-nummer of EU-citaat: ${id.slice(0, 100)}`, suggestion: celexSuggestion }));
    try {
      if (dryRun) return dryRunPayload({ connector: "eu_cellar", url: "https://publications.europa.eu/webapi/rdf/sparql", params: { celex } });
      const started = Date.now();
      const out = await euCellar.document({ id: celex });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map(toEuRecord);
      const response = buildFormattedResponse({ summary: `${records.length} EU-handeling ${celex}`, records, provenance: prov("eurlex_document", out.endpoint, out.params, records.length, out.total), outputFormat, offset: 0, limit: Math.max(1, records.length), total: out.total, access_note: out.access_note, verbose: singleConnectorVerbose({ enabled: verbose, connector: "eu_cellar", endpoint: out.endpoint, responseTimeMs }) });
      return toMcpToolPayload(response);
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "EUR-Lex/CELLAR", "https://eur-lex.europa.eu")); }
  });

  server.registerTool("eurlex_nl_omzetting", {
    description: "List Dutch national transposition measures (act/decree with Staatsblad/Staatscourant reference) for an EU directive, via CELLAR.",
    inputSchema: { id: z.string().describe("Directive CELEX (32016L0680) or citation ('Richtlijn (EU) 2016/680')."), top: z.number().int().min(1).max(config.limits.maxRows).default(20), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ id, top, offset, limit, outputFormat, verbose, dryRun }) => {
    const celex = normalizeCelex(id);
    if (!celex) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Ongeldig CELEX-nummer of EU-citaat: ${id.slice(0, 100)}`, suggestion: celexSuggestion }));
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) return dryRunPayload({ connector: "eu_cellar", url: "https://publications.europa.eu/webapi/rdf/sparql", params: { celex, limit: fetchRows } });
      const started = Date.now();
      const out = await euCellar.nlTransposition({ id: celex, limit: fetchRows });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record("eu-cellar", String(x.title ?? x.identifier ?? "Omzettingsmaatregel"), String(x.canonical_url ?? `https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=CELEX:${celex}`), x, [x.measure_type, x.official_journal].filter(Boolean).join(" — "), String(x.publication_date ?? "")));
      const response = buildFormattedResponse({ summary: `${records.length} NL-omzettingsmaatregelen bij ${celex}`, records, provenance: prov("eurlex_nl_omzetting", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total), outputFormat, offset, limit: effectiveLimit, total: out.total, access_note: out.access_note, verbose: singleConnectorVerbose({ enabled: verbose, connector: "eu_cellar", endpoint: out.endpoint, responseTimeMs }) });
      return toMcpToolPayload(response);
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "EUR-Lex/CELLAR", "https://eur-lex.europa.eu")); }
  });

  server.registerTool("lido_verwijzingen", {
    description: "Count references per document type in LiDO (Linked Data Overheid) to a ruling (ECLI), law article (BWBR + artikel), EU act (CELEX) or Staatsblad/Staatscourant publication; includes a portal link to the list. The list itself (titles, direction, URLs) is available via lido_verwijzingen_lijst.",
    inputSchema: { id: z.string().describe("ECLI:NL:HR:2019:2006, BWBR0011823, 32016L0680 or stb-2018-401."), artikel: z.string().optional().describe("Article number, only with a BWBR id, e.g. '7:658'."), outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ id, artikel, outputFormat, verbose, dryRun }) => {
    const parsed = parseLidoId(id);
    if (!parsed) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Onbekend LiDO-identifier: ${id.slice(0, 100)}`, suggestion: "Use an ECLI (ECLI:NL:HR:2019:2006), BWB id (BWBR0011823, optionally with artikel), CELEX (32016L0680) or OEP publication (stb-2018-401)." }));
    try {
      if (dryRun) return dryRunPayload({ connector: "lido", url: "https://linkeddata.overheid.nl/service/get-aantal-per-informatietype", params: { kind: parsed.kind, id: parsed.value, artikel } });
      const started = Date.now();
      const out = await lido.references({ id, artikel });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => {
        const perType = Array.isArray(x.per_type) ? (x.per_type as Array<{ type: string; count: number }>) : [];
        const snippet = perType.slice(0, 5).map((p) => `${p.type}: ${p.count}`).join(", ");
        return record("lido", String(x.title ?? `LiDO-verwijzingen naar ${id}`), String(x.portal_url ?? "https://linkeddata.overheid.nl"), x, `${String(x.total_references ?? "?")} verwijzingen${snippet ? ` (${snippet})` : ""}`);
      });
      const response = buildFormattedResponse({ summary: `LiDO-verwijzingen naar ${parsed.value}${artikel ? ` art. ${artikel}` : ""}`, records, provenance: prov("lido_verwijzingen", out.endpoint, out.params, records.length, out.total), outputFormat, offset: 0, limit: Math.max(1, records.length), total: out.total, access_note: out.access_note, verbose: singleConnectorVerbose({ enabled: verbose, connector: "lido", endpoint: out.endpoint, responseTimeMs }) });
      return toMcpToolPayload(response);
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "LiDO Linked Data Overheid", "https://linkeddata.overheid.nl")); }
  });

  server.registerTool("lido_verwijzingen_lijst", {
    description: "List the documents LiDO (Linked Data Overheid) links to or from a ruling (ECLI), law article (BWBR + artikel), EU act (CELEX) or Staatsblad/Staatscourant publication: title, document type, direction (uitgaand = the item cites it, inkomend = it cites the item, beide = both), link labels and source URL. Paged upstream with offset/limit (at most 100 per call); total and offset count references (links), and a document linked more than once is listed once per page. Optional 'type' filter on the LiDO document type. Use lido_verwijzingen for counts only.",
    inputSchema: { id: z.string().describe("ECLI:NL:HR:2019:2006, BWBR0011823, 32016L0680 or stb-2018-401."), artikel: z.string().optional().describe("Article number, only with a BWBR id, e.g. '7:658'."), type: z.string().optional().describe("Optional LiDO document type to filter on, e.g. 'Jurisprudentie', 'Wet', 'Verdrag', 'Amvb', 'Ministeriële-regeling', 'Officiele overheidspublicatie'. Letters, digits, spaces and hyphens only."), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ id, artikel, type, offset, limit, outputFormat, verbose, dryRun }) => {
    const parsed = parseLidoId(id);
    if (!parsed) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Onbekend LiDO-identifier: ${id.slice(0, 100)}`, suggestion: "Use an ECLI (ECLI:NL:HR:2019:2006), BWB id (BWBR0011823, optionally with artikel), CELEX (32016L0680) or OEP publication (stb-2018-401)." }));
    try {
      // LiDO pagineert zelf (start = 0-based offset, rows <= 100): records worden
      // hier niet nog eens lokaal gesliced, vandaar geen buildFormattedResponse.
      const rows = clampLidoRows(limit);
      const typeFilter = normalizeLidoType(type);
      if (dryRun) return dryRunPayload({ connector: "lido", url: "https://linkeddata.overheid.nl/service/get-links", params: { kind: parsed.kind, id: parsed.value, artikel, type: typeFilter ?? undefined, output: "xml", start: offset, rows } });
      const started = Date.now();
      const out = await lido.links({ id, artikel, type: typeFilter ?? undefined, offset, limit: rows });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => {
        const labels = Array.isArray(x.link_labels) ? (x.link_labels as string[]) : [];
        const snippet = [x.direction, x.type, labels.join(", ")].filter((s) => typeof s === "string" && s).join(" — ");
        return record("lido", String(x.title ?? x.external_id ?? x.lido_id ?? "LiDO-item"), String(x.url ?? out.portal_url ?? "https://linkeddata.overheid.nl"), x, snippet);
      });
      const label = `${parsed.value}${artikel?.trim() ? ` art. ${artikel.trim()}` : ""}`;
      const typeText = out.type_filter ? ` (type ${out.type_filter})` : "";
      let summary: string;
      if (!out.lido_id) {
        summary = `LiDO kent ${label} niet; geen gekoppelde documenten.`;
      } else {
        // offset/total tellen LiDO-verwijzingen; records bevat elk document één keer.
        const range = out.page_entries
          ? `getoond ${out.offset + 1}-${out.offset + out.page_entries}${records.length < out.page_entries ? `, ${records.length} unieke documenten` : ""}`
          : `geen verwijzingen vanaf offset ${out.offset}`;
        const split = out.per_type.map((p) => `${p.type}: ${p.count}`).join(", ");
        summary = `${out.total ?? "?"} verwijzingen${typeText} van/naar ${label} (${range})${split ? `; per type: ${split}` : ""}`;
        if (out.type_filter && out.total === 0) summary += `. Geen treffers voor type '${out.type_filter}': het type is hoofdlettergevoelig, lido_verwijzingen toont welke typen voorkomen.`;
      }
      const formatted = applyOutputFormat({ records, outputFormat });
      return toMcpToolPayload(successResponse({
        summary,
        records,
        provenance: prov("lido_verwijzingen_lijst", out.endpoint, out.params, records.length, out.total),
        pagination: {
          offset: out.offset,
          limit: out.limit,
          total: out.total,
          has_more: typeof out.total === "number" ? out.offset + out.page_entries < out.total : out.page_entries >= out.limit,
        },
        output_format: formatted.output_format,
        formatted_output: formatted.formatted_output,
        access_note: mergeAccessNotes(out.access_note, out.portal_url ? `portal_url: ${out.portal_url}` : undefined, formatted.access_note),
        verbose: singleConnectorVerbose({ enabled: verbose, connector: "lido", endpoint: out.endpoint, responseTimeMs }),
      }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "LiDO Linked Data Overheid", "https://linkeddata.overheid.nl")); }
  });

  server.registerTool("bestuurlijke_gebieden_search", {
    description: "Search Dutch administrative areas (gemeente/provincie/land) via PDOK Bestuurlijke Gebieden OGC API Features. Filter by exact naam, code, or RD (EPSG:28992) bbox. Returns naam, code, identificatie, parent province/country, bbox/centroid and optional GeoJSON geometry.",
    inputSchema: {
      niveau: z.enum(["gemeente", "provincie", "land"]).default("gemeente").describe("Administrative level: gemeente (municipality), provincie (province) or land (country)."),
      naam: z.string().optional().describe("Exact area name (case-sensitive), e.g. 'Utrecht'. Filters on the naam property (exact match)."),
      code: z.string().optional().describe("Exact area code, e.g. '0344' for a gemeente or '26' for a provincie."),
      bbox: z.string().optional().describe("Optional RD New (EPSG:28992) bounding box 'minx,miny,maxx,maxy'."),
      includeGeometry: z.boolean().default(false).describe("Include full GeoJSON geometry (large for gemeente/provincie polygons). Needed for outputFormat=geojson."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ niveau, naam, code, bbox, includeGeometry, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) {
        return dryRunPayload({ connector: "bestuurlijke_gebieden", url: "https://api.pdok.nl/kadaster/bestuurlijkegebieden/ogc/v1", params: { niveau, naam, code, bbox, limit: fetchRows } });
      }
      const started = Date.now();
      const out = await bestuurlijkeGebieden.search({ niveau, naam, code, bbox, includeGeometry, rows: fetchRows });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record(
        "bestuurlijke_gebieden",
        x.title,
        x.url,
        { id: x.id, niveau: x.niveau, naam: x.naam, code: x.code, identificatie: x.identificatie, ligt_in_provincie_naam: x.ligtInProvincieNaam, ligt_in_provincie_code: x.ligtInProvincieCode, ligt_in_land_naam: x.ligtInLandNaam, ligt_in_land_code: x.ligtInLandCode, bbox: x.bbox, centroid: x.centroid, ...(x.geometry ? { geometry: x.geometry } : {}) },
        `${x.niveau} — code ${x.code}`.trim(),
      ));
      const response = buildFormattedResponse({
        summary: `${records.length} bestuurlijke gebieden`,
        records,
        provenance: prov("bestuurlijke_gebieden_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total),
        outputFormat,
        offset,
        limit: effectiveLimit,
        total: out.total,
        access_note: out.access_note,
        verbose: singleConnectorVerbose({ enabled: verbose, connector: "bestuurlijke_gebieden", endpoint: out.endpoint, responseTimeMs }),
      });
      return toMcpToolPayload(response);
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "PDOK Bestuurlijke Gebieden", "https://api.pdok.nl/kadaster/bestuurlijkegebieden/ogc/v1"));
    }
  });

  server.registerTool("brk_kadastrale_kaart_search", {
    description: "Search Dutch cadastral parcels and map objects (BRK Kadastrale Kaart) via PDOK OGC API Features. bbox-driven (EPSG:28992). Collections: perceel, kadastralegrens, openbareruimtenaam, bebouwing, nummeraanduidingreeks. Returns kadastrale aanduiding (gemeente/sectie/perceelnummer), grootte, bbox/centroid and optional GeoJSON geometry.",
    inputSchema: {
      collectie: z.enum(["perceel", "kadastralegrens", "openbareruimtenaam", "bebouwing", "nummeraanduidingreeks"]).default("perceel").describe("BRK collection to query."),
      bbox: z.string().describe("Required RD New (EPSG:28992) bounding box 'minx,miny,maxx,maxy'. Keep it small; this API is bbox-driven."),
      includeGeometry: z.boolean().default(false).describe("Include full GeoJSON geometry. Needed for outputFormat=geojson."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(50),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ collectie, bbox, includeGeometry, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) {
        return dryRunPayload({ connector: "brk_kadastrale_kaart", url: "https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1", params: { collectie, bbox, limit: fetchRows } });
      }
      const started = Date.now();
      const out = await brkKadastraleKaart.search({ collectie, bbox, includeGeometry, rows: fetchRows });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record(
        "brk_kadastrale_kaart",
        x.title,
        x.url,
        { id: x.id, collectie: x.collectie, kadastrale_aanduiding: x.kadastraleAanduiding, kadastrale_gemeente: x.kadastraleGemeente, sectie: x.sectie, perceelnummer: x.perceelnummer, kadastrale_grootte_m2: x.kadastraleGrootteM2, tekst: x.tekst, bronhouder: x.bronhouder, bbox: x.bbox, centroid: x.centroid, ...(x.geometry ? { geometry: x.geometry } : {}) },
        x.kadastraleAanduiding ?? x.collectie,
      ));
      const response = buildFormattedResponse({
        summary: `${records.length} BRK objecten`,
        records,
        provenance: prov("brk_kadastrale_kaart_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total),
        outputFormat,
        offset,
        limit: effectiveLimit,
        total: out.total,
        // PDOK omits numberMatched, so "is there more" comes from the next link.
        hasMore: out.hasMore,
        access_note: out.access_note,
        verbose: singleConnectorVerbose({ enabled: verbose, connector: "brk_kadastrale_kaart", endpoint: out.endpoint, responseTimeMs }),
      });
      return toMcpToolPayload(response);
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "PDOK BRK Kadastrale Kaart", "https://api.pdok.nl/kadaster/brk-kadastrale-kaart/ogc/v1"));
    }
  });

  server.registerTool("bron_ongevallen_search", {
    inputSchema: {
      bbox: z.string().optional().describe("RD New (EPSG:28992) bounding box 'minx,miny,maxx,maxy'. REQUIRED — searching the full dataset is not allowed. Example: '190000,442000,195000,445000'."),
      jaar: z.enum(["2022", "2023", "2024", "2022_2024"]).optional().default("2024").describe("Accident year table. '2022_2024' is the combined three-year set."),
      afloop: z.enum(["letsel", "dodelijk", "ums", "all"]).optional().default("all").describe("Severity filter: letsel (injury), dodelijk (fatal), ums (material damage only), all."),
      gemeente: z.string().optional().describe("Optional municipality substring filter on the gemeente field."),
      query: z.string().optional().describe("Optional substring filter on street/place/municipality (straatnaam/woonplaats/gemeente). Do NOT pass full questions."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    description: "Search Dutch road traffic accidents (Rijkswaterstaat BRON, verkeersongevallen) via WFS GetFeature within an EPSG:28992 bbox. Returns severity (afloop), crash type (aard), involved vehicle types, location and RD coordinates as GeoJSON-capable records. Keywords: verkeersongeval, ongeval, letsel, dodelijk, aanrijding.",
    annotations: TOOL_ANNOTATIONS,
  }, async ({ bbox, jaar, afloop, gemeente, query, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) return dryRunPayload({ connector: "bron_ongevallen", url: "https://geo.rijkswaterstaat.nl/services/ogc/gdr/verkeersongevallen_nederland/ows", params: { bbox: bbox ?? "", jaar: jaar ?? "2024", afloop: afloop ?? "all", count: fetchRows } });
      const started = Date.now();
      const out = await bronOngevallen.search({ bbox, jaar: jaar ?? "2024", afloop: afloop ?? "all", gemeente, query, rows: fetchRows });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record(
        "bron_ongevallen",
        x.title,
        x.url,
        { id: x.id, jaar: x.jaar, afloop: x.afloop, aardOngeval: x.aardOngeval, aantalPartijen: x.aantalPartijen, vervoerswijzen: x.vervoerswijzen, straatnaam: x.straatnaam, woonplaats: x.woonplaats, gemeente: x.gemeente, provincie: x.provincie, maximumSnelheid: x.maximumSnelheid, rd: x.rd },
        `${x.afloop} — ${x.aardOngeval} — ${x.gemeente}`.trim(),
        String(x.jaar ?? ""),
      ));
      const response = buildFormattedResponse({
        summary: `${records.length} verkeersongevallen`,
        records,
        provenance: prov("bron_ongevallen_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total),
        outputFormat,
        offset,
        limit: effectiveLimit,
        total: out.total,
        access_note: out.access_note,
        verbose: singleConnectorVerbose({ enabled: verbose, connector: "bron_ongevallen", endpoint: out.endpoint, responseTimeMs }),
      });
      return toMcpToolPayload(response);
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "BRON Verkeersongevallen (Rijkswaterstaat WFS)", "https://geo.rijkswaterstaat.nl/services/ogc/gdr/verkeersongevallen_nederland/ows"));
    }
  });

  server.registerTool("nza_zorgbeeld_search", {
    description: "Search current NZa Zorgbeeld waiting times for Dutch hospital / medical-specialist (MSZ) care. Filter by keywords (care provider, location, specialism, treatment, city), KVK number, and treatment type. Returns care provider, specialism, waiting time in days and reference date (peildatum).",
    inputSchema: {
      query: z.string().optional().describe("Optional keywords, substring-matched on care provider, location, specialism, treatment or city. Examples: 'orthopedie', 'Radboudumc', 'staaroperatie'. Do NOT pass full questions."),
      kvk: z.string().optional().describe("Optional KVK number of the care provider to narrow server-side (digits only). Example: '41055629'."),
      treatmentType: z.enum(["Behandeling", "Polikliniekbezoek", "Diagnostiek"]).optional().describe("Optional treatment type filter."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, kvk, treatmentType, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) return dryRunPayload({ connector: "nza_zorgbeeld", url: "https://zorgbeeld.nza.nl/openapi/WaitingTimeMSZ", params: { ...(kvk ? { KVKNummer: kvk } : {}), ...(query ? { q: query } : {}), ...(treatmentType ? { treatmentType } : {}), rows: fetchRows } });
      const started = Date.now();
      const out = await nzaZorgbeeld.search({ query, kvk, treatmentType, rows: fetchRows });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record("nza_zorgbeeld", String(x.title), String(x.url), x as unknown as Record<string, unknown>, `${x.specialism} — ${x.waitingTimeDays ?? "n.v.t."} dagen wachttijd`, String(x.date)));
      const response = buildFormattedResponse({
        summary: `${records.length} NZa wachttijden`,
        records,
        provenance: prov("nza_zorgbeeld_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total),
        outputFormat,
        offset,
        limit: effectiveLimit,
        total: out.total,
        access_note: out.access_note,
        verbose: singleConnectorVerbose({ enabled: verbose, connector: "nza_zorgbeeld", endpoint: out.endpoint, responseTimeMs }),
      });
      return toMcpToolPayload(response);
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "NZa Zorgbeeld", "https://zorgbeeld.nza.nl")); }
  });

server.registerTool(
  "overheidsorganisaties_search",
  {
    description:
      "Search the Dutch government organisation register (ROO / TOOI): find agencies, municipalities, provinces, ministries, water authorities and ZBOs by name or abbreviation. Matching ignores case, accents, apostrophes and hyphens and also covers register abbreviations (UWV, RIVM), official names ('s-Gravenhage for Den Haag) and a few generic aliases (GGD = gezondheidsdienst); best matches first. Omit query to browse (e.g. all water authorities via type). The register also lists dissolved organisations: einddatum/opgeheven mark them, active_only=true hides them. Returns organisation name, type, TOOI URI, abbreviation, website, phone and visiting address; canonical_url is the website (https), or the organisation's register page when there is no website, enrichment is skipped or the organisation is dissolved. Utility for cross-source linking (name -> canonical TOOI id).",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Name substring or abbreviation of the government organisation, e.g. 'Amsterdam', 'Kadaster', 'UWV' or 'GGD'. Omit or leave empty to browse the full register (combine with type)."),
      type: z
        .string()
        .optional()
        .describe("Optional TOOI type URI filter, e.g. https://identifier.overheid.nl/tooi/def/ont/Gemeente"),
      enrich: z
        .boolean()
        .default(true)
        .describe("Enrich hits with website, phone and visiting address (extra API calls; only the first 15 hits of the returned page, the rest link to their register page)."),
      active_only: z
        .boolean()
        .default(false)
        .describe("Only organisations that still exist (no end date in the past in the TOOI register). Fails rather than returning unfiltered results when TOOI is unreachable."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  },
  async ({ query, type, enrich, active_only, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) {
        // Besides the register list, every search reads abbreviations and end dates from
        // TOOI (cached for an hour), and enrichment calls the register per shown hit.
        const base = dryRunPayload({
          connector: "overheidsorganisaties",
          url: "https://api-organisaties.overheid.nl/v1/overheidsorganisaties",
          params: { query: query ?? "", type: type ?? "", top: fetchRows, ...(active_only ? { active_only } : {}) },
        }).structuredContent;
        const payload = {
          ...base,
          planned_requests: [
            ...(base.planned_requests as unknown[]),
            {
              connector: "tooi_sparql",
              method: "GET",
              url: "https://standaarden.overheid.nl/tooi/sparql",
              params: { query: "afkortingen, officiële namen en einddata van alle organisaties (SPARQL)" },
            },
            ...(enrich
              ? [
                  {
                    connector: "overheidsorganisaties",
                    method: "GET",
                    url: "https://api-organisaties.overheid.nl/v1/overheidsorganisaties/{tooi_uri}/{contact|adressen|identificatie}",
                    params: { per_hit: "contact en adressen; identificatie alleen zonder bruikbare website", max_hits: 15 },
                  },
                ]
              : []),
          ],
          estimated_sources: ["overheidsorganisaties", "tooi_sparql"],
          cache_status: [...(base.cache_status as unknown[]), { connector: "tooi_sparql", cache_policy: "hardcoded-ttl" }],
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
      }
      const started = Date.now();
      const out = await overheidsorganisaties.search({
        query: query ?? "",
        rows: fetchRows,
        type,
        enrich,
        activeOnly: active_only,
        page: { offset, limit: effectiveLimit },
      });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) =>
        record(
          "overheidsorganisaties",
          String(x.title ?? x.id ?? "Overheidsorganisatie"),
          String(x.url ?? "https://organisaties.overheid.nl/"),
          x as unknown as Record<string, unknown>,
          [x.organisatietype, x.afkorting, x.opgeheven ? `opgeheven (einddatum ${x.einddatum})` : ""].filter(Boolean).join(" — "),
          "",
        ),
      );
      const response = buildFormattedResponse({
        summary: `${records.length} overheidsorganisaties`,
        records,
        provenance: prov(
          "overheidsorganisaties_search",
          out.endpoint,
          out.params,
          Math.min(effectiveLimit, Math.max(0, records.length - offset)),
          out.total,
        ),
        outputFormat,
        offset,
        limit: effectiveLimit,
        total: out.total,
        access_note: out.access_note,
        verbose: singleConnectorVerbose({
          enabled: verbose,
          connector: "overheidsorganisaties",
          endpoint: out.endpoint,
          responseTimeMs,
        }),
      });
      return toMcpToolPayload(response);
    } catch (e) {
      return toMcpToolPayload(
        mapSourceError(e, "Register Overheidsorganisaties", "https://organisaties.overheid.nl/"),
      );
    }
  },
);

  server.registerTool("ovapi_departures", {
    description: "Realtime public transport departures for a Dutch stop (halte). Requires a timingpointcode (haltecode). Returns line, destination, planned + expected departure time, delay minutes and live trip status. Tram/bus/metro/ferry.",
    inputSchema: {
      timingPointCode: z.string().describe("Halte timingpointcode (REQUIRED). Example: '32002646'. Look it up via 9292 or the OVapi/GTFS index (https://gtfs.ovapi.nl/nl/). Do NOT pass a stop name."),
      line: z.string().optional().describe("Optional filter on public line number, e.g. '2' or '6'."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ timingPointCode, line, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) return dryRunPayload({ connector: "ovapi", url: `http://v0.ovapi.nl/tpc/${timingPointCode}`, params: { timingPointCode, line: line ?? "", top: fetchRows } });
      const started = Date.now();
      const out = await ovapi.search({ timingPointCode, line, rows: fetchRows });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record("ovapi", String(x.title ?? "Vertrek"), String(x.url ?? "http://v0.ovapi.nl"), x as unknown as Record<string, unknown>, `${String(x.line ?? "")} → ${String(x.destination ?? "")} · verwacht ${String(x.expectedDepartureTime ?? "")}${typeof x.delayMinutes === "number" && x.delayMinutes !== 0 ? ` (${x.delayMinutes > 0 ? "+" : ""}${String(x.delayMinutes)} min)` : ""}`, String(x.expectedDepartureTime ?? "")));
      const response = buildFormattedResponse({
        summary: `${records.length} OVapi vertrekken`,
        records,
        provenance: prov("ovapi_departures", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total),
        outputFormat,
        offset,
        limit: effectiveLimit,
        total: out.total,
        access_note: out.access_note,
        verbose: singleConnectorVerbose({ enabled: verbose, connector: "ovapi", endpoint: out.endpoint, responseTimeMs }),
      });
      return toMcpToolPayload(response);
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "OVapi", "http://v0.ovapi.nl")); }
  });

  server.registerTool("bro_ondergrond_search", {
    description: "Query the Dutch Key Register of the Subsurface (BRO, Basisregistratie Ondergrond) public REST services. Pass a BRO object id (GMW/GLD/GMN/CPT/BHR, e.g. GMW000000036287) to fetch one subsurface object with location (WGS84 + RD), quality regime and registration metadata; pass a keyword to search the BRO reference-code domains. Keywords: grondwater, monitoringput, sondering, boring, ondergrond.",
    inputSchema: {
      query: z.string().describe("A BRO object id (GMW/GLD/GMN/CPT/BHR + digits, e.g. 'GMW000000036287') for a direct object lookup, OR a keyword to filter the BRO refcode domains (e.g. 'grondwater'). Do NOT pass full questions."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) return dryRunPayload({ connector: "bro", url: "https://publiek.broservices.nl/", params: { query, top: fetchRows } });
      const started = Date.now();
      const out = await broOndergrond.search({ query, rows: fetchRows });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record("bro", String(x.title ?? x.id ?? "BRO object"), String(x.url ?? "https://www.broloket.nl"), x as Record<string, unknown>, String(x.description ?? x.registration_status ?? ""), String(x.date ?? "")));
      const response = buildFormattedResponse({
        summary: `${records.length} BRO ondergrond resultaten`,
        records,
        provenance: prov("bro_ondergrond_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total),
        outputFormat,
        offset,
        limit: effectiveLimit,
        total: out.total,
        access_note: out.access_note,
        verbose: singleConnectorVerbose({ enabled: verbose, connector: "bro", endpoint: out.endpoint, responseTimeMs }),
      });
      return toMcpToolPayload(response);
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "BRO Basisregistratie Ondergrond", "https://www.broloket.nl"));
    }
  });

  server.registerTool(
    "ned_energie_search",
    {
      description:
        "Search NED.nl (Nationaal Energie Dashboard) energy generation/consumption per source (solar, wind, wind offshore, gas, nuclear) via /v1/utilizations. Returns capacity (kW), volume (kWh), utilization percentage and CO2 emission per time period, incl. forecasts. Requires NED_API_KEY.",
      inputSchema: {
        type: z.string().optional().describe("Energy source: alias (zon/solar, wind, wind_offshore, gas, kern/nuclear, verbruik) or NED code (0=all,1=wind,2=solar,17=wind offshore,18=fossil gas,20=nuclear,23=natural gas,59=electricity load). Default 2 (solar)."),
        point: z.string().optional().describe("Area (point): 0=Netherlands, 1-12=provinces, 14=offshore. Default 0."),
        granularity: z.string().optional().describe("Time interval: alias (10min/15min/hour/day/month/year) or code (3-8). Default hour (5)."),
        activity: z.string().optional().describe("Operation: providing/opwek(1), consuming/verbruik(2), import(3), export(4). Default 1."),
        classification: z.string().optional().describe("forecast(1) or current/measured(2). Default 2."),
        timezone: z.string().optional().describe("Granularity timezone: utc(0) or cet(1). Default 1."),
        validFrom: z.string().optional().describe("Lower bound on validfrom (YYYY-MM-DD or ISO), filter validfrom[after]."),
        validTo: z.string().optional().describe("Upper bound on validfrom (YYYY-MM-DD or ISO), filter validfrom[before]."),
        rows: z.number().int().min(1).max(config.limits.maxRows).default(20),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ type, point, granularity, activity, classification, timezone, validFrom, validTo, rows }) => {
      const apiKey = process.env[ENV_KEYS.NED_API_KEY];
      if (!apiKey) {
        return toMcpToolPayload(
          errorResponse({
            error: "not_configured",
            message: "NED_API_KEY ontbreekt",
            suggestion:
              "Maak een persoonlijke API-sleutel aan via je account op https://ned.nl/nl/api en zet NED_API_KEY. De sleutel gaat mee als X-AUTH-TOKEN-header.",
          }),
        );
      }
      try {
        const { NedSource } = await import("./sources/ned.js");
        const src = new NedSource(config, apiKey);
        const out = await src.search({ type, point, granularity, activity, classification, timezone, validFrom, validTo, rows });
        const records = out.items.map((x) =>
          record(
            "ned",
            x.title,
            x.url,
            x as unknown as Record<string, unknown>,
            x.typeLabel ?? x.type,
            x.validfrom,
          ),
        );
        return toMcpToolPayload(
          successResponse({
            summary: `${records.length} NED energie-datapunten`,
            records,
            provenance: prov("ned_energie_search", out.endpoint, out.params, records.length, out.total),
            access_note: out.access_note,
          }),
        );
      } catch (e) {
        return toMcpToolPayload(mapSourceError(e, "NED.nl Nationaal Energie Dashboard", "https://ned.nl/nl/api"));
      }
    },
  );

  server.registerTool(
    "ep_online_energielabel",
    {
      description:
        "Look up the registered energy label (energielabel) for a Dutch address from EP-Online (RVO national register). Returns energy class, registration/validity dates, building type, BAG ids, and energy indicators. Query by postcode+huisnummer or by BAG verblijfsobject id. Requires EP_ONLINE_API_KEY.",
      inputSchema: {
        postcode: z
          .string()
          .optional()
          .describe("Postcode zoals '3511LX' (spaties worden verwijderd). Vereist samen met huisnummer, tenzij bagId is opgegeven."),
        huisnummer: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Huisnummer. Vereist samen met postcode, tenzij bagId is opgegeven."),
        huisletter: z.string().optional().describe("Optionele huisletter, bijv. 'A'."),
        huisnummertoevoeging: z.string().optional().describe("Optionele huisnummertoevoeging."),
        detailaanduiding: z.string().optional().describe("Optionele detailaanduiding."),
        bagId: z
          .string()
          .optional()
          .describe("BAG verblijfsobject-id. Gebruikt het AdresseerbaarObject-endpoint i.p.v. adreszoekopdracht."),
        rows: z.number().int().min(1).max(config.limits.maxRows).default(20),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ postcode, huisnummer, huisletter, huisnummertoevoeging, detailaanduiding, bagId, rows }) => {
      const apiKey = process.env[ENV_KEYS.EP_ONLINE_API_KEY];
      if (!apiKey) {
        return toMcpToolPayload(
          errorResponse({
            error: "not_configured",
            message: "EP_ONLINE_API_KEY ontbreekt",
            suggestion:
              "Vraag een API-key aan via https://www.ep-online.nl/ (EP-Online / RVO) en zet EP_ONLINE_API_KEY. De key wordt als kale waarde in de Authorization-header meegestuurd.",
          }),
        );
      }
      try {
        const src = new EpOnlineSource(config, apiKey);
        const out = await src.search({ postcode, huisnummer, huisletter, huisnummertoevoeging, detailaanduiding, bagId, rows });
        const records = out.items.map((x) =>
          record(
            "ep_online",
            x.title,
            x.url,
            x as unknown as Record<string, unknown>,
            x.energieklasse,
            x.registratiedatum,
          ),
        );
        return toMcpToolPayload(
          successResponse({
            summary: `${records.length} EP-Online energielabel(s)`,
            records,
            provenance: prov("ep_online_energielabel", out.endpoint, out.params, records.length, out.total),
            access_note: out.access_note,
          }),
        );
      } catch (e) {
        return toMcpToolPayload(mapSourceError(e, "EP-Online", "https://www.ep-online.nl"));
      }
    },
  );

  server.registerTool(
    "ns_reisinformatie",
    {
      description:
        "Query NS (Dutch Railways) Reisinformatie API for live train info. operation=disruptions (verstoringen/werkzaamheden, v3), departures (vertrektijden per station, v2), arrivals (aankomsttijden, v2), trips (reisadvies from/to station, v3). Realtime; requires NS_API_KEY.",
      inputSchema: {
        operation: z
          .enum(["disruptions", "departures", "arrivals", "trips"])
          .default("disruptions")
          .describe("Welke NS-operatie: verstoringen, vertrektijden, aankomsttijden of reisadvies."),
        station: z
          .string()
          .optional()
          .describe("Stationcode (bijv. 'UT' Utrecht, 'ASD' Amsterdam CS, 'RTD' Rotterdam). Vereist voor departures/arrivals."),
        fromStation: z.string().optional().describe("Vertrekstation (code) — vereist voor operation 'trips'."),
        toStation: z.string().optional().describe("Aankomststation (code) — vereist voor operation 'trips'."),
        dateTime: z
          .string()
          .optional()
          .describe("Optioneel ISO-8601 tijdstip, bijv. '2026-07-03T08:00:00+02:00'. Default = nu."),
        isActive: z.boolean().optional().describe("disruptions: alleen actieve verstoringen tonen (default true)."),
        rows: z.number().int().min(1).max(config.limits.maxRows).default(20),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ operation, station, fromStation, toStation, dateTime, isActive, rows }) => {
      const apiKey = process.env[ENV_KEYS.NS_API_KEY];
      if (!apiKey) {
        return toMcpToolPayload(
          errorResponse({
            error: "not_configured",
            message: "NS_API_KEY ontbreekt",
            suggestion:
              "Vraag een gratis subscription-key aan via https://apiportal.ns.nl/ (product 'Reisinformatie API') en zet NS_API_KEY. De sleutel gaat mee als header 'Ocp-Apim-Subscription-Key'.",
          }),
        );
      }
      try {
        const { NsReisinformatieSource } = await import("./sources/ns-reisinformatie.js");
        const src = new NsReisinformatieSource(config, apiKey);
        const out = await src.search({ operation, station, fromStation, toStation, dateTime, isActive, rows });
        const records = out.items.map((x) =>
          record(
            "ns",
            String(x.title),
            String(x.url),
            x as unknown as Record<string, unknown>,
            String(x.cause ?? x.status ?? x.disruptionType ?? x.trainCategory ?? ""),
            String(x.date ?? ""),
          ),
        );
        return toMcpToolPayload(
          successResponse({
            summary: `${records.length} NS ${operation}`,
            records,
            provenance: prov("ns_reisinformatie", out.endpoint, out.params, records.length, out.total),
            access_note: out.access_note,
          }),
        );
      } catch (e) {
        return toMcpToolPayload(mapSourceError(e, "NS Reisinformatie", "https://www.ns.nl/reisinformatie"));
      }
    },
  );

  server.registerTool(
    "dnb_statistics_search",
    {
      description:
        "Fetch datapoints from the DNB Statistics API (De Nederlandsche Bank, gateway api.dnb.nl): interest rates, exchange rates, mortgages, pension fund and insurer balance sheets, balance of payments. Returns period, value and unit per observation. Requires DNB_API_KEY (free 'Public' product). Pass 'dataset' as the path 'statisticsdata/<version>/<dataset-slug>' or a full endpoint URL.",
      inputSchema: {
        dataset: z.string().describe("DNB dataset path 'statisticsdata/<version>/<dataset-slug>' or a full https endpoint URL. Example: 'statisticsdata/v2026061000/exchange-rates-of-the-euro-and-gold-price-day'. Find dataset slugs in the DNB Statistics API docs (api.portal.dnb.nl -> APIs -> DNB Statistics API)."),
        query: z.string().optional().describe("Optional free-text filter, applied client-side to period/label/unit/value."),
        startPeriod: z.string().optional().describe("Optional start period (SDMX-style), e.g. '2020' or '2020-01'."),
        endPeriod: z.string().optional().describe("Optional end period, e.g. '2024-12'."),
        rows: z.number().int().min(1).max(config.limits.maxRows).default(20),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ dataset, query, startPeriod, endPeriod, rows }) => {
      const apiKey = process.env[ENV_KEYS.DNB_API_KEY];
      if (!apiKey) {
        return toMcpToolPayload(
          errorResponse({
            error: "not_configured",
            message: "DNB_API_KEY ontbreekt",
            suggestion:
              "Maak een gratis My DNB-account aan, abonneer op het product 'Public' via https://api.portal.dnb.nl en zet de subscription key als DNB_API_KEY. Zie de Starters Guide: https://api.portal.dnb.nl/startersguide.",
          }),
        );
      }
      try {
        const { DnbStatisticsSource } = await import("./sources/dnb-statistics.js");
        const src = new DnbStatisticsSource(config, apiKey);
        const out = await src.search({ dataset, query, startPeriod, endPeriod, rows });
        const records = out.items.map((x) =>
          record(
            "dnb",
            x.title,
            x.url,
            { id: x.id, dataset: x.dataset, period: x.period, value: x.value, unit: x.unit, label: x.label, frequency: x.frequency },
            x.unit ? `${x.value ?? ""} ${x.unit}`.trim() : String(x.value ?? ""),
            x.period,
          ),
        );
        return toMcpToolPayload(
          successResponse({
            summary: `${records.length} DNB datapunten (${dataset})`,
            records,
            provenance: prov("dnb_statistics_search", out.endpoint, out.params, records.length, out.total),
            access_note: out.access_note,
          }),
        );
      } catch (e) {
        return toMcpToolPayload(mapSourceError(e, "DNB Statistics API", "https://www.dnb.nl/en/statistics/data-search/"));
      }
    },
  );


  server.registerTool("tenderned_aanbestedingen_search", {
    description: "Search Dutch public procurement notices and awards (TenderNed) — every tender published by Rijk, provincies, gemeenten, waterschappen, zorg- and onderwijsinstellingen. Returns contracting authority, tender name, publication type (aankondiging/gunning/marktconsultatie/vroegtijdige beëindiging), procedure, contract type, closing date and description. Use for 'welke aanbestedingen', 'wat besteedt gemeente X aan', 'wie won opdracht Y' (winner and award value: tenderned_aanbesteding_get). Search syntax is TenderNed's own: several words are combined with OR (a notice matching any one word counts), so to require an exact phrase wrap the WHOLE query in double quotes, e.g. '\"openbare verlichting\"'. Only one phrase per query works: two quoted phrases return nothing, and a phrase plus loose words is searched as plain OR. AND/OR/NOT, + and - are not operators. To limit results to one contracting authority use opdrachtgever instead of putting its name in the query. Only the first 10,000 results of any query are reachable. Closing dates: TenderNed's search index keeps the deadline of the original notice, even after a rectification moved it. For notices whose indexed deadline is in the future or at most 180 days old (up to 50 per call, latest first, within about 3 seconds) the tool re-reads the detail record, so sluitings_datum is the current deadline (sluitings_datum_gecontroleerd: true; sluitings_datum_oorspronkelijk holds the index date when it differed). Other closing dates come unchecked from the index (sluitings_datum_gecontroleerd: false); tenderned_aanbesteding_get gives the current deadline. Market consultations (MAC): the deadline in the notice itself ('Termijn ontvangst antwoorden', with time) is the closing date, as TenderNed's own field often differs (mostly later); recent ones are checked against their notice (sluitings_datum_bron 'aankondiging'; sluitings_datum_oorspronkelijk is TenderNed's field when it differed; sluitings_datum_opmerking explains).",
    inputSchema: {
      query: z.string().optional().describe("Free-text search over tender name, description and contracting authority. Several words = OR; wrap the whole query in double quotes for an exact phrase. Examples: 'fietsbrug', 'jeugdzorg', '\"openbare verlichting\"'. Keywords only, not full questions."),
      opdrachtgever: z.string().optional().describe("Contracting authority (aanbestedende dienst), e.g. 'Gemeente Utrecht', 'Omgevingsdienst Rivierenland', 'Ministerie van Defensie'. Looked up in TenderNed's register of contracting authorities and applied server-side: every registered authority whose name contains this text as whole words is included ('Ministerie van Defensie' covers all its units; 'Gemeente Utrecht' does not include 'Gemeente Utrechtse Heuvelrug'). Case, accents, apostrophe style and punctuation are ignored ('Gemeente Noardeast Fryslan' finds 'Gemeente Noardeast-Fryslân'). access_note lists the matched authorities; a name matching too many authorities (e.g. just 'Gemeente') is rejected as too broad."),
      typeOpdracht: z.enum(["leveringen", "diensten", "werken", "all"]).default("all").describe("Contract type: leveringen (supplies), diensten (services), werken (works)."),
      procedure: z.string().optional().describe("Optional procedure code. Known codes: OPE (openbaar), NOP (niet-openbaar), MAC (marktconsultatie), OZB (onderhands), CCD (concessie)."),
      date_from: z.string().optional().describe("Publication date from (YYYY-MM-DD)."),
      date_to: z.string().optional().describe("Publication date until (YYYY-MM-DD)."),
      sort: z.enum(["relevance", "date_newest"]).optional().describe("Server-side order across all matches: 'relevance' or 'date_newest' (newest publication date first). Default: relevance when query is set, newest first otherwise."),
      page: z.number().int().min(0).default(0).describe("Zero-based page number in pages of top notices (or limit, when larger). Results start at page × page size + offset. TenderNed serves max 100 notices per call and only the first 10,000 results of a query."),
      top: z.number().int().min(1).max(100).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, opdrachtgever, typeOpdracht, procedure, date_from, date_to, sort, page, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      // One upstream call returns at most 100 notices; the source reports that
      // cap in access_note, so a caller asking for more learns why it got 100.
      const windowSize = Math.min(100, effectiveLimit);
      // Pages count in top (or limit when larger, as before); offset is an
      // absolute shift on top of that, translated into upstream page/size.
      const pageSize = Math.min(100, Math.max(top, effectiveLimit));
      const start = page * pageSize + offset;
      // An unreachable start falls through to search(), which rejects it before any request.
      if (dryRun && start < TENDERNED_MAX_REACHABLE) {
        const plan = planUpstreamWindow(start, windowSize);
        return dryRunPayload({ connector: "tenderned", url: "https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties", params: { search: query, opdrachtgever, typeOpdracht, procedure, publicatieDatumVanaf: date_from, publicatieDatumTot: date_to, sort, page: plan.pages.join(","), size: plan.size } });
      }
      const started = Date.now();
      const out = await tenderned.search({ query, opdrachtgever, typeOpdracht, procedure, datumVanaf: date_from, datumTot: date_to, sort, rows: effectiveLimit, offset: start });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record(
        "tenderned",
        x.title,
        x.url,
        tenderNedRecordFields(x),
        `${x.opdrachtgever}${x.typePublicatie ? ` — ${x.typePublicatie}` : ""}`.trim(),
        x.publicatieDatum,
      ));
      const response = buildFormattedResponse({ summary: `${records.length} TenderNed publicaties`, records, provenance: prov("tenderned_aanbestedingen_search", out.endpoint, out.params, records.length, out.total), outputFormat, offset: 0, limit: windowSize, total: out.total, access_note: out.access_note, verbose: singleConnectorVerbose({ enabled: verbose, connector: "tenderned", endpoint: out.endpoint, responseTimeMs }) });
      // The window was already cut upstream, so the local slice starts at 0;
      // report its absolute position and TenderNed's own has_more instead.
      response.pagination = { offset: out.offset, limit: windowSize, total: out.total, has_more: out.has_more };
      return toMcpToolPayload(response);
    } catch (e) {
      if (e instanceof TenderNedInputError) {
        return toMcpToolPayload(errorResponse({ error: "unexpected", message: e.message, suggestion: e.suggestion, details: e.details }));
      }
      return toMcpToolPayload(mapSourceError(e, "TenderNed", "https://www.tenderned.nl/aankondigingen/overzicht"));
    }
  });

  server.registerTool("tenderned_aanbesteding_get", {
    description: "Get the full detail of one TenderNed procurement notice by publicatieId (publicatie_id from tenderned_aanbestedingen_search; either name is accepted): CPV codes, NUTS region, legal framework, procedure, contract start/end dates, award status and the related publications of the same procedure. Returns the same snake_case fields as the search tool (publicatie_datum, sluitings_datum, type_publicatie, ...) next to the original camelCase ones. By default also reads TenderNed's HTML rendering of the notice (Dutch or English) for the estimated value (geraamdeWaarde) and, for award notices, the winner(s), awarded values and contract dates (gunning): gunning.totaleWaarde is the value of all contracts awarded, winnaars[].waarde a winner's own value; for framework agreements gunning.raamovereenkomstMaximum (and per lot gunning.percelen[].raamovereenkomstMaximum) is a ceiling, not an awarded amount; a value shared by several winners of one lot is in gunning.percelen[].waarde, not per winner. Amounts under € 1,000 (e.g. '1 Euro') and closing dates in 2090 or later are flagged as placeholders. The closing date comes from TenderNed's metadata (sluitings_datum_bron names the field) and is the current deadline after any rectification (laatsteRectificatieId); for a market consultation (MAC) it is the deadline in the notice itself ('Termijn ontvangst antwoorden', read from the HTML rendering, else the PDF text, of the latest rectification when there is one; sluitings_datum_bron 'aankondiging', with time and UTC offset), and sluitings_datum_gecontroleerd is true only when the notice confirmed it; TenderNed's own field, which often differs, is kept in sluitings_datum_oorspronkelijk and sluitings_datum_opmerking names both. Otherwise it can differ from the deadline printed in the notice PDF and from the original deadline TenderNed's search index keeps; for a dynamic purchasing system (DAS) it may be the end date of the system. Set include_text to also extract the text of the official notice PDF (capped by max_chars).",
    inputSchema: {
      publicatieId: z.union([z.string(), z.number().int()]).optional().describe("TenderNed publication id, e.g. '437355'."),
      publicatie_id: z.union([z.string(), z.number().int()]).optional().describe("Alias of publicatieId, as returned by tenderned_aanbestedingen_search."),
      include_text: z.boolean().default(false).describe("Extract the text layer of the official notice PDF."),
      max_chars: z.number().int().min(1).max(200000).optional().describe("Cap on extracted PDF characters (default 12000, max 200000)."),
      include_award: z.boolean().default(true).describe("Parse the estimated value and, for award notices, winner(s), awarded value and contract dates from TenderNed's HTML rendering of the notice (one extra request)."),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ publicatieId, publicatie_id, include_text, max_chars, include_award }) => {
    const ids = [...new Set([publicatieId, publicatie_id].filter((v) => v !== undefined).map((v) => String(v).trim()).filter(Boolean))];
    if (!ids.length) {
      return toMcpToolPayload(errorResponse({ error: "unexpected", message: "Geef publicatieId (of publicatie_id) op", suggestion: "Gebruik publicatie_id uit tenderned_aanbestedingen_search, bijv. '437355'" }));
    }
    if (ids.length > 1) {
      return toMcpToolPayload(errorResponse({ error: "unexpected", message: `publicatieId en publicatie_id verschillen (${ids.join(" / ")})`, suggestion: "Geef één publicatie-id op" }));
    }
    if (!/^\d+$/.test(ids[0])) {
      return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Ongeldige TenderNed publicatie-id '${ids[0]}': alleen cijfers`, suggestion: "Gebruik publicatie_id uit tenderned_aanbestedingen_search, bijv. '437355'" }));
    }
    try {
      const out = await tenderned.get({ publicatieId: ids[0], include_text, max_chars, include_award });
      const x = out.item;
      const records = [record(
        "tenderned",
        x.title,
        x.url,
        { ...tenderNedRecordFields(x), ...x },
        `${x.opdrachtgever}${x.typePublicatie ? ` — ${x.typePublicatie}` : ""}`.trim(),
        // Same date-only form as the search record; the full timestamp stays in data.publicatieDatum.
        x.publicatieDatum.slice(0, 10),
      )];
      return toMcpToolPayload(successResponse({
        summary: `TenderNed publicatie ${x.id}: ${x.title}`,
        records,
        provenance: prov("tenderned_aanbesteding_get", out.endpoint, out.params, records.length, records.length),
        access_note: out.access_note,
      }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "TenderNed", "https://www.tenderned.nl/aankondigingen/overzicht"));
    }
  });

  server.registerTool("tuchtrecht_search", {
    description: "Search Dutch disciplinary rulings (tuchtrecht.overheid.nl) for regulated professions: healthcare (medisch tuchtcollege), lawyers, notaries, accountants, veterinarians and bailiffs. Rechtspraak.nl does NOT contain these rulings — use this tool for 'tuchtklacht', 'tuchtcollege', 'berisping', 'doorhaling BIG-register'. Returns ECLI, college, decision, case number and a summary.",
    inputSchema: {
      query: z.string().optional().describe("Topic keywords, matched full-text. Examples: 'onjuiste diagnose', 'medicatiefout', 'geheimhoudingsplicht'. Keywords only, not full questions."),
      college: z.string().optional().describe("Exact name of the disciplinary board, e.g. 'Centraal Tuchtcollege voor de Gezondheidszorg'. Exact match — leave empty when unsure."),
      date_from: z.string().optional().describe("Published/modified from (YYYY-MM-DD)."),
      date_to: z.string().optional().describe("Published/modified until (YYYY-MM-DD)."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, college, date_from, date_to, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) return dryRunPayload({ connector: "tuchtrecht", url: "https://repository.overheid.nl/sru", params: { query: `c.product-area==tuchtrecht${query ? ` AND ${query}` : ""}`, maximumRecords: fetchRows } });
      const started = Date.now();
      const out = await tuchtrecht.search({ query, organisatie: college, date_from, date_to, maximumRecords: fetchRows });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((raw) => {
        const x = raw as import("./sources/koop-collecties.js").TuchtrechtItem;
        return record(
          "tuchtrecht",
          x.title,
          x.canonical_url,
          { ecli: x.identifier, college: x.college, domein: x.domein, plaats: x.plaats, zaaknummer: x.zaaknummer, beslissing: x.beslissing, uitspraakdatum: x.uitspraakdatum, onderwerp: x.onderwerp, pdf_url: x.pdf_url },
          [x.beslissing, x.onderwerp].filter(Boolean).join(" — ") || x.samenvatting,
          x.uitspraakdatum,
        );
      });
      const response = buildFormattedResponse({ summary: `${records.length} tuchtrechtuitspraken`, records, provenance: prov("tuchtrecht_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total), outputFormat, offset, limit: effectiveLimit, total: out.total, access_note: out.access_note, verbose: singleConnectorVerbose({ enabled: verbose, connector: "tuchtrecht", endpoint: out.endpoint, responseTimeMs }) });
      return toMcpToolPayload(response);
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Tuchtrecht (KOOP SRU)", "https://tuchtrecht.overheid.nl"));
    }
  });

  server.registerTool("samenwerkende_catalogi_search", {
    description: "Search Samenwerkende Catalogi — the national index of products and services offered by Dutch municipalities, provinces and water authorities (paspoort aanvragen, gehandicaptenparkeerkaart, bijstandsuitkering, ...). Answers 'welke gemeenten bieden X aan' and 'wat biedt gemeente Y op gebied van Z'. Returns product title, responsible organisation, target audience and a summary.",
    inputSchema: {
      query: z.string().optional().describe("Product/service keywords, matched full-text. Examples: 'paspoort', 'hondenbelasting', 'schuldhulpverlening'."),
      organisatie: z.string().optional().describe("Exact organisation name (gemeente/provincie/waterschap), e.g. 'Amsterdam'. Exact match."),
      date_from: z.string().optional().describe("Last modified from (YYYY-MM-DD)."),
      date_to: z.string().optional().describe("Last modified until (YYYY-MM-DD)."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, organisatie, date_from, date_to, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) return dryRunPayload({ connector: "samenwerkende_catalogi", url: "https://repository.overheid.nl/sru", params: { query: `c.product-area==samenwerkendecatalogi${query ? ` AND ${query}` : ""}`, maximumRecords: fetchRows } });
      const started = Date.now();
      const out = await samenwerkendeCatalogi.search({ query, organisatie, date_from, date_to, maximumRecords: fetchRows });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((raw) => {
        const x = raw as import("./sources/koop-collecties.js").SamenwerkendeCatalogiItem;
        return record(
          "samenwerkende_catalogi",
          x.title,
          x.canonical_url,
          { identifier: x.identifier, organisatie: x.organisatie, organisatietype: x.organisatietype, gebied: x.gebied, informatietype: x.informatietype, doelgroep: x.doelgroep, samenvatting: x.samenvatting },
          [x.organisatie, x.doelgroep].filter(Boolean).join(" — "),
          x.gewijzigd,
        );
      });
      const response = buildFormattedResponse({ summary: `${records.length} productbeschrijvingen (Samenwerkende Catalogi)`, records, provenance: prov("samenwerkende_catalogi_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total), outputFormat, offset, limit: effectiveLimit, total: out.total, access_note: out.access_note, verbose: singleConnectorVerbose({ enabled: verbose, connector: "samenwerkende_catalogi", endpoint: out.endpoint, responseTimeMs }) });
      return toMcpToolPayload(response);
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Samenwerkende Catalogi (KOOP SRU)", "https://www.samenwerkendecatalogi.nl"));
    }
  });

  server.registerTool("brp_gewaspercelen_search", {
    description: "Search Dutch agricultural parcels (BRP Gewaspercelen, RVO) — the crop grown on every registered farm parcel, with polygon, area and year. Query by gemeente (auto-converted to a bbox) or by an EPSG:28992 bbox, and filter on crop name, category (bouwland/grasland/natuurterrein/landschapselement/braakland) or year. Use for land use, nitrogen, water quality and agriculture questions.",
    inputSchema: {
      gemeente: z.string().optional().describe("Municipality name; resolved to a bbox via the PDOK Locatieserver. Example: 'Dronten'."),
      bbox: z.string().optional().describe("RD New (EPSG:28992) bounding box 'minx,miny,maxx,maxy'. Takes precedence over gemeente."),
      gewas: z.string().optional().describe("Crop name substring filter (client-side). Examples: 'mais', 'aardappel', 'tarwe'."),
      categorie: z.enum(["bouwland", "grasland", "natuurterrein", "landschapselement", "braakland", "all"]).default("all").describe("Parcel category filter."),
      jaar: z.number().int().min(2009).max(2100).optional().describe("Registration year (jaar) filter."),
      includeGeometry: z.boolean().default(false).describe("Include the full GeoJSON polygon. Needed for outputFormat=geojson."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ gemeente, bbox, gewas, categorie, jaar, includeGeometry, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) return dryRunPayload({ connector: "brp_gewaspercelen", url: "https://service.pdok.nl/rvo/brpgewaspercelen/wfs/v1_0", params: { typeNames: "brpgewaspercelen:BrpGewas", bbox, gemeente, gewas, categorie, jaar, count: fetchRows } });
      const started = Date.now();
      const out = await brpGewaspercelen.search({ bbox, gemeente, gewas, categorie: categorie ?? "all", jaar, includeGeometry, rows: fetchRows });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record(
        "brp_gewaspercelen",
        x.title,
        x.url,
        { id: x.id, gewas: x.gewas, gewascode: x.gewascode, categorie: x.categorie, jaar: x.jaar, status: x.status, oppervlakte_m2: x.oppervlakteM2, oppervlakte_ha: x.oppervlakteHa, centroid: x.centroid, bbox: x.bbox, ...(x.geometry ? { geometry: x.geometry } : {}) },
        `${x.categorie}${x.oppervlakteHa !== null ? ` — ${x.oppervlakteHa} ha` : ""}`,
        x.jaar,
      ));
      const response = buildFormattedResponse({ summary: `${records.length} gewaspercelen`, records, provenance: prov("brp_gewaspercelen_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total), outputFormat, offset, limit: effectiveLimit, total: out.total, access_note: out.access_note, verbose: singleConnectorVerbose({ enabled: verbose, connector: "brp_gewaspercelen", endpoint: out.endpoint, responseTimeMs }) });
      return toMcpToolPayload(response);
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "BRP Gewaspercelen (PDOK WFS)", "https://service.pdok.nl/rvo/brpgewaspercelen/wfs/v1_0"));
    }
  });

  server.registerTool("verkiezingsuitslagen_search", {
    description: "Get Dutch election results per party from the Kiesraad databank (Databank Verkiezingsuitslagen): votes, percentage and seats, nationally or for one province or municipality, plus turnout (opkomst) and blank/invalid votes. Covers Tweede Kamer, Gemeenteraad, Provinciale Staten, Europees Parlement, Eerste Kamer, waterschappen and referenda. Use for 'hoe stemde gemeente X', 'uitslag verkiezingen', 'opkomst in Y'.",
    inputSchema: {
      verkiezing: z.string().optional().describe("Election code (e.g. 'TK20251029'), election kind ('TK', 'gemeenteraad', 'Europees Parlement') or empty for the most recent election."),
      gebied: z.string().optional().describe("Municipality or province name for a regional result, e.g. 'Tilburg' or 'Overijssel'. Empty returns the national result."),
      list_elections: z.boolean().default(false).describe("Return the list of available elections instead of a result."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(50),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ verkiezing, gebied, list_elections, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      if (dryRun) return dryRunPayload({ connector: "verkiezingsuitslagen", url: "https://www.verkiezingsuitslagen.nl/verkiezingen/detailJson", params: { verkiezing, gebied, list_elections } });
      const started = Date.now();

      if (list_elections) {
        const listed = await verkiezingsuitslagen.listVerkiezingen();
        const responseTimeMs = Date.now() - started;
        const records = listed.items.map((x) => record(
          "verkiezingsuitslagen",
          `${x.naam} — ${x.datum}`,
          x.url,
          { code: x.code, soort: x.soort, naam: x.naam, datum: x.datum, opkomst: x.opkomst },
          `Opkomst ${x.opkomst}`,
          x.datum,
        ));
        return toMcpToolPayload(buildFormattedResponse({ summary: `${records.length} beschikbare verkiezingen`, records, provenance: prov("verkiezingsuitslagen_search", listed.endpoint, { list_elections: "true" }, records.length, records.length), outputFormat, offset, limit: effectiveLimit, total: records.length, access_note: "Overzicht van gepubliceerde verkiezingen in de Kiesraad-databank. Gebruik 'code' als verkiezing-parameter.", verbose: singleConnectorVerbose({ enabled: verbose, connector: "verkiezingsuitslagen", endpoint: listed.endpoint, responseTimeMs }) }));
      }

      const out = await verkiezingsuitslagen.uitslag({ verkiezing, gebied });
      const responseTimeMs = Date.now() - started;

      if (!out.uitslag) {
        const records = out.verkiezingen.map((x) => record(
          "verkiezingsuitslagen",
          `${x.naam} — ${x.datum}`,
          x.url,
          { code: x.code, soort: x.soort, naam: x.naam, datum: x.datum, opkomst: x.opkomst },
          `Opkomst ${x.opkomst}`,
          x.datum,
        ));
        return toMcpToolPayload(buildFormattedResponse({ summary: "Verkiezing niet herkend; beschikbare verkiezingen", records, provenance: prov("verkiezingsuitslagen_search", out.endpoint, out.params, records.length, records.length), outputFormat, offset, limit: effectiveLimit, total: records.length, access_note: out.access_note, verbose: singleConnectorVerbose({ enabled: verbose, connector: "verkiezingsuitslagen", endpoint: out.endpoint, responseTimeMs }) }));
      }

      const u = out.uitslag;
      const records = u.partijen.map((p) => record(
        "verkiezingsuitslagen",
        p.partij,
        u.url,
        { partij: p.partij, aantal_stemmen: p.aantalStemmen, percentage: p.percentage, aantal_zetels: p.aantalZetels, verkiezing: u.verkiezingCode, verkiezing_naam: u.verkiezingNaam, gebied: u.gebied, niveau: u.niveau, kiesgerechtigden: u.kiesgerechtigden, opkomst: u.opkomst, opkomst_percentage: u.opkomstPercentage, geldige_stemmen: u.geldigeStemmen, blanco_stemmen: u.blancoStemmen, ongeldige_stemmen: u.ongeldigeStemmen },
        `${p.aantalStemmen ?? "?"} stemmen (${p.percentage ?? "?"}%)${p.aantalZetels ? ` — ${p.aantalZetels} zetels` : ""}`,
        u.verkiezingDatum,
      ));

      const context = `${u.verkiezingNaam} ${u.verkiezingDatum} — ${u.gebied}: opkomst ${u.opkomstPercentage ?? "?"}%, ${u.geldigeStemmen ?? "?"} geldige stemmen.`;
      const response = buildFormattedResponse({ summary: `${records.length} partijuitslagen — ${u.gebied} (${u.verkiezingNaam})`, records, provenance: prov("verkiezingsuitslagen_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), records.length), outputFormat, offset, limit: effectiveLimit, total: records.length, access_note: mergeAccessNotes(context, out.access_note), verbose: singleConnectorVerbose({ enabled: verbose, connector: "verkiezingsuitslagen", endpoint: out.endpoint, responseTimeMs }) });
      return toMcpToolPayload(response);
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Kiesraad Verkiezingsuitslagen", "https://www.verkiezingsuitslagen.nl"));
    }
  });

  server.registerTool("algoritmeregister_search", {
    description: "Search the Dutch national Algoritmeregister (algoritmes.overheid.nl, Ministry of BZK): algorithms and AI systems that government organisations have published. Search by keywords and/or organisation, optionally filtered by status, publication category (including 'Hoog-risico AI-systeem'), theme or organisation type. Returns per algorithm: name, organisation, short description, status, publication category, themes, supplier, impact assessments, publication date and a link to its page on algoritmes.overheid.nl. Keywords are matched in all fields with Dutch stemming and must all occur; without any exact match (also within an organisation or filter) the register answers with similar words (fuzzy), which the summary flags ('Geen exacte treffers', or 'Vermoedelijk geen' when inferred). Results are newest first and paged upstream (at most 100 per call). An ambiguous or unknown organisation returns no algorithms and names the matching organisations in access_note; an organisation the register knows without published algorithms is reported as such. The register only holds what organisations publish themselves, so it is not exhaustive.",
    inputSchema: {
      query: z.string().optional().describe("Keywords, e.g. 'parkeervergunning', 'afvalinzameling', 'fraude', 'anonimiseren'. Matched in all fields (name, description, supplier, organisation, ...); every word must occur, so pass a few keywords, not a question. Supports \"quoted phrases\", 'of'/'or' for alternatives and -word to exclude. Empty lists everything matching the other filters."),
      organisatie: z.string().optional().describe("Publishing organisation: a name ('Gemeente Utrecht', 'Utrecht', 'Belastingdienst', 'Ministerie van Financiën'), an abbreviation ('UWV', 'OCW', 'MinFin', 'Ministerie van JenV'), a register org_id ('gm0344') or register code ('gemeente-utrecht'). A bare place name prefers the municipality; the chosen organisation and other matches are reported in access_note. Ministries: the usual abbreviations resolve with or without 'Min'/'Ministerie van' in front ('OCW', 'MinOCW', 'SoZaWe', 'BiZa'; 'Fin', 'Def' and 'AZ' only with it), and another 'Min'/'Ministerie van' form when it names exactly one ministry by the start of a word or by the capitals that start its words ('MinJus', 'MinOnd'). A form that fits several ministries, or only by letters scattered through a name ('MinVol', the former 'VenW'), is not guessed: the ministries it may mean, if any, are listed in access_note instead."),
      status: z.enum(ALGORITME_STATUSSEN).optional().describe("Lifecycle status of the algorithm."),
      publicatiecategorie: z.enum(ALGORITME_PUBLICATIECATEGORIEEN).optional().describe("'Hoog-risico AI-systeem' (high-risk AI system), 'Impactvolle algoritmes' (impactful) or 'Overige algoritmes' (other)."),
      categorie: z.string().optional().describe("Theme, e.g. 'Sociale zekerheid', 'Openbare orde en veiligheid', 'Verkeer', 'Organisatie en bedrijfsvoering', 'Zorg en gezondheid'. Case-insensitive."),
      organisatietype: z.enum(ALGORITME_ORGANISATIETYPES).optional().describe("Type of publishing organisation as the register classifies it, e.g. 'gemeente', 'provincie', 'waterschap', 'ministerie', 'zelfstandig_bestuursorgaan'. The register files omgevingsdiensten, veiligheidsregio's, GGD's and other regional bodies under 'veiligheidsregio' (label 'Regionaal samenwerkingsorgaan'); several other types are not in use and return nothing, so search such an organisation by organisatie instead."),
      include_children: z.boolean().default(true).describe("With organisatie: include algorithms of underlying organisations (e.g. Belastingdienst, Douane and Dienst Toeslagen under Ministerie van Financiën). False = the organisation itself only."),
      top: z.number().int().min(1).max(ALGORITMEREGISTER_MAX_ROWS).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, organisatie, status, publicatiecategorie, categorie, organisatietype, include_children, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      // The register pages itself (page/limit, limit <= 100), so records are not
      // sliced locally again — hence no buildFormattedResponse.
      const rows = clampAlgoritmeRows(limit ?? top);
      const args = { query, organisatie, status, publicatiecategorie, categorie, organisatietype, includeChildren: include_children, offset, limit: rows };
      if (dryRun) {
        const plan = planAlgoritmeWindow(offset, rows);
        const org = organisatie?.trim();
        const body = algoritmeregister.buildQuery(args, org ? "<org_id>" : undefined);
        // The register's search is a POST with a JSON body.
        return dryRunPayload({ connector: "algoritmeregister", method: "POST", url: ALGORITMEREGISTER_SEARCH_ENDPOINT, params: { ...body, page: plan.pages.join(","), limit: plan.pageSize, ...(org ? { organisatie: org, organisatie_lookup: `POST ${ALGORITMEREGISTER_ORG_ENDPOINT}` } : {}) } });
      }
      const started = Date.now();
      const out = await algoritmeregister.search(args);
      const responseTimeMs = Date.now() - started;
      const records = out.items.map(algoritmeRecord);
      const formatted = applyOutputFormat({ records, outputFormat });
      return toMcpToolPayload(successResponse({
        summary: summarizeAlgoritmeSearch(out),
        records,
        provenance: prov("algoritmeregister_search", out.endpoint, out.params, records.length, out.total),
        pagination: {
          offset: out.offset,
          limit: out.limit,
          total: out.total,
          has_more: typeof out.total === "number" ? out.offset + records.length < out.total : false,
        },
        output_format: formatted.output_format,
        formatted_output: formatted.formatted_output,
        access_note: mergeAccessNotes(out.access_note, formatted.access_note),
        verbose: singleConnectorVerbose({ enabled: verbose, connector: "algoritmeregister", endpoint: out.endpoint, responseTimeMs }),
      }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Algoritmeregister", "https://algoritmes.overheid.nl"));
    }
  });

  server.registerTool("wodc_search", {
    description: "Search the WODC Repository (repository.wodc.nl): research reports of the Wetenschappelijk Onderzoek- en Datacentrum (Ministry of Justice and Security) since 1974, on crime, recidivism, the justice system, migration and evaluations of laws. Keywords are searched in the metadata and in the full text of the reports, all words required; \"quoted phrases\", OR and -word work. Filter by publication date (date_from/date_to: YYYY, YYYY-MM or YYYY-MM-DD), series ('Cahier', 'WODC Rapport', 'Factsheet', 'Justitiële verkenningen', or one number like 'Cahier 2026-12'), WODC project number or author. Returns per report: title, authors, issue date, series, project number, subjects, abstract (shortened), news link on wodc.nl and the persistent handle URL, plus the uuid for wodc_document_get (full abstract, files and text). sort: relevance (default with keywords), newest (default without) or oldest. At most 100 per call.",
    inputSchema: {
      query: z.string().max(SEARCH_QUERY_MAX).optional().describe("Keywords, e.g. 'recidive', 'ondermijning', '\"huiselijk geweld\"', 'cybercrime -fraude'. All words must occur (metadata or full text). Empty lists everything matching the filters."),
      date_from: z.string().optional().describe("Published on or after: YYYY, YYYY-MM or YYYY-MM-DD."),
      date_to: z.string().optional().describe("Published on or before: YYYY, YYYY-MM or YYYY-MM-DD."),
      series: z.string().optional().describe("Report series, matched as part of the series name: 'Cahier', 'WODC Rapport', 'Factsheet', 'Memorandum', 'Justitiële verkenningen', or one number, e.g. 'Cahier 2026-12'."),
      project: z.string().optional().describe("WODC project number, matched as part of the number and case-insensitive: '3606', or '3105' for 3105a-3105g."),
      author: z.string().optional().describe("Author, matched as part of the name ('Lastname, Initials' in the repository), e.g. 'Wartna'."),
      sort: z.enum(["relevance", "newest", "oldest"]).optional().describe("Default: relevance with keywords, newest without."),
      top: z.number().int().min(1).max(WODC_MAX_ROWS).default(20),
      ...paginationInputSchema,
      offset: z.number().int().min(0).max(WODC_MAX_OFFSET).default(0).describe(`Skip this many reports (at most ${WODC_MAX_OFFSET}).`),
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, date_from, date_to, series, project, author, sort, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      // The repository pages itself (page/size), so records are not sliced locally again.
      const rows = clampWodcRows(limit ?? top);
      const args = { query, date_from, date_to, series, project, author, sort, offset, limit: rows };
      if (dryRun) {
        const plan = planWodcWindow(offset, rows);
        const { params } = wodc.buildSearchParams(args, plan.pages[0], plan.size);
        return dryRunPayload({ connector: "wodc", url: WODC_SEARCH_ENDPOINT, params: { ...params, page: plan.pages.join(",") } });
      }
      const started = Date.now();
      const out = await wodc.search(args);
      const responseTimeMs = Date.now() - started;
      const records = out.items.map(wodcRecord);
      const formatted = applyOutputFormat({ records, outputFormat });
      const order = out.sort === "relevance" ? "meest relevant eerst" : out.sort === "newest" ? "nieuwste eerst" : "oudste eerst";
      const shown = records.length ? `, ${out.offset + 1}-${out.offset + records.length} getoond` : ", geen op deze pagina";
      return toMcpToolPayload(successResponse({
        summary: out.total === 0 ? "Geen WODC-rapporten gevonden" : out.total === null ? `${records.length} WODC-rapporten (${order})` : `${out.total} WODC-rapporten gevonden${shown} (${order})`,
        records,
        provenance: prov("wodc_search", out.endpoint, out.params, records.length, out.total),
        pagination: {
          offset: out.offset,
          limit: out.limit,
          total: out.total,
          has_more: typeof out.total === "number" ? out.offset + records.length < out.total : false,
        },
        output_format: formatted.output_format,
        formatted_output: formatted.formatted_output,
        access_note: mergeAccessNotes(out.access_note, formatted.access_note),
        verbose: singleConnectorVerbose({ enabled: verbose, connector: "wodc", endpoint: out.endpoint, responseTimeMs }),
      }));
    } catch (e) {
      return toMcpToolPayload(mapWodcError(e));
    }
  });

  server.registerTool("wodc_document_get", {
    description: `Get one WODC report (repository.wodc.nl) by the uuid or handle URL from wodc_search: full metadata (abstract, authors, series, project number, subjects), the item's files (rapport, aanbiedingsbrief, samenvatting, summary, ...: name, size, download URL) and the text of the report. The text is the repository's own extraction, which stops after 100,000 characters; when more is needed (zoekterm, a larger max_chars) the PDF itself is read (text_source 'auto'), up to 200,000 characters. zoekterm returns the passages holding all its words (at most ${WODC_MAX_PASSAGES}) instead of the beginning. bestand picks another file ('samenvatting', 'summary', a file uuid). Some items hold no files (published elsewhere): their link is given. Truncation is always stated.`,
    inputSchema: {
      id: z.string().max(300).describe("uuid or handle URL from wodc_search, e.g. 'cee6220c-e1b7-4507-a313-8891c35e77e4' or 'https://repository.wodc.nl/handle/20.500.12832/3576'."),
      max_chars: z.number().int().min(0).max(WODC_MAX_CHARS).default(WODC_DEFAULT_CHARS).describe("Characters of text (with zoekterm: of all passages together). 0: metadata and files only."),
      zoekterm: z.string().optional().describe("Words to find in the text, all required near each other; \"quoted phrase\" for exact words. Returns the passages around them."),
      bestand: z.string().optional().describe("Which file to read instead of the main report: 'samenvatting', 'summary', 'aanbiedingsbrief', 'factsheet', part of a file name, or a file uuid."),
      text_source: z.enum(["auto", "repository", "pdf"]).default("auto").describe("'auto': the repository's text, the PDF when that is missing or too short; 'repository': only the repository's text (fast); 'pdf': always the PDF."),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ id, max_chars, zoekterm, bestand, text_source }) => {
    try {
      const out = await wodc.getDocument({ id, max_chars, zoekterm, bestand, text_source });
      if ("notFound" in out) {
        return toMcpToolPayload(successResponse({
          summary: `WODC-item ${id} niet gevonden`,
          records: [],
          provenance: prov("wodc_document_get", out.endpoint, out.params, 0, 0),
          access_note: `${out.message} Zoek het rapport met wodc_search.`,
        }));
      }
      const x = out.item;
      const textInfo = out.passages
        ? `${out.passages_totaal} passage${out.passages_totaal === 1 ? "" : "s"} met '${zoekterm?.trim()}'`
        : out.tekst !== undefined
          ? `tekst ${out.tekst_ingekort ? `${max_chars} van ` : ""}${out.tekst_lengte} tekens uit ${out.tekst_bron === "pdf" ? "de PDF" : "de repository"}${out.tekst_onvolledig ? " (niet de hele tekst)" : ""}`
          : max_chars === 0 ? "alleen metadata en bestanden" : "geen tekst";
      const data = {
        ...x,
        files: out.files,
        bestand: out.bestand?.name,
        bestand_url: out.bestand?.url,
        tekst_bron: out.tekst_bron,
        tekst: out.tekst,
        tekst_lengte: out.tekst_lengte,
        tekst_ingekort: out.tekst_ingekort,
        tekst_onvolledig: out.tekst_onvolledig,
        pdf_tekst_lengte: out.pdf_tekst_lengte,
        pdf_paginas: out.pdf_paginas,
        zoekterm: zoekterm?.trim() || undefined,
        passages: out.passages,
        passages_totaal: out.passages_totaal,
        woord_treffers: out.woord_treffers,
      };
      const snippet = out.passages?.[0]?.tekst ?? shortAbstract(x.abstract, 240).text;
      return toMcpToolPayload(successResponse({
        summary: `WODC-rapport ${x.title}${x.issued ? ` (${[x.issued, ...x.series].join(", ")})` : ""}: ${textInfo}`,
        records: [record("wodc", x.subtitle ? `${x.title}: ${x.subtitle}` : x.title, x.url, data, snippet, x.issued)],
        provenance: prov("wodc_document_get", out.endpoint, out.params, 1, 1),
        access_note: mergeAccessNotes(...out.notes, "De repository vermeldt bij de rapporten geen licentie; neem voor hergebruik de voorwaarden van het WODC in acht."),
      }));
    } catch (e) {
      return toMcpToolPayload(mapWodcError(e));
    }
  });

  server.registerTool("eu_funding_search", {
    description: "Search the EU Funding & Tenders Portal (European Commission) for open, forthcoming or closed EU funding: topics of calls for proposals (grants, including prizes) under Horizon Europe, Digital Europe, LIFE, CEF, Creative Europe, CERV, EU4Health, Erasmus+, EDF, SMP and other EU programmes; cascade funding calls (open calls that EU-funded projects run for SMEs, start-ups and other third parties); and EU external action calls (EuropeAid/PROSPECT, mostly for organisations in or working with non-EU countries). Not here: EU tenders (TenderNed for Dutch procurement), national and regional schemes (rvo_subsidies_search, nl_onderzoek_calls_search) and EU structural funds run by Dutch authorities (EFRO/ESF+, Interreg). Per call: id (for eu_funding_get), title, call, programme, status as the portal states it, opening date, all deadlines, next_deadline and deadline_passed (computed), budget_eur with budget_scope (the topic's own budget line, a line shared with other topics: budget_shared_with, a cascade call's total, or an external call's budget; absent when the source has no amount), types of action and the portal URL. The portal index keeps outdated copies of many topics with their old status: with status open/forthcoming (default) calls without a deadline today or later are left out and counted in the summary and access_note; include_expired shows them, flagged outdated_index_record / deadline_passed. Keywords must be English: the portal is English and Dutch words find almost nothing. All words must occur; \"quoted phrases\", OR and -word work. Default order: next deadline first without keywords, relevance with keywords. At most 100 per call; only the first 10,000 results of a query are reachable.",
    inputSchema: {
      query: z.string().max(SEARCH_QUERY_MAX).optional().describe("English keywords, e.g. 'hydrogen', '\"cultural heritage\"', 'healthcare innovation', 'batteries OR storage', 'robotics -space'. Matched in title, description, identifier, call, type of action and keywords; every word must occur. Translate Dutch terms (waterstof → hydrogen, cultureel erfgoed → cultural heritage, zorginnovatie → healthcare innovation). A topic or call identifier also works. Empty lists everything matching the filters."),
      status: z.array(z.enum(EU_FUNDING_STATUSES)).optional().describe("'open', 'forthcoming' (announced, not yet open) and/or 'closed'. Default ['open','forthcoming']."),
      type: z.array(z.enum(EU_FUNDING_TYPES)).optional().describe("'grant' (topics of EU calls for proposals, including prizes), 'cascade_funding' (open calls of EU-funded projects for third parties, often SMEs) and/or 'external_action' (EuropeAid/PROSPECT, mostly for non-EU countries). Default all three."),
      programme: z.string().optional().describe(`EU programme as abbreviation (${EU_FUNDING_PROGRAMME_ABBREVIATIONS.join(", ")}), part of its name ('Horizon Europe', 'Digital Europe') or numeric portal id. An abbreviation used in two periods (LIFE, CREA, JUST, ...) covers both. Unknown values are rejected, never ignored.`),
      deadline_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD. A call matches when one of its deadlines falls on or after this day."),
      deadline_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD. A call matches when one of its deadlines falls on or before this day (one range: one deadline must lie inside the whole window)."),
      include_expired: z.boolean().default(false).describe("With status open/forthcoming: also show calls the portal still labels open/forthcoming whose deadlines have all passed (mostly outdated index copies)."),
      sort: z.enum(EU_FUNDING_SORTS).optional().describe("'deadline' (next deadline first; default without query), 'relevance' (default with query), 'deadline_desc' (latest last deadline first), 'newest'/'oldest' (opening or publication date), 'title', 'identifier'."),
      top: z.number().int().min(1).max(EU_FUNDING_MAX_ROWS).default(EU_FUNDING_DEFAULT_ROWS),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, status, type, programme, deadline_from, deadline_to, include_expired, sort, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      // The portal pages itself (at most 100 per page), so records are not sliced locally again.
      const args = { query, status, type, programme, deadlineFrom: deadline_from, deadlineTo: deadline_to, includeExpired: include_expired, sort, offset, limit: clampEuFundingRows(limit ?? top) };
      if (dryRun) {
        // A multipart POST (parts query, languages and sort typed application/json); the params also say
        // whether a count request and the next-deadline merge apply.
        return dryRunPayload({ connector: "eu_funding", method: "POST", url: EU_FUNDING_SEARCH_ENDPOINT, params: euFundingParams(buildEuFundingRequest(args)) });
      }
      const started = Date.now();
      const out = await euFunding.search(args);
      const responseTimeMs = Date.now() - started;
      const records = out.items.map(euFundingRecord);
      const formatted = applyOutputFormat({ records, outputFormat });
      return toMcpToolPayload(successResponse({
        summary: summarizeEuFundingSearch(out),
        records,
        provenance: prov("eu_funding_search", out.endpoint, out.params, records.length, out.total),
        pagination: {
          offset: out.offset,
          limit: out.limit,
          total: out.total,
          has_more: typeof out.total === "number" ? out.offset + records.length < Math.min(out.total, EU_FUNDING_MAX_REACHABLE) : false,
        },
        output_format: formatted.output_format,
        formatted_output: formatted.formatted_output,
        access_note: mergeAccessNotes(out.access_note, formatted.access_note),
        verbose: singleConnectorVerbose({ enabled: verbose, connector: "eu_funding", endpoint: out.endpoint, responseTimeMs }),
      }));
    } catch (e) {
      if (e instanceof EuFundingInputError) {
        return toMcpToolPayload(errorResponse({ error: "unexpected", message: e.message, suggestion: "Pas de invoer aan; de toegestane waarden staan in de beschrijving van eu_funding_search." }));
      }
      return toMcpToolPayload(mapSourceError(e, "EU Funding & Tenders Portal", EU_FUNDING_PORTAL));
    }
  });

  server.registerTool("eu_funding_get", {
    description: "Get one EU funding opportunity from the EU Funding & Tenders Portal by the id eu_funding_search returns: a topic identifier (e.g. 'HORIZON-CL5-2027-02-D3-01'; case does not matter), a cascade funding call number (cascade_call_id), a EuropeAid reference ('EuropeAid/187686/ID/ACT/MK') or a portal or PROSPECT URL. Returns the search fields plus: for a topic, description (expected outcome, scope) and conditions (admissibility, eligibility, evaluation) as plain text cut at max_chars, its budget lines (EUR per year; expected number of grants and min/max EU contribution per grant when stated, 0 = not stated), the whole call's budget overview with each budget line counted once, per-action status and deadlines, submission links, the latest call updates, and the cascade funding calls run under the topic (cascade_calls); for a cascade call, the project's own texts on eligibility, how to apply, further information and timing; for an external action call, the beneficiary administration and the published documents. A call identifier (e.g. 'HORIZON-CL4-2027-02-two-stage') returns its topics as candidates, as does a topic id that only matches cascade calls. When the index holds a current record and an outdated copy, the current record is used. An item the portal still labels open although all deadlines passed is flagged in access_note.",
    inputSchema: {
      id: z.string().min(1).max(500).describe("Topic identifier ('HORIZON-CL5-2027-02-D3-01'), cascade call number (cascade_call_id, e.g. '13882'), EuropeAid reference ('EuropeAid/187686/ID/ACT/MK') or call number, or the URL of the call's page on the Funding & Tenders Portal or PROSPECT. A call identifier lists its topics."),
      max_chars: z.number().int().min(200).max(EU_FUNDING_MAX_CHARS).default(EU_FUNDING_DEFAULT_MAX_CHARS).describe("Cap per text field (description, conditions, application_info, ...); 'truncated' names the fields that were cut."),
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ id, max_chars, verbose, dryRun }) => {
    try {
      // One POST on the identifier, at most two fallbacks on a miss (identifier phrase, call identifier).
      if (dryRun) return dryRunPayload({ connector: "eu_funding", method: "POST", url: EU_FUNDING_SEARCH_ENDPOINT, params: { id } });
      const started = Date.now();
      const out = await euFunding.get(id, { maxChars: max_chars });
      const responseTimeMs = Date.now() - started;
      const x = out.item;
      const records = x
        ? [record("eu_funding", x.title, x.url, { ...x, cascade_calls: out.cascade_calls }, describeEuFundingItem(x), (x.next_deadline ?? x.deadlines.at(-1))?.slice(0, 10))]
        : (out.candidates ?? []).map(euFundingRecord);
      return toMcpToolPayload(successResponse({
        summary: summarizeEuFundingGet(out),
        records,
        provenance: prov("eu_funding_get", out.endpoint, out.params, records.length),
        access_note: out.access_note,
        verbose: singleConnectorVerbose({ enabled: verbose, connector: "eu_funding", endpoint: out.endpoint, responseTimeMs }),
      }));
    } catch (e) {
      if (e instanceof EuFundingInputError) {
        return toMcpToolPayload(errorResponse({ error: "unexpected", message: e.message, suggestion: "Gebruik de id uit eu_funding_search." }));
      }
      return toMcpToolPayload(mapSourceError(e, "EU Funding & Tenders Portal", EU_FUNDING_PORTAL));
    }
  });

  server.registerTool("rvo_subsidies_search", {
    description: `Search the subsidies and financing schemes of RVO (Rijksdienst voor Ondernemend Nederland) on rvo.nl, e.g. DUMAVA, DEI+, ISDE, SWIM, Innovatiekrediet, BMKB, DHI. The catalogue is RVO's open data list of all ~1,370 pages of the section 'Subsidies en financiering', closed and historical regelingen and their sub-pages (aanvragen, voorwaarden, oproepen) included; it is read whole and searched locally: keywords in title, intro, regeling names and tags, all words required (also inside compounds: 'waterstof' finds 'waterstoftankstation'; words up to 3 letters only as whole words), \"quoted phrase\", uppercase OR for alternatives, -word to exclude; generic words such as 'subsidie' are ignored. Filter by doelgroep, onderwerp, sector, land, changed_since and main_pages_only. Status ('Open voor aanvragen', 'Bijna open voor aanvragen', 'Tijdelijk gesloten voor aanvragen', 'Gesloten voor aanvragen'), application period, total budget, the amount 'In behandeling' and what is still available are not in the open data: they are read from each shown result's public rvo.nl page exactly as RVO shows them (include_status, default true, at most ${RVO_STATUS_ENRICH_MAX} pages), with the raw values as evidence and a note where label and dates disagree. The status filter reads candidates' pages in ranking order, at most ${RVO_STATUS_CHECK_MAX} per call; total is then null when not every candidate was checked. Status pages are read for at most 10 s per call: a page not read in time is 'onbekend' with that reason (with the status filter it is unchecked, so total is null); a later call reuses what came in meanwhile. Only schemes RVO runs: NWO and ZonMw calls are in nl_onderzoek_calls_search, EU calls in eu_funding_search, municipal and provincial subsidieregelingen in cvdr_search. Full text, legal references and downloads of one result: rvo_subsidie_get.`,
    inputSchema: {
      query: z.string().max(SEARCH_QUERY_MAX).optional().describe("Keywords, e.g. 'waterstof', 'cultureel erfgoed', 'zorginnovatie', '\"maatschappelijk vastgoed\"'. Matched in title, intro, regeling names and tags; every word must occur (also inside a compound word); words of up to 3 letters only as a whole word. \"quoted phrase\", uppercase OR between alternatives, -word or NOT word to exclude. Generic words (subsidie, regeling, financiering, RVO) and stop words are ignored. Do NOT pass a full question. Empty: all pages matching the filters."),
      doelgroep: z.string().optional().describe(`Target group, matched case- and accent-insensitively against RVO's own values (exact first, otherwise containing): ${RVO_DOELGROEPEN.join(", ")}. E.g. 'mkb', 'kennisinstelling', 'agrarisch', 'overheid'. An unknown value returns nothing and lists the known ones in access_note.`),
      onderwerp: z.string().optional().describe(`Subject, matched like doelgroep: ${RVO_ONDERWERPEN.join(", ")}.`),
      sector: z.string().optional().describe("Sector, matched like doelgroep, e.g. 'Waterstofsector', 'Agrarische sector', 'ICT', 'Creatieve industrie', 'Watersector'. Broad regelingen list (almost) every sector, so this narrows little."),
      land: z.string().optional().describe("Country or area the regeling is for: Dutch name ('Ghana', 'Caribisch Nederland', 'Europa') or ISO code ('GH', 'NL')."),
      changed_since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD: only pages RVO edited on or after this day (UTC date of the last edit; any edit counts, not only new rounds)."),
      status: z.array(z.enum(RVO_STATUSSEN)).optional().describe("Only pages whose rvo.nl page shows one of these labels: open = 'Open voor aanvragen', bijna_open = 'Bijna open voor aanvragen', tijdelijk_gesloten = 'Tijdelijk gesloten voor aanvragen', gesloten = 'Gesloten voor aanvragen'. Reads the candidates' pages in ranking order, at most 40 per call; narrow with query or filters. E.g. ['open', 'bijna_open'] for what can be applied for now or soon."),
      main_pages_only: z.boolean().default(false).describe("Only a regeling's own page (directly under /subsidies-financiering/), not its sub-pages (aanvragen, voorwaarden, oproepen, veelgestelde vragen). Calls of a programme are often sub-pages, so leave false to find them."),
      include_status: z.boolean().default(true).describe(`Read the public page of each shown result (at most ${RVO_STATUS_ENRICH_MAX}) for status, period and budget. false: catalogue data only (fast, no status).`),
      sort: z.enum(RVO_SORTS).optional().describe("relevance (default with query), changed (default without: last edited first), created (newest pages first, e.g. new calls), title."),
      top: z.number().int().min(1).max(RVO_MAX_ROWS).default(RVO_DEFAULT_ROWS),
      ...paginationInputSchema,
      limit: z.number().int().min(1).max(RVO_MAX_ROWS).optional(),
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, doelgroep, onderwerp, sector, land, changed_since, status, main_pages_only, include_status, sort, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      if (dryRun) {
        const filters = Object.fromEntries(Object.entries({ query, doelgroep, onderwerp, sector, land, changed_since, status: status?.join(","), main_pages_only: main_pages_only || undefined, sort }).filter(([, v]) => v !== undefined && v !== ""));
        const pages = include_status || status?.length
          ? { status_pages: `GET ${rvoPageUrl("/subsidies-financiering/<slug>")} per ${status?.length ? `candidate (max ${RVO_STATUS_CHECK_MAX})` : `shown result (max ${RVO_STATUS_ENRICH_MAX})`} via connector ${RVO_SUBSIDIES_PAGES_CONNECTOR}` }
          : {};
        return dryRunPayload({ connector: RVO_SUBSIDIES_CONNECTOR, url: RVO_SUBSIDIES_ENDPOINT, params: { page: "0,1,2,... (50 per page, until an empty page; about 28; kept 3 h)", ...filters, ...pages } });
      }
      const started = Date.now();
      // The catalogue is searched and paged locally by the source (offset/limit applied there).
      const out = await rvoSubsidies.search({ query, doelgroep, onderwerp, sector, land, changed_since, status, main_pages_only, include_status, sort, offset, limit: limit ?? top });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map(rvoRecord);
      const formatted = applyOutputFormat({ records, outputFormat });
      return toMcpToolPayload(successResponse({
        summary: summarizeRvoSearch(out),
        records,
        provenance: prov("rvo_subsidies_search", out.endpoint, out.params, records.length, out.total),
        pagination: { offset: out.offset, limit: out.limit, total: out.total, has_more: out.has_more },
        output_format: formatted.output_format,
        formatted_output: formatted.formatted_output,
        access_note: mergeAccessNotes(out.access_note, formatted.access_note),
        verbose: singleConnectorVerbose({ enabled: verbose, connector: RVO_SUBSIDIES_CONNECTOR, endpoint: out.endpoint, responseTimeMs }),
      }));
    } catch (e) {
      if (e instanceof RvoSubsidiesInputError) {
        return toMcpToolPayload(errorResponse({ error: "unexpected", message: e.message, suggestion: e.suggestion }));
      }
      return toMcpToolPayload(mapSourceError(e, "RVO open data", "https://www.rvo.nl/subsidies-financiering"));
    }
  });

  server.registerTool("rvo_subsidie_get", {
    description: "Read one RVO regeling or page (rvo.nl, Subsidies en financiering) in full, by the uuid from rvo_subsidies_search or by its URL, path or slug ('dumava', '/subsidies-financiering/dumava'). Returns the text as plain text with '## ' section headings, taken from all blocks of the public page (uitklapblokken, notices, call-to-action and download lists included; RVO's open data API holds only the rich-text blocks), the list of sections, the status label, application period and budget (total, in behandeling, still available, budget date) as rvo.nl shows them with the raw values as evidence, links to the legal texts (wetten.overheid.nl BWBR ids, Staatscourant publication ids, EUR-Lex CELEX/ELI) to read with wetten_bwb_tekst or officiele_bekendmakingen_record_get, and the downloads (forms, lists: name, URL, type, size). sectie returns only the sections whose heading contains it ('Voorwaarden', 'Budget', 'Aanvragen'); max_chars caps the text (truncation is stated). A slug shared by several pages is not guessed: they are named as suggestions. A path or slug that rvo.nl has a page for but the open data lacks (some big regelingen' own pages, e.g. 'isde', 'sde', 'mit', 'dei') is reported with that page's link and suggestions from the catalogue. When the page redirects elsewhere or cannot be read, the status is 'onbekend' with the reason and the text comes from the open data API, with the missing blocks stated.",
    inputSchema: {
      id: z.string().min(1).max(500).describe("uuid from rvo_subsidies_search (data.id), or the page URL, path or slug: 'https://www.rvo.nl/subsidies-financiering/dumava', '/subsidies-financiering/dumava', 'dumava'. A bare slug means the regeling's own page first, else the one page whose path ends in it."),
      sectie: z.string().optional().describe("Only the sections whose '## ' heading contains this, e.g. 'Voorwaarden', 'Budget', 'Aanvragen', 'Meer weten'. Case- and accent-insensitive; an unknown one returns no text and lists the sections."),
      max_chars: z.number().int().min(1).max(RVO_TEXT_MAX_CHARS).default(RVO_TEXT_DEFAULT_CHARS).describe(`Maximum characters of text (default ${RVO_TEXT_DEFAULT_CHARS}, max ${RVO_TEXT_MAX_CHARS}); cut at a line.`),
      read_page: z.boolean().default(true).describe("Read the public rvo.nl page for status, period, budget and the complete text. false: only the open data API (rich-text blocks, no status)."),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ id, sectie, max_chars, read_page }) => {
    try {
      const out = await rvoSubsidies.get({ id, sectie, maxChars: max_chars, readPage: read_page });
      if ("notFound" in out) {
        const suggestions = out.suggestions.map((s) => `${s.title} (id ${s.id}, ${s.url})`);
        return toMcpToolPayload(successResponse({
          summary: `RVO-pagina '${id}' niet gevonden`,
          records: [],
          provenance: prov("rvo_subsidie_get", out.endpoint, out.params, 0, 0),
          access_note: mergeAccessNotes(out.message, suggestions.length ? `${out.site_page ? "Treffers in de catalogus" : "Misschien bedoeld"}: ${suggestions.join("; ")}.` : undefined, "Zoek de regeling met rvo_subsidies_search."),
        }));
      }
      const s = out.status_info;
      const snippet = [s?.status_label, s?.period_text ? `aanvragen ${s.period_text}` : undefined].filter(Boolean).join(" · ") || out.item.intro.slice(0, 240);
      const data = {
        ...out.item,
        status_info: s,
        text: out.text,
        text_chars: out.text_chars,
        text_truncated: out.text_truncated,
        text_source: out.text_source,
        sections: out.sections,
        sectie: out.sectie,
        legal_references: out.legal_references,
        downloads: out.downloads,
      };
      return toMcpToolPayload(successResponse({
        summary: summarizeRvoGet(out),
        records: [record("rvo", out.item.title, out.item.url, data, snippet, out.item.changed?.slice(0, 10))],
        provenance: prov("rvo_subsidie_get", out.endpoint, out.params, 1, 1),
        access_note: out.access_note,
      }));
    } catch (e) {
      if (e instanceof RvoSubsidiesInputError) {
        return toMcpToolPayload(errorResponse({ error: "unexpected", message: e.message, suggestion: e.suggestion }));
      }
      return toMcpToolPayload(mapSourceError(e, "RVO open data", "https://www.rvo.nl/subsidies-financiering"));
    }
  });

  server.registerTool("nl_onderzoek_calls_search", {
    description: "Search open calls and subsidy rounds of NWO (nwo.nl/calls, including calls of the NWO units on regieorgaan-sia.nl, nko.nl and openscience.nl) and ZonMw (zonmw.nl/nl/subsidies): research and health-care funding. Filter by organisation, keywords and status: 'actueel' (default: open or opening soon), 'open', 'binnenkort', 'gesloten' or 'alle'. Per call: title, link, short description, status (normalised to open/binnenkort/gesloten, with the site's own label such as 'Open voor aanvragen', 'Doorlopend', 'In voorbereiding', 'Verwacht'), and where the overview shows them: budget (NWO), start date and deadline, programme and 'Voor wie' (ZonMw, e.g. 'Op uitnodiging'). The NWO overview shows no closing date and the ZonMw overview no budget: nl_onderzoek_call_get gives those, the conditions and the documents. NWO statuses are nwo.nl's own labels; the ZonMw status follows from the start and deadline on the page with zonmw.nl's own rule. Keywords go to each site's own full-text search and must all occur. With organisatie 'alle', offset and limit apply per organisation (NWO first, then ZonMw). The total can be unknown (null) when a site was not read to the end; this is stated. DUS-I is not covered (its site shows no status). Business subsidies: rvo_subsidies_search; EU calls: eu_funding_search; legal texts of subsidy regulations: CVDR, Officiële Bekendmakingen and wetten_bwb.",
    inputSchema: {
      organisatie: z.enum(["nwo", "zonmw", "alle"]).default("alle").describe("Funding body: NWO (research, including its units SIA, NKO and Open Science NL), ZonMw (health care and welfare research) or both."),
      query: z.string().max(128).optional().describe("Keywords for the site's own full-text search, e.g. 'klimaat', 'zorginnovatie', 'cultureel erfgoed', 'waterstof'. All words must occur; pass one or two keywords, not a question. At most 128 characters."),
      status: z.enum(ONDERZOEKSCALL_STATUS_FILTERS).default("actueel").describe("'actueel' = open or opening soon (default), 'open', 'binnenkort' (NWO 'Opent binnenkort'/'In voorbereiding', ZonMw 'Verwacht'), 'gesloten' (incl. NWO 'Procedure loopt'), 'alle'."),
      top: z.number().int().min(1).max(ONDERZOEKSCALL_MAX_ROWS).default(ONDERZOEKSCALL_DEFAULT_ROWS),
      ...paginationInputSchema,
      offset: z.number().int().min(0).max(ONDERZOEKSCALL_MAX_OFFSET).default(0).describe("Skip this many calls per organisation."),
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ organisatie, query, status, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      // The sites page themselves (12 cards a page), so records are not sliced locally again.
      const args = { organisatie, query, status, offset, limit: clampOnderzoekscallRows(limit ?? top) };
      if (dryRun) {
        // One request per organisation; ZonMw starts at page 0 unless every status is asked.
        const [first, ...rest] = onderzoekscalls.planSearch(args).map(({ connector, url, params }) => ({ connector, url, params }));
        return dryRunPayload({ ...first, also: rest });
      }
      const started = Date.now();
      const out = await onderzoekscalls.search(args);
      const responseTimeMs = Date.now() - started;
      const records = out.items.map(onderzoekscallRecord);
      const formatted = applyOutputFormat({ records, outputFormat });
      return toMcpToolPayload(successResponse({
        summary: summarizeOnderzoekscallsSearch(out),
        records,
        provenance: prov("nl_onderzoek_calls_search", out.endpoint, out.params, records.length, out.total),
        pagination: { offset: out.offset, limit: out.limit, total: out.total, has_more: out.has_more },
        ...(out.failures.length ? { failures: out.failures.map((f) => ({ connector: f.connector, error_type: f.error_type, message: f.message })) } : {}),
        output_format: formatted.output_format,
        formatted_output: formatted.formatted_output,
        access_note: mergeAccessNotes(out.access_note, formatted.access_note),
        verbose: singleConnectorVerbose({ enabled: verbose, connector: out.per_site.map((s) => s.connector).join(","), endpoint: out.endpoint, responseTimeMs }),
      }));
    } catch (e) {
      return toMcpToolPayload(mapOnderzoekscallError(e));
    }
  });

  server.registerTool("nl_onderzoek_call_get", {
    description: "Get one call or subsidy round of NWO (also on regieorgaan-sia.nl, nko.nl, openscience.nl) or ZonMw by the url from nl_onderzoek_calls_search: status as the page shows it, every date on the page (opening, pre-registration, closing date; the deadline is 'Sluitingsdatum volledige aanvraag' or the only closing date for NWO, the header deadline for ZonMw; for NWO next_deadline is the first closing date still ahead, e.g. a letter of intent before the full application), budget (total and, for ZonMw, per application; amounts in words stay text), programme, all 'Kenmerken' as shown, links to the call documents and forms, and the page text (who can apply, what for, criteria, procedure) with '## ' before each heading. Contact persons are left out. A warning is given when an open status sits next to closing dates that have all passed, or when several closing dates leave the deadline undetermined. Text is cut at max_chars (stated).",
    inputSchema: {
      url: z.string().min(1).max(500).describe("URL of a call page from nl_onderzoek_calls_search, e.g. https://www.nwo.nl/calls/<naam>, https://regieorgaan-sia.nl/calls/<naam>, https://www.zonmw.nl/nl/subsidie/<naam>. Other hosts or paths are refused without a request."),
      max_chars: z.number().int().min(500).max(ONDERZOEKSCALL_MAX_CHARS).default(ONDERZOEKSCALL_DEFAULT_CHARS).describe("Maximum characters of page text."),
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ url, max_chars, verbose, dryRun }) => {
    try {
      if (dryRun) {
        // Refuses other hosts and paths before any request. A ZonMw page is followed by
        // a small request for its status block, whose node id is on the page.
        const { organisation, url: pageUrl } = resolveOnderzoekscallUrl(url);
        return dryRunPayload({ connector: ONDERZOEKSCALL_CONNECTORS[organisation], url: pageUrl, params: organisation === "zonmw" ? { status_block: "GET https://www.zonmw.nl/nl/entity-date-status/<nid>/full" } : {} });
      }
      const started = Date.now();
      const d = await onderzoekscalls.get({ url, max_chars });
      const responseTimeMs = Date.now() - started;
      const records = [record(d.organisation, d.title, d.url, d as unknown as Record<string, unknown>, [d.status_label, d.deadline_text, d.budget_text].filter(Boolean).join(" · "), amsterdamDay(d.deadline))];
      return toMcpToolPayload(successResponse({
        summary: summarizeOnderzoekscall(d),
        records,
        provenance: prov("nl_onderzoek_call_get", d.endpoint, d.params, 1, 1),
        access_note: d.access_note,
        verbose: singleConnectorVerbose({ enabled: verbose, connector: ONDERZOEKSCALL_CONNECTORS[d.organisation], endpoint: d.endpoint, responseTimeMs }),
      }));
    } catch (e) {
      return toMcpToolPayload(mapOnderzoekscallError(e));
    }
  });
}
