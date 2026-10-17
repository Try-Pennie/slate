/**
 * How many keys one of the booker's hourly caps is refusing right now (#1727): the
 * IO half of the embed refusal signals, kept apart so the judge stays node-testable.
 *
 * Read from the limiter's own rows (`rate_limits`, migration 0024), whose count goes
 * on rising past the limit, so a key whose CURRENT window started within the rule's
 * window length and whose count is over the limit is a key being refused now. That
 * is a distinct count of locked out keys read from the limiter's decision state,
 * which is what tells one bot reusing an identity from many leads each tripping
 * once. What it cannot see is in `embed-refusal-thresholds.ts`.
 *
 * A server side count (`head: true`), so no key, and so no email, phone or address,
 * ever leaves the database, and it is cap safe by construction. It THROWS on a
 * failed read through `unwrapCount`: a failed count read as zero would clear a page
 * about people still locked out (#1165).
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrapCount } from "@/lib/db/result";
import type { RateLimitRule } from "@/lib/rate-limit-core";
import { lockedOutFilter } from "@/lib/monitor/embed-lockouts";

export async function countLockedOutKeys(rule: RateLimitRule, nowMs: number): Promise<number> {
  const f = lockedOutFilter(rule, nowMs);
  return unwrapCount(
    await supabaseAdmin()
      .from("rate_limits")
      .select("key", { count: "exact", head: true })
      .like("key", f.keyPattern)
      .gt("count", f.countAbove)
      .gt("window_start", f.windowStartAfterIso),
    `rate_limits locked out ${rule.prefix}`,
  );
}
