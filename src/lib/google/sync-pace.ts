/**
 * Pure helpers for pacing the every-minute backstop sync cron across a large
 * agent roster (#238). The cron is a backstop + watch renewer (real-time
 * freshness comes from Google push), so it bounds its own work per tick and
 * rotates least-recently-synced agents first instead of re-processing the same
 * head of the list every minute. Exercised by scripts/test-sync-pace.ts and
 * scripts/test-sync-agents.ts.
 */

/** Cap on brand-new agents onboarded (first watch setup) per cron tick. */
export const MAX_ONBOARDS_PER_TICK = 10;

/**
 * How many agents the sync lane processes concurrently (#242). Sequential
 * per-agent Google I/O blew the per-tick budget well before 200 agents; a
 * bounded pool fits far more agents per tick. Kept small so the peak
 * subrequest count (cap × per-agent Google+DB calls) stays well under the
 * Worker ceiling — the real ceiling is proven in the 200-agent load test.
 */
export const SYNC_CONCURRENCY = 8;

/**
 * Max agents the sync lane processes per tick (#273 Inc 5). Caps the TOTAL
 * outbound calls in one Worker invocation: at 200 agents the lane otherwise
 * processes the whole roster in a single tick (~5 subrequests/agent ≈ 1000),
 * up against Cloudflare's ~1000-subrequest-per-invocation ceiling. Capping +
 * rotation (least-recently-synced first) drains the roster across a few ticks
 * instead — the backstop only needs each agent covered every couple of minutes
 * (real-time freshness comes from Google push). Distinct from SYNC_CONCURRENCY
 * (how many run at once); this bounds how many run total per tick.
 */
export const MAX_AGENTS_PER_SYNC_TICK = 100;

export interface SyncAgent {
  userId: string;
  /** Whether the agent already has agent_calendars rows (DB-only check). */
  hasCalendars: boolean;
  /** users.last_synced_at as epoch ms, or null if never synced by the cron. */
  lastSyncedMs: number | null;
}

/** A users row as loaded for sync candidacy (bookable pool). */
export interface SyncCandidateRow {
  id: string;
  last_synced_at: string | null;
  deactivated_at: string | null;
}

/**
 * Shape the bookable-user rows into per-tick pacing facts, dropping any
 * deactivated user (#274) so the sync/watch loop never touches an offboarded
 * account. The query already filters `deactivated_at IS NULL`; re-checking
 * here is belt-and-braces and the node-testable seam. The `deactivated_at ==
 * null` predicate mirrors isActive() but is kept inline so this stays a
 * dependency-free pure module (cf. offboarding/plan.ts).
 */
export function toSyncAgents(
  rows: SyncCandidateRow[],
  calendarUserIds: Set<string>,
): SyncAgent[] {
  return rows
    .filter((r) => r.deactivated_at == null)
    .map((r) => ({
      userId: r.id,
      hasCalendars: calendarUserIds.has(r.id),
      lastSyncedMs: r.last_synced_at ? Date.parse(r.last_synced_at) : null,
    }));
}

/**
 * True while the tick still has budget. A null deadline means "unbounded"
 * (used by callers that pass no budget) and always returns true. The positive
 * form the cron loop guards on; inverse of sync-coalesce.ts pastDeadline.
 */
export function withinBudget(nowMs: number, deadlineMs: number | null): boolean {
  return deadlineMs === null || nowMs < deadlineMs;
}

/**
 * Least-recently-synced first: never-synced agents (lastSyncedMs null) lead,
 * then ascending lastSyncedMs. Stable within each group so the DB's order is
 * preserved among ties. Returns a new array; never mutates the input.
 */
export function orderAgentsForTick(agents: SyncAgent[]): SyncAgent[] {
  return [...agents].sort((a, b) => {
    const an = a.lastSyncedMs === null;
    const bn = b.lastSyncedMs === null;
    if (an !== bn) return an ? -1 : 1; // nulls first
    if (an && bn) return 0; // both never-synced: stable
    return (a.lastSyncedMs as number) - (b.lastSyncedMs as number);
  });
}

/**
 * Whether to spend this tick's onboarding budget on this agent. Only agents
 * with no calendars yet need first-time watch setup (the ~2-Google-call path);
 * already-onboarded agents are synced without counting against the cap.
 */
export function shouldOnboard(
  agent: SyncAgent,
  onboardedSoFar: number,
  cap: number = MAX_ONBOARDS_PER_TICK,
): boolean {
  return !agent.hasCalendars && onboardedSoFar < cap;
}

/**
 * Which agents the watch lane processes this tick (#302). Every already-
 * onboarded agent (cheap renewal check) plus at most `onboardCap` brand-new
 * ones (the ~2-Google-call first-time setup), in the given order. The watch
 * lane runs CONCURRENTLY, so the onboarding cap can't be a running counter
 * inside the loop (it would race); pre-selecting here keeps it deterministic.
 * Brand-new agents beyond the cap are picked up next tick (rotation).
 */
export function watchAgentsForTick(
  ordered: SyncAgent[],
  onboardCap: number = MAX_ONBOARDS_PER_TICK,
): SyncAgent[] {
  let onboards = 0;
  return ordered.filter((a) => {
    if (a.hasCalendars) return true;
    if (onboards < onboardCap) {
      onboards++;
      return true;
    }
    return false;
  });
}

/**
 * Process `items` through `worker` with at most `cap` in flight at once (#242).
 * Items are started in order, so the started set is always a prefix — workers
 * stop STARTING new items once `deadlineMs` passes (in-flight ones still
 * finish), and `truncated` reports whether any item went unstarted (it's
 * picked up next tick, since rotation sorts unreached agents first). `now` is
 * injectable so the deadline behavior is testable without a real clock.
 * Results are index-aligned to the started items.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  cap: number,
  worker: (item: T, index: number) => Promise<R>,
  opts: { deadlineMs?: number | null; now?: () => number } = {},
): Promise<{ results: R[]; processed: number; truncated: boolean }> {
  const { deadlineMs = null, now = Date.now } = opts;
  const results: R[] = new Array(items.length);
  let next = 0;
  let started = 0;
  const limit = Math.max(1, cap);

  async function runFrom(): Promise<void> {
    // No await between reading and bumping `next`, so each item is claimed by
    // exactly one worker (single-threaded) - started items stay contiguous.
    while (true) {
      if (deadlineMs !== null && now() >= deadlineMs) return;
      const i = next;
      if (i >= items.length) return;
      next++;
      started++;
      results[i] = await worker(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runFrom()),
  );

  return {
    results: results.slice(0, started),
    processed: started,
    truncated: started < items.length,
  };
}
