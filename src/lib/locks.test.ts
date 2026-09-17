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

import { acquireLock } from "@/lib/locks";

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
