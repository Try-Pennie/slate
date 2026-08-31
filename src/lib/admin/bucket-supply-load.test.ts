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
//    to fix a routing pool that was fine.
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

const settings = vi.hoisted(() => ({ loadBookingHorizonDays: vi.fn(async () => 4) }));

const depth = vi.hoisted(() => ({
  loadTierDepths: vi.fn(async () => [
    { code: "120", name: "Low | Beyond | No Legal Param", depth: 4, effectiveDepth: 3 },
    { code: "110", name: "Low | Both | No Legal Param", depth: 9, effectiveDepth: 9 },
  ]),
}));

// The two table reads, each with its own error seam, so one can be made to fail
// while the other stays healthy.
const db = vi.hoisted(() => ({
  slotRows: [] as unknown[],
  slotError: null as { message: string } | null,
  bucketRows: [] as unknown[],
  bucketError: null as { message: string } | null,
}));

vi.mock("@/lib/booking/business-hours-load", () => hours);
vi.mock("@/lib/booking/settings", () => settings);
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
  settings.loadBookingHorizonDays.mockResolvedValue(4);
  depth.loadTierDepths.mockResolvedValue([
    { code: "120", name: "Low | Beyond | No Legal Param", depth: 4, effectiveDepth: 3 },
    { code: "110", name: "Low | Both | No Legal Param", depth: 9, effectiveDepth: 9 },
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
  it("measures each bucket against the maximum the booker would derive", async () => {
    const report = await loadBucketSupply("org-1", NOW);
    expect(report.measurable).toBe(true);
    if (!report.measurable) return;

    const thin = report.rows.find((r) => r.code === "120");
    const full = report.rows.find((r) => r.code === "110");
    expect(thin?.cells[0]).toEqual({ kind: "counted", open: 9, max: 21, share: 9 / 21 });
    expect(full?.cells[0]).toEqual({ kind: "counted", open: 21, max: 21, share: 1 });
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
    // And the supply half is still measured: losing the roster must not blank a
    // page that can still answer the question it exists for.
    expect(report.rows.find((r) => r.code === "120")?.cells[0]).toEqual({
      kind: "counted",
      open: 9,
      max: 21,
      share: 9 / 21,
    });
  });

  it("falls back to the cache's own codes when the bucket list read errors", async () => {
    db.bucketError = { message: "relation buckets does not exist" };
    const report = await loadBucketSupply("org-1", NOW);
    expect(report.measurable).toBe(true);
    if (!report.measurable) return;

    expect(report.bucketListReadable).toBe(false);
    expect(report.rows.map((r) => r.code).sort()).toEqual(["110", "120"]);
    // Still measured, because the cache is what carries the answer.
    expect(report.rows.find((r) => r.code === "110")?.cells[0]).toEqual({
      kind: "counted",
      open: 21,
      max: 21,
      share: 1,
    });
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
});
