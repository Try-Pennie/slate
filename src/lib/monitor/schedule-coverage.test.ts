import { describe, it, expect, vi, beforeEach } from "vitest";

const logError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({ log: { error: logError, warn: vi.fn(), info: vi.fn() } }));

import {
  AGENTS_WITHOUT_SCHEDULE_KEY,
  formatScheduleGapNotice,
  missingScheduleAgents,
  runScheduleCoverageCheck,
  usableScheduleUserIds,
  type ScheduleLessAgent,
} from "@/lib/monitor/schedule-coverage";

type HealFn = (orgIds: string[]) => Promise<void>;
type NotifyFn = (key: string, cooldownMs: number, text: string) => Promise<void>;
type LoadFn = () => Promise<ScheduleLessAgent[]>;

const agent = (id: string, over: Partial<ScheduleLessAgent> = {}): ScheduleLessAgent => ({
  id,
  name: `Agent ${id}`,
  email: `${id}@ex.com`,
  org_id: "org-1",
  ...over,
});

describe("missingScheduleAgents (#1158)", () => {
  it("returns only the agents with no schedule row", () => {
    const out = missingScheduleAgents([agent("a"), agent("b")], new Set(["a"]));
    expect(out.map((x) => x.id)).toEqual(["b"]);
  });

  it("returns empty when every agent has a row", () => {
    expect(missingScheduleAgents([agent("a")], new Set(["a", "z"]))).toEqual([]);
  });

  it("an empty schedule set flags every agent", () => {
    expect(missingScheduleAgents([agent("a"), agent("b")], new Set()).length).toBe(2);
  });
});

// #1670: the check keyed on a schedule ROW existing, and a row with NO rules is
// not a schedule an agent can be booked in. `isWithinWorkingHours` rejects every
// instant against an empty rule set, so that agent offers no times, permanently,
// and the monitor written to catch exactly that saw a row and moved on.
describe("usableScheduleUserIds (#1670)", () => {
  const sched = (id: string, user_id: string) => ({ id, user_id });

  it("counts an agent whose schedule holds at least one rule", () => {
    const out = usableScheduleUserIds([sched("s1", "a")], new Set(["s1"]));
    expect([...out]).toEqual(["a"]);
  });

  it("does NOT count an agent whose schedule holds no rules", () => {
    expect([...usableScheduleUserIds([sched("s1", "a")], new Set())]).toEqual([]);
  });

  it("counts only the agents whose own schedule has rules", () => {
    const out = usableScheduleUserIds(
      [sched("s1", "a"), sched("s2", "b"), sched("s3", "c")],
      new Set(["s1", "s3"]),
    );
    expect([...out].sort()).toEqual(["a", "c"]);
  });

  // Which is the whole point: fed through the existing set difference, an agent
  // with an empty schedule is reported exactly like one with no schedule at all.
  it("makes an empty-rule agent visible to missingScheduleAgents", () => {
    const usable = usableScheduleUserIds([sched("s1", "a")], new Set());
    expect(missingScheduleAgents([agent("a")], usable).map((x) => x.id)).toEqual(["a"]);
  });
});

describe("formatScheduleGapNotice", () => {
  it("returns empty string when nobody is schedule-less", () => {
    expect(formatScheduleGapNotice([])).toBe("");
  });

  it("names the agents and flags that auto-fix could not create them", () => {
    const text = formatScheduleGapNotice([agent("a"), agent("b")]);
    expect(text).toMatch(/2/);
    expect(text).toMatch(/Agent a/);
    expect(text).toMatch(/Agent b/);
    // Worded as a malfunction (auto-heal failed), not a benign nudge.
    expect(text.toLowerCase()).toMatch(/could not|couldn't|auto/);
  });

  it("caps the list and appends an (and N more) tail", () => {
    const many = Array.from({ length: 10 }, (_, i) => agent(`u${i}`));
    const text = formatScheduleGapNotice(many);
    expect(text).toMatch(/and 2 more/);
  });
});

describe("runScheduleCoverageCheck", () => {
  it("does nothing (no heal, no alert) when every bookable agent has a schedule", async () => {
    const heal = vi.fn<HealFn>(async () => {});
    const notify = vi.fn<NotifyFn>(async () => {});
    const loadMissingAgents = vi.fn<LoadFn>(async () => []);

    const out = await runScheduleCoverageCheck({
      loadMissingAgents,
      heal,
      notify,
      cooldownMs: 1000,
    });

    expect(heal).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(out).toEqual({ missingBefore: 0, healed: 0, stillMissing: 0 });
  });

  it("self-heals and stays silent when the fill covers every gap", async () => {
    const heal = vi.fn<HealFn>(async () => {});
    const notify = vi.fn<NotifyFn>(async () => {});
    // Missing on the first read, all filled on the recheck.
    const loadMissingAgents = vi
      .fn()
      .mockResolvedValueOnce([agent("a", { org_id: "org-1" }), agent("b", { org_id: "org-2" })])
      .mockResolvedValueOnce([]);

    const out = await runScheduleCoverageCheck({
      loadMissingAgents,
      heal,
      notify,
      cooldownMs: 1000,
    });

    // Healed once, per distinct org of the missing agents.
    expect(heal).toHaveBeenCalledTimes(1);
    expect(heal.mock.calls[0][0].sort()).toEqual(["org-1", "org-2"]);
    expect(notify).not.toHaveBeenCalled();
    expect(out).toEqual({ missingBefore: 2, healed: 2, stillMissing: 0 });
  });

  it("alerts on exactly the agents the fill could not heal (failure path)", async () => {
    const heal = vi.fn<HealFn>(async () => {});
    const notify = vi.fn<NotifyFn>(async () => {});
    const loadMissingAgents = vi
      .fn()
      .mockResolvedValueOnce([agent("a"), agent("b")])
      .mockResolvedValueOnce([agent("b")]); // b still missing after heal

    const out = await runScheduleCoverageCheck({
      loadMissingAgents,
      heal,
      notify,
      cooldownMs: 1000,
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const [key, cooldown, text] = notify.mock.calls[0];
    expect(key).toBe(AGENTS_WITHOUT_SCHEDULE_KEY);
    expect(cooldown).toBe(1000);
    expect(text).toMatch(/Agent b/);
    expect(text).not.toMatch(/Agent a/); // a was healed
    expect(out).toEqual({ missingBefore: 2, healed: 1, stillMissing: 1 });
  });

  it("still alerts when the heal itself throws (a broken fill must not be swallowed)", async () => {
    const heal = vi.fn(async () => {
      throw new Error("fill exploded");
    });
    const notify = vi.fn<NotifyFn>(async () => {});
    const loadMissingAgents = vi
      .fn()
      .mockResolvedValueOnce([agent("a")])
      .mockResolvedValueOnce([agent("a")]); // heal threw, still missing

    const out = await runScheduleCoverageCheck({
      loadMissingAgents,
      heal,
      notify,
      cooldownMs: 1000,
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ missingBefore: 1, healed: 0, stillMissing: 1 });
  });
});

// #1049: the self-heal call used to swallow its rejection. That matters because a
// heal that never ran is exactly why the gap alert then fires, so with no trace
// the alert reads as "these agents cannot be fixed" rather than "the fix never
// ran". Both are one line apart in the log and worlds apart to diagnose.
describe("runScheduleCoverageCheck records a failed self-heal (#1049)", () => {
  beforeEach(() => logError.mockClear());

  it("logs when heal rejects, and still completes the check and alerts", async () => {
    const heal = vi.fn<HealFn>(async () => {
      throw new Error("insert into availability_schedules denied");
    });
    const notify = vi.fn<NotifyFn>(async () => {});
    const loadMissingAgents = vi
      .fn<LoadFn>()
      .mockResolvedValueOnce([agent("a")])
      // The heal failed, so the gap is still there on the recheck.
      .mockResolvedValueOnce([agent("a")]);

    const out = await runScheduleCoverageCheck({
      loadMissingAgents,
      heal,
      notify,
      cooldownMs: 1000,
    });

    // A failed heal must NOT abort the lane: the alert about the surviving gap is
    // the whole point of the check.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ missingBefore: 1, healed: 0, stillMissing: 1 });

    // And the reason the heal did nothing is now findable.
    expect(logError).toHaveBeenCalledTimes(1);
    const [tag, fields, err] = logError.mock.calls[0] as [string, Record<string, unknown>, unknown];
    expect(tag).toBe("schedule-coverage");
    expect(String(fields.msg)).toMatch(/heal/i);
    expect(err).toBeInstanceOf(Error);
  });

  it("logs nothing when the heal succeeds", async () => {
    const loadMissingAgents = vi
      .fn<LoadFn>()
      .mockResolvedValueOnce([agent("a")])
      .mockResolvedValueOnce([]);

    await runScheduleCoverageCheck({
      loadMissingAgents,
      heal: vi.fn<HealFn>(async () => {}),
      notify: vi.fn<NotifyFn>(async () => {}),
      cooldownMs: 1000,
    });

    expect(logError).not.toHaveBeenCalled();
  });
});
