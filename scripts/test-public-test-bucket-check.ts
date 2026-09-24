// The canary's read of the public test bucket (#2660), driven offline.
//
// The empty bucket alarm, the slot health count and the booker_unstaffed page all
// skip `is_test` buckets, correctly, so a public test bucket that goes dark (its
// row deleted, its agent unbookable, its slots never recomputed) is watched by
// nothing and is found by the next partner reporting "no times", which reads as
// a Slate outage and lands on Dan's desk as one (audit finding 3). The 30 minute
// dry tick therefore makes the exact keyless request a partner's booker makes and
// requires the bucket to answer by name. These are its verdict rules, pinned
// here the way `embed-render-check.ts` pins the browser check's, so they are
// tested where no deployment exists (L11, L98).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-public-test-bucket-check.ts
import {
  PUBLIC_TEST_BUCKET_OUTCOMES,
  judgePublicTestBucketRead,
  publicTestBucketUrl,
  type PublicTestBucketOutcome,
} from "./lib/public-test-bucket-check.ts";
import { PUBLIC_TEST_BUCKET_CODES } from "../src/lib/embed/public-test-bucket.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const CODE = PUBLIC_TEST_BUCKET_CODES[0];
const judge = (status: number, body: unknown) => judgePublicTestBucketRead({ status, body }, CODE);
/** Built from code points, so this file holds no literal dash to trip the copy lint. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

// --- the healthy case, first, so every failure below is a change from it ----------
eq(
  judge(200, { bucket: { code: CODE }, slots: ["2099-01-01T15:00:00.000Z"] }).outcome,
  "served",
  "a 200 naming the bucket with times is served",
);
// The case the design turns on: an EMPTY answer is still served. Out of hours the
// bucket legitimately offers nothing, and a check that demanded times would be red
// every night and every weekend (L36). What it asks is whether the bucket ANSWERED.
eq(
  judge(200, { bucket: { code: CODE }, slots: [], emptyBecause: { kind: "closed", reopensOn: null } }).outcome,
  "served",
  "a 200 naming the bucket with no times is still served: it answered by name",
);

// --- every way it can be wrong, each its own outcome (L11) --------------------------
eq(judge(404, { error: "Unknown bucket" }).outcome, "not-found", "a 404 is the bucket not being served at all");
eq(judge(200, { bucket: { code: "100" }, slots: [] }).outcome, "other-bucket", "a 200 naming another code was rescued or cascaded, not served");
eq(judge(200, { slots: [] }).outcome, "unreadable", "a 200 with no bucket in it is a shape this check cannot read");
eq(judge(200, "not json").outcome, "unreadable", "a 200 whose body is not an object is unreadable");
eq(judge(401, { error: "Unauthorized" }).outcome, "refused", "a 401 is the public path gating the bucket on a key again");
eq(judge(403, {}).outcome, "refused", "and so is a 403");
eq(judge(429, {}).outcome, "throttled", "a 429 is the edge throttle, which says nothing about the bucket");
eq(judge(500, {}).outcome, "error", "a 5xx is the route failing");
eq(judge(503, {}).outcome, "error", "any 5xx");
eq(judge(302, {}).outcome, "unreadable", "an unexpected status is unreadable rather than silently one of the others");

// --- the sentences send a reader to different places ---------------------------------
{
  const reasons = new Map<PublicTestBucketOutcome, string>();
  const cases: [number, unknown][] = [
    [200, { bucket: { code: CODE }, slots: [] }],
    [404, {}],
    [200, { bucket: { code: "100" }, slots: [] }],
    [200, {}],
    [401, {}],
    [429, {}],
    [500, {}],
  ];
  for (const [status, body] of cases) {
    const v = judge(status, body);
    reasons.set(v.outcome, v.reason);
  }
  eq(reasons.size, PUBLIC_TEST_BUCKET_OUTCOMES.length, "every declared outcome is produced by some observation");
  eq(new Set(reasons.values()).size, reasons.size, "and no two outcomes share a sentence");
  for (const [outcome, reason] of reasons) {
    assert(reason.trim().length > 40, `${outcome} carries a sentence a reader can act on`);
    assert(!DASHES.test(reason), `${outcome}'s sentence carries no dash`);
  }
  assert(/seed/i.test(reasons.get("not-found") ?? ""), "not-found names the seed, which is the repair");
  assert(/rescued|catch/i.test(reasons.get("other-bucket") ?? ""), "other-bucket names the catch-all, which is what answered");
  assert(/key/i.test(reasons.get("refused") ?? ""), "refused names the key gate, which is what came back");
}

// --- the request is the partner's own ---------------------------------------------------
eq(
  publicTestBucketUrl("https://slate.trypennie.app/", CODE),
  `https://slate.trypennie.app/api/availability?bucket=${CODE}`,
  "the URL is the availability read a partner's booker makes, with no trailing slash doubled",
);

finish();
