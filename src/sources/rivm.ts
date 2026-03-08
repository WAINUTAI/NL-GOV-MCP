import type { AppConfig } from "../types.js";
import { getJson, getText } from "../utils/http.js";
import { XMLParser } from "fast-xml-parser";

interface RIVMItem {
  id: string;
  title: string;
  description?: string;
  type?: string;
  url: string;
  source: string;
  updated_at?: string;
  [key: string]: unknown;
}

// RIVM publishes data via GeoNetwork CSW, not CKAN.
const RIVM_CSW_ENDPOINT = "https://data.rivm.nl/geonetwork/srv/eng/csw";
const RIVM_DATA_BROWSE = "https://data.rivm.nl/data/";

function scoreRivmItem(title: string, description: string, query: string): number {
  const q = query.toLowerCase();
  const hay = `${title.toLowerCase()} ${description.toLowerCase()}`;
  let score = 0;
  for (const token of q.split(/\s+/).filter(Boolean)) if (hay.includes(token)) score += 2;
  if (title.toLowerCase().includes(q)) score += 4;
  return score;
}

export class RivmSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: { query: string; rows: number }) {
    const rows = Math.min(args.rows, this.config.limits.maxRows);

    // Try CSW (GeoNetwork) first — this is RIVM's real metadata API.
    try {
      const items = await this.searchCsw(args.query, rows);
      if (items.length) {
        return {
          items,
          total: items.length,
          endpoint: RIVM_CSW_ENDPOINT,
          params: { q: args.query, rows: String(rows) },
        };
      }
    } catch {
      // fall through to directory browse
    }

    // Fallback: scrape the data directory listing for matching paths.
    try {
      const items = await this.browseDataDirectory(args.query, rows);
      if (items.length) {
        return {
          items,
          total: items.length,
          endpoint: RIVM_DATA_BROWSE,
          params: { q: args.query, rows: String(rows) },
        };
      }
    } catch {
      // fall through to fallback
    }

    return this.fallback({ query: args.query, rows });
  }

  private async searchCsw(query: string, rows: number): Promise<RIVMItem[]> {
    const params: Record<string, string> = {
      service: "CSW",
      version: "2.0.2",
      request: "GetRecords",
      resultType: "results",
      typeNames: "gmd:MD_Metadata",
      elementSetName: "summary",
      maxRecords: String(rows),
      startPosition: "1",
      outputSchema: "http://www.isotc211.org/2005/gmd",
      constraintLanguage: "CQL_TEXT",
      constraint_language_version: "1.1.0",
      constraint: `AnyText like '%${query.replace(/'/g, "''")}%'`,
    };

    const { data } = await getText(RIVM_CSW_ENDPOINT, {
      query: params,
      timeoutMs: 15_000,
      retries: 1,
    });

    const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
    const parsed = parser.parse(data);

    const searchResults = parsed?.GetRecordsResponse?.SearchResults;
    if (!searchResults) return [];

    const rawRecords = Array.isArray(searchResults.MD_Metadata)
      ? searchResults.MD_Metadata
      : searchResults.MD_Metadata ? [searchResults.MD_Metadata] : [];

    const items: RIVMItem[] = rawRecords.map((rec: Record<string, unknown>) => {
      const ident = rec.fileIdentifier as Record<string, unknown> | undefined;
      const id = String((ident?.CharacterString ?? ident) || "rivm-csw-item");
      const ci = (rec.identificationInfo as Record<string, unknown>)?.MD_DataIdentification as Record<string, unknown> | undefined;
      const citation = ci?.citation as Record<string, unknown> | undefined;
      const ciCitation = citation?.CI_Citation as Record<string, unknown> | undefined;
      const titleObj = ciCitation?.title as Record<string, unknown> | undefined;
      const title = String(titleObj?.CharacterString ?? id);
      const abstractObj = ci?.abstract as Record<string, unknown> | undefined;
      const description = String(abstractObj?.CharacterString ?? "");

      return {
        id,
        title,
        description,
        type: "dataset",
        url: `https://data.rivm.nl/geonetwork/srv/dut/catalog.search#/metadata/${id}`,
        source: "rivm-csw",
      };
    });

    // Score and sort by relevance
    return [...items]
      .sort((a, b) => scoreRivmItem(b.title, b.description ?? "", query) - scoreRivmItem(a.title, a.description ?? "", query))
      .slice(0, rows);
  }

  private async browseDataDirectory(query: string, rows: number): Promise<RIVMItem[]> {
    const { data } = await getText(RIVM_DATA_BROWSE, { timeoutMs: 10_000, retries: 1 });
    // Directory listing has hrefs to topic folders
    const links = Array.from(data.matchAll(/href="([^"]+)"/g)).map((m) => m[1]);
    const q = query.toLowerCase();
    const matched = links
      .filter((l) => !l.startsWith("?") && !l.startsWith("/") && l !== "../")
      .filter((l) => l.toLowerCase().includes(q) || q.split(/\s+/).some((t) => l.toLowerCase().includes(t)));

    return matched.slice(0, rows).map((l) => ({
      id: `rivm-dir-${l.replace(/\//g, "").toLowerCase()}`,
      title: l.replace(/\/$/, "").replace(/[-_]/g, " "),
      description: `RIVM data directory: ${l}`,
      type: "directory",
      url: `${RIVM_DATA_BROWSE}${l}`,
      source: "rivm-data-browse",
    }));
  }

  fallback(args: { query: string; rows: number }) {
    const qSlug = args.query.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const items: RIVMItem[] = [
      {
        id: `rivm-fallback-${qSlug}`,
        title: `RIVM fallback discovery voor '${args.query}'`,
        description: "Live RIVM discovery endpoint gaf geen bruikbare response; deterministische fallbackrecord.",
        type: "fallback",
        url: "https://data.rivm.nl",
        source: "fallback",
        updated_at: "1970-01-01T00:00:00Z",
      },
    ];

    return {
      items: items.slice(0, args.rows),
      total: items.length,
      endpoint: `${RIVM_CSW_ENDPOINT} (fallback)`,
      params: { q: args.query, rows: String(args.rows) },
      access_note: "RIVM endpoints waren onbereikbaar/instabiel; fallbackrecord gebruikt.",
    };
  }
}
