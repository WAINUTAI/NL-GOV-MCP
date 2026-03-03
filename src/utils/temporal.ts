export interface TemporalRange {
  from: string;
  to: string;
  matchedPattern: string;
  cleanedQuery: string;
}

function toIsoDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateUtc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

function startOfDayUtc(date: Date): Date {
  return dateUtc(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
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

export function parseTemporalRange(input: string, now = new Date()): TemporalRange | undefined {
  const query = input.trim();
  if (!query) return undefined;

  const today = startOfDayUtc(now);
  const todayIso = toIsoDateUtc(today);

  // tussen 2018 en 2022 / between 2018 and 2022
  const betweenYears = query.match(/\b(?:tussen|between)\s+(20\d{2})\s+(?:en|and)\s+(20\d{2})\b/i);
  if (betweenYears) {
    const y1 = Number(betweenYears[1]);
    const y2 = Number(betweenYears[2]);
    const fromYear = Math.min(y1, y2);
    const toYear = Math.max(y1, y2);
    return {
      from: `${fromYear}-01-01`,
      to: `${toYear}-12-31`,
      matchedPattern: "between_years",
      cleanedQuery: cleanQuery(query, betweenYears),
    };
  }

  // sinds 2020 / since 2020
  const sinceYear = query.match(/\b(?:sinds|since)\s+(20\d{2})\b/i);
  if (sinceYear) {
    const year = Number(sinceYear[1]);
    return {
      from: `${year}-01-01`,
      to: todayIso,
      matchedPattern: "since_year",
      cleanedQuery: cleanQuery(query, sinceYear),
    };
  }

  // vandaag / today
  const todayMatch = query.match(/\b(?:vandaag|today)\b/i);
  if (todayMatch) {
    return {
      from: todayIso,
      to: todayIso,
      matchedPattern: "today",
      cleanedQuery: cleanQuery(query, todayMatch),
    };
  }

  // gisteren / yesterday
  const yesterdayMatch = query.match(/\b(?:gisteren|yesterday)\b/i);
  if (yesterdayMatch) {
    const y = dateUtc(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1);
    const d = toIsoDateUtc(y);
    return {
      from: d,
      to: d,
      matchedPattern: "yesterday",
      cleanedQuery: cleanQuery(query, yesterdayMatch),
    };
  }

  // dit jaar / this year
  const thisYearMatch = query.match(/\b(?:dit\s+jaar|this\s+year)\b/i);
  if (thisYearMatch) {
    const year = today.getUTCFullYear();
    return {
      from: `${year}-01-01`,
      to: todayIso,
      matchedPattern: "this_year",
      cleanedQuery: cleanQuery(query, thisYearMatch),
    };
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

    return {
      from: toIsoDateUtc(dateUtc(quarterYear, startMonth, 1)),
      to: toIsoDateUtc(endOfMonthUtc(quarterYear, endMonth)),
      matchedPattern: "last_quarter",
      cleanedQuery: cleanQuery(query, lastQuarterMatch),
    };
  }

  // afgelopen maand / last month
  const lastMonthMatch = query.match(/\b(?:afgelopen\s+maand|vorige\s+maand|last\s+month)\b/i);
  if (lastMonthMatch) {
    const month = today.getUTCMonth();
    const year = today.getUTCFullYear();
    const previousMonth = (month + 11) % 12;
    const previousYear = month === 0 ? year - 1 : year;

    return {
      from: toIsoDateUtc(dateUtc(previousYear, previousMonth, 1)),
      to: toIsoDateUtc(endOfMonthUtc(previousYear, previousMonth)),
      matchedPattern: "last_month",
      cleanedQuery: cleanQuery(query, lastMonthMatch),
    };
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

    return {
      from: toIsoDateUtc(startPrevWeek),
      to: toIsoDateUtc(endPrevWeek),
      matchedPattern: "last_week",
      cleanedQuery: cleanQuery(query, lastWeekMatch),
    };
  }

  return undefined;
}
