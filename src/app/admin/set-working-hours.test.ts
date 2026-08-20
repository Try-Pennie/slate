import { describe, it, expect, vi, beforeEach } from "vitest";

// #1293: the setWorkingHours admin action. What is pinned here is the behaviour
// that decides whether an agent can silently vanish from availability.
//
// The write replaces every rule for a schedule, so the dangerous cases are the ones
// where it writes NOTHING or writes half: an input that cannot make a real week must
// be refused BEFORE anything is deleted, and a write whose result cannot be
// confirmed must fail loudly rather than reporting a save that did not happen. The
// atomicity itself lives in Postgres (migration 0097); what this proves is that the
// action goes through it and refuses to claim success on its own.
const auth = vi.hoisted(() => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  requireManager: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  currentUser: vi.fn(async () => ({ id: "admin1", role: "admin", org_id: "o1" })),
  realCurrentUser: vi.fn(),
}));
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
const revalidatePath = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() =>
  vi.fn(async (_fn: string, _args: unknown): Promise<{ data: unknown; error: { message: string } | null }> => ({
    data: 5,
    error: null,
  })),
);
// The rules table must never be touched directly by the action any more: a bare
// delete here is the defect. Any call is recorded so a test can assert its absence.
const fromTable = vi.hoisted(() => vi.fn());
const upsertUserSchedule = vi.hoisted(() => vi.fn(async () => "sched1"));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
/** Whatever the last `.update()` wrote, so the org-default cases can read it. */
const updated = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (t: string) => {
      fromTable(t);
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "agent" } }) }) }),
        delete: () => ({ eq: async () => ({}) }),
        insert: async () => ({ error: null }),
        update: (row: Record<string, unknown>) => {
          updated.row = row;
          return { eq: async () => ({ error: null }) };
        },
      };
    },
    rpc,
  }),
}));
vi.mock("@/lib/schedule", () => ({ upsertUserSchedule, ensureDefaultSchedules: vi.fn() }));
vi.mock("@/lib/audit", () => ({ recordAudit }));
vi.mock("@/lib/availability/precompute", () => ({ markAllBucketSlotsStale: vi.fn() }));
vi.mock("@/lib/webhooks/emit", () => ({ resendDelivery: vi.fn(), replayDeadLetteredDeliveries: vi.fn() }));
vi.mock("@/lib/locks", () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));
vi.mock("@/lib/offboarding/service", () => ({ applyLifecycleByUserId: vi.fn(), applyLifecycleByEmail: vi.fn() }));
vi.mock("@/lib/bookable/service", () => ({ applyBookableByUserId: vi.fn(), applyBookableByEmail: vi.fn(), writeBookable: vi.fn() }));
vi.mock("@/lib/salesforce/sync", () => ({ syncSalesforceAgents: vi.fn(), AGENTS_SYNC_STREAK_KEY: "k" }));
vi.mock("@/lib/notify/streak", () => ({ clearFailureStreak: vi.fn(), recordFailureStreak: vi.fn(), recordConsecutiveStreak: vi.fn() }));

import { setWorkingHours, setOrgDefaultHours } from "./actions";

/**
 * The form as the per-day hours editor submits it (#1308): a checkbox and its own
 * pair of times per weekday. `over` still takes the bare "start"/"end" keys, which
 * set every ticked day, so the cases below stay about the action rather than about
 * seven rows of fixture.
 */
function hoursForm(over: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("user_id", "u1");
  fd.set("timezone", "America/New_York");
  const start = over.start ?? "08:00";
  const end = over.end ?? "17:00";
  for (const d of [1, 2, 3, 4, 5]) {
    fd.set(`day_${d}`, "on");
    fd.set(`start_${d}`, start);
    fd.set(`end_${d}`, end);
  }
  for (const [k, v] of Object.entries(over)) {
    if (k === "start" || k === "end") continue;
    if (v === "") fd.delete(k);
    else fd.set(k, v);
  }
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: 5, error: null });
});

describe("setWorkingHours", () => {
  it("writes the whole week through the one transactional call", async () => {
    await setWorkingHours(hoursForm());
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0] as [string, { p_schedule_id: string; p_rules: unknown[] }];
    expect(fn).toBe("replace_availability_rules");
    expect(args.p_schedule_id).toBe("sched1");
    expect(args.p_rules).toEqual([1, 2, 3, 4, 5].map((weekday) => ({
      weekday,
      start_minute: 480,
      end_minute: 1020,
    })));
    // Never a direct delete on the rules table: that is the two-statement shape
    // whose crash window left an agent with no hours at all.
    expect(fromTable.mock.calls.map(([t]) => t)).not.toContain("availability_rules");
  });

  it("refuses a week with no days, and writes nothing at all", async () => {
    const noDays = hoursForm();
    for (const d of [1, 2, 3, 4, 5]) noDays.delete(`day_${d}`);
    await expect(setWorkingHours(noDays)).rejects.toThrow(/day/i);
    // The refusal has to come BEFORE the write, or the schedule is already cleared
    // and the agent is unbookable whatever the message says.
    expect(rpc).not.toHaveBeenCalled();
    expect(upsertUserSchedule).not.toHaveBeenCalled();
  });

  it("refuses an end time that is not after the start, and writes nothing", async () => {
    await expect(setWorkingHours(hoursForm({ start: "17:00", end: "09:00" }))).rejects.toThrow(
      /later than its start/i,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("surfaces a failed write instead of reporting a save", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "deadlock detected" } });
    await expect(setWorkingHours(hoursForm())).rejects.toThrow(/could not be saved/i);
  });

  it("refuses to claim success when the database recorded a different number of days", async () => {
    // The count is the only thing that can catch a write that partly landed, and
    // "no error" is not the same as "wrote the five days asked for".
    rpc.mockResolvedValue({ data: 3, error: null });
    await expect(setWorkingHours(hoursForm())).rejects.toThrow(/expected 5 days/i);
  });

  it("refuses to claim success when the count comes back unreadable", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(setWorkingHours(hoursForm())).rejects.toThrow(/unreadable count/i);
  });
});

// #1308: the per-day half, which is the reason the form changed shape at all.
describe("setWorkingHours, a window per day", () => {
  it("writes each day's OWN window rather than the first day's applied to all", async () => {
    const fd = new FormData();
    fd.set("user_id", "u1");
    fd.set("timezone", "America/New_York");
    for (const d of [1, 2, 3, 4]) {
      fd.set(`day_${d}`, "on");
      fd.set(`start_${d}`, "09:00");
      fd.set(`end_${d}`, "17:00");
    }
    // The case an agent could not express before: an early finish on Friday.
    fd.set("day_5", "on");
    fd.set("start_5", "08:00");
    fd.set("end_5", "16:00");

    await setWorkingHours(fd);

    const [, args] = rpc.mock.calls[0] as [string, { p_rules: { weekday: number; start_minute: number; end_minute: number }[] }];
    expect(args.p_rules).toHaveLength(5);
    expect(args.p_rules.find((r) => r.weekday === 5)).toEqual({
      weekday: 5,
      start_minute: 480,
      end_minute: 960,
    });
    expect(args.p_rules.find((r) => r.weekday === 1)).toEqual({
      weekday: 1,
      start_minute: 540,
      end_minute: 1020,
    });
  });

  it("ignores the times on a day that is not ticked", async () => {
    const fd = new FormData();
    fd.set("user_id", "u1");
    fd.set("timezone", "America/New_York");
    fd.set("day_1", "on");
    fd.set("start_1", "09:00");
    fd.set("end_1", "17:00");
    // Saturday is left unticked with a window that would be refused if it were read.
    fd.set("start_6", "20:00");
    fd.set("end_6", "08:00");

    rpc.mockResolvedValue({ data: 1, error: null });
    await setWorkingHours(fd);

    const [, args] = rpc.mock.calls[0] as [string, { p_rules: { weekday: number }[] }];
    expect(args.p_rules.map((r) => r.weekday)).toEqual([1]);
  });

  it("names the day when one row cannot be read, and writes nothing", async () => {
    const fd = new FormData();
    fd.set("user_id", "u1");
    fd.set("timezone", "America/New_York");
    for (const d of [1, 5]) fd.set(`day_${d}`, "on");
    fd.set("start_1", "09:00");
    fd.set("end_1", "17:00");
    fd.set("start_5", "not a time");
    fd.set("end_5", "16:00");

    // The refusal has to name Friday: a seven row form answering "those times could
    // not be read" tells the person nothing about which row to look at.
    await expect(setWorkingHours(fd)).rejects.toThrow(/Friday/);
    // And it has to come BEFORE the write, or Monday is saved and the week the
    // person actually asked for is gone.
    expect(rpc).not.toHaveBeenCalled();
  });
});

// The org default hours share the same time parser (#1308). An unreadable field
// here is worse than on an agent's own screen: it writes the window every NEW
// agent starts on, and the "apply company hours" button puts an existing agent
// back onto it, so midnight would spread rather than sit on one person.
describe("setOrgDefaultHours", () => {
  const orgForm = (over: Record<string, string> = {}): FormData => {
    const fd = new FormData();
    fd.set("default_timezone", "America/New_York");
    fd.set("default_start", "08:00");
    fd.set("default_end", "20:00");
    for (const d of [1, 2, 3, 4, 5]) fd.set(`dday_${d}`, "on");
    for (const [k, v] of Object.entries(over)) {
      if (v === "") fd.delete(k);
      else fd.set(k, v);
    }
    return fd;
  };

  /** What the action wrote. A getter rather than a direct read, because assigning
   *  `updated.row = null` above narrows the property to null for the rest of the
   *  block and every later read then types as `never`. */
  const written = () => updated.row as Record<string, unknown> | null;

  it("writes the times as entered", async () => {
    updated.row = null;
    await setOrgDefaultHours(orgForm());
    expect(written()).toMatchObject({ default_start_minute: 480, default_end_minute: 1200 });
  });

  it("falls back to the seeded day, never to midnight, when a time cannot be read", async () => {
    updated.row = null;
    await setOrgDefaultHours(orgForm({ default_start: "not a time" }));
    // 00:00 is a perfectly valid window, so writing it would be indistinguishable
    // from somebody choosing it, and every new agent would start there (L50).
    expect(written()?.default_start_minute).not.toBe(0);
    expect(written()?.default_start_minute).toBe(480);
  });

  it("falls back for a missing field too, not just a malformed one", async () => {
    updated.row = null;
    await setOrgDefaultHours(orgForm({ default_end: "" }));
    expect(written()?.default_end_minute).not.toBe(0);
    // The SEEDED day (17:00), which is what a blank field has always meant here:
    // the fallback exists so a blank cannot write 09:00 over the backfilled
    // roster, and it must not be able to write midnight either.
    expect(written()?.default_end_minute).toBe(1020);
  });
});
