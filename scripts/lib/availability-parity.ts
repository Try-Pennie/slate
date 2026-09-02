// The comparison behind `pnpm verify:availability-parity` (#1731). Pure: no
// network, no clock, no database, so `scripts/test-availability-parity.ts` can
// drive every verdict offline.
//
// The question it answers is NOT "is Slate correct" (that is the truth probe,
// which asks Google, the actual source of truth for whether a time is free). It
// is "does Slate agree with the system taking real bookings today", which is a
// check on CONFIGURATION: working hours, bucket membership, business hours, a
// calendar that never connected. Those are the things that make Slate quietly
// offer a different week than cal.com does, and none of them are visible from
// inside Slate alone.
import { DateTime } from "luxon";

export interface ParityInput {
  /** Instants cal.com offers, already flattened by `parseCalcomSlots`. */
  calcomSlots: string[];
  /** Instants Slate offers (`/api/availability` returns a flat ISO array). */
  slateSlots: string[];
  /** The zone days and hours are bucketed in. Comparing in UTC would report a
   *  false hours mismatch every day of the year. */
  zone: string;
}

export type ParityVerdict =
  /** The same local hours are open in both systems. */
  | "agree"
  /** Hours cal.com offers that Slate does not. The finding Phase 1 exists for. */
  | "slate-under-offers"
  /** Hours Slate offers that cal.com does not, usually a cal.com out of office. */
  | "slate-over-offers"
  /** cal.com offers a week and Slate offers nothing at all. */
  | "slate-offers-nothing"
  /** Slate offers and cal.com does not: cannot compare, and never Slate's fault. */
  | "calcom-offers-nothing"
  /** Both empty. Perfect agreement, zero information, never a pass (L98). */
  | "neither-offers"
  /** The two answers cover no day in common, so nothing could be compared. */
  | "no-shared-days";

/** Hours open on one day in one system but not the other. */
export interface DayGap {
  day: string;
  hours: number[];
}

export interface ParityResult {
  verdict: ParityVerdict;
  missingInSlate: DayGap[];
  missingInCalcom: DayGap[];
  /** Days inside the shared reach that BOTH systems answered for. The hour
   *  comparison can only say anything about these, so it is the honest
   *  denominator for the report. */
  daysCompared: number;
  /** The day range both systems answered within, or null when they share none. */
  sharedFrom: string | null;
  sharedTo: string | null;
  /** Days each system reached BEYOND the shared range. Excluded from the gaps and
   *  reported on their own: they are a horizon difference, not an hours finding. */
  calcomOnlyDays: string[];
  slateOnlyDays: string[];
}

type CalcomSlot = { start?: unknown };

/**
 * Flatten cal.com's `{ "YYYY-MM-DD": [{ start }] }` into a list of instants.
 *
 * Refuses anything it cannot read rather than returning what it managed to
 * salvage. A partially parsed payload yields FEWER slots, which is
 * indistinguishable from cal.com genuinely offering fewer, and would be reported
 * as Slate over-offering: a finding about our own parser wearing the costume of a
 * finding about the roster.
 */
export function parseCalcomSlots(
  data: unknown,
): { ok: true; slots: string[] } | { ok: false; why: string } {
  if (data === null || typeof data !== "object") {
    return { ok: false, why: "the slots payload is not an object" };
  }
  if (Array.isArray(data)) {
    return { ok: false, why: "the slots payload is an array; the contract is an object keyed by date" };
  }
  const slots: string[] = [];
  for (const [date, value] of Object.entries(data as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      return { ok: false, why: `the value for ${date} is not a list of slots` };
    }
    for (const entry of value as CalcomSlot[]) {
      const start = entry?.start;
      if (typeof start !== "string") {
        return { ok: false, why: `a slot on ${date} carries no readable start` };
      }
      // A string that is not a readable instant is refused HERE rather than left
      // to be dropped during bucketing. A dropped instant is a smaller answer,
      // which is indistinguishable from cal.com genuinely offering less, and would
      // be reported as Slate over-offering: a finding about the payload wearing the
      // costume of a finding about the roster (L340).
      if (!DateTime.fromISO(start).isValid) {
        return { ok: false, why: `a slot on ${date} carries an unreadable start: ${start}` };
      }
      slots.push(start);
    }
  }
  return { ok: true, slots };
}

/**
 * Read the slot list out of Slate's `/api/availability` body.
 *
 * The mirror of `parseCalcomSlots`, and refusing for the same reason in the
 * opposite direction: filtering out an entry it cannot read would make Slate's
 * answer SMALLER, and a smaller Slate answer is reported as Slate under-offering,
 * which is the headline finding this probe exists to make. A defect in our own
 * reading would then arrive dressed as a defect in the roster (L340). A missing or
 * non-array `slots` is refused too, because collapsing it to an empty list is the
 * `slate-offers-nothing` verdict, which is a real and very different finding.
 */
export function parseSlateSlots(
  body: unknown,
): { ok: true; slots: string[] } | { ok: false; why: string } {
  if (body === null || typeof body !== "object") {
    return { ok: false, why: "the availability body is not an object" };
  }
  const slots = (body as { slots?: unknown }).slots;
  if (!Array.isArray(slots)) {
    return { ok: false, why: "the availability body carries no slots array" };
  }
  for (const entry of slots as unknown[]) {
    if (typeof entry !== "string") {
      return { ok: false, why: `a slot is not a string: ${JSON.stringify(entry)}` };
    }
    if (!DateTime.fromISO(entry).isValid) {
      return { ok: false, why: `a slot is not a readable instant: ${entry}` };
    }
  }
  return { ok: true, slots: slots as string[] };
}

/**
 * Group instants into the local hours they fall in.
 *
 * The hour, not the minute, is the unit of comparison: cal.com offers the review
 * event every 10 minutes and Slate offers on its own interval, so equal minutes
 * were never going to happen and demanding them would produce a permanently red
 * check. An hour either system offers anything in is an hour it considers open,
 * which survives every interval, duration and buffer difference between them.
 */
export function bucketByDayHour(slots: string[], zone: string): Map<string, Set<number>> {
  const byDay = new Map<string, Set<number>>();
  for (const iso of slots) {
    const dt = DateTime.fromISO(iso, { zone });
    // An unreadable instant is dropped, never bucketed: `Date.parse` returning NaN
    // lands every comparison on the permissive branch (L: parse-ok convention), and
    // an hour of NaN would read as an hour neither system offers.
    if (!dt.isValid) continue;
    const day = dt.toFormat("yyyy-MM-dd");
    let hours = byDay.get(day);
    if (!hours) byDay.set(day, (hours = new Set<number>()));
    hours.add(dt.hour);
  }
  return byDay;
}

function gapsBetween(
  a: Map<string, Set<number>>,
  b: Map<string, Set<number>>,
): DayGap[] {
  const gaps: DayGap[] = [];
  for (const [day, hours] of a) {
    const other = b.get(day);
    const missing = [...hours].filter((h) => !other?.has(h)).sort((x, y) => x - y);
    if (missing.length > 0) gaps.push({ day, hours: missing });
  }
  return gaps.sort((x, y) => x.day.localeCompare(y.day));
}

/** The first and last day a system answered for, or null when it answered for none. */
function span(days: Iterable<string>): { from: string; to: string } | null {
  const sorted = [...days].sort();
  if (sorted.length === 0) return null;
  return { from: sorted[0], to: sorted[sorted.length - 1] };
}

/**
 * Restrict a system's answer to the days inside `[from, to]`.
 *
 * Everything outside is a HORIZON difference, and the reasoning is measured rather
 * than assumed: against live cal.com on 2026-09-02 its pool reached about two days
 * ahead while Slate's booking horizon runs much further, so comparing over a fixed
 * week would report Slate offering more on every run forever, which is the
 * always-red check this module exists not to be (L36).
 *
 * It clips by RANGE, not by which days each system happens to hold. Clipping to the
 * shared day SET would excuse the finding that matters most: a day sitting inside
 * both systems' reach that one of them offers nothing on.
 */
function within(
  byDay: Map<string, Set<number>>,
  from: string,
  to: string,
): { inside: Map<string, Set<number>>; outside: string[] } {
  const inside = new Map<string, Set<number>>();
  const outside: string[] = [];
  for (const [day, hours] of byDay) {
    if (day >= from && day <= to) inside.set(day, hours);
    else outside.push(day);
  }
  return { inside, outside: outside.sort() };
}

export function compareCoverage(input: ParityInput): ParityResult {
  const calcom = bucketByDayHour(input.calcomSlots, input.zone);
  const slate = bucketByDayHour(input.slateSlots, input.zone);

  const empty = {
    missingInSlate: [] as DayGap[],
    missingInCalcom: [] as DayGap[],
    daysCompared: 0,
    sharedFrom: null,
    sharedTo: null,
    calcomOnlyDays: [] as string[],
    slateOnlyDays: [] as string[],
  };

  // The three "nothing to compare" states come FIRST and each says something
  // different, because collapsing any two of them sends the reader after the wrong
  // thing: an empty Slate is a roster problem, an empty cal.com is not ours, and
  // two empties are a run that measured nothing (L11).
  if (calcom.size === 0 && slate.size === 0) return { verdict: "neither-offers", ...empty };
  if (slate.size === 0) return { verdict: "slate-offers-nothing", ...empty };
  if (calcom.size === 0) return { verdict: "calcom-offers-nothing", ...empty };

  const calSpan = span(calcom.keys())!;
  const slateSpan = span(slate.keys())!;
  const sharedFrom = calSpan.from > slateSpan.from ? calSpan.from : slateSpan.from;
  const sharedTo = calSpan.to < slateSpan.to ? calSpan.to : slateSpan.to;
  // Two answers that overlap on no day compare nothing at all, which is a run that
  // measured nothing rather than a run that found agreement (L98).
  if (sharedFrom > sharedTo) {
    return {
      verdict: "no-shared-days",
      ...empty,
      calcomOnlyDays: [...calcom.keys()].sort(),
      slateOnlyDays: [...slate.keys()].sort(),
    };
  }

  const cal = within(calcom, sharedFrom, sharedTo);
  const sl = within(slate, sharedFrom, sharedTo);
  const missingInSlate = gapsBetween(cal.inside, sl.inside);
  const missingInCalcom = gapsBetween(sl.inside, cal.inside);
  let daysCompared = 0;
  for (const day of cal.inside.keys()) if (sl.inside.has(day)) daysCompared++;

  const result = {
    missingInSlate,
    missingInCalcom,
    daysCompared,
    sharedFrom,
    sharedTo,
    calcomOnlyDays: cal.outside,
    slateOnlyDays: sl.outside,
  };

  // Under-offering outranks over-offering when both are present. Slate offering
  // less costs a lead a bookable time, which is the failure this phase is watching
  // for; Slate offering more is usually cal.com holding an out of office. Both are
  // always reported, so ranking decides only which one names the run.
  if (missingInSlate.length > 0) return { verdict: "slate-under-offers", ...result };
  if (missingInCalcom.length > 0) return { verdict: "slate-over-offers", ...result };
  return { verdict: "agree", ...result };
}

/** One agent's calendar readiness, as read from `agent_calendars`. */
export interface AgentReadiness {
  userId: string;
  /** An `agent_calendars` row exists at all. */
  hasCalendar: boolean;
  /** `sync_window_to` as epoch ms; null when never hydrated OR unreadable. */
  syncWindowToMs: number | null;
}

/**
 * Whether a bucket's pool is hydrated enough for a comparison to mean anything.
 *
 * An agent flipped bookable holds NO cached busy time until the watch lane has
 * discovered their calendar and the sync lane has hydrated it (#1736). Until then
 * the cache-first booker sees them as free for every hour their working hours
 * allow, so a parity run taken during that drain measures the drain and reports it
 * as Slate over-offering: a finding about our own timing dressed as a finding about
 * the roster.
 *
 * The remedy could have been a sentence in the runbook saying to wait. A rule that
 * lives only in an instruction is a hope (L27), and this one would be read exactly
 * once, by whoever is most eager to see the first numbers after the flip. So the
 * probe refuses instead.
 *
 * A null window is NOT ready, matching `calendar-window-coverage`'s own reasoning:
 * no recorded coverage is precisely the state worth noticing, and an unreadable
 * stamp scored as fine is the shape where NaN lands on the healthy branch.
 *
 * An EMPTY pool is not ready either. Letting it through would hand a bucket with
 * nobody in it to a comparison where two empty answers agree perfectly and prove
 * nothing (L98).
 */
export function rosterReadiness(
  agents: AgentReadiness[],
  needCoverageToMs: number,
): { ready: boolean; noCalendar: number; notHydrated: number } {
  let noCalendar = 0;
  let notHydrated = 0;
  for (const a of agents) {
    // Counted as ONE reason each, the more fundamental first: an agent with no
    // calendar row cannot have a window, and reporting them under both headings
    // would make the two counts sum to more than the pool and read as worse than
    // it is.
    if (!a.hasCalendar) noCalendar++;
    else if (a.syncWindowToMs === null || a.syncWindowToMs < needCoverageToMs) notHydrated++;
  }
  return {
    ready: agents.length > 0 && noCalendar === 0 && notHydrated === 0,
    noCalendar,
    notHydrated,
  };
}

/**
 * Whether cal.com ignored the `routedTeamMemberIds` pin and answered with the
 * whole pool.
 *
 * It does exactly that, silently and with a 200, when a pinned id is not a host on
 * the event type. Compared against one agent's Slate availability the pool always
 * offers more, so the run reports Slate under-offering and sends somebody to fix
 * an agent who is fine. The only way to see it from outside is to ask a second
 * question whose answer is known to be the pool (a deliberately bogus id) and
 * notice that the two answers are the same.
 *
 * Compared as SETS: the same instants in a different order are the same answer,
 * and a positional comparison would call an ignored pin honoured (L228). Two empty
 * answers are not evidence either way, so they are not treated as ignored.
 */
export function detectPinIgnored(pinned: string[], bogus: string[]): boolean {
  if (pinned.length === 0 && bogus.length === 0) return false;
  if (pinned.length !== bogus.length) return false;
  const inBogus = new Set(bogus);
  return pinned.every((s) => inBogus.has(s));
}
