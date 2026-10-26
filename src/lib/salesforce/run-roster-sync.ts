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
import { activationAllowance, ROSTER_RUN_LOCK_TTL_MS } from "@/lib/bookable/activation-allowance";
import { ensureDefaultOrg } from "@/lib/provision";
import { ensureDefaultSchedules } from "@/lib/schedule";
import { acquireLease, releaseLock, type LeaseStopReason, type LockLease } from "@/lib/locks";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { logAlertSendFailure, logResolveFailure } from "@/lib/notify/send-failure";
import { clearFailureStreak, recordConsecutiveStreak } from "@/lib/notify/streak";
import { log } from "@/lib/log";
import {
  agentSyncRecovery,
  salesforceManagerAmbiguousAlert,
  salesforceManagerAmbiguousRecovery,
  salesforceRosterDivergenceAlert,
  salesforceRosterDivergenceRecovery,
  salesforceUserIdConflictAlert,
  salesforceUserIdConflictRecovery,
  twilioSyncFailureAlert,
  twilioSyncRecovery,
  twilioWriteFailureAlert,
  twilioWriteFailureRecovery,
  twilioOrphanedMarkAlert,
  demotionTriggerFailureAlert,
  demotionTriggerFailureRecovery,
  twilioOrphanedMarkRecovery,
} from "@/lib/monitor/cron-alert-copy";
import { hasUserIdConflicts } from "@/lib/salesforce/user-id-link";
import { convergeDepartedSessions, type SessionConvergenceResult } from "@/lib/offboarding/session-convergence";
import {
  reportSessionConvergence,
  SESSION_CONVERGENCE_ALERT_KEY,
  SESSION_CONVERGENCE_STREAK_ALERT_AT,
  SESSION_CONVERGENCE_STREAK_WINDOW_S,
} from "@/lib/offboarding/session-convergence-alert";
import { loadMonitorCooldowns } from "@/lib/monitor/settings";
import { defaultTwilioSyncDeps, syncTwilioRedistribute, type TwilioSyncResult } from "@/lib/twilio/sync";
import { recordDetectorVerdict } from "@/lib/monitor/verdict-store";
import {
  TWILIO_ROSTER_VERDICT_LANE,
  twilioRosterReachedVerdict,
} from "@/lib/monitor/verdict-freshness";

export const AGENTS_LOCK_KEY = "cron_agents";
/** Imported rather than written here (#2317): it is the window every activation
 *  allowance is derived from, so it lives beside them and not beside the lock. */
const AGENTS_LOCK_TTL_MS = ROSTER_RUN_LOCK_TTL_MS;

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
/** #3615: the reroute for demoted advisors, on the same two-runs-in-a-row footing as the writes. */
const DEMOTION_TRIGGER_STREAK_KEY = "demotion_trigger_failures";

/**
 * The Twilio READ failures streak (#2774).
 *
 * The same mechanism as the writes above and as the Salesforce half's
 * `agent_sync_failures` (`recordConsecutiveStreak` over the `rate_limit_hit` counter
 * in `rate_limits`, cleared by `clearFailureStreak`), with its own key so a failing
 * read and a failing write never count toward each other.
 *
 * On 2026-09-25 one 520 from Twilio's edge paged a person while the run an hour
 * earlier had read Twilio fine. The client now retries a 5xx or a dropped
 * connection once inside the run; what survives that still pages only when the
 * NEXT hourly run fails to read Twilio as well. The miss is not hidden on the first
 * run: the verdict stamp and the banner line say so every time, and only the page
 * waits.
 *
 * The window is three hours for the same reason as the writes' window: two
 * genuinely consecutive hourly runs land in one window rather than each looking
 * like the first.
 */
const TWILIO_READ_STREAK_KEY = "twilio_sync_failures";
const TWILIO_READ_STREAK_WINDOW_S = 3 * 60 * 60;
const TWILIO_READ_STREAK_ALERT_AT = 2;
const SYNC_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Why a half did not run when this run stopped holding its lock part way through
 * (#3177), one sentence per cause, because the two are different facts (L11):
 *
 *   taken    a newer run holds the key and is doing this work itself
 *   refused  renewing the lock could not run, so nothing shows the key is still
 *            this run's; it stops rather than risk writing beside another run
 *
 * Each is marked `leaseStop` on the outcome, because neither is a failed read of
 * the half it stands for. So neither records that half's failure streak or stamps
 * its verdict. A refused renewal is logged as a warning where it happens
 * (`renewLock`), and the next hourly run does the work.
 */
export const ROSTER_LEASE_STOP_REASONS: Record<LeaseStopReason, string> = {
  taken:
    "this run overran its lock and a newer roster sync took over, so it stopped and left the rest to that run",
  refused:
    "this run could not renew its lock, so it could not show the lock was still its own and stopped; the next hourly sync does the rest",
};

/** One half of the run: what it did, why it could not, or that the run stopped holding its lock first. */
type HalfOutcome<R> =
  | { ok: true; result: R }
  | { ok: false; reason: string; leaseStop?: undefined }
  | { ok: false; reason: string; leaseStop: LeaseStopReason };

/** A half that never ran because the lease stopped before it. */
function leaseStopHalf(why: LeaseStopReason) {
  return { ok: false, reason: ROSTER_LEASE_STOP_REASONS[why], leaseStop: why } as const;
}

/** The reason a caught failure carries, for the outcome and the banner. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What `stillHeld()` going false means; a lease always records a reason when it does. */
function stopReasonOf(lease: LockLease): LeaseStopReason {
  return lease.stopReason() ?? "refused";
}

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
       * branch on. A run that stopped holding its lock before this half carries
       * that reason here (#3177), never a read failure.
       */
      twilio: HalfOutcome<TwilioSyncResult>;
      /** Null when the run stopped holding its lock before applying default hours (#3177):
       *  it did not run, which a zero would report as having found nobody. */
      hoursApplied: number | null;
      /**
       * #2459: what the departed session convergence did, or WHY it could not
       * read. A discriminated pair for the same reason `twilio` is one.
       */
      sessions: HalfOutcome<SessionConvergenceResult>;
      /** Why this run stopped part way because its lock was not provably its own
       *  (#3177), or null when it held the lock to the end. */
      leaseStop: LeaseStopReason | null;
    };

/**
 * Run the roster job under its lock. Throws when the sync itself fails, and the
 * caller decides what a failure means (the cron records a streak, the button shows
 * an error). Everything on the SUCCESS path is here, because it is the same work
 * whoever asked for it, and a manual run that skipped any of it would leave the
 * roster in a state only the next scheduled hour could finish.
 */
export async function runRosterSync(): Promise<RosterSyncOutcome> {
  // lock-overlap: fenced (#3177). stillHeld() renews the claim before each
  // phase that writes and the run stops once another run holds the key.
  // #3177: the lock is a lease, so once its TTL passes the next hourly run may take
  // the key while this one is still working, and a stale run writing after a newer
  // one re-applies an old picture of who is bookable. So the run is FENCED: before
  // each phase that writes, `stillHeld()` renews the claim (a run making progress
  // keeps its key) and answers false once another run has taken it, or once the
  // renewal could not run, at which point this run stops and says which. The token
  // moves on each renewal, so the release below hands back the current one.
  const lease = await acquireLease(AGENTS_LOCK_KEY, AGENTS_LOCK_TTL_MS);
  if (!lease) return { skipped: "overlapping-run" };
  try {
    // #2302: ONE allowance for the whole run, spent by both halves. Each attempt to
    // make somebody bookable now reads their Google calendar as part of the gate,
    // and these two syncs share a single Worker invocation, so a budget held
    // separately by each would let the run spend twice the stated maximum. Created
    // here because this is the only place that knows a run is one run.
    const allowance = activationAllowance();
    const sync = await syncSalesforceAgents({ allowance });
    if (!(await lease.stillHeld())) {
      const why = stopReasonOf(lease);
      return { sync, sessions: leaseStopHalf(why), twilio: leaseStopHalf(why), hoursApplied: null, leaseStop: why };
    }

    // #2459: the reap above departs people with a batch write that never came
    // through the offboarding path, so it never banned them in Supabase Auth.
    // This converges every departed person's session access from the end state,
    // which repairs this hour's leavers, anybody an earlier failure stranded, and
    // the ones the reap departed before this shipped (see session-convergence.ts
    // for why a call beside the write would lose a failure for ever).
    //
    // Contained, for the reason the Twilio half below is: the roster writes have
    // committed, and a throw here would make the run read as a failed Salesforce
    // sync. A refused READ is reported as a reason, never as a zero (L214), and a
    // refused ban is counted and retried by the next run.
    let sessions: { ok: true; result: SessionConvergenceResult } | { ok: false; reason: string };
    try {
      sessions = { ok: true, result: await convergeDepartedSessions() };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      sessions = { ok: false, reason };
      log.error("agents", { msg: "departed session convergence could not run" }, err);
    }
    // Fail loud: a listing or a ban that keeps failing pages on the SECOND
    // unhealthy run in a row (one miss is a blip the next hour usually fixes), and
    // only a measured healthy run clears it. A backlog the cap left for the next
    // run is expected and never pages. Never throws.
    // alert-key: departed_sessions_unconverged
    // all-clear-proof: scripts/test-session-convergence.ts - "a single unhealthy
    // run pages nobody / and clears nothing" drives reportSessionConvergence with
    // an unreadable outcome and asserts resolve is never reached.
    await reportSessionConvergence(sessions, {
      recordStreak: () =>
        recordConsecutiveStreak(
          SESSION_CONVERGENCE_ALERT_KEY,
          SESSION_CONVERGENCE_STREAK_WINDOW_S,
          SESSION_CONVERGENCE_STREAK_ALERT_AT,
        ),
      clearStreak: () => clearFailureStreak(SESSION_CONVERGENCE_ALERT_KEY),
      // alert-key: departed_sessions_unconverged
      notify: (key, ms, text, repeat) => sendThrottledAlert(key, ms, text, repeat),
      // alert-key: departed_sessions_unconverged
      resolve: (key, text) => resolveAlert(key, text),
      cooldownMs: async () => (await loadMonitorCooldowns("agents")).departed_sessions_unconverged,
    });

    const org = await ensureDefaultOrg();
    // The Twilio half is the other writer of who is bookable, so it is the one a
    // stale run must never reach after a newer run has started (#3177).
    if (!(await lease.stillHeld())) {
      const why = stopReasonOf(lease);
      return { sync, sessions, twilio: leaseStopHalf(why), hoursApplied: null, leaseStop: why };
    }

    // The Twilio half, after Salesforce and BEFORE the bucket coverage check
    // (#2097). Both orderings are load bearing:
    //
    //  - after Salesforce, because the Salesforce half can make somebody bookable
    //    on their first debt team and Twilio's Redistribute tag has to beat that.
    //    The other order would admit a withheld agent for an hour every hour.
    //  - and it stays before the roster report, because taking twelve agents out
    //    of the pool changes what every later count in this run reports.
    //
    // Contained, so a Twilio failure cannot destroy the Salesforce half's report:
    // by this point those writes have already committed, and throwing here would
    // make the run indistinguishable from one where Salesforce failed. It is a
    // REFUSAL rather than a skip all the same: its own alert, its own line in the
    // banner, its own log. What it must never be is silent, because a Twilio half
    // that quietly does nothing has every symptom of a healthy run.
    //
    // The read is kept apart from its bookkeeping (the read streak, its page or all
    // clear, the write outcome report and the verdict stamp) so the fence can sit
    // between them (#3177): a run that lost the key during the read reports what
    // it read and writes none of that, because the newer run is reading Twilio
    // itself and owns those records now.
    let read: { ok: true; result: TwilioSyncResult } | { ok: false; err: unknown };
    try {
      read = {
        ok: true,
        result: await syncTwilioRedistribute({
          ...(await defaultTwilioSyncDeps(org.id)),
          allowance,
        }),
      };
    } catch (err) {
      read = { ok: false, err };
    }
    if (!(await lease.stillHeld())) {
      if (!read.ok) log.error("agents", { msg: "twilio half of the roster sync failed" }, read.err);
      return {
        sync,
        sessions,
        twilio: read.ok ? { ok: true, result: read.result } : { ok: false, reason: errorText(read.err) },
        hoursApplied: null,
        leaseStop: stopReasonOf(lease),
      };
    }

    let twilio: { ok: true; result: TwilioSyncResult } | { ok: false; reason: string };
    try {
      if (!read.ok) throw read.err;
      const result = read.result;
      twilio = { ok: true, result };
      // alert-key: twilio_sync_failures
      // all-clear-proof: src/app/api/cron/agents/route.test.ts - "sends NO Twilio
      // all-clear when the Twilio read failed" drives this runner with the Twilio
      // step throwing and asserts resolveAlert is never reached for its key.
      //
      // Hung off the MEASURED success, which is the only thing that can know Twilio
      // is readable. A run that threw above never reaches this line, so a Twilio
      // half that could not measure anything clears nothing (#1134, #1152). The
      // streak is cleared on the same footing (#2774), so a later isolated miss
      // starts counting from zero.
      await clearFailureStreak(TWILIO_READ_STREAK_KEY);
      const cleared = await resolveAlert("twilio_sync_failures", twilioSyncRecovery()).catch(logResolveFailure("twilio_sync_failures"));
      if (cleared) log.info("agents", { msg: "twilio sync failure alert cleared" });
      await reportTwilioWriteOutcome(result);
      // #3615: its own boundary. The Twilio half READ fine by this point, so a failure while
      // reporting the reroute (its streak, its page, its info line) must not land in the catch
      // below and be recorded as Twilio being unreadable, which pages about the wrong system.
      await reportDemotionOutcome(result).catch((err: unknown) =>
        log.error("agents", { msg: "could not report the demotion reroute's outcome, carrying on" }, err),
      );
    } catch (err) {
      const reason = errorText(err);
      twilio = { ok: false, reason };
      log.error("agents", { msg: "twilio half of the roster sync failed" }, err);
      // #2774: pages on the SECOND consecutive run that cannot read Twilio, not the
      // first. See TWILIO_READ_STREAK_KEY.
      const consecutive = await recordConsecutiveStreak(
        TWILIO_READ_STREAK_KEY,
        TWILIO_READ_STREAK_WINDOW_S,
        TWILIO_READ_STREAK_ALERT_AT,
      );
      if (consecutive) {
        // alert-text-ok: every one of the read's five refusals is a short sentence
        // this code wrote, carrying its own instruction. It is not a raw error.
        // alert-key: twilio_sync_failures
        await sendThrottledAlert(
          "twilio_sync_failures",
          SYNC_ALERT_COOLDOWN_MS,
          twilioSyncFailureAlert(reason),
        ).catch(logAlertSendFailure("twilio_sync_failures"));
      }
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

    // The last fence: what follows writes default hours and settles this run's
    // alerts, both of which the newer run now owns (#3177).
    if (!(await lease.stillHeld())) {
      return { sync, sessions, twilio, hoursApplied: null, leaseStop: stopReasonOf(lease) };
    }
    const hoursApplied = await ensureDefaultSchedules(org.id);
    // The per bucket coverage sweep used to run here (#327). It was retired by
    // #2505: a bucket with nobody in it is not a customer problem while the rest
    // of its debt tier can take the lead, and since #2486 the ladder tries every
    // bucket in the tier before dropping one. The question is asked per DEBT TIER
    // now, on the monitor lane, where the cached slot rows and the org's week are
    // already in hand (`empty_tier:<digit>`).
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
    // #2387 rides on this key rather than taking one of its own. A reap the sync
    // refused is the SAME shared address that produces `salesforceIdAmbiguous`,
    // reaching a different decision, and one edit in Salesforce settles both, so a
    // second page would be a second message about one morning's data problem. One
    // condition, read ONCE into a name, so the send and the all clear can never
    // disagree about whether it is true (L53).
    const keyUnsettled =
      hasUserIdConflicts(idConflicts) || sync.deactivationsRefusedAmbiguous > 0;
    if (keyUnsettled) {
      // alert-key: salesforce_user_id_conflicts
      await sendThrottledAlert(
        "salesforce_user_id_conflicts",
        SYNC_ALERT_COOLDOWN_MS,
        salesforceUserIdConflictAlert(
          idConflicts.disagreements,
          idConflicts.ambiguous,
          idConflicts.claimed,
          sync.deactivationsRefusedAmbiguous,
        ),
      ).catch(logAlertSendFailure("salesforce_user_id_conflicts"));
    } else {
      // alert-key: salesforce_user_id_conflicts
      const clearedIds = await resolveAlert(
        "salesforce_user_id_conflicts",
        salesforceUserIdConflictRecovery(),
      ).catch(logResolveFailure("salesforce_user_id_conflicts"));
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
      ).catch(logAlertSendFailure("salesforce_manager_ambiguous"));
    } else {
      // alert-key: salesforce_manager_ambiguous
      const clearedManagers = await resolveAlert(
        "salesforce_manager_ambiguous",
        salesforceManagerAmbiguousRecovery(),
      ).catch(logResolveFailure("salesforce_manager_ambiguous"));
      if (clearedManagers) log.info("agents", { msg: "salesforce manager ambiguity alert cleared" });
    }

    // #1833: a row the roster query no longer returns, whose agent is still in the
    // pool. Its own condition for the same reason the two above are separate: one
    // status field between independent checks means clearing either clears both
    // (L53).
    //
    // ONLY the bookable ones page. Measured against production on 2026-09-13 all
    // 39 unconfirmed rows were non bookable, which is a stale admin display and
    // not a lead going to the wrong person; an hourly page carrying no action is
    // what teaches somebody to skip the whole family (L36). The counts for the
    // rest are in the sync's own log line. A bookable one is different in kind:
    // clearing an agent's balance tiers is how they are taken off rotation, so
    // this is Slate routing to somebody the source says should not be taking the
    // call.
    //
    // Both directions hang off THIS point, reached only after the sync returned a
    // real result. A run that threw never gets here, so a sync that could not
    // measure anything clears nothing (#1134, #1152).
    if (sync.rosterUnconfirmedBookable.length > 0) {
      // alert-key: salesforce_roster_divergence
      await sendThrottledAlert(
        "salesforce_roster_divergence",
        SYNC_ALERT_COOLDOWN_MS,
        salesforceRosterDivergenceAlert(sync.rosterUnconfirmedBookable.length),
      ).catch(logAlertSendFailure("salesforce_roster_divergence"));
    } else {
      // alert-key: salesforce_roster_divergence
      const clearedDivergence = await resolveAlert(
        "salesforce_roster_divergence",
        salesforceRosterDivergenceRecovery(),
      ).catch(logResolveFailure("salesforce_roster_divergence"));
      if (clearedDivergence) log.info("agents", { msg: "salesforce roster divergence alert cleared" });
    }

    return {
      sync,
      twilio,
      hoursApplied,
      sessions,
      leaseStop: null,
    };
  } finally {
    await releaseLock(AGENTS_LOCK_KEY, lease.token());
  }
}

/**
 * The reroute for advisors Twilio demoted (#3615): page when it could not finish on two runs in a
 * row. The line saying how the moves went is not sent here: a run only QUEUES them, so it could
 * only say "is moving", which it once said of a call nobody was free to take. The every minute
 * drain says it once each sweep finishes (`demotion-outcome-report.ts`).
 *
 * Its own key rather than more parts on `twilio_write_failures`, because it is its own feature
 * behind its own switch with its own repair. An UNREADABLE switch counts as a failure: the sync
 * treats it as off and checks nobody, which once armed is every demotion silently missed.
 *
 * Only reached from a run that READ Twilio, so a run that measured nothing clears nothing
 * (#1134, #1152). Best effort, like its siblings: a Slack problem never fails the run.
 */
async function reportDemotionOutcome(result: TwilioSyncResult): Promise<void> {
  await reportDemotionFailures(result).catch((err: unknown) =>
    log.error("agents", { msg: "could not report the demotion reroute's failures, carrying on" }, err),
  );
}

/** The failure half of `reportDemotionOutcome`: page on the second run in a row, else clear. */
async function reportDemotionFailures(result: TwilioSyncResult): Promise<void> {
  const failures = {
    switchUnreadable: result.demotionSwitchUnreadable,
    evals: result.demotionEvalFailures,
    sweeps: result.demotionSweepFailures,
    writes: result.demotionWriteFailures,
  };
  const anyFailed = failures.switchUnreadable || failures.evals + failures.sweeps + failures.writes > 0;
  if (anyFailed) {
    const streak = await recordConsecutiveStreak(
      DEMOTION_TRIGGER_STREAK_KEY,
      TWILIO_WRITE_STREAK_WINDOW_S,
      TWILIO_WRITE_STREAK_ALERT_AT,
    );
    // alert-key: demotion_trigger_failures
    if (streak) {
      await sendThrottledAlert(
        "demotion_trigger_failures",
        SYNC_ALERT_COOLDOWN_MS,
        demotionTriggerFailureAlert(failures),
      ).catch(logAlertSendFailure("demotion_trigger_failures"));
    }
  } else {
    await clearFailureStreak(DEMOTION_TRIGGER_STREAK_KEY);
    // alert-key: demotion_trigger_failures
    const cleared = await resolveAlert(
      "demotion_trigger_failures",
      demotionTriggerFailureRecovery(),
    ).catch(logResolveFailure("demotion_trigger_failures"));
    if (cleared) log.info("agents", { msg: "demotion trigger failure alert cleared" });
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
    attributes: result.attributeWriteFailures,
  };
  const anyFailed = failures.flips + failures.sweeps + failures.attributes > 0;
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
      ).catch(logAlertSendFailure("twilio_write_failures"));
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
    ).catch(logResolveFailure("twilio_write_failures"));
    if (cleared) log.info("agents", { msg: "twilio write failure alert cleared" });
  }

  const orphaned = result.markedWithNoWorker.length;
  if (orphaned > 0) {
    // alert-key: twilio_marked_no_worker
    await sendThrottledAlert(
      "twilio_marked_no_worker",
      SYNC_ALERT_COOLDOWN_MS,
      twilioOrphanedMarkAlert(orphaned),
    ).catch(logAlertSendFailure("twilio_marked_no_worker"));
  } else {
    // alert-key: twilio_marked_no_worker
    const cleared = await resolveAlert(
      "twilio_marked_no_worker",
      twilioOrphanedMarkRecovery(),
    ).catch(logResolveFailure("twilio_marked_no_worker"));
    if (cleared) log.info("agents", { msg: "twilio orphaned mark alert cleared" });
  }
}
