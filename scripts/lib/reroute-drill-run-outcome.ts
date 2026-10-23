/**
 * What the daily reroute drill says, and when it counts as a verdict (#3615).
 *
 * `pnpm verify:reroute-on-ineligibility` asks the deployment to run the drill
 * (`POST /api/smoke/demotion-drill`): a test call is booked on the DRILL bucket, its test advisor
 * loses the drill tier, the real demotion decision, sweep and drain move it, and the real move back
 * returns it. Two decisions a person would make by reading the terminal are written down here:
 *
 * - **Did it reach a MEASURED verdict?** Only this table decides what stamps
 *   `verdict:reroute-drill`. A drill that never reached the pipeline (not seeded, no free time,
 *   busy, a key refused) measured nothing, and stamping it would report the drill concluding while
 *   it was blind (#1394, L98). Every ending where the pipeline itself answered concludes, the bad
 *   ones included: a sweep that did not move the call is a definite reading.
 * - **What to SAY.** A pass says nothing (L36). Everything else is reported with the drill's own
 *   sentence rather than a second copy of its wording here (L41).
 *
 * Bare node safe: imports only from scripts/, because the reporter that uses it runs with no
 * dependency install (#1598). The drill's own reason list lives in `src/lib/booking/demotion-drill.ts`, and
 * `scripts/test-reroute-drill-run-outcome.ts` requires every one of them to have an exit here.
 */

import { proofAlertText } from "./run-summary-file.ts";
import { DRILL_LEASE_WAIT_MS, minutesOf, waitForTestAdvisors } from "./test-advisor-lease-wait.ts";

/** Every way the command can end, on its own code (L11). */
export const REROUTE_DRILL_EXIT = {
  passed: 0,
  /** No base URL or no key here, so nothing was asked. */
  misconfigured: 1,
  /** The request never got a reply. */
  noAnswer: 2,
  /** Something replied with a shape the endpoint never produces, or a reason nothing here knows. */
  unreadableReply: 3,
  /** The deployment rejected the key. */
  unauthorized: 4,
  /** The deployment has no canary key configured, so the endpoint is disabled. */
  notConfigured: 5,
  /** The deployment does not carry the endpoint. */
  endpointMissing: 6,
  /** Another drill was running. */
  busy: 7,
  /** The DRILL bucket or its two test advisors are not set up. */
  notSeeded: 8,
  /** The DRILL bucket offered no free time to book on. */
  noFreeSlot: 9,
  /** The booking path refused the test call. */
  bookingRefused: 10,
  /** The test call landed on somebody outside the drill. */
  bookedOutsideDrill: 11,
  /** The demotion decision did not stamp the narrowing. */
  didNotStamp: 12,
  /** Past the debounce the decision did not sweep. */
  didNotSweep: 13,
  /** The sweep moved the call without recording what changed. */
  changeNotRecorded: 14,
  /** The sweep queued no call. */
  sweepQueuedNothing: 15,
  /** The sweep ran and the call did not move. */
  didNotMove: 16,
  /** The call moved and no audit row says why. */
  noAudit: 17,
  /** The move back refused. */
  moveBackRefused: 18,
  /** The move back answered done and the call is not back. */
  didNotMoveBack: 19,
  /** The call went back and is not pinned. */
  notPinned: 20,
  /** The drill could not cancel its call or restore its advisor. */
  cleanupFailed: 21,
  /** A step threw. */
  errored: 22,
  /** The drill measured the pipeline (a pass or a definite failure) and THEN could not clean up. */
  cleanupFailedAfterVerdict: 23,
  /** #4180: the smoke canary held the shared test advisors past the drill's whole wait, so the
   *  drill never started. NOT MEASURED, and never the did-not-move a collision used to cause. */
  testAdvisorsHeld: 24,
} as const;

export type RerouteDrillExit = (typeof REROUTE_DRILL_EXIT)[keyof typeof REROUTE_DRILL_EXIT];

/** The drill's reasons, as the endpoint answers them, to their exits. */
export const REASON_EXIT: Record<string, RerouteDrillExit> = {
  passed: REROUTE_DRILL_EXIT.passed,
  busy: REROUTE_DRILL_EXIT.busy,
  "test-advisors-held": REROUTE_DRILL_EXIT.testAdvisorsHeld,
  "not-seeded": REROUTE_DRILL_EXIT.notSeeded,
  "no-free-slot": REROUTE_DRILL_EXIT.noFreeSlot,
  "booking-refused": REROUTE_DRILL_EXIT.bookingRefused,
  "booked-outside-drill": REROUTE_DRILL_EXIT.bookedOutsideDrill,
  "did-not-stamp": REROUTE_DRILL_EXIT.didNotStamp,
  "did-not-sweep": REROUTE_DRILL_EXIT.didNotSweep,
  "change-not-recorded": REROUTE_DRILL_EXIT.changeNotRecorded,
  "sweep-queued-nothing": REROUTE_DRILL_EXIT.sweepQueuedNothing,
  "did-not-move": REROUTE_DRILL_EXIT.didNotMove,
  "no-audit": REROUTE_DRILL_EXIT.noAudit,
  "move-back-refused": REROUTE_DRILL_EXIT.moveBackRefused,
  "did-not-move-back": REROUTE_DRILL_EXIT.didNotMoveBack,
  "not-pinned": REROUTE_DRILL_EXIT.notPinned,
  "cleanup-failed": REROUTE_DRILL_EXIT.cleanupFailed,
  errored: REROUTE_DRILL_EXIT.errored,
};

/** Read the endpoint's reply into an exit and the drill's own sentence. */
export function readDrillReply(status: number, body: string): { exit: RerouteDrillExit; detail: string } {
  if (status === 401) return { exit: REROUTE_DRILL_EXIT.unauthorized, detail: "The deployment refused the canary key." };
  if (status === 503) return { exit: REROUTE_DRILL_EXIT.notConfigured, detail: "The deployment has no canary key configured." };
  if (status === 404) return { exit: REROUTE_DRILL_EXIT.endpointMissing, detail: "The deployment does not carry the drill's endpoint yet." };
  if (status !== 200) return { exit: REROUTE_DRILL_EXIT.unreadableReply, detail: `The endpoint answered HTTP ${status}.` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { exit: REROUTE_DRILL_EXIT.unreadableReply, detail: "The reply was not the endpoint's JSON." };
  }
  const r = parsed as { reason?: unknown; detail?: unknown } | null;
  // An OWN property only: a reason named like an inherited one ("toString") must read as
  // unknown, never borrow whatever the prototype holds.
  let exit = typeof r?.reason === "string" && Object.hasOwn(REASON_EXIT, r.reason) ? REASON_EXIT[r.reason] : undefined;
  // A cleanup that failed AFTER the drill measured the pipeline keeps that measurement, or a real
  // broken pipeline would later page as a drill that never concluded.
  if (exit === REROUTE_DRILL_EXIT.cleanupFailed) {
    const ended = (parsed as { endedAs?: unknown } | null)?.endedAs;
    const endedExit = typeof ended === "string" && Object.hasOwn(REASON_EXIT, ended) ? REASON_EXIT[ended] : undefined;
    if (endedExit !== undefined && RUN_JUDGEMENT[endedExit].concluded) exit = REROUTE_DRILL_EXIT.cleanupFailedAfterVerdict;
  }
  if (exit === undefined) {
    return { exit: REROUTE_DRILL_EXIT.unreadableReply, detail: `The endpoint answered a reason nothing here knows (${String(r?.reason)}).` };
  }
  return { exit, detail: typeof r?.detail === "string" ? r.detail : "" };
}

interface RunJudgement {
  concluded: boolean;
  /** The opening sentence, or null when there is nothing worth saying. */
  headline: string | null;
}

const BLIND = "so the reroute pipeline was not exercised today.";
const BROKEN = "If the switch is on, real demoted advisors' calls are affected the same way.";

export const RUN_JUDGEMENT: Record<RerouteDrillExit, RunJudgement> = {
  [REROUTE_DRILL_EXIT.passed]: { concluded: true, headline: null },
  [REROUTE_DRILL_EXIT.misconfigured]: { concluded: false, headline: `Today's reroute drill is missing the key or the base URL it needs, ${BLIND}` },
  [REROUTE_DRILL_EXIT.noAnswer]: { concluded: false, headline: `Today's reroute drill got no reply from the deployment, ${BLIND}` },
  [REROUTE_DRILL_EXIT.unreadableReply]: { concluded: false, headline: `Today's reroute drill got a reply it could not read, ${BLIND}` },
  [REROUTE_DRILL_EXIT.unauthorized]: { concluded: false, headline: `The deployment refused the key today's reroute drill sends, ${BLIND}` },
  [REROUTE_DRILL_EXIT.notConfigured]: { concluded: false, headline: `The deployment has no canary key configured, ${BLIND}` },
  [REROUTE_DRILL_EXIT.endpointMissing]: { concluded: false, headline: `The running deployment does not carry the reroute drill's endpoint yet, ${BLIND}` },
  [REROUTE_DRILL_EXIT.busy]: { concluded: false, headline: `Another reroute drill was already running, ${BLIND}` },
  [REROUTE_DRILL_EXIT.notSeeded]: {
    concluded: false,
    headline: `The DRILL test bucket or its two test advisors are not set up, ${BLIND} Run the smoke seed (scripts/seed-smoke-test.ts) to set them up.`,
  },
  [REROUTE_DRILL_EXIT.noFreeSlot]: { concluded: false, headline: `The DRILL test bucket offered no free time to book the test call on, ${BLIND}` },
  [REROUTE_DRILL_EXIT.bookingRefused]: { concluded: false, headline: `The booking path refused the reroute drill's test call, ${BLIND}` },
  [REROUTE_DRILL_EXIT.bookedOutsideDrill]: {
    concluded: false,
    headline: `The reroute drill's test call landed on somebody outside the drill, so the DRILL bucket is not isolated. Nobody was demoted and the call was cancelled, ${BLIND}`,
  },
  [REROUTE_DRILL_EXIT.didNotStamp]: { concluded: true, headline: `The reroute drill demoted a test advisor and the demotion decision did not record it. ${BROKEN}` },
  [REROUTE_DRILL_EXIT.didNotSweep]: { concluded: true, headline: `The reroute drill's demotion was recorded and never swept once past the wait. ${BROKEN}` },
  [REROUTE_DRILL_EXIT.changeNotRecorded]: {
    concluded: true,
    headline: "The reroute drill's sweep moved the call without recording what changed in Twilio, so the audit and the move back screen cannot say why a call moved.",
  },
  [REROUTE_DRILL_EXIT.sweepQueuedNothing]: { concluded: true, headline: `The reroute drill's sweep queued no call to move, so a demotion moved nobody. ${BROKEN}` },
  [REROUTE_DRILL_EXIT.didNotMove]: { concluded: true, headline: `The reroute drill's sweep ran and the test call was not moved to the other test advisor. ${BROKEN}` },
  [REROUTE_DRILL_EXIT.noAudit]: { concluded: true, headline: "The reroute drill's call moved and no audit row says why, so a real move would leave no record." },
  [REROUTE_DRILL_EXIT.moveBackRefused]: { concluded: true, headline: "The reroute drill could not move its call back, so the undo on a booking's page would refuse too." },
  [REROUTE_DRILL_EXIT.didNotMoveBack]: { concluded: true, headline: "The reroute drill's move back answered done and the call did not go back." },
  [REROUTE_DRILL_EXIT.notPinned]: {
    concluded: true,
    headline: "The reroute drill's moved back call is not pinned to its advisor, so the next sweep would move a call an admin deliberately kept.",
  },
  [REROUTE_DRILL_EXIT.cleanupFailed]: {
    concluded: false,
    headline:
      "The reroute drill could not clean up after itself, so a test call may still be booked or a test advisor may still be missing the drill tier. Tomorrow's drill will refuse until it is put right.",
  },
  [REROUTE_DRILL_EXIT.errored]: { concluded: false, headline: `The reroute drill failed in a step before it could judge it, ${BLIND}` },
  [REROUTE_DRILL_EXIT.cleanupFailedAfterVerdict]: {
    concluded: true,
    headline:
      "The reroute drill judged the pipeline and then could not clean up after itself, so a test call may still be booked or a test advisor may still be missing the drill tier. What it judged is below.",
  },
  // #4180: not a fault of the reroute pipeline, which was never asked. Said in the same blind
  // wording as a drill that could not start for any other reason, so nobody reads it as broken.
  [REROUTE_DRILL_EXIT.testAdvisorsHeld]: {
    concluded: false,
    headline: `Another run (usually the smoke canary) held the two smoke test advisors for the reroute drill's whole ${minutesOf(DRILL_LEASE_WAIT_MS)} minute wait, so the drill did not start and the reroute pipeline was not exercised today. This is not a reroute fault.`,
  },
};

/**
 * Ask the deployment to run the drill, asking again while the smoke canary holds the shared test
 * advisors (#4180), up to the drill's bound. `ask` sends one request and reads its reply into an
 * exit; every exit but the held lease ends the wait at once, since nothing else is fixed by
 * waiting. Past the bound the drill is NOT MEASURED, on its own exit.
 */
export async function askDrillWhenAdvisorsFree(
  ask: () => Promise<{ exit: RerouteDrillExit; detail: string }>,
  deps: { now(): number; sleep(ms: number): Promise<void>; boundMs?: number; intervalMs?: number },
): Promise<{ exit: RerouteDrillExit; detail: string }> {
  const boundMs = deps.boundMs ?? DRILL_LEASE_WAIT_MS;
  const waited = await waitForTestAdvisors(
    async () => {
      const reply = await ask();
      return reply.exit === REROUTE_DRILL_EXIT.testAdvisorsHeld ? { busy: true as const } : { busy: false as const, value: reply };
    },
    { now: deps.now, sleep: deps.sleep, boundMs, intervalMs: deps.intervalMs },
  );
  if (waited.kind === "answered") return waited.value;
  return {
    exit: REROUTE_DRILL_EXIT.testAdvisorsHeld,
    detail:
      `The smoke test advisors were still held by another run after ${minutesOf(boundMs)} minutes (${waited.tries} asks), ` +
      "so the drill did not start and today's run is not measured.",
  };
}

const SILENCE = "This repeats once a day until a run passes, and a run that passes says nothing.";

/** Decide what the scheduled run stamps and what it says. `summary` is null when no verdict reached this process. */
export function decideRerouteDrillReport(
  summary: { exit: number; detail: string } | null,
  runUrl: string,
): { concluded: boolean; alert: string | null } {
  const look = runUrl.trim() || "Open the burst-counter workflow in the Actions tab.";
  if (summary === null) {
    return {
      concluded: false,
      alert: [`Today's reroute drill did not complete, ${BLIND}`, "The run itself says how far it got.", SILENCE, look].join("\n"),
    };
  }
  const judgement = RUN_JUDGEMENT[summary.exit as RerouteDrillExit];
  if (judgement === undefined) {
    return {
      concluded: false,
      alert: [
        `Today's reroute drill ended on exit ${summary.exit}, which nothing here knows how to read, ${BLIND}`,
        summary.detail.trim() || "The run recorded no detail.",
        SILENCE,
        look,
      ].join("\n"),
    };
  }
  if (judgement.headline === null) return { concluded: judgement.concluded, alert: null };
  return {
    concluded: judgement.concluded,
    alert: proofAlertText(judgement.headline, summary, SILENCE, look),
  };
}
