// Re-running an end to end tree write tripwire case whose run MEASURED NOTHING (#3524).
//
// The tripwire's own tests start a real runner (or a real vitest) against a throwaway
// root and read its verdict. On a loaded macOS machine the file watch underneath can
// stall, and an honest tripwire then reports that it could not watch: it refuses to
// start, or it finishes with TREE WATCH FAILED. That is the machine's file watching,
// not the behaviour a case is checking, and reading it as a red failed unrelated
// pushes (L411). So such a run is re-run, a bounded number of times.
//
// What it deliberately does NOT do, so it never hides a real red (L293):
//   - re-run anything that measured something, red or green;
//   - re-run forever: after TRIPWIRE_RUN_ATTEMPTS the last unmeasured run is
//     returned and the case fails on it, with the runner's own words;
//   - re-run silently: every retry prints a line saying why, so a flake has a price
//     somebody can see and count.
import { reportsWatchUnavailable } from "./tree-write-tripwire.ts";

/** How many times one case may run before an unmeasured run is reported as such. */
export const TRIPWIRE_RUN_ATTEMPTS = 3;

const WATCH_UNAVAILABLE =
  "the run under test said it could not watch the tree, so it measured nothing either way " +
  "(a stalled file watch on this machine, #3524)";

/**
 * Run a case, re-running it while its output is UNMEASURED: the tripwire said it
 * could not watch, or `alsoUnmeasured` names a reason of the case's own (the
 * positive control's write caught too late to name a suite, so attribution was not
 * exercised). Measured on 2026-10-12 at load 15 to 20, 20 runs of that control:
 * every write caught, one only by the comparison and three seen after the runner's
 * 2s suspect window, so naming nobody.
 */
export async function untilWatched<T extends { out: string }>(
  run: () => Promise<T>,
  label: string,
  log: (line: string) => void = (line) => console.error(line),
  alsoUnmeasured: (out: string) => string | null = () => null,
): Promise<T> {
  const unmeasured = (out: string) => (reportsWatchUnavailable(out) ? WATCH_UNAVAILABLE : alsoUnmeasured(out));
  let last = await run();
  for (let attempt = 2; attempt <= TRIPWIRE_RUN_ATTEMPTS; attempt++) {
    const why = unmeasured(last.out);
    if (why === null) break;
    log(`retry ${attempt}/${TRIPWIRE_RUN_ATTEMPTS} for ${label}: ${why}`);
    last = await run();
  }
  return last;
}
