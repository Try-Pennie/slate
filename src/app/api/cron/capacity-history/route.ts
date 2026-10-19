import { NextResponse, type NextRequest } from "next/server";
import { laneFailure } from "@/lib/monitor/lane-failure-response";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { acquireLock, releaseLock } from "@/lib/locks";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { runHistoryTick, type HistoryTickResult } from "@/lib/admin/capacity-history";
import { readHistoryCursor, readSavedCalls, writeHistory } from "@/lib/admin/capacity-history-store";
import { loadCapacityPeople, loadCapacityRules } from "@/lib/admin/team-capacity-load";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Team capacity history (#3940): every half hour, save each advisor's calls that stopped being
 * bookable since the last tick, so a past day on the Team capacity page shows how it ended. The
 * rules are `src/lib/admin/capacity-history.ts`; this file is the IO.
 *
 * A read that fails fails the tick and writes nothing, so the cursor stays and the next tick covers
 * the stretch. The heartbeat is stamped only after every org was recorded, so a lane failing every
 * tick lapses it and the watchdog pages (LANE_STALE_BOUNDS_MS).
 */
const LOCK_TTL_MS = 5 * 60_000;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // lock-overlap: a repeat is safe. record_capacity_history merges saved calls as a set union and
  // only moves the cursor forward, so an overlapping tick adds nothing; the lock only spares it the work.
  const lock = await acquireLock("cron_capacity_history", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });
  try {
    const orgs = (unwrap(await supabaseAdmin().from("organizations").select("id"), "capacity history orgs") ?? []) as { id: string }[];
    if (orgs.length === 0) throw new Error("no organisation to record capacity history for");
    const nowMs = Date.now();
    const results: (HistoryTickResult & { org: string })[] = [];
    for (const { id: orgId } of orgs) {
      const r = await runHistoryTick({
        nowMs,
        readCursor: () => readHistoryCursor(orgId),
        loadRules: () => loadCapacityRules(orgId),
        loadPeople: (rules, days) => loadCapacityPeople(orgId, rules, days),
        readSaved: (days) => readSavedCalls(orgId, days),
        write: (rows, throughMs) => writeHistory(orgId, rows, throughMs),
      });
      results.push({ org: orgId, ...r });
      if (r.skippedMs > 0) {
        // Said, not paged: the heartbeat has already paged long before a day was missed.
        log.error("capacity-history", { msg: "stretch skipped after an outage", org_id: orgId, skipped_min: Math.round(r.skippedMs / 60_000) }, new Error("capacity history gap"));
      }
      log.info("capacity-history", {
        msg: "cycle",
        org_id: orgId,
        days: r.days.join(","),
        rows: r.rows,
        open: r.open,
        nobody_bookable: r.nobodyBookable,
      });
    }
    await recordHeartbeat("capacity-history");
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("capacity-history", { msg: "cron failed", error: message }, err instanceof Error ? err : new Error(message));
    return laneFailure("capacity-history", message);
  } finally {
    await releaseLock("cron_capacity_history", lock);
  }
}
