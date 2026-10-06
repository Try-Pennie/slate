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
/**
 * The most one `wrangler deploy` may take before it is a failed sample (L110): about
 * 20s measured, so a hung deploy costs one sample rather than the whole job's timeout.
 */
export const COLD_DEPLOY_TIMEOUT_MS = 50_000;

/**
 * The `cold_samples` input: 0 (off) when unset, or a whole number up to the most it
 * takes, written without a leading zero. The workflow stands the cold job down only on
 * the exact strings "0" and "", so "00" read here as off would be a job started for
 * nothing; it is refused by name instead.
 */
export function readColdSamples(raw: string | undefined): { ok: true; n: number } | { ok: false; why: string } {
  if (raw === undefined || raw === "") return { ok: true, n: 0 };
  if (!/^(0|[1-9]\d*)$/.test(raw) || Number(raw) > COLD_SAMPLES_MAX) {
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
 * How far apart any two cold samples' times are held, across every code. Buckets can
 * share an advisor, and the seed offers a 20 minute call on a 10 minute grid, so two
 * neighbouring times can land on one advisor and the later confirm is refused as taken:
 * a reading of a refusal rather than of the confirm path. An hour clears the seed's
 * call and production's call with 10 minutes either side (#2989), the same gap the
 * burst planner holds its moments apart by.
 */
export const COLD_SLOT_GAP_MS = 60 * 60_000;

/**
 * `n` times, taken across the codes in turn so no one bucket is emptied first, and
 * each at least `COLD_SLOT_GAP_MS` from every other one picked, whatever code offered
 * it: buckets can share an advisor, so a time near another sample's would be refused
 * as taken rather than measured. A time that does not parse is never picked. Too few
 * qualifying times is refused with both counts rather than running a shorter leg that
 * reads as the one asked for (L98).
 */
export function chooseColdSlots(
  offered: readonly { code: string; slots: readonly string[] }[],
  n: number,
): { ok: true; slots: ColdSlot[] } | { ok: false; why: string } {
  const picked: (ColdSlot & { ms: number })[] = [];
  for (let round = 0; picked.length < n; round++) {
    let any = false;
    for (const o of offered) {
      const start = o.slots[round];
      if (start === undefined) continue;
      any = true;
      const ms = Date.parse(start);
      if (!Number.isFinite(ms)) continue;
      if (picked.some((p) => Math.abs(p.ms - ms) < COLD_SLOT_GAP_MS)) continue;
      picked.push({ code: o.code, start, ms });
      if (picked.length === n) break;
    }
    if (!any) break;
  }
  if (picked.length < n) {
    return {
      ok: false,
      why: `only ${picked.length} offered times across the codes are ${COLD_SLOT_GAP_MS / 60_000} minutes apart, for ${n} cold samples`,
    };
  }
  return { ok: true, slots: picked.map(({ code, start }) => ({ code, start })) };
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
 * The leg's results file, read three ways that each send a reader somewhere different
 * (L11): absent (the normal state when the leg was not asked for, or never wrote it),
 * read, or there and unusable (truncated, unreadable, or another file's shape). An
 * unusable file is never folded into absent, which would say the results never arrived.
 */
export function readColdResult(
  readText: () => string,
): { kind: "absent" } | { kind: "read"; result: ColdLegResult } | { kind: "unreadable"; why: string } {
  let text: string;
  try {
    text = readText();
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", why: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: "unreadable", why: err instanceof Error ? err.message : String(err) };
  }
  const r = parsed as Partial<ColdLegResult> | null;
  if (r === null || typeof r !== "object" || r.mode !== "cold" || typeof r.planned !== "number" || !Array.isArray(r.attempts)) {
    return { kind: "unreadable", why: "not a cold leg result (no cold mode, planned count and attempts)" };
  }
  return { kind: "read", result: r as ColdLegResult };
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

/** A sample whose deploy made a version and whose confirm got an HTTP answer. */
export function isAnsweredSample(a: ColdAttempt): boolean {
  return a.deployOk && a.status !== null && a.status >= 100;
}

/**
 * What each sample came to, counted once: a deploy that failed, a confirm that got no
 * HTTP answer, or an answer (created or refused). The leg's exit line and the judge's
 * report both read this, so they cannot disagree about one population (L41).
 */
export function coldSampleCounts(result: ColdLegResult): {
  planned: number;
  deployed: number;
  deployFailed: number;
  answered: number;
  created: number;
  noAnswer: number;
} {
  const answeredRows = result.attempts.filter(isAnsweredSample);
  const deployed = result.attempts.filter((a) => a.deployOk).length;
  return {
    planned: result.planned,
    deployed,
    deployFailed: result.attempts.filter((a) => !a.deployOk).length,
    answered: answeredRows.length,
    created: answeredRows.filter((a) => a.outcome === "created").length,
    noAnswer: deployed - answeredRows.length,
  };
}

/**
 * What the leg exits with, and its one line. A sample counts as taken when its deploy
 * made a version and its confirm got an HTTP answer, whatever the answer: a refused
 * confirm still started on a fresh version, so its wait before the profile is still a
 * reading. A failed deploy and a confirm that got no answer each lose a sample, and are
 * named apart because they send a reader to different places (L11).
 *
 * The leg is a diagnostic that never fails the run, so lost samples are reported on the
 * line and the job still passes. Only a leg where no sample got an answer exits 1: it
 * measured nothing, and that must not read as a quiet leg (L98).
 */
export function coldLegOutcome(result: ColdLegResult): { exit: 0 | 1; text: string } {
  const { answered, created, deployFailed, noAnswer } = coldSampleCounts(result);
  const lost = [
    deployFailed > 0 ? `${deployFailed} deploy${deployFailed === 1 ? "" : "s"} failed` : null,
    noAnswer > 0 ? `${noAnswer} confirm${noAnswer === 1 ? "" : "s"} got no answer` : null,
  ].filter((t): t is string => t !== null);
  const text =
    `cold leg: ${answered} of ${result.planned} samples answered after a fresh deploy ` +
    `(${created} created, ${answered - created} refused)` +
    (lost.length > 0 ? `; ${lost.join(", ")}` : "") +
    (answered === 0 ? "; it measured nothing" : "");
  return { exit: answered > 0 ? 0 : 1, text };
}

/** The part of `spawnSync` a deploy uses, so a test can drive the real step. */
export type DeploySpawn = (
  cmd: string,
  args: string[],
  opts: { encoding: "utf8"; maxBuffer: number; timeout: number },
) => { status: number | null; stdout?: string | null; stderr?: string | null; error?: { code?: string; message: string } };

/**
 * One deploy of the load test Worker, keeping the run's recompute arm (`--var` MERGES
 * with env.loadtest's vars block, as the fault leg's deploy does), under its own
 * deadline (L110). A deploy that hits the deadline is a failed sample that SAYS it
 * timed out, apart from one that failed with its own error (L11).
 */
export function makeColdDeploy(deps: {
  arm: string;
  /** wrangler's own binary, as an absolute path, so the leg works from any directory. */
  wranglerBin: string;
  spawn: DeploySpawn;
}): () => Promise<{ ok: boolean; output: string }> {
  return async () => {
    // wrangler's own binary rather than `npx wrangler`: the deadline kills the process
    // it started, and through npx that is only the wrapper (L321).
    const r = deps.spawn(deps.wranglerBin, ["deploy", "--env", "loadtest", "--var", `SLATE_LOADTEST_POST_CONFIRM_RECOMPUTE:${deps.arm}`], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: COLD_DEPLOY_TIMEOUT_MS,
    });
    const timedOut = r.error !== undefined && /ETIMEDOUT/.test(`${r.error.code ?? ""} ${r.error.message}`);
    const output =
      `${r.stdout ?? ""}\n${r.stderr ?? ""}` + (timedOut ? `\nthe deploy did not finish within ${COLD_DEPLOY_TIMEOUT_MS}ms` : "");
    return { ok: r.status === 0, output };
  };
}
