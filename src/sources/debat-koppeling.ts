/**
 * Debat-koppeling: from a Gehoord.de hit to the official spoken text.
 *
 * Gehoord.de is the search index and the fallback; the verslag of the Tweede
 * Kamer (VLOS, Gegevensmagazijn) is the text. For every Tweede Kamer hit this
 * finds its debate in a verslag (cached, see
 * TweedeKamerDebattenSource.getVerslag) and picks the fragment of the same
 * person (Gehoord speakerLabel = TK Persoon GUID = <spreker objectid>) that
 * overlaps the hit most in time. When there is none, the hit keeps its
 * transcript and gets an honest status.
 *
 * Two routes, the direct one first (methode on the Koppeling):
 * - debat_id: Gehoord's tkDebateId (the Debat Direct id) is the objectid of
 *   the debate's <activiteit> in the verslag, exactly. The verslagen of the
 *   candidate vergaderingen of its day are searched for it and the fragment is
 *   matched inside that activiteit: the parts of a begrotingsdebat split
 *   over the day, or two debates in one zaal, cannot take each other's
 *   fragment. Gehoord's debate boundaries are not always VLOS's (Gehoord can
 *   file the Stemmingen after a debate under it): a hit that is not in the
 *   activiteit and runs outside its span (aanvang-eind, beyond the tolerance)
 *   is looked for in the whole verslag. The id is not in the OData API (tkActivityId, the Activiteit Id,
 *   has no way to its Vergadering or Verslag), and tkActivityNumber / parlisid
 *   is no key: the parts of a split begroting share one, Gehoord often has none
 *   for a plenary debate, and a cancelled and a held debate shared one.
 * - zaal_tijd: the vergadering by zaal and start time, the fragment by
 *   speaker and time across the whole verslag. For a hit without a
 *   tkDebateId, with a stale one (no activiteit has it: 2 of 84 held debates
 *   measured) or of a debate without a verslag yet.
 *
 * Facts this rests on (measured November 2026 on the debates of October):
 * - Times line up to the second: Gehoord gives UTC, the verslag local
 *   Europe/Amsterdam time without an offset. A fragment boundary can equal the
 *   end of the previous fragment, so the match is the largest overlap.
 * - A plenary day is one Plenair vergadering; its tussenpublicaties are
 *   cumulative (the latest holds everything so far) and lag the debate by a
 *   few hours. pickVerslag takes the latest.
 * - A committee debate is a Commissie vergadering in the same zaal starting
 *   within minutes of the debate's real start (startedAt; startsAt is the
 *   Debat Direct agenda time and not always the real one). The zaal is
 *   compared on Gehoord's locationId ('klompezaal'), the Gegevensmagazijn
 *   Zaal folded to the same key ("Klompézaal" → klompezaal), else on hall.
 *   Its verslag follows 2-12 days later.
 * - The day of a debate is the date in its Debat Direct url
 *   (debatdirect.tweedekamer.nl/2026-10-28/...), else vergaderDag. A plenary
 *   debate after midnight is also looked for on the day before (night sitting).
 * - Of a vergadering the most corrected, then newest verslag is read:
 *   tussenpublicaties are cumulative (pickVerslag). A plenary verslag appears
 *   the same day or the next, a committee verslag days later: before that
 *   there is nothing to link.
 * - The commissievergadering page comes from Gehoord's tkActivityNumber, else
 *   from the parlisid of the activiteit in the verslag (only for that page).
 * - Technische briefings, procedurevergaderingen, rondetafelgesprekken and
 *   constituerende vergaderingen get no verslag with text (at most an empty
 *   casco, which is never read); every hit carries its debate's debateType, so
 *   no lookup is needed. A cancelled debate is not held.
 * - The Eerste Kamer has no VLOS; its speakerLabel is the Eerste Kamer's own
 *   person id, not a TK GUID.
 *
 * Budgets cap what costs a request, not the hits: the vergaderingen of at
 * most KOPPELING_MAX_DAGEN days and KOPPELING_MAX_VERSLAGEN verslagen per
 * call, each listed or read once per call and shared by its hits; every hit
 * whose verslag is read is linked. Everything runs within
 * KOPPELING_DEADLINE_MS, each request with the time left and no retry, so
 * nothing keeps a connector slot after it. Every failure leaves the hit with
 * its transcript.
 */
import type { DebatActiviteit, DebatFragment, DebatVergadering, DebatVerslag, TweedeKamerDebattenSource } from "./tweede-kamer-debatten.js";
import type { GehoordContribution, GehoordDebateRef } from "./gehoord.js";
import { foldText } from "./dso-regeltekst.js";
import { logger } from "../utils/logger.js";

/** Days whose vergaderingen are listed per call (one small request each); hits on later days keep their transcript (reden limiet). */
export const KOPPELING_MAX_DAGEN = 7;
/** Verslagen read per call: a plenary day is 1-3 MB. */
export const KOPPELING_MAX_VERSLAGEN = 4;
/** Slack on both sides of an official fragment: the clocks agree to the second. */
export const KOPPELING_TOLERANCE_MS = 3_000;
/** A committee vergadering (its Aanvangstijd is the agenda time) starts within this of the debate's start. */
export const KOPPELING_START_WINDOW_MS = 45 * 60_000;
/** Up to this many days after a debate a missing verslag is still expected (committee: 2-12 days). */
export const KOPPELING_RECENT_DAYS = 21;
/** The whole linking step gives up after this; what is not done keeps its transcript. */
export const KOPPELING_DEADLINE_MS = 25_000;

export type KoppelingStatus = "officieel" | "nog_geen_verslag" | "geen_verslag_verwacht" | "eerste_kamer" | "niet_gekoppeld";
export type KoppelingMode = "officieel" | "uit";
/** How the hit found its verslag: the debate's id in the verslag, or zaal and start time. */
export type KoppelingMethode = "debat_id" | "zaal_tijd";

/** Debate types that get no verslag with text in the Gegevensmagazijn (at most an empty casco). */
export const GEEN_VERSLAG_TYPES = new Set(["technische briefing", "procedurevergadering", "rondetafelgesprek", "constituerende vergadering"]);

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Koppeling {
  status: KoppelingStatus;
  /** Why it is not officieel (or a detail of the match). */
  reden?: string;
  /** How the verslag was found; absent when none was. */
  methode?: KoppelingMethode;
  vergadering?: DebatVergadering;
  /** The activiteit (debate) of the verslag the hit is in: by its id (debat_id) or around the fragment (zaal_tijd). */
  activiteit?: Pick<DebatActiviteit, "objectid" | "parlisid" | "titel" | "soort">;
  verslag?: Pick<DebatVerslag, "verslag_id" | "status" | "publicatie">;
  fragment?: DebatFragment;
  /** Seconds the Gehoord hit and the official fragment overlap. */
  overlap_s?: number;
  /** Where in the official text the middle of the hit falls, 0..1 (by time): to show the right passage of a long spreekbeurt. */
  positie?: number;
}

/* ------------------------------------------------------------------ */
/*  Time: UTC (Gehoord) and Europe/Amsterdam local time (VLOS)         */
/* ------------------------------------------------------------------ */

const AMS_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Amsterdam",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Minutes Amsterdam is ahead of UTC at this instant: 120 in summer time, 60 in winter time. */
export function amsterdamOffsetMinutes(epochMs: number): number {
  const p = Object.fromEntries(AMS_PARTS.formatToParts(new Date(epochMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
}

/**
 * "2026-10-28T14:25:32" (Amsterdam wall clock, as in VLOS) → epoch ms. An
 * explicit offset or Z is honoured. The hour that occurs twice when summer
 * time ends (02:00-03:00) maps to one of the two; nobody debates then.
 */
export function amsterdamLocalToEpoch(local: string | undefined): number | undefined {
  if (!local) return undefined;
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(local)) {
    const t = Date.parse(local);
    return Number.isFinite(t) ? t : undefined;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(local);
  if (!m) return undefined;
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), ms);
  // Two passes: the offset at the guess can differ from the offset at the answer around a switch.
  let epoch = wall - amsterdamOffsetMinutes(wall - 60 * 60_000) * 60_000;
  epoch = wall - amsterdamOffsetMinutes(epoch) * 60_000;
  return epoch;
}

/** The Dutch calendar day of an instant: "2026-10-25T23:30:00Z" → "2026-10-26". */
export function amsterdamDay(iso: string | number | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date(t));
}

/** A plenary sitting never begins before this hour; a debate starting earlier is the night of the previous day's sitting. */
const NACHT_GRENS_MS = 6 * 60 * 60_000;

type DebateWhere = Pick<GehoordDebateRef, "hall" | "locationId" | "startsAt" | "startedAt">;

/** The debate's start: the real one (startedAt), else the agenda time (startsAt). */
export function debatStart(debate: Pick<GehoordDebateRef, "startsAt" | "startedAt">): string | undefined {
  return debate.startedAt ?? debate.startsAt;
}

/**
 * The day of the vergadering a Gehoord debate belongs to, for the lookup in
 * the Gegevensmagazijn. A plenary sitting that runs past midnight stays the
 * vergadering of the day it began (the verslag of 14 Oct 2026 runs to 01:15 on
 * the 15th), so a plenary debate that starts after midnight but before
 * NACHT_GRENS_MS belongs to the previous day.
 */
export function vergaderDag(debate: DebateWhere, fallback?: string): string | undefined {
  const t = Date.parse(debatStart(debate) ?? fallback ?? "");
  if (!Number.isFinite(t)) return undefined;
  return amsterdamDay(isPlenair(debate) ? t - NACHT_GRENS_MS : t);
}

/** The meeting day in a Debat Direct url: "https://debatdirect.tweedekamer.nl/2026-10-28/..." → "2026-10-28". */
export function debatDirectDag(url: string | undefined): string | undefined {
  const m = /^https?:\/\/debatdirect\.tweedekamer\.nl\/(\d{4}-\d{2}-\d{2})(?:[/?#]|$)/i.exec(url ?? "");
  return m?.[1];
}

/**
 * The days whose vergaderingen may hold a debate's activiteit: the day in its
 * Debat Direct url, else vergaderDag; for a plenary debate after midnight
 * vergaderDag adds the day before (a night sitting is the vergadering of the
 * day it began). Each day once.
 */
export function debatDagen(debate: DebateWhere & Pick<GehoordDebateRef, "url">, fallback?: string): string[] {
  const days = [debatDirectDag(debate.url), vergaderDag(debate, fallback)].filter((d): d is string => Boolean(d));
  return [...new Set(days)];
}

/** "14:25" in Amsterdam time. */
function amsterdamClock(epochMs: number): string {
  return new Intl.DateTimeFormat("nl-NL", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" }).format(new Date(epochMs));
}

/* ------------------------------------------------------------------ */
/*  Matching                                                           */
/* ------------------------------------------------------------------ */

/** A zaal as one key, accents, case and separators gone: "Klompézaal" and 'klompezaal' → klompezaal. */
export function zaalKey(zaal: string | undefined): string {
  return foldText(zaal ?? "").replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The Gegevensmagazijn Zaal against Gehoord's locationId (the stable key), else its hall. */
export function sameZaal(zaal: string | undefined, debate: Pick<GehoordDebateRef, "hall" | "locationId">): boolean {
  const key = zaalKey(zaal);
  if (!key) return false;
  return debate.locationId ? key === zaalKey(debate.locationId) : key === zaalKey(debate.hall);
}

export function isPlenaireZaal(hall: string | undefined): boolean {
  return /^plenaire\s*zaal$/i.test((hall ?? "").trim());
}

/** A debate in the plenary hall: locationId 'plenaire-zaal', else the hall's name. */
export function isPlenair(debate: Pick<GehoordDebateRef, "hall" | "locationId">): boolean {
  return debate.locationId ? zaalKey(debate.locationId) === "plenairezaal" : isPlenaireZaal(debate.hall);
}

/**
 * The vergadering of a Gehoord debate among the vergaderingen of its day: the
 * plenary hall is the Plenair vergadering (the latest that began before the
 * hit when there are several); any other hall a Commissie vergadering in that
 * zaal (locationId, else hall) starting closest to the debate's start
 * (startedAt, else startsAt), within KOPPELING_START_WINDOW_MS.
 */
export function matchVergadering(
  debate: DebateWhere,
  vergaderingen: DebatVergadering[],
  hitEpoch?: number,
): DebatVergadering | undefined {
  if (isPlenair(debate)) {
    const plenair = vergaderingen.filter((v) => v.soort === "Plenair");
    if (plenair.length <= 1 || hitEpoch === undefined) return plenair[0];
    const started = plenair
      .map((v) => ({ v, t: Date.parse(v.aanvangstijd ?? "") }))
      .filter((x) => Number.isFinite(x.t) && x.t <= hitEpoch + KOPPELING_TOLERANCE_MS)
      .sort((a, b) => b.t - a.t);
    return started[0]?.v ?? plenair[0];
  }
  const start = Date.parse(debatStart(debate) ?? "");
  if (!Number.isFinite(start)) return undefined;
  return vergaderingen
    .filter((v) => v.soort === "Commissie" && sameZaal(v.zaal, debate))
    .map((v) => ({ v, d: Math.abs(Date.parse(v.aanvangstijd ?? "") - start) }))
    .filter((x) => Number.isFinite(x.d) && x.d <= KOPPELING_START_WINDOW_MS)
    .sort((a, b) => a.d - b.d)[0]?.v;
}

/** How far an instant lies outside a vergadering's span [Aanvangstijd, Eindtijd] (open while Eindtijd is empty); NaN without a start. */
function afstandTotVergadering(v: DebatVergadering, t: number): number {
  const start = Date.parse(v.aanvangstijd ?? "");
  if (!Number.isFinite(start)) return Number.NaN;
  if (t < start) return start - t;
  const end = Date.parse(v.eindtijd ?? "");
  return Number.isFinite(end) && t > end ? t - end : 0;
}

/**
 * The vergaderingen whose verslag may hold a debate's activiteit, in the
 * order to read them: the zaal-and-time match first; plenary, the other
 * Plenair vergaderingen of its days; otherwise the Commissie vergaderingen in
 * the same zaal, then those in another zaal, each only when the debate starts
 * within KOPPELING_START_WINDOW_MS of its span, nearest first.
 */
export function debatKandidaten(debate: DebateWhere, vergaderingen: DebatVergadering[], primary?: DebatVergadering): DebatVergadering[] {
  const out: DebatVergadering[] = primary ? [primary] : [];
  const add = (v: DebatVergadering) => {
    if (!out.some((x) => x.vergadering_id === v.vergadering_id)) out.push(v);
  };
  if (isPlenair(debate)) {
    for (const v of vergaderingen) if (v.soort === "Plenair") add(v);
    return out;
  }
  const start = Date.parse(debatStart(debate) ?? "");
  if (!Number.isFinite(start)) return out;
  const near = vergaderingen
    .filter((v) => v.soort === "Commissie")
    .map((v) => ({ v, d: afstandTotVergadering(v, start), zelfde: sameZaal(v.zaal, debate) }))
    .filter((x) => Number.isFinite(x.d) && x.d <= KOPPELING_START_WINDOW_MS)
    .sort((a, b) => Number(b.zelfde) - Number(a.zelfde) || a.d - b.d);
  for (const { v } of near) add(v);
  return out;
}

/** The innermost activiteit whose block holds this fragment (its index in verslag.fragments). */
export function activiteitVanFragment(verslag: Pick<DebatVerslag, "activiteiten">, index: number): DebatActiviteit | undefined {
  let best: DebatActiviteit | undefined;
  for (const a of verslag.activiteiten ?? []) {
    if (index >= a.fragmentVan && index < a.fragmentTot && (!best || a.fragmentTot - a.fragmentVan <= best.fragmentTot - best.fragmentVan)) best = a;
  }
  return best;
}

interface Interval {
  start: number;
  end: number;
}

/** The fragments' times as epoch intervals; a missing eind ends at the next fragment's begin (or is a point). */
export function fragmentIntervals(fragments: DebatFragment[]): Array<Interval | undefined> {
  const begins = fragments.map((f) => amsterdamLocalToEpoch(f.begin));
  const sortedBegins = begins.filter((b): b is number => b !== undefined).sort((a, b) => a - b);
  return fragments.map((f, i) => {
    const start = begins[i];
    if (start === undefined) return undefined;
    let end = amsterdamLocalToEpoch(f.eind);
    if (end === undefined || end < start) end = sortedBegins.find((b) => b > start) ?? start;
    return { start, end };
  });
}

/** The latest moment the verslag covers. */
export function verslagReach(intervals: Array<Interval | undefined>): number | undefined {
  let max: number | undefined;
  for (const iv of intervals) if (iv && (max === undefined || iv.end > max)) max = iv.end;
  return max;
}

/**
 * The official fragment of this person that overlaps the hit most, each
 * fragment widened by the tolerance on both sides. A boundary shared with the
 * previous fragment does not win over the real overlap.
 */
export function bestFragment(
  hit: { persoonId: string; start: number; end: number },
  fragments: DebatFragment[],
  intervals: Array<Interval | undefined>,
  toleranceMs = KOPPELING_TOLERANCE_MS,
): { fragment: DebatFragment; overlapMs: number; positie: number } | undefined {
  const who = hit.persoonId.toLowerCase();
  let best: { fragment: DebatFragment; overlapMs: number; positie: number; score: number } | undefined;
  fragments.forEach((f, i) => {
    const iv = intervals[i];
    if (!iv || !f.persoon_id || f.persoon_id.toLowerCase() !== who) return;
    const lo = Math.max(hit.start, iv.start - toleranceMs);
    const hi = Math.min(hit.end, iv.end + toleranceMs);
    if (hi < lo) return;
    // A point hit (no end) inside the widened fragment scores 0 but still counts.
    const score = hi - lo;
    if (!best || score > best.score) {
      const real = Math.max(0, Math.min(hit.end, iv.end) - Math.max(hit.start, iv.start));
      const span = iv.end - iv.start;
      const middle = (hit.start + hit.end) / 2;
      const positie = span > 0 ? Math.min(1, Math.max(0, (middle - iv.start) / span)) : 0;
      best = { fragment: f, overlapMs: real, positie, score };
    }
  });
  return best ? { fragment: best.fragment, overlapMs: best.overlapMs, positie: best.positie } : undefined;
}

/* ------------------------------------------------------------------ */
/*  The linker                                                         */
/* ------------------------------------------------------------------ */

export interface KoppelingDeps {
  debatten: Pick<TweedeKamerDebattenSource, "vergaderingenOp" | "getVerslag">;
  now?: () => number;
  maxDagen?: number;
  maxVerslagen?: number;
  deadlineMs?: number;
}

export interface KoppelingResult {
  koppelingen: Koppeling[];
  counts: Record<KoppelingStatus, number>;
  /** Verslagen read (from cache or the network). */
  verslagen: number;
  /** Epoch ms when the deadline of this koppeling ends: what comes after it (the debate pages) uses the rest. */
  deadlineAt: number;
}

class Deadline extends Error {}

function withDeadline<T>(promise: Promise<T>, deadline: Promise<never>): Promise<T> {
  return Promise.race([promise, deadline]);
}

function short(error: unknown): string {
  if (error instanceof Deadline) return "time-out";
  const msg = error instanceof Error ? error.message : String(error);
  return msg.replace(/\s+/g, " ").slice(0, 120);
}

/** The debate id to look for in the verslagen: a GUID tkDebateId, for a speaker with a TK Persoon id (else nothing could be matched). */
function debatIdVan(c: GehoordContribution): string | undefined {
  const id = c.debate.tkDebateId?.trim();
  return id && GUID_RE.test(id) && GUID_RE.test(c.persoonId) ? id.toLowerCase() : undefined;
}

/** A debate that will have no verslag with text: its type says so, or Gehoord marks it cancelled. */
function zonderVerslag(c: GehoordContribution): boolean {
  const type = c.debate.debateType?.toLowerCase();
  return Boolean(type && GEEN_VERSLAG_TYPES.has(type)) || c.debate.status === "cancelled";
}

/** The status of a hit whose debate has no vergadering (with a verslag) to read: its type, status and date decide. */
function zonderVergadering(c: GehoordContribution, nowMs: number): Koppeling {
  const type = c.debate.debateType;
  const status = c.debate.status;
  const plenair = isPlenair(c.debate);
  const startMs = Date.parse(debatStart(c.debate) ?? c.startTime ?? "");
  const ageDays = Number.isFinite(startMs) ? (nowMs - startMs) / 86_400_000 : 0;
  if (type && GEEN_VERSLAG_TYPES.has(type.toLowerCase())) {
    return { status: "geen_verslag_verwacht", reden: `een ${type.toLowerCase()} krijgt geen verslag met tekst in het Gegevensmagazijn` };
  }
  if (status === "cancelled") {
    return { status: "geen_verslag_verwacht", reden: "Gehoord.de meldt dit debat als geschrapt (cancelled): het is niet doorgegaan" };
  }
  if (status === "live" || ageDays <= KOPPELING_RECENT_DAYS) {
    return {
      status: "nog_geen_verslag",
      reden: status === "live"
        ? "het debat is nog bezig; het verslag volgt"
        : plenair
          ? "nog geen verslag van deze plenaire vergadering"
          : "nog geen verslag van dit debat (een commissiedebat krijgt het na 2 tot 12 dagen)",
    };
  }
  return { status: "niet_gekoppeld", reden: `geen vergadering met verslag gevonden${plenair ? " (plenaire zaal)" : ` in de ${c.debate.hall ?? "zaal"} rond het begin van het debat`}` };
}

/**
 * The fragment of this hit among fragments[van .. tot - 1] of a verslag (the
 * whole verslag, or the block of the debate's activiteit), with the status
 * when there is none: a verslag that may still grow and does not reach the
 * moment yet is nog_geen_verslag.
 */
function koppelFragment(
  c: GehoordContribution,
  v: DebatVergadering,
  verslag: DebatVerslag,
  intervals: Array<Interval | undefined>,
  scope: { methode: KoppelingMethode; van: number; tot: number; activiteit?: DebatActiviteit },
): Koppeling {
  const start = amsterdamLocalToEpoch(c.startTime) as number;
  const end = Math.max(start, amsterdamLocalToEpoch(c.endTime) ?? start);
  const meta = { verslag_id: verslag.verslag_id, status: verslag.status ?? v.verslag_status, publicatie: verslag.publicatie ?? v.verslag_soort };
  const best = bestFragment({ persoonId: c.persoonId, start, end }, verslag.fragments.slice(scope.van, scope.tot), intervals.slice(scope.van, scope.tot));
  const base = { methode: scope.methode, vergadering: v, verslag: meta };
  if (best) {
    const activiteit = scope.activiteit ?? activiteitVanFragment(verslag, best.fragment.volgnummer - 1);
    return {
      status: "officieel",
      ...base,
      ...(activiteit ? { activiteit: activiteitRef(activiteit) } : {}),
      fragment: best.fragment,
      overlap_s: Math.round(best.overlapMs / 1000),
      positie: best.positie,
    };
  }
  const activiteit = scope.activiteit ? { activiteit: activiteitRef(scope.activiteit) } : {};
  const reach = verslagReach(intervals);
  // Only a verslag that may still grow promises more: not an eindpublicatie, not one that holds the Sluiting.
  const complete = meta.publicatie === "Eindpublicatie" || Boolean(verslag.sluiting);
  if (!complete && (reach === undefined || reach + KOPPELING_TOLERANCE_MS < start)) {
    return {
      status: "nog_geen_verslag",
      ...base,
      ...activiteit,
      reden: reach === undefined ? "het verslag bevat nog geen tekst" : `het verslag (${meta.publicatie ?? "publicatie"}) loopt nog maar tot ${amsterdamClock(reach)}; dit fragment is van ${amsterdamClock(start)}`,
    };
  }
  const afloop = complete && reach !== undefined && reach + KOPPELING_TOLERANCE_MS < start ? ` (het verslag is compleet en loopt tot ${amsterdamClock(reach)}; dit fragment is van ${amsterdamClock(start)})` : "";
  const waar = scope.activiteit ? "in dit debat in het verslag" : "in het verslag";
  return { status: "niet_gekoppeld", ...base, ...activiteit, reden: `geen fragment van deze spreker rond dit tijdstip ${waar}${afloop}` };
}

/** Whether the hit runs outside the activiteit's span [aanvang, eind], beyond the tolerance (an open end bounds nothing). */
function buitenActiviteit(c: GehoordContribution, a: DebatActiviteit): boolean {
  const start = amsterdamLocalToEpoch(c.startTime) as number;
  const end = Math.max(start, amsterdamLocalToEpoch(c.endTime) ?? start);
  const aanvang = amsterdamLocalToEpoch(a.aanvang);
  const eind = amsterdamLocalToEpoch(a.eind);
  return (aanvang !== undefined && start < aanvang - KOPPELING_TOLERANCE_MS) || (eind !== undefined && end > eind + KOPPELING_TOLERANCE_MS);
}

function activiteitRef(a: DebatActiviteit): NonNullable<Koppeling["activiteit"]> {
  return { objectid: a.objectid, parlisid: a.parlisid, titel: a.titel, soort: a.soort };
}

/**
 * Links the Tweede Kamer hits to their official fragments. Returns one
 * Koppeling per contribution, in the same order. Never throws.
 */
export async function koppelGehoord(contributions: GehoordContribution[], deps: KoppelingDeps): Promise<KoppelingResult> {
  const maxDagen = deps.maxDagen ?? KOPPELING_MAX_DAGEN;
  const maxVerslagen = deps.maxVerslagen ?? KOPPELING_MAX_VERSLAGEN;
  const now = deps.now ?? Date.now;
  const out: Koppeling[] = new Array(contributions.length);
  let verslagen = 0;
  const deadlineMs = deps.deadlineMs ?? KOPPELING_DEADLINE_MS;
  const deadlineAt = Date.now() + deadlineMs;
  // Each request gets the time left, at least a second, and no retry: a request the deadline gave up on must not hold a slot.
  const budget = () => ({ timeoutMs: Math.max(1_000, deadlineAt - Date.now()), retries: 0 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Deadline("time-out"));
    }, deadlineMs);
  });
  deadline.catch(() => undefined);

  try {
    // 1. What needs no lookup: the Eerste Kamer, a hit without a time. A speaker without a
    //    TK Persoon id (a guest at a briefing) still gets the status of the debate. A hit
    //    with a debate id may also look on the day of its Debat Direct url and, for a night
    //    sitting, the day before, when the day budget allows.
    const todo: number[] = [];
    const dayOf = (c: GehoordContribution) => vergaderDag(c.debate, c.startTime) as string;
    const days: string[] = [];
    const dagenVan = new Map<number, string[]>();
    contributions.forEach((c, i) => {
      if (c.debate.chamber === "ek") {
        out[i] = { status: "eerste_kamer", reden: "De Eerste Kamer heeft geen verslag in het Gegevensmagazijn; citeer uit de Handelingen (officiele_bekendmakingen_search, type Handelingen)." };
      } else if (c.debate.chamber !== "tk") {
        out[i] = { status: "niet_gekoppeld", reden: `onbekende kamer '${c.debate.chamber}'` };
      } else if (amsterdamLocalToEpoch(c.startTime) === undefined) {
        out[i] = { status: "niet_gekoppeld", reden: "fragment zonder tijdstip" };
      } else {
        const day = dayOf(c);
        if (!days.includes(day)) {
          if (days.length >= maxDagen) {
            out[i] = { status: "niet_gekoppeld", reden: `limiet: per aanroep worden de vergaderingen van hooguit ${maxDagen} dagen opgezocht` };
            return;
          }
          days.push(day);
        }
        todo.push(i);
        if (debatIdVan(c)) {
          const own = debatDagen(c.debate, c.startTime).filter((d) => {
            if (days.includes(d)) return true;
            if (days.length >= maxDagen) return false;
            days.push(d);
            return true;
          });
          dagenVan.set(i, own);
        }
      }
    });

    // 2. The vergaderingen of each day, once per day, side by side.
    const perDay = new Map<string, DebatVergadering[] | Error>();
    await Promise.all(
      days.map(async (day) => {
        try {
          perDay.set(day, await withDeadline(deps.debatten.vergaderingenOp(day, budget()), deadline));
        } catch (error) {
          perDay.set(day, error instanceof Error ? error : new Error(String(error)));
        }
      }),
    );

    // 3. Each hit to its vergadering by zaal and time; a hit with a debate id also to the
    //    vergaderingen whose verslag may hold its activiteit, that one first.
    const vergaderingOf = new Map<number, DebatVergadering>();
    const kandidaten = new Map<number, DebatVergadering[]>();
    for (const i of todo) {
      const c = contributions[i];
      const list = perDay.get(dayOf(c));
      if (list instanceof Error) {
        out[i] = { status: "niet_gekoppeld", reden: `vergaderingen niet opgehaald: ${short(list)}` };
        continue;
      }
      const v = matchVergadering(c.debate, list ?? [], amsterdamLocalToEpoch(c.startTime));
      if (v) vergaderingOf.set(i, v);
      const own = dagenVan.get(i);
      if (own) {
        // A debate without a verslag with text spends no extra verslag on its id.
        const all = own.flatMap((d) => {
          const l = perDay.get(d);
          return Array.isArray(l) ? l : [];
        });
        kandidaten.set(i, zonderVerslag(c) ? (v ? [v] : []) : debatKandidaten(c.debate, all, v));
      }
    }

    // 4. The verslagen, at most maxVerslagen, each once, side by side. First the zaal-and-time
    //    vergadering of each hit; then, while the budget lasts, the next candidate of each
    //    debate id not found yet. A speaker
    //    without a TK Persoon id cannot be linked: that hit spends no verslag.
    const loaded = new Map<string, DebatVerslag | Error>();
    const attempted = new Set<string>();
    const vergaderingVan = new Map<string, DebatVergadering>();
    const gevonden = new Map<string, { verslagId: string; activiteit: DebatActiviteit }>();
    const load = async (list: DebatVergadering[]) => {
      for (const v of list) {
        attempted.add(v.verslag_id);
        vergaderingVan.set(v.verslag_id, v);
      }
      await Promise.all(
        list.map(async (v) => {
          try {
            const verslag = await withDeadline(deps.debatten.getVerslag(v, budget()), deadline);
            loaded.set(v.verslag_id, verslag);
            for (const a of verslag.activiteiten ?? []) {
              const key = a.objectid.toLowerCase();
              if (!gevonden.has(key)) gevonden.set(key, { verslagId: v.verslag_id, activiteit: a });
            }
          } catch (error) {
            loaded.set(v.verslag_id, error instanceof Error ? error : new Error(String(error)));
          }
        }),
      );
    };
    const first: DebatVergadering[] = [];
    for (const i of todo) {
      // Only the zaal-and-time vergaderingen: a speculative candidate must not take the slot of another hit's verslag.
      const v = GUID_RE.test(contributions[i].persoonId) ? vergaderingOf.get(i) : undefined;
      if (v && !first.some((x) => x.verslag_id === v.verslag_id) && first.length < maxVerslagen) first.push(v);
    }
    await load(first);
    while (attempted.size < maxVerslagen && !timedOut) {
      const next: DebatVergadering[] = [];
      for (const [i, list] of kandidaten) {
        if (gevonden.has(debatIdVan(contributions[i]) as string)) continue;
        const v = list.find((x) => !attempted.has(x.verslag_id));
        if (v && !next.some((x) => x.verslag_id === v.verslag_id)) next.push(v);
      }
      if (!next.length) break;
      await load(next.slice(0, maxVerslagen - attempted.size));
    }
    verslagen = [...loaded.values()].filter((v) => !(v instanceof Error)).length;

    // 5. Each hit: inside its debate's activiteit when the id was found (debat_id), else
    //    across the verslag of its zaal-and-time vergadering (zaal_tijd), else its status.
    const intervalCache = new Map<string, Array<Interval | undefined>>();
    const intervalsOf = (verslag: DebatVerslag) => {
      let intervals = intervalCache.get(verslag.verslag_id);
      if (!intervals) {
        intervals = fragmentIntervals(verslag.fragments);
        intervalCache.set(verslag.verslag_id, intervals);
      }
      return intervals;
    };
    for (const i of todo) {
      if (out[i]) continue;
      const c = contributions[i];
      const id = debatIdVan(c);
      const hit = id ? gevonden.get(id) : undefined;
      const hitVerslag = hit ? loaded.get(hit.verslagId) : undefined;
      if (hit && hitVerslag && !(hitVerslag instanceof Error)) {
        const a = hit.activiteit;
        const hv = vergaderingVan.get(hit.verslagId) as DebatVergadering;
        const k = koppelFragment(c, hv, hitVerslag, intervalsOf(hitVerslag), { methode: "debat_id", van: a.fragmentVan, tot: a.fragmentTot, activiteit: a });
        // Gehoord's debate boundaries are not VLOS's (the Stemmingen after a debate, say): a hit that
        // runs outside its activiteit's span and is not in it is looked for in the whole verslag.
        out[i] = k.status !== "officieel" && buitenActiviteit(c, a)
          ? koppelFragment(c, hv, hitVerslag, intervalsOf(hitVerslag), { methode: "debat_id", van: 0, tot: hitVerslag.fragments.length })
          : k;
        continue;
      }
      const v = vergaderingOf.get(i);
      if (!v) {
        // No zaal-and-time vergadering and the id not found (in the candidates the budget reached): as before the id.
        out[i] = zonderVergadering(c, now());
        continue;
      }
      if (!GUID_RE.test(c.persoonId)) {
        out[i] = { status: "niet_gekoppeld", methode: "zaal_tijd", vergadering: v, reden: "spreker zonder persoon-id van de Tweede Kamer" };
        continue;
      }
      if (!attempted.has(v.verslag_id)) {
        out[i] = { status: "niet_gekoppeld", methode: "zaal_tijd", vergadering: v, reden: `limiet: per aanroep worden hooguit ${maxVerslagen} verslagen gelezen` };
        continue;
      }
      const verslag = loaded.get(v.verslag_id);
      if (!verslag || verslag instanceof Error) {
        out[i] = { status: "niet_gekoppeld", methode: "zaal_tijd", vergadering: v, reden: `verslag niet gelezen: ${short(verslag)}` };
        continue;
      }
      out[i] = koppelFragment(c, v, verslag, intervalsOf(verslag), { methode: "zaal_tijd", van: 0, tot: verslag.fragments.length });
    }
  } catch (error) {
    logger.warn({ err: short(error) }, "debat-koppeling failed");
  } finally {
    if (timer) clearTimeout(timer);
  }

  for (let i = 0; i < out.length; i++) out[i] ??= { status: "niet_gekoppeld", reden: "koppeling mislukt" };
  const counts: Record<KoppelingStatus, number> = { officieel: 0, nog_geen_verslag: 0, geen_verslag_verwacht: 0, eerste_kamer: 0, niet_gekoppeld: 0 };
  for (const k of out) counts[k.status] += 1;
  return { koppelingen: out, counts, verslagen, deadlineAt };
}

const STATUS_LABEL: Record<KoppelingStatus, string> = {
  officieel: "officieel",
  nog_geen_verslag: "nog geen verslag",
  geen_verslag_verwacht: "geen verslag verwacht",
  eerste_kamer: "Eerste Kamer",
  niet_gekoppeld: "niet gekoppeld",
};

/** "6 officieel, 2 nog geen verslag, 1 Eerste Kamer". */
export function koppelingCounts(counts: Record<KoppelingStatus, number>): string {
  return (Object.keys(STATUS_LABEL) as KoppelingStatus[])
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${STATUS_LABEL[s]}`)
    .join(", ");
}
