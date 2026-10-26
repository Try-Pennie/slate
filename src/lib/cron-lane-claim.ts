import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { claimLane, laneClaimAnswer, laneRunStore, type LaneClaim } from "@/lib/monitor/lane-claim";
import { LANE_RESEND_HEADER, TICK_ID_HEADER } from "@/lib/monitor/lane-failure";
import { log } from "@/lib/log";

/**
 * A scheduled lane's claim on its tick, as its route calls it (#4222). The first
 * awaited call of every scheduled lane's handler, straight after the cron secret check
 * and before any other read or write (`scripts/test-lane-claim-coverage.ts`):
 *
 *   const claimed = await claimLaneTick(req.headers, "/api/cron/sync");
 *   if (claimed) return claimed;
 *
 * Null means run the lane. A Response means do not: the tick's lane was already
 * claimed (200, `x-slate-lane-not-run: duplicate`), a RE-SEND's claim could not be read
 * (503), or the tick id is not one the dispatcher mints (400). A FIRST delivery whose
 * claim could not be read runs (Dan, 2026-10-26: run anyway, one alert), logged here on
 * the lane's line. The rules, and why each answer is what it is, are in
 * `src/lib/monitor/lane-claim.ts`.
 *
 * No lane sends an alert about its claim: the one alert is the monitor lane's, judged
 * from its own claim, which it reads through `observe` (`lane-claim-health.ts`).
 *
 * Never throws: a client that cannot even be made is an unreadable claim.
 */
export async function claimLaneTick(
  headers: Headers,
  path: string,
  observe?: (claim: LaneClaim) => void,
): Promise<Response | null> {
  const claim = await claimLane(
    headers.get(TICK_ID_HEADER),
    path,
    laneRunStore(async (row) => await supabaseAdmin().from("lane_runs").insert(row)),
    headers.get(LANE_RESEND_HEADER),
  );
  observe?.(claim);
  if (claim.run && claim.claim === "unreadable") {
    // The lane runs unprotected: a re-send of this tick would not be refused. Said on
    // the lane's own line, once per lane; the page is the monitor lane's, once.
    log.error(
      "cron",
      { msg: "lane claim unreadable, running anyway", path, lane: claim.lane, tick: claim.tickId, claim: "unreadable" },
      claim.error,
    );
  }
  const answer = laneClaimAnswer(claim);
  if (!answer) return null;
  const fields = { msg: "lane not run", path, lane: claim.lane, tick: claim.tickId, not_run: answer.notRun };
  // A duplicate is the claim doing its job: information. A refusal is a lane that did
  // not run when it should have, and the dispatcher pages on its status as well.
  if (answer.notRun === "duplicate") log.info("cron", fields);
  else log.error("cron", fields, claim.error);
  return NextResponse.json(answer.body, { status: answer.status, headers: answer.headers });
}
