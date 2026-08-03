// #1200: every copy-paste command in an operator runbook must say whether it has
// actually been executed.
//
// #1197 shipped a runbook step whose SQL had never been run against the real
// target. It named a column that exists only in Supabase, so Snowflake rejected
// the whole statement and the purge was a silent no-op. It read as correct to
// every reviewer for as long as it existed, and was caught only because an
// operator ran the verify query and compared the numbers.
//
// These docs are read while something is broken or a deadline is running, and
// unlike code nothing in CI executes them, so age does not increase confidence
// in them. The defect is not that a command is wrong; it is that a reader cannot
// tell a proven step from an assumed one. So every fenced block declares one of:
//
//   <!-- runbook-verified: YYYY-MM-DD (hash) what was run, against what, result -->
//   <!-- runbook-unverified: why it cannot be executed -->
//   <!-- runbook-reference: why this block is not a command to run -->
//
// The hash is what keeps `verified` honest. It is taken over the block's own
// content, so EDITING a verified command invalidates its proof and this guard
// demands a fresh run. Without it the marker decays into a claim about text that
// is no longer there, which is the #1197 shape again: a statement that reads as
// checked while nothing checked the thing actually present (L40, L1).
//
// `unverified` and `reference` carry no hash on purpose: neither makes a claim
// about a past execution, so there is no proof for an edit to invalidate.
//
// Run: node --experimental-strip-types scripts/test-runbook-commands.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import {
  blockHash,
  normalizeBlock,
  parseMarker,
  scanRunbookBlocks,
} from "./lib/scan-runbook-commands.ts";

const root = join(import.meta.dirname, "..");

/**
 * The operator-facing docs. `pii-retention.md` holds no fenced blocks today and
 * is listed anyway, so a command added to it later is guarded on arrival rather
 * than needing someone to remember this list exists.
 */
const RUNBOOKS = [
  "DEPLOY.md",
  "docs/migrations-runbook.md",
  "docs/snowflake-setup.md",
  "docs/pii-erasure-runbook.md",
  "docs/pii-retention.md",
  "docs/smoke-test-runbook.md",
];

const blocks = RUNBOOKS.flatMap((rel) =>
  scanRunbookBlocks(rel, readFileSync(join(root, rel), "utf8")),
);

// Sanity check on the parse. A regex that stopped matching would leave every
// claim below iterating an empty list and reading as full coverage (L1).
assert(
  blocks.length >= 25,
  `parsed the runbooks' fenced blocks (found ${blocks.length}, expected at least 25)`,
);
for (const rel of ["DEPLOY.md", "docs/snowflake-setup.md", "docs/pii-erasure-runbook.md"]) {
  assert(
    blocks.some((b) => b.doc === rel),
    `sanity check on the parse: found blocks in ${rel}`,
  );
}

for (const b of blocks) {
  const at = `${b.doc}:${b.line}`;
  const first = normalizeBlock(b.content).split("\n")[0]?.slice(0, 60) ?? "";

  if (!b.marker) {
    assert(
      false,
      `${at} has no verification marker (first line: "${first}"). Add one of ` +
        `runbook-verified / runbook-unverified / runbook-reference directly above the fence`,
    );
    continue;
  }

  assert(
    b.marker.note.trim().length >= 15,
    `${at} marker states a real reason or evidence rather than a placeholder ` +
      `(got "${b.marker.note.trim()}")`,
  );

  if (b.marker.status !== "verified") continue;

  assert(
    b.marker.date !== null && b.marker.hash !== null,
    `${at} runbook-verified marker is shaped ` +
      `"YYYY-MM-DD (hash) evidence" (got "${b.marker.note.slice(0, 60)}")`,
  );
  if (!b.marker.date || !b.marker.hash) continue;

  const actual = blockHash(b.content);
  assert(
    b.marker.hash === actual,
    `${at} was EDITED since it was verified on ${b.marker.date} ` +
      `(marker says ${b.marker.hash}, block is now ${actual}). Re-run the command and ` +
      `update the marker, or downgrade it to runbook-unverified`,
  );

  // A date in the future, or one that does not parse, means the marker was
  // hand-written rather than recorded from a real run.
  const stamp = Date.parse(`${b.marker.date}T00:00:00Z`);
  assert(
    Number.isFinite(stamp) && stamp <= Date.now(),
    `${at} verification date ${b.marker.date} is a real, non-future date`,
  );
}

// Every doc that holds commands has at least one block actually PROVEN, so a
// runbook cannot pass this guard by declaring all of its steps unverifiable.
for (const rel of RUNBOOKS) {
  const mine = blocks.filter((b) => b.doc === rel);
  if (mine.length === 0) continue;
  assert(
    mine.some((b) => b.marker?.status === "verified"),
    `${rel} has at least one command proven by execution, not only unverifiable ones`,
  );
}

// --- A documented `node scripts/…` command invokes the script the way the repo
// does everywhere else.
//
// docs/smoke-test-runbook.md step 4 told the operator to run
// `node --experimental-strip-types scripts/smoke-booking-api.ts`, with no
// `--import ./scripts/register-paths.mjs`. That flag is what resolves the `@/`
// alias, so the command died immediately on
// `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'` (#1200). Every
// package.json script and every workflow step carries it; only the document a
// human reads did not, which is why nothing caught it.
//
// The rule is uniform rather than "only scripts that import through the alias":
// step 2's seed happened to work without the flag, purely because nothing it
// imports uses `@/` yet. That made the shorter form look safe when it was one
// import away from breaking, so it is not treated as acceptable.
const REGISTER_PATHS = "--import ./scripts/register-paths.mjs";

/** Lines in a block that invoke a repo script through node. */
function nodeScriptInvocations(content: string): string[] {
  return normalizeBlock(content)
    .split("\n")
    .filter((l) => /\bnode\b/.test(l) && /\bscripts\/[\w-]+\.ts\b/.test(l));
}

let checkedInvocations = 0;
for (const b of blocks) {
  for (const line of nodeScriptInvocations(b.content)) {
    checkedInvocations++;
    assert(
      line.includes(REGISTER_PATHS),
      `${b.doc}:${b.line} invokes a repo script without ${REGISTER_PATHS}, so it crashes on ` +
        `ERR_MODULE_NOT_FOUND the moment anything it imports uses the @/ alias: ${line.trim()}`,
    );
  }
}
// Sanity check: a filter that stopped matching would leave the loop above
// checking nothing while reading as full coverage.
assert(
  checkedInvocations >= 4,
  `found the runbooks' node script invocations (checked ${checkedInvocations}, expected at least 4)`,
);

// Positive control: the exact command that shipped broken must be caught.
const wasBroken = "node --experimental-strip-types scripts/smoke-booking-api.ts";
eq(
  nodeScriptInvocations(wasBroken).length,
  1,
  "positive control: the parse SEES the invocation that shipped broken",
);
assert(
  !wasBroken.includes(REGISTER_PATHS),
  "positive control: that command lacks the flag, so the check above would fail on it",
);
eq(
  nodeScriptInvocations("pnpm test\nwrangler secret list").length,
  0,
  "positive control: a line that is not a node script invocation is not checked for the flag",
);

// --- Positive controls. Each proves this guard can still FAIL, so it cannot rot
// into a no-op if a regex quietly stops matching.

const sample = [
  "# Heading",
  "",
  "<!-- runbook-verified: 2026-08-03 (deadbeef) ran it against prod, returned 200 -->",
  "```bash",
  "echo hello",
  "```",
  "",
  "```sql",
  "select 1;",
  "```",
].join("\n");

const parsed = scanRunbookBlocks("sample.md", sample);
eq(parsed.length, 2, "positive control: the scanner finds both sample blocks");
eq(parsed[0].marker?.status, "verified", "positive control: reads the marker above a block");
eq(parsed[0].lang, "bash", "positive control: reads the fence language");
eq(parsed[0].content, "echo hello", "positive control: reads the block body");
eq(
  parsed[1].marker,
  null,
  "positive control: an unmarked block is reported as unmarked, which is the failure this guard exists to raise",
);
eq(
  parsed[0].marker?.hash,
  "deadbeef",
  "positive control: the recorded hash is read off the marker",
);
assert(
  blockHash("echo hello") !== "deadbeef",
  "positive control: the sample's real hash differs from its stale marker, so the edited-since-verified check would fire",
);

// A marker further up, with prose in between, must NOT be credited to the block.
const detached = scanRunbookBlocks(
  "sample.md",
  [
    "<!-- runbook-verified: 2026-08-03 (deadbeef) ran this against production -->",
    "",
    "Some prose that separates the marker from the block below it.",
    "",
    "```bash",
    "echo hello",
    "```",
  ].join("\n"),
);
eq(
  detached[0].marker,
  null,
  "positive control: a marker separated from its block by prose is not credited to it",
);

// A marker's justification is usually longer than one line, so the multi-line
// comment form is the normal case, not an edge case.
const wrapped = scanRunbookBlocks(
  "sample.md",
  [
    "<!-- runbook-verified: 2026-08-03 (deadbeef) run against production;",
    "     returned exactly the documented shape and wrote nothing. -->",
    "```bash",
    "echo hello",
    "```",
  ].join("\n"),
);
eq(
  wrapped[0].marker?.hash,
  "deadbeef",
  "positive control: a marker wrapped across several lines is read as one marker",
);
assert(
  (wrapped[0].marker?.note ?? "").includes("wrote nothing"),
  "positive control: the evidence text from a wrapped marker's later lines is kept",
);

// An unrelated HTML comment between the marker and the fence must not detach it.
// The erasure runbook's purge SQL really does carry a second comment (the
// `canonical-sql` anchor another guard reads), so this is the live arrangement.
const twoComments = scanRunbookBlocks(
  "sample.md",
  [
    "<!-- runbook-verified: 2026-08-03 (deadbeef) ran this against production -->",
    "<!-- canonical-sql: purge -->",
    "```",
    "select 1;",
    "```",
  ].join("\n"),
);
eq(
  twoComments[0].marker?.status,
  "verified",
  "positive control: a marker is still credited across an unrelated HTML comment",
);

// Whitespace-only edits must not force a re-verification; a real edit must.
eq(
  blockHash("echo hello"),
  blockHash("\necho hello   \n\n"),
  "positive control: trailing and surrounding whitespace does not change the hash",
);
assert(
  blockHash("echo hello") !== blockHash("echo hell0"),
  "positive control: a one-character change to the command DOES change the hash",
);

// Marker shapes that must be rejected rather than silently accepted.
eq(
  parseMarker("<!-- runbook-verified: ran it, it worked -->", 1)?.hash,
  null,
  "positive control: a verified marker with no date and hash is not treated as well-formed",
);
eq(parseMarker("<!-- just a normal comment -->", 1), null, "positive control: an unrelated HTML comment is not a marker");
eq(
  parseMarker("<!-- runbook-unverified: destructive; rolls production back -->", 1)?.status,
  "unverified",
  "positive control: an unverified marker parses",
);

finish();
