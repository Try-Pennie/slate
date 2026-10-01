// The failing bookings floors, derived from measured traffic (#2494). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-failure-rate-fit.ts
//
// What this pins:
// - the measurement in failure-rate-thresholds.ts is exactly what the committed cal.com
//   fixtures give, so it cannot be hand edited away from the traffic (L107, L422);
// - the shipped thresholds are the derivation of that measurement, not typed beside it;
// - the derivation in both directions: more traffic shortens the window, less
//   lengthens it, and traffic that could never reach the floor is refused by name
//   rather than shipped as a check that only ever says `insufficient` (L98);
// - a tier left out of the measurement is left out with a reason, and the day a
//   measurement for it is committed this fails until it is counted.
import { assert, eq, finish } from "./lib/harness.ts";
import { attemptTrafficFromFixtures, reachedBy } from "./lib/attempt-traffic.ts";
import { readTierFixtures } from "./lib/volume-floor-scope.ts";
import {
  FAILURE_RATE_FIT,
  MEASURED_ATTEMPT_TRAFFIC,
  SHIPPED_FAILURE_RATE_THRESHOLDS,
  deriveFailureRateThresholds,
  minAttemptsFor,
  type AttemptTrafficMeasurement,
} from "../src/lib/monitor/failure-rate-thresholds.ts";

const HOUR = 60 * 60_000;

// --- the committed measurement is the fixtures' -----------------------------------
{
  const fixtures = readTierFixtures();
  const derived = attemptTrafficFromFixtures(fixtures as Record<string, NonNullable<(typeof fixtures)[keyof typeof fixtures]>>);
  const committed = { ...MEASURED_ATTEMPT_TRAFFIC } as Partial<AttemptTrafficMeasurement>;
  delete committed.slateShare;
  delete committed.slateShareSource;
  delete committed.excluded;
  eq(committed, derived, "MEASURED_ATTEMPT_TRAFFIC is what the committed cal.com fixtures give");
  for (const tier of Object.keys(MEASURED_ATTEMPT_TRAFFIC.excluded)) {
    assert(
      !(tier in fixtures),
      `tier ${tier} is excluded for having no committed measurement, and none exists; once one does, count it`,
    );
  }
}

// --- the shipped thresholds are the derivation -------------------------------------
eq(
  SHIPPED_FAILURE_RATE_THRESHOLDS,
  deriveFailureRateThresholds(MEASURED_ATTEMPT_TRAFFIC, FAILURE_RATE_FIT),
  "the shipped thresholds are derived from the measurement",
);

// --- the floor: how many failures a page takes at it -------------------------------
{
  const n = minAttemptsFor(FAILURE_RATE_FIT);
  const failuresToBreach = (attempts: number) => Math.floor((attempts * FAILURE_RATE_FIT.failPct) / 100) + 1;
  assert(failuresToBreach(n) >= FAILURE_RATE_FIT.failuresToBreachAtFloor, `at the floor of ${n} a page takes ${FAILURE_RATE_FIT.failuresToBreachAtFloor} failures`);
  assert(failuresToBreach(n - 1) < FAILURE_RATE_FIT.failuresToBreachAtFloor, "and the floor is the smallest that does");
  eq(minAttemptsFor({ ...FAILURE_RATE_FIT, failPct: 20, failuresToBreachAtFloor: 3 }), 10, "three failures at 20 percent is the old floor of ten");
}

// --- the window, in both directions -------------------------------------------------
{
  const base: AttemptTrafficMeasurement = { ...MEASURED_ATTEMPT_TRAFFIC };
  const floor = minAttemptsFor(FAILURE_RATE_FIT);
  const heavy = { ...base, slateShare: 1, windowReach: { "1": floor * 3, "2": floor * 6, "3": floor * 9, "4": floor * 12 } };
  eq(deriveFailureRateThresholds(heavy, FAILURE_RATE_FIT).windowMs, 1 * HOUR, "traffic that clears the floor in an hour gets a one hour window");
  const thinner = { ...heavy, slateShare: 0.25 };
  assert(
    deriveFailureRateThresholds(thinner, FAILURE_RATE_FIT).windowMs > 1 * HOUR,
    "the same traffic at a quarter share needs a longer window",
  );
  const hopeless = { ...base, windowReach: { "1": 1, "2": 2, "3": 3, "4": 4 } };
  let refusal = "";
  try {
    deriveFailureRateThresholds(hopeless, FAILURE_RATE_FIT);
  } catch (e) {
    refusal = (e as Error).message;
  }
  assert(refusal.includes("no window up to 4 hours"), `traffic that never reaches the floor is refused by name (got "${refusal}")`);
  let shareRefusal = "";
  try {
    deriveFailureRateThresholds({ ...heavy, slateShare: Number.NaN }, FAILURE_RATE_FIT);
  } catch (e) {
    shareRefusal = (e as Error).message;
  }
  assert(shareRefusal.includes("share"), "an unreadable share is refused rather than read as zero traffic (L50)");
}

// --- the shipped pair, against the traffic it judges --------------------------------
{
  const hours = SHIPPED_FAILURE_RATE_THRESHOLDS.windowMs / HOUR;
  const reach = MEASURED_ATTEMPT_TRAFFIC.windowReach[String(hours)]!;
  assert(
    Math.floor(reach * MEASURED_ATTEMPT_TRAFFIC.slateShare) >= SHIPPED_FAILURE_RATE_THRESHOLDS.minAttempts,
    `Slate's share of ${Math.round(FAILURE_RATE_FIT.windowCoverage * 100)} percent of ${hours} hour windows reaches the floor`,
  );
  assert(
    (1 / SHIPPED_FAILURE_RATE_THRESHOLDS.minAttempts) * 100 <= SHIPPED_FAILURE_RATE_THRESHOLDS.failPct,
    "one failed booking at the floor does not by itself exceed the share (L139)",
  );
}

// --- reachedBy, both ends -----------------------------------------------------------
{
  const vals = Array.from({ length: 101 }, (_, i) => i);
  eq(reachedBy(vals, 0.85), 15, "85 percent of 0 to 100 reach 15");
  eq(reachedBy(vals, 1), 0, "every window reaches the minimum");
}

finish();
