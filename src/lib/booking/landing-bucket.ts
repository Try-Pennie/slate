import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";

/**
 * Whether the bucket a landing page is about to draw the booker for is a TEST
 * bucket (#2660), read once for both landing routes.
 *
 * `/book` and `/booking/[id]` render the same booker for the same resolved code,
 * and each used to make its own decision about the bucket row (one read it, one
 * did not). The mode a tester or a stray lead meets has to be established in one
 * place and carried onto every screen it reaches (L319, L659), so this is that
 * place: the page asks it, and hands the answer to the Booker as `isTest`.
 *
 * `unwrap`, never a swallowed read (#2542): a FAILED query answering "not a test
 * bucket" would draw the ordinary booker for the test code, with no test line,
 * and a tester would read a real looking booker. A read error is a broken deploy
 * and belongs on the screen as one.
 *
 * A code with NO row answers false. The public test code resolves to no row until
 * the seed has run; the booker then draws, its availability read answers 404, and
 * it says in its own words that it could not load, which is honest and nothing
 * the tester can fix (red team finding 7).
 */
export async function loadLandingBucketIsTest(code: string): Promise<boolean> {
  const row = unwrap(
    await supabaseAdmin()
      .from("buckets")
      .select("is_test")
      .eq("code", code)
      .maybeSingle(),
    "landing page bucket",
  ) as { is_test: boolean } | null;
  return row?.is_test === true;
}
