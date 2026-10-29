/**
 * The every minute lanes' backstop, run on the five minute tick (2026-10-29).
 *
 * Cloudflare has stopped delivering the `* * * * *` trigger on its own while every other
 * schedule on this Worker kept firing: 14 minutes on 2026-10-29 (4:52 to 5:06 AM ET, no
 * status page incident), 10 on 2026-10-26 (inside Cloudflare's "Delayed, missed, and
 * duplicated Workers Cron Triggers" incident), and twelve gaps of 3 to 9 minutes on
 * 2026-10-27. Nothing on Slate's side fails when it happens: the Worker is simply never
 * invoked, so no code of ours can notice from inside that trigger.
 *
 * So the five minute tick asks the app which every minute lanes have not claimed a tick in
 * three minutes (`/api/cron/minute-backstop`, which reads `lane_runs`), and starts exactly
 * those, each through its own route exactly as the minute tick would: its own claim on
 * this tick, its own lock, its own heartbeat. What keeps it safe:
 *
 * - A lane that is running, or ran in the last three minutes, has a recent claim (a lane
 *   claims at its START), so it is not named and not started.
 * - A lane still running after three minutes holds its lock, and the lane's own route
 *   refuses the second run, as it would a late minute tick.
 * - A check that fails, throws, or answers anything but a list of every minute lanes starts
 *   NOTHING, and says `unreadable` on the timings line with an error line beside it. The
 *   check route pages about its own failed read (`minute_backstop_unreadable`), so a broken
 *   backstop is never silently read as "nothing was overdue".
 * - The deployment's SLATE_LANES_DISABLED still holds back any lane it names.
 *
 * WHAT IT COSTS. On a healthy tick, one placed request (the check: one indexed read of about
 * 55 rows) and no lane: 288 small invocations a day, billed on their own CPU, not this
 * invocation's. The dispatcher's own CPU grows by one more fetch and a JSON parse. Only on a
 * tick where Cloudflare has skipped the minute trigger does it start up to four lanes, each
 * as the placed invocation the minute tick would have made.
 *
 * Pure apart from the injected fetch, clock and log; `scripts/test-minute-lane-backstop.ts`
 * drives it.
 */
import { laneFieldName } from "@/lib/monitor/lane-timing";
import { parseBackstopAnswer } from "@/lib/monitor/minute-lane-claims";
import { ANSWER_READ_MS, askApp, readThrough, runLane, type LaneRunDeps, type LaneTick } from "./lane-run";

/** The app route that judges which every minute lanes are overdue. */
export const MINUTE_BACKSTOP_PATH = "/api/cron/minute-backstop";

type LaneOutcome = Awaited<ReturnType<typeof runLane>>;

/**
 * What the backstop did, for the timings line: `none` (nothing overdue), `started:a+b` (the
 * lanes it started), or `unreadable` (the check failed, so it started nothing).
 */
export type BackstopSummary = "none" | "unreadable" | `started:${string}`;

/**
 * Run the backstop. Never throws: the five minute tick's own lanes run beside it and must
 * not be taken down by it. `allowed` is the deployment's lane decision
 * (SLATE_LANES_DISABLED), applied to what the check names.
 */
export async function runMinuteBackstop(
  tick: LaneTick,
  deps: LaneRunDeps,
  allowed: (paths: string[]) => string[],
): Promise<{ summary: BackstopSummary; outcomes: LaneOutcome[] }> {
  let overdue: string[] | null = null;
  let status: number | null = null;
  try {
    const { res } = await askApp(MINUTE_BACKSTOP_PATH, tick, deps);
    status = res.status;
    const answer = await readThrough(res, ANSWER_READ_MS, deps.wait);
    if (res.ok && answer.outcome === "read") overdue = parseBackstopAnswer(answer.text);
  } catch (err) {
    deps.log.error(
      "cron",
      { msg: "the every minute backstop could not read the lanes' claims, so it started nothing", tick: tick.tickId, status: "threw" },
      err,
    );
    return { summary: "unreadable", outcomes: [] };
  }
  if (overdue === null) {
    deps.log.error("cron", {
      msg: "the every minute backstop could not read the lanes' claims, so it started nothing",
      tick: tick.tickId,
      status: status ?? "none",
    });
    return { summary: "unreadable", outcomes: [] };
  }
  const start = allowed(overdue);
  if (start.length === 0) return { summary: "none", outcomes: [] };
  deps.log.info("cron", {
    msg: "the every minute trigger has not run these lanes in three minutes, so the five minute tick started them",
    tick: tick.tickId,
    lanes: start.map(laneFieldName).join(","),
  });
  const outcomes = await Promise.all(start.map((path) => runLane(path, tick, deps)));
  return { summary: `started:${start.map(laneFieldName).join("+")}`, outcomes };
}
