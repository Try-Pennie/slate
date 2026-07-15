// escapeLike (#620): the direct-API person lookup fetches candidate bookings
// with `.ilike("attendee_email", email)`. ilike treats `_` and `%` in the
// address as wildcards, so `john_doe@x.com` also matches `johnXdoe@x.com`. The
// grader re-checks exact (lowercased) equality so no wrong-person action, but an
// unordered limit(20) can crowd out the true row and mis-decide `create`. This
// wrapper escapes the LIKE metacharacters so an escaped pattern matches only the
// literal address (still case-insensitively, so the trigram index still serves
// it). Pure -> runs under `node --experimental-strip-types`.
// Run: node --experimental-strip-types scripts/test-sql-like.ts
import { escapeLike } from "../src/lib/sql-like.ts";
import { assert, finish } from "./lib/harness.ts";

// Model Postgres (I)LIKE matching for the escaped pattern, so the tests assert
// real match behavior, not just the escaped string. `\` is the default LIKE
// escape char: `\_` and `\%` are literals; an unescaped `_`/`%` is a wildcard.
function ilikeMatches(pattern: string, value: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const next = pattern[++i] ?? "";
      re += next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "%") {
      re += ".*";
    } else if (c === "_") {
      re += ".";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, "i").test(value);
}

// The core bug: an underscore must not act as a wildcard once escaped.
{
  const pat = escapeLike("john_doe@example.com");
  assert(ilikeMatches(pat, "john_doe@example.com"), "underscore email matches itself");
  assert(!ilikeMatches(pat, "johnXdoe@example.com"), "underscore does NOT match an arbitrary char");
}

// Percent must not act as a multi-char wildcard once escaped.
{
  const pat = escapeLike("50%off@example.com");
  assert(ilikeMatches(pat, "50%off@example.com"), "percent email matches itself");
  assert(!ilikeMatches(pat, "50anythingoff@example.com"), "percent does NOT match arbitrary run");
}

// Case-insensitivity is preserved (grader compares lowercased; fetch must too).
{
  const pat = escapeLike("John_Doe@Example.com");
  assert(ilikeMatches(pat, "john_doe@example.com"), "escaped pattern still matches case-insensitively");
}

// A literal backslash in the address is itself escaped (won't consume the next).
{
  const pat = escapeLike("a\\_b@example.com");
  assert(ilikeMatches(pat, "a\\_b@example.com"), "literal backslash+underscore matches itself");
  assert(!ilikeMatches(pat, "a\\Xb@example.com"), "escaped underscore after backslash is still literal");
}

// A plain address (no metacharacters) is unchanged and matches only itself.
{
  const pat = escapeLike("jane@example.com");
  assert(pat === "jane@example.com", "plain email is passed through unchanged");
  assert(ilikeMatches(pat, "jane@example.com"), "plain email matches itself");
  assert(!ilikeMatches(pat, "janeXexample.com"), "plain email is not a wildcard match");
}

finish();
