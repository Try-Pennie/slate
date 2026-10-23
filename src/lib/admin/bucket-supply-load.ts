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
 * - The HORIZON failing is fatal too (#1654). It sets how many day columns there
 *   are and where each bucket's own allowance runs out, so taking the coded
 *   default would not make a share unavailable, it would quietly change what
 *   every share on the page MEANS while the numbers still looked normal. The
 *   monitor lane already refuses on these grounds; this page used to take the
 *   default and present the result as measured, and the two cannot both be right.
 * - The OFFERED OPEN DAYS failing is fatal for the same reason (#3922). They set
 *   the window every row's cover is judged over and the page's own words name it,
 *   so a guessed count would quietly change what the page says a lead is shown.
 * - The ROSTER failing is not fatal. The depth column reads as unknown and the page
 *   says so, never as zero eligible agents. Since #3939 the days read unknown too,
 *   because a day is counted in the calls of the pool's own advisors and the roster
 *   is what says who they are; a shut day still says it is shut.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { loadBusinessHours } from "@/lib/booking/business-hours-load";
import { readBookingHorizonDays } from "@/lib/booking/settings";
import { readOfferedOpenDays } from "@/lib/booking/days-offered-load";
import { loadTierDepths } from "@/lib/routing/staffing-depth-load";
import type { TierDepth } from "@/lib/routing/staffing-depth";
import { log } from "@/lib/log";
import { DateTime } from "luxon";
import { selectAllPages } from "@/lib/supabase/paginate";
import { searchWindowDays } from "@/lib/availability/bookable-days";
import { withStartedColumn } from "@/lib/availability/slot-row-times";
import { loadPoolCalls } from "@/lib/admin/bucket-calls-load";
import {
  bucketSupplyReport,
  supplyDays,
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
    // #3388: with when each row's compute started, which the "Last computed" column
    // and its freshness grade judge by (see `supplyComputedAtMs`). A database without
    // migration 0201 is read for the stamp alone.
    const read = await withStartedColumn(
      (withStarted) =>
        db
          .from("bucket_slots")
          .select(
            withStarted
              ? "bucket_code, payload, computed_at, compute_started_at"
              : "bucket_code, payload, computed_at",
          ),
      "bucket supply",
    );
    cacheRows = (unwrap(read, "bucket supply slot cache") ?? []) as unknown as CachedSlotRow[];
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
  let depths: TierDepth[] | null = null;
  try {
    depths = await loadTierDepths(db, orgId, now);
    depthByCode = supplyDepthMap(depths);
  } catch (err) {
    log.error("bucket-supply", { msg: "staffing depth unreadable" }, err);
    depthByCode = null;
  }

  // Null means the READ failed, never "no override stored" (that resolves to the
  // documented default and is a real answer). See the header: this one is fatal.
  const horizonDays = await readBookingHorizonDays();
  if (horizonDays === null) {
    log.error("bucket-supply", { msg: "booking horizon unreadable" });
    return { measurable: false, reason: "booking-horizon" };
  }

  // #3922: the stored offered open days. Null means the read failed, and the
  // report refuses rather than judging every row over a guessed window.
  const offeredOpenDays = await readOfferedOpenDays();
  if (offeredOpenDays === null) {
    log.error("bucket-supply", { msg: "offered open days unreadable" });
    return { measurable: false, reason: "offered-open-days" };
  }

  // The times already booked (#1937). Since #3939 the page's shares are counted in
  // calls, so on the page these feed only the cover judgement (which days a pool
  // still has times on); they are still the numerator of the monitor's start time
  // measure, which builds this report without calls. Keyed by bucket CODE and then by date in the org's zone, so the
  // report never has to know about bucket ids.
  //
  // `bookings` is a growth table rather than a roster bounded one, so this is
  // paginated: a single page read would silently under-count the moment the
  // window holds more than a thousand bookings, and an under-count here reads as
  // "those times are free" (see the capped read convention in AGENTS.md).
  //
  // Null on failure, never an empty map: an empty one means "nothing is booked",
  // which is exactly what a healthy quiet day looks like, and it would paint the
  // whole page 0% while the read was broken (L11).
  let bookedByCodeAndDate: Map<string, Map<string, string[]>> | null = null;
  try {
    bookedByCodeAndDate = await loadBookedTimes(db, orgId, hours, horizonDays, now);
  } catch (err) {
    log.error("bucket-supply", { msg: "booked times unreadable" }, err);
    bookedByCodeAndDate = null;
  }

  // Each pool's day in calls, from its own eligible advisors' calendars (#3939): staffing depth's
  // list of who is in each pool, so this page and routing never disagree about the pool. Without
  // that list there is no pool to add up, and every open day reads unknown.
  const callsByCode =
    depths === null
      ? null
      : await loadPoolCalls(
          orgId,
          new Map(depths.map((d) => [d.code, d.agents.map((a) => a.id)])),
          supplyDays(hours, horizonDays, now.getTime()).map((d) => d.iso),
          now.getTime(),
        );

  return bucketSupplyReport({
    hours,
    horizonDays,
    offeredOpenDays,
    nowMs: now.getTime(),
    buckets,
    depthByCode,
    cacheRows,
    bookedByCodeAndDate,
    callsByCode,
  });
}

/**
 * Staffing depth as the report wants it, keyed by code. The pool key and label are
 * carried as staffing depth computed them, so the codes this page combines into
 * one pool are exactly the codes the tiers page groups and the recompute lane
 * computes once. Shared with the nearly full pool whisper (#1256), which builds
 * the same report from the monitor's own reads.
 */
export function supplyDepthMap(depths: TierDepth[]): Map<string, SupplyDepth> {
  return new Map(
    depths.map((d) => [
      d.code,
      {
        depth: d.depth,
        effectiveDepth: d.effectiveDepth,
        poolKey: d.poolKey,
        poolLabel: d.poolLabel,
      },
    ]),
  );
}

/**
 * The start times already booked, by bucket code and then by date.
 *
 * CANCELLED bookings are excluded, because a cancelled time is free again and
 * counting it would report a bucket as busier than it is. `rescheduled` is NOT
 * excluded: that status marks a booking that MOVED, and the row carries the time
 * it moved to, so its slot is genuinely taken.
 *
 * Bounded to the window the page draws, which is what keeps this read small: a
 * fortnight of one org's bookings rather than the whole table.
 */
export async function loadBookedTimes(
  db: ReturnType<typeof supabaseAdmin>,
  /** Undefined reads every org, as the single org monitor lane does. */
  orgId: string | undefined,
  hours: Awaited<ReturnType<typeof loadBusinessHours>>,
  horizonDays: number,
  now: Date,
): Promise<Map<string, Map<string, string[]>>> {
  const start = DateTime.fromJSDate(now, { zone: hours.zone }).startOf("day");
  const end = start.plus({ days: searchWindowDays(horizonDays) });

  // The bucket's CODE comes through the foreign key rather than from a second
  // read of `buckets`. That is not only one query fewer: keying these by id
  // would make this read depend on the bucket list one, and a bucket list
  // failure is deliberately survivable here (the rows then come from the cache's
  // own codes). Re-reading it would have turned that degraded page into one with
  // no shares at all.
  const rows = await selectAllPages<{ starts_at: string; buckets: { code: string } | null }>(
    "bucket supply booked times",
    "id",
    () => {
      const q = db
        .from("bookings")
        .select("starts_at, buckets!inner(code)")
        // #2073: a share of a bucket's ROUTED demand. A booking through an agent's
        // own link sits in a bucket only because a booking needs one, so it is not
        // demand that bucket's pool served.
        .eq("kind", "routed");
      return (orgId === undefined ? q : q.eq("org_id", orgId))
        // A cancelled time is free again, so counting it would report a bucket
        // as busier than it is. `rescheduled` is NOT excluded: that marks a
        // booking that MOVED, and the row carries the time it moved to, so its
        // slot is genuinely taken.
        .neq("status", "cancelled")
        .gte("starts_at", start.toISO() ?? "")
        .lt("starts_at", end.toISO() ?? "");
    },
  );

  const out = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const code = row.buckets?.code;
    if (!code) continue;
    const dt = DateTime.fromISO(row.starts_at, { zone: hours.zone });
    if (!dt.isValid) continue;
    const iso = dt.toISODate();
    if (iso === null) continue;
    const byDate = out.get(code) ?? new Map<string, string[]>();
    byDate.set(iso, [...(byDate.get(iso) ?? []), row.starts_at]);
    out.set(code, byDate);
  }
  return out;
}
