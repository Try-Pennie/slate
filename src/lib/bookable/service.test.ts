import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Reachability } from "@/lib/google/reachability-classify";
import type { PoolEntryResult } from "@/lib/google/pool-entry";
import type { ActivationHoursOutcome } from "./activation-hours";

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
  attributes?: Record<string, unknown> | null;
} | null = null;
/** Set to make the next lookup of the row refuse (#3028). */
let nextLookupError: { message: string } | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (nextLookupError) {
              const error = nextLookupError;
              nextLookupError = null;
              return { data: null, error };
            }
            return { data: currentUser, error: null };
          },
        }),
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

// #2085: the flip itself lives in routable-write.ts, which owns every write to
// bookable and deactivated_at and is driven against a real filtering store in
// routable-write.test.ts. Here it is the seam: a recorder that writes into the same
// arrays and refuses the same way, so these tests stay about what the SERVICE decides
// to write, not about the write.
vi.mock("@/lib/bookable/routable-write", () => ({
  writeBookable: async (id: string, bookable: boolean) => {
    if (nextWriteError) {
      const err = nextWriteError;
      nextWriteError = null;
      throw new Error(`bookable write for ${id} failed: ${err.message}`);
    }
    updates.push({ id, bookable });
    patches.push({ id, patch: { bookable, bookable_pending_since: null } });
  },
}));

import { applyBookableByEmail, applyBookableByUserId, BookableLookupError } from "./service";
import {
  ACTIVATION_BUDGET_MS,
  MAX_ACTIVATIONS_PER_RUN,
  ROSTER_RUN_LOCK_TTL_MS,
} from "./activation-allowance";

// checkReachable yields the given outcomes in order (last one repeats), so a
// test can model the retry: e.g. deps("transient", "reachable").
function deps(...outcomes: Reachability[]) {
  const seq = [...outcomes];
  return {
    checkReachable: vi.fn(async (_email: string) => seq.shift() ?? outcomes[outcomes.length - 1]),
    notify: vi.fn(async (_key: string, _cooldownMs: number, _text: string) => {}),
    cleanupOnPoolExit: vi.fn(async (_userId: string) => {}),
    onboardIntoPool: vi.fn(async (_userId: string, _opts: { withinBudget: () => boolean }) => ({
      calendars: 1,
      hydrated: 1,
      failed: 0,
      contended: 0,
      watch: "renewed" as PoolEntryResult["watch"],
      outOfBudget: false,
    })),
    // #2627: the cal.com week import that follows an admitted calendar. It records
    // when it ran relative to the bookable write, so the ORDER can be asserted.
    importHours: vi.fn(async (_user: { id: string; email: string }, _remainingMs: () => number): Promise<ActivationHoursOutcome> => {
      importedBeforeWrite.push(updates.length === 0);
      return { kind: "imported" as const, timezone: "America/Los_Angeles", rules: 5, changes: [] };
    }),
    // #2317: the gate's deadline is measured against this, never the real clock,
    // so every test in this file runs inside its budget unless it says otherwise.
    now: () => 1_000_000,
  };
}

/** For each import call, whether the bookable write had NOT yet happened. */
const importedBeforeWrite: boolean[] = [];

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
    expect(d.onboardIntoPool).toHaveBeenCalledWith("u1", expect.objectContaining({ withinBudget: expect.any(Function) }));
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
    d.onboardIntoPool = vi.fn(async () => ({ calendars: 1, hydrated: 0, failed: 1, contended: 0, watch: "renewed" as PoolEntryResult["watch"], outOfBudget: false }));
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
    d.onboardIntoPool = vi.fn(async () => ({ calendars: 2, hydrated: 1, failed: 1, contended: 0, watch: "renewed" as PoolEntryResult["watch"], outOfBudget: false }));
    const res = await applyBookableByUserId("u1", true, d);
    expect(res.status).toBe("blocked");
    expect(updates).toEqual([]);
  });

  it("refuses when Google gave them no calendar at all", async () => {
    // Nothing to read is not a successful read (L98). Zero hydrated calendars and a
    // clean run look identical from a failure count alone.
    currentUser = { id: "u1", bookable: false, email: "nocal@trypennie.com" };
    const d = deps("reachable");
    d.onboardIntoPool = vi.fn(async () => ({ calendars: 0, hydrated: 0, failed: 0, contended: 0, watch: "skipped" as PoolEntryResult["watch"], outOfBudget: false }));
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
    d.onboardIntoPool = vi.fn(async () => ({ calendars: 1, hydrated: 0, failed: 1, contended: 0, watch: "renewed" as PoolEntryResult["watch"], outOfBudget: false }));
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



// #2627: a hire used to enter the pool on the seeded Eastern week and wait up to a
// day for the importer. Once the calendar is admitted, the gate imports their
// cal.com week, BEFORE the bookable write so they enter on the right hours, and
// nothing the import meets can stop the activation.
describe("importing cal.com hours on activation (#2627)", () => {
  beforeEach(() => {
    updates.length = 0;
    patches.length = 0;
    importedBeforeWrite.length = 0;
    currentUser = null;
  });

  it("imports after the calendar is admitted and before the bookable write", async () => {
    currentUser = { id: "u1", bookable: false, email: "nshort@trypennie.com" };
    const d = deps("reachable");
    const res = await applyBookableByUserId("u1", true, d);
    expect(res.status).toBe("applied");
    expect(d.importHours).toHaveBeenCalledTimes(1);
    expect(d.importHours.mock.calls[0][0]).toEqual({ id: "u1", email: "nshort@trypennie.com" });
    expect(d.onboardIntoPool).toHaveBeenCalled();
    expect(importedBeforeWrite).toEqual([true]);
    expect(updates).toEqual([{ id: "u1", bookable: true }]);
  });

  it("hands the import what is LEFT of the gate's own budget", async () => {
    currentUser = { id: "u1", bookable: false, email: "nshort@trypennie.com" };
    const d = deps("reachable");
    await applyBookableByUserId("u1", true, d);
    const remaining = d.importHours.mock.calls[0][1];
    // The fake clock stands still, so all of the budget is left.
    expect(remaining()).toBe(ACTIVATION_BUDGET_MS);
  });

  it("a skipped import (cal.com failed) still activates", async () => {
    currentUser = { id: "u1", bookable: false, email: "nshort@trypennie.com" };
    const d = deps("reachable");
    d.importHours = vi.fn(async () => ({
      kind: "skipped" as const,
      reason: "calcom-rate-limited" as const,
      detail: "rate-limited",
    }));
    const res = await applyBookableByUserId("u1", true, d);
    expect(res.status).toBe("applied");
    expect(updates).toEqual([{ id: "u1", bookable: true }]);
  });

  it("an import that THROWS still activates: it is contained at the call site", async () => {
    // The import promises never to throw, and this does not rely on the promise:
    // containment in the collaborator is lost the day somebody injects another one.
    currentUser = { id: "u1", bookable: false, email: "nshort@trypennie.com" };
    const d = deps("reachable");
    d.importHours = vi.fn(async () => {
      throw new Error("cal.com exploded");
    });
    const res = await applyBookableByUserId("u1", true, d);
    expect(res.status).toBe("applied");
    expect(updates).toEqual([{ id: "u1", bookable: true }]);
  });

  it("does not import when the gate refuses, on the way out, or on a noop", async () => {
    currentUser = { id: "u1", bookable: false, email: "gone@trypennie.com" };
    const blocked = deps("gone");
    await applyBookableByUserId("u1", true, blocked);
    expect(blocked.importHours).not.toHaveBeenCalled();

    const unread = deps("reachable");
    unread.onboardIntoPool = vi.fn(async () => ({ calendars: 1, hydrated: 0, failed: 1, contended: 0, watch: "renewed" as PoolEntryResult["watch"], outOfBudget: false }));
    await applyBookableByUserId("u1", true, unread);
    expect(unread.importHours).not.toHaveBeenCalled();

    currentUser = { id: "u1", bookable: true, email: "leaving@trypennie.com" };
    const leaving = deps("reachable");
    await applyBookableByUserId("u1", false, leaving);
    expect(leaving.importHours).not.toHaveBeenCalled();

    const already = deps("reachable");
    await applyBookableByUserId("u1", true, already);
    expect(already.importHours).not.toHaveBeenCalled();
  });
});

// #2317: the activation gate makes several Google calls before it writes, and
// none of them carried a deadline. A wait with no deadline cannot fail, only
// hang, which is worse than failing because it is indistinguishable from
// slowness and still holds whatever it acquired (L110). On the admin toggle a
// hung Google is a hung click; inside the hourly roster lane one slow agent eats
// the invocation budget the Salesforce and Twilio halves share.
//
// The clock is injected, so the boundary is drivable without waiting for one.
describe("the activation gate's deadline (#2317)", () => {
  beforeEach(() => {
    updates.length = 0;
    patches.length = 0;
    currentUser = null;
  });

  /** deps whose clock jumps forward by `stepMs` on every read. */
  function timed(stepMs: number) {
    const d = deps("reachable");
    let t = 1_000_000;
    return {
      ...d,
      now: () => {
        const at = t;
        t += stepMs;
        return at;
      },
    };
  }

  it("applies normally when the whole gate fits inside the budget", async () => {
    currentUser = { id: "u1", bookable: false, email: "quick@trypennie.com" };
    const d = timed(1);
    const res = await applyBookableByUserId("u1", true, d);
    expect(res.status).toBe("applied");
    expect(updates).toEqual([{ id: "u1", bookable: true }]);
  });

  it("refuses with its OWN reason when the reachability probe ate the budget", async () => {
    // Its own reason rather than calendar_unhydrated, because the reader's next
    // move is different: wait and retry, not go and look at the sync lane.
    currentUser = { id: "u1", bookable: false, email: "slow@trypennie.com" };
    const d = timed(ACTIVATION_BUDGET_MS);
    const res = await applyBookableByUserId("u1", true, d);
    expect(res).toMatchObject({ status: "blocked", userId: "u1", reason: "activation_timed_out" });
    expect(updates).toEqual([]);
    // Nothing further was spent on a run that could not finish.
    expect(d.onboardIntoPool).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(d.notify.mock.calls[0][0]).toBe("bookable_blocked:u1");
  });

  it("refuses with activation_timed_out when the onboarding ran out part way", async () => {
    currentUser = { id: "u1", bookable: false, email: "partial@trypennie.com" };
    const d = deps("reachable");
    d.onboardIntoPool = vi.fn(async () => ({
      calendars: 3,
      hydrated: 1,
      failed: 0,
      contended: 0,
      watch: "renewed" as PoolEntryResult["watch"],
      outOfBudget: true,
    }));
    const res = await applyBookableByUserId("u1", true, d);
    expect(res).toMatchObject({ status: "blocked", reason: "activation_timed_out" });
    expect(updates).toEqual([]);
  });

  it("a MEASURED calendar failure outranks the budget", async () => {
    // Both are true at once when a calendar really failed and the run then ran
    // out. A measured failure names something a person can act on, so it wins;
    // answering "try again" over a broken calendar would send them away from it.
    currentUser = { id: "u1", bookable: false, email: "broken@trypennie.com" };
    const d = deps("reachable");
    d.onboardIntoPool = vi.fn(async () => ({
      calendars: 3,
      hydrated: 1,
      failed: 1,
      contended: 0,
      watch: "renewed" as PoolEntryResult["watch"],
      outOfBudget: true,
    }));
    const res = await applyBookableByUserId("u1", true, d);
    expect(res).toMatchObject({ status: "blocked", reason: "calendar_unhydrated" });
  });

  it("refuses with calendar_contended when another lane held a calendar (#2705)", async () => {
    // The pass measured nothing about that calendar, so the refusal is the retry
    // kind and the message must not send anybody to read sync errors that were
    // never recorded.
    currentUser = { id: "u1", bookable: false, email: "racing@trypennie.com" };
    const d = deps("reachable");
    d.onboardIntoPool = vi.fn(async () => ({
      calendars: 2,
      hydrated: 1,
      failed: 0,
      contended: 1,
      watch: "renewed" as PoolEntryResult["watch"],
      outOfBudget: false,
    }));
    const res = await applyBookableByUserId("u1", true, d);
    expect(res).toMatchObject({ status: "blocked", reason: "calendar_contended" });
    expect(updates).toEqual([]);
    const text = d.notify.mock.calls[0][2];
    expect(text).toContain("racing@trypennie.com");
    expect(text).not.toMatch(/sync lane/);
  });

  it("a MEASURED failure outranks a contended calendar (#2705)", async () => {
    currentUser = { id: "u1", bookable: false, email: "broken@trypennie.com" };
    const d = deps("reachable");
    d.onboardIntoPool = vi.fn(async () => ({
      calendars: 3,
      hydrated: 1,
      failed: 1,
      contended: 1,
      watch: "renewed" as PoolEntryResult["watch"],
      outOfBudget: false,
    }));
    const res = await applyBookableByUserId("u1", true, d);
    expect(res).toMatchObject({ status: "blocked", reason: "calendar_unhydrated" });
  });

  it("hands the onboarding a budget it can see", async () => {
    currentUser = { id: "u1", bookable: false, email: "new@trypennie.com" };
    const d = timed(1);
    await applyBookableByUserId("u1", true, d);
    const opts = d.onboardIntoPool.mock.calls[0][1] as { withinBudget: () => boolean };
    expect(typeof opts.withinBudget).toBe("function");
    expect(opts.withinBudget()).toBe(true);
  });

  it("leaves the pending mark alone on a timeout, so the hourly sync retries", async () => {
    // Same contract as every other refusal: the mark IS the intent and only an
    // explicit bookable write settles it. A timeout that cleared it would make a
    // slow Google look like a decision somebody made.
    currentUser = {
      id: "u1",
      bookable: false,
      email: "slow@trypennie.com",
      bookable_pending_since: "2026-09-01T00:00:00.000Z",
    };
    const d = timed(ACTIVATION_BUDGET_MS);
    await applyBookableByUserId("u1", true, d);
    expect(patches).toEqual([]);
  });

  it("never applies a deadline to LEAVING the pool", async () => {
    // Deactivation writes first and cleans up afterwards. There is no gate to
    // time out, and refusing to take somebody OUT of the pool because Google was
    // slow would be a defect of its own.
    currentUser = { id: "u1", bookable: true, email: "leaving@trypennie.com" };
    const d = timed(ACTIVATION_BUDGET_MS * 10);
    const res = await applyBookableByUserId("u1", false, d);
    expect(res).toMatchObject({ status: "applied", bookable: false });
    expect(updates).toEqual([{ id: "u1", bookable: false }]);
  });

  it("the budget is derived from the roster run's lock and its allowance", async () => {
    // Not a number somebody picked. The hourly roster run may attempt
    // MAX_ACTIVATIONS_PER_RUN activations in sequence inside one invocation whose
    // lock is ROSTER_RUN_LOCK_TTL_MS, and the activations are not the only work in
    // it, so they get half of that window between them. Asserted as arithmetic so
    // changing either constant has to be a decision about both.
    expect(ACTIVATION_BUDGET_MS).toBe(ROSTER_RUN_LOCK_TTL_MS / 2 / MAX_ACTIVATIONS_PER_RUN);
  });
});

// #3028: the hourly Twilio sync turns off every bookable advisor whose worker
// carries Redistribute, so a flip into the pool for one of them is undone within the
// hour. The refusal lives HERE rather than in one caller, because the admin action,
// the machine API and the Salesforce activation all arrive through this service,
// and a refusal held by only one of them is one other route away from not existing.
describe("an advisor Twilio holds on Redistribute (#3028)", () => {
  beforeEach(() => {
    updates.length = 0;
    patches.length = 0;
    currentUser = null;
    nextLookupError = null;
  });

  it("refuses the flip in by user id, before any Google call, and writes nothing", async () => {
    currentUser = { id: "u1", bookable: false, email: "held@trypennie.com", attributes: { redistribute_tagged: "Y" } };
    const d = deps("reachable");
    const res = await applyBookableByUserId("u1", true, d);
    expect(res).toEqual({ status: "blocked", userId: "u1", reason: "twilio_redistribute" });
    expect(updates).toEqual([]);
    // Not even the pending mark: nothing here is owed a retry by the calendar gate.
    expect(patches).toEqual([]);
    expect(d.checkReachable).not.toHaveBeenCalled();
    expect(d.onboardIntoPool).not.toHaveBeenCalled();
    // A refusal by design, not a fault, so nobody is paged about it.
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("refuses the same flip by email, which is the machine API's route", async () => {
    currentUser = { id: "u1", bookable: false, email: "held@trypennie.com", attributes: { redistribute_tagged: "Y" } };
    const d = deps("reachable");
    const res = await applyBookableByEmail("held@trypennie.com", true, d);
    expect(res).toEqual({ status: "blocked", userId: "u1", reason: "twilio_redistribute" });
    expect(updates).toEqual([]);
  });

  it("never refuses taking them OUT of the pool", async () => {
    currentUser = { id: "u1", bookable: true, email: "held@trypennie.com", attributes: { redistribute_tagged: "Y" } };
    const d = deps("reachable");
    const res = await applyBookableByUserId("u1", false, d);
    expect(res).toMatchObject({ status: "applied", bookable: false });
    expect(updates).toEqual([{ id: "u1", bookable: false }]);
  });

  it("admits an untagged advisor exactly as before", async () => {
    currentUser = { id: "u1", bookable: false, email: "free@trypennie.com", attributes: { debt_team: ["low"] } };
    const d = deps("reachable");
    const res = await applyBookableByUserId("u1", true, d);
    expect(res).toMatchObject({ status: "applied", bookable: true });
  });

  it("does not refuse a tagged row whose Twilio worker has gone, which the sync never turns off", async () => {
    currentUser = {
      id: "u1",
      bookable: false,
      email: "gone@trypennie.com",
      attributes: { redistribute_tagged: "Y", twilio_worker_missing_since: "2026-09-30T10:00:00.000Z" },
    };
    const d = deps("reachable");
    const res = await applyBookableByUserId("u1", true, d);
    expect(res).toMatchObject({ status: "applied", bookable: true });
  });

  // The Twilio sync's own reactivation reads the tag LIVE and flips before it
  // rewrites the stored mirror, so the row it flips still says tagged. Refusing it
  // on that stale copy would hold every reactivation back an hour and report it as
  // refused.
  it("lets the Twilio sync's live read overrule the stored copy of the tag", async () => {
    currentUser = { id: "u1", bookable: false, email: "back@trypennie.com", attributes: { redistribute_tagged: "Y", redistribute: "Y" } };
    const d = deps("reachable");
    const res = await applyBookableByUserId("u1", true, d, { liveTwilioUntagged: true });
    expect(res).toMatchObject({ status: "applied", bookable: true });
    expect(updates).toEqual([{ id: "u1", bookable: true }]);
  });

  // Fail closed: an unreadable row is never read as untagged. Its own error type,
  // so the admin action can say the check could not be made rather than showing a
  // scrubbed error page.
  it("throws its own error when the row cannot be read, and writes nothing", async () => {
    nextLookupError = { message: "connection reset" };
    const d = deps("reachable");
    await expect(applyBookableByUserId("u1", true, d)).rejects.toBeInstanceOf(BookableLookupError);
    expect(updates).toEqual([]);
    expect(d.checkReachable).not.toHaveBeenCalled();
  });
});
