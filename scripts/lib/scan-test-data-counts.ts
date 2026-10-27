// Static detector for the #1291 guard: a reported COUNT over a population table
// that silently includes the permanent test fixtures. See
// scripts/test-test-data-counts.ts for the why and the fixtures proving it
// catches the bad pattern.
//
// The defect. The SMOKE agents and buckets exist to run forever (#396), so any
// number that includes them is permanently measuring Slate against itself, and
// nothing fails: the figure is simply wrong in a direction that reads as healthy.
// It shipped twice in one day. The low-booking-volume count included the canary's
// bookings, where the last 6 hours held 8 bookings and 0 of them were real
// (#1258); the empty-bucket sweep counted the two SMOKE fixtures in the total it
// reported (#1286). In both cases every neighbouring read filtered test rows and
// the new one did not.
//
// SCOPE is the surface where a wrong number is TOLD to someone: the monitor lane,
// the alerting, and the availability service that raises the empty-bucket pages.
// Both shipped instances are inside it. The wider codebase is deliberately out,
// and that boundary is a decision rather than an oversight: an operational read
// that happens to call `.filter()` on its own result is not reporting a
// measurement, and flagging all 27 of them would trade real thought for
// mechanical comments, the same call already made for the table-aware capped-read
// guard.
//
// A read is FLAGGED when it is on a population table, feeds a count or aggregate,
// and neither filters test rows nor carries an opt-out. It is NOT flagged when:
//   - the chain is wrapped in `realAdvisorsOnly(` or selects `REAL_ADVISOR_COLUMNS`,
//     the shared real advisor rule (#4201), which excludes the test advisors;
//   - the chain mentions `is_test`, directly or through an embed
//     (`buckets!inner(is_test)`, as monitor/customer-bookings.ts does, because
//     `bookings` has no is_test column of its own and test-ness is a property of
//     the BUCKET);
//   - it is a primary-key lookup (`.eq("id", …)` / `.in("id", …)`): the set was
//     already chosen upstream, so this is not measuring a population and a filter
//     here would only re-ask a question already answered;
//   - nothing aggregates the result, so no number is derived from it;
//   - a `// test-data-ok:` opt-out sits on, or in the `//` block directly above,
//     the `.from(` line.
//
// Deliberately a text scan, in the same family as scan-src-capped-reads.ts.

import { hasOptOut } from "./opt-out.ts";

export interface TestDataCountFinding {
  file: string;
  line: number;
  table: string;
  snippet: string;
}

/** Tables that hold both real rows and the permanent fixtures. */
const POPULATION_TABLES = ["bookings", "buckets", "users"];

/** Directories whose numbers are reported to a person, so a wrong one misleads. */
export const REPORTED_COUNT_SCOPE = [
  "src/lib/monitor",
  "src/lib/notify",
  "src/app/api/cron/monitor",
  "src/lib/availability",
];

const FROM_RE = new RegExp(`\\.from\\(\\s*["'\`](${POPULATION_TABLES.join("|")})["'\`]`);
/** Something derives a NUMBER from the result. */
const AGGREGATE_RE = /count:\s*["'`]exact|head:\s*true|\.length\b|\.filter\(|\.reduce\(/;
/** A bounded, already-chosen set rather than a population. */
const PRIMARY_KEY_RE = /\.(?:eq|in)\(\s*["'`]id["'`]/;

/** How far past the `.from(` to read the rest of the chain and its use. */
const CHAIN_LINES = 14;

/** True when `path` is inside the reported-count scope. */
export function inReportedCountScope(path: string): boolean {
  const normalised = path.split("\\").join("/");
  return REPORTED_COUNT_SCOPE.some((dir) => normalised.startsWith(dir));
}

function optedOut(lines: string[], index: number): boolean {
  return hasOptOut(lines, index, "test-data-ok:");
}

export function scanTestDataCounts(source: string, file = "<source>"): TestDataCountFinding[] {
  const lines = source.split("\n");
  const findings: TestDataCountFinding[] = [];

  lines.forEach((line, i) => {
    // Comments stripped before matching, so the guard can neither be satisfied by
    // nor tripped by prose about a read, including one saying a filter was
    // removed (L103).
    const table = FROM_RE.exec(line.replace(/\/\/.*$/, ""))?.[1];
    if (table === undefined) return;

    const window = lines
      .slice(i, i + CHAIN_LINES)
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    if (!AGGREGATE_RE.test(window)) return;
    if (PRIMARY_KEY_RE.test(window)) return;
    if (window.includes("is_test")) return;
    // The helper wraps the chain, so it sits on or just above the `.from(` line.
    const above = lines
      .slice(Math.max(0, i - 3), i + 1)
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    if (/realAdvisorsOnly\(/.test(above) || window.includes("REAL_ADVISOR_COLUMNS")) return;
    if (optedOut(lines, i)) return;

    findings.push({ file, line: i + 1, table, snippet: line.trim().slice(0, 120) });
  });

  return findings;
}
