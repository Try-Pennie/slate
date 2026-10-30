// #4390: migration 0215, the per Eastern day count of program lead outcomes, proved in a
// REAL Postgres.
//
// What it proves, each beside a control the same statement passes (L1):
//
//   - bump_program_lead_outcome counts one occurrence of a kind on today's EASTERN day,
//     one row per (day, kind), answering the new total;
//   - two bumps in concurrent transactions are BOTH counted (an atomic upsert, never a
//     read then a write that loses one);
//   - only the kinds the code records are accepted (times_fallback, limit_refused);
//   - the table is closed to the web roles and the function is not executable by them.
//
// It replays EVERY migration into the supabase/postgres image, writes nothing outside
// that container, and removes it on the way out. Not named test-*.ts: it needs Docker.
// No Docker is exit 2, never a pass (L98).
//
// Run: node --experimental-strip-types scripts/verify-program-lead-outcomes-sql.ts
// (the DB replay workflow also runs it, with every other scripts/verify-*-sql.ts)
import { join } from "node:path";
import { firstErrorLine, replayEveryMigration, startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const IMAGE = process.env.PROGRAM_LEAD_OUTCOMES_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const pg = startThrowawayPostgres(`slate-program-lead-outcomes-${process.pid}`, IMAGE);
const { sql } = pg;

const bump = (kind: string) => sql(`select bump_program_lead_outcome('${kind}')::text;`, "service_role");
const count = (kind: string) =>
  sql(`select coalesce((select occurrences from program_lead_outcomes
        where kind = '${kind}' and day = (now() at time zone 'America/New_York')::date), 0)::text;`);

try {
  const applied = replayEveryMigration(pg, DIR);
  assert(applied > 200, `the schema for the outcome counts: every migration applied to an empty database (${applied})`);

  // --- counting ------------------------------------------------------------------------------
  eq(count("times_fallback"), "0", "control: nothing is counted before the first bump");
  eq(bump("times_fallback"), "1", "the first bump of a kind answers 1");
  eq(bump("times_fallback"), "2", "the second answers 2: one row, counted up");
  eq(count("times_fallback"), "2", "and the row for today's Eastern day holds 2");
  eq(bump("limit_refused"), "1", "another kind is its own row");
  eq(sql("select count(*)::text from program_lead_outcomes;"), "2", "one row per (day, kind)");
  eq(
    sql("select string_agg(day::text, ',') from (select distinct day from program_lead_outcomes) d;"),
    sql("select (now() at time zone 'America/New_York')::date::text;"),
    "the day is the Eastern day the bump happened on",
  );

  // --- concurrent bumps -----------------------------------------------------------------------
  const before = Number(count("times_fallback"));
  const racer = async () =>
    (
      await pg.session(`begin;
        select bump_program_lead_outcome('times_fallback');
        select pg_sleep(1);
        commit;`)
    ).code;
  eq(await Promise.all([racer(), racer(), racer()]), [0, 0, 0], "three concurrent bumps all ran to completion");
  eq(count("times_fallback"), String(before + 3), "and all three were counted: none lost to a concurrent write");

  // --- the kinds ------------------------------------------------------------------------------
  for (const bad of ["fallback", "", "TIMES_FALLBACK"]) {
    const err = pg.verboseError(`select bump_program_lead_outcome('${bad}');`, "service_role");
    assert(err !== null && /23514/.test(err), `the kind "${bad}" is refused (got ${firstErrorLine(err)})`);
  }

  // --- closed to the web roles ----------------------------------------------------------------
  for (const role of ["anon", "authenticated"]) {
    eq(sql("select count(*)::text from program_lead_outcomes;", role), "0", `${role} sees no rows (row security, default deny)`);
    const err = pg.verboseError("select bump_program_lead_outcome('times_fallback');", role);
    assert(err !== null && /42501|permission denied/.test(err), `${role} cannot bump a count (got ${firstErrorLine(err)})`);
  }
  eq(sql("select count(*)::text from program_lead_outcomes;", "service_role"), "2", "control: the server role reads the rows");
} finally {
  pg.stop();
}
finish();
