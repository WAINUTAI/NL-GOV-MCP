import type { AppConfig } from "../types.js";
import { getJson, getText } from "../utils/http.js";
import { parseXml } from "../utils/xml-parser.js";

/**
 * Nieuw keyless zoek-/nieuws-endpoint van het Rijksoverheid.nl-platform (RSS 2.0).
 * De oude opendata.rijksoverheid.nl `/documents`-API is per 2 juni 2026 opgeheven (404);
 * alleen `/infotypes/schoolholidays` leeft daar nog (zie schoolholidays()).
 */
const RIJKSOVERHEID_RSS_BASE = "https://www.rijksoverheid.nl/api/rss";

/** Normaliseer een fast-xml-parser waarde naar een array (één item wordt geen array). */
function asArray(data: unknown): Array<Record<string, unknown>> {
  if (data === undefined || data === null) return [];
  return Array.isArray(data)
    ? (data as Array<Record<string, unknown>>)
    : [data as Record<string, unknown>];
}

/** RFC-822 pubDate → ISO 8601; laat de ruwe waarde staan als parsing faalt. */
function toIsoDate(raw: string): string {
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? raw : new Date(ts).toISOString();
}

/** Haal de tekst uit een RSS-veld dat een string óf een { "#text", ...attrs }-object kan zijn. */
function nodeText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    const text = (value as Record<string, unknown>)["#text"];
    return text === undefined ? "" : String(text);
  }
  return String(value);
}

export class RijksoverheidSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: {
    query: string;
    top: number;
    type?: "news" | "all";
    date_from?: string;
    date_to?: string;
  }) {
    const type = args.type ?? "news";
    const filters =
      type === "all"
        ? []
        : [{ field: "content_type", values: ["pro:newsDocument"], type: "all" }];
    const queryObj = {
      filters,
      resultSearchTerm: args.query,
      pageTitle: type === "all" ? "Zoeken" : "Nieuws",
    };
    const url = `${RIJKSOVERHEID_RSS_BASE}?query=${encodeURIComponent(JSON.stringify(queryObj))}`;

    const { data, meta } = await getText(url, { connector: "rijksoverheid" });
    const parsed = parseXml(data) as Record<string, unknown> | undefined;
    const rss = (parsed?.rss ?? {}) as Record<string, unknown>;
    const channel = (rss.channel ?? {}) as Record<string, unknown>;
    const rawItems = asArray(channel.item);

    let items = rawItems.map((item) => {
      const link = nodeText(item.link);
      const guid = nodeText(item.guid);
      const pubDate = nodeText(item.pubDate);
      return {
        id: guid || link,
        title: nodeText(item.title),
        url: link,
        snippet: nodeText(item.description),
        date: pubDate ? toIsoDate(pubDate) : "",
        type,
      };
    });

    // Client-side date-filter op pubDate (het RSS-platform kent geen date-parameters).
    if (args.date_from?.trim()) {
      const from = Date.parse(`${args.date_from.trim()}T00:00:00Z`);
      if (!Number.isNaN(from)) {
        items = items.filter((item) => {
          const ts = Date.parse(String(item.date));
          return Number.isNaN(ts) ? true : ts >= from;
        });
      }
    }
    if (args.date_to?.trim()) {
      const until = Date.parse(`${args.date_to.trim()}T23:59:59Z`);
      if (!Number.isNaN(until)) {
        items = items.filter((item) => {
          const ts = Date.parse(String(item.date));
          return Number.isNaN(ts) ? true : ts <= until;
        });
      }
    }

    const total = items.length;
    const sliced = items.slice(0, args.top);

    const params: Record<string, string> = {
      query: args.query,
      type,
      top: String(args.top),
    };
    if (args.date_from?.trim()) params.date_from = args.date_from.trim();
    if (args.date_to?.trim()) params.date_to = args.date_to.trim();

    const result: {
      items: Array<Record<string, unknown>>;
      total: number;
      endpoint: string;
      params: Record<string, string>;
      access_note?: string;
    } = {
      items: sliced,
      total,
      endpoint: meta.url,
      params,
    };

    result.access_note =
      total === 0
        ? `Geen resultaten via het Rijksoverheid RSS-zoekplatform voor "${args.query}" (type=${type}). Server-side keyword-zoek levert max ~20 resultaten per query; probeer bredere trefwoorden of type=all (nieuws + documenten + persberichten).`
        : `Server-side keyword-zoek (resultSearchTerm) via het nieuwe Rijksoverheid RSS-platform. Max ~20 resultaten per query en geen paginatie, dus een 'top' boven ~20 levert niet meer op. type=news = alleen nieuws; type=all = nieuws + documenten + persberichten.`;

    return result;
  }

  async schoolholidays(args: { year?: number; region?: string }) {
    const schoolYear = args.year
      ? `${args.year}-${args.year + 1}`
      : undefined;

    const endpoint = schoolYear
      ? `${this.config.endpoints.rijksoverheid}/infotypes/schoolholidays/schoolyear/${schoolYear}`
      : `${this.config.endpoints.rijksoverheid}/infotypes/schoolholidays`;

    const params = { output: "json" };
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, {
      query: params,
    });

    // The no-year endpoint returns a JSON ARRAY of yearly documents; the
    // single-year endpoint returns ONE such document. Normalize to a list.
    const documents: Array<Record<string, unknown>> = Array.isArray(data)
      ? (data as unknown as Array<Record<string, unknown>>)
      : [data];

    const items: Array<Record<string, unknown>> = [];
    for (const doc of documents) {
      const content = Array.isArray(doc.content)
        ? (doc.content as Array<Record<string, unknown>>)
        : [];

      for (const block of content) {
        const title = String(block.title ?? "Schoolvakanties");
        const schoolyear = String(block.schoolyear ?? schoolYear ?? "").trim();
        const vacations = Array.isArray(block.vacations)
          ? (block.vacations as Array<Record<string, unknown>>)
          : [];

        for (const vacation of vacations) {
          const vacationType = String(vacation.type ?? "").trim();
          const compulsory = String(vacation.compulsorydates ?? "").trim();
          const regions = Array.isArray(vacation.regions)
            ? (vacation.regions as Array<Record<string, unknown>>)
            : [];

          for (const r of regions) {
            items.push({
              title,
              schoolyear,
              vacation_type: vacationType,
              compulsory,
              region: String(r.region ?? "").trim(),
              startdate: r.startdate,
              enddate: r.enddate,
              canonical: doc.canonical,
            });
          }
        }
      }
    }

    let filtered = items;
    if (args.region?.trim()) {
      const region = args.region.trim().toLowerCase();
      filtered = filtered.filter((item) =>
        String(item.region ?? "").toLowerCase().includes(region),
      );
    }

    return {
      items: filtered,
      endpoint: meta.url,
      params: {
        ...params,
        ...(schoolYear ? { schoolyear: schoolYear } : {}),
        ...(args.region ? { region: args.region } : {}),
      },
    };
  }
}
