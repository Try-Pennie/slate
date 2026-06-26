/**
 * Dead-man's switch helpers for the monitor lane (#420).
 *
 * PURE: isHeartbeatStale — node-native-testable, no imports.
 * IO:   recordHeartbeat / readHeartbeatMs — best-effort DB ops via supabaseAdmin.
 *       These use an @/ alias so they cannot be node-tested directly; that's fine.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";

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
 * never throws (swallows errors + console.error). Call after a lane's work
 * succeeds to prove it ran this tick.
 */
export async function recordHeartbeat(lane: string): Promise<void> {
  try {
    const db = supabaseAdmin();
    const { error } = await db
      .from("lane_heartbeats")
      .upsert({ lane, last_ran_at: new Date().toISOString() }, { onConflict: "lane" });
    if (error) console.error(`heartbeat upsert failed for lane "${lane}": ${error.message}`);
  } catch (err) {
    console.error(
      `heartbeat upsert threw for lane "${lane}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
      console.error(`heartbeat read failed for lane "${lane}": ${error.message}`);
      return null;
    }
    if (!data) return null;
    const ms = Date.parse((data as { last_ran_at: string }).last_ran_at);
    return isNaN(ms) ? null : ms;
  } catch (err) {
    console.error(
      `heartbeat read threw for lane "${lane}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
