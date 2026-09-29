// Phase 2 of #1956: learning the low volume floors from Slate's own bookings.
// Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-volume-learning.ts
//
// Slate has no real traffic yet, so every case here is a fixture: synthetic
// bookings with a known rate, placed so each of the three traps the issue names
// (the ramp, test bookings, a slow decline) is exercised in isolation, each with a
// control showing the same input WITHOUT the trap learns normally (L159).
import { DateTime } from "luxon";
import { learnFloors, LEARNING, type SlateBookingRow } from "../src/lib/monitor/volume-learning.ts";
import type { FloorCell, VolumeBaseline } from "../src/lib/monitor/volume-floors.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ZONE = "America/New_York";
const MIN = 60_000;
const WEEK = 7 * 24 * 60 * MIN;

/** A flat anchor: every cell's floors set to the given pair. */
function anchor(floor30: number, floor120: number): VolumeBaseline {
  return {
    source: "calcom",
    measuredOn: "2026-09-25",
    fromDate: "2026-07-24",
    toDate: "2026-09-25",
    zone: ZONE,
    scope: "a fixture",
    tierShare: 0.5,
    bookings: 1,
    cells: Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, (): FloorCell => ({ floor30, floor120, typical120: floor120 * 3 })),
    ),
  };
}

const RAMP_END = DateTime.fromISO("2026-11-02T00:00", { zone: ZONE }).toMillis(); // a Monday
const NOW = RAMP_END + 8 * WEEK;

/** One booking every `everyMin` minutes over [from, to), rate scaled by `scale(atMs)`. */
function bookings(from: number, to: number, everyMin: number, scale: (at: number) => number = () => 1): SlateBookingRow[] {
  const out: SlateBookingRow[] = [];
  let carry = 0;
  for (let t = from; t < to; t += everyMin * MIN) {
    carry += scale(t);
    while (carry >= 1) {
      out.push({ createdAtMs: t, isTest: false });
      carry -= 1;
    }
  }
  return out;
}

const cell = (b: VolumeBaseline, weekday: number, hour: number) => b.cells[weekday - 1]![hour]!;

// --- nothing is learned until a person declares the ramp over ---
{
  const out = learnFloors({ bookings: bookings(RAMP_END, NOW, 5), rampEndMs: null, nowMs: NOW, anchor: anchor(0, 4), closedDates: [] });
  eq(out.status, "not-started", "no declared ramp end, nothing learned, however much traffic there is");
}

// --- control: steady full traffic after the ramp is learned ---
const steady = bookings(RAMP_END, NOW, 5);
const control = learnFloors({ bookings: steady, rampEndMs: RAMP_END, nowMs: NOW, anchor: anchor(0, 4), closedDates: [] });
{
  eq(control.status, "learned", "eight weeks of steady traffic is learned");
  if (control.status === "learned") {
    eq(control.baseline.source, "slate", "and the baseline says where it came from");
    assert(cell(control.baseline, 2, 14).floor120 > 4, "a Slate carrying full traffic learns a floor above the one page anchor");
    eq(control.excludedTest, 0, "nothing excluded as test");
    eq(control.excludedRamp, 0, "nothing excluded as ramp");
  }
}

// --- too little post ramp history ---
{
  const soon = RAMP_END + 3 * WEEK;
  const out = learnFloors({ bookings: bookings(RAMP_END, soon, 5), rampEndMs: RAMP_END, nowMs: soon, anchor: anchor(0, 4), closedDates: [] });
  eq(out.status, "insufficient", `fewer than ${LEARNING.minWeeks} weeks after the ramp is not enough`);
}

// --- trap 1: the ramp is excluded explicitly ---
{
  // Eight weeks of ramp at a tenth of the rate, then the declared end, then four
  // weeks of full traffic. Learning must see only the four.
  const rampStart = RAMP_END - 8 * WEEK;
  const early = RAMP_END + 4 * WEEK;
  const ramp = bookings(rampStart, RAMP_END, 50);
  const full = bookings(RAMP_END, early, 5);
  const out = learnFloors({ bookings: [...ramp, ...full], rampEndMs: RAMP_END, nowMs: early, anchor: anchor(0, 0), closedDates: [] });
  const onlyFull = learnFloors({ bookings: full, rampEndMs: RAMP_END, nowMs: early, anchor: anchor(0, 0), closedDates: [] });
  eq(out.status, "learned", "four whole weeks after the ramp is learned");
  if (out.status === "learned" && onlyFull.status === "learned") {
    eq(out.excludedRamp, ramp.length, "every ramp booking is excluded and counted");
    assert(
      JSON.stringify(out.baseline.cells) === JSON.stringify(onlyFull.baseline.cells),
      "the ramp's low traffic changes no learned floor",
    );
  }
}

// --- trap 2: test bookings are not traffic ---
{
  // A smoke run every minute, all day, every day: many times the real rate.
  const smoke = bookings(RAMP_END, NOW, 1).map((b) => ({ ...b, isTest: true }));
  const out = learnFloors({ bookings: [...steady, ...smoke], rampEndMs: RAMP_END, nowMs: NOW, anchor: anchor(0, 4), closedDates: [] });
  eq(out.status, "learned", "test bookings do not stop learning");
  if (out.status === "learned" && control.status === "learned") {
    eq(out.excludedTest, smoke.length, "every test booking is excluded and counted");
    assert(JSON.stringify(out.baseline.cells) === JSON.stringify(control.baseline.cells), "and they change no floor");
  }
}

// --- trap 3a: a clear recent decline is reported and not learned ---
{
  const split = NOW - LEARNING.recentWeeks * WEEK;
  const halved = bookings(RAMP_END, NOW, 5, (at) => (at >= split ? 0.5 : 1));
  const out = learnFloors({ bookings: halved, rampEndMs: RAMP_END, nowMs: NOW, anchor: anchor(0, 4), closedDates: [] });
  eq(out.status, "declining", "the last two weeks at half the earlier rate is a decline");
  if (out.status === "declining" && control.status === "learned") {
    assert(out.recentPerWeek < out.earlierPerWeek * 0.6, "and it reports both rates");
    assert(
      cell(out.baseline, 2, 14).floor120 >= cell(control.baseline, 2, 14).floor120 - 1,
      "the floors come from the weeks before the decline, not from the decline",
    );
  }
}

// --- a closed week is not a decline, and not traffic (#2764) ---
{
  // Christmas week shut Monday to Friday, inside the two recent weeks. The alarm
  // never judges those days, so learning must neither read their silence as a
  // decline nor fit a floor to it.
  const closed = ["2026-12-21", "2026-12-22", "2026-12-23", "2026-12-24", "2026-12-25"];
  const isClosed = (at: number) => closed.includes(DateTime.fromMillis(at, { zone: ZONE }).toISODate() ?? "");
  const shut = bookings(RAMP_END, NOW, 5, (at) => (isClosed(at) ? 0 : 1));
  const unexcused = learnFloors({ bookings: shut, rampEndMs: RAMP_END, nowMs: NOW, anchor: anchor(0, 4), closedDates: [] });
  eq(unexcused.status, "declining", "control: the shut week read as traffic looks like a decline");
  const out = learnFloors({ bookings: shut, rampEndMs: RAMP_END, nowMs: NOW, anchor: anchor(0, 4), closedDates: closed });
  eq(out.status, "learned", "with the week recorded closed, the recent weeks are compared on their open days only");
  if (out.status === "learned" && control.status === "learned") {
    assert(
      JSON.stringify(out.baseline.cells) === JSON.stringify(control.baseline.cells),
      "and the floors are the ones steady traffic learns: the shut days are left out of the fit",
    );
  }
  // A booking made on a closed day (a lead booking ahead) is not the day's traffic either.
  const stray = learnFloors({
    bookings: [...shut, ...bookings(Date.parse("2026-12-22T15:00:00Z"), Date.parse("2026-12-22T17:00:00Z"), 5)],
    rampEndMs: RAMP_END,
    nowMs: NOW,
    anchor: anchor(0, 4),
    closedDates: closed,
  });
  assert(
    stray.status === "learned" && JSON.stringify(stray.baseline.cells) === JSON.stringify(control.baseline.cells),
    "bookings on a closed day change no floor",
  );
}

// --- trap 3b: a decline too slow for the comparison still meets the anchor ---
{
  // Three percent fewer bookings every week: no two week window is 20% below the
  // six before it, so the comparison stays quiet, and a floor that followed volume
  // would sink with it. The anchor holds it up.
  const slow = bookings(RAMP_END, NOW, 5, (at) => Math.pow(0.97, Math.floor((at - RAMP_END) / WEEK)));
  const high = anchor(1, 20);
  const out = learnFloors({ bookings: slow, rampEndMs: RAMP_END, nowMs: NOW, anchor: high, closedDates: [] });
  eq(out.status, "learned", "a slow enough decline passes the comparison");
  if (out.status === "learned") {
    const everyCellHeld = out.baseline.cells.every((day) => day.every((c) => c.floor120 >= 20 && c.floor30 >= 1));
    assert(everyCellHeld, "and every learned floor stays at or above the measured anchor");
  }
  // Control: the same slow decline with no anchor to hold it learns something lower.
  const unheld = learnFloors({ bookings: slow, rampEndMs: RAMP_END, nowMs: NOW, anchor: anchor(0, 0), closedDates: [] });
  if (unheld.status === "learned") {
    assert(cell(unheld.baseline, 2, 14).floor120 < 20, "without the anchor the same traffic would have learned a lower floor");
  }
}

// --- #2874: a tier nobody has measured learns with no anchor under it ---
{
  // No cal.com measurement exists for the tier, so there is no floor under the
  // learned floor: what its own traffic fits is what it gets, judged in the zone it
  // is given, and scoped in the words it is given.
  const out = learnFloors({
    bookings: steady,
    rampEndMs: RAMP_END,
    nowMs: NOW,
    anchor: null,
    zone: ZONE,
    scope: "Every real Medium booking",
    closedDates: [],
  });
  const zeroAnchor = learnFloors({ bookings: steady, rampEndMs: RAMP_END, nowMs: NOW, anchor: anchor(0, 0), closedDates: [] });
  eq(out.status, "learned", "an unanchored tier learns from its own traffic");
  if (out.status === "learned" && zeroAnchor.status === "learned") {
    assert(JSON.stringify(out.baseline.cells) === JSON.stringify(zeroAnchor.baseline.cells), "exactly what an anchor of zeros would leave");
    eq(out.baseline.zone, ZONE, "judged in the zone it was given");
    eq(out.baseline.scope, "Every real Medium booking", "and scoped in the words it was given");
  }
  let threw = false;
  try {
    learnFloors({ bookings: steady, rampEndMs: RAMP_END, nowMs: NOW, anchor: null, closedDates: [] });
  } catch {
    threw = true;
  }
  assert(threw, "with neither an anchor nor a zone there is no week to judge in, so it refuses");
}

finish();
