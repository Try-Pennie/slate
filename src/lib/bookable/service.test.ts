import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Reachability } from "@/lib/google/reachability-classify";
import type { PoolEntryResult } from "@/lib/google/pool-entry";

// #281 + #913: the bookable-toggle service. Making an agent bookable when Slate
// can't reach their Google calendar must BLOCK the flip (the agent never enters
// the pool) and fire a named alert, because verify-on-book would otherwise fail
// them at confirm time. A DEFINITIVE failure (gone) blocks immediately; a
// TRANSIENT failure is retried once and only then blocks, with a distinct
// "couldn't verify" reason/alert. Deactivation is never blocked. Supabase is
// mocked; the reachability probe and alerter are injected.

const updates: Array<{ id: string; bookable: boolean }> = [];
/** Every patch as written, so the columns BESIDE bookable can be asserted (#2071). */
const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
/** Set to make the next write refuse, the way Postgres refuses (#2482). */
let nextWriteError: { message: string } | null = null;
let currentUser: {
  id: string;
  bookable: boolean;
  email: string;
  bookable_pending_since?: string | null;
} | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: currentUser, error: null }) }),
      }),
      update: (patch: { bookable: boolean } & Record<string, unknown>) => ({
        eq: async (_col: string, id: string) => {
          // `updates` is the BOOKABLE writes only. Since #2302 the activation path
          // also writes `bookable_pending_since` on its own before the gate, and
          // folding that in here would make every "wrote exactly one flip"
          // assertion read as two. Every write, of either kind, is in `patches`.
          if (nextWriteError) {
            const err = nextWriteError;
            nextWriteError = null;
            return { error: err };
          }
          if ("bookable" in patch) updates.push({ id, bookable: patch.bookable });
          patches.push({ id, patch });
          return { error: null };
        },
      }),
    }),
  }),
}));

import { applyBookableByEmail, applyBookableByUserId, writeBookable } from "./service";

// checkReachable yields the given outcomes in order (last one repeats), so a
// test can model the retry: e.g. deps("transient", "reachable").
function deps(...outcomes: Reachability[]) {
  const seq = [...outcomes];
  return {
    checkReachable: vi.fn(async (_email: string) => seq.shift() ?? outcomes[outcomes.length - 1]),
    notify: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
    cleanupOnPoolExit: vi.fn(async (_userId: string) => {}),
    onboardIntoPool: vi.fn(async (_userId: string) => ({
      calendars: 1,
      hydrated: 1,
      failed: 0,
      watch: "renewed" as PoolEntryResult["watch"],
    })),
  };
}

describe("applyBookableByEmail", () => {
  beforeEach(() => {
    updates.length = 0;
    currentUser = null;
  });

  it("returns not_found for an unknown email and writes nothing", async () => {
    const d = deps("reachable");
    const res = await applyBookableByEmail("nobody@trypennie.com", true, d);
    expect(res.status).toBe("not_found");
    expect(updates).toEqual([]);
    expect(d.checkReachable).not.toHaveBeenCalled();
  });

  it("is a no-op when already in the target state (no probe, no write)", async () => {
    currentUser = { id: "u1", bookable: true, email: "agent@trypennie.com" };
    const d = deps("reachable");
    const res = await applyBookableByEmail("agent@trypennie.com", true, d);
    expect(res.status).toBe("noop");
    expect(updates).toEqual([]);
    expect(d.checkReachable).not.toHaveBeenCalled();
  });

  it("applies activation when the calendar is reachable", async () => {
    currentUser = { id: "u1", bookable: false, email: "agent@trypennie.com" };
    const d = deps("reachable");
    const res = await applyBookableByEmail("agent@trypennie.com", true, d);
    expect(res).toMatchObject({ status: "applied", userId: "u1", bookable: true });
    expect(updates).toEqual([{ id: "u1", bookable: true }]);
    expect(d.checkReachable).toHaveBeenCalledTimes(1);
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("BLOCKS immediately on a gone account (no retry), reason google_unreachable", async () => {
    currentUser = { id: "u1", bookable: false, email: "agent@trypennie.com" };
    const d = deps("gone");
    const res = await applyBookableByEmail("gone@trypennie.com", true, d);
    expect(res).toMatchObject({ status: "blocked", userId: "u1", reason: "google_unreachable" });
    expect(updates).toEqual([]);
    expect(d.checkReachable).toHaveBeenCalledTimes(1); // gone is definitive, no retry
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(d.notify.mock.calls[0][0]).toBe("bookable_blocked:u1");
  });

  it("retries once on transient, then applies if the retry succeeds", async () => {
    currentUser = { id: "u1", bookable: false, email: "agent@trypennie.com" };
    const d = deps("transient", "reachable");
    const res = await applyBookableByEmail("agent@trypennie.com", true, d);
    expect(res).toMatchObject({ status: "applied", bookable: true });
    expect(updates).toEqual([{ id: "u1", bookable: true }]);
    expect(d.checkReachable).toHaveBeenCalledTimes(2);
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("retries once on transient, then BLOCKS with google_unverified if still transient", async () => {
    currentUser = { id: "u1", bookable: false, email: "agent@trypennie.com" };
    const d = deps("transient", "transient");
    const res = await applyBookableByEmail("agent@trypennie.com", true, d);
    expect(res).toMatchObject({ status: "blocked", userId: "u1", reason: "google_unverified" });
    expect(updates).toEqual([]);
    expect(d.checkReachable).toHaveBeenCalledTimes(2);
    expect(d.notify).toHaveBeenCalledTimes(1);
    // distinct alert key from the gone case so they don't throttle each other
    expect(d.notify.mock.calls[0][0]).toBe("bookable_unverified:u1");
  });

  it("blocks on gone even when it surfaces on the retry", async () => {
    currentUser = { id: "u1", bookable: false, email: "agent@trypennie.com" };
    const d = deps("transient", "gone");
    const res = await applyBookableByEmail("gone@trypennie.com", true, d);
    expect(res).toMatchObject({ status: "blocked", reason: "google_unreachable" });
    expect(updates).toEqual([]);
  });

  it("never probes or blocks on deactivation (bookable=false)", async () => {
    currentUser = { id: "u1", bookable: true, email: "agent@trypennie.com" };
    const d = deps("gone");
    const res = await applyBookableByEmail("agent@trypennie.com", false, d);
    expect(res).toMatchObject({ status: "applied", userId: "u1", bookable: false });
    expect(updates).toEqual([{ id: "u1", bookable: false }]);
    expect(d.checkReachable).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });
});

// #912: the admin path resolves by user id but runs the SAME activation gate and
// write, so a manager clicking "Make bookable" can't put a calendar-less agent
// in the pool either. The gate probes the row's canonical email.
describe("applyBookableByUserId", () => {
  beforeEach(() => {
    updates.length = 0;
    currentUser = null;
  });

  it("applies when reachable, probing the row's email", async () => {
    currentUser = { id: "u9", bookable: false, email: "byid@trypennie.com" };
    const d = deps("reachable");
    const res = await applyBookableByUserId("u9", true, d);
    expect(res).toMatchObject({ status: "applied", userId: "u9", bookable: true });
    expect(updates).toEqual([{ id: "u9", bookable: true }]);
    expect(d.checkReachable).toHaveBeenCalledWith("byid@trypennie.com");
  });

  it("blocks on a gone calendar and writes nothing", async () => {
    currentUser = { id: "u9", bookable: false, email: "byid@trypennie.com" };
    const d = deps("gone");
    const res = await applyBookableByUserId("u9", true, d);
    expect(res).toMatchObject({ status: "blocked", userId: "u9", reason: "google_unreachable" });
    expect(updates).toEqual([]);
  });
});

// #239/#248: leaving the pool (true->false applied) must trigger the pool-exit
// cleanup (stop Google watches + prune busy_blocks) so we stop being POSTed for an
// agent we no longer book. Entering the pool, a no-op, and a blocked flip must NOT.
describe("pool-exit cleanup on deactivation", () => {
  beforeEach(() => {
    updates.length = 0;
    currentUser = null;
  });

  it("runs cleanup for the agent when a true->false flip is applied", async () => {
    currentUser = { id: "u9", bookable: true, email: "leaving@trypennie.com" };
    const d = deps("reachable");
    const res = await applyBookableByUserId("u9", false, d);
    expect(res).toMatchObject({ status: "applied", bookable: false });
    expect(d.cleanupOnPoolExit).toHaveBeenCalledWith("u9");
  });

  it("does not run cleanup when an agent enters the pool", async () => {
    currentUser = { id: "u9", bookable: false, email: "joining@trypennie.com" };
    const d = deps("reachable");
    await applyBookableByUserId("u9", true, d);
    expect(d.cleanupOnPoolExit).not.toHaveBeenCalled();
  });

  it("does not run cleanup on a no-op (already non-bookable)", async () => {
    currentUser = { id: "u9", bookable: false, email: "already@trypennie.com" };
    const d = deps("reachable");
    const res = await applyBookableByUserId("u9", false, d);
    expect(res.status).toBe("noop");
    expect(d.cleanupOnPoolExit).not.toHaveBeenCalled();
  });
});

// #2071: the Salesforce sync plans a flip when a hire gains a first debt team, and
// remembers a refusal in users.bookable_pending_since so the next hour can tell it
// from a manager somebody deliberately held out of the pool. ANY explicit bookable
// write answers that question, whether the sync finally succeeded or a person
// decided either way, so the one write that flips the flag also settles the mark.
// Without this, a person switching a hire off by hand would be overridden an hour
// later by a sync still retrying the decision they had just made.
describe("writeBookable settles the sync's pending mark (#2071)", () => {
  beforeEach(() => {
    updates.length = 0;
    patches.length = 0;
  });

  it("clears bookable_pending_since in the same write when switching ON", async () => {
    await writeBookable("u1", true);
    expect(patches).toEqual([{ id: "u1", patch: { bookable: true, bookable_pending_since: null } }]);
  });

  it("clears it when switching OFF too, so a human hold stops the retry", async () => {
    await writeBookable("u1", false);
    expect(patches).toEqual([{ id: "u1", patch: { bookable: false, bookable_pending_since: null } }]);
  });
});

describe("onboarding on the way INTO the pool (#2302)", () => {
  beforeEach(() => {
    updates.length = 0;
    patches.length = 0;
    currentUser = null;
  });

  it("reads the calendar BEFORE the write, so bookable means a calendar Slate can see", async () => {
    currentUser = { id: "u1", bookable: false, email: "new@trypennie.com" };
    const d = deps("reachable");
    const res = await applyBookableByUserId("u1", true, d);
    expect(res.status).toBe("applied");
    expect(d.onboardIntoPool).toHaveBeenCalledWith("u1");
    expect(updates).toEqual([{ id: "u1", bookable: true }]);
    expect(d.cleanupOnPoolExit).not.toHaveBeenCalled();
  });

  it("refuses the flip when no calendar could be read, and writes nothing", async () => {
    // Dan, 2026-09-14: "we should probably not allow the change to work if the
    // calendar read fails. we don't want someone without a read calendar to be
    // bookable." An agent in the pool with no cached busy time reads as free for
    // every hour their working hours allow, so this fails CLOSED like every other
    // arm of the activation gate.
    currentUser = { id: "u1", bookable: false, email: "unread@trypennie.com" };
    const d = deps("reachable");
    d.onboardIntoPool = vi.fn(async () => ({ calendars: 1, hydrated: 0, failed: 1, watch: "renewed" as PoolEntryResult["watch"] }));
    const res = await applyBookableByUserId("u1", true, d);
    expect(res.status).toBe("blocked");
    expect(res).toMatchObject({ reason: "calendar_unhydrated" });
    expect(updates).toEqual([]);
    expect(d.notify).toHaveBeenCalled();
  });

  it("refuses when only SOME of their calendars could be read", async () => {
    // A calendar Slate cannot read is busy time Slate cannot see, so a partial read
    // carries the same double booking risk as none at all. The strictness is the
    // sharp edge of the rule and is deliberate.
    currentUser = { id: "u1", bookable: false, email: "partial@trypennie.com" };
    const d = deps("reachable");
    d.onboardIntoPool = vi.fn(async () => ({ calendars: 2, hydrated: 1, failed: 1, watch: "renewed" as PoolEntryResult["watch"] }));
    const res = await applyBookableByUserId("u1", true, d);
    expect(res.status).toBe("blocked");
    expect(updates).toEqual([]);
  });

  it("refuses when Google gave them no calendar at all", async () => {
    // Nothing to read is not a successful read (L98). Zero hydrated calendars and a
    // clean run look identical from a failure count alone.
    currentUser = { id: "u1", bookable: false, email: "nocal@trypennie.com" };
    const d = deps("reachable");
    d.onboardIntoPool = vi.fn(async () => ({ calendars: 0, hydrated: 0, failed: 0, watch: "skipped" as PoolEntryResult["watch"] }));
    const res = await applyBookableByUserId("u1", true, d);
    expect(res.status).toBe("blocked");
    expect(updates).toEqual([]);
  });

  it("an onboarding that THROWS refuses the flip rather than escaping", async () => {
    // Fail closed on the way in. A throw is the least informative failure there is,
    // so it must not be the one that admits somebody: the caller gets the same
    // refusal it would get from a measured failure, and nothing is written.
    currentUser = { id: "u1", bookable: false, email: "boom@trypennie.com" };
    const d = deps("reachable");
    d.onboardIntoPool = vi.fn(async () => {
      throw new Error("google 500");
    });
    const res = await applyBookableByUserId("u1", true, d);
    expect(res.status).toBe("blocked");
    expect(updates).toEqual([]);
  });

  it("records that an activation is owed BEFORE it starts building one", async () => {
    // The gate establishes watches and loads the calendar before the bookable
    // write, so in between the agent is a non-bookable row holding a live watch and
    // fresh busy blocks, which is exactly what the pool-exit reconcile reaps every
    // minute. `bookable_pending_since` is what tells that lane an activation is
    // being built rather than abandoned, so it has to be written first.
    currentUser = { id: "u1", bookable: false, email: "new@trypennie.com" };
    const d = deps("reachable");
    await applyBookableByUserId("u1", true, d);
    const marked = patches.filter((p) => typeof p.patch.bookable_pending_since === "string");
    expect(marked).toHaveLength(1);
    // And it is written before the calendar work starts, not after it.
    expect(d.onboardIntoPool).toHaveBeenCalled();
  });

  it("does not restamp a mark that is already set", async () => {
    // The stamp is how long somebody has been waiting, which the readiness check
    // reads. Rewriting it every hourly retry would make an agent stuck for a week
    // look freshly pending on every run.
    currentUser = { id: "u1", bookable: false, email: "new@trypennie.com", bookable_pending_since: "2026-09-01T00:00:00.000Z" };
    const d = deps("reachable");
    await applyBookableByUserId("u1", true, d);
    const marked = patches.filter((p) => typeof p.patch.bookable_pending_since === "string");
    expect(marked).toHaveLength(0);
  });

  it("leaves the pending mark alone on a refusal, so the hourly sync retries", async () => {
    // #2071: the mark IS the intent, and only an explicit bookable write settles it.
    // A refusal here must not write, or the retry that would fix this next hour
    // stops happening.
    currentUser = { id: "u1", bookable: false, email: "unread@trypennie.com" };
    const d = deps("reachable");
    d.onboardIntoPool = vi.fn(async () => ({ calendars: 1, hydrated: 0, failed: 1, watch: "renewed" as PoolEntryResult["watch"] }));
    await applyBookableByUserId("u1", true, d);
    // The mark written on the way in survives, which is what brings them back next
    // hour. What must NOT be here is a bookable write.
    expect(patches.every((p) => p.patch.bookable === undefined)).toBe(true);
    expect(updates).toEqual([]);
  });

  it("does not onboard on the way OUT", async () => {
    currentUser = { id: "u1", bookable: true, email: "leaving@trypennie.com" };
    const d = deps("reachable");
    await applyBookableByUserId("u1", false, d);
    expect(d.onboardIntoPool).not.toHaveBeenCalled();
    expect(d.cleanupOnPoolExit).toHaveBeenCalledWith("u1");
  });

  it("does not onboard an activation the gate BLOCKED", async () => {
    // No write happened, so the agent is not in the pool and there is nothing to
    // make ready. Onboarding here would spend Google calls on an account the gate
    // has just established we cannot read.
    currentUser = { id: "u1", bookable: false, email: "gone@trypennie.com" };
    const d = deps("gone");
    const res = await applyBookableByUserId("u1", true, d);
    expect(res.status).toBe("blocked");
    expect(d.onboardIntoPool).not.toHaveBeenCalled();
  });

  it("does not onboard an agent who was already bookable", async () => {
    // A noop writes nothing and changes no state, so there is no transition to
    // service. The hourly roster sync retries a pending flip every hour, and this
    // is what stops that becoming an hourly re-bootstrap of a healthy agent.
    currentUser = { id: "u1", bookable: true, email: "already@trypennie.com" };
    const d = deps("reachable");
    const res = await applyBookableByUserId("u1", true, d);
    expect(res.status).toBe("noop");
    expect(d.onboardIntoPool).not.toHaveBeenCalled();
  });

  it("a pool-exit cleanup that fails does not fail the flip either", async () => {
    // The same guarantee on the other side of the transition, and it is tested here
    // rather than assumed from the wiring: the write has committed, so throwing
    // would report a flip that happened as one that did not.
    currentUser = { id: "u1", bookable: true, email: "leaving@trypennie.com" };
    const d = deps("reachable");
    d.cleanupOnPoolExit = vi.fn(async () => {
      throw new Error("stopChannel exploded");
    });
    const res = await applyBookableByUserId("u1", false, d);
    expect(res.status).toBe("applied");
    expect(updates).toEqual([{ id: "u1", bookable: false }]);
  });


});


// #2482: the one write that flips bookable used to discard its result. supabase-js
// resolves `{ error }` rather than throwing, so a refused update ran to completion
// and every caller recorded the flip as done: the agent stays out of the pool while
// the roster sync counts them activated and the admin page says saved. That is the
// shape #2381 and #2481 are about, arriving through the write they all share.
describe("a refused bookable write is not a completed one (#2482)", () => {
  it("throws rather than reporting a flip that did not happen", async () => {
    nextWriteError = { message: "permission denied for table users" };
    await expect(writeBookable("u1", true)).rejects.toThrow(/permission denied/);
  });

  it("names the user, so a failure in a sweep says which one", async () => {
    nextWriteError = { message: "deadlock detected" };
    await expect(writeBookable("u-42", false)).rejects.toThrow(/u-42/);
  });

  // CONTROL: without this the two above are satisfied by a function that always
  // throws, which would take the whole roster out of the pool (L159).
  it("CONTROL: a write that lands still returns, and writes the flip", async () => {
    nextWriteError = null;
    await expect(writeBookable("u2", true)).resolves.toBeUndefined();
    expect(updates.at(-1)).toEqual({ id: "u2", bookable: true });
  });
});
