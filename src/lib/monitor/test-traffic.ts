import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";

/**
 * Is this booking attempt the smoke canary's, or a customer's? (#1616)
 *
 * The booking failure rate (#1313) counted the canary's own attempts, so before
 * cutover it measured the test harness and nothing else: one canary pass records
 * 16 attempts in about two minutes, exactly one of which is a
 * `reschedule_conflict` the canary raises ON PURPOSE.
 *
 * `bucket_code` alone cannot separate them, which is the whole reason this module
 * exists. The SMOKE buckets are identifiable, but the manage-token reschedule path
 * records an EMPTY bucket code (4 of the 16 per pass, including the deliberate
 * conflict), so a bucket-code filter would take the canary's successes out and
 * leave its errors in, which is worse than not filtering at all.
 *
 * Two rules hold this together:
 *
 *  - **Only the server decides.** Test-ness is read from `buckets.is_test`, never
 *    from a header, a query parameter or a body field. A caller-settable marker
 *    would let anybody exclude a real wave of failures from the one check watching
 *    for it, and the exclusion would be invisible on both sides.
 *  - **An unreadable marker COUNTS the attempt.** Marking a canary call as real
 *    adds noise a person can see and dismiss; marking a real call as test hides a
 *    customer failure and nothing anywhere reports that it happened. So every
 *    failure resolves to `false` and says so at warn.
 */
export type TestTraffic =
  /** The attempt named a bucket; that bucket's `is_test` decides. */
  | { by: "bucket"; code: string }
  /** The attempt is against an existing booking; the booking's bucket decides. */
  | { by: "manageToken"; token: string }
  /**
   * Nothing identifying had been read when the attempt was recorded (an auth
   * refusal before the body, a body that did not parse). Counted as real, and the
   * reason is spelled out at the call site rather than being an empty string
   * somebody later reads as "no bucket, so probably a test".
   */
  | { by: "unidentifiable"; why: string };

/** One shared warn, so an unreadable marker is never silent. */
function unreadable(where: string, detail: string): false {
  log.warn("booking-api-tally", {
    msg: "could not tell test traffic from real; counting it as real",
    where,
    detail,
  });
  return false;
}

export async function resolveTestTraffic(source: TestTraffic): Promise<boolean> {
  if (source.by === "unidentifiable") return false;

  if (source.by === "bucket") {
    // No code to look up. Not a failure and not worth a warn: the recording sites
    // that pass an empty code are the ones that refused before routing.
    if (!source.code) return false;
    try {
      // cap-safe: bucket codes are unique, so maybeSingle returns at most one row.
      const { data, error } = await supabaseAdmin()
        .from("buckets")
        .select("is_test")
        .eq("code", source.code)
        .maybeSingle();
      if (error) return unreadable("bucket", error.message);
      return data?.is_test === true;
    } catch (err) {
      return unreadable("bucket", String(err));
    }
  }

  try {
    // cap-safe: manage_token is unique, so maybeSingle returns at most one row.
    const { data, error } = await supabaseAdmin()
      .from("bookings")
      .select("buckets!inner(is_test)")
      .eq("manage_token", source.token)
      .maybeSingle();
    if (error) return unreadable("manage-token", error.message);
    // A token that matches nothing is not a canary booking; count it.
    return data?.buckets?.is_test === true;
  } catch (err) {
    return unreadable("manage-token", String(err));
  }
}
