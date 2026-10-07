/**
 * What the daily shared confirm line proof says, and when it counts as a verdict (#3340).
 *
 * `pnpm verify:confirm-line` drives the confirm path's own client against the live
 * `CONFIRM_LINE` object. On the schedule two decisions a person would make by reading
 * the terminal have to be written down:
 *
 * - **Did it reach a MEASURED verdict?** That is what the `verdict:confirm-line` stamp
 *   records, and only this table may decide it. Most endings mean the command never got
 *   to ask the object anything (a refused key, a deployment older than the endpoint, a
 *   reply it could not fully read), and stamping one of those would report the detector
 *   concluding while it is blind (#1394, L98, L331).
 * - **What to SAY.** The good day says nothing (L36). Everything else is reported with
 *   the command's own sentence rather than a second copy of its wording here (L41).
 *
 * Bare node safe: imports nothing, because the reporter that uses it runs with no
 * dependency install (#1598). That is why the exit table LIVES here rather than in
 * `confirm-line-live-control.ts`, which reaches into `src/` for the probe vocabulary and
 * re-exports this table, so there is still one of it.
 */

/**
 * Every way the command can end, on its own code (L11). A shell caller branches on these,
 * and each names a different thing to go and do.
 */
export const CONFIRM_LINE_EXIT = {
  /** Every check answered as the line's rules say. The only zero. */
  passed: 0,
  /** No base URL or no key here, so nothing was attempted. */
  misconfigured: 1,
  /** The request never got a reply. */
  noAnswer: 2,
  /** Something replied with a shape this endpoint never produces. */
  unreadableReply: 3,
  /** The deployment rejected the key. */
  unauthorized: 4,
  /** The deployment has no booking API key configured, so the endpoint is disabled. */
  notConfigured: 5,
  /** The deployment does not carry the endpoint. */
  endpointMissing: 6,
  /** The Worker could not read its own context. */
  contextUnreadable: 7,
  /** `CONFIRM_LINE` is not bound in the running deployment. */
  bindingMissing: 8,
  /** Bound, and the production client could not use the object: it fell back. */
  objectUnreachable: 9,
  /** The endpoint said it checked, and its reply lacked a check or carried an unknown outcome. */
  incompleteReply: 10,
  /** The probe's own code threw inside a check. */
  checkErrored: 11,
  /** The first confirm on an instant nobody had used was not given the lead. */
  idleNotLed: 12,
  /** A second confirm led while the first still held the line. */
  ledBeside: 13,
  /** A full verdict did not refuse the confirm waiting behind it. */
  fullNotSettled: 14,
  /** A not full verdict did not hand the line on within the report's own two calls. */
  notFullNotHandedOn: 15,
  /** An abandoned lead was freed only after its acknowledgement window. */
  abandonedFreedLate: 16,
  /** An abandoned lead was never freed inside the follower's wait. */
  abandonedNotFreed: 17,
  /** Something the probe used was still held afterwards. */
  leftHeld: 18,
  /** #3460: the pool grouping directory did not answer. */
  directoryUnreachable: 19,
  /** The directory did not store a fresh put, or handed back something else. */
  directoryNotStored: 20,
  /** An older put replaced the newer grouping. */
  directoryOlderWon: 21,
  /** The live directory holds no grouping. */
  groupingAbsent: 22,
  /** The live grouping is one a cold server would refuse. */
  groupingUnusable: 23,
} as const;

export type ConfirmLineExit = (typeof CONFIRM_LINE_EXIT)[keyof typeof CONFIRM_LINE_EXIT];

export interface ConfirmLineReportDecision {
  /** Whether the run MEASURED how the object answers. Only this may stamp. */
  concluded: boolean;
  /** What to post, or null when there is nothing worth saying. */
  alert: string | null;
}

interface RunJudgement {
  /** Did the object get asked, and answer, so the reading is about the line itself? */
  concluded: boolean;
  /** The opening sentence, or null when there is nothing worth saying. */
  headline: string | null;
}

/**
 * Every ending, judged one by one.
 *
 * Every ending where the object was asked and ANSWERED concludes, the bad ones included:
 * a line that excludes nobody, or that never frees an abandoned lead, is a definite
 * reading of the thing under test, so it stamps AND speaks. A fresh stamp with nothing
 * said would otherwise be the only trace of a line that is doing nothing.
 *
 * `objectUnreachable` concludes too, as the burst counter's does: the production client
 * met a bound object that would not answer, which is exactly the state the per isolate
 * fallback hides everywhere else.
 *
 * `bindingMissing` does NOT, although it feels definite: a deployment with nothing bound
 * never exercised the answering half, and a stamp there would keep the verdict fresh for
 * as long as the binding stayed missing. The daily message still says so, and the stamp
 * lapsing adds the blind detector page, so nothing about it is quieter.
 *
 * `incompleteReply` and `checkErrored` are faults in this command or its endpoint, and
 * measured nothing anybody can stand on.
 */
export const RUN_JUDGEMENT: Record<ConfirmLineExit, RunJudgement> = {
  [CONFIRM_LINE_EXIT.passed]: { concluded: true, headline: null },
  [CONFIRM_LINE_EXIT.misconfigured]: {
    concluded: false,
    headline: "Today's shared confirm line proof is missing the key or the base URL it needs, so it asked the object nothing.",
  },
  [CONFIRM_LINE_EXIT.noAnswer]: {
    concluded: false,
    headline: "Today's shared confirm line proof got no reply from the deployment at all, so nothing was measured about the line.",
  },
  [CONFIRM_LINE_EXIT.unreadableReply]: {
    concluded: false,
    headline: "Something other than the deployment's own endpoint answered today's shared confirm line proof, so nothing was measured about the line.",
  },
  [CONFIRM_LINE_EXIT.unauthorized]: {
    concluded: false,
    headline: "The deployment would not accept the key today's shared confirm line proof sends, so nothing was measured about the line.",
  },
  [CONFIRM_LINE_EXIT.notConfigured]: {
    concluded: false,
    headline: "The deployment has no booking API key configured, so it refused today's shared confirm line proof before it reached the object.",
  },
  [CONFIRM_LINE_EXIT.endpointMissing]: {
    concluded: false,
    headline: "The running deployment does not carry the endpoint today's shared confirm line proof runs through, so nothing was measured about the line.",
  },
  [CONFIRM_LINE_EXIT.contextUnreadable]: {
    concluded: false,
    headline: "The running Worker could not read its own request context, so today's shared confirm line proof never looked for the object.",
  },
  [CONFIRM_LINE_EXIT.bindingMissing]: {
    concluded: false,
    headline:
      "The running deployment has no CONFIRM_LINE object bound, so every confirm would use its own isolate's line, and today's shared confirm line proof could not ask whether the object answers.",
  },
  [CONFIRM_LINE_EXIT.objectUnreachable]: {
    concluded: true,
    headline:
      "The shared confirm line is bound and the confirm path's own client could not use it, so a crowd for one slot would form a line per isolate again, which is the state nothing else can see.",
  },
  [CONFIRM_LINE_EXIT.incompleteReply]: {
    concluded: false,
    headline: "The shared confirm line endpoint answered without a readable result for every check, so the proof could not judge the line. That is a fault in the command or the endpoint.",
  },
  [CONFIRM_LINE_EXIT.checkErrored]: {
    concluded: false,
    headline: "The shared confirm line proof failed in its own code before a check could answer, so the line was not judged. That is a fault in the probe, not in the object.",
  },
  [CONFIRM_LINE_EXIT.idleNotLed]: {
    concluded: true,
    headline: "The shared confirm line would not give the lead to the first confirm on a slot nobody had used, so it is holding something it should not.",
  },
  [CONFIRM_LINE_EXIT.ledBeside]: {
    concluded: true,
    headline: "The shared confirm line let a second confirm lead beside the first, so it is excluding nobody and a crowd would run the whole path together.",
  },
  [CONFIRM_LINE_EXIT.fullNotSettled]: {
    concluded: true,
    headline: "The shared confirm line did not answer the waiting confirm from a full verdict, so a crowd for a taken slot would each do the whole confirm.",
  },
  [CONFIRM_LINE_EXIT.notFullNotHandedOn]: {
    concluded: true,
    headline: "The shared confirm line did not hand the lead on after a not full verdict, so confirms queued for a slot that still has room are kept waiting or turned away.",
  },
  [CONFIRM_LINE_EXIT.abandonedFreedLate]: {
    concluded: true,
    headline: "The shared confirm line freed a lead nobody acknowledged only when its lease ran out, so a lost answer holds the line for seconds longer than it should.",
  },
  [CONFIRM_LINE_EXIT.abandonedNotFreed]: {
    concluded: true,
    headline: "The shared confirm line never freed a lead nobody acknowledged, so one lost answer can hold every confirm behind it until they give up.",
  },
  [CONFIRM_LINE_EXIT.leftHeld]: {
    concluded: true,
    headline: "The shared confirm line was still holding something after the proof finished, so a newcomer on that slot could not lead at once.",
  },
  // #3460: the pool grouping directory. Each is the object asked and answering (or, like
  // the line's own, bound and not answering), so each concludes.
  [CONFIRM_LINE_EXIT.directoryUnreachable]: {
    concluded: true,
    headline:
      "The shared confirm line's pool grouping directory did not answer, so the grouping the recompute lane publishes cannot reach any server.",
  },
  [CONFIRM_LINE_EXIT.directoryNotStored]: {
    concluded: true,
    headline:
      "The shared confirm line's pool grouping directory did not keep the grouping it was handed, so no published grouping can reach any server.",
  },
  [CONFIRM_LINE_EXIT.directoryOlderWon]: {
    concluded: true,
    headline:
      "The shared confirm line's pool grouping directory let an older grouping replace a newer one, so a slow publisher could hand servers a stale grouping.",
  },
  [CONFIRM_LINE_EXIT.groupingAbsent]: {
    concluded: true,
    headline: "The shared confirm line's live pool grouping directory holds nothing, so the recompute lane is not publishing to it.",
  },
  [CONFIRM_LINE_EXIT.groupingUnusable]: {
    concluded: true,
    headline: "The shared confirm line's live pool grouping is one a server reading it would refuse, so the snapshot reaches nobody.",
  },
};

/** The endings that may stamp, derived from the table above so there is one list. */
export const CONCLUDING_EXITS: ReadonlySet<number> = new Set(
  Object.entries(RUN_JUDGEMENT)
    .filter(([, judgement]) => judgement.concluded)
    .map(([code]) => Number(code)),
);

/** What silence from this lane means, said in the message itself (the burst counter's reasoning, #2392). */
const SILENCE = "This repeats once a day until a run passes, and a run that passes says nothing.";

/**
 * Decide what the scheduled run stamps and what it says. `summary` is what the command
 * wrote when it decided, or null when no verdict reached this process.
 */
export function decideConfirmLineReport(
  summary: { exit: number; detail: string } | null,
  runUrl: string,
): ConfirmLineReportDecision {
  const look = runUrl.trim() || "Open the burst-counter workflow in the Actions tab.";
  if (summary === null) {
    return {
      concluded: false,
      alert: [
        "Today's shared confirm line proof did not complete, so nothing measured whether the object every isolate shares answers the confirm path.",
        "It takes a lead, queues behind it and reports both verdicts against the live CONFIRM_LINE object. The run itself says how far it got.",
        SILENCE,
        look,
      ].join("\n"),
    };
  }
  const judgement = RUN_JUDGEMENT[summary.exit as ConfirmLineExit];
  if (judgement === undefined) {
    // An ending nothing here judges: reported, and never a verdict (L98).
    return {
      concluded: false,
      alert: [
        `Today's shared confirm line proof ended on exit ${summary.exit}, which nothing here knows how to read, so the line was not judged.`,
        summary.detail.trim() || "The run recorded no detail.",
        SILENCE,
        look,
      ].join("\n"),
    };
  }
  if (judgement.headline === null) return { concluded: judgement.concluded, alert: null };
  return {
    concluded: judgement.concluded,
    alert: [judgement.headline, summary.detail.trim() || `The run recorded no detail (exit ${summary.exit}).`, SILENCE, look].join("\n"),
  };
}
