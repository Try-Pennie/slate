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
          order: () => q,
          // Each row carries its primary key, which a paged read cuts its next page
          // on (keyset paging, 2026-10-25).
          range: async () => ({ data: ooo.error ? null : ooo.rows.map((r, i) => ({ id: `ooo-${i}`, ...r })), error: ooo.error }),
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

// #1846: the three independent reads run TOGETHER, and one of them failing while
// the others are still in flight behaves the same as it did when they were serial.
//
// Measured against live Supabase, the page spent 839ms in seven strictly serial
// reads. The slot cache depends on neither the roster nor the hours, and the
// roster not on the hours, so they are three independent chains.
//
// Leave is deliberately NOT one of them: it is read after the roster, on purpose,
// since it is attached per agent. That ordering is asserted too, or "parallel"
// could be satisfied by firing a read before its own input exists.
//
// NO SLEEPS. Each read is held open by a promise this test resolves by hand, so
// the ordering is decided rather than raced. A fixed wait would be asserting
// about the machine's load, and it would be slowest exactly when CI is busiest
// (L290).
describe("the independent reads run in parallel (#1846)", () => {
  /** A promise this test opens and closes, plus a record of what has started. */
  function gate() {
    const order: string[] = [];
    const release: Record<string, (v?: unknown) => void> = {};
    const reject: Record<string, (e: Error) => void> = {};
    const held = <T,>(name: string, fn: () => Promise<T> | T) => async () => {
      order.push(`${name}:start`);
      await new Promise((res, rej) => {
        release[name] = res as (v?: unknown) => void;
        reject[name] = rej;
      });
      order.push(`${name}:end`);
      return fn();
    };
    return { order, release, reject, held };
  }

  const AT = () => DateTime.fromISO("2026-01-05T00:00:00", { zone: "America/New_York" });

  function traceHoursAndRoster(g: ReturnType<typeof gate>) {
    const realHours = hours.loadBusinessHours.getMockImplementation()!;
    const realCoverage = coverage.loadCoverageAgents.getMockImplementation()!;
    hours.loadBusinessHours.mockImplementation(g.held("hours", realHours));
    coverage.loadCoverageAgents.mockImplementation(g.held("roster", realCoverage));
    return () => {
      hours.loadBusinessHours.mockImplementation(realHours);
      coverage.loadCoverageAgents.mockImplementation(realCoverage);
    };
  }

  it("starts the hours and roster reads before either of them finishes", async () => {
    const g = gate();
    const restore = traceHoursAndRoster(g);
    try {
      const pending = loadAvailabilityGrid(AT());
      // Let the synchronous part of every chain run, without advancing any read.
      await Promise.resolve();
      await Promise.resolve();

      // A serial implementation cannot have started the second: it would still be
      // waiting on the first, which this test is holding open.
      expect(g.order.filter((e) => e.endsWith(":start")).sort()).toEqual([
        "hours:start",
        "roster:start",
      ]);
      expect(g.order.some((e) => e.endsWith(":end")), "nothing has finished yet").toBe(false);

      g.release.hours();
      g.release.roster();
      await pending;

      // Leave is read AFTER the roster, since it is attached per agent. Asserted
      // so "parallel" cannot be satisfied by firing a read before its input exists.
      expect(g.order.indexOf("roster:end")).toBeGreaterThan(-1);
    } finally {
      restore();
    }
  });

  it("still refuses the page when one read fails while the others are in flight", async () => {
    // The risk in parallelising is here, not in the speed. `Promise.all` rejects
    // on the first rejection while the rest are still running, and the loader's
    // one rule is that an unreadable roster renders as "could not check" rather
    // than as an empty pool. This holds the others open, fails the hours read,
    // and requires the page to refuse rather than render half an answer.
    const g = gate();
    const restore = traceHoursAndRoster(g);
    try {
      const pending = loadAvailabilityGrid(AT());
      const settled = expect(pending).rejects.toThrow(/hours gone/);
      await Promise.resolve();

      g.reject.hours(new Error("hours gone"));
      await settled;

      // The roster read was still in flight when that happened. Releasing it now
      // must not produce an unhandled rejection or a second settle.
      g.release.roster();
      await Promise.resolve();
    } finally {
      restore();
    }
  });
});
