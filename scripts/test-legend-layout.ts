// Both keys are ONE component, laid out as one column with shared tracks (#1925).
//
// Dan: "The key is also too hard to read. Let's make it a single column and try
// for fewer words where possible."
//
// The layout was the problem rather than the wording. Both keys were a wrapping
// flow row, so the columns anybody sees are an accident of where entries of
// different lengths happen to wrap: each begins wherever the sentence to its
// left ended, so nothing lines up and the eye has no column to follow (L578).
//
// This is a SHAPE check and it says so. What it cannot do is measure where
// anything actually lands, and the first version of the fix passed every shape
// anybody would have written while still giving five rows five different
// sentence positions, because a grid PER ROW sizes its own tracks. That was
// caught by measuring the rendered page, and the assertions below are what stop
// the shape drifting back.
//
// Run: node --experimental-strip-types scripts/test-legend-layout.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert, finish } from "./lib/harness.ts";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Source with the prose blanked. A comment DESCRIBING the layout that was
 * removed reads identically to the layout itself, and this guard failed on its
 * own explanation of the fix the first time it ran (the mirror of L103).
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

const LEGEND = join("src", "components", "ui", "LegendList.tsx");
const legend = code(readFileSync(LEGEND, "utf8"));

// --- one column, with tracks shared across the rows --------------------------
assert(
  /<ul className="[^"]*\bgrid\b[^"]*grid-cols-\[/.test(legend),
  "the LIST is the grid, so its tracks are shared by every row",
);
assert(
  /<li[^>]*className="[^"]*grid-cols-subgrid/.test(legend),
  "and each row takes those tracks rather than sizing its own",
);
assert(
  !/flex-wrap/.test(legend),
  "the key never wraps into a flow row, which is the layout that made it unreadable",
);
// A row whose sentence wraps must not drag its swatch down with it.
assert(/items-start/.test(legend), "rows align on their first line, not their centres");

// --- and both keys go through it ---------------------------------------------
//
// The two carried this markup character for character. Fixing one and leaving
// the other is exactly how they drift, so the check is that NOTHING renders a
// key of its own any more.
const files = sources("src").filter((f) => f !== LEGEND);
const ownLegend: string[] = [];
for (const f of files) {
  const text = code(readFileSync(f, "utf8"));
  // The shape of the old key: a list mapping entries that carry a swatch and a
  // meaning. Matched on the pair, so an ordinary list is not flagged.
  if (/\.map\(\([a-z]\) => \(\s*<li/.test(text) && /swatchExtra/.test(text)) {
    ownLegend.push(f);
  }
}
assert(
  ownLegend.length === 0,
  `no page renders a key of its own:\n    ${ownLegend.join("\n    ")}`,
);

// Both pages must actually USE it, or "nothing renders its own" is satisfied by
// nothing rendering a key at all (L98).
const users = files.filter((f) => /<LegendList\b/.test(code(readFileSync(f, "utf8"))));
assert(
  users.length >= 2,
  `both keys go through the shared one (found ${users.length}: ${users.join(", ")})`,
);
for (const expected of ["AvailabilityGridTable.tsx", "BucketSupplyTable.tsx"]) {
  assert(
    users.some((f) => f.endsWith(expected)),
    `${expected} renders the shared key`,
  );
}

// --- the sentences are short, and the one that must not be is not ------------
const copy = readFileSync(join("src", "lib", "admin", "availability-grid-copy.ts"), "utf8");
const meanings = [...copy.matchAll(/meaning: "([^"]+)"/g)].map((m) => m[1]);
assert(meanings.length >= 7, `the grid's meanings were found (${meanings.length})`);

const longOnes = meanings.filter((m) => m.length > 45 && !/could not be read/.test(m));
assert(
  longOnes.length === 0,
  `every sentence is short, bar the could-not-measure one:\n    ${longOnes.join("\n    ")}`,
);
// THE EXCEPTION, and it is deliberate: shortening it to something like "Not
// measured" loses the distinction between "we looked and there was nothing" and
// "we could not look", which is the whole reason that state exists (L11).
assert(
  meanings.some((m) => /could not be read/.test(m)),
  "the could-not-measure state still says WHY, rather than being shortened into silence",
);

finish();
