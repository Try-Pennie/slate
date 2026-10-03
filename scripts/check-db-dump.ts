// Refuse a daily database dump that is not worth keeping (#3076).
//
// Run by .github/workflows/db-backup.yml on bare node, between the dump and the
// upload, so an empty or truncated dump fails the run red instead of being uploaded
// and stamped as a backup. The judgement lives in scripts/lib/db-dump-check.ts and
// is pinned by scripts/test-db-dump-check.ts.
//
//   node --experimental-strip-types scripts/check-db-dump.ts <dump directory>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DUMP_FILES, judgeDump, type DumpFile } from "./lib/db-dump-check.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: check-db-dump.ts <dump directory>");
  process.exit(2);
}

const files: Partial<Record<DumpFile, string | null>> = {};
for (const name of DUMP_FILES) {
  try {
    files[name] = readFileSync(join(dir, name), "utf8");
  } catch {
    files[name] = null;
  }
}

const verdict = judgeDump(files);
for (const [table, n] of Object.entries(verdict.rows)) console.log(`${table}: ${n} rows`);
if (!verdict.ok) {
  for (const p of verdict.problems) console.error(`::error::${p}`);
  console.error("The dump is refused, so nothing is uploaded and the backup heartbeat is not stamped.");
  process.exit(1);
}
console.log("The dump is complete enough to keep.");
