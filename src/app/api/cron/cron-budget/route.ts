import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { recordDetectorVerdict } from "@/lib/monitor/verdict-store";
import { CRON_BUDGET_VERDICT_LANE } from "@/lib/monitor/verdict-freshness";
import { cronCpuReachedVerdict, runCronCpuCheck } from "@/lib/monitor/cron-budget";
import { resolveAlert, sendThrottledAlert, sendThrottledInfo } from "@/lib/notify/dispatch";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * How long the one analytics call may take. Generous for a query that answers in about a second,
 * and well inside the hourly invocation, so a hung API cannot hold the tick (L110).
 */
const ANALYTICS_TIMEOUT_MS = 20_000;

/**
 * CRON CPU check (#3141). Not a scheduled lane: `worker/index.ts` calls it in process on the
 * hourly tick, after that tick's lanes have settled.
 *
 * It reads a day of Cloudflare's own CPU figures for every scheduled invocation of the
 * production Worker (`runCronCpuCheck`), pages `cron_budget_headroom` when a schedule's worst
 * tick passed half `limits.cpu_ms`, and clears it on a measured day under the line. One
 * GraphQL call, which is the only subrequest it spends. With `CF_ANALYTICS_TOKEN` unset it
 * spends nothing and says so on the info channel, once a day.
 *
 * The `verdict:cron-budget` stamp is written only on a measured day, so a token that stops
 * working, or an answer this cannot read, goes stale and the lane watchdog says so.
 *
 * Same Bearer secret as every cron lane. Takes nothing in the query.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  const health = await runCronCpuCheck({
    // Read by its literal name, the way every Worker secret is read here.
    token: process.env.CF_ANALYTICS_TOKEN,
    nowMs: Date.now(),
    post: async (url, authorization, body) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(ANALYTICS_TIMEOUT_MS),
      });
      // A body that is not JSON is passed on as null, which the reader refuses by name.
      const parsed: unknown = await res.json().catch(() => null);
      return { status: res.status, body: parsed };
    },
    // alert-key: cron_budget_headroom
    // alert-text-ok: our own copy from cron-budget.ts, never a raw error.
    notify: sendThrottledAlert,
    // alert-key: cron_cpu_not_configured
    // alert-text-ok: fixed copy from cron-budget.ts.
    info: sendThrottledInfo,
    // A condition: it holds while a schedule's worst tick in the day was past the line, and ends
    // on a measured day with none.
    // alert-key: cron_budget_headroom
    // all-clear-proof: scripts/test-cron-budget.ts - an unset token, a refused or thrown call,
    // a schema error, an empty or truncated day and an unreadable row each clear nothing.
    resolve: resolveAlert,
    log: (msg) => log.info("cron-budget", { msg }),
  });
  let stamped = true;
  try {
    await recordDetectorVerdict(CRON_BUDGET_VERDICT_LANE, cronCpuReachedVerdict(health));
  } catch (err) {
    stamped = false;
    log.error("cron-budget", { msg: "verdict stamp threw", status: health.status }, err);
  }
  if (!stamped) {
    return NextResponse.json({ error: "verdict stamp failed", status: health.status }, { status: 500 });
  }
  return NextResponse.json({ status: health.status });
}
