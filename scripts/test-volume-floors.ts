// The low volume floors fitted to measured traffic (#1956). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-volume-floors.ts
//
// Four things, in order:
//   1. the fit itself, on hand built series where the right answer is known;
//   2. the committed floors are what the committed measurement produces (L422);
//   3. the policy: a person's value replaces the measured one, visibly, per window;
//   4. the REPLAY: the shipped alarm, armed, driven every 5 minutes over the real
//      measured weeks. It must stay quiet through the real Saturdays it was not
//      fitted on, and page inside an injected weekday outage. The numbers it prints
//      are the evidence the PR quotes.
import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import {
  bandLabel,
  fitFloorCells,
  floorsFor,
  hourLabel,
  judgedFloors,
  poissonFloor,
  windowCountsByCell,
  type BookingSeries,
  type FloorPolicy,
  type VolumeBaseline,
} from "../src/lib/monitor/volume-floors.ts";
import { MEASURED_VOLUME_BASELINE } from "../src/lib/monitor/volume-baseline.ts";
import { floorTable } from "../src/lib/admin/volume-floor-table.ts";
import type { BusinessHoursConfig } from "../src/lib/monitor/booking-volume.ts";
import {
  FLOOR_SCOPE,
  baselineFromFixture,
  buildFixture,
  offlineHoursFor,
  renderBaselineModule,
  scopedSeries,
  type VolumeFixture,
} from "./lib/volume-floor-scope.ts";
import { headOf, replayLowVolume, withGap } from "./lib/volume-floor-replay.ts";
import { LOW_PAGES_ON_SLATE } from "../src/lib/monitor/page-volume.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// --- 1. poissonFloor ---
{
  eq(poissonFloor(0, 0.001), 0, "no rate, no floor");
  eq(poissonFloor(3, 0.001), 0, "a rate of 3 cannot carry a floor of 1: P(0) is 5%");
  // P(X < 3 | 20) is about 4e-6 and P(X < 6 | 20) about 7e-5, P(X < 7) about 2.6e-4,
  // P(X < 8) about 7.9e-4, P(X < 9) about 2.1e-3.
  eq(poissonFloor(20, 0.001), 8, "a rate of 20 carries a floor of 8 at one in a thousand");
  assert(poissonFloor(40, 0.001) > poissonFloor(20, 0.001), "a higher rate carries a higher floor");
}

/** A series of `weeks` whole weeks from a Monday midnight in the zone, `perBucket` bookings every bucket. */
function flatSeries(weeks: number, perBucket: (i: number, atMs: number) => number): BookingSeries {
  const startMs = DateTime.fromISO("2026-06-01T00:00", { zone: ZONE }).toMillis(); // a Monday
  const n = (weeks * 7 * DAY) / (5 * MIN);
  return {
    startMs,
    bucketMinutes: 5,
    counts: Array.from({ length: n }, (_, i) => perBucket(i, startMs + i * 5 * MIN)),
  };
}

// --- 1. windowCountsByCell places each tick in the right local hour ---
{
  const s = flatSeries(1, () => 1);
  const cells = windowCountsByCell(s, ZONE, []);
  // Monday 01:00 local is the first hour with a full 120 minute history: ticks at
  // 02:00 onwards. Every tick sees 6 in 30 minutes and 24 in 120.
  eq(cells[0]![1]!.c120.length, 0, "no tick before a full long window of history");
  assert(cells[0]![3]!.c30.every((n) => n === 6), "a 30 minute window holds six 5 minute buckets");
  assert(cells[0]![3]!.c120.every((n) => n === 24), "a 120 minute window holds twenty four");
  eq(cells[2]![14]!.c30.length, 12, "twelve 5 minute ticks land in each hour");

  // Judged in the zone, so a clock change moves which UTC instant is "9am".
  const summer = DateTime.fromISO("2026-07-06T09:00", { zone: ZONE }).toMillis();
  const winter = DateTime.fromISO("2026-12-07T09:00", { zone: ZONE }).toMillis();
  const base = { zone: ZONE } as VolumeBaseline;
  eq(new Date(summer).getUTCHours(), 13, "9am Eastern in July is 13:00 UTC");
  eq(new Date(winter).getUTCHours(), 14, "9am Eastern in December is 14:00 UTC");
  const cellsOf = (b: VolumeBaseline, ms: number) => floorsFor({ baseline: b, override30: null, override120: null }, ms);
  const graded = {
    ...base,
    cells: Array.from({ length: 7 }, () => Array.from({ length: 24 }, (_, h) => ({ floor30: 0, floor120: h, typical120: h }))),
  } as VolumeBaseline;
  eq(cellsOf(graded, summer).hour, 9, "DST: the summer instant reads as the 9am band");
  eq(cellsOf(graded, winter).hour, 9, "DST: the winter instant reads as the 9am band too");
}

// --- 1. fitFloorCells ---
{
  // Steady traffic, 1 booking every 5 minutes, is about 24 a long window.
  const steady = fitFloorCells(flatSeries(8, () => 1), ZONE, []);
  const c = steady[1]![14]!;
  eq(c.typical120, 24, "the typical long window is what the traffic holds");
  assert(c.floor120 > 0 && c.floor120 < 24, `the fitted floor sits below normal and above zero (got ${c.floor120})`);
  eq(c.floor30, poissonFloor(6, 0.001), "the short window's floor is the Poisson guard on a steady 6");

  // One whole week of zero traffic on Tuesdays. With eight weeks the fit leaves it
  // out, so one outage on record does not set the floor for every Tuesday.
  const tuesdayOut = (_i: number, at: number) => {
    const dt = DateTime.fromMillis(at, { zone: ZONE });
    return dt.weekday === 2 && dt.weekNumber === DateTime.fromISO("2026-06-16", { zone: ZONE }).weekNumber ? 0 : 1;
  };
  const withOutage = fitFloorCells(flatSeries(8, tuesdayOut), ZONE, []);
  eq(withOutage[1]![14]!.floor120, c.floor120, "the single worst week is left out of the fit when there are enough weeks");
  // With five weeks there is none to spare, and the outage drags the tail to zero.
  const short = fitFloorCells(flatSeries(5, tuesdayOut), ZONE, []);
  eq(short[1]![14]!.floor120, 0, "with too few weeks every week counts, the outage included");

  // A band with no traffic has no floor, rather than an invented one.
  eq(fitFloorCells(flatSeries(8, () => 0), ZONE, [])[2]![12]!.floor120, 0, "no traffic, no floor");
}

// --- 1. a day the org recorded as closed is not traffic (#2764) ---
//
// A holiday the org keeps in business_hours_exceptions is a day the alarm never
// judges, so a floor fitted with it in is fitted to a day that is not normal: with
// too few weeks to spare one, a single closed Monday drags every Monday to zero.
{
  const closed = "2026-06-15"; // the third Monday of a five week series from June 1
  const shutThatDay = (_i: number, at: number) => (DateTime.fromMillis(at, { zone: ZONE }).toISODate() === closed ? 0 : 1);
  const open = fitFloorCells(flatSeries(5, () => 1), ZONE, []);
  const kept = fitFloorCells(flatSeries(5, shutThatDay), ZONE, []);
  eq(kept[0]![14]!.floor120, 0, "control: a closed Monday left in the fit drags every Monday's floor to zero");
  const excused = fitFloorCells(flatSeries(5, shutThatDay), ZONE, [closed]);
  eq(excused[0]![14], open[0]![14], "a recorded closed day is left out, so every Monday keeps the floor its open days set");
  eq(excused[1]![14], open[1]![14], "and no other weekday moves");

  const cells = windowCountsByCell(flatSeries(5, shutThatDay), ZONE, [closed]);
  eq(cells[0]![14]!.c120.length, 4 * 12, "no sample is taken on the closed day");
  // A window reaching back across midnight into the closed day is part of it too.
  eq(cells[1]![1]!.c120.length, 4 * 12, "the next morning's ticks whose window starts on the closed day are left out");
  eq(cells[1]![2]!.c120.length, 5 * 12, "and the first tick whose window starts after midnight is kept");
  eq(
    windowCountsByCell(flatSeries(5, shutThatDay), ZONE, [])[0]![14]!.c120.length,
    5 * 12,
    "control: with no closed day every Monday is sampled",
  );
}

// --- 2. the committed floors are the committed measurement's ---
const fixture = JSON.parse(readFileSync("scripts/fixtures/calcom-low-bookings.json", "utf8")) as VolumeFixture;
{
  const derived = baselineFromFixture(fixture, FLOOR_SCOPE);
  // Compared with assert rather than eq, so a failure names the fix instead of
  // printing two copies of a hundred line module (L445).
  assert(
    renderBaselineModule(derived) === readFileSync("src/lib/monitor/volume-baseline.ts", "utf8"),
    "src/lib/monitor/volume-baseline.ts is exactly what the committed measurement fits to (run REFIT=1 pnpm measure:volume-floors)",
  );
  assert(
    JSON.stringify(MEASURED_VOLUME_BASELINE) === JSON.stringify(derived),
    "and the module evaluates to that baseline",
  );
  eq(MEASURED_VOLUME_BASELINE.cells.length, 7, "seven weekdays");
  assert(MEASURED_VOLUME_BASELINE.cells.every((d) => d.length === 24), "twenty four hours each");
  // Dan, 2026-09-29 (#2878): the pilot launches on the two pages already wired to
  // Slate, so the floors are those two pages' and not the whole tier's. Fitting the
  // tier while only some pages flip paged 108 to 283 times in two normal weeks of
  // replay; fitting fewer pages than flip is slow and blind.
  const pilotForms = LOW_PAGES_ON_SLATE.map((p) => p.calcomForm);
  const pilotBookings = pilotForms.reduce((s, f) => s + fixture.forms[f]!.reduce((a, v) => a + v, 0), 0);
  eq(MEASURED_VOLUME_BASELINE.bookings, pilotBookings, "the floors count exactly the bookings of the pages Slate carries");
  assert(
    MEASURED_VOLUME_BASELINE.tierShare !== null && MEASURED_VOLUME_BASELINE.tierShare > 0.5 && MEASURED_VOLUME_BASELINE.tierShare < 1,
    `and say they are that share of the Low tier, not all of it (${MEASURED_VOLUME_BASELINE.tierShare})`,
  );
  eq(MEASURED_VOLUME_BASELINE.scope, FLOOR_SCOPE.label, "and name that scope in the words the admin page shows");
  assert(MEASURED_VOLUME_BASELINE.bookings > 1000, "fitted to a real volume of bookings, not a handful");
  // Every page in the tier is kept, so a wider scope can be fitted offline.
  assert(Object.keys(fixture.forms).length >= 2, "the measurement holds every Low page, not only the scoped one");
}

// --- 2. scoping refuses what it cannot answer ---
{
  let refused = "";
  try {
    scopedSeries(fixture, { ...FLOOR_SCOPE, forms: ["A page nobody measured"] });
  } catch (e) {
    refused = (e as Error).message;
  }
  assert(refused.includes("does not hold"), "a scoped page missing from the measurement is refused by name");
  // #2878: a scope naming no page at all (every Low page held off Slate) would fit
  // floors of zero that could never breach and still read as a measurement (L678).
  let empty = "";
  try {
    scopedSeries(fixture, { ...FLOOR_SCOPE, forms: [] });
  } catch (e) {
    empty = (e as Error).message;
  }
  assert(empty.includes("names no page"), `a scope with no pages is refused by name (${empty})`);
  // The whole tier scope reports no share, because it IS the tier.
  const whole = baselineFromFixture(fixture, { ...FLOOR_SCOPE, forms: Object.keys(fixture.forms) });
  eq(whole.tierShare, null, "a scope covering every page is the whole tier");
  const onePage = baselineFromFixture(fixture, { ...FLOOR_SCOPE, forms: [Object.keys(fixture.forms)[0]!] });
  assert(onePage.tierShare !== null && onePage.tierShare < 1, "and one page alone reports its share of the tier");
  assert(whole.bookings > onePage.bookings, "and the tier counts more bookings than one page");

  // buildFixture: only booked responses in the tier, in the bucket they arrived in.
  const s = Date.UTC(2026, 8, 1, 12, 0);
  const built = buildFixture({
    rows: [
      { formName: "P", createdAt: new Date(s + 7 * MIN).toISOString(), tier: "1", booked: true },
      { formName: "P", createdAt: new Date(s + 8 * MIN).toISOString(), tier: "1", booked: false },
      { formName: "P", createdAt: new Date(s + 9 * MIN).toISOString(), tier: "2", booked: true },
      { formName: "P", createdAt: "not a time", tier: "1", booked: true },
      { formName: "Q", createdAt: new Date(s + 20 * MIN).toISOString(), tier: "2", booked: true },
    ],
    tier: "1",
    startMs: s,
    endMs: s + 30 * MIN,
    bucketMinutes: 5,
    zone: ZONE,
    measuredOn: "2026-09-01",
    formNames: [],
    closedDates: ["2026-12-25", "2026-09-01", "2026-08-31"],
  });
  eq(built.forms.P, [0, 1, 0, 0, 0, 0], "one booked Low response, in the second bucket");
  eq(Object.keys(built.forms), ["P"], "a page with no bookings in the tier is not kept");
  // #2764: the org's closed days are recorded WITH the measurement, so a refit from
  // the committed file leaves out exactly the days the fit left out, with no read.
  eq(built.closedDates, ["2026-09-01"], "only the closed days inside the measured span are recorded, in order");

  // The committed measurement spans Labor Day, which production records as closed
  // (`business_hours_exceptions`, read 2026-09-25), so the fit must have left it out.
  assert(fixture.closedDates.includes("2026-09-07"), "the committed measurement records Labor Day as a closed day");
  assert(
    fixture.closedDates.every((d, i, all) => i === 0 || all[i - 1]! < d),
    "its closed days are distinct and in date order, so the file diffs cleanly",
  );
}

// --- 3. the policy ---
{
  const at = DateTime.fromISO("2026-09-22T14:10", { zone: ZONE }).toMillis(); // a Tuesday
  const measured = floorsFor({ baseline: MEASURED_VOLUME_BASELINE, override30: null, override120: null }, at);
  eq(measured.weekday, 2, "Tuesday");
  eq(measured.hour, 14, "the 2pm band");
  eq(measured.floor120, MEASURED_VOLUME_BASELINE.cells[1]![14]!.floor120, "no override: the measured floor");
  assert(measured.override30 === null && measured.override120 === null, "and it says nothing is overridden");

  const one: FloorPolicy = {
    baseline: MEASURED_VOLUME_BASELINE,
    override30: null,
    override120: { value: 11, origin: "stored" },
  };
  const mixed = floorsFor(one, at);
  eq(mixed.floor120, 11, "a stored value replaces the measured long floor");
  eq(mixed.measured120, measured.floor120, "while the measured value it replaced is still reported beside it");
  eq(mixed.floor30, measured.floor30, "and the other window keeps its measured floor");
  assert(mixed.override120 === "stored" && mixed.override30 === null, "an override is per window, with where it was set");

  let threw = false;
  try {
    floorsFor({ baseline: { ...MEASURED_VOLUME_BASELINE, cells: [] }, override30: null, override120: null }, at);
  } catch {
    threw = true;
  }
  assert(threw, "a baseline missing the hour is refused, never read as a floor of zero");
  eq(bandLabel(2, 14), "Tuesdays 2pm to 3pm", "the band as a person says it");
  eq(bandLabel(6, 11), "Saturdays 11am to 12pm", "noon reads as 12pm");
}

// --- 3. what the page and the alert say about a floor ---
{
  const at = DateTime.fromISO("2026-09-22T14:10", { zone: ZONE }).toMillis();
  const plain = judgedFloors(floorsFor({ baseline: MEASURED_VOLUME_BASELINE, override30: null, override120: null }, at));
  eq(plain.basis120, "measured for Tuesdays 2pm to 3pm", "a measured floor names the band it was measured for");
  const set = judgedFloors(
    floorsFor({ baseline: MEASURED_VOLUME_BASELINE, override30: null, override120: { value: 9, origin: "env" } }, at),
  );
  eq(set.floor120, 9, "an override is the floor judged");
  // #1956 review: a deployment value must never be credited to the settings page,
  // which would send the reader to a form that cannot change it (L11).
  eq(set.basis120, "set in the deployment's settings", "an env override says it came from the deployment");
  assert(!set.basis120.includes("alerts settings page"), "and never claims the settings page");
  eq(set.basis30, "measured for Tuesdays 2pm to 3pm", "while the other window stays measured");
  const stored = judgedFloors(
    floorsFor({ baseline: MEASURED_VOLUME_BASELINE, override30: { value: 1, origin: "stored" }, override120: null }, at),
  );
  eq(stored.basis30, "set by hand on the alerts settings page", "a stored override says it came from the settings page");
  assert(stored.basis30 !== set.basis120, "the two origins are worded differently");

  // The page's table: only the org's open days and the hours inside them.
  const week = {
    rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 8 * 60, end_minute: 20 * 60 })),
  };
  const table = floorTable(MEASURED_VOLUME_BASELINE, week);
  eq(table.rows.map((r) => r.label), ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], "Sunday, shut, is not a row");
  eq(table.hours, [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19], "8am to 7pm, the hours the check runs in");
  eq(table.rows[1]!.cells[6]!.floor120, MEASURED_VOLUME_BASELINE.cells[1]![14]!.floor120, "Tuesday 2pm is the baseline's own cell");
  assert(table.shortRows !== null, "the whole tier's 30 minute floor fires at some hour, so it is tabled");
  const quiet = {
    ...MEASURED_VOLUME_BASELINE,
    cells: MEASURED_VOLUME_BASELINE.cells.map((day) => day.map((c) => ({ ...c, floor30: 0 }))),
  };
  eq(floorTable(quiet, week).shortRows, null, "a 30 minute floor of 0 at every judged hour is said once, not tabled");
  // A day with a shorter window shows nothing past it, rather than a floor it never judges.
  const shortSat = floorTable(MEASURED_VOLUME_BASELINE, {
    rules: [...week.rules.slice(0, 5), { weekday: 6, start_minute: 9 * 60, end_minute: 13 * 60 }],
  });
  const sat = shortSat.rows[5]!;
  eq(sat.cells.find((c) => c.hour === 15)!.floor120, null, "Saturday 3pm is outside Saturday's window: nothing shown");
  eq(sat.cells.find((c) => c.hour === 8)!.floor120, null, "and so is 8am");
  assert(sat.cells.find((c) => c.hour === 12)!.floor120 !== null, "while noon, inside it, carries its floor");
  // An unreadable week shows every day and hour rather than nothing (L10).
  const unread = floorTable(MEASURED_VOLUME_BASELINE, null);
  eq(unread.rows.length, 7, "an unreadable week shows all seven days");
  eq(unread.hours.length, 24, "and every hour");
  eq(hourLabel(0), "12am", "midnight reads 12am");
}

// --- 4. the replay ---
//
// The org's stored week, read from production on 2026-09-25 (Monday to Saturday,
// 08:00 to 20:00 Eastern, Sunday closed), with the closed days the measurement
// recorded (#2764), because the live alarm reads both and a replay of it must too.
const HOURS: BusinessHoursConfig = offlineHoursFor(fixture);
{
  // Labor Day, alone: the shipped alarm judges nothing on a recorded closed day,
  // and the same day with the exceptions left out is judged in full (L159).
  const series = scopedSeries(fixture, FLOOR_SCOPE);
  const from = DateTime.fromISO("2026-09-07T00:00", { zone: ZONE }).toMillis();
  const run = (businessHours: BusinessHoursConfig) =>
    replayLowVolume({
      series,
      policy: { baseline: MEASURED_VOLUME_BASELINE, override30: null, override120: null },
      businessHours,
      fromMs: from,
      toMs: from + DAY,
      tickMinutes: 5,
      cooldownMs: 30 * MIN,
    });
  const shut = await run(HOURS);
  eq(shut.checked, 0, "the tier alarm judges no tick of Labor Day, which the org records closed");
  eq(shut.pages.length, 0, "and so pages nothing on it");
  eq((await run({ ...HOURS, exceptions: [] })).checked, 144, "control: without the exception every open tick of it is judged");
}
const COOLDOWN = 30 * MIN; // MONITOR_DEFAULTS.cooldownMs.low_booking_volume
const fmt = (ms: number) => DateTime.fromMillis(ms, { zone: ZONE }).toFormat("ccc d LLL HH:mm");
{
  const series = scopedSeries(fixture, FLOOR_SCOPE);
  const per = fixture.bucketMinutes * MIN;
  const endMs = fixture.startMs + series.counts.length * per;

  // HOLDOUT: fit on everything but the last two weeks, replay those two weeks.
  // The replay is judged on weeks the fit never saw, so a quiet result is not the
  // fit agreeing with itself.
  const holdoutFrom = endMs - 14 * DAY;
  const trainN = series.counts.length - (14 * DAY) / per;
  const trained: VolumeBaseline = {
    ...MEASURED_VOLUME_BASELINE,
    cells: fitFloorCells(headOf(series, trainN), fixture.zone, fixture.closedDates),
  };
  const policy: FloorPolicy = { baseline: trained, override30: null, override120: null };
  const holdout = await replayLowVolume({
    series,
    policy,
    businessHours: HOURS,
    fromMs: holdoutFrom,
    toMs: endMs,
    tickMinutes: 5,
    cooldownMs: COOLDOWN,
  });
  const saturdayPages = holdout.pages.filter((p) => DateTime.fromMillis(p.atMs, { zone: ZONE }).weekday === 6);
  console.log(
    `replay: holdout ${fmt(holdoutFrom)} to ${fmt(endMs)}, ${holdout.checked} ticks judged, ${holdout.pages.length} pages`,
  );
  for (const p of holdout.pages) console.log(`replay:   page at ${fmt(p.atMs)}: ${p.text}`);
  // Twelve open days (two Saturdays among them) of 144 five minute ticks each, so
  // the quiet below is a judgement over every open tick, not an empty window.
  eq(holdout.checked, 12 * 144, "the holdout judged every open tick of two weeks, both Saturdays included");
  eq(saturdayPages.length, 0, "no page through two real Saturdays the fit never saw");
  assert(holdout.pages.length <= 1, `at most one page in two real weeks of normal traffic (${holdout.pages.length})`);

  // The same two weeks against the flat floors this replaces: the reason for the change.
  const flat = await replayLowVolume({
    series,
    policy: {
      baseline: trained,
      override30: { value: 5, origin: "stored" },
      override120: { value: 20, origin: "stored" },
    },
    businessHours: HOURS,
    fromMs: holdoutFrom,
    toMs: endMs,
    tickMinutes: 5,
    cooldownMs: COOLDOWN,
  });
  console.log(`replay: the old flat 5 and 20 floors over the same two weeks: ${flat.pages.length} pages`);
  assert(flat.pages.length > 10 * Math.max(1, holdout.pages.length), "the flat floors page far more over normal traffic");

  // IN SAMPLE, for the record: the committed floors over all nine measured weeks.
  // Not asserted beyond "few": the fit saw these weeks. What it names is worth
  // reading, because a page here is a real afternoon when this page's bookings fell
  // well below every other week's.
  const inSample = await replayLowVolume({
    series,
    policy: { baseline: MEASURED_VOLUME_BASELINE, override30: null, override120: null },
    businessHours: HOURS,
    // From the first tick with a full long window behind it: before that the window
    // reaches back past the start of the measurement and would read as empty.
    fromMs: fixture.startMs + 2 * HOUR,
    toMs: endMs,
    tickMinutes: 5,
    cooldownMs: COOLDOWN,
  });
  console.log(`replay: all nine weeks with the committed floors, ${inSample.checked} ticks judged, ${inSample.pages.length} pages`);
  for (const p of inSample.pages) console.log(`replay:   page at ${fmt(p.atMs)}: ${p.text}`);
  assert(inSample.pages.length <= 9, `at most about one page a week over the measured weeks (${inSample.pages.length})`);
  const onClosed = inSample.pages.filter((p) =>
    fixture.closedDates.includes(DateTime.fromMillis(p.atMs, { zone: ZONE }).toISODate() ?? ""),
  );
  eq(onClosed.length, 0, "no page on a day the org records as closed (#2764)");

  // INJECTED OUTAGE: every weekday in the holdout, nothing booked from 13:00 for
  // 150 minutes. The armed alarm must page inside it.
  const delays: number[] = [];
  for (let d = 0; d < 14; d++) {
    const day = DateTime.fromMillis(holdoutFrom, { zone: ZONE }).startOf("day").plus({ days: d + 1 });
    if (day.weekday > 5 || day.toMillis() >= endMs) continue;
    const gapFrom = day.set({ hour: 13 }).toMillis();
    if (gapFrom + 150 * MIN > endMs) continue;
    const gapped = await replayLowVolume({
      series: withGap(series, gapFrom, gapFrom + 150 * MIN),
      policy,
      businessHours: HOURS,
      fromMs: gapFrom,
      toMs: gapFrom + 150 * MIN,
      tickMinutes: 5,
      cooldownMs: COOLDOWN,
    });
    const first = gapped.pages[0];
    console.log(
      `replay: outage from ${fmt(gapFrom)}: ${first ? `paged after ${(first.atMs - gapFrom) / MIN} minutes` : "NO PAGE"}`,
    );
    assert(first !== undefined, `a weekday outage from ${fmt(gapFrom)} pages inside 150 minutes`);
    if (first) delays.push((first.atMs - gapFrom) / MIN);
  }
  assert(delays.length >= 8, `every holdout weekday was tested (${delays.length})`);

  // The same outage WITHOUT the gap pages nothing: the page came from the gap, not
  // from the afternoon itself (L159).
  const control = await replayLowVolume({
    series,
    policy,
    businessHours: HOURS,
    fromMs: DateTime.fromMillis(holdoutFrom, { zone: ZONE }).startOf("day").plus({ days: 3, hours: 13 }).toMillis(),
    toMs: DateTime.fromMillis(holdoutFrom, { zone: ZONE }).startOf("day").plus({ days: 3, hours: 15, minutes: 30 }).toMillis(),
    tickMinutes: 5,
    cooldownMs: COOLDOWN,
  });
  eq(control.pages.length, 0, "the same afternoon with its real bookings left in pages nothing");
}

finish();
