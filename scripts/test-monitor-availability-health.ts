// Pure logic for the availability-health probe (#371): which buckets SHOULD show
// booking times but don't, and the per-bucket "is any eligible agent on shift in
// their own timezone right now" gate (DST-aware) that keeps the probe from crying
// wolf when a bucket is legitimately closed. Run:
//   node --experimental-strip-types scripts/test-monitor-availability-health.ts
import {
  isWorkingNow,
  anyOnShift,
  failingBuckets,
  formatEmptyAvailabilityAlert,
  type WorkingRule,
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
const NINE_TO_FIVE: WorkingRule[] = [
  { weekday: 1, start_minute: 540, end_minute: 1020 },
  { weekday: 2, start_minute: 540, end_minute: 1020 },
  { weekday: 3, start_minute: 540, end_minute: 1020 },
  { weekday: 4, start_minute: 540, end_minute: 1020 },
  { weekday: 5, start_minute: 540, end_minute: 1020 },
];

// --- isWorkingNow (per-agent, timezone + DST aware) ---
{
  // Tue 14:00 EDT (within 9-17) -> working.
  ok(isWorkingNow(Date.UTC(2026, 5, 23, 18, 0, 0), "America/New_York", NINE_TO_FIVE), "ET agent at 14:00 local -> working");
  // Tue 18:00 EDT (after 17:00) -> not working.
  ok(!isWorkingNow(Date.UTC(2026, 5, 23, 22, 0, 0), "America/New_York", NINE_TO_FIVE), "ET agent at 18:00 local -> off shift");
  // Winter Mon 09:30 EST -> working (proves DST/EST offset, not a fixed UTC slice).
  ok(isWorkingNow(Date.UTC(2026, 0, 5, 14, 30, 0), "America/New_York", NINE_TO_FIVE), "ET agent 09:30 EST winter -> working (DST aware)");
  // PT agent at 23:30 UTC = 16:30 PDT (working). The SAME instant is 19:30 ET (off) -> proves the agent's OWN tz is used.
  ok(isWorkingNow(Date.UTC(2026, 5, 23, 23, 30, 0), "America/Los_Angeles", NINE_TO_FIVE), "PT agent at 16:30 local -> working (uses agent tz, not ET)");
  // Saturday -> off (weekday gate).
  ok(!isWorkingNow(Date.UTC(2026, 5, 20, 18, 0, 0), "America/New_York", NINE_TO_FIVE), "weekend -> off shift");
  // No rules -> never on shift (matches how availability treats a scheduleless agent).
  ok(!isWorkingNow(NOW, "America/New_York", []), "agent with no rules -> off shift");
}

// --- anyOnShift ---
{
  const onMidday = Date.UTC(2026, 5, 23, 18, 0, 0); // Tue 14:00 ET
  ok(
    anyOnShift(onMidday, [
      { timezone: "America/New_York", rules: [] }, // off (no rules)
      { timezone: "America/New_York", rules: NINE_TO_FIVE }, // on
    ]),
    "true when at least one eligible agent is on shift",
  );
  ok(
    !anyOnShift(onMidday, [
      { timezone: "America/New_York", rules: [] },
      { timezone: "America/New_York", rules: [{ weekday: 6, start_minute: 540, end_minute: 1020 }] }, // Sat only
    ]),
    "false when no eligible agent is on shift",
  );
}

// --- failingBuckets ---
{
  const rows = [
    { code: "411", eligibleCount: 5, slotCount: 0, computedAtMs: NOW - 1000, onShiftNow: true }, // broken-empty
    { code: "416", eligibleCount: 5, slotCount: 0, computedAtMs: NOW - 1000, onShiftNow: false }, // no one on shift (legit)
    { code: "412", eligibleCount: 5, slotCount: 3, computedAtMs: NOW - 1000, onShiftNow: true }, // has slots
    { code: "413", eligibleCount: 0, slotCount: 0, computedAtMs: NOW - 1000, onShiftNow: true }, // no agents (#327's job)
    { code: "414", eligibleCount: 5, slotCount: 0, computedAtMs: NOW - 9 * 60_000, onShiftNow: true }, // stale
    { code: "415", eligibleCount: 5, slotCount: 0, computedAtMs: null, onShiftNow: true }, // never computed
  ];
  const out = failingBuckets(rows, { nowMs: NOW, freshWindowMs: FRESH });
  ok(out.length === 1 && out[0] === "411", "flags only on-shift + eligible>0 + fresh + zero-slot buckets");
  ok(!out.includes("416"), "ignores buckets with no eligible agent on shift (legitimately closed)");
  ok(!out.includes("413"), "ignores zero-eligible buckets (that is #327's signal)");
  ok(!out.includes("414"), "ignores STALE rows (the recompute lane's concern)");
  ok(!out.includes("415"), "ignores never-computed (null) rows");
  ok(!out.includes("412"), "ignores buckets that have slots");
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
