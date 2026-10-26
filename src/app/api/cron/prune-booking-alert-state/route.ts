import { NextResponse, type NextRequest } from "next/server";
import { laneFailure } from "@/lib/monitor/lane-failure-response";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { claimLaneTick } from "@/lib/cron-lane-claim";
import { acquireLock, releaseLock } from "@/lib/locks";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap, unwrapCount } from "@/lib/db/result";
import { inIdChunks } from "@/lib/db/id-batch";
import { selectAllPages } from "@/lib/supabase/paginate";
import { laneCompleted } from "@/lib/snowflake/retention-lane";
import { firingKey } from "@/lib/notify/dispatch";
import { pruneBookingAlertState, type BookingTimes } from "@/lib/notify/alert-state-retention";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 60_000;

/** A LIKE pattern matching keys that start with `prefix`. `_` is a LIKE wildcard
 *  and alert keys are full of them, so it is escaped; the sweep re-parses every
 *  key it gets back anyway. */
const likePrefix = (prefix: string) => `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * PRUNE BOOKING ALERT STATE lane (#2726): delete the `alert_state` rows of every
 * alert family keyed by booking, once that booking both started and was made more
 * than a week ago. The rule and why it is safe live in
 * `src/lib/notify/alert-state-retention.ts`.
 *
 * No mirror gate: `alert_state` is not mirrored and holds no lead data. It uses only
 * the heartbeat half of `retention-lane.ts`, so a lane that throws every night stops
 * stamping and the watchdog pages.
 *
 * Every read is paged and every id list is chunked by URL bytes: the table this lane
 * exists for is the one that stopped fitting in a single page.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => new NextResponse("unauthorized", { status: 401 }));
  }
  // #4222: claim this tick before any work, so the same lane sent twice runs once.
  const claimed = await claimLaneTick(req.headers, "/api/cron/prune-booking-alert-state");
  if (claimed) return claimed;
  // lock-overlap: idempotent deletes of cooldown keys for past bookings on a daily
  // cadence; a second run deletes nothing new.
  const lock = await acquireLock("cron_prune_booking_alert_state", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ skipped: "overlapping-run" });
  try {
    const db = supabaseAdmin();
    const keysLike = async (prefix: string) =>
      (
        await selectAllPages<{ key: string }>(`alert_state keys ${prefix}`, "key", () =>
          db.from("alert_state").select("key").like("key", likePrefix(prefix)),
        )
      ).map((r) => r.key);

    const report = await pruneBookingAlertState({
      nowMs: Date.now(),
      listFamilyKeys: async (family) => [
        ...(await keysLike(`${family}:`)),
        ...(await keysLike(firingKey(`${family}:`))),
      ],
      loadBookings: async (ids) => {
        const times = new Map<string, BookingTimes>();
        await inIdChunks("booking alert prune booking read", ids, async (chunk) => {
          const rows = unwrap(
            await db.from("bookings").select("id, starts_at, created_at").in("id", chunk),
            "booking alert prune booking read",
          ) as { id: string; starts_at: string; created_at: string }[] | null;
          for (const r of rows ?? []) times.set(r.id, { startsAt: r.starts_at, createdAt: r.created_at });
        });
        return times;
      },
      // unwrapCount, not `count ?? 0` (#1165): a delete that failed reports a null
      // count, and scoring that as zero reads as "nothing needed cleaning".
      deleteKeys: async (keys) =>
        (
          await inIdChunks("booking alert prune delete", keys, async (chunk) =>
            unwrapCount(
              await db.from("alert_state").delete({ count: "exact" }).in("key", chunk),
              "booking alert prune delete",
            ),
          )
        ).reduce((a, b) => a + b, 0),
    });
    log.info("prune-booking-alert-state", {
      msg: "cycle",
      scanned: report.scanned,
      deleted: report.deleted,
      cutoff: report.cutoff,
      kept_not_yet_past: report.kept.notYetPast,
      kept_no_booking: report.kept.noBooking,
      kept_unreadable: report.kept.unreadable,
      ...Object.fromEntries(Object.entries(report.byFamily).map(([f, n]) => [`pruned_${f}`, n])),
    });
    return laneCompleted("prune-booking-alert-state", { ...report });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("prune-booking-alert-state", { msg: "cron failed", error: message });
    return laneFailure("prune-booking-alert-state", message);
  } finally {
    await releaseLock("cron_prune_booking_alert_state", lock);
  }
}
