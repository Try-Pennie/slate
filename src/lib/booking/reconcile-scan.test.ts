import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #778: the reconcile-missing sweep (#431) scans active upcoming bookings newest
// first, because a missed write-through INSERT happens at create time. But a
// booking that committed its row SECONDS ago has not necessarily written its
// busy_block yet (the create path commits the booking, then moves the block), so
// the sweep used to "heal" a booking whose own write was still in flight. #770's
// UNIQUE (booking_id) index makes that harmless, but the sweep still did the work
// and still counted the booking as recreated - which recomputes buckets and fires
// a Slack alert claiming a write was missed when nothing was.
//
// The loader therefore holds a booking back for RECONCILE_MISSING_GRACE_MS, so
// the sweep only ever sees bookings whose block genuinely did not land.
//
// #3304: the same false page, from the other end of an agent's life. Leaving the
// pool deletes the agent's busy_blocks, booking write throughs included, and the
// offboarding sweep moves their bookings a few minutes later. In between, the sweep
// found a days old booking (outside the grace window) with no block, re-created one
// ON the departed agent and paged about a missed write that never happened. So the
// loader also holds back a booking whose advisor has left the pool, by the pool
// exit backstop's own predicate.

type PoolUser = { bookable: boolean; deactivated_at: string | null; bookable_pending_since: string | null };
type BookingRow = {
  id: string;
  assigned_user_id: string;
  starts_at: string;
  ends_at: string;
  created_at: string;
  users: PoolUser;
};

const state = vi.hoisted(() => ({
  rows: [] as BookingRow[],
  error: null as null | { message: string },
  /** busy_blocks rows that already exist, by booking. */
  blocks: [] as { booking_id: string; source: string }[],
  /** What the sweep wrote to busy_blocks. */
  upserted: [] as { booking_id: string; user_id: string }[],
  /** #3592: every call of the conditional insert RPC, and an error to answer each with. */
  rpcCalls: [] as { name: string; args: { p_booking_ids: string[]; p_created_before: string } }[],
  rpcErrors: [] as ({ message: string } | null)[],
  /** Bookings whose own block landed after the sweep's block read, before the insert. */
  landedBeforeInsert: [] as string[],
}));

/** One `column.[not.]op.literal` term, judged as Postgres would. Throws on any
 *  shape it cannot read, so a filter it does not understand fails loudly. */
function evalTerm(user: PoolUser, term: string): boolean {
  const m = /^([a-z_]+)\.(not\.)?(eq|is)\.(true|false|null)$/.exec(term.trim());
  if (!m || !(m[1] in user)) throw new Error(`fake db: unhandled or-term ${term}`);
  const [, column, negated, op, literal] = m;
  const value = user[column as keyof PoolUser];
  if (op === "eq" && value === null) return false;
  const hit = literal === "null" ? value === null : value === (literal === "true");
  return negated ? !hit : hit;
}

/** Chainable stand-in for the supabase client that HONORS the filters under test,
 *  so these assert what the sweep actually sees, not which methods were called.
 *
 *  The embedded `users` filters follow PostgREST: they drop the PARENT row only
 *  when the embed is an inner join (`users!inner(...)`). On a plain embed they
 *  would only empty the embedded object and every booking would still come back,
 *  so a loader that forgot `!inner` keeps every row here too. */
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    // #3592: `recreate_missing_busy_blocks`, modelled on migration 0204's WHERE: the
    // booking is in the fixture (active, upcoming, assigned), settled before the grace
    // cutoff it is handed, on an advisor still in the pool, and has no block yet. The
    // real statement is proved in Postgres by pnpm verify:recreate-missing-busy-blocks-sql.
    rpc: (name: string, args: { p_booking_ids: string[]; p_created_before: string }) => {
      state.rpcCalls.push({ name, args });
      const error = state.rpcErrors.shift() ?? null;
      if (error) return Promise.resolve({ data: null, error });
      if (name !== "recreate_missing_busy_blocks") throw new Error(`fake db: unexpected rpc ${name}`);
      const inPool = (u: PoolUser) => u.deactivated_at === null && (u.bookable || u.bookable_pending_since !== null);
      const rows = state.rows
        .filter((r) => args.p_booking_ids.includes(r.id))
        .filter((r) => r.created_at < args.p_created_before && inPool(r.users))
        .filter((r) => !state.blocks.some((b) => b.booking_id === r.id) && !state.landedBeforeInsert.includes(r.id))
        .map((r) => ({ booking_id: r.id, user_id: r.assigned_user_id }));
      state.upserted.push(...rows);
      for (const r of rows) state.blocks.push({ booking_id: r.booking_id, source: "slate" });
      return Promise.resolve({ data: rows, error: null });
    },
    from: (table: string) => {
      if (table === "busy_blocks") {
        let ids: string[] = [];
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          in: (_col: string, values: string[]) => {
            ids = values;
            return q;
          },
          upsert: (rows: { booking_id: string; user_id: string }[]) => {
            state.upserted.push(...rows);
            return Promise.resolve({ error: null });
          },
          then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
            Promise.resolve({
              data: state.blocks.filter((b) => ids.includes(b.booking_id)),
              error: null,
            }).then(resolve),
        };
        return q;
      }
      if (table !== "bookings") throw new Error(`fake db: unexpected table ${table}`);

      let rows = state.rows;
      let innerUsers = false;
      const userPreds: ((u: PoolUser) => boolean)[] = [];
      const b: Record<string, unknown> = {
        select: (cols: string) => {
          // `users!inner(...)` or, with the relationship named, `users!<fk>!inner(...)`.
          innerUsers = /\busers(?:![a-z_]+)?!inner\(/.test(cols);
          return b;
        },
        in: () => b,
        gte: () => b,
        not: () => b,
        order: () => b,
        range: () => b,
        lt: (col: string, value: string) => {
          rows = rows.filter((r) => String(r[col as keyof typeof r]) < value);
          return b;
        },
        is: (col: string, value: null) => {
          if (!col.startsWith("users.") || value !== null) throw new Error(`fake db: unhandled is ${col}`);
          const column = col.slice("users.".length) as keyof PoolUser;
          userPreds.push((u) => u[column] === null);
          return b;
        },
        or: (filters: string, opts?: { referencedTable?: string }) => {
          if (opts?.referencedTable !== "users") throw new Error(`fake db: unhandled or on ${opts?.referencedTable}`);
          const terms = filters.split(",");
          userPreds.push((u) => terms.some((t) => evalTerm(u, t)));
          return b;
        },
        then: (resolve: (v: { data: unknown[] | null; error: unknown }) => unknown) => {
          const kept = innerUsers ? rows.filter((r) => userPreds.every((p) => p(r.users))) : rows;
          return Promise.resolve(
            state.error ? { data: null, error: state.error } : { data: kept, error: null },
          ).then(resolve);
        },
      };
      return b;
    },
  }),
}));

// Only the two side effects are replaced (L727): the sweep's own decisions, and the
// alert's wording, run for real.
const notify = vi.hoisted(() => ({ sendThrottledAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/notify/dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/dispatch")>()),
  sendThrottledAlert: notify.sendThrottledAlert,
}));
const pools = vi.hoisted(() => ({ refreshPoolsForAgents: vi.fn(async () => null) }));
vi.mock("@/lib/availability/slot-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/availability/slot-cache")>()),
  refreshPoolsForAgents: pools.refreshPoolsForAgents,
}));

import { loadActiveUpcomingBookings, reconcileMissingBusyBlocks } from "./service";
import { RECONCILE_MISSING_GRACE_MS } from "./orchestration";
import { reconcileRecreatedAlert, reconcileFreedAlert, busyBlockWriteThroughAlert } from "./alert-copy";

const NOW = new Date("2026-07-13T15:00:00.000Z");
const DEPARTED_AT = "2026-07-13T14:43:27.000Z";

const IN_POOL: PoolUser = { bookable: true, deactivated_at: null, bookable_pending_since: null };

function booking(id: string, createdAgoMs: number, users: PoolUser = IN_POOL): BookingRow {
  return {
    id,
    assigned_user_id: `u-${id}`,
    starts_at: "2026-07-13T18:00:00.000Z",
    ends_at: "2026-07-13T18:30:00.000Z",
    created_at: new Date(NOW.getTime() - createdAgoMs).toISOString(),
    users,
  };
}

const DAYS_AGO = 5 * 86_400_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  state.rows = [];
  state.error = null;
  state.blocks = [];
  state.upserted = [];
  state.rpcCalls = [];
  state.rpcErrors = [];
  state.landedBeforeInsert = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loadActiveUpcomingBookings", () => {
  it("#778: holds back a booking created moments ago, whose block write may still be in flight", async () => {
    state.rows = [booking("fresh", 5_000), booking("settled", 10 * 60_000)];

    const scanned = await loadActiveUpcomingBookings(200);

    expect(scanned.map((b) => b.id)).toEqual(["settled"]);
  });

  it("#778: heals a booking once it is past the grace window (the block genuinely never landed)", async () => {
    state.rows = [booking("just-past-grace", RECONCILE_MISSING_GRACE_MS + 1_000)];

    const scanned = await loadActiveUpcomingBookings(200);

    expect(scanned.map((b) => b.id)).toEqual(["just-past-grace"]);
  });

  it("maps the assigned agent onto user_id, which is what the sweep re-creates the block for", async () => {
    state.rows = [booking("b1", 10 * 60_000)];

    const [row] = await loadActiveUpcomingBookings(200);

    expect(row).toEqual({
      id: "b1",
      user_id: "u-b1",
      starts_at: "2026-07-13T18:00:00.000Z",
      ends_at: "2026-07-13T18:30:00.000Z",
    });
  });

  // #3304. Every advisor below holds a days old booking, well outside the #778
  // window, so only their place in the pool decides whether the sweep sees it. The
  // two the pool exit backstop prunes are held back; the two it leaves alone are
  // scanned, which is the positive control in the same fixture (L159).
  it("#3304: holds back a booking whose advisor has left the pool, and only those", async () => {
    state.rows = [
      booking("in-pool", DAYS_AGO),
      booking("departed", DAYS_AGO, { bookable: false, deactivated_at: DEPARTED_AT, bookable_pending_since: null }),
      booking("taken-out", DAYS_AGO, { bookable: false, deactivated_at: null, bookable_pending_since: null }),
      // #2302: the backstop leaves somebody an activation is owed for alone, so their
      // missing block is still a real gap the moment they turn bookable.
      booking("activation-owed", DAYS_AGO, { bookable: false, deactivated_at: null, bookable_pending_since: DEPARTED_AT }),
    ];

    const scanned = await loadActiveUpcomingBookings(200);

    expect(scanned.map((b) => b.id)).toEqual(["in-pool", "activation-owed"]);
  });

  // Failure path, rewritten in #1152. This used to log the error and return [],
  // on the reasoning that a read blip should let the sweep no-op and retry next
  // tick. That reasoning had a hole: an empty scan is EXACTLY what "no bookings
  // need healing" looks like from the outside. The count of zero flowed into the
  // saturation reporter, which since #1134 reads an under-cap count as healthy,
  // clears the failure streak, and posts "the backlog has cleared, no action is
  // needed" about rows nobody managed to read.
  //
  // So the loader now throws. The self-heal lane catches it into the `null` that
  // already means "could not tell" (it neither pages nor all-clears), logs it with
  // the cause attached, and the next tick retries exactly as before. The lane
  // survives either way; what changes is that a failure can no longer pass itself
  // off as good news.
  it("throws when the read fails, so a failed scan can never read as a healthy one", async () => {
    state.rows = [booking("settled", 10 * 60_000)];
    state.error = { message: "read timeout" };

    await expect(loadActiveUpcomingBookings(200)).rejects.toThrow(/read timeout/);
  });
});

// #3304, end to end through the sweep the self heal lane runs: what is written to
// busy_blocks, whose pools are recomputed, and what the page says.
describe("reconcileMissingBusyBlocks", () => {
  it("#3304: neither re-creates nor reports a departed advisor's booking, and still heals the in-pool one beside it", async () => {
    // The 2026-10-05 shape: deactivated minutes ago, the booking days old and not
    // yet moved, its block deleted by the pool exit prune. Beside it, a booking in
    // the pool whose write through genuinely never landed. Neither has a block.
    state.rows = [
      booking("departed", DAYS_AGO, { bookable: false, deactivated_at: DEPARTED_AT, bookable_pending_since: null }),
      booking("missed", DAYS_AGO),
    ];

    const res = await reconcileMissingBusyBlocks(200);

    expect(res.bookingIds).toEqual(["missed"]);
    expect(res.recreated).toBe(1);
    expect(state.upserted.map((b) => [b.booking_id, b.user_id])).toEqual([["missed", "u-missed"]]);
    expect(pools.refreshPoolsForAgents).toHaveBeenCalledWith(["u-missed"], "reconcile-missing");

    // The page names only the real miss, in the words it has always used.
    expect(notify.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, , text] = notify.sendThrottledAlert.mock.calls[0] as unknown as [string, number, string];
    expect(key).toBe("reconcile_missing_busy_blocks");
    expect(text).toBe(reconcileRecreatedAlert(1, ["missed"], false));
    expect(text).toContain("a write-through INSERT had been missed");
    expect(text).not.toContain("departed");
  });

  it("#3304: stays silent when the only block-less booking belongs to somebody taken out of the pool", async () => {
    state.rows = [booking("taken-out", DAYS_AGO, { bookable: false, deactivated_at: null, bookable_pending_since: null })];

    const res = await reconcileMissingBusyBlocks(200);

    expect(res.recreated).toBe(0);
    expect(state.upserted).toEqual([]);
    expect(pools.refreshPoolsForAgents).not.toHaveBeenCalled();
    expect(notify.sendThrottledAlert).not.toHaveBeenCalled();
  });
});

// #3592: the re-create is one conditional statement, and what it says it inserted is
// what the sweep counts, recomputes and pages about.
describe("reconcileMissingBusyBlocks through recreate_missing_busy_blocks (#3592)", () => {
  it("hands the statement the missing candidates and the #778 grace cutoff, from the one constant", async () => {
    state.rows = [booking("missed", DAYS_AGO)];

    await reconcileMissingBusyBlocks(200);

    expect(state.rpcCalls).toEqual([
      {
        name: "recreate_missing_busy_blocks",
        args: {
          p_booking_ids: ["missed"],
          p_created_before: new Date(NOW.getTime() - RECONCILE_MISSING_GRACE_MS).toISOString(),
        },
      },
    ]);
  });

  it("counts and pages only the rows the statement inserted", async () => {
    // Both looked block-less to the sweep's reads, but `landed`'s own write through
    // arrived before the insert (ON CONFLICT DO NOTHING), so only `missed` is real.
    state.rows = [booking("missed", DAYS_AGO), booking("landed", DAYS_AGO)];
    state.landedBeforeInsert = ["landed"];

    const res = await reconcileMissingBusyBlocks(200);

    expect(res.recreated).toBe(1);
    expect(res.bookingIds).toEqual(["missed"]);
    expect(pools.refreshPoolsForAgents).toHaveBeenCalledWith(["u-missed"], "reconcile-missing");
    const [, , text] = notify.sendThrottledAlert.mock.calls[0] as unknown as [string, number, string];
    expect(text).toBe(reconcileRecreatedAlert(1, ["missed"], false));
  });

  it("retries a refused statement once, and a retry that lands pages nobody about the blip", async () => {
    state.rows = [booking("missed", DAYS_AGO)];
    state.rpcErrors = [{ message: "connection reset" }];

    const res = await reconcileMissingBusyBlocks(200);

    expect(state.rpcCalls).toHaveLength(2);
    expect(res.recreated).toBe(1);
    const keys = notify.sendThrottledAlert.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(keys).toEqual(["reconcile_missing_busy_blocks"]);
  });

  it("a statement refused twice aborts the sweep: the write failure pages, no re-create is claimed", async () => {
    // Failure path. The old insert logged, paged and returned, and the sweep then
    // reported every candidate as re-created and paged "a write-through INSERT had been
    // missed" about blocks that were never written. Now it pages the write failure it
    // always paged, then throws, which the self heal lane reads as "could not tell".
    state.rows = [booking("missed", DAYS_AGO)];
    state.rpcErrors = [{ message: "statement timeout" }, { message: "statement timeout" }];

    await expect(reconcileMissingBusyBlocks(200)).rejects.toThrow(/statement timeout/);

    expect(state.upserted).toEqual([]);
    expect(pools.refreshPoolsForAgents).not.toHaveBeenCalled();
    expect(notify.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, , text] = notify.sendThrottledAlert.mock.calls[0] as unknown as [string, number, string];
    expect(key).toBe("busy_block_write_through");
    expect(text).toBe(busyBlockWriteThroughAlert("insert", "booking missed", "statement timeout"));
  });
});

describe("reconcileFreedAlert names the freed bookings (#3585)", () => {
  it("names which bookings were freed, not only how many agents", () => {
    const text = reconcileFreedAlert({
      freedCancelled: 2,
      freedOrphans: 0,
      agentCount: 1,
      bookingIds: ["bk1", "bk2"],
    });
    expect(text).toContain("Booking ids: bk1, bk2.");
    expect(text).toContain("cancel-path health");
  });

  it("marks the list as truncated when more were freed than shown", () => {
    const text = reconcileFreedAlert({
      freedCancelled: 20,
      freedOrphans: 0,
      agentCount: 3,
      bookingIds: ["bk1", "bk2"],
      bookingIdsTruncated: true,
    });
    expect(text).toContain("Booking ids: bk1, bk2 ...");
  });

  it("names no booking ids for a pure orphan free (nothing owned the slot)", () => {
    // An orphan has no booking_id, so there is nothing to name and the cancel path is
    // not implicated: the ids clause must not appear.
    const text = reconcileFreedAlert({ freedCancelled: 0, freedOrphans: 1, agentCount: 1, bookingIds: [] });
    expect(text).not.toContain("Booking ids:");
    expect(text).toContain("no booking and no approved time off owned");
  });
});
