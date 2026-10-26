import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { ensureWatches, loadSyncAgents, loadFailingAgents } from "@/lib/google/sync";
import {
  orderAgentsForTick,
  watchAgentsForTick,
  mapWithConcurrency,
  SYNC_CONCURRENCY,
} from "@/lib/google/sync-pace";
import { acquireLease, releaseLock } from "@/lib/locks";
import { WATCH_LOCK_TTL_MS, SYNC_TICK_BUDGET_MS } from "@/lib/google/sync-coalesce";
import { sendThrottledAlert, resolveAlert, isAlertFiring } from "@/lib/notify/dispatch";
import { formatWatchLapseAlert, type FailingAgent } from "@/lib/notify/alerts";
import { leaseHeldThroughout } from "@/lib/monitor/lease-heartbeat";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { log } from "@/lib/log";
import { watchLapseRecovery } from "@/lib/notify/misc-alert-copy";

export const dynamic = "force-dynamic";

const WATCH_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // don't re-alert within 30 min

const WATCH_ALERT_KEY = "watch_lapse";

/**
 * Post a throttled Slack alert NAMING the persistently-failing agents (#273), and
 * say so when the condition CLEARS (#1134).
 *
 * `failing === null` means the health signal could not be read, which is not health:
 * stay silent both ways rather than announce a recovery there is no evidence for.
 * An empty list is genuine health, established from the stored per-calendar streaks
 * rather than from this lane merely having nothing to report.
 */
async function alertWatchLapse(
  failing: FailingAgent[] | null,
  totalAgents: number,
): Promise<void> {
  if (failing === null) return;
  if (failing.length > 0) {
    await sendThrottledAlert(
      WATCH_ALERT_KEY,
      WATCH_ALERT_COOLDOWN_MS,
      formatWatchLapseAlert(failing, totalAgents, Date.now()),
    );
    return;
  }
  const cleared = await resolveAlert(
    WATCH_ALERT_KEY,
    watchLapseRecovery(),
  );
  if (cleared) log.info("watch", { msg: "watch-lapse alert cleared" });
}

/**
 * WATCH lane (~5 min): reconciles each agent's watched calendar set and
 * renews push channels nearing expiry. Split off the 1-min sync tick (#273)
 * because the watch TTL is ~7 days (renewal threshold 3 days) — it never
 * needed a 1-min cadence, and sharing the tick let a busy sync starve it.
 * Also the onboarding path: ensureWatches is what discovers a brand-new
 * agent's calendars (the agent_calendars rows the sync lane then bootstraps),
 * so first-time setup is capped per tick and drains across ticks.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/watch");
  if (claimed) return claimed;

  // lock-overlap: fenced. Two runs renewing one calendar each open a Google push
  // channel, and the one not recorded is orphaned until it expires. The lease
  // renews before each agent and the tick stops starting agents once another holds
  // the key (#3120).
  const lease = await acquireLease("cron_watch", WATCH_LOCK_TTL_MS);
  if (!lease) {
    return NextResponse.json({ skipped: "overlapping-run" });
  }

  try {
    const ordered = orderAgentsForTick(await loadSyncAgents());
    // Every already-onboarded agent + a capped batch of brand-new ones; the
    // onboarding cap is pre-selected (not a running counter) so the lane can
    // run CONCURRENTLY (#302) — sequential per-agent work was budget-limited to
    // ~104/200 at scale. ensureWatches is mostly a cheap DB read on the common
    // "current" path, so concurrency lets one tick cover the whole roster.
    const toProcess = watchAgentsForTick(ordered);
    const deadlineMs = Date.now() + SYNC_TICK_BUDGET_MS;
    const { results, truncated } = await mapWithConcurrency(
      toProcess,
      SYNC_CONCURRENCY,
      async (agent) => {
        if (!(await lease.stillHeld())) return { userId: agent.userId, watch: "lease-lost" as const };
        const watch = await ensureWatches(agent.userId);
        return {
          userId: agent.userId,
          watch: watch.status,
          ...(watch.status === "error" ? { watchError: watch.error } : {}),
        };
      },
      { deadlineMs },
    );

    // When this tick saw watch errors, name the PERSISTENTLY-failing agents
    // (consecutive_failures >= the threshold) from the diagnostics — a one-off
    // blip (streak of 1) stays quiet; the 30-min cooldown bounds repeats.
    const watchErrors = results.filter((r) => r.watch === "error").length;
    // #1134: also enter this when a page is OUTSTANDING and this tick saw no errors,
    // which is precisely what recovery looks like. Gating solely on `watchErrors > 0`
    // would make the recovery notice unreachable: a healed condition produces zero
    // errors by definition. isAlertFiring is one cheap read, so the healthy no-alert
    // case (almost every tick) pays nothing more than that.
    if (watchErrors > 0 || (await isAlertFiring(WATCH_ALERT_KEY))) {
      // #1150: the WATCH lane's own counter. This used to read the sync lane's,
      // which the 1-min sync tick reset on every success, so a renewal failure
      // was erased before it could reach a threshold and this alert could only
      // fire for an account that was failing both ways.
      await alertWatchLapse(await loadFailingAgents("watch"), ordered.length);
    }

    // Dead-man's switch (#420/#685): prove this lane ran this tick. Best-effort.
    // #3120: withheld when the lease was lost part way, so the gap pages.
    if (leaseHeldThroughout(lease, "watch")) await recordHeartbeat("watch").catch(() => {});
    return NextResponse.json({
      agents: ordered.length,
      processed: results.length,
      onboarded: toProcess.filter((a) => !a.hasCalendars).length,
      watchErrors,
      truncated,
      results,
    });
  } finally {
    await releaseLock("cron_watch", lease.token());
  }
}
