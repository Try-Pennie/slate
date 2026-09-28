import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { bookingHostClass, type BookingOriginFacts, type HostClass } from "@/lib/monitor/offsite-origin";

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

/**
 * Where a RECORDED attempt came from (#2752): a `TestTraffic` whose bucket variant
 * also carries the host page facts the request itself holds. Required on that
 * variant, so `tsc` names every recording site that names a bucket, and a new one
 * cannot quietly record every attempt as having no host.
 *
 * The manage token variant needs nothing more: the booking it names already
 * recorded its host page, and the same lookup that reads its bucket reads that.
 */
export type AttemptSource =
  | { by: "bucket"; code: string; host: BookingOriginFacts }
  | Exclude<TestTraffic, { by: "bucket" }>;

/** Both markers the tally stores about one attempt. */
export interface TrafficMarkers {
  isTest: boolean;
  /** Judged by `bookingHostClass`, the predicate the off site page and the below
   *  tier exclusion use, never by a copy of it (L342). */
  hostClass: HostClass;
}

/**
 * Resolve both markers for one recorded attempt. An unreadable booking counts the
 * attempt as real AND as having no host, which is the direction that keeps it in the
 * failure rate: "none" is counted, exactly as #2737 decided for its own check.
 */
export async function resolveTrafficMarkers(source: AttemptSource): Promise<TrafficMarkers> {
  if (source.by === "bucket") {
    return { isTest: await resolveTestTraffic(source), hostClass: bookingHostClass(source.host) };
  }
  if (source.by === "unidentifiable") return { isTest: false, hostClass: "none" };
  const row = await readManagedBooking(source.token);
  return {
    isTest: row?.buckets?.is_test === true,
    hostClass: row ? bookingHostClass({ prefill: row.prefill, referrer_origin: row.referrer_origin }) : "none",
  };
}

interface ManagedBookingMarkers {
  prefill: Record<string, string> | null;
  referrer_origin: string | null;
  buckets: { is_test: boolean } | null;
}

/** The booking a manage token names, or null when it cannot be read (said at warn)
 *  or matches nothing. */
async function readManagedBooking(token: string): Promise<ManagedBookingMarkers | null> {
  try {
    // cap-safe: manage_token is unique, so maybeSingle returns at most one row.
    const { data, error } = await supabaseAdmin()
      // agent-link-ok: one booking looked up by its own token to read its test
      // markers, which describe that booking whatever kind it is (#2073).
      .from("bookings")
      .select("prefill, referrer_origin, buckets!inner(is_test)")
      .eq("manage_token", token)
      .maybeSingle();
    if (error) {
      unreadable("manage-token", error.message);
      return null;
    }
    return (data as ManagedBookingMarkers | null) ?? null;
  } catch (err) {
    unreadable("manage-token", String(err));
    return null;
  }
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

  // A token that matches nothing is not a canary booking; count it.
  const row = await readManagedBooking(source.token);
  return row?.buckets?.is_test === true;
}
