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
import { bucketSpecForXbc } from "../src/lib/xbc.ts";

// 1. The real criteria, taken from the code that BUILDS every bucket, not from a
//    fixture written here. A rule calibrated against its author's idea of the
//    shape is a rule about the author (L48).
{
  const legal = bucketSpecForXbc("411");
  assert(legal !== null, "411 is a valid XBC");
  assert(
    hasLegalRestriction(legal!.criteria),
    `411's real criteria carry the legal restriction: ${JSON.stringify(legal!.criteria)}`,
  );

  const relaxed = withoutLegalRestriction(legal!.criteria);
  assert(relaxed !== null, "411 relaxes");
  assert(!(LEGAL_CRITERIA_KEY in relaxed!), "the legal key is gone");
  assert(relaxed!.debt_team === legal!.criteria.debt_team, "the debt tier is kept");

  // The relaxed criteria must equal what the neighbouring non-legal code already
  // uses, because that is the claim: this is the pool that code would have used,
  // not a new one invented here.
  const nonLegal = bucketSpecForXbc("412");
  assert(nonLegal !== null, "412 is a valid XBC");
  assert(
    JSON.stringify(relaxed) === JSON.stringify(nonLegal!.criteria),
    `relaxed 411 equals 412's criteria: ${JSON.stringify(relaxed)} vs ${JSON.stringify(nonLegal!.criteria)}`,
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

// 5. EVERY code the measurement found empty must relax, and no other code should.
//    Enumerated from the XBC contract rather than from the ten codes typed by
//    hand, so a code that starts carrying the restriction is covered by
//    construction (L96).
{
  const relaxable: string[] = [];
  for (const adv of "12345") {
    for (const bes of "0123") {
      for (const leg of "012") {
        const spec = bucketSpecForXbc(`${adv}${bes}${leg}`);
        if (spec && hasLegalRestriction(spec.criteria)) relaxable.push(spec.code);
      }
    }
  }
  const expected = ["101", "111", "201", "211", "301", "311", "401", "411", "501", "511"];
  assert(
    JSON.stringify(relaxable.sort()) === JSON.stringify(expected.sort()),
    `exactly the ten measured empty codes relax, got ${JSON.stringify(relaxable)}`,
  );
}

finish();
