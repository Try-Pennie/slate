import { DateTime } from "luxon";
import { compareStrings } from "../compare.ts";

/**
 * Pure round-robin / fair-assignment ordering. Pointer-free (no stored
 * `rr_last_assigned_user_id`): each request derives order from a per-request
 * read, so it's concurrency-safe and immune to the reschedule double-count the
 * old rotation had. Assignment is per-bucket equal-share (ADR 0002) — see
 * orderByBucketShare below; ties break deterministically by id so concurrent
 * callers agree.
 */

/**
 * Apply a bucket's fallback: if the matched pool is non-empty use it; otherwise
 * route to the fallback agent when one is set AND eligible (the cal "default
 * route" analog). `fallbackEligible` must be the caller's verdict on whether the
 * fallback agent is currently routable (bookable and not deactivated) — a stored
 * `fallback_user_id` can point at an agent who has since been turned off or
 * offboarded, and we must never hand a booking to such an agent.
 * `fallbackApplied` records which branch was taken (for the routing trace).
 */
export function applyFallback(
  matched: string[],
  fallbackUserId: string | null,
  fallbackEligible: boolean,
): { ids: string[]; fallbackApplied: boolean } {
  if (matched.length > 0) return { ids: matched, fallbackApplied: false };
  if (fallbackUserId && fallbackEligible) return { ids: [fallbackUserId], fallbackApplied: true };
  return { ids: [], fallbackApplied: false };
}

// --- Per-bucket equal-share assignment (#305, ADR 0002) ---

/**
 * The semi-monthly pay-period window [startMs, endMs) the instant `atMs` falls
 * into: fairness "equal share this period" resets on the 15th and 25th, in `tz`
 * (America/New_York — the roster's business timezone). Boundaries are local
 * wall-clock midnight, computed with Luxon so they stay correct across DST (never
 * do ms arithmetic on day numbers). An instant exactly on a boundary belongs to
 * the period that boundary opens. The booking path anchors this on the SLOT's
 * start (so a next-period slot balances against next-period meetings).
 */
export function payPeriod(
  atMs: number,
  tz = "America/New_York",
): { startMs: number; endMs: number } {
  const dt = DateTime.fromMillis(atMs, { zone: tz });
  const at = (year: number, month: number, day: number) =>
    DateTime.fromObject({ year, month, day }, { zone: tz }).startOf("day");
  let start: DateTime;
  let end: DateTime;
  if (dt.day >= 25) {
    start = at(dt.year, dt.month, 25);
    end = start.plus({ months: 1 }).set({ day: 15 }).startOf("day");
  } else if (dt.day >= 15) {
    start = at(dt.year, dt.month, 15);
    end = at(dt.year, dt.month, 25);
  } else {
    end = at(dt.year, dt.month, 15);
    start = end.minus({ months: 1 }).set({ day: 25 }).startOf("day");
  }
  return { startMs: start.toMillis(), endMs: end.toMillis() };
}

/** A candidate's per-bucket standing this period. `seed` shifts the effective
 * count (the new-agent floor; future proration plugs in here too). */
export interface AgentRankInput {
  count: number;
  lastBookedAtMs: number | null;
  seed?: number;
}

/** Per-bucket booking standing reduced from one bucket's bookings over a window
 * spanning the prior period boundary up to the slot's period end. */
export interface BucketShare {
  /** In-period count + newest created_at (the tiebreak), per agent. An optional
   * `seed` (the Phase-2 proration seam) shifts the effective count if present. */
  counts: Record<string, AgentRankInput>;
  /** Agents with a booking in the PRIOR period — established, so not seeded. */
  priorActiveIds: string[];
}

/**
 * Reduce a bucket's bookings read into per-bucket equal-share standing (#305).
 * The read spans [prior-period-start, this-period-end); `currentPeriodStartMs`
 * splits it: rows whose meeting (`starts_at`) is in the current period count
 * toward share; earlier rows only mark the agent established (so a brand-new
 * agent can be told apart from an established-but-quiet one). Rows with a null
 * assignee are skipped. A query error returns `degraded: true` with empty
 * standing so the caller keeps a valid order and alerts (never fails a booking).
 */
export function bucketShareFromResult(
  res: {
    data: { assigned_user_id: string | null; starts_at: string; created_at: string }[] | null;
    error: unknown;
  },
  currentPeriodStartMs: number,
): { counts: BucketShare["counts"]; priorActiveIds: string[]; degraded: boolean } {
  if (res.error) return { counts: {}, priorActiveIds: [], degraded: true };
  const counts: BucketShare["counts"] = {};
  const prior = new Set<string>();
  for (const r of res.data ?? []) {
    if (r.assigned_user_id == null) continue;
    if (Date.parse(r.starts_at) >= currentPeriodStartMs) {
      const made = Date.parse(r.created_at);
      const cur = counts[r.assigned_user_id] ?? { count: 0, lastBookedAtMs: null };
      cur.count += 1;
      if (cur.lastBookedAtMs == null || made > cur.lastBookedAtMs) cur.lastBookedAtMs = made;
      counts[r.assigned_user_id] = cur;
    } else {
      prior.add(r.assigned_user_id);
    }
  }
  return { counts, priorActiveIds: [...prior], degraded: false };
}

/**
 * Order free candidates by per-bucket equal share (#305): fewest in-period
 * bookings first, tie-break least-recently-booked then id. A brand-new-to-the-
 * pool agent (no count this period AND no booking last period) is seeded at the
 * pool's current average so they land mid-pack instead of flooding at 0; an
 * established-but-quiet agent (count 0 but active last period) is NOT seeded and
 * legitimately sorts first. Pure, deterministic, pointer-free.
 */
export function orderByBucketShare(
  candidateIds: string[],
  share: BucketShare,
): string[] {
  const priorActive = new Set(share.priorActiveIds);
  const countOf = (id: string) => share.counts[id]?.count ?? 0;
  const isEstablished = (id: string) => countOf(id) > 0 || priorActive.has(id);

  // Pool average over established candidates (rounded), used to seed newcomers.
  const established = candidateIds.filter(isEstablished);
  const avg =
    established.length > 0
      ? Math.round(established.reduce((s, id) => s + countOf(id), 0) / established.length)
      : 0;

  const effective = (id: string) =>
    countOf(id) + (share.counts[id]?.seed ?? (isEstablished(id) ? 0 : avg));

  return [...candidateIds].sort((a, b) => {
    const ea = effective(a);
    const eb = effective(b);
    if (ea !== eb) return ea - eb;
    const ta = share.counts[a]?.lastBookedAtMs ?? Number.NEGATIVE_INFINITY;
    const tb = share.counts[b]?.lastBookedAtMs ?? Number.NEGATIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return compareStrings(a, b);
  });
}
