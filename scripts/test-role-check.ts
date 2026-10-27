// The database's `users_role_check` allows exactly the roles the code knows (#4205).
// Run: node --experimental-strip-types scripts/test-role-check.ts
//
// `Role` is a TypeScript union and `users_role_check` a Postgres CHECK, and nothing
// compared them: a role added to the union and not the CHECK fails the first write
// that uses it (the grant, the role editor), on production, as a write that "could not
// be saved". The coordinator role (#4205) is the first added since 0031, so this pins
// the two together, and pins the rule that a coordinator is never bookable.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLES } from "../src/lib/auth/roles.ts";
import { latestCheckValues } from "./lib/scan-check-constraint.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const migrationsDir = join(import.meta.dirname, "..", "supabase", "migrations");
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(join(migrationsDir, f), "utf8") }));

const allowed = latestCheckValues(migrations, "users_role_check");
assert(allowed != null, "a migration defines users_role_check");
eq(
  [...(allowed ?? [])].sort().join(","),
  [...ROLES].sort().join(","),
  "users_role_check allows exactly the roles in ROLES",
);

// The coordinator is never bookable, held by the database as well as the code: the
// round robin pool reads `bookable`, so a CHECK is what keeps a coordinator out of it
// whichever writer forgot.
const neverBookable = migrations.filter((m) =>
  /add\s+constraint\s+users_coordinator_never_bookable\s+check\s*\(\s*role\s*<>\s*'coordinator'\s+or\s+bookable\s*=\s*false\s*\)/i.test(m.sql),
);
eq(neverBookable.length, 1, "exactly one migration adds users_coordinator_never_bookable");

finish();
