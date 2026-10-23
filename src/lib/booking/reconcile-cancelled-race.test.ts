import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #4165: the reconcile-cancelled sweep reads the upcoming slate blocks first, then
// the booking statuses and in-flight cancels. A customer cancel landing between those
// reads was paged as "a write-through delete was missed, check cancel-path health"
// although the cancel worked (booking d124f50e, 2026-10-23 02:31 UTC). Two windows:
//
//  1. The cancel FINISHED in between: its own step had already deleted the block, so
//     the sweep's delete removed nothing, yet it counted the candidate as freed.
//  2. The cancel had not QUEUED yet: the status flip and the outbox insert are two
//     statements (31 ms apart in the incident), so the booking read cancelled with no
//     pending outbox row and looked exactly like a finished cancel that missed.
//
// These cases run the real service wiring against a fake database that honours the
// filters under test, so they assert what the sweep sees and what the page says, not
// which methods were called. The pure decisions are in
// scripts/test-reconcile-busy-blocks.ts.

type BlockRow = { id: string; user_id: string; booking_id: string | null; source: string; ooo_request_id: string | null };
type BookingRow = { id: string; status: string; updated_at: string };

const state = vi.hoisted(() => ({
  /** What the scan returns: the blocks as they were when the sweep first read them. */
  scanned: [] as BlockRow[],
  /** Block ids still in the table when the delete runs. */
  present: new Set<string>(),
  bookings: [] as BookingRow[],
  /** booking ids with a pending cancel outbox row (#784). */
  outbox: [] as string[],
  deleteError: null as null | { message: string },
  graceReadError: null as null | { message: string },
  deleted: [] as string[][],
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === "busy_blocks") {
        const scan: Record<string, unknown> = {
          select: () => scan,
          eq: () => scan,
          gte: () => scan,
          order: () => scan,
          range: () => scan,
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: state.scanned, error: null }).then(resolve),
          delete: () => ({
            in: (col: string, ids: string[]) => {
              if (col !== "id") throw new Error(`fake db: delete keyed on ${col}`);
              const run = () => {
                state.deleted.push(ids);
                if (state.deleteError) return { data: null, error: state.deleteError };
                const removed = ids.filter((id) => state.present.has(id));
                for (const id of removed) state.present.delete(id);
                return { data: removed.map((id) => ({ id })), error: null };
              };
              return {
                // Only `.select("id")` answers with the removed rows; awaiting the
                // bare delete answers with no data at all, as PostgREST does.
                select: (cols: string) => {
                  if (cols !== "id") throw new Error(`fake db: delete returning ${cols}`);
                  return Promise.resolve(run());
                },
                then: (resolve: (v: unknown) => unknown) =>
                  Promise.resolve({ ...run(), data: null }).then(resolve),
              };
            },
          }),
        };
        return scan;
      }
      if (table === "bookings") {
        let rows = state.bookings;
        let failing = false;
        const q: Record<string, unknown> = {
          select: () => q,
          in: (col: string, values: string[]) => {
            rows = rows.filter((r) => values.includes(String(r[col as keyof BookingRow])));
            return q;
          },
          eq: (col: string, value: string) => {
            rows = rows.filter((r) => r[col as keyof BookingRow] === value);
            return q;
          },
          gt: (col: string, value: string) => {
            if (col !== "updated_at") throw new Error(`fake db: unhandled gt ${col}`);
            failing = state.graceReadError !== null;
            rows = rows.filter((r) => Date.parse(r.updated_at) > Date.parse(value));
            return q;
          },
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve(
              failing ? { data: null, error: state.graceReadError } : { data: rows, error: null },
            ).then(resolve),
        };
        return q;
      }
      if (table === "booking_outbox") {
        let ids: string[] = [];
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          in: (_col: string, values: string[]) => {
            ids = values;
            return q;
          },
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({
              data: state.outbox.filter((id) => ids.includes(id)).map((booking_id) => ({ booking_id })),
              error: null,
            }).then(resolve),
        };
        return q;
      }
      throw new Error(`fake db: unexpected table ${table}`);
    },
  }),
}));

// Only the two side effects are replaced: the sweep's decisions and the alert's
// wording run for real.
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

import { reconcileCancelledBusyBlocks } from "./service";
import { RECONCILE_CANCELLED_GRACE_MS } from "./orchestration";
import { reconcileFreedAlert } from "./alert-copy";

const NOW = new Date("2026-10-23T02:31:30.000Z");

function blockFor(bookingId: string | null, id = `blk-${bookingId}`, userId = `u-${bookingId}`): BlockRow {
  return { id, user_id: userId, booking_id: bookingId, source: "slate", ooo_request_id: null };
}

function cancelled(id: string, agoMs: number): BookingRow {
  return { id, status: "cancelled", updated_at: new Date(NOW.getTime() - agoMs).toISOString() };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  state.scanned = [];
  state.present = new Set();
  state.bookings = [];
  state.outbox = [];
  state.deleteError = null;
  state.graceReadError = null;
  state.deleted = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reconcileCancelledBusyBlocks against a racing cancel (#4165)", () => {
  it("a block the cancel deleted between the scan and the delete is neither counted nor alerted", async () => {
    // The incident: cancelled 22 s before the tick, outbox delivered, block already
    // gone by the time the sweep deleted. Past any grace too, so only counting real
    // rows can keep this quiet.
    state.scanned = [blockFor("d124f50e")];
    state.present = new Set(); // the cancel's own step removed it
    state.bookings = [cancelled("d124f50e", RECONCILE_CANCELLED_GRACE_MS + 5_000)];

    const res = await reconcileCancelledBusyBlocks(200);

    expect(state.deleted).toEqual([["blk-d124f50e"]]);
    expect(res.freed).toBe(0);
    expect(res.freedBookingIds).toEqual([]);
    expect(pools.refreshPoolsForAgents).not.toHaveBeenCalled();
    expect(notify.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("a booking cancelled 10 s ago with no outbox row yet is skipped", async () => {
    state.scanned = [blockFor("just")];
    state.present = new Set(["blk-just"]);
    state.bookings = [cancelled("just", 10_000)];
    state.outbox = []; // the cancel has flipped the status but not queued yet

    const res = await reconcileCancelledBusyBlocks(200);

    expect(state.deleted).toEqual([]);
    expect(state.present.has("blk-just")).toBe(true);
    expect(res.freed).toBe(0);
    expect(notify.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("a booking cancelled 2 min ago with its block still present is freed and alerted", async () => {
    state.scanned = [blockFor("missed")];
    state.present = new Set(["blk-missed"]);
    state.bookings = [cancelled("missed", 2 * 60_000)];

    const res = await reconcileCancelledBusyBlocks(200);

    expect(state.deleted).toEqual([["blk-missed"]]);
    expect(state.present.has("blk-missed")).toBe(false);
    expect(res.freed).toBe(1);
    expect(res.freedBookingIds).toEqual(["missed"]);
    expect(pools.refreshPoolsForAgents).toHaveBeenCalledWith(["u-missed"], "reconcile");
    expect(notify.sendThrottledAlert).toHaveBeenCalledTimes(1);
    const [key, , text] = notify.sendThrottledAlert.mock.calls[0] as unknown as [string, number, string];
    expect(key).toBe("reconcile_busy_blocks");
    expect(text).toBe(
      reconcileFreedAlert({ freedCancelled: 1, freedOrphans: 0, agentCount: 1, bookingIds: ["missed"] }),
    );
  });

  it("an orphan block is freed at once, with no grace, as before", async () => {
    state.scanned = [blockFor(null, "blk-orphan", "u-orphan")];
    state.present = new Set(["blk-orphan"]);

    const res = await reconcileCancelledBusyBlocks(200);

    expect(res.freed).toBe(1);
    expect(res.freedOrphans).toBe(1);
  });

  it("a refused delete aborts the tick: nothing is reported freed and nothing is alerted", async () => {
    // A refused statement removed nothing, so the honest answer is "could not tell",
    // which the self heal lane reads as null (no page, no all clear). Logging it and
    // reporting the candidates as freed was the old behaviour, and it is the same
    // false page as window 1.
    state.scanned = [blockFor("missed")];
    state.present = new Set(["blk-missed"]);
    state.bookings = [cancelled("missed", 2 * 60_000)];
    state.deleteError = { message: "statement timeout" };

    await expect(reconcileCancelledBusyBlocks(200)).rejects.toThrow(/statement timeout/);
    expect(pools.refreshPoolsForAgents).not.toHaveBeenCalled();
    expect(notify.sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("a failed grace read aborts the tick rather than freeing a cancel still on its way", async () => {
    state.scanned = [blockFor("just")];
    state.present = new Set(["blk-just"]);
    state.bookings = [cancelled("just", 10_000)];
    state.graceReadError = { message: "read timeout" };

    await expect(reconcileCancelledBusyBlocks(200)).rejects.toThrow(/read timeout/);
    expect(state.deleted).toEqual([]);
    expect(notify.sendThrottledAlert).not.toHaveBeenCalled();
  });
});
