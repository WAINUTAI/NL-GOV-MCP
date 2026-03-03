import * as cbs from "./sources/cbsStatline.js";
import * as rdw from "./sources/rdw.js";
import * as bag from "./sources/pdokBag.js";
import * as ob from "./sources/officieleBekendmakingen.js";
import * as catalog from "./sources/dataOverheidCatalog.js";

export type NLSource =
  | "data.overheid.nl"
  | "cbs_statline"
  | "tweede_kamer"
  | "officiele_bekendmakingen"
  | "rijksoverheid_open_data"
  | "rijksfinancien"
  | "duo_onderwijsdata"
  | "api_register"
  | "knmi"
  | "pdok_bag"
  | "ngr"
  | "ori_ods"
  | "ndw"
  | "rdw"
  | "rws_waterdata"
  | "luchtmeetnet"
  | "rechtspraak";

export type Citation = {
  source: NLSource;
  title: string;
  url: string;
  retrievedAt: string;
  excerpt?: string;
};

export type MCPResult = {
  query: string;
  routedTo: NLSource[];
  data: unknown;
  answer: string;
  citations: Citation[];
  errors?: { source: NLSource; message: string }[];
};

function hasAny(haystack: string, terms: string[]): boolean {
  return terms.some((t) => haystack.includes(t));
}

function buildAnswer(query: string, data: unknown): string {
  const raw = JSON.stringify(data);
  const short = raw.length > 220 ? `${raw.slice(0, 220)}…` : raw;
  return `Resultaten voor: ${query}. ${short}`;
}

async function callWithSafety<T>(
  source: NLSource,
  fn: () => Promise<{ data: T; citations: Citation[] }>,
  errors: Array<{ source: NLSource; message: string }>,
) {
  try {
    return await fn();
  } catch (error) {
    errors.push({
      source,
      message: error instanceof Error ? error.message : "unknown source error",
    });
    return undefined;
  }
}

export async function nlGovMcpQuery(query: string): Promise<MCPResult> {
  const q = query.toLowerCase();
  const errors: Array<{ source: NLSource; message: string }> = [];

  const looksLikeDutchPlate = (() => {
    const tokens = query
      .toUpperCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^A-Z0-9-]/g, ""))
      .filter(Boolean);

    return tokens.some((token) => {
      const compact = token.replace(/-/g, "");
      if (!/^[A-Z0-9]{6}$/.test(compact)) return false;
      const letters = (compact.match(/[A-Z]/g) ?? []).length;
      const digits = (compact.match(/[0-9]/g) ?? []).length;
      return letters >= 2 && digits >= 2;
    });
  })();

  const isRdw =
    hasAny(q, ["kenteken", "voertuig", "rdw", "nummerplaat", "license plate"]) ||
    looksLikeDutchPlate;

  const isBag = hasAny(q, ["bag", "adres", "postcode", "huisnummer"]);
  const isCbs = hasAny(q, ["cbs", "bevolking", "inwoners", "statistiek", "werkloos", "inflatie", "opleidingsniveau"]);
  const isOb = hasAny(q, ["staatsblad", "staatscourant", "gemeenteblad", "bekendmaking", "verordening", "regeling"]);

  if (isBag) {
    const out = await callWithSafety("pdok_bag", () => bag.search(query), errors);
    if (out) {
      return {
        query,
        routedTo: ["pdok_bag"],
        data: out.data,
        answer: buildAnswer(query, out.data),
        citations: out.citations,
        ...(errors.length ? { errors } : {}),
      };
    }
  }

  if (isRdw) {
    const out = await callWithSafety("rdw", () => rdw.search(query), errors);
    if (out) {
      return {
        query,
        routedTo: ["rdw"],
        data: out.data,
        answer: buildAnswer(query, out.data),
        citations: out.citations,
        ...(errors.length ? { errors } : {}),
      };
    }
  }

  if (isOb) {
    const out = await callWithSafety("officiele_bekendmakingen", () => ob.search(query), errors);
    if (out) {
      return {
        query,
        routedTo: ["officiele_bekendmakingen"],
        data: out.data,
        answer: buildAnswer(query, out.data),
        citations: out.citations,
        ...(errors.length ? { errors } : {}),
      };
    }
  }

  if (isCbs) {
    const out = await callWithSafety("cbs_statline", () => cbs.search(query), errors);
    if (out) {
      return {
        query,
        routedTo: ["cbs_statline"],
        data: out.data,
        answer: buildAnswer(query, out.data),
        citations: out.citations,
        ...(errors.length ? { errors } : {}),
      };
    }
  }

  const fallback = await callWithSafety("data.overheid.nl", () => catalog.search(query), errors);
  if (fallback) {
    return {
      query,
      routedTo: ["data.overheid.nl"],
      data: fallback.data,
      answer: buildAnswer(query, fallback.data),
      citations: fallback.citations,
      ...(errors.length ? { errors } : {}),
    };
  }

  return {
    query,
    routedTo: [],
    data: null,
    answer: "Geen resultaten beschikbaar op dit moment.",
    citations: [],
    ...(errors.length ? { errors } : {}),
  };
}
