import type { AppConfig } from "../types.js";
import { getText } from "../utils/http.js";
import { parseXml } from "../utils/xml-parser.js";

interface RechtspraakItem {
  id?: string;
  title?: string;
  summary?: string;
  updated?: string;
  link?: string;
  ecli?: string;
  [key: string]: unknown;
}

const RECHTSPRAAK_SEARCH = "https://data.rechtspraak.nl/uitspraken/zoeken";
const RECHTSPRAAK_CONTENT = "https://data.rechtspraak.nl/uitspraken/content";

type AnyRecord = Record<string, unknown>;

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    const obj = value as AnyRecord;
    const direct = obj["#text"] ?? obj["_"] ?? obj["text"];
    if (typeof direct === "string") return direct.trim();
  }
  return "";
}

function ecliFrom(text: string): string | undefined {
  const m = text.match(/ECLI:[A-Z]{2}:[A-Z0-9]+:[0-9]{4}:[A-Z0-9.:-]+/i);
  return m ? m[0].toUpperCase() : undefined;
}

function normalizeEntry(entry: AnyRecord): RechtspraakItem {
  const id = textValue(entry.id);
  const title = textValue(entry.title);
  const summary = textValue(entry.summary);
  const updated = textValue(entry.updated);

  const links = toArray<unknown>(entry.link)
    .filter((x): x is AnyRecord => Boolean(x && typeof x === "object"));
  const preferredLink =
    links.find((x) => String(x.rel ?? "") === "alternate") ?? links[0] ?? {};
  const href = textValue((preferredLink as AnyRecord).href);

  const ecli =
    ecliFrom(id) ?? ecliFrom(title) ?? ecliFrom(summary) ?? undefined;

  const fallbackLink = ecli
    ? `${RECHTSPRAAK_CONTENT}?id=${encodeURIComponent(ecli)}`
    : RECHTSPRAAK_SEARCH;

  return {
    id: id || ecli || href || fallbackLink,
    title: title || ecli || "Rechtspraak uitspraak",
    summary,
    updated,
    link: href || fallbackLink,
    ecli,
  };
}

function parseAtomEntries(parsed: unknown): RechtspraakItem[] {
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as AnyRecord;
  const feed = (root.feed as AnyRecord | undefined) ?? root;
  const rawEntries = (feed.entry as unknown) ?? (root.entry as unknown);

  return toArray<unknown>(rawEntries)
    .filter((x): x is AnyRecord => Boolean(x && typeof x === "object"))
    .map(normalizeEntry)
    .filter((x) => Boolean(x.ecli));
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

function sanitizeTerms(query: string): string[] {
  const stopwords = new Set([
    "de",
    "het",
    "een",
    "en",
    "of",
    "van",
    "voor",
    "met",
    "op",
    "in",
    "aan",
    "over",
    "wat",
    "is",
    "zijn",
    "dat",
    "die",
    "dit",
    "naar",
    "tot",
    "bij",
    "om",
  ]);

  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !stopwords.has(t));
}

function scoreTermHits(text: string, terms: string[]): number {
  if (!terms.length) return 0;
  return terms.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0);
}

async function loadContentText(ecli: string): Promise<string> {
  try {
    const { data } = await getText(RECHTSPRAAK_CONTENT, {
      query: { id: ecli },
      timeoutMs: 8_000,
      retries: 1,
    });
    // Convert XML-ish payload to plain searchable text.
    return normalizeWhitespace(data.replace(/<[^>]+>/g, " "));
  } catch {
    return "";
  }
}

function createNoMatchItem(query: string): RechtspraakItem {
  const link = `${RECHTSPRAAK_SEARCH}?term=${encodeURIComponent(query)}`;
  return {
    id: `rechtspraak-no-match-${query.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "query"}`,
    title: `Geen passende Rechtspraak-uitspraak gevonden voor '${query}'`,
    summary:
      "De open feed gaf geen verifieerbare match op basis van metadata + inhoudscontrole.",
    updated: new Date(0).toISOString(),
    link,
    ecli: undefined,
    mode: "deterministic-no-match",
  };
}

export class RechtspraakSource {
  constructor(private readonly config: AppConfig) {}

  async searchEcli(args: { query: string; rows: number }) {
    const pageSize = Math.min(Math.max(args.rows * 4, args.rows), 100);
    const params = {
      return: "DOC",
      sort: "DESC",
      max: String(pageSize),
      term: args.query,
    };

    const { data, meta } = await getText(RECHTSPRAAK_SEARCH, {
      query: params,
      timeoutMs: 20_000,
      retries: 2,
    });

    const parsed = parseXml(data);
    const entries = parseAtomEntries(parsed);

    const terms = sanitizeTerms(args.query);
    const seen = new Set<string>();

    // First pass: metadata-based ranking.
    const ranked = entries
      .map((item) => {
        const merged = normalizeWhitespace(
          `${item.title ?? ""} ${item.summary ?? ""} ${item.ecli ?? ""}`,
        );
        const score = scoreTermHits(merged, terms);
        return { item, score };
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return String(b.item.updated ?? "").localeCompare(String(a.item.updated ?? ""));
      });

    // Strictness to avoid false positives:
    // - single term: must be present in metadata OR content
    // - multiple terms: all terms must be present (prefer content validation)
    const results: RechtspraakItem[] = [];

    for (const candidate of ranked) {
      const item = candidate.item;
      const ecli = item.ecli ?? "";
      if (!ecli || seen.has(ecli)) continue;
      seen.add(ecli);

      const merged = normalizeWhitespace(
        `${item.title ?? ""} ${item.summary ?? ""} ${item.ecli ?? ""}`,
      );
      const metaHits = scoreTermHits(merged, terms);

      let isMatch = false;

      if (!terms.length) {
        isMatch = true;
      } else if (terms.length === 1) {
        isMatch = metaHits >= 1;
      } else {
        isMatch = metaHits === terms.length;
      }

      // If metadata is insufficient, validate on document content.
      if (!isMatch) {
        const content = await loadContentText(ecli);
        const contentHits = scoreTermHits(content, terms);
        if (terms.length === 1) {
          isMatch = contentHits >= 1;
        } else {
          isMatch = contentHits === terms.length;
        }
      }

      if (!isMatch) continue;

      results.push(item);
      if (results.length >= args.rows) break;
    }

    if (!results.length) {
      const item = createNoMatchItem(args.query);
      return {
        items: [item].slice(0, args.rows),
        total: 1,
        endpoint: meta.url,
        params,
        access_note:
          "Geen passende ECLI-match gevonden voor deze zoekterm op basis van metadata + inhoudscontrole.",
      };
    }

    return {
      items: results,
      total: results.length,
      endpoint: meta.url,
      params,
    };
  }

  fallback(args: { query: string; rows: number }) {
    const item = createNoMatchItem(args.query);

    return {
      items: [item].slice(0, args.rows),
      total: 1,
      endpoint: `${RECHTSPRAAK_SEARCH} (fallback)`,
      params: {
        return: "DOC",
        sort: "DESC",
        max: String(Math.min(Math.max(args.rows * 4, args.rows), 100)),
        term: args.query,
        mode: "deterministic-fallback",
      },
      access_note:
        "Rechtspraak zoekfeed tijdelijk niet bereikbaar of onvoldoende betrouwbaar; no-match fallbackrecord gebruikt.",
    };
  }
}
