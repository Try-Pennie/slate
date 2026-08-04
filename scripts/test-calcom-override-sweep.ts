// The cal.com override sweep (#1253): retry a recorded failure while it still
// matters, and page when an absence has BEGUN with cal.com never updated.
//
// Why this exists at all: cal.com is still the booking system taking real customer
// bookings, so an approved absence whose override never landed leaves an agent
// bookable during their time off. Until now the only recovery was a human reading
// one Slack message and pressing a button, which is a must-not-lose write resting
// on a best-effort mechanism. A single transient 500 in June consumed one absence's
// protection permanently.
//
// The selection predicate matters as much as the retry. Measured on prod
// 2026-08-04: 634 approved requests have `calcom_synced = false`, but 631 of those
// are from before the dual-write existed and carry NO cal.com outcome at all. A
// sweep keyed on the flag would have fired 631 writes, nearly all for absences long
// past. Keyed on a recorded FAILURE it matches 2.
import {
  CALCOM_UNPROTECTED_KEY,
  formatUnprotectedAlert,
  inProgressUnprotected,
  runCalcomOverrideSweep,
  type OverrideCandidate,
} from "../src/lib/monitor/calcom-override-sweep.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.parse("2026-08-07T15:00:00Z");
const hours = (n: number) => n * 3_600_000;

const candidate = (over: Partial<OverrideCandidate> = {}): OverrideCandidate => ({
  id: "req-1",
  email: "agent@trypennie.com",
  startsAt: new Date(NOW + hours(48)).toISOString(),
  endsAt: new Date(NOW + hours(72)).toISOString(),
  effect: "failed: schedule patch returned 500",
  ...over,
});

// --- which ones are actually dangerous ------------------------------------

{
  const upcoming = candidate();
  const started = candidate({
    id: "req-2",
    startsAt: new Date(NOW - hours(2)).toISOString(),
    endsAt: new Date(NOW + hours(6)).toISOString(),
  });
  const found = inProgressUnprotected([upcoming, started], NOW);
  eq(found.length, 1, "only the absence already under way counts as unprotected");
  eq(found[0].id, "req-2", "and it is the started one");
}

{
  // An unreadable timestamp must not read as "not started yet", which would hide
  // the exact state this check exists to find (the parseStampMs fail-safe rule).
  const broken = candidate({ id: "req-3", startsAt: "not a date" });
  eq(
    inProgressUnprotected([broken], NOW).length,
    1,
    "an unreadable start is treated as under way, not silently skipped",
  );
}

// --- the sweep ------------------------------------------------------------

interface FakeOpts {
  candidates?: OverrideCandidate[] | null;
  outcomes?: Record<string, string>;
  max?: number;
}

function runFake(opts: FakeOpts) {
  const state = { retried: [] as string[], alerts: [] as string[], resolved: [] as string[] };
  const promise = runCalcomOverrideSweep({
    nowMs: NOW,
    max: opts.max,
    loadCandidates: async () => opts.candidates ?? null,
    retry: async (id) => {
      state.retried.push(id);
      return opts.outcomes?.[id] ?? "failed: schedule patch returned 500";
    },
    alert: async (key, text) => {
      state.alerts.push(`${key}|${text}`);
    },
    resolve: async (key) => {
      state.resolved.push(key);
      return true;
    },
  });
  return { state, promise };
}

{
  // A transient failure that clears on the retry: nothing to page about.
  const { state, promise } = runFake({
    candidates: [candidate()],
    outcomes: { "req-1": "ok" },
  });
  const res = await promise;
  eq(state.retried.length, 1, "the failed request is retried");
  eq(res.cleared, 1, "and counted as cleared when it comes back ok");
  eq(state.alerts.length, 0, "no page for a failure that just fixed itself");
}

{
  // A retry that comes back as a SKIP also clears: the agent is not in cal.com, so
  // there is nothing to protect and it must stop being swept forever.
  const { state, promise } = runFake({
    candidates: [candidate()],
    outcomes: { "req-1": "skipped: not in cal.com (agent@trypennie.com)" },
  });
  const res = await promise;
  eq(res.cleared, 1, "a skip clears the row rather than being retried forever");
  eq(state.alerts.length, 0, "and does not page");
}

{
  // The dangerous case: the absence is under way and the retry still fails.
  const started = candidate({
    startsAt: new Date(NOW - hours(1)).toISOString(),
    endsAt: new Date(NOW + hours(7)).toISOString(),
  });
  const { state, promise } = runFake({ candidates: [started] });
  const res = await promise;
  eq(res.unprotected, 1, "an in-progress absence that still fails is unprotected");
  assert(state.alerts.length === 1, "and it pages");
  assert(state.alerts[0].startsWith(CALCOM_UNPROTECTED_KEY), "on its own key");
  assert(state.alerts[0].includes("agent@trypennie.com"), "naming the agent");
  eq(state.resolved.length, 0, "and clears nothing while it is still true");
}

{
  // A future absence that still fails is worth retrying but is NOT yet an incident:
  // there is time for the next tick to fix it.
  const { state, promise } = runFake({ candidates: [candidate()] });
  const res = await promise;
  eq(res.unprotected, 0, "an upcoming absence is not yet unprotected");
  eq(state.alerts.length, 0, "so it does not page yet");
}

{
  // Nothing to do: measured healthy, so the condition can be cleared.
  const { state, promise } = runFake({ candidates: [] });
  const res = await promise;
  eq(res.measured, true, "an empty candidate list is a real measurement");
  assert(state.resolved.includes(CALCOM_UNPROTECTED_KEY), "so it sends the all-clear");
}

{
  // The read failed. That is NOT health: alerting would name nobody and clearing
  // would announce a recovery on the strength of a query that never ran (#1134).
  const { state, promise } = runFake({ candidates: null });
  const res = await promise;
  eq(res.measured, false, "an unreadable candidate list is not a measurement");
  eq(state.alerts.length, 0, "so it does not page");
  eq(state.resolved.length, 0, "and it does not all-clear either");
  eq(state.retried.length, 0, "and it retries nothing");
}

{
  // Bounded per tick, and it says what it left, so a cap set too low cannot read as
  // a clean sweep.
  const many = Array.from({ length: 25 }, (_, i) => candidate({ id: `req-${i}` }));
  const { state, promise } = runFake({ candidates: many, max: 10 });
  const res = await promise;
  eq(state.retried.length, 10, "retries at most the per-tick cap");
  eq(res.deferred, 15, "and reports how many it left for the next tick");
}

// --- the copy -------------------------------------------------------------

{
  const started = candidate({
    startsAt: new Date(NOW - hours(1)).toISOString(),
    endsAt: new Date(NOW + hours(7)).toISOString(),
  });
  const text = formatUnprotectedAlert([started], NOW);
  assert(text.includes("agent@trypennie.com"), "the alert names who is affected");
  assert(!/^Slate/.test(text), "does not open with the word Slate (the app name is the header)");
  assert(!text.includes("undefined") && !text.includes("NaN"), "renders no placeholder junk");
  assert(text.length < 400, "short enough to read on a phone mid-incident");
}

finish();
