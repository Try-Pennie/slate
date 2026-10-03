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
  CALENDAR_WINDOW_FIRST_RUN_MS,
  CALENDAR_WINDOW_COLUMNS,
  calendarWindowRow,
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
  // An ESTABLISHED calendar: created three days ago, no failure recorded. That is
  // what every case written before the #2300 first-run window meant, so the grace
  // never silently answers for one of them.
  createdAtIso: new Date(Date.parse(NOW_ISO) - 3 * 24 * 60 * 60_000).toISOString(),
  hasRecordedFailure: false,
  ...over,
});

/** A calendar row created `minsAgo` minutes ago that hydration has never covered. */
const brandNew = (minsAgo: number, over: Partial<CalendarWindowRow> = {}): CalendarWindowRow =>
  row({
    syncWindowToIso: null,
    createdAtIso: new Date(Date.parse(NOW_ISO) - minsAgo * 60_000).toISOString(),
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
    // Zero graced: the ordinary case, where the pass really did judge every calendar.
    const text = formatCalendarWindowRecovery(0);
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
    expect(result.judged).toBe(0);
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(recordConsecutiveStreak).not.toHaveBeenCalled();
  });

  // all-clear-proof: a clear pass over ZERO judged calendars measured nothing, so it
  // may not end a page or reset the streak toward one (#2807, the #1152 shape).
  it("an empty roster judged nothing: no all-clear, no streak change (#2807)", async () => {
    const result = await runCalendarWindowCheck(deps([]));
    expect(result.status).toBe("clear");
    expect(result.judged).toBe(0);
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(recordConsecutiveStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("a pass that graced every calendar judged nothing: no all-clear, no streak change (#2807)", async () => {
    const result = await runCalendarWindowCheck(deps([brandNew(3), brandNew(7)]));
    expect(result.status).toBe("clear");
    expect(result.judged).toBe(0);
    expect(result.graced).toBe(2);
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(clearFailureStreak).not.toHaveBeenCalled();
    expect(recordConsecutiveStreak).not.toHaveBeenCalled();
    expect(sendThrottledAlert).not.toHaveBeenCalled();
  });

  it("one judged calendar that is covered is enough to resolve, even beside a graced one (#2807)", async () => {
    const result = await runCalendarWindowCheck(deps([row(), brandNew(3)]));
    expect(result.status).toBe("clear");
    expect(result.judged).toBe(1);
    expect(clearFailureStreak).toHaveBeenCalledWith(CALENDAR_WINDOW_KEY);
    expect(resolveAlert).toHaveBeenCalledWith(CALENDAR_WINDOW_KEY, formatCalendarWindowRecovery(1));
  });

  it("an uncovered tick that has not persisted counts the streak without paging", async () => {
    recordConsecutiveStreak.mockResolvedValueOnce(false);
    const result = await runCalendarWindowCheck(deps([row({ syncWindowToIso: null })]));
    expect(result.status).toBe("uncovered");
    expect(sendThrottledAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
  });
});

describe("the first run window (#2300)", () => {
  // A null sync_window_to was scored uncovered with no reference to how long the row
  // had existed, and for a calendar the hydration rotation has never reached, null is
  // the only value it can hold. The three tick streak was the only patience there was,
  // and fifteen minutes is not enough: the lane runs every fifteen minutes and took
  // thirty to cover four new calendars on 2026-09-14.
  it("a calendar whose row is minutes old has not yet been given a chance", () => {
    const out = uncoveredCalendars({ rows: [brandNew(5)], horizonDays: HORIZON_DAYS, nowIso: NOW_ISO });
    expect(out).toHaveLength(0);
  });

  it("the window EXPIRES, so a calendar the rotation really has missed still pages", () => {
    const past = CALENDAR_WINDOW_FIRST_RUN_MS / 60_000 + 1;
    const out = uncoveredCalendars({ rows: [brandNew(past)], horizonDays: HORIZON_DAYS, nowIso: NOW_ISO });
    expect(out).toHaveLength(1);
  });

  it("a recorded failure ends it at once, because that answer has already arrived", () => {
    // L458. Inside the window a rotation still working through its queue and one that
    // has already failed on this calendar look identical, since neither has produced a
    // success, and being patient about the second hides something already actionable.
    const out = uncoveredCalendars({
      rows: [brandNew(2, { hasRecordedFailure: true })],
      horizonDays: HORIZON_DAYS,
      nowIso: NOW_ISO,
    });
    expect(out).toHaveLength(1);
  });

  it("an unreadable created_at buys no patience", () => {
    const out = uncoveredCalendars({
      rows: [brandNew(2, { createdAtIso: "not-a-date" })],
      horizonDays: HORIZON_DAYS,
      nowIso: NOW_ISO,
    });
    expect(out).toHaveLength(1);
  });

  it("a missing created_at buys no patience either", () => {
    const out = uncoveredCalendars({
      rows: [brandNew(2, { createdAtIso: null })],
      horizonDays: HORIZON_DAYS,
      nowIso: NOW_ISO,
    });
    expect(out).toHaveLength(1);
  });

  it("only a calendar with NO coverage is in scope, never one whose coverage has lapsed", () => {
    // The stand down is no broader than its reason (L324). A window that once reached
    // past the horizon and has since fallen behind is the incident this alert exists
    // for, and a fresh row does not excuse it. In practice that is #1879's reactivated
    // agent, whose row is old anyway, but the rule must not depend on that.
    const lapsed = row({
      syncWindowToIso: new Date(HORIZON_END - 60_000).toISOString(),
      createdAtIso: new Date(Date.parse(NOW_ISO) - 60_000).toISOString(),
    });
    const out = uncoveredCalendars({ rows: [lapsed], horizonDays: HORIZON_DAYS, nowIso: NOW_ISO });
    expect(out).toHaveLength(1);
  });

  it("the window is derived from the hydration cadence, not chosen", () => {
    // 96 ticks a day is fifteen minutes. Asserted so the two cannot drift apart: a
    // patience shorter than one cadence pages before the rotation has had a single
    // opportunity, which is a page nobody could have pre-empted.
    expect(CALENDAR_WINDOW_FIRST_RUN_MS).toBe(15 * 60_000);
  });
});

describe("what the check says about a graced calendar (#2300)", () => {
  beforeEach(() => {
    recordConsecutiveStreak.mockClear();
    clearFailureStreak.mockClear();
    sendThrottledAlert.mockClear();
    resolveAlert.mockClear();
    recordConsecutiveStreak.mockResolvedValue(false);
  });

  it("reports how many it withheld, so a quiet tick and a withheld one differ", async () => {
    const res = await runCalendarWindowCheck({
      loadRows: async () => [row(), brandNew(3)],
      horizonDays: HORIZON_DAYS,
      nowIso: NOW_ISO,
      cooldownMs: 1000,
    });
    expect(res.status).toBe("clear");
    expect(res.graced).toBe(1);
    // #2798: the verdict lane stamps on calendars JUDGED, never on rows read.
    expect(res.judged).toBe(1);
  });

  it("a clear pass that graced every calendar judged none (#2798)", async () => {
    const res = await runCalendarWindowCheck({
      loadRows: async () => [brandNew(3)],
      horizonDays: HORIZON_DAYS,
      nowIso: NOW_ISO,
      cooldownMs: 1000,
    });
    expect(res.status).toBe("clear");
    expect(res.judged).toBe(0);
  });

  it("the all-clear may not claim what the grace declined to measure", () => {
    const clean = formatCalendarWindowRecovery(0);
    expect(clean).toMatch(/every bookable agent/i);

    const graced = formatCalendarWindowRecovery(2);
    expect(graced).not.toMatch(/every bookable agent/i);
    expect(graced).toMatch(/2/);
    expect(graced).not.toMatch(/undefined|NaN|\[object Object\]/);
    expect(graced).not.toMatch(new RegExp("[\\u2013\\u2014]"));
  });

  it("a graced calendar never reaches the page copy", async () => {
    recordConsecutiveStreak.mockResolvedValue(true);
    await runCalendarWindowCheck({
      loadRows: async () => [brandNew(3, { email: "new@trypennie.com" }), row({ syncWindowToIso: null, email: "old@trypennie.com" })],
      horizonDays: HORIZON_DAYS,
      nowIso: NOW_ISO,
      cooldownMs: 1000,
    });
    const body = sendThrottledAlert.mock.calls[0]?.[2] ?? "";
    expect(body).toContain("old@trypennie.com");
    expect(body).not.toContain("new@trypennie.com");
  });
});

// #3063: the readiness command and the monitor build their rows through ONE function,
// so the command judges with the same first-run grace and failure facts the page does.
describe("calendarWindowRow", () => {
  const cal = {
    user_id: "u1",
    calendar_id: "c1",
    sync_window_to: null,
    created_at: "2026-10-02T12:00:00Z",
    consecutive_failures: 0,
    last_sync_error: null,
  };
  const user = { id: "u1", name: "Ada", email: "ada@trypennie.com" };

  it("carries every fact the judge reads", () => {
    expect(calendarWindowRow(cal, user)).toEqual({
      userId: "u1",
      name: "Ada",
      email: "ada@trypennie.com",
      calendarId: "c1",
      syncWindowToIso: null,
      createdAtIso: "2026-10-02T12:00:00Z",
      hasRecordedFailure: false,
    });
  });

  it("counts a failure streak or a stored error as a recorded failure", () => {
    expect(calendarWindowRow({ ...cal, consecutive_failures: 2 }, user).hasRecordedFailure).toBe(true);
    expect(calendarWindowRow({ ...cal, last_sync_error: "403" }, user).hasRecordedFailure).toBe(true);
    expect(calendarWindowRow({ ...cal, consecutive_failures: null }, user).hasRecordedFailure).toBe(false);
  });

  it("names the columns it needs, so a read cannot leave one out", () => {
    for (const col of Object.keys(cal)) expect(CALENDAR_WINDOW_COLUMNS).toContain(col);
  });

  it("leaves name and email null for an agent the caller could not find", () => {
    const row = calendarWindowRow(cal, undefined);
    expect(row.name).toBeNull();
    expect(row.email).toBeNull();
  });
});
