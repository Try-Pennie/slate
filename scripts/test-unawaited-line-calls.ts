// Every call the confirm path makes to its line is awaited (#3325).
//
// A line shared across isolates answers over the network, so a seat claim, a
// pass or a turn's report is a promise. One left unawaited still compiles: `tsc`
// does not flag an unused promise and the repo has no type aware lint. And a
// Worker cancels unawaited work when the response goes out, so a forgotten `await`
// on `done` leaves the shared line holding a turn until its lease runs out, every
// follower behind it waiting. This guard fails the build on one.
//
// Positive controls first: a scanner that finds nothing is indistinguishable from
// a tree that has nothing to find (L1, L98).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-unawaited-line-calls.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { unawaitedLineCalls, LINE_CALL_EXEMPT_FILES } from "./lib/scan-unawaited-line-calls.ts";
import { assert, finish } from "./lib/harness.ts";

// --- positive controls ---------------------------------------------------------
{
  const caught = unawaitedLineCalls("x.ts", ["  seat.claim(userId, false);", "  if (x) held?.seat?.pass();", "  turn.done({ full: false });", "  void seat.claimFirst(c);"].join("\n"));
  assert(caught.length === 4, `controls: four unawaited calls are caught (got ${caught.length}: ${JSON.stringify(caught)})`);
  const clean = unawaitedLineCalls(
    "x.ts",
    [
      "  await seat.claim(userId, false);",
      "  if (x) await held?.seat?.pass();",
      "  return seat.claimFirst(c);",
      "  const { pool } = await seat.claimFirst(c);",
      "  await turn.done({ full: false });",
      "  claimedByOthers: seat ? await seat.claimedByOthers() : undefined,",
      "  // seat.claim(userId) in a comment is not a call",
    ].join("\n"),
  );
  assert(clean.length === 0, `controls: awaited, returned and commented calls are left alone (got ${JSON.stringify(clean)})`);
}

// --- #3350: `//` inside a string is not a comment --------------------------------------
// The scan cut every line at its first `//`, so a URL in a string hid an unawaited call
// written after it on the same line, and the guard passed while the bug shipped.
{
  const hidden = unawaitedLineCalls(
    "x.ts",
    [
      '  const u = "https://x.test/a"; seat.claim(userId, false);',
      "  const v = `//${host}/b`; turn.done({ full: false });",
      "  const w = '//'; seat.pass();",
    ].join("\n"),
  );
  assert(hidden.length === 3, `an unawaited call after a // inside a string is still caught (got ${hidden.length}: ${JSON.stringify(hidden)})`);
  const stillComments = unawaitedLineCalls(
    "x.ts",
    ["  await seat.pass(); // and then seat.claim(x) in a trailing comment", "  /* seat.claim(x) in a block comment */ await seat.pass();", "  /*", "   * seat.claim(x) on a block comment line", "   */"].join("\n"),
  );
  assert(stillComments.length === 0, `a call written only in a real comment is still not a call (got ${JSON.stringify(stillComments)})`);
}

// --- the real tree ---------------------------------------------------------------
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}
const files = walk("src/lib/booking").filter((f) => !LINE_CALL_EXEMPT_FILES.includes(f));
assert(files.some((f) => f.endsWith("orchestration.ts")), "tree: the scan reaches orchestration.ts, where the line is used");
const found = files.flatMap((f) => unawaitedLineCalls(f, readFileSync(f, "utf8")));
assert(found.length === 0, `tree: no unawaited line call in src/lib/booking (found ${found.length}):\n${found.join("\n")}`);

finish();
