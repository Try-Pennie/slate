// #1725: the booking failure SHARE can never count a self inflicted refusal.
//
// The refusals Slate makes to its own caller (#1442, #1450, #1709) stay out of the
// share for exactly one reason: their names are absent from `OUTCOME_ORDER`, which
// is what `normalizeMix` sums into `total`, the denominator the failure share is
// measured against. Nothing asserted that. Add a refusal name to `OUTCOME_ORDER`
// later, or move one across, and the share silently starts counting refusals it was
// designed to exclude: the denominator grows, a real outage has to move a larger
// number to page, and every other test still passes.
//
// Three halves, each blind where another looks:
//
//   - the two LISTS are disjoint, which is the mechanism itself;
//   - every name a catalog decision says is recorded OUTSIDE the share is on the
//     refusal list, so a name moved across (taken off one list and put on the other)
//     cannot keep the lists disjoint while the decision quietly stops being true;
//   - the real normalizer, given a reading full of refusals, leaves `total` exactly
//     where the outcomes put it, so the claim is checked against the code that does
//     the summing rather than only against the two constants.
//
// Each carries a positive control, so none can rot into a check that passes over
// anything (L1).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-refusal-outcome-disjoint.ts
import {
  OUTCOME_ORDER,
  SELF_INFLICTED_REFUSALS,
  emptyRefusalCounts,
  normalizeMix,
} from "../src/lib/monitor/booking-api-outcome.ts";
import { REFUSAL_CATALOG } from "../src/lib/booking/refusal-catalog.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** The names on both lists. Written here rather than imported so the control below
 *  drives the very function the real check uses. */
function overlap(order: readonly string[], refusals: readonly string[]): string[] {
  const inOrder = new Set(order);
  return refusals.filter((name) => inOrder.has(name));
}

// ------------------------------------------------ the two lists are disjoint

{
  // A vacuous pass is the failure this guards against most: an empty refusal list is
  // disjoint from anything.
  assert(SELF_INFLICTED_REFUSALS.length > 0, "the refusal list is not empty, so disjointness means something");
  assert(OUTCOME_ORDER.length > 0, "the outcome list is not empty either");
  eq(
    overlap(OUTCOME_ORDER, SELF_INFLICTED_REFUSALS),
    [],
    "no self inflicted refusal is an outcome the failure share divides by",
  );

  // Positive control: the same function, handed an outcome list with one refusal
  // planted in it, names exactly that refusal.
  for (const planted of SELF_INFLICTED_REFUSALS) {
    eq(
      overlap([...OUTCOME_ORDER, planted], SELF_INFLICTED_REFUSALS),
      [planted],
      `positive control: ${planted} planted in OUTCOME_ORDER is caught`,
    );
  }

  // The naming convention every refusal follows, held on the share's side too, so a
  // refusal moved ACROSS (dropped from the refusal list and added to the outcomes)
  // still fails here even though the two lists would then be disjoint.
  eq(
    OUTCOME_ORDER.filter((o) => o.startsWith("refused_")),
    [],
    "no outcome the share divides by is named like a refusal",
  );
  for (const name of SELF_INFLICTED_REFUSALS) {
    assert(name.startsWith("refused_"), `${name} follows the refused_ naming the check above relies on`);
  }
}

// ------------------- every catalog decision to stay out of the share holds

{
  // The catalog records `own-counter` for every path deliberately kept OUT of the
  // share. Those outcome names are the decision; the refusal list is the mechanism.
  // An entry may name two counters ("a / b"), as the ceiling does.
  const decided = REFUSAL_CATALOG.flatMap((r) =>
    r.counting.kind === "own-counter" ? r.counting.outcome.split("/").map((s) => s.trim()) : [],
  );
  assert(decided.length > 0, "the catalog records at least one path kept out of the share, so this half is not vacuous");
  const refusals = new Set<string>(SELF_INFLICTED_REFUSALS);
  eq(
    decided.filter((name) => !refusals.has(name)),
    [],
    "every outcome a catalog entry keeps out of the share is on the refusal list",
  );
  eq(
    overlap(OUTCOME_ORDER, decided),
    [],
    "and none of them is an outcome the share divides by",
  );
  // Positive control: a decided name taken off the refusal list is caught.
  const moved = decided[0]!;
  const without = SELF_INFLICTED_REFUSALS.filter((n) => n !== moved);
  eq(
    decided.filter((name) => !(without as readonly string[]).includes(name)),
    [moved],
    `positive control: ${moved} dropped from the refusal list is caught`,
  );
}

// ----------------------- the real normalizer keeps them out of the total

{
  const byOutcome: Record<string, number> = { created: 7, error: 3 };
  for (const name of SELF_INFLICTED_REFUSALS) byOutcome[name] = 1000;
  const mix = normalizeMix({ by_outcome: byOutcome });
  eq(mix.total, 10, "a thousand of every refusal moves the share's denominator by nothing");
  eq(
    mix.outcomes.find((o) => o.outcome === "error")?.pct,
    30,
    "so three errors in ten attempts still read as 30%, not as a sliver of a refusal flood",
  );
  // And the refusals are still CARRIED, on their own field, so they were not simply
  // dropped (a normalizer that discarded them would also pass the line above).
  for (const name of SELF_INFLICTED_REFUSALS) {
    eq(mix.refusals[name], 1000, `${name} is carried on the refusals field for its own signal`);
  }
  eq(
    Object.keys(emptyRefusalCounts()).sort(),
    [...SELF_INFLICTED_REFUSALS].sort(),
    "the zero filled counts cover exactly the refusal list, so no name reads as absent",
  );

  // Positive control: the same reading with one more OUTCOME does move the total, so
  // the equality above is a measurement and not a constant the normalizer returns.
  const control = normalizeMix({ by_outcome: { ...byOutcome, created: 8 } });
  eq(control.total, 11, "positive control: an outcome the share divides by does move the total");
}

finish();
