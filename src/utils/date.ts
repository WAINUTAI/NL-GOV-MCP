export function normalizeDateInput(value?: string): string | undefined {
  if (!value) return undefined;
  // Accept YYYY-MM-DD or YYYYMMDD and normalize to YYYYMMDD for APIs that need it.
  if (/^\d{8}$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.replace(/-/g, "");
  return value;
}

export function isCbsPeriodCode(value: string): boolean {
  return /^\d{4}(JJ\d{2}|KW\d{2}|MM\d{2})$/.test(value);
}

export function toIsoNow(): string {
  return new Date().toISOString();
}
