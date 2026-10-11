import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

interface RdwRecord {
  kenteken?: string;
  merk?: string;
  handelsbenaming?: string;
  voertuigsoort?: string;
  [key: string]: unknown;
}

const RDW_ENDPOINT = "https://opendata.rdw.nl/resource/m9d7-ebf2.json";

function normalizeKenteken(input: string): string | undefined {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z0-9]{6}$/.test(compact)) return undefined;
  const letters = (compact.match(/[A-Z]/g) ?? []).length;
  const digits = (compact.match(/[0-9]/g) ?? []).length;
  return letters >= 2 && digits >= 2 ? compact : undefined;
}

function toRdwItem(x: RdwRecord, fallbackId: string) {
  const datumTenaamstelling = (x as { datum_tenaamstelling?: unknown }).datum_tenaamstelling;
  return {
    id: `${x.kenteken ?? fallbackId}`,
    title: `${x.merk ?? "Onbekend merk"} ${x.handelsbenaming ?? ""}`.trim(),
    url: "https://opendata.rdw.nl/",
    updated_at: String(datumTenaamstelling ?? ""),
    kenteken: x.kenteken,
    merk: x.merk,
    handelsbenaming: x.handelsbenaming,
    voertuigsoort: x.voertuigsoort,
    datum_tenaamstelling: datumTenaamstelling,
  };
}

function containsQuery(x: RdwRecord, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  const text = `${x.kenteken ?? ""} ${x.merk ?? ""} ${
    x.handelsbenaming ?? ""
  } ${x.voertuigsoort ?? ""}`.toLowerCase();
  return text.includes(q);
}

export class RdwSource {
  constructor(private readonly config: AppConfig) {}

  fallback(args: { query: string; rows: number }) {
    const slug = args.query.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return {
      items: [
        {
          id: `rdw-fallback-${slug}`,
          title: `RDW fallback voor '${args.query}'`,
          url: "https://opendata.rdw.nl/",
          updated_at: "1970-01-01T00:00:00Z",
          voertuigsoort: "onbekend",
          source: "fallback",
        },
      ].slice(0, args.rows),
      total: 1,
      endpoint: `${RDW_ENDPOINT} (fallback)`,
      params: { $limit: String(args.rows) },
      access_note:
        "Geen live RDW match of endpoint instabiliteit; fallbackrecord gebruikt.",
    };
  }

  async search(args: { query: string; rows: number }) {
    const q = args.query.trim();
    const normalizedKenteken = normalizeKenteken(q);
    const escapedLike = q.toUpperCase().replace(/'/g, "''").replace(/[%_\\]/g, "\\$&");

    const attemptParams: Array<Record<string, string>> = [];

    if (normalizedKenteken) {
      attemptParams.push({
        $limit: String(Math.min(args.rows, 25)),
        $where: `kenteken='${normalizedKenteken}'`,
      });
    }

    attemptParams.push({
      $limit: String(Math.min(args.rows * 5, 100)),
      $q: q,
      $order: "datum_tenaamstelling DESC",
    });

    if (q) {
      attemptParams.push({
        $limit: String(Math.min(args.rows * 5, 100)),
        $where: `upper(merk) like '%${escapedLike}%' or upper(handelsbenaming) like '%${escapedLike}%' or upper(voertuigsoort) like '%${escapedLike}%'`,
        $order: "datum_tenaamstelling DESC",
        __timeoutMs: "8000", // LIKE with leading wildcards is slow on Socrata
      });
    }

    for (const params of attemptParams) {
      try {
        const timeoutMs = params.__timeoutMs ? Number(params.__timeoutMs) : 15_000;
        const { __timeoutMs: _, ...cleanParams } = params;
        const { data, meta } = await getJson<RdwRecord[]>(RDW_ENDPOINT, {
          query: cleanParams,
          timeoutMs,
        });

        const raw = Array.isArray(data) ? data : [];
        const filtered =
          params.$q || params.$where
            ? raw
            : raw.filter((x) => containsQuery(x, q));

        if (!filtered.length) continue;

        const seen = new Set<string>();
        const items = filtered
          .map((x, i) => toRdwItem(x, `rdw-${i}`))
          .filter((item) => {
            const key = String(item.id ?? "");
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, args.rows);

        if (!items.length) continue;

        return {
          items,
          // Upstream levert geen count; null i.p.v. de paginagrootte, zodat een
          // consument "x van y" niet met een verzonnen y toont.
          total: null,
          endpoint: meta.url,
          params,
        };
      } catch {
        // try next strategy
      }
    }

    return {
      items: [],
      total: 0,
      endpoint: RDW_ENDPOINT,
      params: { $limit: String(args.rows) },
      access_note: "Geen live match in RDW dataset voor deze zoekterm.",
    };
  }
}
