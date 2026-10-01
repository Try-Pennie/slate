/**
 * The booking traffic the failing bookings floors are fitted to (#2494), read from the
 * cal.com measurements already committed for the volume floors rather than from a
 * second read of cal.com: the two fits then rest on one measurement and cannot drift
 * apart about how much traffic there is (L41).
 *
 * The failure rate check sums every booking attempt across every tier in a ROLLING
 * window, so the quantity that decides whether it can conclude is the count inside
 * such a window, not an hourly average (L711). This builds the series of every
 * measured tier summed bucket by bucket over the span every measurement covers, slides
 * a window of each candidate length across it, and records the count that the given
 * share of those windows reaches.
 *
 * The result is the WHOLE traffic cal.com measured. Slate's share of it is applied
 * where the thresholds are derived (`deriveFailureRateThresholds`), because the
 * measurement is a fact about cal.com and the share is a fact about the split.
 */
import type { VolumeFixture } from "./volume-floor-scope.ts";
import type { AttemptTrafficMeasurement } from "../../src/lib/monitor/failure-rate-thresholds.ts";
import { FAILURE_RATE_FIT } from "../../src/lib/monitor/failure-rate-thresholds.ts";

/** The count at least `coverage` of the values reach: the low end a floor has to clear. */
export function reachedBy(values: readonly number[], coverage: number): number {
  if (values.length === 0) throw new Error("attempt traffic: no windows to measure");
  const sorted = [...values].sort((a, b) => a - b);
  // Index of the value with (1 - coverage) of the windows below it.
  return sorted[Math.floor((1 - coverage) * (sorted.length - 1))]!;
}

/**
 * The measurement, from the committed tier fixtures. Every fixture must share one
 * bucket length; the span is the stretch every one of them covers, so no tier is
 * counted as zero where it simply was not measured.
 */
export function attemptTrafficFromFixtures(
  fixtures: Readonly<Record<string, VolumeFixture>>,
  coverage: number = FAILURE_RATE_FIT.windowCoverage,
  maxWindowHours: number = FAILURE_RATE_FIT.maxWindowHours,
): Omit<AttemptTrafficMeasurement, "slateShare" | "slateShareSource" | "excluded"> {
  const list = Object.entries(fixtures).sort(([a], [b]) => a.localeCompare(b));
  if (list.length === 0) throw new Error("attempt traffic: no measurements to read");
  const bucketMinutes = list[0]![1].bucketMinutes;
  if (list.some(([, f]) => f.bucketMinutes !== bucketMinutes)) {
    throw new Error("attempt traffic: the measurements do not share one bucket length");
  }
  const per = bucketMinutes * 60_000;
  const spanOf = (f: VolumeFixture) => {
    const n = Math.max(0, ...Object.values(f.forms).map((c) => c.length));
    return [f.startMs, f.startMs + n * per] as const;
  };
  const startMs = Math.max(...list.map(([, f]) => spanOf(f)[0]));
  const endMs = Math.min(...list.map(([, f]) => spanOf(f)[1]));
  const n = Math.floor((endMs - startMs) / per);
  const perHourBuckets = 60 / bucketMinutes;
  if (n < maxWindowHours * perHourBuckets) throw new Error("attempt traffic: the measurements share too short a span");

  const total = new Array<number>(n).fill(0);
  for (const [, f] of list) {
    const offset = (f.startMs - startMs) / per;
    for (const counts of Object.values(f.forms)) {
      counts.forEach((c, i) => {
        const j = i + offset;
        if (j >= 0 && j < n) total[j]! += c;
      });
    }
  }

  const windowReach: Record<string, number> = {};
  for (let hours = 1; hours <= maxWindowHours; hours++) {
    const w = hours * perHourBuckets;
    const windows: number[] = [];
    let sum = total.slice(0, w).reduce((s, v) => s + v, 0);
    for (let i = w; i <= n; i++) {
      windows.push(sum);
      if (i < n) sum += total[i]! - total[i - w]!;
    }
    windowReach[String(hours)] = reachedBy(windows, coverage);
  }

  return {
    source: "calcom",
    tiers: list.map(([t]) => t),
    measuredOn: list.map(([, f]) => f.measuredOn).sort().at(-1)!,
    from: new Date(startMs).toISOString(),
    to: new Date(startMs + n * per).toISOString(),
    bookings: total.reduce((s, v) => s + v, 0),
    coverage,
    windowReach,
  };
}
