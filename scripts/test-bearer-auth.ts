// Shared constant-time Bearer auth primitives (#594). Pure/IO-free so it runs
// under `node --experimental-strip-types` with no Next/Supabase/Google in scope.
// Consolidates the ad-hoc `header === `Bearer ${key}`` checks that reassign,
// offboarding, and cron each did with a plain === (a timing side channel) onto
// one constant-time path, matching what the booking API already used.
// Run: node --experimental-strip-types scripts/test-bearer-auth.ts
import { bearerToken, timingSafeEqual, bearerTokenMatches, matchingSecretIndex } from "../src/lib/bearer-auth.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- bearerToken: extract the token from an Authorization header ---
{
  assert(bearerToken("Bearer abc") === "abc", "extracts the token after 'Bearer '");
  assert(bearerToken(null) === null, "null header -> null");
  assert(bearerToken("abc") === null, "missing 'Bearer ' scheme -> null");
  assert(bearerToken("Bearer ") === null, "empty token -> null");
  assert(bearerToken("Basic abc") === null, "wrong scheme -> null");
}

// --- timingSafeEqual: equal strings match, anything else doesn't ---
{
  assert(timingSafeEqual("s3cr3t", "s3cr3t") === true, "identical strings match");
  assert(timingSafeEqual("s3cr3t", "s3cr3T") === false, "one differing char -> no match");
  assert(timingSafeEqual("s3cr3t", "s3cr3t-longer") === false, "length mismatch -> no match");
  assert(timingSafeEqual("", "") === true, "two empty strings match");
}

// --- bearerTokenMatches: the single-secret check the routes now share ---
{
  assert(bearerTokenMatches("Bearer s3cr3t", "s3cr3t") === true, "matching header + secret -> true");
  assert(bearerTokenMatches("Bearer nope", "s3cr3t") === false, "wrong token -> false");
  assert(bearerTokenMatches(null, "s3cr3t") === false, "missing header -> false");
  assert(bearerTokenMatches("Bearer s3cr3t", "") === false, "unconfigured (blank) secret never authenticates");
  assert(bearerTokenMatches("Bearer ", "") === false, "blank secret + empty token still -> false");
  assert(
    bearerTokenMatches("s3cr3t", "s3cr3t") === false,
    "raw secret without the 'Bearer ' scheme -> false",
  );
}

// --- rotation slots (#3110): a key and its _2 slot, either of which authenticates ---
{
  const slots = ["new-key", "old-key"] as const;
  assert(bearerTokenMatches("Bearer new-key", slots) === true, "the primary slot authenticates");
  assert(bearerTokenMatches("Bearer old-key", slots) === true, "the _2 slot authenticates, so a caller can move first");
  assert(bearerTokenMatches("Bearer other", slots) === false, "a value in neither slot is refused");
  assert(bearerTokenMatches("Bearer new-key", ["new-key", ""]) === true, "an unset _2 slot changes nothing");
  assert(bearerTokenMatches("Bearer ", ["", ""]) === false, "two blank slots never authenticate");
  assert(bearerTokenMatches("Bearer x", []) === false, "no slots at all never authenticates");
  assert(bearerTokenMatches("Bearer x", ["", "x"]) === true, "a _2 slot alone still authenticates (the primary is the 503 check, not this)");
}

// --- matchingSecretIndex: WHICH slot matched, so a caller can log the old one ---
{
  eq(matchingSecretIndex("a", ["a", "b"]), 0, "the first slot is index 0");
  eq(matchingSecretIndex("b", ["a", "b"]), 1, "the second slot is index 1");
  eq(matchingSecretIndex("c", ["a", "b"]), -1, "no slot is -1");
  eq(matchingSecretIndex("", ["", "b"]), -1, "a blank token never matches a blank slot");
  eq(matchingSecretIndex("a", ["a", "a"]), 0, "the same value in both slots reads as the primary");
}

finish();
