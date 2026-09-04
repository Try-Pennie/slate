// The org-open judge is asked once per distinct window, not once per slot (#1846).
//
// /admin/availability measured 3.3s and 4.0s in production, with 2.0s and 2.4s of
// that being Worker CPU: the page was WORKING, not waiting. `bucketsOfferingByHour`
// walks 62 bucket_slots rows holding 11,384 slot strings in total, and asked the
// business-hours judge about every single one. Its answer depends only on the
// window (start, end) against a week that is fixed for the request, and the
// comment on that function already noted that "a start time is the SAME time in
// most of the sixty buckets", so the same question was being asked over and over.
//
// THE GUARD IS THE CALL COUNT, not a duration. A duration measures whatever else
// the machine is running (L224); the quantity actually being protected is how many
// times the expensive judge runs (L63).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-org-open-memo.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  memoisedOrgOpen,
  isOrgOpen,
  slotsWithinBusinessHours,
  type BusinessHoursRules,
} from "../src/lib/availability/compute.ts";
import { bucketsOfferingByHour } from "../src/lib/admin/availability-grid.ts";

const ZONE = "America/New_York";
/** Mon to Fri, 08:00 to 20:00, with one date shut and one date opened against it. */
const HOURS: BusinessHoursRules = {
  zone: ZONE,
  rules: [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    start_minute: 8 * 60,
    end_minute: 20 * 60,
  })),
  exceptions: [
    { on_date: "2026-09-07", is_open: false, start_minute: null, end_minute: null, note: "Labor Day" },
    { on_date: "2026-09-12", is_open: true, start_minute: 9 * 60, end_minute: 13 * 60, note: "Saturday clinic" },
  ],
};

/** A judge that records every window it was asked about. */
function counting() {
  const asked: string[] = [];
  const judge = (startMs: number, endMs: number) => {
    asked.push(`${startMs}:${endMs}`);
    return isOrgOpen(HOURS, startMs, endMs);
  };
  return { judge, asked };
}

// --- the memo asks once per distinct window ---------------------------------
{
  const { judge, asked } = counting();
  const memo = memoisedOrgOpen(judge);
  const t = Date.parse("2026-09-08T14:00:00Z");
  for (let i = 0; i < 50; i++) memo(t, t + 30 * 60_000);
  eq(asked.length, 1, "fifty identical questions reach the judge once");

  memo(t, t + 60 * 60_000);
  eq(asked.length, 2, "a different DURATION is a different question");
  memo(t + 60_000, t + 30 * 60_000);
  eq(asked.length, 3, "and so is a different start");
}

// --- and it answers the same as asking every time ----------------------------
//
// The half that matters. A memo keyed on too little would be fast and wrong, and
// the two cases that would catch it are the ones a uniform fixture never has: a
// date the org has closed against its weekly pattern, and a window that starts
// inside the day but runs past the close.
{
  const memo = memoisedOrgOpen((s, e) => isOrgOpen(HOURS, s, e));
  const cases: [string, number, number][] = [];
  for (const day of ["2026-09-07", "2026-09-08", "2026-09-11", "2026-09-12", "2026-09-13"]) {
    for (const hour of [7, 8, 9, 12, 13, 19, 20]) {
      for (const dur of [30, 60, 120]) {
        const start = Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00-04:00`);
        cases.push([`${day} ${hour}:00 +${dur}m`, start, start + dur * 60_000]);
      }
    }
  }
  assert(cases.length > 90, `a real spread of cases (${cases.length})`);
  const disagreements = cases.filter(([, s, e]) => memo(s, e) !== isOrgOpen(HOURS, s, e));
  eq(disagreements.map((c) => c[0]).join(", "), "", "the memo agrees with the judge on every case");

  // Positive control: those cases must not be all-true or all-false, or agreeing
  // proves nothing (L1). The closed holiday and the past-close windows are what
  // make the mix.
  const open = cases.filter(([, s, e]) => isOrgOpen(HOURS, s, e)).length;
  assert(open > 0 && open < cases.length, `the fixture mixes open and closed (${open} of ${cases.length} open)`);
}

// --- the grid asks once per distinct window across ALL buckets ---------------
{
  const day = "2026-09-08";
  // Sixty buckets offering the SAME twenty start times, which is the real shape:
  // a start time is the same instant in most of the sixty buckets.
  const starts = Array.from({ length: 20 }, (_, i) =>
    new Date(Date.parse(`${day}T09:00:00-04:00`) + i * 15 * 60_000).toISOString(),
  );
  const rows = Array.from({ length: 60 }, () => ({
    payload: { slots: starts, eventType: { duration_min: 30 } },
  }));
  const totalSlots = rows.length * starts.length;
  eq(totalSlots, 1200, "the fixture really holds 1200 slot strings");

  const { judge, asked } = counting();
  bucketsOfferingByHour(rows, HOURS, ZONE, memoisedOrgOpen(judge));

  eq(asked.length, starts.length, "the judge is asked once per distinct window, not once per slot");
  assert(
    asked.length < totalSlots / 10,
    `which is far fewer than the slot count (${asked.length} against ${totalSlots})`,
  );
  eq(new Set(asked).size, asked.length, "and never asked the same window twice");
}

// --- the grid's counts are unchanged by any of this --------------------------
{
  const day = "2026-09-08";
  const starts = ["09:00", "09:30", "10:00", "19:30", "21:00"].map(
    (t) => new Date(Date.parse(`${day}T${t}:00-04:00`)).toISOString(),
  );
  const rows = [
    { payload: { slots: starts, eventType: { duration_min: 30 } } },
    { payload: { slots: starts, eventType: { duration_min: 60 } } },
    { payload: { slots: null } },
    { payload: { slots: starts, eventType: {} } },
  ] as Parameters<typeof bucketsOfferingByHour>[0];

  const withMemo = bucketsOfferingByHour(rows, HOURS, ZONE, memoisedOrgOpen((s, e) => isOrgOpen(HOURS, s, e)));
  const withoutMemo = bucketsOfferingByHour(rows, HOURS, ZONE, (s, e) => isOrgOpen(HOURS, s, e));

  eq(
    JSON.stringify([...withMemo].sort()),
    JSON.stringify([...withoutMemo].sort()),
    "memoised and unmemoised produce an identical map",
  );
  assert(withMemo.size > 0, `and it is not an empty map either way (${withMemo.size} day-hours)`);

  // 21:00 is past the 20:00 close and 19:30 + 60m runs past it, so both must be
  // absent. This is what a memo keyed on the hour alone would get wrong.
  const keys = [...withMemo.keys()].join(" ");
  assert(!keys.includes(`${day}:21`), "a start past the close is not counted");
  assert(keys.includes(`${day}:9`), "and a start inside the window is");
}

// --- the default is still to ask directly, so no caller had to change --------
{
  const t = Date.parse("2026-09-08T14:00:00Z");
  eq(
    slotsWithinBusinessHours([new Date(t).toISOString()], 30, HOURS).length,
    isOrgOpen(HOURS, t, t + 30 * 60_000) ? 1 : 0,
    "slotsWithinBusinessHours with no judge behaves exactly as before",
  );
}

finish();
