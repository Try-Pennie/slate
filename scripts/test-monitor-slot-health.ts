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
import { slotHealthByCode } from "../src/lib/monitor/slot-health.ts";
import { assert, finish } from "./lib/harness.ts";

const FRESH_ISO = "2026-07-29T12:00:00.000Z";
const FRESH_MS = Date.parse(FRESH_ISO);

// A clean row: slot count from the payload, stamp parsed to epoch ms.
{
  const m = slotHealthByCode([
    { bucket_code: "111", payload: { slots: ["a", "b", "c"] }, computed_at: FRESH_ISO },
  ]);
  assert(m.get("111")?.slotCount === 3, "counts the cached slots");
  assert(m.get("111")?.computedAtMs === FRESH_MS, "parses a readable computed_at to epoch ms");
}

// The fail-safe: an unreadable stamp is maximally stale, never fresh.
for (const bad of ["", "not-a-date", "2026-13-45T99:99:99Z"]) {
  const m = slotHealthByCode([
    { bucket_code: "222", payload: { slots: ["a"] }, computed_at: bad },
  ]);
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
    { bucket_code: "good", payload: { slots: ["a"] }, computed_at: FRESH_ISO },
    { bucket_code: "bad", payload: { slots: ["a"] }, computed_at: "not-a-date" },
  ]);
  const isStale = (code: string) => nowMs - m.get(code)!.computedAtMs > STALE_AFTER_MS;
  assert(isStale("good") === false, "a recent recompute is judged fresh");
  assert(isStale("bad") === true, "an unreadable recompute stamp is judged stale, so the canary fires");
}

// A missing/empty payload is zero slots, not a crash.
{
  const m = slotHealthByCode([
    { bucket_code: "333", payload: null, computed_at: FRESH_ISO },
    { bucket_code: "444", payload: {}, computed_at: FRESH_ISO },
  ]);
  assert(m.get("333")?.slotCount === 0, "a null payload is zero slots");
  assert(m.get("444")?.slotCount === 0, "a payload with no slots key is zero slots");
}

finish();
