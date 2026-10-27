import { recordConsecutiveStreak, clearFailureStreak } from "@/lib/notify/streak";
import { COVERAGE_PANEL_NAME } from "@/lib/booking/coverage-panel-copy";
import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { changeBatchMs, doublingBand, type AlertRepeat } from "@/lib/notify/repeat-policy";
import type { SendOptions } from "@/lib/notify/dispatch";
import { logAlertSendFailure, logAllClearFailure } from "@/lib/notify/send-failure";
import { log } from "@/lib/log";
import { parseStampMs } from "@/lib/date/stamp";
import type { Attributes, BulkReassignItemStatus, Criteria } from "@/lib/db/types";
import { selectDemotionBookings, type DemotionCandidateRow } from "@/lib/booking/demotion-snapshot";
import { ACTIONABLE_ITEM_STATUSES } from "@/lib/booking/bulk-reassign";

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

/** alert_state row key for the demotion backstop (#3582), a SEPARATE alert from the pool-exit one
 *  so a failed demotion read can never blind the #1215 departed-agent check. */
export const DEMOTED_AGENT_BOOKINGS_KEY = "demoted_agent_bookings";

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

/** Why an agent can no longer serve a booking they still hold. `deactivated` and `not_bookable`
 *  are the pool-exit axes (#1215); `demoted` is a still-bookable agent a Twilio tier/backend
 *  change took off the pool the booking needs (#3582), whose reroute did not complete. The
 *  remediation differs, so the alert says which per agent. */
export type OutOfPoolReason = "deactivated" | "not_bookable" | "demoted";

/** An agent the roster read found outside the bookable pool. */
export interface OutOfPoolAgent {
  id: string;
  name: string | null;
  email: string | null;
  /** True when `deactivated_at` is set; false when they are merely not bookable. */
  deactivated: boolean;
  /**
   * True when their booked calls are being handled by a debounced redistribute sweep
   * that has not run yet (#3599): the Twilio turn-off takes them out of the pool a sync
   * before the sweep moves their calls, so for that window they hold calls by design,
   * not through neglect. The raw mark state only; the check still pages a DEACTIVATED
   * holder regardless, because no sweep ever runs for one. Required so `tsc` names every
   * construction site (the one query that feeds this), and the safe value is `false`: a
   * missed case pages rather than going quiet.
   */
  coveredByPendingSweep: boolean;
}

/** One upcoming call an agent holds, as the demotion backstop names it. */
export interface HeldCall {
  id: string;
  startsAt: string;
}

/** One out-of-pool agent who still holds future appointments. */
export interface InactiveHolder {
  userId: string;
  name: string | null;
  email: string | null;
  reason: OutOfPoolReason;
  bookingCount: number;
  /** The calls themselves, which the demotion backstop names one by one (Dan, 2026-10-26);
   *  the pool-exit check counts by agent and leaves this out. */
  calls?: readonly HeldCall[];
}

/** Item statuses that leave a booking in a coverage sweep's hands: still being worked
 *  (`pending`, including a call the hourly retry re-armed), or given up on and paged by
 *  `coverage_needs_human` (the actionable ones). */
export const SWEEP_HELD_ITEM_STATUSES: readonly BulkReassignItemStatus[] = ["pending", ...ACTIONABLE_ITEM_STATUSES];
const SWEEP_HELD = new Set<string>(SWEEP_HELD_ITEM_STATUSES);

/**
 * The bookings a coverage sweep holds, so this check leaves them to it.
 *
 * Without this, a call the sweep could not place was paged by BOTH alerts: the stranded
 * page an hour before it starts, and this one every hour all night, telling a person to
 * run the very sweep that had already failed on it (Alana Lambert, 2026-10-12: 18
 * attempts per call, then a page at 2am, 3am, 4am...). This check exists for the call
 * NOTHING is working, which is the case "Move upcoming bookings" actually fixes.
 *
 * Held means the SAME thing the stranded page counts by (#3303, L342): an item in
 * `SWEEP_HELD_ITEM_STATUSES` on a sweep whose out agent is the booking's CURRENT holder.
 * An item from a sweep for somebody else (a call an earlier sweep moved onto this agent)
 * is not working this agent's departure, and a settled item (moved, skipped, cancelled)
 * is working nothing, so both stay counted here. Pure, so the rule is pinned by tests.
 */
export function sweepHeldBookingIds(
  holderByBooking: ReadonlyMap<string, string | null>,
  items: { booking_id: string; status: string; out_user_id: string }[],
): Set<string> {
  const held = new Set<string>();
  for (const it of items) {
    if (!SWEEP_HELD.has(it.status)) continue;
    const holder = holderByBooking.get(it.booking_id);
    if (holder != null && holder === it.out_user_id) held.add(it.booking_id);
  }
  return held;
}

/**
 * Group one bulk booking read by assigned agent, keeping only the out-of-pool
 * agents who actually hold something.
 *
 * The read is ONE query over every out-of-pool agent rather than a count per
 * agent, because the roster target is 100 to 200 agents and a count each would
 * spend a subrequest budget this lane shares with three others. Pure so the
 * "which bookings count" rule is pinned by tests rather than living inside a
 * query nothing can assert against. A booking assigned to nobody, to an agent
 * still in the pool, or held by a coverage sweep (`sweepHeldBookingIds`) is not
 * this check's business. `heldBySweep` is required so `tsc` names every caller.
 *
 * Ordered worst-holder-first so a truncated list in the alert names the biggest
 * gap rather than an arbitrary one.
 */
export function inactiveHoldersFromBookings(
  agents: OutOfPoolAgent[],
  bookings: { id: string; assigned_user_id: string | null }[],
  heldBySweep: ReadonlySet<string>,
): InactiveHolder[] {
  const byAgent = new Map<string, number>();
  for (const b of bookings) {
    if (!b.assigned_user_id) continue;
    if (heldBySweep.has(b.id)) continue;
    byAgent.set(b.assigned_user_id, (byAgent.get(b.assigned_user_id) ?? 0) + 1);
  }
  return agents
    .flatMap((a) => {
      // A redistribute sweep that has not run yet is deliberately holding these calls
      // for one sync (#3599), so leave them to it rather than page mid-pipeline. But only
      // for a NOT-bookable agent: the planner skips deactivated rows, so no sweep ever
      // runs for a deactivated agent and the exemption would silence the backstop on
      // exactly the #1215 case it exists for. A deactivated holder always pages.
      if (a.coveredByPendingSweep && !a.deactivated) return [];
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

/** A still-bookable agent a Twilio demotion took off a pool the bookings they hold need (#3582),
 *  with how many of those bookings they can no longer serve, already computed from the filtered
 *  demotion snapshot (`unservedBookingIds`). */
export interface DemotedAgent {
  id: string;
  name: string | null;
  email: string | null;
  /** Bookings the agent no longer serves, per the demotion snapshot (excludes agent_link and
   *  manual-member bookings, exactly as the reroute does). */
  unserved: HeldCall[];
  /**
   * True while a debounced demotion sweep is still legitimately pending for them
   * (`demotionSweepPending`): the sweep has not run yet, so they hold the lost-pool calls by
   * design for that window, not through neglect. Only once that window lapses (or the sweep ran
   * and could not place a booking) is an un-rerouted held booking a real gap. The safe value is
   * `false`: a missed case pages rather than going quiet.
   */
  coveredByPendingSweep: boolean;
}

/**
 * The demoted agents who still hold a booking they no longer serve and are NOT inside the sweep's
 * debounce window (#3582): an un-rerouted held booking the automatic reroute was due to move but
 * did not (the sweep failed, or found no eligible advisor and left it unplaceable). The complement
 * of `inactiveHoldersFromBookings`, which covers agents OUT of the pool; a demoted agent is still
 * bookable, so the pool-exit read never sees them. Pure, so the rule is pinned by tests.
 */
export function demotedHolders(agents: DemotedAgent[]): InactiveHolder[] {
  return agents
    .filter((a) => !a.coveredByPendingSweep && a.unserved.length > 0)
    .map((a) => ({
      userId: a.id,
      name: a.name,
      email: a.email,
      reason: "demoted" as OutOfPoolReason,
      bookingCount: a.unserved.length,
      calls: a.unserved,
    }))
    .sort((x, y) => y.bookingCount - x.bookingCount || x.userId.localeCompare(y.userId));
}

/**
 * The demoted agents the backstop judges, built from its reads (#3582): each marked agent past the
 * debounce, with how many of their upcoming calls they can no longer serve, judged by the SAME
 * filtered snapshot the reroute moves with (`selectDemotionBookings`, L342). A call an admin moved
 * BACK to them (#3615) is theirs by decision and is not counted, or the backstop would page about
 * it every day. Pure, so the counting is tested where the route's reads are not.
 */
export function demotedAgentsFrom(input: {
  stamped: { id: string; name: string | null; email: string | null; attributes: Attributes | null }[];
  rows: (DemotionCandidateRow & { assigned_user_id: string | null })[];
  criteriaByBucket: Map<string, Criteria | null>;
  membersByUser: Map<string, Set<string>>;
  pinnedByUser: Map<string, Set<string>>;
}): DemotedAgent[] {
  const rowsByUser = new Map<string, DemotionCandidateRow[]>();
  for (const r of input.rows) {
    if (!r.assigned_user_id) continue;
    if (input.pinnedByUser.get(r.assigned_user_id)?.has(r.id)) continue;
    const list = rowsByUser.get(r.assigned_user_id) ?? [];
    list.push({
      id: r.id,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      attendee_name: r.attendee_name,
      bucket_id: r.bucket_id,
      kind: r.kind,
    });
    rowsByUser.set(r.assigned_user_id, list);
  }
  return input.stamped.map((a) => ({
    id: a.id,
    name: a.name,
    email: a.email,
    // Only agents past the debounce reach here (the caller filters), so never mid-sweep.
    coveredByPendingSweep: false,
    unserved: selectDemotionBookings(
      a.attributes,
      rowsByUser.get(a.id) ?? [],
      input.criteriaByBucket,
      input.membersByUser.get(a.id) ?? new Set<string>(),
    ).map((r) => ({ id: r.id, startsAt: r.starts_at })),
  }));
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
  const why =
    h.reason === "deactivated" ? "deactivated" : h.reason === "demoted" ? "demoted off a pool" : "not bookable";
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
 *
 * It no longer says the customers "will meet nobody": a missed call is redistributed
 * by Regal to whoever is free (Dan, 2026-10-12). What it can say truthfully, since
 * sweep-held calls are excluded, is that nothing has tried to move these yet, which is
 * exactly what makes the panel the right place to send the reader.
 */
export function formatInactiveAgentBookingsAlert(holders: InactiveHolder[]): string {
  const totalBookings = holders.reduce((n, h) => n + h.bookingCount, 0);
  const lines = holders.slice(0, NAME_CAP).map(holderLine);
  const more = holders.length > NAME_CAP ? `\n(and ${holders.length - NAME_CAP} more)` : "";
  const oneAgent = holders.length === 1;
  const oneBooking = totalBookings === 1;
  return (
    `${plural(holders.length, "agent", "agents")} who ${oneAgent ? "has" : "have"} left ` +
    `the booking pool still ${oneAgent ? "holds" : "hold"} ` +
    `${plural(totalBookings, "appointment", "appointments")} in the future that no coverage ` +
    `sweep has picked up. ` +
    `${oneBooking ? "That customer is" : "Those customers are"} booked with someone Slate no ` +
    `longer routes to. Reassign ` +
    `${oneBooking ? "it" : "them"} from the agent's page in Admin, under ${COVERAGE_PANEL_NAME}.\n` +
    lines.join("\n") +
    more
  );
}

/** The subject the demotion backstop names one call by, so each is posted once. */
export function demotedCallSubject(bookingId: string): string {
  return `booking:${bookingId}`;
}

/** A holder narrowed to the calls in `only`, or null when none of theirs is in it. A holder
 *  without its calls listed is kept whole, which is the loud side. */
function narrowedTo(h: InactiveHolder, only: ReadonlySet<string>): InactiveHolder | null {
  if (h.calls === undefined) return h;
  const calls = h.calls.filter((c) => only.has(demotedCallSubject(c.id)));
  return calls.length === 0 ? null : { ...h, calls, bookingCount: calls.length };
}

/**
 * The demotion backstop page (#3582). A separate alert from the pool-exit one above, deliberately:
 * the cause and the remediation differ (a demoted agent is still bookable; their held booking
 * needs REROUTING to an eligible advisor, which the automatic reroute tried), and keeping them
 * separate means a failed demotion read can never blind the #1215 departed-agent check (L11, L71).
 *
 * It says what the reader would otherwise ask (Dan, 2026-10-26: "why isn't it being fixed
 * automatically?"): the reroute tried, nobody else in the pool was free, and the hourly retry
 * (`coverage-retry.ts`) keeps trying until the call starts. Each call is named once, so `only`
 * narrows the page to the calls the dispatcher found new (`textForFresh`); the opening already
 * says why they are held, so the line per agent does not say it again (L605).
 */
export function formatDemotedAgentBookingsAlert(holders: InactiveHolder[], only?: ReadonlySet<string>): string {
  const named = only === undefined ? holders : holders.flatMap((h) => narrowedTo(h, only) ?? []);
  const totalBookings = named.reduce((n, h) => n + h.bookingCount, 0);
  const lines = named
    .slice(0, NAME_CAP)
    .map((h) => {
      const who = h.name?.trim() || h.email || h.userId;
      const contact = h.email && h.email !== who ? `${who} (${h.email})` : who;
      return `${contact}, ${plural(h.bookingCount, "appointment", "appointments")}`;
    });
  const more = named.length > NAME_CAP ? `\n(and ${named.length - NAME_CAP} more)` : "";
  const one = totalBookings === 1;
  return (
    `The automatic reroute could not move ${plural(totalBookings, "appointment", "appointments")} ` +
    `held by ${named.length === 1 ? "an agent" : `${named.length} agents`} Twilio moved off a pool: nobody else in the ` +
    `pool ${one ? "it needs" : "each one needs"} was free at that time. ` +
    `It retries ${one ? "it" : "them"} every hour until ${one ? "it starts" : "they start"}. ` +
    `To move ${one ? "it" : "one"} sooner, use ${COVERAGE_PANEL_NAME} on the agent's page in Admin.\n` +
    lines.join("\n") +
    more
  );
}

/**
 * What the demotion backstop tells the dispatcher (Dan, 2026-10-26): one subject per call, so
 * each is posted once; the calls starting before the next batch could post, so they skip the
 * wait; and the page narrowed to whichever calls turn out to be new. No band: a growing count
 * is new calls, which the subjects already carry.
 */
export function demotedAgentBookingsSend(holders: readonly InactiveHolder[], nowMs: number): SendOptions {
  const calls = holders.flatMap((h) => h.calls ?? []);
  const horizonMs = changeBatchMs(DEMOTED_AGENT_BOOKINGS_KEY) ?? 0;
  // A start that cannot be read counts as soon, the side that posts.
  const urgent = calls.filter((c) => {
    const startMs = parseStampMs(c.startsAt);
    return startMs === null || startMs - nowMs < horizonMs;
  });
  return {
    subjects: calls.map((c) => demotedCallSubject(c.id)),
    urgentSubjects: urgent.map((c) => demotedCallSubject(c.id)),
    textForFresh: (fresh) => formatDemotedAgentBookingsAlert([...holders], new Set(fresh)),
  };
}

/** The demotion backstop all-clear (#3582), the sibling of the pool-exit recovery. */
export function formatDemotedAgentBookingsRecovery(): string {
  return (
    `No agent moved off a pool is holding a future appointment they can no longer serve any more. ` +
    `The bookings behind the earlier page have been rerouted, reassigned or have passed, so every ` +
    `upcoming appointment belongs to an advisor who can take it. No action is needed.`
  );
}

/**
 * The all-clear. Says the customers are covered again, and deliberately does NOT
 * repeat the page's remediation: the reader is being told to stand down, and
 * carrying "reassign them from the coverage panel" into the all-clear is how a
 * recovery notice sends someone to redo work that is already done.
 *
 * It must not claim every booking was reassigned: a call a sweep picked up and could not
 * place clears this alert too, and is still with the departed agent. So it says where
 * such a call went, and that the stranded-call page speaks for it from there.
 */
export function formatInactiveAgentBookingsRecovery(): string {
  return (
    `Every future appointment held by an agent Slate no longer routes to has been reassigned, ` +
    `has passed, or has been picked up by a coverage sweep, which pages on its own if it cannot ` +
    `place one before it starts. No action is needed.`
  );
}

/**
 * What the page names, for the repeat rule (#3801): one subject per agent still
 * holding calls, and the appointment count as a band that moves only when it at
 * least doubles. A new agent, or a count that has doubled, posts at once; the same
 * agents holding roughly the same calls are said again once a day.
 */
export function inactiveAgentBookingsRepeat(holders: readonly InactiveHolder[]): AlertRepeat {
  return {
    subjects: holders.map((h) => `agent:${h.userId}`),
    band: doublingBand(holders.reduce((n, h) => n + h.bookingCount, 0)),
  };
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
  /** The alert_state key, streak and copy. Defaults to the pool-exit check (#1215); the demotion
   *  backstop (#3582) passes its own so the two are fully independent (a failed read of one can
   *  never blind or false-clear the other). */
  key?: string;
  formatAlert?: (holders: InactiveHolder[]) => string;
  formatRecovery?: () => string;
  /** What the page tells the dispatcher beyond its text. Defaults to one subject per agent
   *  (`inactiveAgentBookingsRepeat`); the demotion backstop names one per call. */
  sendOptions?: (holders: InactiveHolder[]) => SendOptions;
}): Promise<InactiveAgentBookingsResult> {
  const key = deps.key ?? INACTIVE_AGENT_BOOKINGS_KEY;
  const formatAlert = deps.formatAlert ?? formatInactiveAgentBookingsAlert;
  const formatRecovery = deps.formatRecovery ?? formatInactiveAgentBookingsRecovery;
  let holders: InactiveHolder[];
  try {
    holders = await deps.loadHolders();
  } catch (err) {
    // Fail loud in the logs, silent on the alert channels. The lane heartbeat and
    // the migration-drift page cover a database that cannot be read at all; what
    // must not happen is this check turning an unread result into an all-clear.
    log.error("inactive-agent-bookings", { msg: "holder read failed", key }, err);
    deps.log?.({ status: "unreadable", key });
    return { status: "unreadable", agents: 0, bookings: 0 };
  }

  const bookings = holders.reduce((n, h) => n + h.bookingCount, 0);

  if (holders.length === 0) {
    await clearFailureStreak(key);
    // alert-key: inactive_agent_bookings
    // alert-key: demoted_agent_bookings
    await resolveAlert(key, formatRecovery()).catch(logAllClearFailure(key));
    deps.log?.({ status: "clear", agents: 0, bookings: 0, key });
    return { status: "clear", agents: 0, bookings: 0 };
  }

  const sustained = await recordConsecutiveStreak(
    key,
    INACTIVE_BOOKINGS_WINDOW_SECONDS,
    INACTIVE_BOOKINGS_ALERT_AFTER_TICKS,
  );
  if (sustained) {
    const opts = deps.sendOptions?.(holders) ?? inactiveAgentBookingsRepeat(holders);
    // alert-key: inactive_agent_bookings
    // alert-key: demoted_agent_bookings
    await sendThrottledAlert(key, deps.cooldownMs, formatAlert(holders), opts).catch(logAlertSendFailure(key));
  }
  deps.log?.({ status: "holding", agents: holders.length, bookings, sustained, key });
  return { status: "holding", agents: holders.length, bookings };
}
