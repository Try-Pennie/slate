/**
 * #1433: the migration drift gate may not report green on output it never read.
 *
 * The gate exists because deploys do NOT apply migrations, so code shipping ahead
 * of its schema has to be caught before merge. #766 already rewrote it once, for
 * exactly this class: it used to `exit 0` on a missing secret, passing green in
 * about nine seconds having verified nothing.
 *
 * Three more of the same shape were found on 2026-08-12, all in the parsing:
 *
 *   1. `supabase migration list --linked | tee` returns TEE's exit code, so a
 *      failing list call left an empty file the parser read as "nothing unapplied";
 *   2. zero parsed rows was success, when it is the state that arrives exactly when
 *      the check has not really run (L98);
 *   3. the parser split every line on `|` and read "digits in field 1, blank field
 *      2" as an unapplied migration, which matches the CLI's OWN upgrade notice.
 *      Reproduced against the version CI pins, so this was live.
 *
 * The parse lives in a module with this suite rather than inline in workflow YAML,
 * the way check-main-push.ts already splits its decision out, because a rule inside
 * a `run:` block is a rule nothing can test.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-migration-drift-parse.ts
 */
import { readMigrationRows, migrationDriftVerdict } from "./lib/migration-drift.ts";
import { parseLock } from "./lib/migration-content.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/** What the CLI really prints, header and all. */
const HEADER = `
        Local          | Remote         | Time (UTC)         
  ----------------|----------------|---------------------`;

const APPLIED = `${HEADER}
   0099  | 0099   | 0099       
   0100  | 0100   | 0100       
   0101  | 0101   | 0101       
`;

const UNAPPLIED = `${HEADER}
   0100  | 0100   | 0100       
   0101  |        |            
`;

/** The line that made this a live defect. It carries digits and no pipes at all. */
const NOTICE =
  "\nA new version of Supabase CLI is available: v2.114.0 (currently installed v2.84.2)\n" +
  "We recommend updating regularly for new features and bug fixes: https://supabase.com/docs\n";

// --------------------------------------------------------------- the rows

{
  const rows = readMigrationRows(APPLIED);
  eq(rows.length, 3, "every migration row is read");
  eq(rows[2], { local: "0101", remote: "0101" }, "with both sides");

  const missing = readMigrationRows(UNAPPLIED);
  eq(missing.length, 2, "an unapplied row is still a row");
  eq(missing[1], { local: "0101", remote: null }, "and its remote side reads as absent");
}

// The upgrade notice, which is the one that was actually firing.
{
  const rows = readMigrationRows(APPLIED + NOTICE);
  eq(rows.length, 3, "the CLI's own upgrade notice is not a migration row");
  const verdict = migrationDriftVerdict(APPLIED + NOTICE);
  eq(verdict.ok, true, "so a fully applied database does not report drift because of it");
}

// And every other thing a CLI puts on the same stream.
for (const noise of [
  "WARN: something happened",
  "Connecting to remote database...",
  "Finished supabase link.",
  "  Local  | Remote | Time (UTC)",
  "  ----------------|----------------|---------------------",
]) {
  eq(
    readMigrationRows(`${APPLIED}\n${noise}\n`).length,
    3,
    `${JSON.stringify(noise)} is not read as a migration row`,
  );
}

// --------------------------------------------------------- the verdict

{
  const ok = migrationDriftVerdict(APPLIED);
  eq(ok.ok, true, "a fully applied database passes");
  eq(ok.unapplied, [], "with nothing outstanding");
  assert(ok.reason.includes("3"), `and says how many rows it actually read (got: ${ok.reason})`);

  const drift = migrationDriftVerdict(UNAPPLIED);
  eq(drift.ok, false, "an unapplied migration fails");
  eq(drift.unapplied, ["0101"], "and is named, so the reader knows which");
}

// The direction the whole issue is about. Finding NOTHING is not finding nothing
// wrong: an empty read arrives exactly when the CLI failed, which is the moment a
// green verdict is most likely to be believed and acted on (L98).
{
  for (const [label, output] of [
    ["empty output", ""],
    ["whitespace only", "   \n\n  "],
    ["a header and no rows", HEADER],
    ["only the upgrade notice", NOTICE],
    ["an error message", "Unexpected error retrieving remote project status: error code: 502"],
  ] as [string, string][]) {
    const v = migrationDriftVerdict(output);
    eq(v.ok, false, `${label} is NOT a pass`);
    assert(
      /no migration rows|could not/i.test(v.reason),
      `${label} says it read nothing rather than that everything is applied (got: ${v.reason})`,
    );
    eq(v.unapplied, [], `${label} claims no specific migration, because it saw none`);
  }
}

// Both directions, or a verdict hard-wired to fail would satisfy every case above
// while blocking every deploy (L1).
assert(
  migrationDriftVerdict(APPLIED).ok && !migrationDriftVerdict(UNAPPLIED).ok,
  "the verdict really distinguishes an applied database from a drifted one",
);

// --- the lock's intention has to become a fact, and this is what notices (#1642) --------
//
// A lock entry may say `pending`, meaning the content is recorded and the apply has not
// happened. That is what makes the documented order followable. It is only safe because
// something insists the intention is converted, and the only place that can know is here:
// this gate reads the REMOTE, so it is the one check that can see a migration is applied
// while the lock still calls it an intention.
//
// A pending entry for a migration the remote has NOT got is correct and passes: that is the
// state a branch is legitimately pushed in.
{
  const pendingLock = parseLock("0099 a pending\n0100 b\n0101 c pending\n");

  const stillPending = migrationDriftVerdict(UNAPPLIED, pendingLock);
  eq(
    stillPending.unapplied,
    ["0101"],
    "an unapplied migration whose entry is pending is the ordinary state, reported as unapplied",
  );

  const appliedButPending = migrationDriftVerdict(APPLIED, pendingLock);
  eq(appliedButPending.ok, false, "an APPLIED migration whose entry still says pending fails");
  assert(
    /0099/.test(appliedButPending.reason),
    `and names it (got: ${appliedButPending.reason})`,
  );
  assert(
    /update-migration-lock/.test(appliedButPending.reason),
    "and names the command that converts it, so the reader is not left guessing",
  );
  assert(
    !/not applied/.test(appliedButPending.reason),
    "and does not read as an unapplied migration, which is a different thing to go and do",
  );

  // The control: with every entry a fact, the same applied output passes. Without this the
  // assertion above is satisfied by a gate that fails on everything.
  const confirmed = migrationDriftVerdict(APPLIED, parseLock("0099 a\n0100 b\n0101 c\n"));
  eq(confirmed.ok, true, "CONTROL: the same applied database passes once the lock records facts");

  // And with no lock handed in at all, the gate judges exactly what it always did, so a
  // caller that has not been updated is not silently checking less than it reports.
  eq(migrationDriftVerdict(APPLIED).ok, true, "no lock passed means the original verdict, unchanged");
}

finish();
