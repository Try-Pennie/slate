import { describe, it, expect, vi, beforeEach } from "vitest";

// The reads behind the availability grid (#1302). The pure grid logic is driven
// natively by scripts/test-availability-grid.ts; what only this layer can be
// wrong about is the ASSEMBLY, and it has two ways to be wrong that would both
// render as a confident, wrong screen:
//
//  - a roster read that THROWS becoming "nobody is rostered" rather than "not
//    measured", which sends somebody to fix a roster that was fine;
//  - coverage computed for ONE week and applied to a fortnight, which would leave
//    the second week keyed on a Monday nothing wrote and read as unmeasured.

const hours = vi.hoisted(() => ({
  loadBusinessHours: vi.fn(async () => ({
    zone: "America/New_York",
    source: "stored" as const,
    // #1363: no date exceptions in this fixture; the date-override cases live in
    // scripts/test-business-hours-exceptions.ts.
    exceptions: [],
    // Open Monday to Friday, 09:00 to 11:00, so the grid has two hours a day.
    rules: [1, 2, 3, 4, 5].map((weekday) => ({
      weekday,
      start_minute: 9 * 60,
      end_minute: 11 * 60,
    })),
  })),
}));
const coverage = vi.hoisted(() => ({
  loadCoverageAgents: vi.fn(async () => [
    { userId: "a1", timezone: "America/New_York", rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 11 * 60 })) },
    { userId: "a2", timezone: "America/New_York", rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 11 * 60 })) },
  ]),
}));
const slots = vi.hoisted(() => ({
  rows: [] as { payload: unknown }[],
  error: null as { message: string } | null,
}));
// Approved time off (#1582): what the ooo_requests read returns. The mock chain
// mirrors the real query's shape (select/eq/lt/gt/range) so the wiring is the
// thing under test, not a stub of it.
const ooo = vi.hoisted(() => ({
  rows: [] as { user_id: string; starts_at: string; ends_at: string }[],
  error: null as { message: string } | null,
}));

vi.mock("@/lib/booking/business-hours-load", () => hours);
vi.mock("@/lib/booking/business-hours-coverage-load", async () => {
  const actual = await vi.importActual<typeof import("@/lib/booking/business-hours-coverage-load")>(
    "@/lib/booking/business-hours-coverage-load",
  );
  return { ...actual, loadCoverageAgents: coverage.loadCoverageAgents };
});
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === "ooo_requests") {
        const q = {
          select: () => q,
          eq: () => q,
          lt: () => q,
          gt: () => q,
          range: async () => ({ data: ooo.rows, error: ooo.error }),
        };
        return q;
      }
      return { select: async () => ({ data: slots.rows, error: slots.error }) };
    },
  }),
}));

import { DateTime } from "luxon";
import { loadAvailabilityGrid, GRID_DAYS } from "./availability-grid-load";

/** A Wednesday, so the fortnight below crosses two week boundaries and the
 *  per-week coverage lookup has to hold for all three. */
const NOW = DateTime.fromISO("2026-08-19T12:00:00", { zone: "America/New_York" });

beforeEach(() => {
  vi.clearAllMocks();
  slots.rows = [];
  slots.error = null;
  ooo.rows = [];
  ooo.error = null;
});

describe("loadAvailabilityGrid (#1302)", () => {
  it("covers every day of the range, across the week boundaries it crosses", async () => {
    const grid = await loadAvailabilityGrid(NOW);

    expect(grid.days).toHaveLength(GRID_DAYS);
    expect(grid.measurable).toBe(true);
    // The failure this catches: coverage computed for one week and looked up by a
    // key nothing wrote for the others, which would silently read as unmeasured.
    expect(grid.days.every((d) => d.cells.every((c) => c.kind !== "unknown"))).toBe(true);
    expect(grid.hours).toEqual([9, 10]);
  });

  it("says nothing was measured when the roster cannot be read", async () => {
    coverage.loadCoverageAgents.mockRejectedValueOnce(new Error("pool read failed"));

    const grid = await loadAvailabilityGrid(NOW);

    expect(grid.measurable).toBe(false);
    // NOT "nobody is rostered". `loadCoverageAgents` throws rather than returning
    // an empty pool precisely so this distinction survives to the screen.
    expect(grid.days.every((d) => d.cells.every((c) => c.kind === "unknown"))).toBe(true);
  });

  it("separates days inside the booking horizon from days past it", async () => {
    const grid = await loadAvailabilityGrid(NOW);
    const kinds = grid.days.map((d) => d.cells[0].kind);

    // Wednesday plus three days is inside the four day horizon; everything after
    // it is staffed but not yet offered, which is not the same as being full.
    expect(kinds.slice(0, 2)).toEqual(["booked", "booked"]);
    expect(kinds.filter((k) => k === "beyond-horizon").length).toBeGreaterThan(0);
    // A weekend day the org is shut is closed either way, horizon or not.
    expect(kinds).toContain("closed");
  });

  it("reads a bookable hour from the cached slots, counting pools not start times", async () => {
    const iso = (t: string) => `2026-08-19T${t}:00.000-04:00`;
    slots.rows = [
      { payload: { slots: [iso("09:00"), iso("09:30")], eventType: { duration_min: 15 } } },
      { payload: { slots: [iso("09:00")], eventType: { duration_min: 15 } } },
    ];

    const grid = await loadAvailabilityGrid(NOW);
    const today = grid.days[0].cells[0];

    expect(today.kind).toBe("open");
    expect(today.kind === "open" && today.buckets).toBe(2);
    expect(today.kind === "open" && today.agents).toBe(2);
  });

  it("attaches approved leave to the right agent and discounts the hours it overlaps (#1582)", async () => {
    // a1 is away for the whole of today; a2 is present. Keyed per userId: leave
    // attached to nobody would count 2, and to everybody would read as away.
    ooo.rows = [
      { user_id: "a1", starts_at: "2026-08-19T00:00:00.000-04:00", ends_at: "2026-08-20T00:00:00.000-04:00" },
    ];

    const grid = await loadAvailabilityGrid(NOW);
    const today = grid.days[0].cells[0];

    expect(today.kind).toBe("booked");
    expect(today.kind === "booked" && today.agents).toBe(1);
    // Tomorrow the leave is over and both count again.
    const tomorrow = grid.days[1].cells[0];
    expect(tomorrow.kind === "booked" && tomorrow.agents).toBe(2);
  });

  it("renders a fully-away hour as away, not as booked out (#1582)", async () => {
    ooo.rows = ["a1", "a2"].map((user_id) => ({
      user_id,
      starts_at: "2026-08-19T00:00:00.000-04:00",
      ends_at: "2026-08-20T00:00:00.000-04:00",
    }));

    const grid = await loadAvailabilityGrid(NOW);
    const today = grid.days[0].cells[0];

    expect(today.kind).toBe("away");
    expect(today.kind === "away" && today.away).toBe(2);
  });

  it("says nothing was measured when the leave read fails (#1582)", async () => {
    // Rendering an unreadable leave read as fully staffed would be the exact
    // defect the leave read exists to fix, on the day it matters.
    ooo.error = { message: "relation does not exist" };

    const grid = await loadAvailabilityGrid(NOW);

    expect(grid.measurable).toBe(false);
    expect(grid.days.every((d) => d.cells.every((c) => c.kind === "unknown"))).toBe(true);
  });

  it("throws rather than reporting a quietly empty grid when the slot read fails", async () => {
    // A swallowed slot error would render every staffed hour as booked out, which
    // is a confident wrong answer about the thing this screen exists to report.
    slots.error = { message: "relation does not exist" };

    await expect(loadAvailabilityGrid(NOW)).rejects.toThrow();
  });
});
