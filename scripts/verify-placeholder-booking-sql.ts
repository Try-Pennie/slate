// #4202, #4203: migration 0208, the kind that follows the assignee and the move onto
// the placeholder advisor, proved in a REAL Postgres.
//
// What it proves, each beside a control the same statement passes (L1):
//
//   - a booking on the placeholder is always staff_placed AND stacks (allow_double_book),
//     refused otherwise whichever path writes it (bookings_kind_follows_assignee);
//   - a write that moves a staff_placed booking onto a real advisor makes it routed:
//     commit_reschedule (the lead's move, 0206), reassign_booking_swap (a manager's
//     reassign, coverage and bulk all go through it), and a bare UPDATE, so the Regal
//     marker (booking_kind) is true of the call by construction;
//   - commit_reschedule_onto_placeholder moves a booking onto its org's placeholder in
//     the booking's own world, as staff_placed and stacking, with its guard and its
//     outbox row in one transaction, and refuses any other target;
//   - the new functions are SECURITY DEFINER with a pinned search_path and are not
//     executable by the web roles.
//
// It replays EVERY migration into the supabase/postgres image, writes nothing outside
// that container, and removes it on the way out. Not named test-*.ts: it needs Docker.
// No Docker is exit 2, never a pass (L98).
//
// Run: node --experimental-strip-types scripts/verify-placeholder-booking-sql.ts
// (the DB replay workflow also runs it, with every other scripts/verify-*-sql.ts)
import { join } from "node:path";
import { replayEveryMigration, startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { bookingInsertSql, bucketsInsertSql, eventTypesInsertSql, sqlLiteral } from "./lib/seed-sql.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const IMAGE = process.env.PLACEHOLDER_BOOKING_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const pg = startThrowawayPostgres(`slate-placeholder-booking-${process.pid}`, IMAGE);
const { sql } = pg;

const ORG = "00000000-0000-0000-0000-0000000000a0";
const ORG2 = "00000000-0000-0000-0000-0000000000a2";
const ET = "00000000-0000-0000-0000-0000000000e1"; // 20 minutes, 10 before, 10 after
const B100 = "00000000-0000-0000-0000-000000000100";
const BTEST = "00000000-0000-0000-0000-000000000101";
const DAY = "2031-03-04";
const SIGNATURE = "commit_reschedule_onto_placeholder(uuid, uuid, text, timestamptz, timestamptz, uuid, text, text, text, int, boolean, jsonb, jsonb, jsonb)";
const STEPS = [
  { name: "reschedule:busyblock_move", state: "pending" },
  { name: "reschedule:recompute", state: "pending" },
  { name: "reschedule:owner_alert_move", state: "pending" },
  { name: "reschedule:notify", state: "pending" },
];

let seq = 0;
const nextId = () => `40000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
const lit = (v: unknown) => (v === null ? "null" : `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`);
const firstLine = (e: string | null) => e?.split("\n").find((l) => /ERROR/.test(l)) ?? e?.split("\n")[0] ?? "it ran";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A users row; returns its id. */
function user(org: string, cols: { placeholder?: boolean; test?: boolean } = {}): string {
  const id = nextId().replace(/^4/, "5");
  sql(`insert into users (id, org_id, email, role, is_placeholder, is_test)
       values ('${id}', '${org}', '${id}@example.com', 'agent', ${cols.placeholder ?? false}, ${cols.test ?? false});`);
  return id;
}

interface Seed {
  kind?: string;
  doubleBook?: boolean;
  bucket?: string;
}
/** The insert for one booking, with allow_double_book when asked for. */
function seedSql(id: string, agent: string, start: string, end: string, o: Seed = {}): string {
  const base = bookingInsertSql({ id, orgId: ORG, bucketId: o.bucket ?? B100, eventTypeId: ET, assignedUserId: agent, startIso: at(start), endIso: at(end), kind: o.kind });
  return o.doubleBook ? base.replace("insert into bookings (id,", "insert into bookings (allow_double_book, id,").replace("values ('", "values (true, '") : base;
}
/** One booking; its event id is `gcal-<id>`. */
function seed(agent: string, start: string, end: string, o: Seed = {}): string {
  const id = nextId();
  sql(seedSql(id, agent, start, end, o));
  return id;
}
/** The same insert expected to be refused: the verbose error, or null if it ran. */
const seedRefused = (agent: string, start: string, end: string, o: Seed = {}) => pg.verboseError(seedSql(nextId(), agent, start, end, o));

const kindOf = (id: string) => sql(`select kind || '|' || allow_double_book::text from bookings where id = '${id}';`);
const outboxRows = (booking: string) => sql(`select count(*) from booking_outbox where booking_id = '${booking}';`);
const state = (booking: string) =>
  sql(`select concat_ws('|', starts_at, assigned_user_id, status, gcal_event_id, reschedule_seq, kind, allow_double_book) from bookings where id = '${booking}';`);

interface Move {
  booking: string;
  from: string;
  to: string;
  start: string;
  end: string;
  guardEvent?: string | null;
  seq?: number;
  steps?: unknown;
}
const payloadFor = (m: Move) => ({ reasonCode: "other", reasonDetail: null, initiator: "admin", fromStartsIso: at("09:00"), fromAgentUserId: m.from });
/** A move as PostgREST makes it, by name, through `fn`. */
function moveSql(fn: "commit_reschedule" | "commit_reschedule_onto_placeholder", m: Move): string {
  const guardEvent = m.guardEvent === undefined ? `gcal-${m.booking}` : m.guardEvent;
  return `select coalesce(${fn}(
      p_booking_id => '${m.booking}', p_guard_assigned => '${m.from}', p_guard_event => ${sqlLiteral(guardEvent)},
      p_starts_at => '${at(m.start)}', p_ends_at => '${at(m.end)}', p_assigned_user_id => '${m.to}',
      p_agent_name => 'Agent', p_agent_email => 'agent@example.com',
      p_gcal_event_id => 'moved-${m.booking}-${m.seq ?? 1}', p_reschedule_seq => ${m.seq ?? 1},
      p_set_routing_trace => false, p_routing_trace => null,
      p_steps => ${m.steps === undefined ? lit(STEPS) : lit(m.steps)}, p_payload => ${lit(payloadFor(m))})::text, 'null');`;
}
const onto = (m: Move) => sql(moveSql("commit_reschedule_onto_placeholder", m), "service_role");
const ontoRefused = (m: Move) => pg.verboseError(moveSql("commit_reschedule_onto_placeholder", m));
const reschedule = (m: Move) => sql(moveSql("commit_reschedule", m), "service_role");
const rescheduleRefused = (m: Move) => pg.verboseError(moveSql("commit_reschedule", m));

try {
  const applied = replayEveryMigration(pg, DIR);
  assert(applied > 200, `every migration applied to an empty database (${applied})`);
  sql(`
    insert into organizations (id, name) values ('${ORG}', 'Placeholder org'), ('${ORG2}', 'Second org');
    ${eventTypesInsertSql([{ id: ET, orgId: ORG, name: "Call", durationMin: 20, bufferBeforeMin: 10, bufferAfterMin: 10 }])}
    ${bucketsInsertSql([{ id: B100, orgId: ORG, code: "100", name: "Low", eventTypeId: ET }, { id: BTEST, orgId: ORG, code: "PARTNER", name: "Partner", eventTypeId: ET }])}
    update buckets set is_test = true where id = '${BTEST}';
  `);
  const P = user(ORG, { placeholder: true });
  const PT = user(ORG, { placeholder: true, test: true });
  const OTHER_ORG_P = user(ORG2, { placeholder: true });

  // --- a booking on the placeholder is staff_placed and stacks, whatever writes it ------------
  {
    const a = user(ORG);
    const ok = seed(P, "09:00", "09:20", { kind: "staff_placed", doubleBook: true });
    eq(kindOf(ok), "staff_placed|true", "control: a staff placed, stacking booking on the placeholder is accepted");
    const stacked = seed(P, "09:00", "09:20", { kind: "staff_placed", doubleBook: true });
    eq(kindOf(stacked), "staff_placed|true", "a second one at the same time stacks beside it");
    for (const kind of ["routed", "agent_link"]) {
      const err = seedRefused(P, "10:00", "10:20", { kind, doubleBook: true });
      assert(err !== null && /23514[\s\S]*bookings_placeholder_kind/.test(err), `a ${kind} booking on the placeholder is refused (got ${firstLine(err)})`);
    }
    const unstacked = seedRefused(P, "10:00", "10:20", { kind: "staff_placed" });
    assert(unstacked !== null && /23514[\s\S]*bookings_placeholder_kind/.test(unstacked), `a staff placed booking that does not stack is refused (got ${firstLine(unstacked)})`);
    const offPlaceholder = seedRefused(a, "10:00", "10:20", { kind: "staff_placed", doubleBook: true });
    assert(offPlaceholder !== null && /23514[\s\S]*bookings_placeholder_kind/.test(offPlaceholder),
      `a NEW staff placed booking on a real advisor is refused, never silently turned routed (got ${firstLine(offPlaceholder)})`);
    const routed = seed(a, "10:00", "10:20");
    eq(kindOf(routed), "routed|false", "control: a routed booking on a real advisor is accepted untouched");
    const onto = pg.verboseError(`update bookings set assigned_user_id = '${P}', allow_double_book = true where id = '${routed}';`);
    assert(onto !== null && /bookings_placeholder_kind/.test(onto), `a bare update moving a routed booking onto the placeholder is refused (got ${firstLine(onto)})`);
    eq(kindOf(routed), "routed|false", "and wrote nothing");
    const relabel = pg.verboseError(`update bookings set kind = 'staff_placed' where id = '${routed}';`);
    assert(relabel !== null && /bookings_placeholder_kind/.test(relabel), `relabelling a real advisor's booking staff placed is refused (got ${firstLine(relabel)})`);
    const unstack = pg.verboseError(`update bookings set allow_double_book = false where id = '${ok}';`);
    assert(unstack !== null && /bookings_placeholder_kind/.test(unstack), `clearing the stack flag of a placeholder booking is refused (got ${firstLine(unstack)})`);
    sql(`update bookings set status = 'cancelled' where id = '${stacked}';`);
    eq(sql(`select status || '|' || kind from bookings where id = '${stacked}';`), "cancelled|staff_placed", "control: a placeholder booking can still be cancelled, and stays staff placed");
  }

  // --- a move OFF the placeholder makes the call routed, through every writer ---------------
  {
    const a = user(ORG);
    // The lead's reschedule (0206 clears allow_double_book): staff placed becomes routed.
    const viaReschedule = seed(P, "11:00", "11:20", { kind: "staff_placed", doubleBook: true });
    assert(UUID.test(reschedule({ booking: viaReschedule, from: P, to: a, start: "11:40", end: "12:00" })), "commit_reschedule moves a placeholder call onto a real advisor");
    eq(kindOf(viaReschedule), "routed|false", "and the call is routed and no longer stacks");
    // A reschedule that would KEEP it on the placeholder clears the stack flag, which is refused whole.
    const kept = seed(P, "12:30", "12:50", { kind: "staff_placed", doubleBook: true });
    const before = state(kept);
    const keptErr = rescheduleRefused({ booking: kept, from: P, to: P, start: "13:00", end: "13:20" });
    assert(keptErr !== null && /bookings_placeholder_kind/.test(keptErr), `commit_reschedule cannot keep a call on the placeholder (got ${firstLine(keptErr)})`);
    eq(state(kept), before, "the call is not moved");
    eq(outboxRows(kept), "0", "and no outbox row stands");

    // A manager's reassign, coverage and bulk all go through reassign_booking_swap.
    const viaSwap = seed(P, "14:00", "14:20", { kind: "staff_placed", doubleBook: true });
    eq(sql(`select updated::text from reassign_booking_swap(p_booking_id => '${viaSwap}', p_user_id => '${a}', p_agent_name => 'A', p_agent_email => 'a', p_gcal_event_id => 'g-swap', p_routing_trace => '{}'::jsonb, p_gcal_client_id => null, p_bucket_id => null, p_requested_bucket_id => null, p_requested_tier => null, p_booked_tier => null, p_rungs_dropped => null, p_hold_id => null, p_result => null, p_expected_user_id => null, p_expected_starts_at => null);`, "service_role"),
      "true", "reassign_booking_swap moves a placeholder call onto a real advisor");
    eq(kindOf(viaSwap), "routed|true", "and the call is routed (stacked on the advisor as every reassign is)");
    const swapOnto = seed(a, "15:00", "15:20");
    const swapErr = pg.verboseError(`select updated from reassign_booking_swap(p_booking_id => '${swapOnto}', p_user_id => '${P}', p_agent_name => 'P', p_agent_email => 'p', p_gcal_event_id => 'g-onto', p_routing_trace => '{}'::jsonb, p_gcal_client_id => null, p_bucket_id => null, p_requested_bucket_id => null, p_requested_tier => null, p_booked_tier => null, p_rungs_dropped => null, p_hold_id => null, p_result => null, p_expected_user_id => null, p_expected_starts_at => null);`);
    assert(swapErr !== null && /bookings_placeholder_kind/.test(swapErr), `a reassign onto the placeholder is refused (got ${firstLine(swapErr)})`);
    eq(kindOf(swapOnto), "routed|false", "and leaves the routed call where it was");

    // A bare update, the lowest layer anything could reach.
    const viaUpdate = seed(P, "16:00", "16:20", { kind: "staff_placed", doubleBook: true });
    sql(`update bookings set assigned_user_id = '${a}' where id = '${viaUpdate}';`);
    eq(kindOf(viaUpdate), "routed|true", "a bare update moving it onto a real advisor makes it routed");
    // Control: a write that touches the call but keeps it on the placeholder keeps it staff placed.
    const stays = seed(P, "16:00", "16:20", { kind: "staff_placed", doubleBook: true });
    sql(`update bookings set assigned_user_id = '${P}', starts_at = '${at("16:30")}', ends_at = '${at("16:50")}' where id = '${stays}';`);
    eq(kindOf(stays), "staff_placed|true", "control: a write keeping the call on the placeholder leaves it staff placed");
  }

  // --- commit_reschedule_onto_placeholder ------------------------------------------------------
  {
    eq(sql(`select prosecdef::text || ':' || coalesce(array_to_string(proconfig, ','), '-') from pg_proc where proname = 'commit_reschedule_onto_placeholder';`),
      "true:search_path=public, pg_catalog", "it is SECURITY DEFINER with its search_path pinned");
    eq(sql(`select array_to_string(proargnames, ',') from pg_proc where proname = 'commit_reschedule_onto_placeholder';`),
      sql(`select array_to_string(proargnames, ',') from pg_proc where proname = 'commit_reschedule';`),
      "it takes exactly commit_reschedule's arguments, so the caller builds one argument list for both");
    for (const role of ["anon", "authenticated"]) {
      eq(sql(`select has_function_privilege('${role}', '${SIGNATURE}', 'execute')::text;`), "false", `${role} cannot execute it`);
    }
    eq(sql(`select has_function_privilege('service_role', '${SIGNATURE}', 'execute')::text;`), "true", "control: the server's role can");
    eq(sql(`select has_function_privilege('anon', 'bookings_kind_follows_assignee()', 'execute')::text;`), "false", "nor can anon execute the trigger function");

    const a = user(ORG);
    // A routed call moved onto the placeholder: staff placed, stacking, with its outbox row.
    const routed = seed(a, "17:00", "17:20");
    const answer = onto({ booking: routed, from: a, to: P, start: "18:00", end: "18:20" });
    assert(UUID.test(answer), `a routed call moves onto the placeholder and answers its outbox row (got ${answer})`);
    eq(state(routed), sql(`select concat_ws('|', '${at("18:00")}'::timestamptz, '${P}', 'rescheduled', 'moved-${routed}-1', 1, 'staff_placed', true);`),
      "the call is at the new time on the placeholder, rescheduled, staff placed and stacking");
    eq(sql(`select concat_ws('|', id, action, status, (steps = ${lit(STEPS)})::text) from booking_outbox where booking_id = '${routed}';`),
      `${answer}|reschedule|pending|true`, "the answer IS its one pending reschedule outbox row, with the steps it was handed");
    // Stacked: a second call moved onto the placeholder at the same time.
    const second = seed(a, "19:00", "19:20");
    assert(UUID.test(onto({ booking: second, from: a, to: P, start: "18:00", end: "18:20" })), "a second call moves onto the placeholder at the same time, stacked");
    // A placeholder call moved to another time on the placeholder.
    assert(UUID.test(onto({ booking: routed, from: P, to: P, start: "18:40", end: "19:00", guardEvent: `moved-${routed}-1`, seq: 2 })),
      "a placeholder call moves to another time on the placeholder");
    eq(kindOf(routed), "staff_placed|true", "and stays staff placed and stacking");

    // The guard: a changed event id answers null and writes nothing.
    const guarded = seed(a, "20:00", "20:20");
    const g0 = state(guarded);
    eq(onto({ booking: guarded, from: a, to: P, start: "20:40", end: "21:00", guardEvent: "gcal-elsewhere" }), "null", "a guard that matches nothing answers null");
    eq(state(guarded), g0, "and the call is untouched");
    eq(outboxRows(guarded), "0", "with no outbox row");
    eq(onto({ booking: "40000000-0000-4000-8000-0000deadbeef", from: a, to: P, start: "20:40", end: "21:00" }), "null", "a booking that does not exist answers null");

    // Only the placeholder of the booking's own org and world.
    const targets: [string, string][] = [
      ["a real advisor", user(ORG)],
      ["the test placeholder, for a real bucket's call", PT],
      ["another org's placeholder", OTHER_ORG_P],
    ];
    for (const [label, to] of targets) {
      const from = user(ORG);
      const id = seed(from, "21:00", "21:20");
      const before = state(id);
      const err = ontoRefused({ booking: id, from, to, start: "21:40", end: "22:00" });
      assert(err !== null && /22023[\s\S]*placeholder/.test(err), `${label} is refused as a target (got ${firstLine(err)})`);
      eq(state(id), before, `${label}: the call is not moved`);
      eq(outboxRows(id), "0", `${label}: and no outbox row stands`);
    }
    const testCall = seed(user(ORG, { test: true }), "21:00", "21:20", { bucket: BTEST });
    const testFrom = sql(`select assigned_user_id from bookings where id = '${testCall}';`);
    assert(UUID.test(onto({ booking: testCall, from: testFrom, to: PT, start: "21:40", end: "22:00" })), "control: a test bucket's call moves onto the TEST placeholder");

    // One transaction: a refused outbox row rolls the move back.
    const whole = seed(a, "22:30", "22:50");
    const w0 = state(whole);
    const err = ontoRefused({ booking: whole, from: a, to: P, start: "23:00", end: "23:20", steps: null });
    assert(err !== null && /23502[\s\S]*steps/.test(err), `a refused outbox row fails the call (got ${firstLine(err)})`);
    eq(state(whole), w0, "and the move is rolled back with it: never a moved call with no record");
    assert(UUID.test(onto({ booking: whole, from: a, to: P, start: "23:00", end: "23:20" })), "control: the identical move with its steps applies");
  }
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  pg.stop();
}

if (process.exitCode === 1) process.exit(1);
finish();
