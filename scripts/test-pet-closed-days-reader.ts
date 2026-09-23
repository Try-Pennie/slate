// PET's login can read the org's closed dates and nothing else (0134, PET #1535).
//
// pet_reader exists so PET's daily build can leave company holidays out of its
// working day counts. Its whole value is what it CANNOT reach: the build holds
// its password, so every grant it carries is a grant PET's pipeline holds over
// Slate. A later migration that hands it one more table would pass every other
// check in this repo, so this reads every migration and fails on any grant to the
// role beyond the two it was created with, and on the view growing a column.
//
// Run: node --experimental-strip-types scripts/test-pet-closed-days-reader.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, "supabase", "migrations");
const ROLE = "pet_reader";

const migrations = readdirSync(DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort()
  .map((f) => ({ name: f, sql: readFileSync(join(DIR, f), "utf8") }));

// SQL with comments removed, so a sentence ABOUT a grant is not read as one.
const code = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();

// Every grant statement naming the role, in every migration, normalised. This
// also catches the role being made a MEMBER of another (`grant x to pet_reader`),
// which would hand it that role's privileges: that statement is a grant too.
const grants = migrations.flatMap(({ name, sql }) =>
  code(sql)
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("grant ") && new RegExp(`\\bto ${ROLE}\\b`).test(s))
    .map((s) => ({ name, stmt: s })),
);

eq(
  grants.map((g) => g.stmt).sort(),
  [
    `grant select on pet_export.closed_days to ${ROLE}`,
    `grant usage on schema pet_export to ${ROLE}`,
  ],
  `${ROLE} holds exactly USAGE on pet_export and SELECT on pet_export.closed_days, in every migration`,
);

const creating = migrations.find(({ sql }) => code(sql).includes(`create role ${ROLE}`));
assert(!!creating, `a migration creates ${ROLE}`);
if (creating) {
  const create = code(creating.sql).match(new RegExp(`create role ${ROLE}[^;]*`))?.[0] ?? "";
  assert(!create.includes("password"), `${ROLE} is created with no password, so no secret is committed (${creating.name})`);
  assert(create.includes("noinherit"), `${ROLE} is NOINHERIT (${creating.name})`);
  assert(!/\b(superuser|createrole|createdb|bypassrls|replication)\b/.test(create), `${ROLE} carries no elevated attribute (${creating.name})`);
}

// The view exposes the DATE only, for CLOSED days only: not the note, not who
// edited the row, and not the one off opening days.
const views = migrations
  .map(({ name, sql }) => ({ name, view: code(sql).match(/create (or replace )?view pet_export\.closed_days as ([^;]*)/)?.[2]?.trim() }))
  .filter((v) => v.view);
assert(views.length > 0, "a migration defines pet_export.closed_days");
const latest = views[views.length - 1];
eq(
  latest.view,
  "select on_date from public.business_hours_exceptions where is_open = false",
  `pet_export.closed_days selects only the closed dates (${latest.name})`,
);

// The view must be unreachable from the Data API keys.
const revoked = migrations.some(({ sql }) => code(sql).includes("revoke all on pet_export.closed_days from public, anon, authenticated"));
assert(revoked, "pet_export.closed_days is revoked from public, anon and authenticated");

finish();
