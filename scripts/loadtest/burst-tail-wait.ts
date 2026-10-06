// Hold the burst tail open until the last burst's lines are in (#3416).
//
// The workflow's burst-tail job starts `wrangler tail` in the background, runs this,
// and stops the tail when this returns, whatever it returned. The decision is pure
// and pinned offline (`burstTailWait` in book-plan.ts, scripts/test-loadtest-burst-tail.ts):
// the stop is DERIVED from the plan's last moment, never a constant somebody picked.
//
// Exits:
//   0  the tail covered every burst
//   1  the plan or the ceiling could not be read, so nothing was waited for
//   3  the tail could not cover every burst (it started after the first moment, or its
//      ceiling ends before the stop); it waited for what it could and says which
//
// Run:
//   BURST_PLAN='<the setup step's burst_plan>' BURST_TAIL_CEILING_MINUTES=10 \
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/loadtest/burst-tail-wait.ts
import { burstTailWait } from "./book-plan.ts";

const decision = burstTailWait({
  rawPlan: process.env.BURST_PLAN ?? "",
  rawCeilingMinutes: process.env.BURST_TAIL_CEILING_MINUTES ?? "",
  nowMs: Date.now(),
});
if (!decision.ok) {
  console.error(`FAILED: ${decision.why}.`);
  process.exit(1);
}
for (const line of decision.lines) console.log(line);
await new Promise((resolve) => setTimeout(resolve, decision.waitMs));
if (decision.exit !== 0) {
  console.error("FAILED: the burst tail did not cover every burst; the judge reports which requests it could match.");
}
process.exit(decision.exit);
