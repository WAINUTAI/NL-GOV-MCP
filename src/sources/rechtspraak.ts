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

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export class RechtspraakSource {
  constructor(private readonly config: AppConfig) {}

  async searchEcli(args: { query: string; rows: number }) {
    const params = { term: args.query, max: String(args.rows) };
    const { data, meta } = await getText(RECHTSPRAAK_SEARCH, { query: params });
    const parsed = parseXml(data) as Record<string, unknown>;
    const feed = (parsed.feed as Record<string, unknown> | undefined) ?? parsed;
    const entries = toArray(feed.entry as Record<string, unknown> | Record<string, unknown>[] | undefined);

    const items: RechtspraakItem[] = entries.map((entry) => {
      const title = String((entry.title as string | undefined) ?? "Rechtspraak uitspraak");
      const id = String((entry.id as string | undefined) ?? "");
      const summary = String((entry.summary as string | undefined) ?? "");
      const updated = String((entry.updated as string | undefined) ?? "");
      const linkObj = entry.link as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
      const links = toArray(linkObj);
      const altLink = links.find((x) => String(x.rel ?? "") === "alternate") ?? links[0] ?? {};
      const href = String(altLink.href ?? id);
      const ecliMatch = `${title} ${id} ${summary}`.match(/ECLI:[A-Z]{2}:[A-Z0-9]+:[0-9]{4}:[A-Z0-9]+/i);
      return {
        id,
        title,
        summary,
        updated,
        link: href,
        ecli: ecliMatch ? ecliMatch[0].toUpperCase() : undefined,
      };
    });

    return {
      items: items.slice(0, args.rows),
      total: items.length,
      endpoint: meta.url,
      params,
    };
  }

  fallback(args: { query: string; rows: number }) {
    const normalized = args.query.trim().toUpperCase();
    const ecli = normalized.startsWith("ECLI:") ? normalized : `ECLI:NL:FALLBACK:1970:${normalized.replace(/[^A-Z0-9]+/g, "") || "UNKNOWN"}`;
    const item: RechtspraakItem = {
      id: `https://data.rechtspraak.nl/uitspraken/content?id=${encodeURIComponent(ecli)}`,
      title: `Fallback uitspraak voor ${ecli}`,
      summary: "Geen live resultaat beschikbaar vanuit huidige runtime.",
      updated: "1970-01-01T00:00:00Z",
      link: `https://data.rechtspraak.nl/uitspraken/content?id=${encodeURIComponent(ecli)}`,
      ecli,
      mode: "deterministic-fallback",
    };

    return {
      items: [item].slice(0, args.rows),
      total: 1,
      endpoint: `${RECHTSPRAAK_SEARCH} (fallback)`,
      params: { term: args.query, max: String(args.rows), mode: "deterministic-fallback" },
      access_note: "Rechtspraak zoekfeed tijdelijk niet bereikbaar of onvolledig parsebaar; fallback-resultaat gebruikt.",
    };
  }
}
