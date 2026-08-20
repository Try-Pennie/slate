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
    { timezone: "America/New_York", rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 11 * 60 })) },
    { timezone: "America/New_York", rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 11 * 60 })) },
  ]),
}));
const slots = vi.hoisted(() => ({
  rows: [] as { payload: unknown }[],
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
    from: () => ({ select: async () => ({ data: slots.rows, error: slots.error }) }),
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

  it("throws rather than reporting a quietly empty grid when the slot read fails", async () => {
    // A swallowed slot error would render every staffed hour as booked out, which
    // is a confident wrong answer about the thing this screen exists to report.
    slots.error = { message: "relation does not exist" };

    await expect(loadAvailabilityGrid(NOW)).rejects.toThrow();
  });
});
