import type { AppConfig } from "../types.js";
import { getText } from "../utils/http.js";
import { parseXml } from "../utils/xml-parser.js";

const RECHTSPRAAK_SEARCH = "https://data.rechtspraak.nl/uitspraken/zoeken";

type AnyRecord = Record<string, unknown>;

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function readText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const v = value as AnyRecord;
    const textLike = v["#text"] ?? v["_"] ?? v["text"];
    if (typeof textLike === "string") return textLike.trim();
  }
  return "";
}

function readHrefFromLinks(value: unknown): string {
  const links = asArray<unknown>(value);
  for (const raw of links) {
    if (!raw || typeof raw !== "object") continue;
    const link = raw as AnyRecord;
    const href = link.href;
    if (typeof href === "string" && href.trim()) return href.trim();
  }
  return "";
}

function extractEcli(text: string): string {
  const m = text.match(/ECLI:[A-Z]{2}:[A-Z0-9]+:[0-9]{4}:[A-Z0-9.:-]+/i);
  return m ? m[0].toUpperCase() : "";
}

function parseEntriesFromAtom(parsed: unknown): AnyRecord[] {
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as AnyRecord;

  // xml-parser strips namespaces in this repo utility, so Atom tags are usually plain names.
  const feed = (root.feed as AnyRecord | undefined) ?? root;
  const entriesRaw = (feed.entry as unknown) ?? (root.entry as unknown);
  return asArray<unknown>(entriesRaw)
    .filter((x): x is AnyRecord => Boolean(x && typeof x === "object"));
}

function normalizeEntry(entry: AnyRecord): AnyRecord {
  const id = readText(entry.id);
  const title = readText(entry.title);
  const summary = readText(entry.summary);
  const updated = readText(entry.updated);
  const href = readHrefFromLinks(entry.link);

  const ecliFromId = extractEcli(id);
  const ecliFromText = extractEcli(`${title} ${summary}`);
  const ecli = ecliFromId || ecliFromText;

  return {
    id: id || ecli || href || "",
    title: title || ecli || "Rechtspraak uitspraak",
    summary,
    updated,
    url: href || (ecli ? `https://data.rechtspraak.nl/uitspraken/content?id=${ecli}` : "https://data.rechtspraak.nl/uitspraken/zoeken"),
    ecli,
  };
}

function sanitizeQueryTerms(query: string): string[] {
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
  ]);

  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !stopwords.has(t));
}

function rankEntries(entries: AnyRecord[], terms: string[]): AnyRecord[] {
  const scored = entries.map((entry) => {
    const text = `${String(entry.title ?? "")} ${String(entry.summary ?? "")} ${String(entry.ecli ?? "")}`.toLowerCase();
    const score = terms.length
      ? terms.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0)
      : 0;
    return { entry, score };
  });

  // Keep everything when no terms (broad recent feed request)
  const filtered = terms.length ? scored.filter((s) => s.score > 0) : scored;

  return filtered
    .sort((a, b) => {
      const ua = String(a.entry.updated ?? "");
      const ub = String(b.entry.updated ?? "");
      if (b.score !== a.score) return b.score - a.score;
      return ub.localeCompare(ua);
    })
    .map((x) => x.entry);
}

export class RechtspraakSource {
  constructor(private readonly config: AppConfig) {}

  fallback(args: { query: string; rows: number }) {
    const slug = args.query.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return {
      items: [
        {
          id: `rechtspraak-fallback-${slug}`,
          title: `Rechtspraak fallback voor '${args.query}'`,
          summary: "Geen live Rechtspraak-resultaat beschikbaar binnen de huidige feed-oproep.",
          updated: new Date(0).toISOString(),
          url: "https://data.rechtspraak.nl/uitspraken/zoeken",
          ecli: undefined,
          source: "fallback",
        },
      ].slice(0, args.rows),
      endpoint: `${RECHTSPRAAK_SEARCH} (fallback)`,
      params: {
        return: "DOC",
        sort: "DESC",
        max: String(Math.min(Math.max(args.rows * 8, args.rows), 100)),
      },
      access_note:
        "Geen live match of endpoint-instabiliteit; fallbackrecord gebruikt.",
    };
  }

  async searchEcli(args: { query: string; rows: number }) {
    // Rechtspraak open feed supports paging/sorting; free-text is handled client-side.
    const params = {
      return: "DOC",
      sort: "DESC",
      max: String(Math.min(Math.max(args.rows * 8, args.rows), 100)),
    };

    const { data, meta } = await getText(RECHTSPRAAK_SEARCH, {
      query: params,
      timeoutMs: 20_000,
    });

    const parsed = parseXml(data);
    const normalized = parseEntriesFromAtom(parsed)
      .map(normalizeEntry)
      .filter((x) => /^ECLI:/i.test(String(x.ecli ?? "")));

    const terms = sanitizeQueryTerms(args.query);

    const exact = terms.length
      ? normalized.filter((entry) => {
          const text = `${String(entry.title ?? "")} ${String(entry.summary ?? "")} ${String(entry.ecli ?? "")}`.toLowerCase();
          return terms.every((t) => text.includes(t));
        })
      : normalized;

    const ranked = rankEntries(exact.length ? exact : normalized, terms);

    const items = ranked.slice(0, args.rows);

    return {
      items,
      endpoint: meta.url,
      params,
      ...(items.length
        ? {}
        : {
            access_note:
              "Geen passende ECLI-match gevonden in de recente open feed voor deze zoekterm.",
          }),
      ...(exact.length === 0 && items.length > 0 && terms.length > 1
        ? {
            access_note:
              "Geen volledige exacte termmatch gevonden; resultaten gerankt op beste term-overlap.",
          }
        : {}),
    };
  }
}
