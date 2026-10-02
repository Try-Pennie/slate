// `pnpm verify:advisor-photos-sql` (#3027): migration 0156 in a REAL Postgres.
//
// The offline suites have no database, and a mocked client agrees with whatever it
// is told (L52), so the table's promises are proved here: an image is stored as
// base64 text and the bytes read back hash to what was written; the image columns
// are set exactly when the state is 'photo'; a hash must be 64 lower case hex; the
// browser roles cannot read the table even though default privileges would have
// granted it (L124); and a deleted user's row goes with them.
//
// It starts a throwaway Postgres in Docker, lays down the slice of the schema the
// migration reads, applies the migration file verbatim, and removes the container.
// NOT named test-*.ts: it needs Docker, which the offline suite does not have. With
// no Docker it exits 2 and says UNMEASURED, never a pass (L98, L411).
import { startThrowawayPostgres } from "./lib/throwaway-postgres.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assert, eq, finish } from "./lib/harness.ts";

const MIGRATION = readFileSync(fileURLToPath(new URL("../supabase/migrations/0156_advisor_photos.sql", import.meta.url)), "utf8");
const IMAGE = process.env.ADVISOR_PHOTOS_PG_IMAGE ?? "postgres:17-alpine";
const NAME = `slate-advisor-photos-${process.pid}`;

const pg = startThrowawayPostgres(NAME, IMAGE);
const { sql, sqlError } = pg;

try {

  // The slice 0156 reads, plus the API roles and the default privileges 0121 sets,
  // so the REVOKE is measured against the grant it exists to take back.
  sql(`
    create role anon; create role authenticated;
    alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    create table users (id uuid primary key default gen_random_uuid(), email text not null unique, deactivated_at timestamptz);
    insert into users (email) values ('a@x.test'), ('b@x.test');
  `);
  sql(MIGRATION);

  // A real JPEG signature with filler, as the refresh stores it: standard base64.
  const bytes = Buffer.alloc(4096);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  for (let i = 4; i < bytes.length; i++) bytes[i] = (i * 31) % 256;
  const sha = createHash("sha256").update(bytes).digest("hex");
  const b64 = bytes.toString("base64");
  sql(`insert into advisor_photos (user_id, state, bytes_b64, mime, sha256, width, height)
       select id, 'photo', '${b64}', 'image/jpeg', '${sha}', 96, 96 from users where email = 'a@x.test';`);
  const back = sql(`select bytes_b64 from advisor_photos p join users u on u.id = p.user_id where u.email = 'a@x.test';`);
  eq(createHash("sha256").update(Buffer.from(back, "base64")).digest("hex"), sha, "bytes read back hash to what was written");

  assert(sqlError(`insert into advisor_photos (user_id, state) select id, 'photo' from users where email = 'b@x.test';`) !== null, "a photo row with no image is refused");
  assert(sqlError(`insert into advisor_photos (user_id, state, bytes_b64, mime, sha256) select id, 'none', 'eA==', 'image/png', '${sha}' from users where email = 'b@x.test';`) !== null, "a none row carrying an image is refused");
  assert(sqlError(`insert into advisor_photos (user_id, state, bytes_b64, mime, sha256) select id, 'photo', 'eA==', 'image/gif', '${sha}' from users where email = 'b@x.test';`) !== null, "a type outside JPEG and PNG is refused");
  assert(sqlError(`insert into advisor_photos (user_id, state, bytes_b64, mime, sha256) select id, 'photo', 'eA==', 'image/png', '${sha.toUpperCase()}' from users where email = 'b@x.test';`) !== null, "a hash that is not lower case hex is refused");
  assert(sqlError(`insert into advisor_photos (user_id, state) select id, 'maybe' from users where email = 'b@x.test';`) !== null, "a state outside photo and none is refused");
  eq(sqlError(`insert into advisor_photos (user_id, state) select id, 'none' from users where email = 'b@x.test';`), null, "a none row with no image is accepted");
  assert(sqlError(`insert into advisor_photos (user_id, state) select id, 'none' from users where email = 'b@x.test';`) !== null, "a second row for one user is refused");

  eq(sql(`select relrowsecurity from pg_class where relname = 'advisor_photos';`), "t", "row level security is on");
  for (const role of ["anon", "authenticated"]) {
    eq(sql(`select has_table_privilege('${role}', 'advisor_photos', 'select');`), "f", `${role} holds no SELECT, despite the default privileges`);
    assert(sqlError("select count(*) from advisor_photos;", role)?.includes("permission denied") ?? false, `a read as ${role} is refused outright`);
  }
  // Positive control: the default privileges really did reach a sibling table, so
  // the "f" above is the revoke working, not the grant never having happened.
  sql("create table control_table (id int);");
  eq(sql(`select has_table_privilege('anon', 'control_table', 'select');`), "t", "control: a table without the revoke IS readable by anon");

  sql(`delete from users where email = 'a@x.test';`);
  eq(sql(`select count(*) from advisor_photos;`), "1", "a deleted user's photo row goes with them");
} finally {
  pg.stop();
}

finish();
