/**
 * The words the every-lane cron alerts say (#1153).
 *
 * Lifted out of the route handlers so the alert preview renders the REAL copy by
 * calling these (L41: one place per sentence). All of these are CONDITIONS, so
 * each has a matching all-clear that a person reads in the same channel.
 */

/** The hourly Salesforce roster sync is failing on consecutive runs. */
export function agentSyncFailureAlert(message: string): string {
  return `The hourly Salesforce agent sync failed on consecutive runs (${message}). Agent teams and the roster may be stale until it succeeds or someone runs Sync from the admin page.`;
}

/** It works again. */
export function agentSyncRecovery(): string {
  return "The hourly Salesforce agent sync is working again. The agent roster and team " +
        "assignments are up to date, so the earlier page is cleared. No action is needed.";
}

/** Recompute is not keeping up with the buckets that are due. */
export function recomputeHeadroomAlert(
  recomputed: number,
  due: number,
  totalBuckets: number,
  utilizationPct: number,
): string {
  return (
    `Bucket recompute is falling behind. Refreshed only ${recomputed} of ${due} due buckets ` +
    `within its time budget on consecutive cycles (${totalBuckets} buckets total, last cycle ` +
    `used ${utilizationPct}%). Availability may start going stale. To scale: widen the ` +
    `freshness window, which moves the staleness alarm out with it so this does not just ` +
    `swap one page for another, or move to the Durable Objects design.`
  );
}

/** It caught up. */
export function recomputeHeadroomRecovery(): string {
  return "Bucket recompute has caught up. It refreshed every bucket that was due within " +
          "its time budget this cycle, so availability is being kept fresh again. No action is needed.";
}

/** Cached slot rows are going stale after a recompute pass. */
export function bucketSlotsStaleAlert(count: number, minutes: number, examples: string[]): string {
  return `${count} bucket_slots row(s) stale >${minutes}m (e.g. ${examples.join(", ")}); a precompute writer may be stuck.`;
}

/**
 * The same staleness, but the deliberate-invalidation marker could not be READ
 * (#1304), on enough consecutive ticks that a blip is ruled out.
 *
 * Distinct copy on purpose. The ordinary page says a precompute writer may be
 * stuck, which is a measured claim about the drain; here nothing about the drain
 * was measured at all, because the one value that would have explained the
 * staleness is unavailable. Sending the ordinary wording would point the reader at
 * the writers when the thing to look at is the read.
 */
export function bucketSlotsStaleUnreadableMarkerAlert(
  count: number,
  minutes: number,
  examples: string[],
  consecutiveTicks: number,
): string {
  return (
    `${count} bucket_slots row(s) stale >${minutes}m (e.g. ${examples.join(", ")}), and the ` +
    `deliberate invalidation marker has been unreadable for ${consecutiveTicks} minutes running, ` +
    `so nothing can say whether a booking settings save explains this or a precompute writer is ` +
    `stuck. Check the alert_state read first, then the writers.`
  );
}

/** Nothing is stale any more. */
export function bucketSlotsStaleRecovery(): string {
  return "No cached availability rows are stale any more. The precompute writers are " +
          "keeping up, so the booker is showing current times again. No action is needed.";
}

/** A manager's daily time-off digest is not reaching them. */
export function digestUnreachableAlert(managerLabel: string, afterRuns: number): string {
  return (
    `A manager is not receiving their daily pending time off digest on Slack. ` +
    `${managerLabel} has been unreachable for at least ${afterRuns} days running, ` +
    `so time off requests waiting on their approval may be piling up unseen. ` +
    `Check that their Slack account uses their Slate email address.`
  );
}

/** It reached them. */
export function digestUnreachableRecovery(managerLabel: string): string {
  return (
    `${managerLabel} is receiving their daily pending time off digest again, so approvals ` +
    `waiting on them are being surfaced. No action is needed.`
  );
}

/**
 * The daily nudge for time off nobody can be nudged about could not be posted
 * (#1499).
 *
 * Its own key and its own words, not the per manager one: nothing here is a
 * Slack address problem, and there is no manager to name. The requests behind it
 * are exactly the ones with no assigned approver, so a silent failure leaves the
 * least watched part of the queue with nobody watching it at all.
 */
export function digestUnroutedUnreachableAlert(count: number, afterRuns: number): string {
  const noun = count === 1 ? "request" : "requests";
  return (
    `The daily Slack post for time off requests with no assigned approver has failed ` +
    `${afterRuns} days running. ${count} ${noun} ${count === 1 ? "is" : "are"} waiting with ` +
    `nobody nudged about ${count === 1 ? "it" : "them"}. Review them on the time off queue, ` +
    `and check the alerts channel the bot posts to.`
  );
}

/** The post is landing again. */
export function digestUnroutedUnreachableRecovery(): string {
  return (
    `The daily Slack post for time off requests with no assigned approver is landing again, ` +
    `so requests with nobody to nudge are being surfaced. No action is needed.`
  );
}

/** An endpoint has exhausted its delivery retries. */
export function webhookDeadAlert(url: string, event: string, attempt: number, lastResponse: string): string {
  return `Webhook delivery to ${url} keeps failing (event ${event}, ${attempt} attempts). Last response: ${lastResponse}`;
}

/** Deliveries are landing again. */
export function webhookDeadRecovery(url: string): string {
  return (
    `Webhook delivery to ${url} is succeeding again, so events are reaching it ` +
    `and the earlier page is cleared. Deliveries that dead-lettered while it was down are not ` +
    `re-sent automatically; replay them from the admin webhooks page if they matter.`
  );
}
