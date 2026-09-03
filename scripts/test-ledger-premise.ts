// The premise the ledger's 3:1 floor was built on is gone (#1830).
//
// I asserted a requirement that does not exist and justified it with reasoning
// that is wrong: "the uncovered letters are functional, not decorative: they
// establish which position is which, so a reader can tell `l M H V u` from
// `L M H v u` without counting". They do not. The COVERED letters are their own
// labels: three dark letters reading M H V say Medium, High, Very High directly,
// and a lone dark L says Low. Nothing is ever counted.
//
// What the faint letters actually carry is the five slot rhythm, so rows align
// and the cell width never varies, plus a sense of the scale's extent. That needs
// them PERCEPTIBLE, not legible, which carries no 3:1 obligation.
//
// It had reached eight places, three more than the issue's own list, so this is
// the check that it cannot survive in a corner somebody missed.
//
// TWO NEARBY PHRASES ARE DELIBERATELY LEFT ALONE, and telling them apart is the
// whole reason this matches an exact claim rather than the word "position".
// `debt-team.ts` and `test-ledger-letters.ts` say two rungs drawing the same
// letter is "unreadable as a position marker", which is about the COVERED letters
// needing to be distinct in order to label themselves. That reasoning is sound
// and is #1817's, not this one's.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-ledger-premise.ts
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { scrubbedGitEnv } from "./lib/git-env.ts";
import { assert, eq, fail, finish } from "./lib/harness.ts";

/** The claims that are wrong, as they were actually written. */
export const RETIRED_PREMISE = [/position is which/i, /position\s+off\b/i];

function tracked(): string[] {
  return execFileSync("git", ["ls-files", "src", "scripts", "DESIGN.md"], {
    encoding: "utf8",
    env: scrubbedGitEnv(),
  })
    .split("\n")
    .filter(Boolean)
    .filter((f) => /\.(tsx?|css|md)$/.test(f))
    // This file has to quote the claim in order to forbid it.
    .filter((f) => f !== "scripts/test-ledger-premise.ts");
}

{
  const hits: string[] = [];
  for (const f of tracked()) {
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const re of RETIRED_PREMISE) {
          if (re.test(line)) hits.push(`${f}:${i + 1} ${line.trim().slice(0, 110)}`);
        }
      });
  }
  if (hits.length === 0) {
    assert(true, "the retired premise appears nowhere in src, scripts or DESIGN.md");
  } else {
    for (const h of hits) fail(`retired premise still recorded at ${h}`);
  }
}

// --- positive controls -----------------------------------------------------
//
// A scan that matched nothing at all would pass the block above.
{
  const hit = (text: string) => RETIRED_PREMISE.some((re) => re.test(text));
  assert(hit("they establish which position is which, so a reader can tell"), "the docstring claim is matched");
  assert(hit("an unfilled mark a reader has to read a position off"), "the DESIGN.md claim is matched");
  assert(hit("useless as a letter somebody has to read a POSITION off"), "and it is case insensitive");
  // The two that must NOT be matched, or the fix would delete sound reasoning.
  assert(
    !hit("two identical letters in fixed positions, which is unreadable as a position marker"),
    "the #1817 claim about COVERED letters being distinct is left alone",
  );
  assert(!hit("the five slot rhythm, so rows align"), "and the replacement reasoning is not caught");
  eq(RETIRED_PREMISE.length, 2, "two phrases, both of which the real files carried");
}

finish();
