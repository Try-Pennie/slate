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
}));
const warn = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({ select: async () => ({ data: rows.data, error: rows.error }) }),
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
  rows.error = null;
});

describe("loadBusinessHours", () => {
  it("returns the stored open days and the org zone", async () => {
    const hours = await loadBusinessHours();
    expect(hours.source).toBe("stored");
    expect(hours.zone).toBe(BUSINESS_ZONE);
    expect(hours.rules.map((r) => r.weekday)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(hours.rules[0]).toEqual({ weekday: 1, start_minute: 480, end_minute: 1200 });
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
