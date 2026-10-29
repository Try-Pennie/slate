// #3863: the reservation resume's lookup by key reaches an index, proved in a REAL Postgres.
//
// findLatestBookingByIdempotencyKey (#3847) reads the newest booking on a key in ANY
// status. The only index on bookings.idempotency_key used to be 0010's partial unique
// index over ACTIVE bookings, which a read with no status predicate cannot use, so the
// lookup scanned the whole table. Migration 0185 adds a plain index on the column.
//
// A text scan can say an index exists (scripts/test-idempotency-key-index.ts); only
// the planner can say it is USED. So this replays every migration BEFORE 0185 into the
// supabase/postgres image, seeds a production sized bookings table, and reads the plan
// of the lookup's exact shape: it must be a sequential scan there, which is the
// control that proves the check below can fail (L1). Then it applies 0185 verbatim in
// one transaction, as `supabase db push` runs a file, and reads the plan again: an
// index scan on the new index, with the key as its index condition. Sequential scans
// stay ON throughout, so the planner picks the index on cost, as it would in
// production, rather than because the alternative was switched off.
//
// It writes nothing outside that container, which it removes on the way out. Not named
// test-*.ts: it needs Docker. No Docker is exit 2, never a pass (L98).
//
// Run: node --experimental-strip-types scripts/verify-idempotency-key-index-sql.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { CLI_HISTORY_TABLE_SQL, migrationBatch, migrationPlan, replayMigrations } from "./lib/migration-replay.ts";
import { bookingSeriesInsertSql } from "./lib/seed-sql.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const INDEX_MIGRATION = "0185_bookings_idempotency_key_idx.sql";
const INDEX = "bookings_idempotency_key_idx";
const IMAGE = process.env.IDEMPOTENCY_KEY_INDEX_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const NAME = `slate-idempotency-key-index-${process.pid}`;

// Production held 10,586 bookings on 2026-10-16 (read only count). Seeded a little
// above that, so the planner's cost comparison is the one production makes today.
const ROWS = 12_000;

const ORG = "00000000-0000-0000-0000-0000000000a0";
const AGENT = "00000000-0000-0000-0000-00000000000a";
const ET = "00000000-0000-0000-0000-0000000000e1";
const BUCKET = "00000000-0000-0000-0000-000000000100";

// The lookup as PostgREST sends it for
//   .from("bookings").select("*").eq("idempotency_key", key)
//   .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1)
// The key arrives as a bind parameter, so the plan is read for a prepared statement
// under a GENERIC plan too: a custom plan sees the literal, a generic one does not.
const LOOKUP = `select * from public.bookings where public.bookings.idempotency_key = $1
  order by public.bookings.created_at desc, public.bookings.id desc limit 1`;
const KEY = "key-4321"; // a key the seed below holds twice: a cancelled booking and its rebook

/** The plan for the lookup, both custom (literal key) and generic (bind parameter). */
function plans(sql: (t: string) => string): { custom: string; generic: string } {
  const custom = sql(`explain ${LOOKUP.replace("$1", `'${KEY}'`)};`);
  const generic = sql(`
    set plan_cache_mode = force_generic_plan;
    prepare latest_by_key(text) as ${LOOKUP};
    explain execute latest_by_key('${KEY}');
  `);
  return { custom, generic };
}

const flat = (plan: string) => plan.replace(/\s+/g, " ").slice(0, 400);
// A plain index scan or a bitmap one: which the planner picks for two rows is its
// choice, and either reaches the rows through the index rather than the whole table.
const usesIndex = (plan: string) =>
  new RegExp(`(?:Index Scan using ${INDEX} on bookings|Bitmap Index Scan on ${INDEX})`).test(plan) &&
  /Index Cond: \(idempotency_key = /.test(plan);

const pg = startThrowawayPostgres(NAME, IMAGE);
const { sql } = pg;

try {
  // --- every migration BEFORE the index, as db push applied them ----------------------
  const plan = migrationPlan(readdirSync(DIR));
  if (!plan.ok) throw new Error(plan.error);
  const indexFile = plan.files.find((f) => f.file === INDEX_MIGRATION);
  assert(indexFile !== undefined, `${INDEX_MIGRATION} is on disk to apply`);
  if (!indexFile) throw new Error(`${INDEX_MIGRATION} missing`);
  const before = plan.files.filter((f) => f.version < indexFile.version);
  sql(CLI_HISTORY_TABLE_SQL);
  const applied = replayMigrations(before, (f) => readFileSync(join(DIR, f), "utf8"), (batch) => void sql(batch, undefined, { singleTransaction: true }));
  assert(applied > 180, `the schema before the index: every earlier migration applied to an empty database (${applied})`);

  // --- a production sized bookings table ----------------------------------------------
  // Every row at its own half hour on one agent, so the active overlap constraint
  // (0120) holds. Statuses mixed as production's are; every key distinct except one
  // pair, a cancelled booking and the same lead's rebook of that time.
  sql(`
    insert into organizations (id, name) values ('${ORG}', 'Index org');
    insert into users (id, org_id, email, role) values ('${AGENT}', '${ORG}', 'agent@trypennie.com', 'agent');
    insert into event_types (id, org_id, name, duration_min) values ('${ET}', '${ORG}', 'Call', 20);
    insert into buckets (id, org_id, code, name, event_type_id, is_test) values ('${BUCKET}', '${ORG}', '100', 'Low', '${ET}', false);
    ${bookingSeriesInsertSql({
      orgId: ORG,
      bucketId: BUCKET,
      eventTypeId: ET,
      assignedUserId: AGENT,
      rows: ROWS,
      start: `timestamptz '2027-01-01' + i * interval '30 minutes'`,
      status: `case when i = 4321 then 'cancelled' when i = ${ROWS} then 'confirmed'
        else (array['cancelled', 'completed', 'completed', 'confirmed'])[1 + i % 4] end`,
      idempotencyKey: `'key-' || case when i = ${ROWS} then 4321 else i end`,
      createdAt: `timestamptz '2026-01-01' + i * interval '10 minutes'`,
    })}
    analyze bookings;
  `);
  eq(sql(`select count(*) from bookings;`), String(ROWS), `the seed holds ${ROWS} bookings`);
  eq(sql(`select count(*) from bookings where idempotency_key = '${KEY}';`), "2", "and the looked up key holds two of them");

  // --- the control: before 0185, the lookup scans every booking ----------------------
  const old = plans(sql);
  for (const [mode, p] of Object.entries(old)) {
    assert(/Seq Scan on bookings/.test(p) && !usesIndex(p), `control, ${mode} plan before ${INDEX_MIGRATION}: a sequential scan of bookings (plan: ${flat(p)})`);
    assert(!/bookings_idempotency_active_uniq/.test(p), `control, ${mode} plan: the partial ACTIVE index cannot serve a read in any status`);
  }

  // --- why the migration is not CONCURRENTLY ------------------------------------------
  // db push runs a file in one transaction, and a concurrent build refuses to run
  // inside one, so a CONCURRENTLY migration would fail to apply at all.
  let concurrentRefusal = "";
  try {
    sql(`create index concurrently bookings_concurrent_probe on bookings (idempotency_key);`, undefined, { singleTransaction: true });
  } catch (err) {
    concurrentRefusal = String((err as { stderr?: string }).stderr ?? err);
  }
  assert(/cannot run inside a transaction block/.test(concurrentRefusal), `a concurrent build is refused in a single transaction, as db push would run it (got ${concurrentRefusal.split("\n")[0] || "success"})`);

  // --- 0185, verbatim, as db push applies it ------------------------------------------
  const t0 = Date.now();
  sql(migrationBatch(indexFile, readFileSync(join(DIR, INDEX_MIGRATION), "utf8")), undefined, { singleTransaction: true });
  console.log(`  note: ${INDEX_MIGRATION} built over ${ROWS} rows in ${Date.now() - t0}ms, psql round trip included`);
  sql(`analyze bookings;`);
  eq(sql(`select count(*) from pg_indexes where tablename = 'bookings' and indexname = '${INDEX}';`), "1", `${INDEX} exists`);
  // Read without a regclass cast, so an absent index fails this line and the plan
  // checks below still run and say what the lookup does instead.
  eq(sql(`select coalesce((select i.indisvalid::text from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = '${INDEX}'), 'absent');`), "true", "and is valid");

  // --- after 0185, the lookup reaches the index, with sequential scans still allowed --
  const fresh = plans(sql);
  for (const [mode, p] of Object.entries(fresh)) {
    assert(usesIndex(p), `${mode} plan after ${INDEX_MIGRATION}: an index scan on ${INDEX} with the key as its condition (plan: ${flat(p)})`);
    assert(!/Seq Scan on bookings/.test(p), `${mode} plan: no sequential scan of bookings (plan: ${flat(p)})`);
  }

  // And the answer is the one the reader wants: the newest booking on the key.
  eq(sql(`${LOOKUP.replace("$1", `'${KEY}'`)}`.replace("select *", "select status")), "confirmed", "the lookup answers the newest booking on the key, the rebook");
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  pg.stop();
}

if (process.exitCode === 1) process.exit(1);
finish();
