import type { AppConfig } from "../types.js";
import { getText } from "../utils/http.js";
import { parseXml } from "../utils/xml-parser.js";

const RECHTSPRAAK_SEARCH = "https://data.rechtspraak.nl/uitspraken/zoeken";
const RECHTSPRAAK_CONTENT = "https://data.rechtspraak.nl/uitspraken/content";

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
  const feed = (root.feed as AnyRecord | undefined) ?? root;
  const entriesRaw = (feed.entry as unknown) ?? (root.entry as unknown);
  return asArray<unknown>(entriesRaw).filter(
    (x): x is AnyRecord => Boolean(x && typeof x === "object"),
  );
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
    url:
      href ||
      (ecli
        ? `${RECHTSPRAAK_CONTENT}?id=${encodeURIComponent(ecli)}`
        : RECHTSPRAAK_SEARCH),
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
    "bij",
    "om",
    "hoe",
    "waar",
    "welke",
  ]);

  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !stopwords.has(t));
}

function scoreTextMatch(text: string, terms: string[]): number {
  if (!terms.length) return 0;
  const low = text.toLowerCase();
  return terms.reduce((acc, t) => acc + (low.includes(t) ? 1 : 0), 0);
}

function rankEntries(entries: AnyRecord[], terms: string[]): AnyRecord[] {
  const scored = entries
    .map((entry) => {
      const text = `${String(entry.title ?? "")} ${String(entry.summary ?? "")} ${String(entry.ecli ?? "")}`;
      const score = scoreTextMatch(text, terms);
      return { entry, score };
    })
    .filter(({ score }) => (terms.length ? score > 0 : true));

  return scored
    .sort((a, b) => {
      const ua = String(a.entry.updated ?? "");
      const ub = String(b.entry.updated ?? "");
      if (b.score !== a.score) return b.score - a.score;
      return ub.localeCompare(ua);
    })
    .map((x) => x.entry);
}

async function contentContainsTerms(
  ecli: string,
  terms: string[],
): Promise<{ all: boolean; score: number }> {
  if (!ecli || !terms.length) return { all: false, score: 0 };

  try {
    const { data } = await getText(RECHTSPRAAK_CONTENT, {
      query: { id: ecli },
      timeoutMs: 8_000,
      retries: 0,
    });
    const low = data.toLowerCase();
    const score = terms.reduce((acc, t) => acc + (low.includes(t) ? 1 : 0), 0);
    return { all: score === terms.length, score };
  } catch {
    return { all: false, score: 0 };
  }
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
          summary:
            "Geen live Rechtspraak-resultaat beschikbaar binnen de huidige feed-oproep.",
          updated: new Date(0).toISOString(),
          url: RECHTSPRAAK_SEARCH,
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
    const params = {
      return: "DOC",
      sort: "DESC",
      max: String(Math.min(Math.max(args.rows * 10, args.rows), 100)),
    };

    const { data, meta } = await getText(RECHTSPRAAK_SEARCH, {
      query: params,
      timeoutMs: 20_000,
    });

    const parsed = parseXml(data);
    const entries = parseEntriesFromAtom(parsed)
      .map(normalizeEntry)
      .filter((x) => /^ECLI:/i.test(String(x.ecli ?? "")));

    const terms = sanitizeQueryTerms(args.query);
    const ranked = rankEntries(entries, terms);

    let selected = ranked.slice(0, args.rows);
    let accessNote: string | undefined;

    // If no strong title/summary match, validate top recent ECLI content for term presence.
    if (terms.length && selected.length === 0) {
      const candidates = entries.slice(0, 20);
      const withContentScore: Array<{ item: AnyRecord; score: number; all: boolean }> = [];
      for (const c of candidates) {
        const ecli = String(c.ecli ?? "");
        const hit = await contentContainsTerms(ecli, terms);
        if (hit.score > 0) {
          withContentScore.push({ item: c, score: hit.score, all: hit.all });
        }
      }

      withContentScore.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const ua = String(a.item.updated ?? "");
        const ub = String(b.item.updated ?? "");
        return ub.localeCompare(ua);
      });

      selected = withContentScore.map((x) => x.item).slice(0, args.rows);
      if (selected.length) {
        accessNote =
          "Resultaten zijn geselecteerd met aanvullende full-text controle op uitspraakinhoud.";
      }
    }

    if (!selected.length) {
      return {
        items: [],
        endpoint: meta.url,
        params,
        access_note:
          "Geen passende ECLI-match gevonden in de recente open feed voor deze zoekterm.",
      };
    }

    return {
      items: selected,
      endpoint: meta.url,
      params,
      ...(accessNote ? { access_note: accessNote } : {}),
    };
  }
}
