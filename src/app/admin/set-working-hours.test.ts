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
// #1988: the confirmation IS the redirect, so it is a named mock rather than an
// anonymous one.
//
// #1994: AND IT THROWS, the way the real one does. It did not, which was safe
// while a redirect was only ever the last line of an action. It stopped being
// safe the moment a REFUSAL redirected too: with a mock that returns, execution
// carried on into the write, so the suite observed a throw from
// `replaceUserSchedule` that production never reaches, and every refusal test
// passed for a reason that no longer existed.
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }) }));
/** Whatever the last `.update()` wrote, so the org-default cases can read it. */
const updated = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (t: string) => {
      fromTable(t);
      return {
        // #1670 reads the org defaults and the agent's existing zone through this
        // same fake, so `single` and `maybeSingle` both answer, keyed by table.
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data:
                t === "availability_schedules"
                  ? { timezone: "America/New_York" }
                  : { role: "agent" },
              error: null,
            }),
            single: async () => ({
              data: {
                default_timezone: "America/New_York",
                default_start_minute: 480,
                default_end_minute: 1200,
                default_weekdays: [1, 2, 3, 4, 5],
              },
              error: null,
            }),
          }),
        }),
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

import {
  setWorkingHours,
  setOrgDefaultHours,
  useDefaultHours,
  setMyWorkingHours,
} from "./actions";

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
    await expect(setWorkingHours(hoursForm())).rejects.toThrow("NEXT_REDIRECT:/admin/agents/u1?ok=working-hours");
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
    // #1994: the refusal travels as a redirect carrying the reason now, so the
    // sentence is asserted where it actually reaches the person.
    await expect(setWorkingHours(hoursForm({ start: "17:00", end: "09:00" }))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(decodeURIComponent(String(redirect.mock.calls.at(-1)?.[0]))).toMatch(
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
// #1988: whether a save SAYS it saved.
//
// Dan, 2026-09-06: "when I click save hours it appears to work but there's no
// real confirmation. I want to know it worked for sure." The week was written
// and the page came back with the same values it already showed, so a
// successful save and a click that did nothing were the same event.
//
// The confirmation travels as a redirect carrying a NAMED outcome, so what is asserted
// here is that the redirect happens, that it lands on the page the person was
// actually on, and above all that it does NOT happen when nothing was saved. A
// confirmation over a week nobody wrote is worse than the silence it replaced.
describe("saving working hours confirms it saved (#1988)", () => {
  it("sends the person back to the agent they were editing", async () => {
    await expect(setWorkingHours(hoursForm())).rejects.toThrow("NEXT_REDIRECT:/admin/agents/u1?ok=working-hours");
    expect(redirect).toHaveBeenCalledWith("/admin/agents/u1?ok=working-hours");
  });

  // The route is derived from the SUBJECT, not written down once. A hardcoded
  // path passes the assertion above and sends every admin to the same agent.
  it("names the agent from the form rather than a fixed path", async () => {
    const other = hoursForm();
    other.set("user_id", "u9");
    await expect(setWorkingHours(other)).rejects.toThrow(/ok=working-hours/);
    expect(redirect).toHaveBeenCalledWith("/admin/agents/u9?ok=working-hours");
  });

  // The /me form posts from a different page into an action that looks alike.
  // #1769 was already this mistake once, in the revalidate rather than the
  // redirect: the agent's own page went unrefreshed because only /admin was
  // named. Asserted separately so one cannot answer for the other.
  it("sends an agent saving their own hours back to their own page", async () => {
    auth.currentUser.mockResolvedValue({ id: "me1", role: "agent", org_id: "o1" });
    await expect(setMyWorkingHours(hoursForm())).rejects.toThrow(/ok=working-hours/);
    expect(redirect).toHaveBeenCalledWith("/me?ok=working-hours");
  });

  // #2103: the agent's half of this went with `useMyDefaultHours`. The company
  // default is no longer something an agent applies to themselves, so there is
  // no second page for this confirmation to be checked on.
  it("confirms the company default button on the agent's admin page", async () => {
    await expect(useDefaultHours(hoursForm())).rejects.toThrow(/ok=working-hours/);
    expect(redirect).toHaveBeenCalledWith("/admin/agents/u1?ok=working-hours");
  });

  // The half that matters most, and it is the reason the confirmation is placed
  // after the write rather than beside it.
  // #1994: a refusal DOES redirect now, carrying the reason. What it must never
  // do is confirm, so the assertion is about the outcome and not about whether a
  // redirect happened at all.
  it("does not confirm a week that was refused, and says why instead", async () => {
    const noDays = hoursForm();
    for (const d of [1, 2, 3, 4, 5]) noDays.delete(`day_${d}`);
    await expect(setWorkingHours(noDays)).rejects.toThrow(/NEXT_REDIRECT/);
    const to = String(redirect.mock.calls.at(-1)?.[0] ?? "");
    expect(to).not.toContain("ok=");
    expect(to).toContain("error=");
    // The sentence names what is wrong, in words a person can act on, which is
    // the whole point: it was unreachable before, redacted into a blank screen.
    expect(decodeURIComponent(to)).toMatch(/day/i);
    // And nothing was written on the way past.
    expect(rpc).not.toHaveBeenCalled();
  });

  it("says nothing when the write itself failed", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "deadlock detected" } });
    await expect(setWorkingHours(hoursForm())).rejects.toThrow(/could not be saved/i);
    expect(redirect).not.toHaveBeenCalled();
  });

  // The count guard is the only thing that can catch a write that PARTLY landed,
  // and a confirmation shown over a partial write is exactly the false assurance
  // this issue exists to prevent.
  it("says nothing when the database recorded a different number of days", async () => {
    rpc.mockResolvedValue({ data: 3, error: null });
    await expect(setWorkingHours(hoursForm())).rejects.toThrow(/expected 5 days/i);
    expect(redirect).not.toHaveBeenCalled();
  });

  // ORDER, not just presence. The mock does not throw the way the real redirect
  // does, so nothing structural stops a future edit confirming before the write
  // commits. This is what does.
  it("confirms only after the write has committed", async () => {
    await expect(setWorkingHours(hoursForm())).rejects.toThrow("NEXT_REDIRECT:/admin/agents/u1?ok=working-hours");
    expect(rpc).toHaveBeenCalled();
    expect(redirect.mock.invocationCallOrder[0]).toBeGreaterThan(
      rpc.mock.invocationCallOrder[0],
    );
  });
});


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

    await expect(setWorkingHours(fd)).rejects.toThrow(/ok=working-hours/);

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
    await expect(setWorkingHours(fd)).rejects.toThrow(/ok=working-hours/);

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
    await expect(setOrgDefaultHours(orgForm())).rejects.toThrow(/ok=org-default-hours/);
    expect(written()).toMatchObject({ default_start_minute: 480, default_end_minute: 1200 });
  });

  it("falls back to the seeded day, never to midnight, when a time cannot be read", async () => {
    updated.row = null;
    await expect(setOrgDefaultHours(orgForm({ default_start: "not a time" }))).rejects.toThrow(/ok=org-default-hours/);
    // 00:00 is a perfectly valid window, so writing it would be indistinguishable
    // from somebody choosing it, and every new agent would start there (L50).
    expect(written()?.default_start_minute).not.toBe(0);
    expect(written()?.default_start_minute).toBe(480);
  });

  it("falls back for a missing field too, not just a malformed one", async () => {
    updated.row = null;
    await expect(setOrgDefaultHours(orgForm({ default_end: "" }))).rejects.toThrow(/ok=org-default-hours/);
    expect(written()?.default_end_minute).not.toBe(0);
    // The SEEDED day (17:00), which is what a blank field has always meant here:
    // the fallback exists so a blank cannot write 09:00 over the backfilled
    // roster, and it must not be able to write midnight either.
    expect(written()?.default_end_minute).toBe(1020);
  });
});

// #1671: the timezone is a stored value the availability engine COMPARES against,
// not a label. `isWithinWorkingHours` tests `rule.weekday !== day.weekday`, and a
// zone Luxon cannot read makes that weekday NaN, so every comparison is false,
// every rule misses, and the agent is bookable at no time at all. Their hours
// still render correctly afterwards, so nothing tells them and nothing tells
// anyone else. Refused at the write, before anything is deleted.
describe("the timezone on a working-hours save (#1671)", () => {
  it("refuses an unreadable zone and writes nothing", async () => {
    const fd = hoursForm();
    fd.set("timezone", "Eastern");
    await expect(setWorkingHours(fd)).rejects.toThrow(/time ?zone/i);
    expect(rpc).not.toHaveBeenCalled();
    expect(upsertUserSchedule).not.toHaveBeenCalled();
  });

  it("refuses a blank zone and writes nothing", async () => {
    const fd = hoursForm();
    fd.set("timezone", "   ");
    await expect(setWorkingHours(fd)).rejects.toThrow(/time ?zone/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  // The control: a real zone still saves, so the refusals above are about the
  // value and not about the action having stopped working.
  it("CONTROL: a real zone still writes the week", async () => {
    const fd = hoursForm();
    fd.set("timezone", "America/Los_Angeles");
    await expect(setWorkingHours(fd)).rejects.toThrow(/ok=working-hours/);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(upsertUserSchedule).toHaveBeenCalledWith("u1", "America/Los_Angeles");
  });

  it("refuses an unreadable org default zone, so no new agent adopts it", async () => {
    const fd = new FormData();
    fd.set("default_timezone", "Eastern");
    fd.set("default_start", "08:00");
    fd.set("default_end", "20:00");
    for (const d of [1, 2, 3, 4, 5]) fd.set(`dday_${d}`, "on");
    updated.row = null;
    await expect(setOrgDefaultHours(fd)).rejects.toThrow(/time ?zone/i);
    expect(updated.row).toBeNull();
  });
});

// #1670: "Apply company default hours" was the straggler write on this path, a
// bare delete then insert with neither error bound, no transaction and no
// validation. A half failure left the agent with a schedule row holding NO rules,
// which makes isWithinWorkingHours reject every instant, so that agent offers no
// times permanently, while the reloaded page drew the org default week (it renders
// the org fallback for zero rules) and the coverage monitor saw a row and moved on.
describe("useDefaultHours (#1670)", () => {
  const form = () => {
    const fd = new FormData();
    fd.set("user_id", "u1");
    return fd;
  };

  it("goes through the one transactional call, and never deletes rules itself", async () => {
    await expect(useDefaultHours(form())).rejects.toThrow(/ok=working-hours/);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0] as [string, { p_rules: unknown[] }];
    expect(fn).toBe("replace_availability_rules");
    expect(args.p_rules).toHaveLength(5);
    // A direct touch of the rules table is the defect itself.
    expect(fromTable).not.toHaveBeenCalledWith("availability_rules");
  });

  it("refuses to report a save when the database recorded a different number of days", async () => {
    rpc.mockResolvedValue({ data: 2, error: null });
    await expect(useDefaultHours(form())).rejects.toThrow(/could not be saved/i);
  });

  it("surfaces a failed write instead of leaving the agent with an empty week", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "deadlock detected" } });
    await expect(useDefaultHours(form())).rejects.toThrow(/deadlock detected/);
  });
});

// #1764: a weekday can hold SEVERAL windows now, so the form repeats the field
// names (`start_1` twice for a split Monday) and the action pairs them by
// position. What matters here is that the extra windows actually REACH the write,
// and that the two shapes a repeated field can arrive in are told apart: a blank
// row somebody added and left alone is ignored, while a half filled one is a
// mistake and refuses the save.
describe("setWorkingHours, several windows a day (#1764)", () => {
  /** A form with repeated window fields, the way the rebuilt editor submits. */
  function splitForm(windows: Record<number, [string, string][]>): FormData {
    const fd = new FormData();
    fd.set("user_id", "u1");
    fd.set("timezone", "America/New_York");
    for (const [day, list] of Object.entries(windows)) {
      fd.set(`day_${day}`, "on");
      for (const [start, end] of list) {
        fd.append(`start_${day}`, start);
        fd.append(`end_${day}`, end);
      }
    }
    return fd;
  }

  it("writes BOTH windows of a split day", async () => {
    rpc.mockResolvedValue({ data: 3, error: null });
    await expect(
      setWorkingHours(
        splitForm({ 1: [["08:00", "12:00"], ["14:00", "17:00"]], 2: [["09:00", "17:00"]] }),
      ),
    ).rejects.toThrow(/ok=working-hours/);

    const [, args] = rpc.mock.calls[0] as [
      string,
      { p_rules: { weekday: number; start_minute: number; end_minute: number }[] },
    ];
    expect(args.p_rules).toHaveLength(3);
    expect(args.p_rules).toEqual([
      { weekday: 1, start_minute: 480, end_minute: 720 },
      { weekday: 1, start_minute: 840, end_minute: 1020 },
      { weekday: 2, start_minute: 540, end_minute: 1020 },
    ]);
  });

  it("ignores a blank added window rather than refusing the whole week", async () => {
    rpc.mockResolvedValue({ data: 1, error: null });
    // Clicking + and saving without filling it in is an ordinary thing to do.
    await expect(
      setWorkingHours(splitForm({ 1: [["09:00", "17:00"], ["", ""]] })),
    ).rejects.toThrow(/ok=working-hours/);

    const [, args] = rpc.mock.calls[0] as [string, { p_rules: { weekday: number }[] }];
    expect(args.p_rules).toHaveLength(1);
  });

  it("refuses a HALF filled window and names the day, writing nothing", async () => {
    // A start with no end is not a window, and quietly dropping it would save a
    // week missing hours the person had just entered.
    await expect(
      setWorkingHours(splitForm({ 1: [["09:00", "17:00"], ["14:00", ""]] })),
    ).rejects.toThrow(/Monday/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses two windows on one day that overlap, and names the day", async () => {
    await expect(
      setWorkingHours(splitForm({ 5: [["09:00", "17:00"], ["16:00", "18:00"]] })),
    ).rejects.toThrow(/Friday.*overlap/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("still ignores every window on a day that is not ticked", async () => {
    const fd = splitForm({ 1: [["09:00", "17:00"]] });
    // Saturday keeps its times in the form (the dimming does not remove them) and
    // must contribute nothing while it is unticked.
    fd.append("start_6", "09:00");
    fd.append("end_6", "17:00");
    fd.append("start_6", "20:00");
    fd.append("end_6", "08:00");

    rpc.mockResolvedValue({ data: 1, error: null });
    await expect(setWorkingHours(fd)).rejects.toThrow(/ok=working-hours/);

    const [, args] = rpc.mock.calls[0] as [string, { p_rules: { weekday: number }[] }];
    expect(args.p_rules.map((r) => r.weekday)).toEqual([1]);
  });
});

// #1769: both of these are submitted from a form on /admin/agents/[id] (and the
// agent's own /me), and both revalidated only /admin. The saved week therefore did
// not appear on the page that had just been used to change it.
describe("the hours actions refresh the page their form is on (#1769)", () => {
  it("setWorkingHours refreshes the agent page", async () => {
    rpc.mockResolvedValue({ data: 5, error: null });
    await expect(setWorkingHours(hoursForm())).rejects.toThrow("NEXT_REDIRECT:/admin/agents/u1?ok=working-hours");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/agents/u1");
    // The Overview still refreshes too: this adds a route rather than moving one.
    expect(revalidatePath).toHaveBeenCalledWith("/admin");
  });

  it("useDefaultHours refreshes the agent page", async () => {
    rpc.mockResolvedValue({ data: 5, error: null });
    const fd = new FormData();
    fd.set("user_id", "u1");
    await useDefaultHours(fd).catch(() => {});
    expect(revalidatePath).toHaveBeenCalledWith("/admin/agents/u1");
  });
});
