/**
 * Take an advisor out of the pool when Google has refused their calendar for a
 * sustained period (#3700, Dan's decision of 2026-10-20).
 *
 * ## Why
 *
 * Offboarding archives the advisor's Workspace account, and from then on Google
 * answers their calendar with `403 notACalendarUser`. Until the Salesforce reap or a
 * manager turns them off, they stay bookable: the availability cache keeps offering
 * their last known free times, and every confirm meets the refusal live (#3988 makes
 * that confirm skip them rather than fail). The sync lane already KNOWS: it records
 * the refusal on every read. So the lane that measures it acts on it.
 *
 * ## The rule
 *
 * In `refused-pool-exit-rule.ts`, pure, with the reasoning for each half: every
 * calendar the advisor holds refused (`gone` or `not-provisioned`) on the latest
 * read, on several reads, with no good read for the whole period.
 *
 * ## The way back
 *
 * The write (`writeRoutableState`, kind `hold-out`) clears `bookable` and stamps
 * `bookable_pending_since` in one compare and swap. The mark is the existing record
 * that an activation is owed: the hourly roster run retries every marked row through
 * the activation gate, which admits them only once every calendar of theirs reads.
 * So nothing new is built for the return. `deactivated_at` is never stamped: this is
 * not a departure.
 *
 * ## Running twice
 *
 * The write matches only a row that is still bookable and not departed, so of two
 * overlapping runs exactly one gets a row back, and only that run audits and posts.
 */
import { supabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@/lib/log";
import { recordAudit, type AuditEntry } from "@/lib/audit";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { logAlertSendFailure } from "@/lib/notify/send-failure";
import { refusedAdvisorLeftPoolAlert } from "@/lib/notify/misc-alert-copy";
import { writeRoutableState } from "@/lib/bookable/routable-write";
import { loadTierDepths } from "@/lib/routing/staffing-depth-load";
import type { ThrottledNotify } from "@/lib/monitor/alert-deps";
import {
  REFUSED_POOL_EXIT_AFTER_MS,
  REFUSED_POOL_EXIT_AUDIT_VIA,
  heldOutEpisodeStart,
  refusedAdvisorIds,
  type RefusedCalendarRow,
} from "@/lib/bookable/refused-pool-exit-rule";

export {
  REFUSED_POOL_EXIT_AFTER_MS,
  REFUSED_POOL_EXIT_MIN_FAILED_READS,
  REFUSED_POOL_EXIT_AUDIT_VIA,
  heldOutEpisodeStart,
  isRefusedThroughoutPeriod,
  refusedAdvisorIds,
  type RefusedCalendarRow,
} from "@/lib/bookable/refused-pool-exit-rule";

/**
 * Per advisor. The write's compare and swap is what decides who posts, so this only
 * backs it up against a double send, and it must stay SHORTER than the quickest
 * second removal could follow the first: a return takes an hourly roster run, and a
 * second removal another full period of refusal after that. Anything longer (a week
 * was the first draft) would swallow the note for a real second removal.
 */
const REFUSED_POOL_EXIT_COOLDOWN_MS = REFUSED_POOL_EXIT_AFTER_MS;

/** The alert family, one key per advisor (catalogued in alert-catalog.ts). */
export const REFUSED_POOL_EXIT_KEY_PREFIX = "refused_advisor_left_pool:";

/** One advisor as the action needs them, with their manager's name joined in. */
export interface RefusedAdvisorRow {
  id: string;
  name: string | null;
  email: string;
  org_id: string;
  bookable: boolean;
  deactivated_at: string | null;
  manager_name: string | null;
}

export interface RefusedPoolExitDeps {
  /** Every calendar row of these advisors, or null when the read failed. */
  loadCalendars: (userIds: string[]) => Promise<RefusedCalendarRow[] | null>;
  /** These advisors, or null when the read failed. */
  loadAdvisors: (userIds: string[]) => Promise<RefusedAdvisorRow[] | null>;
  /** Pools this advisor is the only bookable one in. Throws when it cannot tell. */
  poolsOnlyThem: (userId: string) => Promise<string[]>;
  /** The owned write. True only when THIS call changed the row; throws on refusal. */
  holdOut: (userId: string, stampIso: string) => Promise<boolean>;
  audit: (entry: AuditEntry) => Promise<void>;
  notify: ThrottledNotify;
  now: () => number;
}

/** The kind the note names: not provisioned when any calendar says so. */
function failureOf(rows: RefusedCalendarRow[]): "gone" | "not-provisioned" {
  return rows.some((r) => r.last_failure_kind === "not-provisioned") ? "not-provisioned" : "gone";
}

/**
 * Judge the advisors whose sync failed on this tick, and take out those Google has
 * refused for the whole period. Answers who was removed, or null when the health or
 * roster read failed, in which case nothing was changed: an unreadable signal is
 * never a reason to remove anybody, and never a report that nobody needed it.
 *
 * Never throws for one advisor: a refused write is logged and the rest carry on.
 */
export async function takeRefusedAdvisorsOutOfPool(
  failedUserIds: string[],
  deps: RefusedPoolExitDeps = defaultRefusedPoolExitDeps,
): Promise<{ removed: string[] } | null> {
  const ids = [...new Set(failedUserIds)];
  if (ids.length === 0) return { removed: [] };
  const calendars = await deps.loadCalendars(ids);
  if (calendars === null) return null;
  const nowMs = deps.now();
  const candidates = refusedAdvisorIds(calendars, nowMs);
  if (candidates.length === 0) return { removed: [] };
  const advisors = await deps.loadAdvisors(candidates);
  if (advisors === null) return null;

  const removed: string[] = [];
  for (const a of advisors) {
    if (!candidates.includes(a.id) || !a.bookable || a.deactivated_at !== null) continue;
    const rows = calendars.filter((c) => c.user_id === a.id);
    const failure = failureOf(rows);
    // Measured BEFORE the write, because afterwards they are no longer in any pool.
    let poolsLeftEmpty: string[] | null;
    try {
      poolsLeftEmpty = await deps.poolsOnlyThem(a.id);
    } catch (err) {
      log.warn("refused-pool-exit", { msg: "pool depth unreadable; removing anyway", user_id: a.id }, err);
      poolsLeftEmpty = null;
    }
    const stampIso = new Date(nowMs).toISOString();
    let changed: boolean;
    try {
      changed = await deps.holdOut(a.id, stampIso);
    } catch (err) {
      log.error("refused-pool-exit", { msg: "pool exit write refused", user_id: a.id }, err);
      continue;
    }
    // Another run, or a person, got there first: theirs is the record, not ours.
    if (!changed) continue;
    removed.push(a.id);
    log.warn("refused-pool-exit", {
      msg: "advisor taken out of the pool, Google refuses their calendar",
      user_id: a.id,
      email: a.email,
      failure,
      pools_left_empty: poolsLeftEmpty === null ? null : poolsLeftEmpty.length,
    });
    await deps.audit({
      orgId: a.org_id,
      actorId: null,
      action: "agent.bookable",
      targetUserId: a.id,
      details: {
        bookable: false,
        via: REFUSED_POOL_EXIT_AUDIT_VIA,
        failure,
        // The mark this write stamped: how the hourly activation retry knows the
        // episode is ours and says its blocked note once (`heldOutSince` below).
        pending_since: stampIso,
        refused_for_min: Math.round(REFUSED_POOL_EXIT_AFTER_MS / 60_000),
      },
    });
    const key = `${REFUSED_POOL_EXIT_KEY_PREFIX}${a.id}`;
    try {
      await deps.notify(
        key,
        REFUSED_POOL_EXIT_COOLDOWN_MS,
        refusedAdvisorLeftPoolAlert({
          name: a.name,
          email: a.email,
          managerName: a.manager_name,
          failure,
          refusedForMs: REFUSED_POOL_EXIT_AFTER_MS,
          poolsLeftEmpty,
        }),
      );
    } catch (err) {
      logAlertSendFailure(key)(err);
    }
  }
  return { removed };
}

// ---------------------------------------------------------------- the wiring

async function loadCalendars(userIds: string[]): Promise<RefusedCalendarRow[] | null> {
  // error-ok: a failed read answers null, and the caller changes nothing on null.
  const { data, error } = await supabaseAdmin()
    .from("agent_calendars")
    .select("user_id, calendar_id, consecutive_failures, last_success_at, last_failure_kind")
    // in-chunk-ok: the advisors whose sync failed on one tick, at most MAX_AGENTS_PER_SYNC_TICK.
    .in("user_id", userIds);
  if (error) {
    log.warn("refused-pool-exit", { msg: "calendar health unreadable; nobody judged this tick" }, error);
    return null;
  }
  return (data ?? []) as RefusedCalendarRow[];
}

async function loadAdvisors(userIds: string[]): Promise<RefusedAdvisorRow[] | null> {
  const db = supabaseAdmin();
  // error-ok: a failed read answers null, and the caller changes nothing on null.
  const { data, error } = await db
    .from("users")
    .select("id, name, email, org_id, bookable, deactivated_at, manager_id")
    .in("id", userIds);
  if (error) {
    log.warn("refused-pool-exit", { msg: "advisor read failed; nobody removed this tick" }, error);
    return null;
  }
  const rows = (data ?? []) as (Omit<RefusedAdvisorRow, "manager_name"> & { manager_id: string | null })[];
  const managerIds = [...new Set(rows.map((r) => r.manager_id).filter((m): m is string => m !== null))];
  const managerName = new Map<string, string | null>();
  if (managerIds.length > 0) {
    // error-ok: the manager's name is decoration on the note; without it the note omits the line.
    const { data: managers, error: managerError } = await db
      .from("users")
      .select("id, name, email")
      .in("id", managerIds);
    if (managerError) {
      log.warn("refused-pool-exit", { msg: "manager names unreadable; the note omits them" }, managerError);
    }
    for (const m of (managers ?? []) as { id: string; name: string | null; email: string }[]) {
      managerName.set(m.id, m.name ?? m.email);
    }
  }
  return rows.map(({ manager_id, ...r }) => ({
    ...r,
    manager_name: manager_id ? (managerName.get(manager_id) ?? null) : null,
  }));
}

/**
 * The pools this advisor is the only bookable one in, by the same staffing depth
 * the tiers page and the thin tier notice read (roster depth, not today's), named
 * by the pool's words or its code. One entry per pool, since several codes share one.
 */
async function poolsOnlyThem(userId: string): Promise<string[]> {
  const depths = await loadTierDepths(supabaseAdmin());
  const seen = new Map<string, string>();
  for (const d of depths) {
    if (d.depth !== 1 || !d.agents.some((x) => x.id === userId)) continue;
    if (!seen.has(d.poolKey)) seen.set(d.poolKey, d.poolLabel ?? d.code);
  }
  return [...seen.values()];
}

/**
 * The start of the episode when this advisor's CURRENT pending mark was written by
 * the pool exit, else null (#3700), for the activation retry's blocked note
 * (`BookableDeps.heldOutSince`). Read from the exit's own audit rows, newest first: a
 * handful is plenty, since each removal writes one and a return clears the mark.
 * THROWS on a failed read, which the caller treats as "not held out": the note then
 * repeats on its ordinary cooldown, the loud direction to be wrong in. If the exit's
 * audit insert itself failed (it pages when it does), the same fallback applies.
 */
export async function heldOutSince(userId: string, pendingSince: string | null): Promise<number | null> {
  if (pendingSince === null) return null;
  // error-ok: a failed read throws below, and the caller notes on the ordinary cooldown.
  const { data, error } = await supabaseAdmin()
    .from("audit_log")
    .select("details")
    .eq("action", "agent.bookable")
    .eq("target_id", userId)
    .eq("details->>via", REFUSED_POOL_EXIT_AUDIT_VIA)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(`held out audit read failed: ${error.message}`);
  const details = ((data ?? []) as { details: Record<string, unknown> | null }[]).map((r) => r.details ?? {});
  return heldOutEpisodeStart(pendingSince, details);
}

export const defaultRefusedPoolExitDeps: RefusedPoolExitDeps = {
  loadCalendars,
  loadAdvisors,
  poolsOnlyThem,
  holdOut: async (userId, stampIso) =>
    (await writeRoutableState({ kind: "hold-out", userId, stampIso })).length > 0,
  audit: recordAudit,
  // alert-key: refused_advisor_left_pool:*
  notify: (key, cooldownMs, text, repeat) => sendThrottledAlert(key, cooldownMs, text, repeat),
  now: () => Date.now(),
};
