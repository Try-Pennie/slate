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
import { attemptTrafficFromFixtures, reachedBy, shortWindowReach } from "./lib/attempt-traffic.ts";
import { readTierFixtures } from "./lib/volume-floor-scope.ts";
import {
  FAILURE_RATE_FIT,
  MEASURED_ATTEMPT_TRAFFIC,
  SHIPPED_FAILURE_RATE_RECENT,
  SHIPPED_FAILURE_RATE_THRESHOLDS,
  deriveFailureRateThresholds,
  failuresToBreach,
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

// --- #3275: the recent sub window is reachable on the traffic it judges ------------
//
// The page stands down only on a measured clean run in the last 30 minutes, so a
// recent floor the traffic rarely reaches would hold every page open. The figures the
// comment on SHIPPED_FAILURE_RATE_RECENT quotes are re-derived here from the same
// fixtures and the same share as the window, so they cannot drift from it (L107).
{
  const tiers = readTierFixtures();
  const fixtures = tiers as Record<string, NonNullable<(typeof tiers)[keyof typeof tiers]>>;
  const r = SHIPPED_FAILURE_RATE_RECENT;
  const share = MEASURED_ATTEMPT_TRAFFIC.slateShare;
  const at = (minutes: number) => shortWindowReach(fixtures, minutes, r.minAttempts, share, 9, 20);
  const pct = (x: number) => Math.round(x * 100);
  const thirty = at(r.windowMs / 60_000);
  eq(r.windowMs, 30 * 60_000, "the recent window is the 30 minutes the comment measures");
  eq(pct(thirty.daytime), 96, "between 9am and 8pm ET, 96% of 30 minute windows hold the recent floor (update the comment if this moves)");
  eq(pct(thirty.allDay), 74, "around the clock, 74% do");
  eq(pct(at(15).daytime), 52, "a 15 minute window would hold it in only 52% of daytime windows");
  assert(thirty.daytime >= 0.9, "the all-clear can stand down on ordinary daytime traffic");

  // The chance a wave still under way produces a clean run of the floor by luck, at
  // the failure rates the comment quotes, from the SHIPPED floor (L107).
  const luck = (failPct: number) => pct((1 - failPct / 100) ** r.minAttempts);
  eq(luck(FAILURE_RATE_FIT.failPct), 33, "a wave sitting on the line stands down on luck about 33% of the time");
  eq(luck(30), 17, "17% at a 30% failure rate");
  eq(luck(46), 5, "5% at the 2026-08-06 wave's 46%");
}

// --- the floor: how many failures a page takes at it -------------------------------
{
  const n = minAttemptsFor(FAILURE_RATE_FIT);
  const failuresAt = (attempts: number) => failuresToBreach(attempts, FAILURE_RATE_FIT.failPct);
  assert(failuresAt(n) >= FAILURE_RATE_FIT.failuresToBreachAtFloor, `at the floor of ${n} a page takes ${FAILURE_RATE_FIT.failuresToBreachAtFloor} failures`);
  assert(failuresAt(n - 1) < FAILURE_RATE_FIT.failuresToBreachAtFloor, "and the floor is the smallest that does");
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
  // The quantity the floor exists to guard: how many failed bookings it takes to page
  // at the floor (L139, L63). Asserted on the shipped pair, through the same judge
  // arithmetic the check uses, and seen to fail on #2484's pair, which took three.
  const atFloor = failuresToBreach(SHIPPED_FAILURE_RATE_THRESHOLDS.minAttempts, SHIPPED_FAILURE_RATE_THRESHOLDS.failPct);
  assert(
    atFloor >= FAILURE_RATE_FIT.failuresToBreachAtFloor,
    `a page at the shipped floor takes ${atFloor} failed bookings, at least ${FAILURE_RATE_FIT.failuresToBreachAtFloor}`,
  );
  eq(failuresToBreach(10, 20), 3, "negative control: #2484's floor of 10 at 20 percent paged on 3 failures");
  assert(failuresToBreach(10, 20) < FAILURE_RATE_FIT.failuresToBreachAtFloor, "so the assertion above would refuse that fit");
  // And the count agrees with the judge itself: exactly that many failures at the
  // floor exceed failPct, one fewer does not.
  const n = SHIPPED_FAILURE_RATE_THRESHOLDS.minAttempts;
  const pct = SHIPPED_FAILURE_RATE_THRESHOLDS.failPct;
  assert((atFloor / n) * 100 > pct && ((atFloor - 1) / n) * 100 <= pct, "the count matches the share the check exceeds");
}

// --- reachedBy, both ends -----------------------------------------------------------
{
  const vals = Array.from({ length: 101 }, (_, i) => i);
  eq(reachedBy(vals, 0.85), 15, "85 percent of 0 to 100 reach 15");
  eq(reachedBy(vals, 1), 0, "every window reaches the minimum");
}

finish();
