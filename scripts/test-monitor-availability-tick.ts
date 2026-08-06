// The monitor tick's behaviour when the org's hours cannot be read (#1296).
//
// Run: node --experimental-strip-types scripts/test-monitor-availability-tick.ts
//
// The availability scan pages on "this bucket should be showing times and shows
// none". Its slot counts are now filtered to the org's hours, so a tick that cannot
// READ those hours has no honest count to work from. There are two wrong answers
// and this file exists to keep both out:
//
//   * scan anyway with an empty map, and every bucket reads as zero slots, so the
//     tick pages the entire ladder over a failed config read; and
//   * skip, but report `failing: 0`, which is indistinguishable from a clean scan,
//     so a lane that has quietly stopped checking looks healthy indefinitely.
import {
  slotHealthForTick,
  availabilityScanReport,
} from "../src/lib/monitor/availability-tick.ts";
import type { SlotHealthRow } from "../src/lib/monitor/slot-health.ts";
import type { BusinessHoursRules } from "../src/lib/availability/compute.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// Monday 2026-06-08, New York: 09:00, 14:00 and 19:00 local, 30 minutes each.
const ROWS: SlotHealthRow[] = [
  {
    bucket_code: "411",
    payload: {
      slots: [
        "2026-06-08T13:00:00.000Z",
        "2026-06-08T18:00:00.000Z",
        "2026-06-08T23:00:00.000Z",
      ],
      eventType: { duration_min: 30 },
    },
    computed_at: "2026-06-08T12:00:00.000Z",
  },
];

const NARROWED: BusinessHoursRules = {
  zone: "America/New_York",
  rules: [{ weekday: 1, start_minute: 8 * 60, end_minute: 15 * 60 }],
};

// --- a readable week: count what the booker serves ---------------------------------
{
  const map = slotHealthForTick(ROWS, NARROWED);
  assert(map !== null, "a readable week produces counts and the scan runs");
  eq(map!.get("411")?.slotCount, 2, "the tick counts the slots the org's hours actually allow");
}

// --- an unreadable week: skip, and NOT with an empty map ---------------------------
{
  const map = slotHealthForTick(ROWS, null);
  eq(map, null, "an unreadable week returns null, the signal to skip the scan");
  // The distinction that matters. An empty Map is falsy-ish in every way that
  // counts here: `map.get(code)` is undefined for every bucket, the scan reads that
  // as zero slots, and a failed config read becomes a page for the whole ladder.
  assert(
    !(map instanceof Map),
    "the skip signal is NOT an empty Map, which would read as zero slots for every bucket",
  );
}

// --- the response must not report a skipped scan as a clean one --------------------
{
  const ran = availabilityScanReport({ page: ["411", "412"] });
  eq(ran.availabilityScan, "ran", "a scan that ran says so");
  eq(ran.failing, 2, "a scan that ran reports how many buckets are failing");

  const clean = availabilityScanReport({ page: [] });
  eq(clean.failing, 0, "a clean scan reports a real zero");

  const skipped = availabilityScanReport(null);
  eq(skipped.availabilityScan, "skipped: business hours unreadable", "a skipped scan names itself");
  eq(
    skipped.failing,
    null,
    "a skipped scan reports null, never the zero that would read as a clean tick",
  );
  assert(
    skipped.failing !== clean.failing,
    "a skipped tick and a clean tick are distinguishable in the response",
  );
}

finish();
