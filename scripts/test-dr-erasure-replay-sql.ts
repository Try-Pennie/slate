// #3132: the post restore erasure list in docs/dr-runbook.md section 5 is pinned to
// the code that writes and reads the rows it lists.
//
// After a restore every `pii.erasure` honoured inside the gap window has been undone,
// and re-running each one is a legal commitment. The runbook used to say so and give
// no query, so the list came from memory. It now carries one, and nothing in CI can
// run it (there is no database here, and its only real target is a production
// incident). So this checks what can be known offline, against the code itself rather
// than against a copy of its strings:
//
//   - it writes nothing (an operator pastes it into a console holding the secret key);
//   - it filters on the action literal `erase_booking_pii` INSERTS and the erasure
//     audit lane FILTERS on, read out of both, so a renamed action breaks this test
//     rather than the query silently returning nothing;
//   - it selects every column the lane's trail reader selects, each of which the
//     audit_log row type declares;
//   - it reads the two detail keys the function writes and the trail declares;
//   - it is bounded below by a restore target that cannot run unreplaced.
//
// Run: node --experimental-strip-types scripts/test-dr-erasure-replay-sql.ts
import { readdirSync, readFileSync } from "node:fs";
import { assert, finish } from "./lib/harness.ts";
import { scanRunbookBlocks } from "./lib/scan-runbook-commands.ts";
import { namesColumn, readOnlyProblems, sqlCode } from "./lib/runbook-sql-check.ts";
import { interfaceFields, tableTypeMap } from "./lib/scan-db-columns.ts";

const RUNBOOK = "docs/dr-runbook.md";
const blocks = scanRunbookBlocks(RUNBOOK, readFileSync(RUNBOOK, "utf8")).filter((b) =>
  /from\s+audit_log/i.test(b.content),
);
assert(blocks.length === 1, `${RUNBOOK} carries exactly one audit_log query (found ${blocks.length})`);
const query = blocks[0]?.content ?? "";

// What the code says, read from the code.
const trail = readFileSync("src/lib/snowflake/erasure-trail.ts", "utf8");
const laneAction = /\.eq\("action",\s*"([^"]+)"\)/.exec(trail)?.[1];
const laneColumns = (/\.select\("([^"]+)"\)\s*\n\s*\.eq\("action"/.exec(trail)?.[1] ?? "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);
const detailKeys = [
  ...(/details:\s*\{([^}]*)\}/.exec(trail)?.[1] ?? "").matchAll(/(\w+)\?:/g),
].map((m) => m[1]);

// The LAST migration defining erase_booking_pii is the one production runs.
const definitions = readdirSync("supabase/migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(`supabase/migrations/${f}`, "utf8"))
  .flatMap((sql) => sql.match(/create or replace function (?:public\.)?erase_booking_pii[\s\S]*?\$\$;/gi) ?? []);
const fn = definitions.at(-1) ?? "";
const insertedAction = /insert into audit_log[\s\S]*?values\s*\([\s\S]*?'([a-z.]+)'/i.exec(fn)?.[1];

assert(!!laneAction, "the erasure trail reader's action filter is readable");
assert(laneColumns.length >= 4, `the trail reader's columns are readable (${laneColumns.join(", ")})`);
assert(detailKeys.length >= 2, `the trail's detail keys are readable (${detailKeys.join(", ")})`);
assert(fn.length > 0, "a migration defines erase_booking_pii");
assert(
  insertedAction === laneAction,
  `erase_booking_pii inserts the action the lane reads ("${insertedAction}" vs "${laneAction}")`,
);

const schema = readFileSync("src/lib/db/schema.ts", "utf8");
const fields = interfaceFields(readFileSync("src/lib/db/types.ts", "utf8"));
const auditFields = fields.get(tableTypeMap(schema).get("audit_log") ?? "") ?? new Set<string>();
assert(auditFields.size > 0, "the audit_log row type is readable");

/** Every reason this query does not match the code, or none. */
function problems(sql: string): string[] {
  const out = readOnlyProblems(sql, ["timestamptz"]);
  if (!new RegExp(`action\\s*=\\s*'${(laneAction ?? "").replace(".", "\\.")}'`).test(sql)) {
    out.push(`it does not filter on action = '${laneAction}'`);
  }
  for (const c of laneColumns) {
    if (!auditFields.has(c)) out.push(`audit_log declares no column "${c}"`);
    if (!namesColumn(sql, c)) out.push(`it does not select "${c}", which the lane reads`);
  }
  for (const k of detailKeys) {
    if (!new RegExp(`details\\s*->>?\\s*'${k}'`).test(sql)) out.push(`it does not read details '${k}'`);
    if (!new RegExp(`'${k}'`).test(fn)) out.push(`erase_booking_pii does not write details '${k}'`);
  }
  if (!/created_at\s*>=\s*timestamptz\s*'RESTORE_TARGET_UTC'/.test(sql)) {
    out.push("it is not bounded below by the RESTORE_TARGET_UTC placeholder");
  }
  if (!/\bfrom\s+audit_log\b/i.test(sqlCode(sql))) out.push("it does not read audit_log");
  return out;
}

const found = problems(query);
assert(found.length === 0, `the runbook query matches the erasure code: ${found.join("; ") || "ok"}`);

// The placeholder must be refused if left in, which needs it to be no timestamp.
assert(
  Number.isNaN(Date.parse("RESTORE_TARGET_UTC")),
  "the placeholder is not a readable timestamp, so an unreplaced run is refused",
);

// Positive controls (L1): each check must fire on the defect it exists for.
const controls: [string, string][] = [
  ["a renamed action", query.replace(`'${laneAction}'`, "'pii.erased'")],
  ["a dropped column", query.replace(/^\s*org_id,\n/m, "")],
  ["a misspelt detail key", query.replace("'email_sha256'", "'email_hash'")],
  ["a write", query + "\ndelete from audit_log;"],
  ["a data modifying CTE", "with gone as (delete from audit_log returning id) " + query],
  ["an unbounded window", query.replace(/\s*and created_at >= timestamptz 'RESTORE_TARGET_UTC'/, "")],
  ["a function call", query.replace("now()", "erase_booking_pii('a@b.c')")],
];
for (const [label, sql] of controls) {
  assert(sql !== query, `control "${label}" actually changed the query`);
  assert(problems(sql).length > 0, `control: ${label} is caught`);
}

finish();
