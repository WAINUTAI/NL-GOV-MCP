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
  meta?: {
    routeDecision: {
      explicit: boolean;
      matchedRules: string[];
      initialSources: NLSource[];
      finalSources: NLSource[];
      fallbackUsed: boolean;
    };
  };
};

function hasAny(haystack: string, terms: string[]): boolean {
  return terms.some((t) => haystack.includes(t));
}

function buildSuccessAnswer(query: string, data: unknown): string {
  const raw = JSON.stringify(data);
  const short = raw.length > 260 ? `${raw.slice(0, 260)}…` : raw;
  return `Resultaten voor: ${query}. ${short}`;
}

function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];

  for (const c of citations) {
    const key = `${c.source}|${c.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }

  return out;
}

function detectSources(query: string): {
  sources: NLSource[];
  explicit: boolean;
  matchedRules: string[];
} {
  const q = query.toLowerCase();

  const explicitMap: Array<[RegExp, NLSource, string]> = [
    [/^\s*cbs\s*:/i, "cbs_statline", "explicit:cbs"],
    [/^\s*rdw\s*:/i, "rdw", "explicit:rdw"],
    [/^\s*(bag|pdok)\s*:/i, "pdok_bag", "explicit:pdok_bag"],
    [
      /^\s*(ob|offici[eë]le\s+bekendmakingen)\s*:/i,
      "officiele_bekendmakingen",
      "explicit:officiele_bekendmakingen",
    ],
  ];

  for (const [rx, source, rule] of explicitMap) {
    if (rx.test(query)) {
      return { sources: [source], explicit: true, matchedRules: [rule] };
    }
  }

  const sources: NLSource[] = [];
  const matchedRules: string[] = [];

  const isCbs = hasAny(q, [
    "cbs",
    "statline",
    "bevolking",
    "inwoners",
    "cijfers",
    "kerncijfers",
    "emissie",
    "econom",
    "opleidingsniveau",
    "werkloos",
    "inflatie",
  ]);

  const plateLike = /\b([A-Z]{2}-\d{2}-[A-Z]{2}|\d{2}-[A-Z]{2}-\d{2}|[A-Z]{2}-[A-Z]{2}-\d{2}|\d{2}-\d{2}-[A-Z]{2}|[A-Z]{2}-\d{2}-\d{2}|\d{2}-[A-Z]{2}-[A-Z]{2})\b/i.test(
    query,
  );

  const isRdw =
    hasAny(q, [
      "rdw",
      "kenteken",
      "voertuig",
      "apk",
      "bouwjaar",
      "merk",
      "typegoedkeuring",
      "nummerplaat",
      "license plate",
    ]) || plateLike;

  const isBag = hasAny(q, [
    "bag",
    "pdok",
    "adres",
    "postcode",
    "huisnummer",
    "woonplaats",
    "pand",
    "verblijfsobject",
  ]);

  const isOb = hasAny(q, [
    "officiële bekendmakingen",
    "officiele bekendmakingen",
    "regeling",
    "wet",
    "ministeriële regeling",
    "ministeriele regeling",
    "staatscourant",
    "staatsblad",
    "gmb",
    "trb",
    "verordening",
  ]);

  if (isCbs) {
    sources.push("cbs_statline");
    matchedRules.push("heuristic:cbs_keywords");
  }
  if (isRdw) {
    sources.push("rdw");
    matchedRules.push(plateLike ? "heuristic:rdw_plate_pattern" : "heuristic:rdw_keywords");
  }
  if (isBag) {
    sources.push("pdok_bag");
    matchedRules.push("heuristic:bag_keywords");
  }
  if (isOb) {
    sources.push("officiele_bekendmakingen");
    matchedRules.push("heuristic:ob_keywords");
  }

  if (!sources.length) {
    sources.push("data.overheid.nl");
    matchedRules.push("fallback:data.overheid.nl");
  }

  return { sources, explicit: false, matchedRules };
}

async function callSource(
  source: NLSource,
  query: string,
): Promise<{ data: unknown; citations: Citation[] }> {
  switch (source) {
    case "cbs_statline":
      return cbs.search(query);
    case "rdw":
      return rdw.search(query);
    case "pdok_bag":
      return bag.search(query);
    case "officiele_bekendmakingen":
      return ob.search(query);
    case "data.overheid.nl":
      return catalog.search(query);
    default:
      throw new Error(`Unsupported source: ${source}`);
  }
}

export async function nlGovMcpQuery(query: string): Promise<MCPResult> {
  const errors: Array<{ source: NLSource; message: string }> = [];
  const route = detectSources(query);

  const successfulSources: NLSource[] = [];
  const citations: Citation[] = [];
  const payloadBySource: Record<string, unknown> = {};
  let fallbackUsed = false;

  for (const source of route.sources) {
    try {
      const out = await callSource(source, query);
      successfulSources.push(source);
      payloadBySource[source] = out.data;
      citations.push(...out.citations);
    } catch (error) {
      errors.push({
        source,
        message: error instanceof Error ? error.message : "unknown source error",
      });
    }
  }

  // Fallback only when non-explicit route had source failures and no successes.
  if (
    !route.explicit &&
    !successfulSources.length &&
    !route.sources.includes("data.overheid.nl")
  ) {
    try {
      const fallback = await callSource("data.overheid.nl", query);
      successfulSources.push("data.overheid.nl");
      payloadBySource["data.overheid.nl"] = fallback.data;
      citations.push(...fallback.citations);
      fallbackUsed = true;
    } catch (error) {
      errors.push({
        source: "data.overheid.nl",
        message: error instanceof Error ? error.message : "unknown source error",
      });
    }
  }

  if (!successfulSources.length) {
    const errorAnswer = errors.length
      ? `Er trad een fout op bij: ${errors.map((e) => e.source).join(", ")}`
      : "Geen resultaten gevonden.";

    return {
      query,
      routedTo: [],
      data: null,
      answer: errorAnswer,
      citations: [],
      ...(errors.length ? { errors } : {}),
      meta: {
        routeDecision: {
          explicit: route.explicit,
          matchedRules: route.matchedRules,
          initialSources: route.sources,
          finalSources: [],
          fallbackUsed,
        },
      },
    };
  }

  const data =
    successfulSources.length === 1
      ? payloadBySource[successfulSources[0]]
      : payloadBySource;

  return {
    query,
    routedTo: successfulSources,
    data,
    answer: buildSuccessAnswer(query, data),
    citations: dedupeCitations(citations),
    ...(errors.length ? { errors } : {}),
    meta: {
      routeDecision: {
        explicit: route.explicit,
        matchedRules: route.matchedRules,
        initialSources: route.sources,
        finalSources: successfulSources,
        fallbackUsed,
      },
    },
  };
}
