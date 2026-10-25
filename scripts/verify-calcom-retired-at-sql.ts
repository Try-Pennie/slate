// #3896: migration 0203's `calcom_retired_at` backfill and trigger, proved in a REAL Postgres.
//
// When cal.com was marked retired decides when the cal.com anchor stops holding the learned
// low volume floors up (`ANCHOR_OVERLAP_WEEKS`), and only the database writes it. The offline
// suites read the migration's text; this runs it. It replays every migration BEFORE 0203 into
// the supabase/postgres image (L714), sets cal.com retired with a history of presses, applies
// 0203 so its backfill runs, then drives the switch the way `setCalcomRetired` does (a
// PostgREST upsert naming only the columns it sends) and checks the stamp after every write.
//
// It writes nothing outside that container and one temporary folder, both removed on the way
// out. Not named test-*.ts: it needs Docker. No Docker is exit 2, never a pass (L98).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/verify-calcom-retired-at-sql.ts
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigration, replayEveryMigration, startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const UNDER_TEST = "0203_calcom_retired_at.sql";
const IMAGE = process.env.CALCOM_RETIRED_AT_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const NAME = `slate-calcom-retired-at-${process.pid}`;
const ORG = "00000000-0000-0000-0000-0000000000c0";

// tree-write-ok: a real mkdtemp folder under tmpdir(), removed in finally.
const before = mkdtempSync(join(tmpdir(), "slate-calcom-retired-at-"));
for (const f of readdirSync(DIR)) {
  if (f.endsWith(".sql") && f < UNDER_TEST) copyFileSync(join(DIR, f), join(before, f));
}

const pg = startThrowawayPostgres(NAME, IMAGE);
const { sql } = pg;

const at = (hm: string) => `2026-10-01T${hm}:00Z`;
/** The stamp as an ISO minute in UTC, or "null". */
const stamp = () =>
  sql(`select coalesce(to_char(calcom_retired_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'), 'null') from monitor_alert_config where id = 1;`);
/** Exactly what supabase-js's upsert in `setCalcomRetired` sends: only these columns. */
const press = (retired: boolean) =>
  sql(`insert into monitor_alert_config (id, calcom_retired, updated_at) values (1, ${retired}, now())
         on conflict (id) do update set calcom_retired = excluded.calcom_retired, updated_at = excluded.updated_at;`);
const audit = (when: string, from: boolean | null, to: boolean) =>
  sql(`insert into audit_log (org_id, action, details, created_at)
         values ('${ORG}', 'monitor.calcom_retired', '${JSON.stringify({ from, to })}'::jsonb, '${when}');`);
/** Whether the stamp is within a minute of the database's clock, for writes stamped now(). */
const stampedNow = () =>
  sql(`select abs(extract(epoch from (calcom_retired_at - now()))) < 60 from monitor_alert_config where id = 1;`);

try {
  const applied = replayEveryMigration(pg, before);
  assert(applied > 190, `every migration before 0203 applied to an empty database (${applied})`);
  sql(`insert into organizations (id, name) values ('${ORG}', 'Retirement org');`);

  // --- the backfill: the last press that moved the switch INTO retired ------------------------
  sql(`insert into monitor_alert_config (id, calcom_retired) values (1, true);`);
  audit(at("09:00"), false, true); // retired
  audit(at("10:00"), true, false); // put back
  audit(at("11:00"), false, true); // retired again: the one that counts
  audit(at("12:00"), true, true); // a repeat press, which must not move it
  sql(readMigration(UNDER_TEST), undefined, { singleTransaction: true });
  eq(stamp(), "2026-10-01T11:00", "the backfill takes the last move into retired, not the first or a repeat press");

  // --- while retired, the stamp holds ---------------------------------------------------------
  press(true);
  eq(stamp(), "2026-10-01T11:00", "pressing retire again keeps the first stamp");
  sql(`update monitor_alert_config set floor_30 = 4, updated_at = now() where id = 1;`);
  eq(stamp(), "2026-10-01T11:00", "saving another setting on the row keeps it");
  sql(`update monitor_alert_config set calcom_retired_at = '${at("08:30")}' where id = 1;`);
  eq(stamp(), "2026-10-01T08:30", "a date written while retired is kept, so it can be corrected");
  sql(`update monitor_alert_config set calcom_retired_at = null where id = 1;`);
  eq(stamp(), "2026-10-01T08:30", "and it can never be cleared while cal.com stays retired");

  // --- putting cal.com back clears it; retiring again stamps now ----------------------------
  press(false);
  eq(stamp(), "null", "putting cal.com back clears the stamp");
  sql(`update monitor_alert_config set calcom_retired_at = '${at("08:30")}' where id = 1;`);
  eq(stamp(), "null", "and a date written while cal.com is live is refused as null");
  press(true);
  eq(stampedNow(), "t", "retiring again stamps the moment of the press");
  press(false);
  sql(`update monitor_alert_config set calcom_retired = true, calcom_retired_at = '${at("07:00")}' where id = 1;`);
  eq(stamp(), "2026-10-01T07:00", "a write that retires and names the date keeps the date it names");

  // --- the row's first write -----------------------------------------------------------------
  sql(`delete from monitor_alert_config where id = 1;`);
  press(true);
  eq(stampedNow(), "t", "a first write that retires cal.com stamps now");
  sql(`delete from monitor_alert_config where id = 1;`);
  press(false);
  eq(stamp(), "null", "a first write with cal.com live leaves it null");

  // --- the function is the pinned, invoker kind the guards expect -----------------------------
  eq(
    sql(`select prosecdef::text || '|' || array_to_string(proconfig, ',') from pg_proc where proname = 'monitor_alert_config_stamp_calcom_retired';`),
    "false|search_path=public",
    "the trigger function runs as the invoker with its search_path pinned",
  );
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  pg.stop();
  rmSync(before, { recursive: true, force: true });
}

if (process.exitCode === 1) process.exit(1);
finish();
