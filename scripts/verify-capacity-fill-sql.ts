// #4102: record_capacity_fill, proved in a REAL Postgres.
//
// The half hourly booking pace readings depend on what the database does with a run's write:
// the first run of a half hour writes, a second run of the same half hour writes nothing even
// after the calendar changed, a run that read an older snapshot writes nothing, and two runs at
// once leave one set of rows with exactly one of them told it wrote. The offline suite drives a
// fake that agrees with whatever it is told (L52), so this replays EVERY migration into the
// supabase/postgres image, which carries the platform's roles and default grants (L714), and
// drives the function itself.
//
// It writes nothing outside that container, which it removes on the way out. Not named
// test-*.ts: it needs Docker. No Docker is exit 2, never a pass (L98).
//
// Run: pnpm verify:capacity-fill-sql
import { join } from "node:path";
import { replayEveryMigration, startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const IMAGE = process.env.CAPACITY_FILL_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const NAME = `slate-capacity-fill-${process.pid}`;
const ORG = "00000000-0000-0000-0000-0000000000a0";
const ORG2 = "00000000-0000-0000-0000-0000000000b0";

const pg = startThrowawayPostgres(NAME, IMAGE);
const { sql, sqlError } = pg;

const ts = (hm: string) => `2026-10-20T${hm}:00Z`;
const reading = (day: string, over: Record<string, unknown> = {}) => ({
  day,
  day_position: 0,
  slot_of_day: 24,
  weekday: 2,
  prev_read_at: null,
  taken: null,
  taken_reason: "first-reading",
  open: 10,
  capacity: 16,
  comparable_share: null,
  excluded_not_syncing: 0,
  excluded_left_pool: 0,
  excluded_capacity_changed: 0,
  ...over,
});
const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
const stamp = (v: string | null) => (v === null ? "null" : `'${v}'::timestamptz`);
/** The function's own answer, as psql prints a boolean. */
const record = (readAt: string, prev: string | null, rows: unknown[], last: unknown[], org = ORG) =>
  sql(`select record_capacity_fill('${org}', ${stamp(readAt)}, ${stamp(prev)}, ${lit(rows)}, ${lit(last)});`);
const dump = () =>
  sql(`select coalesce(json_agg(r order by r.org_id, r.read_at, r.day), '[]') from (
         select org_id, read_at, day, taken, taken_reason, open, capacity, prev_read_at from capacity_fill_readings) r;`) +
  sql(`select coalesce(json_agg(l order by l.org_id, l.day), '[]') from (select org_id, day, read_at, snapshot from capacity_fill_last) l;`);
const lastAt = (day: string, org = ORG) => sql(`select to_char(read_at at time zone 'UTC', 'HH24:MI') from capacity_fill_last where org_id = '${org}' and day = '${day}';`);

try {
  const applied = replayEveryMigration(pg, DIR);
  assert(applied > 190, `every migration applied to an empty database (${applied})`);
  sql(`insert into organizations (id, name) values ('${ORG}', 'Fill org'), ('${ORG2}', 'Other org');`);

  // --- the first run writes ---------------------------------------------------------------
  eq(record(ts("15:30"), null, [reading("2026-10-20"), reading("2026-10-21", { day_position: 1 })], [{ day: "2026-10-20", snapshot: { u1: { open: 10, capacity: 16, fp: "a" } } }, { day: "2026-10-21", snapshot: {} }]), "t", "the first run of an org writes");
  eq(sql(`select count(*) from capacity_fill_readings where org_id = '${ORG}';`), "2", "a reading per day");
  eq(lastAt("2026-10-20"), "15:30", "and a snapshot per day at its half hour");

  // --- a rerun of the same half hour writes nothing, whatever changed ------------------------
  const before = dump();
  const changed = [reading("2026-10-20", { open: 3 })];
  const changedLast = [{ day: "2026-10-20", snapshot: { u1: { open: 3, capacity: 16, fp: "b" } } }];
  eq(record(ts("15:30"), null, changed, changedLast), "f", "a rerun that read no snapshot (another run wrote first) writes nothing");
  eq(record(ts("15:30"), ts("15:30"), changed, changedLast), "f", "a rerun of the half hour the org already holds writes nothing");
  eq(dump(), before, "every reading and snapshot is unchanged after a rerun with other numbers");

  // --- the next half hour moves on, only from the snapshot it read ----------------------------
  eq(record(ts("16:30"), ts("15:00"), changed, changedLast), "f", "a run that read an older snapshot than the org holds writes nothing");
  eq(dump(), before, "and changes nothing");
  const measured = reading("2026-10-20", { slot_of_day: 25, prev_read_at: ts("15:30"), taken: 1.25, taken_reason: null, comparable_share: 0.8 });
  eq(record(ts("16:00"), ts("15:30"), [measured], [{ day: "2026-10-20", snapshot: { u1: { open: 9, capacity: 15, fp: "a" } } }]), "t", "the next half hour, from the snapshot the org holds, writes");
  eq(sql(`select taken::text || '|' || comparable_share::text from capacity_fill_readings where read_at = '${ts("16:00")}';`), "1.25|0.8", "taken and the share are kept as measured");
  eq([lastAt("2026-10-20"), lastAt("2026-10-21")], ["16:00", "15:30"], "only the days written move on");
  // A day that dropped out of a run and came back is not stuck behind the org's latest.
  eq(record(ts("16:30"), ts("16:00"), [], [{ day: "2026-10-21", snapshot: {} }]), "t", "a later run writes");
  eq(lastAt("2026-10-21"), "16:30", "and moves a day whose snapshot was older than the org's latest");

  // --- one org's write never touches another's ------------------------------------------------
  eq(record(ts("16:30"), null, [reading("2026-10-20")], [{ day: "2026-10-20", snapshot: {} }], ORG2), "t", "another org's first run writes");
  eq(lastAt("2026-10-20"), "16:00", "and leaves the first org's snapshot where it was");

  // --- a reading once written is never rewritten ---------------------------------------------
  // Only reachable when a write carried readings without their snapshots, so the org check
  // cannot see them: the insert itself must still keep the first.
  eq(record(ts("17:30"), ts("16:30"), [reading("2026-10-20", { open: 7 })], [], ORG2), "t", "a write of readings alone");
  eq(record(ts("17:30"), ts("16:30"), [reading("2026-10-20", { open: 2 })], [], ORG2), "t", "passes the org check a second time");
  eq(sql(`select open from capacity_fill_readings where org_id = '${ORG2}' and read_at = '${ts("17:30")}';`), "7", "and the reading first written is kept");

  // --- the table refuses a reading that is not one ---------------------------------------------
  assert(/capacity_fill_readings_taken_or_reason/.test(sqlError(`select record_capacity_fill('${ORG}', ${stamp(ts("17:00"))}, ${stamp(ts("16:30"))}, ${lit([reading("2026-10-20", { taken_reason: null })])}, '[]'::jsonb);`) ?? ""), "a reading with neither taken nor a reason is refused");
  assert(/capacity_fill_readings_taken_or_reason/.test(sqlError(`select record_capacity_fill('${ORG}', ${stamp(ts("17:00"))}, ${stamp(ts("16:30"))}, ${lit([reading("2026-10-20", { taken: 0 })])}, '[]'::jsonb);`) ?? ""), "a reading with both taken and a reason is refused");
  assert(/read_at_check/.test(sqlError(`select record_capacity_fill('${ORG}', ${stamp("2026-10-20T17:08:00Z")}, ${stamp(ts("16:30"))}, ${lit([reading("2026-10-20")])}, '[]'::jsonb);`) ?? ""), "a reading off the half hour is refused");
  eq(lastAt("2026-10-21"), "16:30", "and a refused write leaves the snapshots where they were");

  // --- two runs at once: one writes, one is told it did not ------------------------------------
  sql("create table race_result (wrote boolean);");
  const racer = async () =>
    (
      await pg.session(`begin;
        insert into race_result select record_capacity_fill('${ORG}', '${ts("17:00")}'::timestamptz, '${ts("16:30")}'::timestamptz,
          ${lit([reading("2026-10-20", { slot_of_day: 26 })])}, ${lit([{ day: "2026-10-20", snapshot: {} }])});
        select pg_sleep(1);
        commit;`)
    ).code;
  eq(await Promise.all([racer(), racer()]), [0, 0], "both concurrent runs committed");
  eq(sql("select string_agg(wrote::text, ',' order by wrote) from race_result;"), "false,true", "exactly one concurrent run is told it wrote");
  eq(sql(`select count(*) from capacity_fill_readings where org_id = '${ORG}' and read_at = '${ts("17:00")}';`), "1", "and the half hour holds one set of readings");

  // --- only the server may write or read --------------------------------------------------------
  eq(sql("select string_agg(relname || '=' || relrowsecurity::text, ',' order by relname) from pg_class where relname in ('capacity_fill_readings', 'capacity_fill_last');"), "capacity_fill_last=true,capacity_fill_readings=true", "RLS is on for both tables");
  for (const role of ["anon", "authenticated"]) {
    assert(/permission denied for function record_capacity_fill/.test(sqlError(`select record_capacity_fill('${ORG}', now(), null, '[]'::jsonb, '[]'::jsonb);`, role) ?? ""), `${role} cannot run record_capacity_fill`);
    eq(sql("select count(*) from capacity_fill_readings;", role), "0", `${role} reads no readings`);
    eq(sql("select count(*) from capacity_fill_last;", role), "0", `${role} reads no snapshots`);
  }
  eq(sql(`select record_capacity_fill('${ORG}', '${ts("23:30")}'::timestamptz, '${ts("16:00")}'::timestamptz, '[]'::jsonb, '[]'::jsonb);`, "service_role"), "f", "control: service_role, the server's client, can run it");
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  pg.stop();
}

if (process.exitCode === 1) process.exit(1);
finish();
