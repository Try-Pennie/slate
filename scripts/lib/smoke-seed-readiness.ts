// Is a test bucket READY to serve, and if not, which of four things is missing
// (#2660)? Pure, so `scripts/test-smoke-seed-readiness.ts` drives every state
// offline; `scripts/seed-smoke-test.ts` does the reads and prints the verdict.
//
// Four states rather than one "not ready", because each sends the person running
// the seed somewhere different (L11): no row means run the seed; a row that is
// not flagged means somebody edited it by hand and it must not be served; no
// member means the seed's membership write failed or somebody removed the agent;
// no slot row means the seed worked and the recompute cron has not published the
// bucket yet, which is the normal state for the first minute after APPLY=1 and
// must not read as a failed seed (red team finding 6).

export type SeedReadinessState = "ready" | "no-bucket" | "not-test" | "no-member" | "no-slots";

/** One exit code per state, so a shell caller can branch on which it met.
 *  Exit 1 is the seed's own crash and is deliberately not reused. */
export const READINESS_EXIT: Record<SeedReadinessState | "nothing-judged", number> = {
  ready: 0,
  "no-bucket": 2,
  "not-test": 5,
  "no-member": 3,
  "no-slots": 4,
  "nothing-judged": 6,
};

/** Worst first: what makes the bucket unservable outranks what merely delays it. */
const SEVERITY: SeedReadinessState[] = ["not-test", "no-bucket", "no-member", "no-slots", "ready"];

export interface SeedReadinessInput {
  code: string;
  /** The bucket row by code, or null when none exists. */
  bucket: { id: string; is_test: boolean } | null;
  /** Active members of that bucket. */
  activeMembers: number;
  /** The published slot row for the code, or null when the recompute has not written one. */
  slotRow: { computed_at: string } | null;
}

export interface SeedReadiness {
  code: string;
  state: SeedReadinessState;
  message: string;
}

export function judgeSeedReadiness(input: SeedReadinessInput): SeedReadiness {
  const { code } = input;
  if (!input.bucket) {
    return {
      code,
      state: "no-bucket",
      message: `${code}: no bucket row. Run the seed with APPLY=1.`,
    };
  }
  if (!input.bucket.is_test) {
    return {
      code,
      state: "not-test",
      message:
        `${code}: the bucket row is NOT flagged is_test, so a booking on it would fire real webhooks. ` +
        `Do not serve it. Re-run the seed with APPLY=1, which writes the flag back.`,
    };
  }
  if (input.activeMembers === 0) {
    return {
      code,
      state: "no-member",
      message: `${code}: the bucket has no active member, so it can offer no times. Re-run the seed with APPLY=1.`,
    };
  }
  if (!input.slotRow) {
    return {
      code,
      state: "no-slots",
      message:
        `${code}: seeded, and the recompute cron has not published its slots yet. ` +
        `Wait one recompute cycle (about a minute) and run this again.`,
    };
  }
  return {
    code,
    state: "ready",
    message: `${code}: ready. Bucket ${input.bucket.id}, ${input.activeMembers} active member(s), slots published at ${input.slotRow.computed_at}.`,
  };
}

/** The sweep's verdict: its worst row, or a refusal when it judged nothing (L98). */
export function worstReadiness(
  rows: SeedReadiness[],
): { state: SeedReadinessState | "nothing-judged"; exit: number } {
  if (rows.length === 0) return { state: "nothing-judged", exit: READINESS_EXIT["nothing-judged"] };
  const worst = [...rows].sort((a, b) => SEVERITY.indexOf(a.state) - SEVERITY.indexOf(b.state))[0]!;
  return { state: worst.state, exit: READINESS_EXIT[worst.state] };
}
