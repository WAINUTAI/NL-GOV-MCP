import type { AppConfig } from "../types.js";
import { getJson, getText } from "../utils/http.js";

function uniqBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * DUO onderwijsdata.
 *
 * `duo_schools` and `duo_exam_results` used to search the CKAN *dataset
 * catalogue*, so "welke basisschool in Tilburg" returned national dataset
 * descriptions instead of schools. Every CKAN resource here is datastore-backed
 * (`datastore_active: true`), which means the rows themselves are queryable with
 * server-side filters — so both tools now return real per-school records.
 */

export type OnderwijsSector = "po" | "vo" | "mbo" | "ho";

interface SectorResource {
  /** CKAN package the resource lives in. */
  packageId: string;
  /** Matched against the resource name to survive resource re-uploads. */
  resourceNamePattern: RegExp;
  /** Known resource id, used directly and as the fallback if lookup fails. */
  resourceId: string;
  label: string;
  /** Field holding the school/institution name for this sector. */
  nameField: string;
  /** Sector-specific extra field worth surfacing (school type / structure). */
  typeField?: string;
}

const SECTOR_RESOURCES: Record<OnderwijsSector, SectorResource> = {
  po: {
    packageId: "adressen_bo",
    resourceNamePattern: /alle vestigingen/i,
    resourceId: "dcc9c9a5-6d01-410b-967f-810557588ba4",
    label: "Vestigingen basisonderwijs",
    nameField: "VESTIGINGSNAAM",
  },
  vo: {
    packageId: "adressen_vo",
    resourceNamePattern: /vestigingen/i,
    resourceId: "5187f8d5-ff9c-4284-8e06-4311f0354956",
    label: "Vestigingen voortgezet onderwijs",
    nameField: "VESTIGINGSNAAM",
    typeField: "ONDERWIJSSTRUCTUUR",
  },
  mbo: {
    packageId: "adressen_mbo",
    resourceNamePattern: /instellingen/i,
    resourceId: "1a946297-a7ca-48d5-9ae8-19ad73bf8176",
    label: "Instellingen mbo",
    nameField: "INSTELLINGSNAAM",
    typeField: "MBO INSTELLINGSSOORT - NAAM",
  },
  ho: {
    packageId: "adressen_ho",
    resourceNamePattern: /instellingen/i,
    resourceId: "bf1da9c6-c688-4873-91b1-b12c9ac2c132",
    label: "Instellingen hoger onderwijs",
    nameField: "INSTELLINGSNAAM",
    typeField: "SOORT HO",
  },
};

/**
 * School years covered by the per-location exam dataset. DUO publishes newer
 * exam figures only as loose CSV downloads without a stable, discoverable URL,
 * so a request for 2024 is answered with an explanation rather than a schema
 * rejection — an assistant asking for "last year" should get a usable reply.
 */
const EXAM_YEAR_RANGE = { from: 2013, to: 2017 } as const;

/** Slagingspercentages en gemiddelde examencijfers per vestiging (VO). */
const EXAM_RESOURCE: SectorResource = {
  packageId: "03_voex-v1",
  resourceNamePattern: /slagingspercentage/i,
  resourceId: "0423457d-c69e-4950-a12c-51912fc48faf",
  label: "Slagingspercentages en gemiddelde examencijfers per vestiging",
  nameField: "INSTELLINGSNAAM VESTIGING",
};

export interface DuoSchoolItem {
  naam: string;
  instellingscode: string;
  vestigingscode: string;
  bevoegdGezag: string;
  onderwijstype: string;
  straat: string;
  postcode: string;
  plaats: string;
  gemeente: string;
  gemeentecode: string;
  provincie: string;
  denominatie: string;
  telefoon: string;
  website: string;
  url: string;
}

export interface DuoExamResultItem {
  school: string;
  brin: string;
  brinVestiging: string;
  gemeente: string;
  provincie: string;
  onderwijstype: string;
  schooljaar: number | null;
  examenkandidaten: number | null;
  geslaagden: number | null;
  gezakten: number | null;
  slagingspercentage: number | null;
  gemiddeldSchoolexamen: number | null;
  gemiddeldCentraalExamen: number | null;
  gemiddeldCijferlijst: number | null;
  url: string;
}

interface CkanResource {
  id?: unknown;
  name?: unknown;
  datastore_active?: unknown;
}

interface CkanPackageShow {
  result?: { resources?: CkanResource[] };
}

interface DatastoreSearchResponse {
  success?: boolean;
  result?: {
    total?: unknown;
    records?: Array<Record<string, unknown>>;
    fields?: Array<{ id?: unknown; type?: unknown }>;
  };
}

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = str(value).replace(",", ".");
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** DUO stores place/municipality names uppercase; filters are exact matches. */
function upper(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}

function normalizePostcode(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").replace(/\s+/g, "").toUpperCase();
  return trimmed || undefined;
}

function schoolUrl(website: string, naam: string): string {
  const site = website.trim();
  if (site) return /^https?:\/\//i.test(site) ? site : `https://${site}`;
  return `https://onderwijsdata.duo.nl/dataset?q=${encodeURIComponent(naam)}`;
}

export class DuoSource {
  constructor(private readonly config: AppConfig) {}

  private get ckanBase(): string {
    return `${this.config.endpoints.duoDatasets}/api/3/action`;
  }

  async datasetsCatalog(query: string, rows: number) {
    const endpoint = `${this.ckanBase}/package_search`;
    const params = { q: query, rows: String(rows) };
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, { query: params });
    const result = (data.result as Record<string, unknown> | undefined) ?? {};
    const items = (result.results as Array<Record<string, unknown>> | undefined) ?? [];
    const total = (result.count as number | undefined) ?? items.length;
    return { items, total, endpoint: meta.url, params };
  }

  /**
   * Look up the current resource id for a dataset. DUO re-uploads resources, which
   * mints a new id; resolving by name keeps the connector working across those
   * refreshes and falls back to the last known id if the lookup fails.
   */
  private async resolveResourceId(resource: SectorResource): Promise<string> {
    try {
      const { data } = await getJson<CkanPackageShow>(`${this.ckanBase}/package_show`, {
        query: { id: resource.packageId },
        connector: "duo",
      });
      const resources = data.result?.resources ?? [];
      const match = resources.find(
        (r) => resource.resourceNamePattern.test(str(r.name)) && r.datastore_active === true,
      );
      const id = str(match?.id);
      return id || resource.resourceId;
    } catch {
      return resource.resourceId;
    }
  }

  private async datastoreSearch(args: {
    resourceId: string;
    filters?: Record<string, string | number>;
    q?: string;
    sort?: string;
    limit: number;
    offset?: number;
  }): Promise<{
    records: Array<Record<string, unknown>>;
    total: number;
    endpoint: string;
    params: Record<string, string>;
  }> {
    const params: Record<string, string> = {
      resource_id: args.resourceId,
      limit: String(args.limit),
    };
    if (args.filters && Object.keys(args.filters).length) {
      params.filters = JSON.stringify(args.filters);
    }
    if (args.q?.trim()) params.q = args.q.trim();
    if (args.sort?.trim()) params.sort = args.sort.trim();
    if (args.offset) params.offset = String(args.offset);

    const { data, meta } = await getJson<DatastoreSearchResponse>(
      `${this.ckanBase}/datastore_search`,
      { query: params, connector: "duo", timeoutMs: 20_000 },
    );

    const records = data.result?.records ?? [];
    const total = num(data.result?.total) ?? records.length;
    return { records, total, endpoint: meta.url, params };
  }

  async getSchools(args: {
    name?: string;
    municipality?: string;
    place?: string;
    postcode?: string;
    sector?: OnderwijsSector;
    top: number;
    offset?: number;
  }): Promise<{
    items: DuoSchoolItem[];
    total: number;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const sector = args.sector ?? "po";
    const resource = SECTOR_RESOURCES[sector];
    const resourceId = await this.resolveResourceId(resource);

    const filters: Record<string, string | number> = {};
    const gemeente = upper(args.municipality);
    const plaats = upper(args.place);
    const postcode = normalizePostcode(args.postcode);
    if (gemeente) filters.GEMEENTENAAM = gemeente;
    if (plaats) filters.PLAATSNAAM = plaats;
    if (postcode) filters.POSTCODE = postcode;

    const out = await this.datastoreSearch({
      resourceId,
      filters,
      q: args.name,
      sort: `${resource.nameField} asc`,
      limit: args.top,
      offset: args.offset,
    });

    const items: DuoSchoolItem[] = out.records.map((row) => {
      const naam = str(row[resource.nameField]) || str(row.INSTELLINGSNAAM);
      const website = str(row.INTERNETADRES);
      const huisnummer = str(row["HUISNUMMER-TOEVOEGING"]);
      return {
        naam,
        instellingscode: str(row.INSTELLINGSCODE),
        vestigingscode: str(row.VESTIGINGSCODE),
        bevoegdGezag: str(row["BEVOEGD GEZAG NUMMER"]),
        onderwijstype: resource.typeField ? str(row[resource.typeField]) : "",
        straat: [str(row.STRAATNAAM), huisnummer].filter(Boolean).join(" "),
        postcode: str(row.POSTCODE),
        plaats: str(row.PLAATSNAAM),
        gemeente: str(row.GEMEENTENAAM),
        gemeentecode: str(row.GEMEENTENUMMER),
        provincie: str(row.PROVINCIE),
        denominatie: str(row.DENOMINATIE),
        telefoon: str(row.TELEFOONNUMMER),
        website,
        url: schoolUrl(website, naam),
      };
    });

    const notes: string[] = [
      `Bron: DUO ${resource.label} (CKAN datastore, dataset '${resource.packageId}'). Per-vestiging records, geen catalogustreffers.`,
    ];
    if (!items.length) {
      notes.push(
        "Geen scholen gevonden. Gemeente/plaats/postcode filteren exact (hoofdletterongevoelig ingevoerd, DUO slaat ze in hoofdletters op); een schoolnaam werkt als vrije zoekterm.",
      );
    }
    if (sector === "po" && args.name && !items.length) {
      notes.push("Tip: probeer sector='vo' voor middelbare scholen.");
    }

    return {
      items,
      total: out.total,
      endpoint: out.endpoint,
      params: { ...out.params, sector },
      access_note: notes.join(" "),
    };
  }

  async getExamResults(args: {
    year?: number;
    school?: string;
    municipality?: string;
    onderwijstype?: string;
    sortByScore?: boolean;
    top: number;
    offset?: number;
  }): Promise<{
    items: DuoExamResultItem[];
    total: number;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const resourceId = await this.resolveResourceId(EXAM_RESOURCE);

    const filters: Record<string, string | number> = {};
    if (args.year) filters.SCHOOLJAAR = args.year;
    const gemeente = upper(args.municipality);
    if (gemeente) filters["GEMEENTENAAM VESTIGING"] = gemeente;
    const onderwijstype = upper(args.onderwijstype);
    if (onderwijstype) filters["ONDERWIJSTYPE VO"] = onderwijstype;

    const sort = args.sortByScore
      ? "SLAGINGSPERCENTAGE desc"
      : "SCHOOLJAAR desc, SLAGINGSPERCENTAGE desc";

    const out = await this.datastoreSearch({
      resourceId,
      filters,
      q: args.school,
      sort,
      limit: args.top,
      offset: args.offset,
    });

    const items: DuoExamResultItem[] = out.records.map((row) => {
      const school = str(row["INSTELLINGSNAAM VESTIGING"]);
      const brinVestiging = str(row.BRINVESTIGINGSNUMMER);
      return {
        school,
        brin: str(row["BRIN NUMMER"]),
        brinVestiging,
        gemeente: str(row["GEMEENTENAAM VESTIGING"]),
        provincie: str(row["PROVINCIE VESTIGING"]),
        onderwijstype: str(row["ONDERWIJSTYPE VO"]),
        schooljaar: num(row.SCHOOLJAAR),
        examenkandidaten: num(row.EXAMENKANDIDATEN),
        geslaagden: num(row.GESLAAGDEN),
        gezakten: num(row.GEZAKTEN),
        slagingspercentage: num(row.SLAGINGSPERCENTAGE),
        gemiddeldSchoolexamen: num(row["GEMIDDELD CIJFER SCHOOLEXAMEN"]),
        gemiddeldCentraalExamen: num(row["GEMIDDELD CIJFER CENTRAAL EXAMEN"]),
        gemiddeldCijferlijst: num(row["GEMIDDELD CIJFER CIJFERLIJST"]),
        url: `https://onderwijsdata.duo.nl/dataset/${EXAM_RESOURCE.packageId}`,
      };
    });

    const outOfRange =
      args.year !== undefined &&
      (args.year < EXAM_YEAR_RANGE.from || args.year > EXAM_YEAR_RANGE.to);

    const notes: string[] = [
      "Bron: DUO 'Slagingspercentages en gemiddelde examencijfers per vestiging' (CKAN datastore). Per-vestiging examenresultaten voortgezet onderwijs.",
      `Dekking: schooljaren ${EXAM_YEAR_RANGE.from} t/m ${EXAM_YEAR_RANGE.to} — dit is de laatste per-vestiging examendataset die DUO machine-leesbaar publiceert.`,
    ];
    if (outOfRange) {
      notes.push(
        `Schooljaar ${args.year} valt buiten de dekking en levert daarom 0 resultaten; kies een jaar tussen ${EXAM_YEAR_RANGE.from} en ${EXAM_YEAR_RANGE.to} of laat 'year' weg.`,
      );
    } else if (!items.length) {
      notes.push(
        "Geen resultaten. Gemeente en onderwijstype (VMBO/HAVO/VWO) filteren exact; een schoolnaam werkt als vrije zoekterm.",
      );
    }

    return {
      items,
      total: out.total,
      endpoint: out.endpoint,
      params: out.params,
      access_note: notes.join(" "),
    };
  }

  async rioSearch(query: string, top: number) {
    const endpoint = `${this.config.endpoints.duoRio}/search`;
    const params = { q: query, limit: String(top) };

    const { data, meta } = await getText(endpoint, { query: params });

    const trimmed = data.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const items = (parsed.results as Array<Record<string, unknown>> | undefined) ??
          (Array.isArray((parsed as { items?: unknown[] }).items)
            ? ((parsed as { items: unknown[] }).items as Array<Record<string, unknown>>)
            : []);
        return { items: items.slice(0, top), endpoint: meta.url, params };
      } catch {
        // continue to fallback below
      }
    }

    const fallbackItems: Array<Record<string, unknown>> = [
      {
        id: "rio-api-home",
        name: "RIO API home",
        description: "RIO API returned HTML shell from this host; use linked docs/endpoints",
        url: this.config.endpoints.duoRio,
        query,
      },
      {
        id: "rio-overview",
        name: "DUO open data overview",
        url: "https://duo.nl/open_onderwijsdata/overzicht-open-data.jsp",
        query,
      },
      {
        id: "duo-datasets",
        name: "DUO datasets portal",
        url: "https://onderwijsdata.duo.nl/datasets",
        query,
      },
    ].slice(0, top);

    return { items: fallbackItems, endpoint: meta.url, params };
  }
}

export { uniqBy };
