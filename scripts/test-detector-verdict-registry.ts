/**
 * #1941: every gated monitor check either has a verdict lane or a NAMED reason
 * for not having one.
 *
 * The verdict family (#1394) exists because a fail safe detector can stop
 * concluding and look exactly like one finding nothing wrong. Its lane list was
 * hand maintained, so a new detector was exempt from the watch by default, and
 * roster coverage shipped that way: a guard driven by a hand written registry
 * checks only what the registry lists (L96).
 *
 * So this enumerates the detectors from something the code already HAS to
 * declare: the keys `monitorSetupGates` returns. Every check on the monitor lane
 * that consumes shared setup state is gated there, and being gated is precisely
 * having a legitimate way to conclude nothing. The coverage table is typed on
 * those keys, so `tsc` names a new gate with no entry; this suite is the half
 * that holds at runtime and says WHY an entry is acceptable.
 *
 * What it does NOT enumerate, stated so a green run is not read as more than it
 * measured (L400): monitor steps that do all their own reads and so are not
 * gated (the time off protection check, the lane watchdog) and detectors outside
 * the monitor lane (the Twilio roster sync, the two GitHub workflow proofs). Those
 * carry lanes today because somebody added them, not because anything here
 * required it.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
 *        scripts/test-detector-verdict-registry.ts
 */
import { ALL_SETUP_READ, monitorSetupGates } from "../src/lib/monitor/setup-gates.ts";
import {
  GATED_CHECK_VERDICT_COVERAGE,
  ROSTER_COVERAGE_VERDICT_LANE,
  type DetectorVerdictCoverage,
} from "../src/lib/monitor/verdict-freshness.ts";
import { VERDICT_STALE_BOUNDS_MS } from "../src/lib/monitor/health.ts";
import { assert, eq, finish } from "./lib/harness.ts";

/**
 * Every problem with a coverage table, judged against the detectors the code
 * declares. Empty means every detector is watched or deliberately exempted.
 */
function coverageFindings(
  detectors: string[],
  coverage: Record<string, DetectorVerdictCoverage | undefined>,
  bounds: Record<string, number>,
): string[] {
  const findings: string[] = [];
  const declared = new Set(detectors);
  for (const d of detectors) {
    const entry = coverage[d];
    if (!entry) {
      findings.push(`${d}: a gated monitor check with no verdict lane and no named exemption`);
      continue;
    }
    if ("lane" in entry) {
      if (typeof bounds[entry.lane] !== "number") {
        findings.push(`${d}: names ${entry.lane}, which has no blindness bound, so nothing watches it`);
      }
      continue;
    }
    // A reason must begin with a word and say something, so punctuation or a
    // placeholder cannot stand in for one (L675).
    const reason = "exempt" in entry ? entry.exempt : entry.pending;
    if (!/^[A-Za-z]/.test(reason) || reason.trim().split(/\s+/).length < 8) {
      findings.push(`${d}: its exemption carries no real reason`);
    }
    if ("pending" in entry && !(Number.isInteger(entry.issue) && entry.issue > 0)) {
      findings.push(`${d}: a pending lane must name the issue that adds it`);
    }
  }
  for (const key of Object.keys(coverage)) {
    if (!declared.has(key)) findings.push(`${key}: covers a check the gates no longer declare`);
  }
  return findings;
}

const detectors = Object.keys(monitorSetupGates(ALL_SETUP_READ)).sort();
const shipped = GATED_CHECK_VERDICT_COVERAGE as Record<string, DetectorVerdictCoverage>;

// --- the enumeration found something to judge -------------------------------------
// A gates object that came back empty would make every assertion below vacuous.
assert(detectors.length >= 10, `the gates declare the monitor's gated checks (${detectors.length} found)`);
assert(detectors.includes("rosterCoverage"), "roster coverage is among them");

// --- the shipped table is clean ----------------------------------------------------
{
  const findings = coverageFindings(detectors, shipped, VERDICT_STALE_BOUNDS_MS);
  for (const f of findings) console.error("  ", f);
  eq(findings.length, 0, "every gated monitor check has a verdict lane or a named, reasoned exemption");
  const entry = shipped.rosterCoverage;
  assert(
    entry !== undefined && "lane" in entry && entry.lane === ROSTER_COVERAGE_VERDICT_LANE,
    "roster coverage is watched by verdict:roster-coverage (#1941)",
  );
}

// --- positive controls: the check fails in each way it claims to -----------------
{
  // A detector with no verdict lane. Removing roster coverage's own entry puts the
  // table back to the state #1941 was filed about.
  const removed = { ...shipped };
  delete removed.rosterCoverage;
  const f = coverageFindings(detectors, removed, VERDICT_STALE_BOUNDS_MS);
  assert(
    f.some((x) => x.startsWith("rosterCoverage:") && /no verdict lane/.test(x)),
    "a detector with no verdict lane fails the registry test",
  );

  // A brand new gate nobody added to the table.
  const f2 = coverageFindings([...detectors, "someNewDetector"], shipped, VERDICT_STALE_BOUNDS_MS);
  assert(
    f2.some((x) => x.startsWith("someNewDetector:")),
    "a newly gated check with no entry fails, which is the sixth detector the issue warns about",
  );

  // A lane nothing watches.
  const unbound = { ...VERDICT_STALE_BOUNDS_MS };
  delete unbound[ROSTER_COVERAGE_VERDICT_LANE];
  assert(
    coverageFindings(detectors, shipped, unbound).some((x) => x.startsWith("rosterCoverage:")),
    "a lane with no blindness bound is not coverage",
  );

  // An exemption that gives no reason.
  const lazy = { ...shipped, rosterCoverage: { exempt: "n/a" } };
  assert(
    coverageFindings(detectors, lazy, VERDICT_STALE_BOUNDS_MS).some((x) => /no real reason/.test(x)),
    "an exemption with no reason fails",
  );

  // A pending lane with no issue.
  const orphan = {
    ...shipped,
    rosterCoverage: { pending: "a lane is wanted here and nobody has said who adds it", issue: 0 },
  };
  assert(
    coverageFindings(detectors, orphan, VERDICT_STALE_BOUNDS_MS).some((x) => /name the issue/.test(x)),
    "a pending lane with no issue fails",
  );

  // A stale entry for a check the gates dropped.
  assert(
    coverageFindings(detectors, { ...shipped, goneDetector: { lane: ROSTER_COVERAGE_VERDICT_LANE } }, VERDICT_STALE_BOUNDS_MS)
      .some((x) => x.startsWith("goneDetector:")),
    "an entry for a check the gates no longer declare fails",
  );
}

finish();
