import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, ENV_KEYS } from "./config.js";
import { DataOverheidSource } from "./sources/data-overheid.js";
import { CbsSource } from "./sources/cbs.js";
import { TweedeKamerSource } from "./sources/tweede-kamer.js";
import { BekendmakingenSource } from "./sources/bekendmakingen.js";
import { RijksoverheidSource } from "./sources/rijksoverheid.js";
import { RijksbegrotingSource } from "./sources/rijksbegroting.js";
import { DuoSource } from "./sources/duo.js";
import { ApiRegisterSource } from "./sources/api-register.js";
import { KnmiSource } from "./sources/knmi.js";
import { PdokSource } from "./sources/pdok.js";
import { OriSource } from "./sources/ori.js";
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
import { CvdrSource } from "./sources/cvdr.js";
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
import { TenderNedSource } from "./sources/tenderned.js";
import { KoopCollectieSource } from "./sources/koop-collecties.js";
import { BrpGewasperceelSource } from "./sources/brp-gewaspercelen.js";
import { VerkiezingsuitslagenSource } from "./sources/verkiezingsuitslagen.js";
import { mapSourceError, nowIso, successResponse, toMcpToolPayload, errorResponse } from "./utils/response.js";
import { parseTemporalRange } from "./utils/temporal.js";
import { applyOutputFormat } from "./utils/output-format.js";
import { getConnectorHealth } from "./utils/connector-runtime.js";
import { buildFormattedResponse, dryRunPayload, mergeAccessNotes, singleConnectorVerbose } from "./utils/tool-runner.js";
import type { MCPRecord } from "./types.js";
import { rewriteQuery } from "./utils/query-rewriter.js";
import { logger } from "./utils/logger.js";

const config = loadConfig();

/** MCP annotations shared by all tools — every tool is read-only and queries external public APIs. */
const TOOL_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true } as const;
const dataOverheid = new DataOverheidSource(config);
const cbs = new CbsSource(config);
const tk = new TweedeKamerSource(config);
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

function record(source: string, title: string, canonical_url: string, data: Record<string, unknown>, snippet?: string, date?: string): MCPRecord {
  return { source_name: source, title, canonical_url, data, snippet, date };
}

function prov(tool: string, endpoint: string, query_params: Record<string, string>, returned_results: number, total_results?: number) {
  return { tool, endpoint, query_params, timestamp: nowIso(), returned_results, total_results };
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
    try {
      const effectiveLimit = args.limit ?? args.rows;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(args.rows, args.offset + effectiveLimit));

      if (args.dryRun) {
        return dryRunPayload({
          connector: "data_overheid",
          url: `${config.endpoints.dataOverheid}/package_search`,
          params: {
            q: rw.rewritten,
            rows: fetchRows,
            sort: args.sort,
            organization: args.organization,
            theme: args.theme,
          },
        });
      }

      const started = Date.now();
      const out = await dataOverheid.datasetsSearch({
        query: rw.rewritten,
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
        access_note: out.access_note,
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

  server.registerTool("tweede_kamer_documents", { description: "Search Dutch Parliament (Tweede Kamer) documents. Use policy topic keywords. Optionally filter by document type and date range.", inputSchema: { query: z.string().describe("Policy topic keywords. Examples: 'stikstof', 'woningbouw', 'defensie budget', 'klimaat'. Do NOT pass full questions."), top: z.number().int().min(1).max(config.limits.maxRows).default(25), type: z.string().optional(), date_from: z.string().optional(), date_to: z.string().optional(), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, annotations: TOOL_ANNOTATIONS }, async ({ query, top, type, date_from, date_to, offset, limit, outputFormat, verbose, dryRun }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));

      if (dryRun) {
        return dryRunPayload({
          connector: "tweede_kamer",
          url: `${config.endpoints.tweedeKamer}/Document`,
          params: { query: rw.rewritten, top: fetchRows, type, date_from, date_to },
        });
      }

      const started = Date.now();
      const out = await tk.searchDocuments({ query: rw.rewritten, top: fetchRows, type, date_from, date_to });
      const responseTimeMs = Date.now() - started;

      const records = out.items.map((x)=>record("tweedekamer", String(x.Titel ?? x.Onderwerp ?? x.Id ?? "Document"), String(x.Url ?? x.resource_url ?? "https://www.tweedekamer.nl"), x, String(x.Onderwerp ?? ""), String(x.Datum ?? "")));
      const response = buildFormattedResponse({
        summary: `${records.length} Tweede Kamer documenten`,
        records,
        provenance: prov("tweede_kamer_documents", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), records.length),
        outputFormat,
        offset,
        limit: effectiveLimit,
        // Tweede Kamer OData search levert geen totaal-count; null i.p.v.
        // records.length zodat has_more op de records-heuristiek valt.
        total: null,
        verbose: singleConnectorVerbose({
          enabled: verbose,
          connector: "tweede_kamer",
          endpoint: out.endpoint,
          responseTimeMs,
        }),
      });
      return toMcpToolPayload(response);
    } catch(e){ return toMcpToolPayload(mapSourceError(e, "Tweede Kamer", "https://www.tweedekamer.nl")); }
  });

  server.registerTool("tweede_kamer_search", { description: "Advanced OData search on Tweede Kamer entities (Document, Zaak, Kamerstuk, etc.). Use topic keywords and optionally OData filter/orderby expressions.", inputSchema: { query: z.string().describe("Topic keywords for parliamentary search. Examples: 'zorg', 'migratie', 'onderwijs'. Do NOT pass full questions."), entity: z.string().default("Document"), top: z.number().int().min(1).max(config.limits.maxRows).default(25), filter: z.string().optional(), orderby: z.string().optional(), skip: z.number().int().min(0).optional(), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, annotations: TOOL_ANNOTATIONS }, async ({ query, entity, top, filter, orderby, skip, offset, limit, outputFormat, verbose, dryRun }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const effectiveOffset = skip ?? offset;
      const effectiveLimit = limit ?? top;

      if (dryRun) {
        return dryRunPayload({
          connector: "tweede_kamer",
          url: `${config.endpoints.tweedeKamer}/${entity}`,
          params: { query: rw.rewritten, top: effectiveLimit, filter, orderby, skip: effectiveOffset },
        });
      }

      const started = Date.now();
      const out = await tk.search({ query: rw.rewritten, entity, top: effectiveLimit, filter, orderby, skip: effectiveOffset });
      const responseTimeMs = Date.now() - started;

      const records = out.items.map((x)=>record("tweedekamer", String(x.Titel ?? x.Onderwerp ?? x.Id ?? "Result"), String(x.Url ?? "https://www.tweedekamer.nl"), x, String(x.Onderwerp ?? ""), String(x.Datum ?? x.GewijzigdOp ?? "")));
      const formatted = applyOutputFormat({ records, outputFormat });
      return toMcpToolPayload(successResponse({
        summary: `${records.length} Tweede Kamer records`,
        records,
        provenance: prov("tweede_kamer_search", out.endpoint, out.params, records.length, records.length),
        output_format: formatted.output_format,
        formatted_output: formatted.formatted_output,
        access_note: mergeAccessNotes(
          "Upstream paging toegepast via skip/top; pagination.total kan bronafhankelijk ontbreken.",
          formatted.access_note,
        ),
        pagination: {
          offset: effectiveOffset,
          limit: effectiveLimit,
          total: null,
          has_more: records.length >= effectiveLimit,
        },
        verbose: singleConnectorVerbose({
          enabled: verbose,
          connector: "tweede_kamer",
          endpoint: out.endpoint,
          responseTimeMs,
        }),
      }));
    } catch(e){ return toMcpToolPayload(mapSourceError(e, "Tweede Kamer", "https://www.tweedekamer.nl")); }
  });

  server.registerTool("tweede_kamer_document_get", { description: "Get full details of a specific Tweede Kamer document by ID. Can optionally resolve resource URLs and include text previews.", inputSchema: { id: z.string(), resolve_resource: z.boolean().default(false), include_text: z.boolean().default(false), max_chars: z.number().int().min(1).max(50000).optional() }, annotations: TOOL_ANNOTATIONS }, async ({ id, resolve_resource, include_text, max_chars }) => {
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
      } else if (include_text && r.text_preview_unavailable_reason === "pdf_not_extracted_in_lean_mode") {
        notes.push("PDF text extraction is intentionally skipped in lean mode; use the resolved resource URL for downstream PDF handling.");
      } else if (include_text && typeof r.text_preview_unavailable_reason === "string") {
        notes.push(`Text preview unavailable: ${r.text_preview_unavailable_reason}.`);
      }

      const records = [
        record(
          "tweedekamer",
          String(r.Titel ?? r.Onderwerp ?? r.Id ?? id),
          String(r.resolved_resource_url ?? r.resource_url ?? `https://www.tweedekamer.nl`),
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
    } catch(e){ return toMcpToolPayload(mapSourceError(e, "Tweede Kamer", "https://www.tweedekamer.nl")); }
  });

  server.registerTool("tweede_kamer_votes", { description: "Retrieve voting records from the Tweede Kamer. Filter by case ID (zaak_id) or date.", inputSchema: { zaak_id: z.string().optional(), date: z.string().optional(), top: z.number().int().min(1).max(config.limits.maxRows).default(100) }, annotations: TOOL_ANNOTATIONS }, async ({ zaak_id, date, top }) => {
    try { const out = await tk.getVotes({ zaak_id, date, top }); const records = out.items.map((x)=>record("tweedekamer", String(x.ActorFractie ?? x.Soort ?? x.Id ?? "Stemming"), "https://opendata.tweedekamer.nl", x, String(x.Soort ?? ""), String(x.GewijzigdOp ?? ""))); return toMcpToolPayload(successResponse({ summary: `${records.length} stemmingen`, records, provenance: prov("tweede_kamer_votes", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Tweede Kamer", "https://www.tweedekamer.nl")); }
  });

  server.registerTool("tweede_kamer_members", { description: "List current or former Tweede Kamer members. Optionally filter by parliamentary group (fractie).", inputSchema: { fractie: z.string().optional(), active: z.boolean().default(true), top: z.number().int().min(1).max(config.limits.maxRows).default(50) }, annotations: TOOL_ANNOTATIONS }, async ({ fractie, active, top }) => {
    try { const out = await tk.getMembers({ fractie, active, top }); const records = out.items.map((x)=>record("tweedekamer", String(x.name ?? x.id ?? "Kamerlid"), String(x.persoon_url ?? "https://www.tweedekamer.nl"), x, String(x.fractie ?? ""), String(x.start_date ?? ""))); return toMcpToolPayload(successResponse({ summary: `${records.length} Kamerleden`, records, provenance: prov("tweede_kamer_members", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Tweede Kamer", "https://www.tweedekamer.nl")); }
  });

  server.registerTool("officiele_bekendmakingen_search", { description: "Search Officiële Bekendmakingen (Dutch official publications: Staatscourant, Staatsblad, Kamerstukken, gemeenteblad). Use legal/policy topic keywords. Optionally filter by type, authority, and date range.", inputSchema: { query: z.string().describe("Legal or policy topic keywords. Examples: 'bestemmingsplan Rotterdam', 'subsidieregeling', 'omgevingsvergunning'. Do NOT pass full questions."), top: z.number().int().min(1).max(100).default(20), startRecord: z.number().int().min(1).default(1), type: z.string().optional(), authority: z.string().optional(), date_from: z.string().optional(), date_to: z.string().optional(), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, annotations: TOOL_ANNOTATIONS }, async ({ query, top, startRecord, type, authority, date_from, date_to, offset, limit, outputFormat, verbose, dryRun }) => {
    const rw = rewriteQuery(query, "moderate");
    const effectiveLimit = limit ?? top;
    const effectiveStartRecord = Math.max(1, startRecord + offset);

    if (dryRun) {
      return dryRunPayload({
        connector: "officiele_bekendmakingen",
        url: config.endpoints.bekendmakingenSru,
        params: {
          query: rw.rewritten,
          maximumRecords: effectiveLimit,
          startRecord: effectiveStartRecord,
          type,
          authority,
          date_from,
          date_to,
        },
      });
    }

    try {
      const started = Date.now();
      const out = await bekend.search({ query: rw.rewritten, maximumRecords: effectiveLimit, startRecord: effectiveStartRecord, type, authority, date_from, date_to });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x)=>record("officielebekendmakingen", String(x.title ?? x.titel ?? x.identifier ?? "Bekendmaking"), String(x.canonical_url ?? x.identifier ?? x.url ?? "https://zoek.officielebekendmakingen.nl"), x as Record<string, unknown>, String(x.authority ?? ""), String(x.date ?? "")));
      const formatted = applyOutputFormat({ records, outputFormat });
      return toMcpToolPayload(successResponse({
        summary: `${records.length} bekendmakingen`,
        records,
        provenance: prov("officiele_bekendmakingen_search", out.endpoint, out.params, records.length, out.total),
        pagination: {
          offset: effectiveStartRecord - 1,
          limit: effectiveLimit,
          total: out.total,
          has_more: typeof out.total === "number" ? effectiveStartRecord - 1 + records.length < out.total : records.length >= effectiveLimit,
        },
        output_format: formatted.output_format,
        formatted_output: formatted.formatted_output,
        access_note: formatted.access_note,
        verbose: singleConnectorVerbose({
          enabled: verbose,
          connector: "officiele_bekendmakingen",
          endpoint: out.endpoint,
          responseTimeMs,
        }),
      }));
    } catch (e) {
      logger.warn({ err: e, tool: "officiele_bekendmakingen_search" }, "Primary source failed, using fallback");
      const started = Date.now();
      const fallback = bekend.fallbackSearch({ query: rw.rewritten, maximumRecords: effectiveLimit, startRecord: effectiveStartRecord, type, authority, date_from, date_to });
      const responseTimeMs = Date.now() - started;
      const records = fallback.items.map((x)=>record("officielebekendmakingen", String(x.title ?? x.identifier ?? "Bekendmaking fallback"), String(x.canonical_url ?? "https://zoek.officielebekendmakingen.nl"), x as Record<string, unknown>, String(x.authority ?? ""), String(x.date ?? "")));
      const formatted = applyOutputFormat({ records, outputFormat });
      return toMcpToolPayload(successResponse({
        summary: `${records.length} bekendmakingen (fallback)`,
        records,
        provenance: prov("officiele_bekendmakingen_search", fallback.endpoint, fallback.params, records.length, fallback.total),
        pagination: {
          offset: effectiveStartRecord - 1,
          limit: effectiveLimit,
          total: fallback.total,
          has_more: false,
        },
        output_format: formatted.output_format,
        formatted_output: formatted.formatted_output,
        access_note: mergeAccessNotes(fallback.access_note, formatted.access_note),
        verbose: singleConnectorVerbose({
          enabled: verbose,
          connector: "officiele_bekendmakingen",
          endpoint: fallback.endpoint,
          responseTimeMs,
        }),
      }));
    }
  });

  server.registerTool("officiele_bekendmakingen_record_get", { description: "Get a specific official publication (bekendmaking) by its identifier.", inputSchema: { identifier: z.string() }, annotations: TOOL_ANNOTATIONS }, async ({ identifier }) => {
    try {
      const out = await bekend.getRecord(identifier);
      const r = out.item;
      const records = [record("officielebekendmakingen", String(r.title ?? r.identifier ?? identifier), String(r.canonical_url ?? `https://zoek.officielebekendmakingen.nl/${identifier}`), r, String(r.authority ?? ""), String(r.date ?? ""))];
      return toMcpToolPayload(successResponse({ summary: `Bekendmaking ${identifier}`, records, provenance: prov("officiele_bekendmakingen_record_get", out.endpoint, out.params, 1, 1) }));
    } catch (e) {
      logger.warn({ err: e, tool: "officiele_bekendmakingen_record_get", identifier }, "Primary source failed, using fallback");
      const fallback = bekend.fallbackGet(identifier);
      const r = fallback.item;
      const records = [record("officielebekendmakingen", String(r.title ?? r.identifier ?? identifier), String(r.canonical_url ?? `https://zoek.officielebekendmakingen.nl/${identifier}`), r, String(r.authority ?? ""), String(r.date ?? ""))];
      return toMcpToolPayload(successResponse({ summary: `Bekendmaking ${identifier} (fallback)`, records, provenance: prov("officiele_bekendmakingen_record_get", fallback.endpoint, fallback.params, 1, 1), access_note: fallback.access_note }));
    }
  });

  server.registerTool("rijksoverheid_search", { description: "Search Rijksoverheid.nl content via the government's RSS search platform. Server-side keyword search returns up to ~20 results per query (no pagination). Use topic keywords. type='news' returns news only; type='all' returns news + documents + press releases.", inputSchema: { query: z.string().describe("Government topic keywords. Examples: 'energietransitie', 'pensioenwet', 'toeslagen'. Do NOT pass full questions."), top: z.number().int().min(1).max(config.limits.maxRows).default(20), type: z.enum(["news", "all"]).optional().default("news").describe("'news' = only news documents; 'all' = news + policy documents + press releases. The platform returns at most ~20 items per query."), date_from: z.string().optional(), date_to: z.string().optional(), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, annotations: TOOL_ANNOTATIONS }, async ({ query, top, type, date_from, date_to, offset, limit, outputFormat, verbose, dryRun }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));

      if (dryRun) {
        return dryRunPayload({
          connector: "rijksoverheid",
          url: config.endpoints.rijksoverheid,
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
        total: out.total,
        access_note: out.access_note,
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
    try {
      const effectiveLimit = limit ?? rows;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(rows, offset + effectiveLimit));

      if (dryRun) {
        return dryRunPayload({
          connector: "duo",
          url: `${config.endpoints.duoDatasets}/api/3/action/package_search`,
          params: { q: rw.rewritten, rows: fetchRows },
        });
      }

      const started = Date.now();
      const out = await duo.datasetsCatalog(rw.rewritten, fetchRows);
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
    try { const out = await duo.rioSearch(rw.rewritten, top); const records = out.items.map((x)=>record("duo-rio", String(x.naam ?? x.name ?? x.id ?? "RIO"), String(x.url ?? "https://duo.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} RIO resultaten`, records, provenance: prov("duo_rio_search", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "DUO RIO", "https://lod.onderwijsregistratie.nl")); }
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
        access_note: "Requires OVERHEID_API_KEY",
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
    try { const out = await new KnmiSource(config, apiKey).datasets(); const records = out.items.map((x)=>record("knmi", String(x.name ?? x.datasetName ?? "KNMI dataset"), "https://developer.dataplatform.knmi.nl", x)); return toMcpToolPayload(successResponse({ summary: `${records.length} KNMI datasets`, records, provenance: prov("knmi_datasets", out.endpoint, out.params, records.length, records.length), access_note: "Requires KNMI_API_KEY" })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "KNMI")); }
  });

  server.registerTool("knmi_search_datasets", { description: "Search KNMI weather datasets by keyword. Requires KNMI_API_KEY.", inputSchema: { query: z.string().optional() }, annotations: TOOL_ANNOTATIONS }, async ({ query }) => {
    const apiKey = process.env[ENV_KEYS.KNMI_API_KEY];
    if (!apiKey) return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI_API_KEY ontbreekt", suggestion: "Set KNMI_API_KEY to use KNMI tools" }));
    try { const out = await new KnmiSource(config, apiKey).searchDatasets(query); const records = out.items.map((x)=>record("knmi", String(x.name ?? x.datasetName ?? "KNMI dataset"), "https://developer.dataplatform.knmi.nl", x)); return toMcpToolPayload(successResponse({ summary: `${records.length} KNMI dataset matches`, records, provenance: prov("knmi_search_datasets", out.endpoint, out.params, records.length, records.length), access_note: "Requires KNMI_API_KEY" })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "KNMI")); }
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

  server.registerTool("ori_search", { inputSchema: { query: z.string().describe("Municipal governance topic keywords. Examples: 'parkeerbeleid', 'bestemmingsplan', 'raadsvergadering woningbouw'. Do NOT pass full questions."), sort: z.enum(["relevance", "date_newest"]).default("relevance").describe("Use 'date_newest' when user asks for recent/latest council documents. Use 'relevance' for general searches."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20), bestuurslaag: z.string().optional() }, description: "Search Open Raadsinformatie (ORI) — Dutch municipal council documents, motions, and decisions. Use policy topic keywords. Use 'sort' parameter for recency.", annotations: TOOL_ANNOTATIONS }, async ({ query, sort, rows, bestuurslaag }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const out = await ori.search({ query: rw.rewritten, rows, sort, bestuurslaag });
      const records = out.items.map((x) => record("ori", String(x.title ?? x.id ?? "ORI item"), String(x.url ?? "https://www.openraadsinformatie.nl"), x, String(x.type ?? ""), String(x.publishedAt ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} ORI resultaten`, records, provenance: prov("ori_search", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "ORI", "https://www.openraadsinformatie.nl"));
    }
  });

  server.registerTool("ndw_search", { inputSchema: { query: z.string().describe("Traffic data topic keywords. Examples: 'verkeersdrukte A2', 'snelheid', 'filedata'. Do NOT pass full questions."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search NDW open traffic data (Dutch road network). Use traffic topic or road keywords.", annotations: TOOL_ANNOTATIONS }, async ({ query, rows }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const out = await ndw.search({ query: rw.rewritten, rows });
      const records = out.items.map((x) => record("ndw", String(x.title ?? x.id ?? "NDW item"), String(x.url ?? "https://www.ndw.nu"), x, String(x.description ?? ""), String(x.updated_at ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} NDW resultaten`, records, provenance: prov("ndw_search", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
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
        return toMcpToolPayload(successResponse({ summary: `${records.length} RDW resultaten`, records, provenance: prov("rdw_open_data_search", live.endpoint, live.params, records.length, live.total), access_note: (live as { access_note?: string }).access_note }));
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
      return toMcpToolPayload(successResponse({ summary: `${records.length} RWS waterdata resultaten`, records, provenance: prov("rijkswaterstaat_waterdata_search", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Rijkswaterstaat Waterdata", "https://waterinfo.rws.nl"));
    }
  });

  server.registerTool("rijkswaterstaat_waterdata_measurements", { inputSchema: { query: z.string().describe("Water measurement query with optional location. Examples: 'waterstand Maas', 'golfhoogte Noordzee', 'debiet Rijn', 'waterstand Lobith', 'temperatuur IJsselmeer'. Combine a measurement type with an optional location name."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Get latest real-time water measurements (water levels, waves, flow, temperature) from Rijkswaterstaat stations. Returns actual measured values with timestamps.", annotations: TOOL_ANNOTATIONS }, async ({ query, rows }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const out = await rwsWaterdata.latestMeasurements({ query: rw.rewritten, rows });
      const records = out.items.map((x) => record("rijkswaterstaat-waterdata", `${x.location_name} – ${x.measurement_type}`, "https://waterinfo.rws.nl", x as Record<string, unknown>, `${x.value ?? "?"} ${x.unit}`));
      return toMcpToolPayload(successResponse({ summary: `${records.length} RWS metingen (${out.totalBeforeFilter ?? records.length} stations totaal)`, records, provenance: prov("rijkswaterstaat_waterdata_measurements", out.endpoint, out.params, records.length, out.totalBeforeFilter ?? out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Rijkswaterstaat Waterdata", "https://waterinfo.rws.nl"));
    }
  });

  server.registerTool("ngr_discovery_search", { inputSchema: { query: z.string().describe("Geo/spatial data topic keywords. Examples: 'bodemkaart', 'hoogtemodel', 'kadastrale grenzen', 'natura 2000'. Do NOT pass full questions."), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search Nationaal GeoRegister (NGR) for geospatial metadata (maps, WMS/WFS services). Use spatial data topic keywords.", annotations: TOOL_ANNOTATIONS }, async ({ query, rows }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const out = await ngr.search({ query: rw.rewritten, rows });
      const records = out.items.map((x) => record("ngr", String(x.title ?? x.id ?? "NGR metadata"), String(x.url ?? "https://www.nationaalgeoregister.nl"), x as Record<string, unknown>));
      return toMcpToolPayload(successResponse({ summary: `${records.length} NGR metadata records`, records, provenance: prov("ngr_discovery_search", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Nationaal GeoRegister", "https://www.nationaalgeoregister.nl"));
    }
  });

  server.registerTool(
    "dso_omgevingsdocumenten_search",
    {
      description:
        "Discovery-only search for DSO Omgevingsdocumenten (omgevingsplannen, omgevingsvisies, programma's, omgevingsverordeningen) onder de Omgevingswet. Returns metadata only (id, titel, type, bevoegd gezag, geldigheidsdatums, viewer-link), geen juridische tekst. Requires DSO_API_KEY.",
      inputSchema: {
        query: z.string().optional().describe("Optionele vrije tekst (matched op titel, citeertitel, opschrift, bevoegd gezag). Bijv. 'omgevingsvisie Utrecht'."),
        bevoegdGezag: z.string().optional().describe("TOOI-code van het bevoegd gezag, bijv. 'gm0344' (Utrecht), 'pv24' (Utrecht provincie). Zie identifier.overheid.nl/tooi."),
        typeBevoegdGezag: z.enum(["gemeente", "provincie", "waterschap", "ministerie"]).optional().describe("Filter op bestuurslaag."),
        documentType: z.enum(["omgevingsplan", "omgevingsvisie", "programma", "omgevingsverordening"]).optional().describe("Filter op documenttype (client-side filter op type.waarde)."),
        rows: z.number().int().min(1).max(config.limits.maxRows).default(20),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async ({ query, bevoegdGezag, typeBevoegdGezag, documentType, rows }) => {
      const apiKey = process.env[ENV_KEYS.DSO_API_KEY];
      if (!apiKey) {
        return toMcpToolPayload(
          errorResponse({
            error: "not_configured",
            message: "DSO_API_KEY ontbreekt",
            suggestion:
              "Vraag een sleutel aan via https://developer.omgevingswet.overheid.nl/formulieren/api-key-aanvragen-0/ en zet DSO_API_KEY. Lees-only PDOK-tegeldata is geen alternatief; vector tiles bevatten geen documentmetadata.",
          }),
        );
      }
      try {
        const { DsoOmgevingsdocumentenSource } = await import("./sources/dso-omgevingsdocumenten.js");
        const src = new DsoOmgevingsdocumentenSource(config, apiKey);
        const out = await src.search({ query, bevoegdGezag, typeBevoegdGezag, documentType, rows });
        const records = out.items.map((x) =>
          record(
            "dso_omgevingsdocumenten",
            x.title,
            x.viewerUrl,
            { ...x, raw: undefined },
            x.documentType,
            x.beginGeldigheid ?? x.beginInwerking,
          ),
        );
        return toMcpToolPayload(
          successResponse({
            summary: `${records.length} DSO omgevingsdocumenten`,
            records,
            provenance: prov("dso_omgevingsdocumenten_search", out.endpoint, out.query, records.length, out.total),
            access_note:
              "Bron: DSO Omgevingsdocumenten Presenteren API v8 (read-only). Filters op documentType worden client-side toegepast op de eerste pagina; verfijn met bevoegdGezag of typeBevoegdGezag voor scherpere resultaten.",
          }),
        );
      } catch (e) {
        return toMcpToolPayload(mapSourceError(e, "DSO Omgevingsdocumenten", "https://omgevingswet.overheid.nl/regels-op-de-kaart/viewer"));
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
      return toMcpToolPayload(successResponse({ summary: `${records.length} RIVM discovery resultaten`, records, provenance: prov("rivm_discovery_search", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
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
    return toMcpToolPayload(successResponse({ summary: `${records.length} Eurostat dataset suggesties`, records, provenance: prov("eurostat_datasets_search", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
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
      return toMcpToolPayload(successResponse({ summary: `${records.length} data.europa.eu datasets`, records, provenance: prov("data_europa_datasets_search", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch {
      const out = dataEuropa.fallback({ query, rows });
      const records = out.items.map((x) => record("data-europa", String(x.title ?? x.id ?? "Dataset"), String(x.url ?? "https://data.europa.eu/data"), x as Record<string, unknown>, String(x.notes ?? ""), String(x.metadata_modified ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} data.europa.eu fallback datasets`, records, provenance: prov("data_europa_datasets_search", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
    }
  });

  server.registerTool("nl_gov_ask", { inputSchema: { question: z.string(), top: z.number().int().min(1).max(config.limits.maxRows).default(10), reference_now: z.string().optional(), timezone: z.string().optional(), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, description: "Smart router that interprets a natural-language question about Dutch government data and queries the most relevant source(s). Supports temporal expressions in Dutch and English (e.g. 'vorige week', 'since 2020'). Use this when the best source is unclear.", annotations: TOOL_ANNOTATIONS }, async ({ question, top, reference_now, timezone, offset, limit, outputFormat, verbose, dryRun }) => {
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

    const makeKeywordQuery = (input: string, _maxTerms = 6): string =>
      rewriteQuery(input, "moderate").rewritten;

    const makeStrictQuery = (input: string): string =>
      rewriteQuery(input, "strict").rewritten;

    const makeCbsQuery = (input: string): string => makeKeywordQuery(input, 6);
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
      failures?: NonNullable<ReturnType<typeof successResponse>["failures"]>;
      total?: number | null;
    }) =>
      toMcpToolPayload(
        {
          ...buildFormattedResponse({
            summary: args.summary,
            records: args.records,
            provenance: args.provenance,
            outputFormat,
            offset,
            limit: effectiveLimit,
            total: args.total,
            access_note: args.access_note,
            failures: args.failures,
          }),
          verbose: buildVerbose(),
        },
      );

    const cbsTerms = ["cbs", "statistiek", "statistieken", "statistics", "bevolking", "population", "inwoner", "inwoners", "inflatie", "werkloos", "werkloosheid", "woning", "woningen", "inkomen", "inkomens", "economie", "bbp", "gdp", "import", "export", "geboorte", "geboortes", "sterfte", "opleidingsniveau", "opleiding", "onderwijsniveau", "emissie", "emissies"];
    const tkTerms = ["tweede kamer", "parlement", "motie", "moties", "amendement", "amendementen", "kamerstuk", "kamerstukken", "kamervraag", "kamervragen", "debat", "debatten", "stemming", "stemmingen", "fractie", "fracties", "commissie", "commissies", "wetsvoorstel", "wetsvoorstellen", "kamerlid", "kamerleden", "minister-president", "premier"];
    const obTerms = ["staatsblad", "staatscourant", "tractatenblad", "gemeenteblad", "bekendmaking", "bekendmakingen", "verordening", "verordeningen", "regeling", "regelingen", "officieel besluit", "officiele publicatie", "officiële publicatie", "stcrt", "gmb"];
    const rijkTerms = ["rijksoverheid", "kabinet", "minister", "ministerie", "beleid", "toespraak", "schoolvakantie", "schoolvakanties", "school holiday", "school holidays", "vakantie regio"];
    const budgetTerms = ["begroting", "begrotingen", "rijksbegroting", "budget", "uitgaven", "spending", "rijksfinanci", "begrotingsartikel", "defensie-uitgaven"];
    const duoTerms = ["school", "scholen", "leerling", "leerlingen", "student", "studenten", "leraar", "leraren", "docent", "docenten", "teacher", "onderwijs", "education", "slagingspercentage", "slagingspercentages", "examen", "examens", "diploma", "diplomas", "duo", "basisschool", "basisscholen", "middelbare", "mbo", "hbo", "universiteit", "universiteiten"];
    const weatherTerms = ["weer", "weather", "temperatuur", "rain", "regen", "wind", "storm", "klimaat", "earthquake", "aardbeving", "seismologie"];
    const apiTerms = ["welke api", "which api", "is er een api", "data over", "api heeft"];
    const rechtspraakTerms = ["jurisprudentie", "rechtspraak", "rechtszaak", "rechtszaken", "rechterlijke uitspraak", "rechterlijk", "ecli", "vonnis", "vonnissen", "arrest", "arresten", "beschikking", "gerechtshof", "rechtbank", "raad van state", "hoge raad", "gesanctioneerd", "sanctie", "sancties", "handhaving", "boete", "overtreding", "beroep", "bezwaar", "uitspraak", "tuchtrecht", "bestuursrecht"];
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
      if (has(rechtspraakTerms)) plannerCandidates.push("rechtspraak");

      const uniquePlannerCandidates = Array.from(new Set(plannerCandidates));
      const multiIntentSignal = explicitMulti || implicitMulti || uniquePlannerCandidates.length >= 2;

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
        };

        const estimatedSources = uniquePlannerCandidates.length
          ? uniquePlannerCandidates
          : ["data_overheid"];

        const plannedRequests = estimatedSources.map((candidate) => ({
          connector: candidate,
          method: "GET",
          url: endpointByCandidate[candidate] ?? config.endpoints.dataOverheid,
          params: {
            query: questionForSearch,
            top,
            ...(temporal ? { date_from: temporal.from, date_to: temporal.to } : {}),
          },
        }));

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

              let out = await timed("cbs", () => cbs.searchTables(candidates[0] || questionForSearch, Math.max(top, 8)));
              let items = out.items;

              if (!items.length) {
                for (const candidate of candidates.slice(1)) {
                  if (!candidate || !candidate.trim()) continue;
                  fallbackSteps.push(`cbs:fallback_candidate:${candidate}`);
                  out = await timed("cbs", () => cbs.searchTables(candidate, Math.max(top, 8)));
                  items = out.items;
                  if (items.length) break;
                }
              }

              const sorted = [...items].sort((a, b) => scoreCbsTable(b) - scoreCbsTable(a));
              const records = sorted.slice(0, top).map((x) =>
                record("cbs", String(x.Title ?? x.Identifier ?? "CBS"), "https://www.cbs.nl", x),
              );
              return { connector: "cbs", records, endpoint: out.endpoint, params: out.params, total: items.length };
            }
            case "tk": {
              const out = await timed("tweede_kamer", () => tk.searchDocuments({
                query: makeKeywordQuery(questionForSearch, 5) || questionForSearch,
                top,
                date_from: temporal?.from,
                date_to: temporal?.to,
              }));
              const records = out.items.map((x) =>
                record("tweedekamer", String(x.Titel ?? x.Id ?? "Document"), String(x.Url ?? x.resource_url ?? "https://www.tweedekamer.nl"), x),
              );
              return { connector: "tweede_kamer", records, endpoint: out.endpoint, params: out.params, total: out.items.length };
            }
            case "ob": {
              const out = await timed("officiele_bekendmakingen", () => bekend.search({
                query: questionForSearch,
                maximumRecords: top,
                date_from: temporal?.from,
                date_to: temporal?.to,
              }));
              const records = out.items.map((x) =>
                record(
                  "officielebekendmakingen",
                  String(x.title ?? x.identifier ?? "Bekendmaking"),
                  String(x.canonical_url ?? x.identifier ?? "https://zoek.officielebekendmakingen.nl"),
                  x as Record<string, unknown>,
                ),
              );
              return { connector: "officiele_bekendmakingen", records, endpoint: out.endpoint, params: out.params, total: out.total };
            }
            case "rijk": {
              const out = await timed("rijksoverheid", () => rijksoverheid.search({
                query: makeKeywordQuery(questionForSearch, 5) || questionForSearch,
                top,
                date_from: temporal?.from,
                date_to: temporal?.to,
              }));
              const records = out.items.map((x) =>
                record("rijksoverheid", String(x.title ?? x.id ?? "Rijksoverheid"), String(x.canonical ?? x.url ?? "https://www.rijksoverheid.nl"), x),
              );
              return { connector: "rijksoverheid", records, endpoint: out.endpoint, params: out.params, total: out.total };
            }
            case "budget": {
              const out = await timed("rijksbegroting", () => rijksbegroting.search(makeKeywordQuery(questionForSearch, 5) || questionForSearch, top));
              const records = out.items.map((x) =>
                record("rijksbegroting", String(x.name ?? x.id ?? "Rijksbegroting"), String(x.url ?? "https://opendata.rijksbegroting.nl"), x),
              );
              return { connector: "rijksbegroting", records, endpoint: out.endpoint, params: out.params, total: out.total };
            }
            case "duo": {
              const out = await timed("duo", () => duo.datasetsCatalog(makeKeywordQuery(questionForSearch, 5) || questionForSearch, top));
              const records = out.items.map((x) =>
                record("duo", String(x.title ?? x.name ?? x.id ?? "DUO"), String(x.url ?? "https://onderwijsdata.duo.nl"), x),
              );
              return { connector: "duo", records, endpoint: out.endpoint, params: out.params, total: out.total };
            }
            case "api": {
              const apiKey = process.env[ENV_KEYS.OVERHEID_API_KEY];
              if (!apiKey) throw new Error("OVERHEID_API_KEY is not set");
              const out = await timed("api_register", () => new ApiRegisterSource(config, apiKey).search(makeKeywordQuery(questionForSearch, 4) || questionForSearch, top));
              const records = out.items.map((x) =>
                record("api-register", String(x.name ?? x.title ?? x.id ?? "API"), String(x.portalUrl ?? x.url ?? "https://apis.developer.overheid.nl"), x),
              );
              return { connector: "api_register", records, endpoint: out.endpoint, params: out.params, total: out.items.length };
            }
            case "rechtspraak": {
              const rq = makeStrictQuery(questionForSearch) || questionForSearch;
              const out = await timed("rechtspraak", () => rechtspraak.searchEcli({ query: rq, rows: top, sort: "relevance" }));
              const records = out.items
                .filter((x) => Boolean(x.ecli))
                .map((x) =>
                  record("rechtspraak", String(x.title ?? x.ecli ?? x.id ?? "Rechtspraak uitspraak"), String(x.link ?? x.id ?? "https://data.rechtspraak.nl"), x as Record<string, unknown>, String(x.summary ?? x.ecli ?? ""), String(x.updated ?? "")),
                );
              return { connector: "rechtspraak", records, endpoint: out.endpoint, params: out.params, total: out.total };
            }
          }
        };

        const settled = await Promise.allSettled(runnableCandidates.map((c) => runCandidate(c)));

        const mergedRecordsRaw: MCPRecord[] = [];
        const successfulConnectors: string[] = [];

        settled.forEach((result, idx) => {
          const candidate = runnableCandidates[idx];

          if (result.status === "fulfilled") {
            const out = result.value;
            successfulConnectors.push(out.connector);

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

          const mapped = mapSourceError(result.reason, connectorLabelMap[candidate] ?? candidate);
          failures.push({
            connector: candidate === "api" ? "api_register" : candidate,
            error_type: mapped.error,
            message: mapped.message,
          });
        });

        const mergedRecords = dedupeMergedRecords(mergedRecordsRaw);
        const dedupedCount = mergedRecordsRaw.length - mergedRecords.length;

        if (mergedRecords.length) {
          const notes: string[] = [];
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

        if (failures.length) {
          return toMcpToolPayload(errorResponse({
            error: failures[0]?.error_type ?? "unexpected",
            message: `Alle geselecteerde bronnen faalden: ${failures.map((f) => `${f.connector} (${f.error_type})`).join(", ")}`,
            details: { failures },
          }));
        }
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
      } catch {
        // One dead upstream must not sink the router — fall through to the next source.
        fallbackSteps.push("verkiezingsuitslagen:search_failed");
      }

      if (has(aanbestedingTerms)) try {
        const tenderQuery = makeKeywordQuery(questionForSearch, 5) || questionForSearch;
        const out = await timed("tenderned", () =>
          tenderned.search({ query: tenderQuery, rows: Math.min(top, 100), datumVanaf: temporal?.from, datumTot: temporal?.to }),
        );
        const records = out.items.map((x) => record(
          "tenderned",
          x.title,
          x.url,
          { publicatie_id: x.id, opdrachtgever: x.opdrachtgever, publicatie_datum: x.publicatieDatum, sluitings_datum: x.sluitingsDatum, type_publicatie: x.typePublicatie, procedure: x.procedure, type_opdracht: x.typeOpdracht, beschrijving: x.beschrijving },
          `${x.opdrachtgever}${x.typePublicatie ? ` — ${x.typePublicatie}` : ""}`.trim(),
          x.publicatieDatum,
        ));
        if (records.length) {
          return askSuccess({ summary: `Router: TenderNed (${records.length} publicaties)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: out.access_note, total: out.total });
        }
      } catch {
        fallbackSteps.push("tenderned:search_failed");
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
          return askSuccess({ summary: `Router: Tuchtrecht (${records.length} uitspraken)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: out.access_note, total: out.total });
        }
      } catch {
        fallbackSteps.push("tuchtrecht:search_failed");
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
        }
      } catch {
        fallbackSteps.push("brp_gewaspercelen:search_failed");
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
      } catch {
        fallbackSteps.push("luchtmeetnet:search_failed");
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
          return askSuccess({ summary: `Router: Samenwerkende Catalogi (${records.length} productbeschrijvingen)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: out.access_note, total: out.total });
        }
      } catch {
        fallbackSteps.push("samenwerkende_catalogi:search_failed");
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
      } catch {
        // Falls through to the DUO dataset-catalogue branch further down.
        fallbackSteps.push("duo:per_school_search_failed");
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

        let out = await timed("cbs", () => cbs.searchTables(candidates[0] || questionForSearch, Math.max(top, 8)));
        let items = out.items;

        if (!items.length) {
          for (const candidate of candidates.slice(1)) {
            if (!candidate || !candidate.trim()) continue;
            fallbackSteps.push(`cbs:fallback_candidate:${candidate}`);
            out = await timed("cbs", () => cbs.searchTables(candidate, Math.max(top, 8)));
            items = out.items;
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
                    access_note: trendMeasure ? `CBS trend enrichment applied for measure ${trendMeasure} (previous_period, previous_value, delta, delta_pct).` : undefined,
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
          return askSuccess({ summary: `Router: CBS (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, items.length), total: null });
        }
      }

      if (has(tkTerms)) {
        const tkCandidates = [makeKeywordQuery(questionForSearch, 5), questionForSearch];
        if (q.includes("motie") || q.includes("moties")) tkCandidates.push("motie");
        if (q.includes("stikstof")) tkCandidates.push("motie stikstof");

        let out = await timed("tweede_kamer", () => tk.searchDocuments({ query: tkCandidates[0] || questionForSearch, top, date_from: temporal?.from, date_to: temporal?.to }));
        let records = out.items.map((x)=>record("tweedekamer", String(x.Titel ?? x.Id ?? "Document"), String(x.Url ?? x.resource_url ?? "https://www.tweedekamer.nl"), x));

        if (!records.length) {
          for (const candidate of tkCandidates.slice(1)) {
            if (!candidate || !candidate.trim()) continue;
            fallbackSteps.push(`tweede_kamer:fallback_candidate:${candidate}`);
            out = await timed("tweede_kamer", () => tk.searchDocuments({ query: candidate, top, date_from: temporal?.from, date_to: temporal?.to }));
            records = out.items.map((x)=>record("tweedekamer", String(x.Titel ?? x.Id ?? "Document"), String(x.Url ?? x.resource_url ?? "https://www.tweedekamer.nl"), x));
            if (records.length) break;
          }
        }

        if (records.length) {
          const shouldDeepen = shouldDeepenTweedeKamerQuery(decodedQuestion);
          if (shouldDeepen) {
            const topMatch = out.items.find((item) => typeof item.Id === "string" && item.Id.trim()) as Record<string, unknown> | undefined;
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
                  String(deepRecordData.Titel ?? deepRecordData.Onderwerp ?? deepRecordData.Id ?? topMatchId),
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
                  provenance: prov("nl_gov_ask", deepOut.endpoint, { ...out.params, deep_document_id: topMatchId }, records.length, records.length),
                  total: records.length,
                  access_note: deepAccessNotes.join(" "),
                });
              } catch {
                fallbackSteps.push(`tweede_kamer:deep_fetch_failed:${topMatchId}`);
              }
            }
          }

          return askSuccess({ summary: `Router: Tweede Kamer (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, records.length), total: records.length });
        }
      }

      if (has(obTerms)) {
        const out = await timed("officiele_bekendmakingen", () => bekend.search({ query: questionForSearch, maximumRecords: top, date_from: temporal?.from, date_to: temporal?.to }));
        const records = out.items.map((x)=>record("officielebekendmakingen", String(x.title ?? x.identifier ?? "Bekendmaking"), String(x.canonical_url ?? x.identifier ?? "https://zoek.officielebekendmakingen.nl"), x as Record<string, unknown>));
        if (records.length) {
          return askSuccess({ summary: `Router: Bekendmakingen (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), total: out.total });
        }
      }

      if (has(rijkTerms)) {
        const rijkQuery = makeKeywordQuery(questionForSearch, 5) || questionForSearch;
        let out = await timed("rijksoverheid", () => rijksoverheid.search({ query: rijkQuery, top, date_from: temporal?.from, date_to: temporal?.to }));
        let records = out.items.map((x)=>record("rijksoverheid", String(x.title ?? x.id ?? "Rijksoverheid"), String(x.canonical ?? x.url ?? "https://www.rijksoverheid.nl"), x));

        if (!records.length && (q.includes("schoolvakantie") || q.includes("schoolvakanties"))) {
          fallbackSteps.push("rijksoverheid:search:fallback_schoolvakantie");
          out = await timed("rijksoverheid", () => rijksoverheid.search({ query: "schoolvakantie", top }));
          records = out.items.map((x)=>record("rijksoverheid", String(x.title ?? x.id ?? "Rijksoverheid"), String(x.canonical ?? x.url ?? "https://www.rijksoverheid.nl"), x));
        }

        if (records.length) {
          return askSuccess({ summary: `Router: Rijksoverheid (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), total: out.total });
        }
      }

      if (likelyBudget) {
        const budgetQuery = makeKeywordQuery(questionForSearch, 5) || questionForSearch;
        const out = await timed("rijksbegroting", () => rijksbegroting.search(budgetQuery, top));
        const records = out.items.map((x)=>record("rijksbegroting", String(x.name ?? x.id ?? "Rijksbegroting"), String(x.url ?? "https://opendata.rijksbegroting.nl"), x));
        if (records.length) {
          return askSuccess({ summary: `Router: Rijksbegroting (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), total: out.total });
        }
      }

      if (has(duoTerms)) {
        const duoQuery = makeKeywordQuery(questionForSearch, 5) || questionForSearch;
        const out = await timed("duo", () => duo.datasetsCatalog(duoQuery, top));
        const records = out.items.map((x)=>record("duo", String(x.title ?? x.name ?? x.id ?? "DUO"), String(x.url ?? "https://onderwijsdata.duo.nl"), x));
        if (records.length) {
          return askSuccess({ summary: `Router: DUO (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), total: out.total });
        }
      }

      if (has(weatherTerms)) {
        return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI route vereist KNMI_API_KEY", suggestion: "Set KNMI_API_KEY and use knmi_* tools" }));
      }

      if (has(apiTerms)) {
        const apiKey = process.env[ENV_KEYS.OVERHEID_API_KEY];
        if (!apiKey) {
          return toMcpToolPayload(errorResponse({ error: "not_configured", message: "OVERHEID_API_KEY ontbreekt voor API-register queries", suggestion: "Set OVERHEID_API_KEY" }));
        }
        const apiQuery = makeKeywordQuery(questionForSearch, 4) || questionForSearch;
        try {
          const out = await timed("api_register", () => new ApiRegisterSource(config, apiKey).search(apiQuery, top));
          const records = out.items.map((x)=>record("api-register", String(x.name ?? x.title ?? x.id ?? "API"), String(x.portalUrl ?? x.url ?? "https://apis.developer.overheid.nl"), x));
          if (records.length) {
            return askSuccess({ summary: `Router: API Register (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, records.length), access_note: "Requires OVERHEID_API_KEY", total: records.length });
          }
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

      if (has(rechtspraakTerms)) {
        const rq = makeStrictQuery(questionForSearch) || questionForSearch;
        try {
          const out = await timed("rechtspraak", () => rechtspraak.searchEcli({ query: rq, rows: top, sort: "relevance" }));
          const records = out.items
            .filter((x) => Boolean(x.ecli))
            .map((x) => record("rechtspraak", String(x.title ?? x.ecli ?? x.id ?? "Rechtspraak uitspraak"), String(x.link ?? x.id ?? "https://data.rechtspraak.nl"), x as Record<string, unknown>, String(x.summary ?? x.ecli ?? ""), String(x.updated ?? "")));
          if (records.length) {
            return askSuccess({ summary: `Router: Rechtspraak (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note, total: out.total });
          }
        } catch {
          fallbackSteps.push("rechtspraak:search_failed");
        }
      }

      const out = await timed("data_overheid", () => dataOverheid.datasetsSearch({ query: questionForSearch, rows: top }));
      const records = out.items.map((d) => record("data.overheid.nl", String(d.title ?? d.id), `https://data.overheid.nl/dataset/${d.id}`, d as unknown as Record<string, unknown>, d.notes, d.metadata_modified));
      return askSuccess({ summary: `Router fallback: data.overheid (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.query, records.length, out.total), total: out.total });
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
    description: "Search Dutch decentralised/local regulations (CVDR: municipal, provincial and water-authority bylaws) via KOOP SRU. Keywords match the 'keyword' index. Returns CVDR id, title, issuing municipality/authority, date and a lokaleregelgeving.overheid.nl link. Pass topic keywords only.",
    inputSchema: { query: z.string().describe("Local-regulation topic keywords, e.g. 'hondenbelasting', 'parkeerverordening', 'afvalstoffenheffing'. Matched against the CVDR 'keyword' index."), top: z.number().int().min(1).max(config.limits.maxRows).default(20), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun) return dryRunPayload({ connector: "cvdr", url: "https://zoekservice.overheid.nl/sru/Search", params: { "x-connection": "cvdr", operation: "searchRetrieve", version: "1.2", query, maximumRecords: fetchRows } });
      const started = Date.now();
      const out = await cvdr.search({ query, maximumRecords: fetchRows });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record("cvdr", String(x.title ?? x.identifier ?? "CVDR regeling"), String(x.canonical_url ?? "https://lokaleregelgeving.overheid.nl"), x as Record<string, unknown>, String(x.gemeente ?? ""), String(x.date ?? "")));
      const response = buildFormattedResponse({ summary: `${records.length} CVDR regelingen`, records, provenance: prov("cvdr_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total), outputFormat, offset, limit: effectiveLimit, total: out.total, access_note: out.access_note, verbose: singleConnectorVerbose({ enabled: verbose, connector: "cvdr", endpoint: out.endpoint, responseTimeMs }) });
      return toMcpToolPayload(response);
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "CVDR lokale regelgeving", "https://lokaleregelgeving.overheid.nl")); }
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
      "Search the Dutch government organisation register (ROO / TOOI): find agencies, municipalities, provinces, ministries, water authorities and ZBOs by name. Returns organisation name, organisation type, TOOI URI, website, phone and visiting address. Utility for cross-source linking (name -> canonical TOOI id).",
    inputSchema: {
      query: z
        .string()
        .describe("Name substring of the government organisation, e.g. 'Amsterdam' or 'Kadaster'. Leave empty to browse the full register."),
      type: z
        .string()
        .optional()
        .describe("Optional TOOI type URI filter, e.g. https://identifier.overheid.nl/tooi/def/ont/Gemeente"),
      enrich: z
        .boolean()
        .default(true)
        .describe("Enrich each hit with contact + visiting address (extra API calls; auto-skipped above 15 hits)."),
      top: z.number().int().min(1).max(config.limits.maxRows).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  },
  async ({ query, type, enrich, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));
      if (dryRun)
        return dryRunPayload({
          connector: "overheidsorganisaties",
          url: "https://api-organisaties.overheid.nl/v1/overheidsorganisaties",
          params: { query, type: type ?? "", top: fetchRows },
        });
      const started = Date.now();
      const out = await overheidsorganisaties.search({ query, rows: fetchRows, type, enrich });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) =>
        record(
          "overheidsorganisaties",
          String(x.title ?? x.id ?? "Overheidsorganisatie"),
          String(x.url ?? "https://organisaties.overheid.nl/"),
          x as unknown as Record<string, unknown>,
          String(x.organisatietype ?? ""),
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
    description: "Search Dutch public procurement notices and awards (TenderNed) — every tender published by Rijk, provincies, gemeenten, waterschappen, zorg- and onderwijsinstellingen. Returns contracting authority, tender name, publication type (aankondiging/gunning/marktconsultatie/vroegtijdige beëindiging), procedure, contract type, closing date and description. Use for 'welke aanbestedingen', 'wat besteedt gemeente X aan', 'wie won opdracht Y'.",
    inputSchema: {
      query: z.string().optional().describe("Free-text search over tender name, description and contracting authority. Examples: 'fietsbrug', 'jeugdzorg', 'Provincie Overijssel'. Keywords only, not full questions."),
      typeOpdracht: z.enum(["leveringen", "diensten", "werken", "all"]).default("all").describe("Contract type: leveringen (supplies), diensten (services), werken (works)."),
      procedure: z.string().optional().describe("Optional procedure code. Known codes: OPE (openbaar), NOP (niet-openbaar), MAC (marktconsultatie), OZB (onderhands), CCD (concessie)."),
      date_from: z.string().optional().describe("Publication date from (YYYY-MM-DD)."),
      date_to: z.string().optional().describe("Publication date until (YYYY-MM-DD)."),
      page: z.number().int().min(0).default(0).describe("Zero-based page number; TenderNed serves max 100 notices per page."),
      top: z.number().int().min(1).max(100).default(20),
      ...paginationInputSchema,
      outputFormat: outputFormatSchema,
      verbose: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ query, typeOpdracht, procedure, date_from, date_to, page, top, offset, limit, outputFormat, verbose, dryRun }) => {
    try {
      const effectiveLimit = limit ?? top;
      // Not pre-clamped to 100: the source clamps and reports the cap in
      // access_note, so a caller asking for more learns why it got 100.
      const fetchRows = Math.max(top, offset + effectiveLimit);
      if (dryRun) return dryRunPayload({ connector: "tenderned", url: "https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties", params: { search: query, typeOpdracht, procedure, publicatieDatumVanaf: date_from, publicatieDatumTot: date_to, page, size: Math.min(100, fetchRows) } });
      const started = Date.now();
      const out = await tenderned.search({ query, typeOpdracht, procedure, datumVanaf: date_from, datumTot: date_to, rows: fetchRows, page });
      const responseTimeMs = Date.now() - started;
      const records = out.items.map((x) => record(
        "tenderned",
        x.title,
        x.url,
        { publicatie_id: x.id, opdrachtgever: x.opdrachtgever, publicatie_datum: x.publicatieDatum, sluitings_datum: x.sluitingsDatum, type_publicatie: x.typePublicatie, type_publicatie_code: x.typePublicatieCode, procedure: x.procedure, type_opdracht: x.typeOpdracht, europees: x.europees, kenmerk: x.kenmerk, beschrijving: x.beschrijving },
        `${x.opdrachtgever}${x.typePublicatie ? ` — ${x.typePublicatie}` : ""}`.trim(),
        x.publicatieDatum,
      ));
      const response = buildFormattedResponse({ summary: `${records.length} TenderNed publicaties`, records, provenance: prov("tenderned_aanbestedingen_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total), outputFormat, offset, limit: effectiveLimit, total: out.total, access_note: out.access_note, verbose: singleConnectorVerbose({ enabled: verbose, connector: "tenderned", endpoint: out.endpoint, responseTimeMs }) });
      return toMcpToolPayload(response);
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "TenderNed", "https://www.tenderned.nl/aankondigingen/overzicht"));
    }
  });

  server.registerTool("tenderned_aanbesteding_get", {
    description: "Get the full detail of one TenderNed procurement notice by publicatieId (from tenderned_aanbestedingen_search): CPV codes, NUTS region, legal framework, procedure, contract start/end dates, award status and related publications. Set include_text to also extract the text of the official notice PDF.",
    inputSchema: {
      publicatieId: z.string().describe("TenderNed publication id, e.g. '437355'."),
      include_text: z.boolean().default(false).describe("Extract the text layer of the official notice PDF."),
      max_chars: z.number().int().min(1).max(200000).optional().describe("Cap on extracted PDF characters (default 12000)."),
    },
    annotations: TOOL_ANNOTATIONS,
  }, async ({ publicatieId, include_text, max_chars }) => {
    try {
      const out = await tenderned.get({ publicatieId, include_text, max_chars });
      const x = out.item;
      const records = [record(
        "tenderned",
        x.title,
        x.url,
        { ...x },
        `${x.opdrachtgever}${x.typePublicatie ? ` — ${x.typePublicatie}` : ""}`.trim(),
        x.publicatieDatum,
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
}
