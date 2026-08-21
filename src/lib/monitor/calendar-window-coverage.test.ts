import { describe, it, expect, vi, beforeEach } from "vitest";

// #1262: hydration is load-bearing once anything filters or prunes the busy
// cache, so its failure must be visible BEFORE either ships. What is under test
// is the DECISION: which calendars count as uncovered (null and unreadable are
// the fail-safe side, never "fine"), which measured state pages, which clears,
// and that a failed read does NEITHER (#1134, #1152).
const recordConsecutiveStreak = vi.hoisted(() =>
  vi.fn(async (_key: string, _windowSeconds: number, _afterTicks: number) => false),
);
const clearFailureStreak = vi.hoisted(() => vi.fn(async () => {}));
const sendThrottledAlert = vi.hoisted(() =>
  vi.fn(async (_key: string, _cooldownMs: number, _body: string) => {}),
);
const resolveAlert = vi.hoisted(() => vi.fn(async (_key: string, _text: string) => true));

vi.mock("@/lib/notify/streak", () => ({ recordConsecutiveStreak, clearFailureStreak }));
vi.mock("@/lib/notify/dispatch", () => ({ sendThrottledAlert, resolveAlert }));

import {
  uncoveredCalendars,
  runCalendarWindowCheck,
  formatCalendarWindowAlert,
  formatCalendarWindowRecovery,
  CALENDAR_WINDOW_KEY,
  CALENDAR_WINDOW_GRACE_MS,
  type CalendarWindowRow,
} from "./calendar-window-coverage";

const NOW_ISO = "2026-08-21T12:00:00.000Z";
const HORIZON_DAYS = 4;
// The horizon end this fixture implies: now + 4 days.
const HORIZON_END = Date.parse(NOW_ISO) + 4 * 24 * 60 * 60_000;

const row = (over: Partial<CalendarWindowRow> = {}): CalendarWindowRow => ({
  userId: "u1",
  name: "Dana Ruiz",
  email: "dana.ruiz@trypennie.com",
  calendarId: "dana.ruiz@trypennie.com",
  syncWindowToIso: new Date(HORIZON_END + 17 * 24 * 60 * 60_000).toISOString(),
  ...over,
});

describe("uncoveredCalendars (#1262)", () => {
  it("a window comfortably past the horizon is covered", () => {
    expect(
      uncoveredCalendars({ rows: [row()], horizonDays: HORIZON_DAYS, nowIso: NOW_ISO }),
    ).toEqual([]);
  });

  it("a window short of the horizon plus grace is uncovered", () => {
    const short = row({
      syncWindowToIso: new Date(HORIZON_END + CALENDAR_WINDOW_GRACE_MS - 1).toISOString(),
    });
    expect(
      uncoveredCalendars({ rows: [short], horizonDays: HORIZON_DAYS, nowIso: NOW_ISO }),
    ).toEqual([short]);
  });

  it("a window exactly at the horizon plus grace is still covered", () => {
    const exact = row({
      syncWindowToIso: new Date(HORIZON_END + CALENDAR_WINDOW_GRACE_MS).toISOString(),
    });
    expect(
      uncoveredCalendars({ rows: [exact], horizonDays: HORIZON_DAYS, nowIso: NOW_ISO }),
    ).toEqual([]);
  });

  it("a null window is uncovered: no recorded coverage is the fail-safe side", () => {
    const never = row({ syncWindowToIso: null });
    expect(
      uncoveredCalendars({ rows: [never], horizonDays: HORIZON_DAYS, nowIso: NOW_ISO }),
    ).toEqual([never]);
  });

  it("an unreadable stamp is uncovered, never silently fine", () => {
    const garbage = row({ syncWindowToIso: "not a date" });
    expect(
      uncoveredCalendars({ rows: [garbage], horizonDays: HORIZON_DAYS, nowIso: NOW_ISO }),
    ).toEqual([garbage]);
  });
});

describe("the copy", () => {
  it("the page names who is uncovered and what a lead would experience", () => {
    const text = formatCalendarWindowAlert([row({ syncWindowToIso: null })], HORIZON_DAYS);
    expect(text).toContain("Dana Ruiz");
    expect(text).not.toContain("undefined");
  });

  it("the all-clear stands down without repeating the remediation", () => {
    const text = formatCalendarWindowRecovery();
    expect(text.length).toBeGreaterThan(20);
    expect(text).not.toContain("undefined");
  });
});

describe("runCalendarWindowCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const deps = (rows: CalendarWindowRow[] | (() => Promise<CalendarWindowRow[]>)) => ({
    loadRows: typeof rows === "function" ? rows : async () => rows,
    horizonDays: HORIZON_DAYS,
    nowIso: NOW_ISO,
    cooldownMs: 60 * 60_000,
  });

  it("pages once an uncovered calendar has persisted", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(true);
    const result = await runCalendarWindowCheck(deps([row({ syncWindowToIso: null })]));
    expect(result.status).toBe("uncovered");
    expect(sendThrottledAlert).toHaveBeenCalledWith(
      CALENDAR_WINDOW_KEY,
      expect.any(Number),
      expect.stringContaining("Dana Ruiz"),
    );
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it("a measured zero uncovered clears the streak and announces recovery", async () => {
    const result = await runCalendarWindowCheck(deps([row()]));
    expect(result.status).toBe("clear");
    expect(clearFailureStreak).toHaveBeenCalledWith(CALENDAR_WINDOW_KEY);
    expect(resolveAlert).toHaveBeenCalledWith(CALENDAR_WINDOW_KEY, expect.any(String));
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  // all-clear-proof: the recovery hangs off the MEASURED healthy result, never
  // off "we did not alert this run". A read that failed measured nothing.
  it("a failed read does NEITHER: no page, no all-clear, no streak change", async () => {
    const result = await runCalendarWindowCheck(
      deps(async () => {
        throw new Error("calendars unreadable");
      }),
    );
    expect(result.status).toBe("unreadable");
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(recordConsecutiveStreak).not.toHaveBeenCalled();
  });

  it("an uncovered tick that has not persisted counts the streak without paging", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(false);
    const result = await runCalendarWindowCheck(deps([row({ syncWindowToIso: null })]));
    expect(result.status).toBe("uncovered");
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
  });
});
