// Live proof of the reroute on ineligibility (#3615). Run:
//   pnpm verify:reroute-on-ineligibility
//
// WHY THIS IS NOT A UNIT TEST. The automatic reroute acts rarely, only when Twilio narrows
// somebody, so a pipeline that had silently stopped would look exactly like a quiet month (L557,
// #1394), and a fake agrees with our assumptions about the database, the reassign and the calendars
// by construction (L52). Only the real pieces can prove it.
//
// WHAT IT PROVES. It asks the deployment to run the drill (`POST /api/smoke/demotion-drill`), on
// the DRILL test bucket and the two smoke test advisors only: a test call is booked, its advisor
// loses the drill tier, the real demotion decision, sweep and drain move it to the other advisor
// with what changed recorded and audited, and the real move back returns it and pins it. The call
// is always cancelled and the advisor restored. Only all of that is a pass; every other ending exits
// on its own code (L98, L11). The table is `scripts/lib/reroute-drill-run-outcome.ts`, pinned by
// `scripts/test-reroute-drill-run-outcome.ts`; the drill by `scripts/test-demotion-drill.ts`.
//
// THE SHARED TEST ADVISORS (#4180). The smoke canary's full pass books on the same two advisors,
// so the endpoint holds one lease over them for the drill's run. While the canary holds it the
// endpoint answers `test-advisors-held` without starting, and this asks again every 15 seconds
// for up to 12 minutes (longer than the lease's TTL, so even a crashed canary's claim lapses
// inside the wait), then ends NOT MEASURED on exit 24, which stamps nothing.
//
// WHAT IT WRITES. One test call (cancelled again), one sweep and its item, two audit rows (hidden
// from the audit log, which leaves out test advisors), and the drill tier taken off and put back on
// one test advisor. Nothing about a real advisor or a real lead.
//
// It talks to the LIVE deployment, so it is not named `test-*.ts`. It runs daily on
// `.github/workflows/burst-counter.yml`, and there it writes REROUTE_DRILL_SUMMARY_FILE when it
// decides, so the reporter can tell a verdict from a run that died before one. A hand run sets no path.
//
// Env:
//   BOOKING_API_KEY_CANARY       the canary's Bearer key (from .env.local / .dev.vars, or the environment)
//   SLATE_BASE_URL               the deployment to ask (default https://slate.trypennie.app)
//   REROUTE_DRILL_SUMMARY_FILE   where the scheduled lane reads the verdict (unset: nowhere)
import { loadEnvFiles, canaryProofTarget } from "./smoke-env.ts";
import { recordRunSummary } from "./lib/run-summary-file.ts";
import { REROUTE_DRILL_EXIT, askDrillWhenAdvisorsFree, readDrillReply, type RerouteDrillExit } from "./lib/reroute-drill-run-outcome.ts";
import { realSleep } from "./lib/test-advisor-lease-wait.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

/** Longer than the drill can take, its wait on the drain lane included. */
const REPLY_DEADLINE_MS = 5 * 60_000;

// An unset repo variable reaches the step as an empty string (#1494), which canaryProofTarget
// treats as unset.
const { canaryKey, deployment } = canaryProofTarget(process.env.BOOKING_API_KEY_CANARY, process.env.SLATE_BASE_URL);
const summaryPath = process.env.REROUTE_DRILL_SUMMARY_FILE ?? "";

function end(exit: number, message: string): never {
  recordRunSummary(summaryPath, { exit, detail: message });
  if (exit === REROUTE_DRILL_EXIT.passed) console.log(`\nPASSED: ${message}`);
  else if (exit === REROUTE_DRILL_EXIT.testAdvisorsHeld) console.error(`\nNOT MEASURED (exit ${exit}): ${message}`);
  else console.error(`\nFAILED (exit ${exit}): ${message}`);
  process.exit(exit);
}

if (!canaryKey) {
  end(REROUTE_DRILL_EXIT.misconfigured, "BOOKING_API_KEY_CANARY is not set, so the drill was not asked to run. Put it in .env.local or .dev.vars, or pass it on the command line.");
}
if (!deployment) end(REROUTE_DRILL_EXIT.misconfigured, "SLATE_BASE_URL resolved to nothing, so there is no deployment to ask.");

console.log(`Reroute drill against ${deployment}`);

/** One ask of the endpoint, read into an exit. Never throws: no reply is its own exit. */
async function askOnce(): Promise<{ exit: RerouteDrillExit; detail: string }> {
  let res: Response;
  try {
    res = await fetch(`${deployment}/api/smoke/demotion-drill`, {
      method: "POST",
      headers: { authorization: `Bearer ${canaryKey}` },
      signal: AbortSignal.timeout(REPLY_DEADLINE_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return {
      exit: REROUTE_DRILL_EXIT.noAnswer,
      detail: timedOut ? `No reply within ${REPLY_DEADLINE_MS / 60_000} minutes.` : err instanceof Error ? err.message : String(err),
    };
  }
  let body = "";
  try {
    body = await res.text();
  } catch (err) {
    return { exit: REROUTE_DRILL_EXIT.noAnswer, detail: `The reply body could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  const reply = readDrillReply(res.status, body);
  if (reply.exit === REROUTE_DRILL_EXIT.testAdvisorsHeld) console.log("The smoke canary holds the test advisors; asking again shortly.");
  return reply;
}

// #4180: while the smoke canary holds the shared test advisors the endpoint answers so without
// starting, and this asks again up to DRILL_LEASE_WAIT_MS, then ends NOT MEASURED (exit 24).
const { exit, detail } = await askDrillWhenAdvisorsFree(askOnce, { now: Date.now, sleep: realSleep });
end(exit, detail);
