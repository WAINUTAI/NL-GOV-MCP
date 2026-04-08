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
import { RivmSource } from "./sources/rivm.js";
import { SparqlLinkedDataSource, SPARQL_LIMIT_CAP } from "./sources/sparql-linked-data.js";
import { EurostatSource } from "./sources/eurostat.js";
import { DataEuropaSource } from "./sources/data-europa.js";
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
const rivm = new RivmSource(config);
const bagLinkedData = new SparqlLinkedDataSource(config, "https://api.labs.kadaster.nl/datasets/bag/lv/services/default/sparql", "Kadaster BAG Linked Data");
const rceLinkedData = new SparqlLinkedDataSource(config, "https://api.linkeddata.cultureelerfgoed.nl/datasets/rce/cho/services/cho/sparql", "RCE Linked Data");
const eurostat = new EurostatSource(config);
const dataEuropa = new DataEuropaSource(config);

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
      const records = out.items.map((x) => record("data.overheid.nl", String(x.title ?? x.name ?? "organisatie"), `https://data.overheid.nl`, x as Record<string, unknown>));
      return toMcpToolPayload(successResponse({ summary: `${records.length} organisaties`, records, provenance: prov("data_overheid_organizations", out.endpoint, {}, records.length, records.length) }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "data.overheid.nl")); }
  });

  server.registerTool("data_overheid_themes", { description: "List all dataset themes/categories on data.overheid.nl.", annotations: TOOL_ANNOTATIONS }, async () => {
    try {
      const out = await dataOverheid.themes();
      const records = out.items.map((x) => record("data.overheid.nl", String(x.title ?? x.name ?? "thema"), `https://data.overheid.nl`, x as Record<string, unknown>));
      return toMcpToolPayload(successResponse({ summary: `${records.length} thema's`, records, provenance: prov("data_overheid_themes", out.endpoint, {}, records.length, records.length) }));
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
        total: records.length,
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
        total: records.length,
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
        total: records.length,
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

  server.registerTool("rijksoverheid_search", { description: "Search Rijksoverheid.nl content (news, policy documents, publications). Use topic keywords. Optionally filter by ministry, topic, and date range.", inputSchema: { query: z.string().describe("Government topic keywords. Examples: 'energietransitie', 'pensioenwet', 'toeslagen'. Do NOT pass full questions."), top: z.number().int().min(1).max(config.limits.maxRows).default(20), ministry: z.string().optional(), topic: z.string().optional(), date_from: z.string().optional(), date_to: z.string().optional(), ...paginationInputSchema, outputFormat: outputFormatSchema, verbose: z.boolean().default(false), dryRun: z.boolean().default(false) }, annotations: TOOL_ANNOTATIONS }, async ({ query, top, ministry, topic, date_from, date_to, offset, limit, outputFormat, verbose, dryRun }) => {
    const rw = rewriteQuery(query, "moderate");
    try {
      const effectiveLimit = limit ?? top;
      const fetchRows = Math.min(config.limits.maxRows, Math.max(top, offset + effectiveLimit));

      if (dryRun) {
        return dryRunPayload({
          connector: "rijksoverheid",
          url: config.endpoints.rijksoverheid,
          params: { query: rw.rewritten, top: fetchRows, ministry, topic, date_from, date_to },
        });
      }

      const started = Date.now();
      const out = await rijksoverheid.search({ query: rw.rewritten, top: fetchRows, ministry, topic, date_from, date_to });
      const responseTimeMs = Date.now() - started;

      const records = out.items.map((x)=>record("rijksoverheid", String(x.title ?? x.titel ?? x.id ?? "Rijksoverheid item"), String(x.canonical ?? x.url ?? "https://www.rijksoverheid.nl"), x));
      const response = buildFormattedResponse({
        summary: `${records.length} resultaten`,
        records,
        provenance: prov("rijksoverheid_search", out.endpoint, out.params, Math.min(effectiveLimit, Math.max(0, records.length - offset)), out.total),
        outputFormat,
        offset,
        limit: effectiveLimit,
        total: out.total,
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

  server.registerTool("rijksoverheid_document", { description: "Get a specific Rijksoverheid.nl document by ID.", inputSchema: { id: z.string() }, annotations: TOOL_ANNOTATIONS }, async ({ id }) => {
    try { const out = await rijksoverheid.document(id); const r = out.item; const records = [record("rijksoverheid", String(r.title ?? r.titel ?? r.id ?? id), String(r.canonical ?? r.url ?? "https://www.rijksoverheid.nl"), r, String(r.introduction ?? ""), String(r.frontenddate ?? ""))]; return toMcpToolPayload(successResponse({ summary: `Rijksoverheid document ${id}`, records, provenance: prov("rijksoverheid_document", out.endpoint, out.params, 1, 1) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Rijksoverheid", "https://www.rijksoverheid.nl")); }
  });

  server.registerTool("rijksoverheid_topics", { description: "List all policy topics on Rijksoverheid.nl.", annotations: TOOL_ANNOTATIONS }, async () => {
    try { const out = await rijksoverheid.topics(); const records = out.items.map((x)=>record("rijksoverheid", String(x.name ?? x.title ?? x.id ?? "Topic"), String(x.url ?? "https://www.rijksoverheid.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} onderwerpen`, records, provenance: prov("rijksoverheid_topics", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Rijksoverheid", "https://www.rijksoverheid.nl")); }
  });

  server.registerTool("rijksoverheid_ministries", { description: "List all Dutch government ministries.", annotations: TOOL_ANNOTATIONS }, async () => {
    try { const out = await rijksoverheid.ministries(); const records = out.items.map((x)=>record("rijksoverheid", String(x.name ?? x.title ?? x.id ?? "Ministerie"), String(x.url ?? "https://www.rijksoverheid.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} ministeries`, records, provenance: prov("rijksoverheid_ministries", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Rijksoverheid", "https://www.rijksoverheid.nl")); }
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

  server.registerTool("duo_schools", { description: "Search DUO school data by name, municipality, or school type.", inputSchema: { name: z.string().optional(), municipality: z.string().optional(), type: z.string().optional(), top: z.number().int().min(1).max(config.limits.maxRows).default(20) }, annotations: TOOL_ANNOTATIONS }, async ({ name, municipality, type, top }) => {
    try { const out = await duo.getSchools({ name, municipality, type, top }); const records = out.items.map((x)=>record("duo", String(x.title ?? x.name ?? x.id ?? "School dataset"), String(x.url ?? "https://onderwijsdata.duo.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} school-gerelateerde resultaten`, records, provenance: prov("duo_schools", out.endpoint, out.params, records.length, out.total) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "DUO", "https://onderwijsdata.duo.nl")); }
  });

  server.registerTool("duo_exam_results", { description: "Search DUO exam result data by year, school name, or municipality.", inputSchema: { year: z.number().int().min(2000).max(2100).optional(), school: z.string().optional(), municipality: z.string().optional(), top: z.number().int().min(1).max(config.limits.maxRows).default(20) }, annotations: TOOL_ANNOTATIONS }, async ({ year, school, municipality, top }) => {
    try { const out = await duo.getExamResults({ year, school, municipality, top }); const records = out.items.map((x)=>record("duo", String(x.title ?? x.name ?? x.id ?? "Exam results dataset"), String(x.url ?? "https://onderwijsdata.duo.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} exam-resultaten bronnen`, records, provenance: prov("duo_exam_results", out.endpoint, out.params, records.length, out.total) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "DUO", "https://onderwijsdata.duo.nl")); }
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
        total: records.length,
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

  server.registerTool("knmi_latest_files", { description: "Get latest data files from a specific KNMI dataset. Requires KNMI_API_KEY.", inputSchema: { datasetName: z.string(), datasetVersion: z.string().default("1"), top: z.number().int().min(1).max(200).default(50) }, annotations: TOOL_ANNOTATIONS }, async ({ datasetName, datasetVersion, top }) => {
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

  server.registerTool("luchtmeetnet_latest", { inputSchema: { component: z.string().optional(), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Fetch latest air quality measurements from Luchtmeetnet. Optionally filter by component (e.g. NO2, PM10, PM2.5, O3).", annotations: TOOL_ANNOTATIONS }, async ({ component, rows }) => {
    try {
      const out = await luchtmeetnet.latest({ component, rows });
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
    const has = (terms: string[]) => terms.some((t) => q.includes(t));

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

    const cbsTerms = ["cbs", "statistiek", "statistics", "bevolking", "population", "inwoners", "inflatie", "werkloos", "woning", "inkomen", "economie", "bbp", "gdp", "import", "export", "geboorte", "sterfte", "opleidingsniveau", "opleiding", "onderwijsniveau", "emissie", "emissies"];
    const tkTerms = ["tweede kamer", "parlement", "motie", "moties", "amendement", "kamerstuk", "kamervraag", "debat", "stemming", "fractie", "commissie", "wetsvoorstel", "kamerlid", "mp"];
    const obTerms = ["staatsblad", "staatscourant", "tractatenblad", "gemeenteblad", "bekendmaking", "verordening", "regeling", "officieel besluit", "stcrt", "gmb"];
    const rijkTerms = ["rijksoverheid", "kabinet", "minister", "ministerie", "beleid", "toespraak", "schoolvakantie", "schoolvakanties", "school holiday", "school holidays", "vakantie regio"];
    const budgetTerms = ["begroting", "budget", "uitgaven", "spending", "rijksfinanci", "begrotingsartikel", "defensie-uitgaven"];
    const duoTerms = ["school", "leerling", "student", "leraar", "teacher", "onderwijs", "education", "slagingspercentage", "examen", "diploma", "duo", "basisschool", "middelbare", "mbo", "hbo", "universiteit"];
    const weatherTerms = ["weer", "weather", "temperatuur", "rain", "regen", "wind", "storm", "klimaat", "earthquake", "aardbeving", "seismologie"];
    const apiTerms = ["welke api", "which api", "is er een api", "data over", "api heeft"];
    const rechtspraakTerms = ["jurisprudentie", "rechtspraak", "rechtszaak", "rechtszaken", "rechterlijke uitspraak", "rechterlijk", "ecli", "vonnis", "vonnissen", "arrest", "arresten", "beschikking", "gerechtshof", "rechtbank", "raad van state", "hoge raad", "gesanctioneerd", "sanctie", "sancties", "handhaving", "boete", "overtreding", "beroep", "bezwaar", "uitspraak", "tuchtrecht", "bestuursrecht"];

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

      if (has(cbsTerms)) {
        const candidates = [makeCbsQuery(questionForSearch), questionForSearch];
        if (q.includes("inwoner") || q.includes("population")) candidates.push("bevolking");
        if (q.includes("opleidingsniveau") || q.includes("opleiding")) candidates.push("opleidingsniveau gemeenten");
        if (q.includes("werkloos")) candidates.push("werkloosheid");

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
          return askSuccess({ summary: `Router: CBS (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, items.length), total: items.length });
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
}
