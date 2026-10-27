import { describe, it, expect, vi, beforeEach } from "vitest";

// #1757: the loader's own failure paths, driven through a fake Supabase client.
// The page test mocks the loader away, so without this nothing proves that a
// failed read becomes an unreadable state rather than a team of empty weeks, or
// that a manager's query is narrowed to their own reports on the server.
const admin = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => admin);
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { loadTeamHours } from "./team-hours-load";
import { idFilterBytes, MAX_IN_FILTER_BYTES } from "@/lib/db/id-batch";

type Result = { data: unknown; error: { message: string } | null };
/** `after` is the keyset filter a paged read cuts each later page with (2026-10-25). */
type Call = { table: string; filters: [string, unknown][]; range?: [number, number]; after?: unknown };

const ORG = {
  default_timezone: "America/New_York",
  default_start_minute: 480,
  default_end_minute: 1020,
  default_weekdays: [1, 2, 3, 4, 5],
};

const USERS = [
  { id: "a1", name: "Ann", email: "a@x.com", role: "agent", manager_id: "me", bookable: true, deactivated_at: null },
  { id: "a2", name: "Bea", email: "b@x.com", role: "agent", manager_id: "me", bookable: true, deactivated_at: null },
];
const SCHEDULES = [
  { id: "s1", user_id: "a1", timezone: "America/Chicago", hours_source: "agent", hours_set_at: null, created_at: "2026-08-01T00:00:00Z" },
];

let calls: Call[];

type Answer = Result | ((range?: [number, number], after?: unknown) => Result);

function mockDb(over: Partial<Record<string, Answer>> = {}) {
  calls = [];
  const byTable: Record<string, Answer> = {
    organizations: { data: ORG, error: null },
    users: { data: USERS, error: null },
    availability_schedules: { data: SCHEDULES, error: null },
    availability_rules: { data: [{ id: "r1", schedule_id: "s1", weekday: 1, start_minute: 540, end_minute: 1020 }], error: null },
    ...over,
  };
  admin.supabaseAdmin.mockReturnValue({
    from: (table: string) => {
      const call: Call = { table, filters: [] };
      calls.push(call);
      const resolve = () => {
        const r = byTable[table]!;
        return typeof r === "function" ? r(call.range, call.after) : r;
      };
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.order = () => b;
      b.gt = (_col: string, v: unknown) => {
        call.after = v;
        return b;
      };
      for (const m of ["eq", "neq", "in", "is"]) {
        b[m] = (col: string, v: unknown) => {
          call.filters.push([`${m}:${col}`, v]);
          return b;
        };
      }
      b.range = (from: number, to: number) => {
        call.range = [from, to];
        return b;
      };
      b.single = () => Promise.resolve(resolve());
      b.then = (ok: (r: Result) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(ok, bad);
      return b;
    },
  });
}

const VIEWER = { id: "me", org_id: "o1", name: "Mia", email: "me@x.com" };
const fails = (message: string): Result => ({ data: null, error: { message } });

beforeEach(() => vi.clearAllMocks());

describe("loadTeamHours", () => {
  it("narrows a manager's roster read to their own reports, on the server", async () => {
    mockDb();
    const r = await loadTeamHours(VIEWER, { kind: "team", managerId: "me" });
    expect(r.kind).toBe("ok");
    const usersCall = calls.find((c) => c.table === "users")!;
    expect(usersCall.filters).toContainEqual(["eq:manager_id", "me"]);
    const sched = calls.find((c) => c.table === "availability_schedules")!;
    expect(sched.filters).toContainEqual(["in:user_id", ["a1", "a2"]]);
    if (r.kind === "ok") {
      const rows = r.groups[0]!.rows;
      // Bea has no schedule, and reads as none; Ann's stored Monday arrived.
      expect(rows.map((x) => [x.id, x.hours.kind])).toEqual([
        ["a2", "none"],
        ["a1", "set"],
      ]);
    }
  });

  it("reads everybody for an admin, with no manager filter", async () => {
    mockDb();
    await loadTeamHours(VIEWER, { kind: "all" });
    const usersCall = calls.find((c) => c.table === "users")!;
    expect(usersCall.filters.some(([k]) => k === "eq:manager_id")).toBe(false);
    // ...but the hours reads are still narrowed to the roster it read, so they never
    // pull the schedules of test agents or of anyone outside the org.
    const sched = calls.find((c) => c.table === "availability_schedules")!;
    expect(sched.filters).toContainEqual(["in:user_id", ["a1", "a2"]]);
    const rules = calls.find((c) => c.table === "availability_rules")!;
    expect(rules.filters).toContainEqual(["in:schedule_id", ["s1"]]);
  });

  it("splits a roster past the URL budget into several narrowed reads, losing nobody", async () => {
    // 300 agents is past the design target of 200 and past the ~266 uuids one
    // `in` filter can carry, so the read must be split rather than refused.
    const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const many = Array.from({ length: 300 }, (_, i) => ({ ...USERS[0]!, id: uuid(i), name: `A${i}` }));
    mockDb({ users: { data: many, error: null }, availability_schedules: { data: [], error: null } });
    const r = await loadTeamHours(VIEWER, { kind: "all" });
    expect(r.kind).toBe("ok");
    const schedCalls = calls.filter((c) => c.table === "availability_schedules");
    expect(schedCalls.length).toBeGreaterThan(1);
    const sent = schedCalls.flatMap((c) => c.filters.filter(([k]) => k === "in:user_id").flatMap(([, v]) => v as string[]));
    expect(new Set(sent).size).toBe(300);
    for (const c of schedCalls) {
      const ids = c.filters.find(([k]) => k === "in:user_id")![1] as string[];
      // Judged in bytes, the unit the transport refuses in, never a row count.
      expect(idFilterBytes(ids)).toBeLessThanOrEqual(MAX_IN_FILTER_BYTES);
    }
  });

  it("reports an unreadable roster as the roster, not as an empty team", async () => {
    mockDb({ users: fails("users read exploded") });
    expect(await loadTeamHours(VIEWER, { kind: "team", managerId: "me" })).toEqual({
      kind: "unreadable",
      what: "roster",
    });
  });

  it("reports unreadable schedules as the hours, never as agents with no hours", async () => {
    mockDb({ availability_schedules: fails("schedules read exploded") });
    expect(await loadTeamHours(VIEWER, { kind: "all" })).toEqual({ kind: "unreadable", what: "hours" });
  });

  it("reports an unreadable rules read, including one that fails on a later page", async () => {
    mockDb({
      availability_rules: (range, after) =>
        range && range[0] === 0 && after === undefined
          ? {
              data: Array.from({ length: 1000 }, (_, i) => ({
                id: `r${String(i).padStart(4, "0")}`,
                schedule_id: "s1",
                weekday: (i % 7) + 1,
                start_minute: 540,
                end_minute: 600,
              })),
              error: null,
            }
          : fails("page two exploded"),
    });
    expect(await loadTeamHours(VIEWER, { kind: "all" })).toEqual({ kind: "unreadable", what: "hours" });
    // It really did page past the first thousand rather than stopping short.
    expect(calls.filter((c) => c.table === "availability_rules").length).toBe(2);
  });
});
