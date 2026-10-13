// #3667: when the offboarding automation says an advisor has left, Slate removes the
// invites on their upcoming calls BEFORE their Google account is archived, because
// once it is archived Google refuses every delete (`403 notACalendarUser`) and the
// lead keeps the departed advisor's invite beside the new one (measured 2026-10-13).
// The automation waits 10 seconds after telling Slate before it archives, so the
// clear runs inside a budget and says how far it got.
//
// Pure: no clock, no network, no database. The clock and the waits are injected
// (L524), so no test here waits for real.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-offboarding-clear-invites.ts
import { clearLeaverInvites, type LeaverInvite } from "../src/lib/offboarding/clear-invites.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const invite = (n: number): LeaverInvite => ({ bookingId: `b${n}`, eventId: `e${n}`, organizerEmail: "alana@trypennie.com" });

/** A clock the test moves, and a sleep that resolves only when the test says so. */
function fakeTime() {
  let now = 0;
  const sleepers: Array<{ until: number; resolve: () => void }> = [];
  return {
    nowMs: () => now,
    sleep: (ms: number) => new Promise<void>((resolve) => sleepers.push({ until: now + ms, resolve })),
    advance(ms: number) {
      now += ms;
      for (const s of sleepers.splice(0)) {
        if (s.until <= now) s.resolve();
        else sleepers.push(s);
      }
    },
  };
}

// Every invite is removed, silently, from the organizer's calendar.
{
  const t = fakeTime();
  const deleted: string[] = [];
  const r = await clearLeaverInvites({
    loadInvites: async () => [invite(1), invite(2), invite(3)],
    deleteInvite: async (email, id) => {
      deleted.push(`${email}/${id}`);
    },
    nowMs: t.nowMs,
    sleep: t.sleep,
    budgetMs: 6000,
    concurrency: 2,
  });
  eq(r, { total: 3, cleared: 3, failed: 0, unanswered: 0, notStarted: 0 }, "every invite on an upcoming call is cleared");
  eq(deleted.sort(), ["alana@trypennie.com/e1", "alana@trypennie.com/e2", "alana@trypennie.com/e3"],
    "each on the departed advisor's own calendar");
}

// One refused delete is counted on its own; it never stops the others (L767).
{
  const t = fakeTime();
  const r = await clearLeaverInvites({
    loadInvites: async () => [invite(1), invite(2), invite(3)],
    deleteInvite: async (_email, id) => {
      if (id === "e2") throw new Error("403 notACalendarUser");
    },
    nowMs: t.nowMs,
    sleep: t.sleep,
    budgetMs: 6000,
    concurrency: 1,
  });
  eq([r.cleared, r.failed], [2, 1], "a refused invite is one failure, and the rest are still cleared");
}

// Nothing to clear is a measured zero, and no delete is attempted.
{
  const t = fakeTime();
  let calls = 0;
  const r = await clearLeaverInvites({
    loadInvites: async () => [],
    deleteInvite: async () => {
      calls++;
    },
    nowMs: t.nowMs,
    sleep: t.sleep,
    budgetMs: 6000,
    concurrency: 4,
  });
  eq(r, { total: 0, cleared: 0, failed: 0, unanswered: 0, notStarted: 0 }, "no upcoming invites clears nothing");
  eq(calls, 0, "and calls Google for nothing");
}

// The budget: no new delete starts once it is spent, and the call returns at the
// budget even while a delete is still waiting on Google, so the reply always lands
// inside the automation's wait.
{
  const t = fakeTime();
  const started: string[] = [];
  const pending: Array<() => void> = [];
  const run = clearLeaverInvites({
    loadInvites: async () => [invite(1), invite(2), invite(3)],
    deleteInvite: async (_email, id) => {
      started.push(id);
      await Promise.resolve(); // both workers are under way before the clock moves
      if (id === "e1") {
        t.advance(7000); // e1 answers once the budget is already spent
        return;
      }
      await new Promise<void>((resolve) => pending.push(resolve)); // e2 never answers in time
    },
    nowMs: t.nowMs,
    sleep: t.sleep,
    budgetMs: 6000,
    concurrency: 2,
  });
  const r = await run;
  eq(started.includes("e3"), false, "no delete starts after the budget is spent");
  eq(r, { total: 3, cleared: 1, failed: 0, unanswered: 1, notStarted: 1 },
    "the result says how many were cleared, still waiting on Google, and never started");
  for (const p of pending) p();
}

// An unreadable list of invites throws: the caller reports it, it is never zero.
{
  const t = fakeTime();
  let threw = false;
  try {
    await clearLeaverInvites({
      loadInvites: async () => {
        throw new Error("bookings read failed");
      },
      deleteInvite: async () => {},
      nowMs: t.nowMs,
      sleep: t.sleep,
      budgetMs: 6000,
      concurrency: 2,
    });
  } catch {
    threw = true;
  }
  assert(threw, "a failed read of the advisor's bookings throws rather than reporting nothing to clear");
}

finish();
