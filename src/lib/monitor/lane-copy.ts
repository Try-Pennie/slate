/**
 * The words the cron dead-man's switch says (#1153).
 *
 * Lifted out of lane-watchdog.ts so the alert preview can render the REAL copy by
 * calling these, instead of holding a second copy that would drift the first time
 * someone edited one and not the other (L41). The watchdog imports them back.
 *
 * Nine lane families, nine voices, deliberately: these lanes fail for different
 * reasons and are recovered by different people doing different things, and
 * #1123 already had to unpick one shared message that pointed responders at the
 * wrong lane and lock.
 */
import { describeGap, laneQuietClause, laneRun, type StaleLane } from "@/lib/monitor/health";
import {
  AVAILABILITY_TRUTH_VERDICT_LANE,
  FAILURE_RATE_VERDICT_LANE,
  LOW_VOLUME_VERDICT_LANE,
  OOO_PROTECTION_VERDICT_LANE,
  TWILIO_ROSTER_VERDICT_LANE,
  LANE_WATCHDOG_VERDICT_LANE,
  TIER_STAFFING_VERDICT_LANE,
  REGAL_CALLS_VERDICT_LANE,
  BURST_COUNTER_VERDICT_LANE,
  KILL_SWITCH_VERDICT_LANE,
  CONFIRM_LINE_VERDICT_LANE,
  REROUTE_DRILL_VERDICT_LANE,
  AVAILABILITY_LATENCY_VERDICT_LANE,
  BELOW_LEAD_TIER_VERDICT_LANE,
  CROSS_SYSTEM_BOOKINGS_VERDICT_LANE,
  ROSTER_COVERAGE_VERDICT_LANE,
  AVAILABILITY_SCAN_VERDICT_LANE,
  CALENDAR_WINDOW_VERDICT_LANE,
  OFFSITE_ORIGIN_VERDICT_LANE,
  AUTH_SIGN_IN_VERDICT_LANE,
  AWAITING_ACTIVATION_VERDICT_LANE,
  STRANDED_HIRES_VERDICT_LANE,
  AUDIT_CHAIN_VERDICT_LANE,
  REGAL_CALL_FEED_VERDICT_LANE,
  REGAL_CALL_OUTCOMES_VERDICT_LANE,
  ADVISOR_PHOTOS_VERDICT_LANE,
  BUSY_MINUTES_VERDICT_LANE,
  BUSY_DRIFT_VERDICT_LANE,
  OFFERED_NOBODY_FREE_VERDICT_LANE,
  BUFFER_BREACH_VERDICT_LANE,
  CRON_BUDGET_VERDICT_LANE,
  parkedDetector,
  type DetectorVerdictLane,
} from "@/lib/monitor/verdict-freshness";

/** Minutes, rounded, for the copy. */
const minutes = (ms: number) => Math.round(ms / 60_000);

/** The alerts runbook section the stale lane page sends its reader to. */
export const STALE_LANE_RUNBOOK_SECTION = "A lane or schedule has gone quiet";

/**
 * A Worker cron lane that has gone quiet (#4168, #3468).
 *
 * Since #3693 every lane runs as its own placed fetch, so a CPU kill on a shared
 * invocation (#760) is no longer how lanes go quiet. What was seen on 2026-10-23 was a
 * gradual deploy cancelling a run part way, the next tick waiting on the cancelled
 * run's lock, and a run far from the database taking 77 s instead of 21 s.
 *
 * The page is read by a product manager on a phone, so it says those causes in plain
 * words and names no log command, field or lock (Dan, 2026-10-23, "Plainer"). The
 * runbook section it names holds that detail per lane, held to `LANE_RUNS` by
 * scripts/test-stale-lane-copy.ts. The waiting clause comes only for a lane whose route
 * takes a lock (`LANE_RUNS`), because without one the next run has nothing to wait on.
 */
export function coreLaneAlertText(lane: StaleLane): string {
  const waited = laneRun(lane.lane).lock
    ? `, and the next run then waited for the first to time out`
    : "";
  return (
    `The ${lane.lane} cron lane ${laneQuietClause({
      ageMs: lane.ageMs,
      boundMin: minutes(lane.maxStaleMs),
      unreadable: lane.unreadable,
    })}. Its work is not happening. Usually a deploy cancelled a run part way, a run ` +
    `went to a server far from the database and ran slowly, or a run took longer than ` +
    `its schedule${waited}. The alerts runbook covers what to check for each lane, under ` +
    `"${STALE_LANE_RUNBOOK_SECTION}".`
  );
}

/** All-clear for a Worker cron lane. Carries no remediation: the page named the
 *  usual causes and the runbook, and repeating that here would send the reader after
 *  a fault that is over. */
export function laneRecoveryText(lane: string): string {
  return (
    `The ${lane} cron lane is running again. It has stamped a heartbeat inside ` +
    `its bound, so the work it had stopped doing is happening again and the earlier ` +
    `page is cleared. No action is needed.`
  );
}

/** All-clear for the external booking canary, keyed like its alert (#525, #982). */
export function canaryRecoveryText(lane: string): string {
  if (lane === "smoke-canary-full") {
    return (
      `The booking smoke canary's full end to end pass is running again, so the ` +
      `automated proof that a booking can be created, rescheduled and cancelled is back ` +
      `in place. No action is needed.`
    );
  }
  if (lane === "schedule-parity") {
    return (
      `The daily Slate against cal.com comparison is running again, so drift between ` +
      `the two systems is being watched for once more. No action is needed.`
    );
  }
  if (lane === "router-replay") {
    return (
      `The weekly routing replay is reaching a verdict again, so there is a measurement ` +
      `once more of whether Slate would route real leads the way cal.com does. No action ` +
      `is needed.`
    );
  }
  return (
    `The booking smoke canary is running again, so the automated end to end ` +
    `booking check is back in place. No action is needed.`
  );
}

/**
 * The ending for a cal.com lane page that was open when cal.com was marked retired
 * (#2875). Not a recovery: the lane will never stamp again, and saying it is
 * "running again" would be false. It names what changed and where it was changed,
 * so a reader who did not flip the switch can find who did.
 */
export function calcomLaneRetiredText(lane: string): string {
  const what =
    lane === "router-replay"
      ? "The weekly routing replay against cal.com"
      : "The daily Slate against cal.com comparison";
  return (
    `${what} is no longer watched, because cal.com has been marked retired on the ` +
    `alerts page. The earlier page is cleared. If cal.com is still taking bookings, ` +
    `turn that setting off again.`
  );
}

/** All-clear for the Snowflake mirror lanes, keyed like its alert (#1101, #1123). */
export function mirrorRecoveryText(lane: string): string {
  if (lane === "snowflake-reconcile") {
    return (
      `The check comparing the live database against the Snowflake mirror is ` +
      `running again, so the warehouse is being verified against the source once more. ` +
      `Anything that was treated as unverified while it was quiet, including export ` +
      `gated deletion, is being checked again. No action is needed.`
    );
  }
  if (lane === "erasure-audit") {
    return (
      `The check proving an erased person's data is really gone from the ` +
      `Snowflake warehouse is running again, so deletion requests are being watched ` +
      `through to the end once more. No action is needed.`
    );
  }
  if (lane === "snowflake-check") {
    return (
      `The Snowflake warehouse self check is passing again, so the statements ` +
      `the retention and erasure work depends on are known to run against the real ` +
      `warehouse. No action is needed.`
    );
  }
  return (
    `The Snowflake mirror export lane is running again, so the analytics ` +
    `warehouse is being kept up to date. No action is needed.`
  );
}

/**
 * What each time off stamp means when it goes quiet (#2543).
 *
 * Four stamps, four sentences, for the #1123 reason: the two lanes each carry a
 * "the cron reached the route" stamp and a "the work happened" one, and those send
 * a reader to two different places. Telling somebody the schedule has stopped when
 * the route is firing and throwing wastes the morning the report did not go out.
 *
 * `cost` is what a person loses while it holds, and `look` is where to go. Both
 * are phrased for a reader who does not know these lanes exist.
 */
const TIME_OFF_SUBJECT: Record<string, { what: string; cost: string; look: string }> = {
  "ooo-approvals": {
    what: "the daily time off approvals report",
    cost:
      "nothing is reaching the route at all, so no report can go out however healthy the rest of it is",
    look:
      "the ooo-approvals entries in worker/cron-routes.ts and wrangler.jsonc, then the Worker logs for tag=cron",
  },
  "ooo-approvals-report": {
    what: "the daily CSV of yesterday's approved time off",
    cost:
      "the sales managers are getting no record of who was approved, and the report catches up its own gap when it next runs, so the days since are still recoverable",
    look: "the Worker logs for the /api/cron/ooo-approvals 500, and that Gmail can still send",
  },
  "ooo-digest": {
    what: "the morning nudge about pending time off",
    cost:
      "nothing is reaching the route at all, so no manager can be nudged however healthy the rest of it is",
    look:
      "the ooo-digest entries in worker/cron-routes.ts and wrangler.jsonc, then the Worker logs for tag=cron",
  },
  "ooo-digest-nudge": {
    what: "the morning nudge about pending time off",
    cost:
      "no manager is being reminded of the requests waiting on them, so agents are waiting on approvals nobody has been told about",
    look:
      "that the ooo-digest schedule in wrangler.jsonc runs Monday to Friday, then the Worker logs for the /api/cron/ooo-digest 500, and that Slack still accepts a DM",
  },
};

/**
 * A time off lane that has gone quiet (#2543).
 *
 * Deliberately not the core lane wording: these fire once a day rather than every few
 * minutes, so the core page's causes (a deploy cancelling a run, a slow run far from
 * the database, a run waiting on another) are not where their faults live, and naming
 * them would send the reader after a fault that is not there. The
 * bound is quoted in hours or days rather than minutes, because "has not run for
 * 4,380 minutes" is arithmetic shown to somebody reading a phone.
 */
export function timeOffLaneAlertText(lane: StaleLane): string {
  const subject = TIME_OFF_SUBJECT[lane.lane]!;
  const bound = describeGap(lane.maxStaleMs);
  const opener = `${subject.what[0]!.toUpperCase()}${subject.what.slice(1)} `;
  if (lane.unreadable) {
    return (
      `${opener}has a last-run record that cannot be read, so it is being treated as ` +
      `stopped (expected a run at least every ${bound}). While that holds, ${subject.cost}. ` +
      `Check ${subject.look}.`
    );
  }
  if (!Number.isFinite(lane.ageMs)) {
    return (
      `${opener}has NEVER once run, so it has either failed every run since it was ` +
      `deployed or is not being scheduled (expected a run at least every ${bound}). ` +
      `${subject.cost[0]!.toUpperCase()}${subject.cost.slice(1)}. Check ${subject.look}.`
    );
  }
  return (
    `${opener}has not run in ${describeGap(lane.ageMs)} (expected at least every ${bound}). ` +
    `While that holds, ${subject.cost}. Check ${subject.look}.`
  );
}

/** All-clear for a time off lane (#2543). It names the work that is happening
 *  again, because the page was about a morning that produced nothing. */
export function timeOffRecoveryText(lane: string): string {
  const subject = TIME_OFF_SUBJECT[lane]!;
  return (
    `${subject.what[0]!.toUpperCase()}${subject.what.slice(1)} has run again inside its ` +
    `bound, so the earlier page is cleared. No action is needed.`
  );
}

/**
 * The daily off platform database dump has gone quiet (#3076).
 *
 * Its own voice, because the reader's question is not "which lane" but "what can I
 * no longer get back": bookings are still recoverable from the Snowflake mirror, and
 * everything else is only as recent as the last dump. The bound is quoted in hours,
 * like the time off lanes, for the same reason.
 */
export function backupAlertText(lane: StaleLane): string {
  const bound = describeGap(lane.maxStaleMs);
  const stake =
    `Bookings are still recoverable from the Snowflake mirror, but advisors, pools, ` +
    `working hours, settings and time off are only as recent as the last dump, so a ` +
    `restore today would lose everything changed since.`;
  const look =
    `Read the last db-backup run in the Actions tab: it fails red on a missing R2 or ` +
    `Supabase secret, a dump that came out empty, or an upload R2 did not keep. If no ` +
    `run happened at all (GitHub drops scheduled runs), Run workflow on db-backup takes ` +
    `one now.`;
  if (lane.unreadable) {
    return (
      `The record of the last off platform database backup cannot be read, so it is being ` +
      `treated as stopped (expected one at least every ${bound}). ${stake} ${look}`
    );
  }
  if (!Number.isFinite(lane.ageMs)) {
    return (
      `The daily off platform database backup has NEVER once landed in R2, so there is no ` +
      `copy of the database outside Supabase (expected one at least every ${bound}). ${stake} ` +
      `${look} A missing or rotated R2_BACKUP secret is the usual cause.`
    );
  }
  return (
    `The newest off platform database backup is ${describeGap(lane.ageMs)} old (expected one ` +
    `at least every ${bound}). ${stake} ${look}`
  );
}

/** All-clear for the daily database dump (#3076). It names what is protected again,
 *  because the page was about what a restore would lose. */
export function backupRecoveryText(_lane: string): string {
  return (
    `A fresh off platform database backup has landed in R2, so a restore would again lose ` +
    `at most a day of the non booking tables, and the earlier page is cleared. No action is needed.`
  );
}

/**
 * Slate's logs have stopped being confirmed in Better Stack (#3182).
 *
 * Its own voice, because the reader's question is what is being lost and where the
 * cause is written down. Nothing about the site is wrong, and Cloudflare still holds
 * every line for 7 days, so the stake is history rather than service. The cause is
 * never knowable from here: every way the pipe breaks ends the receipts identically,
 * and only the tail worker's own log says which one it was.
 */
export function logShippingAlertText(lane: StaleLane): string {
  const bound = describeGap(lane.maxStaleMs);
  const stake =
    `Bookings and the site are unaffected, and Cloudflare still keeps every line for 7 days, ` +
    `but nothing older than that will survive unless shipping resumes.`;
  const look =
    `The tail worker logs why it sent nothing: run npx wrangler tail slate-log-tail. A ` +
    `refused 401 or 403 is a revoked or wrong BETTERSTACK_SOURCE_TOKEN, no-token is that ` +
    `secret missing, timeout or unreachable is Better Stack itself, and receipt no-binding ` +
    `is a tail worker deployed without its SLATE binding.`;
  if (lane.unreadable) {
    return (
      `The record of the last log shipping receipt cannot be read, so whether Slate's logs ` +
      `are reaching Better Stack is unknown and it is being treated as stopped (expected one ` +
      `at least every ${bound}). Look at the ${lane.lane} row in lane_heartbeats. ${look}`
    );
  }
  if (!Number.isFinite(lane.ageMs)) {
    return (
      `Log shipping has NEVER once been confirmed: no receipt has said Slate's logs reach ` +
      `Better Stack (expected one at least every ${bound}). ${stake} If the tail worker has not been redeployed since this ` +
      `check shipped, that is the cause: run npx wrangler deploy -c wrangler.log-tail.jsonc. ` +
      `${look}`
    );
  }
  return (
    `Logs have not been confirmed reaching Better Stack for ${describeGap(lane.ageMs)} ` +
    `(expected a receipt at least every ${bound}). ${stake} ${look}`
  );
}

/** All-clear for log shipping (#3182). It says where the gap's lines still are,
 *  because the page was about history, and a gap is not filled in afterwards. */
export function logShippingRecoveryText(_lane: string): string {
  return (
    `Logs are reaching Better Stack again, so the earlier page is cleared. Lines ` +
    `from the gap are only in Cloudflare, for 7 days from when they were written. No ` +
    `action is needed.`
  );
}

/**
 * The pool grouping has stopped being published (#3460).
 *
 * Its own voice, because the stake is capacity rather than service: bookings still
 * work, and a server holding no fresh grouping of its own keys its confirm line by code,
 * which is how every confirm keyed before #3460. What is lost is the one line a crowd
 * for one slot on sibling codes shares, so a burst splits again and each line elects its
 * own leader. The cause is in the lane's own log line, which names how the publish ended.
 */
export function poolGroupingAlertText(lane: StaleLane): string {
  const bound = describeGap(lane.maxStaleMs);
  const stake =
    `Bookings still go through, but a server without its own fresh grouping keys its confirm line by code, ` +
    `so a crowd for one slot on sibling codes splits across several lines again, each electing its own leader.`;
  const look =
    `The recompute lane logs why a publish did not land: search tag=pool-grouping. Unbound is a deployment ` +
    `without the CONFIRM_LINE binding, unreachable or refused is the object, and empty is a bucket read that came back empty.`;
  if (lane.unreadable) {
    return (
      `The record of the last pool grouping publish cannot be read, so whether cold servers can key their ` +
      `confirm line from it is unknown and it is being treated as stopped (expected one every minute, at most ` +
      `${bound} apart). Look at the ${lane.lane} row in lane_heartbeats. ${look}`
    );
  }
  if (!Number.isFinite(lane.ageMs)) {
    return (
      `The pool grouping has NEVER once been published to the confirm line's directory (expected every minute, ` +
      `at most ${bound} apart). ${stake} ${look}`
    );
  }
  return (
    `The pool grouping has not been published for ${describeGap(lane.ageMs)} (expected every minute, at most ` +
    `${bound} apart). ${stake} ${look}`
  );
}

/** All-clear for the pool grouping publish (#3460). */
export function poolGroupingRecoveryText(_lane: string): string {
  return (
    `The pool grouping is being published again, so servers without their own fresh grouping key their ` +
    `confirm line from it once more and the earlier page is cleared. No action is needed.`
  );
}

/** All-clear for a daily retention lane (#1102). These destroy customer data, so
 *  the notice says plainly that the deletion work has resumed. */
export function retentionRecoveryText(lane: string): string {
  return (
    `The ${lane} retention lane is running again, so the scheduled deleting of ` +
    `aged data has resumed and the retention window is being honored. No action is ` +
    `needed.`
  );
}


/**
 * What each detector STOPS TELLING US while it is blind (#1394).
 *
 * Phrased as the missing answer, not the missing job, because that is what the
 * reader has to decide about: the detector is fine, the lane is running, and the
 * thing that is gone is the assurance. Each detector gets its own sentence for
 * the #1123 reason: a shared "a detector went blind" would send whoever reads it
 * looking for the wrong thing.
 *
 * Keyed by the verdict lane TYPE, never by string (L113): a lane added to the family
 * and forgotten here fails `tsc`, rather than throwing on `.what` inside the very
 * page that is meant to say the detector went blind.
 */
interface VerdictSubject {
  what: string;
  cost: string;
  look: string;
}

const VERDICT_SUBJECT: Record<DetectorVerdictLane, VerdictSubject> = {
  [AVAILABILITY_TRUTH_VERDICT_LANE]: {
    what: "the check asking whether the times the booker is offering are really free on the agents' calendars",
    cost: "nothing is confirming that the published availability is true, so a drifted cache would only surface as customers being refused at the last step",
    look: 'the Worker logs for msg="availability truth" and the reason each tick gives for not concluding',
  },
  [FAILURE_RATE_VERDICT_LANE]: {
    what: "the check watching how often customers fail to complete a booking",
    cost: "a wave of refused confirms would pass unreported, which is the cal.com failure this check was built after",
    look: 'the Worker logs for msg="booking failure rate" and whether any hour is reaching its attempt floor',
  },
  [LOW_VOLUME_VERDICT_LANE]: {
    what: "the check watching for bookings drying up",
    cost: "a funnel that has stopped delivering leads would look like an ordinary quiet day",
    look: 'the Worker logs for msg="booking volume" and whether the tick is landing inside business hours',
  },
  [REGAL_CALLS_VERDICT_LANE]: {
    what: "the check asking whether anybody Slate routes no bookings to is placing calls in Regal",
    cost: "somebody could be working the phones while Slate offers leads none of their time, and the pool would read as an ordinary quiet day",
    look: 'the Worker logs for msg="regal calls" under tag=monitor, and whether rows are arriving in regal_call_events at all',
  },
  [OFFERED_NOBODY_FREE_VERDICT_LANE]: {
    what: "the check judging the times the booker serves with the confirm's own candidate read",
    cost: "the booker could go on offering times the confirm refuses, as it did for bucket 112 on 2026-10-06, and the only sign would be leads being turned away",
    look: 'the Worker logs for msg="offered nobody free" under tag=monitor, and whether the pool listing, the markers in alert_state or the ladder read are failing',
  },
  [BUFFER_BREACH_VERDICT_LANE]: {
    what: "the check asking whether any advisor holds two upcoming calls closer than the call type's buffer",
    cost: "an advisor could be booked back to back or into an overlap, as 57 pairs were in October, and nothing would say so until a lead was kept waiting",
    look: 'the Worker logs for msg="buffer breaches" under tag=monitor, and whether the bookings, event types or buckets read is failing',
  },
  [TIER_STAFFING_VERDICT_LANE]: {
    what: "the check asking whether each debt tier is offering a lead any booking time on the days the booker shows",
    cost: "a whole debt tier could have nobody able to take a call and nothing would say so, while every lead asking for it was quietly served by a lower tier",
    look: 'the Worker logs for msg="tier staffing" under tag=monitor, and whether the roster and the cached slot rows can be read at all',
  },
  [BELOW_LEAD_TIER_VERDICT_LANE]: {
    what: "the check holding each upcoming booking's team against the tier Salesforce gives the lead",
    cost: "an Ultra High lead booked with the Low team would keep that call with nobody told, which is the case the cal.com Slack workflow covered before cutover",
    look: 'the Worker logs for msg="below lead tier" under tag=monitor, and whether the Salesforce read is failing or there are simply no upcoming bookings with a lead id',
  },
  [CROSS_SYSTEM_BOOKINGS_VERDICT_LANE]: {
    what: "the hourly check asking whether any lead holds an upcoming call in both Slate and cal.com",
    cost: "a lead could be booked with two advisors at once and nobody would know to cancel one of the calls",
    look: 'the Worker logs for msg="cross system bookings" under tag=monitor, and whether the cal.com bookings listing is being refused or timing out',
  },
  [ROSTER_COVERAGE_VERDICT_LANE]: {
    what: "the check asking whether every hour the org advertises has a bookable agent rostered to cover it",
    cost: "the org could go on advertising hours nobody works, and a lead asking for one would be offered nothing with no page saying why",
    look: 'the Worker logs for tag=roster-coverage and the monitor cycle line for roster_coverage under failed=, and whether the business hours and the agents\' working hours can be read at all',
  },
  // #2798: the five gated checks that answered a failed read with a status of
  // their own and paged nothing. Each `look` names the log line that carries the
  // status, because that line is where "could not read" and "nothing wrong" part.
  [AVAILABILITY_SCAN_VERDICT_LANE]: {
    what: "the scan asking whether every bucket that should be offering times is offering them",
    cost: "a bucket showing leads no times could go unexplained, because the scan can no longer tell a wedged cache from a booked solid week",
    look: 'the Worker logs for msg="availability scan" under tag=monitor, and whether it reports truncated or every dead end unverified, which means the live recompute is failing',
  },
  [CALENDAR_WINDOW_VERDICT_LANE]: {
    what: "the check asking whether every bookable agent's calendar has been read out to the end of the booking window",
    cost: "an agent whose calendar stopped being read could be offered to leads over meetings Slate cannot see",
    look: 'the Worker logs for msg="tick" under tag=calendar-window, and whether the calendar rows can be read at all',
  },
  [OFFSITE_ORIGIN_VERDICT_LANE]: {
    what: "the check asking whether real bookings are arriving from a page that is not the production site",
    cost: "bookings made from a test page or a copied embed would land on real agents' calendars with nobody told",
    look: 'the Worker logs for msg="offsite origin unreadable" under tag=monitor, and whether recent bookings can be read at all',
  },
  [AUTH_SIGN_IN_VERDICT_LANE]: {
    what: "the check asking whether Supabase Auth in production accepts anything but Google sign in",
    cost: "email sign in or another provider could be turned back on with nobody told",
    look: 'the Worker logs for tag=auth-sign-in, and whether /auth/v1/settings answers with the public key',
  },
  [AWAITING_ACTIVATION_VERDICT_LANE]: {
    what: "the check asking whether anybody the roster counts as working has been stuck waiting to become bookable",
    cost: "a new hire whose activation keeps being refused would stay out of every pool with nothing saying why",
    look: 'the Worker logs for msg="awaiting activation" under tag=monitor, and whether the users table can be read at all',
  },
  [STRANDED_HIRES_VERDICT_LANE]: {
    what: "the check asking whether any signed in Sales hire is outside the booking pool with nothing pending and no hold recorded",
    cost: "a hire whose pending activation was lost would stay out of every pool for good, reading exactly like somebody held back on purpose",
    look: 'the Worker logs for msg="stranded hires" under tag=monitor, and whether the users, agent_calendars and audit_log tables can be read',
  },
  [AUDIT_CHAIN_VERDICT_LANE]: {
    what: "the check walking the audit log's hash chain to find any entry changed after it was written",
    cost: "an audit log edited by somebody able to switch off its append only guard would read as untouched",
    look: 'the Worker logs for msg="audit chain" under tag=monitor, and whether audit_log and audit_log_chain_verify can be read at all',
  },
  [REGAL_CALL_FEED_VERDICT_LANE]: {
    what: "the pair of checks asking whether calls from Regal are reaching Slate and whether Slate can read them",
    cost: "Regal could stop posting calls, or change what it sends, and the check for people calling while Slate does not route to them would go on judging nobody",
    look: 'the Worker logs for msg="regal calls quiet" and msg="regal calls unreadable" under tag=monitor, and whether the regal_call_reason_counts RPC answers',
  },
  [REGAL_CALL_OUTCOMES_VERDICT_LANE]: {
    what: "the check asking whether a call outcome is being stored for each completed call Regal posts",
    cost: "regal_call_outcomes could stop filling and the show rate in the Slate vs cal.com split would be computed from whichever calls happened to land",
    look: 'the Worker logs for msg="regal call outcomes" under tag=monitor, and whether regal_call_outcomes and the regal_call_reason_counts RPC can be read at all',
  },
  [ADVISOR_PHOTOS_VERDICT_LANE]: {
    what: "the daily refresh of advisor photos from the Google directory",
    cost: "the photos leads and the roster see stop following Google, so a photo somebody adds, changes or removes there never reaches Slate",
    // This stamp is the lane's only heartbeat, so a schedule that stopped firing
    // lands here too, and that is the first thing to rule out (L11).
    look: 'that the 17 4 * * * and 17 10 * * * crons are in wrangler.jsonc and firing, then the Worker logs for tag=advisor-photos and any advisor_photos_unread page',
  },
  [BUSY_MINUTES_VERDICT_LANE]: {
    what: "the daily count of routed bookings a minute that says when the booking load run's bar needs raising",
    cost: "real traffic could grow past a tenth of the load run's bar with nothing saying the bar had stopped being ten times over it",
    // The stamp is the lane's only heartbeat, so a schedule that stopped firing lands
    // here too, and that is the first thing to rule out (L11).
    look: 'that the 41 5 * * * and 41 9 * * * crons are in wrangler.jsonc and firing, then the Worker logs for tag=busy-minutes and any load_bar_unread page',
  },
  [BUSY_DRIFT_VERDICT_LANE]: {
    what: "the sampler asking whether the busy time Slate has cached for each agent matches their live Google calendar",
    cost: "an agent whose cached busy time had fallen behind their calendar could be offered to leads over meetings, with no page saying the cache had drifted",
    look: 'the Worker logs for msg="tick" under tag=busy-drift, and whether it reports status="unreadable", which means the live freeBusy read or the busy_blocks read is failing',
  },
  [CRON_BUDGET_VERDICT_LANE]: {
    what: "the hourly check reading each cron schedule's real CPU from the Worker logs",
    cost: "a schedule could grow toward the point Cloudflare kills it, and the warning meant to come first would never arrive",
    look: 'the Worker logs for tag=cron-budget, where msg="cron cpu: unmeasured, ..." quotes why the read failed (a CF_ANALYTICS_TOKEN that was revoked, expired or lacks the Workers role Metadata Read-only is the usual cause), then that the 0 * * * * cron is in wrangler.jsonc and firing',
  },
  [OOO_PROTECTION_VERDICT_LANE]: {
    what: "the check asking whether approved time off is still blocking the hours it covers",
    cost: "an agent's time off could stop blocking anything and nobody would hear, which is how a lead gets booked into a day someone is away",
    look: 'the Worker logs for msg="tick" under tag=ooo-protection and whether the approved requests can be read at all',
  },
  [LANE_WATCHDOG_VERDICT_LANE]: {
    what: "the dead man's switch that watches every cron lane for going quiet",
    cost: "nothing is watching the lanes, so sync, recompute or the outbox could stop and the first sign of it would be a customer noticing",
    // Two causes, and the FIRST one is not about the watchdog at all: only the
    // monitor lane writes this stamp, so a monitor lane that is not running at all
    // lands here as well, and that case is already paging under its own name. A
    // message that sent every reader to tag=lane-watchdog would be advice about the
    // wrong fault most of the time it fires (L11).
    look: 'whether the monitor lane is stale under its own page first, then the Worker logs for tag=lane-watchdog and the monitor cycle line for lane_watchdog under failed=',
  },
  [BURST_COUNTER_VERDICT_LANE]: {
    what: "the daily proof that the burst counter behind the request ceiling really answers and really counts",
    cost:
      "nothing is confirming that the ceiling which stops one caller spreading a burst across the " +
      "edge is switched on, and a counter that is bound and silent reads as healthy everywhere else, " +
      "so the first sign would be a burst nobody refused",
    // WHETHER IT RAN comes first, and that ordering is the finding rather than a
    // preference. Both of this check's bad verdicts stamp, because each is a definite
    // reading of the counter, so the only ways this page can fire are a run that could
    // not reach the deployment and a run that never happened. It shares the opening
    // clause with every other detector here, which says the check "is running": that is
    // the commonest thing to be wrong, so the first place to look has to correct it,
    // the way the lane watchdog's own entry does above (L11).
    //
    // After that the run is the whole diagnosis: the command ends on a different exit
    // code for each cause and the reporter posts its own sentence, so the next step is
    // to read the last run rather than to go hunting in the Worker logs, which is where
    // every other detector in this table sends people.
    look:
      "whether the daily burst-counter workflow ran at all in the Actions tab, then what its last " +
      "run said, since it ends on a different exit code for each way the check can fail",
  },
  [KILL_SWITCH_VERDICT_LANE]: {
    what: "the nightly proof that public booking can still be stopped",
    cost:
      "nothing is confirming that the one lever which stops Slate putting invites on agents' " +
      "calendars still works, and the same gate refuses EVERY lead when it cannot read its own " +
      "flag, so the first sign either way would be leads being turned away or a booking nobody " +
      "could stop",
    // WHETHER IT RAN comes first, for the reason the burst counter's entry gives just
    // above: every BAD verdict this check can reach stamps, so the only ways this page can
    // fire are a run that could not reach the deployment and a run that never happened.
    // After that the run is the whole diagnosis, since the command ends on a different exit
    // code for each cause and the reporter posts its own sentence.
    look:
      "whether the nightly kill-switch workflow ran at all in the Actions tab, then what its " +
      "last run said, since it ends on a different exit code for each way the check can fail",
  },
  [CONFIRM_LINE_VERDICT_LANE]: {
    what: "the daily proof that the shared confirm line every isolate uses really answers the confirm path",
    cost:
      "nothing is confirming that a crowd for one slot would form ONE line, and a line that is bound and " +
      "silent reads as healthy everywhere else because every confirm quietly falls back to its own " +
      "isolate, so the first sign would be the database saturating under a crowd again",
    // WHETHER IT RAN comes first, for the burst counter's reason above: every bad reading of
    // the object stamps, so this page means a run that could not reach the deployment or a run
    // that never happened, and the run's own exit code then says which.
    look:
      "whether the daily burst-counter workflow ran its confirm line step at all in the Actions tab, " +
      "then what that step said, since it ends on a different exit code for each way the check can fail",
  },
  [REROUTE_DRILL_VERDICT_LANE]: {
    what: "the daily reroute drill that proves a Twilio demotion really moves a call, records it, and can be undone",
    cost:
      "nothing is confirming that the automatic reroute still moves a demoted advisor's calls, and because it acts " +
      "only when Twilio narrows somebody, a pipeline that had stopped would look exactly like a quiet month",
    // WHETHER IT RAN comes first, for the burst counter's reason: every bad reading of the pipeline
    // stamps, so this page means a drill that could not start or a run that never happened.
    look:
      "whether the daily burst-counter workflow ran its reroute drill step at all in the Actions tab, then " +
      "what that step said, since it ends on a different exit code for each way the drill can fail",
  },
  [AVAILABILITY_LATENCY_VERDICT_LANE]: {
    what: "the smoke canary's check on how fast the booker's availability read answers",
    cost:
      "a read that has stopped being served from the cache would go unreported, and leads would " +
      "wait on it before seeing a single time",
    // The canary runs every 30 minutes and pages under its own name when it stops, so the
    // first place to look is a run that DID happen: its latency step says why it had no
    // usable reading, one line per refused request.
    look:
      "the Availability latency step of the last smoke canary run in the Actions tab, whose " +
      "lines say what each request answered instead of a timing",
  },
  [TWILIO_ROSTER_VERDICT_LANE]: {
    what: "the hourly roster sync's Twilio half, which takes an agent out of the bookable pool when Twilio marks them redistribute",
    cost: "somebody tagged redistribute would go on being offered to leads, and anybody whose tag came off would stay out of the pool",
    look: 'the Worker logs for tag=twilio-sync and tag=agents, and whether the hourly agents cron is running at all',
  },
};

/**
 * The subject for a lane read back off the heartbeat table, where it is a string.
 *
 * Every lane in the family has an entry, which the type above enforces. A string that
 * is not in the family can only come from a code fault (a bound or a stamp for a lane
 * nobody declared), and it is named as exactly that rather than rendering `undefined`
 * into a page or throwing inside the alert path (L11).
 */
function verdictSubject(lane: string): VerdictSubject {
  const known = (VERDICT_SUBJECT as Record<string, VerdictSubject | undefined>)[lane];
  if (known) return known;
  return {
    what: `the detector stamping ${lane}, which has no entry in VERDICT_SUBJECT`,
    cost: "whatever it watches is not being reported, and its alert copy is missing, which is a code fault",
    look: "src/lib/monitor/lane-copy.ts and src/lib/monitor/verdict-freshness.ts for that lane",
  };
}

/**
 * A detector that has gone blind: it keeps running, and it has stopped (or never
 * started) reaching a verdict (#1394).
 *
 * The distinction from every other message in this file is the whole point, so
 * the copy has to carry it: the lane is NOT quiet, and telling someone to go
 * check a stuck lock would send them after a fault that is not there.
 */
export function verdictBlindAlertText(lane: StaleLane): string {
  const subject = verdictSubject(lane.lane);
  const bound = describeGap(lane.maxStaleMs);
  // Sentence case: these render as the first line of a Slack message.
  const opener = `${subject.what[0].toUpperCase()}${subject.what.slice(1)} is running, but `;
  if (lane.unreadable) {
    return (
      `${opener}its last verdict record cannot be read, so it is being treated as blind ` +
      `(expected at least one verdict every ${bound}). While that holds, ${subject.cost}. ` +
      `Check ${subject.look}.`
    );
  }
  if (!Number.isFinite(lane.ageMs)) {
    return (
      `${opener}it has NEVER once reached a verdict, so it has been reporting nothing for its ` +
      `entire life while looking healthy (expected at least one verdict every ${bound}). ` +
      `${subject.cost[0].toUpperCase()}${subject.cost.slice(1)}. Check ${subject.look}.`
    );
  }
  return (
    `${opener}it has not reached a verdict in ${describeGap(lane.ageMs)} ` +
    `(expected at least one every ${bound}). While that holds, ${subject.cost}. ` +
    `Check ${subject.look}.`
  );
}

/** All-clear for a detector that is concluding again (#1394). It names what is
 *  being measured once more, because the page was about a missing answer. */
export function verdictRecoveryText(lane: string): string {
  const subject = verdictSubject(lane);
  return (
    `${subject.what[0].toUpperCase()}${subject.what.slice(1)} has reached a verdict again, so it ` +
    `is measuring rather than merely running, and the earlier page is cleared. No action is needed.`
  );
}

/**
 * Canary alert copy, keyed by which pass went quiet (#525, #982). The half hourly dry
 * tick and the hourly full pass (#1493) are separate heartbeats: a stale dry tick means the
 * whole canary stopped, while a stale `smoke-canary-full` means only the full
 * end-to-end booking proof stopped (the dry tick may still be fine), and recovery
 * is a full-pass re-run, so the two need distinct, actionable messages.
 */
export function canaryAlertText(lane: StaleLane, boundMin: number): string {
  const quiet = laneQuietClause({ ageMs: lane.ageMs, boundMin, unreadable: lane.unreadable });
  if (lane.lane === "smoke-canary-full") {
    return `The booking smoke canary's full end to end pass (create, reschedule, cancel) ${quiet}, so the automated proof that a booking can actually be made is no longer running (the quick health tick may still be fine). Both the hourly scheduled run and the Worker gap filler have failed to complete it. Re run it from the Actions tab (Run workflow on smoke-canary, mode full).`;
  }
  if (lane.lane === "router-replay") {
    // No hand re run here (#2466), for the reason the parity page below gives: the
    // monitor lane re fires this one once the weekly run is late enough to count as
    // dropped, so a person reaching this page has already seen that tried.
    return `The weekly replay that puts real cal.com routed leads through the Slate tier ladder ${quiet}, so nothing is measuring whether Slate would route them the way the incumbent does. The pilot now sends about half of real leads to Slate, but only the leads cal.com still takes say which advisor the incumbent would have chosen, so this is the only comparison of Slate routing against it. It also goes quiet when it runs and cannot judge enough leads to mean anything, which is the same silence. The monitor lane already re fires the replay once the weekly run is late enough to count as dropped, so GitHub's schedule and that re attempt have both failed to conclude one. Read what the last router-replay run in the Actions tab actually said. If cal.com no longer takes bookings, mark it retired at the foot of the alerts page and this stops.`;
  }
  if (lane.lane === "schedule-parity") {
    // No "re run it from the Actions tab" here, unlike its two siblings above: the
    // monitor lane re fires this one by itself (#2414), so by the time the bound is
    // reached the hand re run has already been tried and failed. Naming it would be
    // a remedy that no longer matches what the system does (L111), which is worse
    // than none. What is left for a person is to read why the attempts died.
    return `The daily check comparing Slate's roster and working hours against cal.com ${quiet}, so nothing is watching for the two systems drifting apart while both are live. Drift ran at about four agents a day the last time this went unwatched, and it is invisible from inside Slate: a schedule saying 08:00 reads the same whether or not the agent starts then. The monitor lane already re fires this once the daily run is late enough to count as dropped, so GitHub's schedule and that re attempt have both failed to finish one. Read what the last schedule-parity run in the Actions tab actually said: a run that starts and then cannot reach cal.com, Twilio or Slate never stamps. If cal.com no longer takes bookings, mark it retired at the foot of the alerts page and this stops.`;
  }
  return `The booking smoke canary ${quiet}, so the automated end to end booking check is no longer running. The scheduled GitHub Actions workflow (smoke-canary) has likely stopped firing or is failing before it can report. Check the Actions tab and re run it.`;
}

/**
 * Snowflake-mirror alert copy, keyed by which lane went quiet (#1101, #1123).
 *
 * The three lanes fail for different reasons and are recovered differently: the
 * export FEEDS the warehouse, while reconcile and the erasure audit are the two
 * CHECKS on it, on a different cron expression and different locks. One shared
 * message used to name the export lane and its every-10-minutes lock for all of
 * them, which would point a responder at the wrong lane and lock. Each lane
 * gets its own cause and its own next step, and each says plainly that the app
 * itself is unaffected so nobody treats it as an outage.
 */
export function mirrorAlertText(lane: StaleLane, boundMin: number): string {
  const quiet = laneQuietClause({ ageMs: lane.ageMs, boundMin, unreadable: lane.unreadable });
  if (lane.lane === "snowflake-reconcile") {
    return `The check that compares the live database against the Snowflake mirror ${quiet}, so nothing is verifying that the warehouse still matches the source (the app itself is unaffected). Anything that trusts the mirror being complete, including export gated deletion, should be treated as unverified until this clears. Check the cron_snowflake_reconcile lock and the Worker outcome for the 6h lane.`;
  }
  if (lane.lane === "erasure-audit") {
    return `The check that proves an erased person's data is really gone from the Snowflake warehouse ${quiet}, so a deletion request could be sitting half finished with nobody watching (the app itself is unaffected). This is the only automated check on the operator's manual warehouse purge step. Check the cron_erasure_audit lock and the Worker outcome for the 6h lane.`;
  }
  return `The Snowflake mirror export lane ${quiet}, so the analytics warehouse is going stale (the app itself is unaffected). Check the cron_snowflake_export lock and the Worker outcome for the */10 lane.`;
}

/**
 * The recurring whisper that a safety net is deliberately off (#1561).
 *
 * A parked detector is a net nobody is holding, and the failure this whole family
 * exists to catch is exactly that being invisible. Silence would fix the noise and
 * recreate the #1394 defect one level up, so the park says itself out loud on a
 * slow cadence: often enough that it cannot be forgotten before cutover, rarely
 * enough that it is never the thing anyone scrolls past.
 *
 * It carries each detector's REASON and the issue that arms it, because the only
 * useful response to this whisper is to decide whether the reason still holds.
 */
export function verdictParkedInfoText(
  lanes: string[],
  registry?: Parameters<typeof parkedDetector>[1],
): string {
  const items = lanes.map((lane) => {
    const subject = verdictSubject(lane);
    const parked = parkedDetector(lane, registry);
    // A lane with no entry cannot describe a park, so it says what it knows rather
    // than rendering the word undefined twice into a sentence (#2484, L11).
    if (!parked) {
      return (
        `${subject.what[0].toUpperCase()}${subject.what.slice(1)} is listed as parked with no entry ` +
        `in PARKED_VERDICT_DETECTORS, which is a code fault rather than a decision.`
      );
    }
    return (
      `${subject.what[0].toUpperCase()}${subject.what.slice(1)} is parked because ` +
      `${parked.reason}. While it is parked, ${subject.cost}. Arm it in #${parked.issue}.`
    );
  });
  return (
    `${lanes.length} monitoring ${lanes.length === 1 ? "check is" : "checks are"} parked, ` +
    `so ${lanes.length === 1 ? "it is" : "they are"} not watching anything today. ` +
    `This is on purpose and nothing is broken; it is repeated so the missing cover ` +
    `stays visible rather than silent. ${items.join(" ")}`
  );
}

/**
 * A parked detector has reached a verdict anyway, so the park is over (#1561).
 *
 * This is the good direction: cutover looks precisely like this, and it is the
 * reason the park does not need anyone to remember it. The message is a page
 * rather than a whisper because the detector is now capable of watching and is
 * still switched off, which is the state the reader has to end.
 */
/**
 * Where to go to arm a parked detector, named so it is never a bare `#undefined`.
 *
 * The registry is the destination either way; the issue number is a convenience
 * when there is one. A lane with no entry is the rare path (both callers are sent
 * only while a lane IS parked), which is exactly the kind that ships unexercised
 * and then renders the word undefined into a sentence somebody reads on a phone
 * (#2484, L535, L11).
 */
function unparkDestination(lane: string, registry?: Parameters<typeof parkedDetector>[1]): string {
  const parked = parkedDetector(lane, registry);
  const where = "PARKED_VERDICT_DETECTORS in src/lib/monitor/verdict-freshness.ts";
  return parked ? `${where} and close #${parked.issue}` : where;
}

export function verdictUnparkAlertText(
  lane: string,
  registry?: Parameters<typeof parkedDetector>[1],
): string {
  const subject = verdictSubject(lane);
  return (
    `${subject.what[0].toUpperCase()}${subject.what.slice(1)} has reached a verdict, ` +
    `so the reason it was parked has stopped being true and it is now switched off ` +
    `while able to watch. Until it is armed, ${subject.cost}. Take it out of ` +
    `${unparkDestination(lane, registry)}.`
  );
}

/**
 * All-clear for an un-park page: somebody armed the detector.
 *
 * One of TWO endings, and the only one that may say this (#1562). See
 * `verdictUnparkLapsedText` for the other.
 */
export function verdictUnparkRecoveryText(lane: string): string {
  const subject = verdictSubject(lane);
  return (
    `${subject.what[0].toUpperCase()}${subject.what.slice(1)} is armed again, so it is ` +
    `being watched against its own bound like every other detector and the earlier ` +
    `page is cleared. No action is needed.`
  );
}

/**
 * The OTHER ending of an un-park page: the detector went quiet again (#1562).
 *
 * A park ends two ways and they are not the same news. Somebody arming the
 * detector is `verdictUnparkRecoveryText`. This one is the verdict lapsing: the
 * detector concluded, the page asked for it to be armed, nobody armed it, and it
 * has now stopped concluding, so the park it never left still stands.
 *
 * It needs its own wording because the two were sharing one all-clear, and that
 * all-clear says the detector "is armed again, so it is being watched against its
 * own bound". Sent on a lapse, every clause of it is false, and it is a claim the
 * watchdog never measured (L11). What it must leave the reader with instead is why
 * the earlier page was not worth acting on: the burst was too brief to be the
 * traffic the park is waiting for.
 */
export function verdictUnparkLapsedText(
  lane: string,
  registry?: Parameters<typeof parkedDetector>[1],
): string {
  const subject = verdictSubject(lane);
  // Deliberately does NOT recite the park's reason. The weekly whisper carries that,
  // at length, and this is a message whose whole content is that there is nothing to
  // do: repeating four lines of arithmetic here buries the one fact worth reading.
  return (
    `${subject.what[0].toUpperCase()}${subject.what.slice(1)} has stopped reaching a verdict ` +
    `again, so the earlier page asking for it to be switched on is cleared and it stays parked. ` +
    `Nothing was armed, and nothing needs to be: the verdict was too short lived to be the ` +
    `traffic the park is waiting for. ${unparkDestination(lane, registry)} is still where it goes back on. ` +
    `No action is needed.`
  );
}

/**
 * Which noodge check stamps which lane (#1228), with the name the check carries in
 * noodge's dashboard, so the page sends the reader to the right row. The names are
 * the ones the production rows carry and `monitors/slate.sql` in Try-Pennie/noodge
 * keeps them at.
 */
const UPTIME_CHECK: Record<string, { path: string; name: string }> = {
  "uptime:api-health": { path: "/api/health", name: "Slate: API health (DB + cron lanes)" },
  "uptime:availability-canary": {
    path: "/api/health/availability",
    name: "Slate: Booker availability canary",
  },
};

/**
 * noodge's keyed check of a Slate endpoint has stopped reaching it (#1228).
 *
 * This message is sent BY the Worker, so Slate is up: the silence is on noodge's
 * side, and what is at stake is that nothing outside Slate would notice if it went
 * down. The reader is told to look at the check and at noodge, in that order,
 * because those are the two things that can be wrong. The never-stamped case adds
 * the third, a deployment with no key, which stamps nothing whatever noodge does.
 */
export function uptimeAlertText(lane: StaleLane): string {
  const check = UPTIME_CHECK[lane.lane] ?? { path: lane.lane, name: lane.lane };
  const bound = describeGap(lane.maxStaleMs);
  const stake =
    `Slate is up (this message comes from it), so the silence is on noodge's side, and ` +
    `while it lasts nothing outside Slate would notice a dead Worker or a broken deploy.`;
  const todo =
    `Open noodge.trypennie.dev and check that "${check.name}" is still registered and ` +
    `enabled, and that noodge itself is running (its scheduler health on the dashboard).`;
  if (!Number.isFinite(lane.ageMs)) {
    return (
      `Noodge's check of ${check.path} has NEVER reached Slate with the heartbeat key ` +
      `(expected at least once every ${bound}). ${stake} ${todo} If the check is missing, ` +
      `run npm run monitors:sync:slate in the noodge repo. If it is there and running, ` +
      `this deployment may have no UPTIME_HEARTBEAT_KEY set, and then it never stamps, ` +
      `or noodge holds a different value.`
    );
  }
  if (lane.unreadable) {
    // Nothing was measured about noodge here, so the message says so rather than
    // claiming a silence (L11). The stored row is the first thing to look at.
    return (
      `The heartbeat record for noodge's check of ${check.path} cannot be read, so whether ` +
      `noodge is still checking is unknown and it is being treated as stale (expected at ` +
      `least once every ${bound}). Look at the ${lane.lane} row in lane_heartbeats, then ${todo[0].toLowerCase()}${todo.slice(1)}`
    );
  }
  return (
    `Noodge's check of ${check.path} has not reached Slate for ${describeGap(lane.ageMs)} ` +
    `(expected at least once every ${bound}). ${stake} ${todo} If Slate itself was down ` +
    `in the last few minutes, noodge should already have alerted and this clears on its ` +
    `next run.`
  );
}

/** All-clear for noodge's keyed check (#1228). */
export function uptimeRecoveryText(lane: string): string {
  const check = UPTIME_CHECK[lane] ?? { path: lane, name: lane };
  return (
    `Noodge's check of ${check.path} is reaching Slate again, so the external uptime ` +
    `monitor is watching it once more and the earlier page is cleared. No action is needed.`
  );
}
