import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isAuthorizedCron } from "@/lib/cron";
import { runIncrementalSync, loadSyncAgents, markAgentSynced } from "@/lib/google/sync";
import { withinBudget, orderAgentsForTick } from "@/lib/google/sync-pace";
import { acquireLock, releaseLock } from "@/lib/locks";
import { CRON_LOCK_TTL_MS, SYNC_TICK_BUDGET_MS } from "@/lib/google/sync-coalesce";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { formatSyncFailureAlert, isConsecutiveFailure } from "@/lib/notify/alerts";

export const dynamic = "force-dynamic";

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

/**
 * Backstop sync (~1 min). Catches any push notification Google may have missed
 * and reconciles cached busy_blocks with Google. Watch renewal lives in the
 * independent watch lane (`/api/cron/watch`, #273) and slot-cache freshness in
 * the recompute lane, so a busy sync tick can no longer starve either.
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
    // One budget for the whole tick (#44/#238): we BREAK at the deadline so a
    // long pass can't run for every remaining agent after the budget is spent.
    // Unreached agents are picked up next tick (rotation sorts them first).
    // Real-time freshness meanwhile comes from Google push.
    const deadlineMs = Date.now() + SYNC_TICK_BUDGET_MS;
    const results: {
      userId: string;
      synced?: number;
      truncated?: boolean;
      error?: string;
    }[] = [];
    for (const agent of agents) {
      if (!withinBudget(Date.now(), deadlineMs)) break;
      // Brand-new agents have no calendars to sync yet — the watch lane
      // discovers and watches them first; skip until they're onboarded.
      if (!agent.hasCalendars) continue;

      const row: (typeof results)[number] = { userId: agent.userId };
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

    await alertSyncFailures(results.filter((r) => r.error), results.length);

    const truncated = results.some((r) => r.truncated);
    return NextResponse.json({
      agents: agents.length,
      processed: results.length,
      truncated,
      results,
    });
  } finally {
    await releaseLock("cron_sync", lock);
  }
}
