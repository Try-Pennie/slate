import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { resolveAlert, sendThrottledAlert } from "@/lib/notify/dispatch";
import { CONDITION_REPEAT_MS } from "@/lib/notify/repeat-policy";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import {
  BACKSTOP_CHECK_WINDOW_MS,
  overdueMinuteLanes,
  readRecentLaneClaims,
  type LaneClaimQuery,
} from "@/lib/monitor/minute-lane-claims";
import {
  MINUTE_BACKSTOP_UNREADABLE_KEY,
  minuteBackstopRecoveryText,
  minuteBackstopUnreadableText,
} from "@/lib/monitor/lane-copy";

export const dynamic = "force-dynamic";

/**
 * Which every minute lanes have not claimed a tick in three minutes (2026-10-29).
 *
 * Asked by the Worker's five minute tick, which starts exactly the lanes named here
 * (worker/lane-backstop.ts), because Cloudflare has stopped delivering the every minute
 * trigger on its own while the others fired. Not a lane and never scheduled itself: it
 * claims no tick, takes no lock and stamps no heartbeat, because it writes nothing to
 * `lane_runs` or any lane's state. Its only writes are its own page's `alert_state` rows,
 * through the alert dispatcher.
 *
 * WHO MAY CALL: the cron bearer only (the dispatcher). WHOSE DATA: `lane_runs`, which holds
 * tick ids, lane names and instants, nothing about a lead or an agent.
 *
 * A read that fails names NO lane and answers 503, so the dispatcher starts nothing extra,
 * and pages `minute_backstop_unreadable`: an empty list here would read as "nothing is
 * overdue" and the backstop would be off without anybody knowing (L90). A measured read
 * ends that page.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  const nowMs = Date.now();
  let rows;
  try {
    rows = (
      await readRecentLaneClaims(
        supabaseAdmin().from("lane_runs") as unknown as LaneClaimQuery,
        new Date(nowMs - BACKSTOP_CHECK_WINDOW_MS).toISOString(),
      )
    ).rows;
  } catch (err) {
    log.error("cron", { msg: "the every minute backstop could not read lane_runs, so it names no lane" }, err);
    try {
      // alert-text-ok: our own copy from lane-copy.ts, never a raw error.
      // alert-key: minute_backstop_unreadable
      await sendThrottledAlert(MINUTE_BACKSTOP_UNREADABLE_KEY, CONDITION_REPEAT_MS, minuteBackstopUnreadableText());
    } catch (sendErr) {
      log.error("cron", { msg: "the every minute backstop's page was not sent", key: MINUTE_BACKSTOP_UNREADABLE_KEY }, sendErr);
    }
    return NextResponse.json({ error: "lane_runs could not be read, so no lane is named" }, { status: 503 });
  }
  const { overdue, unreadable } = overdueMinuteLanes(rows, nowMs);
  if (unreadable.length > 0) {
    log.warn("cron", { msg: "a lane's claim stamp could not be read, so the backstop leaves it alone", lanes: unreadable.join(",") });
  }
  // all-clear-proof: src/app/api/cron/minute-backstop/route.test.ts (a measured read resolves; a failed one never does)
  // alert-key: minute_backstop_unreadable
  await resolveAlert(MINUTE_BACKSTOP_UNREADABLE_KEY, minuteBackstopRecoveryText()).catch((err) => {
    log.error("cron", { msg: "the every minute backstop's all clear was not sent", key: MINUTE_BACKSTOP_UNREADABLE_KEY }, err);
  });
  return NextResponse.json({ overdue });
}
