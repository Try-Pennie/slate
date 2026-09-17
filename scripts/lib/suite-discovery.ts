// Which files ARE the node suite (#2503).
//
// One definition, read by the runner that executes them and by the shifted run's
// reporter, which has to know how many suites a run SHOULD have contained before it
// can say a clean result was a real one. A count that is merely plausible would let
// a run that executed half the suite report no date dependent tests (L98), and two
// copies of the pattern would drift the day somebody renamed the convention (L41).
import { readdirSync } from "node:fs";

/** The house convention: every node suite is `scripts/test-<something>.ts`. */
export const SUITE_FILE_PATTERN = /^test-.*\.ts$/;

/** The suite file NAMES in a directory, sorted, with no path attached. */
export function discoverSuiteNames(dir: string): string[] {
  return readdirSync(dir).filter((f) => SUITE_FILE_PATTERN.test(f)).sort();
}
