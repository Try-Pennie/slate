/**
 * What the scheduled router replay says, and when it says nothing (#2263).
 *
 * `pnpm verify:router-replay` was hand run, so it found what it found on the day
 * somebody remembered. On a schedule two decisions a person used to make by
 * reading the terminal have to be written down:
 *
 * - **Did the detector CONCLUDE?** That is what the heartbeat records. A run that
 *   reached a usable verdict concluded; a run cal.com refused, or one whose sample
 *   was too thin to judge, did not. A detector that has stopped concluding looks
 *   exactly like one finding nothing wrong (#1394), and a heartbeat stamped
 *   whatever happened would make that state invisible rather than visible.
 * - **What to SAY.** Agreement says nothing at all, because a weekly message
 *   reporting that nothing is wrong is how the ones that matter stop being read
 *   (L36). Everything else is reported, carrying the COMMAND's own sentence rather
 *   than a second copy of the wording written here (L41).
 *
 * The summary file is how a verdict is told apart from a run that never reached
 * one: the command writes it when it decides, so an ABSENT file is evidence rather
 * than an inference from an exit code (L98).
 *
 * Bare node safe: this file imports nothing outside node builtins, because the
 * alerter that uses it runs with no dependency install (#1598).
 *
 * The WRITE and the READ live here together on purpose. They are two halves of one
 * contract across two processes, and a field added on one side and not the other
 * would be invisible until a run needed it (L26).
 */
import { writeFileSync } from "node:fs";

/** What the replay command writes when it reaches a verdict. */
export interface ReplaySummaryFile {
  outcome: string;
  exit: number;
  /** The command's own sentence about what it found, numbers included. */
  detail: string;
}

export interface ReplayReportDecision {
  /**
   * Whether the detector reached a USABLE verdict, which is what the heartbeat
   * records. Agreement and a disagreement both count; a run that could not judge
   * enough leads to mean anything does not.
   */
  concluded: boolean;
  /** What to post, or null when there is nothing worth saying. */
  alert: string | null;
}

/**
 * The outcomes that mean the ladder was really compared.
 *
 * Only these two stamp the heartbeat. `nothing-judged`, `resolution-too-low` and
 * `catchall-too-high` are each a run that LOOKED and could not conclude usefully,
 * which is the blind detector state, so they are reported and leave the heartbeat
 * to go stale if they persist.
 */
const CONCLUDING = new Set(["agree", "disagreement"]);

/**
 * Write the verdict where the scheduled lane can read it.
 *
 * Returns whether it landed, and NEVER throws. The command calls this having
 * already measured what it measured, and a failed write must not turn a reported
 * verdict into a run that looks as though it never happened. The failure direction
 * is the safe one either way: with no file the lane reports "did not complete" and
 * leaves the heartbeat unstamped, which is louder than the truth rather than
 * quieter (L95).
 *
 * An empty path writes nothing and says so: a hand run sets no path and is reading
 * the terminal instead.
 */
export function writeReplaySummary(
  path: string,
  summary: ReplaySummaryFile,
): { written: boolean; why: string } {
  if (!path.trim()) return { written: false, why: "no summary path was set" };
  try {
    writeFileSync(path, JSON.stringify(summary, null, 2), "utf8");
    return { written: true, why: "written" };
  } catch (err) {
    return { written: false, why: String(err) };
  }
}

export function decideReplayReport(
  summary: ReplaySummaryFile | null,
  runUrl: string,
): ReplayReportDecision {
  // An absent RUN_URL is an unset workflow variable, not a link to nowhere: saying
  // where to look beats printing an empty line under the sentence.
  const where = runUrl.trim() || "Open the router-replay workflow in the Actions tab.";

  if (summary === null) {
    return {
      concluded: false,
      alert: [
        "The weekly replay of cal.com's routed leads through Slate's ladder did not complete, so " +
          "nothing measured this week whether Slate would route real leads the way the incumbent " +
          "does.",
        "It reads cal.com's routing form responses and puts each lead to Slate's own code " +
          "resolution and tier ladder. A rate limit, a refused key or an unreadable Slate roster " +
          "each stop it, and the run says which.",
        where,
      ].join("\n"),
    };
  }

  if (summary.outcome === "agree") return { concluded: true, alert: null };

  const known = CONCLUDING.has(summary.outcome) || summary.exit > 0;
  return {
    concluded: CONCLUDING.has(summary.outcome),
    alert: [
      known && summary.outcome !== "agree"
        ? "The weekly replay of cal.com's routed leads through Slate's ladder did not come back clean."
        : "The weekly replay of cal.com's routed leads reported something this cannot read, which " +
          "is a fault in the report rather than a reading about routing.",
      // The command's OWN sentence, so the numbers are the ones it measured and
      // there is no second copy of the wording to keep in step (L41).
      summary.detail.trim() || `outcome: ${summary.outcome} (exit ${summary.exit})`,
      where,
    ].join("\n"),
  };
}
