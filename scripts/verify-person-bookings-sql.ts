// #3476: a lead's active bookings in ONE call, proved in a REAL Postgres.
//
// Every confirm's person check read the lead's active bookings with one request per
// signal: each strong id against `external_id` and again against `salesforce_id`, the
// email, and the phone, each joining the bucket for its world. Request COUNT is what
// queues a crowd (#3492), so `find_active_bookings_for_person` answers all of them in
// one. What it must not change is which rows come back, so this suite holds the
// function to the old reads themselves, restated in SQL exactly as PostgREST ran them
// (`findActiveBookingsForPerson` before #3476: one `eq` or `ilike` per signal, active
// statuses, the bucket's world, at most 20 rows), for every signal shape.
//
// The values arrive as PARAMETERS, never as filter text: a caller supplied id inside a
// PostgREST `or` filter would be parsed as syntax, which is why the reads were separate
// (see `findActiveBookingsByStrongIds`). So an id carrying filter syntax is one of the
// shapes, and must match only itself.
//
// It replays EVERY migration into the supabase/postgres image (its roles and default
// grants, L714) and calls the function as service_role, the server's role. It writes
// nothing outside that container, which it removes on the way out. Not named
// test-*.ts: it needs Docker. No Docker is exit 2, never a pass (L98).
//
// Run: node --experimental-strip-types scripts/verify-person-bookings-sql.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replayEveryMigration, startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { bookingInsertSql } from "./lib/seed-sql.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { readPersonBookings } from "../src/lib/booking/person-bookings-answer.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const FIXTURES = join(import.meta.dirname, "fixtures");
const IMAGE = process.env.PERSON_BOOKINGS_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const NAME = `slate-person-bookings-${process.pid}`;

const pg = startThrowawayPostgres(NAME, IMAGE);
const { sql } = pg;

const ORG = "00000000-0000-0000-0000-0000000000a0";
const A = "00000000-0000-0000-0000-00000000000a";
const ET = "00000000-0000-0000-0000-0000000000e1";
const REAL = "00000000-0000-0000-0000-000000000100";
const TEST = "00000000-0000-0000-0000-000000000900";

let seq = 0;
let minute = 0;
const nextId = () => `20000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/** One booking, with only the person's signals and the world varied. Each at its own start. */
function insertBooking(o: {
  externalId?: string | null;
  salesforceId?: string | null;
  email?: string | null;
  phone?: string | null;
  status?: string;
  test?: boolean;
}): string {
  const id = nextId();
  const start = new Date(Date.UTC(2031, 2, 4, 9) + minute++ * 30 * 60_000).toISOString();
  const end = new Date(Date.parse(start) + 20 * 60_000).toISOString();
  sql(
    bookingInsertSql({
      id,
      orgId: ORG,
      bucketId: o.test ? TEST : REAL,
      eventTypeId: ET,
      assignedUserId: A,
      startIso: start,
      endIso: end,
      status: o.status,
      attendeeEmail: o.email,
      attendeePhone: o.phone,
      externalId: o.externalId,
      salesforceId: o.salesforceId,
    }),
  );
  return id;
}

const text = (v: string | null) => (v === null ? "null" : `'${v.replace(/'/g, "''")}'`);
const arr = (ids: readonly string[]) => `array[${ids.map((i) => text(i)).join(", ")}]::text[]`;

/** The LIKE escaping the caller applies (`escapeLike`), so the suite sends what the server sends. */
const likeOf = (email: string) => email.replace(/\\/g, "\\\\").replace(/[_%]/g, "\\$&");

type Signals = { ids?: string[]; email?: string | null; phone?: string | null };

/** The function, called as the server calls it, its answer read by the server's own reader. */
function lookup(s: Signals, world: string, role = "service_role") {
  const out = sql(
    `select find_active_bookings_for_person(
       p_ids => ${arr(s.ids ?? [])}, p_email_like => ${text(s.email ? likeOf(s.email) : null)},
       p_phone => ${text(s.phone ?? null)}, p_world => ${text(world)})::text;`,
    role,
  );
  return readPersonBookings(JSON.parse(out));
}

/**
 * The reads `findActiveBookingsForPerson` made before #3476, restated in SQL as
 * PostgREST ran them: one per strong id per column, one for the email (ilike, escaped)
 * and one for the phone, each over active bookings in the world, each at most 20 rows,
 * merged by id. Ids only: which 20 a capped read returns is unordered, so the bound is
 * checked on its own below.
 */
function oldReads(s: Signals, isTest: boolean | null): string[] {
  const world = isTest === null ? "true" : `bu.is_test = ${isTest}`;
  const read = (where: string) =>
    `(select b.id::text from bookings b join buckets bu on bu.id = b.bucket_id
       where ${where} and b.status in ('confirmed', 'rescheduled') and ${world} limit 20)`;
  const parts: string[] = [];
  for (const id of s.ids ?? []) {
    parts.push(read(`b.external_id = ${text(id)}`), read(`b.salesforce_id = ${text(id)}`));
  }
  if (s.email) parts.push(read(`b.attendee_email ilike ${text(likeOf(s.email))}`));
  if (s.phone) parts.push(read(`b.attendee_phone = ${text(s.phone)}`));
  if (parts.length === 0) return [];
  const out = sql(`select coalesce(string_agg(id, ',' order by id), '') from (${parts.join(" union ")}) u;`);
  return out === "" ? [] : out.split(",");
}

/** The function asked in the world of the bucket with this code (#3489). */
function lookupInBucket(s: Signals, code: string) {
  const out = sql(
    `select find_active_bookings_for_person(
       p_ids => ${arr(s.ids ?? [])}, p_email_like => ${text(s.email ? likeOf(s.email) : null)},
       p_phone => ${text(s.phone ?? null)}, p_world => 'bucket', p_bucket_code => ${text(code)})::text;`,
  );
  return readPersonBookings(JSON.parse(out));
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

try {
  const applied = replayEveryMigration(pg, DIR);
  assert(applied > 170, `the schema for the person lookup: every migration applied to an empty database (${applied})`);
  sql(`
    insert into organizations (id, name) values ('${ORG}', 'Person org');
    insert into users (id, org_id, email, role) values ('${A}', '${ORG}', 'a@trypennie.com', 'agent');
    insert into event_types (id, org_id, name, duration_min) values ('${ET}', '${ORG}', 'Call', 20);
    insert into buckets (id, org_id, code, name, event_type_id, is_test) values
      ('${REAL}', '${ORG}', '100', 'Low', '${ET}', false),
      ('${TEST}', '${ORG}', 'SMOKE', 'Smoke', '${ET}', true);
  `);

  // --- the people: every signal, in both worlds, active and not ---------------------------
  const lead = insertBooking({ externalId: "00QLEAD000001", email: "dana@example.com", phone: "+12155550100" });
  const embed = insertBooking({ salesforceId: "00QLEAD000001" }); // an embed booking: the id in salesforce_id only
  const byEmail = insertBooking({ email: "Dana@Example.com" }); // case differs
  const underscore = insertBooking({ email: "john_doe@example.com" });
  const lookalike = insertBooking({ email: "johnXdoe@example.com" }); // `_` must not act as a wildcard
  const byPhone = insertBooking({ phone: "+12155550199" });
  const cancelled = insertBooking({ externalId: "00QLEAD000001", status: "cancelled" });
  const testWorld = insertBooking({ externalId: "00QLEAD000001", email: "dana@example.com", test: true });
  const syntax = insertBooking({ externalId: "a,b)" }); // filter syntax, as a value
  const other = insertBooking({ externalId: "00QOTHER00001", email: "someone@example.com", phone: "+12155550142" });

  // --- the same rows as the old reads, for every signal shape ------------------------------
  const shapes: [string, Signals][] = [
    ["one strong id, in either column", { ids: ["00QLEAD000001"] }],
    ["two strong ids", { ids: ["00QLEAD000001", "00QOTHER00001"] }],
    ["an email, case insensitive", { email: "dana@example.com" }],
    ["an email with an underscore", { email: "john_doe@example.com" }],
    ["a phone", { phone: "+12155550199" }],
    ["every signal at once", { ids: ["00QLEAD000001"], email: "dana@example.com", phone: "+12155550199" }],
    ["an id carrying filter syntax", { ids: ["a,b)"] }],
    ["signals matching nothing", { ids: ["00QNOBODY0001"], email: "nobody@example.com", phone: "+12155550000" }],
  ];
  for (const [label, s] of shapes) {
    for (const [world, isTest] of [["real", false], ["test", true], ["both", null]] as const) {
      const got = ids(lookup(s, world));
      const want = oldReads(s, isTest);
      assert(same(got, want), `${label}, ${world} world: the old reads' rows (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
    }
  }

  // Positive controls, so the equality above is not two empty lists agreeing (L159).
  const real = ids(lookup({ ids: ["00QLEAD000001"], email: "dana@example.com" }, "real"));
  assert(same(real, [lead, embed, byEmail].sort()), `the real world finds the lead by id in both columns and by email, any case (got ${JSON.stringify(real)})`);
  assert(!real.includes(cancelled), "never a cancelled booking");
  assert(!real.includes(testWorld), "never a test world booking for a real lead (#2660)");
  const test = ids(lookup({ ids: ["00QLEAD000001"] }, "test"));
  assert(same(test, [testWorld]), `the test world finds only its own (got ${JSON.stringify(test)})`);
  const both = lookup({ ids: ["00QLEAD000001"] }, "both");
  eq(ids(both).length, 3, "both worlds, for the lookup API: the real two and the test one");
  assert(both.every((r) => r.isTest === (r.id === testWorld)), "and each says which world it is in");
  const escaped = ids(lookup({ email: "john_doe@example.com" }, "real"));
  assert(same(escaped, [underscore]), `an underscore is a character, never a wildcard (got ${JSON.stringify(escaped)})`);
  assert(!escaped.includes(lookalike), "so the lookalike address is not fetched");
  const literal = ids(lookup({ ids: ["a,b)"] }, "real"));
  assert(same(literal, [syntax]), `an id carrying filter syntax matches only itself (got ${JSON.stringify(literal)})`);
  eq(ids(lookup({ phone: "+12155550199" }, "real")).join(), byPhone, "a phone finds its booking");
  eq(lookup({}, "real").length, 0, "no signals at all is an empty answer, not an error");
  assert(!real.includes(other), "and nobody else's booking rides along");

  // --- the 20 row bound, per signal, as before -----------------------------------------------
  for (let i = 0; i < 25; i++) insertBooking({ email: "busy@example.com" });
  eq(lookup({ email: "busy@example.com" }, "real").length, 20, "one signal answers at most 20 rows, the old bound");
  const busyPlusPhone = lookup({ email: "busy@example.com", phone: "+12155550199" }, "real");
  eq(busyPlusPhone.length, 21, "and the bound is per signal: another signal's row still comes back");

  // --- it reaches the indexes, never every active booking ------------------------------------
  // The person check runs on every confirm, so the function must look each signal up
  // through its index (scripts/test-person-lookup-indexes.ts) rather than build the set
  // of every active booking first and filter that. A CTE referenced more than once is
  // materialized by default, which is exactly that full build. Read from the plan the
  // database actually ran (auto_explain, nested statements), with sequential scans
  // switched off so a table this small still has to show which path EXISTS.
  const planned = await pg.session(`
    load 'auto_explain';
    set auto_explain.log_min_duration = 0;
    set auto_explain.log_nested_statements = on;
    set auto_explain.log_level = notice;
    set client_min_messages = notice;
    set enable_seqscan = off;
    select find_active_bookings_for_person(array['00QLEAD000001']::text[], 'dana@example.com', '+12155550199', 'real');
  `, "supabase_admin");
  const plan = planned.stderr;
  assert(planned.code === 0 && /Index Cond: \(external_id = /.test(plan) && /Index Cond: \(salesforce_id = /.test(plan),
    `an id is looked up through the external_id and salesforce_id indexes (plan: ${plan.replace(/\s+/g, " ").slice(0, 600)})`);
  assert(/Index Cond: \(attendee_phone = /.test(plan), "and a phone through the attendee_phone index");
  // The email is judged on a bookings scan of its own, never on a prebuilt set. Which
  // index serves it on a table this small is the planner's choice (the trigram index is
  // pinned to exist by scripts/test-person-lookup-indexes.ts); what was wrong was that
  // the predicate could not reach a bookings scan at all.
  const flat = plan.replace(/\s+/g, " ");
  // Within ONE plan node: no `->` (the start of another node) between the bookings
  // scan and the email condition.
  assert(/Scan (?:using \w+ )?on bookings \w+ \(cost=(?:(?!->).)*?(?:Filter|Index Cond|Recheck Cond): \(attendee_email ~~\* /.test(flat),
    "and an email is judged on a bookings scan of its own");
  assert(!/CTE Scan/.test(plan), `and nothing scans a materialized set of every active booking (plan: ${plan.replace(/\s+/g, " ").slice(0, 600)})`);

  // --- the world of a BUCKET, so the person read runs beside the bucket read (#3489) ----------
  // The confirm read the bucket, waited, then asked for the person's bookings in its world:
  // two round trips one after the other on every confirm. Named by the bucket's code, the
  // function finds the world itself, so both reads go out at once. Same rows as naming the
  // world, for every shape.
  for (const [label, s] of shapes) {
    for (const [code, world] of [["100", "real"], ["SMOKE", "test"]] as const) {
      const got = ids(lookupInBucket(s, code));
      const want = ids(lookup(s, world));
      assert(same(got, want), `${label}, bucket ${code}: the ${world} world's rows (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
    }
  }
  assert(ids(lookupInBucket({ ids: ["00QLEAD000001"] }, "SMOKE")).join() === testWorld, "control: the test bucket's world finds only the test booking");
  for (const [what, code] of [["a code no bucket has", "'NOPE'"], ["no code", "null"]] as const) {
    const e = pg.verboseError(`select find_active_bookings_for_person(p_ids => array['00QLEAD000001']::text[], p_email_like => null, p_phone => null, p_world => 'bucket', p_bucket_code => ${code});`);
    assert(e !== null && /22023/.test(e), `the bucket world with ${what} is refused, never read as no bookings (got ${e?.split("\n")[0] ?? "a result"})`);
  }

  // --- the world is named, never defaulted (L168) -----------------------------------------------
  for (const bad of ["", "everything"]) {
    const e = pg.verboseError(`select find_active_bookings_for_person(p_ids => array[]::text[], p_email_like => null, p_phone => null, p_world => ${text(bad)});`);
    assert(e !== null && /22023/.test(e), `a world of ${JSON.stringify(bad)} is refused (got ${e?.split("\n")[0] ?? "a result"})`);
  }
  const nullWorld = pg.verboseError(`select find_active_bookings_for_person(p_ids => array[]::text[], p_email_like => null, p_phone => null, p_world => null);`);
  assert(nullWorld !== null && /22023/.test(nullWorld), `a missing world is refused rather than read as both (got ${nullWorld?.split("\n")[0] ?? "a result"})`);

  // --- the answer has the shape the TypeScript reader is tested against (L26) ------------------
  const fixture = JSON.parse(readFileSync(join(FIXTURES, "person-bookings-answer.json"), "utf8")) as { rows: Record<string, unknown>[] };
  const realAnswer = JSON.parse(sql(`select find_active_bookings_for_person(p_ids => array['00QLEAD000001']::text[], p_email_like => null, p_phone => null, p_world => 'real')::text;`)) as Record<string, unknown>[];
  const realKeys = Object.keys(realAnswer[0]!).sort();
  // Every column the table has, read from the table itself rather than from the function (L70).
  const columns = sql(`select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema = 'public' and table_name = 'bookings';`).split(",");
  eq(realKeys.join(), [...columns, "is_test"].sort().join(), "a row carries every bookings column and its world, nothing more");
  for (const row of fixture.rows) {
    const stray = Object.keys(row).filter((k) => k !== "_comment" && !realKeys.includes(k));
    eq(stray.join(), "", "every key the reader's fixture carries is one the live answer carries");
  }

  // --- who may call it ------------------------------------------------------------------------
  for (const role of ["anon", "authenticated"]) {
    const err = pg.verboseError(`select find_active_bookings_for_person(p_ids => array['00QLEAD000001']::text[], p_email_like => null, p_phone => null, p_world => 'real');`, role);
    assert(err !== null && /permission denied/.test(err), `${role} cannot execute it (got ${err?.split("\n")[0] ?? "a result"})`);
  }
  // Every call above ran as service_role, so a missing grant to the server's own role
  // fails this suite rather than every confirm in production (L159).
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  pg.stop();
}

if (process.exitCode === 1) process.exit(1);
finish();
