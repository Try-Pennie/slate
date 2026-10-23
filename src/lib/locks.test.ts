import { describe, it, expect, vi, beforeEach } from "vitest";

// #2542: `acquireLock` steals a stale claim with an UPDATE narrowed by
// `claimed_at < staleBefore`, and reads `data?.length` to decide whether it won.
// supabase-js resolves a refused statement as `{ data: null, error }`, so a
// statement that never RAN reads exactly like a claim somebody else holds.
//
// Here that is the SAFE side and the file says so, which is why it carries an
// `// error-ok:` rather than an `unwrap`: nothing double runs, the lane skips
// this tick, and the next one retries. What had never been asserted is that it
// really is that side. A steal that returned a claim token on a refused write
// would let two invocations run the same lane at once, which is the whole reason
// this table exists.
//
// Both directions in one fixture, so "returns null on everything" cannot satisfy
// the negative alone (L159).

const supabase = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => supabase);

import { acquireLock, makeLockLease, releaseLock, renewLock, type RenewLockResult } from "@/lib/locks";

type Result = { data: unknown; error: { message: string } | null };

/** A `sync_locks` table whose insert always collides, so the steal is reached. */
function locksWhoseStealAnswers(steal: Result) {
  const builder: Record<string, unknown> = {
    update: () => builder,
    eq: () => builder,
    lt: () => builder,
    select: async () => steal,
    insert: async () => ({ error: { message: "duplicate key value" } }),
  };
  return { from: () => builder };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("acquireLock when the steal cannot run (#2542)", () => {
  it("does NOT claim the key when the update is refused", async () => {
    supabase.supabaseAdmin.mockReturnValue(
      locksWhoseStealAnswers({ data: null, error: { message: "statement timeout" } }),
    );

    expect(await acquireLock("sync", 60_000)).toBeNull();
  });

  it("CONTROL: a steal that really transitioned the row DOES claim it", async () => {
    supabase.supabaseAdmin.mockReturnValue(
      locksWhoseStealAnswers({ data: [{ key: "sync" }], error: null }),
    );

    expect(await acquireLock("sync", 60_000)).not.toBeNull();
  });

  it("CONTROL: a live claim held by somebody else transitions nothing and is refused", async () => {
    supabase.supabaseAdmin.mockReturnValue(locksWhoseStealAnswers({ data: [], error: null }));

    expect(await acquireLock("sync", 60_000)).toBeNull();
  });
});

// #3120: a run that outlives its TTL lets the next tick take the key, and then two
// runs write at once with the older one unaware. A lease renews its own claim while
// the run works, and tells the run to stop once the claim is somebody else's.
describe("renewLock (#3120)", () => {
  function locksWhoseRenewalAnswers(result: Result) {
    const eqs: [string, string][] = [];
    const builder: Record<string, unknown> = {
      update: () => builder,
      eq: (col: string, val: string) => {
        eqs.push([col, val]);
        return builder;
      },
      select: async () => result,
    };
    return { db: { from: () => builder }, eqs };
  }

  it("moves the claim forward only while it is still ours, and returns the new token", async () => {
    const { db, eqs } = locksWhoseRenewalAnswers({ data: [{ key: "sync" }], error: null });
    supabase.supabaseAdmin.mockReturnValue(db);
    const next = await renewLock("sync", "2026-10-03T10:00:00.000Z");
    expect(next.ok).toBe(true);
    // Compare and swap on OUR token: a claim another run has taken is never renewed.
    expect(eqs).toEqual([
      ["key", "sync"],
      ["claimed_at", "2026-10-03T10:00:00.000Z"],
    ]);
  });

  it("reports the claim TAKEN when the renewal ran and matched nothing", async () => {
    supabase.supabaseAdmin.mockReturnValue(locksWhoseRenewalAnswers({ data: [], error: null }).db);
    expect(await renewLock("sync", "2026-10-03T10:00:00.000Z")).toEqual({ ok: false, why: "taken" });
  });

  it("reports the renewal REFUSED, not taken, when the statement could not run (L11)", async () => {
    supabase.supabaseAdmin.mockReturnValue(
      locksWhoseRenewalAnswers({ data: null, error: { message: "statement timeout" } }).db,
    );
    expect(await renewLock("sync", "2026-10-03T10:00:00.000Z")).toEqual({ ok: false, why: "refused" });
  });
});

describe("makeLockLease (#3120)", () => {
  const TTL = 120_000;

  it("answers held without a round trip inside a third of the TTL", async () => {
    const clock = { ms: 0 };
    const renew = vi.fn(async () => ({ ok: true as const, token: "t2" }));
    const lease = makeLockLease("k", "t1", TTL, { now: () => clock.ms, renew });
    clock.ms = TTL / 3 - 1;
    expect(await lease.stillHeld()).toBe(true);
    expect(renew).not.toHaveBeenCalled();
  });

  it("renews once due, and carries the new token for the release", async () => {
    const clock = { ms: 0 };
    const renew = vi.fn(async () => ({ ok: true as const, token: "t2" }));
    const lease = makeLockLease("k", "t1", TTL, { now: () => clock.ms, renew });
    clock.ms = TTL / 3;
    expect(await lease.stillHeld()).toBe(true);
    expect(renew).toHaveBeenCalledWith("k", "t1");
    expect(lease.token()).toBe("t2");
    // And the next renewal swaps from the NEW token.
    clock.ms += TTL / 3;
    await lease.stillHeld();
    expect(renew).toHaveBeenLastCalledWith("k", "t2");
  });

  it("keeps a run that is working past its TTL holding the key, renewal by renewal", async () => {
    const clock = { ms: 0 };
    let n = 1;
    const renew = vi.fn(async () => ({ ok: true as const, token: `t${++n}` }));
    const lease = makeLockLease("k", "t1", TTL, { now: () => clock.ms, renew });
    for (let i = 0; i < 10; i++) {
      clock.ms += TTL / 2;
      expect(await lease.stillHeld()).toBe(true);
    }
    expect(renew).toHaveBeenCalledTimes(10);
  });

  it("shares one renewal between concurrent askers, so the run never races itself", async () => {
    const clock = { ms: TTL };
    let release: (v: RenewLockResult) => void = () => {};
    const renew = vi.fn(() => new Promise<RenewLockResult>((r) => (release = r)));
    const lease = makeLockLease("k", "t1", TTL, { now: () => clock.ms, renew });
    clock.ms = TTL * 2;
    const asks = Promise.all([lease.stillHeld(), lease.stillHeld(), lease.stillHeld()]);
    expect(renew).toHaveBeenCalledTimes(1);
    release({ ok: true, token: "t2" });
    expect(await asks).toEqual([true, true, true]);
  });

  it("says stop once the claim is taken, and never resumes", async () => {
    const clock = { ms: 0 };
    const renew = vi.fn(async (): Promise<RenewLockResult> => ({ ok: false, why: "taken" }));
    const lease = makeLockLease("k", "t1", TTL, { now: () => clock.ms, renew });
    expect(lease.stopReason()).toBeNull();
    clock.ms = TTL;
    expect(await lease.stillHeld()).toBe(false);
    expect(lease.stopReason()).toBe("taken");
    renew.mockResolvedValue({ ok: true, token: "t9" });
    clock.ms += TTL;
    expect(await lease.stillHeld()).toBe(false);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  // L11: a renewal the database refused stops the run just as safely, since
  // nothing shows the claim is still ours, but it must never read as another run
  // having taken over.
  // A renewal that THROWS (a deadline, a network fault) is a refusal too. It must
  // answer stop rather than reject, or the run's caller reads the rejection as its
  // own failure and records a streak about a sync that never failed.
  it("treats a renewal that throws as refused, and answers stop rather than rejecting", async () => {
    const clock = { ms: 0 };
    const renew = vi.fn(async (): Promise<RenewLockResult> => {
      throw new Error("deadline exceeded");
    });
    const lease = makeLockLease("k", "t1", TTL, { now: () => clock.ms, renew });
    clock.ms = TTL;
    await expect(lease.stillHeld()).resolves.toBe(false);
    expect(lease.stopReason()).toBe("refused");
    renew.mockResolvedValue({ ok: true, token: "t9" });
    clock.ms += TTL;
    expect(await lease.stillHeld()).toBe(false);
  });

  it("stops on a refused renewal too, and says it was refused rather than taken", async () => {
    const clock = { ms: 0 };
    const renew = vi.fn(async (): Promise<RenewLockResult> => ({ ok: false, why: "refused" }));
    const lease = makeLockLease("k", "t1", TTL, { now: () => clock.ms, renew });
    clock.ms = TTL;
    expect(await lease.stillHeld()).toBe(false);
    expect(lease.stopReason()).toBe("refused");
    renew.mockResolvedValue({ ok: true, token: "t9" });
    clock.ms += TTL;
    expect(await lease.stillHeld()).toBe(false);
    expect(lease.stopReason()).toBe("refused");
  });
});

// #4180: a release says what it did, so the canary's lease endpoint can answer it, and it never
// throws, so a release in a `finally` cannot replace the outcome it follows.
describe("releaseLock (#4180)", () => {
  function locksWhoseDeleteAnswers(result: Result | Error) {
    const eqs: [string, string][] = [];
    const builder: Record<string, unknown> = {
      delete: () => builder,
      eq: (col: string, val: string) => {
        eqs.push([col, val]);
        return builder;
      },
      select: async () => {
        if (result instanceof Error) throw result;
        return result;
      },
    };
    return { db: { from: () => builder }, eqs };
  }

  it("answers released when our claim was deleted, narrowed to our own token", async () => {
    const { db, eqs } = locksWhoseDeleteAnswers({ data: [{ key: "k" }], error: null });
    supabase.supabaseAdmin.mockReturnValue(db);
    expect(await releaseLock("k", "t1")).toBe("released");
    expect(eqs).toEqual([
      ["key", "k"],
      ["claimed_at", "t1"],
    ]);
  });

  it("answers not-held when no claim of ours remains, which is what a second release finds", async () => {
    supabase.supabaseAdmin.mockReturnValue(locksWhoseDeleteAnswers({ data: [], error: null }).db);
    expect(await releaseLock("k", "t1")).toBe("not-held");
  });

  it("answers refused, never throwing, when the delete could not run", async () => {
    supabase.supabaseAdmin.mockReturnValue(locksWhoseDeleteAnswers({ data: null, error: { message: "statement timeout" } }).db);
    expect(await releaseLock("k", "t1")).toBe("refused");
    supabase.supabaseAdmin.mockReturnValue(locksWhoseDeleteAnswers(new Error("fetch failed")).db);
    expect(await releaseLock("k", "t1")).toBe("refused");
  });
});
