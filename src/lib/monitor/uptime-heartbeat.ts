/**
 * The external uptime checks' own dead man's switch (#1228).
 *
 * noodge polls `/api/health` and `/api/health/availability` every five minutes
 * (`monitors/slate.sql` in Try-Pennie/noodge). Nothing noticed when a check was
 * deleted, paused, or simply stopped firing, and that is the one layer whose
 * silence matters most: it is what catches a dead Worker, which cannot report its
 * own absence. So each of those two checks carries a dedicated key, and a request
 * carrying it stamps a per check heartbeat that the lane watchdog judges against
 * `UPTIME_STALE_BOUNDS_MS`.
 *
 * What a stamp claims, and nothing more: noodge's check REACHED this endpoint. It
 * is written whatever the endpoint then answers, because the answer is noodge's to
 * alert on from the status code, and a heartbeat that went quiet whenever Slate was
 * degraded would page "noodge stopped" about an outage noodge was busy reporting.
 *
 * Two things this must never do, both pinned by the route tests:
 *  - change the health answer. A wrong, missing or unconfigured key simply does not
 *    stamp; the endpoint answers exactly as it would have.
 *  - fail the health check. A stamp write that throws is logged and swallowed.
 *
 * `/widget.js` and `/login` cannot stamp, because no app code runs for them; their
 * coverage is the registration file in noodge alone (DEPLOY.md says so).
 */
import { bearerTokenMatches } from "@/lib/bearer-auth";
import { uptimeHeartbeatKey, uptimeHeartbeatKey2 } from "@/lib/env";
import { recordHeartbeat } from "@/lib/monitor/heartbeat";
import { log } from "@/lib/log";

/**
 * The only lanes a heartbeat key holder may stamp. An allowlist rather than a
 * parameter anybody can widen, for the same reason the smoke route has one: a key
 * that could name any lane could keep a dead cron lane looking alive.
 */
const UPTIME_HEARTBEAT_LANES = new Set(["uptime:api-health", "uptime:availability-canary"]);

export type UptimeLane = "uptime:api-health" | "uptime:availability-canary";

/**
 * Stamp `lane` when `authorization` carries the deployment's heartbeat key.
 *
 * Returns whether it stamped, for the logs and tests; callers must not branch
 * their response on it. Never throws.
 */
export async function stampUptimeHeartbeat(
  authorization: string | null,
  lane: UptimeLane,
): Promise<boolean> {
  try {
    // Constant time, and false when the deployment holds no key, so an
    // unconfigured deployment can never be stamped by anyone.
    if (!bearerTokenMatches(authorization, [uptimeHeartbeatKey(), uptimeHeartbeatKey2()])) return false;
    if (!UPTIME_HEARTBEAT_LANES.has(lane)) return false;
    await recordHeartbeat(lane);
    return true;
  } catch (err) {
    // The stamp is bookkeeping about the monitor, never part of the health answer.
    // A lost stamp costs at worst a late page, one bound from now, if it keeps
    // failing; a thrown one would turn a heartbeat hiccup into an outage page.
    log.error("uptime-heartbeat", { msg: "stamp failed", lane }, err);
    return false;
  }
}
