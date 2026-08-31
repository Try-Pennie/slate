/**
 * The reads behind the per bucket supply page (#1254).
 *
 * Nothing new is stored and nothing live is called. Every read already exists
 * for something else: the org's week, the slot cache the booker reads, the
 * bucket list, and the staffing depth the tiers page and the monitor share. The
 * whole page is a different arrangement of numbers the system already has, which
 * is the point: it adds no cost to the hot path and no Google traffic.
 *
 * The rules that matter here are about which read failing means what.
 *
 * - The org's WEEK is load bearing twice over: every maximum on the page is
 *   derived from it, and the served slot count is filtered through it (#1296).
 *   `loadBusinessHours` throws rather than degrading, and that throw has to reach
 *   the screen as "could not check" rather than as a page of shares computed
 *   against a maximum nobody measured.
 * - The SLOT CACHE failing is the same: with no cached rows there is nothing to
 *   report, and rendering sixty empty buckets would say the exact opposite of the
 *   truth.
 * - The ROSTER failing is not fatal. The supply half of the page is still worth
 *   reading, so the depth column reads as unknown and the page says so. It never
 *   reads as zero eligible agents.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { loadBusinessHours } from "@/lib/booking/business-hours-load";
import { loadBookingHorizonDays } from "@/lib/booking/settings";
import { loadTierDepths } from "@/lib/routing/staffing-depth-load";
import { log } from "@/lib/log";
import {
  bucketSupplyReport,
  type BucketSupplyReport,
  type CachedSlotRow,
  type SupplyBucket,
  type SupplyDepth,
} from "@/lib/admin/bucket-supply";

export async function loadBucketSupply(
  orgId: string,
  now: Date = new Date(),
): Promise<BucketSupplyReport> {
  const db = supabaseAdmin();

  // Gate 1's own hours. A throw here is the whole page: see the header.
  let hours;
  try {
    hours = await loadBusinessHours();
  } catch (err) {
    log.error("bucket-supply", { msg: "business hours unreadable" }, err);
    return { measurable: false, reason: "business-hours" };
  }

  // What the booker is actually serving. `bucket_slots` is roster bounded (about
  // sixty rows, one per bucket) and on SAFE_TABLES, so a single page holds it.
  // `unwrap` throws on a real error, which becomes the cache's own screen rather
  // than a page of zeros (#277's direction).
  let cacheRows: CachedSlotRow[];
  try {
    cacheRows = (unwrap(
      await db.from("bucket_slots").select("bucket_code, payload, computed_at"),
      "bucket supply slot cache",
    ) ?? []) as CachedSlotRow[];
  } catch (err) {
    log.error("bucket-supply", { msg: "slot cache unreadable" }, err);
    return { measurable: false, reason: "slot-cache" };
  }

  // The bucket list, so a bucket that has NEVER been computed still gets a row
  // saying so. A failure here degrades to the cache's own codes rather than
  // taking the page down, and the page says which buckets it may be missing.
  let buckets: SupplyBucket[] | null = null;
  try {
    // cap-safe: roster bounded at sixty non-test buckets, on SAFE_TABLES.
    const rows = (unwrap(
      await db
        .from("buckets")
        .select("code, name, is_test")
        .eq("org_id", orgId),
      "bucket supply buckets",
    ) ?? []) as { code: string; name: string; is_test: boolean }[];
    buckets = rows
      // Synthetic test buckets (#396) are excluded here for the same reason
      // `bucketStaffingDepths` excludes them: they are not real supply.
      .filter((b) => !b.is_test)
      .map((b) => ({ code: b.code, name: b.name }));
  } catch (err) {
    log.error("bucket-supply", { msg: "bucket list unreadable" }, err);
    buckets = null;
  }

  // Eligible-agent depth by the SAME criteria match routing uses. Shared with the
  // tiers page and the monitor rather than re-derived, so the three can never
  // disagree about who can take a bucket's bookings.
  let depthByCode: Map<string, SupplyDepth> | null = null;
  try {
    const depths = await loadTierDepths(db, orgId, now);
    depthByCode = new Map(
      depths.map((d) => [d.code, { depth: d.depth, effectiveDepth: d.effectiveDepth }]),
    );
  } catch (err) {
    log.error("bucket-supply", { msg: "staffing depth unreadable" }, err);
    depthByCode = null;
  }

  // A failed horizon read falls back to the documented default, exactly as every
  // other consumer of this setting does. It shapes how many columns are shown and
  // where a bucket's own allowance runs out, never what is counted in a column.
  const horizonDays = await loadBookingHorizonDays();

  return bucketSupplyReport({
    hours,
    horizonDays,
    nowMs: now.getTime(),
    buckets,
    depthByCode,
    cacheRows,
  });
}
