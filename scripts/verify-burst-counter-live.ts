// Live positive control for the burst counter (#1564). Run:
//   pnpm verify:burst-counter
//
// WHY THIS IS NOT A UNIT TEST. The monitor lane reports the burst counter missing from a
// deployment (#1558) by resolving `BURST_LIMITER` as a property read, and stops there
// deliberately: asking the object whether it ANSWERS would create it, spend a subrequest out of
// the invocation four cron lanes share, and give it an alarm to clean up on every tick forever.
// The cost is that a counter which is bound but unreachable reads as fine, and stays that way
// until one caller crosses the escalation threshold, which before cutover could be months away.
// That is the #1394 family: a detector that has never once concluded. Injected fakes cannot
// close it either, because a fake agrees with our assumption about the Durable Object by
// construction (L52). Only a real report to the real object can.
//
// WHAT IT PROVES. It reports a FIXED monitor key to the live `BURST_LIMITER` object, reads the
// count back, reports it again, and requires the count to have RISEN inside one window. Both
// halves, or it proves nothing (L1): a counter hard wired to a single answer, or one that
// replies without counting, satisfies a check that only asks whether it replied. Nothing else
// is a pass, and every way of learning nothing exits non-zero on its own code (L98, L11).
//
// It judges on the COUNT and never on a substring of the output, because every failure the
// deployment can report quotes the same binding name the success case does (L156, L184).
//
// WHAT IT WRITES. One count, against a key no real caller's `burstKey` can produce (the reason
// it cannot is in `src/lib/monitor/burst-counter-probe.ts`), on an object whose own alarm
// deletes it two windows after the last report. Nothing a lead's traffic is ever judged against.
//
// It talks to the LIVE deployment, so it is deliberately not named `test-*.ts`: that glob is
// the offline unit suite. Its decision logic is pinned offline by
// `scripts/test-burst-counter-live-control.ts`.
//
// Needs BOOKING_API_KEY_CANARY (from .env.local / .dev.vars, or the environment).
//
// It runs DAILY on `.github/workflows/burst-counter.yml` (#2392) as well as by hand. The rule to
// re-run it after any change to the burst path lived only in AGENTS.md, and the path moved five
// times with nobody running it (L27). On that lane it writes BURST_SUMMARY_FILE when it decides,
// which is how the lane tells a verdict apart from a run that died before reaching one: node exits
// 1 on an uncaught throw and 1 is also a real ending here, so an exit code alone makes those one
// message (L11, L98). A hand run sets no path and writes nothing.
//
// Env overrides:
//   SLATE_BASE_URL     the deployment to ask (default https://slate.trypennie.app)
//   BOOKING_API_KEY_CANARY    the Bearer key the deployment accepts
//   BURST_SUMMARY_FILE where to record the verdict for the scheduled lane (unset: nowhere)
import { loadEnvFiles, envOr } from "./smoke-env.ts";
import type { ProbeOutcome } from "./lib/burst-counter-live-control.ts";
// Statically imported, unlike the two below: it reads no environment as it loads (only node:fs),
// and the very first refusal below happens before those dynamic imports are reached.
import { writeBurstSummary } from "./lib/burst-counter-run-outcome.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

// Imported after the env files are loaded, like the other live scripts here: a static import is
// hoisted above the call above, so anything that reads the environment as it loads would read it
// unset. Type-only imports are erased and are safe to state at the top.
const { VERIFY_EXIT, readProbeOutcome, judgeBurstCounterProbe, msToWaitForWindow } = await import(
  "./lib/burst-counter-live-control.ts"
);
const { BURST_VERIFY_KEY } = await import("@/lib/monitor/burst-counter-probe");
const { BURST_WINDOW_MS } = await import("@/lib/rate-limit-burst");

// envOr, not `??`: a workflow wiring SLATE_BASE_URL from an unset repo variable sets it to the
// empty string, and `??` would take that as the value (#1494).
const BASE = envOr(process.env.SLATE_BASE_URL, "https://slate.trypennie.app").replace(/\/$/, "");
const KEY = process.env.BOOKING_API_KEY_CANARY ?? "";

/** How close to a window boundary is too close to start. Two reports and their round trips are
 *  well under a second; five seconds is that with room to spare, and it costs nothing on the
 *  other 55 seconds of every minute. */
const START_MARGIN_MS = 5_000;

/** Where the scheduled lane reads this run's verdict. Empty on a hand run. */
const SUMMARY_FILE = process.env.BURST_SUMMARY_FILE ?? "";

/** Record what was decided, for a lane that cannot read the terminal. Never throws: a failed
 *  write leaves the lane reporting a run that did not complete, which is louder than the truth
 *  rather than quieter (L95). */
function record(exit: number, detail: string): void {
  const res = writeBurstSummary(SUMMARY_FILE, { exit, detail });
  if (SUMMARY_FILE && !res.written) console.error(`  (the verdict could not be recorded: ${res.why})`);
}

function fail(exitCode: number, why: string): never {
  record(exitCode, why);
  console.error(`\nFAILED: ${why}`);
  process.exit(exitCode);
}

if (!KEY) {
  fail(
    VERIFY_EXIT.misconfigured,
    "BOOKING_API_KEY_CANARY is not set, so nothing was attempted. Put it in .env.local or .dev.vars, " +
      "or pass it on the command line.",
  );
}
if (!BASE) {
  fail(VERIFY_EXIT.misconfigured, "SLATE_BASE_URL resolved to nothing, so there is no deployment to ask.");
}

async function report(): Promise<ProbeOutcome> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/smoke/burst-counter`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
    });
  } catch (err) {
    return { kind: "no-answer", detail: err instanceof Error ? err.message : String(err) };
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    return {
      kind: "no-answer",
      detail: `the reply body could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return readProbeOutcome(res.status, text);
}

console.log(`Burst counter live control against ${BASE}, key ${BURST_VERIFY_KEY}`);

// Not starting in the last moments of a window. A run that straddles a boundary gets two
// readings from two different counts, which is a refusal nobody can act on.
const wait = msToWaitForWindow(Date.now(), BURST_WINDOW_MS, START_MARGIN_MS);
if (wait > 0) {
  console.log(`  waiting ${(wait / 1000).toFixed(1)}s for the next window, so both reports land in one`);
  await new Promise((resolve) => setTimeout(resolve, wait + 50));
}

const first = await report();
console.log(`  first report: ${first.kind}${first.kind === "counted" ? ` count=${first.count}` : ""}`);
const second = await report();
console.log(`  second report: ${second.kind}${second.kind === "counted" ? ` count=${second.count}` : ""}`);

const verdict = judgeBurstCounterProbe(first, second);
if (!verdict.ok) fail(verdict.exitCode, verdict.message);

record(VERIFY_EXIT.passed, verdict.message);
console.log(`\nPASSED: ${verdict.message}`);
