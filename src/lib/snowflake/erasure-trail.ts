/**
 * The `pii.erasure` audit trail: the list of booking ids Slate has erased in
 * Supabase, and therefore the exact set whose warehouse copy must hold no contact
 * data.
 *
 * Lifted out of `erasure-audit.ts` (#1128) so the lane that DETECTS a warehouse
 * residual and the purge that CLEARS one read the same trail through one
 * implementation. Two readers would be two chances to disagree about which
 * bookings are in scope, and the purge's entire safety argument is that it can
 * only ever touch a booking already erased in Supabase.
 */

import { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages, type PageableQuery } from "@/lib/supabase/paginate";
import { inIdChunks } from "@/lib/db/id-batch";
import { bookingTestFlags } from "@/lib/booking/test-flag";

export interface ErasureAuditRow {
  /** The `audit_log` row id: the stable identity of one erasure (#1124). */
  id: string;
  org_id: string;
  created_at: string;
  /**
   * `email_sha256` is the ONLY identifier the trail keeps for the person:
   * `erase_booking_pii` deliberately records a hash and never the cleartext
   * address, so it is what the operator worklist shows.
   */
  details: { booking_ids?: string[]; email_sha256?: string } | null;
}

/**
 * Every `pii.erasure` audit row. Paginated because `audit_log` is a growth table
 * (the `.range` in the page callback bounds each read), and it THROWS on a read
 * error rather than returning a short list: an empty trail read as "nothing has
 * been erased" would make the residual audit report clean and the purge do
 * nothing, both of which look identical to a healthy system.
 */
export async function readErasureAuditRows(): Promise<ErasureAuditRow[]> {
  const db = supabaseAdmin();
  return selectAllPages<ErasureAuditRow>("erasure-audit ids", "id", () =>
    db
      .from("audit_log")
      .select("id, org_id, created_at, details")
      .eq("action", "pii.erasure") as unknown as PageableQuery,
  );
}

/** The distinct booking ids across those rows, in first-seen order. */
export function erasedIdsFrom(rows: ErasureAuditRow[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) for (const id of r.details?.booking_ids ?? []) ids.add(id);
  return [...ids];
}

/**
 * Whether each of these bookings is a test fixture (#1196).
 *
 * Returns null rather than throwing or short-listing when the read fails, because
 * the caller's fallback for "cannot classify" is to treat everything as REAL, and
 * that decision belongs in one pure place (`classifyErasedBookings`) rather than
 * being split between a thrown error here and a partition there.
 *
 * A short read is indistinguishable from a booking that is genuinely absent, and
 * both land on real, so this deliberately does NOT paginate: the id set is the
 * erasure trail, which is a handful of rows, and `.in("id", ...)` is a primary-key
 * lookup, so it is cap-safe by the bounded-set rule.
 *
 * **It used to select `is_test` FROM `bookings`, which has no such column** (#2369).
 * The flag is on the BUCKET (#396), so PostgREST answered 42703 on every call and
 * this returned null every time: the residual audit has never once been able to
 * downgrade a test booking to a whisper, and because null is the loud direction
 * nothing ever said so. The flag now comes from `bookingTestFlags`, the one place
 * that derives it, and a booking whose bucket did not come back is simply LEFT OUT,
 * which `classifyErasedBookings` already counts as real and names in `unreadable`.
 */
export async function readBookingClasses(
  ids: string[],
): Promise<{ id: string; is_test: boolean }[] | null> {
  if (ids.length === 0) return [];
  const db = supabaseAdmin();
  // Split across requests (#2388). The docstring above says this id set is "a handful
  // of rows", and it is today, but it is the WHOLE erasure trail: every id ever named
  // in a `pii.erasure` audit row, read by `readErasureAuditRows` through
  // `selectAllPages`. It only grows, and one `in` filter of more than roughly 266
  // uuids is refused by PostgREST outright, so that assumption expires on a date
  // nobody is watching for.
  //
  // A failure in ANY batch returns null for the whole set, never the batches that
  // happened to succeed: a short list here is indistinguishable from bookings that
  // are genuinely absent, and the classifier lands both on real.
  let rows: { id: string; bucket_id: string }[];
  try {
    const pages = await inIdChunks("erasure-audit booking classes", ids, async (batch) => {
      // error-ok: a read failure returns null, and `classifyErasedBookings` maps null
      // to "every booking is real", which is the LOUD direction: the residual still
      // pages, it simply cannot be downgraded to a whisper. An empty array is never
      // substituted for a failure here, which is what would silently mark everything
      // real-but-unremarked.
      const { data, error } = await db.from("bookings").select("id,bucket_id").in("id", batch);
      if (error) throw new Error(error.message);
      return (data ?? []) as { id: string; bucket_id: string }[];
    });
    rows = pages.flat();
  } catch {
    return null;
  }
  // Same fallback for the same reason: a failed BUCKET read leaves every id
  // unclassified, which lands on real.
  let flags;
  try {
    flags = await bookingTestFlags(db, rows);
  } catch {
    return null;
  }
  const out: { id: string; is_test: boolean }[] = [];
  for (const r of rows) {
    const flag = flags.get(r.id);
    // An unknown flag is omitted rather than guessed: the classifier already treats a
    // missing id as real and says so in its `unreadable` note.
    if (flag === true || flag === false) out.push({ id: r.id, is_test: flag });
  }
  return out;
}
