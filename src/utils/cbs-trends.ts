type CbsRow = Record<string, unknown>;

interface TrendKeys {
  periodKey: string;
  measureKey: string;
}

function parsePeriodSortValue(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const input = value.trim();
  if (!input) return undefined;

  let match = input.match(/^(\d{4})$/);
  if (match) return Number(match[1]) * 10_000;

  match = input.match(/^(\d{4})JJ(?:00)?$/i);
  if (match) return Number(match[1]) * 10_000;

  match = input.match(/^(\d{4})KW(?:0?([1-4]))$/i);
  if (match) return Number(match[1]) * 10_000 + Number(match[2]) * 100;

  match = input.match(/^(\d{4})Q([1-4])$/i);
  if (match) return Number(match[1]) * 10_000 + Number(match[2]) * 100;

  match = input.match(/^(\d{4})MM(0[1-9]|1[0-2])$/i);
  if (match) return Number(match[1]) * 10_000 + Number(match[2]) * 100;

  match = input.match(/^(\d{4})(0[1-9]|1[0-2])$/);
  if (match) return Number(match[1]) * 10_000 + Number(match[2]) * 100;

  match = input.match(/^(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/);
  if (match) {
    return Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3]);
  }

  const parsed = Date.parse(input);
  if (!Number.isNaN(parsed)) return parsed;
  return undefined;
}

function detectTrendKeys(items: CbsRow[]): TrendKeys | undefined {
  if (items.length < 2) return undefined;

  const allKeys = Array.from(
    items.reduce((acc, item) => {
      Object.keys(item).forEach((key) => acc.add(key));
      return acc;
    }, new Set<string>()),
  );

  const periodCandidates = allKeys.filter((key) => {
    if (/^id$/i.test(key)) return false;
    if (!/period/i.test(key) && !/jaar/i.test(key)) return false;

    const values = items
      .map((item) => item[key])
      .filter((value) => value !== null && value !== undefined);

    if (!values.length) return false;
    return values.every((value) => parsePeriodSortValue(value) !== undefined);
  });

  if (periodCandidates.length !== 1) return undefined;
  const periodKey = periodCandidates[0];

  const measureCandidates = allKeys.filter((key) => {
    if (key === periodKey || /^id$/i.test(key)) return false;

    const values = items
      .map((item) => item[key])
      .filter((value) => value !== undefined);

    if (!values.some((value) => typeof value === "number")) return false;
    return values.every((value) => value === null || typeof value === "number");
  });

  if (measureCandidates.length !== 1) return undefined;

  return {
    periodKey,
    measureKey: measureCandidates[0],
  };
}

export function injectCbsTrends(items: CbsRow[]): CbsRow[] {
  const keys = detectTrendKeys(items);
  if (!keys) return items;

  const { periodKey, measureKey } = keys;
  const groupMap = new Map<string, Array<{ index: number; row: CbsRow; periodSort: number }>>();

  items.forEach((row, index) => {
    const periodSort = parsePeriodSortValue(row[periodKey]);
    if (periodSort === undefined) return;

    const groupKey = JSON.stringify(
      Object.keys(row)
        .filter((key) => key !== periodKey && key !== measureKey && !/^id$/i.test(key))
        .sort()
        .map((key) => [key, row[key]]),
    );

    const bucket = groupMap.get(groupKey) ?? [];
    bucket.push({ index, row, periodSort });
    groupMap.set(groupKey, bucket);
  });

  if (!groupMap.size) return items;

  const enriched = items.map((item) => ({ ...item }));

  for (const bucket of groupMap.values()) {
    bucket.sort((a, b) => a.periodSort - b.periodSort);

    for (let i = 1; i < bucket.length; i += 1) {
      const current = bucket[i];
      const previous = bucket[i - 1];

      const currentValue = current.row[measureKey];
      const previousValue = previous.row[measureKey];
      if (typeof currentValue !== "number" || typeof previousValue !== "number") continue;

      const delta = currentValue - previousValue;
      const deltaPct = previousValue === 0 ? null : (delta / previousValue) * 100;

      enriched[current.index].trend_measure = measureKey;
      enriched[current.index].previous_period = previous.row[periodKey];
      enriched[current.index].previous_value = previousValue;
      enriched[current.index].delta = delta;
      enriched[current.index].delta_pct = deltaPct;
    }
  }

  return enriched;
}
