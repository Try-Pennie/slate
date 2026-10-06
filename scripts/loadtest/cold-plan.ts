/**
 * The diagnostic cold leg's pure parts (#3354 item 4).
 *
 * A load run yields about ten confirms that are the first on their isolate, so its
 * cold p95 is its slowest one (`percentiles` takes `s[floor(0.95 n)]`), and one slow
 * confirm decides a run. Under the three run rule Dan chose on 2026-10-06 that is
 * three chances for one slow confirm to fail the set. This leg takes thirty or more
 * cold samples the same way each time, so a change can be judged against a
 * distribution rather than a handful: it deploys a new version, waits for it to
 * settle, and sends ONE confirm, which is that version's first request on whichever
 * isolate serves it. Not a bar: the judge reports it and fails nothing on it.
 *
 * The slots are read once, before the first deploy, because any request to a new
 * version ahead of its confirm would start that version's isolate and the confirm
 * would no longer be its first.
 */

/** How many cold samples the plan asked for (#3354): enough for a p95 that is not the max. */
export const COLD_SAMPLES_TARGET = 30;
/**
 * The most one run takes. Thirty is the target, and thirty is also what fits in the
 * 60 minutes `scripts/test-workflow-timeouts.ts` holds every job to, beside the setup.
 */
export const COLD_SAMPLES_MAX = 30;
/**
 * Each sample's share of the job: a deploy (about 20s, measured on run 37390071571's
 * fault leg), the settle, and one confirm under its 30s request timeout, with room.
 */
export const COLD_SAMPLE_SECONDS = 90;
/** Checkout, install, one build (about 70s on that run), the tail connecting and its last lines flushing. */
export const COLD_JOB_SETUP_MINUTES = 10;
/** How long after a deploy returns before its confirm is sent, so the new version is the one serving. */
export const COLD_SETTLE_MS = 8_000;

/** The `cold_samples` input: 0 (off) when unset, or a whole number up to the most it takes. */
export function readColdSamples(raw: string | undefined): { ok: true; n: number } | { ok: false; why: string } {
  if (raw === undefined || raw === "") return { ok: true, n: 0 };
  if (!/^\d+$/.test(raw) || Number(raw) > COLD_SAMPLES_MAX) {
    return { ok: false, why: `cold_samples ${JSON.stringify(raw)} is not a whole number from 0 to ${COLD_SAMPLES_MAX}` };
  }
  return { ok: true, n: Number(raw) };
}

/** The cold job's `timeout-minutes`, derived so a longer leg is never cut short (L313). */
export function coldJobTimeoutMinutes(n: number): number {
  return COLD_JOB_SETUP_MINUTES + Math.ceil((n * COLD_SAMPLE_SECONDS) / 60);
}

/**
 * The version a `wrangler deploy` made, from its own `Current Version ID` line, or
 * null when the output carried none. Kept per sample, so the judge can say how many
 * confirms the version just deployed actually served.
 */
export function deployedVersionOf(stdout: string): string | null {
  const m = /Current Version ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(stdout);
  return m ? m[1]!.toLowerCase() : null;
}

/** One time to book, and the code that offered it. */
export interface ColdSlot {
  code: string;
  start: string;
}

/**
 * `n` distinct times, taken across the codes in turn so no one bucket is emptied
 * first. Fewer offered times than samples is refused with both counts rather than
 * running a shorter leg that reads as the one asked for (L98).
 */
export function chooseColdSlots(
  offered: readonly { code: string; slots: readonly string[] }[],
  n: number,
): { ok: true; slots: ColdSlot[] } | { ok: false; why: string } {
  const picked: ColdSlot[] = [];
  const seen = new Set<string>();
  for (let round = 0; picked.length < n; round++) {
    let any = false;
    for (const o of offered) {
      const start = o.slots[round];
      if (start === undefined) continue;
      any = true;
      const key = `${o.code}@${start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push({ code: o.code, start });
      if (picked.length === n) break;
    }
    if (!any) break;
  }
  if (picked.length < n) {
    return { ok: false, why: `only ${picked.length} offered times across the codes, for ${n} cold samples` };
  }
  return { ok: true, slots: picked };
}

/** One sample: the deploy, the version it made, and its one confirm's answer. */
export interface ColdAttempt {
  i: number;
  slot: ColdSlot;
  deployOk: boolean;
  /** The version the deploy reported, or null when it failed or reported none. */
  version: string | null;
  /** When the confirm was sent, or null when no confirm was (its deploy failed). */
  sentAtMs: number | null;
  status: number | null;
  outcome: string | null;
}

/** What the leg leaves for the judge (`results/cold-0.json`). */
export interface ColdLegResult {
  mode: "cold";
  planned: number;
  attempts: ColdAttempt[];
}

/**
 * The leg: read every code's offered times ONCE, then for each sample deploy, settle,
 * and send one confirm. Nothing else reaches a new version between its deploy and its
 * confirm, so the confirm is that version's first request. A failed deploy sends no
 * confirm, because one sent then would land on the old version and read warm; it is
 * recorded and the leg carries on. Too few offered times refuses before any deploy.
 */
export async function runColdLeg(deps: {
  n: number;
  codes: readonly string[];
  readSlots: (code: string) => Promise<string[]>;
  deploy: () => Promise<{ ok: boolean; output: string }>;
  sleep: (ms: number) => Promise<void>;
  confirm: (slot: ColdSlot, i: number) => Promise<{ status: number; outcome: string | null }>;
  now: () => number;
}): Promise<{ ok: true; result: ColdLegResult } | { ok: false; why: string }> {
  const offered: { code: string; slots: string[] }[] = [];
  for (const code of deps.codes) offered.push({ code, slots: await deps.readSlots(code) });
  const picked = chooseColdSlots(offered, deps.n);
  if (!picked.ok) return { ok: false, why: picked.why };
  const attempts: ColdAttempt[] = [];
  for (let i = 1; i <= deps.n; i++) {
    const slot = picked.slots[i - 1]!;
    const d = await deps.deploy();
    if (!d.ok) {
      attempts.push({ i, slot, deployOk: false, version: null, sentAtMs: null, status: null, outcome: null });
      continue;
    }
    await deps.sleep(COLD_SETTLE_MS);
    const sentAtMs = deps.now();
    const answer = await deps.confirm(slot, i);
    attempts.push({ i, slot, deployOk: true, version: deployedVersionOf(d.output), sentAtMs, status: answer.status, outcome: answer.outcome });
  }
  return { ok: true, result: { mode: "cold", planned: deps.n, attempts } };
}
