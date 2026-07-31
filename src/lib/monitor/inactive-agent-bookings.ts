import { recordConsecutiveStreak, clearFailureStreak } from "@/lib/notify/streak";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { log } from "@/lib/log";

/**
 * Appointments still held by an agent who has left the bookable pool (#1215).
 *
 * Deactivating an agent and reassigning that agent's upcoming bookings are two
 * completely independent actions. `applyLifecycleByEmail` /
 * `applyLifecycleByUserId` flip `deactivated_at` and nothing else; the pool-exit
 * cleanup then tears down the agent's Google watch and prunes their cached
 * `busy_blocks`, so they vanish from availability and from every picker. Their
 * already-booked future appointments stay assigned to them, and nothing said so.
 * A customer could hold a confirmed appointment with an advisor who had left,
 * with only an admin's memory of the coverage panel between that and a no-show.
 *
 * This is the "an empty result reads as healthy" family one step removed: the
 * agent looks fully cleaned up (watch gone, busy blocks gone) precisely BECAUSE
 * the cleanup that ran is the cleanup that does not cover bookings.
 *
 * Both axes count, matching the predicate the pool-exit cleanup itself uses
 * (`bookable = false OR deactivated_at IS NOT NULL`, see
 * `reconcileOrphanedPoolExits`): whichever way an agent left, their cached busy
 * time is pruned and the booker stops offering them, so a customer holding an
 * appointment with them is in the same position either way. The alert names WHICH
 * axis per agent, because the remediation differs (a paused agent may be coming
 * back; a departed one is not).
 *
 * Covers both entry points, which is why it is a monitor rather than only a UI
 * warning: an admin deactivating on the agent page has a human present to warn,
 * but the hourly Salesforce roster sync sets `deactivated_at` with no admin and
 * no UI at all.
 */

/** alert_state row key for the throttle. Lives with the feature so the cron lane
 *  and the settings screen refer to the one constant. */
export const INACTIVE_AGENT_BOOKINGS_KEY = "inactive_agent_bookings";

/**
 * Consecutive monitor ticks holding bookings before this pages. The monitor lane
 * runs every 5 minutes, so 12 ticks is about an hour of the gap standing open.
 *
 * The streak is the whole reason this can watch both axes without crying wolf
 * (L36). Two ordinary, correct sequences produce holders for a tick or two and
 * must never page: an admin deactivates an agent and then runs the coverage panel
 * a minute later, and an agent is made not-bookable for an afternoon while
 * keeping the appointments they already have. Neither survives an hour. A real
 * offboarding nobody followed up on does.
 */
export const INACTIVE_BOOKINGS_ALERT_AFTER_TICKS = 12;

/** Streak window. Must comfortably exceed 12 ticks * 5 min = 60 min so genuinely
 *  consecutive ticks land in the same window, with slack for a delayed tick. */
export const INACTIVE_BOOKINGS_WINDOW_SECONDS = 2 * 60 * 60;

/** How an agent left the bookable pool. The remediation differs, so the alert
 *  says which. */
export type OutOfPoolReason = "deactivated" | "not_bookable";

/** An agent the roster read found outside the bookable pool. */
export interface OutOfPoolAgent {
  id: string;
  name: string | null;
  email: string | null;
  /** True when `deactivated_at` is set; false when they are merely not bookable. */
  deactivated: boolean;
}

/** One out-of-pool agent who still holds future appointments. */
export interface InactiveHolder {
  userId: string;
  name: string | null;
  email: string | null;
  reason: OutOfPoolReason;
  bookingCount: number;
}

/**
 * Group one bulk booking read by assigned agent, keeping only the out-of-pool
 * agents who actually hold something.
 *
 * The read is ONE query over every out-of-pool agent rather than a count per
 * agent, because the roster target is 100 to 200 agents and a count each would
 * spend a subrequest budget this lane shares with three others. Pure so the
 * "which bookings count" rule is pinned by tests rather than living inside a
 * query nothing can assert against. A booking assigned to nobody, or to an agent
 * still in the pool, is not this check's business.
 *
 * Ordered worst-holder-first so a truncated list in the alert names the biggest
 * gap rather than an arbitrary one.
 */
export function inactiveHoldersFromBookings(
  agents: OutOfPoolAgent[],
  bookings: { assigned_user_id: string | null }[],
): InactiveHolder[] {
  const byAgent = new Map<string, number>();
  for (const b of bookings) {
    if (!b.assigned_user_id) continue;
    byAgent.set(b.assigned_user_id, (byAgent.get(b.assigned_user_id) ?? 0) + 1);
  }
  return agents
    .flatMap((a) => {
      const bookingCount = byAgent.get(a.id) ?? 0;
      if (bookingCount === 0) return [];
      return [
        {
          userId: a.id,
          name: a.name,
          email: a.email,
          reason: (a.deactivated ? "deactivated" : "not_bookable") as OutOfPoolReason,
          bookingCount,
        },
      ];
    })
    .sort((x, y) => y.bookingCount - x.bookingCount || x.userId.localeCompare(y.userId));
}

// Match the other monitor notices' list cap so a broad gap stays one readable
// Slack post rather than a wall of names.
const NAME_CAP = 8;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Human line for one holder: who they are, why they are out, and how much they
 *  are holding, so the reader can triage without opening the admin. */
function holderLine(h: InactiveHolder): string {
  const who = h.name?.trim() || h.email || h.userId;
  const contact = h.email && h.email !== who ? `${who} (${h.email})` : who;
  const why = h.reason === "deactivated" ? "deactivated" : "not bookable";
  return `${contact}, ${why}, ${plural(h.bookingCount, "appointment", "appointments")}`;
}

/**
 * The page. States the customer-facing consequence first (that is what decides
 * whether someone acts at 7am), then names the agents, then points at the ONE
 * place that fixes it. Deliberately does not paste booking ids or times: the
 * coverage panel lists them, and a page is read on a phone.
 *
 * The verbs agree with the subject in both directions. Counting the nouns is not
 * enough: "1 agent who HAVE left the pool still HOLD 1 appointment" satisfies
 * every singular/plural assertion about "agent" and "appointment" and still reads
 * wrong, which is only visible rendered (`pnpm preview:alerts`).
 */
export function formatInactiveAgentBookingsAlert(holders: InactiveHolder[]): string {
  const totalBookings = holders.reduce((n, h) => n + h.bookingCount, 0);
  const lines = holders.slice(0, NAME_CAP).map(holderLine);
  const more = holders.length > NAME_CAP ? `\n(and ${holders.length - NAME_CAP} more)` : "";
  const oneAgent = holders.length === 1;
  const oneBooking = totalBookings === 1;
  return (
    `Slate: ${plural(holders.length, "agent", "agents")} who ${oneAgent ? "has" : "have"} left ` +
    `the booking pool still ${oneAgent ? "holds" : "hold"} ` +
    `${plural(totalBookings, "appointment", "appointments")} in the future. ` +
    `${oneBooking ? "That customer is" : "Those customers are"} booked with someone Slate no ` +
    `longer routes to, so they will meet nobody unless the ` +
    `${oneBooking ? "appointment is" : "appointments are"} moved. Reassign ` +
    `${oneBooking ? "it" : "them"} from the agent's page in Admin, under Coverage.\n` +
    lines.join("\n") +
    more
  );
}

/**
 * The all-clear. Says the customers are covered again, and deliberately does NOT
 * repeat the page's remediation: the reader is being told to stand down, and
 * carrying "reassign them from the coverage panel" into the all-clear is how a
 * recovery notice sends someone to redo work that is already done.
 */
export function formatInactiveAgentBookingsRecovery(): string {
  return (
    `Slate: no agent who has left the booking pool is holding future appointments any more. ` +
    `The bookings behind the earlier page have been reassigned or have passed, so every upcoming ` +
    `appointment belongs to an agent Slate still routes to. No action is needed.`
  );
}

/** What one tick measured. `unreadable` is NOT zero: see the check below. */
export interface InactiveAgentBookingsResult {
  status: "clear" | "holding" | "unreadable";
  agents: number;
  bookings: number;
}

/**
 * One monitor tick: measure who is holding what, page when it has persisted, and
 * clear when a real read says the gap is closed.
 *
 * The three states are deliberately distinct, and the third is the one this class
 * of defect keeps shipping without:
 *
 *   - holders found: count toward the streak, page once it is sustained.
 *   - a MEASURED zero: clear the streak and announce recovery. `resolveAlert` is a
 *     no-op unless a page was actually delivered, so a check that never alerted
 *     stays silent. This path is reachable while healthy, which a recovery gated
 *     on the condition still being true would not be.
 *   - a read that FAILED: do neither. An unread worklist comes back empty, and an
 *     empty result here is indistinguishable from "nobody is holding anything".
 *     Announcing recovery off it would clear a real page, and clearing the streak
 *     would reset the count that was about to fire, both at the moment the system
 *     is least able to tell anyone (#1134, #1152).
 *
 * Best-effort by design: monitoring must never take down the lane it watches, so
 * both dispatches are caught and the streak helpers swallow their own errors.
 */
export async function runInactiveAgentBookingsCheck(deps: {
  loadHolders: () => Promise<InactiveHolder[]>;
  cooldownMs: number;
  log?: (fields: Record<string, unknown>) => void;
}): Promise<InactiveAgentBookingsResult> {
  let holders: InactiveHolder[];
  try {
    holders = await deps.loadHolders();
  } catch (err) {
    // Fail loud in the logs, silent on the alert channels. The lane heartbeat and
    // the migration-drift page cover a database that cannot be read at all; what
    // must not happen is this check turning an unread result into an all-clear.
    log.error("inactive-agent-bookings", { msg: "holder read failed" }, err);
    deps.log?.({ status: "unreadable" });
    return { status: "unreadable", agents: 0, bookings: 0 };
  }

  const bookings = holders.reduce((n, h) => n + h.bookingCount, 0);

  if (holders.length === 0) {
    await clearFailureStreak(INACTIVE_AGENT_BOOKINGS_KEY);
    // alert-key: inactive_agent_bookings
    await resolveAlert(INACTIVE_AGENT_BOOKINGS_KEY, formatInactiveAgentBookingsRecovery()).catch(
      () => {},
    );
    deps.log?.({ status: "clear", agents: 0, bookings: 0 });
    return { status: "clear", agents: 0, bookings: 0 };
  }

  const sustained = await recordConsecutiveStreak(
    INACTIVE_AGENT_BOOKINGS_KEY,
    INACTIVE_BOOKINGS_WINDOW_SECONDS,
    INACTIVE_BOOKINGS_ALERT_AFTER_TICKS,
  );
  if (sustained) {
    // alert-key: inactive_agent_bookings
    await sendThrottledAlert(
      INACTIVE_AGENT_BOOKINGS_KEY,
      deps.cooldownMs,
      formatInactiveAgentBookingsAlert(holders),
    ).catch(() => {});
  }
  deps.log?.({ status: "holding", agents: holders.length, bookings, sustained });
  return { status: "holding", agents: holders.length, bookings };
}
