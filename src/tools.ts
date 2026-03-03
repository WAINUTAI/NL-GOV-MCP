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
import type { MCPRecord } from "./types.js";

const config = loadConfig();
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
const bagLinkedData = new SparqlLinkedDataSource(config, "https://data.labs.kadaster.nl/bag/sparql", "Kadaster BAG Linked Data");
const rceLinkedData = new SparqlLinkedDataSource(config, "https://linkeddata.cultureelerfgoed.nl/sparql", "RCE Linked Data");
const eurostat = new EurostatSource(config);
const dataEuropa = new DataEuropaSource(config);

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

  server.registerTool("tweede_kamer_documents", { inputSchema: { query: z.string(), top: z.number().int().min(1).max(config.limits.maxRows).default(25), type: z.string().optional(), date_from: z.string().optional(), date_to: z.string().optional() } }, async ({ query, top, type, date_from, date_to }) => {
    try { const out = await tk.searchDocuments({ query, top, type, date_from, date_to }); const records = out.items.map((x)=>record("tweedekamer", String(x.Titel ?? x.Onderwerp ?? x.Id ?? "Document"), String(x.Url ?? x.resource_url ?? "https://www.tweedekamer.nl"), x, String(x.Onderwerp ?? ""), String(x.Datum ?? ""))); return toMcpToolPayload(successResponse({ summary: `${records.length} Tweede Kamer documenten`, records, provenance: prov("tweede_kamer_documents", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Tweede Kamer", "https://www.tweedekamer.nl")); }
  });

  server.registerTool("tweede_kamer_search", { inputSchema: { query: z.string(), entity: z.string().default("Document"), top: z.number().int().min(1).max(config.limits.maxRows).default(25), filter: z.string().optional(), orderby: z.string().optional(), skip: z.number().int().min(0).optional() } }, async ({ query, entity, top, filter, orderby, skip }) => {
    try { const out = await tk.search({ query, entity, top, filter, orderby, skip }); const records = out.items.map((x)=>record("tweedekamer", String(x.Titel ?? x.Onderwerp ?? x.Id ?? "Result"), String(x.Url ?? "https://www.tweedekamer.nl"), x, String(x.Onderwerp ?? ""), String(x.Datum ?? x.GewijzigdOp ?? ""))); return toMcpToolPayload(successResponse({ summary: `${records.length} Tweede Kamer records`, records, provenance: prov("tweede_kamer_search", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Tweede Kamer", "https://www.tweedekamer.nl")); }
  });

  server.registerTool("tweede_kamer_document_get", { inputSchema: { id: z.string() } }, async ({ id }) => {
    try { const out = await tk.getDocument(id); const r = out.item as Record<string, unknown>; const records = [record("tweedekamer", String(r.Titel ?? r.Onderwerp ?? r.Id ?? id), String(r.resource_url ?? `https://www.tweedekamer.nl`), r, String(r.Onderwerp ?? ""), String(r.Datum ?? ""))]; return toMcpToolPayload(successResponse({ summary: `Tweede Kamer document ${id}`, records, provenance: prov("tweede_kamer_document_get", out.endpoint, out.params, 1, 1) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Tweede Kamer", "https://www.tweedekamer.nl")); }
  });

  server.registerTool("tweede_kamer_votes", { inputSchema: { zaak_id: z.string().optional(), date: z.string().optional(), top: z.number().int().min(1).max(config.limits.maxRows).default(100) } }, async ({ zaak_id, date, top }) => {
    try { const out = await tk.getVotes({ zaak_id, date, top }); const records = out.items.map((x)=>record("tweedekamer", String(x.ActorFractie ?? x.Soort ?? x.Id ?? "Stemming"), "https://opendata.tweedekamer.nl", x, String(x.Soort ?? ""), String(x.GewijzigdOp ?? ""))); return toMcpToolPayload(successResponse({ summary: `${records.length} stemmingen`, records, provenance: prov("tweede_kamer_votes", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Tweede Kamer", "https://www.tweedekamer.nl")); }
  });

  server.registerTool("tweede_kamer_members", { inputSchema: { fractie: z.string().optional(), active: z.boolean().default(true), top: z.number().int().min(1).max(config.limits.maxRows).default(50) } }, async ({ fractie, active, top }) => {
    try { const out = await tk.getMembers({ fractie, active, top }); const records = out.items.map((x)=>record("tweedekamer", String(x.name ?? x.id ?? "Kamerlid"), String(x.persoon_url ?? "https://www.tweedekamer.nl"), x, String(x.fractie ?? ""), String(x.start_date ?? ""))); return toMcpToolPayload(successResponse({ summary: `${records.length} Kamerleden`, records, provenance: prov("tweede_kamer_members", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Tweede Kamer", "https://www.tweedekamer.nl")); }
  });

  server.registerTool("officiele_bekendmakingen_search", { inputSchema: { query: z.string(), top: z.number().int().min(1).max(100).default(20), startRecord: z.number().int().min(1).default(1), type: z.string().optional(), authority: z.string().optional(), date_from: z.string().optional(), date_to: z.string().optional() } }, async ({ query, top, startRecord, type, authority, date_from, date_to }) => {
    try { const out = await bekend.search({ query, maximumRecords: top, startRecord, type, authority, date_from, date_to }); const records = out.items.map((x)=>record("officielebekendmakingen", String(x.title ?? x.titel ?? x.identifier ?? "Bekendmaking"), String(x.canonical_url ?? x.identifier ?? x.url ?? "https://zoek.officielebekendmakingen.nl"), x as Record<string, unknown>, String(x.authority ?? ""), String(x.date ?? ""))); return toMcpToolPayload(successResponse({ summary: `${records.length} bekendmakingen`, records, provenance: prov("officiele_bekendmakingen_search", out.endpoint, out.params, records.length, out.total) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Officiële Bekendmakingen")); }
  });

  server.registerTool("officiele_bekendmakingen_record_get", { inputSchema: { identifier: z.string() } }, async ({ identifier }) => {
    try { const out = await bekend.getRecord(identifier); const r = out.item; const records = [record("officielebekendmakingen", String(r.title ?? r.identifier ?? identifier), String(r.canonical_url ?? `https://zoek.officielebekendmakingen.nl/${identifier}`), r, String(r.authority ?? ""), String(r.date ?? ""))]; return toMcpToolPayload(successResponse({ summary: `Bekendmaking ${identifier}`, records, provenance: prov("officiele_bekendmakingen_record_get", out.endpoint, out.params, 1, 1) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Officiële Bekendmakingen")); }
  });

  server.registerTool("rijksoverheid_search", { inputSchema: { query: z.string(), top: z.number().int().min(1).max(config.limits.maxRows).default(20), ministry: z.string().optional(), topic: z.string().optional(), date_from: z.string().optional(), date_to: z.string().optional() } }, async ({ query, top, ministry, topic, date_from, date_to }) => {
    try { const out = await rijksoverheid.search({ query, top, ministry, topic, date_from, date_to }); const records = out.items.map((x)=>record("rijksoverheid", String(x.title ?? x.titel ?? x.id ?? "Rijksoverheid item"), String(x.canonical ?? x.url ?? "https://www.rijksoverheid.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} resultaten`, records, provenance: prov("rijksoverheid_search", out.endpoint, out.params, records.length, out.total) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Rijksoverheid", "https://www.rijksoverheid.nl")); }
  });

  server.registerTool("rijksoverheid_document", { inputSchema: { id: z.string() } }, async ({ id }) => {
    try { const out = await rijksoverheid.document(id); const r = out.item; const records = [record("rijksoverheid", String(r.title ?? r.titel ?? r.id ?? id), String(r.canonical ?? r.url ?? "https://www.rijksoverheid.nl"), r, String(r.introduction ?? ""), String(r.frontenddate ?? ""))]; return toMcpToolPayload(successResponse({ summary: `Rijksoverheid document ${id}`, records, provenance: prov("rijksoverheid_document", out.endpoint, out.params, 1, 1) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Rijksoverheid", "https://www.rijksoverheid.nl")); }
  });

  server.registerTool("rijksoverheid_topics", {}, async () => {
    try { const out = await rijksoverheid.topics(); const records = out.items.map((x)=>record("rijksoverheid", String(x.name ?? x.title ?? x.id ?? "Topic"), String(x.url ?? "https://www.rijksoverheid.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} onderwerpen`, records, provenance: prov("rijksoverheid_topics", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Rijksoverheid", "https://www.rijksoverheid.nl")); }
  });

  server.registerTool("rijksoverheid_ministries", {}, async () => {
    try { const out = await rijksoverheid.ministries(); const records = out.items.map((x)=>record("rijksoverheid", String(x.name ?? x.title ?? x.id ?? "Ministerie"), String(x.url ?? "https://www.rijksoverheid.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} ministeries`, records, provenance: prov("rijksoverheid_ministries", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Rijksoverheid", "https://www.rijksoverheid.nl")); }
  });

  server.registerTool("rijksoverheid_schoolholidays", { inputSchema: { year: z.number().int().min(2000).max(2100).optional(), region: z.string().optional() } }, async ({ year, region }) => {
    try { const out = await rijksoverheid.schoolholidays({ year, region }); const records = out.items.map((x)=>record("rijksoverheid", String(x.title ?? x.name ?? x.region ?? x.id ?? "Schoolvakantie"), String(x.url ?? "https://www.rijksoverheid.nl"), x, String(x.region ?? ""), String(x.startdate ?? x.date ?? ""))); return toMcpToolPayload(successResponse({ summary: `${records.length} schoolvakantie records`, records, provenance: prov("rijksoverheid_schoolholidays", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Rijksoverheid", "https://www.rijksoverheid.nl")); }
  });

  server.registerTool("rijksbegroting_search", { inputSchema: { query: z.string(), top: z.number().int().min(1).max(config.limits.maxRows).default(20) } }, async ({ query, top }) => {
    try { const out = await rijksbegroting.search(query, top); const records = out.items.map((x)=>record("rijksbegroting", String(x.title ?? x.name ?? x.id ?? "Rijksbegroting dataset"), String(x.url ?? "https://opendata.rijksbegroting.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} Rijksbegroting datasets`, records, provenance: prov("rijksbegroting_search", out.endpoint, out.params, records.length, out.total) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Rijksbegroting", "https://opendata.rijksbegroting.nl")); }
  });

  server.registerTool("rijksbegroting_chapter", { inputSchema: { year: z.number().int().min(2000).max(2100), chapter: z.string() } }, async ({ year, chapter }) => {
    try { const out = await rijksbegroting.getChapter(year, chapter); const records = out.items.map((x)=>{ const rec = x as Record<string, unknown>; return record("rijksbegroting", String(rec.name ?? rec.id ?? "Begrotingshoofdstuk"), String(rec.url ?? "https://opendata.rijksbegroting.nl"), rec); }); return toMcpToolPayload(successResponse({ summary: `${records.length} chapter matches`, records, provenance: prov("rijksbegroting_chapter", out.endpoint, out.params, records.length, records.length) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "Rijksbegroting", "https://opendata.rijksbegroting.nl")); }
  });

  server.registerTool("duo_datasets_search", { inputSchema: { query: z.string(), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) } }, async ({ query, rows }) => {
    try { const out = await duo.datasetsCatalog(query, rows); const records = out.items.map((x)=>record("duo", String(x.title ?? x.name ?? x.id ?? "DUO dataset"), String(x.url ?? "https://onderwijsdata.duo.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} DUO datasets`, records, provenance: prov("duo_datasets_search", out.endpoint, out.params, records.length, out.total) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "DUO", "https://onderwijsdata.duo.nl")); }
  });

  server.registerTool("duo_schools", { inputSchema: { name: z.string().optional(), municipality: z.string().optional(), type: z.string().optional(), top: z.number().int().min(1).max(config.limits.maxRows).default(20) } }, async ({ name, municipality, type, top }) => {
    try { const out = await duo.getSchools({ name, municipality, type, top }); const records = out.items.map((x)=>record("duo", String(x.title ?? x.name ?? x.id ?? "School dataset"), String(x.url ?? "https://onderwijsdata.duo.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} school-gerelateerde resultaten`, records, provenance: prov("duo_schools", out.endpoint, out.params, records.length, out.total) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "DUO", "https://onderwijsdata.duo.nl")); }
  });

  server.registerTool("duo_exam_results", { inputSchema: { year: z.number().int().min(2000).max(2100).optional(), school: z.string().optional(), municipality: z.string().optional(), top: z.number().int().min(1).max(config.limits.maxRows).default(20) } }, async ({ year, school, municipality, top }) => {
    try { const out = await duo.getExamResults({ year, school, municipality, top }); const records = out.items.map((x)=>record("duo", String(x.title ?? x.name ?? x.id ?? "Exam results dataset"), String(x.url ?? "https://onderwijsdata.duo.nl"), x)); return toMcpToolPayload(successResponse({ summary: `${records.length} exam-resultaten bronnen`, records, provenance: prov("duo_exam_results", out.endpoint, out.params, records.length, out.total) })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "DUO", "https://onderwijsdata.duo.nl")); }
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

  server.registerTool("knmi_search_datasets", { inputSchema: { query: z.string().optional() } }, async ({ query }) => {
    const apiKey = process.env[ENV_KEYS.KNMI_API_KEY];
    if (!apiKey) return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI_API_KEY ontbreekt", suggestion: "Set KNMI_API_KEY to use KNMI tools" }));
    try { const out = await new KnmiSource(config, apiKey).searchDatasets(query); const records = out.items.map((x)=>record("knmi", String(x.name ?? x.datasetName ?? "KNMI dataset"), "https://developer.dataplatform.knmi.nl", x)); return toMcpToolPayload(successResponse({ summary: `${records.length} KNMI dataset matches`, records, provenance: prov("knmi_search_datasets", out.endpoint, out.params, records.length, records.length), access_note: "Requires KNMI_API_KEY" })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "KNMI")); }
  });

  server.registerTool("knmi_latest_files", { inputSchema: { datasetName: z.string(), datasetVersion: z.string().default("1"), top: z.number().int().min(1).max(200).default(50) } }, async ({ datasetName, datasetVersion, top }) => {
    const apiKey = process.env[ENV_KEYS.KNMI_API_KEY];
    if (!apiKey) return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI_API_KEY ontbreekt", suggestion: "Set KNMI_API_KEY to use KNMI tools" }));
    try { const out = await new KnmiSource(config, apiKey).latestFiles(datasetName, datasetVersion, top); const records = out.items.map((x)=>record("knmi", String(x.filename ?? x.name ?? "KNMI file"), "https://developer.dataplatform.knmi.nl", x)); return toMcpToolPayload(successResponse({ summary: `${records.length} KNMI files`, records, provenance: prov("knmi_latest_files", out.endpoint, out.params, records.length, records.length), access_note: "Requires KNMI_API_KEY" })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "KNMI")); }
  });

  server.registerTool("knmi_latest_observations", { inputSchema: { top: z.number().int().min(1).max(200).default(20) } }, async ({ top }) => {
    const apiKey = process.env[ENV_KEYS.KNMI_API_KEY];
    if (!apiKey) return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI_API_KEY ontbreekt", suggestion: "Set KNMI_API_KEY to use KNMI tools" }));
    try { const out = await new KnmiSource(config, apiKey).latestObservations(top); const records = out.items.map((x)=>record("knmi", String(x.filename ?? x.name ?? "Observation file"), "https://developer.dataplatform.knmi.nl", x)); return toMcpToolPayload(successResponse({ summary: `${records.length} observation files`, records, provenance: prov("knmi_latest_observations", out.endpoint, out.params, records.length, records.length), access_note: "Requires KNMI_API_KEY" })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "KNMI")); }
  });

  server.registerTool("knmi_warnings", { inputSchema: { top: z.number().int().min(1).max(200).default(20) } }, async ({ top }) => {
    const apiKey = process.env[ENV_KEYS.KNMI_API_KEY];
    if (!apiKey) return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI_API_KEY ontbreekt", suggestion: "Set KNMI_API_KEY to use KNMI tools" }));
    try { const out = await new KnmiSource(config, apiKey).warnings(top); const records = out.items.map((x)=>record("knmi", String(x.filename ?? x.name ?? "Warning file"), "https://developer.dataplatform.knmi.nl", x)); const accessNote = (out as { access_note?: string }).access_note ?? "Requires KNMI_API_KEY"; return toMcpToolPayload(successResponse({ summary: `${records.length} warning files`, records, provenance: prov("knmi_warnings", out.endpoint, out.params, records.length, records.length), access_note: accessNote })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "KNMI")); }
  });

  server.registerTool("knmi_earthquakes", { inputSchema: { top: z.number().int().min(1).max(200).default(20) } }, async ({ top }) => {
    const apiKey = process.env[ENV_KEYS.KNMI_API_KEY];
    if (!apiKey) return toMcpToolPayload(errorResponse({ error: "not_configured", message: "KNMI_API_KEY ontbreekt", suggestion: "Set KNMI_API_KEY to use KNMI tools" }));
    try { const out = await new KnmiSource(config, apiKey).earthquakes(top); const records = out.items.map((x)=>record("knmi", String(x.filename ?? x.name ?? "Earthquake file"), "https://developer.dataplatform.knmi.nl", x)); const accessNote = (out as { access_note?: string }).access_note ?? "Requires KNMI_API_KEY"; return toMcpToolPayload(successResponse({ summary: `${records.length} earthquake files`, records, provenance: prov("knmi_earthquakes", out.endpoint, out.params, records.length, records.length), access_note: accessNote })); } catch(e){ return toMcpToolPayload(mapSourceError(e, "KNMI")); }
  });

  server.registerTool("pdok_search", { inputSchema: { query: z.string(), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search PDOK Locatieserver (adres/locatie)" }, async ({ query, rows }) => {
    try {
      const out = await pdok.search({ query, rows });
      const records = out.items.map((x) => record("pdok", String(x.weergavenaam ?? x.id ?? "PDOK locatie"), "https://www.pdok.nl", x, String(x.type ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} PDOK resultaten`, records, provenance: prov("pdok_search", out.endpoint, out.params, records.length, out.total) }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "PDOK", "https://www.pdok.nl"));
    }
  });

  server.registerTool("bag_lookup_address", { inputSchema: { query: z.string().optional(), postcode: z.string().optional(), huisnummer: z.string().optional(), rows: z.number().int().min(1).max(config.limits.maxRows).default(10) }, description: "Lookup BAG address via PDOK locatieserver" }, async ({ query, postcode, huisnummer, rows }) => {
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

  server.registerTool("ori_search", { inputSchema: { query: z.string(), rows: z.number().int().min(1).max(config.limits.maxRows).default(20), bestuurslaag: z.string().optional() }, description: "Search Open Raadsinformatie (ORI/ODS)" }, async ({ query, rows, bestuurslaag }) => {
    try {
      const out = await ori.search({ query, rows, bestuurslaag });
      const records = out.items.map((x) => record("ori", String(x.title ?? x.id ?? "ORI item"), String(x.url ?? "https://www.openraadsinformatie.nl"), x, String(x.type ?? ""), String(x.publishedAt ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} ORI resultaten`, records, provenance: prov("ori_search", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "ORI", "https://www.openraadsinformatie.nl"));
    }
  });

  server.registerTool("ndw_search", { inputSchema: { query: z.string(), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search NDW open traffic data" }, async ({ query, rows }) => {
    try {
      const out = await ndw.search({ query, rows });
      const records = out.items.map((x) => record("ndw", String(x.title ?? x.id ?? "NDW item"), String(x.url ?? "https://www.ndw.nu"), x, String(x.description ?? ""), String(x.updated_at ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} NDW resultaten`, records, provenance: prov("ndw_search", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "NDW", "https://www.ndw.nu"));
    }
  });

  server.registerTool("luchtmeetnet_latest", { inputSchema: { component: z.string().optional(), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Fetch latest Luchtmeetnet measurements" }, async ({ component, rows }) => {
    try {
      const out = await luchtmeetnet.latest({ component, rows });
      const records = out.items.map((x) => record("luchtmeetnet", `${String(x.formula ?? "component")}-${String(x.station_name ?? x.station_number ?? "station")}`, "https://www.luchtmeetnet.nl", x, `${String(x.component ?? x.formula ?? "")}: ${String(x.value ?? "")} ${String(x.unit ?? "")}`, String(x.timestamp ?? x.timestamp_measured ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} luchtmeetnet metingen`, records, provenance: prov("luchtmeetnet_latest", out.endpoint, out.params, records.length, out.total) }));
    } catch {
      const out = luchtmeetnet.fallback({ component, rows });
      const records = out.items.map((x) => record("luchtmeetnet", `${String(x.formula ?? "component")}-${String(x.station_name ?? x.station_number ?? "station")}`, "https://www.luchtmeetnet.nl", x, `${String(x.component ?? x.formula ?? "")}: ${String(x.value ?? "")} ${String(x.unit ?? "")}`, String(x.timestamp ?? x.timestamp_measured ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} luchtmeetnet fallback metingen`, records, provenance: prov("luchtmeetnet_latest", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
    }
  });

  server.registerTool("rdw_open_data_search", { inputSchema: { query: z.string(), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search RDW open voertuigdata" }, async ({ query, rows }) => {
    try {
      const live = await rdw.search({ query, rows });
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

  server.registerTool("rijkswaterstaat_waterdata_search", { inputSchema: { query: z.string(), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search Rijkswaterstaat waterdata catalog" }, async ({ query, rows }) => {
    try {
      const out = await rwsWaterdata.search({ query, rows });
      const records = out.items.map((x) => record("rijkswaterstaat-waterdata", String(x.title ?? x.id ?? "RWS waterdata"), "https://waterinfo.rws.nl", x as Record<string, unknown>, String(x.category ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} RWS waterdata resultaten`, records, provenance: prov("rijkswaterstaat_waterdata_search", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Rijkswaterstaat Waterdata", "https://waterinfo.rws.nl"));
    }
  });

  server.registerTool("ngr_discovery_search", { inputSchema: { query: z.string(), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search Nationaal GeoRegister metadata via CSW" }, async ({ query, rows }) => {
    try {
      const out = await ngr.search({ query, rows });
      const records = out.items.map((x) => record("ngr", String(x.title ?? x.id ?? "NGR metadata"), String(x.url ?? "https://www.nationaalgeoregister.nl"), x as Record<string, unknown>));
      return toMcpToolPayload(successResponse({ summary: `${records.length} NGR metadata records`, records, provenance: prov("ngr_discovery_search", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Nationaal GeoRegister", "https://www.nationaalgeoregister.nl"));
    }
  });

  server.registerTool("rechtspraak_search_ecli", { inputSchema: { query: z.string(), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search Rechtspraak feed and extract ECLI references" }, async ({ query, rows }) => {
    try {
      const out = await rechtspraak.searchEcli({ query, rows });
      const records = out.items.map((x) => record("rechtspraak", String(x.title ?? x.ecli ?? x.id ?? "Rechtspraak uitspraak"), String(x.link ?? x.id ?? "https://data.rechtspraak.nl"), x, String(x.summary ?? x.ecli ?? ""), String(x.updated ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} Rechtspraak resultaten`, records, provenance: prov("rechtspraak_search_ecli", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch {
      const out = rechtspraak.fallback({ query, rows });
      const records = out.items.map((x) => record("rechtspraak", String(x.title ?? x.ecli ?? "Fallback uitspraak"), String(x.link ?? x.id ?? "https://data.rechtspraak.nl"), x, String(x.summary ?? ""), String(x.updated ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} Rechtspraak fallback resultaten`, records, provenance: prov("rechtspraak_search_ecli", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
    }
  });

  server.registerTool("rivm_discovery_search", { inputSchema: { query: z.string(), rows: z.number().int().min(1).max(config.limits.maxRows).default(20) }, description: "Search/discover RIVM public API/dataset references" }, async ({ query, rows }) => {
    try {
      const out = await rivm.search({ query, rows });
      const records = out.items.map((x) => record("rivm", String(x.title ?? x.id ?? "RIVM item"), String(x.url ?? "https://www.rivm.nl"), x as Record<string, unknown>, String(x.description ?? ""), String(x.updated_at ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} RIVM discovery resultaten`, records, provenance: prov("rivm_discovery_search", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch {
      const out = rivm.fallback({ query, rows });
      const records = out.items.map((x) => record("rivm", String(x.title ?? x.id ?? "RIVM item"), String(x.url ?? "https://www.rivm.nl"), x as Record<string, unknown>, String(x.description ?? ""), String(x.updated_at ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} RIVM fallback resultaten`, records, provenance: prov("rivm_discovery_search", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
    }
  });

  server.registerTool("bag_linked_data_select", { inputSchema: { query: z.string(), limit: z.number().int().min(1).max(SPARQL_LIMIT_CAP).default(25) }, description: "Read-only SELECT query on Kadaster BAG linked data (SPARQL, guarded)" }, async ({ query, limit }) => {
    try {
      const out = await bagLinkedData.select({ query, limit });
      const records = out.items.map((x, i) => record("bag-linked-data", `BAG row ${i + 1}`, "https://data.labs.kadaster.nl/bag/sparql", x, out.safeQuery));
      return toMcpToolPayload(successResponse({ summary: `${records.length} BAG linked-data rows`, records, provenance: prov("bag_linked_data_select", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch (e) {
      if (e instanceof Error && /SELECT|toegestaan|keyword/i.test(e.message)) {
        return toMcpToolPayload(errorResponse({ error: "unexpected", message: e.message, suggestion: "Gebruik een read-only SELECT query met een kleine LIMIT" }));
      }
      const out = bagLinkedData.fallback({ query, limit });
      const records = out.items.map((x, i) => record("bag-linked-data", `BAG fallback row ${i + 1}`, "https://data.labs.kadaster.nl/bag/sparql", x, String(x.note ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} BAG linked-data fallback rows`, records, provenance: prov("bag_linked_data_select", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
    }
  });

  server.registerTool("rce_linked_data_select", { inputSchema: { query: z.string(), limit: z.number().int().min(1).max(SPARQL_LIMIT_CAP).default(25) }, description: "Read-only SELECT query on RCE linked data (SPARQL, guarded)" }, async ({ query, limit }) => {
    try {
      const out = await rceLinkedData.select({ query, limit });
      const records = out.items.map((x, i) => record("rce-linked-data", `RCE row ${i + 1}`, "https://linkeddata.cultureelerfgoed.nl/sparql", x, out.safeQuery));
      return toMcpToolPayload(successResponse({ summary: `${records.length} RCE linked-data rows`, records, provenance: prov("rce_linked_data_select", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch (e) {
      if (e instanceof Error && /SELECT|toegestaan|keyword/i.test(e.message)) {
        return toMcpToolPayload(errorResponse({ error: "unexpected", message: e.message, suggestion: "Gebruik een read-only SELECT query met een kleine LIMIT" }));
      }
      const out = rceLinkedData.fallback({ query, limit });
      const records = out.items.map((x, i) => record("rce-linked-data", `RCE fallback row ${i + 1}`, "https://linkeddata.cultureelerfgoed.nl/sparql", x, String(x.note ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} RCE linked-data fallback rows`, records, provenance: prov("rce_linked_data_select", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
    }
  });

  server.registerTool("eurostat_datasets_search", { inputSchema: { query: z.string(), rows: z.number().int().min(1).max(config.limits.maxRows).default(10) }, description: "Eurostat dataset finder (deterministic catalog helper)" }, async ({ query, rows }) => {
    const out = eurostat.searchFallback({ query, rows });
    const records = out.items.map((x) => record("eurostat", String(x.title ?? x.id ?? "Eurostat dataset"), String(x.url ?? "https://ec.europa.eu/eurostat"), x as Record<string, unknown>));
    return toMcpToolPayload(successResponse({ summary: `${records.length} Eurostat dataset suggesties`, records, provenance: prov("eurostat_datasets_search", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
  });

  server.registerTool("eurostat_dataset_preview", { inputSchema: { dataset: z.string(), rows: z.number().int().min(1).max(config.limits.maxRows).default(10), filters: z.record(z.string(), z.string()).optional() }, description: "Fetch preview observations from a Eurostat dataset code" }, async ({ dataset, rows, filters }) => {
    try {
      const out = await eurostat.previewDataset({ dataset, rows, filters });
      const records = out.items.map((x) => record("eurostat", `${dataset}:${String(x.observation_key ?? "obs")}`, `https://ec.europa.eu/eurostat/databrowser/view/${encodeURIComponent(dataset)}/default/table?lang=en`, x as Record<string, unknown>, String(x.value ?? ""), String(x.updated ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} Eurostat observaties`, records, provenance: prov("eurostat_dataset_preview", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Eurostat", "https://ec.europa.eu/eurostat"));
    }
  });

  server.registerTool("data_europa_datasets_search", { inputSchema: { query: z.string(), rows: z.number().int().min(1).max(config.limits.maxRows).default(10) }, description: "Search datasets on data.europa.eu CKAN API" }, async ({ query, rows }) => {
    try {
      const out = await dataEuropa.datasetsSearch({ query, rows });
      const records = out.items.map((x) => record("data-europa", String(x.title ?? x.id ?? "Dataset"), String(x.url ?? "https://data.europa.eu/data"), x as Record<string, unknown>, String(x.notes ?? ""), String(x.metadata_modified ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} data.europa.eu datasets`, records, provenance: prov("data_europa_datasets_search", out.endpoint, out.params, records.length, out.total), access_note: (out as { access_note?: string }).access_note }));
    } catch {
      const out = dataEuropa.fallback({ query, rows });
      const records = out.items.map((x) => record("data-europa", String(x.title ?? x.id ?? "Dataset"), String(x.url ?? "https://data.europa.eu/data"), x as Record<string, unknown>, String(x.notes ?? ""), String(x.metadata_modified ?? "")));
      return toMcpToolPayload(successResponse({ summary: `${records.length} data.europa.eu fallback datasets`, records, provenance: prov("data_europa_datasets_search", out.endpoint, out.params, records.length, out.total), access_note: out.access_note }));
    }
  });

  server.registerTool("nl_gov_ask", { inputSchema: { question: z.string(), top: z.number().int().min(1).max(config.limits.maxRows).default(10) }, description: "Meta-router for Dutch govt sources" }, async ({ question, top }) => {
    const decodedQuestion = (() => {
      try { return decodeURIComponent(question.replace(/\+/g, " ")); } catch { return question; }
    })();
    const q = decodedQuestion.toLowerCase();
    const has = (terms: string[]) => terms.some((t) => q.includes(t));

    const stopwords = new Set([
      "wat", "is", "de", "het", "een", "van", "voor", "met", "over", "in", "op", "en", "naar", "per", "tussen", "hoeveel", "hoe", "gemiddelde", "gemeente", "zijn", "er", "aan", "om", "bij", "welke", "which", "heeft", "have", "api",
    ]);

    const makeKeywordQuery = (input: string, maxTerms = 6): string => {
      const tokens = input
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((t) => t.length > 2 && !stopwords.has(t));
      return tokens.slice(0, maxTerms).join(" ").trim();
    };

    const makeCbsQuery = (input: string): string => makeKeywordQuery(input, 6);

    const cbsTerms = ["cbs", "statistiek", "statistics", "bevolking", "population", "inwoners", "inflatie", "werkloos", "woning", "inkomen", "economie", "bbp", "gdp", "import", "export", "geboorte", "sterfte", "opleidingsniveau", "opleiding", "onderwijsniveau"];
    const tkTerms = ["tweede kamer", "parlement", "motie", "moties", "amendement", "kamerstuk", "kamervraag", "debat", "stemming", "fractie", "commissie", "wetsvoorstel", "kamerlid", "mp"];
    const obTerms = ["staatsblad", "staatscourant", "tractatenblad", "gemeenteblad", "bekendmaking", "verordening", "regeling", "officieel besluit", "stcrt", "gmb"];
    const rijkTerms = ["rijksoverheid", "kabinet", "minister", "ministerie", "beleid", "toespraak", "schoolvakantie", "schoolvakanties", "school holiday", "school holidays", "vakantie regio"];
    const budgetTerms = ["begroting", "budget", "uitgaven", "spending", "rijksfinanci", "begrotingsartikel", "defensie-uitgaven"];
    const duoTerms = ["school", "leerling", "student", "leraar", "teacher", "onderwijs", "education", "slagingspercentage", "examen", "diploma", "duo", "basisschool", "middelbare", "mbo", "hbo", "universiteit"];
    const weatherTerms = ["weer", "weather", "temperatuur", "rain", "regen", "wind", "storm", "klimaat", "earthquake", "aardbeving", "seismologie"];
    const apiTerms = ["welke api", "which api", "is er een api", "data over", "api heeft"];

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
      const terms = makeCbsQuery(decodedQuestion).split(/\s+/).filter(Boolean);
      for (const t of terms) if (text.includes(t)) score += 1;
      return score;
    };

    try {
      const isSchoolHolidayQuery = q.includes("schoolvakantie") || q.includes("schoolvakanties") || q.includes("school holiday") || q.includes("school holidays");
      if (isSchoolHolidayQuery) {
        const yearMatch = decodedQuestion.match(/\b(20\d{2})\b/);
        const regionMatch = q.match(/\b(noord|midden|zuid)\b/);

        let out = await rijksoverheid.schoolholidays({
          year: yearMatch ? Number(yearMatch[1]) : undefined,
          region: regionMatch ? regionMatch[1] : undefined,
        });

        if (!out.items.length && regionMatch) {
          out = await rijksoverheid.schoolholidays({ year: yearMatch ? Number(yearMatch[1]) : undefined });
        }
        if (!out.items.length && yearMatch) {
          out = await rijksoverheid.schoolholidays({ region: regionMatch ? regionMatch[1] : undefined });
        }

        const records = out.items.map((x)=>record("rijksoverheid", String(x.title ?? x.region ?? "Schoolvakantie"), String(x.canonical ?? "https://www.rijksoverheid.nl"), x, String(x.region ?? ""), String(x.startdate ?? "")));
        if (records.length) {
          return toMcpToolPayload(successResponse({ summary: `Router: Rijksoverheid schoolvakanties (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, records.length) }));
        }

        const rijkOut = await rijksoverheid.search({ query: "schoolvakantie", top });
        const rijkRecords = rijkOut.items.map((x)=>record("rijksoverheid", String(x.title ?? x.id ?? "Rijksoverheid"), String(x.canonical ?? x.url ?? "https://www.rijksoverheid.nl"), x));
        if (rijkRecords.length) {
          return toMcpToolPayload(successResponse({ summary: `Router: Rijksoverheid (${rijkRecords.length} resultaten)`, records: rijkRecords, provenance: prov("nl_gov_ask", rijkOut.endpoint, rijkOut.params, rijkRecords.length, rijkOut.total) }));
        }
      }

      if (has(cbsTerms)) {
        const candidates = [makeCbsQuery(decodedQuestion), decodedQuestion];
        if (q.includes("inwoner") || q.includes("population")) candidates.push("bevolking");
        if (q.includes("opleidingsniveau") || q.includes("opleiding")) candidates.push("opleidingsniveau gemeenten");
        if (q.includes("werkloos")) candidates.push("werkloosheid");

        let out = await cbs.searchTables(candidates[0] || decodedQuestion, Math.max(top, 8));
        let items = out.items;

        if (!items.length) {
          for (const candidate of candidates.slice(1)) {
            if (!candidate || !candidate.trim()) continue;
            out = await cbs.searchTables(candidate, Math.max(top, 8));
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
                const obsOut = await cbs.getObservations({ tableId: bestTableId, top });
                const obsRecords = obsOut.items.map((x) => record("cbs", `Observatie ${bestTableId}`, `https://opendata.cbs.nl/#/CBS/nl/dataset/${bestTableId}`, x));
                if (obsRecords.length) {
                  return toMcpToolPayload(successResponse({ summary: `Router: CBS observaties (${obsRecords.length} resultaten)`, records: obsRecords, provenance: prov("nl_gov_ask", obsOut.endpoint, obsOut.params, obsRecords.length, obsRecords.length) }));
                }
              } catch {
                // fall through to table-level response
              }
            }
          }

          const records = sorted.slice(0, top).map((x) => record("cbs", String(x.Title ?? x.Identifier ?? "CBS"), "https://www.cbs.nl", x));
          return toMcpToolPayload(successResponse({ summary: `Router: CBS (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, items.length) }));
        }
      }

      if (has(tkTerms)) {
        const tkCandidates = [makeKeywordQuery(decodedQuestion, 5), decodedQuestion];
        if (q.includes("motie") || q.includes("moties")) tkCandidates.push("motie");
        if (q.includes("stikstof")) tkCandidates.push("motie stikstof");

        let out = await tk.searchDocuments({ query: tkCandidates[0] || decodedQuestion, top });
        let records = out.items.map((x)=>record("tweedekamer", String(x.Titel ?? x.Id ?? "Document"), String(x.Url ?? x.resource_url ?? "https://www.tweedekamer.nl"), x));

        if (!records.length) {
          for (const candidate of tkCandidates.slice(1)) {
            if (!candidate || !candidate.trim()) continue;
            out = await tk.searchDocuments({ query: candidate, top });
            records = out.items.map((x)=>record("tweedekamer", String(x.Titel ?? x.Id ?? "Document"), String(x.Url ?? x.resource_url ?? "https://www.tweedekamer.nl"), x));
            if (records.length) break;
          }
        }

        if (records.length) {
          return toMcpToolPayload(successResponse({ summary: `Router: Tweede Kamer (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, records.length) }));
        }
      }

      if (has(obTerms)) {
        const out = await bekend.search({ query: decodedQuestion, maximumRecords: top });
        const records = out.items.map((x)=>record("officielebekendmakingen", String(x.title ?? x.identifier ?? "Bekendmaking"), String(x.canonical_url ?? x.identifier ?? "https://zoek.officielebekendmakingen.nl"), x as Record<string, unknown>));
        if (records.length) {
          return toMcpToolPayload(successResponse({ summary: `Router: Bekendmakingen (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total) }));
        }
      }

      if (has(rijkTerms)) {
        const rijkQuery = makeKeywordQuery(decodedQuestion, 5) || decodedQuestion;
        let out = await rijksoverheid.search({ query: rijkQuery, top });
        let records = out.items.map((x)=>record("rijksoverheid", String(x.title ?? x.id ?? "Rijksoverheid"), String(x.canonical ?? x.url ?? "https://www.rijksoverheid.nl"), x));

        if (!records.length && (q.includes("schoolvakantie") || q.includes("schoolvakanties"))) {
          out = await rijksoverheid.search({ query: "schoolvakantie", top });
          records = out.items.map((x)=>record("rijksoverheid", String(x.title ?? x.id ?? "Rijksoverheid"), String(x.canonical ?? x.url ?? "https://www.rijksoverheid.nl"), x));
        }

        if (records.length) {
          return toMcpToolPayload(successResponse({ summary: `Router: Rijksoverheid (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total) }));
        }
      }

      const likelyBudget = has(budgetTerms) || ((q.includes("hoeveel geeft") || q.includes("how much does")) && q.includes("uit"));
      if (likelyBudget) {
        const budgetQuery = makeKeywordQuery(decodedQuestion, 5) || decodedQuestion;
        const out = await rijksbegroting.search(budgetQuery, top);
        const records = out.items.map((x)=>record("rijksbegroting", String(x.name ?? x.id ?? "Rijksbegroting"), String(x.url ?? "https://opendata.rijksbegroting.nl"), x));
        if (records.length) {
          return toMcpToolPayload(successResponse({ summary: `Router: Rijksbegroting (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total) }));
        }
      }

      if (has(duoTerms)) {
        const duoQuery = makeKeywordQuery(decodedQuestion, 5) || decodedQuestion;
        const out = await duo.datasetsCatalog(duoQuery, top);
        const records = out.items.map((x)=>record("duo", String(x.title ?? x.name ?? x.id ?? "DUO"), String(x.url ?? "https://onderwijsdata.duo.nl"), x));
        if (records.length) {
          return toMcpToolPayload(successResponse({ summary: `Router: DUO (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, out.total) }));
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
        const apiQuery = makeKeywordQuery(decodedQuestion, 4) || decodedQuestion;
        const out = await new ApiRegisterSource(config, apiKey).search(apiQuery, top);
        const records = out.items.map((x)=>record("api-register", String(x.name ?? x.title ?? x.id ?? "API"), String(x.portalUrl ?? x.url ?? "https://apis.developer.overheid.nl"), x));
        if (records.length) {
          return toMcpToolPayload(successResponse({ summary: `Router: API Register (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.params, records.length, records.length), access_note: "Requires OVERHEID_API_KEY" }));
        }
      }

      const out = await dataOverheid.datasetsSearch({ query: decodedQuestion, rows: top });
      const records = out.items.map((d) => record("data.overheid.nl", String(d.title ?? d.id), `https://data.overheid.nl/dataset/${d.id}`, d as unknown as Record<string, unknown>, d.notes, d.metadata_modified));
      return toMcpToolPayload(successResponse({ summary: `Router fallback: data.overheid (${records.length} resultaten)`, records, provenance: prov("nl_gov_ask", out.endpoint, out.query, records.length, out.total) }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "nl_gov_ask"));
    }
  });
}
