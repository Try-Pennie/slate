// #3090: the audit_log hash chain, proved in a REAL Postgres.
//
// The chain is built inside the database (migration 0160) and re-derived in the
// Worker (src/lib/monitor/audit-chain.ts). Both halves have to produce the same
// bytes, and the offline suite can prove neither: it has no database, and a mocked
// client agrees with whatever it is told (L52). So this starts a throwaway Postgres
// in Docker, lays down the slice of the schema the migration reads plus the 0089
// append only triggers it works around, applies 0160 VERBATIM, and drives it:
//
//   - the backfill chains rows that existed before it, and the Worker's hash agrees
//     with every one, read back the way PostgREST renders them, in three time zones;
//   - inserts after it are chained by the trigger, whatever the caller supplied;
//   - concurrent inserts, a rolled back insert and a refused insert leave the
//     sequence with no fork and no gap;
//   - the append only guard still refuses an UPDATE;
//   - every way of tampering the verifier names is caught, by the verifier's own
//     walk over the real rows: an edited row, a deleted row, a chain recomputed
//     after an edit, and rows cut off the end;
//   - a second run of the migration changes nothing.
//
// It also prints the vector `scripts/test-audit-chain.ts` pins, measured here, so
// the offline suite fails if either side's encoding drifts (L48).
//
// It writes nothing outside that container, which it removes on the way out. It is
// deliberately not named test-*.ts: that glob is the offline unit suite, and this
// needs Docker. No Docker is exit 2, never a pass (L98).
//
// Run: pnpm verify:audit-chain-sql
import { readMigration, startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  AUDIT_CHAIN_START,
  chainLink,
  walkAuditChain,
  type AuditChainPosition,
  type AuditChainRow,
} from "../src/lib/monitor/audit-chain.ts";
import { AUDIT_CHAIN_VECTOR } from "./lib/audit-chain-vector.ts";

const APPEND_ONLY = readMigration("0089_tamper_evident_audit.sql");
const CHAIN = readMigration("0160_audit_log_hash_chain.sql");
const IMAGE = process.env.AUDIT_CHAIN_PG_IMAGE ?? "postgres:17-alpine";
const NAME = `slate-audit-chain-${process.pid}`;

const pg = startThrowawayPostgres(NAME, IMAGE);
const { sql, sqlError } = pg;

/** The rows as PostgREST would hand them to the lane: json, details cast to text. */
function readRows(timezone = "UTC"): AuditChainRow[] {
  const out = sql(`
    set timezone = '${timezone}';
    select coalesce(json_agg(t order by t.chain_seq), '[]') from (
      select id, org_id, actor_id, action, target_id, details::text as details,
             created_at, chain_seq, chain_hash
        from audit_log
    ) t;
  `);
  return JSON.parse(out) as AuditChainRow[];
}

/** Walk the whole chain the way the lane does, a few rows a tick, from `position`. */
async function walkAll(position: AuditChainPosition, timezone = "UTC") {
  const all = readRows(timezone);
  const limit = 2;
  let at = position;
  for (let tick = 0; tick < 1000; tick++) {
    const rows = all.filter((r) => r.chain_seq > at.passSeq).slice(0, limit);
    const walk = await walkAuditChain(at, rows, limit);
    if (walk.status !== "progressing") return walk;
    at = walk.next;
  }
  throw new Error("the walk never reached the end of the chain");
}

function insertRow(action: string): void {
  sql(`insert into audit_log (org_id, actor_id, action, details)
       values ((select id from organizations), (select id from users limit 1), '${action}', '{"n": 1}');`);
}

try {
  // The slice of the schema 0160 reads, shaped as 0020 declares it, plus the two
  // API roles its REVOKEs name.
  sql(`
    create role anon; create role authenticated;
    create table organizations (id uuid primary key default gen_random_uuid());
    insert into organizations default values;
    create table users (id uuid primary key default gen_random_uuid());
    insert into users default values;
    create table audit_log (
      id          uuid primary key default gen_random_uuid(),
      org_id      uuid not null references organizations(id) on delete cascade,
      actor_id    uuid references users(id) on delete set null,
      action      text not null,
      target_id   uuid references users(id) on delete set null,
      details     jsonb not null default '{}',
      created_at  timestamptz not null default now()
    );
    -- 0089 guards this table too; only its existence matters here.
    create table booking_events (id uuid primary key default gen_random_uuid());
  `);
  sql(APPEND_ONLY);

  // Rows that exist BEFORE the migration, so the backfill is what chains them: a
  // null actor, text outside ASCII, a nested object whose keys Postgres reorders,
  // two rows sharing one created_at, and a whole second with no fraction.
  sql(`
    insert into audit_log (org_id, actor_id, action, target_id, details, created_at) values
      ((select id from organizations), null, 'agent.bookable', (select id from users), '{"zeta": 1, "a": {"y": [1, 2.50, "café"]}}', '2026-01-01T00:00:00.123456Z'),
      ((select id from organizations), (select id from users), 'role.change', null, '{"from": "agent", "to": "manager"}', '2026-01-01T00:00:01Z'),
      ((select id from organizations), (select id from users), 'erasure', null, '{"note": "line\\nbreak \u2603 \u{1F600}"}', '2026-01-01T00:00:01Z');
  `);

  sql(CHAIN);

  // --- the backfill -----------------------------------------------------------
  eq(sql("select string_agg(chain_seq::text, ',' order by chain_seq) from audit_log;"), "1,2,3", "the backfill numbers every existing row from 1 with no gap");
  eq(
    sql("select chain_seq from audit_log order by created_at, id limit 1;"),
    "1",
    "oldest first: the earliest row is the first link",
  );
  eq(
    sql("select (h.seq, h.hash) = (a.chain_seq, a.chain_hash) from audit_log_chain_head h, audit_log a where a.chain_seq = 3;"),
    "t",
    "the head is the newest row's seq and hash",
  );
  eq(sql("select count(*) from audit_log where chain_hash !~ '^[0-9a-f]{64}$';"), "0", "every hash is 64 hex characters");

  // --- the Worker's hash agrees with the database's ---------------------------
  for (const tz of ["UTC", "America/Phoenix", "Asia/Kolkata"]) {
    const rows = readRows(tz);
    let prev = AUDIT_CHAIN_START.passHash;
    let agree = 0;
    for (const row of rows) {
      if ((await chainLink(prev, row)) === row.chain_hash) agree++;
      prev = row.chain_hash;
    }
    eq(agree, rows.length, `the Worker recomputes every backfilled hash, read in ${tz}`);
  }

  // --- the pinned vector --------------------------------------------------------
  const v = AUDIT_CHAIN_VECTOR;
  const fromSql = sql(`
    select audit_log_chain_link('${v.prev}', ${v.row.chain_seq}, '${v.row.id}', '${v.row.org_id}', null,
      '${v.row.action}', '${v.row.target_id}', '${v.detailsJsonb}'::jsonb, '${v.row.created_at}');
  `);
  console.log(`  vector measured here: ${fromSql}`);
  eq(sql(`select '${v.detailsJsonb}'::jsonb::text;`), v.row.details, "the vector's details are Postgres's own rendering of them");
  eq(fromSql, v.hash, "the database produces the hash scripts/test-audit-chain.ts pins");
  eq(await chainLink(v.prev, v.row), v.hash, "and so does the Worker");

  // --- inserts after the migration ----------------------------------------------
  sql(`insert into audit_log (org_id, action, chain_seq, chain_hash)
       values ((select id from organizations), 'forged', 999, '${"f".repeat(64)}');`);
  eq(
    sql("select chain_seq || ' ' || (chain_hash = repeat('f', 64)) from audit_log where action = 'forged';"),
    "4 false",
    "the trigger chains a new row and overwrites whatever the caller supplied",
  );

  // A rolled back insert and a refused insert take nothing from the sequence.
  sql(`begin; insert into audit_log (org_id, action) values ((select id from organizations), 'rolled back'); rollback;`);
  assert(
    sqlError(`insert into audit_log (org_id, action, target_id) values ((select id from organizations), 'bad fk', gen_random_uuid());`) !== null,
    "an insert refused by a foreign key fails",
  );
  insertRow("after the failures");
  eq(sql("select chain_seq from audit_log where action = 'after the failures';"), "5", "neither the rollback nor the refusal left a gap");

  // Concurrent writers: each session inserts several rows in its own transactions.
  const writer = (n: number) =>
    pg.session(
      Array.from({ length: 10 }, (_, i) => `insert into audit_log (org_id, action) values ((select id from organizations), 'racer ${n}.${i}');`).join("\n"),
    );
  const codes = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => writer(n)));
  eq(codes.map((c) => c.code), [0, 0, 0, 0, 0, 0], "six concurrent writers all committed");
  eq(sql("select count(*) || ' ' || min(chain_seq) || ' ' || max(chain_seq) from audit_log;"), "65 1 65", "65 rows numbered 1 to 65, so no seq was taken twice or skipped");

  const intact = await walkAll(AUDIT_CHAIN_START);
  eq(intact.status, "intact", "the lane's walk verifies the whole chain, backfill and live inserts alike");
  const anchored: AuditChainPosition = intact.status === "intact" ? intact.next : AUDIT_CHAIN_START;
  eq(anchored.anchorSeq, 65, "a complete walk anchors the last row");
  eq((await walkAll(anchored, "America/Phoenix")).status, "intact", "and a second walk from that anchor agrees, read in another zone");

  // --- the append only guard is still there -------------------------------------
  assert(
    (sqlError("update audit_log set action = 'x' where chain_seq = 2;") ?? "").includes("append-only"),
    "an UPDATE is still refused by the 0089 trigger",
  );

  // --- the security posture -----------------------------------------------------
  assert(sqlError("select audit_log_chain_link(repeat('0', 64), 1, null, null, null, 'x', null, '{}', now());", "anon") !== null, "anon cannot execute the link function");
  assert(sqlError("select * from audit_log_chain_head;", "anon") !== null, "anon cannot read the chain head");
  assert(sqlError("select * from audit_log_chain_verify;", "authenticated") !== null, "authenticated cannot read the verifier position");

  // --- a second run of the migration --------------------------------------------
  // One digest over every hash in order, so a failure prints two short values.
  const allHashes = "select md5(string_agg(chain_hash, ',' order by chain_seq)) from audit_log;";
  const before = sql(allHashes);
  sql(CHAIN);
  eq(sql(allHashes), before, "re-running the migration changes no hash");
  insertRow("after the rerun");
  eq(sql("select chain_seq from audit_log where action = 'after the rerun';"), "66", "and the trigger carries on from the same head");
  eq((await walkAll(anchored)).status, "intact", "the chain still verifies after the re-run");

  // --- tampering, by a role that can switch the guard off -----------------------
  // Each case commits its edit, is walked, and is then restored from a snapshot, so
  // the next case starts from the intact chain.
  const tampered = async (edit: string) => {
    sql(`begin; alter table audit_log disable trigger audit_log_no_update_delete; ${edit} alter table audit_log enable trigger audit_log_no_update_delete; commit;`);
    return walkAll(anchored);
  };
  const snapshot = "create table audit_log_saved as select * from audit_log; create table head_saved as select * from audit_log_chain_head;";
  const restore = `
    alter table audit_log disable trigger audit_log_no_update_delete;
    alter table audit_log disable trigger zz_audit_log_hash_chain;
    delete from audit_log; insert into audit_log select * from audit_log_saved;
    alter table audit_log enable trigger audit_log_no_update_delete;
    alter table audit_log enable trigger zz_audit_log_hash_chain;
    update audit_log_chain_head h set seq = s.seq, hash = s.hash from head_saved s;
  `;
  sql(snapshot);

  const altered = await tampered(`update audit_log set details = '{"n": 2}' where chain_seq = 30;`);
  eq(altered.status === "broken" ? altered.break : null, { kind: "altered", seq: 30, id: sql("select id from audit_log where chain_seq = 30;") }, "an edited row is caught as altered, at that row");
  sql(restore);
  eq((await walkAll(anchored)).status, "intact", "putting the row back the way it was written verifies again");

  const deleted = await tampered("delete from audit_log where chain_seq = 12;");
  eq(deleted.status === "broken" ? deleted.break.kind : null, "missing", "a row deleted from the middle is caught as missing");
  eq(deleted.status === "broken" && deleted.break.kind === "missing" ? deleted.break.expectedSeq : null, 12, "naming the seq that is gone");
  sql(restore);

  // The careful attacker: edit row 20, then recompute every hash after it with the
  // database's own function, and move the head to match.
  const recomputed = await tampered(`
    update audit_log set action = 'innocent' where chain_seq = 20;
    do $$ declare r record; prev text; begin
      select chain_hash into prev from audit_log where chain_seq = 19;
      for r in select * from audit_log where chain_seq >= 20 order by chain_seq loop
        prev := audit_log_chain_link(prev, r.chain_seq, r.id, r.org_id, r.actor_id, r.action, r.target_id, r.details, r.created_at);
        update audit_log set chain_hash = prev where id = r.id;
      end loop;
      update audit_log_chain_head set hash = prev;
    end $$;
  `);
  eq(recomputed.status === "broken" ? recomputed.break.kind : null, "rewritten", "an edit with every later hash recomputed is caught as rewritten at the anchor");
  eq((await walkAll(AUDIT_CHAIN_START)).status, "intact", "control: the same recomputed chain verifies with no anchor, which is why the anchor is kept");
  sql(restore);

  const cut = await tampered("delete from audit_log where chain_seq >= 60;");
  eq(cut.status === "broken" ? cut.break : null, { kind: "truncated", anchorSeq: 65, lastSeq: 59 }, "rows cut off the end are caught as truncated");
  sql(restore);
  eq((await walkAll(anchored)).status, "intact", "and the restored chain verifies");
} finally {
  pg.stop();
}

finish();
