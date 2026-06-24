// Pure logic for the availability-health probe (#371): which buckets SHOULD show
// booking times but don't, and the business-hours gate (Eastern, DST-aware) that
// keeps the probe from crying wolf overnight/weekends. Run:
//   node --experimental-strip-types scripts/test-monitor-availability-health.ts
import {
  isWithinBusinessHours,
  failingBuckets,
  formatEmptyAvailabilityAlert,
  type BusinessHoursConfig,
} from "../src/lib/monitor/availability-health.ts";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
};

const NOW = Date.UTC(2026, 5, 23, 18, 0, 0); // 2026-06-23 14:00 ET (fresh ref)
const FRESH = 6 * 60_000;

// --- failingBuckets ---
{
  const rows = [
    { code: "411", eligibleCount: 5, slotCount: 0, computedAtMs: NOW - 1000 }, // broken-empty
    { code: "412", eligibleCount: 5, slotCount: 3, computedAtMs: NOW - 1000 }, // has slots
    { code: "413", eligibleCount: 0, slotCount: 0, computedAtMs: NOW - 1000 }, // no agents (#327's job)
    { code: "414", eligibleCount: 5, slotCount: 0, computedAtMs: NOW - 9 * 60_000 }, // stale (recompute's job)
    { code: "415", eligibleCount: 5, slotCount: 0, computedAtMs: null }, // never computed
  ];
  const out = failingBuckets(rows, { nowMs: NOW, freshWindowMs: FRESH });
  ok(out.length === 1 && out[0] === "411", "flags only eligible>0 + fresh + zero-slot buckets");
  ok(!out.includes("413"), "ignores zero-eligible buckets (that is #327's signal, not this)");
  ok(!out.includes("414"), "ignores STALE rows (a fall-behind is the recompute lane's concern)");
  ok(!out.includes("415"), "ignores never-computed (null) rows");
  ok(!out.includes("412"), "ignores buckets that have slots");
}

// --- isWithinBusinessHours (Eastern, DST-aware) ---
{
  const cfg: BusinessHoursConfig = {
    zone: "America/New_York",
    weekdays: [1, 2, 3, 4, 5],
    startHour: 8,
    endHour: 20,
  };
  // 23:00 UTC on a summer Tue = 19:00 EDT -> within. (Proves ET, not UTC: UTC hour 23 would be "outside".)
  ok(isWithinBusinessHours(Date.UTC(2026, 5, 23, 23, 0, 0), cfg), "summer 19:00 ET weekday -> within (ET not UTC)");
  // 00:30 UTC = 19:30 EST the prior (Mon) evening -> within. (Proves the winter offset, DST-aware.)
  ok(isWithinBusinessHours(Date.UTC(2026, 0, 6, 0, 30, 0), cfg), "winter 19:30 EST weekday -> within (DST aware)");
  // Saturday midday ET -> outside (weekday gate).
  ok(!isWithinBusinessHours(Date.UTC(2026, 5, 20, 16, 0, 0), cfg), "weekend -> outside");
  // 07:00 UTC summer = 03:00 EDT -> outside (hour gate).
  ok(!isWithinBusinessHours(Date.UTC(2026, 5, 23, 7, 0, 0), cfg), "overnight ET -> outside");
}

// --- formatEmptyAvailabilityAlert ---
{
  const msg = formatEmptyAvailabilityAlert(["411", "412"]);
  ok(msg.includes("411") && msg.includes("412"), "alert names the failing buckets");
  ok(!/[–—]/.test(msg), "alert uses no em/en dashes (copy rule)");
  const many = formatEmptyAvailabilityAlert(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  ok(/2 more/.test(many), "alert caps the inline list and summarizes the remainder");
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
