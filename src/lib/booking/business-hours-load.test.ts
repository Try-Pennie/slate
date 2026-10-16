import { describe, it, expect, vi, beforeEach } from "vitest";

// #1294: the DB layer for gate 1. The resolution rules are node-tested next door;
// what only this file can prove is which way the READ fails, and that matters more
// than usual because the two wrong answers are invisible in opposite ways.
//
// A read error must NOT degrade to the seeded week the way the booking horizon
// degrades to its default. Falling back here would silently re-open hours an admin
// had narrowed, and nothing in the product would show it: the booker would just keep
// offering the old times. So it throws and lets the caller decide.
//
// An empty table is the opposite case and must NOT throw: a fresh database has no
// stored week, and closing the org over that would blank the booker.
const rows = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  // #1363: the date exceptions read, which shares the loader. Its own failure
  // direction has its own cases below.
  exceptions: [] as unknown[],
  exceptionsError: null as { message: string } | null,
  // #3713: the order the two reads start and finish in, so the test can tell
  // sequential reads from concurrent ones.
  order: [] as string[],
}));
const warn = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) =>
      table === "business_hours_exceptions"
        ? {
            select: () => ({
              gte: () => ({
                order: () => ({
                  limit: async () => {
                    rows.order.push("exceptions:start");
                    return { data: rows.exceptions, error: rows.exceptionsError };
                  },
                }),
              }),
            }),
          }
        : {
            select: async () => {
              rows.order.push("week:start");
              // One macrotask, standing in for the round trip.
              await new Promise((resolve) => setTimeout(resolve, 0));
              rows.order.push("week:end");
              return { data: rows.data, error: rows.error };
            },
          },
  }),
}));
vi.mock("@/lib/log", () => ({ log: { warn, info: vi.fn(), error: vi.fn() } }));

import { loadBusinessHours } from "./business-hours-load";
import { SEEDED_BUSINESS_HOURS, BUSINESS_ZONE } from "./business-hours";

const week = (over: Partial<Record<number, { is_open?: boolean; start_minute?: number; end_minute?: number }>> = {}) =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    is_open: over[weekday]?.is_open ?? weekday !== 7,
    start_minute: over[weekday]?.start_minute ?? 480,
    end_minute: over[weekday]?.end_minute ?? 1200,
  }));

beforeEach(() => {
  vi.clearAllMocks();
  rows.data = week();
  rows.exceptions = [];
  rows.exceptionsError = null;
  rows.error = null;
  rows.order = [];
});

describe("loadBusinessHours", () => {
  it("returns the stored open days and the org zone", async () => {
    const hours = await loadBusinessHours();
    expect(hours.source).toBe("stored");
    expect(hours.zone).toBe(BUSINESS_ZONE);
    expect(hours.rules.map((r) => r.weekday)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(hours.rules[0]).toEqual({ weekday: 1, start_minute: 480, end_minute: 1200 });
  });

  it("sends the exceptions read before the week read has answered (#3713)", async () => {
    // Two round trips one after the other cost about 65ms on almost every lead read,
    // because the cache in front of this lives 5 seconds. Neither read needs the other.
    await loadBusinessHours();
    expect(rows.order).toEqual(["week:start", "exceptions:start", "week:end"]);
  });

  it("throws on a read error rather than quietly serving the default week", async () => {
    // The direction that matters: a fallback here would re-open narrowed hours with
    // nothing visible to say so.
    rows.error = { message: "connection reset" };
    await expect(loadBusinessHours()).rejects.toThrow(/business_hours|connection reset/i);
  });

  it("throws when the stored week cannot be trusted", async () => {
    rows.data = week({ 3: { start_minute: 1200, end_minute: 480 } });
    await expect(loadBusinessHours()).rejects.toThrow(/unusable/i);
  });

  it("falls back to the seeded week on an empty table, and says so", async () => {
    rows.data = [];
    const hours = await loadBusinessHours();
    expect(hours.source).toBe("seeded");
    expect(hours.rules).toEqual(SEEDED_BUSINESS_HOURS);
    // Logged, because an unconfigured table is worth knowing about even though it is
    // handled: it means nobody has set the hours yet.
    expect(warn).toHaveBeenCalled();
  });

  it("honours a fully closed week instead of treating it as unconfigured", async () => {
    rows.data = week({ 1: { is_open: false }, 2: { is_open: false }, 3: { is_open: false }, 4: { is_open: false }, 5: { is_open: false }, 6: { is_open: false } });
    const hours = await loadBusinessHours();
    expect(hours.source).toBe("stored");
    expect(hours.rules).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

// #1363: the date exceptions ride the same read, and they fail the same way for a
// sharper reason. An exception is nearly always a CLOSURE, so a swallowed error
// would leave the org advertising times on a day it is shut and a lead would be
// booked into an empty office.
describe("date exceptions (#1363)", () => {
  it("returns the stored dates alongside the week", async () => {
    rows.exceptions = [
      { on_date: "2026-12-25", is_open: false, start_minute: null, end_minute: null, note: "Christmas Day" },
    ];

    const hours = await loadBusinessHours();

    expect(hours.exceptions).toHaveLength(1);
    expect(hours.exceptions[0].on_date).toBe("2026-12-25");
  });

  it("throws rather than serving the weekly pattern when the dates cannot be read", async () => {
    rows.exceptionsError = { message: "relation does not exist" };

    await expect(loadBusinessHours()).rejects.toThrow();
  });

  it("says so, loudly, when a stored date cannot be understood", async () => {
    // The row that matters most: it matches no date, so it shuts NOTHING, and the
    // day it was meant to close stays open and bookable.
    rows.exceptions = [
      { on_date: "25/12/2026", is_open: false, start_minute: null, end_minute: null, note: null },
    ];

    const hours = await loadBusinessHours();

    expect(hours.exceptions).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls.at(-1)?.[1]?.msg)).toMatch(/unreadable/i);
  });
});
