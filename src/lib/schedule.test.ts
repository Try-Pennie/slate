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
  vi.fn(
    async (
      _fn: string,
      args: { p_schedule_id: string; p_rules: unknown[] },
    ): Promise<Result> => ({ data: args.p_rules.length, error: null }),
  ),
);
const upserted = vi.hoisted(() => ({ rows: [] as { user_id: string }[] }));

const from = vi.hoisted(() =>
  vi.fn((table: string) => {
    // Filters are applied to a fixture's rows as PostgREST would, on the columns a
    // row carries, so a read's own exclusions are part of what the test sees (#4201).
    const filters: [string, unknown][] = [];
    const res = async (): Promise<Result> => {
      const r = tables.results[table] ?? { data: [], error: null };
      if (!Array.isArray(r.data)) return r;
      const rows = r.data as Record<string, unknown>[];
      return { ...r, data: rows.filter((row) => filters.every(([c, v]) => !(c in row) || row[c] === v)) };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return b;
      },
      // selectAllPages orders the query by its key, then `range` resolves the whole
      // (small) fixture in one page, which is what it sees when a first page comes
      // back short.
      order: () => b,
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
  rpc.mockImplementation(async (_fn: string, args: { p_schedule_id: string; p_rules: unknown[] }) => ({
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
    tables.results.availability_rules = { data: [{ id: "r1", schedule_id: "s1" }], error: null };

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

    await expect(ensureDefaultSchedules("org1")).rejects.toThrow(/wrote 2 of 5 days/);
  });

  it("throws when the refill itself errors, rather than leaving the week empty", async () => {
    tables.results.availability_schedules = { data: [{ id: "s1", user_id: "u1" }], error: null };
    rpc.mockResolvedValue({ data: null, error: { message: "deadlock detected" } });

    await expect(ensureDefaultSchedules("org1")).rejects.toThrow(/deadlock detected/);
  });

  // L71: one agent's refill failing must not abort the others, or the repair for
  // everyone after them silently never happens while the caller sees one error.
  it("keeps repairing the other agents when one refill fails, then raises them together", async () => {
    tables.results.users = { data: [{ id: "u1" }, { id: "u2" }, { id: "u3" }], error: null };
    tables.results.availability_schedules = {
      data: [
        { id: "s1", user_id: "u1" },
        { id: "s2", user_id: "u2" },
      ],
      error: null,
    };
    rpc.mockImplementation(async (_fn: string, args: { p_schedule_id: string; p_rules: unknown[] }) =>
      args.p_schedule_id === "s1"
        ? { data: null, error: { message: "deadlock detected" } }
        : { data: args.p_rules.length, error: null },
    );

    await expect(ensureDefaultSchedules("org1")).rejects.toThrow(/deadlock detected/);
    // s2's refill still ran, and u3 (who has no row at all) still got one.
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(upserted.rows.map((r) => r.user_id)).toEqual(["u3"]);
    expect(inserted.rows).toHaveLength(5);
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

// #2542: a failed READ must not arrive as an answer.
//
// These three reads sat outside the swallowed-read guard's hand written
// directory list, so nothing had ever asked what they do on a refusal. Two of
// them are dangerous in opposite directions and neither is visible from the call
// site: an unreadable `organizations` row made this return 0, which the caller
// reads as "every agent already has hours", and an unreadable
// `availability_schedules` made EVERY agent look uncovered, so this fill would
// replace a week somebody personalised on /me with the org default.
describe("ensureDefaultSchedules on an unreadable read (#2542)", () => {
  it("throws rather than reporting nothing to fill when the org row cannot be read", async () => {
    tables.results.organizations = { data: null, error: { message: "column does not exist" } };
    tables.results.availability_schedules = { data: [{ id: "s1", user_id: "u1" }], error: null };

    await expect(ensureDefaultSchedules("org1")).rejects.toThrow(/column does not exist/);
    expect(rpc).not.toHaveBeenCalled();
    expect(upserted.rows).toEqual([]);
  });

  it("throws rather than treating an unreadable schedules table as nobody having hours", async () => {
    tables.results.availability_schedules = { data: null, error: { message: "permission denied" } };

    await expect(ensureDefaultSchedules("org1")).rejects.toThrow(/permission denied/);
    // Nothing was written, so a week somebody personalised is still theirs.
    expect(rpc).not.toHaveBeenCalled();
    expect(upserted.rows).toEqual([]);
    expect(inserted.rows).toEqual([]);
  });

  it("throws rather than filling for a roster it could not read", async () => {
    tables.results.users = { data: null, error: { message: "statement timeout" } };

    await expect(ensureDefaultSchedules("org1")).rejects.toThrow(/statement timeout/);
    expect(upserted.rows).toEqual([]);
  });

  // The CONTROL, so the three above cannot pass by this function throwing on
  // everything: the same fixture with every read healthy still fills, and the
  // "not found" case (a null row with NO error) still returns 0 rather than
  // throwing, which is the distinction `unwrap` exists to keep.
  it("CONTROL: a healthy read still fills, and a genuinely absent org still returns 0", async () => {
    tables.results.availability_schedules = { data: [{ id: "s1", user_id: "u1" }], error: null };
    expect(await ensureDefaultSchedules("org1")).toBe(1);

    vi.clearAllMocks();
    tables.results.organizations = { data: null, error: null };
    expect(await ensureDefaultSchedules("org1")).toBe(0);
  });
});

// #4201: the placeholder advisor holds stacked calls at whatever time a coordinator
// placed them and is never bookable, so it has no working hours to fill. The smoke
// test advisors still do: they need hours to be booked at all.
describe("ensureDefaultSchedules leaves the placeholder advisor without hours (#4201)", () => {
  it("fills the agents and the test advisor, never the placeholder", async () => {
    tables.results.users = {
      data: [
        { id: "u1", is_test: false, is_placeholder: false },
        { id: "smoke", is_test: true, is_placeholder: false },
        { id: "marcia", is_test: false, is_placeholder: true },
      ],
      error: null,
    };

    expect(await ensureDefaultSchedules("org1")).toBe(2);
    expect(upserted.rows.map((r) => r.user_id).sort()).toEqual(["smoke", "u1"]);
  });
});
