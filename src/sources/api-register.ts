import type { AppConfig } from "../types.js";
import { getJson, getText } from "../utils/http.js";

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAllTerms(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const terms = q.split(/\s+/).filter(Boolean);
  const hay = text.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

function parseCards(pageHtml: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const cardRegex = /<li[^>]*>[\s\S]*?<div class="rhc-card-as-link[\s\S]*?<\/li>/gi;
  const cards = pageHtml.match(cardRegex) ?? [];

  for (const card of cards) {
    const titleMatch = card.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const linkCandidates = Array.from(
      card.matchAll(
        /href="(https:\/\/apis\.developer\.overheid\.nl\/apis\/[A-Za-z0-9_\-]+)"/gi,
      ),
    )
      .map((m) => m[1])
      .filter((u) => !u.includes("/apis/toevoegen") && !u.endsWith("/apis"));
    const link = linkCandidates.length
      ? linkCandidates[linkCandidates.length - 1]
      : "";
    const orgMatch = card.match(
      /class="_badgeLink[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
    );
    const descMatch = card.match(
      /<div class="description[^"]*">([\s\S]*?)<\/div>/i,
    );
    const versionMatch = card.match(
      /<div class="version"[^>]*>\s*Versie\s*([\s\S]*?)<\/div>/i,
    );

    const title = titleMatch ? stripTags(titleMatch[1]) : "";
    const url = link;
    const organization = orgMatch ? stripTags(orgMatch[1]) : "";
    const description = descMatch ? stripTags(descMatch[1]) : "";
    const version = versionMatch ? stripTags(versionMatch[1]) : "";

    if (!title || !url) continue;

    out.push({
      id: url.split("/").pop(),
      name: title,
      organization,
      description,
      version,
      url,
      documentation_url: url,
      api_type: "unknown",
      source: "developer.overheid.nl-html",
      __raw_text: stripTags(card),
    });
  }

  return out;
}

export class ApiRegisterSource {
  constructor(private readonly config: AppConfig, private readonly apiKey: string) {}

  private async tryOfficialApi(query: string, top: number) {
    const endpoints = [
      `${this.config.endpoints.apiRegister}/api/v1/apis`,
      `${this.config.endpoints.apiRegister}/v1/apis`,
      `${this.config.endpoints.apiRegister}/api/apis`,
    ];

    for (const endpoint of endpoints) {
      try {
        const params = { q: query, limit: String(top) };
        const { data, meta } = await getJson<Record<string, unknown>>(endpoint, {
          query: params,
          headers: {
            "X-API-Key": this.apiKey,
            Authorization: this.apiKey,
          },
        });

        const items =
          (data.items as Array<Record<string, unknown>> | undefined) ??
          (data.apis as Array<Record<string, unknown>> | undefined) ??
          [];

        if (items.length) {
          return { items, endpoint: meta.url, params };
        }
      } catch {
        // try next endpoint
      }
    }

    return undefined;
  }

  private async fallbackScrape(query: string, top: number) {
    const base = `${this.config.endpoints.apiRegister}/apis`;
    const seen = new Set<string>();
    const matches: Array<Record<string, unknown>> = [];

    for (let page = 1; page <= 5; page += 1) {
      const pageUrl = page === 1 ? base : `${base}/pagina/${page}`;
      const { data } = await getText(pageUrl, {
        headers: {
          "X-API-Key": this.apiKey,
          Authorization: this.apiKey,
        },
      });

      const cards = parseCards(data);
      if (!cards.length) break;

      for (const card of cards) {
        const url = String(card.url ?? "");
        if (!url || seen.has(url)) continue;
        seen.add(url);

        const text = `${String(card.name ?? "")} ${String(card.organization ?? "")} ${String(card.description ?? "")} ${String(card.__raw_text ?? "")}`;
        if (hasAllTerms(text, query)) {
          const { __raw_text, ...clean } = card;
          matches.push(clean);
        }
      }

      if (matches.length >= top) break;
    }

    return {
      items: matches.slice(0, top),
      endpoint: `${base} (html-fallback)` ,
      params: { q: query, limit: String(top) },
    };
  }

  async search(query: string, top: number) {
    const apiResult = await this.tryOfficialApi(query, top);
    if (apiResult) return apiResult;

    return this.fallbackScrape(query, top);
  }
}
