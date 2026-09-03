// A Pill starting a table cell aligns its label to the column header (#1821).
//
// Dan, on the Bookable column: "the alignment is from the B in the column header
// to the left edge of the green bubble, not to the B in the value. So the words
// aren't align, the header and the bubble are aligned and that's awkward".
//
// He noticed it there because the header and the value were the same word. The
// defect belonged to the pill, so it was in every column that used one, which is
// why the fix is on the component and this guard is on the call sites.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-pill-alignment.ts
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { scrubbedGitEnv } from "./lib/git-env.ts";
import { scanPillAlignment } from "./lib/scan-pill-alignment.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

function sourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "src"], {
    encoding: "utf8",
    env: scrubbedGitEnv(),
  })
    .split("\n")
    .filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f));
}

// --- the tree --------------------------------------------------------------
{
  const offenders = sourceFiles().flatMap((f) => scanPillAlignment(f, readFileSync(f, "utf8")));
  if (offenders.length === 0) {
    assert(true, "every Pill starting a table cell aligns to its column");
  } else {
    for (const o of offenders) fail(`${o.file}:${o.line} ${o.why}`);
  }
}

// --- positive controls -----------------------------------------------------
//
// Without these, a scanner that found nothing at all would pass the block above.
{
  const CELL = (inner: string) => `<tr><td className="px-3 py-3">${inner}</td></tr>`;

  eq(
    scanPillAlignment("src/x.tsx", CELL('<Pill variant="status-ok">Yes</Pill>')).length,
    1,
    "an unaligned pill in a cell is caught",
  );
  eq(
    scanPillAlignment("src/x.tsx", CELL('<Pill variant="status-ok" alignToColumn>Yes</Pill>')).length,
    0,
    "an aligned one is not",
  );

  // A pill OUTSIDE a cell is correctly inset and must be left alone.
  eq(
    scanPillAlignment("src/x.tsx", '<p>status <Pill variant="outline">No</Pill></p>').length,
    0,
    "a pill in a sentence is not a table cell",
  );

  // Two in one cell: the first aligns, the second must not.
  eq(
    scanPillAlignment(
      "src/x.tsx",
      CELL('<Pill variant="outline" alignToColumn>A</Pill><Pill variant="outline">B</Pill>'),
    ).length,
    0,
    "first aligned, second not, is the correct shape",
  );
  eq(
    scanPillAlignment(
      "src/x.tsx",
      CELL('<Pill variant="outline" alignToColumn>A</Pill><Pill variant="outline" alignToColumn>B</Pill>'),
    ).length,
    1,
    "a second aligned pill is caught, because it would eat the gap",
  );
  eq(
    scanPillAlignment(
      "src/x.tsx",
      CELL('<Pill variant="outline">A</Pill><Pill variant="outline">B</Pill>'),
    ).length,
    1,
    "and an unaligned first one is still caught when there are two",
  );

  // The workaround this exists to prevent.
  eq(
    scanPillAlignment(
      "src/x.tsx",
      '<td className="-ml-[9px] px-3"><Pill variant="outline" alignToColumn>A</Pill></td>',
    ).length,
    1,
    "a negative margin on the cell is caught even when the pill is correct",
  );
  eq(
    scanPillAlignment("src/x.tsx", '<td className="-ml-2 px-3">plain text</td>').length,
    0,
    "and a cell with no pill in it is none of this guard's business",
  );

  // A multi line opening tag, which is how most real call sites are written.
  eq(
    scanPillAlignment(
      "src/x.tsx",
      '<td className="px-3">\n  <Pill\n    variant="status-ok"\n    alignToColumn\n  >\n    Yes\n  </Pill>\n</td>',
    ).length,
    0,
    "the prop is found across a multi line tag",
  );

  // The opt-out works and needs a reason.
  // On its own line above the pill, which is how every other guard in this tree
  // spells its opt-out.
  eq(
    scanPillAlignment(
      "src/x.tsx",
      '<td className="px-3">\n  // pill-align-ok: a reason\n  <Pill variant="outline">A</Pill>\n</td>',
    ).length,
    0,
    "an opt-out with a reason is honoured",
  );
  eq(
    scanPillAlignment(
      "src/x.tsx",
      '<td className="px-3">\n  // pill-align-ok:\n  <Pill variant="outline">A</Pill>\n</td>',
    ).length,
    1,
    "an opt-out with no reason is not one",
  );
}

finish();
