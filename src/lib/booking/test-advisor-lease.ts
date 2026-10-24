/**
 * The one lease over the two smoke test advisors (#4180). The terms (its key and TTL) are in
 * `test-advisor-lease-terms.ts`, which says why it exists.
 *
 * Two holders take it: the reroute drill's endpoint (`/api/smoke/demotion-drill`) for the drill's
 * run, and the smoke canary through `/api/smoke/test-advisor-lease` around its full pass booking
 * steps. Each side asks once per request and its CLIENT polls up to a bound, reporting the run as
 * not measured past it (`scripts/lib/test-advisor-lease-wait.ts`), so no Worker request waits.
 *
 * A shared GitHub Actions concurrency group was rejected (L1020): a third queued run cancels the
 * pending one in the group even with `cancel-in-progress: false`, and the canary queues often,
 * so the day's drill could be dropped without a word.
 */
import { acquireLease, releaseLock, type ReleaseLockResult } from "@/lib/locks";
import { TEST_ADVISOR_LEASE_KEY, TEST_ADVISOR_LEASE_TTL_MS } from "@/lib/booking/test-advisor-lease-terms";

/** Takes the lease, answering its claim token, or null while another run holds it. */
export async function takeTestAdvisorLease(): Promise<string | null> {
  // lock-overlap: refused. A side that cannot take the lease books nothing and answers that the
  // advisors are held; its client asks again until its bound. The TTL outlasts the longest holder
  // (`TEST_ADVISOR_LEASE_TTL_MS`), so it cannot lapse under one still booking, and the canary's
  // hold spans two GitHub steps, which no in process renewal could cover.
  const lease = await acquireLease(TEST_ADVISOR_LEASE_KEY, TEST_ADVISOR_LEASE_TTL_MS);
  return lease === null ? null : lease.token();
}

/** Releases the claim `token` names, and only that one: idempotent, and a stale holder's late
 *  release never frees the claim that replaced it. */
export async function releaseTestAdvisorLease(token: string): Promise<ReleaseLockResult> {
  return releaseLock(TEST_ADVISOR_LEASE_KEY, token);
}
