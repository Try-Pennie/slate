/**
 * Regenerate supabase/migrations/applied-content.lock (#1127, #1642).
 *
 * Two modes, because the lock records two different things and used to conflate them:
 *
 *   node --experimental-strip-types scripts/update-migration-lock.ts
 *     Every entry is a FACT. Run this once `supabase db push` has succeeded, so the
 *     lock records what was actually applied.
 *
 *   node --experimental-strip-types scripts/update-migration-lock.ts --pending
 *     Any migration with no existing fact entry is recorded as an INTENTION: its
 *     content is locked, and it is marked `pending` because it has not been applied.
 *     Run this before pushing a branch that carries a new migration, which the push
 *     gate demands an entry for and which the runbook rightly refuses to call applied.
 *
 * Nothing already recorded as a fact is ever demoted to pending: a fact is about a
 * migration that really ran, and no later run of this script can unmake that.
 *
 * It rewrites the whole file from the migrations on disk, so it is also the way to
 * record a deliberate edit to an already applied migration: change the file, run this,
 * and the lock's diff is what a reviewer sees.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalMigrationSql, parseLock, versionOf, PENDING_MARKER } from "./lib/migration-content.ts";

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
# with no flag AFTER supabase db push succeeds, so every entry records what really ran.
#
# A line ending in the word "pending" is an INTENTION rather than a fact (#1642): its
# content is recorded and it has not been applied yet. That is what a branch carrying a
# new migration is pushed with, written by the same script with --pending, because the
# push gate demands an entry for every migration on disk and this file must not claim
# something ran when it has not. The drift gate reads the remote and refuses a merge
# while an APPLIED migration's entry still says pending, so an intention cannot reach
# main wearing the clothes of a fact.
#
# Known divergences from production, measured 2026-08-13: 0035, 0044, 0062 and 0065
# no longer match what prod executed. 0035 lost the 'public.' schema qualification
# from both statements and had its comment header rewritten; the other three had
# comment text changed by the em dash cleanup. All four are semantically harmless and
# CANNOT be corrected in the files: restoring 0062's em dash would trip the repo's own
# style hook. They are recorded here as they stand today, so this lock is the baseline
# from which the next change is visible.
`;

const markPending = process.argv.includes("--pending");

/** What the lock already says, so a fact is never demoted by a later run. */
let existing: ReturnType<typeof parseLock> = [];
try {
  existing = parseLock(readFileSync(LOCK, "utf8"));
} catch {
  // No lock yet is a first run, not a failure: every entry is then written fresh.
}
const alreadyFact = new Set(existing.filter((e) => !e.pending).map((e) => e.version));

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

let pendingCount = 0;
const lines = files.map((f) => {
  const version = versionOf(f);
  const digest = createHash("sha256")
    .update(canonicalMigrationSql(readFileSync(join(DIR, f), "utf8")))
    .digest("hex");
  const pending = markPending && !alreadyFact.has(version);
  if (pending) pendingCount++;
  return pending ? `${version} ${digest} ${PENDING_MARKER}` : `${version} ${digest}`;
});

writeFileSync(LOCK, `${HEADER}\n${lines.join("\n")}\n`);
console.log(
  `applied-content.lock: recorded ${lines.length} migrations` +
    (pendingCount > 0
      ? `, ${pendingCount} as pending. Re-run WITHOUT --pending once supabase db push has succeeded, or the drift gate will refuse the merge.`
      : ""),
);
