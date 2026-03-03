import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

interface SparqlJsonBindingValue {
  type?: string;
  value?: string;
  datatype?: string;
  [key: string]: unknown;
}

interface SparqlJsonResponse {
  head?: { vars?: string[] };
  results?: { bindings?: Array<Record<string, SparqlJsonBindingValue>> };
}

export const SPARQL_LIMIT_CAP = 100;

const BLOCKED_KEYWORDS = [
  "insert",
  "delete",
  "load",
  "clear",
  "create",
  "drop",
  "copy",
  "move",
  "add",
  "construct",
  "describe",
  "ask",
  "service",
  "with",
];

function stripComments(query: string): string {
  return query
    .split("\n")
    .map((line) => line.replace(/#.*/, ""))
    .join("\n")
    .trim();
}

function validateSelectOnly(query: string): { ok: boolean; reason?: string } {
  const normalized = stripComments(query).replace(/\s+/g, " ").trim();
  const noPrefix = normalized.replace(/^(prefix\s+[^>]+>\s*)+/i, "").trim();

  if (!/^select\b/i.test(noPrefix)) {
    return { ok: false, reason: "Alleen SELECT queries zijn toegestaan." };
  }

  const lowered = ` ${noPrefix.toLowerCase()} `;
  for (const word of BLOCKED_KEYWORDS) {
    if (lowered.includes(` ${word} `)) {
      return { ok: false, reason: `SPARQL keyword niet toegestaan: ${word.toUpperCase()}` };
    }
  }

  return { ok: true };
}

function enforceLimit(query: string, requestedLimit: number): { safeQuery: string; appliedLimit: number } {
  const cap = Math.max(1, Math.min(SPARQL_LIMIT_CAP, requestedLimit));
  const stripped = query.trim().replace(/;\s*$/, "");
  const limitRegex = /\blimit\s+(\d+)\b/i;
  const match = stripped.match(limitRegex);
  if (!match) {
    return { safeQuery: `${stripped}\nLIMIT ${cap}`, appliedLimit: cap };
  }

  const currentLimit = Number(match[1]);
  if (Number.isFinite(currentLimit) && currentLimit <= cap) {
    return { safeQuery: stripped, appliedLimit: currentLimit };
  }

  return {
    safeQuery: stripped.replace(limitRegex, `LIMIT ${cap}`),
    appliedLimit: cap,
  };
}

function bindingToValue(binding: SparqlJsonBindingValue | undefined): unknown {
  if (!binding) return undefined;
  if (binding.datatype?.endsWith("#integer") || binding.datatype?.endsWith("#decimal") || binding.datatype?.endsWith("#double")) {
    const asNum = Number(binding.value);
    if (!Number.isNaN(asNum)) return asNum;
  }
  if (binding.datatype?.endsWith("#boolean")) {
    return String(binding.value).toLowerCase() === "true";
  }
  return binding.value;
}

export class SparqlLinkedDataSource {
  constructor(
    private readonly config: AppConfig,
    private readonly endpoint: string,
    private readonly sourceLabel: string,
  ) {}

  async select(args: { query: string; limit: number }) {
    const validation = validateSelectOnly(args.query);
    if (!validation.ok) {
      throw new Error(validation.reason ?? "Ongeldige SPARQL query");
    }

    const { safeQuery, appliedLimit } = enforceLimit(args.query, args.limit);

    const { data, meta } = await getJson<SparqlJsonResponse>(this.endpoint, {
      query: {
        query: safeQuery,
        format: "application/sparql-results+json",
      },
      headers: {
        Accept: "application/sparql-results+json",
      },
      timeoutMs: 20_000,
      retries: 1,
    });

    const vars = Array.isArray(data.head?.vars) ? data.head?.vars ?? [] : [];
    const bindings = Array.isArray(data.results?.bindings) ? data.results?.bindings ?? [] : [];

    const items = bindings.slice(0, appliedLimit).map((binding) => {
      const out: Record<string, unknown> = {};
      for (const v of vars) {
        out[v] = bindingToValue(binding[v]);
      }
      return out;
    });

    return {
      items,
      total: bindings.length,
      endpoint: meta.url,
      params: {
        limit: String(appliedLimit),
      },
      safeQuery,
      source: this.sourceLabel,
      ...(items.length ? {} : { access_note: `${this.sourceLabel} endpoint bereikbaar, maar query leverde geen bindings op.` }),
    };
  }

  fallback(args: { query: string; limit: number }) {
    return {
      items: [
        {
          id: `${this.sourceLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-fallback`,
          query: args.query,
          note: "Deterministische fallback voor SPARQL endpoint-onbereikbaarheid",
          timestamp: "1970-01-01T00:00:00Z",
        },
      ],
      total: 1,
      endpoint: `${this.endpoint} (fallback)`,
      params: { limit: String(Math.min(args.limit, SPARQL_LIMIT_CAP)) },
      access_note: `${this.sourceLabel} SPARQL endpoint was onbereikbaar of gaf geen parsebare SPARQL-JSON response; fallbackrecord gebruikt.`,
    };
  }
}
