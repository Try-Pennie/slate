// Are call outcomes being stored for the calls Regal posts? (#2944). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-regal-call-outcomes-monitor.ts
//
// The show rate in the Slate vs cal.com split is computed from regal_call_outcomes,
// and that table fills in silence: a refused body, a failed insert or a migration
// that never reached production all leave the detector's counter ticking over while
// the outcome rows stop. So the monitor lane compares outcome rows written against
// completed calls received over the last two hours. This pins:
//
//   1. which received events count as completed calls (the denominator);
//   2. the page: under 80% on TWO consecutive checks, never on the first;
//   3. the all clear: off a MEASURED healthy ratio only, which also clears the streak;
//   4. a window with no calls: "no calls", never healthy and never a page, and it
//      touches neither the streak nor the alert; a handful of calls is too few;
//   5. a failed read of either count measures nothing, pages nothing, clears nothing;
//   6. disarmed: measure, send nothing, clear nothing.
import {
  runRegalCallOutcomesCheck,
  completedCallsFrom,
  formatRegalCallOutcomesAlert,
  formatRegalCallOutcomesRecovery,
  COMPLETED_CALL_REASONS,
  REGAL_CALL_OUTCOMES_KEY,
  REGAL_OUTCOME_WINDOW_MS,
  REGAL_OUTCOME_MIN_RATIO,
  REGAL_OUTCOME_MIN_CALLS,
  type RegalCallOutcomesResult,
} from "@/lib/monitor/regal-call-outcomes";
import { REGAL_CALL_REASONS } from "@/lib/regal/inbound-call";
import type { RegalReasonCounts } from "@/lib/monitor/regal-call-feed";
import { regalCallOutcomesReachedVerdict } from "@/lib/monitor/verdict-freshness";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.UTC(2026, 9, 2, 16, 0, 0);

// --- 1. the denominator -----------------------------------------------------------

eq(REGAL_OUTCOME_WINDOW_MS, 2 * 60 * 60_000, "the window is the last two hours");
eq(REGAL_OUTCOME_MIN_RATIO, 0.8, "the floor is 80%");
for (const r of ["body_unreadable", "event_id_unreadable", "not_call_completed"] as const) {
  assert(
    !COMPLETED_CALL_REASONS.includes(r),
    `${r} is not counted as a completed call: no outcome row could ever be written for it`,
  );
}
for (const r of REGAL_CALL_REASONS.filter(
  (x) => !["body_unreadable", "event_id_unreadable", "not_call_completed"].includes(x),
)) {
  assert(COMPLETED_CALL_REASONS.includes(r), `${r} IS a completed call with a readable event id`);
}
eq(
  completedCallsFrom({ candidate: 10, ai_agent: 600, agent_email_null: 300, not_call_completed: 4, body_unreadable: 2 }),
  910,
  "the AI's calls and the dialer's are counted: an outcome is wanted for every completed call",
);

// --- harness ------------------------------------------------------------------------

type Harness = {
  run: () => Promise<RegalCallOutcomesResult>;
  pages: { key: string; text: string }[];
  resolved: { key: string; text: string }[];
  streakHits: () => number;
  streakClears: () => number;
  since: string[];
};

/** A streak that behaves like the real one: the Nth consecutive hit reports true. */
function harness(opts: {
  counts: RegalReasonCounts | Error;
  written: number | Error;
  armed?: boolean;
  streak?: { hits: number };
}): Harness {
  const pages: { key: string; text: string }[] = [];
  const resolved: { key: string; text: string }[] = [];
  const streak = opts.streak ?? { hits: 0 };
  let clears = 0;
  const since: string[] = [];
  const run = () =>
    runRegalCallOutcomesCheck({
      loadReasonCounts: async (iso) => {
        since.push(iso);
        if (opts.counts instanceof Error) throw opts.counts;
        return opts.counts;
      },
      countOutcomes: async (iso) => {
        since.push(iso);
        if (opts.written instanceof Error) throw opts.written;
        return opts.written;
      },
      streak: async () => {
        streak.hits += 1;
        return streak.hits >= 2;
      },
      clearStreak: async () => {
        clears += 1;
        streak.hits = 0;
      },
      armed: opts.armed ?? true,
      notify: async (key, _ms, text) => {
        pages.push({ key, text });
      },
      resolve: async (key, text) => {
        resolved.push({ key, text });
        return true;
      },
      cooldownMs: 60 * 60_000,
      nowMs: NOW,
    });
  return { run, pages, resolved, streakHits: () => streak.hits, streakClears: () => clears, since };
}

const BUSY = { candidate: 80, ai_agent: 700, agent_email_null: 220 }; // 1,000 completed calls

// --- 2. the page ---------------------------------------------------------------------

{
  const streak = { hits: 0 };
  const first = harness({ counts: BUSY, written: 612, streak });
  const r1 = await first.run();
  eq(r1.status, "short", "612 of 1,000 is short");
  eq(first.since, [new Date(NOW - REGAL_OUTCOME_WINDOW_MS).toISOString(), new Date(NOW - REGAL_OUTCOME_WINDOW_MS).toISOString()], "both counts read the same two hour window");
  eq(first.pages.length, 0, "the FIRST short check stays quiet: one blip is not a page");
  eq(r1.status === "short" ? r1.paged : null, false, "and says it did not page");

  const second = harness({ counts: BUSY, written: 640, streak });
  const r2 = await second.run();
  eq(r2.status === "short" ? r2.paged : null, true, "the SECOND consecutive short check pages");
  eq(second.pages.map((p) => p.key), [REGAL_CALL_OUTCOMES_KEY], "on its own key");
  const text = second.pages[0].text;
  assert(text.includes("640") && text.includes("1,000"), "naming how many were stored of how many");
  assert(text.includes("64%"), "and the ratio");
  assert(/tag=regal-call-outcomes/.test(text), "and where the reason for each missing row is logged");
  eq(second.resolved.length, 0, "a short check clears nothing");
}
{
  // Just under the floor still pages, and the percentage never rounds up to it.
  const streak = { hits: 1 };
  const h = harness({ counts: BUSY, written: 799, streak });
  const r = await h.run();
  eq(r.status, "short", "79.9% is under the floor");
  assert(h.pages[0].text.includes("(79%)"), "and is displayed floored as 79%, never rounded up to the floor");
}

// --- 3. the all clear -----------------------------------------------------------------

{
  const streak = { hits: 1 };
  const h = harness({ counts: BUSY, written: 800, streak });
  const r = await h.run();
  eq(r.status, "healthy", "exactly 80% is healthy");
  eq(h.pages.length, 0, "healthy pages nothing");
  eq(h.resolved.map((x) => x.key), [REGAL_CALL_OUTCOMES_KEY], "a measured healthy ratio is what clears it");
  eq(h.streakClears(), 1, "and it resets the streak, so the next short check is a first one again");
  assert(h.resolved[0].text.includes("800") && h.resolved[0].text.includes("1,000"), "the all clear says what it measured");
}
{
  // More outcomes than counted events (the detector's insert failed while the
  // outcome's succeeded) is healthy, and never displayed above 100%.
  const h = harness({ counts: BUSY, written: 1_010 });
  const r = await h.run();
  eq(r.status, "healthy", "more outcomes than counted calls is healthy");
  assert(h.resolved[0].text.includes("(100%)") && !/10[1-9]%/.test(h.resolved[0].text), "and is printed as 100%, never above");
}

// --- 4. no calls, and too few to judge -------------------------------------------------

{
  const streak = { hits: 1 };
  const h = harness({ counts: { not_call_completed: 3, body_unreadable: 1 }, written: 0, streak });
  const r = await h.run();
  eq(r.status, "no-calls", "a window with no completed call is 'no calls'");
  eq([h.pages.length, h.resolved.length], [0, 0], "never a page, and never an all clear");
  eq([streak.hits, h.streakClears()], [1, 0], "and it neither adds to the streak nor clears it");
}
{
  const h = harness({ counts: {}, written: 0 });
  eq((await h.run()).status, "no-calls", "an empty window is 'no calls', not healthy");
}
{
  const h = harness({ counts: { candidate: REGAL_OUTCOME_MIN_CALLS - 1 }, written: 0, streak: { hits: 1 } });
  const r = await h.run();
  eq(r.status, "too-few", "a handful of calls is too few to judge a rate on");
  eq([h.pages.length, h.resolved.length, h.streakClears()], [0, 0, 0], "and decides nothing");
}
{
  const h = harness({ counts: { candidate: REGAL_OUTCOME_MIN_CALLS }, written: 0, streak: { hits: 1 } });
  eq((await h.run()).status, "short", "at the minimum, a rate is judged");
}

// --- 5. unreadable counts -------------------------------------------------------------

for (const [label, opts] of [
  ["the reason counts", { counts: new Error("rpc refused"), written: 900 }],
  ["the outcome count", { counts: BUSY, written: new Error("count refused") }],
] as const) {
  const streak = { hits: 1 };
  const h = harness({ ...opts, streak });
  const r = await h.run();
  eq(r.status, "unmeasured", `a failed read of ${label} measures nothing`);
  eq([h.pages.length, h.resolved.length, streak.hits, h.streakClears()], [0, 0, 1, 0], `and pages, clears and counts nothing (${label})`);
}

// --- 6. disarmed ----------------------------------------------------------------------

{
  const h = harness({ counts: BUSY, written: 100, armed: false, streak: { hits: 5 } });
  const r = await h.run();
  eq(r.status === "short" ? r.paged : null, false, "disarmed: short is measured and says it was not sent");
  eq(h.pages.length, 0, "disarmed sends nothing");
  const h2 = harness({ counts: BUSY, written: 990, armed: false });
  eq((await h2.run()).status, "healthy", "disarmed still measures healthy");
  eq(h2.resolved.length, 0, "disarmed clears nothing");
}

// --- the verdict ------------------------------------------------------------------------

assert(regalCallOutcomesReachedVerdict({ status: "healthy", received: 1000, written: 990 }), "healthy is a verdict");
assert(regalCallOutcomesReachedVerdict({ status: "short", received: 1000, written: 10, paged: true }), "short is a verdict");
assert(!regalCallOutcomesReachedVerdict({ status: "no-calls" }), "no calls is NOT a verdict");
assert(!regalCallOutcomesReachedVerdict({ status: "too-few", received: 3, written: 0 }), "too few is NOT a verdict");
assert(!regalCallOutcomesReachedVerdict({ status: "unmeasured", why: "x" }), "unmeasured is NOT a verdict");
assert(!regalCallOutcomesReachedVerdict(null), "a skipped check is NOT a verdict");

// --- the copy ---------------------------------------------------------------------------

{
  const page = formatRegalCallOutcomesAlert({ received: 1, written: 0 });
  assert(/1 completed call\b/.test(page), "one call reads as one call, not one calls");
  const ok = formatRegalCallOutcomesRecovery({ received: 1_000, written: 990 });
  assert(ok.includes("99%"), "the all clear carries its ratio");
}

finish();
