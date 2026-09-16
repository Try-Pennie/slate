// The decision logic behind `pnpm verify:kill-switch` (#2365), driven offline so
// every refusal it can reach is a tested decision rather than a catch block
// nothing exercises, and so the exit table is pinned where no deployment exists.
//
// The command asserts BOTH directions or it proves nothing (L1): with the flag
// off a malformed request reaches the body parser and answers 400, with it on the
// same request is refused ahead of parsing and answers 503 carrying the paused
// copy. One direction alone is satisfied by a route hard wired to a single
// answer. Finding nothing to check is never a pass (L98), so every way of
// learning nothing exits non-zero on its own code, and no two share one (L11).
import {
  KILL_SWITCH_EXIT,
  readProbeReply,
  judgeKillSwitchRun,
  restoreFailureMessage,
  type ProbeReply,
} from "./lib/kill-switch-live-control.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- Every exit code is distinct, so a shell caller can branch on which ---
//
// The whole point of a table like this is that "the deployment refused the key"
// and "the switch does not refuse" send two different people to two different
// places. A shared code makes them one event (L11).
{
  const codes = Object.values(KILL_SWITCH_EXIT);
  eq(new Set(codes).size, codes.length, "no two outcomes share an exit code");
  assert(!codes.includes(1), "1 is reserved for 'no credentials here', decided before anything is read");
  eq(KILL_SWITCH_EXIT.ok, 0, "only a proven switch exits 0");
}

// --- readProbeReply: one HTTP reply becomes one outcome ---
//
// Judged on the STATUS and the refusal id, never by looking for words in the
// body: the paused copy and the unreadable copy are both lead facing sentences
// and a substring match would let one answer for the other (L156).
{
  const parsed = (status: number, body: unknown): ProbeReply =>
    readProbeReply(status, JSON.stringify(body));

  eq(parsed(400, { error: "Invalid request" }).kind, "reached-parser", "a 400 means the gate let the request through to the body parser");
  eq(parsed(503, { error: "Bookings are paused" }).kind, "refused", "a 503 is the gate refusing");
  eq(parsed(429, { error: "Too many" }).kind, "rate-limited", "a 429 is the limiter, not the gate, and is its own outcome");
  eq(parsed(500, { error: "boom" }).kind, "server-error", "a 500 is neither, and must not read as a refusal");
  eq(parsed(404, {}).kind, "endpoint-missing", "a 404 means this deployment has no public booking route");

  // A body that is not JSON at all: a platform error page. The STATUS still says
  // something, so it is classified before the body is called unreadable.
  eq(readProbeReply(503, "<html>upstream</html>").kind, "refused", "an unreadable body does not stop a 503 being a refusal");
  eq(readProbeReply(200, "<html>ok</html>").kind, "unreadable-reply", "a status this cannot interpret, with no readable body, is its own outcome");
}

// --- The two refusals are told apart, because they mean opposite things ---
//
// `booking_paused` is somebody deliberately stopping bookings.
// `booking_pause_unreadable` is the gate failing CLOSED on a flag it could not
// read, which turns every lead away with nobody having asked for it. A command
// that scored them alike would report the fault this issue was opened about as a
// working switch.
{
  const paused = readProbeReply(503, JSON.stringify({ error: "Bookings are paused right now." }));
  assert(paused.kind === "refused", "the paused case is a refusal");

  const run = judgeKillSwitchRun({
    whileOpen: { kind: "reached-parser" },
    whilePaused: { kind: "refused", copy: "Bookings are paused right now." },
    pausedCopyIsPauseCopy: false,
    availabilityOpen: { ok: true, slots: 12 },
    availabilityPaused: { ok: true, slots: 12 },
    restored: true,
  });
  assert(!run.ok, "a refusal carrying the UNREADABLE copy is not a working switch");
  eq(run.exitCode, KILL_SWITCH_EXIT.refusedUnreadable, "and it exits on its own code");
  assert(
    /could not read|unreadable/i.test(run.message),
    "and says the gate refused because it could not read its flag, not because somebody paused it",
  );
}

// --- The pass: both directions, the right copy, availability untouched ---
{
  const run = judgeKillSwitchRun({
    whileOpen: { kind: "reached-parser" },
    whilePaused: { kind: "refused", copy: "Bookings are paused right now." },
    pausedCopyIsPauseCopy: true,
    availabilityOpen: { ok: true, slots: 12 },
    availabilityPaused: { ok: true, slots: 12 },
    restored: true,
  });
  assert(run.ok, "both directions, the pause copy and untouched availability is the only pass");
  eq(run.exitCode, KILL_SWITCH_EXIT.ok, "and it exits 0");
}

// --- One direction alone proves nothing (L1) ---
{
  const neverRefused = judgeKillSwitchRun({
    whileOpen: { kind: "reached-parser" },
    whilePaused: { kind: "reached-parser" },
    pausedCopyIsPauseCopy: false,
    availabilityOpen: { ok: true, slots: 12 },
    availabilityPaused: { ok: true, slots: 12 },
    restored: true,
  });
  assert(!neverRefused.ok, "a switch that does not refuse while ON is the headline failure");
  eq(neverRefused.exitCode, KILL_SWITCH_EXIT.doesNotRefuse, "and exits on its own code");

  // The opposite, and it is the fault the issue was actually worried about: a
  // gate that refuses EVERYTHING. It is seen in the OPEN half, where a request
  // must reach the parser.
  const refusesAlways = judgeKillSwitchRun({
    whileOpen: { kind: "refused", copy: "Bookings are paused right now." },
    whilePaused: { kind: "refused", copy: "Bookings are paused right now." },
    pausedCopyIsPauseCopy: true,
    availabilityOpen: { ok: true, slots: 12 },
    availabilityPaused: { ok: true, slots: 12 },
    restored: true,
  });
  assert(!refusesAlways.ok, "a gate refusing while the flag is OFF is turning leads away by itself");
  eq(refusesAlways.exitCode, KILL_SWITCH_EXIT.refusesWhileOpen, "and exits on its own code");
}

// --- What the switch leaves ALONE is half its design, so it is asserted ---
//
// Availability keeps computing while bookings are paused, deliberately: the
// embed render canary drives a real bucket through the public page and cannot
// send a bearer token, so closing the read would take the repo's only browser
// check dark. Compared OPEN against PAUSED rather than demanded to be non zero,
// because before cutover a real bucket legitimately offers nothing (#1272) and a
// check that demanded times would be red from the day it shipped (L36).
{
  const closed = judgeKillSwitchRun({
    whileOpen: { kind: "reached-parser" },
    whilePaused: { kind: "refused", copy: "Bookings are paused right now." },
    pausedCopyIsPauseCopy: true,
    availabilityOpen: { ok: true, slots: 12 },
    availabilityPaused: { ok: false, slots: null },
    restored: true,
  });
  assert(!closed.ok, "availability failing while paused means the switch closed more than it should");
  eq(closed.exitCode, KILL_SWITCH_EXIT.availabilityClosed, "and exits on its own code");

  const emptied = judgeKillSwitchRun({
    whileOpen: { kind: "reached-parser" },
    whilePaused: { kind: "refused", copy: "Bookings are paused right now." },
    pausedCopyIsPauseCopy: true,
    availabilityOpen: { ok: true, slots: 12 },
    availabilityPaused: { ok: true, slots: 0 },
    restored: true,
  });
  assert(!emptied.ok, "times offered before the pause and none during it is the same finding");
  eq(emptied.exitCode, KILL_SWITCH_EXIT.availabilityClosed, "and reports it the same way");

  // Zero on BOTH sides is the dark roster before cutover, not a fault. It is
  // still not evidence, so it is reported rather than passed off as proof.
  const darkBoth = judgeKillSwitchRun({
    whileOpen: { kind: "reached-parser" },
    whilePaused: { kind: "refused", copy: "Bookings are paused right now." },
    pausedCopyIsPauseCopy: true,
    availabilityOpen: { ok: true, slots: 0 },
    availabilityPaused: { ok: true, slots: 0 },
    restored: true,
  });
  assert(darkBoth.ok, "a bucket offering nothing either way does not fail the run");
  assert(
    /offered no times/i.test(darkBoth.message),
    "and the run SAYS availability was unmeasured rather than counting it as proof (L98)",
  );
}

// --- A run that could not put the flag back is the loudest outcome there is ---
//
// It leaves PUBLIC BOOKING STOPPED. Nothing else this command can meet turns
// real leads away after it exits, so it outranks every finding above: a reader
// told "the switch does not refuse" while bookings are silently off has been
// sent to the wrong problem.
{
  const stranded = judgeKillSwitchRun({
    whileOpen: { kind: "reached-parser" },
    whilePaused: { kind: "refused", copy: "Bookings are paused right now." },
    pausedCopyIsPauseCopy: true,
    availabilityOpen: { ok: true, slots: 12 },
    availabilityPaused: { ok: true, slots: 12 },
    restored: false,
  });
  assert(!stranded.ok, "a run that could not restore the flag never passes, whatever else it proved");
  eq(stranded.exitCode, KILL_SWITCH_EXIT.notRestored, "and exits on its own code");

  // It outranks a finding that would otherwise name the run.
  const strandedAndBroken = judgeKillSwitchRun({
    whileOpen: { kind: "reached-parser" },
    whilePaused: { kind: "reached-parser" },
    pausedCopyIsPauseCopy: false,
    availabilityOpen: { ok: true, slots: 12 },
    availabilityPaused: { ok: true, slots: 12 },
    restored: false,
  });
  eq(
    strandedAndBroken.exitCode,
    KILL_SWITCH_EXIT.notRestored,
    "a stranded flag names the run even when the switch also failed to refuse",
  );

  const msg = restoreFailureMessage();
  assert(/paused|stopped/i.test(msg), "the restore failure says bookings are still stopped");
  assert(/booking_settings|admin/i.test(msg), "and names where to put it back");
  assert(msg.length > 40, "in a sentence somebody can act on, not a code");
}

// --- The states where the run learned nothing, each on its own code ---
{
  const cases: { reply: ProbeReply; exit: number; what: string }[] = [
    { reply: { kind: "no-answer", detail: "fetch failed" }, exit: KILL_SWITCH_EXIT.noAnswer, what: "no reply at all" },
    { reply: { kind: "rate-limited" }, exit: KILL_SWITCH_EXIT.rateLimited, what: "the limiter answered, so the gate was never reached" },
    { reply: { kind: "server-error", detail: "500" }, exit: KILL_SWITCH_EXIT.serverError, what: "the route threw" },
    { reply: { kind: "endpoint-missing" }, exit: KILL_SWITCH_EXIT.endpointMissing, what: "no public booking route here" },
    { reply: { kind: "unreadable-reply", detail: "200" }, exit: KILL_SWITCH_EXIT.unreadableReply, what: "something this cannot read answered" },
  ];
  for (const c of cases) {
    const run = judgeKillSwitchRun({
      whileOpen: c.reply,
      whilePaused: { kind: "refused", copy: "Bookings are paused right now." },
      pausedCopyIsPauseCopy: true,
      availabilityOpen: { ok: true, slots: 12 },
      availabilityPaused: { ok: true, slots: 12 },
      restored: true,
    });
    assert(!run.ok, `${c.what} is never a pass`);
    eq(run.exitCode, c.exit, `${c.what} exits on its own code`);
  }
}

// --- Availability that never answered EITHER WAY is unmeasured, not closed ---
//
// Caught by the first live run (2026-09-16), which reported "the switch closed
// availability" when the truth was that the command had asked about a key gated
// test bucket and been 404ed in both halves. A message may claim only what its
// check measured (L11), and this one was accusing the switch of a fault its own
// read had caused. It is still not a pass: the run did not do half its job, so it
// exits on a code of its own (L98).
{
  const run = judgeKillSwitchRun({
    whileOpen: { kind: "reached-parser" },
    whilePaused: { kind: "refused", copy: "Bookings are paused right now." },
    pausedCopyIsPauseCopy: true,
    availabilityOpen: { ok: false, slots: null },
    availabilityPaused: { ok: false, slots: null },
    restored: true,
  });
  assert(!run.ok, "a run that could not read availability at all has not finished its job");
  eq(run.exitCode, KILL_SWITCH_EXIT.availabilityUnmeasured, "and exits on its own code");
  assert(
    !/switch (closed|must close)/i.test(run.message),
    "and does not accuse the switch of a fault the command's own read caused",
  );
  assert(/could not be read|did not answer/i.test(run.message), "it says availability could not be read");

  // The asymmetry that makes the accusation legitimate: it answered BEFORE the
  // pause and not during it. That is the switch, and it keeps its own code.
  const closedByPause = judgeKillSwitchRun({
    whileOpen: { kind: "reached-parser" },
    whilePaused: { kind: "refused", copy: "Bookings are paused right now." },
    pausedCopyIsPauseCopy: true,
    availabilityOpen: { ok: true, slots: 12 },
    availabilityPaused: { ok: false, slots: null },
    restored: true,
  });
  eq(
    closedByPause.exitCode,
    KILL_SWITCH_EXIT.availabilityClosed,
    "answering before the pause and not during it is still the switch closing it",
  );
}

finish();
