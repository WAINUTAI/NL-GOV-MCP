export interface TemporalContext {
  referenceNow: string;
  timeZone: string;
  today: string;
}

export interface TemporalRange {
  from: string;
  to: string;
  matchedPattern: string;
  cleanedQuery: string;
  context: TemporalContext;
}

export interface TemporalParseOptions {
  now?: Date | string;
  timeZone?: string;
}

export const DEFAULT_TEMPORAL_TIME_ZONE = "Europe/Amsterdam";

function toIsoDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateUtc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

function endOfMonthUtc(year: number, month: number): Date {
  // day=0 => previous month end
  return dateUtc(year, month + 1, 0);
}

function cleanQuery(query: string, matched: RegExpMatchArray | null): string {
  if (!matched) return query.trim();
  const full = matched[0];
  return query.replace(full, " ").replace(/\s+/g, " ").trim();
}

function normalizeNow(value?: Date | string): Date {
  if (!value) return new Date();

  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid temporal reference time: ${String(value)}`);
  }

  return date;
}

function resolveTimeZone(value?: string): string {
  const candidate = value?.trim() || DEFAULT_TEMPORAL_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-CA", {
      timeZone: candidate,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_TEMPORAL_TIME_ZONE;
  }
}

function getDatePartsInTimeZone(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error(`Unable to resolve date parts for timezone ${timeZone}`);
  }

  return { year, month, day };
}

function startOfDayForTimeZone(date: Date, timeZone: string): Date {
  const parts = getDatePartsInTimeZone(date, timeZone);
  return dateUtc(parts.year, parts.month - 1, parts.day);
}

function normalizeParseOptions(nowOrOptions?: Date | TemporalParseOptions): { now: Date; timeZone: string } {
  if (nowOrOptions instanceof Date) {
    return { now: new Date(nowOrOptions.getTime()), timeZone: DEFAULT_TEMPORAL_TIME_ZONE };
  }

  if (typeof nowOrOptions === "object" && nowOrOptions !== null) {
    return {
      now: normalizeNow(nowOrOptions.now),
      timeZone: resolveTimeZone(nowOrOptions.timeZone),
    };
  }

  return {
    now: new Date(),
    timeZone: DEFAULT_TEMPORAL_TIME_ZONE,
  };
}

function makeRange(
  from: string,
  to: string,
  matchedPattern: string,
  cleanedQuery: string,
  context: TemporalContext,
): TemporalRange {
  return {
    from,
    to,
    matchedPattern,
    cleanedQuery,
    context,
  };
}

export function parseTemporalRange(input: string, nowOrOptions: Date | TemporalParseOptions = new Date()): TemporalRange | undefined {
  const query = input.trim();
  if (!query) return undefined;

  const { now, timeZone } = normalizeParseOptions(nowOrOptions);
  const today = startOfDayForTimeZone(now, timeZone);
  const todayIso = toIsoDateUtc(today);
  const context: TemporalContext = {
    referenceNow: now.toISOString(),
    timeZone,
    today: todayIso,
  };

  // tussen 2018 en 2022 / between 2018 and 2022
  const betweenYears = query.match(/\b(?:tussen|between)\s+(20\d{2})\s+(?:en|and)\s+(20\d{2})\b/i);
  if (betweenYears) {
    const y1 = Number(betweenYears[1]);
    const y2 = Number(betweenYears[2]);
    const fromYear = Math.min(y1, y2);
    const toYear = Math.max(y1, y2);
    return makeRange(
      `${fromYear}-01-01`,
      `${toYear}-12-31`,
      "between_years",
      cleanQuery(query, betweenYears),
      context,
    );
  }

  // sinds 2020 / since 2020
  const sinceYear = query.match(/\b(?:sinds|since)\s+(20\d{2})\b/i);
  if (sinceYear) {
    const year = Number(sinceYear[1]);
    return makeRange(
      `${year}-01-01`,
      todayIso,
      "since_year",
      cleanQuery(query, sinceYear),
      context,
    );
  }

  // vandaag / today
  const todayMatch = query.match(/\b(?:vandaag|today)\b/i);
  if (todayMatch) {
    return makeRange(todayIso, todayIso, "today", cleanQuery(query, todayMatch), context);
  }

  // gisteren / yesterday
  const yesterdayMatch = query.match(/\b(?:gisteren|yesterday)\b/i);
  if (yesterdayMatch) {
    const y = dateUtc(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1);
    const d = toIsoDateUtc(y);
    return makeRange(d, d, "yesterday", cleanQuery(query, yesterdayMatch), context);
  }

  // dit jaar / this year
  const thisYearMatch = query.match(/\b(?:dit\s+jaar|this\s+year)\b/i);
  if (thisYearMatch) {
    const year = today.getUTCFullYear();
    return makeRange(
      `${year}-01-01`,
      todayIso,
      "this_year",
      cleanQuery(query, thisYearMatch),
      context,
    );
  }

  // vorig jaar / last year
  const lastYearMatch = query.match(/\b(?:vorig\s+jaar|afgelopen\s+jaar|last\s+year)\b/i);
  if (lastYearMatch) {
    const year = today.getUTCFullYear() - 1;
    return makeRange(
      `${year}-01-01`,
      `${year}-12-31`,
      "last_year",
      cleanQuery(query, lastYearMatch),
      context,
    );
  }

  // bare year: "in 2024", "uit 2024", "from 2024", or standalone "2024"
  const bareYearMatch = query.match(/\b(?:in|uit|from|van|over)?\s*(20\d{2})\b/i);
  if (bareYearMatch) {
    const year = Number(bareYearMatch[1]);
    const currentYear = today.getUTCFullYear();
    const to = year === currentYear ? todayIso : `${year}-12-31`;
    return makeRange(
      `${year}-01-01`,
      to,
      "bare_year",
      cleanQuery(query, bareYearMatch),
      context,
    );
  }

  // afgelopen kwartaal / last quarter
  const lastQuarterMatch = query.match(/\b(?:afgelopen\s+kwartaal|vorige\s+kwartaal|last\s+quarter)\b/i);
  if (lastQuarterMatch) {
    const month = today.getUTCMonth();
    const currentQuarter = Math.floor(month / 3);
    const previousQuarter = (currentQuarter + 3) % 4;
    const quarterYear = currentQuarter === 0 ? today.getUTCFullYear() - 1 : today.getUTCFullYear();
    const startMonth = previousQuarter * 3;
    const endMonth = startMonth + 2;

    return makeRange(
      toIsoDateUtc(dateUtc(quarterYear, startMonth, 1)),
      toIsoDateUtc(endOfMonthUtc(quarterYear, endMonth)),
      "last_quarter",
      cleanQuery(query, lastQuarterMatch),
      context,
    );
  }

  // afgelopen maand / last month
  const lastMonthMatch = query.match(/\b(?:afgelopen\s+maand|vorige\s+maand|last\s+month)\b/i);
  if (lastMonthMatch) {
    const month = today.getUTCMonth();
    const year = today.getUTCFullYear();
    const previousMonth = (month + 11) % 12;
    const previousYear = month === 0 ? year - 1 : year;

    return makeRange(
      toIsoDateUtc(dateUtc(previousYear, previousMonth, 1)),
      toIsoDateUtc(endOfMonthUtc(previousYear, previousMonth)),
      "last_month",
      cleanQuery(query, lastMonthMatch),
      context,
    );
  }

  // vorige week / last week (ISO-style Monday..Sunday)
  const lastWeekMatch = query.match(/\b(?:vorige\s+week|afgelopen\s+week|last\s+week)\b/i);
  if (lastWeekMatch) {
    const day = today.getUTCDay(); // 0=Sun..6=Sat
    const dayFromMonday = (day + 6) % 7; // 0=Mon
    const startCurrentWeek = dateUtc(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() - dayFromMonday,
    );
    const startPrevWeek = dateUtc(
      startCurrentWeek.getUTCFullYear(),
      startCurrentWeek.getUTCMonth(),
      startCurrentWeek.getUTCDate() - 7,
    );
    const endPrevWeek = dateUtc(
      startCurrentWeek.getUTCFullYear(),
      startCurrentWeek.getUTCMonth(),
      startCurrentWeek.getUTCDate() - 1,
    );

    return makeRange(
      toIsoDateUtc(startPrevWeek),
      toIsoDateUtc(endPrevWeek),
      "last_week",
      cleanQuery(query, lastWeekMatch),
      context,
    );
  }

  return undefined;
}
