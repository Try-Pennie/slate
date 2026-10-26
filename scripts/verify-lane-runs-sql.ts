// #4222: lane_runs, the cron lanes' claims on their ticks, proved in a REAL Postgres.
//
// A lane sent twice for one tick runs once only because the database lets exactly one
// insert of (tick_id, lane) succeed and answers every other one with 23505, the one
// error src/lib/monitor/lane-claim.ts reads as "already claimed". The offline suite
// (scripts/test-lane-claim.ts) drives a fake that behaves as a primary key is supposed to
// (L52), so this replays EVERY migration into the supabase/postgres image, which carries
// the platform's roles and default grants (L714), and asks Postgres itself, including
// two sessions inserting the same claim at the same moment.
//
// It writes nothing outside that container, which it removes on the way out. Not named
// test-*.ts: it needs Docker. No Docker is exit 2, never a pass (L98). The DB replay
// workflow runs it with every other scripts/verify-*-sql.ts.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/verify-lane-runs-sql.ts
import { join } from "node:path";
import { replayEveryMigration, startThrowawayPostgres, SERVER_ROLE } from "./lib/throwaway-postgres.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// Postgres's unique violation, the one code lane-claim.ts reads as "already claimed"
// (UNIQUE_VIOLATION there; scripts/test-lane-claim.ts pins the adapter to this literal).
// Spelled out rather than imported, so this suite reads nothing outside the replay
// workflow's paths gate.
const UNIQUE_VIOLATION = "23505";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const IMAGE = process.env.LANE_RUNS_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const NAME = `slate-lane-runs-${process.pid}`;

const pg = startThrowawayPostgres(NAME, IMAGE);
const { sql, sqlError, verboseError } = pg;

const claim = (tick: string, lane: string) => `insert into lane_runs (tick_id, lane) values ('${tick}', '${lane}');`;
const count = (where = "true") => sql(`select count(*) from lane_runs where ${where};`);

try {
  const applied = replayEveryMigration(pg, DIR);
  assert(applied > 200, `every migration applied to an empty database (${applied})`);

  // --- one claim per lane per tick, as the server's own client -----------------------------
  eq(sql(claim("abc123", "sync"), SERVER_ROLE), "", "the first claim of a lane on a tick is recorded");
  const second = verboseError(claim("abc123", "sync")) ?? "";
  assert(second.includes(UNIQUE_VIOLATION), `a second claim of the same lane on the same tick is refused as ${UNIQUE_VIOLATION} (${second.split("\n")[0]})`);
  assert(/lane_runs_pkey/.test(second), "by the primary key, the constraint the claim depends on");
  eq(count("tick_id = 'abc123' and lane = 'sync'"), "1", "one claim stands");
  eq(sql(claim("abc123", "recompute"), SERVER_ROLE), "", "control: another lane on the same tick is its own claim");
  eq(sql(claim("abc124", "sync"), SERVER_ROLE), "", "control: the same lane on the next tick is its own claim");

  // --- only what the dispatcher mints -------------------------------------------------------
  for (const [tick, lane, what] of [
    ["ABC123", "sync", "an upper case tick id"],
    ["", "sync", "an empty tick id"],
    ["a".repeat(33), "sync", "a tick id past 32 characters"],
    ["abc125", "prune-routing", "a lane named by its path rather than laneFieldName"],
    ["abc125", "", "an empty lane"],
  ] as const) {
    const refused = verboseError(claim(tick, lane)) ?? "";
    assert(refused.includes("23514"), `${what} is refused by a check constraint (${refused.split("\n")[0]})`);
  }

  // --- two deliveries at the same moment ------------------------------------------------------
  // Each session holds its transaction open past the other's insert, so the second insert
  // has to wait on the first's uncommitted key and is then refused when it commits.
  const racer = () =>
    pg.session(`begin;
      set local role ${SERVER_ROLE};
      ${claim("c0ffee", "outbox")}
      select pg_sleep(1);
      commit;`);
  const raced = await Promise.all([racer(), racer()]);
  eq(raced.map((r) => r.code === 0).sort(), [false, true], "of two concurrent claims of one lane on one tick, exactly one commits");
  const loser = raced.find((r) => r.code !== 0);
  assert(/duplicate key value violates unique constraint "lane_runs_pkey"/.test(loser?.stderr ?? ""), `and the other is refused by the primary key (${(loser?.stderr ?? "").trim().split("\n")[0]})`);
  eq(count("tick_id = 'c0ffee'"), "1", "leaving one claim");

  // A claim whose transaction never commits (the request died before the insert landed)
  // must not hold the tick: the waiting delivery then claims it and runs.
  const crashed = pg.session(`begin;
      set local role ${SERVER_ROLE};
      ${claim("dead01", "selfheal")}
      select pg_sleep(1);
      rollback;`);
  const waiting = pg.session(`select pg_sleep(0.3);
      set role ${SERVER_ROLE};
      ${claim("dead01", "selfheal")}`);
  const [c, w] = await Promise.all([crashed, waiting]);
  eq([c.code, w.code], [0, 0], "a claim rolled back leaves the tick free, and the delivery waiting on it claims it");
  eq(count("tick_id = 'dead01'"), "1", "one claim, the waiting delivery's");

  // --- retention ------------------------------------------------------------------------------
  sql(`insert into lane_runs (tick_id, lane, claimed_at) values ('01d0', 'sync', now() - interval '3 days'), ('01d1', 'sync', now() - interval '1 day');`);
  eq(sql("with d as (delete from lane_runs where claimed_at < now() - interval '2 days' returning 1) select count(*) from d;", SERVER_ROLE), "1", "the prune's delete removes a claim past two days, as the server's client");
  eq(count("tick_id = '01d1'"), "1", "and keeps one inside them");
  eq(sql("select indexdef from pg_indexes where indexname = 'lane_runs_claimed_at_idx';").includes("(claimed_at)"), true, "the prune's range is indexed");

  // --- only the server may write or read ------------------------------------------------------
  eq(sql("select relrowsecurity from pg_class where relname = 'lane_runs';"), "t", "RLS is on");
  for (const role of ["anon", "authenticated"]) {
    assert(/row-level security|permission denied/.test(sqlError(claim("abc999", "sync"), role) ?? ""), `${role} cannot claim a tick`);
    eq(sql("select count(*) from lane_runs;", role), "0", `${role} reads no claims`);
  }
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  pg.stop();
}

if (process.exitCode === 1) process.exit(1);
finish();
