import { describe, it, expect, vi, beforeEach } from "vitest";

// The reads behind the per bucket supply page (#1254). The report logic itself is
// driven natively by scripts/test-bucket-supply.ts; what only this layer can be
// wrong about is which READ FAILING means what, and every way of getting that
// wrong renders as a confident, wrong screen:
//
//  - an unreadable week producing a page of shares measured against a maximum
//    nobody could derive;
//  - an unreadable slot cache rendering as sixty buckets with no availability,
//    which is the exact opposite of what is known;
//  - an unreadable roster rendering as zero eligible agents, which sends somebody
//    to fix a routing pool that was fine;
//  - an unreadable HORIZON (#1654) rendering a page of shares measured against a
//    window nobody chose. That one is the worst of the four to get wrong, because
//    the number LOOKS right: the horizon decides both how many day columns are
//    shown and where each bucket's own allowance runs out, so a guessed one
//    silently changes what every share MEANS rather than making it unavailable.
//
// Each of those is a read that CAN fail, so each gets a test that makes it fail.

const hours = vi.hoisted(() => ({
  loadBusinessHours: vi.fn(async () => ({
    zone: "America/New_York",
    source: "stored" as const,
    exceptions: [],
    // Open Monday to Saturday, 09:00 to 17:00: the week the worked example ran on.
    rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      start_minute: 9 * 60,
      end_minute: 17 * 60,
    })),
  })),
}));

const settings = vi.hoisted(() => ({
  readBookingHorizonDays: vi.fn(async (): Promise<number | null> => 4),
}));

// #3922: the offered open days, a stored setting read through its own loader.
const offered = vi.hoisted(() => ({
  readOfferedOpenDays: vi.fn(async (): Promise<number | null> => 3),
}));

const depth = vi.hoisted(() => ({
  loadTierDepths: vi.fn(async () => [
    { code: "120", name: "Low | Beyond | No Legal Param", depth: 4, effectiveDepth: 3, poolKey: "pool-low-beyond", poolLabel: "Low with Beyond", agents: [{ id: "a1", name: "A", out: false }] },
    { code: "110", name: "Low | Both | No Legal Param", depth: 9, effectiveDepth: 9, poolKey: "pool-low", poolLabel: "Low", agents: [{ id: "a1", name: "A", out: false }, { id: "a2", name: "B", out: false }] },
  ]),
}));

// #3939: each pool's day in calls, from its advisors' calendars. Stood in for here; the adding up
// is driven by scripts/test-bucket-calls.ts and the reads by bucket-calls-load.test.ts.
const DAY0 = "2026-08-04";
const CALLS = () =>
  new Map([
    ["110", new Map([[DAY0, { taken: 5, capacity: 20 }]])],
    ["120", new Map([[DAY0, { taken: 2, capacity: 8 }]])],
  ]);
const calls = vi.hoisted(() => ({ loadPoolCalls: vi.fn() }));
vi.mock("@/lib/admin/bucket-calls-load", () => calls);

// The two table reads, each with its own error seam, so one can be made to fail
// while the other stays healthy.
const db = vi.hoisted(() => ({
  slotRows: [] as unknown[],
  slotError: null as { message: string } | null,
  bucketRows: [] as unknown[],
  bucketError: null as { message: string } | null,
  /** Booked start times, as the bookings table returns them (#1937). */
  bookingRows: [] as { starts_at: string; buckets: { code: string } | null }[],
  bookingError: null as { message: string } | null,
  /** What the bookings read actually asked for, so the filters can be asserted. */
  bookingQuery: { select: "", filters: [] as [string, string, string][] },
}));

vi.mock("@/lib/booking/business-hours-load", () => hours);
vi.mock("@/lib/booking/settings", () => settings);
vi.mock("@/lib/booking/days-offered-load", () => offered);
vi.mock("@/lib/routing/staffing-depth-load", () => depth);
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === "bucket_slots") {
        return {
          select: async () => ({ data: db.slotRows, error: db.slotError }),
        };
      }
      if (table === "buckets") {
        const q = {
          select: () => q,
          eq: async () => ({ data: db.bucketRows, error: db.bucketError }),
        };
        return q;
      }
      // #1937: the times already booked, the numerator of every share. The call
      // site paginates, so this answers one page and then an EMPTY one, or the
      // loader would ask for the next page forever.
      if (table === "bookings") {
        let served = false;
        // RECORDED, not swallowed. A fake whose filters are passthroughs cannot
        // tell a query that excludes cancelled bookings from one that counts
        // them, and both mutations survived until this recorded them: the
        // assertions below are what make those filters real (L143).
        const q = {
          select: (cols: string) => {
            db.bookingQuery.select = cols;
            return q;
          },
          eq: (col: string, val: unknown) => {
            db.bookingQuery.filters.push(["eq", col, String(val)]);
            return q;
          },
          neq: (col: string, val: unknown) => {
            db.bookingQuery.filters.push(["neq", col, String(val)]);
            return q;
          },
          gte: (col: string, val: unknown) => {
            db.bookingQuery.filters.push(["gte", col, String(val)]);
            return q;
          },
          lt: (col: string, val: unknown) => {
            db.bookingQuery.filters.push(["lt", col, String(val)]);
            return q;
          },
          order: () => q,
          range: async () => {
            if (db.bookingError) return { data: null, error: db.bookingError };
            // Each row carries its primary key, which a paged read cuts its next
            // page on (keyset paging, 2026-10-25).
            const page = served ? [] : db.bookingRows.map((r, i) => ({ id: `bk-${i}`, ...r }));
            served = true;
            return { data: page, error: null };
          },
        };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const { loadBucketSupply } = await import("./bucket-supply-load");

// 2026-08-04 at 11:19 America/New_York, the instant behind the issue's worked
// example. Pinned so real time can never walk the fixture into a different case.
const NOW = new Date("2026-08-04T15:19:00.000Z");

/** Twenty one ten minute starts from 13:20 ET on 2026-08-04: the whole day. */
const FULL_DAY = Array.from({ length: 21 }, (_, i) =>
  new Date(Date.parse("2026-08-04T17:20:00.000Z") + i * 10 * 60_000).toISOString(),
);

const EVENT_TYPE = {
  duration_min: 20,
  slot_interval_min: 10,
  min_notice_min: 120,
  buffer_before_min: 0,
  buffer_after_min: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  calls.loadPoolCalls.mockImplementation(async () => CALLS());
  db.bookingRows = [];
  db.bookingError = null;
  db.bookingQuery = { select: "", filters: [] };
  hours.loadBusinessHours.mockResolvedValue({
    zone: "America/New_York",
    source: "stored",
    exceptions: [],
    rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      start_minute: 9 * 60,
      end_minute: 17 * 60,
    })),
  });
  settings.readBookingHorizonDays.mockResolvedValue(4);
  offered.readOfferedOpenDays.mockResolvedValue(3);
  depth.loadTierDepths.mockResolvedValue([
    { code: "120", name: "Low | Beyond | No Legal Param", depth: 4, effectiveDepth: 3, poolKey: "pool-low-beyond", poolLabel: "Low with Beyond", agents: [{ id: "a1", name: "A", out: false }] },
    { code: "110", name: "Low | Both | No Legal Param", depth: 9, effectiveDepth: 9, poolKey: "pool-low", poolLabel: "Low", agents: [{ id: "a1", name: "A", out: false }, { id: "a2", name: "B", out: false }] },
  ]);
  db.slotRows = [
    {
      bucket_code: "120",
      payload: { slots: FULL_DAY.slice(0, 9), eventType: EVENT_TYPE },
      computed_at: new Date(NOW.getTime() - 30_000).toISOString(),
    },
    {
      bucket_code: "110",
      payload: { slots: FULL_DAY, eventType: EVENT_TYPE },
      computed_at: new Date(NOW.getTime() - 30_000).toISOString(),
    },
  ];
  db.slotError = null;
  db.bucketRows = [
    { code: "120", name: "Low | Beyond | No Legal Param", is_test: false },
    { code: "110", name: "Low | Both | No Legal Param", is_test: false },
    { code: "SMOKE", name: "Smoke test bucket", is_test: true },
  ];
  db.bucketError = null;
});

describe("loadBucketSupply (#1254)", () => {
  it("measures each pool's day in calls taken out of the calls its shifts could hold", async () => {
    const report = await loadBucketSupply("org-1", NOW);
    expect(report.measurable).toBe(true);
    if (!report.measurable) return;

    const thin = report.rows.find((r) => r.code === "120");
    const full = report.rows.find((r) => r.code === "110");
    // #3939: calls taken out of the calls the pool's shifts could hold, Team capacity's measure.
    expect(thin?.cells[0]).toEqual({ kind: "counted", booked: 2, capacity: 8, share: 2 / 8 });
    expect(full?.cells[0]).toEqual({ kind: "counted", booked: 5, capacity: 20, share: 5 / 20 });
    // Each pool's own advisors, as staffing depth lists them, over the page's days.
    const [org, agentsByCode, days] = calls.loadPoolCalls.mock.calls[0]!;
    expect(org).toBe("org-1");
    expect(agentsByCode).toEqual(new Map([["120", ["a1"]], ["110", ["a1", "a2"]]]));
    expect(days[0]).toBe(DAY0);
    expect(thin?.depth).toBe(4);
    expect(thin?.effectiveDepth).toBe(3);
    expect(report.depthReadable).toBe(true);
    expect(report.bucketListReadable).toBe(true);
  });

  it("leaves the synthetic test bucket off the page", async () => {
    const report = await loadBucketSupply("org-1", NOW);
    if (!report.measurable) throw new Error("expected a report");
    expect(report.rows.map((r) => r.code)).not.toContain("SMOKE");
  });

  it("refuses to report at all when the office week cannot be read", async () => {
    hours.loadBusinessHours.mockRejectedValue(new Error("business hours are unusable"));
    const report = await loadBucketSupply("org-1", NOW);
    // Not a page of zeros, and not a page of shares against a maximum nobody
    // measured: every figure here is derived from the week.
    expect(report).toEqual({ measurable: false, reason: "business-hours" });
  });

  it("refuses to report at all when the slot cache read errors", async () => {
    db.slotError = { message: "relation bucket_slots does not exist" };
    const report = await loadBucketSupply("org-1", NOW);
    expect(report).toEqual({ measurable: false, reason: "slot-cache" });
  });

  it("never turns a failed roster read into zero eligible agents", async () => {
    depth.loadTierDepths.mockRejectedValue(new Error("roster unreadable"));
    const report = await loadBucketSupply("org-1", NOW);
    expect(report.measurable).toBe(true);
    if (!report.measurable) return;

    expect(report.depthReadable).toBe(false);
    expect(report.rows.every((r) => r.depth === null && r.effectiveDepth === null)).toBe(true);
    // #3939: a day is counted in the calls of the pool's own advisors, and the roster is what says
    // who they are, so without it the day is unknown rather than measured some other way: a share
    // in start times beside shares in calls would be one word for two measures (L118).
    expect(calls.loadPoolCalls).not.toHaveBeenCalled();
    expect(report.rows.find((r) => r.code === "120")?.cells[0]).toEqual({ kind: "unknown" });
  });

  it("falls back to the cache's own codes when the bucket list read errors", async () => {
    db.bucketError = { message: "relation buckets does not exist" };
    const report = await loadBucketSupply("org-1", NOW);
    expect(report.measurable).toBe(true);
    if (!report.measurable) return;

    expect(report.bucketListReadable).toBe(false);
    expect(report.rows.map((r) => r.code).sort()).toEqual(["110", "120"]);
    // Still measured: the cache carries which pool serves, the calls how full it is.
    expect(report.rows.find((r) => r.code === "110")?.cells[0]).toEqual({ kind: "counted", booked: 5, capacity: 20, share: 5 / 20 });
  });

  it("reports a bucket with no cached row as never computed, not as empty", async () => {
    db.slotRows = db.slotRows.filter(
      (r) => (r as { bucket_code: string }).bucket_code !== "120",
    );
    const report = await loadBucketSupply("org-1", NOW);
    if (!report.measurable) throw new Error("expected a report");

    const row = report.rows.find((r) => r.code === "120");
    expect(row?.cacheState).toBe("missing");
    expect(row?.freshness).toBe("unknown");
    expect(row?.cells[0]).toEqual({ kind: "unknown" });
  });

  it("scopes the bucket read to the caller's own org", async () => {
    const eq = vi.fn(async () => ({ data: db.bucketRows, error: null }));
    const supabase = await import("@/lib/supabase/admin");
    const spy = vi.spyOn(supabase, "supabaseAdmin").mockReturnValue({
      from: (table: string) =>
        table === "bucket_slots"
          ? { select: async () => ({ data: db.slotRows, error: null }) }
          : { select: () => ({ eq }) },
    } as unknown as ReturnType<typeof supabase.supabaseAdmin>);

    await loadBucketSupply("org-42", NOW);
    expect(eq).toHaveBeenCalledWith("org_id", "org-42");
    spy.mockRestore();
  });

  // #1654: the horizon is a measuring bound, so a guessed one is not a safe
  // stand in here. The monitor lane already refuses on this grounds; this surface
  // used to take the coded default and present the result as measured.
  it("refuses to report at all when the booking horizon could not be read", async () => {
    settings.readBookingHorizonDays.mockResolvedValue(null);
    const report = await loadBucketSupply("o1", new Date("2026-08-04T14:00:00Z"));
    expect(report.measurable).toBe(false);
    expect(report.measurable === false && report.reason).toBe("booking-horizon");
  });

  // The control beside it, in the same fixture: a horizon that reads fine still
  // produces a report, so the refusal above cannot be passing because this loader
  // stopped reporting altogether.
  it("still reports when the horizon reads fine", async () => {
    settings.readBookingHorizonDays.mockResolvedValue(4);
    const report = await loadBucketSupply("o1", new Date("2026-08-04T14:00:00Z"));
    expect(report.measurable).toBe(true);
  });

  // #3922: the offered open days set the window every row is judged over, so an
  // unreadable setting is the horizon's case again: no report, never one judged
  // over a guessed count.
  it("refuses to report at all when the offered open days could not be read", async () => {
    offered.readOfferedOpenDays.mockResolvedValue(null);
    const report = await loadBucketSupply("o1", new Date("2026-08-04T14:00:00Z"));
    expect(report.measurable === false && report.reason).toBe("offered-open-days");
  });

  it("judges the window over the stored offered open days, 4 when 4 are saved", async () => {
    offered.readOfferedOpenDays.mockResolvedValue(4);
    const report = await loadBucketSupply("o1", new Date("2026-08-04T14:00:00Z"));
    expect(report.measurable && report.offeredOpenDays).toBe(4);
    if (!report.measurable) return;
    const days = report.rows.find((r) => r.code === "110")?.offeredDays;
    expect(days).toHaveLength(4);
  });

  // #3939: booked times still feed the cover judgement, while how full the day is comes from calls.
  it("measures a day in calls even when bookings have been made through the bucket", async () => {
    db.bookingRows = FULL_DAY.slice(0, 7).map((starts_at) => ({
      starts_at,
      buckets: { code: "110" },
    }));
    const report = await loadBucketSupply("org-1", NOW);
    expect(report.measurable).toBe(true);
    if (!report.measurable) return;

    // The booked times are still read: they decide which days a pool still has times on (and the
    // monitor's start time measure, driven in scripts/test-bucket-supply.ts). How full the day is
    // comes from the calls (#3939).
    const cell = report.rows.find((r) => r.code === "110")?.cells[0];
    expect(cell).toEqual({ kind: "counted", booked: 5, capacity: 20, share: 5 / 20 });
  });

  // Every code of a pool carries staffing depth's pool key and label, and reads the same pool's
  // calls (#3939): the pool, not the code a lead came in on, is what fills up.
  it("gives every code of a pool its pool's key, label and calls", async () => {
    depth.loadTierDepths.mockResolvedValue([
      { code: "110", name: "Low | Both | No Legal Param", depth: 9, effectiveDepth: 9, poolKey: "pool-low", poolLabel: "Low", agents: [] },
      { code: "111", name: "Low | Both | Legal", depth: 9, effectiveDepth: 9, poolKey: "pool-low", poolLabel: "Low", agents: [] },
    ]);
    db.bucketRows = [
      { code: "110", name: "Low | Both | No Legal Param", is_test: false },
      { code: "111", name: "Low | Both | Legal", is_test: false },
    ];
    const stamp = new Date(NOW.getTime() - 30_000).toISOString();
    db.slotRows = ["110", "111"].map((bucket_code) => ({
      bucket_code,
      payload: { slots: FULL_DAY.slice(7), eventType: EVENT_TYPE },
      computed_at: stamp,
    }));
    const pool = new Map([[DAY0, { taken: 5, capacity: 20 }]]);
    calls.loadPoolCalls.mockResolvedValue(new Map([["110", pool], ["111", pool]]));
    db.bookingRows = FULL_DAY.slice(0, 7).map((starts_at) => ({ starts_at, buckets: { code: "110" } }));
    const report = await loadBucketSupply("org-1", NOW);
    expect(report.measurable).toBe(true);
    if (!report.measurable) return;
    const a = report.rows.find((r) => r.code === "110");
    const b = report.rows.find((r) => r.code === "111");
    expect(a?.cells[0]).toEqual({ kind: "counted", booked: 5, capacity: 20, share: 5 / 20 });
    expect(b?.cells).toEqual(a?.cells);
    expect(b?.poolKey).toBe("pool-low");
    expect(b?.poolLabel).toBe("Low");
  });

  // 2026-10-02: an empty pool is judged as the booker serves it, over the slot
  // rows this loader already reads. 110 is the Low whole tier rung on 120's ladder.
  it("marks an empty pool overflowing when a rung on the ladder has a time in the offered window", async () => {
    db.slotRows = [
      {
        bucket_code: "120",
        payload: { slots: [], eventType: EVENT_TYPE },
        computed_at: new Date(NOW.getTime() - 30_000).toISOString(),
      },
      {
        bucket_code: "110",
        payload: { slots: FULL_DAY, eventType: EVENT_TYPE },
        computed_at: new Date(NOW.getTime() - 30_000).toISOString(),
      },
    ];
    const report = await loadBucketSupply("org-1", NOW);
    expect(report.measurable).toBe(true);
    if (!report.measurable) return;
    expect(report.rows.find((r) => r.code === "120")?.cells[0]).toEqual({
      kind: "overflows",
      toPool: "Low",
    });
  });

  it("keeps an empty pool nothing on the ladder can take as nobody available", async () => {
    db.slotRows = [
      {
        bucket_code: "120",
        payload: { slots: [], eventType: EVENT_TYPE },
        computed_at: new Date(NOW.getTime() - 30_000).toISOString(),
      },
      {
        bucket_code: "110",
        payload: { slots: [], eventType: EVENT_TYPE },
        computed_at: new Date(NOW.getTime() - 30_000).toISOString(),
      },
    ];
    const report = await loadBucketSupply("org-1", NOW);
    if (!report.measurable) throw new Error("expected a report");
    expect(report.rows.find((r) => r.code === "120")?.cells[0]).toEqual({ kind: "nobody-available" });
  });

  it("says unknown rather than a share when the advisors' calendars cannot be read (#3939)", async () => {
    calls.loadPoolCalls.mockResolvedValue(null);
    const report = await loadBucketSupply("org-1", NOW);
    if (!report.measurable) throw new Error("expected a report");
    expect(report.rows.every((r) => r.cells.every((c) => c.kind !== "counted"))).toBe(true);
    expect(report.rows.find((r) => r.code === "110")?.cells[0]).toEqual({ kind: "unknown" });
  });

  // A read that could not measure must never be scored as zero booked, which is
  // exactly what a healthy quiet day looks like (L11).
  it("says unknown rather than zero booked when the bookings cannot be read", async () => {
    db.bookingError = { message: "statement timeout" };
    const report = await loadBucketSupply("org-1", NOW);
    expect(report.measurable).toBe(true);
    if (!report.measurable) return;

    // Not one share anywhere: a zero would read as "nothing is taken", which is
    // what every bucket honestly looks like today.
    expect(report.rows.every((r) => r.cells.every((c) => c.kind !== "counted"))).toBe(true);
    expect(report.rows[0].cells[0].kind).toBe("unknown");
    // A day the office is SHUT still says so, because that is known whatever the
    // bookings read did, and "unknown" about a closed day would be worse than
    // useless.
    const sunday = report.days.findIndex((d) => d.iso === "2026-08-09");
    expect(sunday).toBeGreaterThanOrEqual(0);
    expect(report.rows[0].cells[sunday].kind).toBe("closed");
  });

  // The filters are the correctness of this read, and nothing could see them
  // until the fake recorded them: both of these mutations survived first time.
  it("counts no cancelled booking, and asks only for the window on screen", async () => {
    await loadBucketSupply("org-1", NOW);

    const filters = db.bookingQuery.filters;
    // A cancelled time is FREE again, so counting it would report a bucket as
    // busier than it is. `rescheduled` is deliberately NOT excluded: that marks
    // a booking that moved, and the row carries the time it moved to.
    expect(filters).toContainEqual(["neq", "status", "cancelled"]);
    expect(filters.some(([op, col]) => op === "neq" && col === "status")).toBe(true);
    expect(filters).toContainEqual(["eq", "org_id", "org-1"]);

    // Bounded to the days the page draws, which is what keeps this off the whole
    // table: bookings is a growth table, not a roster bounded one.
    const lower = filters.find(([op, col]) => op === "gte" && col === "starts_at");
    const upper = filters.find(([op, col]) => op === "lt" && col === "starts_at");
    expect(lower).toBeTruthy();
    expect(upper).toBeTruthy();
    expect(Date.parse(lower![2])).toBeLessThanOrEqual(NOW.getTime());
    expect(Date.parse(upper![2])).toBeGreaterThan(NOW.getTime());

    // The bucket's code comes through the FOREIGN KEY rather than a second read
    // of `buckets`, which is what keeps this read working when the bucket list
    // one fails.
    expect(db.bookingQuery.select).toContain("buckets");
    expect(db.bookingQuery.select).toContain("starts_at");
  });
});
