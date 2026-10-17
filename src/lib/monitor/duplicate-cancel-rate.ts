/**
 * Every outcome of POST /api/bookings/cancel-duplicate, counted, and paged on a
 * sustained SHARE (#2377).
 *
 * The route (#2369) counted nothing. Its three refusals that need a person each open
 * a `booking_handoffs` row, and the monitor lane spoke only when a handoff went
 * UNDELIVERED, never when refusals arrived in volume, so one lead whose later call is
 * in cal.com and a broken identity match refusing every request read identically
 * (L77). The same was true of the three 503 stages (`rpc`, `result`, `handoff`).
 *
 * WHERE THE COUNT COMES FROM. The daily booking outcome tally (#418), the way the
 * follow up drain share (#3267) counts: the route records one row per answer under a
 * name OUTSIDE `OUTCOME_ORDER`, so none of it enters the booking failure share's
 * denominator, and this reads it off the same tally read the failure share makes, so
 * it costs no subrequest of its own. The window is the failure rate's machinery
 * (`advanceWindow`), in its own row of `booking_failure_rate_state`.
 *
 * Two signals, each its own condition, because they send a reader to different places:
 *  - **unavailable**: a share of calls answered 503 (nothing was decided, or the
 *    finding could not be recorded). The caller retries; a sustained share means it
 *    is retrying something that keeps failing. That is Slate's or the database's.
 *  - **refused**: a share of calls refused for a reason that opens a handoff
 *    (identity conflict, named call is the newest, no other call). Each one is told
 *    to sales on its own; a high share means Regal is naming the wrong booking or the
 *    identity match has drifted, which no single handoff says.
 *  `not-found`, `not-active` and `started` are counted (they are calls) and judged
 *  as neither: they are a journey naming a booking that is not in play, which opens
 *  no handoff and is not a fault of Slate's.
 *
 * THE NUMBERS. The issue asked for this after the flip, because a threshold needs real
 * Regal volume. Real leads already book through Slate, so the endpoint's volume was
 * measured instead (production, read only, 2026-10-16):
 *  - Cloudflare logs held 30 to 38 calls to the route in the seven days before (the
 *    query samples, so it is a range), about five a day.
 *  - Every sampled call ended at the `rpc` stage with a 503, under a booking id that
 *    logs as `null`: a journey is sending no usable id, the database refuses it, and
 *    the route tells the caller to retry. Zero duplicate cancels and zero
 *    duplicate-unresolved handoffs in the 30 days before.
 *  Five calls a day is too few to fit a share honestly, so the counting ships ARMED
 *  behind a floor today's volume cannot reach: at least 40 calls in the 24 hour window,
 *  above the whole of the measured week. Over it, more than 20 percent unavailable
 *  (with at least 5) or more than 30 percent refused for a person (with at least 5)
 *  pages. Those shares are judgement, not measurement, and should be re-read against
 *  real Regal traffic once the duplicate journeys send real ids.
 *
 *  Deliberately NO saturation rule under the floor (the follow up share has one,
 *  L139). Today every call fails, so one would page now, on a handful of calls, about
 *  a fault already reported separately; the brief for #2377 was a floor that cannot
 *  fire on today's volume. So until volume clears the floor, a total failure here is
 *  counted and unpaged, and that is the cost.
 *
 * THE ALL CLEAR hangs off a MEASURED clean run, never off the share dipping: the last
 * six hours holding at least 10 calls with no more than 5 percent unavailable (or 10
 * percent refused). Too few calls is not a clean run (L98), and a page is sent only
 * while that recent run is NOT clean.
 *
 * No `@/` imports, so scripts/test-duplicate-cancel-rate.ts drives every branch; the
 * reading, the state row and the sending are the caller's.
 */
import {
  advanceWindow,
  windowTotals,
  type OutcomeReading,
  type RateWindowState,
  type Rebase,
} from "./booking-failure-rate.ts";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

/** alert_state keys, one per signal, for sender, catalog, preview and settings. */
export const DUPLICATE_CANCEL_UNAVAILABLE_KEY = "duplicate_cancel_unavailable";
export const DUPLICATE_CANCEL_REFUSED_KEY = "duplicate_cancel_refused";

/**
 * The tally row each database answer is recorded under. Keyed by the outcomes of
 * `src/lib/booking/duplicate-cancel.ts` (held against that list by the test, since
 * this module may not import it).
 */
export const DUPLICATE_CANCEL_OUTCOME_TALLY = {
  cancelled: "duplicate_cancel_cancelled",
  "already-cancelled": "duplicate_cancel_already_cancelled",
  "not-found": "duplicate_cancel_not_found",
  "not-active": "duplicate_cancel_not_active",
  started: "duplicate_cancel_started",
  "identity-conflict": "duplicate_cancel_identity_conflict",
  "named-is-newest": "duplicate_cancel_named_is_newest",
  "no-other-call": "duplicate_cancel_no_other_call",
} as const;

/** The tally row each 503 stage is recorded under. */
export const DUPLICATE_CANCEL_STAGE_TALLY = {
  rpc: "duplicate_cancel_unavailable_rpc",
  result: "duplicate_cancel_unavailable_result",
  handoff: "duplicate_cancel_unavailable_handoff",
} as const;

/** The refusals that open a handoff, the ones judged as `refused`. */
export const HANDOFF_REFUSAL_OUTCOMES = ["identity-conflict", "named-is-newest", "no-other-call"] as const;

/** Every name this signal records, for the mix reader. */
export const DUPLICATE_CANCEL_TALLY_NAMES: readonly string[] = [
  ...Object.values(DUPLICATE_CANCEL_OUTCOME_TALLY),
  ...Object.values(DUPLICATE_CANCEL_STAGE_TALLY),
];

const STAGE_NAMES: readonly string[] = Object.values(DUPLICATE_CANCEL_STAGE_TALLY);
const REFUSAL_NAMES: readonly string[] = HANDOFF_REFUSAL_OUTCOMES.map((o) => DUPLICATE_CANCEL_OUTCOME_TALLY[o]);

export interface DuplicateCancelThresholds {
  windowMs: number;
  /** Fewest calls in the window before either share is judged (L716). */
  minCalls: number;
  unavailable: { minCount: number; sharePct: number };
  refused: { minCount: number; sharePct: number };
  /** The recent run each all clear hangs off. */
  recent: { windowMs: number; minCalls: number; unavailableRecoverPct: number; refusedRecoverPct: number };
}

/** The shipped numbers; the module header says what they were measured against. */
export const DUPLICATE_CANCEL_THRESHOLDS: DuplicateCancelThresholds = {
  windowMs: 24 * 60 * 60_000,
  minCalls: 40,
  unavailable: { minCount: 5, sharePct: 20 },
  refused: { minCount: 5, sharePct: 30 },
  recent: { windowMs: 6 * 60 * 60_000, minCalls: 10, unavailableRecoverPct: 5, refusedRecoverPct: 10 },
};

/**
 * Today's cumulative counts as the window machinery reads them: every duplicate
 * cancel answer is a call (`attempts`), the 503 stages are `failures`, and each name
 * rides in `byCode` so the refusals and the stage split can be read back.
 */
export function duplicateCancelReading(day: string, byOutcome: Record<string, number>): OutcomeReading {
  const byCode: Record<string, number> = {};
  let attempts = 0;
  let failures = 0;
  for (const name of DUPLICATE_CANCEL_TALLY_NAMES) {
    const n = byOutcome[name] ?? 0;
    if (n <= 0) continue;
    byCode[name] = n;
    attempts += n;
    if (STAGE_NAMES.includes(name)) failures += n;
  }
  return { day, attempts, failures, byCode };
}

export interface SignalCounts {
  calls: number;
  count: number;
  pct: number;
  /** The tally names behind `count`, so the page can say which stage or refusal. */
  byName: Record<string, number>;
}

export type SignalVerdict = ({ status: "breach" } | { status: "under" }) & SignalCounts;

export type DuplicateCancelVerdict =
  | { status: "insufficient"; calls: number }
  | { status: "judged"; calls: number; unavailable: SignalVerdict; refused: SignalVerdict };

function pick(byCode: Record<string, number>, names: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of names) if ((byCode[n] ?? 0) > 0) out[n] = byCode[n];
  return out;
}

const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);

function signal(calls: number, byName: Record<string, number>, rule: { minCount: number; sharePct: number }): SignalVerdict {
  const count = sum(byName);
  const pct = calls === 0 ? 0 : Math.round((count / calls) * 100);
  const over = count >= rule.minCount && count * 100 > rule.sharePct * calls;
  return { status: over ? "breach" : "under", calls, count, pct, byName };
}

/** Judge the window as of `atMs`. Shares are compared before rounding. */
export function judgeDuplicateCancel(state: RateWindowState, atMs: number, t: DuplicateCancelThresholds): DuplicateCancelVerdict {
  const { attempts: calls, byCode } = windowTotals(state, atMs, t.windowMs);
  if (calls < t.minCalls) return { status: "insufficient", calls };
  return {
    status: "judged",
    calls,
    unavailable: signal(calls, pick(byCode, STAGE_NAMES), t.unavailable),
    refused: signal(calls, pick(byCode, REFUSAL_NAMES), t.refused),
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const STAGE_WORDS: Record<string, string> = {
  [DUPLICATE_CANCEL_STAGE_TALLY.rpc]: "the duplicate check could not be run",
  [DUPLICATE_CANCEL_STAGE_TALLY.result]: "its answer could not be read",
  [DUPLICATE_CANCEL_STAGE_TALLY.handoff]: "the finding could not be recorded",
};

const REFUSAL_WORDS: Record<string, string> = {
  [DUPLICATE_CANCEL_OUTCOME_TALLY["identity-conflict"]]: "another upcoming call has the same email and phone under a different Salesforce id",
  [DUPLICATE_CANCEL_OUTCOME_TALLY["named-is-newest"]]: "the named call is the lead's newest",
  [DUPLICATE_CANCEL_OUTCOME_TALLY["no-other-call"]]: "Slate holds no other upcoming call for the lead",
};

function breakdown(byName: Record<string, number>, words: Record<string, string>): string {
  return Object.entries(byName)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${n} because ${words[name] ?? "of another reason"}`)
    .join(", ");
}

/** The unavailable page, from measured counts only. */
export function formatDuplicateCancelUnavailablePage(v: SignalCounts, windowHours: number): string {
  return (
    `${v.count} of ${plural(v.calls, "duplicate cancel request", "duplicate cancel requests")} in the last ${windowHours} hours (${v.pct}%) ` +
    `could not be completed and were answered 503, so the caller retries: ${breakdown(v.byName, STAGE_WORDS)}. ` +
    `Nothing was cancelled for those leads, and a journey retrying gets the same answer until the cause is fixed. ` +
    `The detail is in the logs under tag=duplicate-cancel msg="incomplete".`
  );
}

/** The refused page, from measured counts only. */
export function formatDuplicateCancelRefusedPage(v: SignalCounts, windowHours: number): string {
  return (
    `${v.count} of ${plural(v.calls, "duplicate cancel request", "duplicate cancel requests")} in the last ${windowHours} hours (${v.pct}%) ` +
    `were refused for a reason a person has to look at: ${breakdown(v.byName, REFUSAL_WORDS)}. ` +
    `Each opened its own handoff to sales; a share this high usually means the journey is naming the wrong ` +
    `booking or the identity match has drifted, which no single handoff shows.`
  );
}

export function formatDuplicateCancelUnavailableAllClear(recent: { calls: number; count: number }, windowHours: number): string {
  const n = recent.count === 0 ? "none" : `${recent.count}`;
  return (
    `Duplicate cancel requests are completing again: ${n} of the last ` +
    `${plural(recent.calls, "request", "requests")} in ${windowHours} hours ended in a 503.`
  );
}

export function formatDuplicateCancelRefusedAllClear(recent: { calls: number; count: number }, windowHours: number): string {
  const n = recent.count === 0 ? "none" : `${recent.count}`;
  return (
    `Duplicate cancel refusals are back to an ordinary share: ${n} of the last ` +
    `${plural(recent.calls, "request", "requests")} in ${windowHours} hours needed a person.`
  );
}

export interface RecentRun {
  calls: number;
  unavailable: number;
  refused: number;
  unavailableClean: boolean;
  refusedClean: boolean;
}

export type DuplicateCancelResult =
  | { status: "rebased"; rebased: Exclude<Rebase, null> }
  | { status: "judged"; verdict: DuplicateCancelVerdict; recent: RecentRun; paged: string[]; cleared: string[] };

/**
 * One monitor tick. A read or a write that fails THROWS, so the step's own boundary
 * records it and nothing is paged or cleared off a measurement that was not made.
 */
export async function runDuplicateCancelCheck(deps: {
  nowMs: number;
  readToday: () => Promise<OutcomeReading>;
  loadState: () => Promise<RateWindowState | null>;
  saveState: (state: RateWindowState) => Promise<void>;
  thresholds: DuplicateCancelThresholds;
  cooldownMs: { refused: number; unavailable: number };
  notify: ThrottledNotify<unknown>;
  resolve: AlertResolve<unknown>;
}): Promise<DuplicateCancelResult> {
  const t = deps.thresholds;
  const reading = await deps.readToday();
  const prev = await deps.loadState();
  const keepMs = Math.max(t.windowMs, t.recent.windowMs);
  const { state, rebased } = advanceWindow(prev, reading, deps.nowMs, keepMs);
  await deps.saveState(state);
  // A rebase records no sample, so this tick measured no interval: it neither pages
  // nor clears, whatever the samples already held say.
  if (rebased !== null) return { status: "rebased", rebased };

  const verdict = judgeDuplicateCancel(state, deps.nowMs, t);
  const r = windowTotals(state, deps.nowMs, t.recent.windowMs);
  const recentUnavailable = sum(pick(r.byCode, STAGE_NAMES));
  const recentRefused = sum(pick(r.byCode, REFUSAL_NAMES));
  const measured = r.attempts >= t.recent.minCalls;
  const recent: RecentRun = {
    calls: r.attempts,
    unavailable: recentUnavailable,
    refused: recentRefused,
    unavailableClean: measured && recentUnavailable * 100 <= t.recent.unavailableRecoverPct * r.attempts,
    refusedClean: measured && recentRefused * 100 <= t.recent.refusedRecoverPct * r.attempts,
  };
  const windowHours = Math.round(t.windowMs / 3_600_000);
  const recentHours = Math.round(t.recent.windowMs / 3_600_000);
  const paged: string[] = [];
  const cleared: string[] = [];

  const signals = [
    {
      key: DUPLICATE_CANCEL_UNAVAILABLE_KEY,
      v: verdict.status === "judged" ? verdict.unavailable : null,
      clean: recent.unavailableClean,
      cooldownMs: deps.cooldownMs.unavailable,
      page: formatDuplicateCancelUnavailablePage,
      allClear: () => formatDuplicateCancelUnavailableAllClear({ calls: r.attempts, count: recentUnavailable }, recentHours),
    },
    {
      key: DUPLICATE_CANCEL_REFUSED_KEY,
      v: verdict.status === "judged" ? verdict.refused : null,
      clean: recent.refusedClean,
      cooldownMs: deps.cooldownMs.refused,
      page: formatDuplicateCancelRefusedPage,
      allClear: () => formatDuplicateCancelRefusedAllClear({ calls: r.attempts, count: recentRefused }, recentHours),
    },
  ];
  for (const s of signals) {
    if (s.v?.status === "breach" && !s.clean) {
      await deps.notify(s.key, s.cooldownMs, s.page(s.v, windowHours));
      paged.push(s.key);
    } else if (s.clean) {
      await deps.resolve(s.key, s.allClear());
      cleared.push(s.key);
    }
  }
  return { status: "judged", verdict, recent, paged, cleared };
}
