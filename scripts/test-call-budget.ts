/**
 * #3102: one expiry shared across every call made inside a piece of work. The
 * clock is injected and moved by hand, so nothing here waits for real time.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-call-budget.ts
 */
import {
  deadlineWithinBudget,
  fetchWithinBudget,
  outsideCallBudget,
  withinCallBudget,
  withinFreshCallBudget,
} from "../src/lib/call-budget.ts";
import { DeadlineExceededError, NO_DEADLINE } from "../src/lib/fetch-within-deadline.ts";
import type { ScheduleTimer } from "../src/lib/read-within-deadline.ts";
import { assert, eq, finish } from "./lib/harness.ts";

let t = 0;
const now = () => t;

// Outside any budget a request gets exactly its own limit: the cron lanes.
{
  const d = deadlineWithinBudget(15_000, "supabase", now);
  eq(d.waitMs, 15_000, "no budget: the request's own limit");
  eq(d.reportAs, { label: "supabase", timeoutMs: 15_000 }, "no budget: the error names the request");
}

// Inside a budget with room to spare, the request's own limit still applies.
await withinCallBudget(
  14_000,
  "the booking confirm",
  async () => {
    t = 1_000;
    eq(deadlineWithinBudget(8_000, "google freeBusy", now).waitMs, 8_000, "room left: the request keeps its own limit");
    // Late in the budget the request gets only what is left, and the error it
    // would raise names the BUDGET, so the page says what actually ran out.
    t = 10_000;
    const late = deadlineWithinBudget(15_000, "supabase", now);
    eq(late.waitMs, 4_000, "late: the request waits only for what the budget has left");
    eq(late.reportAs, { label: "the booking confirm", timeoutMs: 14_000 }, "late: a miss names the budget");
    // A spent budget refuses to start anything.
    t = 14_000;
    let caught: unknown = null;
    try {
      deadlineWithinBudget(15_000, "supabase", now);
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof DeadlineExceededError, "spent: the next request fails at once instead of starting");
    eq((caught as DeadlineExceededError).label, "the booking confirm", "spent: the error names the budget");
  },
  now,
);
t = 0;

// Budgets nest and the inner one can only be tighter. A Google call opens its own
// 8 second budget: early in the confirm that is its own, late in the confirm the
// confirm's expiry wins.
await withinCallBudget(
  14_000,
  "the booking confirm",
  async () => {
    await withinCallBudget(
      8_000,
      "google events.insert",
      async () => {
        t = 3_000;
        const d = deadlineWithinBudget(8_000, "google token mint", now);
        eq(d.waitMs, 5_000, "a mint 3s into a Google call gets the 5s the call has left, not 8s more");
        eq(d.reportAs.label, "google events.insert", "and a miss names the Google call");
      },
      now,
    );
    t = 12_000;
    await withinCallBudget(
      8_000,
      "google events.insert",
      async () => {
        eq(deadlineWithinBudget(8_000, "google events.insert", now).waitMs, 2_000, "late in the confirm, the confirm's expiry wins");
      },
      now,
    );
  },
  now,
);
t = 0;

// Work deferred past the response leaves the budget, or a webhook send would
// inherit an expiry meant for the lead and fail for no reason of its own.
await withinCallBudget(
  1_000,
  "the booking confirm",
  async () => {
    t = 5_000;
    await outsideCallBudget(async () => {
      eq(deadlineWithinBudget(15_000, "supabase", now).waitMs, 15_000, "outside the budget: the request's own limit again");
    });
  },
  now,
);
t = 0;

// Cleanup after a spent budget gets its own small allowance rather than none,
// and it is bounded rather than open ended.
await withinCallBudget(
  1_000,
  "the booking confirm",
  async () => {
    t = 5_000;
    await withinFreshCallBudget(
      2_000,
      "the booking cleanup",
      async () => {
        const d = deadlineWithinBudget(15_000, "supabase", now);
        eq(d.waitMs, 2_000, "cleanup after a spent confirm gets its own 2s, not nothing and not 15s");
        eq(d.reportAs.label, "the booking cleanup", "and a miss names the cleanup");
      },
      now,
    );
  },
  now,
);
t = 0;

// The fetch is actually held to what is left, and NO_DEADLINE stays unbounded.
{
  const armed: number[] = [];
  const timer: ScheduleTimer = (ms) => {
    armed.push(ms);
    return () => {};
  };
  await withinCallBudget(
    14_000,
    "the booking confirm",
    async () => {
      t = 11_000;
      await fetchWithinBudget(async () => new Response("ok"), "https://x.test", {}, 15_000, "supabase", timer, now);
      await fetchWithinBudget(async () => new Response("ok"), "https://x.test", {}, NO_DEADLINE, "x", timer, now);
    },
    now,
  );
  eq(armed, [3_000], "the request's timer is armed for the 3s the budget had left; NO_DEADLINE arms none");
}

finish();
