/**
 * Waiting for the one lease over the two smoke test advisors (#4180), the client half shared by
 * both sides that take it: the daily reroute drill (`verify-reroute-on-ineligibility-live.ts`)
 * and the smoke canary's full pass (`smoke-test-advisor-lease.ts`).
 *
 * The server never waits: each ask either gets the lease or answers that another run holds it.
 * So each side asks again every `LEASE_POLL_INTERVAL_MS` until its bound, and past the bound
 * reports its run as NOT MEASURED on its own exit, never as a pass and never as the failure the
 * collision used to cause. The clock and the sleep are injected, so the tests move a fake clock
 * and nothing waits for real (L290, L524).
 *
 * Bare node safe: imports nothing, because the drill's bare node reporter reads the drill's bound
 * through `reroute-drill-run-outcome.ts` (#1598). Its relation to the lease's TTL
 * (`src/lib/booking/test-advisor-lease-terms.ts`) and to each workflow's job timeout is checked by
 * `scripts/test-test-advisor-lease-wait.ts`.
 */

/** How often a side asks again while the other holds the lease. */
export const LEASE_POLL_INTERVAL_MS = 15_000;

/**
 * How long the drill waits for the canary. Longer than the lease's ten minute TTL, so even a
 * canary that died holding the lease has lost it before the drill gives up: the drill runs once a
 * day, and a wait is far cheaper than a day with no reading. A healthy canary holds it about two
 * minutes.
 */
export const DRILL_LEASE_WAIT_MS = 12 * 60_000;

/**
 * How long the canary's full pass waits for the drill. Longer than the drill's longest run (its
 * command cuts the request off at five minutes), so a drill in flight never costs a full pass. A
 * drill that died holding the lease outlasts it; that hour's pass is not measured, and the next
 * one, an hour later, is past the TTL.
 */
export const CANARY_LEASE_WAIT_MS = 6 * 60_000;

/** One ask: the lease is held elsewhere, or the side got an answer worth keeping. */
export type LeaseTry<T> = { busy: true } | { busy: false; value: T };

export type LeaseWait<T> =
  | { kind: "answered"; value: T; waitedMs: number; tries: number }
  /** Still held elsewhere at the bound: the run measured nothing. */
  | { kind: "not-measured"; waitedMs: number; tries: number };

export interface LeaseWaitDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  boundMs: number;
  intervalMs?: number;
}

/**
 * Ask until the lease is not held elsewhere or the bound passes. The last ask lands ON the bound,
 * never a poll interval past it, and time an ask itself takes counts against the bound.
 */
export async function waitForTestAdvisors<T>(attempt: () => Promise<LeaseTry<T>>, deps: LeaseWaitDeps): Promise<LeaseWait<T>> {
  const interval = deps.intervalMs ?? LEASE_POLL_INTERVAL_MS;
  const start = deps.now();
  let tries = 0;
  for (;;) {
    const answer = await attempt();
    tries += 1;
    const waitedMs = deps.now() - start;
    if (!answer.busy) return { kind: "answered", value: answer.value, waitedMs, tries };
    if (waitedMs >= deps.boundMs) return { kind: "not-measured", waitedMs, tries };
    await deps.sleep(Math.min(interval, deps.boundMs - waitedMs));
  }
}

/** A real sleep for the commands. Tests pass their own. */
export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minutes, for the sentences that name a bound. */
export function minutesOf(ms: number): number {
  return Math.round(ms / 60_000);
}
