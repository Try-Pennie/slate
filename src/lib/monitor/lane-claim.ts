/**
 * A scheduled cron lane's claim on its tick (#4222), so a lane sent twice runs once.
 *
 * WHY. The Worker's dispatcher (`worker/lane-run.ts`) never re-runs a lane whose
 * request REJECTED, because the lane may have run part way and a second run can double
 * a write. The relay that places lanes near the database (#4189) fails exactly that
 * way, as a rejected Durable Object call, and Dan decided a relay failure falls back to
 * today's route and never skips a run. So re-running has to be safe, rather than proof
 * that a lane did not run.
 *
 * HOW. Every scheduled lane route claims `(tick id, lane)` in `lane_runs` before any
 * work. The table's primary key is on both, so of any number of deliveries of one lane
 * for one tick, sequential or concurrent, exactly one insert succeeds and runs the lane;
 * every other one is told the key is taken (Postgres 23505) and answers 200 with
 * `x-slate-lane-not-run: duplicate`, doing nothing. Nothing here reads before it writes,
 * so no ordering in application code is relied on: the constraint decides.
 *
 * What each outcome means:
 * - A lane that crashed AFTER claiming is not run again by a re-send of that tick. The
 *   next tick claims a new id and runs it, and the lane's lease and heartbeat watchdog
 *   already cover a lane that stopped part way. Skipping one tick's re-send is the
 *   safe direction; running a half finished lane twice is not.
 * - A claim that cannot be read (the table missing, locked or slow, a timeout, the
 *   network) is neither "claimed" nor "taken", and what happens depends on whether
 *   this is the tick's FIRST delivery of the lane:
 *     A first delivery RUNS the lane anyway, marked `claim: "unreadable"` so the route
 *     logs it on the lane's line. Dan decided 2026-10-26: run anyway, one alert. Failing
 *     closed made lane_runs a single point of failure, since one missing, locked or slow
 *     table would stop all 28 lanes at once and page once per lane, and the rule is
 *     never skip a run. A first delivery is today's only delivery, so running it
 *     unclaimed is exactly how every lane ran before this table existed. The one alert
 *     is the monitor lane's (`lane-claim-health.ts`), never the lanes'.
 *     A RE-SEND (`LANE_RESEND_HEADER` present, with any value) runs NOTHING and answers
 *     503, so the dispatcher reports it as failed. A re-send exists because a first
 *     delivery may already have run, so an unprotected re-send is the one case that
 *     could run a lane twice. The marker is read only behind the cron secret (the
 *     claim runs after it), and it can only make a delivery stricter, so a caller who
 *     sends it gains nothing. The dispatcher will set it when it starts re-sending
 *     (#4189, phase 4); nothing sets it yet.
 * - No tick id at all is a hand run with the cron secret, never the dispatcher, which
 *   stamps every lane request (`scripts/test-cron-lane-run.ts`). It runs unclaimed, as
 *   every lane ran before this. A tick id that does not read as one we mint runs
 *   nothing, and neither does a re-send with no tick id, which could never be claimed.
 *
 * Pure apart from the injected store, so `scripts/test-lane-claim.ts` drives it; the
 * route glue is `src/lib/cron-lane-claim.ts`.
 */
import { LANE_NOT_RUN_HEADER, parseTickId } from "./lane-failure.ts";
import { laneFieldName } from "./lane-timing.ts";

/** Why a lane answered without running, as its not-run header says it. */
export type LaneClaimRefusal = "duplicate" | "claim_unreadable" | "tick_unreadable";

/**
 * Where claims are recorded. `claim` resolves "claimed" when this call recorded the
 * key, "taken" when the key was already recorded, and THROWS when it cannot tell.
 */
export interface LaneClaimStore {
  claim(tickId: string, lane: string): Promise<"claimed" | "taken">;
}

/**
 * How a lane that RUNS stands with its tick: `claimed` (this delivery holds the claim),
 * `unclaimed` (no tick id: a hand run), or `unreadable` (a first delivery whose claim
 * could not be read, running unprotected and logged).
 */
export type LaneClaimStanding = "claimed" | "unclaimed" | "unreadable";

export type LaneClaim =
  | { run: true; lane: string; tickId: string | null; claim: LaneClaimStanding; error?: unknown }
  | { run: false; lane: string; tickId: string | null; refusal: LaneClaimRefusal; error?: unknown };

/**
 * Claim `path`'s lane for the tick named by `tickHeader` (the raw `TICK_ID_HEADER`
 * value, null when absent). `resendHeader` is the raw `LANE_RESEND_HEADER` value: any
 * value at all, the empty string included, makes this delivery a re-send. Never throws:
 * a store failure is kept as the error, beside a run on a first delivery and beside the
 * `claim_unreadable` refusal on a re-send.
 */
export async function claimLane(
  tickHeader: string | null,
  path: string,
  store: LaneClaimStore,
  resendHeader: string | null = null,
): Promise<LaneClaim> {
  const lane = laneFieldName(path);
  const resend = resendHeader !== null;
  if (tickHeader === null) {
    if (resend) return { run: false, lane, tickId: null, refusal: "tick_unreadable" };
    return { run: true, lane, tickId: null, claim: "unclaimed" };
  }
  const tickId = parseTickId(tickHeader);
  if (tickId === null) return { run: false, lane, tickId: null, refusal: "tick_unreadable" };
  try {
    const outcome = await store.claim(tickId, lane);
    if (outcome === "claimed") return { run: true, lane, tickId, claim: "claimed" };
    return { run: false, lane, tickId, refusal: "duplicate" };
  } catch (error) {
    if (resend) return { run: false, lane, tickId, refusal: "claim_unreadable", error };
    return { run: true, lane, tickId, claim: "unreadable", error };
  }
}

/** What a refused claim answers. A duplicate is 200: the tick's lane did run, once. */
export interface LaneClaimAnswer {
  status: 200 | 400 | 503;
  notRun: LaneClaimRefusal;
  headers: Record<string, string>;
  body: Record<string, string>;
}

const STATUS: Record<LaneClaimRefusal, 200 | 400 | 503> = {
  duplicate: 200,
  tick_unreadable: 400,
  claim_unreadable: 503,
};

const BODY: Record<LaneClaimRefusal, (claim: LaneClaim) => Record<string, string>> = {
  duplicate: (c) => ({ skipped: "duplicate", lane: c.lane, tick: c.tickId ?? "" }),
  tick_unreadable: (c) => ({ error: "the tick id is not one the dispatcher mints", lane: c.lane }),
  claim_unreadable: (c) => ({ error: "the lane's claim on its tick could not be read", lane: c.lane }),
};

/** The answer for a claim that does not run the lane, or null when it runs. */
export function laneClaimAnswer(claim: LaneClaim): LaneClaimAnswer | null {
  if (claim.run) return null;
  return {
    status: STATUS[claim.refusal],
    notRun: claim.refusal,
    headers: { [LANE_NOT_RUN_HEADER]: claim.refusal },
    body: BODY[claim.refusal](claim),
  };
}

/** Postgres's unique violation: the one error that means "already claimed". */
export const UNIQUE_VIOLATION = "23505";

/** What the insert answers, as supabase-js resolves it. */
export type LaneRunInsert = (row: { tick_id: string; lane: string }) => Promise<{
  error: { code?: string; message: string } | null;
}>;

/**
 * The store over `lane_runs`. A plain insert, never an upsert or a read first: the
 * primary key alone decides who claimed, and only 23505 reads as taken. Any other
 * error, an error with no code, or a rejected call throws, which `claimLane` turns
 * into the refusal that runs nothing.
 */
export function laneRunStore(insert: LaneRunInsert): LaneClaimStore {
  return {
    async claim(tickId, lane) {
      const { error } = await insert({ tick_id: tickId, lane });
      if (!error) return "claimed";
      if (error.code === UNIQUE_VIOLATION) return "taken";
      throw new Error(`lane_runs claim failed: ${error.code ?? "no code"} ${error.message}`);
    },
  };
}

/**
 * How long a claim is kept. A re-send arrives within the tick it belongs to (seconds,
 * at most the dispatcher's deadline), so the claim only has to outlive that; two days
 * keeps a weekend morning's question "was that tick's lane sent twice" answerable from
 * the table as well as the logs. About 7,600 rows a day at today's schedule (5,760 of them the every minute lanes).
 */
export const LANE_RUN_RETENTION_DAYS = 2;

const DAY_MS = 24 * 60 * 60_000;

/** Claims made strictly before this instant are deleted. */
export function laneRunCutoffIso(nowMs: number): string {
  return new Date(nowMs - LANE_RUN_RETENTION_DAYS * DAY_MS).toISOString();
}

export interface LaneRunPruneDeps {
  nowMs: number;
  /** Deletes claims with `claimed_at` before the cutoff and returns how many. THROWS on a
   *  database error: a failed delete scored as zero reads as nothing to clean (#1165). */
  deleteClaimedBefore: (cutoffIso: string) => Promise<number>;
}

export async function pruneLaneRuns(deps: LaneRunPruneDeps): Promise<{ deleted: number; cutoff: string }> {
  const cutoff = laneRunCutoffIso(deps.nowMs);
  const deleted = await deps.deleteClaimedBefore(cutoff);
  return { deleted, cutoff };
}
