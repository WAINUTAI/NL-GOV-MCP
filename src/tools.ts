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
import { mapSourceError, nowIso, successResponse, toMcpToolPayload, errorResponse } from "./utils/response.js";
import type { MCPRecord } from "./types.js";

const config = loadConfig();
const dataOverheid = new DataOverheidSource(config);
const cbs = new CbsSource(config);
const tk = new TweedeKamerSource(config);
const bekend = new BekendmakingenSource(config);
const rijksoverheid = new RijksoverheidSource(config);
const rijksbegroting = new RijksbegrotingSource(config);
const duo = new DuoSource(config);

function record(source: string, title: string, canonical_url: string, data: Record<string, unknown>, snippet?: string, date?: string): MCPRecord {
  return { source_name: source, title, canonical_url, data, snippet, date };
}

function prov(tool: string, endpoint: string, query_params: Record<string, string>, returned_results: number, total_results?: number) {
  return { tool, endpoint, query_params, timestamp: nowIso(), returned_results, total_results };
}

export function registerTools(server: McpServer): void {
  server.registerTool("data_overheid_datasets_search", {
    description: "Search datasets on data.overheid.nl",
    inputSchema: { query: z.string(), rows: z.number().int().min(1).max(config.limits.maxRows).default(config.limits.defaultRows), organization: z.string().optional(), theme: z.string().optional() },
  }, async (args) => {
    try {
      const out = await dataOverheid.datasetsSearch(args);
      const records = out.items.map((d) => record("data.overheid.nl", String(d.title ?? d.id), `https://data.overheid.nl/dataset/${d.id}`, d as unknown as Record<string, unknown>, d.notes, d.metadata_modified));
      return toMcpToolPayload(successResponse({ summary: `${records.length} datasets gevonden`, records, provenance: prov("data_overheid_datasets_search", out.endpoint, out.query, records.length, out.total) }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "data.overheid.nl", "https://data.overheid.nl")); }
  });

  server.registerTool("data_overheid_dataset_get", { inputSchema: { id: z.string() }, description: "Get dataset details" }, async ({ id }) => {
    try {
      const out = await dataOverheid.datasetsGet(id);
      const d = out.item;
      const records = [record("data.overheid.nl", String(d.title ?? d.id), `https://data.overheid.nl/dataset/${d.id}`, d as unknown as Record<string, unknown>, d.notes, d.metadata_modified)];
      return toMcpToolPayload(successResponse({ summary: `Dataset ${id} opgehaald`, records, provenance: prov("data_overheid_dataset_get", out.endpoint, out.query, 1, 1) }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "data.overheid.nl", "https://data.overheid.nl")); }
  });

  server.registerTool("data_overheid_organizations", { description: "List organizations" }, async () => {
    try {
      const out = await dataOverheid.organizations();
      const records = out.items.map((x) => record("data.overheid.nl", String(x.title ?? x.name ?? "organisatie"), `https://data.overheid.nl`, x as Record<string, unknown>));
      return toMcpToolPayload(successResponse({ summary: `${records.length} organisaties`, records, provenance: prov("data_overheid_organizations", out.endpoint, {}, records.length, records.length) }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "data.overheid.nl")); }
  });

  server.registerTool("data_overheid_themes", { description: "List themes" }, async () => {
    try {
      const out = await dataOverheid.themes();
      const records = out.items.map((x) => record("data.overheid.nl", String(x.title ?? x.name ?? "thema"), `https://data.overheid.nl`, x as Record<string, unknown>));
      return toMcpToolPayload(successResponse({ summary: `${records.length} thema's`, records, provenance: prov("data_overheid_themes", out.endpoint, {}, records.length, records.length) }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "data.overheid.nl")); }
  });

  server.registerTool("cbs_tables_search", { inputSchema: { query: z.string(), top: z.number().int().min(1).max(config.limits.maxRows).default(20) } }, async ({ query, top }) => {
    try {
      const out = await cbs.searchTables(query, top);
      const records = out.items.map((x) => record("cbs", String(x.Title ?? x.title ?? x.Identifier ?? "CBS tabel"), `https://www.cbs.nl`, x));
      return toMcpToolPayload(successResponse({ summary: `${records.length} CBS tabellen`, records, provenance: prov("cbs_tables_search", out.endpoint, out.params, records.length, records.length) }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "CBS", "https://www.cbs.nl")); }
  });

  server.registerTool("cbs_table_info", { inputSchema: { tableId: z.string() } }, async ({ tableId }) => {
    try {
      const out = await cbs.getTableInfo(tableId);
      const records = [record("cbs", String((out.info.Title as string | undefined) ?? tableId), `https://opendata.cbs.nl/#/CBS/nl/dataset/${tableId}`, out.info)];
      return toMcpToolPayload(successResponse({ summary: `CBS tabel ${tableId}`, records, provenance: prov("cbs_table_info", out.endpoint, out.params, 1, 1) }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "CBS")); }
  });

  server.registerTool("cbs_observations", { inputSchema: { tableId: z.string(), top: z.number().int().min(1).max(config.limits.maxRows).default(50), select: z.array(z.string()).optional(), filters: z.record(z.string(), z.any()).optional() } }, async ({ tableId, top, select, filters }) => {
    try {
      const out = await cbs.getObservations({ tableId, top, select, filters: filters as Record<string, string | number | boolean | Array<string | number | boolean>> | undefined });
      const records = out.items.map((x) => record("cbs", `Observatie ${tableId}`, `https://opendata.cbs.nl/#/CBS/nl/dataset/${tableId}`, x));
      return toMcpToolPayload(successResponse({ summary: `${records.length} observaties`, records, provenance: prov("cbs_observations", out.endpoint, out.params, records.length, records.length) }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "CBS")); }
  });

  server.registerTool("tweede_kamer_documents", { inputSchema: { query: z.string(), top: z.number().int().min(1).max(config.limits.maxRows).default(25) } }, async ({ query, top }) => {
    try { const out = await tk.searchDocuments(query, top); const records = out.items.map((x)=>record("tweedekamer", String(x.Titel ?? x.Onderwerp ?? x.Id ?? "Document"), String(x.Url ?? "https://www.tweedekamer.nl"), x, String(x.Onderwerp ?? ""), String(x.Datum ?? ""))); return toMcpToolPayload(successResponse({ summary: `${records.length} Tweede Kamer documenten`, records, provenance: prov("tweede_kamer_documents", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Tweede Kamer", "https://www.tweedekamer.nl")); }
  });

  server.registerTool("officiele_bekendmakingen_search", { inputSchema: { query: z.string(), top: z.number().int().min(1).max(100).default(20), startRecord: z.number().int().min(1).default(1) } }, async ({ query, top, startRecord }) => {
    try { const out = await bekend.search({ query, maximumRecords: top, startRecord }); const records = out.items.map((x)=>record("officielebekendmakingen", String(x.title ?? x.titel ?? x.identifier ?? "Bekendmaking"), String(x.identifier ?? x.url ?? "https://zoek.officielebekendmakingen.nl"), x as Record<string, unknown>)); return toMcpToolPayload(successResponse({ summary: `${records.length} bekendmakingen`, records, provenance: prov("officiele_bekendmakingen_search", out.endpoint, out.params, records.length, out.total) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Officiële Bekendmakingen")); }
  });

  server.registerTool("rijksoverheid_search", { inputSchema: { query: z.string(), top: z.number().int().min(1).max(config.limits.maxRows).default(20) } }, async ({ query, top }) => {
    try { const out = await rijksoverheid.search(query, top); const records = out.items.map((x)=>record("rijksoverheid", String(x.title ?? x.titel ?? x.id ?? "Rijksoverheid item"), String(x.url ?? "https://www.rijksoverheid.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} resultaten`, records, provenance: prov("rijksoverheid_search", out.endpoint, out.params, records.length, out.total) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Rijksoverheid", "https://www.rijksoverheid.nl")); }
  });

  server.registerTool("rijksbegroting_search", { inputSchema: { query: z.string(), top: z.number().int().min(1).max(config.limits.maxRows).default(20) } }, async ({ query, top }) => {
    try { const out = await rijksbegroting.search(query, top); const records = out.items.map((x)=>record("rijksbegroting", String(x.title ?? x.name ?? x.id ?? "Rijksbegroting dataset"), String(x.url ?? "https://opendata.rijksbegroting.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} Rijksbegroting datasets`, records, provenance: prov("rijksbegroting_search", out.endpoint, out.params, records.length, out.total) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Rijksbegroting", "https://opendata.rijksbegroting.nl")); }
  });

  server.registerTool("duo_datasets_search", { inputSchema: { query: z.string(), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) } }, async ({ query, rows }) => {
    try { const out = await duo.datasetsCatalog(query, rows); const records = out.items.map((x)=>record("duo", String(x.title ?? x.name ?? x.id ?? "DUO dataset"), String(x.url ?? "https://onderwijsdata.duo.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} DUO datasets`, records, provenance: prov("duo_datasets_search", out.endpoint, out.params, records.length, out.total) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "DUO", "https://onderwijsdata.duo.nl")); }
  });

  server.registerTool("duo_rio_search", { inputSchema: { query: z.string(), top: z.number().int().min(1).max(config.limits.maxRows).default(20) } }, async ({ query, top }) => {
    try { const out = await duo.rioSearch(query, top); const records = out.items.map((x)=>record("duo-rio", String(x.naam ?? x.name ?? x.id ?? "RIO"), String(x.url ?? "https://duo.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} RIO resultaten`, records, provenance: prov("duo_rio_search", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "DUO RIO", "https://lod.onderwijsregistratie.nl")); }
  });

  server.registerTool("overheid_api_register_search", { inputSchema: { query: z.string(), top: z.number().int().min(1).max(config.limits.maxRows).default(20) } }, async ({ query, top }) => {
    const apiKey = process.env[ENV_KEYS.OVERHEID_API_KEY];
    if (!apiKey) return toMcpToolPayload(errorResponse({ error: "not_configured", message: "OVERHEID_API_KEY ontbreekt", suggestion: "Set OVERHEID_API_KEY to use this tool" }));
    try { const out = await new ApiRegisterSource(config, apiKey).search(query, top); const records = out.items.map((x)=>record("api-register", String(x.name ?? x.title ?? x.id ?? "API"), String(x.portalUrl ?? x.url ?? "https://apis.developer.overheid.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} API's`, records, provenance: prov("overheid_api_register_search", out.endpoint, out.params, records.length, records.length), access_note: "Requires OVERHEID_API_KEY" })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Overheid API Register", "https://apis.developer.overheid.nl")); }
  });

  server.registerTool("knmi_datasets", { description: "List KNMI datasets" }, async () => {
    const apiKey = process.env[ENV_KEYS.KNMI_API_KEY];
    if (!apiKey) return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI_API_KEY ontbreekt", suggestion: "Set KNMI_API_KEY to use KNMI tools" }));
    try { const out = await new KnmiSource(config, apiKey).datasets(); const records = out.items.map((x)=>record("knmi", String(x.name ?? x.datasetName ?? "KNMI dataset"), "https://developer.dataplatform.knmi.nl", x)); return toMcpToolPayload(successResponse({ summary: `${records.length} KNMI datasets`, records, provenance: prov("knmi_datasets", out.endpoint, out.params, records.length, records.length), access_note: "Requires KNMI_API_KEY" })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "KNMI")); }
  });

  server.registerTool("knmi_latest_files", { inputSchema: { datasetName: z.string(), datasetVersion: z.string().default("1"), top: z.number().int().min(1).max(200).default(50) } }, async ({ datasetName, datasetVersion, top }) => {
    const apiKey = process.env[ENV_KEYS.KNMI_API_KEY];
    if (!apiKey) return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI_API_KEY ontbreekt", suggestion: "Set KNMI_API_KEY to use KNMI tools" }));
    try { const out = await new KnmiSource(config, apiKey).latestFiles(datasetName, datasetVersion, top); const records = out.items.map((x)=>record("knmi", String(x.filename ?? x.name ?? "KNMI file"), "https://developer.dataplatform.knmi.nl", x)); return toMcpToolPayload(successResponse({ summary: `${records.length} KNMI files`, records, provenance: prov("knmi_latest_files", out.endpoint, out.params, records.length, records.length), access_note: "Requires KNMI_API_KEY" })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "KNMI")); }
  });

  server.registerTool("nl_gov_ask", { inputSchema: { question: z.string(), top: z.number().int().min(1).max(config.limits.maxRows).default(10) }, description: "Meta-router for Dutch govt sources" }, async ({ question, top }) => {
    const q = question.toLowerCase();
    const has = (terms: string[]) => terms.some((t) => q.includes(t));

    try {
      if (has(["cbs", "statistiek", "statistics", "tabel"])) {
        const out = await cbs.searchTables(question, top);
        const records = out.items.map((x) => record("cbs", String(x.Title ?? x.Identifier ?? "CBS"), "https://www.cbs.nl", x));
        return toMcpToolPayload(successResponse({ summary: `Router: CBS (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, records.length) }));
      }
      if (has(["tweede kamer", "kamervraag", "motie", "kamerstuk"])) {
        const out = await tk.searchDocuments(question, top);
        const records = out.items.map((x)=>record("tweedekamer", String(x.Titel ?? x.Id ?? "Document"), String(x.Url ?? "https://www.tweedekamer.nl"), x));
        return toMcpToolPayload(successResponse({ summary: `Router: Tweede Kamer (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, records.length) }));
      }
      if (has(["bekendmaking", "officieel", "stcrt", "gmb", "sru"])) {
        const out = await bekend.search({ query: question, maximumRecords: top });
        const records = out.items.map((x)=>record("officielebekendmakingen", String(x.title ?? x.identifier ?? "Bekendmaking"), String(x.identifier ?? "https://zoek.officielebekendmakingen.nl"), x as Record<string, unknown>));
        return toMcpToolPayload(successResponse({ summary: `Router: Bekendmakingen (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total) }));
      }
      const out = await dataOverheid.datasetsSearch({ query: question, rows: top });
      const records = out.items.map((d) => record("data.overheid.nl", String(d.title ?? d.id), `https://data.overheid.nl/dataset/${d.id}`, d as unknown as Record<string, unknown>, d.notes, d.metadata_modified));
      return toMcpToolPayload(successResponse({ summary: `Router fallback: data.overheid (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.query, records.length, out.total) }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "nl_gov_ask"));
    }
  });
}
