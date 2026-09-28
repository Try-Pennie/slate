// #1171: the bucket-freshness mapping the monitor tick feeds its availability
// canary. This was the one site changed by #1169/PR #1170 that had no test of
// its own, because the route built the map inline.
//
// What matters is the DIRECTION an unreadable stamp lands. `computedAtMs` is
// compared against a freshness threshold, and NaN compares false against every
// threshold, so an unreadable stamp parsed raw would read as fresh and the
// canary would stay quiet about a slot cache that had stopped recomputing. It
// must land on the stale side instead.
// Run: node --experimental-strip-types scripts/test-monitor-slot-health.ts
import { slotHealthByCode, type SlotHealthRow } from "../src/lib/monitor/slot-health.ts";
import type { BusinessHoursRules } from "../src/lib/availability/compute.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const FRESH_ISO = "2026-07-29T12:00:00.000Z";
const FRESH_MS = Date.parse(FRESH_ISO);

// The org open all day every day, so the tests below stay about the stamp and the
// payload shape. Gate 1's own effect on the count is the block at the end.
const OPEN: BusinessHoursRules = {
  zone: "America/New_York",
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })), exceptions: [] };
/** Three real instants on Wednesday 2026-07-29, so they survive an open-day filter. */
const THREE = ["2026-07-29T14:00:00.000Z", "2026-07-29T15:00:00.000Z", "2026-07-29T16:00:00.000Z"];
const ONE = ["2026-07-29T14:00:00.000Z"];
const ET = { duration_min: 30 };

// A clean row: slot count from the payload, stamp parsed to epoch ms.
{
  const m = slotHealthByCode([
    { bucket_code: "111", payload: { slots: THREE, eventType: ET }, computed_at: FRESH_ISO },
  ], OPEN);
  assert(m.get("111")?.slotCount === 3, "counts the cached slots");
  assert(m.get("111")?.computedAtMs === FRESH_MS, "parses a readable computed_at to epoch ms");
}

// The fail-safe: an unreadable stamp is maximally stale, never fresh.
for (const bad of ["", "not-a-date", "2026-13-45T99:99:99Z"]) {
  const m = slotHealthByCode([
    { bucket_code: "222", payload: { slots: ONE, eventType: ET }, computed_at: bad },
  ], OPEN);
  assert(
    m.get("222")?.computedAtMs === 0,
    `an unreadable computed_at (${JSON.stringify(bad)}) reads as epoch 0, the stale side`,
  );
  assert(
    Number.isFinite(m.get("222")!.computedAtMs),
    `an unreadable computed_at (${JSON.stringify(bad)}) is never NaN, which would read as fresh`,
  );
}

// Proof the stale side is what a freshness check actually concludes: the same
// comparison the canary makes must call the unreadable row stale and the good
// row fresh. Without this, "epoch 0" is just a number nobody checked the meaning
// of.
{
  const STALE_AFTER_MS = 10 * 60_000;
  const nowMs = FRESH_MS + 60_000; // one minute after the good recompute
  const m = slotHealthByCode([
    { bucket_code: "good", payload: { slots: ONE, eventType: ET }, computed_at: FRESH_ISO },
    { bucket_code: "bad", payload: { slots: ONE, eventType: ET }, computed_at: "not-a-date" },
  ], OPEN);
  const isStale = (code: string) => nowMs - m.get(code)!.computedAtMs > STALE_AFTER_MS;
  assert(isStale("good") === false, "a recent recompute is judged fresh");
  assert(isStale("bad") === true, "an unreadable recompute stamp is judged stale, so the canary fires");
}

// A missing/empty payload is zero slots, not a crash.
{
  const m = slotHealthByCode([
    { bucket_code: "333", payload: null, computed_at: FRESH_ISO },
    { bucket_code: "444", payload: {}, computed_at: FRESH_ISO },
  ], OPEN);
  assert(m.get("333")?.slotCount === 0, "a null payload is zero slots");
  assert(m.get("444")?.slotCount === 0, "a payload with no slots key is zero slots");
}

// --- #1296: the count must match what the booker actually serves ------------------
//
// The read path filters cached slots against the org's CURRENT hours, so a stored
// payload can hold slots that no lead is being offered. If the monitor counted the
// raw payload it would be measuring a list nobody sees, which is the one thing a
// health probe must never do.
{
  const narrowed = {
    zone: "America/New_York",
    rules: [{ weekday: 1, start_minute: 8 * 60, end_minute: 15 * 60 }], exceptions: [] };
  // Monday 2026-06-08, New York: 09:00, 14:00 and 19:00 local, 30 minutes each.
  const row = (slots: string[]): SlotHealthRow => ({
    bucket_code: "411",
    payload: { slots, eventType: { duration_min: 30 } },
    computed_at: "2026-06-08T12:00:00.000Z",
  });
  const all = [
    "2026-06-08T13:00:00.000Z",
    "2026-06-08T18:00:00.000Z",
    "2026-06-08T23:00:00.000Z",
  ];

  eq(
    slotHealthByCode([row(all)], narrowed).get("411")?.slotCount,
    2,
    "the count drops the slots the org's hours now exclude, matching what is served",
  );
  eq(
    slotHealthByCode([row(all)], {
      zone: "America/New_York",
      rules: [{ weekday: 1, start_minute: 0, end_minute: 1440 }], exceptions: [] }).get("411")?.slotCount,
    3,
    "an open day counts every stored slot",
  );

  // A payload with no duration cannot be judged against the org's window at all.
  // Counting it raw would report slots the booker may not be serving; reporting
  // zero would page about a bucket that is probably fine. Neither is measurement,
  // so it reads as UNKNOWN and the detector leaves it alone.
  eq(
    slotHealthByCode(
      [{ bucket_code: "411", payload: { slots: all }, computed_at: "2026-06-08T12:00:00.000Z" }],
      narrowed,
    ).get("411")?.slotCount,
    null,
    "a payload with no duration reads as unknown, never as a confident count",
  );
}

// --- #2842: the count offered by advisors WITHOUT Low, judged the same way ---
{
  const CLOSED_WED: BusinessHoursRules = {
    zone: "America/New_York",
    rules: [1, 2, 4, 5, 6, 7].map((weekday) => ({ weekday, start_minute: 0, end_minute: 1440 })),
    exceptions: [],
  };
  const m = slotHealthByCode([
    { bucket_code: "311", payload: { slots: THREE, slotsWithoutLow: ONE, eventType: ET }, computed_at: FRESH_ISO },
    { bucket_code: "312", payload: { slots: THREE, eventType: ET }, computed_at: FRESH_ISO },
  ], OPEN);
  eq(m.get("311")?.slotCountWithoutLow, 1, "the second list is counted");
  // Absent is UNKNOWN, never zero: a zero reads as "nobody without Low is free",
  // which is a finding, while a row from before the field existed is not one.
  eq(m.get("312")?.slotCountWithoutLow, null, "an absent second list is unmeasured, not zero");
  const shut = slotHealthByCode([
    { bucket_code: "311", payload: { slots: THREE, slotsWithoutLow: ONE, eventType: ET }, computed_at: FRESH_ISO },
  ], CLOSED_WED);
  eq(shut.get("311")?.slotCountWithoutLow, 0, "the org's hours filter the second list too");
}

finish();
