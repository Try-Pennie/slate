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
}

/**
 * Build the bump_booking_api_outcome RPC args for one API call. `atMs` is the
 * call time (epoch ms), bucketed into the roster's ET calendar day. A null error
 * code becomes "" so it fits the table's non-null unique key (day, outcome,
 * bucket, error_code) rather than making the row NULL-distinct.
 */
export function outcomeTallyArgs(
  outcome: string,
  bucketCode: string,
  errorCode: string | null,
  atMs: number,
): TallyArgs {
  const day = DateTime.fromMillis(atMs, { zone: ROSTER_ZONE }).toISODate() ?? "";
  return {
    p_day: day,
    p_outcome: outcome,
    p_bucket: bucketCode,
    p_error_code: errorCode ?? "",
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
}

/** The jsonb shape the booking_api_outcome_mix RPC returns for a window. */
export interface RawMix {
  by_outcome?: Record<string, number> | null;
  by_error?: Record<string, number> | null;
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
  return { total, outcomes, errors };
}
