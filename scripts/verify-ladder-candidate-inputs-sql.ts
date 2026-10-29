// #3489: everything a confirm's candidate read needs, for every rung of its ladder, in
// ONE request, proved in a REAL Postgres.
//
// A confirm read each rung's candidates with seven to nine requests (the pool's members
// and roster, schedules, busy time, the daily counts, the business hours, the live
// holds, the share rows) and a bucket read per lower rung, and request COUNT is what
// queues a crowd (#3492). `ladder_candidate_inputs` answers all of them for the whole
// ladder in one. What it must not change is what each read returns, so this suite holds
// every section of its answer to the read it replaces, restated in SQL exactly as
// PostgREST ran it (`roundRobinCandidates` and what it calls before #3489), over a world
// that has each thing those reads filter on: other orgs, unbookable and departed
// advisors, inactive members, busy time and holds inside and outside the window, hold
// blocks, share bookings of the wrong kind, status, bucket and period, and business
// hour exceptions before and after the date asked from.
//
// The function reads every BOOKABLE advisor of the ladder's orgs rather than one rung's
// pool (which only the TypeScript judge can work out from the criteria), over windows
// the caller makes a superset of every rung's. So each comparison is the old read for a
// pool and window, against the function's answer narrowed to the same pool and window.
//
// It replays EVERY migration into the supabase/postgres image (its roles and default
// grants, L714) and calls the function as service_role, the server's role. It writes
// nothing outside that container, which it removes on the way out. Not named
// test-*.ts: it needs Docker. No Docker is exit 2, never a pass (L98).
//
// Run: node --experimental-strip-types scripts/verify-ladder-candidate-inputs-sql.ts
import { join } from "node:path";
import { replayEveryMigration, startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { bookingInsertSql, eventTypesInsertSql } from "./lib/seed-sql.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const IMAGE = process.env.LADDER_INPUTS_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const NAME = `slate-ladder-inputs-${process.pid}`;

const pg = startThrowawayPostgres(NAME, IMAGE);
const { sql } = pg;

const uuid = (prefix: string, n: number) => `${prefix}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = uuid("a0", 1);
const ORG2 = uuid("a0", 2);
const ET = uuid("e0", 1);
const ET2 = uuid("e0", 2);
// The ladder: 500 over 400 over 300, and a bucket in another org with the same shape.
const B500 = uuid("b0", 500);
const B400 = uuid("b0", 400);
const B300 = uuid("b0", 300);
const BOTHER = uuid("b0", 999);
// Advisors: bookable ones, one not bookable, one departed, one in the other org.
const A = uuid("c0", 1);
const B = uuid("c0", 2);
const C = uuid("c0", 3);
const D = uuid("c0", 4);
const OFF = uuid("c0", 5); // not bookable
const GONE = uuid("c0", 6); // departed
const OTHER = uuid("c0", 7); // another org
const NOSCHED = uuid("c0", 8); // bookable, no schedule
const BOOKABLE = [A, B, C, D, NOSCHED];

// The slot: 2031-03-04 15:00Z, a 20 minute call with 10 minute buffers.
const SLOT = "2031-03-04T15:00:00.000Z";
const at = (iso: string) => `'${iso}'::timestamptz`;
const plusMin = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString();
// One rung's buffered window, and the superset the caller sends.
const RUNG_FROM = plusMin(SLOT, -10);
const RUNG_TO = plusMin(SLOT, 30);
const SUPER_FROM = plusMin(SLOT, -70);
const SUPER_TO = plusMin(SLOT, 90);
const DAY = 24 * 60;
const CAP_FROM = plusMin(SUPER_FROM, -DAY);
const CAP_TO = plusMin(SUPER_TO, DAY);
const RUNG_CAP_FROM = plusMin(RUNG_FROM, -DAY);
const RUNG_CAP_TO = plusMin(RUNG_TO, DAY);
const SHARE_FROM = "2031-02-01T00:00:00.000Z";
const SHARE_TO = "2031-03-16T00:00:00.000Z";
const EXCEPTIONS_FROM = "2031-03-04";

let seq = 0;
const nextId = () => uuid("d0", ++seq);

function booking(o: { bucket: string; user: string; start: string; kind?: string; status?: string; org?: string; et?: string }): string {
  const id = nextId();
  const end = plusMin(o.start, 20);
  sql(
    bookingInsertSql({
      id,
      orgId: o.org ?? ORG,
      bucketId: o.bucket,
      eventTypeId: o.et ?? ET,
      assignedUserId: o.user,
      startIso: o.start,
      endIso: end,
      status: o.status,
      attendeeEmail: `lead-${id}@trypennie.com`,
      kind: o.kind,
    }),
  );
  return id;
}

/** The function, called as the server calls it. */
function inputs(codes: string[], role = "service_role"): Record<string, unknown> {
  const out = sql(
    `select ladder_candidate_inputs(
       p_codes => array[${codes.map((c) => `'${c}'`).join(", ")}]::text[],
       p_busy_from => ${at(SUPER_FROM)}, p_busy_to => ${at(SUPER_TO)},
       p_cap_from => ${at(CAP_FROM)}, p_cap_to => ${at(CAP_TO)},
       p_share_from => ${at(SHARE_FROM)}, p_share_to => ${at(SHARE_TO)},
       p_exceptions_from => '${EXCEPTIONS_FROM}'::date)::text;`,
    role,
  );
  return JSON.parse(out) as Record<string, unknown>;
}

/** A query's rows as JSON, in a stable order, for comparing a section with an old read. */
const rows = (query: string): unknown[] => JSON.parse(sql(`select coalesce(json_agg(q), '[]')::text from (${query}) q;`)) as unknown[];
/** JSON with every object's keys sorted: jsonb orders keys its own way, a json row by its select list. */
const canon = (x: unknown): string =>
  Array.isArray(x)
    ? `[${x.map(canon).join(",")}]`
    : x !== null && typeof x === "object"
      ? `{${Object.keys(x as object).sort().map((k) => `${JSON.stringify(k)}:${canon((x as Record<string, unknown>)[k])}`).join(",")}}`
      : JSON.stringify(x);
const sorted = (xs: unknown[]) => xs.map(canon).sort();
const sameRows = (a: unknown[], b: unknown[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const list = (ids: readonly string[]) => `array[${ids.map((i) => `'${i}'`).join(", ")}]::uuid[]`;
/** Normalises a timestamp field to epoch ms, so the two renderings compare by instant. */
const ms = (x: Record<string, unknown>, ...keys: string[]) => {
  const o = { ...x };
  for (const k of keys) o[k] = Date.parse(String(o[k]));
  return o;
};

try {
  const applied = replayEveryMigration(pg, DIR);
  assert(applied > 170, `the schema for the ladder read: every migration applied to an empty database (${applied})`);
  sql(`
    insert into organizations (id, name) values ('${ORG}', 'Ladder org'), ('${ORG2}', 'Other org');
    insert into users (id, org_id, email, role, bookable, deactivated_at, attributes) values
      ('${A}', '${ORG}', 'a@trypennie.com', 'agent', true, null, '{"debt_team":["Low"]}'),
      ('${B}', '${ORG}', 'b@trypennie.com', 'agent', true, null, '{"debt_team":["Medium"]}'),
      ('${C}', '${ORG}', 'c@trypennie.com', 'agent', true, null, '{}'),
      ('${D}', '${ORG}', 'd@trypennie.com', 'agent', true, null, '{"debt_team":["High"]}'),
      ('${OFF}', '${ORG}', 'off@trypennie.com', 'agent', false, null, '{}'),
      ('${GONE}', '${ORG}', 'gone@trypennie.com', 'agent', true, now() - interval '1 day', '{}'),
      ('${OTHER}', '${ORG2}', 'other@trypennie.com', 'agent', true, null, '{}'),
      ('${NOSCHED}', '${ORG}', 'nosched@trypennie.com', 'agent', true, null, '{}');
    ${eventTypesInsertSql([
      { id: ET, orgId: ORG, name: "Call", durationMin: 20, bufferBeforeMin: 10, bufferAfterMin: 10 },
      { id: ET2, orgId: ORG2, name: "Other call", durationMin: 30 },
    ])}
    insert into buckets (id, org_id, code, name, event_type_id) values
      ('${B500}', '${ORG}', '500', 'Top', '${ET}'),
      ('${B400}', '${ORG}', '400', 'Middle', '${ET}'),
      ('${B300}', '${ORG}', '300', 'Bottom', '${ET}'),
      ('${BOTHER}', '${ORG2}', '999', 'Elsewhere', '${ET2}');
    insert into bucket_members (bucket_id, user_id, active) values
      ('${B500}', '${A}', true), ('${B500}', '${B}', false), ('${B400}', '${C}', true),
      ('${B400}', '${OFF}', true), ('${BOTHER}', '${OTHER}', true);
  `);
  // Schedules: everyone but NOSCHED, with rules on two weekdays, the other org's too.
  for (const [u, tz] of [[A, "America/New_York"], [B, "America/Phoenix"], [C, "America/Los_Angeles"], [D, "America/Chicago"], [OFF, "America/New_York"], [GONE, "America/New_York"], [OTHER, "America/Denver"]] as const) {
    const s = nextId();
    sql(`insert into availability_schedules (id, user_id, timezone) values ('${s}', '${u}', '${tz}');
      insert into availability_rules (schedule_id, weekday, start_minute, end_minute) values
        ('${s}', 2, 540, 1020), ('${s}', 3, 600, 960);`);
  }
  // Busy time: inside the rung window, inside only the superset, outside both, a hold
  // block, and the same for advisors the read must leave out.
  const block = (u: string, from: string, to: string, source = "gcal") =>
    sql(`insert into busy_blocks (user_id, starts_at, ends_at, source) values ('${u}', ${at(from)}, ${at(to)}, '${source}');`);
  block(A, plusMin(SLOT, -5), plusMin(SLOT, 15)); // in the rung window
  block(B, plusMin(SLOT, -60), plusMin(SLOT, -30)); // in the superset only
  block(C, plusMin(SLOT, 200), plusMin(SLOT, 260)); // outside both
  block(D, plusMin(SLOT, 0), plusMin(SLOT, 20), "slate"); // in the rung window, a booking's
  block(OFF, plusMin(SLOT, 0), plusMin(SLOT, 20)); // not bookable
  block(GONE, plusMin(SLOT, 0), plusMin(SLOT, 20)); // departed
  block(OTHER, plusMin(SLOT, 0), plusMin(SLOT, 20)); // another org
  block(NOSCHED, plusMin(SLOT, 60), plusMin(SLOT, 80)); // in the superset only

  // Bookings: routed and linked, in each status, in and out of the share period, across
  // two local days for the counts, in each bucket and in the other org.
  const b500a = booking({ bucket: B500, user: A, start: "2031-03-04T13:00:00.000Z" });
  booking({ bucket: B500, user: A, start: "2031-03-03T13:00:00.000Z", status: "completed" });
  booking({ bucket: B500, user: B, start: "2031-03-04T03:30:00.000Z" }); // Phoenix's 3rd, UTC's 4th
  booking({ bucket: B500, user: A, start: "2031-03-04T18:00:00.000Z", kind: "agent_link" }); // not a share
  booking({ bucket: B500, user: A, start: "2031-03-04T19:00:00.000Z", status: "cancelled" });
  booking({ bucket: B500, user: B, start: "2031-01-20T13:00:00.000Z" }); // before the share period
  booking({ bucket: B400, user: C, start: "2031-03-05T13:00:00.000Z", status: "rescheduled" });
  booking({ bucket: B300, user: D, start: "2031-03-04T16:00:00.000Z" });
  booking({ bucket: B500, user: OFF, start: "2031-03-04T20:00:00.000Z" }); // not bookable
  booking({ bucket: BOTHER, user: OTHER, start: "2031-03-04T13:00:00.000Z", org: ORG2, et: ET2 });

  // Holds: live and overlapping, live and outside the superset, expired, and consumed.
  const hold = (u: string, onBooking: string, from: string, to: string, expires: string, consumed = false) =>
    sql(`insert into reroute_holds (org_id, booking_id, agent_user_id, buffered_starts_at, buffered_ends_at,
        booking_starts_at, booking_ends_at, reschedule_seq, requested_bucket_id, target_bucket_id, expires_at, consumed_at)
      values ('${ORG}', '${onBooking}', '${u}', ${at(from)}, ${at(to)}, ${at(plusMin(from, 10))}, ${at(plusMin(to, -10))}, 0,
        '${B500}', '${B500}', ${expires}, ${consumed ? "now()" : "null"});`);
  hold(B, b500a, plusMin(SLOT, -10), plusMin(SLOT, 30), "now() + interval '5 minutes'");
  hold(C, booking({ bucket: B400, user: C, start: "2031-03-06T13:00:00.000Z" }), plusMin(SLOT, 300), plusMin(SLOT, 340), "now() + interval '5 minutes'");
  hold(D, booking({ bucket: B300, user: D, start: "2031-03-06T14:00:00.000Z" }), plusMin(SLOT, -10), plusMin(SLOT, 30), "now() - interval '1 second'");
  hold(A, booking({ bucket: B500, user: A, start: "2031-03-06T15:00:00.000Z" }), plusMin(SLOT, -10), plusMin(SLOT, 30), "now() + interval '5 minutes'", true);

  // Business hours: a stored week, and exceptions before and after the date asked from.
  sql(`insert into business_hours (weekday, is_open, start_minute, end_minute) values
      (1, true, 480, 1200), (2, true, 480, 1200), (3, true, 480, 1200), (4, true, 480, 1200),
      (5, true, 480, 1200), (6, false, 600, 900), (7, false, 600, 900)
      on conflict (weekday) do update set is_open = excluded.is_open, start_minute = excluded.start_minute, end_minute = excluded.end_minute;
    insert into business_hours_exceptions (on_date, is_open, start_minute, end_minute, note) values
      ('2031-03-03', false, null, null, 'before'), ('2031-03-04', true, 600, 900, 'short day'),
      ('2031-03-10', false, null, null, 'closed');`);

  const got = inputs(["500", "400", "300", "nope"]);

  // --- buckets: as resolveBucketByCode read them, "*, event_types(*)" ------------------
  const oldBucket = (code: string) =>
    rows(`select to_jsonb(b) || jsonb_build_object('event_types', to_jsonb(e)) as row
            from buckets b left join event_types e on e.id = b.event_type_id where b.code = '${code}'`).map((r) => (r as { row: unknown }).row);
  const buckets = got.buckets as { code: string }[];
  eq(buckets.map((b) => b.code).sort().join(","), "300,400,500", "buckets: every code on the ladder that has a row, and nothing for one that has none");
  for (const code of ["500", "400", "300"]) {
    assert(
      sameRows(buckets.filter((b) => b.code === code), oldBucket(code)),
      `buckets: ${code} is the bucket row with its event type nested, as the bucket read returned it`,
    );
  }

  // --- the roster: resolveBucketPool's org agents, each the WHOLE row getUser reads ----
  const oldAgents = rows(`select * from users where org_id = '${ORG}' and bookable = true and deactivated_at is null`);
  const agents = got.agents as Record<string, unknown>[];
  assert(
    sameRows(agents.map((a) => ms(a, "created_at")), (oldAgents as Record<string, unknown>[]).map((a) => ms(a, "created_at"))) && agents.every((a) => a.org_id === ORG),
    `roster: the org's bookable advisors who have not left, each the whole row the advisor read returns (got ${agents.map((a) => a.id).join(",")})`,
  );

  // --- members: resolveBucketPool's active manual members, per bucket ------------------
  const members = got.members as { bucket_id: string; user_id: string }[];
  for (const [bucket, code] of [[B500, "500"], [B400, "400"], [B300, "300"]] as const) {
    const old = rows(`select user_id from bucket_members where bucket_id = '${bucket}' and active = true`);
    assert(
      sameRows(members.filter((m) => m.bucket_id === bucket).map(({ user_id }) => ({ user_id })), old),
      `members: ${code}'s active manual members, as the pool read returned them`,
    );
  }
  assert(!members.some((m) => m.bucket_id === BOTHER), "members: nothing from a bucket that is not on the ladder");

  // --- schedules, busy time, counts and holds: the old reads for a POOL and a WINDOW ---
  // A pool the judge could work out (every bookable advisor here), and the old reads over
  // the rung's own window, against the function's answer narrowed to them.
  const pool = BOOKABLE;
  const oldSchedules = rows(`select s.id, s.user_id, s.timezone,
      coalesce((select json_agg(json_build_object('schedule_id', r.schedule_id, 'weekday', r.weekday, 'start_minute', r.start_minute, 'end_minute', r.end_minute))
                  from availability_rules r where r.schedule_id = s.id), '[]') as availability_rules
    from availability_schedules s where s.user_id = any(${list(pool)})`);
  const schedules = got.schedules as { user_id: string; availability_rules: unknown[] }[];
  const ruleSorted = (xs: unknown[]) =>
    xs.map((s) => {
      const o = s as { availability_rules: unknown[] };
      return { ...o, availability_rules: sorted(o.availability_rules) };
    });
  assert(
    sameRows(ruleSorted(schedules.filter((s) => pool.includes(s.user_id))), ruleSorted(oldSchedules)),
    "schedules: each pool advisor's schedule with its rules, as the schedules read returned them",
  );
  assert(!schedules.some((s) => s.user_id === OFF || s.user_id === GONE || s.user_id === OTHER), "schedules: nobody outside the roster");

  const oldBusy = rows(`select user_id, starts_at, ends_at, source from busy_blocks
      where user_id = any(${list(pool)}) and starts_at < ${at(RUNG_TO)} and ends_at > ${at(RUNG_FROM)}`);
  const busy = got.busy as { user_id: string; starts_at: string; ends_at: string; source: string }[];
  const inRung = busy.filter((b) => pool.includes(b.user_id) && Date.parse(b.starts_at) < Date.parse(RUNG_TO) && Date.parse(b.ends_at) > Date.parse(RUNG_FROM));
  assert(
    sameRows(inRung.map((b) => ms(b, "starts_at", "ends_at")), (oldBusy as Record<string, unknown>[]).map((b) => ms(b, "starts_at", "ends_at"))),
    "busy: narrowed to the rung's window, the same blocks the busy read returned, sources included",
  );
  // Over the whole superset, every roster block inside it (hold blocks included: placing
  // a hold writes one, 0167, and the caller drops them) and nothing outside it or off it.
  const oldSuper = rows(`select x.user_id, x.starts_at, x.ends_at, x.source from busy_blocks x join users u on u.id = x.user_id
      where u.org_id = '${ORG}' and u.bookable and u.deactivated_at is null
        and x.starts_at < ${at(SUPER_TO)} and x.ends_at > ${at(SUPER_FROM)}`);
  assert(
    sameRows(busy.map((b) => ms(b, "starts_at", "ends_at")), (oldSuper as Record<string, unknown>[]).map((b) => ms(b, "starts_at", "ends_at"))),
    `busy: the superset holds every roster block inside it, and nothing outside it or off the roster (got ${busy.length}, read ${oldSuper.length})`,
  );
  assert(busy.some((b) => b.source === "hold") && !busy.some((b) => [OFF, GONE, OTHER].includes(b.user_id)), "busy control: a hold block is there to drop, and nobody off the roster is");

  // The daily counts: the old RPC over the pool and the rung's cap window, against the
  // function's over the superset, for the slot's local day of each advisor.
  const tzOf = Object.fromEntries((oldSchedules as { user_id: string; timezone: string }[]).map((s) => [s.user_id, s.timezone]));
  const oldCounts = JSON.parse(
    sql(`select count_bookings_per_local_day(${list(pool)}, '${JSON.stringify(tzOf)}'::jsonb, ${at(RUNG_CAP_FROM)}, ${at(RUNG_CAP_TO)})::text;`),
  ) as Record<string, number>;
  const counts = got.day_counts as Record<string, number>;
  const slotDay: Record<string, string> = Object.fromEntries(
    pool.map((u) => [u, new Date(Date.parse(SLOT)).toLocaleDateString("en-CA", { timeZone: tzOf[u] ?? "America/New_York" })]),
  );
  for (const u of pool) {
    const key = `${u}|${slotDay[u]}`;
    eq(counts[key] ?? 0, oldCounts[key] ?? 0, `counts: ${u.slice(-1)}'s bookings on the slot's local day (${slotDay[u]}) match the cap read`);
  }
  assert(Object.keys(oldCounts).length > 0 && Object.values(oldCounts).some((n) => n > 0), "counts control: the seeded bookings are counted at all");

  const oldHolds = rows(`select * from live_reroute_holds(${list(pool)}, ${at(RUNG_FROM)}, ${at(RUNG_TO)})`);
  const holds = got.holds as Record<string, unknown>[];
  const holdsInRung = holds.filter((h) => Date.parse(String(h.buffered_starts_at)) < Date.parse(RUNG_TO) && Date.parse(String(h.buffered_ends_at)) > Date.parse(RUNG_FROM));
  assert(
    sameRows(
      holdsInRung.map((h) => ms(h, "booking_starts_at", "booking_ends_at", "buffered_starts_at", "buffered_ends_at")),
      (oldHolds as Record<string, unknown>[]).map((h) => ms(h, "booking_starts_at", "booking_ends_at", "buffered_starts_at", "buffered_ends_at")),
    ),
    `holds: narrowed to the rung's window, the live unconsumed holds the holds read returned (got ${holdsInRung.length})`,
  );
  eq(oldHolds.length, 1, "holds control: one live hold overlaps the rung; the expired, consumed and far away ones do not");

  // --- shares: rankBucketShare's read, per bucket, for the candidates -----------------
  const shares = got.shares as { bucket_id: string; assigned_user_id: string; starts_at: string; created_at: string }[];
  for (const [bucket, code] of [[B500, "500"], [B400, "400"], [B300, "300"]] as const) {
    const old = rows(`select assigned_user_id, starts_at, created_at from bookings
        where bucket_id = '${bucket}' and kind = 'routed' and starts_at >= ${at(SHARE_FROM)} and starts_at < ${at(SHARE_TO)}
          and assigned_user_id = any(${list(pool)}) and status in ('confirmed', 'rescheduled', 'completed')`);
    const mine = shares.filter((s) => s.bucket_id === bucket && pool.includes(s.assigned_user_id)).map(({ assigned_user_id, starts_at, created_at }) => ({ assigned_user_id, starts_at, created_at }));
    assert(
      sameRows(mine.map((s) => ms(s, "starts_at", "created_at")), (old as Record<string, unknown>[]).map((s) => ms(s, "starts_at", "created_at"))),
      `shares: ${code}'s routed active bookings in the period, as the share read returned them (got ${mine.length})`,
    );
  }
  assert(shares.length > 0, "shares control: the period holds bookings at all");

  // --- business hours and exceptions: loadBusinessHours's two reads -------------------
  assert(
    sameRows(got.business_hours as unknown[], rows("select weekday, is_open, start_minute, end_minute from business_hours")),
    "business hours: the stored week, as the hours read returned it",
  );
  const oldExceptions = rows(`select on_date, is_open, start_minute, end_minute, note from business_hours_exceptions
      where on_date >= '${EXCEPTIONS_FROM}' order by on_date limit 400`);
  eq(canon(got.exceptions), canon(oldExceptions), "exceptions: from the date asked, in date order, as the exceptions read returned them");

  // --- the edges -----------------------------------------------------------------------
  const none = inputs(["nope"]);
  assert(
    JSON.stringify([none.buckets, none.agents, none.members, none.schedules, none.busy, none.shares, none.holds]) === JSON.stringify([[], [], [], [], [], [], []]),
    `edges: a ladder with no bucket rows reads no roster and no rows (got ${JSON.stringify(none).slice(0, 200)})`,
  );
  const other = inputs(["999"]);
  eq((other.agents as { id: string }[]).map((a) => a.id).join(","), OTHER, "edges: a bucket in another org reads that org's roster only");
  for (const role of ["anon", "authenticated"]) {
    let refused = "";
    try {
      inputs(["500"], role);
    } catch (err) {
      refused = (err as Error).message;
    }
    assert(/permission denied/.test(refused), `security: ${role} cannot call it (got ${refused.slice(0, 120) || "an answer"})`);
  }
  let badArgs = "";
  try {
    sql(`select ladder_candidate_inputs(null, ${at(SUPER_FROM)}, ${at(SUPER_TO)}, ${at(CAP_FROM)}, ${at(CAP_TO)}, ${at(SHARE_FROM)}, ${at(SHARE_TO)}, '${EXCEPTIONS_FROM}'::date);`);
  } catch (err) {
    badArgs = (err as Error).message;
  }
  assert(/22023|needs/.test(badArgs), `edges: no codes is refused by name, never read as an empty ladder (got ${badArgs.slice(0, 160)})`);
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  pg.stop();
}

if (process.exitCode === 1) process.exit(1);
finish();
