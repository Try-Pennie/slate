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

/**
 * The Twilio half of the roster sync could not read Twilio (#2097).
 *
 * Its own key, not folded into `agent_sync_failures`, because the two send somebody
 * to different places and either half can fail while the other works: the Salesforce
 * one is a Salesforce or a credentials problem, and this one is a Twilio key, a
 * Twilio outage, or a deployment that never had the three secrets set.
 *
 * The REASON is the whole message here rather than a raw error, because the five ways
 * the read can fail each carry their own wording and their own instruction already
 * (`src/lib/twilio/client.ts`). What this adds is the consequence, which is the part
 * a reader cannot infer: while it is failing, nobody is being taken out of the pool
 * for carrying the Redistribute tag.
 */
export function twilioSyncFailureAlert(reason: string): string {
  return (
    `The roster sync could not read Twilio on two runs in a row, so no agent was taken out of the bookable pool for the Redistribute tag ` +
    `and nobody was put back in. Salesforce still synced. ${reason}`
  );
}

/** It can read Twilio again. */
export function twilioSyncRecovery(): string {
  return (
    "The roster sync can read Twilio again, so the Redistribute tag is being acted on once more. " +
    "Anybody tagged while it was failing has been taken out of the bookable pool. No action is needed."
  );
}

/**
 * The writes that did not land (#2114).
 *
 * The READ failing is already paged. What was not, until this, is the half after
 * it: a flip that keeps throwing, a coverage sweep that could not be queued, a
 * legal value that would not write. Each was counted, logged and put in the sync
 * banner, and reported by nothing at all on an unattended hourly run, which is the
 * shape #1394 exists to prevent: a count nobody reads is indistinguishable from a
 * count of zero.
 *
 * The FLIP LEADS whenever there is one, because it is the only one of the three
 * that misroutes a lead today: the agent is still in the pool, so Slate is still
 * offering somebody Twilio withholds. The other two are latent, and each is still
 * named with its own count rather than folded into a total, because they send a
 * reader to three different places (L11, L609).
 */
export function twilioWriteFailureAlert(counts: {
  flips: number;
  sweeps: number;
  attributes: number;
}): string {
  const parts: string[] = [];
  if (counts.flips > 0) {
    parts.push(
      `${agents(counts.flips)} Twilio withholds could not be taken out of the bookable pool, so Slate is still offering them to leads`,
    );
  }
  if (counts.sweeps > 0) {
    parts.push(
      `${agents(counts.sweeps)} left the pool and the move of their upcoming calls could not be queued, so those calls are still with them: move them from the coverage panel on their profile`,
    );
  }
  if (counts.attributes > 0) {
    // Named as the routing attributes rather than as legal eligibility since
    // #2152: the same write now carries the debt tiers and the backend service,
    // and a message naming only one of the three sends a reader to check the one
    // fact that may be perfectly fine.
    parts.push(
      `${agents(counts.attributes)} could not have their routing attributes recorded, so their debt tiers, backend service and legal eligibility are whatever Slate held before`,
    );
  }
  return (
    `The roster sync read Twilio and could not finish acting on it, on two runs in a row. ` +
    `${parts.join(". ")}. Check the Worker logs for tag=twilio-sync.`
  );
}

/** The writes are landing again. */
export function twilioWriteFailureRecovery(): string {
  return (
    "The roster sync is acting on Twilio again: the flips, the coverage moves and the routing " +
    "attribute writes all landed on the latest run. No action is needed."
  );
}

/**
 * Slate is holding somebody out of the pool and Twilio no longer has a worker for
 * them (#2114).
 *
 * Deliberately does NOT say to press sync again. Re-running changes nothing while
 * the worker is missing: the sync correctly does nothing on an absence, because a
 * source that is present and silent about one person is not the same as one saying
 * the tag is gone (L214). The repair is in Twilio, or it is a person deciding to
 * put them back by hand, and a message naming an action that cannot change the
 * state is worse than no message (L111).
 */
export function twilioOrphanedMarkAlert(count: number): string {
  return (
    `${agents(count)} ${count === 1 ? "is" : "are"} out of the bookable pool because Slate marked them ` +
    `redistribute, and Twilio now holds no worker for ${count === 1 ? "that address" : "those addresses"}. ` +
    `Nothing can say whether the tag was removed or the worker went away, so Slate is leaving them out. ` +
    `Either restore the Twilio worker, or turn them back on from their profile.`
  );
}

/** Every mark has a worker again. */
export function twilioOrphanedMarkRecovery(): string {
  return (
    "Every agent Slate is holding out of the pool for redistribute has a Twilio worker again, " +
    "so the tag can be read for all of them. No action is needed."
  );
}

/**
 * The reroute for demoted advisors could not finish, on two roster runs in a row (#3615). Each
 * part is its own fault with its own consequence (L11), and the switch comes first because it
 * means NOBODY was checked, which hides every other count.
 */
export function demotionTriggerFailureAlert(counts: {
  switchUnreadable: boolean;
  evals: number;
  sweeps: number;
  writes: number;
}): string {
  const parts: string[] = [];
  if (counts.switchUnreadable) {
    parts.push(
      "Slate could not read whether the automatic reroute is switched on, so it treated it as off and checked nobody",
    );
  }
  if (counts.evals > 0) {
    parts.push(
      `${agents(counts.evals)} whose Twilio tiers changed could not be checked against the calls they hold, so a call they can no longer take may still be with them`,
    );
  }
  if (counts.sweeps > 0) {
    parts.push(
      `${agents(counts.sweeps)} lost a pool their calls need and the move of those calls could not be queued, so the calls are still with them: move them from the coverage panel on their profile`,
    );
  }
  if (counts.writes > 0) {
    parts.push(
      `${agents(counts.writes)} could not have their demotion recorded, so the next run will try again`,
    );
  }
  return (
    "The automatic reroute for advisors Twilio demoted could not finish, on two roster runs in a row. " +
    `${parts.join(". ")}. Check the Worker logs for tag=twilio-sync.`
  );
}

/** The reroute for demoted advisors ran cleanly again. */
export function demotionTriggerFailureRecovery(): string {
  return (
    "The automatic reroute for advisors Twilio demoted is running cleanly again: on the latest run " +
    "every changed agent was checked and every move was queued. No action is needed."
  );
}

/** "1 agent" / "4 agents", so a count of one never renders as a plural. */
function agents(n: number): string {
  return `${n} agent${n === 1 ? "" : "s"}`;
}

/** It works again. */
export function agentSyncRecovery(): string {
  return "The hourly Salesforce agent sync is working again. The agent roster and team " +
        "assignments are up to date, so the earlier page is cleared. No action is needed.";
}

/**
 * The shared cross system rep key cannot be settled for some people (#1587).
 *
 * Four shapes, one page, because the reader's first action is the same for all
 * of them (open Salesforce and look at those users) and four separate keys would
 * be four pages about one morning's data problem. Each count is named separately
 * inside it, because what they then DO differs: a disagreement is a decision about
 * which record is the person, a duplicate is a Salesforce cleanup, a claimed
 * id means two Slate rows are pointing at one human, and a refused deactivation
 * is somebody the hourly reap will not act on either way until it is settled.
 *
 * Deliberately NOT sent for rows with no id at all. That is reported in the run's
 * counts and its log line: a person with no key is one every consumer refuses,
 * which is safe, while a key that may name the WRONG person is not.
 *
 * @param deactivationsRefused reapable rows the reap left alone because their
 *   address answers to several Salesforce records that disagree (#2387). It
 *   belongs here rather than on a key of its own: it is the SAME shared address
 *   that produces `ambiguous`, reaching a different decision, and it is settled by
 *   the same edit in Salesforce.
 */
export function salesforceUserIdConflictAlert(
  disagreements: number,
  ambiguous: number,
  claimed: number,
  deactivationsRefused: number,
): string {
  const parts: string[] = [];
  if (disagreements > 0) {
    parts.push(
      `${disagreements} ${disagreements === 1 ? "person has" : "people have"} a stored ` +
        `Salesforce id that no longer matches the one Salesforce returns for their email`,
    );
  }
  if (ambiguous > 0) {
    parts.push(
      `${ambiguous} email ${ambiguous === 1 ? "address is" : "addresses are"} shared by ` +
        `more than one Salesforce user`,
    );
  }
  if (claimed > 0) {
    parts.push(
      `${claimed} Slate ${claimed === 1 ? "row wants" : "rows want"} a Salesforce id ` +
        `another Slate row already holds`,
    );
  }
  if (deactivationsRefused > 0) {
    parts.push(
      `${deactivationsRefused} ${deactivationsRefused === 1 ? "person was" : "people were"} ` +
        `left in the roster rather than deactivated, because their address answers to ` +
        `several Salesforce records and only some of them are inactive`,
    );
  }
  return (
    `The Salesforce user id could not be settled for part of the roster: ${parts.join("; ")}. ` +
    `Nothing was changed, on purpose: the stored ids are left exactly as they were, so no ` +
    `existing link has been re-pointed at a different person. Time off and manager checks ` +
    `will refuse to name these people until it is resolved. Look at them in Salesforce and ` +
    `decide which record is the person; the sync log line tagged sf-sync names the Slate rows.`
  );
}

/**
 * A manager of record could not be settled, because the Agent_Manager picklist
 * name answers to more than one Salesforce user (#1653).
 *
 * Its own key rather than a fold into the user id conflicts above: that one is
 * about the stored id column, and its all-clear says the roster agrees about user
 * ids. Sharing a key would give two independent checks one status field, so
 * clearing either would clear both (L53).
 *
 * @param agents How many PEOPLE have no settled approver (not how many names are
 *   duplicated), because that is the number the reader has to act on.
 * @param names  How many picklist values are duplicated, since editing those is
 *   the whole remedy.
 */
export function salesforceManagerAmbiguousAlert(
  agents: number,
  names: number,
): string {
  return (
    `${names} manager ${names === 1 ? "name" : "names"} in the Salesforce Agent_Manager ` +
    `picklist ${names === 1 ? "answers" : "answer"} to more than one Salesforce user, so ` +
    `${agents} ${agents === 1 ? "person has" : "people have"} no settled approver. Nothing ` +
    `was changed, on purpose: choosing one of the matches would route their time off ` +
    `approvals to somebody who may not be their manager, and every screen would still read ` +
    `as correct. Any manager link they already had was left exactly as it was, so it may now ` +
    `be out of date. Make the duplicated name unique in Salesforce, or point those people at ` +
    `a name that is, and the next hourly sync settles it. The sync log line tagged sf-sync ` +
    `names the picklist values.`
  );
}

/** Every manager name answers to exactly one Salesforce user again. */
export function salesforceManagerAmbiguousRecovery(): string {
  return (
    "Every manager name in the Salesforce Agent_Manager picklist now answers to exactly one " +
    "Salesforce user, so the earlier page is cleared. Manager links are being kept in step " +
    "with Salesforce again, and time off approvals route to the right person. No action is " +
    "needed."
  );
}

/**
 * A bookable agent the hourly roster query no longer returns (#1833).
 *
 * Only the bookable ones reach this: an unconfirmed row nobody can be routed to
 * is a stale admin display, and an hourly page about one is how a whole family of
 * alerts stops being read (L36). What makes this one worth a phone is that the
 * lead goes to somebody the source says should not be taking the call.
 */
export function salesforceRosterDivergenceAlert(bookable: number): string {
  return (
    `${bookable} ${bookable === 1 ? "agent is" : "agents are"} still taking booked calls ` +
    `while the hourly Salesforce roster query no longer returns them, ` +
    `so their times are being offered on the last values Salesforce gave us. Clearing ` +
    `somebody's balance tiers is how they are taken off rotation, and it drops them out of ` +
    `that query rather than updating them, which is why nothing else reports this. Nothing ` +
    `was changed, on purpose: a source going quiet about somebody is not the source saying ` +
    `their record is gone, and emptying every pool they belong to could not be undone from ` +
    `here. Either make Salesforce match them again, or turn them off in Slate, and the next ` +
    `hourly sync settles it. The sync log line tagged sf-sync names the Slate rows.`
  );
}

/** Every bookable agent is confirmed by Salesforce again. */
export function salesforceRosterDivergenceRecovery(): string {
  return (
    "Every bookable agent is confirmed by the Salesforce roster query again, so the earlier " +
    "page is cleared. Nobody taking booked calls is being routed on values Salesforce no " +
    "longer holds. No action is needed."
  );
}

/** Every roster row agrees with Salesforce again. */
export function salesforceUserIdConflictRecovery(): string {
  return (
    "Every roster row now agrees with Salesforce about its user id, so the earlier page is " +
    "cleared. Time off and manager checks can name these people again. No action is needed."
  );
}

/** Recompute is not keeping up with the buckets that are due. */
export function recomputeHeadroomAlert(
  recomputed: number,
  due: number,
  totalBuckets: number,
  utilizationPct: number,
  behindMinutes: number,
): string {
  return (
    `Bucket recompute is falling behind. It has not refreshed every due bucket within its ` +
    `time budget for ${behindMinutes} minutes running, most recently ${recomputed} of ${due} ` +
    `(${totalBuckets} buckets total, last cycle used ${utilizationPct}%). Availability may ` +
    `start going stale. To scale: widen the ` +
    `freshness window, which moves the staleness alarm out with it so this does not just ` +
    `swap one page for another, or move to the Durable Objects design.`
  );
}

/** It caught up, and stayed caught up for the whole re-arm window (#2021). */
export function recomputeHeadroomRecovery(rearmMinutes: number): string {
  return (
    `Bucket recompute has caught up. It has refreshed every due bucket within its time budget ` +
    `for ${rearmMinutes} minutes running, so availability is being kept fresh again. No action is needed.`
  );
}

/** "1 bucket" / "3 buckets". */
function bucketCount(n: number): string {
  return `${n} ${n === 1 ? "bucket" : "buckets"}`;
}

/** "1 minute" / "6 minutes". */
function minutesText(n: number): string {
  return `${n} ${n === 1 ? "minute" : "minutes"}`;
}

/**
 * "bucket 530", "buckets 530, 531 and 532", or "including buckets 411, ..." when
 * the examples are only part of the stale set (the route passes at most five).
 * The values are bucket CODES, the XBC codes the landing pages send.
 */
function staleBucketList(count: number, examples: string[]): string {
  if (examples.length === 0) return "";
  const noun = examples.length === 1 ? "bucket" : "buckets";
  const joined =
    examples.length === 1
      ? examples[0]
      : `${examples.slice(0, -1).join(", ")} and ${examples[examples.length - 1]}`;
  return count > examples.length ? `including ${noun} ${joined}` : `${noun} ${joined}`;
}

/**
 * What a lead sees while a bucket's saved times are old (#2815). True because the
 * booker serves the stored row whatever its age (`resolveBucketSlots` has no age
 * check), and verify-on-book reads live Google at confirm time, so a time that
 * filled since the last refresh is refused there with the alternatives shown.
 */
const STALE_SLOTS_LEAD_IMPACT =
  "Leads still see times, but from the last refresh, so a time that has filled since " +
  "can still be offered; it is caught when they confirm and they are asked to pick another.";

/** Cached slot rows are going stale after a recompute pass. */
export function bucketSlotsStaleAlert(count: number, minutes: number, examples: string[]): string {
  const list = staleBucketList(count, examples);
  return (
    `The open times for ${bucketCount(count)} have not been refreshed in over ` +
    `${minutesText(minutes)}${list ? ` (${list})` : ""}. ${STALE_SLOTS_LEAD_IMPACT} ` +
    `This can clear by itself within a few minutes when a refresh was only slow, and an ` +
    `all clear will follow here. If none arrives within 15 minutes, the refresh job is ` +
    `stuck and needs looking at. Diagnose via tag=recompute in the Worker logs.`
  );
}

/**
 * The same staleness, but the deliberate-invalidation marker could not be READ
 * (#1304), on enough consecutive ticks that a blip is ruled out.
 *
 * Distinct copy on purpose. The ordinary page says the refresh job may be stuck,
 * which is a measured claim about the drain; here nothing about the drain was
 * measured at all, because the one value that would have explained the staleness
 * is unavailable. Sending the ordinary wording would point the reader at the
 * refresh job when the thing to look at first is the marker read.
 */
export function bucketSlotsStaleUnreadableMarkerAlert(
  count: number,
  minutes: number,
  examples: string[],
  consecutiveTicks: number,
): string {
  const list = staleBucketList(count, examples);
  return (
    `The open times for ${bucketCount(count)} have not been refreshed in over ` +
    `${minutesText(minutes)}${list ? ` (${list})` : ""}, and for ` +
    `${minutesText(consecutiveTicks)} running the check that tells a planned refresh from a ` +
    `stuck one could not be read. So this may be the expected catch up after somebody saved a ` +
    `booking setting, or the refresh job may be stuck. ${STALE_SLOTS_LEAD_IMPACT} ` +
    `A catch up clears by itself and an all clear will follow here. If none arrives within ` +
    `15 minutes, act. Diagnose via tag=recompute in the Worker logs: check the ` +
    `invalidation marker read in alert_state first, then the refresh job.`
  );
}

/** Nothing is stale any more. */
export function bucketSlotsStaleRecovery(): string {
  return "No cached availability rows are stale any more. Open times are being refreshed " +
          "on schedule again, so the booker is showing current times. No action is needed.";
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

/**
 * An endpoint has burned every retry and is dead-lettering.
 *
 * `reason` is already SHORT: the sender classifies the reply
 * (`summarizeWebhookReply`) and runs it through `shortFailureReason`, so no body
 * reaches this sentence. The full reply is in the logs under `tag=webhooks`, which
 * is the division of labour docs/alerts-runbook.md sets out ("Alert copy never
 * carries a raw error"): the alert carries a short human reason, the log
 * carries the text.
 *
 * `reply.intermediary` is a MEASURED fact, not a guess made from the wording, and
 * it changes who the reader has to go and talk to (#2418). A block page from a WAF
 * in front of the subscriber means their firewall is refusing Slate's egress
 * address and their API never saw a thing, which is a network repair on their
 * side. Every other failure is between Slate and their API, and the commonest of
 * those is a key. Saying the same sentence for both is what left an on call reader
 * with a kilobyte of markup and no idea which it was.
 */
export function webhookDeadAlert(
  url: string,
  event: string,
  attempt: number,
  reason: string,
  reply: { intermediary: boolean },
): string {
  const head = `Webhook delivery to ${url} keeps failing (event ${event}, ${attempt} attempts).`;
  if (reply.intermediary) {
    return (
      `${head} Something in front of the subscriber answered with a block page, so their API never saw the request: ` +
      `${reason}. That is a firewall repair on their side, not a payload or key problem. ` +
      `Full reply in the logs (tag=webhooks).`
    );
  }
  return `${head} Last response: ${reason}. Full reply in the logs (tag=webhooks).`;
}

/** Deliveries are landing again. */
export function webhookDeadRecovery(url: string): string {
  return (
    `Webhook delivery to ${url} is succeeding again, so events are reaching it ` +
    `and the earlier page is cleared. Deliveries that dead-lettered while it was down are not ` +
    `re-sent automatically; replay them from the admin webhooks page if they matter.`
  );
}
