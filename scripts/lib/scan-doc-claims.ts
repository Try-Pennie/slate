// #2398: the documents this repo auto loads state measured numbers by hand, and
// four of them were wrong on the day the issue was filed. The suite count was
// given three different ways in two files and every one was wrong; the scripts
// typecheck error count was off by nearly three to one; the lead facing copy
// count was off by two to one.
//
// The distinction this scanner draws, and the reason it is a REFUSAL rather than
// a comparison: a number describing the repo's OWN TREE is re-derivable by a
// command anybody can run, so writing it out by hand creates a second copy that
// drifts the moment a file is added, and nothing ever re-runs the command. A
// number describing a MEASUREMENT OF THE WORLD (the gate takes about 40s, about
// 25,000 leads were routed in 30 days) cannot be re-derived from the tree, so it
// stays, carrying its own date and issue.
//
// A check that compared the stated number against the real one would keep the
// number and make the sentence beside it more trusted for passing (L210), and
// would go red on every added test file until somebody edited prose. Refusing
// the hand count outright leaves nothing to drift.

export interface DocClaimFinding {
  file: string;
  line: number;
  text: string;
  /** The rule the line broke, in the words a reader needs. */
  reason: string;
}

export interface ForbiddenClaim {
  pattern: RegExp;
  reason: string;
}

/**
 * Each entry names a count of the repo's own tree that a command already prints,
 * and says which command, so the remedy is in the failure rather than in a wiki.
 */
export const FORBIDDEN_CLAIMS: ForbiddenClaim[] = [
  {
    pattern: /\b[\d,]+\s+node\s+(?:test\s+|script\s+)?suites\b/i,
    reason:
      "the node suite count is printed by `pnpm test:node` on its own last line; say \"the node suites\" instead",
  },
  {
    pattern: /\b(?:roughly|about|~)\s*[\d,]+\s+errors\b/i,
    reason:
      "the scripts typecheck error count is printed by `npx tsc -p tsconfig.scripts.json --noEmit`; say \"the errors the tree carries\" instead",
  },
  {
    pattern: /\b[\d,]+\s+lines\s+across\s+[\d,]+\s+screens\b/i,
    reason:
      "the lead facing copy count is printed by `pnpm preview:booker` on its own last line; do not restate it",
  },
  {
    pattern: /\b(?:about|roughly)\s+\S+\s+dozen\s+repo\s+invariant\s+guards\b/i,
    reason:
      "the repo invariant guard count is `ls scripts/test-*.ts`; say \"the repo invariant guards\" instead",
  },
];

/**
 * Scan one document's text. Pure, so the guard can drive it over fixtures.
 *
 * Every claim is tested against the line AND against that line joined to the
 * next one, because these files are hard wrapped at about 80 columns and the
 * counts that had drifted sat across the break: "~120 node script / suites" and
 * "(68 / lines across 13 screens)" are both invisible to a per line match, which
 * is the first version of this scanner reporting a clean tree over two of the
 * four instances it was written for (L278).
 */
export function scanDocClaims(
  file: string,
  text: string,
  claims: ForbiddenClaim[] = FORBIDDEN_CLAIMS,
): DocClaimFinding[] {
  const findings: DocClaimFinding[] = [];
  const lines = text.split("\n");
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    const joined = line + " " + (lines[i + 1] ?? "");
    for (const claim of claims) {
      const hit = claim.pattern.test(line) || claim.pattern.test(joined);
      if (!hit) continue;
      const key = `${file}:${i + 1}:${claim.reason}`;
      const prev = `${file}:${i}:${claim.reason}`;
      // A wrapped claim matches on the line before it too; report it once.
      if (seen.has(key) || seen.has(prev)) continue;
      seen.add(key);
      findings.push({ file, line: i + 1, text: line.trim(), reason: claim.reason });
    }
  });
  return findings;
}
