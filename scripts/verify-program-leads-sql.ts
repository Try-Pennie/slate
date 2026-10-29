// #4387: migration 0213, program leads and the placeholder day limit, proved in a REAL
// Postgres.
//
// What it proves, each beside a control the same statement passes (L1):
//
//   - register_program_lead stores a lead under its 15 character key, refuses anything
//     that is not a Lead key, and a second registration extends the mark rather than
//     shortening it or adding a row;
//   - claim_placeholder_day grants a place while the day's held count is under
//     booking_settings.placeholder_day_limit and refuses at it, where HELD is derived,
//     never stored: active program bookings on the placeholder starting that Eastern
//     day, plus fresh claims whose booking has not committed yet. So a cancel, a move
//     off the placeholder and a move to another day free the place with no release
//     step, a claim whose booking committed is not counted twice, a claim that never
//     committed lapses, and a retry of the same claim is granted again without taking
//     a second place;
//   - a move within the day at the limit is allowed (the booking does not count itself,
//     L1005), and test world bookings never count;
//   - two concurrent claims for the last place: exactly one is granted;
//   - placeholder_day_counts reports the same held figure per day over a range;
//   - the limit setting refuses values outside 0 to 500;
//   - the tables are closed to the web roles and the functions are not executable by
//     them.
//
// It replays EVERY migration into the supabase/postgres image, writes nothing outside
// that container, and removes it on the way out. Not named test-*.ts: it needs Docker.
// No Docker is exit 2, never a pass (L98).
//
// Run: node --experimental-strip-types scripts/verify-program-leads-sql.ts
// (the DB replay workflow also runs it, with every other scripts/verify-*-sql.ts)
import { join } from "node:path";
import { firstErrorLine, replayEveryMigration, startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { bookingInsertSql, realAndTestBucketsSql, callEventTypeSql } from "./lib/seed-sql.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const IMAGE = process.env.PROGRAM_LEADS_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const pg = startThrowawayPostgres(`slate-program-leads-${process.pid}`, IMAGE);
const { sql } = pg;

const ORG = "00000000-0000-0000-0000-0000000000a0";
const ET = "00000000-0000-0000-0000-0000000000e1";
const B100 = "00000000-0000-0000-0000-000000000100";
const BTEST = "00000000-0000-0000-0000-000000000101";
// A Tuesday far enough ahead that every booking is in the future. 2031-03-04 13:00Z is
// 08:00 in New York (EST), so "late" below starts on the 4th in New York and on the 5th
// in UTC: the Eastern day, not the UTC day, is the one counted.
const DAY = "2031-03-04";
const NEXT = "2031-03-05";
const at = (iso: string) => `${iso}:00.000Z`;

let seq = 0;
const nextId = () => `40000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function user(cols: { placeholder?: boolean; test?: boolean } = {}): string {
  const id = nextId().replace(/^4/, "5");
  sql(`insert into users (id, org_id, email, role, is_placeholder, is_test)
       values ('${id}', '${ORG}', '${id}@example.com', 'agent', ${cols.placeholder ?? false}, ${cols.test ?? false});`);
  return id;
}

interface Seed {
  agent: string;
  start: string;
  end: string;
  program?: boolean;
  bucket?: string;
  status?: "confirmed" | "rescheduled" | "cancelled";
}
/** One booking; a placeholder one is staff_placed and stacks, as 0208 requires. Returns its id; its idempotency key is `key-<id>`. */
function booking(s: Seed, placeholder: boolean): string {
  const id = nextId();
  let insert = bookingInsertSql({
    id, orgId: ORG, bucketId: s.bucket ?? B100, eventTypeId: ET, assignedUserId: s.agent,
    startIso: at(s.start), endIso: at(s.end), kind: placeholder ? "staff_placed" : "routed", status: s.status,
  });
  if (placeholder) insert = insert.replace("insert into bookings (id,", "insert into bookings (allow_double_book, id,").replace("values ('", "values (true, '");
  sql(insert);
  if (s.program) sql(`update bookings set program_lead = true where id = '${id}';`);
  return id;
}

const setLimit = (n: number) => sql(`update booking_settings set placeholder_day_limit = ${n} where id = 1;`);
const claim = (day: string, key: string, bookingId: string | null = null) =>
  sql(`select claim_placeholder_day('${day}'::date, '${key}', ${bookingId ? `'${bookingId}'::uuid` : "null"})::text;`, "service_role");
const held = (day: string) =>
  sql(`select coalesce((select held from placeholder_day_counts('${day}'::date, '${day}'::date) where call_day = '${day}'::date), -1);`, "service_role");

try {
  const applied = replayEveryMigration(pg, DIR);
  assert(applied > 200, `the schema for program leads: every migration applied to an empty database (${applied})`);
  sql(`
    insert into organizations (id, name) values ('${ORG}', 'Booking org');
    ${callEventTypeSql(ORG, ET)}
    ${realAndTestBucketsSql(ORG, ET, B100, BTEST)}
    insert into booking_settings (id) values (1) on conflict (id) do nothing;
  `);
  const P = user({ placeholder: true });
  const PT = user({ placeholder: true, test: true });
  const REAL = user();

  // --- registering a lead --------------------------------------------------------------------
  {
    const first = sql(`select register_program_lead('00Q5f00000AbCdE', 'bidspoke')::text;`, "service_role");
    assert(/^\d{4}-\d\d-\d\d/.test(first), `a Lead key registers and answers when its mark expires (${first})`);
    eq(
      sql(`select round(extract(epoch from (expires_at - registered_at)) / 86400)::text from program_leads where lead_key = '00Q5f00000AbCdE';`),
      "30",
      "the mark lasts 30 days",
    );
    sql(`update program_leads set expires_at = now() + interval '40 days' where lead_key = '00Q5f00000AbCdE';`);
    sql(`select register_program_lead('00Q5f00000AbCdE', 'bidspoke');`, "service_role");
    eq(
      sql(`select count(*) || '|' || (expires_at > now() + interval '39 days')::text from program_leads where lead_key = '00Q5f00000AbCdE' group by expires_at;`),
      "1|true",
      "registering again keeps one row and never shortens a longer mark",
    );
    sql(`update program_leads set expires_at = now() + interval '1 day' where lead_key = '00Q5f00000AbCdE';`);
    sql(`select register_program_lead('00Q5f00000AbCdE', 'bidspoke');`, "service_role");
    eq(
      sql(`select (expires_at > now() + interval '29 days')::text from program_leads where lead_key = '00Q5f00000AbCdE';`),
      "true",
      "and extends a mark about to lapse to a full 30 days",
    );
    for (const bad of ["00Q5f00000AbCdEFGH", "0035f00000AbCdE", "00Q5f00000AbC-E", ""]) {
      const err = pg.verboseError(`select register_program_lead('${bad}', 'bidspoke');`);
      assert(err !== null && /23514|22023/.test(err), `"${bad}" is refused as a Lead key (got ${firstErrorLine(err)})`);
    }
  }

  // --- the held count and the limit ----------------------------------------------------------
  setLimit(2);
  eq(held(DAY), "0", "control: an empty day holds nothing");
  const a = booking({ agent: P, start: `${DAY}T14:00`, end: `${DAY}T14:20`, program: true }, true);
  booking({ agent: P, start: `${DAY}T14:00`, end: `${DAY}T14:20` }, true); // a coordinator's call, not a program lead
  booking({ agent: REAL, start: `${DAY}T15:00`, end: `${DAY}T15:20`, program: true }, false); // a program lead on a real advisor
  booking({ agent: PT, start: `${DAY}T14:00`, end: `${DAY}T14:20`, program: true, bucket: BTEST }, true); // the test world
  eq(held(DAY), "1", "only a program lead's active booking on the placeholder holds a place; a coordinator call, a real advisor and the test world do not");

  // Eastern day, not UTC day: 03:30Z on the 5th is 22:30 on the 4th in New York.
  const late = booking({ agent: P, start: `${NEXT}T03:30`, end: `${NEXT}T03:50`, program: true }, true);
  eq(held(DAY), "2", "a call late in the Eastern evening counts on its Eastern day");
  eq(held(NEXT), "0", "and not on the UTC day it falls in");

  eq(claim(DAY, "fresh-1"), "false", "at the limit a new claim is refused");
  eq(claim(DAY, "move-a", a), "true", "a move within the day at the limit is allowed: the booking does not count itself");

  sql(`update bookings set status = 'cancelled' where id = '${late}';`);
  eq(held(DAY), "1", "a cancel frees its place with no release step");
  eq(claim(DAY, "fresh-2"), "true", "so a new claim is granted");
  eq(held(DAY), "2", "and the fresh claim holds a place while its booking is in flight");
  eq(claim(DAY, "fresh-2"), "true", "a retry of the same claim is granted again");
  eq(held(DAY), "2", "without taking a second place");

  // The claim's booking commits under the same key: counted once, as the booking.
  const committed = booking({ agent: P, start: `${DAY}T16:00`, end: `${DAY}T16:20`, program: true }, true);
  sql(`update bookings set idempotency_key = 'fresh-2' where id = '${committed}';`);
  eq(held(DAY), "2", "a claim whose booking committed is counted once, not twice");

  // A claim that never committed lapses.
  setLimit(3);
  eq(claim(DAY, "abandoned"), "true", "control: a third place is granted under a limit of 3");
  eq(held(DAY), "3", "and held while fresh");
  sql(`update placeholder_day_claims set claimed_at = now() - interval '16 minutes' where claim_key = 'abandoned';`);
  eq(held(DAY), "2", "a claim older than 15 minutes whose booking never committed no longer holds a place");
  setLimit(2);
  eq(claim(DAY, "abandoned"), "false", "and a retry of the lapsed claim is judged afresh: refused once the day is full");
  setLimit(3);

  // A move to another day frees the old day; a move off the placeholder frees it too.
  sql(`update bookings set starts_at = '${at(`${NEXT}T15:00`)}', ends_at = '${at(`${NEXT}T15:20`)}' where id = '${committed}';`);
  eq(`${held(DAY)}|${held(NEXT)}`, "1|1", "a move to another day moves its place with it");
  eq(held(DAY), "1", "control: the program booking still on the placeholder holds the day's one place, its move claim folded into it");
  sql(`update bookings set assigned_user_id = '${REAL}', allow_double_book = false where id = '${a}';`);
  eq(held(DAY), "0", "a move off the placeholder frees its place, and its move claim, written before the move, no longer holds one");

  // The range read agrees with the per day figure.
  eq(
    sql(`select string_agg(call_day || '=' || held, ',' order by call_day) from placeholder_day_counts('${DAY}'::date, '${NEXT}'::date);`, "service_role"),
    `${DAY}=0,${NEXT}=1`,
    "placeholder_day_counts reports every day of the range, empty days as 0",
  );

  // --- two concurrent claims for the last place ---------------------------------------------
  setLimit(1);
  const RACE_DAY = "2031-03-06";
  eq(held(RACE_DAY), "0", "control: the race day starts empty, so its one place is open");
  sql("create table claim_race (granted boolean);");
  const racer = async (key: string) =>
    (
      await pg.session(`begin;
        insert into claim_race select claim_placeholder_day('${RACE_DAY}'::date, '${key}', null);
        select pg_sleep(1);
        commit;`)
    ).code;
  eq(await Promise.all([racer("race-1"), racer("race-2")]), [0, 0], "both concurrent claims ran to completion");
  eq(sql("select string_agg(granted::text, ',' order by granted) from claim_race;"), "false,true", "exactly one concurrent claim for the last place is granted");

  // --- the setting's bounds -------------------------------------------------------------------
  for (const n of [-1, 501]) {
    const err = pg.verboseError(`update booking_settings set placeholder_day_limit = ${n} where id = 1;`);
    assert(err !== null && /23514/.test(err), `a limit of ${n} is refused (got ${firstErrorLine(err)})`);
  }
  eq(sql("select placeholder_day_limit::text from booking_settings where id = 1;"), "1", "control: an in range limit was stored");
  eq(sql("select column_default from information_schema.columns where table_name = 'booking_settings' and column_name = 'placeholder_day_limit';"), "50", "the limit starts at 50");

  // --- closed to the web roles --------------------------------------------------------------
  for (const role of ["anon", "authenticated"]) {
    for (const table of ["program_leads", "placeholder_day_claims"]) {
      eq(sql(`select count(*) from ${table};`, role), "0", `${role} sees no ${table} rows (row security, default deny)`);
    }
    for (const call of [
      "select register_program_lead('00Q5f00000ZzZzZ', 'x');",
      `select claim_placeholder_day('${DAY}'::date, 'web', null);`,
      `select * from placeholder_day_counts('${DAY}'::date, '${DAY}'::date);`,
    ]) {
      const err = pg.verboseError(call, role);
      assert(err !== null && /42501|permission denied/.test(err), `${role} cannot run ${call.split("(")[0].replace("select ", "")} (got ${firstErrorLine(err)})`);
    }
  }
  eq(sql(`select count(*) from program_leads;`, "service_role"), "1", "control: the server role reads the table");
} finally {
  pg.stop();
}
finish();
