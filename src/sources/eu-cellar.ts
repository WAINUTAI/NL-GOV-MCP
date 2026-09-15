import type { AppConfig } from "../types.js";
import { getJson } from "../utils/http.js";

/**
 * EUR-Lex via CELLAR, the Publications Office's semantic repository. Its SPARQL
 * endpoint is keyless and fast for exact CELEX lookups and Virtuoso free-text
 * (bif:contains) title searches; FILTER(CONTAINS/REGEX) scans the whole corpus
 * and takes >10 s, so it is never used here.
 */
const SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";
const CELLAR_CELEX = "https://publications.europa.eu/resource/celex/";
const EURLEX_NL = "https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=CELEX:";
const OB_BASE = "https://zoek.officielebekendmakingen.nl/";

const LANG_NLD = "http://publications.europa.eu/resource/authority/language/NLD";
const LANG_ENG = "http://publications.europa.eu/resource/authority/language/ENG";
const COUNTRY_NLD = "http://publications.europa.eu/resource/authority/country/NLD";
const RESOURCE_TYPE = "http://publications.europa.eu/resource/authority/resource-type/";

/** Newest CJEU rulings listed per legal act in eurlex_document. */
const CASE_LAW_LIMIT = 10;

const PREFIXES =
  "PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>\n" +
  "PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\n";

const TYPE_GROUPS: Record<"REG" | "DIR" | "DEC", string[]> = {
  REG: ["REG", "REG_IMPL", "REG_DEL"],
  DIR: ["DIR", "DIR_IMPL", "DIR_DEL"],
  DEC: ["DEC", "DEC_IMPL", "DEC_DEL"],
};

const TYPE_LABEL_NL: Record<string, string> = {
  REG: "Verordening",
  REG_IMPL: "Uitvoeringsverordening",
  REG_DEL: "Gedelegeerde verordening",
  DIR: "Richtlijn",
  DIR_IMPL: "Uitvoeringsrichtlijn",
  DIR_DEL: "Gedelegeerde richtlijn",
  DEC: "Besluit",
  DEC_IMPL: "Uitvoeringsbesluit",
  DEC_DEL: "Gedelegeerd besluit",
};

/** Words Virtuoso's free-text index treats as noise; an AND with one of them matches nothing. */
const NOISE_WORDS = new Set([
  "het", "een", "van", "voor", "met", "door", "naar", "over", "tot", "bij", "aan", "uit",
  "als", "dat", "die", "deze", "zijn", "and", "the", "for", "with", "des", "der", "den",
]);

const ACCESS_NOTE_BASE =
  "Bron: EUR-Lex/CELLAR (Publicatiebureau van de Europese Unie), SPARQL-endpoint. " +
  "Alleen de elektronische editie van het Publicatieblad van de EU is authentiek; " +
  "metadata en geconsolideerde teksten dienen louter ter informatie.";

export interface EuCellarResult {
  items: Array<Record<string, unknown>>;
  total: number | null;
  endpoint: string;
  params: Record<string, string>;
  access_note: string;
}

type Binding = Record<string, { value?: string } | undefined>;
interface SparqlJson {
  results?: { bindings?: Binding[] };
}

const CELEX_STRICT = /^3\d{4}[A-Z]\d{4,5}$/;

function expandYear(y: string): string {
  if (y.length === 4) return y;
  return Number(y) > 50 ? `19${y}` : `20${y}`;
}

function plausibleYear(y: string): boolean {
  if (y.length !== 2 && y.length !== 4) return false;
  const n = Number(expandYear(y));
  return n >= 1952 && n <= 2100;
}

/**
 * Turn a CELEX number or a Dutch/English EU citation into a sector-3 CELEX
 * (e.g. "Richtlijn 95/46/EG" → 31995L0046). Returns null when unrecognised.
 */
export function normalizeCelex(input: string): string | null {
  const raw = String(input ?? "").normalize("NFC").trim();
  if (!raw) return null;

  const direct = raw.replace(/^celex\s*[:\s]\s*/i, "").replace(/\s+/g, "").toUpperCase();
  const dm = /^3(\d{4})([A-Z])(\d{1,5})$/.exec(direct);
  if (dm) {
    const celex = `3${dm[1]}${dm[2]}${dm[3].padStart(4, "0")}`;
    return CELEX_STRICT.test(celex) ? celex : null;
  }

  const s = raw.toLowerCase();
  const kinds: Array<[RegExp, string]> = [
    [/verordening|regulation/, "R"],
    [/richtlijn|directive/, "L"],
    [/besluit|decision|beschikking/, "D"],
  ];
  let letter: string | null = null;
  let firstAt = Infinity;
  for (const [re, l] of kinds) {
    const m = re.exec(s);
    if (m && m.index < firstAt) {
      firstAt = m.index;
      letter = l;
    }
  }
  const nm = /(\d{1,4})\s*\/\s*(\d{1,4})/.exec(s);
  if (!letter || !nm) return null;

  const [a, b] = [nm[1], nm[2]];
  let year: string;
  let number: string;
  // Pre-2015 regulations are cited as "(EG) nr. 1049/2001": number first, year last.
  const numberFirst = /\b(nr|no)\.?\s*$/.test(s.slice(0, nm.index));
  if (numberFirst && plausibleYear(b)) {
    [year, number] = [b, a];
  } else if (plausibleYear(a)) {
    [year, number] = [a, b];
  } else if (b.length === 4 && plausibleYear(b)) {
    [year, number] = [b, a];
  } else {
    return null;
  }
  const celex = `3${expandYear(year)}${letter}${number.padStart(4, "0")}`;
  return CELEX_STRICT.test(celex) ? celex : null;
}

/**
 * Build a Virtuoso free-text expression from user input. Only Unicode letters
 * and digits survive, so quotes, braces and SPARQL keywords can never reach the query.
 */
export function buildFreeText(query: string): string {
  const words = (String(query ?? "").normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => w.length >= 3 && !NOISE_WORDS.has(w.toLowerCase()))
    .slice(0, 6);
  if (words.length === 0) {
    throw new Error(
      `Zoekterm '${query}' bevat geen bruikbare woorden (minimaal 3 letters of cijfers, geen stopwoorden).`,
    );
  }
  return words.map((w) => `"${w}"`).join(" AND ");
}

function val(row: Binding, key: string): string | undefined {
  const v = row[key]?.value;
  return v === undefined || v === "" ? undefined : v;
}

function lastSegment(uri: string | undefined): string | undefined {
  return uri ? uri.split("/").pop() : undefined;
}

function toBool(v: string | undefined): boolean | null {
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return null;
}

function requireCelex(id: string): string {
  const celex = normalizeCelex(id);
  if (!celex) {
    throw new Error(
      `Ongeldig CELEX-nummer of EU-citaat: '${id}' (verwacht bv. 32016R0679 of 'Richtlijn (EU) 2016/680').`,
    );
  }
  return celex;
}

function legislationItem(args: {
  celex: string;
  titleNl?: string;
  titleEn?: string;
  type?: string;
  date?: string;
  force?: string;
  eli?: string;
}): Record<string, unknown> {
  const title = args.titleNl ?? args.titleEn ?? null;
  return {
    celex: args.celex,
    title,
    title_language: args.titleNl ? "nl" : args.titleEn ? "en" : null,
    document_type: args.type ?? null,
    document_type_label: args.type ? (TYPE_LABEL_NL[args.type] ?? args.type) : null,
    date: args.date ? args.date.slice(0, 10) : null,
    in_force: toBool(args.force),
    eli: args.eli ?? null,
    eurlex_url: EURLEX_NL + args.celex,
    cellar_url: CELLAR_CELEX + args.celex,
  };
}

/** Derive the officielebekendmakingen.nl identifier of a Dutch implementing measure. */
function bekendmakingId(
  oj: string | undefined,
  ojNum: string | undefined,
  ojDate: string | undefined,
  typeAct: string | undefined,
): { identifier: string | null; journal: string | null } {
  const year = ojDate?.slice(0, 4);
  const num = ojNum?.trim().replace(/^0+(?=\d)/, "");
  const ojLower = (oj ?? "").toLowerCase();
  let kind: "stb" | "stcrt" | null = null;
  if (ojLower.includes("staatsblad")) kind = "stb";
  else if (ojLower.includes("staatscourant")) kind = "stcrt";
  else if (!oj) {
    // Without a journal name CELLAR still gives the number: a Wet is always in the
    // Staatsblad, a ministerial Regeling/Bekendmaking always in the Staatscourant.
    const t = (typeAct ?? "").toLowerCase();
    if (t === "wet") kind = "stb";
    else if (/^(bekendmaking|regeling|mededeling)$/.test(t)) kind = "stcrt";
  }
  const validNumber = Boolean(num && /^\d+$/.test(num) && year && /^\d{4}$/.test(year));
  const identifier = kind && validNumber ? `${kind}-${year}-${num}` : null;

  let journal: string | null = null;
  const baseName = oj ? oj.replace(/\s*\(.*\)\s*$/, "").trim() : kind === "stb" ? "Staatsblad" : kind === "stcrt" ? "Staatscourant" : "";
  if (baseName && validNumber) journal = `${baseName} ${year}, ${num}`;
  else if (oj) journal = oj;
  return { identifier, journal };
}

export class EuCellarSource {
  constructor(private readonly config: AppConfig) {}

  private async select(query: string): Promise<Binding[]> {
    const { data } = await getJson<SparqlJson>(SPARQL_ENDPOINT, {
      query: { query: PREFIXES + query },
      headers: { Accept: "application/sparql-results+json" },
      connector: "eu_cellar",
      timeoutMs: 20_000,
      retries: 1,
    });
    const bindings = data?.results?.bindings;
    if (!Array.isArray(bindings)) {
      throw new Error("CELLAR SPARQL gaf een onverwacht antwoord (geen results.bindings).");
    }
    return bindings;
  }

  async search(args: { query: string; type?: "REG" | "DIR" | "DEC"; limit: number }): Promise<EuCellarResult> {
    const expression = buildFreeText(args.query);
    const limit = Math.max(1, Math.min(Math.floor(args.limit) || 1, this.config.limits.maxRows));
    const types = args.type ? TYPE_GROUPS[args.type] : Object.values(TYPE_GROUPS).flat();
    if (!types) throw new Error(`Onbekend documenttype '${args.type}' (verwacht REG, DIR of DEC).`);
    const typeList = types.map((t) => `<${RESOURCE_TYPE}${t}>`).join(", ");

    const sparql = `SELECT DISTINCT ?celex ?date ?type ?force ?eli ?title WHERE {
  ?expr cdm:expression_title ?title ;
        cdm:expression_uses_language <${LANG_NLD}> ;
        cdm:expression_belongs_to_work ?work .
  ?title bif:contains '${expression}' .
  ?work cdm:resource_legal_id_celex ?celex ;
        cdm:work_has_resource-type ?type ;
        cdm:work_date_document ?date .
  OPTIONAL { ?work cdm:resource_legal_in-force ?force }
  OPTIONAL { ?work cdm:resource_legal_eli ?eli }
  FILTER(?type IN (${typeList}))
  FILTER(!CONTAINS(STR(?celex), "R("))
} ORDER BY DESC(?date) ?celex LIMIT ${limit}`;

    const rows = await this.select(sparql);
    const seen = new Set<string>();
    const items: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const celex = val(row, "celex");
      if (!celex || seen.has(celex)) continue;
      seen.add(celex);
      items.push(
        legislationItem({
          celex,
          titleNl: val(row, "title"),
          type: lastSegment(val(row, "type")),
          date: val(row, "date"),
          force: val(row, "force"),
          eli: val(row, "eli"),
        }),
      );
    }

    return {
      items,
      total: null,
      endpoint: SPARQL_ENDPOINT,
      params: {
        query: args.query,
        freetext: expression,
        ...(args.type ? { type: args.type } : {}),
        limit: String(limit),
      },
      access_note:
        `${ACCESS_NOTE_BASE} Er wordt alleen gezocht in de Nederlandse titels (niet in de volledige tekst) ` +
        "van verordeningen, richtlijnen en besluiten, nieuwste eerst; het totaal aantal treffers is onbekend. " +
        (items.length === 0
          ? "Geen titels gevonden; probeer officiële EU-terminologie (bv. 'artificiële intelligentie' i.p.v. 'kunstmatige intelligentie'), synoniemen of minder woorden."
          : "Titels gebruiken officiële EU-terminologie; zijn de resultaten schaars of niet relevant, zoek dan opnieuw met officiële of alternatieve termen of met minder woorden."),
    };
  }

  /** CJEU case law interpreting a work: the newest rulings plus the total count, as two parallel queries. */
  private async caseLaw(celex: string): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
    // No GROUP BY: Virtuoso's MAX/SAMPLE over OPTIONAL dates mixes values between groups.
    // Rows can repeat per title, so fetch a margin and deduplicate on CELEX below.
    const listSparql = `SELECT DISTINCT ?celex ?ecli ?date ?titleNl ?titleEn WHERE {
  ?work cdm:resource_legal_id_celex "${celex}"^^xsd:string .
  ?case cdm:case-law_interpretes_resource_legal ?work ;
        cdm:resource_legal_id_celex ?celex ;
        cdm:work_date_document ?date .
  OPTIONAL { ?case cdm:case-law_ecli ?ecli }
  OPTIONAL { ?exprNl cdm:expression_belongs_to_work ?case ;
             cdm:expression_uses_language <${LANG_NLD}> ;
             cdm:expression_title ?titleNl }
  OPTIONAL { ?exprEn cdm:expression_belongs_to_work ?case ;
             cdm:expression_uses_language <${LANG_ENG}> ;
             cdm:expression_title ?titleEn }
} ORDER BY DESC(?date) ?celex LIMIT ${CASE_LAW_LIMIT * 4}`;
    const countSparql = `SELECT (COUNT(DISTINCT ?case) AS ?n) WHERE {
  ?work cdm:resource_legal_id_celex "${celex}"^^xsd:string .
  ?case cdm:case-law_interpretes_resource_legal ?work .
}`;

    const [listRows, countRows] = await Promise.all([this.select(listSparql), this.select(countSparql)]);
    const total = Number(countRows[0] ? val(countRows[0], "n") : undefined);
    if (!Number.isInteger(total) || total < 0) {
      throw new Error("CELLAR SPARQL gaf geen geldig aantal HvJ-uitspraken.");
    }

    const seen = new Set<string>();
    const items: Array<Record<string, unknown>> = [];
    for (const row of listRows) {
      const caseCelex = val(row, "celex");
      if (!caseCelex || seen.has(caseCelex)) continue;
      seen.add(caseCelex);
      const title = val(row, "titleNl") ?? val(row, "titleEn");
      items.push({
        ecli: val(row, "ecli") ?? null,
        celex: caseCelex,
        // CELLAR separates the heading, parties, keywords and case number with '#'.
        title: title ? title.replace(/\s*#\s*/g, " ").trim() : null,
        date: val(row, "date")?.slice(0, 10) ?? null,
        eurlex_url: EURLEX_NL + caseCelex,
      });
      if (items.length === CASE_LAW_LIMIT) break;
    }
    return { items, total: Math.max(total, items.length) };
  }

  async document(args: { id: string }): Promise<EuCellarResult> {
    const celex = requireCelex(args.id);
    const sparql = `SELECT ?date ?type ?force ?eli ?titleNl ?titleEn WHERE {
  ?work cdm:resource_legal_id_celex "${celex}"^^xsd:string .
  OPTIONAL { ?work cdm:work_date_document ?date }
  OPTIONAL { ?work cdm:work_has_resource-type ?type }
  OPTIONAL { ?work cdm:resource_legal_in-force ?force }
  OPTIONAL { ?work cdm:resource_legal_eli ?eli }
  OPTIONAL { ?exprNl cdm:expression_belongs_to_work ?work ;
             cdm:expression_uses_language <${LANG_NLD}> ;
             cdm:expression_title ?titleNl }
  OPTIONAL { ?exprEn cdm:expression_belongs_to_work ?work ;
             cdm:expression_uses_language <${LANG_ENG}> ;
             cdm:expression_title ?titleEn }
} LIMIT 100`;

    // Case law runs alongside the metadata; only the metadata query may fail the call.
    const [rows, caseLaw] = await Promise.all([
      this.select(sparql),
      this.caseLaw(celex).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]);
    const first = (key: string, pick?: (v: string) => boolean): string | undefined => {
      for (const row of rows) {
        const v = val(row, key);
        if (v !== undefined && (!pick || pick(v))) return v;
      }
      return undefined;
    };

    const params = { id: args.id, celex };
    if (rows.length === 0) {
      return {
        items: [],
        total: 0,
        endpoint: SPARQL_ENDPOINT,
        params,
        access_note: `${ACCESS_NOTE_BASE} CELEX ${celex} komt niet voor in CELLAR.`,
      };
    }

    // A work can carry several resource types (e.g. REG and a legacy code); prefer a known one.
    const typeCodes = rows.map((r) => lastSegment(val(r, "type"))).filter((t): t is string => Boolean(t));
    const type = typeCodes.find((t) => t in TYPE_LABEL_NL) ?? typeCodes[0];

    let caseLawNote: string;
    if (!caseLaw.ok) {
      const reason = caseLaw.error instanceof Error ? caseLaw.error.message : String(caseLaw.error);
      caseLawNote = ` HvJ-rechtspraak kon niet worden opgehaald (${reason.slice(0, 200)}); hvj_arresten en hvj_arresten_total zijn daarom null.`;
    } else if (caseLaw.value.total === 0) {
      caseLawNote = " CELLAR registreert geen uitspraken van het Hof van Justitie die deze handeling uitleggen.";
    } else {
      caseLawNote =
        ` hvj_arresten: de ${caseLaw.value.items.length} nieuwste van ${caseLaw.value.total} uitspraken van het Hof van Justitie ` +
        "(vooral arresten) die deze handeling volgens CELLAR uitleggen.";
    }

    return {
      items: [
        {
          ...legislationItem({
            celex,
            titleNl: first("titleNl"),
            titleEn: first("titleEn"),
            type,
            date: first("date"),
            force: first("force"),
            eli: first("eli"),
          }),
          hvj_arresten: caseLaw.ok ? caseLaw.value.items : null,
          hvj_arresten_total: caseLaw.ok ? caseLaw.value.total : null,
        },
      ],
      total: 1,
      endpoint: SPARQL_ENDPOINT,
      params,
      access_note: ACCESS_NOTE_BASE + caseLawNote,
    };
  }

  async nlTransposition(args: { id: string; limit: number }): Promise<EuCellarResult> {
    const celex = requireCelex(args.id);
    if (celex[5] !== "L") {
      throw new Error(
        `${celex} is geen richtlijn; nationale omzettingsmaatregelen bestaan alleen voor richtlijnen (verordeningen gelden rechtstreeks).`,
      );
    }
    const limit = Math.max(1, Math.min(Math.floor(args.limit) || 1, this.config.limits.maxRows));

    // Group per measure: several OPTIONAL values would otherwise multiply the rows
    // and let LIMIT cut measures off.
    const sparql = `SELECT ?nimcelex (SAMPLE(?t) AS ?title) (SAMPLE(?ta) AS ?typeAct) (SAMPLE(?o) AS ?oj)
       (SAMPLE(?on) AS ?ojnum) (MAX(?od) AS ?ojdate) (MAX(?nd) AS ?notif) WHERE {
  ?w cdm:resource_legal_id_celex "${celex}"^^xsd:string .
  ?nim cdm:measure_national_implementing_implements_resource_legal ?w ;
       cdm:measure_national_implementing_implemented_by_country <${COUNTRY_NLD}> ;
       cdm:resource_legal_id_celex ?nimcelex .
  OPTIONAL { ?nim cdm:work_title ?t }
  OPTIONAL { ?nim cdm:measure_national_implementing_type_act ?ta }
  OPTIONAL { ?nim cdm:measure_national_implementing_name_official_journal ?o }
  OPTIONAL { ?nim cdm:measure_national_implementing_number_official_journal ?on }
  OPTIONAL { ?nim cdm:measure_national_implementing_date_official_journal ?od }
  OPTIONAL { ?nim cdm:measure_national_implementing_date_notification ?nd }
} GROUP BY ?nimcelex ORDER BY DESC(?ojdate) ?nimcelex LIMIT ${limit}`;

    const rows = await this.select(sparql);
    const eurlexUrl = EURLEX_NL + celex;
    const seen = new Set<string>();
    const items: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const nimCelex = val(row, "nimcelex");
      if (!nimCelex || seen.has(nimCelex)) continue;
      seen.add(nimCelex);
      const ojDate = val(row, "ojdate");
      const typeAct = val(row, "typeAct");
      const { identifier, journal } = bekendmakingId(val(row, "oj"), val(row, "ojnum"), ojDate, typeAct);
      items.push({
        directive_celex: celex,
        title: val(row, "title") ?? null,
        measure_type: typeAct ?? null,
        official_journal: journal,
        identifier,
        publication_date: ojDate ? ojDate.slice(0, 10) : null,
        notification_date: val(row, "notif")?.slice(0, 10) ?? null,
        canonical_url: identifier ? `${OB_BASE}${identifier}.html` : eurlexUrl,
      });
    }

    const note =
      items.length === 0
        ? ` Voor richtlijn ${celex} zijn in CELLAR geen Nederlandse omzettingsmaatregelen genotificeerd (of de richtlijn bestaat niet).`
        : " Omzettingsmaatregelen zoals door Nederland aan de Commissie genotificeerd; de identifier (stb-/stcrt-) is afgeleid van publicatieblad en nummer.";

    return {
      items,
      total: items.length < limit ? items.length : null,
      endpoint: SPARQL_ENDPOINT,
      params: { id: args.id, celex, limit: String(limit) },
      access_note: ACCESS_NOTE_BASE + note,
    };
  }
}
