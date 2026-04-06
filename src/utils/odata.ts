export interface ODataQuery {
  filter?: string;
  select?: string[];
  top?: number;
  skip?: number;
  orderby?: string;
  expand?: string;
}

export function buildODataQuery(query: ODataQuery): Record<string, string> {
  const params: Record<string, string> = {};
  if (query.filter) params["$filter"] = query.filter;
  if (query.select?.length) params["$select"] = query.select.join(",");
  if (typeof query.top === "number") params["$top"] = String(query.top);
  if (typeof query.skip === "number") params["$skip"] = String(query.skip);
  if (query.orderby) params["$orderby"] = query.orderby;
  if (query.expand) params["$expand"] = query.expand;
  return params;
}

const SAFE_FIELD = /^[A-Za-z_]\w*$/;

function assertSafeField(field: string): void {
  if (!SAFE_FIELD.test(field)) {
    throw new Error(`Invalid OData field name: ${field}`);
  }
}

export function contains(field: string, value: string): string {
  assertSafeField(field);
  const escaped = value.replace(/'/g, "''");
  return `contains(${field},'${escaped}')`;
}

export function equals(field: string, value: string): string {
  assertSafeField(field);
  const escaped = value.replace(/'/g, "''");
  return `${field} eq '${escaped}'`;
}

export function and(...filters: Array<string | undefined>): string | undefined {
  const clean = filters.filter((f): f is string => Boolean(f));
  if (!clean.length) return undefined;
  return clean.map((f) => `(${f})`).join(" and ");
}
