// #3495: a fresh booking's final save in ONE call, proved in a REAL Postgres.
//
// After its calendar event exists, a booking made six sequential database calls (the
// insert, the stray mirror's delete, the busy block, the webhook's endpoints and
// deliveries, the routing record, the reservation's delete). Request COUNT is what
// limits a crowd (#3492), so `commit_fresh_booking` does the writes in one
// transaction. What makes that delicate is what must NOT happen inside one
// transaction: an optional write that fails undoing the booking. So each write after
// the insert runs in its own block, and this suite plants a failure in each, by a
// throwaway trigger keyed on one booking id, and proves the booking stands.
//
// The offline suite has no database and a fake agrees with whatever it is told (L52),
// so this replays EVERY migration into the supabase/postgres image (its roles and
// default grants, L714) and calls the function as service_role, the server's role.
// Both directions everywhere (L1): every clash beside a control that commits, every
// planted failure beside the same call committing whole.
//
// It also holds the function's answers to the committed fixture the TypeScript reader
// is tested against (L26), and the webhook payload's times to the format production
// stores, read from production (scripts/fixtures/stored-webhook-time-format.json),
// never to Postgres compared with itself (L70).
//
// It writes nothing outside that container, which it removes on the way out. Not
// named test-*.ts: it needs Docker. No Docker is exit 2, never a pass (L98).
//
// Run: node --experimental-strip-types scripts/verify-commit-fresh-booking-sql.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replayEveryMigration, startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { bucketsInsertSql, rerouteHoldInsertSql } from "./lib/seed-sql.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { readCommitAnswer } from "../src/lib/booking/commit-answer.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const FIXTURES = join(import.meta.dirname, "fixtures");
const IMAGE = process.env.COMMIT_FRESH_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const NAME = `slate-commit-fresh-${process.pid}`;

const pg = startThrowawayPostgres(NAME, IMAGE);
const { sql } = pg;

const ORG = "00000000-0000-0000-0000-0000000000a0";
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const C = "00000000-0000-0000-0000-00000000000c";
const ET = "00000000-0000-0000-0000-0000000000e1"; // 20 minutes, 10 before, 10 after
const B100 = "00000000-0000-0000-0000-000000000100";
const GENERIC = "00000000-0000-0000-0000-00000000ee01";
const REGAL = "00000000-0000-0000-0000-00000000ee02";
const FORMATS = ["generic", "regal"];
const DAY = "2031-03-04";

let seq = 0;
const nextId = () => `10000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/**
 * A booking row as createBooking builds it (BookingInsert), with the id TypeScript mints.
 * `sameLeadAs` books that row's lead again, under the same idempotency key.
 */
function bookingRow(o: { id?: string; agent?: string; start: string; end: string; sameLeadAs?: { idempotency_key: string }; kind?: "routed" | "agent_link" }) {
  const id = o.id ?? nextId();
  return {
    id,
    org_id: ORG,
    bucket_id: B100,
    event_type_id: ET,
    assigned_user_id: o.agent ?? A,
    agent_name: "Agent",
    agent_email: "agent@trypennie.com",
    // As TypeScript sends them: milliseconds and a Z, never the stored rendering.
    starts_at: `${DAY}T${o.start}:00.000Z`,
    ends_at: `${DAY}T${o.end}:00.000Z`,
    original_starts_at: `${DAY}T${o.start}:00.000Z`,
    original_ends_at: `${DAY}T${o.end}:00.000Z`,
    timezone: "America/New_York",
    status: "confirmed",
    salesforce_id: null,
    attendee_name: "Dana Lead",
    attendee_first_name: "Dana",
    attendee_email: "dana@trypennie.com",
    attendee_phone: "+12155550100",
    prefill: { utm_source: "verify" },
    gcal_event_id: `gcal-${id}`,
    manage_token: `tok-${id}`,
    idempotency_key: o.sameLeadAs?.idempotency_key ?? `key-${id}`,
    external_id: null,
    routing_trace: o.kind === "agent_link" ? null : { bucket_code: "100", requested_tier: "low", booked_tier: "low", tier_fallback: false, rungs_dropped: 0 },
    kind: o.kind ?? "routed",
    source: "booking",
    referrer_origin: null,
  };
}

/** A pending reservation, as insertReservation writes it before the calendar event. */
function reservation(key: string, agent = A): string {
  return sql(`insert into booking_reservations (idempotency_key, pinned_user_id, pinned_agent_email, gcal_client_id, payload)
    values ('${key}', '${agent}', 'agent@trypennie.com', 'gcal-${key}', '{}'::jsonb) returning id;`);
}

/** The webhook as fire() builds it: event, payload, dedupe key and a decision per format. */
function webhook(row: ReturnType<typeof bookingRow>, suppression: Record<string, string | null> = { generic: null, regal: null }) {
  return {
    event: "booking.created",
    payload: { booking_id: row.id, bucket_code: "100", starts_at: row.starts_at, ends_at: row.ends_at, status: "confirmed" },
    dedupe_key: row.id,
    suppression,
  };
}

/** The routing decision row as recordRoutingDecision maps it, without the booking id. */
const routing = { org_id: ORG, bucket_code: "100", bucket_id: B100, chosen_user_id: A, considered: [A], excluded: [], outcome: "booked" };

const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;

/** Call the function as the server does, and return its answer parsed. */
function commit(row: ReturnType<typeof bookingRow>, opts: { reservation: string; webhook?: unknown; routing?: unknown | null; role?: string }): unknown {
  const r = opts.routing === undefined ? routing : opts.routing;
  return JSON.parse(
    sql(
      `select commit_fresh_booking(
         p_booking => ${lit(row)}, p_reservation_id => '${opts.reservation}',
         p_webhook => ${lit(opts.webhook ?? webhook(row))}, p_routing => ${r === null ? "null" : lit(r)})::text;`,
      opts.role ?? "service_role",
    ),
  );
}

const read = (answer: unknown) => readCommitAnswer(answer, FORMATS);
const count = (table: string, where: string) => sql(`select count(*) from ${table} where ${where};`);
/** The digits of a time replaced by 9, so two renderings compare by their shape alone. */
const shape = (t: string) => t.replace(/\d/g, "9");

/** Make one table refuse writes for one booking id, to plant a failure in one step. */
function plantRefusal(table: string, column: string, bookingId: string, name: string) {
  sql(`
    create or replace function ${name}() returns trigger language plpgsql as $$
    begin
      if new.${column} = '${bookingId}' then raise exception 'planted refusal of % for %', tg_table_name, new.${column}; end if;
      return new;
    end $$;
    create trigger ${name} before insert on ${table} for each row execute function ${name}();
  `);
}

try {
  // --- every migration, from empty, as db push applies them ----------------------------
  const applied = replayEveryMigration(pg, DIR);
  assert(applied > 170, `the schema for the one call save: every migration applied to an empty database (${applied})`);

  sql(`
    insert into organizations (id, name) values ('${ORG}', 'Commit org');
    insert into users (id, org_id, email, role) values
      ('${A}', '${ORG}', 'a@trypennie.com', 'agent'), ('${B}', '${ORG}', 'b@trypennie.com', 'agent'),
      ('${C}', '${ORG}', 'c@trypennie.com', 'agent');
    insert into event_types (id, org_id, name, duration_min, buffer_before_min, buffer_after_min) values ('${ET}', '${ORG}', 'Call', 20, 10, 10);
    ${bucketsInsertSql([{ id: B100, orgId: ORG, code: "100", name: "Low", eventTypeId: ET }])}
    insert into webhook_endpoints (id, org_id, url, format, active, events, created_at) values
      ('${GENERIC}', '${ORG}', 'https://generic.example/hook', 'generic', true, array['booking.created'], '2031-03-01 00:00:00+00'),
      ('${REGAL}', '${ORG}', 'https://regal.example/hook', 'regal', true, array['booking.created'], '2031-03-01 00:00:01+00');
  `);
  const stored = JSON.parse(readFileSync(join(FIXTURES, "stored-webhook-time-format.json"), "utf8")) as { starts_at: string; ends_at: string };

  // --- a commit: every write, in one call -----------------------------------------------------
  const K1 = bookingRow({ start: "15:00", end: "15:20" });
  const R1 = reservation(K1.idempotency_key);
  const first = read(commit(K1, { reservation: R1 }));
  assert(first.status === "committed", `a free slot commits (got ${first.status})`);
  if (first.status === "committed") {
    eq(first.booking.id, K1.id, "the booking carries the id TypeScript minted");
    eq(first.failed, {}, "nothing failed");
    eq(first.reservationDeleted, true, "and the reservation is deleted, last");
    eq(first.enqueue?.deliveries.length, 2, "both subscribers got a delivery");
    const payload = first.enqueue?.deliveries[0]?.payload as Record<string, string>;
    eq(payload.booking_id, K1.id, "the webhook names the booking's own id");
    eq(shape(payload.starts_at), shape(stored.starts_at),
      `the webhook's start has the format production stores, never the one TypeScript sent (got ${payload.starts_at})`);
    eq(shape(payload.ends_at), shape(stored.ends_at), "and so does its end, against the stored end");
  }
  eq(count("bookings", `id = '${K1.id}'`), "1", "the booking row is there");
  eq(sql(`select user_id || ':' || source from busy_blocks where booking_id = '${K1.id}';`), `${A}:slate`,
    "its busy block is the ADVISOR's, written as Slate's own (two uuids, never swapped, L455)");
  eq(count("webhook_deliveries", `dedupe_key = '${K1.id}'`), "2", "one delivery row per subscriber");
  eq(count("routing_decisions", `booking_id = '${K1.id}'`), "1", "the routing decision, with the booking's id");
  eq(count("booking_reservations", `id = '${R1}'`), "0", "the reservation is gone");
  // Columns the call did not name keep their DEFAULTS, never a null over them.
  eq(sql(`select (created_at is not null)::text || ':' || reschedule_seq || ':' || allow_double_book from bookings where id = '${K1.id}';`),
    "true:0:false", "columns absent from the row get their defaults (created_at, reschedule_seq, allow_double_book)");
  eq(sql(`select catchall_applied || ':' || tier_fallback || ':' || rungs_dropped from routing_decisions where booking_id = '${K1.id}';`),
    "false:false:0", "and so do the routing record's (catchall_applied, tier_fallback, rungs_dropped)");

  // --- running it twice: the second is a conflict that names the first -------------------------
  const again = read(commit(K1, { reservation: reservation(`${K1.idempotency_key}-2`) }));
  assert(again.status === "conflict" && again.winner?.id === K1.id, `the same booking again is a conflict naming the first (got ${JSON.stringify(again)})`);
  eq(count("bookings", `idempotency_key = '${K1.idempotency_key}'`), "1", "and no second booking was written");
  eq(count("webhook_deliveries", `dedupe_key = '${K1.id}'`), "2", "nor a second delivery");

  // --- every clash writes NOTHING, beside a control that commits -------------------------------
  const clashes: [string, () => ReturnType<typeof bookingRow>, () => ReturnType<typeof bookingRow>][] = [
    // bookings_active_slot_uniq: the same advisor at the same start.
    ["the same start for the same advisor", () => bookingRow({ start: "15:00", end: "15:20" }), () => bookingRow({ agent: B, start: "15:00", end: "15:20" })],
    // bookings_active_no_overlap: overlapping the advisor's existing call.
    ["an overlap with the advisor's call", () => bookingRow({ start: "15:10", end: "15:30" }), () => bookingRow({ start: "16:00", end: "16:20" })],
  ];
  for (const [label, clash, control] of clashes) {
    const row = clash();
    const res = reservation(row.idempotency_key);
    const answer = read(commit(row, { reservation: res }));
    assert(answer.status === "conflict" && answer.winner === null, `${label} is a conflict with no winner of its own key (got ${JSON.stringify(answer)})`);
    eq(count("bookings", `id = '${row.id}'`), "0", `${label}: no booking`);
    eq(count("busy_blocks", `booking_id = '${row.id}'`), "0", `${label}: no busy block`);
    eq(count("webhook_deliveries", `dedupe_key = '${row.id}'`), "0", `${label}: no delivery`);
    eq(count("routing_decisions", `booking_id = '${row.id}'`), "0", `${label}: no routing record`);
    eq(count("booking_reservations", `id = '${res}'`), "1", `${label}: the reservation stays for the rollback`);
    const ok = control();
    assert(read(commit(ok, { reservation: reservation(ok.idempotency_key) })).status === "committed", `control for ${label}: the nearby booking commits`);
  }

  // The reroute hold (0166's trigger raises exclusion_violation): C is held near 17:00.
  const HELD = bookingRow({ agent: A, start: "17:00", end: "17:20" });
  assert(read(commit(HELD, { reservation: reservation(HELD.idempotency_key) })).status === "committed", "the held call itself commits");
  sql(rerouteHoldInsertSql({
    orgId: ORG, bookingId: HELD.id, agentUserId: C, bufferedStartsAt: `${DAY} 16:50:00+00`, bufferedEndsAt: `${DAY} 17:30:00+00`,
    bookingStartsAt: `${DAY} 17:00:00+00`, bookingEndsAt: `${DAY} 17:20:00+00`, bucketId: B100,
  }));
  const onHeld = bookingRow({ agent: C, start: "17:00", end: "17:20" });
  const held = read(commit(onHeld, { reservation: reservation(onHeld.idempotency_key) }));
  assert(held.status === "conflict" && held.winner === null, `a booking on an advisor held for a reroute is a conflict (got ${JSON.stringify(held)})`);
  eq(count("bookings", `id = '${onHeld.id}'`), "0", "and is not written");
  const freeOfHold = bookingRow({ agent: C, start: "18:00", end: "18:20" });
  assert(read(commit(freeOfHold, { reservation: reservation(freeOfHold.idempotency_key) })).status === "committed",
    "control: the same advisor away from the held window commits");

  // The other direction (L159): an insert error that is NOT a clash is never read as
  // one. A bucket that does not exist is a foreign key violation, 23503.
  const badBucket = { ...bookingRow({ agent: B, start: "21:00", end: "21:20" }), bucket_id: "00000000-0000-0000-0000-00000000dead" };
  const fk = pg.verboseError(`select commit_fresh_booking(p_booking => ${lit(badBucket)}, p_reservation_id => '${reservation(badBucket.idempotency_key)}', p_webhook => ${lit(webhook(badBucket))}, p_routing => null);`);
  assert(fk !== null && /23503/.test(fk), `a foreign key refusal is an error, never a conflict (got ${fk?.split("\n")[0] ?? "a conflict or a commit"})`);
  eq(count("bookings", `id = '${badBucket.id}'`), "0", "and writes nothing");

  // The idempotency clash: the same lead's key already booked at another time names the winner.
  const sameKey = bookingRow({ agent: B, start: "19:00", end: "19:20", sameLeadAs: K1 });
  const dup = read(commit(sameKey, { reservation: reservation(`${K1.idempotency_key}-3`) }));
  assert(dup.status === "conflict" && dup.winner?.id === K1.id, `a key already booked answers the booking that holds it (got ${JSON.stringify(dup)})`);

  // --- a planted failure in each optional step never undoes the booking --------------------------
  // The busy block: the booking stands, the reservation is deleted (as today: a failed
  // busy write is alerted, never left to the drain), and the failure is named.
  const busyFails = bookingRow({ start: "09:00", end: "09:20" });
  plantRefusal("busy_blocks", "booking_id", busyFails.id, "plant_busy");
  const rBusy = reservation(busyFails.idempotency_key);
  const busy = read(commit(busyFails, { reservation: rBusy }));
  assert(busy.status === "committed" && "busy" in busy.failed, `a refused busy block is named and the booking commits (got ${JSON.stringify(busy)})`);
  eq(count("bookings", `id = '${busyFails.id}'`), "1", "the booking stands");
  eq(count("webhook_deliveries", `dedupe_key = '${busyFails.id}'`), "2", "and the webhook still went in");

  // The webhook: the booking stands and the reservation STAYS, so the drain re-runs the
  // side effects and the webhook is not lost (today's rule).
  const hookFails = bookingRow({ start: "10:00", end: "10:20" });
  const rHook = reservation(hookFails.idempotency_key);
  const hook = read(commit(hookFails, { reservation: rHook, webhook: webhook(hookFails, { generic: null }) }));
  assert(hook.status === "committed" && "webhook" in hook.failed, `a refused webhook is named and the booking commits (got ${JSON.stringify(hook)})`);
  eq(count("bookings", `id = '${hookFails.id}'`), "1", "the booking stands");
  eq(count("booking_reservations", `id = '${rHook}'`), "1", "and the reservation STAYS for the drain");
  eq(hook.status === "committed" ? hook.reservationDeleted : null, false, "the answer says the reservation was kept");

  // A webhook the caller could not BUILD (the drain's resume, whose bucket would not
  // read): before the one call save that read ran after the insert, where its failure
  // cost the webhook alone. So the booking stands, the reason is named, nothing is
  // enqueued, and the reservation STAYS for the drain, which reads the bucket again.
  const hookUnbuilt = bookingRow({ start: "10:30", end: "10:50" });
  const rUnbuilt = reservation(hookUnbuilt.idempotency_key);
  const unbuilt = read(commit(hookUnbuilt, { reservation: rUnbuilt, webhook: { unbuilt: "the bucket 100 would not read" } }));
  assert(
    unbuilt.status === "committed" && unbuilt.failed.webhook === "the bucket 100 would not read" && unbuilt.enqueue === null,
    `a webhook the caller could not build is named with its reason and the booking commits (got ${JSON.stringify(unbuilt)})`,
  );
  eq(count("bookings", `id = '${hookUnbuilt.id}'`), "1", "the booking stands");
  eq(count("webhook_deliveries", `dedupe_key = '${hookUnbuilt.id}'`), "0", "with no deliveries");
  eq(count("booking_reservations", `id = '${rUnbuilt}'`), "1", "and the reservation STAYS for the drain");

  // The routing record: the booking stands and the reservation goes (the record is evidence,
  // not control flow, as today).
  const routeFails = bookingRow({ start: "11:00", end: "11:20" });
  plantRefusal("routing_decisions", "booking_id", routeFails.id, "plant_routing");
  const rRoute = reservation(routeFails.idempotency_key);
  const route = read(commit(routeFails, { reservation: rRoute }));
  assert(route.status === "committed" && "routing" in route.failed, `a refused routing record is named and the booking commits (got ${JSON.stringify(route)})`);
  eq(count("bookings", `id = '${routeFails.id}'`), "1", "the booking stands");
  eq(count("booking_reservations", `id = '${rRoute}'`), "0", "and the reservation is deleted");

  // An agent link booking routes nothing, so no routing record is written.
  const linked = bookingRow({ start: "12:00", end: "12:20", kind: "agent_link" });
  assert(read(commit(linked, { reservation: reservation(linked.idempotency_key), routing: null })).status === "committed", "an agent link booking commits");
  eq(count("routing_decisions", `booking_id = '${linked.id}'`), "0", "with no routing record");

  // --- refusals: nothing written -------------------------------------------------------------------
  const before = sql("select count(*) from bookings;");
  const noId = { ...bookingRow({ start: "13:00", end: "13:20" }), id: undefined };
  const e1 = pg.verboseError(`select commit_fresh_booking(p_booking => ${lit(noId)}, p_reservation_id => '${R1}', p_webhook => ${lit(webhook(bookingRow({ start: "13:00", end: "13:20" })))}, p_routing => null);`);
  assert(e1 !== null && /22023/.test(e1) && /id/.test(e1), `a row with no id is refused, since the webhook names it (got ${e1?.split("\n")[0] ?? "a result"})`);
  const stray = { ...bookingRow({ start: "13:00", end: "13:20" }), not_a_column: 1 };
  const e2 = pg.verboseError(`select commit_fresh_booking(p_booking => ${lit(stray)}, p_reservation_id => '${R1}', p_webhook => ${lit(webhook(stray))}, p_routing => null);`);
  assert(e2 !== null && /22023/.test(e2) && /not_a_column/.test(e2), `a key bookings has no column for is refused by name (got ${e2?.split("\n")[0] ?? "a result"})`);
  // A webhook is a payload or the reason there is none, never neither and never both: a
  // caller that forgot it must not read as one that could not build it (L168).
  const hookless = bookingRow({ start: "13:00", end: "13:20" });
  for (const [label, bad] of [
    ["no webhook at all", null],
    ["an empty webhook", {}],
    ["an empty reason", { unbuilt: "" }],
    ["a payload AND a reason", { ...webhook(hookless), unbuilt: "the bucket 100 would not read" }],
  ] as const) {
    const e = pg.verboseError(
      `select commit_fresh_booking(p_booking => ${lit(hookless)}, p_reservation_id => '${R1}', p_webhook => ${bad === null ? "null" : lit(bad)}, p_routing => null);`,
    );
    assert(e !== null && /22023/.test(e), `${label} is refused (got ${e?.split("\n")[0] ?? "a result"})`);
  }
  eq(sql("select count(*) from bookings;"), before, "and none of them wrote a booking");

  // --- the answers have the shape the reader is tested against (L26) ------------------------------
  const fixture = JSON.parse(readFileSync(join(FIXTURES, "commit-fresh-booking-answer.json"), "utf8")) as Record<string, Record<string, unknown>>;
  const keys = (o: unknown) => Object.keys(o as Record<string, unknown>).sort().join(",");
  const realCommitted = commit(bookingRow({ start: "14:00", end: "14:20" }), { reservation: reservation("key-shape") }) as Record<string, unknown>;
  eq(keys(realCommitted), keys(fixture.committed), "a committed answer's keys are the fixture's");
  const realConflict = commit(bookingRow({ start: "14:00", end: "14:20" }), { reservation: reservation("key-shape-2") }) as Record<string, unknown>;
  eq(keys(realConflict), keys(fixture.conflict), "a conflict answer's keys are the fixture's");

  // --- who may call it -------------------------------------------------------------------------------
  for (const role of ["anon", "authenticated"]) {
    const row = bookingRow({ start: "20:00", end: "20:20" });
    const err = pg.verboseError(`select commit_fresh_booking(p_booking => ${lit(row)}, p_reservation_id => '${R1}', p_webhook => ${lit(webhook(row))}, p_routing => null);`, role);
    assert(err !== null && /permission denied/.test(err), `${role} cannot execute it (got ${err?.split("\n")[0] ?? "a result"})`);
  }
  // Every call above ran as service_role, so a missing grant to the server's own role
  // fails this suite rather than every booking in production (L159).
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  pg.stop();
}

if (process.exitCode === 1) process.exit(1);
finish();
