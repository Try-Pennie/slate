/**
 * The one alert for cron lanes that cannot claim their ticks (#4222 follow up).
 *
 * Dan decided 2026-10-26: a lane whose claim on its tick cannot be read runs anyway,
 * with one alert. Failing closed made `lane_runs` a single point of failure: a missing,
 * locked or slow table would have stopped all 28 lanes at once and paged once per lane.
 * So a first delivery runs unprotected and says so on its own log line
 * (`src/lib/cron-lane-claim.ts`), and the page is raised HERE, by the monitor lane, not
 * by the lanes.
 *
 * WHY THE MONITOR LANE, and not the lanes or the dispatcher. A lane sending its own
 * page puts 28 senders on one key in the same minute, and the dispatch layer's guard
 * against concurrent senders (its claim on the `alert_state` row) is a database write:
 * in the outage most likely to break claims, it fails, and it then deliberately sends
 * anyway, so 28 lanes would post 28 times. The Worker's dispatcher sees every lane of a
 * tick, but not why a lane answered as it did: a lane's claim outcome would have to be
 * smuggled back on every one of 28 routes' responses, and the dispatcher still runs one
 * invocation per cron expression, several of them in one minute. The monitor lane is a
 * single judge by construction: it runs every five minutes under its lease, so two of
 * its runs never overlap, and it claims its own tick at the top of its handler exactly
 * like every lane, on the five minute boundary the every minute lanes claim on too. Its
 * claim IS the measurement: unreadable raises, written resolves.
 *
 * So one alert stays one: one judge per five minutes (its lease), one key for every
 * lane, and a CONDITION, which the dispatch layer posts again only once a day while
 * nothing changes. The cost: the monitor samples one claim in five minutes, so a fault
 * that fails only some inserts (contention at a busy minute) can miss its sample. Every
 * lane that ran unclaimed still logs `lane claim unreadable, running anyway`.
 *
 * Pure apart from the injected senders; `scripts/test-lane-claim-health.ts` drives it.
 */
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";
import type { LaneClaim } from "./lane-claim.ts";

/** alert-key: lane_claim_unreadable */
export const LANE_CLAIM_UNREADABLE_KEY = "lane_claim_unreadable";

export type LaneClaimHealth =
  | { status: "unmeasured"; why: string }
  | { status: "unreadable" }
  | { status: "healthy" };

/** What the monitor lane's own claim says about claiming. */
export function laneClaimHealth(claim: LaneClaim | null): LaneClaimHealth {
  if (claim === null) return { status: "unmeasured", why: "the lane made no claim this run" };
  if (claim.run) {
    if (claim.claim === "claimed") return { status: "healthy" };
    if (claim.claim === "unreadable") return { status: "unreadable" };
    return { status: "unmeasured", why: "a hand run carries no tick id, so it claims nothing" };
  }
  if (claim.refusal === "claim_unreadable") return { status: "unreadable" };
  return { status: "unmeasured", why: `the claim was refused as ${claim.refusal}, which writes nothing` };
}

/** The page. Our own words only: the error is on the lanes' log lines (#1135). */
export function formatLaneClaimUnreadableAlert(): string {
  return (
    "Cron lanes cannot record their claim on each tick, so they run anyway without it. " +
    "Nothing is skipped, but while this lasts a lane sent twice for one tick would not be " +
    "recognised as a repeat, so a re-sent lane is refused rather than risk running twice. " +
    "Check that the lane_runs table exists and answers; each lane that ran without its " +
    "claim logs the reason under tag=cron, msg=\"lane claim unreadable, running anyway\". " +
    "Repeats once a day while it lasts, and says when it clears."
  );
}

/** The all clear, sent only from a claim that was actually written. */
export function formatLaneClaimRecovered(): string {
  return "Cron lanes can record their claim on each tick again, so a lane sent twice for one tick runs once.";
}

/**
 * The monitor lane's step. Never throws: a send or clear that fails is logged by the
 * shared catch handlers, and an unmeasured run returns before it can do either.
 */
export async function runLaneClaimHealthCheck(deps: {
  claim: LaneClaim | null;
  notify: ThrottledNotify<unknown>;
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<LaneClaimHealth> {
  const health = laneClaimHealth(deps.claim);
  if (health.status === "unmeasured") {
    deps.log?.(`unmeasured, ${health.why}`);
    return health;
  }
  if (health.status === "unreadable") {
    await deps
      .notify(LANE_CLAIM_UNREADABLE_KEY, deps.cooldownMs, formatLaneClaimUnreadableAlert())
      .catch(logAlertSendFailure(LANE_CLAIM_UNREADABLE_KEY));
    deps.log?.("unreadable");
    return health;
  }
  // The all clear hangs off a claim that was WRITTEN this run (#1134), never off "did
  // not alert": the two branches above return before reaching it.
  await deps.resolve(LANE_CLAIM_UNREADABLE_KEY, formatLaneClaimRecovered()).catch(logResolveFailure(LANE_CLAIM_UNREADABLE_KEY));
  deps.log?.("healthy");
  return health;
}
