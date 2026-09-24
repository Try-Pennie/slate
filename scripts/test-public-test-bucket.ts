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
  HIDDEN_TEST_BUCKET_CODES,
  PUBLIC_TEST_BUCKET_CODES,
  isPublicTestBucket,
} from "../src/lib/embed/public-test-bucket.ts";
import { sourceFiles } from "./lib/source-files.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const CODE = PUBLIC_TEST_BUCKET_CODES[0];

// --- the predicate --------------------------------------------------------------
assert(PUBLIC_TEST_BUCKET_CODES.length === 1, "exactly one public test code is served");
assert(isPublicTestBucket(CODE), "the public test code is recognised");
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
{
  const literal = new RegExp(`\\b${CODE}\\b`);
  const declaring = "src/lib/embed/public-test-bucket.ts";
  const files = sourceFiles({
    paths: ["src", "scripts"],
    match: /\.(tsx?|css|mjs|json)$/,
    exclude: (f) => f === declaring,
  });
  const strays = files.filter((f) => literal.test(readFileSync(f, "utf8")));
  eq(strays.join(", "), "", `no file outside ${declaring} spells the public test code`);

  // Positive control: the declaring module itself carries it, or the regex found
  // nothing because it matched nothing (L98).
  assert(literal.test(readFileSync(declaring, "utf8")), "the declaring module carries the literal the scan looks for");
}

finish();
