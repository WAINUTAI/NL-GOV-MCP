import { describe, expect, it } from "vitest";
import { estimateODataNodes, parseTkQuery, buildTextFilter, TweedeKamerSource } from "../src/sources/tweede-kamer.js";
import { testConfig } from "./helpers/config.js";

/**
 * Independent count of $filter nodes as the Gegevensmagazijn counts them,
 * measured on the live service to one node (October 2026):
 * - a property is 1 node per path segment plus 1 for the $it it starts from
 *   (a lambda variable replaces $it: z/Titel is 2);
 * - a literal is 1; a date, GUID or Boolean compared to a nullable property
 *   gets a conversion (+1), a string does not; keys (Id) are not nullable;
 * - a function call is 1 plus its arguments; contains/startswith/endswith
 *   yield a non-nullable Boolean, a comparison on a nullable property a
 *   nullable one;
 * - and/or is 1 plus both sides, plus 1 when one side is nullable and the
 *   other is not; not is 1; any() is 1 + its source path + 1 + its body.
 * The service accepts a filter of up to 100 nodes.
 */
type Kind = "nullable" | "nonnull" | "value";
interface Node {
  nodes: number;
  kind: Kind;
  key?: boolean;
  convertible?: boolean;
}

const TOKEN_RE =
  /\s*(?:('(?:[^']|'')*')|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|(\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?)|(\d+(?:\.\d+)?)|([A-Za-z_]\w*)|([(),/:]))/giy;

function tokenize(s: string): Array<{ t: string; v: string }> {
  const out: Array<{ t: string; v: string }> = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (TOKEN_RE.lastIndex < s.length && (m = TOKEN_RE.exec(s))) {
    if (m[1]) out.push({ t: "str", v: m[1] });
    else if (m[2]) out.push({ t: "guid", v: m[2] });
    else if (m[3]) out.push({ t: "date", v: m[3] });
    else if (m[4]) out.push({ t: "num", v: m[4] });
    else if (m[5]) out.push({ t: "id", v: m[5] });
    else if (m[6]) out.push({ t: "p", v: m[6] });
  }
  if (TOKEN_RE.lastIndex < s.trimEnd().length) throw new Error(`cannot tokenize at ${s.slice(TOKEN_RE.lastIndex, TOKEN_RE.lastIndex + 20)}`);
  return out;
}

const BOOL_FUNCTIONS = new Set(["contains", "startswith", "endswith"]);
const COMPARISONS = new Set(["eq", "ne", "gt", "ge", "lt", "le"]);

function serviceNodeCount(filter: string): number {
  const toks = tokenize(filter);
  let i = 0;
  const vars = new Set<string>();
  const peek = (v?: string) => (v === undefined ? toks[i] : toks[i] && toks[i].v.toLowerCase() === v.toLowerCase() ? toks[i] : undefined);
  const take = (v?: string) => {
    const tok = toks[i];
    if (!tok || (v !== undefined && tok.v.toLowerCase() !== v.toLowerCase())) throw new Error(`expected ${v} at token ${i} (${tok?.v})`);
    i += 1;
    return tok;
  };
  const join = (l: Node, r: Node): Node => ({
    nodes: l.nodes + r.nodes + 1 + (l.kind !== r.kind ? 1 : 0),
    kind: l.kind === "nullable" || r.kind === "nullable" ? "nullable" : "nonnull",
  });

  const operand = (): Node => {
    const tok = take();
    if (tok.v === "(") {
      const e = or();
      take(")");
      return e;
    }
    if (tok.t === "str" || tok.t === "num") return { nodes: 1, kind: "value" };
    if (tok.t === "guid" || tok.t === "date") return { nodes: 1, kind: "value", convertible: true };
    if (tok.t !== "id") throw new Error(`unexpected ${tok.v}`);
    const lower = tok.v.toLowerCase();
    if (lower === "true" || lower === "false") return { nodes: 1, kind: "value", convertible: true };
    if (lower === "null") return { nodes: 1, kind: "value" };
    if (peek("(")) {
      take("(");
      let nodes = 1;
      for (;;) {
        nodes += or().nodes;
        if (peek(",")) take(",");
        else break;
      }
      take(")");
      return { nodes, kind: BOOL_FUNCTIONS.has(lower) ? "nonnull" : "value" };
    }
    const segments = [tok.v];
    while (peek("/")) {
      take("/");
      const seg = take();
      if ((seg.v === "any" || seg.v === "all") && peek("(")) {
        take("(");
        const source = segments.length + (vars.has(segments[0]) ? 0 : 1);
        const variable = take().v;
        take(":");
        vars.add(variable);
        const body = or();
        take(")");
        return { nodes: source + 2 + body.nodes, kind: "nonnull" };
      }
      segments.push(seg.v);
    }
    const nodes = segments.length + (vars.has(segments[0]) ? 0 : 1);
    return { nodes, kind: "value", key: segments[segments.length - 1] === "Id" };
  };

  const comparison = (): Node => {
    const left = operand();
    const op = peek();
    if (op && op.t === "id" && COMPARISONS.has(op.v.toLowerCase())) {
      take();
      const right = operand();
      const convert = right.convertible && !left.key ? 1 : 0;
      return { nodes: 1 + left.nodes + right.nodes + convert, kind: left.key ? "nonnull" : "nullable" };
    }
    return left;
  };
  const not = (): Node => {
    if (peek("not")) {
      take("not");
      const o = not();
      return { nodes: o.nodes + 1, kind: o.kind };
    }
    return comparison();
  };
  const and = (): Node => {
    let l = not();
    while (peek("and")) {
      take("and");
      l = join(l, not());
    }
    return l;
  };
  function or(): Node {
    let l = and();
    while (peek("or")) {
      take("or");
      l = join(l, and());
    }
    return l;
  }

  const result = or();
  if (i !== toks.length) throw new Error(`trailing tokens from ${toks[i].v}`);
  return result.nodes;
}

const LIMIT = 100;

/** The word filter the previous version generated (8 patterns, `eq` in the middle). */
function oldWordPart(t: string, k: number): string {
  const p = (f: string) =>
    [
      `contains(${f},' ${t} ')`,
      `contains(${f},' ${t}-')`,
      `contains(${f},'(${t})')`,
      `endswith(${f},' ${t}')`,
      `startswith(${f},'${t} ')`,
      `${f} eq '${t}'`,
      `startswith(${f},'${t}-')`,
      `contains(${f},'/${t} ')`,
    ].slice(0, k);
  return `(contains(Titel,'${t}') or contains(Onderwerp,'${t}')) and (${[...p("Titel"), ...p("Onderwerp")].join(" or ")})`;
}

describe("service node count model", () => {
  it("reproduces the single-construct costs measured on the live service", () => {
    expect(serviceNodeCount("contains(Titel,'x')")).toBe(4);
    expect(serviceNodeCount("Titel eq 'x'")).toBe(4);
    expect(serviceNodeCount("Datum ge 2026-09-01T00:00:00+02:00")).toBe(5);
    expect(serviceNodeCount("Verwijderd eq false")).toBe(5);
    expect(serviceNodeCount("Besluit_Id eq 64db5eb1-4ad8-4ee1-88c5-9960d34d6423")).toBe(5);
    expect(serviceNodeCount("Besluit/Agendapunt/Activiteit/Datum ge 2026-09-01T00:00:00+02:00")).toBe(8);
    expect(serviceNodeCount("contains(concat(concat(' ',Titel),' '),' x ')")).toBe(8);
    expect(serviceNodeCount("contains(concat(' ',Titel),' x-')")).toBe(6);
    expect(serviceNodeCount("Besluit/Zaak/any(z: z/Nummer eq '2026Z15215')")).toBe(9);
    expect(serviceNodeCount("Besluit/Zaak/any(z: z/Id eq 64db5eb1-4ad8-4ee1-88c5-9960d34d6423)")).toBe(9);
    expect(serviceNodeCount("Besluit/Zaak/any(z: contains(z/Titel,'x') or contains(z/Onderwerp,'x'))")).toBe(14);
    // A nullable and a non-nullable Boolean joined: one conversion per mixed join.
    expect(serviceNodeCount("contains(Titel,'a') or contains(Titel,'b') or Titel eq 'c'")).toBe(15);
    expect(serviceNodeCount("Titel eq 'c' or contains(Titel,'a') or contains(Titel,'b')")).toBe(16);
  });

  it("agrees with the live accept/reject observations that the old planner got wrong", () => {
    // Accepted live: 8 patterns alone, and 7 patterns with two date bounds.
    expect(serviceNodeCount(oldWordPart("WW", 8))).toBe(100);
    expect(
      serviceNodeCount(`(${oldWordPart("WW", 7)}) and ((Datum ge 2026-09-01T00:00:00+02:00) and (Datum lt 2026-10-01T00:00:00+02:00))`),
    ).toBe(100);
    // Rejected live (HTTP 400, node count limit) although planned at 95 and 94.
    expect(serviceNodeCount(`(${oldWordPart("WW", 8)}) and (Datum ge 2026-09-01T00:00:00+02:00)`)).toBe(106);
    expect(serviceNodeCount(`(${oldWordPart("WW", 8)}) and (Soort eq 'Motie')`)).toBe(105);
  });
});

describe("planned filters stay within the service limit", () => {
  const tk = new TweedeKamerSource(testConfig);
  const count = (filter: string | undefined) => (filter ? serviceNodeCount(filter) : 0);

  it("plans the cases that were rejected with HTTP 400 within 100 nodes", () => {
    const plans = [
      tk.planDocuments({ query: "WW", top: 10, date_from: "2026-09-01" }),
      tk.planDocuments({ query: "EU", top: 5, date_to: "2026-09-30" }),
      tk.planDocuments({ query: "WW zorg", top: 5, date_from: "2026-09-01" }),
      tk.planDocuments({ query: '"sociale advocatuur"', top: 5, date_from: "2026-09-01" }),
      tk.planSearch({ entity: "Document", query: "WW", top: 5, filter: "Soort eq 'Motie'" }),
      tk.planSearch({ entity: "Zaak", query: "ICT", top: 5, date_from: "2026-01-01" }),
    ];
    for (const plan of plans) {
      expect(count(plan.params.$filter)).toBeLessThanOrEqual(LIMIT);
    }
  });

  it("keeps every combination of short terms, dates, type and filters within 100 nodes", () => {
    const queries = ["WW", "WW EU", "WW EU ICT", '"sociale advocatuur"', "WW zorg", "stikstof", "Rob de Bos", "SP"];
    const dates: Array<[string | undefined, string | undefined]> = [
      [undefined, undefined],
      ["2026-01-01", undefined],
      ["2026-01-01", "2026-09-30"],
    ];
    const filters = [undefined, "Soort eq 'Motie'", "Soort eq 'Voor' and Vergissing eq false", "Verwijderd eq false and contains(Titel,'x')"];
    for (const query of queries) {
      for (const [date_from, date_to] of dates) {
        const docs = tk.planDocuments({ query, top: 5, date_from, date_to });
        expect(count(docs.params.$filter)).toBeLessThanOrEqual(LIMIT);
        const typed = tk.planDocuments({ query, top: 5, date_from, date_to, type: "Motie" });
        expect(count(typed.params.$filter)).toBeLessThanOrEqual(LIMIT);
        const votes = tk.planVotes({ query, top: 5, date_from, date_to, zaak_nummer: "2026Z15215" });
        expect(count(votes.params.$filter)).toBeLessThanOrEqual(LIMIT);
        const either = tk.planVotes({ query, top: 5, date_from, date_to, zaak_id: "64db5eb1-4ad8-4ee1-88c5-9960d34d6423" });
        expect(count(either.params.$filter)).toBeLessThanOrEqual(LIMIT);
        for (const filter of filters) {
          for (const entity of ["Document", "Zaak", "Stemming"]) {
            const plan = tk.planSearch({ entity, query, top: 5, date_from, date_to, filter });
            expect(count(plan.params.$filter)).toBeLessThanOrEqual(LIMIT);
          }
          const persoon = tk.planSearch({ entity: "Persoon", query, top: 5, filter });
          expect(count(persoon.params.$filter)).toBeLessThanOrEqual(LIMIT);
        }
      }
    }
  });

  it("stays within 100 nodes whatever the count of candidate rows allows, and so does the count itself", () => {
    const queries = ["WW", "WW EU", "WW EU ICT", "ING parkeerbeleid", "SP"];
    for (const candidateRows of [0, 50, 300_000]) {
      for (const query of queries) {
        for (const [date_from, date_to] of [[undefined, undefined], ["2026-01-01", "2026-09-30"]] as const) {
          const docs = tk.planDocuments({ query, top: 5, date_from, date_to, type: "Motie" }, { candidateRows });
          expect(count(docs.params.$filter)).toBeLessThanOrEqual(LIMIT);
          const votes = tk.planVotes({ query, top: 5, date_from, date_to }, { candidateRows });
          expect(count(votes.params.$filter)).toBeLessThanOrEqual(LIMIT);
          for (const filter of [undefined, "Soort eq 'Voor' and Vergissing eq false"]) {
            for (const entity of ["Document", "Zaak", "Stemming"]) {
              const plan = tk.planSearch({ entity, query, top: 5, date_from, date_to, filter }, { candidateRows });
              expect(count(plan.params.$filter)).toBeLessThanOrEqual(LIMIT);
            }
          }
        }
      }
    }
    for (const query of queries) {
      for (const probe of [
        tk.planDocuments({ query, top: 5, type: "Motie", date_from: "2026-01-01" }).probe,
        tk.planVotes({ query, top: 5, date_from: "2026-01-01" }).probe,
        tk.planSearch({ entity: "Zaak", query, top: 5, filter: "Soort eq 'Motie'" }).probe,
      ]) {
        if (probe) expect(count(probe.filter)).toBeLessThanOrEqual(LIMIT);
      }
    }
  });

  it("estimates a caller filter at or above what the service counts", () => {
    for (const filter of [
      "Soort eq 'Motie'",
      "Soort eq 'Voor' and Vergissing eq false",
      "Verwijderd eq false and contains(Functie,'Kamerlid')",
      "contains(Titel,'x') or contains(Onderwerp,'x')",
      "Besluit_Id eq 64db5eb1-4ad8-4ee1-88c5-9960d34d6423",
      "Besluit/Agendapunt/Activiteit/Datum ge 2026-07-02T00:00:00+02:00",
      "Besluit/Zaak/any(z: z/Nummer eq '2026Z15215')",
      "not (Soort eq 'Motie') and Datum ge 2026-01-01",
    ]) {
      expect(estimateODataNodes(filter)).toBeGreaterThanOrEqual(serviceNodeCount(filter));
    }
  });

  it("counts its own text filter the way the service does", () => {
    for (const query of ["WW", "WW EU", "WW zorg", '"sociale advocatuur"', "stikstof motie"]) {
      const text = buildTextFilter(parseTkQuery(query).terms, ["Titel", "Onderwerp"], 0);
      expect(text.part!.nodes).toBe(serviceNodeCount(text.part!.expr));
    }
  });
});
