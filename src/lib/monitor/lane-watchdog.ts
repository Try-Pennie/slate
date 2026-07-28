import { readAllHeartbeatMs } from "@/lib/monitor/heartbeat";
import {
  findStaleLanes,
  CANARY_STALE_BOUNDS_MS,
  MIRROR_STALE_BOUNDS_MS,
  RETENTION_STALE_BOUNDS_MS,
  retentionAlertText,
  neverStampedVerdict,
  type StaleLane,
} from "@/lib/monitor/health";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";

/** Per lane, so one dead lane can't throttle away the first alert for another. */
const staleLaneAlertKey = (lane: string) => `cron_lane_stale:${lane}`;

/** A dead lane stays dead, so re-page hourly rather than every minute. */
const STALE_LANE_COOLDOWN_MS = 60 * 60_000;

const minutes = (ms: number) => Math.round(ms / 60_000);

/**
 * The cron dead-man's switch (#803): alert on every lane that has gone quiet.
 *
 * Before the #760 CPU fix, roughly 400 every-minute invocations were killed by
 * the CPU ceiling. Whichever lanes had not finished simply did not run, and
 * nobody noticed for days; it was found by accident. The lanes are idempotent
 * and self-heal on the next tick, so the impact was low, but the SILENCE is the
 * real defect, and the risk returns as the roster grows toward 200 agents.
 *
 * Detection is by ABSENCE, deliberately. A killed invocation cannot report its
 * own death (it is killed), so the only in-band signal is a lane that stopped
 * stamping. That also makes this cause-agnostic: a CPU kill, a crash, a stuck
 * lock and a bad deploy all surface identically. The alternative, querying
 * Cloudflare's observability API for non-`ok` outcomes, would need a new API
 * token in the Worker and would rest on the very query semantics that have twice
 * produced a confident wrong answer here (#708, #801). A zero from a subtly
 * wrong query reads exactly like "no kills".
 *
 * Called from the sync lane (every minute) AND the monitor lane (every 5 min) so
 * the two watch each other: whichever survives an invocation reports the other.
 * The per-lane cooldown dedupes the overlap. If BOTH die, nothing in-Worker can
 * see it, which is what the external uptime check on /api/health is for (#749).
 *
 * Never throws. It runs inside a cron lane, and a watchdog that takes down the
 * sync tick would be worse than the silence it replaces.
 */
export async function alertOnStaleLanes(): Promise<StaleLane[]> {
  let heartbeats: Record<string, number | null>;
  try {
    heartbeats = await readAllHeartbeatMs();
  } catch (err) {
    // A failed read is NOT evidence that every lane is fine, and it is not
    // evidence they are all dead either. Say so, and alarm on nothing.
    log.error(
      "lane-watchdog",
      { msg: "heartbeat read failed, lane staleness unknown this tick" },
      err,
    );
    return [];
  }
  const now = Date.now();
  const stale = findStaleLanes(heartbeats, now);
  // The external booking-smoke canary (#525) is judged against its OWN bound and
  // alerts with its OWN copy: it is a scheduled GitHub Actions workflow, not a
  // Worker cron lane, so a CPU-kill message would be wrong and it must never touch
  // the external /api/health signal.
  const canaryStale = findStaleLanes(heartbeats, now, CANARY_STALE_BOUNDS_MS);
  // The Snowflake mirror export lane (#1101) is judged against its OWN bound and,
  // like the canary, alerts to Slack only: a stale mirror means the analytics
  // warehouse is going stale, not that the app is down, so it must never touch
  // the external /api/health signal.
  const mirrorStale = findStaleLanes(heartbeats, now, MIRROR_STALE_BOUNDS_MS);
  // The three daily retention lanes (#1102), judged against their own 28h bound.
  // `neverIsStale` is ON for these: a lane that throws on its first run never
  // stamps, and these lanes destroy customer data, so silent-forever is the worse
  // failure. Slack only, like the mirror: stalled retention is a compliance and
  // storage problem, not an app outage, so it must not touch /api/health.
  const retentionStale = findStaleLanes(heartbeats, now, RETENTION_STALE_BOUNDS_MS, true);

  if (
    stale.length === 0 &&
    canaryStale.length === 0 &&
    mirrorStale.length === 0 &&
    retentionStale.length === 0
  ) {
    return [];
  }

  if (stale.length > 0) {
    log.warn("lane-watchdog", {
      msg: "stale lanes",
      count: stale.length,
      lanes: stale.map((l) => `${l.lane}=${minutes(l.ageMs)}m`).join(","),
    });
    for (const lane of stale) {
      await sendThrottledAlert(
        staleLaneAlertKey(lane.lane),
        STALE_LANE_COOLDOWN_MS,
        `Slate: the ${lane.lane} cron lane has not run for ${minutes(lane.ageMs)} minutes (bound ${minutes(
          lane.maxStaleMs,
        )}m). Its work is not happening. A mid-run CPU kill on the shared cron invocation is the usual cause (#760): check the Worker's outcome for exceededCpu, and the cron_${lane.lane} lock.`,
      ).catch((err) => {
        // One lane's failed Slack post must not skip the remaining lanes.
        log.error("lane-watchdog", { msg: "alert failed", lane: lane.lane }, err);
      });
    }
  }

  for (const lane of canaryStale) {
    log.warn("lane-watchdog", {
      msg: "canary stale",
      lane: lane.lane,
      age_min: minutes(lane.ageMs),
    });
    await sendThrottledAlert(
      staleLaneAlertKey(lane.lane),
      STALE_LANE_COOLDOWN_MS,
      canaryAlertText(lane.lane, minutes(lane.ageMs), minutes(lane.maxStaleMs)),
    ).catch((err) => {
      log.error("lane-watchdog", { msg: "alert failed", lane: lane.lane }, err);
    });
  }

  for (const lane of mirrorStale) {
    log.warn("lane-watchdog", { msg: "mirror lane stale", lane: lane.lane, age_min: minutes(lane.ageMs) });
    await sendThrottledAlert(
      staleLaneAlertKey(lane.lane),
      STALE_LANE_COOLDOWN_MS,
      mirrorAlertText(lane.lane, minutes(lane.ageMs), minutes(lane.maxStaleMs)),
    ).catch((err) => {
      log.error("lane-watchdog", { msg: "alert failed", lane: lane.lane }, err);
    });
  }

  for (const lane of retentionStale) {
    // A lane that has NEVER stamped gets a grace window before it can page (#1102).
    // Without it, deploying the heartbeat code paged every daily lane until its
    // first 03:00 run, with copy claiming it had failed every run. See
    // neverStampedVerdict.
    if (!Number.isFinite(lane.ageMs)) {
      const verdict = neverStampedVerdict(await readFirstSeenMissingMs(lane.lane), now, lane.maxStaleMs);
      if (verdict === "record-first-sighting") {
        await recordFirstSeenMissing(lane.lane);
        log.info("lane-watchdog", { msg: "retention lane not yet seen; starting its grace window", lane: lane.lane });
        continue;
      }
      if (verdict === "wait") continue;
    } else {
      // It has stamped, so any earlier sighting is history: clear it so a future
      // disappearance starts a fresh window rather than paging instantly.
      await clearFirstSeenMissing(lane.lane);
    }
    log.warn("lane-watchdog", {
      msg: "retention lane stale",
      lane: lane.lane,
      age_min: Number.isFinite(lane.ageMs) ? minutes(lane.ageMs) : -1,
    });
    await sendThrottledAlert(
      staleLaneAlertKey(lane.lane),
      STALE_LANE_COOLDOWN_MS,
      retentionAlertText(lane.lane, lane.ageMs, minutes(lane.maxStaleMs)),
    ).catch((err) => {
      log.error("lane-watchdog", { msg: "alert failed", lane: lane.lane }, err);
    });
  }

  return [...stale, ...canaryStale, ...mirrorStale, ...retentionStale];
}


/**
 * Canary alert copy, keyed by which pass went quiet (#525, #982). The 30-min dry
 * tick and the 6h full pass are separate heartbeats: a stale dry tick means the
 * whole canary stopped, while a stale `smoke-canary-full` means only the full
 * end-to-end booking proof stopped (the dry tick may still be fine), and recovery
 * is a full-pass re-run, so the two need distinct, actionable messages.
 */
function canaryAlertText(lane: string, ageMin: number, boundMin: number): string {
  if (lane === "smoke-canary-full") {
    return `Slate: the booking smoke canary's full end to end pass (create, reschedule, cancel) has not run for ${ageMin} minutes (bound ${boundMin}m), so the automated proof that a booking can actually be made is no longer running (the quick health tick may still be fine). Both the 6h scheduled run and the Worker gap filler have failed to complete it. Re run it from the Actions tab (Run workflow on smoke-canary, mode full).`;
  }
  return `Slate: the booking smoke canary has not run for ${ageMin} minutes (bound ${boundMin}m), so the automated end to end booking check is no longer running. The scheduled GitHub Actions workflow (smoke-canary) has likely stopped firing or is failing before it can report. Check the Actions tab and re run it.`;
}

/**
 * Snowflake-mirror alert copy, keyed by which lane went quiet (#1101, #1123).
 *
 * The three lanes fail for different reasons and are recovered differently: the
 * export FEEDS the warehouse, while reconcile and the erasure audit are the two
 * CHECKS on it, on a different cron expression and different locks. One shared
 * message used to name the export lane and its every-10-minutes lock for all of
 * them, which would point a responder at the wrong lane and lock. Each lane
 * gets its own cause and its own next step, and each says plainly that the app
 * itself is unaffected so nobody treats it as an outage.
 */
function mirrorAlertText(lane: string, ageMin: number, boundMin: number): string {
  if (lane === "snowflake-reconcile") {
    return `Slate: the check that compares the live database against the Snowflake mirror has not run for ${ageMin} minutes (bound ${boundMin}m), so nothing is verifying that the warehouse still matches the source (the app itself is unaffected). Anything that trusts the mirror being complete, including export gated deletion, should be treated as unverified until this clears. Check the cron_snowflake_reconcile lock and the Worker outcome for the 6h lane.`;
  }
  if (lane === "erasure-audit") {
    return `Slate: the check that proves an erased person's data is really gone from the Snowflake warehouse has not run for ${ageMin} minutes (bound ${boundMin}m), so a deletion request could be sitting half finished with nobody watching (the app itself is unaffected). This is the only automated check on the operator's manual warehouse purge step. Check the cron_erasure_audit lock and the Worker outcome for the 6h lane.`;
  }
  return `Slate: the Snowflake mirror export lane has not run for ${ageMin} minutes (bound ${boundMin}m), so the analytics warehouse is going stale (the app itself is unaffected). Check the cron_snowflake_export lock and the Worker outcome for the */10 lane.`;
}


/**
 * The "first noticed missing" marker for a never-stamped lane (#1102).
 *
 * Stored in `alert_state`, which is already a generic key-to-timestamp table with
 * deny-all RLS, so this needs no migration. The key is namespaced away from the
 * alert cooldown keys (`cron_lane_stale:*`) so the two cannot collide.
 *
 * All three helpers are best-effort and never throw: they run inside a cron lane,
 * and a watchdog that takes down the sync tick is worse than a late alert. A failed
 * READ returns null, which means "record a first sighting", so the worst case is a
 * page deferred by one bound rather than a false page.
 */
const firstSeenKey = (lane: string) => `lane_never_seen:${lane}`;

async function readFirstSeenMissingMs(lane: string): Promise<number | null> {
  try {
    // error-ok: a read failure defers the page by one bound; it never causes a
    // false page, and the next tick retries.
    const { data } = await supabaseAdmin()
      .from("alert_state")
      .select("last_sent_at")
      .eq("key", firstSeenKey(lane))
      .maybeSingle();
    const at = (data as { last_sent_at: string } | null)?.last_sent_at;
    return at ? Date.parse(at) : null;
  } catch (err) {
    log.warn("lane-watchdog", { msg: "first-sighting read failed", lane });
    void err;
    return null;
  }
}

async function recordFirstSeenMissing(lane: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from("alert_state")
      .upsert({ key: firstSeenKey(lane), last_sent_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) log.warn("lane-watchdog", { msg: "first-sighting write failed", lane, error: error.message });
  } catch (err) {
    log.warn("lane-watchdog", { msg: "first-sighting write threw", lane });
    void err;
  }
}

async function clearFirstSeenMissing(lane: string): Promise<void> {
  try {
    await supabaseAdmin().from("alert_state").delete().eq("key", firstSeenKey(lane));
  } catch (err) {
    log.warn("lane-watchdog", { msg: "first-sighting clear failed", lane });
    void err;
  }
}
