import { supabaseAdmin } from "@/lib/supabase/admin";
import { OUTCOME_CALCOM_RETIRED } from "@/lib/calcom/outcomes";
import { log } from "@/lib/log";

/**
 * The "cal.com retired" switch (#2875): one stored admin setting that retires every
 * cal.com lane at once, so cutover (#65) needs no code change.
 *
 * During the parallel run cal.com takes every real lead, and Slate compares itself
 * against it, copies its hours, and writes each approved absence into it. Once
 * cal.com is off, every one of those becomes wrong in its own way: the comparison
 * lanes stop stamping and the watchdog pages "comparison went quiet" every
 * cooldown, the Worker re fires the sweep daily, a closed account turns every time
 * off approval into a page about protection nobody needs, and, if cal.com stays
 * readable, the morning import quietly reverts an admin's hours edit to stale
 * cal.com hours.
 *
 * Stored on `monitor_alert_config.calcom_retired` (migration 0147), NOT NULL
 * DEFAULT false, set only from /admin/alerts by `setCalcomRetired`, which audits
 * the value before and after.
 *
 * ## Three answers, and each consumer decides what the third means
 *
 * `true`, `false`, or `null` for a read that failed. A failed read is never folded
 * into either real answer here, because the safe direction is different for each
 * reader, and a helper that picked one for all of them would be wrong for half:
 *
 * - The hours import falls CLOSED (`calcomHoursWriteRefusal`). Overwriting a
 *   Slate week is the one irreversible direction: an admin's edit replaced by
 *   stale cal.com hours is lost with nothing said, while a day without the import
 *   costs one morning of drift the next run repairs.
 * - The watchdog, the gap fill, the unset hours page and the readiness command's
 *   parity half keep TODAY's behaviour. A spurious "comparison went quiet" page is
 *   the price of a failed read; silencing a live lane on one would be a detector
 *   nobody can see is off.
 * - The time off dual write keeps writing (`calcomOverrideWriteSkip`). A missing
 *   block during the parallel run lets cal.com book somebody who is away; a write
 *   to a retired cal.com is a failed call.
 */

/**
 * The heartbeat lanes that exist only because cal.com is live: the daily schedule
 * parity sweep and the weekly router replay. Both are in `CANARY_STALE_BOUNDS_MS`;
 * `scripts/test-calcom-retirement.ts` asserts that, and that every gap fill which
 * re fires a cal.com workflow is on this list, so the watchdog and the re dispatch
 * table cannot disagree about what cal.com owns (L41).
 */
export const CALCOM_HEARTBEAT_LANES = ["schedule-parity", "router-replay"] as const;

export function isCalcomLane(lane: string): boolean {
  return (CALCOM_HEARTBEAT_LANES as readonly string[]).includes(lane);
}

/**
 * A bounds map with the cal.com lanes taken out once cal.com is retired, and
 * unchanged otherwise, including when the setting could not be read.
 */
export function withoutRetiredCalcomLanes(
  bounds: Record<string, number>,
  retired: boolean | null,
): Record<string, number> {
  if (retired !== true) return bounds;
  return Object.fromEntries(Object.entries(bounds).filter(([lane]) => !isCalcomLane(lane)));
}

/**
 * Why the cal.com hours import may not write, or null when it may. Falls closed:
 * an unreadable setting writes nothing.
 */
export function calcomHoursWriteRefusal(retired: boolean | null): string | null {
  if (retired === false) return null;
  if (retired === true) {
    return "cal.com is marked retired on the alerts page, so the hours Slate holds are the record and nothing is imported from cal.com";
  }
  return "could not read whether cal.com is retired, so no hours were written from cal.com; this repairs itself on the next run once the setting can be read";
}

/**
 * The outcome the time off dual write records instead of writing, or null to write.
 * Falls OPEN: an unreadable setting writes as today.
 */
export function calcomOverrideWriteSkip(retired: boolean | null): string | null {
  return retired === true ? OUTCOME_CALCOM_RETIRED : null;
}

/** The one read this needs, narrowed so a test can hand in a fake. */
export interface RetiredReadDb {
  from: (table: "monitor_alert_config") => {
    select: (cols: "calcom_retired") => {
      eq: (col: "id", val: 1) => {
        maybeSingle: () => PromiseLike<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
}

/**
 * Read the switch. `null` on ANY failure (a refused statement, a throw, a value
 * that is not a boolean), never `false`: a deploy that went out ahead of migration
 * 0147 reads as unknown rather than as live. No row at all is `false`, because the
 * row is created by the first save of the alerts page and the column's default is
 * the off value, so a row that does not exist yet means the same as a fresh one.
 */
export async function loadCalcomRetired(db?: RetiredReadDb): Promise<boolean | null> {
  try {
    const client = db ?? (supabaseAdmin() as unknown as RetiredReadDb);
    const { data, error } = await client
      .from("monitor_alert_config")
      .select("calcom_retired")
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      log.error("calcom-retirement", { msg: "retired setting unreadable" }, error);
      return null;
    }
    if (data === null || data === undefined) return false;
    const value = (data as { calcom_retired?: unknown }).calcom_retired;
    if (typeof value !== "boolean") {
      log.error("calcom-retirement", { msg: "retired setting is not a boolean", value: String(value) });
      return null;
    }
    return value;
  } catch (err) {
    log.error("calcom-retirement", { msg: "retired setting read threw" }, err instanceof Error ? err : undefined);
    return null;
  }
}

/**
 * How long a successful read is reused by the lanes that ask every minute.
 *
 * Five minutes, the monitor lane's own cadence: the watchdog runs on the every
 * minute sync lane too, and a read per tick is a subrequest per minute on the
 * budget four cron lanes share, for a value that changes once, at cutover. The
 * writers (the hours import, the time off dual write) never use this; they read
 * fresh, because a write decided on a five minute old answer is the one place the
 * delay could do harm.
 */
export const CALCOM_RETIRED_TTL_MS = 5 * 60_000;

let cached: { value: boolean; atMs: number } | null = null;

/**
 * `loadCalcomRetired` through a per isolate cache. Only a SUCCESSFUL read is kept;
 * a failed refresh answers null rather than the last value, so every consumer's own
 * rule for "unknown" applies and the next tick asks again.
 */
export async function loadCalcomRetiredCached(
  nowMs: number = Date.now(),
  db?: RetiredReadDb,
): Promise<boolean | null> {
  if (cached && nowMs - cached.atMs < CALCOM_RETIRED_TTL_MS) return cached.value;
  const value = await loadCalcomRetired(db);
  cached = value === null ? null : { value, atMs: nowMs };
  return value;
}

/** The name a refused save of the switch carries back to /admin/alerts, so the page
 *  draws the refusal beside the switch rather than above the settings form. */
export const CALCOM_RETIREMENT_FORM = "calcom-retirement";

/** Test seam: forget the cached answer. */
export function __resetCalcomRetiredCache(): void {
  cached = null;
}
