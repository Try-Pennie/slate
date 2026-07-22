import { readAllHeartbeatMs } from "@/lib/monitor/heartbeat";
import {
  findStaleLanes,
  CANARY_STALE_BOUNDS_MS,
  type StaleLane,
} from "@/lib/monitor/health";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
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

  if (stale.length === 0 && canaryStale.length === 0) return [];

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

  return [...stale, ...canaryStale];
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
