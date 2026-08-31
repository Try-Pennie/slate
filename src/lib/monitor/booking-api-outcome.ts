// Booking-API outcome mix (#418).
//
// #375 emits a per-call outcome log line from the direct booking API
// (created/deduped/rescheduled/confirm_required/error, with bucket + error code)
// but nothing consumed it, so there was no way to SEE whether person-dedupe,
// cross-bucket moves, and no-eligible-agents were behaving once the bot is live.
//
// This persists a lightweight daily tally (the bump_booking_api_outcome RPC does
// an atomic INSERT ... ON CONFLICT increment, so it is safe under concurrency and
// retry) and an admin panel reads the aggregated mix (the booking_api_outcome_mix
// RPC returns a single jsonb row, cap-safe). This module owns the two pure pieces:
// the tally args and the mix normalization. No alert; visibility only.

import { DateTime } from "luxon";

/** The whole roster runs in one zone; the tally buckets a call into its ET day,
 *  matching the daily-cap convention (#832) so day boundaries agree app-wide. */
const ROSTER_ZONE = "America/New_York";

/** The API outcomes, in the order the panel renders them (happy path first). */
export const OUTCOME_ORDER = [
  "created",
  "rescheduled",
  "deduped",
  "confirm_required",
  "error",
] as const;

export type OutcomeName = (typeof OUTCOME_ORDER)[number];

export interface TallyArgs {
  p_day: string;
  p_outcome: string;
  p_bucket: string;
  p_error_code: string;
  /** #1616: whether this attempt was the smoke canary's rather than a customer's. */
  p_is_test: boolean;
}

export interface TallyInput {
  outcome: string;
  bucketCode: string;
  errorCode: string | null;
  /**
   * #1616. Decided at the point of recording from the BUCKET the attempt belongs
   * to, never inferred downstream: the manage-token reschedule path records an
   * empty bucket code, so a bucket-code filter would keep the canary's deliberate
   * `reschedule_conflict` and drop its successes.
   */
  isTest: boolean;
  /** The call time (epoch ms), bucketed into the roster's ET calendar day. */
  atMs: number;
}

/**
 * Build the bump_booking_api_outcome RPC args for one API call. A null error code
 * becomes "" so it fits the table's non-null unique key (day, outcome, bucket,
 * error_code, is_test) rather than making the row NULL-distinct.
 *
 * Takes one named object rather than five positionals: `outcome`, `bucketCode`
 * and `errorCode` are all strings and `isTest` sits beside them, and a pair of
 * same-typed positionals silently swapped is a defect this codebase has already
 * shipped once (#1220).
 */
export function outcomeTallyArgs(input: TallyInput): TallyArgs {
  const day = DateTime.fromMillis(input.atMs, { zone: ROSTER_ZONE }).toISODate() ?? "";
  return {
    p_day: day,
    p_outcome: input.outcome,
    p_bucket: input.bucketCode,
    p_error_code: input.errorCode ?? "",
    p_is_test: input.isTest,
  };
}

export interface OutcomeSlice {
  outcome: OutcomeName;
  count: number;
  pct: number;
}

export interface ErrorSlice {
  code: string;
  count: number;
}

export interface OutcomeMix {
  total: number;
  outcomes: OutcomeSlice[];
  errors: ErrorSlice[];
  /**
   * How many TEST attempts fell in this window (#1616), or null when the read did
   * not report it. Null, never 0: "the canary wrote nothing this week" and "we
   * could not count what we hid" are different facts, and a panel that shows a
   * smaller number without saying what it left out is the silently-smaller-number
   * the issue rules out.
   */
  testTotal: number | null;
}

/** The jsonb shape the booking_api_outcome_mix RPC returns for a window. */
export interface RawMix {
  by_outcome?: Record<string, number> | null;
  by_error?: Record<string, number> | null;
  /** #1616, migration 0108. Absent from a pre-0108 function and from a failed read. */
  test_total?: number | null;
}

/**
 * Normalize the mix RPC's jsonb into an ordered, percentage-carrying view. Always
 * returns every outcome row (zero-filled) so the panel layout is stable, and the
 * error slice sorted by count desc. A null/absent result normalizes to an empty
 * mix rather than throwing.
 */
export function normalizeMix(raw: RawMix | null | undefined): OutcomeMix {
  const byOutcome = raw?.by_outcome ?? {};
  const byError = raw?.by_error ?? {};
  const total = OUTCOME_ORDER.reduce((sum, o) => sum + (byOutcome[o] ?? 0), 0);
  const outcomes: OutcomeSlice[] = OUTCOME_ORDER.map((outcome) => {
    const count = byOutcome[outcome] ?? 0;
    return { outcome, count, pct: total === 0 ? 0 : Math.round((count / total) * 100) };
  });
  const errors: ErrorSlice[] = Object.entries(byError)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const testTotal = typeof raw?.test_total === "number" ? raw.test_total : null;
  return { total, outcomes, errors, testTotal };
}

/**
 * The one sentence the outcome panel shows about what it left out (#1616).
 *
 * The panel HIDES test traffic, so it measures the same population the
 * failure-rate page does and a reader following that page's "the per call
 * breakdown is in the booking outcome panel" is not handed a different number.
 * Hiding is only honest if the reader can see that something was hidden, so the
 * count comes back with the mix and is stated either way.
 *
 * Three states, three sentences, because they are three different facts: some was
 * excluded, none existed, and it could not be counted (L11). The last one must
 * never render as "0 excluded".
 */
export function excludedTestTrafficNote(testTotal: number | null): string {
  if (testTotal === null) {
    return "Could not count the smoke canary calls this window leaves out.";
  }
  if (testTotal === 0) return "No smoke canary calls in this window.";
  const calls = testTotal === 1 ? "call" : "calls";
  return `Excludes ${testTotal} smoke canary ${calls}.`;
}
