// Migration hygiene: files must be NNNN_name.sql, numbered sequentially from
// 0001 with no gaps or duplicates (duplicate/misnumbered files break db push).
// Run: node --experimental-strip-types scripts/test-migrations.ts
import { readdirSync } from "node:fs";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failures++;
  } else console.log("ok:", msg);
}

const files = readdirSync("supabase/migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort();

assert(files.length > 0, "migrations directory has .sql files");

const nums: number[] = [];
for (const f of files) {
  const m = f.match(/^(\d{4})_[a-z0-9_]+\.sql$/);
  if (!m) {
    assert(false, `"${f}" follows the NNNN_snake_case.sql convention`);
    continue;
  }
  nums.push(Number(m[1]));
}

nums.forEach((n, i) => {
  const expected = i + 1;
  assert(
    n === expected,
    `migration #${i} is ${String(expected).padStart(4, "0")} (no gaps/dupes); got ${String(n).padStart(4, "0")}`,
  );
});

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
