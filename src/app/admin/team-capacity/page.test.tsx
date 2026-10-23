// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DateTime } from "luxon";

// The Team capacity page's own decisions (#3936). The numbers are #3935's and the picture is held
// to the design by the e2e score; what only this file can get wrong is who may open it, which read
// failing says what, which day it opens on, and that the design's frames are never served from a
// deployment. Every failure must arrive as its own sentence and never as a team with no room,
// which is the reading that pauses ad spend.
const auth = vi.hoisted(() => ({ currentUser: vi.fn() }));
const redirect = vi.hoisted(() => vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }));
const hdrs = vi.hoisted(() => ({ host: "slate.trypennie.app" }));
const load = vi.hoisted(() => ({ loadTeamCapacity: vi.fn() }));
const settings = vi.hoisted(() => ({ readNearlyFullPct: vi.fn(async (): Promise<number | null> => 85) }));
const hours = vi.hoisted(() => ({ loadBusinessHours: vi.fn() }));
const store = vi.hoisted(() => ({ readSavedDays: vi.fn(), loadCapacityHistoryDay: vi.fn() }));
const paceLoad = vi.hoisted(() => ({ readPaceRows: vi.fn() }));
const logger = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/auth", () => auth);
vi.mock("next/navigation", () => ({ redirect, useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/headers", () => ({ headers: async () => new Map([["host", hdrs.host]]) }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), consoleHiddenFor: () => false }));
vi.mock("@/lib/admin/team-capacity-load", () => load);
vi.mock("@/lib/booking/settings", () => settings);
vi.mock("@/lib/booking/business-hours-load", () => hours);
vi.mock("@/lib/admin/capacity-history-store", () => store);
vi.mock("@/app/admin/actions", () => ({ setNearlyFullPct: vi.fn() }));
vi.mock("@/lib/log", () => logger);
vi.mock("@/lib/admin/team-capacity-pace-load", () => paceLoad);

import TeamCapacityPage from "./page";

const Z = "America/New_York";
const today = DateTime.now().setZone(Z).startOf("day");
const iso = (n: number) => today.plus({ days: n }).toISODate()!;
/** A past day the office was open (the hours below shut Sundays), whatever today is. */
const openPastDay = () => {
  let d = today.minus({ days: 3 });
  while (d.weekday === 7) d = d.minus({ days: 1 });
  return d;
};
const advisorDay = (d: string) => ({
  iso: d, open: 3, capacity: 10, out: false, noShift: false,
  openTimes: [], shiftStart: null, shiftEnd: null, fullShiftStart: null, fullShiftEnd: null, timeOff: [],
});
function report(windowDays: string[]) {
  return {
    measurable: true as const, nowMs: Date.now(), zone: Z, windowDays, bookerDays: windowDays, days: windowDays,
    eventType: { duration_min: 20, slot_interval_min: 10, min_notice_min: 5, buffer_before_min: 10, buffer_after_min: 10, daily_cap: null },
    advisors: [{ id: "u1", name: "Avery Calder", email: "avery@x.test", timezone: Z, unsynced: false, days: windowDays.map(advisorDay) }],
  };
}
const user = (role: string) => ({ id: "me", org_id: "org-1", role, email: "me@x.test" });
const renderPage = async (sp: Record<string, string> = {}) => render(await TeamCapacityPage({ searchParams: Promise.resolve(sp) }));
const selectedTab = () => document.querySelector('[data-tc="day-tab"][data-selected="true"]')?.textContent ?? "";

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  hdrs.host = "slate.trypennie.app";
  delete process.env.SLATE_DESIGN_FIXTURES;
  auth.currentUser.mockResolvedValue(user("admin"));
  load.loadTeamCapacity.mockResolvedValue(report([iso(0), iso(1), iso(2), iso(3)]));
  settings.readNearlyFullPct.mockResolvedValue(85);
  hours.loadBusinessHours.mockResolvedValue({ zone: Z, rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 480, end_minute: 1200 })), exceptions: [], source: "stored" });
  store.readSavedDays.mockResolvedValue([]);
  store.loadCapacityHistoryDay.mockResolvedValue([]);
  paceLoad.readPaceRows.mockResolvedValue({ ok: true, rows: [] });
});

/**
 * A reading of `day` taken `agoMin` minutes ago, filling at 6 an hour, full an hour after it. One
 * run's rows share one read_at, as the lane writes them, so a run is built from one instant: rows
 * built a millisecond apart would read as two runs, of which only the newest counts.
 */
const paceRun = (days: string[], agoMin = 4) => {
  const readAt = DateTime.now().minus({ minutes: agoMin });
  return days.map((day) => paceRow(day, readAt));
};
const paceRow = (day: string, readAt: DateTime) => {
  return {
    day, read_at: readAt.toISO(), pace_state: "pace", pace_per_hour: 6, pace_back_at: null,
    estimate_method: "line", estimate_line_state: "at", estimate_line_at: readAt.plus({ hours: 1 }).toISO(), estimate_pattern_state: null, estimate_pattern_at: null,
  };
};
const paceLines = (card: number) => [...document.querySelectorAll('[data-tc="day-card"]')[card].querySelectorAll('[data-tc="pace"]')].map((n) => n.textContent);
const notices = () => [...document.querySelectorAll('[data-tc="pace-notice"]')].map((n) => n.textContent);

describe("/admin/team-capacity, the booking pace (#4104)", () => {
  it("reads the pace for the viewer's own organisation and shows it on each card", async () => {
    paceLoad.readPaceRows.mockResolvedValue({ ok: true, rows: paceRun([iso(0), iso(1), iso(2), iso(3)]) });
    await renderPage();
    expect(paceLoad.readPaceRows).toHaveBeenCalledWith("org-1");
    expect(paceLines(1)[0]).toBe("Filling at 6 an hour");
    expect(paceLines(1)[1]).toMatch(/^Full by \d{1,2}(:\d\d)?[ap]m( \w{3})? at this pace$/);
    expect(notices()).toEqual([]);
  });

  it("says once, under the cards, when the pace could not be read, and still shows the rest", async () => {
    const err = new Error("down");
    paceLoad.readPaceRows.mockResolvedValue({ ok: false, err });
    await renderPage();
    expect(notices()).toEqual(["Couldn't load how fast the days are filling.Try reloading in a minute."]);
    expect(document.querySelector('[data-tc="pace"]')).toBeNull();
    expect(document.querySelectorAll('[data-tc="day-card"]').length).toBe(4);
    expect(document.querySelectorAll('[data-tc="lane-row"]').length).toBe(1);
    expect(logger.log.error).toHaveBeenCalledWith("team-capacity", expect.objectContaining({ msg: "booking pace read failed" }), err);
  });

  it("says since when, once, when the latest reading is out of date", async () => {
    paceLoad.readPaceRows.mockResolvedValue({ ok: true, rows: paceRun([iso(1)], 120) });
    await renderPage();
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatch(/^Couldn't update how fast the days are filling since \d{1,2}(:\d\d)?[ap]m( \w{3})?\.$/);
    expect(document.querySelector('[data-tc="pace"]')).toBeNull();
  });

  it("keys the timeline's marks at the end of the tab row, with Past on today's tab only", async () => {
    await renderPage();
    const key = () => [...document.querySelectorAll('[data-tc="key-item"]')].map((n) => n.textContent);
    const group = screen.getByRole("group", { name: "Key" });
    expect(group.parentElement?.lastElementChild).toBe(group);
    expect(key()).toEqual(["Busy", "Open", "Not working"]);
    (document.querySelector('[data-tc="day-tab"]') as HTMLButtonElement).click();
    await screen.findByText("Past");
    expect(key()).toEqual(["Busy", "Open", "Not working", "Past"]);
    expect(document.querySelector('[data-tc="open-heading"]')?.textContent).toBe("Open");
  });

  it("says the pace is coming on every card before the first readings", async () => {
    await renderPage();
    expect([0, 1, 2, 3].map((i) => paceLines(i))).toEqual(Array(4).fill(["Pace shows after 3 hours of readings"]));
  });
});

describe("/admin/team-capacity", () => {
  it("sends a signed out visitor to sign in", async () => {
    auth.currentUser.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("refuses an agent, and reads nothing", async () => {
    auth.currentUser.mockResolvedValue(user("agent"));
    await renderPage();
    expect(screen.getByText(/You need a manager or admin account/)).toBeTruthy();
    expect(load.loadTeamCapacity).not.toHaveBeenCalled();
  });

  it("scopes every read to the viewer's own organisation", async () => {
    await renderPage();
    expect(load.loadTeamCapacity).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1" }));
    // Every saved day, so the first one it leaves out is history's real first day.
    expect(store.readSavedDays).toHaveBeenCalledWith("org-1", "1970-01-01");
  });

  it("opens on tomorrow, found by date", async () => {
    await renderPage();
    expect(selectedTab()).toMatch(/^Tomorrow/);
    // After the evening cutoff the window starts tomorrow, and the page still opens on it.
    load.loadTeamCapacity.mockResolvedValue(report([iso(1), iso(2), iso(3), iso(4)]));
    cleanup();
    await renderPage();
    expect(selectedTab()).toMatch(/^Tomorrow/);
  });

  it("puts every day's card in one row, five after the 6 PM cutoff (#3949)", async () => {
    load.loadTeamCapacity.mockResolvedValue(report([iso(0), iso(1), iso(2), iso(3), iso(4)]));
    await renderPage();
    const row = document.querySelector<HTMLElement>("section.totals");
    expect(document.querySelectorAll('[data-tc="day-card"]').length).toBe(5);
    expect(row?.style.gridTemplateColumns).toBe("repeat(5, minmax(0, 1fr))");
  });

  it("lets an admin move the line and a manager only read it", async () => {
    await renderPage();
    expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
    cleanup();
    auth.currentUser.mockResolvedValue(user("manager"));
    await renderPage();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.getByText("Nearly full at 85% full or more.")).toBeTruthy();
  });

  it.each([
    ["the calendars", () => load.loadTeamCapacity.mockResolvedValue({ measurable: false, reason: "calendars" }), "Couldn't load advisor calendars"],
    ["the nearly full line", () => settings.readNearlyFullPct.mockResolvedValue(null), "Couldn't load the nearly full line"],
    ["the office hours", () => hours.loadBusinessHours.mockRejectedValue(new Error("down")), "Couldn't load the office hours"],
    ["the saved days", () => store.readSavedDays.mockRejectedValue(new Error("down")), "Couldn't load past days"],
  ])("says when %s could not be read, and shows no numbers", async (_what, fail, heading) => {
    fail();
    await renderPage();
    expect(document.querySelector('[data-tc="failed"]')?.textContent).toContain(heading);
    expect(document.querySelector('[data-tc="day-card"]')).toBeNull();
    expect(document.querySelector('[data-tc="lane-row"]')).toBeNull();
  });

  it("opens a saved past day from history, and says how it ended", async () => {
    const past = openPastDay().toISODate()!;
    // The first saved day is left out as partly recorded, so history began the week before.
    store.readSavedDays.mockResolvedValue([openPastDay().minus({ days: 7 }).toISODate()!, past]);
    store.loadCapacityHistoryDay.mockResolvedValue([{ id: "u1", name: "Avery Calder", email: "avery@x.test", timezone: Z, unsynced: false, days: [{ ...advisorDay(past), open: 2, capacity: 8 }] }]);
    await renderPage({ day: past });
    expect(store.loadCapacityHistoryDay).toHaveBeenCalledWith("org-1", past);
    expect(load.loadTeamCapacity).toHaveBeenCalledWith(expect.objectContaining({ extraDay: null }));
    expect(document.querySelector('[data-tc="day-note"]')?.textContent).toBe("Ended 75% full, with room left for 2 more calls.");
  });

  it("opens on the picked day when a date is picked after another day was shown", async () => {
    const view = await renderPage();
    expect(selectedTab()).toMatch(/^Tomorrow/);
    // The picker navigates to ?day=, and the page comes back with that day added to the list.
    const later = iso(10);
    load.loadTeamCapacity.mockResolvedValue({ ...report([iso(0), iso(1), iso(2), iso(3)]), days: [iso(0), iso(1), iso(2), iso(3), later], advisors: [{ ...report([iso(0)]).advisors[0], days: [iso(0), iso(1), iso(2), iso(3), later].map(advisorDay) }] });
    view.rerender(await TeamCapacityPage({ searchParams: Promise.resolve({ day: later }) }));
    expect(selectedTab()).toBe(`${DateTime.fromISO(later, { zone: Z }).toFormat("ccc")}, ${DateTime.fromISO(later, { zone: Z }).toFormat("LLL d")}`);
  });

  it("closes the line's form when the page comes back from a save", async () => {
    const view = await renderPage();
    screen.getByRole("button", { name: "Change" }).click();
    await screen.findByRole("button", { name: "Cancel" });
    // The save redirects back here, so the server renders the page again, a moment later.
    const later = Date.now() + 1000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    view.rerender(await TeamCapacityPage({ searchParams: Promise.resolve({ ok: "nearly-full" }) }));
    clock.mockRestore();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
  });

  it("never opens the first day history saved, even by its address", async () => {
    const first = openPastDay().toISODate()!;
    store.readSavedDays.mockResolvedValue([first]);
    store.loadCapacityHistoryDay.mockResolvedValue([{ id: "u1", name: "Avery Calder", email: "avery@x.test", timezone: Z, unsynced: false, days: [{ ...advisorDay(first), open: 0, capacity: 8 }] }]);
    await renderPage({ day: first });
    expect(selectedTab()).toMatch(/^Tomorrow/);
    expect(document.querySelector('[data-tc="day-note"]')).toBeNull();
  });

  it("opens on tomorrow when the past day picked holds nothing saved", async () => {
    await renderPage({ day: iso(-3) });
    expect(selectedTab()).toMatch(/^Tomorrow/);
    expect(document.querySelector('[data-tc="day-note"]')).toBeNull();
  });

  it("refuses the past day when its history cannot be read, rather than showing an empty day", async () => {
    store.loadCapacityHistoryDay.mockRejectedValue(new Error("down"));
    await renderPage({ day: iso(-3) });
    expect(document.querySelector('[data-tc="failed"]')?.textContent).toContain("Couldn't load past days");
  });

  it("never serves the design's frames from a deployment", async () => {
    process.env.SLATE_DESIGN_FIXTURES = "1";
    await renderPage({ frame: "f1" });
    // A real host renders the real page: the loader ran.
    expect(load.loadTeamCapacity).toHaveBeenCalled();
    cleanup();
    vi.clearAllMocks();
    delete process.env.SLATE_DESIGN_FIXTURES;
    hdrs.host = "localhost:3100";
    await renderPage({ frame: "f1" });
    expect(load.loadTeamCapacity).toHaveBeenCalled();
  });

  it("serves a design frame from the fixture on this machine under the flag, reading nothing", async () => {
    process.env.SLATE_DESIGN_FIXTURES = "1";
    hdrs.host = "localhost:3100";
    await renderPage({ frame: "f1" });
    expect(load.loadTeamCapacity).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[data-tc="lane-row"]').length).toBeGreaterThan(50);
  });
});
