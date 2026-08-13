// #1127: a migration edited AFTER it was applied cannot pass silently.
//
// The drift gate compares `schema_migrations` version labels, so a file whose content
// diverges from what was applied passes for as long as its number matches. #1127
// noticed the gap while migration 0092 was edited in place and re-pushed twice.
//
// It is not hypothetical. Measured against production on 2026-08-13, FOUR of the 101
// applied migrations no longer match what prod ran:
//
//   0035  comment header rewritten AND `public.` dropped from both statements
//   0044, 0062, 0065  comment text changed, the em dash cleanup reaching files that
//                     had already been applied
//
// All four are semantically harmless, which is exactly why nothing noticed and why
// they accumulated. The one that eventually matters will look just like them.
//
// This suite makes the next one visible: every migration file's content is pinned in
// supabase/migrations/applied-content.lock, and a change to an already applied file
// fails until somebody records it deliberately.
//
// Run: node --experimental-strip-types scripts/test-migration-content-lock.ts
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  canonicalMigrationSql,
  compareToLock,
  parseLock,
  versionOf,
} from "./lib/migration-content.ts";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, "supabase", "migrations");
const LOCK = join(DIR, "applied-content.lock");

const digest = (sql: string) =>
  createHash("sha256").update(canonicalMigrationSql(sql)).digest("hex");

// --- the real migrations against the real lock ---------------------------
{
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ version: versionOf(f), digest: digest(readFileSync(join(DIR, f), "utf8")) }));
  assert(files.length > 90, `scanning ${files.length} migrations`);

  const lock = parseLock(readFileSync(LOCK, "utf8"));
  eq(lock.length, files.length, "every migration on disk has a lock entry, and vice versa");

  const drift = compareToLock(files, lock);
  eq(
    drift.changed.map((c) => c.version),
    [],
    "no applied migration's content has changed since it was recorded. If this fails, " +
      "either restore the file or, if the edit is deliberate, re-run " +
      "scripts/update-migration-lock.ts so the change is reviewed rather than silent",
  );
  eq(
    drift.unlocked,
    [],
    "every migration is recorded in the lock (a new one is added by running " +
      "scripts/update-migration-lock.ts AFTER the push succeeds)",
  );
  eq(drift.orphaned, [], "the lock holds no entry whose migration file has gone");
}

// --- canonicalMigrationSql: what it does and does not ignore -------------
{
  eq(
    canonicalMigrationSql("create table foo (\n  id uuid\n);\n"),
    "create table foo ( id uuid )",
    "whitespace collapses and the trailing semicolon goes",
  );
  eq(
    canonicalMigrationSql("a;b"),
    "a b",
    "an internal semicolon becomes a space, matching how the CLI stores separate statements",
  );
  eq(
    canonicalMigrationSql("  select   1  "),
    "select 1",
    "leading and trailing whitespace is not content",
  );

  // Reformatting is NOT a content change: the same SQL laid out differently has the
  // same digest, or every tidy-up would fail the gate and the gate would be turned off.
  eq(
    digest("alter table x add column y int;"),
    digest("alter table x\n  add column y int\n;\n"),
    "the same statement formatted differently has the same digest",
  );

  // A real change IS a content change, including one that only touches a comment,
  // because a comment is part of what was applied and telling one from a `--` inside
  // a string needs a lexer this deliberately does not have.
  assert(
    digest("-- old note\nselect 1;") !== digest("-- new note\nselect 1;"),
    "a changed comment changes the digest, so the file stays a record of what ran",
  );
  assert(
    digest("create table public.a (id int);") !== digest("create table a (id int);"),
    "dropping a schema qualification changes the digest (this is the real 0035 edit)",
  );

  // The stated blind spot, asserted rather than left as prose: two files differing
  // only in semicolon placement compare equal. The alternative is a SQL lexer whose
  // bugs would be much harder to see than this one line.
  eq(
    digest("select 1; select 2;"),
    digest("select 1 select 2"),
    "semicolon placement alone is NOT detected, which is the documented cost",
  );
}

// --- compareToLock: each finding, and all of them at once ---------------
{
  const lock = [
    { version: "0001", digest: "aaa" },
    { version: "0002", digest: "bbb" },
  ];
  eq(
    compareToLock([{ version: "0001", digest: "aaa" }, { version: "0002", digest: "bbb" }], lock),
    { changed: [], unlocked: [], orphaned: [] },
    "matching content reports nothing",
  );

  const edited = compareToLock(
    [{ version: "0001", digest: "CHANGED" }, { version: "0002", digest: "bbb" }],
    lock,
  );
  eq(edited.changed.length, 1, "an edited migration is reported");
  eq(edited.changed[0]?.version, "0001", "by version");
  assert(
    edited.changed[0]?.expected === "aaa" && edited.changed[0]?.actual === "CHANGED",
    "with both digests, so a reviewer can see it is a change and not a missing entry",
  );

  const added = compareToLock(
    [...lock, { version: "0003", digest: "ccc" }].map((e) => ({ version: e.version, digest: e.digest })),
    lock,
  );
  eq(added.unlocked, ["0003"], "a migration with no lock entry is reported");

  const removed = compareToLock([{ version: "0001", digest: "aaa" }], lock);
  eq(removed.orphaned, ["0002"], "a lock entry with no file is reported");

  // A rename arrives as BOTH, and reads as a rename only when both are shown, which
  // is why every finding is collected rather than the first one thrown.
  const renamed = compareToLock([{ version: "0009", digest: "aaa" }], lock);
  eq(renamed.unlocked, ["0009"], "a renamed migration reports the new version as unlocked");
  eq(renamed.orphaned, ["0001", "0002"], "and the old ones as orphaned");
}

// --- parseLock ----------------------------------------------------------
{
  const text = "# a comment\n\n0001 abc\n  0002   def  \n# trailing note\n";
  eq(parseLock(text), [
    { version: "0001", digest: "abc" },
    { version: "0002", digest: "def" },
  ], "comments, blank lines and stray whitespace are not entries");
  eq(parseLock(""), [], "an empty lock parses to nothing rather than throwing");
}

// --- the generator and the checker agree --------------------------------
// The lock is written by one script and read by this one. If they disagreed about
// the canonical form, the gate would fail on a fresh generate, which is the one
// failure mode that would make everybody delete it.
{
  const sample = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()[0]!;
  const lock = parseLock(readFileSync(LOCK, "utf8"));
  const entry = lock.find((e) => e.version === versionOf(sample));
  eq(
    entry?.digest,
    digest(readFileSync(join(DIR, sample), "utf8")),
    "the digest in the lock is the one this suite computes for the same file",
  );
}

finish();
