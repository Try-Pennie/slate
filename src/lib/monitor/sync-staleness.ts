import { parseStampMs } from "@/lib/date/stamp";

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
}

/**
 * Flag agents whose last cron sync is older than `thresholdMs` (or who were
 * never synced). Pure so the false-alarm boundary is unit-tested. A never-synced
 * agent is the worst case (sorts first); finite ages sort oldest-first.
 * `> thresholdMs` (strictly greater) so an agent synced exactly at the threshold
 * is not yet stale.
 */
export function classifySyncStaleness(
  agents: SyncAgentStaleness[],
  nowMs: number,
  thresholdMs: number,
): StalenessResult {
  const stale: StaleAgent[] = agents
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
export function syncRotationCandidates(
  agents: { id: string; name: string | null; email: string | null; last_synced_at: string | null }[],
  calendarUserIds: Set<string>,
): SyncAgentStaleness[] {
  return agents
    .filter((a) => calendarUserIds.has(a.id))
    .map((a) => {
      return {
        id: a.id,
        name: a.name,
        email: a.email,
        // Missing OR unparseable both degrade to never-synced (flagged), via the
        // shared #1169 stamp parser.
        lastSyncedMs: parseStampMs(a.last_synced_at),
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
  notify: (key: string, cooldownMs: number, text: string) => Promise<void>;
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
  }
  deps.log?.(
    `monitor sync-staleness: ${res.staleCount} stale of the rotation` +
      (res.staleCount
        ? ` (worst ${res.worstNeverSynced ? "never synced" : Math.round((res.worstAgeMs ?? 0) / 60_000) + " min"})`
        : ""),
  );
  return res;
}
