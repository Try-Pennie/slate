/**
 * The words the cron dead-man's switch says (#1153).
 *
 * Lifted out of lane-watchdog.ts so the alert preview can render the REAL copy by
 * calling these, instead of holding a second copy that would drift the first time
 * someone edited one and not the other (L41). The watchdog imports them back.
 *
 * Five lane families, five voices, deliberately: these lanes fail for different
 * reasons and are recovered by different people doing different things, and
 * #1123 already had to unpick one shared message that pointed responders at the
 * wrong lane and lock.
 */
import { describeGap, laneQuietClause, type StaleLane } from "@/lib/monitor/health";
import {
  AVAILABILITY_TRUTH_VERDICT_LANE,
  FAILURE_RATE_VERDICT_LANE,
  LOW_VOLUME_VERDICT_LANE,
  OOO_PROTECTION_VERDICT_LANE,
  TWILIO_ROSTER_VERDICT_LANE,
  LANE_WATCHDOG_VERDICT_LANE,
  parkedDetector,
} from "@/lib/monitor/verdict-freshness";

/** Minutes, rounded, for the copy. */
const minutes = (ms: number) => Math.round(ms / 60_000);

/**
 * A Worker cron lane that has gone quiet. The usual cause is a mid-run CPU kill
 * on the shared invocation (#760), so the message sends the reader straight at
 * the two things worth looking at.
 */
export function coreLaneAlertText(lane: StaleLane): string {
  return (
    `The ${lane.lane} cron lane ${laneQuietClause({
      ageMs: lane.ageMs,
      boundMin: minutes(lane.maxStaleMs),
      unreadable: lane.unreadable,
    })}. Its work is not happening. A mid-run CPU kill on the shared cron ` +
    `invocation is the usual cause (#760): check the Worker's outcome for ` +
    `exceededCpu, and the cron_${lane.lane} lock.`
  );
}

/** All-clear for a Worker cron lane. Carries no remediation: the page sent the
 *  reader to check for a CPU kill and a stuck lock, and repeating that here would
 *  send them after a fault that is over. */
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
 */
const VERDICT_SUBJECT: Record<string, { what: string; cost: string; look: string }> = {
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
  [TWILIO_ROSTER_VERDICT_LANE]: {
    what: "the hourly roster sync's Twilio half, which takes an agent out of the bookable pool when Twilio marks them redistribute",
    cost: "somebody tagged redistribute would go on being offered to leads, and anybody whose tag came off would stay out of the pool",
    look: 'the Worker logs for tag=twilio-sync and tag=agents, and whether the hourly agents cron is running at all',
  },
};

/**
 * A detector that has gone blind: it keeps running, and it has stopped (or never
 * started) reaching a verdict (#1394).
 *
 * The distinction from every other message in this file is the whole point, so
 * the copy has to carry it: the lane is NOT quiet, and telling someone to go
 * check a stuck lock would send them after a fault that is not there.
 */
export function verdictBlindAlertText(lane: StaleLane): string {
  const subject = VERDICT_SUBJECT[lane.lane];
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
  const subject = VERDICT_SUBJECT[lane];
  return (
    `${subject.what[0].toUpperCase()}${subject.what.slice(1)} has reached a verdict again, so it ` +
    `is measuring rather than merely running, and the earlier page is cleared. No action is needed.`
  );
}

/**
 * Canary alert copy, keyed by which pass went quiet (#525, #982). The 30-min dry
 * tick and the 6h full pass are separate heartbeats: a stale dry tick means the
 * whole canary stopped, while a stale `smoke-canary-full` means only the full
 * end-to-end booking proof stopped (the dry tick may still be fine), and recovery
 * is a full-pass re-run, so the two need distinct, actionable messages.
 */
export function canaryAlertText(lane: StaleLane, boundMin: number): string {
  const quiet = laneQuietClause({ ageMs: lane.ageMs, boundMin, unreadable: lane.unreadable });
  if (lane.lane === "smoke-canary-full") {
    return `The booking smoke canary's full end to end pass (create, reschedule, cancel) ${quiet}, so the automated proof that a booking can actually be made is no longer running (the quick health tick may still be fine). Both the 6h scheduled run and the Worker gap filler have failed to complete it. Re run it from the Actions tab (Run workflow on smoke-canary, mode full).`;
  }
  if (lane.lane === "router-replay") {
    return `The weekly replay that puts real cal.com routed leads through the Slate tier ladder ${quiet}, so nothing is measuring whether Slate would route them the way the incumbent does. It is the ONLY reading of Slate routing that exists before cutover, because cal.com is still taking every real lead and Slate has no traffic of its own to be judged by. It also goes quiet when it runs and cannot judge enough leads to mean anything, which is the same silence, so check what the last run said. Re run it from the Actions tab (Run workflow on router-replay).`;
  }
  if (lane.lane === "schedule-parity") {
    // No "re run it from the Actions tab" here, unlike its two siblings above: the
    // monitor lane re fires this one by itself (#2414), so by the time the bound is
    // reached the hand re run has already been tried and failed. Naming it would be
    // a remedy that no longer matches what the system does (L111), which is worse
    // than none. What is left for a person is to read why the attempts died.
    return `The daily check comparing Slate's roster and working hours against cal.com ${quiet}, so nothing is watching for the two systems drifting apart while both are live. Drift ran at about four agents a day the last time this went unwatched, and it is invisible from inside Slate: a schedule saying 08:00 reads the same whether or not the agent starts then. The monitor lane already re fires this once the daily run is late enough to count as dropped, so GitHub's schedule and that re attempt have both failed to finish one. Read what the last schedule-parity run in the Actions tab actually said: a run that starts and then cannot reach cal.com, Twilio or Slate never stamps.`;
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
export function verdictParkedInfoText(lanes: string[]): string {
  const items = lanes.map((lane) => {
    const subject = VERDICT_SUBJECT[lane];
    const parked = parkedDetector(lane);
    return (
      `${subject.what[0].toUpperCase()}${subject.what.slice(1)} is parked because ` +
      `${parked?.reason}. While it is parked, ${subject.cost}. Arm it in #${parked?.issue}.`
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
export function verdictUnparkAlertText(lane: string): string {
  const subject = VERDICT_SUBJECT[lane];
  const parked = parkedDetector(lane);
  return (
    `${subject.what[0].toUpperCase()}${subject.what.slice(1)} has reached a verdict, ` +
    `so the reason it was parked has stopped being true and it is now switched off ` +
    `while able to watch. Until it is armed, ${subject.cost}. Take it out of ` +
    `PARKED_VERDICT_DETECTORS in src/lib/monitor/verdict-freshness.ts and close #${parked?.issue}.`
  );
}

/**
 * All-clear for an un-park page: somebody armed the detector.
 *
 * One of TWO endings, and the only one that may say this (#1562). See
 * `verdictUnparkLapsedText` for the other.
 */
export function verdictUnparkRecoveryText(lane: string): string {
  const subject = VERDICT_SUBJECT[lane];
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
export function verdictUnparkLapsedText(lane: string): string {
  const subject = VERDICT_SUBJECT[lane];
  const parked = parkedDetector(lane);
  // Deliberately does NOT recite the park's reason. The weekly whisper carries that,
  // at length, and this is a message whose whole content is that there is nothing to
  // do: repeating four lines of arithmetic here buries the one fact worth reading.
  return (
    `${subject.what[0].toUpperCase()}${subject.what.slice(1)} has stopped reaching a verdict ` +
    `again, so the earlier page asking for it to be switched on is cleared and it stays parked. ` +
    `Nothing was armed, and nothing needs to be: the verdict was too short lived to be the ` +
    `traffic the park is waiting for. #${parked?.issue} is still where it goes back on. ` +
    `No action is needed.`
  );
}
