/**
 * The daily busy minute lane (#3124): read both halves of the last 7 days of routed
 * bookings, judge them against the booking load run's bar, and say so.
 *
 * The rules are `busy-minutes.ts` (pure, node tested) and the words are
 * `busy-minutes-copy.ts`; this file is the IO. Each read resolves to a half the judge
 * can refuse, never to an empty list: a Slate read that errored is `{ ok: false }`, and
 * a cal.com read that threw, was refused part way or found cal.com unconfigured each
 * keeps its own kind, so none of them can arrive as a quiet week.
 *
 * What it costs one run: one Supabase RPC (`routed_bookings_per_minute`, one row back),
 * one read of the retired switch, one read of this lane's verdict stamp, the lock's
 * write and release, and, until cal.com is retired, the paged cal.com read: one call
 * for the forms and one per 250 responses of each, about 25 a day at about 4,500 a
 * week, paced 550ms apart, so about half a minute of wall clock and almost no CPU.
 */
import { acquireLock, releaseLock } from "@/lib/locks";
import { log } from "@/lib/log";
import { isLoadtest } from "@/lib/loadtest-guard";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { LOAD_RUN_BOOKINGS_PER_MINUTE } from "@/lib/load-bar";
import { loadCalcomRetired } from "@/lib/calcom/retirement";
import { readCalcomRoutingResponses } from "@/lib/calcom/client";
import { readHeartbeatMsStrict } from "@/lib/monitor/heartbeat";
import { recordDetectorVerdict } from "@/lib/monitor/verdict-store";
import { BUSY_MINUTES_VERDICT_LANE } from "@/lib/monitor/verdict-freshness";
import { loadMonitorCooldowns } from "@/lib/monitor/settings";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { logAlertSendFailure, logResolveFailure } from "@/lib/notify/send-failure";
import {
  alreadyMeasuredToday,
  busyWindow,
  isFinalAttempt,
  judgeBusyMinutes,
  planBusyMinutesActions,
  slateMinutesFrom,
  type BusyWindow,
  type CalcomHalf,
  type SlateHalf,
} from "@/lib/monitor/busy-minutes";
import {
  loadBarOutgrownAlert,
  loadBarOutgrownRecovery,
  loadBarUnreadAlert,
  loadBarUnreadRecovery,
} from "@/lib/monitor/busy-minutes-copy";

export const BUSY_MINUTES_LOCK = "cron_busy_minutes";
/** Well past a run's half minute, and past a cal.com that answers every page slowly. */
const LOCK_TTL_MS = 15 * 60_000;

export type BusyMinutesLaneResult =
  | { status: "skipped"; why: "overlapping-run" | "already-measured-today" | "loadtest" }
  | {
      status: "measured";
      raise: boolean;
      threshold: number;
      crossingDays: number;
      busiest: number | null;
      calcomCounted: boolean;
      slateBookings: number;
      calcomRouted: number;
    }
  | { status: "unmeasured"; reasons: string[]; finalAttempt: boolean };

/** Slate's half, through the one row RPC (migration 0193). */
async function readSlateHalf(window: BusyWindow): Promise<SlateHalf> {
  try {
    const { data, error } = await supabaseAdmin().rpc("routed_bookings_per_minute", {
      p_from: new Date(window.fromMs).toISOString(),
      p_to: new Date(window.toMs).toISOString(),
    });
    if (error) {
      log.error("busy-minutes", { msg: "slate read failed" }, error);
      return { ok: false };
    }
    const half = slateMinutesFrom(data, window);
    if (!half.ok) log.error("busy-minutes", { msg: "slate read answered in a shape it does not know" });
    return half;
  } catch (err) {
    log.error("busy-minutes", { msg: "slate read threw" }, err);
    return { ok: false };
  }
}

/** cal.com's half: retired, unknown, unconfigured, partial, or every routed response. */
async function readCalcomHalf(window: BusyWindow): Promise<CalcomHalf> {
  const retired = await loadCalcomRetired();
  if (retired === null) return { kind: "retired-unknown" };
  if (retired) return { kind: "retired" };
  try {
    const read = await readCalcomRoutingResponses(new Date(window.fromMs).toISOString());
    if (read === null) return { kind: "not-configured" };
    if (!read.ok) {
      log.warn("busy-minutes", { msg: "calcom read refused", reason: read.reason, status: read.status, form: read.formName ?? "" });
      return { kind: "unreadable", status: read.status, ...(read.formName ? { formName: read.formName } : {}) };
    }
    return {
      kind: "read",
      routed: read.rows.filter((r) => r.booked).map((r) => ({ createdAt: r.createdAt, ...(r.id ? { id: r.id } : {}) })),
    };
  } catch (err) {
    log.error("busy-minutes", { msg: "calcom read threw" }, err);
    return { kind: "unreadable", status: 0 };
  }
}

/**
 * The verdict stamp, read to let the 09:41 retry stand down after a measured 05:41 run.
 * A failed read runs the check anyway: the safe side of a doubt is one more count.
 */
async function lastVerdictMs(): Promise<number | null> {
  try {
    return await readHeartbeatMsStrict(BUSY_MINUTES_VERDICT_LANE);
  } catch (err) {
    log.warn("busy-minutes", { msg: "verdict stamp unreadable, counting anyway" }, err);
    return null;
  }
}

export async function runBusyMinutesLane(nowMs: number = Date.now()): Promise<BusyMinutesLaneResult> {
  // A load test deployment reaches no cal.com and its bookings are synthetic, so a
  // count there would be about nothing real.
  if (isLoadtest()) return { status: "skipped", why: "loadtest" };
  if (alreadyMeasuredToday(await lastVerdictMs(), nowMs)) return { status: "skipped", why: "already-measured-today" };
  // lock-overlap: a repeat is safe. The check writes nothing but its alerts and verdict
  // stamp, both idempotent, so an overlapping run would only repeat the reads.
  const lock = await acquireLock(BUSY_MINUTES_LOCK, LOCK_TTL_MS);
  if (!lock) return { status: "skipped", why: "overlapping-run" };
  try {
    const window = busyWindow(nowMs);
    const [slate, calcom] = await Promise.all([readSlateHalf(window), readCalcomHalf(window)]);
    const verdict = judgeBusyMinutes({ barPerMinute: LOAD_RUN_BOOKINGS_PER_MINUTE, window, slate, calcom });
    const finalAttempt = isFinalAttempt(nowMs);
    const plan = planBusyMinutesActions(verdict, { finalAttempt });
    const cooldowns = await loadMonitorCooldowns("busy-minutes");

    if (verdict.kind === "unmeasured") {
      const reasons = verdict.reasons.map((r) => r.kind);
      log.warn("busy-minutes", { msg: "could not count", reasons: reasons.join(","), final_attempt: finalAttempt });
      if (plan.pageUnread) {
        // alert-text-ok: built in busy-minutes-copy.ts from reason kinds, a status number
        // and a form name; no error text reaches it.
        await sendThrottledAlert("load_bar_unread", cooldowns.load_bar_unread, loadBarUnreadAlert(verdict.reasons), {
          subjects: reasons,
        }).catch(logAlertSendFailure("load_bar_unread"));
      }
      return { status: "unmeasured", reasons, finalAttempt };
    }

    log.info("busy-minutes", {
      msg: "cycle",
      threshold: verdict.threshold,
      crossing_days: verdict.crossingDays.length,
      raise: verdict.raise,
      busiest: verdict.busiest?.total ?? 0,
      slate_bookings: verdict.slateBookings,
      calcom_routed: verdict.calcomRouted,
      calcom_counted: verdict.calcomCounted,
    });
    // all-clear-proof: src/lib/monitor/busy-minutes-lane.test.ts drives a Slate read that
    // errors or throws, a cal.com read refused, thrown or unconfigured, and an unreadable
    // retired switch, and asserts no all clear is sent and no verdict stamped; the
    // unmeasured branch above returns before this line.
    if (plan.resolveUnread) {
      await resolveAlert("load_bar_unread", loadBarUnreadRecovery()).catch(logResolveFailure("load_bar_unread"));
    }
    if (plan.pageOutgrown) {
      // alert-text-ok: built in busy-minutes-copy.ts from counts and times.
      await sendThrottledAlert("load_bar_outgrown", cooldowns.load_bar_outgrown, loadBarOutgrownAlert(verdict), {
        subjects: [],
      }).catch(logAlertSendFailure("load_bar_outgrown"));
    } else if (plan.resolveOutgrown) {
      await resolveAlert("load_bar_outgrown", loadBarOutgrownRecovery(verdict)).catch(logResolveFailure("load_bar_outgrown"));
    }
    await recordDetectorVerdict(BUSY_MINUTES_VERDICT_LANE, plan.stampVerdict);
    return {
      status: "measured",
      raise: verdict.raise,
      threshold: verdict.threshold,
      crossingDays: verdict.crossingDays.length,
      busiest: verdict.busiest?.total ?? null,
      calcomCounted: verdict.calcomCounted,
      slateBookings: verdict.slateBookings,
      calcomRouted: verdict.calcomRouted,
    };
  } finally {
    await releaseLock(BUSY_MINUTES_LOCK, lock);
  }
}
