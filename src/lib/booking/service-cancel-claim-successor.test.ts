import { describe, it, expect, vi, beforeEach } from "vitest";

// #3672: the REAL cancel claim records the booking that replaced the one it cancels.
//
// A cross bucket move makes a new booking and cancels the old one, and the old
// booking's links follow to the new one only because the cancelled row names it. The
// rule is that the name is written by the SAME statement that flips the status, so a
// crash between two writes can never leave a cancelled row with no successor. The
// orchestration suite (`scripts/test-moved-booking-links-follow.ts`) drives a fake of
// this dep; this pins the real one, which is what Postgres actually receives.

const writes = vi.hoisted(() => ({
  updates: [] as { table: string; patch: Record<string, unknown>; id: unknown; statuses: unknown }[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: unknown) => ({
          in: (_statusCol: string, statuses: unknown) => ({
            select: async () => {
              writes.updates.push({ table, patch, id, statuses });
              return { data: [{ id }], error: null };
            },
          }),
        }),
      }),
    }),
  }),
}));

import { realDeps } from "./service";

beforeEach(() => {
  writes.updates.length = 0;
});

describe("the cancel claim names the successor in its own statement (#3672)", () => {
  it("writes the status and the replacing booking together, in ONE update", async () => {
    await expect(realDeps().claimCancellation("bk-old", "bk-new")).resolves.toBe(true);
    expect(writes.updates).toHaveLength(1);
    expect(writes.updates[0]).toMatchObject({
      table: "bookings",
      id: "bk-old",
      patch: { status: "cancelled", replaced_by_booking_id: "bk-new" },
    });
  });

  it("CONTROL: an ordinary cancel writes only the status, never a successor", async () => {
    await expect(realDeps().claimCancellation("bk-old")).resolves.toBe(true);
    expect(writes.updates).toHaveLength(1);
    expect(writes.updates[0].patch).toEqual({ status: "cancelled" });
  });
});
