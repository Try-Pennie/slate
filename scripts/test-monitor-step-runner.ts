// Per-step containment and cost for the monitor lane (#1281 + #1277). Run:
//   node --experimental-strip-types scripts/test-monitor-step-runner.ts
//
// Two problems with one shape. The monitor route ran thirteen checks in sequence
// inside ONE try block, and only four carried their own catch, so an unexpected
// throw in any unguarded step skipped every step below it: a broken migration
// check disabled the availability probe and the cal.com override sweep, which
// exist to catch customer-visible problems. And no step recorded its own cost, so
// when a shared budget degrades the first symptom shows up in whichever check is
// most sensitive rather than in the one consuming it (#1245 took three days to
// notice for exactly that reason).
//
// Knowing which step failed and knowing what each step cost want the same
// structure, so there is one runner rather than two.
import { createStepRunner } from "../src/lib/monitor/step-runner.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** A clock that advances by a fixed amount per read, so durations are exact. */
function fakeClock(steps: number[]) {
  let i = 0;
  const reads: number[] = [];
  let t = 1000;
  return () => {
    // Each step reads the clock twice (before and after); advance on the second.
    reads.push(t);
    const out = t;
    if (reads.length % 2 === 0) t += 0;
    else t += steps[i++] ?? 0;
    return out;
  };
}

// --- containment: one broken step must not cost the others ---
{
  const errors: { name: string; err: unknown }[] = [];
  const r = createStepRunner({ now: () => 0, onError: (name, err) => errors.push({ name, err }) });
  const ran: string[] = [];

  const a = await r.run("scan", "fallback-a", async () => {
    ran.push("scan");
    return "scan-ok";
  });
  const b = await r.run("drift", "fallback-b", async () => {
    ran.push("drift");
    throw new Error("migration table missing");
  });
  const c = await r.run("sweep", "fallback-c", async () => {
    ran.push("sweep");
    return "sweep-ok";
  });

  eq(ran, ["scan", "drift", "sweep"], "a throwing step does not stop the steps after it");
  eq(a, "scan-ok", "a healthy step returns its own result");
  eq(b, "fallback-b", "a throwing step returns its fallback rather than propagating");
  eq(c, "sweep-ok", "and the step after the failure runs normally");
  eq(errors.length, 1, "the failure is reported exactly once");
  eq(errors[0].name, "drift", "and reported against the step that failed, by name");
  assert(String((errors[0].err as Error).message).includes("migration"), "with the real error, not a summary");
}
{
  // A step that rejects rather than throws synchronously is the same case, and is
  // the one most steps here would actually take.
  const r = createStepRunner({ now: () => 0, onError: () => {} });
  const out = await r.run("x", 0, () => Promise.reject(new Error("rejected")));
  eq(out, 0, "a rejected promise is contained too");
}
{
  // A thrown non-Error must not break the reporting path itself.
  const errors: unknown[] = [];
  const r = createStepRunner({ now: () => 0, onError: (_n, err) => errors.push(err) });
  await r.run("x", null, async () => {
    throw "a bare string";
  });
  eq(errors, ["a bare string"], "a non-Error throw reaches onError unchanged");
  eq(r.outcomes()[0].ok, false, "and still counts as a failed step");
}

// --- cost: every step's own duration, including the ones that failed ---
{
  const r = createStepRunner({ now: fakeClock([120, 30, 5]), onError: () => {} });
  await r.run("scan", null, async () => null);
  await r.run("drift", null, async () => {
    throw new Error("boom");
  });
  await r.run("sweep", null, async () => null);
  const o = r.outcomes();
  eq(o.map((s) => s.name), ["scan", "drift", "sweep"], "outcomes keep the order the steps ran in");
  eq(o.map((s) => s.ms), [120, 30, 5], "each step is timed on its own, not cumulatively");
  eq(
    o.map((s) => s.ok),
    [true, false, true],
    "and a failed step is still timed: the step that dies is often the fast one, and leaving it out would hide it",
  );
}
{
  const r = createStepRunner({ now: fakeClock([10, 20]), onError: () => {} });
  await r.run("a", null, async () => null);
  await r.run("b", null, async () => null);
  const f = r.fields();
  eq(f.ms_a, 10, "the log line carries each step's own duration");
  eq(f.ms_b, 20, "for every step");
  eq(f.ms_total, 30, "plus the total, so a slow lane can be attributed rather than guessed at");
  eq(f.steps, 2, "and how many steps ran");
  eq(f.steps_failed, 0, "with nothing failed on a clean tick");
  assert(!("failed" in f), "and no empty failure list to read past");
}
{
  const r = createStepRunner({ now: () => 0, onError: () => {} });
  await r.run("a", null, async () => null);
  await r.run("b", null, async () => {
    throw new Error("x");
  });
  await r.run("c", null, async () => {
    throw new Error("y");
  });
  const f = r.fields();
  eq(f.steps_failed, 2, "failures are counted");
  eq(f.failed, "b,c", "and NAMED, so the log line says which checks did not run rather than only that something did not");
}
{
  // The tick must never report a step it did not run. A zero here would read as
  // "ran and cost nothing", which is the same defect as a false healthy count.
  const r = createStepRunner({ now: () => 0, onError: () => {} });
  const f = r.fields();
  eq(f.steps, 0, "a tick that ran no steps says so");
  eq(f.ms_total, 0, "with a total of zero");
  assert(!("ms_scan" in f), "and names no step it never ran");
}
{
  // Two steps sharing a name would silently overwrite one another's timing, so
  // the whole point of the measurement quietly goes. It must be visible.
  const r = createStepRunner({ now: fakeClock([10, 25]), onError: () => {} });
  await r.run("dup", null, async () => null);
  await r.run("dup", null, async () => null);
  const f = r.fields();
  eq(f.ms_dup, 35, "a repeated step name sums rather than losing one of the two");
  eq(f.duplicate_step_names, "dup", "and says the name was reused, so the sum is not read as one step");
  eq(f.steps, 2, "both still count as steps");
}

// --- the runner itself must not be the thing that breaks the tick ---
{
  const r = createStepRunner({
    now: () => 0,
    onError: () => {
      throw new Error("the logger itself is broken");
    },
  });
  let reached = false;
  const out = await r.run("a", "fb", async () => {
    throw new Error("step failed");
  });
  reached = true;
  eq(out, "fb", "a throwing onError still yields the fallback");
  assert(reached, "and does not take the tick down with it, which would defeat the whole containment");
  eq(r.outcomes()[0].ok, false, "the step is still recorded as failed");
}

// --- #3120: a lost lane lock stops the remaining steps -------------------------
// A tick that outlives its TTL lets the next one take the key, and two monitor runs
// then post the same handoff and overwrite each other's learned settings. The lease
// is asked before each step; once it is gone the rest are skipped, NOT failed (a
// failure would feed the step failure streak and page about a lock), and named.
{
  let held = true;
  let ran = 0;
  const errors: string[] = [];
  const r = createStepRunner({
    now: () => 0,
    onError: (name) => errors.push(name),
    stillHeld: async () => held,
  });
  eq(await r.run("first", "fb", async () => (ran++, "v")), "v", "a held lease runs the step");
  held = false;
  eq(await r.run("second", "fb", async () => (ran++, "v")), "fb", "a lost lease yields the fallback");
  eq(await r.run("third", "fb", async () => (ran++, "v")), "fb", "and keeps skipping");
  eq(ran, 1, "neither skipped step body ran");
  eq(errors.length, 0, "a skip is not reported as a step failure");
  eq(r.fields().skipped_lease_lost, "second,third", "the skipped steps are named on the cycle line");
}
{
  // A fence that throws must not take the tick down: it cannot show the lease is
  // held, so the step is skipped.
  const r = createStepRunner({
    now: () => 0,
    onError: () => {},
    stillHeld: async () => {
      throw new Error("renewal blew up");
    },
  });
  eq(await r.run("a", "fb", async () => "v"), "fb", "a throwing fence skips the step rather than throwing");
}

// --- a step that ran but MEASURED nothing says so (#3955, L792) ---
// A step whose gate is shut, whose hourly slot has not come round, or whose org is
// closed returns without doing its work. It did not throw, and it did not show its
// work succeeding either, so it must not be recorded as a healthy run: the step
// failure streak would read it as recovery and clear a page about the work it skipped.
{
  const r = createStepRunner({ now: () => 0, onError: () => {} });
  const skipped = await r.run("hourly", "fb", async (step) => step.unmeasured("not-due"));
  const worked = await r.run("every_tick", "fb", async () => "done");
  const threw = await r.run("gated_then_threw", "fb", async (step) => {
    step.unmeasured(null);
    throw new Error("boom");
  });
  eq(skipped, "not-due", "an unmeasured step still returns its own value");
  eq(worked, "done", "a step that ignores the context runs as before");
  eq(threw, "fb", "a step that marked itself unmeasured and then threw returns its fallback");
  eq(
    r.outcomes().map((o) => [o.name, o.ok, o.measured]),
    [
      ["hourly", true, false],
      ["every_tick", true, true],
      ["gated_then_threw", false, true],
    ],
    "an unmeasured run is recorded as such, and a throw is always a measured failure",
  );
  eq(r.fields().unmeasured, "hourly", "the cycle line names the steps that measured nothing this tick");
}

finish();
