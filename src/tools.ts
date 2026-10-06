import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, ENV_KEYS } from "./config.js";
import { DataOverheidSource } from "./sources/data-overheid.js";
import { CbsSource } from "./sources/cbs.js";
import { TweedeKamerSource, mapTweedeKamerError, parseTkQuery, tkRecordView, tkSubjectTitle } from "./sources/tweede-kamer.js";
import { DEBAT_DEFAULT_CHARS, DEBAT_DEFAULT_DAYS, DEBAT_MAX_CHARS, DEBAT_MAX_VERSLAGEN, TweedeKamerDebattenSource, type DebatFragment, type DebatHit, type DebatSearchResult } from "./sources/tweede-kamer-debatten.js";
import { BekendmakingenSource, AUTHORITY_TYPES, MAX_TEXT_CHARS, SRU_MAX_START_RECORD, bekendmakingSnippet, normalizeBekendmakingIdentifier, rewriteKeepingSyntax } from "./sources/bekendmakingen.js";
import { RijksoverheidSource } from "./sources/rijksoverheid.js";
import { RijksbegrotingSource } from "./sources/rijksbegroting.js";
import { DuoSource } from "./sources/duo.js";
import { ApiRegisterSource } from "./sources/api-register.js";
import { KnmiSource } from "./sources/knmi.js";
import { PdokSource } from "./sources/pdok.js";
import { OriSource, oriFailureHint } from "./sources/ori.js";
import { NdwSource } from "./sources/ndw.js";
import { LuchtmeetnetSource } from "./sources/luchtmeetnet.js";
import { RechtspraakSource } from "./sources/rechtspraak.js";
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
import { WettenBwbSource } from "./sources/wetten-bwb.js";
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
import { EuCellarSource, normalizeCelex, parseDocumentNumber } from "./sources/eu-cellar.js";
import { LidoSource, parseLidoId, normalizeLidoType, clampLidoRows } from "./sources/lido.js";
import { DsoOmgevingsdocumentenSource, DsoInputError, DSO_DOCUMENT_TYPES, DSO_PRESENTEREN_BASE, DSO_RODK_URL, dsoApiKeyProblem, type DocumentType as DsoDocumentType, type DsoSearchArgs, type DsoSearchItem } from "./sources/dso-omgevingsdocumenten.js";
import { DSO_TEXT_DEFAULT_CHARS, DSO_TEXT_MAX_CHARS, selectDsoText, zoektermWords, type DsoTextPart } from "./sources/dso-regeltekst.js";
import { AlgoritmeregisterSource, ALGORITMEREGISTER_SEARCH_ENDPOINT, ALGORITMEREGISTER_ORG_ENDPOINT, ALGORITMEREGISTER_MAX_ROWS, ALGORITME_STATUSSEN, ALGORITME_PUBLICATIECATEGORIEEN, ALGORITME_ORGANISATIETYPES, clampAlgoritmeRows, planAlgoritmeWindow, summarizeAlgoritmeSearch } from "./sources/algoritmeregister.js";
import { mapSourceError, nowIso, successResponse, toMcpToolPayload, errorResponse } from "./utils/response.js";
import { SourceRequestError } from "./utils/http.js";
import { parseTemporalRange } from "./utils/temporal.js";
import { applyOutputFormat } from "./utils/output-format.js";
import { getConnectorHealth } from "./utils/connector-runtime.js";
import { buildFormattedResponse, dryRunPayload, mergeAccessNotes, singleConnectorVerbose } from "./utils/tool-runner.js";
import type { MCPRecord } from "./types.js";
import { rewriteQuery, extractKeywords, extractKeywordTerms, looseTimePhrases, metaNounBinding, rewriteNote, quotedQuery } from "./utils/query-rewriter.js";
import { logger } from "./utils/logger.js";

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

function record(source: string, title: string, canonical_url: string, data: Record<string, unknown>, snippet?: string, date?: string): MCPRecord {
  return { source_name: source, title, canonical_url, data, snippet, date };
}

/** An Algoritmeregister item as algoritmeregister_search and nl_gov_ask show it. */
function algoritmeRecord(x: Awaited<ReturnType<AlgoritmeregisterSource["search"]>>["items"][number]): MCPRecord {
  const meta = [x.organisation, x.status, x.publication_category].filter(Boolean).join(" · ");
  const desc = x.description_short.length > 240 ? `${x.description_short.slice(0, 239)}…` : x.description_short;
  return record("algoritmeregister", x.title, x.url, x as unknown as Record<string, unknown>, [meta, desc].filter(Boolean).join(" — "), x.published_at?.slice(0, 10));
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
 * An ORI item as nl_gov_ask shows it, the way ori_search does: the passage
 * around the matched terms as snippet (kept out of `data`, so it is not sent
 * twice) instead of the bare record type.
 */
function oriRecord({ snippet, ...item }: Record<string, unknown>): MCPRecord {
  return record("ori", String(item.title ?? item.id ?? "ORI item"), String(item.url ?? "https://www.openraadsinformatie.nl"), item, String(snippet ?? item.type ?? ""), String(item.publishedAt ?? ""));
}

/** data.match of a Tweede Kamer record that holds the words of a name apart, not as the phrase (nl_gov_ask). */
const TK_WORDS_APART = "woorden afzonderlijk";

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

const outputFormatSchema = z.enum(["json", "csv", "geojson", "markdown_table"]).default("json");
const cbsFilterScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const cbsFilterValueSchema = z.union([cbsFilterScalarSchema, z.array(cbsFilterScalarSchema)]);
const paginationInputSchema = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(config.limits.maxRows).optional(),
};

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
 * Lowercase words that bind the parts of a Dutch place name together:
 * "Alphen aan den Rijn", "Bergen op Zoom", "Berkel en Rodenrijs". They only ever
 * appear *between* capitalised words, so a match still has to end on one.
 */
const PLACE_INFIXES = "aan|bij|de|den|der|en|het|op|ten|ter|van|['’]t";

/**
 * One place name: a capitalised word followed by any number of further
 * capitalised words, optionally bound by the infixes above.
 *
 * Shaped as `capital (infix* capital)*` rather than `capital (infix capital)*`,
 * because the second half of a Dutch place name is not always introduced by an
 * infix: "Den Helder" and "Den Haag" are two capitals in a row, and the earlier
 * pattern stopped after "Den". That truncation was not harmless — "Den" prefix-
 * matches the "Den Haag-…" Luchtmeetnet stations and resolves to De Bilt in the
 * PDOK Locatieserver, so a question about Den Helder came back with Den Haag's
 * air quality and parcels 89 km away.
 *
 * "'s-Hertogenbosch" and "'t Zand" open on an apostrophe, hence the prefix.
 */
const PLACE_CORE = `(?:['’]s-|['’]t\\s+)?[A-ZÀ-Þ][\\wÀ-ÿ'’-]*(?:(?:\\s+(?:${PLACE_INFIXES}))*\\s+[A-ZÀ-Þ][\\wÀ-ÿ'’-]*)*`;

const GEMEENTE_PLACE_RE = new RegExp(`\\bgemeente\\s+(${PLACE_CORE})`);
const IN_PLACE_RE = new RegExp(`\\bin\\s+(${PLACE_CORE})`);

/**
 * Pull a place name out of a raw (non-lowercased) question so bbox- and
 * gemeente-scoped sources can be driven from natural language: "in Tilburg",
 * "gemeente Land van Cuijk". Exported for router-intent tests.
 *
 * Over-capturing ("in Amsterdam en Utrecht") is preferred over truncating: an
 * unresolvable name makes a source answer "not found", which is honest, while a
 * truncated one silently resolves to a different place.
 */
export function extractPlaceName(text: string): string | undefined {
  const gemeenteMatch = GEMEENTE_PLACE_RE.exec(text);
  const inMatch = IN_PLACE_RE.exec(text);
  const raw = (gemeenteMatch?.[1] ?? inMatch?.[1] ?? "").trim().replace(/[?.,;:!]+$/, "");
  return raw.length >= 3 ? raw : undefined;
}

/**
 * Narrow a natural question down to CBS-searchable topic words.
 *
 * CBS table titles are national and topical ("Woningen; ...", "Bevolking; ..."):
 * they never carry a municipality name and rarely a question word, so searching
 * the full sentence — even after the generic rewriter — returns nothing. These
 * candidates are only ever tried AFTER the existing ones come back empty, so a
 * query that works today keeps its current result.
 */
export function cbsNarrowingCandidates(strictQuery: string, place?: string): string[] {
  const placeTokens = new Set(
    (place ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
  // Quantity/question words survive the shared rewriter (its frames only strip
  // them directly before a verb) but never appear in a CBS table title.
  const quantityWords = new Set([
    "hoeveel", "aantal", "aantallen", "veel", "many", "much", "count",
    "welke", "welk", "wat", "hoe", "waar", "wanneer", "wie",
  ]);

  const tokens = strictQuery
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter((t) => t.length > 2 && !quantityWords.has(t) && !placeTokens.has(t));

  if (!tokens.length) return [];

  const joined = tokens.join(" ");
  // Longest token = most distinctive noun; the last resort when even the
  // narrowed phrase finds nothing ("woningen gebouwd" -> "woningen").
  const longest = [...tokens].sort((a, b) => b.length - a.length)[0];

  return [...new Set([joined, longest])].filter(Boolean);
}

/** Map an air-quality component named in a (lowercased) question to a Luchtmeetnet formula. */
export function extractLuchtComponent(lowered: string): string | undefined {
  if (/\bno2\b|stikstofdioxide/.test(lowered)) return "NO2";
  if (/\bpm\s?2[.,]?5\b|\bpm25\b/.test(lowered)) return "PM25";
  if (/\bpm\s?10\b|fijn\s?stof/.test(lowered)) return "PM10";
  if (/\bozon\b|\bo3\b/.test(lowered)) return "O3";
  if (/\bso2\b|zwaveldioxide/.test(lowered)) return "SO2";
  return undefined;
}

/** Map an election kind mentioned in a (lowercased) question to a Kiesraad code prefix. */
export function extractVerkiezingHint(lowered: string): string | undefined {
  if (/tweede\s*kamer/.test(lowered)) return "TK";
  if (/gemeenteraad/.test(lowered)) return "GR";
  if (/provinciale\s*staten/.test(lowered)) return "PS";
  if (/europe(es|se)\s*parlement|europese verkiezing/.test(lowered)) return "EP";
  if (/eerste\s*kamer/.test(lowered)) return "EK";
  if (/waterschap/.test(lowered)) return "WS";
  const code = /\b([a-z]{2})\s?(\d{8})\b/.exec(lowered);
  return code ? `${code[1].toUpperCase()}${code[2]}` : undefined;
}

export type EuIntent =
  | { kind: "document"; celex: string }
  | { kind: "transposition"; celex: string }
  | { kind: "search"; query: string };

const EU_CELEX_TOKEN = /(?:^|[^\p{L}\d])(?:celex\s*:?\s*)?(3\d{4}[RLD]\d{4})(?=$|[^\p{L}\d])/iu;
// Tight citation shape: a bare "verordening 2024/12" can be a municipal bylaw, so
// regulations and decisions need an EU/EG/EEG marker; directives are EU-only.
const EU_CITATION = /(?:uitvoerings|gedelegeerde\s+)?(verordening|richtlijn|besluit)\s*(\((?:eu|eg|eeg|euratom)\)|\b(?:eu|eg|eeg)\b)?\s*(?:nr\.?\s*)?\d{1,4}\s*\/\s*\d{1,4}(\s*\/\s*(?:eu|eg|eeg)\b)?/iu;
const EU_SEARCH_TRIGGER = /(?:^|[^\p{L}\d-])(?:eur-?lex|eu-(?:richtlijn|verordening|wetgeving)(?:en)?|europese\s+(?:richtlijn|verordening|wetgeving)(?:en)?|omzetting\s+(?:van\s+(?:de\s+|een\s+)?)?(?:eu-)?richtlijn(?:en)?)(?=$|[^\p{L}\d-])/iu;
const EU_STRIP_WORDS = /(?:^|[^\p{L}\d-])(?:eur-?lex|eu|eu-richtlijn(?:en)?|eu-verordening(?:en)?|eu-wetgeving|europese|europees|richtlijn(?:en)?|verordening(?:en)?|wetgeving|omzetting|welke|zijn|er|over|op|het|gebied|van|de|een|in)(?=$|[^\p{L}\d-])/giu;

/**
 * Narrow EU-legislation intent for nl_gov_ask. Runs on the RAW question: the
 * query rewriter strips '/', which would destroy citations like "2016/679".
 */
export function detectEuIntent(question: string): EuIntent | undefined {
  const raw = String(question ?? "");
  let celex: string | null = null;
  const token = EU_CELEX_TOKEN.exec(raw);
  if (token) celex = normalizeCelex(token[1]);
  if (!celex) {
    const cit = EU_CITATION.exec(raw);
    if (cit && (cit[2] || cit[3] || cit[1].toLowerCase() === "richtlijn")) celex = normalizeCelex(cit[0]);
  }
  if (celex) {
    const isDirective = celex.charAt(5) === "L";
    return isDirective && /omzet|omgezet|implementatie|ge[iï]mplementeerd|transpos/i.test(raw) ? { kind: "transposition", celex } : { kind: "document", celex };
  }
  if (!EU_SEARCH_TRIGGER.test(raw)) return undefined;
  const query = raw.replace(/[?!.,;:]/g, " ").replace(EU_STRIP_WORDS, " ").replace(/\s+/g, " ").trim();
  return query ? { kind: "search", query } : undefined;
}

export function shouldDeepenTweedeKamerQuery(question: string): boolean {
  const q = question.trim().toLowerCase();
  if (!q) return false;

  const explicitContentIntent = [
    /\bvat(?:\s+\w+){0,4}\s+samen\b/i,
    /\bsamenvatting\b/i,
    /\bsummary\b/i,
    /\bsummar(?:ise|ize)\b/i,
    /\bwat\s+staat\s+er(?:in|\s+in)\b/i,
    /\binhoud\b/i,
    /\bleg\s+uit\b/i,
    /\banalyse(?:er)?\b/i,
    /\bwat\s+is\s+besloten\b/i,
    /\bwat\s+heeft\s+de\s+tweede\s+kamer\s+besloten\b/i,
    /\bwat\s+besluiten\s+deze\s+stukken\b/i,
    /\bwhat\s+does\s+(?:this|the)\s+(?:document|motion|letter|brief|stuk)\s+say\b/i,
    /\bwhat\s+is\s+in\s+(?:this|the)\s+(?:document|motion|letter|brief|stuk)\b/i,
  ];

  return explicitContentIntent.some((pattern) => pattern.test(q));
}

/** Words that only say "a municipality"; dropped from a search that is already scoped to one. */
export const MUNICIPAL_SCOPE_WORDS = ["gemeente", "gemeenten", "gemeentes", "gemeentelijk", "gemeentelijke", "gemeenteraad", "gemeenteraden"];

/**
 * Words that place a question in a municipal council: the council, its members
 * and its papers, whose documents live in Open Raadsinformatie. Plain
 * "gemeente(n)" is not among them; it only names the kind of organisation
 * ("Rechtspraak over gemeentelijke belastingen" is no council question).
 */
const COUNCIL_RE = /(?:^|[^\p{L}])(?:gemeenteraad|gemeenteraden|raadslid|raadsleden|raadsvoorstel(?:len)?|raadsbesluit(?:en)?|raadsbrie(?:f|ven)|raadsinformatiebrie(?:f|ven)|raadsvergadering(?:en)?|raadsinformatie|wethouders?|burgemeesters?|collegebesluit(?:en)?|b&w)(?=$|[^\p{L}])/iu;

/** "gemeente", "gemeenten", "gemeentelijke": a municipal question, but no signal of its own. */
const MUNICIPALITY_NOUN_RE = /(?:^|[^\p{L}])(?:gemeente|gemeenten|gemeentes|gemeentelijke?)(?=$|[^\p{L}])/iu;

/** Generic organisation nouns: they mark an organisation question but are no search topic. */
export const ORGANISATION_WORDS = ["overheid", "overheden", "organisatie", "organisaties", "overheidsorganisatie", "overheidsorganisaties", "uitvoeringsorganisatie", "uitvoeringsorganisaties"];

const ORGANISATION_RE = /(?:^|[^\p{L}])(?:gemeente|gemeenten|gemeentes|provincie|provincies|waterschap|waterschappen|ministerie|ministeries|overheid|overheden|overheidsorganisaties?|uitvoeringsorganisaties?|veiligheidsregio(?:'s)?|agentschap(?:pen)?)(?=$|[^\p{L}])/iu;

/**
 * National actors. When one of them is the subject, "in Amsterdam" is where
 * something happens, not the municipality whose council records answer it
 * ("Wat doet het kabinet aan woningnood in Amsterdam?").
 */
const NATIONAL_ACTOR_RE = /(?:^|[^\p{L}])(?:kabinet|regering|ministers?|ministerie|ministeries|staatssecretaris(?:sen)?|rijksoverheid|tweede\s+kamer|eerste\s+kamer)(?=$|[^\p{L}])/iu;

const RULING_WORD_RE = /(?:^|[^\p{L}])uitspra(?:ak|ken)(?=$|[^\p{L}])/iu;

/**
 * Courts, judges and case-law words: with one of them named, "uitspraken" are
 * rulings. "hof" is the court of appeal, but not in the municipality name "Hof
 * van Twente". The chambers of a court ("meervoudige kamer", "strafkamer")
 * are named here so that "kamer" in them is not read as parliament.
 */
const COURT_RE = /(?:^|[^\p{L}])(?:\p{L}*rechters?|rechtbank(?:en)?|gerechtsh(?:of|oven)|hof(?!\s+van\s+twente)|raad\s+van\s+state|hoge\s+raad|centrale\s+raad\s+van\s+beroep|college\s+van\s+beroep|tuchtcolleges?|ecli|jurisprudentie|rechtspraak|rechterlijke?|(?:meervoudige|enkelvoudige|civiele)\s+kamer|(?:straf|kanton|belasting|ondernemings|pacht|familie|handels)kamer)(?=$|[^\p{L}])/iu;

/**
 * Office holders, politicians and bodies that make statements. "Uitspraken van
 * de minister over jeugdzorg" asks what the minister said; "uitspraken" is the usual
 * Dutch word for that as well as for court rulings. Bare "partij(en)" is not
 * among them: "tussen partijen" names the parties to a court case.
 */
const STATEMENT_SPEAKER = String.raw`(?:kabinet|regering|ministers?|minister-president|premier|staatssecretaris(?:sen)?|bewindslieden|bewindspersonen?|(?:tweede\s+|eerste\s+)?kamer|kamerleden|kamerlid|politicus|politici|(?:politieke\s+|coalitie|oppositie|regerings)partij(?:en)?|fracties?|fractievoorzitters?|lijsttrekkers?|wethouders?|burgemeesters?|gemeenteraad|raadsleden|raadslid|raad|college|gedeputeerden?|commissaris|koning|president)`;

/** "de", "het" or "een", then at most one word ("de demissionaire minister", "minister Keijzer" needs none). */
const SPEAKER_LEAD = String.raw`(?:(?:de|het|een)\s+)?(?:\p{L}+\s+)?`;

const UITSPRAAK = String.raw`uitspra(?:ak|ken)`;
const WORD_START = String.raw`(?:^|[^\p{L}])`;
const WORD_END = String.raw`(?=$|[^\p{L}])`;
/** The rest of the clause up to a word boundary: no sentence or clause mark in between. */
const CLAUSE_GAP = String.raw`(?:[^.!?;:]*[^\p{L}.!?;:])?`;

/** Speech verbs: with one of them the speaker made statements ("Wat zei de minister", "de premier zegt"). */
const SPEECH_VERB = String.raw`(?:zei|zeiden|zegt|zeggen)`;

/**
 * Forms of "doen", the verb of "een uitspraak doen". They tie the speaker to
 * the word only when "uitspraak" is their object ("Welke uitspraken deed de
 * premier", "Deed de premier uitspraken"), not in "Wat doet het college met de
 * uitspraak over de parkeervergunning?", where the college acts on a ruling.
 */
const DO_VERB = String.raw`(?:deed|deden|doet|doen)`;

/**
 * Auxiliaries. "heeft de minister" is a statement only with a statement
 * participle in the same clause ("Welke uitspraken heeft het kabinet gedaan"),
 * not in "Heeft de staatssecretaris de uitspraak aangevochten?" or "Welke
 * uitspraak heeft de minister verloren?", where the office holder is a party.
 */
const AUX_VERB = String.raw`(?:heeft|hebben|had|hadden)`;
const STATEMENT_PARTICIPLE = String.raw`(?:gedaan|gezegd|geuit|uitgesproken|herhaald|teruggenomen)`;

/** Prepositions that make "de uitspraak" the thing talked about or acted on ("met de uitspraak", "na de uitspraak"). */
const TOPIC_PREPOSITION = String.raw`(?:over|met|tegen|na|naar|bij|op|in|aan|voor|door|om|ondanks|volgens|rond|rondom|omtrent|inzake|sinds|zonder|uit|tot|onder)`;

/** A determiner and at most one other word (no preposition) before "uitspraak" as the object of "doen": "deed de premier een opvallende uitspraak". */
const OBJECT_LEAD = String.raw`(?:(?:de|het|een|die|deze|dit|dat|geen|zulke|enkele|veel|vele|meerdere)\s+)?(?:(?!${TOPIC_PREPOSITION}\s)\p{L}+\s+)?`;

/**
 * "uitspraak" in a prepositional phrase ("met de uitspraak", "na de recente
 * uitspraak"): a ruling talked about or acted on, not something a speaker
 * says. A possessive keeps it the speaker's own ("in zijn uitspraak").
 */
const TOPIC_UITSPRAAK_RE = new RegExp(String.raw`${WORD_START}${TOPIC_PREPOSITION}\s+(?:(?:de|het|een|deze|die|dit|dat)\s+)?(?:(?!(?:zijn|haar|hun|diens|mijn|onze|jullie)\s)\p{L}+\s+)?${UITSPRAAK}${WORD_END}`, "giu");

/**
 * A speaker tied to "uitspraak"/"uitspraken". Checked on the question as
 * typed: its owner ("uitspraken van de minister", "gedaan door het kabinet",
 * "uitspraken die de wethouder deed"), the subject of a speech verb ("Wat zei
 * de premier") or of an auxiliary with a statement participle ("Welke
 * uitspraken heeft het kabinet gedaan"). An office holder that is only named
 * somewhere in the question is often a party to a case instead ("Uitspraak
 * over verblijfsvergunning tegen de staatssecretaris", "Uitspraken die de
 * staatssecretaris heeft verloren").
 */
const LINKED_SPEAKER_RES = [
  new RegExp(String.raw`${WORD_START}${UITSPRAAK}\s+(?:(?:gedaan|gedane)\s+)?(?:van|door)\s+${SPEAKER_LEAD}${STATEMENT_SPEAKER}${WORD_END}`, "iu"),
  new RegExp(String.raw`${WORD_START}(?:gedaan|gedane)\s+door\s+${SPEAKER_LEAD}${STATEMENT_SPEAKER}${WORD_END}`, "iu"),
  new RegExp(String.raw`${WORD_START}${UITSPRAAK}\s+die\s+${SPEAKER_LEAD}${STATEMENT_SPEAKER}${WORD_END}${CLAUSE_GAP}(?:${DO_VERB}|${SPEECH_VERB}|${STATEMENT_PARTICIPLE}|uitte|uitten)${WORD_END}`, "iu"),
  new RegExp(String.raw`${WORD_START}${SPEECH_VERB}\s+${SPEAKER_LEAD}${STATEMENT_SPEAKER}${WORD_END}`, "iu"),
  new RegExp(String.raw`${WORD_START}${STATEMENT_SPEAKER}\s+${SPEECH_VERB}\s+(?:\p{L}+\s+){0,3}${UITSPRAAK}${WORD_END}`, "iu"),
  new RegExp(String.raw`${WORD_START}${AUX_VERB}\s+${SPEAKER_LEAD}${STATEMENT_SPEAKER}${WORD_END}${CLAUSE_GAP}${STATEMENT_PARTICIPLE}${WORD_END}`, "iu"),
  new RegExp(String.raw`${WORD_START}${STATEMENT_SPEAKER}\s+${AUX_VERB}\s+(?:\p{L}+\s+){0,3}${UITSPRAAK}${WORD_END}${CLAUSE_GAP}${STATEMENT_PARTICIPLE}${WORD_END}`, "iu"),
];

/**
 * A speaker as the subject of "doen" with "uitspraak" as its object. Checked
 * on the question with every "uitspraak" in a prepositional phrase set aside
 * (TOPIC_UITSPRAAK_RE): "uitspraak" before the verb in the same clause
 * ("Welke uitspraken over migratie deed de premier", but not "Uitspraak over
 * de parkeervergunning wat doet het college ermee", whose object is "wat"),
 * or right after the speaker or verb ("Deed de premier uitspraken", "De
 * premier deed een opvallende uitspraak").
 */
const DO_STATEMENT_RES = [
  new RegExp(String.raw`${WORD_START}${UITSPRAAK}${WORD_END}(?:(?![^\p{L}](?:wat|hoe|waarom)[^\p{L}])[^.!?;:,])*[^\p{L}.!?;:,]${DO_VERB}\s+${SPEAKER_LEAD}${STATEMENT_SPEAKER}${WORD_END}`, "iu"),
  new RegExp(String.raw`${WORD_START}${DO_VERB}\s+${SPEAKER_LEAD}${STATEMENT_SPEAKER}\s+${OBJECT_LEAD}${UITSPRAAK}${WORD_END}`, "iu"),
  new RegExp(String.raw`${WORD_START}${STATEMENT_SPEAKER}\s+${DO_VERB}\s+${OBJECT_LEAD}${UITSPRAAK}${WORD_END}`, "iu"),
];

/** Whether an office holder or body in the question is the speaker of "uitspraak"/"uitspraken". */
function hasLinkedSpeaker(question: string): boolean {
  if (LINKED_SPEAKER_RES.some((re) => re.test(question))) return true;
  const withoutTopics = question.replace(TOPIC_UITSPRAAK_RE, (m) => m.replace(/uitspra(?:ak|ken)$/iu, "…"));
  return DO_STATEMENT_RES.some((re) => re.test(withoutTopics));
}

/**
 * Words that only occur in court proceedings: appeal, the parties and their
 * roles, a case against someone, contesting a ruling and its outcome ("de
 * uitspraak aangevochten", "in het gelijk gesteld", "gelijk gekregen", "het
 * besluit … vernietigd"). With one of them "uitspraken" are rulings, also when
 * an office holder is tied to the word ("Welke uitspraken heeft de
 * staatssecretaris in hoger beroep verloren?"). Words that are also a policy
 * topic ("bezwaar", "geschil", "bestemmingsplan", "beroep" as a trade) are not
 * among them, nor bare "verloren"/"gewonnen" ("Uitspraken van de premier over
 * de gewonnen verkiezingen"); without a tied speaker the question is read as
 * rulings anyway ("Welke uitspraak heeft de minister verloren?").
 */
const LITIGATION_RE = /(?:^|[^\p{L}])(?:hoger\s+beroep|in\s+beroep|beroep\s+(?:tegen|ingesteld|aangetekend)|beroepschrift(?:en)?|beroepszaak|beroepszaken|cassatie|bezwaarschrift(?:en)?|(?:tussen\s+(?:de\s+)?|proces)partijen|procespartij|eisers?|eiseres|gedaagden?|verweerders?|verweerster|appellant(?:e|en)?|kort\s+geding|rechtszaak|rechtszaken|za(?:ak|ken)\s+tegen|aangevochten|aanvechten|aanvecht|aanvocht(?:en)?|(?:vecht|vechten|vocht|vochten)\s+(?:[^.!?;:]*\s)?aan(?=\s*(?:$|[.!?;:,]))|in\s+het\s+gelijk\s+(?:gesteld|stelde|stelden|stelt)|gelijk\s+(?:gekregen|kreeg|kregen|krijgt|krijgen)|vernietiging\s+van\s+(?:het|de)\s+(?:besluit|beschikking|vonnis|uitspraak)|(?:besluit(?:en)?|beschikkingen?|vonnis(?:sen)?)\s+(?:\p{L}+\s+){0,3}vernietigd)(?=$|[^\p{L}])/iu;

/**
 * What "uitspraak"/"uitspraken" means in a question, if it occurs. With a
 * court named ("Uitspraken van de rechtbank over de gemeente") or a word of
 * court proceedings ("Uitspraak huurgeschil tussen partijen") the word means
 * rulings. It means statements, which court rulings do not answer, only when
 * an office holder or body is tied to it as its speaker ("Uitspraken van de
 * minister over jeugdzorg", "Welke uitspraken deed de premier over migratie?",
 * "Uitspraken van de wethouder van Utrecht"). Every other question asks for
 * rulings: "Welke uitspraken zijn er over huurrecht?", and also "Uitspraak in
 * de zaak tegen de minister van Justitie", "Heeft de staatssecretaris de
 * uitspraak aangevochten?" and "Wat doet het college met de uitspraak?",
 * where the office holder is a party or acts on a ruling. A speaker named
 * only by surname is not recognised.
 */
export function uitsprakenSense(question: string): "rulings" | "statements" | undefined {
  const raw = String(question ?? "");
  if (!RULING_WORD_RE.test(raw)) return undefined;
  if (COURT_RE.test(raw) || LITIGATION_RE.test(raw)) return "rulings";
  return hasLinkedSpeaker(raw) ? "statements" : "rulings";
}

/** Whether a question asks for court rulings with "uitspraak"/"uitspraken". Exported for router tests. */
export function asksForRulings(question: string): boolean {
  return uitsprakenSense(question) === "rulings";
}

/**
 * Policy vocabulary, compounds included ("GGZ-beleid", "kabinetsbeleid",
 * "woonstrategie", "omgevingsvisie"). "visie" is matched only on its own or as
 * a compound with a linking -s or hyphen, so "televisie" and "revisie" stay out.
 */
const POLICY_RE = /(?:^|[^\p{L}])(?:[\p{L}-]*beleid(?:s\p{L}*)?|[\p{L}-]*strategie(?:ën|s)?|(?:\p{L}+-)?visie|\p{L}+svisie|omgevingsvisie|toekomstvisie|aanpak|plannen|ambities?|maatregelen|inzet|toepassing(?:en)?)(?=$|[^\p{L}])/iu;

/** Questions about what an organisation does: "Wat doet …", "Hoe gaat … om met …". */
const ORGANISATION_ACTIVITY_RES = [
  /\bwat\s+(?:doet|doen|deed|deden)\b/i,
  /\bhoe\s+(?:gaat|gaan|ging|gingen)\b[\s\S]*\bom\s+met\b/i,
  /\bhoe\s+(?:gebruikt|gebruiken|zet|zetten|pakt|pakken|werkt|werken)\b/i,
  /\b(?:werkt|werken)\s+(?:aan|met)\b/i,
  /\b(?:van\s+plan|bezig\s+met)\b/i,
];

/** Words that ask for data rather than documents. */
const DATA_INTENT_WORDS = new Set(["data", "dataset", "datasets", "gegevens", "databestand", "databestanden", "cijfers", "statistiek", "statistieken", "tabel", "tabellen"]);

/**
 * A question that asks for data rather than documents ("Welke data is er over
 * verkeersongevallen?"); the catalogue fallback is the right answer there.
 * A data word only counts on its own: lowercase (a capitalised "Data"
 * mid-sentence is part of a name), not a compound ("data-uitwisseling") and not the
 * first half of a term ("open data portaal", "data strategie"). Before, a
 * lowercase question about an open data portaal went to the catalogue, which
 * dropped "data" and searched "open portaal".
 */
export function hasDataIntent(question: string): boolean {
  const words = String(question ?? "").split(/[^\p{L}\p{N}&+-]+/u).filter(Boolean);
  return words.some((word, i) => {
    const lower = word.toLowerCase();
    if (!DATA_INTENT_WORDS.has(lower)) return false;
    const sentenceInitial = i === 0 && /^\p{Lu}\p{Ll}/u.test(word);
    if (word !== lower && !sentenceInitial) return false;
    return metaNounBinding(undefined, lower, words[i + 1]) !== "head";
  });
}

// No "i" flag on these: PLACE_CORE relies on capitals to know where a place name ends.
const GEMEENTE_PLACE_ANY_CASE_RE = new RegExp(`\\b[Gg]emeente\\s+(${PLACE_CORE})`);
/**
 * "de raad van Amsterdam", "het college in Delft", "burgemeester van Tilburg".
 * "raad" and "college" only in lowercase: capitalised they open the name of a
 * court or body ("Raad van State", "Centrale Raad van Beroep", "College van
 * Beroep voor het bedrijfsleven"), which is no municipality.
 */
const GOVERNANCE_PLACE_RE = new RegExp(`(?:^|[^\\p{L}])(?:[Gg]emeenteraad|raad|college|[Bb]urgemeester|[Ww]ethouders?)\\s+(?:van|in)\\s+(${PLACE_CORE})`, "u");

/** Places that extractPlaceName can return but that have no municipal ORI index. */
const NOT_A_MUNICIPALITY = new Set([
  "nederland", "europa", "eu", "tweede kamer", "eerste kamer", "noord-holland", "zuid-holland",
  "noord-brabant", "gelderland", "overijssel", "drenthe", "friesland", "fryslân", "flevoland",
  "limburg", "zeeland", "randstad",
  // Second halves of the names of courts and bodies: "raad van State",
  // "college van Beroep", "raad van Bestuur", "college van B en W".
  "state", "beroep", "bestuur", "toezicht", "commissarissen", "advies", "state-generaal",
  "b en w", "burgemeester en wethouders", "gedeputeerde staten", "ministers", "europese unie",
]);

/** Lowercase infixes inside a place name ("Bergen op Zoom"); a name never ends on one. */
const PLACE_INFIX_WORDS = new Set(["aan", "bij", "de", "den", "der", "en", "het", "op", "ten", "ter", "van"]);

export interface PolicyIntent {
  /**
   * Municipality named in the question; scopes an ORI search to its council
   * index. Not set when a national actor is the subject ("Wat doet het kabinet
   * voor de gemeente Groningen?").
   */
  gemeente?: string;
  /** The question concerns municipal councils, so ORI is a relevant source even without a named municipality. */
  municipal: boolean;
  /** What made the router treat this as an organisation/policy question. */
  signals: Array<"beleid" | "activiteit" | "organisatie" | "gemeente">;
  /**
   * "strong": a policy word, an activity question or the council itself; the
   * router searches documents before its national routes (Rijksoverheid, DUO).
   * "weak": only an organisation noun or a named municipality; the document
   * search is then a last resort before the catalogue, after every route that
   * a question word picked (Rijksbegroting for "uitgaven van de overheid").
   */
  strength: "strong" | "weak";
}

/**
 * Clean a captured place name and reject what is no municipality. The place
 * pattern lets infixes join capitalised words, so "de raad van Amsterdam van
 * het OV" captured "Amsterdam van het OV"; an acronym ends a place name.
 */
function cleanPlace(raw: string | undefined): string | undefined {
  const words = (raw ?? "").trim().replace(/[?.,;:!]+$/, "").split(/\s+/).filter(Boolean);
  if (!words.length || /^\p{Lu}{2,}$/u.test(words[0])) return undefined;
  let end = words.findIndex((w, i) => i > 0 && /^\p{Lu}{2,}$/u.test(w));
  if (end < 0) end = words.length;
  while (end > 1 && PLACE_INFIX_WORDS.has(words[end - 1].toLowerCase())) end--;
  const place = words.slice(0, end).join(" ");
  if (place.length < 3 || NOT_A_MUNICIPALITY.has(place.toLowerCase())) return undefined;
  return place;
}

/**
 * Organisation and policy questions ("Wat doet de Belastingdienst met de BTW?",
 * "GGZ-beleid gemeente Utrecht") have no dataset as answer: they are answered by
 * council documents (ORI), official publications, parliamentary papers and
 * government news. Without this the router sent them to the dataset catalogue,
 * which matched the whole sentence against dataset titles and found nothing.
 *
 * Returns undefined for questions without an organisation or policy signal, and
 * for data questions ("Welke gegevens heeft de gemeente over parkeren?") unless
 * they also carry a policy or activity signal. The router uses
 * {@link PolicyIntent.strength} to decide how early the document search runs,
 * and skips it for case-law and API questions.
 */
export function detectPolicyIntent(question: string): PolicyIntent | undefined {
  const raw = String(question ?? "").trim();
  if (!raw) return undefined;

  const policy = POLICY_RE.test(raw);
  const activity = ORGANISATION_ACTIVITY_RES.some((re) => re.test(raw));
  const organisation = ORGANISATION_RE.test(raw);
  const municipalityNounMatch = MUNICIPALITY_NOUN_RE.exec(raw);
  const municipalityNoun = Boolean(municipalityNounMatch);
  const gemeenteMatch = GEMEENTE_PLACE_ANY_CASE_RE.exec(raw);
  const governanceMatch = GOVERNANCE_PLACE_RE.exec(raw);
  const councilMatch = COUNCIL_RE.exec(raw);
  const governancePlace = cleanPlace(governanceMatch?.[1]);
  const council = Boolean(councilMatch) || Boolean(governancePlace);
  const strong = policy || activity || council;

  if (hasDataIntent(raw) && !strong) return undefined;

  // A national actor named before any municipal word is the subject: "Wat
  // doet het kabinet voor de gemeente Groningen?" and "Wat zegt de minister
  // over de gemeente Groningen?" ask what the cabinet or minister does or
  // says, which council records do not answer (searching Groningen's for
  // "kabinet" returned council papers, a national ORI search motions from
  // other councils). Such a question is no municipal one; the national
  // sources answer it. "Wat vindt de gemeenteraad van Utrecht van de plannen
  // van het kabinet?" keeps its council.
  const nationalIndex = NATIONAL_ACTOR_RE.exec(raw)?.index;
  const municipalIndex = Math.min(
    ...[municipalityNounMatch, gemeenteMatch, governanceMatch, councilMatch].map((m) => m?.index ?? Number.POSITIVE_INFINITY),
  );
  const nationalSubject = nationalIndex !== undefined && nationalIndex < municipalIndex;

  // A municipality to scope by: named as "gemeente X" / "de raad van X" when no
  // national actor is the subject, or "in X" when the question is about policy
  // or a municipality and no national actor appears at all.
  const named = nationalSubject ? undefined : (cleanPlace(gemeenteMatch?.[1]) ?? governancePlace);
  const inPlace = (strong || municipalityNoun) && nationalIndex === undefined ? cleanPlace(extractPlaceName(raw)) : undefined;
  const gemeente = named ?? inPlace;

  if (!strong && !organisation && !municipalityNoun && !gemeente) return undefined;

  const municipal = !nationalSubject && (council || municipalityNoun || Boolean(gemeente));
  const signals: PolicyIntent["signals"] = [];
  if (policy) signals.push("beleid");
  if (activity) signals.push("activiteit");
  if (organisation) signals.push("organisatie");
  if (municipal) signals.push("gemeente");

  return { ...(gemeente ? { gemeente } : {}), municipal, signals, strength: strong ? "strong" : "weak" };
}

/**
 * Questions longer than this get no DSO intent and keep the route they had
 * before the DSO route: real questions are far shorter, and the detector's
 * work stays bounded whatever nl_gov_ask is sent.
 */
const DEBAT_QUESTION_MAX_CHARS = 300;

export type DebatIntent = {
  /** Words in what was said: the topic after "over". */
  query?: string;
  /** Words in the debate subject: "stikstof" of "het stikstofdebat". */
  debat?: string;
  fractie?: string;
  spreker?: string;
};

/** Fracties as a question writes them, to the name in the verslagen. Upper case only where the name is a common word ("PRO", "SP"). */
const DEBAT_FRACTIES: Array<[RegExp, string]> = [
  [/\bVVD\b/, "VVD"], [/\bCDA\b/, "CDA"], [/\bPVV\b/, "PVV"], [/\bD66\b/i, "D66"], [/\bSP\b/, "SP"], [/\bPRO\b/, "PRO"],
  [/\bJA21\b/i, "JA21"], [/\bSGP\b/, "SGP"], [/\bDENK\b/, "DENK"], [/\bBBB\b/, "BBB"], [/\bFvD\b/, "FvD"], [/\bChristenUnie\b/i, "ChristenUnie"],
  [/\bGL-PvdA\b|\bGroenLinks-PvdA\b/i, "GroenLinks-PvdA"], [/\bPvdD\b|\bPartij voor de Dieren\b/i, "PvdD"], [/\bVolt\b/, "Volt"],
  [/\b50PLUS\b/i, "50PLUS"], [/\bNSC\b/, "NSC"], [/\bGroep Markuszower\b/i, "Groep Markuszower"],
];

/** Speaking, in the past or present: what someone said, argued or answered. */
const DEBAT_SPEECH = /\b(?:zei|zeiden|zegt|zeggen|gezegd|sprak|spraken|gesproken|uitspraak|uitspraken|inbreng|betoog|betoogde|beweerde|antwoordde|citaat|citaten)\b/;
/** "in het debat", "tijdens het commissiedebat", "in debatten". */
const DEBAT_IN = /\b(?:in|tijdens|uit|bij)\s+(?:het\s+|de\s+|een\s+)?\p{L}*debat(?:ten)?\b/u;
/** A debate word, alone or in a compound ("stikstofdebat", "commissiedebat"). */
const DEBAT_WORD = /(?<![\p{L}\p{N}])(\p{L}*?)debat(?:ten)?(?![\p{L}\p{N}])/u;
const DEBAT_KIND_PREFIXES = new Set(["", "kamer", "commissie", "plenair", "plenaire", "tweeminuten", "dertigleden", "begrotings", "wetgevings", "nota", "spoed", "interpellatie", "het"]);
/** Another body than the Tweede Kamer, or a question about the agenda, votes or moties: other routes. */
const DEBAT_OTHER = /\b(?:gemeenteraad|raadsvergadering|raadsleden|raadslid|provinciale staten|statenvergadering|statenleden|eerste kamer|senaat|europees parlement|waterschap|wanneer|agenda|gepland|stem(?:de|den|ming|mingen)|motie|moties|amendement|amendementen|aangenomen|verworpen)\b/;
const DEBAT_SPREKER_FUNCTIES: Array<[RegExp, string]> = [
  [/\b(?:premier|minister-president)\b/, "minister-president"],
  [/\bstaatssecretaris(?:sen)?\b/, "staatssecretaris"],
  [/\bminister(?:s)?\b/, "minister"],
  [/\b(?:kamer)?voorzitter\b/, "voorzitter"],
];

/**
 * A question about what was said in a Tweede Kamer debate, for
 * tweede_kamer_debatten. Precision first: it names a debate and asks what was
 * said ("Wat zei de VVD in het debat over stikstof?"), or asks what someone
 * said in the Kamer ("Wat heeft de minister in de Tweede Kamer gezegd over
 * Pallas?"), and gives a topic ("over …"), a debate ("het stikstofdebat"), a
 * fractie or a speaker. Never: a question about another body, the agenda, votes,
 * moties or amendementen, or one longer than DEBAT_QUESTION_MAX_CHARS.
 */
export function detectDebatIntent(question: string): DebatIntent | undefined {
  const text = String(question ?? "").trim();
  if (!text || text.length > DEBAT_QUESTION_MAX_CHARS) return undefined;
  const q = text.toLowerCase();
  if (DEBAT_OTHER.test(q)) return undefined;
  const debatWord = DEBAT_WORD.exec(q);
  const speech = DEBAT_SPEECH.test(q);
  const inKamer = /\b(?:in de (?:tweede )?kamer|in het parlement|kamerlid|kamerleden)\b/.test(q);
  if (!(debatWord && (speech || DEBAT_IN.test(q))) && !(speech && inKamer)) return undefined;

  const intent: DebatIntent = {};
  const fracties = DEBAT_FRACTIES.filter(([re]) => re.test(text)).map(([, name]) => name);
  if (fracties.length === 1) intent.fractie = fracties[0];
  const functie = DEBAT_SPREKER_FUNCTIES.find(([re]) => re.test(q));
  if (functie) intent.spreker = functie[1];
  if (!intent.spreker) {
    // "Wat zei Klaver …", "Wat heeft Van Campen gezegd …": a capitalised name after the verb.
    const name = /\b(?:zei|zegt|sprak|heeft|hebben|had)\s+((?:(?:van|de|der|den|ten|ter)\s+)*[A-Z][\p{L}'-]+(?:\s+(?:(?:van|de|der|den|ten|ter)\s+)*[A-Z][\p{L}'-]+)?)/u.exec(text);
    const candidate = name?.[1];
    if (candidate && !DEBAT_FRACTIES.some(([re]) => re.test(candidate)) && !/^(?:De|Het|Een|Er|Ik|Je|U|Wij|We|Zij|Ze|Tweede|Kamer)\b/.test(candidate)) {
      intent.spreker = candidate;
    }
  }
  const prefix = debatWord?.[1] ?? "";
  if (prefix.length >= 4 && !DEBAT_KIND_PREFIXES.has(prefix)) intent.debat = prefix;

  // The topic: what follows "over", up to where the question goes on about the debate, the Kamer or the time.
  const over = /\bover\s+(.+?)(?=\s+(?:in|tijdens|bij|gezegd|gesproken|vorige|afgelopen|deze|dit|vandaag|gisteren|eergisteren)\b|[?.!]|$)/u.exec(text);
  if (over) {
    const topic = parseTkQuery(over[1].replace(/\b(?:het|de|een)\s+\p{L}*debat(?:ten)?\b/giu, " ")).terms
      .map((t) => (t.mode === "word" && /\s/.test(t.text) ? `"${t.text}"` : t.text))
      .join(" ");
    if (topic) intent.query = topic;
  }
  return intent.query || intent.debat || intent.fractie || intent.spreker ? intent : undefined;
}

const ALGORITME_QUESTION_MAX_CHARS = 300;

export type AlgoritmeIntent = {
  organisatie?: string;
  query?: string;
  publicatiecategorie?: "Hoog-risico AI-systeem";
};

const ALGORITME_WORD = /\b(?:algoritmes?|algoritmen|algoritmeregister|ai-systemen|ai-systeem)\b/;
/** Documents about algorithms (council papers, Kamerstukken, reports, rulings) are other routes. */
const ALGORITME_OTHER = /\b(?:raad|gemeenteraad|raadsvoorstel\w*|raadsvragen|raadsinformatiebrief\w*|motie\w*|amendement\w*|kamervra\w*|kamerbrie\w*|kamerstuk\w*|\w*debat\w*|rekenkamer\w*|rapport\w*|onderzoek\w*|wetsvoorstel\w*|nieuws|uitspra\w*|rechter\w*|vonnis\w*|toezicht\w*|wet|wetten|wetgeving|regels|eisen|verordening|ai act)\b/;
const ALGORITME_BODIES = /\b(?:gemeente|provincie|waterschap|hoogheemraadschap)\s+((?:'s-)?[A-Z][\p{L}'.-]*(?:[\s-]+(?:aan|den|de|op|van|[A-Z][\p{L}'.-]*))*)/u;
const ALGORITME_MINISTERIE = /\b[Mm]inisterie\s+van\s+([A-Z][\p{L}'.-]*(?:\s+(?:en|van|[A-Z][\p{L}'.-]*))*)/u;
const ALGORITME_AGENCIES = /\b(UWV|DUO|SVB|CJIB|RDW|IND|CBS|RIVM|Belastingdienst|Dienst Toeslagen|Rijkswaterstaat|Kadaster|Politie|Nationale Politie|Rechtspraak|Kamer van Koophandel)\b/;

/**
 * A question about the algorithms a government body uses or has registered,
 * for the Algoritmeregister ("Welke algoritmes gebruikt de gemeente
 * Amsterdam?", "Welke hoog-risico AI-systemen gebruikt het UWV?"). Precision
 * first: it names algorithms or AI systems and an organisation, a topic ("voor
 * fraudedetectie") or high-risk AI. Never: a question about documents on
 * algorithms (council papers, Kamerstukken, reports, rulings) or about the law
 * on them, which other routes answer.
 */
export function detectAlgoritmeIntent(question: string): AlgoritmeIntent | undefined {
  const text = String(question ?? "").trim();
  if (!text || text.length > ALGORITME_QUESTION_MAX_CHARS) return undefined;
  const q = text.toLowerCase();
  if (!ALGORITME_WORD.test(q) || ALGORITME_OTHER.test(q)) return undefined;
  const intent: AlgoritmeIntent = {};
  const body = ALGORITME_BODIES.exec(text);
  const ministerie = ALGORITME_MINISTERIE.exec(text);
  const agency = ALGORITME_AGENCIES.exec(text);
  if (body) intent.organisatie = `${body[0].split(/\s+/)[0].toLowerCase()} ${body[1].replace(/\s+(?:aan|den|de|op|van)$/, "")}`;
  else if (ministerie) intent.organisatie = `Ministerie van ${ministerie[1].replace(/\s+(?:en|van)$/, "")}`;
  else if (agency) intent.organisatie = agency[1];
  if (/\bhoog[- ]?risico\b/.test(q)) intent.publicatiecategorie = "Hoog-risico AI-systeem";
  const topic = /\b(?:voor|bij het|bij de|om)\s+(.+?)[?.!]*$/u.exec(text);
  if (topic && !(intent.organisatie && topic[1].includes(intent.organisatie.split(" ").pop() ?? ""))) {
    // "voor vergunningverlening in Utrecht": the place is no topic word.
    const words = parseTkQuery(topic[1].replace(/\s+in\s+(?:'s-)?[A-Z][\p{L}'.-]*.*$/u, "")).terms.map((t) => t.text).join(" ");
    if (words) intent.query = words;
  }
  return intent.organisatie || intent.query || intent.publicatiecategorie ? intent : undefined;
}

const DSO_QUESTION_MAX_CHARS = 500;

/** The Omgevingswet documents the DSO holds, as a question names them. */
const DSO_DOCUMENT_NOUNS = [
  "omgevingsplan(?:nen)?",
  "omgevingsvisies?",
  "omgevingsverordening(?:en)?",
  "waterschapsverordening(?:en)?",
  "omgevingsprogramma(?:'s|s)?",
  "omgevingsdocument(?:en)?",
  "voorbereidingsbesluit(?:en)?",
  "voorbeschermingsregels?",
  "projectbesluit(?:en)?",
  "ontwerpregeling(?:en)?",
];
const DSO_DOCUMENT_WORDS_RE = new RegExp(`(?:^|[^\\p{L}])(?:${DSO_DOCUMENT_NOUNS.join("|")})(?=$|[^\\p{L}])|regels\\s+op\\s+de\\s+kaart`, "iu");
/** One document word as a lowercase token (the apostrophe of "programma's" splits it off). */
const DSO_DOCUMENT_TOKEN_RE = new RegExp(`^(?:${DSO_DOCUMENT_NOUNS.join("|")}|novi)$`, "u");
/** The document words with a case-free first letter only, for patterns whose PLACE_CORE needs its capitals. */
const DSO_DOCUMENT_NOUNS_CASED = DSO_DOCUMENT_NOUNS.map((n) => `[${n[0].toUpperCase()}${n[0]}]${n.slice(1)}`).join("|");
/** "de NOVI", the Nationale Omgevingsvisie: in capitals only. */
const DSO_NOVI_RE = /(?:^|[^\p{L}])NOVI(?=$|[^\p{L}])/u;
/** A document word in the plural: the question asks for every such document. */
const DSO_PLURAL_DOCUMENT_RE = /(?:^|[^\p{L}])(?:omgevingsplannen|omgevingsvisies|omgevingsverordeningen|waterschapsverordeningen|omgevingsprogramma(?:'s|s)|omgevingsdocumenten|voorbereidingsbesluiten|voorbeschermingsregels|projectbesluiten|ontwerpregelingen|ontwerpen)(?=$|[^\p{L}])/iu;
/** Words that ask for a list, which a document word without a place may get. */
const DSO_LIST_RE = /(?:^|[^\p{L}])(?:welke|hoeveel|alle|lijst|overzicht|toon|geef|noem|which|list|zijn\s+er|bestaan)(?=$|[^\p{L}])/iu;

/**
 * Qualifiers that keep a question on the documents: "onder de Omgevingswet"
 * names the regime, not the law's text, and "beroep aan huis" is no appeal.
 * Masked before the checks below.
 */
const DSO_NEUTRAL_PHRASE_RE = /(?:^|[^\p{L}])(?:onder\s+de\s+(?:nieuwe\s+)?omgevingswet|beroep\s+aan\s+huis|aan[\s-]huis[\s-]gebonden\s+beroep(?:en)?)(?=$|[^\p{L}])/giu;
/**
 * Words that give a question another route, also next to a document word:
 * the council, Staten, parliament or government as the subject, opinions,
 * other sources and their documents, money, procedures and participation,
 * and the law or a concept rather than a document. Lowercase whole words;
 * DSO_OTHER_ROUTE_WORD_RE has the word families.
 */
const DSO_OTHER_ROUTE_WORDS = new Set([
  "kabinet", "regering", "premier", "stemde", "stemden", "stemt", "besprak", "bespraken", "bespreekt", "bespreken", "besproken",
  "besloot", "besloten", "beslist", "woo", "wob", "vng", "ipo", "iplo", "bzk",
  "vindt", "vond", "vonden", "denkt", "denken", "dacht", "dachten", "zei", "zeiden", "mening", "standpunt", "reageert", "reageerde", "kritiek", "oordeel", "oordeelt", "adviseert", "adviseerde",
  "rechtspraak", "gesanctioneerd", "gegund", "inkoop", "procurement", "cbs", "cijfers", "rijksoverheid", "nieuws", "toespraak",
  "api", "apis", "apv", "eu", "europese", "europa", "notitie", "onderzoek", "keur", "legger",
  "kost", "kosten", "kostte", "kostten", "gekost", "geld", "begroot", "budget", "uitgaven", "woz", "planning",
  "inwoners", "wetten", "wetgeving", "omgevingsregeling", "bkl", "bal", "bbl", "amvb", "amvbs", "prijs", "prijzen", "vragen", "vraag", "aangenomen", "verworpen",
  "definitie", "betekenis", "betekent", "betekenen", "verschil", "verschillen", "waarom", "why", "wie", "who", "bindend", "moet", "moeten", "bewoners",
]);
/** Word families with the same effect: prefixes, compounds of another document type, permits, the law. */
const DSO_OTHER_ROUTE_WORD_RE = new RegExp(
  "^(?:raads|college|staten|gedeputeerde|wethouder|burgemeester|kamer|parlement|minister|staatssecretaris|fractie|motie|amendement|stemming|agenda|commissie|rekenkamer|ombudsman|vacature|klacht|persbericht|persconferentie|nieuwsbericht" +
    "|bekendmaking|publicatie|uitspra|rechter|rechtbank|rechtszaak|rechtszaken|gerechtshof|bestuursrecht|beroep|bezwaar|jurisprudentie|ecli|vonnis|arrest|tucht|handhav|boete|sanctie|overtreding|beschikking|dwangsom" +
    "|aanbesteding|tender|gunning|marktconsultatie|offerteaanvra|overheidsopdracht|statistiek|dataset|databestand|algoritme|bestemmingsplan|structuurvisie|beleidsregel" +
    "|jaarrekening|financ|investe|belasting|heffing|tarie|leges|inspraak|zienswijze|evaluat|aanvra|melding|invoering|inwerkingtreding|implementatie|overgang|ambtena|medewerker" +
    "|wets|wettelijk|wettekst|instructieregel|juridisch|verplicht|advie|reactie|politie|partij|verkiezing|griffie|commissaris|protest|petitie|referendum" +
    "|bijeenkomst|webinar|cursus|training|opleiding|software|leverancier|applicatie|systeem|storing|omgevingsdienst|staalkaart|modelregel|handreiking" +
    "|informatiepunt|uitleg|voorbeeld|vergelijk|geschiedenis|historie|voortgang|monitor|antwoord|beantwoord|besluitvorming|vaststelling|ingediend" +
    "|toezicht|inspectie|rapport)" +
    "|(?:raad|raden|blad|courant|nota|brief|brieven|avond|wet)$" +
    "|debat|vergader|begroting|subsidie|participatie|vergunning(?!s?vrij|s?plichtig)" +
    "|(?<!omgevings)(?<!waterschaps)verordening(?:en)?$|(?<!voorbereidings)(?<!project)besluit(?:en)?$|(?<!omgevings)programma$|(?<!omgevings)visies?$|(?<!omgevings)plan(?:nen)?$|.(?<!omgevings)document(?:en)?$",
  "u",
);
/** Phrases with the same effect: parliament, data, definitions and how-it-works questions. */
const DSO_OTHER_ROUTE_PHRASE_RE = /(?:^|[^\p{L}])(?:open\s+data|data\s+over|dagelijks\s+bestuur|algemeen\s+bestuur|stand\s+van\s+zaken|b\s*(?:&|en)\s*w|sinds\s+wanneer|in\s+werking\s+(?:getreden|treedt|trad|traden|treden)|wat\s+(?:is|zijn)\s+(?:een|eigenlijk)|wat\s+houdt|wat\s+(?:vind|vindt|vinden|vond|vonden)|wie\s+(?:stelt|stellen|maakt|maken|beslist|beslissen|bepaalt|bepalen|neemt|nemen)|what\s+is\s+an?|how\s+(?:does|do|is|are))(?=$|[^\p{L}])/u;
/** Abbreviations in capitals: Provinciale and Gedeputeerde Staten, associations, agencies. */
const DSO_OTHER_ROUTE_ACRONYM_RE = /(?:^|[^\p{L}])(?:PS|GS|VNG|IPO|IPLO|BZK|RCE|ILT|PBL)(?=$|[^\p{L}])/u;
/** Verbs whose subject must be the document: "Wat zegt het omgevingsplan", not "Wat zegt de VNG over het omgevingsplan". */
const DSO_DOCUMENT_SUBJECT_VERBS = new Set(["zegt", "zeggen", "regelt", "regelen", "schrijft", "schreef", "stelt", "stelde", "doet", "deed", "gaat", "ging", "meldt", "meldde"]);
const DSO_ARTICLES = new Set(["de", "het", "een", "dit", "deze", "dat", "die", "the"]);
/** "Hoe hoog mag ik bouwen" asks for rules; any other "hoe" asks how something works or went. */
const DSO_HOW_RULES = new Set(["hoog", "hoger", "groot", "groter", "diep", "dieper", "breed", "breder", "ver", "verder", "dicht", "high", "big", "tall", "far", "deep", "wide"]);

/** The question's words in lowercase, letters only. */
function dsoWords(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
}

/** Whether a question belongs to another route (see the word lists above). */
function dsoOtherRoute(text: string): boolean {
  if (DSO_OTHER_ROUTE_ACRONYM_RE.test(text) || COUNCIL_RE.test(text) || DSO_OTHER_ROUTE_PHRASE_RE.test(text.toLowerCase())) return true;
  const words = dsoWords(text);
  const documentFollows = (i: number) => {
    const j = DSO_ARTICLES.has(words[i] ?? "") ? i + 1 : i;
    return DSO_DOCUMENT_TOKEN_RE.test(words[j] ?? "") || DSO_DOCUMENT_TOKEN_RE.test(words[j + 1] ?? "");
  };
  return words.some(
    (w, i) =>
      DSO_OTHER_ROUTE_WORDS.has(w) ||
      DSO_OTHER_ROUTE_WORD_RE.test(w) ||
      ((w === "hoe" || w === "how") && !DSO_HOW_RULES.has(words[i + 1] ?? "")) ||
      (DSO_DOCUMENT_SUBJECT_VERBS.has(w) && !documentFollows(i + 1)),
  );
}

/** documentType per word, for a question that names exactly one kind of document. */
const DSO_TYPE_WORDS: Array<[RegExp, DsoDocumentType]> = [
  [/(?:^|[^\p{L}])omgevingsplan(?:nen)?(?=$|[^\p{L}])/iu, "omgevingsplan"],
  [/(?:^|[^\p{L}])omgevingsvisies?(?=$|[^\p{L}])/iu, "omgevingsvisie"],
  [DSO_NOVI_RE, "omgevingsvisie"],
  [/(?:^|[^\p{L}])omgevingsverordening(?:en)?(?=$|[^\p{L}])/iu, "omgevingsverordening"],
  [/(?:^|[^\p{L}])(?:waterschapsverordening(?:en)?|waterschapsregels)(?=$|[^\p{L}])/iu, "waterschapsverordening"],
  [/(?:^|[^\p{L}])omgevingsprogramma(?:'s|s)?(?=$|[^\p{L}])/iu, "programma"],
  [/(?:^|[^\p{L}])(?:voorbereidingsbesluit(?:en)?|voorbeschermingsregels?)(?=$|[^\p{L}])/iu, "voorbereidingsbesluit"],
  [/(?:^|[^\p{L}])projectbesluit(?:en)?(?=$|[^\p{L}])/iu, "projectbesluit"],
];

const DUTCH_MONTHS: Record<string, number> = {
  januari: 1, jan: 1, februari: 2, feb: 2, maart: 3, mrt: 3, april: 4, apr: 4, mei: 5, juni: 6, jun: 6, juli: 7, jul: 7,
  augustus: 8, aug: 8, september: 9, sep: 9, sept: 9, oktober: 10, okt: 10, november: 11, nov: 11, december: 12, dec: 12,
};

const DSO_STREET_SUFFIXES = "straat|straatweg|laan|weg|plein|gracht|burgwal|kade|singel|baan|dijk|dreef|hof|pad|steeg|markt|park|plantsoen|ring|wal|haven|veld|dam|allee|boulevard|kanaal|erf|zijde|brink|oord|kwartier|plaats";
const DSO_STREET_SUFFIX_RE = new RegExp(`(?:${DSO_STREET_SUFFIXES})$`, "u");
const DSO_STREET_SUFFIX_WORD_RE = new RegExp(`^(?:${DSO_STREET_SUFFIXES})$`, "u");
/** Lowercase words inside a street name: "Van Asch van Wijckstraat", "Weg der Verenigde Naties". */
const DSO_STREET_INFIXES = "van|de|der|den|des|het|['’]t|ter|ten|en";
const DSO_STREET_INFIX_RE = new RegExp(`^(?:${DSO_STREET_INFIXES})$`, "u");
/** Place names that end like a street ("Amsterdam 31 december" is no address). */
const DSO_PLACES_LIKE_STREETS = new Set(["amsterdam", "rotterdam", "schiedam", "zaandam", "edam", "volendam", "monnickendam", "alblasserdam", "leidschendam", "veendam", "moerdijk", "langedijk", "stadskanaal", "barneveld", "westerveld", "noordenveld"]);
/** A house number, but no year: "Omgevingsvisie Amsterdam 2050" and "invoering 2024" are no address. */
const DSO_HOUSE_NUMBER = "(?!(?:19|20)\\d\\d(?![\\d\\p{L}]))\\d{1,5}(?:\\s?[a-zA-Z](?![\\p{L}])|-[\\dA-Za-z]{1,4}(?![\\p{L}\\d]))?";
/**
 * Capitalised words (an ordinal like "1e" or "Tweede" and infixes allowed),
 * then a house number, after a word that introduces an address ("op", "aan",
 * "bij", "voor", "adres") or at the very start. Every other start needs that
 * word and a space, so a long run of name characters is scanned once.
 */
const DSO_ADDRESS_RE = new RegExp(
  `(?:^|[^\\p{L}](?:op|aan|bij|voor|nabij|rond(?:om)?|adres|at)\\s+(?:(?:de|het)\\s+)?)` +
    `((?:(?:\\d{1,2}(?:e|de|ste)|Eerste|Tweede|Derde|Vierde)\\s+)?(?:['’]s-|['’]t\\s+)?[A-ZÀ-Þ][\\p{L}'’.-]*(?:\\s+(?:(?:${DSO_STREET_INFIXES})\\s+)*(?:['’]s-)?[A-ZÀ-Þ][\\p{L}'’.-]*){0,4})` +
    `\\s+(${DSO_HOUSE_NUMBER})(?![\\p{L}\\d])`,
  "dgu",
);
/** Words that open an address phrase at the start of a question ("Op Brennerbaan 150"), not the street. */
const DSO_ADDRESS_LEAD_WORDS = new Set(["op", "aan", "bij", "voor", "nabij", "rond", "rondom", "adres"]);
/** Capitalised words before a number that name no street ("voor Box 3", "op Schiphol Terminal 3"). */
const DSO_NOT_A_STREET = new Set([
  "artikel", "hoofdstuk", "afdeling", "paragraaf", "bijlage", "lid", "natura", "box", "groep", "fase", "categorie", "formule", "euro", "covid", "windkracht",
  "terminal", "rijksmonument", "monument", "sectie", "code", "klasse", "niveau", "zone", "gate", "pier", "versie", "week", "dag", "jaar", "nummer",
]);
/** A number followed by these is a day, a unit or a duration, not a house number. */
const DSO_NOT_AFTER_HOUSE_NUMBER = new Set([
  ...Object.keys(DUTCH_MONTHS),
  "uur", "uren", "minuut", "minuten", "dag", "dagen", "week", "weken", "maand", "maanden", "jaar", "jaren", "meter", "m", "km", "cm", "mm",
  "kilo", "kg", "gram", "ton", "liter", "procent", "euro", "mw", "kw", "kwh", "gw", "db", "graden", "keer", "stuks", "personen", "mensen",
]);
/** A Dutch postcode, letters in capitals ("2026 de" is no postcode). */
const DSO_POSTCODE_RE = /(?:^|[^\p{L}\d])([1-9]\d{3})\s?(?!SA|SD|SS)([A-Z]{2})(?![\p{L}\d])/dgu;
/** Two capitals after a number that are a unit or a country, not postcode letters ("1000 MW", "3500 KG"). */
const DSO_POSTCODE_UNITS = new Set(["MW", "KW", "KG", "GW", "GB", "MB", "TB", "KB", "PJ", "TJ", "GJ", "MJ", "KV", "KM", "CM", "MM", "HA", "PK", "CC", "ML", "CL", "DL", "MG", "KJ", "EU", "NL", "US", "UK", "VS"]);
/** What may stand right before a postcode for it to be one: "op 3524 BN", "postcode 3524 BN", "adres: 3524 BN". */
const DSO_BEFORE_POSTCODE_RE = /(?:^|[^\p{L}])(?:op|aan|bij|voor|nabij|postcode|adres|at)\s*:?\s*$|,\s*$/iu;
const DSO_POSTCODE_AFTER_RE = /\s*,?\s*([1-9]\d{3})\s?(?!SA|SD|SS)([A-Z]{2})(?![\p{L}\d])/uy;
const DSO_NUMBER_AFTER_RE = /\s*,?\s*(\d{1,5}(?:\s?[a-zA-Z](?![\p{L}]))?)(?![\p{L}\d])/uy;
/** The place written behind an address: ", Utrecht", " te Utrecht", " in (de gemeente) Utrecht", " (Utrecht)", " Utrecht". */
const DSO_PLACE_AFTER_RE = new RegExp(`(?:\\s*,\\s*|\\s+te\\s+|\\s+in\\s+(?:de\\s+gemeente\\s+)?|\\s*\\(\\s*|\\s+)(${PLACE_CORE})`, "uy");

/** "provincie Utrecht", "Hoogheemraadschap De Stichtse Rijnlanden", "gemeente Utrecht". */
const DSO_BODY_RE = new RegExp(`(?:^|[^\\p{L}])((?:[Gg]emeente|[Pp]rovincie|[Ww]aterschap|[Hh]oogheemraadschap(?:\\s+van)?|[Ww]etterskip)\\s+${PLACE_CORE})`, "du");
/** "province of Utrecht", "municipality of Ede". */
const DSO_ENGLISH_BODY_RE = new RegExp(`(?:^|[^\\p{L}])([Pp]rovince|[Mm]unicipality)\\s+of\\s+(?:the\\s+)?(${PLACE_CORE})`, "du");
/** "in de provincie Utrecht", "in the province of Utrecht": an area, not the provincie as the body that adopts. */
const DSO_PROVINCE_AREA_RE = new RegExp(`(?:^|[^\\p{L}])(?:in|binnen)\\s+(?:de\\s+|the\\s+)?(?:[Pp]rovincie|[Pp]rovince\\s+of)\\s+(${PLACE_CORE})`, "du");
const DSO_IN_PLACE_RE = new RegExp(`(?:^|[^\\p{L}])in\\s+(${PLACE_CORE})`, "du");
/**
 * The place right after a document word: "omgevingsplan Utrecht", "Omgevingsvisie
 * van Amsterdam", "the omgevingsplan of Groningen", "het omgevingsplan voor Utrecht".
 */
const DSO_DOCUMENT_PLACE_RE = new RegExp(`(?:^|[^\\p{L}])(?:${DSO_DOCUMENT_NOUNS_CASED})\\s+(?:([Vv]an|[Vv]oor|of|for)\\s+(?:de\\s+|het\\s+|the\\s+)?)?(${PLACE_CORE})`, "du");
/** The place before the document word: "Utrecht omgevingsplan" at the start, "the Utrecht omgevingsplan". */
const DSO_PLACE_DOCUMENT_RE = new RegExp(`(?:^|[^\\p{L}]the\\s+)(${PLACE_CORE})\\s+(?:${DSO_DOCUMENT_NOUNS_CASED})(?=$|[^\\p{L}])`, "du");
/** "heeft Utrecht", "geldt voor Rotterdam", "gelden er voor Ede". */
const DSO_VERB_PLACE_RE = new RegExp(`(?:^|[^\\p{L}])(?:[Hh]eeft|[Hh]ebben|geldt|gelden|gold|golden)\\s+(?:er\\s+)?(?:voor\\s+)?(${PLACE_CORE})`, "du");
/** "in het centrum van Utrecht": any "van <Place>", the last resort. */
const DSO_OF_PLACE_RE = new RegExp(`(?:^|[^\\p{L}])van\\s+(?:de\\s+|het\\s+)?(${PLACE_CORE})`, "du");
/** "Welke omgevingsplannen gelden er op Schiphol?": a place without a number, as a point. */
const DSO_AT_PLACE_RE = new RegExp(`(?:^|[^\\p{L}])op\\s+(${PLACE_CORE})\\s*[?.!]?\\s*$`, "du");
/** A place in a question typed in lowercase: after "gemeente", "provincie", "van", "in" or a document word. */
const DSO_LOWER_PLACE = "(?:(?:den|['’]s-|['’]t)\\s*)?\\p{Ll}[\\p{Ll}'’-]+(?:\\s+(?:aan|op|bij|en)\\s+\\p{Ll}[\\p{Ll}'’-]+)?";
const DSO_LOWER_BODY_RE = new RegExp(`(?:^|[^\\p{L}])(gemeente|provincie|waterschap)\\s+(${DSO_LOWER_PLACE})`, "du");
const DSO_LOWER_PLACE_RE = new RegExp(`(?:^|[^\\p{L}])(?:(?:${DSO_DOCUMENT_NOUNS_CASED})\\s+(?:van\\s+|of\\s+)?|in\\s+)(${DSO_LOWER_PLACE})(?=\\s*(?:[?.!,]|over\\b|voor\\b|\\d|$))`, "du");
/** Lowercase words that are no place after those cues. */
const DSO_LOWER_NOT_A_PLACE = new Set([
  "de", "het", "een", "die", "dat", "deze", "dit", "mijn", "onze", "uw", "alle", "elke", "welke", "wat", "regels", "regel", "over", "voor", "met", "zonder",
  "heel", "nationale", "rijk", "nu", "er", "hier", "daar", "toepassing", "werking", "kracht", "inzage", "ontwerp", "ontwerpen", "gemeente", "provincie",
  "waterschap", "buurt", "wijk", "centrum", "stad", "dorp", "totaal", "principe", "feite", "gebruik", "voorbereiding", "ontwikkeling", "belang", "geval",
  "kaart", "praktijk", "algemeen", "wijzigen", "gewijzigd", "vastgesteld", "zien", "vinden", "bouwen",
]);
/** Words that open a question or describe a document: no place, also when capitalised before a document word. */
const DSO_NOT_A_PLACE_START = new Set([
  "welke", "welk", "wat", "wie", "waar", "wanneer", "hoe", "hoeveel", "is", "zijn", "heeft", "hebben", "toon", "geef", "laat", "lees", "zoek", "mag", "kan",
  "geldt", "gelden", "ligt", "liggen", "wordt", "de", "het", "een", "nieuwste", "nieuwe", "recente", "recentste", "laatste", "alle", "nationale", "ontwerp",
  "ontwerpen", "gemeentelijke", "provinciale", "huidige", "oude", "geldende", "actuele", "vigerende", "which", "what", "show", "the", "all", "list", "mijn",
  "onze", "uw", "dit", "deze", "die", "elk", "elke",
]);
/** Words a place name cannot hold: it ends before them ("provincie Gelderland de Omgevingswet"). */
const DSO_NOT_A_PLACE_WORD_RE = new RegExp(`^(?:\\p{L}*wet|${DSO_DOCUMENT_NOUNS.join("|")}|raad|staten|kamer|regels?|artikel|hoofdstuk|afdeling|paragraaf|bijlage|novi|dso)$`, "iu");
/** English names of places the DSO knows in Dutch. */
const DSO_ENGLISH_PLACES: Record<string, string> = { "north holland": "Noord-Holland", "south holland": "Zuid-Holland", "north brabant": "Noord-Brabant", "the hague": "Den Haag", frisia: "Fryslân" };
/** Provincie names no gemeente shares: "in Noord-Holland" is an area like "in de provincie Noord-Holland". */
const DSO_PROVINCES = new Set(["noord-holland", "zuid-holland", "noord-brabant", "brabant", "gelderland", "overijssel", "drenthe", "friesland", "fryslân", "flevoland", "limburg", "zeeland"]);
/** Capitalised words that name no place: an unscoped list question with any other capitalised word is not answered nationwide. */
const DSO_NOT_A_PLACE_CAPITAL = new RegExp(`^(?:${DSO_DOCUMENT_NOUNS.join("|")}|novi|dso|rijk|nationale|nederland|europa|regels|kaart|omgevingswet|ontwerp\\p{L}*)$`, "iu");

/** A body or place the question names ("gemeente Utrecht", "Utrecht"), and where it stands in the question. */
interface DsoPlaceHit {
  name: string;
  start: number;
  end: number;
}

/** A place cut where it runs on into the question ("Gelderland de Omgevingswet"), English names in Dutch, no country. */
function dsoPlace(captured: string | undefined, start: number): DsoPlaceHit | undefined {
  const words = (captured ?? "").replace(/[?.,;:!)]+$/, "").split(/\s+/).filter(Boolean);
  if (!words.length || DSO_NOT_A_PLACE_WORD_RE.test(words[0])) return undefined;
  let end = words.findIndex((w, i) => i > 0 && DSO_NOT_A_PLACE_WORD_RE.test(w));
  if (end < 0) end = words.length;
  while (end > 1 && PLACE_INFIX_WORDS.has(words[end - 1].toLowerCase())) end--;
  const place = words.slice(0, end).join(" ");
  if (place.length < 2 || /^(?:nederland|europa|eu|(?:the\s+)?netherlands)$/i.test(place)) return undefined;
  return { name: DSO_ENGLISH_PLACES[place.toLowerCase()] ?? place, start, end: start + place.length };
}

/** The place in a pattern's capture group (the pattern has the "d" flag). */
function dsoPlaceIn(re: RegExp, text: string, group = 1): DsoPlaceHit | undefined {
  const m = re.exec(text);
  return m?.[group] && m.indices?.[group] ? dsoPlace(m[group], m.indices[group][0]) : undefined;
}

/** A place in a lowercase question, unless it is a common word after the same cue ("in werking", "van toepassing"). */
function dsoLowerPlaceIn(re: RegExp, text: string, group: number): DsoPlaceHit | undefined {
  const hit = dsoPlaceIn(re, text, group);
  return hit && !hit.name.split(/\s+/).some((w) => DSO_LOWER_NOT_A_PLACE.has(w)) ? hit : undefined;
}

/** Replace a span by "§", so the checks after it neither read it nor join words across it. */
function dsoMask(text: string, hit: { start: number; end: number } | undefined): string {
  return hit ? text.slice(0, hit.start) + "§".repeat(Math.max(0, hit.end - hit.start)) + text.slice(hit.end) : text;
}

interface DsoAddressHit {
  /** As the search's locatie takes it: "Brennerbaan 150, Utrecht", "3524 BN 150". */
  locatie: string;
  /** A street with a street ending, or with a postcode, or a postcode; else only capitalised words before a number. */
  strict: boolean;
  /** A place or postcode is written behind it. */
  hasPlace: boolean;
  start: number;
  end: number;
}

/** The postcode, or the place, written behind an address that ends at `end`. */
function dsoAfterAddress(text: string, end: number): { place?: string; postcode?: string; end: number } {
  DSO_POSTCODE_AFTER_RE.lastIndex = end;
  const pc = DSO_POSTCODE_AFTER_RE.exec(text);
  const postcode = pc && !DSO_POSTCODE_UNITS.has(pc[2]) ? `${pc[1]} ${pc[2]}` : undefined;
  if (postcode) end = DSO_POSTCODE_AFTER_RE.lastIndex;
  DSO_PLACE_AFTER_RE.lastIndex = end;
  const m = DSO_PLACE_AFTER_RE.exec(text);
  const place = m ? dsoPlace(m[1], DSO_PLACE_AFTER_RE.lastIndex - m[1].length) : undefined;
  return { postcode, place: place?.name, end: place?.end ?? end };
}

/**
 * The address a question names: a street that ends like one ("Brennerbaan",
 * "Grote Markt", "Laan van Meerdervoort") with a house number, or a postcode
 * after "op", "postcode" or "adres", each with the place or postcode written
 * behind it. Without a street suffix only capitalised words and a number
 * with a place behind them, which counts only next to a document word.
 */
function dsoAddress(text: string): DsoAddressHit | undefined {
  let lenient: DsoAddressHit | undefined;
  for (const m of text.matchAll(DSO_ADDRESS_RE)) {
    let [start] = m.indices![1];
    const numberEnd = m.indices![2][1];
    const words = m[1].split(/\s+/);
    // "Op Brennerbaan 150" at the start: the word opens the address, it is no part of the street.
    const led = words.length > 1 && DSO_ADDRESS_LEAD_WORDS.has(words[0].toLowerCase());
    if (led) start += words.shift()!.length + 1;
    const next = /^\s*([\p{L}%]+)/u.exec(text.slice(numberEnd, numberEnd + 24))?.[1]?.toLowerCase();
    if (next && DSO_NOT_AFTER_HOUSE_NUMBER.has(next)) continue;
    const head = words.find((w) => /^\p{Lu}/u.test(w) && !/^(?:Eerste|Tweede|Derde|Vierde)$/.test(w))?.toLowerCase() ?? "";
    if (DSO_NOT_A_STREET.has(head)) continue;
    const after = dsoAfterAddress(text, numberEnd);
    const hit: DsoAddressHit = {
      locatie: [`${words.join(" ")} ${m[2]}`, after.postcode ?? after.place].filter(Boolean).join(", "),
      strict: dsoStrictStreet(words) || Boolean(after.postcode),
      hasPlace: Boolean(after.postcode ?? after.place),
      start,
      end: after.end,
    };
    if (hit.strict) return hit;
    // Without a street ending: after "op", "voor" and the like, and with a place behind it.
    if (!lenient && after.place && (m.indices![1][0] > 0 || led)) lenient = hit;
  }
  for (const m of text.matchAll(DSO_POSTCODE_RE)) {
    if (DSO_POSTCODE_UNITS.has(m[2])) continue;
    const [start, end] = [m.indices![1][0], m.indices![2][1]];
    DSO_NUMBER_AFTER_RE.lastIndex = end;
    const number = DSO_NUMBER_AFTER_RE.exec(text);
    if (!number && !DSO_BEFORE_POSTCODE_RE.test(text.slice(Math.max(0, start - 12), start))) continue;
    const after = dsoAfterAddress(text, number ? DSO_NUMBER_AFTER_RE.lastIndex : end);
    return { locatie: [`${m[1]} ${m[2]}`, number?.[1]].filter(Boolean).join(" "), strict: true, hasPlace: true, start, end: after.end };
  }
  return lenient;
}

/**
 * A street name: its last word ends like a street and is more than the
 * ending ("Brennerbaan", "'s-Gravendijkwal"); or the bare ending after
 * another capitalised word ("Grote Markt"); or a street word opening the
 * name ("Laan van Meerdervoort", "Weg der Verenigde Naties"). Not "Ring 10",
 * "de Dam 4 mei" or "Amsterdam 31".
 */
function dsoStrictStreet(words: string[]): boolean {
  const named = words.filter((w) => !/^\d/.test(w));
  const capitals = named.filter((w) => /^(?:\p{Lu}|['’]s-)/u.test(w)).length;
  const last = (named[named.length - 1] ?? "").toLowerCase().replace(/^['’]s-/, "");
  const suffix = DSO_STREET_SUFFIX_RE.exec(last)?.[0];
  if (suffix) return last.length > suffix.length ? !DSO_PLACES_LIKE_STREETS.has(last) : capitals >= 2;
  return named.length >= 3 && DSO_STREET_SUFFIX_WORD_RE.test(named[0].toLowerCase()) && DSO_STREET_INFIX_RE.test(named[1]);
}

/** The question's words outside the masked spans, all from the given sets. */
function dsoOnlyWords(text: string, ...allowed: ReadonlySet<string>[]): boolean {
  return dsoWords(text).every((w) => allowed.some((set) => set.has(w)));
}

/** Words a question about the rules at an address may hold besides the address and its place. */
const DSO_ADDRESS_QUESTION_WORDS = new Set([
  ...Object.keys(DUTCH_MONTHS),
  "welke", "welk", "wat", "zijn", "is", "er", "zit", "zitten", "de", "het", "een", "op", "aan", "bij", "voor", "nabij", "rond", "rondom", "in", "te", "ter", "van",
  "en", "of", "ook", "nu", "hier", "daar", "dit", "deze", "die", "dat", "mijn", "ons", "onze", "me", "mij", "ik", "je", "u", "men", "we", "wij", "nog", "al",
  "alle", "allemaal", "precies", "eigenlijk", "graag", "toon", "laat", "zien", "geef", "noem", "lijst", "overzicht", "gelden", "geldt", "golden", "gold",
  "geldig", "geldende", "actuele", "huidige", "toepassing", "momenteel", "vandaag", "per", "vanaf", "tot", "sindsdien", "bijgekomen", "gewijzigd", "veranderd",
  "nieuw", "nieuwe", "adres", "postcode", "huisnummer", "locatie", "perceel", "kavel", "pand", "huis", "woning", "tuin", "achtertuin", "voortuin", "plek",
  "grond", "terrein", "onder",
  "rijk", "gemeente", "provincie", "waterschap", "gemeentelijke", "provinciale", "kan", "kun", "kunt", "kunnen", "hoe", "hoog", "hoger", "groot", "groter",
  "diep", "breed", "ver", "which", "what", "are", "the", "at", "on", "for", "there", "my", "to", "can", "apply", "applies",
]);
/** Rule words: "Welke regels gelden op <adres>". */
const DSO_ADDRESS_RULE_WORDS = new Set(["regels", "regel", "regelgeving", "regelingen", "regeling", "omgevingsregels", "omgevingsplanregels", "waterschapsregels", "bouwregels", "rules", "regulations", "zoning"]);
/** Permission words: "Mag ik een dakkapel plaatsen op <adres>", with a building topic. */
const DSO_ADDRESS_PERMISSION_WORDS = new Set(["mag", "mogen", "toegestaan", "verboden", "vergunningvrij", "vergunningsvrij", "vergunningplichtig", "vergunningsplichtig", "allowed"]);
/** What one builds or changes on a plot: the topics of an omgevingsplan and the Bbl. */
const DSO_BUILDING_TOPICS = new Set([
  "bouwen", "bouw", "verbouwen", "bijbouwen", "plaatsen", "maken", "aanleggen", "neerzetten", "zetten", "slopen", "sloop", "kappen", "vellen", "splitsen",
  "dakkapel", "dakkapellen", "aanbouw", "uitbouw", "opbouw", "dakopbouw", "optopping", "bijgebouw", "bijgebouwen", "bijbehorend", "bijbehorende", "bouwwerk",
  "bouwwerken", "schuur", "schuurtje", "schutting", "erfafscheiding", "hek", "hekwerk", "tuinhuis", "tuinhuisje", "blokhut", "carport", "overkapping", "veranda",
  "serre", "uitrit", "inrit", "boom", "bomen", "zonnepanelen", "dakterras", "balkon", "gevel", "kozijnen", "airco", "warmtepomp", "bed", "and", "breakfast", "b",
  "mantelzorgwoning", "woningsplitsing", "bouwhoogte", "goothoogte", "hoogte", "bouwvlak", "bestemming", "functie", "gebruik", "wonen", "build", "extension",
]);
/** Words a question for the ontwerpen ter inzage of a body or place may hold besides that name. */
const DSO_ONTWERP_QUESTION_WORDS = new Set([
  ...Object.keys(DUTCH_MONTHS),
  "welke", "welk", "wat", "zijn", "is", "er", "liggen", "ligt", "lagen", "lag", "nu", "momenteel", "op", "dit", "moment", "ter", "inzage", "ontwerp",
  "ontwerpen", "de", "het", "een", "in", "bij", "van", "alle", "nog", "toon", "geef", "overzicht", "lijst", "recent", "recente", "nieuwste", "laatste", "open",
  "zie", "zien", "laat", "kan", "ik", "gemeente", "provincie", "waterschap", "hoogheemraadschap", "wetterskip", "vandaag",
]);

/** "ontwerp" or "ontwerpen" as a word of its own: "ontwerpbegroting" and "wetsontwerp" are other documents. */
const DSO_ONTWERP_WORD_RE = /(?:^|[^\p{L}-])ontwerp(?:en)?(?=$|[^\p{L}-])/iu;
const DSO_TER_INZAGE_RE = /\bter\s+inzage\b|\binzagetermijn(?:en)?\b/i;
/** "de Nationale Omgevingsvisie", "de programma's van het Rijk": the Rijk's documents (bevoegd gezag type ministerie). */
const DSO_RIJK_RE = /(?:^|[^\p{L}])(?:nationale|het\s+rijk)(?=$|[^\p{L}])/iu;
const DSO_APPLY_RE = /(?:^|[^\p{L}])(?:gelden|geldt|golden|gold|van\s+toepassing)(?=$|[^\p{L}])/iu;
const DSO_RECENT_RE = /(?:^|[^\p{L}])(?:nieuwste|recentste|recente?|laatste|onlangs|net\s+(?:gepubliceerd|vastgesteld))(?=$|[^\p{L}])/iu;
/** "gelden op 1 januari 2025": the day the question asks the rules for (geldigOp). */
const DSO_VALIDITY_RE = /(?:^|[^\p{L}])(?:gelden|geldt|golden|gold|geldig|van\s+kracht|in\s+werking)(?=$|[^\p{L}])/iu;

/** The calendar days a question names: "1 januari 2025", "2025-01-01", "1-1-2025". */
function explicitDays(text: string): string[] {
  const days = new Set<string>();
  const add = (y: number, m: number, d: number) => {
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d) days.add(date.toISOString().slice(0, 10));
  };
  for (const m of text.matchAll(/(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g)) add(Number(m[1]), Number(m[2]), Number(m[3]));
  for (const m of text.matchAll(/(?<![\d/-])(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?![\d/-])/g)) add(Number(m[3]), Number(m[2]), Number(m[1]));
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})\s+(\p{L}+)\.?\s+(\d{4})(?!\d)/gu)) {
    const month = DUTCH_MONTHS[m[2].toLowerCase()];
    if (month) add(Number(m[3]), month, Number(m[1]));
  }
  return [...days];
}

/** What nl_gov_ask passes to dso_omgevingsdocumenten_search; the field names are the search's own. */
export type DsoIntent = Pick<DsoSearchArgs, "locatie" | "bevoegdGezag" | "typeBevoegdGezag" | "documentType" | "soort" | "alleenTerInzage" | "geldigOp"> & {
  /** An area: the provincie's own documents and those of every gemeente in it (the search's `provincie`). */
  provincie?: string;
};

/**
 * A question about Omgevingswet documents, for the DSO. Precision first: a
 * question another route answered before the DSO route keeps that route.
 *  - It names a document (omgevingsplan, omgevingsvisie, omgevingsverordening,
 *    waterschapsverordening, omgevingsprogramma, omgevingsdocument,
 *    voorbereidingsbesluit, voorbeschermingsregels, projectbesluit,
 *    ontwerpregeling, "regels op de kaart", NOVI) with a scope (address,
 *    place, body, provincie area, the Rijk), or asks for a list or the
 *    newest, or for ontwerpen;
 *  - or it asks which rules apply at an address (a street with a street
 *    ending and a house number, or a postcode), with nothing but rule,
 *    permission and building words besides ("Welke regels gelden op
 *    Brennerbaan 150, Utrecht?", "Mag ik een dakkapel plaatsen op ...");
 *  - or it asks for the ontwerpen ter inzage of a named gemeente, provincie,
 *    waterschap or place, and for nothing else.
 * Never: a question longer than DSO_QUESTION_MAX_CHARS; a question about the
 * law, a definition or how something works; one about money, procedures,
 * participation, the council, Staten, parliament or government; one that
 * names another source or another kind of document (dsoOtherRoute).
 *
 * Where: an address becomes `locatie` with the place or postcode written
 * behind it (or "in Utrecht" elsewhere); "in de provincie X", or "in
 * Noord-Holland", asking for ontwerpen, all documents or omgevingsplannen is
 * the area `provincie`; a verordening "in <gemeente>" is the point there;
 * otherwise the body or place the question names is `bevoegdGezag`. What:
 * documentType when the question names one kind; "ontwerp" or "ter inzage"
 * asks for ontwerpregelingen; a day the rules "gelden op" is geldigOp.
 * `maxChars` is for tests that time the detector on long input.
 */
export function detectDsoIntent(question: string, maxChars = DSO_QUESTION_MAX_CHARS): DsoIntent | undefined {
  const text = String(question ?? "");
  if (text.length > maxChars) return undefined;
  const raw = text.replace(/\s+/g, " ").trim();
  if (!raw) return undefined;

  // The address and the neutral qualifiers are read first and masked, so a
  // street name ("Burgemeester Reigerstraat") is no council word below.
  const neutral = raw.replace(DSO_NEUTRAL_PHRASE_RE, (m) => "§".repeat(m.length));
  const address = dsoAddress(neutral);
  let masked = dsoMask(neutral, address);
  if (dsoOtherRoute(masked)) return undefined;

  const documentWords = DSO_DOCUMENT_WORDS_RE.test(masked) || DSO_NOVI_RE.test(masked);
  const terInzage = DSO_TER_INZAGE_RE.test(masked);
  const ontwerp = terInzage || /(?:^|[^\p{L}])ontwerp/iu.test(masked);
  const types = [...new Set(DSO_TYPE_WORDS.filter(([re]) => re.test(masked)).map(([, type]) => type))];
  const documentType = types.length === 1 ? types[0] : undefined;
  const plural = DSO_PLURAL_DOCUMENT_RE.test(masked);
  const lowercase = !/\p{Lu}/u.test(raw.slice(1));

  // Bodies and places, each masked once read.
  const english = DSO_ENGLISH_BODY_RE.exec(masked);
  const englishBody = english?.indices?.[2] ? dsoPlace(english[2], english.indices[2][0]) : undefined;
  const lowerBody = lowercase ? DSO_LOWER_BODY_RE.exec(masked) : null;
  const lowerBodyPlace = lowerBody ? dsoLowerPlaceIn(DSO_LOWER_BODY_RE, masked, 2) : undefined;
  const body =
    dsoPlaceIn(DSO_BODY_RE, masked) ??
    (englishBody && english ? { ...englishBody, name: `${/^p/i.test(english[1]) ? "provincie" : "gemeente"} ${englishBody.name}` } : undefined) ??
    (lowerBodyPlace && lowerBody ? { ...lowerBodyPlace, name: `${lowerBody[1]} ${lowerBodyPlace.name}` } : undefined);
  const area = dsoPlaceIn(DSO_PROVINCE_AREA_RE, masked);
  masked = dsoMask(dsoMask(masked, area), body);
  const documentPlace = DSO_DOCUMENT_PLACE_RE.exec(masked);
  const nextTo = documentPlace?.indices?.[2] ? dsoPlace(documentPlace[2], documentPlace.indices[2][0]) : undefined;
  // "het omgevingsplan voor Utrecht" yields to "in": "een voorbereidingsbesluit voor Lunetten in Utrecht".
  const forPlace = /^(?:[Vv]oor|for)$/.test(documentPlace?.[1] ?? "");
  const inPlace = dsoPlaceIn(DSO_IN_PLACE_RE, masked);
  const placeFirst = dsoPlaceIn(DSO_PLACE_DOCUMENT_RE, masked);
  // Without a document word only "in <place>" counts: "gelden voor Airbnb" names no place.
  const place = !documentWords
    ? inPlace
    : ((forPlace ? undefined : nextTo) ??
      inPlace ??
      nextTo ??
      dsoPlaceIn(DSO_VERB_PLACE_RE, masked) ??
      (placeFirst && !DSO_NOT_A_PLACE_START.has(placeFirst.name.split(" ")[0].toLowerCase()) && !/(?:se|sche)$/i.test(placeFirst.name) ? placeFirst : undefined) ??
      dsoPlaceIn(DSO_OF_PLACE_RE, masked) ??
      (lowercase ? dsoLowerPlaceIn(DSO_LOWER_PLACE_RE, masked, 1) : undefined));
  const placeFromIn = Boolean(place && place === inPlace);
  masked = dsoMask(masked, place);

  // Which rules apply at an address, and nothing else.
  const words = dsoWords(masked);
  const ruleWord = words.some((w) => DSO_ADDRESS_RULE_WORDS.has(w));
  const permission = words.some((w) => DSO_ADDRESS_PERMISSION_WORDS.has(w)) && words.some((w) => DSO_BUILDING_TOPICS.has(w));
  const addressRules =
    Boolean(address?.strict) &&
    (ruleWord || permission) &&
    dsoOnlyWords(masked, DSO_ADDRESS_QUESTION_WORDS, DSO_ADDRESS_RULE_WORDS, DSO_ADDRESS_PERMISSION_WORDS, DSO_BUILDING_TOPICS);
  // The ontwerpen ter inzage of a body or place, and nothing else.
  const ontwerpenTerInzage = DSO_ONTWERP_WORD_RE.test(masked) && terInzage && Boolean(body || area || place) && dsoOnlyWords(masked, DSO_ONTWERP_QUESTION_WORDS);
  if (!documentWords && !addressRules && !ontwerpenTerInzage) return undefined;

  // An address keeps its place; without one written behind it, the place the question names elsewhere.
  const addressPlace = address && !address.hasPlace ? (body?.name.replace(/^gemeente\s+/i, "") ?? place?.name) : undefined;
  const verordeningHere =
    placeFromIn && !body && (documentType === "waterschapsverordening" || (documentType === "omgevingsverordening" && !DSO_PROVINCES.has(place!.name.toLowerCase())));
  const locatie =
    address && (address.strict || documentWords)
      ? [address.locatie, addressPlace].filter(Boolean).join(", ")
      : // A verordening "in Amersfoort" is the one that applies there, not the gemeente's own (none).
        documentWords && verordeningHere
        ? place!.name
        : // "Welke omgevingsplannen gelden er op Schiphol?": the point.
          documentWords && !body && !place && !area && DSO_APPLY_RE.test(masked)
          ? dsoPlaceIn(DSO_AT_PLACE_RE, masked)?.name
          : undefined;

  // "in de provincie Utrecht" is an area when the question asks for ontwerpen,
  // for documents of every kind or in the plural, or for omgevingsplannen,
  // which only gemeenten adopt ("provincie Utrecht" + omgevingsplan is one
  // too); so is a provincie's own name "in Noord-Holland". "de omgevingsvisie
  // van de provincie Utrecht" is the provincie's own.
  const areaWanted = ontwerp || !documentType || documentType === "omgevingsplan" || plural;
  const provincieBody = body && /^provincie\s/i.test(body.name) ? body.name.replace(/^provincie\s+/i, "") : undefined;
  const provinceNamed = place && !body && DSO_PROVINCES.has(place.name.toLowerCase()) ? place.name : undefined;
  const provincie = locatie
    ? undefined
    : area && areaWanted
      ? area.name
      : provincieBody && documentType === "omgevingsplan"
        ? provincieBody
        : provinceNamed && (documentType === "omgevingsplan" || (placeFromIn && areaWanted))
          ? provinceNamed
          : undefined;
  const bevoegdGezag = locatie || provincie ? undefined : (body?.name ?? place?.name ?? (area ? `provincie ${area.name}` : undefined));
  const typeBevoegdGezag = locatie || bevoegdGezag || provincie
    ? undefined
    : /\b(?:gemeenten|gemeentes)\b/i.test(masked)
      ? "gemeente"
      : /\bprovincies\b/i.test(masked)
        ? "provincie"
        : /\bwaterschappen\b/i.test(masked)
          ? "waterschap"
          : DSO_RIJK_RE.test(masked) || DSO_NOVI_RE.test(masked)
            ? "ministerie"
            : undefined;
  // Only a single day the rules "gelden op"; a year or a period stays today's list (the route says so).
  const days = !ontwerp && DSO_VALIDITY_RE.test(masked) ? explicitDays(raw) : [];
  const geldigOp = days.length === 1 ? days[0] : undefined;

  if (!locatie && !bevoegdGezag && !provincie && !typeBevoegdGezag) {
    // Nowhere: only a list, the newest documents or ontwerpen, and not when a
    // capitalised word that may be a place went unread ("Omgevingsplan Artikel 22").
    const list = (plural && DSO_LIST_RE.test(masked)) || DSO_RECENT_RE.test(masked) || ontwerp;
    const unread = raw
      .split(/[^\p{L}'’-]+/u)
      .slice(1)
      .some((w) => /^\p{Lu}/u.test(w) && !w.split("-").some((part) => DSO_NOT_A_PLACE_CAPITAL.test(part.replace(/['’]s$/, ""))));
    if (!list || unread) return undefined;
  }
  return {
    ...(locatie ? { locatie } : {}),
    ...(bevoegdGezag ? { bevoegdGezag } : {}),
    ...(provincie ? { provincie } : {}),
    ...(typeBevoegdGezag ? { typeBevoegdGezag } : {}),
    ...(documentType ? { documentType } : {}),
    ...(ontwerp ? { soort: "ontwerpregelingen" as const } : {}),
    ...(terInzage ? { alleenTerInzage: true } : {}),
    ...(geldigOp ? { geldigOp } : {}),
  };
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
 * Keyword terms as a query for the sources that read quoted phrases: ORI
 * (Elasticsearch query_string), Tweede Kamer (parseTkQuery matches a quoted
 * term as a whole phrase) and Officiële Bekendmakingen (freeTextCqlPlan keeps
 * a quoted phrase). Multi-word terms (names, quoted phrases, "open data
 * portaal") become phrases; unquoted, each source made every word a term of
 * its own, so "open data portaal" matched any document with "data" in it.
 *
 * A term in `loose` goes as its words: a run of capitalised words that the
 * keywords grouped into one term (extractKeywordTerms kind "name") is often
 * no phrase in the documents. Tweede Kamer and Officiële Bekendmakingen AND
 * every word, and "Schiphol Geluidsoverlast" or "Wet Kwaliteitsborging
 * Bouwen" as a phrase found nothing or unrelated publications.
 */
export function toPhraseQuery(terms: string[], loose: ReadonlySet<string> = new Set()): string {
  return terms.map((t) => (t.includes(" ") && !loose.has(t) ? `"${t.replace(/"/g, "")}"` : t)).join(" ");
}

/** Keyword terms as an Elasticsearch query_string for ORI, see {@link toPhraseQuery}. */
export function toOriQuery(terms: string[]): string {
  return toPhraseQuery(terms);
}

/**
 * A municipality as a national ORI search names it: a phrase. A loose town
 * name that is also a common word matched unrelated text (Kampen: the verb
 * "kampen met", and "kamp" through stemming), and a one-word name in
 * quotes is still that one stemmed word, so it is bound to "gemeente". A
 * longer name ("Bergen op Zoom") is a phrase of its own.
 */
export function oriPlacePhrase(place: string): string {
  const name = place.replace(/"/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  return /\s/.test(name) ? `"${name}"` : `"gemeente ${name}"`;
}

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

      const records = out.items.map((x) => record("cbs", String(x.Title ?? x.title ?? x.Identifier ?? "CBS tabel"), `https://www.cbs.nl`, x));
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
      } else if (include_text && r.text_preview_unavailable_reason === "pdf_not_extracted_in_lean_mode") {
        notes.push("PDF text extraction is intentionally skipped in lean mode; use the resolved resource URL for downstream PDF handling.");
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

  server.registerTool("rijksoverheid_search", { description: "Search Rijksoverheid.nl content via the government's RSS search platform. Server-side keyword search returns at most 20 results per query, ranked by relevance, with no pagination; when the feed is full the real number of matches is unknown and total is left empty. date_from/date_to are applied server-side before that cap. Each item has date (the date Rijksoverheid.nl itself shows for the item, as an Amsterdam calendar day: for news the publication date, for documents the document date, for a revised document that of its latest version; date_from/date_to filter on this same date), issued (that date as a full timestamp), url_date (documents only: the date in the URL path, when the page was created, which for a revised document dates its first version; not when it went online) and type (page kind from the URL path: news, document, video, agenda, weblog, question_and_answer, topic, webpage); the feed carries no finer document type and no ministry. Use topic keywords. type='news' returns news only; type='all' returns news + documents + other pages.", inputSchema: { query: z.string().describe("Government topic keywords. Examples: 'energietransitie', 'pensioenwet', 'toeslagen'. Do NOT pass full questions."), top: z.number().int().min(1).max(config.limits.maxRows).default(20), type: z.enum(["news", "all"]).optional().default("news").describe("'news' = only news documents; 'all' = news + policy documents + other pages. The platform returns at most 20 items per query."), date_from: z.string().optional().describe("Start of the period, inclusive: YYYY-MM-DD, or YYYY-MM / YYYY for the first day of that month or year (Amsterdam calendar days). Filters server-side on the item's date. An unreadable value is ignored with a warning in access_note."), date_to: z.string().optional().describe("End of the period, inclusive: YYYY-MM-DD, or YYYY-MM / YYYY for the last day of that month or year (Amsterdam calendar days). Filters server-side on the item's date. An unreadable value is ignored with a warning in access_note."), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, annotations: TOOL_ANNOTATIONS }, async ({ query, top, type, date_from, date_to, offset, limit, outputFormat, verbose, dryRun }) => {
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
        summary: `${records.length} resultaten`,
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
  server.registerTool("ori_search", { inputSchema: { query: z.string().describe("Council topic keywords. Examples: 'parkeerbeleid', 'bestemmingsplan', 'raadsvergadering woningbouw'. Do NOT pass full questions. By default all words must occur (see 'match')."), sort: z.enum(["relevance", "date_newest"]).default("relevance").describe("'date_newest' sorts server-side by meeting date (last_discussed_at, the last meeting that discussed the record — not the publication date) and leaves out dates after today unless date_to is set. 'relevance' for general searches."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20), bestuurslaag: z.string().optional().describe("Filter by government layer: 'gemeente', 'provincie' or 'waterschap'. Other values are not applied (reported in access_note)."), gemeente: z.string().optional().describe("Scope to one body, e.g. 'Delft', 'Den Haag', 'Leidschendam-Voorburg', 'Provincie Noord-Holland', 'Hoogheemraadschap van Delfland'. Matched exactly against the live ORI index list (gemeenten, provincies, waterschappen); a name without an ORI index returns no records and says so. Without it a search runs across all indices."), date_from: oriDate.optional().describe("Only records dated on or after this day (YYYY-MM-DD). Filters on the meeting date (last_discussed_at; start_date for reports)."), date_to: oriDate.optional().describe("Only records dated on or before this day (YYYY-MM-DD), same date field as date_from."), match: z.enum(["all", "any"]).default("all").describe("'all' (default): every word must occur. 'any': at least one word (broad, many more hits).") }, description: "Search Open Raadsinformatie (ORI) — council documents, agenda items, meetings and decisions of Dutch municipalities, provinces and water boards. Use policy topic keywords; set 'gemeente' to answer 'what did the council of X discuss', 'bestuurslaag' to restrict to a layer, 'date_from'/'date_to' for a period and 'sort' for recency. The query accepts \"phrases\", uppercase OR/AND/NOT, -term and prefix*; a lowercase or/and/not is searched as a word (e.g. OR = ondernemingsraad). Documents link to their file (data.original_url, also on each attachment, is the source system's own link if ORI's link fails; where ORI's link is known to fail the link already goes to the source system, see link_note); meetings and agenda items link to the meeting's page in the council information system (link_type 'meeting_page'; iBabs, Notubiz, Parlaeus or GemeenteOplossingen, see source_system; an agenda item to its meeting's page, anchored on the item where possible) when that page answered a check during the search, or where a page cannot be checked itself, when the system's own API confirmed the meeting (GemeenteOplossingen, whose API also names the page, and Haarlem's Notubiz site); else, also when the checks ran out of time (about 3 s per search), to their ORI API record, which is JSON and not a web page (link_type 'ori_record', reason in link_note); ori_record_url keeps the ORI record next to a meeting page, and their documents are under 'attachments'. data.date_type says what the date is (vergaderdatum, documentdatum, or an iBabs list date such as a deadline). Totals above 10000 are reported as a lower bound; access_note warns when the ORI index is stale.", annotations: TOOL_ANNOTATIONS }, async ({ query, sort, rows, bestuurslaag, gemeente, date_from, date_to, match }) => {
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
        "Search the omgevingsdocumenten of the Omgevingswet in the DSO (Digitaal Stelsel Omgevingswet), at document level: omgevingsplannen, omgevingsvisies, programma's, omgevingsverordeningen, waterschapsverordeningen, voorbereidingsbesluiten (voorbeschermingsregels), projectbesluiten and the Rijk's AMvB's, and with soort 'ontwerpregelingen' the drafts, with their inzagetermijn where the DSO has one. " +
        "Use 'locatie' (an address, postcode or place) for the documents whose werkingsgebied covers that point, gemeente first, then waterschap, provincie and Rijk. This does not check which individual articles apply there: an artikel can have a smaller werkingsgebied (Regels op de kaart shows rules per location). " +
        "Use 'bevoegdGezag' for the documents one body issued itself: a TOOI code (gm0344 = gemeente Utrecht, pv26 = provincie Utrecht, ws0636 = Hoogheemraadschap De Stichtse Rijnlanden, mnre1034 = ministerie van BZK) or a name. A provincie as bevoegdGezag gives only the provincie's own documents; use 'provincie' for the area: the provincie's documents plus those of all its gemeenten. " +
        "Without locatie, bevoegdGezag or provincie, 'query' and 'documentType' search the complete national catalogue. " +
        "Returns metadata, most recently changed first (by the start of each document's current consolidated version, so a new version of an old plan counts as recent): title, type, bevoegd gezag (the issuing body), versie with the beginGeldigheid/eindGeldigheid of that version (eindGeldigheid is exclusive: on that day the next version applies, so this one holds through versieGeldigTotEnMet, the day before; it is not when the regeling ends), a link to the readable text (canonical_url: lokaleregelgeving.overheid.nl for gemeente, provincie and waterschap, wetten.overheid.nl for Rijk laws where known, else Regels op de kaart; the publication for an ontwerp), and identificatie/uriIdentificatie (technischId for an ontwerp). " +
        "Two Rijk records at every location are no rule document: the Omgevingswet is only a pointer in the DSO (alleenVerwijzing) and 'Aansluitdocument Rijk' a technical record (technisch); both carry an opmerking and say so in their title. " +
        "access_note says what was searched and, per bestuurslaag, what was found and what rows left out. The rule text itself comes from dso_omgevingsdocument_tekst with that identificatie. Requires DSO_API_KEY.",
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
        "Read the rule text (regeltekst) of one DSO omgevingsdocument as plain text (the whole document; it does not tell which artikelen apply at a particular location): hoofdstukken, afdelingen, paragrafen and artikelen with number and title, numbered leden and lists, begrippen as 'term: definitie', tables as rows. " +
        "Pass the identificatie from dso_omgevingsdocumenten_search ('/akn/nl/act/gm0344/2020/omgevingsplan'; uriIdentificatie, an identifier.overheid.nl URL or an ontwerp's technischId also work). The Rijk's AMvB's are readable here article by article too (Bbl = '/akn/nl/act/mnre1034/2018/BWBR0041297'; dso_omgevingsdocumenten_search with typeBevoegdGezag 'ministerie' lists them). " +
        "'zoekterm' returns only the artikelen, begrippen and toelichting parts holding every word, each with its heading path, the regels before bijlagen and toelichting; every hit gets at least its heading and the passage with the term, and a hit too long for max_tekens comes with only its passages (ingekort: true, eId for the rest). It finds the word only: a rule that applies through a general term or an afwijking ('In afwijking van artikel 9.3') may not repeat it, so also read the afdeling of the main hit. " +
        "'onderdeel' returns one part by eId/wId or label ('Artikel 4.24', 'artikel 4.1 lid 2', 'artikel 4.1, tweede lid', 'Hoofdstuk 4', 'Bijlage II'). " +
        "A part from the toelichting is titled 'Toelichting bij …' and has toelichting: true: it explains a rule and is not binding; the rule is the artikel itself. " +
        "An omgevingsplan's voorbeschermingsregels (voorbereidingsbesluiten) are a tijdelijk deel of it and take precedence where they deviate: access_note lists them, and a zoekterm searches them too ('Voorbeschermingsregels: <titel> — Artikel …', tijdelijkDeel: true). " +
        "An ontwerp reads as the regeling would after the change: added text in, deleted text out; with weergave 'wijzigingen' only what it changes, [+added+] and [-deleted-] text marked, parts only renumbered listed as such. " +
        "Without zoekterm or onderdeel, a document longer than max_tekens comes back as its beginning plus a table of contents whose eIds a follow-up call can pass as onderdeel. Large documents (an omgevingsplan is several MB) are fetched once and kept for 15 minutes. " +
        "For the Omgevingswet the DSO holds only a pointer, not the law: access_note then links the text on wetten.overheid.nl; the Aansluitdocument Rijk is a technical record without rules. Requires DSO_API_KEY.",
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

  server.registerTool("rechtspraak_search_ecli", { inputSchema: { query: z.string().describe("1-3 core legal topic keywords ONLY. Extract the subject from the user's question. Examples: 'waterschade', 'huurrecht ontbinding', 'arbeidsrecht ontslag'. NEVER include question words, verbs, articles, or full sentences. This API is extremely sensitive to extra words."), sort: z.enum(["relevance", "date_newest", "ruling_newest"]).default("relevance").describe("Use 'date_newest' when user asks for recent/latest/newest results (sorted by publication date). Use 'ruling_newest' to sort by ruling date. Use 'relevance' for general searches."), date_filter: z.enum(["week", "month", "year", "last_year"]).optional().describe("Optional publication date filter. Use 'week' for past 7 days, 'month' for past month, 'year' for this year, 'last_year' for previous year. Only set when user explicitly mentions a time period."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search Dutch case law (Rechtspraak) for ECLI references. IMPORTANT: Pass only topic keywords in 'query', not full sentences. Use 'sort' and 'date_filter' parameters to control recency and time period — do NOT encode these in the query string.", annotations: TOOL_ANNOTATIONS }, async ({ query, sort, date_filter, rows }) => {
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

  server.registerTool("nl_gov_ask", { inputSchema: { question: z.string(), top: z.number().int().min(1).max(config.limits.maxRows).default(10), reference_now: z.string().optional(), timezone: z.string().optional(), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, description: "Smart router that interprets a natural-language question about Dutch government data and queries the most relevant source(s). Supports temporal expressions in Dutch and English (e.g. 'vorige week', 'since 2020'). Organisation and policy questions ('Wat doet de Belastingdienst met de BTW?', 'GGZ-beleid gemeente Utrecht') are searched in documents: the municipality's council records (Open Raadsinformatie), official publications, Tweede Kamer and Rijksoverheid. Case-law, API-register and budget questions keep their own routes. With DSO_API_KEY set, Omgevingswet document questions go to the DSO first: a question naming an omgevingsplan, omgevingsvisie, omgevingsverordening, waterschapsverordening, omgevingsprogramma, voorbereidingsbesluit, projectbesluit, ontwerpregeling or omgevingsdocument together with an address, a place, a gemeente, provincie or waterschap, or asking for a list, the newest or ontwerpen; 'welke regels gelden op <straat huisnummer, plaats>' or '<postcode>' (also 'mag ik een dakkapel plaatsen op ...'); and ontwerpen ter inzage of a named gemeente, provincie, waterschap or place. An address gives the documents of every bestuurslaag at that point, 'in de provincie X' (or 'in Noord-Holland') the provincie's and its gemeenten's, a named gemeente, provincie or waterschap its own; 'gelden op <dag>' asks for that day. Questions about the law itself, definitions, procedures, costs, participation, the council, Staten, parliament or ministers, and questions naming publications, case law, enforcement, permits, tenders, budgets, statistics or news keep their own route, as do questions longer than 500 characters. For a place, an address or ontwerpen the DSO's answer stands even when it is empty; when the DSO fails, gives no answer within 20 s or does not know the place, the other routes answer and access_note says why. Questions no route answers fall back to the data.overheid.nl dataset catalogue; access_note then names the routes that were tried and whether they found nothing or failed. The search terms derived from the question are reported in access_note. Use this when the best source is unclear.", annotations: TOOL_ANNOTATIONS }, async ({ question, top, reference_now, timezone, offset, limit, outputFormat, verbose, dryRun }) => {
    const decodedQuestion = (() => {
      try { return decodeURIComponent(question.replace(/\+/g, " ")); } catch { return question; }
    })();
    const temporal = parseTemporalRange(decodedQuestion, { now: reference_now, timeZone: timezone ?? config.temporal.defaultTimeZone });
    const questionForSearch = temporal?.cleanedQuery?.trim() ? temporal.cleanedQuery : decodedQuestion;
    const q = questionForSearch.toLowerCase();
    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match intent terms op woordgrenzen i.p.v. naïeve substring-includes, zodat
    // korte tokens (bv. "mp") niet binnen andere woorden matchen ("temperatuur",
    // "lamp", "pomp"). Werkt met meerwoords-termen ("tweede kamer", "raad van
    // state") en koppeltekens ("defensie-uitgaven").
    const matchesTerm = (haystack: string, term: string): boolean => {
      const t = term.trim();
      if (!t) return false;
      return new RegExp(`\\b${escapeRegExp(t)}\\b`).test(haystack);
    };
    const has = (terms: string[]) => terms.some((t) => matchesTerm(q, t));

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

    // Route-specific words that select the source and are no search topic there.
    const tkRouteWords = ["tweede kamer", "parlement", "motie", "moties", "amendement", "amendementen", "kamerstuk", "kamerstukken", "kamervraag", "kamervragen", "debat", "debatten", "stemming", "stemmingen", "fractie", "fracties", "commissie", "commissies", "wetsvoorstel", "wetsvoorstellen", "kamerlid", "kamerleden", "minister-president", "premier", "aangenomen", "verworpen"];
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
    const tkTopicTerms = topicTerms(questionForSearch, tkRouteWords);
    const tkTopic = toPhraseQuery(tkTopicTerms, nameTerms);
    const tkNamedTopic = toPhraseQuery(tkTopicTerms);
    const tkLooseTopic = tkTopicTerms.join(" ");
    const tkNameTopicTerms = tkTopicTerms.filter((term) => nameTerms.has(term));
    // In a multi-source answer Tweede Kamer gets one search, without a type
    // filter, and without a topic the question minus its frame.
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
            access_note: mergeAccessNotes(dsoNote, debatNote, algoritmeNote, args.access_note, pagingNote),
            failures: failures.length ? failures : undefined,
          }),
          verbose: buildVerbose(),
        },
      );
    };

    const cbsTerms = ["cbs", "statistiek", "statistieken", "statistics", "bevolking", "population", "inwoner", "inwoners", "inflatie", "werkloos", "werkloosheid", "woning", "woningen", "inkomen", "inkomens", "economie", "bbp", "gdp", "import", "export", "geboorte", "geboortes", "sterfte", "opleidingsniveau", "opleiding", "onderwijsniveau", "emissie", "emissies"];
    const tkTerms = ["tweede kamer", "parlement", "motie", "moties", "amendement", "amendementen", "kamerstuk", "kamerstukken", "kamervraag", "kamervragen", "debat", "debatten", "stemming", "stemmingen", "fractie", "fracties", "commissie", "commissies", "wetsvoorstel", "wetsvoorstellen", "kamerlid", "kamerleden", "minister-president", "premier"];
    const obTerms = ["staatsblad", "staatscourant", "tractatenblad", "gemeenteblad", "provinciaal blad", "waterschapsblad", "bekendmaking", "bekendmakingen", "verordening", "verordeningen", "regeling", "regelingen", "officieel besluit", "officiele publicatie", "officiële publicatie", "stcrt", "gmb"];
    const rijkTerms = ["rijksoverheid", "kabinet", "minister", "ministerie", "beleid", "toespraak", "schoolvakantie", "schoolvakanties", "school holiday", "school holidays", "vakantie regio"];
    const budgetTerms = ["begroting", "begrotingen", "rijksbegroting", "budget", "uitgaven", "spending", "rijksfinanci", "begrotingsartikel", "defensie-uitgaven"];
    const duoTerms = ["school", "scholen", "leerling", "leerlingen", "student", "studenten", "leraar", "leraren", "docent", "docenten", "teacher", "onderwijs", "education", "slagingspercentage", "slagingspercentages", "examen", "examens", "diploma", "diplomas", "duo", "basisschool", "basisscholen", "middelbare", "mbo", "hbo", "universiteit", "universiteiten"];
    const weatherTerms = ["weer", "weather", "temperatuur", "rain", "regen", "wind", "storm", "klimaat", "earthquake", "aardbeving", "seismologie"];
    const apiTerms = ["welke api", "which api", "is er een api", "data over", "api heeft"];
    // Case-law words split in three: the first set always means rulings, the
    // second also occurs in policy questions ("Wat doet de gemeente aan
    // handhaving?", "mensen met een zwaar beroep"), and "uitspraak" /
    // "uitspraken" are rulings only when no office holder is their subject
    // ("Uitspraken van de minister over jeugdzorg" asks for statements, see
    // uitsprakenSense).
    const caseLawTerms = ["jurisprudentie", "rechtspraak", "rechtszaak", "rechtszaken", "rechterlijke uitspraak", "rechterlijk", "ecli", "vonnis", "vonnissen", "arrest", "arresten", "gerechtshof", "rechtbank", "raad van state", "hoge raad", "centrale raad van beroep", "college van beroep", "tuchtrecht", "bestuursrecht"];
    const enforcementTerms = ["beschikking", "gesanctioneerd", "sanctie", "sancties", "handhaving", "boete", "overtreding", "beroep", "bezwaar"];
    const caseLawAsked = has(caseLawTerms) || uitspraken === "rulings";
    const rechtspraakAsked = caseLawAsked || has(enforcementTerms);
    const verkiezingTerms = ["verkiezing", "verkiezingen", "verkiezingsuitslag", "verkiezingsuitslagen", "kiesraad", "opkomst", "opkomstpercentage", "gestemd", "stembureau", "stembureaus", "kiesgerechtigden", "election", "election results"];
    const aanbestedingTerms = ["aanbesteding", "aanbestedingen", "tender", "tenders", "tenderned", "gunning", "gunningen", "gegund", "marktconsultatie", "offerteaanvraag", "overheidsopdracht", "overheidsopdrachten", "inkoop", "procurement"];
    // Disciplinary law has its own collection; rechtspraak.nl does not carry it.
    const tuchtrechtTerms = ["tuchtrecht", "tuchtcollege", "tuchtcolleges", "tuchtklacht", "tuchtklachten", "tuchtzaak", "tuchtzaken", "berisping", "doorhaling", "tuchtrechter"];
    const gewasTerms = ["gewasperceel", "gewaspercelen", "landbouwperceel", "landbouwpercelen", "landbouwgrond", "akkerbouw", "gewas", "gewassen", "teelt", "grondgebruik", "agrarisch"];
    const catalogiTerms = ["productbeschrijving", "productbeschrijvingen", "samenwerkende catalogi", "gemeentelijke dienstverlening", "welke gemeenten bieden", "loket"];
    // Only unambiguous air-quality words: bare "stikstof" is a parliamentary and
    // agricultural topic, so it must keep routing to Tweede Kamer / CBS.
    const luchtTerms = ["luchtkwaliteit", "luchtvervuiling", "luchtverontreiniging", "fijnstof", "fijn stof", "smog", "stikstofdioxide", "no2", "pm10", "pm2.5", "pm25", "ozon", "luchtmeetnet", "air quality"];
    const examTerms = ["examen", "examens", "eindexamen", "slagingspercentage", "geslaagd", "geslaagden", "gezakt", "examencijfer", "examencijfers", "examenresultaten"];
    const schoolTerms = ["school", "scholen", "basisschool", "basisscholen", "middelbare school", "middelbare scholen", "onderwijsinstelling", "onderwijsinstellingen", "vestiging", "vestigingen", "schooladres", "schooladressen"];

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
      const likelyBudget = has(budgetTerms) || ((q.includes("hoeveel geeft") || q.includes("how much does")) && q.includes("uit"));
      // Detect multi-source intent: explicit signals OR implicit (question spans 2+ domain term lists, or uses "en ... ook/daarnaast/tevens")
      const explicitMulti = /(combineer|gecombineerd|vergel(?:ijk|ijken)|verhoud|versus|\bvs\b|zowel|naast|cross\s*source|multi\s*source)/i.test(decodedQuestion);
      const implicitMulti = /\b(?:en\s+(?:is\s+(?:er|daar)|zijn\s+er|ook|tevens|daarnaast|verder)|maar\s+ook|alsook|alsmede)\b/i.test(decodedQuestion);

      const plannerCandidates: Array<"cbs" | "tk" | "ob" | "rijk" | "budget" | "duo" | "api" | "rechtspraak"> = [];
      if (has(cbsTerms)) plannerCandidates.push("cbs");
      if (has(tkTerms)) plannerCandidates.push("tk");
      if (has(obTerms)) plannerCandidates.push("ob");
      if (has(rijkTerms)) plannerCandidates.push("rijk");
      if (likelyBudget) plannerCandidates.push("budget");
      if (has(duoTerms)) plannerCandidates.push("duo");
      if (has(apiTerms)) plannerCandidates.push("api");
      if (rechtspraakAsked) plannerCandidates.push("rechtspraak");

      const uniquePlannerCandidates = Array.from(new Set(plannerCandidates));
      const multiIntentSignal = explicitMulti || implicitMulti || uniquePlannerCandidates.length >= 2;
      // EU legislation goes first: "Verordening (EU) 2016/679" would otherwise hit obTerms.
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
      const caseLawIntent = caseLawAsked || (has(enforcementTerms) && detectedPolicyIntent?.strength !== "strong");
      const apiIntent = has(apiTerms.filter((t) => /\bapi\b/.test(t)));
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
      const namesNationalSource = has(obTerms) || /\b(?:tweede kamer|eerste kamer|kamerstuk(?:ken)?|kamervra(?:ag|gen)|kamerlid|kamerleden|provinciaal blad)\b/.test(q);
      const gemeenteForOri = policyIntent?.gemeente && !namesNationalSource ? policyIntent.gemeente : undefined;
      const gemeenteTerms = gemeenteForOri
        ? // "de raad van Amsterdam": within Amsterdam's council records "raad" is in every document.
          topicTerms(questionForSearch, [...MUNICIPAL_SCOPE_WORDS, ...ORGANISATION_WORDS, "raad", "college", gemeenteForOri], namedNationalRouteWords)
        : [];

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
        };

        // Estimate only: the specific routes further down can still answer first.
        const policySources = gemeenteTerms.length
          ? ["ori"]
          : policyIntent && policyTerms.length
            ? [...(policyIntent.municipal ? ["ori"] : []), "ob", "tk", "rijk"]
            : [];
        // Follow the route order below: the multi-source planner runs first, the
        // municipal ORI route after CBS, the early document search after CBS, TK
        // and OB, the late one only after every route a question word picked.
        const multiPlanned = multiIntentSignal && uniquePlannerCandidates.length >= 2;
        const routedEarlier = gemeenteTerms.length
          ? uniquePlannerCandidates.includes("cbs")
          : policyEarly
            ? uniquePlannerCandidates.some((c) => c === "cbs" || c === "tk" || c === "ob")
            : uniquePlannerCandidates.length > 0;
        const plannedPolicy = !euIntent && !multiPlanned && !routedEarlier && policySources.length > 0;
        const estimatedSources: string[] = dsoIntent
          ? ["dso_omgevingsdocumenten"]
          : debatArgs
            ? ["tweede_kamer_debatten"]
            : algoritmeIntent
              ? ["algoritmeregister"]
          : euIntent
            ? ["eu_cellar"]
            : plannedPolicy
              ? policySources
              : uniquePlannerCandidates.length
                ? uniquePlannerCandidates
                : ["data_overheid"];

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
        const tkSingleType = !multiPlanned && tkType ? tkType : undefined;
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
            default:
              return makeKeywordQuery(questionForSearch);
          }
        };

        const plannedRequests = estimatedSources.flatMap<{ connector: string; method: string; url: string; params: Record<string, unknown> }>((candidate) => candidate === "dso_omgevingsdocumenten" && dsoIntent ? dsoPlannedRequests(dsoIntent, decodedQuestion, top) : candidate === "tweede_kamer_debatten" && debatArgs ? [{
          connector: "tweede_kamer",
          method: "GET",
          url: `${config.endpoints.tweedeKamer}/Vergadering`,
          params: { ...Object.fromEntries(Object.entries(debatArgs).filter(([, v]) => v !== undefined)), question: decodedQuestion, top },
        }] : candidate === "algoritmeregister" && algoritmeIntent ? [{
          connector: "algoritmeregister",
          method: "POST",
          url: ALGORITMEREGISTER_SEARCH_ENDPOINT,
          params: { ...algoritmeIntent, question: decodedQuestion, limit: top },
        }] : [{
          connector: candidate,
          method: "GET",
          url: endpointByCandidate[candidate] ?? config.endpoints.dataOverheid,
          params: {
            // The terms the routes derive from the question, not the sentence itself.
            query: plannedPolicy && candidate !== "data_overheid" ? policyQueryFor(candidate) : routeQueryFor(candidate),
            question: decodedQuestion,
            ...(candidate === "tk" && !plannedPolicy && tkSingleType ? { type: tkSingleType } : {}),
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

      if (euIntent) try {
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

      if (dsoIntent && dsoKey) {
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

      if (debatArgs) {
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

      if (algoritmeIntent) {
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

      if (multiIntentSignal && uniquePlannerCandidates.length >= 2) {
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
              let items = out.items;

              if (!items.length) {
                for (const candidate of candidates.slice(1)) {
                  if (!candidate || !candidate.trim()) continue;
                  fallbackSteps.push(`cbs:fallback_candidate:${candidate}`);
                  out = await timed("cbs", () => cbs.searchTables(candidate, Math.max(top, 8)));
                  items = out.items;
                  if (items.length) {
                    query = candidate;
                    break;
                  }
                }
              }

              const sorted = [...items].sort((a, b) => scoreCbsTable(b) - scoreCbsTable(a));
              const records = sorted.slice(0, top).map((x) =>
                record("cbs", String(x.Title ?? x.Identifier ?? "CBS"), "https://www.cbs.nl", x),
              );
              return { connector: "cbs", records, endpoint: out.endpoint, params: out.params, total: items.length, query };
            }
            case "tk": {
              const query = tkMultiQuery;
              const out = await timed("tweede_kamer", () => tk.searchDocuments({
                query,
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

      const isSchoolHolidayQuery = q.includes("schoolvakantie") || q.includes("schoolvakanties") || q.includes("school holiday") || q.includes("school holidays");
      if (isSchoolHolidayQuery) {
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
      if (has(verkiezingTerms)) try {
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

      if (has(aanbestedingTerms)) try {
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
      if (has(tuchtrechtTerms)) try {
        const tuchtQuery = makeStrictQuery(questionForSearch) || questionForSearch;
        const out = await timed("tuchtrecht", () =>
          tuchtrecht.search({ query: tuchtQuery, date_from: temporal?.from, date_to: temporal?.to, maximumRecords: top }),
        );
        const records = out.items.map((raw) => {
          const x = raw as import("./sources/koop-collecties.js").TuchtrechtItem;
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

      if (has(gewasTerms)) try {
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

      if (has(luchtTerms)) try {
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

      if (has(catalogiTerms)) try {
        const productQuery = makeStrictQuery(questionForSearch) || questionForSearch;
        const out = await timed("samenwerkende_catalogi", () =>
          samenwerkendeCatalogi.search({ query: productQuery, maximumRecords: top }),
        );
        const records = out.items.map((raw) => {
          const x = raw as import("./sources/koop-collecties.js").SamenwerkendeCatalogiItem;
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
      // schoolTerms/examTerms carry the plural forms duoTerms lacks ("basisscholen"),
      // and word-boundary matching means those would otherwise miss entirely.
      if (has(duoTerms) || has(schoolTerms) || has(examTerms)) try {
        const gemeente = extractPlaceName(decodedQuestion);
        const wantsExam = has(examTerms);
        const wantsSchools = has(schoolTerms) || Boolean(gemeente);

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
          const sector = /middelbare|voortgezet|havo|vwo|vmbo|middelbaar/.test(q)
            ? "vo"
            : /\bmbo\b|beroepsonderwijs/.test(q)
              ? "mbo"
              : /\bhbo\b|universiteit|hogeschool|hoger onderwijs/.test(q)
                ? "ho"
                : "po";
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

      if (has(cbsTerms)) {
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
        let items = out.items;

        if (!items.length) {
          for (const candidate of candidates.slice(1)) {
            if (!candidate || !candidate.trim()) continue;
            fallbackSteps.push(`cbs:fallback_candidate:${candidate}`);
            out = await timed("cbs", () => cbs.searchTables(candidate, Math.max(top, 8)));
            items = out.items;
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

          const records = sorted.slice(0, top).map((x) => record("cbs", String(x.Title ?? x.Identifier ?? "CBS"), "https://www.cbs.nl", x));
          // items.length is de gefetchte buffer, niet de echte upstream-total, en kan
          // groter zijn dan de teruggegeven records (sorted.slice(0, top)); null zodat
          // has_more niet onterecht true wordt buiten de beschikbare records.
          return askSuccess({ summary: `Router: CBS (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, items.length), access_note: queryNote(usedCbsQuery), total: null });
        }
        routeEmpty("CBS", "cbs:no_results");
      }

      // A named municipality plus a policy or council question: its council
      // documents in Open Raadsinformatie answer it ("GGZ-beleid gemeente
      // Utrecht"); national sources would return other places' news.
      // ORI's explanation when it has no index for the municipality: that is
      // not an empty result, and the answer given instead says so.
      let oriScopeNote: string | undefined;
      if (gemeenteForOri) try {
        const gemeente = gemeenteForOri;
        if (gemeenteTerms.length) {
          const oriQuery = toOriQuery(gemeenteTerms);
          const out = await timed("ori", () => ori.search({ query: oriQuery, rows: top, gemeente }));
          const records = out.items.map(oriRecord);
          if (records.length) {
            return askSuccess({
              summary: `Router: Open Raadsinformatie ${gemeente} (${records.length} resultaten)`,
              records,
              provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total),
              access_note: mergeAccessNotes(
                queryNote(oriQuery),
                `Vraag over gemeente ${gemeente}: gezocht in de raadsinformatie van die gemeente (Open Raadsinformatie).`,
                temporal ? "De periode uit de vraag is niet toegepast: deze ORI-zoekopdracht heeft geen datumfilter." : undefined,
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

      if (has(tkTerms)) {
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
                } else if (deepRecordData.text_preview_unavailable_reason === "pdf_not_extracted_in_lean_mode") {
                  deepAccessNotes.push("Top match is a PDF; lean mode resolves the resource URL but skips built-in PDF text extraction.");
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

      if (has(obTerms)) try {
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

      if (policyIntent && policyTerms.length && policyEarly) {
        const answered = await runPolicySearch();
        if (answered) return answered;
      }

      if (has(rijkTerms)) {
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

      if (likelyBudget) {
        const budgetQuery = makeKeywordQuery(questionForSearch) || questionForSearch;
        const out = await timed("rijksbegroting", () => rijksbegroting.search(budgetQuery, top));
        const records = out.items.map((x)=>record("rijksbegroting", String(x.name ?? x.id ?? "Rijksbegroting"), String(x.url ?? "https://opendata.rijksbegroting.nl"), x));
        if (records.length) {
          return askSuccess({ summary: `Router: Rijksbegroting (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: queryNote(budgetQuery), total: out.total });
        }
        routeEmpty("Rijksbegroting", "rijksbegroting:no_results");
      }

      if (has(duoTerms)) {
        const duoQuery = makeKeywordQuery(questionForSearch) || questionForSearch;
        const out = await timed("duo", () => duo.datasetsCatalog(duoQuery, top));
        const records = out.items.map((x)=>record("duo", String(x.title ?? x.name ?? x.id ?? "DUO"), String(x.url ?? "https://onderwijsdata.duo.nl"), x));
        if (records.length) {
          return askSuccess({ summary: `Router: DUO (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: queryNote(duoQuery), total: out.total });
        }
        routeEmpty("DUO-datasets", "duo:catalog_no_results");
      }

      if (has(weatherTerms)) {
        return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI route vereist KNMI_API_KEY", suggestion: "Set KNMI_API_KEY and use knmi_* tools" }));
      }

      if (has(apiTerms)) {
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

      if (rechtspraakAsked) {
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
      if (policyIntent && policyTerms.length && !policySearched) {
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
      const recognised = triedRoutes.length > 0 || policyNote !== undefined || dsoNote !== undefined || debatNote !== undefined || algoritmeNote !== undefined;
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
    description: "Search Dutch consolidated national legislation (BWB, wetten.overheid.nl) via KOOP SRU. Keywords are matched against the law title index (overheidbwb.titel). Returns BWBR id, title, competent authority, date and a wetten.overheid.nl link. Pass title keywords only, not full sentences.",
    inputSchema: { query: z.string().describe("Law/regulation title keywords, e.g. 'arbeid vreemdelingen', 'wegenverkeerswet', 'omgevingswet'. Matched against the BWB title index (overheidbwb.titel), not full text."), top: z.number().int().min(1).max(config.limits.maxRows).default(20), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) return dryRunPayload({ connector: "wetten_bwb", url: "https://zoekservice.overheid.nl/sru/Search", params: { "x-connection": "BWB", operation: "searchRetrieve", version: "1.2", query, maximumRecords: fetchRows } });
      const started = Date.now();
      const out = await wettenBwb.search({ query, maximumRecords: fetchRows });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record("wetten-bwb", String(x.title ?? x.identifier ?? "BWB regeling"), String(x.canonical_url ?? "https://wetten.overheid.nl"), x as Record<string, unknown>, String(x.authority ?? ""), String(x.date ?? "")));
      const response = buildFormattedResponse({ summary: `${records.length} BWB wetten`, records, provenance: prov("wetten_bwb_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total), outputFormat, offset, limit: effectiveLimit, total: out.total, access_note: out.access_note, verbose: singleConnectorVerbose({ enabled: verbose, connector: "wetten_bwb", endpoint: out.endpoint, responseTimeMs }) });
      return toMcpToolPayload(response);
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "BWB wetgeving", "https://wetten.overheid.nl")); }
  });

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
    description: "Search Dutch public procurement notices and awards (TenderNed) — every tender published by Rijk, provincies, gemeenten, waterschappen, zorg- and onderwijsinstellingen. Returns contracting authority, tender name, publication type (aankondiging/gunning/marktconsultatie/vroegtijdige beëindiging), procedure, contract type, closing date and description. Use for 'welke aanbestedingen', 'wat besteedt gemeente X aan', 'wie won opdracht Y' (winner and award value: tenderned_aanbesteding_get). Search syntax is TenderNed's own: several words are combined with OR (a notice matching any one word counts), so to require an exact phrase wrap the WHOLE query in double quotes, e.g. '\"openbare verlichting\"'. Only one phrase per query works: two quoted phrases return nothing, and a phrase plus loose words is searched as plain OR. AND/OR/NOT, + and - are not operators. To limit results to one contracting authority use opdrachtgever instead of putting its name in the query. Only the first 10,000 results of any query are reachable. Closing dates: TenderNed's search index keeps the deadline of the original notice, even after a rectification moved it. For notices whose indexed deadline is in the future or at most 180 days old (up to 50 per call, latest deadlines first, within about 3 seconds; the check stops early when TenderNed's detail records answer slowly or not at all) the tool re-reads the detail record, so sluitings_datum is the current deadline (sluitings_datum_gecontroleerd: true; sluitings_datum_oorspronkelijk holds the index date when it differed). Other closing dates come unchecked from the index (sluitings_datum_gecontroleerd: false); tenderned_aanbesteding_get gives the current deadline.",
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
    description: "Get the full detail of one TenderNed procurement notice by publicatieId (publicatie_id from tenderned_aanbestedingen_search; either name is accepted): CPV codes, NUTS region, legal framework, procedure, contract start/end dates, award status and the related publications of the same procedure. Returns the same snake_case fields as the search tool (publicatie_datum, sluitings_datum, type_publicatie, ...) next to the original camelCase ones. By default also reads TenderNed's HTML rendering of the notice (Dutch or English) for the estimated value (geraamdeWaarde) and, for award notices, the winner(s), awarded values and contract dates (gunning): gunning.totaleWaarde is the value of all contracts awarded, winnaars[].waarde a winner's own value; for framework agreements gunning.raamovereenkomstMaximum (and per lot gunning.percelen[].raamovereenkomstMaximum) is a ceiling, not an awarded amount; a value shared by several winners of one lot is in gunning.percelen[].waarde, not per winner. Amounts under € 1,000 (e.g. '1 Euro') and closing dates in 2090 or later are flagged as placeholders. The closing date comes from TenderNed's metadata (sluitings_datum_bron names the field) and is the current deadline after any rectification (laatsteRectificatieId); it can differ from the deadline printed in the notice PDF and from the original deadline TenderNed's search index keeps; for a dynamic purchasing system (DAS) it may be the end date of the system. Set include_text to also extract the text of the official notice PDF (capped by max_chars).",
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
        const planned = dryRunPayload({ connector: "algoritmeregister", url: ALGORITMEREGISTER_SEARCH_ENDPOINT, params: { ...body, page: plan.pages.join(","), limit: plan.pageSize, ...(org ? { organisatie: org, organisatie_lookup: `POST ${ALGORITMEREGISTER_ORG_ENDPOINT}` } : {}) } });
        // dryRunPayload labels every request GET; the register's search is a POST with a JSON body.
        const payload = planned.structuredContent as { planned_requests?: Array<Record<string, unknown>> };
        if (payload.planned_requests?.[0]) payload.planned_requests[0].method = "POST";
        return { content: [{ type: "text" as const, text: JSON.stringify(planned.structuredContent) }], structuredContent: planned.structuredContent };
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
}
