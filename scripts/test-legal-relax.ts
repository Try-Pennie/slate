// #2158: a legal bucket with nobody in it is widened to the same tier's whole
// pool rather than shown as "all times are taken".
//
// The rule is small and the danger is in its EDGES, so this drives them: it must
// relax exactly one key, must leave every other constraint standing, and must say
// clearly when there was nothing to relax, because "we widened and still found
// nobody" and "there was nothing to widen" are different facts.
// Run: node --experimental-strip-types scripts/test-legal-relax.ts
import { assert, finish } from "./lib/harness.ts";
import {
  hasLegalRestriction,
  LEGAL_CRITERIA_KEY,
  withoutLegalRestriction,
} from "../src/lib/routing/legal-relax.ts";
import { allXbcCodes, bucketSpecForXbc } from "../src/lib/xbc.ts";

// 1. THE WIDENING IS NOW UNREACHABLE, and that is what this block proves (#2218).
//
//    It used to assert the opposite: that 411's real criteria carry the legal
//    restriction, so the relaxation had something to act on. Dropping the
//    criterion from all sixty codes consumed that premise (L373), and the honest
//    replacement is the fact that replaced it, read from the code that BUILDS
//    every bucket rather than from a fixture written here (L48).
//
//    This is the SAFETY claim of dropping the criterion, so it is asserted rather
//    than assumed: `resolveEligibleAgents` reaches the widening only when a pool
//    is empty AND the criteria carry the key, so with no code carrying it the
//    widening cannot fire, and removing it later cannot change what any lead is
//    offered. Every code, not one example, because a criterion left on a single
//    bucket would leave the widening live for exactly that bucket.
{
  for (const code of allXbcCodes()) {
    const spec = bucketSpecForXbc(code)!;
    assert(
      !hasLegalRestriction(spec.criteria),
      `${code} carries no legal restriction: ${JSON.stringify(spec.criteria)}`,
    );
    assert(
      withoutLegalRestriction(spec.criteria) === null,
      `${code} has nothing to widen, which is what null means here`,
    );
  }

  // And the three legal digits of one tier and backend now select the same pool,
  // which is the pool the widening was handing them anyway.
  assert(
    JSON.stringify(bucketSpecForXbc("411")!.criteria) ===
      JSON.stringify(bucketSpecForXbc("412")!.criteria),
    "411 and 412 select the same pool",
  );
}

// 2. The backend is a different boundary and is NEVER relaxed. A Beyond lead must
//    not be handed to an Achieve advisor because a legal pool was thin.
{
  const beyondLegal = bucketSpecForXbc("421");
  const relaxed = withoutLegalRestriction(beyondLegal!.criteria);
  // 421 carries no legal restriction at all (the Beyond and Achieve routes never
  // filter on legal), so there is nothing to relax and it says so.
  assert(relaxed === null, "a Beyond legal code has no legal restriction to relax");

  // And where a code DOES carry both, the backend survives.
  const both = withoutLegalRestriction({ debt_team: "high", backend_service: "beyond", [LEGAL_CRITERIA_KEY]: "N" });
  assert(both !== null && both.backend_service === "beyond", "the backend is kept through a relaxation");
  assert(both !== null && both.debt_team === "high", "the debt team is kept through a relaxation");
}

// 3. Nothing to relax is reported as nothing, in every shape.
{
  assert(withoutLegalRestriction({ debt_team: "low" }) === null, "no legal key, nothing to relax");
  assert(withoutLegalRestriction({} as never) === null, "empty criteria, nothing to relax");
  assert(!hasLegalRestriction(null), "null criteria carry no restriction");
  assert(!hasLegalRestriction(undefined), "undefined criteria carry no restriction");
}

// 4. The original is not mutated. The caller still holds the bucket's own criteria
//    and may report on them, so a relaxation that edited them in place would make
//    the alert describe the widened pool as the requested one.
{
  const original = { debt_team: "ultra_high", [LEGAL_CRITERIA_KEY]: "N" };
  const before = JSON.stringify(original);
  withoutLegalRestriction(original);
  assert(JSON.stringify(original) === before, "the caller's criteria are untouched");
}

// 5. NO code relaxes any more (#2218). This block used to name the ten codes the
//    measurement found empty and require exactly those to relax; the criterion is
//    gone from all sixty, so the set is empty and saying so is the assertion. It
//    is kept rather than deleted because it is enumerated from the XBC contract,
//    so a criterion reintroduced on any code fails here as well as in test-xbc.
{
  const relaxable = allXbcCodes().filter((code) =>
    hasLegalRestriction(bucketSpecForXbc(code)!.criteria),
  );
  assert(
    relaxable.length === 0,
    `no code carries a legal restriction to relax, got ${JSON.stringify(relaxable)}`,
  );
}

finish();
