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
import { touchedBucketCodes } from "@/lib/availability/precompute";
import { recomputeBucketSlotsForToday } from "@/lib/availability/slot-cache";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { acquireLock, releaseLock } from "@/lib/locks";
import { CRON_LOCK_TTL_MS, SYNC_TICK_BUDGET_MS } from "@/lib/google/sync-coalesce";
import { sendThrottledAlert, resolveAlert, isAlertFiring } from "@/lib/notify/dispatch";
import {
  formatSyncFailureAlert,
  formatSyncRecoveryNotice,
  isConsecutiveFailure,
} from "@/lib/notify/alerts";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { alertOnStaleLanes } from "@/lib/monitor/lane-watchdog";
import { log } from "@/lib/log";

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
const SYNC_ALERT_KEY = "sync_failures";

/**
 * Say so when the sync-failure page clears (#1133). A no-op unless a page was
 * actually delivered, so it's safe to offer on every clean tick.
 */
async function resolveSyncFailureAlert(): Promise<void> {
  // Never throws: a monitoring failure must not become a sync failure (same rule
  // as alertOnStaleLanes below). The firing marker survives a failure, so the
  // notice is retried next tick rather than lost.
  try {
    const sent = await resolveAlert(SYNC_ALERT_KEY, formatSyncRecoveryNotice());
    if (sent) log.info("sync", { msg: "sync-failure alert cleared" });
  } catch (err) {
    log.error("sync", { msg: "recovery notice failed" }, err);
  }
}

async function alertSyncFailures(
  failed: { error?: string }[],
  totalAgents: number,
): Promise<void> {
  const db = supabaseAdmin();
  if (failed.length === 0) {
    // write-ok: a refused clear leaves the streak standing, so the next tick re-alerts rather than going quiet. Over-reporting is the safe direction for a streak.
    await db.from("rate_limits").delete().eq("key", SYNC_STREAK_KEY);
    // #1134: a clean tick is NOT proof the fleet is healthy. The tick is capped
    // (MAX_AGENTS_PER_SYNC_TICK) and budgeted (SYNC_TICK_BUDGET_MS), so an agent it
    // never reached contributes no error while its stored streak keeps climbing.
    // So prove health from the stored streaks before all-clearing, and only bother
    // when there is actually an outstanding page to clear.
    if (await isAlertFiring(SYNC_ALERT_KEY)) {
      const stillFailing = await loadFailingAgents();
      if (stillFailing !== null && stillFailing.length === 0) await resolveSyncFailureAlert();
    }
    return;
  }
  const { data: underLimit, error } = await db.rpc("rate_limit_hit", {
    p_key: SYNC_STREAK_KEY,
    p_window_seconds: SYNC_STREAK_WINDOW_S,
    p_max: 1,
  });
  if (error) {
    log.error("sync", { msg: "failure-streak tracking failed" }, error);
    return;
  }
  // rate_limit_hit returns false once the count exceeds 1 in the window,
  // i.e. from the second consecutive failing pass onward.
  if (!isConsecutiveFailure(underLimit === false ? 2 : 1)) return;
  // Name the persistently-failing agents from the diagnostics (#293), same as
  // the watch-lapse alert — not an anonymous count. If none are at the streak
  // threshold yet, stay quiet rather than send an empty-named alert.
  const failing = await loadFailingAgents();
  // #1134: null is "we could not read the health signal", which is NOT health. Stay
  // silent both ways: alerting would name no one, and all-clearing would announce a
  // recovery we have no evidence for. The every-minute lane retries.
  if (failing === null) return;
  // Nothing is at its paging threshold (including a lone transient agent still
  // inside the #1133 hold), so the paged condition is clear even though this tick
  // saw errors: say it cleared rather than leaving the reader in silence.
  if (failing.length === 0) {
    await resolveSyncFailureAlert();
    return;
  }
  await sendThrottledAlert(
    SYNC_ALERT_KEY,
    SYNC_ALERT_COOLDOWN_MS,
    formatSyncFailureAlert(failing, totalAgents, Date.now()),
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
            goneSkipped?: number;
            claimSkipped?: number;
            error?: string;
          } = { userId: agent.userId };
          try {
            const sync = await runIncrementalSync(agent.userId, deadlineMs);
            row.synced = sync.events;
            if (sync.truncated) row.truncated = true;
            // Only when there IS a backed-off calendar, so the overwhelmingly
            // common healthy row stays as small as it was.
            if (sync.goneSkipped > 0) row.goneSkipped = sync.goneSkipped;
            // #2411: and how many another pass was holding, which since #2411
            // includes the daily hydration re-bootstrap. Its own field, not folded
            // into goneSkipped: one is a delegation to repair and the other is a
            // pass that finishes by itself, and the next minute retries it.
            if (sync.claimSkipped > 0) row.claimSkipped = sync.claimSkipped;
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
      // One batched lookup for every changed agent (#762). A failed read logs and
      // yields nothing rather than failing the tick; the recompute lane's freshness
      // sweep is the backstop.
      const touched = await touchedBucketCodes(changed, MAX_TOUCHED_BUCKETS, "touched-bucket");
      // #216: one horizon read for the batch, not per bucket.
      const horizonDays = await loadBookingHorizonDays();
      for (const code of touched) {
        await recomputeBucketSlotsForToday(code, true, undefined, horizonDays).catch((err) =>
          // Best-effort: the recompute lane reconverges. Logged so a bucket that
          // never recomputes after a sync is findable.
          // #1188: the Error goes through so its stack survives, at warn rather
          // than error because the every-minute recompute lane is the backstop.
          log.warn("sync", { msg: "post-sync recompute failed", bucket: code }, err),
        );
      }
    }

    // The self-heal sweeps (#401 deletion drain, #428 cancelled-reconcile,
    // #431 missing-reconcile) moved to the dedicated /api/cron/selfheal lane
    // (#433): on a busy ~200-agent tick this sync pass exhausts its 25s budget,
    // so as a tail call they could be starved exactly when self-heal is needed
    // most. They now run under their own lock + guaranteed every-minute lane.

    // Dead-man's switch (#420, widened to every lane in #803). This used to watch
    // only the monitor lane, which meant a mid-run CPU kill could silently take
    // out recompute / outbox / selfheal and nothing would say so. Roughly 400
    // invocations were killed that way before #760 and nobody noticed for days.
    // Now every covered lane is judged against its own cadence bound. Never
    // throws: a monitoring failure must not become a sync failure.
    await alertOnStaleLanes();

    // truncated = agents deferred by the per-tick cap, OR unreached at the
    // budget deadline, OR an agent's own calendars didn't all finish.
    const truncated = deferred > 0 || budgetTruncated || results.some((r) => r.truncated);
    // #1187: how many calendars the #1049 gone-backoff held back this tick.
    const goneSkipped = results.reduce((n, r) => n + (r.goneSkipped ?? 0), 0);
    // #2411: how many were held by another pass (hydration, or a push sync).
    const claimSkipped = results.reduce((n, r) => n + (r.claimSkipped ?? 0), 0);
    // One line per cycle, always, mirroring the recompute lane. Two reasons it
    // is unconditional: a zero has to be STATED, because an absent field reads
    // the same as a lane that never ran, and this is the sync lane's positive
    // control when querying Worker logs (a query returning nothing is then a
    // wrong query, not proof of silence).
    log.info("sync", {
      msg: "cycle",
      agents: agents.length,
      deferred,
      processed,
      gone_skipped: goneSkipped,
      claim_skipped: claimSkipped,
      truncated,
    });
    // Dead-man's switch (#420/#685): prove this lane ran this tick. Best-effort.
    await recordHeartbeat("sync").catch(() => {});
    return NextResponse.json({
      agents: agents.length,
      deferred,
      processed,
      truncated,
      goneSkipped,
      claimSkipped,
      results,
    });
  } finally {
    await releaseLock("cron_sync", lock);
  }
}
