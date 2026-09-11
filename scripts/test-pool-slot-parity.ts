// The verdicts `pnpm verify:pool-slot-parity` can reach (#2245), driven through
// hand written samples with no network.
//
// The command asks ONE question of the deployed app: do the codes that share a
// pool offer the same times? That question is answerable at any instant, which
// is what makes it a usable before and after check. A raw before and after diff
// of each code's slots is not: the window walks forward, so the two runs
// legitimately differ and a reader cannot tell that from a regression.
//
// Run: node --experimental-strip-types scripts/test-pool-slot-parity.ts
import {
  judgePoolParity,
  type CodeSample,
  type ComparedPool,
} from "./lib/pool-slot-parity.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const A = ["2026-09-11T14:00:00.000Z", "2026-09-11T14:30:00.000Z"];
const B = ["2026-09-11T15:00:00.000Z"];

const LOW: ComparedPool = { key: "low", codes: ["100", "101", "102", "110", "111", "112"] };
const BEYOND: ComparedPool = { key: "low+beyond", codes: ["120", "121", "122"] };

function slots(codes: string[], value: string[]): Map<string, CodeSample> {
  return new Map(codes.map((code) => [code, { code, kind: "slots", slots: value } as CodeSample]));
}

function merge(...maps: Map<string, CodeSample>[]): Map<string, CodeSample> {
  const out = new Map<string, CodeSample>();
  for (const m of maps) for (const [k, v] of m) out.set(k, v);
  return out;
}

// --- Agreement ---

{
  const v = judgePoolParity([LOW, BEYOND], merge(slots(LOW.codes, A), slots(BEYOND.codes, B)));
  eq(v.outcome, "agree", "codes that share a pool offering the same times agree");
  eq(v.exitCode, 0, "and that is the only outcome that passes");
  eq(v.comparedPools, 2, "it says how many pools it compared");
  eq(v.comparedCodes, 9, "and how many codes, so a silent under-read cannot read as a pass");
}

{
  // Two pools offering the SAME times is not a finding: they are separate pools
  // that happen to have identical availability today, which is ordinary.
  const v = judgePoolParity([LOW, BEYOND], merge(slots(LOW.codes, A), slots(BEYOND.codes, A)));
  eq(v.outcome, "agree", "two different pools offering identical times is not a difference");
}

{
  // Order is not meaning here: the same instants in a different order are the
  // same offer, and demanding an order would report the serialisation.
  const shuffled = new Map(slots(LOW.codes, A));
  shuffled.set("111", { code: "111", kind: "slots", slots: [...A].reverse() });
  const v = judgePoolParity([LOW], shuffled);
  eq(v.outcome, "agree", "the same instants in another order still agree");
}

// --- The finding ---

{
  const differing = new Map(slots(LOW.codes, A));
  differing.set("111", { code: "111", kind: "slots", slots: B });
  const v = judgePoolParity([LOW], differing);
  eq(v.outcome, "slots-differ", "one code offering different times is the finding");
  eq(v.exitCode, 6, "on its own exit code");
  assert(
    v.findings.some((f) => f.includes("111")),
    "and the finding names the code that disagreed",
  );
}

{
  // Ranked above everything else: a genuine difference must name the run even
  // when something else also went wrong, or the real finding is buried.
  const mixed = new Map(slots(LOW.codes, A));
  mixed.set("111", { code: "111", kind: "slots", slots: B });
  mixed.set("112", { code: "112", kind: "no-answer", detail: "connection refused" });
  const v = judgePoolParity([LOW], mixed);
  eq(v.outcome, "slots-differ", "a real difference outranks a failed read");
  assert(v.findings.length >= 2, "while the failed read is still reported");
}

// --- Learning nothing is never a pass (L98) ---

{
  const v = judgePoolParity([], new Map());
  eq(v.outcome, "nothing-compared", "no pools at all is not agreement");
  eq(v.exitCode, 2, "and exits on its own code");
}

{
  // Every pool holding one code means the premise this command exists to check
  // is not present. Reporting "no differences" there would be true and useless.
  const v = judgePoolParity(
    [{ key: "a", codes: ["100"] }, { key: "b", codes: ["200"] }],
    merge(slots(["100"], A), slots(["200"], B)),
  );
  eq(v.outcome, "nothing-compared", "pools of one code each compare nothing");
}

{
  const v = judgePoolParity([LOW], new Map());
  eq(v.outcome, "no-answer", "a pool whose codes were never sampled is not agreement");
  eq(v.exitCode, 3, "and exits as a failed read rather than as nothing to compare");
}

// --- Each way of failing to measure keeps its own code ---

{
  const v = judgePoolParity(
    [LOW],
    merge(slots(LOW.codes.slice(1), A), new Map([["100", { code: "100", kind: "no-answer", detail: "timeout" } as CodeSample]])),
  );
  eq(v.outcome, "no-answer", "the app not answering for a code is its own outcome");
  eq(v.exitCode, 3, "");
}

{
  const v = judgePoolParity(
    [LOW],
    merge(slots(LOW.codes.slice(1), A), new Map([["100", { code: "100", kind: "unreadable", detail: "html" } as CodeSample]])),
  );
  eq(v.outcome, "unreadable", "an unreadable reply is separate from no reply");
  eq(v.exitCode, 4, "");
}

{
  // The landing pages send all sixty codes, so a code that stopped resolving is
  // a broken booking link, not a measurement problem. It outranks both reads.
  const v = judgePoolParity(
    [LOW],
    merge(slots(LOW.codes.slice(1), A), new Map([["100", { code: "100", kind: "not-found" } as CodeSample]])),
  );
  eq(v.outcome, "code-not-found", "a code the app no longer resolves is its own finding");
  eq(v.exitCode, 5, "");
}

{
  // Ranking, stated as one list rather than left to the numbers: the exit code
  // NAMES an outcome and the ranking decides which one names a run.
  const withBoth = merge(
    slots(LOW.codes.slice(2), A),
    new Map([
      ["100", { code: "100", kind: "not-found" } as CodeSample],
      ["101", { code: "101", kind: "no-answer", detail: "timeout" } as CodeSample],
    ]),
  );
  eq(
    judgePoolParity([LOW], withBoth).outcome,
    "code-not-found",
    "a missing code outranks a failed read",
  );
}

// --- A pool still compared even when one of its codes could not be read ---

{
  // Four readable codes that agree, plus one that could not be read, is still a
  // real comparison of four; the run fails on the unread one but says what it
  // did compare, so nobody reads the failure as "nothing was checked".
  const partial = merge(
    slots(["100", "101", "102", "110"], A),
    new Map([["111", { code: "111", kind: "no-answer", detail: "timeout" } as CodeSample]]),
  );
  const pool: ComparedPool = { key: "low", codes: ["100", "101", "102", "110", "111"] };
  const v = judgePoolParity([pool], partial);
  eq(v.comparedCodes, 4, "the readable codes were still compared");
  eq(v.comparedPools, 1, "in one pool");
  eq(v.outcome, "no-answer", "and the unread code still fails the run");
}

finish();
