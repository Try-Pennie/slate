// The public test bucket's code lives in ONE module, and nothing else spells it
// (#2660).
//
// The seed creates the row from this constant and the public paths serve it from
// this constant. Two spellings would let one move without the other, and both
// directions read the same to a partner: "Unknown bucket". So the constant is
// asserted here, and a walk over src/ and scripts/ refuses any other file that
// carries the literal, the declaring module excepted (L41, L96).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-public-test-bucket.ts
import { readFileSync } from "node:fs";
import {
  DEMO_BUCKET_CODE,
  HIDDEN_TEST_BUCKET_CODES,
  PUBLIC_TEST_BUCKET_CODES,
  isDemoBucket,
  isPublicTestBucket,
  opensFromHostPage,
} from "../src/lib/embed/public-test-bucket.ts";
import { sourceFiles } from "./lib/source-files.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const CODE = PUBLIC_TEST_BUCKET_CODES[0];

// --- the predicate --------------------------------------------------------------
// Two public codes since #3424: the partner one, opened from an approved host page,
// and the demo one, opened only from Slate's own /demo page.
eq(PUBLIC_TEST_BUCKET_CODES.length, 2, "two public test codes are served: the partner one and the demo one");
for (const code of PUBLIC_TEST_BUCKET_CODES) assert(isPublicTestBucket(code), `the public test code ${code} is recognised`);
assert(PUBLIC_TEST_BUCKET_CODES.includes(DEMO_BUCKET_CODE), "the demo code is one of the public codes");
assert(CODE !== DEMO_BUCKET_CODE, "the first public code is the partner one, which the canary and reroute check lead with");

// --- which page may open each (#3424) ---------------------------------------------
assert(isDemoBucket(DEMO_BUCKET_CODE), "the demo code is the demo bucket");
assert(!isDemoBucket(CODE), "the partner code is not the demo bucket");
assert(!isDemoBucket("100"), "a real code is not the demo bucket");
assert(!isDemoBucket(DEMO_BUCKET_CODE.toLowerCase()), "the demo match is exact and case sensitive");
assert(opensFromHostPage(CODE), "the partner bucket opens from an approved host page");
assert(!opensFromHostPage(DEMO_BUCKET_CODE), "the demo bucket never opens from a host page, only from /demo");
assert(!opensFromHostPage("100"), "a real bucket is not a test bucket a host page opens through the test gate");
for (const hidden of HIDDEN_TEST_BUCKET_CODES) {
  assert(!isPublicTestBucket(hidden), `the hidden test code ${hidden} stays hidden`);
}
for (const real of ["100", "411", "532"]) {
  assert(!isPublicTestBucket(real), `a real routing code (${real}) is not a test bucket`);
}
assert(!isPublicTestBucket(""), "an empty code is not a test bucket");
assert(!isPublicTestBucket(CODE.toLowerCase()), "the match is case sensitive: a lower case spelling is not served");
assert(!isPublicTestBucket(` ${CODE} `), "the match is exact: a padded spelling is not served, the resolver trims first");
assert(
  !HIDDEN_TEST_BUCKET_CODES.some((h) => PUBLIC_TEST_BUCKET_CODES.includes(h as never)),
  "no code is both hidden and public",
);
assert(
  HIDDEN_TEST_BUCKET_CODES.length >= 2,
  "the hidden codes are the two the canary drives, so the seed still builds both",
);

// --- nothing else spells it -----------------------------------------------------
// The declaring module is the one file allowed to carry the literal. Every other
// file, tests included, reaches it through the import, so a test cannot pin a
// spelling the product no longer serves. Comments count too: a comment naming the
// code is a second place to update when it moves.
for (const code of PUBLIC_TEST_BUCKET_CODES) {
  const literal = new RegExp(`\\b${code}\\b`);
  const declaring = "src/lib/embed/public-test-bucket.ts";
  const files = sourceFiles({
    paths: ["src", "scripts"],
    match: /\.(tsx?|css|mjs|json)$/,
    exclude: (f) => f === declaring,
  });
  const strays = files.filter((f) => literal.test(readFileSync(f, "utf8")));
  eq(strays.join(", "), "", `no file outside ${declaring} spells the public test code ${code}`);

  // Positive control: the declaring module itself carries it, or the regex found
  // nothing because it matched nothing (L98).
  assert(literal.test(readFileSync(declaring, "utf8")), `the declaring module carries the literal ${code} the scan looks for`);
}

finish();
