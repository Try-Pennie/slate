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
import { loadCapacityPeople, loadCapacityRules, loadTeamCapacity } from "@/lib/admin/team-capacity-load";
import { readNearlyFullPct } from "@/lib/booking/settings";
import { loadTierAgentIds } from "@/lib/monitor/tier-staffing-load";
import { runRosterFillCheck } from "@/lib/monitor/roster-fill";
import { resolveAlert, sendThrottledAlert } from "@/lib/notify/dispatch";
import { log } from "@/lib/log";
import { appUrl } from "@/lib/env";

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

/**
 * The roster filling up notice's cooldown (#2590). A condition, so the dispatcher repeats an
 * unchanged one once a day whatever this says and posts a worse band at once (#3801); this only
 * bounds a retry after a failed post.
 */
const ROSTER_FILL_COOLDOWN_MS = 4 * 60 * 60_000;

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
    // #2590: calendars filling up across the roster, judged against the Team capacity line.
    // After the heartbeat, because it is not what the heartbeat vouches for, and it never throws:
    // a reading it could not take posts nothing and clears nothing, and says so in the log.
    // The notice is about the whole roster under one key, which holds while Slate serves one
    // organisation; with more it is skipped by name rather than judged across them.
    const [onlyOrg] = orgs;
    if (orgs.length === 1 && onlyOrg) {
      await runRosterFillCheck({
        loadReport: () => loadTeamCapacity({ orgId: onlyOrg.id, now: new Date(nowMs) }),
        readLine: readNearlyFullPct,
        loadTierAgents: loadTierAgentIds,
        // alert-key: roster_filling_up
        // alert-text-ok: our own copy from roster-fill.ts, never a raw error.
        notify: sendThrottledAlert,
        // alert-key: roster_filling_up
        // all-clear-proof: scripts/test-roster-fill.ts - an unreadable report, an unreadable line,
        // and a read that throws each clear nothing.
        resolve: resolveAlert,
        cooldownMs: ROSTER_FILL_COOLDOWN_MS,
        appBaseUrl: appUrl(),
        log: (fields) => log.info("capacity-history", { msg: "roster fill", ...fields }),
      });
    } else {
      log.error("capacity-history", { msg: "roster fill skipped", orgs: orgs.length }, new Error("roster fill judges one organisation"));
    }
    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("capacity-history", { msg: "cron failed", error: message }, err instanceof Error ? err : new Error(message));
    return laneFailure("capacity-history", message);
  } finally {
    await releaseLock("cron_capacity_history", lock);
  }
}
