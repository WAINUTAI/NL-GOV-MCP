import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

// Register van Overheidsorganisaties (ROO/TOOI) — keyless JSON API.
// De lijst-endpoint levert een platte array van { label, type, uri } zonder
// server-side naam-filter of paginering, dus we halen de volledige lijst op en
// filteren client-side op naam. Optioneel verrijken we de teruggegeven treffers
// met contact + bezoekadres via de dedicated sub-endpoints.
const BASE = "https://api-organisaties.overheid.nl/v1";
const LIST_ENDPOINT = `${BASE}/overheidsorganisaties`;
const CONNECTOR = "overheidsorganisaties";

// Bovengrens voor verrijking: elke treffer kost 2 extra requests (contact +
// adressen). Boven deze grens slaan we verrijking over om de fair-use (100 req/s)
// te respecteren.
const ENRICH_CAP = 15;

export interface OverheidsorganisatieItem {
  id: string;
  title: string;
  url: string;
  organisatietype: string;
  type_uri: string;
  tooi_uri: string;
  website: string;
  telefoon: string;
  bezoekadres: string;
}

export interface OverheidsorganisatiesSearchArgs {
  query: string;
  rows: number;
  type?: string;
  enrich?: boolean;
}

interface ContactResponse {
  internetadressen?: unknown;
  telefoonnummers?: unknown;
}

function asOrgList(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === "object") {
    const items = (data as Record<string, unknown>).items;
    if (Array.isArray(items)) return items as Array<Record<string, unknown>>;
  }
  return [];
}

// Leidt een leesbaar organisatietype af uit de TOOI-ontologie-URI, bv.
// ".../tooi/def/ont/Gemeente" -> "Gemeente".
function shortType(typeUri: string): string {
  if (!typeUri) return "";
  const seg = typeUri.split("/").filter(Boolean).pop() ?? "";
  return seg;
}

function firstStringField(v: unknown, field: string): string {
  if (!Array.isArray(v)) return "";
  for (const entry of v) {
    if (entry && typeof entry === "object") {
      const val = (entry as Record<string, unknown>)[field];
      if (typeof val === "string" && val.trim()) return val;
    }
  }
  return "";
}

function formatBezoekadres(data: unknown): string {
  if (!Array.isArray(data)) return "";
  const entries = data.filter(
    (e): e is Record<string, unknown> => !!e && typeof e === "object",
  );
  const visit =
    entries.find((e) => String(e.adresType ?? "").toLowerCase() === "bezoekadres") ??
    entries[0];
  if (!visit) return "";
  const straat = `${String(visit.openbareRuimte ?? "")} ${String(
    visit.huisnummer ?? "",
  )}`.trim();
  const postbus = String(visit.postbus ?? "").trim();
  const line1 = straat || (postbus ? `Postbus ${postbus}` : "");
  const plaats = `${String(visit.postcode ?? "")} ${String(
    visit.woonplaats ?? "",
  )}`.trim();
  return [line1, plaats].filter(Boolean).join(", ");
}

function toBaseItem(o: Record<string, unknown>): OverheidsorganisatieItem {
  const uri = String(o.uri ?? "");
  const label = String(o.label ?? "");
  const typeUri = String(o.type ?? "");
  return {
    id: uri,
    title: label || uri || "Overheidsorganisatie",
    url: uri || LIST_ENDPOINT,
    organisatietype: shortType(typeUri),
    type_uri: typeUri,
    tooi_uri: uri,
    website: "",
    telefoon: "",
    bezoekadres: "",
  };
}

export class OverheidsorganisatiesSource {
  constructor(private readonly config: AppConfig) {}

  private async enrichItem(
    o: Record<string, unknown>,
  ): Promise<OverheidsorganisatieItem> {
    const base = toBaseItem(o);
    const uri = base.tooi_uri;
    if (!uri) return base;
    const enc = encodeURIComponent(uri);

    let website = "";
    let telefoon = "";
    let bezoekadres = "";

    try {
      const { data } = await getJson<ContactResponse>(
        `${BASE}/overheidsorganisaties/${enc}/contact`,
        { connector: CONNECTOR, timeoutMs: 15_000 },
      );
      website = firstStringField(data.internetadressen, "url");
      telefoon = firstStringField(data.telefoonnummers, "nummer");
    } catch {
      // Verrijking is best-effort; ontbrekend contact mag de zoekopdracht niet breken.
    }

    try {
      const { data } = await getJson<unknown>(
        `${BASE}/overheidsorganisaties/${enc}/adressen`,
        { connector: CONNECTOR, timeoutMs: 15_000 },
      );
      bezoekadres = formatBezoekadres(data);
    } catch {
      // idem: adressen best-effort.
    }

    return {
      id: base.id,
      title: base.title,
      url: website || base.url,
      organisatietype: base.organisatietype,
      type_uri: base.type_uri,
      tooi_uri: base.tooi_uri,
      website,
      telefoon,
      bezoekadres,
    };
  }

  async search(args: OverheidsorganisatiesSearchArgs): Promise<{
    items: OverheidsorganisatieItem[];
    total: number;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const query = args.query.trim();
    const listQuery: Record<string, string> = {};
    if (args.type) listQuery.type = args.type;

    const { data, meta } = await getJson<unknown>(LIST_ENDPOINT, {
      query: listQuery,
      connector: CONNECTOR,
      timeoutMs: 20_000,
    });

    const all = asOrgList(data);
    const q = query.toLowerCase();
    const matched = q
      ? all.filter((o) => String(o.label ?? "").toLowerCase().includes(q))
      : all;
    const total = matched.length;
    const sliced = matched.slice(0, args.rows);

    const wantsEnrich = args.enrich !== false;
    const enrich = wantsEnrich && sliced.length <= ENRICH_CAP;
    const items = enrich
      ? await Promise.all(sliced.map((o) => this.enrichItem(o)))
      : sliced.map((o) => toBaseItem(o));

    const params: Record<string, string> = {
      query,
      ...(args.type ? { type: args.type } : {}),
      enrich: String(enrich),
    };

    const notes: string[] = [];
    if (wantsEnrich && !enrich) {
      notes.push(
        `Verrijking (contact/adres) overgeslagen: meer dan ${ENRICH_CAP} treffers. Verfijn de zoekterm voor contact- en adresgegevens.`,
      );
    }
    if (!items.length) {
      notes.push(
        query
          ? `Geen overheidsorganisatie gevonden voor '${query}'. Controleer de schrijfwijze of laat 'query' leeg om de volledige lijst te bladeren.`
          : "Geen overheidsorganisaties ontvangen van het register.",
      );
    }

    return {
      items,
      total,
      endpoint: meta.url,
      params,
      access_note: notes.length ? notes.join(" ") : undefined,
    };
  }
}
