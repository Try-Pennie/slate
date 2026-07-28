import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { ensureWatches, loadSyncAgents, loadFailingAgents } from "@/lib/google/sync";
import {
  orderAgentsForTick,
  watchAgentsForTick,
  mapWithConcurrency,
  SYNC_CONCURRENCY,
} from "@/lib/google/sync-pace";
import { acquireLock, releaseLock } from "@/lib/locks";
import { WATCH_LOCK_TTL_MS, SYNC_TICK_BUDGET_MS } from "@/lib/google/sync-coalesce";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { formatWatchLapseAlert, type FailingAgent } from "@/lib/notify/alerts";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";

export const dynamic = "force-dynamic";

const WATCH_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // don't re-alert within 30 min

/** Post a throttled Slack alert NAMING the persistently-failing agents (#273). */
async function alertWatchLapse(failing: FailingAgent[], totalAgents: number): Promise<void> {
  if (failing.length === 0) return;
  await sendThrottledAlert(
    "watch_lapse",
    WATCH_ALERT_COOLDOWN_MS,
    formatWatchLapseAlert(failing, totalAgents, Date.now()),
  );
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
    return new NextResponse("unauthorized", { status: 401 });
  }

  const lock = await acquireLock("cron_watch", WATCH_LOCK_TTL_MS);
  if (!lock) {
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
    if (watchErrors > 0) {
      await alertWatchLapse(await loadFailingAgents(), ordered.length);
    }

    // Dead-man's switch (#420/#685): prove this lane ran this tick. Best-effort.
    await recordHeartbeat("watch").catch(() => {});
    return NextResponse.json({
      agents: ordered.length,
      processed: results.length,
      onboarded: toProcess.filter((a) => !a.hasCalendars).length,
      watchErrors,
      truncated,
      results,
    });
  } finally {
    await releaseLock("cron_watch", lock);
  }
}
