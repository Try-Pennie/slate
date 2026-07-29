// Pure logic for the low-booking-volume alert (#370): which time windows are
// below their expected floor, and the business-hours gate (Eastern, DST-aware)
// that keeps it from firing overnight/weekends when low volume is normal. Run:
//   node --experimental-strip-types scripts/test-monitor-booking-volume.ts
import {
  isBusinessHours,
  lowVolumeBreaches,
  formatLowVolumeAlert,
  runLowVolumeCheck,
  VOLUME_ALERT_KEY,
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

// --- runLowVolumeCheck (#1158): the paging DECISION, extracted from the cron
// route so the gates (business hours, armed) and the failure path (a count read
// that fails must claim nothing, never zero) are pinned by tests. ---

/** A weekday 14:00 ET instant, squarely inside business hours. */
const BUSINESS_NOW = Date.UTC(2026, 5, 23, 18, 0, 0);
/** A Saturday, outside business hours. */
const WEEKEND_NOW = Date.UTC(2026, 5, 20, 18, 0, 0);

function harness(overrides: {
  counts?: Record<string, number | null>;
  countThrows?: boolean;
  notifyThrows?: boolean;
  nowMs?: number;
  armed?: boolean;
  floors?: { floor30: number; floor120: number };
}) {
  const notified: { key: string; cooldownMs: number; text: string }[] = [];
  const logged: Record<string, unknown>[] = [];
  const countCalls: string[] = [];
  const run = () =>
    runLowVolumeCheck({
      nowMs: overrides.nowMs ?? BUSINESS_NOW,
      businessHours: CFG,
      countSince: async (sinceIso: string) => {
        countCalls.push(sinceIso);
        if (overrides.countThrows) throw new Error("bookings read failed");
        const minutes = String(
          Math.round(((overrides.nowMs ?? BUSINESS_NOW) - Date.parse(sinceIso)) / 60_000),
        );
        // `in` rather than `??`: a configured null means "read failed" and must
        // reach the check as null, not collapse to 0.
        const counts = overrides.counts ?? {};
        return minutes in counts ? counts[minutes] : 0;
      },
      floors: overrides.floors ?? { floor30: 5, floor120: 20 },
      armed: overrides.armed ?? true,
      cooldownMs: 30 * 60_000,
      notify: async (key: string, cooldownMs: number, text: string) => {
        if (overrides.notifyThrows) throw new Error("slack down");
        notified.push({ key, cooldownMs, text });
      },
      log: (fields: Record<string, unknown>) => logged.push(fields),
    });
  return { run, notified, logged, countCalls };
}

// Outside business hours: no reads, no alert, explicit status.
{
  const h = harness({ nowMs: WEEKEND_NOW });
  const res = await h.run();
  assert(res.status === "outside-hours", "outside business hours the check does not run");
  assert(h.countCalls.length === 0, "outside business hours no booking counts are read");
  assert(h.notified.length === 0, "outside business hours nothing is alerted");
}

// Healthy volume: checked, no breach, no alert, counts logged.
{
  const h = harness({ counts: { "30": 9, "120": 40 } });
  const res = await h.run();
  assert(res.status === "checked" && res.breaches.length === 0, "healthy counts above the floors are no breach");
  assert(h.notified.length === 0, "healthy volume sends no alert");
  assert(
    h.logged.some((f) => f.count_30m === 9 && f.count_120m === 40 && f.below_floor === 0),
    "the log line carries both counts and a zero breach count",
  );
}

// Breach while armed: pages once with the shared key and the settings cooldown.
{
  const h = harness({ counts: { "30": 1, "120": 40 } });
  const res = await h.run();
  assert(res.status === "checked" && res.breaches.length === 1, "a count below its floor is a breach");
  assert(h.notified.length === 1, "an armed breach pages exactly once");
  assert(h.notified[0]?.key === VOLUME_ALERT_KEY, "the page uses the shared alert key");
  assert(h.notified[0]?.cooldownMs === 30 * 60_000, "the page uses the injected cooldown");
  assert(h.notified[0]?.text.includes("30 min") === true, "the page names the breached window");
}

// Breach while disarmed: counted and logged, never paged.
{
  const h = harness({ counts: { "30": 1, "120": 40 }, armed: false });
  const res = await h.run();
  assert(res.status === "checked" && res.breaches.length === 1, "a disarmed breach is still reported in the result");
  assert(h.notified.length === 0, "a disarmed breach never pages");
  assert(h.logged.some((f) => f.armed === false), "the log line says the alarm is disarmed");
}

// THE FAILURE PATH (#1158): a failed count read must claim nothing. Before the
// extraction a read error became count 0, which is below any real floor, so an
// unreadable bookings table would have paged "0 bookings" off a query that never
// ran (the #1134/#1152 class, on the paging side).
{
  const h = harness({ counts: { "30": null, "120": 40 } });
  const res = await h.run();
  assert(res.status === "unverified", "a failed count read is unverified, not zero");
  assert(h.notified.length === 0, "a failed count read never pages a false zero");
  assert(
    h.logged.some((f) => f.unverified === true),
    "the log line says the counts could not be read, distinct from a real zero",
  );
}

// A count reader that THROWS (instead of returning null) must not kill the tick.
{
  const h = harness({ countThrows: true });
  const res = await h.run();
  assert(res.status === "unverified", "a throwing count read degrades to unverified");
  assert(h.notified.length === 0, "a throwing count read never pages");
}

// A flaky Slack must never fail the monitor tick (matches the other checks).
{
  const h = harness({ counts: { "30": 0, "120": 0 }, notifyThrows: true });
  const res = await h.run();
  assert(res.status === "checked", "a throwing notify is swallowed and the check still reports");
}

finish();
