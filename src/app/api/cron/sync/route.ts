import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isAuthorizedCron } from "@/lib/cron";
import {
  ensureWatches,
  runIncrementalSync,
  loadSyncAgents,
  markAgentSynced,
} from "@/lib/google/sync";
import {
  withinBudget,
  orderAgentsForTick,
  shouldOnboard,
} from "@/lib/google/sync-pace";
import { acquireLock, releaseLock } from "@/lib/locks";
import { CRON_LOCK_TTL_MS, SYNC_TICK_BUDGET_MS } from "@/lib/google/sync-coalesce";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import {
  formatSyncFailureAlert,
  formatWatchLapseAlert,
  isConsecutiveFailure,
} from "@/lib/notify/alerts";

export const dynamic = "force-dynamic";

const WATCH_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // don't re-alert within 30 min

/**
 * Alert when calendar sync errors on CONSECUTIVE passes (#43). The streak
 * counter rides the #31 rate_limit_hit function: each failing pass bumps the
 * key inside a 10-minute window, a clean pass deletes it, and the second
 * consecutive bump (count > max of 1) trips the throttled Slack alert - so a
 * one-off Google blip stays quiet.
 */
const SYNC_STREAK_KEY = "cron_sync_failures";
const SYNC_STREAK_WINDOW_S = 600;
const SYNC_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

async function alertSyncFailures(
  failed: { error?: string }[],
  totalAgents: number,
): Promise<void> {
  const db = supabaseAdmin();
  if (failed.length === 0) {
    await db.from("rate_limits").delete().eq("key", SYNC_STREAK_KEY);
    return;
  }
  const { data: underLimit, error } = await db.rpc("rate_limit_hit", {
    p_key: SYNC_STREAK_KEY,
    p_window_seconds: SYNC_STREAK_WINDOW_S,
    p_max: 1,
  });
  if (error) {
    console.error(`sync-failure streak tracking failed: ${error.message}`);
    return;
  }
  // rate_limit_hit returns false once the count exceeds 1 in the window,
  // i.e. from the second consecutive failing pass onward.
  if (!isConsecutiveFailure(underLimit === false ? 2 : 1)) return;
  await sendThrottledAlert(
    "sync_failures",
    SYNC_ALERT_COOLDOWN_MS,
    formatSyncFailureAlert(failed.length, totalAgents, failed[0]?.error ?? null),
  );
}

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
 * Backstop sync (~1 min). Catches any push notification Google may have missed
 * and renews watch channels nearing expiry.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  // A slow pass (full resync) can outlive the 1-minute cadence; overlapping
  // invocations would re-sync every calendar in parallel for nothing (#30).
  const lock = await acquireLock("cron_sync", CRON_LOCK_TTL_MS);
  if (!lock) {
    return NextResponse.json({ skipped: "overlapping-run" });
  }

  try {
    // Bookable agents with their pacing facts (DB only, no Google calls).
    const agents = orderAgentsForTick(await loadSyncAgents());
    // One budget for the whole tick (#44/#238): we BREAK at the deadline so
    // watch setup can't run for every remaining agent after the budget is
    // spent. Unreached agents are picked up next tick (rotation makes them
    // sort first). Real-time freshness meanwhile comes from Google push.
    const deadlineMs = Date.now() + SYNC_TICK_BUDGET_MS;
    const results: {
      userId: string;
      watch: string;
      watchError?: string;
      synced?: number;
      truncated?: boolean;
      error?: string;
    }[] = [];
    let onboarded = 0;
    for (const agent of agents) {
      if (!withinBudget(Date.now(), deadlineMs)) break;
      // A brand-new agent needs ~2 Google calls to set up watches; cap how many
      // we onboard per tick so a fresh roster drains over several minutes
      // instead of blowing the budget in one ~100s run. Already-onboarded
      // agents are always processed (their ensureWatches is a cheap DB read
      // unless a renewal is genuinely due).
      if (!agent.hasCalendars && !shouldOnboard(agent, onboarded)) continue;

      const watch = await ensureWatches(agent.userId);
      if (!agent.hasCalendars && watch.status === "renewed") onboarded++;
      const row: (typeof results)[number] = {
        userId: agent.userId,
        watch: watch.status,
        ...(watch.status === "error" ? { watchError: watch.error } : {}),
      };
      try {
        const sync = await runIncrementalSync(agent.userId, deadlineMs);
        row.synced = sync.events;
        if (sync.truncated) row.truncated = true;
      } catch (err) {
        row.error = err instanceof Error ? err.message : String(err);
      }
      await markAgentSynced(agent.userId);
      results.push(row);
    }

    const watchErrors = results.filter((r) => r.watch === "error").length;
    await alertWatchLapse(watchErrors, results.length);
    await alertSyncFailures(results.filter((r) => r.error), results.length);

    const truncated = results.some((r) => r.truncated);
    return NextResponse.json({
      agents: agents.length,
      processed: results.length,
      onboarded,
      watchErrors,
      truncated,
      results,
    });
  } finally {
    await releaseLock("cron_sync", lock);
  }
}
