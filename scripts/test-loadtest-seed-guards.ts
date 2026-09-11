// What the load test seed REFUSES before it writes anything (#2243).
//
// Both refusals exist because a ten minute run judged against the wrong premise is
// expensive and looks exactly like a run judged against the right one.
//
// Run: node --experimental-strip-types scripts/test-loadtest-seed-guards.ts
import {
  migrationMismatch,
  readAgentCount,
  migrationReadRefusal,
  appliedVersionsFrom,
} from "./loadtest/seed-guards.ts";
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

// --- reading the branch's migrations at all (#2261) ---------------------------
//
// The seed shipped reading `supabase_migrations.schema_migrations` over the REST
// API, which exposes the `public` schema ONLY and answers 406 on every Supabase
// project. It died on its own check before writing a row, and a refusal that can
// never succeed is indistinguishable from the bad schema the check exists to
// catch. The read goes through `applied_migration_versions()` now, and each way
// it can fail says its own thing.

{
  eq(migrationReadRefusal(200, ""), null, "a 200 is not a refusal");
}

{
  const why = migrationReadRefusal(404, "")!;
  assert(why !== null, "a 404 is refused");
  assert(why.includes("0072"), "and names the migration that ships the function");
  assert(!why.includes("may not call"), "rather than blaming the key");
}

{
  for (const status of [401, 403]) {
    const why = migrationReadRefusal(status, "")!;
    assert(why.includes("secret key"), `a ${status} names the grant rather than the migration`);
    assert(!why.includes("0072"), `and a ${status} does not send anybody to check a migration`);
  }
}

{
  // The status the old read produced on every project. It gets its own sentence,
  // because seeing it again means something is calling the table rather than the
  // RPC, which is a different repair from every other failure here.
  const why = migrationReadRefusal(406, "")!;
  assert(why.includes("rather than the RPC"), "a 406 says something is reading the table");
}

{
  const why = migrationReadRefusal(500, "upstream exploded")!;
  assert(why.includes("500"), "any other status is named");
  assert(why.includes("upstream exploded"), "and carries what the server said");
  // No two of the refusals share a message, or one answers for another (L11). Six
  // statuses, six messages: 401 and 403 take the same branch and still name the
  // status they saw, which is what stops a reader hunting for the wrong one.
  const statuses = [404, 401, 403, 406, 500, 502];
  const all = statuses.map((s) => migrationReadRefusal(s, ""));
  eq(new Set(all).size, statuses.length, "no two statuses share a message");
  for (const s of statuses) {
    assert(migrationReadRefusal(s, "")!.includes(String(s)), `the ${s} refusal names its status`);
  }
}

{
  eq(
    (appliedVersionsFrom(["0001", "0002"]) as { versions: string[] }).versions.length,
    2,
    "an array of versions is read",
  );
  // Numbers come back as strings, because the comparison downstream is textual and
  // a mixed list would never match the shipped filenames.
  eq(
    (appliedVersionsFrom([1, 2]) as { versions: string[] }).versions[0],
    "1",
    "and every element is read as a string",
  );
  eq(
    (appliedVersionsFrom([]) as { versions: string[] }).versions.length,
    0,
    "an empty array is an empty branch, which migrationMismatch then refuses by name",
  );
}

{
  // A non-array is NOT an empty branch. Reading it as one hands migrationMismatch a
  // count of zero, which it reports as "never migrated or the migration table could
  // not be read": a true sentence about the wrong thing.
  for (const [label, body] of [
    ["an object", { versions: [] }],
    ["a string", "0119"],
    ["null", null],
    ["a number", 119],
  ] as const) {
    const got = appliedVersionsFrom(body);
    assert("why" in got, `${label} is refused rather than read as an empty branch`);
  }
  const why = (appliedVersionsFrom(null) as { why: string }).why;
  const empty = migrationMismatch([], SHIPPED, "0004")!;
  assert(why !== empty, "and its message is not the one an empty branch gets");
}

finish();
