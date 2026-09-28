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

import {
  countCustomerBookingsSince,
  customerBookingFromSourcesSince,
  listCustomerBookingSourcesSince,
  SOURCE_READ_LIMIT,
} from "./customer-bookings";

const SINCE = "2026-08-05T09:00:00.000Z";

/**
 * A stand-in for the supabase count chain. Records the filters applied and
 * resolves the count from rows the filters actually select, so a query missing the
 * is_test filter counts the canary rows and fails the test.
 */
function fakeDb(
  rows: { created_at: string; is_test: boolean; kind?: string }[],
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
      // #2073: honoured like the test filter, so a count that forgot it counts
      // the named link bookings below.
      const kindFilter = filters.find((f) => f.col === "kind");
      const since = filters.find((f) => f.col === "created_at")?.val as string | undefined;
      const kept = rows.filter(
        (r) =>
          (since === undefined || r.created_at >= since) &&
          (testFilter === undefined || r.is_test === testFilter.val) &&
          (kindFilter === undefined || (r.kind ?? "routed") === kindFilter.val),
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

  it("does not count a booking made through an agent's own link (#2073)", async () => {
    // A later call with a lead the funnel already sent: counting it would hold the
    // alarm quiet while customers stopped arriving.
    const { db } = fakeDb([
      customer("2026-08-05T10:00:00.000Z"),
      { ...customer("2026-08-05T11:00:00.000Z"), kind: "agent_link" },
    ]);
    expect(await countCustomerBookingsSince(db, SINCE)).toBe(1);
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

// #2738: the per page alarm's two reads. The same test-bucket rule applies, and
// both must THROW on a failed read rather than answer, because their empty answers
// ("no bookings from any page", "this page has never recorded a booking") are the
// answers that page.
type SourceFakeRow = { created_at: string; is_test: boolean; source: string | null };

function sourceDb(rows: SourceFakeRow[], opts: { error?: string } = {}) {
  const make = () => {
    const filters: { col: string; val: unknown }[] = [];
    let limit = Infinity;
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => (filters.push({ col, val }), chain),
      gte: (col: string, val: unknown) => (filters.push({ col, val }), chain),
      in: (col: string, val: unknown) => (filters.push({ col, val }), chain),
      limit: (n: number) => ((limit = n), chain),
      then: (res: (v: unknown) => unknown) => {
        if (opts.error) return Promise.resolve(res({ data: null, count: null, error: { message: opts.error } }));
        const kept = rows.filter((r) =>
          filters.every((f) =>
            f.col === "buckets.is_test"
              ? r.is_test === f.val
              : f.col === "created_at"
                ? r.created_at >= (f.val as string)
                : f.col === "source"
                  ? (f.val as string[]).includes(r.source ?? "")
                  : true,
          ),
        );
        const page = kept.slice(0, limit);
        return Promise.resolve(
          res({ data: page.map(({ created_at, source }) => ({ created_at, source })), count: kept.length, error: null }),
        );
      },
    };
    return chain;
  };
  return { db: { from: (_t: string) => make() } as never };
}

describe("listCustomerBookingSourcesSince", () => {
  it("lists customer bookings with their source, leaving the canary's out", async () => {
    const { db } = sourceDb([
      { created_at: "2026-08-05T10:00:00.000Z", is_test: true, source: "offerhub" },
      { created_at: "2026-08-05T10:05:00.000Z", is_test: false, source: "offerhub" },
      { created_at: "2026-08-05T10:06:00.000Z", is_test: false, source: null },
      { created_at: "2026-08-05T08:00:00.000Z", is_test: false, source: "booking" },
    ]);
    expect(await listCustomerBookingSourcesSince(db, SINCE)).toEqual([
      { createdMs: Date.parse("2026-08-05T10:05:00.000Z"), source: "offerhub" },
      { createdMs: Date.parse("2026-08-05T10:06:00.000Z"), source: null },
    ]);
  });

  it("throws on a read error, never answering with an empty list", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = sourceDb([], { error: "read timeout" });
    await expect(listCustomerBookingSourcesSince(db, SINCE)).rejects.toThrow(/could not read/);
    log.mockRestore();
  });

  it("throws on a full page, because a truncated list undercounts every page", async () => {
    const rows = Array.from({ length: SOURCE_READ_LIMIT }, (_, i) => ({
      created_at: new Date(Date.parse(SINCE) + i * 1000).toISOString(),
      is_test: false,
      source: "offerhub",
    }));
    const { db } = sourceDb(rows);
    await expect(listCustomerBookingSourcesSince(db, SINCE)).rejects.toThrow(/truncated/);
  });

  it("throws on a timestamp it cannot read rather than dropping the booking", async () => {
    const { db } = sourceDb([{ created_at: "not a date", is_test: false, source: "offerhub" }]);
    await expect(listCustomerBookingSourcesSince(db, "")).rejects.toThrow(/unreadable/);
  });
});

describe("customerBookingFromSourcesSince", () => {
  it("answers whether any customer booking carried one of the sources", async () => {
    const { db } = sourceDb([
      { created_at: "2026-08-05T10:00:00.000Z", is_test: true, source: "offerhub" },
      { created_at: "2026-08-05T10:00:00.000Z", is_test: false, source: "booking" },
    ]);
    expect(await customerBookingFromSourcesSince(db, ["offerhub", "booking-portal"], SINCE)).toBe(false);
    expect(await customerBookingFromSourcesSince(db, ["booking"], SINCE)).toBe(true);
  });

  it("throws on a read error, so a failure is never 'this page has recorded nothing'", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = sourceDb([], { error: "read timeout" });
    await expect(customerBookingFromSourcesSince(db, ["offerhub"], SINCE)).rejects.toThrow(/could not read/);
    log.mockRestore();
  });
});
