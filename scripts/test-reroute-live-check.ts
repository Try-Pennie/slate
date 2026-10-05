// #3251: the pure decisions behind `pnpm verify:reroute-live`, pinned with no
// network and no clock, so the live command's refusals are tested where it cannot
// run.
//
// Run: node --experimental-strip-types scripts/test-reroute-live-check.ts
import { REROUTE_LIVE_OUTCOMES, candidateStarts, inCanaryWindow, startIsClear } from "./lib/reroute-live-check.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const at = (hhmm: string, day = "2031-03-04") => Date.parse(`${day}T${hhmm}:00Z`);
const MIN = 60_000;

// --- every outcome has its own exit code and its own message (L11) ----------------------------
{
  const outcomes = Object.values(REROUTE_LIVE_OUTCOMES);
  eq(new Set(outcomes.map((o) => o.exit)).size, outcomes.length, "no two outcomes share an exit code");
  eq(new Set(outcomes.map((o) => o.says)).size, outcomes.length, "no two outcomes share a message");
  eq(REROUTE_LIVE_OUTCOMES.proven.exit, 0, "only proof exits 0");
  assert(outcomes.filter((o) => o.exit === 0).length === 1, "and nothing else does (L98)");
  assert(!/[\u2014\u2013]/.test(JSON.stringify(outcomes)), "no dashes in any message");
}

// --- the canary's window, both edges both sides --------------------------------------------------
for (const [hhmm, inside] of [
  ["14:26", false], ["14:27", true], ["14:30", true], ["14:37", true], ["14:38", false],
  ["14:56", false], ["14:57", true], ["15:00", true], ["15:07", true], ["15:08", false], ["15:15", false],
] as const) {
  eq(inCanaryWindow(at(hhmm)), inside, `${hhmm} is ${inside ? "inside" : "outside"} the canary's window`);
}

// --- the starts tried ----------------------------------------------------------------------------
{
  const now = at("09:13");
  const starts = candidateStarts(now);
  eq(new Date(starts[0]).toISOString(), "2031-03-06T15:00:00.000Z", "the first is two days ahead at 15:00 UTC");
  eq(new Date(starts[starts.length - 1]).toISOString(), "2031-03-11T20:40:00.000Z", "the last is seven days ahead at 20:40 UTC");
  assert(starts.every((s) => (s / MIN) % 20 === 0), "every start is on the twenty minute grid");
  assert(starts.every((s, i) => i === 0 || s > starts[i - 1]), "in order, earliest first");
  eq(candidateStarts(at("23:59")).length, starts.length, "the same count whatever the hour of day");
}

// --- a start is clear only with room for every call and the shared event type's buffers ---------
{
  // smoketest@ takes calls at T (with ten minute buffers) and the public test bucket's call at T+60;
  // smoketest2@ takes one at T.
  const T = at("16:00");
  const busy = (from: string, to: string) => [{ startMs: at(from), endMs: at(to) }];
  assert(startIsClear(T, [], []), "nothing busy is clear");
  assert(!startIsClear(T, busy("17:10", "17:15"), []), "smoketest@ busy during the public test bucket's call is not");
  assert(startIsClear(T, busy("17:20", "18:00"), []), "control: busy from the end of that call is clear");
  assert(!startIsClear(T, busy("15:45", "15:55"), []), "smoketest@ busy inside the first call's before buffer is not");
  assert(startIsClear(T, busy("15:00", "15:50"), []), "control: busy until the buffer starts is clear");
  assert(!startIsClear(T, [], busy("16:25", "16:35")), "smoketest2@ busy inside the call's after buffer is not");
  assert(startIsClear(T, [], busy("16:30", "17:30")), "control: smoketest2@ busy only from the end of that buffer is clear");
  assert(!startIsClear(T, [], busy("15:45", "15:55")), "smoketest2@ busy inside the before buffer is not");
}

finish();
