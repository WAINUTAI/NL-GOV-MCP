import { getJson, getText } from "../utils/http.js";
import type { AppConfig } from "../types.js";

function toItems(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj.value)
    ? (obj.value as Array<Record<string, unknown>>)
    : [];
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeContentType(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isTextLikeContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("html") ||
    contentType.includes("xhtml")
  );
}

function normalizeTextPreview(input: string, maxChars: number): { text: string; truncated: boolean } {
  const compact = input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return { text: compact, truncated: false };
  }
  return {
    text: `${compact.slice(0, Math.max(0, maxChars)).trimEnd()}…`,
    truncated: true,
  };
}

export class TweedeKamerSource {
  constructor(private readonly config: AppConfig) {}

  private async fetchEntity(
    entity: string,
    params: Record<string, string>,
  ): Promise<{ items: Array<Record<string, unknown>>; endpoint: string; params: Record<string, string> }> {
    const endpoint = `${this.config.endpoints.tweedeKamer}/${entity}`;
    const { data, meta } = await getJson<Record<string, unknown>>(endpoint, {
      query: params,
    });
    return { items: toItems(data), endpoint: meta.url, params };
  }

  async search(args: {
    entity: string;
    query: string;
    top: number;
    filter?: string;
    orderby?: string;
    skip?: number;
  }) {
    const entity = args.entity || "Document";
    const params: Record<string, string> = {
      $top: String(args.top),
      $orderby: args.orderby ?? "GewijzigdOp desc",
    };

    const q = args.query?.trim();
    const filters: string[] = [];
    if (q) {
      const esc = escapeODataString(q);
      const entityLower = entity.toLowerCase();
      if (entityLower === "document") {
        filters.push(`contains(Titel,'${esc}') or contains(Onderwerp,'${esc}')`);
      } else if (entityLower === "persoon") {
        filters.push(`contains(Achternaam,'${esc}') or contains(Roepnaam,'${esc}') or contains(Functie,'${esc}')`);
      } else if (entityLower === "besluit") {
        filters.push(`contains(BesluitTekst,'${esc}')`);
      }
    }
    if (args.filter?.trim()) {
      filters.push(args.filter.trim());
    }
    if (filters.length) {
      params.$filter = filters.map((f) => `(${f})`).join(" and ");
    }
    if (typeof args.skip === "number" && args.skip > 0) {
      params.$skip = String(args.skip);
    }

    try {
      return await this.fetchEntity(entity, params);
    } catch {
      // fallback: remove filter/orderby and perform client-side text filtering
      const fallbackParams: Record<string, string> = {
        $top: String(Math.min(Math.max(args.top * 5, 50), 250)),
      };
      if (typeof args.skip === "number" && args.skip > 0) {
        fallbackParams.$skip = String(args.skip);
      }
      const out = await this.fetchEntity(entity, fallbackParams);
      let items = out.items;
      if (q) {
        const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
        items = items.filter((item) => {
          const hay = Object.values(item)
            .map((v) => (v == null ? "" : String(v).toLowerCase()))
            .join(" ");
          return terms.every((t) => hay.includes(t));
        });
      }
      return {
        ...out,
        items: items.slice(0, args.top),
      };
    }
  }

  async searchDocuments(args: {
    query: string;
    top: number;
    type?: string;
    date_from?: string;
    date_to?: string;
  }) {
    const q = escapeODataString(args.query);
    const filters: string[] = [];

    if (args.query.trim()) {
      filters.push(`contains(Titel,'${q}') or contains(Onderwerp,'${q}')`);
    }
    if (args.type?.trim()) {
      const t = escapeODataString(args.type.trim());
      filters.push(`contains(Soort,'${t}') or contains(Titel,'${t}')`);
    }
    if (args.date_from?.trim()) {
      filters.push(`Datum ge ${args.date_from.trim()}T00:00:00Z`);
    }
    if (args.date_to?.trim()) {
      filters.push(`Datum le ${args.date_to.trim()}T23:59:59Z`);
    }

    const params: Record<string, string> = {
      $top: String(args.top),
      $orderby: "Datum desc",
    };
    if (filters.length) params.$filter = filters.map((f) => `(${f})`).join(" and ");

    return this.fetchEntity("Document", params);
  }

  async getDocument(args: {
    id: string;
    resolve_resource?: boolean;
    include_text?: boolean;
    max_chars?: number;
  }) {
    const docEndpoint = `${this.config.endpoints.tweedeKamer}/Document(${args.id})`;
    const { data, meta } = await getJson<Record<string, unknown>>(docEndpoint);

    const resourceUrl = `${this.config.endpoints.tweedeKamer}/Document(${args.id})/Resource`;
    const typedResourceUrl = `${this.config.endpoints.tweedeKamer}/Document(${args.id})/TK.DA.GGM.OData.Resource`;
    const maxChars = Math.max(1, Math.min(50_000, args.max_chars ?? 12_000));
    const contentType = normalizeContentType(data.ContentType);

    const item: Record<string, unknown> = {
      ...data,
      resource_url: resourceUrl,
      typed_resource_url: typedResourceUrl,
    };

    if (args.resolve_resource || args.include_text) {
      item.resource_resolved = true;
      item.resolved_resource_url = resourceUrl;
      item.resource_content_type = contentType || String(data.ContentType ?? "");
      item.resource_content_length = data.ContentLength ?? null;
    }

    if (args.include_text) {
      if (!contentType) {
        item.text_preview_unavailable_reason = "missing_content_type";
      } else if (contentType.includes("pdf")) {
        item.text_preview_unavailable_reason = "pdf_not_extracted_in_lean_mode";
      } else if (!isTextLikeContentType(contentType)) {
        item.text_preview_unavailable_reason = "content_type_not_text_like";
      } else {
        const resource = await getText(resourceUrl, {
          headers: {
            accept: "text/plain, text/html, application/json, application/xml;q=0.9, */*;q=0.1",
          },
        });
        const preview = normalizeTextPreview(resource.data, maxChars);
        item.resolved_resource_url = resource.meta.url;
        item.text_preview = preview.text;
        item.text_preview_chars = preview.text.length;
        item.text_preview_truncated = preview.truncated;
      }
    }

    return {
      item,
      endpoint: meta.url,
      params: {
        id: args.id,
        resolve_resource: String(Boolean(args.resolve_resource)),
        include_text: String(Boolean(args.include_text)),
        max_chars: String(maxChars),
      },
    };
  }

  async getVotes(args: { zaak_id?: string; date?: string; top: number }) {
    const params: Record<string, string> = {
      $top: String(args.top),
      $orderby: "GewijzigdOp desc",
    };

    const filters: string[] = [];
    if (args.zaak_id?.trim()) {
      // API model links votes to Besluit_Id. Accept zaak_id as operator input and use it as besluit-id filter.
      filters.push(`Besluit_Id eq ${args.zaak_id.trim()}`);
    }
    if (args.date?.trim()) {
      const d = args.date.trim();
      filters.push(`GewijzigdOp ge ${d}T00:00:00Z and GewijzigdOp le ${d}T23:59:59Z`);
    }
    if (filters.length) {
      params.$filter = filters.map((f) => `(${f})`).join(" and ");
    }

    return this.fetchEntity("Stemming", params);
  }

  async getMembers(args: { fractie?: string; active?: boolean; top: number }) {
    // 1) Members
    const personsParams: Record<string, string> = {
      $top: String(Math.min(Math.max(args.top * 5, 50), 250)),
      $orderby: "Achternaam asc",
      $filter: "contains(Functie,'Tweede Kamerlid')",
    };
    const personsOut = await this.fetchEntity("Persoon", personsParams);

    // 2) Seating links (person -> seat)
    const linksParams: Record<string, string> = {
      $top: "250",
      $orderby: "GewijzigdOp desc",
    };
    if (args.active !== false) {
      linksParams.$filter = "TotEnMet eq null";
    }
    const linksOut = await this.fetchEntity("FractieZetelPersoon", linksParams);

    // 3) Seat -> faction
    const seatsOut = await this.fetchEntity("FractieZetel", { $top: "250" });
    const factionsOut = await this.fetchEntity("Fractie", { $top: "200" });

    const seatToFaction = new Map<string, string>();
    for (const seat of seatsOut.items) {
      const seatId = String(seat.Id ?? "");
      const fractieId = String(seat.Fractie_Id ?? "");
      if (seatId && fractieId) seatToFaction.set(seatId, fractieId);
    }

    const factionById = new Map<string, Record<string, unknown>>();
    for (const f of factionsOut.items) {
      const id = String(f.Id ?? "");
      if (id) factionById.set(id, f);
    }

    const activeLinkByPerson = new Map<string, Record<string, unknown>>();
    for (const link of linksOut.items) {
      const personId = String(link.Persoon_Id ?? "");
      if (!personId) continue;
      if (!activeLinkByPerson.has(personId)) {
        activeLinkByPerson.set(personId, link);
      }
    }

    const normFractieFilter = (args.fractie ?? "").trim().toLowerCase();

    const items: Array<Record<string, unknown>> = [];
    for (const p of personsOut.items) {
      const personId = String(p.Id ?? "");
      const link = activeLinkByPerson.get(personId);
      const seatId = String(link?.FractieZetel_Id ?? "");
      const factionId = seatToFaction.get(seatId) ?? "";
      const faction = factionById.get(factionId);
      const fractieAfkorting = String(faction?.Afkorting ?? "");
      const fractieNaam = String(faction?.NaamNL ?? faction?.NaamEN ?? "");

      if (normFractieFilter) {
        const hay = `${fractieAfkorting} ${fractieNaam}`.toLowerCase();
        if (!hay.includes(normFractieFilter)) continue;
      }

      const fullName = [p.Roepnaam, p.Tussenvoegsel, p.Achternaam]
        .map((x) => (x ? String(x).trim() : ""))
        .filter(Boolean)
        .join(" ");

      items.push({
        id: p.Id,
        name: fullName || String(p.Achternaam ?? p.Id ?? "Onbekend"),
        roepnaam: p.Roepnaam,
        achternaam: p.Achternaam,
        fractie: fractieAfkorting || undefined,
        fractie_naam: fractieNaam || undefined,
        start_date: link?.Van,
        end_date: link?.TotEnMet,
        roles: p.Functie,
        persoon_url: `${this.config.endpoints.tweedeKamer}/Persoon(${personId})`,
      });

      if (items.length >= args.top) break;
    }

    return {
      items,
      endpoint: personsOut.endpoint,
      params: {
        ...personsOut.params,
        fractie: args.fractie ?? "",
        active: String(args.active !== false),
      },
    };
  }
}
