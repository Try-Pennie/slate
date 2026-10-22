import { NextResponse, type NextRequest } from "next/server";
import { laneFailure } from "@/lib/monitor/lane-failure-response";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { acquireLock, releaseLock } from "@/lib/locks";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { runFillTick, type FillTickResult } from "@/lib/admin/capacity-fill";
import { readFillLast, writeFill } from "@/lib/admin/capacity-fill-store";
import { loadCapacityPeople, loadCapacityRules } from "@/lib/admin/team-capacity-load";
import { readOfferedOpenDays } from "@/lib/booking/days-offered-load";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Booking pace readings (#4102): every half hour, each page day's calls open and how many were
 * taken since the last reading, so the pace a day fills at is worked out from what happened. The
 * rules are `src/lib/admin/capacity-fill.ts`; this file is the IO.
 *
 * A read that fails fails the run and writes nothing, so the snapshots stay and the next run
 * measures the longer interval. The heartbeat is stamped only after every org was recorded, so a
 * lane failing every run lapses it and the watchdog pages (LANE_STALE_BOUNDS_MS).
 */
const LOCK_TTL_MS = 5 * 60_000;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // lock-overlap: a repeat is safe. record_capacity_fill writes only from the snapshot a run read
  // and only for a later half hour, so an overlapping run writes nothing; the lock spares the work.
  const lock = await acquireLock("cron_capacity_fill", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });
  try {
    const orgs = (unwrap(await supabaseAdmin().from("organizations").select("id"), "capacity fill orgs") ?? []) as { id: string }[];
    if (orgs.length === 0) throw new Error("no organisation to record capacity fill for");
    const nowMs = Date.now();
    const results: (FillTickResult & { org: string })[] = [];
    for (const { id: orgId } of orgs) {
      const r = await runFillTick({
        nowMs,
        loadRules: () => loadCapacityRules(orgId),
        readOfferedDays: readOfferedOpenDays,
        readLast: (days) => readFillLast(orgId, days),
        loadPeople: (rules, days) => loadCapacityPeople(orgId, rules, days),
        write: (w) => writeFill(orgId, w),
      });
      results.push({ org: orgId, ...r });
      log.info("capacity-fill", {
        msg: "cycle",
        org_id: orgId,
        read_at: new Date(r.readAtMs).toISOString(),
        state: r.state,
        days: r.days.join(","),
        rows: r.rows,
        measured: r.measured,
      });
    }
    await recordHeartbeat("capacity-fill");
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("capacity-fill", { msg: "cron failed", error: message }, err instanceof Error ? err : new Error(message));
    return laneFailure("capacity-fill", message);
  } finally {
    await releaseLock("cron_capacity_fill", lock);
  }
}
