// The booking pace on Team capacity's day cards (#4104, the design settled in #4101): which lines a
// card shows from its day's latest reading, and when the one line under the cards says the pace
// could not be read or stopped updating. The words are held to the settled design
// (docs/design/team-capacity.html, D29 to D39); the picture is the design score's.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-team-capacity-pace.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { cardPaceLines, judgePace, PACE_ESTIMATE_PCT, type DayPace, type PaceRow } from "../src/lib/admin/team-capacity-pace.ts";
import { LANE_STALE_BOUNDS_MS } from "../src/lib/monitor/health.ts";

const Z = "America/New_York";
const TODAY = "2026-10-19";
// 3:34pm ET on Monday 19 October, four minutes after the 3:30pm reading.
const NOW = Date.parse("2026-10-19T19:34:00.000Z");
const READ = "2026-10-19T19:30:00.000Z";

const row = (day: string, over: Partial<PaceRow> = {}): PaceRow => ({
  day,
  read_at: READ,
  pace_state: "pace",
  pace_per_hour: 6.1,
  pace_back_at: null,
  estimate_method: "line",
  estimate_line_state: "at",
  estimate_line_at: "2026-10-20T01:30:00.000Z",
  estimate_pattern_state: "wont-fill",
  estimate_pattern_at: null,
  estimate_last_line_state: null,
  estimate_last_line_at: null,
  estimate_last_pattern_state: null,
  estimate_last_pattern_at: null,
  estimate_last_method: null,
  ...over,
});
const fresh = (rows: PaceRow[]) => {
  const v = judgePace({ ok: true, rows }, NOW);
  if (v.kind !== "fresh") throw new Error(`expected a fresh reading, got ${v.kind}`);
  return v.byDay;
};
const lines = (r: PaceRow | undefined, fullPct: number | null = 88) => {
  const day: DayPace | undefined = r ? fresh([r]).get(r.day) : undefined;
  return cardPaceLines(day, fullPct, Z, TODAY);
};

// --- the two lines (D29 to D32) ------------------------------------------------------------------
eq(lines(row("2026-10-21")), ["Filling at 6 an hour", "Full by 9:30pm at this pace"], "the pace, then a time later today, bare (D29, D30)");
eq(lines(row("2026-10-21", { estimate_line_at: "2026-10-20T13:30:00.000Z" })), ["Filling at 6 an hour", "Full by 9:30am Tue at this pace"], "a time on another day carries its weekday after it (D31)");
eq(lines(row("2026-10-21", { estimate_line_at: "2026-10-20T00:00:00.000Z" })), ["Filling at 6 an hour", "Full by 8pm at this pace"], "a time on the hour drops its minutes");
eq(lines(row("2026-10-22", { estimate_line_state: "wont-fill", estimate_line_at: null })), ["Filling at 6 an hour", "Won't fill at this pace"], "a day the straight line won't fill (D30)");
eq(lines(row("2026-10-22", { estimate_method: "pattern", estimate_pattern_state: "at", estimate_pattern_at: "2026-10-20T23:00:00.000Z" })), ["Filling at 6 an hour", "Full by 7pm Tue"], "the pattern carries no qualifier (D32)");
eq(lines(row("2026-10-22", { estimate_method: "pattern" })), ["Filling at 6 an hour", "Won't fill"], "nor does the pattern that won't fill (D32)");
eq(lines(row("2026-10-21", { pace_per_hour: 18.5 })), ["Filling at 19 an hour", "Full by 9:30pm at this pace"], "the pace rounds to a whole number");
eq(lines(row("2026-10-21", { pace_per_hour: "1234.4" as unknown as number })), ["Filling at 1,234 an hour", "Full by 9:30pm at this pace"], "numeric comes back from PostgREST as text and still reads");
eq(lines(row("2026-10-21", { pace_per_hour: 0.2 }))[0], "Filling at 1 an hour", "a pace above 0 never reads as filling at 0 an hour");
// A clock change: 1:30am on Sunday 1 November in New York is said in the office's own zone.
eq(cardPaceLines(fresh([row("2026-11-02", { read_at: "2026-11-01T04:00:00.000Z", estimate_line_at: "2026-11-02T14:00:00.000Z" })]).get("2026-11-02"), 50, Z, "2026-11-01"), ["Filling at 6 an hour", "Full by 9am Mon at this pace"], "after the clocks go back the time is still the office's");

// --- one line, in place of both (D33 to D36) -------------------------------------------------------
eq(lines(row("2026-10-20"), 96), ["Filling at 6 an hour"], "a day at 95% read with no last call estimate (saved before #4190) shows the pace alone");
// From 95%, Full by is the last call (#4190, decision 20): 10pm tonight is 02:00 UTC.
const last = { estimate_line_state: "already", estimate_line_at: null, estimate_pattern_state: "already", estimate_last_line_state: "at", estimate_last_line_at: "2026-10-20T02:00:00.000Z", estimate_last_pattern_state: "wont-fill", estimate_last_method: "line" } as const;
eq(lines(row("2026-10-20", last), 96), ["Filling at 6 an hour", "Full by 10pm at this pace"], "a day at 95% says when its last call goes, at this pace (D48)");
eq(lines(row("2026-10-20", { ...last, estimate_last_method: "pattern", estimate_last_pattern_state: "at", estimate_last_pattern_at: "2026-10-20T03:00:00.000Z" }), 99), ["Filling at 6 an hour", "Full by 11pm"], "by the pattern, with no qualifier");
eq(lines(row("2026-10-20", { ...last, estimate_last_line_state: "wont-fill", estimate_last_line_at: null }), 96), ["Filling at 6 an hour", "Won't fill at this pace"], "a last call the walk never reaches won't fill");
eq(lines(row("2026-10-20", { ...last, estimate_last_line_state: "already", estimate_last_line_at: null }), 96), ["Filling at 6 an hour"], "a last call already gone, read a moment before the card, is the pace alone");
eq(lines(row("2026-10-20", last), 94), ["Filling at 6 an hour"], "under 95% the card reads the 95% estimate, never the last call");
eq(lines(row("2026-10-20"), PACE_ESTIMATE_PCT), ["Filling at 6 an hour"], "95% exactly is already there");
eq(lines(row("2026-10-20"), PACE_ESTIMATE_PCT - 1).length, 2, "94% still shows the estimate");
eq(lines(row("2026-10-20", { estimate_line_state: "already", estimate_line_at: null }), 93), ["Filling at 6 an hour"], "the lane's already, read a moment before the card, is the pace alone too");
eq(lines(row("2026-10-20", { pace_state: "not-filling", pace_per_hour: -0.6 })), ["Won't fill at this pace"], "a pace at or under 0 won't fill (D34, #4190 decision 21)");
eq(lines(row("2026-10-20", { ...last, pace_state: "not-filling", pace_per_hour: -1.6 }), 99), ["Won't fill at this pace"], "nor does a day at 99% that is not filling (D49)");
eq(lines(row("2026-10-22", { pace_state: "no-pace-yet", pace_per_hour: null, estimate_line_state: "no-pace", estimate_line_at: null })), ["Pace shows after 3 hours of readings"], "no pace yet (D35)");
eq(lines(row("2026-10-20", { pace_state: "readings-missed", pace_per_hour: null, pace_back_at: "2026-10-19T22:30:00.000Z", estimate_line_state: "no-pace" })), ["Readings missed, pace back by 6:30pm"], "readings missed, with when the pace returns (D36)");
eq(lines(row("2026-10-20", { pace_state: "readings-missed", pace_per_hour: null, pace_back_at: "2026-10-20T04:30:00.000Z" })), ["Readings missed, pace back by 12:30am Tue"], "a return after midnight says its day");
eq(lines(undefined), ["Pace shows after 3 hours of readings"], "a day the latest run did not read has no pace yet");
eq(lines(row("2026-10-21", { pace_state: null, pace_per_hour: null, estimate_method: null, estimate_line_state: null, estimate_line_at: null })), ["Pace shows after 3 hours of readings"], "a reading the pace was not yet worked out for has no pace yet");
// Coordinator, 2026-10-22: no-capacity shows no estimate (the card already says Nobody counted),
// and no-pace never shows an estimate.
eq(lines(row("2026-10-21", { estimate_line_state: "no-capacity", estimate_line_at: null }), null), ["Filling at 6 an hour"], "a day nobody can be counted on has no estimate line");
eq(lines(row("2026-10-21", { estimate_line_state: "at" }), null), ["Filling at 6 an hour"], "nor an estimate when the card has no percent");
eq(lines(row("2026-10-21", { estimate_line_state: "no-pace", estimate_line_at: null })), ["Filling at 6 an hour"], "no pace to walk with is never an estimate");
eq(lines(row("2026-10-21", { estimate_method: null })), ["Filling at 6 an hour"], "nor is a reading with no method");

// --- the read as a whole: fresh, out of date, or failed (D38, D39) ----------------------------------
{
  const bound = LANE_STALE_BOUNDS_MS["capacity-fill"];
  eq(bound, 90 * 60_000, "the page reads the capacity-fill lane's own stale bound");
  const at = (ms: number) => new Date(ms).toISOString();
  eq(judgePace({ ok: true, rows: [row("2026-10-20", { read_at: at(NOW - bound) })] }, NOW).kind, "fresh", "a reading exactly at the bound is still current");
  eq(judgePace({ ok: true, rows: [row("2026-10-20", { read_at: at(NOW - bound - 1) })] }, NOW), { kind: "stale", sinceMs: NOW - bound - 1 }, "a reading past the bound is out of date, since when it was taken");
  eq(judgePace({ ok: false, err: new Error("down") }, NOW).kind, "failed", "a failed read is said, never drawn as no pace");
  const none = judgePace({ ok: true, rows: [] }, NOW);
  assert(none.kind === "fresh" && none.byDay.size === 0, "no readings at all is launch: every card says the pace is coming");

  // Only the latest run counts: an older reading of a day the latest run left out is not shown.
  const byDay = fresh([
    row("2026-10-20", { read_at: READ }),
    row("2026-10-21", { read_at: "2026-10-19T19:00:00.000Z", pace_state: "not-filling" }),
    row("2026-10-21", { read_at: READ, pace_per_hour: 11 }),
    row("2026-10-22", { read_at: "2026-10-19T19:00:00.000Z" }),
  ]);
  eq([...byDay.keys()].sort(), ["2026-10-20", "2026-10-21"], "the latest run's days, and only those");
  eq(cardPaceLines(byDay.get("2026-10-21"), 50, Z, TODAY)[0], "Filling at 11 an hour", "each day's latest reading wins, whatever order the rows came in");

  // A row the page cannot read refuses the whole read, rather than showing a guess (L50).
  for (const [what, bad] of [
    ["an unknown pace state", { pace_state: "fast" }],
    ["an unknown estimate state", { estimate_line_state: "soon" }],
    ["an unknown method", { estimate_method: "guess" }],
    ["an unreadable pace", { pace_per_hour: "lots" as unknown as number }],
    ["a pace with no number", { pace_per_hour: null }],
    ["an estimate with no time", { estimate_line_at: null }],
    ["an unknown last call state", { estimate_last_line_state: "soon", estimate_last_pattern_state: "at", estimate_last_pattern_at: READ, estimate_last_method: "line" }],
    ["a last call at a time with no time", { estimate_last_line_state: "at", estimate_last_pattern_state: "wont-fill", estimate_last_method: "line" }],
    ["an unknown last call method", { estimate_last_line_state: "wont-fill", estimate_last_pattern_state: "wont-fill", estimate_last_method: "guess" }],
    ["an unreadable estimate time", { estimate_line_at: "soon" }],
    ["readings missed with no return time", { pace_state: "readings-missed", pace_back_at: null }],
    ["an unreadable read_at", { read_at: "later" }],
  ] as const) {
    const v = judgePace({ ok: true, rows: [row("2026-10-21", bad as Partial<PaceRow>)] }, NOW);
    assert(v.kind === "failed", `${what} is refused as a failed read`);
  }
}

finish();
