// #2702: the guarded `replace_user_schedule`, proved in a REAL Postgres.
//
// The activation import used to read an agent's week, judge it unset, ask cal.com,
// and then write: an admin save landing in between was overwritten with nothing
// said. Migration 0157 moves the condition into the write, and whether that holds
// is decided entirely by Postgres: the row lock, the compare against a null, the
// custom SQLSTATE, the rollback, and which of two concurrent writers wins. The
// offline suite has no database, and a fake agrees with whatever it is told (L52),
// so this starts a throwaway Postgres in Docker, lays down the slice of the schema
// the functions read, applies migrations 0117, 0129 and 0157 VERBATIM, and drives
// them, including two real concurrent sessions in both orders.
//
// It writes nothing outside that container, which it removes on the way out. It is
// deliberately not named test-*.ts: that glob is the offline unit suite, and this
// needs Docker. No Docker is exit 2, never a pass (L98).
//
// Run: pnpm verify:replace-user-schedule-guard
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const migration = (file: string) => readFileSync(join(ROOT, "supabase", "migrations", file), "utf8");
const IMAGE = process.env.REPLACE_USER_SCHEDULE_PG_IMAGE ?? "postgres:17-alpine";
const NAME = `slate-replace-user-schedule-${process.pid}`;

const USER = "00000000-0000-0000-0000-000000000001";
const SEED = `'[{"weekday":1,"start_minute":480,"end_minute":1020}]'::jsonb`;
const ADMIN = `'[{"weekday":2,"start_minute":540,"end_minute":900}]'::jsonb`;
const IMPORT = `'[{"weekday":3,"start_minute":420,"end_minute":960},{"weekday":4,"start_minute":420,"end_minute":960}]'::jsonb`;

const pg = startThrowawayPostgres(NAME, IMAGE);
const { sql, sqlError, session } = pg;

/** Put the agent back on a seeded week, stamped as given (null = unstamped). */
function reset(source: string | null): void {
  sql(`
    delete from availability_schedules;
    insert into availability_schedules (user_id, timezone) values ('${USER}', 'America/New_York');
    select replace_availability_rules((select id from availability_schedules), ${SEED}, 'seed');
    update availability_schedules set hours_source = ${source === null ? "null" : `'${source}'`};
  `);
}

const state = () =>
  sql(`select s.timezone || '|' || coalesce(s.hours_source, 'null') || '|' ||
         (select string_agg(weekday::text, ',' order by weekday) from availability_rules r where r.schedule_id = s.id)
       from availability_schedules s;`);

const guarded = (expected: string | null) =>
  `select replace_user_schedule('${USER}', 'America/Los_Angeles', ${IMPORT}, 'calcom-import', 2, ${expected === null ? "null" : `'${expected}'`});`;
const adminSave = `select replace_user_schedule('${USER}', 'America/Phoenix', ${ADMIN}, 'admin', 1);`;

try {
  // The slice of the schema the functions read, shaped as 0001 and 0074 declare it.
  sql(`
    create table availability_schedules (
      id         uuid primary key default gen_random_uuid(),
      user_id    uuid not null,
      timezone   text not null default 'America/New_York',
      created_at timestamptz not null default now()
    );
    create unique index availability_schedules_user_id_key on availability_schedules (user_id);
    create table availability_rules (
      id           uuid primary key default gen_random_uuid(),
      schedule_id  uuid not null references availability_schedules(id) on delete cascade,
      weekday      int not null check (weekday between 1 and 7),
      start_minute int not null check (start_minute between 0 and 1440),
      end_minute   int not null check (end_minute between 0 and 1440),
      check (end_minute > start_minute)
    );
  `);
  sql(migration("0117_hours_source.sql"));
  sql(migration("0129_replace_user_schedule.sql"));
  sql(migration("0157_replace_user_schedule_only_if_source.sql"));

  // --- both forms exist, so the deployed code keeps working when this is applied first ---
  eq(
    sql("select string_agg(pronargs::text, ',' order by pronargs) from pg_proc where proname = 'replace_user_schedule';"),
    "5,6",
    "the five argument form is kept beside the guarded six argument form",
  );
  eq(
    sql("select bool_and(proconfig::text like '%search_path=public, pg_catalog%') from pg_proc where proname = 'replace_user_schedule';"),
    "t",
    "both forms pin their search_path",
  );

  // --- the guard passes when the source is what the caller read ---
  reset("seed");
  eq(sql(guarded("seed")), "2", "a seed week guarded as seed is replaced, and the count comes back");
  eq(state(), "America/Los_Angeles|calcom-import|3,4", "zone, stamp and rules all land");

  reset(null);
  eq(sql(guarded(null)), "2", "an unstamped week guarded as unstamped (null) is replaced");
  eq(state(), "America/Los_Angeles|calcom-import|3,4", "and stamped calcom-import");

  // --- the guard refuses, with its own SQLSTATE, and writes NOTHING ---
  for (const [stored, expected] of [
    ["admin", "seed"],
    ["agent", "seed"],
    ["calcom-import", "seed"],
    ["seed", null],
    [null, "seed"],
  ] as const) {
    reset(stored);
    const before = state();
    const err = sqlError(`\\set VERBOSITY verbose\n${guarded(expected)}`);
    assert(err !== null && err.includes("SL409"),
      `stored ${String(stored)}, expected ${String(expected)}: refused with SL409 (got ${err})`);
    eq(state(), before, `stored ${String(stored)}, expected ${String(expected)}: zone, stamp and rules untouched`);
  }
  {
    sql("delete from availability_schedules;");
    const err = sqlError(`\\set VERBOSITY verbose\n${guarded("seed")}`);
    assert(err !== null && err.includes("SL409"), `no row: refused with SL409 rather than created (got ${err})`);
    eq(sql("select count(*) from availability_schedules;"), "0", "no row: nothing is created");
  }

  // Control: the unguarded five argument form is unchanged and overwrites as before.
  reset("admin");
  eq(sql(`select replace_user_schedule('${USER}', 'America/Los_Angeles', ${IMPORT}, 'calcom-import', 2);`), "2",
    "control: the five argument form still writes over any source (the daily importer's rule)");

  // --- the race itself, in two real concurrent sessions, both orders ---
  // An admin save commits FIRST, while the import is waiting on the row: the import
  // must see the admin's stamp and refuse.
  reset("seed");
  {
    const admin = session(`begin; ${adminSave} select pg_sleep(2); commit;`);
    await new Promise((r) => setTimeout(r, 700));
    const importer = session(`\\set VERBOSITY verbose\nbegin; ${guarded("seed")} commit;`);
    const [a, i] = await Promise.all([admin, importer]);
    eq(a.code, 0, "admin first: the admin save commits");
    assert(i.code !== 0 && i.stderr.includes("SL409"), `admin first: the import waits on the lock, then refuses with SL409 (got ${i.code} ${i.stderr})`);
    eq(state(), "America/Phoenix|admin|2", "admin first: the admin's week stands");
  }
  // The import takes the lock FIRST and an admin saves while it holds it: the admin
  // waits and then wins, which is the right order for a person's edit.
  reset("seed");
  {
    const importer = session(`begin; ${guarded("seed")} select pg_sleep(2); commit;`);
    await new Promise((r) => setTimeout(r, 700));
    const admin = session(`begin; ${adminSave} commit;`);
    const [i, a] = await Promise.all([importer, admin]);
    eq(i.code, 0, "import first: the import commits");
    eq(a.code, 0, "import first: the admin save waits, then commits");
    eq(state(), "America/Phoenix|admin|2", "import first: the admin's later save wins");
  }
} finally {
  pg.stop();
}

finish();
