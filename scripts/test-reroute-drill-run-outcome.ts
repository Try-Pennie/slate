// #3615: what the daily reroute drill says, and when it counts as a verdict. Pure, driven here.
//
// The `verdict:reroute-drill` stamp may be written only on a run that EXERCISED the reroute
// pipeline, whichever way it went: a drill that could not start (not seeded, no free time, busy)
// measured nothing, and stamping it would report the drill concluding while it was blind (L98,
// #1394). Every ending speaks except a pass (L36), and in the drill's own words.
import {
  REROUTE_DRILL_EXIT,
  REASON_EXIT,
  RUN_JUDGEMENT,
  decideRerouteDrillReport,
  readDrillReply,
} from "./lib/reroute-drill-run-outcome.ts";
import { DRILL_REASONS } from "../src/lib/booking/demotion-drill.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DASH = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);

// Every reason the drill can answer has its own exit, and no two endings share one (L11).
for (const reason of DRILL_REASONS) assert(REASON_EXIT[reason] !== undefined, `the drill's ${reason} has an exit code`);
const codes = Object.values(REROUTE_DRILL_EXIT);
eq(new Set(codes).size, codes.length, "every ending exits on its own code");
for (const code of codes) assert(RUN_JUDGEMENT[code as keyof typeof RUN_JUDGEMENT] !== undefined, `exit ${code} is judged`);

// Reading the endpoint's reply.
eq(readDrillReply(200, JSON.stringify({ reason: "passed", detail: "ok" })), { exit: REROUTE_DRILL_EXIT.passed, detail: "ok" }, "a pass reads as a pass");
eq(readDrillReply(200, JSON.stringify({ reason: "did-not-move", detail: "x" })).exit, REROUTE_DRILL_EXIT.didNotMove, "each reason maps to its exit");
eq(readDrillReply(401, "").exit, REROUTE_DRILL_EXIT.unauthorized, "a refused key");
eq(readDrillReply(503, "").exit, REROUTE_DRILL_EXIT.notConfigured, "no key configured on the deployment");
eq(readDrillReply(404, "").exit, REROUTE_DRILL_EXIT.endpointMissing, "a deployment older than the endpoint");
eq(readDrillReply(200, "<html>").exit, REROUTE_DRILL_EXIT.unreadableReply, "a body that is not the endpoint's");
eq(readDrillReply(200, JSON.stringify({ reason: "something-new", detail: "x" })).exit, REROUTE_DRILL_EXIT.unreadableReply, "a reason nothing here knows is never read as a pass");
eq(readDrillReply(500, "boom").exit, REROUTE_DRILL_EXIT.unreadableReply, "any other status is unreadable, not a verdict");
// A cleanup that failed AFTER the drill measured the pipeline keeps that measurement as a verdict,
// or a real broken pipeline would later page as a drill that never concluded.
eq(
  readDrillReply(200, JSON.stringify({ reason: "cleanup-failed", endedAs: "did-not-move", detail: "x" })).exit,
  REROUTE_DRILL_EXIT.cleanupFailedAfterVerdict,
  "cleanup failed after a measured failure",
);
eq(
  readDrillReply(200, JSON.stringify({ reason: "cleanup-failed", endedAs: "passed", detail: "x" })).exit,
  REROUTE_DRILL_EXIT.cleanupFailedAfterVerdict,
  "cleanup failed after a pass",
);
eq(
  readDrillReply(200, JSON.stringify({ reason: "cleanup-failed", endedAs: "errored", detail: "x" })).exit,
  REROUTE_DRILL_EXIT.cleanupFailed,
  "cleanup failed after a drill that never reached the pipeline",
);
assert(concludesEarly(REROUTE_DRILL_EXIT.cleanupFailedAfterVerdict), "after a measured verdict, a failed cleanup still stamps");
for (const inherited of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
  eq(
    readDrillReply(200, JSON.stringify({ reason: inherited, detail: "x" })).exit,
    REROUTE_DRILL_EXIT.unreadableReply,
    `a reason named like an inherited property (${inherited}) is unreadable, never an exit it borrowed`,
  );
}

// Which endings stamp.
const concludes = (exit: number) => decideRerouteDrillReport({ exit, detail: "d" }, "https://run").concluded;
function concludesEarly(exit: number): boolean {
  return decideRerouteDrillReport({ exit, detail: "d" }, "https://run").concluded;
}
assert(concludes(REROUTE_DRILL_EXIT.passed), "a pass is a measured verdict");
for (const exit of [
  REROUTE_DRILL_EXIT.didNotStamp,
  REROUTE_DRILL_EXIT.didNotSweep,
  REROUTE_DRILL_EXIT.changeNotRecorded,
  REROUTE_DRILL_EXIT.sweepQueuedNothing,
  REROUTE_DRILL_EXIT.didNotMove,
  REROUTE_DRILL_EXIT.noAudit,
  REROUTE_DRILL_EXIT.moveBackRefused,
  REROUTE_DRILL_EXIT.didNotMoveBack,
  REROUTE_DRILL_EXIT.notPinned,
]) {
  assert(concludes(exit), `exit ${exit}: the pipeline answered wrongly, which is a definite reading`);
}
for (const exit of [
  REROUTE_DRILL_EXIT.misconfigured,
  REROUTE_DRILL_EXIT.noAnswer,
  REROUTE_DRILL_EXIT.unreadableReply,
  REROUTE_DRILL_EXIT.unauthorized,
  REROUTE_DRILL_EXIT.notConfigured,
  REROUTE_DRILL_EXIT.endpointMissing,
  REROUTE_DRILL_EXIT.busy,
  // #4180: the smoke canary held the shared test advisors past the drill's wait.
  REROUTE_DRILL_EXIT.testAdvisorsHeld,
  REROUTE_DRILL_EXIT.notSeeded,
  REROUTE_DRILL_EXIT.noFreeSlot,
  REROUTE_DRILL_EXIT.bookingRefused,
  REROUTE_DRILL_EXIT.bookedOutsideDrill,
  REROUTE_DRILL_EXIT.cleanupFailed,
  REROUTE_DRILL_EXIT.errored,
]) {
  assert(!concludes(exit), `exit ${exit}: the pipeline was never judged, so nothing may stamp`);
}

// What it says.
{
  const pass = decideRerouteDrillReport({ exit: REROUTE_DRILL_EXIT.passed, detail: "fine" }, "https://run");
  eq(pass.alert, null, "a pass says nothing");
  // Dan, 2026-10-23: a drill the canary kept off the test advisors is not news. It says nothing
  // and stamps nothing, so only a run of such days surfaces, through the verdict's stale bound.
  const held = decideRerouteDrillReport({ exit: REROUTE_DRILL_EXIT.testAdvisorsHeld, detail: "held" }, "https://run/2");
  eq(held.alert, null, "a drill skipped because the canary held the test advisors says nothing");
  assert(!held.concluded, "a drill skipped because the canary held the test advisors never stamps");
  const moved = decideRerouteDrillReport({ exit: REROUTE_DRILL_EXIT.didNotMove, detail: "The call stayed put." }, "https://run/1");
  assert(moved.alert !== null && moved.alert.includes("The call stayed put.") && moved.alert.includes("https://run/1"), "a failure says the drill's own words and links the run");
  const cleanup = decideRerouteDrillReport({ exit: REROUTE_DRILL_EXIT.cleanupFailed, detail: "cancel: refused" }, "");
  assert(cleanup.alert !== null && /test call|test advisor/.test(cleanup.alert), "a failed cleanup names what may be left behind");
  const none = decideRerouteDrillReport(null, "");
  assert(!none.concluded && none.alert !== null, "a run that wrote no verdict speaks and never stamps");
  const unknown = decideRerouteDrillReport({ exit: 99, detail: "x" }, "");
  assert(!unknown.concluded && unknown.alert !== null && unknown.alert.includes("99"), "an exit nothing judges speaks and never stamps");
  for (const code of codes) {
    const said = decideRerouteDrillReport({ exit: code, detail: "d" }, "u").alert ?? "";
    assert(!DASH.test(said), `exit ${code} says nothing with dash punctuation`);
  }
}

finish();
