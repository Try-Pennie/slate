// What the load test seed REFUSES before it writes anything (#2243).
//
// Both refusals exist because a ten minute run judged against the wrong premise is
// expensive and looks exactly like a run judged against the right one.
//
// Run: node --experimental-strip-types scripts/test-loadtest-seed-guards.ts
import {
  migrationMismatch,
  readAgentCount,
  resolveAgentCount,
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

// =============================================================================
// THE ROSTER SIZE COMES FROM THE SHAPE (#2320)
//
// `AGENTS` defaulted to 200 while the SHAPE the seed reproduces carries the
// measured count: 90 baked in, 94 on the 2026-09-14 export. The seed printed the
// shape's count in its own log line and then ignored it. On 2026-09-14 the first
// branch for the #2284 re-run came up with 200 bookable agents against
// production's 94, pool depths roughly double the real ones, and had to be thrown
// away and re-created.
//
// It fails GREEN, which is why it needs a guard rather than care: a roster of the
// wrong size seeds perfectly, every count reads as a number, and the run measures a
// shape nobody chose (L354). The shape's pool depths are also what the seeded
// output is CHECKED against, so a different total makes that check meaningless.
// =============================================================================

// --- no AGENTS: the shape decides -------------------------------------------------
{
  const r = resolveAgentCount({ rawAgents: undefined, shapeAgents: 94 });
  eq(r.count, 94, "an unset AGENTS takes the SHAPE's measured count, never a coded 200");
  eq(r.why, null, "and there is nothing to explain");
}
{
  eq(
    resolveAgentCount({ rawAgents: "", shapeAgents: 94 }).count,
    94,
    "and so does an empty one",
  );
}

// --- AGENTS agreeing with the shape ------------------------------------------------
{
  const r = resolveAgentCount({ rawAgents: "94", shapeAgents: 94 });
  eq(r.count, 94, "an explicit count that agrees with the shape is used");
  eq(r.why, null, "with nothing to explain");
}

// --- AGENTS disagreeing is REFUSED --------------------------------------------------
{
  // The pool depths the seeded output is checked against come from the shape, so a
  // different total makes that check meaningless. Refused by name rather than
  // seeded and discovered an hour later.
  const r = resolveAgentCount({ rawAgents: "200", shapeAgents: 94 });
  eq(r.count, null, "an explicit count that disagrees with the shape is refused");
  assert(/200/.test(r.why ?? ""), "naming what was asked for");
  assert(/94/.test(r.why ?? ""), "and what the shape says");
  assert(
    /ALLOW_AGENT_COUNT_MISMATCH/.test(r.why ?? ""),
    "and the override, so a deliberate experiment is not left guessing (L111)",
  );
}

// --- the named override lets a deliberate experiment through ---------------------------
{
  const r = resolveAgentCount({ rawAgents: "200", shapeAgents: 94, allowMismatch: true });
  eq(r.count, 200, "the override honours the explicit count");
  assert(
    /200/.test(r.why ?? "") && /94/.test(r.why ?? ""),
    "and SAYS the run is against a roster the shape does not describe, since a silent override " +
      "is the same defect wearing a flag",
  );
}
{
  // The override must not invent a count when none was given: it says a MISMATCH is
  // intended, which is a statement about two numbers, and there is only one here.
  const r = resolveAgentCount({ rawAgents: undefined, shapeAgents: 94, allowMismatch: true });
  eq(r.count, 94, "the override changes nothing when no count was given");
}

// --- an unreadable AGENTS is still refused by name ----------------------------------------
{
  for (const raw of ["many", "0", "1e3", "0x10", "-4"]) {
    const r = resolveAgentCount({ rawAgents: raw, shapeAgents: 94 });
    eq(r.count, null, `${JSON.stringify(raw)} is refused`);
    assert(
      !/does not match/.test(r.why ?? ""),
      `and ${JSON.stringify(raw)} is refused for being unreadable, not for disagreeing (L11)`,
    );
  }
}

// --- a shape that carries no usable count is its own refusal --------------------------------
{
  // The shape is the thing being reproduced, so a shape with no count is not a
  // reason to fall back to 200: that is the exact substitution this fixes.
  for (const shapeAgents of [0, -1, Number.NaN]) {
    const r = resolveAgentCount({ rawAgents: undefined, shapeAgents });
    eq(r.count, null, `a shape claiming ${shapeAgents} agents is refused`);
    assert(/shape/i.test(r.why ?? ""), "and the message says it is the shape that is unusable");
  }
}

// --- no two refusals say the same thing (L11) -----------------------------------------------
{
  const said = new Set<string>();
  const cases = [
    { rawAgents: "200", shapeAgents: 94 },
    { rawAgents: "many", shapeAgents: 94 },
    { rawAgents: undefined, shapeAgents: 0 },
  ];
  for (const c of cases) {
    const why = resolveAgentCount(c).why;
    assert(why !== null, "each of these refuses");
    assert(!said.has(why!), `each refusal has its own sentence: ${why}`);
    said.add(why!);
  }
  eq(said.size, cases.length, "no two refusals share a sentence");
}

finish();
