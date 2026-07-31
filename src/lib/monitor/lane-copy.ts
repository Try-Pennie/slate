/**
 * The words the cron dead-man's switch says (#1153).
 *
 * Lifted out of lane-watchdog.ts so the alert preview can render the REAL copy by
 * calling these, instead of holding a second copy that would drift the first time
 * someone edited one and not the other (L41). The watchdog imports them back.
 *
 * Four lane families, four voices, deliberately: these lanes fail for different
 * reasons and are recovered by different people doing different things, and
 * #1123 already had to unpick one shared message that pointed responders at the
 * wrong lane and lock.
 */
import { laneQuietClause, type StaleLane } from "@/lib/monitor/health";

/** Minutes, rounded, for the copy. */
const minutes = (ms: number) => Math.round(ms / 60_000);

/**
 * A Worker cron lane that has gone quiet. The usual cause is a mid-run CPU kill
 * on the shared invocation (#760), so the message sends the reader straight at
 * the two things worth looking at.
 */
export function coreLaneAlertText(lane: StaleLane): string {
  return (
    `The ${lane.lane} cron lane ${laneQuietClause({
      ageMs: lane.ageMs,
      boundMin: minutes(lane.maxStaleMs),
      unreadable: lane.unreadable,
    })}. Its work is not happening. A mid-run CPU kill on the shared cron ` +
    `invocation is the usual cause (#760): check the Worker's outcome for ` +
    `exceededCpu, and the cron_${lane.lane} lock.`
  );
}

/** All-clear for a Worker cron lane. Carries no remediation: the page sent the
 *  reader to check for a CPU kill and a stuck lock, and repeating that here would
 *  send them after a fault that is over. */
export function laneRecoveryText(lane: string): string {
  return (
    `The ${lane} cron lane is running again. It has stamped a heartbeat inside ` +
    `its bound, so the work it had stopped doing is happening again and the earlier ` +
    `page is cleared. No action is needed.`
  );
}

/** All-clear for the external booking canary, keyed like its alert (#525, #982). */
export function canaryRecoveryText(lane: string): string {
  if (lane === "smoke-canary-full") {
    return (
      `The booking smoke canary's full end to end pass is running again, so the ` +
      `automated proof that a booking can be created, rescheduled and cancelled is back ` +
      `in place. No action is needed.`
    );
  }
  return (
    `The booking smoke canary is running again, so the automated end to end ` +
    `booking check is back in place. No action is needed.`
  );
}

/** All-clear for the Snowflake mirror lanes, keyed like its alert (#1101, #1123). */
export function mirrorRecoveryText(lane: string): string {
  if (lane === "snowflake-reconcile") {
    return (
      `The check comparing the live database against the Snowflake mirror is ` +
      `running again, so the warehouse is being verified against the source once more. ` +
      `Anything that was treated as unverified while it was quiet, including export ` +
      `gated deletion, is being checked again. No action is needed.`
    );
  }
  if (lane === "erasure-audit") {
    return (
      `The check proving an erased person's data is really gone from the ` +
      `Snowflake warehouse is running again, so deletion requests are being watched ` +
      `through to the end once more. No action is needed.`
    );
  }
  if (lane === "snowflake-check") {
    return (
      `The Snowflake warehouse self check is passing again, so the statements ` +
      `the retention and erasure work depends on are known to run against the real ` +
      `warehouse. No action is needed.`
    );
  }
  return (
    `The Snowflake mirror export lane is running again, so the analytics ` +
    `warehouse is being kept up to date. No action is needed.`
  );
}

/** All-clear for a daily retention lane (#1102). These destroy customer data, so
 *  the notice says plainly that the deletion work has resumed. */
export function retentionRecoveryText(lane: string): string {
  return (
    `The ${lane} retention lane is running again, so the scheduled deleting of ` +
    `aged data has resumed and the retention window is being honored. No action is ` +
    `needed.`
  );
}

/**
 * Canary alert copy, keyed by which pass went quiet (#525, #982). The 30-min dry
 * tick and the 6h full pass are separate heartbeats: a stale dry tick means the
 * whole canary stopped, while a stale `smoke-canary-full` means only the full
 * end-to-end booking proof stopped (the dry tick may still be fine), and recovery
 * is a full-pass re-run, so the two need distinct, actionable messages.
 */
export function canaryAlertText(lane: StaleLane, boundMin: number): string {
  const quiet = laneQuietClause({ ageMs: lane.ageMs, boundMin, unreadable: lane.unreadable });
  if (lane.lane === "smoke-canary-full") {
    return `The booking smoke canary's full end to end pass (create, reschedule, cancel) ${quiet}, so the automated proof that a booking can actually be made is no longer running (the quick health tick may still be fine). Both the 6h scheduled run and the Worker gap filler have failed to complete it. Re run it from the Actions tab (Run workflow on smoke-canary, mode full).`;
  }
  return `The booking smoke canary ${quiet}, so the automated end to end booking check is no longer running. The scheduled GitHub Actions workflow (smoke-canary) has likely stopped firing or is failing before it can report. Check the Actions tab and re run it.`;
}

/**
 * Snowflake-mirror alert copy, keyed by which lane went quiet (#1101, #1123).
 *
 * The three lanes fail for different reasons and are recovered differently: the
 * export FEEDS the warehouse, while reconcile and the erasure audit are the two
 * CHECKS on it, on a different cron expression and different locks. One shared
 * message used to name the export lane and its every-10-minutes lock for all of
 * them, which would point a responder at the wrong lane and lock. Each lane
 * gets its own cause and its own next step, and each says plainly that the app
 * itself is unaffected so nobody treats it as an outage.
 */
export function mirrorAlertText(lane: StaleLane, boundMin: number): string {
  const quiet = laneQuietClause({ ageMs: lane.ageMs, boundMin, unreadable: lane.unreadable });
  if (lane.lane === "snowflake-reconcile") {
    return `The check that compares the live database against the Snowflake mirror ${quiet}, so nothing is verifying that the warehouse still matches the source (the app itself is unaffected). Anything that trusts the mirror being complete, including export gated deletion, should be treated as unverified until this clears. Check the cron_snowflake_reconcile lock and the Worker outcome for the 6h lane.`;
  }
  if (lane.lane === "erasure-audit") {
    return `The check that proves an erased person's data is really gone from the Snowflake warehouse ${quiet}, so a deletion request could be sitting half finished with nobody watching (the app itself is unaffected). This is the only automated check on the operator's manual warehouse purge step. Check the cron_erasure_audit lock and the Worker outcome for the 6h lane.`;
  }
  return `The Snowflake mirror export lane ${quiet}, so the analytics warehouse is going stale (the app itself is unaffected). Check the cron_snowflake_export lock and the Worker outcome for the */10 lane.`;
}
