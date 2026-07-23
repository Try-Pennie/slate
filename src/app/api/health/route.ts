import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { computeHealthStatus, LANE_STALE_BOUNDS_MS } from "@/lib/monitor/health";
import { slackConfigured } from "@/lib/notify/slack";

export const dynamic = "force-dynamic";

/**
 * Unauthenticated external liveness signal for the live booking app (#595),
 * a multi-lane dead-man's switch (#685).
 *
 * One query both proves the DB is reachable and returns every lane heartbeat.
 * Each covered cron lane (LANE_STALE_BOUNDS_MS) stamps a heartbeat on a
 * successful tick; we age each configured lane against its OWN bound. Returns
 * 200 when the DB is reachable and no covered lane is stale; 503 (fail loud)
 * otherwise. Heartbeat rows for lanes we don't cover are ignored, and a lane
 * that has never stamped (fresh deploy) does not fail health. Body is
 * intentionally minimal (no sensitive data) so it is safe to expose to uptime
 * checks.
 */
export async function GET() {
  const now = Date.now();

  let dbOk = true;
  const ageByLane = new Map<string, number>();

  try {
    const db = supabaseAdmin();
    const { data, error } = await db.from("lane_heartbeats").select("lane, last_ran_at");
    if (error) {
      dbOk = false;
    } else {
      for (const row of (data ?? []) as { lane: string; last_ran_at: string }[]) {
        const ms = Date.parse(row.last_ran_at);
        if (isNaN(ms)) continue;
        ageByLane.set(row.lane, now - ms);
      }
    }
  } catch {
    dbOk = false;
  }

  // Evaluate every configured lane against its own bound. A lane with no
  // heartbeat row yet gets a null age, which computeHealthStatus treats as
  // "not stale" (never alarm on an uninitialized lane).
  const lanes = Object.entries(LANE_STALE_BOUNDS_MS).map(([lane, maxStaleMs]) => ({
    lane,
    ageMs: ageByLane.has(lane) ? (ageByLane.get(lane) as number) : null,
    maxStaleMs,
  }));

  const result = computeHealthStatus({ dbOk, lanes });

  // #1035: surface whether the Slack paging layer is even configured. Every
  // safety net pages through Slack, and an unconfigured token makes every alert
  // a silent no-op. This is a CONFIG signal, not a liveness one: the booking app
  // is still up, and /api/health drives the uptime dead-man's switch, so it must
  // NOT flip httpStatus (that would conflate "app down" with "paging off"). It
  // rides the body so an uptime check or a human reading the endpoint can see it.
  const alerting = slackConfigured() ? "ok" : "unconfigured";

  return NextResponse.json(
    {
      status: result.healthy ? "ok" : "degraded",
      reason: result.reason,
      db: dbOk ? "ok" : "unreachable",
      alerting,
      staleLane: result.staleLane,
      staleAgeMs: result.staleAgeMs,
    },
    { status: result.httpStatus },
  );
}
