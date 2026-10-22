// #3247: the reroute hold, proved in a REAL Postgres.
//
// Phase 1 of rerouting a booking into a corrected bucket (#3244) is entirely
// decided by Postgres: an advisory lock per agent, a trigger that refuses a booking
// landing on a held advisor with the SAME SQLSTATE the booker already reads as a
// lost race (23P01), two RPCs that place and claim a hold, and a swap that moves the
// booking, rewrites its bucket and consumes the hold in one transaction. The offline
// suite has no database, and a fake agrees with whatever it is told (L52), so this
// replays EVERY migration into the supabase/postgres image, which carries the
// platform's roles and default grants (L714), and drives the result.
//
// Both directions everywhere (L1): each refusal has a control that the same write
// succeeds with no hold, with a hold on another agent, with an expired hold, and
// with a consumed hold. Expiry is set by writing expires_at in the past, never by
// sleeping.
//
// It writes nothing outside that container, which it removes on the way out. Not
// named test-*.ts: it needs Docker. No Docker is exit 2, never a pass (L98).
//
// Run: pnpm verify:reroute-holds-sql
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { eventTypesInsertSql } from "./lib/seed-sql.ts";
import { CLI_HISTORY_TABLE_SQL, migrationPlan, replayMigrations } from "./lib/migration-replay.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const IMAGE = process.env.REROUTE_HOLDS_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const NAME = `slate-reroute-holds-${process.pid}`;

const plan = migrationPlan(readdirSync(DIR));
if (!plan.ok) {
  console.error(`FAIL: ${plan.error}`);
  process.exit(1);
}

const pg = startThrowawayPostgres(NAME, IMAGE);
const { sql, sqlError } = pg;

const ORG = "00000000-0000-0000-0000-0000000000a0";
const ORG2 = "00000000-0000-0000-0000-0000000000b0";
const ADMIN = "00000000-0000-0000-0000-0000000000ad";
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const C = "00000000-0000-0000-0000-00000000000c";
const D = "00000000-0000-0000-0000-00000000000d";
const X = "00000000-0000-0000-0000-0000000000f0"; // an agent in the OTHER org
const ET = "00000000-0000-0000-0000-0000000000e1"; // 20 minutes, 10 before, 10 after
const ET2 = "00000000-0000-0000-0000-0000000000e2"; // a second event type
const ETX = "00000000-0000-0000-0000-0000000000e3"; // the other org's event type
const B100 = "00000000-0000-0000-0000-000000000100";
const B200 = "00000000-0000-0000-0000-000000000200";
const B300 = "00000000-0000-0000-0000-000000000300"; // ET2, a different event type
const BX = "00000000-0000-0000-0000-000000000f00"; // the other org's bucket

/** A future day, so nothing has "already started". */
const DAY = "2031-03-04";
const at = (hhmm: string) => `'${DAY} ${hhmm}:00+00'::timestamptz`;

let seq = 0;
/** Insert a booking and return its id. */
function book(
  agent: string,
  start: string,
  end: string,
  opts: { bucket?: string; status?: string; kind?: string; id?: string; eventType?: string; allowDouble?: boolean } = {},
): string {
  seq++;
  const id = opts.id ?? `10000000-0000-0000-0000-${String(seq).padStart(12, "0")}`;
  sql(`insert into bookings (id, org_id, bucket_id, event_type_id, assigned_user_id, starts_at, ends_at, timezone,
         status, manage_token, kind, agent_email, gcal_event_id, allow_double_book, routing_trace)
       values ('${id}', '${ORG}', '${opts.bucket ?? B100}', '${opts.eventType ?? ET}', '${agent}', ${at(start)}, ${at(end)},
         'America/New_York', '${opts.status ?? "confirmed"}', 'tok-${id}', '${opts.kind ?? "routed"}',
         'agent-${agent.slice(-2)}@example.com', 'gcal-${id}', ${opts.allowDouble ? "true" : "false"},
         ${opts.kind === "agent_link" ? "null" : `'{"bucket_code":"100","bucket_id":"${B100}","requested_tier":"low","booked_tier":"low","tier_fallback":false,"rungs_dropped":0}'::jsonb`});`);
  return id;
}

/** The error text a statement raises, verbose, so the SQLSTATE and constraint name show. */
const refusal = (text: string): string | null => sqlError(`\\set VERBOSITY verbose\n${text}`);

/** Did this write fail as the reroute hold's lost race (23P01, constraint reroute_hold)? */
function isHoldClash(err: string | null): boolean {
  return err !== null && /23P01/.test(err) && /reroute_hold/.test(err);
}

function place(booking: string, agent: string, opts: { org?: string; target?: string; requested?: string; rungs?: number } = {}): {
  holdId: string;
  refused: string;
} {
  const out = sql(`select coalesce(hold_id::text, ''), coalesce(refused, '') from place_reroute_hold(
      p_org_id => '${opts.org ?? ORG}', p_booking_id => '${booking}', p_agent_user_id => '${agent}',
      p_requested_bucket_id => '${opts.requested ?? opts.target ?? B200}', p_target_bucket_id => '${opts.target ?? B200}',
      p_rungs_dropped => ${opts.rungs ?? 0}, p_created_by => '${ADMIN}');`);
  const [holdId, refused] = out.split("|");
  return { holdId: holdId ?? "", refused: refused ?? "" };
}

function claim(booking: string, hold: string, org = ORG): { refused: string; result: string; leaseSeconds: number } {
  const out = sql(`select coalesce(refused, ''), coalesce(result::text, ''),
      coalesce(round(extract(epoch from expires_at - now()))::int, -1)
    from claim_reroute_hold(p_org_id => '${org}', p_booking_id => '${booking}', p_hold_id => '${hold}');`);
  const [refused, result, lease] = out.split("|");
  return { refused: refused ?? "", result: result ?? "", leaseSeconds: Number(lease) };
}

function swap(
  booking: string,
  agent: string,
  opts: { bucket?: string; requested?: string; hold?: string | null; rungs?: number; clientId?: string | null } = {},
): { updated: string; refused: string } {
  const hold = opts.hold === undefined || opts.hold === null ? "null" : `'${opts.hold}'`;
  const client = opts.clientId === undefined || opts.clientId === null ? "null" : `'${opts.clientId}'`;
  const out = sql(`select updated::text, coalesce(refused, '') from reassign_booking_swap(
      p_booking_id => '${booking}', p_user_id => '${agent}', p_agent_name => 'Agent ${agent.slice(-2)}',
      p_agent_email => 'agent-${agent.slice(-2)}@example.com', p_gcal_event_id => 'gcal-new-${booking}',
      p_routing_trace => '{}'::jsonb, p_gcal_client_id => ${client},
      p_bucket_id => '${opts.bucket ?? B200}', p_requested_bucket_id => '${opts.requested ?? opts.bucket ?? B200}',
      p_requested_tier => 'mid', p_booked_tier => 'mid', p_rungs_dropped => ${opts.rungs ?? 0},
      p_hold_id => ${hold}, p_result => '{"note":"from the caller"}'::jsonb);`);
  const [updated, refused] = out.split("|");
  return { updated: updated ?? "", refused: refused ?? "" };
}

const holdCount = (booking: string) => sql(`select count(*) from reroute_holds where booking_id = '${booking}';`);
const expire = (hold: string) => sql(`update reroute_holds set expires_at = now() - interval '1 second' where id = '${hold}';`);
const cancel = (booking: string) => sql(`update bookings set status = 'cancelled' where id = '${booking}';`);

try {
  // --- every migration, from empty, as db push applies them ----------------------------
  sql(CLI_HISTORY_TABLE_SQL);
  const applied = replayMigrations(
    plan.files,
    (file) => readFileSync(join(DIR, file), "utf8"),
    (batch) => void sql(batch, undefined, { singleTransaction: true }),
  );
  assert(applied === plan.files.length && applied > 160, `every migration applied to an empty database (${applied})`);

  sql(`
    insert into organizations (id, name) values ('${ORG}', 'Reroute org'), ('${ORG2}', 'Other org');
    insert into users (id, org_id, email, role) values
      ('${ADMIN}', '${ORG}', 'admin@example.com', 'admin'),
      ('${A}', '${ORG}', 'a@example.com', 'agent'), ('${B}', '${ORG}', 'b@example.com', 'agent'),
      ('${C}', '${ORG}', 'c@example.com', 'agent'), ('${D}', '${ORG}', 'd@example.com', 'agent'),
      ('${X}', '${ORG2}', 'x@example.com', 'agent');
    ${eventTypesInsertSql([
      { id: ET, orgId: ORG, name: "Call", durationMin: 20, bufferBeforeMin: 10, bufferAfterMin: 10 },
      { id: ET2, orgId: ORG, name: "Other call", durationMin: 20 },
      { id: ETX, orgId: ORG2, name: "Call", durationMin: 20, bufferBeforeMin: 10, bufferAfterMin: 10 },
    ])}
    insert into buckets (id, org_id, code, name, event_type_id) values
      ('${B100}', '${ORG}', '100', 'Low', '${ET}'), ('${B200}', '${ORG}', '200', 'Mid', '${ET}'),
      ('${B300}', '${ORG}', '300', 'Other type', '${ET2}'), ('${BX}', '${ORG2}', 'X100', 'Low', '${ETX}');
  `);

  // --- the shape the plan records -----------------------------------------------------------
  eq(
    sql(`select string_agg(column_name, ',' order by column_name) from information_schema.columns
         where table_schema = 'public' and table_name = 'reroute_holds';`),
    [
      "agent_user_id", "booking_ends_at", "booking_id", "booking_starts_at", "buffered_ends_at", "buffered_starts_at",
      "claimed_at", "consumed_at", "created_at", "created_by", "expires_at", "id", "org_id", "requested_bucket_id",
      "reschedule_seq", "result", "rungs_dropped", "target_bucket_id",
    ].join(","),
    "reroute_holds carries the columns the plan names, plus the raw end the buffered comparison needs",
  );
  eq(sql("select relrowsecurity::text from pg_class where relname = 'reroute_holds';"), "true", "reroute_holds has RLS on");
  eq(sql("select count(*) from pg_policies where tablename = 'reroute_holds';"), "0", "and no policy, so it is default deny");
  eq(
    sql("select string_agg(pronargs::text, ',' order by pronargs) from pg_proc where proname = 'reassign_booking_swap';"),
    "7,14,16",
    "the seven and fourteen argument swaps the deployed code calls are kept beside #1677's sixteen argument one, so applying first breaks nothing",
  );

  // --- place: a hold on a new agent, at the booking's own buffered window -------------------
  const K1 = book(A, "15:00", "15:20");
  const p1 = place(K1, B);
  eq(p1.refused, "", "a hold is placed on a free agent");
  assert(/^[0-9a-f-]{36}$/.test(p1.holdId), "and returns its id");
  eq(
    sql(`select to_char(buffered_starts_at at time zone 'UTC', 'HH24:MI') || '-' || to_char(buffered_ends_at at time zone 'UTC', 'HH24:MI')
         || '|' || to_char(booking_starts_at at time zone 'UTC', 'HH24:MI') || '|' || reschedule_seq
         || '|' || (expires_at between now() + interval '299 seconds' and now() + interval '301 seconds')::text
         from reroute_holds where id = '${p1.holdId}';`),
    "14:50-15:30|15:00|0|true",
    "the hold stores the BUFFERED window, the captured start and reschedule_seq, and expires in five minutes",
  );

  // --- the trigger: a booking on the held agent's window is a lost race ---------------------
  {
    const err = refusal(`insert into bookings (org_id, bucket_id, event_type_id, assigned_user_id, starts_at, ends_at,
        timezone, manage_token) values ('${ORG}', '${B100}', '${ET}', '${B}', ${at("15:00")}, ${at("15:20")}, 'UTC', 'race-1');`);
    assert(isHoldClash(err), `a lead booking the held agent at the held time is refused as 23P01 reroute_hold (got ${err})`);
    assert(err !== null && /held for a bucket correction/.test(err), "and the message says why");
  }
  // Positive controls: the same write on another agent, and outside the buffers.
  {
    const ok = book(C, "15:00", "15:20");
    eq(sql(`select status from bookings where id = '${ok}';`), "confirmed", "control: the same time on an unheld agent books");
    cancel(ok);
  }
  // Buffered edges, both sides. Hold raw 15:00 to 15:20, buffered 14:50 to 15:30.
  assert(isHoldClash(refusal(`select 1; ${bookSql(B, "15:20", "15:40")}`)), "back to back at the hold's END is refused, inside its 10 minute buffer");
  assert(isHoldClash(refusal(bookSql(B, "14:35", "14:55"))), "a call ending inside the hold's BEFORE buffer is refused");
  {
    const after = book(B, "15:30", "15:50");
    const before = book(B, "14:30", "14:50");
    eq(sql(`select count(*) from bookings where id in ('${after}', '${before}') and status = 'confirmed';`), "2",
      "control: exactly one buffer away on either side books, so the guard matches the slot judge rather than doubling the gap");
    cancel(after);
    cancel(before);
  }
  // Update paths: reassigning onto the held agent, and moving a call onto the held window.
  {
    const other = book(C, "15:00", "15:20");
    assert(isHoldClash(refusal(`update bookings set assigned_user_id = '${B}' where id = '${other}';`)),
      "an admin reassign onto the held agent at the held time is refused");
    cancel(other);
    const later = book(B, "17:00", "17:20");
    assert(isHoldClash(refusal(`update bookings set starts_at = ${at("15:05")}, ends_at = ${at("15:25")} where id = '${later}';`)),
      "a reschedule onto the held window is refused");
    cancel(later);
  }
  // The held booking itself is never refused by its own hold.
  eq(sql(`update bookings set ends_at = ${at("15:20")} where id = '${K1}' returning 'ok';`), "ok",
    "the booking the hold is FOR is not refused by its own hold");
  // A cancelled or completed row never meets the trigger.
  eq(
    sql(`insert into bookings (org_id, bucket_id, event_type_id, assigned_user_id, starts_at, ends_at, timezone, manage_token, status)
         values ('${ORG}', '${B100}', '${ET}', '${B}', ${at("15:00")}, ${at("15:20")}, 'UTC', 'cancelled-1', 'cancelled') returning status;`),
    "cancelled",
    "an inactive row is not refused",
  );

  // --- place refusals, each its own reason (L11) ----------------------------------------------
  {
    const busy = book(C, "16:00", "16:20");
    const K5 = book(D, "16:05", "16:25");
    eq(place(K5, C).refused, "agent_busy", "a hold refuses an agent with an overlapping active booking");
    eq(place(K5, B).refused, "", "control: the same hold on a free agent is placed");
    const K6 = book(A, "16:05", "16:25", { allowDouble: true });
    eq(place(K6, B).refused, "agent_held", "a second hold over an agent already held for another booking is refused");
    eq(place(K5, C, { org: ORG2 }).refused, "org_mismatch", "a hold for a booking in another org is refused");
    eq(place(K5, X).refused, "agent_not_in_org", "a hold on an agent from another org is refused");
    eq(place(K5, D).refused, "agent_is_current", "a hold on the booking's current agent is refused: a keep needs no hold");
    eq(place(K5, B, { target: B300 }).refused, "event_type_mismatch", "a target bucket with a different event type is refused");
    eq(place(K5, B, { target: BX }).refused, "bucket_not_in_org", "a target bucket from another org is refused");
    const link = book(A, "18:00", "18:20", { kind: "agent_link" });
    eq(place(link, B).refused, "agent_link", "an advisor link booking is refused");
    const gone = book(A, "18:30", "18:50", { status: "cancelled" });
    eq(place(gone, B).refused, "booking_inactive", "a cancelled booking is refused");
    eq(place("10000000-0000-0000-0000-999999999999", B).refused, "booking_not_found", "an unknown booking is refused");
    const started = sql(`insert into bookings (org_id, bucket_id, event_type_id, assigned_user_id, starts_at, ends_at, timezone, manage_token)
        values ('${ORG}', '${B100}', '${ET}', '${A}', now() - interval '5 minutes', now() + interval '15 minutes', 'UTC', 'started-1') returning id;`);
    eq(place(started, B).refused, "booking_started", "a call that has already started is refused");
    cancel(busy);
    cancel(K5);
    cancel(K6);
    cancel(started);
  }
  // Replacing: a second place for the same booking replaces its unconsumed hold.
  {
    const again = place(K1, C);
    eq(again.refused, "", "placing again for the same booking is allowed");
    eq(holdCount(K1), "1", "and replaces the earlier hold rather than holding two agents");
    assert(again.holdId !== p1.holdId, "under a new id");
    const freed = book(B, "15:00", "15:20");
    eq(sql(`select status from bookings where id = '${freed}';`), "confirmed", "the replaced hold's agent is free again at once");
    cancel(freed);
  }

  // --- expiry and consumption release the agent, without sleeping -----------------------------
  {
    const K7 = book(A, "19:00", "19:20");
    const h = place(K7, B).holdId;
    assert(isHoldClash(refusal(bookSql(B, "19:00", "19:20"))), "held: refused");
    expire(h);
    const free = book(B, "19:00", "19:20");
    eq(sql(`select status from bookings where id = '${free}';`), "confirmed", "an EXPIRED hold refuses nobody, the instant it expires");
    cancel(free);
    eq(place(K7, B).refused, "", "and an expired hold does not block a fresh one");
    cancel(K7);
    eq(holdCount(K7), "0", "cancelling a booking deletes its hold");
    const free2 = book(B, "19:00", "19:20");
    eq(sql(`select status from bookings where id = '${free2}';`), "confirmed", "so the agent is free once the held booking is cancelled");
    cancel(free2);
  }

  // --- claim ---------------------------------------------------------------------------------
  {
    const K8 = book(A, "20:00", "20:20");
    const K9 = book(A, "21:00", "21:20");
    const h8 = place(K8, B).holdId;
    eq(claim(K9, h8).refused, "hold_not_found", "a hold claimed for ANOTHER booking is refused");
    eq(claim(K8, h8, ORG2).refused, "hold_not_found", "a hold claimed from another org is refused");
    eq(claim(K8, "20000000-0000-0000-0000-000000000000").refused, "hold_not_found", "an unknown hold is refused");

    // 4:58 into the hold: two seconds left. A claim extends it by the confirm lease.
    sql(`update reroute_holds set expires_at = now() + interval '2 seconds' where id = '${h8}';`);
    const c = claim(K8, h8);
    eq(c.refused, "", "a hold with two seconds left is claimed");
    assert(c.leaseSeconds >= 118 && c.leaseSeconds <= 121, `and its expiry moves to the two minute confirm lease (${c.leaseSeconds}s)`);
    eq(sql(`select (claimed_at is not null)::text from reroute_holds where id = '${h8}';`), "true", "claimed_at is stamped");
    eq(place(K8, C).refused, "confirm_in_progress", "a claimed hold cannot be replaced from under its confirm");

    expire(h8);
    eq(claim(K8, h8).refused, "hold_expired", "an expired hold is refused at claim");

    const h9 = place(K9, B).holdId;
    sql(`update bookings set starts_at = ${at("21:10")}, ends_at = ${at("21:30")}, reschedule_seq = reschedule_seq + 1 where id = '${K9}';`);
    eq(claim(K9, h9).refused, "booking_moved", "a lead reschedule during the hold refuses the confirm");
    cancel(K8);
    cancel(K9);
  }

  // --- the swap: a reroute move ----------------------------------------------------------------
  {
    const K10 = book(A, "22:00", "22:20");
    sql(`insert into reassign_intents (booking_id, pinned_agent_email, gcal_client_id, lease_until)
         values ('${K10}', 'agent-0b@example.com', 'client-10', now() + interval '5 minutes');`);
    const h = place(K10, B, { requested: B200, target: B200 }).holdId;

    eq(swap(K10, B, { hold: h, clientId: "client-10" }).refused, "hold_not_claimed",
      "a move whose hold was never claimed is refused: the claim comes first");
    claim(K10, h);
    eq(swap(K10, C, { hold: h, clientId: "client-10" }).refused, "hold_mismatch", "a move onto an agent the hold is not for is refused");
    eq(swap(K10, B, { hold: h, bucket: B300, clientId: "client-10" }).refused, "bucket_mismatch",
      "a move into a bucket with another event type is refused");
    eq(sql(`select assigned_user_id::text || '|' || bucket_id::text from bookings where id = '${K10}';`), `${A}|${B100}`,
      "and every refusal wrote nothing");

    const s = swap(K10, B, { hold: h, clientId: "client-10" });
    eq(`${s.updated}|${s.refused}`, "true|", "a claimed hold swaps");
    eq(
      sql(`select assigned_user_id::text || '|' || bucket_id::text || '|' || allow_double_book::text || '|' || status
           from bookings where id = '${K10}';`),
      `${B}|${B200}|false|confirmed`,
      "the booking moves to the held agent and the corrected bucket, stays inside the overlap guards, and keeps its status",
    );
    eq(
      sql(`select routing_trace->>'bucket_code' || '|' || (routing_trace->>'bucket_id') || '|' || (routing_trace->>'booked_tier')
             || '|' || (routing_trace->>'requested_tier') || '|' || (routing_trace->>'rungs_dropped') || '|' || (routing_trace->>'tier_fallback')
             || '|' || jsonb_array_length(routing_trace->'reroutes') || '|' || (routing_trace->'reroutes'->0->>'bucket_code')
             || '|' || (routing_trace->'reroutes'->0->>'booked_tier') || '|' || jsonb_array_length(routing_trace->'reassignments')
           from bookings where id = '${K10}';`),
      `200|${B200}|mid|mid|0|false|1|100|low|1`,
      "the trace's top level names the corrected bucket, the prior values are appended to reroutes, and the move is in reassignments",
    );
    eq(sql(`select (swapped_at is not null)::text || '|' || prev_gcal_event_id from reassign_intents where booking_id = '${K10}';`),
      `true|gcal-${K10}`, "the reassign intent is stamped exactly as a plain reassign stamps it");
    eq(sql(`select (consumed_at is not null)::text || '|' || (result->>'note') || '|' || (result->>'outcome') from reroute_holds where id = '${h}';`),
      "true|from the caller|moved", "the hold is consumed in the same transaction and keeps the result");
    eq(
      sql(`select outcome || '|' || bucket_code || '|' || requested_code || '|' || chosen_user_id || '|' || rungs_dropped
           from routing_decisions where booking_id = '${K10}';`),
      `rerouted|200|200|${B}|0`,
      "a routing decision records the corrected bucket for analytics, under its own outcome so no booking is counted twice",
    );

    const second = claim(K10, h);
    eq(second.refused, "hold_consumed", "a second confirm of a consumed hold is refused as consumed, not expired");
    assert(/"outcome": "moved"/.test(second.result), "and returns the first confirm's stored result");
    eq(swap(K10, B, { hold: h, clientId: "client-10" }).refused, "hold_consumed", "a second swap on the consumed hold writes nothing");
    eq(sql(`select jsonb_array_length(routing_trace->'reroutes') from bookings where id = '${K10}';`), "1", "no second reroute entry");

    // A move onto an agent who has meanwhile been double booked is still refused by the
    // overlap guard, because a reroute move keeps allow_double_book false (0017 sets it true
    // only for an owner reassign).
    const K11 = book(A, "23:00", "23:20");
    const h11 = place(K11, D).holdId;
    claim(K11, h11);
    // Planted with the trigger off, standing in for a write that raced past every
    // guard: the overlap constraint is then the only thing left to refuse the move.
    sql(`set session_replication_role = replica;
      ${bookSql(D, "23:00", "23:20")}
      set session_replication_role = origin;`);
    const clash = refusal(`select * from reassign_booking_swap(p_booking_id => '${K11}', p_user_id => '${D}', p_agent_name => 'D',
      p_agent_email => 'd@example.com', p_gcal_event_id => 'g', p_routing_trace => '{}'::jsonb, p_gcal_client_id => null,
      p_bucket_id => '${B200}', p_requested_bucket_id => '${B200}', p_requested_tier => 'mid', p_booked_tier => 'mid',
      p_rungs_dropped => 0, p_hold_id => '${h11}', p_result => '{}'::jsonb);`);
    assert(clash !== null && /23P01|23505/.test(clash) && /bookings_active/.test(clash),
      `a move onto an agent already booked then is refused by the overlap guard, not double booked (got ${clash})`);
    eq(sql(`select assigned_user_id::text from bookings where id = '${K11}';`), A, "and the booking stays where it was");
    eq(swap(K11, D, { hold: null }).refused, "hold_not_found", "a new agent with no hold is refused: only a hold makes a move");
    cancel(K10);
    cancel(K11);
  }

  // --- the swap: a keep ------------------------------------------------------------------------
  {
    const K12 = book(A, "13:00", "13:20");
    const s = swap(K12, A, { hold: null, bucket: B200, requested: B100, rungs: 1 });
    eq(`${s.updated}|${s.refused}`, "true|", "a keep swaps with no hold");
    eq(
      sql(`select assigned_user_id::text || '|' || bucket_id::text || '|' || gcal_event_id || '|' || allow_double_book::text
             || '|' || coalesce(jsonb_array_length(routing_trace->'reassignments'), 0) || '|' || jsonb_array_length(routing_trace->'reroutes')
             || '|' || (routing_trace->'reroutes'->0->>'kept')
           from bookings where id = '${K12}';`),
      `${A}|${B200}|gcal-${K12}|false|0|1|true`,
      "a keep corrects the bucket and the trace, and leaves the agent, the invite and the reassignments alone",
    );
    eq(sql(`select requested_code || '|' || bucket_code || '|' || tier_fallback::text from routing_decisions where booking_id = '${K12}';`),
      "100|200|true", "a cascaded keep records what was asked for and what was used");
    const link = book(A, "13:30", "13:50", { kind: "agent_link" });
    eq(swap(link, A, { hold: null }).refused, "agent_link", "an advisor link booking cannot be rerouted");
    cancel(K12);
    cancel(link);
  }

  // --- #1677: the sixteen argument swap commits only on the state the caller verified ------------
  {
    const expectSwap = (id: string, to: string, expUser: string | null, expStart: string | null) =>
      sql(`select updated::text || '|' || coalesce(refused, '') from reassign_booking_swap(
             p_booking_id => '${id}', p_user_id => '${to}', p_agent_name => 'T', p_agent_email => 't@example.com',
             p_gcal_event_id => 'g-exp', p_routing_trace => '{}'::jsonb, p_gcal_client_id => 'client-exp',
             p_bucket_id => null, p_requested_bucket_id => null, p_requested_tier => null, p_booked_tier => null,
             p_rungs_dropped => null, p_hold_id => null, p_result => null,
             p_expected_user_id => ${expUser ? `'${expUser}'` : "null"}, p_expected_starts_at => ${expStart ?? "null"});`);
    const holder = (id: string) => sql(`select assigned_user_id::text from bookings where id = '${id}';`);

    const KE1 = book(A, "11:00", "11:20");
    eq(expectSwap(KE1, C, A, at("11:00")), "true|", "control: a booking still with the expected advisor at the expected start moves");
    eq(holder(KE1), C, "and is now with the new advisor");

    const KE2 = book(B, "11:30", "11:50"); // somebody else already moved it off A
    eq(expectSwap(KE2, C, A, at("11:30")), "false|booking_moved", "a booking no longer with the expected advisor is refused as moved");
    eq(holder(KE2), B, "and the advisor somebody else chose is kept");

    const KE3 = book(A, "12:30", "12:50"); // the lead rescheduled it from 11:30
    eq(expectSwap(KE3, C, A, at("11:30")), "false|booking_moved", "a booking at a different start is refused as moved");
    eq(holder(KE3), A, "and nothing is written");

    const KE4 = book(A, "13:00", "13:20", { status: "cancelled" });
    eq(expectSwap(KE4, C, B, at("13:00")), "false|booking_inactive", "a cancelled booking is still refused as inactive, by the body");

    const KE5 = book(B, "13:30", "13:50");
    eq(expectSwap(KE5, C, null, null), "true|", "no expectation checks nothing: the plain reassign");
    for (const id of [KE1, KE2, KE3, KE5]) cancel(id);
    for (const role of ["anon", "authenticated"]) {
      const err = sqlError(
        `select * from reassign_booking_swap(p_booking_id => '${KE1}', p_user_id => '${B}', p_agent_name => 'B', p_agent_email => 'b', p_gcal_event_id => 'g', p_routing_trace => '{}'::jsonb, p_gcal_client_id => null, p_bucket_id => null, p_requested_bucket_id => null, p_requested_tier => null, p_booked_tier => null, p_rungs_dropped => null, p_hold_id => null, p_result => null, p_expected_user_id => null, p_expected_starts_at => null);`,
        role,
      );
      assert(err !== null && /permission denied/.test(err), `${role} cannot execute the sixteen argument swap`);
    }
  }

  // --- the seven argument swap is the plain reassign it always was -------------------------------
  {
    const K13 = book(A, "12:00", "12:20");
    eq(sql(`select updated::text from reassign_booking_swap('${K13}', '${C}', 'C', 'c@example.com', 'g13', '{}'::jsonb, 'client-13');`),
      "true", "the seven argument swap still works");
    eq(
      sql(`select assigned_user_id::text || '|' || bucket_id::text || '|' || allow_double_book::text || '|' || jsonb_array_length(routing_trace->'reassignments')
             || '|' || (routing_trace->'reroutes' is null)::text from bookings where id = '${K13}';`),
      `${C}|${B100}|true|1|true`,
      "and still sets allow_double_book (the 0017 owner reassign), appends a reassignment, and touches no bucket",
    );
    cancel(K13);
  }

  // --- history and analytics accept the new values ---------------------------------------------
  {
    const K14 = book(A, "11:00", "11:20");
    eq(
      sql(`insert into booking_events (booking_id, action, initiator, reason_code, from_bucket_id, to_bucket_id)
           values ('${K14}', 'bucket_corrected', 'admin', 'bucket_correction', '${B100}', '${B200}') returning action;`),
      "bucket_corrected",
      "booking_events accepts bucket_corrected with from and to bucket",
    );
    assert(sqlError(`insert into booking_events (booking_id, action, initiator, reason_code) values ('${K14}', 'nonsense', 'admin', 'x');`) !== null,
      "control: an unknown action is still refused");
    cancel(K14);
  }

  // --- 0167: a hold writes a busy block, and every way it ends removes it (#3248) ------
  {
    const blocks = (hold: string) => sql(`select count(*) from busy_blocks where hold_id = '${hold}';`);
    const K20 = book(A, "09:00", "09:20");
    const h = place(K20, B).holdId;
    eq(
      sql(`select user_id::text || '|' || source || '|' || to_char(starts_at at time zone 'UTC', 'HH24:MI') || '-'
             || to_char(ends_at at time zone 'UTC', 'HH24:MI') || '|' || (booking_id is null)::text
           from busy_blocks where hold_id = '${h}';`),
      `${B}|hold|09:00-09:20|true`,
      "placing a hold writes one block for the held advisor at the call's raw window, naming no booking",
    );
    const h2 = place(K20, C).holdId;
    eq(blocks(h), "0", "replacing the hold removes the old block with the old hold row");
    eq(blocks(h2), "1", "and writes the new one");

    // Expiry: the block stays until the sweep, which returns who it freed.
    expire(h2);
    eq(blocks(h2), "1", "an expired hold's block waits for the sweep (a trigger cannot see time pass)");
    eq(sql("select string_agg(user_id::text, ',') from prune_expired_reroute_hold_blocks();"), C,
      "the sweep removes it and names the advisor it freed");
    eq(blocks(h2), "0", "the block is gone");
    eq(holdCount(K20), "1", "and the hold row is kept, so a late confirm reads expired rather than not found");
    eq(sql("select count(*) from prune_expired_reroute_hold_blocks();"), "0", "a second sweep finds nothing");

    // A live hold is never swept; consuming removes the block in the same transaction.
    const h3 = place(K20, D).holdId;
    eq(sql("select count(*) from prune_expired_reroute_hold_blocks();"), "0", "control: a live hold's block is not swept");
    claim(K20, h3);
    eq(swap(K20, D, { hold: h3 }).refused, "", "the hold is consumed by the swap");
    eq(blocks(h3), "0", "and its block went with it");

    // Cancelling the booking deletes the hold, and the block with it.
    const K21 = book(A, "08:00", "08:20");
    const h4 = place(K21, B).holdId;
    cancel(K21);
    eq(blocks(h4), "0", "cancelling the held booking removes the block");

    // The live holds read, on the DATABASE clock (L736).
    {
      const K22 = book(A, "07:00", "07:20");
      const h5 = place(K22, B).holdId;
      const live = (users: string, from: string, to: string) =>
        sql(`select coalesce(string_agg(booking_id::text, ','), '') from live_reroute_holds(array[${users}]::uuid[], ${at(from)}, ${at(to)});`);
      eq(live(`'${B}'`, "07:25", "07:45"), K22, "a live hold whose buffered window reaches the asked window is returned");
      eq(live(`'${B}'`, "07:31", "07:50"), "", "one wholly past its buffered end is not");
      eq(live(`'${C}'`, "07:00", "07:20"), "", "another advisor's question does not see it");
      sql(`update reroute_holds set expires_at = now() - interval '1 second' where id = '${h5}';`);
      eq(live(`'${B}'`, "07:00", "07:20"), "", "the moment it expires by the database's own clock, it is not live");
      cancel(K22);
      for (const role of ["anon", "authenticated"]) {
        const err = sqlError(`select * from live_reroute_holds(array['${B}']::uuid[], now(), now());`, role);
        assert(err !== null && /permission denied/.test(err), `${role} cannot read live holds`);
      }
    }

    // The shape: a hold block names a hold and nothing else, and nothing else is a hold.
    assert(sqlError(`insert into busy_blocks (user_id, starts_at, ends_at, source) values ('${B}', ${at("07:00")}, ${at("07:20")}, 'hold');`) !== null,
      "a hold block with no hold is refused");
    assert(sqlError(`insert into busy_blocks (user_id, starts_at, ends_at, source) values ('${B}', ${at("07:00")}, ${at("07:20")}, 'nonsense');`) !== null,
      "an unknown source is still refused");
    eq(sql(`insert into busy_blocks (user_id, starts_at, ends_at, source) values ('${B}', ${at("07:00")}, ${at("07:20")}, 'gcal') returning source;`),
      "gcal", "control: an ordinary block still inserts");
    cancel(K20);
    for (const role of ["anon", "authenticated"]) {
      const err = sqlError("select * from prune_expired_reroute_hold_blocks();", role);
      assert(err !== null && /permission denied/.test(err), `${role} cannot run the expiry sweep`);
    }
  }

  // --- no browser role can call any of it (L714) ---------------------------------------------
  for (const role of ["anon", "authenticated"]) {
    for (const call of [
      `select * from place_reroute_hold(p_org_id => '${ORG}', p_booking_id => '${K1}', p_agent_user_id => '${B}', p_requested_bucket_id => '${B200}', p_target_bucket_id => '${B200}', p_rungs_dropped => 0, p_created_by => '${ADMIN}');`,
      `select * from claim_reroute_hold(p_org_id => '${ORG}', p_booking_id => '${K1}', p_hold_id => '${p1.holdId}');`,
      `select * from reassign_booking_swap(p_booking_id => '${K1}', p_user_id => '${B}', p_agent_name => 'B', p_agent_email => 'b', p_gcal_event_id => 'g', p_routing_trace => '{}'::jsonb, p_gcal_client_id => null, p_bucket_id => '${B200}', p_requested_bucket_id => '${B200}', p_requested_tier => 'mid', p_booked_tier => 'mid', p_rungs_dropped => 0, p_hold_id => null, p_result => '{}'::jsonb);`,
    ]) {
      const err = sqlError(call, role);
      assert(err !== null && /permission denied/.test(err), `${role} cannot execute ${call.slice(14, 40).trim()} (got ${err?.trim().split("\n")[0] ?? "a result"})`);
    }
    eq(sql("select count(*) from reroute_holds;", role), "0", `${role} reads no hold rows`);
  }
  assert(sqlError("select count(*) from reroute_holds;", "service_role") === null, "control: service_role, the server's client, reads the table");
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  pg.stop();
}

/** The SQL to book an agent with no assertion, for a refusal check. */
function bookSql(agent: string, start: string, end: string): string {
  seq++;
  return `insert into bookings (org_id, bucket_id, event_type_id, assigned_user_id, starts_at, ends_at, timezone, manage_token)
    values ('${ORG}', '${B100}', '${ET}', '${agent}', ${at(start)}, ${at(end)}, 'UTC', 'raw-${seq}');`;
}

if (process.exitCode === 1) process.exit(1);
finish();
