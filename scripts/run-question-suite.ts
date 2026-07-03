/**
 * NL-GOV-MCP question / live suite runner (in-process).
 *
 * WHY THIS WAS REWRITTEN (2026):
 *   The previous version shelled out to an external `mcporter` CLI via
 *   execFileSync("mcporter", ...). That binary is not a devDependency and is not
 *   installed by `npm ci`, so every case failed with "spawnSync mcporter ENOENT"
 *   (see the old scripts/live-suite-report.json: 16/16 FAIL). This version drives
 *   the MCP server IN-PROCESS using the official @modelcontextprotocol/sdk
 *   InMemoryTransport + Client — the same proven call path as
 *   tests/acceptance.live.test.ts, but without opening a listening HTTP port.
 *   The external mcporter dependency is gone entirely.
 *
 * DATA SOURCE:
 *   Cases are loaded from scripts/test-queries.json (data-driven). Previously that
 *   file was an unused 4-line stub; it is now the single source of truth for the
 *   suite. Each entry: { id, description, tool, args?, minRecords?, saveContext?,
 *   requireEnv?, allowErrors?, skipErrors?, skipMessageIncludes?, liveProfile? }.
 *
 * PROFILES (CLI flag --profile <full|live>, default full):
 *   full → runs the complete case suite across every connector; writes
 *          scripts/question-suite-report.json.
 *   live → runs only the curated smoke-test subset (cases flagged
 *          "liveProfile": true) and writes scripts/live-suite-report.json.
 *
 *   NOTE ON THE full/live DISTINCTION: every connector targets a real external
 *   public API and this project ships no offline fixtures, so BOTH profiles make
 *   real network calls. "full" is the broad end-to-end suite; "live" is a fast,
 *   curated subset. This mirrors the pre-existing behaviour (the old runner drew
 *   the identical full/live split via a hard-coded LIVE_CASE_IDS set).
 *
 * CONTEXT INTERPOLATION:
 *   A string arg of the form "{{contextKey|fallback}}" is resolved at runtime from
 *   context captured by an earlier case's "saveContext" (dot-path into the tool
 *   payload). If the context key is unset, the fallback literal is used. This
 *   replaces the function-valued args the old TS runner used, so the whole suite
 *   can live in JSON.
 *
 * The CLI flags (--profile full / --profile live) and the report format/paths are
 * unchanged, so package.json (test:questions / test:live) needs no edits.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

dotenvConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = __dirname;

type ArgValue = string | number | boolean;
type ArgMap = Record<string, ArgValue>;
type Context = Record<string, unknown>;

interface CaseDef {
  id: string;
  description: string;
  tool: string;
  args?: ArgMap;
  minRecords?: number;
  allowErrors?: string[];
  skipErrors?: string[];
  skipMessageIncludes?: string[];
  requireEnv?: string[];
  saveContext?: Record<string, string>;
  liveProfile?: boolean;
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

/** Resolve "{{contextKey|fallback}}" tokens in string args from captured context. */
function resolveArgs(args: ArgMap, ctx: Context): ArgMap {
  const resolved: ArgMap = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      const match = /^\{\{(.+?)\|(.*)\}\}$/.exec(value);
      if (match) {
        const [, ctxKey, fallback] = match;
        const fromCtx = ctx[ctxKey];
        resolved[key] =
          fromCtx !== undefined && fromCtx !== null && String(fromCtx) !== ""
            ? String(fromCtx)
            : fallback;
        continue;
      }
    }
    resolved[key] = value;
  }
  return resolved;
}

const requestedProfile = (() => {
  const idx = process.argv.indexOf("--profile");
  return idx >= 0 ? String(process.argv[idx + 1] ?? "full") : "full";
})();

function loadCases(): CaseDef[] {
  const raw = fs.readFileSync(path.join(SCRIPTS_DIR, "test-queries.json"), "utf8");
  const parsed = JSON.parse(raw) as CaseDef[];
  if (!Array.isArray(parsed)) {
    throw new Error("scripts/test-queries.json must be a JSON array of cases");
  }
  return parsed;
}

/**
 * In-process MCP tool invocation via InMemoryTransport + Client.
 * Mirrors the parsing done by tests/acceptance.live.test.ts: the tool payload is
 * the JSON in content[0].text.
 */
interface ToolClient {
  call: (tool: string, args: ArgMap) => Promise<{ payload?: Record<string, unknown>; elapsedMs: number; execError?: string }>;
  close: () => Promise<void>;
}

async function createToolClient(): Promise<ToolClient> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nl-gov-question-suite", version: "1.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    async call(tool, args) {
      const started = Date.now();
      try {
        const result = (await client.callTool({ name: tool, arguments: args })) as {
          content?: Array<{ type: string; text?: string }>;
          isError?: boolean;
        };
        const elapsedMs = Date.now() - started;
        const text = result.content?.find((c) => c.type === "text")?.text;
        if (!text) {
          return { elapsedMs, execError: `No text content returned from ${tool}` };
        }
        try {
          return { payload: JSON.parse(text) as Record<string, unknown>, elapsedMs };
        } catch {
          // Tool threw and the SDK wrapped a non-JSON error string in text content.
          return { elapsedMs, execError: result.isError ? text : `Unparseable payload from ${tool}: ${text.slice(0, 200)}` };
        }
      } catch (error) {
        const elapsedMs = Date.now() - started;
        const msg = error instanceof Error ? error.message : "tool call failed";
        return { elapsedMs, execError: msg };
      }
    },
    async close() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

async function main() {
  const allCases = loadCases();
  const context: Context = {};
  const results: CaseResult[] = [];
  const toolClient = await createToolClient();

  try {
    for (const testCase of allCases) {
      if (requestedProfile === "live" && !testCase.liveProfile) {
        continue;
      }

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

      const args = resolveArgs(testCase.args ?? {}, context);
      const maxAttempts = requestedProfile === "live" ? 3 : 2;
      let finalResult: CaseResult | undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const out = await toolClient.call(testCase.tool, args);

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
            const message = String(payload.message ?? "unknown error");
            const allowed = (testCase.allowErrors ?? []).includes(code);
            const shouldSkip =
              (testCase.skipErrors ?? []).includes(code) &&
              ((testCase.skipMessageIncludes ?? []).length === 0 ||
                (testCase.skipMessageIncludes ?? []).some((part) =>
                  message.toLowerCase().includes(part.toLowerCase()),
                ));
            finalResult = {
              id: testCase.id,
              tool: testCase.tool,
              description: testCase.description,
              status: allowed ? "PASS" : shouldSkip ? "SKIP" : "FAIL",
              elapsedMs: out.elapsedMs,
              records: 0,
              error: code,
              ...(shouldSkip ? { reason: `${code}: ${message}` } : { message }),
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
  } finally {
    await toolClient.close();
  }

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIP").length;

  const suiteLabel = requestedProfile === "live" ? "live suite" : "question suite";

  console.log(`\nNL-GOV-MCP ${suiteLabel} @ ${nowIso()}`);
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

  const reportPath = path.resolve(
    process.cwd(),
    requestedProfile === "live" ? "scripts/live-suite-report.json" : "scripts/question-suite-report.json",
  );
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
