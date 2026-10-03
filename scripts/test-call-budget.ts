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
  withinCleanupBudget,
} from "../src/lib/call-budget.ts";
import { DeadlineExceededError, NO_DEADLINE } from "../src/lib/fetch-within-deadline.ts";
import type { ScheduleTimer } from "../src/lib/read-within-deadline.ts";
import { assert, eq, finish } from "./lib/harness.ts";

let t = 0;
const now = () => t;
const CONFIRM = { label: "the booking confirm", totalMs: 14_000 };

// Outside any budget a request gets exactly its own limit: the cron lanes.
{
  const d = deadlineWithinBudget(15_000, "supabase", now);
  eq(d.waitMs, 15_000, "no budget: the request's own limit");
  eq(d.reportAs, { label: "supabase", timeoutMs: 15_000, budget: null }, "no budget: the error names the request");
}

// Inside a budget with room to spare, the request's own limit still applies.
await withinCallBudget(
  14_000,
  "the booking confirm",
  async () => {
    t = 1_000;
    eq(deadlineWithinBudget(8_000, "google freeBusy", now).waitMs, 8_000, "room left: the request keeps its own limit");
    // Late in the budget the request gets only what is left. A miss still names
    // the CALL that was running, so the page says which dependency was slow, and
    // says the budget is what cut it short.
    t = 10_000;
    const late = deadlineWithinBudget(15_000, "supabase", now);
    eq(late.waitMs, 4_000, "late: the request waits only for what the budget has left");
    eq(
      late.reportAs,
      { label: "supabase", timeoutMs: 4_000, budget: CONFIRM },
      "late: a miss names the call in flight AND the budget that cut it short",
    );
    // A spent budget refuses to start anything, naming the call it refused.
    t = 14_000;
    let caught: unknown = null;
    try {
      deadlineWithinBudget(15_000, "supabase", now);
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof DeadlineExceededError, "spent: the next request fails at once instead of starting");
    eq((caught as DeadlineExceededError).label, "supabase", "spent: the error names the call it refused");
    eq((caught as DeadlineExceededError).budget, CONFIRM, "spent: and the budget that had run out");
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
        eq(d.reportAs.label, "google token mint", "and a miss names the mint");
        eq(d.reportAs.budget?.label, "google events.insert", "as part of the Google call");
        // The request inside its own call's budget is reported as the call, once.
        const req = deadlineWithinBudget(8_000, "google events.insert", now);
        eq(
          req.reportAs,
          { label: "google events.insert", timeoutMs: 8_000, budget: null },
          "the call's own request is reported against the call's own 8s, not as a budget miss",
        );
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
// it is bounded, and it is ONE allowance however many layers open it: a route's
// failure path and the service's alert beneath it share it rather than each
// adding another.
await withinCallBudget(
  1_000,
  "the booking confirm",
  async () => {
    t = 5_000;
    await withinCleanupBudget(
      2_000,
      "the booking cleanup",
      async () => {
        const d = deadlineWithinBudget(15_000, "supabase", now);
        eq(d.waitMs, 2_000, "cleanup after a spent confirm gets its own 2s, not nothing and not 15s");
        eq(d.reportAs.budget?.label, "the booking cleanup", "and a miss says the cleanup ran out");
        t = 6_500;
        await withinCleanupBudget(
          2_000,
          "the booking cleanup",
          async () => {
            eq(deadlineWithinBudget(15_000, "supabase", now).waitMs, 500, "a nested cleanup shares the allowance, it does not restart it");
          },
          now,
        );
      },
      now,
    );
  },
  now,
);
t = 0;

// Two cleanups opened ONE AFTER THE OTHER in one request (the service's page,
// then the route's failure path) share the allowance too: the second does not
// get a fresh 2 seconds just because the first has returned.
await withinCallBudget(
  1_000,
  "the booking confirm",
  async () => {
    t = 5_000;
    await withinCleanupBudget(2_000, "the booking cleanup", async () => {}, now);
    t = 6_500;
    await withinCleanupBudget(
      2_000,
      "the booking cleanup",
      async () => {
        eq(deadlineWithinBudget(15_000, "supabase", now).waitMs, 500, "a later cleanup in the same request reuses the first allowance");
      },
      now,
    );
  },
  now,
);
t = 0;

// The fetch is actually held to what is left. NO_DEADLINE opts out of the per
// call default only: inside a budget it still waits no longer than the budget
// has left, and a spent budget refuses it like any other call.
{
  const armed: number[] = [];
  const timer: ScheduleTimer = (ms) => {
    armed.push(ms);
    return () => {};
  };
  await fetchWithinBudget(async () => new Response("ok"), "https://x.test", {}, NO_DEADLINE, "x", timer, now);
  eq(armed, [], "outside a budget NO_DEADLINE arms nothing");
  await withinCallBudget(
    14_000,
    "the booking confirm",
    async () => {
      t = 11_000;
      await fetchWithinBudget(async () => new Response("ok"), "https://x.test", {}, 15_000, "supabase", timer, now);
      await fetchWithinBudget(async () => new Response("ok"), "https://x.test", {}, NO_DEADLINE, "x", timer, now);
      t = 14_000;
      let caught: unknown = null;
      await fetchWithinBudget(async () => new Response("ok"), "https://x.test", {}, NO_DEADLINE, "x", timer, now).catch((e: unknown) => {
        caught = e;
      });
      assert(caught instanceof DeadlineExceededError, "a spent budget refuses a NO_DEADLINE call too");
    },
    now,
  );
  eq(armed, [3_000, 3_000], "both the 15s call and the NO_DEADLINE call wait only the 3s the budget had left");
  t = 0;
}

finish();
