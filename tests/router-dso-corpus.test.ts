import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectDsoIntent, registerTools } from "../src/tools.js";
import { NON_DSO_QUESTIONS, ROUND_TWO_NON_DSO, ADVERSARIAL_NON_DSO, DSO_QUESTIONS, LEFT_TO_OTHER_ROUTES } from "./helpers/router-corpus.js";

/* ------------------------------------------------------------------ */
/*  The DSO route must not take questions that other routes answer.   */
/*  With DSO_API_KEY set, every question below gets the plan it gets  */
/*  without the key, which is the plan it had before the DSO route:   */
/*  the first review round's corpus, the second round's and a set of  */
/*  questions with DSO words, numbers, places and addresses.          */
/* ------------------------------------------------------------------ */

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
const tools = new Map<string, { schema: Record<string, { parse: (v: unknown) => unknown }>; handler: Handler }>();
registerTools({
  registerTool(name: string, cfg: { inputSchema?: Record<string, { parse: (v: unknown) => unknown }> }, handler: Handler) {
    tools.set(name, { schema: cfg.inputSchema ?? {}, handler });
  },
} as unknown as McpServer);

async function plan(question: string): Promise<Record<string, unknown>> {
  const tool = tools.get("nl_gov_ask")!;
  const args: Record<string, unknown> = { question, dryRun: true, reference_now: "2026-10-06T10:00:00+02:00" };
  const parsed: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.schema)) parsed[key] = schema.parse(args[key]);
  const out = await tool.handler(parsed);
  return JSON.parse(out.content[0].text);
}

const ROUND_TWO = Object.entries(ROUND_TWO_NON_DSO).flatMap(([route, questions]) => questions.map((q) => [route, q] as const));
const ADVERSARIAL = ADVERSARIAL_NON_DSO.map((q) => ["adversarial", q] as const);

/** With DSO_API_KEY set, each question gets the plan it gets without the key. */
async function expectSamePlans(questions: ReadonlyArray<readonly [string, string]>) {
  for (const [route, question] of questions) {
    vi.stubEnv("DSO_API_KEY", "");
    const without = await plan(question);
    vi.stubEnv("DSO_API_KEY", "test-key");
    const withKey = await plan(question);
    expect(withKey, `${route}: ${question}`).toEqual(without);
    expect(withKey.estimated_sources, `${route}: ${question}`).not.toContain("dso_omgevingsdocumenten");
  }
}

describe("nl_gov_ask: questions for other routes keep their plan with DSO_API_KEY", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const all = Object.entries(NON_DSO_QUESTIONS).flatMap(([route, questions]) => questions.map((q) => [route, q] as const));

  it("holds corpora over every route: the first round's, the second round's and the adversarial set", () => {
    expect(all.length).toBeGreaterThanOrEqual(150);
    expect(new Set(all.map(([, q]) => q)).size).toBe(all.length);
    expect(ROUND_TWO.length).toBeGreaterThanOrEqual(400);
    expect(new Set(ROUND_TWO.map(([, q]) => q)).size).toBe(ROUND_TWO.length);
    expect(ADVERSARIAL.length).toBeGreaterThanOrEqual(100);
    expect(new Set(ADVERSARIAL_NON_DSO).size).toBe(ADVERSARIAL.length);
  });

  it("finds no DSO intent in them", () => {
    for (const [route, question] of [...all, ...ROUND_TWO, ...ADVERSARIAL]) expect(detectDsoIntent(question), `${route}: ${question}`).toBeUndefined();
  });

  it("plans exactly as without the key: first round", async () => {
    await expectSamePlans(all);
  });

  it("plans exactly as without the key: second round", { timeout: 60_000 }, async () => {
    await expectSamePlans(ROUND_TWO);
  });

  it("plans exactly as without the key: adversarial set", { timeout: 60_000 }, async () => {
    await expectSamePlans(ADVERSARIAL);
  });

  it("still plans the DSO for Omgevingswet document questions", async () => {
    vi.stubEnv("DSO_API_KEY", "test-key");
    for (const question of DSO_QUESTIONS) {
      expect((await plan(question)).estimated_sources, question).toEqual(["dso_omgevingsdocumenten"]);
    }
  });

  it("leaves the DSO questions it cannot read precisely to the routes they had", async () => {
    for (const question of LEFT_TO_OTHER_ROUTES) {
      expect(detectDsoIntent(question), question).toBeUndefined();
      vi.stubEnv("DSO_API_KEY", "");
      const without = await plan(question);
      vi.stubEnv("DSO_API_KEY", "test-key");
      expect(await plan(question), question).toEqual(without);
    }
  });
});
