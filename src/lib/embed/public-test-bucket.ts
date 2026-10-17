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
 *  - PUBLIC: served on the public paths (`/book`, `/api/availability`,
 *    `/api/availability/next`, the Booker's confirm) without a key, to a page on
 *    an APPROVED website carrying a short lived pass (#2666, `test-pass.ts`). Still
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
 * The reroute drill's bucket (#3615). A test bucket like the canary's, so no real lead, webhook or
 * monitor ever sees it, and never public. Unlike them it has NO manual members and is keyed on the
 * made up `DRILL_TIER` both test advisors carry, because the daily drill proves a demotion moves a
 * call, and a demotion can only move a call held through criteria (a manual member serves
 * everything). No real bucket keys on the tier, so carrying it widens no real pool.
 */
export const DRILL_TEST_BUCKET_CODE = "DRILL";
export const DRILL_TIER = "drill";

/**
 * The test buckets the public paths serve, the partner one FIRST (the canary and
 * the reroute check lead with it).
 *
 *  - PARTNER: one stable code for any host page (a partner's staging, a flipped
 *    live page being checked, a future partner), chosen by Dan on 2026-09-24.
 *    Which websites may open it is `EMBED_TEST_ORIGINS` (#2666), judged in
 *    `test-pass.ts`.
 *  - DEMO (#3424): the booker shown to somebody outside Pennie through Slate's own
 *    `/demo` page. It is opened by that page and by no host page, and its bookings
 *    cancel themselves 30 minutes after they are made, so a link passed around
 *    cannot fill the test agent's day.
 */
export const PUBLIC_TEST_BUCKET_CODES = ["PARTNER", "DEMO"] as const;

export type PublicTestBucketCode = (typeof PUBLIC_TEST_BUCKET_CODES)[number];

/** The partner test bucket (#2660), where a test flagged Marcia token books (#3543). */
export const PARTNER_BUCKET_CODE: PublicTestBucketCode = "PARTNER";

/** The demo bucket (#3424). */
export const DEMO_BUCKET_CODE: PublicTestBucketCode = "DEMO";

/**
 * Whether a requested code is the public test bucket. EXACT and case sensitive:
 * a lower case or padded spelling is a different string, and the resolver trims
 * before asking, so nothing here has to guess at what was meant.
 */
export function isPublicTestBucket(code: string): code is PublicTestBucketCode {
  return (PUBLIC_TEST_BUCKET_CODES as readonly string[]).includes(code);
}

/** Whether a code is the demo bucket (#3424). Exact, like the predicate above. */
export function isDemoBucket(code: string): boolean {
  return code === DEMO_BUCKET_CODE;
}

/**
 * Whether a host page on an approved website may open this bucket through `/book`
 * (#3424). Every public test bucket except the demo one, which only Slate's own
 * `/demo` page opens: a demo booking cancels itself, which is right for a visitor
 * looking around and wrong for a partner checking their embed.
 */
export function opensFromHostPage(code: string): boolean {
  return isPublicTestBucket(code) && !isDemoBucket(code);
}
