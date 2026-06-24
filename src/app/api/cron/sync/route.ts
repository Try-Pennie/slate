import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isAuthorizedCron } from "@/lib/cron";
import {
  runIncrementalSync,
  loadSyncAgents,
  markAgentsSynced,
  loadFailingAgents,
} from "@/lib/google/sync";
import {
  orderAgentsForTick,
  mapWithConcurrency,
  agentsWithChanges,
  SYNC_CONCURRENCY,
  MAX_AGENTS_PER_SYNC_TICK,
  MAX_TOUCHED_AGENTS,
  MAX_TOUCHED_BUCKETS,
} from "@/lib/google/sync-pace";
import { bucketsForAgent } from "@/lib/availability/precompute";
import { recomputeBucketSlotsForToday } from "@/lib/availability/slot-cache";
import { acquireLock, releaseLock } from "@/lib/locks";
import { CRON_LOCK_TTL_MS, SYNC_TICK_BUDGET_MS } from "@/lib/google/sync-coalesce";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { formatSyncFailureAlert, isConsecutiveFailure } from "@/lib/notify/alerts";
import { processPendingEventDeletions } from "@/lib/booking/service";

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
  // Name the persistently-failing agents from the diagnostics (#293), same as
  // the watch-lapse alert — not an anonymous count. If none are at the streak
  // threshold yet, stay quiet rather than send an empty-named alert.
  const failing = await loadFailingAgents();
  if (failing.length === 0) return;
  await sendThrottledAlert(
    "sync_failures",
    SYNC_ALERT_COOLDOWN_MS,
    formatSyncFailureAlert(failing, totalAgents),
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
    // Brand-new agents have no calendars to sync yet — the watch lane discovers
    // and watches them first, so skip them here until they're onboarded.
    const ordered = orderAgentsForTick(await loadSyncAgents()).filter(
      (a) => a.hasCalendars,
    );
    // Cap agents per tick (#273 Inc 5) so one invocation's total outbound calls
    // stay under the Worker subrequest ceiling at 200 agents; the rest are
    // picked up next tick (rotation sorts least-recently-synced first).
    const agents = ordered.slice(0, MAX_AGENTS_PER_SYNC_TICK);
    const deferred = ordered.length - agents.length;
    // One budget for the whole tick (#44/#238): the pool stops STARTING new
    // agents at the deadline so a long pass can't run for every remaining
    // agent. Unreached agents are picked up next tick (rotation sorts them
    // first). Real-time freshness meanwhile comes from Google push.
    // Agents are processed CONCURRENTLY up to SYNC_CONCURRENCY (#242): the old
    // sequential loop's per-agent Google I/O blew the budget before ~30 agents.
    const deadlineMs = Date.now() + SYNC_TICK_BUDGET_MS;
    const { results, processed, truncated: budgetTruncated } =
      await mapWithConcurrency(
        agents,
        SYNC_CONCURRENCY,
        async (agent) => {
          const row: {
            userId: string;
            synced?: number;
            truncated?: boolean;
            error?: string;
          } = { userId: agent.userId };
          try {
            const sync = await runIncrementalSync(agent.userId, deadlineMs);
            row.synced = sync.events;
            if (sync.truncated) row.truncated = true;
          } catch (err) {
            row.error = err instanceof Error ? err.message : String(err);
          }
          return row;
        },
        { deadlineMs },
      );

    // Stamp rotation for every agent we processed this tick in ONE write (#243)
    // instead of an UPDATE per agent inside the loop.
    await markAgentsSynced(results.map((r) => r.userId));

    await alertSyncFailures(results.filter((r) => r.error), ordered.length);

    // A missed Google push means the change only surfaced now, via this
    // backstop. Refresh the affected buckets inline (#296) so it shows in ~1 min
    // instead of waiting for the recompute lane's freshness window. Deduped
    // across agents and bounded (MAX_TOUCHED_*) so a burst can't blow the
    // subrequest ceiling; any overflow is caught by the recompute lane. Usually
    // a no-op — most ticks have no changes (push handles the common case).
    const changed = agentsWithChanges(results, MAX_TOUCHED_AGENTS);
    if (changed.length > 0) {
      const touched = new Set<string>();
      for (const id of changed) {
        // bucketsForAgent now fails loud on a DB error (#313); isolate it per
        // agent so one bad lookup logs and is skipped instead of failing the
        // whole tick (the recompute lane's freshness sweep still backstops).
        try {
          for (const code of await bucketsForAgent(id)) touched.add(code);
        } catch (err) {
          console.error(
            `touched-bucket lookup failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      for (const code of [...touched].slice(0, MAX_TOUCHED_BUCKETS)) {
        await recomputeBucketSlotsForToday(code, true).catch(() => {});
      }
    }

    // Drain a small batch of failed-event-deletion retries (#401). Best-effort:
    // a failure here must never break the sync lane.
    await processPendingEventDeletions(20).catch(() => {});

    // truncated = agents deferred by the per-tick cap, OR unreached at the
    // budget deadline, OR an agent's own calendars didn't all finish.
    const truncated = deferred > 0 || budgetTruncated || results.some((r) => r.truncated);
    return NextResponse.json({
      agents: agents.length,
      deferred,
      processed,
      truncated,
      results,
    });
  } finally {
    await releaseLock("cron_sync", lock);
  }
}
