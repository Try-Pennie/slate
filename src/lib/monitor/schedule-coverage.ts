import { logAlertSendFailure } from "../notify/send-failure.ts";
import { log } from "@/lib/log";
import type { ThrottledNotify } from "./alert-deps";

// alert_state row key for the throttle; lives with the feature so the cron and
// the settings screen refer to the one constant.
export const AGENTS_WITHOUT_SCHEDULE_KEY = "agents_without_schedule";

/** A bookable, non-deactivated, non-test agent with no availability_schedules row. */
export type ScheduleLessAgent = {
  id: string;
  name: string | null;
  email: string | null;
  org_id: string;
};

/**
 * The agents who have a schedule that can actually produce a bookable time
 * (#1670): a schedule ROW is not enough, its rules are what the engine reads.
 *
 * `isWithinWorkingHours` loops the rules matching a weekday, so an empty rule set
 * rejects every instant and that agent offers no times, permanently. Keying this
 * check on the row alone made that state invisible to the one monitor written to
 * catch an agent who is silently unbookable, which is how "Apply company default
 * hours" could half fail and leave nothing anywhere saying so.
 */
export function usableScheduleUserIds(
  schedules: { id: string; user_id: string }[],
  scheduleIdsWithRules: Set<string>,
): Set<string> {
  return new Set(
    schedules.filter((s) => scheduleIdsWithRules.has(s.id)).map((s) => s.user_id),
  );
}

/** From the bookable agents and the user ids with a USABLE schedule (a row that
 *  holds rules, see above), the agents who have none (#838, widened by #1670).
 *  Pure so the set difference is pinned by tests (#1158); the paged reads live in
 *  the cron route. */
export function missingScheduleAgents(
  agents: ScheduleLessAgent[],
  scheduledUserIds: Set<string>,
): ScheduleLessAgent[] {
  return agents.filter((a) => !scheduledUserIds.has(a.id));
}

// Match the other monitor notices' list cap so a broad gap stays one readable
// Slack post, not a wall of names.
const NAME_CAP = 8;

/** Human line for one agent: name (email) so staffing can find them. */
function agentLine(a: ScheduleLessAgent): string {
  const name = a.name?.trim() || a.email || a.id;
  return a.email && a.email !== name ? `${name} (${a.email})` : name;
}

/**
 * The Slack info notice for agents left without a working-hours schedule AFTER
 * the self-heal attempt, or "" when there are none. This only fires when the
 * auto-fill could not create the schedule, so it is worded as a malfunction (the
 * fill is broken) rather than a benign nudge: those agents show zero availability
 * and silently take no bookings until a human fixes it.
 */
export function formatScheduleGapNotice(agents: ScheduleLessAgent[]): string {
  if (!agents.length) return "";
  const lines = agents.slice(0, NAME_CAP).map(agentLine);
  const more = agents.length > NAME_CAP ? ` (and ${agents.length - NAME_CAP} more)` : "";
  // "no working hours" rather than "no schedule row" (#1670): the check now also
  // catches an agent whose schedule exists but holds no rules, and the two are the
  // same thing to the reader (this person takes no bookings) and to the repair.
  return (
    `Could not auto-create working hours for ${agents.length} ` +
    `bookable agent(s); they show zero availability and take no bookings until fixed ` +
    `(admin > agent hours, or check the roster sync).${more}\n` +
    lines.join("\n")
  );
}

/**
 * The monitor-cron step (#838): find bookable agents with no schedule (who would
 * silently show zero availability), try to SELF-HEAL them by filling the org
 * default, and whisper an alert ONLY for the ones the fill could not create.
 *
 * The benign case (a new agent who arrived between roster syncs) heals quietly;
 * an alert therefore means the fill mechanism itself is broken, which is the
 * fail-loud signal worth a human. Dependency-injected so the IO stays testable:
 * `loadMissingAgents` is re-read AFTER the heal so the recheck reflects what the
 * fill actually created. The notify failure is swallowed (fail-soft): a flaky
 * Slack must never fail the monitor tick. The gate on repeats is the persistent
 * `alert_state` cooldown inside `notify`, not this call.
 */
export async function runScheduleCoverageCheck(deps: {
  loadMissingAgents: () => Promise<ScheduleLessAgent[]>;
  heal: (orgIds: string[]) => Promise<void>;
  notify: ThrottledNotify;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<{ missingBefore: number; healed: number; stillMissing: number }> {
  const before = await deps.loadMissingAgents();
  if (!before.length) {
    deps.log?.("monitor schedule-coverage: 0 schedule-less agents");
    return { missingBefore: 0, healed: 0, stillMissing: 0 };
  }

  // Best-effort heal: a throw here (a broken fill) must not skip the recheck.
  // That is exactly the case the alert exists to surface.
  const orgIds = [...new Set(before.map((a) => a.org_id))];
  await deps
    .heal(orgIds)
    // A failed self-heal is why the gap alert then fires; without a trace the
    // alert looks like the gap was never fixable rather than never attempted.
    .catch((err) =>
      log.error("schedule-coverage", { msg: "schedule self-heal failed", orgs: orgIds.length }, err),
    );

  const after = await deps.loadMissingAgents();
  const healed = before.length - after.length;
  if (after.length) {
    await deps
      .notify(AGENTS_WITHOUT_SCHEDULE_KEY, deps.cooldownMs, formatScheduleGapNotice(after))
      .catch(logAlertSendFailure(AGENTS_WITHOUT_SCHEDULE_KEY));
  }
  deps.log?.(
    `monitor schedule-coverage: ${before.length} missing, ${healed} self-healed, ${after.length} still missing`,
  );
  return { missingBefore: before.length, healed, stillMissing: after.length };
}
