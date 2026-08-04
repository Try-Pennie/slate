import { parseStampMs } from "@/lib/date/stamp";

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

/** Retries per tick. The set is normally 0 to 2 rows; the cap exists so a bad day
 *  cannot turn one monitor tick into hundreds of outbound cal.com calls. */
export const MAX_RETRIES_PER_TICK = 10;

export interface OverrideCandidate {
  id: string;
  email: string;
  startsAt: string;
  endsAt: string;
  /** The recorded cal.com outcome, which is what selected this row. */
  effect: string;
}

/** An outcome that needs no further attempts: it worked, or there was nothing to do. */
export function isSettled(outcome: string): boolean {
  return outcome.startsWith("ok") || outcome.startsWith("skipped");
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
export function selectCandidates(rows: OverrideCandidate[]): OverrideCandidate[] {
  return rows.filter((r) => !isSettled(r.effect));
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
    `Retries are running every 5 minutes; the recorded reason is on each time off request.`
  );
}

/** It cleared. */
export function formatUnprotectedRecovery(): string {
  return (
    "Every approved absence now has its cal.com block in place, so nobody can be " +
    "booked while they are away. No action is needed."
  );
}

export interface SweepResult {
  retried: number;
  cleared: number;
  unprotected: number;
  deferred: number;
  /** False when the candidate read failed, which is NOT health. */
  measured: boolean;
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
  alert: (key: string, text: string) => Promise<void>;
  resolve: (key: string, text: string) => Promise<boolean>;
  max?: number;
  log?: (msg: string) => void;
}): Promise<SweepResult> {
  const empty: SweepResult = {
    retried: 0,
    cleared: 0,
    unprotected: 0,
    deferred: 0,
    measured: false,
  };
  const loaded = await deps.loadCandidates();
  if (loaded === null) return empty;
  // Applied here rather than trusted to the loader, so a caller cannot forget the
  // rule and quietly narrow what gets retried.
  const rows = selectCandidates(loaded);

  const max = deps.max ?? MAX_RETRIES_PER_TICK;
  const attempt = rows.slice(0, max);
  const deferred = rows.length - attempt.length;
  if (deferred > 0) {
    deps.log?.(`deferred ${deferred} override retries past the per-tick cap`);
  }

  const stillFailing: OverrideCandidate[] = [];
  let cleared = 0;
  for (const row of attempt) {
    const outcome = await deps.retry(row.id);
    if (isSettled(outcome)) cleared++;
    else stillFailing.push({ ...row, effect: outcome });
  }
  // Rows past the cap were not attempted, so they are still failing as far as this
  // tick knows. Counting them as healthy would let the cap hide the condition.
  stillFailing.push(...rows.slice(max));

  const unprotected = inProgressUnprotected(stillFailing, deps.nowMs);
  if (unprotected.length > 0) {
    await deps.alert(CALCOM_UNPROTECTED_KEY, formatUnprotectedAlert(unprotected, deps.nowMs));
  } else {
    // Hung off the MEASURED healthy result: the read succeeded and nothing is
    // unprotected, which is the only evidence that clears this condition.
    await deps.resolve(CALCOM_UNPROTECTED_KEY, formatUnprotectedRecovery());
  }

  return {
    retried: attempt.length,
    cleared,
    unprotected: unprotected.length,
    deferred,
    measured: true,
  };
}
