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
import { judgePace, type PaceView } from "../src/lib/admin/team-capacity-pace.ts";

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
const NO_READINGS: PaceView = { kind: "fresh", byDay: new Map() };
/** A reading with no last call estimate: under 95%, or saved before #4190. */
const NO_LAST = { estimate_last_method: null, estimate_last_line_state: null, estimate_last_line_at: null, estimate_last_pattern_state: null, estimate_last_pattern_at: null };
const view = (days: CapacityDaySource[], todayIso = "2026-10-19", nowIso = "2026-10-19T19:30:00.000Z", pace: PaceView = NO_READINGS) =>
  teamCapacityView({ zone: Z, todayIso, nowMs: Date.parse(nowIso), durationMin: 20, nearlyFullPct: 85, days, pace });

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

// --- a day nobody could be counted on -----------------------------------------------------------
{
  const out = day({ out: true });
  const v = view([source("2026-10-20", "window", [{ advisor: advisor("Avery"), day: out }]), source("2026-10-16", "past", [{ advisor: advisor("Avery"), day: { ...out, iso: "2026-10-16" } }])]);
  eq(v.cards[0].fullPct, null, "a card with nobody counted carries no percent, never 0");
  eq(v.days[1].note, "Nobody was counted this day.", "nor does a past day's summary");
}

// --- today after every shift has ended, and a day nobody works (#4127) --------------------------
{
  const over = day({ iso: "2026-10-19", shiftStart: null, shiftEnd: null, capacity: 0, open: 0, openTimes: [], fullShiftStart: "2026-10-19T12:00:00.000Z", fullShiftEnd: "2026-10-19T21:00:00.000Z" });
  const noShift = day({ fullShiftStart: null, fullShiftEnd: null, shiftStart: null, shiftEnd: null, capacity: 0, open: 0, openTimes: [], noShift: true });
  const notFilling = judgePace({ ok: true, rows: ["2026-10-19", "2026-10-20"].map((d) => ({ day: d, read_at: "2026-10-20T01:30:00.000Z", pace_state: "not-filling", pace_per_hour: 0, pace_back_at: null, estimate_method: null, estimate_line_state: null, estimate_line_at: null, estimate_pattern_state: null, estimate_pattern_at: null, ...NO_LAST })) }, Date.parse("2026-10-20T02:00:00.000Z"));
  const days = [
    source("2026-10-19", "window", [{ advisor: advisor("Avery"), day: over }, { advisor: advisor("Blake"), day: { ...over, out: true } }]),
    source("2026-10-20", "window", [{ advisor: advisor("Avery"), day: noShift }, { advisor: advisor("Blake"), day: day({ out: true }) }]),
  ];
  const at10pm = (ended: { open: number; fullPct: number | null } | null) =>
    teamCapacityView({ zone: Z, todayIso: "2026-10-19", nowMs: Date.parse("2026-10-20T02:00:00.000Z"), durationMin: 20, nearlyFullPct: 85, days, pace: notFilling, todayEnded: ended });

  const v = at10pm({ open: 58, fullPct: 91 });
  const today = v.cards[0];
  eq(today.kind, "ended", "today with every shift over is a finished day, never nobody counted");
  eq([today.headline, today.resultLine, today.fullPct], ["Done for today", "58 calls went unbooked", 91], "it says so, then the calls that went unbooked, then how full it ended");
  eq(today.flag, null, "a finished day never takes the nearly full colour (Dan, 2026-10-22)");
  eq(today.pace, [], "nor a pace line: nothing is left to fill (#4101 decision 17)");
  eq(today.outLine, "1 advisor off", "its time off line stays");

  const unread = at10pm(null).cards[0];
  eq([unread.kind, unread.headline, unread.resultLine, unread.fullPct], ["ended", "Done for today", null, null], "history unreadable: Done for today alone, never a guessed figure");
  eq(at10pm({ open: 0, fullPct: null }).cards[0].resultLine, null, "history holding nothing for today: no figures either");
  eq(at10pm({ open: 1, fullPct: 99 }).cards[0].resultLine, "1 call went unbooked", "one call in the singular");

  const tomorrow = v.cards[1];
  eq(tomorrow.kind, "no-shift", "a day everyone is out or off shift is its own state");
  eq([tomorrow.open, tomorrow.unit, tomorrow.resultLine, tomorrow.fullPct], [0, " calls open", "No one on shift", null], "0 calls open, then No one on shift, with no percent");
  eq([tomorrow.outLine, tomorrow.pace, tomorrow.flag], [null, [], null], "and no time off line, no pace line and no flag (Dan, 2026-10-22)");

  const unsyncedOnly = view([source("2026-10-20", "window", [{ advisor: advisor("Avery", { unsynced: true }), day: day() }, { advisor: advisor("Blake"), day: noShift }])]).cards[0];
  eq([unsyncedOnly.kind, unsyncedOnly.resultLine], ["nobody-counted", null], "only unsynced calendars left: still Nobody counted, the open question on #4127");

  const midday = view([source("2026-10-19", "window", [{ advisor: advisor("Avery"), day: day({ iso: "2026-10-19" }) }, { advisor: advisor("Blake"), day: over }])]).cards[0];
  eq([midday.kind, midday.headline, midday.resultLine], ["open", null, null], "while one shift still runs, today is an ordinary card");
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

// --- the booking pace on the cards, and the one line under them (#4104, #4101) ----------------------
{
  const read = (over: Record<string, unknown>) => ({
    day: "2026-10-20", read_at: "2026-10-19T19:00:00.000Z", pace_state: "pace", pace_per_hour: 6, pace_back_at: null,
    estimate_method: "line", estimate_line_state: "at", estimate_line_at: "2026-10-20T01:30:00.000Z", estimate_pattern_state: null, estimate_pattern_at: null, ...NO_LAST, ...over,
  });
  const days = [
    source("2026-10-20", "window", [{ advisor: advisor("Avery"), day: day({ open: 5 }) }, { advisor: advisor("Blake", { unsynced: true }), day: day() }, { advisor: advisor("Casey"), day: day({ out: true }) }]),
    source("2026-10-21", "window", [{ advisor: advisor("Avery"), day: day({ iso: "2026-10-21", open: 0, openTimes: [] }) }]),
    source("2026-10-28", "beyond", [{ advisor: advisor("Avery"), day: day({ iso: "2026-10-28" }) }]),
  ];
  const now = Date.parse("2026-10-19T19:30:00.000Z");
  const fresh = judgePace({ ok: true, rows: [read({}), read({ day: "2026-10-21", pace_per_hour: 3 })] }, now);
  const v = view(days, "2026-10-19", "2026-10-19T19:30:00.000Z", fresh);
  eq(v.cards[0].pace, ["Filling at 6 an hour", "Full by 9:30pm at this pace"], "each card shows its own day's pace and estimate");
  // From 95% a card shows the last call estimate (decision 20, #4190), held in
  // scripts/test-team-capacity-pace.ts; the 96% card in the #4145 block below has none
  // stored, so it shows its pace alone.
  eq(v.cards[1].pace, [], "a card with no calls open shows no pace line (#4101 decision 18, 2026-10-23)");
  eq(v.paceNotice, null, "fresh readings need no line under the cards");
  eq([v.cards[0].outLine, v.cards[0].notSyncingLine], ["1 advisor off", "1 calendar not syncing"], "time off and not syncing in the settled words");
  eq([v.cards[1].outLine, v.cards[1].notSyncingLine], [null, null], "and nothing when there is none");

  const stale = view(days, "2026-10-19", "2026-10-19T19:30:00.000Z", judgePace({ ok: true, rows: [read({ read_at: "2026-10-19T17:30:00.000Z" })] }, now));
  assert(stale.cards.every((c) => c.pace.length === 0), "out of date: the cards drop their pace lines");
  eq(stale.paceNotice, { lead: "Couldn't update how fast the days are filling since 1:30pm.", rest: null }, "and one line says since when");

  const failed = view(days, "2026-10-19", "2026-10-19T19:30:00.000Z", judgePace({ ok: false, err: new Error("down") }, now));
  assert(failed.cards.every((c) => c.pace.length === 0), "a failed read: the cards drop their pace lines");
  eq(failed.paceNotice, { lead: "Couldn't load how fast the days are filling.", rest: "Try reloading in a minute." }, "and one line says so, never one per card");
  eq(failed.cards.map((c) => c.open), v.cards.map((c) => c.open), "and the rest of the page is unchanged");
}

// --- a day with no calls open and some capacity shows no pace (#4145, #4101 decision 18) ------------
{
  const reading = (state: "pace" | "not-filling") => judgePace({ ok: true, rows: ["2026-10-20", "2026-10-21"].map((d) => ({ day: d, read_at: "2026-10-19T19:00:00.000Z", pace_state: state, pace_per_hour: state === "pace" ? 20 : 0, pace_back_at: null, estimate_method: "line", estimate_line_state: "already", estimate_line_at: null, estimate_pattern_state: "already", estimate_pattern_at: null, ...NO_LAST })) }, Date.parse("2026-10-19T19:30:00.000Z"));
  const full = day({ open: 0, capacity: 10, openTimes: [] });
  const nearly = day({ iso: "2026-10-21", open: 1, capacity: 25, openTimes: ["2026-10-21T14:00:00.000Z"] });
  const days = [source("2026-10-20", "window", [{ advisor: advisor("Avery"), day: full }]), source("2026-10-21", "window", [{ advisor: advisor("Avery"), day: nearly }])];
  for (const state of ["pace", "not-filling"] as const) {
    const [fullCard, nearlyCard] = view(days, "2026-10-19", "2026-10-19T19:30:00.000Z", reading(state)).cards;
    eq([fullCard.flag, fullCard.pace], ["full", []], `a full day shows the Full tag and no pace line, its reading ${state}`);
    eq(nearlyCard.pace.length, 1, `a day at 96% with a call open still shows its pace line alone (${state})`);
  }
}

// --- the design's own frames, end to end -----------------------------------------------------------
const frameViewOf = (id: string) => {
  const f = fixtureView(fixture, id);
  if (!f.report.measurable) throw new Error(`${id} is measurable`);
  const r = f.report;
  return teamCapacityView({
    zone: r.zone,
    todayIso: r.windowDays[0],
    nowMs: r.nowMs,
    durationMin: r.eventType.duration_min,
    nearlyFullPct: f.nearlyFullPct,
    days: r.days.map((iso, i) => source(iso, "window", r.advisors.map((a) => ({ advisor: a, day: a.days[i] })))),
    pace: judgePace(f.pace, r.nowMs),
    todayEnded: f.todayEnded,
  });
};
{
  const v = frameViewOf("f1");
  eq(v.cards.length, fixture.snapshot.offeredOpenDays, "one card per offered day");
  eq(v.days[1].rows.length, fixture.snapshot.advisors.length, "every advisor has a row");
  const names = v.days[1].rows.map((x) => x.name);
  eq(names, [...names].sort((a, b) => a.localeCompare(b)), "in name order");
  // The pace each frame draws, as the design's checks expect it (D29 to D39).
  eq(v.cards.map((c) => c.pace), [
    ["Won't fill at this pace"],
    ["Filling at 9 an hour", "Full by 10pm at this pace"],
    ["Filling at 6 an hour", "Full by 9:30am Tue at this pace"],
    ["Filling at 11 an hour", "Won't fill at this pace"],
  ], "f1: not filling, at 95% the last call (#4190), a time on another day, and won't fill");
  eq(frameViewOf("f11").cards.map((c) => c.pace), [
    ["Won't fill at this pace"],
    ["Readings missed, pace back by 6:30pm"],
    ["Filling at 18 an hour", "Full by 9:30pm at this pace"],
    ["Filling at 11 an hour", "Full by 7pm Tue"],
  ], "f11: readings missed, a time later today, and the pattern");
  eq(frameViewOf("f12").cards.slice(2).map((c) => c.pace), [["Filling at 6 an hour", "Won't fill"], ["Pace shows after 3 hours of readings"]], "f12: the pattern that won't fill, and no pace yet");
  const f15 = frameViewOf("f15");
  eq([f15.cards[0].headline, f15.cards[0].resultLine, f15.cards[0].fullPct, f15.cards[0].pace], ["Done for today", "58 calls went unbooked", 91, []], "f15: today after every shift has ended");
  const f16 = frameViewOf("f16");
  eq([f16.cards[2].kind, f16.cards[2].resultLine, f16.cards[2].pace, f16.cards[2].outLine], ["no-shift", "No one on shift", [], null], "f16: Wednesday with nobody on shift");
  eq(frameViewOf("f13").paceNotice, { lead: "Couldn't load how fast the days are filling.", rest: "Try reloading in a minute." }, "f13: the pace can't load");
  eq(frameViewOf("f14").paceNotice, { lead: "Couldn't update how fast the days are filling since 1:30pm.", rest: null }, "f14: the pace is out of date");
  assert(frameViewOf("f14").cards.every((c) => c.pace.length === 0), "f14: no card keeps a pace line");
}

// --- the days the picker offers -----------------------------------------------------------------
{
  const days = pickableDays({
    todayIso: "2026-10-19",
    zone: Z,
    aheadDays: 3,
    saved: ["2026-10-17", "2026-10-15", "2026-10-16", "2026-10-18", "2026-10-19"],
    isOpen: (_iso, weekday) => weekday !== 7,
  });
  eq(days, ["2026-10-16", "2026-10-17", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"], "saved past days and the days ahead, never a closed Sunday, never a past day nothing saved");
  // History starts partway through its first day (the recorder's first run saves nothing and its
  // second covers only the rest of that day), so the earliest saved day would read nearly full.
  assert(!days.includes("2026-10-15"), "the first day history saved is never offered: it was only partly recorded");
  assert(!days.includes("2026-10-14"), "a past day with nothing saved is not offered (Dan, 2026-10-19)");
  assert(!days.includes("2026-10-23"), "nor a day past the cached calendars");
}

// --- the design's frames are served only to this machine, and only when asked ---------------------
{
  assert(designFixturesEnabled("1", "localhost:3100"), "the e2e run on this machine gets the frames");
  assert(designFixturesEnabled("1", "127.0.0.1:3100") && designFixturesEnabled("1", "[::1]:3100"), "by any loopback name");
  // The frames' branch reads the fixture from disk, which a Worker has none of, so no deployment
  // may carry the flag at all; the loopback check is the second lock, not the only one.
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert(!wrangler.includes("SLATE_DESIGN_FIXTURES"), "no deployment in wrangler.jsonc sets the design frames flag");
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
