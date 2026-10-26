import type { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { parseStampMs } from "@/lib/date/stamp";
import { selectAllPages, sortByStamp } from "@/lib/supabase/paginate";
import type { SlateBookingRow } from "./volume-learning.ts";
import { pageTrafficFilter } from "./page-volume.ts";
import { tierOfBucketCode } from "./volume-tiers.ts";
import { isTestSourceBooking } from "./offsite-origin.ts";

// Its own file rather than beside the counts in customer-bookings.ts: those FILTER
// test bookings out, and this one deliberately reads them and flags them, so the
// guard that proves the counts filter (scripts/test-test-data-counts.ts) can strip
// every filter from that file without this read standing in for one.

/**
 * Every booking created in [sinceIso, untilIso), each flagged as test when its bucket
 * is a test bucket or, since #2974, when it was made from a development host on a real
 * bucket (`isTestSourceBooking`), for relearning the low volume floors from Slate's own
 * traffic (#2739).
 *
 * The same inner join on the bucket as the counts in customer-bookings.ts, so the learner is fitted
 * to exactly the population the alarm later counts. Test bookings are READ and
 * flagged rather than filtered out server side, because the learner reports how many
 * it left out, and a zero there must mean none existed rather than none were looked at.
 *
 * Eight weeks of traffic is well past one PostgREST page, so it pages
 * (`selectAllPages`, keyset paged on id, so a booking made while it pages can never
 * repeat or skip a row), bounded above by `untilIso`, and sorted oldest first after
 * the read.
 * THROWS on any failed page and on an unreadable timestamp: the pages it did get
 * would read as a quiet stretch, and a quiet stretch learned is a lower floor.
 */
export async function listBookingStampsBetween(
  db: ReturnType<typeof supabaseAdmin>,
  sinceIso: string,
  untilIso: string,
): Promise<SlateBookingRow[]> {
  const rows = await selectAllPages<{
    id: string;
    created_at: string;
    parent_origin: string | null;
    referrer_origin: string | null;
    buckets: { is_test: boolean; code: string | null } | null;
  }>(
    "volume learning bookings",
    "id",
    () =>
      db
        .from("bookings")
        // #2874: the bucket's code too, whose first digit is the booking's tier.
        // #2974: and the two recorded host page origins, never the rest of `prefill`,
        // which carries the lead's contact.
        .select("id, created_at, referrer_origin, parent_origin:prefill->>parentOrigin, buckets!inner(is_test, code)")
        // #2073: the floors are fitted to the population the alarm counts, which
        // is routed bookings only.
        .eq("kind", "routed")
        // #2876: and page traffic only, as the alarm's count is. A booking API call
        // learned as traffic would raise the floors above what the pages send.
        .or(pageTrafficFilter())
        .gte("created_at", sinceIso)
        .lt("created_at", untilIso),
  )
    // Oldest first, as the read used to ask Postgres for; the read itself is ordered
    // by id, which keyset paging owns (2026-10-25).
    .then((r) => sortByStamp("volume learning bookings", r, "created_at", "id"))
    .catch((err: unknown) => {
      log.error("monitor", { msg: "volume learning read failed", since: sinceIso }, err instanceof Error ? err : undefined);
      throw err;
    });
  return rows.map((r) => {
    const createdAtMs = parseStampMs(r.created_at);
    if (createdAtMs === null) throw new Error("volume learning: a booking's created_at is unreadable");
    // #2974: test traffic is a test bucket's booking OR one made from a development
    // host on a real bucket, judged by the predicate every other consumer reads, so the
    // floors are never learned from a developer's tests and the learner's count of what
    // it left out names them.
    const fromDevHost = isTestSourceBooking({
      prefill: r.parent_origin == null ? null : { parentOrigin: r.parent_origin },
      referrer_origin: r.referrer_origin,
    });
    return { createdAtMs, isTest: r.buckets?.is_test === true || fromDevHost, tier: tierOfBucketCode(r.buckets?.code) };
  });
}
