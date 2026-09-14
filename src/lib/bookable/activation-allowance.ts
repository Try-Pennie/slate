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
