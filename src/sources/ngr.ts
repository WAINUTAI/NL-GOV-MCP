import type { AppConfig } from "../types.js";
import { getText } from "../utils/http.js";
import { parseXml } from "../utils/xml-parser.js";

const NGR_CSW_ENDPOINT = "https://www.nationaalgeoregister.nl/geonetwork/srv/dut/csw";

function asArray<T>(v: T | T[] | undefined): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

export class NgrSource {
  constructor(private readonly config: AppConfig) {}

  async search(args: { query: string; rows: number }) {
    const params = {
      service: "CSW",
      version: "2.0.2",
      request: "GetRecords",
      resultType: "results",
      typeNames: "gmd:MD_Metadata",
      elementSetName: "summary",
      maxRecords: String(args.rows),
      startPosition: "1",
      outputSchema: "http://www.isotc211.org/2005/gmd",
      constraintLanguage: "CQL_TEXT",
      constraint_language_version: "1.1.0",
      constraint: `AnyText like '%${args.query.replace(/'/g, "''").replace(/[%_\\]/g, "\\$&")}%'`,
    };

    const { data, meta } = await getText(NGR_CSW_ENDPOINT, { query: params, timeoutMs: 20_000, retries: 1 });
    const parsed = parseXml(data) as Record<string, unknown>;
    const resp = (parsed.GetRecordsResponse as Record<string, unknown> | undefined) ?? {};
    const sr = (resp.SearchResults as Record<string, unknown> | undefined) ?? {};
    const md = asArray(sr.MD_Metadata as Record<string, unknown> | Record<string, unknown>[] | undefined);

    const items = md.slice(0, args.rows).map((x) => {
      const fileIdentifier = x.fileIdentifier as Record<string, unknown> | undefined;
      const id = String(fileIdentifier?.CharacterString ?? "");
      const ident = x.identificationInfo as Record<string, unknown> | undefined;
      const mdData = ident?.MD_DataIdentification as Record<string, unknown> | undefined;
      const citation = mdData?.citation as Record<string, unknown> | undefined;
      const mdCitation = citation?.CI_Citation as Record<string, unknown> | undefined;
      const titleNode = mdCitation?.title as Record<string, unknown> | undefined;
      const title = String(titleNode?.CharacterString ?? id ?? "NGR metadata");
      return {
        id,
        title,
        url: id.startsWith("http") ? id : `https://www.nationaalgeoregister.nl/geonetwork/srv/dut/catalog.search#/metadata/${id}`,
        source: "ngr-csw",
        raw: x,
      };
    });

    return {
      items,
      total: Number(sr.numberOfRecordsMatched ?? items.length),
      endpoint: meta.url,
      params,
      ...(items.length ? {} : { access_note: "NGR CSW live endpoint bereikbaar, maar query gaf geen records." }),
    };
  }
}
