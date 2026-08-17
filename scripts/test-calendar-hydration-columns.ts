// Repo invariant (#1260): the calendar hydration columns must read as "we have never
// established coverage", and nothing may quietly give them a value.
//
// `sync_window_to` is the `timeMax` actually sent on the last SUCCESSFUL bootstrap, and it
// AUTHORIZES deletion: the out-of-window prune (#1265) uses it to decide which cached busy
// time may go, and the coverage alert (#1262) uses it to decide whether an agent's calendar
// still reaches the booking horizon. So a value that was never fetched is not a cosmetic
// error, it is a licence to delete busy time inside a window nothing has read, and to report
// coverage the product does not have.
//
// The two ways that happens are both one word long, which is why they are guarded here rather
// than left to review: a DEFAULT on the column, or a backfill in the same migration. Either
// makes every one of the 121 calendars claim coverage immediately, including the ones that
// have not been bootstrapped since June.
//
// A static read of the migration text, deliberately. The live schema is checked once by hand
// when the migration is applied; this is what stops the property being edited away afterwards,
// in a repo where migrations are roll-forward only and an edit to an applied file is a real
// workflow (scripts/update-migration-lock.ts exists for exactly that).
//
// Run: node --experimental-strip-types scripts/test-calendar-hydration-columns.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";

const DIR = join(import.meta.dirname, "..", "supabase", "migrations");
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql"));

// Comments are stripped before every match below. The migration EXPLAINS at length why it
// has no backfill and no default, so a raw search finds those words in the prose and a guard
// can be satisfied, or broken, by a sentence about the thing rather than the thing (L103).
const codeOf = (sql: string): string =>
  sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");

const HYDRATION_COLUMNS = ["last_bootstrap_attempt_at", "sync_window_to"] as const;

// Every migration is read, not just the one that added them: the point is that NOTHING in the
// tree gives these columns a value, including a later migration nobody thought to check.
const all = files.map((f) => ({ name: f, code: codeOf(readFileSync(join(DIR, f), "utf8")) }));

// The columns exist somewhere, so the guard cannot pass by finding nothing to check (L100).
{
  for (const col of HYDRATION_COLUMNS) {
    const adds = all.filter((f) => new RegExp(`add column\\s+${col}\\b`, "i").test(f.code));
    eq(adds.length, 1, `${col} is added by exactly one migration`);
    const add = adds[0];
    if (!add) continue;
    // The whole `add column` clause, up to the statement end.
    const clause =
      add.code.match(new RegExp(`add column\\s+${col}\\b[^;]*`, "i"))?.[0] ?? "";
    assert(/timestamptz/i.test(clause), `${col} is a timestamptz`);
    assert(
      !/\bnot\s+null\b/i.test(clause),
      `${col} is NULLABLE, so an unbootstrapped calendar reads as no coverage`,
    );
    assert(
      !/\bdefault\b/i.test(clause),
      `${col} has NO default: a default would make every calendar claim coverage at once`,
    );
  }
}

// No backfill of either column, anywhere. An UPDATE setting them is the other way the same
// false coverage arrives, and it would look entirely reasonable in review.
{
  for (const col of HYDRATION_COLUMNS) {
    for (const f of all) {
      const setsIt = new RegExp(`update\\s+agent_calendars[\\s\\S]{0,400}?set[\\s\\S]{0,400}?\\b${col}\\s*=`, "i");
      assert(
        !setsIt.test(f.code),
        `no migration backfills ${col} (${f.name})`,
      );
    }
  }
}

// The prune index must stay PARTIAL and keyed on the column the read orders by. A plain index
// on ends_at would still be used, so the prune would look fine while scanning every row the
// predicate excludes, and nothing downstream would report the difference.
{
  const withIdx = all.filter((f) => /busy_blocks_gcal_prune_idx/i.test(f.code));
  eq(withIdx.length, 1, "the prune index is created by exactly one migration");
  const idx = withIdx[0]?.code.match(/create index[^;]*busy_blocks_gcal_prune_idx[^;]*/i)?.[0] ?? "";
  assert(idx.length > 0, "the prune index statement is readable");
  assert(/\(\s*ends_at\s*\)/i.test(idx), "the prune index is keyed on ends_at, the column the read orders by");
  assert(/\bwhere\b/i.test(idx), "the prune index is PARTIAL");
  assert(
    /source\s*=\s*'gcal'/i.test(idx) && /booking_id\s+is\s+null/i.test(idx),
    "and its predicate matches the prune's own filter exactly",
  );
}

// The shipped version constant and the migration files must agree. scripts/test-migrations.ts
// owns that rule in general; this asserts it for the file added here, so a bump forgotten
// alongside THIS migration fails with a message naming it.
{
  const versionFile = readFileSync(
    join(import.meta.dirname, "..", "src", "lib", "db", "migration-version.ts"),
    "utf8",
  );
  const shipped = versionFile.match(/SHIPPED_MIGRATION_VERSION\s*=\s*"(\d+)"/)?.[1] ?? "";
  const highest = files
    .map((f) => f.match(/^(\d+)_/)?.[1] ?? "")
    .filter(Boolean)
    .sort()
    .at(-1);
  eq(shipped, highest, "SHIPPED_MIGRATION_VERSION matches the highest migration on disk");
}

// The hand-written DB types carry both columns as nullable, because the app reads this table
// through them and a missing field would simply not exist at every call site rather than
// failing anywhere a reader could notice (L46: a column with no reader, from the other end).
{
  const types = readFileSync(
    join(import.meta.dirname, "..", "src", "lib", "db", "types.ts"),
    "utf8",
  );
  const iface = types.match(/export interface AgentCalendar \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert(iface.length > 0, "the AgentCalendar interface is readable");
  for (const col of HYDRATION_COLUMNS) {
    assert(
      new RegExp(`${col}:\\s*string\\s*\\|\\s*null`).test(iface),
      `AgentCalendar.${col} is typed as nullable, matching the column`,
    );
  }
}

finish();
