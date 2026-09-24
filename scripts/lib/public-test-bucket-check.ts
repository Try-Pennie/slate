/**
 * What counts as the PUBLIC test bucket being served (#2660).
 *
 * The pure half of the canary's keyless read, split out for the same reason
 * every live check in this repo has one: the verdict is driven offline by
 * `scripts/test-public-test-bucket-check.ts`, and the smoke script stays a thin
 * driver that makes the request and prints the sentence.
 *
 * ## What this exists to catch
 *
 * The public test bucket is how a partner tests the embed from their own site,
 * and every monitor that would notice it going dark skips `is_test` buckets on
 * purpose: the empty bucket alarm, the slot health count, the booker_unstaffed
 * page. So a row deleted by hand, an agent made unbookable, or a recompute that
 * stopped publishing it would be found by the next partner reporting "no times",
 * which reads as a Slate outage. The 30 minute dry tick therefore makes the exact
 * request a partner's booker makes, with no key, and requires the bucket to
 * answer BY NAME.
 *
 * It does NOT demand that times are offered: out of hours the bucket legitimately
 * offers nothing, and a check that demanded slots would be red every night (L36).
 * A 200 naming the bucket, empty or not, is the bucket being served.
 *
 * ## Each way it can be wrong is its own outcome (L11)
 *
 *  - `not-found`: the 404 a partner would meet. The seed has not run, the row was
 *    deleted, or the recompute never published it. The repair is the seed's dry
 *    run, which says which.
 *  - `other-bucket`: a 200 naming a DIFFERENT code. The resolver rescued the code
 *    to the catch-all, or the read cascaded, so a partner would be booking a real
 *    pool while believing it a test.
 *  - `refused`: a 401 or 403. The public path is gating the bucket on a key
 *    again, so a browser can never reach it.
 *  - `throttled`: a 429 from the edge window, which says nothing about the bucket.
 *  - `error`: the route failed.
 *  - `unreadable`: a reply this check cannot read, which is its own outcome
 *    rather than silently one of the above.
 */

export const PUBLIC_TEST_BUCKET_OUTCOMES = [
  "served",
  "not-found",
  "other-bucket",
  "refused",
  "throttled",
  "error",
  "unreadable",
] as const;

export type PublicTestBucketOutcome = (typeof PUBLIC_TEST_BUCKET_OUTCOMES)[number];

export interface PublicTestBucketObservation {
  status: number;
  /** The parsed JSON body, or whatever the parse produced. */
  body: unknown;
}

export interface PublicTestBucketVerdict {
  outcome: PublicTestBucketOutcome;
  /** One sentence, naming what to do rather than what broke. */
  reason: string;
}

/** The exact read a partner's booker makes for the test bucket, with no key. */
export function publicTestBucketUrl(base: string, code: string): string {
  return `${base.replace(/\/+$/, "")}/api/availability?bucket=${encodeURIComponent(code)}`;
}

function servedCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const bucket = (body as { bucket?: unknown }).bucket;
  if (!bucket || typeof bucket !== "object") return null;
  const code = (bucket as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function judgePublicTestBucketRead(
  o: PublicTestBucketObservation,
  expectedCode: string,
): PublicTestBucketVerdict {
  if (o.status === 404) {
    return {
      outcome: "not-found",
      reason:
        `The public test bucket ${expectedCode} answers 404, which is what a partner's booker ` +
        `would meet. Its row is missing, it has no member, or the recompute has not published ` +
        `it: run the seed's dry run (scripts/seed-smoke-test.ts) to see which.`,
    };
  }
  if (o.status === 401 || o.status === 403) {
    return {
      outcome: "refused",
      reason:
        `The public test bucket ${expectedCode} is being refused with ${o.status}, so the public ` +
        `availability read is gating it on a key again. A browser can never send one, so no ` +
        `partner can test the embed until the keyless path is restored.`,
    };
  }
  if (o.status === 429) {
    return {
      outcome: "throttled",
      reason:
        `The availability read was throttled (429) before it could say whether the public ` +
        `test bucket ${expectedCode} is served. That is the edge window, not the bucket: ` +
        `re-run, and read the throttle if it persists.`,
    };
  }
  if (o.status >= 500) {
    return {
      outcome: "error",
      reason:
        `The availability read failed with ${o.status} while asking for the public test ` +
        `bucket ${expectedCode}. That is the route, not the bucket: read tag=availability ` +
        `in the Worker logs.`,
    };
  }
  if (o.status === 200) {
    const code = servedCode(o.body);
    if (code === null) {
      return {
        outcome: "unreadable",
        reason:
          `The availability read answered 200 for the public test bucket ${expectedCode} with ` +
          `a body this check cannot read (no bucket code in it). The response shape changed ` +
          `under the check; update scripts/lib/public-test-bucket-check.ts alongside the route.`,
      };
    }
    if (code !== expectedCode) {
      return {
        outcome: "other-bucket",
        reason:
          `Asking for the public test bucket ${expectedCode} answered with ${code}: the code ` +
          `was rescued to the catch-all or cascaded to a real pool, so a partner would be ` +
          `booking a real advisor while believing it a test. Check resolveRequestedCode and ` +
          `the public test bucket constant.`,
      };
    }
    return {
      outcome: "served",
      reason: `The public test bucket ${expectedCode} answered by name, with no key.`,
    };
  }
  return {
    outcome: "unreadable",
    reason:
      `The availability read answered ${o.status} for the public test bucket ${expectedCode}, ` +
      `a status this check does not know. Update scripts/lib/public-test-bucket-check.ts ` +
      `alongside whatever now answers it.`,
  };
}
