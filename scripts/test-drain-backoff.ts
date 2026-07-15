// Drain retry backoff (#445): the booking-outbox + reservation drains retry a
// failing row every tick. drainBackoffMs spreads those retries exponentially so a
// permanently-failing step (e.g. a dead Google call or Regal webhook) is not hit
// ~50 times in 50 minutes. Pure + node-native.
// Run: node --experimental-strip-types scripts/test-drain-backoff.ts
import {
  drainBackoffMs,
  DRAIN_ALERT_AFTER,
  DRAIN_GIVE_UP_AT,
} from "../src/lib/booking/drain-backoff.ts";
import { assert, finish } from "./lib/harness.ts";

const MIN = 60_000;

// Exponential from a 1-minute base: attempt n waits 2^(n-1) minutes.
assert(drainBackoffMs(1) === 1 * MIN, "1st retry waits 1 min");
assert(drainBackoffMs(2) === 2 * MIN, "2nd retry waits 2 min");
assert(drainBackoffMs(3) === 4 * MIN, "3rd retry waits 4 min");
assert(drainBackoffMs(4) === 8 * MIN, "4th retry waits 8 min");

// Capped at 60 min so a long-stuck row still gets retried hourly until give-up.
assert(drainBackoffMs(7) === 60 * MIN, "7th retry (would be 64 min) is capped at 60 min");
assert(drainBackoffMs(50) === 60 * MIN, "far-out retries stay capped at 60 min (no overflow)");

// Defensive: a zero/negative count never produces a zero or negative delay.
assert(drainBackoffMs(0) === MIN, "attempt 0 floors at the 1-min base");
assert(drainBackoffMs(-3) === MIN, "negative attempts floor at the base (never <= 0)");

// Thresholds: alert well before giving up, and give up long after alerting.
assert(DRAIN_ALERT_AFTER < DRAIN_GIVE_UP_AT, "alert threshold is below the give-up cap");
assert(DRAIN_ALERT_AFTER >= 3, "alert only after a few real failures (not a one-off blip)");

finish();
