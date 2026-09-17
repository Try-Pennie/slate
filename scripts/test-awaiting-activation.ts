// Somebody has been waiting to become bookable (#2318). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-awaiting-activation.ts
//
// Since #2302 the activation gate refuses an agent whose Google calendar Slate
// cannot read, so `bookable_pending_since` is a real population rather than a
// rare one, and nothing watched it. A refused attempt fires a per agent alert on
// a 30 minute cooldown; an activation the roster run DEFERRED because it spent
// its shared allowance is never attempted at all, so it produces no alert and no
// evidence anywhere a person looks. From outside, a hire the roster thinks is
// working and Slate is not offering looks exactly like a hire who is fine.
//
// This file pins the predicate (who counts as waiting), the patience on top of it
// (four hourly retries), and the three things the lane step must keep apart: a
// measured queue, a measured empty queue, and a read that failed and therefore
// measured nothing.
import {
  agentsAwaitingActivation,
  agentsPastActivationGrace,
  runAwaitingActivationCheck,
  formatAwaitingActivationAlert,
  formatAwaitingActivationRecovery,
  AWAITING_ACTIVATION_GRACE_MS,
  AWAITING_ACTIVATION_KEY,
  ROSTER_RETRY_INTERVAL_MS,
  type AwaitingActivationRow,
} from "@/lib/monitor/awaiting-activation";
import { assert, eq, finish } from "./lib/harness.ts";

// A fixed clock: nothing here may read the real one (L290).
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);
const HOUR = 60 * 60_000;
const hoursAgo = (n: number) => new Date(NOW - n * HOUR).toISOString();

function row(over: Partial<AwaitingActivationRow> = {}): AwaitingActivationRow {
  return {
    id: "u1",
    name: "A Agent",
    email: "aagent@trypennie.com",
    bookable: false,
    deactivated_at: null,
    bookable_pending_since: hoursAgo(9),
    ...over,
  };
}

// --- who counts as waiting ---------------------------------------------------------
{
  eq(agentsAwaitingActivation([row()]).length, 1, "a live non bookable row carrying the mark is waiting");
  eq(
    agentsAwaitingActivation([row({ bookable_pending_since: null })]).length,
    0,
    "no mark, nothing was ever planned for them",
  );

  // The mark SURVIVES a refusal and is cleared by any explicit bookable write
  // (writeBookable, #2071), so a row that is both bookable and marked is a stale
  // mark rather than a wait. isRoutable is what says so, rather than a second
  // spelling of "Slate will route to them" written here (L41).
  eq(
    agentsAwaitingActivation([row({ bookable: true })]).length,
    0,
    "already in the pool: the mark is stale, not a wait",
  );

  // Somebody who left is not waiting for anything. Their Google account is
  // routinely unlicensed on the way out, so naming them sends a reader to do a
  // provisioning repair on a departed employee.
  eq(
    agentsAwaitingActivation([row({ deactivated_at: hoursAgo(1) })]).length,
    0,
    "deactivated: they are not waiting to enter a pool they have left",
  );
  eq(
    agentsAwaitingActivation([row({ bookable: true, deactivated_at: hoursAgo(1) })]).length,
    0,
    "and a deactivated row that still reads bookable is not waiting either",
  );
}

// --- the grace: four hourly retries -------------------------------------------------
{
  eq(
    AWAITING_ACTIVATION_GRACE_MS,
    4 * ROSTER_RETRY_INTERVAL_MS,
    "the patience is a whole number of the retries that would clear it",
  );
  eq(ROSTER_RETRY_INTERVAL_MS, HOUR, "and the roster lane retries hourly");

  const pastGrace = (h: number) =>
    agentsPastActivationGrace(agentsAwaitingActivation([row({ bookable_pending_since: hoursAgo(h) })]), NOW).length;
  eq(pastGrace(0), 0, "marked this minute: inside the grace, say nothing");
  eq(pastGrace(3), 0, "three hourly retries in: still inside");
  eq(pastGrace(9), 1, "nine hours: four retries have been and gone");

  // The boundary, both sides of it, so neither an off by one nor a flipped
  // comparison can pass (L1).
  const at = (ms: number) =>
    agentsPastActivationGrace(
      agentsAwaitingActivation([row({ bookable_pending_since: new Date(ms).toISOString() })]),
      NOW,
    ).length;
  eq(at(NOW - AWAITING_ACTIVATION_GRACE_MS + 60_000), 0, "a minute short of the grace is silent");
  eq(at(NOW - AWAITING_ACTIVATION_GRACE_MS - 60_000), 1, "a minute past it is named");
}

// --- an unreadable stamp is named, never silently spared -----------------------------
{
  // A NaN comparison lands on the quiet branch by default, which would disable the
  // alert for exactly the rows nobody can explain (L: parseStampMs).
  for (const bad of ["", "not a date", "0000-00-00"]) {
    const found = agentsAwaitingActivation([row({ bookable_pending_since: bad })]);
    eq(found.length, bad === "" ? 0 : 1, `an unreadable mark (${JSON.stringify(bad)}) is still a mark`);
    if (found.length) {
      eq(found[0].waitingSinceMs, null, "with no measurable start");
      eq(agentsPastActivationGrace(found, NOW).length, 1, "and it is named rather than spared");
    }
  }
}

// --- the lane step: three outcomes, and only one of them clears -----------------------
{
  const paged: string[] = [];
  const resolved: string[] = [];
  const deps = (load: () => Promise<AwaitingActivationRow[]>, armed = true) => ({
    load,
    armed,
    notify: async (key: string) => {
      paged.push(key);
    },
    resolve: async (key: string) => {
      resolved.push(key);
      return true;
    },
    cooldownMs: 1,
    nowMs: NOW,
  });

  const waiting = await runAwaitingActivationCheck(deps(async () => [row()]));
  eq(waiting.status, "waiting", "a queue past the grace is reported as a queue");
  eq(waiting.status === "waiting" ? waiting.paged : false, true, "and armed, it pages");
  eq(paged.length, 1, "once");
  eq(paged[0], AWAITING_ACTIVATION_KEY, "on its own key");

  paged.length = 0;
  resolved.length = 0;
  const clear = await runAwaitingActivationCheck(deps(async () => [row({ bookable_pending_since: null })]));
  eq(clear.status, "clear", "a sweep that found nobody waiting is clear");
  eq(clear.status === "clear" ? clear.measured : -1, 1, "and says how many rows it looked at");
  eq(resolved.length, 1, "the all clear is posted, because the sweep really ran");

  // THE FAILURE PATH. A read that failed measured nothing, so it may claim nothing
  // in either direction: an all clear hung off a query that never ran is how "the
  // backlog has cleared" once went out over a dead read (#1134, #1152).
  paged.length = 0;
  resolved.length = 0;
  const dead = await runAwaitingActivationCheck(
    deps(async () => {
      throw new Error("users read failed: relation does not exist");
    }),
  );
  eq(dead.status, "unreadable", "a failed read is reported as unmeasured");
  assert(dead.status === "unreadable" && /relation does not exist/.test(dead.error), "carrying why");
  eq(paged.length, 0, "it pages nobody");
  eq(resolved.length, 0, "and clears nothing");

  // A read that came back and a read that failed must not render the same: the
  // empty sweep above stamped a resolve and this one did not, which is the only
  // externally visible difference between them.
  assert(dead.status !== clear.status, "an unreadable roster and an empty queue are different verdicts");
}

// --- disarmed: it measures, and sends nothing in either direction ---------------------
{
  const paged: string[] = [];
  const resolved: string[] = [];
  const deps = (rows: AwaitingActivationRow[]) => ({
    load: async () => rows,
    armed: false,
    notify: async (key: string) => {
      paged.push(key);
    },
    resolve: async (key: string) => {
      resolved.push(key);
      return true;
    },
    cooldownMs: 1,
    nowMs: NOW,
  });

  const observed = await runAwaitingActivationCheck(deps([row()]));
  eq(observed.status, "waiting", "it still reaches a measured verdict while disarmed");
  eq(observed.status === "waiting" ? observed.paged : true, false, "and says it did not send it");
  eq(paged.length, 0, "nothing was sent");

  // Silence chosen by a switch is not a measurement of health, so a disarmed run
  // must not post an all clear either.
  await runAwaitingActivationCheck(deps([row({ bookable_pending_since: null })]));
  eq(resolved.length, 0, "a disarmed empty sweep clears nothing");
}

// --- copy -----------------------------------------------------------------------------
{
  const findings = agentsAwaitingActivation([
    row({ id: "u1", name: "C Frank", email: "cfrank@trypennie.com", bookable_pending_since: hoursAgo(9) }),
    row({ id: "u2", name: null, email: "jsaminu@trypennie.com", bookable_pending_since: hoursAgo(73) }),
  ]);
  const text = formatAwaitingActivationAlert(findings, NOW);
  assert(/2 agents have been waiting/.test(text), "plural reads as plural");
  assert(/cfrank@trypennie.com/.test(text), "names who");
  assert(/jsaminu@trypennie.com/.test(text), "each of them");
  assert(/9 hours/.test(text), "and how long each has actually waited");
  assert(/3 days/.test(text), "in days once the wait runs past one");
  assert(/Google Workspace/.test(text), "says what the reader should do");
  assert(!/^Slate/.test(text), "does not open with the word Slate");
  assert(!/[\u2014\u2013]/.test(text), "no dashes as punctuation");
  assert(!/NaN|undefined|Invalid/.test(text), "and leaks nothing broken into Slack");

  const one = formatAwaitingActivationAlert(agentsAwaitingActivation([row()]), NOW);
  assert(/1 agent has been waiting/.test(one), "singular reads as singular");

  const unreadable = formatAwaitingActivationAlert(
    agentsAwaitingActivation([row({ bookable_pending_since: "nonsense" })]),
    NOW,
  );
  assert(/unreadable/.test(unreadable), "an unmeasurable wait says so rather than rendering NaN hours");
  assert(!/NaN|undefined|Invalid/.test(unreadable), "never a broken number");

  // The all clear may claim only what the sweep measured (L440): nobody is PAST
  // the window, which is not the same as nobody being in the queue at all.
  const recovery = formatAwaitingActivationRecovery();
  assert(/4 hours/.test(recovery), "the all clear names the same window the alert measured");
  assert(!/^Slate/.test(recovery), "and does not open with the word Slate");
  assert(!/[\u2014\u2013]/.test(recovery), "no dashes there either");
}

finish();
