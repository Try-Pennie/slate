import type { PoolEntryResult } from "@/lib/google/pool-entry";

/**
 * Whether the SECOND half of the activation gate (#2302) refuses, and which way.
 *
 * `null` from the caller means `onboardIntoPool` threw. Pure, and in its own module
 * rather than inline in the gate, so the live proof (`pnpm verify:pool-entry`,
 * #2316) judges what Google answered through the predicate that ships rather than
 * through a second copy of it that could drift into agreeing with itself (L107).
 *
 * WHICH refusal, when more than one is true at once (#2317). A MEASURED calendar
 * failure outranks an exhausted budget: it names something a person can act on,
 * and answering "try again in a minute" over a calendar Google has already refused
 * would send them away from the only evidence there is. A throw ranks with the
 * measured failures because it is the least informative outcome and must not be
 * the one that produces the most reassuring advice (L93).
 */
export function poolEntryRefusal(
  entry: PoolEntryResult | null,
): "calendar_unhydrated" | "activation_timed_out" | null {
  if (entry !== null && entry.hydrated > 0 && entry.failed === 0 && !entry.outOfBudget) return null;
  const timedOut = entry !== null && entry.failed === 0 && entry.outOfBudget;
  return timedOut ? "activation_timed_out" : "calendar_unhydrated";
}
