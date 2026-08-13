/**
 * Regenerate supabase/migrations/applied-content.lock (#1127).
 *
 * Run this as the LAST step of applying a migration, once `supabase db push` has
 * succeeded, so the lock records what was actually applied rather than what someone
 * intended to apply. The runbook has it in order.
 *
 *   node --experimental-strip-types scripts/update-migration-lock.ts
 *
 * It rewrites the whole file from the migrations on disk, so it is also the way to
 * record a deliberate edit to an already applied migration: change the file, run
 * this, and the lock's diff is what a reviewer sees.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalMigrationSql, versionOf } from "./lib/migration-content.ts";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, "supabase", "migrations");
const LOCK = join(DIR, "applied-content.lock");

const HEADER = `# Content digests of the applied migrations (#1127).
#
# The drift gate compares VERSION labels, so a migration edited after it was applied
# passes for as long as its number matches. This file is what notices. Each line is
# a version and the sha256 of its canonical SQL (whitespace collapsed, semicolons
# removed; see scripts/lib/migration-content.ts for why).
#
# Regenerate with: node --experimental-strip-types scripts/update-migration-lock.ts
# ALWAYS after the push succeeds, never before, so it records what really ran.
#
# Known divergences from production, measured 2026-08-13: 0035, 0044, 0062 and 0065
# no longer match what prod executed. 0035 lost the 'public.' schema qualification
# from both statements and had its comment header rewritten; the other three had
# comment text changed by the em dash cleanup. All four are semantically harmless and
# CANNOT be corrected in the files: restoring 0062's em dash would trip the repo's own
# style hook. They are recorded here as they stand today, so this lock is the baseline
# from which the next change is visible.
`;

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const lines = files.map((f) => {
  const digest = createHash("sha256")
    .update(canonicalMigrationSql(readFileSync(join(DIR, f), "utf8")))
    .digest("hex");
  return `${versionOf(f)} ${digest}`;
});

writeFileSync(LOCK, `${HEADER}\n${lines.join("\n")}\n`);
console.log(`applied-content.lock: recorded ${lines.length} migrations`);
