import { parseStampMs } from "@/lib/date/stamp";
import {
  isRetiredSkip,
  OUTCOME_NOTHING_TO_REMOVE_PREFIX,
  OUTCOME_NOT_IN_CALCOM,
  OUTCOME_OK_PREFIX,
  OUTCOME_SKIPPED_PREFIX,
} from "@/lib/calcom/outcomes";
import type { AlertResolve } from "./alert-deps";

/**
 * Retry a cal.com availability override that failed, and page when an absence is
 * under way with cal.com never updated (#1253).
 *
 * cal.com is still the booking system taking real customer bookings, so an approved
 * absence whose override never landed leaves that agent bookable during their time
 * off. Until this lane, the only recovery was a human reading one Slack message and
 * pressing an admin button: a must-not-lose write resting on a best-effort
 * mechanism. One transient 500 in June consumed an absence's protection for good.
 *
 * SELECTION IS THE SUBTLE PART. Keyed on a recorded FAILURE, never on the
 * `calcom_synced` flag. Measured on prod 2026-08-04: 634 approved requests have the
 * flag false, but 631 of those predate the dual-write and carry no cal.com outcome
 * at all, so a flag-keyed sweep would have fired 631 writes, nearly all for
 * absences long past. Keyed on a failure it matched 2. A retry that comes back "ok"
 * or "skipped" stops matching and leaves the sweep on its own.
 */

export const CALCOM_UNPROTECTED_KEY = "ooo_calcom_unprotected";

/**
 * The per approval page, fired at approval time when the dual-write fails (#1280).
 *
 * Resolved from HERE rather than from the approval path, because this is where the
 * condition is re-measured. It was classified an incident on the reasoning that
 * "the transition path holds no state to clear", which was true before this sweep
 * existed and is not now: on 2026-08-04 request 844bdbab paged at 14:42, was
 * genuinely fixed that afternoon, and the firing marker was still set.
 *
 * Kept as a PAGE rather than demoted to an info whisper, which was the other option
 * on the table. `ooo_calcom_unprotected` only speaks once an absence is UNDER WAY,
 * so an override that keeps failing a week ahead would page nobody until the day
 * arrived. This is the early warning, and the early warning is the one worth having.
 */
export const CALCOM_ALERT_KEY = "ooo_calcom";

// Retries per tick, defined where a client module can import it (#2890).
import { MAX_RETRIES_PER_TICK } from "./override-sweep-limits.ts";
export { MAX_RETRIES_PER_TICK };

export interface OverrideCandidate {
  id: string;
  email: string;
  startsAt: string;
  endsAt: string;
  /** The recorded cal.com outcome, which is what selected this row. */
  effect: string;
}

/**
 * The skip that stops being true on its own (#1276).
 *
 * "Not in cal.com" says nothing about the absence and everything about the agent's
 * account, and that changes: agents missing from the cal.com org were added on
 * 2026-08-04, and new hires reaching Slate before cal.com make it the expected
 * direction of travel. Treating it as done left those agents bookable in cal.com
 * right through time off that Slate had already approved, with nothing retrying
 * and nothing reporting it.
 *
 * The OTHER skip, cal.com being unconfigured, is genuinely terminal: no later
 * tick can discover it has changed, and retrying it would spend a shared per tick
 * budget on a lookup that cannot succeed.
 */
export function isProvisionalSkip(outcome: string): boolean {
  return outcome.startsWith(OUTCOME_NOT_IN_CALCOM);
}

/**
 * The skip written while cal.com was marked retired (#2875), which stops being true
 * the moment an admin puts cal.com back (#2890).
 *
 * It used to be settled, like an unconfigured cal.com, and that is what made putting
 * cal.com back lose time off: every absence approved during retirement had recorded
 * this skip, nothing retried it, and cal.com went back to taking bookings with no
 * block for any of them. It is a FAILURE as far as a live sweep is concerned, not a
 * provisional skip: once cal.com is live it can book the agent, so an absence under
 * way with no block is exactly what `ooo_calcom_unprotected` exists to say, and
 * waiting for the absence to approach would protect nothing a lead can already book.
 *
 * A retired sweep never sees it: `runCalcomOverrideSweep` returns before reading a
 * single row while cal.com is retired, so this costs nothing during retirement.
 *
 * Defined beside the other outcomes in `@/lib/calcom/outcomes` and re-exported here.
 */
export { isRetiredSkip };

/**
 * An outcome that needs no further attempts: it worked, or there was nothing to do
 * AND nothing that could change.
 */
export function isSettled(outcome: string): boolean {
  if (isProvisionalSkip(outcome) || isRetiredSkip(outcome)) return false;
  return outcome.startsWith(OUTCOME_OK_PREFIX) || outcome.startsWith(OUTCOME_SKIPPED_PREFIX);
}

/**
 * An outcome that means an override which SHOULD exist does not (#1276).
 *
 * Deliberately narrower than "not settled": an agent with no cal.com account
 * cannot be booked there by anyone, so nothing is unprotected and nothing should
 * page. Splitting the two is what lets a provisional skip be retried every tick
 * without turning into a nightly alarm about an account nobody in Slate can
 * create.
 */
export function isFailure(outcome: string): boolean {
  return !isProvisionalSkip(outcome) && !isSettled(outcome);
}

/**
 * The retry cannot ask cal.com anything without the agent's address, and there are
 * TWO ways it can be missing (#2383). They are kept apart here rather than at the
 * read, so both are driven by a test that never touches a database.
 *
 * The read used to swallow its `error`, so a query that never ran arrived as a null
 * row and was reported as "failed: agent has no email", written into
 * `ooo_requests.side_effects` and quoted in the Slack line. That is a claim about
 * the agent nothing measured (L11), and it sends somebody to repair a roster row
 * that is perfectly fine.
 *
 * Both outcomes are FAILURES rather than skips, and deliberately so: the override
 * that should exist still does not, the row stays in the candidate set, and the
 * next tick tries again. A skip would settle the row and leave an agent bookable in
 * cal.com right through an absence Slate has approved.
 */
export const OUTCOME_EMAIL_UNREADABLE = "failed: could not read the agent's email";
export const OUTCOME_NO_EMAIL = "failed: agent has no email";

export function agentEmailForRetry(
  res: { data: { email?: string } | null; error: { message: string } | null },
): { email: string } | { outcome: string } {
  if (res.error) return { outcome: OUTCOME_EMAIL_UNREADABLE };
  const email = res.data?.email;
  if (!email) return { outcome: OUTCOME_NO_EMAIL };
  return { email };
}

/**
 * Which loaded rows still need an attempt. The caller hands over every approved
 * absence that has not ended; this decides, in code rather than in a query.
 *
 * Deciding here rather than in the SQL is what makes the interesting case
 * expressible at all (#1275). Nine approved FUTURE absences carry NO cal.com
 * outcome, because they were approved before the dual-write existed: they are not
 * failures, and they are certainly not done, so a filter keyed on either word
 * misses them and those agents stay bookable in cal.com right through their time
 * off. "Not settled" covers a recorded failure and a blank alike.
 *
 * It stays cheap because the caller's set is bounded by absences that have not
 * ended: 44 rows on prod 2026-08-04, of which 35 were already done.
 */
/**
 * How close an absence has to be before a provisional skip is retried (#1276).
 *
 * Without a bound, an agent who never gets a cal.com account would cost one
 * outbound lookup every five minutes for as long as the absence is in the
 * future, and would hold a slot in the per tick cap the whole time. The retry is
 * only USEFUL before somebody can book into the absence, and nobody can book
 * further out than the booking horizon (days, not weeks), so two weeks is
 * comfortably early while costing nothing for an absence six months away.
 *
 * A far future absence is not dropped, only deferred: it re-enters the set as it
 * approaches, which is well before anyone could book into it.
 */
export const PROVISIONAL_RETRY_WINDOW_DAYS = 14;

/**
 * `nowMs` is REQUIRED rather than defaulted (#2502). A default read of the clock is
 * a seam nobody has to use, so the one caller that forgot it was a test whose
 * fixture start was pinned to a constant and whose horizon walked with real time:
 * the pair had drifted into asserting about a window nobody chose (L130). The
 * monitor lane already holds a clock and passes it, so nothing production side wanted
 * the default.
 */
export function selectCandidates(
  rows: OverrideCandidate[],
  nowMs: number,
): OverrideCandidate[] {
  const horizon = nowMs + PROVISIONAL_RETRY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const picked = rows.filter((r) => {
    if (isSettled(r.effect)) return false;
    if (!isProvisionalSkip(r.effect)) return true;
    // An unreadable start is treated as NEAR, not far: the fail-safe side of this
    // comparison is the one that keeps checking, since the cost of an extra
    // lookup is a lookup and the cost of skipping is an agent bookable through
    // their time off (L50).
    const startMs = parseStampMs(r.startsAt);
    return startMs === null || startMs <= horizon;
  });
  // Real failures first. The per tick cap is a shared budget, and a run of agents
  // waiting on cal.com accounts would otherwise push an override that genuinely
  // failed past it, leaving it unattempted for a whole tick while the cheap,
  // benign class consumed every slot (L117). A stable partition, not a sort, so
  // the order within each group is the loader's.
  return [
    ...picked.filter((r) => !isProvisionalSkip(r.effect)),
    ...picked.filter((r) => isProvisionalSkip(r.effect)),
  ];
}

/**
 * Join raw request rows to the agents who are still here, DROPPING any request whose
 * agent is absent from the map.
 *
 * An agent who has left cannot be booked by anyone, so an override for them protects
 * nothing, and paging to ask a human to place one would be asking for work with no
 * purpose in it. The caller passes active agents only; a missing entry therefore
 * means "no longer with us", never "email unknown", so the row is dropped rather
 * than carried with a placeholder.
 *
 * Real case on 2026-08-04: the one remaining skipped absence belonged to someone who
 * had left Pennie. Benign there only because a skip settles and leaves the set; a
 * departed agent still present in cal.com whose write failed would have paged.
 */
export function toCandidates(
  rows: { id: string; userId: string; startsAt: string; endsAt: string; effect: string }[],
  activeEmailById: Map<string, string>,
): OverrideCandidate[] {
  const out: OverrideCandidate[] = [];
  for (const r of rows) {
    const email = activeEmailById.get(r.userId);
    if (!email) continue;
    out.push({ id: r.id, email, startsAt: r.startsAt, endsAt: r.endsAt, effect: r.effect });
  }
  return out;
}

/**
 * Absences already under way whose override is still not in place. This is the
 * reportable condition: from the moment the absence starts, a real customer can
 * book an agent who is not there.
 *
 * An unreadable start reads as UNDER WAY, the fail-safe side: `Date.parse` of a bad
 * value is NaN and every comparison with it is false, which would silently classify
 * the row as "not started yet" and hide the exact state this exists to find.
 */
export function inProgressUnprotected(
  rows: OverrideCandidate[],
  nowMs: number,
): OverrideCandidate[] {
  return rows.filter((r) => {
    const startMs = parseStampMs(r.startsAt);
    return startMs === null || startMs <= nowMs;
  });
}

/** Page copy. Says who, how many, and where to look, and nothing else. */
export function formatUnprotectedAlert(rows: OverrideCandidate[], nowMs: number): string {
  const started = inProgressUnprotected(rows, nowMs);
  const who = started.slice(0, 3).map((r) => r.email).join(", ");
  const more = started.length > 3 ? ` and ${started.length - 3} more` : "";
  const noun = started.length === 1 ? "agent is" : "agents are";
  return (
    `${started.length} ${noun} on approved time off right now with no cal.com block in place ` +
    `(${who}${more}), so cal.com can still book them while they are away. ` +
    `Retries are running every 5 minutes; the recorded reason is on each time off request. ` +
    `If cal.com no longer takes bookings, mark it retired on the alerts page and this stops.`
  );
}

/**
 * The ending for both pages once cal.com is marked retired (#2875). Not a recovery:
 * no block was put in place, and there is nothing left for one to protect, because
 * nobody books through cal.com any more. Slate's own busy block is what keeps an
 * absent agent from being offered, and it never depended on cal.com.
 */
export function formatCalcomRetiredSweepEnding(): string {
  return (
    "cal.com has been marked retired on the alerts page, so nobody can be booked " +
    "through it and an absence needs no cal.com block. The earlier page is cleared. " +
    "If cal.com is still taking bookings, turn that setting off again."
  );
}

/** It cleared. */
export function formatUnprotectedRecovery(): string {
  return (
    "Every approved absence now has its cal.com block in place, so nobody can be " +
    "booked while they are away. No action is needed."
  );
}

/**
 * The all-clear for the per approval page (#1280).
 *
 * Says what changed in the reader's terms: the override the page named is in place
 * now. It names no request id, because the page is one key covering every failing
 * approval and by the time this sends there are none, so quoting one would suggest
 * the others were left.
 */
export function formatOverrideRecovery(): string {
  return (
    "The cal.com availability overrides that had failed are all in place now, so " +
    "no approved absence is missing its block. The earlier page is cleared and no " +
    "action is needed."
  );
}

/**
 * A block left in cal.com when time off was cancelled or changed while cal.com was
 * retired (#2890, `calcom_override_removals`). Only unresolved windows that have
 * not ended are handed over.
 */
export interface RemovalCandidate {
  id: string;
  startsAt: string;
  endsAt: string;
}

/**
 * Whether a stale block's removal is done: it was taken out, it was already gone
 * (the client rewrote the dates to match Slate either way), or there was never
 * anything in cal.com to take out. A removal skipped because cal.com is retired is
 * NOT done: the block is still there.
 */
export function isRemovalResolved(outcome: string): boolean {
  if (isRetiredSkip(outcome)) return false;
  if (outcome.startsWith(OUTCOME_NOTHING_TO_REMOVE_PREFIX)) return true;
  return outcome.startsWith(OUTCOME_OK_PREFIX) || outcome.startsWith(OUTCOME_SKIPPED_PREFIX);
}

export interface SweepResult {
  retried: number;
  cleared: number;
  unprotected: number;
  deferred: number;
  /** False when the candidate read failed, which is NOT health. */
  measured: boolean;
  /** #2890: stale cal.com blocks taken out this tick. */
  removed: number;
  /** #2890: stale blocks whose removal was attempted and did not land. */
  removalsFailing: number;
  /** #2890: stale blocks past the per tick cap, left for the next tick. */
  removalsDeferred: number;
  /** #2890: false when the stale block list could not be read (or was not asked). */
  removalsMeasured: boolean;
}

/**
 * One sweep. `loadCandidates` returns null when it could not read, which must
 * neither page (it would name nobody) nor all-clear (it would announce a recovery
 * on the strength of a query that never ran).
 */
export async function runCalcomOverrideSweep(deps: {
  nowMs: number;
  loadCandidates: () => Promise<OverrideCandidate[] | null>;
  retry: (requestId: string) => Promise<string>;
  alert: AlertResolve<void>;
  resolve: AlertResolve;
  max?: number;
  log?: (msg: string) => void;
  /**
   * #2875: whether cal.com is marked retired. Retired, nothing is retried and both
   * pages end with `formatCalcomRetiredSweepEnding`. A read that failed or threw
   * keeps today's sweep, because during the parallel run a missing block lets
   * cal.com book somebody who is away. Omitted, it reads as live.
   */
  calcomRetired?: () => Promise<boolean | null>;
  /**
   * #2890: the blocks left in cal.com while it was retired, or null when that read
   * failed. Omitted, none are asked for. Read only once cal.com is live.
   */
  loadRemovals?: () => Promise<RemovalCandidate[] | null>;
  /** #2890: take one stale block out and record the outcome, returning it. */
  removeStale?: (removalId: string) => Promise<string>;
}): Promise<SweepResult> {
  const empty: SweepResult = {
    retried: 0,
    cleared: 0,
    unprotected: 0,
    deferred: 0,
    measured: false,
    removed: 0,
    removalsFailing: 0,
    removalsDeferred: 0,
    removalsMeasured: false,
  };
  const endAsRetired = async (partial: Partial<SweepResult>): Promise<SweepResult> => {
    await deps.resolve(CALCOM_UNPROTECTED_KEY, formatCalcomRetiredSweepEnding());
    await deps.resolve(CALCOM_ALERT_KEY, formatCalcomRetiredSweepEnding());
    return { ...empty, ...partial, measured: true };
  };
  let retired: boolean | null = false;
  if (deps.calcomRetired) {
    try {
      retired = await deps.calcomRetired();
    } catch {
      retired = null;
    }
  }
  if (retired === true) {
    // Hung off a MEASURED answer: the setting was read and says retired, which is
    // the only evidence that ends these two pages without a block in place.
    deps.log?.("cal.com is retired, so no override is retried");
    return endAsRetired({});
  }

  const loaded = await deps.loadCandidates();
  if (loaded === null) return empty;
  // Applied here rather than trusted to the loader, so a caller cannot forget the
  // rule and quietly narrow what gets retried.
  const rows = selectCandidates(loaded, deps.nowMs);

  const max = deps.max ?? MAX_RETRIES_PER_TICK;
  const attempt = rows.slice(0, max);
  const deferred = rows.length - attempt.length;
  if (deferred > 0) {
    deps.log?.(`deferred ${deferred} override retries past the per-tick cap`);
  }

  const stillFailing: OverrideCandidate[] = [];
  let cleared = 0;
  let retried = 0;
  for (const row of attempt) {
    const outcome = await deps.retry(row.id);
    retried++;
    if (isRetiredSkip(outcome)) {
      // #2890: the setting read above came from a per isolate cache, and the retry
      // read it FRESH and found cal.com retired. That is a measurement, so the tick
      // ends the way a retired tick does, rather than paging that cal.com can book
      // an absent agent, or claiming every block is in place, both of which would
      // be false. Nothing further is attempted: each would only record the same skip.
      deps.log?.("cal.com was retired during this tick, so no further override is retried");
      return endAsRetired({ retried, cleared });
    }
    if (isSettled(outcome)) cleared++;
    // #1276: a provisional skip is neither. It is not cleared, because the agent
    // may get a cal.com account before the absence starts and the next tick has to
    // look again; and it is not failing, because nobody can book an agent who does
    // not exist there, so there is nothing to be unprotected about.
    else if (isFailure(outcome)) stillFailing.push({ ...row, effect: outcome });
  }
  // Rows past the cap were not attempted, so they are still failing as far as this
  // tick knows. Counting them as healthy would let the cap hide the condition. The
  // same split applies: an unattempted provisional skip is not evidence of a
  // missing override either.
  stillFailing.push(...rows.slice(max).filter((r) => isFailure(r.effect)));

  const unprotected = inProgressUnprotected(stillFailing, deps.nowMs);
  if (unprotected.length > 0) {
    await deps.alert(CALCOM_UNPROTECTED_KEY, formatUnprotectedAlert(unprotected, deps.nowMs));
  } else {
    // Hung off the MEASURED healthy result: the read succeeded and nothing is
    // unprotected, which is the only evidence that clears this condition.
    await deps.resolve(CALCOM_UNPROTECTED_KEY, formatUnprotectedRecovery());
  }

  // #1280: the per approval page ends when NOTHING is failing any more. Note this
  // reads `stillFailing`, which already carries the rows past the per tick cap:
  // those were never attempted, so this tick knows nothing about them, and counting
  // them as settled would let the cap end a page for a request still failing.
  if (stillFailing.length === 0) {
    await deps.resolve(CALCOM_ALERT_KEY, formatOverrideRecovery());
  }

  // #2890: the blocks left in cal.com while it was retired, out of whatever the per
  // tick cap has left after the override retries, which go first because a missing
  // block lets cal.com book somebody who is away while a stale one only withholds a
  // day the agent works. They never page: the stale direction is the safe one, and
  // a removal that keeps failing is retried every tick and logged. Done after the
  // pages are settled, so an unreadable list cannot hold either page open.
  const removals = {
    removed: 0,
    removalsFailing: 0,
    removalsDeferred: 0,
    removalsMeasured: false,
  };
  if (deps.loadRemovals && deps.removeStale) {
    const stale = await deps.loadRemovals();
    if (stale === null) {
      deps.log?.("the cal.com blocks left while it was retired could not be read");
    } else {
      removals.removalsMeasured = true;
      const room = Math.max(0, max - attempt.length);
      const take = stale.slice(0, room);
      removals.removalsDeferred = stale.length - take.length;
      for (const row of take) {
        const outcome = await deps.removeStale(row.id);
        if (isRetiredSkip(outcome)) {
          deps.log?.("cal.com was retired during this tick, so no further block is taken out");
          return endAsRetired({ retried: attempt.length, cleared, ...removals });
        }
        if (isRemovalResolved(outcome)) removals.removed++;
        else removals.removalsFailing++;
      }
      if (removals.removalsFailing > 0) {
        deps.log?.(`${removals.removalsFailing} cal.com blocks left while it was retired could not be taken out`);
      }
    }
  }

  return {
    retried: attempt.length,
    cleared,
    unprotected: unprotected.length,
    deferred,
    measured: true,
    ...removals,
  };
}
