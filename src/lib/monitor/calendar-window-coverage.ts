import { parseStampMs } from "@/lib/date/stamp";
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
}

/**
 * Which calendars fail the coverage bound. Pure, so the boundary (and both
 * fail-safe directions) are pinned by tests rather than living in a query.
 */
export function uncoveredCalendars(input: {
  rows: CalendarWindowRow[];
  horizonDays: number;
  nowIso: string;
}): CalendarWindowRow[] {
  const nowMs = parseStampMs(input.nowIso);
  if (nowMs === null) return input.rows;
  const requiredMs = nowMs + input.horizonDays * 24 * 60 * 60_000 + CALENDAR_WINDOW_GRACE_MS;
  return input.rows.filter((r) => {
    const windowMs = parseStampMs(r.syncWindowToIso ?? "");
    // null and unreadable both land here: no coverage established.
    if (windowMs === null) return true;
    return windowMs < requiredMs;
  });
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

/** The all-clear: stand down, no remediation carried along. */
export function formatCalendarWindowRecovery(): string {
  return (
    `Every bookable agent's calendar is covered past the booking window again, so the ` +
    `times the booker offers are backed by a fresh view of their calendars. No action is needed.`
  );
}

/** What one tick measured. `unreadable` is NOT zero uncovered. */
export interface CalendarWindowResult {
  status: "clear" | "uncovered" | "unreadable";
  uncovered: number;
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
    return { status: "unreadable", uncovered: 0 };
  }

  const uncovered = uncoveredCalendars({
    rows,
    horizonDays: deps.horizonDays,
    nowIso: deps.nowIso,
  });

  if (uncovered.length === 0) {
    await clearFailureStreak(CALENDAR_WINDOW_KEY);
    // alert-key: calendar_window_uncovered
    await resolveAlert(CALENDAR_WINDOW_KEY, formatCalendarWindowRecovery()).catch(() => {});
    deps.logTick?.({ status: "clear", calendars: rows.length });
    return { status: "clear", uncovered: 0 };
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
  deps.logTick?.({ status: "uncovered", uncovered: uncovered.length, sustained });
  return { status: "uncovered", uncovered: uncovered.length };
}
