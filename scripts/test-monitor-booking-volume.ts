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

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
};

const CFG: BusinessHoursConfig = {
  zone: "America/New_York",
  weekdays: [1, 2, 3, 4, 5],
  startHour: 8,
  endHour: 20,
};

// --- isBusinessHours (Eastern, DST aware) ---
{
  ok(isBusinessHours(Date.UTC(2026, 5, 23, 23, 0, 0), CFG), "summer 19:00 ET weekday -> business hours (ET not UTC)");
  ok(isBusinessHours(Date.UTC(2026, 0, 6, 0, 30, 0), CFG), "winter 19:30 EST weekday -> business hours (DST aware)");
  ok(!isBusinessHours(Date.UTC(2026, 5, 20, 16, 0, 0), CFG), "weekend -> outside");
  ok(!isBusinessHours(Date.UTC(2026, 5, 23, 7, 0, 0), CFG), "overnight ET -> outside");
}

// --- lowVolumeBreaches ---
{
  const windows: VolumeWindow[] = [
    { label: "30 min", count: 0, floor: 10 }, // breached
    { label: "120 min", count: 50, floor: 40 }, // healthy
  ];
  const out = lowVolumeBreaches(windows);
  ok(out.length === 1 && out[0].label === "30 min", "flags a window whose count is below its floor");
  ok(!out.some((w) => w.label === "120 min"), "ignores a window at or above its floor");
  ok(lowVolumeBreaches([{ label: "30 min", count: 10, floor: 10 }]).length === 0, "count exactly at the floor is NOT a breach");
  ok(lowVolumeBreaches([]).length === 0, "no windows -> no breaches");
}

// --- formatLowVolumeAlert ---
{
  const msg = formatLowVolumeAlert([{ label: "30 min", count: 0, floor: 25 }]);
  ok(msg.includes("0") && msg.includes("30 min") && msg.includes("25"), "alert states the count, window, and expected floor");
  ok(!/[–—]/.test(msg), "alert uses no em/en dashes (copy rule)");
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
