import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { ensureWatches, loadSyncAgents } from "@/lib/google/sync";
import {
  withinBudget,
  orderAgentsForTick,
  shouldOnboard,
} from "@/lib/google/sync-pace";
import { acquireLock, releaseLock } from "@/lib/locks";
import { WATCH_LOCK_TTL_MS, SYNC_TICK_BUDGET_MS } from "@/lib/google/sync-coalesce";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { formatWatchLapseAlert } from "@/lib/notify/alerts";

export const dynamic = "force-dynamic";

const WATCH_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // don't re-alert within 30 min

/** Post a throttled Slack alert when watch renewals are failing. */
async function alertWatchLapse(watchErrors: number, totalAgents: number): Promise<void> {
  if (watchErrors === 0) return;
  await sendThrottledAlert(
    "watch_lapse",
    WATCH_ALERT_COOLDOWN_MS,
    formatWatchLapseAlert(watchErrors, totalAgents),
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
    const agents = orderAgentsForTick(await loadSyncAgents());
    const deadlineMs = Date.now() + SYNC_TICK_BUDGET_MS;
    const results: { userId: string; watch: string; watchError?: string }[] = [];
    let onboarded = 0;
    for (const agent of agents) {
      if (!withinBudget(Date.now(), deadlineMs)) break;
      // A brand-new agent needs ~2 Google calls to set up watches; cap how many
      // we onboard per tick so a fresh roster drains over several ticks instead
      // of blowing the budget. Already-onboarded agents are always processed
      // (their ensureWatches is a cheap DB read unless a renewal is due).
      if (!agent.hasCalendars && !shouldOnboard(agent, onboarded)) continue;

      const watch = await ensureWatches(agent.userId);
      // Count any brand-new agent whose setup ran the Google path (renewed OR
      // error) against the per-tick cap — "skipped" makes no Google calls.
      if (!agent.hasCalendars && watch.status !== "skipped") onboarded++;
      results.push({
        userId: agent.userId,
        watch: watch.status,
        ...(watch.status === "error" ? { watchError: watch.error } : {}),
      });
    }

    const watchErrors = results.filter((r) => r.watch === "error").length;
    await alertWatchLapse(watchErrors, results.length);

    return NextResponse.json({
      agents: agents.length,
      processed: results.length,
      onboarded,
      watchErrors,
      results,
    });
  } finally {
    await releaseLock("cron_watch", lock);
  }
}
