/**
 * The words the every-lane cron alerts say (#1153).
 *
 * Lifted out of the route handlers so the alert preview renders the REAL copy by
 * calling these (L41: one place per sentence). All of these are CONDITIONS, so
 * each has a matching all-clear that a person reads in the same channel.
 */

/** The hourly Salesforce roster sync is failing on consecutive runs. */
export function agentSyncFailureAlert(message: string): string {
  return `Slate: the hourly Salesforce agent sync failed on consecutive runs (${message}). Agent teams and the roster may be stale until it succeeds or someone runs Sync from the admin page.`;
}

/** It works again. */
export function agentSyncRecovery(): string {
  return "Slate: the hourly Salesforce agent sync is working again. The agent roster and team " +
        "assignments are up to date, so the earlier page is cleared. No action is needed.";
}

/** Recompute is not keeping up with the buckets that are due. */
export function recomputeHeadroomAlert(
  recomputed: number,
  due: number,
  totalBuckets: number,
  utilizationPct: number,
): string {
  return `Slate: bucket recompute is falling behind. Refreshed only ${recomputed} of ${due} due buckets within its time budget on consecutive cycles (${totalBuckets} buckets total, last cycle used ${utilizationPct}%). Availability may start going stale. Scale: widen the freshness window or move to the Durable-Objects design.`;
}

/** It caught up. */
export function recomputeHeadroomRecovery(): string {
  return "Slate: bucket recompute has caught up. It refreshed every bucket that was due within " +
          "its time budget this cycle, so availability is being kept fresh again. No action is needed.";
}

/** Cached slot rows are going stale after a recompute pass. */
export function bucketSlotsStaleAlert(count: number, minutes: number, examples: string[]): string {
  return `Slate: ${count} bucket_slots row(s) stale >${minutes}m (e.g. ${examples.join(", ")}); a precompute writer may be stuck.`;
}

/** Nothing is stale any more. */
export function bucketSlotsStaleRecovery(): string {
  return "Slate: no cached availability rows are stale any more. The precompute writers are " +
          "keeping up, so the booker is showing current times again. No action is needed.";
}

/** A manager's daily time-off digest is not reaching them. */
export function digestUnreachableAlert(managerLabel: string, afterRuns: number): string {
  return (
    `Slate: a manager is not receiving their daily pending time off digest on Slack. ` +
    `${managerLabel} has been unreachable for at least ${afterRuns} days running, ` +
    `so time off requests waiting on their approval may be piling up unseen. ` +
    `Check that their Slack account uses their Slate email address.`
  );
}

/** It reached them. */
export function digestUnreachableRecovery(managerLabel: string): string {
  return (
    `Slate: ${managerLabel} is receiving their daily pending time off digest again, so approvals ` +
    `waiting on them are being surfaced. No action is needed.`
  );
}

/** An endpoint has exhausted its delivery retries. */
export function webhookDeadAlert(url: string, event: string, attempt: number, lastResponse: string): string {
  return `Slate: webhook delivery to ${url} keeps failing (event ${event}, ${attempt} attempts). Last response: ${lastResponse}`;
}

/** Deliveries are landing again. */
export function webhookDeadRecovery(url: string): string {
  return (
    `Slate: webhook delivery to ${url} is succeeding again, so events are reaching it ` +
    `and the earlier page is cleared. Deliveries that dead-lettered while it was down are not ` +
    `re-sent automatically; replay them from the admin webhooks page if they matter.`
  );
}
