// #3251: the pure decisions behind `pnpm verify:reroute-live`, pinned with no
// network and no clock, so the live command's refusals are tested where it cannot
// run.
//
// Run: node --experimental-strip-types scripts/test-reroute-live-check.ts
import {
  REROUTE_LIVE_OUTCOMES,
  RUN_BUDGET_MS,
  attemptEach,
  candidateStarts,
  cleanupVerdict,
  eventLedger,
  publicBucketWindowProblem,
  rerouteLostEvent,
  inCanaryWindow,
  residue,
  runMeetsCanary,
  startIsClear,
} from "./lib/reroute-live-check.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const at = (hhmm: string, day = "2031-03-04") => Date.parse(`${day}T${hhmm}:00Z`);
const MIN = 60_000;

// --- every outcome has its own exit code and its own message (L11) ----------------------------
{
  const outcomes = Object.values(REROUTE_LIVE_OUTCOMES);
  eq(new Set(outcomes.map((o) => o.exit)).size, outcomes.length, "no two outcomes share an exit code");
  eq(new Set(outcomes.map((o) => o.says)).size, outcomes.length, "no two outcomes share a message");
  eq(REROUTE_LIVE_OUTCOMES.proven.exit, 0, "only proof exits 0");
  const codeOf = (o: keyof typeof REROUTE_LIVE_OUTCOMES): number => REROUTE_LIVE_OUTCOMES[o].exit;
  assert(codeOf("cleanupUnverified") !== codeOf("residue"),
    "could not confirm cleanup and found something left are different outcomes (L11)");
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

// --- a run must END before the canary's window too, not only start outside it -------------------
{
  // The last start allowed is the one whose budget ends just before the window
  // opens at :27; derived from the budget, so a changed budget moves both cases.
  const opens = at("14:27");
  const lastClear = opens - RUN_BUDGET_MS - 60_000;
  eq(runMeetsCanary(lastClear), false, "the last start whose whole budget ends before the window is clear");
  eq(runMeetsCanary(lastClear + 60_000), true, "a minute later its budget reaches the window, so it is refused");
}
eq(runMeetsCanary(at("14:10")), false, "a run starting at 14:10 finishes well clear of 14:27");
eq(runMeetsCanary(at("14:30")), true, "one starting inside the window is refused, as before");
eq(runMeetsCanary(at("14:38")), false, "control: one starting just after the window is clear");

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

// --- the cleanup verdict: what is left, and a read that fails is a finding, never a crash -------
// By the time it runs the command has written to production, so it must always reach
// its own verdict (L515) rather than dying on one unreadable record, and a record it
// could not read must say so rather than reading as gone (L11, L98).
async function residueCases() {
  const calls: string[] = [];
  const left = await residue([
    { label: "B1", leftOver: async () => (calls.push("B1"), null) },
    { label: "B2", leftOver: async () => (calls.push("B2"), "B2 is confirmed") },
    {
      label: "B3's calendar event",
      leftOver: async () => {
        calls.push("B3");
        throw new Error("events.get 503");
      },
    },
    { label: "the hold blocks", leftOver: async () => (calls.push("blocks"), "a hold busy block is still there") },
  ]);
  eq(left.left, ["B2 is confirmed", "a hold busy block is still there"], "what was found left, in order");
  eq(left.unverified, ["B3's calendar event: events.get 503"], "and what could not be read, kept apart from it");
  eq(calls, ["B1", "B2", "B3", "blocks"], "a failed read never stops the checks after it");
  eq(await residue([{ label: "B1", leftOver: async () => null }]), { left: [], unverified: [] }, "nothing left reads as two empty lists");
}

// --- events are recorded as they appear, with the calendar that holds them -----------------------
{
  const ledger = eventLedger({ ONE: "one@x.com", TWO: "two@x.com" });
  ledger.note({ gcal_event_id: "ev-1", assigned_user_id: "ONE" });
  ledger.note({ gcal_event_id: null, assigned_user_id: "TWO" });
  ledger.note({ gcal_event_id: "ev-2", assigned_user_id: "TWO" });
  ledger.note({ gcal_event_id: "ev-3", assigned_user_id: "REAL" });
  ledger.note({ gcal_event_id: "ev-1", assigned_user_id: "ONE" });
  ledger.note({ gcal_event_id: "ev-2", assigned_user_id: null });
  eq([...ledger.events()], [["ev-1", "one@x.com"], ["ev-2", "two@x.com"], ["ev-3", null]],
    "each event once, with its first known calendar (a later read with the advisor cleared never erases it); no event records nothing; one outside the test world records no calendar");
}

// --- every cleanup step is attempted, whatever the one before it did ---------------------------
async function attemptCases() {
  const ran: string[] = [];
  const failed = await attemptEach([
    { what: "release the hold on B1", run: async () => { ran.push("release"); throw new Error("rpc 500"); } },
    { what: "cancel B1", run: async () => { ran.push("cancel"); } },
  ]);
  eq(ran, ["release", "cancel"], "a failed release never stops the cancel after it");
  eq(failed, ["could not release the hold on B1: rpc 500"], "and the failure is named");
}

// --- the verdict: left wins, then could not tell, then proven -------------------------------------
eq(cleanupVerdict({ left: [], unverified: [] }), null, "nothing left and everything read: no cleanup verdict");
eq(cleanupVerdict({ left: ["B1 is not cancelled"], unverified: ["event x: 503"] }),
  { outcome: "residue", detail: "B1 is not cancelled; could not read: event x: 503" }, "something left is the residue outcome, naming the unread too");
eq(cleanupVerdict({ left: [], unverified: ["event x: 503"] }),
  { outcome: "cleanupUnverified", detail: "could not read: event x: 503" }, "only unread records is its own outcome");

// --- the clear window assumes the public test bucket's call carries no buffers --------------------
eq(publicBucketWindowProblem({ buffer_before_min: 0, buffer_after_min: 0 }), null, "no buffers: the window fits");
assert(publicBucketWindowProblem({ buffer_before_min: 0, buffer_after_min: 10 }) !== null, "an after buffer would outrun the window, so the run refuses");
assert(publicBucketWindowProblem({ buffer_before_min: 5, buffer_after_min: 0 }) !== null, "and so would a before buffer");

// --- a reroute must leave its booking holding a calendar event ------------------------------------
eq(rerouteLostEvent({ gcal_event_id: "ev-1" }, "the keep"), null, "an event still held is fine");
eq(rerouteLostEvent({ gcal_event_id: null }, "the keep"), "the keep left the booking with no calendar event", "a lost event fails the step by name");

residueCases().then(attemptCases).then(() => finish());
