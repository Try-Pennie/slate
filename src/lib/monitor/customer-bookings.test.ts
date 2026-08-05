import { describe, it, expect, vi } from "vitest";

// #1258: the low-volume alarm's input. It exists to notice that customers have
// stopped booking, so the one thing it must never count is Slate booking against
// itself: the smoke canary makes roughly 8 bookings every 6 hours forever, and a
// floor measured against those cannot tell a quiet afternoon from a dead funnel.
//
// `bookings` has no is_test column of its own, so a booking is a test booking when
// its BUCKET is one (the SMOKE fixtures, #396). The fake below therefore honours
// the embedded filter rather than asserting against a shape of its own: what the
// query asks for is what decides the count.

import { countCustomerBookingsSince } from "./customer-bookings";

const SINCE = "2026-08-05T09:00:00.000Z";

/**
 * A stand-in for the supabase count chain. Records the filters applied and
 * resolves the count from rows the filters actually select, so a query missing the
 * is_test filter counts the canary rows and fails the test.
 */
function fakeDb(
  rows: { created_at: string; is_test: boolean }[],
  opts: { error?: string } = {},
) {
  const filters: { col: string; val: unknown }[] = [];
  const chain = {
    select: (_cols: string, _opts: { count: string; head: boolean }) => chain,
    eq: (col: string, val: unknown) => {
      filters.push({ col, val });
      return chain;
    },
    gte: (col: string, val: unknown) => {
      filters.push({ col, val });
      return chain;
    },
    then: (res: (v: unknown) => unknown) => {
      if (opts.error) {
        return Promise.resolve(res({ count: null, error: { message: opts.error } }));
      }
      const testFilter = filters.find((f) => f.col === "buckets.is_test");
      const since = filters.find((f) => f.col === "created_at")?.val as string | undefined;
      const kept = rows.filter(
        (r) =>
          (since === undefined || r.created_at >= since) &&
          (testFilter === undefined || r.is_test === testFilter.val),
      );
      return Promise.resolve(res({ count: kept.length, error: null }));
    },
  };
  return {
    filters,
    db: { from: (_t: string) => chain } as never,
  };
}

const canary = (created_at: string) => ({ created_at, is_test: true });
const customer = (created_at: string) => ({ created_at, is_test: false });

describe("countCustomerBookingsSince", () => {
  it("counts customer bookings and ignores the canary's", async () => {
    const { db } = fakeDb([
      canary("2026-08-05T10:00:00.000Z"),
      canary("2026-08-05T10:05:00.000Z"),
      canary("2026-08-05T11:00:00.000Z"),
      customer("2026-08-05T10:30:00.000Z"),
    ]);
    expect(await countCustomerBookingsSince(db, SINCE)).toBe(1);
  });

  it("returns zero, not the canary's count, on a genuinely dead funnel", async () => {
    // The case the alarm exists for: today's production reality is 8 canary
    // bookings in 6 hours and no customer bookings at all. That has to read as 0.
    const { db } = fakeDb([canary("2026-08-05T10:00:00.000Z"), canary("2026-08-05T12:00:00.000Z")]);
    expect(await countCustomerBookingsSince(db, SINCE)).toBe(0);
  });

  it("still honours the window it was asked for", async () => {
    const { db } = fakeDb([
      customer("2026-08-05T08:00:00.000Z"), // before SINCE
      customer("2026-08-05T10:00:00.000Z"),
    ]);
    expect(await countCustomerBookingsSince(db, SINCE)).toBe(1);
  });

  it("returns null on a read error, so a failed query never pages a false drought", async () => {
    // The #1158 contract: null means unverified. A read error must NEVER become a
    // zero, because zero is the exact value that pages.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb([customer("2026-08-05T10:00:00.000Z")], { error: "read timeout" });
    expect(await countCustomerBookingsSince(db, SINCE)).toBeNull();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
