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
  requestLabel,
  withinCallBudget,
  withinCleanupBudget,
  withinOwnCleanupBudget,
} from "../src/lib/call-budget.ts";
import { DeadlineExceededError, NO_DEADLINE } from "../src/lib/fetch-within-deadline.ts";
import { forgetDependencyCalls, recentStall } from "../src/lib/dependency-stall.ts";
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

// #3145 (L1017): work STARTED inside a budget and still running once the scope
// that opened it has returned (a float, a raw after() callback, a waitUntil, a
// flight another request awaits) carries the budget's async context with it,
// because the context is copied into every continuation. Nobody is waiting on
// that budget any more, so it must stop governing the work, whichever writer
// deferred it. This is decided where the budget is READ, the one place that is
// safe for every writer, rather than by each writer remembering
// `outsideCallBudget`.
{
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let late: Promise<number> | null = null;
  await withinCallBudget(
    1_000,
    "the booking confirm",
    async () => {
      // Deferred without leaving the budget, the way a raw float or after() is.
      late = gate.then(() => deadlineWithinBudget(15_000, "supabase", now).waitMs);
    },
    now,
  );
  // The request has answered; its budget is long spent.
  t = 5_000;
  release();
  let lateWait: number | string = "never ran";
  try {
    lateWait = await late!;
  } catch (e) {
    lateWait = e instanceof Error ? e.message : String(e);
  }
  eq(lateWait, 15_000, "work outliving the scope that opened the budget gets its own limit, not the spent budget");

  // A budget opened by deferred work after the request ended is its own root:
  // a Google call made from it still gets its own expiry, rather than inheriting
  // the closed request's.
  let release2: () => void = () => {};
  const gate2 = new Promise<void>((r) => {
    release2 = r;
  });
  let nested: Promise<number> | null = null;
  t = 0;
  await withinCallBudget(
    1_000,
    "the booking confirm",
    async () => {
      nested = gate2.then(() =>
        withinCallBudget(8_000, "google freeBusy", async () => deadlineWithinBudget(15_000, "google freeBusy", now).waitMs, now),
      );
    },
    now,
  );
  t = 5_000;
  release2();
  eq(await nested!, 8_000, "a budget opened after the request closed is its own, not the closed one");

  // And the scope closing must not loosen a budget for work still INSIDE it: a
  // nested budget returning (a Google call finishing) leaves the confirm's in force.
  t = 0;
  await withinCallBudget(
    1_000,
    "the booking confirm",
    async () => {
      await withinCallBudget(8_000, "google freeBusy", async () => {}, now);
      t = 900;
      eq(deadlineWithinBudget(15_000, "supabase", now).waitMs, 100, "a nested budget returning does not close the request's");
    },
    now,
  );
  t = 0;
}

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

// #3439: a cleanup the request owes WHILE its own budget still has the whole
// allowance to spare (a lost race's rollback in the middle of a confirm) gets an
// allowance of its own. It ends inside the request's budget, so it adds nothing to
// the request's worst case, and it leaves the one shared allowance unopened for the
// failure path. Two such cleanups 3 seconds apart each get their whole 2 seconds,
// where the shared allowance gave the second nothing.
await withinCallBudget(
  12_000,
  "the booking confirm",
  async () => {
    t = 1_000;
    await withinOwnCleanupBudget(
      2_000,
      "the lost race cleanup",
      async () => {
        eq(deadlineWithinBudget(15_000, "supabase", now).waitMs, 2_000, "own allowance: the first cleanup gets 2s");
        t = 1_500;
        await withinCleanupBudget(
          2_000,
          "the booking cleanup",
          async () => {
            eq(deadlineWithinBudget(15_000, "supabase", now).waitMs, 1_500, "own allowance: a cleanup nested inside it shares it");
          },
          now,
        );
      },
      now,
    );
    t = 4_000;
    await withinOwnCleanupBudget(
      2_000,
      "the lost race cleanup",
      async () => {
        eq(deadlineWithinBudget(15_000, "supabase", now).waitMs, 2_000, "own allowance: a second cleanup 3s later gets its own 2s, not a spent one");
      },
      now,
    );
    // Back in the confirm, a call is held to the confirm's budget again, never to an
    // allowance that has ended.
    eq(deadlineWithinBudget(15_000, "supabase", now).waitMs, 8_000, "own allowance: the confirm's own calls keep the confirm's budget");
    // The request's failure path opens the shared allowance afresh: the lost race
    // cleanups above never opened it.
    t = 12_500;
    await withinCleanupBudget(
      2_000,
      "the booking cleanup",
      async () => {
        eq(deadlineWithinBudget(15_000, "supabase", now).waitMs, 2_000, "own allowance: the failure path still gets the whole shared 2s");
      },
      now,
    );
  },
  now,
);
t = 0;

// #3439: with less than the allowance left in the request's budget, an allowance of
// its own would run past the budget, and the request's worst case is sized as the
// budget plus ONE allowance. So it is the shared allowance, exactly as before, and
// the failure path after it reuses that one rather than getting another 2 seconds.
await withinCallBudget(
  12_000,
  "the booking confirm",
  async () => {
    t = 11_000;
    await withinOwnCleanupBudget(
      2_000,
      "the lost race cleanup",
      async () => {
        eq(deadlineWithinBudget(15_000, "supabase", now).waitMs, 2_000, "late cleanup: the shared allowance, opened now");
      },
      now,
    );
    t = 12_500;
    await withinCleanupBudget(
      2_000,
      "the booking cleanup",
      async () => {
        eq(deadlineWithinBudget(15_000, "supabase", now).waitMs, 500, "late cleanup: the failure path shares it, 12 plus 2 holds");
      },
      now,
    );
  },
  now,
);
t = 0;

// #3439: outside any request there is nothing to share and no budget to stay inside,
// so it is its own allowance, as `withinCleanupBudget` gives there.
await withinOwnCleanupBudget(
  2_000,
  "the lost race cleanup",
  async () => {
    eq(deadlineWithinBudget(15_000, "supabase", now).waitMs, 2_000, "no request: its own allowance");
  },
  now,
);

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

// #3300: the request's observer is told about every budgeted call it made, with the
// call's label and its own span, including one that failed, and nothing outside it.
{
  const timer: ScheduleTimer = () => () => {};
  const seen: { who: string; label: string; from: number; to: number }[] = [];
  const observer = (who: string) => ({
    call: (label: string, from: number, to: number) => seen.push({ who, label, from, to }),
  });
  // A fetch that takes time on the shared clock, so a span has a length.
  const slow = (ms: number, fail = false) => async () => {
    t += ms;
    if (fail) throw new Error("connection reset");
    return new Response("ok");
  };
  t = 1_000;
  await withinCallBudget(
    14_000,
    "the booking confirm",
    async () => {
      await fetchWithinBudget(slow(300), "https://x.test", {}, 15_000, "supabase", timer, now);
      // A Google call opens its own nested budget, and is still this request's.
      await withinCallBudget(8_000, "google freeBusy", () =>
        fetchWithinBudget(slow(500), "https://x.test", {}, 8_000, "google freeBusy", timer, now), now);
      await fetchWithinBudget(slow(200, true), "https://x.test", {}, 15_000, "supabase", timer, now).catch(() => null);
      // The failure path's allowance belongs to the same request.
      await withinCleanupBudget(2_000, "cleanup", () =>
        fetchWithinBudget(slow(50), "https://x.test", {}, 15_000, "supabase", timer, now), now);
    },
    now,
    observer("one"),
  );
  eq(
    seen,
    [
      { who: "one", label: "supabase", from: 1_000, to: 1_300 },
      { who: "one", label: "google freeBusy", from: 1_300, to: 1_800 },
      { who: "one", label: "supabase", from: 1_800, to: 2_000 },
      { who: "one", label: "supabase", from: 2_000, to: 2_050 },
    ],
    "observer: every call the request made, a failed one included, each with its own span",
  );

  // A call outside any budget, and a call deferred past the answer, belong to no
  // request's profile.
  seen.length = 0;
  await fetchWithinBudget(slow(10), "https://x.test", {}, 15_000, "supabase", timer, now);
  let deferred: Promise<unknown> | null = null;
  await withinCallBudget(
    14_000,
    "the booking confirm",
    async () => {
      deferred = Promise.resolve().then(async () => {
        await new Promise((r) => setTimeout(r, 0));
        return fetchWithinBudget(slow(10), "https://x.test", {}, 15_000, "supabase", timer, now);
      });
    },
    now,
    observer("two"),
  );
  await deferred;
  eq(seen, [], "observer: nothing outside the request's own scope is charged to it");

  // L748: two requests in flight in one isolate each see only their own calls.
  seen.length = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const a = withinCallBudget(
    14_000,
    "the booking confirm",
    async () => {
      await held;
      await fetchWithinBudget(slow(1), "https://a.test", {}, 15_000, "supabase", timer, now);
    },
    now,
    observer("a"),
  );
  const b = withinCallBudget(
    14_000,
    "the booking confirm",
    () => fetchWithinBudget(slow(1), "https://b.test", {}, 15_000, "google freeBusy", timer, now),
    now,
    observer("b"),
  );
  await b;
  release();
  await a;
  eq(
    seen.map((s) => `${s.who}:${s.label}`),
    ["b:google freeBusy", "a:supabase"],
    "observer: two requests interleaved in one isolate never see each other's calls",
  );
  t = 0;
}

// #3784: where each call was answered from. Supabase sits behind Cloudflare, so its
// answer carries a `cf-ray` whose suffix names the colo Supabase's edge served it at,
// which is the colo this Worker ran in. The observer is told it with the call; a call
// with no answer, or an answer with no ray (Google), names none. And this isolate
// remembers a slow call, inside a request or not, for the Google breaker page.
{
  forgetDependencyCalls();
  const timer: ScheduleTimer = () => () => {};
  const seen: { label: string; colo: string | null | undefined }[] = [];
  const observer = { call: (label: string, _from: number, _to: number, colo?: string | null) => seen.push({ label, colo }) };
  const answer = (ms: number, headers: Record<string, string> = {}, fail = false) => async () => {
    t += ms;
    if (fail) throw new Error("connection reset");
    return new Response("ok", { headers });
  };
  t = 10_000;
  await withinCallBudget(
    14_000,
    "the booking confirm",
    async () => {
      await fetchWithinBudget(answer(20, { "cf-ray": "8f2c1a9b4d5e6f70-SEA" }), "https://x.test", {}, 15_000, "supabase", timer, now);
      await fetchWithinBudget(answer(400), "https://x.test", {}, 8_000, "google freeBusy", timer, now);
      await fetchWithinBudget(answer(2_600, {}, true), "https://x.test", {}, 15_000, "supabase", timer, now).catch(() => null);
    },
    now,
    observer,
  );
  eq(
    seen,
    [
      { label: "supabase", colo: "SEA" },
      { label: "google freeBusy", colo: null },
      { label: "supabase", colo: null },
    ],
    "observer: each call says where it was answered from, and a call with no answer names nowhere",
  );
  eq(
    recentStall("supabase", now()),
    { ms: 2_600, at: now(), colo: "SEA" },
    "isolate: the slow Supabase call is remembered, with where this isolate's answers came from",
  );
  forgetDependencyCalls();
  await fetchWithinBudget(answer(2_100, { "cf-ray": "8f2c1a9b4d5e6f70-SEA" }), "https://x.test", {}, 15_000, "supabase", timer, now);
  eq(
    recentStall("supabase", now()),
    null,
    "isolate: a slow call outside any budget (a cron lane's statement, up to 7.9s while healthy) is not read as a stall",
  );
  forgetDependencyCalls();
  t = 0;
}

// #3298: the request a call belongs to is named by its ROOT budget, so a token
// mint inside a Google call's own nested budget still says it was for the booking
// confirm. Outside any request there is none, and a closed request names nothing.
{
  eq(requestLabel(), undefined, "request label: none outside any budget");
  let insideNested: string | undefined;
  let insideRoot: string | undefined;
  let afterRoot: () => string | undefined = () => "unset";
  await withinCallBudget(
    14_000,
    "the booking confirm",
    async () => {
      insideRoot = requestLabel();
      await withinCallBudget(8_000, "google freeBusy", async () => {
        insideNested = requestLabel();
      }, now);
      afterRoot = () => requestLabel();
    },
    now,
  );
  eq(insideRoot, "the booking confirm", "request label: the root budget names the request");
  eq(insideNested, "the booking confirm", "request label: a nested budget keeps the request's name, not its own");
  eq(afterRoot(), undefined, "request label: a request that has answered names nothing");
  eq(
    outsideCallBudget(() => requestLabel()),
    undefined,
    "request label: work run outside the budget names no request",
  );
}

finish();
