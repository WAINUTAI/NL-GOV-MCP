import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";
import { fetchPdfText, type PdfTextError, type PdfTextResult } from "../utils/pdf-text.js";

/**
 * TenderNed — the Dutch national public-procurement platform.
 *
 * Every Dutch contracting authority (Rijk, provincie, gemeente, waterschap,
 * zorg- and onderwijsinstelling) publishes its tender notices and awards here,
 * which makes it the missing "what does the government actually buy, from whom,
 * for how much" source alongside Rijksbegroting (planned) and Iv3 (spent).
 *
 * Keyless public API (`papi`). Verified server-side parameters: search,
 * typeOpdracht, procedure, publicatieDatumVanaf/-Tot, page, size (max 100).
 * Unknown parameters are silently ignored by the upstream, so only send verified
 * ones — an unsupported filter would look like it worked and quietly return
 * everything.
 */
const BASE = "https://www.tenderned.nl/papi/tenderned-rs-tns/v2";
const PUBLICATIES = `${BASE}/publicaties`;
const CONNECTOR = "tenderned";
/** Upstream rejects size > 100 with HTTP 400. */
const MAX_PAGE_SIZE = 100;
const VIEWER_BASE = "https://www.tenderned.nl/aankondigingen/overzicht";

export type TenderTypeOpdracht = "leveringen" | "diensten" | "werken" | "all";

const TYPE_OPDRACHT_CODE: Record<Exclude<TenderTypeOpdracht, "all">, string> = {
  leveringen: "L",
  diensten: "D",
  werken: "W",
};

export interface TenderNedItem {
  id: string;
  title: string;
  opdrachtgever: string;
  publicatieDatum: string;
  sluitingsDatum: string;
  typePublicatie: string;
  typePublicatieCode: string;
  procedure: string;
  typeOpdracht: string;
  europees: boolean | null;
  beschrijving: string;
  kenmerk: string;
  url: string;
}

export interface TenderNedDetail extends TenderNedItem {
  cpvCodes: Array<{ code: string; omschrijving: string; hoofdopdracht: boolean }>;
  nutsCodes: Array<{ code: string; omschrijving: string }>;
  juridischKader: string;
  aanbestedingStatus: string;
  opdrachtAard: string;
  aanvangOpdrachtDatum: string;
  voltooiingOpdrachtDatum: string;
  isGegund: boolean | null;
  afgerondeAanbesteding: boolean | null;
  gerelateerdePublicaties: Array<{ id: string; datum: string; type: string }>;
  pdfUrl: string;
  pdf_text?: string;
  pdf_text_chars?: number;
  pdf_text_truncated?: boolean;
  pdf_pages?: number;
  pdf_text_unavailable_reason?: string;
}

interface CodeLabel {
  code?: unknown;
  omschrijving?: unknown;
}

interface PublicatieSummary {
  publicatieId?: unknown;
  publicatieDatum?: unknown;
  sluitingsDatum?: unknown;
  sluitingsDatumMarktconsultatie?: unknown;
  aanbestedingNaam?: unknown;
  opdrachtgeverNaam?: unknown;
  opdrachtBeschrijving?: unknown;
  typePublicatie?: CodeLabel;
  procedure?: CodeLabel;
  typeOpdracht?: CodeLabel;
  europees?: unknown;
  kenmerk?: unknown;
  link?: { href?: unknown };
}

interface PublicatiePage {
  content?: PublicatieSummary[];
  totalElements?: unknown;
  totalPages?: unknown;
  number?: unknown;
  size?: unknown;
}

interface PublicatieDetail {
  publicatieId?: unknown;
  kenmerk?: unknown;
  aanbestedingNaam?: unknown;
  opdrachtgeverNaam?: unknown;
  opdrachtBeschrijving?: unknown;
  publicatieDatum?: unknown;
  sluitingsDatum?: unknown;
  aanvangOpdrachtDatum?: unknown;
  voltooiingOpdrachtDatum?: unknown;
  typePublicatie?: unknown;
  publicatieCode?: unknown;
  juridischKaderCode?: CodeLabel;
  nationaalOfEuropeesCode?: CodeLabel;
  typeOpdrachtCode?: CodeLabel;
  procedureCode?: CodeLabel;
  opdrachtAardCode?: CodeLabel;
  aankondigingCode?: CodeLabel;
  cpvCodes?: Array<{ code?: unknown; omschrijving?: unknown; isHoofdOpdracht?: unknown }>;
  nutsCodes?: CodeLabel[];
  aanbestedingStatus?: unknown;
  isGegund?: unknown;
  afgerondeAanbesteding?: unknown;
  gerelateerdePublicaties?: Array<{
    publicatieId?: unknown;
    publicatieDatum?: unknown;
    typePublicatie?: unknown;
  }>;
}

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function label(value: CodeLabel | undefined): string {
  if (!value) return "";
  const code = str(value.code);
  const omschrijving = str(value.omschrijving);
  if (code && omschrijving) return `${omschrijving} (${code})`;
  return omschrijving || code;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Accept both "2026-08-25" and a full ISO timestamp; upstream wants a plain date. */
function toDateParam(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
}

function mapSummary(row: PublicatieSummary): TenderNedItem {
  const id = str(row.publicatieId);
  const href = str(row.link?.href) || `${VIEWER_BASE}/${id}`;
  return {
    id,
    title: str(row.aanbestedingNaam) || `TenderNed publicatie ${id}`,
    opdrachtgever: str(row.opdrachtgeverNaam),
    publicatieDatum: str(row.publicatieDatum),
    // Marktconsultaties carry their closing date under a different key.
    sluitingsDatum: str(row.sluitingsDatum) || str(row.sluitingsDatumMarktconsultatie),
    typePublicatie: str(row.typePublicatie?.omschrijving),
    typePublicatieCode: str(row.typePublicatie?.code),
    procedure: label(row.procedure),
    typeOpdracht: label(row.typeOpdracht),
    europees: bool(row.europees),
    beschrijving: str(row.opdrachtBeschrijving),
    kenmerk: str(row.kenmerk),
    url: href,
  };
}

export class TenderNedSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: {
    query?: string;
    typeOpdracht?: TenderTypeOpdracht;
    procedure?: string;
    datumVanaf?: string;
    datumTot?: string;
    rows: number;
    page?: number;
  }): Promise<{
    items: TenderNedItem[];
    total: number;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const size = Math.min(MAX_PAGE_SIZE, Math.max(1, args.rows));
    const typeCode =
      args.typeOpdracht && args.typeOpdracht !== "all"
        ? TYPE_OPDRACHT_CODE[args.typeOpdracht]
        : undefined;

    const params: Record<string, string> = {
      page: String(Math.max(0, args.page ?? 0)),
      size: String(size),
    };
    const searchTerm = (args.query ?? "").trim();
    if (searchTerm) params.search = searchTerm;
    if (typeCode) params.typeOpdracht = typeCode;
    if (args.procedure?.trim()) params.procedure = args.procedure.trim().toUpperCase();

    const vanaf = toDateParam(args.datumVanaf);
    const tot = toDateParam(args.datumTot);
    if (vanaf) params.publicatieDatumVanaf = vanaf;
    if (tot) params.publicatieDatumTot = tot;

    const { data, meta } = await getJson<PublicatiePage>(PUBLICATIES, {
      query: params,
      connector: CONNECTOR,
      timeoutMs: 20_000,
    });

    const items = (data.content ?? []).map(mapSummary);
    const totalRaw = Number(data.totalElements);
    const total = Number.isFinite(totalRaw) ? totalRaw : items.length;

    const notes: string[] = [];
    if (args.rows > MAX_PAGE_SIZE) {
      notes.push(`TenderNed levert maximaal ${MAX_PAGE_SIZE} publicaties per pagina; gebruik 'page' voor meer.`);
    }
    if (!items.length) {
      notes.push(
        "TenderNed bereikbaar, maar geen publicaties voor deze zoekterm/filters. Probeer een bredere zoekterm of een ruimere periode.",
      );
    }
    if ((args.datumVanaf && !vanaf) || (args.datumTot && !tot)) {
      notes.push("Datumfilter genegeerd: gebruik het formaat JJJJ-MM-DD.");
    }

    return {
      items,
      total,
      endpoint: meta.url,
      params,
      access_note: notes.length ? notes.join(" ") : undefined,
    };
  }

  async get(args: {
    publicatieId: string;
    include_text?: boolean;
    max_chars?: number;
  }): Promise<{
    item: TenderNedDetail;
    endpoint: string;
    params: Record<string, string>;
    access_note?: string;
  }> {
    const id = args.publicatieId.trim();
    const endpoint = `${PUBLICATIES}/${encodeURIComponent(id)}`;
    const { data, meta } = await getJson<PublicatieDetail>(endpoint, {
      connector: CONNECTOR,
      timeoutMs: 20_000,
    });

    const pdfUrl = `${PUBLICATIES}/${encodeURIComponent(id)}/pdf`;
    const item: TenderNedDetail = {
      id: str(data.publicatieId) || id,
      title: str(data.aanbestedingNaam) || `TenderNed publicatie ${id}`,
      opdrachtgever: str(data.opdrachtgeverNaam),
      publicatieDatum: str(data.publicatieDatum),
      sluitingsDatum: str(data.sluitingsDatum),
      typePublicatie: str(data.typePublicatie),
      typePublicatieCode: str(data.publicatieCode),
      procedure: label(data.procedureCode),
      typeOpdracht: label(data.typeOpdrachtCode),
      europees: str(data.nationaalOfEuropeesCode?.code) === "EU",
      beschrijving: str(data.opdrachtBeschrijving),
      kenmerk: str(data.kenmerk),
      url: `${VIEWER_BASE}/${id}`,
      cpvCodes: (data.cpvCodes ?? []).map((c) => ({
        code: str(c.code),
        omschrijving: str(c.omschrijving),
        hoofdopdracht: c.isHoofdOpdracht === true,
      })),
      nutsCodes: (data.nutsCodes ?? []).map((c) => ({
        code: str(c.code),
        omschrijving: str(c.omschrijving),
      })),
      juridischKader: label(data.juridischKaderCode),
      aanbestedingStatus: str(data.aanbestedingStatus),
      opdrachtAard: label(data.opdrachtAardCode),
      aanvangOpdrachtDatum: str(data.aanvangOpdrachtDatum),
      voltooiingOpdrachtDatum: str(data.voltooiingOpdrachtDatum),
      isGegund: bool(data.isGegund),
      afgerondeAanbesteding: bool(data.afgerondeAanbesteding),
      gerelateerdePublicaties: (data.gerelateerdePublicaties ?? []).map((r) => ({
        id: str(r.publicatieId),
        datum: str(r.publicatieDatum),
        type: str(r.typePublicatie),
      })),
      pdfUrl,
    };

    let access_note: string | undefined;

    if (args.include_text) {
      const extracted: (PdfTextResult | PdfTextError) & { source_url: string } = await fetchPdfText(
        pdfUrl,
        { maxChars: args.max_chars, connector: CONNECTOR },
      );
      if (extracted.ok) {
        item.pdf_text = extracted.text;
        item.pdf_text_chars = extracted.chars;
        item.pdf_text_truncated = extracted.truncated;
        item.pdf_pages = extracted.pages;
      } else {
        item.pdf_text_unavailable_reason = extracted.reason;
        access_note = `Aankondigings-PDF kon niet als tekst worden gelezen (${extracted.reason}); gebruik pdfUrl.`;
      }
    }

    return {
      item,
      endpoint: meta.url,
      params: {
        publicatieId: id,
        include_text: String(Boolean(args.include_text)),
      },
      access_note,
    };
  }
}
