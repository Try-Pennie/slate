// #4200: migration 0207's placeholder advisor data model, proved in a REAL Postgres.
//
// What it proves, each beside a control the same statement passes without the change (L1):
//
//   - a placeholder advisor can never be bookable (users_placeholder_never_bookable), so
//     the round robin pool, which reads bookable, cannot route a public booking to it;
//   - at most one real and one test placeholder per org (users_one_placeholder_per_org);
//   - a booking may be staff_placed, and source 'coordinator', while a kind or source
//     nobody decided is still refused;
//   - placed_by_user_id names a person, and removing that person nulls it rather than
//     blocking or deleting the booking;
//   - the go live switch exists and starts OFF on the settings row.
//
// It replays EVERY migration into the supabase/postgres image, writes nothing outside
// that container, and removes it on the way out. Not named test-*.ts: it needs Docker.
// No Docker is exit 2, never a pass (L98).
//
// Run: node --experimental-strip-types scripts/verify-placeholder-advisor-sql.ts
// (the DB replay workflow also runs it, with every other scripts/verify-*-sql.ts)
import { join } from "node:path";
import { replayEveryMigration, startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { bookingInsertSql, bucketsInsertSql, eventTypesInsertSql } from "./lib/seed-sql.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const IMAGE = process.env.PLACEHOLDER_PG_IMAGE ?? "supabase/postgres:17.6.1.175";
const pg = startThrowawayPostgres(`slate-placeholder-${process.pid}`, IMAGE);
const { sql } = pg;

const ORG = "00000000-0000-0000-0000-0000000000a0";
const ORG2 = "00000000-0000-0000-0000-0000000000a2";
const ET = "00000000-0000-0000-0000-0000000000e1";
const B100 = "00000000-0000-0000-0000-000000000100";
let seq = 0;
const nextId = () => `30000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const firstLine = (e: string | null) => e?.split("\n").find((l) => /ERROR/.test(l)) ?? e?.split("\n")[0] ?? "it ran";

/** A users row; returns its id. */
function user(org: string, cols: { placeholder?: boolean; test?: boolean; bookable?: boolean } = {}): string {
  const id = nextId();
  sql(`insert into users (id, org_id, email, role, is_placeholder, is_test, bookable)
       values ('${id}', '${org}', '${id}@example.com', 'agent', ${cols.placeholder ?? false}, ${cols.test ?? false}, ${cols.bookable ?? false});`);
  return id;
}
/** The same insert, expected to be refused: the verbose error, or null if it ran. */
function userRefused(org: string, cols: { placeholder?: boolean; test?: boolean; bookable?: boolean }): string | null {
  const id = nextId();
  return pg.verboseError(`insert into users (id, org_id, email, role, is_placeholder, is_test, bookable)
       values ('${id}', '${org}', '${id}@example.com', 'agent', ${cols.placeholder ?? false}, ${cols.test ?? false}, ${cols.bookable ?? false});`);
}

try {
  const applied = replayEveryMigration(pg, DIR);
  assert(applied > 200, `every migration applied to an empty database (${applied})`);
  sql(`
    insert into organizations (id, name) values ('${ORG}', 'Placeholder org'), ('${ORG2}', 'Second org');
    ${eventTypesInsertSql([{ id: ET, orgId: ORG, name: "Call", durationMin: 20, bufferBeforeMin: 10, bufferAfterMin: 10 }])}
    ${bucketsInsertSql([{ id: B100, orgId: ORG, code: "100", name: "Low", eventTypeId: ET }])}
  `);

  // --- a placeholder is never bookable -------------------------------------------------
  {
    const err = userRefused(ORG2, { placeholder: true, bookable: true });
    assert(err !== null && /23514[\s\S]*users_placeholder_never_bookable/.test(err), `a bookable placeholder is refused (got ${firstLine(err)})`);
    const p = user(ORG2, { placeholder: true });
    eq(sql(`select bookable::text from users where id = '${p}';`), "false", "control: an unbookable placeholder is accepted");
    const flip = pg.verboseError(`update users set bookable = true where id = '${p}';`);
    assert(flip !== null && /users_placeholder_never_bookable/.test(flip), `making the placeholder bookable later is refused too (got ${firstLine(flip)})`);
    const real = user(ORG2, { bookable: true });
    eq(sql(`select bookable::text from users where id = '${real}';`), "true", "control: a real advisor may be bookable");
    eq(sql(`select is_placeholder::text from users where id = '${real}';`), "false", "and a row that names no marker is not a placeholder");
  }

  // --- one real and one test placeholder per org ----------------------------------------
  {
    user(ORG, { placeholder: true });
    const second = userRefused(ORG, { placeholder: true });
    assert(second !== null && /23505[\s\S]*users_one_placeholder_per_org/.test(second), `a second real placeholder in one org is refused (got ${firstLine(second)})`);
    user(ORG, { placeholder: true, test: true });
    eq(sql(`select count(*) from users where org_id = '${ORG}' and is_placeholder;`), "2", "control: one test placeholder beside the real one is accepted");
    const secondTest = userRefused(ORG, { placeholder: true, test: true });
    assert(secondTest !== null && /users_one_placeholder_per_org/.test(secondTest), `a second test placeholder is refused (got ${firstLine(secondTest)})`);
    user(ORG, {});
    user(ORG, {});
    eq(sql(`select count(*) from users where org_id = '${ORG}' and not is_placeholder;`), "2", "control: the index leaves ordinary advisors alone");
  }

  // --- the booking kind, the source and who placed it ------------------------------------
  {
    const placeholder = sql(`select id from users where org_id = '${ORG}' and is_placeholder and not is_test;`);
    const coordinator = user(ORG, {});
    const at = (h: string) => `2031-03-04T${h}:00.000Z`;
    const id = nextId();
    // Stacking from the insert: since 0208 a booking on the placeholder must stack (#4202).
    sql(bookingInsertSql({ id, orgId: ORG, bucketId: B100, eventTypeId: ET, assignedUserId: placeholder, startIso: at("15:00"), endIso: at("15:20"), kind: "staff_placed" }).replace("insert into bookings (id,", "insert into bookings (allow_double_book, id,").replace("values ('", "values (true, '"));
    sql(`update bookings set source = 'coordinator', placed_by_user_id = '${coordinator}' where id = '${id}';`);
    eq(sql(`select kind || '|' || source || '|' || placed_by_user_id from bookings where id = '${id}';`), `staff_placed|coordinator|${coordinator}`,
      "a booking may be staff_placed, from the coordinator page, naming who placed it");
    // Stacked: a second staff placed call at the same time on the same placeholder.
    const stacked = nextId();
    sql(bookingInsertSql({ id: stacked, orgId: ORG, bucketId: B100, eventTypeId: ET, assignedUserId: placeholder, startIso: at("15:00"), endIso: at("15:20"), kind: "staff_placed" }).replace("'booking');", "'coordinator');").replace("insert into bookings (id,", "insert into bookings (allow_double_book, id,").replace("values ('", "values (true, '"));
    eq(sql(`select count(*) from bookings where assigned_user_id = '${placeholder}' and starts_at = '${at("15:00")}';`), "2", "two calls stack on the placeholder at one time while both carry allow_double_book");

    const badKind = pg.verboseError(bookingInsertSql({ id: nextId(), orgId: ORG, bucketId: B100, eventTypeId: ET, assignedUserId: coordinator, startIso: at("16:00"), endIso: at("16:20"), kind: "staff" }));
    assert(badKind !== null && /23514[\s\S]*bookings_kind_check/.test(badKind), `a kind nobody decided is still refused (got ${firstLine(badKind)})`);
    const badSource = pg.verboseError(`update bookings set source = 'coordinators' where id = '${id}';`);
    assert(badSource !== null && /23514[\s\S]*bookings_source_check/.test(badSource), `a source nobody decided is still refused (got ${firstLine(badSource)})`);
    for (const kind of ["routed", "agent_link"]) {
      const ok = nextId();
      sql(bookingInsertSql({ id: ok, orgId: ORG, bucketId: B100, eventTypeId: ET, assignedUserId: coordinator, startIso: at(kind === "routed" ? "17:00" : "18:00"), endIso: at(kind === "routed" ? "17:20" : "18:20"), kind }));
      eq(sql(`select kind from bookings where id = '${ok}';`), kind, `control: the existing kind ${kind} is still accepted`);
    }

    // Removing the person who placed it leaves the booking, with nobody named.
    sql(`update bookings set placed_by_user_id = null where placed_by_user_id = '${coordinator}' and id <> '${id}';`);
    sql(`delete from bookings where assigned_user_id = '${coordinator}';`);
    sql(`delete from users where id = '${coordinator}';`);
    eq(sql(`select coalesce(placed_by_user_id::text, 'null') || '|' || status from bookings where id = '${id}';`), "null|confirmed",
      "removing the coordinator nulls placed_by_user_id and keeps the booking");
  }

  // --- the go live switch starts off ------------------------------------------------------
  eq(sql(`select column_default || '|' || is_nullable from information_schema.columns
            where table_name = 'booking_settings' and column_name = 'placeholder_booking_enabled';`),
    "false|NO", "placeholder_booking_enabled is NOT NULL and defaults off");
  sql(`insert into booking_settings (id) values (1) on conflict (id) do nothing;`);
  eq(sql(`select placeholder_booking_enabled::text from booking_settings where id = 1;`), "false", "and a settings row nobody touched reads off");
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  pg.stop();
}

if (process.exitCode === 1) process.exit(1);
finish();
