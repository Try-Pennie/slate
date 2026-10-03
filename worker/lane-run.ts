/**
 * One cron lane's run inside a scheduled tick, and what happens when it fails
 * (#3133), with the tick's correlation id threaded through both (#3139).
 *
 * Lifted out of `worker/index.ts` because that file imports the generated
 * `.open-next/worker.js` and so cannot be loaded by a test; everything here takes
 * its fetch, clock and logger as arguments and is driven by
 * `scripts/test-cron-lane-run.ts`.
 *
 * What it fixes. The dispatcher wrapped each lane in try/finally with no catch, so
 * a lane that THREW reached the logs only as `failed=<lane>` on the timings line,
 * with no message and no stack. And a lane answering non-ok was logged and nothing
 * else, so detection waited on the heartbeat watchdog, which cannot fire at all
 * for a lane that stamped its heartbeat before failing part way. Now both log the
 * cause, and both are handed to `/api/cron/lane-failure`, which sends a throttled
 * `cron_lane_failed:<lane>` page from inside the app, where every other alert is
 * sent from.
 *
 * Why a route rather than a send from here: this entry is bundled separately from
 * the app, so a send here would be a second copy of the Supabase client and the
 * alert dispatcher, reading environment the app's handler fills in on its first
 * request. The route runs on the same in-process `fetch` the lanes do, so it adds
 * no network hop and nothing new to configure.
 *
 * The TICK ID. A cron tick fans out to several lanes, each its own request, and
 * until now the only thing tying a lane's lines to the tick that drove it was the
 * time. Each tick mints one id, sends it on every lane request as
 * `TICK_ID_HEADER`, and stamps it on every line the dispatcher writes for that
 * tick, including the failure page, so a reader can go from the page to every
 * line of the tick that failed.
 */
import { laneFieldName, type LaneRun } from "@/lib/monitor/lane-timing";
import { TICK_ID_HEADER, type LaneFailureReport } from "@/lib/monitor/lane-failure";
import { shortErrorReason } from "@/lib/notify/error-text";
import type { LogFields } from "@/lib/log";

export { TICK_ID_HEADER };

/** The app route a failed lane is reported to. */
export const LANE_FAILURE_PATH = "/api/cron/lane-failure";

/** The origin the synthetic requests are addressed to. Never leaves the isolate. */
export const CRON_ORIGIN = "https://slate.trypennie.app";

/** What the failure route is told. `status` is null when the lane THREW, because
 *  then there is no response to have a status. */
export type LaneFailure = LaneFailureReport;

export interface LaneRunDeps {
  fetch(request: Request): Promise<Response>;
  now(): number;
  log: {
    error(tag: string, fields: LogFields, err?: unknown): void;
  };
}

export interface LaneTick {
  tickId: string;
  cronSecret: string;
}

/** A tick's id: short enough to read off a phone, unique enough to search on. */
export function mintTickId(randomUUID: () => string): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

function laneRequest(path: string, tick: LaneTick, init: RequestInit = {}): Request {
  return new Request(`${CRON_ORIGIN}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${tick.cronSecret}`,
      [TICK_ID_HEADER]: tick.tickId,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/**
 * Run one lane. Never throws: a lane's failure is the finding this reports, and a
 * throw here would take the other lanes on the tick with it.
 */
export async function runLane(
  path: string,
  tick: LaneTick,
  deps: LaneRunDeps,
): Promise<{ run: LaneRun; failure: LaneFailure | null }> {
  const lane = laneFieldName(path);
  const startedAt = deps.now();
  let ok = false;
  let failure: LaneFailure | null = null;
  try {
    const res = await deps.fetch(laneRequest(path, tick));
    ok = res.ok;
    if (!res.ok) {
      // The body is read for the LOG only; the page carries the status, never a
      // response body, which is whatever the lane chose to put there.
      const body = await res.text().catch(() => "");
      deps.log.error("cron", {
        msg: "lane returned a non-ok response",
        path,
        status: res.status,
        body: body.slice(0, 300),
        tick: tick.tickId,
      });
      failure = { lane, status: res.status, reason: `answered ${res.status}` };
    }
  } catch (err) {
    // The error itself goes to the log as the third argument, so Cloudflare keeps
    // its message and stack; the page gets one short line of it.
    deps.log.error("cron", { msg: "lane threw", path, tick: tick.tickId }, err);
    failure = { lane, status: null, reason: shortErrorReason(err) };
  }
  // A thrown lane is still measured and still reported as failed: a lane that dies
  // is usually the FAST one, and leaving it out would quietly shrink the record on
  // exactly the tick worth reading.
  return { run: { path, ms: deps.now() - startedAt, ok }, failure };
}

/**
 * Hand each failure to the app's failure route. Best-effort: a report that cannot
 * be delivered is logged, and never fails the tick, because the lane's own failure
 * is already in the log above it.
 */
export async function reportLaneFailures(
  failures: LaneFailure[],
  tick: LaneTick,
  deps: LaneRunDeps,
): Promise<void> {
  for (const failure of failures) {
    try {
      const res = await deps.fetch(
        laneRequest(LANE_FAILURE_PATH, tick, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(failure),
        }),
      );
      if (!res.ok) {
        deps.log.error("cron", {
          msg: "lane failure report was refused",
          lane: failure.lane,
          status: res.status,
          tick: tick.tickId,
        });
      }
    } catch (err) {
      deps.log.error(
        "cron",
        { msg: "lane failure report threw", lane: failure.lane, tick: tick.tickId },
        err,
      );
    }
  }
}
