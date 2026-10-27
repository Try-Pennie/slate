// #3592: the reconcile-missing sweep's atomic re-create, proved in a REAL Postgres.
//
// `recreate_missing_busy_blocks` (migration 0204) re-creates a missing write-through
// busy_block only for a booking that is STILL active, upcoming, assigned, past the
// #778 grace and on an advisor still in the pool (#3304), in the same statement as
// the insert, and answers with the rows it actually inserted. The offline suites
// fake that answer, and a fake agrees with whatever it is told (L52), so this
// replays EVERY migration into the supabase/postgres image, which carries the
// platform's roles and default grants (L714), and drives the function.
//
// Both directions for every guard (L1): each refusal sits beside a control that the
// same call re-creates a block. The race the issue exists for is driven for real: a
// second session holds a cancel's UPDATE open while the function runs, so the
// function must wait for it and then skip the booking. Without the migration's
// `for share of b` the SELECT reads its snapshot and inserts the block without
// waiting (seen failing that way when the clause was removed); the control beside
// it shows a booking nobody is cancelling is never made to wait.
//
// #4259: the two self heal sweeps that touch a booking's block, run TOGETHER over the
// placeholder advisor's calls, tick after tick. The pool exit backstop deletes the
// cached busy time of everybody `hasLeftPool` names, and this function puts a block
// back for an active booking that has none; asked different questions they would
// delete and re-create the same rows for ever. The backstop's own predicate is
// imported and run over the rows it reads, and its own delete is issued, so the half
// that lives in TypeScript is the real rule too. Beside it, a departed real advisor's
// call (still pruned, never rebuilt) and an in pool advisor's (rebuilt, never pruned).
//
// It writes nothing outside that container, which it removes on the way out. Not
// named test-*.ts: it needs Docker. No Docker is exit 2, never a pass (L98).
//
// Run: pnpm verify:recreate-missing-busy-blocks-sql
import { join } from "node:path";
import { replayEveryMigration, startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { bookingInsertSql, eventTypesInsertSql } from "./lib/seed-sql.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { hasLeftPool } from "../src/lib/bookable/left-pool.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const IMAGE = process.env.RECREATE_MISSING_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const NAME = `slate-recreate-missing-${process.pid}`;

const pg = startThrowawayPostgres(NAME, IMAGE);
const { sql, sqlError } = pg;

const ORG = "00000000-0000-0000-0000-0000000000a0";
const ET = "00000000-0000-0000-0000-0000000000e1";
const BKT = "00000000-0000-0000-0000-000000000100";
const IN_POOL = "00000000-0000-0000-0000-00000000000a";
const DEPARTED = "00000000-0000-0000-0000-00000000000b";
const TAKEN_OUT = "00000000-0000-0000-0000-00000000000c";
const OWED = "00000000-0000-0000-0000-00000000000d"; // not bookable yet, activation owed (#2302)
const PLACEHOLDER = "00000000-0000-0000-0000-00000000000e"; // the placeholder advisor (#4200), never bookable

/** A future day, so every booking is upcoming unless placed in the past on purpose. */
const DAY = "2031-03-04";
const at = (hhmm: string) => `${DAY}T${hhmm}:00Z`;
const HOUR_MS = 3_600_000;

let seq = 0;
function book(
  agent: string,
  start: string,
  end: string,
  opts: { status?: string; createdAgo?: string; past?: boolean; placeholder?: boolean } = {},
): string {
  seq++;
  const id = `10000000-0000-0000-0000-${String(seq).padStart(12, "0")}`;
  // A past booking is placed by this machine's clock: an hour of margin either side
  // dwarfs any drift from the container's.
  const startIso = opts.past ? new Date(Date.now() - 2 * HOUR_MS).toISOString() : at(start);
  const endIso = opts.past ? new Date(Date.now() - HOUR_MS).toISOString() : at(end);
  // created_at is set by the database's own clock, since the grace it is judged against
  // is measured in seconds and taken from the same now().
  // A call on the placeholder is staff placed and stacks, or 0208's trigger refuses it.
  const insert = bookingInsertSql({ id, orgId: ORG, bucketId: BKT, eventTypeId: ET, assignedUserId: agent, startIso, endIso, status: opts.status, kind: opts.placeholder ? "staff_placed" : undefined });
  const row = opts.placeholder
    ? insert.replace("insert into bookings (id,", "insert into bookings (allow_double_book, id,").replace("values ('", "values (true, '")
    : insert;
  sql(`${row}
       update bookings set created_at = now() - interval '${opts.createdAgo ?? "10 minutes"}' where id = '${id}';`);
  return id;
}

/** Call the function as the server does, with the 60 s grace, and list what it inserted. */
function recreate(ids: string[], role = "service_role"): string {
  const arr = `array[${ids.map((i) => `'${i}'::uuid`).join(",")}]::uuid[]`;
  return sql(
    `select coalesce(string_agg(booking_id::text || ':' || user_id::text, ',' order by booking_id), '')
       from recreate_missing_busy_blocks(${arr}, now() - interval '60 seconds');`,
    role,
  );
}
const blockOf = (booking: string) =>
  sql(`select coalesce(string_agg(user_id::text || '|' || source || '|' || (starts_at = (select starts_at from bookings where id = '${booking}'))::text, ','), '')
       from busy_blocks where booking_id = '${booking}';`);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Open transactions that have WRITTEN (hold an xid) and are sleeping before their
 *  commit: the cancel sessions below, mid UPDATE. */
const cancelsInFlight = () =>
  sql(`select count(*) from pg_stat_activity where backend_xid is not null and query like 'select pg_sleep(%';`);
/** Wait on the CONDITION, never a fixed time (L290): until a cancel session holds its
 *  UPDATE open. Real timers, so the event loop flushes the session's SQL meanwhile. */
async function untilCancelInFlight(): Promise<boolean> {
  for (let i = 0; i < 150; i++) {
    if (cancelsInFlight() === "1") return true;
    await pause(100);
  }
  return false;
}
const blockCount = (booking: string) => sql(`select count(*) from busy_blocks where booking_id = '${booking}';`);

/** The block a booking's own create writes (`commit_fresh_booking`), on its own agent and window. */
const writeOwnBlock = (booking: string) =>
  sql(`insert into busy_blocks (user_id, starts_at, ends_at, source, booking_id)
       select assigned_user_id, starts_at, ends_at, 'slate', id from bookings where id = '${booking}';`);

/**
 * One pool exit backstop pass (`reconcileOrphanedPoolExits`): its roster read, its own
 * predicate over the rows, and its prune, scoped as the code scopes it. Answers how many
 * rows it deleted.
 */
function poolExitPrune(): number {
  const rows = sql(`select id || '|' || bookable::text || '|' || coalesce(deactivated_at::text, '') || '|' || coalesce(bookable_pending_since::text, '')
                      from users where bookable = false or deactivated_at is not null;`)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, bookable, deactivated, pending] = line.split("|");
      return { id, bookable: bookable === "true", deactivated_at: deactivated || null, bookable_pending_since: pending || null };
    });
  const ids = rows.filter(hasLeftPool).map((r) => `'${r.id}'::uuid`);
  if (ids.length === 0) return 0;
  return Number(
    sql(`with gone as (delete from busy_blocks where user_id = any(array[${ids.join(",")}]) and ooo_request_id is null returning 1)
         select count(*) from gone;`),
  );
}

try {
  const applied = replayEveryMigration(pg, DIR);
  assert(applied > 190, `every migration applied to an empty database (${applied})`);

  sql(`
    insert into organizations (id, name) values ('${ORG}', 'Reconcile org');
    insert into users (id, org_id, email, role, bookable, deactivated_at, bookable_pending_since) values
      ('${IN_POOL}', '${ORG}', 'a@example.com', 'agent', true, null, null),
      ('${DEPARTED}', '${ORG}', 'b@example.com', 'agent', false, now() - interval '1 day', null),
      ('${TAKEN_OUT}', '${ORG}', 'c@example.com', 'agent', false, null, null),
      ('${OWED}', '${ORG}', 'd@example.com', 'agent', false, null, now() - interval '1 hour');
    ${eventTypesInsertSql([{ id: ET, orgId: ORG, name: "Call", durationMin: 20 }])}
    insert into buckets (id, org_id, code, name, event_type_id) values ('${BKT}', '${ORG}', '100', 'Low', '${ET}');
  `);

  // --- the shape: a pinned, invoker function the web roles cannot call --------------------
  eq(
    sql(`select prosecdef::text || '|' || array_to_string(proconfig, ',') from pg_proc where proname = 'recreate_missing_busy_blocks';`),
    "false|search_path=public",
    "security invoker, with its search_path pinned",
  );

  // --- the healthy case and its controls -----------------------------------------------------
  const missed = book(IN_POOL, "15:00", "15:20");
  eq(recreate([missed]), `${missed}:${IN_POOL}`, "re-creates the block of an active, settled, in-pool booking and names it");
  eq(blockOf(missed), `${IN_POOL}|slate|true`, "as a slate block on the booking's own agent and window");
  eq(recreate([missed]), "", "a second call inserts nothing and names nothing: the block exists (ON CONFLICT DO NOTHING)");
  eq(blockCount(missed), "1", "and still exactly one block");

  const resched = book(IN_POOL, "16:00", "16:20", { status: "rescheduled" });
  eq(recreate([resched]), `${resched}:${IN_POOL}`, "a rescheduled (moved in place) booking is active too");

  // --- every guard refuses, beside the control above -----------------------------------------
  const cancelled = book(IN_POOL, "17:00", "17:20", { status: "cancelled" });
  const completed = book(IN_POOL, "17:30", "17:50", { status: "completed" });
  const past = book(IN_POOL, "", "", { past: true });
  const fresh = book(IN_POOL, "18:00", "18:20", { createdAgo: "5 seconds" });
  const departed = book(DEPARTED, "15:00", "15:20");
  const takenOut = book(TAKEN_OUT, "15:00", "15:20");
  eq(recreate([cancelled]), "", "a cancelled booking gets no block");
  eq(recreate([completed]), "", "a completed booking gets no block (no longer upcoming work)");
  eq(recreate([past]), "", "a booking that already ended gets no block");
  eq(recreate([fresh]), "", "#778: a booking inside the grace gets no block, its own write may be in flight");
  eq(recreate([departed]), "", "#3304: a departed advisor's booking gets no block");
  eq(recreate([takenOut]), "", "#3304: an advisor taken out of the pool gets no block");
  const owed = book(OWED, "15:00", "15:20");
  eq(recreate([owed]), `${owed}:${OWED}`, "#2302: an advisor owed an activation still gets the block (the backstop leaves them alone)");
  for (const id of [cancelled, completed, past, fresh, departed, takenOut]) eq(blockCount(id), "0", `no block written for ${id}`);

  // A mixed batch names only what it inserted.
  const m1 = book(IN_POOL, "19:00", "19:20");
  const m2 = book(IN_POOL, "19:30", "19:50", { status: "cancelled" });
  eq(recreate([m1, m2, missed]), `${m1}:${IN_POOL}`, "a mixed batch answers with exactly the rows it inserted");

  // --- #4259: both sweeps over the placeholder's calls, tick after tick -----------------------
  sql(`insert into users (id, org_id, email, role, bookable, is_placeholder) values
         ('${PLACEHOLDER}', '${ORG}', 'marcia@example.com', 'agent', false, true);`);
  // Two calls stacked at one time on the placeholder, a departed advisor's call and an in
  // pool advisor's, each with the block its create wrote, then the in pool one's lost.
  const stackedA = book(PLACEHOLDER, "13:00", "13:20", { placeholder: true });
  const stackedB = book(PLACEHOLDER, "13:00", "13:20", { placeholder: true });
  const departedCall = book(DEPARTED, "13:00", "13:20");
  const inPoolCall = book(IN_POOL, "13:00", "13:20");
  for (const id of [stackedA, stackedB, departedCall, inPoolCall]) writeOwnBlock(id);
  sql(`delete from busy_blocks where booking_id = '${inPoolCall}';`);
  const section = [stackedA, stackedB, departedCall, inPoolCall];
  const pruned: number[] = [];
  const rebuilt: string[] = [];
  for (let tick = 0; tick < 4; tick++) {
    // The self heal lane's order: the missing block repair, then the pool exit backstop.
    // The repair is handed every call here, not only what its loader would pass it, so it
    // is the function's own guard that is proved.
    rebuilt.push(recreate(section));
    pruned.push(poolExitPrune());
  }
  eq(rebuilt[0], `${inPoolCall}:${IN_POOL}`, "tick 1: the repair rebuilds the in pool advisor's lost block and nothing of the placeholder's");
  eq(pruned[0], 3, "tick 1: the backstop prunes the two stacked placeholder blocks and the departed advisor's");
  eq(rebuilt.slice(1).join(","), ",,", "ticks 2 to 4: the repair re-creates nothing, so there is nothing to fight over");
  eq(pruned.slice(1).join(","), "0,0,0", "ticks 2 to 4: and the backstop deletes nothing (#4259: no churn)");
  for (const id of [stackedA, stackedB]) eq(blockCount(id), "0", "the placeholder's call holds no block: it is in no pool, so nothing reads one");
  eq(blockCount(departedCall), "0", "control: a departed real advisor's block is still pruned, and stays pruned");
  eq(blockCount(inPoolCall), "1", "control: an in pool advisor's block is rebuilt once and then left standing");

  // --- the race: a cancel in flight while the function runs ----------------------------------
  const racing = book(IN_POOL, "20:00", "20:20");
  const cancelSession = pg.session(`
    begin;
    update bookings set status = 'cancelled' where id = '${racing}';
    select pg_sleep(5);
    commit;
  `);
  assert(await untilCancelInFlight(), "the cancel session is holding its UPDATE open on the booking");
  const raced = recreate([racing]);
  // Judged by state, not by a stopwatch: the cancel session sleeps 5 s before it
  // commits, so if the function had read past it, it would have returned with that
  // session still open.
  eq(cancelsInFlight(), "0", "the function returned only once the in-flight cancel had committed: it WAITED on the row");
  const cancelled2 = await cancelSession;
  eq(cancelled2.code, 0, `the cancel session committed (${cancelled2.stderr.trim()})`);
  eq(raced, "", "a cancel committing while the function runs is honoured: no block, nothing named");
  eq(blockCount(racing), "0", "and no stray block is left for the next tick to free and page about");

  // Control for the lock: the same race on a booking the cancel does NOT touch inserts at
  // once, so the wait above is the cancel's row lock and nothing else.
  const other = book(IN_POOL, "21:00", "21:20");
  const holder = book(IN_POOL, "21:30", "21:50");
  const otherSession = pg.session(`
    begin;
    update bookings set status = 'cancelled' where id = '${holder}';
    select pg_sleep(10);
    commit;
  `);
  assert(await untilCancelInFlight(), "control: the other cancel is holding its own booking open");
  eq(recreate([other]), `${other}:${IN_POOL}`, "control: a booking nobody is cancelling is re-created during the same kind of race");
  eq(cancelsInFlight(), "1", "control: and it returned while the unrelated cancel was still open, without waiting on it");
  await otherSession;

  // --- no browser role can call it (L714) -----------------------------------------------------
  const target = book(IN_POOL, "22:00", "22:20");
  for (const role of ["anon", "authenticated"]) {
    const err = sqlError(
      `select * from recreate_missing_busy_blocks(array['${target}'::uuid], now() - interval '60 seconds');`,
      role,
    );
    assert(err !== null && /permission denied/.test(err), `${role} cannot execute it (got ${err?.trim().split("\n")[0] ?? "a result"})`);
  }
  eq(blockCount(target), "0", "and their attempts wrote nothing");
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  pg.stop();
}

if (process.exitCode === 1) process.exit(1);
finish();
