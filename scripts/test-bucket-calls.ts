// Bucket availability counted in calls (#3939, Dan, 2026-10-20): a pool's day is the calls taken by
// anything on its advisors' calendars out of the calls their shifts could hold, the same per advisor
// numbers Team capacity shows, so the two pages say one thing with one word (L118).
//
// The rules a wrong answer would hide behind a plausible number:
//  - a pool adds up its own eligible advisors only, each counted once;
//  - an advisor not syncing or out counts in neither number, as on Team capacity;
//  - a failed read is unknown on every open day, never a zero;
//  - the monitor's nearly full check, which passes no calls, keeps its start time measure.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-bucket-calls.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { bucketSupplyReport, type CachedSlotRow, type SupplyEventType } from "../src/lib/admin/bucket-supply.ts";
import { callsByCode } from "../src/lib/admin/bucket-calls.ts";
import { SUPPLY_DAY_GROUP_HEADER, supplyCellTitle } from "../src/lib/admin/bucket-supply-copy.ts";
import type { BusinessHoursRules } from "../src/lib/availability/compute.ts";
import type { AdvisorDay, TeamCapacityAdvisor } from "../src/lib/admin/team-capacity.ts";

const ZONE = "America/New_York";
const WEEK: BusinessHoursRules = {
  zone: ZONE,
  rules: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_minute: 9 * 60, end_minute: 17 * 60 })),
  exceptions: [],
};
const EVENT: SupplyEventType = { duration_min: 20, slot_interval_min: 10, min_notice_min: 120, buffer_before_min: 0, buffer_after_min: 0 };
const NOW = Date.parse("2026-08-04T15:19:00.000Z"); // Tuesday 11:19 in New York
const STAMP = new Date(NOW - 30_000).toISOString();
const DAYS = ["2026-08-04", "2026-08-05"];

const day = (iso: string, open: number, capacity: number, over: Partial<AdvisorDay> = {}): AdvisorDay => ({
  iso, open, capacity, out: false, noShift: false, openTimes: [], shiftStart: null, shiftEnd: null,
  fullShiftStart: null, fullShiftEnd: null, timeOff: [], ...over,
});
const advisor = (id: string, days: AdvisorDay[], unsynced = false): TeamCapacityAdvisor => ({
  id, name: id, email: `${id}@x.test`, timezone: ZONE, unsynced, days,
});

// --- adding up a pool ------------------------------------------------------------------------
{
  const advisors = [
    advisor("a", [day(DAYS[0], 4, 10), day(DAYS[1], 10, 10)]),
    advisor("b", [day(DAYS[0], 0, 8), day(DAYS[1], 2, 8)]),
    advisor("c", [day(DAYS[0], 5, 5), day(DAYS[1], 5, 5)], true),
    advisor("d", [day(DAYS[0], 0, 9, { out: true }), day(DAYS[1], 3, 9)]),
  ];
  const calls = callsByCode(
    new Map([["110", ["a", "b", "c", "d", "gone"]], ["120", ["a"]]]),
    advisors,
    DAYS,
  );
  eq(calls.get("110")?.get(DAYS[0]), { taken: 14, capacity: 18 }, "a pool adds its advisors' calls taken and the calls their shifts hold");
  eq(calls.get("110")?.get(DAYS[1]), { taken: 12, capacity: 27 }, "an advisor out one day counts again the next");
  eq(calls.get("120")?.get(DAYS[0]), { taken: 6, capacity: 10 }, "each pool only its own advisors");
  const twice = callsByCode(new Map([["110", ["a", "a"]]]), advisors, DAYS);
  eq(twice.get("110")?.get(DAYS[0]), { taken: 6, capacity: 10 }, "an advisor named twice counts once");
  eq(callsByCode(new Map([["130", []]]), advisors, DAYS).get("130")?.get(DAYS[0]), { taken: 0, capacity: 0 }, "a pool with nobody holds nothing");
}

// --- the report reads calls when the page hands them over ---------------------------------------
const slots = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse("2026-08-04T17:20:00.000Z") + i * 600_000).toISOString());
const row = (code: string): CachedSlotRow => ({ bucket_code: code, payload: { slots: slots(9), eventType: { ...EVENT } }, computed_at: STAMP });
const report = (over: Partial<Parameters<typeof bucketSupplyReport>[0]> = {}) =>
  bucketSupplyReport({
    hours: WEEK,
    horizonDays: 4,
    offeredOpenDays: 3,
    nowMs: NOW,
    buckets: [{ code: "110", name: "Low | Both | No Legal Param" }],
    depthByCode: new Map([["110", { depth: 2, effectiveDepth: 2, poolKey: "pool-low", poolLabel: "Low" }]]),
    cacheRows: [row("110")],
    bookedByCodeAndDate: new Map(),
    ...over,
  });
const cell0 = (r: ReturnType<typeof report>) => (r.measurable ? r.rows[0].cells[0] : null);
{
  const calls = new Map([["110", new Map([[DAYS[0], { taken: 14, capacity: 18 }]])]]);
  eq(cell0(report({ callsByCode: calls })), { kind: "counted", booked: 14, capacity: 18, share: 14 / 18 }, "a measured day is calls taken out of calls the shifts hold");
  eq(cell0(report()), { kind: "counted", booked: 0, capacity: 9, share: 0 }, "with no calls handed over, the start time measure the monitor reads is unchanged");
  eq(cell0(report({ callsByCode: null })), { kind: "unknown" }, "calls that could not be read are unknown, never zero");
  eq(cell0(report({ callsByCode: new Map() })), { kind: "unknown" }, "a pool with no reading is unknown");
  const empty = new Map([["110", new Map([[DAYS[0], { taken: 0, capacity: 0 }]])]]);
  eq(cell0(report({ callsByCode: empty })), { kind: "nobody-available" }, "a pool whose advisors hold no calls that day has nobody available");
  const sunday = report({ callsByCode: null, nowMs: Date.parse("2026-08-09T15:19:00.000Z") });
  assert(sunday.measurable && sunday.rows[0].cells[0].kind === "closed", "a shut day stays shut whatever the calls read");
}

// --- the words say calls taken, never times booked ---------------------------------------------
{
  const counted = { kind: "counted" as const, booked: 14, capacity: 18, share: 14 / 18 };
  eq(supplyCellTitle(counted, "Low", "Tue Aug 4", 3), "Low on Tue Aug 4: 14 of 18 calls taken, 78 percent.", "a measured day is read out in calls taken");
  eq(supplyCellTitle({ ...counted, booked: 0, share: 0 }, "Low", "Tue Aug 4", 3), "Low on Tue Aug 4: nothing taken, out of 18 calls its advisors could hold.", "and a quiet one too");
  eq(SUPPLY_DAY_GROUP_HEADER, "Share of the pool's calls already taken", "the day columns name their unit");
}

finish();
