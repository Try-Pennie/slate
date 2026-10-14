// #2806: the faster slot walk offers EXACTLY the times the old one did.
//
// `computeBucketSlots` stopped asking Luxon about every candidate start: it steps
// the grid in plain milliseconds and hands `bookableSlotReason` the facts it has
// already worked out about the agent's local day, so a 7 day window for an 80
// member pool no longer pays a zone conversion per slot per agent. That is a
// change to the hottest pure function in availability, and the only acceptable
// outcome is that no lead is ever offered a different time because of it.
//
// So this suite runs the new walk and the pre-#2806 walk (scripts/lib/
// slot-walk-reference.ts, kept as the oracle) over a few hundred generated pools and
// requires the offered lists to be IDENTICAL strings, not similar ones. The corpus
// is aimed at where a millisecond walk could go wrong rather than at the average
// day: windows across every clock change the roster's zones see in a year, the
// weeks when the US has changed and Europe has not, zones that change AT midnight or
// by half an hour, an org in another zone than the agent, date exceptions, ragged
// window bounds, a "now" inside the window, caps at and over their limit, and rules
// a form would never write.
//
// A corpus that never reaches those cases would agree with anything (L98), so the
// last section re-introduces the plausible mistakes one at a time and requires each
// to be CAUGHT. It also prints how many fixtures offered anything at all, because a
// comparison of two empty lists proves nothing.
//
// Run: node --experimental-strip-types scripts/test-slot-walk-equivalence.ts
import { DateTime } from "luxon";
import {
  computeBucketSlots,
  freeMembersForSlot,
  isOrgOpen,
  orgOpenByDay,
} from "../src/lib/availability/compute.ts";
import type { BusinessHoursRules, SlotComputeInput } from "../src/lib/availability/compute.ts";
import type { BusinessHoursException } from "../src/lib/booking/business-hours.ts";
import { assert, finish } from "./lib/harness.ts";
import {
  AWKWARD_ZONES,
  ROSTER_ZONES,
  buildFixture,
  rng,
  seededBusinessHours,
  type FixtureOptions,
} from "./lib/slot-compute-fixtures.ts";
import {
  referenceBucketSlots,
  referenceFreeMembersForSlot,
  type WalkFaults,
} from "./lib/slot-walk-reference.ts";

// Window starts, as org local dates, chosen for the clock changes they straddle.
const START_DATES = [
  "2026-03-07", // US spring forward (Sun Mar 8), Havana's at midnight that night
  "2026-03-16", // US changed, UK and Europe not yet (Mar 29)
  "2026-03-28", // Europe springs forward, Beirut at midnight (Sun Mar 29)
  "2026-04-04", // Santiago falls back at 24:00, Lord Howe's half hour, Sydney (Apr 5)
  "2026-04-23", // Cairo springs forward at midnight (last Friday of April)
  "2026-08-10", // an ordinary summer week
  "2026-09-05", // Santiago springs forward at midnight (Sep 6)
  "2026-10-03", // Lord Howe and Sydney spring forward (Oct 4)
  "2026-10-24", // Europe falls back (Oct 25), Beirut at midnight, the US not yet
  "2026-10-29", // Cairo falls back at 24:00 (last Thursday of October)
  "2026-10-31", // US falls back (Sun Nov 1), Havana's at 01:00
  "2026-12-31", // a year roll
  "2027-03-13", // the following spring forward, from the other side of the year
];

const ORG_ZONES = ["America/New_York", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Europe/London"];

function businessHoursFor(r: () => number, fromDate: string): BusinessHoursRules {
  const zone = ORG_ZONES[Math.floor(r() * ORG_ZONES.length)]!;
  const base = seededBusinessHours();
  const roll = r();
  // Every day open round the clock, so night shifts in far zones reach the agent gate.
  const rules =
    roll < 0.25
      ? [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 }))
      : roll < 0.4
        ? [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start_minute: 540, end_minute: 1020 }))
        : base.rules;
  const exceptions: BusinessHoursException[] = [];
  if (r() < 0.4) {
    const day = DateTime.fromISO(fromDate, { zone }).plus({ days: Math.floor(r() * 3) });
    const kind = r();
    exceptions.push({
      on_date: day.toISODate()!,
      is_open: kind >= 0.34,
      start_minute: kind < 0.34 ? null : kind < 0.67 ? 600 : 0,
      end_minute: kind < 0.34 ? null : kind < 0.67 ? 905 : 1440,
      note: "generated",
    });
  }
  return { zone, rules, exceptions };
}

function optionsFor(seed: number): FixtureOptions {
  const r = rng(seed * 7919 + 13);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const fromDate = pick(START_DATES);
  const zonesRoll = r();
  return {
    members: 3 + Math.floor(r() * 4),
    zones: zonesRoll < 0.45 ? ROSTER_ZONES : zonesRoll < 0.8 ? AWKWARD_ZONES : [...ROSTER_ZONES, ...AWKWARD_ZONES],
    fromDate,
    days: 2 + Math.floor(r() * 2),
    busyPerDay: pick([0, 2, 5, 9]),
    durationMin: pick([15, 20, 20, 30, 45, 60]),
    slotIntervalMin: pick([5, 10, 10, 15, 20, 30]),
    bufferBeforeMin: pick([0, 0, 5, 10, 15]),
    bufferAfterMin: pick([0, 5, 10, 10, 30]),
    minNoticeMin: pick([0, 120, 120, 1440]),
    dailyCap: pick([null, null, 1, 2, 3, 12]),
    nowLeadMin: pick([60, 60, -300, -2000]),
    oddRules: r() < 0.5,
    everyDayShare: pick([0, 0.5, 1]),
    derivedCountShare: pick([0, 0.3, 1]),
    businessHours: businessHoursFor(r, fromDate),
    bounds: pick(["midnight", "end-of-day", "ragged"] as const),
  };
}

const FIXTURES = 220;
const corpus: SlotComputeInput[] = [];
for (let seed = 1; seed <= FIXTURES; seed++) corpus.push(buildFixture(seed, optionsFor(seed)));

/** The oracle's answer per fixture, computed once and reused by the controls. */
const baseline: string[][] = [];

// --- 1. The offered list is the same string list on every fixture -------------------
{
  let mismatched = 0;
  let nonEmpty = 0;
  let offered = 0;
  let oracleMs = 0;
  let walkMs = 0;
  for (let i = 0; i < corpus.length; i++) {
    const input = corpus[i]!;
    const a = performance.now();
    const expected = referenceBucketSlots(input);
    const b = performance.now();
    baseline.push(expected);
    const actual = computeBucketSlots(input);
    oracleMs += b - a;
    walkMs += performance.now() - b;
    if (expected.length > 0) nonEmpty++;
    offered += expected.length;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      mismatched++;
      if (mismatched <= 3) {
        const extra = actual.filter((s) => !expected.includes(s)).slice(0, 3);
        const missing = expected.filter((s) => !actual.includes(s)).slice(0, 3);
        console.error(
          `  seed ${i + 1}: ${actual.length} offered vs ${expected.length}; extra ${extra.join(",") || "none"}; missing ${missing.join(",") || "none"}`,
        );
      }
    }
  }
  console.log(`  ${corpus.length} fixtures, ${nonEmpty} offering at least one time, ${offered} times in all`);
  console.log(`  oracle ${Math.round(oracleMs)}ms, walk ${Math.round(walkMs)}ms over the corpus`);
  assert(mismatched === 0, `every fixture offers byte identical times to the pre-#2806 walk (${mismatched} differ)`);
  // A corpus that mostly offers nothing compares empty lists (L98).
  assert(nonEmpty >= corpus.length * 0.6, `most fixtures offer something (${nonEmpty} of ${corpus.length})`);
}

// --- 2. Who is free for a given instant agrees too --------------------------------
{
  let mismatched = 0;
  let asked = 0;
  for (let i = 0; i < corpus.length; i += 4) {
    const input = corpus[i]!;
    const { members, from: _from, to: _to, ...rest } = input;
    const r = rng(i + 101);
    const offered = referenceBucketSlots(input).map((s) => Date.parse(s));
    const fromMs = Date.parse(input.from);
    const candidates = [
      ...offered.filter(() => r() < 0.15).slice(0, 6),
      // Instants on and off the grid, offered or not.
      ...Array.from({ length: 4 }, () => fromMs + Math.floor(r() * 48 * 12) * 5 * 60_000),
    ];
    for (const startMs of candidates) {
      asked++;
      const expected = referenceFreeMembersForSlot(members, rest, startMs);
      const actual = freeMembersForSlot(members, rest, startMs);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatched++;
    }
  }
  assert(asked > 300, `asked who is free at enough instants (${asked})`);
  assert(mismatched === 0, `freeMembersForSlot agrees with the pre-#2806 walk at every instant (${mismatched} differ)`);
}

// --- 3. The org judge agrees with `isOrgOpen` instant by instant ------------------
//
// `orgOpenByDay` answers gate 1 inside the walk, so it is held against the one judge
// directly too, across every start date above, in org zones whose clocks change at
// 02:00, at midnight and by half an hour, with date exceptions on a change day.
{
  const zones = ["America/New_York", "Europe/London", "America/Santiago", "America/Havana", "Australia/Lord_Howe"];
  let asked = 0;
  let mismatched = 0;
  let open = 0;
  for (const zone of zones) {
    for (const date of START_DATES) {
      const day = DateTime.fromISO(date, { zone });
      const hours: BusinessHoursRules = {
        zone,
        rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          start_minute: weekday === 7 ? 0 : 60,
          end_minute: weekday === 6 ? 1440 : 1350,
        })),
        exceptions: [
          { on_date: day.plus({ days: 1 }).toISODate()!, is_open: true, start_minute: 30, end_minute: 1440, note: null },
          { on_date: day.plus({ days: 2 }).toISODate()!, is_open: false, start_minute: null, end_minute: null, note: null },
        ],
      };
      const judge = orgOpenByDay(hours);
      const fromMs = day.minus({ days: 1 }).toMillis();
      for (let t = fromMs; t < fromMs + 4 * 86_400_000; t += 15 * 60_000) {
        for (const durMin of [20, 90]) {
          asked++;
          const expected = isOrgOpen(hours, t, t + durMin * 60_000);
          if (expected) open++;
          if (judge(t, t + durMin * 60_000) !== expected) mismatched++;
        }
      }
    }
  }
  assert(open > 0 && open < asked, `the org judge saw both verdicts (${open} open of ${asked})`);
  assert(mismatched === 0, `orgOpenByDay agrees with isOrgOpen at every instant (${mismatched} of ${asked} differ)`);
}

// --- 4. The corpus catches each plausible mistake (positive controls, L1) ---------
{
  // Stops at the first fixture that catches the fault: one is the proof, and the
  // oracle is the slow walk, so scanning the whole corpus per fault would cost the
  // suite several seconds for nothing.
  const firstCatch = (faults: WalkFaults): number =>
    corpus.findIndex((input, i) => JSON.stringify(referenceBucketSlots(input, faults)) !== JSON.stringify(baseline[i]));

  const dst = firstCatch({ durationAddWindows: true });
  assert(dst >= 0, `a walk adding shift minutes as a duration (wrong on clock change days) is caught (seed ${dst + 1})`);
  const utc = firstCatch({ capDayInUtc: true });
  assert(utc >= 0, `a walk counting the daily cap on the UTC date is caught (seed ${utc + 1})`);
  const orgZone = firstCatch({ shiftInOrgZone: true });
  assert(orgZone >= 0, `a walk judging the shift in the org's zone is caught (seed ${orgZone + 1})`);
  const lastStart = firstCatch({ dropLastFittingStart: true });
  assert(lastStart >= 0, `a walk losing the last start that fits a shift is caught (seed ${lastStart + 1})`);
}

finish();
