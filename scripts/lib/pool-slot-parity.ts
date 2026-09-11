/**
 * The verdict for `pnpm verify:pool-slot-parity` (#2245).
 *
 * The question is deliberately NOT "do today's slots match yesterday's". The
 * booking window walks forward with the clock, so a before and after diff of one
 * code's times differs for reasons nobody should fix, and a reader cannot
 * separate that from a regression (the same trap #1754 hit).
 *
 * The question this asks holds at any instant: **do the codes that share a pool
 * offer the same times?** It has to pass BEFORE the change, which is what proves
 * the premise that sixty codes were already producing fifteen answers, and after
 * it, which is what proves the pooled write did not put one pool's times under
 * another pool's code.
 *
 * Pure, so every verdict is driven offline by `scripts/test-pool-slot-parity.ts`
 * where no deployment exists.
 */

/** What the deployed app said about one bucket code. */
export type CodeSample =
  | { code: string; kind: "slots"; slots: string[] }
  /** The app resolved no such bucket. The landing pages send all sixty codes, so
   *  this is a broken booking link rather than a measurement problem. */
  | { code: string; kind: "not-found" }
  | { code: string; kind: "no-answer"; detail: string }
  | { code: string; kind: "unreadable"; detail: string };

export interface ComparedPool {
  key: string;
  codes: string[];
}

export type PoolParityOutcome =
  | "agree"
  | "nothing-compared"
  | "no-answer"
  | "unreadable"
  | "code-not-found"
  | "slots-differ";

export interface PoolParityVerdict {
  outcome: PoolParityOutcome;
  exitCode: number;
  /** Pools in which at least two codes were readable and compared. */
  comparedPools: number;
  /** Readable codes that took part in a comparison. Reported because zero is the
   *  shape of a broken read and never a healthy roster (L98). */
  comparedCodes: number;
  findings: string[];
}

/**
 * Worst first. Written out as one list rather than inferred from the exit
 * numbers, because the exit code NAMES an outcome and the rank decides which
 * outcome names the run: two different questions.
 *
 * A real difference outranks everything, so one unreadable code cannot bury it.
 * A code the app no longer resolves outranks both read failures, because it is a
 * finding about the product rather than about the measurement.
 */
const RANK: PoolParityOutcome[] = [
  "slots-differ",
  "code-not-found",
  "unreadable",
  "no-answer",
  "nothing-compared",
  "agree",
];

const EXIT: Record<PoolParityOutcome, number> = {
  agree: 0,
  "nothing-compared": 2,
  "no-answer": 3,
  unreadable: 4,
  "code-not-found": 5,
  "slots-differ": 6,
};

export function judgePoolParity(
  pools: ComparedPool[],
  samples: Map<string, CodeSample>,
): PoolParityVerdict {
  const findings: string[] = [];
  const met = new Set<PoolParityOutcome>();
  let comparedPools = 0;
  let comparedCodes = 0;

  for (const pool of pools) {
    const readable: { code: string; slots: string[] }[] = [];
    for (const code of pool.codes) {
      const sample = samples.get(code);
      if (!sample) {
        met.add("no-answer");
        findings.push(`${code}: never sampled`);
        continue;
      }
      if (sample.kind === "slots") {
        readable.push({ code, slots: sample.slots });
        continue;
      }
      if (sample.kind === "not-found") {
        met.add("code-not-found");
        findings.push(`${code}: the app resolves no such bucket`);
        continue;
      }
      met.add(sample.kind);
      findings.push(`${code}: ${sample.kind} (${sample.detail})`);
    }

    if (readable.length < 2) continue;
    comparedPools++;
    comparedCodes += readable.length;

    // Sorted before comparing: the same instants in another order are the same
    // offer, and demanding an order would be reporting the serialisation.
    const reference = readable[0]!;
    const referenceKey = [...reference.slots].sort().join(",");
    for (const other of readable.slice(1)) {
      if ([...other.slots].sort().join(",") === referenceKey) continue;
      met.add("slots-differ");
      findings.push(
        `${other.code} offers ${other.slots.length} times where ${reference.code} offers ` +
          `${reference.slots.length}, and they share a pool`,
      );
    }
  }

  // Comparing nothing is never agreement (L98). It is its own outcome, because
  // "sixty codes agree" and "no two codes were ever compared" render the same in
  // a passing run and mean opposite things.
  if (comparedPools === 0) met.add("nothing-compared");

  const outcome = RANK.find((o) => met.has(o)) ?? "agree";
  return { outcome, exitCode: EXIT[outcome], comparedPools, comparedCodes, findings };
}
