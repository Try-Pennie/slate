import { parseStampMs } from "@/lib/date/stamp";
import { HYDRATION_TICKS_PER_DAY } from "@/lib/google/hydration";
import { recordConsecutiveStreak, clearFailureStreak } from "@/lib/notify/streak";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { log } from "@/lib/log";

/**
 * A bookable agent's calendar whose hydrated window no longer covers the booking
 * horizon (#1262).
 *
 * The hydration rotation (#1261) re-bootstraps every calendar's busy window out
 * to `BUSY_WINDOW_AHEAD_DAYS` and stamps how far it reached in
 * `agent_calendars.sync_window_to`. Availability is served from that cache, so a
 * calendar whose window has fallen behind the horizon is a calendar whose far
 * days the booker OFFERS without knowing what is on them: a lead can book an
 * hour the agent's calendar says is taken, and nothing anywhere says so. That is
 * why hydration is load-bearing, and why this alert must exist before any write
 * filter or prune ships (#1263, #1264): both of those DELETE data on the promise
 * that hydration will re-add what matters.
 *
 * The lane watchdog covers the rotation dying outright. This covers the quieter
 * failure it cannot see: the rotation running happily while one agent's calendar
 * starves (a permanently failing bootstrap, a calendar added and never reached).
 *
 * `null` and an unreadable stamp are both scored UNCOVERED, because "no recorded
 * coverage" is exactly the state the alert exists to notice, and an unreadable
 * one silently scored as fine is the NaN-lands-healthy shape (#1169). Live
 * measurement before building (2026-08-21): both bookable agents' windows sat 21
 * days out against a 4 day horizon, and the only NULL windows belonged to
 * non-bookable calendars, so the first enforcing run is a measured clear rather
 * than an unwatched threshold's first live test (L56).
 */

/** alert_state key. Lives with the feature so the lane and the settings screen
 *  refer to the one constant. */
export const CALENDAR_WINDOW_KEY = "calendar_window_uncovered";

/**
 * How far past the horizon end a window must reach to count as covered: one
 * hydration lane cadence (the rotation runs every fifteen minutes), so the page
 * fires BEFORE coverage equals the horizon, which is already the incident.
 * Measured against live data the margin is normally ~17 days, so anything
 * inside one cadence of the horizon means the rotation has not touched this
 * calendar for weeks.
 */
export const CALENDAR_WINDOW_GRACE_MS = 15 * 60_000;

/**
 * How long after its row appears a calendar has NOT yet been given a chance (#2300).
 *
 * One hydration cadence, derived from the lane's own tick rate rather than written as
 * a number, so a change to the schedule cannot leave this pointing at the old one.
 *
 * Why it is needed at all, given the streak below. A null `sync_window_to` is the only
 * value a calendar the rotation has never reached can hold, so the streak was the only
 * patience there was, and three ticks of five minutes is exactly one cadence: a wave
 * larger than one batch pages before the lane has had a second opportunity. Measured
 * 2026-09-14, four new calendars took thirty minutes to cover and the page landed at
 * fifteen.
 *
 * It is deliberately NOT a tolerance on the distribution. It applies only to a calendar
 * with no coverage recorded at all, never to one whose window used to reach past the
 * horizon and has since fallen behind, which is the incident this alert exists for.
 */
export const CALENDAR_WINDOW_FIRST_RUN_MS = (24 * 60 * 60_000) / HYDRATION_TICKS_PER_DAY;

/** Consecutive monitor ticks uncovered before paging. The lane runs every 5
 *  minutes; 3 ticks rides out a calendar caught mid-bootstrap. */
export const CALENDAR_WINDOW_ALERT_AFTER_TICKS = 3;

/** Streak window: comfortably over 3 ticks * 5 min, with slack for a late tick. */
export const CALENDAR_WINDOW_STREAK_SECONDS = 60 * 60;

/** One bookable, non-deactivated agent's calendar and its recorded coverage. */
export interface CalendarWindowRow {
  userId: string;
  name: string | null;
  email: string | null;
  calendarId: string;
  /** `agent_calendars.sync_window_to`; null = hydration has never covered it. */
  syncWindowToIso: string | null;
  /**
   * `agent_calendars.created_at`: when this calendar joined the rotation, which is what
   * the first-run window is measured from (#2300). null = unreadable, which buys nothing.
   *
   * Required, not optional, so `tsc` enumerates every construction site rather than
   * letting one default quietly into permanent patience.
   */
  createdAtIso: string | null;
  /** The rotation has already recorded a failure against this calendar (#2300). */
  hasRecordedFailure: boolean;
}

/**
 * Which calendars fail the coverage bound. Pure, so the boundary (and both
 * fail-safe directions) are pinned by tests rather than living in a query.
 */
/**
 * Whether the hydration rotation has not yet had its FIRST opportunity at this calendar
 * (#2300).
 *
 * Narrow on purpose, and each condition is the reason rather than a proxy for it (L324):
 *
 *  - only a calendar with NO coverage recorded, so a window that once reached past the
 *    horizon and has since lapsed is never softened, however new the row is;
 *  - not one the rotation has already failed on, because that answer has arrived and
 *    being patient about it hides something actionable (L458);
 *  - measured from a STORED stamp, so it expires rather than sliding with the clock (L74);
 *  - and an unreadable or missing stamp buys nothing, the fail-safe side.
 */
function withinFirstRun(r: CalendarWindowRow, nowMs: number): boolean {
  if (r.syncWindowToIso !== null) return false;
  if (r.hasRecordedFailure) return false;
  const createdMs = parseStampMs(r.createdAtIso ?? "");
  if (createdMs === null) return false;
  return nowMs - createdMs <= CALENDAR_WINDOW_FIRST_RUN_MS;
}

/** What one pass judged, separating the uncovered from the not-yet-judged. */
export function judgeCalendarCoverage(input: {
  rows: CalendarWindowRow[];
  horizonDays: number;
  nowIso: string;
}): { uncovered: CalendarWindowRow[]; graced: number } {
  const nowMs = parseStampMs(input.nowIso);
  // An unreadable clock scores every calendar uncovered, unchanged: nothing can be
  // graced against a now nobody can read.
  if (nowMs === null) return { uncovered: input.rows, graced: 0 };
  const judged = input.rows.filter((r) => !withinFirstRun(r, nowMs));
  const requiredMs = nowMs + input.horizonDays * 24 * 60 * 60_000 + CALENDAR_WINDOW_GRACE_MS;
  const uncovered = judged.filter((r) => {
    const windowMs = parseStampMs(r.syncWindowToIso ?? "");
    // null and unreadable both land here: no coverage established.
    if (windowMs === null) return true;
    return windowMs < requiredMs;
  });
  return { uncovered, graced: input.rows.length - judged.length };
}

export function uncoveredCalendars(input: {
  rows: CalendarWindowRow[];
  horizonDays: number;
  nowIso: string;
}): CalendarWindowRow[] {
  return judgeCalendarCoverage(input).uncovered;
}

const NAME_CAP = 8;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const who = (r: CalendarWindowRow): string => {
  const name = r.name?.trim() || r.email || r.userId;
  return r.email && r.email !== name ? `${name} (${r.email})` : name;
};

/**
 * The page. Customer consequence first, then who, then where the fix lives.
 */
export function formatCalendarWindowAlert(rows: CalendarWindowRow[], horizonDays: number): string {
  const lines = rows.slice(0, NAME_CAP).map((r) => {
    const coverage =
      r.syncWindowToIso === null
        ? "no coverage recorded at all"
        : `covered only to ${r.syncWindowToIso.slice(0, 10)}`;
    return `${who(r)}, ${coverage}`;
  });
  const more = rows.length > NAME_CAP ? `\n(and ${rows.length - NAME_CAP} more)` : "";
  return (
    `${plural(rows.length, "bookable agent's calendar", "bookable agents' calendars")} ` +
    `no longer ${rows.length === 1 ? "covers" : "cover"} the ${horizonDays} day booking ` +
    `window. The booker is offering ${rows.length === 1 ? "that agent's" : "their"} far days ` +
    `without knowing what is on ${rows.length === 1 ? "that calendar" : "those calendars"}, ` +
    `so a lead can book an hour that is already taken. The refresh rotation runs every 15 ` +
    `minutes and has not reached ${rows.length === 1 ? "this calendar" : "these calendars"}; ` +
    `check the calendar sync lane's recent errors for ` +
    `${rows.length === 1 ? "this account" : "these accounts"}.\n` +
    lines.join("\n") +
    more
  );
}

/**
 * The all-clear: stand down, no remediation carried along.
 *
 * The unqualified sentence may only be said when the pass really did judge every
 * calendar. Withholding one inside its first run (#2300) makes the uncovered count
 * zero and reaches this branch, so the softened form states what WAS measured rather
 * than merely dropping the claim (L440).
 */
export function formatCalendarWindowRecovery(graced: number): string {
  if (graced === 0) {
    return (
      `Every bookable agent's calendar is covered past the booking window again, so the ` +
      `times the booker offers are backed by a fresh view of their calendars. No action is needed.`
    );
  }
  const who = graced === 1 ? "One calendar was" : `${graced} calendars were`;
  return (
    `Every calendar this check judged is covered past the booking window again, so the ` +
    `times the booker offers are backed by a fresh view of those calendars. ${who} left ` +
    `out: ${graced === 1 ? "it joined" : "they joined"} the rotation too recently to have ` +
    `been reached yet, so ${graced === 1 ? "it was" : "they were"} not judged either way. ` +
    `No action is needed.`
  );
}

/** What one tick measured. `unreadable` is NOT zero uncovered. */
export interface CalendarWindowResult {
  status: "clear" | "uncovered" | "unreadable";
  uncovered: number;
  /**
   * How many calendars this pass DECLINED to judge because the rotation has not yet had
   * its first opportunity at them (#2300). Reported rather than left implicit: a pass
   * that withheld somebody and a pass that found everything covered are otherwise the
   * same zero, and the all-clear copy has to know the difference before it can claim
   * what it measured.
   */
  graced: number;
}

/**
 * One monitor tick. Three states, deliberately distinct:
 *
 *  - uncovered calendars: count toward the streak, page once sustained;
 *  - a MEASURED zero uncovered: clear the streak and resolve (a no-op unless a
 *    page was actually delivered);
 *  - a read that FAILED: do neither. An unread roster comes back empty, and an
 *    empty result here is indistinguishable from "everyone is covered";
 *    announcing recovery off it would clear a real page at the exact moment the
 *    system cannot tell anyone (#1134, #1152).
 *
 * Best-effort by design: monitoring must never take down the lane it watches.
 */
export async function runCalendarWindowCheck(deps: {
  loadRows: () => Promise<CalendarWindowRow[]>;
  horizonDays: number;
  nowIso: string;
  cooldownMs: number;
  logTick?: (fields: Record<string, unknown>) => void;
}): Promise<CalendarWindowResult> {
  let rows: CalendarWindowRow[];
  try {
    rows = await deps.loadRows();
  } catch (err) {
    log.error("calendar-window", { msg: "coverage read failed" }, err);
    deps.logTick?.({ status: "unreadable" });
    return { status: "unreadable", uncovered: 0, graced: 0 };
  }

  const { uncovered, graced } = judgeCalendarCoverage({
    rows,
    horizonDays: deps.horizonDays,
    nowIso: deps.nowIso,
  });

  if (uncovered.length === 0) {
    await clearFailureStreak(CALENDAR_WINDOW_KEY);
    // alert-key: calendar_window_uncovered
    await resolveAlert(CALENDAR_WINDOW_KEY, formatCalendarWindowRecovery(graced)).catch(() => {});
    deps.logTick?.({ status: "clear", calendars: rows.length, graced });
    return { status: "clear", uncovered: 0, graced };
  }

  const sustained = await recordConsecutiveStreak(
    CALENDAR_WINDOW_KEY,
    CALENDAR_WINDOW_STREAK_SECONDS,
    CALENDAR_WINDOW_ALERT_AFTER_TICKS,
  );
  if (sustained) {
    // alert-key: calendar_window_uncovered
    await sendThrottledAlert(
      CALENDAR_WINDOW_KEY,
      deps.cooldownMs,
      formatCalendarWindowAlert(uncovered, deps.horizonDays),
    ).catch(() => {});
  }
  deps.logTick?.({ status: "uncovered", uncovered: uncovered.length, sustained, graced });
  return { status: "uncovered", uncovered: uncovered.length, graced };
}
