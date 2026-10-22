import { describe, it, expect, vi, beforeEach } from "vitest";

// The reads behind Team capacity (#3935). The calculation itself is driven natively by
// scripts/test-team-capacity.ts; what only this layer can get wrong is which READ FAILING means
// what. Every one of them, degraded to an empty answer, would draw a team with no room, the exact
// reading that pauses ad spend, so each read that can fail gets a test that makes it fail and
// requires the page to name it instead (design decision D26).

const hours = vi.hoisted(() => ({
  loadBusinessHours: vi.fn(async () => ({
    zone: "America/New_York",
    source: "stored" as const,
    exceptions: [],
    rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 8 * 60, end_minute: 20 * 60 })),
  })),
}));
const offered = vi.hoisted(() => ({ readOfferedOpenDays: vi.fn(async (): Promise<number | null> => 4) }));
const eventType = { duration_min: 20, slot_interval_min: 10, min_notice_min: 5, buffer_before_min: 10, buffer_after_min: 10, daily_cap: null };
const service = vi.hoisted(() => ({
  resolveBucketByCode: vi.fn(async (code: string) => ({ bucket: { id: "b1", code, org_id: "org" }, eventType })),
  loadMembersAvailability: vi.fn(async (_b: unknown, _f: string, _t: string, resolve: (b: unknown) => Promise<{ ids: string[] }>) => {
    const { ids } = await resolve(_b);
    return {
      members: ids.map((userId) => ({
        userId,
        timezone: "America/New_York",
        rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 17 * 60 })),
        busy: [],
        bookingStartsMs: [],
        dayCounts: new Map(),
      })),
      lowIds: undefined,
    };
  }),
}));
const ooo = vi.hoisted(() => ({ approvedTimeOffIntervals: vi.fn(async () => new Map()) }));
const sync = vi.hoisted(() => ({ loadFailingAgents: vi.fn(async (): Promise<{ email: string }[] | null> => []) }));
const db = vi.hoisted(() => ({
  buckets: [] as unknown[],
  bucketError: null as { message: string } | null,
  users: [] as unknown[],
  userError: null as { message: string } | null,
}));

vi.mock("@/lib/booking/business-hours-load", () => hours);
vi.mock("@/lib/booking/days-offered-load", () => offered);
vi.mock("@/lib/availability/service", () => service);
vi.mock("@/lib/ooo/approved-overlap", () => ooo);
vi.mock("@/lib/google/sync", () => sync);
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const result = () =>
        table === "buckets" ? { data: db.buckets, error: db.bucketError } : { data: db.users, error: db.userError };
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is"]) q[m] = () => q;
      q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad);
      return q;
    },
  }),
}));

import { loadTeamCapacity } from "./team-capacity-load";

// Monday 19 October 2026, 15:34 in New York: before the 6pm cutoff, so today is a window day.
const now = new Date("2026-10-19T19:34:00Z");

beforeEach(() => {
  db.buckets = [
    { code: "100", event_type_id: "e1", is_test: false },
    { code: "200", event_type_id: "e1", is_test: null },
    { code: "SMOKE", event_type_id: "e2", is_test: true },
  ];
  db.bucketError = null;
  db.users = [
    { id: "u1", name: "Blake Abbott", email: "blake@x.com", is_test: null },
    { id: "u2", name: "Avery Calder", email: "avery@x.com", is_test: false },
    { id: "u3", name: "Smoke Test", email: "smoke@x.com", is_test: true },
  ];
  db.userError = null;
  hours.loadBusinessHours.mockClear();
  offered.readOfferedOpenDays.mockResolvedValue(4);
  service.resolveBucketByCode.mockClear();
  ooo.approvedTimeOffIntervals.mockResolvedValue(new Map());
  sync.loadFailingAgents.mockResolvedValue([]);
});

describe("loadTeamCapacity", () => {
  it("reports the window's days for every live advisor, a null test flag included", async () => {
    const r = await loadTeamCapacity({ orgId: "org", now });
    expect(r.measurable).toBe(true);
    if (!r.measurable) return;
    expect(r.windowDays).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"]);
    expect(r.bookerDays).toEqual(r.windowDays);
    expect(r.advisors.map((a) => a.name)).toEqual(["Avery Calder", "Blake Abbott"]);
    expect(r.advisors[0].days).toHaveLength(4);
  });

  it("keeps today after the 6 PM cutoff, ahead of the booker's days (#3949)", async () => {
    // Monday 19 October, 7:10 PM in New York: the booker's days start tomorrow, and today's
    // remaining times are still served, so the page still shows today.
    const r = await loadTeamCapacity({ orgId: "org", now: new Date("2026-10-19T23:10:00Z") });
    expect(r.measurable && r.windowDays).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
    // The booker's own days leave today out, and the report still holds each of them (#4064).
    expect(r.measurable && r.bookerDays).toEqual(["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
    expect(r.measurable && r.bookerDays.every((d) => r.days.includes(d))).toBe(true);
  });

  it("does not add today after the cutoff on a day the office is shut", async () => {
    // Sunday 25 October, 7:10 PM: the office's week here holds no Sunday.
    const r = await loadTeamCapacity({ orgId: "org", now: new Date("2026-10-25T23:10:00Z") });
    expect(r.measurable && r.windowDays).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"]);
    expect(r.measurable && r.bookerDays).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"]);
  });

  it("adds a picked day after the window's", async () => {
    const r = await loadTeamCapacity({ orgId: "org", now, extraDay: "2026-10-26" });
    expect(r.measurable && r.days).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-26"]);
  });

  it("ignores a picked day that is not a real date, never failing the page", async () => {
    for (const extraDay of ["2026-13-40", "yesterday", "2026-10-26T00:00"]) {
      const r = await loadTeamCapacity({ orgId: "org", now, extraDay });
      expect(r.measurable && r.days).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"]);
    }
  });

  it("marks an advisor whose calendar is failing to sync", async () => {
    sync.loadFailingAgents.mockResolvedValue([{ email: "blake@x.com" }]);
    const r = await loadTeamCapacity({ orgId: "org", now });
    expect(r.measurable && r.advisors.find((a) => a.email === "blake@x.com")?.unsynced).toBe(true);
  });

  const failures: [string, () => void, string][] = [
    ["the office hours", () => hours.loadBusinessHours.mockRejectedValueOnce(new Error("no week")), "business-hours"],
    ["the booking window", () => offered.readOfferedOpenDays.mockResolvedValueOnce(null), "booking-window"],
    ["the booking window, by throwing", () => offered.readOfferedOpenDays.mockRejectedValueOnce(new Error("settings refused")), "booking-window"],
    ["a week with no open day", () => hours.loadBusinessHours.mockResolvedValueOnce({ zone: "America/New_York", source: "stored" as const, exceptions: [], rules: [] }), "no-open-days"],
    ["the buckets", () => { db.bucketError = { message: "refused" }; }, "event-type"],
    ["buckets that disagree on the call", () => { db.buckets = [{ code: "100", event_type_id: "e1" }, { code: "200", event_type_id: "e9" }]; }, "event-type"],
    ["the roster", () => { db.userError = { message: "refused" }; }, "roster"],
    ["the calendars", () => service.loadMembersAvailability.mockRejectedValueOnce(new Error("busy read refused")), "calendars"],
    ["the time off", () => ooo.approvedTimeOffIntervals.mockRejectedValueOnce(new Error("ooo read refused")), "time-off"],
    ["the sync health", () => sync.loadFailingAgents.mockResolvedValueOnce(null), "calendar-sync"],
    ["nobody being bookable", () => { db.users = [{ id: "u3", name: "Smoke Test", email: "smoke@x.com", is_test: true }]; }, "no-advisors"],
    ["an availability read missing an advisor", () => service.loadMembersAvailability.mockResolvedValueOnce({ members: [], lowIds: undefined }), "calendars"],
    ["the sync health, by throwing", () => sync.loadFailingAgents.mockRejectedValueOnce(new Error("health refused")), "calendar-sync"],
  ];
  for (const [what, breakIt, reason] of failures) {
    it(`names ${what} when that read fails, never an empty team`, async () => {
      breakIt();
      const r = await loadTeamCapacity({ orgId: "org", now });
      expect(r).toEqual({ measurable: false, reason });
    });
  }
});
