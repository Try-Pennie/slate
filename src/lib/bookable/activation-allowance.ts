import { MAX_ONBOARDS_PER_TICK } from "@/lib/google/sync-pace";

/**
 * How many agents ONE roster run may try to make bookable (#2302).
 *
 * Since the calendar read became part of the activation gate, every attempt is a
 * handful of Google calls: the reachability probe, the calendar list, the watch
 * registration and the bootstrap fetch. The hourly roster lane runs the Salesforce
 * sync and the Twilio sync inside ONE Worker invocation and they share its budget,
 * so an unbounded loop over a mass licence upgrade is a lane that runs out of budget
 * part way and reports nothing about where it stopped.
 *
 * Derived from the lane that would otherwise do this work rather than chosen: the
 * watch lane onboards `MAX_ONBOARDS_PER_TICK` brand new agents per tick, which is
 * this codebase's established measure of how many first-time calendar setups fit in
 * one run. The arithmetic is asserted in the tests, so changing either constant has
 * to be a decision about both.
 */
export const MAX_ACTIVATIONS_PER_RUN = MAX_ONBOARDS_PER_TICK;

/**
 * How long ONE roster run may hold its lock, and therefore the outer bound on
 * everything this file allots.
 *
 * It lives here rather than in `run-roster-sync.ts`, which is where the lock is
 * actually taken, because it is the number both allowances below are derived
 * from and a copy of it beside them would be a second place for the answer to
 * hide (L41). `run-roster-sync.ts` imports it back for `acquireLock`, which is a
 * direction that does not close a cycle: this module reaches only `sync-pace`.
 */
export const ROSTER_RUN_LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * How long ONE activation may spend before the gate refuses it (#2317).
 *
 * The gate makes several Google calls before it writes: a reachability probe with
 * one retry, then a calendar list, a watch registration and a bootstrap fetch per
 * calendar. None of them carried a deadline, and a wait with no deadline cannot
 * fail, only hang, which is worse than failing because it is indistinguishable
 * from slowness and still holds whatever it acquired (L110).
 *
 * DERIVED, not chosen. A roster run may attempt `MAX_ACTIVATIONS_PER_RUN`
 * activations one after another inside a single Worker invocation whose lock is
 * `ROSTER_RUN_LOCK_TTL_MS`, so the activations must not be able, between them, to
 * outlive that lock. They are also not the only work in the run (the Salesforce
 * read and merge, the Twilio read, the default hours backfill), so they get HALF
 * of the window and divide it by the allowance: 30 seconds each. The arithmetic
 * is asserted in `service.test.ts`, so changing either constant has to be a
 * decision about both.
 *
 * Thirty seconds is generous against what the work actually costs, which is the
 * direction to err in: the hydration lane budgets `HYDRATE_BUDGET_MS` (90s) for a
 * batch of two maintenance calendars plus up to `HYDRATION_ONBOARDING_MAX` never
 * covered ones, so this codebase's own worst case allowance for bootstrapping one
 * calendar is 7.5 seconds, and the live roster holds roughly one calendar per
 * agent (121 calendars, 129 users, measured 2026-09-14). So an ordinary
 * activation finishes several times over inside this, and what the budget catches
 * is a Google that has stopped answering rather than one having a slow morning.
 *
 * On the admin toggle it is the same number for a different reason: a person who
 * clicks and waits is owed an answer, and thirty seconds is inside what
 * `SubmitButton` already shows elapsed time for.
 */
export const ACTIVATION_BUDGET_MS = ROSTER_RUN_LOCK_TTL_MS / 2 / MAX_ACTIVATIONS_PER_RUN;

/**
 * The allowance, SHARED by every sync in one roster run.
 *
 * Shared rather than one each, because the two syncs are in the same invocation
 * and two independent budgets is not a budget: the combined worst case would be
 * double the number anybody wrote down, which is the kind of limit that is only
 * discovered when it is exceeded.
 */
export interface ActivationAllowance {
  /** Claim a slot. False means this run has spent its allowance. */
  take(): boolean;
  /** How many slots have been claimed, for the run's own report. */
  spent(): number;
}

export function activationAllowance(max: number = MAX_ACTIVATIONS_PER_RUN): ActivationAllowance {
  let used = 0;
  return {
    take() {
      // Claimed BEFORE the attempt, and never refunded. An attempt that turns out
      // to have cost nothing (the row was already bookable, or had gone) wastes a
      // slot, which is rare and is the safe direction: it under-attempts by one and
      // the deferred agent is retried next hour. Refunding would mean deciding
      // after the fact what an attempt cost, which is the accounting this exists to
      // avoid needing.
      if (used >= max) return false;
      used += 1;
      return true;
    },
    spent: () => used,
  };
}
