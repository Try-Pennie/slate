import { readAllHeartbeatMs } from "@/lib/monitor/heartbeat";
import { findStaleLanes, type StaleLane } from "@/lib/monitor/health";
import { sendThrottledAlert } from "@/lib/notify/dispatch";

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
  let stale: StaleLane[];
  try {
    stale = findStaleLanes(await readAllHeartbeatMs(), Date.now());
  } catch (err) {
    // A failed read is NOT evidence that every lane is fine, and it is not
    // evidence they are all dead either. Say so, and alarm on nothing.
    console.error(
      `lane-watchdog: heartbeat read failed, lane staleness unknown this tick: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }

  if (stale.length === 0) return [];

  console.warn(
    `lane-watchdog: ${stale.length} stale lane(s): ${stale
      .map((l) => `${l.lane}=${minutes(l.ageMs)}m`)
      .join(", ")}`,
  );

  for (const lane of stale) {
    await sendThrottledAlert(
      staleLaneAlertKey(lane.lane),
      STALE_LANE_COOLDOWN_MS,
      `Slate: the ${lane.lane} cron lane has not run for ${minutes(lane.ageMs)} minutes (bound ${minutes(
        lane.maxStaleMs,
      )}m). Its work is not happening. A mid-run CPU kill on the shared cron invocation is the usual cause (#760): check the Worker's outcome for exceededCpu, and the cron_${lane.lane} lock.`,
    ).catch((err) => {
      // One lane's failed Slack post must not skip the remaining lanes.
      console.error(
        `lane-watchdog: alert failed for lane "${lane.lane}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  return stale;
}
