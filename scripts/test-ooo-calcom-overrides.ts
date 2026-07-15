// Tests for the Cal.com inverse-override builder (port of buildDateOverrides_).
// Run: node --experimental-strip-types scripts/test-ooo-calcom-overrides.ts
import {
  buildDateOverrides,
  filterOutOverrides,
  mergeOverrides,
  type CalcomAvailabilityRule,
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

// 2026-07-01 is a Wednesday.
// --- same-day partial: OOO 1pm-3pm ET leaves 9-1 and 3-5 ---
for (const [label, avail] of [
  ["names", weekdaysByName],
  ["numbers", weekdaysByNumber],
] as const) {
  eq(
    buildDateOverrides("2026-07-01T17:00:00Z", "2026-07-01T19:00:00Z", TZ, avail),
    [
      { date: "2026-07-01", startTime: "09:00", endTime: "13:00" },
      { date: "2026-07-01", startTime: "15:00", endTime: "17:00" },
    ],
    `mid-day OOO splits the day (days as ${label})`,
  );
}

// --- OOO covering the whole working day -> 00:00-00:00 block ---
eq(
  buildDateOverrides("2026-07-01T12:00:00Z", "2026-07-02T00:00:00Z", TZ, weekdaysByName),
  [{ date: "2026-07-01", startTime: "00:00", endTime: "00:00" }],
  "OOO spanning the working day blocks it fully",
);

// --- OOO entirely outside working hours -> no overrides ---
eq(
  buildDateOverrides("2026-07-01T22:00:00Z", "2026-07-01T23:00:00Z", TZ, weekdaysByName),
  [],
  "evening OOO changes nothing",
);

// --- OOO starting mid-day, open end of day -> only the before-window remains ---
eq(
  buildDateOverrides("2026-07-01T19:00:00Z", "2026-07-01T23:00:00Z", TZ, weekdaysByName),
  [{ date: "2026-07-01", startTime: "09:00", endTime: "15:00" }],
  "afternoon-onward OOO keeps the morning",
);

// --- zero-length window -> nothing ---
eq(
  buildDateOverrides("2026-07-01T17:00:00Z", "2026-07-01T17:00:00Z", TZ, weekdaysByName),
  [],
  "zero-length window builds nothing",
);

// --- no working hours that day (Saturday) -> still a full block ---
eq(
  buildDateOverrides("2026-07-04T14:00:00Z", "2026-07-04T18:00:00Z", TZ, weekdaysByName),
  [{ date: "2026-07-04", startTime: "00:00", endTime: "00:00" }],
  "a day without working hours still gets blocked",
);

// --- multi-day: Wed 3pm ET through Fri 11am ET ---
eq(
  buildDateOverrides("2026-07-01T19:00:00Z", "2026-07-03T15:00:00Z", TZ, weekdaysByName),
  [
    { date: "2026-07-01", startTime: "09:00", endTime: "15:00" }, // first: morning stays
    { date: "2026-07-02", startTime: "00:00", endTime: "00:00" }, // middle: blocked
    { date: "2026-07-03", startTime: "11:00", endTime: "17:00" }, // last: afternoon stays
  ],
  "multi-day first/middle/last days",
);

// --- multi-day spanning a weekend keeps blocking weekend days ---
{
  // Fri 2026-07-03 4pm ET -> Mon 2026-07-06 12pm ET
  const out = buildDateOverrides(
    "2026-07-03T20:00:00Z",
    "2026-07-06T16:00:00Z",
    TZ,
    weekdaysByName,
  );
  eq(
    out,
    [
      { date: "2026-07-03", startTime: "09:00", endTime: "16:00" },
      { date: "2026-07-04", startTime: "00:00", endTime: "00:00" },
      { date: "2026-07-05", startTime: "00:00", endTime: "00:00" },
      { date: "2026-07-06", startTime: "12:00", endTime: "17:00" },
    ],
    "weekend middle days blocked, Monday partial",
  );
}

// --- unknown availability shape -> full-day blocks (never silently bookable) ---
eq(
  buildDateOverrides("2026-07-01T17:00:00Z", "2026-07-01T19:00:00Z", TZ, undefined),
  [{ date: "2026-07-01", startTime: "00:00", endTime: "00:00" }],
  "missing availability blocks the day",
);

// --- merge de-dupes exact matches ---
{
  const existing = [{ date: "2026-07-01", startTime: "09:00", endTime: "13:00" }];
  const merged = mergeOverrides(existing, [
    { date: "2026-07-01", startTime: "09:00", endTime: "13:00" },
    { date: "2026-07-02", startTime: "00:00", endTime: "00:00" },
  ]);
  assert(merged.length === 2, "merge de-dupes identical overrides");
}

// --- removal is symmetric with building ---
{
  const built = buildDateOverrides(
    "2026-07-01T19:00:00Z",
    "2026-07-03T15:00:00Z",
    TZ,
    weekdaysByName,
  );
  const foreign = [{ date: "2026-08-01", startTime: "00:00", endTime: "00:00" }];
  const merged = mergeOverrides(foreign, built);
  eq(
    filterOutOverrides(merged, built),
    foreign,
    "remove filters exactly what was added, keeping foreign overrides",
  );
}

finish();
