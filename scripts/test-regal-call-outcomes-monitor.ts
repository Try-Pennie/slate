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
  humanCallsFrom,
  formatRegalCallOutcomesAlert,
  formatRegalCallOutcomesRecovery,
  HUMAN_CALL_REASONS,
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
// Only a call with a human advisor on it is counted (#2950). An unanswered dialer
// attempt arrives with no talk time and is correctly refused, and an AI call is not
// the advisor's call, so neither can decide a show and neither may count as missing.
eq([...HUMAN_CALL_REASONS].sort(), ["candidate", "foreign_domain", "no_slate_user"], "only calls with a human advisor are counted");
for (const r of REGAL_CALL_REASONS.filter((x) => !["candidate", "foreign_domain", "no_slate_user"].includes(x))) {
  assert(!HUMAN_CALL_REASONS.includes(r), `${r} is not counted: it has no human advisor on it, or could not be read`);
}
eq(
  humanCallsFrom({ candidate: 10, foreign_domain: 3, no_slate_user: 2, ai_agent: 600, agent_email_null: 300, not_call_completed: 4 }),
  15,
  "the AI's calls and the dialer's unanswered attempts are not counted",
);
{
  // Measured on production 2026-10-01 17:12 to 17:17 UTC: 32 human calls, all stored,
  // beside 9 unanswered attempts and 1 AI call that are never stored. That is healthy.
  const h = harness({ counts: { candidate: 32, agent_email_null: 9, ai_agent: 1 }, written: 32 });
  const r = await h.run();
  eq(r.status, "healthy", "32 of 32 human calls stored is healthy, whatever the dialer did");
}

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
  /** When the table stored its first row; null for an empty table. Defaults to long ago. */
  firstOutcomeAtMs?: number | null | Error;
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
      firstOutcomeAtMs: async () => {
        const v = opts.firstOutcomeAtMs === undefined ? NOW - 30 * 24 * 60 * 60_000 : opts.firstOutcomeAtMs;
        if (v instanceof Error) throw v;
        return v;
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

const BUSY = { candidate: 700, foreign_domain: 200, no_slate_user: 100, ai_agent: 50, agent_email_null: 300 }; // 1,000 human calls

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
  const page = formatRegalCallOutcomesAlert({ received: 1, written: 0, windowMinutes: 120 });
  assert(/1 completed advisor call\b/.test(page), "one call reads as one call, not one calls");
  const ok = formatRegalCallOutcomesRecovery({ received: 1_000, written: 990, windowMinutes: 120 });
  assert(ok.includes("99%"), "the all clear carries its ratio");
}

// --- a freshly created table: the window starts at its first stored row ----------------
{
  // Deployed 10 minutes ago: the received count must not reach back two hours to calls
  // the new table could never have stored, or the first two checks after the deploy page.
  const first = NOW - 10 * 60_000;
  const h = harness({ counts: BUSY, written: 90, firstOutcomeAtMs: first });
  await h.run();
  eq(h.since, [new Date(first).toISOString(), new Date(first).toISOString()], "both counts start at the table's first stored row, not two hours back");
}
{
  // A table older than the window reads the full two hours.
  const h = harness({ counts: BUSY, written: 900, firstOutcomeAtMs: NOW - 5 * 60 * 60_000 });
  await h.run();
  eq(h.since, [new Date(NOW - REGAL_OUTCOME_WINDOW_MS).toISOString(), new Date(NOW - REGAL_OUTCOME_WINDOW_MS).toISOString()], "an older table reads the whole window");
}
{
  // An EMPTY table after calls arrived is the total failure this check exists for, so
  // it is judged, over the last 15 minutes only: long enough to see busy traffic, short
  // enough that calls from before the deploy age out within three checks.
  const streak = { hits: 1 };
  const h = harness({ counts: BUSY, written: 0, firstOutcomeAtMs: null, streak });
  const r = await h.run();
  eq(h.since, [new Date(NOW - 15 * 60_000).toISOString(), new Date(NOW - 15 * 60_000).toISOString()], "an empty table is judged over the last 15 minutes");
  eq(r.status === "short" ? r.paged : null, true, "and nothing stored while calls arrive still pages on the second check");
  assert(h.pages.length === 1 && h.pages[0].text.includes("last 15 minutes"), "and the page names the window it judged, not two hours");
  assert(!h.pages[0].text.includes("two hours"), "never the full window it did not read");
}
{
  // A table 40 minutes old: the page names 40 minutes.
  const streak = { hits: 1 };
  const h = harness({ counts: BUSY, written: 100, firstOutcomeAtMs: NOW - 40 * 60_000, streak });
  await h.run();
  assert(h.pages.length === 1 && h.pages[0].text.includes("last 40 minutes"), "a young table's page names its own window");
}
{
  // The first row lookup failing measures nothing.
  const h = harness({ counts: BUSY, written: 0, firstOutcomeAtMs: new Error("boom") });
  const r = await h.run();
  eq(r.status, "unmeasured", "an unreadable first row is unmeasured, never a page");
  eq(h.pages.length, 0, "and pages nothing");
}

finish();
