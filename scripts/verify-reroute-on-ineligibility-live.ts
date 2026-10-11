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
import { loadEnvFiles, envOr } from "./smoke-env.ts";
import { writeRunSummary } from "./lib/run-summary-file.ts";
import { REROUTE_DRILL_EXIT, readDrillReply } from "./lib/reroute-drill-run-outcome.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

/** Longer than the drill can take, its wait on the drain lane included. */
const REPLY_DEADLINE_MS = 5 * 60_000;

const canaryKey = process.env.BOOKING_API_KEY_CANARY ?? "";
// envOr rather than `??`: an unset repo variable reaches the step as an empty string (#1494).
const deployment = envOr(process.env.SLATE_BASE_URL, "https://slate.trypennie.app").replace(/\/$/, "");
const summaryPath = process.env.REROUTE_DRILL_SUMMARY_FILE ?? "";

function end(exit: number, message: string): never {
  const res = writeRunSummary(summaryPath, { exit, detail: message });
  if (summaryPath && !res.written) console.error(`  (the verdict could not be recorded: ${res.why})`);
  if (exit === REROUTE_DRILL_EXIT.passed) console.log(`\nPASSED: ${message}`);
  else console.error(`\nFAILED (exit ${exit}): ${message}`);
  process.exit(exit);
}

if (!canaryKey) {
  end(REROUTE_DRILL_EXIT.misconfigured, "BOOKING_API_KEY_CANARY is not set, so the drill was not asked to run. Put it in .env.local or .dev.vars, or pass it on the command line.");
}
if (!deployment) end(REROUTE_DRILL_EXIT.misconfigured, "SLATE_BASE_URL resolved to nothing, so there is no deployment to ask.");

console.log(`Reroute drill against ${deployment}`);
let res: Response;
try {
  res = await fetch(`${deployment}/api/smoke/demotion-drill`, {
    method: "POST",
    headers: { authorization: `Bearer ${canaryKey}` },
    signal: AbortSignal.timeout(REPLY_DEADLINE_MS),
  });
} catch (err) {
  const timedOut = err instanceof Error && err.name === "TimeoutError";
  end(REROUTE_DRILL_EXIT.noAnswer, timedOut ? `No reply within ${REPLY_DEADLINE_MS / 60_000} minutes.` : err instanceof Error ? err.message : String(err));
}
let body = "";
try {
  body = await res.text();
} catch (err) {
  end(REROUTE_DRILL_EXIT.noAnswer, `The reply body could not be read: ${err instanceof Error ? err.message : String(err)}`);
}
const { exit, detail } = readDrillReply(res.status, body);
end(exit, detail);
