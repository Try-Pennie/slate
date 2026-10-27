import { describe, it, expect, vi, beforeEach } from "vitest";

// #239/#248: when an agent leaves the bookable pool, Slate must stop their Google
// push-watch channels (so Google stops POSTing change notifications for someone we
// no longer book) and prune their cached busy_blocks (never read for a non-bookable
// agent, so they only bloat the table). cleanupOnPoolExit does both on the
// transition; reconcileOrphanedPoolExits is the periodic backstop that mops up
// agents that left the pool without going through the toggle (SF deactivation, or
// the ~100 orphaned watches the #238 flip benchmark left behind). Supabase is a
// mutable in-memory fake so idempotency is exercised for real; stopChannel is a spy.

const admin = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => admin.current }));

const stopChannelSpy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/google/calendar", async (importActual) => {
  const actual = await importActual<typeof import("./calendar")>();
  return { ...actual, stopChannel: stopChannelSpy };
});

vi.mock("@/lib/env", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/env")>();
  return { ...actual, googlePushUrl: () => "https://slate.example.com/api/google/push" };
});

const logSpy = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: logSpy }));

import { cleanupOnPoolExit, reconcileOrphanedPoolExits } from "./sync";

type Row = Record<string, unknown>;

/**
 * Minimal mutable supabase stand-in. Backs a few named tables with in-memory
 * arrays and applies eq/in/or/not/is filters against them, so update and delete
 * actually mutate the rows (proving idempotency) and delete({count}) returns the
 * number removed. Handles only the query shapes these two functions use.
 */
function matchOrTerm(r: Row, t: string): boolean {
  if (t === "bookable.eq.false") return r.bookable === false;
  if (t === "deactivated_at.not.is.null")
    return r.deactivated_at !== null && r.deactivated_at !== undefined;
  throw new Error("fake db: unhandled or-term " + t);
}

function fakeDb(tables: Record<string, Row[]>, faults: { deleteError?: string } = {}) {
  const from = (table: string) => {
    const rows = () => (tables[table] ??= []);
    let mode: "select" | "update" | "delete" = "select";
    let payload: Row = {};
    let wantCount = false;
    let headCount = false;
    const preds: Array<(r: Row) => boolean> = [];
    const b: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) headCount = true;
        return b;
      },
      update: (p: Row) => {
        mode = "update";
        payload = p;
        return b;
      },
      delete: (opts?: { count?: string }) => {
        mode = "delete";
        if (opts?.count) wantCount = true;
        return b;
      },
      eq: (col: string, val: unknown) => {
        preds.push((r) => r[col] === val);
        return b;
      },
      is: (col: string, val: unknown) => {
        // `.is(col, null)` matches SQL NULL, and a key absent from a fixture row
        // stands for exactly that, so undefined has to match too. Without this the
        // fake would answer "not null" for every column a test did not spell out,
        // which is the opposite of what PostgREST does.
        preds.push((r) => (val === null ? r[col] == null : r[col] === val));
        return b;
      },
      in: (col: string, vals: unknown[]) => {
        preds.push((r) => vals.includes(r[col]));
        return b;
      },
      not: (col: string, _op: string, _val: unknown) => {
        preds.push((r) => r[col] !== null && r[col] !== undefined);
        return b;
      },
      or: (str: string) => {
        const terms = str.split(",").map((t) => t.trim());
        preds.push((r) => terms.some((t) => matchOrTerm(r, t)));
        return b;
      },
      maybeSingle: async () => {
        const m = rows().filter((r) => preds.every((p) => p(r)));
        return { data: m[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => {
        const match = (r: Row) => preds.every((p) => p(r));
        if (mode === "select" && headCount) {
          return Promise.resolve({
            data: null,
            count: rows().filter(match).length,
            error: null,
          }).then(resolve);
        }
        if (mode === "update") {
          for (const r of rows()) if (match(r)) Object.assign(r, payload);
          return Promise.resolve({ error: null }).then(resolve);
        }
        if (mode === "delete") {
          // A failed delete: PostgREST removes nothing and returns a null count
          // alongside the error, which is exactly what `count ?? 0` used to
          // launder into a healthy-looking "0 blocks needed deleting" (#1165).
          if (faults.deleteError) {
            return Promise.resolve({
              count: null,
              error: { message: faults.deleteError },
            }).then(resolve);
          }
          const keep: Row[] = [];
          let removed = 0;
          for (const r of rows()) {
            if (match(r)) removed++;
            else keep.push(r);
          }
          tables[table] = keep;
          return Promise.resolve({ count: wantCount ? removed : null, error: null }).then(
            resolve,
          );
        }
        return Promise.resolve({ data: rows().filter(match), error: null }).then(resolve);
      },
    };
    return b;
  };
  return { from } as unknown as never;
}

beforeEach(() => {
  admin.current = null;
  stopChannelSpy.mockClear();
  stopChannelSpy.mockImplementation(async () => {});
  logSpy.error.mockClear();
});

describe("cleanupOnPoolExit", () => {
  function seed() {
    return {
      users: [{ id: "u1", email: "a@trypennie.com", bookable: false, deactivated_at: null }],
      agent_calendars: [
        {
          id: "c1",
          user_id: "u1",
          calendar_id: "primary",
          watch_channel_id: "ch1",
          watch_resource_id: "r1",
          watch_expiration: "2026-08-01T00:00:00Z",
        },
        {
          id: "c2",
          user_id: "u1",
          calendar_id: "team",
          watch_channel_id: null,
          watch_resource_id: null,
          watch_expiration: null,
        },
      ],
      busy_blocks: [{ user_id: "u1" }, { user_id: "u1" }, { user_id: "u2" }],
    } as Record<string, Row[]>;
  }

  it("stops live watches, nulls the watch columns, and prunes the agent's busy_blocks", async () => {
    const tables = seed();
    admin.current = fakeDb(tables);

    const res = await cleanupOnPoolExit("u1");

    expect(stopChannelSpy).toHaveBeenCalledTimes(1);
    expect(stopChannelSpy).toHaveBeenCalledWith("a@trypennie.com", "ch1", "r1");
    expect(res.watchesStopped).toBe(1);
    expect(res.blocksDeleted).toBe(2);
    // watch columns cleared so Google is no longer asked to push here
    expect(tables.agent_calendars[0].watch_channel_id).toBeNull();
    expect(tables.agent_calendars[0].watch_resource_id).toBeNull();
    expect(tables.agent_calendars[0].watch_expiration).toBeNull();
    // another agent's cached blocks are untouched
    expect(tables.busy_blocks).toEqual([{ user_id: "u2" }]);
  });

  it("is idempotent: a second run stops no watches and deletes no blocks", async () => {
    const tables = seed();
    admin.current = fakeDb(tables);
    await cleanupOnPoolExit("u1");
    stopChannelSpy.mockClear();

    const res = await cleanupOnPoolExit("u1");

    expect(stopChannelSpy).not.toHaveBeenCalled();
    expect(res.watchesStopped).toBe(0);
    expect(res.blocksDeleted).toBe(0);
  });

  // #1165: the prune used `const { count } = await ...delete({ count: "exact" })`
  // and ignored `error`, so a delete that FAILED reported `blocksDeleted: 0`,
  // indistinguishable from an agent who had no cached busy time at all. The
  // stale blocks the #248 backstop exists to remove then lingered with nothing
  // noticing. A failed prune must be a thrown error the caller logs, never a
  // zero.
  it("throws instead of reporting 0 blocks deleted when the busy_blocks prune fails", async () => {
    const tables = seed();
    admin.current = fakeDb(tables, { deleteError: "permission denied for table busy_blocks" });

    await expect(cleanupOnPoolExit("u1")).rejects.toThrow(/busy_blocks/);
  });

  // #1471/#1464: the prune deletes by user_id regardless of where the row came
  // from. That was safe while every row was a Google mirror or a booking's
  // write-through, both meaningless once someone leaves the pool. The OOO
  // fallback made it unsafe: its row is the ONLY thing blocking approved time
  // off when the agent's calendar event could not be created, and an agent
  // toggled out of the pool and back (or caught by the periodic backstop) lost
  // that protection with no record.
  it("keeps a block owned by an approved time off, and still prunes the rest", async () => {
    const tables = {
      users: [{ id: "u1", email: "a@trypennie.com", bookable: false, deactivated_at: null }],
      agent_calendars: [],
      busy_blocks: [
        { user_id: "u1", ooo_request_id: null }, // calendar mirror / booking write-through
        { user_id: "u1", ooo_request_id: "ooo-1" }, // approved time off's cover
      ],
    } as Record<string, Row[]>;
    admin.current = fakeDb(tables);

    const res = await cleanupOnPoolExit("u1");

    expect(res.blocksDeleted).toBe(1);
    // Visible in the count, not silent: the operator can see something survived.
    expect(res.blocksPreserved).toBe(1);
    expect(tables.busy_blocks).toEqual([{ user_id: "u1", ooo_request_id: "ooo-1" }]);
  });

  it("a failing stopChannel does not abort the cleanup (columns still nulled, blocks still pruned)", async () => {
    const tables = seed();
    admin.current = fakeDb(tables);
    stopChannelSpy.mockRejectedValueOnce(new Error("google down"));

    const res = await cleanupOnPoolExit("u1");

    expect(res.blocksDeleted).toBe(2);
    expect(tables.agent_calendars[0].watch_channel_id).toBeNull();
    expect(tables.busy_blocks).toEqual([{ user_id: "u2" }]);
  });
});

describe("reconcileOrphanedPoolExits", () => {
  function seed() {
    return {
      users: [
        // left the pool via the bookable flag
        { id: "u1", email: "a@trypennie.com", bookable: false, deactivated_at: null },
        // left the pool via deactivation (bypasses the toggle, e.g. SF offboarding)
        { id: "u2", email: "b@trypennie.com", bookable: true, deactivated_at: "2026-01-01T00:00:00Z" },
        // still routable (must be left alone)
        { id: "u3", email: "c@trypennie.com", bookable: true, deactivated_at: null },
      ],
      agent_calendars: [
        {
          id: "c1",
          user_id: "u1",
          calendar_id: "primary",
          watch_channel_id: "ch1",
          watch_resource_id: "r1",
          watch_expiration: "x",
        },
        {
          id: "c2",
          user_id: "u2",
          calendar_id: "primary",
          watch_channel_id: null,
          watch_resource_id: null,
          watch_expiration: null,
        },
        {
          id: "c3",
          user_id: "u3",
          calendar_id: "primary",
          watch_channel_id: "ch3",
          watch_resource_id: "r3",
          watch_expiration: "x",
        },
      ],
      busy_blocks: [
        { user_id: "u1" },
        { user_id: "u2" },
        { user_id: "u2" },
        { user_id: "u3" },
      ],
    } as Record<string, Row[]>;
  }

  it("tears down orphaned watches and prunes blocks only for agents that left the pool", async () => {
    const tables = seed();
    admin.current = fakeDb(tables);

    const res = await reconcileOrphanedPoolExits(50);

    expect(res.scanned).toBe(2); // u1 + u2
    expect(res.cleaned).toBe(1); // only u1 had a live watch to stop
    expect(res.blocksDeleted).toBe(3); // u1(1) + u2(2)
    // only the orphaned live watch was stopped, never the in-pool agent's
    expect(stopChannelSpy).toHaveBeenCalledTimes(1);
    expect(stopChannelSpy).toHaveBeenCalledWith("a@trypennie.com", "ch1", "r1");
    // u1's watch columns cleared; u3 (still in pool) untouched
    expect(tables.agent_calendars[0].watch_channel_id).toBeNull();
    expect(tables.agent_calendars[2].watch_channel_id).toBe("ch3");
    // only the still-routable agent's cached blocks survive
    expect(tables.busy_blocks).toEqual([{ user_id: "u3" }]);
  });

  // #4259: the placeholder advisor (#4200) is never bookable and is owed no activation,
  // so it has left the pool by construction: the backstop prunes the block each of its
  // calls wrote at create, once, and a second pass finds nothing. The missing block
  // repair asks the same rule (`whereStillInPool`, 0204) and never re-creates them, which
  // the real Postgres suite proves over both sweeps tick after tick
  // (verify-recreate-missing-busy-blocks-sql.ts); here, the backstop's half.
  it("prunes the placeholder's stacked call blocks once, and finds nothing to prune after (#4259)", async () => {
    const tables = {
      users: [
        { id: "ph", email: "marcia@trypennie.com", bookable: false, deactivated_at: null, bookable_pending_since: null, is_placeholder: true },
        { id: "u3", email: "c@trypennie.com", bookable: true, deactivated_at: null, bookable_pending_since: null },
      ],
      agent_calendars: [],
      busy_blocks: [
        { user_id: "ph", booking_id: "call-1", ooo_request_id: null },
        { user_id: "ph", booking_id: "call-2", ooo_request_id: null },
        { user_id: "u3", booking_id: "call-3", ooo_request_id: null },
      ],
    } as Record<string, Row[]>;
    admin.current = fakeDb(tables);

    const first = await reconcileOrphanedPoolExits(50);
    expect(first.scanned).toBe(1);
    expect(first.blocksDeleted).toBe(2);
    const second = await reconcileOrphanedPoolExits(50);
    expect(second.blocksDeleted).toBe(0);
    // CONTROL: the routable advisor's block is never in scope.
    expect(tables.busy_blocks).toEqual([{ user_id: "u3", booking_id: "call-3", ooo_request_id: null }]);
  });

  // #1165, the sweep's copy of the same defect: a failed bulk prune reported
  // `poolExitBlocksDeleted: 0` on the self-heal lane, which reads as "nothing
  // needed cleaning" rather than "this sweep did not run". The route already
  // catches and logs a throw and reports "error" for the tick, so failing loud
  // here is what makes the failure visible.
  // #1471: the bulk backstop is the second call site of the same delete, and it
  // reaches every non-routable agent at once, so an unscoped prune here undoes
  // the protection for everyone who has ever left the pool.
  it("the bulk backstop also keeps time-off-owned rows and reports how many", async () => {
    const tables = {
      users: [
        { id: "u1", email: "a@trypennie.com", bookable: false, deactivated_at: null },
        { id: "u2", email: "b@trypennie.com", bookable: true, deactivated_at: "2026-01-01T00:00:00Z" },
        { id: "u3", email: "c@trypennie.com", bookable: true, deactivated_at: null },
      ],
      agent_calendars: [],
      busy_blocks: [
        { user_id: "u1", ooo_request_id: null },
        { user_id: "u1", ooo_request_id: "ooo-1" },
        { user_id: "u2", ooo_request_id: "ooo-2" },
        { user_id: "u3", ooo_request_id: null },
      ],
    } as Record<string, Row[]>;
    admin.current = fakeDb(tables);

    const res = await reconcileOrphanedPoolExits(50);

    expect(res.blocksDeleted).toBe(1); // only u1's unowned row
    expect(res.blocksPreserved).toBe(2); // both time-off covers
    expect(tables.busy_blocks).toEqual([
      { user_id: "u1", ooo_request_id: "ooo-1" },
      { user_id: "u2", ooo_request_id: "ooo-2" },
      { user_id: "u3", ooo_request_id: null }, // still routable, never in scope
    ]);
  });

  it("throws instead of reporting 0 blocks deleted when the bulk prune fails", async () => {
    const tables = seed();
    admin.current = fakeDb(tables, { deleteError: "permission denied for table busy_blocks" });

    await expect(reconcileOrphanedPoolExits(50)).rejects.toThrow(/busy_blocks/);
  });

  it("returns zeroes and touches nothing when no agent has left the pool", async () => {
    const tables = {
      users: [{ id: "u3", email: "c@trypennie.com", bookable: true, deactivated_at: null }],
      agent_calendars: [
        { id: "c3", user_id: "u3", calendar_id: "primary", watch_channel_id: "ch3", watch_resource_id: "r3", watch_expiration: "x" },
      ],
      busy_blocks: [{ user_id: "u3" }],
    } as Record<string, Row[]>;
    admin.current = fakeDb(tables);

    const res = await reconcileOrphanedPoolExits(50);

    expect(res).toEqual({ scanned: 0, cleaned: 0, blocksDeleted: 0, blocksPreserved: 0 });
    expect(stopChannelSpy).not.toHaveBeenCalled();
    expect(tables.busy_blocks).toEqual([{ user_id: "u3" }]);
  });
});

describe("an activation in flight is not torn down (#2302)", () => {
  beforeEach(() => {
    stopChannelSpy.mockClear();
  });

  // The gate now establishes an agent's watches and loads their calendar BEFORE
  // the bookable write, so for the second or two in between they are a
  // non-bookable agent holding a live watch and fresh busy blocks: exactly what
  // this reconcile exists to reap. The selfheal lane runs every minute, so at a
  // window of a couple of seconds this fires on a few percent of activations, and
  // the result is invisible: cleanupOnPoolExit leaves sync_window_to alone, so the
  // coverage monitor still reads as healthy over an emptied cache (#1879).
  //
  // `bookable_pending_since` is the mark that says an activation is owed, so it is
  // the signal for "being built, do not tear down".
  it("leaves the watch and the blocks of somebody an activation is owed for", async () => {
    const tables = {
      users: [{ id: "u1", email: "a@trypennie.com", bookable: false, deactivated_at: null, bookable_pending_since: "2026-09-14T13:00:00.000Z" }],
      agent_calendars: [
        { id: "c1", user_id: "u1", calendar_id: "primary", watch_channel_id: "ch1", watch_resource_id: "r1" },
      ],
      busy_blocks: [{ id: "b1", user_id: "u1", ends_at: "2026-12-01T00:00:00.000Z" }],
    };
    admin.current = fakeDb(tables);
    const res = await reconcileOrphanedPoolExits(25);
    expect(res.cleaned).toBe(0);
    expect(stopChannelSpy).not.toHaveBeenCalled();
    expect(tables.busy_blocks).toHaveLength(1);
    expect(tables.agent_calendars[0].watch_channel_id).toBe("ch1");
  });

  it("still reaps somebody who simply left the pool", async () => {
    // The positive control. Without it the exclusion above could be doing nothing,
    // or everything, and both read as a passing test.
    const tables = {
      users: [{ id: "u1", email: "a@trypennie.com", bookable: false, deactivated_at: null, bookable_pending_since: null }],
      agent_calendars: [
        { id: "c1", user_id: "u1", calendar_id: "primary", watch_channel_id: "ch1", watch_resource_id: "r1" },
      ],
      busy_blocks: [{ id: "b1", user_id: "u1", ends_at: "2026-12-01T00:00:00.000Z" }],
    };
    admin.current = fakeDb(tables);
    const res = await reconcileOrphanedPoolExits(25);
    expect(res.cleaned).toBe(1);
    expect(stopChannelSpy).toHaveBeenCalled();
    expect(tables.busy_blocks).toHaveLength(0);
  });

  it("reaps a DEACTIVATED agent even while a mark is set, because they have left", async () => {
    // The exclusion is no broader than its reason (L324). It means "an activation
    // is being built", and somebody who has left the company is not that, whatever
    // stale mark their row carries.
    const tables = {
      users: [{ id: "u1", email: "a@trypennie.com", bookable: false, deactivated_at: "2026-09-01T00:00:00.000Z", bookable_pending_since: "2026-09-14T13:00:00.000Z" }],
      agent_calendars: [
        { id: "c1", user_id: "u1", calendar_id: "primary", watch_channel_id: "ch1", watch_resource_id: "r1" },
      ],
      busy_blocks: [{ id: "b1", user_id: "u1", ends_at: "2026-12-01T00:00:00.000Z" }],
    };
    admin.current = fakeDb(tables);
    const res = await reconcileOrphanedPoolExits(25);
    expect(res.cleaned).toBe(1);
    expect(tables.busy_blocks).toHaveLength(0);
  });
});
