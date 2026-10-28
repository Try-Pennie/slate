/**
 * A cron lane that failed on its scheduled run (#3133), as the app sees it.
 *
 * The Worker's dispatcher (`worker/lane-run.ts`) catches a lane that threw or
 * answered non-ok and POSTs it to `/api/cron/lane-failure`, which pages through
 * this module's copy. Before that, a thrown lane reached the logs only as
 * `failed=<lane>` on the timings line, and a non-ok one as a log line nobody is
 * paged by, so detection waited on the heartbeat watchdog, which cannot fire at
 * all for a lane that stamped its heartbeat before failing.
 *
 * An INCIDENT, not a condition: each page is about one tick's run, and saying when
 * it is over would mean a read on every healthy tick of every lane, on the budget
 * the every minute lanes share. A lane that stays down is still reported by its
 * heartbeat watchdog, and this repeats at most once an hour while it keeps failing.
 *
 * Pure, so the copy and the parsing are pinned by `scripts/test-cron-lane-run.ts`
 * and rendered by `pnpm preview:alerts`.
 */

import { CRON_ROUTES } from "../../../worker/cron-routes.ts";
import { laneFieldName } from "./lane-timing.ts";

/** The header a lane request carries its tick's correlation id on (#3139). */
export const TICK_ID_HEADER = "x-slate-tick-id";

/**
 * The header a lane answer carries when the lane did NOT run, with why. Moved here from
 * `worker/lane-run.ts` (which re-exports it) so the app's routes can set it too (#4222).
 * `standby` (a canary refusing a placed lane, #3693) is the one value the dispatcher
 * runs the lane in process after; `duplicate`, `claim_unreadable` and `tick_unreadable`
 * come from the lane's claim on its tick (`src/lib/monitor/lane-claim.ts`).
 */
export const LANE_NOT_RUN_HEADER = "x-slate-lane-not-run";

/**
 * The header the dispatcher will set on a lane request it RE-SENDS for the same tick
 * (#4222, defined now; set from #4189's phase 4, when a relay failure falls back to
 * today's route). Any value marks a re-send. It decides one thing only: a re-send whose
 * claim on its tick cannot be read runs nothing, because the first delivery may already
 * have run, while a first delivery with an unreadable claim runs anyway
 * (`src/lib/monitor/lane-claim.ts`). Read only behind the cron secret, and it can only
 * make a delivery stricter, so nobody gains by sending it.
 */
export const LANE_RESEND_HEADER = "x-slate-lane-resend";

/**
 * The header a lane's non-ok response carries when the lane ALREADY raised its own
 * alert about this failure (#3133 follow-up). Its value is the keys it raised, and
 * the dispatcher sends no generic page for a response that carries it, so a failure
 * produces exactly one message (Dan, 2026-10-03: "I only want one alert"). It is
 * set only by `laneFailure` / `laneFailedResponse`, from what the code recorded.
 */
export const LANE_ALERTED_HEADER = "x-slate-lane-alerted";

/** alert-key: cron_lane_failed:* */
export const LANE_FAILED_KEY_PREFIX = "cron_lane_failed";

/** One page per lane per hour. A lane failing on every minute tick is one fault,
 *  and its heartbeat watchdog covers the lane that stays down. */
export const LANE_FAILED_COOLDOWN_MS = 60 * 60_000;

/**
 * Every lane the dispatcher can drive, by the name `laneFieldName` gives it,
 * DERIVED from the schedule rather than listed beside it, so a new lane is covered
 * by construction.
 */
export const KNOWN_LANES: ReadonlySet<string> = new Set(
  Object.values(CRON_ROUTES)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .map(laneFieldName),
);

/**
 * The key for a lane. The suffix comes from a request body, so it is MAPPED onto
 * the fixed set of scheduled lanes, with anything else as `other`, rather than
 * minted from whatever arrived (#2755): the family stays bounded however it is
 * called.
 */
export function laneFailedKey(lane: string): string {
  return `${LANE_FAILED_KEY_PREFIX}:${KNOWN_LANES.has(lane) ? lane : "other"}`;
}

/** What the Worker reports. `status` is null when the lane threw. */
export interface LaneFailureReport {
  lane: string;
  status: number | null;
  reason: string;
  /** A placed lane answered 5xx with a body read through to its end and EMPTY (#4325).
   *  Every answer Slate sends carries text, so this one most likely came from Cloudflare. */
  emptyBody?: true;
}

/** A lane name as `laneFieldName` produces it. Anything else is refused rather
 *  than minted into an alert key. */
const LANE_NAME = /^[a-z0-9_]{1,40}$/;
/** A tick id as `mintTickId` produces it. */
const TICK_ID = /^[a-f0-9]{1,32}$/;

/** The report, or null when the body is not one. Never a guess: a key built from
 *  an unreadable body would page about a lane that does not exist. */
export function parseLaneFailure(body: unknown): LaneFailureReport | null {
  if (!body || typeof body !== "object") return null;
  const { lane, status, reason, emptyBody } = body as Record<string, unknown>;
  if (typeof lane !== "string" || !LANE_NAME.test(lane)) return null;
  if (status !== null && !(typeof status === "number" && Number.isInteger(status))) return null;
  if (typeof reason !== "string" || reason.trim() === "") return null;
  if (emptyBody !== undefined && typeof emptyBody !== "boolean") return null;
  return { lane, status, reason: reason.trim().slice(0, 120), ...(emptyBody ? { emptyBody: true as const } : {}) };
}

/** The tick id from the header, or null when absent or not one we minted. */
export function parseTickId(header: string | null): string | null {
  return header && TICK_ID.test(header) ? header : null;
}

export function formatLaneFailureAlert(
  report: LaneFailureReport,
  tickId: string | null,
): string {
  // Says exactly what each search finds (L440): only the DISPATCHER's lines carry
  // the tick id. The lane's own lines do not, so they are found by time.
  const path = `/api/cron/${report.lane.replace(/_/g, "-")}`;
  const where = tickId
    ? `Searching the Worker logs for tick=${tickId} finds the dispatcher's lines for that ` +
      `run (the failure with its error, and the lane timings); the lane's own lines do not ` +
      `carry the id, so read them from the same minute.`
    : `Search the Worker logs for tag=cron and path=${path}, and read the lane's own lines ` +
      `from the same minute.`;
  const tail =
    `Its heartbeat can still read fresh if it was stamped before the failure, so the lane ` +
    `watchdog may never page about it. Repeats at most hourly while it keeps failing.`;
  // #4325: the dispatcher cannot tell a lane Cloudflare never started from one it
  // stopped partway after writing, so the page names both and the record that
  // separates them, and claims neither (L11).
  if (report.emptyBody && report.status !== null) {
    return (
      `The ${report.lane} cron lane answered ${report.status} with an empty body on a ` +
      `scheduled run. Every answer Slate's code sends carries text, so this one most likely ` +
      `came from Cloudflare: the lane either never started, or was stopped partway. In the ` +
      `Workers observability view, a GET ${path} invocation in that minute means it started; ` +
      `none means it never started and nothing ran. ${where} ${tail}`
    );
  }
  const what =
    report.status === null
      ? `threw before answering (${report.reason})`
      : `answered ${report.status}`;
  return (
    `The ${report.lane} cron lane ${what} on a scheduled run, so whatever it does on that ` +
    `schedule did not finish. ${where} ${tail}`
  );
}
