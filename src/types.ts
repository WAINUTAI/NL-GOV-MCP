export interface MCPRecord {
  title: string;
  date?: string;
  source_name: string;
  canonical_url: string;
  snippet?: string;
  data?: Record<string, unknown>;
}

export interface Provenance {
  tool: string;
  endpoint: string;
  query_params: Record<string, string>;
  timestamp: string;
  total_results?: number;
  returned_results: number;
}

export interface MCPToolResponse {
  summary: string;
  records: MCPRecord[];
  provenance: Provenance;
  access_note?: string;
  failures?: Array<{
    connector: string;
    error_type: MCPErrorCode;
    message: string;
  }>;
  pagination?: {
    offset: number;
    limit: number;
    total: number | null;
    has_more: boolean;
  };
  output_format?: "json" | "csv" | "geojson" | "markdown_table";
  formatted_output?: string | Record<string, unknown>;
}

export type MCPErrorCode =
  | "timeout"
  | "http_error"
  | "rate_limited"
  | "malformed_response"
  | "not_configured"
  | "circuit_open"
  | "unexpected";

export interface MCPErrorResponse {
  error: MCPErrorCode;
  message: string;
  suggestion?: string;
  retry_after?: number;
  details?: Record<string, unknown>;
}

export type ToolResult = MCPToolResponse | MCPErrorResponse;

export interface SourceCallMeta {
  endpoint: string;
  params?: Record<string, string | number | boolean | undefined>;
}

export interface CacheOptions {
  ttlMs: number;
}

export interface AppConfig {
  server: {
    name: string;
    version: string;
    httpPort: number;
  };
  cacheTtlMs: {
    default: number;
    cbsCatalog: number;
    tkEntityLists: number;
    knmiObservations: number;
    knmiHistorical: number;
    dataOverheidDatasetList: number;
    rijksoverheidLists: number;
  };
  limits: {
    defaultRows: number;
    maxRows: number;
  };
  endpoints: {
    dataOverheid: string;
    cbsV4: string;
    cbsV3: string;
    tweedeKamer: string;
    bekendmakingenSru: string;
    rijksoverheid: string;
    knmi: string;
    rijksbegroting: string;
    duoDatasets: string;
    duoRio: string;
    apiRegister: string;
  };
}
