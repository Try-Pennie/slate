import type { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";

/**
 * Whether a booking is the smoke canary's, read from the one place that knows.
 *
 * **`bookings` has no `is_test` column.** Migration 0051 put the flag on `users` and
 * `buckets` only, because the canary is isolated by its BUCKET (#396): the key authed
 * smoke test books a hidden test bucket served by a test agent, and routing is
 * deliberately not gated on the flag. Two shipped reads had assumed otherwise
 * (`src/lib/handoffs/store.ts` from #2367, `src/lib/snowflake/erasure-trail.ts` from
 * #1196), and both were silent: a select naming a column that does not exist is a
 * string, so nothing typechecks it, and PostgREST answers 42703 at runtime only.
 * `scripts/test-db-column-selects.ts` is what says so now.
 *
 * So the answer is derived here, once, and every caller uses it. Two implementations
 * of "is this the canary's booking" would drift, and the drift is silent in the worst
 * direction: one of them suppresses a real lead's handoff, the other downgrades an
 * incomplete data subject erasure to a whisper.
 *
 * The callers: the handoff check (`handoffs/store.ts`), the erasure trail
 * (`snowflake/erasure-trail.ts`), and the moved invite handler, its check failed page
 * and its launch sweep (`google/invite-move-deps.ts`, #3930), which hold back every
 * message about a test booking's moved invite.
 */

/** Three states, not two. `null` is "Slate could not tell", and it is never a guess. */
export type BookingTestFlag = boolean | null;

/** What the lookup needs of a booking: its id and the bucket it was routed into. */
export interface BookingBucketRef {
  id: string;
  bucket_id: string;
}

/**
 * The flag per booking id.
 *
 * `null` for a booking whose bucket did not come back. It cannot happen while
 * `bookings.bucket_id` is NOT NULL with its foreign key, and it is still given a
 * value of its own rather than a default, because BOTH defaults are wrong in a way
 * nobody would see: `false` announces one of the canary's bookings to the sales side,
 * and `true` suppresses a real lead's handoff, which #2370 also holds out of the
 * waiting count, so nothing would ever page about it. A caller has to decide, and the
 * type makes it decide.
 *
 * A failed bucket read THROWS. Answering "unknown for everybody" would be a read
 * error wearing the shape of an answer, and every caller's handling of `null` is
 * built for one booking being odd rather than for the whole read having failed.
 */
export async function bookingTestFlags(
  db: ReturnType<typeof supabaseAdmin>,
  bookings: BookingBucketRef[],
): Promise<Map<string, BookingTestFlag>> {
  const out = new Map<string, BookingTestFlag>();
  if (bookings.length === 0) return out;

  const bucketIds = [...new Set(bookings.map((b) => b.bucket_id).filter((id) => !!id))];
  if (bucketIds.length === 0) {
    for (const b of bookings) out.set(b.id, null);
    return out;
  }

  // cap-safe: a primary-key lookup over the DISTINCT buckets these bookings name, and
  // the bucket count is the routing matrix (60 at the design target), so this can
  // never approach a page however many bookings were passed in. `buckets` is on the
  // capped-read guard's SAFE_TABLES for the same reason.
  const rows = unwrap(
    await db.from("buckets").select("id, is_test").in("id", bucketIds),
    "booking test flags",
  ) as { id: string; is_test: boolean }[] | null;

  const byBucket = new Map((rows ?? []).map((r) => [r.id, r.is_test === true]));
  for (const b of bookings) {
    const flag = byBucket.get(b.bucket_id);
    out.set(b.id, flag === undefined ? null : flag);
  }
  return out;
}
