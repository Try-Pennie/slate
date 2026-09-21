import { parseStampMs } from "@/lib/date/stamp";
import type { AlertResolve, ThrottledNotify } from "./alert-deps";

// alert_state row key for the throttle; lives with the feature so the cron and
// the settings screen refer to the one constant.
export const SYNC_STALENESS_KEY = "sync_staleness";

// Default staleness threshold. Normal rotation covers the roster in ~1-3 min
// (MAX_AGENTS_PER_SYNC_TICK = 100 agents/tick, plus Google push), so 15 min
// unsynced means an agent is being skipped or the rotation is falling behind,
// not ordinary time-distribution.
export const SYNC_STALENESS_THRESHOLD_MS = 15 * 60_000;

// Match the other monitor notices' list cap so a broad stall stays one readable
// Slack post rather than a wall of names.
const NAME_CAP = 8;

/** A bookable agent that IS in the sync rotation (has a calendar row). */
export interface SyncAgentStaleness {
  id: string;
  name: string | null;
  email: string | null;
  /** users.last_synced_at as epoch ms, or null if the cron never synced them. */
  lastSyncedMs: number | null;
  /**
   * When this agent ENTERED the rotation: the earliest `agent_calendars.created_at`
   * they hold, as epoch ms. null = unreadable, which buys no grace (#2299).
   *
   * Required, not optional, so `tsc` enumerates every construction site rather than
   * letting one quietly default into permanent silence.
   */
  rotationSinceMs: number | null;
  /** Any of their calendars carries a recorded sync failure (#2299). */
  hasRecordedFailure: boolean;
}

export interface StaleAgent extends SyncAgentStaleness {
  /** now - lastSyncedMs, or null when never synced. */
  ageMs: number | null;
}

export interface StalenessResult {
  staleCount: number;
  /** The worst FINITE stale age in ms, or null when the stale set is empty or all never-synced. */
  worstAgeMs: number | null;
  /** True when at least one stale agent has never been synced. */
  worstNeverSynced: boolean;
  /** The stale agents, worst-first (never-synced first, then oldest age). */
  stale: StaleAgent[];
  /**
   * How many agents this tick DECLINED to judge because the rotation has not yet
   * had its first opportunity at them (#2299). Reported rather than left implicit:
   * a check that withheld somebody and a check that found a clean rotation are
   * otherwise the same zero, and the all-clear copy has to know the difference
   * before it can claim what it measured.
   */
  gracedCount: number;
}

/**
 * Flag agents whose last cron sync is older than `thresholdMs` (or who were
 * never synced). Pure so the false-alarm boundary is unit-tested. A never-synced
 * agent is the worst case (sorts first); finite ages sort oldest-first.
 * `> thresholdMs` (strictly greater) so an agent synced exactly at the threshold
 * is not yet stale.
 */
/**
 * Whether the rotation has not yet had its FIRST opportunity at this agent (#2299).
 *
 * Only the never-synced case can be in it: an agent with a `last_synced_at` has an
 * age of their own and is judged on it, however new their calendar row is. That is
 * the stand-down written as its own reason rather than as "this agent is new"
 * (L324), and it is why a reactivated agent (#1879), whose calendar row is old, is
 * untouched by any of this.
 *
 * A recorded failure ENDS it, per L458. Inside the window a rotation still working
 * through the roster and a rotation that has already failed on this calendar are
 * indistinguishable, because neither has produced a success; being patient about
 * the second hides a condition that is already known and already actionable.
 *
 * An unreadable entry stamp gets no grace, the fail-safe side: an unreadable value
 * must never buy silence.
 */
function withinFirstRun(a: SyncAgentStaleness, nowMs: number, thresholdMs: number): boolean {
  if (a.lastSyncedMs !== null) return false;
  if (a.hasRecordedFailure) return false;
  if (a.rotationSinceMs === null) return false;
  // Strictly greater, the same rule the finite-age branch below uses, so there is
  // one threshold in this file rather than two that can drift apart.
  return nowMs - a.rotationSinceMs <= thresholdMs;
}

export function classifySyncStaleness(
  agents: SyncAgentStaleness[],
  nowMs: number,
  thresholdMs: number,
): StalenessResult {
  const judged = agents.filter((a) => !withinFirstRun(a, nowMs, thresholdMs));
  const gracedCount = agents.length - judged.length;
  const stale: StaleAgent[] = judged
    .map((a) => ({ ...a, ageMs: a.lastSyncedMs === null ? null : nowMs - a.lastSyncedMs }))
    .filter((a) => a.ageMs === null || a.ageMs > thresholdMs)
    .sort((x, y) => {
      if (x.ageMs === null && y.ageMs === null) return 0;
      if (x.ageMs === null) return -1;
      if (y.ageMs === null) return 1;
      return y.ageMs - x.ageMs;
    });

  const finiteAges = stale
    .map((s) => s.ageMs)
    .filter((n): n is number => n !== null);
  return {
    staleCount: stale.length,
    worstAgeMs: finiteAges.length ? Math.max(...finiteAges) : null,
    worstNeverSynced: stale.some((s) => s.ageMs === null),
    stale,
    gracedCount,
  };
}

/**
 * Join the bookable agents to the sync rotation (#241, extracted #1158): only an
 * agent with a calendar row is IN the rotation (a bookable agent with none is the
 * schedule/watch-onboarding lane's concern). `last_synced_at` becomes epoch ms;
 * null stays null (never synced, the worst case), and an UNPARSEABLE timestamp
 * also degrades to null rather than NaN, because a NaN age compares false against
 * the threshold and would silently read a corrupt stamp as a healthy agent.
 */
export interface RotationCalendarRow {
  user_id: string;
  /** `agent_calendars.created_at`: when this calendar joined the rotation. */
  created_at: string | null;
  consecutive_failures: number | null;
  last_sync_error: string | null;
}

export function syncRotationCandidates(
  agents: { id: string; name: string | null; email: string | null; last_synced_at: string | null }[],
  calendars: RotationCalendarRow[],
): SyncAgentStaleness[] {
  // Folded per agent rather than per calendar, because the rotation processes the
  // AGENT: `users.last_synced_at` is one stamp covering all their calendars, so the
  // grace has to be answered at the same grain.
  const byUser = new Map<string, { since: number | null; anyUnreadable: boolean; failed: boolean }>();
  for (const c of calendars) {
    const prev = byUser.get(c.user_id) ?? { since: null, anyUnreadable: false, failed: false };
    const created = parseStampMs(c.created_at);
    byUser.set(c.user_id, {
      // The EARLIEST row: an agent enters the rotation when their first calendar
      // appears, so a second calendar added later must not restart the grace.
      since: created === null ? prev.since : prev.since === null ? created : Math.min(prev.since, created),
      anyUnreadable: prev.anyUnreadable || created === null,
      // ANY failing calendar answers for the agent, since one broken calendar is
      // enough for the rotation to have concluded something about them.
      failed: prev.failed || (c.consecutive_failures ?? 0) > 0 || c.last_sync_error !== null,
    });
  }
  return agents
    .filter((a) => byUser.has(a.id))
    .map((a) => {
      const cal = byUser.get(a.id)!;
      return {
        id: a.id,
        name: a.name,
        email: a.email,
        // Missing OR unparseable both degrade to never-synced (flagged), via the
        // shared #1169 stamp parser.
        lastSyncedMs: parseStampMs(a.last_synced_at),
        // An agent with ANY unreadable calendar stamp gets no grace, even if another
        // of their rows is readable: the unreadable one could be the older, and
        // guessing in the permissive direction is how an unreadable value buys
        // silence.
        rotationSinceMs: cal.anyUnreadable ? null : cal.since,
        hasRecordedFailure: cal.failed,
      };
    });
}

function agentLine(a: StaleAgent): string {
  const name = a.name?.trim() || a.email || a.id;
  const who = a.email && a.email !== name ? `${name} (${a.email})` : name;
  const age =
    a.ageMs === null ? "never synced by the cron" : `${Math.round(a.ageMs / 60_000)} min unsynced`;
  return `${who}: ${age}`;
}

/**
 * The Slack alert for a stalled sync rotation, or "" when nothing is stale.
 * Worded as a real fault: a stale cache can drift from the calendar and
 * double-book, so it goes to the alert (page) channel, not the info whisper.
 */
export function formatSyncStalenessAlert(res: StalenessResult, thresholdMs: number): string {
  if (!res.staleCount) return "";
  const mins = Math.round(thresholdMs / 60_000);
  const lines = res.stale.slice(0, NAME_CAP).map(agentLine);
  const more = res.staleCount > NAME_CAP ? ` (and ${res.staleCount - NAME_CAP} more)` : "";
  return (
    `${res.staleCount} bookable agent(s) have not been calendar-synced in over ` +
    `${mins} min; the sync rotation may be falling behind (roster too large for a tick, ` +
    `or agents being skipped), so their cached availability can drift and double-book.${more}\n` +
    lines.join("\n")
  );
}


/**
 * The all-clear for a recovered sync rotation (#1400).
 *
 * The page said their cached availability could drift and double book, so the
 * ending has to answer that: everyone in the rotation is synced inside the
 * window again. It carries no remediation, because the page already sent the
 * reader to look at the rotation and that fault is over.
 */
export function formatSyncStalenessRecovery(agentCount: number, gracedCount: number): string {
  const measured = agentCount - gracedCount;
  // The unqualified sentence may only be said when the check really did judge
  // everybody. With an agent withheld by the first-run grace (#2299) it would claim
  // a reading the check declined to take, so the softened form states what WAS
  // measured rather than merely dropping the claim (L440).
  const who =
    measured === 1 && gracedCount === 0
      ? "the one bookable agent"
      : gracedCount === 0
        ? `all ${agentCount} bookable agents`
        : `${measured} of the ${agentCount} bookable agents`;
  const withheld =
    gracedCount === 0
      ? ""
      : ` The other ${gracedCount === 1 ? "one joined" : `${gracedCount} joined`} the rotation ` +
        `too recently to have been reached yet, so ${gracedCount === 1 ? "it was" : "they were"} ` +
        `not judged either way.`;
  return (
    `The calendar sync rotation has caught up: ${who} in it were synced inside the ` +
    `expected window on this check, so their cached availability is current again ` +
    `and the earlier page is cleared.${withheld} No action is needed.`
  );
}

/**
 * The monitor-cron step (#241): load the bookable agents in the sync rotation,
 * classify staleness, and fire ONE throttled alert naming the stale agents. The
 * notify failure is swallowed (fail-soft): a flaky Slack must never fail the
 * monitor tick. Repeats are gated by the persistent alert_state cooldown inside
 * `notify`, not by this call. IO is dependency-injected so it stays node-testable.
 */
export async function runSyncStalenessCheck(deps: {
  loadAgents: () => Promise<SyncAgentStaleness[]>;
  nowMs: number;
  thresholdMs?: number;
  notify: ThrottledNotify;
  /**
   * The all-clear (#1400). REQUIRED, not optional, so `tsc` enumerates every
   * construction site rather than letting a caller quietly wire a page with no
   * way to end it, which is how this condition went three releases without one.
   */
  resolve: AlertResolve;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<StalenessResult> {
  const thresholdMs = deps.thresholdMs ?? SYNC_STALENESS_THRESHOLD_MS;
  const agents = await deps.loadAgents();
  const res = classifySyncStaleness(agents, deps.nowMs, thresholdMs);
  if (res.staleCount) {
    await deps
      .notify(SYNC_STALENESS_KEY, deps.cooldownMs, formatSyncStalenessAlert(res, thresholdMs))
      .catch(() => {});
  } else if (agents.length > 0) {
    // The all-clear hangs off a rotation we actually MEASURED. `agents.length > 0`
    // is the part that is easy to leave out and impossible to notice afterwards:
    // an EMPTY candidate list also produces staleCount 0, and "nobody is stale"
    // and "there was nobody to look at" are indistinguishable from that number
    // alone (L98). Before cutover the rotation is nearly empty by design, so this
    // is the live case, not a hypothetical one.
    //
    // A read that FAILED never reaches here at all: loadAgents throws, the step
    // runner records the tick as degraded, and nothing is claimed either way.
    await deps
      .resolve(SYNC_STALENESS_KEY, formatSyncStalenessRecovery(agents.length, res.gracedCount))
      .catch(() => {});
  }
  deps.log?.(
    `monitor sync-staleness: ${res.staleCount} stale of the rotation` +
      (res.gracedCount ? `, ${res.gracedCount} within their first run` : "") +
      (res.staleCount
        ? ` (worst ${res.worstNeverSynced ? "never synced" : Math.round((res.worstAgeMs ?? 0) / 60_000) + " min"})`
        : ""),
  );
  return res;
}
