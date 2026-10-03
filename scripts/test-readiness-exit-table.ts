// The readiness command's exit table matches the code (#2394). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-readiness-exit-table.ts
//
// `pnpm verify:parallel-run-readiness` exits on its own code per outcome, and the
// table in docs/verify-commands.md is the only place anybody reads what a code
// means. It fell behind twice: once by two outcomes and a renumbering (#2717), and
// once by exit 11, which shipped with #2080 while a paragraph beside the table still
// said that check had been deliberately dropped. A shell caller meeting a code with
// no row finds no meaning for it, and a reader meeting a recorded reason for leaving
// a check out reads it as a decision (L346).
//
// So every code in `READINESS_EXIT` must have a `| N |` row in the readiness section,
// and every row there must be a code the command can produce. Exit 1 is the one
// code outside the map: the entry exits 1 before anything is judged when there are
// no credentials, which the map's own header explains.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { READINESS_EXIT } from "./lib/parallel-run-readiness.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");
const doc = readFileSync(join(root, "docs/verify-commands.md"), "utf8");

const HEADING = "# Is the shadow run trustworthy today? (`pnpm verify:parallel-run-readiness`)";
/** Decided by the entry before the judge runs, so it is not in READINESS_EXIT. */
const ENTRY_ONLY_CODES = [1];

/** The readiness section: from its heading to the next top level heading. */
function readinessSection(text: string): string | null {
  const start = text.indexOf(`\n${HEADING}\n`);
  if (start < 0) return null;
  const rest = text.slice(start + 1);
  const next = rest.slice(HEADING.length).search(/\n# /);
  return next < 0 ? rest : rest.slice(0, HEADING.length + next);
}

/** Every `| N |` row's code, in document order. */
function tableCodes(section: string): number[] {
  return [...section.matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1]));
}

/** What is wrong between the code's exits and the table's rows, or nothing. */
function tableProblems(section: string): string[] {
  const rows = tableCodes(section);
  const expected = new Set<number>([...Object.values(READINESS_EXIT), ...ENTRY_ONLY_CODES]);
  const problems: string[] = [];
  for (const code of expected) {
    if (!rows.includes(code)) problems.push(`exit ${code} has no row`);
  }
  for (const code of rows) {
    if (!expected.has(code)) problems.push(`row ${code} is not an exit the command produces`);
  }
  const seen = new Set<number>();
  for (const code of rows) {
    if (seen.has(code)) problems.push(`exit ${code} has two rows`);
    seen.add(code);
  }
  return problems;
}

const section = readinessSection(doc);
assert(section !== null, "docs/verify-commands.md carries the readiness section");

if (section !== null) {
  // Sanity: the section really is the readiness one and holds its table, so an
  // empty match cannot pass as agreement (L98).
  assert(tableCodes(section).length >= 10, `the readiness section holds its exit table (${tableCodes(section).length} rows)`);
  assert(!section.includes("verify:pool-slot-parity"), "the section stops at the next command's heading");

  eq(tableProblems(section), [], "every READINESS_EXIT code has a row, and every row is a real exit");

  // Positive controls: the comparison must catch each way the table can drift.
  const withoutEleven = section.replace(/^\| 11 \|.*\n/m, "");
  assert(withoutEleven !== section, "control: the exit 11 row was found to remove");
  assert(
    tableProblems(withoutEleven).includes("exit 11 has no row"),
    "control: a code with no row is caught",
  );
  const withBogus = section.replace(/^\| 0 \| READY \|\n/m, (row) => `${row}| 42 | an outcome nothing produces |\n`);
  assert(withBogus !== section, "control: a bogus row was inserted");
  assert(
    tableProblems(withBogus).includes("row 42 is not an exit the command produces"),
    "control: a row naming no exit is caught",
  );
  const withDuplicate = section.replace(/^(\| 8 \|.*\n)/m, "$1$1");
  assert(
    tableProblems(withDuplicate).includes("exit 8 has two rows"),
    "control: a code with two rows is caught",
  );

  // #2394: the paragraph that called the unset hours check deliberately dropped was
  // written the day before #2080 shipped it, and it read as a reason to remove it.
  assert(
    !/seeded default week is NOT reported/i.test(section),
    "the section no longer calls the unset hours check deliberately dropped",
  );
}

finish();
