import { describe, it, expect, vi, beforeEach } from "vitest";

// #1152: the three self-heal sweeps must not report "no work" when their worklist
// read FAILED. Each returns a count that the saturation reporter reads as the
// sweep's verdict, and since #1134 an under-cap count is not merely "quiet", it
// MEANS healthy: it clears the failure streak and posts an all-clear
// ("the backlog that triggered the earlier page has cleared, no action is needed").
//
// So a read error that degraded to an empty worklist produced a count of zero, and
// that zero announced recovery on the strength of a query that never ran, while
// simultaneously resetting the streak that would have paged. Same defect #1134
// fixed in `loadFailingAgents`, in three more places.
//
// The fix is the one the rest of the chain already expects: the loader throws, the
// self-heal lane's `.catch` turns that into `null`, and `pageOnSaturationStreak`
// already treats `null` as "tells us nothing" (no page, no all-clear, streak
// untouched). These tests pin the FIRST link, that a failed read is never dressed
// up as an empty one. `selfheal/route.test.ts` pins the link after it.
//
// Each failing case is paired with a genuinely-empty control, so a test can't pass
// because the mock never returned rows in the first place.

const state = vi.hoisted(() => ({
  errors: {} as Record<string, { message: string } | undefined>,
  rows: {} as Record<string, unknown[]>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const result = () =>
        state.errors[table]
          ? { data: null, error: state.errors[table] }
          : { data: state.rows[table] ?? [], error: null };
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        neq: () => b,
        gte: () => b,
        lt: () => b,
        in: () => b,
        is: () => b,
        not: () => b,
        order: () => b,
        range: () => b,
        limit: () => b,
        maybeSingle: () => Promise.resolve(result()),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return b;
    },
  }),
}));

import {
  processPendingEventDeletions,
  reconcileCancelledBusyBlocks,
  reconcileMissingBusyBlocks,
  agentActiveBookingStartsMs,
} from "./service";

beforeEach(() => {
  vi.clearAllMocks();
  state.errors = {};
  state.rows = {};
});

describe("self-heal worklist reads never report a failed read as no work (#1152)", () => {
  describe("failed calendar event deletion drain", () => {
    it("aborts the tick when the queue read fails", async () => {
      state.errors.pending_event_deletions = { message: "read timeout" };

      await expect(processPendingEventDeletions(20)).rejects.toThrow(/read timeout/);
    });

    it("reports a genuinely empty queue as zero drained", async () => {
      state.rows.pending_event_deletions = [];

      const res = await processPendingEventDeletions(20);

      expect(res.deleted).toBe(0);
      expect(res.failed).toBe(0);
    });
  });

  describe("cancelled-block reconcile", () => {
    it("aborts the tick when the busy_blocks scan fails", async () => {
      state.errors.busy_blocks = { message: "read timeout" };

      await expect(reconcileCancelledBusyBlocks(200)).rejects.toThrow(/read timeout/);
    });

    it("reports a genuinely empty scan as zero freed", async () => {
      state.rows.busy_blocks = [];

      const res = await reconcileCancelledBusyBlocks(200);

      expect(res.freed).toBe(0);
      expect(res.scanned).toBe(0);
    });
  });

  // Same class, found auditing the other `error-ok` reads for #1152, and the one
  // that is not about an alert. This read counts an agent's other bookings that
  // day so the reassign path can refuse to push them past their daily cap. It
  // returned [] on a read error, and [] is not "could not count", it is "no
  // bookings that day", which is comfortably under every cap. So a read blip
  // silently granted an exemption from the cap. Its own comment claimed the
  // failure re-routed, borrowing the reasoning from `busyIntervalsForAgent`, which
  // really does return null for unknown; this one returned the permissive value.
  describe("agent daily-cap count", () => {
    it("throws when the count read fails, rather than counting zero bookings", async () => {
      state.errors.bookings = { message: "read timeout" };

      await expect(
        agentActiveBookingStartsMs("u1", "2026-07-28T00:00:00Z", "2026-07-29T00:00:00Z", "bk1"),
      ).rejects.toThrow(/read timeout/);
    });

    it("counts a genuinely empty day as no bookings", async () => {
      state.rows.bookings = [];

      const starts = await agentActiveBookingStartsMs(
        "u1",
        "2026-07-28T00:00:00Z",
        "2026-07-29T00:00:00Z",
        "bk1",
      );

      expect(starts).toEqual([]);
    });
  });

  describe("missing-block reconcile", () => {
    it("aborts the tick when the active-bookings scan fails", async () => {
      state.errors.bookings = { message: "read timeout" };

      await expect(reconcileMissingBusyBlocks(200)).rejects.toThrow(/read timeout/);
    });

    it("reports a genuinely empty scan as zero recreated", async () => {
      state.rows.bookings = [];

      const res = await reconcileMissingBusyBlocks(200);

      expect(res.recreated).toBe(0);
      expect(res.scanned).toBe(0);
    });
  });
});
