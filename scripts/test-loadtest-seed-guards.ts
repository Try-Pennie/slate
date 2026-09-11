// What the load test seed REFUSES before it writes anything (#2243).
//
// Both refusals exist because a ten minute run judged against the wrong premise is
// expensive and looks exactly like a run judged against the right one.
//
// Run: node --experimental-strip-types scripts/test-loadtest-seed-guards.ts
import { migrationMismatch, readAgentCount } from "./loadtest/seed-guards.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const SHIPPED = ["0001", "0002", "0003", "0004"];

// --- the branch's schema ------------------------------------------------------

{
  eq(migrationMismatch(SHIPPED, SHIPPED, "0004"), null, "a branch holding exactly what ships passes");
  // Order of the applied list carries no meaning: PostgREST returns rows in
  // whatever order it likes (L343), so the highest is taken by sorting.
  eq(
    migrationMismatch(["0003", "0001", "0004", "0002"], SHIPPED, "0004"),
    null,
    "and the applied list may arrive in any order",
  );
}

{
  // The half that matters. A branch carrying the NEWEST file and missing one in the
  // middle has the right highest version, and comparing only that is the check that
  // looks right and passes on exactly the broken case (L570).
  const holed = ["0001", "0003", "0004"];
  const why = migrationMismatch(holed, SHIPPED, "0004");
  assert(why !== null, "a branch missing a migration in the middle is refused");
  assert(why!.includes("3 migrations"), "and the message says how many it has");
  assert(why!.includes("4"), "and how many it should have");
  // The other direction (L159): the highest version alone agrees, so the case above
  // is about the count rather than about the version.
  eq(
    [...holed].sort()[holed.length - 1],
    "0004",
    "the holed branch really does carry the newest file, which is why the count is needed",
  );
}

{
  const behind = ["0001", "0002", "0003"];
  assert(migrationMismatch(behind, SHIPPED, "0004") !== null, "a branch behind is refused");
  const ahead = ["0001", "0002", "0003", "0004", "0005"];
  assert(migrationMismatch(ahead, SHIPPED, "0004") !== null, "and so is one ahead");
}

{
  // A branch reporting NOTHING is its own message rather than an off-by-N: it was
  // either never migrated or its migration table could not be read, and neither is
  // a count somebody should reason about (L11).
  const why = migrationMismatch([], SHIPPED, "0004");
  assert(why !== null, "a branch reporting no migrations is refused");
  assert(
    why!.includes("never migrated") || why!.includes("could not be read"),
    "and is told which two things that could mean",
  );
  assert(!why!.includes("0 migrations (highest"), "rather than being reported as a count of zero");
  // And a checkout that ships none is refused too, in its own words: there would be
  // nothing to compare against, and "they match" would be vacuously true.
  const none = migrationMismatch(SHIPPED, [], "0004");
  assert(none !== null, "a checkout shipping no migrations is refused");
  assert(none !== why, "with a message of its own");
}

// --- the agent count ----------------------------------------------------------

{
  eq(readAgentCount(undefined, 200), 200, "an unset count takes the default");
  eq(readAgentCount("", 200), 200, "and so does an empty one");
  eq(readAgentCount("150", 200), 150, "a real number is used");
  // The L50 case: `Number("many")` is NaN, and NaN compares false against every
  // threshold, so a guard written as `n <= 0` waves it through and the roster ends
  // up NaN agents deep with every count still reading as a number.
  eq(readAgentCount("many", 200), null, "an unreadable count is refused by name, not left as NaN");
  eq(readAgentCount("0", 200), null, "a roster of nobody is refused");
  eq(readAgentCount("-5", 200), null, "and so is a negative one");
  eq(readAgentCount("12.5", 200), null, "and a fractional one");
  // `Number` accepts these and yields 1000, 16 and 12. A roster silently sixteen
  // agents deep is worse than a refusal somebody can read.
  eq(readAgentCount("1e3", 200), null, "exponent notation is refused rather than becoming 1000");
  eq(readAgentCount("0x10", 200), null, "and hex rather than becoming 16");
  eq(readAgentCount(" 12 ", 200), 12, "but ordinary surrounding space is fine");
}

finish();
