import { recordConsecutiveStreak, clearFailureStreak } from "@/lib/notify/streak";
import { sendThrottledAlert, resolveRecovered } from "@/lib/notify/dispatch";
import { logAlertSendFailure, logAllClearFailure } from "@/lib/notify/send-failure";

/**
 * A sweep on the complete or outbox lane that is FAILING rather than falling
 * behind (#2544, #3077).
 *
 * Its sibling `sweep-saturation.ts` answers a different question, and the two are
 * deliberately separate. Saturation is "the sweep ran and could not keep up",
 * which is a backlog; this is "the sweep did not run at all", which is a fault.
 * Saturation is explicitly told NOTHING by a failed run (`drained === null` leaves
 * the streak untouched), which is correct for it and is exactly why this had to
 * exist: the one outcome saturation cannot speak about had nothing else speaking
 * about it either.
 *
 * What it replaced: `/api/cron/complete` caught each sweep's throw, wrote a
 * `log.error`, and answered `{ completed: "error" }` on a 200. The heartbeat is
 * stamped either way, deliberately (it proves the LANE executed), so a sweep
 * failing on every five minute tick was invisible outside Cloudflare logs, which
 * have no alerting on top of them and seven days of retention.
 *
 * ONE failed run is not a page. A transient Supabase blip resolves on the next
 * tick and the work is idempotent, so this pages on a sustained streak and
 * all-clears off a run that came back with a real result.
 */

/** alert-key: completion_sweep_failing */
export const COMPLETION_SWEEP_FAILING_KEY = "completion_sweep_failing";
/** alert-key: webhook_retry_sweep_failing */
export const WEBHOOK_RETRY_SWEEP_FAILING_KEY = "webhook_retry_sweep_failing";

/** alert-key: demo_auto_cancel_failing */
export const DEMO_AUTO_CANCEL_FAILING_KEY = "demo_auto_cancel_failing";

/**
 * The outbox lane's three secondary jobs (#3077), which had the same silence one
 * lane over: each was `.catch(() => null)` with no log line, the heartbeat stamped
 * anyway, and the reservation drain's own `reservation_drain_stuck` page can only
 * fire from inside a drain that SUCCEEDED. A drain throwing on every tick left
 * crashed lead bookings unresumed behind a lane answering 200.
 */
/** alert-key: reservation_drain_failing */
export const RESERVATION_DRAIN_FAILING_KEY = "reservation_drain_failing";
/** alert-key: reschedule_pin_sweep_failing */
export const RESCHEDULE_PIN_SWEEP_FAILING_KEY = "reschedule_pin_sweep_failing";
/** alert-key: reassign_intent_sweep_failing */
export const REASSIGN_INTENT_SWEEP_FAILING_KEY = "reassign_intent_sweep_failing";

/**
 * Consecutive failing runs before paging. The complete lane runs every 5 minutes,
 * so three runs is about fifteen minutes of the sweep not working, which clears a
 * transient blip and is well inside the `complete` lane's own 20 minute heartbeat
 * bound: a fault that takes the whole lane down is still reported by the dead
 * man's switch first, and this is for the case where the lane is perfectly alive.
 */
export const SWEEP_FAILURE_ALERT_AFTER_RUNS = 3;

/**
 * The same judgement for a sweep on the EVERY MINUTE outbox lane. Three runs there
 * would be three minutes, which is inside an ordinary Supabase blip; five is five
 * minutes, still far inside the 30 minute window, so the runs land in one window.
 */
export const OUTBOX_SWEEP_FAILURE_ALERT_AFTER_RUNS = 5;

/** Streak window. Comfortably over 3 runs times 5 minutes, with slack for a tick
 *  delayed by lock contention, so genuinely consecutive runs land in one window. */
export const SWEEP_FAILURE_WINDOW_SECONDS = 30 * 60;

/** A failing sweep stays failing until somebody deploys something, so repeat at
 *  the same interval its saturation sibling uses rather than every tick. */
const SWEEP_FAILURE_COOLDOWN_MS = 30 * 60_000;

/**
 * What each sweep's failure COSTS, and what it looks like when it is over.
 *
 * Per key rather than a shared "the X sweep is failing", for the #1123 reason: the
 * two sweeps are recovered by different people looking at different things, and a
 * reader woken by this needs the consequence rather than the mechanism.
 */
const SWEEP_SUBJECT: Record<
  string,
  { what: string; cost: string; back: string; tag: string; afterRuns: number }
> = {
  [COMPLETION_SWEEP_FAILING_KEY]: {
    tag: "complete",
    afterRuns: SWEEP_FAILURE_ALERT_AFTER_RUNS,
    what: "The booking completion sweep on the complete cron lane",
    cost:
      "Finished bookings are not being marked complete, so they keep counting as upcoming " +
      "calls in every count and screen that reads the status.",
    back: "Finished bookings are being marked complete again, and they no longer count as upcoming",
  },
  [WEBHOOK_RETRY_SWEEP_FAILING_KEY]: {
    tag: "complete",
    afterRuns: SWEEP_FAILURE_ALERT_AFTER_RUNS,
    what: "The failed webhook delivery retry on the complete cron lane",
    cost:
      "A delivery that failed once is never re-attempted, so events sit in the queue until " +
      "they dead letter instead of reaching Regal.",
    back: "Failed webhook deliveries are being re-attempted again, so the queue that had stopped draining is moving",
  },
  [DEMO_AUTO_CANCEL_FAILING_KEY]: {
    tag: "complete",
    afterRuns: SWEEP_FAILURE_ALERT_AFTER_RUNS,
    what: "The demo booking auto cancel on the complete cron lane",
    cost:
      "Calls booked through the /demo link are not being cancelled after their 30 minutes, so " +
      "they stay on the test agent's calendar and the demo offers fewer times to the next visitor.",
    back: "Demo bookings are being cancelled after their 30 minutes again",
  },
  [RESERVATION_DRAIN_FAILING_KEY]: {
    tag: "outbox",
    afterRuns: OUTBOX_SWEEP_FAILURE_ALERT_AFTER_RUNS,
    what: "The booking crash recovery drain on the outbox cron lane",
    cost:
      "A lead booking that crashed part way through is not being resumed, so that lead may " +
      "have no calendar invite and Regal may never hear about the call.",
    back: "Crashed lead bookings are being resumed again",
  },
  [RESCHEDULE_PIN_SWEEP_FAILING_KEY]: {
    tag: "outbox",
    afterRuns: OUTBOX_SWEEP_FAILURE_ALERT_AFTER_RUNS,
    what: "The abandoned reschedule cleanup on the outbox cron lane",
    cost:
      "A reschedule that crashed part way through is neither cleaned up nor reported, so its " +
      "booking can stay at the old time with nobody told.",
    back: "Abandoned reschedules are being cleaned up and reported again",
  },
  [REASSIGN_INTENT_SWEEP_FAILING_KEY]: {
    tag: "outbox",
    afterRuns: OUTBOX_SWEEP_FAILURE_ALERT_AFTER_RUNS,
    what: "The abandoned reassign cleanup on the outbox cron lane",
    cost:
      "A reassign that crashed part way through is neither cleaned up nor reported, so a lost " +
      "contact owner change goes unnoticed.",
    back: "Abandoned reassigns are being cleaned up and reported again",
  },
};

/** How many consecutive failing runs page for this key, set by its lane's cadence. */
export function sweepFailureAfterRuns(key: string): number {
  return SWEEP_SUBJECT[key]!.afterRuns;
}

/**
 * Page body. `runs` is the threshold that was crossed, so the wording says "at
 * least": once the streak alerts it keeps alerting, and claiming an exact duration
 * would understate a long outage.
 */
export function formatSweepFailureAlert(key: string, runs: number): string {
  const subject = SWEEP_SUBJECT[key]!;
  return (
    `${subject.what} has thrown on at least ${runs} consecutive runs. ${subject.cost} ` +
    `The lane itself is still running, so its heartbeat is fresh and nothing else will say ` +
    `this. Check the Worker logs for tag=${subject.tag}.`
  );
}

/** All-clear. Says what is happening again, and carries no remediation: the page
 *  sent the reader to the logs, and repeating that would send them after a fault
 *  that is over. */
export function formatSweepFailureRecovery(key: string): string {
  return `${SWEEP_SUBJECT[key]!.back}. No action is needed.`;
}

/** One sweep's verdict for this run. `ok` is false ONLY when the sweep threw. */
export interface SweepRunOutcome {
  key: string;
  ok: boolean;
}

/**
 * Fold one tick's sweep outcomes into their streaks, and page when sustained.
 *
 * The recoveries are settled in ONE `alert_state` read for every sweep that came
 * back healthy, because this runs on cron invocations several lanes
 * share and a resolve per key would be a read each for rows that almost never
 * exist.
 *
 * Best-effort throughout: monitoring must never take down the lane it is watching
 * (L71), so every dispatch is caught and the streak helpers swallow their own
 * errors.
 */
export async function reportSweepFailures(outcomes: SweepRunOutcome[]): Promise<void> {
  const healthy = outcomes.filter((o) => o.ok);

  for (const o of healthy) {
    await clearFailureStreak(o.key);
  }
  if (healthy.length > 0) {
    const recovered = healthy.map((o) => ({ key: o.key, text: formatSweepFailureRecovery(o.key) }));
    // Hung off the MEASURED healthy result: `ok` is true only when the sweep
    // returned a real result this tick. A run whose sweep threw is not in this
    // list, so a failed tick can never announce recovery (#1134, #1152).
    // alert-key: completion_sweep_failing
    // alert-key: webhook_retry_sweep_failing
    // alert-key: demo_auto_cancel_failing
    // alert-key: reservation_drain_failing
    // alert-key: reschedule_pin_sweep_failing
    // alert-key: reassign_intent_sweep_failing
    await resolveRecovered(recovered).catch(logAllClearFailure(recovered.map((r) => r.key)));
  }

  for (const o of outcomes) {
    if (o.ok) continue;
    const afterRuns = sweepFailureAfterRuns(o.key);
    const sustained = await recordConsecutiveStreak(
      o.key,
      SWEEP_FAILURE_WINDOW_SECONDS,
      afterRuns,
    ).catch(() => false);
    if (!sustained) continue;
    // alert-key: completion_sweep_failing
    // alert-key: webhook_retry_sweep_failing
    // alert-key: demo_auto_cancel_failing
    // alert-key: reservation_drain_failing
    // alert-key: reschedule_pin_sweep_failing
    // alert-key: reassign_intent_sweep_failing
    await sendThrottledAlert(
      o.key,
      SWEEP_FAILURE_COOLDOWN_MS,
      formatSweepFailureAlert(o.key, afterRuns),
    ).catch(logAlertSendFailure(o.key));
  }
}
