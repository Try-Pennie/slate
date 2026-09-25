import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  computeHealthStatus,
  LANE_STALE_BOUNDS_MS,
  UNREADABLE_STAMP_MS,
  isUnreadableStamp,
} from "@/lib/monitor/health";
import { parseStampMs } from "@/lib/date/stamp";
import { slackConfigured } from "@/lib/notify/slack";
import { stampUptimeHeartbeat } from "@/lib/monitor/uptime-heartbeat";

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
 *
 * #1228: a request carrying the uptime heartbeat key (noodge's check) also stamps
 * `uptime:api-health`, so a check that stops firing goes stale and pages. The key
 * decides only whether that stamp is written: the answer below is identical with a
 * valid key, a wrong one, none at all, or none configured.
 */
export async function GET(req: Request) {
  const now = Date.now();
  // Started before the read and awaited after it, so the stamp costs this request
  // no extra round trip. It never throws.
  const stamped = stampUptimeHeartbeat(req.headers.get("authorization"), "uptime:api-health");

  let dbOk = true;
  const ageByLane = new Map<string, number>();
  // Lanes whose stored stamp exists but could not be parsed (#1172).
  const unreadableLanes = new Set<string>();

  try {
    const db = supabaseAdmin();
    const { data, error } = await db.from("lane_heartbeats").select("lane, last_ran_at");
    if (error) {
      dbOk = false;
    } else {
      for (const row of (data ?? []) as { lane: string; last_ran_at: string }[]) {
        // #1169: fail closed. A stamp that exists but cannot be parsed reads as
        // epoch 0 (an infinite age -> 503), never skipped as if never stamped:
        // the lane's work cannot be proven to be happening.
        const ms = parseStampMs(row.last_ran_at) ?? UNREADABLE_STAMP_MS;
        ageByLane.set(row.lane, now - ms);
        // #1172: remember WHICH lanes could not be read, so the body reports the
        // fact instead of publishing now-minus-epoch as if it were a measured age.
        if (isUnreadableStamp(ms)) unreadableLanes.add(row.lane);
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
    stampUnreadable: unreadableLanes.has(lane),
  }));

  const result = computeHealthStatus({ dbOk, lanes });

  // #1035: surface whether the Slack paging layer is even configured. Every
  // safety net pages through Slack, and an unconfigured token makes every alert
  // a silent no-op. This is a CONFIG signal, not a liveness one: the booking app
  // is still up, and /api/health drives the uptime dead-man's switch, so it must
  // NOT flip httpStatus (that would conflate "app down" with "paging off"). It
  // rides the body so an uptime check or a human reading the endpoint can see it.
  const alerting = slackConfigured() ? "ok" : "unconfigured";

  await stamped;

  return NextResponse.json(
    {
      status: result.healthy ? "ok" : "degraded",
      reason: result.reason,
      db: dbOk ? "ok" : "unreachable",
      alerting,
      staleLane: result.staleLane,
      staleAgeMs: result.staleAgeMs,
      staleStampUnreadable: result.staleStampUnreadable,
    },
    { status: result.httpStatus },
  );
}
