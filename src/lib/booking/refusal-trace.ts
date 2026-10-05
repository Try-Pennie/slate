/**
 * Where a refused confirm was refused, and what it asked for (#3272).
 *
 * On 2026-10-04 twenty three confirms were refused in seventy five minutes and not
 * one could be traced to the instant its lead picked, so no failure could be
 * reproduced. A refusal now carries a trace from the point it is thrown: the
 * requested instant and bucket, which stage refused it, and per rung how many
 * advisors each stage left, so "nobody free in the cache" and "Google said everyone
 * was busy" can never be read as one another.
 *
 * The trace rides on the thrown error rather than through a return value, because a
 * refusal leaves through several layers (the tier ladder, the confirm line, the
 * route) and every one of them must keep answering the same 409 or 503 it did. It
 * carries counts and bucket codes; the one fact about the lead is its Salesforce
 * lead id, which is an external id and safe to store (#3276 counts people by it).
 */
import { isLeadId, leadIdKey } from "@/lib/salesforce/lead-xbc";


/**
 * Every stage a confirm can be refused at.
 *
 * - `pool_empty`: the bucket resolved to nobody at all.
 * - `candidate_read_empty`: people exist and the cached availability read found
 *   none of them free (the slot rule, hours, buffers, daily cap, holds).
 * - `verify_busy`: candidates were read free and live Google found every one busy.
 * - `verify_unreadable`: live Google could not answer for at least one candidate and
 *   nobody it could answer for was free.
 * - `race_lost`: an advisor was free, the insert lost the overlap race, and nobody
 *   after them in the rung could be booked instead.
 * - `follower`: a confirm waiting in the slot's line was answered from the verdict of
 *   the confirm ahead of it, without running any of the above itself.
 *
 * Being claimed by another confirm in the line is NOT a stage: when every candidate
 * is claimed, none is left out (`claimFromLine`), so it can never refuse by itself.
 * It is counted per rung (`claimed`) instead.
 */
export const REFUSAL_STAGES = [
  "pool_empty",
  "candidate_read_empty",
  "verify_busy",
  "verify_unreadable",
  "race_lost",
  "follower",
] as const;
export type RefusalStage = (typeof REFUSAL_STAGES)[number];

/**
 * The stages a routing decision row carries (migration 0168's check). A follower
 * writes no row: it never resolved a pool, and a bucket read plus an insert for
 * every one of a crowd waiting behind a full slot would put back on the line the
 * load it exists to keep off it. It is on the confirm line instead.
 */
export type RecordedRefusalStage = Exclude<RefusalStage, "follower">;
export const RECORDED_REFUSAL_STAGES: readonly RecordedRefusalStage[] = REFUSAL_STAGES.filter(
  (s): s is RecordedRefusalStage => s !== "follower",
);

/** What one rung of the tier ladder did with this confirm. Null is "not reached". */
export interface RungTrace {
  code: string;
  /** Advisors in the rung's pool, before any availability. */
  members: number | null;
  /** Advisors the cached availability read as free. */
  read: number | null;
  /** Of those, how many another confirm in the line had already claimed. */
  claimed: number | null;
  /** Advisors sent to the live Google check. */
  checked: number | null;
  stage: RefusalStage;
  /** The free ids the read returned, for the routing decision's considered set. Not logged or stored. */
  readIds?: string[];
}

export interface RefusalTrace {
  requestedStart: string | null;
  bucketCode: string | null;
  stage: RefusalStage;
  rungs: RungTrace[];
  /** On a follower: what the confirm ahead of it was refused as. */
  leaderRefusal?: "taken" | "race";
  /** On a lost race: how many advisors this confirm lost in a row. */
  lostRaces?: number;
  /** The refused lead (`refusedLeadId`), so the log line counts people too (#3276). */
  leadId?: string | null;
}

const TRACE = Symbol.for("slate.refusalTrace");
const RUNG = Symbol.for("slate.refusalRung");

/** Attach a trace to an error and hand the error back, so `throw traced(err, t)` reads naturally. */
export function traced<E>(err: E, trace: RefusalTrace): E {
  if (err !== null && typeof err === "object") (err as Record<symbol, unknown>)[TRACE] = trace;
  return err;
}

/** The trace a refusal carries, or null when it was thrown without one. */
export function refusalTraceOf(err: unknown): RefusalTrace | null {
  if (err === null || typeof err !== "object") return null;
  return ((err as Record<symbol, unknown>)[TRACE] as RefusalTrace | undefined) ?? null;
}

/** Attach one rung's trace, for the tier ladder to collect. */
export function withRung<E>(err: E, rung: RungTrace): E {
  if (err !== null && typeof err === "object") (err as Record<symbol, unknown>)[RUNG] = rung;
  return err;
}

export function rungOf(err: unknown): RungTrace | null {
  if (err === null || typeof err !== "object") return null;
  return ((err as Record<symbol, unknown>)[RUNG] as RungTrace | undefined) ?? null;
}

/**
 * The stage one rung refused at, from what it saw. Pure, so the order is decided in
 * one place: an empty pool, then an empty read, then Google.
 */
export function rungStage(r: { members: number; read: number; anyUnverified: boolean }): RefusalStage {
  if (r.members === 0) return "pool_empty";
  if (r.read === 0) return "candidate_read_empty";
  return r.anyUnverified ? "verify_unreadable" : "verify_busy";
}

/**
 * The stage a whole ladder refused at: the furthest any rung got. A lead refused
 * after Google found three rungs' advisors busy was refused by Google, whatever an
 * empty fourth rung said, and that is the fact a reader chasing the refusal needs.
 */
export function ladderStage(rungs: RungTrace[]): RefusalStage {
  const order: RefusalStage[] = ["pool_empty", "candidate_read_empty", "verify_busy", "verify_unreadable"];
  let best = -1;
  for (const r of rungs) best = Math.max(best, order.indexOf(r.stage));
  return best < 0 ? "pool_empty" : order[best];
}

/** One rung as stored and logged: counts only. */
export function rungCounts(r: RungTrace): Omit<RungTrace, "readIds"> {
  return { code: r.code, members: r.members, read: r.read, claimed: r.claimed, checked: r.checked, stage: r.stage };
}

const n = (v: number | null) => (v === null ? "-" : String(v));

/**
 * The fields the `confirm answered` line carries for a refusal. `stage_counts` is one
 * token per rung, `code:members/read/claimed/checked`, so a whole ladder fits a log
 * line and reads in order.
 */
export function refusalLogFields(t: RefusalTrace): Record<string, string | number> {
  const out: Record<string, string | number> = { refusal_stage: t.stage };
  if (t.requestedStart) out.requested_start = t.requestedStart;
  if (t.bucketCode) out.bucket_code = t.bucketCode;
  if (t.rungs.length > 0) {
    out.stage_counts = t.rungs
      .map((r) => `${r.code}:${n(r.members)}/${n(r.read)}/${n(r.claimed)}/${n(r.checked)}`)
      .join(",");
  }
  if (t.leaderRefusal) out.leader_refusal = t.leaderRefusal;
  if (t.lostRaces !== undefined) out.lost_races = t.lostRaces;
  if (t.leadId) out.lead_id = t.leadId;
  return out;
}

/**
 * The refused lead, as the key distinct people are counted by (#3276): the 15
 * character form of whichever Salesforce lead id the request carried, checked as a
 * lead id first. The embed carries it as `salesforceId`; a direct API caller may
 * send it as `externalId`. The 15 character form is what both the 15 and the 18
 * character spellings of one lead share, so one person never counts twice. Null
 * when the request named no lead, which is said rather than guessed.
 */
export function refusedLeadId(person: { salesforceId?: string | null; externalId?: string | null }): string | null {
  for (const id of [person.salesforceId, person.externalId]) {
    const v = id?.trim();
    if (v && isLeadId(v)) return leadIdKey(v);
  }
  return null;
}
