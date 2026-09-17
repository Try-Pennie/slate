/**
 * What the scheduled kill switch proof says, and when it counts as a verdict (#2493).
 *
 * `pnpm verify:kill-switch` (#2365) had run exactly once, in the session that wrote
 * it. That is the state `verify:burst-counter` was in when #2392 found the burst path
 * had moved five times with nobody re-running the proof, because a rule that lives
 * only in a prompt is a hope (L27) and a check that has never once concluded is
 * measuring nothing (L557).
 *
 * The answer taken there was a daily workflow that stamps a verdict, and it is the
 * answer taken here, with ONE difference forced by this command's side effect:
 * running it STOPS public booking for about two seconds. So the schedule sits outside
 * the hours the org advertises rather than in the morning, and the reasoning for that
 * lives in `.github/workflows/kill-switch.yml` beside the cron it justifies.
 *
 * On a schedule, two decisions a person used to make by reading the terminal have to
 * be written down.
 *
 * - **Did it reach a MEASURED verdict?** That is what the `verdict:kill-switch` stamp
 *   records, and it is the only thing that may write it. The command has fourteen
 *   endings and half of them mean it never got to ask the question. A stamp on one of
 *   those would report the detector concluding while it is blind, which is the exact
 *   substitution the verdict family exists to stop (#1394, L98, L331).
 * - **What to SAY.** The good day says nothing, because a daily message reporting
 *   that nothing is wrong is how the ones that matter stop being read (L36).
 *   Everything else is reported, carrying the COMMAND's own sentence rather than a
 *   second copy of the wording written here (L41).
 *
 * The summary FILE is how a verdict is told apart from a run that died before
 * reaching one. Node exits 1 on an uncaught throw and 1 is also a real ending of this
 * command ("nothing was attempted here"), so an exit code alone makes those two one
 * message (L11). An absent file is evidence rather than an inference (L98).
 *
 * Bare node safe: this file imports nothing but node builtins and the command's own
 * exit table, which itself imports nothing, because the reporter that uses it runs
 * with no dependency install (#1598).
 */
import { writeFileSync } from "node:fs";
import { KILL_SWITCH_EXIT } from "./kill-switch-live-control.ts";

export type KillSwitchExit = (typeof KILL_SWITCH_EXIT)[keyof typeof KILL_SWITCH_EXIT];

/** What the command writes when it decides. */
export interface KillSwitchSummaryFile {
  /** The `KILL_SWITCH_EXIT` code it ended on. */
  exit: number;
  /** The command's own sentence about what it found. */
  detail: string;
}

export interface KillSwitchReportDecision {
  /** Whether the run MEASURED whether the switch refuses and releases. Only this may stamp. */
  concluded: boolean;
  /** What to post, or null when there is nothing worth saying. */
  alert: string | null;
}

interface RunJudgement {
  /**
   * Did the run get an answer to the question the detector asks: does the deployed
   * booker refuse a public booking while the flag is ON, and take one while it is
   * OFF?
   */
  concluded: boolean;
  /** The opening sentence, or null when there is nothing worth saying. */
  headline: string | null;
}

/**
 * Every ending, judged one by one.
 *
 * FIVE of them conclude, and the four that are not the happy path are the interesting
 * ones: a switch that does not refuse, a booker refusing with the switch off, a
 * refusal carrying the unreadable copy, and a switch that also closed availability,
 * are all definite readings of the thing under test. They stamp AND they speak,
 * because a fresh stamp with nothing said would be the only trace of a gate that is
 * not doing its job.
 *
 * `availabilityUnmeasured` concludes too, and it is the one that needs saying out
 * loud. The detector's question is whether the SWITCH refuses and releases, and by
 * the time that code is reachable both directions have already been proven; what was
 * not measured is the separate promise that availability keeps answering. So it is a
 * verdict about the switch and a job half done, which is why it stamps and still
 * speaks.
 *
 * `notRestored` deliberately does NOT conclude, although it is the loudest thing in
 * this table. It is judged before anything else the run found, so the gate's own
 * behaviour may never have been reached, and a stamp there would let a run that
 * stranded the flag keep the verdict fresh. It is also the one ending that goes on
 * turning real leads away after the command exits, so its message leads with that and
 * nothing else.
 *
 * `alreadyPaused` is neither a finding about the switch nor a failure: somebody has
 * stopped public booking on purpose and the command correctly stood down rather than
 * turning it back on for them. It stamps nothing, because nothing was measured, and
 * it SPEAKS, because a reader who sees no message would have no way to tell it from a
 * pass, and because a run of them means the switch has been left on, which is exactly
 * what `public_booking_stopped` (#2366) is for.
 */
export const RUN_JUDGEMENT: Record<KillSwitchExit, RunJudgement> = {
  [KILL_SWITCH_EXIT.ok]: { concluded: true, headline: null },
  [KILL_SWITCH_EXIT.notRestored]: {
    concluded: false,
    headline:
      "Tonight's kill switch proof turned public booking OFF and could not turn it back on, so " +
      "the embed is refusing every new booking right now.",
  },
  [KILL_SWITCH_EXIT.doesNotRefuse]: {
    concluded: true,
    headline:
      "The kill switch was ON and the deployed booker took a public booking anyway, so the one " +
      "lever that can stop Slate putting invites on agents' calendars does not stop anything.",
  },
  [KILL_SWITCH_EXIT.refusesWhileOpen]: {
    concluded: true,
    headline:
      "The deployed booker refused a public booking while the kill switch was OFF, so it is " +
      "turning leads away on its own.",
  },
  [KILL_SWITCH_EXIT.refusedUnreadable]: {
    concluded: true,
    headline:
      "The deployed booker is refusing because it CANNOT READ its own kill switch flag rather " +
      "than because anybody set it, so it refuses every lead whether or not bookings were stopped.",
  },
  [KILL_SWITCH_EXIT.availabilityClosed]: {
    concluded: true,
    headline:
      "The kill switch refuses and releases correctly, and it also closed availability while it " +
      "was on, which it must never do: a lead should still see times while the booking write is stopped.",
  },
  [KILL_SWITCH_EXIT.availabilityUnmeasured]: {
    concluded: true,
    headline:
      "The kill switch was proven in both directions, and whether it leaves availability alone " +
      "was not measured, because the bucket it asks about did not answer in one of the halves.",
  },
  [KILL_SWITCH_EXIT.noAnswer]: {
    concluded: false,
    headline:
      "Tonight's kill switch proof got no reply from the deployment at all, so nothing was " +
      "measured about whether public booking can be stopped.",
  },
  [KILL_SWITCH_EXIT.rateLimited]: {
    concluded: false,
    headline:
      "The rate limiter answered tonight's kill switch proof before the gate did, so the switch " +
      "was never reached and nothing was measured about it.",
  },
  [KILL_SWITCH_EXIT.serverError]: {
    concluded: false,
    headline:
      "The public booking route failed while the kill switch was OFF, so tonight's proof measured " +
      "nothing about the switch and the route itself needs looking at.",
  },
  [KILL_SWITCH_EXIT.endpointMissing]: {
    concluded: false,
    headline:
      "The running deployment has no public booking route for tonight's proof to ask, so nothing " +
      "was measured about whether public booking can be stopped.",
  },
  [KILL_SWITCH_EXIT.unreadableReply]: {
    concluded: false,
    headline:
      "Something other than the deployment's own booking route answered tonight's kill switch " +
      "proof, so nothing was measured about the switch.",
  },
  [KILL_SWITCH_EXIT.alreadyPaused]: {
    concluded: false,
    headline:
      "Tonight's kill switch proof stood down without testing anything, because public booking " +
      "was ALREADY stopped and finishing the run would have started it again for whoever stopped it.",
  },
  [KILL_SWITCH_EXIT.flagNotSet]: {
    concluded: false,
    headline:
      "Tonight's kill switch proof could not write the pause flag, so the paused half was never " +
      "exercised and nothing was measured about the switch. Nothing is left stopped.",
  },
};

/** The endings that may stamp, derived from the table above so there is one list. */
export const CONCLUDING_EXITS: ReadonlySet<number> = new Set(
  Object.entries(RUN_JUDGEMENT)
    .filter(([, judgement]) => judgement.concluded)
    .map(([code]) => Number(code)),
);

/**
 * What silence from this lane means, said in the message itself.
 *
 * It speaks from the RUNNER rather than reporting into Slate's own alerting, for the
 * same reason the burst counter proof does: this is a rare fault somebody fixes the
 * day they read it, so the condition machinery would buy one thing, telling a reader
 * it had cleared, and saying what silence means does that for the price of a sentence
 * (L678).
 */
const REPEAT_NOTE =
  "This repeats once a night until a run passes, and a run that passes says nothing.";

/**
 * Decide what the scheduled run stamps and what it says.
 *
 * `summary` is what the command wrote when it decided, or null when no verdict
 * reached this process at all.
 */
export function decideKillSwitchReport(
  summary: KillSwitchSummaryFile | null,
  runUrl: string,
): KillSwitchReportDecision {
  // An absent RUN_URL is an unset workflow setting, not a link to nowhere: saying
  // where to look beats printing an empty line under the sentence.
  const where = runUrl.trim() || "Open the kill-switch workflow in the Actions tab.";

  if (summary === null) {
    return {
      concluded: false,
      alert: [
        "Tonight's proof that public booking can be stopped did not complete, so nothing measured " +
          "whether the kill switch still refuses a booking when it is on and releases one when it is off.",
        "It sends one deliberately malformed booking with the flag off, then the same one with it " +
          "on, and requires the two to be answered differently. The run itself says how far it got.",
        REPEAT_NOTE,
        where,
      ].join("\n"),
    };
  }

  const judgement = RUN_JUDGEMENT[summary.exit as KillSwitchExit];
  if (judgement === undefined) {
    // An ending this table does not know. Reported rather than dropped, and never
    // counted as a verdict: a code added to the command without being judged here
    // must arrive as something somebody reads, not as a silent pass (L98).
    return {
      concluded: false,
      alert: [
        `Tonight's kill switch proof ended on exit ${summary.exit}, which nothing here knows how to ` +
          "read, so whether public booking can still be stopped was not established.",
        summary.detail.trim() || "The run recorded no detail.",
        REPEAT_NOTE,
        where,
      ].join("\n"),
    };
  }

  if (judgement.headline === null) return { concluded: judgement.concluded, alert: null };

  return {
    concluded: judgement.concluded,
    alert: [
      judgement.headline,
      // The command's OWN sentence, so the remedy is the one it measured and there is
      // no second copy of the wording to keep in step (L41).
      summary.detail.trim() || `The run recorded no detail (exit ${summary.exit}).`,
      REPEAT_NOTE,
      where,
    ].join("\n"),
  };
}

/**
 * Write the verdict where the scheduled lane can read it.
 *
 * Returns whether it landed, and NEVER throws. The command calls this having already
 * measured what it measured, and a failed write must not turn a reported verdict into
 * a run that looks as though it never happened. The failure direction is the safe one
 * either way: with no file the lane reports a run that did not complete and leaves the
 * heartbeat unstamped, which is louder than the truth rather than quieter (L95).
 *
 * An empty path writes nothing and says so: a hand run sets no path and is reading the
 * terminal instead.
 */
export function writeKillSwitchSummary(
  path: string,
  summary: KillSwitchSummaryFile,
): { written: boolean; why: string } {
  if (!path.trim()) return { written: false, why: "no summary path was set" };
  try {
    writeFileSync(path, JSON.stringify(summary, null, 2), "utf8");
    return { written: true, why: "written" };
  } catch (err) {
    return { written: false, why: String(err) };
  }
}
