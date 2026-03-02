import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function matchesQuery(item: Record<string, unknown>, query: string): boolean {
  if (!query.trim()) return true;
  const qTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const haystack = [
    normalizeText(item.title),
    normalizeText(item.introduction),
    normalizeText(item.content),
    normalizeText(item.canonical),
    normalizeText(item.type),
    normalizeText(item.organisationalunit),
    normalizeText(item.subject),
  ].join(" \n ");

  return qTerms.every((term) => haystack.includes(term));
}

function asArray(data: unknown): Array<Record<string, unknown>> {
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

export class RijksoverheidSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: {
    query: string;
    top: number;
    ministry?: string;
    topic?: string;
    date_from?: string;
    date_to?: string;
  }) {
    const endpoint = `${this.config.endpoints.rijksoverheid}/documents`;
    const fetchRows = Math.min(200, Math.max(args.top * 20, 50));

    const params: Record<string, string> = {
      rows: String(fetchRows),
      output: "json",
    };
    if (args.ministry?.trim()) {
      params.organisationalunit = args.ministry.trim();
    }
    if (args.topic?.trim()) {
      params.subject = args.topic.trim();
    }
    if (args.date_from?.trim()) {
      params.lastmodifiedsince = args.date_from.trim().replace(/-/g, "");
    }

    const { data, meta } = await getJson<unknown>(endpoint, { query: params });
    let items = asArray(data);

    if (args.date_to?.trim()) {
      const until = new Date(`${args.date_to.trim()}T23:59:59Z`).getTime();
      items = items.filter((item) => {
        const raw = String(item.lastmodified ?? item.frontenddate ?? "");
        const ts = Date.parse(raw);
        return Number.isNaN(ts) ? true : ts <= until;
      });
    }

    const filtered = items.filter((item) => matchesQuery(item, args.query));
    const sliced = filtered.slice(0, args.top);

    return {
      items: sliced,
      total: filtered.length,
      endpoint: meta.url,
      params,
    };
  }

  async document(id: string) {
    const endpoint = `${this.config.endpoints.rijksoverheid}/documents/${id}`;
    const params = { output: "json" };
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, {
      query: params,
    });

    return {
      item: data,
      endpoint: meta.url,
      params,
    };
  }

  async topics() {
    const endpoint = `${this.config.endpoints.rijksoverheid}/infotypes/subject`;
    const params = { rows: "200", output: "json" };
    const { data, meta } = await getJson<unknown>(endpoint, { query: params });
    const items = asArray(data);
    return { items, endpoint: meta.url, params };
  }

  async ministries() {
    const endpoint = `${this.config.endpoints.rijksoverheid}/infotypes/ministry`;
    const params = { rows: "100", output: "json" };
    const { data, meta } = await getJson<unknown>(endpoint, { query: params });
    const items = asArray(data);
    return { items, endpoint: meta.url, params };
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

    const content = Array.isArray(data.content)
      ? (data.content as Array<Record<string, unknown>>)
      : [];

    const items: Array<Record<string, unknown>> = [];
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
            canonical: data.canonical,
          });
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
