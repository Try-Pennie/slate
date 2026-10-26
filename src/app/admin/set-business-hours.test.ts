import { describe, it, expect, vi, beforeEach } from "vitest";

// #1297: the setBusinessHours admin action, which decides when Pennie is OPEN and so
// gates every time every lead is offered. Pinned here:
//
//  * admin only, and a refusal writes nothing;
//  * a bad week comes back as STATE, not a redirect, so twenty-one entered fields
//    survive (re-typing a week after a bounce is how someone ends up editing the
//    database instead);
//  * closing a day that already holds appointments WARNS FIRST and saves on the
//    second submit, per Dan's decision, with the existing appointments left alone;
//  * the appointment count pages the bookings read, because a truncated read would
//    under-count and let someone close a day believing it was empty;
//  * it does NOT mass-invalidate the slot cache. Gate 1 filters cached slots against
//    the current hours at READ time (#1296), so a narrowing lands on the next request
//    without touching a row, and marking 60+ buckets stale would risk a false
//    bucket_slots_stale page. That is a real regression risk because the horizon save
//    right next door DOES invalidate, so copying it would look correct.
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  requireManager: vi.fn(),
  currentUser: vi.fn(),
  realCurrentUser: vi.fn(),
}));
const recordAudit = vi.hoisted(() =>
  vi.fn(async (_entry: { action: string; details: { week: unknown[] } }) => {}),
);
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
const markAllBucketSlotsStale = vi.hoisted(() => vi.fn(async () => 3));
const loadBusinessHoursRows = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
/** #1458: the roster the coverage warning is measured against. Mocked so the
 *  action drives the REAL coverageForWeek predicate over a roster this file
 *  controls, rather than a second copy of the comparison (L107). */
const loadCoverageAgents = vi.hoisted(() =>
  vi.fn(async () => [] as { timezone: string; rules: unknown[] }[]),
);

/** Records every upsert, and serves the paged bookings read. */
const db = vi.hoisted(() => ({
  upserts: [] as { table: string; rows: unknown }[],
  bookingRows: [] as { starts_at: string }[],
  bookingPages: 0,
}));

const from = vi.hoisted(() => {
  return vi.fn((table: string) => {
    const builder: Record<string, unknown> = {
      upsert: (rows: unknown) => {
        db.upserts.push({ table, rows });
        return Promise.resolve({ error: null });
      },
      select: () => builder,
      in: () => builder,
      gte: () => builder,
      eq: () => builder,
      is: () => builder,
      order: () => builder,
      // The keyset filter selectAllPages cuts each later page with; the table's
      // primary key is modelled as the row's position.
      gt: (_col: string, after: string) => {
        builder.after = after;
        return builder;
      },
      range: (fromRow: number, toRow: number) => {
        db.bookingPages++;
        const keyed = db.bookingRows.map((r, i) => ({ id: `b${String(i).padStart(6, "0")}`, ...r }));
        const after = builder.after as string | undefined;
        return Promise.resolve({
          data: keyed.filter((r) => after === undefined || r.id > after).slice(fromRow, toRow + 1),
          error: null,
        });
      },
    };
    return builder;
  });
});

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale }));
vi.mock("@/lib/booking/business-hours-load", () => ({ loadBusinessHoursRows }));
vi.mock("@/lib/booking/business-hours-coverage-load", () => ({
  loadCoverageAgents,
  currentWeekStartIso: () => "2026-08-10",
}));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn(), applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));

import { setBusinessHours, setBusinessHoursException } from "./actions";
import { COVERAGE_UNCHECKED_WARNING } from "@/lib/monitor/roster-coverage";

/** One bookable agent, Eastern, Monday to Friday 09:00 to 17:00. Every live agent
 *  is Eastern, so this is the shape production actually has. */
const EASTERN_NINE_TO_FIVE = {
  timezone: "America/New_York",
  rules: [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    start_minute: 9 * 60,
    end_minute: 17 * 60,
  })),
};

/** A full open week as the form posts it, 08:00 to 20:00. */
function weekForm(over: Record<string, string | null> = {}): FormData {
  const fd = new FormData();
  for (const d of [1, 2, 3, 4, 5, 6, 7]) {
    fd.set(`bh_open_${d}`, "on");
    fd.set(`bh_start_${d}`, "08:00");
    fd.set(`bh_end_${d}`, "20:00");
  }
  for (const [k, v] of Object.entries(over)) {
    if (v === null) fd.delete(k);
    else fd.set(k, v);
  }
  return fd;
}

const openWeek = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  weekday,
  is_open: true,
  start_minute: 480,
  end_minute: 1200,
}));

beforeEach(() => {
  vi.clearAllMocks();
  db.upserts = [];
  db.bookingRows = [];
  db.bookingPages = 0;
  auth.requireAdmin.mockResolvedValue({ id: "admin1", role: "admin", org_id: "o1" });
  loadBusinessHoursRows.mockResolvedValue(openWeek);
  loadCoverageAgents.mockResolvedValue([EASTERN_NINE_TO_FIVE]);
});

describe("setBusinessHours", () => {
  it("rejects a non-admin caller and writes nothing", async () => {
    auth.requireAdmin.mockRejectedValueOnce(new Error("Not authorized"));
    await expect(setBusinessHours({ error: null }, weekForm())).rejects.toThrow();
    expect(db.upserts).toHaveLength(0);
  });

  it("saves a valid week as seven rows in one upsert, so it can never be half-saved", async () => {
    const state = await setBusinessHours({ error: null }, weekForm());

    expect(state.error).toBeNull();
    expect(state.ok).toBe(true);
    expect(db.upserts).toHaveLength(1);
    const rows = db.upserts[0].rows as { weekday: number }[];
    expect(db.upserts[0].table).toBe("business_hours");
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("does NOT mass-invalidate the slot cache", async () => {
    await setBusinessHours({ error: null }, weekForm());
    // The read-time filter (#1296) makes a narrowing effective on the next request,
    // and marking every bucket stale can page a false bucket_slots_stale alarm.
    expect(markAllBucketSlotsStale).not.toHaveBeenCalled();
  });

  it("returns a bad week as state rather than navigating, and writes nothing", async () => {
    const state = await setBusinessHours({ error: null }, weekForm({ bh_start_3: "" }));

    expect(state.error).toMatch(/wednesday/i);
    expect(redirect).not.toHaveBeenCalled();
    expect(db.upserts).toHaveLength(0);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("records the saved week in the audit trail", async () => {
    await setBusinessHours({ error: null }, weekForm());
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const entry = recordAudit.mock.calls[0][0];
    expect(entry.action).toBe("org.business_hours");
    expect(entry.details.week).toHaveLength(7);
  });

  describe("closing a day that already holds appointments", () => {
    // Monday 2026-06-08 12:00 New York. The week above is open every day, so
    // unchecking Monday closes it.
    const mondayBooking = { starts_at: "2026-06-08T16:00:00.000Z" };

    it("warns with a count first and saves nothing yet", async () => {
      db.bookingRows = [mondayBooking, mondayBooking];
      const state = await setBusinessHours({ error: null }, weekForm({ bh_open_1: null }));

      expect(state.confirm?.message).toMatch(/Monday/);
      expect(state.confirm?.message).toMatch(/2 appointments/);
      // A warning is NOT an error: nothing is wrong, the person just has to see the
      // consequence before it happens.
      expect(state.error).toBeNull();
      expect(db.upserts).toHaveLength(0);
    });

    it("saves on the second submit, and still moves nobody", async () => {
      db.bookingRows = [mondayBooking];
      const form = weekForm({ bh_open_1: null });
      form.set("confirm_close", "1");

      const state = await setBusinessHours({ error: null }, form);

      expect(state.ok).toBe(true);
      expect(db.upserts).toHaveLength(1);
      const rows = db.upserts[0].rows as { weekday: number; is_open: boolean }[];
      expect(rows.find((r) => r.weekday === 1)!.is_open).toBe(false);
      // Nothing rescheduled, cancelled or reassigned: the appointments stand.
      expect(db.upserts).toHaveLength(1);
    });

    it("does not warn when the day being closed is empty", async () => {
      db.bookingRows = [{ starts_at: "2026-06-09T16:00:00.000Z" }]; // Tuesday
      const state = await setBusinessHours({ error: null }, weekForm({ bh_open_1: null }));

      expect(state.confirm).toBeFalsy();
      expect(state.ok).toBe(true);
      expect(db.upserts).toHaveLength(1);
    });

    it("does not warn about a day that was already closed", async () => {
      // Sunday already shut, and it is not re-submitted as open.
      loadBusinessHoursRows.mockResolvedValue(
        openWeek.map((r) => (r.weekday === 7 ? { ...r, is_open: false } : r)),
      );
      db.bookingRows = [{ starts_at: "2026-06-14T16:00:00.000Z" }]; // a Sunday booking
      const state = await setBusinessHours({ error: null }, weekForm({ bh_open_7: null }));

      expect(state.confirm).toBeFalsy();
      expect(state.ok).toBe(true);
    });

    it("pages the bookings read, so a big diary cannot under-count the warning", async () => {
      // More than one PostgREST page of future bookings, all on the Monday being
      // closed. A single-page read would stop at 1,000 and, if the count landed at
      // zero, would let someone close a day believing it was empty.
      db.bookingRows = Array.from({ length: 1500 }, () => mondayBooking);
      const state = await setBusinessHours({ error: null }, weekForm({ bh_open_1: null }));

      expect(db.bookingPages).toBeGreaterThan(1);
      expect(state.confirm?.message).toMatch(/1500 appointments/);
    });
  });
  // ---------------------------------------------------------------- #1458
  //
  // The wiring, which the pure comparison in scripts/test-roster-coverage-gap.ts
  // cannot see: that a save which widens the week past its roster comes back
  // CARRYING the warning, that a save which does not stays silent, and that a
  // coverage read which fails says so instead of reading as "nothing added".
  //
  // Every case here goes through the real coverageForWeek / newlyUncoveredGaps,
  // so this can only pass while the action is really consulting them.
  describe("warning when the save opens hours nobody covers", () => {
    beforeEach(() => {
      // Before: Monday to Friday 09:00 to 17:00, exactly matching the roster, so
      // the week starts fully covered and any gap reported is one this save made.
      loadBusinessHoursRows.mockResolvedValue(
        [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          is_open: weekday <= 5,
          start_minute: 9 * 60,
          end_minute: 17 * 60,
        })),
      );
    });

    /** Monday to Friday 08:00 to 20:00, weekend left shut. */
    const widerWeek = () => weekForm({ bh_open_6: null, bh_open_7: null });

    it("names the stretches the change opened, and still saves", async () => {
      const state = await setBusinessHours({ error: null }, widerWeek());

      expect(state.ok).toBe(true);
      expect(state.error).toBeNull();
      // The save is not held back: a warning, never a refusal (L54).
      expect(db.upserts).toHaveLength(1);
      expect(state.warning).toMatch(/^Saved\./);
      expect(state.warning).toContain("08:00 to 09:00 Monday to Friday");
      expect(state.warning).toContain("17:00 to 20:00 Monday to Friday");
      // It says what a lead experiences, and both ways out.
      expect(state.warning).toMatch(/offered nothing/);
      expect(state.warning).toMatch(/working hours/);
    });

    it("stays silent when the save adds no uncovered time", async () => {
      // The same week back again: nothing widened, so nothing to say.
      const sameWeek = weekForm({
        bh_open_6: null,
        bh_open_7: null,
        bh_start_1: "09:00",
        bh_end_1: "17:00",
        bh_start_2: "09:00",
        bh_end_2: "17:00",
        bh_start_3: "09:00",
        bh_end_3: "17:00",
        bh_start_4: "09:00",
        bh_end_4: "17:00",
        bh_start_5: "09:00",
        bh_end_5: "17:00",
      });
      const state = await setBusinessHours({ error: null }, sameWeek);

      expect(state.ok).toBe(true);
      expect(state.warning).toBeFalsy();
    });

    it("says the roster could not be read rather than reading as nothing added", async () => {
      // The failure mode that matters: an unreadable roster and a change that adds
      // nothing both produce no gaps, and only one of them is safe to render as
      // silence (L11, L98). The save itself must still stand.
      loadCoverageAgents.mockRejectedValueOnce(new Error("pool read failed"));
      const state = await setBusinessHours({ error: null }, widerWeek());

      expect(state.ok).toBe(true);
      expect(state.error).toBeNull();
      expect(db.upserts).toHaveLength(1);
      expect(state.warning).toBe(COVERAGE_UNCHECKED_WARNING);
      expect(state.warning).not.toBe(null);
    });
  });
});

/**
 * #2219: a saved date has to say what it DID.
 *
 * The page confirmed every save, closed or open, with "Saved. Leads see that
 * date straight away." A closed date is the one leads do not see, so the
 * commonest save asserted the opposite of what had happened. The wording lives in
 * `business-hours-copy.ts`; what is pinned here is that the ACTION reports which
 * of the two outcomes it wrote, since a component cannot derive a sentence from a
 * bare `ok: true` (L608).
 */
describe("setBusinessHoursException", () => {
  function dateForm(over: Record<string, string> = {}): FormData {
    const fd = new FormData();
    fd.set("on_date", "2027-01-01");
    fd.set("state", "closed");
    for (const [k, v] of Object.entries(over)) fd.set(k, v);
    return fd;
  }

  it("reports a CLOSED save as closed, naming the date it wrote", async () => {
    const res = await setBusinessHoursException({ error: null }, dateForm());
    expect(res.error).toBeNull();
    expect(res.ok).toBe(true);
    expect(res.saved).toEqual({ onDate: "2027-01-01", isOpen: false });
  });

  it("reports an OPEN save as open, so the two outcomes are told apart", async () => {
    const res = await setBusinessHoursException(
      { error: null },
      dateForm({ state: "open", start: "09:00", end: "13:00" }),
    );
    expect(res.ok).toBe(true);
    expect(res.saved).toEqual({ onDate: "2027-01-01", isOpen: true });
  });

  it("reports nothing saved when the form is refused, so no notice can be drawn", async () => {
    const res = await setBusinessHoursException({ error: null }, dateForm({ on_date: "nonsense" }));
    expect(res.error).toBeTruthy();
    expect(res.ok).toBeFalsy();
    expect(res.saved ?? null).toBeNull();
  });

  it("reports nothing saved while the close is still awaiting confirmation", async () => {
    db.bookingRows = [{ starts_at: "2027-01-01T15:00:00Z" }];
    const res = await setBusinessHoursException({ error: null }, dateForm());
    expect(res.confirm?.message).toBeTruthy();
    expect(res.saved ?? null).toBeNull();
    expect(db.upserts).toHaveLength(0);
  });
});
