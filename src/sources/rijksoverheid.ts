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

/**
 * The RSS platform returns at most this many items per query, ranked by relevance
 * (verified live: no page/size/sort parameter changes that). A full feed therefore
 * means "there may be more"; a shorter one is the complete match set.
 */
const RSS_MAX_ITEMS = 20;

const AMSTERDAM = "Europe/Amsterdam";

/** Calendar date (YYYY-MM-DD) of an instant as seen in Amsterdam. */
function amsterdamDate(ts: number): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: AMSTERDAM,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
}

/** Validate a YYYY-MM-DD string as a real calendar date. */
function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * UTC instant of 00:00 Amsterdam time on a calendar date. Rijksoverheid stamps
 * documents at local midnight (e.g. 2023-03-05T23:00Z for 6 March), so day
 * boundaries must be Amsterdam days, not UTC days.
 */
function amsterdamMidnightUtc(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  // Amsterdam's offset at UTC midnight equals its offset at local midnight: DST
  // switches happen at 01:00 UTC, after both instants.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: AMSTERDAM,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMidnight));
  const offsetHours = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return utcMidnight - offsetHours * 3_600_000;
}

/** Next calendar date after a YYYY-MM-DD date. */
function nextDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Read a date_from/date_to value as a calendar day. Besides YYYY-MM-DD (optionally
 * followed by a time, which is dropped) a year or a month is accepted: as a lower
 * bound it means its first day, as an upper bound its last day, so date_from=2026-07
 * with date_to=2026-07 covers all of July. Anything else is undefined (rejected).
 */
function boundDay(value: string, edge: "start" | "end"): string | undefined {
  const year = /^(\d{4})$/.exec(value);
  if (year) return edge === "start" ? `${year[1]}-01-01` : `${year[1]}-12-31`;
  const month = /^(\d{4})-(\d{2})$/.exec(value);
  if (month) {
    const y = Number(month[1]);
    const m = Number(month[2]);
    if (m < 1 || m > 12) return undefined;
    if (edge === "start") return `${month[1]}-${month[2]}-01`;
    // Day 0 of the next month is the last day of this one.
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  const day = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/.exec(value);
  if (day && isCalendarDate(day[1])) return day[1];
  return undefined;
}

/**
 * Date in the path of a document URL (/documenten/2024/10/16/…, also
 * /documenten/videos/… and /documenten/kamerstukken/…). It is the day the page was
 * created in Rijksoverheid's CMS, not its publication date: verified live, a page
 * can go online weeks after its path date, and the date the site shows is the RSS
 * pubDate. Its use is the revised document: a brochure under /documenten/2024/10/16/
 * shows 04-09-2025, the date of its current version, while the path still dates the
 * first one. News paths are left out (their path date is when the item was drafted,
 * often days before an embargoed release) and so are agenda paths (the week the
 * agenda covers).
 */
function urlPathDate(url: string): string | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const m = /\/documenten\/(?:[a-z-]+\/)?(\d{4})\/(\d{2})\/(\d{2})\//.exec(path);
  if (!m) return undefined;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  return isCalendarDate(date) ? date : undefined;
}

/**
 * Kind of page, from the URL path: the RSS items carry no document type and no
 * ministry, so the path is the only per-item signal available.
 */
function urlPathType(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return "webpage";
  }
  if (/\/nieuws\//.test(path)) return "news";
  if (/^\/documenten\/videos\//.test(path)) return "video";
  if (/\/documenten\//.test(path)) return "document";
  if (/^\/actueel\/agenda\//.test(path)) return "agenda";
  if (/^\/actueel\/weblogs\//.test(path)) return "weblog";
  if (/\/vraag-en-antwoord\//.test(path)) return "question_and_answer";
  if (/^\/(?:themas|onderwerpen)\//.test(path)) return "topic";
  return "webpage";
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

  /**
   * Build the RSS request. Date limits go into the query as a server-side range
   * filter on `sort_date`, the field the site's own period filter uses (verified
   * live; date-only strings make the platform answer HTTP 500, so full instants are
   * sent). Filtering server-side matters because the feed is capped at 20 items:
   * filtering those 20 afterwards dropped nearly every match in the period.
   */
  private planSearch(args: { query: string; type?: "news" | "all"; date_from?: string; date_to?: string }) {
    const type = args.type ?? "news";
    const filters: Array<Record<string, unknown>> =
      type === "all"
        ? []
        : [{ field: "content_type", values: ["pro:newsDocument"], type: "all" }];

    const invalid: string[] = [];
    const widened: string[] = [];
    const parseDay = (name: string, raw: string | undefined, edge: "start" | "end"): string | undefined => {
      const value = raw?.trim();
      if (!value) return undefined;
      const day = boundDay(value, edge);
      if (!day) {
        invalid.push(`${name} '${value}'`);
        return undefined;
      }
      // A year or month is widened to a day; a timestamp just loses its time.
      if (value.length < 10) widened.push(`${name} '${value}' als ${day}`);
      return day;
    };
    const fromDay = parseDay("date_from", args.date_from, "start");
    const toDay = parseDay("date_to", args.date_to, "end");

    if (fromDay || toDay) {
      const range: Record<string, string> = { name: "specificPeriod" };
      if (fromDay) range.from = new Date(amsterdamMidnightUtc(fromDay)).toISOString();
      if (toDay) range.to = new Date(amsterdamMidnightUtc(nextDate(toDay)) - 1).toISOString();
      filters.push({ field: "sort_date", values: [range], type: "all" });
    }

    const queryObj = {
      filters,
      resultSearchTerm: args.query,
      pageTitle: type === "all" ? "Zoeken" : "Nieuws",
    };
    const url = `${RIJKSOVERHEID_RSS_BASE}?query=${encodeURIComponent(JSON.stringify(queryObj))}`;
    return { url, type, fromDay, toDay, invalid, widened };
  }

  /** The exact URL search() would request, for dry runs. */
  requestUrl(args: { query: string; type?: "news" | "all"; date_from?: string; date_to?: string }): string {
    return this.planSearch(args).url;
  }

  async search(args: {
    query: string;
    top: number;
    type?: "news" | "all";
    date_from?: string;
    date_to?: string;
  }) {
    const { url, type, fromDay, toDay, invalid, widened } = this.planSearch(args);

    const { data, meta } = await getText(url, { connector: "rijksoverheid" });
    const parsed = parseXml(data) as Record<string, unknown> | undefined;
    const rss = (parsed?.rss ?? {}) as Record<string, unknown>;
    const channel = (rss.channel ?? {}) as Record<string, unknown>;
    const rawItems = asArray(channel.item);

    let items = rawItems.map((item) => {
      const link = nodeText(item.link);
      const guid = nodeText(item.guid);
      const pubDate = nodeText(item.pubDate);
      const pubTs = pubDate ? Date.parse(pubDate) : Number.NaN;
      const pathDate = urlPathDate(link);
      const out: Record<string, unknown> = {
        id: guid || link,
        title: nodeText(item.title),
        url: link,
        snippet: nodeText(item.description),
        // The date the site itself shows for the item (verified live: equal to the
        // pubDate, and for news to the page's datePublished), as an Amsterdam calendar
        // day because documents are stamped at local midnight. The date filter works
        // on the same value. Only without a pubDate does the URL path stand in.
        date: pubDate ? (Number.isNaN(pubTs) ? pubDate : amsterdamDate(pubTs)) : (pathDate ?? ""),
        date_source: pubDate ? "issued" : pathDate ? "url_path" : "",
        issued: pubDate ? toIsoDate(pubDate) : "",
        type: urlPathType(link),
      };
      // Documents only: the day the page was created, which for a revised document
      // dates its first version (see urlPathDate).
      if (pathDate) out.url_date = pathDate;
      return out;
    });

    // Safety net behind the server-side filter, on the item's own date (the Amsterdam
    // day of issued, the field the server filters on): whatever the platform does, no
    // item whose shown date lies outside the requested period is returned. An item
    // without a readable date is kept, as the server let it through.
    if (fromDay || toDay) {
      items = items.filter((item) => {
        const day = String(item.date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return true;
        return (!fromDay || day >= fromDay) && (!toDay || day <= toDay);
      });
    }

    // A full feed is a truncated one: the real number of matches is unknown, so it
    // is not reported as a total.
    const capped = rawItems.length >= RSS_MAX_ITEMS;
    const total = capped ? null : items.length;
    const sliced = items.slice(0, args.top);

    // The provenance shows the period actually applied: a widened year or month as
    // its day bound, and an ignored (invalid) value not at all.
    const params: Record<string, string> = {
      query: args.query,
      type,
      top: String(args.top),
    };
    if (fromDay) params.date_from = fromDay;
    if (toDay) params.date_to = toDay;

    const notes: string[] = [];
    // Date warnings first: an ignored filter changes what the results mean.
    if (invalid.length) {
      notes.push(
        `Let op: ${invalid.join(" en ")} is geen geldige datum (JJJJ-MM-DD, JJJJ-MM of JJJJ) en is genegeerd; de resultaten zijn daar niet op gefilterd.`,
      );
    }
    if (widened.length) notes.push(`Gelezen: ${widened.join(", ")}.`);
    if (items.length === 0) {
      notes.push(
        `Geen resultaten via het Rijksoverheid RSS-zoekplatform voor "${args.query}" (type=${type}${fromDay ? `, vanaf ${fromDay}` : ""}${toDay ? `, t/m ${toDay}` : ""}). Probeer bredere trefwoorden${type === "news" ? " of type=all (nieuws + documenten + overige pagina's)" : ""}.`,
      );
      if (fromDay && toDay && fromDay > toDay) notes.push("date_from ligt na date_to.");
    } else {
      notes.push(
        "Server-side zoeken (resultSearchTerm) via het Rijksoverheid RSS-platform: max 20 resultaten per zoekopdracht, gerangschikt op relevantie, zonder paginering; een 'top' of offset voorbij 20 levert niets extra op. type=news = alleen nieuws; type=all = nieuws + documenten + overige pagina's.",
      );
      notes.push(
        capped
          ? "De feed zat vol (20 items): het werkelijke aantal treffers is onbekend en waarschijnlijk hoger, daarom is total leeg. Verfijn met specifiekere trefwoorden of date_from/date_to."
          : `Dit zijn alle ${items.length} treffers.`,
      );
      notes.push(
        "date is de datum die Rijksoverheid.nl zelf bij het item toont (issued, als Amsterdamse kalenderdag): bij nieuws de publicatiedatum, bij documenten de documentdatum, bij een herzien document die van de laatste versie. Documenten hebben daarnaast url_date, de datum uit het URL-pad (/documenten/JJJJ/MM/DD/): de dag dat de pagina werd aangemaakt, bij een herzien document die van de eerste versie; het is niet de dag dat het document online kwam. data.type komt uit het URL-pad (news, document, video, agenda, weblog, question_and_answer, topic, webpage): de feed levert geen fijner documenttype en geen ministerie.",
      );
    }
    if (fromDay || toDay) {
      notes.push(
        "date_from/date_to filteren server-side op date (Amsterdamse kalenderdagen, grenzen inbegrepen), vóór de limiet van 20; url_date kan buiten de periode liggen.",
      );
    }

    return {
      items: sliced as Array<Record<string, unknown>>,
      total,
      // Items the feed actually returned (after the date check), before slicing to
      // `top`: with total unknown this is what tells a caller whether a later page has data.
      available: items.length,
      endpoint: meta.url,
      params,
      access_note: notes.join(" "),
    };
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
