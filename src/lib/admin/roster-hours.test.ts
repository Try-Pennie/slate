import { describe, it, expect } from "vitest";
import { rosterHoursByUser } from "@/lib/admin/roster-hours";
import type { OrgDefaults } from "@/lib/schedule-core";
import { groupRulesBySchedule, type UnsetHoursSchedule } from "@/lib/monitor/unset-hours";

// #1802: the roster pairs "never signed in" with whether the agent's working
// hours are still the seeded default. Slate records that fact (`hours_source`,
// migration 0117, #1753), so the roster reads it through the SAME predicate the
// unset hours alert and the activation import use rather than a lookalike.

const ORG: OrgDefaults = {
  default_timezone: "America/New_York",
  default_start_minute: 480,
  default_end_minute: 1020,
  default_weekdays: [1, 2, 3, 4, 5],
} as OrgDefaults;

const seedRules = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1020 }));

const sched = (user_id: string, over: Partial<UnsetHoursSchedule> = {}): UnsetHoursSchedule => ({
  user_id,
  timezone: "America/New_York",
  hours_source: null,
  hours_set_at: null,
  created_at: "2026-09-01T00:00:00Z",
  rules: seedRules,
  ...over,
});

describe("groupRulesBySchedule", () => {
  it("keeps every rule under its own schedule, in order, and invents no schedule", () => {
    const g = groupRulesBySchedule([
      { schedule_id: "a", weekday: 1 },
      { schedule_id: "b", weekday: 2 },
      { schedule_id: "a", weekday: 3 },
    ]);
    expect(g.get("a")!.map((r) => r.weekday)).toEqual([1, 3]);
    expect(g.get("b")!.map((r) => r.weekday)).toEqual([2]);
    expect(g.size).toBe(2);
    expect(groupRulesBySchedule([]).size).toBe(0);
  });
});

describe("rosterHoursByUser", () => {
  it("reads the writer's stamp when there is one", () => {
    const m = rosterHoursByUser(
      [sched("seed", { hours_source: "seed" }), sched("agent", { hours_source: "agent" }), sched("admin", { hours_source: "admin" })],
      ORG,
    );
    expect(m.get("seed")).toBe("seeded");
    // Equal to the seed's shape, and still set: somebody chose it.
    expect(m.get("agent")).toBe("set");
    expect(m.get("admin")).toBe("set");
  });

  it("falls back to the seed's shape only for a row written before the stamp", () => {
    const m = rosterHoursByUser(
      [sched("old-seed"), sched("old-set", { rules: [{ weekday: 1, start_minute: 540, end_minute: 1020 }] })],
      ORG,
    );
    expect(m.get("old-seed")).toBe("seeded");
    expect(m.get("old-set")).toBe("set");
  });

  it("says none for a schedule with no days, and leaves somebody with no schedule to the caller", () => {
    const m = rosterHoursByUser([sched("empty", { rules: [], hours_source: "seed" })], ORG);
    expect(m.get("empty")).toBe("none");
    expect(m.has("nobody")).toBe(false);
  });
});
