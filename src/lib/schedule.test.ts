import { describe, it, expect, vi, beforeEach } from "vitest";

// #1670: `ensureDefaultSchedules` is the self-heal behind the #838 coverage
// monitor, and it keyed on a schedule ROW existing. A row that holds NO rules is
// not working hours: `isWithinWorkingHours` rejects every instant against an empty
// rule set, so that agent offers no times, permanently. The fill walked straight
// past them, which is why "Apply company default hours" half failing could leave
// an agent dark with nothing anywhere saying so.

type Result = { data: unknown; error: { message: string } | null };

const tables = vi.hoisted(() => ({ results: {} as Record<string, Result> }));
const inserted = vi.hoisted(() => ({ rows: [] as unknown[] }));
const rpc = vi.hoisted(() =>
  vi.fn(async (_fn: string, args: { p_rules: unknown[] }): Promise<Result> => ({
    data: args.p_rules.length,
    error: null,
  })),
);
const upserted = vi.hoisted(() => ({ rows: [] as { user_id: string }[] }));

const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    const res = async (): Promise<Result> => tables.results[table] ?? { data: [], error: null };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      // `range` resolves the whole (small) fixture in one page, which is what
      // selectAllPages sees when a first page comes back short.
      range: res,
      single: res,
      maybeSingle: res,
      then: (resolve: (v: Result) => unknown) => res().then(resolve),
      insert: async (rows: unknown[]) => {
        inserted.rows.push(...rows);
        return { error: null };
      },
      upsert: (rows: { user_id: string }[]) => {
        upserted.rows.push(...rows);
        return {
          select: async () => ({
            data: rows.map((r) => ({ id: `new-${r.user_id}` })),
            error: null,
          }),
        };
      },
    };
    return b;
  }),
);

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => ({ from, rpc }) }));

import { ensureDefaultSchedules } from "@/lib/schedule";

const ORG = {
  default_timezone: "America/New_York",
  default_start_minute: 480,
  default_end_minute: 1200,
  default_weekdays: [1, 2, 3, 4, 5],
};

beforeEach(() => {
  vi.clearAllMocks();
  inserted.rows = [];
  upserted.rows = [];
  rpc.mockImplementation(async (_fn: string, args: { p_rules: unknown[] }) => ({
    data: args.p_rules.length,
    error: null,
  }));
  tables.results = {
    organizations: { data: ORG, error: null },
    users: { data: [{ id: "u1" }], error: null },
    availability_schedules: { data: [], error: null },
    availability_rules: { data: [], error: null },
  };
});

describe("ensureDefaultSchedules (#1670)", () => {
  it("fills a schedule row that exists but holds no rules", async () => {
    tables.results.availability_schedules = { data: [{ id: "s1", user_id: "u1" }], error: null };
    tables.results.availability_rules = { data: [], error: null };

    expect(await ensureDefaultSchedules("org1")).toBe(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0] as [string, { p_schedule_id: string; p_rules: unknown[] }];
    expect(fn).toBe("replace_availability_rules");
    expect(args.p_schedule_id).toBe("s1");
    expect(args.p_rules).toHaveLength(5);
    // No second row for somebody who already has one (the user_id unique index).
    expect(upserted.rows).toEqual([]);
  });

  // The control: an agent whose schedule already holds rules is left alone, so
  // hours personalized on /me survive and the fill above is a repair rather than
  // an overwrite.
  it("CONTROL: leaves an agent whose schedule already holds rules untouched", async () => {
    tables.results.availability_schedules = { data: [{ id: "s1", user_id: "u1" }], error: null };
    tables.results.availability_rules = { data: [{ schedule_id: "s1" }], error: null };

    expect(await ensureDefaultSchedules("org1")).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(upserted.rows).toEqual([]);
  });

  it("still creates the row and its rules for an agent with no schedule at all", async () => {
    tables.results.availability_schedules = { data: [], error: null };

    expect(await ensureDefaultSchedules("org1")).toBe(1);
    expect(upserted.rows.map((r) => r.user_id)).toEqual(["u1"]);
    expect(inserted.rows).toHaveLength(5);
  });

  // The refill goes through the same atomic call the hours editors use, so it
  // must obey the same rule: never claim success on a count it did not get.
  it("throws rather than reporting a fill the database did not confirm", async () => {
    tables.results.availability_schedules = { data: [{ id: "s1", user_id: "u1" }], error: null };
    rpc.mockResolvedValue({ data: 2, error: null });

    await expect(ensureDefaultSchedules("org1")).rejects.toThrow(/2 of 5 days/);
  });

  it("throws when the refill itself errors, rather than leaving the week empty", async () => {
    tables.results.availability_schedules = { data: [{ id: "s1", user_id: "u1" }], error: null };
    rpc.mockResolvedValue({ data: null, error: { message: "deadlock detected" } });

    await expect(ensureDefaultSchedules("org1")).rejects.toThrow(/deadlock detected/);
  });

  it("says so when the org defaults cannot produce a week at all", async () => {
    tables.results.organizations = {
      data: { ...ORG, default_start_minute: 1200, default_end_minute: 480 },
      error: null,
    };
    tables.results.availability_schedules = { data: [{ id: "s1", user_id: "u1" }], error: null };

    await expect(ensureDefaultSchedules("org1")).rejects.toThrow(/produce no week/);
    expect(rpc).not.toHaveBeenCalled();
  });
});
