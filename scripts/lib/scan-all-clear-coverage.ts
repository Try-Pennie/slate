// Pure detectors for the #1152 guard: every place Slate can say "all clear" must
// carry a test proving it stays silent when the thing it measured could not be
// read. The fs walk and the fixtures live in
// scripts/test-all-clear-failure-coverage.ts; this file holds the two text
// judgements so they are unit-testable on their own.
//
// The bug class. A recovery notice (`resolveAlert`, #1133) is only honest if the
// healthy verdict behind it came from a query that actually ran. Slate keeps
// re-learning that an empty result is not evidence of health:
//   - #277: an availability read swallowed its error, the pool collapsed to empty
//     and the booker showed no times; a broken deploy looked like a quiet day.
//   - #1134: `loadFailingAgents` swallowed a read error, returned [], and would
//     have posted "calendar sync has recovered" off a query that never ran.
//   - #1152: three self-heal sweeps did the same. Their worklist reads degraded to
//     an empty list, the resulting count of zero read as "under the cap", and that
//     posted "the backlog has cleared, no action is needed" while also clearing the
//     failure streak that would have paged.
//
// Each time, the code looked right and the tests were green, because a test that
// only exercises the healthy path cannot tell a real zero from an unreadable one.
// So the invariant this guard enforces is about the TESTS, not the source: a module
// that resolves an alert must own at least one test that pins the silent path.

/** Where `resolveAlert` is defined (and legitimately named without calling it). */
export const ALL_CLEAR_DEFINITION = "src/lib/notify/dispatch.ts";

/**
 * Does this module decide to send an all-clear? True when it CALLS `resolveAlert`
 * or hands it to a helper that will (`resolve: resolveAlert`), as opposed to
 * importing it, re-exporting it, or mentioning it in a comment.
 *
 * Both shapes count because both are wiring points: the monitor lane calls it
 * directly for one alert and passes it into `runMigrationDriftCheck` for another,
 * and a guard that saw only the first would let half that lane's all-clears ship
 * unexamined. Ignoring the import line and comments keeps a doc reference from
 * registering a surface that does not exist, which would demand a test for nothing
 * and train people to write exemptions.
 */
export function callsResolveAlert(source: string): boolean {
  return stripComments(source)
    .split("\n")
    .filter((line) => !/^\s*import\b/.test(line) && !/^\s*}\s*from\s+["']/.test(line))
    .some((line) => /(^|[^\w.])(?:\w+\.)?resolveAlert\b/.test(line));
}

/**
 * Test files this module names as holding its silent-path proof, via a
 * `// all-clear-proof: <path> - <why>` comment on or above the wiring.
 *
 * The second escape from the strict rule below, and the one that keeps the guard
 * honest about Slate's two harnesses. A vitest suite proves the silent path with
 * `expect(resolveAlert).not.toHaveBeenCalled()`, which `provesNoAllClear` can read.
 * A node script proves the same thing with `assert(resolved.length === 0, ...)`,
 * which no regex can recognise without inviting a fake. So a module whose proof
 * lives node-natively, or in the suite of the helper it injects into, points at
 * that file and the runner checks the file exists. The pointer sits in the source
 * beside the wiring rather than in a list off to one side, so it moves with the
 * code instead of drifting from it (L41).
 */
export function declaredProofPaths(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split("\n")) {
    const m = /\/\/\s*all-clear-proof:\s*(\S+)/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Does this test file prove that some path sends NO all-clear?
 *
 * The proof shape is an assertion that `resolveAlert` was not called:
 *   expect(resolveAlert).not.toHaveBeenCalled();
 *   expect(dispatch.resolveAlert).not.toHaveBeenCalled();
 *
 * DELIBERATE LIMIT, stated so this guard never reads as more than it is: this
 * confirms such an assertion EXISTS, not that the scenario driving it is the
 * unreadable one. It cannot know whether the test fed the module a failed read or
 * merely a quiet healthy tick. What it does close is the gap that produced #1134
 * and #1152 twice over, a surface shipping with only happy-path assertions on it,
 * and it puts the question in front of whoever adds the next all-clear. Judging
 * whether the scenario is a genuine failure is a review call, and the fixtures in
 * the runner keep the detector itself from rotting into a no-op.
 */
export function provesNoAllClear(testSource: string): boolean {
  return /resolveAlert\s*\)\s*\.\s*not\s*\.\s*toHaveBeenCalled/.test(stripComments(testSource));
}

/** Drop `//` and block comments so a commented-out call or assertion never counts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
