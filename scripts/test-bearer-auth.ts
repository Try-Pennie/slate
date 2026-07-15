// Shared constant-time Bearer auth primitives (#594). Pure/IO-free so it runs
// under `node --experimental-strip-types` with no Next/Supabase/Google in scope.
// Consolidates the ad-hoc `header === `Bearer ${key}`` checks that reassign,
// offboarding, and cron each did with a plain === (a timing side channel) onto
// one constant-time path, matching what the booking API already used.
// Run: node --experimental-strip-types scripts/test-bearer-auth.ts
import { bearerToken, timingSafeEqual, bearerTokenMatches } from "../src/lib/bearer-auth.ts";
import { assert, finish } from "./lib/harness.ts";

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

finish();
