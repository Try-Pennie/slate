// Unit test for the booking smoke suite's slot-availability gate (#456).
//
// The failure this locks in: if the isolated test agent is misconfigured (no
// Google Calendar connected, no availability schedule, or recompute has not
// published slots yet), the bucket returns ZERO open slots and the smoke run
// exercises NOTHING. That must fail loudly as a configuration error, never read
// as a quiet pass. This test drives the pure decision function directly, so it
// runs with no production calls.
// Run: node --experimental-strip-types scripts/test-smoke-slot-availability.ts
import { evaluateSlotAvailability } from "./smoke-lib.ts";
import { assert, finish } from "./lib/harness.ts";

// The core failure path: zero slots is the misconfigured setup. It must NOT be
// ok, must be classified as setup_broken, and must name the misconfiguration
// loudly (not the old soft "pick a bucket" hint).
const zero = evaluateSlotAvailability("SMOKE", 0);
assert(zero.ok === false, "zero slots is NOT ok (a run that exercises nothing is a failure, not a pass)");
assert(
  zero.ok === false && zero.kind === "setup_broken",
  "zero slots is classified as setup_broken (the test agent is misconfigured)",
);
assert(
  zero.ok === false && /ZERO open slots/.test(zero.message) && /misconfigured/.test(zero.message),
  "setup_broken message loudly names the misconfiguration",
);

// A thin but non-zero window is a distinct, still-failing case (not setup_broken).
const thin = evaluateSlotAvailability("SMOKE", 3);
assert(
  thin.ok === false && thin.kind === "insufficient",
  "3 slots (below the floor of 5) is insufficient, not setup_broken",
);
assert(
  thin.ok === false && /at least 5/.test(thin.message),
  "insufficient message states the required floor",
);

// Enough slots proceeds.
assert(evaluateSlotAvailability("SMOKE", 5).ok === true, "exactly the floor (5) is ok");
assert(evaluateSlotAvailability("SMOKE", 12).ok === true, "well above the floor is ok");

// The floor is configurable, so a caller can require a different minimum.
assert(evaluateSlotAvailability("SMOKE", 2, 2).ok === true, "a custom minRequired is honored");
assert(
  (() => {
    const r = evaluateSlotAvailability("SMOKE", 1, 3);
    return r.ok === false && r.kind === "insufficient";
  })(),
  "a non-zero count below a custom floor is insufficient",
);

finish();
