import { TEST_PASS_REFUSAL_CODES } from "../../src/lib/embed/test-pass-header.ts";

/**
 * What counts as the PUBLIC test bucket being served (#2660), and being GATED
 * (#2666).
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
 * which reads as a Slate outage. The 30 minute dry tick therefore reads the
 * bucket and requires it to answer BY NAME.
 *
 * ## Two reads since #2666, because one cannot answer both questions
 *
 * Since #2666 a browser reads the bucket only with a short lived pass `/book`
 * mints for an approved website, and the canary is not a website. So:
 *
 *  - the SERVED read carries the canary's own key, which the availability read
 *    accepts for every test bucket, and asks whether the bucket answers by name;
 *  - the GATE read carries nothing, exactly as a stray caller would, and asks
 *    whether it is REFUSED for want of a pass. A 200 there is the test path open
 *    to anybody again; `TEST_PASS_OFF` is the deployment missing its signing
 *    secret, which switches testing off for every partner at once and which no
 *    other signal in Slate reports.
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
        `The public test bucket ${expectedCode} was refused with ${o.status} even though the ` +
        `canary sent its own key, so the key it holds is not one the availability read accepts ` +
        `for test buckets. Check BOOKING_API_KEY_CANARY in the canary's secrets against CANARY_CALLERS.`,
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
      reason: `The public test bucket ${expectedCode} answered by name to the canary's key.`,
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

// --- the gate (#2666) -------------------------------------------------------------------

export const PUBLIC_TEST_GATE_OUTCOMES = [
  "gated",
  "open",
  "switched-off",
  "throttled",
  "error",
  "unreadable",
] as const;

export type PublicTestGateOutcome = (typeof PUBLIC_TEST_GATE_OUTCOMES)[number];

export interface PublicTestGateVerdict {
  outcome: PublicTestGateOutcome;
  reason: string;
}

function refusalCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Judge the read made with NO key and NO pass. Only `gated` passes: the bucket
 * refused for want of a pass, which is the gate working. Each other answer sends
 * a reader somewhere different (L11).
 */
export function judgePublicTestBucketGate(
  o: PublicTestBucketObservation,
  expectedCode: string,
): PublicTestGateVerdict {
  if (o.status === 403 && refusalCode(o.body) === TEST_PASS_REFUSAL_CODES.refused) {
    return {
      outcome: "gated",
      reason: `The public test bucket ${expectedCode} refused a read carrying no pass, as it should.`,
    };
  }
  if (o.status === 403 && refusalCode(o.body) === TEST_PASS_REFUSAL_CODES.off) {
    return {
      outcome: "switched-off",
      reason:
        `The public test bucket ${expectedCode} says test bookings are switched off: the ` +
        `deployment holds no EMBED_TEST_PASS_SECRET, so no partner can test the embed. Set it ` +
        `with wrangler secret put (DEPLOY.md, runtime secrets).`,
    };
  }
  if (o.status === 200) {
    return {
      outcome: "open",
      reason:
        `The public test bucket ${expectedCode} answered 200 to a caller with no key and no ` +
        `pass, so it is open to any website again. Check the pass gate in the availability ` +
        `route (src/lib/embed/test-pass-gate.ts).`,
    };
  }
  if (o.status === 429) {
    return {
      outcome: "throttled",
      reason:
        `The keyless read was throttled (429) before it could say whether the public test ` +
        `bucket ${expectedCode} is gated. That is the edge window: re-run, and read the ` +
        `throttle if it persists.`,
    };
  }
  if (o.status >= 500) {
    return {
      outcome: "error",
      reason:
        `The keyless read of the public test bucket ${expectedCode} failed with ${o.status}. ` +
        `That is the route, not the gate: read tag=availability in the Worker logs.`,
    };
  }
  return {
    outcome: "unreadable",
    reason:
      `The keyless read of the public test bucket ${expectedCode} answered ${o.status} with a ` +
      `body this check does not recognise as the pass refusal. Update ` +
      `scripts/lib/public-test-bucket-check.ts alongside whatever now answers it.`,
  };
}
