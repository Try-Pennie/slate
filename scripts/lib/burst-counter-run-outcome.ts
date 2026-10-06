/**
 * What the scheduled burst counter proof says, and when it counts as a verdict (#2392).
 *
 * `pnpm verify:burst-counter` (#1564) was hand run, and AGENTS.md asked in words for
 * it to be re-run after any change to the burst path or the `BURST_LIMITER` binding.
 * Nothing enforced that: the path moved five times with no run recorded, because a
 * rule that lives only in a prompt is a hope (L27). On a schedule, two decisions a
 * person used to make by reading the terminal have to be written down.
 *
 * - **Did it reach a MEASURED verdict?** That is what the `verdict:burst-counter`
 *   stamp records, and it is the only thing that may write it. The command has
 *   thirteen endings and most of them mean it never got to ask the question: a
 *   refused key, a deployment that predates the endpoint, a Worker that could not
 *   read its own context. Stamping on one of those would report the detector
 *   concluding while it is blind, which is the substitution the whole verdict family
 *   exists to stop (#1394, L98, L331).
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
 * Bare node safe: this file imports nothing outside `scripts/` (the shared summary
 * writer, itself node builtins only), because the reporter that uses it runs with no
 * dependency install (#1598). That is also why `VERIFY_EXIT`
 * LIVES here rather than in `burst-counter-live-control.ts`, which reaches into `src/`
 * for the probe vocabulary; that module re-exports it, so there is still one table.
 *
 * The WRITE and the READ of the summary file are two halves of one contract across
 * two processes, so both live in `run-summary-file.ts`, shared with the kill switch
 * and the confirm line proofs rather than written out once per proof (L26).
 */
import { writeRunSummary } from "./run-summary-file.ts";

/**
 * Every way the command can end, and the exit code it ends on.
 *
 * One code per cause, never a shared "it failed" (L11). These are what a caller in a
 * shell script branches on, and each one names a different thing to go and do: a key
 * to fix, a deployment to ship, a binding to restore, Cloudflare to ask about, or a
 * counter that is genuinely not counting.
 */
export const VERIFY_EXIT = {
  /** The count rose. The only zero. */
  passed: 0,
  /** This machine is missing the base URL or the API key, so nothing was attempted. */
  misconfigured: 1,
  /** The request never got a reply at all: DNS, TLS, a timeout, no network. */
  noAnswer: 2,
  /** Something replied with a shape this endpoint never produces (a platform error page). */
  unreadableReply: 3,
  /** The deployment rejected the key. */
  unauthorized: 4,
  /** The deployment has no booking API key configured, so the endpoint is disabled. */
  notConfigured: 5,
  /** The deployment does not carry the endpoint: it is older than this change. */
  endpointMissing: 6,
  /** The running Worker could not read its own request context. */
  contextUnreadable: 7,
  /** `BURST_LIMITER` is absent from the running deployment. */
  bindingMissing: 8,
  /** The namespace resolved and the object did not answer. The gap this command exists for. */
  objectUnreachable: 9,
  /** The object answered without a count, so there was nothing to compare. */
  noCount: 10,
  /** The fixed window rolled between the readings, so the two numbers are different counts. */
  windowRolled: 11,
  /** Two readings inside one window, and the second was not greater than the first. */
  didNotRise: 12,
} as const;

export type BurstVerifyExit = (typeof VERIFY_EXIT)[keyof typeof VERIFY_EXIT];

/** What the command writes when it decides. */
export interface BurstSummaryFile {
  /** The `VERIFY_EXIT` code it ended on. */
  exit: number;
  /** The command's own sentence about what it found, numbers included. */
  detail: string;
}

export interface BurstReportDecision {
  /** Whether the run MEASURED whether the counter answers and counts. Only this may stamp. */
  concluded: boolean;
  /** What to post, or null when there is nothing worth saying. */
  alert: string | null;
}

interface RunJudgement {
  /**
   * Did the run get an answer to the question the detector asks: does the burst
   * counter, in the running deployment, take a report and come back with a count
   * that rose?
   */
  concluded: boolean;
  /** The opening sentence, or null when there is nothing worth saying. */
  headline: string | null;
}

/**
 * Every ending, judged one by one.
 *
 * Three of them CONCLUDE, and the two that are not the happy path are the interesting
 * ones: a counter that answers and does not count, and a bound object that does not
 * answer, are both definite readings of the thing under test. They stamp AND they
 * speak, because a fresh stamp with nothing said would be the only trace of a ceiling
 * that is failing open.
 *
 * `bindingMissing` deliberately does NOT conclude, although it feels like the most
 * definite answer in the table. The half this command exists to prove is the
 * ANSWERING half, and a deployment with nothing bound never exercised it: a stamp
 * there would let a deploy that shipped without the `durable_objects` block keep the
 * verdict fresh for as long as it stayed broken. It is already paged by the monitor
 * lane's own presence read (#1558), so nothing is lost by leaving it to the bound.
 *
 * `windowRolled` is the one ending that is neither a finding nor a failure: nothing is
 * wrong and nothing was learned. It stamps nothing and says nothing, so a run of them
 * lapses the stamp and the blind detector page fires with words that fit.
 */
export const RUN_JUDGEMENT: Record<BurstVerifyExit, RunJudgement> = {
  [VERIFY_EXIT.passed]: { concluded: true, headline: null },
  [VERIFY_EXIT.misconfigured]: {
    concluded: false,
    headline:
      "Today's burst counter proof is missing the key or the base URL it needs, so it attempted " +
      "nothing and nothing was measured about the request ceiling.",
  },
  [VERIFY_EXIT.noAnswer]: {
    concluded: false,
    headline:
      "Today's burst counter proof got no reply from the deployment at all, so nothing was " +
      "measured about the request ceiling.",
  },
  [VERIFY_EXIT.unreadableReply]: {
    concluded: false,
    headline:
      "Something other than the deployment's own endpoint answered today's burst counter proof, " +
      "so nothing was measured about the request ceiling.",
  },
  [VERIFY_EXIT.unauthorized]: {
    concluded: false,
    headline:
      "The deployment would not accept the key today's burst counter proof reports with, so " +
      "nothing was measured about the request ceiling.",
  },
  [VERIFY_EXIT.notConfigured]: {
    concluded: false,
    headline:
      "The deployment has no booking API key configured, so it refused today's burst counter " +
      "proof before it ever reached the counter.",
  },
  [VERIFY_EXIT.endpointMissing]: {
    concluded: false,
    headline:
      "The running deployment does not carry the endpoint today's burst counter proof reports " +
      "through, so nothing was measured about the request ceiling.",
  },
  [VERIFY_EXIT.contextUnreadable]: {
    concluded: false,
    headline:
      "The running Worker could not read its own request context, so it never looked for the " +
      "burst counter and today's proof measured nothing.",
  },
  [VERIFY_EXIT.bindingMissing]: {
    concluded: false,
    headline:
      "The running deployment has no burst counter bound at all, so the ceiling that stops one " +
      "caller spreading a burst across the edge is off, and today's proof could not test whether " +
      "it answers.",
  },
  [VERIFY_EXIT.objectUnreachable]: {
    concluded: true,
    headline:
      "The burst counter is bound and did not answer when it was called, which is the one state " +
      "the monitor lane cannot see, so the request ceiling is failing open right now.",
  },
  [VERIFY_EXIT.noCount]: {
    concluded: false,
    headline:
      "The burst counter answered with a reply shape this cannot read, so whether it counts is " +
      "still unknown. That is a code fault rather than a deploy one.",
  },
  [VERIFY_EXIT.windowRolled]: { concluded: false, headline: null },
  [VERIFY_EXIT.didNotRise]: {
    concluded: true,
    headline:
      "The burst counter is answering and not counting, so the request ceiling is measuring " +
      "nothing while reading as healthy on every other surface.",
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
 * It speaks from the RUNNER rather than reporting into Slate's own alerting, which is
 * the schedule-parity choice (#2031) reversed and worth stating. That one is a daily
 * finding that sits for days while people edit the other system, so it needs a
 * cooldown and an all clear, and both need a memory a runner has none of. This one is
 * a rare fault somebody fixes the day they read it, so the whole condition machinery
 * would buy one thing: telling a reader it had cleared. Saying what silence means does
 * that for the price of a sentence, and a warning is read by its presence (L678).
 */
const REPEAT_NOTE =
  "This repeats once a day until a run passes, and a run that passes says nothing.";

/**
 * Decide what the scheduled run stamps and what it says.
 *
 * `summary` is what the command wrote when it decided, or null when no verdict
 * reached this process at all.
 */
export function decideBurstCounterReport(
  summary: BurstSummaryFile | null,
  runUrl: string,
): BurstReportDecision {
  // An absent RUN_URL is an unset workflow setting, not a link to nowhere: saying
  // where to look beats printing an empty line under the sentence.
  const where = runUrl.trim() || "Open the burst-counter workflow in the Actions tab.";

  if (summary === null) {
    return {
      concluded: false,
      alert: [
        "Today's proof that the burst counter answers did not complete, so nothing measured " +
          "whether the ceiling that stops one caller spreading a burst across the edge is " +
          "switched on.",
        "It reports one monitor key to the live BURST_LIMITER object, reads the count back and " +
          "requires it to have risen. The run itself says how far it got.",
        REPEAT_NOTE,
        where,
      ].join("\n"),
    };
  }

  const judgement = RUN_JUDGEMENT[summary.exit as BurstVerifyExit];
  if (judgement === undefined) {
    // An ending this table does not know. Reported rather than dropped, and never
    // counted as a verdict: a code added to the command without being judged here
    // must arrive as something somebody reads, not as a silent pass (L98).
    return {
      concluded: false,
      alert: [
        `Today's burst counter proof ended on exit ${summary.exit}, which nothing here knows how ` +
          "to read, so whether the request ceiling is switched on was not established.",
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
      // The command's OWN sentence, so the numbers and the remedy are the ones it
      // measured and there is no second copy of the wording to keep in step (L41).
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
export function writeBurstSummary(
  path: string,
  summary: BurstSummaryFile,
): { written: boolean; why: string } {
  // One writer for every scheduled proof (scripts/lib/run-summary-file.ts, #3340).
  return writeRunSummary(path, summary);
}
