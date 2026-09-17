// Repo invariant (#2235): an assertion that cannot fail is a test reporting
// coverage it does not have.
//
// #2218 found three in one change, two of them green for months, and every one
// was found by accident while changing something else. They are cheap to find
// once you know the shapes and expensive to find that way.
//
// This file is BOTH halves of the issue: the guard for the shapes a scan can
// decide (in `scripts/lib/scan-unfailable-assertions.ts`), and the record of the
// hand sweep for the one it cannot.
//
// ---------------------------------------------------------------------------
// THE SWEEP, and what it found. Measured across 1,619 files: `scripts/**`,
// `src/**`, `.github/workflows/**` and `.githooks/**`.
//
// The first draft of the scan was the issue's own wording taken literally: any
// `for ... of` over something that looked string-ish, and any assertion whose
// MESSAGE carried a property word beside a literal. It named 72 sites. Reading
// them is what produced the rules that shipped, so the counts are worth keeping:
//
//   iterated-string      16 named, 0 real. Every one was an ARRAY built by a
//     `.map` or `.filter` whose callback happened to end in `.trim()`,
//     `.toLowerCase()` or `.replace(...)`. Anchoring the string test to the END
//     of the expression, and judging only a name declared once on one complete
//     line, takes it to zero. Two deliberate character walks
//     (`for (const d of "0123")`, which builds the three digit bucket codes) are
//     left alone on purpose: the defect is a NAME that reads as a list and is
//     not one, never iterating a literal somebody wrote out.
//
//   claim-vs-literal     56 named, 0 real, and this is the rule the issue asks
//     for that does not work. "every entry is named by a live refusal site"
//     beside `[]` is a property assertion done RIGHT, and "never sorted as epoch
//     0 or NaN" is prose. A word in a sentence cannot decide it. What CAN be
//     decided is the part of the claim that is checkable: a message claiming
//     sorted order beside a string array literal that is not sorted, which is
//     #2218's `test-catalog.ts` exactly. Zero on the tree today, and it would
//     have caught that one.
//
//   empty-filter-zero    1 named, 1 REAL, now fixed. `scripts/test-ooo-digest.ts`
//     asserted that no time off request is nudged twice by reading
//     `routedIds.filter((id) => unroutedIds.includes(id)).length === 0`. Two
//     empty lists overlap in nothing, so a routing step that produced no blocks
//     at all satisfied it while proving nothing. It now asserts both lists carry
//     something, in the same breath.
//
//   the count shape      swept BY HAND and deliberately not scanned. The issue's
//     third shape is a length compared against "how many of these exist in the
//     code", and no scan can tell `eq(rows.length, 3)` over a fixture of three
//     from one hard coding how many fields a row happens to have. Read through
//     the `eq(..., <number>, ...)` sites in the node suite: the ones over a
//     fixture the same test builds are fine (the number and the fixture move
//     together, in view of each other), and the ones over a REAL population
//     already derive it. The live instance #2218 names, `page.test.tsx`
//     asserting at least three "Not set" values because the row held three
//     fields, was corrected in #2234. Nothing new was found, and the honest
//     record of that is "swept, none found" rather than a guard that would fire
//     on every fixture in the suite.
//
// ---------------------------------------------------------------------------
// Run: node --experimental-strip-types scripts/test-unfailable-assertions.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanUnfailableAssertions } from "./lib/scan-unfailable-assertions.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const HERE = import.meta.dirname; // scripts/
const ROOT = join(HERE, "..");

// --- fixtures: both directions per shape --------------------------------------

interface Fixture {
  name: string;
  src: string;
  shape: "iterated-string" | "unsorted-sorted-claim" | "empty-filter-zero" | null;
}

const FIXTURES: Fixture[] = [
  // iterated-string -----------------------------------------------------------
  {
    name: "#2218: a list built with join and then iterated",
    shape: "iterated-string",
    src: [
      `const RETIRED_CRITERIA_KEYS = ["legal", "eligible"].join("_");`,
      `for (const key of RETIRED_CRITERIA_KEYS) {`,
      `  assert(!criteria[key], "the retired key is gone");`,
      `}`,
    ].join("\n"),
  },
  {
    name: "a name holding a lowercased string, iterated",
    shape: "iterated-string",
    src: [`const codes = row.code.toLowerCase();`, `for (const c of codes) use(c);`].join("\n"),
  },
  {
    name: "an ARRAY whose map callback ends in trim is not a string",
    shape: null,
    src: [
      `const teams = Array.isArray(attrs.teams) ? attrs.teams.map((t) => String(t).trim()) : [];`,
      `for (const tag of teams) use(tag);`,
    ].join("\n"),
  },
  {
    name: "an ARRAY whose map callback ends in replace is not a string",
    shape: null,
    src: [
      `const layoutDirs = LAYOUTS.map((l) => [l.replace(/x$/, "/"), l] as const);`,
      `for (const [dir] of layoutDirs) use(dir);`,
    ].join("\n"),
  },
  {
    name: "a deliberate character walk over a literal is left alone",
    shape: null,
    src: `for (const a of "12345") for (const b of "0123") CODES.push(a + b);`,
  },
  {
    name: "a name declared TWICE is not judged by the last declaration",
    shape: null,
    src: [
      `const texts = calls.map((c) => c[2]).join(" ");`,
      `const texts = other.map((c) => c[2] as string);`,
      `for (const text of texts) use(text);`,
    ].join("\n"),
  },
  {
    name: "a MULTI LINE declaration is not judged",
    shape: null,
    src: [
      `const disabled = String(env.LANES ?? "")`,
      `  .split(",")`,
      `  .filter(Boolean);`,
      `for (const name of disabled) use(name);`,
    ].join("\n"),
  },

  // unsorted-sorted-claim -----------------------------------------------------
  {
    name: "#2218: a literal claiming sorted order that is not sorted",
    shape: "unsorted-sorted-claim",
    src: `eq(Object.keys(cat), ["backend_service", "debt_team", "trades_access", "role"], "keys are sorted");`,
  },
  {
    name: "the same claim over a literal that IS sorted",
    shape: null,
    src: `eq(Object.keys(cat), ["backend_service", "debt_team", "role", "trades_access"], "keys are sorted");`,
  },
  {
    name: "an unsorted literal making no claim about order",
    shape: null,
    src: `eq(rows, ["Low", "High"], "in the order the rows arrived");`,
  },
  {
    // The real site this stands for is `test-monitor-availability-truth.ts`,
    // whose expectation is `[iso(30), iso(60)]`. A scan cannot order two calls,
    // so it does not try: it judges string literals and leaves the rest alone.
    name: "a claim this cannot judge, because the expectation is not string literals",
    shape: null,
    src: `eq(slotsToCheck(s), [iso(30), iso(60)], "an unreadable start is dropped, never sorted as epoch 0");`,
  },

  // empty-filter-zero ---------------------------------------------------------
  {
    name: "an overlap count read against zero with nothing asserting the input",
    shape: "empty-filter-zero",
    src: `assert(routedIds.filter((id) => other.includes(id)).length === 0, "nothing twice");`,
  },
  {
    name: "the same count with the input asserted beside it",
    shape: null,
    src: [
      `assert(routedIds.length > 0, "the routing step produced something to compare");`,
      `assert(routedIds.filter((id) => other.includes(id)).length === 0, "nothing twice");`,
    ].join("\n"),
  },
  {
    name: "prose describing the shape is not an instance of it",
    shape: null,
    src: `// a .filter(x).length === 0 with no companion check is the shape this catches`,
  },
];

for (const f of FIXTURES) {
  const found = scanUnfailableAssertions("fixture.ts", f.src);
  if (f.shape === null) {
    eq(found.length, 0, `allows: ${f.name}`);
  } else {
    assert(
      found.length === 1 && found[0]!.shape === f.shape,
      `flags as ${f.shape}: ${f.name} (got ${JSON.stringify(found.map((x) => x.shape))})`,
    );
  }
}

// --- the real tree ------------------------------------------------------------

function sources(dir: string, exts: RegExp): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", ".open-next", "worktrees", ".git"].includes(e.name)) continue;
    if (e.isDirectory()) {
      out.push(...sources(join(dir, e.name), exts));
      continue;
    }
    if (exts.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

// This file's own FIXTURES are instances of every shape by construction, so it is
// the one file the sweep does not read. A guard that has to name what it forbids
// cannot tell its own examples from the real thing, and the alternative is
// annotating each fixture to excuse it, which is the guard firing on its own
// documentation (L673).
const SELF = join(ROOT, "scripts", "test-unfailable-assertions.ts");

const tree = [
  ...sources(join(ROOT, "scripts"), /\.(ts|mjs|sh)$/).filter((f) => f !== SELF),
  ...sources(join(ROOT, "src"), /\.tsx?$/),
  ...sources(join(ROOT, ".github"), /\.ya?ml$/),
  ...sources(join(ROOT, ".githooks"), /(^pre-push$|\.sh$)/),
];

// A walk that reached nothing reports clean exactly as a clean tree does (L98).
assert(tree.length > 1000, `the sweep reached the tree (${tree.length} files)`);

let findings = 0;
for (const file of tree) {
  const rel = file.slice(ROOT.length + 1).replaceAll("\\", "/");
  for (const f of scanUnfailableAssertions(rel, readFileSync(file, "utf8"))) {
    findings += 1;
    assert(false, `${f.file}:${f.line} [${f.shape}] ${f.why} [${f.snippet}]`);
  }
}
if (findings === 0) {
  console.log(`ok: no assertion that cannot fail across ${tree.length} files`);
}

// --- positive control over a REAL file ----------------------------------------
//
// The fixtures prove the shapes; this proves the scan reaches the tree it just
// reported clean. #2235's own instance is put back into the real `test-ooo-digest`
// by removing the companion assertion it now carries, in memory, and the guard
// must catch it. Without this, a scan that had stopped matching and a clean tree
// would read the same (L1).
{
  const digestPath = join(ROOT, "scripts", "test-ooo-digest.ts");
  const real = readFileSync(digestPath, "utf8");
  assert(
    scanUnfailableAssertions("scripts/test-ooo-digest.ts", real).length === 0,
    "the real test-ooo-digest.ts is clean",
  );
  const reverted = real
    .split("\n")
    .filter((l) => !l.includes("both nudge lists carry something to compare"))
    .filter((l) => !l.includes("routedIds.length > 0 && unroutedIds.length > 0"))
    .join("\n");
  const caught = scanUnfailableAssertions("scripts/test-ooo-digest.ts", reverted);
  assert(
    caught.length === 1 && caught[0]!.shape === "empty-filter-zero",
    `positive control: removing the companion assertion from the REAL file is caught ` +
      `(got ${JSON.stringify(caught.map((c) => c.shape))})`,
  );
}

finish();
