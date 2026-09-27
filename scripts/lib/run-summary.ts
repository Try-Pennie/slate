// The test runner's summary line, formatted in ONE place (#2813).
//
// `scripts/run-tests.ts` prints it and `scripts/lib/clock-shift-report.ts` reads it
// back to decide whether a shifted run measured anything. The two used to hold the
// shape separately, so when the tree write tripwire (#2733) added a field after the
// clock, the reader went on parsing the old shape, read `+1d, tripwire on` as the
// clock, and reported every shift unmeasured. The report's tests build their
// fixture from this function, so a field added here reaches the reader's tests the
// same day it reaches the runner's output (L41).
//
// Imports nothing, so the bare node alerter that reads the line can carry it.

export interface RunSummaryParts {
  passed: number;
  failed: number;
  wallMs: number;
  concurrency: number;
  /** The clock shift the run was asked for, or "" for an ordinary run. */
  clock: string;
  /** The tripwire's state, exactly as the runner resolved it. */
  tripwire: string;
}

/**
 * The summary, without its PASS / FAIL prefix. The parenthesised part is a list of
 * `, ` separated fields, each a name then its value, so a reader must split it into
 * fields rather than capture from a name to the closing bracket.
 */
export function formatRunSummary(p: RunSummaryParts): string {
  const fields = [`concurrency ${p.concurrency}`];
  if (p.clock) fields.push(`clock ${p.clock}`);
  fields.push(`tripwire ${p.tripwire}`);
  return `${p.passed} passed, ${p.failed} failed in ${(p.wallMs / 1000).toFixed(2)}s (${fields.join(", ")})`;
}
