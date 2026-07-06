import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { computeHealthStatus } from "@/lib/monitor/health";

export const dynamic = "force-dynamic";

// A lane whose heartbeat is older than this is treated as unhealthy. Mirrors the
// sync lane's monitor-heartbeat alarm (#420): 15 min = 3 missed 5-min ticks.
const MAX_STALE_MS = 15 * 60_000;

/**
 * Unauthenticated external liveness signal for the live booking app (#595).
 *
 * One query both proves the DB is reachable and returns every lane heartbeat, so
 * we derive the most-stale lane from it. Returns 200 when the DB is reachable and
 * no lane is stale; 503 (fail loud) otherwise. Body is intentionally minimal (no
 * sensitive data) so it is safe to expose to uptime checks.
 */
export async function GET() {
  const now = Date.now();

  let dbOk = true;
  let mostStaleAgeMs: number | null = null;
  let staleLane: string | null = null;

  try {
    const db = supabaseAdmin();
    const { data, error } = await db.from("lane_heartbeats").select("lane, last_ran_at");
    if (error) {
      dbOk = false;
    } else {
      for (const row of (data ?? []) as { lane: string; last_ran_at: string }[]) {
        const ms = Date.parse(row.last_ran_at);
        if (isNaN(ms)) continue;
        const ageMs = now - ms;
        if (mostStaleAgeMs === null || ageMs > mostStaleAgeMs) {
          mostStaleAgeMs = ageMs;
          staleLane = row.lane;
        }
      }
    }
  } catch {
    dbOk = false;
  }

  const result = computeHealthStatus({ dbOk, mostStaleAgeMs, maxStaleMs: MAX_STALE_MS });

  return NextResponse.json(
    {
      status: result.healthy ? "ok" : "degraded",
      reason: result.reason,
      db: dbOk ? "ok" : "unreachable",
      staleLane: result.reason === "heartbeat_stale" ? staleLane : null,
      staleAgeMs: result.reason === "heartbeat_stale" ? mostStaleAgeMs : null,
    },
    { status: result.httpStatus },
  );
}
