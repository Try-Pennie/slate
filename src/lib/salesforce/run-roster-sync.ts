// The whole hourly roster job, as one locked call (#2071).
//
// It used to live inside the cron route, and the admin's "Sync from Salesforce"
// button called only its first step, `syncSalesforceAgents`. So a person pressing
// the button after adding somebody in Salesforce got the roster row and none of
// what the hour would have done next: no working hours for the new agent (they
// stayed without a schedule until the top of the hour), no check that a bucket now
// routes to nobody, no all clear for the conflicts the run had just settled, and no
// lock, so a press at :00 could run alongside the scheduled pass.
//
// Both callers now come here. The cron route keeps only what is genuinely its own
// (the bearer check and the failure streak that pages on consecutive misses), and
// the button keeps only its banner.
import { syncSalesforceAgents, AGENTS_SYNC_STREAK_KEY, type SyncResult } from "@/lib/salesforce/sync";
import { ensureDefaultOrg } from "@/lib/provision";
import { ensureDefaultSchedules } from "@/lib/schedule";
import { alertOnEmptyBuckets } from "@/lib/availability/service";
import { acquireLock, releaseLock } from "@/lib/locks";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { clearFailureStreak, recordConsecutiveStreak } from "@/lib/notify/streak";
import { log } from "@/lib/log";
import {
  agentSyncRecovery,
  salesforceManagerAmbiguousAlert,
  salesforceManagerAmbiguousRecovery,
  salesforceUserIdConflictAlert,
  salesforceUserIdConflictRecovery,
  twilioSyncFailureAlert,
  twilioSyncRecovery,
  twilioWriteFailureAlert,
  twilioWriteFailureRecovery,
  twilioOrphanedMarkAlert,
  twilioOrphanedMarkRecovery,
} from "@/lib/monitor/cron-alert-copy";
import { hasUserIdConflicts } from "@/lib/salesforce/user-id-link";
import { defaultTwilioSyncDeps, syncTwilioRedistribute, type TwilioSyncResult } from "@/lib/twilio/sync";
import { recordDetectorVerdict } from "@/lib/monitor/verdict-store";
import {
  TWILIO_ROSTER_VERDICT_LANE,
  twilioRosterReachedVerdict,
} from "@/lib/monitor/verdict-freshness";

export const AGENTS_LOCK_KEY = "cron_agents";
const AGENTS_LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * The Twilio write failures streak (#2114).
 *
 * TWO consecutive runs, not one. The plan is a pure function of the current
 * state, so a run that failed retries the same work an hour later; the first
 * failure is a blip that fixes itself and the second is the retry failing too,
 * which is the first moment anything is known that a person could act on.
 *
 * The window is three hours, comfortably over the hourly cadence, so two
 * genuinely consecutive runs land in one window rather than each looking like
 * the first.
 */
const TWILIO_WRITE_STREAK_KEY = "twilio_write_failures";
const TWILIO_WRITE_STREAK_WINDOW_S = 3 * 60 * 60;
const TWILIO_WRITE_STREAK_ALERT_AT = 2;
const SYNC_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export type RosterSyncOutcome =
  /** Another run holds the lock. Nothing was done, and the caller says so. */
  | { skipped: "overlapping-run" }
  | {
      skipped?: undefined;
      sync: SyncResult;
      /**
       * The Twilio half (#2097): what it changed, or WHY it could not be read.
       *
       * Never absent and never an empty default. A Twilio read that failed and a
       * Twilio read that found nobody tagged are different facts, and a default
       * would let the caller report the second while the first happened (L214), so
       * this is a discriminated pair the banner and the cron response both have to
       * branch on.
       */
      twilio: { ok: true; result: TwilioSyncResult } | { ok: false; reason: string };
      hoursApplied: number;
      emptyBuckets: string[];
      emptyBucketsAggregated: boolean;
    };

/**
 * Run the roster job under its lock. Throws when the sync itself fails, and the
 * caller decides what a failure means (the cron records a streak, the button shows
 * an error). Everything on the SUCCESS path is here, because it is the same work
 * whoever asked for it, and a manual run that skipped any of it would leave the
 * roster in a state only the next scheduled hour could finish.
 */
export async function runRosterSync(): Promise<RosterSyncOutcome> {
  const lock = await acquireLock(AGENTS_LOCK_KEY, AGENTS_LOCK_TTL_MS);
  if (!lock) return { skipped: "overlapping-run" };
  try {
    const sync = await syncSalesforceAgents();
    const org = await ensureDefaultOrg();

    // The Twilio half, after Salesforce and BEFORE the bucket coverage check
    // (#2097). Both orderings are load bearing:
    //
    //  - after Salesforce, because the Salesforce half can make somebody bookable
    //    on their first debt team and Twilio's Redistribute tag has to beat that.
    //    The other order would admit a withheld agent for an hour every hour.
    //  - before `alertOnEmptyBuckets`, because taking twelve agents out of the pool
    //    can be what empties a bucket, and the alarm has to see the state the run
    //    actually leaves rather than the one before its own flips.
    //
    // Contained, so a Twilio failure cannot destroy the Salesforce half's report:
    // by this point those writes have already committed, and throwing here would
    // make the run indistinguishable from one where Salesforce failed. It is a
    // REFUSAL rather than a skip all the same: its own alert, its own line in the
    // banner, its own log. What it must never be is silent, because a Twilio half
    // that quietly does nothing has every symptom of a healthy run.
    let twilio: { ok: true; result: TwilioSyncResult } | { ok: false; reason: string };
    try {
      const result = await syncTwilioRedistribute(await defaultTwilioSyncDeps(org.id));
      twilio = { ok: true, result };
      // alert-key: twilio_sync_failures
      // all-clear-proof: src/app/api/cron/agents/route.test.ts - "sends NO Twilio
      // all-clear when the Twilio read failed" drives this runner with the Twilio
      // step throwing and asserts resolveAlert is never reached for its key.
      //
      // Hung off the MEASURED success, which is the only thing that can know Twilio
      // is readable. A run that threw above never reaches this line, so a Twilio
      // half that could not measure anything clears nothing (#1134, #1152).
      const cleared = await resolveAlert("twilio_sync_failures", twilioSyncRecovery()).catch(() => false);
      if (cleared) log.info("agents", { msg: "twilio sync failure alert cleared" });
      await reportTwilioWriteOutcome(result);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      twilio = { ok: false, reason };
      log.error("agents", { msg: "twilio half of the roster sync failed" }, err);
      // alert-text-ok: every one of the read's five refusals is a short sentence
      // this code wrote, carrying its own instruction. It is not a raw error.
      // alert-key: twilio_sync_failures
      await sendThrottledAlert(
        "twilio_sync_failures",
        SYNC_ALERT_COOLDOWN_MS,
        twilioSyncFailureAlert(reason),
      ).catch(() => {});
    }

    // #2114: the stamp that says the Twilio half CONCLUDED, as opposed to ran.
    // Hung off the measured result, so a refused read stamps nothing: that is
    // already paged, and stamping there would report the detector as concluding
    // while it is blind. Best effort, like every other verdict stamp.
    await recordDetectorVerdict(
      TWILIO_ROSTER_VERDICT_LANE,
      twilioRosterReachedVerdict(twilio),
    ).catch((err) =>
      // `recordHeartbeat` already swallows its own database errors, so reaching
      // here means something unexpected. It must not fail the roster run, and it
      // must not be silent either: a stamp that never lands makes this detector
      // page as blind while it is in fact concluding.
      log.warn("agents", { msg: "twilio roster verdict stamp failed" }, err),
    );

    const hoursApplied = await ensureDefaultSchedules(org.id);
    // After the roster settles, flag any bucket that now routes to nobody (#327).
    // Best-effort: a monitoring miss must never fail the roster reconcile.
    const coverage = await alertOnEmptyBuckets().catch(() => ({
      empty: [] as string[],
      aggregated: false,
    }));
    // Clean pass: reset the streak so a later isolated failure starts from zero.
    await clearFailureStreak(AGENTS_SYNC_STREAK_KEY);
    // #1151: a failing roster sync is a CONDITION, and this successful run IS the
    // recovery. Hung off the healthy path, which is the only place that can know
    // the sync works; resolveAlert is a no-op unless a page was delivered, so a
    // sync that never failed stays silent. Best-effort: the roster already synced,
    // and a Slack problem must not turn a good run into a failure.
    // all-clear-proof: src/app/api/cron/agents/route.test.ts - "sends NO all-clear
    // when the sync itself failed" drives this runner through the route with the
    // sync throwing and asserts resolveAlert is never reached.
    // alert-key: agent_sync_failures
    const clearedSync = await resolveAlert("agent_sync_failures", agentSyncRecovery()).catch(
      () => false,
    );
    if (clearedSync) log.info("agents", { msg: "sync failure alert cleared" });

    // #1587: the shared cross system rep key. A row the sync deliberately left
    // alone is invisible from every other angle: the run succeeds, the roster
    // looks synced, and the only trace is a count nobody reads. It pages instead.
    //
    // Both directions hang off THIS point, which is reached only after the sync
    // returned a real result. A run that threw never gets here, so a sync that
    // could not measure anything clears nothing (#1134, #1152).
    const idConflicts = {
      linked: sync.salesforceIdsLinked,
      disagreements: sync.salesforceIdDisagreements,
      ambiguous: sync.salesforceIdAmbiguous,
      claimed: sync.salesforceIdClaimed,
      unresolved: sync.salesforceIdsUnresolved,
    };
    if (hasUserIdConflicts(idConflicts)) {
      // alert-key: salesforce_user_id_conflicts
      await sendThrottledAlert(
        "salesforce_user_id_conflicts",
        SYNC_ALERT_COOLDOWN_MS,
        salesforceUserIdConflictAlert(
          idConflicts.disagreements,
          idConflicts.ambiguous,
          idConflicts.claimed,
        ),
      ).catch(() => {});
    } else {
      // alert-key: salesforce_user_id_conflicts
      const clearedIds = await resolveAlert(
        "salesforce_user_id_conflicts",
        salesforceUserIdConflictRecovery(),
      ).catch(() => false);
      if (clearedIds) log.info("agents", { msg: "salesforce user id conflict alert cleared" });
    }

    // #1653: a manager name answering to more than one Salesforce user. Its own
    // condition, not folded into the id conflicts above, because the two are
    // independent checks and one status field between them would have either
    // clearing both (L53).
    //
    // Only the AMBIGUOUS refusal pages. A manager name that matched NOBODY leaves
    // the rep with no manager, which every consumer correctly sees as no manager;
    // a name that matched several may leave a link naming the wrong human, and
    // wrong is worse than missing. That is the same asymmetry #1587 settled.
    if (sync.managersAmbiguous > 0) {
      // alert-key: salesforce_manager_ambiguous
      await sendThrottledAlert(
        "salesforce_manager_ambiguous",
        SYNC_ALERT_COOLDOWN_MS,
        salesforceManagerAmbiguousAlert(sync.managersAmbiguous, sync.managerNamesAmbiguous),
      ).catch(() => {});
    } else {
      // alert-key: salesforce_manager_ambiguous
      const clearedManagers = await resolveAlert(
        "salesforce_manager_ambiguous",
        salesforceManagerAmbiguousRecovery(),
      ).catch(() => false);
      if (clearedManagers) log.info("agents", { msg: "salesforce manager ambiguity alert cleared" });
    }

    return {
      sync,
      twilio,
      hoursApplied,
      emptyBuckets: coverage.empty,
      emptyBucketsAggregated: coverage.aggregated,
    };
  } finally {
    await releaseLock(AGENTS_LOCK_KEY, lock);
  }
}

/**
 * Page when the Twilio half read fine and could not finish acting on it (#2114).
 *
 * Two separate conditions, because they are two different faults with two
 * different repairs (L11):
 *
 *  - a WRITE that keeps throwing (a flip, a coverage move, a legal value). It
 *    retries every hour on its own, so it pages on the SECOND consecutive run
 *    rather than the first, and clears the moment a run lands everything.
 *  - a MARK Twilio holds no worker for. Nothing retries that and nothing fixes
 *    it: the sync correctly does nothing on an absence, so it is a standing state
 *    somebody has to end, and it clears when every mark has a worker again.
 *
 * Both are best effort: the roster already synced, and a Slack problem must never
 * turn a good run into a failure.
 */
async function reportTwilioWriteOutcome(result: TwilioSyncResult): Promise<void> {
  const failures = {
    flips: result.flipFailures,
    sweeps: result.coverageSweepFailures,
    legal: result.legalWriteFailures,
  };
  const anyFailed = failures.flips + failures.sweeps + failures.legal > 0;
  if (anyFailed) {
    const streak = await recordConsecutiveStreak(
      TWILIO_WRITE_STREAK_KEY,
      TWILIO_WRITE_STREAK_WINDOW_S,
      TWILIO_WRITE_STREAK_ALERT_AT,
    );
    // alert-key: twilio_write_failures
    if (streak) {
      await sendThrottledAlert(
        "twilio_write_failures",
        SYNC_ALERT_COOLDOWN_MS,
        twilioWriteFailureAlert(failures),
      ).catch(() => {});
    }
  } else {
    // Hung off the MEASURED clean run, which is the only thing that can know the
    // writes are landing. A run that threw never reaches this function at all, so
    // a Twilio half that could not measure anything clears nothing (#1134, #1152).
    await clearFailureStreak(TWILIO_WRITE_STREAK_KEY);
    // alert-key: twilio_write_failures
    const cleared = await resolveAlert(
      "twilio_write_failures",
      twilioWriteFailureRecovery(),
    ).catch(() => false);
    if (cleared) log.info("agents", { msg: "twilio write failure alert cleared" });
  }

  const orphaned = result.markedWithNoWorker.length;
  if (orphaned > 0) {
    // alert-key: twilio_marked_no_worker
    await sendThrottledAlert(
      "twilio_marked_no_worker",
      SYNC_ALERT_COOLDOWN_MS,
      twilioOrphanedMarkAlert(orphaned),
    ).catch(() => {});
  } else {
    // alert-key: twilio_marked_no_worker
    const cleared = await resolveAlert(
      "twilio_marked_no_worker",
      twilioOrphanedMarkRecovery(),
    ).catch(() => false);
    if (cleared) log.info("agents", { msg: "twilio orphaned mark alert cleared" });
  }
}
