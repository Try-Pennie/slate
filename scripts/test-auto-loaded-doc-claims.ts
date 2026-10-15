// #2398: hand maintained numbers and lists in AGENTS.md and docs/review-process.md
// had drifted and nothing derived them. Three guards, each blind where the others
// look:
//
//   1. no hand written count of the repo's own tree survives in the docs a
//      session loads or a reviewer is pointed at (scan-doc-claims.ts says why);
//   2. AGENTS.md points at SAFE_TABLES and holds NO copy of it. The copy drifted
//      once (a reader adding a read on `business_hours` was told every unlisted
//      table is flagged, and told to add it to a list that already held it), and
//      the constant already carries a reason per table, so since 2026-10-15 the
//      constant is the list's one home and the doc only names it;
//   3. every `verify:` command in package.json is named in AGENTS.md AND carries
//      its detail in docs/verify-commands.md, so moving a section out of the
//      auto loaded file cannot quietly lose one.
//
// Run: node --experimental-strip-types scripts/test-auto-loaded-doc-claims.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SAFE_TABLES } from "./lib/scan-src-capped-reads.ts";
import { FORBIDDEN_CLAIMS, scanDocClaims } from "./lib/scan-doc-claims.ts";
import { assert, fail, finish } from "./lib/harness.ts";

const root = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// Every document a session loads, plus the one a reviewer is sent to and the one
// the verify detail moved into. A doc left off this list is exempt from the
// guard written to cover it (L96), so the list is short and deliberate.
const SCANNED = [
  "AGENTS.md",
  "CLAUDE.md",
  "docs/review-process.md",
  "docs/verify-commands.md",
  // Where the 2026-10-15 cut moved runbook sections out of AGENTS.md; each is
  // named by a pointer that the auto loaded file still carries.
  "docs/auto-loaded-rules.md",
  "docs/push-gate.md",
  "docs/workflows.md",
  "docs/monitor-lane.md",
  "docs/testing.md",
  "docs/repo-guards.md",
  "docs/copy-previews.md",
];

// --- 1. No hand written count of the repo's own tree --------------------------

{
  const findings = SCANNED.flatMap((f) => scanDocClaims(f, read(f)));
  for (const f of findings) {
    fail(`${f.file}:${f.line} restates a count the tree already answers: ${f.reason}\n    ${f.text}`);
  }
  assert(findings.length === 0, `no auto loaded doc restates a count of the repo's own tree (${findings.length} found)`);
}

// Positive control: the scanner has to be seen catching each shape it claims to
// catch, or a rule nobody can violate and a rule nobody checks read the same.
{
  const planted = [
    "CI runs the ~120 node script suites before every push.",
    "The tree carries roughly 100 errors, almost all in fakes.",
    "It prints every string a lead can read (68 lines across 13 screens).",
    "On top of those sit about two dozen repo invariant guards.",
  ];
  const caught = scanDocClaims("planted.md", planted.join("\n\n"));
  assert(caught.length === planted.length, `every planted hand count is caught (${caught.length} of ${planted.length})`);
  assert(
    new Set(caught.map((c) => c.reason)).size === FORBIDDEN_CLAIMS.length,
    "each forbidden shape is reached by a planted line, so none is a dead rule",
  );
}

// And the wrapped shape, which the first version of this scanner read as clean
// over two of the four real instances it was written for (L278).
{
  const wrapped = [
    "end to end pass. The pyramid is intentionally bottom heavy: ~120 node script",
    "suites (`pnpm test`) plus the vitest suites all run in the pre-push gate.",
    "",
    "before it shipped.** It prints every string a lead can read (68",
    "lines across 13 screens), grouped by screen and by the state that produces it.",
  ].join("\n");
  const caught = scanDocClaims("wrapped.md", wrapped);
  assert(caught.length === 2, `a claim broken across a line wrap is caught (${caught.length} of 2)`);
}

// Negative control: a measurement of the WORLD must survive, or the guard would
// push people into deleting the dated figures that are the point.
{
  const kept = [
    "It takes about 40s, not the ~20s this file used to claim (#1594).",
    "about 25,000 routed leads over 30 days, replayed through resolveRequestedCode",
    "the design target (100 to 200 agents, ~60 buckets)",
    "Making jsdom opt in cut the vitest suite from about 8.2s to about 4.3s (#608).",
  ];
  const caught = scanDocClaims("kept.md", kept.join("\n"));
  assert(caught.length === 0, `a measurement of the world is not refused (${caught.length} false positives)`);
}

// --- 2. SAFE_TABLES: named, never copied --------------------------------------

// The doc may NAME a roster bounded table where a rule is about it (today
// `bucket_slots` in the pool compute rule and `export_cursor` in the backfill
// row), but three or more is the start of a list, and a partial list is the
// copy that drifted: it tells a reader an unlisted table is flagged.
const MAX_SAFE_TABLES_NAMED = 2;

const safeTablesNamed = (doc: string) => [...SAFE_TABLES].filter((t) => doc.includes(`\`${t}\``));

/** True when one paragraph names the constant AND the file it lives in. */
const pointsAtSafeTables = (doc: string) =>
  doc
    .split(/\n\s*\n/)
    .some((p) => p.includes("`SAFE_TABLES`") && p.includes("scripts/lib/scan-src-capped-reads.ts"));

{
  const agents = read("AGENTS.md");
  assert(SAFE_TABLES.size > 10, `the constant was really read (${SAFE_TABLES.size} tables)`);
  assert(
    pointsAtSafeTables(agents),
    "AGENTS.md points at the list: one paragraph names `SAFE_TABLES` and scripts/lib/scan-src-capped-reads.ts",
  );
  const named = safeTablesNamed(agents);
  assert(
    named.length <= MAX_SAFE_TABLES_NAMED,
    `AGENTS.md holds no copy of SAFE_TABLES (it names ${named.length}, at most ${MAX_SAFE_TABLES_NAMED}: ${named.join(", ")}); point at the constant instead`,
  );
}

// Controls, both directions, run against the real doc so they track it.
{
  const agents = read("AGENTS.md");
  const partial = [...SAFE_TABLES].filter((t) => !agents.includes(`\`${t}\``)).slice(0, 3);
  const planted = `${agents}\n\nRoster bounded: ${partial.map((t) => `\`${t}\``).join(", ")}.\n`;
  assert(
    safeTablesNamed(planted).length > MAX_SAFE_TABLES_NAMED,
    `a planted partial copy of three tables is refused (${safeTablesNamed(planted).length} named)`,
  );
  const stripped = agents.replaceAll("scripts/lib/scan-src-capped-reads.ts", "the scanner");
  assert(!pointsAtSafeTables(stripped), "a doc that names the constant but not its file is refused");
  assert(
    pointsAtSafeTables("See `SAFE_TABLES` in scripts/lib/scan-src-capped-reads.ts."),
    "a one line pointer is accepted",
  );
}

// --- 3. Every verify command is named where a reader will look ----------------

{
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  const commands = Object.keys(pkg.scripts).filter((k) => k.startsWith("verify:"));
  assert(commands.length > 0, `package.json declares verify commands (${commands.length})`);
  const agents = read("AGENTS.md");
  const runbook = read("docs/verify-commands.md");
  for (const cmd of commands) {
    assert(agents.includes(cmd), `AGENTS.md names \`pnpm ${cmd}\``);
    assert(runbook.includes(cmd), `docs/verify-commands.md carries the detail for \`pnpm ${cmd}\``);
  }
  // And the other direction: a command the runbook describes that no longer
  // exists sends somebody to run something that is gone.
  for (const named of new Set([...runbook.matchAll(/pnpm (verify:[a-z-]+)/g)].map((m) => m[1]))) {
    assert(commands.includes(named), `docs/verify-commands.md only describes real commands (\`${named}\`)`);
  }
  assert(
    agents.includes("docs/verify-commands.md"),
    "AGENTS.md points at the runbook the detail moved into, so the rule keeps its evidence",
  );
}

finish();
