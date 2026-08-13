/**
 * Content identity for an applied migration (#1127).
 *
 * The drift gate compares `schema_migrations` VERSION labels, so a migration file
 * whose content diverges from what was actually applied passes for as long as the
 * number matches. An edited but not reapplied migration is undetectable.
 *
 * That is not hypothetical. Measured against production on 2026-08-13, FOUR of the
 * 101 applied migrations no longer match what prod ran:
 *
 *   0035  the comment header was rewritten AND `public.` was dropped from both
 *         statements (`create table ... public.bucket_slots` became `bucket_slots`)
 *   0044, 0062, 0065  comment text changed, the em dash cleanup reaching files that
 *         had already been applied
 *
 * None of them broke anything, which is the point: they are invisible, they
 * accumulate, and the one that eventually matters looks exactly like these.
 *
 * ## What the digest covers, and what it deliberately does not
 *
 * The canonical form collapses all whitespace and removes semicolons, because the
 * Supabase CLI splits a file into separate statements and stores them without their
 * separators, so a byte comparison against prod is impossible without re-implementing
 * its splitter (strings, dollar quoted bodies and comments all have to be lexed to
 * find a top level semicolon). With this canonicalisation, 97 of 101 migrations match
 * production EXACTLY, which is what makes the four that do not a finding rather than
 * noise.
 *
 * The cost of removing semicolons is stated rather than hidden: two files differing
 * ONLY in semicolon placement would compare equal. That is a narrow blind spot, and
 * the alternative is a SQL lexer whose bugs would be far harder to see.
 *
 * Comments ARE part of the digest. They are part of what was applied, and excluding
 * them would need the same lexing to tell a comment from a `--` inside a string.
 * Correcting an old comment therefore has to be recorded deliberately, which is the
 * intended friction: the file is a record of what ran.
 */

/**
 * The canonical form of a migration's SQL: whitespace collapsed, semicolons removed.
 * Both sides of any comparison must use this exact function, or the comparison is
 * about formatting rather than content.
 */
export function canonicalMigrationSql(sql: string): string {
  return sql.replace(/;/g, " ").replace(/\s+/g, " ").trim();
}

/** The version label a migration filename carries (`0092_foo.sql` -> `0092`). */
export function versionOf(filename: string): string {
  return filename.split("_")[0] ?? "";
}

export interface LockEntry {
  version: string;
  digest: string;
}

/**
 * Parse the lock file: one `version digest` pair per line, `#` comments ignored.
 * A plain text format on purpose, so a diff on it reads as "this migration's
 * content changed" rather than as a wall of reformatted JSON.
 */
export function parseLock(text: string): LockEntry[] {
  const entries: LockEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [version, digest] = trimmed.split(/\s+/);
    if (version && digest) entries.push({ version, digest });
  }
  return entries;
}

export interface ContentDrift {
  /** In the lock, and the file's content no longer matches it. */
  changed: { version: string; expected: string; actual: string }[];
  /** A migration file with no lock entry: applied without being recorded, or new. */
  unlocked: string[];
  /** A lock entry whose migration file is gone. */
  orphaned: string[];
}

/**
 * Compare the migrations on disk against the lock.
 *
 * All three findings are reported, not just the first, because they arrive together
 * when someone renames a file: one orphaned entry and one unlocked file, which read
 * as a rename only when seen side by side.
 */
export function compareToLock(
  files: { version: string; digest: string }[],
  lock: LockEntry[],
): ContentDrift {
  const lockByVersion = new Map(lock.map((e) => [e.version, e.digest]));
  const seen = new Set<string>();
  const changed: ContentDrift["changed"] = [];
  const unlocked: string[] = [];

  for (const file of files) {
    const expected = lockByVersion.get(file.version);
    if (expected === undefined) {
      unlocked.push(file.version);
      continue;
    }
    seen.add(file.version);
    if (expected !== file.digest) {
      changed.push({ version: file.version, expected, actual: file.digest });
    }
  }

  const orphaned = lock.map((e) => e.version).filter((v) => !seen.has(v));
  return { changed, unlocked, orphaned };
}
