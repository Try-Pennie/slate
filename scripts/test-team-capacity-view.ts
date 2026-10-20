// What the Team capacity page draws (#3936), held to the settled design (docs/design/team-capacity.html).
// The design match score compares the pictures; this holds the rules a picture cannot name: which
// words a whole day gets on which day, where the Now line falls and on which day only, which tabs
// carry a flag, and that a picked day never borrows the window's numbers.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-team-capacity-view.ts
import { readFileSync } from "node:fs";
import { assert, eq, finish } from "./lib/harness.ts";
import { axisPos, pickableDays, teamCapacityView, type CapacityDaySource } from "../src/lib/admin/team-capacity-view.ts";
import { designFixturesEnabled, fixtureView, type DesignFixtureFile } from "../src/lib/admin/team-capacity-fixture.ts";
import type { AdvisorDay, TeamCapacityAdvisor } from "../src/lib/admin/team-capacity.ts";

const Z = "America/New_York";
const fixture = JSON.parse(readFileSync(new URL("../docs/design/fixtures/team-capacity.json", import.meta.url), "utf8")) as DesignFixtureFile;

const day = (over: Partial<AdvisorDay> = {}): AdvisorDay => ({
  iso: "2026-10-20",
  open: 2,
  capacity: 10,
  out: false,
  noShift: false,
  openTimes: ["2026-10-20T14:00:00.000Z", "2026-10-20T15:00:00.000Z"],
  shiftStart: "2026-10-20T13:00:00.000Z",
  shiftEnd: "2026-10-20T20:30:00.000Z",
  fullShiftStart: "2026-10-20T13:00:00.000Z",
  fullShiftEnd: "2026-10-20T21:00:00.000Z",
  timeOff: [],
  ...over,
});
const advisor = (name: string, over: Partial<TeamCapacityAdvisor> = {}): TeamCapacityAdvisor => ({
  id: name, name, email: `${name.toLowerCase()}@x.test`, timezone: Z, unsynced: false, days: [], ...over,
});
const source = (iso: string, kind: CapacityDaySource["kind"], advisors: { advisor: TeamCapacityAdvisor; day: AdvisorDay }[]): CapacityDaySource => ({ iso, kind, advisors });
const view = (days: CapacityDaySource[], todayIso = "2026-10-19", nowIso = "2026-10-19T19:30:00.000Z") =>
  teamCapacityView({ zone: Z, todayIso, nowMs: Date.parse(nowIso), durationMin: 20, nearlyFullPct: 85, days });

// --- the axis ---------------------------------------------------------------------------
eq(axisPos("2026-10-20T12:00:00.000Z", Z), 0, "8am in New York is the axis start");
eq(axisPos("2026-10-21T01:00:00.000Z", Z), 100, "9pm in New York is the axis end");
eq(axisPos("2026-11-03T13:00:00.000Z", Z), 0, "8am after the clocks change is still the start");

// --- whole days, by day -------------------------------------------------------------------
{
  const noShift = day({ fullShiftStart: null, fullShiftEnd: null, shiftStart: null, shiftEnd: null, capacity: 0, open: 0, openTimes: [], noShift: true });
  const v = view([
    source("2026-10-19", "window", [{ advisor: advisor("Avery"), day: { ...noShift, iso: "2026-10-19" } }]),
    source("2026-10-20", "window", [{ advisor: advisor("Avery"), day: noShift }, { advisor: advisor("Blake"), day: day({ out: true }) }]),
  ]);
  eq(v.days[0].rows[0].whole, "No shift today", "today with no hours says so");
  eq(v.days[1].rows[0].whole, "No shift", "tomorrow is never called today (Dan, 2026-10-19)");
  eq(v.days[1].rows[1].whole, "Out, approved time off", "a whole day off");
  eq([v.days[1].rows[1].count, v.days[1].rows[0].count], ["", ""], "a whole day has no Open count");
  assert(v.days[1].rows[1].taken === null && v.days[1].rows[1].open.length === 0, "and nothing else is drawn on it");
}

// --- today: the Now line, the gone hours, a shift already over ---------------------------------
{
  const over = day({ iso: "2026-10-19", shiftStart: null, shiftEnd: null, capacity: 0, open: 0, openTimes: [], fullShiftStart: "2026-10-19T12:00:00.000Z", fullShiftEnd: "2026-10-19T16:00:00.000Z" });
  const live = day({ iso: "2026-10-19", fullShiftStart: "2026-10-19T13:00:00.000Z", fullShiftEnd: "2026-10-19T21:00:00.000Z", shiftStart: "2026-10-19T19:40:00.000Z", shiftEnd: "2026-10-19T20:30:00.000Z" });
  const v = view([source("2026-10-19", "window", [{ advisor: advisor("Avery"), day: over }, { advisor: advisor("Blake"), day: live }]), source("2026-10-20", "window", [{ advisor: advisor("Avery"), day: day() }])]);
  const now = axisPos("2026-10-19T19:30:00.000Z", Z);
  eq(v.days[0].nowPos, now, "today carries the Now line where now falls");
  eq(v.days[1].nowPos, null, "no other day does");
  eq(v.days[0].rows[0].taken, null, "a shift already over draws no used up bar");
  eq(v.days[0].rows[0].gone, { left: 0, width: axisPos("2026-10-19T16:00:00.000Z", Z) }, "only its gone hours");
  eq(v.days[0].rows[1].gone?.width, now - axisPos("2026-10-19T13:00:00.000Z", Z), "a live shift is gone up to now");
  assert(v.ticks[0].some((t) => t.hidden) && v.ticks[1].every((t) => !t.hidden), "only today hides the ticks under the Now label");
}

// --- flags on cards and tabs; a picked day ----------------------------------------------------
{
  const full = day({ open: 0, openTimes: [], capacity: 10 });
  const nearly = day({ open: 1, capacity: 10 });
  const v = view([
    source("2026-10-19", "window", [{ advisor: advisor("Avery"), day: full }]),
    source("2026-10-20", "window", [{ advisor: advisor("Avery"), day: nearly }]),
    source("2026-10-21", "window", [{ advisor: advisor("Avery"), day: day() }]),
    source("2026-10-28", "beyond", [{ advisor: advisor("Avery"), day: full }]),
  ]);
  eq(v.cards.map((c) => c.flag), ["full", "nearly-full", null], "cards flag Full and Nearly full");
  eq(v.cards.length, 3, "a picked day gets no card");
  eq(v.tabs.map((t) => t.dot), [true, true, false, true], "the dot marks any day at or over the line");
  eq(v.tabs[3].flag, null, "a picked day's tab is never coloured as the window's");
  eq(v.tabs[3].label, "Wed, Oct 28", "and is named by its weekday and date");
  eq(v.days[3].note, "Leads can't book this day yet, so it will fill up more than it shows.", "a day past the window says leads can't book it yet");
  eq(v.tabs[1].label, "Tomorrow, Tue Oct 20", "tomorrow by name");
}

// --- a saved past day -------------------------------------------------------------------------
{
  const v = view([
    source("2026-10-19", "window", [{ advisor: advisor("Avery"), day: day({ iso: "2026-10-19" }) }]),
    source("2026-10-16", "past", [{ advisor: advisor("Avery"), day: day({ iso: "2026-10-16", open: 3, capacity: 12 }) }, { advisor: advisor("Blake", { unsynced: true }), day: day({ iso: "2026-10-16", open: 9 }) }]),
  ]);
  eq(v.days[1].note, "Ended 75% full, with room left for 3 more calls.", "a past day says how it ended, counting only the advisors it can trust");
  assert(v.days[1].rows.every((r) => r.past), "its open calls are drawn as a past day's");
  eq(v.days[1].rows[1].tag, "Calendar not syncing", "a day saved while a calendar was not syncing says so");
}

// --- the design's own frame, end to end -----------------------------------------------------------
{
  const f = fixtureView(fixture, "f1");
  if (!f.report.measurable) throw new Error("f1 is measurable");
  const r = f.report;
  const v = teamCapacityView({
    zone: r.zone,
    todayIso: r.windowDays[0],
    nowMs: r.nowMs,
    durationMin: r.eventType.duration_min,
    nearlyFullPct: f.nearlyFullPct,
    days: r.days.map((iso, i) => source(iso, "window", r.advisors.map((a) => ({ advisor: a, day: a.days[i] })))),
  });
  eq(v.cards.length, fixture.snapshot.offeredOpenDays, "one card per offered day");
  eq(v.days[1].rows.length, fixture.snapshot.advisors.length, "every advisor has a row");
  const names = v.days[1].rows.map((x) => x.name);
  eq(names, [...names].sort((a, b) => a.localeCompare(b)), "in name order");
}

// --- the days the picker offers -----------------------------------------------------------------
{
  const days = pickableDays({
    todayIso: "2026-10-19",
    zone: Z,
    aheadDays: 3,
    saved: ["2026-10-17", "2026-10-16", "2026-10-18", "2026-10-19"],
    isOpen: (_iso, weekday) => weekday !== 7,
  });
  eq(days, ["2026-10-16", "2026-10-17", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"], "saved past days and the days ahead, never a closed Sunday, never a past day nothing saved");
  assert(!days.includes("2026-10-15"), "a past day with nothing saved is not offered (Dan, 2026-10-19)");
  assert(!days.includes("2026-10-23"), "nor a day past the cached calendars");
}

// --- the design's frames are served only to this machine, and only when asked ---------------------
{
  assert(designFixturesEnabled("1", "localhost:3100"), "the e2e run on this machine gets the frames");
  assert(designFixturesEnabled("1", "127.0.0.1:3100") && designFixturesEnabled("1", "[::1]:3100"), "by any loopback name");
  for (const [flag, host] of [[undefined, "localhost:3100"], ["true", "localhost:3100"], ["1", "slate.trypennie.app"], ["1", "localhost.evil.test"], ["1", null]] as const) {
    assert(!designFixturesEnabled(flag, host), `never with flag ${String(flag)} on host ${String(host)}`);
  }
}

// --- the fixture's picker draws the calendar the design captured -----------------------------------
{
  // The captured month (docs/design/team-capacity.html, frame f7) greys out only Sundays in October.
  const offered = new Set(fixtureView(fixture, "f7").pickable);
  const october = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
  const greyed = october.filter((iso) => !offered.has(iso));
  eq(greyed, ["2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25"], "October greys out its Sundays and nothing else");
}

finish();
