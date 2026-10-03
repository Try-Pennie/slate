// #3124: the peak query in scripts/loadtest/RUNBOOK.md ("The peak the 60 a minute
// bar rests on") is pinned to the schema it reads.
//
// The load run's bar is only as good as the peak it was set against, and the peak
// was a number in a plan comment that nobody could re-derive. The query that
// re-derives it is run by hand against production, which nothing in CI can do, so
// this checks what can be known offline: it writes nothing, it names only columns
// the row types declare, it excludes the canary's test buckets (or the canary's
// every-30-minute bookings would be read as lead traffic), and it reads a fixed
// 30 day window, so two runs a week apart answer the same question.
//
// Run: node --experimental-strip-types scripts/test-capacity-peak-sql.ts
import { readFileSync } from "node:fs";
import { assert, finish } from "./lib/harness.ts";
import { scanRunbookBlocks } from "./lib/scan-runbook-commands.ts";
import { readOnlyProblems, sqlCode } from "./lib/runbook-sql-check.ts";
import { interfaceFields, tableTypeMap } from "./lib/scan-db-columns.ts";

const RUNBOOK = "scripts/loadtest/RUNBOOK.md";
const blocks = scanRunbookBlocks(RUNBOOK, readFileSync(RUNBOOK, "utf8")).filter((b) =>
  /busiest_minute/.test(b.content),
);
assert(blocks.length === 1, `${RUNBOOK} carries exactly one peak query (found ${blocks.length})`);
assert(blocks[0]?.marker !== null, "the peak query declares whether it has been run");
const query = blocks[0]?.content ?? "";

const schema = readFileSync("src/lib/db/schema.ts", "utf8");
const fields = interfaceFields(readFileSync("src/lib/db/types.ts", "utf8"));
const columnsOf = (table: string) => fields.get(tableTypeMap(schema).get(table) ?? "") ?? new Set<string>();
const bookings = columnsOf("bookings");
const buckets = columnsOf("buckets");
assert(bookings.size > 0 && buckets.size > 0, "the bookings and buckets row types are readable");

/** Every reason this query is not the one the runbook promises, or none. */
function problems(sql: string): string[] {
  const out = readOnlyProblems(sql);
  const code = sqlCode(sql);
  // Every `b.x` reads bookings and every `k.x` reads buckets, by the aliases the
  // query declares; a column neither type holds is a query that cannot execute.
  if (!/\bfrom\s+bookings\s+b\b/i.test(code)) out.push("it does not read bookings as b");
  if (!/\bjoin\s+buckets\s+k\s+on\s+k\.id\s*=\s*b\.bucket_id\b/i.test(code)) {
    out.push("it does not join each booking to its bucket");
  }
  for (const m of code.matchAll(/\bb\.([a-z_]+)/g)) {
    if (!bookings.has(m[1])) out.push(`bookings declares no column "${m[1]}"`);
  }
  for (const m of code.matchAll(/\bk\.([a-z_]+)/g)) {
    if (!buckets.has(m[1])) out.push(`buckets declares no column "${m[1]}"`);
  }
  if (!/\bwhere\s+not\s+k\.is_test\b/i.test(code)) out.push("it does not exclude test buckets");
  if (!/b\.created_at\s*>=\s*now\(\)\s*-\s*interval\s*'30 days'/i.test(sql)) {
    out.push("it does not read a fixed 30 day window");
  }
  if (!/date_trunc\('minute'/.test(sql)) out.push("it does not count per minute");
  return out;
}

const found = problems(query);
assert(found.length === 0, `the peak query matches the schema: ${found.join("; ") || "ok"}`);

// Positive controls (L1).
const controls: [string, string][] = [
  ["test buckets counted", query.replace(/where not k\.is_test\s*\n\s*and /, "where ")],
  ["a column bookings lacks", query.replace("b.created_at\n", "b.booked_at\n")],
  ["a column on the wrong table", query.replace("not k.is_test", "not b.is_test")],
  ["an open window", query.replace(/\s*and b\.created_at >= now\(\) - interval '30 days'/, "")],
  ["a write", query + "\nupdate bookings set status = 'cancelled';"],
];
for (const [label, sql] of controls) {
  assert(sql !== query, `control "${label}" actually changed the query`);
  assert(problems(sql).length > 0, `control: ${label} is caught`);
}

finish();
