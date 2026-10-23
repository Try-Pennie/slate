/**
 * The terms of the one lease over the two smoke test advisors (#4180), in a file with no imports
 * so the server (the drill's endpoint and the canary's lease endpoint) and the offline checks of
 * the client bounds (scripts/test-test-advisor-lease-wait.ts) read the same two numbers.
 *
 * The daily reroute drill (`POST /api/smoke/demotion-drill`) and the smoke canary's full pass
 * both book on Sarah Mitchell (smoketest@) and Smoke Reassign Target (smoketest2@). On 2026-10-23
 * at 15:34 UTC they overlapped and both failed: the drill's sweep found the other advisor busy
 * with the canary's bookings (exit 16), and the canary's sub event reschedule got a 409. Each now
 * holds this lease while it books, so neither can see the other's bookings.
 */

/** The `sync_locks` key. One name, imported by every side that takes the lease. */
export const TEST_ADVISOR_LEASE_KEY = "smoke_test_advisors";

/**
 * How long a claim stands before another side may take it over, which is what frees the
 * advisors after a holder that crashed without releasing.
 *
 * It is judged by the side TAKING the lease (`acquireLock` steals a claim older than the taker's
 * TTL), so both sides must use this one number. Ten minutes is twice the drill's longest run (its
 * command cuts the request off at five minutes) and over four times the canary's whole job at its
 * measured worst (139s, which includes the booking steps that hold the lease), so it never lapses
 * under a holder that is still working. A longer TTL would only lengthen the wait a crash costs.
 */
export const TEST_ADVISOR_LEASE_TTL_MS = 10 * 60_000;
