/**
 * The test buckets, and which of them the public may reach (#2660).
 *
 * Slate has no staging deployment, so a partner testing the embed from their
 * own staging site had one path: book a real advisor, with a real invite, a real
 * text from Regal, and a cancel by hand afterwards. The hidden test buckets
 * (#396) could not serve them, because they are gated on the canary's bearer key
 * and a browser cannot send one.
 *
 * So there are two kinds of test bucket now, and this module is the one place
 * that says which is which:
 *
 *  - HIDDEN: the canary's own buckets. Read only with the canary's key; to the
 *    public they do not exist, and answer the same 404 as a typo (#601).
 *  - PUBLIC: served to anyone on the public paths (`/book`, `/api/availability`,
 *    `/api/availability/next`, the Booker's confirm) without a key. Still
 *    `is_test` in the database, so every webhook is suppressed at the choke point
 *    (#459), no reminder is sent, no monitor counts it, and the booking lands on
 *    the smoke test agent's calendar and nowhere real.
 *
 * Every consumer imports from HERE. The seed builds its rows from these constants
 * and the routes judge against them, so the two cannot drift: a drift would read
 * as "Unknown bucket" to the partner either way, and nothing on our side would
 * say why. `scripts/test-public-test-bucket.ts` refuses any other file that
 * spells the public code.
 *
 * Pure, no imports: the routing resolver reads it, and so does a seed script that
 * runs outside the app.
 */

/** The canary's buckets (#396, #464). Never public. */
export const HIDDEN_TEST_BUCKET_CODES = ["SMOKE", "SMOKE2"] as const;

/**
 * The ONE test bucket the public paths serve. One stable code for any host page
 * (a partner's staging, a flipped live page being checked, a future partner),
 * chosen by Dan on 2026-09-24. Origin restriction is a separate change (#2666).
 */
export const PUBLIC_TEST_BUCKET_CODES = ["PARTNER"] as const;

export type PublicTestBucketCode = (typeof PUBLIC_TEST_BUCKET_CODES)[number];

/**
 * Whether a requested code is the public test bucket. EXACT and case sensitive:
 * a lower case or padded spelling is a different string, and the resolver trims
 * before asking, so nothing here has to guess at what was meant.
 */
export function isPublicTestBucket(code: string): code is PublicTestBucketCode {
  return (PUBLIC_TEST_BUCKET_CODES as readonly string[]).includes(code);
}
