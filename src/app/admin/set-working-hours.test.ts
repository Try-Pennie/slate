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
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (t: string) => {
      fromTable(t);
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "agent" } }) }) }),
        delete: () => ({ eq: async () => ({}) }),
        insert: async () => ({ error: null }),
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

import { setWorkingHours } from "./actions";

function hoursForm(over: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("user_id", "u1");
  fd.set("timezone", "America/New_York");
  fd.set("start", "08:00");
  fd.set("end", "17:00");
  for (const d of [1, 2, 3, 4, 5]) fd.set(`day_${d}`, "on");
  for (const [k, v] of Object.entries(over)) {
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
      /later than your start/i,
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
