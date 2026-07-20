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

function fakeDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const rows = () => (tables[table] ??= []);
    let mode: "select" | "update" | "delete" = "select";
    let payload: Row = {};
    let wantCount = false;
    const preds: Array<(r: Row) => boolean> = [];
    const b: Record<string, unknown> = {
      select: () => b,
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
        preds.push((r) => r[col] === val);
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
        if (mode === "update") {
          for (const r of rows()) if (match(r)) Object.assign(r, payload);
          return Promise.resolve({ error: null }).then(resolve);
        }
        if (mode === "delete") {
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

    expect(res).toEqual({ scanned: 0, cleaned: 0, blocksDeleted: 0 });
    expect(stopChannelSpy).not.toHaveBeenCalled();
    expect(tables.busy_blocks).toEqual([{ user_id: "u3" }]);
  });
});
