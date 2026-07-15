// Pure logic for the low-booking-volume alert (#370): which time windows are
// below their expected floor, and the business-hours gate (Eastern, DST-aware)
// that keeps it from firing overnight/weekends when low volume is normal. Run:
//   node --experimental-strip-types scripts/test-monitor-booking-volume.ts
import {
  isBusinessHours,
  lowVolumeBreaches,
  formatLowVolumeAlert,
  type BusinessHoursConfig,
  type VolumeWindow,
} from "../src/lib/monitor/booking-volume.ts";
import { assert, finish } from "./lib/harness.ts";

const CFG: BusinessHoursConfig = {
  zone: "America/New_York",
  weekdays: [1, 2, 3, 4, 5],
  startHour: 8,
  endHour: 20,
};

// --- isBusinessHours (Eastern, DST aware) ---
{
  assert(isBusinessHours(Date.UTC(2026, 5, 23, 23, 0, 0), CFG), "summer 19:00 ET weekday -> business hours (ET not UTC)");
  assert(isBusinessHours(Date.UTC(2026, 0, 6, 0, 30, 0), CFG), "winter 19:30 EST weekday -> business hours (DST aware)");
  assert(!isBusinessHours(Date.UTC(2026, 5, 20, 16, 0, 0), CFG), "weekend -> outside");
  assert(!isBusinessHours(Date.UTC(2026, 5, 23, 7, 0, 0), CFG), "overnight ET -> outside");
}

// --- lowVolumeBreaches ---
{
  const windows: VolumeWindow[] = [
    { label: "30 min", count: 0, floor: 10 }, // breached
    { label: "120 min", count: 50, floor: 40 }, // healthy
  ];
  const out = lowVolumeBreaches(windows);
  assert(out.length === 1 && out[0].label === "30 min", "flags a window whose count is below its floor");
  assert(!out.some((w) => w.label === "120 min"), "ignores a window at or above its floor");
  assert(lowVolumeBreaches([{ label: "30 min", count: 10, floor: 10 }]).length === 0, "count exactly at the floor is NOT a breach");
  assert(lowVolumeBreaches([]).length === 0, "no windows -> no breaches");
}

// --- formatLowVolumeAlert ---
{
  const msg = formatLowVolumeAlert([{ label: "30 min", count: 0, floor: 25 }]);
  assert(msg.includes("0") && msg.includes("30 min") && msg.includes("25"), "alert states the count, window, and expected floor");
  assert(!/[\u2013\u2014]/.test(msg), "alert uses no em/en dashes (copy rule)");
}

finish();
