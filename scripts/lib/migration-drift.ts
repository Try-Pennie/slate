/**
 * Reading `supabase migration list --linked`, for the CI gate that stops code
 * merging ahead of its schema (#1433).
 *
 * Deploys do not apply migrations, so this gate is the thing standing between a
 * committed migration and a Worker that expects a column the database has not got.
 * #766 already rewrote it once, because it used to pass green in nine seconds
 * having verified nothing, and the three defects this module exists to fix were all
 * the same shape one level down, in the parsing.
 *
 * The rule that shapes it: **the CLI's stdout is not a data feed.** Upgrade
 * notices, connection chatter and warnings land on the same stream as the table, so
 * a row is recognised by being a row, never by "has some digits and a blank
 * neighbour". The live instance was the CLI's own
 * `A new version of Supabase CLI is available: v2.114.0` line, which has no pipes
 * at all and so parsed as a migration whose remote side was missing.
 *
 * Pure, so scripts/test-migration-drift-parse.ts drives every branch, and so the
 * decision is not a rule living inside a workflow `run:` block where nothing can
 * test it.
 */

/** One row of the CLI's table: the committed migration, and the remote's copy of it. */
export interface MigrationRow {
  local: string;
  /** Null when the remote column is blank, which is what unapplied looks like. */
  remote: string | null;
}

/**
 * A table row, and nothing else.
 *
 * Anchored to the WHOLE first field, so a line only counts when that field is a bare
 * migration number with nothing else in it. The separator row is excluded by the same
 * rule (its first field is dashes), and so is every notice, banner and error the CLI
 * writes to the same stream.
 */
const ROW = /^\s*(\d+)\s*\|([^|]*)\|/;

export function readMigrationRows(output: string): MigrationRow[] {
  const rows: MigrationRow[] = [];
  for (const line of output.split("\n")) {
    const m = ROW.exec(line);
    if (!m) continue;
    const remote = m[2]!.trim();
    rows.push({ local: m[1]!, remote: remote === "" ? null : remote });
  }
  return rows;
}

export interface MigrationDriftVerdict {
  ok: boolean;
  /** The committed migrations the remote has not got. Empty when none were SEEN,
   *  which is not the same as none existing, hence `ok` carrying that separately. */
  unapplied: string[];
  /** What was decided and on what, in a sentence a reader of the CI log can act on. */
  reason: string;
}

/**
 * Judge the CLI's output.
 *
 * Three outcomes collapsed into two flags, and the third is the point of the
 * module: reading NO rows is not "nothing is unapplied", it is "this check did not
 * run". That state arrives exactly when the CLI failed, errored, or printed only a
 * notice, which is the moment a green verdict is most likely to be believed and
 * acted on (L98). It fails, and it says which of the two it is.
 */
export function migrationDriftVerdict(output: string): MigrationDriftVerdict {
  const rows = readMigrationRows(output);
  if (rows.length === 0) {
    return {
      ok: false,
      unapplied: [],
      reason:
        "read no migration rows from the CLI, so nothing was checked. This is not an " +
        "applied database; it is an output the gate could not read.",
    };
  }
  const unapplied = rows.filter((r) => r.remote === null).map((r) => r.local);
  if (unapplied.length > 0) {
    return {
      ok: false,
      unapplied,
      reason:
        `${unapplied.length} committed migration(s) are not applied on the remote ` +
        `(${unapplied.join(", ")}). Run: supabase db push`,
    };
  }
  return {
    ok: true,
    unapplied: [],
    reason: `all ${rows.length} committed migration(s) are applied on the remote.`,
  };
}
