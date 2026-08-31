// Repo invariant (#1648): the three unique keys provisioning leans on must exist
// in the migrations.
//
// `provisionUser` runs on the login path and used to be read then insert three
// times over. Routing every read through `unwrap` fixes ONE half of that (a read
// that FAILED no longer falls through to the insert). It does nothing about the
// other half: two concurrent first logins both pass a read that correctly returned
// nothing, and only a database key can make the second write impossible. So the
// code deliberately inserts plainly and treats SQLSTATE 23505 as "a concurrent
// login won", re-resolving to the row that won.
//
// That design is only correct while the keys are really there. The vitest suite
// that proves the race (src/lib/provision-integrity.test.ts) enforces them in a
// hand written fake, and a fake agrees with our assumption by construction (L52):
// delete the index from the schema and that suite goes on passing, because its
// fake still refuses the duplicate. This guard is the half the fake cannot be.
//
// It reads the migration FILES rather than the live database on purpose: it has to
// run offline in the pre-push gate and in CI, where no database credentials exist.
// The CI `migration-drift` job is what proves the files were applied.
//
// Run: node --experimental-strip-types scripts/test-provision-unique-keys.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, "supabase", "migrations");

/** Every migration's SQL, whitespace collapsed so a line break cannot hide a key. */
const sql = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(DIR, f), "utf8"))
  .join("\n")
  .replace(/\s+/g, " ")
  .toLowerCase();

assert(sql.length > 1000, `read the migration tree (got ${sql.length} chars)`);

interface RequiredKey {
  /** What breaks if this key is missing, in the words of the defect it prevents. */
  why: string;
  pattern: RegExp;
}

const REQUIRED: RequiredKey[] = [
  {
    why:
      "organizations: at most one default org, or a lost race creates a SECOND organization " +
      "and every bucket code collides, because resolveBucketByCode matches globally by code",
    pattern:
      /create unique index (if not exists )?organizations_single_default_idx on organizations \(is_default\) where is_default/,
  },
  {
    why:
      "users.email: unique, or a lost race creates a duplicate row for one person and splits " +
      "their identity across the roster, the bookable pool and the manager link",
    pattern: /email\s+text not null unique/,
  },
  {
    why:
      "users.auth_user_id: unique where set, or two rows can claim one Google identity and the " +
      "session lookup (which matches on auth_user_id) resolves to whichever it happens to find",
    pattern:
      /create unique index (if not exists )?users_auth_user_id_key on users\(auth_user_id\) where auth_user_id is not null/,
  },
];

for (const key of REQUIRED) {
  assert(key.pattern.test(sql), `a migration declares it. ${key.why}`);
}

// Positive control: the patterns are specific enough that removing the key from the
// text is CAUGHT. Without this, a pattern loose enough to match some other line
// would report every key as present over a schema that has none of them (L1, L98).
for (const key of REQUIRED) {
  const without = sql.replace(key.pattern, "-- removed for the control");
  assert(
    without !== sql && !key.pattern.test(without),
    `positive control: removing this key is caught. ${key.why.split(":")[0]}`,
  );
}

assert(true, `all ${REQUIRED.length} of provisioning's unique keys are declared in the migrations`);
finish();
