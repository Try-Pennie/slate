/**
 * Dead-man's switch helpers for the monitor lane (#420).
 *
 * PURE: isHeartbeatStale — node-native-testable, no imports.
 * IO:   recordHeartbeat / readHeartbeatMs — best-effort DB ops via supabaseAdmin.
 *       These use an @/ alias so they cannot be node-tested directly; that's fine.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";

/**
 * Returns true ONLY when `lastRanAtMs` is non-null AND the gap since the last
 * stamp exceeds `maxStaleMs` (strict >). A null `lastRanAtMs` (the lane has
 * never stamped — e.g. fresh deploy before the first tick) returns false so we
 * do not alert on an uninitialized lane.
 */
export function isHeartbeatStale(
  lastRanAtMs: number | null,
  nowMs: number,
  maxStaleMs: number,
): boolean {
  if (lastRanAtMs === null) return false;
  return nowMs - lastRanAtMs > maxStaleMs;
}

/**
 * Upsert `{ lane, last_ran_at: now }` into `lane_heartbeats`. Best-effort:
 * never throws (swallows errors, logging them). Call after a lane's work
 * succeeds to prove it ran this tick.
 */
export async function recordHeartbeat(lane: string): Promise<void> {
  try {
    const db = supabaseAdmin();
    const { error } = await db
      .from("lane_heartbeats")
      .upsert({ lane, last_ran_at: new Date().toISOString() }, { onConflict: "lane" });
    if (error) log.error("heartbeat", { msg: "upsert failed", lane }, error);
  } catch (err) {
    log.error("heartbeat", { msg: "upsert threw", lane }, err);
  }
}

/**
 * Read EVERY lane's `last_ran_at` in one query, as `{ lane: ms | null }` (#803).
 *
 * One round trip rather than one per lane: this runs on the every-minute sync
 * tick, which shares a subrequest budget with the other lanes. Best-effort in the
 * same way as the rest of this module, but it THROWS on a read failure rather
 * than returning `{}`: an empty map is indistinguishable from "every lane has
 * gone quiet", and silently reporting a healthy fleet because the DB was
 * unreachable is exactly the false-confidence bug this watchdog exists to catch.
 * The caller (lane-watchdog) catches and stays quiet.
 */
export async function readAllHeartbeatMs(): Promise<Record<string, number | null>> {
  const db = supabaseAdmin();
  const { data, error } = await db.from("lane_heartbeats").select("lane, last_ran_at");
  if (error) throw new Error(`heartbeat bulk read failed: ${error.message}`);

  const out: Record<string, number | null> = {};
  for (const row of (data ?? []) as { lane: string; last_ran_at: string }[]) {
    const ms = Date.parse(row.last_ran_at);
    out[row.lane] = isNaN(ms) ? null : ms;
  }
  return out;
}

/**
 * Read the `last_ran_at` timestamp for `lane` from `lane_heartbeats`.
 * Returns `Date.parse(last_ran_at)` (ms) or null if the row is missing or the
 * read fails. Best-effort: never throws.
 */
export async function readHeartbeatMs(lane: string): Promise<number | null> {
  try {
    const db = supabaseAdmin();
    const { data, error } = await db
      .from("lane_heartbeats")
      .select("last_ran_at")
      .eq("lane", lane)
      .maybeSingle();
    if (error) {
      log.error("heartbeat", { msg: "read failed", lane }, error);
      return null;
    }
    if (!data) return null;
    const ms = Date.parse((data as { last_ran_at: string }).last_ran_at);
    return isNaN(ms) ? null : ms;
  } catch (err) {
    log.error("heartbeat", { msg: "read threw", lane }, err);
    return null;
  }
}
