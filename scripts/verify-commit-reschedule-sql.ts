// #3505: a reschedule's one transaction save, proved in a REAL Postgres.
//
// `commit_reschedule` (migration 0171, #3265) applies a gated move and records its
// outbox row (the slot move, the recompute, the owner alert's move and the
// rescheduled webhook to Regal) in ONE transaction. Before this suite nothing ever
// executed it: scripts/test-reschedule-commit-args.ts checks the arguments the caller
// builds, offline, and scripts/test-definer-search-path.ts reads its search_path as
// text. So the two things that matter were proved nowhere they run:
//
//   - the guard (still active, assignee and event id as read, #615): a guard that
//     matched the wrong row would move a cancelled call or clobber a reassign;
//   - the one transaction: a refused outbox insert that still committed the move
//     would leave a moved call with no record of its slot move, recompute or webhook,
//     which is exactly the gap #3265 closed.
//
// The offline suite has no database and a fake agrees with whatever it is told (L52),
// so this replays EVERY migration into the supabase/postgres image (its roles and
// default grants, L714) and calls the function as service_role, the server's role,
// with named arguments, as PostgREST does. Both directions everywhere (L1): every
// "null, wrote nothing" beside a control that the same call applies without the
// change, every refusal beside a nearby move that commits.
//
// What it does NOT cover, so a green run is not read as more (L400): a repeated
// IN PLACE move (same advisor, same event id) still matches the guard and would write
// a second outbox row. That retry is stopped before the call, by the reschedule lock
// answering "idempotent" when the booking is already at the target
// (`claimRescheduleLock`, src/lib/booking/service.ts), not by this function.
//
// It writes nothing outside that container, which it removes on the way out. Not
// named test-*.ts: it needs Docker. No Docker is exit 2, never a pass (L98).
//
// Run: node --experimental-strip-types scripts/verify-commit-reschedule-sql.ts
// (the DB replay workflow also runs it, with every other scripts/verify-*-sql.ts)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replayEveryMigration, startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { bookingInsertSql, bucketsInsertSql, eventTypesInsertSql, rerouteHoldInsertSql, sqlLiteral } from "./lib/seed-sql.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, "supabase", "migrations");
// The caller's argument names, read as text: the module imports through the app's
// alias, which the bare node job cannot load. Its path is in db-replay.yml's gate.
const CALLER = join(ROOT, "src", "lib", "booking", "reschedule-commit.ts");
const IMAGE = process.env.COMMIT_RESCHEDULE_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const NAME = `slate-commit-reschedule-${process.pid}`;

const pg = startThrowawayPostgres(NAME, IMAGE);
const { sql } = pg;

const ORG = "00000000-0000-0000-0000-0000000000a0";
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const H = "00000000-0000-0000-0000-00000000000d"; // held for a reroute
const ET = "00000000-0000-0000-0000-0000000000e1"; // 20 minutes, 10 before, 10 after
const B100 = "00000000-0000-0000-0000-000000000100";
const DAY = "2031-03-04";
const SIGNATURE = "commit_reschedule(uuid, uuid, text, timestamptz, timestamptz, uuid, text, text, text, int, boolean, jsonb, jsonb, jsonb)";

/** The steps `rescheduleOutboxSteps()` builds (src/lib/booking/orchestration.ts). */
const STEPS = [
  { name: "reschedule:busyblock_move", state: "pending" },
  { name: "reschedule:recompute", state: "pending" },
  { name: "reschedule:owner_alert_move", state: "pending" },
  { name: "reschedule:notify", state: "pending" },
];

let seq = 0;
const nextId = () => `20000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
const lit = (v: unknown) => (v === null ? "null" : `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`);

/** A new advisor, so each case's calls can never clash with another case's. */
function advisor(): string {
  const id = nextId().replace(/^2/, "3");
  sql(`insert into users (id, org_id, email, role) values ('${id}', '${ORG}', '${id}@example.com', 'agent');`);
  return id;
}

/** One active call on an advisor, as the booker writes it; its event id is `gcal-<id>`. */
function seed(agent: string, start: string, end: string, status = "confirmed"): string {
  const id = nextId();
  sql(bookingInsertSql({ id, orgId: ORG, bucketId: B100, eventTypeId: ET, assignedUserId: agent, startIso: at(start), endIso: at(end), status }));
  return id;
}

interface Move {
  booking: string;
  /** The assignee and event id the caller read; default: what the seed wrote. */
  guardAssigned?: string | null;
  guardEvent?: string | null;
  from: string;
  to: string;
  start: string;
  end: string;
  seq?: number;
  /** A trace to write; absent means the move keeps its advisor and leaves the stored one. */
  trace?: unknown;
  steps?: unknown;
  payload?: unknown;
}

/** The payload the service builds (rescheduleOutbox in applyReschedule). */
const payloadFor = (m: Move) => ({ reasonCode: "lead_request", reasonDetail: null, initiator: "lead", fromStartsIso: "2031-03-04T09:00:00.000Z", fromAgentUserId: m.from });
const newEvent = (m: Move) => `slate-evt-${m.booking}-${m.seq ?? 1}`;

/** The call as PostgREST makes it: every argument by name. */
function moveSql(m: Move): string {
  const guardAssigned = m.guardAssigned === undefined ? m.from : m.guardAssigned;
  const guardEvent = m.guardEvent === undefined ? `gcal-${m.booking}` : m.guardEvent;
  return `select coalesce(commit_reschedule(
      p_booking_id => '${m.booking}', p_guard_assigned => ${sqlLiteral(guardAssigned)}, p_guard_event => ${sqlLiteral(guardEvent)},
      p_starts_at => '${at(m.start)}', p_ends_at => '${at(m.end)}', p_assigned_user_id => '${m.to}',
      p_agent_name => 'Agent ${m.to.slice(-1)}', p_agent_email => '${m.to.slice(-1)}@example.com',
      p_gcal_event_id => '${newEvent(m)}', p_reschedule_seq => ${m.seq ?? 1},
      p_set_routing_trace => ${m.trace !== undefined}, p_routing_trace => ${lit(m.trace ?? null)},
      p_steps => ${m.steps === undefined ? lit(STEPS) : lit(m.steps)}, p_payload => ${lit(m.payload ?? payloadFor(m))})::text, 'null');`;
}
/** Run the move as the server's role; the outbox row's id, or "null" when the guard matched nothing. */
const move = (m: Move): string => sql(moveSql(m), "service_role");
/** Run a move expected to be REFUSED; the verbose error text, or null if it ran. */
const refused = (m: Move): string | null => pg.verboseError(moveSql(m));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const count = (table: string, where: string) => sql(`select count(*) from ${table} where ${where};`);
const outboxRows = (booking: string) => count("booking_outbox", `booking_id = '${booking}'`);
/** Every column the move writes, so "wrote nothing" is measured, never assumed. */
const state = (booking: string) =>
  sql(`select concat_ws('|', starts_at, ends_at, assigned_user_id, agent_name, agent_email, status, gcal_event_id,
         reschedule_seq, coalesce(routing_trace::text, '-')) from bookings where id = '${booking}';`);
const firstLine = (e: string | null) => e?.split("\n").find((l) => /ERROR/.test(l)) ?? e?.split("\n")[0] ?? "it ran";

try {
  // --- every migration, from empty, as db push applies them ----------------------------
  const applied = replayEveryMigration(pg, DIR);
  assert(applied > 170, `the schema for the reschedule commit: every migration applied to an empty database (${applied})`);

  sql(`
    insert into organizations (id, name) values ('${ORG}', 'Reschedule org');
    insert into users (id, org_id, email, role) values
      ('${A}', '${ORG}', 'a@example.com', 'agent'), ('${B}', '${ORG}', 'b@example.com', 'agent'),
      ('${H}', '${ORG}', 'h@example.com', 'agent');
    ${eventTypesInsertSql([{ id: ET, orgId: ORG, name: "Call", durationMin: 20, bufferBeforeMin: 10, bufferAfterMin: 10 }])}
    ${bucketsInsertSql([{ id: B100, orgId: ORG, code: "100", name: "Low", eventTypeId: ET }])}
  `);

  // --- the function the server calls is the one the caller names ---------------------------
  {
    const src = readFileSync(CALLER, "utf8");
    const block = src.match(/export interface CommitRescheduleArgs \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const callerNames = [...block.matchAll(/^\s*(p_\w+)\??:/gm)].map((m) => m[1]).sort();
    const dbNames = sql(`select array_to_string(proargnames, ',') from pg_proc where proname = 'commit_reschedule';`).split(",").sort();
    assert(callerNames.length > 0, `the caller's argument list was read from ${CALLER} (${callerNames.length})`);
    eq(callerNames.join(","), dbNames.join(","),
      "every argument the caller sends by name is one the function takes, and none is missing (a mismatch is a PGRST202 on every reschedule)");
    eq(sql(`select prosecdef::text || ':' || coalesce(array_to_string(proconfig, ','), '-') from pg_proc where proname = 'commit_reschedule';`),
      "true:search_path=public, pg_catalog", "it is SECURITY DEFINER with its search_path pinned, as applied");
  }

  // --- a move applies, and its outbox row is written with it --------------------------------
  {
    const id = seed(A, "09:00", "09:20");
    const trace = { bucket_code: "100", reassignments: [{ from: A, to: B }] };
    const m: Move = { booking: id, from: A, to: B, start: "13:00", end: "13:20", trace };
    const answer = move(m);
    assert(UUID.test(answer), `a move to another advisor answers its outbox row's id (got ${answer})`);
    eq(state(id),
      sql(`select concat_ws('|', '${at("13:00")}'::timestamptz, '${at("13:20")}'::timestamptz, '${B}', 'Agent b', 'b@example.com',
             'rescheduled', '${newEvent(m)}', 1, ${lit(trace)}::text);`),
      "the booking carries the new time, advisor, event id, ordinal and trace, and reads as rescheduled");
    eq(outboxRows(id), "1", "exactly one outbox row for the booking");
    eq(sql(`select concat_ws('|', id, booking_id, action, status, attempts, coalesce(lease_until::text, '-'), coalesce(next_attempt_at::text, '-'))
              from booking_outbox where booking_id = '${id}';`),
      `${answer}|${id}|reschedule|pending|0|-|-`,
      "the answer IS that row: a pending reschedule for this booking, free for the drain to take at once");
    // Read by booking, never by the answer: an answer that is not an id must fail this
    // line, not end the run before every later check.
    eq(sql(`select (steps = ${lit(STEPS)})::text || ':' || (payload = ${lit(payloadFor(m))})::text from booking_outbox where booking_id = '${id}';`),
      "true:true", "and it carries the steps and the payload the caller built, unchanged");

    // A second move of the now rescheduled call, guarded by what it now carries,
    // keeping its advisor: it applies, and leaves the stored trace alone.
    const m2: Move = { booking: id, guardAssigned: B, guardEvent: newEvent(m), from: B, to: B, start: "14:00", end: "14:20", seq: 2 };
    const before = sql(`select routing_trace::text from bookings where id = '${id}';`);
    assert(UUID.test(move(m2)), "a rescheduled call can be moved again, guarded by the assignee and event it now carries");
    eq(sql(`select routing_trace::text from bookings where id = '${id}';`), before,
      "a move that keeps its advisor leaves the stored trace as it was, never a null over it");
    eq(outboxRows(id), "2", "and records its own outbox row");
    // The flag decides, not the value: a trace passed with the flag off is not written.
    const m3: Move = { booking: id, guardAssigned: B, guardEvent: newEvent(m2), from: B, to: B, start: "15:00", end: "15:20", seq: 3 };
    const withTrace = moveSql(m3).replace("p_routing_trace => null", `p_routing_trace => ${lit({ overwritten: true })}`);
    assert(withTrace !== moveSql(m3), "the flag off call really carries a trace value");
    assert(UUID.test(sql(withTrace, "service_role")), "a move with a trace value and the flag off applies");
    eq(sql(`select routing_trace::text from bookings where id = '${id}';`), before, "and the trace it was passed is not written");
  }

  // --- a reschedule clears allow_double_book (#4199) ------------------------------------------
  // A reassign sets the flag so the call may stack on its advisor (0017, 0166). A
  // reschedule always lands on a time checked free for the advisor it goes to, so
  // the flag stops being true of the call the moment it moves. Left set, it exempts
  // the call from 0017's unique index and 0120's overlap constraint on its NEW
  // advisor, and the buffer breach monitor reads any clash there as forced.
  {
    const flag = (id: string) => sql(`select allow_double_book::text from bookings where id = '${id}';`);
    for (const [label, sameAdvisor] of [["to another advisor", false], ["keeping its advisor", true]] as const) {
      const x = advisor();
      const y = sameAdvisor ? x : advisor();
      const id = seed(x, "11:00", "11:20");
      sql(`update bookings set allow_double_book = true where id = '${id}';`);
      eq(flag(id), "true", `a reassigned call carries allow_double_book before it is rescheduled ${label}`);
      assert(UUID.test(move({ booking: id, from: x, to: y, start: "11:40", end: "12:00" })), `the reschedule ${label} applies`);
      eq(flag(id), "false", `a reschedule ${label} clears allow_double_book`);
      // The constraint it was exempt from now holds it: a second call on the same
      // advisor at the same time is refused, where the flagged call would have stacked.
      const err = pg.verboseError(bookingInsertSql({ id: nextId(), orgId: ORG, bucketId: B100, eventTypeId: ET, assignedUserId: y, startIso: at("11:40"), endIso: at("12:00"), status: "confirmed" }));
      assert(err !== null && /23505|23P01/.test(err), `a call on the same advisor at the moved call's time is now refused (got ${firstLine(err)})`);
    }
    // Control: a call that was never flagged stays unflagged, so the clear is not a
    // side effect of something that sets every row false anyway.
    const x = advisor();
    const id = seed(x, "12:30", "12:50");
    eq(flag(id), "false", "control: a call booked normally carries no flag");
    assert(UUID.test(move({ booking: id, from: x, to: x, start: "13:30", end: "13:50" })), "control: it reschedules");
    eq(flag(id), "false", "control: and still carries none");
    // And a guard that matches nothing leaves a flagged call's flag exactly as it was.
    const z = advisor();
    const held = seed(z, "14:30", "14:50");
    sql(`update bookings set allow_double_book = true where id = '${held}';`);
    eq(move({ booking: held, from: z, to: z, start: "15:30", end: "15:50", guardEvent: "gcal-elsewhere" }), "null", "a move whose guard fails answers null");
    eq(flag(held), "true", "and leaves the flag on the call it did not move");
  }

  // A guard on an EMPTY event id matches a booking with none (IS NOT DISTINCT FROM),
  // and a guard naming an event does not match a booking with none.
  {
    const x = advisor();
    const id = seed(x, "09:30", "09:50");
    sql(`update bookings set gcal_event_id = null where id = '${id}';`);
    const named = move({ booking: id, guardEvent: "gcal-something", from: x, to: x, start: "16:00", end: "16:20" });
    eq(named, "null", "a guard naming an event does not match a booking that has none");
    assert(UUID.test(move({ booking: id, guardEvent: null, from: x, to: x, start: "16:00", end: "16:20" })),
      "control: a null guard matches the booking's null event id and the move applies");
  }

  // --- the guard: each change answers null and writes NOTHING, beside a control -------------------
  const guarded: [string, (id: string) => void][] = [
    ["a cancelled booking", (id) => sql(`update bookings set status = 'cancelled' where id = '${id}';`)],
    ["a completed booking", (id) => sql(`update bookings set status = 'completed' where id = '${id}';`)],
    // A concurrent reassign: the assignee changed since the caller read it.
    ["a changed assignee", (id) => sql(`update bookings set assigned_user_id = '${advisor()}' where id = '${id}';`)],
    // A concurrent reassign or an earlier move: the event id changed since it was read.
    ["a changed event id", (id) => sql(`update bookings set gcal_event_id = 'gcal-moved-elsewhere' where id = '${id}';`)],
  ];
  for (const [label, change] of guarded) {
    const x = advisor();
    const id = seed(x, "10:00", "10:20");
    change(id);
    const before = state(id);
    const m: Move = { booking: id, from: x, to: x, start: "10:30", end: "10:50", trace: { moved: true } };
    eq(move(m), "null", `${label}: the guard matches nothing and the answer is null`);
    eq(state(id), before, `${label}: the booking is untouched`);
    eq(outboxRows(id), "0", `${label}: and no outbox row was written`);
    const y = advisor();
    const control = seed(y, "10:00", "10:20");
    assert(UUID.test(move({ ...m, booking: control, from: y, to: y })), `control for ${label}: the same move of an unchanged booking applies`);
    eq(outboxRows(control), "1", `control for ${label}: and writes its outbox row`);
  }
  {
    const total = sql("select count(*) from booking_outbox;");
    eq(move({ booking: "20000000-0000-4000-8000-0000deadbeef", from: A, to: B, start: "18:00", end: "18:20" }), "null",
      "a booking that does not exist answers null");
    eq(sql("select count(*) from booking_outbox;"), total, "and no outbox row was written for it");
  }

  // --- a refusal rolls back the WHOLE call: the move and its outbox row together -------------
  {
    // The advisor the moves go to already has a call 19:00 to 19:20.
    const to = advisor();
    seed(to, "19:00", "19:20");
    const cases: { label: string; change: Partial<Move>; why: RegExp; control: { start: string; end: string } }[] = [
      // bookings_active_no_overlap (0120), 23P01. Control: back to back, the range is half open.
      { label: "an overlap with the new advisor's call", change: { start: "19:10", end: "19:30" }, why: /23P01[\s\S]*bookings_active_no_overlap/, control: { start: "19:20", end: "19:40" } },
      // The same start: 0017's unique index or the overlap constraint, whichever Postgres checks first.
      { label: "the new advisor's call at the same start", change: { start: "19:00", end: "19:20" }, why: /23505[\s\S]*bookings_active_slot_uniq|23P01[\s\S]*bookings_active_no_overlap/, control: { start: "19:40", end: "20:00" } },
      // A move to an advisor who does not exist: the foreign key, 23503.
      { label: "an advisor who does not exist", change: { to: "00000000-0000-0000-0000-00000000dead" }, why: /23503[\s\S]*bookings_assigned_user_id_fkey/, control: { start: "22:00", end: "22:20" } },
      // The outbox row itself refused: steps is NOT NULL, so the insert after the update fails.
      { label: "an outbox row the table refuses", change: { steps: null }, why: /23502[\s\S]*steps/, control: { start: "23:00", end: "23:20" } },
    ];
    for (const { label, change, why, control } of cases) {
      const x = advisor();
      const id = seed(x, "06:00", "06:20");
      const before = state(id);
      const m: Move = { booking: id, from: x, to, start: "21:00", end: "21:20", trace: { moved: true }, ...change };
      const err = refused(m);
      assert(err !== null && why.test(err), `${label} is refused as ${why.source} (got ${firstLine(err)})`);
      eq(state(id), before, `${label}: the booking is NOT moved`);
      eq(outboxRows(id), "0", `${label}: and no outbox row stands`);
      const ok: Move = { ...m, to, steps: undefined, ...control };
      assert(UUID.test(move(ok)), `control for ${label}: the same booking moved to ${control.start} commits`);
      eq(outboxRows(id), "1", `control for ${label}: with its outbox row`);
    }
  }

  // A planted refusal of the outbox insert, by a throwaway trigger keyed on one booking
  // id: the generic case of "the record could not be written", whatever the reason.
  {
    const x = advisor();
    const id = seed(x, "07:00", "07:20");
    sql(`
      create or replace function plant_outbox_refusal() returns trigger language plpgsql as $$
      begin
        if new.booking_id = '${id}' then raise exception 'planted refusal of the outbox row for %', new.booking_id; end if;
        return new;
      end $$;
      create trigger plant_outbox_refusal before insert on booking_outbox for each row execute function plant_outbox_refusal();
    `);
    const before = state(id);
    const m: Move = { booking: id, from: x, to: x, start: "07:30", end: "07:50", trace: { moved: true } };
    const err = refused(m);
    assert(err !== null && /planted refusal of the outbox row/.test(err), `a refused outbox insert fails the call (got ${firstLine(err)})`);
    eq(state(id), before, "and the move it would have recorded is rolled back with it: never a moved call with no record");
    eq(outboxRows(id), "0", "no outbox row");
    sql("drop trigger plant_outbox_refusal on booking_outbox; drop function plant_outbox_refusal();");
    assert(UUID.test(move(m)), "control: with the refusal removed, the identical call applies");
    eq(outboxRows(id), "1", "control: and records its row");
  }

  // The reroute hold (0166's trigger, exclusion_violation with constraint reroute_hold):
  // a move onto an advisor held for a bucket correction is refused whole.
  {
    const heldCall = seed(advisor(), "08:00", "08:20");
    sql(rerouteHoldInsertSql({
      orgId: ORG, bookingId: heldCall, agentUserId: H, bufferedStartsAt: `${DAY} 07:50:00+00`, bufferedEndsAt: `${DAY} 08:30:00+00`,
      bookingStartsAt: `${DAY} 08:00:00+00`, bookingEndsAt: `${DAY} 08:20:00+00`, bucketId: B100,
    }));
    const x = advisor();
    const id = seed(x, "05:00", "05:20");
    const before = state(id);
    const m: Move = { booking: id, from: x, to: H, start: "08:00", end: "08:20", trace: { moved: true } };
    const err = refused(m);
    assert(err !== null && /23P01[\s\S]*reroute_hold/.test(err), `a move onto a held advisor's window is refused as the hold (got ${firstLine(err)})`);
    eq(state(id), before, "the booking is not moved");
    eq(outboxRows(id), "0", "and no outbox row stands");
    assert(UUID.test(move({ ...m, start: "09:00", end: "09:20" })), "control: the same advisor clear of the held window takes the move");
  }

  // --- two transactions at once: the guard holds under a real race -------------------------------
  // The loser of a row lock re-checks the guard against the COMMITTED row (READ
  // COMMITTED re-evaluates the WHERE on the new version), so a move waiting on a
  // concurrent cancel, or on another move, answers null rather than winning.
  //
  // No fixed waits (L290): the holder commits only once Postgres reports the mover
  // WAITING on a lock, and the mover starts only once the holder has its row. So the
  // race is exercised on every run, however slow the machine, and a run in which the
  // two never overlapped fails rather than passing over a sequential case.
  sql("create table race_answers (label text primary key, answer text); grant all on race_answers to service_role;");
  /** A session that writes, holds its row lock until `tag`'s mover is blocked on a lock, then commits. */
  const holder = (tag: string, write: string) => `set application_name = '${tag}';
    begin;
    ${write}
    reset role;
    do $race$ declare t0 timestamptz := clock_timestamp(); begin
      loop
        -- pg_stat_activity is read once per transaction unless cleared, so without
        -- this the holder would never see the mover arrive (measured: it did not).
        perform pg_stat_clear_snapshot();
        exit when exists (select 1 from pg_stat_activity where application_name = '${tag}-mover' and wait_event_type = 'Lock');
        if clock_timestamp() - t0 > interval '20 seconds' then raise exception 'the mover never waited on the row lock'; end if;
        perform pg_sleep(0.05);
      end loop;
    end $race$;
    commit;`;
  /** The mover, as the server's role, recording its answer under `tag`. */
  const mover = (tag: string, m: Move) => `set application_name = '${tag}-mover';
    begin; set local role service_role;
    insert into race_answers ${moveSql(m).replace(/^select /, `select '${tag}', `).replace(/;$/, "")};
    commit;`;
  /** Resolves once the holder is inside its wait, so it holds the row; refuses after 20s rather than hanging. */
  const holderHoldsRow = async (tag: string) => {
    const t0 = Date.now();
    while (sql(`select count(*) from pg_stat_activity where application_name = '${tag}' and query like '%do $race$%';`) !== "1") {
      if (Date.now() - t0 > 20_000) throw new Error(`the ${tag} holder never reached its wait`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const answerOf = (tag: string) => sql(`select coalesce((select answer from race_answers where label = '${tag}'), 'no answer');`);
  {
    const x = advisor();
    const id = seed(x, "04:00", "04:20");
    const cancel = pg.session(holder("cancel", `update bookings set status = 'cancelled' where id = '${id}';`));
    await holderHoldsRow("cancel");
    const moved = pg.session(mover("cancel", { booking: id, from: x, to: x, start: "04:30", end: "04:50", trace: { moved: true } }));
    const [c, mv] = await Promise.all([cancel, moved]);
    eq(`${c.code}:${mv.code}`, "0:0", `both sessions ran, the mover blocked behind the cancel (${c.stderr}${mv.stderr})`);
    eq(answerOf("cancel"), "null", "a move that waited on a concurrent cancel answers null once the cancel commits");
    eq(sql(`select status from bookings where id = '${id}';`), "cancelled", "the call stays cancelled, never resurrected by the move");
    eq(outboxRows(id), "0", "and no outbox row was written");
  }
  {
    const x = advisor();
    const y = advisor();
    const id = seed(x, "03:00", "03:20");
    const first: Move = { booking: id, from: x, to: y, start: "03:30", end: "03:50", trace: { moved: "first" } };
    const second: Move = { booking: id, from: x, to: x, start: "02:00", end: "02:20", seq: 9, trace: { moved: "second" } };
    const firstWrite = `insert into race_answers ${moveSql(first).replace(/^select /, "select 'first', ").replace(/;$/, "")};`;
    const winner = pg.session(holder("move", `set local role service_role; ${firstWrite}`));
    await holderHoldsRow("move");
    const loser = pg.session(mover("move", second));
    const [w, l] = await Promise.all([winner, loser]);
    eq(`${w.code}:${l.code}`, "0:0", `both sessions ran, the second blocked behind the first (${w.stderr}${l.stderr})`);
    assert(UUID.test(answerOf("first")), `the first move applies (got ${answerOf("first")})`);
    eq(answerOf("move"), "null", "a second move read from the same row, waiting on the first, answers null: the assignee and event id it guarded on are gone");
    eq(sql(`select assigned_user_id || '|' || gcal_event_id from bookings where id = '${id}';`), `${y}|${newEvent(first)}`, "the first move stands");
    eq(outboxRows(id), "1", "with exactly one outbox row");
  }

  // --- who may call it -------------------------------------------------------------------------------
  for (const role of ["anon", "authenticated"]) {
    const x = advisor();
    const id = seed(x, "01:00", "01:20");
    const before = state(id);
    const err = pg.verboseError(moveSql({ booking: id, from: x, to: x, start: "01:30", end: "01:50" }), role);
    assert(err !== null && /permission denied for function commit_reschedule/.test(err), `${role} cannot execute it (got ${firstLine(err)})`);
    eq(state(id), before, `${role}: the booking is untouched`);
  }
  eq(sql(`select string_agg(r || '=' || has_function_privilege(r, '${SIGNATURE}', 'execute'), ',' order by r)
            from unnest(array['anon', 'authenticated', 'service_role']) r;`),
    "anon=false,authenticated=false,service_role=true",
    "the browser roles hold no EXECUTE by any route (PUBLIC included) and the server's role keeps it");
  // Every move above ran as service_role, so a missing grant to the server's own role
  // fails this suite rather than every reschedule in production (L159).
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  pg.stop();
}

if (process.exitCode === 1) process.exit(1);
finish();
