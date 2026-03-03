import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

type ArgValue = string | number | boolean;
type ArgMap = Record<string, ArgValue | undefined>;
type Context = Record<string, unknown>;

interface CaseDef {
  id: string;
  description: string;
  tool: string;
  args?: ArgMap | ((ctx: Context) => ArgMap);
  minRecords?: number;
  allowErrors?: string[];
  requireEnv?: string[];
  saveContext?: Record<string, string>;
}

interface CaseResult {
  id: string;
  tool: string;
  description: string;
  status: "PASS" | "FAIL" | "SKIP";
  elapsedMs: number;
  records: number;
  summary?: string;
  error?: string;
  message?: string;
  reason?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getByPath(obj: unknown, dotPath: string): unknown {
  if (!dotPath) return undefined;
  return dotPath.split(".").reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function formatArg(key: string, value: ArgValue): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return `${key}:${value}`;
  }
  return `${key}=${encodeURIComponent(value)}`;
}

function runTool(tool: string, args: ArgMap): { payload?: Record<string, unknown>; elapsedMs: number; execError?: string } {
  const argTokens = Object.entries(args)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => formatArg(k, v as ArgValue));

  const cmd = [
    "call",
    "--stdio",
    "node dist/src/index.js",
    tool,
    ...argTokens,
    "--output",
    "json",
  ];

  const started = Date.now();
  try {
    const out = execFileSync("mcporter", cmd, {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const elapsedMs = Date.now() - started;
    return { payload: JSON.parse(out) as Record<string, unknown>, elapsedMs };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const msg = error instanceof Error ? error.message : "mcporter call failed";
    return { elapsedMs, execError: msg };
  }
}

const cases: CaseDef[] = [
  {
    id: "data_overheid_search",
    description: "data.overheid dataset search",
    tool: "data_overheid_datasets_search",
    args: { query: "bevolking", rows: 3 },
    minRecords: 1,
    saveContext: { dataOverheidDatasetId: "records.0.data.id" },
  },
  {
    id: "data_overheid_get",
    description: "data.overheid dataset details",
    tool: "data_overheid_dataset_get",
    args: (ctx) => ({
      id: String(ctx.dataOverheidDatasetId ?? "e2a3a2b7-790f-4e34-bbf9-8897f77e16f0"),
    }),
    minRecords: 1,
  },
  {
    id: "data_overheid_orgs",
    description: "data.overheid organizations",
    tool: "data_overheid_organizations",
    minRecords: 1,
  },
  {
    id: "cbs_search",
    description: "CBS table search",
    tool: "cbs_tables_search",
    args: { query: "bevolking", top: 3 },
    minRecords: 1,
  },
  {
    id: "cbs_table_info",
    description: "CBS table metadata",
    tool: "cbs_table_info",
    args: { tableId: "86232NED" },
    minRecords: 1,
  },
  {
    id: "cbs_observations",
    description: "CBS observations",
    tool: "cbs_observations",
    args: { tableId: "86232NED", top: 3 },
    minRecords: 1,
  },
  {
    id: "tk_documents",
    description: "Tweede Kamer document search",
    tool: "tweede_kamer_documents",
    args: { query: "klimaat", top: 3 },
    minRecords: 1,
    saveContext: { tkDocumentId: "records.0.data.Id" },
  },
  {
    id: "tk_document_get",
    description: "Tweede Kamer document get",
    tool: "tweede_kamer_document_get",
    args: (ctx) => ({
      id: String(ctx.tkDocumentId ?? "c6b24107-4fff-4753-b3ae-a10bfd08d053"),
    }),
    minRecords: 1,
  },
  {
    id: "tk_votes",
    description: "Tweede Kamer votes",
    tool: "tweede_kamer_votes",
    args: { top: 3 },
    minRecords: 1,
  },
  {
    id: "tk_members",
    description: "Tweede Kamer members",
    tool: "tweede_kamer_members",
    args: { fractie: "VVD", top: 3 },
    minRecords: 1,
  },
  {
    id: "ob_search",
    description: "Officiële Bekendmakingen search",
    tool: "officiele_bekendmakingen_search",
    args: { query: "klimaat", top: 3, startRecord: 1 },
    minRecords: 1,
    saveContext: { obIdentifier: "records.0.data.identifier" },
  },
  {
    id: "ob_get",
    description: "Officiële Bekendmakingen record get",
    tool: "officiele_bekendmakingen_record_get",
    args: (ctx) => ({ identifier: String(ctx.obIdentifier ?? "blg-1054762") }),
    minRecords: 1,
  },
  {
    id: "rijk_search",
    description: "Rijksoverheid search",
    tool: "rijksoverheid_search",
    args: { query: "defensie", top: 3 },
    minRecords: 1,
    saveContext: { rijkDocId: "records.0.data.id" },
  },
  {
    id: "rijk_document",
    description: "Rijksoverheid document get",
    tool: "rijksoverheid_document",
    args: (ctx) => ({ id: String(ctx.rijkDocId ?? "876c7ae6-21fe-4b02-91fa-73deb5089a8b") }),
    minRecords: 1,
  },
  {
    id: "rijk_topics",
    description: "Rijksoverheid topics",
    tool: "rijksoverheid_topics",
    minRecords: 1,
  },
  {
    id: "rijk_ministries",
    description: "Rijksoverheid ministries",
    tool: "rijksoverheid_ministries",
    minRecords: 1,
  },
  {
    id: "rijk_schoolholidays",
    description: "Rijksoverheid school holidays",
    tool: "rijksoverheid_schoolholidays",
    args: { year: 2026, region: "noord" },
    minRecords: 1,
  },
  {
    id: "begroting_search",
    description: "Rijksbegroting search",
    tool: "rijksbegroting_search",
    args: { query: "defensie", top: 3 },
    minRecords: 1,
  },
  {
    id: "begroting_chapter",
    description: "Rijksbegroting chapter helper",
    tool: "rijksbegroting_chapter",
    args: { year: 2026, chapter: "defensie" },
    minRecords: 1,
  },
  {
    id: "duo_datasets",
    description: "DUO datasets search",
    tool: "duo_datasets_search",
    args: { query: "onderwijs", rows: 3 },
    minRecords: 1,
  },
  {
    id: "duo_schools",
    description: "DUO schools helper",
    tool: "duo_schools",
    args: { municipality: "amsterdam", top: 3 },
    minRecords: 0,
  },
  {
    id: "duo_exam",
    description: "DUO exam results helper",
    tool: "duo_exam_results",
    args: { year: 2024, municipality: "utrecht", top: 3 },
    minRecords: 0,
  },
  {
    id: "duo_rio",
    description: "DUO RIO adapter",
    tool: "duo_rio_search",
    args: { query: "amsterdam", top: 3 },
    minRecords: 1,
  },
  {
    id: "api_register",
    description: "API register search",
    tool: "overheid_api_register_search",
    args: { query: "kadaster", top: 3 },
    minRecords: 1,
    requireEnv: ["OVERHEID_API_KEY"],
  },
  {
    id: "knmi_datasets",
    description: "KNMI dataset catalog",
    tool: "knmi_datasets",
    minRecords: 1,
    requireEnv: ["KNMI_API_KEY"],
  },
  {
    id: "knmi_latest_obs",
    description: "KNMI latest observations files",
    tool: "knmi_latest_observations",
    args: { top: 2 },
    minRecords: 1,
    requireEnv: ["KNMI_API_KEY"],
  },
  {
    id: "knmi_warnings",
    description: "KNMI warnings files",
    tool: "knmi_warnings",
    args: { top: 2 },
    minRecords: 0,
    requireEnv: ["KNMI_API_KEY"],
  },
  {
    id: "knmi_earthquakes",
    description: "KNMI earthquakes files",
    tool: "knmi_earthquakes",
    args: { top: 2 },
    minRecords: 0,
    requireEnv: ["KNMI_API_KEY"],
  },
  {
    id: "pdok_search",
    description: "PDOK locatieserver search",
    tool: "pdok_search",
    args: { query: "den haag", rows: 3 },
    minRecords: 1,
  },
  {
    id: "bag_lookup",
    description: "BAG address lookup",
    tool: "bag_lookup_address",
    args: { query: "Damrak 1 Amsterdam", rows: 2 },
    minRecords: 1,
  },
  {
    id: "ori_search",
    description: "ORI search",
    tool: "ori_search",
    args: { query: "woningbouw", rows: 2 },
    minRecords: 1,
  },
  {
    id: "ndw_search",
    description: "NDW search",
    tool: "ndw_search",
    args: { query: "verkeer", rows: 2 },
    minRecords: 1,
  },
  {
    id: "luchtmeetnet_latest",
    description: "Luchtmeetnet latest measurements",
    tool: "luchtmeetnet_latest",
    args: { component: "NO2", rows: 2 },
    minRecords: 1,
  },
  {
    id: "rechtspraak_search_ecli",
    description: "Rechtspraak ECLI search",
    tool: "rechtspraak_search_ecli",
    args: { query: "ECLI:NL:HR:2024", rows: 2 },
    minRecords: 1,
  },
  {
    id: "rdw_search",
    description: "RDW open data search",
    tool: "rdw_open_data_search",
    args: { query: "toyota", rows: 2 },
    minRecords: 1,
  },
  {
    id: "rws_waterdata",
    description: "RWS waterdata catalog search",
    tool: "rijkswaterstaat_waterdata_search",
    args: { query: "water", rows: 2 },
    minRecords: 1,
  },
  {
    id: "ngr_discovery",
    description: "NGR metadata discovery",
    tool: "ngr_discovery_search",
    args: { query: "bag", rows: 2 },
    minRecords: 1,
  },
  {
    id: "rivm_discovery",
    description: "RIVM discovery search",
    tool: "rivm_discovery_search",
    args: { query: "lucht", rows: 2 },
    minRecords: 1,
  },
  {
    id: "bag_linked_data_select",
    description: "Kadaster BAG linked-data SELECT",
    tool: "bag_linked_data_select",
    args: { query: "SELECT * WHERE { ?s ?p ?o } LIMIT 1", limit: 1 },
    minRecords: 1,
  },
  {
    id: "rce_linked_data_select",
    description: "RCE linked-data SELECT",
    tool: "rce_linked_data_select",
    args: { query: "SELECT * WHERE { ?s ?p ?o } LIMIT 1", limit: 1 },
    minRecords: 1,
  },
  {
    id: "eurostat_search",
    description: "Eurostat dataset helper",
    tool: "eurostat_datasets_search",
    args: { query: "population", rows: 2 },
    minRecords: 1,
  },
  {
    id: "eurostat_preview",
    description: "Eurostat dataset preview",
    tool: "eurostat_dataset_preview",
    args: { dataset: "tps00001", rows: 2 },
    minRecords: 1,
  },
  {
    id: "data_europa_search",
    description: "data.europa.eu CKAN search",
    tool: "data_europa_datasets_search",
    args: { query: "climate", rows: 2 },
    minRecords: 1,
  },
  // nl_gov_ask (question-routing)
  {
    id: "ask_cbs",
    description: "Router question: CBS",
    tool: "nl_gov_ask",
    args: { question: "Hoeveel inwoners heeft Nederland", top: 3 },
    minRecords: 1,
  },
  {
    id: "ask_tk",
    description: "Router question: Tweede Kamer",
    tool: "nl_gov_ask",
    args: { question: "Welke moties zijn ingediend over stikstof", top: 3 },
    minRecords: 1,
  },
  {
    id: "ask_rijk",
    description: "Router question: Rijksoverheid",
    tool: "nl_gov_ask",
    args: { question: "Wat zijn de schoolvakanties 2026 in regio noord", top: 3 },
    minRecords: 1,
  },
  {
    id: "ask_budget",
    description: "Router question: Rijksbegroting",
    tool: "nl_gov_ask",
    args: { question: "begroting defensie", top: 3 },
    minRecords: 1,
  },
  {
    id: "ask_api",
    description: "Router question: API register",
    tool: "nl_gov_ask",
    args: { question: "Welke API heeft kadaster", top: 3 },
    minRecords: 1,
    requireEnv: ["OVERHEID_API_KEY"],
  },
  {
    id: "ask_education_papendrecht",
    description: "Router question: education level Papendrecht",
    tool: "nl_gov_ask",
    args: { question: "Wat is het gemiddelde opleidingsniveau in de gemeente Papendrecht", top: 3 },
    minRecords: 1,
  },
];

async function main() {
  const context: Context = {};
  const results: CaseResult[] = [];

  for (const testCase of cases) {
    const missingEnv = (testCase.requireEnv ?? []).filter((k) => !process.env[k]);
    if (missingEnv.length) {
      results.push({
        id: testCase.id,
        tool: testCase.tool,
        description: testCase.description,
        status: "SKIP",
        elapsedMs: 0,
        records: 0,
        reason: `Missing env: ${missingEnv.join(", ")}`,
      });
      continue;
    }

    const args = typeof testCase.args === "function" ? testCase.args(context) : (testCase.args ?? {});
    const maxAttempts = 2;
    let finalResult: CaseResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const out = runTool(testCase.tool, args);

      if (out.execError) {
        finalResult = {
          id: testCase.id,
          tool: testCase.tool,
          description: testCase.description,
          status: "FAIL",
          elapsedMs: out.elapsedMs,
          records: 0,
          error: "exec_error",
          message: out.execError,
        };
      } else {
        const payload = out.payload ?? {};
        const isError = typeof payload.error === "string";

        if (isError) {
          const code = String(payload.error);
          const allowed = (testCase.allowErrors ?? []).includes(code);
          finalResult = {
            id: testCase.id,
            tool: testCase.tool,
            description: testCase.description,
            status: allowed ? "PASS" : "FAIL",
            elapsedMs: out.elapsedMs,
            records: 0,
            error: code,
            message: String(payload.message ?? "unknown error"),
          };
        } else {
          const records = Array.isArray(payload.records) ? payload.records.length : 0;
          const minRecords = testCase.minRecords ?? 0;
          const passed = records >= minRecords;

          if (passed && testCase.saveContext) {
            for (const [ctxKey, pathExpr] of Object.entries(testCase.saveContext)) {
              const value = getByPath(payload, pathExpr);
              if (value !== undefined && value !== null && String(value) !== "") {
                context[ctxKey] = value;
              }
            }
          }

          finalResult = {
            id: testCase.id,
            tool: testCase.tool,
            description: testCase.description,
            status: passed ? "PASS" : "FAIL",
            elapsedMs: out.elapsedMs,
            records,
            summary: String(payload.summary ?? ""),
            ...(passed
              ? {}
              : {
                  error: "record_count",
                  message: `Expected >= ${minRecords} records, got ${records}`,
                }),
          };
        }
      }

      if (finalResult.status === "PASS") {
        break;
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }

    results.push(finalResult as CaseResult);
  }

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIP").length;

  console.log(`\nNL-GOV-MCP question suite @ ${nowIso()}`);
  console.log(`PASS=${pass} FAIL=${fail} SKIP=${skip} TOTAL=${results.length}\n`);

  for (const r of results) {
    const base = `[${r.status}] ${r.id} (${r.tool}) - ${r.description}`;
    if (r.status === "PASS") {
      console.log(`${base} | records=${r.records} | ${r.elapsedMs}ms | ${r.summary ?? ""}`);
    } else if (r.status === "SKIP") {
      console.log(`${base} | SKIP reason: ${r.reason}`);
    } else {
      console.log(`${base} | FAIL ${r.error ?? ""}: ${r.message ?? ""}`);
    }
  }

  const report = {
    generatedAt: nowIso(),
    pass,
    fail,
    skip,
    total: results.length,
    results,
  };

  const reportPath = path.resolve(process.cwd(), "scripts/question-suite-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${reportPath}`);

  if (fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
