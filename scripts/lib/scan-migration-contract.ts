// Scan logic for the expand then contract rule in scripts/test-migrations.ts (#3096),
// kept here so the runner's `scripts/test-*.ts` glob does not pick it up as a suite.
//
// Slate applies a migration BEFORE the code that needs it deploys
// (docs/migrations-runbook.md), so the code already deployed runs on the new schema
// for the whole review window. An additive change is invisible to that code. A DROP
// or a RENAME of something it still reads fails every request that reads it, from
// the moment `supabase db push` returns, and the drift gate cannot see it because the
// migration WAS applied. So a destructive statement has to say, in the file, why the
// deployed code no longer needs the thing:
//
//   -- contract-ok: nothing has read buckets.rr_pointer since #123 deployed
//   alter table buckets drop column if exists rr_pointer;
//
// The marker sits on the statement's own line or in the comment block directly above
// it, and must say something in words: a bare `contract-ok:` or one followed only
// by punctuation is not a reason (L675). Read through the shared opt out reader
// (`scripts/lib/opt-out.ts`), so a reason means here what it means to every other
// guard.
//
// What counts as destructive is what can break a READER that still exists: a dropped
// table, column, function, procedure, view, type or schema, and any RENAME. A dropped
// constraint, index, trigger, policy or default narrows nothing a caller names, so it
// is left out rather than turning the marker into noise nobody reads.
import { hasOptOut, readOptOutOnLine } from "./opt-out.ts";

/** One destructive statement found in a migration. */
export interface DestructiveStatement {
  file: string;
  /** 1-indexed line the destructive keyword is on. */
  line: number;
  /** The code on that line, trimmed and shortened, for an actionable message. */
  statement: string;
  /** Whether a `-- contract-ok: <reason>` marker covers it. */
  marked: boolean;
}

/**
 * The migrations that already dropped something when the rule arrived (#3096). They
 * are frozen by `applied-content.lock`, so they are recorded here by name rather than
 * edited to carry a marker. Closed: test-migrations.ts fails an entry above
 * GRANDFATHER_CEILING and an entry that no longer contains a destructive statement.
 */
export const GRANDFATHERED_DESTRUCTIVE_MIGRATIONS: ReadonlySet<string> = new Set([
  "0008_drop_rr_pointer.sql",
  "0018_drop_user_watch_columns.sql",
  "0070_drop_dead_reassign_swap_overload.sql",
  "0076_drop_orphaned_applied_migration_version.sql",
  "0079_drop_google_credentials.sql",
  "0101_drop_org_booker_layout.sql",
  "0108_booking_api_outcome_test_traffic.sql",
  "0117_hours_source.sql",
  "0143_booking_api_outcome_host_class.sql",
]);

/** The highest migration on main when the rule shipped. Nothing above it is exempt. */
export const GRANDFATHER_CEILING = "0157";

const DESTRUCTIVE =
  /\bdrop\s+(?:table|column|function|procedure|view|materialized\s+view|type|schema)\b|\brename\b/i;

const TOKEN = "contract-ok:";
const SQL = { syntax: ["sql"], blankLineEndsRegion: true } as const;

/** A line's executable part: single-quoted literals removed, then any `--` comment. */
function codeOf(line: string): string {
  const noStrings = line.replace(/'(?:[^']|'')*'/g, "''");
  const at = noStrings.indexOf("--");
  return at === -1 ? noStrings : noStrings.slice(0, at);
}

/** Every destructive statement in one migration file, marked or not. */
export function findDestructiveStatements(file: string, sql: string): DestructiveStatement[] {
  const lines = sql.split("\n");
  const code = lines.map(codeOf);
  const out: DestructiveStatement[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!DESTRUCTIVE.test(code[i])) continue;

    // Walk up to the start of this statement and the comment block above it. A line
    // whose code ends in `;` closes the previous statement, and a blank line ends the
    // comment block, so a marker can never reach across to a neighbour.
    let top = i;
    for (let j = i - 1; j >= 0; j--) {
      const c = code[j].trim();
      if (c.endsWith(";")) break;
      if (c === "" && lines[j].trim() === "") break;
      top = j;
    }

    // The comment block above the statement's first line, or a trailing comment on
    // any of its lines up to this one.
    let marked = hasOptOut(lines, top, TOKEN, SQL);
    for (let j = top; j <= i && !marked; j++) {
      const own = readOptOutOnLine(lines[j], TOKEN, SQL);
      if (own.present && own.reasoned) marked = true;
    }

    out.push({ file, line: i + 1, statement: code[i].trim().slice(0, 80), marked });
  }
  return out;
}
