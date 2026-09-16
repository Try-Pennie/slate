// Tests for the Cal.com date-override derivation (#2417).
// Run: node --experimental-strip-types scripts/test-ooo-calcom-overrides.ts
//
// The assertions below are written against WHAT CAL.COM WILL OFFER, not against
// the override rows, because cal.com reads a date's overrides ADDITIVELY: two
// correct-looking rows on one date union into a day neither of them describes.
// That union is the whole of #2417, and a test keyed on rows cannot see it.
import {
  datesCoveredBy,
  recomputeOverrides,
  type AbsenceWindow,
  type CalcomAvailabilityRule,
  type DateOverride,
} from "../src/lib/calcom/overrides.ts";

import { assert, eq, finish } from "./lib/harness.ts";

const TZ = "America/New_York";
// Mon-Fri 9-5 in two of Cal.com's encodings: day names and Sunday=0 numbers.
const weekdaysByName: CalcomAvailabilityRule[] = [
  { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], startTime: "09:00", endTime: "17:00" },
];
const weekdaysByNumber: CalcomAvailabilityRule[] = [
  { days: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "17:00" },
];

const win = (startIso: string, endIso: string): AbsenceWindow => ({ startIso, endIso });

/**
 * Everything the derivation produces for one absence's dates, from the given
 * window set, starting from whatever cal.com already holds.
 */
function rewrite(
  own: AbsenceWindow,
  others: AbsenceWindow[],
  opts: {
    mode?: "add" | "remove";
    existing?: DateOverride[];
    availability?: CalcomAvailabilityRule[];
    tz?: string;
  } = {},
): { overrides: DateOverride[]; replaced: number } {
  const tz = opts.tz ?? TZ;
  const dates = datesCoveredBy(own.startIso, own.endIso, tz);
  if (dates === null) throw new Error("datesCoveredBy refused a window this test meant to be readable");
  const windows = (opts.mode ?? "add") === "add" ? [...others, own] : [...others];
  const result = recomputeOverrides({
    existing: opts.existing ?? [],
    dates,
    windows,
    scheduleTz: tz,
    availability: "availability" in opts ? opts.availability : weekdaysByName,
  });
  if (!result.ok) throw new Error(`recompute refused: ${result.reason}`);
  return { overrides: result.overrides, replaced: result.replaced };
}

const min = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/**
 * What cal.com offers on `date`: the UNION of that date's overrides, or the
 * normal working week when the date carries none.
 *
 * `null` is "nothing at all" (the date carries an override that offers no time),
 * and `"week"` is "no override, use the normal week". Keeping those two apart is
 * the point: an empty override list for a fully covered day is the fail-open
 * case, and it renders identically to a correct block if you only count rows.
 */
function offeredOn(
  overrides: DateOverride[],
  date: string,
): [number, number][] | null | "week" {
  const onDate = overrides.filter((o) => o.date === date);
  if (onDate.length === 0) return "week";
  const spans = onDate
    .map((o) => [min(o.startTime), min(o.endTime)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  if (spans.length === 0) return null;
  const merged: [number, number][] = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

const show = (o: ReturnType<typeof offeredOn>): string => {
  if (o === "week") return "the normal week";
  if (o === null) return "nothing";
  const pad = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return o.map(([s, e]) => `${pad(s)}-${pad(e)}`).join(" + ");
};

function offers(
  overrides: DateOverride[],
  date: string,
  expected: [string, string][] | null | "week",
  msg: string,
): void {
  const actual = offeredOn(overrides, date);
  const want =
    Array.isArray(expected) ? expected.map(([s, e]) => [min(s), min(e)] as [number, number]) : expected;
  assert(
    JSON.stringify(actual) === JSON.stringify(want),
    `${msg} (expected ${show(want)}, got ${show(actual)})`,
  );
}

// ===========================================================================
// #2417: two partial-day absences on one date
// ===========================================================================
// 2026-07-01 is a Wednesday. 09:00 ET = 13:00Z, 12:00 ET = 16:00Z,
// 13:00 ET = 17:00Z, 17:00 ET = 21:00Z.
const A = win("2026-07-01T13:00:00Z", "2026-07-01T16:00:00Z"); // absent 09:00-12:00
const B = win("2026-07-01T17:00:00Z", "2026-07-01T21:00:00Z"); // absent 13:00-17:00

{
  // Approve A, then approve B. Under the per-request merge this file replaced,
  // A wrote "available 12:00-17:00" and B wrote "available 09:00-13:00", whose
  // additive union is 09:00-17:00: the whole working day, through both absences.
  const afterA = rewrite(A, []);
  offers(afterA.overrides, "2026-07-01", [["12:00", "17:00"]], "A alone leaves the afternoon");

  const afterB = rewrite(B, [A], { existing: afterA.overrides });
  offers(
    afterB.overrides,
    "2026-07-01",
    [["12:00", "13:00"]],
    "two partial absences leave only the hour between them",
  );
}

{
  // Cancelling A leaves everything except B's window, and it is recomputed, not
  // key-subtracted: the answer has to come from B alone.
  const stored = rewrite(B, [A], { existing: rewrite(A, []).overrides }).overrides;
  const afterCancel = rewrite(A, [B], { mode: "remove", existing: stored });
  offers(
    afterCancel.overrides,
    "2026-07-01",
    [["09:00", "13:00"]],
    "cancelling the morning absence gives back 09:00 to 13:00",
  );
  assert(afterCancel.replaced > 0, "cancelling replaced the overrides that were there");
}

{
  // Three absences is where a key-subtracting removal is visibly wrong: dropping
  // one request's inverse leaves the other two's inverses, which still union to
  // the whole day.
  const one = win("2026-07-01T13:00:00Z", "2026-07-01T15:00:00Z"); // 09:00-11:00
  const two = win("2026-07-01T16:00:00Z", "2026-07-01T18:00:00Z"); // 12:00-14:00
  const three = win("2026-07-01T19:00:00Z", "2026-07-01T21:00:00Z"); // 15:00-17:00
  let stored = rewrite(one, []).overrides;
  stored = rewrite(two, [one], { existing: stored }).overrides;
  stored = rewrite(three, [one, two], { existing: stored }).overrides;
  offers(
    stored,
    "2026-07-01",
    [["11:00", "12:00"], ["14:00", "15:00"]],
    "three absences leave the two gaps between them",
  );
  const afterCancel = rewrite(one, [two, three], { mode: "remove", existing: stored });
  offers(
    afterCancel.overrides,
    "2026-07-01",
    [["09:00", "12:00"], ["14:00", "15:00"]],
    "cancelling the first of three gives back only its own hours",
  );
}

{
  // Abutting absences cover the working day between them, and a fully covered
  // day must produce cal.com's "nothing at all", never an empty list (which is
  // "no override", i.e. the normal week, i.e. bookable straight through).
  const morning = win("2026-07-01T13:00:00Z", "2026-07-01T16:00:00Z"); // 09:00-12:00
  const afternoon = win("2026-07-01T16:00:00Z", "2026-07-01T21:00:00Z"); // 12:00-17:00
  const stored = rewrite(morning, []).overrides;
  const both = rewrite(afternoon, [morning], { existing: stored });
  offers(both.overrides, "2026-07-01", null, "abutting absences leave nothing bookable");
  assert(
    both.overrides.some(
      (o) => o.date === "2026-07-01" && o.startTime === "00:00" && o.endTime === "00:00",
    ),
    "a fully covered day is written as the 00:00-00:00 block cal.com reads as unavailable",
  );
}

{
  // Overlapping absences (which the overlap guard refuses today, but a data
  // import or a widened edit can still produce) must not double-subtract.
  const first = win("2026-07-01T13:00:00Z", "2026-07-01T18:00:00Z"); // 09:00-14:00
  const second = win("2026-07-01T17:00:00Z", "2026-07-01T20:00:00Z"); // 13:00-16:00
  const out = rewrite(second, [first]);
  offers(out.overrides, "2026-07-01", [["16:00", "17:00"]], "overlapping absences union, not stack");
}

{
  // Other dates are carried across untouched: rewriting 07-01 must not disturb
  // an override an unrelated absence put on 08-01.
  const foreign: DateOverride[] = [{ date: "2026-08-01", startTime: "00:00", endTime: "00:00" }];
  const out = rewrite(A, [], { existing: foreign });
  assert(
    out.overrides.some((o) => o.date === "2026-08-01" && o.startTime === "00:00"),
    "an override on an unrelated date survives the rewrite",
  );
  eq(out.replaced, 0, "nothing on the rewritten date was there to replace");
}

// ===========================================================================
// The single-request control: one absence behaves exactly as it did before
// #2417. Every expected value below is unchanged from the pre-fix suite.
// ===========================================================================

for (const [label, avail] of [
  ["names", weekdaysByName],
  ["numbers", weekdaysByNumber],
] as const) {
  eq(
    rewrite(win("2026-07-01T17:00:00Z", "2026-07-01T19:00:00Z"), [], { availability: avail }).overrides,
    [
      { date: "2026-07-01", startTime: "09:00", endTime: "13:00" },
      { date: "2026-07-01", startTime: "15:00", endTime: "17:00" },
    ],
    `mid-day OOO splits the day (days as ${label})`,
  );
}

eq(
  rewrite(win("2026-07-01T12:00:00Z", "2026-07-02T00:00:00Z"), []).overrides,
  [{ date: "2026-07-01", startTime: "00:00", endTime: "00:00" }],
  "OOO spanning the working day blocks it fully",
);

eq(
  rewrite(win("2026-07-01T22:00:00Z", "2026-07-01T23:00:00Z"), []).overrides,
  [],
  "evening OOO changes nothing",
);

eq(
  rewrite(win("2026-07-01T19:00:00Z", "2026-07-01T23:00:00Z"), []).overrides,
  [{ date: "2026-07-01", startTime: "09:00", endTime: "15:00" }],
  "afternoon-onward OOO keeps the morning",
);

eq(
  datesCoveredBy("2026-07-01T17:00:00Z", "2026-07-01T17:00:00Z", TZ),
  [],
  "zero-length window touches no date",
);

eq(
  rewrite(win("2026-07-04T14:00:00Z", "2026-07-04T18:00:00Z"), []).overrides,
  [{ date: "2026-07-04", startTime: "00:00", endTime: "00:00" }],
  "a day without working hours still gets blocked",
);

eq(
  rewrite(win("2026-07-01T19:00:00Z", "2026-07-03T15:00:00Z"), []).overrides,
  [
    { date: "2026-07-01", startTime: "09:00", endTime: "15:00" }, // first: morning stays
    { date: "2026-07-02", startTime: "00:00", endTime: "00:00" }, // middle: blocked
    { date: "2026-07-03", startTime: "11:00", endTime: "17:00" }, // last: afternoon stays
  ],
  "multi-day first/middle/last days",
);

eq(
  rewrite(win("2026-07-03T20:00:00Z", "2026-07-06T16:00:00Z"), []).overrides,
  [
    { date: "2026-07-03", startTime: "09:00", endTime: "16:00" },
    { date: "2026-07-04", startTime: "00:00", endTime: "00:00" },
    { date: "2026-07-05", startTime: "00:00", endTime: "00:00" },
    { date: "2026-07-06", startTime: "12:00", endTime: "17:00" },
  ],
  "weekend middle days blocked, Monday partial",
);

eq(
  rewrite(win("2026-07-01T17:00:00Z", "2026-07-01T19:00:00Z"), [], { availability: undefined }).overrides,
  [{ date: "2026-07-01", startTime: "00:00", endTime: "00:00" }],
  "missing availability blocks the day",
);

// ===========================================================================
// All day, and an absence running past the working day at either end
// ===========================================================================

{
  // A whole local day: 00:00 to 24:00 ET.
  const allDay = win("2026-07-01T04:00:00Z", "2026-07-02T04:00:00Z");
  eq(
    datesCoveredBy(allDay.startIso, allDay.endIso, TZ),
    ["2026-07-01"],
    "an all-day absence ending at midnight does not claim the next date",
  );
  offers(rewrite(allDay, []).overrides, "2026-07-01", null, "an all-day absence leaves nothing");
}

{
  // 07:00 to 12:00 ET: starts before the working day.
  const early = win("2026-07-01T11:00:00Z", "2026-07-01T16:00:00Z");
  offers(rewrite(early, []).overrides, "2026-07-01", [["12:00", "17:00"]], "an early start clips to 09:00");
  // 14:00 to 20:00 ET: runs past the end of the working day.
  const late = win("2026-07-01T18:00:00Z", "2026-07-02T00:00:00Z");
  offers(rewrite(late, []).overrides, "2026-07-01", [["09:00", "14:00"]], "a late finish clips to 17:00");
  // Both at once still leaves only the middle.
  offers(
    rewrite(late, [early], { existing: rewrite(early, []).overrides }).overrides,
    "2026-07-01",
    [["12:00", "14:00"]],
    "an early and a late absence leave only the middle",
  );
}

// ===========================================================================
// Refusals: an unreadable window must never produce an override
// ===========================================================================

{
  const bad = recomputeOverrides({
    existing: [],
    dates: ["2026-07-01"],
    windows: [win("not-a-timestamp", "2026-07-01T16:00:00Z")],
    scheduleTz: TZ,
    availability: weekdaysByName,
  });
  assert(bad.ok === false, "an unreadable window refuses rather than computing an override");
}

{
  const inverted = recomputeOverrides({
    existing: [],
    dates: ["2026-07-01"],
    windows: [win("2026-07-01T16:00:00Z", "2026-07-01T13:00:00Z")],
    scheduleTz: TZ,
    availability: weekdaysByName,
  });
  assert(inverted.ok === false, "an inverted window refuses rather than being skipped");
}

eq(datesCoveredBy("2026-07-02T13:00:00Z", "2026-07-01T13:00:00Z", TZ), null, "an inverted window covers no dates");
eq(datesCoveredBy("nonsense", "2026-07-01T13:00:00Z", TZ), null, "an unreadable start covers no dates");

// ===========================================================================
// Timezone: the agent's own zone decides the date, and the day can differ from
// the org's (CLAUDE.md's three-gate rule: an agent's hours are judged in their
// own zone, never the org's).
// ===========================================================================

{
  const tokyo = "Asia/Tokyo";
  const tokyoWeek: CalcomAvailabilityRule[] = [
    { days: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "17:00" },
  ];
  // 2026-07-01 23:00 UTC is 2026-07-02 08:00 in Tokyo: a Thursday there while it
  // is still Wednesday in New York and in UTC.
  const morning = win("2026-07-02T00:00:00Z", "2026-07-02T02:00:00Z"); // Thu 09:00-11:00 JST
  const afternoon = win("2026-07-02T05:00:00Z", "2026-07-02T08:00:00Z"); // Thu 14:00-17:00 JST
  eq(
    datesCoveredBy(morning.startIso, morning.endIso, tokyo),
    ["2026-07-02"],
    "a Tokyo absence lands on the Tokyo date",
  );
  const stored = rewrite(morning, [], { tz: tokyo, availability: tokyoWeek }).overrides;
  const both = rewrite(afternoon, [morning], { tz: tokyo, availability: tokyoWeek, existing: stored });
  offers(
    both.overrides,
    "2026-07-02",
    [["11:00", "14:00"]],
    "two Tokyo absences leave only the middle of the Tokyo working day",
  );
  // The same instants read against New York fall on a different local date, so
  // judging the agent in the org's zone would rewrite the wrong day entirely.
  eq(
    datesCoveredBy(morning.startIso, morning.endIso, TZ),
    ["2026-07-01"],
    "the same instants are the previous date in the org's zone",
  );
}

{
  // A daylight-saving day is 23 hours long, and the working week is stated in
  // wall-clock hours. 2026-03-08 is the US spring-forward Sunday; use the Monday
  // after it, when only one of two zones has changed its clocks.
  const springWeek: CalcomAvailabilityRule[] = [
    { days: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "17:00" },
  ];
  // Mon 2026-03-09, 09:00-12:00 EDT = 13:00-16:00Z.
  const out = rewrite(win("2026-03-09T13:00:00Z", "2026-03-09T16:00:00Z"), [], {
    availability: springWeek,
  });
  offers(
    out.overrides,
    "2026-03-09",
    [["12:00", "17:00"]],
    "wall-clock hours hold across a daylight-saving change",
  );
}

finish();
