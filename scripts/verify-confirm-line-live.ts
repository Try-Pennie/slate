// Live positive control for the shared confirm line (#3340). Run:
//   pnpm verify:confirm-line
//
// WHY THIS IS NOT A UNIT TEST. The confirm path falls back to the isolate's own line
// whenever the shared one cannot be used (#3325), so a CONFIRM_LINE object that is bound
// and does not answer reads as healthy until a crowd for one slot arrives and every isolate
// forms its own line again (load run 37333201026). Fakes cannot close that: a fake agrees
// with our assumptions about the object by construction (L52). Only the real object can.
//
// WHAT IT PROVES. It asks the deployment to run the probe (`POST /api/smoke/confirm-line`),
// which drives the confirm path's OWN client against the real object: a follower refused
// after a full verdict, handed the lead after a not full one, freed behind a lead nobody
// acknowledged, and nothing left held afterwards; and (#3460) the pool grouping directory
// stores, keeps the newest, and holds a live grouping a cold server would install; and
// (#3481) the probe's own directory, left idle until the platform puts it to sleep, hands
// its grouping back from storage. Only every check passing is a pass, and every other
// ending exits on its own code (L98, L11). The rules are pinned offline by
// `scripts/test-confirm-line-live-control.ts`, against the real object host.
//
// WHAT IT CANNOT PROVE. Every participant runs in the one invocation that serves the
// request, so a pass cannot show that two isolates reach the SAME object. Only a load run,
// whose confirms spread across isolates, can show that.
//
// WHAT IT WRITES. Leads, tickets and verdicts on the verification group's object only, on
// instants minted per run, and the probe checks it left nothing held; and groupings on its
// own verification directory. The live pool grouping directory is only read. No booking, no row.
//
// It talks to the LIVE deployment, so it is not named `test-*.ts`. It runs daily on
// `.github/workflows/burst-counter.yml` beside the burst counter's proof, and there it
// writes CONFIRM_LINE_SUMMARY_FILE when it decides, so the reporter can tell a verdict from
// a run that died before one (an uncaught throw also exits 1). A hand run sets no path.
//
// Env:
//   BOOKING_API_KEY_CANARY     the canary's Bearer key (from .env.local / .dev.vars, or the environment)
//   SLATE_BASE_URL             the deployment to ask (default https://slate.trypennie.app)
//   CONFIRM_LINE_SUMMARY_FILE  where the scheduled lane reads the verdict (unset: nowhere)
import { loadEnvFiles, canaryProofTarget } from "./smoke-env.ts";
import { recordRunSummary } from "./lib/run-summary-file.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

// After the env files load, like the other live scripts: a static import is hoisted above
// that call, and anything reading the environment as it loads would read it unset.
// REPLY_DEADLINE_MS lives beside the decision logic, where the offline test holds the
// slowest planted run against it.
const { CONFIRM_LINE_EXIT, REPLY_DEADLINE_MS, readConfirmLineOutcome, judgeConfirmLineProbe } = await import("./lib/confirm-line-live-control.ts");
type Outcome = ReturnType<typeof readConfirmLineOutcome>;

// An unset repo variable reaches the step as an empty string (#1494), which canaryProofTarget
// treats as unset.
const { canaryKey, deployment } = canaryProofTarget(process.env.BOOKING_API_KEY_CANARY, process.env.SLATE_BASE_URL);
const summaryPath = process.env.CONFIRM_LINE_SUMMARY_FILE ?? "";

/** Record the verdict for the lane, print it, and exit on its code. */
function end(exit: number, message: string): never {
  recordRunSummary(summaryPath, { exit, detail: message });
  if (exit === CONFIRM_LINE_EXIT.passed) console.log(`\nPASSED: ${message}`);
  else console.error(`\nFAILED: ${message}`);
  process.exit(exit);
}

if (!canaryKey) {
  end(CONFIRM_LINE_EXIT.misconfigured, "BOOKING_API_KEY_CANARY is not set, so the object was asked nothing. Put it in .env.local or .dev.vars, or pass it on the command line.");
}
if (!deployment) end(CONFIRM_LINE_EXIT.misconfigured, "SLATE_BASE_URL resolved to nothing, so there is no deployment to ask.");

async function ask(): Promise<Outcome> {
  let res: Response;
  try {
    res = await fetch(`${deployment}/api/smoke/confirm-line`, {
      method: "POST",
      headers: { authorization: `Bearer ${canaryKey}` },
      signal: AbortSignal.timeout(REPLY_DEADLINE_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return { kind: "no-answer", detail: timedOut ? `no reply within ${REPLY_DEADLINE_MS / 1000}s` : err instanceof Error ? err.message : String(err) };
  }
  try {
    return readConfirmLineOutcome(res.status, await res.text());
  } catch (err) {
    return { kind: "no-answer", detail: `the reply body could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

console.log(`Shared confirm line live control against ${deployment}`);
const outcome = await ask();
console.log(`  endpoint answered: ${outcome.kind}`);
if (outcome.kind === "checked") {
  for (const [check, result] of Object.entries(outcome.checks)) console.log(`  ${check}: ${result.outcome}, ${result.detail}`);
}
const verdict = judgeConfirmLineProbe(outcome);
end(verdict.ok ? CONFIRM_LINE_EXIT.passed : verdict.exitCode, verdict.message);
