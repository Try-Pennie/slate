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

const state = vi.hoisted(() => ({
  rows: [] as { id: string; assigned_user_id: string; starts_at: string; ends_at: string; created_at: string }[],
  error: null as null | { message: string },
}));

/** Chainable stand-in for the supabase client that HONORS the filters under test,
 *  so these assert what the sweep actually sees, not which methods were called. */
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => {
      let rows = state.rows;
      const b: Record<string, unknown> = {
        select: () => b,
        in: () => b,
        gte: () => b,
        not: () => b,
        order: () => b,
        range: () => b,
        lt: (col: string, value: string) => {
          rows = rows.filter((r) => String(r[col as keyof typeof r]) < value);
          return b;
        },
        then: (resolve: (v: { data: unknown[] | null; error: unknown }) => unknown) =>
          Promise.resolve(
            state.error ? { data: null, error: state.error } : { data: rows, error: null },
          ).then(resolve),
      };
      return b;
    },
  }),
}));

import { loadActiveUpcomingBookings } from "./service";
import { RECONCILE_MISSING_GRACE_MS } from "./orchestration";

const NOW = new Date("2026-07-13T15:00:00.000Z");

function booking(id: string, createdAgoMs: number) {
  return {
    id,
    assigned_user_id: `u-${id}`,
    starts_at: "2026-07-13T18:00:00.000Z",
    ends_at: "2026-07-13T18:30:00.000Z",
    created_at: new Date(NOW.getTime() - createdAgoMs).toISOString(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  state.rows = [];
  state.error = null;
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

  // Failure path: a read blip must not look like "no bookings need healing" in a
  // way that hides itself. It logs and yields nothing, so the sweep no-ops this
  // tick and the next tick retries, rather than the sweep crashing the lane.
  it("logs and scans nothing when the read fails, instead of failing silently", async () => {
    state.rows = [booking("settled", 10 * 60_000)];
    state.error = { message: "read timeout" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const scanned = await loadActiveUpcomingBookings(200);

    expect(scanned).toEqual([]);
    expect(err).toHaveBeenCalledOnce();
    // #808: the line is tagged, and the real failure rides along as the second
    // argument so Cloudflare serializes it rather than it being flattened away.
    expect(String(err.mock.calls[0][0])).toContain("tag=reconcile-missing");
    expect(JSON.stringify(err.mock.calls[0][1])).toContain("read timeout");
    err.mockRestore();
  });
});
