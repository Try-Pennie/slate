import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { ensureDefaultOrg } from "@/lib/provision";
import { syncSalesforceAgents, AGENTS_SYNC_STREAK_KEY } from "@/lib/salesforce/sync";
import { ensureDefaultSchedules } from "@/lib/schedule";
import { alertOnEmptyBuckets } from "@/lib/availability/service";
import { acquireLock, releaseLock } from "@/lib/locks";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { recordFailureStreak, clearFailureStreak } from "@/lib/notify/streak";
import { log } from "@/lib/log";
import {
  agentSyncFailureAlert,
  agentSyncRecovery,
  salesforceManagerAmbiguousAlert,
  salesforceManagerAmbiguousRecovery,
  salesforceUserIdConflictAlert,
  salesforceUserIdConflictRecovery,
} from "@/lib/monitor/cron-alert-copy";
import { hasUserIdConflicts } from "@/lib/salesforce/user-id-link";

export const dynamic = "force-dynamic";

const AGENTS_LOCK_TTL_MS = 10 * 60 * 1000;
const SYNC_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// Streak so a single failing pass stays quiet (transient SF blips self-heal next
// hour) and only CONSECUTIVE failures alert (#486). The window comfortably spans
// two hourly passes so the second genuinely-consecutive failure lands in it. The
// key is shared with the admin manual-sync action (#491) via salesforce/sync.
const AGENTS_STREAK_WINDOW_S = 3 * 60 * 60;

/**
 * Hourly roster maintenance: pull agent/team changes from Salesforce (existing
 * agents get attribute updates via the merge; new agents arrive
 * bookable=false; departed synced-only agents are removed) and give any
 * schedule-less agent the org default working hours so they are never
 * silently unavailable once flipped bookable.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const lock = await acquireLock("cron_agents", AGENTS_LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });

  try {
    const sync = await syncSalesforceAgents();
    const org = await ensureDefaultOrg();
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
    // and a Slack problem must not turn a good run into a 500.
    const clearedSync = await resolveAlert(
      "agent_sync_failures",
      agentSyncRecovery(),
    ).catch(() => false);
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
      if (clearedIds) {
        log.info("agents", { msg: "salesforce user id conflict alert cleared" });
      }
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
    //
    // Both directions hang off THIS point, reached only after the sync returned a
    // real result, so a run that threw clears nothing (#1134, #1152).
    if (sync.managersAmbiguous > 0) {
      // alert-key: salesforce_manager_ambiguous
      await sendThrottledAlert(
        "salesforce_manager_ambiguous",
        SYNC_ALERT_COOLDOWN_MS,
        salesforceManagerAmbiguousAlert(
          sync.managersAmbiguous,
          sync.managerNamesAmbiguous,
        ),
      ).catch(() => {});
    } else {
      // alert-key: salesforce_manager_ambiguous
      const clearedManagers = await resolveAlert(
        "salesforce_manager_ambiguous",
        salesforceManagerAmbiguousRecovery(),
      ).catch(() => false);
      if (clearedManagers) {
        log.info("agents", { msg: "salesforce manager ambiguity alert cleared" });
      }
    }
    return NextResponse.json({
      ...sync,
      hoursApplied,
      emptyBuckets: coverage.empty,
      // Whether those buckets paged once for the set instead of once each, so the
      // response says which of the two happened rather than leaving it to be
      // inferred from Slack.
      emptyBucketsAggregated: coverage.aggregated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("agents", { msg: "cron failed", error: message });
    // Only alert on CONSECUTIVE failures (#486): a single transient blip (e.g. a
    // Cloudflare 522 to Salesforce) self-heals on the next hourly run.
    const consecutive = await recordFailureStreak(
      AGENTS_SYNC_STREAK_KEY,
      AGENTS_STREAK_WINDOW_S,
    );
    if (consecutive) {
      await sendThrottledAlert(
        "agent_sync_failures",
        SYNC_ALERT_COOLDOWN_MS,
        agentSyncFailureAlert(message.slice(0, 300)),
      ).catch(() => {});
    }
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await releaseLock("cron_agents", lock);
  }
}
