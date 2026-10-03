import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { recordDetectorVerdict } from "@/lib/monitor/verdict-store";
import { CRON_BUDGET_VERDICT_LANE } from "@/lib/monitor/verdict-freshness";
import { CRON_BUDGET_BREACH_PREFIX, cronBudgetWrites } from "@/lib/monitor/cron-budget";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/** A cron expression as wrangler.jsonc writes one: digits, fields, and weekday names. Nothing
 *  else may name a row, so the set of rows stays the set of schedules. */
const CRON_SHAPE = /^[0-9A-Z*/,\- ]{9,64}$/;

/**
 * CRON BUDGET recorder (#3141). Not a scheduled lane: `worker/index.ts` calls it in process
 * after a tick's lanes have settled, and only when that tick has something to record, so a
 * healthy tick never reaches it.
 *
 * It exists so the WRITE lives in the app, where the database client already does: the Worker
 * entry stays free of it, and the decision about what to record is re-made here from the same
 * pure function rather than trusted from the caller. What it writes:
 *
 *  - a tick past half the CPU ceiling: `cron-over-budget:<cron>` in `lane_heartbeats`, which the
 *    monitor lane's daily judgement reads. A failed write fails the request and is logged,
 *    because a lost breach is a warning that never arrives.
 *  - the hourly tick: the `verdict:cron-budget` stamp, which proves this path is still writing.
 *
 * Same Bearer secret as every cron lane. Takes `cron` and `wall_ms` as query parameters, which
 * carry nothing sensitive.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return new NextResponse("unauthorized", { status: 401 });
  const params = new URL(req.url).searchParams;
  const cron = params.get("cron") ?? "";
  const wallMs = Number(params.get("wall_ms"));
  if (!CRON_SHAPE.test(cron) || !Number.isFinite(wallMs) || wallMs < 0) {
    log.error("cron-budget", { msg: "refused an unreadable measurement", cron, wall_ms: params.get("wall_ms") ?? "" });
    return NextResponse.json({ error: "cron and wall_ms are required" }, { status: 400 });
  }
  const writes = cronBudgetWrites(cron, wallMs);
  if (writes.breach) {
    const { error } = await supabaseAdmin()
      .from("lane_heartbeats")
      .upsert(
        { lane: `${CRON_BUDGET_BREACH_PREFIX}${cron}`, last_ran_at: new Date().toISOString() },
        { onConflict: "lane" },
      );
    if (error) {
      log.error("cron-budget", { msg: "breach write failed", cron, wall_ms: Math.round(wallMs) }, error);
      return NextResponse.json({ error: "breach write failed" }, { status: 500 });
    }
    log.warn("cron-budget", { msg: "tick past half the cpu ceiling", cron, wall_ms: Math.round(wallMs) });
  }
  await recordDetectorVerdict(CRON_BUDGET_VERDICT_LANE, writes.verdict);
  return NextResponse.json({ breach: writes.breach, verdict: writes.verdict });
}
