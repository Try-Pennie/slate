import { supabaseAdmin } from "@/lib/supabase/admin";
import { nextScanOffset } from "./scan-rotation";
import { log } from "@/lib/log";

/**
 * Persisted rotating-scan cursor for the bounded self-heal sweeps (#512).
 *
 * Each sweep scans at most one page of upcoming rows per tick. This stores the
 * next offset to scan, advanced by the lane so rows past the first page are
 * eventually covered. The selfheal lane holds a single lock, so the read-then-
 * write is never raced, and it is best-effort throughout: a lost cursor just
 * restarts the scan from offset 0, which is safe (it re-scans the priority page),
 * so a tracking miss must never break the sweep it serves.
 */

const TABLE = "selfheal_scan_cursor";

export async function loadScanOffset(key: string): Promise<number> {
  const { data, error } = await supabaseAdmin()
    .from(TABLE)
    .select("next_offset")
    .eq("key", key)
    .maybeSingle();
  if (error) {
    log.error("selfheal-cursor", { msg: "load failed", key }, error);
    return 0;
  }
  const offset = (data as { next_offset: number } | null)?.next_offset ?? 0;
  return Number.isFinite(offset) && offset >= 0 ? offset : 0;
}

export async function saveScanOffset(key: string, offset: number): Promise<void> {
  const { error } = await supabaseAdmin()
    .from(TABLE)
    .upsert({ key, next_offset: offset, updated_at: new Date().toISOString() });
  if (error) log.error("selfheal-cursor", { msg: "save failed", key }, error);
}

/**
 * Run one sweep against its current scan window and advance the cursor for next
 * tick. `run` receives the offset to scan and returns the sweep result (which
 * carries `scanned`, the number of rows it loaded), or null if the sweep failed.
 *
 * A failed sweep leaves the cursor untouched: advancing on an unknown `scanned`
 * would skip that whole page next tick, stranding exactly the rows this rotation
 * exists to cover.
 */
export async function rotateSelfhealScan<T extends { scanned: number }>(
  key: string,
  limit: number,
  run: (offset: number) => Promise<T | null>,
): Promise<T | null> {
  const offset = await loadScanOffset(key);
  const res = await run(offset);
  if (res && typeof res.scanned === "number") {
    await saveScanOffset(key, nextScanOffset(offset, res.scanned, limit));
  }
  return res;
}
