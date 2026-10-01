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
 *
 * A calendar another lane held (#2705) is the retry kind too, ranked below the
 * budget: when both hold, the run stopped because the budget ran out, and that is
 * the sentence that describes what happened. Below any measured failure, for the
 * same reason the budget is.
 */
export function poolEntryRefusal(
  entry: PoolEntryResult | null,
): "calendar_unhydrated" | "activation_timed_out" | "calendar_contended" | null {
  if (entry === null || entry.failed > 0) return "calendar_unhydrated";
  if (entry.outOfBudget) return "activation_timed_out";
  if (entry.contended > 0) return "calendar_contended";
  if (entry.hydrated > 0) return null;
  return "calendar_unhydrated";
}
