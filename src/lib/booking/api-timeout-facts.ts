/**
 * What a direct booking API request had established when its deadline struck
 * (#3663), and the three answers the route's timeout callback takes from it: what
 * the tally records, whether it pages, and what the page may say happened.
 *
 * At 03:37 UTC on 2026-10-13 the canary's dry run ran out of the request's 12
 * seconds while Google's token mint was in flight. The callback assumed nothing had
 * been read: it recorded bucket '' with is_test false under "a dependency timed out
 * before the request was read", and paged verify_on_book_outage telling the reader
 * the lead saw an error and to check booking_reservations. The request had been
 * authenticated with the canary's key and its body named SMOKE, and a dry run
 * writes no row (L11).
 *
 * The route fills `ApiRequestProgress` as it goes (the caller the moment its key is
 * accepted, the request the moment its body parses) and the callback reads it. One
 * set of facts decides both the tally and the page (L261):
 *
 *  - a canary key is test traffic, decided by which secret matched, so it needs no
 *    read and holds even when the deadline struck before the body was read;
 *  - otherwise a parsed body's bucket decides, through its `is_test` flag, exactly
 *    as every other outcome on this route is recorded;
 *  - otherwise nothing identifies it, and it counts and pages as real, the safe
 *    direction, with a reason naming how far it got.
 */
import { CANARY_CALLERS, type BookingApiCaller } from "@/lib/booking/api-auth";
import type { TimeoutReach } from "@/lib/booking/alert-copy";
import type { BookingOriginFacts } from "@/lib/monitor/offsite-origin";
import type { AttemptSource } from "@/lib/monitor/test-traffic";

export interface ApiRequestProgress {
  /** Who the key belongs to, set the moment it is accepted, before the ceilings. */
  caller: BookingApiCaller | null;
  /** What the body said, set the moment it parsed. */
  request: { bucketCode: string; dryRun: boolean; host: BookingOriginFacts } | null;
}

export function newApiRequestProgress(): ApiRequestProgress {
  return { caller: null, request: null };
}

function isCanaryCaller(progress: ApiRequestProgress): boolean {
  return progress.caller !== null && CANARY_CALLERS.includes(progress.caller);
}

/** How far the request had got, for the page's wording. */
export function timeoutReach(progress: ApiRequestProgress): TimeoutReach {
  if (!progress.request) return "before-body";
  return progress.request.dryRun ? "dry-run" : "booking";
}

/** What the daily tally is told the timed out attempt was. */
export function timeoutAttemptSource(progress: ApiRequestProgress): AttemptSource {
  if (isCanaryCaller(progress)) return { by: "canaryCaller", host: progress.request?.host ?? null };
  if (progress.request) return { by: "bucket", code: progress.request.bucketCode, host: progress.request.host };
  return {
    by: "unidentifiable",
    why: progress.caller
      ? `a dependency timed out after the ${progress.caller} key was accepted, before the body named a bucket`
      : "a dependency timed out before the API key was accepted",
  };
}

/**
 * Whether the timed out attempt is test traffic, for the paging decision. Asks the
 * bucket's flag through `isTestBucket` (the route passes `isTestBucketForPaging`,
 * which answers false on an unreadable flag, so that case pages).
 */
export async function timeoutIsTestTraffic(
  progress: ApiRequestProgress,
  isTestBucket: (bucketCode: string) => Promise<boolean>,
): Promise<boolean> {
  if (isCanaryCaller(progress)) return true;
  if (progress.request) return isTestBucket(progress.request.bucketCode);
  return false;
}
